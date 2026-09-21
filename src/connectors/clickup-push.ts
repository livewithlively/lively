// #177 아웃바운드 드레인 — external_outbox(pending) → ClickUp create/update/delete. run-sync(인바운드)의 역방향.
//  우리 DB=master: 로컬 편집을 ClickUp 미러에 반영. 멱등(현재 project 행 재읽기 → upsert), 부분실패 안전(행별 try/catch + attempts).
//  매핑(인바운드와 대칭): project=top-level Task(컨테이너 List 안), task=Subtask(parent=project-Task), subtask=중첩 Subtask.
//   부모 미푸시(external_id 없음)면 그 자식은 defer(이번 틱 skip) — 다음 틱에 부모 푸시 후 수렴.
//  status: **그 카드가 속한 리스트**의 상태셋에서 뽑는다(판정은 clickup/push-status.ts). 불일치 시 status 빼고 1회 재시도.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { clickupFetch, createTask, updateTask, getTeam } from "./clickup.js";
import { statusesForList, decidePushStatus } from "./clickup/push-status.js";
import type { ClickUpStatus, ClickUpList, ClickUpSpace } from "./clickup/types.js";
import { resolveConnectorConfig } from "./config.js";
import { logger } from "../log.js";
import { hiddenProjects } from "../v6/visibility.js";
import { PUBLIC_VIEWER } from "../v6/visibility.js";

// 상태셋 로드 일시실패를 언제까지 미룰지 — 넘으면 status 없이 진행한다(무한 재시도가 큐 머리를 점거하지 않게).
//  ⚠ 기준은 **그 행의 누적 attempts** 다(상태셋 전용 카운터가 아니다 — 일반 push 실패와 같은 칸을 쓴다).
//   그래서 이미 여러 번 실패한 행은 상태셋 재시도 기회가 줄거나 없다. 재enqueue 시 attempts 는 0 으로 리셋된다.
const STATUS_LOAD_RETRY_LIMIT = 5;
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
  list_ext: string | null;        // 인바운드가 남긴 그 카드의 ClickUp 리스트 좌표(external_base.list_ext).
  base_status_raw: string | null; // 저쪽(ClickUp)의 현재 상태 라벨/슬러그 — status 판정의 기준. push-status.ts 머리말 참조.
}

function mkBody(p: ProjRow, status: string | undefined): Record<string, unknown> {
  const b: Record<string, unknown> = { name: p.name || "(제목없음)" };
  // #541: 본문은 markdown_description 으로 — 인바운드가 markdown_description(서식 원문)을 저장하므로
  //  평문 description 으로 PUT 하면 ClickUp 리치텍스트가 리터럴 마크다운 소스로 덮여 왕복마다 열화된다.
  if (p.description != null) b.markdown_description = p.description;
  if (status) b.status = status;
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

// skipped ≠ deferred — deferred 는 '다음 틱에 다시 시도'(아웃박스 행 유지), skipped 는 '반출 대상이 아니라 닫았다'(행 소비).
//  종전엔 둘을 deferred 로 합산해, 운영자가 큰 deferred 를 보고 일시적 지연으로 오독하면 이번 사고(영구 미반출)를
//  못 알아본다. 두 숫자를 갈라야 '왜 큐가 안 빠지나'를 로그만으로 판정할 수 있다.
export async function pushOutbox(opts?: { limit?: number }): Promise<{ pushed: number; deferred: number; skipped: number; failed: number; deleted: number; scanned: number }> {
  const team = await getTeam();
  const teamId = team.id;
  const containerId = ((await resolveConnectorConfig("clickup")).container_list_id ?? "").trim() || "";
  if (!containerId) logger.warn("CLICKUP_CONTAINER_LIST_ID 미설정 — 네이티브(우리에서 태어난) 항목의 create 를 건너뛴다");

  // 상태셋 — **리스트별로** 로드해 캐시한다(리스트당 최대 2콜). 종전엔 컨테이너 리스트의 스페이스 하나로
  //  전 태스크의 status 를 만들었는데, 미러가 여러 리스트에 걸쳐 있고 리스트마다 상태 어휘가 달라서
  //  다른 리스트 카드에선 그 이름이 유효하지 않았다 → ClickUp 이 거부하고 updateSafe 의 "status 빼고 재시도"가
  //  삼켜서 status 만 조용히 유실됐다(실측 드리프트 18건이 그렇게 영구 미반영이었다).
  //  ⚠ 로드 실패를 「빈 상태셋」으로 뭉개면 안 된다 — 그러면 status 없이 PUT 하고 done 을 찍어 **그 status
  //   변경이 영구 유실**된다(아웃박스 행이 닫히니 다음 틱에 재시도되지 않는다). 그래서 실패를 따로 알린다.
  const statusCache = new Map<string, { statuses: ClickUpStatus[]; failed: boolean }>();
  const statusesOf = async (listId: string | null): Promise<{ statuses: ClickUpStatus[]; failed: boolean }> => {
    if (!listId) return { statuses: [], failed: false };
    const hit = statusCache.get(listId);
    if (hit) return hit;
    let entry: { statuses: ClickUpStatus[]; failed: boolean };
    try {
      const list = await clickupFetch<ClickUpList>(`/list/${encodeURIComponent(listId)}`);
      const spaceId = list.space?.id;
      const space = spaceId ? await clickupFetch<ClickUpSpace>(`/space/${encodeURIComponent(spaceId)}`) : null;
      entry = { statuses: statusesForList(list, space), failed: false };
    } catch (e) {
      // 404 = 리스트가 없어진 것이라 재시도로 안 풀린다. 그것만 「영구」로 보고 status 없이 진행한다 —
      //  영구 실패를 pending 으로 남기면 그 행이 `LIMIT 200` 큐 머리를 점거한다(이 MR 이 고치는 바로 그 결함).
      const permanent = String((e as Error)?.message).includes("404");
      logger.warn({ err: e, listId, permanent }, permanent
        ? "리스트가 없다 — 이 리스트의 행은 status 없이 푸시"
        : "리스트 상태셋 로드 실패 — 이 리스트의 행은 다음 틱으로 미룬다");
      entry = { statuses: [], failed: !permanent };
    }
    statusCache.set(listId, entry); // 실패도 캐시한다 — 같은 틱에서 리스트마다 한 번만 물어본다(429 폭주 방지).
    return entry;
  };

  // 컨테이너 리스트가 없으면 **네이티브(우리에서 태어난) 항목은 애초에 뽑지 않는다.** create 할 자리가 없어
  //  재시도로 풀리지 않는데, 종전엔 그 행을 markErr 로 pending 에 남겨 `ORDER BY created_at LIMIT 200` 의
  //  머리를 영구 점거했다 → 뒤에 있는 미러 항목의 PUT 까지 막혔다(실측: pending 2,563건 중 네이티브 2,476건이
  //  머리를 막아 고쳐야 할 미러 47건이 순위 5~2509 에 갇혔다). 쿼리에서 빼면 머리 점거는 사라지고 행은
  //  pending 으로 남아 **컨테이너를 설정하는 순간 자동 수렴**한다(닫아 버리면 다시 편집될 때까지 영구 미반출).
  //  ⚠ 같은 술어로 **project 행이 사라진 고아 upsert** 도 함께 빠진다 — 종전엔 뽑혀서 바로 닫혔으나 이제
  //   컨테이너 설정 후 첫 드레인에 닫힌다. pending 수를 읽을 때 그만큼이 섞여 있다(머리 점거는 없다).
  const rows: Array<{ id: number; entity_id: number; op: string; ext_id_snapshot: string | null; attempts: number }> = await q(itemsPool,
    `SELECT o.id, o.entity_id, o.op, o.ext_id_snapshot, o.attempts
       FROM external_outbox o
       LEFT JOIN project p ON p.id = o.entity_id
      WHERE o.system='clickup' AND o.done_at IS NULL
        AND ($2::bool OR o.op <> 'upsert' OR p.external_id IS NOT NULL)
      ORDER BY o.created_at LIMIT $1`, [opts?.limit ?? 200, containerId !== ""]);

  let pushed = 0, deferred = 0, failed = 0, deleted = 0, skipped = 0;
  const markDone = (obid: number) => itemsPool.query(`UPDATE external_outbox SET done_at=now(), updated_at=now() WHERE id=$1`, [obid]);
  const markErr = (obid: number, msg: string) => itemsPool.query(`UPDATE external_outbox SET attempts=attempts+1, last_error=$2, updated_at=now() WHERE id=$1`, [obid, msg.slice(0, 500)]);

  // 이 프로젝트가 '전원 공개'가 아닌가 — 리스트(또는 그 조상 폴더·스페이스)가 잠겼으면 반출 대상이 아니다.
  //  ⚠ 판정을 여기서 손으로 짜지 마라. 처음엔 리스트+**직속** 폴더만 보는 SQL 이었는데, 스페이스▸폴더▸리스트가
  //  ClickUp 미러의 기본 모양이라(라이브 실측 19건) 스페이스를 잠가도 그 안 리스트의 프로젝트가 조직 밖으로
  //  나갔다. v1 에서 knowledge-store 가 똑같이 1홉만 봤던 그 결함의 사본이다 — 반출은 되돌릴 수 없으므로
  //  가장 비싼 자리이기도 하다. 술어 SoT 의 재귀 판정을 그대로 쓴다(뷰어 무관·캐시됨).
  const restrictedIds = (await hiddenProjects(PUBLIC_VIEWER)).ids;
  const isRestrictedForPublish = (projectId: number): boolean => restrictedIds.has(projectId);

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
                external_system, external_id, folder,
                external_base->>'list_ext'   AS list_ext,
                external_base->>'status_raw' AS base_status_raw
         FROM project WHERE id=$1`, [ob.entity_id]);
      if (!p || p.folder === "__board_anchor__") { await markDone(ob.id); continue; } // 삭제됨/보드앵커 → skip

      // 공개범위(#1291) — 반출은 '생산'이 아니라 조직 밖으로 내보내는 일이다. 잠긴 리스트의 프로젝트 본문이
      //  ClickUp 카드로 나가면 라이블리에서 아무리 막아도 소용이 없다.
      //  ⚠ 단 **미러 기원(external_id 보유)은 제외한다.** 그건 원래 ClickUp 것이고 외부 ACL 이 관장한다.
      //   여기서 막으면 아웃박스 행이 영영 pending 으로 남아 3-way 머지의 pending 가드가 "곧 PUT 된다"는 전제를
      //   잃고, 그 엔티티의 **외부 변경이 조용히 유실**된다(우리 데이터도 안 나가고 저쪽 것도 안 들어온다).
      //  네이티브(우리에서 태어난) 프로젝트만 막고, 다시 큐에 쌓이지 않게 done 으로 닫는다.
      if (!p.external_id && isRestrictedForPublish(p.id)) {
        await markDone(ob.id); skipped++; continue;
      }
      // status 는 그 카드가 실제로 속한 리스트 기준으로 정한다. 네이티브(아직 카드가 없는 것)는 컨테이너 리스트가
      //  곧 그 자리이므로 컨테이너 상태셋을 쓴다.
      // 리스트 좌표가 없으면 컨테이너로 폴백한다. `list_ext` 는 인바운드가 채우는 값이라 **푸시로 방금 만든
      //  카드**엔 첫 인바운드 싱크 전까지 없다(create 가 병합하는 base 에 그 키가 없다). 빈 상태셋으로 두면
      //  그 구간의 status 가 조용히 빠져 이 수정이 고치려는 결함을 다시 만든다. 컨테이너 밖 카드에 폴백이
      //  잘못 걸려도 ClickUp 이 거부하고 updateSafe 가 status 를 빼고 재시도해 종전과 같아진다.
      const listForStatus = (p.external_id ? p.list_ext : null) ?? (containerId || null);
      const { statuses, failed: statusLoadFailed } = await statusesOf(listForStatus);
      // 일시 실패(429·순단)면 이 행을 닫지 않는다 — status 없이 밀어 done 을 찍으면 그 변경이 영구 유실된다.
      //  단 무한정 미루면 그 행이 큐 머리를 점거하므로 attempts 로 상한을 둔다(넘으면 status 없이 진행).
      if (statusLoadFailed && ob.attempts < STATUS_LOAD_RETRY_LIMIT) {
        await markErr(ob.id, `list ${listForStatus} 상태셋 로드 실패 — 다음 틱 재시도`); deferred++; continue;
      }
      const status = decidePushStatus({
        ourCategory: p.status_category,
        theirStatusRaw: p.base_status_raw,
        statuses,
      });
      const body = mkBody(p, status);
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
        // 도달 불가 방어 — 위 SELECT 가 컨테이너 부재 시 네이티브 행을 뽑지 않는다(근거는 그 주석).
        if (!containerId) { await markDone(ob.id); skipped++; continue; }
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
  logger.info({ pushed, deferred, skipped, failed, deleted, scanned: rows.length }, "clickup outbox 드레인 완료");
  return { pushed, deferred, skipped, failed, deleted, scanned: rows.length };
}
