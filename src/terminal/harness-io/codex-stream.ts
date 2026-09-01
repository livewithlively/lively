// codex app-server → SessionEvent 번역기 (#2439). **순수** — 프로세스·IO 없음.
//
//  ── 근거 ────────────────────────────────────────────────────────────────────────
//  · `codex app-server generate-json-schema` 산출(codex-cli 0.151.0, 2026-08-31 실행)
//  · 우리가 이미 돌리고 있는 번역기 [[codex-app-server-events.ts]](#2055 실측)
//  둘 다 «지어낸 형식» 이 아니다 — 하나는 공급사가 뽑아 준 스키마이고, 하나는 프로덕션에서 도는 코드다.
//
//  ── claude 와 무엇이 다른가 ─────────────────────────────────────────────────────
//  claude 는 «작업(task)» 이라는 1급 개념이 있어 셸·서브에이전트가 같은 봉투로 온다. codex 에는 그게
//  없고 **`item/*` 스트림**이 있다 — 명령 실행도 파일 변경도 MCP 호출도 전부 «아이템» 이다.
//  그래서 여기서는 **명령 실행 아이템을 작업으로 옮긴다**(`commandExecution` → `kind:"shell"`).
//  이것이 어휘를 우리가 소유하는 이유다(session-event.ts ★1): 두 하네스의 모양이 달라도 화면은 하나다.
//
//  ── 아직 안 옮기는 것 ───────────────────────────────────────────────────────────
//  codex 의 서브에이전트(`codex agents`)는 우리 런타임이 아직 그 축을 안 쓴다 — 형식을 실측하기 전엔
//  `raw` 로 흘려 **관측만** 한다(session-event.ts ★2). 있는 척하지 않는다.
import type { SessionEvent, TaskInfo } from "./session-event.js";

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** codex 아이템 status → 우리 낱말. 모르는 값은 undefined(거짓 진행을 만들지 않는다). */
function statusOf(v: unknown, exitCode?: number): TaskInfo["status"] | undefined {
  const s = String(v || "").toLowerCase();
  if (s === "failed" || (typeof exitCode === "number" && exitCode !== 0)) return "failed";
  if (s === "completed" || s === "success") return "completed";
  if (s === "inprogress" || s === "in_progress" || s === "running") return "running";
  if (s === "aborted" || s === "canceled" || s === "cancelled") return "killed";
  return undefined;
}

/** 명령 한 줄을 사람이 읽을 제목으로 — 배열이면 합치고, 너무 길면 자른다(카드 한 줄이다). */
function titleOfCommand(v: unknown): string {
  const raw = Array.isArray(v) ? v.map((x) => String(x)).join(" ") : String(v ?? "");
  const one = raw.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 117) + "…" : one;
}

/**
 * app-server 알림/요청 한 줄 → 세션 이벤트.
 *  · 대화(에이전트 메시지·추론)는 **ChatLine 축**이라 여기서 null 이다 — 그건 기존 번역기가 그린다.
 *  · 상태 축인데 못 알아본 것은 **`raw`**(버리지 않는다).
 */
export function codexAppServerEvent(line: unknown): SessionEvent | null {
  const o = rec(line);
  if (!o) return null;
  const method = String(o.method ?? "");
  const p = rec(o.params) ?? {};

  //  ── 승인 — 답하지 않으면 그 턴이 선다(runtime-bus 가 그 불변식을 쥔다). ──
  //   스키마: CommandExecutionRequestApprovalParams {approvalId, command, cwd, itemId, kind, reason, startedAtMs}
  if (method.endsWith("requestApproval") || method === "execCommandApproval" || method === "applyPatchApproval") {
    const id = str(p.approvalId) ?? str(o.id) ?? "";
    if (!id) return { t: "raw", source: "codex", payload: o };
    return { t: "permission.asked", ask: {
      id,
      toolName: method.includes("Patch") || method.includes("fileChange") ? "ApplyPatch" : "Bash",
      title: titleOfCommand(p.command) || undefined,
      description: str(p.reason),
      input: { command: p.command, cwd: str(p.cwd) },
    } };
  }

  //  ── 선택지 — codex 도 **사람에게 묻는다**(`item/tool/requestUserInput`, 스키마 근거) ────────
  //   요청: {isBlocking, itemId, threadId, turnId, questions:[{id, header, question,
  //          options:[{label,description}]|null, isOther, isSecret}]}
  //   응답: {answers:{"<질문 id>":{answers:["<label>",…]}}}
  //   ★ codex 는 **질문 id 로** 키잡는다(claude·grok 은 질문 전문) — 어휘의 QuestionItem.id 가 그 자리다.
  //   ⚠ `isSecret` 질문은 **웹에서 안 받는다.** 그건 자격증명 입력이고, 우리 화면은 비밀을 받는
  //    자리가 아니다(터미널에서 직접 친다). 하나라도 섞이면 이 묶음 전체를 raw 로 흘린다 —
  //    반쪽만 답하면 그 턴이 더 이상하게 막힌다.
  if (method === "item/tool/requestUserInput") {
    const id = str(o.id !== undefined && o.id !== null ? String(o.id) : undefined) ?? str(p.itemId) ?? "";
    const raw = Array.isArray(p.questions) ? p.questions : [];
    if (!id || !raw.length) return { t: "raw", source: "codex", payload: o };
    if (raw.some((q) => rec(q)?.isSecret === true)) return { t: "raw", source: "codex", payload: o };
    const qs = raw.map((x) => rec(x)).filter((q): q is Record<string, unknown> => !!q && typeof q.question === "string")
      .map((q) => ({
        id: str(q.id),
        question: String(q.question),
        header: str(q.header),
        options: (Array.isArray(q.options) ? q.options : []).map((x) => rec(x))
          .filter((x): x is Record<string, unknown> => !!x && typeof x.label === "string")
          .map((x) => ({ label: String(x.label), description: str(x.description) })),
        //  ⚠ codex 스키마에 multiSelect 축이 없다 — 답이 **배열**이라 여러 개가 가능하지만
        //   «여러 개 고르라» 는 신호는 안 준다. 지어내지 않고 단일 선택으로 둔다.
        multiSelect: false,
      }))
      .filter((q) => q.options.length > 0);
    if (!qs.length) return { t: "raw", source: "codex", payload: o };
    return { t: "permission.asked", ask: { id, toolName: "requestUserInput", title: qs[0].question, questions: qs, input: p } };
  }

  //  ── 아이템 — codex 에는 «작업» 이 없고 아이템이 있다. 명령 실행만 작업으로 옮긴다. ──
  if (method === "item/started" || method === "item/completed" || method === "item/updated") {
    const item = rec(p.item) ?? {};
    const type = String(item.type ?? "");
    if (type !== "commandExecution") {
      //  파일 변경·MCP 호출·추론 등은 대화 축(ChatLine)이 이미 그린다 — 상태 축에선 조용히 흘린다.
      return null;
    }
    const id = str(item.id) ?? str(p.itemId) ?? "";
    if (!id) return { t: "raw", source: "codex", payload: o };
    const exit = num(item.exitCode);
    const status = statusOf(item.status, exit) ?? (method === "item/completed" ? "completed" : "running");
    const task: TaskInfo = {
      id,
      kind: "shell",                                   // ★3 — codex 낱말이 아니라 우리 낱말
      title: titleOfCommand(item.command),
      status,
      startedAt: num(item.startedAtMs),
      endedAt: method === "item/completed" ? (num(p.completedAtMs) ?? Date.now()) : undefined,
    };
    return method === "item/started"
      ? { t: "task.started", task }
      : { t: "task.updated", id, patch: { status: task.status, endedAt: task.endedAt, title: task.title } };
  }

  //  ── 사용량·한도 ──
  if (method === "thread/tokenUsage/updated") {
    const u = rec(p.usage) ?? p;
    return { t: "usage", usage: { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens) } };
  }
  if (method === "account/rateLimits/updated") {
    const util: Record<string, number> = {};
    for (const [k, v] of Object.entries(rec(p.rateLimits) ?? p)) {
      const n = num(rec(v)?.usedPercent ?? rec(v)?.utilization);
      if (n !== undefined) util[k] = n > 1 ? n / 100 : n;      // 퍼센트로 오면 0~1 로 맞춘다
    }
    return { t: "usage", usage: Object.keys(util).length ? { utilization: util } : {} };
  }

  //  ── 세션이 무엇을 할 수 있나 ──
  if (method === "thread/started" || method === "thread/resumed") {
    return { t: "facts", facts: { model: str(p.model), permissionMode: str(p.approvalPolicy) } };
  }

  //  대화 축은 여기서 다루지 않는다(기존 번역기 소관).
  if (method.startsWith("item/agentMessage/") || method.startsWith("item/reasoning/")) return null;
  if (method === "turn/started" || method === "turn/completed") return null;

  //  ★ 나머지는 버리지 않는다 — codex 가 새 이벤트를 내면 여기로 관측된다.
  return method ? { t: "raw", source: "codex", payload: o } : null;
}
