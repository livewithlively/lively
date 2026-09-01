// codex 세션의 대화 런타임 선택 (#2055 P2-B) — **순수**(env 만 읽는다).
//
//  ── 두 갈래 ──
//   tmux(기본·종전)   pane 에서 codex TUI 가 돌고, 화면의 글자는 아웃박스 → send-keys 로 들어간다.
//   app-server        pane 은 **셸**이고, 대화는 app-server(JSON-RPC)가 돈다. 글자 유실이 없고 승인을 우리가 받는다.
//
//  ── 왜 스위치인가 ──
//  App Server 는 공식 문서가 *"experimental and aren't supported for production workloads"* 라고 못박은 표면이다.
//  그래서 ⓐ 기본은 종전 그대로 ⓑ 켠 배포에서도 실패하면 종전 경로로 폴백 ⓒ 언제든 끌 수 있어야 한다.
//  켜는 값은 배포 env 하나다(`LIVELY_CODEX_CHAT=app-server`) — 조직 설정으로 올리는 건 실박스 검증 뒤에 한다.
//
//  ── ★ 왜 pane 이 셸이어야 하나 ──
//  codex 는 **스레드당 writer 를 하나만** 허용한다(실측: `thread-store conflict: … already has an active writer`).
//  TUI 와 app-server 가 같은 대화를 동시에 쥘 수 없으므로, app-server 모드에서 pane 에 TUI 를 띄우면
//  대화가 두 개로 갈린다(터미널에서 보는 것과 대화창에서 보는 것이 다른 대화가 된다). 그래서 pane 은 셸이다.
//  사람이 TUI 로 이어가고 싶으면 대화창이 스레드를 놓아 주고(프로세스 종료) `codex resume <id>` 로 넘긴다.

export type CodexChatMode = "tmux" | "app-server";

/**
 * 이 배포의 기본 모드 — **codex 는 대화 UI(app-server)가 기본이다.**
 *
 *  ── 왜 기본을 뒤집었나 (2026-08-27, 상민님 지시) ──
 *  처음엔 opt-in 이었다. App Server 가 공식 문서상 experimental 인데다, 켜는 순간 pane 이 TUI 대신 셸로
 *  바뀌는 눈에 띄는 변화라 «조용한 전환» 을 피하고 싶었다. 그 판단을 뒤집은 근거는 둘이다:
 *   ① **실측이 쌓였다** — 매니지드 프로덕션에서 로컬·원격 노드 양쪽 배치로 왕복이 확인됐다(e2e 상시 검사).
 *   ② **경계가 배포마다 실제로 서게 됐다** — 마지막까지 비어 있던 자리가 격리 리눅스였는데, 거기서도
 *      포트를 버리고 0600 유닉스 소켓으로 바꿔 닫았다(codex-as-supervisor.ts). 그전까지는 «켤 때 동의를
 *      받는 노브» 로 막고 있었고, 그건 결함을 노브로 덮은 것이지 고친 게 아니었다.
 *
 *  끄는 길은 남긴다: `LIVELY_CODEX_CHAT=tmux`. experimental 표면이라 언제든 되돌릴 수 있어야 한다는
 *  처음의 판단은 그대로 유효하다 — 바뀐 것은 **어느 쪽이 기본이냐** 뿐이다.
 */
export function codexChatModeDefault(env: NodeJS.ProcessEnv = process.env): CodexChatMode {
  return String(env.LIVELY_CODEX_CHAT || "").trim().toLowerCase() === "tmux" ? "tmux" : "app-server";
}

/**
 * 이 세션이 어느 모드로 도나.
 *  · codex 가 아니면 언제나 tmux(다른 하네스는 이 경로를 안 탄다).
 *  · 로그인 전용 세션(loginFor)은 언제나 tmux — 그 세션의 일은 대화가 아니라 `codex login` 이다.
 */
export function codexChatMode(
  o: { harness: string; loginFor?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): CodexChatMode {
  if (String(o.harness || "") !== "codex") return "tmux";
  if (o.loginFor) return "tmux";
  return codexChatModeDefault(env);
}
