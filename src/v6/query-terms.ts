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
//
//  ── 3차(#4530 검색 품질, 원준 2026-10-05) — «글자가 조금 달라도 찾는다» ──
//   실측(매니지드 · 실제 세션 50개를 과녁으로 변형 질의 229개): 붙여 쓰면(«통합 검색» → «통합검색») 20위 안 6% · 한 글자 틀리면 0% ·
//    군말 한 낱말(«방법»·«관련»)을 더하면 48% · 영어↔한글(배포·deploy)을 바꾸면 58%. 낱말이 글자 그대로 **전부** 있어야만 맞았기 때문이다.
//   그래서 낱말에 셋을 더한다(전부 순수 규칙 — 맞추는 SQL 은 conv-index-store 가 만든다):
//    · optional — 군말(«방법» · «어떻게» · «관련» · «세션» …). 없어도 되는 낱말이다. 있으면 더 맞는 것으로 친다.
//      낱말이 전부 군말이면(«문제 해결») 전부 있어야 하는 낱말로 되돌린다.
//    · alts — 같은 뜻의 다른 표기(배포 = deploy). 그 표기로 든 글도 맞은 것으로 친다(세기 0.7).
//    · loosePatterns — 붙여 쓴 말 · 한 글자 틀린 말을 받는 LIKE 꼴들. **띄어쓰기를 지운 글**에 댄다(세기 0.5). 느려서 엄격한
//      맞춤이 거의 없을 때, 빠진 낱말에만 쓴다.

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
  /** 군말 — 없어도 되는 낱말(#4530 3차). 구절은 군말이 아니다. */
  optional?: boolean;
  /** 같은 뜻의 다른 표기(소문자) — 없으면 비어 있다. */
  alts?: string[];
}

/**
 * 군말 — 사람이 검색어에 붙이지만 찾는 글에는 없기 쉬운 낱말. 없어도 되는 낱말로 다룬다(있으면 점수에 얹는다).
 *  «세션» · «대화» 는 세션을 찾는 검색에서 «그 세션» 이라는 뜻으로 붙는다(«배포 세션») — 대화 안에 그 낱말이 있어야 할 까닭이 없다.
 *  ⚠ 여기 넣는 낱말은 «빼도 뜻이 안 바뀌는» 것만이다. 넣을수록 느슨해진다 — 실측으로 필요가 확인된 것만 더한다.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  '방법', '어떻게', '어떡해', '왜', '뭐', '뭐지', '뭐였지', '뭐더라', '무엇', '어디', '언제', '누가',
  '관련', '관련된', '관련한', '대한', '대해', '관해', '관한', '위한', '위해',
  '그', '그거', '그것', '그때', '저번', '저번에', '지난번', '지난번에', '예전', '예전에', '전에', '아까',
  '좀', '것', '거', '건', '때', '하는', '했던', '하던', '있는', '있던', '하는법', '하기',
  '이유', '원인', '내용', '얘기', '이야기', '말', '말한', '말했던', '문제', '정리', '해결', '안됨', '안돼', '안되는',
  '세션', '대화', '채팅', '그리고', '및',
  'how', 'why', 'what', 'where', 'when', 'the', 'a', 'an', 'to', 'of', 'for', 'about', 'with', 'session', 'chat',
]);

/**
 * 같은 뜻의 다른 표기 묶음 — 이 워크스페이스에서 한글과 영어를 섞어 쓰는 낱말들(실측 2026-10-05: 한쪽 표기로만 치면 58%).
 *  낱말이 묶음의 한 표기와 **같을 때만**(일부가 아니라) 나머지 표기를 함께 본다. 묶음은 뜻이 같은 것만 — 넓은 뜻·좁은 뜻은 넣지 않는다.
 *  ⚠ 맞춤은 «글에 그 글자가 들어 있나» 다 — 짧거나 다른 낱말 속에 흔히 든 표기는 넣지 않는다(log 는 login 에, test 는 latest 에,
 *   file 은 profile 에, bug 는 debug 에, db·doc·icon·link 도 같은 까닭). «작업»·«검토»·«시험» 처럼 어디에나 나오는 말도 뺀다.
 */
export const TERM_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['배포', 'deploy', '디플로이', 'deployment'], ['검색', 'search', '서치'], ['세션', 'session'], ['프로젝트', 'project'], ['지식', 'knowledge'],
  ['로그인', 'login', 'signin'], ['로그아웃', 'logout', 'signout'], ['가입', 'signup'], ['사이드바', 'sidebar', '곁칸'], ['터미널', 'terminal'],
  ['알림', 'notification', '노티'], ['미리보기', 'preview', '프리뷰'], ['색인', 'index', '인덱스'], ['권한', 'permission', '퍼미션'],
  ['온보딩', 'onboarding'], ['설정', 'settings', '세팅'], ['대시보드', 'dashboard'], ['워크스페이스', 'workspace'], ['테넌트', 'tenant'],
  ['수집', 'collect'], ['분류', 'category', '카테고리'], ['태스크', 'task'], ['댓글', 'comment', '코멘트'], ['업로드', 'upload'],
  ['다운로드', 'download'], ['토큰', 'token'], ['위젯', 'widget'], ['빌드', 'build'], ['캐시', 'cache'],
  ['머지', 'merge', '병합'], ['브랜치', 'branch'], ['커밋', 'commit'], ['디자인', 'design'], ['임베딩', 'embedding'], ['리뷰', 'review'],
  ['모바일', 'mobile'], ['버튼', 'button', '단추'], ['모달', 'modal'], ['메뉴', 'menu'], ['핸드오버', 'handover', '인수인계'],
  ['스킬', 'skill'], ['하네스', 'harness'], ['게이트웨이', 'gateway'], ['에러', 'error', '오류'],
  ['스크린샷', 'screenshot', '캡처'], ['폴더', 'folder'], ['데이터베이스', 'database', '디비'],
  ['마이그레이션', 'migration'], ['롤백', 'rollback'], ['프롬프트', 'prompt'], ['에이전트', 'agent'],
];
const ALIAS_OF: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const g of TERM_ALIAS_GROUPS) for (const w of g) m.set(w, [...(m.get(w) || []), ...g.filter((x) => x !== w)]);
  return m;
})();
/** 이 낱말(또는 조사 뗀 꼴)과 같은 뜻의 다른 표기들. */
export function aliasesOf(t: string, stem: string): string[] {
  const out: string[] = [];
  for (const k of [t, stem]) for (const a of ALIAS_OF.get(k) || []) if (a !== t && a !== stem && !out.includes(a)) out.push(a);
  return out;
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
    const stem = quoted ? t : stemKo(t);
    const term: QueryTerm = { t, stem, quoted };
    if (!quoted) {
      if (FILLER_WORDS.has(t) || FILLER_WORDS.has(stem)) term.optional = true;
      const alts = aliasesOf(t, stem);
      if (alts.length) term.alts = alts;
    }
    out.push(term);
  }
  //  전부 군말이면 군말이 아니다 — «문제 해결» 로 찾는 사람은 그 두 낱말을 찾는다.
  if (out.length && out.every((x) => x.optional)) for (const x of out) delete x.optional;
  return out;
}

/** 있어야 하는 낱말(군말 제외). */
export function requiredTerms(terms: QueryTerm[]): QueryTerm[] {
  return terms.filter((t) => !t.optional);
}

/** 세기 — 친 그대로 1 · 조사 뗀 꼴 0.8 · 다른 표기 0.7 · 느슨한 맞춤(붙여 쓰기·한 글자 틀림) 0.5. */
export const STRENGTH_ALIAS = 0.7;
export const STRENGTH_LOOSE = 0.5;

/** 이 낱말이 글에 들어 있나 — 1 = 친 그대로 들어 있다 · 0.8 = 조사를 뗀 꼴만 들어 있다 · 0 = 없다. textLower 는 소문자. */
export function termStrength(textLower: string, term: QueryTerm): number {
  if (!term.t) return 0;
  if (textLower.includes(term.t)) return 1;
  if (term.stem !== term.t && term.stem.length >= 2 && textLower.includes(term.stem)) return 0.8;
  if (term.alts) for (const a of term.alts) if (textLower.includes(a)) return STRENGTH_ALIAS;
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

/** 다른 표기(alts)의 LIKE 꼴들 — 없으면 빈 목록. */
export function termAltPatterns(term: QueryTerm): string[] {
  return (term.alts || []).map(likePattern);
}

// ── 느슨한 맞춤(#4530 3차) — 붙여 쓴 말 · 한 글자 틀린 말 ──────────────────────────────────
//  대는 글은 **띄어쓰기를 지운 글**이다(SQL: translate(body, 공백들, '')). 그래서 «통합검색» 이 «통합 검색» 과 맞고, 한 글자
//   틀린 꼴(_ 한 글자)도 낱말 사이 공백에 걸리지 않는다. 낱말이 짧으면(한글 두 글자 · 영문 네 글자 이하) 느슨한 꼴이 아무 말에나
//   맞으므로 «붙여 쓴 꼴» 하나만(그것도 세 글자부터) 준다.
const LIKE_ESC = (c: string): string => (c === '\\' || c === '%' || c === '_' ? '\\' + c : c);
/** 띄어쓰기를 지울 때 걷는 글자들 — SQL translate 의 둘째 인자와 화면 쪽 정규식이 같은 표를 쓴다. */
export const LOOSE_WS = ' \n\t\r';
export function stripWs(s: string): string {
  return String(s || '').replace(/[ \n\t\r]+/g, '');
}
/**
 * 이 낱말의 느슨한 LIKE 꼴들(앞뒤 % 포함 · 최대 24개). 구절(큰따옴표)·군말·너무 짧은 낱말은 빈 목록.
 *  ① 그대로(띄어쓰기만 무시) ② 한 글자 바뀜(자리마다 _) ③ 이웃한 두 글자 자리 바뀜 ④ 한 글자 더 침(자리마다 뺌) ⑤ 한 글자 빠뜨림(사이마다 _).
 *  ②~⑤ 는 한글 세 글자 · 영문 다섯 글자부터 — 그보다 짧으면 «검_» 이 «검사»·«검토» 를 다 잡는다.
 */
export function loosePatterns(term: QueryTerm, max = 24): string[] {
  if (term.quoted || term.optional) return [];
  //  숫자만으로 된 낱말(«4530» · «#4530»)은 번호다 — 한 글자 다르면 다른 번호이고, 띄어 쓴 숫자(«45 30»)는 같은 번호가 아니다.
  //   번호는 번호로 찾는다(그 번호의 프로젝트·태스크에 묶인 세션 — conv-index-store identSessions). 격리 리뷰.
  if (/^#?[0-9]+$/.test(term.t)) return [];
  const base = [...stripWs(term.stem.length >= 2 ? term.stem : term.t)];
  const n = base.length;
  const hangul = base.some((c) => /[가-힣]/.test(c));
  if (n < 3) return [];
  const out: string[] = [];
  const add = (chars: string[]): void => { const p = '%' + chars.join('') + '%'; if (!out.includes(p) && out.length < max) out.push(p); };
  const esc = base.map(LIKE_ESC);
  add(esc);
  if (n < (hangul ? 3 : 5)) return out;
  for (let i = 0; i < n; i++) add([...esc.slice(0, i), '_', ...esc.slice(i + 1)]);
  for (let i = 0; i + 1 < n; i++) add([...esc.slice(0, i), esc[i + 1], esc[i], ...esc.slice(i + 2)]);
  if (n >= 4) for (let i = 0; i < n; i++) add([...esc.slice(0, i), ...esc.slice(i + 1)]);
  for (let i = 1; i < n; i++) add([...esc.slice(0, i), '_', ...esc.slice(i)]);
  return out;
}
/** LIKE 꼴(% _ 와 ESCAPE '\\') → 정규식. 이름·첫 지시처럼 이미 손에 든 짧은 글에 같은 규칙을 댈 때 쓴다. */
export function likeToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    re += c === '%' ? '[\\s\\S]*' : c === '_' ? '[\\s\\S]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
/** 이 낱말이 느슨하게라도 맞나 — textLower 는 소문자. 맞으면 STRENGTH_LOOSE. */
export function looseStrength(textLower: string, term: QueryTerm): number {
  const pats = loosePatterns(term);
  if (!pats.length) return 0;
  const flat = stripWs(textLower);
  return pats.some((p) => likeToRegExp(p).test(flat)) ? STRENGTH_LOOSE : 0;
}

/**
 * 느슨하게 맞은 자리의 **실제 글**(소문자) — 발췌를 그 자리에서 자르고 화면이 칠할 수 있게. 못 찾으면 null.
 *  꼴의 글자 사이에 공백을 허용해 원문에서 찾는다(«통합검색» → «통합 검색»). _ 는 공백 아닌 한 글자.
 */
export function looseFind(textLower: string, term: QueryTerm): string | null {
  for (const p of loosePatterns(term)) {
    const parts: string[] = [];
    const body = p.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '\\' && i + 1 < body.length) { parts.push(body[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); continue; }
      parts.push(c === '_' ? '\\S' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    const m = new RegExp(parts.join('[ \\n\\t\\r]*')).exec(textLower);
    if (m && m[0]) return m[0];
  }
  return null;
}
