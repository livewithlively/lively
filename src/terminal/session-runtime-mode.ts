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

import { harnessOpensChatRuntime } from "./harness-io/chat-runtime-keys.js";

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
  //  ★ 표에서 **파생**한다 — 다만 «키» 만 담은 가벼운 자리를 본다(chat-runtime-keys.ts).
  //   표 자체를 보면 번역기 넷이 노드 에이전트 번들까지 딸려 온다(경계 가드가 잡았다).
  //   두 벌이 되지 않게 chat-adapters.test 가 전 키에서 두 답이 같은지 강제한다.
  return harnessOpensChatRuntime(harness);
}

/**
 * 배포 기본값 — `LIVELY_SESSION_RUNTIME=chat|terminal`.
 *
 *  ── ★★ 기본은 **terminal** 이다 — 두 번 뒤집었고 두 번 다 사고였다 (2026-09-01) ──
 *  자취: terminal → chat(사고) → terminal → chat(사고) → **terminal**.
 *
 *  두 번째 사고(상민님 실측 신고): pane 을 셸로 여는 전제는 채웠는데, **대화창이 그 세션의 말을
 *  못 받았다.** 그래서 사람은 TUI 도 없고 대화창도 죽은 화면을 봤고, 터미널에 친 말은 zsh 가 받아
 *  `command not found: 안녕` 이 됐다. 이 파일이 경고하던 바로 그 조합이다 —
 *  «pane 은 셸인데 대화창은 아무것도 못 받는 빈 화면(가장 나쁜 조합)».
 *
 *  ⚠ **내가 화면으로 확인하지 않고 뒤집었다.** 값 테스트 487건이 초록이어도 그건 «그 경로를
 *   돌려 봤다» 가 아니다. 다시 뒤집으려면 **실제 세션을 만들어 말을 걸어 답이 오는 것까지**
 *   눈으로 본 뒤에 한다. 그 전에는 이 줄을 건드리지 않는다.
 *
 *  ⚠ codex 는 이 값과 **무관**하다 — codexChatMode 라는 자기 축으로 app-server 를 쓴다.
 */
export function sessionRuntimeDefault(env: NodeJS.ProcessEnv = process.env): SessionRuntimeMode {
  return String(env.LIVELY_SESSION_RUNTIME || "").trim().toLowerCase() === "chat" ? "chat" : "terminal";
}

/**
 * 이 세션이 어느 모드로 도나.
 *
 *  우선순위: ① 감당 못 하는 하네스 → terminal  ② 로그인 전용 세션 → terminal
 *           ③ **노드 세션 → terminal**(런타임이 거기서 안 돈다)  ④ 사람이 고른 값  ⑤ 배포 기본
 *
 *  ②의 이유: 로그인 세션의 일은 대화가 아니라 `claude /login`·`codex login` 이다. 그 화면을 셸로 바꾸면
 *   정작 로그인할 자리가 사라진다(codex 가 같은 예외를 둔다).
 */
export function sessionRuntimeMode(
  o: { harness: string; loginFor?: string | null; choice?: SessionRuntimeChoice; onNode?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): SessionRuntimeMode {
  if (!harnessSupportsChat(o.harness)) return "terminal";
  if (o.loginFor) return "terminal";
  //  ★★ **노드 세션은 chat 을 못 한다** — 대화 런타임은 게이트웨이가 프로세스를 띄울 수 있는
  //   세션에서만 돈다(deliver-prompt 의 분기 조건이 «이 박스의 tmux 에 그 세션이 있나» 다).
  //   그 tmux 는 노드에 있으니 배달은 노드 릴레이로 가고, 대화 런타임은 **한 번도 안 돈다.**
  //
  //  ⚠ 이 줄이 없어서 사고가 났다(2026-09-01, 상민님 실측): 세션 **생성**은 노드에서 돌며
  //   chat 이라고 보고 pane 을 셸로 열었는데, **배달**은 게이트웨이에서 돌며 chat 분기를
  //   건너뛰었다. 그래서 TUI 도 없고 대화창도 죽은 세션이 됐고, 터미널에 친 말은 zsh 가 받아
  //   `command not found` 가 됐다. 같은 술어인데 **살아있음을 재는 자리가 달랐다.**
  //  ⚠ 사람이 명시로 골라도 막는다 — 못 하는 것을 골랐다고 되게 할 수는 없다.
  //  ⚠ `env.LIVELY_NODE_ID` 는 **노드 에이전트 프로세스**의 표식이다(그 안에서 createSession 이 돈다).
  //   호출부가 아는 경우엔 onNode 로 명시하는 쪽이 낫다(게이트웨이에서 노드 세션을 판정할 때).
  if (o.onNode || !!String(env.LIVELY_NODE_ID || "").trim()) return "terminal";
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
