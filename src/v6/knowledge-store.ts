// v6 knowledge 데이터 접근 — 구 knowledge_unit 대체(kind 폐기 → injection/provenance 직교축).
//  injection=always(규칙·페르소나, 항상 주입) | recalled(검색 소환). provenance=authored | observed(외부 미러).
//  knowledge_category(n:n)로 카테고리 매핑. 감사 org_content_audit(entity='knowledge'). 갱신 시 version+1.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { auditOrgContent, restoreSnapshot, type WriteCtx } from "../db/write.js";
// 임베딩 seam(벡터검색 #172) — config 는 org_runtime_config 에서 직접 읽는다(org/store import 회피 → 무순환).
import {
  type EmbeddingProvider, resolveEmbeddingConfig, resolveEmbeddingProvider,
  embeddingInputText, toVectorLiteral,
} from "./embedding-provider.js";

const K_COLS =
  `name, title, body_md, injection, provenance, lifecycle, supersedes, confidence, source,
   external_system, external_instance, external_id, external_url, occurred_at, last_synced_at,
   as_of, parent_name, summary, author, source_ref, sort, is_wiki, version, updated_at, updated_by`;
const K_SEL = K_COLS.split(",").map((c) => "k." + c.trim()).join(", ");

export interface KnowledgeRow {
  name: string; title: string | null; body_md: string;
  injection: string; provenance: string; lifecycle: string;
  confidence: string; source: string; summary: string | null;
  sort: number; is_wiki: boolean; version: number; updated_at: string;
  [k: string]: unknown;
}

function slugify(s: string): string {
  return ((s || "untitled").toLowerCase().trim()
    .replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)) || "untitled";
}

// ── grep 매처 — Claude Code(ripgrep) 직관에 맞춘 본문/제목 텍스트 매칭. "search"(의미검색)가 아니라 grep이다.
//  · 정규식 메타문자가 있고 유효한 패턴이면 → POSIX 정규식(`~*`, 대소문자 무시)으로 grep. 예: `벡터|vector`, `task_\w+`.
//  · 그 외(평문)면 → 공백으로 나눈 모든 토큰이 (제목이든 본문이든) 등장해야 매치(AND, 부분일치). 단일 토큰이면 단순 contains.
//    → 다중 키워드("벡터 검색")가 통짜 구절이 아니라 토큰 AND 로 동작해 직관적. 구 단일-ILIKE 의 과소회수를 해소.
//  · LIKE 와일드카드(`%`/`_`)는 평문 토큰에서 리터럴로 이스케이프(grep 패리티 — 구버전은 `knowledge_x` 의 `_` 가 와일드카드로 샜다).
const REGEX_META = /[.*+?^${}()|[\]\\]/;
function likeEscape(s: string): string { return s.replace(/[\\%_]/g, "\\$&"); }
export type GrepPlan = { mode: "regex"; pattern: string; re: RegExp } | { mode: "tokens"; tokens: string[] };
export function parseGrep(qstr: string): GrepPlan {
  const t = (qstr ?? "").trim();
  if (REGEX_META.test(t)) {
    try { return { mode: "regex", pattern: t, re: new RegExp(t, "i") }; } catch { /* 깨진 정규식 → 토큰으로 폴백 */ }
  }
  const tokens = t.split(/\s+/).filter(Boolean);
  return { mode: "tokens", tokens: tokens.length ? tokens : [t] };
}
// cols 중 어느 하나에 매치(OR). regex 는 패턴 1개, tokens 는 토큰마다 (cols OR) 를 AND 로 묶는다. params 에 push 하고 WHERE 절 문자열 반환.
function grepWhere(cols: string[], plan: GrepPlan, params: unknown[]): string {
  const colsOr = (placeholder: string) => "(" + cols.map((c) => `${c} ${placeholder}`).join(" OR ") + ")";
  if (plan.mode === "regex") {
    params.push(plan.pattern);
    return colsOr(`~* $${params.length}`);
  }
  return plan.tokens.map((tok) => { params.push(`%${likeEscape(tok)}%`); return colsOr(`ILIKE $${params.length} ESCAPE '\\'`); }).join(" AND ");
}
// ── grep 스니펫 — 매치 줄만 "L<n>: …" 로(ripgrep 식, 여러 매치 표시). ⚠ 검색 결과는 절대 body_md 전문을 싣지 않는다
//  (과거 {...r} 스프레드가 전문을 누출 → 토큰 폭주로 응답 잘림). 본문은 snippet 으로만 보이고, 전문은 knowledge_get.
const SNIP_MAX_LINES = 4;     // 결과당 표시할 매치 줄 상한(초과분은 "(+N matches)")
const SNIP_LINE_CHARS = 160;  // 줄당 트림 길이(매치 주변)
// grep 결과 SELECT — 전문(body_md)은 스니펫 계산용으로만 가져오고 응답에선 뺀다. 무관 메타(external_* 등)는 아예 미조회.
const K_GREP_SEL = ["name", "title", "body_md", "injection", "provenance", "is_wiki", "summary", "updated_at"]
  .map((c) => "k." + c).join(", ");
// names 모드 — body_md 도 미조회(스니펫 불필요). 발견용 메타만(가장 얕게).
const K_GREP_NAMES_SEL = ["name", "title", "injection", "provenance", "is_wiki", "summary", "updated_at"]
  .map((c) => "k." + c).join(", ");

// 한 줄의 매치 시작 위치(없으면 -1). regex 는 줄 단위 exec, tokens 는 토큰 중 하나라도(OR) 등장하는 최좌단(트림 기준).
function grepLineAt(line: string, plan: GrepPlan): number {
  if (plan.mode === "regex") { const m = plan.re.exec(line); return m ? m.index : -1; }
  let at = -1;
  const lower = line.toLowerCase();
  for (const tok of plan.tokens) { const i = lower.indexOf(tok.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  return at;
}
// 한 줄을 매치 주변 SNIP_LINE_CHARS 자로 트림(탭→공백, 양끝 …).
function grepTrimLine(line: string, at: number): string {
  const s = line.replace(/\t/g, " ").trim();
  if (s.length <= SNIP_LINE_CHARS) return s;
  const start = Math.max(0, at - 48);
  const end = Math.min(s.length, start + SNIP_LINE_CHARS);
  return (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
}
// 본문에서 매치 줄들을 ripgrep 처럼 "L<n>: …". context>0 면 매치 줄 ±context 줄도 포함(-C 패리티,
//  비연속 그룹은 ⋯ 로 구분). 본문 매치가 0줄이면(제목만 매치 등) 앞부분 미리보기로 폴백.
function grepSnippet(body: string, plan: GrepPlan, context = 0): string {
  if (!body) return "";
  const lines = body.split("\n");
  const hits: Array<{ i: number; at: number }> = [];
  for (let i = 0; i < lines.length; i++) { const at = grepLineAt(lines[i], plan); if (at >= 0) hits.push({ i, at }); }
  if (hits.length === 0) return body.slice(0, SNIP_LINE_CHARS).replace(/\s+/g, " ").trim();
  const ctx = Math.max(0, Math.min(context, 3));
  const atOf = new Map(hits.map(({ i, at }) => [i, at] as const));
  const shown = hits.slice(0, SNIP_MAX_LINES);
  const out: string[] = [];
  const emitted = new Set<number>();
  let prev = -1;
  for (const { i } of shown) {
    const lo = Math.max(0, i - ctx), hi = Math.min(lines.length - 1, i + ctx);
    if (prev >= 0 && lo > prev + 1) out.push("  ⋯");
    for (let j = lo; j <= hi; j++) {
      if (emitted.has(j)) continue;
      emitted.add(j);
      out.push(`L${j + 1}: ${grepTrimLine(lines[j], atOf.get(j) ?? 0)}`);
    }
    prev = hi;
  }
  if (hits.length > shown.length) out.push(`(+${hits.length - shown.length} matches) → knowledge_get`);
  return out.join("\n");
}

const auditKnowledge = (name: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("knowledge", name, op, before, after, ctx);

// ── 임베딩(벡터검색 #172) — config 가 켜졌을 때만. org_runtime_config.embedding_config 를 직접 읽어 provider 해소(무순환). ──
//  off(기본)면 null → 쓰기·검색 모두 no-op/렉시컬 폴백. 설계 [[vector-search-172-design-pluggable-seam-oss]].
async function activeEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  try {
    const r = await one(itemsPool, `SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    return resolveEmbeddingProvider(resolveEmbeddingConfig((r as { embedding_config?: unknown } | undefined)?.embedding_config));
  } catch {
    return null; // 설정 못 읽으면 안전하게 off
  }
}

// 쓰기 경로 best-effort 임베딩 — provider on 일 때만. 실패는 삼킨다(지식은 이미 저장됨 → 백필로 보강). off=no-op.
//  ⚠ 감사·커밋 이후 별도 UPDATE(임베딩 실패가 knowledge_save 를 깨지 않게). 차원 불일치 등은 endpoint 가 거부 → 경고만.
async function embedKnowledgeBestEffort(name: string, fields: { title?: string | null; summary?: string | null; body_md?: string | null }): Promise<void> {
  const provider = await activeEmbeddingProvider();
  if (!provider) return;
  try {
    const text = embeddingInputText(fields);
    if (!text) return;
    const [vec] = await provider.embed([text]);
    if (!vec || !vec.length) return;
    await itemsPool.query(
      `UPDATE knowledge SET embedding_vector=$2::vector, embedding_model=$3, embedding_updated_at=now() WHERE name=$1`,
      [name, toVectorLiteral(vec), provider.model]);
  } catch (e) {
    console.warn(`[embeddings] '${name}' 임베딩 실패(best-effort, 백필로 보강): ${(e as Error)?.message}`);
  }
}

export interface KnowledgeFilter {
  space?: string; categoryId?: number; injection?: string; provenance?: string;
  lifecycle?: string; q?: string; limit?: number; orderBy?: string; is_wiki?: boolean;
}

export async function listKnowledge(f: KnowledgeFilter = {}): Promise<KnowledgeRow[]> {
  const params: unknown[] = [];
  let join = "";
  // 카테고리/스페이스 필터 = knowledge_category 조인(rejected 매핑 제외).
  if (f.categoryId != null) {
    params.push(f.categoryId);
    join = `JOIN knowledge_category kc ON kc.name=k.name AND kc.category_id=$${params.length} AND kc.state<>'rejected'`;
  } else if (f.space) {
    params.push(f.space);
    join = `JOIN knowledge_category kc ON kc.name=k.name AND kc.state<>'rejected'
            JOIN category c ON c.id=kc.category_id AND c.space=$${params.length}`;
  }
  const wh: string[] = [];
  if (f.injection) { params.push(f.injection); wh.push(`k.injection=$${params.length}`); }
  if (f.provenance) { params.push(f.provenance); wh.push(`k.provenance=$${params.length}`); }
  if (f.is_wiki != null) { params.push(f.is_wiki); wh.push(`k.is_wiki=$${params.length}`); }
  if (f.lifecycle) { params.push(f.lifecycle); wh.push(`k.lifecycle=$${params.length}`); }
  else wh.push(`k.lifecycle='active'`);
  if (f.q) wh.push(grepWhere(["k.title", "k.body_md"], parseGrep(f.q), params));  // grep 매처(regex|토큰 AND) — knowledge_grep 과 동일 의미
  const where = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
  const order = f.orderBy === "name" ? "k.name" : "k.updated_at DESC";
  params.push(Math.min(f.limit ?? 200, 500));
  return q(itemsPool,
    `SELECT DISTINCT ${K_SEL} FROM knowledge k ${join} ${where} ORDER BY ${order} LIMIT $${params.length}`, params);
}

export async function getKnowledge(name: string): Promise<(KnowledgeRow & { categories: unknown[] }) | undefined> {
  const k = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!k) return undefined;
  const categories = await q(itemsPool,
    `SELECT kc.category_id, kc.state, c.space, c.key, c.name
     FROM knowledge_category kc JOIN category c ON c.id=kc.category_id WHERE kc.name=$1`, [name]);
  return { ...k, categories };
}

export async function upsertKnowledge(
  input: { name?: string; title?: string; body_md: string; injection?: string; provenance?: string; confidence?: string; source?: string; supersedes?: string; summary?: string | null; sort?: number; is_wiki?: boolean; category?: string[] },
  ctx?: WriteCtx,
): Promise<KnowledgeRow> {
  let name: string;
  if (input.name) {
    name = slugify(input.name);
  } else {
    const base = slugify(input.title || input.body_md.slice(0, 40));
    name = base;
    for (let i = 2; await one(itemsPool, `SELECT 1 FROM knowledge WHERE name=$1`, [name]); i++) {
      if (i > 999) throw new Error("이름 자동생성 실패");
      name = `${base}-${i}`;
    }
  }
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  // 미분류 금지(2026-06-24): category(분류) key→id 해소. 신규는 1개 이상 필수, 미존재 key 는 INSERT 전 차단(미분류·오타 생성 방지).
  const catIds: number[] = [];
  for (const key of (input.category ?? [])) {
    const cat = await one(itemsPool, `SELECT id FROM category WHERE key=$1 AND state<>'merged' LIMIT 1`, [key]);
    if (!cat) throw new Error(`category '${key}' 없음 — category_list 로 확인하세요`);
    catIds.push((cat as { id: number }).id);
  }
  if (!before && !catIds.length) {
    throw new Error("신규 지식은 category(분류) 1개 이상 필수 — category_list 의 key 를 지정하세요(미분류 저장 금지).");
  }
  // confidence 는 source 로 서버강제(mcp→ai, web→human) 또는 명시값. injection/provenance 는 명시 우선·기존 보존.
  const confidence = input.confidence ?? (ctx?.source === "mcp" ? "ai" : "human");
  const injection = input.injection ?? (before?.injection as string) ?? "recalled";
  const provenance = input.provenance ?? (before?.provenance as string) ?? "authored";
  // summary/sort/is_wiki: 명시(undefined 아님) 우선, 없으면 기존 보존(편집 저장이 핀·요약·정렬 유실 안 하게). 신규면 기본값.
  const summary = input.summary !== undefined ? input.summary : ((before?.summary as string | null) ?? null);
  const sort = input.sort !== undefined ? input.sort : (Number(before?.sort) || 0);
  const isWiki = input.is_wiki !== undefined ? input.is_wiki : ((before?.is_wiki as boolean) ?? false);
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, supersedes, confidence, source, summary, sort, is_wiki, version, updated_at, updated_by)
     VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,1,now(),$12)
     ON CONFLICT (name) DO UPDATE SET
       title=COALESCE(EXCLUDED.title, knowledge.title), body_md=EXCLUDED.body_md,
       injection=EXCLUDED.injection, provenance=EXCLUDED.provenance, supersedes=EXCLUDED.supersedes,
       confidence=EXCLUDED.confidence, source=EXCLUDED.source,
       summary=EXCLUDED.summary, sort=EXCLUDED.sort, is_wiki=EXCLUDED.is_wiki,
       version=knowledge.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [name, input.title ?? null, input.body_md, injection, provenance, input.supersedes ?? null, confidence, input.source ?? "authored", summary, sort, isWiki, ctx?.actor ?? null]);
  const after = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  await auditKnowledge(name, before ? "update" : "insert", before, after, ctx);
  for (const id of catIds) await linkKnowledgeCategory(name, id, "confirmed", ctx);
  // 벡터검색(#172) — 임베딩 on 이면 본문 임베딩 갱신(best-effort, off=no-op, 실패해도 저장 성공 보존).
  await embedKnowledgeBestEffort(name, { title: input.title ?? (after?.title as string | null), summary, body_md: input.body_md });
  return after;
}

export async function setKnowledgeLifecycle(name: string, lifecycle: string, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!before) throw new Error(`지식 '${name}' 없음`);
  const after = await one(itemsPool,
    `UPDATE knowledge SET lifecycle=$2, updated_at=now() WHERE name=$1 RETURNING ${K_COLS}`, [name, lifecycle]);
  await auditKnowledge(name, "set_lifecycle", before, after, ctx);
  return after;
}

// WIKI 핀 토글 — is_wiki 만 갱신(본문·메타 불변, version 안 올림). 핀된 지식의 제목+메타가 가이드 ${wiki} 로 항상-주입된다.
export async function setKnowledgeWiki(name: string, isWiki: boolean, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!before) throw new Error(`지식 '${name}' 없음`);
  const after = await one(itemsPool,
    `UPDATE knowledge SET is_wiki=$2, updated_at=now() WHERE name=$1 RETURNING ${K_COLS}`, [name, isWiki]);
  await auditKnowledge(name, "set_wiki", before, after, ctx);
  return after;
}

// 삭제 — 활성 테이블에서 제거하되 감사(org_content_audit op='delete')에 before 전문 스냅샷을 남긴다.
//  = "감사로그를 휴지통 삼는 소프트삭제" — restoreKnowledge 로 복원 가능. knowledge_category/project_knowledge/
//  activity_knowledge 는 FK ON DELETE CASCADE 라 링크가 동반 삭제된다(복원 시 링크는 돌아오지 않음 — project 와 동형).
//  사람전용 게이트(에이전트 403)는 capability 계층(knowledge_delete)에서 선행한다(여기는 순수 데이터).
export async function deleteKnowledge(name: string, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!before) throw new Error(`지식 '${name}' 없음`);
  await itemsPool.query(`DELETE FROM knowledge WHERE name=$1`, [name]);
  await auditKnowledge(name, "delete", before, null, ctx);
  return before;
}

// 복원 — 마지막 delete 의 before 스냅샷(전문)을 그대로 재적재한다. 본문/메타는 삭제 시점 그대로,
//  복원 사실(누가/언제)은 감사 op='restore' 로 기록된다. 이미 존재하면(삭제 상태 아님) 거부.
export async function restoreKnowledge(before: Record<string, unknown>, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const after = await restoreSnapshot<KnowledgeRow>("knowledge", K_COLS, "name", before);
  await auditKnowledge(after.name, "restore", null, after, ctx);
  return after;
}

// grep — title/body_md 매칭(정규식 또는 토큰 AND) → 매치 줄 스니펫(전문 X, body_md 미포함). 전문은 getKnowledge.
//  의미검색 아님(벡터는 추후 별도 도구). Postgres 가 정규식을 거부하면(JS 유효·POSIX 무효 드묾) 토큰 모드로 1회 폴백 — 에이전트에 에러 누출 안 함.
//  결과 행 = grep 발견에 필요한 얕은 필드만 + snippet(전문 누출·토큰폭주 방지).
export interface KnowledgeSearchRow {
  name: string; title: string | null;
  injection: string; provenance: string; is_wiki: boolean;
  summary: string | null; updated_at: string; snippet?: string;  // names 모드는 snippet 생략
  score?: number;  // 하이브리드 검색(knowledge_search)의 RRF 점수 — grep(searchKnowledge)은 미설정
}
export type KnowledgeGrepMode = "snippets" | "names" | "count";
// regex→token 폴백 공통화: plan 으로 쿼리하되 POSIX 가 정규식을 거부하면 토큰모드로 1회 재시도.
async function grepExec<T>(qstr: string, runWithPlan: (plan: GrepPlan) => Promise<T>): Promise<{ result: T; plan: GrepPlan }> {
  let plan = parseGrep(qstr);
  try { return { result: await runWithPlan(plan), plan }; }
  catch (e) {
    if (plan.mode !== "regex") throw e;          // 토큰 모드 실패는 진짜 에러
    plan = { mode: "tokens", tokens: qstr.trim().split(/\s+/).filter(Boolean) || [qstr] };
    return { result: await runWithPlan(plan), plan };  // POSIX 가 거부한 정규식 → 토큰 부분일치 폴백
  }
}
// 공통 WHERE(grep 매처 + lifecycle='active' + injection/provenance). params 에 push 하고 절 문자열 반환.
function grepWhereSql(plan: GrepPlan, opts: { injection?: string; provenance?: string }, params: unknown[]): string {
  const wh: string[] = [grepWhere(["k.title", "k.body_md"], plan, params), `k.lifecycle='active'`];
  if (opts.injection) { params.push(opts.injection); wh.push(`k.injection=$${params.length}`); }
  if (opts.provenance) { params.push(opts.provenance); wh.push(`k.provenance=$${params.length}`); }
  return wh.join(" AND ");
}

// mode='count' — 본문/스니펫 없이 매치 총건수만(페이징·존재확인용).
export async function countKnowledgeGrep(qstr: string, opts: { injection?: string; provenance?: string } = {}): Promise<number> {
  const { result } = await grepExec(qstr, async (plan) => {
    const params: unknown[] = [];
    const where = grepWhereSql(plan, opts, params);
    const rows = await q(itemsPool, `SELECT count(*)::int AS n FROM knowledge k WHERE ${where}`, params);
    return Number(rows[0]?.n ?? 0);
  });
  return result;
}

export async function searchKnowledge(
  qstr: string,
  opts: { injection?: string; provenance?: string; limit?: number; mode?: KnowledgeGrepMode; context?: number } = {},
): Promise<KnowledgeSearchRow[]> {
  const withBody = opts.mode !== "names";   // names 모드는 body_md/스니펫 불필요 — 더 얕게 조회
  const sel = withBody ? K_GREP_SEL : K_GREP_NAMES_SEL;
  const { result: rows, plan } = await grepExec(qstr, async (p) => {
    const params: unknown[] = [];
    const where = grepWhereSql(p, opts, params);
    params.push(Math.min(opts.limit ?? 20, 100));
    return q(itemsPool,
      `SELECT ${sel} FROM knowledge k WHERE ${where} ORDER BY k.updated_at DESC LIMIT $${params.length}`, params);
  });
  return rows.map((r) => {
    const base: KnowledgeSearchRow = { name: r.name, title: r.title, injection: r.injection,
      provenance: r.provenance, is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at };
    if (withBody) base.snippet = grepSnippet(r.body_md ?? "", plan, opts.context);
    return base;
  });
}

// ── 하이브리드 검색(knowledge_search, 벡터검색 #172) — 벡터(cosine) ∪ 렉시컬(grep) RRF 융합. ──
//  · 임베딩 off / 쿼리 임베딩 실패 / SQL 실패 → 전부 searchKnowledge(렉시컬)로 폴백(하위호환·safe-by-construction).
//  · grep 과 다른 점: 단어가 본문에 그대로 없어도 의미 유사로 회수(벡터 채널). 정확 토큰/정규식은 knowledge_grep.
//  · 결과는 grep 과 동일 표면(스니펫·전문 미포함). 벡터-only 매치는 grepSnippet 이 본문 앞부분 미리보기로 폴백.
const RRF_K = 60;        // RRF 상수(Azure 기본). Σ 1/(k+rank) — 두 채널 모두 상위면 가산.
const HYBRID_CANDIDATES = 50; // 각 채널(렉시컬·벡터) 후보 수 → 융합 후 limit 로 컷.

export async function hybridSearchKnowledge(
  qstr: string,
  opts: { injection?: string; provenance?: string; limit?: number; mode?: KnowledgeGrepMode; context?: number } = {},
): Promise<KnowledgeSearchRow[]> {
  const provider = await activeEmbeddingProvider();
  if (!provider) return searchKnowledge(qstr, opts);          // off → grep 그대로(하위호환)
  let qvec: number[] | null = null;
  try { const [v] = await provider.embed([qstr]); qvec = v && v.length ? v : null; } catch { qvec = null; }
  if (!qvec) return searchKnowledge(qstr, opts);               // 쿼리 임베딩 실패 → 폴백
  try {
    return await rrfSearch(qstr, qvec, opts);
  } catch (e) {
    console.warn(`[embeddings] 하이브리드 검색 실패 — 렉시컬 폴백: ${(e as Error)?.message}`);
    return searchKnowledge(qstr, opts);                        // pgvector 컬럼 부재 등 → 폴백
  }
}

// RRF 융합 = SQL 한 방(쿼리 임베딩은 JS 에서 계산해 $n::vector 로 주입). lex/vec CTE 각 후보 → row_number rank → RRF 점수.
async function rrfSearch(
  qstr: string, qvec: number[],
  opts: { injection?: string; provenance?: string; limit?: number; mode?: KnowledgeGrepMode; context?: number },
): Promise<KnowledgeSearchRow[]> {
  const withBody = opts.mode !== "names";
  const sel = withBody ? K_GREP_SEL : K_GREP_NAMES_SEL;
  const limit = Math.min(opts.limit ?? 20, 100);
  const plan = parseGrep(qstr);
  const params: unknown[] = [];
  // 렉시컬 채널 WHERE — grep 매처 + lifecycle='active' + injection/provenance(searchKnowledge 와 동일 의미).
  const lexWhere = grepWhereSql(plan, opts, params);
  // 벡터 채널 WHERE — 같은 필터(+ 임베딩 보유 행만). params 공유.
  const vecWh: string[] = [`k.lifecycle='active'`, `k.embedding_vector IS NOT NULL`];
  if (opts.injection) { params.push(opts.injection); vecWh.push(`k.injection=$${params.length}`); }
  if (opts.provenance) { params.push(opts.provenance); vecWh.push(`k.provenance=$${params.length}`); }
  const vecWhere = vecWh.join(" AND ");
  params.push(toVectorLiteral(qvec)); const qp = `$${params.length}::vector`;   // 쿼리 벡터(lex/vec 양쪽 참조 가능)
  params.push(HYBRID_CANDIDATES); const candP = `$${params.length}`;
  params.push(RRF_K); const kP = `$${params.length}`;
  params.push(limit); const limP = `$${params.length}`;
  const sql = `
    WITH lex AS (
      SELECT k.name, row_number() OVER (ORDER BY k.updated_at DESC) AS rank
      FROM knowledge k WHERE ${lexWhere} ORDER BY k.updated_at DESC LIMIT ${candP}
    ),
    vec AS (
      SELECT k.name, row_number() OVER (ORDER BY k.embedding_vector <=> ${qp}) AS rank
      FROM knowledge k WHERE ${vecWhere} ORDER BY k.embedding_vector <=> ${qp} LIMIT ${candP}
    ),
    fused AS (
      SELECT name, SUM(1.0/(${kP} + rank)) AS score
      FROM (SELECT name, rank FROM lex UNION ALL SELECT name, rank FROM vec) u
      GROUP BY name
    )
    SELECT ${sel}, f.score::float8 AS score
    FROM fused f JOIN knowledge k ON k.name=f.name
    ORDER BY f.score DESC LIMIT ${limP}`;
  const rows = await q(itemsPool, sql, params);
  return rows.map((r) => {
    const base: KnowledgeSearchRow = { name: r.name, title: r.title, injection: r.injection,
      provenance: r.provenance, is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at, score: Number(r.score) };
    if (withBody) base.snippet = grepSnippet(r.body_md ?? "", plan, opts.context);
    return base;
  });
}

// ── 유사 지식(벡터검색 #172) — 코사인 유사도(0~1) 기반 최근접. 저장-시 중복감지·관련패널의 프리미티브. ──
//  · raw 유사도 = 1 - (embedding_vector <=> qvec) (pgvector <=> 는 코사인 거리 → 1-거리 = 코사인 유사도).
//    RRF score(랭크 기반, hybridSearch)와 달리 **절대 임계 비교 가능**(중복 판정 등) — 이게 proactive·dedup 의 열쇠.
//  · 입력: name(기존 지식 → 저장된 임베딩 재사용, 재임베딩 불요) 또는 text(임시 텍스트 → 즉시 임베딩). name 우선.
//  · 임베딩 off / 대상 임베딩 없음 / 쿼리 임베딩 실패 / SQL 실패 → 빈 배열(graceful — 호출부는 "유사 없음"으로 처리).
const PREVIEW_CHARS = 160; // 식별용 본문 미리보기 길이(쿼리 grep 아님 — similar 는 매치 토큰이 없다)
function previewBody(body: string): string { return body.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim(); }

export interface KnowledgeSimilarRow {
  name: string; title: string | null;
  injection: string; provenance: string; is_wiki: boolean;
  summary: string | null; updated_at: string;
  similarity: number;   // 0~1 코사인 유사도(높을수록 유사)
  snippet?: string;     // 본문 앞부분 미리보기(식별용)
}
export async function findSimilarKnowledge(
  opts: { name?: string; text?: string; limit?: number; minScore?: number; injection?: string; provenance?: string } = {},
): Promise<KnowledgeSimilarRow[]> {
  // 1) 쿼리 벡터 리터럴 확보 — name(저장된 벡터 재사용, 재임베딩 불요) 또는 text(즉시 임베딩).
  let vecLiteral: string | null = null;
  let selfName: string | null = null;
  if (opts.name) {
    selfName = opts.name;
    const r = await one(itemsPool, `SELECT embedding_vector::text AS v FROM knowledge WHERE name=$1`, [opts.name]);
    vecLiteral = (r as { v?: string | null } | undefined)?.v ?? null;   // 대상에 임베딩 없으면 null → []
  } else if (opts.text && opts.text.trim()) {
    const provider = await activeEmbeddingProvider();
    if (!provider) return [];                                            // off → 유사 없음
    try {
      const [v] = await provider.embed([opts.text.slice(0, 8000)]);
      vecLiteral = v && v.length ? toVectorLiteral(v) : null;
    } catch { return []; }                                              // 쿼리 임베딩 실패 → 빈 결과(폴백 아님 — similar 는 벡터 전용)
  }
  if (!vecLiteral) return [];
  // 2) 최근접 — 코사인 거리 오름차순. 자기 자신·미임베딩·비활성 제외. minScore(코사인 유사도) 이상만.
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0;
  try {
    const params: unknown[] = [vecLiteral]; const qp = `$1::vector`;     // $1 = 쿼리 벡터(거리·유사도·정렬에 공유)
    const wh: string[] = [`k.lifecycle='active'`, `k.embedding_vector IS NOT NULL`];
    if (selfName) { params.push(selfName); wh.push(`k.name <> $${params.length}`); }
    if (opts.injection) { params.push(opts.injection); wh.push(`k.injection=$${params.length}`); }
    if (opts.provenance) { params.push(opts.provenance); wh.push(`k.provenance=$${params.length}`); }
    params.push(minScore); const minP = `$${params.length}`;
    params.push(limit); const limP = `$${params.length}`;
    const sql = `
      SELECT k.name, k.title, k.injection, k.provenance, k.is_wiki, k.summary, k.updated_at, k.body_md,
             (1 - (k.embedding_vector <=> ${qp}))::float8 AS similarity
      FROM knowledge k
      WHERE ${wh.join(" AND ")} AND (1 - (k.embedding_vector <=> ${qp})) >= ${minP}
      ORDER BY k.embedding_vector <=> ${qp}
      LIMIT ${limP}`;
    const rows = await q(itemsPool, sql, params);
    return rows.map((r) => ({
      name: r.name, title: r.title, injection: r.injection, provenance: r.provenance,
      is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at,
      similarity: Number(r.similarity), snippet: previewBody(r.body_md ?? ""),
    }));
  } catch (e) {
    console.warn(`[embeddings] 유사 지식 조회 실패: ${(e as Error)?.message}`);
    return [];                                                          // pgvector 부재 등 → 빈 결과(저장·검색 무손상)
  }
}

// ── 추천(카테고리 인지, 벡터검색 #172) — 의미 유사도 + 카테고리 공유 가산점·구제. 프로젝트 필요지식 추천의 코어. ──
//  순수 벡터보다 나은 점: 사람이 큐레이션한 카테고리는 강한 관련 신호 → ① 같은 카테고리면 가산점(boost)으로 상위로,
//  ② 임계(minScore) 미달이어도 같은 카테고리면 구제(rescue)해 포함, ③ 임베딩 off 여도 카테고리만으로 추천 가능(graceful).
//  score = 코사인유사도 + (카테고리 공유 ? boost : 0). 단일 랭킹 리스트 + shares_category 태그(왜 추천인지).
export interface KnowledgeRecommendRow extends KnowledgeSimilarRow {
  shares_category: boolean;  // 주어진 카테고리와 공유(가산점·구제 대상)
  score: number;             // 정렬 기준 = similarity + 카테고리 가산점
}
const CATEGORY_BOOST = 0.15; // 같은 카테고리 공유 시 코사인유사도에 더하는 가산점(bge-m3 스케일 기준 보수적)
export async function findRecommendedKnowledge(
  opts: { text?: string; categoryIds?: number[]; exclude?: string[]; limit?: number; minScore?: number; categoryBoost?: number } = {},
): Promise<KnowledgeRecommendRow[]> {
  const cats = (opts.categoryIds ?? []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  // 쿼리 임베딩(텍스트 있고 provider on 일 때만). 실패/off → null → 카테고리만으로 추천(graceful).
  let qvec: number[] | null = null;
  if (opts.text && opts.text.trim()) {
    const provider = await activeEmbeddingProvider();
    if (provider) {
      try { const [v] = await provider.embed([opts.text.slice(0, 8000)]); qvec = v && v.length ? v : null; } catch { qvec = null; }
    }
  }
  if (!qvec && !cats.length) return [];   // 의미·카테고리 둘 다 신호 없음 → 추천 불가
  const exclude = opts.exclude ?? [];
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0.4;
  const boost = typeof opts.categoryBoost === "number" ? opts.categoryBoost : CATEGORY_BOOST;
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
  try {
    const params: unknown[] = [];
    // similarity 식 — qvec 있을 때만 벡터 참조(off 면 NULL → 카테고리 경로만).
    let simExpr = "NULL";
    if (qvec) { params.push(toVectorLiteral(qvec)); simExpr = `(1 - (k.embedding_vector <=> $${params.length}::vector))`; }
    // 카테고리 공유 식 — cats 있을 때만(rejected 매핑 제외). 없으면 false → 순수 벡터(가산점·구제 없음).
    let sharesExpr = "false";
    if (cats.length) {
      params.push(cats);
      sharesExpr = `EXISTS(SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name AND kc.state<>'rejected' AND kc.category_id = ANY($${params.length}::int[]))`;
    }
    params.push(exclude); const exclP = `$${params.length}::text[]`;
    params.push(minScore); const minP = `$${params.length}`;
    params.push(boost); const boostP = `$${params.length}`;
    params.push(limit); const limP = `$${params.length}`;
    // 포함 조건 = (벡터 임계 통과) OR (같은 카테고리) — 카테고리는 임계 미달도 구제. score 로 정렬(가산점 반영), 동점은 최신순.
    const sql = `
      SELECT k.name, k.title, k.injection, k.provenance, k.is_wiki, k.summary, k.updated_at, k.body_md,
             ${simExpr}::float8 AS similarity,
             ${sharesExpr} AS shares_category,
             (COALESCE(${simExpr}, 0) + CASE WHEN ${sharesExpr} THEN ${boostP}::float8 ELSE 0 END)::float8 AS score
      FROM knowledge k
      WHERE k.lifecycle='active' AND NOT (k.name = ANY(${exclP}))
        AND ( ${simExpr} >= ${minP} OR ${sharesExpr} )
      ORDER BY score DESC, k.updated_at DESC
      LIMIT ${limP}`;
    const rows = await q(itemsPool, sql, params);
    return rows.map((r) => ({
      name: r.name, title: r.title, injection: r.injection, provenance: r.provenance,
      is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at,
      similarity: r.similarity == null ? 0 : Number(r.similarity),
      shares_category: !!r.shares_category, score: Number(r.score),
      snippet: previewBody(r.body_md ?? ""),
    }));
  } catch (e) {
    console.warn(`[embeddings] 추천 지식 조회 실패: ${(e as Error)?.message}`);
    return [];
  }
}

export async function linkKnowledgeCategory(name: string, categoryId: number, state = "confirmed", ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `INSERT INTO knowledge_category(name, category_id, mapped_by, state, created_at)
     VALUES($1,$2,'manual',$3,now())
     ON CONFLICT (name, category_id) DO UPDATE SET state=EXCLUDED.state`,
    [name, categoryId, state]);
  await auditKnowledge(name, "link_category", null, { category_id: categoryId, state }, ctx);
}

export async function unlinkKnowledgeCategory(name: string, categoryId: number, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(`DELETE FROM knowledge_category WHERE name=$1 AND category_id=$2`, [name, categoryId]);
  await auditKnowledge(name, "unlink_category", { category_id: categoryId }, null, ctx);
}
