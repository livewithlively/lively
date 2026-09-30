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
