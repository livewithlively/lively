// #177 아웃바운드 드레인 — external_outbox(pending) → ClickUp create/update/delete. run-sync(인바운드)의 역방향.
//  우리 DB=master: 로컬 편집을 ClickUp 미러에 반영. 멱등(현재 project 행 재읽기 → upsert), 부분실패 안전(행별 try/catch + attempts).
//  매핑(인바운드와 대칭): project=top-level Task(컨테이너 List 안), task=Subtask(parent=project-Task), subtask=중첩 Subtask.
//   부모 미푸시(external_id 없음)면 그 자식은 defer(이번 틱 skip) — 다음 틱에 부모 푸시 후 수렴.
//  status: status_category → 컨테이너 스페이스 상태셋(to do/in progress/complete). 불일치 시 status 빼고 1회 재시도.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { clickupFetch, createTask, updateTask, getTeam } from "./clickup.js";
import { resolveConnectorConfig } from "./config.js";
import { logger } from "../log.js";

const PRIORITY_MAP: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
const toMs = (d?: string | null): number | undefined => {
  if (!d) return undefined;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : undefined;
};

interface ProjRow {
  id: number; level: string; parent_id: number | null;
  name: string; description: string | null;
  status_category: string | null; priority: string | null;
  start_date: string | null; due_date: string | null;
  external_system: string | null; external_id: string | null; folder: string | null;
}

// 정규 카테고리 → 스페이스 상태명(인바운드 clickUpStatusCategory 의 역). 스페이스 statuses(type: open|custom|done|closed)에서 매칭.
function buildStatusMap(statuses: Array<{ status?: string; type?: string }>): Record<string, string | undefined> {
  const byType = (t: string) => (statuses.find((s) => s.type === t) || {}).status;
  const open = byType("open"), custom = byType("custom"), done = byType("done") || byType("closed");
  return { backlog: open, unstarted: open, started: custom || open, done, canceled: done };
}

function mkBody(p: ProjRow, statusMap: Record<string, string | undefined>): Record<string, unknown> {
  const b: Record<string, unknown> = { name: p.name || "(제목없음)" };
  // #541: 본문은 markdown_description 으로 — 인바운드가 markdown_description(서식 원문)을 저장하므로
  //  평문 description 으로 PUT 하면 ClickUp 리치텍스트가 리터럴 마크다운 소스로 덮여 왕복마다 열화된다.
  if (p.description != null) b.markdown_description = p.description;
  const st = p.status_category ? statusMap[p.status_category] : undefined;
  if (st) b.status = st;
  if (p.priority && PRIORITY_MAP[p.priority]) b.priority = PRIORITY_MAP[p.priority];
  const dd = toMs(p.due_date); if (dd) b.due_date = dd;
  const sd = toMs(p.start_date); if (sd) b.start_date = sd;
  return b;
}

// 생성/수정 — status 불일치(리스트 상태셋 밖) 방어로 실패 시 status 빼고 1회 재시도.
async function createSafe(listId: string, body: Record<string, unknown>) {
  try { return await createTask(listId, body); }
  catch (e) { if (body.status) { const { status, ...b } = body; logger.warn({ name: body.name }, "create status 빼고 재시도"); return await createTask(listId, b); } throw e; }
}
async function updateSafe(taskId: string, body: Record<string, unknown>) {
  try { return await updateTask(taskId, body); }
  catch (e) { if (body.status) { const { status, ...b } = body; logger.warn({ name: body.name }, "update status 빼고 재시도"); return await updateTask(taskId, b); } throw e; }
}

export async function pushOutbox(opts?: { limit?: number }): Promise<{ pushed: number; deferred: number; failed: number; deleted: number; scanned: number }> {
  const team = await getTeam();
  const teamId = team.id;
  const containerId = ((await resolveConnectorConfig("clickup")).container_list_id ?? "").trim() || "";
  if (!containerId) logger.warn("CLICKUP_CONTAINER_LIST_ID 미설정 — 아웃바운드 create 불가(컨테이너 리스트 id 필요)");

  // 상태셋 — 컨테이너 리스트의 스페이스에서 1회 로드(없어도 진행 — status 매핑만 생략).
  let statusMap: Record<string, string | undefined> = {};
  if (containerId) {
    try {
      const list = await clickupFetch<{ space?: { id?: string } }>(`/list/${encodeURIComponent(containerId)}`);
      const spaceId = list.space?.id;
      if (spaceId) {
        const space = await clickupFetch<{ statuses?: Array<{ status?: string; type?: string }> }>(`/space/${encodeURIComponent(spaceId)}`);
        statusMap = buildStatusMap(space.statuses ?? []);
      }
    } catch (e) { logger.warn({ err: e }, "스페이스 상태셋 로드 실패 — status 매핑 없이 진행"); }
  }

  const rows: Array<{ id: number; entity_id: number; op: string; ext_id_snapshot: string | null }> = await q(itemsPool,
    `SELECT id, entity_id, op, ext_id_snapshot FROM external_outbox
     WHERE system='clickup' AND done_at IS NULL ORDER BY created_at LIMIT $1`, [opts?.limit ?? 200]);

  let pushed = 0, deferred = 0, failed = 0, deleted = 0;
  const markDone = (obid: number) => itemsPool.query(`UPDATE external_outbox SET done_at=now(), updated_at=now() WHERE id=$1`, [obid]);
  const markErr = (obid: number, msg: string) => itemsPool.query(`UPDATE external_outbox SET attempts=attempts+1, last_error=$2, updated_at=now() WHERE id=$1`, [obid, msg.slice(0, 500)]);

  for (const ob of rows) {
    try {
      if (ob.op === "delete") {
        if (ob.ext_id_snapshot) {
          try { await clickupFetch(`/task/${encodeURIComponent(ob.ext_id_snapshot)}`, { method: "DELETE" }); }
          catch (e) { if (!String((e as Error)?.message).includes("404")) throw e; } // 이미 없으면 성공 취급
        }
        await markDone(ob.id); deleted++; continue;
      }

      // upsert — 현재 project 행 재읽기(멱등, 최신 상태 푸시).
      const p: ProjRow | undefined = await one(itemsPool,
        `SELECT id, level, parent_id, name, description, status_category, priority, start_date, due_date,
                external_system, external_id, folder
         FROM project WHERE id=$1`, [ob.entity_id]);
      if (!p || p.folder === "__board_anchor__") { await markDone(ob.id); continue; } // 삭제됨/보드앵커 → skip
      const body = mkBody(p, statusMap);
      // 푸시하는 ours 값 → external_base 갱신(#6d 3-way 의 공통조상). 인바운드가 이 base 로 외부편집 변화를 판정.
      //  #541: **병합**(|| 연산) — 통째 교체하면 인바운드 미러가 관리하는 확장 키(status_raw/assignee/list_ext/tags)가
      //  푸시 때마다 소거되어 다음 3-way 가 base=NULL 로 동작한다. 푸시에 실리는 필드만 전진(name/desc/category/priority/dates).
      const baseJson = JSON.stringify({
        name: p.name, description: p.description, status_category: p.status_category,
        priority: p.priority, start_date: p.start_date, due_date: p.due_date,
      });

      if (p.external_system === "clickup" && p.external_id) {
        await updateSafe(p.external_id, body);
        await itemsPool.query(
          `UPDATE project SET external_base = COALESCE(external_base, '{}'::jsonb) || $2::jsonb WHERE id=$1`,
          [p.id, baseJson]);
        await markDone(ob.id); pushed++;
      } else {
        // CREATE — 부모(project-Task / task-Subtask) external_id 해소. 미푸시면 defer.
        let parentExt: string | undefined;
        if (p.level !== "project") {
          if (p.parent_id == null) { await markDone(ob.id); continue; } // 비정상 — skip
          const par: { external_id: string | null; external_system: string | null } | undefined = await one(itemsPool,
            `SELECT external_id, external_system FROM project WHERE id=$1`, [p.parent_id]);
          if (!par || par.external_system !== "clickup" || !par.external_id) { deferred++; continue; } // 부모 미푸시 → 다음 틱
          parentExt = par.external_id;
        }
        if (!containerId) { await markErr(ob.id, "no CLICKUP_CONTAINER_LIST_ID"); failed++; continue; }
        const ct = await createSafe(containerId, { ...body, ...(parentExt ? { parent: parentExt } : {}) });
        const url = ct.url || `https://app.clickup.com/t/${ct.id}`;
        await itemsPool.query(
          `UPDATE project SET external_system='clickup', external_instance=$2, external_id=$3, external_url=$4,
                  external_base = COALESCE(external_base, '{}'::jsonb) || $5::jsonb, updated_at=now() WHERE id=$1`,
          [p.id, teamId, ct.id, url, baseJson]);
        await markDone(ob.id); pushed++;
      }
    } catch (e) {
      await markErr(ob.id, (e as Error)?.message ?? String(e)); failed++;
      logger.warn({ err: e, outbox: ob.id, entity: ob.entity_id }, "outbox 푸시 실패(다음 틱 재시도)");
    }
  }
  logger.info({ pushed, deferred, failed, deleted, scanned: rows.length }, "clickup outbox 드레인 완료");
  return { pushed, deferred, failed, deleted, scanned: rows.length };
}
