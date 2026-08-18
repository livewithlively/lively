// 노드 ↔ 게이트웨이 WS 링크의 **클라이언트 쪽** 생존 판정 (#1541) — 순수.
//
// ★ 실측(2026-08-14 · 2026-08-18, 사용자 Windows 노드 hammurabi): 노드 프로세스는 살아 있는데(앱: "노드 실행 중")
//  게이트웨이는 몇 시간째 오프라인으로 본다(마지막 연결 03:45, 이후 재연결 0회). 8/14 엔 같은 상태가 **나흘** 갔다.
//  런처는 프로세스가 죽어야 살리는데 죽지 않았고, 에이전트는 상대가 사라진 걸 알 길이 없었다:
//   · 게이트웨이(registry.ts)는 10초마다 ping 하고 pong 이 없으면 terminate 한다 — **서버 쪽만** 감시한다.
//   · 에이전트의 상태 push 는 세션이 안 바뀌면 보내지 않는다(idle) → 죽은 소켓에 아무것도 안 써서 TCP 오류도 안 난다.
//   · SO_KEEPALIVE 도 안 켜져 있다. PC 절전(21:33 KST · 12:45 KST)으로 경로가 끊기면, 깨어난 뒤에도 소켓은
//     '연결됨' 인 채로 영원히 남는다 — 재연결 로직은 close 이벤트가 와야 도는데 그게 안 온다.
//  → 에이전트도 **게이트웨이의 ping(또는 어떤 메시지든)이 일정 시간 안 오면 스스로 끊고 다시 잇는다.**
//    끊으면(terminate) close 가 오고, 기존 재연결(백오프)이 그대로 돈다.
//
// 왜 순수함수인가: 이 판정이 틀리면 증상이 조용하다(안 끊거나 너무 자주 끊거나). 시각을 인자로 받아 표로 못박는다.

/** 게이트웨이 heartbeat 주기(registry.ts HEARTBEAT_MS)와 같은 값 — 여기서 몇 배를 기다릴지 계산한다. */
export const GW_HEARTBEAT_MS = 10_000;
/** 이 시간 동안 게이트웨이로부터 아무것도(ping·메시지) 안 오면 링크가 죽은 것으로 본다 — heartbeat 4.5주기.
 *  너무 짧으면 잠깐의 지연에도 끊고, 너무 길면 절전 뒤 복귀가 늦다. 절전 복귀 → 최대 45초 안에 다시 붙는다. */
export const LINK_STALE_MS = 45_000;
/** 감시 주기 — heartbeat 와 같게. */
export const LINK_CHECK_MS = GW_HEARTBEAT_MS;

/**
 * 링크가 죽었나 — 마지막으로 게이트웨이에서 무언가 받은 시각(lastBeatAt)이 stale 보다 오래됐으면 true.
 * @param lastBeatAt  마지막 수신 시각(ms epoch) — 열린 직후엔 open 시각
 * @param now         지금(ms epoch)
 * @param staleMs     허용 침묵(기본 LINK_STALE_MS)
 */
export function linkIsStale(lastBeatAt: number, now: number, staleMs: number = LINK_STALE_MS): boolean {
  if (!Number.isFinite(lastBeatAt) || !Number.isFinite(now)) return false;   // 모르면 끊지 않는다(안전측 — 끊기는 파괴적)
  return now - lastBeatAt > staleMs;
}
