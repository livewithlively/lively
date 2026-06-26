// DB → 임시 디렉토리 materialize — 발행 시에만 org-content(DB)를 generator 가 기대하는 파일 트리로 굳힌다.
// 이렇게 하면 검증된 file-based generator(build-context.mjs)를 한 줄도 고치지 않고 재사용한다(D: 진실원천=DB,
// git/파일은 발행 순간의 임시 산물). generate() 규약(build-context.mjs:80-173):
//   - 필수: org/org-defaults.md (없으면 generator 가 종료) → 비어 있으면 최소 본문을 채운다.
//   - 선택: org/managed-policy.md, memory/knowledge-index.md(+ 링크된 memory/*.md, orgHas 가드로 누락은 스킵).
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrgProfile, getSection, listMembers } from "./store.js";
import { listKnowledge, type KnowledgeRow } from "../v6/knowledge-store.js";
import { redactString } from "./redact.js";
import { logger } from "../log.js";

export interface Materialized {
  dir: string;
  orgName: string;
  cleanup: () => Promise<void>;
}

// ════════ V4-P3 주입 재설계 ════════
// v3 까지의 주입 = recalled-kind(K/H) 제목·요약 리스트 + 중요도 캡 + observed 제외 + distill 제외.
// v4 결정(plan §F·§J): **주입 = 검색(retrieval)**. 정적 랭킹/중요도/제목리스트 폐기.
//   (a) R(규칙) **전문 항상 주입**(enforced — 맥락무관 강제).
//   (b) **카테고리 지도** — 전 카테고리(space+key+name+active 유닛수)를 *작고 완전하게* 나열. 에이전트는 이 지도로
//       어떤 주제가 있는지 알고, 일에 맞춰 `카테고리+검색`(ctx_grep/memory_search/ctx_ls domain=)으로 그때 소환한다.
//   (c) **쓰기 가이드** — 언제/어디/무엇/분류/외부 를 헤더에 안내(지속지식이 생기면 in-flow 로 ctx_save).
// 제거: PER_KIND_CAP/TOTAL_CAP(중요도 캡)·recalled-kind 제목 리스트·observed 인덱스제외 필터·distill source_ref 제외절.
//   → K/H/W 는 정적 주입하지 않는다(카테고리 지도로 발견·검색으로 소환). importance 축 없음(맥락 상대적).
//   → observed 는 '주입 결정 안 함'으로 의미전환(주입은 출처 아닌 kind/검색이 결정) — overview observed_count·
//     팀메모리 구분은 별도로 유지(P5 정합).
// redact 게이트(assertNoHardSecrets 쓰기경로 + redactString 서빙경로)는 v4 에서도 유지(defense-in-depth).

// 카테고리 지도 한 항목 — v6 category(space/key/name) + knowledge_category(active 지식수). 모두 itemsPool 단일 DB.
export interface CategoryMapEntry {
  space: string;          // 'business' | 'product'(코드앵커) | 'system' — v6 category.space
  key: string;            // category.key(소환 시 domain= 인자)
  name: string;           // 사람용 표시명
  active_units: number;   // 이 카테고리에 매핑된 active knowledge 수(kc.state<>'rejected'). 발견용 메타.
  mine?: boolean;         // 보는 멤버의 팀이 소유/이해관계인 카테고리(team-scoped 주입에서만 채워짐 — 공간 내 상단 정렬+★).
}


// ── (라이브 헬퍼) R(규칙) 전문 — kind='R', lifecycle='active'. enforced 주입 대상. sort, name 순. ──
//  buildKnowledgeIndex 는 순수함수라 units 인자에서 R 을 직접 필터한다(아래). 이 헬퍼는 호출자 편의용(미사용 가능).

// ── (라이브 헬퍼) 카테고리 지도 — v6 category(space/key/name) + knowledge_category(active 지식수). 단일 DB(itemsPool). ──
//  V6: domain/knowledge_unit_domain → category/knowledge_category. 한 DB라 메모리 조인 불필요 — 두 쿼리(전 카테고리 + 카운트)면 충분.
//  fail-open: 조회가 죽어도 인덱스 생성이 500 나면 안 된다(빈 지도 반환 → 헤더만, 안내문은 유지).
// mineIds(선택) = 보는 멤버의 팀 소유/이해관계 카테고리 id 집합(team-store.memberCategoryIds). 주어지면 entry.mine 마킹.
//  생략(정적 발행·멤버 무관 경로)이면 mine 미설정 → 출력 불변(정적↔라이브 일치 불변식 유지).
export async function categoryMapForIndex(mineIds?: Set<number>): Promise<CategoryMapEntry[]> {
  try {
    const { itemsPool } = await import("../items/store.js");
    // (1) 전 카테고리 — merged 제외. (space,key) 부분유니크. cross_cutting 먼저(교차관심사 상위 노출).
    const catRows = (await itemsPool.query(
      `SELECT c.id, c.space, c.key, c.name, c.cross_cutting
         FROM category c
        WHERE c.state <> 'merged'
        ORDER BY c.space, c.cross_cutting, c.key`,
    )).rows;
    // (2) active 지식수/category — knowledge_category(rejected 제외) ⋈ knowledge(active). category_id 로 집계 후 key 로 환원.
    const cntRows = (await itemsPool.query(
      `SELECT kc.category_id, COUNT(DISTINCT k.name)::int AS n
         FROM knowledge_category kc
         JOIN knowledge k ON k.name = kc.name AND k.lifecycle = 'active'
        WHERE kc.state <> 'rejected'
        GROUP BY kc.category_id`,
    )).rows;
    const cnt = new Map<number, number>();
    for (const r of cntRows) cnt.set(Number(r.category_id), Number(r.n) || 0);
    return catRows.map((c) => ({
      space: (c.space as string) ?? "product",
      key: c.key as string,
      name: (c.name as string) ?? (c.key as string),
      active_units: cnt.get(Number(c.id)) ?? 0,
      mine: mineIds ? mineIds.has(Number(c.id)) : false,
    }));
  } catch (err) {
    logger.warn({ err }, "카테고리 지도 조회 실패 — 빈 지도로 폴백(인덱스는 R 전문·가이드만)");
    return [];
  }
}

// ── 컨텍스트 온톨로지 가이드(주입 골격) — buildKnowledgeIndex 가 굽는 Knowledge Index **전체 템플릿**. ──
//  06-23 재설계(윤상민): 3섹션으로 쪼개지 않고 **하나의 편집 가능한 템플릿**. 동적 데이터는 플레이스홀더로 주입:
//   `${categories}` = 카테고리 지도 항목(space별 'key — name (N)'), `${rules}` = 사용자-저작 강제 규칙(R) 전문.
//  편집값(섹션)이 비거나 DB 가 없으면 이 상수로 폴백 → 계약(온톨로지 골격) 안 깨짐. 기본값은 코드가 단일 출처
//  (쓰기 가이드는 이 템플릿의 '## 맥락 로드/기록 가이드' 섹션으로 통합 — 별도 블록 없음. 06-23 재설계).
export const DEFAULT_CONTEXT_ONTOLOGY_GUIDE = [
  "# Knowledge Index",
  "",
  "${rules}## 컨텍스트 온톨로지 개념 (맥락, 카테고리, 프로젝트, 지식)",
  "",
  "**맥락(Context)** 은 일할 때 알아야 할 조직의 모든 것이다. 세 축으로 본다.",
  "",
  "- **카테고리 — 분류축.** 맥락을 *어디에 두는지*. 3 space: **사업**(개발 불필요 업무)·**제품**(개발 필요 업무)·**시스템**(조직·업무방식 등 메타). 각 space 아래 하위 카테고리가 있고, **제품의 하위 카테고리 = 도메인**이다. 도메인은 정의·범위·규칙(**should**) + 코드 구현·의존(**is**) + 둘의 갭(**debt**) + 도메인 간 관계(엣지)를 합쳐 **도메인맵**을 이룬다.",
  "- **지식 — 맥락의 *기록*(정적).** 지속되는 사실·결정·설계·런북. 여러 카테고리에 n:n 매핑. 두 직교 속성 — **injection**(`always`=항상 주입되는 규칙·페르소나 / `recalled`=검색 소환), **provenance**(`authored`=저작 / `observed`=외부 미러).",
  "- **프로젝트 — 맥락의 *변화*(동적).** 맥락을 바꾸는 일. **project ▸ task ▸ subtask** 위계. 여러 카테고리에 n:n. **필요지식**(required)을 요구하고 **산출지식**(produced)을 만든다. 진척은 **작업(activity)** 으로 기록되고, 작업 중 **커밋은 도메인의 is**를, **비커밋(결정·리뷰 등)은 should**를 바꾼다.",
  "",
  "## 카테고리 (주제 — 검색으로 소환)",
  "관련 카테고리가 보이면 그걸로 검색(`knowledge_grep`/`knowledge_list` category=)해 지식을 그때 소환한다.",
  "",
  "${categories}## 맥락 로드/기록 가이드",
  "",
  "*맥락을 다루는 규칙은 (조건 발동 훅이 아니라) 여기에 명시한다 — stop 훅 등은 보조 리마인더일 뿐이다.*",
  "",
  "**로드 — 필요한 맥락을 그때 소환한다 (전부 미리 읽지 않는다).**",
  "- 위 **카테고리** 목록에서 관련 주제를 찾는다.",
  "- 지식: `knowledge_grep`(텍스트 grep — 한 토큰/정규식, 자연어 문장 X) · `knowledge_list`(space·category·injection 필터) · `knowledge_get`(name→전문).",
  "- 도메인맵: `category_list` / `category_get`(should·is·debt·의존 엣지) · `category_edge_list`.",
  "- 프로젝트: `project_list_v6` / `project_get_v6`(태스크 위계·필요/산출지식).",
  "- 라이브 데이터(코드·DB): `db_query` · `context_overview`.",
  "",
  "**기록 — 지속될 맥락은 그 자리에서(in-flow), 나중에 몰아서가 아니라.**",
  "- 지식: 연구·결정·설계·런북이 생기면 즉시 `knowledge_save`로 **전문**을 기록한다(요약·링크 X). injection(규칙·페르소나만 `always`, 그 외 `recalled`)·provenance(`authored`)를 정하고 `knowledge_link_category`로 카테고리(제품이면 도메인)에 연결한다.",
  "- WIKI 인덱스 핀: 어떤 지식이 **모두가 항상 인덱스에서 봐야 할 만큼** 중요하면 `knowledge_set_wiki`로 핀한다 — 핀된 지식의 제목·소환키가 아래 **WIKI 인덱스**에 항상 노출되어 전원이 발견한다(본문은 여전히 `knowledge_get`/검색으로 소환).",
  "- 작업 진척: `activity_log`로 한 작업을 얇게 기록한다 — type 은 작업의 성격(feature·fix·decision·docs·research·review·chore·other). 커밋은 유형이 아니라 commit_sha 로 표현하고(어떤 유형이든 동반 가능), author_agent(어떤 AI)는 게이트웨이가 접속 신원으로 자동 식별하니 넘기지 않아도 된다. 커밋이면 건드린 코드(is)를, 비커밋이면 바뀐 의도(should)를 함께 표시하고, 실질 산출물은 지식으로 따로 써서 작업에 연결한다.",
  "- 프로젝트/태스크: `task_create_v6` / `task_set_status_v6`, 필요·산출지식은 `project_link_knowledge_v6`.",
  "- 도메인 의도: should 변경은 `category_update`, 도메인 간 의존(should 엣지)은 `category_edge_set` — is 엣지는 코드 스캔이 채운다.",
  "- 외부(클릭업·노션·코드): 원본은 외부 소유 → 미러(`observed`)로 둔다. 복제하지 말고, 거기서 얻은 **파생 인사이트만** 별도 지식(`authored`)으로 저작한다.",
  "",
  "**원칙**",
  "- 조직 지식의 유일한 집은 **WIKI**(지식 스토어)다 — 레포에 `.md`를 새로 만들거나 포인터만 남기지 않는다.",
  "- 전문을 담는다 — 나중의 나/동료가 그것만 읽고 일할 수 있도록.",
  "- **로컬 메모리와 WIKI는 직교다.** 하네스 로컬 메모리(예: Claude `~/.claude/.../memory`, Codex 메모리)는 **이 세션이 뿌리내린 스코프(작업 디렉터리 — 플젝 폴더든, 공유 워크스페이스 디렉터리든, 플젝과 무관한 경로든)에 바인딩**된다 — 다른 스코프에서 뜬 세션엔 **로드조차 안 된다**. ⚠ 라이블리 맥락은 플젝 유무·경로와 무관하게 주입되니 **\"지금 세션이 플젝 안\"이라 전제하지 말 것**.",
  "- 따라서 **이 한 세션-스코프를 넘어 가치 있는 모든 것**(다른 세션·다른 디렉터리/플젝·워크스페이스 전체·동료·다른 에이전트)은 로컬 금지 → 조직 지식(남에게도 가치 있는 것)은 WIKI(`knowledge_save`)에 올린다. 로컬은 \"오직 나·오직 이 세션-스코프 안\"일 때만. **\"AI가 어떻게 일해야 하나\" 류 피드백도 자동 로컬이 아니다** — 스코프 밖 누구든 득 보면 WIKI다.",
  "- 자문 한 줄: **이게 이 세션-스코프 밖 누군가·어딘가에서 쓰일 수 있나? → yes면 WIKI**.",
  "- 조직 지식의 **발견**은 이 인덱스(매 세션 주입)가 전담한다 — 로컬 메모리에 WIKI 포인터를 두지 않는다(중복·드리프트).",
  "",
  "${wiki}",
].join("\n");

// 가이드 섹션 키(단일) — 웹 관리 '컨텍스트 온톨로지 가이드' 탭. updateSection(kind='R') 로 저장.
export const CONTEXT_ONTOLOGY_GUIDE_SECTION = "context-ontology-guide";

// 섹션 키 → 코드 기본값(편집기 프리필·되돌리기·계약 폴백). delivery 가 화이트리스트·기본값 노출에 재사용.
export const GUIDE_SECTION_DEFAULTS: Record<string, string> = {
  [CONTEXT_ONTOLOGY_GUIDE_SECTION]: DEFAULT_CONTEXT_ONTOLOGY_GUIDE,
};

// 가이드 템플릿을 DB 에서 로드(라이브 주입·발행물 양 경로 공유). 빈/부재면 undefined → buildKnowledgeIndex 가 기본값 폴백.
//  getSection 은 store 가 이미 import 됨(순환 없음). 조회 실패 시 undefined(폴백).
export async function loadGuideTemplate(): Promise<string | undefined> {
  try { const s = await getSection(CONTEXT_ONTOLOGY_GUIDE_SECTION); return s?.body_md?.trim() || undefined; }
  catch { return undefined; }
}

// ── 항상-주입 지식 인덱스(Knowledge Index — 본문 헤더 '# Knowledge Index') — 가이드 템플릿 + 동적 플레이스홀더(${rules}/${categories}/${wiki}). ──
//  입력 units = v6 listKnowledge({lifecycle:"active"}) 전체. injection='always'(규칙·페르소나)만 전문으로 추려
//  ${rules} 에 박고, recalled 지식은 정적 주입하지 않는다(카테고리 지도로 발견·검색 소환). 비-링크 텍스트(본문 follow 차단 불변식 유지).
// H1-b 시크릿 출력게이트: 이 인덱스가 **항상-주입**(훅·정적 context.md·preview·web)의 단일 소스이므로 평문 시크릿이
//  섞이면 유출된다. 쓰기경로(ctx_save/org section)는 assertNoHardSecrets 로 hard-block 하지만 그 전 적재 레거시는
//  통과 못 했다. 서빙 경로에선 throw(전면 거부) 대신 **조립 결과 전체**를 emit 직전 redactString 으로 마스킹한다
//  (defense-in-depth·fail-open — 편집 가능해진 템플릿·동적 블록 모두 단일 choke-point 통과).
// categoryMap 인자는 호출자가 categoryMapForIndex() 로 라이브 조회해 넘긴다(non-stale·두 DB 조인). 생략 시 빈 지도.
// guideTemplate(편집값) 생략/공백이면 DEFAULT_CONTEXT_ONTOLOGY_GUIDE 폴백(순수함수·결정적 단위테스트 유지).
//
// 중복 주입 방지: org_content 섹션 R(managed-policy·org-defaults)·가이드 섹션은 ${rules} 전문 주입에서 제외 —
//  앞 둘은 전용 경로(머리말 prepend·생성기 org/*.md)로 세션당 1회 전달되고, 가이드 섹션은 그 자체가 이 템플릿이다.
const SECTION_R_NAMES = new Set<string>([
  "managed-policy", "org-defaults", CONTEXT_ONTOLOGY_GUIDE_SECTION,
]);

// ${rules} 치환 블록 — 사용자-저작 항상-주입 지식(섹션 제외) 전문. 없으면 "". 있으면 헤더+전문, 뒤따르는 ## 와 분리되게 \n\n 종결.
//  V6: kind='R' → injection='always'(규칙·페르소나 항상 주입). 섹션 제외/정렬/전문 emit 동일.
function buildRulesBlock(units: KnowledgeRow[]): string {
  const rules = units
    .filter((u) => u.injection === "always" && u.lifecycle === "active" && !SECTION_R_NAMES.has(u.name))
    .sort((a, b) => (Number(a.sort) - Number(b.sort)) || a.name.localeCompare(b.name));
  if (!rules.length) return "";
  const out: string[] = ["## 강제 규칙 (R · 항상 적용)", ""];
  for (const u of rules) {
    out.push(`### ${u.title?.trim() || u.name}`);
    const body = (u.body_md ?? "").trim();
    if (body) out.push(body);
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n\n";
}

// ${categories} 치환 블록 — 전 카테고리를 space(product→business)별 'key — name (N)'. 없으면 "". 뒤따르는 ## 와 분리되게 \n\n 종결.
function buildCategoryBlock(categoryMap: CategoryMapEntry[]): string {
  if (!categoryMap.length) return "";
  const order = (s: string): number => (s === "product" ? 0 : s === "business" ? 1 : 2);
  const spaces = [...new Set(categoryMap.map((a) => a.space))].sort((x, y) => order(x) - order(y) || x.localeCompare(y));
  const out: string[] = [];
  for (const sp of spaces) {
    out.push(`### ${sp}`);
    // 우리 팀(mine) 카테고리를 공간 내 상단으로 정렬하고 ★ 마킹(표면화 사이드바 '우리 팀 우선'의 텍스트 인덱스 판본).
    //  V8 sort 는 stable — mine 이 하나도 없으면(정적/멤버무관) 비교가 전부 0이라 기존 순서·출력 불변.
    const ordered = [...categoryMap.filter((x) => x.space === sp)].sort((a, b) => (a.mine === b.mine ? 0 : a.mine ? -1 : 1));
    for (const a of ordered) {
      const n = a.active_units > 0 ? ` (${a.active_units})` : "";
      out.push(`- ${a.key} — ${a.name}${n}${a.mine ? " ★" : ""}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n\n";
}

// is_wiki 핀 지식의 name→대표 category.key(confirmed 우선) 라이브 조회 — buildWikiBlock 의 category 칩 소스.
//  categoryMapForIndex 와 동형(itemsPool dynamic import·fail-open 빈 맵). 호출자가 buildKnowledgeIndex 4번째 인자로 넘긴다.
export async function wikiCategoryMap(): Promise<Map<string, string>> {
  try {
    const { itemsPool } = await import("../items/store.js");
    const rows = (await itemsPool.query(
      `SELECT DISTINCT ON (kc.name) kc.name, c.key
         FROM knowledge_category kc
         JOIN category c ON c.id = kc.category_id
         JOIN knowledge k ON k.name = kc.name AND k.is_wiki AND k.lifecycle = 'active'
        WHERE kc.state <> 'rejected' AND c.state <> 'merged'
        ORDER BY kc.name, (kc.state = 'confirmed') DESC, c.cross_cutting DESC, kc.category_id`)).rows;
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.name as string, r.key as string);
    return m;
  } catch (err) {
    logger.warn({ err }, "wiki category 맵 조회 실패 — 빈 맵 폴백(wiki 블록은 category 칩 없이 렌더)");
    return new Map();
  }
}

// ${wiki} 치환 블록 — is_wiki 핀 지식의 '소환키 — 제목 · category' 한 줄씩(본문 제외, 인덱스). 없으면 "". 뒤 ## 와 \n\n 분리.
//  wikiCats = name→대표 category.key(wikiCategoryMap 라이브 조회). buildRulesBlock 과 동일 정렬(sort,name). 본문 follow 차단 위해 비-링크.
function buildWikiBlock(units: KnowledgeRow[], wikiCats: Map<string, string>): string {
  const wiki = units
    .filter((u) => u.is_wiki && u.lifecycle === "active")
    .sort((a, b) => (Number(a.sort) - Number(b.sort)) || a.name.localeCompare(b.name));
  if (!wiki.length) return "";
  const out: string[] = ["## WIKI 인덱스 (핀 — 제목·소환키만, 본문은 `knowledge_get` 으로)", ""];
  for (const u of wiki) {
    const cat = wikiCats.get(u.name);
    out.push(`- ${u.name} — ${u.title?.trim() || u.name}${cat ? ` · ${cat}` : ""}`);
  }
  return out.join("\n").trimEnd() + "\n\n";
}

export function buildKnowledgeIndex(
  units: KnowledgeRow[],
  categoryMap: CategoryMapEntry[] = [],
  guideTemplate?: string,
  wikiCats: Map<string, string> = new Map(),
): string {
  // 편집값(섹션) 우선, 비면 코드 기본 템플릿(계약 폴백).
  const tpl = (typeof guideTemplate === "string" && guideTemplate.trim()) ? guideTemplate : DEFAULT_CONTEXT_ONTOLOGY_GUIDE;
  // 동적 블록 치환 — 함수형 replacement(치환문자열의 $ 특수해석 회피). ${rules}=R 전문, ${categories}=카테고리 지도, ${wiki}=핀 인덱스.
  const assembled = tpl
    .replace(/\$\{rules\}/g, () => buildRulesBlock(units))
    .replace(/\$\{categories\}/g, () => buildCategoryBlock(categoryMap))
    .replace(/\$\{wiki\}/g, () => buildWikiBlock(units, wikiCats));
  // 조립 결과 전체 마스킹(편집 가능 템플릿·동적 블록 모두) + 빈 플레이스홀더로 생긴 과잉 공백/트레일링 정리 → 단일 개행 종결.
  return redactString(assembled)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

// YAML 스칼라 안전화 — load-bindings 미니 파서는 "..."/'...' 인용 스칼라를 받지만 \" 언이스케이프는 안 한다.
//  따라서 개행/따옴표를 제거 후 큰따옴표로 감싼다(인젝션·줄깨짐 방지). 빈 값 → "".
const yv = (s: string | undefined | null): string => '"' + String(s ?? "").replace(/[\r\n"]+/g, " ").trim() + '"';

// 구성원 frontmatter — load-bindings 미니 파서가 읽는 고정 스키마(identities 객체 리스트). 값은 전부 인용(안전).
function memberFrontmatter(m: {
  id: string; kind: string; display_name: string | null;
  identities: { system: string; external_id: string; email?: string; instance?: string; display_name?: string }[];
}): string {
  const out = ["---", `id: ${yv(m.id)}`, `kind: ${yv(m.kind)}`, `display_name: ${yv(m.display_name ?? m.id)}`];
  if (m.identities.length) {
    out.push("identities:");
    for (const idn of m.identities) {
      out.push(`  - system: ${yv(idn.system)}`);
      out.push(`    external_id: ${yv(idn.external_id)}`);
      if (idn.email) out.push(`    email: ${yv(idn.email)}`);
      if (idn.instance) out.push(`    instance: ${yv(idn.instance)}`);
      if (idn.display_name) out.push(`    display_name: ${yv(idn.display_name)}`);
    }
  }
  out.push("---", "");
  return out.join("\n");
}

export async function materializeOrgContent(): Promise<Materialized> {
  const dir = await mkdtemp(join(tmpdir(), "lively-org-"));
  const profile = await getOrgProfile();
  const orgName = profile.display_name?.trim() || profile.name?.trim() || "조직";

  await mkdir(join(dir, "org"), { recursive: true });
  await mkdir(join(dir, "members"), { recursive: true });
  await mkdir(join(dir, "memory"), { recursive: true });

  // org/org-defaults.md — 필수. generator 의 strip()(frontmatter/HTML주석 제거) 후 빈 본문이면
  //  AGENTS.md 가 거의 빈 채로 발행되므로, '의미 있는 본문'이 남는지(strip 후 비어있지 않은지)로 판정.
  const stripMd = (md: string): string =>
    md.replace(/^<!--[\s\S]*?-->\s*/, "").replace(/^---[\s\S]*?---\s*/, "").trim();
  const defaults = await getSection("org-defaults");
  const defaultsBody = defaults?.body_md && stripMd(defaults.body_md)
    ? defaults.body_md
    : `# ${orgName} 공통 컨텍스트\n\n(아직 작성되지 않음 — 관리 UI에서 회사 맥락·페르소나·업무방식을 채우세요.)\n`;
  await writeFile(join(dir, "org", "org-defaults.md"), defaultsBody);

  // org/managed-policy.md — 선택.
  const policy = await getSection("managed-policy");
  if (policy?.body_md?.trim()) {
    await writeFile(join(dir, "org", "managed-policy.md"), policy.body_md);
  }

  // memory/knowledge-index.md — v4 인덱스(R 전문 + 카테고리 지도 + 쓰기 가이드)만 발행. **본문 파일은 디스크에 안 쓴다** —
  //  K/H/W 본문은 ctx_cat(게이트웨이 pull)로 가져온다. 인덱스가 비-링크라 generator 의 본문 follow 도 안 걸림.
  //  buildKnowledgeIndex 가 단일 소스(previewMemberContext 와 공유) — 카테고리 지도는 라이브 조회(categoryMapForIndex).
  const knowledge = await listKnowledge({ lifecycle: "active", limit: 500 });
  const categoryMap = await categoryMapForIndex();
  // 컨텍스트 온톨로지 가이드 템플릿은 DB 섹션에서 — 라이브 미리보기(previewMemberContext)와 동일 소스라
  //  발행물↔미리보기 일치. 편집 안 했으면 빈 섹션 → buildKnowledgeIndex 가 코드 기본 템플릿 폴백.
  const guide = await loadGuideTemplate();
  // R 전문이 있거나(규칙) 카테고리 지도가 있으면 인덱스 발행(쓰기 가이드는 템플릿에 항상 동반). 둘 다 없어도 가이드는
  //  의미가 있으나, 완전 빈 DB 에선 인덱스를 생략한다(기존 관례 — knowledge.length 가드).
  if (knowledge.length || categoryMap.length) {
    await writeFile(join(dir, "memory", "knowledge-index.md"), buildKnowledgeIndex(knowledge, categoryMap, guide, await wikiCategoryMap()));
  }

  // members/_template.md — 개인 레이어 견본(발행물에 복사됨). 실제 멤버 파일도 함께 쓰되(게이트웨이 신원용)
  //  publish 는 _template 만 아티팩트에 포함하고 실제 멤버 파일은 제외한다(프라이버시).
  await writeFile(join(dir, "members", "_template.md"),
    "# 개인 레이어 (members/local.md 로 복사해 채우세요)\n\n- 역할:\n- 호칭/말투 선호:\n- 담당 영역:\n");
  for (const m of await listMembers()) {
    if (m.state !== "active") continue;
    const body = (m.body_md ?? "").trim();
    await writeFile(join(dir, "members", `${m.id}.md`),
      memberFrontmatter(m) + (body ? body + "\n" : ""));
  }

  return {
    dir,
    orgName,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
