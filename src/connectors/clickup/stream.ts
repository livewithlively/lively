// ClickUp 무손실 스트림(#1313 R22 분할 — 구 clickup.ts 1056-1184).
import type { RawItem } from "../types.js";
import type { ClickUpList, ClickUpTask } from "./types.js";
import {
  enumerateHierarchy, fetchListTasks, fetchTeamTasks, fetchTimeEntries,
  getExcludedListIds, getIncludedListIds, getTaskComments, getTaskFull, getTeam,
} from "./api.js";
import {
  commentToRawItem, folderToRawItem, listToRawItem, spaceToRawItem,
  timeEntryToRawItem, toRawItem, viewToRawItem,
} from "./transform.js";
import type { ToRawItemCtx } from "./transform.js";

// ══════════════════════════════════════════════════════════════════════════
// ── 무손실 스트림(#541) — 계층(Space→Folder→List→View) → 태스크(hydration·부모우선·미지 서브태스크 수렴)
//    → 태스크별 댓글 → 팀 타임엔트리. run-sync --full(전체)·run-sync(증분) 공용 단일 경로.
//  · 계층은 since 무관 매 run 재수집(멱등 upsert·저비용) — 커스텀상태/뷰 변경이 항상 수렴.
//  · 태스크는 hydration(getTaskFull) 필수 — markdown_description(서식)·attachments·custom_fields 값·subtasks 는
//    리스트 나열 응답에 없다. 태스크당 1콜 + 댓글 1콜(rate 100/min 은 clickupFetch 선제대기가 흡수).
//  · yield 순서가 미러의 부모 해소를 보장: 컨테이너 먼저, 태스크는 부모 먼저(위상), 댓글은 귀속 태스크 뒤.
// ══════════════════════════════════════════════════════════════════════════
export interface LosslessOpts {
  sinceMs?: number;       // 증분 — 태스크 date_updated_gt(계층·뷰는 항상 재수집)
  comments?: boolean;     // 기본 true
  timeEntries?: boolean;  // 기본 true
  hydrate?: boolean;      // 기본 true(false=얕은 나열만 — 디버그용)
  /** 수집(fetch) 실패 집계 — 소비자(run-sync)가 커서 동결 판정에 사용('커서는 모든 단계 성공 후에만 전진' 불변식).
   *  스트림 내부 catch 는 부분 수집을 계속하되(가능한 만큼 적재) 여기에 실패를 남긴다 — 삼키고 성공 위장 금지. */
  stats?: { fetchFailures: number };
}

export async function* losslessStream(opts?: LosslessOpts): AsyncIterable<RawItem> {
  const team = await getTeam();
  const teamId = team.id;
  const ctx: ToRawItemCtx = { teamId };
  const withComments = opts?.comments !== false;
  const withTime = opts?.timeEntries !== false;
  const doHydrate = opts?.hydrate !== false;
  const stats = opts?.stats;
  const bumpFail = () => { if (stats) stats.fetchFailures++; };
  const sinceMs = opts?.sinceMs !== undefined && Number.isFinite(opts.sinceMs) ? opts.sinceMs : undefined;
  // 스코프 필터(#541 리뷰) — 컨테이너 나열(enumerateHierarchy)뿐 아니라 hydration 이 드러내는 부모/이동 서브태스크에도
  //  동일 적용. 제외(denylist)·미포함(allowlist 밖) 리스트의 태스크가 위상 재귀로 새어 들어오는 걸 막는다.
  const excluded = await getExcludedListIds();
  const included = await getIncludedListIds();
  const listAllowed = (listId?: string | null) =>
    !listId || (!excluded.has(listId) && (!included || included.has(listId)));

  // ① 계층 — Space → Folder → List → View 순서(미러 부모 해소 순서 의존). 부분 실패는 stats 로(커서 동결).
  //  허용목록(include) 스코프면 **허용 리스트가 있는 컨테이너만** 이관 — 고객 박스가 리스트 1개만 스코핑했는데
  //  워크스페이스의 빈 스페이스/폴더 전부가 사이드바에 유입되는 것 방지(denylist-only/무필터는 전체 계층 보존).
  const pruneContainers = !!included;
  const tree = await enumerateHierarchy(teamId, { withMeta: true, onError: bumpFail });
  const allLists: ClickUpList[] = [];
  let spaceIdx = 0;
  for (const s of tree) {
    const keptFolders = s.folders.filter((f) => !pruneContainers || f.lists.length > 0);
    const spaceHasLists = keptFolders.some((f) => f.lists.length > 0) || s.folderlessLists.length > 0;
    const keepSpace = !pruneContainers || spaceHasLists;
    if (keepSpace) yield spaceToRawItem(s.space, ctx, spaceIdx++);
    if (!keepSpace) continue; // 스페이스가 빠지면 하위 전부 스코프 밖
    for (const f of keptFolders) yield folderToRawItem(f.folder, s.space.id, ctx);
    for (const f of keptFolders) for (const hl of f.lists) { allLists.push(hl.list); yield listToRawItem(hl, s.space, ctx); }
    for (const hl of s.folderlessLists) { allLists.push(hl.list); yield listToRawItem(hl, s.space, ctx); }
    for (const v of s.views) yield viewToRawItem(v, { kind: "space", id: s.space.id }, ctx);
    for (const f of keptFolders) for (const v of f.views) yield viewToRawItem(v, { kind: "folder", id: f.folder.id }, ctx);
    for (const f of keptFolders) for (const hl of f.lists) for (const v of hl.views) yield viewToRawItem(v, { kind: "list", id: hl.list.id }, ctx);
    for (const hl of s.folderlessLists) for (const v of hl.views) yield viewToRawItem(v, { kind: "list", id: hl.list.id }, ctx);
  }

  // ② 태스크 얕은 나열 — full=리스트별 active+archived, incr=team date_updated_gt + per-list archived 패스.
  //  실패는 부분 수집 계속 + stats 집계(커서 동결 근거 — 실패 윈도가 커서에 덮여 영구 유실되는 것 방지).
  const shallow = new Map<string, ClickUpTask>();
  if (sinceMs !== undefined) {
    try {
      for (const t of await fetchTeamTasks(teamId, { dateUpdatedGt: sinceMs, listIds: allLists.map((l) => l.id) })) shallow.set(t.id, t);
    } catch (err) { bumpFail(); console.error(`[clickup] 팀 증분 폴 실패(archived 패스만 진행):`, err); }
    for (const l of allLists) {
      try {
        for (const t of await fetchListTasks(l.id, { archived: true, dateUpdatedGt: sinceMs })) if (!shallow.has(t.id)) shallow.set(t.id, t);
      } catch (err) { bumpFail(); console.error(`[clickup] 리스트 ${l.id} archived 증분 실패, skip:`, err); }
    }
  } else {
    for (const l of allLists) {
      try {
        for (const t of await fetchListTasks(l.id, {})) shallow.set(t.id, t);
        for (const t of await fetchListTasks(l.id, { archived: true })) if (!shallow.has(t.id)) shallow.set(t.id, t);
      } catch (err) { bumpFail(); console.error(`[clickup] 리스트 ${l.id} 백필 중단(부분 수집됨):`, err); }
    }
  }

  // ③ hydration + 부모우선(위상) + 미지 서브태스크 수렴 + 댓글.
  //  hydration 실패는 **skip + 실패 집계** — 얕은 응답 폴백 금지(#541 리뷰): 얕은 응답엔 markdown 본문·첨부·
  //  커스텀필드 값이 없어, 폴백을 미러에 흘리면 파괴적 reconcile(첨부 삭제·본문 다운그레이드)이 기존 무손실
  //  데이터를 훼손한다. skip+커서 동결이면 다음 run 이 같은 윈도를 재수화해 무손상 수렴.
  const emitted = new Set<string>();
  const getFull = async (id: string): Promise<ClickUpTask | null> => {
    if (!doHydrate) return shallow.get(id) ?? null;
    try { return await getTaskFull(id); } catch (err) {
      bumpFail();
      console.error(`[clickup] 태스크 ${id} hydration 실패 — skip(커서 동결로 다음 run 재수화):`, err);
      return null;
    }
  };
  const emitTask = async function* (id: string, depth: number): AsyncIterable<RawItem> {
    if (emitted.has(id) || depth > 12) return;
    emitted.add(id); // 선등록 — 순환(이론상)·중복 재귀 방지
    const full = await getFull(id);
    if (!full) { return; }
    // 스코프 필터 — 제외/미포함 리스트의 태스크(부모 위상·이동 서브태스크로 유입)는 자신·부속을 적재하지 않는다.
    if (!listAllowed(full.list?.id ?? null)) return;
    // 부모 먼저(미러 parent_id 즉시 해소). incr 에서 부모가 미변경분이어도 재수화(멱등·1콜) — 정합 우선.
    const parentId = full.parent ?? null;
    if (parentId && !emitted.has(parentId)) yield* emitTask(parentId, depth + 1);
    try {
      yield toRawItem(full, ctx);
    } catch (err) {
      console.error(`[clickup] 태스크 변환 실패 ${full.id}, skip:`, err);
      return;
    }
    // hydration 이 드러낸 미지 서브태스크(타 리스트 이동 포함) 수렴.
    for (const st of full.subtasks ?? []) if (st?.id && !emitted.has(st.id)) yield* emitTask(st.id, depth + 1);
    // 댓글 — 귀속 태스크 뒤(미러 task 해소 순서). 실패도 stats 집계(커서 전진 시 이 태스크 댓글만 영구 누락 방지).
    if (withComments) {
      try {
        for (const { comment, replyTo } of await getTaskComments(full.id)) yield commentToRawItem(comment, full.id, ctx, replyTo);
      } catch (err) { bumpFail(); console.error(`[clickup] 태스크 ${full.id} 댓글 수집 실패, skip:`, err); }
    }
  };
  for (const id of [...shallow.keys()]) yield* emitTask(id, 0);

  // ④ 타임엔트리 — 팀 스윕(태스크 귀속만; 태스크가 이번 스트림 밖이어도 DB 기존 행에 붙는다 — 미러가 해소).
  //  start_date 필터는 엔트리 '시작시각' 기준이라 과거로 소급 기록(어제 작업을 오늘 입력)이 커서 뒤로 숨는다
  //  → 7일 마진으로 재수집(멱등 upsert라 무비용). 7일 이전 소급은 다음 --full 이 수렴.
  if (withTime) {
    const timeSince = sinceMs !== undefined ? Math.max(0, sinceMs - 7 * 864e5) : undefined;
    for (const t of await fetchTimeEntries(teamId, { sinceMs: timeSince, onError: bumpFail })) {
      const ri = timeEntryToRawItem(t, ctx);
      if (ri) yield ri;
    }
  }
}
