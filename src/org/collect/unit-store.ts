// 수집 단위 표(#4213 T10 #4742) — 저장·조회. 판정(담당·알림·분류·공개범위 계산·권한)은 unit-plan.ts(순수)가 하고,
//  여기는 DB 와 그 판정을 잇는다. 설계 정본: 지식 connect-collect-tobe-claude-connector-4213 §2.
//
//  ── 다른 과업이 부르는 함수(이름·인자 고정 — 태스크 #4742 «병렬 착수 경계») ──
//   T11 수집 실행: listAssignedUnits(member) → 맡은 단위·읽은 위치 · storeUnitItems(unit, items, {member}) → 원문 저장(같은 외부
//     좌표는 한 건 · 볼 수 있는 사람 합치기) · advanceUnitCursor(unit, {member}, {cursor}) → 읽은 위치 · recordUnitListing({…, verified:true})
//     → 서버가 연 목록 실행의 결과 · recordCollectOutcome(…) → 실행 결과로 담당 건강을 바꾸고 멈춘 단위의 볼 사람에게 «다시 로그인».
//   T6 커넥터 상태·로그인: markAssigneeHealthy(member, connector?) — 다시 연결된 것을 본 쪽이 부른다.
//   리브·화면(capabilities/collect-units.ts): listUnitsFor · updateUnit · splitUnit · recordUnitListing(본인 신고) · syncCollectorUnits.
//
//  ⚠ 원문 저장은 upsertSource 가 아니라 mirrorSourceV6 다 — upsertSource 는 id 가 없으면 그냥 INSERT 해 같은 외부 좌표가
//   두 행이 된다. 외부 좌표 합치기(source_external_uidx ON CONFLICT)의 정본은 mirrorSourceV6 다(태스크 #4742 댓글 #408).
//  ⚠ 볼 수 있는 사람은 **확인된** 구성원뿐이다(unit-plan 머리말 ★) — 본인 신고는 후보로만 선다.
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import type { RawItem } from "../../items/store.js";
import { mirrorSourceV6 } from "../../v6/mirror/mirror-source.js";
import { pickRule, sourceVisRules, type SourceVisRule } from "../../v6/source-vis-policy.js";
import { axisOn } from "../../v6/visibility-axes.js";
import { auditOrgContent, type WriteCtx } from "../../v6/content-audit.js";
import { failReason } from "../store/run-fail-reason.js";
import { currentTenant } from "../tenant-context.js";
import { HEADLESS_NOTICE_APP, HEADLESS_NOTICE_HREF } from "../credentials/headless-connect.js";
import {
  ANY_CONNECTOR, COLLECT_ROUTES, MAIL_APPS, UNIT_STATES,
  canAdvanceCursor, canEditUnit, canonicalCoord, classifyCollectRun, collectorAuthFailed, computeAudience, connectorKey,
  healthIndex, isCollectorRoute, listingClaimAllowed, noticeTargets, normalizeListing, planUnit, retryDelayMs, splitOverreach,
  unitAccess,
  type AssigneeState, type AudiencePolicy, type CollectRoute, type CollectRunExit, type CollectRunSummary, type HealthChange,
  type HealthIndex, type NoticeTarget, type PlanCollector, type PlanHealth, type PlanUnit, type UnitKind, type UnitPlan, type UnitState,
} from "./unit-plan.js";

type Q = Pick<pg.PoolClient, "query">;

/** 단위가 주기를 아직 안 가졌을 때 «다시 읽을 때가 됐나» 의 기본 간격(T12 가 단위 글 빈도로 덮는다). */
export const DEFAULT_UNIT_INTERVAL_SEC = 3600;
/** 목록 한 번에 받는 단위 수 상한 — 넘는 목록은 «전부(complete)» 일 수 없다(잘린 꼬리를 «빠졌다» 로 읽으면 볼 수 있는 사람이 지워진다). */
export const LISTING_CAP = 5000;

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

export interface UnitMember {
  member_id: string; priority: number; via: string; added_at: string; seen_at: string;
  verified: boolean; verified_at: string | null;
  /** 구성원 상태가 inactive(내보낸 사람)면 false — 후보 줄에서 뺀다(그 사람은 실행이 없으니 끊김으로도 안 잡힌다). */
  active: boolean;
}
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
      added_at: iso(m.added_at)!, seen_at: iso(m.seen_at)!, verified: m.verified_at != null, verified_at: iso(m.verified_at),
      active: m.inactive !== true,
    })),
  };
}

/** 단위 + 볼 수 있는 구성원(후보 줄 순서). where 는 u 별칭 기준 SQL 조각. */
async function loadUnits(q: Q, where = "TRUE", params: unknown[] = []): Promise<UnitRow[]> {
  const r = await q.query(
    `SELECT ${UNIT_COLS},
            COALESCE(json_agg(json_build_object('member_id', m.member_id, 'priority', m.priority, 'via', m.via,
                                                'added_at', m.added_at, 'seen_at', m.seen_at, 'verified_at', m.verified_at,
                                                'inactive', EXISTS (SELECT 1 FROM org_member om WHERE om.id = m.member_id AND om.state = 'inactive'))
                     ORDER BY (m.verified_at IS NULL), m.priority, m.added_at, m.member_id) FILTER (WHERE m.member_id IS NOT NULL), '[]') AS members
       FROM collect_unit u LEFT JOIN collect_unit_member m ON m.unit_id = u.id
      WHERE ${where}
      GROUP BY u.id
      ORDER BY u.app, u.instance, u.name NULLS LAST, u.ref`, params);
  return r.rows.map(mapUnit);
}

export async function getUnit(id: number, q: Q = itemsPool): Promise<UnitRow | null> {
  return (await loadUnits(q, "u.id = $1", [id]))[0] ?? null;
}

const accessInput = (u: UnitRow) => ({ route: u.route, members: u.members.map((m) => ({ member_id: m.member_id, verified: m.verified })) });

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

/**
 * 수집기 목록 + «끊겼나» — 마지막으로 끝난 실행이 오류이고 그 로그가 **수집기 자격 실패**(unit-plan.collectorAuthFailed —
 *  슬랙 invalid_auth·token_revoked · 노션 401 API token is invalid · 구글 invalid_grant …)면 끊김이다. 실행 기록이 없으면 끊기지 않은 것.
 */
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
        `SELECT DISTINCT ON (collector_id) collector_id, status, right(log, 4000) AS tail
           FROM connector_run WHERE collector_id = ANY($1::bigint[]) AND status <> 'running'
          ORDER BY collector_id, started_at DESC`, [ids]);
      for (const r of runs.rows as any[]) {
        if (r.status !== "error") continue;
        if (collectorAuthFailed(`${failReason(r.tail) ?? ""}\n${String(r.tail ?? "")}`)) broken.add(Number(r.collector_id));
      }
    } catch (e) {
      //  표가 아직 없는 것(첫 실행 전 — 42P01)만 «끊김 없음» 이다. 그 밖의 오류는 알린다(조용히 «멀쩡하다» 로 삼키지 않는다).
      if ((e as { code?: string })?.code !== "42P01") {
        logger.warn({ err: (e as Error)?.message }, "[collect-unit] 수집기 실행 기록을 못 읽었다 — 이번 판정은 끊김 없음으로 본다");
      }
    }
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
    candidates: u.members.filter((m) => m.active)
      .map((m) => ({ member_id: m.member_id, priority: m.priority, added_at: ms(m.added_at) ?? 0, verified: m.verified })),
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

/** 정책 하나를 «단위 몫» 으로 — 조직 공개범위 정책(#1291 v4)이 그 앱·채널을 묶었으면 그 대상. */
function policyFor(rules: SourceVisRule[], app: string, ref: string, name: string | null): AudiencePolicy {
  const p = pickRule(rules, app, [ref, name]);
  return { visibility: p.visibility, members: p.members };
}

/**
 * 자료들의 볼 수 있는 사람을 다시 맞춘다 — 단위가 공개범위를 정하는 연결(audience=true)만 본다.
 *  그 자료를 들여온 단위마다 «확인된 단위 구성원 ∩ 조직 정책» 의 합집합. 지금 대상과 같은 자료는 건드리지 않는다.
 *  ⚠ 자료마다 문장을 돌리지 않는다 — 한 채널 5만 건이면 구성원 한 명이 들어올 때마다 15만 문장이 된다(리뷰 2026-10-16).
 *   «같은 단위 묶음» 으로 자료를 묶고(대개 단위 하나), 묶음마다 대상을 한 번 계산해 500건씩 세 문장(UPDATE·DELETE·INSERT)으로 쓴다.
 *  정책을 못 읽으면 닫는 쪽(대상 0)으로 — 열어 두면 정책 위반이 유출로 굳는다(stampSourceVisibility 와 같은 규칙).
 */
export async function applySourceAudience(q: Q, sourceIds: readonly number[]): Promise<number> {
  const ids = [...new Set(sourceIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return 0;
  let rules: SourceVisRule[] | null = null;
  try { rules = await sourceVisRules(); }
  catch { logger.warn({ n: ids.length }, "[collect-unit] 공개범위 정책을 못 읽었다 — 단위 자료를 닫힌 채로 둔다(정책 복구 뒤 다시 맞춘다)"); }
  //  ① 자료 → 공개범위를 정하는 단위들(정렬된 id 묶음).
  const links = await q.query(
    `SELECT source_id, array_agg(unit_id ORDER BY unit_id) AS units
       FROM collect_unit_source WHERE source_id = ANY($1::int[]) AND audience GROUP BY source_id`, [ids]);
  const groups = new Map<string, { unitIds: number[]; sources: number[] }>();
  for (const r of links.rows as any[]) {
    const unitIds: number[] = ((r.units ?? []) as unknown[]).map(Number);
    const k = unitIds.join(",");
    const g = groups.get(k) ?? { unitIds, sources: [] as number[] };
    g.sources.push(Number(r.source_id));
    groups.set(k, g);
  }
  if (!groups.size) return 0;
  //  ② 묶음에 나오는 단위들의 확인된 구성원 · 좌표(정책 매칭용).
  const allUnits = [...new Set([...groups.values()].flatMap((g) => g.unitIds))];
  const uRows = await q.query(
    `SELECT u.id, u.app, u.ref, u.name,
            COALESCE(array_agg(m.member_id) FILTER (WHERE m.member_id IS NOT NULL AND m.verified_at IS NOT NULL), '{}') AS viewers
       FROM collect_unit u LEFT JOIN collect_unit_member m ON m.unit_id = u.id
      WHERE u.id = ANY($1::int[]) GROUP BY u.id`, [allUnits]);
  const unitInfo = new Map<number, { viewers: string[]; policy: AudiencePolicy }>();
  const teamIds = new Set<string>();
  for (const r of uRows.rows as any[]) {
    const policy = rules ? policyFor(rules, String(r.app), String(r.ref), r.name ?? null) : { visibility: "members" as const, members: [] };
    for (const s of policy.members) if (s.subject_kind === "team") teamIds.add(s.member_id);
    unitInfo.set(Number(r.id), { viewers: (r.viewers ?? []).map(String), policy });
  }
  const teamMembers = new Map<string, Set<string>>();
  if (teamIds.size) {
    const t = await q.query(`SELECT team_id::text AS team_id, member_id FROM team_member WHERE team_id::text = ANY($1::text[])`, [[...teamIds]]);
    for (const r of t.rows as any[]) teamMembers.set(String(r.team_id), (teamMembers.get(String(r.team_id)) ?? new Set()).add(String(r.member_id)));
  }
  let changed = 0;
  for (const g of groups.values()) {
    const units = g.unitIds.map((id) => unitInfo.get(id)).filter((x): x is { viewers: string[]; policy: AudiencePolicy } => !!x);
    const want = computeAudience({ units, teamMembers });
    const wantKey = want.map((m) => `member:${m}`).join("\u0001");
    for (let i = 0; i < g.sources.length; i += AUDIENCE_BATCH) {
      const chunk = g.sources.slice(i, i + AUDIENCE_BATCH);
      //  ③ 이미 그 대상인 자료는 뺀다(행 교체·잠금 소음 없음).
      const cur = await q.query(
        `SELECT s.id, s.visibility,
                COALESCE(string_agg(sm.subject_kind || ':' || sm.member_id, E'\\u0001' ORDER BY sm.subject_kind || ':' || sm.member_id)
                         FILTER (WHERE sm.member_id IS NOT NULL), '') AS aud
           FROM source s LEFT JOIN source_member sm ON sm.source_id = s.id
          WHERE s.id = ANY($1::int[]) GROUP BY s.id`, [chunk]);
      const todo = (cur.rows as any[]).filter((r) => !(r.visibility === "members" && String(r.aud) === wantKey)).map((r) => Number(r.id));
      if (!todo.length) continue;
      await q.query(`UPDATE source SET visibility='members' WHERE id = ANY($1::int[])`, [todo]);
      await q.query(`DELETE FROM source_member WHERE source_id = ANY($1::int[])`, [todo]);
      if (want.length) {
        await q.query(
          `INSERT INTO source_member(source_id, subject_kind, member_id)
           SELECT s, 'member', m FROM unnest($1::int[]) AS s CROSS JOIN unnest($2::text[]) AS m
           ON CONFLICT DO NOTHING`, [todo, want]);
      }
      changed += todo.length;
    }
  }
  return changed;
}

/** 단위들이 공개범위를 정하는 자료 전부를 다시 맞춘다 — 확인된 구성원이 바뀐 뒤(목록 반영·쪼개기·저장으로 확인됨). */
export async function syncUnitAudience(q: Q, unitIds: readonly number[]): Promise<number> {
  const ids = [...new Set(unitIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return 0;
  const r = await q.query(`SELECT DISTINCT source_id FROM collect_unit_source WHERE unit_id = ANY($1::int[]) AND audience`, [ids]);
  return applySourceAudience(q, r.rows.map((x: any) => Number(x.source_id)));
}

/** 이 사람을 이 단위의 «확인된» 볼 수 있는 구성원으로 — 그 사람 커넥터로 그 단위를 실제로 읽은 것이 확인됐을 때. 새로 확인되면 true. */
async function verifyMember(q: Q, unitId: number, member: string): Promise<boolean> {
  const r = await q.query(
    `UPDATE collect_unit_member SET verified_at = now(), seen_at = now()
      WHERE unit_id = $1 AND member_id = $2 AND verified_at IS NULL RETURNING 1`, [unitId, member]);
  return r.rows.length > 0;
}

export interface StoreResult {
  stored: number; inserted: number; skipped: number; conflicts: number; failed: number; source_ids: number[];
}

/**
 * 단위로 읽은 원문을 자료로 저장한다(T11 의 원문 저장 입구가 부른다). by = 그 실행의 주인(그 단위의 볼 수 있는 구성원이어야 한다).
 *  · 같은 외부 좌표(앱 + 인스턴스 + 항목 id)는 자료 한 건이다 — mirrorSourceV6(source_external_uidx ON CONFLICT).
 *    좌표 공간은 단위의 것으로 맞춘다(system = 단위 앱 · instance = 단위 인스턴스 · 그릇 = 단위 ref).
 *  · 그릇이 이 단위가 아닌 항목은 버린다(conflicts) — 쪼갠 자식 단위의 글이 부모의 넓은 대상으로 들어가거나, 다른 단위의 좌표를
 *    빌린 항목이 그 자료를 덮어쓰고 대상을 넓히지 못하게. 메일만은 같은 메일이 여러 메일함에 있는 게 정상이라 합친다.
 *  · 새로 들어온 자료는 그 단위의 확인된 볼 수 있는 구성원에게만 보인다. 같은 자료가 여러 단위로 들어오면 합집합이다.
 *  · 단위 체계 밖에서 먼저 들어와 있던 자료(봇 수집기가 모은 것)는 연결만 하고 공개범위를 건드리지 않는다(조용히 좁히지 않는다).
 *  · 한 건이라도 저장되면 by 를 «확인됨» 으로 올린다 — 그 사람 커넥터가 이 단위를 실제로 읽었다는 증거다.
 *  항목마다 트랜잭션이다(ingestItems 와 같은 결) — 하나가 실패해도 나머지는 들어가고, 실패 수를 돌려준다.
 *  한계: 쪼개기 전에 부모로 모은 자료는 부모 대상 그대로다(쪼개기는 앞으로 모을 것만 나눈다).
 */
export async function storeUnitItems(
  unitId: number, items: readonly RawItem[], by: { member?: string | null; collector_id?: number | null },
): Promise<StoreResult> {
  const u = await getUnit(unitId);
  if (!u) throw new UnitError(404, `수집 단위 #${unitId} 가 없습니다`);
  const member = by.member ? String(by.member) : null;
  if (member ? !u.members.some((m) => m.member_id === member) : by.collector_id == null) {
    throw new UnitError(403, "이 단위를 볼 수 있는 구성원(또는 그 수집기)의 실행만 자료를 넣을 수 있습니다");
  }
  const kids = new Set((await itemsPool.query(`SELECT ref FROM collect_unit WHERE parent_id = $1`, [unitId])).rows.map((r: any) => String(r.ref)));
  const shareable = MAIL_APPS.has(u.app);
  const res: StoreResult = { stored: 0, inserted: 0, skipped: 0, conflicts: 0, failed: 0, source_ids: [] };
  const client = await itemsPool.connect();
  try {
    for (const raw of items) {
      const ext = String(raw?.provenance?.external_id ?? "").trim();
      if (!ext) { res.skipped++; continue; }
      const given = raw.container_ref == null ? null : String(raw.container_ref).trim();
      if (given && (given !== u.ref || kids.has(given))) { res.conflicts++; continue; }
      const it: RawItem = {
        ...raw,
        provenance: { ...raw.provenance, system: u.app, instance: u.instance, external_id: ext },
        container_ref: u.ref,
        container_name: raw.container_name ?? u.name ?? undefined,
      };
      await client.query("BEGIN");
      try {
        const coord = [u.app, u.instance, ext];
        const before = await client.query(
          `SELECT id, fields->>'container_ref' AS container FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`, coord);
        const prev = before.rows[0] as { id: number; container: string | null } | undefined;
        if (prev && !shareable && prev.container && prev.container !== u.ref) {
          await client.query("ROLLBACK");
          res.conflicts++;
          continue;
        }
        await mirrorSourceV6(client, it, u.app, ext);
        const sid = Number((await client.query(
          `SELECT id FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`, coord)).rows[0].id);
        const inserted = !prev;
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
    //  그 사람 커넥터가 이 단위를 실제로 읽었다 → 확인됨. 새로 확인되면 이 단위의 자료가 그 사람에게도 열린다.
    if (member && res.stored > 0) {
      await client.query("BEGIN");
      try {
        if (await verifyMember(client, unitId, member)) await syncUnitAudience(client, [unitId]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        logger.warn({ unitId, member, err: (e as Error)?.message }, "[collect-unit] 확인됨 표시 실패 — 다음 저장에서 다시 한다");
      }
    }
  } finally {
    client.release();
  }
  return res;
}

// ── 목록 반영(listing) ───────────────────────────────────────────────────────

export interface ListingInput {
  /** 목록을 훑은 구성원 — 그 사람 것만 반영한다(표면은 호출자로 못박는다). */
  member: string;
  app: string;
  /** claude.ai 커넥터 이름(«claude.ai » 뒤 그대로 — 예 Slack · Google Drive). 새 단위의 connector 가 된다. */
  connector?: string | null;
  instance?: string | null;
  items: ReadonlyArray<{ ref?: unknown; name?: unknown; kind?: unknown }>;
  /** 이 앱·인스턴스에서 이 사람이 볼 수 있는 것 **전부**인가 — 그렇다면 목록에 없는 단위에서 이 사람을 뺀다. 빈 목록·상한 초과면 무시. */
  complete?: boolean;
  /**
   * 그 사람 커넥터로 읽은 것이 **확인된** 목록인가 — 서버가 연 목록 실행(T11)의 결과만 true. 본인 신고 표면은 false 다.
   *  true 면 볼 수 있는 구성원(자료가 열린다), false 면 후보로만 선다(확인된 사람 뒤 · 자료는 안 열린다).
   */
  verified?: boolean;
}
export interface ListingResult {
  created: number; joined: number; seen: number; verified: number; left: number; refused: string[]; audience_changed: number;
  complete_ignored: boolean;
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
  const instance = canonicalCoord(app, String(input.instance ?? "").slice(0, 200), "x").instance;
  const connector = input.connector ? String(input.connector).trim().slice(0, 80) || null : null;
  const verified = input.verified === true;
  const raw = normalizeListing(input.items ?? []);
  //  같은 단위가 두 줄이 되지 않게 좌표를 맞추고(메일 소문자 · 노션 하이픈), 잠금 순서를 정렬로 고정한다(겹치는 목록 둘이 교착하지 않게).
  const byRef = new Map<string, (typeof raw)[number]>();
  for (const it of raw) {
    const ref = canonicalCoord(app, instance, it.ref).ref;
    if (ref && !byRef.has(ref)) byRef.set(ref, { ...it, ref });
  }
  const items = [...byRef.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const res: ListingResult = {
    created: 0, joined: 0, seen: 0, verified: 0, left: 0, refused: [], audience_changed: 0,
    complete_ignored: !!input.complete && (items.length === 0 || (input.items?.length ?? 0) > LISTING_CAP),
  };
  const emails = (await itemsPool.query(`SELECT email FROM org_member WHERE id=$1`, [member])).rows
    .map((x: any) => String(x.email ?? "")).filter(Boolean);
  const existingKinds = new Map<string, string>();
  if (items.length) {
    const ex = await itemsPool.query(`SELECT ref, kind FROM collect_unit WHERE app=$1 AND instance=$2 AND ref = ANY($3::text[])`,
      [app, instance, items.map((i) => i.ref)]);
    for (const r of ex.rows as any[]) existingKinds.set(String(r.ref), String(r.kind));
  }
  const allowed = items.filter((i) => {
    const ok = listingClaimAllowed(i, { app, existingKind: existingKinds.get(i.ref) ?? null, memberEmails: emails });
    if (!ok) res.refused.push(i.ref);
    return ok;
  });
  const run = async (): Promise<void> => {
    const client = await itemsPool.connect();
    const touched = new Set<number>();
    try {
      await client.query("BEGIN");
      for (const it of allowed) {
        const kind = MAIL_APPS.has(app) ? "mailbox" : it.kind;
        const up = await client.query(
          `INSERT INTO collect_unit(app, instance, ref, kind, name, connector, route, state, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,'member_ai','candidate',$7)
           ON CONFLICT (tenant_id, app, instance, ref) DO UPDATE SET
              name = COALESCE(collect_unit.name, EXCLUDED.name),
              kind = CASE WHEN collect_unit.kind = 'other' THEN EXCLUDED.kind ELSE collect_unit.kind END,
              connector = COALESCE(collect_unit.connector, EXCLUDED.connector)
           RETURNING id, (xmax = 0) AS created`,
          [app, instance, it.ref, kind, it.name, connector, member]);
        const id = Number(up.rows[0].id);
        if (up.rows[0].created) res.created++;
        const m = await client.query(
          `INSERT INTO collect_unit_member(unit_id, member_id, priority, via, verified_at)
           VALUES($1, $2, COALESCE((SELECT max(priority) FROM collect_unit_member WHERE unit_id=$1), 0) + 10, 'listing',
                  CASE WHEN $3::boolean THEN now() END)
           ON CONFLICT (unit_id, member_id) DO UPDATE SET seen_at = now(),
              verified_at = COALESCE(collect_unit_member.verified_at, EXCLUDED.verified_at)
           RETURNING (xmax = 0) AS joined`, [id, member, verified]);
        if (m.rows[0].joined) res.joined++; else res.seen++;
        //  자료가 열리는 건 확인된 구성원이 생길 때뿐이다(신고만으로는 대상이 안 바뀐다).
        if (verified) { touched.add(id); res.verified++; }
      }
      if (input.complete && !res.complete_ignored) {
        const left = await client.query(
          `DELETE FROM collect_unit_member m USING collect_unit u
            WHERE m.unit_id = u.id AND m.member_id = $1 AND u.app = $2 AND u.instance = $3
              AND m.via IN ('listing', 'split')
              AND NOT (u.ref = ANY($4::text[]))
          RETURNING m.unit_id, m.verified_at`, [member, app, instance, allowed.map((i) => i.ref)]);
        res.left = left.rows.length;
        for (const r of left.rows as any[]) if (r.verified_at != null) touched.add(Number(r.unit_id));
      }
      res.audience_changed = await syncUnitAudience(client, [...touched]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  try { await run(); }
  catch (e) {
    if ((e as { code?: string })?.code !== "40P01") throw e;
    //  교착(다른 목록과 겹친 행) — 정렬로 드물지만 한 번 더 한다(목록 반영은 멱등이다).
    Object.assign(res, { created: 0, joined: 0, seen: 0, verified: 0, left: 0, audience_changed: 0 });
    await run();
  }
  if (res.created || res.joined || res.left || res.refused.length || res.verified) {
    await auditOrgContent("collect_unit", `${app}:${instance}`, "listing", null,
      { member, app, instance, verified, complete: !!input.complete && !res.complete_ignored,
        created: res.created, joined: res.joined, left: res.left, refused: res.refused.length },
      ctx).catch(() => undefined);
  }
  return res;
}

// ── 실행 결과 → 담당 건강 → «다시 로그인» 알림 ──────────────────────────────

/** 같은 끊김을 다시 울리지 않는 간격 — notified_at 이 끊김 한 번에 한 번을 보장하고, 이건 앱 알림 층의 겹 방어다. */
const NOTICE_COOLDOWN_MS = 12 * 60 * 60_000;

type NotifyFn = (input: {
  appId: string; memberId: string; title: string; body: string; href: string; dedupe_key: string; cooldownMs: number;
}) => Promise<{ ok: boolean; denial?: string }>;

/** (순수) «다시 로그인» 알림 한 건의 모양. connectorLabel = 사람에게 보일 커넥터 이름(단위에 적힌 그대로). */
export function collectNotice(t: Pick<NoticeTarget, "kind" | "connector">, unitNames: readonly string[], connectorLabel?: string | null): {
  title: string; body: string; href: string; dedupe_key: string;
} {
  const shown = unitNames.slice(0, 3).join(", ") + (unitNames.length > 3 ? ` 외 ${unitNames.length - 3}개` : "");
  if (t.kind === "login") {
    return {
      title: "Claude 로그인이 끊겨 수집이 멈췄어요",
      body: `${shown} 수집을 맡은 내 Claude 로그인이 끊겼어요. 대신 모을 수 있는 사람이 없어 멈춰 있어요. 내 AI 계정에서 Claude 에 다시 로그인해 주세요.`,
      href: HEADLESS_NOTICE_HREF,
      dedupe_key: "collect-unit:login",
    };
  }
  const name = connectorLabel || t.connector;
  return {
    title: `Claude 에서 ${name} 연결이 필요해요`,
    body: `${shown} 수집에 쓰는 내 Claude 계정에서 ${name} 커넥터가 연결돼 있지 않아요(로그인이 끊겼을 수도 있어요). 대신 모을 수 있는 사람이 없어 멈춰 있어요. claude.ai 의 커넥터 설정에서 ${name} 를 다시 연결해 주세요.`,
    href: HEADLESS_NOTICE_HREF,
    dedupe_key: `collect-unit:connector:${connectorKey(t.connector)}`,
  };
}

/**
 * 건강 칸 하나를 바꾼다. at = 그 결과가 난 시각(실행이 끝난 시각) — 그 칸이 이미 더 나중 결과로 바뀌었으면 손대지 않는다
 *  (게이트웨이 재기동 뒤 옛 실행을 다시 읽어 «끊김» 이 나중의 «정상» 을 덮지 않게). 같은 실행은 두 번 반영하지 않는다.
 */
async function setHealth(q: Q, member: string, change: HealthChange, runId: string | null, at: Date): Promise<void> {
  const conn = connectorKey(change.connector);
  const prev = (await q.query(
    `SELECT state, fails, last_run_id, updated_at FROM collect_assignee_state WHERE member_id=$1 AND connector=$2`, [member, conn])).rows[0] as
    { state: string; fails: number; last_run_id: string | null; updated_at: Date } | undefined;
  if (runId && prev?.last_run_id === runId) return;
  if (prev && new Date(prev.updated_at).getTime() > at.getTime()) return;
  if (change.state === "ok") {
    if (!prev) return;                                            // 끊긴 적 없는 칸은 만들지 않는다
    await q.query(
      `UPDATE collect_assignee_state SET state='ok', reason=NULL, fails=0, retry_at=NULL, notified_at=NULL,
              since = CASE WHEN state <> 'ok' THEN $3 ELSE since END, last_run_id=$4, updated_at=$3
        WHERE member_id=$1 AND connector=$2`, [member, conn, at, runId]);
    return;
  }
  const same = prev?.state === change.state;
  const fails = same ? Number(prev!.fails) + 1 : 1;
  const retryAt = new Date(at.getTime() + retryDelayMs(change.state, fails));
  await q.query(
    `INSERT INTO collect_assignee_state(member_id, connector, state, reason, since, retry_at, fails, last_run_id, notified_at, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$5)
     ON CONFLICT (tenant_id, member_id, connector) DO UPDATE SET
        state=EXCLUDED.state, reason=EXCLUDED.reason, retry_at=EXCLUDED.retry_at, fails=EXCLUDED.fails,
        last_run_id=EXCLUDED.last_run_id, updated_at=EXCLUDED.updated_at,
        since = CASE WHEN collect_assignee_state.state = EXCLUDED.state THEN collect_assignee_state.since ELSE EXCLUDED.since END,
        notified_at = CASE WHEN collect_assignee_state.state = EXCLUDED.state THEN collect_assignee_state.notified_at ELSE NULL END`,
    [member, conn, change.state, change.reason, at, retryAt, fails, runId]);
}

/**
 * 멈춘 단위(아무도 못 메우는 단위)의 볼 사람에게 «다시 로그인» 을 알린다. **던지지 않는다**(호출부는 실행 정리 중이다).
 *  대상 고르기는 unit-plan.noticeTargets — 볼 사람이 한 명뿐이면 그 사람, 여럿이 다 끊겼으면 우선순위가 가장 높은 사람.
 *  알림이 실제로 나갔을 때만 «이번 끊김에 알렸다» 를 적는다 — 못 나갔는데 적으면 그 끊김 동안 사람이 영영 모른다.
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
      const us = t.unit_ids.map((id) => byId.get(id)).filter((u): u is UnitRow => !!u);
      const names = us.map((u) => u.name || u.ref);
      const label = us.find((u) => u.connector)?.connector ?? (us[0] ? connectorOfApp(us[0].app) : null);
      const n = collectNotice(t, names, label);
      let r: { ok: boolean; denial?: string };
      try { r = await send({ appId: HEADLESS_NOTICE_APP, memberId: t.member_id, ...n, cooldownMs: NOTICE_COOLDOWN_MS }); }
      catch (e) { r = { ok: false, denial: (e as Error)?.message }; }
      if (!r.ok) {
        logger.warn({ member: t.member_id, kind: t.kind, denial: r.denial }, "[collect-unit] «다시 로그인» 알림을 못 보냈다 — 다음 실행 결과에서 다시 보낸다");
        continue;
      }
      //  GREATEST — 끊김 시각(since)은 그 사람 컨테이너 시계(실행이 끝난 시각)라 게이트웨이 시계보다 조금 앞설 수 있다.
      //   «이번 끊김에 알렸다(notified_at ≥ since)» 가 시계 차이로 거짓이 되어 매 결과마다 다시 알리지 않게.
      await itemsPool.query(
        `UPDATE collect_assignee_state SET notified_at = GREATEST($3::timestamptz, since) WHERE member_id=$1 AND connector=$2`,
        [t.member_id, t.kind === "login" ? ANY_CONNECTOR : connectorKey(t.connector), new Date(now)]);
      sent++;
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
 *  at = 실행이 끝난 시각(exit.endedAt) — 없으면 지금.
 */
export async function recordCollectOutcome(input: {
  member: string; runId?: string | null; exit: CollectRunExit | null; summary: (CollectRunSummary & { apps?: string[] | null }) | null;
  requested?: readonly string[] | null; at?: Date | string | null; notify?: NotifyFn; now?: number;
}): Promise<{ changes: HealthChange[]; notified: number }> {
  const member = String(input.member || "").trim();
  if (!member) return { changes: [], notified: 0 };
  try {
    const verdict = classifyCollectRun({
      exit: input.exit, summary: input.summary,
      requested: input.requested ?? input.summary?.apps ?? [],
    });
    if (!verdict.changes.length) return { changes: [], notified: 0 };
    const nowMs = input.now ?? Date.now();
    const atRaw = input.at ? new Date(input.at) : null;
    const at = atRaw && Number.isFinite(atRaw.getTime()) ? atRaw : new Date(nowMs);
    for (const c of verdict.changes) await setHealth(itemsPool, member, c, input.runId ?? null, at);
    const notified = verdict.changes.some((c) => c.state !== "ok")
      ? await notifyStalledUnits([member], input.notify, nowMs)
      : 0;
    return { changes: verdict.changes, notified };
  } catch (e) {
    logger.warn({ member, err: (e as Error)?.message }, "[collect-unit] 실행 결과 반영 실패 — 담당 건강은 그대로");
    return { changes: [], notified: 0 };
  }
}

/** 다시 연결된 것을 본 쪽(T6 커넥터 상태 · [로그인했어요] 확인)이 부른다 — 끊김 기록을 지워 그 사람이 다시 후보 줄에 선다. */
export async function markAssigneeHealthy(member: string, connector: string = ANY_CONNECTOR): Promise<void> {
  if (!member) return;
  await setHealth(itemsPool, member, { connector, state: "ok", reason: null }, null, new Date());
}

// ── 조회 · 수정 · 쪼개기(리브·화면) ─────────────────────────────────────────

/** 다 보는 사람(확인된 볼 수 있는 구성원 · 수집기 단위의 관리자)의 한 줄. */
export interface UnitView extends Omit<UnitRow, "members"> {
  access: "full";
  candidates: Array<{ member_id: string; priority: number; via: string; seen_at: string; verified: boolean; active: boolean; health: AssigneeState; retry_at: string | null }>;
  assignee: UnitPlan["assignee"];
  assignee_reason: UnitPlan["reason"];
}
/**
 * 일부만 보는 사람의 한 줄 — 수집기 단위의 다른 구성원 · 신고만 한 본인. 후보 줄·건강·설명·메타·읽은 위치는 없다.
 *  비공개 대화(private_channel·group_dm·dm·mailbox)는 이름도 뺀다(신고한 본인에게는 자기가 적은 이름이라 보인다).
 */
export interface UnitCoarseView {
  access: "coarse";
  id: number; app: string; kind: UnitKind; name: string | null; route: CollectRoute; state: UnitState;
  assignee_kind: "collector" | "member" | null; assignee_reason: UnitPlan["reason"]; candidate_count: number;
  /** 신고만 한 본인이면 그 자리(확인되면 다 보인다). */
  mine: { verified: false; priority: number } | null;
}

const PRIVATE_KINDS: ReadonlySet<string> = new Set(["private_channel", "group_dm", "dm", "mailbox"]);

function viewOf(u: UnitRow, plan: UnitPlan, idx: HealthIndex): UnitView {
  const { members, ...rest } = u;
  const connector = u.connector ?? connectorOfApp(u.app);
  return {
    ...rest, access: "full",
    candidates: members.map((m) => {
      const h = [idx.get(`${m.member_id}\u0000${ANY_CONNECTOR}`), idx.get(`${m.member_id}\u0000${connectorKey(connector)}`)]
        .find((x) => x && x.state !== "ok");
      return {
        member_id: m.member_id, priority: m.priority, via: m.via, seen_at: m.seen_at, verified: m.verified, active: m.active,
        health: h?.state ?? "ok", retry_at: h?.retry_at != null ? new Date(h.retry_at).toISOString() : null,
      };
    }),
    assignee: plan.assignee, assignee_reason: plan.reason,
  };
}

function coarseOf(u: UnitRow, plan: UnitPlan, member: string): UnitCoarseView {
  const me = u.members.find((m) => m.member_id === member && !m.verified);
  return {
    access: "coarse", id: u.id, app: u.app, kind: u.kind, name: PRIVATE_KINDS.has(u.kind) && !me ? null : u.name,
    route: u.route, state: u.state, assignee_kind: plan.assignee?.kind ?? null, assignee_reason: plan.reason,
    candidate_count: u.members.length, mine: me ? { verified: false, priority: me.priority } : null,
  };
}

export interface Actor { member: string; isAdmin: boolean }

/**
 * 이 사람에게 보이는 단위 — unit-plan.unitAccess: 다 보이는 것(full)과 일부만 보이는 것(coarse). 못 보는 단위는 관리자에게 개수만.
 *  SQL 에서 먼저 거른다(수집기 경로이거나 이 사람이 후보인 단위) — 워크스페이스 전체를 읽어 JS 로 거르지 않는다.
 */
export async function listUnitsFor(actor: Actor, f: { app?: string | null; state?: string | null; mine?: boolean } = {}): Promise<{ units: Array<UnitView | UnitCoarseView>; hidden: number }> {
  const params: unknown[] = [actor.member];
  const where: string[] = [`(u.route IN ('lively_collector','liv_direct') OR EXISTS (SELECT 1 FROM collect_unit_member x WHERE x.unit_id = u.id AND x.member_id = $1))`];
  if (f.app) { params.push(normalizeAppKey(f.app)); where.push(`u.app = $${params.length}`); }
  if (f.state) {
    if (!(UNIT_STATES as readonly string[]).includes(f.state)) throw new UnitError(400, `state 는 ${UNIT_STATES.join("·")} 중 하나입니다`);
    params.push(f.state); where.push(`u.state = $${params.length}`);
  }
  const units = await loadUnits(itemsPool, where.join(" AND "), params);
  const { plans, idx } = await planUnits(units);
  let views: Array<UnitView | UnitCoarseView> = [];
  for (const u of units) {
    const a = unitAccess(accessInput(u), actor.member, actor.isAdmin);
    if (a === "full") views.push(viewOf(u, plans.get(u.id)!, idx));
    else if (a === "coarse") views.push(coarseOf(u, plans.get(u.id)!, actor.member));
  }
  if (f.mine) views = views.filter((v) => v.access === "full" && v.assignee?.kind === "member" && v.assignee.member_id === actor.member);
  let hidden = 0;
  if (actor.isAdmin) {
    const h = await itemsPool.query(
      `SELECT count(*)::int AS n FROM collect_unit u
        WHERE u.route = 'member_ai' AND NOT EXISTS (SELECT 1 FROM collect_unit_member x WHERE x.unit_id = u.id AND x.member_id = $1)`, [actor.member]);
    hidden = Number(h.rows[0]?.n ?? 0);
  }
  return { units: views, hidden };
}

export interface UnitPatch {
  state?: UnitState; interval_sec?: number | null; description?: string | null;
  meta?: Record<string, unknown> | null; priorities?: string[]; route?: CollectRoute; name?: string | null;
}

/** 리브·사람이 단위를 고친다 — 상태(모을지)·주기·설명·메타데이터·후보 순서·경로. 권한은 unit-plan.canEditUnit · 경로는 관리자만. */
export async function updateUnit(id: number, patch: UnitPatch, actor: Actor, ctx?: WriteCtx): Promise<UnitView> {
  const u = await getUnit(id);
  if (!u || unitAccess(accessInput(u), actor.member, actor.isAdmin) !== "full") throw new UnitError(404, `수집 단위 #${id} 가 없습니다`);
  if (!canEditUnit(accessInput(u), actor.member, actor.isAdmin)) {
    throw new UnitError(403, "이 단위를 고칠 권한이 없습니다 — 수집기 단위는 관리자 또는 확인된 볼 수 있는 구성원, 그 밖은 확인된 볼 수 있는 구성원만");
  }
  const viewers = u.members.map((m) => m.member_id);
  if (patch.route != null && patch.route !== u.route) {
    if (!(COLLECT_ROUTES as readonly string[]).includes(patch.route)) throw new UnitError(400, `route 는 ${COLLECT_ROUTES.join("·")} 중 하나입니다`);
    //  경로를 바꾸면 누가 모으나가 바뀐다(수집기는 제 설정대로 따로 돈다 — 구성원 경로로 돌리면 둘이 겹쳐 모은다).
    if (!actor.isAdmin) throw new UnitError(403, "수집 경로는 관리자만 바꿀 수 있습니다");
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
      //  준 순서대로 10·20·30… — 빠진 후보는 그 뒤에 원래 순서로 남는다(확인된 사람이 먼저인 규칙은 판정이 따로 지킨다).
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
 *  이미 있는 단위를 자식으로 데려오려면: 그 단위를 다 볼 수 있고 고칠 수 있어야 하며, 다른 부모가 없고, 그 구성원이 부모 안이어야 한다
 *   (아니면 남의 단위를 데려와 옛 부모의 넓은 대상이 그 그릇을 다시 모으게 된다 — 리뷰 2026-10-16).
 *  자식의 구성원은 부모에서의 «확인됨» 을 그대로 물려받는다.
 */
export async function splitUnit(
  parentId: number, children: ReadonlyArray<{ ref?: unknown; name?: unknown; kind?: unknown; viewers?: readonly string[] }>,
  actor: Actor, ctx?: WriteCtx,
): Promise<UnitView[]> {
  const p = await getUnit(parentId);
  if (!p || unitAccess(accessInput(p), actor.member, actor.isAdmin) !== "full") throw new UnitError(404, `수집 단위 #${parentId} 가 없습니다`);
  if (!canEditUnit(accessInput(p), actor.member, actor.isAdmin)) throw new UnitError(403, "이 단위를 쪼갤 권한이 없습니다");
  const parentViewers = p.members.map((m) => m.member_id);
  const items = normalizeListing(children).map((it) => ({ ...it, ref: canonicalCoord(p.app, p.instance, it.ref).ref }));
  if (!items.length) throw new UnitError(400, "쪼갤 자식 단위(ref)를 하나 이상 주세요");
  const want = new Map<string, string[]>();
  children.forEach((c) => {
    const ref = canonicalCoord(p.app, p.instance, c?.ref).ref;
    if (ref) want.set(ref, [...new Set(Array.isArray(c?.viewers) ? c.viewers.map(String) : [])]);
  });
  const existing = new Map((await loadUnits(itemsPool, `u.app = $1 AND u.instance = $2 AND u.ref = ANY($3::text[])`,
    [p.app, p.instance, items.map((i) => i.ref)])).map((u) => [u.ref, u]));
  for (const it of items) {
    if (it.ref === p.ref) throw new UnitError(400, "자식 ref 가 부모와 같습니다");
    const over = splitOverreach(parentViewers, want.get(it.ref) ?? []);
    if (over.length) throw new UnitError(400, `자식 «${it.ref}» 에 부모 단위를 볼 수 없는 구성원이 있습니다: ${over.join(", ")} — 쪼개기는 좁히기만 합니다`);
    const ex = existing.get(it.ref);
    if (!ex) continue;
    if (unitAccess(accessInput(ex), actor.member, actor.isAdmin) !== "full" || !canEditUnit(accessInput(ex), actor.member, actor.isAdmin)) {
      throw new UnitError(404, `자식으로 데려올 단위 «${it.ref}» 가 없습니다`);
    }
    if (ex.parent_id != null && ex.parent_id !== p.id) throw new UnitError(400, `«${it.ref}» 는 이미 다른 단위(#${ex.parent_id})의 자식입니다`);
    if (ex.id === p.parent_id) throw new UnitError(400, `«${it.ref}» 이 이 단위의 부모입니다 — 고리를 만들 수 없습니다`);
    const exOver = splitOverreach(parentViewers, ex.members.map((m) => m.member_id));
    if (exOver.length) throw new UnitError(400, `«${it.ref}» 에 부모 단위를 볼 수 없는 구성원이 있습니다(${exOver.join(", ")}) — 자식이 될 수 없습니다`);
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
      ids.push(cid);
      //  이미 있던 단위는 그 구성원(목록이 확인한 사실)을 건드리지 않는다 — 부모만 잇는다.
      if (!r.rows[0].created) continue;
      for (const m of want.get(it.ref) ?? []) {
        const pm = p.members.find((x) => x.member_id === m);
        await client.query(
          `INSERT INTO collect_unit_member(unit_id, member_id, priority, via, verified_at) VALUES($1,$2,$3,'split',$4)
           ON CONFLICT (unit_id, member_id) DO NOTHING`, [cid, m, pm?.priority ?? 100, pm?.verified_at ?? null]);
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
  return units.filter((u) => unitAccess(accessInput(u), actor.member, actor.isAdmin) === "full").map((u) => viewOf(u, plans.get(u.id)!, idx));
}

// ── 라이블리 수집기 → 단위 이관 ─────────────────────────────────────────────

/** 자료(source)로 들어오고 그릇(채널·저장소·팀·폴더·파일)이 있는 수집기 — 모인 그릇이 곧 단위다. */
const CONTAINER_KIND: Record<string, UnitKind> = {
  slack: "channel", github: "repo", gitlab: "project", linear: "team", discord: "channel", gdrive: "folder", figma: "file",
};

export interface ReconcileResult {
  created: number; updated: number; rerouted: number; mailboxes: number; notion_roots: number; skipped_presets: string[];
}

const freshAt = new Map<string, number>();
const FRESH_MS = 6 * 3600_000;
const RETRY_MS = 10 * 60_000;

/**
 * 이관을 워크스페이스마다 6시간에 한 번 — 스케줄러 틱(scheduler/engine.ts, 워크스페이스 컨텍스트 안)이 부른다.
 *  읽기 경로(collect_units·listAssignedUnits)에서 부르지 않는다 — 읽기 도구가 쓰기를 하게 되고 첫 조회가 느려진다(리뷰 2026-10-16).
 *  실패하면 10분 뒤 다시.
 */
export async function ensureCollectorUnitsFresh(force = false): Promise<void> {
  const key = currentTenant()?.id ?? "_";
  const at = freshAt.get(key) ?? 0;
  if (!force && Date.now() - at < FRESH_MS) return;
  freshAt.set(key, Date.now());
  try { await syncCollectorUnits(); }
  catch (e) {
    freshAt.set(key, Date.now() - FRESH_MS + RETRY_MS);
    logger.warn({ err: (e as Error)?.message }, "[collect-unit] 수집기 단위 이관 실패 — 10분 뒤 다시 한다");
  }
}

/** (시험용) 게으른 이관 시각을 지운다. */
export function _resetCollectorUnitsFreshForTest(): void { freshAt.clear(); }

/**
 * 지금 수집기 설정을 단위로 풀어 등록한다(설계 §2 «이관», 태스크 #4742 10/15 범위 추가). 멱등이다.
 *  · 그릇이 있는 수집기(슬랙·GitHub·GitLab·Linear·Discord·Drive·Figma): 켜진 수집기의 범위 안에서 **실제로 모인 그릇**을
 *    단위로 만든다. 설정의 채널 목록은 대개 이름이라(슬랙) 이름만으로는 좌표(채널 id)를 모른다 — 모인 자료가 이름 ↔ id 를 잇는다.
 *    «비면 전부» 인 설정도 모인 그릇으로 풀린다. 구성원 경로로 모은 자료(단위가 공개범위를 정하는 자료)는 세지 않는다.
 *  · 메일함(Gmail·Outlook): 자격 주인의 메일 주소가 단위다. 주인은 그 단위의 확인된 볼 수 있는 구성원이다(서버가 아는 사실).
 *  · 노션: 지식으로 들어오므로 그릇 대신 맨 위 페이지(부모가 들어와 있지 않은 페이지)가 단위다.
 *  · 단위는 «수집 중(active)» · 경로 라이블리 수집기로 생긴다. 이미 구성원 경로로 있던 단위는 수집기 경로로 바뀐다(수집기 1순위).
 *    사람이 «모으지 않기(excluded)» 로 둔 단위는 그대로 둔다.
 */
export async function syncCollectorUnits(): Promise<ReconcileResult> {
  const res: ReconcileResult = { created: 0, updated: 0, rerouted: 0, mailboxes: 0, notion_roots: 0, skipped_presets: [] };
  const collectors = (await loadCollectors(itemsPool)).filter((c) => c.enabled);
  const presets = [...new Set(collectors.map((c) => c.preset))];
  const upsert = async (u: { app: string; instance: string; ref: string; kind: UnitKind; name: string | null; collector_id: number; last_at: unknown }): Promise<number> => {
    const c = canonicalCoord(u.app, u.instance, u.ref);
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
      [u.app, c.instance, c.ref, u.kind, u.name, u.collector_id, u.last_at ?? null]);
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
    } else if (MAIL_APPS.has(preset)) {
      for (const c of mine) {
        const owner = c.token_source.startsWith("member:") ? c.token_source.slice("member:".length) : "";
        if (!owner) continue;
        const em = await itemsPool.query(`SELECT email FROM org_member WHERE id=$1`, [owner]);
        const email = String(em.rows[0]?.email ?? "").trim().toLowerCase();
        if (!email) continue;
        const last = await itemsPool.query(`SELECT max(occurred_at) AS at FROM source WHERE external_system=$1`, [preset]);
        const id = await upsert({ app: preset, instance: "default", ref: email, kind: "mailbox", name: email, collector_id: c.id, last_at: last.rows[0]?.at });
        //  메일함 주인은 서버가 아는 사실(수집기 자격 주인)이라 처음부터 확인된 구성원이다.
        await itemsPool.query(
          `INSERT INTO collect_unit_member(unit_id, member_id, priority, via, verified_at) VALUES($1,$2,10,'migrate',now())
           ON CONFLICT (unit_id, member_id) DO UPDATE SET verified_at = COALESCE(collect_unit_member.verified_at, now())`,
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
          ORDER BY k.external_instance, k.external_id
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
