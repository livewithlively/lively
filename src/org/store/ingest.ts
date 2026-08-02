// 자동 인입 라인 — org_ingest_policy(허용선 정책 #638) · org_distiller(자료 증류기 #1289) · 인입 게이트 관측(#656).
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { invalidateIngestPolicyCache } from "../ingest/ingest-policy-load.js";   // #783 정책 쓰기 → 캐시 즉시 무효화(스위치가 곧바로 먹게)
import { audit } from "./audit.js";

// ════════ 자동 인입 허용선 정책 — org_ingest_policy (프로젝트 #638) ════════
//  distill/mirror 가 지식을 auto(즉시 active)|confirm(pending 격리→검토 큐)|drop(미적재) 중 어디로 보낼지 오너가 조절.
//  평가는 순수함수 resolveIngestPolicy(org/ingest/ingest-policy.ts) — 여기선 CRUD 만. 디폴트(규칙 0)=auto(현행 무변).

export interface IngestPolicyRow {
  id: number; enabled: boolean;
  match_category: string | null; match_system: string | null; match_channel: string | null;
  match_provenance: string | null; match_sensitive: string | null;
  match_actor_kind: string | null; match_agent: string | null; match_type: string | null;
  action: string; action_update: string; is_exception: boolean; preset: string | null;
  priority: number; note: string | null; updated_at: string | null;
}
const IPOL_SEL = `id, enabled, match_category, match_system, match_channel, match_provenance, match_sensitive,
  match_actor_kind, match_agent, match_type, action, action_update, is_exception, preset, priority, note, updated_at`;

export async function listIngestPolicies(): Promise<IngestPolicyRow[]> {
  const r = await itemsPool.query(`SELECT ${IPOL_SEL} FROM org_ingest_policy ORDER BY priority DESC, id`);
  return r.rows;
}

export interface IngestPolicyUpsertInput {
  id?: number; enabled?: boolean;
  match_category?: string | null; match_system?: string | null; match_channel?: string | null;
  match_provenance?: string | null; match_sensitive?: string | null;
  match_actor_kind?: string | null; match_agent?: string | null; match_type?: string | null;
  action?: string; action_update?: string; is_exception?: boolean; preset?: string | null;
  priority?: number; note?: string | null;
}

// 매치 축 정규화 — 빈 문자열/undefined/null → null(any). axisMatch(ingest-policy.ts) 와 일관되게 '없음'은 항상 null 로 저장.
function normMatch(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// #783 프리셋 규칙(관리탭 스위치가 관리)은 id 없이도 preset 키로 찾아 갱신한다 — 스위치 토글이 중복 행을 만들지 않게.
export async function upsertIngestPolicy(input: IngestPolicyUpsertInput, actor?: string, source?: string): Promise<IngestPolicyRow> {
  const action = input.action ?? "confirm";
  if (!["auto", "confirm", "drop"].includes(action)) throw new Error("action 은 auto|confirm|drop");
  const actionUpdate = input.action_update ?? "auto";
  if (!["auto", "review", "stage", "drop"].includes(actionUpdate)) throw new Error("action_update 는 auto|review|stage|drop");
  const prov = normMatch(input.match_provenance);
  if (prov !== null && !["authored", "observed"].includes(prov)) throw new Error("match_provenance 는 authored|observed 또는 비움");
  const actorKind = normMatch(input.match_actor_kind);
  if (actorKind !== null && !["ai", "human"].includes(actorKind)) throw new Error("match_actor_kind 는 ai|human 또는 비움");
  const vals = {
    enabled: input.enabled ?? true,
    match_category: normMatch(input.match_category),
    match_system: normMatch(input.match_system),
    match_channel: normMatch(input.match_channel),
    match_provenance: prov,
    match_sensitive: normMatch(input.match_sensitive),
    match_actor_kind: actorKind,
    match_agent: normMatch(input.match_agent),
    match_type: normMatch(input.match_type),
    action,
    action_update: actionUpdate,
    is_exception: input.is_exception ?? false,
    preset: normMatch(input.preset),
    priority: Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0,
    note: input.note === undefined || input.note === "" ? null : input.note,
  };
  // 대상 행 결정 — id 우선, 없으면 preset 키(스위치 경로).
  let targetId = input.id ?? null;
  if (!targetId && vals.preset) {
    const p = await itemsPool.query(`SELECT id FROM org_ingest_policy WHERE preset=$1`, [vals.preset]);
    targetId = p.rows[0]?.id ?? null;
  }
  if (targetId) {
    const cur = await itemsPool.query(`SELECT ${IPOL_SEL} FROM org_ingest_policy WHERE id=$1`, [targetId]);
    const before = cur.rows[0];
    if (!before) throw new Error(`org_ingest_policy #${targetId} 없음`);
    const r = await itemsPool.query(
      `UPDATE org_ingest_policy SET enabled=$2, match_category=$3, match_system=$4, match_channel=$5,
         match_provenance=$6, match_sensitive=$7, action=$8, priority=$9, note=$10,
         match_actor_kind=$12, match_agent=$13, match_type=$14, action_update=$15, is_exception=$16, preset=$17,
         version=version+1, updated_at=now(), updated_by=$11
       WHERE id=$1 RETURNING ${IPOL_SEL}`,
      [targetId, vals.enabled, vals.match_category, vals.match_system, vals.match_channel, vals.match_provenance,
       vals.match_sensitive, vals.action, vals.priority, vals.note, actor ?? null,
       vals.match_actor_kind, vals.match_agent, vals.match_type, vals.action_update, vals.is_exception, vals.preset]);
    await audit("org_ingest_policy", String(targetId), "update", before, r.rows[0], actor, source);
    invalidateIngestPolicyCache();   // 관리탭 저장 즉시 반영(캐시 TTL 대기 없이)
    return r.rows[0];
  }
  const r = await itemsPool.query(
    `INSERT INTO org_ingest_policy(enabled, match_category, match_system, match_channel, match_provenance, match_sensitive,
       action, priority, note, created_by, updated_by, match_actor_kind, match_agent, match_type, action_update, is_exception, preset)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16) RETURNING ${IPOL_SEL}`,
    [vals.enabled, vals.match_category, vals.match_system, vals.match_channel, vals.match_provenance, vals.match_sensitive,
     vals.action, vals.priority, vals.note, actor ?? null,
     vals.match_actor_kind, vals.match_agent, vals.match_type, vals.action_update, vals.is_exception, vals.preset]);
  await audit("org_ingest_policy", String(r.rows[0].id), "insert", null, r.rows[0], actor, source);
  invalidateIngestPolicyCache();
  return r.rows[0];
}

export async function removeIngestPolicy(id: number, actor?: string, source?: string): Promise<void> {
  const cur = await itemsPool.query(`SELECT ${IPOL_SEL} FROM org_ingest_policy WHERE id=$1`, [id]);
  if (!cur.rows[0]) return;
  await itemsPool.query(`DELETE FROM org_ingest_policy WHERE id=$1`, [id]);
  await audit("org_ingest_policy", String(id), "delete", cur.rows[0], null, actor, source);
  invalidateIngestPolicyCache();
}

// ════════ 자료 증류기 — org_distiller (프로젝트 #1289) ════════
//  "어떤 자료를 · 무슨 기준으로 · 어떤 형식의 지식으로" 를 n개 정의. 스코프·배타배정·프롬프트는 org/distill/distiller.ts,
//  여기선 CRUD 만(ingest-policy 와 동형). 실행은 scheduler 의 distill_sources[_headless] 액션.
//  ⚠ 정책(밸브)이 아니라 생산 라인이다 — 캐시 무효화 대상 없음(매 배치 DB 를 읽는다).

export interface DistillerUpsertInput {
  id?: number;
  key?: string;
  label?: string | null;
  enabled?: boolean;
  priority?: number;
  match_kinds?: string[] | string | null;
  match_system?: string | null;
  include_channels?: string[] | string | null;
  exclude_channels?: string[] | string | null;
  include_authors?: string[] | string | null;
  exclude_authors?: string[] | string | null;
  exclude_bots?: boolean;
  min_chars?: number;
  lookback_days?: number | null;
  criteria_md?: string | null;
  format_md?: string | null;
  target_category?: string | null;
  default_type?: string | null;
  name_prefix?: string | null;
  thread_aware?: boolean;
  prefilter_level?: number;
  prefilter_rules?: Record<string, unknown> | null;
  batch_size?: number;
  batch_max_msgs?: number;
  mode?: string;
  session_ref?: string | null;
  model?: string | null;
  effort?: string | null;
  requester?: string | null;
  note?: string | null;
}

// 리스트 축 정규화 — 관리탭은 줄바꿈/쉼표로 받고(사람이 채널명을 붙여넣는다), API 는 배열로도 받는다. 둘 다 여기서 흡수.
function normList(v: string[] | string | null | undefined): string[] | null {
  if (v === undefined || v === null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(/[\n,]/);
  const out = arr.map((s) => String(s).trim().replace(/^#/, "")).filter(Boolean);   // 슬랙 '#채널' 붙여넣기 흡수
  return out.length ? out : null;
}
function normText(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
const DKEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const D_SEL = `id, key, label, enabled, priority,
  match_kinds, match_system, include_channels, exclude_channels, include_authors, exclude_authors,
  exclude_bots, min_chars, lookback_days,
  criteria_md, format_md, target_category, default_type, name_prefix, thread_aware,
  prefilter_level, prefilter_rules,
  batch_size, batch_max_msgs, mode, session_ref, model, effort, requester,
  last_run_at, last_status, last_summary, note, updated_at`;

// 부분 갱신의 병합 규칙(순수 — 테스트 seam). 이 결함의 전부가 이 한 줄의 판정이다:
//  · 입력에 그 키가 있고 undefined 가 아니면 → 보낸 값을 쓴다(명시적 null 은 '지우기'라 그대로 반영).
//  · 없으면 → 기존 행의 값을 유지한다. 기존 행이 없으면(신규) 기본값.
//  ⚠ truthy 검사로 바꾸지 마라 — enabled:false·priority:0 을 '미지정'으로 오해해 증류기를 못 끄게 된다.
export function pickDistillerField<T>(
  input: Record<string, unknown>, before: Record<string, unknown> | undefined, key: string, computed: T,
): T {
  const given = Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  return given || !before ? computed : (before[key] as T);
}

export async function upsertDistiller(input: DistillerUpsertInput, actor?: string, source?: string): Promise<Record<string, unknown>> {
  // 대상 행 — id 우선, 없으면 key(멱등 upsert: 같은 key 로 다시 저장하면 갱신).
  let targetId = input.id ?? null;
  const key = normText(input.key);
  if (!targetId && key) {
    const r = await itemsPool.query(`SELECT id FROM org_distiller WHERE key=$1`, [key]);
    targetId = r.rows[0]?.id ?? null;
  }
  if (!targetId && !key) throw new Error("key 가 필요합니다(증류기 식별자).");
  if (key && !DKEY_RE.test(key)) throw new Error("key 는 소문자 슬러그(a-z0-9._-, 64자 이내)");

  // ⚠ **부분 갱신** — 기존 행이 있으면 입력에 없는 필드는 현 값을 유지한다.
  //  종전엔 미지정 필드를 기본값으로 덮어써서, `{key, batch_size}` 한 줄이 그 증류기의 기준·형식·채널·
  //  사전필터를 **통째로 날렸다**(실측 2026-07-31: batch_size 만 바꾸려다 튜닝한 키워드 62개와 criteria 3,458자가
  //  사라지고 enabled 까지 false 로 꺼졌다 — 잔량이 24→306 으로 튀었다). 툴 설명은 "같은 key 로 다시 저장하면
  //  갱신"이라 부분 갱신을 약속하는데 동작은 전체 치환이었다. 모든 필드가 optional 인 스키마도 같은 약속이다.
  //  ⚠ 없음(undefined)과 비움(null)은 다르다 — 명시적 null 은 그 필드를 지우는 뜻이므로 그대로 반영한다.
  const before0 = targetId
    ? (await itemsPool.query(`SELECT ${D_SEL} FROM org_distiller WHERE id=$1`, [targetId])).rows[0] as Record<string, unknown> | undefined
    : undefined;
  if (targetId && !before0) throw new Error(`org_distiller #${targetId} 없음`);
  const pick = <T>(k: keyof DistillerUpsertInput, next: T): T =>
    pickDistillerField(input as Record<string, unknown>, before0, k as string, next);

  const mode = pick("mode", input.mode ?? "headless") as string;
  if (!["headless", "session"].includes(mode)) throw new Error("mode 는 headless|session");
  const sessionRef = pick("session_ref", normText(input.session_ref));
  if (mode === "session" && !sessionRef) throw new Error("mode=session 이면 타깃 상시 세션(session_ref)이 필요합니다.");
  // batch_size = 스레드 상한(자료 건수가 아니다) · batch_max_msgs = 메시지 상한. 첫 스레드는 메시지 상한 예외.
  const batch = Number(pick("batch_size", Number.isFinite(input.batch_size) ? Math.trunc(input.batch_size as number) : 3));
  if (!Number.isFinite(batch) || batch < 1 || batch > 200) throw new Error("batch_size(스레드 수) 는 1~200");
  const batchMsgs = Number(pick("batch_max_msgs", Number.isFinite(input.batch_max_msgs) ? Math.trunc(input.batch_max_msgs as number) : 20));
  if (!Number.isFinite(batchMsgs) || batchMsgs < 1 || batchMsgs > 2000) throw new Error("batch_max_msgs 는 1~2000");
  const lookback = pick("lookback_days",
    input.lookback_days === undefined || input.lookback_days === null || !Number.isFinite(input.lookback_days)
      ? null : Math.max(0, Math.trunc(input.lookback_days as number)) || null);

  const vals = {
    key: key || (before0?.key as string | undefined) || null,
    label: pick("label", normText(input.label)),
    enabled: pick("enabled", input.enabled ?? false),
    priority: pick("priority", Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0),
    match_kinds: pick("match_kinds", normList(input.match_kinds)),
    match_system: pick("match_system", normText(input.match_system)),
    include_channels: pick("include_channels", normList(input.include_channels)),
    exclude_channels: pick("exclude_channels", normList(input.exclude_channels)),
    include_authors: pick("include_authors", normList(input.include_authors)),
    exclude_authors: pick("exclude_authors", normList(input.exclude_authors)),
    exclude_bots: pick("exclude_bots", input.exclude_bots ?? true),
    min_chars: pick("min_chars", Number.isFinite(input.min_chars) ? Math.max(0, Math.trunc(input.min_chars as number)) : 0),
    lookback_days: lookback,
    criteria_md: pick("criteria_md", normText(input.criteria_md)),
    format_md: pick("format_md", normText(input.format_md)),
    target_category: pick("target_category", normText(input.target_category)),
    default_type: pick("default_type", normText(input.default_type)),
    name_prefix: pick("name_prefix", normText(input.name_prefix)),
    thread_aware: pick("thread_aware", input.thread_aware ?? true),
    // 사전 필터 — 레버(0~100)와 축별 덮어쓰기. 레버 0 = 필터 끔(구 동작 그대로).
    prefilter_level: pick("prefilter_level", Number.isFinite(input.prefilter_level) ? Math.max(0, Math.min(100, Math.trunc(input.prefilter_level as number))) : 0),
    prefilter_rules: pick("prefilter_rules", (input.prefilter_rules && typeof input.prefilter_rules === "object") ? input.prefilter_rules : null),
    batch_size: batch,
    batch_max_msgs: batchMsgs,
    mode,
    session_ref: sessionRef,
    model: pick("model", normText(input.model)),
    effort: pick("effort", normText(input.effort)),
    requester: pick("requester", normText(input.requester)),
    note: pick("note", normText(input.note)),
  };

  if (targetId) {
    const before = before0!;   // 위에서 조회·존재확인 완료(부분 갱신의 기준값)
    const r = await itemsPool.query(
      `UPDATE org_distiller SET key=COALESCE($2,key), label=$3, enabled=$4, priority=$5,
         match_kinds=$6, match_system=$7, include_channels=$8, exclude_channels=$9,
         include_authors=$10, exclude_authors=$11, exclude_bots=$12, min_chars=$13, lookback_days=$14,
         criteria_md=$15, format_md=$16, target_category=$17, default_type=$18, name_prefix=$19, thread_aware=$20,
         batch_size=$21, mode=$22, session_ref=$23, model=$24, effort=$25, requester=$26, note=$27,
         prefilter_level=$29, prefilter_rules=$30::jsonb, batch_max_msgs=$31,
         version=version+1, updated_at=now(), updated_by=$28
       WHERE id=$1 RETURNING ${D_SEL}`,
      [targetId, vals.key, vals.label, vals.enabled, vals.priority,
       vals.match_kinds, vals.match_system, vals.include_channels, vals.exclude_channels,
       vals.include_authors, vals.exclude_authors, vals.exclude_bots, vals.min_chars, vals.lookback_days,
       vals.criteria_md, vals.format_md, vals.target_category, vals.default_type, vals.name_prefix, vals.thread_aware,
       vals.batch_size, vals.mode, vals.session_ref, vals.model, vals.effort, vals.requester, vals.note, actor ?? null,
       vals.prefilter_level, vals.prefilter_rules ? JSON.stringify(vals.prefilter_rules) : null, vals.batch_max_msgs]);
    await audit("org_distiller", String(targetId), "update", before, r.rows[0], actor, source);
    return r.rows[0];
  }

  const r = await itemsPool.query(
    `INSERT INTO org_distiller(key, label, enabled, priority,
       match_kinds, match_system, include_channels, exclude_channels, include_authors, exclude_authors,
       exclude_bots, min_chars, lookback_days,
       criteria_md, format_md, target_category, default_type, name_prefix, thread_aware,
       batch_size, mode, session_ref, model, effort, requester, note, created_by, updated_by,
       prefilter_level, prefilter_rules, batch_max_msgs)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$27,$28,$29::jsonb,$30)
     RETURNING ${D_SEL}`,
    [vals.key, vals.label, vals.enabled, vals.priority,
     vals.match_kinds, vals.match_system, vals.include_channels, vals.exclude_channels,
     vals.include_authors, vals.exclude_authors, vals.exclude_bots, vals.min_chars, vals.lookback_days,
     vals.criteria_md, vals.format_md, vals.target_category, vals.default_type, vals.name_prefix, vals.thread_aware,
     vals.batch_size, vals.mode, vals.session_ref, vals.model, vals.effort, vals.requester, vals.note, actor ?? null,
     vals.prefilter_level, vals.prefilter_rules ? JSON.stringify(vals.prefilter_rules) : null, vals.batch_max_msgs]);
  await audit("org_distiller", String(r.rows[0].id), "insert", null, r.rows[0], actor, source);
  return r.rows[0];
}

export async function removeDistiller(idOrKey: number | string, actor?: string, source?: string): Promise<void> {
  const isId = typeof idOrKey === "number" || /^\d+$/.test(String(idOrKey));
  const cur = isId
    ? await itemsPool.query(`SELECT ${D_SEL} FROM org_distiller WHERE id=$1`, [Number(idOrKey)])
    : await itemsPool.query(`SELECT ${D_SEL} FROM org_distiller WHERE key=$1`, [String(idOrKey)]);
  const row = cur.rows[0];
  if (!row) return;
  await itemsPool.query(`DELETE FROM org_distiller WHERE id=$1`, [row.id]);
  await audit("org_distiller", String(row.id), "delete", row, null, actor, source);
}

// 실행 결과 기록 — 잡이 매 배치 끝에 호출(관리탭이 '마지막 실행'을 여기서 읽는다).
export async function recordDistillerRun(id: number, status: string, summary: unknown): Promise<void> {
  await itemsPool.query(
    `UPDATE org_distiller SET last_run_at=now(), last_status=$2, last_summary=$3 WHERE id=$1`,
    [id, String(status).slice(0, 40), JSON.stringify(summary ?? {})]);
}

// #656 인입 게이트 관측 — org_content_audit(knowledge insert/set_lifecycle/delete) + pending 카운트를 집계.
//  파일럿 1순위 지표('오너가 어디까지 자동 허용하나')의 데이터화. after/before 스냅샷의 lifecycle 로 auto/pending 판별.
//  · mirror_auto = 커넥터 미러가 즉시 active 로 적재(자동 통과). channel='connector' AND after.lifecycle='active'.
//  · pending_created = 게이트가 검토 큐로 보낸 것(정책 confirm). after.lifecycle='pending' AND 자동경로(connector 또는 ai).
//  · approved/rejected = pending 을 승인(set_lifecycle→active)/반려(delete). before.lifecycle='pending'.
//  · pending_now = 현재 검토 대기(knowledge.lifecycle='pending').
//  #783 추가 축(에이전트 저작 — 게이트의 실제 대상):
//   · agent_auto = 에이전트(MCP)가 쓴 신규 지식이 게이트 없이 즉시 active(=지금 무검증으로 라이브에 박히는 양. 게이트를 켜야 할 이유의 크기).
//   · rev_pending = 검토 대기 '수정' 건수 · rev_approved/rev_rejected = 기간 내 처리량.
export interface IngestObservability {
  days: number; mirror_auto: number; pending_created: number; approved: number; rejected: number; pending_now: number;
  agent_auto: number; rev_pending: number; rev_approved: number; rev_rejected: number;
}
export async function ingestObservability(days = 30): Promise<IngestObservability> {
  const d = Math.max(1, Math.min(365, Math.trunc(Number(days) || 30)));
  const iv = `${d} days`;
  const one = async (sql: string, params: unknown[] = [iv]): Promise<number> =>
    Number((await itemsPool.query(sql, params)).rows[0]?.n ?? 0);
  const zero = async (sql: string, params: unknown[] = [iv]): Promise<number> => {
    try { return await one(sql, params); } catch { return 0; }   // knowledge_revision 미생성(구 DB) → 0
  };
  const [mirror_auto, pending_created, approved, rejected, pending_now, agent_auto, rev_pending, rev_approved, rev_rejected] = await Promise.all([
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='insert' AND at >= now() - $1::interval
           AND (after->>'lifecycle')='active' AND channel='connector'`),
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='insert' AND at >= now() - $1::interval
           AND (after->>'lifecycle')='pending' AND (channel='connector' OR actor_kind='ai')`),
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='set_lifecycle' AND at >= now() - $1::interval
           AND (before->>'lifecycle')='pending' AND (after->>'lifecycle')='active'`),
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='delete' AND at >= now() - $1::interval
           AND (before->>'lifecycle')='pending'`),
    one(`SELECT count(*)::int AS n FROM knowledge WHERE lifecycle='pending'`, []),
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='insert' AND at >= now() - $1::interval
           AND (after->>'lifecycle')='active' AND actor_kind='ai' AND channel='mcp'`),
    zero(`SELECT count(*)::int AS n FROM knowledge_revision WHERE status='pending'`, []),
    zero(`SELECT count(*)::int AS n FROM knowledge_revision WHERE status='approved' AND reviewed_at >= now() - $1::interval`),
    zero(`SELECT count(*)::int AS n FROM knowledge_revision WHERE status='rejected' AND reviewed_at >= now() - $1::interval`),
  ]);
  return { days: d, mirror_auto, pending_created, approved, rejected, pending_now, agent_auto, rev_pending, rev_approved, rev_rejected };
}
