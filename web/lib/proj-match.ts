// lib/proj-match.ts — 프로젝트 고르기 칸의 **찾기 규칙** 한 곳(#3778, 원준 2026-09-09).
//
//  두 자리가 같은 규칙을 쓴다 — 홈 컴포저의 「프로젝트」·「선행」 칸(v2/views.ts)과 세션의 프로젝트 바꾸기(v2/main.ts).
//  종전엔 둘 다 `String(p.id) === q` 였다: **번호를 다 쳐야만** 잡혔고 «#» 을 붙이면 아예 안 잡혔다. 목록에 번호가
//  «#3778» 로 적혀 있는데 그대로 쳐서는 못 찾는 것이라, 화면이 보여 준 것과 받는 것이 달랐다.
//
//  규칙(위에서부터 우선):
//   1) 번호 완전일치 — `3778` · `#3778`
//   2) 이름 부분일치 — 대소문자 무시
//   3) 번호 부분일치 — `377` 로 3778 을 찾는다(번호를 외우지 못해 앞자리만 치는 경우)
//  같은 등급 안에서는 **넘겨받은 순서**(사이드바와 같은 최근 순)를 지킨다 — 고르는 사람이 «위가 최근» 을 이미 알고 있다.

export interface ProjLike { id: number; name?: string | null }

/** 친 글에서 번호만 뽑는다 — `#3778` · `3778` 이면 3778, 아니면 null. */
export function projQueryId(q: string): number | null {
  const m = /^#?(\d+)$/.exec(q.trim());
  return m ? Number(m[1]) : null;
}

/**
 * 후보를 걸러 정렬한다. q 가 비면 **원래 순서 그대로**(최근 순) 돌려준다 — 빈 칸은 «찾기» 가 아니라 «최근» 이다.
 * limit 을 주면 그만큼 자른다(0·미지정이면 전부).
 */
export function projMatches<T extends { proj: ProjLike }>(rows: readonly T[], q: string, limit = 0): T[] {
  const s = q.trim();
  if (!s) return limit > 0 ? rows.slice(0, limit) : rows.slice();
  const num = projQueryId(s);
  const digits = /^#?\d+$/.test(s) ? s.replace(/^#/, '') : '';
  //  `#3778` 은 `3778` 과 **같은 뜻**이다 — 이름 대조에도 # 을 뗀 글로 맞춘다(안 그러면 이름에 번호가 든 행이 한쪽에서만 잡힌다).
  const ql = (digits || s).toLowerCase();
  const exact: T[] = [];
  const byName: T[] = [];
  const byNum: T[] = [];
  for (const r of rows) {
    const id = Number(r.proj.id);
    if (num !== null && id === num) { exact.push(r); continue; }
    if (String(r.proj.name || '').toLowerCase().includes(ql)) { byName.push(r); continue; }
    if (digits && String(id).includes(digits)) byNum.push(r);
  }
  const out = [...exact, ...byName, ...byNum];
  return limit > 0 ? out.slice(0, limit) : out;
}
