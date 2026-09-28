// #177 아웃바운드 드레인 — external_outbox(pending) → ClickUp create/update/delete. run-sync(인바운드)의 역방향.
//  우리 DB=master: 로컬 편집을 ClickUp 미러에 반영. 멱등(현재 project 행 재읽기 → upsert), 부분실패 안전(행별 try/catch + attempts).
//  매핑(인바운드와 대칭): project=top-level Task(컨테이너 List 안), task=Subtask(parent=project-Task), subtask=중첩 Subtask.
//   부모 미푸시(external_id 없음)면 그 자식은 defer(이번 틱 skip) — 다음 틱에 부모 푸시 후 수렴.
//  status: **그 카드가 속한 리스트**의 상태셋에서 뽑는다(판정은 clickup/push-status.ts). 불일치 시 status 빼고 1회 재시도.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { clickupFetch, createTask, updateTask, getTeam, createTaskComment } from "./clickup.js";
import { CLOSED_CATEGORIES, closeCommentText, type CloseNote } from "./clickup/close-comment.js";
import { rootProjectIdOfTaskNode } from "../v6/project-store.js";
import { getMember } from "../org/store/members.js";
import { gatewayUrl } from "../gateway-url.js";
import { statusesForList, decidePushStatus } from "./clickup/push-status.js";
import { createListFor } from "./clickup/push-target.js";
import type { ClickUpStatus, ClickUpList, ClickUpSpace } from "./clickup/types.js";
import { resolveConnectorConfig } from "./config.js";
import { logger } from "../log.js";
import { drainBudgetExceeded } from "./push-budget.js";
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
  base_status_category: string | null; // 마지막 동기화(인바운드·푸시) 때의 우리 카테고리 — 그 뒤 로컬 status 편집 여부 판정.
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
//  statusApplied 는 ClickUp 에 상태가 실제로 실렸는가 — 닫힘 코멘트는 이게 참일 때만 보낸다. 상태셋을 못 읽어 status 를
//  아예 안 실었거나 빼고 재시도한 경우 ClickUp 태스크는 열린 채인데 «닫았다»는 코멘트만 붙으면 침묵보다 나쁘다.
async function createSafe(listId: string, body: Record<string, unknown>) {
  try { return { task: await createTask(listId, body), statusApplied: body.status != null }; }
  catch (e) { if (body.status) { const { status, ...b } = body; logger.warn({ name: body.name }, "create status 빼고 재시도"); return { task: await createTask(listId, b), statusApplied: false }; } throw e; }
}
async function updateSafe(taskId: string, body: Record<string, unknown>) {
  try { await updateTask(taskId, body); return { statusApplied: body.status != null }; }
  catch (e) { if (isClickupTaskGone(e)) throw e; if (body.status) { const { status, ...b } = body; logger.warn({ name: body.name }, "update status 빼고 재시도"); await updateTask(taskId, b); return { statusApplied: false }; } throw e; }
}

// 닫힘 근거 코멘트 — 상태 PUT 이 성공한 뒤에만. 실패해도 행은 done 으로 둔다: 상태는 이미 나갔고, 행을 다시 돌리면
//  PUT 은 멱등이어도 코멘트가 성공하는 순간까지 틱마다 재시도가 쌓이며 pending 행이 인바운드 3-way 머지를 계속 막는다.
//  ⚠ 코멘트 유실이 실제로 문제가 되면 이 행의 done 을 풀지 말고 별도 op(예: 'comment')로 재시도 큐를 따로 둘 것.
async function postCloseComment(p: ProjRow, taskExtId: string, note: CloseNote): Promise<void> {
  if (!p.status_category || !CLOSED_CATEGORIES.has(p.status_category)) return; // 드레인 전에 다시 열렸다
  try {
    // 곁들이는 정보(처리자·작업 기록·링크)는 하나씩 실패를 삼킨다 — 그중 하나가 넘어졌다고 코멘트 전체를 잃지 않게.
    const rootId = p.level === "project" ? p.id : (await rootProjectIdOfTaskNode(p).catch(() => undefined)) ?? null;
    const member = note.actor ? await getMember(note.actor).catch(() => null) : null;
    const actorName = member ? ((member.use_nickname && member.nickname) || member.display_name || member.nickname) : null;
    let recentActivity: string | null = null;
    // ⚠ 작업 기록은 **닫힌 그 항목(p.id)** 에 붙은 것만 본다. activity.project_id 는 task·subtask 도 가리키므로, 루트
    //  프로젝트로 찾으면 형제 태스크·다른 세션의 기록이 «이 태스크를 닫은 근거»로 ClickUp 에 나간다(오귀속·반출).
    if (!note.reason) {
      const a: { title: string } | undefined = await one(itemsPool,
        `SELECT title FROM activity WHERE project_id=$1 AND created_at <= $2::timestamptz
            AND created_at > $2::timestamptz - interval '24 hours'
          ORDER BY created_at DESC LIMIT 1`, [p.id, note.at]).catch(() => undefined);
      recentActivity = a?.title?.trim() || null;
    }
    const base = await gatewayUrl().catch(() => null);
    const deepLink = base && rootId ? `${base}/ui/#/projects/${rootId}` : null;
    await createTaskComment(taskExtId, { comment_text: closeCommentText(note, { actorName, recentActivity, deepLink }), notify_all: false });
  } catch (e) {
    logger.warn({ err: e, entity: p.id }, "닫힘 근거 코멘트 실패(상태 푸시는 성공 — 코멘트만 누락)");
  }
}

/** clickupFetch 가 던진 오류가 «그 태스크가 저쪽에 없다»(상태코드 404)인가. */
export function isClickupTaskGone(e: unknown): boolean {
  return e instanceof Error && /^ClickUp 404 /.test(e.message);
}

/**
 * 연결된 태스크로 갱신을 보낸다. 태스크가 ClickUp 에서 지워졌으면 연결을 끊고 "detached".
 *  종전엔 404 도 markErr 로 남겨 매 틱 재시도했다 — 태스크는 돌아오지 않으므로 그 행이 실행마다 실패 1건을 만들고,
 *  연속 실패 서킷브레이커가 push-clickup 전체를 멈췄다. 연결을 끊은 프로젝트는 네이티브가 되어, 다음 변경 때
 *  create 경로로 새 카드가 생긴다(라이블리가 원본이다). 404 가 아닌 오류는 종전대로 던져 재시도한다.
 */
export async function pushLinkedUpsert(o: { update: () => Promise<unknown>; detach: () => Promise<unknown> }): Promise<"pushed" | "detached"> {
  try {
    await o.update();
    return "pushed";
  } catch (e) {
    if (!isClickupTaskGone(e)) throw e;
    await o.detach();
    return "detached";
  }
}

// skipped ≠ deferred — deferred 는 '다음 틱에 다시 시도'(아웃박스 행 유지), skipped 는 '반출 대상이 아니라 닫았다'(행 소비).
//  종전엔 둘을 deferred 로 합산해, 운영자가 큰 deferred 를 보고 일시적 지연으로 오독하면 이번 사고(영구 미반출)를
//  못 알아본다. 두 숫자를 갈라야 '왜 큐가 안 빠지나'를 로그만으로 판정할 수 있다. detached = 저쪽 태스크가 지워져 연결을 끊었다(행 소비).
export async function pushOutbox(opts?: { limit?: number; startedAtMs?: number }): Promise<{ pushed: number; deferred: number; skipped: number; failed: number; deleted: number; detached: number; scanned: number; visited: number; budgetStopped: boolean }> {
  //  원점은 호출자가 넘긴다 — 부모의 하드 타임아웃은 프로세스 스폰부터 재는데 여기서 찍으면
  //   node 부팅·모듈 로드·풀 연결만큼 여유가 조용히 깎인다(run-push 가 performance.timeOrigin 을 넘긴다).
  //   기본값은 지금 — 장수 프로세스가 이 함수를 직접 부를 때 원점이 과거로 밀려 즉시 소진되지 않게.
  const startedAt = opts?.startedAtMs ?? Date.now();
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
      //  ⚠ 상태코드 자리만 본다 — clickupFetch 메시지엔 경로가 실리므로(`ClickUp 429 재시도 초과(5회): /list/9014041…`)
      //   includes("404") 는 id 에 404 가 든 리스트의 일시 실패를 영구로 오판해 status 를 버리고 행을 닫는다.
      const permanent = /^ClickUp 404 /.test(String((e as Error)?.message));
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
  const rows: Array<{ id: number; entity_id: number; op: string; ext_id_snapshot: string | null; attempts: number; close_note: CloseNote | null }> = await q(itemsPool,
    `SELECT o.id, o.entity_id, o.op, o.ext_id_snapshot, o.attempts, o.close_note
       FROM external_outbox o
       LEFT JOIN project p ON p.id = o.entity_id
      WHERE o.system='clickup' AND o.done_at IS NULL
        AND ($2::bool OR o.op <> 'upsert' OR p.external_id IS NOT NULL)
      ORDER BY o.created_at LIMIT $1`, [opts?.limit ?? 200, containerId !== ""]);

  let pushed = 0, deferred = 0, failed = 0, deleted = 0, skipped = 0, detached = 0;
  let budgetStopped = false, visited = 0;
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
    // 시간예산 — 남은 행은 손대지 않고 나간다(pending 그대로 → 다음 틱이 이어받는다). 왜 자발 종료여야
    //  하는지, 예산이 왜 자식 타임아웃보다 작아야 하는지는 push-budget.ts 머리말이 정본이다.
    if (drainBudgetExceeded(startedAt, Date.now())) {
      budgetStopped = true;
      logger.warn({ pushed, visited, scanned: rows.length }, "드레인 시간예산 소진 — 남은 행은 다음 틱에 이어간다");
      break;
    }
    visited++;
    try {
      if (ob.op === "delete") {
        if (ob.ext_id_snapshot) {
          try { await clickupFetch(`/task/${encodeURIComponent(ob.ext_id_snapshot)}`, { method: "DELETE" }); }
          // 이미 없으면 성공 취급. ⚠ 판정은 isClickupTaskGone(상태코드 자리) — includes("404") 는 메시지에 실린 경로까지 봐서
          //  id 에 404 가 든 태스크의 5xx·429 소진을 «이미 없음»으로 닫고 ClickUp 카드를 남겼다.
          catch (e) { if (!isClickupTaskGone(e)) throw e; }
        }
        await markDone(ob.id); deleted++; continue;
      }

      // upsert — 현재 project 행 재읽기(멱등, 최신 상태 푸시).
      const p: ProjRow | undefined = await one(itemsPool,
        `SELECT id, level, parent_id, name, description, status_category, priority, start_date, due_date,
                external_system, external_id, folder,
                external_base->>'list_ext'   AS list_ext,
                external_base->>'status_raw' AS base_status_raw,
                external_base->>'status_category' AS base_status_category
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
      // CREATE 의 부모·타깃 리스트를 status 판정보다 **먼저** 푼다 — 자식이 실릴 리스트가 곧 status 기준 리스트다.
      //  (왜 부모 리스트여야 하는지는 createListFor 머리말 — ITEM_137.)
      const willUpdate = p.external_system === "clickup" && !!p.external_id;
      let parentExt: string | undefined;
      let chainListExts: (string | null)[] = [];
      if (!willUpdate && p.level !== "project") {
        if (p.parent_id == null) { await markDone(ob.id); continue; } // 비정상 — skip
        //  직계 부모(d=0)부터 위로 — 부모의 푸시 여부는 d=0 으로 판정하고, 리스트 좌표는 체인에서 첫 non-null 을
        //  쓴다(왜 한 칸이 아니라 체인인지는 createListFor 머리말). d<8 = 폭주 방지 상한.
        const anc: Array<{ d: number; external_id: string | null; external_system: string | null; list_ext: string | null }> = await q(itemsPool,
          `WITH RECURSIVE anc AS (
             SELECT id, parent_id, external_id, external_system,
                    NULLIF(btrim(external_base->>'list_ext'), '') AS list_ext, 0 AS d
               FROM project WHERE id=$1
             UNION ALL
             SELECT p.id, p.parent_id, p.external_id, p.external_system,
                    NULLIF(btrim(p.external_base->>'list_ext'), ''), anc.d+1
               FROM project p JOIN anc ON p.id = anc.parent_id
              WHERE anc.list_ext IS NULL AND anc.d < 8)
           SELECT d, external_id, external_system, list_ext FROM anc ORDER BY d`, [p.parent_id]);
        const par = anc.find((a) => a.d === 0);
        if (!par || par.external_system !== "clickup" || !par.external_id) { deferred++; continue; } // 부모 미푸시 → 다음 틱
        parentExt = par.external_id;
        chainListExts = anc.map((a) => a.list_ext);
      }
      const createList = createListFor(chainListExts, containerId);

      // status 는 그 카드가 실제로 속한 리스트 기준으로 정한다. 네이티브(아직 카드가 없는 것)는 이번에 만들 리스트가
      //  곧 그 자리이므로 그 리스트의 상태셋을 쓴다.
      // 리스트 좌표가 없으면 컨테이너로 폴백한다. `list_ext` 는 인바운드가 채우는 값이라 **푸시로 방금 만든
      //  카드**엔 첫 인바운드 싱크 전까지 없다(create 가 병합하는 base 에 그 키가 없다). 빈 상태셋으로 두면
      //  그 구간의 status 가 조용히 빠져 이 수정이 고치려는 결함을 다시 만든다. 컨테이너 밖 카드에 폴백이
      //  잘못 걸려도 ClickUp 이 거부하고 updateSafe 가 status 를 빼고 재시도해 종전과 같아진다.
      const listForStatus = (p.external_id ? p.list_ext : null) ?? (createList || null);
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
        baseCategory: p.base_status_category,
      });
      const body = mkBody(p, status);
      // 푸시하는 ours 값 → external_base 갱신(#6d 3-way 의 공통조상). 인바운드가 이 base 로 외부편집 변화를 판정.
      //  #541: **병합**(|| 연산) — 통째 교체하면 인바운드 미러가 관리하는 확장 키(status_raw/assignee/list_ext/tags)가
      //  푸시 때마다 소거되어 다음 3-way 가 base=NULL 로 동작한다. 푸시에 실리는 필드만 전진(name/desc/category/priority/dates).
      const baseJson = JSON.stringify({
        name: p.name, description: p.description, status_category: p.status_category,
        priority: p.priority, start_date: p.start_date, due_date: p.due_date,
      });

      if (willUpdate && p.external_id) {
        const extId = p.external_id;
        let statusApplied = false;
        const r = await pushLinkedUpsert({
          update: async () => { ({ statusApplied } = await updateSafe(extId, body)); },
          detach: () => itemsPool.query(
            `UPDATE project SET external_system=NULL, external_instance=NULL, external_id=NULL, external_url=NULL,
                    external_base=NULL, updated_at=now() WHERE id=$1`, [p.id]),
        });
        if (r === "detached") {
          logger.warn({ project: p.id, task: extId }, "ClickUp 태스크가 지워져 연결을 끊었다(다음 변경 때 컨테이너 리스트에 새 카드 — 자식은 부모가 다시 생긴 뒤)");
          await markDone(ob.id); detached++; continue;
        }
        await itemsPool.query(
          `UPDATE project SET external_base = COALESCE(external_base, '{}'::jsonb) || $2::jsonb WHERE id=$1`,
          [p.id, baseJson]);
        await markDone(ob.id); pushed++;
        if (ob.close_note && statusApplied) await postCloseComment(p, p.external_id, ob.close_note);
        else if (ob.close_note) logger.warn({ entity: p.id }, "닫힘 근거 코멘트 생략 — status 가 ClickUp 에 실리지 않았다(상태셋 미해소·거부·저쪽이 이미 닫힘)");
      } else {
        // CREATE — 부모(project-Task / task-Subtask) external_id 는 위에서 해소했다(미푸시면 이미 defer).
        // 위 SELECT 가 컨테이너 부재 시 external_id 없는 행을 뽑지 않으므로, 여기 닿는 건 다른 시스템 미러
        //  (external_system≠clickup — 예: 노션 미러 프로젝트)뿐이다. create 할 자리가 없으니 닫는다.
        if (!containerId) { await markDone(ob.id); skipped++; continue; }
        const { task: ct, statusApplied } = await createSafe(createList, { ...body, ...(parentExt ? { parent: parentExt } : {}) });
        const url = ct.url || `https://app.clickup.com/t/${ct.id}`;
        await itemsPool.query(
          `UPDATE project SET external_system='clickup', external_instance=$2, external_id=$3, external_url=$4,
                  external_base = COALESCE(external_base, '{}'::jsonb) || $5::jsonb, updated_at=now() WHERE id=$1`,
          [p.id, teamId, ct.id, url, baseJson]);
        await markDone(ob.id); pushed++;
        if (ob.close_note && statusApplied) await postCloseComment(p, ct.id, ob.close_note); // 첫 푸시 전에 이미 닫힌 경우
        else if (ob.close_note) logger.warn({ entity: p.id }, "닫힘 근거 코멘트 생략 — status 가 ClickUp 에 실리지 않았다(상태셋 미해소·거부)");
      }
    } catch (e) {
      await markErr(ob.id, (e as Error)?.message ?? String(e)); failed++;
      logger.warn({ err: e, outbox: ob.id, entity: ob.entity_id }, "outbox 푸시 실패(다음 틱 재시도)");
    }
  }
  logger.info({ pushed, deferred, skipped, failed, deleted, detached, scanned: rows.length, visited, budgetStopped }, "clickup outbox 드레인 완료");
  return { pushed, deferred, skipped, failed, deleted, detached, scanned: rows.length, visited, budgetStopped };
}
