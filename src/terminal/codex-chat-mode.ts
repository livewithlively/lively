// codex 세션의 대화 런타임 선택 (#2055 P2-B · 기본 뒤집기 #4135) — **순수**(env + 세션 표식만 읽는다).
//
//  ── 두 갈래 ──
//   tmux(기본)        pane 에서 codex TUI 가 돌고, 화면의 글자는 아웃박스 → send-keys 로 들어간다.
//   app-server        pane 은 **셸**이고, 대화는 app-server(JSON-RPC)가 돈다. 글자 유실이 없고 승인을 우리가 받는다.
//
//  ── ★ 기본을 다시 tmux 로 (2026-09-25, 원준님 지시) ──
//  2026-08-27 에 app-server 를 기본으로 삼았다(상민님 지시 — 글자 유실이 없고 승인을 화면이 받는다는 이점).
//  그 결정을 되돌린다. 이유는 이점이 사라져서가 아니라 **사람이 만나는 화면이 갈렸기** 때문이다:
//   · app-server 세션의 pane 은 셸이라, 터미널로 보면 codex 가 없다. 거기 친 말은 zsh 가 받는다
//     (실측 2026-09-25 원준님: «터미널 뷰로 보고 명령을 쳐도 코덱스로 안 간다»).
//   · 클로드 세션은 터미널에 TUI 가 있어 정반대로 움직인다 — 같은 제품 안에서 두 AI 가 서로 다른 물건이 됐다.
//  그래서 codex 도 클로드와 **같은 상태**로 둔다: pane 에 TUI 가 뜨고, 터미널이 본자리다.
//  켜는 길은 남긴다: `LIVELY_CODEX_CHAT=app-server`.
//
//  ── ★★ 왜 «세션마다 기록» 인가 (이 파일의 가장 중요한 불변식) ──
//  이 값은 **그 세션의 pane 에 무엇이 떠 있나**를 말한다. 그런데 종전 판정은 배포 기본값만 봤다 — 즉 배포가
//  바뀌는 순간 **이미 떠 있는 세션들의 판정까지 같이 뒤집혔다.** 그 상태에서 사람이 말을 걸면:
//   app-server 로 뜬 세션(pane=셸)을 tmux 로 읽고 → send-keys → **사람의 프롬프트가 셸 명령으로 실행된다**(#3982).
//  그래서 세션이 태어날 때 모드를 tmux 옵션 `@box_runtime` 에 박고(sessionMetaCmds), 읽는 자리는 전부 그 표식을
//  본다. 표식이 없는 세션 = **이 변경 전에 태어난 세션** 이므로 그때의 기본(app-server)으로 읽는다.
//  ⚠ 표식은 tmux 에만 있고 DB 에는 없다(#2439 와 같은 자리). 표식 되채우기(metaHealCmds)는 DB 로 하므로 이 값을
//   되살리지 못한다 — 그 경우 legacy 로 읽혀 app-server 로 판정된다. 그때는 «대화창이 스레드를 잡으려다 부딪힌다»
//   (보이는 실패)이지 «셸에 프롬프트가 실행된다»(조용한 사고)가 아니다 — 안전한 쪽으로 틀리게 두었다.

export type CodexChatMode = "tmux" | "app-server";

/** 세션 표식(`@box_runtime`)의 원시값 — 모르면 undefined(«이 변경 전에 태어난 세션»). */
export type CodexModeStamp = string | null | undefined;

/** 표식에 적는 값 — codex 세션만 쓴다(그 밖의 하네스는 "chat"|없음, #2439). */
export const CODEX_STAMP_APP_SERVER = "app-server";
export const CODEX_STAMP_TMUX = "terminal";

const envMode = (env: NodeJS.ProcessEnv): string => String(env.LIVELY_CODEX_CHAT || "").trim().toLowerCase();

/**
 * **새로 만드는** codex 세션의 모드. 기본은 tmux(터미널에 TUI) — 클로드와 같은 상태다.
 *  `LIVELY_CODEX_CHAT=app-server` 로 종전 대화 런타임을 켤 수 있다(experimental 표면이라 길을 남긴다).
 */
export function codexChatModeForNew(env: NodeJS.ProcessEnv = process.env): CodexChatMode {
  return envMode(env) === "app-server" ? "app-server" : "tmux";
}

/**
 * **표식이 없는** 세션을 어떻게 읽나 — 그 세션이 태어난 때의 기본, 곧 이 변경 전의 기본값이다.
 *  ⚠ 여기서 tmux 로 접으면 안 된다: 살아 있는 app-server 세션(pane=셸)에 send-keys 가 들어간다(#3982).
 */
function codexChatModeLegacy(env: NodeJS.ProcessEnv): CodexChatMode {
  return envMode(env) === "tmux" ? "tmux" : "app-server";
}

/**
 * 이 세션이 어느 모드로 도나.
 *  · codex 가 아니면 언제나 tmux(다른 하네스는 이 경로를 안 탄다).
 *  · 로그인 전용 세션(loginFor)은 언제나 tmux — 그 세션의 일은 대화가 아니라 `codex login` 이다.
 *  · 표식이 있으면 **그것이 정본**이다(태어날 때 정해진 값 — 배포 기본이 나중에 바뀌어도 안 흔들린다).
 *  · 표식이 없으면 legacy(= app-server).
 */
export function codexChatMode(
  o: { harness: string; loginFor?: string | null; stamp?: CodexModeStamp },
  env: NodeJS.ProcessEnv = process.env,
): CodexChatMode {
  if (String(o.harness || "") !== "codex") return "tmux";
  if (o.loginFor) return "tmux";
  const stamp = String(o.stamp ?? "").trim().toLowerCase();
  if (stamp === CODEX_STAMP_APP_SERVER) return "app-server";
  if (stamp === CODEX_STAMP_TMUX) return "tmux";
  //  "chat"(하네스 무관 대화 런타임, #2439)도 여기로 온다 — codex 축의 값이 아니므로 표식 없음과 같이 다룬다.
  return codexChatModeLegacy(env);
}

/** 새 세션이 표식에 적을 값(codex 가 아니면 없음 — 그 자리는 #2439 의 "chat" 이 쓴다). */
export function codexModeStampFor(harness: string, mode: CodexChatMode): string | undefined {
  if (String(harness || "") !== "codex") return undefined;
  return mode === "app-server" ? CODEX_STAMP_APP_SERVER : CODEX_STAMP_TMUX;
}
