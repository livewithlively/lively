// 수집 단위 표(#4213 T10 #4742) — 저장·조회. 판정(담당·알림·분류·공개범위 계산)은 unit-plan.ts(순수)가 하고,
//  여기는 DB 와 그 판정을 잇는다. 설계 정본: 지식 connect-collect-tobe-claude-connector-4213 §2.
//
//  ── 다른 과업이 부르는 함수(이름·인자 고정 — 태스크 #4742 «병렬 착수 경계») ──
//   T11 수집 실행: listAssignedUnits(member) → 맡은 단위·읽은 위치 · storeUnitItems(unit, items) → 원문 저장(같은 외부 좌표는
//     한 건 · 볼 수 있는 사람 합치기) · advanceUnitCursor(unit, {member}, {cursor}) → 읽은 위치 · recordUnitListing(…) → 목록 반영 ·
//     recordCollectOutcome(…) → 실행 결과로 담당 건강을 바꾸고 멈춘 단위의 볼 사람에게 «다시 로그인» 을 알린다.
//   T6 커넥터 상태: markAssigneeHealthy(member, connector?) — 다시 연결된 것을 본 쪽이 부른다.
//   리브·화면(capabilities/collect-units.ts): listUnitsFor · updateUnit · splitUnit · syncCollectorUnits.
//
//  ⚠ 원문 저장은 upsertSource 가 아니라 mirrorSourceV6 다 — upsertSource 는 id 가 없으면 그냥 INSERT 해 같은 외부 좌표가
//   두 행이 된다. 외부 좌표 합치기(source_external_uidx ON CONFLICT)의 정본은 mirrorSourceV6 다(태스크 #4742 댓글 #408).
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import type { RawItem } from "../../items/store.js";
import { mirrorSourceV6 } from "../../v6/mirror/mirror-source.js";
import { applyVisibility, pickRule, sourceVisRules, type SourceVisRule } from "../../v6/source-vis-policy.js";
import { axisOn } from "../../v6/visibility-axes.js";
import { auditOrgContent, type WriteCtx } from "../../v6/content-audit.js";
import { detectAuthFailure } from "../../node/task-failure.js";
import { failReason } from "../store/run-fail-reason.js";
import { normalizeExternalInstance } from "../ingest/external-identity.js";
import { currentTenant } from "../tenant-context.js";
import {
  ANY_CONNECTOR, COLLECT_ROUTES, UNIT_STATES,
  canAdvanceCursor, canEditUnit, canSeeUnit, classifyCollectRun, computeAudience, connectorKey, healthIndex,
  isCollectorRoute, listingClaimAllowed, noticeTargets, normalizeListing, planUnit, retryDelayMs, splitOverreach,
  type AssigneeState, type AudiencePolicy, type CollectRoute, type CollectRunExit, type CollectRunSummary, type HealthChange,
  type HealthIndex, type NoticeTarget, type PlanCollector, type PlanHealth, type PlanUnit, type UnitKind, type UnitPlan, type UnitState,
} from "./unit-plan.js";

type Q = Pick<pg.PoolClient, "query">;

/** 단위가 주기를 아직 안 가졌을 때 «다시 읽을 때가 됐나» 의 기본 간격(T12 가 단위 글 빈도로 덮는다). */
export const DEFAULT_UNIT_INTERVAL_SEC = 3600;

/** 측정한 claude.ai 커넥터 이름(«claude.ai » 뒤) — 단위에 connector 가 비었을 때만 쓴다. 목록 반영이 정확한 이름을 남긴다. */
const CONNECTOR_OF_APP: Record<string, string> = {
  slack: "Slack", notion: "Notion", gmail: "Gmail", gdrive: "Google Drive", outlook: "Microsoft 365",
};
export function connectorOfApp(app: string): string {
  return CONNECTOR_OF_APP[app] ?? app;
}

/** 앱 키 — source.external_system 과 같은 공간(slack·notion·gmail·gdrive·github …). */
export function normalizeAppKey(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
  if (!s) throw new UnitError(400, "앱(app)이 비었습니다 — source 의 외부 시스템 키(slack·notion·gmail …)를 주세요");
  return s;
}

export class UnitError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ── 행 모양 ──────────────────────────────────────────────────────────────────

export interface UnitMember { member_id: string; priority: number; via: string; added_at: string; seen_at: string }
export interface UnitRow {
  id: number; app: string; instance: string; ref: string; kind: UnitKind; name: string | null;
  parent_id: number | null; route: CollectRoute; collector_id: number | null; connector: string | null;
  state: UnitState; cursor: Record<string, unknown>; read_at: string | null; read_by: string | null;
  last_item_at: string | null; interval_sec: number | null; description: string | null; meta: Record<string, unknown>;
  created_at: string; updated_at: string; updated_by: string | null;
  members: UnitMember[];
}

const UNIT_COLS = `u.id, u.app, u.instance, u.ref, u.kind, u.name, u.parent_id, u.route, u.collector_id, u.connector, u.state,
  u.cursor, u.read_at, u.read_by, u.last_item_at, u.interval_sec, u.description, u.meta, u.created_at, u.updated_at, u.updated_by`;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());

function mapUnit(r: Record<string, any>): UnitRow {
  const members = (Array.isArray(r.members) ? r.members : []) as Array<Record<string, unknown>>;
  return {
    id: Number(r.id), app: String(r.app), instance: String(r.instance ?? ""), ref: String(r.ref),
    kind: String(r.kind) as UnitKind, name: r.name ?? null, parent_id: r.parent_id == null ? null : Number(r.parent_id),
    route: String(r.route) as CollectRoute, collector_id: r.collector_id == null ? null : Number(r.collector_id),
    connector: r.connector ?? null, state: String(r.state) as UnitState,
    cursor: (r.cursor && typeof r.cursor === "object") ? r.cursor : {},
    read_at: iso(r.read_at), read_by: r.read_by ?? null, last_item_at: iso(r.last_item_at),
    interval_sec: r.interval_sec == null ? null : Number(r.interval_sec), description: r.description ?? null,
    meta: (r.meta && typeof r.meta === "object") ? r.meta : {},
    created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!, updated_by: r.updated_by ?? null,
    members: members.map((m) => ({
      member_id: String(m.member_id), priority: Number(m.priority), via: String(m.via ?? "listing"),
      added_at: iso(m.added_at)!, seen_at: iso(m.seen_at)!,
    })),
  };
}

/** 단위 + 볼 수 있는 구성원(후보 줄 순서). where 는 u 별칭 기준 SQL 조각. */
async function loadUnits(q: Q, where = "TRUE", params: unknown[] = []): Promise<UnitRow[]> {
  const r = await q.query(
    `SELECT ${UNIT_COLS},
            COALESCE(json_agg(json_build_object('member_id', m.member_id, 'priority', m.priority, 'via', m.via,
                                                'added_at', m.added_at, 'seen_at', m.seen_at)
                     ORDER BY m.priority, m.added_at, m.member_id) FILTER (WHERE m.member_id IS NOT NULL), '[]') AS members
       FROM collect_unit u LEFT JOIN collect_unit_member m ON m.unit_id = u.id
      WHERE ${where}
      GROUP BY u.id
      ORDER BY u.app, u.instance, u.name NULLS LAST, u.ref`, params);
  return r.rows.map(mapUnit);
}

export async function getUnit(id: number, q: Q = itemsPool): Promise<UnitRow | null> {
  return (await loadUnits(q, "u.id = $1", [id]))[0] ?? null;
}

// ── 담당 건강 · 수집기 상태 ──────────────────────────────────────────────────

async function loadHealth(q: Q, members: readonly string[]): Promise<PlanHealth[]> {
  if (!members.length) return [];
  const r = await q.query(
    `SELECT member_id, connector, state, since, retry_at, notified_at FROM collect_assignee_state WHERE member_id = ANY($1::text[])`,
    [members]);
  return r.rows.map((x: any) => ({
    member_id: String(x.member_id), connector: String(x.connector), state: String(x.state) as AssigneeState,
    since: ms(x.since) ?? 0, retry_at: ms(x.retry_at), notified_at: ms(x.notified_at),
  }));
}

interface CollectorInfo {
  id: number; preset: string; enabled: boolean; broken: boolean; include: string[]; exclude: string[]; token_source: string;
  /** 이 수집기가 모으는 외부 인스턴스 — 슬랙 bot:<팀> · 노션 config.instance. null 이면 가리지 않는다. */
  instance: string | null;
}

/** 수집기 설정에서 «무엇을 모으나» 를 담는 칸 — 비면 «전부». 앱마다 이름이 다르다(connectors/config.ts CONNECTOR_SPECS). */
const SCOPE_KEYS: Record<string, { include: string[]; exclude: string[] }> = {
  slack: { include: ["channels"], exclude: ["noise_exclude"] },
  github: { include: ["repos"], exclude: [] },
  gitlab: { include: ["projects"], exclude: [] },
  linear: { include: ["teams"], exclude: [] },
  discord: { include: ["channels"], exclude: [] },
  gdrive: { include: ["folders"], exclude: [] },
  figma: { include: ["file_keys", "team_ids"], exclude: ["exclude_files"] },
  notion: { include: ["root_pages"], exclude: ["exclude_pages"] },
};
const scopeToken = (s: string): string => s.trim().replace(/^#/, "").toLowerCase().replace(/-/g, "");
function scopeList(config: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) for (const t of String(config?.[k] ?? "").split(/[\s,]+/)) if (t.trim()) out.push(scopeToken(t));
  return out;
}

/** 수집기 목록 + «끊겼나» — 마지막으로 끝난 실행이 자격 실패(오류 + 인증 문구)면 끊김이다. 실행 기록이 없으면 끊기지 않은 것으로 본다. */
async function loadCollectors(q: Q): Promise<CollectorInfo[]> {
  let rows: any[] = [];
  try {
    rows = (await q.query(`SELECT id, preset_key, enabled, config FROM org_collector`)).rows;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[collect-unit] 수집기 목록을 못 읽었다 — 수집기 경로 단위는 «꺼짐» 으로 본다");
    return [];
  }
  const broken = new Set<number>();
  const ids = rows.filter((r) => r.enabled).map((r) => Number(r.id));
  if (ids.length) {
    try {
      const runs = await q.query(
        `SELECT DISTINCT ON (collector_id) collector_id, status, right(log, 2000) AS tail
           FROM connector_run WHERE collector_id = ANY($1::bigint[]) AND status <> 'running'
          ORDER BY collector_id, started_at DESC`, [ids]);
      for (const r of runs.rows as any[]) {
        if (r.status !== "error") continue;
        if (detectAuthFailure({ error: `${failReason(r.tail) ?? ""}\n${String(r.tail ?? "")}` })) broken.add(Number(r.collector_id));
      }
    } catch { /* 실행 기록 표가 아직 없다(첫 실행 전) — 끊김 없음 */ }
  }
  return rows.map((r) => {
    const preset = String(r.preset_key);
    const cfg = (r.config && typeof r.config === "object") ? r.config as Record<string, unknown> : {};
    const keys = SCOPE_KEYS[preset] ?? { include: [], exclude: [] };
    const ts = String(cfg.token_source ?? "");
    const team = /^bot:([A-Za-z0-9]+)$/.exec(ts)?.[1] ?? null;
    const inst = preset === "notion" && cfg.instance && cfg.instance !== "default" ? String(cfg.instance) : null;
    return {
      id: Number(r.id), preset, enabled: !!r.enabled, broken: broken.has(Number(r.id)),
      include: scopeList(cfg, keys.include), exclude: scopeList(cfg, keys.exclude), token_source: ts,
      instance: preset === "slack" ? team : inst,
    };
  });
}

/** 수집기 경로 단위의 수집기 — 그 단위를 모으는 켜진 수집기(설정 범위가 덮는 것)를 모아 하나로 본다. */
function unitCollector(u: Pick<UnitRow, "app" | "instance" | "ref" | "name" | "collector_id">, collectors: readonly CollectorInfo[]): PlanCollector | null {
  const ref = scopeToken(u.ref), name = u.name ? scopeToken(u.name) : null;
  const hit = (list: string[]): boolean => list.includes(ref) || (!!name && list.includes(name));
  const covering = collectors.filter((c) =>
    c.id === u.collector_id
    || (c.preset === u.app && (c.instance == null || c.instance === u.instance)
        && (c.include.length === 0 || hit(c.include)) && !hit(c.exclude)));
  const on = covering.filter((c) => c.enabled);
  if (!on.length) return covering.length ? { id: covering[0].id, enabled: false, broken: false } : null;
  const healthy = on.find((c) => !c.broken);
  return healthy ? { id: healthy.id, enabled: true, broken: false } : { id: on[0].id, enabled: true, broken: true };
}

function toPlanUnit(u: UnitRow, collectors: readonly CollectorInfo[]): PlanUnit {
  return {
    id: u.id, route: u.route, state: u.state,
    connector: u.connector ?? connectorOfApp(u.app),
    collector: isCollectorRoute(u.route) ? unitCollector(u, collectors) : null,
    candidates: u.members.map((m) => ({ member_id: m.member_id, priority: m.priority, added_at: ms(m.added_at) ?? 0 })),
  };
}

export interface PlannedUnits { units: UnitRow[]; plans: Map<number, UnitPlan>; idx: HealthIndex }

/** 단위들의 담당을 지금 기준으로 정한다(저장하지 않는다 — 담당은 늘 그 자리에서 다시 판정한다: 건강·수집기·구성원이 바뀌면 바로 따라간다). */
export async function planUnits(units: UnitRow[], q: Q = itemsPool, now = Date.now()): Promise<PlannedUnits> {
  const members = [...new Set(units.flatMap((u) => u.members.map((m) => m.member_id)))];
  const [health, collectors, sourceAxisOn] = await Promise.all([
    loadHealth(q, members),
    units.some((u) => isCollectorRoute(u.route)) ? loadCollectors(q) : Promise.resolve([] as CollectorInfo[]),
    axisOn("source"),
  ]);
  const idx = healthIndex(health);
  const plans = new Map<number, UnitPlan>();
  for (const u of units) plans.set(u.id, planUnit(toPlanUnit(u, collectors), idx, { now, sourceAxisOn }));
  return { units, plans, idx };
}

// ── T11: 담당자별 맡은 단위 · 읽은 위치 ───────────────────────────────────────

export interface AssignedUnit {
  id: number; app: string; instance: string; ref: string; kind: UnitKind; name: string | null;
  connector: string; rank: number;
  cursor: Record<string, unknown>; read_at: string | null; last_item_at: string | null;
  interval_sec: number; due: boolean;
  description: string | null; knowhow: unknown;
  /** 이 단위에서 떼어 낸 자식 단위의 ref — 이 단위를 읽을 때 건너뛴다(자식은 볼 수 있는 사람이 달라 따로 모은다). */
  exclude_refs: string[];
  /** 수집기가 끊겨 넘어온 단위 — 읽은 위치가 수집기 쪽에 있어 last_item_at 부터 읽는다. */
  from_collector: boolean;
}

/**
 * 이 구성원이 **지금** 모아야 할 단위 — 구성원 경로에서 이 사람이 담당(건강한 첫 후보)인 수집 중 단위.
 *  수집기 경로 단위도 수집기가 끊겨 넘어왔으면 들어간다. connector 를 주면 그 커넥터 단위만, dueOnly 면 주기가 된 것만.
 *  ⚠ 같은 사람의 실행은 한 번에 하나다(T11 collect-run 409) — 호출부가 앱들을 한 판에 묶는다.
 */
export async function listAssignedUnits(memberId: string, opts: { connector?: string | null; dueOnly?: boolean; now?: number } = {}): Promise<AssignedUnit[]> {
  if (!memberId) return [];
  await ensureCollectorUnitsFresh();
  const now = opts.now ?? Date.now();
  const units = await loadUnits(itemsPool,
    `u.state = 'active' AND EXISTS (SELECT 1 FROM collect_unit_member x WHERE x.unit_id = u.id AND x.member_id = $1)`, [memberId]);
  const { plans } = await planUnits(units, itemsPool, now);
  const mine = units.filter((u) => {
    const a = plans.get(u.id)?.assignee;
    return a?.kind === "member" && a.member_id === memberId;
  });
  const want = opts.connector ? connectorKey(opts.connector) : null;
  const children = mine.length
    ? await itemsPool.query(`SELECT parent_id, ref FROM collect_unit WHERE parent_id = ANY($1::int[])`, [mine.map((u) => u.id)])
    : { rows: [] as any[] };
  const kids = new Map<number, string[]>();
  for (const r of children.rows as any[]) kids.set(Number(r.parent_id), [...(kids.get(Number(r.parent_id)) ?? []), String(r.ref)]);
  const out: AssignedUnit[] = [];
  for (const u of mine) {
    const connector = u.connector ?? connectorOfApp(u.app);
    if (want && connectorKey(connector) !== want) continue;
    const interval = u.interval_sec ?? DEFAULT_UNIT_INTERVAL_SEC;
    const due = u.read_at == null || now - (ms(u.read_at) ?? 0) >= interval * 1000;
    if (opts.dueOnly && !due) continue;
    const a = plans.get(u.id)!.assignee as { kind: "member"; rank: number };
    out.push({
      id: u.id, app: u.app, instance: u.instance, ref: u.ref, kind: u.kind, name: u.name, connector, rank: a.rank,
      cursor: u.cursor, read_at: u.read_at, last_item_at: u.last_item_at, interval_sec: interval, due,
      description: u.description, knowhow: (u.meta as Record<string, unknown>).knowhow ?? null,
      exclude_refs: kids.get(u.id) ?? [], from_collector: isCollectorRoute(u.route),
    });
  }
  return out;
}

/**
 * 읽은 위치를 옮긴다 — **지금 담당만**. 담당이 아니면(1순위가 회복돼 담당이 바뀐 뒤 늦게 끝난 실행 등) 거절한다.
 *  자료 저장은 외부 좌표로 합쳐지므로 거절돼도 해가 없다 — 다음 담당이 옛 위치부터 다시 읽어도 중복 행이 생기지 않는다.
 */
export async function advanceUnitCursor(
  unitId: number, by: { member?: string | null; collector_id?: number | null },
  next: { cursor?: Record<string, unknown> | null; readAt?: string | Date | null; lastItemAt?: string | Date | null },
): Promise<{ ok: boolean; reason?: string }> {
  const u = await getUnit(unitId);
  if (!u) return { ok: false, reason: "no_unit" };
  const { plans } = await planUnits([u]);
  const plan = plans.get(u.id)!;
  if (!canAdvanceCursor(plan, by)) return { ok: false, reason: plan.assignee ? "not_assignee" : plan.reason };
  const readBy = by.member ? String(by.member) : `collector:${by.collector_id}`;
  await itemsPool.query(
    `UPDATE collect_unit SET
        cursor = COALESCE($2::jsonb, cursor),
        read_at = COALESCE($3::timestamptz, now()), read_by = $4,
        last_item_at = CASE WHEN $5::timestamptz IS NULL THEN last_item_at
                            WHEN last_item_at IS NULL OR $5::timestamptz > last_item_at THEN $5::timestamptz
                            ELSE last_item_at END,
        updated_at = now()
      WHERE id = $1`,
    [unitId, next.cursor == null ? null : JSON.stringify(next.cursor), next.readAt ?? null, readBy, next.lastItemAt ?? null]);
  return { ok: true };
}

// ── 자료 저장 · 볼 수 있는 사람 ──────────────────────────────────────────────

const AUDIENCE_BATCH = 500;

/** 정책 하나를 «단위 몫» 으로 — 조직 공개범위 정책(#1291 v4)이 그 앱·채널을 묶었으면 그 대상. 못 읽으면 null 이 아니라 던진다. */
function policyFor(rules: SourceVisRule[], app: string, ref: string, name: string | null): AudiencePolicy {
  const p = pickRule(rules, app, [ref, name]);
  return { visibility: p.visibility, members: p.members };
}

/**
 * 자료들의 볼 수 있는 사람을 다시 맞춘다 — 단위가 공개범위를 정하는 연결(audience=true)만 본다.
 *  그 자료를 들여온 단위마다 «단위 구성원 ∩ 조직 정책» 의 합집합. 지금 대상과 같으면 손대지 않는다(감사·행 교체 소음 없음).
 *  정책을 못 읽으면 닫는 쪽(대상 0)으로 — 열어 두면 정책 위반이 유출로 굳는다(stampSourceVisibility 와 같은 규칙).
 */
export async function applySourceAudience(q: Q, sourceIds: readonly number[]): Promise<number> {
  const ids = [...new Set(sourceIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return 0;
  let rules: SourceVisRule[] | null = null;
  try { rules = await sourceVisRules(); }
  catch { logger.warn({ n: ids.length }, "[collect-unit] 공개범위 정책을 못 읽었다 — 단위 자료를 닫힌 채로 둔다(정책 복구 뒤 다시 맞춘다)"); }
  let changed = 0;
  for (let i = 0; i < ids.length; i += AUDIENCE_BATCH) {
    const chunk = ids.slice(i, i + AUDIENCE_BATCH);
    const links = await q.query(
      `SELECT us.source_id, u.app, u.ref, u.name,
              COALESCE(array_agg(m.member_id) FILTER (WHERE m.member_id IS NOT NULL), '{}') AS viewers
         FROM collect_unit_source us JOIN collect_unit u ON u.id = us.unit_id
         LEFT JOIN collect_unit_member m ON m.unit_id = us.unit_id
        WHERE us.source_id = ANY($1::int[]) AND us.audience
        GROUP BY us.source_id, u.id`, [chunk]);
    const bySource = new Map<number, Array<{ viewers: string[]; app: string; ref: string; name: string | null }>>();
    for (const r of links.rows as any[]) {
      const sid = Number(r.source_id);
      bySource.set(sid, [...(bySource.get(sid) ?? []), { viewers: (r.viewers ?? []).map(String), app: String(r.app), ref: String(r.ref), name: r.name ?? null }]);
    }
    const teamIds = new Set<string>();
    const perSource = new Map<number, Array<{ viewers: string[]; policy: AudiencePolicy | null }>>();
    for (const [sid, us] of bySource) {
      perSource.set(sid, us.map((u) => {
        const policy = rules ? policyFor(rules, u.app, u.ref, u.name) : { visibility: "members" as const, members: [] };
        for (const s of policy.members) if (s.subject_kind === "team") teamIds.add(s.member_id);
        return { viewers: u.viewers, policy };
      }));
    }
    const teamMembers = new Map<string, Set<string>>();
    if (teamIds.size) {
      const t = await q.query(`SELECT team_id::text AS team_id, member_id FROM team_member WHERE team_id::text = ANY($1::text[])`, [[...teamIds]]);
      for (const r of t.rows as any[]) teamMembers.set(String(r.team_id), (teamMembers.get(String(r.team_id)) ?? new Set()).add(String(r.member_id)));
    }
    const cur = await q.query(
      `SELECT s.id, s.visibility,
              COALESCE(array_agg(sm.subject_kind || ':' || sm.member_id) FILTER (WHERE sm.member_id IS NOT NULL), '{}') AS aud
         FROM source s LEFT JOIN source_member sm ON sm.source_id = s.id
        WHERE s.id = ANY($1::int[]) GROUP BY s.id`, [[...perSource.keys()]]);
    const current = new Map<number, { visibility: string; aud: Set<string> }>();
    for (const r of cur.rows as any[]) current.set(Number(r.id), { visibility: String(r.visibility), aud: new Set((r.aud ?? []).map(String)) });
    for (const [sid, units] of perSource) {
      const now = current.get(sid);
      if (!now) continue;                                  // 자료가 그새 지워졌다
      const want = computeAudience({ units, teamMembers });
      const same = now.visibility === "members" && now.aud.size === want.length && want.every((m) => now.aud.has(`member:${m}`));
      if (same) continue;
      await applyVisibility(q, sid, want.map((m) => ({ subject_kind: "member" as const, member_id: m })));
      changed++;
    }
  }
  return changed;
}

/** 단위들이 공개범위를 정하는 자료 전부를 다시 맞춘다 — 볼 수 있는 구성원이 바뀐 뒤(목록 반영·쪼개기·이관). */
export async function syncUnitAudience(q: Q, unitIds: readonly number[]): Promise<number> {
  const ids = [...new Set(unitIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return 0;
  const r = await q.query(`SELECT DISTINCT source_id FROM collect_unit_source WHERE unit_id = ANY($1::int[]) AND audience`, [ids]);
  return applySourceAudience(q, r.rows.map((x: any) => Number(x.source_id)));
}

export interface StoreResult { stored: number; inserted: number; skipped: number; failed: number; source_ids: number[] }

/**
 * 단위로 읽은 원문을 자료로 저장한다(T11 의 원문 저장 입구가 부른다).
 *  · 같은 외부 좌표(앱 + 인스턴스 + 항목 id)는 자료 한 건이다 — mirrorSourceV6(source_external_uidx ON CONFLICT).
 *    좌표 공간은 단위의 것으로 맞춘다(system = 단위 앱 · instance = 단위 인스턴스) — 그래야 같은 메일·같은 메시지가
 *    다른 사람의 단위로 다시 들어와도 한 행으로 합쳐진다.
 *  · 새로 들어온 자료는 그 단위의 볼 수 있는 구성원에게만 보인다. 같은 자료가 여러 단위로 들어오면 합집합이다.
 *  · 단위 체계 밖에서 먼저 들어와 있던 자료(봇 수집기가 모은 것)는 연결만 하고 공개범위를 건드리지 않는다(조용히 좁히지 않는다).
 *  항목마다 트랜잭션이다(ingestItems 와 같은 결) — 하나가 실패해도 나머지는 들어가고, 실패 수를 돌려준다.
 */
export async function storeUnitItems(unitId: number, items: readonly RawItem[]): Promise<StoreResult> {
  const u = await getUnit(unitId);
  if (!u) throw new UnitError(404, `수집 단위 #${unitId} 가 없습니다`);
  const res: StoreResult = { stored: 0, inserted: 0, skipped: 0, failed: 0, source_ids: [] };
  const client = await itemsPool.connect();
  try {
    for (const raw of items) {
      const ext = String(raw?.provenance?.external_id ?? "").trim();
      if (!ext) { res.skipped++; continue; }
      const it: RawItem = {
        ...raw,
        provenance: { ...raw.provenance, system: u.app, instance: u.instance, external_id: ext },
        container_ref: raw.container_ref ?? u.ref,
        container_name: raw.container_name ?? u.name ?? undefined,
      };
      await client.query("BEGIN");
      try {
        const coord = [u.app, normalizeExternalInstance(u.instance), ext];
        const before = await client.query(
          `SELECT id FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`, coord);
        await mirrorSourceV6(client, it, u.app, ext);
        const after = await client.query(
          `SELECT id FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`, coord);
        const sid = Number(after.rows[0].id);
        const inserted = before.rows.length === 0;
        //  공개범위를 단위가 정하나: 새 자료 · 또는 이미 다른 단위가 정하고 있던 자료(합집합에 보탠다).
        const owned = inserted
          || (await client.query(`SELECT 1 FROM collect_unit_source WHERE source_id=$1 AND audience LIMIT 1`, [sid])).rows.length > 0;
        await client.query(
          `INSERT INTO collect_unit_source(unit_id, source_id, audience) VALUES($1,$2,$3)
           ON CONFLICT (unit_id, source_id) DO UPDATE SET audience = collect_unit_source.audience OR EXCLUDED.audience`,
          [unitId, sid, owned]);
        if (owned) await applySourceAudience(client, [sid]);
        await client.query("COMMIT");
        res.stored++; if (inserted) res.inserted++;
        res.source_ids.push(sid);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        res.failed++;
        logger.warn({ unitId, externalId: ext, err: (e as Error)?.message }, "[collect-unit] 자료 저장 실패 — 다음 실행이 같은 좌표로 다시 합친다");
      }
    }
  } finally {
    client.release();
  }
  return res;
}

// ── 목록 반영(listing) ───────────────────────────────────────────────────────

export interface ListingInput {
  /** 목록을 훑은 구성원 — 본인 것만 반영한다(표면이 호출자로 못박는다). */
  member: string;
  app: string;
  /** claude.ai 커넥터 이름(«claude.ai » 뒤 그대로 — 예 Slack · Google Drive). 새 단위의 connector 가 된다. */
  connector?: string | null;
  instance?: string | null;
  items: ReadonlyArray<{ ref?: unknown; name?: unknown; kind?: unknown }>;
  /** 이 앱·인스턴스에서 이 사람이 볼 수 있는 것 **전부**인가 — 그렇다면 목록에 없는 단위에서 이 사람을 뺀다. */
  complete?: boolean;
}
export interface ListingResult {
  created: number; joined: number; seen: number; left: number; refused: string[]; audience_changed: number;
}

/**
 * 구성원 한 명이 커넥터로 훑은 «무엇이 있나» 를 표에 반영한다.
 *  새 단위는 «후보(candidate)» 로 생긴다 — 모을지는 리브·사람이 정한다(수집 범위는 고정 규칙이 없다, 설계 §1-3).
 *  이미 있는 단위(수집기 단위 포함)는 경로·상태를 바꾸지 않는다 — 이 사람은 후보 줄 맨 뒤에 선다.
 */
export async function recordUnitListing(input: ListingInput, ctx?: WriteCtx): Promise<ListingResult> {
  const member = String(input.member || "").trim();
  if (!member) throw new UnitError(400, "목록을 훑은 구성원이 비었습니다");
  const app = normalizeAppKey(input.app);
  const instance = normalizeExternalInstance(input.instance ?? "").trim().slice(0, 200);
  const connector = input.connector ? String(input.connector).trim().slice(0, 80) || null : null;
  const items = normalizeListing(input.items ?? []);
  const res: ListingResult = { created: 0, joined: 0, seen: 0, left: 0, refused: [], audience_changed: 0 };
  let emails: string[] = [];
  if (items.some((i) => i.kind === "mailbox")) {
    const r = await itemsPool.query(`SELECT email FROM org_member WHERE id=$1`, [member]);
    emails = r.rows.map((x: any) => String(x.email ?? "")).filter(Boolean);
  }
  const allowed = items.filter((i) => {
    const ok = listingClaimAllowed(i, emails);
    if (!ok) res.refused.push(i.ref);
    return ok;
  });
  const client = await itemsPool.connect();
  const touched = new Set<number>();
  try {
    await client.query("BEGIN");
    for (const it of allowed) {
      const up = await client.query(
        `INSERT INTO collect_unit(app, instance, ref, kind, name, connector, route, state, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,'member_ai','candidate',$7)
         ON CONFLICT (tenant_id, app, instance, ref) DO UPDATE SET
            name = COALESCE(EXCLUDED.name, collect_unit.name),
            kind = CASE WHEN collect_unit.kind = 'other' THEN EXCLUDED.kind ELSE collect_unit.kind END,
            connector = COALESCE(collect_unit.connector, EXCLUDED.connector),
            updated_at = now()
         RETURNING id, (xmax = 0) AS created`,
        [app, instance, it.ref, it.kind, it.name, connector, member]);
      const id = Number(up.rows[0].id);
      if (up.rows[0].created) res.created++;
      const m = await client.query(
        `INSERT INTO collect_unit_member(unit_id, member_id, priority, via)
         VALUES($1, $2, COALESCE((SELECT max(priority) FROM collect_unit_member WHERE unit_id=$1), 0) + 10, 'listing')
         ON CONFLICT (unit_id, member_id) DO UPDATE SET seen_at = now()
         RETURNING (xmax = 0) AS joined`, [id, member]);
      if (m.rows[0].joined) { res.joined++; touched.add(id); } else res.seen++;
    }
    if (input.complete) {
      const left = await client.query(
        `DELETE FROM collect_unit_member m USING collect_unit u
          WHERE m.unit_id = u.id AND m.member_id = $1 AND u.app = $2 AND u.instance = $3
            AND m.via IN ('listing', 'split')
            AND NOT (u.ref = ANY($4::text[]))
        RETURNING m.unit_id`, [member, app, instance, allowed.map((i) => i.ref)]);
      res.left = left.rows.length;
      for (const r of left.rows as any[]) touched.add(Number(r.unit_id));
    }
    res.audience_changed = await syncUnitAudience(client, [...touched]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (res.created || res.joined || res.left || res.refused.length) {
    await auditOrgContent("collect_unit", `${app}:${instance}`, "listing", null,
      { member, app, instance, complete: !!input.complete, created: res.created, joined: res.joined, left: res.left, refused: res.refused.length },
      ctx).catch(() => undefined);
  }
  return res;
}

// ── 실행 결과 → 담당 건강 → «다시 로그인» 알림 ──────────────────────────────

/** 알림을 싣는 빌트인 앱·누르면 갈 곳 — 헤드리스 자격 알림(org/credentials/headless-connect.ts)과 같은 자리. */
const NOTICE_APP = "ai-session";
const NOTICE_HREF = "#/me/ai";
/** 같은 끊김을 다시 울리지 않는 간격 — notified_at 이 끊김 한 번에 한 번을 보장하고, 이건 앱 알림 층의 겹 방어다. */
const NOTICE_COOLDOWN_MS = 12 * 60 * 60_000;

type NotifyFn = (input: {
  appId: string; memberId: string; title: string; body: string; href: string; dedupe_key: string; cooldownMs: number;
}) => Promise<{ ok: boolean }>;

/** (순수) «다시 로그인» 알림 한 건의 모양. 단위 이름은 그 사람이 볼 수 있는 단위뿐이다(대상이 그 단위의 후보다). */
export function collectNotice(t: Pick<NoticeTarget, "kind" | "connector">, unitNames: readonly string[]): { title: string; body: string; href: string; dedupe_key: string } {
  const shown = unitNames.slice(0, 3).join(", ") + (unitNames.length > 3 ? ` 외 ${unitNames.length - 3}개` : "");
  if (t.kind === "login") {
    return {
      title: "Claude 로그인이 끊겨 수집이 멈췄어요",
      body: `${shown} 수집을 맡은 내 Claude 로그인이 끊겼어요. 대신 모을 수 있는 사람이 없어 멈춰 있어요. 내 AI 계정에서 Claude 에 다시 로그인해 주세요.`,
      href: NOTICE_HREF,
      dedupe_key: "collect-unit:login",
    };
  }
  return {
    title: `Claude 에서 ${t.connector} 연결이 필요해요`,
    body: `${shown} 수집에 쓰는 내 Claude 계정에서 ${t.connector} 커넥터가 연결돼 있지 않아요(로그인이 끊겼을 수도 있어요). 대신 모을 수 있는 사람이 없어 멈춰 있어요. claude.ai 의 커넥터 설정에서 ${t.connector} 를 다시 연결해 주세요.`,
    href: NOTICE_HREF,
    dedupe_key: `collect-unit:connector:${connectorKey(t.connector)}`,
  };
}

async function setHealth(q: Q, member: string, change: HealthChange, runId: string | null, now: Date): Promise<void> {
  const conn = connectorKey(change.connector);
  const prev = (await q.query(
    `SELECT state, fails, last_run_id FROM collect_assignee_state WHERE member_id=$1 AND connector=$2`, [member, conn])).rows[0] as
    { state: string; fails: number; last_run_id: string | null } | undefined;
  if (runId && prev?.last_run_id === runId) return;              // 같은 실행을 두 번 반영하지 않는다(재기동 뒤 상태 읽기 등)
  if (change.state === "ok") {
    if (!prev) return;                                            // 끊긴 적 없는 칸은 만들지 않는다
    await q.query(
      `UPDATE collect_assignee_state SET state='ok', reason=NULL, fails=0, retry_at=NULL, notified_at=NULL,
              since = CASE WHEN state <> 'ok' THEN $3 ELSE since END, last_run_id=$4, updated_at=$3
        WHERE member_id=$1 AND connector=$2`, [member, conn, now, runId]);
    return;
  }
  const same = prev?.state === change.state;
  const fails = same ? Number(prev!.fails) + 1 : 1;
  const retryAt = new Date(now.getTime() + retryDelayMs(change.state, fails));
  await q.query(
    `INSERT INTO collect_assignee_state(member_id, connector, state, reason, since, retry_at, fails, last_run_id, notified_at, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$5)
     ON CONFLICT (tenant_id, member_id, connector) DO UPDATE SET
        state=EXCLUDED.state, reason=EXCLUDED.reason, retry_at=EXCLUDED.retry_at, fails=EXCLUDED.fails,
        last_run_id=EXCLUDED.last_run_id, updated_at=EXCLUDED.updated_at,
        since = CASE WHEN collect_assignee_state.state = EXCLUDED.state THEN collect_assignee_state.since ELSE EXCLUDED.since END,
        notified_at = CASE WHEN collect_assignee_state.state = EXCLUDED.state THEN collect_assignee_state.notified_at ELSE NULL END`,
    [member, conn, change.state, change.reason, now, retryAt, fails, runId]);
}

/**
 * 멈춘 단위(아무도 못 메우는 단위)의 볼 사람에게 «다시 로그인» 을 알린다. **던지지 않는다**(호출부는 실행 정리 중이다).
 *  대상 고르기는 unit-plan.noticeTargets — 볼 사람이 한 명뿐이면 그 사람, 여럿이 다 끊겼으면 우선순위가 가장 높은 사람.
 */
export async function notifyStalledUnits(memberScope: readonly string[] | null, notify?: NotifyFn, now = Date.now()): Promise<number> {
  try {
    const units = memberScope && memberScope.length
      ? await loadUnits(itemsPool, `u.state='active' AND EXISTS (SELECT 1 FROM collect_unit_member x WHERE x.unit_id=u.id AND x.member_id = ANY($1::text[]))`, [memberScope])
      : await loadUnits(itemsPool, `u.state='active'`);
    if (!units.length) return 0;
    const { plans, idx } = await planUnits(units, itemsPool, now);
    const targets = noticeTargets([...plans.values()], idx);
    if (!targets.length) return 0;
    const send: NotifyFn = notify ?? (async (i) => (await import("../../apps/notify.js")).notifyMember(i));
    const byId = new Map(units.map((u) => [u.id, u]));
    let sent = 0;
    for (const t of targets) {
      const names = t.unit_ids.map((id) => { const u = byId.get(id); return u?.name || u?.ref || `#${id}`; });
      const n = collectNotice(t, names);
      const r = await send({ appId: NOTICE_APP, memberId: t.member_id, ...n, cooldownMs: NOTICE_COOLDOWN_MS }).catch(() => ({ ok: false }));
      //  보냈든 앱이 꺼져 못 보냈든 이번 끊김엔 다시 고르지 않는다 — 실행마다 같은 시도를 되풀이하지 않게.
      await itemsPool.query(
        `UPDATE collect_assignee_state SET notified_at = $3 WHERE member_id=$1 AND connector=$2`,
        [t.member_id, t.kind === "login" ? ANY_CONNECTOR : connectorKey(t.connector), new Date(now)]);
      if (r.ok) sent++;
    }
    return sent;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[collect-unit] 멈춘 단위 알림 실패 — 다음 실행 결과에서 다시 본다");
    return 0;
  }
}

/**
 * 수집 실행 한 판의 결과로 담당 건강을 바꾼다(T11 collect-run 이 실행이 끝나면 부른다). **던지지 않는다.**
 *  로그인 끊김·커넥터 끊김·한도 초과면 그 사람을 건너뛰게 되어 다음 후보가 이어받고, 아무도 못 메우는 단위가 생기면
 *  그 단위의 볼 사람에게 알린다. 정상이면 끊김 기록을 지워 1순위가 다시 담당이 된다.
 */
export async function recordCollectOutcome(input: {
  member: string; runId?: string | null; exit: CollectRunExit | null; summary: (CollectRunSummary & { apps?: string[] | null }) | null;
  requested?: readonly string[] | null; notify?: NotifyFn; now?: number;
}): Promise<{ changes: HealthChange[]; notified: number }> {
  const member = String(input.member || "").trim();
  if (!member) return { changes: [], notified: 0 };
  try {
    const verdict = classifyCollectRun({
      exit: input.exit, summary: input.summary,
      requested: input.requested ?? input.summary?.apps ?? [],
    });
    if (!verdict.changes.length) return { changes: [], notified: 0 };
    const now = new Date(input.now ?? Date.now());
    for (const c of verdict.changes) await setHealth(itemsPool, member, c, input.runId ?? null, now);
    const notified = verdict.changes.some((c) => c.state !== "ok")
      ? await notifyStalledUnits([member], input.notify, now.getTime())
      : 0;
    return { changes: verdict.changes, notified };
  } catch (e) {
    logger.warn({ member, err: (e as Error)?.message }, "[collect-unit] 실행 결과 반영 실패 — 담당 건강은 그대로");
    return { changes: [], notified: 0 };
  }
}

/** 다시 연결된 것을 본 쪽(T6 커넥터 상태 · 로그인 완료)이 부른다 — 끊김 기록을 지워 그 사람이 다시 후보 줄에 선다. */
export async function markAssigneeHealthy(member: string, connector: string = ANY_CONNECTOR): Promise<void> {
  if (!member) return;
  await setHealth(itemsPool, member, { connector, state: "ok", reason: null }, null, new Date());
}

// ── 조회 · 수정 · 쪼개기(리브·화면) ─────────────────────────────────────────

export interface UnitView extends Omit<UnitRow, "members"> {
  candidates: Array<{ member_id: string; priority: number; via: string; seen_at: string; health: AssigneeState; retry_at: string | null }>;
  assignee: UnitPlan["assignee"];
  assignee_reason: UnitPlan["reason"];
}

function viewOf(u: UnitRow, plan: UnitPlan, idx: HealthIndex): UnitView {
  const { members, ...rest } = u;
  const connector = u.connector ?? connectorOfApp(u.app);
  return {
    ...rest,
    candidates: members.map((m) => {
      const h = [idx.get(`${m.member_id}\u0000${ANY_CONNECTOR}`), idx.get(`${m.member_id}\u0000${connectorKey(connector)}`)]
        .find((x) => x && x.state !== "ok");
      return {
        member_id: m.member_id, priority: m.priority, via: m.via, seen_at: m.seen_at,
        health: h?.state ?? "ok", retry_at: h?.retry_at != null ? new Date(h.retry_at).toISOString() : null,
      };
    }),
    assignee: plan.assignee, assignee_reason: plan.reason,
  };
}

export interface Actor { member: string; canManage: boolean }

/** 이 사람이 볼 수 있는 단위만(구성원 경로 = 볼 수 있는 구성원 · 수집기 경로 = 워크스페이스를 굴리는 사람). 못 보는 단위는 개수만. */
export async function listUnitsFor(actor: Actor, f: { app?: string | null; state?: string | null; mine?: boolean } = {}): Promise<{ units: UnitView[]; hidden: number }> {
  await ensureCollectorUnitsFresh();
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.app) { params.push(normalizeAppKey(f.app)); where.push(`u.app = $${params.length}`); }
  if (f.state) {
    if (!(UNIT_STATES as readonly string[]).includes(f.state)) throw new UnitError(400, `state 는 ${UNIT_STATES.join("·")} 중 하나입니다`);
    params.push(f.state); where.push(`u.state = $${params.length}`);
  }
  const units = await loadUnits(itemsPool, where.length ? where.join(" AND ") : "TRUE", params);
  const visible = units.filter((u) => canSeeUnit({ route: u.route, viewers: u.members.map((m) => m.member_id) }, actor.member, actor.canManage));
  const { plans, idx } = await planUnits(visible);
  let views = visible.map((u) => viewOf(u, plans.get(u.id)!, idx));
  if (f.mine) views = views.filter((v) => v.assignee?.kind === "member" && v.assignee.member_id === actor.member);
  return { units: views, hidden: actor.canManage ? units.length - visible.length : 0 };
}

export interface UnitPatch {
  state?: UnitState; interval_sec?: number | null; description?: string | null;
  meta?: Record<string, unknown> | null; priorities?: string[]; route?: CollectRoute; name?: string | null;
}

/** 리브·사람이 단위를 고친다 — 상태(모을지)·주기·설명·메타데이터·후보 순서·경로. 권한은 unit-plan.canEditUnit. */
export async function updateUnit(id: number, patch: UnitPatch, actor: Actor, ctx?: WriteCtx): Promise<UnitView> {
  const u = await getUnit(id);
  const viewers = u ? u.members.map((m) => m.member_id) : [];
  if (!u || !canSeeUnit({ route: u.route, viewers }, actor.member, actor.canManage)) throw new UnitError(404, `수집 단위 #${id} 가 없습니다`);
  if (!canEditUnit({ route: u.route, viewers }, actor.member, actor.canManage)) {
    throw new UnitError(403, isCollectorRoute(u.route)
      ? "수집기가 모으는 단위는 워크스페이스를 관리하는 사람만 고칠 수 있습니다"
      : "이 단위를 볼 수 있는 구성원만 고칠 수 있습니다");
  }
  if (patch.route != null && patch.route !== u.route) {
    if (!(COLLECT_ROUTES as readonly string[]).includes(patch.route)) throw new UnitError(400, `route 는 ${COLLECT_ROUTES.join("·")} 중 하나입니다`);
    if (!actor.canManage) throw new UnitError(403, "수집 경로는 워크스페이스를 관리하는 사람만 바꿀 수 있습니다");
  }
  if (patch.state != null && !(UNIT_STATES as readonly string[]).includes(patch.state)) throw new UnitError(400, `state 는 ${UNIT_STATES.join("·")} 중 하나입니다`);
  if (patch.interval_sec != null && !(Number.isInteger(patch.interval_sec) && patch.interval_sec >= 60 && patch.interval_sec <= 30 * 86400)) {
    throw new UnitError(400, "interval_sec 는 60~2592000 초입니다");
  }
  if (patch.priorities) {
    const extra = patch.priorities.filter((m) => !viewers.includes(m));
    if (extra.length) throw new UnitError(400, `후보 순서에 이 단위를 볼 수 없는 구성원이 있습니다: ${extra.join(", ")}`);
  }
  const before = { state: u.state, interval_sec: u.interval_sec, description: u.description, route: u.route, priorities: viewers };
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE collect_unit SET
          state = COALESCE($2, state),
          interval_sec = CASE WHEN $3::boolean THEN $4::int ELSE interval_sec END,
          description = CASE WHEN $5::boolean THEN $6 ELSE description END,
          meta = CASE WHEN $7::jsonb IS NULL THEN meta ELSE meta || $7::jsonb END,
          route = COALESCE($8, route),
          name = CASE WHEN $9::boolean THEN $10 ELSE name END,
          updated_at = now(), updated_by = $11
        WHERE id = $1`,
      [id, patch.state ?? null,
        patch.interval_sec !== undefined, patch.interval_sec ?? null,
        patch.description !== undefined, patch.description == null ? null : String(patch.description).slice(0, 4000),
        patch.meta == null ? null : JSON.stringify(patch.meta),
        patch.route ?? null,
        patch.name !== undefined, patch.name == null ? null : String(patch.name).slice(0, 200),
        actor.member]);
    if (patch.priorities?.length) {
      //  준 순서대로 10·20·30… — 빠진 후보는 그 뒤에 원래 순서로 남는다.
      const rest = viewers.filter((m) => !patch.priorities!.includes(m));
      const order = [...patch.priorities, ...rest];
      for (let i = 0; i < order.length; i++) {
        await client.query(`UPDATE collect_unit_member SET priority=$3 WHERE unit_id=$1 AND member_id=$2`, [id, order[i], (i + 1) * 10]);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const after = (await getUnit(id))!;
  await auditOrgContent("collect_unit", String(id), "update", before,
    { state: after.state, interval_sec: after.interval_sec, description: after.description, route: after.route, priorities: after.members.map((m) => m.member_id) },
    ctx).catch(() => undefined);
  const { plans, idx } = await planUnits([after]);
  return viewOf(after, plans.get(id)!, idx);
}

/**
 * 단위 쪼개기 — 볼 수 있는 범위가 사람마다 다르면 «같은 사람들이 같은 내용을 보는 묶음» 으로 나눈다(설계 §2).
 *  쪼개기는 **좁히기만** 한다: 자식의 볼 수 있는 구성원은 부모의 볼 수 있는 구성원 안에서만(넓히면 남의 자료가 열린다).
 *  자식은 부모와 같은 앱·인스턴스·경로·상태로 생기고, 부모를 읽을 때는 자식 ref 를 건너뛴다(listAssignedUnits.exclude_refs).
 */
export async function splitUnit(
  parentId: number, children: ReadonlyArray<{ ref?: unknown; name?: unknown; kind?: unknown; viewers?: readonly string[] }>,
  actor: Actor, ctx?: WriteCtx,
): Promise<UnitView[]> {
  const p = await getUnit(parentId);
  const viewers = p ? p.members.map((m) => m.member_id) : [];
  if (!p || !canSeeUnit({ route: p.route, viewers }, actor.member, actor.canManage)) throw new UnitError(404, `수집 단위 #${parentId} 가 없습니다`);
  if (!canEditUnit({ route: p.route, viewers }, actor.member, actor.canManage)) throw new UnitError(403, "이 단위를 쪼갤 권한이 없습니다");
  const items = normalizeListing(children);
  if (!items.length) throw new UnitError(400, "쪼갤 자식 단위(ref)를 하나 이상 주세요");
  const want = new Map<string, string[]>();
  children.forEach((c) => {
    const ref = String(c?.ref ?? "").trim();
    if (ref) want.set(ref, [...new Set(Array.isArray(c?.viewers) ? c.viewers.map(String) : [])]);
  });
  for (const it of items) {
    const over = splitOverreach(viewers, want.get(it.ref) ?? []);
    if (over.length) throw new UnitError(400, `자식 «${it.ref}» 에 부모 단위를 볼 수 없는 구성원이 있습니다: ${over.join(", ")} — 쪼개기는 좁히기만 합니다`);
    if (it.ref === p.ref) throw new UnitError(400, "자식 ref 가 부모와 같습니다");
  }
  const ids: number[] = [];
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    for (const it of items) {
      const r = await client.query(
        `INSERT INTO collect_unit(app, instance, ref, kind, name, parent_id, route, collector_id, connector, state, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, app, instance, ref) DO UPDATE SET parent_id = EXCLUDED.parent_id, updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING id, (xmax = 0) AS created`,
        [p.app, p.instance, it.ref, it.kind === "other" ? p.kind : it.kind, it.name, p.id, p.route, p.collector_id, p.connector, p.state, actor.member]);
      const cid = Number(r.rows[0].id);
      if (cid === p.parent_id) throw new UnitError(400, `자식 «${it.ref}» 이 이 단위의 부모입니다 — 고리를 만들 수 없습니다`);
      ids.push(cid);
      //  이미 있던 단위(목록이 따로 찾아 둔 것)는 그 구성원이 목록으로 확인된 사실이라 건드리지 않는다 — 부모만 잇는다.
      //  새로 생긴 자식만 준 구성원(부모의 부분집합)으로 채운다.
      if (!r.rows[0].created) continue;
      for (const m of want.get(it.ref) ?? []) {
        const pri = p.members.find((x) => x.member_id === m)?.priority ?? 100;
        await client.query(
          `INSERT INTO collect_unit_member(unit_id, member_id, priority, via) VALUES($1,$2,$3,'split')
           ON CONFLICT (unit_id, member_id) DO NOTHING`, [cid, m, pri]);
      }
    }
    await syncUnitAudience(client, ids);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await auditOrgContent("collect_unit", String(parentId), "split", null, { children: ids }, ctx).catch(() => undefined);
  const units = await loadUnits(itemsPool, `u.id = ANY($1::int[])`, [ids]);
  const { plans, idx } = await planUnits(units);
  return units.map((u) => viewOf(u, plans.get(u.id)!, idx));
}

// ── 라이블리 수집기 → 단위 이관 ─────────────────────────────────────────────

/** 자료(source)로 들어오고 그릇(채널·저장소·팀·폴더·파일)이 있는 수집기 — 모인 그릇이 곧 단위다. */
const CONTAINER_KIND: Record<string, UnitKind> = {
  slack: "channel", github: "repo", gitlab: "project", linear: "team", discord: "channel", gdrive: "folder", figma: "file",
};
/** 메일함이 단위인 수집기 — 그릇이 없고(외부 인스턴스 'default') 자격 주인의 메일함 하나를 모은다. */
const MAILBOX_APPS = new Set(["gmail", "outlook"]);

export interface ReconcileResult {
  created: number; updated: number; rerouted: number; mailboxes: number; notion_roots: number; skipped_presets: string[];
}

const freshAt = new Map<string, number>();
const FRESH_MS = 6 * 3600_000;
const RETRY_MS = 10 * 60_000;

/** 이관을 게으르게 — 워크스페이스마다 6시간에 한 번(매니지드는 부팅 단계가 워크스페이스마다 닿지 않는다). 실패해도 조회는 계속한다. */
export async function ensureCollectorUnitsFresh(force = false): Promise<void> {
  const key = currentTenant()?.id ?? "_";
  const at = freshAt.get(key) ?? 0;
  if (!force && Date.now() - at < FRESH_MS) return;
  freshAt.set(key, Date.now());
  try { await syncCollectorUnits(); }
  catch (e) {
    freshAt.set(key, Date.now() - FRESH_MS + RETRY_MS);     // 실패면 6시간이 아니라 10분 뒤 다시
    logger.warn({ err: (e as Error)?.message }, "[collect-unit] 수집기 단위 이관 실패 — 10분 뒤 조회에서 다시 한다");
  }
}

/** (시험용) 게으른 이관 시각을 지운다. */
export function _resetCollectorUnitsFreshForTest(): void { freshAt.clear(); }

/**
 * 지금 수집기 설정을 단위로 풀어 등록한다(설계 §2 «이관», 태스크 #4742 10/15 범위 추가). 멱등이다.
 *  · 그릇이 있는 수집기(슬랙·GitHub·GitLab·Linear·Discord·Drive·Figma): 켜진 수집기의 범위 안에서 **실제로 모인 그릇**을
 *    단위로 만든다. 설정의 채널 목록은 대개 이름이라(슬랙) 이름만으로는 좌표(채널 id)를 모른다 — 모인 자료가 이름 ↔ id 를 잇는다.
 *    «비면 전부» 인 설정도 모인 그릇으로 풀린다. 구성원 경로로 모은 자료(단위가 공개범위를 정하는 자료)는 세지 않는다.
 *  · 메일함(Gmail·Outlook): 자격 주인의 메일 주소가 단위다. 주인은 그 단위를 볼 수 있는 구성원이다.
 *  · 노션: 지식으로 들어오므로 그릇 대신 맨 위 페이지(부모가 들어와 있지 않은 페이지)가 단위다.
 *  · 단위는 «수집 중(active)» · 경로 라이블리 수집기로 생긴다. 이미 구성원 경로로 있던 단위는 수집기 경로로 바뀐다(수집기 1순위).
 *    사람이 «모으지 않기(excluded)» 로 둔 단위는 그대로 둔다.
 */
export async function syncCollectorUnits(): Promise<ReconcileResult> {
  const res: ReconcileResult = { created: 0, updated: 0, rerouted: 0, mailboxes: 0, notion_roots: 0, skipped_presets: [] };
  const collectors = (await loadCollectors(itemsPool)).filter((c) => c.enabled);
  const presets = [...new Set(collectors.map((c) => c.preset))];
  const upsert = async (u: { app: string; instance: string; ref: string; kind: UnitKind; name: string | null; collector_id: number; last_at: unknown }): Promise<number> => {
    const r = await itemsPool.query(
      `INSERT INTO collect_unit(app, instance, ref, kind, name, route, collector_id, state, last_item_at, updated_by)
       VALUES($1,$2,$3,$4,$5,'lively_collector',$6,'active',$7,'system:collect-unit-migrate')
       ON CONFLICT (tenant_id, app, instance, ref) DO UPDATE SET
          route = CASE WHEN collect_unit.route = 'member_ai' THEN 'lively_collector' ELSE collect_unit.route END,
          collector_id = CASE WHEN collect_unit.route = 'liv_direct' THEN collect_unit.collector_id ELSE EXCLUDED.collector_id END,
          state = CASE WHEN collect_unit.state = 'candidate' THEN 'active' ELSE collect_unit.state END,
          name = COALESCE(collect_unit.name, EXCLUDED.name),
          kind = CASE WHEN collect_unit.kind = 'other' THEN EXCLUDED.kind ELSE collect_unit.kind END,
          last_item_at = GREATEST(collect_unit.last_item_at, EXCLUDED.last_item_at),
          updated_at = CASE WHEN collect_unit.route = 'member_ai' OR collect_unit.collector_id IS DISTINCT FROM EXCLUDED.collector_id
                            THEN now() ELSE collect_unit.updated_at END
       RETURNING id, (xmax = 0) AS created`,
      [u.app, u.instance, u.ref, u.kind, u.name, u.collector_id, u.last_at ?? null]);
    const row = r.rows[0] as { id: number; created: boolean };
    if (row.created) res.created++; else res.updated++;
    return Number(row.id);
  };
  for (const preset of presets) {
    const mine = collectors.filter((c) => c.preset === preset);
    if (CONTAINER_KIND[preset]) {
      const seen = await itemsPool.query(
        `SELECT COALESCE(s.external_instance, '') AS instance, s.fields->>'container_ref' AS ref,
                max(s.fields->>'container_name') AS name, max(s.occurred_at) AS last_at,
                bool_or(COALESCE(s.fields->>'channel_is_private', '') = 'true') AS private
           FROM source s
          WHERE s.external_system = $1 AND COALESCE(s.fields->>'container_ref', '') <> ''
            AND NOT EXISTS (SELECT 1 FROM collect_unit_source us WHERE us.source_id = s.id AND us.audience)
          GROUP BY 1, 2`, [preset]);
      const before = await itemsPool.query(`SELECT ref, instance, route FROM collect_unit WHERE app = $1`, [preset]);
      const routeOf = new Map((before.rows as any[]).map((r) => [`${r.instance}\u0000${r.ref}`, String(r.route)]));
      for (const s of seen.rows as any[]) {
        const unit = { app: preset, instance: String(s.instance), ref: String(s.ref), name: s.name ?? null };
        const col = unitCollector({ ...unit, collector_id: null }, mine);
        if (!col || !col.enabled) continue;                     // 지금 켜진 수집기의 범위 밖(옛 채널 등) — 단위로 올리지 않는다
        const kind: UnitKind = preset === "slack" && s.private ? "private_channel" : CONTAINER_KIND[preset];
        if (routeOf.get(`${unit.instance}\u0000${unit.ref}`) === "member_ai") res.rerouted++;
        await upsert({ ...unit, kind, collector_id: col.id, last_at: s.last_at });
      }
    } else if (MAILBOX_APPS.has(preset)) {
      for (const c of mine) {
        const owner = c.token_source.startsWith("member:") ? c.token_source.slice("member:".length) : "";
        if (!owner) continue;
        const em = await itemsPool.query(`SELECT email FROM org_member WHERE id=$1`, [owner]);
        const email = String(em.rows[0]?.email ?? "").trim().toLowerCase();
        if (!email) continue;
        const last = await itemsPool.query(`SELECT max(occurred_at) AS at FROM source WHERE external_system=$1`, [preset]);
        const id = await upsert({ app: preset, instance: "default", ref: email, kind: "mailbox", name: email, collector_id: c.id, last_at: last.rows[0]?.at });
        await itemsPool.query(
          `INSERT INTO collect_unit_member(unit_id, member_id, priority, via) VALUES($1,$2,10,'migrate') ON CONFLICT (unit_id, member_id) DO NOTHING`,
          [id, owner]);
        res.mailboxes++;
      }
    } else if (preset === "notion") {
      const roots = await itemsPool.query(
        `SELECT COALESCE(k.external_instance, '') AS instance, k.external_id AS ref, k.title AS name, k.updated_at AS last_at
           FROM knowledge k
          WHERE k.external_system = 'notion' AND k.external_id IS NOT NULL
            AND (k.parent_external_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM knowledge p WHERE p.external_system = 'notion'
                     AND COALESCE(p.external_instance, '') = COALESCE(k.external_instance, '') AND p.external_id = k.parent_external_id))
          LIMIT 2000`);
      for (const r of roots.rows as any[]) {
        const col = mine.find((c) => c.instance === String(r.instance)) ?? mine.find((c) => c.instance == null) ?? null;
        if (!col) continue;
        await upsert({ app: "notion", instance: String(r.instance), ref: String(r.ref), kind: "page", name: r.name ?? null, collector_id: col.id, last_at: r.last_at });
        res.notion_roots++;
      }
    } else {
      res.skipped_presets.push(preset);
    }
  }
  return res;
}
