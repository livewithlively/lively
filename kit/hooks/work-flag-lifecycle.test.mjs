#!/usr/bin/env node
// work-flag 세션 라이프사이클 보고 유닛테스트 (#1059) — 훅을 실제 프로세스로 띄우고, 스텁 게이트웨이가 받은
//  HTTP POST(부작용)로 단언한다. 로그 문자열이 아니라 **무엇이 어디로 나갔나**를 본다.
//   - SessionEnd(reason=prompt_input_exit·logout) → POST …/exited (정상종료 표시 → 복원목록 '종료됨' 구분)
//   - SessionEnd(reason=clear 등)               → POST 없음 (세션이 이어지므로 종료 아님)
//   - SessionStart                              → POST …/claude-uuid (정밀복원 매핑 — 편집·MCP 없는 대화도 잡히게)
//  실행: node kit/hooks/work-flag-lifecycle.test.mjs  (npm test 체인에 포함)
//  오프라인: 게이트웨이는 127.0.0.1 인프로세스 스텁. 실제 ~/.lively·/tmp 무접촉(샌드박스 HOME/TMPDIR).
//  ⚠ 인프로세스 스텁이 응답하려면 이벤트루프가 돌아야 하므로 훅은 **비동기 spawn**으로 띄운다(execFileSync 는 루프를 막아 못 받음).
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
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
let nextStatus = 200;   // 다음 응답 상태코드(실패 재시도 검증용 — 1회 쓰고 200 으로 복귀)
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    reqs.push({ method: req.method, path: req.url, body });
    res.writeHead(nextStatus, { "content-type": "application/json" });
    nextStatus = 200;                       // 1회성 — 다음 요청은 정상
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

// ── E7: 같은 box + 같은 UUID 를 두 번 → 두 번째는 보고 없음(dedup 유지 — 핫패스에서 매번 fetch 하면 툴 사용이 느려진다) ──
{
  const sid = `dup${++n}`;
  const first = await runHook({ session_id: sid, hook_event_name: "SessionStart", source: "startup" });
  const second = await runHook({ session_id: sid, hook_event_name: "SessionStart", source: "startup" });
  const cnt = (r) => r.filter((x) => x.path.endsWith("/claude-uuid")).length;
  cnt(first) === 1 && cnt(second) === 0
    ? ok("E7 같은 (box,UUID) 는 1회만 보고")
    : bad("E7 dedup", `1차=${cnt(first)} 2차=${cnt(second)}`);
}

// ── E8: 같은 UUID + **다른 box-id** → 다시 보고한다 (복원 시나리오 — 이번 수정의 핵심) ──
//  복원(restore)은 같은 대화(UUID)를 새 box 로 이어받는다. dedup 키가 UUID 만이면 여기서 보고가 스킵돼
//  새 세션에 매핑이 안 붙고 → 그 세션을 다시 복원할 때 정밀 복원이 안 되고 후보 picker 로 떨어진다
//  (2026-07-28 실측 신고: 정밀 복원이 딱 한 번만 됨). 그래서 box 가 다르면 반드시 다시 보고해야 한다.
{
  const sid = `resumed${++n}`;
  const BOX2 = "box-test-99990000";
  const first = await runHook({ session_id: sid, hook_event_name: "SessionStart", source: "startup" });
  const afterRestore = await runHook({ session_id: sid, hook_event_name: "SessionStart", source: "resume" }, { LIVELY_SESSION_ID: BOX2 });
  const to = (r, box) => r.filter((x) => x.method === "POST" && x.path === `/api/ui/terminal/sessions/${box}/claude-uuid`);
  if (to(first, BOX).length === 1 && to(afterRestore, BOX2).length === 1) {
    let u = null; try { u = JSON.parse(to(afterRestore, BOX2)[0].body).uuid; } catch { /* */ }
    u === sid ? ok("E8 같은 UUID·새 box → 새 box 에 다시 보고(복원 매핑 승계)") : bad("E8 uuid", `body=${to(afterRestore, BOX2)[0].body}`);
  } else bad("E8 새 box 재보고", `1차(${BOX})=${to(first, BOX).length} 복원후(${BOX2})=${to(afterRestore, BOX2).length} all=${JSON.stringify(afterRestore.map((x) => x.path))}`);
}

// ── E9: PostToolUse → **활동 보고**(/active). 회수(F)가 이 시각을 본다 ─────────────────
// 종전엔 게이트웨이가 5분마다 pane 제목 스피너를 훔쳐보는 게 유일한 활동 관측이라, tick 사이에 짧게 끝나는
//  작업을 놓쳐 **도는 세션이 회수될 수 있었다**. 훅은 툴 사용마다 실제로 실행되므로 추측이 아니다.
{
  const r = await runHook({ session_id: `act${++n}`, hook_event_name: "PostToolUse", tool_name: "Edit" });
  const act = r.filter((x) => x.method === "POST" && x.path === `/api/ui/terminal/sessions/${BOX}/active`);
  act.length === 1 ? ok("E9 PostToolUse → POST /active(활동 보고)") : bad("E9 /active", `실제=${JSON.stringify(r.map((x) => x.path))}`);
}

// ── E10: 60초 스로틀 — 같은 세션의 다음 툴 사용은 보고하지 않는다(핫패스 부담) ──
{
  rmSync(join(TMP, "lively-hooks"), { recursive: true, force: true });   // 앞 케이스의 스로틀 플래그와 격리
  //  ⚠ 스로틀은 **box 단위**(`<boxId>.active`)다 — 세션(sid)이 달라도 같은 box 면 공유된다. 그게 의도다.
  const r1 = await runHook({ session_id: `thr${++n}`, hook_event_name: "PostToolUse", tool_name: "Edit" });
  const r2 = await runHook({ session_id: `thr${n}`, hook_event_name: "PostToolUse", tool_name: "Write" });
  const cnt = (r) => r.filter((x) => x.path.endsWith("/active")).length;
  cnt(r1) === 1 && cnt(r2) === 0 ? ok("E10 활동 보고는 60초 스로틀(연속 툴에 매번 안 쏜다)")
    : bad("E10 스로틀", `1차=${cnt(r1)} 2차=${cnt(r2)}`);
}

// ── E11: SessionStart 는 활동이 아니다 — /active 를 보내지 않는다(UUID 매핑만) ──
{
  rmSync(join(TMP, "lively-hooks"), { recursive: true, force: true });   // 스로틀 플래그 초기화
  const r = await runHook({ session_id: `st${++n}`, hook_event_name: "SessionStart", source: "startup" });
  const act = r.filter((x) => x.path.endsWith("/active"));
  const uuid = r.filter((x) => x.path.endsWith("/claude-uuid"));
  act.length === 0 && uuid.length === 1 ? ok("E11 SessionStart → UUID 만 보고(활동 보고 아님)")
    : bad("E11 SessionStart", `active=${act.length} uuid=${uuid.length}`);
}

// ── E12: UUID 보고가 **실패하면 재시도 가능**해야 한다 ──────────────────────────────
// 종전엔 성공·실패 무관하게 완료 플래그를 먼저 써서, 세션 시작 순간 게이트웨이가 잠깐 다운이면
//  **그 세션이 영구 무매핑**이 됐다(복원이 늘 후보 picker 로 떨어진다).
{
  rmSync(join(TMP, "lively-hooks"), { recursive: true, force: true });
  const sid = `retry${++n}`;
  nextStatus = 503;                                   // 1차 보고는 실패
  const r1 = await runHook({ session_id: sid, hook_event_name: "SessionStart", source: "startup" });
  const flagDir = join(TMP, "lively-hooks");
  const mapped = `${BOX}.${sid}.mapped`;
  const doneAfterFail = existsSync(join(flagDir, mapped));
  // 쿨다운(60초)만 남아야 한다 — 완료 플래그가 있으면 영구 포기다.
  rmSync(join(flagDir, `${mapped}.try`), { force: true });   // 쿨다운 지난 상황을 흉내
  const r2 = await runHook({ session_id: sid, hook_event_name: "SessionStart", source: "resume" });
  const tried = (r) => r.filter((x) => x.path.endsWith("/claude-uuid")).length;
  if (!doneAfterFail && tried(r1) === 1 && tried(r2) === 1 && existsSync(join(flagDir, mapped))) {
    ok("E12 보고 실패는 영구 포기가 아니다 — 다음 기회에 재시도하고 성공하면 완료 표시");
  } else bad("E12 재시도", `실패후완료=${doneAfterFail} 1차=${tried(r1)} 2차=${tried(r2)} 최종완료=${existsSync(join(flagDir, mapped))}`);
}

// ══ #1221 실행 단계 보고 — 화면 스크래핑을 대체하는 주신호. 훅이 '무엇을' 보내는지가 계약의 전부다 ══════
const fresh = () => rmSync(join(TMP, "lively-hooks"), { recursive: true, force: true });   // 상태·스로틀 플래그 초기화
const states = (r) => r.filter((x) => x.method === "POST" && x.path === `/api/ui/terminal/sessions/${BOX}/active`)
  .map((x) => { try { return JSON.parse(x.body).state; } catch { return null; } });

// ── E13: 턴 시작(UserPromptSubmit) → busy ──────────────────────────────────────────
// 종전엔 '지금 작업 중'을 게이트웨이가 pane 제목의 브라유 스피너 글리프로 추측했다(UI 가 바뀌면 조용히 깨지고,
//  코덱스처럼 스피너를 안 그리는 하네스는 영영 안 잡힌다). 사용자가 프롬프트를 넣은 이 순간이 진짜 턴 시작이다.
{
  fresh();
  const r = await runHook({ session_id: `ph${++n}`, hook_event_name: "UserPromptSubmit", prompt_text: "안녕" });
  const s = states(r);
  s.length === 1 && s[0] === "busy" ? ok("E13 UserPromptSubmit → state=busy(턴 시작)") : bad("E13 busy", `실제=${JSON.stringify(s)}`);
}

// ── E14: 턴 종료(Stop) → idle. **전이는 스로틀에 막히면 안 된다** ─────────────────────
// 같은 상태의 반복만 60초 스로틀 대상이다. 전이(busy→idle)가 막히면 끝난 세션이 계속 '작업 중'으로 보이고,
//  회수(F)도 그 세션을 영원히 보호한다 — 스로틀이 정보를 삼키는 가장 위험한 지점이라 여기서 못박는다.
{
  fresh();
  const r1 = await runHook({ session_id: `ph${++n}`, hook_event_name: "PostToolUse", tool_name: "Edit" });
  const r2 = await runHook({ session_id: `ph${n}`, hook_event_name: "Stop", stop_hook_active: false });
  const s1 = states(r1), s2 = states(r2);
  s1[0] === "busy" && s2.length === 1 && s2[0] === "idle"
    ? ok("E14 Stop → state=idle(턴 종료). 상태 전이는 60초 스로틀을 뚫는다")
    : bad("E14 전이", `busy=${JSON.stringify(s1)} idle=${JSON.stringify(s2)}`);
}

// ── E15: 승인 대기(Notification) → waiting. 신·구 페이로드 형식 둘 다 ──────────────────
// notification_type 은 비교적 최근 Claude Code 만 준다 — 구버전은 message 문구뿐이다. 한쪽만 보면 그 버전에서
//  '확인 필요'가 통째로 사라진다(가장 행동을 요하는 상태다).
{
  fresh();
  const r1 = await runHook({ session_id: `ph${++n}`, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  fresh();
  const r2 = await runHook({ session_id: `ph${++n}`, hook_event_name: "Notification", message: "Claude needs your permission to use Bash" });
  const s1 = states(r1), s2 = states(r2);
  s1[0] === "waiting" && s2[0] === "waiting"
    ? ok("E15 Notification(권한 요청) → state=waiting (신형 notification_type·구형 message 모두)")
    : bad("E15 waiting", `신형=${JSON.stringify(s1)} 구형=${JSON.stringify(s2)}`);
}

// ── E16: 상태와 무관한 알림은 보고하지 않는다 ─────────────────────────────────────
// Notification 에 matcher 를 안 걸었으므로(구 빌드에서 엔트리가 통째로 안 걸리는 걸 피하려고) auth_success 같은
//  알림도 훅을 깨운다. 그걸 상태로 오역하면 로그인 성공이 '확인 필요'가 된다.
{
  fresh();
  const r = await runHook({ session_id: `ph${++n}`, hook_event_name: "Notification", notification_type: "auth_success", message: "Login successful" });
  states(r).length === 0 ? ok("E16 상태와 무관한 알림(auth_success)은 보고 안 함") : bad("E16 무관 알림", `실제=${JSON.stringify(states(r))}`);
}

// ── E17: 같은 상태의 반복은 스로틀 — 다른 이벤트라도 마찬가지 ────────────────────────
// UserPromptSubmit(busy) 직후의 PostToolUse(busy)는 같은 사실의 반복이다. 이걸 안 막으면 툴 하나 쓸 때마다
//  게이트웨이 왕복이 붙는다(핫패스).
{
  fresh();
  const r1 = await runHook({ session_id: `ph${++n}`, hook_event_name: "UserPromptSubmit", prompt_text: "x" });
  const r2 = await runHook({ session_id: `ph${n}`, hook_event_name: "PostToolUse", tool_name: "Edit" });
  states(r1).length === 1 && states(r2).length === 0
    ? ok("E17 같은 상태(busy)의 반복은 이벤트가 달라도 60초 스로틀")
    : bad("E17 동일상태 스로틀", `1차=${JSON.stringify(states(r1))} 2차=${JSON.stringify(states(r2))}`);
}

server.close();
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`work-flag-lifecycle tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
