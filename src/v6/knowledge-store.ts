// v6 knowledge 데이터 접근 — 구 knowledge_unit 대체(kind 폐기 → injection/provenance 직교축).
//  injection=always(규칙·페르소나, 항상 주입) | recalled(검색 소환). provenance=authored | observed(외부 미러).
//  knowledge_category(n:n)로 카테고리 매핑. 감사 org_content_audit(entity='knowledge'). 갱신 시 version+1.
//  검색(grep·하이브리드·유사·추천)은 knowledge-search.ts, 링크·위키링크·그래프는 knowledge-links.ts 로 분리(#1313 R21).
//  둘 다 아래에서 **재수출**한다 — 이 모듈이 지식 표면의 배럴이라 기존 호출부(40+)는 무수정이다.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { restoreSnapshot, type WriteCtx } from "./content-audit.js";
import { embeddingInputText } from "./embedding-provider.js";
// 쓰기 경로 임베딩 비동기화(#1053) — 저장 시 인라인 임베딩 대신 pending 마킹 후 백그라운드 스윕에 위임.
import { markEmbeddingPending, KNOWLEDGE_TARGET } from "./embedding-backfill.js";
// 검색 공용 유틸(#631 분리) — grep 매처를 목록 필터(knowledgeListFilter)가 knowledge_grep 과 같은 의미로 쓴다.
import { parseGrep, grepWhere } from "./search-util.js";
import { visibleListIds, projectRowListId, PUBLIC_VIEWER, type Viewer } from "./visibility.js";
// 공용 프리미티브(#1313 R21) — 검색·링크와 함께 쓰는 슬러그·감사·가시성 술어·아이콘 표현식.
import { knowledgeVisWhere, slugify, auditKnowledge, K_ICON_EXPR } from "./knowledge-common.js";
import { listKnowledgeLinks, materializeWikiLinksBestEffort, type WikiLinkResult } from "./knowledge-links.js";

// PUBLIC_VIEWER 는 Viewer 개념이라 visibility.ts 로 옮겼다(#1291) — 여기 두면 상수 하나 때문에
//  터미널·커넥터 같은 hot 모듈이 지식 스토어 전체를 끌어온다. 기존 import 경로는 아래 재export 로 유지.
export { PUBLIC_VIEWER } from "./visibility.js";
// 같은 이유로 슬러그·가시성 술어는 knowledge-common.ts(#1313 R21) — 기존 import 경로는 이 재수출로 유지.
export { slugify, knowledgeVisWhere } from "./knowledge-common.js";
// 검색(#1313 R21) — 구현은 knowledge-search.ts. 표면은 종전 그대로.
export {
  countKnowledgeGrep, searchKnowledge, hybridSearchKnowledge, findSimilarKnowledge, findRecommendedKnowledge,
} from "./knowledge-search.js";
export type {
  KnowledgeSearchRow, KnowledgeGrepMode, KnowledgeSimilarRow, KnowledgeRecommendRow,
} from "./knowledge-search.js";
// 링크·위키링크·그래프(#1313 R21) — 구현은 knowledge-links.ts. 표면은 종전 그대로.
export {
  linkKnowledge, unlinkKnowledge, listKnowledgeLinks, resolveWikiLinkTargets, materializeWikiLinks,
  sweepWikiLinks, linkKnowledgeSource, unlinkKnowledgeSource, knowledgeGraphData,
} from "./knowledge-links.js";
export type { KnowledgeLinkRow, WikiLinkResult } from "./knowledge-links.js";

// is_folder(#592) 포함 — 목록·트리가 폴더 행을 구분해야 해서 K_COLS 에 둔다(boolean 1개 = 가볍다).
//  props_ui(#592)는 fields 와 같은 취급 — 목록엔 무겁고 상세엔 필수라 getKnowledge 에서만 SELECT.
// visibility(#1291) — **복원이 잠금을 되살리려면 스냅샷에 들어 있어야 한다.** restoreSnapshot 은 K_COLS 에
//  있는 키만 INSERT 하므로, 여기 없으면 삭제된 members 지식이 복원될 때 DDL 기본값(open)으로 풀린다
//  (grant 테이블은 CASCADE 로 이미 비어 있어 되돌릴 근거도 함께 사라진다).
const K_COLS =
  `name, title, body_md, injection, provenance, lifecycle, supersedes, confidence, source,
   external_system, external_instance, external_id, external_url, occurred_at, last_synced_at,
   as_of, parent_name, summary, author, source_ref, sort, is_wiki, type, is_folder, visibility, version, created_at, updated_at, updated_by`;
const K_SEL = K_COLS.split(",").map((c) => "k." + c.trim()).join(", ");
// 목록 전용 경량 SELECT(#1091) — body_md 만 뺀다. 사이드바 트리·검색·홈 카드 보강은 본문을 한 글자도 안 쓰는데,
//  전량(수백 건 × 평균 8KB)을 실어 나르고 있었다(위키 홈 첫 화면 ~4MB). 발췌(deck)를 그리는 화면만 full 을 쓴다.
const K_SEL_LIGHT = K_COLS.split(",").map((c) => c.trim()).filter((c) => c !== "body_md").map((c) => "k." + c).join(", ");

export interface KnowledgeRow {
  name: string; title: string | null; body_md: string;
  injection: string; provenance: string; lifecycle: string;
  confidence: string; source: string; summary: string | null;
  sort: number; is_wiki: boolean; is_folder: boolean; version: number; updated_at: string;
  [k: string]: unknown;
}

// activeEmbeddingProvider 는 search-util.ts 로 이동(#631, project 스토어와 공유).
// 쓰기 경로 임베딩은 #1053 에서 비동기로 분리 — upsert 는 pending 마킹(markEmbeddingPending)만 하고 백그라운드
//  스윕이 채운다. 옛 동기 embedKnowledgeBestEffort(인라인 provider.embed HTTP)는 제거(저장 지연의 원인이었음).

export interface KnowledgeFilter {
  space?: string; categoryId?: number; uncategorized?: boolean; injection?: string; provenance?: string;
  lifecycle?: string; q?: string; limit?: number; offset?: number; orderBy?: string; is_wiki?: boolean; type?: string;
  light?: boolean;   // #1091 본문(body_md) 제외 — 트리·검색·카드 보강처럼 발췌를 안 그리는 소비자용
}

// listKnowledge / countKnowledge 공유 필터 — JOIN·WHERE·params 를 한 곳에서 조립(목록과 총계가 항상 같은 조건).
//  export = 단위 테스트용(순수 문자열 조립) — 미분류 축(#1091)이 조용히 무력화되면 '전체가 다 나오는' 오답이
//  에러 없이 나오므로(빈 필터 = no-op) 테스트로 잠근다. knowledge-store.test.ts 참조.
export function knowledgeListFilter(f: KnowledgeFilter): { join: string; where: string; params: unknown[] } {
  const params: unknown[] = [];
  let join = "";
  // 미분류(#1091) — 어느 카테고리에도 안 뜨는 지식. categoryId/space 와 배타(그건 '어느 카테고리냐'를 묻는 축이다).
  const uncategorized = !!f.uncategorized && f.categoryId == null;
  // 카테고리/스페이스 필터 = knowledge_category 조인(rejected 매핑 제외).
  if (f.categoryId != null) {
    params.push(f.categoryId);
    join = `JOIN knowledge_category kc ON kc.name=k.name AND kc.category_id=$${params.length} AND kc.state<>'rejected'`;
  } else if (f.space && !uncategorized) {
    params.push(f.space);
    join = `JOIN knowledge_category kc ON kc.name=k.name AND kc.state<>'rejected'
            JOIN category c ON c.id=kc.category_id AND c.space=$${params.length}`;
  }
  const wh: string[] = [];
  // 기준은 소비쿼리와 같은 state<>'rejected' — knowledge_unmapped('빈 자리인가' = NOT EXISTS any)와 다르다.
  //  rejected 매핑만 남은 지식은 어느 카테고리 목록에도 안 뜨므로 사람 눈엔 미분류다(사이드바가 보여줘야 할 대상).
  if (uncategorized) wh.push(`NOT EXISTS (SELECT 1 FROM knowledge_category kcu WHERE kcu.name=k.name AND kcu.state<>'rejected')`);
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
  //  ⚠ **name(=key)도 본다**(2026-08-25 상민님 신고: "지식 key 로 검색하면 안 뜬다"). 종전엔 title·body_md 만 봐서,
  //   key 로 찾으면 **그 key 를 본문에 인용한 다른 문서**만 나오고 정작 그 문서는 안 나왔다(실측:
  //   `omni-unified-search-spotlight-1835` → 그 위키링크를 담은 다른 지식 1건). key 는 사람이 실제로 옮겨 적는 이름이다
  //   (위키링크 `[[key]]`·URL `#/k/<key>`·에이전트의 knowledge_get 인자) — 그걸로 못 찾는 검색은 반쪽이다.
  if (f.q) wh.push(grepWhere(["k.name", "k.title", "k.body_md"], parseGrep(f.q), params));  // grep 매처(regex|토큰 AND) — knowledge_grep 과 동일 의미
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

export async function listKnowledge(f: KnowledgeFilter = {}, viewer?: Viewer): Promise<KnowledgeRow[]> {
  const { join, where, params } = knowledgeListFilter(f);
  // 공개범위(#1291) — 필터 파라미터 뒤·페이지 파라미터 앞에 넣는다(limit/offset 은 문자열 끝에서 자리번호를 참조한다).
  const vis = await knowledgeVisWhere(viewer, params);
  // updated_at 동률에 k.name 타이브레이커(#1091) — 미러 인입분은 updated_at 이 날짜 단위로 뭉쳐 동률이 흔한데,
  //  전순서가 없으면 LIMIT/OFFSET 페이지 경계에서 같은 행이 중복되거나 빠진다(#709 페이지네이션의 전제).
  const order = f.orderBy === "name" ? "k.name" : "k.updated_at DESC, k.name";
  const { limit, offset } = knowledgePage(f);
  params.push(limit); const limP = `$${params.length}`;
  params.push(offset); const offP = `$${params.length}`;
  // icon/cover(#657, props_ui) — 목록 행 아이콘·갤러리 카드 커버용 얕은 노출(전체 props_ui 는 상세 전용 유지).
  // category_key/name(#783) — 목록 행에 소속 도메인 표시(검토 큐가 도메인별로 묶고, 에이전트도 목록에서 분류를 본다).
  //  단일 카테고리 정책(#290)이라 LATERAL LIMIT 1 — 행 증식 없음(DISTINCT 와도 무해).
  return q(itemsPool,
    `SELECT DISTINCT ${f.light ? K_SEL_LIGHT : K_SEL}, ${K_ICON_EXPR}, k.props_ui->>'cover' AS cover,
            cat.key AS category_key, cat.name AS category_name
     FROM knowledge k ${join}
     LEFT JOIN LATERAL (
       SELECT cc.key, cc.name FROM knowledge_category kc2 JOIN category cc ON cc.id=kc2.category_id
        WHERE kc2.name=k.name AND kc2.state<>'rejected' ORDER BY kc2.category_id LIMIT 1
     ) cat ON true
     ${where} AND ${vis} ORDER BY ${order} LIMIT ${limP} OFFSET ${offP}`, params);
}

// #709 총계 — 같은 필터의 전체 건수(페이징 메타 total/has_more 용). 목록의 DISTINCT 와 일치하도록 count(DISTINCT k.name).
//  총계도 같은 viewer 로 센다 — 목록만 걸러 놓고 total 을 전체로 주면 '보이지 않는 N 건이 있다'가 그대로 새고
//  has_more 가 영원히 true 인 페이지네이션이 된다.
export async function countKnowledge(f: KnowledgeFilter = {}, viewer?: Viewer): Promise<number> {
  const { join, where, params } = knowledgeListFilter(f);
  const vis = await knowledgeVisWhere(viewer, params);
  const row = await one(itemsPool,
    `SELECT count(DISTINCT k.name)::int AS n FROM knowledge k ${join} ${where} AND ${vis}`, params);
  return Number((row as { n?: number } | undefined)?.n ?? 0);
}

// 조직에 대상 제한(visibility='members') 지식이 하나라도 있나(#1291) — 목록 필터의 단축 판정용.
//  대부분의 조직은 0건이라 이 한 번의 물음으로 행마다 판정하는 비용을 통째로 건너뛴다.
//  캐시·실패 시 폴백(닫는 쪽)은 호출부 몫 — 여기는 사실만 답한다.
export async function anyRestrictedKnowledge(): Promise<boolean> {
  const rows = await q(itemsPool, `SELECT 1 FROM knowledge WHERE visibility='members' LIMIT 1`, []);
  return rows.length > 0;
}

// ── #1247 WIKI 인덱스 핀 전량 — 매 세션 주입되는 인덱스(${wiki})의 단일 소스. ──
//  is_wiki 를 **DB WHERE 에서** 걸러 LIMIT 을 그 결과에만 건다. 구 렌더 경로는 순서가 반대였다 —
//  일반 목록 500건(updated_at DESC)을 먼저 뽑고 메모리에서 is_wiki 를 걸렀다. 그래서 활성 지식이 500건을
//  넘는 조직에선 그 창 밖의 핀이 인덱스에서 **조용히** 사라졌다(고객사 A 실박스 2026-07-29 실측: 활성
//  1,173건 · 창 커트라인 07-24 → 핀 3건 중 1건만 주입. 라이블리 dev: 활성 589건 → 10건 중 9건).
//  창에 남는 기준이 '최근 수정'이라 커넥터 미러 싱크마다 인덱스 구성이 바뀌는 비결정성도 함께 사라진다.
//  핀은 원래 소수지만 '조용한 절단'이 이 버그의 본질이라 페이지를 끝까지 순회한다(방어 상한 10k).
//  light — 인덱스는 소환키·제목만 쓰므로 본문(body_md) 미조회. lister 는 테스트 주입 seam(기본 listKnowledge).
//  viewer(#1291)는 **필수 인자**다 — 이 인덱스는 매 세션 통째로 주입되는 자리라, 인자를 생략할 수 있게 두면
//   호출부 한 곳만 놓쳐도 잠긴 지식의 소환키·제목이 전 조직 세션 첫머리로 새고 그 사실이 어디에도 안 드러난다.
//   조직 전체 배포물(정적 context·발행 번들)은 PUBLIC_VIEWER 를, 특권 내부 경로는 null 을 **명시**해서 넘겨라.
export async function listWikiPins(
  viewer: Viewer,
  lister: (f: KnowledgeFilter) => Promise<KnowledgeRow[]> = (f) => listKnowledge(f, viewer),
): Promise<KnowledgeRow[]> {
  const PAGE = 500;                       // knowledgePage 상한과 동일 — 이보다 크게 줘도 클램프된다
  const out: KnowledgeRow[] = [];
  // orderBy=name — 페이지 경계가 흔들리지 않는 전순서(updated_at 은 미러 인입분이 동률로 뭉친다).
  //  표시 순서는 buildWikiBlock 이 sort,name 으로 다시 잡으므로 여기선 안정성만 본다.
  for (let offset = 0; offset <= 10_000; offset += PAGE) {
    const page = await lister({ is_wiki: true, lifecycle: "active", limit: PAGE, offset, light: true, orderBy: "name" });
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

export async function getKnowledge(name: string, viewer?: Viewer): Promise<(KnowledgeRow & { categories: unknown[]; links?: unknown; sources?: unknown[] }) | undefined> {
  // fields 는 목록(K_COLS)엔 무겁고 상세엔 필수(#551 노션 속성 패널) — 상세 조회에서만 포함.
  //  props_ui(#592 항목 단위 속성 노출 오버라이드)도 fields 와 같은 취급(상세 전용).
  const k = await one(itemsPool, `SELECT ${K_SEL}, k.fields, k.props_ui FROM knowledge k WHERE k.name=$1`, [name]);
  if (!k) return undefined;
  const categories = await q(itemsPool,
    `SELECT kc.category_id, kc.state, c.space, c.key, c.name
     FROM knowledge_category kc JOIN category c ON c.id=kc.category_id WHERE kc.name=$1`, [name]);
  const links = await listKnowledgeLinks(name, viewer);      // #290 지식↔지식(outgoing + 백링크). viewer: 안 보이는 이웃은 뺀다(#1291)
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
//  viewer(#1291): 트리는 제목·계층을 그대로 그리는 표면이라(사이드바) 안 보이는 문서는 노드 자체를 뺀다.
//   자식만 빠지고 부모가 남는 조합이 생길 수 있는데(부모 open·자식 members), 그건 정상이다 — 트리는 부모가
//   없는 노드를 루트로 접어 그린다(클라이언트 조립). 별칭을 k 로 두는 건 knowledgeVisWhere 규약이다.
export async function knowledgeTreeData(system: string, limit = 20000, viewer?: Viewer): Promise<Record<string, unknown>[]> {
  const cap = Math.min(limit, 50000);
  if (system === "authored") {
    const params: unknown[] = [cap];
    const vis = await knowledgeVisWhere(viewer, params);
    return q(itemsPool,
      `SELECT k.name, k.title, k.parent_name, k.sort, k.lifecycle, k.is_folder, k.updated_at,
              k.props_ui->>'icon' AS icon
       FROM knowledge k WHERE k.external_system IS NULL AND k.lifecycle <> 'superseded' AND ${vis}
       ORDER BY k.parent_name NULLS FIRST, k.sort, k.title NULLS LAST, k.name
       LIMIT $1`, params);
  }
  const params: unknown[] = [system, cap];
  const vis = await knowledgeVisWhere(viewer, params);
  return q(itemsPool,
    `SELECT k.name, k.title, k.parent_name, k.sort, k.lifecycle, k.external_id, k.external_url, k.updated_at,
            k.props_ui->>'icon' AS icon,
            k.fields->'notion'->>'kind' AS kind
     FROM knowledge k WHERE k.external_system=$1 AND k.lifecycle <> 'superseded' AND ${vis}
     ORDER BY k.parent_name NULLS FIRST, k.sort, k.title NULLS LAST, k.name
     LIMIT $2`, params);
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

/** #1531 edit 모드 — 본문 일부만 정확일치로 갈아끼운다. */
export interface KnowledgeEdit {
  /** 바꿀 기존 텍스트 — 본문에 **정확히 한 번** 있어야 한다(replace_all 이면 여러 번 허용). */
  old: string;
  /** 그 자리에 넣을 텍스트. 빈 문자열이면 삭제. */
  new: string;
  /** 같은 텍스트가 여러 곳에 있고 전부 바꿔야 할 때만 true. */
  replace_all?: boolean;
}

/**
 * #1531 본문 부분 편집 — 전문을 되보내지 않고 바뀌는 조각만 갈아끼운다.
 *
 * 왜 필요한가: append 는 **문서 끝**에만 붙는다. 그런데 실제 갱신은 문서 중간에서 일어난다 —
 * 타임라인 중간에 이번 달을 끼우고, '열린 이슈'의 낡은 항목을 고치고, 표의 수치를 바꾸는 식이다.
 * 그 경우 유일한 수단이 replace(전문 교체)인데, 그러면 **에이전트가 4만 자를 통째로 받아쓰게 된다.**
 * 토큰도 토큰이지만 전사 과정에서 **손대지 말아야 할 문장이 깨진다** — 어니스트 실측에서 40K자 문서를
 * 갱신하다 무관한 문장의 쉼표가 여는 괄호로 바뀌어 괄호가 닫히지 않았다(#1531).
 * 손상 확률이 문서 크기에 비례하는 구조라, 문서가 자랄수록 갱신이 위험해진다.
 *
 * 계약(Claude Code 의 Edit 도구와 동형):
 *  · `old` 는 **정확일치**. 못 찾으면 조용히 넘어가지 않고 던진다 — 조용한 무시는 "저장했는데 안 바뀐"
 *    최악의 실패다(호출자는 본문을 안 읽으므로 영영 모른다).
 *  · 여러 번 나오면 **모호**하므로 던진다(replace_all 로 의도를 밝히면 전부 교체).
 *  · 편집은 **순차 적용** — 앞 편집의 결과 위에 다음 편집이 얹힌다. 앞 편집이 뒤 앵커를 지웠다면
 *    '못 찾음'으로 드러난다(그것도 조용한 실패보다 낫다).
 *  · 건드리지 않은 부분은 **문자 단위로 그대로다** — 이 모드의 존재 이유다.
 */
export function applyKnowledgeEdits(base: string, edits: KnowledgeEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("edits 가 비었습니다 — 무엇을 바꿀지 지정하세요.");
  }
  let out = String(base ?? "");
  edits.forEach((e, i) => {
    const at = `edits[${i}]`;
    const oldText = String(e?.old ?? "");
    const newText = String(e?.new ?? "");
    if (!oldText) throw new Error(`${at}.old 가 비었습니다 — 바꿀 기존 텍스트를 지정하세요(본문 끝에 덧붙이려면 mode='append').`);
    if (oldText === newText) throw new Error(`${at}: old 와 new 가 같습니다 — 바뀌는 것이 없습니다.`);
    // 출현 횟수 — indexOf 루프로 센다(정규식 이스케이프 이슈 없음).
    let count = 0;
    for (let p = out.indexOf(oldText); p !== -1; p = out.indexOf(oldText, p + oldText.length)) count++;
    if (count === 0) {
      const head = oldText.slice(0, 60).replace(/\n/g, "⏎");
      throw new Error(`${at}: 본문에서 찾지 못했습니다 — "${head}${oldText.length > 60 ? "…" : ""}". 공백·줄바꿈까지 원문 그대로여야 합니다(지식을 다시 읽어 확인하세요).`);
    }
    if (count > 1 && !e.replace_all) {
      const head = oldText.slice(0, 60).replace(/\n/g, "⏎");
      throw new Error(`${at}: 본문에 ${count}곳 있어 어디를 바꿀지 모호합니다 — "${head}${oldText.length > 60 ? "…" : ""}". 앞뒤를 더 붙여 유일하게 만들거나, 전부 바꾸려면 replace_all: true 로 명시하세요.`);
    }
    out = e.replace_all ? out.split(oldText).join(newText) : out.replace(oldText, newText);
  });
  return out;
}

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
     ON CONFLICT (tenant_id, name) DO UPDATE SET
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
  // 벡터검색(#172)을 쓰기 경로에서 분리(#1053) — 저장은 즉시 반환하고, 임베딩은 백그라운드 스윕이 배치로 채운다.
  //  신규 행은 embedding_vector 가 NULL(=pending)이라 그대로 스윕 대상. 수정은 임베딩 입력 텍스트(제목+요약+본문)가
  //  '실제로 바뀐' 경우에만 벡터를 비워 pending 으로 되돌린다 — 무변경·facet-only(is_wiki·sort 등) 재저장엔 헛임베딩·
  //  검색 공백이 없다(project-store updateProject/updateTask 의 before↔after 텍스트 비교 가드와 동형).
  const newEmbedText = embeddingInputText({ title: input.title ?? (after?.title as string | null), summary, body_md: input.body_md });
  const oldEmbedText = before
    ? embeddingInputText({ title: before.title as string | null, summary: before.summary as string | null, body_md: before.body_md as string | null })
    : "";
  if (newEmbedText && (!before || newEmbedText !== oldEmbedText)) await markEmbeddingPending(KNOWLEDGE_TARGET, name);
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

// 제목만 갱신(#1442) — 본문 불변. `knowledge_save` 는 body_md 가 필수라 제목 한 줄을 고치려면 전문을
//  되보내야 했는데, 그건 소프트캡이 없애려던 바로 그 재전송이다(제목이 잘렸다고 알려주면서 고치는 길은
//  전문 재전송뿐인 모순). 그래서 제목만 바꾸는 경로를 둔다.
//  ⚠ is_wiki·props_ui 같은 '뷰 설정'과 **다른 클래스**다 — title 은 사람이 읽고 검색·주입에 나가는 내용이라
//   upsertKnowledge 와 동형으로 version+1·updated_at 을 올린다.
//  ⚠ 임베딩 재계산을 반드시 예약한다: embeddingInputText 의 첫 파트가 title 이라(embedding-provider.ts)
//   이걸 빠뜨리면 제목을 바꿔도 벡터는 옛 제목으로 남아 의미검색이 조용히 어긋난다(upsert 경로와 같은 규율).
export async function setKnowledgeTitle(name: string, title: string, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!before) throw new Error(`지식 '${name}' 없음`);
  const after = await one(itemsPool,
    `UPDATE knowledge SET title=$2, version=version+1, updated_at=now(), updated_by=$3
      WHERE name=$1 RETURNING ${K_COLS}`, [name, title, ctx?.actor ?? null]);
  await auditKnowledge(name, "set_title", before, after, ctx);
  if ((before as { title?: string | null }).title !== title) await markEmbeddingPending(KNOWLEDGE_TARGET, name);
  return after as KnowledgeRow;
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

// ════════ 세션 산출물 스탬핑(#1291 v2) — 잠긴 프로젝트에서 만든 지식은 그 프로젝트를 보는 사람만 본다. ════════
//  왜 필요한가: 가시성의 목적(R1)은 "사람도 그 사람의 AI 도 못 본다"인데, **AI 가 맥락의 주 생산자**다.
//   비공개 프로젝트 세션에서 AI 가 요약·결정을 지식으로 남기는 순간 그 내용이 전 조직 공개가 되면,
//   프로젝트를 잠근 의미가 산출물 쪽으로 통째로 새어나간다(잠금은 입구만 막고 출구는 열려 있는 꼴).
//  왜 grant(컨테이너 참조)인가: 멤버를 그 시점 명단으로 굳혀두면 리스트에서 빠진 사람이 과거 지식을 계속 보고,
//   나중에 합류한 사람은 못 본다(스냅샷 부패). 리스트를 가리키면 명단 변경이 그대로 따라온다.
//  ⚠ **열린 리스트면 스탬프하지 않는다** — 안 그러면 평범한 프로젝트 세션이 만든 지식이 전부 'members' 로 잠겨
//   조직의 위키가 조용히 사유화된다(비파괴 불변식 위반). '잠겼나'는 리스트 컬럼을 직접 보지 않고
//   **아무 grant 도 없는 사람(PUBLIC_VIEWER)에게 그 리스트가 보이나** 로 판정한다 — 스페이스 상속(폴더 체인)까지
//   자동으로 반영되고, 상속 규칙 사본을 여기 또 만들지 않는다.
//  실패는 비치명(open 유지): 세션↔프로젝트 바인딩은 부가 정보라, 못 찾았다고 저장을 깨뜨리지 않는다.
export async function stampSessionVisibility(name: string, sessionId?: string | null, ctx?: WriteCtx): Promise<number | null> {
  if (!name || !sessionId) return null;
  try {
    // 세션→프로젝트는 session_project(타임라인 귀속과 같은 소스)로 본다. 바인딩이 없으면 프로젝트 세션이 아니다.
    const { latestProjectForSession } = await import("./project-store.js");
    const proj = await latestProjectForSession(String(sessionId));
    if (!proj) return null;
    const listId = await projectRowListId(proj.id);
    if (listId == null) return null;                       // 미분류 프로젝트 = 전원 열람 = 잠금 아님
    const openIds = await visibleListIds(PUBLIC_VIEWER);
    if (openIds === null || openIds.has(listId)) return null;   // 열린 리스트 — 종전대로 open
    await itemsPool.query(
      `INSERT INTO knowledge_list_grant(name, list_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [name, listId]);
    await itemsPool.query(`UPDATE knowledge SET visibility='members' WHERE name=$1`, [name]);
    // #1561 감사 — 접근통제 이력. 사람이 아무것도 누르지 않았는데 문서가 잠기는 자리라 흔적이 있어야 한다.
    //  ⚠ 실패를 여기서 따로 삼킨다: 잠금은 **이미 적용됐으므로** 아래 catch 의 '공개 상태 유지' 문구가
    //   거짓이 되고, 감사가 안 됐다고 잠금을 되돌리면 그게 곧 유출이다(안전 방향은 잠긴 채로 두는 것).
    await auditKnowledge(name, "set_visibility",
      { name, visibility: "open" },
      { name, visibility: "members", via_project_list: listId }, ctx)
      .catch((e) => console.warn(`[visibility] '${name}' 잠금 감사 실패(잠금은 적용됨): ${(e as Error)?.message}`));
    return listId;
  } catch (e) {
    console.warn(`[visibility] '${name}' 세션 스탬핑 실패(공개 상태 유지): ${(e as Error)?.message}`);
    return null;
  }
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

// ⚠ replace 시맨틱 — 이 함수는 '추가'가 아니라 '교체'다(#290 단일 카테고리).
//  #1563: 그래서 **지우기 전에 기존 매핑을 읽어 before 에 싣는다.** 안 읽으면 감사에 '무엇에서 무엇으로'가
//   없어 두 곳이 동시에 반쪽이 된다 — 이력 화면은 분류 변경을 '분류 지정'이라고만 쓸 수 있고,
//   Cmd+Z(#702)는 아예 이 op 을 되돌릴 수 없다(그 한계 때문에 undo 행렬에서 제외돼 있었다).
export async function linkKnowledgeCategory(name: string, categoryId: number, state = "confirmed", ctx?: WriteCtx): Promise<void> {
  // single_uq 로 name 당 1행이지만 ORDER BY 로 결정적으로 고른다(이행기 다중 잔존 대비 — 비결정 스냅샷은 되돌리기를 복불복으로 만든다).
  const prev = await one(itemsPool,
    `SELECT category_id, state, mapped_by FROM knowledge_category WHERE name=$1 ORDER BY category_id LIMIT 1`,
    [name]) as { category_id: number; state: string; mapped_by: string } | undefined;
  // #290 단일 카테고리: 기존 다른 카테고리 매핑을 먼저 제거(replace) — knowledge_category_single_uq 와 정합(앱이 단일 강제, 인덱스 위반 대신 교체).
  await itemsPool.query(`DELETE FROM knowledge_category WHERE name=$1 AND category_id<>$2`, [name, categoryId]);
  await itemsPool.query(
    `INSERT INTO knowledge_category(name, category_id, mapped_by, state, created_at)
     VALUES($1,$2,'manual',$3,now())
     ON CONFLICT (name, category_id) DO UPDATE SET state=EXCLUDED.state`,
    [name, categoryId, state]);
  // 무변경 재링크(같은 분류·같은 state 를 다시 누름)는 감사하지 않는다 — 실측상 지식 감사행의 절반 가까이가
  //  link_category 였고(200행 표본 중 93건), 그 잡음이 정확히 '누가 본문을 고쳤나'를 덮는 것이었다.
  //  판정 기준은 이력 화면의 무변경 update 판정(UPDATE_CHANGED_SQL)과 같다: 실제로 뭔가 달라졌을 때만 남긴다.
  if (prev && Number(prev.category_id) === categoryId && prev.state === state) return;
  await auditKnowledge(name, "link_category",
    prev ? { category_id: Number(prev.category_id), state: prev.state, mapped_by: prev.mapped_by } : null,
    { category_id: categoryId, state }, ctx);
}

export async function unlinkKnowledgeCategory(name: string, categoryId: number, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(`DELETE FROM knowledge_category WHERE name=$1 AND category_id=$2`, [name, categoryId]);
  await auditKnowledge(name, "unlink_category", { category_id: categoryId }, null, ctx);
}

// ── 미분류 지식 인박스(#982) — 카테고리 행이 하나도 없는 active 지식. 분류기(classify_knowledge)가 여기서 드레인. ──
//  list_unmapped(코드유닛)의 지식판. 포인터만(본문 X). 커넥터 미러는 카테고리를 안 써서(connector-mirror 보존규칙) 여기 쌓인다.
//  ⚠ '0행'(NOT EXISTS any) 기준 — knowledge_category_single_uq 가 name 당 1행이라, rejected 1행이라도 있으면 INSERT 가 uq 위반이므로
//   애초에 인박스에서 뺀다(이미 판정된 것 재분류 안 함). 소비쿼리의 state<>'rejected' 와는 다른 기준(그건 '보이나', 이건 '빌 자리인가').
//  viewer(#1291): 분류기 크론은 특권(null)으로 부른다 — 미분류를 못 보면 그 문서는 영원히 분류되지 않는다.
//   사람·에이전트가 인박스를 열 때(capability)는 자기 뷰어로 걸러 안 보이는 문서의 제목이 안 뜨게 한다.
export async function listUnmappedKnowledge(limit = 50, viewer?: Viewer): Promise<Array<{ name: string; title: string | null; type: string | null; provenance: string }>> {
  const lim = Math.min(Math.max(limit, 1), 200);
  const params: unknown[] = [lim];
  const vis = await knowledgeVisWhere(viewer, params);
  const rows = await q(itemsPool, `
    SELECT k.name, k.title, k.type, k.provenance
    FROM knowledge k
    WHERE k.lifecycle='active'
      AND NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name)
      AND ${vis}
    ORDER BY k.updated_at DESC
    LIMIT $1`, params);
  return rows.map((r) => ({ name: r.name as string, title: (r.title ?? null) as string | null, type: (r.type ?? null) as string | null, provenance: r.provenance as string }));
}

export interface ProposedClassification {
  name: string; title: string | null; type: string | null; provenance: string; updated_at: string;
  category_id: number; category_key: string; category_name: string | null; space: string;
  confidence: number | null; evidence: string | null; created_at: string;
}
// ── proposed 분류 검토 인박스(#1102) — 분류기(proposeKnowledgeCategory)가 mapped_by='llm'·state='proposed' 로 건 제안 목록. ──
//  미분류 인박스(listUnmappedKnowledge)의 '다음 단계': 자리는 찼지만 아직 사람 확정 전. confidence 낮은 순(가장 검토 필요한 것 먼저), NULL 최우선.
//  검토 UI(#/knowledge/classifications)가 여기서 읽어 확정(→confirmed)·재분류·반려(unlink). 확정 전이라 recall 소환엔 이미 잡힌다(state<>'rejected').
export async function listProposedClassifications(limit = 200, viewer?: Viewer): Promise<ProposedClassification[]> {
  const lim = Math.min(Math.max(limit, 1), 500);
  const params: unknown[] = [lim];
  const vis = await knowledgeVisWhere(viewer, params);
  const rows = await q(itemsPool, `
    SELECT k.name, k.title, k.type, k.provenance, k.updated_at,
           kc.category_id, kc.confidence, kc.evidence, kc.created_at,
           c.key AS category_key, c.name AS category_name, c.space
    FROM knowledge_category kc
    JOIN knowledge k ON k.name = kc.name AND k.lifecycle='active'
    JOIN category   c ON c.id  = kc.category_id
    WHERE kc.state='proposed' AND kc.mapped_by='llm' AND ${vis}
    ORDER BY kc.confidence ASC NULLS FIRST, kc.created_at DESC
    LIMIT $1`, params);
  return rows.map((r) => ({
    name: r.name as string, title: (r.title ?? null) as string | null, type: (r.type ?? null) as string | null,
    provenance: r.provenance as string, updated_at: String(r.updated_at),
    category_id: Number(r.category_id), category_key: r.category_key as string,
    category_name: (r.category_name ?? null) as string | null, space: r.space as string,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    evidence: (r.evidence ?? null) as string | null, created_at: String(r.created_at),
  }));
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
     ON CONFLICT (tenant_id, name, system, target_id) DO UPDATE SET
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
     ON CONFLICT (tenant_id, name, system, target_id) DO UPDATE SET
       state='failed', last_error=EXCLUDED.last_error, updated_at=now()`,
    [name, system, targetId, err.slice(0, 500)]);
}
