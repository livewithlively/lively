// 세션 런타임 모드 — 이 세션의 대화를 **무엇이 주도하나** (#2439). **순수**(env·인자만 읽는다).
//
//  ── 두 갈래 ─────────────────────────────────────────────────────────────────────
//   terminal  pane 에서 하네스 TUI 가 돌고, 사람이 그 화면을 직접 본다. 우리 대화창은 **대화 파일을 읽어**
//             옆에서 따라 그린다(종전·기본). 백그라운드 작업·승인·슬래시는 TUI 안에서만 보인다.
//   chat      pane 은 **셸**이고, 하네스는 구조화된 프로토콜로 돈다(claude stream-json · codex app-server).
//             작업·승인·슬래시·사용량이 **이벤트로** 와서 대화창이 그릴 수 있다.
//
//  ── ★ 왜 둘 다 필요한가 (2026-08-31 실측이 정한 것) ──────────────────────────────
//  «TUI 는 그대로 두고 관측자만 붙이면 되지 않나» 를 실제로 재봤다. 답은 **안 된다** 였다:
//   · claude 는 codex 와 달리 같은 대화를 두 프로세스가 열어도 **거부하지 않는다**(대화도 안 꼬였다).
//   · 그런데 **stream-json 은 자기 프로세스가 한 일만 낸다** — 옆에서 도는 TUI 가 백그라운드 셸을 띄우든
//     서브에이전트를 돌리든 관측자에겐 **한 줄도 안 온다**(실측: 홀더가 받은 것은 자기 init 8줄뿐).
//   · 대화 파일에도 없다(transcript 26줄에 task 이벤트 0건).
//  즉 그 정보를 얻는 유일한 길은 **우리가 그 프로세스를 주도하는 것**이다. 그래서 모드가 갈린다.
//
//  ── 왜 «하나로 통일» 하지 않나 ───────────────────────────────────────────────────
//  chat 모드에서 pane 에 TUI 를 함께 띄우면 **대화가 둘로 갈린다**(터미널에서 친 것과 대화창에서 친 것이
//  다른 대화가 된다). codex 가 pane 을 셸로 둔 이유와 같다(#2055 §10). 그렇다고 terminal 모드를 없애면
//  사람이 하네스 TUI 를 직접 쓰는 길이 사라진다 — 그건 UX 후퇴이자, Claude Code 를 호스팅하는 조건
//  («인증 방법을 제거·비활성·제한하지 않는다», code.claude.com/docs/en/legal-and-compliance)과도 맞물린다.
//  그래서 **모드를 고르게 하고, 어느 쪽이든 터미널로 가는 길은 남긴다.**

import { canOpenChatRuntime } from "./harness-io/chat-adapters.js";

export type SessionRuntimeMode = "terminal" | "chat";

/** 사람이 세션을 만들 때 고른 값(없으면 배포 기본을 따른다). */
export type SessionRuntimeChoice = SessionRuntimeMode | null | undefined;

/**
 * 이 하네스가 **chat 모드를 감당할 수 있나** — 구조화된 대화 런타임이 실측으로 확인된 것만 true.
 *
 * ⚠ 여기에 «될 것 같다» 를 넣지 않는다. 미실측 하네스를 chat 으로 열면 그 세션은 말을 걸 곳이 없는
 *  빈 화면이 된다(pane 은 셸인데 대화창은 아무것도 못 받는다) — 가장 나쁜 조합이다.
 *  grok(ACP)·opencode(serve)는 경로가 있으나 우리 어댑터가 아직 없다 → false.
 */
export function harnessSupportsChat(harness: string): boolean {
  //  ★ 표에서 **파생**한다(harness-io/chat-adapters.ts). 여기 손으로 적으면 «표엔 없는데 모드는
  //   열리는» 상태가 생기고, 그 세션은 pane 이 셸인데 대화창이 아무것도 못 받는 빈 화면이 된다.
  return canOpenChatRuntime(harness);
}

/**
 * 배포 기본값 — `LIVELY_SESSION_RUNTIME=chat|terminal`.
 *
 *  지금은 **terminal 이 기본**이다. 대화창이 작업·승인·슬래시를 아직 안 그리기 때문이고, 그 커버리지가
 *  차기 전에 기본을 옮기면 «덜 익은 화면이 남의 기본 화면이 되는» 사고가 난다(2026-08-31 실측 사고).
 *  ③④(작업 표면·승인/슬래시)가 붙고 프리뷰 실측을 통과하면 이 한 줄을 뒤집는다.
 */
export function sessionRuntimeDefault(env: NodeJS.ProcessEnv = process.env): SessionRuntimeMode {
  return String(env.LIVELY_SESSION_RUNTIME || "").trim().toLowerCase() === "chat" ? "chat" : "terminal";
}

/**
 * 이 세션이 어느 모드로 도나.
 *
 *  우선순위: ① 감당 못 하는 하네스 → terminal  ② 로그인 전용 세션 → terminal
 *           ③ 사람이 고른 값     ④ 배포 기본
 *
 *  ②의 이유: 로그인 세션의 일은 대화가 아니라 `claude /login`·`codex login` 이다. 그 화면을 셸로 바꾸면
 *   정작 로그인할 자리가 사라진다(codex 가 같은 예외를 둔다).
 */
export function sessionRuntimeMode(
  o: { harness: string; loginFor?: string | null; choice?: SessionRuntimeChoice },
  env: NodeJS.ProcessEnv = process.env,
): SessionRuntimeMode {
  if (!harnessSupportsChat(o.harness)) return "terminal";
  if (o.loginFor) return "terminal";
  if (o.choice === "chat" || o.choice === "terminal") return o.choice;
  return sessionRuntimeDefault(env);
}

/**
 * chat 모드 세션의 **pane 은 셸인가** — 화면이 «터미널에서 답하기» 같은 안내를 가르는 데 쓴다.
 *
 * ⚠ `sessionRuntimeMode` 와 값이 같아 보이지만 **다른 질문이다.** 모드는 «대화를 누가 주도하나» 이고
 *  이건 «저 터미널 탭에 무엇이 떠 있나» 다. 종전에 이 둘을 한 함수가 겸하다가, claude 를 넣으면서
 *  갈렸다(claude 는 terminal 모드에서 pane 이 **진짜 TUI** 라 승인·로그인이 거기서 뜬다).
 *  한 함수가 두 뜻을 겸하면 화면이 사람에게 거짓 안내를 한다.
 */
export function paneIsShell(mode: SessionRuntimeMode): boolean {
  return mode === "chat";
}
