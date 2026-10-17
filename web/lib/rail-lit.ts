// 레일에서 **켜질 칸 하나**를 고른다(#3870).
//
//  원준 2026-09-27 신고: "홈 눌렀다가 밑에 분류체계 저거 눌르면 홈도 배경 하얗게 선택된 느낌인데 분류체계도 …
//   레일 위 5개 앱이랑 그 밑에 4개 앱이 동시에 두 개 된것처럼 보이는 이상한 오류".
//  구역은 사람이 고른 **장소**라 앱 화면으로 가도 기억은 그대로 남는다(사이드바가 그 구역을 계속 그린다).
//  종전엔 그 기억을 곧 켜짐으로 썼다 — 앱은 주소(activeKey)로 켜지는데 구역은 기억으로 켜져서, 앱 화면에선 둘이 함께 켜졌다.
//  켜짐은 **지금 보는 화면**의 표시다. 그래서 순서를 둔다: 리브 같은 갈 곳 > 레일에 설 수 있는 앱 > 기억한 구역.

/**
 * @param ak      지금 화면의 활성 키(lib/side-owner activeKeyOfRoute — 'taxonomy' · 'app:context' · 'liv' · 'home' …)
 * @param section 이 화면에 서는 구역 키(rail.ts railShownSection)
 * @param links   구역이 아닌 갈 곳의 키(리브)
 * @param apps    레일에 설 수 있는 앱 키 — 구역과 같은 문(terminal·projects2·knowledge)과 숨긴 앱은 넣지 않는다
 * @param owner   이 화면의 사이드바 주인(lib/side-owner) — 주면, 구역 목록이 아닌 화면(앱 화면)에선 구역 칸을 켜지 않는다(#4632).
 *                설정 · 확인할 것 · 앱 인스턴스처럼 레일에 제 칸이 없는 앱에서 기억한 구역이 켜지면 «홈에 있다» 로 읽혔다. 그럴 땐 아무 칸도 안 켠다('').
 * @returns 켜질 칸의 키. 앱이 켜지면 구역은 어느 것도 켜지지 않는다.
 */
export function railLitKey(ak: string, section: string, links: readonly string[], apps: readonly string[], owner?: string): string {
  if (links.includes(ak)) return ak;
  const app = ak.startsWith('app:') ? ak.slice(4) : ak;
  if (app && apps.includes(app)) return app;
  if (owner && owner !== 'section') return '';
  return section;
}

// 레일 **최근 칸**에 설 앱과 그 순서(#3870).
//
//  원준 2026-09-28 신고: "좌측 레일에서 누르는 버튼으로 제대로 이동을 안해 … 최근순으로 아이콘 정렬되느라고 이상한건가?"
//  종전엔 최근 칸을 **연 순서 그대로** 세웠다 — 셋째 칸을 누르면 그 앱이 맨 위로 올라가고 나머지가 한 칸씩 밀렸다.
//  매니지드 실측: 최근 칸을 40번 눌러 26번 순서가 바뀌었다. 방금 누른 자리에 다른 앱이 서 있으니 같은 자리를 다시 누르면 딴 데로 간다.
//  그래서 **누가 서는지**(최근에 연 n개)와 **어디 서는지**(앱 표 순서 — 런치패드와 같은 순서)를 나눈다.
//  이미 칸에 선 앱을 눌러서는 아무 칸도 움직이지 않는다. 칸에 없던 앱을 열 때만 가장 오래된 하나가 빠지고 그 앱이 들어온다.

/**
 * @param recent   최근 연 앱 키(최근 것이 앞 — apps.ts noteAppUse 의 기록)
 * @param eligible 최근 칸에 설 수 있는 앱 키, **앱 표 순서**로 — 숨긴 앱·구역과 같은 문·독에 고정한 앱·꺼진 앱은 이미 뺀 것
 * @param n        칸 수
 * @returns 설 앱 키, 앱 표 순서로. 기록이 모자라면 표 순서로 채운다(빈 칸은 '고장'으로 읽힌다).
 */
export function railRecentKeys(recent: readonly string[], eligible: readonly string[], n: number): string[] {
  const pick = new Set<string>();
  for (const k of recent) { if (pick.size >= n) break; if (eligible.includes(k)) pick.add(k); }
  for (const k of eligible) { if (pick.size >= n) break; pick.add(k); }
  return eligible.filter((k) => pick.has(k));
}

// ── 설치한 앱(구성원 앱)도 최근 칸에 선다(#4769, 원준 2026-10-17 «최근에 들어간 앱이 사이드바 아래쪽에 떠야 하는데 … 팀 채널 여러 번 눌렀는데 안 뜸») ──
//  종전엔 최근 기록이 앱 표(apps.ts APPS)의 키만 받아서 앱 찾기에서 연 구성원 앱은 몇 번을 열어도 서지 않았고, 기록이 비니 표 순서로 채운
//  사용 가이드 · 분류체계가 «오래전에 누른 것이 아직 떠 있다» 로 읽혔다. 설치 앱의 키는 `i:<앱 id>` — 앱 표 키와 섞이지 않는다.
export const INSTALLED_RECENT_PREFIX = 'i:';
export const installedRecentKey = (appId: string): string => INSTALLED_RECENT_PREFIX + appId;
export const isInstalledRecentKey = (key: string): boolean => typeof key === 'string' && key.startsWith(INSTALLED_RECENT_PREFIX) && key.length > INSTALLED_RECENT_PREFIX.length;
/** 최근 칸에 설 수 있는 설치 앱의 키 — 화면(UI 페이지)이 있고 정본 주소(system.route)를 따로 갖지 않는 것(자료 · 확인할 것은 앱 표의 줄이 맡는다). 차례는 받은 그대로. */
export function installedRailEligible(apps: ReadonlyArray<{ id: string; hasUi: boolean; systemRoute?: string | null }>): string[] {
  return apps.filter((a) => !!a.id && a.hasUi && !a.systemRoute).map((a) => installedRecentKey(a.id));
}
