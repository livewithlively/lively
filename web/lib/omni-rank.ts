// lib/omni-rank.ts — 통합검색(⌘K)의 순수 규칙(#4530, 원준 2026-10-01). DOM 무접촉이라 시험이 그대로 부른다.
//  원준: «관련도가 적당히 있는 걸 시간순으로 보여 줘야지. 지금 완전 관련도만 갖고 보여 주니까 문제 좀 있는 듯. 슬랙도 좀 참고하고.»
//
//  ── 순서(슬랙 Recent + Top Results) ──
//   ① 맨 위 «가장 맞는 결과» 최대 셋 — 번호·key 로 부른 것 > 이름이 검색어와 같은 것 > 이름에 낱말이 모두 든 것 >
//      서버가 «가장 맞는 대화» 로 표시한 세션 > key 의 일부를 친 것.
//   ② 그 아래 **낱말이 모두 글자로 맞은 것**(관련도의 문턱)을 최근 것부터, 날짜 묶음으로.
//   ③ 뜻만 비슷한 지식은 섞지 않는다 — 맨 아래 «뜻이 비슷한 지식» 묶음에만(점검 실측: 뜻 점수 0.48 문턱이 무관한 것을
//      0.49~0.66 으로 통과시켜 관련도순 10줄 중 8~9줄을 채웠다).
//
//  ── 낱말 ──
//   서버 src/v6/query-terms.ts 와 같은 규칙의 화면 사본이다(웹 묶음은 서버 소스를 들이지 않는다). 둘이 어긋나면 «화면은 맞다는데
//   서버는 안 맞다» 가 생긴다 — 바꿀 때는 둘을 함께 바꾼다(시험 scripts/omni-rank.test.mjs 가 같은 표로 둘을 잰다).

export const KO_JOSA: readonly string[] = [
  '으로부터', '에서부터', '에서는', '에서도', '에게서', '이라고', '라고는', '이라는', '으로는', '으로도',
  '에서', '으로', '까지', '부터', '에게', '한테', '처럼', '보다', '이랑', '하고', '이나', '이며', '이고', '에는', '에도', '라는', '라고',
  '은', '는', '이', '가', '을', '를', '에', '의', '로', '와', '과', '도', '만', '랑', '나', '요',
];
export function stemKo(word: string): string {
  const w = String(word || '');
  if (!/[가-힣]$/.test(w)) return w;
  for (const j of KO_JOSA) if (w.length >= j.length + 2 && w.endsWith(j)) return w.slice(0, -j.length);
  return w;
}
export interface Term { t: string; stem: string; quoted: boolean; optional?: boolean; alts?: string[] }

// ── 군말 · 다른 표기(#4530 검색 품질, 원준 2026-10-05) — 서버 query-terms.ts 의 표와 **글자 하나까지 같다**(시험 R11 이 잰다) ──
//  군말(«방법» · «세션» …)은 없어도 되는 낱말, 다른 표기(배포 = deploy)는 그 표기로 든 글도 맞은 것으로 친다(세기 0.7).
//  셸 목록의 이름 찾기(세션·프로젝트 이름)와 색칠이 서버와 같은 규칙으로 돌아야 «서버는 찾았는데 화면은 안 칠한다» 가 없다.
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  '방법', '어떻게', '어떡해', '왜', '뭐', '뭐지', '뭐였지', '뭐더라', '무엇', '어디', '언제', '누가',
  '관련', '관련된', '관련한', '대한', '대해', '관해', '관한', '위한', '위해',
  '그', '그거', '그것', '그때', '저번', '저번에', '지난번', '지난번에', '예전', '예전에', '전에', '아까',
  '좀', '것', '거', '건', '때', '하는', '했던', '하던', '있는', '있던', '하는법', '하기',
  '이유', '원인', '내용', '얘기', '이야기', '말', '말한', '말했던', '문제', '정리', '해결', '안됨', '안돼', '안되는',
  '세션', '대화', '채팅', '그리고', '및',
  'how', 'why', 'what', 'where', 'when', 'the', 'a', 'an', 'to', 'of', 'for', 'about', 'with', 'session', 'chat',
]);
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
function aliasesOf(t: string, stem: string): string[] {
  const out: string[] = [];
  for (const k of [t, stem]) for (const a of ALIAS_OF.get(k) || []) if (a !== t && a !== stem && !out.includes(a)) out.push(a);
  return out;
}
export function parseTerms(q: string, max = 8): Term[] {
  const out: Term[] = [];
  const s = String(q ?? '').toLowerCase();
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && out.length < max) {
    const quoted = m[1] !== undefined;
    const t = (quoted ? m[1] : m[2]).trim().replace(/\s+/g, ' ');
    if (!t || out.some((x) => x.t === t)) continue;
    const stem = quoted ? t : stemKo(t);
    const term: Term = { t, stem, quoted };
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
/** 1 = 친 그대로 · 0.8 = 조사 뗀 꼴만 · 0.7 = 다른 표기 · 0 = 없음. */
export function termStrength(textLower: string, term: Term): number {
  if (!term.t) return 0;
  if (textLower.includes(term.t)) return 1;
  if (term.stem !== term.t && term.stem.length >= 2 && textLower.includes(term.stem)) return 0.8;
  if (term.alts) for (const a of term.alts) if (textLower.includes(a)) return 0.7;
  return 0;
}
/** 있어야 하는 낱말(군말 제외)이 모두 (그대로 · 조사 뗀 꼴 · 다른 표기로) 들어 있나. 낱말이 없으면 false. */
export function matchAll(text: string, terms: Term[]): boolean {
  const req = terms.filter((t) => !t.optional);
  if (!req.length) return false;
  const low = String(text || '').toLowerCase();
  return req.every((t) => termStrength(low, t) > 0);
}
/** 여러 자리 중 어디에든 있어야 하는 낱말마다 있으면 true(세션 이름·하는 일·프로젝트 이름처럼 나뉜 자리). */
export function matchAllAcross(texts: Array<string | null | undefined>, terms: Term[]): boolean {
  const req = terms.filter((t) => !t.optional);
  if (!req.length) return false;
  const lows = texts.map((x) => String(x || '').toLowerCase());
  return req.every((t) => lows.some((l) => termStrength(l, t) > 0));
}
/** 색칠할 낱말 — 친 그대로 · 조사 뗀 꼴 · 다른 표기. 한 글자 낱말은 색칠하지 않는다(«창» 이 «대화창» 속에서 칠해지는 잡음). */
export function highlightWords(terms: Term[]): string[] {
  const out: string[] = [];
  for (const t of terms) {
    for (const w of [t.t, t.stem, ...(t.alts || [])]) if (w && [...w].length >= 2 && !out.includes(w)) out.push(w);
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * 둘째 줄을 첫 맞은 낱말 조금 앞에서 시작한다. 서버 발췌는 맞은 말을 가운데쯤 두는데, 폰(한 줄 28자 안팎)에서는 맞은 낱말이
 *  줄임표 뒤로 밀려 «왜 떴는지» 가 안 보였다(#4530 배포 뒤 실화면: «칩 키보드 omni.ts» → 대화 줄 둘째 줄에 낱말이 하나도 안 보임).
 *  맞은 낱말이 앞쪽(lead 글자 안)에 있으면 그대로 둔다. 자르는 자리는 가까운 띄어쓰기로 맞춘다.
 */
export function focusSnippet(text: string, words: string[], lead = 14): string {
  const s = String(text || '');
  if (!s || !words.length) return s;
  const low = s.toLowerCase();
  let at = -1;
  for (const w of words) { const i = low.indexOf(w.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at <= lead) return s;
  let from = at - lead;
  const sp = s.indexOf(' ', from);
  if (sp >= 0 && sp < at) from = sp + 1;
  if (/[\udc00-\udfff]/.test(s[from] || '')) from++;   // 서로게이트 쌍을 가르지 않는다
  //  잘린 자리가 가운뎃점(표의 칸막이였던 것)이면 그 점은 버린다 — «…· 큰따옴표» 로 보였다(실화면).
  return '…' + s.slice(from).replace(/^[·\s]+/, '');
}

// ── 지식 제목의 머리말 ─────────────────────────────────────────────────────────────
//  지식 제목 1,692개 중 38%가 «as-built(#4135, 2026-09-28): …» · «원인규명·수정(#3891, …): …» 처럼 머리말로 시작하고 87%가 60자를
//  넘는다(2026-10-01 실측). 한 줄에 다 안 들어가 머리말만 보이고 정작 무엇인지가 잘렸다. 머리말은 따로 떼어 작게 보인다.
const TITLE_HEAD_RE = /^\s*([⚠★✅❌☆]*\s*[^\s:：()（）]{1,24}(?:\s*\([^)]{0,80}\))?)\s*[:：]\s+(\S[\s\S]*)$/u;
export function splitKnowTitle(title: string): { head: string; main: string } {
  const s = String(title || '').trim();
  const m = TITLE_HEAD_RE.exec(s);
  if (!m) return { head: '', main: s };
  const main = m[2].trim();
  if (main.length < 4) return { head: '', main: s };   // 남는 것이 너무 짧으면 떼지 않는다(«결정: 예» 같은 것)
  //  머리말은 «as-built · #4135» 처럼 줄인다 — 날짜·PR 번호는 줄 오른쪽 시각과 겹친다.
  const raw = m[1].replace(/[⚠★✅❌☆]/gu, '').trim();
  const label = raw.replace(/\(.*$/, '').trim();
  const num = (raw.match(/#\d+/) || [])[0] || '';
  return { head: [label, num].filter(Boolean).join(' · '), main };
}

// ── 둘째 줄 글 다듬기 ─────────────────────────────────────────────────────────────
//  서버 발췌문·프로젝트 설명은 마크다운 원문이다. 목록 한 줄엔 기호(#, >, **, `, ▤)와 자동 안내문이 그대로 보였다(점검 실측).
//  안내문은 «… 보강됩니다.» 에서 끝난다 — 줄 끝까지 지우면 서버가 본문 앞부분을 한 줄로 접어 보낸 발췌(search-util grepSnippet 폴백)에서
//   뒤의 첫 지시까지 지워 둘째 줄이 비었다(#4530 항목 확인).
const AUTO_DESC_RE = /(?:>\s*)?(?:[⚙▤]\s*)*세션의 첫 지시에서\s*\**자동 생성\**된 프로젝트입니다(?:[^\n]*?보강됩니다\.?)?/g;
/**
 * 굵게·코드 표시만 걷는다 — **짝이 맞는 것만**. 식별자 안의 밑줄(`__init__` · `foo__bar`) · 곱셈(`a**b`) · 인자 풀기(`f(**opts)`) ·
 *  글롭(`src/**`)은 글자다. 종전엔 `**`·`__` 를 어디서든 지워 «src/__init__.py» 가 «src/init.py» 로 보였다 — 서버는 원문으로 맞췄는데
 *  화면 글이 달라져 색칠도 안 되고 보이는 이름도 틀렸다(#4530 격리 리뷰).
 *   · 백틱 안은 코드다 — 백틱만 걷고 안의 글자는 그대로 둔다(`**kwargs` · `**\/*.ts`).
 *   · 밑줄 굵게(`__굵게__`)는 걷지 않는다(파일 이름과 가를 수 없다).
 *   · 짝 없는 `**` 는 잘린 발췌의 것만 걷는다 — 한글에 붙어 있고 글 끝까지 짝이 없을 때.
 *  ⚠ 뒤돌아보기((?<!…))를 쓰지 않는다 — 옛 사파리(16.4 미만)는 그 정규식을 읽지 못해 화면 묶음 전체가 멈춘다.
 */
const CODE_SPAN_RE = /(`+)([^`\n]*?)\1/g;
export function stripEmphasis(raw: string): string {
  const codes: string[] = [];
  //  코드 조각은 자리표(\uE000n\uE001)로 빼 두었다가 되돌린다 — 그 안의 ** 는 건드리지 않는다.
  let s = String(raw ?? '').replace(CODE_SPAN_RE, (_m, _t, body: string) => { codes.push(body); return '\uE000' + (codes.length - 1) + '\uE001'; });
  s = s.replace(/`+/g, '')                                               // 짝 없는 백틱(잘린 발췌)
    .replace(/(^|[^\w*])\*\*(?=\S)([^*\n]*?\S)\*\*(?!\*)/g, '$1$2')       // **굵게**
    //  잘린 발췌에 한쪽만 남은 표시 — 한글로 시작하는(끝나는) 것만 걷는다. «**kwargs» · «tmp/**» 는 코드다.
    .replace(/(^|[\s«"'…])\*\*(?=[^\x00-\x7F])([^*\n]*)$/, '$1$2')       // 닫는 표시가 잘려 나갔다
    .replace(/([^\x00-\x7F]|[:.!?)\]])\*\*$/, '$1');                    // 여는 표시가 잘려 나갔다
  return s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => codes[Number(i)] ?? '');
}
export function cleanSnippet(raw: string, max = 160): string {
  let s = String(raw || '');
  s = s.replace(AUTO_DESC_RE, ' ');
  s = s.replace(/#{1,6}\s*첫 지시\(원문\)/g, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/\(\+\d+ matches?\)\s*→\s*\S+/g, ' ');          // 에이전트용 안내(«(+3 matches) → knowledge_get»)
  s = s.replace(/^L\d+:\s?/gm, ' ');                             // grep 줄 번호
  s = s.replace(/^\s{0,3}(?:#{1,6}|>+|[-*+]|\d+\.)\s+/gm, '');    // 줄머리 기호
  s = s.replace(/(^|\s)(?:#{1,6}|>+|[-*+])(?=\s)/g, '$1');         // 한 줄로 접힌 발췌 속의 줄머리 기호
  s = s.replace(/[▤⚙]/g, ' ');
  s = s.replace(/(^|\s)\[[ xX]\]\s+/g, '$1');                      // 체크 목록 머리([ ] · [x])
  //  표 조각 — 구분 줄(|---|---|)은 버리고 칸막이는 가운뎃점으로. 목록 둘째 줄에 «| 1 | 랜딩 화면이 …» 가 날것으로 보였다(실화면).
  //   칸막이가 둘 이상일 때만(글 속의 세로줄 하나는 그대로 둔다).
  s = s.replace(/\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?/g, ' ');
  if ((s.match(/\|/g) || []).length >= 2) {
    s = s.replace(/\s*\|\s*/g, ' · ').replace(/(?:·\s*){2,}/g, '· ').replace(/([…⋯])\s*·\s*/g, '$1 ').replace(/^\s*·\s*|\s*·\s*$/g, '');
  }
  s = stripEmphasis(s);                                           // 굵게·코드 표시
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');                       // 위키 링크
  s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');              // 마크다운 링크
  s = s.replace(/\s*⋯\s*/g, ' … ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

// ── 식별자(번호·key) ─────────────────────────────────────────────────────────────
//  번호는 정확일치만(«183» 이 1835 를 잡으면 안 된다). key 의 일부를 친 것은 **key 같은 말**일 때만 호명으로 본다 —
//  «session» 처럼 평범한 낱말까지 호명으로 치면 key 에 그 낱말이 든 지식 전부가 맨 위를 차지한다(점검 실측: 10줄 전부).
export type IdentKind = 'exact' | 'partial' | null;
export function identKind(ident: string | undefined, terms: Term[]): IdentKind {
  if (!ident || terms.length !== 1) return null;
  const q = terms[0].t.replace(/^#/, '');
  if (!q) return null;
  const id = ident.toLowerCase();
  if (id === q) return 'exact';
  if (/^[0-9]+$/.test(id)) return null;
  if (!/[-_]/.test(q) && q.length < 12) return null;   // key 같은 말(하이픈·밑줄이 있거나 긴 것)만
  return id.includes(q) ? 'partial' : null;
}

// ── 맨 위 «가장 맞는 결과» ─────────────────────────────────────────────────────────
export interface RankHit {
  key: string;
  kind: string;
  /** 비교에 쓰는 이름(지식은 머리말을 뗀 제목). */
  name: string;
  ident?: string;
  at?: number;
  /** 서버가 «가장 맞는 대화» 로 표시했나(대화 결과). */
  serverTop?: boolean;
  /** 서버가 매긴 순서(작을수록 앞) — 같은 층 안에서 쓴다. */
  order?: number;
}
/** 층(작을수록 앞). null = 맨 위 후보가 아니다. */
export function topTier(h: RankHit, terms: Term[], qNorm: string): number | null {
  const id = identKind(h.ident, terms);
  if (id === 'exact') return 0;
  const name = String(h.name || '').trim().toLowerCase();
  if (name && name === qNorm) return 1;
  if (name && matchAll(name, terms)) return 2;
  if (h.serverTop) return 3;
  if (id === 'partial') return 4;
  return null;
}
/** 이름에 질의가 놓인 자리 + 이름 길이 — 작을수록 «그 이름다운» 것. */
export function titleRank(name: string, terms: Term[]): number {
  const t = String(name || '').toLowerCase();
  const first = terms[0];
  let at = first ? t.indexOf(first.t) : -1;
  if (at < 0 && first) at = t.indexOf(first.stem);
  return (at < 0 ? 999 : at) * 10 + Math.min(99, [...t].length);
}
export const TOP_MAX = 3;
export function pickTop<T extends RankHit>(hits: T[], terms: Term[], qRaw: string, max = TOP_MAX): T[] {
  const qNorm = String(qRaw || '').trim().toLowerCase().replace(/^#/, '');
  const cands: Array<{ h: T; tier: number }> = [];
  for (const h of hits) { const tier = topTier(h, terms, qNorm); if (tier !== null) cands.push({ h, tier }); }
  cands.sort((a, b) => a.tier - b.tier
    || (a.tier === 2 ? titleRank(a.h.name, terms) - titleRank(b.h.name, terms) : 0)
    || (a.h.order ?? 0) - (b.h.order ?? 0)
    || (b.h.at ?? -Infinity) - (a.h.at ?? -Infinity));
  return cands.slice(0, max).map((x) => x.h);
}
