// #177 아웃바운드 드레인 — external_outbox(pending) → ClickUp create/update/delete. run-sync(인바운드)의 역방향.
//  우리 DB=master: 로컬 편집을 ClickUp 미러에 반영. 멱등(현재 project 행 재읽기 → upsert), 부분실패 안전(행별 try/catch + attempts).
//  매핑(인바운드와 대칭): project=top-level Task(컨테이너 List 안), task=Subtask(parent=project-Task), subtask=중첩 Subtask.
//   부모 미푸시(external_id 없음)면 그 자식은 defer(이번 틱 skip) — 다음 틱에 부모 푸시 후 수렴.
//  status: **그 카드가 속한 리스트**의 상태셋에서 뽑는다(판정은 clickup/push-status.ts). 불일치 시 status 빼고 1회 재시도.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { clickupFetch, createTask, updateTask, getTeam, createTaskComment, getTask } from "./clickup.js";
import { CLOSED_CATEGORIES, closeCommentText, type CloseNote } from "./clickup/close-comment.js";
import { rootProjectIdOfTaskNode } from "../v6/project-store.js";
import { getMember } from "../org/store/members.js";
import { gatewayUrl } from "../gateway-url.js";
import { statusesForList, decidePushStatus } from "./clickup/push-status.js";
import { createListFor, needsAncestorChain, statusListFor, createUnderParent, isParentNotInList } from "./clickup/push-target.js";
import type { ClickUpStatus, ClickUpList, ClickUpSpace } from "./clickup/types.js";
import { resolveConnectorConfig } from "./config.js";
import { logger } from "../log.js";
import { drainBudgetExceeded } from "./push-budget.js";
import { classifyPushFailure, parksAfter, parkedSql, parkedParams, notifyParked, isMassRejection, MASS_REJECT_MARK, type ParkedRow } from "./push-failure.js";
import { sendBoxAlert } from "../ops/alerts.js";
import { hiddenProjects } from "../v6/visibility.js";
import { PUBLIC_VIEWER } from "../v6/visibility.js";

// 상태셋 로드 일시실패를 언제까지 미룰지 — 넘으면 status 없이 진행한다(무한 재시도가 큐 머리를 점거하지 않게).
//  ⚠ 기준은 **그 행의 누적 attempts** 다(상태셋 전용 카운터가 아니다 — 일반 push 실패와 같은 칸을 쓴다).
//   그래서 이미 여러 번 실패한 행은 상태셋 재시도 기회가 줄거나 없다. 재enqueue 시 attempts 는 0 으로 리셋된다.
const STATUS_LOAD_RETRY_LIMIT = 5;
// 치유 재시도(createUnderParent)에서 고친 리스트의 상태셋을 일시적으로 못 읽었다 — 정상 경로의 statusLoadFailed 처럼
//  «이번엔 미룬다» 이지 실행 실패가 아니다. 행 루프의 catch 가 분류보다 먼저 deferred 로 처리한다.
class StatusLoadDeferred extends Error {}
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
  //  ITEM_137(부모 리스트 불일치)은 status 와 무관하다 — status 를 빼고 다시 보내도 같은 400 이 나므로 바로 던진다(createUnderParent 가 처리).
  catch (e) { if (isParentNotInList(e)) throw e; if (body.status) { const { status, ...b } = body; logger.warn({ name: body.name }, "create status 빼고 재시도"); return { task: await createTask(listId, b), statusApplied: false }; } throw e; }
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
 * 단건 조회 오류가 «이 토큰의 워크스페이스에서 그 태스크를 볼 수 없다»(401 OAUTH_027 Team not authorized)인가.
 *  카드가 이 토큰이 권한 없는 다른 워크스페이스로 옮겨지면 이렇게 온다(2026-10-11 실측). 우리 쪽에서는 지워진 것과 같다.
 *  같은 워크스페이스의 비공개 공간 거부는 다른 코드로 오므로 여기 해당하지 않는다(종전대로 던져 재시도).
 *  ⚠ 토큰 자체가 죽은 경우와 구분해야 한다 — 이 판정은 «같은 토큰으로 방금 create 가 인증을 통과해 ITEM_137 을 받은 뒤»
 *   부모를 조회할 때만 쓴다(createUnderParent 의 lookupParentList). 일반 경로에서 쓰면 토큰 장애를 «카드 없음» 으로 덮는다.
 */
export function isClickupTaskInaccessible(e: unknown): boolean {
  return e instanceof Error && /^ClickUp 401 /.test(e.message) && /OAUTH_027/.test(e.message);
}

/**
 * 치유한 부모 좌표를 기록한다(createUnderParent 의 onHealed). 행동은 clickup-push-heal.pg-test.mjs 가 실 PG 로 잠근다.
 *
 *  · 좌표는 **원래 값이 있던** 부모(인바운드가 채운 미러)에만 고쳐 쓴다. 비어 있던 부모는 push 로 만든 네이티브 카드라
 *    base.list_ext 를 써 두면 첫 인바운드의 list_id 수렴이 뒤집힌다(push-target.ts createListFor 머리말). 그 경우는
 *    이번 생성만 고친 리스트로 하고 좌표는 그대로 둔다.
 *  · base 를 고칠 때 list_id 도 인바운드가 했을 것처럼 옮긴다 — base 만 바꾸면 다음 인바운드의 3-way(base=새 값,
 *    ours=옛 리스트, theirs=새 값)가 ours 를 채택해 로컬 배치가 옛 리스트에 고정된다(mirror-project.ts 「외부 이동
 *    수렴」). 로컬에서 따로 옮겨 둔 부모(ours≠base)는 그대로 둔다.
 *  · 🔴 새 리스트가 미러돼 있지 않으면(수집 범위 밖으로 옮겨짐 — 이 치유가 필요한 바로 그 상황) list_id 를 **그대로
 *    둔다.** NULL 로 비우면 그 프로젝트는 «미분류 = 전원 공개»(v6/visibility.ts canSeeProjectRow)가 되어, 잠긴 리스트에
 *    있던 프로젝트와 그 태스크가 조직 전체에 열리고 리스트 화면에서도 사라진다. 인바운드는 범위 밖 카드를 다시 보지
 *    않으니 인바운드가 했을 일도 아니다 — 공개범위는 fail-closed 다. 대가: 그 리스트가 나중에 미러되면 3-way
 *    (t==b → ours)로 옛 리스트에 남는다(사람이 옮기면 된다 — 열리는 쪽보다 낫다).
 */
export async function recordHealedParentList(parentId: number, listExt: string): Promise<void> {
  await itemsPool.query(
    `UPDATE project SET
            list_id = CASE
              WHEN (SELECT pl.external_id FROM project_list pl WHERE pl.id = project.list_id) = (external_base->>'list_ext')
              THEN COALESCE((SELECT pl.id FROM project_list pl
                     WHERE pl.external_system='clickup' AND pl.external_instance=project.external_instance AND pl.external_id=$2), list_id)
              ELSE list_id END,
            external_base = external_base || jsonb_build_object('list_ext', $2::text),
            updated_at=now()
      WHERE id=$1 AND NULLIF(btrim(external_base->>'list_ext'), '') IS NOT NULL`, [parentId, listExt]);
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

// 아직 반출되지 않은 아웃박스 항목 수(전체). 실패는 -1 = «모름» — 감시가 그 값을 버린다.
async function countPending(): Promise<number> {
  try {
    const row: { n: string | number } | undefined = await one(itemsPool,
      `SELECT count(*) AS n FROM external_outbox WHERE system='clickup' AND done_at IS NULL`);
    return row ? Number(row.n) : -1;
  } catch { return -1; }
}

// 그중 파킹된 행 수(push-failure.ts). 실행마다 요약에 실어, 새로 파킹될 때 한 번 나가는 경보를 놓쳐도 남아 있게 한다.
async function countParked(): Promise<number> {
  try {
    const row: { n: string | number } | undefined = await one(itemsPool,
      `SELECT count(*) AS n FROM external_outbox o WHERE o.system='clickup' AND o.done_at IS NULL AND ${parkedSql(1)}`, parkedParams());
    return row ? Number(row.n) : -1;
  } catch { return -1; }
}

// skipped ≠ deferred — deferred 는 '다음 틱에 다시 시도'(아웃박스 행 유지), skipped 는 '반출 대상이 아니라 닫았다'(행 소비).
//  종전엔 둘을 deferred 로 합산해, 운영자가 큰 deferred 를 보고 일시적 지연으로 오독하면 이번 사고(영구 미반출)를
//  못 알아본다. 두 숫자를 갈라야 '왜 큐가 안 빠지나'를 로그만으로 판정할 수 있다. detached = 저쪽 태스크가 지워져 연결을 끊었다(행 소비).
//  failed 는 시스템성 실패만 센다(exit 1 → 브레이커). 행 고유 거절은 rejected 로 따로 세고, 반복되면 파킹한다(push-failure.ts).
export async function pushOutbox(opts?: { limit?: number; startedAtMs?: number }): Promise<{ pushed: number; deferred: number; skipped: number; failed: number; rejected: number; parkedNow: number; parked: number; deleted: number; detached: number; scanned: number; visited: number; budgetStopped: boolean; remaining: number }> {
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
        AND NOT ${parkedSql(3)}
      ORDER BY o.created_at LIMIT $1`, [opts?.limit ?? 200, containerId !== "", ...parkedParams()]);

  let pushed = 0, deferred = 0, failed = 0, rejected = 0, deleted = 0, skipped = 0, detached = 0;
  let parkedRows: ParkedRow[] = [];
  const rejectedIds: number[] = [];
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
      //  (왜 부모 리스트여야 하는지는 createListFor 머리말 — ITEM_137.) 연결된 카드라도 자기 좌표가 없으면(push 로
      //  만든 자식 — 첫 인바운드 전) 같은 체인으로 태어난 리스트를 푼다(왜인지는 needsAncestorChain 머리말 — 상태 원복).
      const willUpdate = p.external_system === "clickup" && !!p.external_id;
      let parentExt: string | undefined;
      let parentId: number | undefined;
      let chainListExts: (string | null)[] = [];
      if (needsAncestorChain({ level: p.level, linked: willUpdate, ownListExt: p.list_ext, hasParent: p.parent_id != null })) {
        if (p.parent_id == null) { await markDone(ob.id); continue; } // 비정상 — skip(create 만 여기 온다)
        //  직계 부모(d=0)부터 위로 — 부모의 푸시 여부는 d=0 으로 판정하고, 리스트 좌표는 체인에서 첫 non-null 을
        //  쓴다(왜 한 칸이 아니라 체인인지는 createListFor 머리말). d<8 = 폭주 방지 상한.
        const anc: Array<{ d: number; id: number; external_id: string | null; external_system: string | null; list_ext: string | null }> = await q(itemsPool,
          `WITH RECURSIVE anc AS (
             SELECT id, parent_id, external_id, external_system,
                    NULLIF(btrim(external_base->>'list_ext'), '') AS list_ext, 0 AS d
               FROM project WHERE id=$1
             UNION ALL
             SELECT p.id, p.parent_id, p.external_id, p.external_system,
                    NULLIF(btrim(p.external_base->>'list_ext'), ''), anc.d+1
               FROM project p JOIN anc ON p.id = anc.parent_id
              WHERE anc.list_ext IS NULL AND anc.d < 8)
           SELECT d, id, external_id, external_system, list_ext FROM anc ORDER BY d`, [p.parent_id]);
        chainListExts = anc.map((a) => a.list_ext);
        //  부모가 올라갔는지는 create 만 본다 — 갱신 행은 status 기준 리스트(statusListFor)를 위해 체인만 읽는다.
        if (!willUpdate) {
          const par = anc.find((a) => a.d === 0);
          if (!par || par.external_system !== "clickup" || !par.external_id) {
            //  부모가 곧 올라갈 때(부모 행이 큐에 있음)만 기다린다. 부모가 반출 대상이 아니면(리스트 매핑이 없어
            //   skip 됐거나, 카드가 지워져 연결을 끊었거나) 부모를 다시 올릴 경로가 없어 자식이 영영 deferred 로 남는다.
            //   그때는 자식도 닫는다. 부모가 나중에 반출되면 자식은 다음 편집 때 다시 큐에 들어와 그 아래에 만들어진다.
            //  파킹된 부모(사람이 고쳐야 하는 거절)도 pending 이라 자식은 기다린다 — 부모가 풀리면 그대로 이어 올라간다.
            //  같은 드레인 앞쪽에서 부모가 만들어졌으면 위 anc 재조회가 이미 external_id 를 본다(부모 CREATE 는
            //   project.external_id 를 쓴 뒤에 markDone 한다).
            const parentQueued = par ? await one(itemsPool,
              `SELECT 1 FROM external_outbox WHERE system='clickup' AND entity_id=$1 AND done_at IS NULL LIMIT 1`, [par.id]) : undefined;
            if (parentQueued) { deferred++; continue; } // 부모 미푸시 → 다음 틱
            logger.info({ project: p.id, parent: p.parent_id }, "부모가 ClickUp 에 없고 반출 대기도 아니라 자식 반출을 닫는다");
            await markDone(ob.id); skipped++; continue;
          }
          parentExt = par.external_id;
          parentId = par.id;
        }
      }
      const createList = createListFor(chainListExts, containerId);

      // status 는 그 카드가 실제로 속한 리스트 기준으로 정한다(statusListFor) — 연결된 카드는 자기 좌표, 없으면 태어난
      //  리스트(위 체인)다. 네이티브(아직 카드가 없는 것)는 이번에 만들 리스트가 곧 그 자리다.
      //  체인이 끝까지 비면 컨테이너로 폴백한다 — 네이티브 top-level 계보는 컨테이너에 태어나고, 빈 상태셋으로 두면 그
      //  구간의 status 가 조용히 빠진다. 그래도 어긋나면 ClickUp 이 거부하고 updateSafe 가 status 를 빼고 재시도한다.
      const listForStatus = statusListFor({ linked: !!p.external_id, ownListExt: p.list_ext, createList });
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
          //  아직 안 올라간 자식은 기다리지 않는다 — 이 행이 큐에 없으니 자식을 다음에 볼 때 «부모가 반출 대상이 아님» 으로
          //   닫힌다(위 부모 미반출 분기). 부모가 다시 올라간 뒤 그 자식을 다시 편집하면 그 아래에 만들어진다.
          logger.warn({ project: p.id, task: extId }, "ClickUp 태스크가 지워져 연결을 끊었다(다음 변경 때 새 카드 — 아직 안 올라간 자식의 반출은 닫힌다, 부모가 다시 올라간 뒤 다시 편집하면 그 아래에 만들어진다)");
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
        //  부모 좌표가 낡았으면 저쪽 카드에서 다시 읽어 한 번 고쳐 만든다(createUnderParent 머리말 — ITEM_137 재발).
        //   고친 리스트에선 상태셋이 다를 수 있으니 status 를 그 리스트 기준으로 다시 정한다.
        const bodyForList = async (listId: string) => {
          //  상태셋을 못 읽었으면 status 없이 만들지 않는다 — 위 STATUS_LOAD_RETRY_LIMIT 가드와 같은 이유(변경 영구 유실)이고
          //   상한도 같다(넘으면 status 없이 진행). 정상 경로처럼 **미룸**으로 처리한다(StatusLoadDeferred → catch 에서
          //   deferred) — 실패로 세면, 좌표를 기록하지 않는 네이티브 부모 아래에서는 이 경로가 매 틱 다시 돌아 상한에 닿기
          //   전에 연속 실패 브레이커가 먼저 선다(기본 max_fail_streak 5 = 이 상한 5). 좌표가 기록된 부모(list_ext 보유)면
          //   다음 틱은 정상 경로가 그 가드를 탄다.
          const { statuses: st, failed: stFailed } = await statusesOf(listId);
          if (stFailed && ob.attempts < STATUS_LOAD_RETRY_LIMIT) throw new StatusLoadDeferred(`list ${listId} 상태셋 로드 실패(치유 재시도) — 다음 틱 재시도`);
          return mkBody(p, decidePushStatus({
            ourCategory: p.status_category, theirStatusRaw: p.base_status_raw, statuses: st, baseCategory: p.base_status_category,
          }));
        };
        const made = await createUnderParent({
          listId: createList,
          parentExt,
          create: async (listId, healed) =>
            createSafe(listId, { ...(healed ? await bodyForList(listId) : body), ...(parentExt ? { parent: parentExt } : {}) }),
          lookupParentList: async (ext) => {
            try { return { kind: "list", listId: (await getTask(ext)).list?.id ?? "" }; }
            catch (err) { if (isClickupTaskGone(err) || isClickupTaskInaccessible(err)) return { kind: "gone" }; throw err; }
          },
          //  무엇을 어떻게 고쳐 쓰는지(좌표가 있던 부모만 · list_id 는 미러된 리스트로만)는 recordHealedParentList 머리말.
          onHealed: (_ext, listId) => parentId == null ? Promise.resolve() : recordHealedParentList(parentId, listId),
        });
        if (made.kind === "parent_gone") {
          //  부모 카드가 저쪽에서 지워졌다 — 갱신 경로의 404 와 같은 규율로 부모 연결을 끊는다(pushLinkedUpsert 머리말).
          //   부모가 네이티브가 되면 이 행은 «부모 미푸시» 로 미뤄지고, 부모가 다시 생기면 그 아래에 만들어진다.
          await itemsPool.query(
            `UPDATE project SET external_system=NULL, external_instance=NULL, external_id=NULL, external_url=NULL,
                    external_base=NULL, updated_at=now() WHERE id=$1`, [parentId]);
          logger.warn({ project: p.id, parent: parentExt }, "부모 ClickUp 카드가 지워졌거나 이 워크스페이스에서 볼 수 없어 부모 연결을 끊었다(자식은 부모가 다시 생긴 뒤)");
          deferred++; continue;
        }
        if (made.listId !== createList) logger.warn({ project: p.id, parent: parentExt, from: createList, to: made.listId }, "부모 리스트 좌표가 낡아 저쪽 값으로 고쳐 만들었다(ITEM_137)");
        const { task: ct, statusApplied } = made.result;
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
      const msg = (e as Error)?.message ?? String(e);
      await markErr(ob.id, msg);
      //  치유 재시도의 상태셋 로드 일시 실패는 정상 경로(statusLoadFailed: markErr + deferred)와 같이 미룬다 — 실행 실패가
      //   아니다(bodyForList 주석). 분류보다 먼저 빠져야 시스템성 failed 로 세지 않는다.
      if (e instanceof StatusLoadDeferred) { deferred++; continue; }
      const kind = classifyPushFailure(e);
      if (kind === "systemic") { failed++; logger.warn({ err: e, outbox: ob.id, entity: ob.entity_id }, "outbox 푸시 실패(다음 틱 재시도)"); continue; }
      rejected++; rejectedIds.push(ob.id);
      if (parksAfter(ob.attempts, kind)) {
        parkedRows.push({ outboxId: ob.id, entityId: ob.entity_id, error: msg });
        logger.warn({ err: e, outbox: ob.id, entity: ob.entity_id }, "outbox 행이 같은 거절을 반복해 드레인 대상에서 뺐다(파킹 — 재편집 시 해제)");
      } else {
        logger.warn({ err: e, outbox: ob.id, entity: ob.entity_id }, "outbox 행 거절(행 고유 — 실행 실패로 세지 않음, 다음 틱 재시도)");
      }
    }
  }
  //  일괄 거절 — 한 실행에서 거절만 여럿이고 반출이 0건이면 행 탓이 아니라 설정 탓(컨테이너 리스트 삭제·오설정 등)이다.
  //   그대로 두면 전 행이 3틱 뒤 하나씩 파킹되고, 설정을 고쳐도 항목마다 다시 편집해야 풀린다(종전엔 브레이커가 멈추고
  //   설정을 고치면 전부 복구됐다). 그래서 이 경우는 시스템성 실패로 올리고, last_error 앞에 표식을 붙여 파킹 술어
  //   (`^ClickUp 4xx` 앵커)에서 빠지게 한다 — 다음 성공 실행이나 재enqueue 가 덮어써 표식은 저절로 사라진다.
  if (isMassRejection({ rejected, pushed })) {
    await itemsPool.query(
      `UPDATE external_outbox SET last_error = $2 || COALESCE(last_error, '') WHERE id = ANY($1::bigint[])`,
      [rejectedIds, MASS_REJECT_MARK]);
    logger.warn({ rejected, pushed }, "반출이 0건인데 거절이 여럿이다 — 설정 문제로 보고 실행 실패로 올린다(파킹하지 않는다)");
    failed += rejected; rejected = 0; parkedRows = [];
  }
  //  새로 파킹된 행은 다음 실행부터 선택되지 않으므로 이 자리가 그 행의 유일한 알림 기회다.
  await notifyParked(parkedRows, sendBoxAlert);
  //  이번 배치가 아니라 **전체** 잔여다 — 정체 감시가 「예산을 다 쓰고도 줄지 않았나」를 보려면
  //   배치 상한(LIMIT)에 잘리지 않은 수가 필요하다. 못 세면 -1(모름) — 0 으로 뭉개면 감시가 눈을 감는다.
  //  파킹된 행도 remaining 에 포함한다(pending 이 맞다). 정체 판정은 «예산을 쓰고도 안 줄었나» 라서 실행 사이에 변하지
  //   않는 파킹 수는 전진 판정에 영향이 없고, 빼면 그 행들이 어떤 수치에도 안 잡혀 조용히 사라진다. 내역은 parked 로 따로 싣는다.
  const remaining = await countPending();
  const parked = await countParked();
  const parkedNow = parkedRows.length;
  logger.info({ pushed, deferred, skipped, failed, rejected, parkedNow, parked, deleted, detached, scanned: rows.length, visited, budgetStopped, remaining }, "clickup outbox 드레인 완료");
  return { pushed, deferred, skipped, failed, rejected, parkedNow, parked, deleted, detached, scanned: rows.length, visited, budgetStopped, remaining };
}
