// claude stream-json → SessionEvent 번역 계약 (#2439).
//
//  사양 표 — 「입력 한 줄 × 기대 이벤트」. 행마다 테스트 1개다. 입력은 전부 **실측 원문**이다
//  (claude 2.1.251, 2026-08-31): 백그라운드 셸 한 번·서브에이전트 한 번을 실제로 돌려 받은 줄.
//  ⚠ 지어낸 fixture 를 쓰지 않는다 — 그러면 하네스가 형식을 바꿔도 이 표가 초록으로 남는다.
import assert from "node:assert/strict";
import { claudeStreamEvent } from "./claude-stream.js";
import { applyTaskEvent, taskKindOf, type TaskInfo } from "./session-event.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("[1] 백그라운드 셸 시작 → task.started{kind:'shell'}", () => {
  const e = claudeStreamEvent({
    type: "system", subtype: "task_started", task_id: "b9zpkp97x",
    tool_use_id: "toolu_01VK", description: "Run sleep 3 and echo done in background",
    is_backgrounded: true, task_type: "local_bash",
  });
  assert.equal(e?.t, "task.started");
  const task = (e as { t: "task.started"; task: TaskInfo }).task;
  assert.equal(task.kind, "shell");
  assert.equal(task.id, "b9zpkp97x");
  assert.equal(task.toolUseId, "toolu_01VK");
  assert.equal(task.title, "Run sleep 3 and echo done in background");
  assert.equal(task.status, "running");
});

t("[2] 서브에이전트 시작 → 같은 봉투에 kind:'agent' + agentType·depth", () => {
  const e = claudeStreamEvent({
    type: "system", subtype: "task_started", task_id: "a51d2bcffc1a7da0a",
    tool_use_id: "toolu_01X8", description: "Reply with single word PONG",
    subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1,
    task_type: "local_agent", prompt: "Your entire job is to reply with the single word: PONG",
  });
  assert.equal(e?.t, "task.started");
  const task = (e as { t: "task.started"; task: TaskInfo }).task;
  assert.equal(task.kind, "agent");
  assert.equal(task.agentType, "general-purpose");
  assert.equal(task.depth, 1);
});

t("[3] task_updated → task.updated (end_time 은 우리 낱말 endedAt 으로)", () => {
  const e = claudeStreamEvent({
    type: "system", subtype: "task_updated", task_id: "b9zpkp97x",
    patch: { status: "completed", end_time: 1788161831390 },
  });
  assert.equal(e?.t, "task.updated");
  const u = e as { t: "task.updated"; id: string; patch: Partial<TaskInfo> };
  assert.equal(u.id, "b9zpkp97x");
  assert.equal(u.patch.status, "completed");
  assert.equal(u.patch.endedAt, 1788161831390);
  assert.ok(!("end_time" in (u.patch as Record<string, unknown>)), "하네스 낱말이 새어 나가지 않는다");
});

t("[4] task_notification → 출력 위치·요약이 델타로 (파일 경로는 outputRef 로)", () => {
  const e = claudeStreamEvent({
    type: "system", subtype: "task_notification", task_id: "b9zpkp97x",
    tool_use_id: "toolu_01VK", status: "completed",
    output_file: "/tmp/x/b9zpkp97x.output", summary: 'Background command "…" completed',
  });
  assert.equal(e?.t, "task.updated");
  const u = e as { t: "task.updated"; patch: Partial<TaskInfo> };
  assert.equal(u.patch.status, "completed");
  assert.equal(u.patch.outputRef, "/tmp/x/b9zpkp97x.output");
  assert.match(String(u.patch.summary), /completed/);
});

t("[5] background_tasks_changed → tasks.snapshot (빈 배열도 유효한 스냅샷이다)", () => {
  const some = claudeStreamEvent({
    type: "system", subtype: "background_tasks_changed",
    tasks: [{ task_id: "b9zpkp97x", task_type: "local_bash", description: "Run sleep 3" }],
  });
  assert.equal(some?.t, "tasks.snapshot");
  assert.equal((some as { tasks: TaskInfo[] }).tasks[0].kind, "shell");
  //  ⚠ 빈 배열은 «작업이 없다» 는 **사실**이다 — null 로 접으면 마지막 작업이 화면에 영영 남는다.
  const none = claudeStreamEvent({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  assert.equal(none?.t, "tasks.snapshot");
  assert.equal((none as { tasks: TaskInfo[] }).tasks.length, 0);
});

t("[6] init → facts (슬래시·모델·MCP 상태)", () => {
  const e = claudeStreamEvent({
    type: "system", subtype: "init", model: "claude-haiku-4-5", permissionMode: "default",
    slash_commands: ["effort", "model"], skills: ["liv"], agents: ["Explore"],
    mcp_servers: [{ name: "lively", status: "connected" }, { name: "figma", status: "needs-auth" }],
  });
  assert.equal(e?.t, "facts");
  const f = (e as any).facts;
  assert.equal(f.model, "claude-haiku-4-5");
  assert.deepEqual(f.commands.map((c: any) => c.name), ["effort", "model"]);
  assert.equal(f.mcpServers[1].status, "needs-auth");
});

t("[7] commands_changed → facts.commands (런타임 갱신)", () => {
  const e = claudeStreamEvent({
    type: "system", subtype: "commands_changed",
    commands: [{ name: "review", description: "코드 리뷰" }],
  });
  assert.equal(e?.t, "facts");
  assert.equal((e as any).facts.commands[0].description, "코드 리뷰");
});

t("[8] rate_limit_event → usage (창별 사용률·리셋)", () => {
  const e = claudeStreamEvent({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", resetsAt: 1788169800,
      unifiedWindows: { five_hour: { utilization: 0.22, resetsAt: 1788169800 }, seven_day: { utilization: 0.37 } } },
  });
  assert.equal(e?.t, "usage");
  assert.equal((e as any).usage.utilization.five_hour, 0.22);
  assert.equal((e as any).usage.utilization.seven_day, 0.37);
});

t("[9] result → usage (비용·토큰)", () => {
  const e = claudeStreamEvent({
    type: "result", subtype: "success", total_cost_usd: 0.0352,
    usage: { input_tokens: 18, output_tokens: 154 },
  });
  assert.equal(e?.t, "usage");
  assert.equal((e as any).usage.costUsd, 0.0352);
  assert.equal((e as any).usage.outputTokens, 154);
});

t("[10] ★ 모르는 system 이벤트는 버리지 않고 raw 로 올린다 (열린 집합)", () => {
  const e = claudeStreamEvent({ type: "system", subtype: "some_future_thing", whatever: 1 });
  assert.equal(e?.t, "raw");
  assert.equal((e as any).source, "claude");
  assert.equal((e as any).payload.subtype, "some_future_thing");
});

t("[11] 대화 줄(assistant·user)과 훅 소음은 null — 그건 ChatLine 축이다", () => {
  assert.equal(claudeStreamEvent({ type: "assistant", message: { role: "assistant", content: [] } }), null);
  assert.equal(claudeStreamEvent({ type: "user", message: { role: "user", content: [] } }), null);
  assert.equal(claudeStreamEvent({ type: "system", subtype: "hook_started", hook_name: "x" }), null);
  assert.equal(claudeStreamEvent({ type: "system", subtype: "thinking_tokens" }), null);
  assert.equal(claudeStreamEvent(null), null);
  assert.equal(claudeStreamEvent("not an object"), null);
});

t("[12] taskKindOf — 하네스 낱말을 우리 낱말로, 모르면 other(던지지 않는다)", () => {
  assert.equal(taskKindOf("local_bash"), "shell");
  assert.equal(taskKindOf("local_agent"), "agent");
  assert.equal(taskKindOf("terminal"), "shell");     // ACP terminal/*
  assert.equal(taskKindOf("subagent"), "agent");
  assert.equal(taskKindOf("wat"), "other");
  assert.equal(taskKindOf(undefined), "other");
});

t("[13] applyTaskEvent — 스냅샷·시작·델타를 같은 규칙으로 접는다", () => {
  let ts: TaskInfo[] = [];
  ts = applyTaskEvent(ts, { t: "task.started", task: { id: "a", kind: "shell", title: "A", status: "running" } });
  assert.equal(ts.length, 1);
  ts = applyTaskEvent(ts, { t: "task.updated", id: "a", patch: { status: "completed" } });
  assert.equal(ts[0].status, "completed");
  //  같은 id 의 started 가 또 와도 둘로 늘지 않는다(재접속·중복 배달).
  ts = applyTaskEvent(ts, { t: "task.started", task: { id: "a", kind: "shell", title: "A", status: "running" } });
  assert.equal(ts.length, 1);
  //  ★ 스냅샷을 못 본 채 온 델타를 버리지 않는다 — 버리면 그 작업은 영영 화면에 안 뜬다.
  ts = applyTaskEvent(ts, { t: "task.updated", id: "ghost", patch: { title: "늦게 온 것" } });
  assert.equal(ts.length, 2);
  assert.equal(ts[1].id, "ghost");
  //  스냅샷은 통째로 교체한다(서버가 정본).
  ts = applyTaskEvent(ts, { t: "tasks.snapshot", tasks: [] });
  assert.equal(ts.length, 0);
});

console.log(`\n${pass}건 통과`);
