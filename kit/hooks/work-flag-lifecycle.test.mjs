#!/usr/bin/env node
// work-flag 세션 라이프사이클 보고 유닛테스트 (#1059) — 훅을 실제 프로세스로 띄우고, 스텁 게이트웨이가 받은
//  HTTP POST(부작용)로 단언한다. 로그 문자열이 아니라 **무엇이 어디로 나갔나**를 본다.
//   - SessionEnd(reason=prompt_input_exit·logout) → POST …/exited (정상종료 표시 → 복원목록 '종료됨' 구분)
//   - SessionEnd(reason=clear 등)               → POST 없음 (세션이 이어지므로 종료 아님)
//   - SessionStart                              → POST …/claude-uuid (정밀복원 매핑 — 편집·MCP 없는 대화도 잡히게)
//  실행: node kit/hooks/work-flag-lifecycle.test.mjs  (npm test 체인에 포함)
//  오프라인: 게이트웨이는 127.0.0.1 인프로세스 스텁. 실제 ~/.lively·/tmp 무접촉(샌드박스 HOME/TMPDIR).
//  ⚠ 인프로세스 스텁이 응답하려면 이벤트루프가 돌아야 하므로 훅은 **비동기 spawn**으로 띄운다(execFileSync 는 루프를 막아 못 받음).
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HOOK = join(fileURLToPath(import.meta.url), "..", "work-flag.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "wfl-test-"));
const HOME = join(SANDBOX, "home");
const TMP = join(SANDBOX, "tmp");
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

// 스텁 게이트웨이 — 받은 POST 를 기록. 각 요청의 (method, path, body) 를 남긴다.
let reqs = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    reqs.push({ method: req.method, path: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const GW = `http://127.0.0.1:${PORT}`;

const BOX = "box-test-abcd1234";
let n = 0;
// 훅을 실제 프로세스로 실행하고(비동기), 스텁이 받은 요청 배열을 돌려준다.
function runHook(input, env = {}) {
  reqs = [];
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env, HOME, TMPDIR: TMP,
        LIVELY_OFF: "", LIVELY_HOOKS_OFF: "",
        LIVELY_TOKEN: "test-token", LIVELY_GATEWAY_URL: GW,
        LIVELY_SESSION_ID: BOX,
        ...env,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    cp.stdin.write(JSON.stringify(input)); cp.stdin.end();
    cp.on("close", () => setImmediate(() => resolve(reqs.slice())));
    cp.on("error", () => resolve(reqs.slice()));
  });
}

// ── E1: SessionEnd(prompt_input_exit) → POST …/exited, /claude-uuid 미호출 ──
{
  const r = await runHook({ session_id: `u${++n}`, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  const exited = r.filter((x) => x.method === "POST" && x.path === `/api/ui/terminal/sessions/${BOX}/exited`);
  const uuidCalls = r.filter((x) => x.path.endsWith("/claude-uuid"));
  if (exited.length === 1 && uuidCalls.length === 0) {
    let reason = null; try { reason = JSON.parse(exited[0].body).reason; } catch { /* */ }
    reason === "prompt_input_exit" ? ok("E1 SessionEnd(/exit) → POST /exited {reason}") : bad("E1 reason", `body=${exited[0].body}`);
  } else bad("E1 SessionEnd(/exit) → /exited", `exited=${exited.length} uuid=${uuidCalls.length} all=${JSON.stringify(r.map((x) => x.path))}`);
}

// ── E2: SessionEnd(logout) → POST …/exited ──
{
  const r = await runHook({ session_id: `u${++n}`, hook_event_name: "SessionEnd", reason: "logout" });
  r.some((x) => x.method === "POST" && x.path === `/api/ui/terminal/sessions/${BOX}/exited`)
    ? ok("E2 SessionEnd(logout) → POST /exited") : bad("E2 logout", `paths=${JSON.stringify(r.map((x) => x.path))}`);
}

// ── E3: SessionEnd(clear) → POST 없음 (세션이 이어지므로 종료 아님) ──
{
  const r = await runHook({ session_id: `u${++n}`, hook_event_name: "SessionEnd", reason: "clear" });
  r.length === 0 ? ok("E3 SessionEnd(clear) → POST 0건") : bad("E3 clear", `예상 0건, 실제=${JSON.stringify(r.map((x) => x.path))}`);
}

// ── E4: SessionStart → POST …/claude-uuid {uuid:session_id}, /exited 미호출 (정밀복원 매핑, 회귀락) ──
{
  const sid = `s${++n}-uuid`;
  const r = await runHook({ session_id: sid, hook_event_name: "SessionStart", source: "startup" });
  const uuid = r.filter((x) => x.method === "POST" && x.path === `/api/ui/terminal/sessions/${BOX}/claude-uuid`);
  const exitedCalls = r.filter((x) => x.path.endsWith("/exited"));
  if (uuid.length === 1 && exitedCalls.length === 0) {
    let u = null; try { u = JSON.parse(uuid[0].body).uuid; } catch { /* */ }
    u === sid ? ok("E4 SessionStart → POST /claude-uuid {uuid}") : bad("E4 uuid", `body=${uuid[0].body}`);
  } else bad("E4 SessionStart → /claude-uuid", `uuid=${uuid.length} exited=${exitedCalls.length} all=${JSON.stringify(r.map((x) => x.path))}`);
}

// ── E5: SessionEnd(prompt_input_exit) 이지만 box-id 없음 → POST 없음(비-box 세션 fail-open) ──
{
  const r = await runHook({ session_id: `u${++n}`, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, { LIVELY_SESSION_ID: "" });
  r.length === 0 ? ok("E5 box-id 없음 → POST 0건") : bad("E5 no-box", `실제=${JSON.stringify(r.map((x) => x.path))}`);
}

// ── E6: 토큰 없음 → POST 없음(스톨 없이 fail-open) ──
{
  const r = await runHook({ session_id: `u${++n}`, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, { LIVELY_TOKEN: "" });
  // 토큰이 env 에도 없고 HOME/.lively/token 도 없으니 미전송.
  r.length === 0 ? ok("E6 토큰 없음 → POST 0건") : bad("E6 no-token", `실제=${JSON.stringify(r.map((x) => x.path))}`);
}

server.close();
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`work-flag-lifecycle tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
