// projects/detail-hub-model.ts — 프로젝트 허브 위젯(#3916·#4164·#4135 5판 시안)의 **순수 모델**. DOM 없음 — 테스트가 컴파일 산출물을
//  그대로 import 한다(scripts/hub-model.test.mjs). 화면(detail-hub-tasks·detail-hub-sessions)은 여기서 «무엇을 몇 줄 어떤 열로» 를 받아 그린다.
//
//  원준의 5판 원칙(2026-09-25): 카드 뷰 금지 · 프로젝트 탭 줄을 그대로 쓴다 · 새 태스크는 묶음 맨 밑 줄 · 1칸 폭은 이름 + 오른쪽 열 하나
//  (팀 설정 — 기본 담당자, 3칸 폭에서만 담당자 이름까지) · 묶기·필터·열은 1칸 폭에선 위젯 머리의 「⚙ 보기」 팝아웃에서 · 세션 줄은
//  상태 점 · 이름 · 태스크 칩(이름 바로 뒤) · 입장(이름 뒤, 다른 열을 가리지 않는다).

export type TaskColKey = 'assignee' | 'due' | 'priority';
export const TASK_COLS: TaskColKey[] = ['assignee', 'due', 'priority'];
export const TASK_COL_LABEL: Record<TaskColKey, string> = { assignee: '담당자', due: '마감일', priority: '우선순위' };

/** 1칸 폭 태스크 위젯의 보기 설정 — 「⚙ 보기」 팝아웃. 저장은 브라우저(localStorage, TASKS_PREF_KEY). */
export interface TasksViewPref {
  group: 'status' | 'none';         // 묶기 — 상태별(진행 중·할 일) | 없음(한 목록)
  filter: 'all' | 'mine';           // 필터 — 전체 | 내 것(내가 담당)
  col: TaskColKey;                  // 1칸 폭의 오른쪽 열 하나
}
export const TASKS_PREF_KEY = 'lively_hub_tasks_view';
export const TASKS_PREF_DEFAULT: TasksViewPref = { group: 'status', filter: 'all', col: 'assignee' };

/** 저장본을 믿지 않는다 — 모르는 값은 기본으로. */
export function normalizeTasksPref(raw: unknown): TasksViewPref {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  return {
    group: r.group === 'none' ? 'none' : 'status',
    filter: r.filter === 'mine' ? 'mine' : 'all',
    col: (TASK_COLS as string[]).includes(String(r.col)) ? r.col as TaskColKey : 'assignee',
  };
}

/** 폭(칸)에 따라 보이는 기본 열 — 1칸: 설정한 열 하나 · 2칸: 담당자·마감일 · 3칸: 셋 다. (5판: 태그·하위는 열이 아니라 이름 옆 칩.) */
export function taskColsFor(w: number, pref: TasksViewPref): TaskColKey[] {
  if (w <= 1) return [pref.col];
  if (w === 2) return ['assignee', 'due'];
  return [...TASK_COLS];
}

// ── 줄 예산 — 위젯 한 칸 260px(행 간격 16). 머리 30 · 바닥 34 · 안쪽 여백 28 · 간격 20 ≈ 114px(실측 1×1 몸통 146px)을 빼고,
//  묶음 하나에 머리 24 + 「＋ 태스크」 28. 줄 하나 31px(허브 안 압축 — 프로젝트 탭 37px 보다 작다, 37-projects-hub.css). 최소 1줄.
export const HUB_ROW_PX = 31;
export const HUB_GROUP_PX = 24 + 28;
export const HUB_CHROME_PX = 114;
export function rowsBudget(h: number, groups: number, extraPx = 0): number {
  const total = Math.max(1, h) * 276 - 16 - HUB_CHROME_PX - Math.max(0, groups) * HUB_GROUP_PX - Math.max(0, extraPx);
  return Math.max(1, Math.floor(total / HUB_ROW_PX));
}

/** 묶음 여럿에 줄 예산을 앞에서부터 나눈다 — 앞 묶음이 다 차면 뒤 묶음은 남은 만큼(각 묶음 최소 1줄은 보장하되 예산을 넘지 않는다).
 *  넘치는 묶음은 마지막 줄을 «… N개 더» 에 내준다(cap 을 하나 줄인다). */
export function splitRows(lengths: number[], budget: number): number[] {
  const n = lengths.length;
  if (!n) return [];
  const caps = lengths.map(() => 0);
  let left = Math.max(0, budget);
  // 최소 1줄씩(있는 묶음만)
  for (let i = 0; i < n && left > 0; i++) if (lengths[i] > 0) { caps[i] = 1; left--; }
  for (let i = 0; i < n && left > 0; i++) { const want = Math.max(0, lengths[i] - caps[i]); const give = Math.min(want, left); caps[i] += give; left -= give; }
  // 넘치면 «… 더» 줄 자리를 비운다(줄이 둘 이상일 때만 — 한 줄뿐이면 그 한 줄이 «더» 다).
  return caps.map((c, i) => (lengths[i] > c && c > 1 ? c - 1 : c));
}

// ── 태스크 묶기·필터 ───────────────────────────────────────────────────────────
export interface TaskLike { id: number | string; name?: string; status?: string; assignee?: string | null; assignees?: string[] | null; due_date?: string | null; level?: string; subtasks?: TaskLike[] }
export interface TaskGroupDef { key: string; label: string; status: 'todo' | 'in_progress' | 'done'; tasks: TaskLike[]; add: boolean }

const isDone = (t: TaskLike): boolean => t.status === 'done';
const isProg = (t: TaskLike): boolean => t.status === 'in_progress';
export const assigneesOf = (t: TaskLike): string[] => Array.isArray(t.assignees) && t.assignees.length ? t.assignees.map(String) : (t.assignee ? [String(t.assignee)] : []);
export const isMine = (t: TaskLike, meId: string): boolean => !!meId && assigneesOf(t).includes(meId);
export const openTasks = (tasks: TaskLike[]): TaskLike[] => tasks.filter((t) => !isDone(t));

/** ISO 날짜(YYYY-MM-DD…)를 그 날 0시(로컬)로 — 마감 비교용. 못 읽으면 NaN. */
export function dayStart(iso: string | null | undefined): number {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}
const DAY = 86400000;
export const isOverdue = (t: TaskLike, nowMs: number): boolean => { const d = dayStart(t.due_date); return !isDone(t) && Number.isFinite(d) && d < dayStart(new Date(nowMs).toISOString().slice(0, 10)) ; };
/** 이번 주 마감 = 오늘부터 7일 안(마감 지난 것 포함 — «이번 주에 끝내야 할 것» 을 보는 자리다). 완료는 뺀다. */
export function dueThisWeek(tasks: TaskLike[], nowMs: number): TaskLike[] {
  const today = dayStart(new Date(nowMs).toISOString().slice(0, 10));
  return tasks.filter((t) => { if (isDone(t)) return false; const d = dayStart(t.due_date); return Number.isFinite(d) && d <= today + 7 * DAY; })
    .sort((a, b) => dayStart(a.due_date) - dayStart(b.due_date));
}
export const overdueCount = (tasks: TaskLike[], nowMs: number): number => tasks.filter((t) => isOverdue(t, nowMs)).length;

/** 크기·설정에 따른 묶음 — 5판 그대로:
 *   1×1: «내 것 · 열림»(내가 담당한 열린 태스크 — meId 없거나 필터가 전체면 «열림») 한 묶음
 *   2×1: «이번 주 마감» 한 묶음
 *   그 밖: 묶기=상태면 «진행 중»·«할 일», 묶기=없음이면 «열림» 한 묶음. 필터=내 것이면 내 담당만.
 *  완료(done)는 어느 크기에도 안 그린다(«완료 N 는 접힘» 은 바닥 줄 글). */
export function taskGroupsFor(tasks: TaskLike[], w: number, h: number, pref: TasksViewPref, meId: string, nowMs: number): TaskGroupDef[] {
  const open = openTasks(tasks);
  if (w <= 1 && h <= 1) {
    const mine = pref.filter === 'mine' || !!meId ? open.filter((t) => isMine(t, meId)) : [];
    const useMine = !!meId && (pref.filter === 'mine' || mine.length > 0);
    const list = useMine ? mine : open;
    return [{ key: 'mine', label: useMine ? '내 것 · 열림' : '열림', status: 'todo', tasks: [...list.filter(isProg), ...list.filter((t) => !isProg(t))], add: true }];
  }
  if (h <= 1 && w === 2) return [{ key: 'week', label: '이번 주 마감', status: 'todo', tasks: dueThisWeek(tasks, nowMs), add: true }];
  const base = pref.filter === 'mine' && meId ? open.filter((t) => isMine(t, meId)) : open;
  // 3×1 — 한 줄 높이엔 묶음 둘을 세울 자리가 없다: «열림» 한 묶음(진행 중 먼저).
  if (h <= 1) return [{ key: 'open', label: '열림', status: 'todo', tasks: [...base.filter(isProg), ...base.filter((t) => !isProg(t))], add: true }];
  if (pref.group === 'none') return [{ key: 'open', label: '열림', status: 'todo', tasks: [...base.filter(isProg), ...base.filter((t) => !isProg(t))], add: true }];
  return [
    { key: 'in_progress', label: '진행 중', status: 'in_progress', tasks: base.filter(isProg), add: true },
    { key: 'todo', label: '할 일', status: 'todo', tasks: base.filter((t) => !isProg(t)), add: true },
  ];
}

/** 바닥 줄 글 — 5판: 1×1 «… N개 더»(listed = 그 묶음의 전체 수, 없으면 열린 수) · 1×N «마감 지남 N · 완료 N 는 접힘» · 2×1 «이번 주 마감 N · 마감 지남 N» · 그 밖 «열림 N · 마감 지남 N». */
export function tasksFootText(tasks: TaskLike[], w: number, h: number, shown: number, nowMs: number, listed?: number): string {
  const open = openTasks(tasks).length, done = tasks.length - open, over = overdueCount(tasks, nowMs);
  if (w <= 1 && h <= 1) { const total = listed == null ? open : listed; const more = Math.max(0, total - shown); return more ? '… ' + more + '개 더' : '열림 ' + total; }
  if (w <= 1) return '마감 지남 ' + over + ' · 완료 ' + done + ' 는 접힘';
  if (h <= 1 && w === 2) return '이번 주 마감 ' + dueThisWeek(tasks, nowMs).length + ' · 마감 지남 ' + over;
  return '열림 ' + open + ' · 마감 지남 ' + over + (done ? ' · 완료 ' + done + ' 는 접힘' : '');
}

// ── 세션 ─────────────────────────────────────────────────────────────────────
export interface SessionLike { id: string; label?: string | null; owner?: string | null; created?: number | null; lastBusy?: number | null; lastAttached?: number | null; lastViewed?: number | null; agentState?: string | null; working?: boolean; awaiting?: boolean; attached?: boolean; restorable?: boolean; harness?: string | null; node?: { id?: string; name?: string; online?: boolean } | null }
export interface SessionGroupDef { key: string; label: string; sessions: SessionLike[] }

/** 마지막 활동 시각(ms) — 바쁜 시각 > 붙은 시각 > 만든 시각. 초 단위(created)는 ms 로. */
export function sessionLastActivity(s: SessionLike): number {
  const ms = (v: number | null | undefined): number => { const n = Number(v) || 0; return n && n < 1e12 ? n * 1000 : n; };
  return Math.max(ms(s.lastBusy), ms(s.lastAttached), ms(s.lastViewed), ms(s.created));
}

/** 세션이 맡은 태스크 — 프로젝트 상세의 tasks[].sessions 를 뒤집어 세션 id → 태스크. 한 세션은 태스크 하나(#4084). */
export function sessionTaskIndex(tasks: Array<{ id: number | string; name?: string; sessions?: Array<{ id: string }> | null }>): Map<string, { id: number | string; name: string }> {
  const m = new Map<string, { id: number | string; name: string }>();
  for (const t of tasks || []) for (const s of (Array.isArray(t.sessions) ? t.sessions : [])) if (s && s.id && !m.has(String(s.id))) m.set(String(s.id), { id: t.id, name: String(t.name || '') });
  return m;
}

/** 묶음 — 5판: 1×N «사용 중»·«최근» · 2×1/3×1 한 묶음 «세션» · 2×2 이상 «태스크에 붙은 세션»·«태스크 없는 세션». live 판정은 호출자가 준다(상태 어휘는 session-status.ts). */
export function sessionGroupsFor(sessions: SessionLike[], w: number, h: number, isLive: (s: SessionLike) => boolean, hasTask: (s: SessionLike) => boolean): SessionGroupDef[] {
  if (w <= 1 && h >= 2) return [{ key: 'live', label: '사용 중', sessions: sessions.filter(isLive) }, { key: 'recent', label: '최근', sessions: sessions.filter((s) => !isLive(s)) }];
  if (h <= 1) return [{ key: 'all', label: '세션', sessions }];
  return [{ key: 'bound', label: '태스크에 붙은 세션', sessions: sessions.filter(hasTask) }, { key: 'free', label: '태스크 없는 세션', sessions: sessions.filter((s) => !hasTask(s)) }];
}

/** 정렬 — 순위(작을수록 먼저: 확인 필요 → 작업 완료 → 작업 중 → 대기 → …) 다음 마지막 활동 내림차순. rank 는 호출자(session-status.ts sessRank). */
export function sortSessions<T extends SessionLike>(sessions: T[], rank: (s: T) => number): T[] {
  return [...sessions].sort((a, b) => (rank(a) - rank(b)) || (sessionLastActivity(b) - sessionLastActivity(a)));
}

// ── 본문·코멘트 ─────────────────────────────────────────────────────────────
/** 안 읽은 코멘트 수 — 기기별 마지막 읽음 id(localStorage `pjv_cmt_read_<pid>`)보다 새 것, 내가 쓴 건 제외(detail-body 와 같은 규칙). */
export function unreadComments(comments: Array<{ id?: number | string; actor?: string | null }>, lastReadId: number, meId: string): number {
  return comments.filter((c) => (Number(c.id) || 0) > lastReadId && c.actor !== meId).length;
}
/** 본문 글자 수 — 마크다운 기호·공백을 걷은 뒤. */
export function bodyCharCount(md: string): number {
  return String(md || '').replace(/[#>*_`\[\]()]/g, '').replace(/\s+/g, '').length;
}

// ── 폴더 ────────────────────────────────────────────────────────────────────
export interface FileLike { name: string; type?: string; size?: number; mtime?: number }
export const splitDirs = (items: FileLike[]): { dirs: FileLike[]; files: FileLike[] } => ({ dirs: items.filter((i) => i.type === 'dir'), files: items.filter((i) => i.type !== 'dir') });
/** 최근 순 파일 n개(폴더 제외, mtime 내림차순 — 같으면 이름순). */
export function recentFiles(items: FileLike[], n: number): FileLike[] {
  return splitDirs(items).files.slice().sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0) || String(a.name).localeCompare(String(b.name))).slice(0, Math.max(0, n));
}

// ── 타임라인 레인 ──────────────────────────────────────────────────────────
export interface ActLike { author_person?: string | null; committed_at?: string | null; created_at?: string | null }
export const actWhen = (a: ActLike): number => { const t = Date.parse(String(a.committed_at || a.created_at || '')); return Number.isFinite(t) ? t : 0; };
/** 로컬 날짜 키 YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export interface LaneDay { key: string; label: string; weekend: boolean; today: boolean }
/** 오늘을 끝으로 n일 — 라벨 «D»(달이 바뀌는 첫날은 «M/D»), 주말·오늘 표식. */
export function laneDays(n: number, nowMs: number): LaneDay[] {
  const out: LaneDay[] = [];
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY);
    const first = i === n - 1 || d.getDate() === 1;
    out.push({ key: dayKey(d.getTime()), label: first ? (d.getMonth() + 1) + '/' + d.getDate() : String(d.getDate()), weekend: d.getDay() === 0 || d.getDay() === 6, today: i === 0 });
  }
  return out;
}
/** 사람 × 날 건수 — 사람 순서는 첫 등장 순(호출자가 팀원 순으로 앞에 세울 수 있다). 기록 없는 사람은 없다. */
export function laneCounts(acts: ActLike[], days: LaneDay[], order: string[] = []): Map<string, number[]> {
  const idx = new Map(days.map((d, i) => [d.key, i]));
  const m = new Map<string, number[]>();
  for (const p of order) if (p) m.set(p, days.map(() => 0));
  for (const a of acts) {
    const p = String(a.author_person || '');
    const when = actWhen(a); if (!p || !when) continue;
    const i = idx.get(dayKey(when)); if (i == null) continue;
    if (!m.has(p)) m.set(p, days.map(() => 0));
    m.get(p)![i]++;
  }
  for (const [p, row] of [...m]) if (!row.some((n) => n > 0) && !order.includes(p)) m.delete(p);
  return m;
}
/** 점 크기 단계 — 0 없음 · 1(1건) · 2(2~3) · 3(4~6) · 4(7+). */
export const dotSize = (n: number): 0 | 1 | 2 | 3 | 4 => (n <= 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4);
/** 피드의 날 라벨 — 오늘 · 어제 · M/D. */
export function feedDayLabel(ms: number, nowMs: number): string {
  const k = dayKey(ms), t = dayKey(nowMs), y = dayKey(nowMs - DAY);
  if (k === t) return '오늘'; if (k === y) return '어제';
  const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate();
}
export const countOn = (acts: ActLike[], key: string): number => acts.filter((a) => actWhen(a) && dayKey(actWhen(a)) === key).length;
export const countSince = (acts: ActLike[], fromMs: number): number => acts.filter((a) => actWhen(a) >= fromMs).length;
/** 가장 최근 기록의 (사람, 날) — 2×2 이상 «자세히» 칸의 기본 선택. 없으면 null. */
export function latestLane(acts: ActLike[]): { person: string; day: string } | null {
  let best: ActLike | null = null;
  for (const a of acts) if (a.author_person && actWhen(a) && (!best || actWhen(a) > actWhen(best))) best = a;
  return best ? { person: String(best.author_person), day: dayKey(actWhen(best)) } : null;
}
