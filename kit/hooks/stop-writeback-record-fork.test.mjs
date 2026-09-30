#!/usr/bin/env node
// 종료 게이트 × 기록 fork 결정표(#4217) — 오프라인·fs-only(샌드박스 HOME/TMPDIR, 실제 ~/.lively·/tmp 무접촉).
//  실행: node kit/hooks/stop-writeback-record-fork.test.mjs  (npm test 체인에 포함)
//
//  왜 이 테스트가 있나: 기록을 부모 대화를 물려받은 fork 에 백그라운드로 맡기면, fork 가 아직 쓰는 중에 메인이 턴을
//   끝내고 게이트가 «기록 없음»으로 막아 메인이 같은 내용을 중복 기록했다(#4201 실측 07:02:06Z). fork 의 쓰기는 부모
//   세션 id 로 오므로 .writeback 은 결국 선다 — 문제는 **순서**다. 그래서 «기록 fork 가 떠 있다»를 게이트가 인정한다.
//  고정하는 불변식:
//   ① 기록 fork(이름 머리 `기록:`)가 도는 동안 게이트는 막지 않고 .blocked 도 안 쓴다(넛지 기회를 아껴 둔다).
//   ② fork 가 기록 없이 끝나면 다음 Stop 에서 평소처럼 **1회** 넛지한다.
//   ③ 코딩용 fork·끝난 fork·셸 작업은 인정하지 않는다(넛지 유지).
//   ④ 하네스가 Stop 에 background_tasks 를 주면 그게 정본이다 — 남은 표시 파일이 넛지를 삼키지 못한다.
//   ⑤ 인정 목록에 project_update_v6·task_update_v6·task_comment_v6 가 있다.
//  페이로드 형태는 claude 2.1.278 실측 그대로다(#4217 세션 — `claude -p` + 페이로드 기록 훅):
//   PostToolUse(Agent) tool_response = {isAsync:true, status:"async_launched", agentId, description, …}
//   Stop.background_tasks = [{id, type:"subagent", status:"running", description, agent_type}]
//   SubagentStop = {session_id(부모), agent_id, agent_type, agent_transcript_path, …}
//  codex 형태는 codex-rs @rust-v0.154.0 코드 근거다(C 행). 실측은 못 했다 — codex 는 config.toml 훅을 사용자가 신뢰해야
//   (hooks.state."<키>".trusted_hash) 돌리고, exec 에서 신뢰를 건너뛰는 플래그는 자동 모드 분류기가 막았다.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";   // HOME/TMPDIR 만으론 윈도우 격리가 안 된다(#1510)

const HERE = join(fileURLToPath(import.meta.url), "..");
const GATE = join(HERE, "stop-writeback-gate.mjs");
const WF = join(HERE, "work-flag.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "record-fork-test-"));
const HOME = join(SANDBOX, "home");
const TMP = join(SANDBOX, "tmp");
const FLAG_DIR = join(TMP, "lively-hooks");   // 훅이 플래그를 두는 곳(tmpdir()/lively-hooks — TMPDIR 로 리다이렉트)
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(FLAG_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why));

const env = (extra = {}) => ({ ...process.env, ...sandboxEnv({ home: HOME, tmp: TMP }), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_MODE: "", ...extra });
const flagPath = (sid, f) => join(FLAG_DIR, `${sid}.${f}`);
const has = (sid, f) => existsSync(flagPath(sid, f));

// 게이트를 실제 프로세스로 띄우고 막았는지(decision:block) 돌려준다.
function gate(sid, extra = {}) {
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify({ session_id: sid, hook_event_name: "Stop", stop_hook_active: false, cwd: TMP, ...extra }),
    env: env(), encoding: "utf8",
  });
  return out.includes('"decision"') && out.includes('"block"');
}
function workFlag(payload, harness = "claude") {
  execFileSync(process.execPath, [WF], { input: JSON.stringify(payload), env: env({ LIVELY_HARNESS: harness }) });
}
let n = 0;
// 넛지 조건을 갖춘 세션(.lively = 자가 게이팅 통과 · .worked = 작업함 · writeback·blocked 없음)
function session() {
  const sid = `rf${++n}`;
  writeFileSync(flagPath(sid, "lively"), "");
  writeFileSync(flagPath(sid, "worked"), "");
  return sid;
}
const bg = (description, extra = {}) => ({ id: `a${n}`, type: "subagent", status: "running", description, agent_type: "fork", ...extra });
// claude 가 백그라운드 fork 를 띄운 직후의 PostToolUse(실측 형태)
const launch = (sid, agentId, description = "기록: 결정 저장", response = {}) => workFlag({
  session_id: sid, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: `toolu_${agentId}`,
  tool_input: { description, prompt: "…", subagent_type: "fork", run_in_background: true },
  tool_response: { isAsync: true, status: "async_launched", agentId, description, ...response },
});
const subagentStop = (sid, agentId) => workFlag({ session_id: sid, hook_event_name: "SubagentStop", agent_id: agentId, agent_type: "fork", stop_hook_active: false });
// 기록 fork 표시 = 자식마다 파일 하나 `<sid>.writeback-pending.<자식 id>` — 그 세션의 자식 id 목록(정렬)을 돌려준다.
const pendingIds = (sid) => readdirSync(FLAG_DIR).filter((f) => f.startsWith(`${sid}.writeback-pending.`)).map((f) => f.slice(`${sid}.writeback-pending.`.length)).sort();
const hasPending = (sid) => pendingIds(sid).length > 0;
// 표시를 직접 세운다(몇 분 전에 세워진 것처럼) — 목록 필드를 안 주는 하네스의 게이트 판정 행에 쓴다.
const mark = (sid, id, minutesAgo = 0) => {
  const f = flagPath(sid, `writeback-pending.${id}`);
  writeFileSync(f, "");
  if (minutesAgo) { const t = (Date.now() - minutesAgo * 60_000) / 1000; utimesSync(f, t, t); }
};

try {
  // ── 게이트: 하네스 정본(background_tasks) ─────────────────────────────
  {
    const sid = session();
    check("G0 대조군 — 기록 fork 없음 → 막는다", gate(sid, { background_tasks: [] }), "넛지 조건인데 안 막음(관측 장치가 죽었다)");
  }
  {
    const sid = session();
    const blocked = gate(sid, { background_tasks: [bg("기록: 결정 저장")] });
    check("G1 기록 fork 진행 중(background_tasks) → 통과", !blocked, "막았다 — 메인이 중복 기록한다");
    check("G1b 진행 중엔 .blocked 를 남기지 않는다", !has(sid, "blocked"), ".blocked 가 섰다 — 넛지 기회를 써 버렸다");
    check("G2 fork 가 기록 없이 끝난 뒤 Stop → 1회 넛지", gate(sid, { background_tasks: [] }), "안 막음");
    check("G2b 그 다음 Stop → 통과(세션당 1회)", !gate(sid, { background_tasks: [] }), "두 번 막음");
  }
  {
    const sid = session();
    check("G3 코딩용 fork(이름 머리 없음) → 막는다", gate(sid, { background_tasks: [bg("Shell side of router split")] }), "코딩 fork 를 기록으로 인정");
  }
  {
    const sid = session();
    check("G4 이름 가운데의 `기록:` → 막는다", gate(sid, { background_tasks: [bg("결과 기록: 나중에")] }), "머리가 아닌데 인정");
  }
  {
    const sid = session();
    check("G5 `기록:` 이름의 셸 작업 → 막는다", gate(sid, { background_tasks: [{ id: "b1", type: "shell", status: "running", description: "기록: sleep", command: "sleep 9" }] }), "셸을 기록 fork 로 인정");
  }
  {
    const sid = session();
    check("G5b `기록:` 이름의 monitor 작업 → 막는다(허용목록은 subagent)", gate(sid, { background_tasks: [{ id: "m1", type: "monitor", status: "running", description: "기록: 감시", server: "x", tool: "y" }] }), "서브에이전트가 아닌 작업을 인정");
  }
  {
    const sid = session();
    check("G6 목록에 남은 끝난 기록 fork(status=completed) → 막는다", gate(sid, { background_tasks: [bg("기록: x", { status: "completed" })] }), "끝난 fork 를 진행 중으로 봄");
  }
  {
    const sid = session();
    check("G7 전각 콜론·앞 공백(«  기록： …») → 통과", !gate(sid, { background_tasks: [bg("  기록： 결정 저장")] }), "표기 변형을 못 알아봄");
  }
  {
    const sid = session();
    mark(sid, "a-stale");   // SubagentStop 을 놓쳐 남은 표시
    check("G8 background_tasks=[] 면 남은 표시 파일보다 정본 우선 → 막는다", gate(sid, { background_tasks: [] }), "남은 표시가 넛지를 삼켰다");
  }
  {
    const sid = session();
    check("G8b 목록 항목에 description 이 없음 → 막는다", gate(sid, { background_tasks: [{ id: "a", type: "subagent", status: "running" }] }), "이름 없는 작업을 기록 fork 로 봄");
  }

  // ── 게이트: 표시 파일(background_tasks 를 안 주는 하네스 — codex·구버전 claude) ──
  {
    const sid = session();
    mark(sid, "a1");
    check("G9 표시 파일 신선 → 통과", !gate(sid), "막았다");
    check("G9b .blocked 안 씀", !has(sid, "blocked"), ".blocked 섰다");
  }
  {
    const sid = session();
    mark(sid, "a1", 21);
    check("G10 표시가 21분 전(TTL 20분 초과) → 막는다", gate(sid), "죽은 표시가 넛지를 막았다");
  }
  {
    const sid = session();
    mark(sid, "a1", 19);
    check("G10b 표시가 19분 전(TTL 안) → 통과", !gate(sid), "살아 있는 표시를 무시");
  }
  {
    const sid = session();
    mark(`${sid}0`, "a1");   // 이 세션 id 로 시작하는 **다른** 세션(rf1 ↔ rf10)의 표시
    check("G11 이름이 이 세션 id 로 시작하는 다른 세션의 표시 → 막는다", gate(sid), "남의 세션 표시를 주웠다");
  }
  {
    const sid = session();
    mark(sid, "a1");
    writeFileSync(flagPath(sid, "writeback"), "");
    check("G12 표시 + 기록 완료 → 통과(종전 그대로)", !gate(sid), "막았다");
  }

  // ── work-flag: 표시 세우기·걷기 ───────────────────────────────────────
  {
    const sid = session();
    launch(sid, "a1");
    check("W1 기록 fork 백그라운드 띄움 → 표시에 자식 id", pendingIds(sid).join() === "a1", `ids=${pendingIds(sid)}`);
    check("W1b 띄움 직후 Stop(목록을 안 주는 하네스) → 통과", !gate(sid), "막았다");
    subagentStop(sid, "a1");
    check("W2 그 자식의 SubagentStop → 표시 제거", !hasPending(sid), `ids=${pendingIds(sid)}`);
    check("W2b 기록 없이 끝난 뒤 Stop → 1회 넛지", gate(sid), "안 막음");
  }
  {
    const sid = session();
    launch(sid, "a1");
    launch(sid, "a2");
    subagentStop(sid, "a1");
    check("W3 겹친 기록 fork 둘 중 하나만 끝남 → 남은 쪽 표시 유지", pendingIds(sid).join() === "a2", `ids=${pendingIds(sid)}`);
    check("W3b 그때 Stop → 통과", !gate(sid), "남은 fork 가 쓰는 중인데 막음");
  }
  // 한 메시지에서 기록 fork 둘을 병렬로 띄우면 두 PostToolUse 훅이 **동시에** 돈다 — 등록이 서로를 덮으면 안 된다.
  //  ⚠ 이 행은 빨간불을 본 적이 없다: 표시를 한 파일의 줄 목록으로 두던 첫 구현(리뷰가 읽고-고쳐-쓰기 경합을 지적)에서도
  //   3병렬 × 8라운드 재현 0건이었다(노드 기동 지연이 경합 창을 벌린다). 경합은 자식마다 파일 하나로 **설계에서** 없앴고,
  //   이 행은 그 설계(병렬 등록·제거가 서로를 안 덮는다)가 뒤집히지 않게 지키는 가드다.
  {
    const bgWorkFlag = (payload) => new Promise((res, rej) => {
      const c = execFile(process.execPath, [WF], { env: env({ LIVELY_HARNESS: "claude" }) }, (e) => (e ? rej(e) : res()));
      c.stdin.end(JSON.stringify(payload));
    });
    const launchPayload = (sid, agentId) => ({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: `toolu_${agentId}`,
      tool_input: { description: "기록: 병렬", prompt: "…", subagent_type: "fork" },
      tool_response: { isAsync: true, status: "async_launched", agentId } });
    let lost = 0;
    for (let round = 0; round < 8; round++) {
      const sid = session();
      await Promise.all(["p1", "p2", "p3"].map((id) => bgWorkFlag(launchPayload(sid, id))));
      if (pendingIds(sid).join() !== "p1,p2,p3") lost++;
      await Promise.all(["p1", "p3"].map((id) => bgWorkFlag({ session_id: sid, hook_event_name: "SubagentStop", agent_id: id })));
      if (pendingIds(sid).join() !== "p2") lost++;
    }
    check("W3c 병렬로 띄우고·병렬로 끝냄(8라운드) → 등록·제거가 서로를 덮지 않는다", lost === 0, `${lost}/16 단계에서 표시가 어긋남`);
  }
  {
    const sid = session();
    launch(sid, "a1");
    subagentStop(sid, "zz");
    check("W4 다른 자식의 SubagentStop → 표시 그대로", pendingIds(sid).join() === "a1", `ids=${pendingIds(sid)}`);
  }
  {
    const sid = session();
    launch(sid, "c1", "Implement task 3898 fix");
    check("W5 코딩용 fork → 표시 없음", !hasPending(sid), "코딩 fork 에 표시가 섰다");
  }
  {
    const sid = session();
    launch(sid, "s1", "기록: 동기 실행", { isAsync: false, status: "completed" });
    check("W6 동기로 끝난 기록 에이전트 → 표시 없음(이미 기록이 끝났다)", !hasPending(sid), "끝난 에이전트에 표시");
  }
  {
    const sid = session();
    workFlag({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_x",
      tool_input: { description: "기록: 결정 저장", prompt: "…", subagent_type: "fork" }, tool_response: "launched" });
    check("W7 응답 형태를 모름 + subagent_type=fork → 표시(fork 는 항상 백그라운드)", pendingIds(sid).join() === "toolu_x", `ids=${pendingIds(sid)}`);
  }
  {
    const sid = session();
    workFlag({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_y",
      tool_input: { description: "기록: 결정 저장", prompt: "…", subagent_type: "fork" }, tool_response: { isAsync: true, status: "async_launched" } });
    check("W7b 응답에 agentId 가 없음 → tool_use_id 로 표시", pendingIds(sid).join() === "toolu_y", `ids=${pendingIds(sid)}`);
  }
  {
    const sid = session();
    workFlag({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "task", tool_input: { description: "기록: x" }, tool_response: {} }, "opencode");
    check("W8 fork 축이 빈 하네스(opencode task) → 표시 없음", !hasPending(sid), "부모 대화 fork 가 없는 하네스에 표시");
  }
  // fork 의 쓰기가 부모 표시를 끝낸다 — 자식 툴콜은 부모 session_id + agent_id 로 온다(실측).
  {
    const sid = session();
    launch(sid, "a9");
    workFlag({ session_id: sid, agent_id: "a9", agent_type: "fork", hook_event_name: "PostToolUse", tool_name: "mcp__lively__knowledge_save", tool_input: { name: "x" } });
    check("W9 fork 안의 knowledge_save → 부모 .writeback", has(sid, "writeback"), "부모에 writeback 안 섬");
    subagentStop(sid, "a9");
    check("W9b 기록한 fork 가 끝난 뒤 Stop → 통과(넛지 없음)", !gate(sid), "기록했는데 막음");
  }

  // ── codex(#4217) — Stop 에 실행 중 작업 목록이 없어 표시 파일이 유일한 신호다 ──
  //  형태는 codex-rs @rust-v0.154.0 코드 근거(훅 신뢰 없이 exec 는 훅을 안 돌려 실측 못 함 — 테스트 머리 주석 참조):
  //  PostToolUse tool_name "spawn_agent"(v1) · tool_input.message 가 과제 평문 · tool_response 는 **JSON 문자열**
  //  `{"agent_id","nickname"}`(v2 는 `{"task_name",…}`) · SubagentStop.agent_id = 자식 스레드 id · session_id = 루트 스레드 id.
  const cdxLaunch = (sid, message, response, tool = "spawn_agent") => workFlag({
    session_id: sid, hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: "call_1",
    tool_input: { message, fork_context: true }, tool_response: response,
  }, "codex");
  {
    const sid = session();
    cdxLaunch(sid, "기록: 결정과 실측을 지식으로 저장", JSON.stringify({ agent_id: "019a-t1", nickname: "Kant" }));
    check("C1 codex spawn_agent(message 머리 `기록:`, 응답=JSON 문자열) → 표시에 agent_id", pendingIds(sid).join() === "019a-t1", `ids=${pendingIds(sid)}`);
    check("C1b 그때 Stop(목록 필드 없음) → 통과", !gate(sid), "막았다");
    workFlag({ session_id: sid, hook_event_name: "SubagentStop", agent_id: "019a-t1", agent_type: "default", stop_hook_active: false }, "codex");
    check("C2 그 자식의 SubagentStop → 표시 제거", !hasPending(sid), `ids=${pendingIds(sid)}`);
    check("C2b 기록 없이 끝난 뒤 Stop → 1회 넛지", gate(sid), "안 막음");
  }
  {
    const sid = session();
    cdxLaunch(sid, "Implement the router split", JSON.stringify({ agent_id: "019a-t2" }));
    check("C3 codex 코딩용 spawn_agent → 표시 없음", !hasPending(sid), "코딩 fork 에 표시");
  }
  {
    const sid = session();
    cdxLaunch(sid, "기록: 저장", JSON.stringify({ task_name: "/root/kirok_save", nickname: "x" }), "collaborationspawn_agent");
    // `/` 는 파일 이름에서 인코딩된다 — 표시가 플래그 디렉터리 밖으로 새지 않는다(경로 조작 차단).
    check("C4 codex v2(collaborationspawn_agent, agent_id 없음) → task_name 으로 표시(`/` 인코딩)", pendingIds(sid).join() === "%2froot%2fkirok_save", `ids=${pendingIds(sid)}`);
  }
  {
    const sid = session();
    cdxLaunch(sid, "기록: 저장", "not json");
    check("C5 codex 응답을 못 읽음 → tool_use_id 로 표시(표시는 선다)", pendingIds(sid).join() === "call_1", `ids=${pendingIds(sid)}`);
  }
  {
    const sid = session();
    workFlag({ session_id: sid, agent_id: "019a-t9", agent_type: "default", hook_event_name: "PostToolUse", tool_name: "mcp__lively__knowledge_save", tool_input: { name: "x" } }, "codex");
    check("C6 codex 자식의 knowledge_save(루트 session_id) → 부모 .writeback", has(sid, "writeback"), "부모에 writeback 안 섬");
  }

  // ── ⑤ 인정 목록 보강 ─────────────────────────────────────────────────
  for (const t of ["project_update_v6", "task_update_v6", "task_comment_v6"]) {
    const sid = session();
    workFlag({ session_id: sid, hook_event_name: "PostToolUse", tool_name: `mcp__lively__${t}`, tool_input: {} });
    check(`R ${t} → .writeback 인정`, has(sid, "writeback"), "인정 안 됨 — 이것만 부르고 끝낸 세션이 막힌다");
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}
console.log(`\nstop-writeback record-fork tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
