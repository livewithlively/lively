// `tmux()` seam 의 코어 직접 경로 (#2600 T2 (d) d2) — spec-d2.md S14·S16·S17 + 살아 있는 가짜 브로커 왕복.
//
// 명제 둘: ① 플래그가 꺼져 있으면(기본) 옛 경로(중계 프로그램 spawn)가 **한 바이트도** 안 바뀐다 — 가짜 브로커엔 요청 0.
//         ② 켜져 있고 길이 있으면 코어가 목록(`GET /lvly/sessions`) → 계획 → exec 팬아웃 → 병합을 스스로 하고,
//            실패는 execFile 오류와 같은 필드로 던져 상위 판정(`isSessionGoneError`·`isNoTmuxServer`)이 종전과 같이 갈린다.
//  단언은 가짜 브로커·가짜 중계가 **받은 것**(요청 로그·argv 파일)으로 한다. 이 파일은 process.env 를 만지므로 afterEach 로 되돌린다.
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { installTenantSlugResolver } from "./catalog.js";
import { tmux, tmuxRouteTransport, isSessionGoneError, isNoTmuxServer } from "./tmux-exec.js";
import { installShadowReporter, resetShadowStats, shadowStats, type ShadowReport } from "./tmux-shadow.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-trs-"));
const SLUG = "acme";
const SOCK = path.join(TMP, `${SLUG}.sock`);
//  가짜 중계 — 불리면 argv 를 파일에 적는다(옛 경로가 실제로 spawn 됐다는 증거).
const RELAY_LOG = path.join(TMP, "relay.log");
const RELAY = path.join(TMP, "relay.sh");
//  d3 — 가짜 중계의 답을 시험이 정한다: RELAY_OUT 이 있으면 그 내용을 stdout 으로, RELAY_ERR 이 있으면 그 내용을 stderr 로 내고 exit 1.
const RELAY_OUT = path.join(TMP, "relay.out");
const RELAY_ERR = path.join(TMP, "relay.err");
fs.writeFileSync(RELAY, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${RELAY_LOG}"\nif [ -f "${RELAY_ERR}" ]; then cat "${RELAY_ERR}" >&2; exit 1; fi\nif [ -f "${RELAY_OUT}" ]; then cat "${RELAY_OUT}"; else echo relayed; fi\n`, { mode: 0o755 });
const KEYS = ["LIVELY_TMUX_EXEC", "LIVELY_TMUX_ROUTE", "LVLY_TMUX_SOCK_TEMPLATE", "LVLY_HUB_URL", "LVLY_HUB_SECRET"] as const;
afterEach(() => {
  for (const k of KEYS) delete process.env[k]; installTenantSlugResolver(() => null); installShadowReporter(null); resetShadowStats();
  for (const f of [RELAY_LOG, RELAY_OUT, RELAY_ERR]) { try { fs.unlinkSync(f); } catch { /* 없음 */ } }
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
//  d3 — 그림자는 떼어 놓고 돈다. 시험은 리포터를 갈아끼워 «다음 판정» 을 기다린다.
//   ⚠ 시한을 둔다 — 그림자 줄이 빠지면(변이 M9) 영원히 안 오는데, 매달림은 빨간불이 아니다.
const nextReport = (ms = 5_000): Promise<ShadowReport> => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`🔴 ${ms}ms 안에 그림자 판정이 안 왔다 — 그림자가 안 돌았다`)), ms);
  installShadowReporter((rep) => { clearTimeout(t); resolve(rep); });
});

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

test("[S14] 플래그 on 인데 길이 없다(중계 없음 = 셀프호스트) / 슬러그 없음 → 새 경로 아님(null)", () => {
  process.env.LIVELY_TMUX_ROUTE = "on"; installTenantSlugResolver(() => SLUG);
  assert.equal(tmuxRouteTransport(), null, "브로커가 없으면 새 경로가 아니다");
  process.env.LIVELY_TMUX_EXEC = `${RELAY} {slug}`; process.env.LVLY_TMUX_SOCK_TEMPLATE = path.join(TMP, "{slug}.sock");
  assert.equal(tmuxRouteTransport(null), null, "슬러그 없는 호출(primary 무컨텍스트)은 중계도 {slug} 를 못 채운다 — 같은 조건");
  assert.notEqual(tmuxRouteTransport(SLUG), null);
});

test("[S17] 전송 매핑 — 소켓은 {slug} 첫 하나만 치환 · 허브는 url·secret·slug 를 실어 보낸다", () => {
  process.env.LIVELY_TMUX_ROUTE = "on"; process.env.LIVELY_TMUX_EXEC = `${RELAY} {slug}`; process.env.LVLY_TMUX_SOCK_TEMPLATE = "/x/{slug}/{slug}.sock";
  assert.deepEqual(tmuxRouteTransport(SLUG), { transport: { kind: "socket", socketPath: "/x/acme/{slug}.sock" }, slug: SLUG, mode: "on", sample: 1 }, "String.replace(문자열) = 첫 하나만 — relay·tmuxArgvFor 와 같은 의미");
  process.env.LVLY_HUB_URL = "http://10.0.0.1:9093"; process.env.LVLY_HUB_SECRET = "sec";
  assert.deepEqual(tmuxRouteTransport(SLUG), { transport: { kind: "hub", url: "http://10.0.0.1:9093", secret: "sec", slug: SLUG }, slug: SLUG, mode: "on", sample: 1 });
  process.env.LIVELY_TMUX_ROUTE = "shadow:25";
  assert.deepEqual(tmuxRouteTransport(SLUG)?.mode, "shadow"); assert.equal(tmuxRouteTransport(SLUG)?.sample, 0.25);
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

test("[R7] 설정 오류(https 허브)도 execFile 오류 모양(code·stderr)으로 던진다 — 맨 Error 가 아니다 · «못 봤다» 로 읽힌다", async () => {
  on(); process.env.LVLY_HUB_URL = "https://h:9093"; process.env.LVLY_HUB_SECRET = "s";
  await assert.rejects(tmux(["list-sessions", "-F", "x"]), (e: unknown) => {
    const err = e as { code?: number; stderr?: string };
    assert.equal(err.code, 1, "🔴 code 가 없는 맨 Error 다 — 상위 판정이 전부 거짓으로 떨어진다");
    assert.match(String(err.stderr), /못 봤다/);
    assert.equal(isNoTmuxServer(e), false); assert.equal(isSessionGoneError(e, "/opt/homebrew/bin/tmux", true), false);
    return true;
  });
  assert.deepEqual(relayCalls(), [], "설정 오류를 옛 경로로 조용히 폴백하지 않는다(그러면 오설정이 영영 안 보인다)");
});

test("[S16] 배선 — 새 갈래는 tmux() 맨 앞의 한 줄이고 옛 execFile 줄은 글자 그대로 남아 있다", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "terminal", "tmux-exec.ts"), "utf8");
  const i = src.indexOf("export async function tmux(args: string[]): Promise<string> {");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("\n}\n", i));
  assert.ok(/const via = tmuxRouteTransport\(\);\s*\n\s*if \(via\?\.mode === "on"\) return tmuxViaRoute\(args, via\);/.test(body), "새 갈래가 seam 머리의 한 줄이다(on 일 때만)");
  assert.ok(body.includes("execFileAsync(bin!, [...prefix, ...args], { timeout: tmuxTimeoutMs(relay), env: TMUX_ENV })"), "🔴 옛 경로의 실행(프로그램·argv·상한·env)이 바뀌었다");
  assert.ok(/if \(via\?\.mode === "shadow"\) void shadowTmux\(/.test(body), "d3 — 그림자는 떼어 놓은(void) 한 줄이다: 옛 경로의 답·지연·예외에 손대지 않는다");
});

// ── d3 그림자 대조 — spec-d3.md R0~R5 ──────────────────────────────────────────────────────
const A = { sid: "box-a-11111111", container: `lvly-s-${SLUG}-box-a-11111111`, inside: true };
const B = { sid: "box-b-22222222", container: `lvly-s-${SLUG}-box-b-22222222`, inside: true };

test("[R0·R1] shadow — 읽기 동사: 옛 경로(중계)의 stdout 이 바이트 그대로 돌아오고 · 브로커엔 목록+exec · 판정 match", async () => {
  on("shadow");
  fs.writeFileSync(RELAY_OUT, `${A.container}\n${B.container}\n`);
  const b = fakeBroker({ sessions: [B, A] }); await b.listen();
  try {
    const rep = nextReport();
    const out = await tmux(["list-sessions", "-F", "#{session_name}"]);
    assert.equal(out, `${A.container}\n${B.container}\n`, "🔴 shadow 인데 답이 옛 경로 것이 아니다");
    assert.deepEqual(relayCalls(), [`${SLUG} list-sessions -F #{session_name}`], "중계가 종전 argv 로 1회");
    const r = await rep;
    assert.deepEqual(r.verdict, { kind: "match" }); assert.equal(r.executed, true); assert.equal(r.verb, "list-sessions"); assert.equal(r.slug, SLUG);
    assert.equal(b.got.filter((g) => g === "GET /lvly/sessions").length, 1);
    assert.deepEqual(b.got.filter((g) => g.startsWith("POST /containers/")).sort(), [`POST /containers/${A.container}/exec`, `POST /containers/${B.container}/exec`], "읽기 동사는 코어 경로를 실제로 실행한다");
    assert.equal(shadowStats().compared, 1); assert.equal(shadowStats().match, 1);
  } finally { await b.close(); }
});

test("[R1b] shadow — 줄 집합이 같고 순서만 다르면 explained:order (브로커 팬아웃 = 색인 삽입순 · 코어 = sid 순)", async () => {
  on("shadow");
  fs.writeFileSync(RELAY_OUT, `${B.container}\n${A.container}\n`);
  const b = fakeBroker({ sessions: [A, B] }); await b.listen();
  try {
    const rep = nextReport();
    assert.equal(await tmux(["list-sessions", "-F", "#{session_name}"]), `${B.container}\n${A.container}\n`, "답은 여전히 옛 경로 순서 그대로");
    assert.deepEqual((await rep).verdict, { kind: "explained", why: "order" });
  } finally { await b.close(); }
});

test("[R2] shadow — 쓰기 동사(set-option -t)는 **계획만**: 브로커엔 GET /lvly/sessions 뿐(exec 0) · 중계 1회 · 판정 match", async () => {
  on("shadow");
  const b = fakeBroker({ sessions: [A] }); await b.listen();
  try {
    const rep = nextReport();
    assert.equal((await tmux(["set-option", "-t", A.sid, "@box_label", "x"])).trim(), "relayed");
    assert.deepEqual(relayCalls(), [`${SLUG} set-option -t ${A.sid} @box_label x`]);
    const r = await rep;
    assert.deepEqual(r.verdict, { kind: "match" }); assert.equal(r.executed, false);
    assert.deepEqual(b.got, ["GET /lvly/sessions"], "🔴 쓰기 동사를 그림자가 실행했다(두 번 들어간다)");
  } finally { await b.close(); }
});

test("[R3] shadow — 브로커가 죽어 있어도 옛 답 그대로 · 판정 explained:new-transport · tmux() 는 실패하지 않는다", async () => {
  on("shadow");
  const rep = nextReport();
  assert.equal((await tmux(["list-sessions", "-F", "x"])).trim(), "relayed");
  assert.deepEqual((await rep).verdict, { kind: "explained", why: "new-transport" });
});

test("[R4] shadow — 중계가 gone(exit 1)이면 **같은 오류**(code·stderr)를 던진다 · 코어 계획도 gone 이면 match", async () => {
  on("shadow");
  const gone = `can't find session: box-zzz-00000000 (session container lvly-s-${SLUG}-box-zzz-00000000 is gone)\n`;
  fs.writeFileSync(RELAY_ERR, gone);
  const b = fakeBroker({ sessions: [A] }); await b.listen();
  try {
    const rep = nextReport();
    await assert.rejects(tmux(["has-session", "-t", "box-zzz-00000000"]), (e: unknown) => {
      const err = e as { code: number; stderr: string };
      assert.equal(err.code, 1); assert.equal(err.stderr, gone, "옛 경로의 stderr 가 바이트 그대로");
      assert.equal(isSessionGoneError(e, "/opt/homebrew/bin/tmux", false), true);
      return true;
    });
    const r = await rep;
    assert.deepEqual(r.verdict, { kind: "match" }, "has-session 은 읽기라 실행됐고 코어도 exec 없이 gone 을 합성했다");
    assert.deepEqual(b.got, ["GET /lvly/sessions"], "없는 세션엔 exec 을 안 보낸다");
  } finally { await b.close(); }
});

test("[R4b] shadow — 옛 경로 성공인데 코어 목록엔 그 세션이 없다 → mismatch:plan (설명되지 않는 불일치가 드러난다)", async () => {
  on("shadow");
  const b = fakeBroker({ sessions: [] }); await b.listen();
  try {
    const rep = nextReport();
    assert.equal((await tmux(["set-option", "-t", A.sid, "@x", "1"])).trim(), "relayed");
    const r = await rep;
    assert.equal(r.verdict.kind, "mismatch"); assert.equal((r.verdict as { why: string }).why, "plan");
    assert.equal(shadowStats().mismatch.plan, 1);
  } finally { await b.close(); }
});

test("[R5] shadow — 리포터가 던져도 tmux() 는 멀쩡하다 · 판정은 세어진다", async () => {
  on("shadow");
  installShadowReporter(() => { throw new Error("리포터 고장"); });
  assert.equal((await tmux(["list-sessions", "-F", "x"])).trim(), "relayed");
  //  떼어 놓은 그림자가 끝날 때까지 — 브로커가 없으니 연결 거절로 곧 끝난다.
  for (let i = 0; i < 200 && shadowStats().compared === 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(shadowStats().compared, 1);
});

test("[R6] shadow — 플래그가 shadow 인데 길이 없으면(셀프호스트) 그림자도 없다 · 옛 경로만", async () => {
  process.env.LIVELY_TMUX_ROUTE = "shadow"; process.env.LIVELY_TMUX_EXEC = `${RELAY} {slug}`; installTenantSlugResolver(() => null);
  assert.equal(tmuxRouteTransport(), null, "슬러그 없음 = 중계도 못 채운다 = 그림자도 없다");
});
