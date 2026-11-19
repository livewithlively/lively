// org_manager — 관리기 레지스트리 + 발견(org_manager_finding) 큐(#1419 T5).
//
//  이 파일에서 가장 조심한 것은 **멱등 발견**이다. 관리기는 주기적으로 도는데 같은 문제는 매번 다시 발견된다.
//  그때마다 새 행을 만들면 큐가 같은 항목의 사본으로 뒤덮여 아무도 안 보고, 무엇보다 사람이 내린 '반려'가
//  다음 주기에 무의미해진다(반려한 것이 새 항목으로 또 올라온다). 그래서 재발견은 카운트만 올린다.
import type { PoolClient } from "pg";
import { itemsPool, q } from "../../db/client.js";
import { audit } from "./audit.js";
import { linkManagerContradiction, dismissManagerContradiction } from "../../v6/knowledge-links.js";
import { isApplicableAction } from "../manage/action-whitelist.js";
import type { Finding } from "../manage/detectors.js";

export type ManagerKind = "mismatch" | "outdated" | "contradiction" | "code_drift";

export interface ManagerRow {
  id: number; key: string; label: string | null; kind: ManagerKind;
  enabled: boolean; priority: number;
  match_categories: string[] | null; match_types: string[] | null;
  match_provenance: string | null; exclude_names: string[] | null; lookback_days: number | null;
  threshold: number | null; stale_days: number | null;
  action_level: string; criteria_md: string | null;
  batch_size: number; harness: string | null; model: string | null; effort: string | null; requester: string | null;
  last_run_at: string | null; last_status: string | null; last_summary: unknown; note: string | null;
  /** 파생 — 열린 발견 수(목록 배지). */
  open_findings?: number;
}

const COLS = `id, key, label, kind, enabled, priority,
  match_categories, match_types, match_provenance, exclude_names, lookback_days,
  threshold, stale_days, action_level, criteria_md,
  batch_size, harness, model, effort, requester, last_run_at, last_status, last_summary, note`;

/** kind 별 사람 읽는 이름 — 화면·요약 공용(한 곳에서 정의해 표기가 갈리지 않게). */
export const MANAGER_KIND_LABEL: Record<ManagerKind, string> = {
  mismatch: "분류 어긋남 보정",
  outdated: "지식 아웃데이티드",
  contradiction: "지식 간 모순",
  code_drift: "지식 ↔ 코드 비교",
};

/** LLM 판정이 필요한 종류인가 — 크론이 배치 접수 여부를 이걸로 가른다. */
export function needsLlm(kind: ManagerKind): boolean {
  return kind === "contradiction" || kind === "code_drift";
}

export async function listManagers(): Promise<ManagerRow[]> {
  const rows = await q(itemsPool, `
    SELECT ${COLS},
           (SELECT count(*)::int FROM org_manager_finding f
             WHERE f.manager_id = org_manager.id AND f.state='open') AS open_findings
      FROM org_manager ORDER BY priority DESC, id`);
  return rows as ManagerRow[];
}

export async function getManager(idOrKey: number | string): Promise<ManagerRow | null> {
  const rows = typeof idOrKey === "number"
    ? await q(itemsPool, `SELECT ${COLS} FROM org_manager WHERE id=$1`, [idOrKey])
    : await q(itemsPool, `SELECT ${COLS} FROM org_manager WHERE key=$1`, [idOrKey]);
  return (rows[0] as ManagerRow) ?? null;
}

/**
 * 발견 저장 — **멱등**. 같은 (관리기, 대상, dedup_key)는 한 행이고 재발견은 카운트만 올린다.
 *
 *  ⚠ 사람이 반려(rejected)한 것은 **다시 열지 않는다.** 그 판단이 최신이고, 되살리면 관리기가 사람과
 *   싸우는 꼴이 된다("아니라니까"를 매 주기 무시당하면 큐 전체의 신뢰가 무너진다).
 *  반대로 accepted/resolved 는 되살린다 — 고쳤는데 또 발견됐다면 그건 새 사실이다(안 고쳐졌거나 재발).
 *  요약·근거·조치안은 매번 갱신한다(최신 수치를 보여줘야 판단할 수 있다).
 */
export async function upsertFinding(managerId: number, kind: string, f: Finding, db: Pick<PoolClient, "query"> = itemsPool): Promise<"new" | "again" | "skipped"> {
  return (await upsertFindingRow(managerId, kind, f, db)).result;
}

/** upsertFinding 과 같고 발견 id 도 돌려준다 — 저장 직후 그 발견에 조치를 거는 자리(auto)가 쓴다. */
export async function upsertFindingRow(
  managerId: number, kind: string, f: Finding, db: Pick<PoolClient, "query"> = itemsPool,
): Promise<{ result: "new" | "again" | "skipped"; id: number | null }> {
  const r = await db.query(`
    INSERT INTO org_manager_finding(manager_id, kind, target_kind, target_ref, dedup_key,
                                    severity, summary, evidence, proposed_action)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    ON CONFLICT (manager_id, target_ref, dedup_key) DO UPDATE SET
      seen_count = org_manager_finding.seen_count + 1,
      last_seen_at = now(),
      severity = EXCLUDED.severity,
      summary = EXCLUDED.summary,
      evidence = EXCLUDED.evidence,
      proposed_action = EXCLUDED.proposed_action,
      -- 반려는 존중(그대로 rejected), 그 외는 다시 열린다.
      state = CASE WHEN org_manager_finding.state='rejected' THEN 'rejected' ELSE 'open' END,
      resolved_at = CASE WHEN org_manager_finding.state='rejected' THEN org_manager_finding.resolved_at ELSE NULL END
    RETURNING id, (xmax = 0) AS inserted, state`,
    [managerId, kind, f.target_kind, f.target_ref, f.dedup_key ?? "",
     f.severity, f.summary, f.evidence ?? null,
     f.proposed_action == null ? null : JSON.stringify(f.proposed_action)]);
  const row = r.rows[0] as { id: string | number; inserted: boolean; state: string } | undefined;
  if (!row) return { result: "skipped", id: null };
  return { result: row.inserted ? "new" : (row.state === "rejected" ? "skipped" : "again"), id: Number(row.id) };
}

/**
 * 모순(contradiction) 보고 — 발견 저장과 contradicts 링크(origin 'manager:<key>')를 한 트랜잭션에서 한다.
 *
 *  쌍 키는 서버가 정한다: target_ref=least, dedup_key=greatest(DB 정렬 규칙 — 후보 SQL 의 o.name > k.name 과 같은 비교).
 *   종전엔 어느 쪽을 target_ref 로 둘지 LLM 이 골라, 같은 쌍이 방향만 바뀌어 두 행으로 열리고 한쪽 반려가 다른 쪽에 안 먹었다.
 *  정규화 전에 만들어진 행(반대 방향)이 있으면 그 행을 계속 쓴다 — 새 방향으로 또 한 행을 만들지 않으려는 것이다.
 *   어느 방향이든 반려된 행이 있으면 저장도 링크도 하지 않는다(사람의 «아니다» 가 최신이다).
 */
export async function reportContradiction(
  m: { id: number; key: string; kind: string }, f: Finding,
  ctx?: { actor?: string | null; source?: string; allowLink?: boolean },
): Promise<{ result: "new" | "again" | "skipped"; linked: boolean }> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const pair = (await client.query(`SELECT least($1::text, $2::text) AS a, greatest($1::text, $2::text) AS b`,
      [f.target_ref, f.dedup_key ?? ""])).rows[0] as { a: string; b: string };
    //  같은 쌍의 기존 행을 먼저 잠근다 — 동시에 도는 반려(resolveFinding)와 이 보고가 같은 행에서 줄을 선다.
    const prior = (await client.query(
      `SELECT target_ref, dedup_key, state FROM org_manager_finding
        WHERE manager_id=$1 AND ((target_ref=$2 AND dedup_key=$3) OR (target_ref=$3 AND dedup_key=$2))
        ORDER BY (target_ref=$2) DESC, id FOR UPDATE`, [m.id, pair.a, pair.b])).rows as Array<{ target_ref: string; dedup_key: string; state: string }>;
    if (prior.some((p) => p.state === "rejected")) { await client.query("COMMIT"); return { result: "skipped", linked: false }; }
    const key = prior[0] ?? { target_ref: pair.a, dedup_key: pair.b };
    const { result } = await upsertFindingRow(m.id, m.kind, { ...f, target_ref: key.target_ref, dedup_key: key.dedup_key }, client);
    //  allowLink=false — 보고한 사람이 두 지식을 다 볼 수 없다. 발견은 저장하되 링크는 만들지 않는다(링크는 양 끝 이름을 남의 화면에 싣는다).
    const linked = result === "skipped" || ctx?.allowLink === false ? false
      : await linkManagerContradiction(client, pair.a, pair.b, m.key, { actor: ctx?.actor ?? `manager:${m.key}`, source: ctx?.source ?? "mcp" });
    await client.query("COMMIT");
    return { result, linked };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

export interface FindingRow {
  id: number; manager_id: number; manager_key?: string; manager_label?: string | null;
  kind: string; target_kind: string; target_ref: string; dedup_key: string;
  severity: string; summary: string; evidence: string | null; proposed_action: unknown;
  state: string; seen_count: number; first_seen_at: string; last_seen_at: string;
  resolved_at: string | null; resolved_by: string | null; resolution: string | null;
  /** 파생 — 대상 지식의 제목(있으면). 큐에서 이름 슬러그만 보이면 무엇인지 모른다. */
  target_title?: string | null;
  /** 파생 — 이 관리기의 조치 수준(report|propose|auto). 화면이 '적용 대기'를 그릴지 정한다. */
  action_level?: string;
  /**
   * 파생(#1419 T9) — 기계가 적용할 수 있는 조치안이 붙어 있나.
   *  판정은 applyFinding 과 **같은 화이트리스트**(isApplicableAction)를 쓴다 — 서로 다르면
   *  '적용' 버튼이 있는데 눌러도 아무 일이 없는 상태가 된다(사용자는 실패했다고 인지하지 못한다).
   */
  actionable?: boolean;
}

export async function listFindings(opts: {
  managerId?: number; kind?: string; state?: string; severity?: string; limit?: number; offset?: number;
} = {}): Promise<FindingRow[]> {
  const params: unknown[] = [];
  const w: string[] = [];
  if (opts.managerId) { params.push(opts.managerId); w.push(`f.manager_id = $${params.length}`); }
  if (opts.kind) { params.push(opts.kind); w.push(`f.kind = $${params.length}`); }
  if (opts.state) { params.push(opts.state); w.push(`f.state = $${params.length}`); }
  else w.push(`f.state = 'open'`); // 기본은 열린 것만 — 큐는 '할 일'이지 이력이 아니다
  if (opts.severity) { params.push(opts.severity); w.push(`f.severity = $${params.length}`); }
  params.push(Math.min(Math.max(1, opts.limit ?? 100), 500)); const limP = `$${params.length}`;
  params.push(Math.max(0, opts.offset ?? 0)); const offP = `$${params.length}`;

  const rows = await q(itemsPool, `
    SELECT f.*, m.key AS manager_key, m.label AS manager_label, m.action_level,
           k.title AS target_title
      FROM org_manager_finding f
      JOIN org_manager m ON m.id = f.manager_id
      LEFT JOIN knowledge k ON f.target_kind='knowledge' AND k.name = f.target_ref
     WHERE ${w.join(" AND ")}
     ORDER BY CASE f.severity WHEN 'high' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, f.last_seen_at DESC
     LIMIT ${limP} OFFSET ${offP}`, params);
  // 적용 가능 여부는 applyFinding 과 **같은 판정**으로 파생한다(#1419 T9) — 화면이 자기 규칙을 따로 갖지 않게.
  return (rows as FindingRow[]).map((f) => ({ ...f, actionable: isApplicableAction(f.proposed_action) }));
}

/**
 * 조치안 묶음 적용(#1419 T9) — action_level='propose' 의 실체.
 *  report 는 쌓기만, auto 는 사람 없이 즉시, **propose 는 미리 만들어 두고 사람이 한 번에** 적용한다.
 *  적용된 것은 accepted 로 닫는다. 적용 불가·실패는 열린 채로 남긴다(조용히 닫으면 안 고쳐진 게 사라진다).
 */
export type ApplyFindingResult = "applied" | "stale" | "skipped" | "failed";
export async function applyFindings(
  ids: number[], actor: string,
  apply: (id: number, actor: string) => Promise<ApplyFindingResult>,
): Promise<{ applied: number; failed: number; skipped: number; stale: number }> {
  if (!ids.length) return { applied: 0, failed: 0, skipped: 0, stale: 0 };
  const rows = await q(itemsPool,
    `SELECT id, proposed_action FROM org_manager_finding WHERE id = ANY($1::bigint[]) AND state='open'`, [ids]);
  let applied = 0, failed = 0, skipped = 0, stale = 0;
  for (const r of rows as Array<{ id: number; proposed_action: unknown }>) {
    if (!isApplicableAction(r.proposed_action)) { skipped++; continue; }
    //  적용과 발견 전환(accepted · 낡았으면 resolved)은 apply 가 한 트랜잭션에서 한다 — 그 사이 사람이 반려한 발견을 덮지 않게.
    const res = await apply(Number(r.id), actor);
    if (res === "applied") applied++;
    else if (res === "stale") stale++;
    else if (res === "skipped") skipped++;
    else failed++;
  }
  return { applied, failed, skipped, stale };
}

/**
 * 발견 처리 — 승인/반려/해결로 닫는다.
 *  onlyOpen: 자동 전환(일괄 적용·재판정 해소)은 열린 발견만 닫는다 — 그 사이 사람이 반려한 발견을 resolved 로 덮으면
 *   다음 탐지가 그 발견을 다시 연다(upsertFinding 은 rejected 만 존중한다). 사람의 처리는 상태와 무관하게 덮는다(종전 동작).
 *  모순 발견을 반려하면 같은 트랜잭션에서 그 쌍의 관리기 링크를 해제한다 — 링크가 남으면 반려한 모순이 knowledge_get 경고로 계속 뜬다.
 */
export async function resolveFinding(
  id: number, state: "accepted" | "rejected" | "resolved", actor?: string, resolution?: string | null,
  opts: { onlyOpen?: boolean; source?: string; allowDismiss?: boolean } = {},
): Promise<FindingRow | null> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE org_manager_finding SET state=$2, resolved_at=now(), resolved_by=$3, resolution=$4
        WHERE id=$1${opts.onlyOpen ? " AND state='open'" : ""} RETURNING *`, [id, state, actor ?? null, resolution ?? null]);
    const row = (r.rows[0] as FindingRow) ?? null;
    //  allowDismiss=false — 반려한 사람이 두 지식을 다 쓸 수 없다. 발견만 반려하고 링크는 둔다(knowledge_link 해제와 같은 문턱).
    //  반려를 나중에 accepted·resolved 로 바꿔도 해제한 링크는 되살리지 않는다 — 되살리기는 사람이 다시 링크하는 길 하나다.
    if (row && state === "rejected" && opts.allowDismiss !== false && row.kind === "contradiction" && row.target_kind === "knowledge" && row.dedup_key) {
      await dismissManagerContradiction(client, row.target_ref, row.dedup_key, { actor: actor ?? null, source: opts.source ?? "web" });
    }
    await client.query("COMMIT");
    return row;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/** 열린 발견 하나를 잠근 채 넘긴다 — 조치 적용과 상태 전환을 한 트랜잭션으로 묶는 자리(applyFinding)가 쓴다.
 *  열려 있지 않으면 null(이미 누가 닫았다). */
export async function lockOpenFinding(client: Pick<PoolClient, "query">, id: number): Promise<{ id: number; proposed_action: unknown } | null> {
  const r = await client.query(
    `SELECT id, proposed_action FROM org_manager_finding WHERE id=$1 AND state='open' FOR UPDATE`, [id]);
  const row = r.rows[0] as { id: string | number; proposed_action: unknown } | undefined;
  return row ? { id: Number(row.id), proposed_action: row.proposed_action } : null;
}
export async function closeFindingIn(
  client: Pick<PoolClient, "query">, id: number, state: "accepted" | "resolved", actor: string, resolution: string,
): Promise<void> {
  await client.query(
    `UPDATE org_manager_finding SET state=$2, resolved_at=now(), resolved_by=$3, resolution=$4 WHERE id=$1 AND state='open'`,
    [id, state, actor, resolution]);
}

/**
 * 지식 하나에 열려 있는 «다시 읽어 보라» 발견(outdated · code_drift) — knowledge_get 응답의 review_hint.
 *  종류·id·처음 잡힌 시각만 싣는다. 요약·근거는 LLM 이 쓴 글이라 다른 지식의 이름이 들어갈 수 있고 그 공개범위를 거를 수 없다.
 *  발견이 마지막으로 잡힌(last_seen_at) 뒤 본문이 바뀐 지식은 뺀다 — 발견은 재판정 스위치가 꺼져 있거나 재판정이 없는 종류
 *   (code_drift)면 열린 채 남으므로, 고친 뒤에도 힌트가 매 세션 뜨지 않게. 다음 탐지가 또 잡으면 last_seen_at 이 올라 다시 뜬다.
 */
export async function openReviewHints(name: string): Promise<Array<{ kind: string; finding_id: number; detected_at: string }>> {
  const rows = await q(itemsPool,
    `SELECT f.kind, f.id, f.first_seen_at FROM org_manager_finding f
       JOIN knowledge k ON k.name = f.target_ref
      WHERE f.target_kind='knowledge' AND f.target_ref=$1 AND f.state='open' AND f.kind IN ('outdated','code_drift')
        AND COALESCE(k.body_updated_at, k.updated_at) <= f.last_seen_at
      ORDER BY f.first_seen_at LIMIT 5`, [name]);
  return rows.map((r) => ({ kind: String(r.kind), finding_id: Number(r.id), detected_at: String(new Date(String(r.first_seen_at)).toISOString()) }));
}

export interface ManagerUpsertInput {
  id?: number; key?: string; label?: string | null; kind?: ManagerKind;
  enabled?: boolean; priority?: number;
  match_categories?: unknown; match_types?: unknown;
  match_provenance?: string | null; exclude_names?: unknown; lookback_days?: number | null;
  threshold?: number | null; stale_days?: number | null;
  action_level?: string; criteria_md?: string | null;
  batch_size?: number; harness?: string | null; model?: string | null; effort?: string | null; requester?: string | null;
  note?: string | null;
}

function toList(v: unknown): string[] | null {
  if (v == null || v === "") return null;
  const arr = Array.isArray(v) ? v.map(String) : String(v).split(/[\n,]/);
  const out = arr.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : null;
}

export async function upsertManager(input: ManagerUpsertInput, actor?: string, source?: string): Promise<ManagerRow> {
  const cur = input.id ? await getManager(input.id) : (input.key ? await getManager(input.key) : null);
  if (input.id && !cur) throw new Error(`관리기를 찾을 수 없습니다: id=${input.id}`);
  const key = String(input.key ?? cur?.key ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!key) throw new Error("관리기 식별자(key)가 필요합니다");
  const kind = (input.kind ?? cur?.kind) as ManagerKind;
  if (!kind || !MANAGER_KIND_LABEL[kind]) throw new Error(`알 수 없는 관리기 종류: ${kind ?? "(미지정)"}`);
  // 종류를 바꾸면 판정 기준·발견 형태가 통째로 달라진다 — 기존 발견이 새 종류의 것인 양 남는다.
  if (cur && input.kind && input.kind !== cur.kind) {
    throw new Error("관리기 종류는 만든 뒤 바꿀 수 없습니다 — 새로 만들고 기존 것을 지우세요(발견 이력이 섞입니다)");
  }

  const pick = <T>(v: T | undefined, prev: T): T => (v === undefined ? prev : v);
  const vals = [
    key,
    pick(input.label, cur?.label ?? null),
    kind,
    pick(input.enabled, cur?.enabled ?? false),
    Number(pick(input.priority, cur?.priority ?? 0)) || 0,
    input.match_categories === undefined ? (cur?.match_categories ?? null) : toList(input.match_categories),
    input.match_types === undefined ? (cur?.match_types ?? null) : toList(input.match_types),
    input.match_provenance === undefined ? (cur?.match_provenance ?? null) : (input.match_provenance || null),
    input.exclude_names === undefined ? (cur?.exclude_names ?? null) : toList(input.exclude_names),
    input.lookback_days === undefined ? (cur?.lookback_days ?? null) : input.lookback_days,
    input.threshold === undefined ? (cur?.threshold ?? null) : input.threshold,
    input.stale_days === undefined ? (cur?.stale_days ?? null) : input.stale_days,
    pick(input.action_level, cur?.action_level ?? "report"),
    input.criteria_md === undefined ? (cur?.criteria_md ?? null) : input.criteria_md,
    Math.min(200, Math.max(1, Number(pick(input.batch_size, cur?.batch_size ?? 20)) || 20)),
    input.model === undefined ? (cur?.model ?? null) : input.model,
    input.effort === undefined ? (cur?.effort ?? null) : input.effort,
    input.requester === undefined ? (cur?.requester ?? null) : input.requester,
    input.note === undefined ? (cur?.note ?? null) : input.note,
    actor ?? null,
    input.harness === undefined ? (cur?.harness ?? null) : input.harness,   // $21 — 뒤에 붙인다(앞 번호를 밀지 않으려고)
  ];

  let id: number;
  if (cur) {
    await itemsPool.query(
      `UPDATE org_manager SET key=$1, label=$2, kind=$3, enabled=$4, priority=$5,
              match_categories=$6, match_types=$7, match_provenance=$8, exclude_names=$9,
              lookback_days=$10, threshold=$11, stale_days=$12, action_level=$13, criteria_md=$14,
              batch_size=$15, model=$16, effort=$17, requester=$18, note=$19,
              harness=$21,
              --  스위치(enabled)를 **바꿔** 저장했을 때만 자동 정지 표식을 지운다 — 폼은 바꾸지 않은 스위치도 보낸다(증류기 upsertDistiller 와 같은 규칙).
              --   관리기는 배타 배정이 없어 표식이 몫을 붙잡지는 않는다 — «자격 실패로 꺼진 관리기» 와 «사람이 끈 관리기» 를 가를
              --   재료로만 남는다(화면은 아직 이 표식을 읽지 않는다).
              last_summary=(CASE WHEN $23::boolean AND jsonb_typeof(last_summary)='object' THEN last_summary - 'auto_disabled' ELSE last_summary END),
              version=version+1, updated_at=now(), updated_by=$20
         WHERE id=$22`, [...vals, cur.id, input.enabled !== undefined && Boolean(input.enabled) !== Boolean(cur.enabled)]);
    id = cur.id;
  } else {
    const ins = await itemsPool.query(
      `INSERT INTO org_manager(key, label, kind, enabled, priority,
         match_categories, match_types, match_provenance, exclude_names,
         lookback_days, threshold, stale_days, action_level, criteria_md,
         batch_size, model, effort, requester, note, created_by, updated_by, harness)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20,$21)
       RETURNING id`, vals);
    id = Number((ins.rows[0] as { id: string | number }).id);
  }

  await audit("org_manager", String(id), cur ? "update" : "insert",
    cur ? { key: cur.key, kind: cur.kind, enabled: cur.enabled, action_level: cur.action_level } : null,
    { key, kind, enabled: vals[3], action_level: vals[12] }, actor, source);
  return (await getManager(id))!;
}

export async function removeManager(id: number, actor?: string, source?: string): Promise<void> {
  const cur = await getManager(id);
  if (!cur) return;
  // 발견은 FK CASCADE 로 함께 사라진다 — 관리기가 없으면 그 발견을 판단할 근거도 없다.
  await itemsPool.query(`DELETE FROM org_manager WHERE id=$1`, [id]);
  await audit("org_manager", String(id), "delete", { key: cur.key, kind: cur.kind }, null, actor, source);
}

export async function recordManagerRun(id: number, status: string, summary: unknown): Promise<void> {
  await itemsPool.query(
    //  자동 정지 표식은 보존한다 — 같은 틱에 형제 관리기의 401 로 이 관리기가 자동 정지된 뒤 이 기록이 덮으면
    //   «자격 실패로 꺼진 관리기» 를 가를 재료가 사라진다(node/auth-failure-response.stopLanes). 관리기에선 표식이 몫을 붙잡지 않고
    //   화면도 아직 읽지 않지만, 증류·분류와 같은 규칙으로 남겨 둔다.
    `UPDATE org_manager SET last_run_at=now(), last_status=$2,
            last_summary=(CASE WHEN jsonb_typeof(last_summary)='object' AND last_summary ? 'auto_disabled'
                               THEN $3::jsonb || jsonb_build_object('auto_disabled', last_summary->'auto_disabled', 'auto_disabled_reason', last_summary->'auto_disabled_reason')
                               ELSE $3::jsonb END)
      WHERE id=$1`,
    [id, status, JSON.stringify(summary ?? {})]).catch(() => undefined);
}

/** 관리 현황 — 파이프라인 화면(T6)의 '관리' 단계 카드가 읽는다. */
export async function managerOverview(): Promise<{
  managers: number; enabled: number;
  open: { total: number; high: number; warn: number; note: number };
  by_kind: Array<{ kind: string; label: string; enabled: boolean; open: number }>;
}> {
  const all = await listManagers();
  const sev = await q(itemsPool,
    `SELECT severity, count(*)::int AS n FROM org_manager_finding WHERE state='open' GROUP BY severity`);
  const bySev: Record<string, number> = {};
  for (const r of sev) bySev[String(r.severity)] = Number(r.n);
  const byKind = (Object.keys(MANAGER_KIND_LABEL) as ManagerKind[]).map((k) => {
    const ms = all.filter((m) => m.kind === k);
    return {
      kind: k, label: MANAGER_KIND_LABEL[k],
      enabled: ms.some((m) => m.enabled),
      open: ms.reduce((s, m) => s + Number(m.open_findings ?? 0), 0),
    };
  });
  return {
    managers: all.length, enabled: all.filter((m) => m.enabled).length,
    open: {
      total: (bySev.high ?? 0) + (bySev.warn ?? 0) + (bySev.note ?? 0),
      high: bySev.high ?? 0, warn: bySev.warn ?? 0, note: bySev.note ?? 0,
    },
    by_kind: byKind,
  };
}
