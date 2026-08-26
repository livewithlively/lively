// codex 대화 스레드를 **세션 상태에 남기는** 한 곳 (#2055).
//
//  ── 왜 함수 하나로 묶나 ──
//  app-server 로 한 턴을 돌리고 나면 반드시 두 가지를 남겨야 한다:
//   ① thread id — 게이트웨이가 재기동돼도 **같은 대화**로 이어 붙는다(없으면 새 스레드가 열려 대화가 갈린다).
//   ② rollout 파일 경로 — **화면이 대화를 읽는 유일한 단서**다. 평소엔 세션 안 훅이 보고하지만
//      app-server 턴에서는 그 훅이 아예 돌지 않는다(실측 2026-08-26). 우리가 threadId 를 아니 직접 찾아 넣는다.
//
//  이 두 줄을 빠뜨리면 증상은 **"답이 안 온다"** 다 — 답은 파일에 멀쩡히 있는데 화면이 그 파일을 못 찾는다.
//  실제로 두 번 밟았다: 프롬프트 경로에서 한 번(고침), 그리고 **세션 생성의 첫 지시 경로에서 또 한 번**
//  (같은 코드를 그쪽에 안 옮겨서 — 그래서 여기로 뽑아 둘 다 부른다).
import { setClaudeSessionId } from "../sessions/session-state.js";

/**
 * 그 세션의 대화 좌표를 갱신한다. 조용히 실패한다(대화 자체는 이미 성립했다 — 여기서 던지면 답을 못 준다).
 *  변한 게 없으면 쓰지 않는다(폴링마다 DB 를 두드리지 않기 위해서다).
 */
export async function rememberCodexThread(o: {
  sessionId: string;
  threadId: string;
  owner: string;
  osUser: string | null;
  /** 이미 아는 값(있으면 같은지 비교해 불필요한 쓰기를 건너뛴다). */
  knownThreadId?: string | null;
  knownPath?: string | null;
}): Promise<void> {
  if (!o.threadId) return;
  const { rolloutPath } = await import("./harness-io/codex-chat-runtime.js");
  const tpath = await rolloutPath(o.osUser, o.threadId).catch(() => "");
  if (o.threadId === o.knownThreadId && (!tpath || tpath === o.knownPath)) return;
  await setClaudeSessionId(o.sessionId, o.threadId, o.owner, tpath || null).catch(() => false);
}
