// claude stream-json → SessionEvent 번역기 (#2439). **순수** — 프로세스·IO·전역 상태 없음.
//
//  ── 이 파일의 자리 ───────────────────────────────────────────────────────────────
//  하네스가 내는 원문 한 줄을 우리 어휘([[session-event.ts]])로 옮긴다. 여기가 **외부 변화를 흡수하는 자리**다:
//  claude 가 필드 이름을 바꾸거나 이벤트를 추가하면 **이 파일만** 고친다(화면·서버 상위는 안 바뀐다).
//
//  ── 왜 순수 함수인가 ─────────────────────────────────────────────────────────────
//  이 번역이 런타임(프로세스 spawn·소켓)과 한 덩어리면 **실측 원문으로 테스트할 수가 없다**. 그러면 하네스가
//  형식을 바꿔도 아무도 모르고, 화면에서 «왜 안 보이지» 로 발견하게 된다(#1719 가 정확히 그 모양이었다).
//  순수로 두면 claude 를 실제로 한 번 돌려 받은 줄을 그대로 fixture 로 박을 수 있다.
//
//  ── 다루지 않는 것 ───────────────────────────────────────────────────────────────
//  대화(assistant·user 메시지)는 **ChatLine 축**이라 여기서 null 이다. 두 축을 한 함수가 겸하면
//  «기록» 과 «상태» 가 섞인다(session-event.ts 머리말).
import {
  taskKindOf,
  type SessionEvent, type SessionFacts, type SlashCommandInfo, type TaskInfo, type UsageInfo,
} from "./session-event.js";

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** claude 의 status 낱말 → 우리 낱말. 모르는 값은 running 으로 두지 않고 그대로 좁힌다(거짓 진행 금지). */
function statusOf(v: unknown): TaskInfo["status"] | undefined {
  const s = String(v || "").toLowerCase();
  if (s === "completed" || s === "done" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "killed" || s === "canceled" || s === "cancelled") return "killed";
  if (s === "running" || s === "in_progress" || s === "started") return "running";
  return undefined;
}

/** task_started 원문 → TaskInfo. 셸이든 서브에이전트든 **같은 봉투**다(claude 실측). */
function taskOf(o: Record<string, unknown>): TaskInfo {
  return {
    id: String(o.task_id ?? ""),
    kind: taskKindOf(str(o.task_type)),
    title: str(o.description) ?? "",
    status: statusOf(o.status) ?? "running",
    toolUseId: str(o.tool_use_id),
    agentType: str(o.subagent_type),
    depth: num(o.spawn_depth),
    startedAt: num(o.start_time),
  };
}

/** 슬래시 목록 — claude 는 문자열 배열(init)로도, 객체 배열(commands_changed)로도 준다. 둘 다 받는다. */
function commandsOf(v: unknown): SlashCommandInfo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((c) => (typeof c === "string"
    ? { name: c }
    : { name: String((rec(c)?.name) ?? ""), description: str(rec(c)?.description), argumentHint: str(rec(c)?.argumentHint) }))
    .filter((c) => !!c.name);
}

/**
 * 승인 카드의 한 줄 제목 — «무엇을 하려는가».
 *  ⚠ 도구 이름만 적으면 사람이 판단할 수 없다("Bash 를 허용할까요?" 는 아무 정보가 아니다).
 *   명령·경로처럼 **사람이 읽고 결정할 수 있는 것**을 앞세운다.
 */
function askTitle(tool: string | undefined, input: unknown): string | undefined {
  const i = rec(input);
  const one = (v: unknown): string | undefined => {
    const t = typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join(" ") : undefined;
    if (!t) return undefined;
    const flat = t.replace(/\s+/g, " ").trim();
    return flat.length > 160 ? flat.slice(0, 157) + "…" : flat;
  };
  return one(i?.command) ?? one(i?.file_path) ?? one(i?.path) ?? one(i?.url) ?? one(i?.pattern) ?? tool;
}

/**
 * 한 줄(파싱된 JSON) → 세션 이벤트.
 *  · 상태 축이 아닌 줄(대화·훅 소음)은 **null**.
 *  · 상태 축인데 못 알아본 것은 **`raw`** — 버리지 않는다(session-event.ts ★2).
 */
export function claudeStreamEvent(line: unknown): SessionEvent | null {
  const o = rec(line);
  if (!o) return null;
  const type = String(o.type ?? "");

  //  ── 승인 — claude 는 **제어 요청**으로 묻는다(실측 2.1.251). ────────────────────
  //   {"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool","tool_name":…,"input":…}}
  //   ⚠ 이 줄은 **답을 기다린다**. 답하지 않으면 그 턴이 선다 — 그래서 어휘의 `permission.asked` 로
  //    올리고, 런타임이 버스의 ask() 를 통해 «반드시 한 번» 답한다(runtime-bus 불변식).
  //   ⚠ `interrupt`·`set_permission_mode` 등 **우리가 보낸 요청의 응답**(control_response)은 여기로
  //    오지 않는다 — 그건 런타임이 id 로 짝짓는다.
  if (type === "control_request") {
    const r = rec(o.request) ?? {};
    const sub = String(r.subtype ?? "");
    const id = str(o.request_id);
    if (!id) return { t: "raw", source: "claude", payload: o };
    if (sub === "can_use_tool") {
      return { t: "permission.asked", ask: {
        id,
        toolName: str(r.tool_name) ?? "도구",
        input: r.input,
        //  제목은 «무엇을 하려는가» 다 — 명령이면 명령줄, 아니면 도구 이름이 곧 제목이다.
        title: askTitle(str(r.tool_name), r.input),
        description: str(r.reason) ?? str(rec(r.permission_suggestions)?.reason),
        //  «항상 허용» 감은 하네스가 준다(claude: permission_suggestions) — 우리가 지어내지 않는다.
        suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : undefined,
      } };
    }
    //  ★ 물어보는 다른 종류(elicitation 등)도 **답이 필요하다** — 모른다고 삼키면 그 턴이 영영 선다.
    //   낱말을 지어내지 않고 도구 이름 자리에 subtype 을 적어 카드가 뜨게 한다(사람이 판단한다).
    return { t: "permission.asked", ask: {
      id, toolName: sub || "확인", input: r, title: str(r.message) ?? str(r.question),
      description: sub === "elicitation" ? "하네스가 확인을 요청했습니다" : undefined,
    } };
  }

  //  사용량 — 한도(구독 창)와 이번 턴 비용은 다른 사건이라 둘 다 usage 로 올린다.
  if (type === "rate_limit_event") {
    const info = rec(o.rate_limit_info) ?? {};
    const windows = rec(info.unifiedWindows) ?? {};
    const utilization: Record<string, number> = {};
    for (const [k, v] of Object.entries(windows)) {
      const u = num(rec(v)?.utilization);
      if (u !== undefined) utilization[k] = u;
    }
    const usage: UsageInfo = { resetsAt: num(info.resetsAt) };
    if (Object.keys(utilization).length) usage.utilization = utilization;
    return { t: "usage", usage };
  }
  if (type === "result") {
    const u = rec(o.usage) ?? {};
    return { t: "usage", usage: {
      costUsd: num(o.total_cost_usd),
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
    } };
  }
  //  대화는 ChatLine 축이다(머리말).
  if (type === "assistant" || type === "user") return null;
  if (type !== "system") return { t: "raw", source: "claude", payload: o };

  switch (String(o.subtype ?? "")) {
    case "task_started":
      return { t: "task.started", task: taskOf(o) };

    case "task_updated": {
      const p = rec(o.patch) ?? {};
      const patch: Partial<TaskInfo> = {};
      const st = statusOf(p.status); if (st) patch.status = st;
      const end = num(p.end_time); if (end !== undefined) patch.endedAt = end;   // 하네스 낱말을 여기서 끊는다
      const title = str(p.description); if (title) patch.title = title;
      return { t: "task.updated", id: String(o.task_id ?? ""), patch };
    }

    case "task_notification": {
      const patch: Partial<TaskInfo> = {};
      const st = statusOf(o.status); if (st) patch.status = st;
      const ref = str(o.output_file); if (ref) patch.outputRef = ref;
      const sum = str(o.summary); if (sum) patch.summary = sum;
      return { t: "task.updated", id: String(o.task_id ?? ""), patch };
    }

    case "background_tasks_changed": {
      //  ⚠ 빈 배열은 «지금 도는 작업이 없다» 는 **사실**이다 — null 로 접으면 마지막 작업이 화면에 영영 남는다.
      const arr = Array.isArray(o.tasks) ? o.tasks : [];
      return { t: "tasks.snapshot", tasks: arr.map((x) => taskOf(rec(x) ?? {})) };
    }

    case "init": {
      const facts: SessionFacts = {
        model: str(o.model),
        permissionMode: str(o.permissionMode),
        commands: commandsOf(o.slash_commands),
        skills: Array.isArray(o.skills) ? o.skills.map(String) : undefined,
        agents: Array.isArray(o.agents) ? o.agents.map(String) : undefined,
        mcpServers: Array.isArray(o.mcp_servers)
          ? o.mcp_servers.map((m) => ({ name: String(rec(m)?.name ?? ""), status: String(rec(m)?.status ?? "") }))
          : undefined,
      };
      return { t: "facts", facts };
    }

    case "commands_changed":
      return { t: "facts", facts: { commands: commandsOf(o.commands) } };

    //  훅 소음·토큰 카운터는 상태 축이 아니다 — 화면이 그릴 것이 없다.
    case "hook_started": case "hook_response": case "hook_progress":
    case "thinking_tokens":
      return null;

    //  ★ 나머지 system 은 **버리지 않는다**: 새 하네스·새 버전이 무엇을 주는지 여기로 관측한다.
    default:
      return { t: "raw", source: "claude", payload: o };
  }
}
