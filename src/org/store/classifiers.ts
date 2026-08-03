// org_classifier — 분류기 레지스트리 + **스코프된 인박스**(#1419 T4). 증류기(store/ingest.ts)의 분류판.
//
//  이 파일의 어려운 부분은 CRUD 가 아니라 `classifierInbox` 다 — "이 분류기가 지금 맡은 지식은 무엇인가".
//  배타 배정(한 지식은 가장 앞선 분류기 하나에만)을 SQL 한 번으로 풀어야 하고, 그게 아니면 분류기를 둘
//  만드는 순간 둘이 같은 지식을 동시에 분류해 서로의 제안을 덮는다.
import { itemsPool, q } from "../../db/client.js";
import { audit } from "./audit.js";

export interface ClassifierRow {
  id: number; key: string; label: string | null; enabled: boolean; priority: number;
  target: string; confidence_below: number | null;
  match_spaces: string[] | null; match_types: string[] | null; match_provenance: string | null;
  match_systems: string[] | null; exclude_names: string[] | null;
  min_chars: number; lookback_days: number | null;
  criteria_md: string | null; candidate_categories: string[] | null; confirm_threshold: number;
  batch_size: number; mode: string; session_ref: string | null;
  model: string | null; effort: string | null; requester: string | null;
  last_run_at: string | null; last_status: string | null; last_summary: unknown;
  note: string | null;
  /** 파생 — 화면용 '무엇을 맡나' 한 줄 요약. */
  scope_text?: string;
}

const COLS = `id, key, label, enabled, priority, target, confidence_below,
  match_spaces, match_types, match_provenance, match_systems, exclude_names,
  min_chars, lookback_days, criteria_md, candidate_categories, confirm_threshold,
  batch_size, mode, session_ref, model, effort, requester,
  last_run_at, last_status, last_summary, note`;

/** 사람이 읽는 스코프 한 줄 — 목록에서 '이 분류기가 뭘 맡나'가 바로 보이게. */
function scopeText(r: ClassifierRow): string {
  const bits: string[] = [];
  bits.push(r.target === "unmapped" ? "미분류" : r.target === "low_confidence" ? "낮은 확신도 재분류" : "미분류 + 재분류");
  if (r.match_spaces?.length) bits.push(`space ${r.match_spaces.join("·")}`);
  if (r.match_types?.length) bits.push(`유형 ${r.match_types.join("·")}`);
  if (r.match_provenance) bits.push(r.match_provenance === "authored" ? "저작" : "미러");
  if (r.match_systems?.length) bits.push(`출처 ${r.match_systems.join("·")}`);
  if (r.candidate_categories?.length) bits.push(`후보 ${r.candidate_categories.length}개 축`);
  if (r.lookback_days) bits.push(`최근 ${r.lookback_days}일`);
  return bits.join(" · ") || "전체";
}

/**
 * 한 분류기의 스코프 WHERE 절 — 인박스·커버리지·미리보기가 **같은 조건**을 쓰게 한 곳에서 만든다.
 *  (화면의 '남은 건수'와 실제로 배치에 실리는 것이 다르면 그 화면은 거짓말을 하는 것이다.)
 *
 *  ⚠ params 를 **공유 배열로 이어 받는다** — 배타 배정이 이 함수를 여러 번(나 + 앞선 분류기 수만큼) 부르고
 *   그 조각들이 한 쿼리에 합쳐지기 때문이다. 그래서 자리표시자 번호는 반드시 배열 길이에서 파생해야 한다.
 *   여기서 번호가 어긋나면 **엉뚱한 값으로 필터링되면서도 쿼리는 성공한다**(조용한 오작동) — 그래서 테스트로 잠갔다.
 *  @internal 테스트 전용 노출(classifier-scope.test.ts).
 */
export function scopeWhere(r: ClassifierRow, params: unknown[]): string {
  const w: string[] = ["k.lifecycle='active'"];

  // 대상 — 미분류(카테고리 행 0건) / 낮은 확신도 제안(재분류) / 둘 다.
  const unmapped = `NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name)`;
  if (r.target === "unmapped") w.push(unmapped);
  else {
    params.push(r.confidence_below ?? 0.8);
    const lowConf = `EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name
       AND kc.state='proposed' AND (kc.confidence IS NULL OR kc.confidence < $${params.length}))`;
    w.push(r.target === "low_confidence" ? lowConf : `(${unmapped} OR ${lowConf})`);
  }

  if (r.match_types?.length) { params.push(r.match_types); w.push(`k.type = ANY($${params.length}::text[])`); }
  if (r.match_provenance) { params.push(r.match_provenance); w.push(`k.provenance = $${params.length}`); }
  if (r.match_systems?.length) { params.push(r.match_systems); w.push(`k.external_system = ANY($${params.length}::text[])`); }
  if (r.exclude_names?.length) { params.push(r.exclude_names); w.push(`NOT (k.name = ANY($${params.length}::text[]))`); }
  if (r.min_chars > 0) { params.push(r.min_chars); w.push(`char_length(COALESCE(k.body_md,'')) >= $${params.length}`); }
  if (r.lookback_days) { params.push(r.lookback_days); w.push(`k.updated_at >= now() - ($${params.length} || ' days')::interval`); }
  // space 는 지식에 직접 없다 — 이미 붙은 분류의 space 로 좁힌다(재분류 시나리오에서 의미가 있고,
  //  미분류 지식은 space 가 없으므로 이 조건을 걸면 자연히 제외된다).
  if (r.match_spaces?.length) {
    params.push(r.match_spaces);
    w.push(`EXISTS (SELECT 1 FROM knowledge_category kc2 JOIN category c2 ON c2.id=kc2.category_id
              WHERE kc2.name=k.name AND c2.space = ANY($${params.length}::text[]))`);
  }
  return w.join(" AND ");
}

export async function listClassifiers(): Promise<ClassifierRow[]> {
  const rows = await q(itemsPool, `SELECT ${COLS} FROM org_classifier ORDER BY priority DESC, id`);
  return rows.map((r) => { const row = r as ClassifierRow; row.scope_text = scopeText(row); return row; });
}

export async function getClassifier(idOrKey: number | string): Promise<ClassifierRow | null> {
  const rows = typeof idOrKey === "number"
    ? await q(itemsPool, `SELECT ${COLS} FROM org_classifier WHERE id=$1`, [idOrKey])
    : await q(itemsPool, `SELECT ${COLS} FROM org_classifier WHERE key=$1`, [idOrKey]);
  if (!rows[0]) return null;
  const row = rows[0] as ClassifierRow;
  row.scope_text = scopeText(row);
  return row;
}

/**
 * 이 분류기가 지금 맡은 지식 — **배타 배정**이 여기 들어 있다.
 *
 *  한 지식은 스코프가 겹치는 분류기 중 **우선순위가 가장 높은 하나**에만 배정된다. 안 그러면 분류기를 둘
 *  만드는 순간 둘이 같은 지식을 동시에 분류해 서로의 제안을 덮어쓴다(마지막에 쓴 쪽이 이긴다 — 비결정적).
 *  구현: 나보다 앞선(우선순위 높은) 켜진 분류기의 스코프에 걸리는 지식을 뺀다.
 *
 *  ⚠ 이미 판정한 것(org_classifier_seen)도 뺀다 — 증류기 실측(#1289)에서 'skip 한 것이 매 배치 재등장'이
 *   진행을 0 으로 만들었다. 분류는 updated_at DESC 정렬이라 더 나쁘다(못 정한 것이 영원히 맨 앞).
 */
export async function classifierInbox(
  r: ClassifierRow, limit?: number,
): Promise<Array<{ name: string; title: string | null; type: string | null; provenance: string }>> {
  const params: unknown[] = [];
  const where = scopeWhere(r, params);

  // 나보다 앞선 켜진 분류기들 — 그들의 스코프에 걸리면 내 몫이 아니다.
  const ahead = (await q(itemsPool,
    `SELECT ${COLS} FROM org_classifier
      WHERE enabled=true AND (priority > $1 OR (priority = $1 AND id < $2))
      ORDER BY priority DESC, id`, [r.priority, r.id])) as ClassifierRow[];
  const notClauses = ahead.map((a) => `NOT (${scopeWhere(a, params)})`);

  params.push(r.id);
  const seenP = `$${params.length}`;
  params.push(Math.min(Math.max(1, limit ?? r.batch_size), 500));
  const limP = `$${params.length}`;

  const rows = await q(itemsPool, `
    SELECT k.name, k.title, k.type, k.provenance
      FROM knowledge k
     WHERE ${where}
       ${notClauses.length ? `AND ${notClauses.join(" AND ")}` : ""}
       AND NOT EXISTS (SELECT 1 FROM org_classifier_seen s WHERE s.classifier_id=${seenP} AND s.knowledge_name=k.name)
     ORDER BY k.updated_at DESC
     LIMIT ${limP}`, params);
  return rows.map((x) => ({
    name: x.name as string, title: (x.title ?? null) as string | null,
    type: (x.type ?? null) as string | null, provenance: x.provenance as string,
  }));
}

/** 커버리지 — 분류기별 잔량 + 어느 분류기에도 안 걸리는 사각지대. 화면 최상단(#1289 UX 계승). */
export async function classifierCoverage(): Promise<{
  total_unclassified: number; uncovered: number;
  classifiers: Array<{ id: number; key: string; backlog: number; reviewed: number }>;
}> {
  const all = await listClassifiers();
  const on = all.filter((c) => c.enabled);
  const totalRow = await q(itemsPool,
    `SELECT count(*)::int AS n FROM knowledge k WHERE k.lifecycle='active'
       AND NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name)`);
  const total = Number((totalRow[0] as { n: number } | undefined)?.n ?? 0);

  const per: Array<{ id: number; key: string; backlog: number; reviewed: number }> = [];
  const covered = new Set<string>();
  for (const c of on) {
    // 잔량은 배치 상한과 무관한 '전체'를 세야 한다 — 상한으로 세면 500 에서 멈춰 "안 줄어든다"로 보인다.
    const items = await classifierInbox(c, 500);
    for (const it of items) covered.add(it.name);
    const rv = await q(itemsPool, `SELECT count(*)::int AS n FROM org_classifier_seen WHERE classifier_id=$1`, [c.id]);
    per.push({ id: c.id, key: c.key, backlog: items.length, reviewed: Number((rv[0] as { n: number } | undefined)?.n ?? 0) });
  }
  // 사각지대 — 미분류인데 켜진 어느 분류기도 안 집는 것. 켜진 분류기가 0개면 전부가 사각지대다.
  const uncovered = Math.max(0, total - covered.size);
  return { total_unclassified: total, uncovered, classifiers: per };
}

/** 배치를 낸 시점에 '봤다'를 기록 — LLM 자기보고에 의존하지 않는다(#1289 교훈). */
export async function markClassifierSeen(classifierId: number, names: string[], taskId?: number | null): Promise<void> {
  if (!names.length) return;
  await itemsPool.query(
    `INSERT INTO org_classifier_seen(classifier_id, knowledge_name, task_id)
       SELECT $1, unnest($2::text[]), $3
     ON CONFLICT (classifier_id, knowledge_name) DO NOTHING`, [classifierId, names, taskId ?? null]);
}

export interface ClassifierUpsertInput {
  id?: number; key?: string; label?: string | null; enabled?: boolean; priority?: number;
  target?: string; confidence_below?: number | null;
  match_spaces?: string[] | string | null; match_types?: string[] | string | null;
  match_provenance?: string | null; match_systems?: string[] | string | null;
  exclude_names?: string[] | string | null;
  min_chars?: number; lookback_days?: number | null;
  criteria_md?: string | null; candidate_categories?: string[] | string | null; confirm_threshold?: number;
  batch_size?: number; mode?: string; session_ref?: string | null;
  model?: string | null; effort?: string | null; requester?: string | null; note?: string | null;
  /** 기준을 바꿔 다시 보고 싶을 때 — '봤다' 기록을 비운다. */
  reset_seen?: boolean;
}

/** 줄바꿈·쉼표 구분 텍스트 또는 배열 → 배열. 화면이 textarea 로 주므로 둘 다 받는다. */
function toList(v: unknown): string[] | null {
  if (v == null || v === "") return null;
  const arr = Array.isArray(v) ? v.map(String) : String(v).split(/[\n,]/);
  const out = arr.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : null;
}

export async function upsertClassifier(input: ClassifierUpsertInput, actor?: string, source?: string): Promise<ClassifierRow> {
  const cur = input.id ? await getClassifier(input.id) : (input.key ? await getClassifier(input.key) : null);
  if (input.id && !cur) throw new Error(`분류기를 찾을 수 없습니다: id=${input.id}`);
  const key = String(input.key ?? cur?.key ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!key) throw new Error("분류기 식별자(key)가 필요합니다");

  const pick = <T>(v: T | undefined, prev: T): T => (v === undefined ? prev : v);
  const row = {
    key,
    label: pick(input.label, cur?.label ?? null),
    enabled: pick(input.enabled, cur?.enabled ?? false),
    priority: Number(pick(input.priority, cur?.priority ?? 0)) || 0,
    target: pick(input.target, cur?.target ?? "unmapped"),
    confidence_below: input.confidence_below === undefined ? (cur?.confidence_below ?? null) : input.confidence_below,
    match_spaces: input.match_spaces === undefined ? (cur?.match_spaces ?? null) : toList(input.match_spaces),
    match_types: input.match_types === undefined ? (cur?.match_types ?? null) : toList(input.match_types),
    match_provenance: input.match_provenance === undefined ? (cur?.match_provenance ?? null) : (input.match_provenance || null),
    match_systems: input.match_systems === undefined ? (cur?.match_systems ?? null) : toList(input.match_systems),
    exclude_names: input.exclude_names === undefined ? (cur?.exclude_names ?? null) : toList(input.exclude_names),
    min_chars: Number(pick(input.min_chars, cur?.min_chars ?? 0)) || 0,
    lookback_days: input.lookback_days === undefined ? (cur?.lookback_days ?? null) : input.lookback_days,
    criteria_md: input.criteria_md === undefined ? (cur?.criteria_md ?? null) : input.criteria_md,
    candidate_categories: input.candidate_categories === undefined ? (cur?.candidate_categories ?? null) : toList(input.candidate_categories),
    confirm_threshold: Math.min(1, Math.max(0, Number(pick(input.confirm_threshold, cur?.confirm_threshold ?? 0.8)))),
    batch_size: Math.min(500, Math.max(1, Number(pick(input.batch_size, cur?.batch_size ?? 50)) || 50)),
    mode: pick(input.mode, cur?.mode ?? "headless"),
    session_ref: input.session_ref === undefined ? (cur?.session_ref ?? null) : input.session_ref,
    model: input.model === undefined ? (cur?.model ?? null) : input.model,
    effort: input.effort === undefined ? (cur?.effort ?? null) : input.effort,
    requester: input.requester === undefined ? (cur?.requester ?? null) : input.requester,
    note: input.note === undefined ? (cur?.note ?? null) : input.note,
  };

  const vals = [row.key, row.label, row.enabled, row.priority, row.target, row.confidence_below,
    row.match_spaces, row.match_types, row.match_provenance, row.match_systems, row.exclude_names,
    row.min_chars, row.lookback_days, row.criteria_md, row.candidate_categories, row.confirm_threshold,
    row.batch_size, row.mode, row.session_ref, row.model, row.effort, row.requester, row.note, actor ?? null];

  let id: number;
  if (cur) {
    await itemsPool.query(
      `UPDATE org_classifier SET key=$1, label=$2, enabled=$3, priority=$4, target=$5, confidence_below=$6,
              match_spaces=$7, match_types=$8, match_provenance=$9, match_systems=$10, exclude_names=$11,
              min_chars=$12, lookback_days=$13, criteria_md=$14, candidate_categories=$15, confirm_threshold=$16,
              batch_size=$17, mode=$18, session_ref=$19, model=$20, effort=$21, requester=$22, note=$23,
              version=version+1, updated_at=now(), updated_by=$24
         WHERE id=$25`, [...vals, cur.id]);
    id = cur.id;
  } else {
    const ins = await itemsPool.query(
      `INSERT INTO org_classifier(key, label, enabled, priority, target, confidence_below,
         match_spaces, match_types, match_provenance, match_systems, exclude_names,
         min_chars, lookback_days, criteria_md, candidate_categories, confirm_threshold,
         batch_size, mode, session_ref, model, effort, requester, note, created_by, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24)
       RETURNING id`, vals);
    id = Number((ins.rows[0] as { id: string | number }).id);
  }

  // 기준을 바꿨으면 '봤다'를 비운다 — 안 그러면 새 기준으로 다시 볼 기회가 영영 없다.
  if (input.reset_seen) await itemsPool.query(`DELETE FROM org_classifier_seen WHERE classifier_id=$1`, [id]);

  await audit("org_classifier", String(id), cur ? "update" : "insert",
    cur ? { key: cur.key, enabled: cur.enabled, priority: cur.priority, target: cur.target } : null,
    { key: row.key, enabled: row.enabled, priority: row.priority, target: row.target }, actor, source);

  return (await getClassifier(id))!;
}

export async function removeClassifier(id: number, actor?: string, source?: string): Promise<void> {
  const cur = await getClassifier(id);
  if (!cur) return;
  // seen 은 FK CASCADE 로 함께 사라진다. 이미 만들어진 분류 제안은 남는다(지식의 자산이지 분류기의 것이 아니다).
  await itemsPool.query(`DELETE FROM org_classifier WHERE id=$1`, [id]);
  await audit("org_classifier", String(id), "delete", { key: cur.key, enabled: cur.enabled }, null, actor, source);
}

/** 실행 결과 기록 — 크론 액션이 배치를 접수한 뒤 부른다(증류기 recordDistillerRun 과 동형). */
export async function recordClassifierRun(id: number, status: string, summary: unknown): Promise<void> {
  await itemsPool.query(
    `UPDATE org_classifier SET last_run_at=now(), last_status=$2, last_summary=$3::jsonb WHERE id=$1`,
    [id, status, JSON.stringify(summary ?? {})]).catch(() => undefined);
}
