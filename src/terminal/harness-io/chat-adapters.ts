// 하네스별 **대화 런타임 어댑터 표** (#2439) — 5 하네스가 한 자리에 선다. **순수**(IO 없음).
//
//  ── 왜 표인가 ────────────────────────────────────────────────────────────────────
//  이 레포의 규율 그대로다(`catalog.ts HARNESSES` · `kit/hooks/harness-registry.mjs` · `harness-io/adapter.ts`):
//  **축을 하나 늘리면 모든 하네스가 그 축을 답해야 한다 — `null` 도 답이다.** 그래야 «빠진 자리» 가
//  조용히 생기지 않는다. 새 하네스는 여기 한 줄 + 번역기 한 파일이면 되고 **화면 코드는 안 바뀐다.**
//
//  ── 축 셋 ───────────────────────────────────────────────────────────────────────
//   transport   무엇으로 말을 섞나. `stdio-jsonl`(한 줄 = JSON 하나) · `jsonrpc-stdio`(ACP·app-server)
//               · `http-sse`(opencode serve). **null = 이 하네스는 대화 런타임을 못 연다.**
//   argv        그 전송으로 띄울 명령. transport 가 null 이면 null.
//   translate   하네스 한 줄 → 우리 어휘(SessionEvent). null 이면 **아직 못 읽는다**(있는 척 금지).
//
//  ── ★ 미실측을 «될 것 같다» 로 채우지 않는다 ────────────────────────────────────
//  translate 가 null 인 하네스를 chat 모드로 열면 pane 은 셸인데 대화창은 아무것도 못 받아
//  **말 걸 곳이 없는 빈 화면**이 된다 — 가장 나쁜 조합이다. 그래서 `session-runtime-mode.ts` 의
//  `harnessSupportsChat` 이 **이 표에서 파생**된다(두 곳에 손으로 적으면 반드시 갈린다).
import { claudeStreamEvent } from "./claude-stream.js";
import { codexAppServerEvent } from "./codex-stream.js";
import { grokAcpEvent } from "./grok-stream.js";
import { antigravityEvent } from "./antigravity-stream.js";
import { opencodeEvent } from "./opencode-stream.js";
import type { PermissionAnswer, PermissionAsk } from "./session-event.js";
import type { SessionEvent } from "./session-event.js";

export type ChatTransport = "stdio-jsonl" | "jsonrpc-stdio" | "http-sse";

export interface ChatAdapter {
  key: string;
  label: string;
  /** null = 이 하네스는 대화 런타임을 못 연다(그 이유를 `note` 에 적는다). */
  transport: ChatTransport | null;
  /** 대화 런타임으로 띄울 argv. transport 가 null 이면 null. */
  argv: ((o: { convId?: string | null; model?: string | null }) => string[]) | null;
  /** 한 줄 → 우리 어휘. **null = 아직 못 읽는다**(빈 화면을 만들지 않으려면 chat 모드도 막힌다). */
  translate: ((line: unknown) => SessionEvent | null) | null;
  /** 사람 말 → 그 하네스가 받는 한 줄. transport 가 stdio-jsonl 일 때만 쓴다. */
  encode: ((text: string) => string) | null;
  /**
   * 사람의 승인 답 → 그 하네스에 **돌려보낼 한 줄**. null = 파이프로 답하지 않는다.
   *
   *  ⚠ 이 축이 없으면 승인 카드는 **그릴 수는 있어도 답할 수가 없다** — 그러면 그 턴은 TTL 까지 서고
   *   사람은 «눌렀는데 아무 일도 안 난다» 를 본다. 카드를 그리는 하네스는 반드시 이 축을 채운다.
   *  ⚠ null 이라도 **답할 길이 없다는 뜻은 아니다**: opencode 는 REST(POST /permission/{id}/reply)라
   *   줄이 아니고, codex 는 자기 런타임이 쥔다. 그 경우 런타임이 Entry.respond 를 직접 세운다.
   */
  respond?: ((o: { ask: PermissionAsk; value: PermissionAnswer; convId: string }) => string | null) | null;
  /**
   * 도는 턴 **멈추기** → 하네스에 보낼 한 줄. null = 이 하네스는 파이프로 못 멈춘다.
   *  ⚠ 멈춤이 없으면 사람은 잘못 보낸 프롬프트를 **끝날 때까지 지켜봐야 한다**(터미널에선 Esc 한 번이다).
   */
  interrupt?: ((o: { convId: string }) => string | null) | null;
  /**
   * 이 하네스의 런타임을 **누가 쥐고 있나**. 값이 있으면 그 모듈이 프로세스를 띄우고 버스로 흘린다
   *  — 이 표는 번역만 제공한다(같은 프로세스를 두 자리가 띄우려 들면 대화가 둘로 갈린다).
   *  null = 아직 아무도 안 쥔다(또는 이 표의 argv 로 띄운다).
   */
  runsVia?: string | null;
  /** 왜 이 상태인가 — 다음 사람이 «안 했다» 와 «못 한다» 를 구분할 수 있게. */
  note: string;
}

const claudeChat: ChatAdapter = {
  key: "claude", label: "Claude Code",
  transport: "stdio-jsonl",
  argv: (o) => {
    const a = ["claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--replay-user-messages", "--forward-subagent-text",
      //  ★ 승인 물음이 **우리에게 오게 하는 스위치**(실측 2.1.251 — 바이너리 자신의 설명):
      //   "--permission-prompt-tool (permission prompts reach the host over stdio; an MCP tool cannot
      //    answer them here)" — 즉 `stdio` 가 «호스트가 stdio 로 받는다» 는 뜻이고, 이 값이 없으면
      //   control_request{can_use_tool} 이 **한 번도 안 온다**. 그러면 승인 카드는 영영 안 뜨고,
      //   사람은 웹에서 승인을 못 한다(그게 이 프로젝트가 고치려던 «반쪽 UX» 다).
      //  ⚠ 이 플래그를 모르는 옛 빌드에선 프로세스가 뜨자마자 죽는다 — 그 경우 deliverPrompt 가
      //   ClaudeChatUnavailable 을 잡아 종전 터미널 경로로 되돌린다(조용히 망가지지 않는다).
      "--permission-prompt-tool", "stdio"];
    if (o.model) a.push("--model", String(o.model));
    //  ⚠ 없는 대화 id 로 --resume 하면 프로세스가 즉시 죽는다 — 있을 때만.
    if (o.convId) a.push("--resume", String(o.convId));
    return a;
  },
  translate: claudeStreamEvent,
  encode: (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n",
  //  ★ 승인 응답 — claude 는 **제어 응답**으로 받는다(control_request 의 짝).
  //   ⚠ `request_id` 를 그대로 되돌려야 한다. 다른 값을 넣으면 claude 는 그 답을 자기 물음의 답으로
  //    보지 않고, 그 턴은 영영 선다(짝이 안 맞는 답은 «답이 없는 것» 과 같다).
  //   ⚠ 거부에 `message` 를 넣는다 — 그게 없으면 에이전트가 왜 막혔는지 모르고 같은 것을 다시 시도한다.
  respond: ({ ask, value }) => JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: ask.id,
      //  ★ **질문에는 «허용» 이 아니라 «고른 값» 으로 답한다**(공식 문서 규약):
      //   updatedInput = { questions: <원본 그대로>, answers: { "<질문 전문>": "<고른 label>" } }
      //   ⚠ questions 를 안 실으면 툴이 처리하지 못한다(문서: "required for tool processing").
      //   ⚠ 그냥 allow 만 하면 답이 빈 채로 실행돼 "The user did not answer the questions" 로 끝난다
      //    — 실측으로 확인했고, 화면은 영원히 도는 것처럼 보인다.
      response: ask.questions?.length
        ? (value.allow
          ? { behavior: "allow", updatedInput: {
              questions: ask.questions,
              answers: value.answers ?? {},
            } }
          //  질문을 닫는 것(«답 안 함»)은 거부로 보낸다 — 에이전트가 그 사실을 알고 다음 수를 정한다.
          : { behavior: "deny", message: "사용자가 답하지 않고 질문을 닫았습니다" })
        : value.allow
        ? { behavior: "allow", updatedInput: (ask.input ?? {}) as Record<string, unknown>,
            //  «앞으로도» 는 하네스가 준 제안을 **그대로** 돌려줄 때만 성립한다(우리가 규칙을 짓지 않는다).
            ...(value.scope === "always" && Array.isArray(ask.suggestions) && ask.suggestions.length
              ? { updatedPermissions: ask.suggestions } : {}) }
        : { behavior: "deny", message: "사용자가 거부했습니다" },
    },
  }) + "\n",
  //  ★ 멈춤 — 같은 제어 통로다. 터미널의 Esc 한 번에 해당한다.
  interrupt: () => JSON.stringify({
    type: "control_request",
    request_id: `int-${Date.now()}`,
    request: { subtype: "interrupt" },
  }) + "\n",
  note: "실측(2026-08-31~09-01, 2.1.251): 작업(local_bash·local_agent)·슬래시(init.slash_commands 77건)·사용량(rate_limit_event) 라이브 확인. 승인은 control_response 봉투가 CLI 에 받아들여지는 것까지 확인(initialize 왕복이 같은 봉투로 응답), 다만 이 맥에서는 환경이 도구를 자동 허용해 can_use_tool 자체를 재현하지 못했다 — 그래서 --permission-prompt-tool stdio 를 명시한다.",
};

const codexChat: ChatAdapter = {
  key: "codex", label: "Codex",
  //  app-server 는 JSON-RPC 다 — 줄 하나가 곧 이벤트인 stdio-jsonl 과 프레이밍이 다르다.
  //  ⚠ 기동·수명은 **기존 codex-chat-runtime 이 이미 쥐고 있다**(매니지드 프로덕션에서 돈다).
  //   여기서는 **번역만** 제공하고, 그 런타임이 이 함수를 불러 버스에도 흘리게 잇는다(#2439 후속).
  transport: "jsonrpc-stdio",
  //  기동·전송은 [[codex-chat-runtime.ts]] 가 쥔다(매니지드 프로덕션에서 돈다) — 여기서 argv 를 주면
  //  두 자리가 같은 프로세스를 띄우려 든다. 그래서 argv·encode 는 null 이고, `runsVia` 가 그 사실을 적는다.
  argv: null,
  translate: codexAppServerEvent,
  encode: null,
  runsVia: "codex-chat-runtime",
  note: "번역·기동 모두 준비됨. 기동은 기존 codex-chat-runtime 소유이고 그 런타임이 onNotify 에서 버스로도 흘린다(#2439).",
};

const grokChat: ChatAdapter = {
  key: "grok", label: "Grok Build",
  //  `grok agent stdio` 가 ACP(JSON-RPC over stdio)를 말한다 — 실측으로 서브커맨드 존재 확인(2026-08-31).
  //  ⚠ 그러나 **session/update 페이로드를 아직 못 쟀다**(로그인 필요). 형식을 모르는 채 번역기를 쓰면
  //   그 세션은 빈 화면이 된다 — 그래서 translate 는 null 이고, chat 모드도 막힌다.
  transport: "jsonrpc-stdio",
  //  ⚠ 기동은 `ensureGrokChat` 이 쥔다(ACP 는 핸드셰이크가 먼저다 — initialize→session/new).
  //   여기 argv 를 두면 두 자리가 같은 프로세스를 띄우려 들고, 그러면 대화가 둘로 갈린다.
  argv: null,
  //  facts 축만 실측으로 옮겼다(핸드셰이크는 로그인 없이 왕복한다). 턴 이벤트·승인은 로그인이 있어야
  //  페이로드를 볼 수 있어 **아직 안 채운다** — 못 본 형식으로 번역기를 쓰면 그 세션은 빈 화면이 된다.
  translate: grokAcpEvent,
  //  ⚠ ACP 는 JSON-RPC 라 «사람 말 한 줄» 인코딩이 stdio-jsonl 과 다르다 — `session/prompt` 요청을
  //   만들어야 하고, 그 요청은 **세션 id 를 요구한다**(실측: 없으면 -32602 "unknown session id").
  //   `encode(text)` 시그니처로는 그 id 를 받을 수 없으므로 여기서는 null 이고, 런타임이 ACP 세션을
  //   여는 단계(session/new — 인증 필요)를 갖추면 grokPromptLine(sessionId, text) 로 잇는다.
  //   ★ 봉투 자체는 실측으로 검증됐다(형식이 틀렸다면 다른 오류가 났다) — 남은 것은 id 한 개다.
  encode: null,
  //  ★ 승인 응답 — ACP 는 **요청의 id 에 result 로** 답한다(JSON-RPC 규약).
  //   ⚠ 선택지를 에이전트가 줬으면 **그중 하나의 optionId** 를 돌려줘야 한다 — 우리가 지어낸 값은
  //    `-32602 invalid params` 로 튕기고 그 턴이 선다. 그래서 고른 것이 없으면 kind 로 고른다.
  respond: ({ ask, value }) => {
    const opts = (Array.isArray(ask.suggestions) ? ask.suggestions : []) as Array<Record<string, unknown>>;
    const pick = (want: string[]): string | undefined => {
      for (const w of want) {
        const hit = opts.find((o) => String(o.kind ?? "") === w);
        if (hit) return String(hit.optionId);
      }
      return undefined;
    };
    const optionId = value.optionId
      ?? (value.allow
        ? pick(value.scope === "always" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"])
        : pick(["reject_once", "reject_always"]));
    //  고를 것이 없으면 **취소**로 답한다 — 답을 안 하는 것보다 낫다(턴이 서지 않는다).
    const outcome = optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
    return JSON.stringify({ jsonrpc: "2.0", id: Number(ask.id) || ask.id, result: { outcome } }) + "\n";
  },
  //  ★ 멈춤 — ACP `session/cancel` 은 **알림**이다(id 없음: 답을 안 준다).
  interrupt: ({ convId }) => convId
    ? JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: convId } }) + "\n"
    : null,
  runsVia: "grok-acp",
  note: "ACP 실측 완료(1.0.13·2026-09-01 로그인 후): initialize→session/new→session/prompt 왕복 성공(stopReason:end_turn). tool_call{_meta.kind:execute}·available_commands_update 수신. 승인은 always-approve 라 이번에 안 떠 미실측(raw 로 관측).",
};

const antigravityChat: ChatAdapter = {
  key: "antigravity", label: "Antigravity",
  //  `agy --print --output-format stream-json` 이 있으나 2026-08-31 실측에서 그 플래그가 먹지 않고
  //  프롬프트로 해석됐다(모델이 «어떤 도구의 옵션인가요» 라고 되물었다). 인자 형식을 다시 재야 한다.
  //  별도로 벤더가 headless `control_request` 를 지원하지 않아 **승인은 구조적으로 불가**하다.
  //  ⚠ 앞서 «전송 자체가 미확정» 이라고 적었던 것은 **내 호출 형식 실수**였다 — agy 는 Go 플래그라
  //   `--print=<프롬프트>` 인데 `--print "<프롬프트>"` 로 불러 플래그가 프롬프트로 해석됐다.
  //   1.1.22 로 다시 재니 stream-json 이 정상 동작한다(init·step_update·result).
  transport: "stdio-jsonl",
  //  ⚠ **턴마다 프로세스**다 — `--input-format stream-json` 은 광고돼 있으나 실제로는 아직 안 된다
  //   (바이너리 문자열 실측: `stream input message event %q is not supported yet`).
  //   대신 `--conversation=<id>` 로 잇는다(실측: 턴2 가 num_turns=2 이고 앞 질문을 기억한다).
  //   그 세 단계는 `ensureAntigravityChat` 이 쥔다 — argv 하나로 표현되지 않는다(대화 id 가 인자에 낀다).
  argv: null,
  runsVia: "antigravity-per-turn",
  translate: antigravityEvent,
  encode: null,
  note: "실측(1.1.22·2026-09-01): init·step_update·result 수신 / stdin 스트림은 벤더 미구현(\"not supported yet\") → --conversation=<id> 로 다중 턴 확인(num_turns=2, 앞 질문 기억).",
};

const opencodeChat: ChatAdapter = {
  key: "opencode", label: "OpenCode",
  //  `opencode serve` 가 HTTP+OpenAPI+SSE(/event)+permission 응답 API 를 준다 — 전송이 stdio 가 아니다.
  //  ⭐ 이 하네스만은 서버화가 **기능을 새로 연다**: 지금은 대화 읽기(parse)조차 구조적으로 없다
  //   (단일 대화 파일을 안 쓴다 — #1884 §2 #35). serve 로 가면 read 와 approve 가 동시에 열린다.
  transport: "http-sse",
  //  ⚠ argv 축이 다르다 — 서버를 띄우고 **포트를 잡아** 붙는 방식이라 argv 하나로 표현되지 않는다.
  //   그 세 단계(기동→세션 생성→SSE)는 `ensureOpencodeChat` 이 쥔다(runsVia).
  argv: null,
  runsVia: "opencode-serve",
  //  OpenAPI 실측(1.18.25)으로 승인·명령 축을 옮겼다. 실제 SSE 프레임은 로그인 없이 못 받아
  //  필드값의 형태를 다 확정하진 못했다 — 모르는 것은 raw 로 관측한다.
  translate: opencodeEvent,
  //  쓰기는 «줄» 이 아니라 REST 다(POST /session/{id}/prompt_async) — encode(text) 로 표현되지 않는다.
  //  그래서 null 이고, 전송(sseTransport.postLine)이 그 자리를 대신한다.
  encode: null,
  note: "serve 실측(1.18.25·2026-09-01 실기동): /event SSE 로 server.connected 수신 · POST /session 이 인증 없이 ses_ id 발급 · /permission/{id}/reply. 기동 3단계는 ensureOpencodeChat 이 쥔다.",
};

export const CHAT_ADAPTERS: readonly ChatAdapter[] = [claudeChat, codexChat, grokChat, antigravityChat, opencodeChat];

/** 하네스 key → 어댑터. 모르는 key 는 null — **claude 로 추측하지 않는다**(남의 하네스를 대신 띄우게 된다). */
export function chatAdapter(key: string | null | undefined): ChatAdapter | null {
  const k = String(key || "").toLowerCase();
  return CHAT_ADAPTERS.find((a) => a.key === k) ?? null;
}

/**
 * 이 하네스로 **대화 런타임을 실제로 열 수 있나** — 전송·argv·번역·인코딩이 다 있어야 참이다.
 *
 *  ★ `session-runtime-mode.harnessSupportsChat` 이 이 함수를 쓴다. 두 곳에 손으로 적으면
 *   «표엔 없는데 모드는 열리는» 상태가 생기고, 그 세션은 빈 화면이 된다.
 */
export function canOpenChatRuntime(key: string | null | undefined): boolean {
  const a = chatAdapter(key);
  if (!a || !a.translate) return false;                 // 번역기가 없으면 대화창이 빈 화면이 된다
  //  ① **전용 기동 문**이 먼저다(codex · opencode · antigravity). 그쪽이 띄우고 버스로 흘린다.
  //   ⚠ 순서가 중요하다: antigravity 는 transport 가 stdio-jsonl 인데 기동은 전용 문이 쥔다
  //    (턴마다 프로세스 + --conversation). transport 로 먼저 가르면 그 하네스가 영영 안 열린다.
  //   ⚠ encode 를 요구하지 않는 이유: 그 하네스들은 «줄을 쓰는» 모양이 아니다(codex 는 JSON-RPC
  //    요청, opencode 는 REST, antigravity 는 대화 id 가 인자에 낀다). 보내는 길은 전용 문이 안다.
  if (a.runsVia) return true;
  //  ② 이 표가 직접 띄우는 하네스(stdio-jsonl) — argv·encode 가 다 있어야 한다.
  return a.transport === "stdio-jsonl" && !!(a.argv && a.encode);
}
