// v6 태스크 상세(클릭업형 모달) 데이터 접근 — 한 태스크(project.id, level=task|subtask)에 매달리는
//  태그·시간추적·체크리스트·의존성·댓글/활동피드. 모달의 좌(필드/하위) + 우(Activity)를 한 번에 조립한다.
//  댓글 = task_comment(task_id=task) [전용 테이블, 프로젝트 #183], 시스템이벤트 = org_content_audit(entity='project') diff —
//  시스템이벤트는 전용 테이블 없이 전 이력 포착(schema.ts ⑧·⑪ 참조). 사람 식별자(member/assignee/actor)=org_member.id.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { type WriteCtx } from "../db/write.js";

const TASK_COLS =
  `id, level, parent_id, name, description, status, folder, created_by,
   priority, assignee, start_date, due_date, sort, created_at, updated_at, completed_at`;

const RECIP: Record<string, string> = { blocking: "waiting_on", waiting_on: "blocking", linked: "linked" };

// ── 상세 집계 — 모달 1회 페치 ────────────────────────────────────────────────
export async function getTaskDetail(id: number, viewer?: string | null): Promise<any | undefined> {
  const task: any = await one(itemsPool,
    `SELECT ${TASK_COLS} FROM project WHERE id=$1 AND level IN ('task','subtask')`, [id]);
  if (!task) return undefined;

  // 소유 프로젝트(루트) — task=부모가 프로젝트, subtask=부모(task)의 부모가 프로젝트. 재귀로 위로 올라가 level='project' 찾기.
  const root: any = await one(itemsPool,
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, level, name FROM project WHERE id=$1
       UNION ALL SELECT p.id, p.parent_id, p.level, p.name FROM project p JOIN up ON p.id = up.parent_id)
     SELECT id, name FROM up WHERE level='project' LIMIT 1`, [id]);
  const projectId: number | null = root?.id ?? null;

  // 하위 태스크(task 행만 의미 — subtask 는 하위 없음).
  const subtasks = task.level === "task"
    ? await q(itemsPool, `SELECT ${TASK_COLS} FROM project WHERE parent_id=$1 AND level='subtask' ORDER BY sort, id`, [id])
    : [];

  // 소유 프로젝트 팀원(담당자 피커용).
  const members = projectId != null
    ? await q(itemsPool,
        `SELECT pm.member_id, pm.role, m.display_name
         FROM project_member pm LEFT JOIN org_member m ON m.id=pm.member_id
         WHERE pm.project_id=$1 ORDER BY pm.sort, pm.member_id`, [projectId])
    : [];

  const [tags, time, checklists, links, feed] = await Promise.all([
    getTaskTags(id), getTaskTime(id), getTaskChecklists(id), getTaskLinks(id), getTaskFeed(id, viewer),
  ]);

  return { task: { ...task, subtasks }, project: root ? { id: root.id, name: root.name } : null,
    members, tags, time, checklists, links, feed };
}

// ── 태그 ─────────────────────────────────────────────────────────────────────
export async function listAllTags(): Promise<any[]> {
  return q(itemsPool, `SELECT id, name, color FROM task_tag ORDER BY lower(name)`, []);
}
export async function getTaskTags(taskId: number): Promise<any[]> {
  return q(itemsPool,
    `SELECT t.id, t.name, t.color FROM task_tag_link l JOIN task_tag t ON t.id=l.tag_id
     WHERE l.task_id=$1 ORDER BY lower(t.name)`, [taskId]);
}
// 태그 부착 — tagId 주면 그대로 링크, 아니면 이름으로 레지스트리 upsert(대소문자 무시) 후 링크.
export async function addTaskTag(taskId: number, input: { tagId?: number; name?: string; color?: string }): Promise<any[]> {
  let tagId = input.tagId ?? null;
  if (tagId == null) {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("태그 이름이 필요합니다");
    const row: any = await one(itemsPool,
      `INSERT INTO task_tag(name, color) VALUES($1,$2)
       ON CONFLICT (lower(name)) DO UPDATE SET color=COALESCE(EXCLUDED.color, task_tag.color)
       RETURNING id`, [name, input.color ?? null]);
    tagId = row.id;
  } else if (input.color !== undefined) {
    await itemsPool.query(`UPDATE task_tag SET color=$2 WHERE id=$1`, [tagId, input.color]);
  }
  await itemsPool.query(`INSERT INTO task_tag_link(task_id, tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [taskId, tagId]);
  return getTaskTags(taskId);
}
export async function removeTaskTag(taskId: number, tagId: number): Promise<any[]> {
  await itemsPool.query(`DELETE FROM task_tag_link WHERE task_id=$1 AND tag_id=$2`, [taskId, tagId]);
  return getTaskTags(taskId);
}
// 태그 레지스트리 수정 — 이름/색 변경(모든 태스크에 반영). 이름은 대소문자무시 유일(중복 시 에러).
export async function updateTag(tagId: number, patch: { name?: string; color?: string | null }): Promise<any> {
  const sets: string[] = []; const params: unknown[] = [tagId];
  if (patch.name !== undefined) { const nm = String(patch.name).trim(); if (!nm) throw new Error('이름은 비울 수 없습니다'); params.push(nm.slice(0, 40)); sets.push(`name=$${params.length}`); }
  if (patch.color !== undefined) { params.push(patch.color); sets.push(`color=$${params.length}`); }
  if (!sets.length) return one(itemsPool, `SELECT id, name, color FROM task_tag WHERE id=$1`, [tagId]);
  return one(itemsPool, `UPDATE task_tag SET ${sets.join(', ')} WHERE id=$1 RETURNING id, name, color`, params);
}
// 태그 레지스트리 삭제 — task_tag_link 는 FK CASCADE 로 정리(모든 태스크에서 제거).
export async function deleteTag(tagId: number): Promise<{ id: number }> {
  await itemsPool.query(`DELETE FROM task_tag WHERE id=$1`, [tagId]);
  return { id: tagId };
}

// ── 시간추적 ───────────────────────────────────────────────────────────────────
export async function getTaskTime(taskId: number): Promise<any> {
  const entries = await q(itemsPool,
    `SELECT id, member, started_at, ended_at, duration_seconds, note, source, created_at
     FROM task_time_entry WHERE task_id=$1 ORDER BY COALESCE(started_at, created_at) DESC`, [taskId]);
  let total = 0;
  let running: any = null;
  for (const e of entries) {
    if (e.ended_at == null && e.started_at != null) running = e;        // 실행중 타이머(프론트가 live tick)
    else if (e.duration_seconds != null) total += Number(e.duration_seconds);
  }
  return { entries, total_seconds: total, running };
}
export async function startTimer(taskId: number, member: string | null): Promise<any> {
  const existing: any = await one(itemsPool,
    `SELECT id FROM task_time_entry WHERE task_id=$1 AND member IS NOT DISTINCT FROM $2 AND ended_at IS NULL`, [taskId, member]);
  if (!existing) {
    await itemsPool.query(
      `INSERT INTO task_time_entry(task_id, member, started_at, source) VALUES($1,$2,now(),'timer')`, [taskId, member]);
  }
  return getTaskTime(taskId);
}
export async function stopTimer(taskId: number, member: string | null): Promise<any> {
  await itemsPool.query(
    `UPDATE task_time_entry
       SET ended_at=now(), duration_seconds=GREATEST(0, EXTRACT(EPOCH FROM (now()-started_at))::int)
     WHERE task_id=$1 AND member IS NOT DISTINCT FROM $2 AND ended_at IS NULL`, [taskId, member]);
  return getTaskTime(taskId);
}
export async function addManualTime(taskId: number, member: string | null, seconds: number, note: string | null): Promise<any> {
  const s = Math.max(1, Math.floor(seconds));
  await itemsPool.query(
    `INSERT INTO task_time_entry(task_id, member, started_at, ended_at, duration_seconds, note, source)
     VALUES($1,$2, now() - make_interval(secs => $3::int), now(), $3::int, $4, 'manual')`, [taskId, member, s, note ?? null]);
  return getTaskTime(taskId);
}
export async function deleteTimeEntry(taskId: number, entryId: number): Promise<any> {
  await itemsPool.query(`DELETE FROM task_time_entry WHERE id=$1 AND task_id=$2`, [entryId, taskId]);
  return getTaskTime(taskId);
}

// ── 체크리스트 ─────────────────────────────────────────────────────────────────
export async function getTaskChecklists(taskId: number): Promise<any[]> {
  const lists = await q(itemsPool,
    `SELECT id, name, sort FROM task_checklist WHERE task_id=$1 ORDER BY sort, id`, [taskId]);
  if (!lists.length) return [];
  const ids = lists.map((l: any) => l.id);
  const items = await q(itemsPool,
    `SELECT id, checklist_id, name, done, assignee, sort FROM task_checklist_item
     WHERE checklist_id = ANY($1) ORDER BY sort, id`, [ids]);
  return lists.map((l: any) => ({ ...l, items: items.filter((it: any) => it.checklist_id === l.id) }));
}
export async function createChecklist(taskId: number, name: string): Promise<any[]> {
  const m: any = await one(itemsPool, `SELECT COALESCE(MAX(sort),-1)+1 AS n FROM task_checklist WHERE task_id=$1`, [taskId]);
  await itemsPool.query(`INSERT INTO task_checklist(task_id, name, sort) VALUES($1,$2,$3)`, [taskId, name.trim() || "체크리스트", m.n]);
  return getTaskChecklists(taskId);
}
export async function renameChecklist(taskId: number, checklistId: number, name: string): Promise<any[]> {
  await itemsPool.query(`UPDATE task_checklist SET name=$2 WHERE id=$1 AND task_id=$3`, [checklistId, name.trim() || "체크리스트", taskId]);
  return getTaskChecklists(taskId);
}
export async function deleteChecklist(taskId: number, checklistId: number): Promise<any[]> {
  await itemsPool.query(`DELETE FROM task_checklist WHERE id=$1 AND task_id=$2`, [checklistId, taskId]);
  return getTaskChecklists(taskId);
}
export async function addChecklistItem(taskId: number, checklistId: number, name: string): Promise<any[]> {
  // checklistId 가 이 태스크 소유인지 확인(교차 태스크 쓰기 차단).
  const own: any = await one(itemsPool, `SELECT 1 FROM task_checklist WHERE id=$1 AND task_id=$2`, [checklistId, taskId]);
  if (!own) throw new Error("체크리스트를 찾을 수 없습니다");
  const m: any = await one(itemsPool, `SELECT COALESCE(MAX(sort),-1)+1 AS n FROM task_checklist_item WHERE checklist_id=$1`, [checklistId]);
  await itemsPool.query(`INSERT INTO task_checklist_item(checklist_id, name, sort) VALUES($1,$2,$3)`, [checklistId, name.trim(), m.n]);
  return getTaskChecklists(taskId);
}
export async function updateChecklistItem(taskId: number, itemId: number, patch: { name?: string; done?: boolean; assignee?: string | null }): Promise<any[]> {
  const sets: string[] = []; const vals: unknown[] = [];
  const set = (c: string, v: unknown) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.done !== undefined) set("done", patch.done);
  if (patch.assignee !== undefined) set("assignee", patch.assignee);
  if (sets.length) {
    vals.push(itemId);
    await itemsPool.query(
      `UPDATE task_checklist_item SET ${sets.join(", ")}
       WHERE id=$${vals.length} AND checklist_id IN (SELECT id FROM task_checklist WHERE task_id=$${vals.length + 1})`,
      [...vals, taskId]);
  }
  return getTaskChecklists(taskId);
}
export async function deleteChecklistItem(taskId: number, itemId: number): Promise<any[]> {
  await itemsPool.query(
    `DELETE FROM task_checklist_item WHERE id=$1 AND checklist_id IN (SELECT id FROM task_checklist WHERE task_id=$2)`,
    [itemId, taskId]);
  return getTaskChecklists(taskId);
}

// ── 의존성/연결 ────────────────────────────────────────────────────────────────
export async function getTaskLinks(taskId: number): Promise<any[]> {
  return q(itemsPool,
    `SELECT l.type, l.to_task AS id, p.name, p.status, p.level
     FROM task_link l JOIN project p ON p.id=l.to_task
     WHERE l.from_task=$1 ORDER BY l.type, p.name`, [taskId]);
}
export async function addTaskLink(fromTask: number, toTask: number, type: string): Promise<any[]> {
  if (fromTask === toTask) throw new Error("자기 자신과는 연결할 수 없습니다");
  const recip = RECIP[type];
  if (!recip) throw new Error("type 이 올바르지 않습니다");
  const exists: any = await one(itemsPool, `SELECT 1 FROM project WHERE id=$1 AND level IN ('task','subtask')`, [toTask]);
  if (!exists) throw new Error("연결할 작업을 찾을 수 없습니다");
  await itemsPool.query(`INSERT INTO task_link(from_task, to_task, type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [fromTask, toTask, type]);
  await itemsPool.query(`INSERT INTO task_link(from_task, to_task, type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [toTask, fromTask, recip]);
  return getTaskLinks(fromTask);
}
export async function removeTaskLink(fromTask: number, toTask: number, type: string): Promise<any[]> {
  const recip = RECIP[type] ?? null;
  await itemsPool.query(`DELETE FROM task_link WHERE from_task=$1 AND to_task=$2 AND type=$3`, [fromTask, toTask, type]);
  if (recip) await itemsPool.query(`DELETE FROM task_link WHERE from_task=$1 AND to_task=$2 AND type=$3`, [toTask, fromTask, recip]);
  return getTaskLinks(fromTask);
}
// 연결 후보 — 같은 프로젝트의 다른 task/subtask 검색(이름 부분일치). 이미 연결된 건 프론트가 거른다.
export async function searchLinkTargets(projectId: number, exclude: number, query: string): Promise<any[]> {
  const like = `%${query.trim()}%`;
  return q(itemsPool,
    `WITH RECURSIVE down AS (
       SELECT id, parent_id, level, name, status FROM project WHERE id=$1
       UNION ALL SELECT p.id, p.parent_id, p.level, p.name, p.status FROM project p JOIN down ON p.parent_id = down.id)
     SELECT id, name, status, level FROM down
     WHERE level IN ('task','subtask') AND id<>$2 AND ($3='' OR name ILIKE $4)
     ORDER BY name LIMIT 20`, [projectId, exclude, query.trim(), like]);
}

// ── 댓글 + 활동 피드 ────────────────────────────────────────────────────────────
export async function postComment(taskId: number, text: string, ctx?: WriteCtx, parentId?: number | null): Promise<any[]> {
  const body = text.trim();
  if (!body) throw new Error("댓글 내용이 비어 있습니다");
  // reply_to = 부모 댓글 id(1단계 스레드). null=최상위. 부모가 이 태스크의 최상위 댓글일 때만 인정(과허용·중첩 평탄화).
  let parent: number | null = null;
  if (parentId) {
    const ok = await one(itemsPool, `SELECT 1 AS x FROM task_comment WHERE id=$1 AND task_id=$2 AND reply_to IS NULL`, [parentId, taskId]);
    if (ok) parent = parentId;
  }
  await itemsPool.query(
    `INSERT INTO task_comment(task_id, author, body, reply_to, created_at) VALUES($1, $2, $3, $4, now())`,
    [taskId, ctx?.actor ?? null, body, parent]);
  return getTaskFeed(taskId);
}

// 피드 = 사용자 댓글(task_comment) + 시스템 이벤트(org_content_audit diff) 를 시간순 병합.
const FEED_FIELDS: Array<[string, string]> = [
  ["status", "상태"], ["assignee", "담당자"], ["priority", "우선순위"],
  ["due_date", "마감일"], ["start_date", "시작일"], ["name", "이름"], ["description", "설명"],
];
export async function getTaskFeed(taskId: number, viewer?: string | null): Promise<any[]> {
  const comments = await q(itemsPool,
    `SELECT c.id, c.body, c.created_at, c.author AS actor, c.reply_to, m.display_name
     FROM task_comment c LEFT JOIN org_member m ON m.id = c.author
     WHERE c.task_id=$1 ORDER BY c.created_at`, [taskId]);
  const audits = await q(itemsPool,
    `SELECT a.id, a.op, a.before, a.after, a.actor, a.at, m.display_name
     FROM org_content_audit a LEFT JOIN org_member m ON m.id = a.actor
     WHERE a.entity='project' AND a.entity_key=$1 ORDER BY a.at`, [String(taskId)]);

  // 댓글 반응(이모지) 집계 — 댓글 id 들에 대해 emoji별 count + 내 반응 여부(mine).
  const cids = comments.map((c) => c.id);
  const reactRows = cids.length
    ? await q(itemsPool,
        `SELECT comment_id, emoji, COUNT(*)::int AS count, BOOL_OR(member = $2) AS mine
         FROM task_comment_reaction WHERE comment_id = ANY($1)
         GROUP BY comment_id, emoji ORDER BY comment_id, MIN(created_at)`, [cids, viewer ?? ""])
    : [];
  const reactByComment = new Map<number, Array<{ emoji: string; count: number; mine: boolean }>>();
  for (const r of reactRows) {
    const arr = reactByComment.get(r.comment_id) || [];
    arr.push({ emoji: r.emoji, count: r.count, mine: r.mine });
    reactByComment.set(r.comment_id, arr);
  }
  const feed: any[] = [];
  for (const c of comments) {
    feed.push({ kind: "comment", id: c.id, ts: c.created_at, actor: c.actor, reply_to: c.reply_to ?? null,
      display_name: c.display_name, body: c.body, reactions: reactByComment.get(c.id) || [] });
  }
  for (const a of audits) {
    const before = a.before || {};
    const after = a.after || {};
    if (a.op === "insert") {
      feed.push({ kind: "event", id: "a" + a.id, ts: a.at, actor: a.actor, display_name: a.display_name, field: "created" });
      continue;
    }
    for (const [key, label] of FEED_FIELDS) {
      const bv = before[key] ?? null;
      const av = after[key] ?? null;
      if (String(bv ?? "") !== String(av ?? "")) {
        feed.push({ kind: "event", id: "a" + a.id + "-" + key, ts: a.at, actor: a.actor,
          display_name: a.display_name, field: key, label, from: bv, to: av });
      }
    }
  }
  feed.sort((x, y) => new Date(x.ts).getTime() - new Date(y.ts).getTime());
  return feed.slice(-300);
}

// 댓글 반응 토글 — (comment_id, emoji, member) 있으면 제거, 없으면 추가. 갱신된 emoji별 집계 반환.
export async function toggleCommentReaction(commentId: number, emoji: string, member: string): Promise<Array<{ emoji: string; count: number; mine: boolean }>> {
  const e = String(emoji).slice(0, 16);
  const ex = await one(itemsPool, `SELECT 1 AS x FROM task_comment_reaction WHERE comment_id=$1 AND emoji=$2 AND member=$3`, [commentId, e, member]);
  if (ex) await itemsPool.query(`DELETE FROM task_comment_reaction WHERE comment_id=$1 AND emoji=$2 AND member=$3`, [commentId, e, member]);
  else await itemsPool.query(`INSERT INTO task_comment_reaction(comment_id, emoji, member) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [commentId, e, member]);
  return q(itemsPool,
    `SELECT emoji, COUNT(*)::int AS count, BOOL_OR(member=$2) AS mine FROM task_comment_reaction
     WHERE comment_id=$1 GROUP BY emoji ORDER BY MIN(created_at)`, [commentId, member]);
}
