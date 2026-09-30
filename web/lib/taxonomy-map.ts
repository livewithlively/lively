// lib/taxonomy-map.ts. 「분류체계」 앱(#4233)이 무엇을 세고 어떻게 늘어놓는지의 잣대 한 자리. 순수 함수(import 0).
//
//  원준 2026-09-26 «이거 맥락 관리에 탭으로 있잖아, 그거 없애버리고 앱으로 따로 빼버리자»: 분류는 위키만의 것이 아니다.
//   지식은 knowledge_category 로, 프로젝트는 «그 분류를 단 프로젝트 목록»(project_list.category_id, #541)으로 붙는다.
//   그래서 분류 하나의 크기는 지식 수와 프로젝트 수 두 개이고, 두 수를 한 화면(전체 지도)에 나란히 보인다.
//  잎 모듈인 이유는 sess-all · past-sess 와 같다: 이 잣대가 화면 코드 안에 있으면 시험할 데가 없다(scripts/taxonomy-app.test.mjs).

/** 이 잣대가 분류에게 묻는 것. 서버 `/api/ui/categories` 행의 부분집합(숫자는 문자열로 올 수 있다). */
export interface TaxCat {
  id: number | string;
  name: string;
  key?: string | null;
  should?: string | null;
  state?: string | null;
  group_key?: string | null;
  group?: string | null;
  knowledge_count?: number | string | null;
  proposed_count?: number | string | null;
}
export interface TaxGroup { key: string; name: string; hint?: string | null; sort?: number | string | null }
/** `/api/ui/v6/project-lists` 행의 부분집합. */
export interface TaxList { id: number | string; name?: string | null; category_id?: number | string | null; project_count?: number | string | null }

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const catId = (c: { id: number | string }): number => num(c.id);
export const knowledgeOf = (c: TaxCat): number => num(c.knowledge_count);
export const isArchived = (c: TaxCat): boolean => String(c.state || 'active') === 'deprecated';
export const groupKeyOf = (c: TaxCat): string => String(c.group_key || c.group || '');

/** 분류별 프로젝트 목록 수 · 프로젝트 수. category_id 가 없거나 0 인 목록은 어느 분류에도 안 센다. */
export interface TaxCount { lists: number; projects: number }
export function countsByCategory(lists: readonly TaxList[] | null | undefined): Map<number, TaxCount> {
  const m = new Map<number, TaxCount>();
  for (const l of lists || []) {
    const cid = num(l.category_id);
    if (cid <= 0) continue;
    const cur = m.get(cid) || { lists: 0, projects: 0 };
    cur.lists += 1;
    cur.projects += num(l.project_count);
    m.set(cid, cur);
  }
  return m;
}
const countOf = (counts: Map<number, TaxCount>, c: TaxCat): TaxCount => counts.get(catId(c)) || { lists: 0, projects: 0 };
/** 빈 분류 = 지식 0 이고 이 분류를 단 프로젝트 목록 0. 지도 · 손볼 것 · 사이드바 · 지우기가 모두 이 한 기준을 쓴다
 *  (목록이 붙어 있으면 프로젝트가 0 이어도 빈 분류가 아니다: 프로젝트를 만들면 그 분류로 들어간다). */
export function isEmptyCat(c: TaxCat, counts: Map<number, TaxCount>): boolean {
  return !knowledgeOf(c) && !countOf(counts, c).lists;
}

/** 전체 지도의 한 칸 = 묶음 하나. key '' 는 «묶음 없음» 칸. */
export interface MapColumn<C extends TaxCat> {
  key: string; name: string; hint: string;
  rows: Array<{ cat: C; knowledge: number; projects: number }>;
  empty: C[];
  archived: C[];
}
export const NO_GROUP = '';

/**
 * 전체 지도. 묶음(sort 순)마다 한 칸, 모르는 묶음·묶음 없음은 맨 끝 한 칸(그런 분류가 있을 때만).
 *  줄 = 쓰는 중이고 빈 분류가 아닌 것. 지식 많은 순 → 프로젝트 많은 순 → 이름 순.
 *  빈 분류(isEmptyCat)와 치운 분류(deprecated)는 줄 대신 접힌 수로 선다.
 */
export function planTaxMap<C extends TaxCat>(cats: readonly C[] | null | undefined, groups: readonly TaxGroup[] | null | undefined,
  counts: Map<number, TaxCount>): Array<MapColumn<C>> {
  const gs = [...(groups || [])].sort((a, b) => num(a.sort) - num(b.sort) || String(a.name).localeCompare(String(b.name), 'ko'));
  const known = new Set(gs.map((g) => g.key));
  const cols: Array<MapColumn<C>> = gs.map((g) => ({ key: g.key, name: g.name, hint: String(g.hint || ''), rows: [], empty: [], archived: [] }));
  const loose: MapColumn<C> = { key: NO_GROUP, name: '묶음 없음', hint: '', rows: [], empty: [], archived: [] };
  for (const c of cats || []) {
    const gk = groupKeyOf(c);
    const col = known.has(gk) ? cols.find((x) => x.key === gk)! : loose;
    if (isArchived(c)) { col.archived.push(c); continue; }
    const k = knowledgeOf(c); const n = countOf(counts, c);
    if (isEmptyCat(c, counts)) col.empty.push(c); else col.rows.push({ cat: c, knowledge: k, projects: n.projects });
  }
  for (const col of [...cols, loose]) {
    col.rows.sort((a, b) => b.knowledge - a.knowledge || b.projects - a.projects || String(a.cat.name).localeCompare(String(b.cat.name), 'ko'));
  }
  const looseUsed = loose.rows.length + loose.empty.length + loose.archived.length > 0;
  return looseUsed ? [...cols, loose] : cols;
}

/** 막대 폭(%). 값이 있으면 최소 3(안 보이는 막대는 0 과 구별되지 않는다), 최댓값이면 100. */
export function barPct(v: number, max: number): number {
  if (!(v > 0) || !(max > 0)) return 0;
  return Math.max(3, Math.min(100, Math.round((v / max) * 100)));
}

/** 손볼 이유. 어긋남(mismatch)은 이유가 아니다: #4173 에서 «점검 결과» 표시로 걷었고, 점검기(#4174)가 붙으면 그쪽이 보인다. */
export type FixReason = 'nodef' | 'empty' | 'proposed';
export const FIX_REASONS: ReadonlyArray<{ key: FixReason; label: string; hint: string }> = [
  { key: 'nodef', label: '정의 없음', hint: '증류기가 이 분류로 지식을 보낼 기준이 없습니다' },
  { key: 'empty', label: '빈 분류', hint: '지식도 프로젝트 목록도 없습니다' },
  { key: 'proposed', label: '제안 대기', hint: '이 분류에 붙이자는 지식이 사람 확인을 기다립니다' },
];
export function fixReasons(c: TaxCat, counts: Map<number, TaxCount>): FixReason[] {
  if (isArchived(c)) return [];
  const out: FixReason[] = [];
  if (!String(c.should || '').trim()) out.push('nodef');
  if (isEmptyCat(c, counts)) out.push('empty');
  if (num(c.proposed_count) > 0) out.push('proposed');
  return out;
}
/** 손볼 것 = 이유가 하나 이상인 분류(수는 분류 개수). */
export function fixList<C extends TaxCat>(cats: readonly C[] | null | undefined, counts: Map<number, TaxCount>): Array<{ cat: C; reasons: FixReason[] }> {
  return (cats || []).map((cat) => ({ cat, reasons: fixReasons(cat, counts) })).filter((x) => x.reasons.length > 0);
}

/** 지식 유형별 수. 많은 순, 같으면 key 순. 유형 없음은 key ''. */
export function typeCounts(entries: ReadonlyArray<{ type?: string | null }> | null | undefined): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const e of entries || []) { const t = String((e && e.type) || ''); m.set(t, (m.get(t) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])));
}

/** 지우기는 비었을 때만. 지식 0 이고 이 분류를 단 프로젝트 목록 0. 그 밖에는 먼저 옮기거나 치운다. */
export function canDeleteCat(c: TaxCat, counts: Map<number, TaxCount>): boolean {
  return isEmptyCat(c, counts);
}
