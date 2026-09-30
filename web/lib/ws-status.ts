// lib/ws-status.ts — 워크스페이스 메뉴의 두 판정 (#3778 태스크 #4122, 원준 2026-09-21)
//
//  DOM·state 를 안 본다(순수) — 그래서 scripts/ws-status.test.mjs 가 값으로 지킨다.
//
// ① 상태 한 칸 — «준비 중이에요 — 곧 열립니다» 를 걷었다.
//   그 문장은 tenant_state 가 running 이 아니면 **무엇이든** 붙였는데, 실측(2026-09-21 원준 계정)으로
//   running 아닌 셋이 전부 stopped(절전)였다. 절전은 준비가 아니라 꺼져 있는 것이다 — 누르면 입장 문이
//   다시 켠다(lvly-cloud signup.ts «깨우는 중»). 그래서 말을 상태마다 가른다:
//     running      → 온라인
//     provisioning → 만드는 중   (갓 만든 것. 이것만은 정말 «준비 중»이라 오프라인이라 부르지 않는다)
//     그 밖        → 오프라인    (stopped·error·deleting — 지금 들어가 있을 수 없다)
//     없음(null)   → 표시 없음   (셀프호스트: 한 박스 안이라 늘 켜져 있다 — 전 행 «온라인» 은 소음이다)
//
// ② 지금 워크스페이스의 얼굴 열쇠 — 설정에서 아바타를 바꿔도 레일 문패가 안 바뀌던 것.
//   문패는 행 객체 없이 그려서 목록이 실어 온 얼굴을 slug 로 찾는데, 그 slug 를 activeWorkspaceSlug()
//   (브라우저에 고른 값)에서 가져왔다. 매니지드는 전환이 주소 이동이라 고른 값이 없어 늘 'primary' 이고,
//   목록의 열쇠는 'wonjoon-jang-074e' 같은 CP slug 라 **한 번도 안 맞았다.** 매니지드에서 «지금» 의
//   답은 서버가 준 is_current 다(rail.ts 목록 판정과 같은 규칙).

export type WsStatusTone = 'on' | 'wait' | 'off';
export interface WsStatus { text: string; tone: WsStatusTone; title: string }

export function wsStatus(tenantState: string | null | undefined): WsStatus | null {
  if (tenantState === null || tenantState === undefined || tenantState === '') return null;
  if (tenantState === 'running') return { text: '온라인', tone: 'on', title: '켜져 있어요. 누르면 바로 들어갑니다.' };
  if (tenantState === 'provisioning') return { text: '만드는 중', tone: 'wait', title: '만드는 중이에요. 다 만들어지면 들어갈 수 있어요.' };
  if (tenantState === 'stopped') return { text: '오프라인', tone: 'off', title: '꺼져 있어요. 누르면 다시 켜고 들어갑니다.' };
  return { text: '오프라인', tone: 'off', title: '지금은 열리지 않아요.' };
}

/** 목록 행 가운데 «지금 여기» 의 slug. 서버가 is_current 를 실었으면(매니지드) 그것이 답이고, 참인 행이
 *  없으면 null 이다(모르는 것을 fallback 으로 메우지 않는다 — 남의 얼굴을 쓰게 된다). 아무 행도
 *  is_current 를 안 실었으면(셀프호스트) 브라우저가 고른 값(fallback)이 답이다. */
export function currentRowSlug(rows: ReadonlyArray<{ slug: string; is_current?: boolean }>, fallback: string): string | null {
  if (!rows.some((r) => typeof r.is_current === 'boolean')) return fallback;
  const hit = rows.find((r) => r.is_current === true);
  return hit ? String(hit.slug) : null;
}
