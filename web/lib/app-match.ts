// lib/app-match.ts — 앱 찾기(런치패드 · 통합검색)가 «이 앱이 이 검색어에 맞나» 를 재는 잣대(#4233). 리프 모듈(import 0).
//  이름을 바꾼 앱은 옛 이름으로도 찾혀야 한다(원준 2026-09-27 「맥락 관리」 → 「수집 · 증류」). 옛 이름은 화면에 안 보이는
//  검색어(aka)로만 남는다. 런치패드와 통합검색이 같은 함수를 쓴다: 잣대가 둘이면 한쪽에서만 찾힌다.

export interface AppSearchable {
  title: string;
  desc: string;
  /** 화면에 안 보이는 검색어(옛 이름 · 띄어쓰기 다른 표기). */
  aka?: readonly string[];
}

const fold = (s: string): string => s.toLowerCase();

/** 검색어가 이름 · 설명 · 검색어(aka) 가운데 어디든 들어 있으면 맞는다. 빈 검색어는 전부 맞는다. */
export function appMatches(a: AppSearchable, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  return fold(a.title).includes(q) || fold(a.desc).includes(q) || (a.aka || []).some((k) => fold(k).includes(q));
}

/** 순서: 0 = 이름이 검색어로 시작 · 1 = 이름 안에 있음 · 2 = 옛 이름 등 검색어(aka)에 있음 · 3 = 설명에만 있음. */
export function appRank(a: AppSearchable, query: string): number {
  const q = fold(query.trim());
  const i = fold(a.title).indexOf(q);
  if (i === 0) return 0;
  if (i > 0) return 1;
  if ((a.aka || []).some((k) => fold(k).includes(q))) return 2;
  return 3;
}

// ── 앱 찾기의 두 묶음(#4554) ──
//  base = 라이블리에 기본으로 들어 있는 앱. workspace = 이 워크스페이스의 앱(세션이 만들었거나 관리자가 설치한 앱 · 대시보드).
export type PadGroup = 'base' | 'workspace';

/** 설치된 앱(org_app)이 서는 묶음. 제품에 실려 온 것(source.kind='builtin')만 기본 앱이고, 출처를 모르면 워크스페이스 앱이다 —
 *  남이 만든 앱을 «기본» 이라 부르는 쪽이 더 나쁜 거짓말이다. */
export function padGroupOfInstalled(sourceKind: string | undefined | null): PadGroup {
  return sourceKind === 'builtin' ? 'base' : 'workspace';
}

/** 검색 중 Enter 로 열릴 칸 — 화면 순서로 늘어선 칸들의 rank(작을수록 잘 맞음) 가운데 가장 잘 맞은 칸의 자리. 동점은 앞 칸. 칸이 없으면 -1.
 *  묶음이 둘이라 «맨 앞 칸» 으로 정하면, 위 묶음의 설명에만 맞은 앱이 아래 묶음의 이름이 맞은 앱을 이긴다. */
export function padBestIndex(ranks: readonly number[]): number {
  let best = -1;
  for (let i = 0; i < ranks.length; i++) if (best < 0 || ranks[i] < ranks[best]) best = i;
  return best;
}
