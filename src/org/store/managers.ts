// org_manager — 관리기 레지스트리 + 발견(org_manager_finding) 큐(#1419 T5).
//
//  이 파일에서 가장 조심한 것은 **멱등 발견**이다. 관리기는 주기적으로 도는데 같은 문제는 매번 다시 발견된다.
//  그때마다 새 행을 만들면 큐가 같은 항목의 사본으로 뒤덮여 아무도 안 보고, 무엇보다 사람이 내린 '반려'가
//  다음 주기에 무의미해진다(반려한 것이 새 항목으로 또 올라온다). 그래서 재발견은 카운트만 올린다.
import { itemsPool, q } from "../../db/client.js";
import { audit } from "./audit.js";
import { isApplicableAction } from "../manage/action-whitelist.js";
import type { Finding } from "../manage/detectors.js";

export type ManagerKind = "mismatch" | "outdated" | "stale_ref" | "contradiction" | "code_drift";

export interface ManagerRow {
  id: number; key: string; label: string | null; kind: ManagerKind;
  enabled: boolean; priority: number;
  match_spaces: string[] | null; match_categories: string[] | null; match_types: string[] | null;
  match_provenance: string | null; exclude_names: string[] | null; lookback_days: number | null;
  threshold: number | null; stale_days: number | null;
  action_level: string; criteria_md: string | null;
  batch_size: number; model: string | null; effort: string | null; requester: string | null;
  last_run_at: string | null; last_status: string | null; last_summary: unknown; note: string | null;
  /** 파생 — 열린 발견 수(목록 배지). */
  open_findings?: number;
}

const COLS = `id, key, label, kind, enabled, priority,
  match_spaces, match_categories, match_types, match_provenance, exclude_names, lookback_days,
  threshold, stale_days, action_level, criteria_md,
  batch_size, model, effort, requester, last_run_at, last_status, last_summary, note`;

/** kind 별 사람 읽는 이름 — 화면·요약 공용(한 곳에서 정의해 표기가 갈리지 않게). */
export const MANAGER_KIND_LABEL: Record<ManagerKind, string> = {
  mismatch: "분류 어긋남 후보",
  outdated: "지식 아웃데이티드",
  // #1419 도그푸드 산출 — mismatch·outdated 가 우리 조직에서 '낡은 지식'을 못 보는 자리를 결정론으로 메운다.
  stale_ref: "사라진 코드 경로 인용",
  contradiction: "지식 간 모순",
  code_drift: "지식 ↔ 코드 비교",
};

/** LLM 판정이 필요한 종류인가 — 크론이 배치 접수 여부를 이걸로 가른다. */
export function needsLlm(kind: ManagerKind): boolean {
  return kind === "contradiction" || kind === "code_drift";
}

/** 결정적 종류 — 이 호출 안에서 판정·저장이 끝난다(LLM 0). needsLlm 의 여집합이지만 이름으로 읽히게 둔다. */
export const DETERMINISTIC_KINDS: ManagerKind[] = ["mismatch", "outdated", "stale_ref"];

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
export async function upsertFinding(managerId: number, kind: string, f: Finding): Promise<"new" | "again" | "skipped"> {
  const r = await itemsPool.query(`
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
    RETURNING (xmax = 0) AS inserted, state`,
    [managerId, kind, f.target_kind, f.target_ref, f.dedup_key ?? "",
     f.severity, f.summary, f.evidence ?? null,
     f.proposed_action == null ? null : JSON.stringify(f.proposed_action)]);
  const row = r.rows[0] as { inserted: boolean; state: string } | undefined;
  if (!row) return "skipped";
  return row.inserted ? "new" : (row.state === "rejected" ? "skipped" : "again");
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
   *  판정은 applyAction 과 **같은 화이트리스트**(isApplicableAction)를 쓴다 — 서로 다르면
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
  // 적용 가능 여부는 applyAction 과 **같은 판정**으로 파생한다(#1419 T9) — 화면이 자기 규칙을 따로 갖지 않게.
  return (rows as FindingRow[]).map((f) => ({ ...f, actionable: isApplicableAction(f.proposed_action) }));
}

/**
 * 조치안 묶음 적용(#1419 T9) — action_level='propose' 의 실체.
 *  report 는 쌓기만, auto 는 사람 없이 즉시, **propose 는 미리 만들어 두고 사람이 한 번에** 적용한다.
 *  적용된 것은 accepted 로 닫는다. 적용 불가·실패는 열린 채로 남긴다(조용히 닫으면 안 고쳐진 게 사라진다).
 */
export async function applyFindings(
  ids: number[], actor: string,
  apply: (action: unknown, actor: string) => Promise<boolean>,
): Promise<{ applied: number; failed: number; skipped: number }> {
  if (!ids.length) return { applied: 0, failed: 0, skipped: 0 };
  const rows = await q(itemsPool,
    `SELECT id, proposed_action FROM org_manager_finding WHERE id = ANY($1::bigint[]) AND state='open'`, [ids]);
  let applied = 0, failed = 0, skipped = 0;
  for (const r of rows as Array<{ id: number; proposed_action: unknown }>) {
    if (!isApplicableAction(r.proposed_action)) { skipped++; continue; }
    if (await apply(r.proposed_action, actor)) {
      await resolveFinding(Number(r.id), "accepted", actor, "제안된 조치 일괄 적용");
      applied++;
    } else failed++;
  }
  return { applied, failed, skipped };
}

/** 발견 처리 — 사람이 승인/반려/해결로 닫는다. */
export async function resolveFinding(
  id: number, state: "accepted" | "rejected" | "resolved", actor?: string, resolution?: string | null,
): Promise<FindingRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_manager_finding SET state=$2, resolved_at=now(), resolved_by=$3, resolution=$4
      WHERE id=$1 RETURNING *`, [id, state, actor ?? null, resolution ?? null]);
  return (r.rows[0] as FindingRow) ?? null;
}

/**
 * **이번 전수 실행에서 다시 발견되지 않은 열린 발견을 닫는다**(#1419 도그푸드 2차).
 *
 * ⚠ 왜 필요한가 — 이게 없으면 **큐가 고쳐서 줄어들지 않는다.** 사람이 문서를 고치면 다음 실행에서
 *  안 잡히기만 하고 발견은 `open` 으로 영원히 남는다. 그러면 큐가 단조증가하고 '할 일'이라는 뜻을
 *  잃는다 — 자동 관리의 가치가 정확히 여기서 무너진다. 실측에서도 판정기를 고쳐 유령 6건이 더 이상
 *  생성되지 않게 됐는데 큐엔 그대로 남아 있었다.
 *
 * ⚠⚠ **전수 실행일 때만 부른다.** batch_size 로 잘린 실행에서 부르면 '배치 밖이라 못 본 것'을
 *  '고쳐진 것'으로 닫아 버린다 — 조용한 데이터 손실이다. 호출자가 truncated 여부를 판단한다.
 *
 * rejected 는 건드리지 않는다(반려 영속 — 사람의 '오탐이다'가 최신 판단이다).
 * accepted 는 닫는다(고치겠다고 했고 이제 안 잡히니 고쳐진 것이다).
 */
export async function resolveUnseenFindings(
  managerId: number, seenSince: string, actor = "manager:sweep",
): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_manager_finding
        SET state='resolved', resolved_at=now(), resolved_by=$3,
            resolution='이번 전수 판정에서 다시 발견되지 않았습니다 — 고쳐진 것으로 봅니다.'
      WHERE manager_id=$1
        AND state IN ('open','accepted')
        AND last_seen_at < $2`,
    [managerId, seenSince, actor]);
  return r.rowCount ?? 0;
}

export interface ManagerUpsertInput {
  id?: number; key?: string; label?: string | null; kind?: ManagerKind;
  enabled?: boolean; priority?: number;
  match_spaces?: unknown; match_categories?: unknown; match_types?: unknown;
  match_provenance?: string | null; exclude_names?: unknown; lookback_days?: number | null;
  threshold?: number | null; stale_days?: number | null;
  action_level?: string; criteria_md?: string | null;
  batch_size?: number; model?: string | null; effort?: string | null; requester?: string | null;
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
    input.match_spaces === undefined ? (cur?.match_spaces ?? null) : toList(input.match_spaces),
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
  ];

  let id: number;
  if (cur) {
    await itemsPool.query(
      `UPDATE org_manager SET key=$1, label=$2, kind=$3, enabled=$4, priority=$5,
              match_spaces=$6, match_categories=$7, match_types=$8, match_provenance=$9, exclude_names=$10,
              lookback_days=$11, threshold=$12, stale_days=$13, action_level=$14, criteria_md=$15,
              batch_size=$16, model=$17, effort=$18, requester=$19, note=$20,
              version=version+1, updated_at=now(), updated_by=$21
         WHERE id=$22`, [...vals, cur.id]);
    id = cur.id;
  } else {
    const ins = await itemsPool.query(
      `INSERT INTO org_manager(key, label, kind, enabled, priority,
         match_spaces, match_categories, match_types, match_provenance, exclude_names,
         lookback_days, threshold, stale_days, action_level, criteria_md,
         batch_size, model, effort, requester, note, created_by, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
       RETURNING id`, vals);
    id = Number((ins.rows[0] as { id: string | number }).id);
  }

  await audit("org_manager", String(id), cur ? "update" : "insert",
    cur ? { key: cur.key, kind: cur.kind, enabled: cur.enabled, action_level: cur.action_level } : null,
    { key, kind, enabled: vals[3], action_level: vals[13] }, actor, source);
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
    `UPDATE org_manager SET last_run_at=now(), last_status=$2, last_summary=$3::jsonb WHERE id=$1`,
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
