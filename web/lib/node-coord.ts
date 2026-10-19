// 세션 행의 노드 좌표가 «정말 다른 컴퓨터» 를 가리키나 (#4904 — #4794 후속).
//
//  목록 행의 `node` 는 배지가 아니라 **좌표**다(src/sessions/session-merge.ts 머리말). 그런데 같은 칸이 두 가지를 뜻한다.
//   · 멤버 PC 노드(`laibeulliui-macmini` …) — 그 세션은 정말 그 컴퓨터에서 돈다. 키·전달은 그쪽 몫이고 대화는 중앙 기록으로 온다.
//   · 세션 호스트(`sesshost-<slug>-<node>`) — 매니지드 테넌트에 세운 프로세스로, 게이트웨이와 **같은 tmux 에 닿는다**.
//     세션 호스트가 전 테넌트에 선 뒤(2026-09-11) 살아 있는 매니지드 세션의 행엔 전부 이 좌표가 실린다.
//  서버는 두 번째를 «이 게이트웨이의 세션» 으로 접는다(src/node/self-node.ts sameTmuxCoordinate · remoteNodeCoordinate —
//   #3745 · #2600 T2 d6: 키 · 전달 큐 · 대화 기록 라우트). 화면이 좌표만 보고 «그 컴퓨터» 로 가르면 서버가 받아 주는 일을
//   화면이 막는다 — 매니지드 대화창에서 멈춤이 «멈출 턴이 없어요» 로 끝나고 승인 단추가 안 서고 전달 실패가 안 보였다(실측 2026-10-19).
//  ⚠ 서버의 근거는 노드 등록의 **선언**(session_host — src/node/registry.ts isSessionHostNode)이고 목록 행엔 그 값이 안 실린다.
//   그래서 화면은 **이름으로 추론**한다. 프로비저닝은 세션 호스트를 `sesshost-<slug>-<node>`(src/node/session-host-provision.ts
//   SESSION_HOST_NODE_PREFIX · sessionHostNodeId)로만 만들지만, 서버가 이 접두를 예약하지는 않는다 — 멤버 PC 를 `sesshost-…` 로
//   등록하면 여기선 세션 호스트로 읽고(단추가 서도 서버가 409 로 막는다), 관리자가 접두 없는 노드를 손으로 선언하면 여기선 멤버 PC 로
//   읽는다(이 수정 전의 증상 그대로). 접두는 scripts/node-coord.test.mjs 가 서버 상수와 묶는다. 근본은 행에 선언 값을 싣는 것(후속 후보).
export const SESSION_HOST_PREFIX = 'sesshost-';

/** 이 노드 좌표가 **이름으로 보아** 세션 호스트인가 — 앞뒤 공백은 무시한다. 빈 값은 아니다. 서버의 선언 판정(registry isSessionHostNode)과는 근거가 다르다(머리말). */
export function looksLikeSessionHost(node: string | null | undefined): boolean {
  return String(node ?? '').trim().startsWith(SESSION_HOST_PREFIX);
}

/** 이 좌표가 «정말 다른 컴퓨터» 면 그 id, 아니면(좌표 없음 · 세션 호스트) null. 대화창의 «그 컴퓨터» 갈래는 이 값으로 가른다. */
export function remoteNodeOf(node: string | null | undefined): string | null {
  const id = String(node ?? '').trim();
  return id && !looksLikeSessionHost(id) ? id : null;
}
