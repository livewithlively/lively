// session-history.ts — 세션 이력 앱(#4553, 원준 2026-10-04)의 순수 규칙. **DOM 을 쓰지 않는다**(시험이 컴파일 결과를 그대로 import 한다).
//
//  세션 이력 앱은 가로탭 셋이다 — 「대화 찾기」 · 「작업 일지」 · 「세션 목록」. 화면 파일(sessions-*.ts)은 그리기만 하고,
//  «무엇이 어느 묶음에 서나 · 어떤 줄이 한 줄로 접히나 · 맞은 말이 대화록의 어느 자리인가» 는 여기서 정한다.
import { sessIsDead, sessLabel, sessStateKey, type SessLike } from './session-status.js';
import { dayStart, daysAgoStart } from './lib/omni-order.js';
import { isIdLabel } from './lib/sess-name.js';
import { NO_PROJECT_NAME } from './lib/proj-none.js';   // #4551 — 프로젝트에 안 붙은 세션 묶음의 이름 한 자리

// ── 「세션 목록」 탭 — 도는 세션(terminal/sessions)과 중앙 기록(v6/sessions)을 한 목록으로 ─────────────────────
//  같은 세션이 두 목록에 있으면 한 줄이다: 도는 세션의 claudeSessionId(그 박스가 지금 도는 대화 uuid)가 기록의 session_id 면
//  기록을 그 줄에 접는다. 같은 대화를 두 박스가 갖고 있으면(되살리기는 새 박스를 만든다) 살아 있는 쪽 · 그다음 최근 쪽만 남긴다.
//  휴지통에 있는 것은 어느 쪽이든 뺀다. (셸의 mergeSessions 와 같은 규칙이다 — 그쪽은 셸 모델을 통째로 끌고 와 여기서 못 쓴다.)
export interface HistRow {
  /** 줄의 열쇠 — 박스 id(있으면) 아니면 대화 uuid. */
  key: string;
  name: string;
  /** 셸이 세션 화면을 여는 id. 기록만 남은 세션은 null. */
  boxId: string | null;
  /** 중앙 기록의 대화 uuid — 없으면 대화록을 못 연다(아직 올라온 기록이 없다). */
  convId: string | null;
  /** 중앙 기록의 node_id('' = 게이트웨이 박스). */
  node: string;
  projectId: number | null;
  projectName: string | null;
  /** 중앙 기록이 말하는 프로젝트(그 대화에 붙은 것) — 기록이 없거나 붙은 프로젝트가 없으면 null. 박스의 것(projectId)과 다를 수 있다:
   *  실측 2026-10-05, 기록 323개 가운데 72개는 박스에만 프로젝트가 있고 기록에는 없다. 대화 찾기 · 작업 일지 · 맞은 말 검색은 기록의 것으로 말하고
   *  거르므로, 기록이 있는 줄은 사이드바와 「세션 목록」 탭도 이것으로 세고 보인다(rowProject) — 탭마다 다른 프로젝트를 말하지 않게. */
  recProjectId: number | null;
  recProjectName: string | null;
  /** session-status 의 key, 또는 'log'(기록만 남음). */
  stateKey: string;
  stateLabel: string;
  /** 박스가 살아 있나(되살릴 것 없이 열 수 있다). 아무도 안 보고 있는 「오프라인」도 여기 든다. */
  alive: boolean;
  /** 지금 쓰이고 있나 — 확인 필요 · 작업 중 · 작업 완료 · 대기 중. 「실행 중」 거르개(프로젝트 허브의 «사용 중» 과 같은 뜻). */
  live: boolean;
  mine: boolean;
  lastMs: number;
  /** 중앙 기록의 마지막 활동(ms) — 기록이 없으면 0. lastMs 는 박스의 활동까지 본 값이라 이보다 늦을 수 있다(일지는 기록의 시각으로 묻는다). */
  recMs: number;
  firstMs: number;
  bytes: number;
  harness: string | null;
  /** 첫 지시(대화 제목). */
  title: string | null;
}

/** 초·밀리초가 섞여 오는 시각 값을 ms 로(자릿수로 가른다). */
const epochMs = (v: unknown): number => {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
};
const isoMs = (v: unknown): number => {
  if (!v) return 0;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
};

export function mergeHistoryRows(liveRows: any[], logRows: any[], nowMs: number): HistRow[] {
  const out = new Map<string, HistRow>();
  const byConv = new Map<string, HistRow>();
  const projNames = new Map<number, string>();
  for (const r of logRows || []) if (r && r.project_id != null && r.project_name) projNames.set(Number(r.project_id), String(r.project_name));

  //  휴지통 표식은 박스 id 에도, 대화 uuid 에도 붙는다 — 박스 쪽에만 붙어 있어도 그 대화의 기록 줄이 되살아나면 안 된다.
  const trashedConv = new Set<string>();
  for (const r of liveRows || []) {
    if (!r || !r.id) continue;
    if (r.trashedAt) { if (r.claudeSessionId) trashedConv.add(String(r.claudeSessionId)); continue; }
    //  이 앱은 «내 세션» 의 이력이다 — 프로젝트를 같이 쓰는 남의 세션(includeProjects)은 싣지 않는다. 사람 열이 없는 표에 섞이면
    //   누구 것인지 알 수 없고, 그 대화록은 초대받지 않았으면 열리지도 않는다.
    if (!r.owned) continue;
    const key = sessStateKey(r as SessLike, nowMs);
    const alive = r.observed === false ? false : !sessIsDead(r as SessLike, nowMs);
    const pid = r.projectId ? Number(r.projectId) : null;
    const row: HistRow = {
      key: String(r.id), name: String(r.label || r.title || r.id), boxId: String(r.id),
      convId: r.claudeSessionId ? String(r.claudeSessionId) : null, node: '',
      projectId: pid, projectName: pid != null ? (projNames.get(pid) ?? null) : null, recProjectId: null, recProjectName: null,
      stateKey: key, stateLabel: sessLabel(r as SessLike, nowMs),
      //  못 본 판의 행(observed=false)은 «돈다» 고 말하지 않는다 — 서버가 DB 행으로 지어낸 것이다(session-status SessLike.observed).
      alive, live: alive && (key === 'waiting' || key === 'busy' || key === 'done' || key === 'idle'),
      mine: true, lastMs: epochMs(r.lastActive || r.created), recMs: 0, firstMs: epochMs(r.created),
      bytes: 0, harness: r.harness ? String(r.harness) : null, title: null,
    };
    //  같은 대화를 두 박스가 갖고 있다 — 살아 있는 쪽, 같으면 최근 쪽.
    const prev = row.convId ? byConv.get(row.convId) : undefined;
    if (prev) {
      const win = row.alive !== prev.alive ? (row.alive ? row : prev) : (row.lastMs >= prev.lastMs ? row : prev);
      const lose = win === row ? prev : row;
      if (win.projectId == null && lose.projectId != null) { win.projectId = lose.projectId; win.projectName = lose.projectName; }
      out.delete(lose.key);
      out.set(win.key, win);
      byConv.set(row.convId!, win);
      continue;
    }
    out.set(row.key, row);
    if (row.convId) byConv.set(row.convId, row);
  }

  for (const r of logRows || []) {
    if (!r || !r.session_id) continue;
    const conv = String(r.session_id);
    const firstMs = isoMs(r.first_seen), lastMs = isoMs(r.last_seen);
    const owner = byConv.get(conv);
    if (owner) {
      if (r.trashed_at) { out.delete(owner.key); byConv.delete(conv); continue; }   // 두 이름 중 한쪽에만 표식이 있어도 그 세션은 휴지통이다
      owner.node = String(r.node_id || '');
      //  박스 이름이 id 그대로면(이름을 안 지은 세션) 기록이 아는 이름을 쓴다.
      if (isIdLabel(owner.name) && r.name) owner.name = String(r.name);
      owner.bytes = Number(r.bytes) || 0;
      owner.title = r.title ? String(r.title) : null;
      //  되살린 박스의 created 는 다시 연 때다 — 이른 쪽이 «만든 때», 늦은 쪽이 «마지막 활동».
      if (firstMs && (!owner.firstMs || firstMs < owner.firstMs)) owner.firstMs = firstMs;
      if (lastMs > owner.lastMs) owner.lastMs = lastMs;
      owner.recMs = lastMs;
      owner.recProjectId = r.project_id != null ? Number(r.project_id) : null;
      owner.recProjectName = r.project_id != null ? (r.project_name ? String(r.project_name) : (projNames.get(Number(r.project_id)) ?? null)) : null;
      if (owner.projectId == null && r.project_id != null) owner.projectId = Number(r.project_id);
      if (owner.projectId != null && !owner.projectName) owner.projectName = projNames.get(owner.projectId) ?? null;
      continue;
    }
    if (r.trashed_at || trashedConv.has(conv) || out.has(conv)) continue;
    out.set(conv, {
      key: conv, name: String(r.name || r.title || conv), boxId: null, convId: conv, node: String(r.node_id || ''),
      projectId: r.project_id != null ? Number(r.project_id) : null, projectName: r.project_name ? String(r.project_name) : null,
      recProjectId: r.project_id != null ? Number(r.project_id) : null, recProjectName: r.project_id != null && r.project_name ? String(r.project_name) : null,
      stateKey: 'log', stateLabel: '기록만', alive: false, live: false, mine: true,
      lastMs, recMs: lastMs, firstMs, bytes: Number(r.bytes) || 0, harness: r.harness ? String(r.harness) : null, title: r.title ? String(r.title) : null,
    });
  }
  const rows = [...out.values()].sort((a, b) => b.lastMs - a.lastMs);
  //  끝내 이름이 id 뿐인 줄(이름을 안 지었고 기록도 이름을 모른다)은 그렇다고 적는다 — uuid 를 이름 자리에 걸지 않는다.
  for (const r of rows) if (isIdLabel(r.name)) r.name = '이름 없는 세션';
  return rows;
}

/** 읽을 기록이 있는 줄인가 — 중앙에 올라온 대화가 있다. 대화 찾기 · 작업 일지 · 사이드바는 이런 줄만 센다(박스만 있고 기록이 없는 세션은 「세션 목록」 탭에만 선다). */
export const hasRecord = (r: HistRow): boolean => r.bytes > 0 && !!r.convId;
/** 이 줄의 프로젝트 — 기록이 있는 줄은 기록의 것(없으면 «없음»), 기록이 없는 줄은 박스의 것. name 은 화면에 적을 글(이름을 모르면 #번호, 없으면 빈 글). */
export function rowProject(r: HistRow): { id: number | null; name: string } {
  const id = hasRecord(r) ? r.recProjectId : r.projectId;
  const name = hasRecord(r) ? r.recProjectName : r.projectName;
  return { id, name: name || (id != null ? '#' + id : '') };
}

export type HistFilter = 'all' | 'live' | 'off' | 'rec';
/**
 * 「전체 · 실행 중 · 오프라인 · 기록만」.
 *  실행 중 = 지금 쓰이는 것(확인 필요·작업 중·작업 완료·대기 중). 오프라인 = 박스는 있지만 아무도 안 보고 있거나 그 컴퓨터가 안 닿는 것
 *  (셸만 남은 것도 여기). 기록만 = 박스가 없는 것(중단됨·종료됨·기록만 남은 것) 중 읽을 기록이 있는 것.
 *  ⚠ 「실행 중」에 오프라인을 넣지 않는다 — 실측(매니지드, 한 사람): 박스가 남은 세션 136 중 지금 쓰이는 것은 16 이었다.
 */
export function histFilter(rows: HistRow[], f: HistFilter): HistRow[] {
  if (f === 'live') return rows.filter((r) => r.live);
  if (f === 'off') return rows.filter((r) => r.alive && !r.live);
  if (f === 'rec') return rows.filter((r) => !r.alive && !!r.convId);
  return rows;
}

// ── 「작업 일지」 탭 ──────────────────────────────────────────────────────────────────────────────
export interface JKnowledge { name: string; title: string | null }
export interface JActivity { id: number; type: string; title: string; summary: string | null; at: string | null; commit: boolean; knowledge: JKnowledge[] }
export interface JTask { id: number; name: string; status: string | null; project_id: number | null }
export interface JRow {
  node_id: string; session_id: string; name: string | null; title: string | null; harness: string | null;
  first_seen: string; last_seen: string; bytes: number;
  project_id: number | null; project_name: string | null; box_id: string | null;
  asks: number; edits: number;
  activities: JActivity[]; knowledge: JKnowledge[]; tasks: JTask[];
  /** 이 기간보다 앞서 적은 작업 기록 수(지난 기간부터 이어진 세션). */
  activities_before?: number;
}

export type JournalPreset = 'week' | 'last-week' | 'd30';
export const JOURNAL_PRESETS: ReadonlyArray<{ key: JournalPreset; label: string }> = [
  { key: 'week', label: '이번 주' },
  { key: 'last-week', label: '지난 주' },
  { key: 'd30', label: '최근 30일' },
];
const md = (ms: number): string => { const d = new Date(ms); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
/** 이번 주 월요일 0시(현지). 주는 월요일에 시작한다 — 달력으로 센다(서머타임 날에도 0시에 선다). */
export function weekStart(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
const addDays = (ms: number, n: number): number => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
/** 일지 기간 — since ≤ 마지막 활동 < until. until 이 null 이면 지금까지. label 은 사람이 읽는 범위(끝 날짜 포함). */
export function journalRange(p: JournalPreset, nowMs: number): { since: number; until: number | null; label: string } {
  if (p === 'd30') { const s = daysAgoStart(nowMs, 29); return { since: s, until: null, label: `${md(s)} ~ ${md(nowMs)}` }; }
  const mon = weekStart(nowMs);
  const since = p === 'last-week' ? addDays(mon, -7) : mon;
  const until = addDays(since, 7);
  return { since, until, label: `${md(since)} ~ ${md(addDays(since, 6))}` };
}

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const pad2 = (n: number): string => (n < 10 ? '0' : '') + n;
const dayKey = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
/** 날짜 묶음 머리글 — 「오늘 · 10월 4일 (일)」 · 「어제 · 10월 3일 (토)」 · 「10월 1일 (목)」. */
export function dayLabel(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})`;
  const day = dayStart(ms);
  if (day === daysAgoStart(nowMs, 0)) return '오늘 · ' + base;
  if (day === daysAgoStart(nowMs, 1)) return '어제 · ' + base;
  return base;
}

export type JournalMode = 'day' | 'project';
export interface JournalGroup { key: string; label: string; rows: JRow[] }
/**
 * 일지 묶음. 날짜별 = 마지막 활동의 현지 날짜(늦은 날이 위). 프로젝트별 = 지금 붙어 있는 프로젝트(최근에 일한 프로젝트가 위,
 *  「프로젝트 없음」은 맨 아래). 묶음 안은 마지막 활동이 늦은 줄이 위다.
 */
export function journalGroups(rows: JRow[], mode: JournalMode, nowMs: number): JournalGroup[] {
  const last = (r: JRow): number => isoMs(r.last_seen);
  const groups = new Map<string, JournalGroup & { at: number; none: boolean }>();
  for (const r of rows) {
    const none = mode === 'project' && r.project_id == null;
    const key = mode === 'day' ? dayKey(last(r)) : (none ? 'p:0' : 'p:' + r.project_id);
    const label = mode === 'day' ? dayLabel(last(r), nowMs) : (none ? NO_PROJECT_NAME : String(r.project_name || '#' + r.project_id));
    const g = groups.get(key) ?? { key, label, rows: [], at: 0, none };
    g.rows.push(r);
    if (last(r) > g.at) g.at = last(r);
    groups.set(key, g);
  }
  const list = [...groups.values()];
  for (const g of list) g.rows.sort((a, b) => last(b) - last(a));
  list.sort((a, b) => (a.none !== b.none ? (a.none ? 1 : -1) : b.at - a.at));
  return list.map((g) => ({ key: g.key, label: g.label, rows: g.rows }));
}

export interface JournalStats { sessions: number; projects: number; activities: number; knowledge: number; tasks: number; commits: number }
/** 기간 합계 — 같은 것이 여러 줄에 있어도 한 번만 센다(같은 박스의 대화 둘이 한 태스크를 맡는 경우 등). */
export function journalStats(rows: JRow[]): JournalStats {
  const proj = new Set<number>(), act = new Set<number>(), kn = new Set<string>(), tk = new Set<number>(), cm = new Set<number>();
  for (const r of rows) {
    if (r.project_id != null) proj.add(r.project_id);
    for (const a of r.activities) { act.add(a.id); if (a.commit) cm.add(a.id); }
    for (const k of r.knowledge) kn.add(k.name);
    for (const t of r.tasks) tk.add(t.id);
  }
  return { sessions: rows.length, projects: proj.size, activities: act.size, knowledge: kn.size, tasks: tk.size, commits: cm.size };
}

// ── 일지 옆 칸(기간 요약) — 하루하루 · 프로젝트 · 만든 지식 · 태스크 ─────────────────────────────────
export interface JournalDay { key: string; ms: number; label: string; weekday: string; n: number; today: boolean }
const JOURNAL_DAYS_MAX = 62;
/**
 * 기간의 하루하루 — 날마다 «그날이 마지막 활동인 세션» 수(일지의 날짜 묶음과 같은 셈). 기간의 끝이 열려 있으면(until null)
 *  오늘까지다. 세션이 없는 날도 0 으로 선다(막대 줄에 빈 날이 보여야 한다). 달력으로 센다(서머타임 날에도 하루에 한 칸).
 *  칸은 62개까지 — 그보다 긴 기간은 끝에서부터 62일을 보인다.
 */
export function journalDayBars(rows: JRow[], since: number, until: number | null, nowMs: number): JournalDay[] {
  const end = until == null ? addDays(dayStart(nowMs), 1) : until;
  const counts = new Map<string, number>();
  for (const r of rows) { const k = dayKey(isoMs(r.last_seen)); counts.set(k, (counts.get(k) || 0) + 1); }
  const today = dayKey(nowMs);
  const out: JournalDay[] = [];
  //  상한보다 긴 기간이면 **늦은 날**을 남긴다 — 이른 날부터 세면 오늘이 잘린다.
  let start = dayStart(since);
  const floor = addDays(dayStart(end - 1), -(JOURNAL_DAYS_MAX - 1));
  if (floor > start) start = floor;
  for (let d = start; d < end && out.length < JOURNAL_DAYS_MAX; d = addDays(d, 1)) {
    const k = dayKey(d), dt = new Date(d);
    out.push({ key: k, ms: d, label: `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WEEKDAY[dt.getDay()]})`, weekday: WEEKDAY[dt.getDay()]!, n: counts.get(k) || 0, today: k === today });
  }
  return out;
}
export interface JournalProject { id: number | null; key: string; name: string; sessions: number; activities: number }
/** 프로젝트마다 세션 수 · 적은 기록 수 — 세션이 많은 프로젝트가 위(같으면 기록이 많은 쪽), 「프로젝트 없음」은 맨 아래. key 는 일지 묶음의 열쇠와 같다. */
export function journalProjects(rows: JRow[]): JournalProject[] {
  const by = new Map<string, JournalProject & { acts: Set<number> }>();
  for (const r of rows) {
    const none = r.project_id == null;
    const key = none ? 'p:0' : 'p:' + r.project_id;
    const g = by.get(key) ?? { id: none ? null : r.project_id!, key, name: none ? NO_PROJECT_NAME : String(r.project_name || '#' + r.project_id), sessions: 0, activities: 0, acts: new Set<number>() };
    g.sessions++;
    for (const a of r.activities) g.acts.add(a.id);
    by.set(key, g);
  }
  const list = [...by.values()].map(({ acts, ...g }) => ({ ...g, activities: acts.size }));
  list.sort((a, b) => ((a.id == null) !== (b.id == null) ? (a.id == null ? 1 : -1) : b.sessions - a.sessions || b.activities - a.activities || a.name.localeCompare(b.name, 'ko')));
  return list;
}
/** 기간에 만든 지식 — 겹치지 않게, 늦게 일한 세션의 것부터. */
export function journalKnowledgeList(rows: JRow[]): JKnowledge[] {
  const seen = new Set<string>(), out: JKnowledge[] = [];
  for (const r of [...rows].sort((a, b) => isoMs(b.last_seen) - isoMs(a.last_seen))) for (const k of r.knowledge) { if (seen.has(k.name)) continue; seen.add(k.name); out.push(k); }
  return out;
}
/** 기간에 맡은 태스크 — 겹치지 않게, 늦게 일한 세션의 것부터. */
export function journalTaskList(rows: JRow[]): JTask[] {
  const seen = new Set<number>(), out: JTask[] = [];
  for (const r of [...rows].sort((a, b) => isoMs(b.last_seen) - isoMs(a.last_seen))) for (const t of r.tasks) { if (seen.has(t.id)) continue; seen.add(t.id); out.push(t); }
  return out;
}

/**
 * 줄의 «한 일» 한 줄. 세션이 (이 기간에) 적은 작업 기록이 있으면 **가장 늦은 기록의 제목**(마무리 기록이 그 세션을 가장 잘
 *  말한다), 이 기간엔 없고 앞선 기간에만 있으면 그 수(earlier — «기록 없음» 이라고 틀리게 말하지 않는다), 아예 없으면 첫 지시.
 *  무엇에서 온 말인지(source)를 함께 준다 — 화면이 «기록» 과 «시킨 말» 을 다르게 그린다(지어낸 요약이 아니다).
 */
export function journalHeadline(r: JRow): { text: string; source: 'activity' | 'earlier' | 'prompt' | 'none'; more: number } {
  if (r.activities.length) {
    const lastAct = r.activities[r.activities.length - 1]!;
    return { text: lastAct.title || lastAct.summary || '', source: 'activity', more: r.activities.length - 1 };
  }
  if ((r.activities_before || 0) > 0) return { text: '', source: 'earlier', more: r.activities_before || 0 };
  const t = String(r.title || '').trim();
  return t ? { text: t, source: 'prompt', more: 0 } : { text: '', source: 'none', more: 0 };
}

/** 주간 보고에 붙여 넣을 글 — 프로젝트별로 한 일을 한 줄씩. 작업 기록이 없는 세션은 이름과 «(기록 없음)». */
export function journalCopyText(rows: JRow[], rangeLabel: string, nowMs: number): string {
  const st = journalStats(rows);
  const lines: string[] = [
    `작업 일지 · ${rangeLabel}`,
    `세션 ${st.sessions} · 프로젝트 ${st.projects} · 한 일 ${st.activities} · 지식 ${st.knowledge} · 태스크 ${st.tasks}`,
  ];
  const seen = new Set<number>();
  for (const g of journalGroups(rows, 'project', nowMs)) {
    const body: string[] = [];
    //  묶음 안은 화면과 달리 **이른 것부터** — 보고는 한 순서대로 읽는다.
    for (const r of [...g.rows].reverse()) {
      if (!r.activities.length) { body.push(`- ${r.name || r.title || '이름 없는 세션'} (${(r.activities_before || 0) > 0 ? '이 기간에 적은 기록 없음' : '기록 없음'})`); continue; }
      for (const a of r.activities) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        const kn = a.knowledge.map((k) => k.title || k.name);
        body.push(`- ${a.title || a.summary || '(제목 없음)'}${kn.length ? ` (지식: ${kn.join(', ')})` : ''}`);
      }
    }
    if (body.length) lines.push('', `[${g.label}]`, ...body);
  }
  return lines.join('\n');
}

// ── 「대화 찾기」 탭 — 맞은 말이 대화록의 어느 자리인가 ──────────────────────────────────────────────
//  대화록 화면은 사람 말마다 턴을 끊고(turn-<n>), 그 턴의 AI 답을 블록 단위로 건다(ln-<n>-a<i>-<b>). 검색 결과는 말의
//  (말한 쪽 · 시각)을 준다 — 같은 시각의 같은 쪽 말을 찾아 그 자리의 앵커를 돌려준다. 시각으로 못 찾으면(색인과 대화록이
//  시각을 다르게 읽은 옛 기록) 낱말이 든 첫 자리로 간다. 그것도 없으면 null.
export interface TurnItem { role: string; text: string; ts?: string }
export interface TurnLike { user: TurnItem | null; ai: TurnItem[] }
export interface HitRef { role: 'user' | 'assistant'; ts: string | null }
export function hitAnchor(turns: TurnLike[], hit: HitRef | null, words: string[]): { q: string; ln: string } | null {
  const want = hit && hit.ts ? Date.parse(hit.ts) : NaN;
  const low = words.map((w) => String(w || '').toLowerCase()).filter(Boolean);
  const has = (text: string): boolean => { const t = text.toLowerCase(); return low.some((w) => t.includes(w)); };
  const sameTs = (ts?: string): boolean => Number.isFinite(want) && !!ts && Date.parse(ts) === want;
  const aiTexts = (t: TurnLike): TurnItem[] => t.ai.filter((x) => x.role === 'assistant' && !!x.text);
  const at = (i: number, ai: number): { q: string; ln: string } => ({ q: String(i), ln: ai < 0 ? '' : `${i}-a${ai}-0` });

  if (hit && Number.isFinite(want)) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!;
      if (hit.role === 'user') { if (t.user && sameTs(t.user.ts)) return at(i, -1); continue; }
      const ai = aiTexts(t);
      //  한 줄(JSONL)의 글 블록들은 시각이 같다 — 그 가운데 낱말이 든 블록, 없으면 첫 블록.
      const same = ai.map((x, k) => ({ x, k })).filter((p) => sameTs(p.x.ts));
      if (same.length) return at(i, (same.find((p) => has(p.x.text)) ?? same[0]!).k);
    }
  }
  if (!low.length) return null;
  const order: Array<'user' | 'assistant'> = hit && hit.role === 'assistant' ? ['assistant', 'user'] : ['user', 'assistant'];
  for (const role of order) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!;
      if (role === 'user') { if (t.user && has(t.user.text)) return at(i, -1); continue; }
      const k = aiTexts(t).findIndex((x) => has(x.text));
      if (k >= 0) return at(i, k);
    }
  }
  return null;
}

/** 글에서 낱말이 든 자리들 — [시작, 끝) 을 겹치지 않게 합쳐 앞에서부터. 대소문자를 가리지 않는다. 낱말이 없으면 빈 배열. */
export function markRanges(text: string, words: string[]): Array<[number, number]> {
  const src = String(text || '');
  const low = src.toLowerCase();
  const raw: Array<[number, number]> = [];
  for (const w0 of words) {
    const w = String(w0 || '').toLowerCase();
    if (!w) continue;
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) raw.push([i, i + w.length]);
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const r of raw) {
    const prev = out[out.length - 1];
    if (prev && r[0] <= prev[1]) { if (r[1] > prev[1]) prev[1] = r[1]; }
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** 가로탭 — 주소의 ?tab= 값. 모르는 값은 첫 탭. */
export type HistTab = 'find' | 'journal' | 'list';
export const HIST_TABS: ReadonlyArray<{ key: HistTab; label: string; hint: string; icon: string }> = [
  { key: 'find', label: '대화 찾기', hint: '지난 대화에서 그 말을 찾아 그 자리로 갑니다', icon: 'search' },
  { key: 'journal', label: '작업 일지', hint: '언제 무슨 일을 했고 무엇이 남았는지 봅니다', icon: 'timeline' },
  { key: 'list', label: '세션 목록', hint: '실행 중인 세션과 기록만 남은 세션을 한 목록으로 봅니다', icon: 'list' },
];
export const readHistTab = (v: unknown): HistTab => (v === 'journal' || v === 'list' ? v : 'find');
