// v6 knowledge capability — 지식 CRUD + lifecycle + 카테고리 연결.
//  레거시 ctx_*/memory_* 와 병행(REST-only 로 시작 — 웹 지식 탭이 소비). MCP 노출은 컷오버에서 일괄.
//  scope='memory'(조직 지식 — ctx_* 와 동일). injection/provenance 는 v6 직교축.
import { z } from "zod";
import { HttpError, clampPage } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listKnowledge, countKnowledge, getKnowledge, upsertKnowledge, setKnowledgeLifecycle, getKnowledgeLifecycle, setKnowledgeWiki, deleteKnowledge,
  linkKnowledgeCategory, unlinkKnowledgeCategory, searchKnowledge, countKnowledgeGrep, hybridSearchKnowledge,
  findSimilarKnowledge, linkKnowledge, unlinkKnowledge, knowledgeGraphData, knowledgeTreeData,
  setKnowledgePropsUi, moveKnowledge, type WikiLinkResult, appendBody, isDuplicateAppend,
} from "../v6/knowledge-store.js";
import { getKnowledgeViewConfig, setKnowledgeViewConfig } from "../v6/view-config-store.js";
import {
  postKnowledgeComment, getKnowledgeCommentFeed, toggleKnowledgeCommentReaction,
} from "../v6/knowledge-comment-store.js";
// #783 인입 허용선 게이트 — 에이전트(MCP) 저작 지식의 자동 검토대기 + 기존 지식 수정 검토 큐.
import { resolveKnowledgeGate } from "../v6/knowledge-gate.js";
import {
  proposeRevision, listRevisions, getRevision, approveRevision, rejectRevision, pendingRevisionFor, pendingStagedRevisionId, reviewQueueCounts,
} from "../v6/knowledge-revision-store.js";
// #802 검토 대기 개인화 — '내 도메인' = 내 팀이 오너인 카테고리(me 의 team_owner_category_ids 와 같은 소스).
import { memberCategories } from "../v6/team-store.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KNOWLEDGE } from "../org/default-content.js";

// 저장-시 중복감지(#172) — 신규 지식이 이 코사인 유사도 이상의 기존 지식과 겹치면 응답에 경고(비차단).
//  bge-m3 코사인 기준 보수적 임계(오탐 억제). 프로젝트 규칙 "새로 만들기 전 비슷한 거 찾기" 의 자동화.
const DEDUP_WARN_SIMILARITY = 0.6;

// 저장 본문 방어 상한 — zod(신규·교체 입력)와 append 결과에 같은 값을 쓴다(불변식 "저장된 본문 ≤ 이 값").
//  append 가 이 상한을 결과에도 걸어야 하는 이유: zod 는 append 에선 '조각'만 재니, 안 걸면 base 199k + chunk 200k 가
//  그대로 저장되고 — 그 문서는 그 순간부터 replace 로도 웹 편집기로도 저장 불가가 된다(되보내면 zod 가 튕김).
//  즉 상한 초과는 문서를 '더 키우는 것 말곤 손댈 수 없는' 상태로 잠그는 one-way door 라 결과에서 막는다.
const BODY_MD_MAX = 200_000;

// ── 시딩 지식 편집 경고(#846) — 고객 박스에 시딩되는 런북을 이 WIKI 에서 고치면, 고객이 받는 본문은
//  여기가 아니라 src/org/seed-knowledge/<name>.md 의 각색 스냅샷이다(#846 이후 분리). 그 파일을 함께
//  갱신하라고 저장 응답으로 알린다(정방향 드리프트 방지). seed 는 이제 DB 캡처가 아니라 파일이 SoT 라
//  자동 동기화되지 않는다 — 사람 리마인더가 유일한 연결고리다.
const SEEDED_KNOWLEDGE_NAMES = new Set(DEFAULT_KNOWLEDGE.map((k) => k.name));
//  경고는 seed 소스가 실재하는 곳(우리 canonical 체크아웃 — src/ 포함)에서만 뜬다. 고객 릴리스 번들엔
//  src/ 가 없으므로(release.yml: dist·public·kit…만 실림) 고객 박스에선 이 경고가 뜨지 않는다 —
//  안 그러면 고객에게 없는 내부 경로를 노출하게 된다(유출 방지하려다 유출하는 역설 회피).
const SEED_SOURCE_PRESENT = fs.existsSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "org", "seed-knowledge"));
function seedSyncWarning(name: string | null | undefined): { seed_warning?: string } {
  if (!SEED_SOURCE_PRESENT || !name || !SEEDED_KNOWLEDGE_NAMES.has(name)) return {};
  return { seed_warning: `⚠ '${name}' 은 신규 고객 게이트웨이에 시딩되는 런북입니다(#713). 고객이 받는 본문은 이 WIKI 가 아니라 src/org/seed-knowledge/${name}.md 의 각색 스냅샷이라 — 이 편집은 고객 박스에 자동 반영되지 않습니다. 절차가 바뀌었다면 그 파일도 갱신하세요(내부 [[링크]]·이슈번호·사내 명칭·타 고객사명은 빼고 고객 맥락으로) → 편집 후 \`node scripts/sync-seed-knowledge.mjs\`. 미갱신 시 고객은 옛 절차를 봅니다.` };
}

// ── #907 본문 [[위키링크]] 자동 엣지 결과 → 응답. 저장은 이미 성공했다 — 미매칭은 **경고**지 실패가 아니다(목표2).
//  링크가 하나도 없으면 아무것도 싣지 않는다(대부분의 저장에 잡음을 더하지 않게).
function wikiLinkInfo(w: WikiLinkResult | undefined): Record<string, unknown> {
  if (!w || (!w.linked.length && !w.unmatched.length)) return {};
  const info: Record<string, unknown> = { wikilinks: { linked: w.linked, unmatched: w.unmatched } };
  if (w.unmatched.length) {
    info.wikilink_warning = `⚠ 본문의 [[링크]] 중 ${w.unmatched.length}건이 실재하지 않는 지식을 가리켜 엣지를 만들지 못했습니다: ${w.unmatched.map((n) => `[[${n}]]`).join(", ")}. 저장은 정상 완료됐습니다 — 오타면 본문을 고치고, 아직 없는 지식이면 그대로 두세요(대상이 생기면 다음 스윕이 자동으로 잇습니다). 문법 예시로 적은 거라면 코드펜스·인라인코드 안에 넣으면 링크로 안 잡힙니다.`;
  }
  return info;
}

const knowledgeList: Capability = {
  name: "knowledge_list",
  title: "지식 목록",
  description: "지식을 space/카테고리/injection/provenance/q(grep 패턴 — knowledge_grep 과 동일 매칭)로 조회(맥락의 기록). is_wiki=true 면 WIKI 인덱스 핀(매 대화 첫머리에 깔리는 인덱스)만. limit(≤500, 기본 200)·offset 으로 페이지네이션 — 응답에 total·has_more 포함(#709).",
  scope: "memory",
  // MCP 필드명 = 핸들러가 읽는 이름(REST 는 query 'category'→categoryId 로 매핑). injection/provenance/lifecycle/orderBy/is_wiki 도 선택.
  input: {
    space: z.string().optional(),
    categoryId: z.number().int().positive().optional(),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    type: z.enum(["decision", "concept", "how-to", "reference", "research", "entity"]).optional(),
    lifecycle: z.enum(["active", "pending", "superseded", "archived"]).optional(),   // archived(#551): 외부 미러 원본 삭제/아카이브 전파 · pending(#638): 자동 인입 검토 큐
    q: z.string().optional(),
    orderBy: z.enum(["name", "updated_at"]).optional(),
    is_wiki: z.boolean().optional().describe("true 면 WIKI 인덱스 핀(is_wiki) 지식만 — 전체 카테고리에서 매 대화 첫머리에 깔리는 인덱스(#336)"),
    limit: z.number().int().min(1).max(500).optional().describe("페이지 크기(1~500, 기본 200) — 구 200 하드캡 해제(#709)"),
    offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — limit 과 함께 상한 너머 전량 순회(#709)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return {
          space: query.space ? String(query.space) : undefined,
          categoryId: query.category ? Number(query.category) : undefined,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          type: query.type ? String(query.type) : undefined,
          lifecycle: query.lifecycle ? String(query.lifecycle) : undefined,
          q: query.q ? String(query.q) : undefined,
          orderBy: query.orderBy ? String(query.orderBy) : undefined,
          is_wiki: query.is_wiki != null ? (String(query.is_wiki) === "true" || String(query.is_wiki) === "1") : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        };
      } }],
  },
  // #709 limit/offset 페이지네이션 + total/has_more. 구 200 하드캡(구 parse 가 limit/offset 미배선)을 해제.
  handler: async (input: any) => {
    const { limit, offset } = clampPage(input, 200, 500);
    const [entries, total] = await Promise.all([
      listKnowledge({ ...input, limit, offset }),
      countKnowledge(input),
    ]);
    return { entries, total, limit, offset, has_more: offset + entries.length < total };
  },
};

const knowledgeGet: Capability = {
  name: "knowledge_get",
  title: "지식 상세",
  meta: { "anthropic/alwaysLoad": true },   // 회수 진입점 — deferred 금지, 상시 로드(grep→get 루프 왕복 0)
  description: "지식 1건 + 매핑된 카테고리. **부분읽기**: offset(시작 줄,1-based)·limit(줄 수)로 본문을 줄 범위만 받는다(로컬 Read 패리티 — grep 스니펫의 L<n>: 를 그대로 조회). 둘 다 생략 시 전문. 응답 body_range 로 총줄수·다음 범위 파악.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    offset: z.number().int().min(1).optional().describe("부분읽기 시작 줄(1-based). offset/limit 둘 다 생략 시 전문"),
    limit: z.number().int().min(1).max(2000).optional().describe("부분읽기 줄 수(기본 200)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/:name"],
      parse: (req) => ({
        name: String(req.params?.name ?? ""),
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      }) }],
  },
  handler: async (input: any) => {
    const knowledge = await getKnowledge(input.name);
    if (!knowledge) throw new Error(`지식 '${input.name}' 없음`);
    // #783 이 지식에 검토 대기 중인 수정이 있으면 함께 알린다 — staged 면 "지금 보는 본문은 옛 승인본"이라는 뜻이라
    //  사람·에이전트가 그 사실을 모르고 덧쓰면 안 된다(웹 문서화면은 이 값으로 배너를 띄운다).
    const pendingRev = await pendingRevisionFor(input.name);
    const revInfo = pendingRev
      ? {
        pending_revision: {
          id: pendingRev.id, mode: pendingRev.mode, proposed_by: pendingRev.proposed_by,
          actor_kind: pendingRev.actor_kind, agent: pendingRev.agent, edits: pendingRev.edits,
          updated_at: pendingRev.updated_at,
          note: pendingRev.mode === "staged"
            ? "이 지식에는 검토 대기 중인 수정 제안이 있습니다 — 아래 본문은 아직 옛 승인본입니다(승인 시 교체)."
            : "이 지식의 최근 수정이 사람 검토 대기 중입니다 — 본문은 반영돼 있으나 되돌려질 수 있습니다.",
        },
      }
      : {};
    if (input.offset == null && input.limit == null) return { knowledge, ...revInfo };
    // 부분읽기 — 본문을 줄 범위로 잘라 반환(전문 대신). body_range 로 위치·총량 표기.
    const lines = (knowledge.body_md ?? "").split("\n");
    const from = Math.max(1, input.offset ?? 1);
    const count = Math.min(input.limit ?? 200, 2000);
    const slice = lines.slice(from - 1, from - 1 + count);
    const to = from - 1 + slice.length;
    return {
      knowledge: { ...knowledge, body_md: slice.join("\n") },
      body_range: { from, to, returned: slice.length, total_lines: lines.length, has_more: to < lines.length },
      ...revInfo,
    };
  },
};

const knowledgeSave: Capability = {
  name: "knowledge_save",
  title: "지식 저장",
  description:
    "지식 전문 저장. **신규는 category(분류 key 1개 문자열) + type(page-type) 둘 다 필수(#290)** — type=decision|concept|how-to|reference|research|entity. 교차주제는 카테고리 복수태깅이 아니라 knowledge_link 로. provenance 포함(지식은 항상 recalled — '항상 주입'은 관리탭 '세션 주입' 섹션 문서로만, knowledge_set_wiki 로 인덱스 핀). name 없으면 자동 슬러그. " +
    "**본문의 [[name]] 은 저장 시 자동으로 지식↔지식 엣지가 된다(#907)** — 관련 지식은 그냥 본문에 [[name]] 으로 적어라(knowledge_link 를 따로 부를 필요 없다). 본문이 진실이라 [[name]] 을 빼면 그 엣지도 사라진다. " +
    "문법은 Obsidian 과 동일: [[name]] · [[name|표시글]]('|' 뒤는 표시 텍스트지 관계가 아니다) · [[name#헤딩]] · ![[name]]. 자동 엣지는 전부 relation=related — **related 가 아닌 관계(refines·contradicts·depends_on)는 knowledge_link 로 명시**하라(그 엣지는 본문과 무관하게 보존된다). 코드펜스·인라인코드 안의 [[…]] 는 링크로 잡히지 않는다(문법 예시를 쓸 때 유용). " +
    "응답의 wikilink_warning 은 본문이 **없는 지식**을 가리켰다는 뜻이다(저장은 성공) — 오타면 고치고, 아직 없는 지식이면 그대로 둬도 대상이 생기는 대로 자동으로 이어진다. " +
    "**중복 방지(중요): 신규로 만들기 전에 knowledge_similar(또는 knowledge_search)로 같은 내용이 이미 있는지 먼저 확인하라.** 있으면 새로 만들지 말고 그 지식을 **같은 name 으로 갱신**하라(에이전트는 자기 글을 삭제할 수 없으니 사후 정리보다 사전 확인이 맞다). " +
    "신규 저장 응답에 similar 가 오면(유사도 높음) 중복일 수 있으니 — 별개 주제가 아니라면 supersedes 로 기존을 대체하거나 한쪽으로 병합을 검토하라. " +
    "**검토 게이트(#783): 조직이 '에이전트 지식 검토'를 켜 두면** 네가 저장한 지식은 곧바로 유효해지지 않고 사람 승인 대기로 갈 수 있다 — 응답의 gate 필드가 그 결과를 알려준다(pending=검토대기 저장 · stage=수정 제안만 접수, 라이브 본문 미변경 · review=반영됐으나 사후검토 대상). " +
    "gate 가 오면 그 사실을 사용자에게 그대로 알려라(‘저장했다’가 아니라 ‘검토 대기로 접수됐다’). 게이트가 꺼져 있으면 gate 필드는 없고 종전처럼 즉시 반영된다. " +
    "**시딩 지식 경고(#846): 응답에 seed_warning 이 오면** 이 지식은 신규 고객 게이트웨이에 시딩되는 런북이라, 이 WIKI 편집은 고객이 받는 각색 스냅샷(src/org/seed-knowledge/…)에 자동 반영되지 않는다 — 안내대로 그 파일도 갱신하고, 그 사실을 사용자에게 알려라. " +
    "**append 모드(#921): 기존 문서에 내용을 보탤 땐 mode='append' 를 써라** — 이때 body_md 는 전문이 아니라 **덧붙일 조각**이고, 서버가 기존 본문 끝에 빈 줄로 잇는다. " +
    "전문을 읽어와(knowledge_get) 재조립해 통째로 되보내지 마라 — 원문이 그대로 보존되고(네가 재출력하며 생기는 요약·드리프트·누락이 없다) 전문이 컨텍스트를 오갈 일도 없다. " +
    "기존 지식 전용(name 필수 · 신규는 mode 없이 만들고 · 외부 미러(observed)엔 불가), 응답엔 본문 전문 대신 증분 요약(appended)만 온다.",
  scope: "memory",
  input: {
    name: z.string().max(64).optional(),
    title: z.string().max(200).optional(),
    // body_md 는 DB 상 TEXT(무제한) — 이 max 는 폭주/실수 입력(붙여넣은 바이너리·base64·무한생성) 차단용 방어 상한일 뿐이다.
    //  구 40,000 은 정상 장문 설계문서(#534: 45k자 doc 이 쪼개짐)를 튕겨 무손실 저장을 막았다 → 200,000(≈50k토큰)으로 상향.
    //  임베딩은 별도로 8,000자 절단(embeddingInputText), grep 은 응답에서 body_md 제외, get 은 부분읽기 — 이 값에 의존하는 하류 없음.
    //  min(1)은 zod 에선 완화(#592: 폴더는 빈 본문 허용) — is_folder=false 의 min 1 은 handler 가 강제(기존 계약 불변).
    //  #921: mode='append' 면 이 값의 의미가 '전문'에서 '조각'으로 바뀐다 → describe 로 스키마에 명시(설명문만 믿게 두지 않는다).
    body_md: z.string().max(BODY_MD_MAX)
      .describe("본문 전문. **mode='append' 일 때만 의미가 다르다 — 전문이 아니라 기존 본문 끝에 덧붙일 '조각'**(그때 전문을 보내면 문서가 통째로 중복된다)."),
    provenance: z.enum(["authored", "observed"]).optional(),
    lifecycle: z.enum(["active", "pending"]).optional()
      .describe("#638 자동 인입(distill 등)이 검토대기로 저장할 때 pending — 기본 목록·검색·주입에서 격리(승인=set_lifecycle active). 미지정=active(사람 저작 기본). superseded/archived 는 set_lifecycle 로만."),
    supersedes: z.string().max(64).optional(),
    type: z.enum(["decision", "concept", "how-to", "reference", "research", "entity"]).optional()
      .describe("page-type(#290, 신규 필수): decision(결정·ADR)|concept(개념·배경·도메인설명)|how-to(런북·절차)|reference(사양·참조)|research(조사·분석)|entity(사람·조직·제품)"),
    category: z.string().optional().describe("분류 key 1개(단일 — category_list). 신규 필수."),
    is_folder: z.boolean().optional()
      .describe("#592 폴더 노드 — true 면 트리 그룹핑용 폴더(title 필수, body_md 빈 문자열 허용). 미전송 시 기존값 보존."),
    parent_name: z.string().min(1).max(64).optional()
      .describe("#592 트리 위치 — 부모 지식/폴더 name(생성 시 배치). 이동은 knowledge_move. 미전송 시 기존값 보존."),
    mode: z.enum(["replace", "append"]).optional()
      .describe("#921 replace(기본)=body_md 로 전문 교체(종전 동작) · append=body_md('조각')를 기존 본문 끝에 덧붙임(구분 빈 줄은 서버가 정규화). append 는 기존 지식 전용(name 필수)."),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const is_folder = typeof b.is_folder === "boolean" ? b.is_folder : undefined;
        // #921 mode — REST 는 zod 를 안 타고 이 화이트리스트가 유일한 검증이라, 미인식 값을 조용히 흘리면
        //  append 의도가 replace 로 떨어져 '조각이 문서를 통째로 교체'한다 → 여기서 fail-closed(provenance/lifecycle 과 같은 모양).
        const mode = b.mode ? String(b.mode) : undefined;
        if (mode && !["replace", "append"].includes(mode)) throw new HttpError(400, "mode 는 replace|append");
        // #921 append 의 body_md 는 '조각' — trim 하면 첫 줄의 들여쓰기(들여쓴 코드블록)가 MCP 와 달리 REST 에서만 깨진다.
        //  빈 값 검증만 trim 으로 하고 원본은 보존한다(구분 빈 줄·앞뒤 개행 정규화는 appendBody 가 한다).
        const raw = String(b.body_md ?? b.note ?? "");
        const body_md = mode === "append" ? raw : raw.trim();
        // #592: 폴더(is_folder=true)만 빈 본문 허용 — min 1 검증은 is_folder 일 때만 우회(기존 문서 계약 불변).
        if (!body_md.trim() && is_folder !== true) throw new HttpError(400, "body_md(또는 note)가 필요합니다");
        // (#335) injection 사용자 입력 폐기 — 지식은 recalled 고정. 항상-주입은 섹션 문서(org_update_section) 경로로만.
        const provenance = b.provenance ? String(b.provenance) : undefined;
        if (provenance && !["authored", "observed"].includes(provenance)) throw new HttpError(400, "provenance 는 authored|observed");
        const lifecycle = b.lifecycle ? String(b.lifecycle) : undefined;   // #638 자동 인입 pending 저장(사람 web 저작은 미전송=active)
        if (lifecycle && !["active", "pending"].includes(lifecycle)) throw new HttpError(400, "lifecycle 은 active|pending (신규 저장)");
        const category = b.category != null
          ? String(Array.isArray(b.category) ? (b.category[0] ?? "") : b.category) : undefined;  // 단일(#290), 배열 오면 첫 1개
        return {
          name: b.name ? String(b.name) : undefined,
          title: b.title ? String(b.title) : undefined,
          body_md, provenance, lifecycle,
          supersedes: b.supersedes ? String(b.supersedes) : undefined,
          type: b.type ? String(b.type) : undefined,
          category,
          is_folder,
          parent_name: b.parent_name ? String(b.parent_name) : undefined,   // #592 생성 시 트리 배치(이동은 /move)
          mode,                                                             // #921 replace(기본)|append
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    // #592: MCP 경로의 빈 본문 방어 — zod min(1) 완화 대신 여기서(폴더만 예외). REST 는 parse 가 이미 걸렀다.
    if (!String(input.body_md ?? "").trim() && input.is_folder !== true) {
      throw new HttpError(400, "body_md 가 필요합니다(폴더 is_folder=true 만 빈 본문 허용)");
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };

    // ── #783 인입 허용선 게이트 — 정책 규칙 0개면 create=auto·update=auto(현행과 100% 동일). ──
    const gate = await resolveKnowledgeGate(input, ctx);

    // ── #921 append — body_md('조각')를 기존 본문 끝에 붙인 **전문**으로 바꿔 아래 경로 전체가 종전처럼 전문만 다루게 한다. ──
    //  이 자리에서 한 번만 병합하는 게 핵심이다: 리비전 제안(next.body_md)에 조각이 들어가면 승인 시
    //  applyRevisionBody 가 전문 교체(knowledge-revision-store.ts)라 문서가 그 조각으로 날아간다.
    //  append 는 이 어댑터의 계약이라 병합·가드를 전부 여기 둔다 — 데이터 층(upsertKnowledge)은 시드/마이그/리비전
    //  적용/undo 도 함께 쓰는 공용 경로라 append 계약을 물려받으면 안 된다(어댑터 층 가드: runbooks/secrets.md 선례).
    const isAppend = input.mode === "append";
    let appendBase: string | null = null;
    let saveInput = input;
    if (isAppend) {
      // 신규 금지 — upsertKnowledge 의 category/type 필수(#290)가 실질적으로 막긴 하지만, 신규 분기는 dedup similar
      //  검색 + 전문 에코라 append 의 응답 규약과 아예 다른 모양이다. 여기서 막는 게 그걸 따로 설계하는 것보다 싸다.
      if (!gate.name) throw new HttpError(400, "append 에는 name 이 필수입니다 — 덧붙일 지식을 지정하세요.");
      if (!gate.before) throw new HttpError(404, `지식 '${gate.name}' 없음 — append 는 기존 지식에만 됩니다(신규는 mode 없이 category·type 과 함께 만드세요).`);
      // 외부 미러 — 다음 재싱크가 body_md 를 통째로 덮으므로(connector-mirror) 덧붙인 조각은 반드시 사라진다.
      //  replace 는 안 막지만 그건 '전문을 되보내는 비용'이 사실상 억제해 왔다 — append 는 그 비용을 없애니 여기서 막는다.
      //  (upsertKnowledge 도 observed 의 이동·폴더전환을 같은 이유로 거부한다 — 원본이 진실.)
      if (gate.before.provenance === "observed") {
        throw new HttpError(400, "외부 미러(observed) 지식엔 append 가 허용되지 않습니다 — 다음 재싱크가 본문을 통째로 덮어 덧붙인 내용이 사라집니다. 원본(노션 등)에서 고치거나, 파생 인사이트는 별도 지식(authored)으로 쓰세요.");
      }
      // 검토 대기(staged) 제안이 있으면 거부 — 라이브 위에 붙이면 그 제안이 승인되는 순간 이 append 가 통째로 덮이고,
      //  반대로 제안 위에 쌓으면 라이브와 갈라져(그 사이 사람이 고쳤다면) 승인이 사람 개정을 지운다. 둘 다 조용한 유실이라
      //  '어느 쪽에 붙일지'를 서버가 정하지 않고 사람이 큐를 처리한 뒤로 미룬다. (fail-closed 조회 — 삼키면 유실이 된다.)
      const staged = await pendingStagedRevisionId(gate.before.name);
      if (staged) {
        throw new HttpError(409, `이 지식엔 검토 대기 중인 수정 제안(#${staged})이 있어 append 가 허용되지 않습니다 — 사람이 승인/반려한 뒤 다시 시도하세요(지금 붙이면 검토 결과에 덮여 사라집니다).`);
      }
      appendBase = gate.before.body_md ?? "";
      // 중복 append(재시도) — replace 와 달리 append 는 멱등이 아니다. 응답을 잃은 호출자가 재시도하면 같은 단락이
      //  두 번 붙는데, 본문을 읽지 않는 호출자는 그걸 알 수 없다 → 이미 끝에 그대로 있으면 붙이지 않고 사실을 알린다.
      if (isDuplicateAppend(appendBase, String(input.body_md ?? ""))) {
        throw new HttpError(409, "이 조각은 이미 본문 끝에 그대로 있습니다 — 앞선 append 가 이미 반영된 것으로 보입니다(응답을 못 받아 재시도한 경우라면 그 저장은 성공한 것입니다). 같은 내용을 한 번 더 붙이려는 게 정말 맞다면 mode 없이(replace) 전문으로 저장하세요.");
      }
      const merged = appendBody(appendBase, String(input.body_md ?? ""));
      if (merged.length > BODY_MD_MAX) {
        throw new HttpError(400, `append 결과가 본문 상한(${BODY_MD_MAX.toLocaleString()}자)을 넘습니다(현재 ${appendBase.length.toLocaleString()}자 + 조각 ${String(input.body_md ?? "").length.toLocaleString()}자) — 넘기면 그 문서는 전문 저장(replace·웹 편집기)이 영영 불가해집니다. 문서를 나누세요.`);
      }
      saveInput = { ...input, body_md: merged };
    }

    // #921 append 응답 — 본문 전문은 빼고 증분 요약만. json()(capabilities/index.ts)이 handler 결과를 통째로
    //  stringify 해 에이전트에 돌려주므로, 전문을 에코하면 '전문을 컨텍스트에 안 싣는다'는 이 모드의 목적이 무효가 된다.
    //  (replace 는 종전대로 전문 포함 — 기존 응답 계약 불변.)
    const lineCount = (s: string): number => (s ? s.split("\n").length : 0);
    const withBody = (k: any): Record<string, unknown> => {
      if (appendBase == null) return { knowledge: k };
      const { body_md, ...rest } = k ?? {};
      const body = String(body_md ?? "");
      return {
        knowledge: rest,
        appended: {
          added_chars: body.length - appendBase.length, added_lines: lineCount(body) - lineCount(appendBase),
          total_chars: body.length, total_lines: lineCount(body), version: rest?.version,
          note: "본문 끝에 덧붙였습니다(기존 원문 그대로 보존). 응답에 전문은 넣지 않습니다 — 확인이 필요하면 knowledge_get 부분읽기(offset/limit)로 보세요.",
        },
      };
    };

    // ① 신규 저장.
    if (gate.isCreate) {
      if (gate.create === "drop") {
        throw new HttpError(403, "인입 허용선 정책상 이 지식은 저장할 수 없습니다(drop) — 관리탭 '인입 허용선'에서 규칙을 확인하세요.");
      }
      // 서버 클램프: 에이전트가 lifecycle='active' 로 우회할 수 없다. 반대로 에이전트가 자진 pending 하면 존중(안전 방향).
      const lifecycle = (gate.create === "confirm" || input.lifecycle === "pending") ? "pending" : (input.lifecycle ?? "active");
      const { wikilinks, ...knowledge } = await upsertKnowledge({ ...input, lifecycle }, writeCtx);
      const wl = wikiLinkInfo(wikilinks);   // #907 자동 엣지 결과 — 응답 최상위로(knowledge 행에 섞지 않는다)
      const gateInfo = lifecycle === "pending"
        ? { action: "confirm", state: "pending", rule_id: gate.rule_id,
            note: "검토 대기(pending)로 저장됐습니다 — 사람이 승인하기 전까지 검색·세션주입·목록에 노출되지 않습니다(knowledge_get·knowledge_list(lifecycle='pending')로는 조회 가능). 같은 name 으로 다시 저장하면 이 초안이 갱신됩니다." }
        : null;
      // 저장-시 중복감지(#172) — 신규(version=1)일 때만, 방금 저장된 임베딩으로 최근접 검색(재임베딩 X).
      //  임베딩 off / 유사 없음이면 그냥 { knowledge }. 비차단 경고 — 중복이면 supersedes/병합을 사람·에이전트가 판단.
      if ((knowledge as any)?.version === 1) {
        const similar = await findSimilarKnowledge({ name: knowledge.name, limit: 3, minScore: DEDUP_WARN_SIMILARITY });
        if (similar.length) {
          return { knowledge, ...seedSyncWarning(knowledge.name), ...(gateInfo ? { gate: gateInfo } : {}), ...wl, similar, similar_note: "⚠ 비슷한 기존 지식이 있습니다(유사도순). 별개 주제가 아니라면 새로 만들지 말고 기존을 갱신하거나 supersedes 로 대체하세요 — 다음부터는 저장 전 knowledge_similar 로 먼저 확인하세요." };
        }
      }
      return { knowledge, ...seedSyncWarning(knowledge.name), ...(gateInfo ? { gate: gateInfo } : {}), ...wl };
    }

    // ② 기존 지식 수정 — 라이브(active) 대상일 때만 게이트(pending 초안 다듬기는 그대로 통과).
    if (gate.update === "drop") {
      throw new HttpError(403, "인입 허용선 정책상 이 지식은 수정할 수 없습니다(drop) — 관리탭 '인입 허용선'에서 규칙을 확인하세요.");
    }
    const before = gate.before!;
    if (gate.update === "stage") {
      // 본문 미반영 — 라이브는 옛 승인본 유지, 제안만 큐로. (같은 지식의 pending 제안은 1건으로 coalesce.)
      const revision = await proposeRevision({
        name: before.name, mode: "staged",
        base: { version: before.version, title: before.title, body_md: before.body_md, confidence: before.confidence },
        // #921 append 면 saveInput.body_md 는 '조각'이 아니라 base+조각 전문 — 승인(applyRevisionBody)이 전문 교체라 조각을 넣으면 문서가 날아간다.
        next: { title: input.title ?? null, body_md: String(saveInput.body_md ?? ""), summary: null, type: input.type ?? null },
        proposed_by: writeCtx.actor, actor_kind: gate.actor_kind, agent: gate.agent, rule_id: gate.rule_id,
      });
      return {
        knowledge: null,
        ...seedSyncWarning(before.name),
        gate: {
          action: "stage", state: "proposed", revision_id: revision.id, rule_id: gate.rule_id,
          note: "수정 제안으로 접수됐습니다 — 라이브 본문은 아직 바뀌지 않았습니다(사람이 승인해야 반영). 같은 지식을 다시 저장하면 이 제안이 갱신됩니다.",
        },
      };
    }
    // #921 saveInput — append 면 body_md 가 조각이 아니라 base+조각 전문(위 append 분기에서 병합).
    const { wikilinks, ...knowledge } = await upsertKnowledge(saveInput, writeCtx);
    const wl = wikiLinkInfo(wikilinks);
    if (gate.update === "review") {
      // 본문은 즉시 반영(라이브 유지) — 사람은 사후에 diff 를 보고 확인 또는 되돌리기.
      const revision = await proposeRevision({
        name: before.name, mode: "applied",
        base: { version: before.version, title: before.title, body_md: before.body_md, confidence: before.confidence },
        next: { title: input.title ?? null, body_md: String(saveInput.body_md ?? ""), summary: null, type: input.type ?? null },
        proposed_by: writeCtx.actor, actor_kind: gate.actor_kind, agent: gate.agent, rule_id: gate.rule_id,
      });
      return {
        ...withBody(knowledge),
        ...seedSyncWarning(knowledge.name),
        ...wl,
        gate: {
          action: "review", state: "applied_pending_review", revision_id: revision.id, rule_id: gate.rule_id,
          note: "수정이 반영됐고(라이브), 사람 검토 큐에 diff 가 적재됐습니다 — 검토에서 되돌려질 수 있습니다.",
        },
      };
    }
    return { ...withBody(knowledge), ...seedSyncWarning(knowledge.name), ...wl };
  },
};

const knowledgeSetLifecycle: Capability = {
  name: "knowledge_set_lifecycle",
  title: "지식 lifecycle",
  description: "active/pending/superseded/archived 전환. pending→active = 검토 승인(#638/#783 게이트). active→pending = 검토대기로 되돌림. 제거(반려)는 폐기 — 대신 knowledge_delete(휴지통, 복원가능). archived 는 외부 미러 원본 아카이브 전파에도 쓰인다(#551). " +
    "⚠ 승인(→active)과 '검토 대기 중 지식의 상태 변경'은 **사람 전용**(웹) — 에이전트(MCP)는 403. 자기가 쓴 지식을 스스로 승인할 수 없다.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    lifecycle: z.enum(["active", "pending", "superseded", "archived"]),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/lifecycle"],
      parse: (req) => {
        const lifecycle = String(((req.body ?? {}) as Record<string, unknown>).lifecycle ?? "");
        if (!["active", "pending", "superseded", "archived"].includes(lifecycle)) throw new HttpError(400, "lifecycle 은 active|pending|superseded|archived");
        return { name: String(req.params?.name ?? ""), lifecycle };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    // 🔒 #783 자가승인 차단 — 이게 없으면 게이트가 통째로 무력화된다:
    //  에이전트가 knowledge_save 로 pending 저장 → 곧바로 set_lifecycle(active) 로 스스로 승인 → 무검증 지식이 라이브.
    //  검토는 사람의 행위다. knowledge_delete 가 같은 이유로 mcp 를 403 하는 것(자기 글 삭제 금지)과 동형 가드.
    //  · →active(승인)는 MCP 금지. · 검토 대기(pending) 중인 지식의 상태 변경도 MCP 금지(큐에서 몰래 치우는 것 방지).
    //  사람 경로(웹 REST, source='web')는 무영향 — 검토 큐·문서 배너의 승인 버튼이 그대로 동작한다.
    if (ctx?.source === "mcp") {
      if (input.lifecycle === "active") {
        throw new HttpError(403, "승인(→active)은 사람이 웹 검토 큐에서 합니다 — 에이전트는 자기가 쓴 지식을 스스로 승인할 수 없습니다.");
      }
      const cur = await getKnowledgeLifecycle(input.name);
      if (cur === "pending") {
        throw new HttpError(403, "검토 대기 중인 지식의 상태 변경은 사람만 할 수 있습니다(검토 큐).");
      }
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await setKnowledgeLifecycle(input.name, input.lifecycle, writeCtx) };
  },
};

// WIKI 핀 토글 — is_wiki 만 갱신. 핀된 지식의 제목+메타가 가이드 ${wiki} 로 매 세션 항상-주입(본문 제외).
const knowledgeSetWiki: Capability = {
  name: "knowledge_set_wiki",
  title: "WIKI 핀 토글",
  description: "지식을 WIKI 인덱스에 핀(고정)하거나 해제한다. 핀된 지식의 제목+메타가 컨텍스트 온톨로지 가이드의 ${wiki} 위치에 매 세션 항상-주입된다(본문 제외 — 인덱스).",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    is_wiki: z.boolean(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/wiki"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { name: String(req.params?.name ?? ""), is_wiki: b.is_wiki === true };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await setKnowledgeWiki(input.name, input.is_wiki, writeCtx) };
  },
};

// 삭제(휴지통) — 활성 목록에서 제거하되 감사 스냅샷으로 보존(content_restore 로 복원). 제거의 유일 경로
//  (가역 숨김 '반려' 는 폐기 — 삭제가 복원가능이라 흡수). ⚠ 사람(웹)만 — 에이전트(MCP)는 403. deny pattern 은 domain_delete 동형.
const knowledgeDelete: Capability = {
  name: "knowledge_delete",
  title: "지식 삭제(휴지통)",
  description:
    "지식을 삭제한다 — 활성 목록·검색·주입에서 사라지되 감사 스냅샷(before)으로 보존되어 content_restore(휴지통)로 복원 가능. " +
    "연결(카테고리·프로젝트 필요/산출·활동)은 FK CASCADE 로 정리된다(복원 시 링크는 돌아오지 않음). " +
    "지식 제거의 유일 경로(가역 숨김 '반려' 는 폐기). ⚠ 사람(웹)만 — 에이전트(MCP)는 403(비가역).",
  scope: "memory",
  input: { name: z.string().min(1).max(64) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/delete"],
      parse: (req) => ({ name: String(req.params?.name ?? "") }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    if (ctx?.source === "mcp") {
      throw new HttpError(403, "지식 삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다(비가역). 정정은 같은 이름으로 덮어쓰기(저장)하세요");
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const before = await deleteKnowledge(input.name, writeCtx);
    return { deleted: true, name: input.name, title: (before as any)?.title ?? null };
  },
};

const knowledgeLinkCategory: Capability = {
  name: "knowledge_link_category",
  title: "지식↔카테고리",
  description: "지식을 카테고리에 연결(또는 unlink=true 로 해제).",
  scope: "memory",
  // 핸들러가 읽는 이름(REST 는 :name 경로 + body 'category_id'→categoryId 매핑). state 기본=confirmed(REST 와 동일).
  input: {
    name: z.string().min(1).max(64),
    categoryId: z.number().int().positive(),
    unlink: z.boolean().optional(),
    state: z.string().max(32).default("confirmed"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/category"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const categoryId = Number(b.category_id);
        if (!Number.isInteger(categoryId)) throw new HttpError(400, "category_id 가 필요합니다");
        return {
          name: String(req.params?.name ?? ""), categoryId,
          unlink: b.unlink === true, state: b.state ? String(b.state) : "confirmed",
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkKnowledgeCategory(input.name, input.categoryId, writeCtx); return { unlinked: true }; }
    await linkKnowledgeCategory(input.name, input.categoryId, input.state, writeCtx);
    return { linked: true };
  },
};

// grep — title/body_md 를 grep(정규식|토큰 AND) + 스니펫. injection/provenance 로 좁힐 수 있음. ⚠ 의미검색 아님(벡터는 추후 knowledge_search 로).
const knowledgeGrep: Capability = {
  name: "knowledge_grep",
  title: "지식 grep",
  meta: { "anthropic/alwaysLoad": true },   // 회수 진입점 — deferred 금지, 상시 로드(세션 첫 동작)
  description:
    "지식 제목/본문을 **grep**(텍스트 패턴 매칭)한다 — 의미검색 아님. 단어가 본문에 그대로 등장해야 잡힌다(대소문자 무시). " +
    "ripgrep 처럼 써라: 좁히려면 **한 토큰**(예: `도메인맵`), 다중 키워드는 공백으로 — **모든 토큰이** 들어간 지식이 잡힌다(AND, 순서무관). " +
    "OR·부분일치 등은 **POSIX 정규식**으로(예: `벡터|vector`, `task_\\w+`). " +
    "자연어 질문 문장은 넣지 마라(그 문장이 통째로 본문에 없으면 0건). 결과는 **매치 줄 스니펫**(`L<n>: …`, 본문 전문 아님) — 전문은 결과의 name 으로 knowledge_get(부분읽기 offset/limit). " +
    "mode=names(이름·제목만 싸게 넓게)·count(총건수만)·snippets(기본). context=±N 줄(스니펫에 주변 줄 포함, ripgrep -C).",
  scope: "memory",
  input: {
    q: z.string().min(1).describe("grep 패턴 — 한 토큰, 공백구분 다중토큰(AND), 또는 POSIX 정규식. 자연어 문장 금지."),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    mode: z.enum(["snippets", "names", "count"]).optional().describe("snippets(기본)=매치 줄 스니펫 / names=name·title만 / count=총건수만"),
    context: z.number().int().min(0).max(3).optional().describe("스니펫에 매치 줄 ±N 컨텍스트 줄 포함(기본 0, ripgrep -C)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/search"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        const q = String(query.q ?? "").trim();
        if (!q) throw new HttpError(400, "q(검색어)가 필요합니다");
        return {
          q,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          mode: query.mode ? String(query.mode) : undefined,
          context: query.context ? Number(query.context) : undefined,
        };
      } }],
  },
  handler: async (input: any) => {
    if (input.mode === "count") {
      return { mode: "count", total: await countKnowledgeGrep(input.q, { injection: input.injection, provenance: input.provenance }) };
    }
    return {
      mode: input.mode ?? "snippets",
      entries: await searchKnowledge(input.q, {
        injection: input.injection, provenance: input.provenance, limit: input.limit, mode: input.mode, context: input.context,
      }),
    };
  },
};

// 하이브리드 검색(벡터검색 #172) — 벡터 임베딩 + 렉시컬 grep RRF 융합. grep(정확 매칭)과 직교: 의미·자연어 회수용.
//  org/schema.ts 가 'knowledge_search' 이름을 이 벡터검색 도구로 예약해 둠(구 knowledge_search→grep 개명 후). MCP 전용.
//  임베딩 off(기본)면 자동으로 렉시컬(grep)로 폴백 → 켜기 전에도 안전하게 동작(동작 == grep).
const knowledgeSearch: Capability = {
  name: "knowledge_search",
  title: "지식 검색(하이브리드)",
  meta: { "anthropic/alwaysLoad": true },   // 회수 진입점 — grep 과 함께 상시(의미검색이 #172 의 헤드라인 능력)
  description:
    "지식을 **의미 기반 하이브리드 검색**한다 — 벡터 임베딩(의미 유사) + 렉시컬 grep 을 RRF 로 융합. " +
    "grep 과 달리 **자연어 질문**이나 다른 표현을 써도 관련 지식을 회수한다(단어가 본문에 그대로 없어도 잡힘). " +
    "임베딩 미설정 환경에선 자동으로 grep(렉시컬)으로 폴백한다(안전). " +
    "결과는 **스니펫**(본문 전문 아님) + RRF score — 전문은 결과의 name 으로 knowledge_get(부분읽기 offset/limit). " +
    "**정확한 토큰/정규식 매칭**이 필요하면 knowledge_grep 을, **의미/유사/자연어**면 이 도구를 써라. mode=names(이름·제목만)·snippets(기본).",
  scope: "memory",
  input: {
    q: z.string().min(1).describe("자연어 질문 또는 키워드 — 의미 유사도로 회수(grep 과 달리 문장 가능)"),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    mode: z.enum(["snippets", "names"]).optional().describe("snippets(기본)=스니펫 / names=name·title만"),
    context: z.number().int().min(0).max(3).optional().describe("스니펫에 매치 줄 ±N 컨텍스트 줄(grep 채널 매치 시, ripgrep -C)"),
  },
  // MCP + REST(/api/ui/knowledge/semantic) — 웹 지식탭의 '의미검색' 토글이 소비. grep 은 /knowledge/search(불변).
  //  ⚠ restMounts 순서: knowledgeGet(/knowledge/:name) **앞**에 둬야 'semantic'이 :name 으로 안 잡힌다(배열 순서 보장).
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/semantic"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        const q = String(query.q ?? "").trim();
        if (!q) throw new HttpError(400, "q(검색어)가 필요합니다");
        return {
          q,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          mode: query.mode ? String(query.mode) : undefined,
          context: query.context ? Number(query.context) : undefined,
        };
      } }],
  },
  handler: async (input: any) => ({
    entries: await hybridSearchKnowledge(input.q, {
      injection: input.injection, provenance: input.provenance, limit: input.limit, mode: input.mode, context: input.context,
    }),
  }),
};

// 유사 지식(벡터검색 #172) — 코사인 유사도(0~1) 기반 최근접. dedup(저장 전 확인)·관련패널의 프리미티브.
//  search/grep 과 직교: 이건 "이 지식/텍스트와 가까운 것" 자체를 절대 유사도로 돌려준다(랭크 아님 → 임계 비교 가능).
//  임베딩 off / 대상 임베딩 없음이면 빈 결과(검색은 knowledge_search). MCP + REST(/api/ui/knowledge/similar).
const knowledgeSimilar: Capability = {
  name: "knowledge_similar",
  title: "유사 지식",
  description:
    "주어진 지식(name) 또는 텍스트(text)와 **의미적으로 가장 가까운** 지식을 코사인 유사도(0~1)로 찾는다. " +
    "신규 저장 전 **중복 확인**이나 관련 지식 탐색용. name 을 주면 그 지식의 저장된 임베딩을 재사용(자기 자신 제외), text 를 주면 즉시 임베딩한다(택일). " +
    "min_score(0~1) 이상만, 유사도 내림차순. **임베딩이 꺼져 있거나 대상에 임베딩이 없으면 빈 결과**(자연어/키워드 검색은 knowledge_search, 정확매칭은 knowledge_grep). " +
    "knowledge_save 는 신규 저장 시 비슷한 지식이 있으면 응답 similar 로 자동 경고한다 — 이 도구는 저장 전에 미리 확인할 때.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64).optional().describe("기준 지식 이름(저장된 임베딩 재사용, 자기 제외) — text 와 택일"),
    text: z.string().min(1).max(8000).optional().describe("기준 텍스트(즉시 임베딩) — name 과 택일"),
    limit: z.number().int().min(1).max(50).optional(),
    min_score: z.number().min(0).max(1).optional().describe("이 코사인 유사도(0~1) 이상만(기본 0)"),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
  },
  // REST 마운트는 knowledgeGet(/knowledge/:name) **앞**에 둬야 'similar'가 :name 으로 안 잡힌다(배열 순서 — semantic 과 동형).
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/similar"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        const name = query.name ? String(query.name) : undefined;
        const text = query.text ? String(query.text) : undefined;
        if (!name && !text) throw new HttpError(400, "name 또는 text 가 필요합니다");
        return {
          name, text,
          limit: query.limit ? Number(query.limit) : undefined,
          min_score: query.min_score != null && query.min_score !== "" ? Number(query.min_score) : undefined,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
        };
      } }],
  },
  handler: async (input: any) => {
    if (!input.name && !input.text) throw new Error("name 또는 text 중 하나가 필요합니다");
    return {
      entries: await findSimilarKnowledge({
        name: input.name, text: input.text, limit: input.limit, minScore: input.min_score,
        injection: input.injection, provenance: input.provenance,
      }),
    };
  },
};

// #290 지식↔지식 링크 — 빠진 1급 프리미티브. create 또는 unlink=true. 교차주제는 카테고리 복수태깅 대신 이 링크로.
const knowledgeLink: Capability = {
  name: "knowledge_link",
  title: "지식↔지식 링크",
  description:
    "지식을 다른 지식과 연결한다(또는 unlink=true 로 해제). relation=related(대칭 관련)|refines(이 지식이 to 를 구체화)|contradicts(모순)|depends_on(의존). " +
    "단일 카테고리(#290)라 **교차주제는 카테고리 복수태깅이 아니라 이 링크로** 표현한다 — 백링크·그래프뷰·회수 그래프의 SoT(MediaWiki/Obsidian 모델). 양쪽 지식이 존재해야 한다.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64).describe("출발 지식(from)"),
    to: z.string().min(1).max(64).describe("도착 지식(to)"),
    relation: z.enum(["related", "refines", "contradicts", "depends_on"]).default("related"),
    unlink: z.boolean().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/link"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const to = String(b.to ?? "").trim();
        if (!to) throw new HttpError(400, "to(도착 지식 이름)가 필요합니다");
        return {
          name: String(req.params?.name ?? ""), to,
          relation: b.relation ? String(b.relation) : "related",
          unlink: b.unlink === true,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkKnowledge(input.name, input.to, input.relation, writeCtx); return { unlinked: true }; }
    await linkKnowledge(input.name, input.to, input.relation, writeCtx);
    return { linked: true };
  },
};

// #290 그래프뷰 데이터(UI 전용, REST) — 활성 지식 노드(+단일 카테고리) + 지식↔지식 엣지. 전역/로컬 그래프를 클라가 그린다.
const knowledgeGraph: Capability = {
  name: "knowledge_graph",
  title: "지식 그래프",
  description: "활성 지식 노드(+단일 카테고리·type)와 지식↔지식 링크 엣지를 반환한다(그래프뷰 전용).",
  scope: "memory",
  input: { limit: z.number().int().min(1).max(2000).optional() },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-graph"],
      parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : undefined }) }],
  },
  handler: async (input: any) => await knowledgeGraphData(input.limit),
};


// #551 페이지 트리(외부 미러) — 얕은 스켈레톤(name/title/parent/sort/lifecycle/kind) 전량. UI 전용(REST).
//  목록 cap(500) 우회: 본문 미포함이라 수천 행도 가볍다. 클라이언트(WIKI 탭 트리)가 조립.
const knowledgeTree: Capability = {
  name: "knowledge_tree",
  title: "지식 페이지 트리",
  description: "외부 미러(system)의 페이지 트리 스켈레톤(parent_name/sort 기반)을 반환한다(트리 뷰 전용).",
  scope: "memory",
  input: {
    system: z.string().min(1).max(40).optional(),
    limit: z.number().int().min(1).max(50000).optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-tree"],
      parse: (req) => {
        const n = req.query?.limit ? Number(req.query.limit) : NaN;
        return {
          system: req.query?.system ? String(req.query.system) : undefined,
          limit: Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined, // NaN/음수 → 기본값(SQL LIMIT 오류 방지)
        };
      } }],
  },
  handler: async (input: any) => ({ entries: await knowledgeTreeData(input.system ?? "notion", input.limit) }),
};

// ════════ #592 지식/위키 UI — 전역 뷰 설정·속성 오버라이드·댓글·트리 이동(REST 계약 §2). ════════

// 전역 뷰 설정 조회 — { hidden_props } 만(계약 고정). 프론트가 카탈로그 전체 − hidden_props 로 기본 노출 계산.
const knowledgeViewGet: Capability = {
  name: "knowledge_view_get",
  title: "지식 뷰 설정 조회",
  description: "지식 속성 패널의 전역 기본 숨김 키(hidden_props)를 반환한다. 항목 단위 오버라이드는 knowledge.props_ui(knowledge_get 응답).",
  scope: "memory",
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-view-config"], parse: () => ({}) }],
  },
  handler: async () => ({ hidden_props: (await getKnowledgeViewConfig()).hidden_props }),
};

// 전역 뷰 설정 저장 — 전체 배열 교체(부분 병합 아님 — 팝오버가 전체 상태를 들고 있다). 감사 org_content_audit.
const knowledgeViewSet: Capability = {
  name: "knowledge_view_set",
  title: "지식 뷰 설정 저장",
  description: "지식 속성 패널의 전역 기본 숨김 키(hidden_props)를 저장한다(전체 교체·감사 기록). 웹 전용.",
  scope: "memory",
  input: { hidden_props: z.array(z.string().min(1).max(64)).max(64) },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge-view-config"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const v = b.hidden_props;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          throw new HttpError(400, "hidden_props 는 문자열 배열이어야 합니다");
        }
        if (v.length > 64) throw new HttpError(400, "hidden_props 는 최대 64키까지 허용됩니다");
        return { hidden_props: v };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { hidden_props: (await setKnowledgeViewConfig(input.hidden_props, writeCtx)).hidden_props };
  },
};

// 항목 단위 속성 노출 오버라이드 — props_ui 부분 병합(키 null=제거). version·updated_at 불변(뷰 설정은 내용 아님).
//  observed(미러) 지식에도 허용 — props_ui 는 fields 밖 별도 컬럼이라 재싱크에 생존(#592 §0).
const knowledgePropsUi: Capability = {
  name: "knowledge_props_ui",
  title: "지식 속성 노출 설정",
  description: "지식 1건의 속성 노출 오버라이드(props_ui: show/hide/full_width)와 페이지 꾸미기(icon/cover, #657)를 부분 병합 저장한다(키에 null 을 주면 제거). 웹 전용.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    show: z.array(z.string().min(1).max(64)).max(64).nullable().optional(),
    hide: z.array(z.string().min(1).max(64)).max(64).nullable().optional(),
    full_width: z.boolean().nullable().optional(),
    // #657 페이지 꾸미기 — icon=이모지(짧은 문자열), cover=프리셋 키(grad:N|#hex) 또는 이미지 URL.
    icon: z.string().min(1).max(80).nullable().optional(),
    cover: z.string().min(1).max(500).nullable().optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/props-ui"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { name: String(req.params?.name ?? "") };
        // 부재(미전송)≠null(키 제거) 3상 구분 — 'in' 프로브로만 채운다(undefined 로 덮으면 스토어가 미변경 처리).
        for (const k of ["show", "hide"] as const) {
          if (!(k in b)) continue;
          const v = b[k];
          if (v === null) { out[k] = null; continue; }
          if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
            throw new HttpError(400, `${k} 는 문자열 배열(또는 null=제거)이어야 합니다`);
          }
          out[k] = (v as string[]).map((s) => s.trim()).filter(Boolean).slice(0, 64);
        }
        if ("full_width" in b) {
          if (b.full_width !== null && typeof b.full_width !== "boolean") {
            throw new HttpError(400, "full_width 는 boolean(또는 null=제거)이어야 합니다");
          }
          out.full_width = b.full_width;
        }
        // #657 icon/cover — 문자열(설정) 또는 null(제거). 길이 상한은 zod(max 80/500)가 최종 방어.
        for (const k of ["icon", "cover"] as const) {
          if (!(k in b)) continue;
          const v = b[k];
          if (v === null) { out[k] = null; continue; }
          if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${k} 는 문자열(또는 null=제거)이어야 합니다`);
          out[k] = v.trim();
        }
        return out;
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { props_ui: await setKnowledgePropsUi(input.name, { show: input.show, hide: input.hide, full_width: input.full_width, icon: input.icon, cover: input.cover }, writeCtx) };
  },
};

// 지식 댓글 피드 조회 — 댓글+반응만(시스템 이벤트 병합 없음, getTaskFeed 와 다른 점). 웹 문서 하단 댓글 섹션 소비.
const knowledgeComments: Capability = {
  name: "knowledge_comments",
  title: "지식 댓글 피드",
  description: "지식 1건의 댓글 피드(댓글+이모지 반응, display_name 포함)를 반환한다. 웹 전용.",
  scope: "memory",
  input: { name: z.string().min(1).max(64) },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/:name/comments"],
      parse: (req) => ({ name: String(req.params?.name ?? "") }) }],
  },
  handler: async (input: any, user: any, ctx: any) =>
    ({ feed: await getKnowledgeCommentFeed(input.name, ctx?.actor ?? user?.userId ?? null) }),
};

// 지식 댓글 작성 — {text, parent_id?(1단계 스레드)}. 작성 후 갱신된 피드 반환(task_comment_v6 동형).
const knowledgeCommentPost: Capability = {
  name: "knowledge_comment_post",
  title: "지식 댓글 작성",
  description: "지식에 댓글을 단다(knowledge_comment). {text, parent_id?}. 작성 후 갱신된 피드 반환. 웹 전용.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    text: z.string().min(1),
    parent_id: z.number().int().positive().nullable().optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/comments"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, "댓글 내용이 필요합니다");
        const pid = b.parent_id != null ? Number(b.parent_id) : null;
        if (pid != null && (!Number.isInteger(pid) || pid <= 0)) throw new HttpError(400, "parent_id 형식이 잘못되었습니다");
        return { name: String(req.params?.name ?? ""), text, parent_id: pid || null };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { feed: await postKnowledgeComment(input.name, input.text, writeCtx, input.parent_id ?? null) };
  },
};

// 지식 댓글 반응 토글 — {emoji}. 갱신된 emoji별 집계 반환(task_comment_reaction_v6 동형).
const knowledgeCommentReaction: Capability = {
  name: "knowledge_comment_reaction",
  title: "지식 댓글 반응",
  description: "지식 댓글(knowledge_comment)에 이모지 반응을 토글한다. {emoji}. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), emoji: z.string().min(1) },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge-comments/:id/reactions"],
      parse: (req) => {
        const id = Number(req.params?.id);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 형식이 잘못되었습니다");
        const e = String(((req.body ?? {}) as Record<string, unknown>).emoji ?? "").trim();
        if (!e) throw new HttpError(400, "emoji 가 필요합니다");
        return { id, emoji: e };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) =>
    ({ reactions: await toggleKnowledgeCommentReaction(input.id, input.emoji, ctx?.actor ?? user?.userId ?? "") }),
};

// 트리 이동 — parent_name(null=루트)·sort?. 가드(스토어): 대상 observed 400 / 부모 존재 404·observed 400·순환 400.
const knowledgeMove: Capability = {
  name: "knowledge_move",
  title: "지식 트리 이동",
  description:
    "지식(폴더 포함)을 저작 지식 트리에서 이동한다 — parent_name(부모 지식/폴더 name, null=루트)과 sort(형제 순서, 선택). " +
    "외부 미러(observed) 지식은 이동 불가(원본에서 옮겨야 함), observed 아래로의 배치·순환도 거부된다.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    parent_name: z.string().min(1).max(64).nullable().describe("부모 지식/폴더 name — null 이면 루트로"),
    sort: z.number().int().optional().describe("형제 간 순서(작을수록 앞). 생략 시 기존 유지"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/move"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (!("parent_name" in b)) throw new HttpError(400, "parent_name(지식 이름 또는 null=루트)이 필요합니다");
        const parent_name = b.parent_name == null ? null : String(b.parent_name).trim();
        if (parent_name === "") throw new HttpError(400, "parent_name 은 지식 이름 또는 null 이어야 합니다");
        const out: Record<string, unknown> = { name: String(req.params?.name ?? ""), parent_name };
        if (b.sort != null) {
          const s = Number(b.sort);
          if (!Number.isInteger(s)) throw new HttpError(400, "sort 는 정수여야 합니다");
          out.sort = s;
        }
        return out;
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await moveKnowledge(input.name, input.parent_name ?? null, input.sort, writeCtx) };
  },
};

// ════════ #783 수정 검토 큐 — 기존 active 지식을 에이전트가 고친 건을 사람이 diff 로 검토. ════════
//  신규 지식은 lifecycle='pending' 으로 격리되므로 knowledge_list(lifecycle=pending)가 그 큐다.
//  수정은 본문과 분리해 knowledge_revision 에 쌓인다(staged=미반영·applied=반영후검토) → 여기 3종이 그 표면.
//  scope='memory' — #638 결정("승인 자격제한 없음, 카테고리 전문성 있는 워킹레벨이 더 잘 검토"). 승인자는 감사(actor)에 남는다.
//  REST 전용: 검토는 사람이 웹에서 하는 일이라 MCP 툴 표면을 늘리지 않는다(에이전트는 knowledge_save 응답의 gate 로 상태를 안다).
const knowledgeRevisions: Capability = {
  name: "knowledge_revisions",
  title: "지식 수정 검토 큐",
  description: "검토 대기(또는 처리된) 지식 수정 목록 — 대상 지식·제안자(에이전트/사람)·모드(staged|applied)·증감 줄수·충돌 여부.",
  scope: "memory",
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-revisions"],
      parse: (req) => ({
        status: req.query?.status ? String(req.query.status) : "pending",
        limit: req.query?.limit ? Number(req.query.limit) : 200,
      }) }],
  },
  handler: async (input: any) => {
    const status = ["pending", "approved", "rejected"].includes(String(input.status)) ? String(input.status) : "pending";
    return { entries: await listRevisions(status, Number(input.limit) || 200) };
  },
};

const knowledgeRevisionGet: Capability = {
  name: "knowledge_revision_get",
  title: "지식 수정 제안 상세",
  description: "수정 제안 1건 + 라이브 현재본 — diff 렌더용 전문 3종(수정 전 base / 라이브 현재 / 제안 new).",
  scope: "memory",
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-revisions/:id"],
      parse: (req) => ({ id: Number(req.params?.id) }) }],
  },
  handler: async (input: any) => {
    const got = await getRevision(Number(input.id));
    if (!got) throw new HttpError(404, "수정 제안 없음");
    return got;
  },
};

const knowledgeRevisionReview: Capability = {
  name: "knowledge_revision_review",
  title: "지식 수정 승인/반려",
  description: "승인 — staged: 제안 본문을 라이브에 적용 · applied: 확인(이미 반영됨). 반려 — staged: 제안 폐기(라이브 무변) · applied: 라이브를 수정 전으로 되돌림.",
  scope: "memory",
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge-revisions/:id/review"],
      parse: (req) => {
        const decision = String(((req.body ?? {}) as Record<string, unknown>).decision ?? "");
        if (!["approve", "reject"].includes(decision)) throw new HttpError(400, "decision 은 approve|reject");
        return { id: Number(req.params?.id), decision };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return input.decision === "approve"
      ? await approveRevision(Number(input.id), writeCtx)
      : await rejectRevision(Number(input.id), writeCtx);
  },
};

// ════════ #802 검토 큐 요약(카운트) — 검토 큐를 관리탭 밖으로 꺼내는 표면들의 공용 데이터원. ════════
//  문제: 검토 큐가 관리탭 안에만 있어, 아무도 안 들어가면 에이전트가 쓴 지식이 승인 대기로 묻힌다
//   (pending 은 검색·세션주입에서 빠져 있으므로 "기록했는데 아무도 못 쓰는" 상태).
//  → 대시보드 '최신 알림'의 검토 대기 리마인더 + 관리탭 nav 배지 + 큐의 '내 도메인' 필터가 이걸 함께 먹는다.
//  scope='memory' — 검토 큐(knowledge_revisions)와 동일. 검토할 수 없는 사람에겐 애초에 알리지 않는다(403 → 표면 생략).
const reviewQueueSummary: Capability = {
  name: "review_queue_summary",
  title: "검토 큐 요약",
  description: "검토 대기 건수 — 신규(pending 지식) + 수정(리비전). 전체와 '내 도메인'(내 팀이 오너인 카테고리)을 분리해 준다.",
  scope: "memory",
  input: {},
  expose: {
    mcp: false,   // 검토는 사람이 웹에서 하는 일 — 에이전트 툴 표면을 늘리지 않는다(knowledge_revisions 와 동일 판단).
    rest: [{ method: "GET", paths: ["/api/ui/review-queue/summary"], parse: () => ({}) }],
  },
  handler: async (_input: any, user: any) => {
    const memberId = String(user?.userId ?? "");
    // 팀 미설정·스키마 초기 등으로 실패해도 카운트 자체는 살린다(개인화만 빠짐 — 전체 건수는 여전히 유효).
    const cats = memberId ? await memberCategories(memberId).catch(() => []) : [];
    const owner = cats.filter((c) => c.owner);
    const counts = await reviewQueueCounts(owner.map((c) => c.category_id));
    return { ...counts, mine_category_keys: owner.map((c) => c.key) };
  },
};

// ⚠ REST 마운트 순서 주의 — knowledgeGrep(REST 경로는 그대로 /knowledge/search — 웹 지식탭 소비)는
//  반드시 knowledgeGet(/knowledge/:name) **앞**에 둔다(web.ts 가 배열순 app.get 마운트 → Express 선매치;
//  뒤에 두면 'search'/'overview'가 :name 으로 잡혀 404). MCP 등록은 이름목록 기반이라 순서 무관.
//  knowledge_graph(/knowledge-graph)·knowledge_link(/knowledge/:name/link)는 :name 단일세그먼트와 안 겹친다(경로 깊이 상이).
//  #592 정적 경로(knowledge-view-config·knowledge-comments)도 같은 규칙으로 :name 계열 **앞**에 둔다
//  (현 Express 패턴상 세그먼트가 달라 실충돌은 없지만, 순서 규칙을 지켜 미래 경로 추가에도 안전).
export const knowledgeCapabilities: Capability[] = [
  knowledgeList, knowledgeGrep, knowledgeSearch, knowledgeSimilar, knowledgeGraph, knowledgeTree,
  knowledgeViewGet, knowledgeViewSet, knowledgeCommentReaction,   // #592 정적 경로 — /:name 계열보다 먼저
  knowledgeRevisions, knowledgeRevisionGet, knowledgeRevisionReview,   // #783 수정 검토 큐(/knowledge-revisions* — :name 과 다른 경로)
  reviewQueueSummary,   // #802 검토 대기 카운트(/review-queue/summary — 대시보드·nav 배지)
  knowledgeGet,
  knowledgeSave, knowledgeSetLifecycle, knowledgeSetWiki, knowledgeDelete, knowledgeLinkCategory, knowledgeLink,
  knowledgePropsUi, knowledgeComments, knowledgeCommentPost, knowledgeMove,   // #592 :name 하위 경로(깊이 상이 — 순서 무관)
];
