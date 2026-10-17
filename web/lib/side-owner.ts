// 사이드바는 **지금 화면의 앱 것**이다(#4632, 원준 2026-10-17).
//
//  «사이드바 내용까지가 하나의 앱이야. 한 앱을 실행했는데 다른 앱의 사이드바가 계속 떠있거나, 홈의 사이드바가 떠있는 경우는 없어야한다.
//   앱은 사이드바가 있어도 되고, 없어도 되지만(앱빌더로 만들때는 디폴트가 없는거임) 없을 때에는 사이드바 영역만큼도 다 그 앱이 쓰는게 디폴트야.»
//  종전엔 자료 · 분류체계 · 세션 이력만 제 사이드바를 갖고, 나머지 앱(앱빌더 · 설정 · 리브 · 확인할 것 · 외부 앱 연결 · 대시보드 …)은
//   직전에 고른 구역(대개 홈)의 목록을 그대로 둔 채 가운데만 바뀌었다. 설정은 제 왼쪽 목록까지 있어 사이드바가 둘로 섰다.
//
//  그래서 화면마다 사이드바의 주인을 셋 중 하나로 정한다 — 이 표가 셸의 유일한 판정이다(main.ts 의 열 접기 · side.ts 의 그리기 · rail.ts 의 켜짐):
//   · 'section' — 구역(홈 · 세션 목록 · 프로젝트 · 위키)의 목록. 구역의 화면과 그 구역에서 여는 것(세션 · 프로젝트 · 지난 세션 · 휴지통)이다.
//   · 앱 이름 — 그 앱이 제 사이드바를 그린다(자료 · 분류체계 · 세션 이력 · 앱빌더).
//   · 'none' — 사이드바가 없는 앱. 사이드바 열을 접고 그 자리까지 앱이 쓴다(레일은 남는다 — 다른 앱 · 구역으로 가는 길).
//     표에 없는 앱은 여기로 온다: 앱의 기본은 «사이드바 없음» 이다. 앱 안에 제 왼쪽 목록이 있으면(설정) 그것이 그 앱의 사이드바다.
//  ⚠ 입력은 main.ts activeKeyOf 의 활성 키다('home' · 's:<id>' · 'p:<id>' · 'builder' · 'app:<클래식 앱>' · 앱 인스턴스는 'app:').

export type SideSec = 'home' | 'sess' | 'proj' | 'wiki';
export type OwnSide = 'sources' | 'taxonomy' | 'sessions' | 'builder';
export type SideOwner = 'section' | 'none' | OwnSide;

/** 제 사이드바를 그리는 앱 — 활성 키 → side.ts 의 갈래. */
const OWN: Record<string, OwnSide> = { sources: 'sources', taxonomy: 'taxonomy', 'app:sessions': 'sessions', builder: 'builder' };
/** 구역과 같은 문(레일의 구역이 여는 그 화면) — 이 화면에선 그 구역의 목록이 선다. 다른 구역을 기억하고 있어도. */
const DOOR: Record<string, SideSec> = { 'app:terminal': 'sess', 'app:projects2': 'proj', 'app:knowledge': 'wiki' };
/** 세션이 사는 화면 — 홈 첫 화면 · 세션 · 프로젝트(그 맨 위 세션으로 가는 문). 위키 목록에는 세션이 없다. */
const isSessionScreen = (ak: string): boolean => ak === 'home' || ak.startsWith('s:') || ak.startsWith('p:');

/**
 * 이 화면의 사이드바 주인.
 * @param ak   활성 키(main.ts activeKeyOf)
 * @param page 주소의 첫 칸 — 활성 키가 'app:'(앱 인스턴스 · 크게 보기 · 처음 설정 · 모르는 주소)일 때만 본다
 */
export function sideOwnerOf(ak: string, page = ''): SideOwner {
  const own = OWN[ak];
  if (own) return own;
  if (isSessionScreen(ak) || ak === 'archive' || ak === 'trash' || DOOR[ak]) return 'section';
  //  'app:' — 앱 인스턴스(#/i/…)와 크게 보기(#/full/…)는 앱이 화면 가득. 처음 설정(#/welcome)은 제 단계에서 사이드바를 여닫고(ob-bare),
  //   모르는 주소는 셸이 홈을 그린다 — 둘 다 구역 그대로.
  if (ak === 'app:' || ak === '') return page === 'i' || page === 'full' ? 'none' : 'section';
  return 'none';
}

/**
 * 구역 목록이 서는 화면에서 **어느 구역의 목록**인가.
 *  구역은 사람이 고를 때만 바뀐다(rail.ts 머리말 — 홈 목록에서 세션을 열어도 목록이 남는다). 그 기억은 그대로 두고, 그 구역이 이 화면의 것이 아닐 때만 비킨다:
 *  ① 구역과 같은 문(위키 · 프로젝트 · 세션 목록 화면)은 그 구역 — 홈을 기억한 채 지식 링크를 열면 위키 목록이 선다.
 *  ② 세션이 사는 화면에 위키를 기억하고 있으면 홈 — 위키 목록은 세션 화면의 것이 아니다.
 */
export function sectionShown(ak: string, remembered: SideSec): SideSec {
  const door = DOOR[ak];
  if (door) return door;
  if (remembered === 'wiki' && isSessionScreen(ak)) return 'home';
  return remembered;
}
