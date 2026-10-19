// lib/invited-up.ts — 홈 사이드바 「초대받은 세션」·「초대한 세션」 층 · 순수 (#3870, 원준 2026-10-14 · 2026-10-17).
//
//  신고: «초대받은 세션은 홈에서 좀 다른 영역에 우선해서 좀 보이게 할 수도 있나? 버튼 같은 거 만들어서 초대받은 세션을 위에
//        보이게.. 지금 프로젝트 묶기는 버튼 있잖아, 그것처럼 온오프 가능하게?»
//  2026-10-17: «초대받은 세션 그 바로 아래에 초대한 세션도 보이게 해주면 좋겠음» — 같은 토글로, 두 층을 위아래로.
//
//  종전: 홈 목록의 세션 줄기(main.ts sideInstances ①)는 **내 세션만** 세웠다. 초대받은 세션은 그 창을 열어 둔 동안만 줄이 섰고,
//   닫으면 홈 어디에도 없었다 — 알림이나 링크가 없으면 다시 찾아 들어갈 길이 [AI 세션] 전체 목록뿐이었다.
//  이제: 머리글의 토글(「프로젝트로 묶기」 옆)을 켜면 「고정」 바로 아래에 두 층이 선다 — 「초대받은 세션」(남이 나를 부른 것) 그리고
//   바로 아래 「초대한 세션」(내가 남을 부른 것). 기본은 켬 — 초대는 사람이 사람을 지목한 일이라 «안 보이는 게 기본» 이면 놓친다.
//
//  무엇이 서나(invitedRowStands — 두 층 같은 잣대):
//   · 도는 세션은 늘. 멈춘 세션은 최근 INVITED_RECENT_MS 안에 움직인 것만 — 몇 달 전 초대가 층을 덮지 않게.
//   · 내가 × 로 치운 것은 안 선다(내 세션 줄과 같은 치움 정본 — sess-visibility).
//   · 내가 고정한 것은 「고정」 층이 이긴다(사람이 고른 자리가 맨 위 — lib/home-pins 와 같은 원칙). 어느 층에도 한 번만 선다.
//  끄면 종전 그대로 — 초대받은 것은 열어 둔 창만, 초대한 것은 내 세션 규칙(①)대로 날짜 묶음 안에.

/** 층 이름 — 날짜 묶음 이름표와 같은 자리 · 같은 모양. */
export const INVITED_GROUP = '초대받은 세션';
/** «내가 남을 초대한» 세션의 층 — 「초대받은 세션」 바로 아래. */
export const HOSTING_GROUP = '초대한 세션';
/** 멈춘 초대 세션이 층에 남는 기간. */
export const INVITED_RECENT_MS = 7 * 24 * 3600 * 1000;

export function invitedRowStands(o: { live: boolean; lastSeen: number; now: number; dismissed: boolean }): boolean {
  if (o.dismissed) return false;
  if (o.live) return true;
  return o.lastSeen > 0 && o.now - o.lastSeen <= INVITED_RECENT_MS;
}

export interface InvitedRowLike { invited?: boolean; hosting?: boolean; pinned?: boolean }

/**
 * 목록을 「초대받은 세션」·「초대한 세션」 층과 나머지로 나눈다. 꺼져 있으면 두 층은 비고 전부 나머지(종전).
 *  고정한 줄은 나머지(「고정」 층)로. 한 줄이 두 표식을 다 달 수는 없지만(초대받은 = 남의 세션 · 초대한 = 내 세션) 혹시 달면
 *  «초대받은» 이 이긴다 — 남이 나를 부른 일이 더 급하다.
 */
export function splitInvited<T extends InvitedRowLike>(rows: readonly T[], on: boolean): { invited: T[]; hosting: T[]; rest: T[] } {
  if (!on) return { invited: [], hosting: [], rest: [...rows] };
  const invited: T[] = [], hosting: T[] = [], rest: T[] = [];
  for (const r of rows) {
    if (r.pinned) rest.push(r);
    else if (r.invited) invited.push(r);
    else if (r.hosting) hosting.push(r);
    else rest.push(r);
  }
  return { invited, hosting, rest };
}
