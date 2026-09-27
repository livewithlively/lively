// 레일에서 **켜질 칸 하나**를 고른다(#3870).
//
//  원준 2026-09-27 신고: "홈 눌렀다가 밑에 분류체계 저거 눌르면 홈도 배경 하얗게 선택된 느낌인데 분류체계도 …
//   레일 위 5개 앱이랑 그 밑에 4개 앱이 동시에 두 개 된것처럼 보이는 이상한 오류".
//  구역은 사람이 고른 **장소**라 앱 화면으로 가도 기억은 그대로 남는다(사이드바가 그 구역을 계속 그린다).
//  종전엔 그 기억을 곧 켜짐으로 썼다 — 앱은 주소(activeKey)로 켜지는데 구역은 기억으로 켜져서, 앱 화면에선 둘이 함께 켜졌다.
//  켜짐은 **지금 보는 화면**의 표시다. 그래서 순서를 둔다: 리브 같은 갈 곳 > 레일에 설 수 있는 앱 > 기억한 구역.

/**
 * @param ak      지금 화면의 활성 키(main.ts activeKeyOf — 'taxonomy' · 'app:context' · 'liv' · 'home' …)
 * @param section 기억한 구역 키
 * @param links   구역이 아닌 갈 곳의 키(리브)
 * @param apps    레일에 설 수 있는 앱 키 — 구역과 같은 문(terminal·projects2·knowledge)과 숨긴 앱은 넣지 않는다
 * @returns 켜질 칸의 키. 앱이 켜지면 구역은 어느 것도 켜지지 않는다.
 */
export function railLitKey(ak: string, section: string, links: readonly string[], apps: readonly string[]): string {
  if (links.includes(ak)) return ak;
  const app = ak.startsWith('app:') ? ak.slice(4) : ak;
  if (app && apps.includes(app)) return app;
  return section;
}
