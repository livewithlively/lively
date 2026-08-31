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
      "--verbose", "--replay-user-messages", "--forward-subagent-text"];
    if (o.model) a.push("--model", String(o.model));
    //  ⚠ 없는 대화 id 로 --resume 하면 프로세스가 즉시 죽는다 — 있을 때만.
    if (o.convId) a.push("--resume", String(o.convId));
    return a;
  },
  translate: claudeStreamEvent,
  encode: (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n",
  note: "실측 완료(2026-08-31, 2.1.251) — 작업(local_bash·local_agent)·승인·슬래시·사용량 전부 확인.",
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
  argv: () => ["grok", "agent", "stdio"],
  //  facts 축만 실측으로 옮겼다(핸드셰이크는 로그인 없이 왕복한다). 턴 이벤트·승인은 로그인이 있어야
  //  페이로드를 볼 수 있어 **아직 안 채운다** — 못 본 형식으로 번역기를 쓰면 그 세션은 빈 화면이 된다.
  translate: grokAcpEvent,
  //  ⚠ ACP 는 JSON-RPC 라 «사람 말 한 줄» 인코딩이 stdio-jsonl 과 다르다(session/prompt 요청을 만들어야 한다).
  //   그 왕복을 실측하기 전엔 null — 그래서 canOpenChatRuntime 이 아직 grok 을 안 연다.
  encode: null,
  note: "ACP 핸드셰이크 실측(1.0.13): initialize 로 모델·MCP·인증필요를 얻는다. session/prompt 왕복과 승인 페이로드는 로그인 뒤 실측이 남았다.",
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
  //  ⚠ 그러나 **한 번에 한 프롬프트**다(`--print=` 로 주고 끝난다) — claude 처럼 stdin 을 열어 두고
  //   여러 턴을 이어가는 형태가 아니다. 그 왕복을 실측하기 전엔 argv·encode 를 채우지 않는다.
  argv: null,
  translate: antigravityEvent,
  encode: null,
  note: "stream-json 실측(1.1.22): init{cwd,tools,permission_mode}·step_update{state,step_type,usage}·result. 다중 턴 왕복(대화 유지)과 승인 step 형식은 미실측 — 그전엔 열지 않는다.",
};

const opencodeChat: ChatAdapter = {
  key: "opencode", label: "OpenCode",
  //  `opencode serve` 가 HTTP+OpenAPI+SSE(/event)+permission 응답 API 를 준다 — 전송이 stdio 가 아니다.
  //  ⭐ 이 하네스만은 서버화가 **기능을 새로 연다**: 지금은 대화 읽기(parse)조차 구조적으로 없다
  //   (단일 대화 파일을 안 쓴다 — #1884 §2 #35). serve 로 가면 read 와 approve 가 동시에 열린다.
  transport: "http-sse",
  //  ⚠ argv 축이 다르다 — 서버를 띄우고 **포트를 잡아** 붙는 방식이다(`opencode serve --port N`).
  //   지금 런타임은 stdio 만 다루므로 여기 argv 를 넣으면 «띄우면 되는 줄» 알고 호출된다. 그래서 null.
  argv: null,
  //  OpenAPI 실측(1.18.25)으로 승인·명령 축을 옮겼다. 실제 SSE 프레임은 로그인 없이 못 받아
  //  필드값의 형태를 다 확정하진 못했다 — 모르는 것은 raw 로 관측한다.
  translate: opencodeEvent,
  encode: null,
  note: "serve 실측(1.18.25): /event SSE · /permission/{id}/reply · session/{id}/shell·children. 승인·명령 축 번역 완료. http-sse 전송을 런타임이 지원해야 열린다.",
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
  //  ① 이 표가 직접 띄우는 하네스(stdio-jsonl) — argv·encode 가 다 있어야 한다.
  if (a.transport === "stdio-jsonl") return !!(a.argv && a.encode);
  //  ② 전용 런타임이 쥔 하네스(codex) — 그쪽이 띄우고 버스로 흘린다. 번역만 있으면 열린다.
  return !!a.runsVia;
}
