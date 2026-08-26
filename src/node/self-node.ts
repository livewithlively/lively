// 게이트웨이 자신이 노드로도 등록됐나 — **순수 판정** (#2108).
//
// `lively node --daemon` 은 self-register 라, 게이트웨이가 도는 그 박스에서 실행하면 평범한 member 노드로
//  목록에 들어온다. 같은 박스면 **같은 tmux 서버**를 보므로 한 세션이 두 경로로 접근된다 — 박스 경로는
//  tmux 에 직접 물어 즉시 확답을 받고, 노드 경로는 3초 스냅샷을 거친다. 그 차이가 "중앙 컴퓨터로 고르면
//  열리는데 노드로 고르면 새 세션이 복원으로 샌다"를 만든다(#2108). 위탁 스케줄러에도 해롭다 — 같은 박스가
//  CENTRAL 과 원격 노드로 두 번 후보에 올라 용량이 이중계산된다.
//
// 판정 근거를 **호스트명이 아니라 tmux 겹침**으로 둔 이유: 호스트명은 대용물이라 같은 이름의 다른 PC 를
//  자기 자신으로 오인할 수 있는데, 그러면 멤버의 개인 PC 가 세션 생성 목록에서 조용히 사라진다. 겹침은
//  해로운 성질(같은 tmux) 그 자체라 오탐이 없고, 노드 에이전트 변경 없이 구 번들에도 그대로 듣는다.

/**
 * 이 노드가 게이트웨이와 **같은 tmux 서버**를 쓰나 = 같은 박스인가.
 *
 * ⚠ **양성일 때만 참**이다. 겹침이 없다고 '아니다'로 뒤집으면 안 된다 — 세션이 하나도 없는 순간엔 볼 것이
 *  없을 뿐이고(없음 ≠ 아니다), 그 오답은 곧 "자기 자신인데 아니라고 판정"이라 이 장치를 통째로 무력화한다.
 *
 * @param gatewaySessionIds 이 게이트웨이 tmux 가 **답해서** 준 세션 id(strict 조회 — '못 봤다'를 빈 목록으로 접지 말 것)
 * @param nodeSessionIds 그 노드가 스냅샷으로 보고한 세션 id
 */
export function sharesGatewayTmux(
  gatewaySessionIds: ReadonlySet<string>, nodeSessionIds: readonly string[],
): boolean {
  if (!gatewaySessionIds.size || !nodeSessionIds.length) return false;   // 볼 것이 없다 = 판정 불가(≠ 아니다)
  return nodeSessionIds.some((id) => gatewaySessionIds.has(id));
}
