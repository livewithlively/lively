// lib/sess-all.ts — [AI 세션] 전체 목록(#4158)이 **무엇을 싣고 어떻게 거르는지**의 잣대 한 자리 — 순수 함수.
//
//  회의 #3977(2026-09-14) 결정 원문: «AI 세션 탭 = 전체 세션 풀스크린 조회. 중복 세션 사이드바 제거, 사이드바엔
//   프로젝트 리스트(클릭 → 그 안 세션 필터)» · 액션 아이템 P1-4 «풀스크린 목록, 세션 클릭 시 홈으로 이동, 날짜/사람 필터».
//  거르는 축은 셋이다 — **프로젝트**(사이드바가 고른다, side.ts renderSessions) · **기간** · **사람**(가운데 목록이 고른다, bins.ts renderSessAll).
//
//  ⚠ 기간의 자는 「지난 세션」 화면과 **같은 것**(past-sess.ts PAST_PERIODS · inPastPeriod)을 쓴다 — 두 목록이 «7일 이내» 를
//   다르게 세면 같은 세션이 한쪽 화면에만 선다.
//  ⚠ 휴지통 것은 싣지 않는다 — 홈·「지난 세션」과 같은 규칙(제 화면이 있다, #1851).
//  ⚠ 홈 목록에서의 자리(목록에 둠·치움 — sess-visibility.ts)는 여기서 재지 않는다. 그 재료(내 인스턴스·치운 기록)는 셸만 들고 있어서,
//   셸이 홈 사이드바와 **같은 함수**로 재어 행마다 넘긴다(main.ts homeRowVerdict). 여기서 따로 재면 판정이 두 벌이 된다.
//  잎 모듈인 이유는 past-sess·sess-fold 와 같다 — 이 잣대가 화면 코드 안에 있으면 시험할 데가 없다(scripts/sess-all.test.mjs).
import { inPastPeriod, type PastPeriod } from './past-sess.js';

/** 사이드바가 고른 프로젝트 — null = 전체 · 0 = 프로젝트 없음 · 그 밖 = 그 프로젝트 id. */
export type SessProjPick = number | null;

/** 이 판정이 세션에게 묻는 것 전부. */
export interface AllSessLike {
  projectId?: number | null;
  /** 휴지통 표식(views.ts `isTrashedSess = !!s.trashedAt`). */
  trashedAt?: string | null;
  lastSeen?: number;
  /** 주인 — 내 세션이면 'me', 남의 세션이면 그 사람 id(모르면 ''). 부르는 쪽이 views.ts isMineSess 로 정한다. */
  owner: string;
}

export interface AllSessQuery {
  proj: SessProjPick;
  period: PastPeriod;
  /** '' = 모든 사람 · 'me' = 나 · 그 밖 = 그 사람 id. */
  owner: string;
  now: number;
}

/** 이 세션이 고른 프로젝트에 드는가. ★ 0 은 «프로젝트 없음» 묶음이지 빈 값이 아니다(null 만 «전체»). */
export function inProjPick(projectId: number | null | undefined, pick: SessProjPick): boolean {
  if (pick === null) return true;
  return (Number(projectId) || 0) === pick;
}

/** 세 축으로 거르고 **최근 순**으로 — 목록은 원장이라 순서의 정본은 마지막 활동 시각이다. */
export function selectAllSess<T extends AllSessLike>(rows: readonly T[] | null | undefined, q: AllSessQuery): T[] {
  return (rows || [])
    .filter((s) => !s.trashedAt
      && inProjPick(s.projectId, q.proj)
      && inPastPeriod(Number(s.lastSeen) || 0, q.now, q.period)
      && (!q.owner || s.owner === q.owner))
    .sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
}

/**
 * 사람 고르개의 칸 — 지금 걸린 프로젝트·기간 **안에서** 주인별 개수(사람 축 자신은 빼고 센다 — 칸 숫자와 고른 뒤 보이는 줄 수가 같다).
 *  나('me')가 맨 앞, 나머지는 많은 순. ★ 지금 고른 사람은 0 이어도 남긴다 — 사라지면 걸린 거르개를 끌 길이 없다.
 */
export function ownerCounts(rows: readonly AllSessLike[] | null | undefined, q: AllSessQuery): Array<{ key: string; n: number }> {
  const m = new Map<string, number>();
  for (const s of selectAllSess(rows, { ...q, owner: '' })) m.set(s.owner, (m.get(s.owner) || 0) + 1);
  if (q.owner && !m.has(q.owner)) m.set(q.owner, 0);
  return [...m.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => Number(b.key === 'me') - Number(a.key === 'me') || b.n - a.n || a.key.localeCompare(b.key));
}
