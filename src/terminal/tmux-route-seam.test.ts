// `tmux()` seam 의 코어 직접 경로 (#2600 T2 (d) d2) — spec-d2.md S14·S16·S17 + 살아 있는 가짜 브로커 왕복.
//
// 명제 둘: ① 플래그가 꺼져 있으면(기본) 옛 경로(중계 프로그램 spawn)가 **한 바이트도** 안 바뀐다 — 가짜 브로커엔 요청 0.
//         ② 켜져 있고 길이 있으면 코어가 목록(`GET /lvly/sessions`) → 계획 → exec 팬아웃 → 병합을 스스로 하고,
//            실패는 execFile 오류와 같은 필드로 던져 상위 판정(`isSessionGoneError`·`isNoTmuxServer`)이 종전과 같이 갈린다.
// #2600 T3-a(2026-09-14) — d3 «그림자 대조»(`LIVELY_TMUX_ROUTE=shadow`)를 걷었다. 검증(일치 98% · 설명 안 된 불일치 0)은
//  끝났고, 게이트웨이가 표본(25%) 호출을 두 번 돌리는 비용만 남아서다. 그 값은 이제 **off** 로 읽힌다(아래 [T3-a]).
//  그림자만 쓰던 **허브 전송**도 함께 걷었다 — 코어 경로는 노드 박스 브로커 소켓 하나다(아래 [S17]·[R7]).
//  단언은 가짜 브로커·가짜 중계가 **받은 것**(요청 로그·argv 파일)으로 한다. 이 파일은 process.env 를 만지므로 afterEach 로 되돌린다.
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { installTenantSlugResolver } from "./catalog.js";
import { tmux, tmuxRouteTransport, isSessionGoneError, isNoTmuxServer } from "./tmux-exec.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-trs-"));
const SLUG = "acme";
const SOCK = path.join(TMP, `${SLUG}.sock`);
//  가짜 중계 — 불리면 argv 를 파일에 적는다(옛 경로가 실제로 spawn 됐다는 증거).
const RELAY_LOG = path.join(TMP, "relay.log");
const RELAY = path.join(TMP, "relay.sh");
fs.writeFileSync(RELAY, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${RELAY_LOG}"\necho relayed\n`, { mode: 0o755 });
const KEYS = ["LIVELY_TMUX_EXEC", "LIVELY_TMUX_ROUTE", "LVLY_TMUX_SOCK_TEMPLATE", "LVLY_HUB_URL", "LVLY_HUB_SECRET", "LIVELY_TMUX_LIST_SCOPE"] as const;
afterEach(() => {
  for (const k of KEYS) delete process.env[k]; installTenantSlugResolver(() => null);
  try { fs.unlinkSync(RELAY_LOG); } catch { /* 없음 */ }
});
const relayCalls = (): string[] => { try { return fs.readFileSync(RELAY_LOG, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

//  가짜 브로커 — d1 표면 + 도커 exec 계약(create → start(101, 8바이트 프레임) → inspect). 받은 요청을 기록한다.
type Sess = { sid: string; container: string; inside: boolean };
function fakeBroker(o: { sessions: Sess[]; observed?: boolean; listStatus?: number; exitCode?: number }) {
  const got: string[] = [];
  const execs = new Map<string, string>();   // execId → container
  const frame = (stream: number, s: string): Buffer => { const b = Buffer.from(s); const h = Buffer.alloc(8); h[0] = stream; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  const srv = http.createServer((q, s) => {
    let body = ""; q.on("data", (d) => (body += d));
    q.on("end", () => {
      const p = q.url!.split("?")[0]!; got.push(`${q.method} ${p}`);
      if (p === "/lvly/sessions") {
        s.writeHead(o.listStatus ?? 200, { "content-type": "application/json" });
        s.end(JSON.stringify({ observed: o.observed ?? true, node: "local", sessions: o.sessions.map((x) => ({ ...x, node: "local", state: "running" })) })); return;
      }
      let m = /^\/containers\/([^/]+)\/exec$/.exec(p);
      if (m && q.method === "POST") { const id = "ab".repeat(32).slice(0, 62) + String(execs.size).padStart(2, "0"); execs.set(id, m[1]!); s.writeHead(201, { "content-type": "application/json" }); s.end(JSON.stringify({ Id: id })); return; }
      m = /^\/exec\/([^/]+)\/json$/.exec(p);
      if (m) { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ Running: false, ExitCode: o.exitCode ?? 0 })); return; }
      s.writeHead(404); s.end("{}");
    });
  });
  srv.on("upgrade", (q, sock) => {
    const p = q.url!.split("?")[0]!; got.push(`UPGRADE ${p}`);
    const id = /^\/exec\/([^/]+)\/start$/.exec(p)?.[1] ?? ""; const c = execs.get(id) ?? "?";
    sock.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    sock.write(frame(1, `${c}\n`)); if ((o.exitCode ?? 0) !== 0) sock.write(frame(2, "can't find session: x\n"));
    sock.end();
  });
  return { srv, got, listen: () => new Promise<void>((r) => srv.listen(SOCK, () => r())), close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const on = (mode = "on"): void => { process.env.LIVELY_TMUX_EXEC = `${RELAY} {slug}`; process.env.LIVELY_TMUX_ROUTE = mode; process.env.LVLY_TMUX_SOCK_TEMPLATE = path.join(TMP, "{slug}.sock"); installTenantSlugResolver(() => SLUG); };

test("[S16·R0] 플래그 off(기본) — 옛 경로: 중계가 spawn 되고 브로커엔 요청 0", async () => {
  process.env.LIVELY_TMUX_EXEC = `${RELAY} {slug}`; process.env.LVLY_TMUX_SOCK_TEMPLATE = path.join(TMP, "{slug}.sock"); installTenantSlugResolver(() => SLUG);
  const b = fakeBroker({ sessions: [] }); await b.listen();
  try {
    const out = await tmux(["list-sessions", "-F", "x"]);
    assert.equal(out.trim(), "relayed", "옛 경로의 stdout 이 그대로 돌아온다");
    assert.deepEqual(relayCalls(), [`${SLUG} list-sessions -F x`], "중계 프로그램이 종전 argv(slug + tmux argv)로 불렸다");
    assert.deepEqual(b.got, [], "🔴 플래그가 꺼졌는데 브로커에 요청이 갔다");
  } finally { await b.close(); }
});

test("[T3-a] ★ 걷힌 그림자 값(`shadow`)은 off 다 — 옛 경로(중계 1회)만 돌고 브로커엔 요청 0(두 번 실행 없음)", async () => {
  on("shadow");
  const b = fakeBroker({ sessions: [] }); await b.listen();
  try {
    assert.equal((await tmux(["list-sessions", "-F", "x"])).trim(), "relayed", "답은 옛 경로 그대로");
    assert.deepEqual(relayCalls(), [`${SLUG} list-sessions -F x`], "중계가 종전 argv 로 1회");
    //  떼어 놓은 대조가 남아 있었다면 이 창 안에 브로커를 부른다(표본 1 = 매 호출) — 오면 곧바로 빨간불.
    for (let i = 0; i < 30 && b.got.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(b.got, [], "🔴 shadow 인데 브로커에 요청이 갔다 — 그림자 대조(두 번 실행)가 살아 있다");
  } finally { await b.close(); }
});

test("[S14] 플래그 on 인데 길이 없다(중계 없음 = 셀프호스트) / 슬러그 없음 → 새 경로 아님(null)", () => {
  process.env.LIVELY_TMUX_ROUTE = "on"; installTenantSlugResolver(() => SLUG);
  assert.equal(tmuxRouteTransport(), null, "브로커가 없으면 새 경로가 아니다");
  process.env.LIVELY_TMUX_EXEC = `${RELAY} {slug}`; process.env.LVLY_TMUX_SOCK_TEMPLATE = path.join(TMP, "{slug}.sock");
  assert.equal(tmuxRouteTransport(null), null, "슬러그 없는 호출(primary 무컨텍스트)은 중계도 {slug} 를 못 채운다 — 같은 조건");
  assert.notEqual(tmuxRouteTransport(SLUG), null);
});

test("[S17] 전송 매핑 — 소켓은 {slug} 첫 하나만 치환 · 허브 env 가 있어도 소켓이다(허브 전송은 T3-a 로 걷었다)", () => {
  process.env.LIVELY_TMUX_ROUTE = "on"; process.env.LIVELY_TMUX_EXEC = `${RELAY} {slug}`; process.env.LVLY_TMUX_SOCK_TEMPLATE = "/x/{slug}/{slug}.sock";
  //  #3797 T7 — `listScope` 가 한 칸 늘었다. 기본은 `cluster`(브로커의 종전 동작).
  const SOCKET = { transport: { kind: "socket", socketPath: "/x/acme/{slug}.sock" }, slug: SLUG, listScope: "cluster" };
  assert.deepEqual(tmuxRouteTransport(SLUG), SOCKET, "String.replace(문자열) = 첫 하나만 — relay·tmuxArgvFor 와 같은 의미");
  process.env.LVLY_HUB_URL = "http://10.0.0.1:9093"; process.env.LVLY_HUB_SECRET = "sec";
  assert.deepEqual(tmuxRouteTransport(SLUG), SOCKET, "🔴 허브 env 가 코어 경로를 허브로 돌렸다 — 걷힌 허브 전송이 살아 있다");
  //  #2600 T3-a — 그림자 값은 새 경로를 만들지 않는다(off).
  for (const v of ["shadow", "shadow:25"]) {
    process.env.LIVELY_TMUX_ROUTE = v;
    assert.equal(tmuxRouteTransport(SLUG), null, `🔴 ${v} 가 코어 경로를 열었다`);
  }
});

test("[S17b] ★★ 세션 호스트 env(#3797 T7) — 범위가 전송에 그대로 실린다", () => {
  //  이 자리가 끊기면 브로커 env 에 `LIVELY_TMUX_LIST_SCOPE=node` 를 적어도 아무 일도 안 일어난다
  //  (요청에 헤더가 안 붙고, 호스트는 조용히 클러스터 전역 목록을 자기 것이라 주장한다).
  process.env.LIVELY_TMUX_ROUTE = "on"; process.env.LIVELY_TMUX_EXEC = `${RELAY} {slug}`;
  process.env.LVLY_TMUX_SOCK_TEMPLATE = "/x/{slug}/sock";
  process.env.LIVELY_TMUX_LIST_SCOPE = "node";
  assert.equal(tmuxRouteTransport(SLUG)?.listScope, "node");
  delete process.env.LIVELY_TMUX_LIST_SCOPE;
  assert.equal(tmuxRouteTransport(SLUG)?.listScope, "cluster", "안 적으면 종전 그대로");
});

test("[R2] ★ 플래그 on — 목록 → 팬아웃(세션마다 exec) → 병합(sid 순) · 중계는 안 불린다", async () => {
  on();
  const A = { sid: "box-a-11111111", container: `lvly-s-${SLUG}-box-a-11111111`, inside: true };
  const B = { sid: "box-b-22222222", container: `lvly-s-${SLUG}-box-b-22222222`, inside: true };
  const OLD = { sid: "box-old-9999", container: `lvly-s-${SLUG}-box-old-9999`, inside: false };
  const b = fakeBroker({ sessions: [B, OLD, A] }); await b.listen();
  try {
    const out = await tmux(["list-sessions", "-F", "#{session_name}"]);
    assert.equal(out, `${A.container}\n${B.container}\n`, "표식 있는 둘만 · sid 순 · 각 줄 개행");
    assert.deepEqual(relayCalls(), [], "🔴 새 경로인데 중계가 spawn 됐다");
    assert.equal(b.got.filter((g) => g === "GET /lvly/sessions").length, 1);
    assert.deepEqual(b.got.filter((g) => g.startsWith("POST /containers/")).sort(), [`POST /containers/${A.container}/exec`, `POST /containers/${B.container}/exec`], "표식 없는 잔재엔 exec 을 안 보낸다");
  } finally { await b.close(); }
});

test("[R5] 플래그 on — 지목한 세션이 목록에 없으면 exec 없이 gone 을 던진다(can't find session · 상위가 «끝났다» 로 확정)", async () => {
  on();
  const b = fakeBroker({ sessions: [] }); await b.listen();
  try {
    await assert.rejects(tmux(["has-session", "-t", "box-zzz-00000000"]), (e: unknown) => {
      const err = e as { code: number; stderr: string };
      assert.equal(err.code, 1); assert.match(err.stderr, /^can't find session: box-zzz-00000000 /);
      assert.equal(isSessionGoneError(e, "/opt/homebrew/bin/tmux", false), true);
      assert.equal(isNoTmuxServer(e), false);
      return true;
    });
    assert.deepEqual(b.got, ["GET /lvly/sessions"], "🔴 없는 세션에 exec 을 보냈다");
  } finally { await b.close(); }
});

test("[R6] 플래그 on — 세션 0 · 관측함 → «no server running»(상위가 세션 0 으로) / 목록 조회 실패 → «못 봤다»(서버 없음으로 위장 안 함)", async () => {
  on();
  const b = fakeBroker({ sessions: [] }); await b.listen();
  try {
    await assert.rejects(tmux(["list-sessions", "-F", "x"]), (e: unknown) => { assert.equal(isNoTmuxServer(e), true); return true; });
  } finally { await b.close(); }
  const b2 = fakeBroker({ sessions: [], listStatus: 500 }); await b2.listen();
  try {
    await assert.rejects(tmux(["list-sessions", "-F", "x"]), (e: unknown) => {
      const err = e as { code: number; stderr: string };
      assert.equal(err.code, 1); assert.match(err.stderr, /못 봤다/);
      assert.equal(isNoTmuxServer(e), false, "🔴 조회 실패를 «서버 없음» 으로 읽으면 killEmptyTmuxServer 가 서버를 죽인다");
      assert.equal(isSessionGoneError(e, "/opt/homebrew/bin/tmux", true), false);
      return true;
    });
  } finally { await b2.close(); }
});

test("[R7] ★ 소켓이 없는 박스(중앙 게이트웨이에서 `on` 오설정) — execFile 오류 모양의 «못 봤다» 로 드러난다 · 허브로 새지 않는다 · 옛 경로로 폴백하지 않는다", async () => {
  //  허브 env 가 가리키는 곳에 **살아 있는** 가짜 허브를 세운다 — 걷힌 허브 전송이 살아 있으면 여기에 요청이 온다.
  const hubGot: string[] = [];
  const hub = http.createServer((q, s) => { hubGot.push(`${q.method} ${q.url}`); s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ observed: true, node: "n1", sessions: [] })); });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
  try {
    on(); process.env.LVLY_TMUX_SOCK_TEMPLATE = path.join(TMP, "no-such-dir", "{slug}.sock");
    process.env.LVLY_HUB_URL = `http://127.0.0.1:${(hub.address() as { port: number }).port}`; process.env.LVLY_HUB_SECRET = "s";
    await assert.rejects(tmux(["list-sessions", "-F", "x"]), (e: unknown) => {
      const err = e as { code?: number; stderr?: string };
      assert.equal(err.code, 1, "🔴 code 가 없는 맨 Error 다 — 상위 판정이 전부 거짓으로 떨어진다");
      assert.match(String(err.stderr), /못 봤다/);
      assert.equal(isNoTmuxServer(e), false); assert.equal(isSessionGoneError(e, "/opt/homebrew/bin/tmux", true), false);
      return true;
    });
    assert.deepEqual(hubGot, [], "🔴 허브에 요청이 갔다 — 걷힌 허브 전송이 살아 있다");
    assert.deepEqual(relayCalls(), [], "오설정을 옛 경로로 조용히 폴백하지 않는다(그러면 오설정이 영영 안 보인다)");
  } finally { await new Promise<void>((r) => hub.close(() => r())); }
});

test("[S16] 배선 — 새 갈래는 tmux() 맨 앞의 한 줄이고 옛 execFile 줄은 글자 그대로 · 걷힌 그림자·허브 전송은 흔적이 없다", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "terminal", "tmux-exec.ts"), "utf8");
  const i = src.indexOf("export async function tmux(args: string[]): Promise<string> {");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("\n}\n", i));
  assert.ok(/const via = tmuxRouteTransport\(\);\s*\n\s*if \(via\) return tmuxViaRoute\(args, via\);/.test(body), "새 갈래가 seam 머리의 한 줄이다(on 일 때만 via 가 있다)");
  assert.ok(body.includes("execFileAsync(bin!, [...prefix, ...args], { timeout: tmuxTimeoutMs(relay), env: TMUX_ENV })"), "🔴 옛 경로의 실행(프로그램·argv·상한·env)이 바뀌었다");
  //  #2600 T3-a — 그림자 대조를 걷었다. 되살아나면(떼어 놓은 두 번째 실행) 게이트웨이가 다시 표본 호출을 두 번 돈다.
  assert.ok(!/shadow/i.test(body), "🔴 tmux() 에 그림자 갈래가 남아 있다");
  assert.ok(!/tmux-shadow/.test(src), "🔴 tmux-exec.ts 가 걷힌 tmux-shadow 를 아직 가리킨다");
  assert.ok(!fs.existsSync(path.join(process.cwd(), "src", "terminal", "tmux-shadow.ts")), "🔴 tmux-shadow.ts 가 남아 있다");
  //  허브 전송도 함께 걷었다 — 코어 경로의 전송은 노드 박스 브로커 소켓 하나다.
  assert.ok(!/kind: "hub"/.test(src), "🔴 tmux-exec.ts 에 허브 전송 매핑이 남아 있다");
});
