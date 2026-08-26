// codex **App Server** 실바이너리 E2E (#2055) — 계정 없이 CI 에서 돈다.
//
//  ── 왜 이 파일이 필요한가 ──
//  codex-app-server*.test.ts 는 전송을 가짜로 갈아 끼운 계약 테스트다(모양만 본다). 그런데 이 방식의 진짜 위험은
//  **codex 가 프로토콜을 바꾸는 것**이다 — 문서가 `app-server` 를 experimental 로 못박았고, 버전마다 스키마를
//  재생성하라고 안내한다. 그 드리프트는 실바이너리로만 잡힌다.
//
//  ── 계정 없이 도는 장치(kit/setup/codex-e2e.test.mjs 와 같은 수법) ──
//  `[model_providers.stub]` + `requires_openai_auth=false` + `wire_api="responses"` 로 로컬 SSE 스텁을 물린다.
//  ⚠ wire_api 는 "responses" 여야 한다 — "chat" 은 0.149 에서 거부된다(#1884 실측).
//
//  ── 여기서 지키는 계약(전부 2026-08-26 실측) ──
//   ① 전송은 **줄바꿈 구분 JSON**. initialize 응답에 codexHome 이 온다.
//   ② thread/start → turn/start → item/* → turn/completed 가 한 턴이다.
//   ③ 우리 번역기가 그 알림을 ChatLine(user·assistant·turn_duration)으로 옮긴다.
//   ④ ★ 스레드당 writer 는 하나다 — 두 번째 프로세스의 thread/resume 은 `active writer` 로 거부된다.
//      (이 성질 때문에 codex 세션의 터미널 탭을 셸로 바꿨다. 성질이 바뀌면 그 설계 근거가 무너지므로 여기서 감시한다.)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const has = (bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
if (!has("codex")) { console.log("skip  codex 없음 — App Server E2E 건너뜀"); process.exit(0); }

const SB = mkdtempSync(join(tmpdir(), "codex-as-e2e-"));
const CODEXHOME = join(SB, "codex-home");
const PROJ = join(SB, "proj");
let serverProc = null;
const procs = [];
const cleanup = () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* 이미 죽었다 */ } }
  try { serverProc?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(SB, { recursive: true, force: true }); } catch { /* */ }
};
process.on("exit", cleanup);

// ── 스텁 Responses 서버 ─────────────────────────────────────────────────────
writeFileSync(join(SB, "stub.mjs"), `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (!/\\/responses$/.test(req.url || "")) { res.writeHead(404, { "content-type": "application/json", "connection": "close" }); res.end("{}"); return; }
    // ⚠ connection: close — keep-alive 면 SSE 클라이언트가 스트림 끝을 못 보고 매달린다(실측 함정).
    res.writeHead(200, { "content-type": "text/event-stream", "connection": "close" });
    const sse = (type, obj) => res.write("event: " + type + "\\ndata: " + JSON.stringify({ type, ...obj }) + "\\n\\n");
    const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "APPSERVER_OK", annotations: [] }] };
    sse("response.created", { response: { id: "r1", object: "response", status: "in_progress", output: [] } });
    sse("response.output_item.done", { output_index: 0, item });
    sse("response.completed", { response: { id: "r1", object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
`);
serverProc = spawn(process.execPath, [join(SB, "stub.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
const PORT = await new Promise((resolve, reject) => {
  let buf = ""; const t = setTimeout(() => reject(new Error("스텁 서버 기동 타임아웃")), 10000);
  serverProc.stdout.on("data", (c) => { buf += c; const m = /PORT=(\d+)/.exec(buf); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
});

mkdirSync(CODEXHOME, { recursive: true });
mkdirSync(PROJ, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: PROJ, stdio: "ignore" });
writeFileSync(join(CODEXHOME, "config.toml"), [
  'model_provider = "stub"', 'model = "stub-1"', "",
  "[model_providers.stub]", 'name = "Stub"',
  `base_url = "http://127.0.0.1:${PORT}/v1"`,
  'env_key = "STUB_API_KEY"', 'wire_api = "responses"', "requires_openai_auth = false", "",
  // 폴더 신뢰 — 안 해 두면 첫 턴에서 신뢰 질문에 걸린다(TUI 의 "Do you trust this directory?" 와 같은 관문).
  `[projects."${PROJ}"]`, 'trust_level = "trusted"', "",
].join("\n"));
const ENV = { ...process.env, CODEX_HOME: CODEXHOME, STUB_API_KEY: "x" };

// ── 최소 JSON-RPC 클라이언트(제품 코드를 쓰지 않는다 — 프로토콜 자체를 본다) ──
function open() {
  const p = spawn("codex", ["app-server"], { cwd: PROJ, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(p);
  const waiters = new Map(); const notes = []; const serverReqs = [];
  let buf = "", nextId = 1, onNote = null;
  p.stdout.on("data", (c) => {
    buf += c.toString("utf8"); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method && m.id !== undefined) {          // 서버 → 우리 **요청**(승인·신뢰). 답하지 않으면 턴이 멈춘다.
        serverReqs.push(m.method);
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { decision: "accept" } }) + "\n");
        continue;
      }
      if (m.method && m.id === undefined) { notes.push(m); onNote?.(m); continue; }
      if (m.id !== undefined && !m.method) { waiters.get(m.id)?.(m); waiters.delete(m.id); }
    }
  });
  const req = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`${method} 응답 없음`)), 30000);
    waiters.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const note = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: {} }) + "\n");
  const waitNote = (method) => new Promise((resolve, reject) => {
    const hit = notes.find((n) => n.method === method); if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error(`${method} 알림 없음`)), 60000);
    onNote = (n) => { if (n.method === method) { clearTimeout(t); onNote = null; resolve(n); } };
  });
  return { proc: p, req, note, waitNote, notes, serverReqs };
}

let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

// ① 핸드셰이크
const A = open();
const init = await A.req("initialize", { clientInfo: { name: "lively-e2e", title: "Lively", version: "1" } });
A.note("initialized");
// 경로는 realpath 로 비교한다 — macOS 의 /var 는 /private/var 심볼릭 링크라 문자열 비교가 어긋난다.
assert.equal(realpathSync(String(init.codexHome)), realpathSync(CODEXHOME), "initialize 는 이 프로세스의 CODEX_HOME 을 돌려준다");
ok("① initialize — 줄바꿈 구분 JSON, codexHome 확인");

// ② 한 턴
const started = await A.req("thread/start", { cwd: PROJ, approvalPolicy: "never", sandbox: "read-only" });
const threadId = started.thread.id;
assert.match(threadId, /^[0-9a-f-]{16,}$/i, "thread id 는 uuid 꼴이다");
await A.req("turn/start", { threadId, input: [{ type: "text", text: "아무 말" }] });
const completed = await A.waitNote("turn/completed");
assert.equal(completed.params.threadId, threadId);
ok("② thread/start → turn/start → turn/completed");

// ③ 우리 번역기가 그 알림을 ChatLine 으로 옮긴다
const { appServerLines } = await import(pathToFileURL(join(process.cwd(), "dist/terminal/harness-io/codex-app-server-events.js")).href);
let state = {}; const lines = [];
for (const n of A.notes) { const r = appServerLines(n, state); state = r.state; lines.push(...r.lines); }
const answer = lines.find((l) => l.type === "assistant" && l.message.content.some((b) => b.type === "text" && b.text.includes("APPSERVER_OK")));
assert.ok(answer, `번역된 assistant 줄이 있어야 한다 — 실제: ${JSON.stringify(lines.map((l) => l.type))}`);
assert.ok(lines.some((l) => l.type === "user"), "사람 말도 줄로 온다");
assert.ok(lines.some((l) => l.type === "system" && l.subtype === "turn_duration"), "턴 마감이 온다");
ok("③ 알림 → ChatLine(user·assistant·turn_duration) 번역");

// ④ ★ 스레드당 writer 는 하나 — 이 성질이 '터미널 탭은 셸' 설계의 근거다
const B = open();
await B.req("initialize", { clientInfo: { name: "lively-e2e-2", title: "Lively", version: "1" } });
B.note("initialized");
await assert.rejects(
  () => B.req("thread/resume", { threadId }),
  (e) => /active writer|conflict/i.test(e.message),
  "다른 프로세스가 쥔 스레드는 열리면 안 된다",
);
ok("④ 스레드당 writer 는 하나(두 번째 프로세스의 resume 은 거부)");

// ⑤ 첫 프로세스를 내리면 인계된다(순차 인계는 된다 — 대화가 안 끊긴다)
A.proc.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 1500));
const resumed = await B.req("thread/resume", { threadId });
assert.equal(resumed.thread.id, threadId);
ok("⑤ 앞 프로세스를 내리면 같은 스레드를 이어받는다(터미널 인계 경로)");

console.log(`\n${pass} passed`);
// ⚠ 명시적으로 끝낸다 — 자식(app-server)의 stdin 파이프가 이벤트 루프를 붙잡아 **끝나도 프로세스가 안 죽는다**
//  (실측: CI 라면 그대로 매달린다). cleanup 은 exit 훅으로 한 번 더 돈다.
cleanup();
process.exit(0);
