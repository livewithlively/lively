// lib/board-view.ts — 프로젝트 보드 첫 화면의 잣대 셋(#4865) — 순수 함수.
//  화면 코드(projects/state.ts · board.ts · session-list.ts) 안에 두면 core.js 를 끌어 Node 에서 값으로 시험할 수 없다
//  (scripts/project-list-view-4865.test.mjs). 그래서 분기 있는 판정만 여기 둔다.

/** 저장소에서 읽은 스코프 뷰를 새 형식으로 — sessions 를 채워 돌려준다(없던 기억이면 null 그대로).
 *  ⚠ 읽는 자리(projects/state.ts pjvLoadScopeView)에서만 쓴다. 코드가 직접 만든 뷰 객체에 걸면 sessions 가 없다는 이유로 세션 뷰로 샌다. */
export function migrateStoredView<T extends Record<string, unknown>>(v: T | null | undefined): (T & { sessions: boolean }) | null {
  if (!v || typeof v !== 'object') return null;
  return { ...v, sessions: viewOpensSessions(v) };
}

/** 기억된 스코프 뷰 → 「리스트」(세션) 뷰로 여나.
 *  · 기억이 없으면 연다 — 기본 뷰가 리스트다(원준 2026-10-17 «디폴트를 리스트뷰가 보이게»).
 *  · 새 형식(sessions 가 적힌 기억)은 그 값을 따른다.
 *  · #4865 이전 기억(sessions 가 없음)은 칸반 · 테이블 · 타임라인 · 개요 · 저장된 뷰였으면 그대로 두고, 아니면 옛 「리스트」였으니 새 리스트로 연다. */
export function viewOpensSessions(v: { sessions?: unknown; kanban?: unknown; table?: unknown; timeline?: unknown; overview?: unknown; savedViewId?: unknown } | null | undefined): boolean {
  if (!v) return true;
  if (v.sessions != null) return !!v.sessions;
  return !(v.kanban || v.table || v.timeline || v.overview || v.savedViewId != null);
}

/** 내가 맡은 프로젝트인가 — 만든 사람이거나 팀원. 서버 mine=1(project-store listProjects viewer)과 같은 술어.
 *  members 줄은 {member_id} 객체와 id 문자열 둘 다 온다. 내 id 를 모르면 아무것도 내 것이 아니다(빈 id 끼리 같다고 보지 않는다). */
export function isMyProject(p: { created_by?: unknown; members?: unknown } | null | undefined, meId: string): boolean {
  if (!p || !meId) return false;
  if (String(p.created_by ?? '') === meId) return true;
  const ms = Array.isArray(p.members) ? p.members : [];
  return ms.some((m: any) => String(m && typeof m === 'object' ? (m.member_id ?? '') : m) === meId);
}

/** 프로젝트별 «내 세션» 수 — 내가 주인이고 지금 살아 있는(박스가 도는) 세션만. 기록만 남은 것 · 남의 것 · 프로젝트 없는 것은 세지 않는다.
 *  종전 서버 mine=1 이 tmux 목록에서 세던 것(owned · projectId)과 같은 셈이다. */
export function countMyLiveSessions(rows: ReadonlyArray<{ live?: boolean; alive?: boolean; owned?: boolean; projectId?: number | null }> | null | undefined): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of rows || []) {
    const pid = Number(s.projectId) || 0;
    if (!s.live || !s.alive || !s.owned || !pid) continue;
    m.set(pid, (m.get(pid) || 0) + 1);
  }
  return m;
}
