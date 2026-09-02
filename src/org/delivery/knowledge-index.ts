// DB → 임시 디렉토리 materialize — 발행 시에만 org-content(DB)를 generator 가 기대하는 파일 트리로 굳힌다.
// 이렇게 하면 검증된 file-based generator(build-context.mjs)를 한 줄도 고치지 않고 재사용한다(D: 진실원천=DB,
// git/파일은 발행 순간의 임시 산물). generate() 규약(build-context.mjs:80-173):
//   - 필수: org/org-defaults.md (없으면 generator 가 종료) → 비어 있으면 최소 본문을 채운다.
//   - 선택: org/managed-policy.md, memory/knowledge-index.md(+ 링크된 memory/*.md, orgHas 가드로 누락은 스킵).
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrgProfile, getSection, getRuntimeConfig, listMembers } from "../store.js";
import { countKnowledge, listWikiPins, knowledgeVisWhere, PUBLIC_VIEWER, type KnowledgeRow } from "../../v6/knowledge-store.js";
import type { Viewer } from "../../v6/visibility.js";
import { redactString } from "../ingest/redact.js";
import { logger } from "../../log.js";

export interface Materialized {
  dir: string;
  orgName: string;
  cleanup: () => Promise<void>;
}

// ════════ V4-P3 주입 재설계 ════════
// v3 까지의 주입 = recalled-kind(K/H) 제목·요약 리스트 + 중요도 캡 + observed 제외 + distill 제외.
// v4 결정(plan §F·§J): **주입 = 검색(retrieval)**. 정적 랭킹/중요도/제목리스트 폐기.
//   (a) R(규칙) **전문 항상 주입**(enforced — 맥락무관 강제).
//   (b) **카테고리 지도** — 전 카테고리(key+name+active 유닛수)를 *작고 완전하게* 나열. 에이전트는 이 지도로
//       어떤 주제가 있는지 알고, 일에 맞춰 `카테고리+검색`(ctx_grep/memory_search/ctx_ls domain=)으로 그때 소환한다.
//   (c) **쓰기 가이드** — 언제/어디/무엇/분류/외부 를 헤더에 안내(지속지식이 생기면 in-flow 로 ctx_save).
// 제거: PER_KIND_CAP/TOTAL_CAP(중요도 캡)·recalled-kind 제목 리스트·observed 인덱스제외 필터·distill source_ref 제외절.
//   → K/H/W 는 정적 주입하지 않는다(카테고리 지도로 발견·검색으로 소환). importance 축 없음(맥락 상대적).
//   → observed 는 '주입 결정 안 함'으로 의미전환(주입은 출처 아닌 kind/검색이 결정) — overview observed_count·
//     팀메모리 구분은 별도로 유지(P5 정합).
// redact 게이트(assertNoHardSecrets 쓰기경로 + redactString 서빙경로)는 v4 에서도 유지(defense-in-depth).

// 카테고리 지도 한 항목 — v6 category(key/name) + knowledge_category(active 지식수). 모두 itemsPool 단일 DB.
export interface CategoryMapEntry {
  key: string;            // category.key(소환 시 domain= 인자)
  name: string;           // 사람용 표시명
  active_units: number;   // 이 카테고리에 매핑된 active knowledge 수(kc.state<>'rejected'). 발견용 메타.
  mine?: boolean;         // 보는 멤버의 팀이 소유/이해관계인 카테고리(team-scoped 주입에서만 채워짐 — 상단 정렬+★).
  // ⚠ #1153 에서 한 줄 설명(category.description)을 여기 붙였다가 **철회**했다. 정의를 읽혀야 하는 건 맞지만,
  //  분류 판단이 필요한 순간은 '지식을 저장할 때'뿐인데 그 비용을 전 세션에 항상 물리는 건 낭비다
  //  (온톨로지 원칙 "전부 미리 읽지 않는다 — 그때 소환한다"에도 역행). 정의는 category_list/category_get 이
  //  이미 실어 주고, 오분류는 knowledge_save 응답의 분류 점검이 그 자리에서 잡는다. 윤상민 판단, 2026-07-27.
}


// ── (라이브 헬퍼) R(규칙) 전문 — kind='R', lifecycle='active'. enforced 주입 대상. sort, name 순. ──
//  buildKnowledgeIndex 는 순수함수라 units 인자에서 R 을 직접 필터한다(아래). 이 헬퍼는 호출자 편의용(미사용 가능).

// ── (라이브 헬퍼) 카테고리 지도 — v6 category(key/name) + knowledge_category(active 지식수). 단일 DB(itemsPool). ──
//  V6: domain/knowledge_unit_domain → category/knowledge_category. 한 DB라 메모리 조인 불필요 — 두 쿼리(전 카테고리 + 카운트)면 충분.
//  fail-open: 조회가 죽어도 인덱스 생성이 500 나면 안 된다(빈 지도 반환 → 헤더만, 안내문은 유지).
// mineIds(선택) = 보는 멤버의 팀 소유/이해관계 카테고리 id 집합(team-store.memberCategoryIds). 주어지면 entry.mine 마킹.
//  생략(정적 발행·멤버 무관 경로)이면 mine 미설정 → 출력 불변(정적↔라이브 일치 불변식 유지).
// viewer(#1291)는 **필수 인자**다 — 이 지도는 매 세션 주입되는 인덱스의 일부고, 지식 수(N)는 "그 분류에 내가
//  못 보는 문서가 몇 건 있다"를 그대로 알려주는 카운트다(있는 줄도 몰라야 하는 게 잠금의 요점). 인자를 생략할 수
//  있게 두면 호출부 한 곳만 놓쳐도 조용히 샌다 → 조직 전체 배포물은 PUBLIC_VIEWER, 내부 특권 경로는 null 을 명시.
export async function categoryMapForIndex(viewer: Viewer, mineIds?: Set<number>): Promise<CategoryMapEntry[]> {
  try {
    const { itemsPool } = await import("../../db/client.js");
    // (1) 전 카테고리 — merged 제외. key 부분유니크. cross_cutting 먼저(교차관심사 상위 노출).
    //  ⚠ 카테고리 자체는 거르지 않는다 — 분류체계는 조직의 뼈대(빈 분류도 보여야 어디에 쓸지 판단한다)라
    //   가시성 주체가 아니다. 잠기는 건 그 안의 **지식**이고, 그래서 아래 카운트만 뷰어 기준으로 센다.
    const catRows = (await itemsPool.query(
      `SELECT c.id, c.key, c.name, c.cross_cutting
         FROM category c
        WHERE c.state <> 'merged'
        ORDER BY c.cross_cutting DESC, c.key`,
    )).rows;
    // (2) active 지식수/category — knowledge_category(rejected 제외) ⋈ knowledge(active). category_id 로 집계 후 key 로 환원.
    const cntParams: unknown[] = [];
    const cntVis = await knowledgeVisWhere(viewer, cntParams);
    const cntRows = (await itemsPool.query(
      `SELECT kc.category_id, COUNT(DISTINCT k.name)::int AS n
         FROM knowledge_category kc
         JOIN knowledge k ON k.name = kc.name AND k.lifecycle = 'active'
        WHERE kc.state <> 'rejected' AND ${cntVis}
        GROUP BY kc.category_id`, cntParams,
    )).rows;
    const cnt = new Map<number, number>();
    for (const r of cntRows) cnt.set(Number(r.category_id), Number(r.n) || 0);
    return catRows.map((c) => ({
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
//   `${categories}` = 카테고리 지도 항목('key — name (N)'), `${rules}` = 사용자-저작 강제 규칙(R) 전문.
//  편집값(섹션)이 비거나 DB 가 없으면 이 상수로 폴백 → 계약(온톨로지 골격) 안 깨짐. 기본값은 코드가 단일 출처
//  (쓰기 가이드는 이 템플릿의 '## 맥락 로드/기록 가이드' 섹션으로 통합 — 별도 블록 없음. 06-23 재설계).
export const DEFAULT_CONTEXT_ONTOLOGY_GUIDE = [
  // ⚠ '# Knowledge Index' H1 은 두지 않는다(#906) — 이 템플릿은 주입 블록의 한 섹션일 뿐이라 문서 제목이 필요 없다.
  //  라이블리 org 는 07-02 편집에서 이미 이 H1 을 뺐었고, 코드만 들고 있어 드리프트의 한 축이었다. 양쪽에서 제거해 통일.
  //  (materialize.test.ts 가 '0개'로 못박는다 — 무심코 되살리지 말 것.)
  "## 컨텍스트 온톨로지 개념 (맥락, 카테고리, 프로젝트, 지식)",
  // 이 한 줄은 라이블리 org 의 DB 섹션에만 있던 편집분을 코드 폴백으로 역이관한 것(#906) — 양쪽을 같게 유지한다.
  //  DB 행이 진실이고 코드는 폴백인데, 편집이 DB 에만 쌓이면 코드 릴리스로 지침을 못 배달한다(#537 함정).
  "라이브 데이터가 필요하면 MCP 툴(`knowledge_search`/`knowledge_grep`/`knowledge_get`, `category_*`, `db_query`, `project_*_v6`/`task_*_v6` 등)을 적극적으로 호출하여, 컨텍스트 온톨로지로부터 맥락(지식, 프로젝트 등)을 가져온다.",
  "",
  "**맥락(Context)** 은 일할 때 알아야 할 조직의 모든 것이다. 세 축으로 본다.",
  "",
  "- **카테고리 — 분류축.** 맥락을 *어디에 두는지*. 이 조직이 자기 일에서 뽑아낸 서랍들이고, 위에 고정된 상위 분류는 없다(무엇이 축이 될지는 조직마다 다르다). 각 축은 **정의(should)** — 무엇을 담고 무엇을 담지 않는지 — 를 갖는다. 코드가 붙는 축이면 거기에 구현·의존(**is**)과 둘의 갭(**debt**), 축 간 관계(엣지)가 더 붙어 **도메인맵**을 이룬다.",
  "- **지식 — 맥락의 *기록*(정적).** 지속되는 사실·결정·설계·런북. 카테고리 1개(단일 home)에 속한다 — 교차주제는 복수 카테고리 태깅이 아니라 `knowledge_link`(지식↔지식)로 잇는다(`knowledge_link_category`는 append 가 아니라 교체 시맨틱). 두 직교 속성 — **injection**(`always`=항상 주입되는 규칙·페르소나 / `recalled`=검색 소환), **provenance**(`authored`=저작 / `observed`=외부 미러).",
  "- **프로젝트 — 맥락의 *변화*(동적).** 맥락을 바꾸는 일. **project ▸ task ▸ subtask** 위계. 카테고리 1개(단일 home)에 속한다 — 프로젝트 간 관계는 `project_link_project_v6`(선후속 등)로 잇는다. **필요지식**(required)을 요구하고 **산출지식**(produced)을 만든다. 진척은 **작업(activity)** 으로 기록되고, 작업 중 **커밋은 도메인의 is**를, **비커밋(결정·리뷰 등)은 should**를 바꾼다.",
  "",
  "## 카테고리 (주제 — 검색으로 소환)",
  "관련 카테고리가 보이면 그걸로 검색(`knowledge_search`/`knowledge_grep`/`knowledge_list` category=)해 지식을 그때 소환한다.",
  "",
  "${categories}## 맥락 로드/기록 가이드",
  "",
  "*맥락을 다루는 규칙은 (조건 발동 훅이 아니라) 여기에 명시한다 — stop 훅 등은 보조 리마인더일 뿐이다.*",
  "",
  "**로드 — 필요한 맥락을 그때 소환한다 (전부 미리 읽지 않는다).**",
  "- 위 **카테고리** 목록에서 관련 주제를 찾는다.",
  "- 지식: `knowledge_search`(의미·자연어 — 벡터+grep RRF 하이브리드; 임베딩 off 면 grep 폴백) · `knowledge_grep`(정확 토큰/정규식 grep) · `knowledge_list`(category·injection 필터) · `knowledge_get`(name→전문, 부분읽기).",
  "- 도메인맵: `category_list` / `category_get`(should·is·debt·의존 엣지) · `category_edge_list`.",
  "- 프로젝트: `project_list_v6` / `project_get_v6`(태스크 위계·필요/산출지식).",
  "- 라이브 데이터(코드·DB): `db_query`(admin이면 별도 등록 없이 내장 `self` 소스로 이 라이블리 DB=지식·프로젝트·카테고리·도메인맵을 읽기전용 SQL 조회) · `context_overview`.",
  "- **외부 자료 미러**: 슬랙·메일·드라이브 등에서 커넥터가 끌어온 **원문**은 지식이 아니라 자료로 있다 — `source_list` · `source_get` · `source_undistilled`(아직 지식이 안 된 것). 노션·클릭업은 지식·프로젝트로 바로 들어와 있어 위 경로로 잡힌다.",
  "- **⚠ 사람의 초기 맥락은 라이블리 밖에 있을 수 있다** — 노션·클릭업·슬랙·메일에 먼저 쓰고 여기로 흘러온다. 그러니 \"라이블리에 없다 = 조직에 없다\"가 아니다. 커넥터가 덮는 범위는 위 경로로 이미 들어와 있으니 **먼저 라이블리에서 찾고**, 거기 없을 때만 외부를 직접 본다(`ext__*` 프록시 툴 — 개인·미공유 페이지, 커넥터 없는 툴, 방금 쓴 것). **끌어온 건 반드시 남긴다 → 아래 기록.**",
  // #1242(고객사 A: claude.ai 슬랙 커넥터 사용) — 코드 폴백만 고치면 섹션을 편집한 org 엔 안 닿는다(#537). 라이블리 org DB 행에도 같은 불릿을 반영해 양쪽을 같게 유지할 것.
  "- **⚠ 외부 서비스 MCP 는 라이블리 `ext__*` 가 기본이다(조직 통제)** — 같은 서비스(슬랙·노션·드라이브·메일 등)가 라이블리 프록시(`ext__*`)와 개인 커넥터(claude.ai 연동·자체 설치 MCP) 양쪽에 보이면 **반드시 `ext__*` 를 쓴다**. `ext__*` 는 조직이 관리하는 커넥터·자격·감사 경로로 나가고, 개인 커넥터는 개인 자격으로 그 통제를 우회한다. \"이미 로드돼 있어서\"·\"이름이 먼저 보여서\"는 선택 근거가 아니다. 그 서비스 커넥터가 라이블리에 없거나 실패할 때만 개인 커넥터로 폴백하고, 폴백했음을 답변에 밝힌다.",
  "",
  "**기록 — 지속될 맥락은 그 자리에서(in-flow), 나중에 몰아서가 아니라.**",
  "- 지식: 연구·결정·설계·런북이 생기면 즉시 `knowledge_save`로 **전문**을 기록한다(요약·링크 X). injection(규칙·페르소나만 `always`, 그 외 `recalled`)·provenance(`authored`)를 정하고 `knowledge_link_category`로 카테고리(제품이면 도메인)에 연결한다.",
  "- **MCP 도구는 대부분 REST로도 열려 있다 (`/api/ui/*`) — 같은 bearer 토큰·같은 scope.** 그래서 **코드로 짜서 호출하거나 대량 마이그레이션 같은 기계적 방식**이 나을 땐, 건별 MCP 대신 REST를 반복 호출하는 스크립트로 처리할 수 있다(거의 모든 쓰기 툴에 대응 REST 존재). 예: `POST /api/ui/knowledge`(=knowledge_save)·`POST /api/ui/knowledge/:name/category`(연결)·`POST /api/ui/sources`·`POST /api/ui/v6/projects[/:id/tasks]`·`POST /api/ui/activity`(=activity_log). 게이트웨이 주소는 org 프로필 `gateway_url`.",
  "- WIKI 인덱스 핀: 어떤 지식이 **모두가 항상 인덱스에서 봐야 할 만큼** 중요하면 `knowledge_set_wiki`로 핀한다 — 핀된 지식의 제목·소환키가 아래 **WIKI 인덱스**에 항상 노출되어 전원이 발견한다(본문은 여전히 `knowledge_get`/검색으로 소환).",
  "- 작업 진척: `activity_log`로 한 작업을 얇게 기록한다 — type 은 작업의 성격(feature·fix·decision·docs·research·review·chore·other). 커밋은 유형이 아니라 commit_sha 로 표현하고(어떤 유형이든 동반 가능), author_agent(어떤 AI)는 게이트웨이가 접속 신원으로 자동 식별하니 넘기지 않아도 된다. 커밋이면 건드린 코드(is)를, 비커밋이면 바뀐 의도(should)를 함께 표시하고, 실질 산출물은 지식으로 따로 써서 작업에 연결한다.",
  "- 프로젝트/태스크: `task_create_v6` / `task_set_status_v6`, 필요·산출지식은 `project_link_knowledge_v6`.",
  "- 도메인 의도: should 변경은 `category_update`, 도메인 간 의존(should 엣지)은 `category_edge_set` — is 엣지는 코드 스캔이 채운다.",
  "- 외부(클릭업·노션·코드): 원본은 외부 소유 → 미러(`observed`)로 둔다. 복제하지 말고, 거기서 얻은 **파생 인사이트만** 별도 지식(`authored`)으로 저작한다.",
  "- **외부에서 끌어온 건 남긴다** — `ext__*` 프록시나 외부 MCP 로 읽은 내용은 **세션이 끝나면 증발한다**(게이트웨이는 무엇을 읽었는지 안 남긴다 — 호출 로그에 응답이 없다). 그러니 조직에 남을 값이면: 미러가 이미 갖고 있으면(먼저 검색해 확인) **중복 저장 말고**, 라이블리에 없으면 `source_save`로 **원문**을 자료로 남긴다(외부 좌표 `external_*` 포함 — 나중에 미러와 이어진다). 파생 인사이트는 그와 별개로 `knowledge_save`.",
  "- **외부에 쓸 때도 라이블리가 먼저다** — 과업은 `ext__clickup__*`이 아니라 `project_create_v6`로 만든다(라이블리에 남고, 아웃박스가 클릭업에 껍데기를 만들어 링크백한다). 외부에 직접 쓰면 그 맥락이 라이블리에 안 남는다. 투영 경로가 없는 곳(노션 등)에서만 직접 쓰고, 그 땐 위 규칙대로 남긴다.",
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

// 가이드 섹션 키(단일) — 웹 관리 '세션 주입' 탭에 보이는 제품 소유 문서. (#1245) 편집 불가 — 코드가 단일 출처.
export const CONTEXT_ONTOLOGY_GUIDE_SECTION = "context-ontology-guide";

// 섹션 키 → 코드 기본값. (#1245) 이 맵의 키 = **잠금(제품 소유) 섹션**: 본문은 항상 이 코드 값이 주입되고(릴리스 = 갱신),
//  DB 행 본문은 무시된다(#537/#1242 행 동결 드리프트 차단). org 는 주입 여부(inject_ontology_guide)만 정한다.
//  delivery 가 편집 차단·기본값 노출에, publish 가 렌더에 재사용.
export const GUIDE_SECTION_DEFAULTS: Record<string, string> = {
  [CONTEXT_ONTOLOGY_GUIDE_SECTION]: DEFAULT_CONTEXT_ONTOLOGY_GUIDE,
};

// (#1245) 잠금 섹션 판정 — 편집 차단(delivery)·잠금 렌더(publish)·웹 표시가 같은 판정을 쓴다.
export const isLockedSection = (section: string): boolean => GUIDE_SECTION_DEFAULTS[section] !== undefined;

// (#1245) 섹션의 유효 템플릿 결정(순수) — 잠금 키는 DB 행 본문을 무시하고 항상 코드 기본값, 주입 토글 off 면 null(미주입).
//  일반 섹션은 행 본문 그대로. null 반환 = 그 섹션을 렌더하지 않는다.
export function effectiveSectionTemplate(section: string, bodyMd: string | null | undefined, guideOn: boolean): string | null {
  const locked = GUIDE_SECTION_DEFAULTS[section];
  if (locked !== undefined) return guideOn ? locked : null;
  return bodyMd ?? null;
}

// (#1245) loadGuideTemplate(DB 행 로드) 삭제 — 가이드는 코드 단일 출처가 되어 DB 를 읽지 않는다.
//  발행물·라이브 주입·미리보기 전부 GUIDE_SECTION_DEFAULTS/DEFAULT_CONTEXT_ONTOLOGY_GUIDE 로 수렴.

// ── 항상-주입 지식 인덱스(Knowledge Index — 본문 헤더 '# Knowledge Index') — 가이드 템플릿 + 동적 플레이스홀더(${rules}/${categories}/${wiki}). ──
//  입력 units = v6 listWikiPins()(활성 핀 전량) — ${wiki} 인덱스에 실을 대상 자체다(#1247. 구 계약은 'listKnowledge
//  활성 전체'였는데 실제로는 500건 페이지가 넘어와 창 밖 핀이 조용히 누락됐다). recalled 지식은 정적 주입하지
//  않는다(카테고리 지도로 발견·검색 소환). 비-링크 텍스트(본문 follow 차단 불변식 유지).
// H1-b 시크릿 출력게이트: 이 인덱스가 **항상-주입**(훅·정적 context.md·preview·web)의 단일 소스이므로 평문 시크릿이
//  섞이면 유출된다. 쓰기경로(ctx_save/org section)는 assertNoHardSecrets 로 hard-block 하지만 그 전 적재 레거시는
//  통과 못 했다. 서빙 경로에선 throw(전면 거부) 대신 **조립 결과 전체**를 emit 직전 redactString 으로 마스킹한다
//  (defense-in-depth·fail-open — 편집 가능해진 템플릿·동적 블록 모두 단일 choke-point 통과).
// categoryMap 인자는 호출자가 categoryMapForIndex() 로 라이브 조회해 넘긴다(non-stale·두 DB 조인). 생략 시 빈 지도.
// guideTemplate(편집값) 생략/공백이면 DEFAULT_CONTEXT_ONTOLOGY_GUIDE 폴백(순수함수·결정적 단위테스트 유지).
//
// (#335) ${rules}/buildRulesBlock·SECTION_R_NAMES 폐기 — 항상-주입은 '섹션 문서'(injection='always' 행, publish.buildSectionBlocks)뿐이다.
//  비-섹션 지식의 injection=always 경로는 제거됨(사용자 노출 X). 섹션 본문은 substituteBlocks 로 ${team}/${categories}/${wiki} 만 치환.

// ${categories} 치환 블록 — 전 카테고리를 'key — name (N)' 평면 목록. 없으면 "". 뒤따르는 ## 와 분리되게 \n\n 종결.
//  ⚠ #1631 이전엔 space(사업/제품/시스템) 소제목으로 묶었다. 그 축을 걷어냈으므로 묶음도 없앴다 —
//   축이 없는데 소제목만 남기면 없는 위계를 읽는 쪽에 가르치게 된다.
function buildCategoryBlock(categoryMap: CategoryMapEntry[]): string {
  if (!categoryMap.length) return "";
  // 우리 팀(mine) 카테고리를 상단으로 정렬하고 ★ 마킹(표면화 사이드바 '우리 팀 우선'의 텍스트 인덱스 판본).
  //  V8 sort 는 stable — mine 이 하나도 없으면(정적/멤버무관) 비교가 전부 0이라 들어온 순서(교차관심사→key) 그대로.
  const ordered = [...categoryMap].sort((a, b) => (a.mine === b.mine ? 0 : a.mine ? -1 : 1));
  const out = ordered.map((a) => {
    const n = a.active_units > 0 ? ` (${a.active_units})` : "";
    return `- ${a.key} — ${a.name}${n}${a.mine ? " ★" : ""}`;
  });
  return out.join("\n").trimEnd() + "\n\n";
}

// is_wiki 핀 지식의 name→대표 category.key(confirmed 우선) 라이브 조회 — buildWikiBlock 의 category 칩 소스.
//  categoryMapForIndex 와 동형(itemsPool dynamic import·fail-open 빈 맵). 호출자가 buildKnowledgeIndex 4번째 인자로 넘긴다.
//  ⚠ 여기엔 viewer 가 없다(의도) — 이 맵은 **열거되지 않는다**. buildWikiBlock 이 이미 걸러진 핀 목록을 돌며
//   name 으로 조회만 하므로(wikiCats.get), 안 보이는 문서의 항목은 애초에 조회되지 않아 출력에 닿지 못한다.
//   즉 잠금은 핀 목록(listWikiPins) 한 곳에서 걸린다 — 같은 규칙을 두 군데 두면 한쪽만 고치는 사본 결함이 생긴다.
export async function wikiCategoryMap(): Promise<Map<string, string>> {
  try {
    const { itemsPool } = await import("../../db/client.js");
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
//  wikiCats = name→대표 category.key(wikiCategoryMap 라이브 조회). 정렬은 sort,name. 본문 follow 차단 위해 비-링크.
//  ⚠ units 에는 **핀 전량**(listWikiPins)을 넘겨라 — 일반 목록의 한 페이지를 넘기면 아래 is_wiki 필터가
//   그 페이지 안에서만 골라, 창 밖 핀이 인덱스에서 조용히 빠진다(#1247 의 원인. 여기 필터는 방어용 멱등).
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

// 동적 블록 치환 — ${team}/${categories}/${wiki}. (#335 ${rules} 폐기: 항상-주입은 섹션 문서뿐.)
//  단일 소스: 섹션 조립(publish.buildSectionBlocks)·가이드 미리보기(org_guide_preview) 공용. 함수형 replacement($ 특수해석 회피).
//  consumedTeam.v 는 ${team} 가 실제 치환됐는지 호출자에 알린다(어느 섹션도 안 쓰면 팀블록 말미 폴백 부착용).
export function substituteBlocks(
  template: string,
  opts: {
    team?: string; categoryMap?: CategoryMapEntry[]; wikiUnits?: KnowledgeRow[];
    wikiCats?: Map<string, string>; consumedTeam?: { v: boolean };
  } = {},
): string {
  const assembled = (typeof template === "string" ? template : "")
    .replace(/\$\{team\}/g, () => { if (opts.consumedTeam) opts.consumedTeam.v = true; return (opts.team ?? "").trim(); })
    .replace(/\$\{categories\}/g, () => buildCategoryBlock(opts.categoryMap ?? []))
    .replace(/\$\{wiki\}/g, () => buildWikiBlock(opts.wikiUnits ?? [], opts.wikiCats ?? new Map()))
    .replace(/\$\{rules\}/g, ""); // (#335) 폐기된 ${rules} — 편집본에 잔존 시 리터럴 노출 방지(빈 문자열로 정리).
  // 빈 플레이스홀더로 생긴 과잉 공백/트레일링 정리 + 마스킹(편집 가능 템플릿·동적 블록 모두 단일 choke-point).
  return redactString(assembled).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// 하위호환 — 가이드 단일 템플릿 렌더(org_guide_preview·offline materializeOrgContent·테스트). 시그니처 유지(소비자 무수정).
//  units = ${wiki} 블록에 실을 **핀 전량**(listWikiPins) — 일반 목록 페이지가 아니다(#1247, buildWikiBlock 주석 참조).
export function buildKnowledgeIndex(
  units: KnowledgeRow[],
  categoryMap: CategoryMapEntry[] = [],
  guideTemplate?: string,
  wikiCats: Map<string, string> = new Map(),
): string {
  const tpl = (typeof guideTemplate === "string" && guideTemplate.trim()) ? guideTemplate : DEFAULT_CONTEXT_ONTOLOGY_GUIDE;
  return substituteBlocks(tpl, { categoryMap, wikiUnits: units, wikiCats }) + "\n";
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

  // (#335) managed-policy 폐기 — 데이터 없는 死섹션이라 발행 제외. 항상-주입 섹션은 buildKnowledgeIndex 가 가이드로 단일 발행.

  // memory/knowledge-index.md — v4 인덱스(R 전문 + 카테고리 지도 + 쓰기 가이드)만 발행. **본문 파일은 디스크에 안 쓴다** —
  //  K/H/W 본문은 ctx_cat(게이트웨이 pull)로 가져온다. 인덱스가 비-링크라 generator 의 본문 follow 도 안 걸림.
  //  buildKnowledgeIndex 가 단일 소스(previewMemberContext 와 공유) — 카테고리 지도는 라이브 조회(categoryMapForIndex).
  // ${wiki} 소스 = 핀 전량(#1247 — 일반 목록 500건 창에서 메모리 필터하던 구 경로는 창 밖 핀을 조용히 잃었다).
  //  발행 가드는 '지식이 하나라도 있나'를 묻는 축이라 핀 수가 아니라 활성 총계(countKnowledge)로 판정한다
  //  — 핀 0건이어도 카테고리 지도·쓰기 가이드는 발행 가치가 있으므로 기존 판정을 그대로 보존한다.
  // 공개범위(#1291) — 이 발행물은 **조직 전체(그리고 고객 박스)로 나가는 파일**이라 특정 멤버의 시야로 구우면 안 된다.
  //  PUBLIC_VIEWER = 아무 대상 지정에도 안 걸리는 뷰어 → 공개(open) 맥락만 담긴다. 아무도 안 잠근 조직에선 종전과 동일.
  const wikiPins = await listWikiPins(PUBLIC_VIEWER);
  const activeKnowledgeCount = await countKnowledge({ lifecycle: "active" }, PUBLIC_VIEWER);
  const categoryMap = await categoryMapForIndex(PUBLIC_VIEWER);
  // (#1245) 가이드는 코드 단일 출처 — DB 섹션 행을 읽지 않는다(행 동결 드리프트 #537/#1242 차단). buildKnowledgeIndex 는
  //  guideTemplate 미전달 시 DEFAULT 로 굽는다(라이브 주입 publish.buildSectionBlocks 와 동일 수렴). 주입 토글 off 면
  //  발행물에서도 인덱스를 뺀다(라이브 주입과 일치). 조회 실패는 켜짐(fail-open — 가이드는 시스템 사용법의 골격).
  let guideOn = true;
  try { guideOn = (await getRuntimeConfig()).inject_ontology_guide; } catch { /* fail-open */ }
  // R 전문이 있거나(규칙) 카테고리 지도가 있으면 인덱스 발행(쓰기 가이드는 템플릿에 항상 동반). 둘 다 없어도 가이드는
  //  의미가 있으나, 완전 빈 DB 에선 인덱스를 생략한다(기존 관례 — knowledge.length 가드).
  if (guideOn && (activeKnowledgeCount || categoryMap.length)) {
    await writeFile(join(dir, "memory", "knowledge-index.md"), buildKnowledgeIndex(wikiPins, categoryMap, undefined, await wikiCategoryMap()));
  }

  // members/_template.md — 개인 레이어 견본(발행물에 복사됨). 실제 멤버 파일도 함께 쓰되(게이트웨이 신원용)
  //  publish 는 _template 만 아티팩트에 포함하고 실제 멤버 파일은 제외한다(프라이버시).
  // ⚠ 구 견본은 "members/local.md 로 복사해 채우세요" 였는데 **local.md 를 읽는 코드가 없다**(#837).
  //  개인 레이어의 진실 출처는 org_member.body_md 하나뿐 — 내 프로필 창 [AI 개인 규칙] 탭이 쓰고
  //  (관리탭의 규칙 폼은 그 창으로 옮겨 갔다 — #1843·#1898),
  //  buildPersonalBlock() 이 읽어 매 세션 주입한다. 그래서 견본은 파일이 아니라 그 화면을 가리킨다.
  //  (담당 영역은 팀·카테고리 오너십이 이미 주입해 중복이라 #837 에서 뺐다.)
  await writeFile(join(dir, "members", "_template.md"),
    "# 개인 레이어 (견본 — 이 파일을 편집하지 마세요)\n\n"
    + "개인 규칙은 화면 왼쪽 아래 내 이름을 눌러 열리는 내 프로필 창의 **[AI 개인 규칙]** 에서 저장합니다. 저장하면 내 AI 세션 첫머리에 자동으로 실립니다.\n"
    + "(이 폴더의 `<멤버id>.md` 는 게이트웨이가 신원용으로 내보낸 사본입니다 — 손으로 고쳐도 반영되지 않습니다.)\n\n"
    + "담는 것 — 역할 / 호칭·말투 선호 / 그 밖에 나에게만 적용할 규칙\n");
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
