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
 * 이 배포의 기본 모드. 값이 정확히 app-server 일 때만 켠다(오타는 종전 동작으로 접는다 — 조용한 전환 금지).
 *
 *  ── ★ 격리 리눅스 박스(#524)는 한 겹 더 묻는다 ──
 *  app-server 는 `ws://127.0.0.1:<포트>` 로 말하는데 **그 포트에는 인증이 없다**. 경계를 누가 대신 서느냐가
 *  배포마다 다르다:
 *   · 매니지드      세션 컨테이너가 선다 — loopback 이 그 세션 안이라 밖에서 못 닿는다.
 *   · 비격리(맥·dev) 어차피 단일 사용자 박스다 — 지킬 경계가 없다.
 *   · **격리 리눅스**  여러 멤버가 **같은 호스트**를 나눠 쓴다. 같은 박스의 다른 멤버 OS 유저가 그 포트에
 *     붙어 **남의 대화를 조종**할 수 있다 — 이 배포의 존재 이유인 그 경계가 여기서만 비어 있다.
 *  그래서 격리에서는 `LIVELY_CODEX_CHAT_ISOLATED=1` 로 **운영자가 그 사실을 알고** 켜야 한다. 없으면 tmux 로
 *  접는다(종전 동작 = 안전한 쪽). codex 가 `unix://` 를 지원하면 이 노브는 사라진다 — 지금은 그 표면이
 *  initialize 에서 연결을 끊는다(codex-app-server-daemon.ts 머리말 실측).
 */
export function codexChatModeDefault(
  env: NodeJS.ProcessEnv = process.env,
  o: { isolated?: boolean } = {},
): CodexChatMode {
  if (String(env.LIVELY_CODEX_CHAT || "").trim().toLowerCase() !== "app-server") return "tmux";
  if (o.isolated && String(env.LIVELY_CODEX_CHAT_ISOLATED || "").trim() !== "1") return "tmux";
  return "app-server";
}

/**
 * 이 세션이 어느 모드로 도나.
 *  · codex 가 아니면 언제나 tmux(다른 하네스는 이 경로를 안 탄다).
 *  · 로그인 전용 세션(loginFor)은 언제나 tmux — 그 세션의 일은 대화가 아니라 `codex login` 이다.
 */
export function codexChatMode(
  o: { harness: string; loginFor?: string | null; isolated?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): CodexChatMode {
  if (String(o.harness || "") !== "codex") return "tmux";
  if (o.loginFor) return "tmux";
  return codexChatModeDefault(env, { isolated: o.isolated });
}
