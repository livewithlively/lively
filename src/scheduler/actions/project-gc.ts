// 크론 액션: 자동 생성 프로젝트 정리(project_gc). 판정은 project-gc-plan.ts(순수), 여기는 후보 조회와 쓰기다.
//
//  ── 쓰기는 웹·REST 와 같은 길로 ──
//  닫기·휴지통은 capability 핸들러(project_set_status_v6 · task_set_status_v6 · project_trash_v6)를 그대로 부른다.
//   스토어 UPDATE 를 직접 하면 외부 미러 푸시(external_outbox)·닫힘 사유 코멘트·감사·AGENTS.md 재생성·세션 묶음 처리 중
//   무언가가 빠진다 — 그 목록을 여기서 따라가며 맞추지 않기 위해 같은 입구를 쓴다.
//
//  ── 워크스페이스 ──
//  이 액션은 SQL 에 워크스페이스 조건을 쓰지 않는다. 엔진(engine.ts tickAllTenants)이 잡을 그 워크스페이스의 테넌트
//   컨텍스트 안에서 돌리고, itemsPool 파사드의 바인딩과 행 수준 보안이 어느 행이 보이는지를 정한다 — 다른 정비 액션과 같은 규율이다.
//   그래서 이 파일 안에서 withTenant 를 다시 걸거나 테넌트를 순회하면 안 된다(남의 워크스페이스를 대신 치우게 된다).
//   격리는 project-gc-tenant.pg-test.mjs 가 앱 역할 · FORCE RLS 로 잰다.
import { itemsPool, q } from "../../db/client.js";
import type { CronJob } from "../registry.js";
import type { LivelyUser } from "../../context.js";
import type { Capability, CapabilityCtx } from "../../capabilities/types.js";
import { childBudgetAllows, gcCloseReason, localDateOf, parseGcOptions, planProjectGc, type GcPick, type GcRow } from "./project-gc-plan.js";

/** 세션이 이 시간 안에 활동했으면 «지금 쓰는 중» 으로 보고 쓰기 직전에 건너뛴다(손길 기준과 별개로, 판정과 쓰기 사이의 경합 방어). */
export const LIVE_SESSION_WINDOW_HOURS = 24;

/** 직계 하위가 이 수 이상이면 기록으로 본다. 세션이 이름을 지으면 그 세션의 태스크 하나가 자동으로 생기므로(v6/session-task.ts) 하나는 기록이 아니다. */
export const RECORD_MIN_DIRECT_CHILDREN = 2;

const OPEN = (alias: string) =>
  `${alias}.status <> 'done' AND COALESCE(${alias}.status_category, '') NOT IN ('done', 'canceled')`;

/**
 * 가족(agg: root, ids)에 지금 붙어 있는 세션과 그 세션의 마지막 활동 시각(sess: root, max_active).
 *
 *  ⚠ execution_session.last_seen 만으로는 활동을 못 잰다 — claim·소속 변경·revision ACK 때만 오르고, 매 턴 문맥 조회는
 *   revision 이 바뀔 때만 ACK 한다(terminal/session-project-routes.ts sessionProjectContext). 2주 전에 붙어 매일 쓰는 세션도
 *   last_seen 은 2주 전이다. 그래서 실제 대화 활동 시각을 함께 본다:
 *    · session.last_seen — 대화 기록 미러의 마지막 활동(기록 줄의 시각, v6/session-log-store.ts lastActivityAt)
 *    · org_session_state.last_prompt_at(사람이 마지막으로 시킨 때) · last_busy(마지막 작업 관측, epoch 초)
 *    · org_session_conv.last_seen(박스 ↔ 대화 매핑이 마지막으로 보고된 때)
 *  «붙어 있다» = 실행 세션의 현재 소속 · 박스 행의 현재 프로젝트 · 세션 구간 중 그 세션의 마지막 구간이 가족을 가리킴.
 *  세션 id 는 박스 id · 대화 uuid · 외부 실행 id 가 섞여 있어 양쪽으로 펼쳐 맞춘다. 외부 실행 id 는 하네스 접두 + 하네스가 준 대화 id 다
 *   (접두 목록의 출처 kit/hooks/run-custom.mjs executionSessionId) — 접두를 떼면 대화 기록 미러의 키가 된다.
 *  ⚠ 외부 하네스 세션은 박스 행이 없어 last_prompt_at·last_busy 가 없다. 그 하네스에 기록 캡처 훅이 없으면 대화 기록 미러도 비어
 *   활동 신호가 실행 세션 last_seen 뿐이다 — 그런 세션은 실제로 쓰여도 손길이 오래돼 보일 수 있다.
 */
const SESSION_CTES = `
bound AS (
  SELECT a.root, x.sid FROM agg a CROSS JOIN LATERAL (
    SELECT xs.id AS sid FROM execution_session xs WHERE xs.desired_project_id = ANY(a.ids) OR xs.task_id = ANY(a.ids)
    UNION
    SELECT st.id FROM org_session_state st WHERE st.project_id = ANY(a.ids) AND st.project_src IS DISTINCT FROM 'org'
    UNION
    SELECT o.session_id FROM (
      SELECT DISTINCT ON (sp.session_id) sp.session_id, sp.project_id FROM session_project sp
       WHERE sp.session_id IN (SELECT s0.session_id FROM session_project s0 WHERE s0.project_id = ANY(a.ids))
       ORDER BY sp.session_id, sp.valid_from DESC) o
     WHERE o.project_id = ANY(a.ids)
  ) x
), convs AS (
  SELECT b.root, c.cid FROM bound b CROSS JOIN LATERAL (
    SELECT b.sid
    UNION SELECT regexp_replace(b.sid, '^(codex|claude|cursor)-', '')
    UNION SELECT oc.conv_uuid FROM org_session_conv oc WHERE oc.box_id = b.sid
    UNION SELECT st.claude_session_id FROM org_session_state st WHERE st.id = b.sid AND st.claude_session_id IS NOT NULL
  ) c(cid)
), boxes AS (
  SELECT b.root, x.bid FROM bound b CROSS JOIN LATERAL (
    SELECT b.sid
    UNION SELECT oc.box_id FROM org_session_conv oc WHERE oc.conv_uuid = b.sid
    UNION SELECT st.id FROM org_session_state st WHERE st.claude_session_id = b.sid
  ) x(bid)
), sess AS (
  SELECT u.root, max(u.at) AS max_active FROM (
    SELECT c.root, s.last_seen AS at FROM convs c JOIN session s ON s.session_id = c.cid
    UNION ALL
    SELECT x.root, GREATEST(st.last_prompt_at, to_timestamp(NULLIF(st.last_busy, 0))) FROM boxes x JOIN org_session_state st ON st.id = x.bid
    UNION ALL
    SELECT x.root, oc.last_seen FROM boxes x JOIN org_session_conv oc ON oc.box_id = x.bid
    UNION ALL
    SELECT b.root, xs.last_seen FROM bound b JOIN execution_session xs ON xs.id = b.sid
  ) u GROUP BY u.root
)`;

/**
 * 후보 SQL — 정리 대상 프로젝트마다 가족(프로젝트 + 하위 태스크 + 그 서브태스크)을 모아 기록 유무·마지막 손길·보호 여부를 잰다.
 *  $1 표식 · $2 이보다 오래된 손길만(일 — 두 단계 기준 중 짧은 쪽) · $3 조직 시간대의 오늘(YYYY-MM-DD, 기한 비교).
 *  보호 = 열린 가족 노드에 기한이 남았거나, 사람이 만든 노드에 담당자가 있다. 담당자는 사람이 만든 노드에서만 센다 — 세션 태스크는
 *   세션 주인을 담당자로 자동 지정하고(v6/session-task.ts ensureSessionTask) name_source 가 session 으로 태어나 이름을 지어도 agent 까지만
 *   오른다. 사람이 그 태스크를 골라 열면 human 으로 올라간다(bindSessionTask) — 그때부터는 사람의 의사다. NULL 은 human 이다
 *   (컬럼 이전 행 · task_create_v6 로 만든 태스크).
 *  기록 = 직계 하위가 RECORD_MIN_DIRECT_CHILDREN 이상이거나, 가족 어디든 아래 rec 의 흔적이 하나라도 있다.
 *   rec 에는 사람이 남기는데 project.updated_at 을 올리지 않는 쓰기(댓글·체크리스트·첨부·시간 기록·프로젝트 대화·팀원)를 함께 넣는다 —
 *   빠지면 댓글만 달린 프로젝트가 «기록 없음» 으로 휴지통에 간다.
 *  손길 = 가족 updated_at · 세션 구간 시작 · rec 흔적 시각 · 붙은 세션의 활동(SESSION_CTES) 중 최댓값.
 */
export const CANDIDATE_SQL = `
WITH target AS (
  SELECT p.id, p.name_source
    FROM project p
   WHERE p.level = 'project'
     AND p.trashed_at IS NULL AND p.archived_at IS NULL
     AND ${OPEN("p")}
     AND strpos(COALESCE(p.description, ''), $1) > 0
     AND COALESCE(p.name_source, 'rule') <> 'human'
     AND COALESCE(p.created_by, '') NOT LIKE 'connector:%'
), fam AS (
  SELECT t.id AS root, n.id, n.parent_id, n.updated_at, n.status, n.status_category, n.created_by, n.name_source, n.due_date, n.assignee FROM target t JOIN project n ON n.id = t.id
  UNION ALL
  SELECT t.id, c.id, c.parent_id, c.updated_at, c.status, c.status_category, c.created_by, c.name_source, c.due_date, c.assignee FROM target t JOIN project c ON c.parent_id = t.id
  UNION ALL
  SELECT t.id, g.id, g.parent_id, g.updated_at, g.status, g.status_category, g.created_by, g.name_source, g.due_date, g.assignee FROM target t JOIN project c ON c.parent_id = t.id JOIN project g ON g.parent_id = c.id
), agg AS (
  SELECT f.root,
         array_agg(f.id) AS ids,
         max(f.updated_at) AS max_updated,
         count(*) FILTER (WHERE f.parent_id = f.root) AS direct_children,
         count(*) FILTER (WHERE f.id <> f.root AND ${OPEN("f")} AND COALESCE(f.created_by, '') NOT LIKE 'connector:%') AS open_children,
         bool_or(${OPEN("f")} AND (f.due_date >= $3
                   OR (COALESCE(f.name_source, 'human') = 'human'
                       AND (f.assignee IS NOT NULL OR EXISTS (SELECT 1 FROM task_assignee ta WHERE ta.task_id = f.id))))) AS protected
    FROM fam f GROUP BY f.root
), ${SESSION_CTES}, scored AS (
  SELECT t.id, t.name_source, a.open_children, COALESCE(a.protected, false) AS protected,
         (a.direct_children >= ${RECORD_MIN_DIRECT_CHILDREN} OR rec.n > 0) AS has_record,
         GREATEST(a.max_updated, sp.at, rec.at, se.max_active) AS last_touch
    FROM target t
    JOIN agg a ON a.root = t.id
    LEFT JOIN sess se ON se.root = t.id
    CROSS JOIN LATERAL (SELECT max(s.created_at) AS at FROM session_project s WHERE s.project_id = ANY(a.ids)) sp
    CROSS JOIN LATERAL (
      SELECT count(*) AS n, max(r.at) AS at FROM (
        SELECT k.added_at AS at FROM project_knowledge k WHERE k.project_id = ANY(a.ids)
        UNION ALL SELECT x.created_at FROM activity x WHERE x.project_id = ANY(a.ids)
        UNION ALL SELECT e.created_at FROM project_edge e WHERE e.from_project_id = ANY(a.ids) OR e.to_project_id = ANY(a.ids)
        UNION ALL SELECT c.created_at FROM task_comment c WHERE c.task_id = ANY(a.ids)
        UNION ALL SELECT GREATEST(cl.created_at, (SELECT max(i.created_at) FROM task_checklist_item i WHERE i.checklist_id = cl.id))
                    FROM task_checklist cl WHERE cl.task_id = ANY(a.ids)
        UNION ALL SELECT ta.created_at FROM task_attachment ta WHERE ta.task_id = ANY(a.ids)
        UNION ALL SELECT GREATEST(te.created_at, te.started_at, te.ended_at) FROM task_time_entry te WHERE te.task_id = ANY(a.ids)
        UNION ALL SELECT pc.updated_at FROM project_chat pc WHERE pc.project_id = ANY(a.ids)
        UNION ALL SELECT pm.added_at FROM project_member pm WHERE pm.project_id = ANY(a.ids)
      ) r) rec
)
SELECT * FROM scored
 WHERE last_touch < now() - make_interval(days => $2::int)
 ORDER BY last_touch, id`;

/** 쓰기 직전 확인 — 이 프로젝트 가족에 붙은 세션 중 최근에 활동한 것이 있나(소유자 무관). $1 프로젝트 · $2 창(시간). */
const LIVE_GUARD_SQL = `
WITH agg AS (
  SELECT $1::int AS root, ARRAY(
    SELECT $1::int
    UNION ALL SELECT c.id FROM project c WHERE c.parent_id = $1
    UNION ALL SELECT g.id FROM project c JOIN project g ON g.parent_id = c.id WHERE c.parent_id = $1) AS ids
), ${SESSION_CTES}
SELECT COALESCE((SELECT max_active FROM sess) > now() - make_interval(hours => $2::int), false) AS live`;

/** 함께 닫을 열린 하위 — 서브태스크 먼저(부모보다 먼저 닫는다). 커넥터가 만든 하위는 외부 원본의 몫이라 건드리지 않는다. */
const OPEN_CHILDREN_SQL = `
SELECT n.id FROM (
  SELECT c.id, c.status, c.status_category, c.created_by, 1 AS depth FROM project c WHERE c.parent_id = $1
  UNION ALL
  SELECT g.id, g.status, g.status_category, g.created_by, 2 FROM project c JOIN project g ON g.parent_id = c.id WHERE c.parent_id = $1
) n
 WHERE ${OPEN("n")} AND COALESCE(n.created_by, '') NOT LIKE 'connector:%'
 ORDER BY n.depth DESC, n.id`;

export async function candidateRows(minDays: number, now: Date = new Date()): Promise<GcRow[]> {
  //  표식 모듈은 프로젝트 스토어까지 끌고 와 동적으로 읽는다 — 레지스트리가 이 파일을 정적으로 로드한다(registry.ts 머리말).
  const { AUTO_CREATED_MARK } = await import("../../project/first-prompt-project.js");
  const { orgTimezone } = await import("../../org/timezone.js");
  const rows = await q(itemsPool, CANDIDATE_SQL, [AUTO_CREATED_MARK, minDays, localDateOf(now, await orgTimezone())]);
  return rows.map((r) => ({
    id: Number(r.id),
    nameSource: r.name_source == null ? null : String(r.name_source),
    hasRecord: !!r.has_record,
    lastTouch: new Date(r.last_touch),
    protected: !!r.protected,
    openChildren: Number(r.open_children ?? 0),
  }));
}

export async function hasLiveSession(projectId: number): Promise<boolean> {
  const rows = await q(itemsPool, LIVE_GUARD_SQL, [projectId, LIVE_SESSION_WINDOW_HOURS]);
  return !!rows[0]?.live;
}

interface GcCaps { setStatus: Capability; setTaskStatus: Capability; trash: Capability }

async function loadCaps(): Promise<GcCaps> {
  const { projectV6Capabilities } = await import("../../capabilities/projects-v6.js");
  const byName = (n: string): Capability => {
    const c = projectV6Capabilities.find((x) => x.name === n);
    if (!c) throw new Error(`capability ${n} 없음`);
    return c;
  };
  return { setStatus: byName("project_set_status_v6"), setTaskStatus: byName("task_set_status_v6"), trash: byName("project_trash_v6") };
}

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};
const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);

export async function runProjectGc(params: Record<string, unknown>, job: CronJob): Promise<{ status: string; summary: unknown }> {
  const opts = parseGcOptions(params);
  const rows = await candidateRows(Math.min(opts.emptyDays, opts.idleDays));
  const plan = planProjectGc(rows, opts, new Date());
  const halted = plan.empty.halted || plan.idle.halted;
  const summary: Record<string, unknown> = {
    ...(halted ? { halted: true } : {}),
    mode: plan.mode,
    params: { empty_days: opts.emptyDays, idle_days: opts.idleDays, batch_trash: opts.batchTrash, batch_close: opts.batchClose, batch_children: opts.batchChildren, cap: opts.cap },
    protected_excluded: plan.protectedExcluded,
    empty: plan.empty,
    idle: plan.idle,
  };
  if (halted) {
    //  멈춘 단계는 요약에만 두면 아무도 안 본다 — 엔진의 자동 정지 알림과 같은 운영 경보로 한 줄 알린다. 실패는 아니라 status 는 ok.
    const { sendBoxAlert } = await import("../../ops/alerts.js");
    await sendBoxAlert({
      severity: "warn",
      title: `자동 생성 프로젝트 정리 멈춤 — ${job.id}`,
      text: `단계별 후보가 상한(cap ${opts.cap})을 넘어 그 단계를 건너뛰었습니다(empty ${plan.empty.candidates} · idle ${plan.idle.candidates}). `
        + `기준 일수나 손길 계산을 확인한 뒤 cap 을 조정하세요.`,
      detail: { job: job.id, mode: plan.mode, empty: plan.empty.candidates, idle: plan.idle.candidates, cap: opts.cap },
    }).catch(() => undefined);
  }
  if (!plan.writes.trash.length && !plan.writes.close.length) return { status: "ok", summary };

  //  실행 신원 — `cron:<잡 id>` 는 다른 크론 액션의 행위자 표기와 같다. 다만 이 파일은 그 값을 capability 핸들러의 LivelyUser 로
  //   쓰는 첫 자리다. 그 신원은 멤버가 아니라서 세션 가시성(terminal/write-cap.ts)이 0 이다 — project_trash_preview_v6 의
  //   live_others · 휴지통 핸들러의 «남의 도는 세션» 409 가 이 신원에겐 늘 0 으로 나온다. 그래서 살아 있는 세션은 핸들러에
  //   기대지 않고 hasLiveSession(소유자 무관 SQL)으로 직접 센다. 감사·외부 코멘트의 처리자 축도 이 값이다(멤버가 아니라 이름 줄은 빠진다).
  const actor = "cron:" + job.id;
  const user: LivelyUser = { userId: actor, email: "", scopes: [], projects: ["*"] };
  // viewer=null 은 내부 경로(가시성 필터 없음) — 이 잡이 도는 워크스페이스의 행은 전부 대상이다.
  const ctx: CapabilityCtx = { actor, source: "cron", viewer: null };
  const caps = await loadCaps();
  //  trashed = 닫고 휴지통까지 · closed = 닫기만(close 단계) · closed_not_trashed = 닫았는데 휴지통이 거부·실패해 닫힌 채 남은 것
  //  skipped_live = 쓰기 직전 활동 중인 세션이 보여 아무것도 안 한 것 · deferred = 다시 읽은 하위가 회차 예산을 넘어 미룬 것
  const done = { trashed: 0, closed: 0, closed_not_trashed: 0, children_closed: 0, skipped_live: 0, deferred: 0,
    errors: [] as Array<{ id: number; step: string; error: string; closed?: true }> };

  /** 하위까지 닫는다. 하위 예산이 모자라면 아무것도 안 하고 false. */
  const closeFamily = async (p: GcPick): Promise<boolean> => {
    const reason = gcCloseReason(p.idleDays);
    const children = await q(itemsPool, OPEN_CHILDREN_SQL, [p.id]);
    if (!childBudgetAllows(done.children_closed, children.length, opts.batchChildren)) return false;
    for (const c of children) {
      await caps.setTaskStatus.handler({ id: Number(c.id), status: "done", reason }, user, ctx);
      done.children_closed++;
    }
    //  status_raw=null — 웹이 상태 칸 없이 완료를 보낼 때와 같이 리스트 커스텀 상태명을 지운다. 남기면 «완료» 인데 옛 커스텀 상태가 보인다.
    await caps.setStatus.handler({ id: p.id, status: "done", status_raw: null, reason }, user, ctx);
    return true;
  };

  for (const p of plan.writes.trash) {
    let closed = false;
    try {
      if (await hasLiveSession(p.id)) { done.skipped_live++; continue; }
      if (!(await closeFamily(p))) { done.deferred++; continue; }
      closed = true;
      await caps.trash.handler({ id: p.id, trashed: true }, user, ctx);
      done.trashed++;
    } catch (e) {
      if (!closed) { done.errors.push({ id: p.id, step: "close", error: errText(e) }); continue; }
      //  닫힌 사실은 남긴다 — 외부 미러 카드도 이미 닫혔다. 409(세션 묶음 거부)는 실패가 아니라 «닫힌 채 남음» 이다.
      done.closed_not_trashed++;
      if (statusOf(e) !== 409) done.errors.push({ id: p.id, step: "trash", error: errText(e), closed: true });
    }
  }
  for (const p of plan.writes.close) {
    try {
      if (await hasLiveSession(p.id)) { done.skipped_live++; continue; }
      if (!(await closeFamily(p))) { done.deferred++; continue; }
      done.closed++;
    } catch (e) { done.errors.push({ id: p.id, step: "close", error: errText(e) }); }
  }

  const errorCount = done.errors.length;
  summary.done = { ...done, errors: done.errors.slice(0, 5), error_count: errorCount };
  // 아무것도 못 닫고 실패만 있으면 error — 서킷 브레이커가 세는 건 error 뿐이다(cron-breaker.ts).
  const wrote = done.trashed + done.closed + done.closed_not_trashed;
  return { status: errorCount && !wrote ? "error" : "ok", summary };
}
