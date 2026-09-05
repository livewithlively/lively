// lib/sess-fold.ts — 프로젝트 폴더 아래 **무엇을 그대로 세우고 무엇을 접을지**의 잣대 한 자리 (#762).
//
//  원준 2026-09-05 신고: "폴더를 펼쳐도 그 세션이 안 보였다 — 프로젝트 안에 들어가서 굳이굳이 찾아서 열었다."
//  원인은 권한도 목록 API 도 아니었다. 사이드바가 **도는 세션만** 폴더에 세우고 멈춘 것은 전부 「지난 세션 n」
//  한 줄 뒤로 접었기 때문이다. 어제 하던 일은 tmux 가 죽는 순간 소리 없이 그 뒤로 내려갔다
//  (실측: SNUCOM BUILD 폴더에 지난 세션 20개가 그 한 줄 뒤에 있었다).
//
//  ⚠ 「지난 세션」을 없애는 것은 답이 아니다 — 그 묶음은 원준 2026-08-24 지시("난 연 적이 없는데 지멋대로
//   펼쳐져 있어")로 **기본 접힘 · 기억 안 함**이 된 것이고, 배경을 본문 위로 올리면 그 신고가 되돌아온다.
//   가를 것은 '멈췄나'가 아니라 **'아직 오늘 일감인가'** 다: 멈춘 지 하루가 안 된 것은 배경이 아니다.
//
//  잎 모듈인 이유는 find.ts 와 같다 — 이 잣대가 화면 코드 안에 인라인으로 있으면 시험할 데가 없고,
//  그래서 조용히 깨진다. 실제로 이번 신고가 그 종류였다.

/** 멈춘 지 이만큼 안 됐으면 '지금 일감'이다. 하루 — 어제 자정 넘어 하던 일이 오늘 아침에도 폴더에 남는 길이. */
export const WARM_MS = 24 * 60 * 60 * 1000;

/** 이 세션이 '지금 일감'인가 — 도는 중이거나, 멈췄어도 하루가 안 지났으면 참. */
export function isWarmSess(s: { live?: boolean; alive?: boolean; lastSeen?: number }, now: number): boolean {
  if (s.live && s.alive) return true;                       // 도는 중 — 언제나 본문
  const t = Number(s.lastSeen || 0);
  return t > 0 && now - t < WARM_MS;
}

/**
 * 폴더 아래 줄을 둘로 가른다.
 *  - `now`  = 그대로 서는 것(도는 것 + 방금 멈춘 것). 한 목록이고 상한도 **하나**다 — 둘로 나눠 세면
 *             폴더가 상한의 두 배까지 자란다.
 *  - `cold` = 「지난 세션 n」 뒤로 접히는 것(하루 넘게 조용한 것).
 * 들어온 순서를 그대로 지킨다 — 정렬은 부르는 쪽의 몫이다(도는 것은 상태순, 멈춘 것은 최근순).
 */
export function splitFolderRows<T extends { live?: boolean; alive?: boolean; lastSeen?: number }>(
  live: T[], past: T[], now: number,
): { now: T[]; cold: T[] } {
  const warm = past.filter((s) => isWarmSess(s, now));
  const cold = past.filter((s) => !isWarmSess(s, now));
  return { now: [...live, ...warm], cold };
}
