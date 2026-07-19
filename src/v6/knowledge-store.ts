// v6 knowledge 데이터 접근 — 구 knowledge_unit 대체(kind 폐기 → injection/provenance 직교축).
//  injection=always(규칙·페르소나, 항상 주입) | recalled(검색 소환). provenance=authored | observed(외부 미러).
//  knowledge_category(n:n)로 카테고리 매핑. 감사 org_content_audit(entity='knowledge'). 갱신 시 version+1.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { auditOrgContent, restoreSnapshot, type WriteCtx } from "../db/write.js";
import { embeddingInputText, toVectorLiteral } from "./embedding-provider.js";
// 검색 공용 유틸(#631 분리) — grep 매처·스니펫·RRF 상수·임베딩 provider 접근자를 project 와 공유.
import {
  type GrepPlan, parseGrep, grepWhere, grepExec, grepSnippet, previewBody,
  RRF_K, HYBRID_CANDIDATES, activeEmbeddingProvider,
} from "./search-util.js";
import { extractWikiLinkTargets } from "./wikilink.js";   // #907 본문 [[…]] → 자동 엣지(문법층은 순수 함수로 분리)

// is_folder(#592) 포함 — 목록·트리가 폴더 행을 구분해야 해서 K_COLS 에 둔다(boolean 1개 = 가볍다).
//  props_ui(#592)는 fields 와 같은 취급 — 목록엔 무겁고 상세엔 필수라 getKnowledge 에서만 SELECT.
const K_COLS =
  `name, title, body_md, injection, provenance, lifecycle, supersedes, confidence, source,
   external_system, external_instance, external_id, external_url, occurred_at, last_synced_at,
   as_of, parent_name, summary, author, source_ref, sort, is_wiki, type, is_folder, version, created_at, updated_at, updated_by`;
const K_SEL = K_COLS.split(",").map((c) => "k." + c.trim()).join(", ");

export interface KnowledgeRow {
  name: string; title: string | null; body_md: string;
  injection: string; provenance: string; lifecycle: string;
  confidence: string; source: string; summary: string | null;
  sort: number; is_wiki: boolean; is_folder: boolean; version: number; updated_at: string;
  [k: string]: unknown;
}

// export: knowledge_save 게이트(#783)가 upsert 전에 '신규냐 수정이냐'를 알아야 해서 같은 규칙으로 name 을 미리 해석한다.
//  (슬러그 규칙이 두 벌이 되면 게이트가 엉뚱한 행을 보므로 단일 진실원천 유지.)
export function slugify(s: string): string {
  return ((s || "untitled").toLowerCase().trim()
    .replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)) || "untitled";
}

// grep 결과 SELECT — 전문(body_md)은 스니펫 계산용으로만 가져오고 응답에선 뺀다. 무관 메타(external_* 등)는 아예 미조회.
//  grep 매처(parseGrep/grepWhere)·스니펫 빌더(grepSnippet)는 search-util.ts 로 분리(#631, project 검색과 공유).
//  icon(#657) = props_ui->>'icon' — 페이지 아이콘(노션형). 목록·검색·트리 행이 문서 글리프 대신 표시.
const K_ICON_EXPR = `k.props_ui->>'icon' AS icon`;
const K_GREP_SEL = ["name", "title", "body_md", "injection", "provenance", "is_wiki", "summary", "updated_at"]
  .map((c) => "k." + c).join(", ") + `, ${K_ICON_EXPR}`;
// names 모드 — body_md 도 미조회(스니펫 불필요). 발견용 메타만(가장 얕게).
const K_GREP_NAMES_SEL = ["name", "title", "injection", "provenance", "is_wiki", "summary", "updated_at"]
  .map((c) => "k." + c).join(", ") + `, ${K_ICON_EXPR}`;

const auditKnowledge = (name: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("knowledge", name, op, before, after, ctx);

// activeEmbeddingProvider 는 search-util.ts 로 이동(#631, project 스토어와 공유).

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
  lifecycle?: string; q?: string; limit?: number; offset?: number; orderBy?: string; is_wiki?: boolean; type?: string;
}

// listKnowledge / countKnowledge 공유 필터 — JOIN·WHERE·params 를 한 곳에서 조립(목록과 총계가 항상 같은 조건).
function knowledgeListFilter(f: KnowledgeFilter): { join: string; where: string; params: unknown[] } {
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
  if (f.type) { params.push(f.type); wh.push(`k.type=$${params.length}`); }   // #290 page-type 필터
  if (f.is_wiki != null) { params.push(f.is_wiki); wh.push(`k.is_wiki=$${params.length}`); }
  // lifecycle: 미지정=active(격리 불변식의 뿌리 — 검색·recall·주입이 전부 이 기본값에 기댄다).
  //  #783 콤마 다중값 허용('active,pending') — WIKI 사이드바 트리가 검토 대기 지식을 배지와 함께 띄우기 위함.
  //  (MCP 는 zod enum 이라 단일값만 들어온다 — 다중값은 REST 전용 경로.)
  if (f.lifecycle) {
    const lcs = String(f.lifecycle).split(",").map((s) => s.trim()).filter(Boolean);
    params.push(lcs);
    wh.push(`k.lifecycle = ANY($${params.length}::text[])`);
  } else wh.push(`k.lifecycle='active'`);
  if (f.q) wh.push(grepWhere(["k.title", "k.body_md"], parseGrep(f.q), params));  // grep 매처(regex|토큰 AND) — knowledge_grep 과 동일 의미
  const where = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
  return { join, where, params };
}

// #709 페이징 방어 — limit(1~500, 기본 200)·offset(0~1e6). capability(clampPage)가 이미 정규화하지만
//  내부 호출처(org publish·materialize 등)·직접 호출도 안전하도록 store 에서 한 번 더 강제한다.
function knowledgePage(f: KnowledgeFilter): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 500);
  const offset = Math.min(Math.max(Number(f.offset) || 0, 0), 1_000_000);
  return { limit, offset };
}

export async function listKnowledge(f: KnowledgeFilter = {}): Promise<KnowledgeRow[]> {
  const { join, where, params } = knowledgeListFilter(f);
  const order = f.orderBy === "name" ? "k.name" : "k.updated_at DESC";
  const { limit, offset } = knowledgePage(f);
  params.push(limit); const limP = `$${params.length}`;
  params.push(offset); const offP = `$${params.length}`;
  // icon/cover(#657, props_ui) — 목록 행 아이콘·갤러리 카드 커버용 얕은 노출(전체 props_ui 는 상세 전용 유지).
  // category_key/name(#783) — 목록 행에 소속 도메인 표시(검토 큐가 도메인별로 묶고, 에이전트도 목록에서 분류를 본다).
  //  단일 카테고리 정책(#290)이라 LATERAL LIMIT 1 — 행 증식 없음(DISTINCT 와도 무해).
  return q(itemsPool,
    `SELECT DISTINCT ${K_SEL}, ${K_ICON_EXPR}, k.props_ui->>'cover' AS cover,
            cat.key AS category_key, cat.name AS category_name
     FROM knowledge k ${join}
     LEFT JOIN LATERAL (
       SELECT cc.key, cc.name FROM knowledge_category kc2 JOIN category cc ON cc.id=kc2.category_id
        WHERE kc2.name=k.name AND kc2.state<>'rejected' ORDER BY kc2.category_id LIMIT 1
     ) cat ON true
     ${where} ORDER BY ${order} LIMIT ${limP} OFFSET ${offP}`, params);
}

// #709 총계 — 같은 필터의 전체 건수(페이징 메타 total/has_more 용). 목록의 DISTINCT 와 일치하도록 count(DISTINCT k.name).
export async function countKnowledge(f: KnowledgeFilter = {}): Promise<number> {
  const { join, where, params } = knowledgeListFilter(f);
  const row = await one(itemsPool,
    `SELECT count(DISTINCT k.name)::int AS n FROM knowledge k ${join} ${where}`, params);
  return Number((row as { n?: number } | undefined)?.n ?? 0);
}

// ── #968 WIKI2 '기록' 피드 — 상태 스냅샷 파생(지식당 최신 1건). 이벤트 원장이 아니다(UI 가 그 사실을 말한다). ──
//  activity_at = GREATEST(updated_at, last_synced_at): 미러 재싱크는 updated_at 을 안 움직이므로(원본이 진실)
//   updated_at 단독 정렬이면 방금 싱크된 미러가 피드에 영영 안 뜬다 — 설계 확정 사항(#968 §5).
//  lifecycle: active·archived 만 — pending(검토 대기)은 격리 원칙대로 피드에 싣지 않는다(검증 뷰가 큐로 보여준다).
//  change_note: 가장 최근 '승인된' 리비전의 note 를, 그 처리가 현재 본문과 시간상 근접할 때만 싣는다
//   (staged 승인 = reviewed_at ≈ updated_at / applied 작성 = created_at ≈ updated_at, 10분 창).
//   근접하지 않으면 그 note 는 지금 본문의 설명이 아닐 수 있어 뺀다 — 없는 설명을 있는 척하지 않는다.
export interface KnowledgeFeedFilter { days?: number; categoryId?: number; by?: string; limit?: number }
export async function listKnowledgeFeed(f: KnowledgeFeedFilter = {}): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  let join = "";
  if (f.categoryId != null) {
    params.push(f.categoryId);
    join = `JOIN knowledge_category kcf ON kcf.name=k.name AND kcf.category_id=$${params.length} AND kcf.state<>'rejected'`;
  }
  const wh: string[] = [`k.lifecycle IN ('active','archived')`, `k.is_folder = false`];
  if (f.by === "human" || f.by === "ai") { params.push(f.by); wh.push(`k.confidence=$${params.length}`); }
  const days = Math.min(Math.max(Number(f.days) || 14, 1), 90);
  params.push(days);
  wh.push(`GREATEST(k.updated_at, COALESCE(k.last_synced_at, k.updated_at)) > now() - make_interval(days => $${params.length}::int)`);
  const limit = Math.min(Math.max(Number(f.limit) || 300, 1), 500);
  params.push(limit);
  return q(itemsPool, `
    SELECT DISTINCT k.name, k.title, k.type, k.provenance, k.confidence, k.lifecycle, k.version,
           k.updated_at, k.updated_by, k.last_synced_at, ${K_ICON_EXPR},
           GREATEST(k.updated_at, COALESCE(k.last_synced_at, k.updated_at)) AS activity_at,
           cat.key AS category_key, cat.name AS category_name,
           rev.note AS change_note, rev.reviewed_by AS change_reviewed_by
      FROM knowledge k ${join}
      LEFT JOIN LATERAL (
        SELECT cc.key, cc.name FROM knowledge_category kc2 JOIN category cc ON cc.id=kc2.category_id
         WHERE kc2.name=k.name AND kc2.state<>'rejected' ORDER BY kc2.category_id LIMIT 1
      ) cat ON true
      LEFT JOIN LATERAL (
        SELECT r.note, r.reviewed_by FROM knowledge_revision r
         WHERE r.name=k.name AND r.status='approved' AND r.note IS NOT NULL
           AND (abs(extract(epoch FROM (r.reviewed_at - k.updated_at))) < 600
             OR abs(extract(epoch FROM (r.created_at  - k.updated_at))) < 600)
         ORDER BY r.reviewed_at DESC LIMIT 1
      ) rev ON true
      WHERE ${wh.join(" AND ")}
      ORDER BY activity_at DESC
      LIMIT $${params.length}`, params) as Promise<Record<string, unknown>[]>;
}

export async function getKnowledge(name: string): Promise<(KnowledgeRow & { categories: unknown[]; links?: unknown; sources?: unknown[] }) | undefined> {
  // fields 는 목록(K_COLS)엔 무겁고 상세엔 필수(#551 노션 속성 패널) — 상세 조회에서만 포함.
  //  props_ui(#592 항목 단위 속성 노출 오버라이드)도 fields 와 같은 취급(상세 전용).
  const k = await one(itemsPool, `SELECT ${K_SEL}, k.fields, k.props_ui FROM knowledge k WHERE k.name=$1`, [name]);
  if (!k) return undefined;
  const categories = await q(itemsPool,
    `SELECT kc.category_id, kc.state, c.space, c.key, c.name
     FROM knowledge_category kc JOIN category c ON c.id=kc.category_id WHERE kc.name=$1`, [name]);
  const links = await listKnowledgeLinks(name);              // #290 지식↔지식(outgoing + 백링크)
  const sources = await q(itemsPool,                          // #290 인용한 자료(derived_from/cites)
    `SELECT ks.source_id, ks.relation, s.title, s.kind FROM knowledge_source ks JOIN source s ON s.id=ks.source_id
     WHERE ks.name=$1 ORDER BY ks.relation`, [name]);
  // #551 페이지 트리 — 자식(sort 순, archived 는 UI 가 배지로 구분)과 조상 체인(브레드크럼). parent_name 소프트참조.
  const children = await q(itemsPool,
    `SELECT name, title, sort, lifecycle, external_system, type, is_folder,
            props_ui->>'icon' AS icon,
            fields->'notion'->>'kind' AS notion_kind
     FROM knowledge WHERE parent_name=$1 AND lifecycle <> 'superseded'
     ORDER BY sort, title NULLS LAST, name LIMIT 500`, [name]);
  // 캡 도달 시 총계 동봉 — 대형 DB(수천 행)에서 knowledge_get 응답이 행 수에 비례 폭주하지 않게(#551 리뷰).
  const childrenTotal = children.length === 500
    ? Number((await one(itemsPool, `SELECT count(*)::int AS n FROM knowledge WHERE parent_name=$1 AND lifecycle <> 'superseded'`, [name]))?.n ?? 500)
    : children.length;
  const ancestors = await q(itemsPool,
    `WITH RECURSIVE up AS (
       SELECT k2.name, k2.title, k2.parent_name, 1 AS depth
       FROM knowledge k2 WHERE k2.name = (SELECT parent_name FROM knowledge WHERE name=$1)
       UNION ALL
       SELECT k3.name, k3.title, k3.parent_name, up.depth + 1
       FROM knowledge k3 JOIN up ON k3.name = up.parent_name WHERE up.depth < 20
     ) SELECT name, title FROM up ORDER BY depth DESC`, [name]);
  return { ...k, categories, links, sources, children, children_total: childrenTotal, ancestors };
}

// #551 페이지 트리 뷰 데이터 — 외부 미러(예: notion) 전체의 얕은 트리 스켈레톤(name/title/parent/sort/lifecycle/kind).
//  목록 cap(500) 우회 전용 표면: 본문·fields 미포함이라 수천 행도 가볍다. 클라이언트가 트리를 조립한다.
//  #592: system='authored' 특수값 — 외부 미러가 아닌 **저작 지식**(external_system IS NULL)의 트리 스켈레톤
//  (폴더 is_folder 포함, 지식탭 사이드바 트리 전용). 기존 notion 등 미러 경로는 불변.
export async function knowledgeTreeData(system: string, limit = 20000): Promise<Record<string, unknown>[]> {
  const cap = Math.min(limit, 50000);
  if (system === "authored") {
    return q(itemsPool,
      `SELECT name, title, parent_name, sort, lifecycle, is_folder, updated_at,
              props_ui->>'icon' AS icon
       FROM knowledge WHERE external_system IS NULL AND lifecycle <> 'superseded'
       ORDER BY parent_name NULLS FIRST, sort, title NULLS LAST, name
       LIMIT $1`, [cap]);
  }
  return q(itemsPool,
    `SELECT name, title, parent_name, sort, lifecycle, external_id, external_url, updated_at,
            props_ui->>'icon' AS icon,
            fields->'notion'->>'kind' AS kind
     FROM knowledge WHERE external_system=$1 AND lifecycle <> 'superseded'
     ORDER BY parent_name NULLS FIRST, sort, title NULLS LAST, name
     LIMIT $2`, [system, cap]);
}

/** resolveUpsertFacets 입력 — upsertKnowledge input 의 facet 부분집합(명시 시 우선). 상위 input 을 통째로 넘겨도 무방(구조적). */
export interface UpsertFacetInput {
  injection?: string; provenance?: string; summary?: string | null; sort?: number; is_wiki?: boolean; type?: string | null;
  is_folder?: boolean; parent_name?: string | null;   // #592 폴더·트리 위치 — 본문만 편집해도 유실 금지(같은 불변식)
}
/** 병합 결과 — INSERT VALUES / ON CONFLICT DO UPDATE(is_wiki=EXCLUDED.is_wiki 등) 파라미터로 그대로 사용. */
export interface ResolvedFacets {
  injection: string; provenance: string; summary: string | null; sort: number; isWiki: boolean; type: string | null;
  isFolder: boolean; parentName: string | null;
}
/**
 * upsert facet 병합 규칙 — "명시(undefined 아님) 우선 → 없으면 기존(before) 보존 → 신규(before=null)면 기본값".
 * 편집 저장(본문만 갱신, facet 미전송)이 WIKI 핀(is_wiki)·주입(injection)·요약·정렬·page-type 을 조용히 유실하지
 * 않게 하는 불변식(프로젝트 #345). 규칙이 upsertKnowledge 인라인에 흩어지면 리팩터 중 한 facet(특히 is_wiki 핀)이
 * 누락돼도 티가 안 나므로, 단일 순수 함수로 모아 knowledge-store.test.ts 가 회귀를 잡는다.
 */
export function resolveUpsertFacets(input: UpsertFacetInput, before: Record<string, unknown> | null | undefined): ResolvedFacets {
  return {
    injection: input.injection ?? (before?.injection as string) ?? "recalled",
    provenance: input.provenance ?? (before?.provenance as string) ?? "authored",
    summary: input.summary !== undefined ? input.summary : ((before?.summary as string | null) ?? null),
    sort: input.sort !== undefined ? input.sort : (Number(before?.sort) || 0),
    isWiki: input.is_wiki !== undefined ? input.is_wiki : ((before?.is_wiki as boolean) ?? false),
    type: input.type !== undefined ? input.type : ((before?.type as string | null) ?? null),
    // #592: 폴더 플래그·트리 위치도 같은 클래스 — 본문만 편집하는 저장이 폴더를 문서로 리셋하거나 트리에서 떼어내면 안 된다.
    isFolder: input.is_folder !== undefined ? input.is_folder : ((before?.is_folder as boolean) ?? false),
    parentName: input.parent_name !== undefined ? input.parent_name : ((before?.parent_name as string | null) ?? null),
  };
}

/**
 * #921 append 본문 병합 — 기존 본문(base) 끝에 조각(chunk)을 덧붙인 전문을 만든다.
 *
 * 구분자를 **서버가** 정규화하는 이유: append 의 요점은 호출자가 본문을 읽지 않는 것이라, 호출자는 base 가
 * 개행으로 끝나는지 알 수 없다 — 그대로 이으면 조각이 마지막 줄에 들러붙는다. 빈 줄 하나로 이어 마크다운
 * 블록 경계를 보장한다(그 대가로 기존 표·타이트 리스트에 '행 추가'는 안 된다 — 그건 replace 로).
 * chunk 는 앞 개행만 지우고 들여쓰기는 보존한다(들여쓴 코드블록이 깨지지 않게).
 *
 * 불변식: base 의 내용은 절대 건드리지 않는다(끝 공백 제거만) — '원문유지·append' 가 이 모드의 존재 이유다.
 */
export function appendBody(base: string, chunk: string): string {
  const b = (base ?? "").replace(/\s+$/, "");
  const c = normalizeAppendChunk(chunk);
  if (!b) return c;
  if (!c) return b;
  return `${b}\n\n${c}`;
}

// 조각 정규화 — appendBody 와 isDuplicateAppend 가 반드시 같은 문자열을 봐야 해서 한 곳에 둔다
//  (다르면 '붙인 것'과 '중복 판정 대상'이 어긋나 감지가 헛돈다).
const normalizeAppendChunk = (chunk: string): string => (chunk ?? "").replace(/^[\r\n]+/, "").replace(/\s+$/, "");

/**
 * #921 중복 append 감지 — 조각이 이미 본문 끝에 그대로 있는가.
 *
 * replace 는 재시도해도 결과가 같지만(멱등) append 는 아니다 — 응답을 못 받은 호출자가 재시도하면 같은 단락이
 * 두 번 붙는다. 그런데 append 호출자는 본문을 읽지 않으므로(그게 이 모드의 요점) 그 중복을 스스로 알 수 없다.
 * → 서버가 본다. 유사도·부분일치가 아니라 **정규화 후 꼬리 정확일치**만 — 오탐은 '직전에 붙인 것과 완전히 같은
 * 조각을 의도적으로 또 붙이는' 경우뿐이고, 그건 replace 로 하라고 안내하면 된다.
 */
export function isDuplicateAppend(base: string, chunk: string): boolean {
  const c = normalizeAppendChunk(chunk);
  if (!c) return false;
  return (base ?? "").replace(/\s+$/, "").endsWith(c);
}

// ── #592 트리 부모 가드(공용: upsertKnowledge·moveKnowledge) — 존재 + observed 부모 금지 + 비순환. ──
//  observed(외부 미러) 아래로의 배치 금지 = 미러 트리는 원본(노션)이 진실(재싱크가 재배치를 되돌린다).
//  비순환 = parent 의 조상 체인(재귀 CTE, getKnowledge ancestors 동형)에 자신이 있으면 거부.
//  에러 문구의 '없음'/'허용' 토큰은 rest-util wrap() 의 상태코드 매핑(404/400)에 load-bearing.
async function assertTreeParent(childName: string, parentName: string): Promise<void> {
  if (parentName === childName) throw new Error("자기 자신을 부모로 지정하는 것은 허용되지 않습니다");
  const parent = await one(itemsPool, `SELECT provenance FROM knowledge WHERE name=$1`, [parentName]);
  if (!parent) throw new Error(`부모 지식 '${parentName}' 없음`);
  if ((parent as { provenance?: string }).provenance === "observed") {
    throw new Error("외부 미러(observed) 지식 아래로의 배치는 허용되지 않습니다 — 원본(노션 등)에서 옮기세요");
  }
  const cyc = await one(itemsPool,
    `WITH RECURSIVE up AS (
       SELECT k2.name, k2.parent_name, 1 AS depth FROM knowledge k2 WHERE k2.name=$1
       UNION ALL
       SELECT k3.name, k3.parent_name, up.depth + 1
       FROM knowledge k3 JOIN up ON k3.name = up.parent_name WHERE up.depth < 50
     ) SELECT 1 AS x FROM up WHERE up.name=$2 LIMIT 1`, [parentName, childName]);
  if (cyc) throw new Error("순환 트리는 허용되지 않습니다 — 자신의 하위로는 이동할 수 없습니다");
}

// 반환에 wikilinks 를 얹는다(#907) — getKnowledge 가 categories/links 를 얹는 것과 같은 급의 파생 정보다.
//  행 자체(감사·undo 입력)는 오염되지 않는다: auditKnowledge 는 이 아래에서 raw `after` 로 이미 기록된다.
//  호출부는 응답에 실을 때 구조분해로 떼어낸다(knowledge_save) — 기존 호출부는 무시하면 그만이라 비파괴.
export async function upsertKnowledge(
  input: { name?: string; title?: string; body_md: string; injection?: string; provenance?: string; lifecycle?: string; confidence?: string; source?: string; supersedes?: string; summary?: string | null; sort?: number; is_wiki?: boolean; type?: string | null; category?: string | string[]; is_folder?: boolean; parent_name?: string | null },
  ctx?: WriteCtx,
): Promise<KnowledgeRow & { wikilinks?: WikiLinkResult }> {
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
  // 단일 카테고리(#290): 단일 키 문자열 또는 배열(커넥터 호환) 정규화. 미존재 key 는 INSERT 전 차단(미분류·오타 방지).
  const catKeys = Array.isArray(input.category) ? input.category : (input.category != null ? [input.category] : []);
  const catIds: number[] = [];
  for (const key of catKeys) {
    const cat = await one(itemsPool, `SELECT id FROM category WHERE key=$1 AND state<>'merged' LIMIT 1`, [key]);
    if (!cat) throw new Error(`category '${key}' 없음 — category_list 로 확인하세요`);
    catIds.push((cat as { id: number }).id);
  }
  // 신규 지식: category(단일) + type(page-type) 둘 다 필수(#290). 기존 편집은 보존(생략 허용).
  if (!before && !catIds.length) {
    throw new Error("신규 지식은 category(분류) 1개 필수 — category_list 의 key 를 지정하세요(단일 분류).");
  }
  if (!before && !input.type) {
    throw new Error("신규 지식은 type(page-type) 필수 — decision|concept|how-to|reference|research|entity 중 하나를 지정하세요.");
  }
  // confidence 는 source 로 서버강제(mcp→ai, web→human) 또는 명시값(기존 보존 대상 아님 — ctx 파생).
  const confidence = input.confidence ?? (ctx?.source === "mcp" ? "ai" : "human");
  // injection/provenance/summary/sort/is_wiki/type/is_folder/parent_name: 명시 우선 → 없으면 기존(before) 보존 → 신규 기본값.
  //  편집 저장(본문만)이 WIKI 핀 is_wiki 등 미전송 facet 을 조용히 유실하지 않게 하는 불변식 — 단일 진실 resolveUpsertFacets(#345 회귀 방지, knowledge-store.test.ts).
  const { injection, provenance, summary, sort, isWiki, type, isFolder, parentName } = resolveUpsertFacets(input, before);
  // #592 폴더: 본문 없는 트리 노드라 title 이 유일한 표시명 — 신규 폴더는 title 필수(빈 body_md 완화는 capability 쪽).
  if (!before && isFolder && !input.title?.trim()) {
    throw new Error("폴더(is_folder) 생성에는 title 이 필수입니다.");
  }
  // 보안/#592: observed(외부 미러)의 트리 위치·폴더 플래그는 원본(노션 등)이 진실 — moveKnowledge 와 대칭으로
  //  upsert 경로도 재부모화·폴더 재타입을 거부한다. 안 막으면 knowledge_save 로 미러를 폴더로 뒤집거나
  //  트리에서 떼어낼 수 있고, 커넥터 재싱크는 is_folder 를 안 건드려 손상이 영구 잔존한다(리뷰 확정).
  if (before && (before as { provenance?: string }).provenance === "observed") {
    if (input.parent_name !== undefined && (input.parent_name ?? null) !== ((before.parent_name as string | null) ?? null)) {
      throw new Error("외부 미러(observed) 지식은 이동이 허용되지 않습니다 — 원본(노션 등)에서 옮기세요.");
    }
    if (input.is_folder !== undefined && !!input.is_folder !== !!(before as { is_folder?: boolean }).is_folder) {
      throw new Error("외부 미러(observed) 지식은 폴더 전환이 허용되지 않습니다 — 원본(노션 등)이 진실입니다.");
    }
  }
  // #592 생성/저장 시 트리 위치 — parent_name 이 **명시**됐을 때만 가드(미전송=기존 보존이라 이미 유효).
  if (input.parent_name != null && input.parent_name !== before?.parent_name) {
    await assertTreeParent(name, input.parent_name);
  }
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, supersedes, confidence, source, summary, sort, is_wiki, type, is_folder, parent_name, version, updated_at, updated_by)
     VALUES($1,$2,$3,$4,$5,$16,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,now(),$15)
     ON CONFLICT (name) DO UPDATE SET
       title=COALESCE(EXCLUDED.title, knowledge.title), body_md=EXCLUDED.body_md,
       injection=EXCLUDED.injection, provenance=EXCLUDED.provenance, supersedes=EXCLUDED.supersedes,
       confidence=EXCLUDED.confidence, source=EXCLUDED.source,
       summary=EXCLUDED.summary, sort=EXCLUDED.sort, is_wiki=EXCLUDED.is_wiki, type=COALESCE(EXCLUDED.type, knowledge.type),
       is_folder=EXCLUDED.is_folder, parent_name=EXCLUDED.parent_name,
       version=knowledge.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [name, input.title ?? null, input.body_md, injection, provenance, input.supersedes ?? null, confidence, input.source ?? "authored", summary, sort, isWiki, type, isFolder, parentName, ctx?.actor ?? null,
     // #638 $16 lifecycle — 신규는 input.lifecycle(자동 인입이 검토대기로 pending 지정) ?? 'active'. 재저장은 ON CONFLICT DO UPDATE 가 lifecycle 미포함이라 기존 보존(승인 전환은 set_lifecycle 로만).
     input.lifecycle ?? "active"]);
  const after = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  await auditKnowledge(name, before ? "update" : "insert", before, after, ctx);
  // #290 단일 카테고리: 첫 카테고리만 적용(linkKnowledgeCategory 가 replace). 2+ 전달은 정책상 경고하고 무시.
  if (catIds.length > 1) console.warn(`[knowledge] '${name}' 단일 카테고리 정책 — 첫 카테고리만 적용(${catIds.length}개 전달).`);
  if (catIds.length) await linkKnowledgeCategory(name, catIds[0], "confirmed", ctx);
  // 벡터검색(#172) — 임베딩 on 이면 본문 임베딩 갱신(best-effort, off=no-op, 실패해도 저장 성공 보존).
  await embedKnowledgeBestEffort(name, { title: input.title ?? (after?.title as string | null), summary, body_md: input.body_md });
  // #907 본문 [[…]] → 자동 엣지. 스토어 층에 두는 이유: 리비전 승인(knowledge-revision-store)·undo 등 **모든 upsert
  //  writer** 가 본문을 바꾸면 엣지도 따라가야 한다(capability 에만 두면 그 경로들이 조용히 어긋난다).
  //  미매칭은 예외가 아니라 경고다 — 호출부가 응답에 실어 붕 뜬 링크를 알린다(#907 목표2).
  const wikilinks = await materializeWikiLinksBestEffort(name, input.body_md);
  return wikilinks ? { ...after, wikilinks } : after;
}

// 얕은 lifecycle 조회 — 게이트 가드용(#783 자가승인 차단). getKnowledge 는 카테고리·링크·트리까지 조인해 무겁다.
export async function getKnowledgeLifecycle(name: string): Promise<string | undefined> {
  const r = await one(itemsPool, `SELECT lifecycle FROM knowledge WHERE name=$1`, [name]);
  return (r as { lifecycle?: string } | undefined)?.lifecycle;
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

// ── #592 항목 단위 속성 노출 오버라이드(props_ui) — { show:[키], hide:[키], full_width:bool } 부분 병합. ──
//  키에 null 을 명시하면 그 키 제거, undefined(미전송)는 미변경. 전부 비면 컬럼 NULL 로 환원.
//  뷰 설정은 내용이 아니다 — version 불변(setKnowledgeWiki 참조), updated_at 도 불변(목록 최신순 정렬을
//  속성 토글이 밀어올리지 않게). observed(미러)에도 허용 — fields 가 아닌 별도 컬럼이라 재싱크에 생존(#592 §0).
//  icon/cover(#657) — 페이지 꾸미기(이모지 아이콘·커버 프리셋/이미지 URL)도 같은 클래스(내용 아님·미러에도 장식 허용).
export interface KnowledgePropsUiPatch { show?: string[] | null; hide?: string[] | null; full_width?: boolean | null; icon?: string | null; cover?: string | null }
export async function setKnowledgePropsUi(name: string, patch: KnowledgePropsUiPatch, ctx?: WriteCtx): Promise<Record<string, unknown>> {
  const row = await one(itemsPool, `SELECT props_ui FROM knowledge WHERE name=$1`, [name]);
  if (!row) throw new Error(`지식 '${name}' 없음`);
  const beforeUi = (row as { props_ui?: unknown }).props_ui;
  const merged: Record<string, unknown> =
    beforeUi && typeof beforeUi === "object" && !Array.isArray(beforeUi) ? { ...(beforeUi as Record<string, unknown>) } : {};
  for (const key of ["show", "hide", "full_width", "icon", "cover"] as const) {
    const v = patch[key];
    if (v === undefined) continue;           // 미전송 = 미변경
    if (v === null) delete merged[key];      // null 명시 = 키 제거
    else merged[key] = v;
  }
  const value = Object.keys(merged).length ? JSON.stringify(merged) : null;
  await itemsPool.query(`UPDATE knowledge SET props_ui=$2::jsonb WHERE name=$1`, [name, value]);
  await auditKnowledge(name, "set_props_ui", { props_ui: beforeUi ?? null }, { props_ui: value ? merged : null }, ctx);
  return merged;
}

// ── #592 트리 이동 — parent_name(null=루트)·sort 갱신(폴더 포함). 가드: 대상 observed 금지(원본이 진실 —
//  노션에서 옮겨야 하고, 재싱크가 어차피 되돌린다) + 부모 존재/비observed/비순환(assertTreeParent).
//  구조 변경이지 내용 변경이 아니므로 version 불변(감사는 op='move'로 남는다).
export async function moveKnowledge(name: string, parentName: string | null, sort?: number, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!before) throw new Error(`지식 '${name}' 없음`);
  if ((before as { provenance?: string }).provenance === "observed") {
    throw new Error("외부 미러(observed) 지식은 이동이 허용되지 않습니다 — 원본(노션 등)에서 옮기세요");
  }
  if (parentName != null) await assertTreeParent(name, parentName);
  const after = await one(itemsPool,
    `UPDATE knowledge SET parent_name=$2, sort=COALESCE($3, sort), updated_at=now() WHERE name=$1 RETURNING ${K_COLS}`,
    [name, parentName, sort ?? null]);
  await auditKnowledge(name, "move",
    { parent_name: (before as { parent_name?: string | null }).parent_name ?? null, sort: (before as { sort?: number }).sort },
    { parent_name: parentName, sort: (after as { sort?: number }).sort }, ctx);
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
  icon?: string | null;  // 페이지 아이콘(#657, props_ui->>'icon') — 검색 결과 행 표시용
}
export type KnowledgeGrepMode = "snippets" | "names" | "count";
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
      provenance: r.provenance, is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at, icon: r.icon ?? null };
    if (withBody) base.snippet = grepSnippet(r.body_md ?? "", plan, opts.context);
    return base;
  });
}

// ── 하이브리드 검색(knowledge_search, 벡터검색 #172) — 벡터(cosine) ∪ 렉시컬(grep) RRF 융합. ──
//  · 임베딩 off / 쿼리 임베딩 실패 / SQL 실패 → 전부 searchKnowledge(렉시컬)로 폴백(하위호환·safe-by-construction).
//  · grep 과 다른 점: 단어가 본문에 그대로 없어도 의미 유사로 회수(벡터 채널). 정확 토큰/정규식은 knowledge_grep.
//  · 결과는 grep 과 동일 표면(스니펫·전문 미포함). 벡터-only 매치는 grepSnippet 이 본문 앞부분 미리보기로 폴백.
//  RRF_K/HYBRID_CANDIDATES 는 search-util.ts 에서 import(project 검색과 공유).

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
      provenance: r.provenance, is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at, score: Number(r.score), icon: r.icon ?? null };
    if (withBody) base.snippet = grepSnippet(r.body_md ?? "", plan, opts.context);
    return base;
  });
}

// ── 유사 지식(벡터검색 #172) — 코사인 유사도(0~1) 기반 최근접. 저장-시 중복감지·관련패널의 프리미티브. ──
//  · raw 유사도 = 1 - (embedding_vector <=> qvec) (pgvector <=> 는 코사인 거리 → 1-거리 = 코사인 유사도).
//    RRF score(랭크 기반, hybridSearch)와 달리 **절대 임계 비교 가능**(중복 판정 등) — 이게 proactive·dedup 의 열쇠.
//  · 입력: name(기존 지식 → 저장된 임베딩 재사용, 재임베딩 불요) 또는 text(임시 텍스트 → 즉시 임베딩). name 우선.
//  · 임베딩 off / 대상 임베딩 없음 / 쿼리 임베딩 실패 / SQL 실패 → 빈 배열(graceful — 호출부는 "유사 없음"으로 처리).
//  previewBody(식별용 미리보기)는 search-util.ts 에서 import.

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
  // #290 단일 카테고리: 기존 다른 카테고리 매핑을 먼저 제거(replace) — knowledge_category_single_uq 와 정합(앱이 단일 강제, 인덱스 위반 대신 교체).
  await itemsPool.query(`DELETE FROM knowledge_category WHERE name=$1 AND category_id<>$2`, [name, categoryId]);
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

// ── 미분류 지식 인박스(#982) — 카테고리 행이 하나도 없는 active 지식. 분류기(classify_knowledge)가 여기서 드레인. ──
//  list_unmapped(코드유닛)의 지식판. 포인터만(본문 X). 커넥터 미러는 카테고리를 안 써서(connector-mirror 보존규칙) 여기 쌓인다.
//  ⚠ '0행'(NOT EXISTS any) 기준 — knowledge_category_single_uq 가 name 당 1행이라, rejected 1행이라도 있으면 INSERT 가 uq 위반이므로
//   애초에 인박스에서 뺀다(이미 판정된 것 재분류 안 함). 소비쿼리의 state<>'rejected' 와는 다른 기준(그건 '보이나', 이건 '빌 자리인가').
export async function listUnmappedKnowledge(limit = 50): Promise<Array<{ name: string; title: string | null; type: string | null; provenance: string }>> {
  const lim = Math.min(Math.max(limit, 1), 200);
  const rows = await q(itemsPool, `
    SELECT k.name, k.title, k.type, k.provenance
    FROM knowledge k
    WHERE k.lifecycle='active'
      AND NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name)
    ORDER BY k.updated_at DESC
    LIMIT $1`, [lim]);
  return rows.map((r) => ({ name: r.name as string, title: (r.title ?? null) as string | null, type: (r.type ?? null) as string | null, provenance: r.provenance as string }));
}

// ── LLM 분류 제안(#982, map_code_unit 의 지식판) — 미분류 지식에 카테고리를 mapped_by='llm'+evidence 로 건다. ──
//  linkKnowledgeCategory 와 결정적 차이 3가지: ① DELETE 안 함(replace 아님 — 사람 분류 불가침) ② mapped_by='llm' ③ **이미 카테고리 행이 있으면 no-op**.
//  state: 명시하면 그대로, 아니면 confidence≥0.8 → 'confirmed' 아니면 'proposed'. 소비쿼리는 state<>'rejected' 라 proposed 만으로 즉시 발견된다.
export async function proposeKnowledgeCategory(
  name: string, categoryId: number,
  opts: { evidence: string; confidence?: number | null; state?: string }, ctx?: WriteCtx,
): Promise<{ applied: boolean; state: string; skipped?: string }> {
  const state = opts.state ?? ((opts.confidence ?? 0) >= 0.8 ? "confirmed" : "proposed");
  // 분류기는 '빈 자리'만 채운다 — 이미 카테고리 행(어떤 state 든)이 있으면 건너뛴다(single_uq 위반 방지 + 사람/기존 판정 불가침).
  const ex = await itemsPool.query(`SELECT 1 FROM knowledge_category WHERE name=$1 LIMIT 1`, [name]);
  if (ex.rowCount) return { applied: false, state, skipped: "already_has_category" };
  await itemsPool.query(
    `INSERT INTO knowledge_category(name, category_id, mapped_by, confidence, state, evidence, created_at)
     VALUES($1,$2,'llm',$3,$4,$5,now())
     ON CONFLICT (name, category_id) DO UPDATE SET state=EXCLUDED.state, confidence=EXCLUDED.confidence, evidence=EXCLUDED.evidence, mapped_by='llm'`,
    [name, categoryId, opts.confidence ?? null, state, opts.evidence]);
  await auditKnowledge(name, "propose_category", null, { category_id: categoryId, state, mapped_by: "llm", confidence: opts.confidence ?? null }, ctx);
  return { applied: true, state };
}

// ════════ #976/#984 지식 발행표식(knowledge_publication) — authored 지식을 외부 피드로 투영한 좌표(external_* 과 직교). ════════
//  멱등 upsert 좌표 (name, system, target_id). page_id 는 최초 create 성공 후 채워져 이후 update 대상이 된다.
//  content_hash 로 무변경 재푸시 skip(드레인 비용·API 호출 절감). observed 미러 경로와 무관 — provenance 안 건드림(#984 결정).
export interface KnowledgePublicationRow {
  name: string; system: string; instance: string | null; target_id: string;
  page_id: string | null; url: string | null; content_hash: string | null;
  state: string; published_at: string | null;
}

export async function getKnowledgePublication(
  name: string, system: string, targetId: string,
): Promise<KnowledgePublicationRow | null> {
  const r = (await one(itemsPool,
    `SELECT name, system, instance, target_id, page_id, url, content_hash, state, published_at
     FROM knowledge_publication WHERE name=$1 AND system=$2 AND target_id=$3`,
    [name, system, targetId])) as KnowledgePublicationRow | undefined;
  return r ?? null;
}

// create/update 성공 후 표식 확정(published) — page_id·url·hash 갱신. 멱등 upsert(좌표 재발행 시 UPDATE).
export async function recordKnowledgePublication(
  p: { name: string; system: string; instance?: string | null; targetId: string;
       pageId: string; url?: string | null; contentHash: string; publishedBy?: string | null },
): Promise<void> {
  await itemsPool.query(
    `INSERT INTO knowledge_publication(name, system, instance, target_id, page_id, url, content_hash, state, last_error, published_at, published_by, created_at, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'published',NULL,now(),$8,now(),now())
     ON CONFLICT (name, system, target_id) DO UPDATE SET
       instance=EXCLUDED.instance, page_id=EXCLUDED.page_id, url=EXCLUDED.url,
       content_hash=EXCLUDED.content_hash, state='published', last_error=NULL,
       published_at=now(), published_by=EXCLUDED.published_by, updated_at=now()`,
    [p.name, p.system, p.instance ?? null, p.targetId, p.pageId, p.url ?? null, p.contentHash, p.publishedBy ?? null]);
}

// 발행 실패 기록(다음 드레인 재시도) — 좌표 행은 남기되 state=failed + last_error. page_id 기존값 보존.
export async function markKnowledgePublicationFailed(
  name: string, system: string, targetId: string, err: string,
): Promise<void> {
  await itemsPool.query(
    `INSERT INTO knowledge_publication(name, system, target_id, state, last_error, created_at, updated_at)
     VALUES($1,$2,$3,'failed',$4,now(),now())
     ON CONFLICT (name, system, target_id) DO UPDATE SET
       state='failed', last_error=EXCLUDED.last_error, updated_at=now()`,
    [name, system, targetId, err.slice(0, 500)]);
}

// ════════ #290 지식↔지식 링크(knowledge_link) — 빠진 1급 프리미티브. 단방향 1행 저장 + 역방향 쿼리로 백링크(MediaWiki/Obsidian 모델). ════════
//  relation=related(대칭)|refines|contradicts|depends_on. FK 가 양 끝 지식 존재를 보장(없으면 INSERT 거부 → capability 에서 클린 에러).
//  origin(#907): 'user'=사람·에이전트가 명시 · 'wikilink'=본문 [[…]] 파생 · 'connector:<sys>'=커넥터 물질화.
//   UI·해제 가드가 '이 엣지를 여기서 떼도 되나'를 판단해야 해서 조회에 싣는다(파생 엣지는 본문이 SoT다).
export interface KnowledgeLinkRow { name: string; relation: string; title: string | null; origin: string }
export async function linkKnowledge(fromName: string, toName: string, relation = "related", ctx?: WriteCtx): Promise<void> {
  if (fromName === toName) throw new Error("자기 자신과 링크할 수 없습니다");
  await itemsPool.query(
    `INSERT INTO knowledge_link(from_name, to_name, relation, origin, created_at, updated_at)
     VALUES($1,$2,$3,'user',now(),now())
     ON CONFLICT (from_name, to_name, relation) DO UPDATE SET updated_at=now(), origin='user'`,
    [fromName, toName, relation]); // 커넥터 물질화 행과 충돌 시 origin 을 user 로 승격 — 다음 싱크의 재작성 DELETE 에서 보호(#551)
  await auditKnowledge(fromName, "link_knowledge", null, { to_name: toName, relation }, ctx);
}
export async function unlinkKnowledge(fromName: string, toName: string, relation: string, ctx?: WriteCtx): Promise<void> {
  // #907 본문 파생 엣지는 여기서 못 뗀다 — 본문이 SoT라 지워봐야 다음 저장·스윕이 되살린다(“지웠는데 살아나”).
  //  진짜 해제 방법(본문에서 [[…]] 제거)을 알려주는 게 조용히 되살아나는 것보다 정직하다. 사람·에이전트 공통 가드.
  //  ⚠ 문구의 '허용' 은 load-bearing — rest-util wrap() 이 이 토큰으로 400 을 매핑한다(없으면 500 +
  //   메시지가 'internal_error' 로 치환돼 이 안내가 통째로 사라진다). assertTreeParent·moveKnowledge 와 같은 idiom.
  const auto = await one(itemsPool,
    `SELECT 1 AS x FROM knowledge_link WHERE from_name=$1 AND to_name=$2 AND relation=$3 AND origin='wikilink'`,
    [fromName, toName, relation]);
  if (auto) {
    throw new Error(
      `'${fromName}' 본문의 [[${toName}]] 에서 자동 생성된 연결이라 여기서 해제가 허용되지 않습니다 — 본문에서 [[${toName}]] 를 지우면 연결도 사라집니다(관계를 바꾸려면 knowledge_link 로 명시하세요).`);
  }
  await itemsPool.query(`DELETE FROM knowledge_link WHERE from_name=$1 AND to_name=$2 AND relation=$3`, [fromName, toName, relation]);
  await auditKnowledge(fromName, "unlink_knowledge", { to_name: toName, relation }, null, ctx);
}
// 양방향 — outgoing(이 지식이 가리키는) + incoming(이 지식을 가리키는 = 백링크). 비활성 지식은 제외.
export async function listKnowledgeLinks(name: string): Promise<{ outgoing: KnowledgeLinkRow[]; incoming: KnowledgeLinkRow[] }> {
  const outgoing = await q(itemsPool,
    `SELECT l.to_name AS name, l.relation, l.origin, k.title FROM knowledge_link l JOIN knowledge k ON k.name=l.to_name
     WHERE l.from_name=$1 AND k.lifecycle='active' ORDER BY l.relation, k.updated_at DESC`, [name]);
  const incoming = await q(itemsPool,
    `SELECT l.from_name AS name, l.relation, l.origin, k.title FROM knowledge_link l JOIN knowledge k ON k.name=l.from_name
     WHERE l.to_name=$1 AND k.lifecycle='active' ORDER BY l.relation, k.updated_at DESC`, [name]);
  return { outgoing, incoming };
}
// ════════ #907 본문 [[위키링크]] → 자동 엣지(origin='wikilink'). **본문이 SoT**. ════════
//  왜: [[…]] 를 본문에 적어도 엣지가 안 생겼다 — knowledge_link 를 따로 부르지 않으면 백링크·그래프뷰·recall
//   그래프에서 관계가 통째로 유실된다(#869 마무리 중 실측으로 드러남). 착수 시점 실측: 활성 지식 본문의
//   위키링크 939건 중 엣지가 있던 건 136건뿐 — 약 770건이 텍스트로만 존재했다.
//  규율은 커넥터 물질화(#551 materializeNotionLinks)와 동형 — **자기 origin 엣지만** 지우고 본문에서 다시 만든다:
//   · origin='wikilink' = 본문 파생(파생 상태) → 본문에서 [[x]] 를 빼면 다음 저장에 엣지도 사라진다(완전 동기화).
//   · origin='user'(knowledge_link) = 사람·에이전트가 명시한 엣지 → 불가침. 같은 쌍을 수동 링크하면 linkKnowledge 가
//     origin 을 'user' 로 승격시켜 이 재작성 DELETE 에서 빠진다 — 관계 타입 지정도 그 경로다.
//  relation 은 전부 'related' — Obsidian 문법에 타입 관계가 없다(wikilink.ts 헤더 · https://obsidian.md/help/links).
export interface WikiLinkResult { linked: string[]; unmatched: string[] }

/** raw 대상 → 실제 knowledge.name 해소. **exact 우선 → slugify 폴백**(이 순서가 load-bearing):
 *   · slugify 는 strip→slice(64) 순서라 64자에서 잘린 이름은 '-' 로 끝날 수 있다(실재 2건). 재슬러그화하면
 *     그 꼬리 '-' 가 떨어져 **정확히 쓴 링크가 오히려 미매칭**된다.
 *   · 대소문자만 다른 동명 지식이 실재한다(2026-06-11-PM툴… / …-pm툴…, 같은 제목·둘 다 active). 먼저 정규화하면
 *     작성자가 지목한 문서가 아닌 쪽에 붙는다 — exact 가 있으면 그게 작성자의 의도다.
 *  자기 자신은 버린다(knowledge_link_noself_chk 가 거부한다). existing 은 lifecycle 무관 전체 name —
 *  FK 는 존재만 요구하고, pending 대상을 '없음'으로 경고하면 거짓 경고가 된다(승인되면 그대로 유효한 링크다). */
export function resolveWikiLinkTargets(fromName: string, targets: string[], existing: ReadonlySet<string>): WikiLinkResult {
  const linked: string[] = [], unmatched: string[] = [];
  for (const raw of targets) {
    const slug = slugify(raw);
    const hit = existing.has(raw) ? raw : (existing.has(slug) ? slug : null);
    if (!hit) { if (!unmatched.includes(raw)) unmatched.push(raw); continue; }
    if (hit === fromName) continue;                       // 자기 참조 — 엣지 불가(CHECK). 조용히 버린다(오류 아님).
    if (!linked.includes(hit)) linked.push(hit);          // raw 와 slug 가 같은 문서로 접히면 1건으로(knowledge_link_uq)
  }
  return { linked, unmatched };
}

/** origin='wikilink' 엣지 재작성 — from_name 것만 지우고 본문 해소분을 다시 넣는다(멱등·수렴형).
 *  ON CONFLICT DO NOTHING = 같은 쌍의 'user' 엣지가 있으면 그대로 존중(사람 링크 불가침 — #551 idiom). */
async function rewriteWikiLinkEdges(fromName: string, toNames: string[]): Promise<void> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM knowledge_link WHERE from_name=$1 AND origin='wikilink'`, [fromName]);
    if (toNames.length) {
      await client.query(
        `INSERT INTO knowledge_link(from_name, to_name, relation, origin, created_at, updated_at)
         SELECT $1, t, 'related', 'wikilink', now(), now() FROM unnest($2::text[]) AS t
         ON CONFLICT (from_name, to_name, relation) DO NOTHING`,
        [fromName, toNames]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 한 지식의 본문 → origin='wikilink' 엣지 수렴. 미매칭 name 은 경고로 돌려준다(저장은 막지 않는다 — #907 목표2). */
export async function materializeWikiLinks(name: string, bodyMd: string): Promise<WikiLinkResult> {
  const targets = extractWikiLinkTargets(bodyMd ?? "");
  // exact·slug 후보를 한 번에 조회(문서당 쿼리 1회). 링크가 없어도 재작성은 돈다 — 본문에서 지운 엣지를 떼야 하니까.
  const cands = [...new Set(targets.flatMap((t) => [t, slugify(t)]))];
  const rows = cands.length ? await q(itemsPool, `SELECT name FROM knowledge WHERE name = ANY($1)`, [cands]) : [];
  const res = resolveWikiLinkTargets(name, targets, new Set(rows.map((r) => String((r as { name: string }).name))));
  await rewriteWikiLinkEdges(name, res.linked);
  return res;
}

/** upsert 경로용 — 실패해도 저장을 되돌리지 않는다(행은 이미 커밋됐다. 스윕이 수렴시킨다).
 *  embedKnowledgeBestEffort 와 같은 급의 파생 상태 갱신이다. */
async function materializeWikiLinksBestEffort(name: string, bodyMd: string): Promise<WikiLinkResult | undefined> {
  try {
    return await materializeWikiLinks(name, bodyMd);
  } catch (e) {
    console.warn(`[wikilink] '${name}' 자동 엣지 실패(best-effort, 스윕으로 보강): ${(e as Error)?.message}`);
    return undefined;
  }
}

/** #907 백필·유지보수 스윕 — 전 지식 본문의 [[…]] 를 전수 재계산해 origin='wikilink' 엣지를 수렴시킨다.
 *  materializeNotionLinks 와 같은 수렴형(매번 전체 재작성 → 재실행·부분실행 안전):
 *   · 붕 뜬 링크의 대상이 나중에 생기면 다음 스윕이 자동으로 엣지를 만든다(그래서 유지보수 잡이 필요하다).
 *   · 단건 경로와 달리 name 집합을 한 번만 읽어 메모리에서 해소한다(문서당 쿼리 0). */
export async function sweepWikiLinks(): Promise<{ docs: number; scanned: number; edges: number; dangling: { name: string; targets: string[] }[] }> {
  const all = await q(itemsPool, `SELECT name, body_md FROM knowledge`);
  const existing = new Set(all.map((r) => String((r as { name: string }).name)));
  const froms: string[] = [], tos: string[] = [];
  const dangling: { name: string; targets: string[] }[] = [];
  let docs = 0;
  for (const row of all) {
    const name = String((row as { name: string }).name);
    const targets = extractWikiLinkTargets(String((row as { body_md?: string }).body_md ?? ""));
    if (!targets.length) continue;
    docs++;
    const { linked, unmatched } = resolveWikiLinkTargets(name, targets, existing);
    for (const to of linked) { froms.push(name); tos.push(to); }
    if (unmatched.length) dangling.push({ name, targets: unmatched });
  }
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM knowledge_link WHERE origin='wikilink'`);
    if (froms.length) {
      await client.query(
        `INSERT INTO knowledge_link(from_name, to_name, relation, origin, created_at, updated_at)
         SELECT f, t, 'related', 'wikilink', now(), now() FROM unnest($1::text[], $2::text[]) AS x(f, t)
         ON CONFLICT (from_name, to_name, relation) DO NOTHING`,
        [froms, tos]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { docs, scanned: all.length, edges: froms.length, dangling };
}

// 지식→자료 인용(knowledge_source). relation=derived_from(증류)|cites(참조).
export async function linkKnowledgeSource(name: string, sourceId: number, relation = "derived_from", ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `INSERT INTO knowledge_source(name, source_id, relation, created_at)
     VALUES($1,$2,$3,now()) ON CONFLICT (name, source_id, relation) DO NOTHING`,
    [name, sourceId, relation]);
  await auditKnowledge(name, "link_source", null, { source_id: sourceId, relation }, ctx);
}
export async function unlinkKnowledgeSource(name: string, sourceId: number, relation: string, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(`DELETE FROM knowledge_source WHERE name=$1 AND source_id=$2 AND relation=$3`, [name, sourceId, relation]);
  await auditKnowledge(name, "unlink_source", { source_id: sourceId, relation }, null, ctx);
}

// #290 그래프뷰 데이터 — 활성 지식 노드(+단일 카테고리·type) + 모든 지식↔지식 엣지. UI 전용(REST). cap 으로 과대그래프 방지.
//  단일 카테고리 정책이라 노드당 카테고리 1개(LIMIT 1 은 이행기 다중 잔존 대비 안전장치).
export async function knowledgeGraphData(limit = 500): Promise<{ nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }> {
  const nodes = await q(itemsPool,
    `SELECT k.name, k.title, k.type, k.injection, k.provenance,
            cat.key AS category, cat.name AS category_name, cat.space AS space
     FROM knowledge k
     LEFT JOIN LATERAL (
       SELECT c.key, c.name, c.space FROM knowledge_category kc JOIN category c ON c.id=kc.category_id
       WHERE kc.name=k.name AND kc.state<>'rejected' ORDER BY kc.created_at LIMIT 1
     ) cat ON true
     WHERE k.lifecycle='active' ORDER BY k.updated_at DESC LIMIT $1`, [Math.min(limit, 2000)]);
  const edges = await q(itemsPool, `SELECT from_name, to_name, relation FROM knowledge_link`);
  // #551 페이지 트리 위계 엣지(parent_name) — relation='child'(자식→부모). 아틀라스가 트리+링크를 함께 표현.
  const hierarchy = await q(itemsPool,
    `SELECT k.name AS from_name, k.parent_name AS to_name, 'child' AS relation
     FROM knowledge k JOIN knowledge p ON p.name = k.parent_name
     WHERE k.lifecycle='active' AND p.lifecycle='active'`);
  // 엣지를 노드 캡과 조인 — 캡 밖 노드로의 유령 엣지 제거 + 대량 미러에서 응답 비대 방지(#551 리뷰).
  const inGraph = new Set(nodes.map((n) => String((n as { name?: unknown }).name)));
  const scoped = [...edges, ...hierarchy].filter(
    (e) => inGraph.has(String((e as { from_name?: unknown }).from_name)) && inGraph.has(String((e as { to_name?: unknown }).to_name)));
  return { nodes, edges: scoped };
}
