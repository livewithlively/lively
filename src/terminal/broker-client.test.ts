// 브로커 전송 어댑터 (#2600 T2 (d) d2) — 엣지 표 T1~T10, 행마다 하나(fail-first).
//
// 가짜 브로커를 **유닉스 소켓 http 서버**로 세워(mkdtemp 안) 네 엔드포인트를 흉내 낸다:
//   GET /lvly/sessions · POST /containers/<c>/exec · POST /exec/<id>/start(101 업그레이드 → raw 프레임) · GET /exec/<id>/json
//  서버는 받은 요청(method·url·headers)을 로그에 적고, 시험은 그 로그로 «무엇을 보냈나» 를 단언한다.
//
//  | 행  | 상황                                              | 기대                                                   |
//  |-----|---------------------------------------------------|--------------------------------------------------------|
//  | T1  | 소켓 전송 · listSessions                           | observed·sessions 그대로 · 인증 헤더 없음 · 접두 없음   |
//  | T2  | 허브 전송 · listSessions                           | `/t/<slug>/lvly/sessions` · 헤더 = HMAC(독립 계산)     |
//  | T3  | execCapture 정상(stdout·stderr 프레임 · ExitCode 0) | {code:0, stdout, stderr}                               |
//  | T4  | ★ 프레임이 청크에 걸쳐 잘려 온다(머리 3+5 · 페이로드 2조각) | stdout/stderr 바르게 재조립                        |
//  | T5  | ExitCode 1 + stderr `can't find session: x`        | code 1 · stderr 바이트 그대로                           |
//  | T6  | exec-create 404                                    | {code:1, gone:true} · start/inspect 안 부름             |
//  | T7  | exec-create 500                                    | code 1 · gone 없음                                     |
//  | T8  | start 가 업그레이드 대신 200                        | code 1 로 접힘 · 매달리지 않음                          |
//  | T9  | timeoutMs 200 · 서버 무응답(create / 업그레이드 뒤 침묵) | 그 안에 code 1 로 끝남                             |
//  | T10 | 배선 — 소스에 process.env · LIVELY_/LVLY_ 문자열 없음 | (정규식)                                              |
//  | T11a | ★★ 허브 · 세션 컨테이너 · exec-create             | `x-lvly-session: <sid>`                                |
//  | T11b | ★★ 허브 · 세션 컨테이너 · exec-start(URL 에 세션 없음) | 같은 값                                            |
//  | T11c | ★★ 허브 · 세션 컨테이너 · exec-inspect(URL 에 세션 없음) | 같은 값                                          |
//  | T11d | 허브 · 파일 op 컨테이너 `lvly-s-<slug>-fs`         | 세 요청 모두 없음                                      |
//  | T11e | 허브 · 다른 접두(`lvly-s-<다른 slug>-…`)           | 세 요청 모두 없음                                      |
//  | T11f | 허브 · sid 형식 밖(`.box-a` · `box.a` · 65자)      | 세 요청 모두 없음                                      |
//  | T11g | 허브 · 경계 — sid 정확히 64자                      | 세 요청 모두 실린다                                    |
//  | T11h | 허브 · sid 빈 값(이름이 접두 그대로)               | 세 요청 모두 없음(빈 값 헤더도 아니다)                 |
//  | T11i | 소켓 · 세션 컨테이너                               | 세 요청 모두 없음(이 헤더를 읽는 것은 허브뿐)          |
//  | T11j | 허브 · listSessions(listScope node)               | 세션 헤더 없음                                         |
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { makeBrokerClient, makeDemuxer, type BrokerTransport } from "./broker-client.js";
import type { SessionRow } from "./tmux-route.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const frame = (type: 1 | 2, payload: string | Buffer): Buffer => {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(p.length, 4);
  return Buffer.concat([h, p]);
};
const UPGRADE_101 = "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n";

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
interface Fake {
  socketPath: string;
  /** `startFake({ tcp: true })` 면 루프백 포트(허브 전송 시험용) — 유닉스 소켓이면 0. */
  port: number;
  log: Seen[];
  /** 업그레이드 소켓에 무엇을 쓰나 — 기본은 stdout/stderr 프레임 하나씩 쓰고 닫는다. (`upgrade` 이벤트의 소켓 타입은 Duplex 다.) */
  onUpgrade: (sock: import("node:stream").Duplex) => void;
  /** exec-create 응답 — 기본 201 {Id}. */
  onCreate: (res: http.ServerResponse) => void;
  /** exec-start 가 **업그레이드 없이** http 로 왔을 때(클라이언트가 Upgrade 헤더를 안 보냈거나, 서버가 101 을 안 줄 때). */
  onStartHttp: ((res: http.ServerResponse) => void) | null;
  /** exec-inspect 응답 — 기본 200 {Running:false, ExitCode:0}. */
  inspect: { Running: boolean; ExitCode: number | null } | ((res: http.ServerResponse) => void);
  sessions: { observed: boolean; node: string | null; sessions: unknown[] };
  /** 요청을 받고 아무것도 안 하는가(T9). */
  hang: boolean;
  close(): Promise<void>;
}

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve) => {
  const c: Buffer[] = []; req.on("data", (d: Buffer) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
});

async function startFake(opts: { tcp?: boolean } = {}): Promise<Fake> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brkc-"));
  const socketPath = path.join(dir, "b.sock");
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  };
  const fake: Fake = {
    socketPath, port: 0, log: [], hang: false, onStartHttp: null,
    onUpgrade: (sock) => { sock.write(frame(1, "out\n")); sock.write(frame(2, "err\n")); sock.end(); },
    onCreate: (res) => json(res, 201, { Id: "exec-1" }),
    inspect: { Running: false, ExitCode: 0 },
    sessions: { observed: true, node: "n1", sessions: [] },
    close: async () => undefined,
  };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    fake.log.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    if (fake.hang) return;
    const u = req.url ?? "";
    if (req.method === "GET" && u.endsWith("/lvly/sessions")) return json(res, 200, fake.sessions);
    if (req.method === "POST" && /\/containers\/[^/]+\/exec$/.test(u)) return fake.onCreate(res);
    if (req.method === "POST" && /\/exec\/[^/]+\/start$/.test(u)) {
      if (fake.onStartHttp) return fake.onStartHttp(res);
      return json(res, 500, { message: "start 가 업그레이드 없이 왔다" });
    }
    if (req.method === "GET" && /\/exec\/[^/]+\/json$/.test(u)) {
      return typeof fake.inspect === "function" ? fake.inspect(res) : json(res, 200, { ID: "exec-1", ContainerID: "c", ...fake.inspect });
    }
    json(res, 501, { message: `unhandled ${req.method} ${u}` });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  server.on("upgrade", async (req, sock, head) => {
    //  본문(Content-Length)은 head 로 같이 올 수 있다 — 브로커처럼 길이만큼 걷어낸 뒤 프레임을 쓴다(여기선 기록만).
    //  ⚠ head 밖의 본문이 **어디로 오는지는 node 판마다 다르다** — 22 는 소켓으로, 26 은 req 로 준다(#3542).
    //   소켓만 기다리면 26 에서 101 을 영영 못 쓰고 클라이언트가 타임아웃으로 끝난다(맥 로컬에서 T3~T9' 가 15초씩 죽던 원인). 둘 다 받는다.
    const want = Number(req.headers["content-length"] ?? 0);
    const got = await new Promise<Buffer>((resolve) => {
      let buf = head;
      if (buf.length >= want) { resolve(buf); return; }
      const done = (): void => { sock.off("data", take); req.off("data", take); sock.off("close", done); resolve(buf); };
      const take = (d: Buffer): void => { buf = Buffer.concat([buf, d]); if (buf.length >= want) done(); };
      sock.on("data", take); req.on("data", take); sock.once("close", done);
    });
    fake.log.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: got.subarray(0, want).toString("utf8") });
    if (fake.hang) return;
    sock.on("error", () => undefined);
    if (fake.onStartHttp) {
      //  T8 — 업그레이드 요청에 보통 응답으로 답한다(101 이 아니다).
      const b = JSON.stringify({ message: "no upgrade for you" });
      sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(b)}\r\nConnection: close\r\n\r\n${b}`);
      return;
    }
    sock.write(UPGRADE_101);
    fake.onUpgrade(sock);
  });
  //  허브 전송은 TCP 다 — 같은 핸들러를 루프백 포트에 세운다(`/t/<slug>` 접두는 핸들러 정규식이 끝만 봐서 그대로 통한다).
  if (opts.tcp) {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    fake.port = (server.address() as { port: number }).port;
  } else {
    await new Promise<void>((r) => server.listen(socketPath, r));
  }
  fake.close = () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); }); });
  return fake;
}

const sockT = (f: Fake): BrokerTransport => ({ kind: "socket", socketPath: f.socketPath });
const urls = (f: Fake): string[] => f.log.map((l) => `${l.method} ${l.url}`);

// ── T1·T2 전송 ─────────────────────────────────────────────────────────────────

test("[T1] 소켓 전송 — listSessions 가 observed·sessions 를 그대로 · 인증 헤더 없음 · 경로 접두 없음", async () => {
  const f = await startFake();
  try {
    const rows: SessionRow[] = [
      { sid: "box-a-11111111", container: "lvly-s-acme-box-a-11111111", inside: true },
      { sid: "box-b-22222222", container: "lvly-s-acme-box-b-22222222", inside: false },
    ];
    //  브로커의 행은 칸이 더 있다(node·state) — 그 밖의 칸은 버리고 tmux-route 의 세 칸만 돌려준다.
    f.sessions = { observed: false, node: "n1", sessions: rows.map((r) => ({ ...r, node: "n1", state: "running" })) };
    const c = makeBrokerClient(sockT(f));
    const got = await c.listSessions();
    assert.deepEqual(got, { observed: false, sessions: rows });
    assert.equal(f.log.length, 1);
    assert.equal(f.log[0]!.url, "/lvly/sessions", "🔴 소켓 전송에 경로 접두가 붙었다");
    assert.equal(f.log[0]!.headers["x-lvly-channel-auth"], undefined, "🔴 소켓 전송에 인증 헤더가 붙었다");
    //  비-2xx·JSON 오류는 throw — 못 본 목록을 빈 목록으로 접지 않는다.
    f.hang = false; f.sessions = { observed: true, node: null, sessions: [] };
    const c2 = makeBrokerClient(sockT(f));
    (f as { sessions: unknown }).sessions = "not json obj";
    await assert.rejects(c2.listSessions(), /sessions 배열이 없다/);
  } finally { await f.close(); }
});

// ── T1b 목록 범위(#3797 T7) ───────────────────────────────────────────────────
//  세션 호스트는 **자기 노드 것만** 보고해야 한다. 브로커의 `GET /lvly/sessions` 는 기본이 클러스터
//   전역이고(다른 산 노드로 팬아웃 — #3689), 범위 헤더 `x-lvly-list-scope: node` 가 그걸 «이 노드 것만»
//   으로 좁힌다(lvly-cloud sessionroute.LIST_SCOPE_HEADER / isNodeScoped 와 같은 이름·같은 값).
//  ⚠ 값이 조금이라도 다르면 브로커의 `isNodeScoped` 가 거짓이 되어 **조용히 전역으로 되돌아간다** —
//   그래서 여기서 헤더의 이름과 값을 문자열로 못박는다.
test("[T1b] ★★ listScope:'node' 면 목록 요청에 `x-lvly-list-scope: node` 를 싣는다", async () => {
  const f = await startFake();
  try {
    f.sessions = { observed: true, node: "n1", sessions: [] };
    const c = makeBrokerClient(sockT(f), { listScope: "node" });
    await c.listSessions();
    assert.equal(f.log[0]!.headers["x-lvly-list-scope"], "node",
      "🔴 범위 헤더가 없다/틀리다 — 세션 호스트가 클러스터 전역 목록을 자기 것이라 주장한다");
  } finally { await f.close(); }
});

test("[T1c] ★ 기본(미지정)은 종전 그대로 — 범위 헤더를 안 싣는다(게이트웨이 무회귀)", async () => {
  const f = await startFake();
  try {
    f.sessions = { observed: true, node: "n1", sessions: [] };
    await makeBrokerClient(sockT(f)).listSessions();
    assert.equal(f.log[0]!.headers["x-lvly-list-scope"], undefined,
      "🔴 게이트웨이 요청까지 노드 범위로 좁혔다 — 다른 노드 세션이 목록에서 사라진다");
  } finally { await f.close(); }
});

test("[T1d] ★ 범위 헤더는 **목록에만** — exec 요청에는 안 붙는다(브로커 라우팅은 세션 축이다)", async () => {
  //  거기 실으면 «그 세션이 다른 노드에 있을 때» 를 우리가 모르게 막는다. 404(컨테이너 없음)로 한 왕복만
  //   태워 재빨리 잰다 — 이 시험이 보는 것은 답이 아니라 **헤더**다.
  const f = await startFake();
  try {
    f.onCreate = (res) => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "No such container" })); };
    const c = makeBrokerClient(sockT(f), { listScope: "node" });
    const out = await c.execCapture("lvly-s-acme-box-a-11111111", ["tmux", "-V"]);
    assert.equal(out.gone, true, "404 는 gone 규약이다(전제가 성립하는지부터 본다)");
    assert.deepEqual(f.log.map((l) => l.headers["x-lvly-list-scope"]), [undefined], "🔴 exec 요청에 목록 범위 헤더가 실렸다");
  } finally { await f.close(); }
});

test("[T2] 허브 전송 — 경로 `/t/<slug>/lvly/sessions` · x-lvly-channel-auth = HMAC-SHA256(secret, 'hub:'+slug) hex", async () => {
  //  허브는 TCP 다 — 가짜 서버를 루프백 포트에 하나 더 세운다(같은 핸들러 모양이면 충분하니 최소 구현).
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: await readBody(req) });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ observed: true, node: "n1", sessions: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    const secret = "s3cr3t-" + Math.random().toString(36).slice(2);
    const slug = "acme-1a2b";
    const c = makeBrokerClient({ kind: "hub", url: `http://127.0.0.1:${port}`, secret, slug });
    const got = await c.listSessions();
    assert.deepEqual(got, { observed: true, sessions: [] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, `/t/${slug}/lvly/sessions`, "🔴 허브 경로 접두가 틀리다");
    const expect = createHmac("sha256", secret).update(`hub:${slug}`).digest("hex");   // 독립 계산
    assert.equal(seen[0]!.headers["x-lvly-channel-auth"], expect, "🔴 허브 토큰이 HMAC 값과 다르다");
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

// ── T3~T5 execCapture 정상 경로 ──────────────────────────────────────────────

test("[T3] execCapture 정상 — stdout·stderr 프레임이 갈려 오고 ExitCode 0 → {code:0, stdout, stderr} · 세 단을 순서대로 부른다", async () => {
  const f = await startFake();
  try {
    f.onUpgrade = (sock) => { sock.write(frame(1, "a\nb\n")); sock.write(frame(2, "warn\n")); sock.write(frame(1, "c\n")); sock.end(); };
    const c = makeBrokerClient(sockT(f));
    const argv = ["tmux", "-L", "lvly-acme", "-f", "/dev/null", "list-sessions", "-F", "#{session_name}"];
    const r = await c.execCapture("lvly-s-acme-box-a-11111111", argv);
    assert.deepEqual(r, { code: 0, stdout: "a\nb\nc\n", stderr: "warn\n" });
    assert.deepEqual(urls(f), [
      "POST /containers/lvly-s-acme-box-a-11111111/exec",
      "POST /exec/exec-1/start",
      "GET /exec/exec-1/json",
    ]);
    //  create 본문 = 도커 exec 계약 그대로.
    assert.deepEqual(JSON.parse(f.log[0]!.body), { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: argv });
    //  start = 업그레이드 요청 + Detach:false 본문(브로커가 걷어낸다).
    assert.match(String(f.log[1]!.headers.upgrade), /^tcp$/i);
    assert.deepEqual(JSON.parse(f.log[1]!.body), { Detach: false, Tty: false });
  } finally { await f.close(); }
});

test("[T4] ★ 프레임이 청크에 걸쳐 잘려 와도(머리 3+5 · 페이로드 둘로 · 두 프레임이 한 청크에) 바르게 재조립된다", async () => {
  const f = await startFake();
  try {
    const out = "세션-한글 №1\nline2\n";   // 멀티바이트 — 프레임 경계·청크 경계 모두에 걸리게 한다
    const err = "stderr 한 줄\n";
    const fo = frame(1, out), fe = frame(2, err), f3 = frame(1, "tail\n");
    f.onUpgrade = async (sock) => {
      sock.write(fo.subarray(0, 3)); await sleep(15);          // 머리 3바이트
      sock.write(fo.subarray(3, 8)); await sleep(15);          // 머리 나머지 5바이트
      const mid = 8 + Math.floor((fo.length - 8) / 2) + 1;     // 페이로드를 둘로 — 멀티바이트 문자 한가운데
      sock.write(fo.subarray(8, mid)); await sleep(15);
      sock.write(Buffer.concat([fo.subarray(mid), fe, f3.subarray(0, 5)])); await sleep(15);   // 남은 페이로드 + 다음 프레임 통째 + 셋째 머리 조각
      sock.write(f3.subarray(5)); await sleep(15);
      sock.end();
    };
    const c = makeBrokerClient(sockT(f));
    const r = await c.execCapture("c1", ["tmux", "x"]);
    assert.deepEqual(r, { code: 0, stdout: out + "tail\n", stderr: err });
    //  디먹서 단독으로도 — 한 바이트씩 먹여도 같은 답.
    const d = makeDemuxer();
    const all = Buffer.concat([fo, fe, f3]);
    for (let i = 0; i < all.length; i++) d.feed(all.subarray(i, i + 1));
    assert.equal(d.stdout(), out + "tail\n"); assert.equal(d.stderr(), err); assert.equal(d.error(), null);
  } finally { await f.close(); }
});

test("[T5] ExitCode 1 + stderr `can't find session: x` → code 1 · stderr 바이트 그대로(코어가 그 문구를 읽는다)", async () => {
  const f = await startFake();
  try {
    const msg = "can't find session: box-x-99999999\n";
    f.onUpgrade = (sock) => { sock.write(frame(2, msg)); sock.end(); };
    f.inspect = { Running: false, ExitCode: 1 };
    const c = makeBrokerClient(sockT(f));
    const r = await c.execCapture("c1", ["tmux", "has-session", "-t", "box-x-99999999"]);
    assert.deepEqual(r, { code: 1, stdout: "", stderr: msg });
    assert.equal((r as { gone?: boolean }).gone, undefined, "🔴 tmux 의 실패를 gone 으로 위장했다 — 그건 컨테이너 부재의 표식이다");
  } finally { await f.close(); }
});

// ── T6~T9 실패 접기 ───────────────────────────────────────────────────────────

test("[T6] exec-create 404 → {code:1, gone:true} · start/inspect 를 부르지 않는다 (409 도 같다)", async () => {
  const f = await startFake();
  try {
    f.onCreate = (res) => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "No such container: c1" })); };
    const c = makeBrokerClient(sockT(f));
    const r = await c.execCapture("c1", ["tmux", "x"]);
    assert.equal(r.code, 1);
    assert.equal(r.gone, true, "🔴 404 를 gone 으로 안 접었다 — 병합이 그 세션을 0행으로 못 접는다");
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^404: .*No such container: c1/);
    assert.deepEqual(urls(f), ["POST /containers/c1/exec"], "🔴 404 뒤에 start/inspect 를 불렀다");
    f.log.length = 0;
    f.onCreate = (res) => { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "Container c1 is not running" })); };
    const r2 = await c.execCapture("c1", ["tmux", "x"]);
    assert.equal(r2.gone, true); assert.match(r2.stderr, /^409: .*is not running/);
    assert.deepEqual(urls(f), ["POST /containers/c1/exec"]);
  } finally { await f.close(); }
});

test("[T7] exec-create 500 → code 1 · gone 없음(«못 봤다» 지 «없다» 가 아니다) · 2xx 인데 Id 가 없어도 같다", async () => {
  const f = await startFake();
  try {
    f.onCreate = (res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "boom" })); };
    const c = makeBrokerClient(sockT(f));
    const r = await c.execCapture("c1", ["tmux", "x"]);
    assert.equal(r.code, 1);
    assert.equal(r.gone, undefined, "🔴 500 을 gone 으로 접었다 — 살아 있는 세션이 사라진 것으로 보인다");
    assert.match(r.stderr, /broker exec-create 실패: 500/);
    assert.deepEqual(urls(f), ["POST /containers/c1/exec"]);
    f.onCreate = (res) => { res.writeHead(201, { "content-type": "application/json" }); res.end("{}"); };
    const r2 = await c.execCapture("c1", ["tmux", "x"]);
    assert.equal(r2.code, 1); assert.equal(r2.gone, undefined); assert.match(r2.stderr, /exec id 없음/);
  } finally { await f.close(); }
});

test("[T8] start 가 업그레이드 대신 200 응답 → code 1 실패로 접힌다(매달리지 않는다) · inspect 를 안 부른다", async () => {
  const f = await startFake();
  try {
    f.onStartHttp = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "no upgrade for you" })); };
    const c = makeBrokerClient(sockT(f), { timeoutMs: 5_000 });
    const t0 = Date.now();
    const r = await c.execCapture("c1", ["tmux", "x"]);
    assert.ok(Date.now() - t0 < 4_000, "🔴 매달렸다");
    assert.equal(r.code, 1); assert.equal(r.gone, undefined);
    assert.match(r.stderr, /broker exec-start 실패: exec start 미업그레이드\(200\)/);
    assert.deepEqual(urls(f), ["POST /containers/c1/exec", "POST /exec/exec-1/start"], "🔴 실패한 start 뒤에 inspect 를 불렀다");
  } finally { await f.close(); }
});

test("[T9] timeoutMs 200 — (a) create 무응답 · (b) 업그레이드 뒤 침묵 · (c) listSessions 무응답 — 전부 그 안에 실패로 끝난다", async () => {
  const f = await startFake();
  try {
    const c = makeBrokerClient(sockT(f), { timeoutMs: 200 });
    // (a)
    f.hang = true;
    let t0 = Date.now();
    const ra = await c.execCapture("c1", ["tmux", "x"]);
    assert.ok(Date.now() - t0 < 1_500, `🔴 create 무응답에 ${Date.now() - t0}ms 매달렸다`);
    assert.equal(ra.code, 1); assert.equal(ra.gone, undefined); assert.match(ra.stderr, /broker exec-create 실패: .*응답 없음\(200ms\)/);
    // (b) — 101 은 주되 프레임도 닫기도 안 한다
    f.hang = false;
    f.onUpgrade = (sock) => { sock.write(frame(1, "partial")); /* 그리고 침묵 */ void sock; };
    t0 = Date.now();
    const rb = await c.execCapture("c1", ["tmux", "x"]);
    assert.ok(Date.now() - t0 < 1_500, `🔴 스트림 침묵에 ${Date.now() - t0}ms 매달렸다`);
    assert.equal(rb.code, 1); assert.match(rb.stderr, /broker exec-start 실패: exec 스트림 유휴 타임아웃\(200ms\)/);
    // (c)
    f.hang = true;
    t0 = Date.now();
    await assert.rejects(c.listSessions(), /응답 없음\(200ms\)/);
    assert.ok(Date.now() - t0 < 1_500);
  } finally { await f.close(); }
});

test("[T9'] inspect 가 실패하면 code 1 · stderr 에 사유 · 잡은 stdout 은 남긴다(모르면 성공이라 말하지 않는다)", async () => {
  const f = await startFake();
  try {
    f.inspect = (res) => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "No such exec instance" })); };
    const c = makeBrokerClient(sockT(f));
    const r = await c.execCapture("c1", ["tmux", "x"]);
    assert.equal(r.code, 1); assert.equal(r.stdout, "out\n"); assert.match(r.stderr, /^err\nbroker exec-inspect 실패: 404/);
    //  Running:true(ExitCode null) 도 «모른다» → 1
    f.inspect = { Running: true, ExitCode: null };
    assert.equal((await c.execCapture("c1", ["tmux", "x"])).code, 1);
  } finally { await f.close(); }
});

test("[T9''] 디먹서 — 길이 칸이 상한을 넘으면 프로토콜 오류로 접는다(4GiB 를 기다리며 쌓지 않는다)", async () => {
  const d = makeDemuxer();
  const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(0xffff_ffff, 4);
  d.feed(h); d.feed(Buffer.from("garbage"));
  assert.match(d.error() ?? "", /상한/);
  assert.equal(d.stdout(), "");
});

// ── T10 배선 ──────────────────────────────────────────────────────────────────

test("[T10] 배선 — 구현 소스에 process.env 가 없고 LIVELY_/LVLY_ 문자열이 없다(전송 설정은 인자로만)", () => {
  //  dist/terminal → ../../src/terminal 이 레포 레이아웃이다(attach-worker-host.test 와 같은 관례). 소스가 없으면(다른 outDir)
  //   컴파일된 JS 로 본다 — 거기선 타입 import 가 지워져 있으니 그 단언만 건너뛴다.
  const srcUrl = new URL("../../src/terminal/broker-client.ts", import.meta.url);
  const isTs = fs.existsSync(srcUrl);
  const src = isTs ? fs.readFileSync(srcUrl, "utf8") : fs.readFileSync(new URL("./broker-client.js", import.meta.url), "utf8");
  assert.ok(src.length > 1000, "소스를 못 읽었다");
  assert.doesNotMatch(src, /process\s*\.\s*env/, "🔴 broker-client 가 환경변수를 읽는다 — exec-topology 만 읽는다");
  assert.doesNotMatch(src, /\bLIVELY_[A-Z_]+/, "🔴 코어 env 이름이 박혀 있다");
  assert.doesNotMatch(src, /\bLVLY_[A-Z_]+/, "🔴 매니지드 env 이름이 박혀 있다");
  //  런타임 import 는 node 내장 둘뿐 · 코어 다른 모듈은 tmux-route 의 **타입만**.
  const imports = [...src.matchAll(/^import\s+(type\s+)?.*?from\s+"([^"]+)"/gm)].map((m) => ({ typeOnly: !!m[1], from: m[2]! }));
  assert.deepEqual(imports.filter((i) => !i.typeOnly).map((i) => i.from).sort(), ["node:crypto", "node:http"], "🔴 런타임 의존이 node 내장 밖으로 나갔다");
  if (isTs) assert.deepEqual(imports.filter((i) => i.typeOnly).map((i) => i.from), ["./tmux-route.js"]);
});

// ── T11 세션 지목(#3708) ──────────────────────────────────────────────────────
//  허브는 `x-lvly-session` 을 보면 테넌트 배치보다 먼저 그 세션의 라우트로 첫 홉을 고른다(lvly-cloud channelhub).
//   exec 3단 중 start·inspect 는 URL 에 세션이 없어 **헤더가 유일한 단서**다 — 하나라도 빠지면 그 요청만 핀 노드로 가서
//   그 브로커가 한 번 더 전달한다. 그래서 세 요청을 **각각** 잰다.
//  ⚠ 헤더 이름은 **문자열로** 못박는다(T1b 와 같은 이유 — 한 글자만 달라도 허브가 조용히 배치로 떨어진다).

const SLUG = "acme-1a2b";
const SID = "box-a-1111aaaa";
const hubT = (f: Fake, slug = SLUG): BrokerTransport => ({ kind: "hub", url: `http://127.0.0.1:${f.port}`, secret: "s3cr3t", slug });
type SessionHeaders = { create: string | undefined; start: string | undefined; inspect: string | undefined };
const NONE: SessionHeaders = { create: undefined, start: undefined, inspect: undefined };

/** execCapture 를 한 번 태우고, 세 요청이 **실제로 왔는지**(배선)부터 본 뒤 요청별 `x-lvly-session` 을 돌려준다. */
async function sessionHeadersSent(f: Fake, t: BrokerTransport, container: string): Promise<SessionHeaders> {
  f.log.length = 0;
  const out = await makeBrokerClient(t).execCapture(container, ["tmux", "-V"]);
  assert.equal(out.code, 0, `전제: exec 가 끝까지 돌아야 세 요청을 잰다 — ${out.stderr}`);
  const prefix = t.kind === "hub" ? `/t/${t.slug}` : "";
  assert.deepEqual(urls(f), [
    `POST ${prefix}/containers/${encodeURIComponent(container)}/exec`,
    `POST ${prefix}/exec/exec-1/start`,
    `GET ${prefix}/exec/exec-1/json`,
  ], "배선: 세 요청이 전부 가짜 브로커에 닿아야 헤더를 잴 수 있다");
  const at = (i: number): string | undefined => f.log[i]!.headers["x-lvly-session"] as string | undefined;
  return { create: at(0), start: at(1), inspect: at(2) };
}

test("[T11a] ★★ 허브 · 세션 컨테이너 — exec-create 가 `x-lvly-session: <sid>` 를 싣는다", async () => {
  const f = await startFake({ tcp: true });
  try {
    const got = await sessionHeadersSent(f, hubT(f), `lvly-s-${SLUG}-${SID}`);
    assert.equal(got.create, SID, "🔴 exec-create 가 세션을 안 밝혔다 — 허브가 테넌트 핀 노드로 보내고 그 브로커가 한 번 더 전달한다");
  } finally { await f.close(); }
});

test("[T11b] ★★ 허브 · 세션 컨테이너 — exec-start 도 싣는다(URL 에 세션이 없어 헤더가 유일한 단서다)", async () => {
  const f = await startFake({ tcp: true });
  try {
    const got = await sessionHeadersSent(f, hubT(f), `lvly-s-${SLUG}-${SID}`);
    assert.equal(got.start, SID, "🔴 exec-start 가 세션을 안 밝혔다 — create 만 고치면 절반만 고친 것이다");
  } finally { await f.close(); }
});

test("[T11c] ★★ 허브 · 세션 컨테이너 — exec-inspect 도 싣는다(URL 에 세션이 없어 헤더가 유일한 단서다)", async () => {
  const f = await startFake({ tcp: true });
  try {
    const got = await sessionHeadersSent(f, hubT(f), `lvly-s-${SLUG}-${SID}`);
    assert.equal(got.inspect, SID, "🔴 exec-inspect 가 세션을 안 밝혔다 — `/exec/<id>/json` 이 핀 노드로 가서 전달된다");
  } finally { await f.close(); }
});

test("[T11d] 파일 op 컨테이너(`lvly-s-<slug>-fs`)는 세션이 아니다 — 세 요청 모두 안 싣는다", async () => {
  const f = await startFake({ tcp: true });
  try {
    assert.deepEqual(await sessionHeadersSent(f, hubT(f), `lvly-s-${SLUG}-fs`), NONE,
      "🔴 파일 op 컨테이너를 «세션 fs» 로 밝혔다 — 허브가 없는 라우트를 찾다 배치로 떨어지며 «라우트 없음» 계기를 더럽힌다");
  } finally { await f.close(); }
});

test("[T11e] 접두가 이 전송의 slug 가 아니면(`lvly-s-<다른 slug>-…`) 안 싣는다", async () => {
  const f = await startFake({ tcp: true });
  try {
    assert.deepEqual(await sessionHeadersSent(f, hubT(f), `lvly-s-other-9f9f-${SID}`), NONE, "🔴 다른 접두의 이름에서 세션을 뽑았다");
  } finally { await f.close(); }
});

test("[T11f] sid 가 허브 규격 밖이면(`.box-a` · `box.a` · 65자) 안 싣는다 — 실어 봐야 허브가 «형식 밖» 으로 떨어뜨린다", async () => {
  const f = await startFake({ tcp: true });
  try {
    for (const sid of [".box-a", "box.a", "b" + "x".repeat(64)]) {
      assert.deepEqual(await sessionHeadersSent(f, hubT(f), `lvly-s-${SLUG}-${sid}`), NONE, `🔴 형식 밖 sid ${JSON.stringify(sid)} (${sid.length}자) 를 실었다`);
    }
  } finally { await f.close(); }
});

test("[T11g] 경계 — sid 가 정확히 64자면 싣는다(허브 규격의 최대치)", async () => {
  const f = await startFake({ tcp: true });
  try {
    const sid = "b" + "x".repeat(63);
    assert.equal(sid.length, 64);
    assert.deepEqual(await sessionHeadersSent(f, hubT(f), `lvly-s-${SLUG}-${sid}`), { create: sid, start: sid, inspect: sid },
      "🔴 64자 sid 를 형식 밖으로 떨어뜨렸다 — 허브는 받는 길이다(오프바이원)");
  } finally { await f.close(); }
});

test("[T11h] sid 가 빈 값이면(이름이 접두 그대로) 안 싣는다 — 빈 값 헤더도 아니다", async () => {
  const f = await startFake({ tcp: true });
  try {
    assert.deepEqual(await sessionHeadersSent(f, hubT(f), `lvly-s-${SLUG}-`), NONE, "🔴 빈 세션 id 를 헤더로 실었다");
    assert.ok(f.log.every((l) => !("x-lvly-session" in l.headers)), "🔴 헤더 키가 빈 값으로 실렸다");
  } finally { await f.close(); }
});

test("[T11i] 소켓 전송은 세션 컨테이너여도 안 싣는다 — 이 헤더를 읽는 것은 허브뿐이다(종전 그대로)", async () => {
  const f = await startFake();
  try {
    assert.deepEqual(await sessionHeadersSent(f, sockT(f), `lvly-s-${SLUG}-${SID}`), NONE, "🔴 소켓 전송에 세션 헤더가 실렸다");
  } finally { await f.close(); }
});

test("[T11j] 목록 요청(`GET /lvly/sessions`)엔 세션 헤더를 안 싣는다", async () => {
  const f = await startFake({ tcp: true });
  try {
    await makeBrokerClient(hubT(f), { listScope: "node" }).listSessions();
    assert.deepEqual(urls(f), [`GET /t/${SLUG}/lvly/sessions`], "배선: 목록 요청이 닿았다");
    assert.equal(f.log[0]!.headers["x-lvly-list-scope"], "node", "배선: 이 요청의 헤더를 실제로 보고 있다");
    assert.equal(f.log[0]!.headers["x-lvly-session"], undefined, "🔴 목록 요청에 세션 헤더가 실렸다");
  } finally { await f.close(); }
});
