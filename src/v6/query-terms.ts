// v6/query-terms.ts — 사람이 검색칸에 친 글을 낱말로 나누는 규칙 한 벌(#4530, 원준 2026-10-01).
//  원준: «세션 내부의 대화 내용의 일부나 내가 그 세션에서 고쳤던 대상을 어렴풋하게 쳐서 … 세션을 찾고 싶은 경우에 많이 쓰이는데,
//   검색 퀄리티가 너무 형편없음.»
//
//  ── 왜 따로 두나 ──
//  화면 검색(⌘K)은 사람이 치는 글을 받는다. 사람은 «검색을», «세션이», «omni.ts에서» 처럼 **조사를 붙여** 치고, 괄호·물음표가
//  든 제목(«통합검색(⌘K)»)을 그대로 붙여 넣는다. 에이전트용 grep(search-util parseGrep)은 정규식을 받아들이는 계약이라
//  이런 글을 엉뚱하게 읽는다(괄호가 묶음이 된다 · «검색을» 은 «검색» 만 든 글과 안 맞는다). 화면 검색은 이 규칙만 쓴다.
//
//  ── 실측(2026-10-01, 원준 세션 80개에서 뽑은 질의 344개 · 매니지드 대화 검색) ──
//   조사를 붙여 치면 원하는 세션을 1위로 찾은 비율이 4%였다(붙이지 않으면 96%). 낱말 끝의 조사를 떼어 «낱말 그대로 또는
//   조사를 뗀 꼴» 둘 중 하나가 맞으면 맞은 것으로 치자 100% 가 됐다.
//
//  규칙(순수 · DB 무접촉):
//   · 공백으로 나눈다. «큰따옴표로 묶은 말» 은 한 낱말(구절)로 본다 — 구절은 조사를 떼지 않는다.
//   · 대소문자는 무시한다(소문자로 바꾼다). 같은 낱말은 한 번만.
//   · 한글로 끝나는 낱말은 끝의 조사를 한 번 뗀 꼴(stem)을 함께 갖는다. 떼고 남는 것이 두 글자 이상일 때만 뗀다
//     («이가» 를 «이» 로 만들지 않는다). 긴 조사부터 본다(«에서는» 을 «는» 보다 먼저).
//   · 정규식·LIKE 메타문자는 **글자 그대로**다 — SQL 로 보낼 때는 likeEscape 로 감싼다(likePattern).

/** 낱말 끝에 붙는 조사(긴 것부터). 너무 짧은 일반 낱말 끝(«이», «가»)도 들어 있어서 두 글자 이상 남을 때만 뗀다. */
export const KO_JOSA: readonly string[] = [
  '으로부터', '에서부터', '에서는', '에서도', '에게서', '이라고', '라고는', '이라는', '으로는', '으로도',
  '에서', '으로', '까지', '부터', '에게', '한테', '처럼', '보다', '이랑', '하고', '이나', '이며', '이고', '에는', '에도', '라는', '라고',
  '은', '는', '이', '가', '을', '를', '에', '의', '로', '와', '과', '도', '만', '랑', '나', '요',
];

/** 한글로 끝나는 낱말에서 끝의 조사를 한 번 뗀다. 뗄 것이 없거나 남는 것이 두 글자 미만이면 그대로 돌려준다. */
export function stemKo(word: string): string {
  const w = String(word || '');
  if (!/[가-힣]$/.test(w)) return w;
  for (const j of KO_JOSA) if (w.length >= j.length + 2 && w.endsWith(j)) return w.slice(0, -j.length);
  return w;
}

export interface QueryTerm {
  /** 친 그대로(소문자). */
  t: string;
  /** 조사를 뗀 꼴 — 뗄 것이 없으면 t 와 같다. 구절이면 늘 t. */
  stem: string;
  /** 큰따옴표로 묶어 친 구절인가. */
  quoted: boolean;
}

/** 검색어 → 낱말 목록(순서 유지 · 중복 제거). 최대 8개 — 그보다 길면 사람이 문장을 붙여 넣은 것이라 앞 8개로 충분하다. */
export function parseQueryTerms(q: string, max = 8): QueryTerm[] {
  const out: QueryTerm[] = [];
  const s = String(q ?? '').toLowerCase();
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && out.length < max) {
    const quoted = m[1] !== undefined;
    const t = (quoted ? m[1] : m[2]).trim().replace(/\s+/g, ' ');
    if (!t || out.some((x) => x.t === t)) continue;
    out.push({ t, stem: quoted ? t : stemKo(t), quoted });
  }
  return out;
}

/** 이 낱말이 글에 들어 있나 — 1 = 친 그대로 들어 있다 · 0.8 = 조사를 뗀 꼴만 들어 있다 · 0 = 없다. textLower 는 소문자. */
export function termStrength(textLower: string, term: QueryTerm): number {
  if (!term.t) return 0;
  if (textLower.includes(term.t)) return 1;
  if (term.stem !== term.t && term.stem.length >= 2 && textLower.includes(term.stem)) return 0.8;
  return 0;
}

/** SQL LIKE 에 넣을 꼴 — `%` `_` `\` 를 글자로 만든다(ESCAPE '\\' 와 함께 쓴다). */
export function likePattern(s: string): string {
  return '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
}

/** 이 낱말이 맞는지 볼 LIKE 꼴들 — 친 그대로, 그리고 조사를 뗀 꼴이 다르면 그것까지. */
export function termPatterns(term: QueryTerm): string[] {
  return term.stem !== term.t && term.stem.length >= 2 ? [likePattern(term.t), likePattern(term.stem)] : [likePattern(term.t)];
}
