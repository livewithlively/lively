// lib/task-pane.ts — 곁칸 «태스크» 부품(v2/panes-tasks.ts)의 **판정**들. DOM·fetch 를 모른다(import 0) — 그래서 값으로 시험한다
//  (scripts/task-pane.test.mjs).
//
//  이 부품의 약속(#4084, 원준 2026-09-20): «보는 세션이 속한 프로젝트의 태스크를, 고를 것 없이 보여 준다».
//  그 약속의 절반은 그리기가 아니라 **무엇을 어디에 세우나**다 — 어느 태스크가 «이 세션의 것»인가, 무엇이 진행 중이고
//  무엇이 끝났나, 접힌 본문 줄에 무엇이 비치나, 이미 배치를 저장한 사람에게 이 탭을 어떻게 한 번만 들이나.

export interface TaskSessLike { id: string; label?: string | null }
export interface TaskLike {
  id: number; name?: string | null; status_category?: string | null;
  sessions?: TaskSessLike[] | null;
}

/** 접힌 [본문] 줄에 비칠 **한 줄**. 본문은 대개 자동 머리말(> ⚙ …)·제목(##)·주석으로 시작하므로 그것들을 건너뛴
 *  첫 «글» 줄을 고른다 — 머리말이 비치면 모든 프로젝트가 같은 줄로 보인다. 마크다운 표식은 떼고, 없으면 빈 문자열. */
export function bodyExcerpt(md: string | null | undefined): string {
  const lines = String(md || '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let heading = '';
  for (const raw of lines) {
    const s = raw.trim();
    if (!s || s.startsWith('>') || /^(-{3,}|\*{3,}|_{3,})$/.test(s)) continue;
    const plain = s.replace(/^#{1,6}\s+/, '').replace(/^([-*+]|\d+\.)\s+/, '')
      .replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    if (!plain) continue;
    if (/^#{1,6}\s/.test(s)) { if (!heading) heading = plain; continue; }   // 제목은 글이 없을 때만 쓴다
    return plain;
  }
  return heading;
}

/** 이 세션이 맡은 태스크. 세션은 이름이 여럿이다(박스 id · 대화 uuid · 접힌 옛 박스 id) — 하나라도 맞으면 그 태스크다.
 *  둘 이상 걸리면(복원으로 이어받은 경우) **안 끝난 것**, 그다음 **나중 것**(id 큰 쪽)을 고른다. */
export function taskOfSession<T extends TaskLike>(tasks: T[], sessionIds: Array<string | null | undefined>): T | null {
  const ids = new Set(sessionIds.filter((x): x is string => !!x));
  if (!ids.size) return null;
  const hits = tasks.filter((t) => (t.sessions || []).some((s) => ids.has(String(s.id))));
  if (!hits.length) return null;
  hits.sort((a, b) => (Number(isDone(a)) - Number(isDone(b))) || (b.id - a.id));
  return hits[0];
}

export const isDone = (t: TaskLike): boolean => t.status_category === 'done';
export const isDoing = (t: TaskLike): boolean => t.status_category === 'started';

export interface TaskGroups<T> { mine: T | null; doing: T[]; todo: T[]; done: T[]; doneCount: number; total: number }

/** 목록의 세 묶음. «이 세션의 태스크»는 맨 위 카드에 서므로 묶음에서 뺀다(같은 줄이 두 번 서지 않게).
 *  n/m 끝냄은 카드의 것까지 **전부** 센다 — 묶음에서 뺐다고 진행 요약에서도 빠지면 숫자가 목록과 어긋난다. */
export function groupTasks<T extends TaskLike>(tasks: T[], mine: T | null): TaskGroups<T> {
  const rest = mine ? tasks.filter((t) => t.id !== mine.id) : tasks;
  return {
    mine,
    doing: rest.filter((t) => isDoing(t)),
    todo: rest.filter((t) => !isDoing(t) && !isDone(t)),
    done: rest.filter((t) => isDone(t)),
    doneCount: tasks.filter((t) => isDone(t)).length,
    total: tasks.length,
  };
}

/** 완료 묶음을 처음에 펴 둘까 — 사람이 고른 적이 있으면 그 값, 없으면 **몇 개 안 될 때만** 편다.
 *  프로젝트가 오래되면 완료가 수십 줄이 되어, 펴 둔 채로는 진행 중인 줄이 화면 밖으로 밀린다. */
export function doneOpenByDefault(doneCount: number, pref: string | null | undefined): boolean {
  if (pref === '1') return true;
  if (pref === '0') return false;
  return doneCount <= 5;
}

// ── 이미 배치를 저장한 사람에게 이 탭을 **한 번만** 들인다 ───────────────────────────────────────
//  배치는 프로젝트마다 저장되고 새 프로젝트는 마지막 배치를 물려받는다(panes.ts). 그래서 기본 배치만 고치면
//  이미 쓰던 사람에게는 영영 안 보인다. 그렇다고 열 때마다 끼워 넣으면 사람이 닫은 탭이 되살아난다 —
//  그래서 저장소에 «들였다» 표식을 남기고 그 뒤로는 손대지 않는다.
const ZONES = ['main', 'side', 'bottom'] as const;
const baseOf = (k: unknown): string => String(k || '').split('#')[0];

function seedOne(lay: any): boolean {
  if (!lay || typeof lay !== 'object') return false;
  const has = ZONES.some((z) => Array.isArray(lay[z]) && lay[z].some((k: unknown) => baseOf(k) === 'tasks'));
  if (has) return false;
  const side: unknown[] = Array.isArray(lay.side) ? lay.side : (lay.side = []);
  const at = side.findIndex((k) => baseOf(k) === 'files');
  side.splice(at >= 0 ? at + 1 : 0, 0, 'tasks');   // 자료 바로 뒤 — 기본 배치(자료·태스크·지식·앱)와 같은 자리
  return true;
}

/** 저장된 배치 묶음({last, p})에 태스크 탭을 들인다. 이미 들였으면(`seeded.tasks`) 아무것도 안 한다.
 *  돌려주는 changed 는 «저장소를 다시 써야 하나»다 — 표식만 새로 찍혀도 true. 받은 객체를 그 자리에서 고친다. */
export function seedTasksTab(store: any): { store: any; changed: boolean; added: number } {
  const st = store && typeof store === 'object' ? store : {};
  if (st.seeded && st.seeded.tasks) return { store: st, changed: false, added: 0 };
  let added = 0;
  if (seedOne(st.last)) added++;
  if (st.p && typeof st.p === 'object') for (const k of Object.keys(st.p)) if (seedOne(st.p[k])) added++;
  st.seeded = { ...(st.seeded || {}), tasks: 1 };
  return { store: st, changed: true, added };
}

// ── 곁칸 «프로젝트» 앱(#4135) ─────────────────────────────────────────────────────────────
//  종전 «태스크» 부품을 고친 것이다(원준 2026-09-27): 본문은 늘 펼쳐 읽고 · «이 세션의 태스크»는 1. 2. 3. 순서 목록 ·
//  나머지는 «외부 태스크» 한 목록 · 새 세션 자리(?new=1)에선 프로젝트 태스크 전체에서 [담기]. 여기는 그 판정들이다.

/** 태스크 줄의 세션 한 장 — 서버 sessionsOfTasks(#4135)가 순서까지 싣는다. 옛 서버는 order/count/current 가 없다. */
export interface TaskSessRef extends TaskSessLike { owner?: string; order?: number; count?: number; current?: boolean }

/** 본문 읽기 모드는 맨 앞의 **자동 안내 인용**(`> 새 작업 창에서 … 만든 프로젝트입니다` · `> ⚙ …자동으로 만든 태스크`)을
 *  건너뛴다(원준 2026-09-27 «이거 하나도 안 중요하고 본문부터 보이게»). 인용·빈 줄이 아닌 첫 줄부터. 고치기 모드는 원문 그대로. */
export function stripLeadNotice(md: string | null | undefined): string {
  const lines = String(md || '').split('\n');
  let i = 0;
  while (i < lines.length && (/^\s*>/.test(lines[i]) || !lines[i].trim())) i++;
  return lines.slice(i).join('\n');
}

/** 이 세션의 태스크 — **순서대로**. 세션 이름 여럿 중 하나라도 맞는 ref 를 모아 order 로 줄 세운다.
 *  옛 서버(order 없음)는 taskOfSession 한 개로 물러난다 — 곁칸이 서버보다 먼저 배포돼도 비지 않게. */
export function sessionTaskOrder<T extends TaskLike>(tasks: T[], sessionIds: Array<string | null | undefined>): T[] {
  const ids = new Set(sessionIds.filter((x): x is string => !!x));
  if (!ids.size) return [];
  const hits: Array<{ t: T; order: number }> = [];
  let ordered = false;
  for (const t of tasks) {
    const ref = ((t.sessions || []) as TaskSessRef[]).find((s) => ids.has(String(s.id)));
    if (!ref) continue;
    if (typeof ref.order === 'number') ordered = true;
    hits.push({ t, order: typeof ref.order === 'number' ? ref.order : 1e9 });
  }
  if (!ordered) { const one = taskOfSession(tasks, [...ids]); return one ? [one] : []; }
  return hits.sort((a, b) => a.order - b.order || a.t.id - b.t.id).map((h) => h.t);
}

/** 프로젝트의 세션에 번호를 준다 — **만든 순서**(이른 것이 1). 곁칸 배지의 «세션 2»가 이 번호다. 모르는 시각(0)은 뒤로. */
export function sessionNumbers(sessions: Array<{ id: string; createdAt?: number; altIds?: string[]; logId?: string | null }>): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...sessions].sort((a, b) => ((a.createdAt || Infinity) - (b.createdAt || Infinity)) || String(a.id).localeCompare(String(b.id)));
  sorted.forEach((s, i) => { for (const k of [s.id, s.logId, ...(s.altIds || [])]) if (k) out.set(String(k), i + 1); });
  return out;
}

/** 세션 번호 → 배지 색. 같은 세션은 어느 줄에서나 같은 색이다. */
export const SESSION_COLORS = ['#2263EF', '#0FA37E', '#7C5CE0', '#C77D14', '#D1476B', '#1B8FB5', '#6B7F1E', '#A0522D'];
export const sessionColor = (n: number): string => SESSION_COLORS[((Math.max(1, n) - 1) % SESSION_COLORS.length)];

/** «외부 태스크»(이 세션에 없는 것)의 줄 순서 — 돌고 있는 세션이 맡은 것 → 진행 중 → 할 일, 완료는 따로(접는다).
 *  같은 무리 안에서는 보드 순서(들어온 순서)를 지킨다. busy 는 «그 태스크의 세션이 지금 일하는 중인가». */
export function externalTasks<T extends TaskLike>(tasks: T[], excludeIds: Set<number>, busy: (t: T) => boolean): { open: T[]; done: T[] } {
  const rest = tasks.filter((t) => !excludeIds.has(t.id));
  const rank = (t: T): number => (busy(t) ? 0 : isDoing(t) ? 1 : 2);
  const open = rest.filter((t) => !isDone(t)).map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
  return { open, done: rest.filter((t) => isDone(t)) };
}

/** 순서 목록에서 하나를 옮긴다(끌기 · 번호 메뉴). to 는 **옮긴 뒤의 자리**(0부터). 범위 밖이면 끝으로 붙인다. */
export function moveInOrder<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  const at = Math.max(0, Math.min(to, out.length));
  out.splice(at, 0, x);
  return out;
}

/** 글칸의 `#태스크` 부르기 — 커서 앞의 `#` 토큰(앞은 줄 처음·빈칸, 안에 빈칸 없음). 없으면 null. `@이름`(mention-text)과 같은 문법. */
export function hashQuery(text: string, caret: number): { start: number; q: string } | null {
  const upto = String(text || '').slice(0, Math.max(0, caret));
  const m = /(^|\s)#([^\s#]*)$/.exec(upto);
  if (!m) return null;
  return { start: upto.length - m[2].length - 1, q: m[2] };
}

/** `#` 로 태스크 고르기 — 이름·번호에 글자가 들어 있는 것, 안 끝난 것 먼저. 이미 고른 것은 뺀다. */
export function hashMatches<T extends TaskLike>(tasks: T[], q: string, exclude: Set<number>, limit = 6): T[] {
  const s = String(q || '').trim().toLowerCase().replace(/^#/, '');
  const hit = tasks.filter((t) => !exclude.has(t.id) && (!s || String(t.name || '').toLowerCase().includes(s) || String(t.id).startsWith(s)));
  return hit.sort((a, b) => Number(isDone(a)) - Number(isDone(b))).slice(0, limit);
}
