// 휴지통으로 보낸 세션을 목록 재료에 비추는 세 가지(#3870) — 순수 함수. 셸(main.ts)의 watchSessionTrash 가 쓴다.
//  규칙이 틀리면 버린 세션이 다시 서거나(표식 누락), 안 버린 세션이 사라진다(이름 오판). 그래서 값으로 검증한다
//  (scripts/write-hold.test.mjs T 절).
//
//  한 세션의 이름은 여럿이다 — 박스 id · 대화 uuid(logId) · 되살리기 전 옛 박스 id(altIds). 휴지통 표식은 어느 이름으로
//   보내도 그 세션의 것이고(views.ts mergeSessions), 서버는 보낸 이름 가운데 일부만 받을 수 있다(대화 기록이 없는 박스의 uuid 등).

export interface TrashSessLike { id: string; logId?: string | null; altIds?: string[]; trashedAt?: string | null }
export interface TrashLiveRow { id?: unknown; claudeSessionId?: unknown; trashedAt?: unknown }
export interface TrashLogRow { session_id?: unknown; trashed_at?: unknown }

/** 그 세션의 이름 가운데 하나라도 ids 에 있나. */
export function sessNamedIn(s: TrashSessLike, ids: ReadonlySet<string>): boolean {
  return ids.has(s.id) || (!!s.logId && ids.has(s.logId)) || (s.altIds || []).some((x) => ids.has(x));
}

/** 붙든 표식(at)을 세션 목록에 덧씌운다 — 이미 표식이 있는 세션(서버가 먼저 말했다)은 건드리지 않는다. */
export function markTrashed<S extends TrashSessLike>(sessions: S[], ids: ReadonlySet<string>, at: string): void {
  for (const s of sessions) if (!s.trashedAt && sessNamedIn(s, ids)) s.trashedAt = at;
}

/** 내가 붙인 표식(at)만 뗀다 — 서버가 붙인 표식은 그대로 둔다. */
export function unmarkTrashed<S extends TrashSessLike>(sessions: S[], at: string): void {
  for (const s of sessions) if (s.trashedAt === at) s.trashedAt = null;
}

/**
 * 서버가 받은 이름(got)으로, **받아 둔 답**(라이브 · 기록 행)에 표식을 적는다.
 *  기록 축은 매 판 최근 200건만 다시 받고 그보다 오래된 줄은 5분마다 오는 깊은 판이 지킨다(log-rows.ts mergeLogRows) —
 *  오래된 기록만 남은 세션은 그 캐시에 표식 없이 남아, 붙든 것을 놓는 순간 다시 섰다가 깊은 판이 올 때에야 빠진다.
 */
export function stampTrashedRows(live: TrashLiveRow[], logs: TrashLogRow[], got: ReadonlySet<string>, at: string): void {
  for (const r of live) if (r && !r.trashedAt && (got.has(String(r.id)) || (!!r.claudeSessionId && got.has(String(r.claudeSessionId))))) r.trashedAt = at;
  for (const r of logs) if (r && !r.trashed_at && got.has(String(r.session_id))) r.trashed_at = at;
}

/**
 * 서버가 받은 이름으로 버려진 세션들의 **창 키**(`sess:<이름>` — 그 세션의 모든 이름으로).
 *  ⚠ 표식의 값이 아니라 이름으로 고른다 — 서버 답보다 먼저 도착한 읽기가 서버의 표식을 실어 오면 내 표식(at)은 안 붙는다.
 */
export function trashedTabKeys(sessions: TrashSessLike[], got: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const s of sessions) {
    if (!s.trashedAt || !sessNamedIn(s, got)) continue;
    for (const x of [s.id, s.logId || '', ...(s.altIds || [])]) if (x) out.add('sess:' + x);
  }
  return [...out];
}
