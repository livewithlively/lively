// lib/trash-tabs.ts — 휴지통 네 탭(#3778, 원준 2026-09-20 "AI 세션, 프로젝트, 자료, 지식으로 하드하게 나누어지도록 … D로")의 잣대.
//  순수 함수만 둔다(DOM·fetch 없음) — scripts/trash-tabs.test.mjs 가 값으로 지킨다. 화면(v2/bins.ts)은 여기서 고른 것을 그릴 뿐이다.
//
//  ★ 재료가 네 곳에서 온다. 탭 하나가 한 곳과 1:1 이 아니다:
//   · AI 세션  = 세션 목록의 «따로 버린» 세션(org_session_trash, 묶음 표식 없음)
//   · 프로젝트 = project.trashed_at(세션까지 통째로 돌아온다) ＋ 감사 스냅샷의 project(옛 길로 지운 것 — 이름·본문만 돌아온다)
//   · 자료     = 파일을 지워 숨김 자리에 보관한 자료(파일까지 돌아온다) ＋ 감사 스냅샷의 source(본문만 돌아온다)
//   · 지식     = 감사 스냅샷의 knowledge
//  «얼마나 돌아오나» 가 출처마다 달라서, 합치되 출처(origin)를 줄마다 들고 다닌다 — 화면이 그 차이를 말해야 한다(#1582).

export type TrashTab = 'sess' | 'proj' | 'src' | 'know';

export const TRASH_TABS: ReadonlyArray<{ key: TrashTab; label: string; unit: string; back: string }> = [
  { key: 'sess', label: 'AI 세션', unit: '세션', back: '되돌리기' },
  { key: 'proj', label: '프로젝트', unit: '프로젝트', back: '복원' },
  { key: 'src', label: '자료', unit: '자료', back: '복원' },
  { key: 'know', label: '지식', unit: '지식', back: '복원' },
];

export const isTrashTab = (v: unknown): v is TrashTab => v === 'sess' || v === 'proj' || v === 'src' || v === 'know';

/** GET /api/ui/deleted 의 한 줄(감사 스냅샷 휴지통). locked = 공개범위 제한으로 관리자에게 메타만 보이는 줄. */
export interface DeletedEntry {
  entity: string; key: string; label: string; at: string; actor: string | null;
  level?: string | null; kind?: string | null; doc_type?: string | null; locked?: boolean;
}

/** GET /api/ui/source-trash 의 한 줄(파일을 지워 보관해 둔 자료). */
export interface TrashedFile {
  id: number; title: string; path: string; ext: string; bytes: number;
  project_id: number | null; at: string; by: string | null; has_knowledge: boolean;
}

// ── 날짜 묶음 — 오늘 · 어제 · 이번 주(7일) · 이전. 자정 기준(그 지역). ──────────────────────────────
export function bucketOf(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '이전';
  const day = (ms: number): number => { const x = new Date(ms); return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  return diff <= 0 ? '오늘' : diff === 1 ? '어제' : diff < 7 ? '이번 주' : '이전';
}

// ── 자료 ─────────────────────────────────────────────────────────────────────────────────────────
const KIND_LABEL: Record<string, string> = {
  slack: '슬랙 대화', discord: '디스코드 대화', transcript: '전사록', minutes: '회의록', email: '메일',
  github_issue: '깃허브 이슈', linear_issue: '리니어 이슈', figma_comment: '피그마 댓글', local_file: '파일', other: '자료',
};
/** 자료 종류의 사람 말 — 모르는 종류는 '자료'(종류 키를 그대로 내보이지 않는다). */
export const kindLabel = (kind: string | null | undefined): string => KIND_LABEL[String(kind || '')] || '자료';

/** 썸네일 자리에 적을 확장자 글자 — 없으면 경로에서, 그래도 없으면 'FILE'. 길면 6자에서 자른다(칸이 좁다). */
export function extLabel(ext: string | null | undefined, path: string | null | undefined): string {
  let e = String(ext || '').replace(/^\./, '');
  if (!e) { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(path || '')); e = m ? m[1] : ''; }
  return (e || 'file').toUpperCase().slice(0, 6);
}

export interface SrcItem {
  key: string;                 // 'f:<id>'(파일 보관) | 'a:<id>'(감사 스냅샷)
  origin: 'file' | 'audit';
  id: number; title: string; badge: string; sub: string; at: string;
  projectId: number | null; bytes: number; hasKnowledge: boolean;
}

/** 자료 탭의 한 목록 — 두 출처를 버린 순서로 섞는다. 잠긴 줄(locked)은 뺀다(되살릴 수도 지울 수도 없는 줄은 세우지 않는다). */
export function srcItems(deleted: ReadonlyArray<DeletedEntry>, files: ReadonlyArray<TrashedFile>): SrcItem[] {
  const out: SrcItem[] = [];
  for (const f of files) {
    const id = Number(f.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    out.push({
      key: 'f:' + id, origin: 'file', id, title: f.title || f.path || `자료 #${id}`, badge: extLabel(f.ext, f.path),
      sub: f.path || '', at: String(f.at || ''), projectId: f.project_id ?? null, bytes: Number(f.bytes) || 0, hasKnowledge: !!f.has_knowledge,
    });
  }
  for (const d of deleted) {
    if (d.entity !== 'source' || d.locked) continue;
    const id = Number(d.key);
    if (!Number.isFinite(id) || id <= 0) continue;
    //  같은 자료가 두 출처에 다 있을 수는 없다(파일 보관은 행이 살아 있고, 감사 휴지통은 행이 없다) — 그래도 키가 달라 겹쳐도 안 터진다.
    //  파일 자료는 종류(«파일») 대신 확장자를 적는다 — 격자에서 서로를 가르는 것은 확장자다(실측: 「파일」만 열한 장이 나란히 섰다).
    out.push({
      key: 'a:' + id, origin: 'audit', id, title: d.label || `자료 #${id}`, badge: d.kind === 'local_file' ? extLabel('', d.label) : kindLabel(d.kind),
      sub: kindLabel(d.kind), at: String(d.at || ''), projectId: null, bytes: 0, hasKnowledge: false,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ── 지식 · 옛 길로 지운 프로젝트 ─────────────────────────────────────────────────────────────────
export const knowItems = (deleted: ReadonlyArray<DeletedEntry>): DeletedEntry[] =>
  deleted.filter((d) => d.entity === 'knowledge' && !d.locked).sort((a, b) => String(b.at).localeCompare(String(a.at)));

/** 옛 길(하드 삭제)로 지운 프로젝트·태스크 — 이름·본문만 되살릴 수 있는 줄. level 이 없으면 프로젝트로 본다(옛 스냅샷). */
export const auditProjItems = (deleted: ReadonlyArray<DeletedEntry>): DeletedEntry[] =>
  deleted.filter((d) => d.entity === 'project' && !d.locked).sort((a, b) => String(b.at).localeCompare(String(a.at)));

export const levelLabel = (level: string | null | undefined): string =>
  level === 'task' ? '태스크' : level === 'subtask' ? '하위 태스크' : '프로젝트';

// ── AI 세션 — 있던 프로젝트로 묶는다 ─────────────────────────────────────────────────────────────
export interface SessGroup<T> { id: number; name: string; rows: T[] }
/**
 * 버린 세션을 «있던 프로젝트» 로 묶는다. 묶음 순서 = 그 묶음에서 가장 최근에 버린 것 순, 「프로젝트 없음」(id 0)은 늘 맨 끝.
 *  rows 는 들어온 순서를 지킨다(호출자가 버린 순서로 정렬해 준다).
 */
export function groupByProject<T>(rows: ReadonlyArray<T>, pidOf: (r: T) => number | null | undefined, nameOf: (pid: number) => string): SessGroup<T>[] {
  const map = new Map<number, SessGroup<T>>();
  for (const r of rows) {
    const pid = Number(pidOf(r)) || 0;
    let g = map.get(pid);
    if (!g) { g = { id: pid, name: pid ? nameOf(pid) : '프로젝트 없음', rows: [] }; map.set(pid, g); }
    g.rows.push(r);
  }
  const out = Array.from(map.values());
  const none = out.filter((g) => g.id === 0);
  return [...out.filter((g) => g.id !== 0), ...none];
}

// ── 찾기 · 개수 · 처음 설 탭 ─────────────────────────────────────────────────────────────────────
/** 이름 찾기 — 빈 검색어는 전부 통과. 대소문자 무시, 앞뒤 공백 무시. */
export function matchesQuery(q: string, ...hay: Array<string | null | undefined>): boolean {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  return hay.some((h) => String(h || '').toLowerCase().includes(needle));
}

export interface TabCounts { sess: number; proj: number; src: number; know: number }

/**
 * 처음 설 탭. 기억한 탭이 있으면 그 탭(비어 있어도 — 사람이 고른 자리다). 없으면 **무언가 든 첫 탭**, 다 비었으면 'sess'.
 *  ⚠ «가장 최근에 버린 것이 있는 탭» 으로 하지 않는다 — 열 때마다 서는 자리가 바뀌면 탭이 자리를 잃는다.
 */
export function pickInitialTab(saved: unknown, counts: TabCounts): TrashTab {
  if (isTrashTab(saved)) return saved;
  for (const t of TRASH_TABS) if (counts[t.key] > 0) return t.key;
  return 'sess';
}

/** 접어 둘까 — 프로젝트 안의 세션 목록. 사람이 편/접은 기록이 있으면 그대로, 없으면 1~5개일 때만 편다(0개는 펼 것이 없다). */
export function bundleOpen(bundleN: number, userChoice: boolean | undefined): boolean {
  if (userChoice !== undefined) return userChoice && bundleN > 0;
  return bundleN > 0 && bundleN <= 5;
}
