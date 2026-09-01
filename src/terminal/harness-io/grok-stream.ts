// grok ACP → SessionEvent 번역기 (#2439). **순수** — 프로세스·IO 없음.
//
//  ── 근거 ────────────────────────────────────────────────────────────────────────
//  grok 1.0.13 의 `grok agent stdio` 와 **실제 핸드셰이크를 주고받아** 재봤다(2026-08-31, 로그인 없이).
//  ACP(Agent Client Protocol, JSON-RPC 2.0 over stdio)를 말한다:
//
//    → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,…}}
//    ← {"id":1,"result":{"protocolVersion":1,
//         "agentCapabilities":{"loadSession":true,"sessionCapabilities":{"list":{},"resume":{},"close":{}},…},
//         "authMethods":[{"id":"grok.com","name":"Grok"}],
//         "_meta":{"modelState":{"currentModelId":"grok-4.6","availableModels":[…]},"agentVersion":"1.0.13"}}}
//    ← {"method":"_x.ai/mcp/servers_updated","params":{"mcpServers":[]}}
//    → session/new … ← {"error":{"code":-32000,"message":"Authentication required"}}
//
//  ── ★ 무엇을 옮기고 무엇을 안 옮기나 ───────────────────────────────────────────
//  **옮긴다**: `initialize` 응답의 모델·MCP 목록 → `facts`. 이건 실측했다.
//  **옮긴다(2026-09-01 로그인 후 실측 완료)**: 슬래시 목록·작업(툴 호출).
//   턴을 실제로 돌려 받은 이벤트: available_commands_update · tool_call · tool_call_update ·
//   agent_message_chunk · agent_thought_chunk · user_message_chunk · session_info_update.
//
//    tool_call        {toolCallId, title:"run_terminal_command", rawInput:{command,description},
//                      _meta["x.ai/tool"]:{kind:"execute", label:"Run Command", read_only:false}}
//    tool_call_update {toolCallId, kind:"execute", title:"Execute `echo hi`", content[],
//                      rawInput:{variant:"Bash", command, is_background}}
//
//  **아직 안 옮긴다**: 승인(`session/request_permission`). 이번 턴은 `always-approve` 상태라
//   승인 프롬프트가 안 떴다 — **안 본 것을 짐작해 채우지 않는다**(raw 로 관측).
import type { QuestionItem, QuestionOption, SessionEvent, SessionFacts, TaskInfo } from "./session-event.js";

/**
 * 사람 말 → ACP `session/prompt` 요청 한 줄 (#2439).
 *
 *  ── 근거 (실측, grok 1.0.13 · 2026-09-01) ────────────────────────────────────
 *  이 모양으로 보냈더니 서버가 **`-32602 "unknown session id"`** 를 냈다. 그건 «요청 형식은 맞고
 *  세션 id 만 없다» 는 뜻이다 — 형식이 틀렸다면 파라미터 자체를 다르게 나무랐을 것이다.
 *  즉 **봉투는 검증됐고 남은 것은 실 세션 id 하나**다.
 *
 *  ⚠ 그래서 `sessionId` 를 **인자로 받는다.** ACP 는 `session/new` 로 id 를 먼저 받아야 하는데
 *   그건 인증이 필요하다(실측: `-32000 Authentication required`). 런타임이 그 id 를 쥐고 넘긴다.
 *   여기서 «없으면 빈 문자열» 같은 기본값을 두지 않는다 — 그러면 이 오류가 조용히 반복된다.
 */
export function grokPromptLine(sessionId: string, text: string, id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0", id,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text }] },
  }) + "\n";
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** ACP 한 줄(JSON-RPC) → 세션 이벤트. 모르는 것은 `raw`(버리지 않는다). */
/**
 * grok 의 questions 를 우리 낱말로 (#2439). claude 와 **같은 모양**이라 규칙도 같다.
 *  ⚠ 옵션이 없는 질문은 버린다 — 고를 것이 없는 «선택지» 는 막다른 카드다.
 */
function questionsOf(v: unknown): QuestionItem[] {
  if (!Array.isArray(v)) return [];
  const out: QuestionItem[] = [];
  for (const raw of v) {
    const q = rec(raw);
    const text = str(q?.question);
    if (!q || !text) continue;
    const opts: QuestionOption[] = (Array.isArray(q.options) ? q.options : [])
      .map((x) => rec(x))
      .filter((x): x is Record<string, unknown> => !!x && typeof x.label === "string")
      .map((x) => ({ label: String(x.label), description: str(x.description) }));
    if (!opts.length) continue;
    //  ⚠ grok 은 multiSelect 를 **null** 로도 보낸다 — true 일 때만 참으로 본다.
    out.push({ question: text, header: str(q.header), options: opts, multiSelect: q.multiSelect === true });
  }
  return out;
}

export function grokAcpEvent(line: unknown): SessionEvent | null {
  const o = rec(line);
  if (!o) return null;

  //  ── initialize 응답 — 이 세션이 무엇을 할 수 있나 ──
  const result = rec(o.result);
  if (result && rec(result.agentCapabilities)) {
    const meta = rec(result._meta) ?? {};
    const modelState = rec(meta.modelState) ?? {};
    const facts: SessionFacts = { model: str(modelState.currentModelId) };
    //  ⚠ authMethods 가 남아 있다 = **아직 로그인 안 됐다**. 화면이 «로그인하세요» 를 말할 근거다 —
    //   그걸 모르면 사람은 답이 안 오는 이유를 알 수 없다(빈 화면이 가장 나쁜 결말이다).
    const auth = Array.isArray(result.authMethods) ? result.authMethods : [];
    if (auth.length) facts.permissionMode = "needs-auth";
    return { t: "facts", facts };
  }

  //  ── 승인 — ACP 는 **서버→클라이언트 요청**으로 묻는다(`session/request_permission`). ──
  //   params: { sessionId, toolCall:{title,kind,rawInput,…}, options:[{optionId,name,kind}] }
  //   ⚠ 이 줄에는 **`id` 가 있다**(알림이 아니라 요청이다). 답하지 않으면 그 턴이 선다 —
  //    그래서 우리 어휘의 승인으로 올리고 런타임이 반드시 한 번 응답한다(runtime-bus 불변식).
  //   ⚠ 선택지를 **우리가 지어내지 않는다**: 무엇을 고를 수 있는지는 에이전트가 `options` 로 준다.
  //    (실측 노트: 이번 로그인 계정은 always-approve 라 이 줄이 안 떴다. 형식은 ACP 규약을 따른다.)
  if (String(o.method ?? "") === "session/request_permission") {
    const p = rec(o.params) ?? {};
    const call = rec(p.toolCall) ?? {};
    const id = o.id !== undefined && o.id !== null ? String(o.id) : "";
    if (!id) return { t: "raw", source: "grok", payload: o };
    const options = (Array.isArray(p.options) ? p.options : [])
      .map((x) => rec(x))
      .filter((x): x is Record<string, unknown> => !!x && typeof x.optionId === "string");
    return { t: "permission.asked", ask: {
      id,
      toolName: str(call.kind) ?? str(call.title) ?? "도구",
      title: str(call.title),
      input: call.rawInput ?? call,
      //  ACP 의 선택지를 **그대로** 나른다 — 화면이 이름을 그리고, 고른 optionId 를 되돌려준다.
      suggestions: options.length ? options : undefined,
    } };
  }

  //  ── 사용량 — grok 은 **턴 응답의 `_meta`** 에 토큰을 싣는다(실측 2026-09-01) ─────────────
  //   {"id":3,"result":{"stopReason":"end_turn","_meta":{totalTokens,inputTokens,outputTokens,
  //     cachedReadTokens,modelId,sessionId}}}
  //   ⚠ 초기화 응답(agentCapabilities)과 **같은 `result` 자리**라 위 분기보다 뒤에 둔다 — 순서가
  //    바뀌면 초기화가 사용량으로 잘못 읽힌다.
  if (result && rec(result._meta) && num(rec(result._meta)?.totalTokens) !== undefined) {
    const m = rec(result._meta) ?? {};
    return { t: "usage", usage: { inputTokens: num(m.inputTokens), outputTokens: num(m.outputTokens) } };
  }
  //  ── 한도 — 다 쓰면 **오류로** 온다(실측: -32003 Rate limited, "tokens (actual/limit): 502001/500000") ──
  //   ⚠ 사람에게 «왜 답이 안 오나» 를 말해 줄 유일한 신호다. 오류라고 버리면 화면이 조용히 멈춘다.
  const rateErr = rec(o.error);
  if (rateErr && num(rateErr.code) === -32003) {
    const msg = str(rec(rateErr.data)?.message) ?? str(rateErr.message) ?? "";
    const m = /tokens \(actual\/limit\): (\d+)\/(\d+)/.exec(msg);
    const used = m ? Number(m[1]) : undefined;
    const cap = m ? Number(m[2]) : undefined;
    return { t: "usage", usage: (used !== undefined && cap) ? { utilization: { limit: used / cap } } : {} };
  }

  //  ── 선택지 — grok 도 **사람에게 묻는다**(x.ai 확장, 실측 2026-09-01) ──────────────
  //   요청: {"jsonrpc":"2.0","id":N,"method":"_x.ai/ask_user_question","params":{
  //           sessionId, toolCallId, questions:[{question, options:[{label,description}], multiSelect}], mode}}
  //   응답: {"outcome":"accepted","answers":{"<질문 전문>":"<고른 label>"}}
  //   ★ questions·options 필드 이름이 **claude 와 같다** — 우리 어휘로 그대로 옮겨진다.
  //   ⚠ outcome 은 **문자열 variant** 다(map 을 주면 "expected variant identifier" 로 튕긴다).
  //    유효값은 오류가 열거해 줬다: accepted · chat_about_this · skip_interview · cancelled.
  if (String(o.method ?? "") === "_x.ai/ask_user_question") {
    const p = rec(o.params) ?? {};
    const id = o.id !== undefined && o.id !== null ? String(o.id) : "";
    const qs = questionsOf(p.questions);
    if (!id || !qs.length) return { t: "raw", source: "grok", payload: o };
    return { t: "permission.asked", ask: {
      id, toolName: "AskUserQuestion", title: qs[0].question, questions: qs, input: p,
    } };
  }

  //  ── MCP 서버 목록(x.ai 확장) ──
  if (String(o.method ?? "") === "_x.ai/mcp/servers_updated") {
    const p = rec(o.params) ?? {};
    const servers = Array.isArray(p.mcpServers) ? p.mcpServers : [];
    return { t: "facts", facts: {
      mcpServers: servers.map((m) => ({ name: String(rec(m)?.name ?? ""), status: String(rec(m)?.status ?? "connected") })),
    } };
  }

  //  ── 인증 오류 — 조용히 삼키지 않는다. 사람이 왜 답이 없는지 알아야 한다. ──
  const err = rec(o.error);
  if (err && /auth/i.test(String(err.message ?? ""))) {
    return { t: "facts", facts: { permissionMode: "needs-auth" } };
  }

  //  ── session/update — 턴 이벤트. **실측(2026-09-01, 로그인 후)으로 형식을 확정했다.** ──
  if (String(o.method ?? "") === "session/update") {
    const p = rec(o.params) ?? {};
    const u = rec(p.update) ?? {};
    const kind = String(u.sessionUpdate ?? "");

    //  슬래시 목록 — ACP 표준 이름 그대로다(AvailableCommandsUpdate).
    if (kind === "available_commands_update") {
      const cmds = Array.isArray(u.availableCommands) ? u.availableCommands : [];
      return { t: "facts", facts: {
        commands: cmds.map((c) => {
          const r = rec(c) ?? {};
          return { name: String(r.name ?? ""), description: str(r.description), argumentHint: str(rec(r.input)?.hint) };
        }).filter((c) => c.name),
      } };
    }

    //  ── 작업 — grok 은 «툴 호출» 로 표현한다(claude 의 task, codex 의 item 에 해당). ──
    //   실측: tool_call{toolCallId,title,rawInput,_meta["x.ai/tool"]{kind,label,read_only}}
    //        tool_call_update{toolCallId,kind,title,content[],rawInput{is_background,…}}
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = str(u.toolCallId);
      if (!id) return { t: "raw", source: "grok", payload: o };
      const meta = rec(rec(u._meta)?.["x.ai/tool"]) ?? {};
      const raw = rec(u.rawInput) ?? {};
      //  ⚠ **명령 실행만** 작업으로 옮긴다 — 파일 읽기·검색까지 도크에 세우면 사람이 못 읽는다.
      //   판정은 `_meta` 의 kind(execute)로 한다(툴 이름 문자열 매칭보다 안정적이다).
      const toolKind = String(meta.kind ?? u.kind ?? "");
      if (toolKind !== "execute") return null;
      const title = str(raw.command) ?? str(u.title) ?? str(meta.label) ?? "명령";
      const task: TaskInfo = {
        id, kind: "shell",
        title: title.length > 120 ? title.slice(0, 117) + "…" : title,
        //  ⚠ 완료 신호가 따로 없다 — tool_call_update 는 진행 중에도 온다. 턴 마감이 접는다.
        status: "running",
        toolUseId: id,
      };
      return kind === "tool_call"
        ? { t: "task.started", task }
        : { t: "task.updated", id, patch: { title: task.title } };
    }

    //  대화 본문·추론은 ChatLine 축이다(agent_message_chunk · agent_thought_chunk · user_message_chunk).
    if (kind.endsWith("_chunk")) return null;
    return { t: "raw", source: "grok", payload: o };
  }

  //  ★ 그 밖은 버리지 않는다 — grok 이 새 이벤트를 내면 여기로 관측된다.
  return o.method || o.result || o.error ? { t: "raw", source: "grok", payload: o } : null;
}
