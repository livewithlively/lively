// Codex App Server 이벤트 → 공통 ChatLine 번역기 (#2055) — **순수 함수**(프로세스·소켓 없음).
//
//  ── 왜 별도 파일인가 ──
//  codex.ts 는 **rollout 파일**(디스크에 append 되는 ndjson)을 읽는 파서다. 이 파일은 같은 대화를 **App Server 가
//  실시간으로 밀어 주는 JSON-RPC 알림**에서 만든다. 재료가 다르므로 파서도 다르고, 순수하게 떼어 놔야
//  하네스 바이너리 없이 테스트할 수 있다(계약 회귀는 여기서 잡는다).
//
//  ── 실측 근거(codex-cli 0.149.1, 2026-08-26 · 지식 codex-app-server-spike-2055) ──
//  · 알림은 JSONL JSON-RPC. 한 턴의 모양:
//      turn/started            {threadId, turn:{id,…}}
//      item/started|completed  {threadId, turnId, item:{type,…}, completedAtMs?}
//      item/agentMessage/delta {delta}                        ← 스트리밍(줄이 아니라 '타이핑')
//      turn/completed          {threadId, turn:{id, items:[…]}}
//  · item.type 18종. 화면에 뜻이 있는 것만 옮기고 나머지는 조용히 버린다(있는 척 금지).
//      userMessage      {content:[UserInput]}                → user
//      agentMessage     {text, phase}                        → assistant text
//      reasoning        {content:[string], summary:[string]} → assistant thinking (rollout 파서와 다르다 —
//                                                              여기선 **생각 원문이 실제로 온다**)
//      commandExecution {command, aggregatedOutput, exitCode, status} → tool_use(Bash) + tool_result
//      fileChange       {changes:[{path,kind,diff}], status}  → tool_use(Edit) + tool_result
//      mcpToolCall      {server, tool, arguments, result, status} → tool_use(mcp__…) + tool_result
//  · ⚠ **완료(item/completed)만 줄로 만든다.** started 는 같은 id 로 다시 오고, 델타는 타이핑이라 줄이 아니다.
//    안 그러면 한 말이 두 번 그려진다(rollout 파서가 event_msg/agent_message 를 버리는 것과 같은 이유).
import { isoOf, type ChatBlock, type ChatLine, type ParseState } from "./chat-line.js";

const asObj = (v: unknown): Record<string, any> | null =>
  (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, any> : null;

/** 도구 결과 본문은 화면이 접어서 보여준다 — 원문을 버리진 않되 한 줄이 창을 통째로 먹지 않게 자른다. */
const OUTPUT_MAX = 16_000;
const clip = (s: string): string => (s.length > OUTPUT_MAX ? s.slice(0, OUTPUT_MAX) + `\n… (+${s.length - OUTPUT_MAX}자)` : s);

/** UserInput[] → 사람이 친 말. text 항목만 쓴다(이미지·첨부는 화면이 따로 다룬다). */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => { const o = asObj(c); return o && o.type === "text" ? String(o.text ?? "") : ""; })
    .filter(Boolean)
    .join("\n");
}

/** 도구 한 쌍(tool_use + tool_result)을 만든다 — 화면은 이 쌍으로 '무엇을 시켰고 무엇이 나왔나'를 그린다. */
function toolPair(
  ts: string,
  id: string,
  name: string,
  input: unknown,
  output: string,
  isError: boolean,
): ChatLine[] {
  const use: ChatBlock = { type: "tool_use", id, name, input };
  const out: ChatLine[] = [{ type: "assistant", timestamp: ts, message: { role: "assistant", content: [use] } }];
  // 결과가 없으면(아직 안 끝났거나 출력이 없는 도구) 결과 줄을 만들지 않는다 — 빈 말풍선을 만들지 않기 위해서다.
  if (output || isError) {
    out.push({
      type: "user",
      timestamp: ts,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: clip(output), is_error: isError || undefined }] },
    });
  }
  return out;
}

/**
 * App Server 알림 하나 → ChatLine 0..n 개.
 *
 *  state 는 창 사이를 잇는 불투명 상태다(rollout 파서와 같은 규약):
 *   · turnStartMs — turn/started 시각. turn/completed 에서 turn_duration 을 만든다.
 *
 *  ⚠ 알 수 없는 method·item.type 은 **조용히 무시**한다(빈 배열). codex 가 항목을 늘려도 화면이 안 깨진다.
 */
export function appServerLines(msg: unknown, state: ParseState): { lines: ChatLine[]; state: ParseState } {
  const st: ParseState = { ...state };
  const m = asObj(msg);
  if (!m) return { lines: [], state: st };
  const method = String(m.method ?? "");
  const params = asObj(m.params) ?? {};

  if (method === "turn/started") {
    const ms = Number(params.startedAtMs);
    st.turnStartMs = Number.isFinite(ms) ? ms : Date.now();
    return { lines: [], state: st };
  }

  if (method === "turn/completed") {
    const endMs = Number.isFinite(Number(params.completedAtMs)) ? Number(params.completedAtMs) : Date.now();
    const startMs = typeof st.turnStartMs === "number" ? st.turnStartMs : 0;
    delete st.turnStartMs;
    if (!startMs) return { lines: [], state: st };
    return {
      lines: [{ type: "system", subtype: "turn_duration", timestamp: new Date(endMs).toISOString(), durationMs: Math.max(0, endMs - startMs) }],
      state: st,
    };
  }

  // ★ 서버가 올리는 **오류 알림** — 이걸 안 받으면 실패한 턴이 «침묵» 으로 끝난다. (실측 2026-08-27, 프로덕션)
  //  사용자 신고: 첫 프롬프트 뒤 «10초쯤 생각중» 하다 세션이 갑자기 종료되고, 새로고침하면 이어받기가 두 번
  //  다 실패했다. app-server 로그에는 이유가 또렷했다 —
  //    `failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses`
  //  그 홈에 `~/.codex/auth.json` 이 없었다(=그 멤버가 codex 로그인을 안 했다). codex 쪽은 정직하게 401 을
  //  말하고 백오프하다 포기했는데, **우리가 그 알림을 버려서** 화면에는 «작업 중» 만 남고 아무 설명이 없었다.
  //  즉 사람이 30초면 고칠 일(로그인)을 «제품이 고장났다» 로 보게 만든 것은 이 한 줄의 부재였다.
  //
  //  ⚠ 오류는 **반드시 보이는 줄**로 남긴다(조용히 삼키지 않는다). 턴이 끝났다는 사실도 함께 알려야
  //   화면이 «작업 중» 에서 풀린다 — 그래서 turn_duration 도 같이 낸다(turn/completed 가 안 올 수 있다).
  if (method === "error" || method === "thread/realtime/error") {
    const ts2 = isoOf(Number(params.emittedAtMs)) || new Date().toISOString();
    const lines: ChatLine[] = [{ type: "system", subtype: "error", timestamp: ts2, text: codexErrorText(params) }];
    const startMs = typeof st.turnStartMs === "number" ? st.turnStartMs : 0;
    if (startMs) {
      delete st.turnStartMs;
      lines.push({ type: "system", subtype: "turn_duration", timestamp: ts2, durationMs: Math.max(0, Date.now() - startMs) });
    }
    return { lines, state: st };
  }

  if (method !== "item/completed") return { lines: [], state: st };

  const item = asObj(params.item);
  if (!item) return { lines: [], state: st };
  const ts = isoOf(Number(params.completedAtMs)) || new Date().toISOString();
  const id = String(item.id ?? "");
  const type = String(item.type ?? "");

  switch (type) {
    case "userMessage": {
      const text = userText(item.content);
      if (!text.trim()) return { lines: [], state: st };
      return { lines: [{ type: "user", timestamp: ts, message: { role: "user", content: text } }], state: st };
    }
    case "agentMessage": {
      const text = String(item.text ?? "");
      if (!text.trim()) return { lines: [], state: st };
      return { lines: [{ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], id: id || undefined } }], state: st };
    }
    case "reasoning": {
      // content 가 생각 원문, summary 는 요약. 원문이 있으면 그걸 쓰고 없으면 요약으로 접는다.
      const body = [item.content, item.summary]
        .map((v) => (Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean).join("\n") : ""))
        .find((v) => v.trim()) ?? "";
      if (!body.trim()) return { lines: [], state: st };
      return { lines: [{ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "thinking", thinking: body }] } }], state: st };
    }
    case "commandExecution": {
      const command = String(item.command ?? "");
      if (!command.trim()) return { lines: [], state: st };
      const exit = item.exitCode;
      const failed = String(item.status ?? "") === "failed" || (typeof exit === "number" && exit !== 0);
      const out = String(item.aggregatedOutput ?? "");
      return { lines: toolPair(ts, id, "Bash", { command, cwd: item.cwd ?? undefined }, out, failed), state: st };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.map((c) => asObj(c)).filter(Boolean) as Record<string, any>[] : [];
      if (!changes.length) return { lines: [], state: st };
      const paths = changes.map((c) => String(c.path ?? "")).filter(Boolean);
      const diff = changes.map((c) => String(c.diff ?? "")).filter(Boolean).join("\n");
      const failed = String(item.status ?? "") === "failed";
      // 화면의 도구 분류기가 읽는 열쇠(file_path)를 채운다 — 이름은 하네스가 아니라 **행위**로 짓는다.
      return { lines: toolPair(ts, id, "Edit", { file_path: paths[0] ?? "", paths, kind: changes[0]?.kind }, diff, failed), state: st };
    }
    case "mcpToolCall": {
      const server = String(item.server ?? "");
      const tool = String(item.tool ?? "");
      if (!server && !tool) return { lines: [], state: st };
      const failed = String(item.status ?? "") === "failed" || Boolean(item.error);
      const res = item.error ? String(item.error) : JSON.stringify(item.result ?? "");
      return { lines: toolPair(ts, id, `mcp__${server}__${tool}`, item.arguments ?? {}, res === "null" ? "" : res, failed), state: st };
    }
    // ── 아래는 화면에 뜻이 있는 나머지 항목들(#2055 후속) ────────────────────────────────
    //  실측 스키마(0.149.1 `generate-json-schema`)의 ThreadItem 18종 중, **사람이 읽을 것이 있는** 것만 옮긴다.
    //  나머지(hookPrompt·subAgentActivity·enteredReviewMode…)는 화면 계약이 아직 없어 그대로 버린다.
    case "plan": {
      // 에이전트가 세운 계획(= 할 일 목록). 텍스트 한 덩이로 온다 — 뜻이 '한 말'이 아니라 '지금 무엇을 하려는가'라
      //  글로 흘리지 않고 **카드**로 세운다. 화면의 도구 분류기가 이미 아는 이름(TodoWrite)에 붙여
      //  claude 세션과 같은 자리·같은 모양으로 보이게 한다(하네스마다 다른 그림을 만들지 않는다).
      const text = String(item.text ?? "");
      if (!text.trim()) return { lines: [], state: st };
      return { lines: toolPair(ts, id, "TodoWrite", { plan: text }, text, false), state: st };
    }
    case "webSearch": {
      const query = String(item.query ?? "");
      const results = Array.isArray(item.results) ? item.results : [];
      if (!query.trim() && !results.length) return { lines: [], state: st };
      const body = results.map((r) => {
        const o = asObj(r);
        return o ? [o.title, o.url].filter(Boolean).map(String).join(" — ") : String(r ?? "");
      }).filter(Boolean).join("\n");
      return { lines: toolPair(ts, id, "WebSearch", { query }, body, false), state: st };
    }
    case "dynamicToolCall": {
      const tool = String(item.tool ?? "");
      if (!tool) return { lines: [], state: st };
      const failed = String(item.status ?? "") === "failed" || item.success === false;
      const contents = Array.isArray(item.contentItems) ? item.contentItems : [];
      const body = contents.map((c) => { const o = asObj(c); return o && typeof o.text === "string" ? o.text : ""; }).filter(Boolean).join("\n");
      const name = item.namespace ? `mcp__${String(item.namespace)}__${tool}` : tool;
      return { lines: toolPair(ts, id, name, item.arguments ?? {}, body, failed), state: st };
    }
    case "imageView": {
      const p = String(item.path ?? "");
      if (!p) return { lines: [], state: st };
      return { lines: toolPair(ts, id, "Read", { file_path: p }, "", false), state: st };
    }
    case "contextCompaction":
      // 맥락 압축 — 화면은 이미 이 사실을 **구분선**으로 그린다(대화가 왜 갑자기 짧아졌는지의 유일한 설명).
      //  claude 의 compact_boundary 와 같은 자리에 앉힌다.
      return { lines: [{ type: "system", subtype: "compact", timestamp: ts }], state: st };
    default:
      return { lines: [], state: st };   // hookPrompt·subAgentActivity·리뷰모드 등 — 화면 계약이 아직 없다
  }
}


/**
 * (순수) codex 오류 알림 → **사람이 다음에 할 일을 아는 한 문장**.
 *
 *  codex 는 `codexErrorInfo` 로 갈래를 준다(unauthorized · usageLimitExceeded · contextWindowExceeded …)
 *  그리고 상류 HTTP 상태가 있으면 `httpStatusCode` 로 함께 온다. 갈래를 아는데도 원문만 흘리면
 *  사용자는 «wss://api.openai.com … 401» 같은 문장을 보게 된다 — 그건 정보이지 안내가 아니다.
 *
 *  ⚠ 모르는 갈래는 **원문을 그대로 보여준다**(지어내지 않는다). codex 가 갈래를 늘려도 최소한 사실은 남는다.
 */
export function codexErrorText(params: Record<string, unknown>): string {
  const info = params.codexErrorInfo;
  const kind = typeof info === "string" ? info : String(asObj(info)?.type ?? asObj(info)?.code ?? "");
  const status = Number(asObj(info)?.httpStatusCode ?? params.httpStatusCode);
  const raw = String(params.message ?? params.error ?? "").trim();
  const detail = raw ? ` (${clip(raw)})` : "";
  switch (kind) {
    case "unauthorized":
      return `코덱스 로그인이 필요합니다 — 이 세션의 터미널 탭에서 \`codex login\` 을 마친 뒤 다시 보내세요.${detail}`;
    case "usageLimitExceeded":
      return `코덱스 사용량 한도에 걸렸습니다 — 한도가 풀린 뒤 다시 시도하세요.${detail}`;
    case "sessionBudgetExceeded":
      return `이 대화의 예산을 넘었습니다 — 새 대화를 여세요.${detail}`;
    case "contextWindowExceeded":
      return `맥락 창을 넘었습니다 — 대화를 줄이거나 새 대화를 여세요.${detail}`;
    case "serverOverloaded":
      return `OpenAI 서버가 혼잡합니다 — 잠시 뒤 다시 보내세요.${detail}`;
    case "sandboxError":
      return `코덱스 샌드박스를 만들지 못했습니다 — 이 세션에서는 도구 실행이 막힐 수 있습니다.${detail}`;
    default:
      break;
  }
  if (status === 401 || /\b401\b|unauthorized/i.test(raw)) {
    return `코덱스 로그인이 필요합니다 — 이 세션의 터미널 탭에서 \`codex login\` 을 마친 뒤 다시 보내세요.${detail}`;
  }
  return raw ? `코덱스 오류 — ${clip(raw)}` : "코덱스가 오류를 알렸습니다(내용 없음)";
}
