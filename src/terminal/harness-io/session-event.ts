// 세션 이벤트(SessionEvent) — 세션의 **살아있는 상태**를 화면에 나르는 한 가지 어휘 (#2439).
//
//  ── 왜 ChatLine 과 따로 두나 ─────────────────────────────────────────────────────
//  [[chat-line.ts]] 의 ChatLine 은 **대화 기록**이다 — 파일에 남고, 나중에 다시 읽고, 중앙 기록으로 흐른다.
//  그런데 사람이 화면에서 봐야 하는 것 중엔 «기록» 이 아닌 것이 있다:
//    · 지금 백그라운드에서 도는 셸이 무엇인가        · 서브에이전트가 몇 개 떠 있고 어디까지 갔나
//    · 승인 요청이 지금 떠 있나                      · 이 세션에서 쓸 수 있는 슬래시 명령이 뭔가
//    · 남은 한도·이번 턴 비용은 얼마인가
//  이것들을 ChatLine 에 욱여넣으면 «대화 한 줄» 이라는 어휘가 오염되고, 대화 기록 파일에 상태가 섞인다.
//  그래서 **기록(ChatLine)** 과 **상태(SessionEvent)** 를 가른다. AG-UI 도 messages 와 state 를 나눈다.
//
//  ── 변화에 유연해야 하는 두 축 (윤상민 2026-08-31) ────────────────────────────────
//  ① **외부**: 하네스 구현이 바뀐다 · 새 하네스가 온다 · 새 프로토콜(ACP·AG-UI)이 표준이 된다.
//  ② **내부**: 우리가 화면을 바꾼다.
//  이 파일이 그 둘 사이의 **완충층**이다. 규칙 셋으로 지킨다:
//
//   ★1 어휘는 **우리가 소유한다.** ACP·AG-UI 의 개념을 빌리되 그들의 타입을 그대로 쓰지 않는다.
//       그들 스펙이 바뀌면 어댑터가 흡수하고 화면은 안 흔들린다(그 반대로 하면 남의 릴리스가 우리 UI 를 흔든다).
//   ★2 **생산자는 열린 집합, 소비자는 닫힌 집합.** 모르는 이벤트가 와도 화면은 안 깨진다 —
//       어댑터는 못 알아본 것을 버리지 않고 `raw` 로 올리고, 화면은 모르는 `t` 를 조용히 건너뛴다.
//       버리면 «새 하네스가 뭘 주는지» 를 영영 모르고, 던지면 하네스 업데이트가 화면을 죽인다.
//   ★3 **하네스 낱말을 여기 들이지 않는다.** claude 는 `local_bash`/`local_agent` 라 부르고 codex 는 다르게
//       부른다 — 여기서는 `shell`/`agent` 다. 번역은 어댑터의 일이고, 그 경계가 무너지면 화면에
//       하네스 이름이 스며들어 새 하네스마다 화면을 고치게 된다(#1719 이 그렇게 났다).
//
//  ── 누가 만드나 ──────────────────────────────────────────────────────────────────
//  하네스 어댑터(harness-io/*)가 만든다. 지금은 claude stream-json(claude-stream.ts)이 첫 생산자이고,
//  codex app-server·grok ACP·opencode serve 가 같은 어휘로 올라온다. **전송이 달라도 어휘는 하나다** —
//  같은 하네스도 전송이 여럿이다(claude = tmux 전사 / stream-json, codex = tmux rollout / app-server).

/** 작업 한 건 — **백그라운드 셸과 서브에이전트가 같은 봉투다**(claude 실측: local_bash · local_agent). */
export interface TaskInfo {
  id: string;
  /** 무엇이 도는가. 하네스 낱말이 아니라 **우리 낱말**(★3). */
  kind: "shell" | "agent" | "other";
  /** 사람이 읽을 한 줄(하네스가 준 description). */
  title: string;
  status: "running" | "completed" | "failed" | "killed";
  /** 이 작업을 낳은 툴 호출 — 대화의 어느 카드 밑에 붙일지 화면이 이걸로 정한다. */
  toolUseId?: string;
  /** kind='agent' 일 때: 어떤 서브에이전트인가 · 몇 겹째인가. */
  agentType?: string;
  depth?: number;
  /** 출력을 어디서 읽나(하네스가 파일로 준다). 화면은 **경로를 그대로 믿지 않고** 서버 중계로 읽는다. */
  outputRef?: string;
  /** 끝났을 때 하네스가 준 요약. */
  summary?: string;
  startedAt?: number;
  endedAt?: number;
}

/** 승인 요청 — 답하지 않으면 턴이 **영구 정지**한다(claude SDK: "permission prompts have no park deadline"). */
export interface PermissionAsk {
  id: string;
  toolName: string;
  input?: unknown;
  /** 구조화된 표시(claude 는 title·display_name·description 을 준다) — `message` 를 파싱하지 않는다. */
  title?: string;
  displayName?: string;
  description?: string;
  /** «항상 허용» 을 그릴 재료. 화면이 그대로 되돌려준다(내용을 해석하지 않는다). */
  suggestions?: unknown[];
}

/** 슬래시 명령 한 개. */
export interface SlashCommandInfo { name: string; description?: string; argumentHint?: string }

/** 이 세션에서 지금 쓸 수 있는 것들 — 화면이 **없는 기능의 버튼을 그리지 않기 위한** 재료. */
export interface SessionFacts {
  model?: string;
  permissionMode?: string;
  commands?: SlashCommandInfo[];
  skills?: string[];
  agents?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
}

/** 사용량 — 한도(구독 창)와 이번 세션 비용은 다른 축이다. */
export interface UsageInfo {
  /** 0~1. 하네스가 창별로 준다(claude: five_hour · seven_day). */
  utilization?: Record<string, number>;
  resetsAt?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * 세션 상태 이벤트 — **화면이 아는 유일한 어휘**.
 *
 * ⚠ `t` 는 늘어난다(새 하네스·새 표면). 소비자는 `switch` 의 `default` 에서 **조용히 무시**하고,
 *  절대 던지지 않는다(★2). 새 표면을 화면이 지원하기 전까지는 «안 보이는» 것이 «깨지는» 것보다 낫다.
 */
export type SessionEvent =
  //  작업 — 스냅샷과 델타를 함께 쓴다(AG-UI 의 StateSnapshot/StateDelta 와 같은 이유: 재접속·새로고침이
  //  스냅샷 한 번으로 정합해지고, 평시엔 델타만 흘러 싸다).
  | { t: "tasks.snapshot"; tasks: TaskInfo[] }
  | { t: "task.started"; task: TaskInfo }
  | { t: "task.updated"; id: string; patch: Partial<TaskInfo> }
  //  승인·선택지 — 답을 반드시 보내야 하는 요청이다(호출부가 미응답 추적).
  | { t: "permission.asked"; ask: PermissionAsk }
  | { t: "permission.resolved"; id: string }
  //  이 세션이 무엇을 할 수 있나(슬래시·스킬·모델·MCP).
  | { t: "facts"; facts: SessionFacts }
  | { t: "usage"; usage: UsageInfo }
  //  ★2 — 못 알아본 것. 버리지 않는다: 새 하네스가 무엇을 주는지 여기로 관측한다.
  | { t: "raw"; source: string; payload: unknown };

/** (순수) 하네스 낱말 → 우리 낱말. 모르는 것은 `other` — 던지지 않는다(★2·★3). */
export function taskKindOf(harnessTaskType: string | undefined | null): TaskInfo["kind"] {
  const s = String(harnessTaskType || "").toLowerCase();
  if (s.includes("agent")) return "agent";     // claude: local_agent
  if (s.includes("bash") || s.includes("shell") || s.includes("terminal")) return "shell";  // claude: local_bash · ACP: terminal/*
  return "other";
}

/**
 * (순수) 스냅샷에 델타를 적용한다 — 화면·서버가 **같은 규칙**으로 접어야 둘이 안 갈린다.
 *  모르는 id 의 델타는 **버리지 않고 새 행으로 만든다**: 스냅샷보다 델타가 먼저 도착할 수 있고
 *  (재접속·경합), 그때 버리면 그 작업은 영영 화면에 안 뜬다.
 */
export function applyTaskEvent(tasks: readonly TaskInfo[], ev: SessionEvent): TaskInfo[] {
  if (ev.t === "tasks.snapshot") return [...ev.tasks];
  if (ev.t === "task.started") {
    const rest = tasks.filter((x) => x.id !== ev.task.id);
    return [...rest, ev.task];
  }
  if (ev.t === "task.updated") {
    const found = tasks.find((x) => x.id === ev.id);
    if (found) return tasks.map((x) => (x.id === ev.id ? { ...x, ...ev.patch } : x));
    //  스냅샷을 못 본 상태에서 온 델타 — 아는 만큼으로 세운다(잃지 않는다).
    return [...tasks, { id: ev.id, kind: "other", title: "", status: "running", ...ev.patch }];
  }
  return [...tasks];
}
