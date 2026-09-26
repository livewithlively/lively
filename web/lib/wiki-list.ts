// lib/wiki-list.ts — [위키] 본문 목록(#4233)이 **무엇을 싣고 어떻게 묶는지**의 잣대 한 자리. 순수 함수.
//
//  원준 2026-09-26: «A를 뼈대로 하고 C의 「새로 들어온 지식」 카드 줄만 얹는 것» · 보기 탭 줄 없이 머리 두 줄 · 목록 보기 하나.
//   문서를 누르면 이동하지 않고 오른쪽 덧창(사이드 피크)에서 읽는다. 덧창 머리의 [우측 사이드바에 고정]은 셸 오른쪽 칸으로 옮긴다.
//  화면(web/v2/wiki-main.ts)은 이 결과를 그리기만 한다. 잎 모듈인 이유는 sess-all 과 같다: 이 잣대가 화면 코드 안에 있으면
//   시험할 데가 없다(scripts/wiki-main.test.mjs).
//  ⚠ 거르기(범위 · 유형 · 찾기)는 서버가 한다(/api/ui/knowledge 의 category · is_wiki · type · q). 여기는 받은 행을 묶고 고르기만 한다.

/** 위키 유형(page-type, #290) 한글 이름. 클래식 위키(wiki-data.ts KN_TYPE_LABEL)도 이 사전을 쓴다(한 벌). 순서가 곧 유형 묶음 순서다. */
export const WIKI_TYPE_LABEL: Record<string, string> = { decision: '결정', concept: '개념', 'how-to': 'How-to', reference: '참조', research: '리서치', entity: '엔티티' };
const TYPE_ORDER = Object.keys(WIKI_TYPE_LABEL);

/** 카테고리 대문 문서(wiki-data.ts HOME_PREFIX)는 목록 · 카드 어디에도 서지 않는다. */
const HOME_PREFIX = 'category-home-';

/** 이 잣대가 문서에게 묻는 것 전부(/api/ui/knowledge?light=1 의 행). */
export interface WikiDocLike {
  name: string;
  title?: string | null;
  type?: string | null;
  category_key?: string | null;
  category_name?: string | null;
  /** 마지막으로 고친 사람(사람 id · 'connector:notion' 같은 커넥터). 작성 열 · 사람 묶기가 읽는다. */
  updated_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  is_folder?: boolean | null;
}

// ── 주소 → 범위 ─────────────────────────────────────────────────────────────

/** 본문이 보는 범위. all = 전체 문서 · index = 인덱스(is_wiki 핀) · cat = 분류 하나(id · key · 'none' = 분류 없음). peek = 딥링크로 열 문서. */
export type WikiScope = { kind: 'all'; peek: string } | { kind: 'index'; peek: string } | { kind: 'cat'; cat: string; peek: string };

/** 셸이 직접 그리는 목록 주소에 실릴 수 있는 칸. 그 밖의 칸(cats · q · type · folder)이 있으면 종전 클래식 화면이 받는다. */
const LIST_PARAMS = new Set(['indexed', 'category', 'all', 'peek']);

/**
 * 이 주소가 위키 목록이면 그 범위, 아니면 null(클래식 그대로).
 *  목록 주소: `#/app/knowledge`(레일 착지) · `#/knowledge` · `?indexed=1` · `?category=<id|key|none>` · `?all=1`, 여기에 `peek=<name>` 만 더.
 *  `#/knowledge/new` · `/review` 같은 하위 화면과 `#/k/<name>`(문서 화면 = 에디터)은 클래식이다.
 */
export function wikiScopeOf(route: string | null | undefined): WikiScope | null {
  const h = String(route || '').replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const path = (q >= 0 ? h.slice(0, q) : h).replace(/\/+$/, '');
  if (path !== 'knowledge' && path !== 'app/knowledge') return null;
  const p = new URLSearchParams(q >= 0 ? h.slice(q + 1) : '');
  for (const k of p.keys()) if (!LIST_PARAMS.has(k)) return null;
  const peek = p.get('peek') || '';
  if (p.get('indexed') === '1') return { kind: 'index', peek };
  const cat = (p.get('category') || '').trim();
  if (cat && p.get('all') !== '1') return { kind: 'cat', cat, peek };
  return { kind: 'all', peek };
}

/** 목록에 서는 문서 — 대문 문서 · 빈 행을 뺀다. */
export function visibleDocs<T extends WikiDocLike>(rows: ReadonlyArray<T | null | undefined> | null | undefined): T[] {
  return (rows || []).filter((r): r is T => !!r && !!r.name && !String(r.name).startsWith(HOME_PREFIX));
}

// ── 묶기 ──────────────────────────────────────────────────────────────────

/** 묶기 기준. 드롭다운은 이 순서 그대로 그리고, 'none' 은 구분선 아래. */
export type WikiGroupBy = 'day' | 'category' | 'type' | 'person' | 'none';
export const WIKI_GROUP_BYS: ReadonlyArray<{ key: WikiGroupBy; label: string }> = [
  { key: 'day', label: '날짜' }, { key: 'category', label: '분류' }, { key: 'type', label: '유형' }, { key: 'person', label: '사람' },
  { key: 'none', label: '묶지 않음' },
];

export interface WikiGroup<T> { key: string; label: string; rows: T[] }

const msOf = (iso: string | null | undefined): number => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : NaN; };
const localDay = (t: number): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** 이 기기 자정 기준 며칠 전인가(오늘 0 · 어제 1). 못 읽으면 NaN. */
const daysAgo = (t: number, now: number): number => (Number.isFinite(t) ? Math.round((localDay(now) - localDay(t)) / 86_400_000) : NaN);
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** 날짜 묶음 이름 — 오늘 · 어제 · «M월 D일 (요일)», 다른 해면 «YYYY년 M월 D일». */
export function wikiDayLabel(t: number, now: number): string {
  const n = daysAgo(t, now);
  if (!Number.isFinite(n)) return '날짜 모름';
  if (n === 0) return '오늘';
  if (n === 1) return '어제';
  const d = new Date(t);
  return d.getFullYear() !== new Date(now).getFullYear()
    ? `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`
    : `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
}

/** 이 문서가 그 기준에서 드는 묶음 key. 날짜는 고친 날(YYYY-MM-DD, 못 읽으면 ''). 분류 · 유형 · 사람은 값 그대로(없으면 ''). */
export function wikiGroupKey(r: WikiDocLike, by: WikiGroupBy): string {
  if (by === 'day') { const t = msOf(r.updated_at); if (!Number.isFinite(t)) return ''; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  if (by === 'category') return String(r.category_key || '');
  if (by === 'type') return String(r.type || '');
  if (by === 'person') return String(r.updated_by || '');
  return '';
}

/**
 * 받은 목록을 묶는다. 묶음 안 순서는 들어온 순서(최근에 고친 순) 그대로다. 보이는 문서 집합은 기준과 상관없이 같다.
 *  · 날짜: 최근 날부터. 날짜를 못 읽는 문서는 «날짜 모름» 한 묶음, 맨 끝.
 *  · 분류: 가장 최근에 고친 순. «분류 없음»은 맨 끝.
 *  · 유형: 사전 순서(결정 → … → 엔티티) → 모르는 유형(이름 순) → «유형 없음».
 *  · 사람: 나(me) 맨 앞 → 문서 많은 순 → 같으면 id 순 → «모름»(고친 사람이 비었다) 맨 끝. 이름은 화면이 붙인다(명부는 셸이 가졌다).
 *  · 묶지 않음: 묶음 하나(key '')에 전부. 문서가 없으면 묶음도 없다.
 */
export function groupWikiDocs<T extends WikiDocLike>(rows: readonly T[] | null | undefined, by: WikiGroupBy, now: number, me = ''): Array<WikiGroup<T>> {
  const all = [...(rows || [])];
  if (!all.length) return [];
  if (by === 'none') return [{ key: '', label: '', rows: all }];
  const m = new Map<string, T[]>();
  for (const r of all) { const k = wikiGroupKey(r, by); const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); }
  const top = (g: WikiGroup<T>): number => Math.max(...g.rows.map((r) => msOf(r.updated_at)).filter(Number.isFinite), 0);
  const labelOf = (k: string, rs: T[]): string => {
    if (by === 'day') return k ? wikiDayLabel(msOf(rs[0].updated_at), now) : '날짜 모름';
    if (by === 'category') return k ? String(rs[0].category_name || k) : '분류 없음';
    if (by === 'type') return k ? (WIKI_TYPE_LABEL[k] || k) : '유형 없음';
    return k;   // 사람 — 화면이 명부로 이름을 붙인다
  };
  const groups = [...m.entries()].map(([key, rs]) => ({ key, label: labelOf(key, rs), rows: rs }));
  const last = (g: WikiGroup<T>): number => Number(g.key === '');
  const typeRank = (k: string): number => { const i = TYPE_ORDER.indexOf(k); return i >= 0 ? i : TYPE_ORDER.length; };
  const cmp: (a: WikiGroup<T>, b: WikiGroup<T>) => number = by === 'day' ? (a, b) => last(a) - last(b) || b.key.localeCompare(a.key)
    : by === 'category' ? (a, b) => last(a) - last(b) || top(b) - top(a)
    : by === 'type' ? (a, b) => last(a) - last(b) || typeRank(a.key) - typeRank(b.key) || a.key.localeCompare(b.key)
    : (a, b) => last(a) - last(b) || Number(!!me && b.key === me) - Number(!!me && a.key === me) || b.rows.length - a.rows.length || a.key.localeCompare(b.key);
  return groups.sort(cmp);
}

// ── 「새로 들어온 지식」 카드 · 「이번 주 +N」 ─────────────────────────────────

/** 카드 — 범위 안에서 **만든 시각** 최근 순 max 장. 폴더 · 대문 문서는 빼고, 만든 시각을 못 읽으면 맨 뒤(들어온 순서). */
export function pickNewDocs<T extends WikiDocLike>(rows: readonly T[] | null | undefined, max = 4): T[] {
  const born = (r: T): number => { const t = msOf(r.created_at); return Number.isFinite(t) ? t : -Infinity; };
  return visibleDocs(rows)
    .filter((r) => !r.is_folder)
    .map((r, i) => ({ r, i, t: born(r) }))
    .sort((a, b) => (b.t === a.t ? a.i - b.i : b.t - a.t))
    .slice(0, Math.max(0, max))
    .map((x) => x.r);
}

/**
 * 만든 지 7일 안(오늘을 포함해 자정 일곱 번) 문서 수. 목록은 고친 순으로 한 창씩 받으므로, 더 있는데(hasMore) 받은 창의
 *  가장 오래 고친 문서가 7일 안이면 창 밖에 이번 주 문서가 더 있을 수 있다. 그때는 틀린 숫자 대신 null(안 보인다).
 *  ⚠ 만든 시각 ≤ 고친 시각이라, 창이 7일을 덮으면 그 안에서 센 수가 정확하다.
 */
export function weekNewCount(rows: readonly WikiDocLike[] | null | undefined, now: number, hasMore: boolean): number | null {
  const rs = visibleDocs(rows);
  const inWeek = (t: number): boolean => { const n = daysAgo(t, now); return Number.isFinite(n) && n >= 0 && n < 7; };
  if (hasMore) {
    const oldest = Math.min(...rs.map((r) => msOf(r.updated_at)).filter(Number.isFinite));
    if (!Number.isFinite(oldest) || inWeek(oldest)) return null;
  }
  return rs.filter((r) => !r.is_folder && inWeek(msOf(r.created_at))).length;
}

// ── 덧창 · 고정 ─────────────────────────────────────────────────────────────

/** 덧창 본문 — 비었으면 empty. 첫 줄이 제목과 같은 H1 이면 뺀다(덧창 머리에 제목이 이미 있다). */
export function peekBody(md: string | null | undefined, title: string | null | undefined): { md: string; empty: boolean } {
  const src = String(md || '');
  if (!src.trim()) return { md: '', empty: true };
  const t = String(title || '').trim();
  const m = src.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);
  const body = m && t && m[1].trim() === t ? src.slice(m[0].length) : src;
  return body.trim() ? { md: body, empty: false } : { md: '', empty: true };
}

/** [우측 사이드바에 고정]이 셸 오른쪽 칸에 싣는 손님. hash 는 문서 화면(#/k/<name>) — 화면이 embedUrl 로 감싼다. */
export function pinGuest(name: string, title: string | null | undefined): { key: string; title: string; hash: string; label: string } {
  return { key: 'kdoc:' + name, title: String(title || '').trim() || name, hash: 'k/' + encodeURIComponent(name), label: '문서' };
}
