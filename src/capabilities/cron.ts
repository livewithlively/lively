// org_cron 관리 capability — 서버사이드 스케줄 잡 CRUD + 즉시실행. admin scope(게이트웨이 운영 — 멤버머신 runtime 아님).
//  웹 관리탭(REST /api/ui/cron)·MCP 양쪽 노출. 보안: action 은 allowlist(스키마 CHECK + 여기 zod enum) — 임의 셸 금지.
//  실행 엔진은 scheduler.ts(인프로세스). 여기는 정의(org_cron 행)만 관리 + run_now 위임.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { itemsPool } from "../items/store.js";
import { runCronById, CRON_ACTIONS, CRON_ACTION_KEYS } from "../scheduler.js";
import { isValidCron } from "../cron-expr.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseCronId(v: unknown): string {
  const id = String(v ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, "id 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
  return id;
}

const cronList: Capability = {
  name: "cron_list",
  title: "스케줄 잡 목록",
  description: "서버사이드 스케줄 잡(org_cron) 목록 — 액션·주기·enabled·마지막 실행 상태/요약·다음 실행. 트리거 표준화의 관리 표면.",
  scope: "admin",
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/cron"], parse: () => ({}) }],
  },
  handler: async () => ({ jobs: (await itemsPool.query(`SELECT * FROM org_cron ORDER BY sort, id`)).rows, actions: CRON_ACTIONS }),
};

const cronSet: Capability = {
  name: "cron_set",
  title: "스케줄 잡 생성/수정",
  description:
    "스케줄 잡을 upsert(id 기준). action 은 등록된 액션 레지스트리(CRON_ACTIONS) 중 하나(임의 셸 불가). " +
    "스케줄 2모드: cron_expr(절대 벽시계 5필드, 예 '0 9 * * 1-5')가 있으면 그게 우선, 없으면 interval_sec(상대, 최소 60s). " +
    "cron_expr=\"\"(빈문자열)로 보내면 interval 모드로 되돌림. params=액션 인자(예: refresh_repo→{repo}, connector_sync→{system}). 커스텀 잡은 이걸로 추가.",
  scope: "admin",
  input: {
    id: z.string(),
    action: z.string().optional(),
    label: z.string().max(200).optional(),
    params: z.record(z.unknown()).optional(),
    interval_sec: z.number().int().min(60).optional(),
    cron_expr: z.string().max(120).optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(2000).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/cron"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        id: b.id, action: b.action, label: b.label, params: b.params,
        interval_sec: b.interval_sec != null ? Number(b.interval_sec) : undefined,
        cron_expr: b.cron_expr != null ? String(b.cron_expr) : undefined,
        enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
        note: b.note,
      };
    } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const id = parseCronId(input.id);
    const actor = ctx?.actor ?? user?.userId ?? null;
    if (input.action && !CRON_ACTION_KEYS.includes(input.action)) {
      throw new HttpError(400, "action 이 allowlist 밖입니다 — 등록된 액션: " + CRON_ACTION_KEYS.join(", "));
    }
    // cron_expr: ""=명시적 비움(interval 모드 복귀), 미제공=유지(수정 시), 값=검증 후 설정.
    if (input.cron_expr != null && input.cron_expr !== "" && !isValidCron(input.cron_expr)) {
      throw new HttpError(400, "cron_expr 가 올바르지 않습니다(5필드: 분 시 일 월 요일, 예: '0 9 * * 1-5' / '*/10 * * * *')");
    }
    const cronProvided = input.cron_expr !== undefined;
    const cronVal: string | null = input.cron_expr === "" ? null : (input.cron_expr ?? null);

    const existing = (await itemsPool.query(`SELECT id FROM org_cron WHERE id=$1`, [id])).rows[0];
    if (!existing) {
      if (!input.action) throw new HttpError(400, "신규 잡은 action 이 필요합니다");
      const r = await itemsPool.query(
        `INSERT INTO org_cron(id,label,action,params,interval_sec,cron_expr,enabled,note,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,true),$8,$9,$9) RETURNING *`,
        [id, input.label ?? null, input.action, JSON.stringify(input.params ?? {}),
         input.interval_sec ?? 600, cronVal, input.enabled ?? null, input.note ?? null, actor]);
      return { job: r.rows[0] };
    }
    const r = await itemsPool.query(
      `UPDATE org_cron SET
         label=COALESCE($2,label), action=COALESCE($3,action),
         params=COALESCE($4,params), interval_sec=COALESCE($5,interval_sec),
         cron_expr = CASE WHEN $6::boolean THEN $7::text ELSE cron_expr END,
         enabled=COALESCE($8,enabled), note=COALESCE($9,note),
         version=version+1, updated_at=now(), updated_by=$10
       WHERE id=$1 RETURNING *`,
      [id, input.label ?? null, input.action ?? null,
       input.params != null ? JSON.stringify(input.params) : null,
       input.interval_sec ?? null, cronProvided, cronVal,
       input.enabled ?? null, input.note ?? null, actor]);
    return { job: r.rows[0] };
  },
};

const cronDelete: Capability = {
  name: "cron_delete",
  title: "스케줄 잡 삭제",
  description:
    "스케줄 잡을 삭제한다. ⚠ 시드 기본 잡(refresh-all-domainmap)은 삭제해도 재부팅 시 시드(ON CONFLICT DO NOTHING)가 다시 만든다 — 끄려면 cron_set 으로 enabled=false.",
  scope: "admin",
  input: { id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/cron/:id/delete"], parse: (req) => ({ id: req.params?.id }) }],
  },
  handler: async (input: any) => {
    const id = parseCronId(input.id);
    const r = await itemsPool.query(`DELETE FROM org_cron WHERE id=$1`, [id]);
    return { deleted: (r.rowCount ?? 0) > 0, id };
  },
};

const cronRunNow: Capability = {
  name: "cron_run_now",
  title: "스케줄 잡 즉시 실행",
  description: "스케줄 잡을 주기와 무관하게 지금 1회 실행(온디맨드 'refresh now'). 결과 요약 반환. 이미 실행 중이면 skip.",
  scope: "admin",
  input: { id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/cron/:id/run"], parse: (req) => ({ id: req.params?.id }) }],
  },
  handler: async (input: any) => runCronById(parseCronId(input.id)),
};

export const cronCapabilities: Capability[] = [cronList, cronSet, cronDelete, cronRunNow];
