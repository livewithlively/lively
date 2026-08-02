// delivery ▸ org-content — 조직 프로필·세션 주입 섹션·멤버 컨텍스트 미리보기·온보딩 안내.
import type { Capability, CapabilityCtx } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { isValidTimezone, DEFAULT_TZ } from "../../org/timezone.js"; // #778 조직 시간대 검증·기본값
import { previewMemberContext } from "../../org/delivery/publish.js";
import { GUIDE_SECTION_DEFAULTS } from "../../org/delivery/knowledge-index.js";
import { DEFAULT_WRITEBACK_NOTICE } from "../../org/delivery/hook-defaults.js";
import { assertNoHardSecrets } from "../../org/ingest/redact.js";
import {
  getOrgProfile, updateOrgProfile, listSections, updateSection, deleteSection, setSectionsOrder, sectionNameInUse, getRuntimeConfig
} from "../../org/store.js";
import { learnGroundTruth } from "../../org/knowledge.js";
import { actorOf, restOnly, restRead, str } from "./shared.js";

// 세션 주입 섹션 — DB 행 + 코드 기본값 fold.
type SectionRow = { body_md: string; version: number; sort: number; updated_at: string | null; updated_by: string | null };
export async function sectionsPayload(): Promise<{ sections: Record<string, SectionRow>; sectionDefaults: typeof GUIDE_SECTION_DEFAULTS; lockedSections: string[]; injectOntologyGuide: boolean; writebackNoticeDefault: string }> {
  const sections = await listSections();
  const sectionMap: Record<string, SectionRow> = {};
  for (const s of sections) sectionMap[s.section] = { body_md: s.body_md, version: s.version, sort: s.sort, updated_at: s.updated_at, updated_by: s.updated_by };
  // (#1245) 잠금(제품 소유) 섹션 — 행이 없으면 코드 기본값으로 패딩(version:0)하고, 행이 **있어도 본문은 코드 기본값으로
  //  덮어 보여준다**(주입이 그렇게 되므로 화면=실주입 일치 — 구 행 본문은 dead). lockedSections 가 웹 read-only 판정의 소스.
  for (const [k, def] of Object.entries(GUIDE_SECTION_DEFAULTS)) {
    if (!sectionMap[k]) sectionMap[k] = { body_md: def, version: 0, sort: 99, updated_at: null, updated_by: null };
    else sectionMap[k] = { ...sectionMap[k], body_md: def };
  }
  // 주입 토글(#1245) — 조회 실패는 켜짐(fail-open, publish 와 동일).
  let injectOntologyGuide = true;
  try { injectOntologyGuide = (await getRuntimeConfig()).inject_ontology_guide; } catch { /* fail-open */ }
  // writebackNoticeDefault: 세션종료 너지 기본값 — 웹 편집기가 표시·되돌리기에 사용
  return { sections: sectionMap, sectionDefaults: GUIDE_SECTION_DEFAULTS, lockedSections: Object.keys(GUIDE_SECTION_DEFAULTS), injectOntologyGuide, writebackNoticeDefault: DEFAULT_WRITEBACK_NOTICE };
}

export const orgContentReadCapabilities: Capability[] = [
  // ── org_overview 의 분해(#1169) — 관리탭 메뉴 단위 읽기 표면 ──
  //  사연: restRead 는 mcp 기본 false 라(위 restRead 주석) **MCP 에 열린 관리 읽기 표면은 org_overview 하나뿐**이었다.
  //   그래서 에이전트가 게이트웨이 주소 한 줄이 필요해도 관리탭 전체 덤프(+admin 이면 토큰 해시 전량)를 컨텍스트에
  //   실어야 했다. 아래로 메뉴 단위를 갈라 필요한 것만 부르게 하고, org_overview 는 화면 전용(REST)으로 내렸다.
  //  ⚠ 불변식: org_overview 가 MCP 로 주던 필드는 **전부** 아래 어딘가에서 같은 모양으로 나와야 한다(정보 손실 0).
  //   대응표 — profile→org_profile · sections/sectionDefaults/writebackNoticeDefault→org_sections ·
  //   (memory 는 #1256 에서 양쪽 모두 제거 — 소비자 없는 4.3MB 잔여 표면. 핀은 knowledge_list{is_wiki:true}) ·
  //   members→org_members · tokens→org_tokens · connectors→org_connectors · runtimeConfig→org_runtime_config ·
  //   mcpServers→org_mcp_servers · dbSources/envSources→org_db_sources · orgHooks→org_hooks ·
  //   orgHarnessAssets→org_harness_assets · orgAssetPrefs→org_asset_prefs · tools/builtins/toolPolicy→org_tools.

  restRead("org_profile", "조직 정보 조회",
    "관리탭 [조직 정보] — 조직 이름·표시명·**게이트웨이 주소(gateway_url)**·시간대(IANA) + 편집 메타(version·updated_at/by). " +
    "⚠ 사람에게 줄 링크를 만들 목적이라면 whoami 의 org.gateway_url 이 더 싸다(alwaysLoad — 추가 호출 없이 이미 와 있다). 수정은 org_update_profile.",
    [{ method: "GET", paths: ["/api/ui/org/profile"], parse: () => ({}) }],
    // meaning — org_overview 는 MEANING **전량**을 줬다. 분해하면서 조각이 새지 않도록 각 툴이 자기 메뉴의 키를
    //  가져간다(이 툴: 조직 정보 3개). 15개 키가 전부 어딘가에 실리는지는 분해 주석의 대응표와 함께 지킨다.
    async () => ({
      profile: await getOrgProfile(),
      meaning: { "gateway-url": MEANING["gateway-url"], timezone: MEANING["timezone"], display_name: MEANING["display_name"] },
    }), true),

  // (#1256) memory 페이로드 제거 — 구 org_memory('WIKI 인덱스') 잔여 표면이었다. 웹 소비자가 없고(관리탭
  //  '메모리' 탭은 #1059 RAM 게이지로 이름만 같다), 핀 목록의 정본은 knowledge_list{is_wiki:true}·주입은
  //  listWikiPins 다. 남겨 둔 대가가 컸다: injection=recalled 500건을 **본문까지** 실어 이 응답이 4.3MB
  //  (고객사 A 실박스 실측 2026-07-30: /api/ui/org/sections 4,371KB 중 4,356KB가 이 필드, body_md 4,137KB).
  //  게다가 #1247 과 같은 LIMIT-후-필터라 소비자가 is_wiki 로 고르면 창 밖 핀이 조용히 빠졌다(그 실측에선 1/3).
  restRead("org_sections", "세션 주입 섹션 조회",
    "관리탭 [세션 주입] — 구성원 AI 가 매 세션 읽는 정적 컨텍스트의 **원본 섹션 본문**(sections: 섹션키→{body_md,version,sort,updated_at/by}) + " +
    "코드 기본값(sectionDefaults — version:0 은 '미저장, 기본값이 유효'라는 뜻) + 세션종료 너지 기본문구(writebackNoticeDefault). " +
    "사람이 실제로 읽는 **렌더 결과**는 org_preview 다. 수정은 org_update_section. " +
    "WIKI 인덱스 핀 목록은 여기가 아니라 knowledge_list{is_wiki:true} 다(#1256 구 memory 필드 제거).",
    [{ method: "GET", paths: ["/api/ui/org/sections"], parse: () => ({}) }],
    async () => ({
      ...await sectionsPayload(),
      meaning: { "context-ontology-guide": MEANING["context-ontology-guide"], "org-defaults": MEANING["org-defaults"] },
    }), true),
];

export const orgContentCapabilities: Capability[] = [
  // ── 멤버 컨텍스트 미리보기(WYSIWYG: 구성원 AI 가 실제 읽는 정적 컨텍스트) ──
  restRead("org_preview", "멤버 컨텍스트 미리보기",
    "구성원의 AI 가 매 세션 첫머리에 실제로 읽는 정적 컨텍스트를 렌더한다(공유 맥락 — 비-admin 도 열람).",
    [{ method: "GET", paths: ["/api/ui/org/preview"], parse: () => ({}) }],
    async (_input, user) => {
      const p = await getOrgProfile();
      const name = p.display_name?.trim() || p.name?.trim() || "조직";
      // 팀-스코프 주입: bearer principal(=org_member.id)로 '우리 팀' 카테고리를 상단 정렬·프리앰블. 익명/미소속이면 org-wide.
      const memberId = (user as { userId?: string } | undefined)?.userId || undefined;
      return { context: await previewMemberContext(name, memberId) };
    }),

  // ── 온보딩 진행상황(SoT) — 웹 '온보딩' 페이지와 하네스 주입(previewMemberContext)이 같은 소스를 소비. ──
  restRead("org_onboarding", "온보딩 진행상황",
    "조직 셋업 단계별 완료 여부(회사·페르소나/카테고리/지식/구성원/데이터소스)를 라이브 계산해 반환한다(공유 — 비-admin 도 열람).",
    [{ method: "GET", paths: ["/api/ui/org/onboarding"], parse: () => ({}) }],
    async () => {
      const { computeOnboardingStatus } = await import("../../org/delivery/onboarding.js");
      return await computeOnboardingStatus();
    }),

  // ── 컨텍스트 온톨로지 가이드 미리보기 — '이 편집 부분만'(Knowledge Index) 을 렌더한다. ──
  //  body_md(미저장 편집값)를 받아 ${rules}/${area} 를 라이브 데이터로 채워 실제 주입 모습을 보여준다(WYSIWYG, 편집 즉시).
  //  body_md 생략/공백이면 buildKnowledgeIndex 가 코드 기본 템플릿으로 폴백. 공유 맥락 미리보기라 scope null(인증만).
  {
    name: "org_guide_preview", mutates: false, title: "컨텍스트 온톨로지 가이드 미리보기", // 읽기전용(#1007): POST 지만 읽기(미리보기 렌더, 스토어 쓰기 없음)
    description: "컨텍스트 온톨로지 가이드 템플릿(편집값)에 카테고리·강제규칙을 채워 실제 주입되는 Knowledge Index 만 렌더한다(전체 맥락 아님).",
    scope: null, input: {}, expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/org/guide-preview"], parse: (req) => req.body ?? {} }] },
    handler: async (input: Record<string, unknown>, _user: LivelyUser, ctx?: CapabilityCtx) => {
      const bodyMd = typeof input?.body_md === "string" ? input.body_md : undefined;
      const { buildKnowledgeIndex, categoryMapForIndex, wikiCategoryMap } = await import("../../org/delivery/knowledge-index.js");
      const { listWikiPins } = await import("../../v6/knowledge-store.js");
      // 핀 전량(#1247) — 미리보기가 실제 주입(previewMemberContext)과 같은 소스를 봐야 WYSIWYG 이 성립한다.
      //  #1291 — 그 '같은 소스'에는 공개범위도 포함된다(요청자 시야로 렌더).
      const viewer = ctx?.viewer ?? null;
      const [wikiPins, categoryMap, wikiCats] = await Promise.all([listWikiPins(viewer), categoryMapForIndex(viewer), wikiCategoryMap()]);
      return { context: buildKnowledgeIndex(wikiPins, categoryMap, bodyMd, wikiCats) };
    },
  },

  // ── 지식유형/수집 ground-truth(#/learn) — kind_registry + data_source 를 그대로 렌더(비개발자 학습 화면). ──
  //  D-GT: 분류기준·저장방식·전달방식·소스별 수집방식의 단일 출처. 읽기전용(scope null = 인증만), REST 전용.
  //  런북(build-classify-runbook.mjs)과 동일 데이터(learnGroundTruth) → 양 표면 non-stale 일관.
  restRead("learn", "지식유형/수집 안내",
    "통합 지식스토어가 분류하는 12개 지식 종류(정의·분류기준·저장방식·전달방식)와 데이터소스별 수집방식을 ground-truth(kind_registry·data_source)에서 그대로 반환한다(비개발자 학습 화면 #/learn).",
    [{ method: "GET", paths: ["/api/ui/learn"], parse: () => ({}) }],
    async () => learnGroundTruth()),

  // ── 프로필(표시명·게이트웨이 주소·시간대) ──
  restOnly("org_update_profile", "조직 프로필 수정",
    "조직 표시명/게이트웨이 주소/시간대를 수정한다. timezone 은 IANA 존(예 Asia/Seoul) — 스케줄러 cron 의 벽시계 기준이자 웹터미널 세션의 TZ.",
    [{ method: "POST", paths: ["/api/ui/org/profile"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const patch: { name?: string; display_name?: string; gateway_url?: string; timezone?: string } = {};
      if (input.name !== undefined) patch.name = str(input.name, "name", 200).trim();
      if (input.display_name !== undefined) patch.display_name = str(input.display_name, "display_name", 200).trim();
      if (input.gateway_url !== undefined) patch.gateway_url = str(input.gateway_url, "gateway_url", 500).trim();
      // 시간대(#778) — 저장 전 IANA 검증. 빈 값 = 기본값(DEFAULT_TZ)으로 되돌림.
      //  이 값은 cron 해석·일자 집계·세션 pane TZ 로 흘러가므로 여기가 유일한 진입 게이트다.
      if (input.timezone !== undefined) {
        const tz = str(input.timezone, "timezone", 64).trim();
        if (tz && !isValidTimezone(tz)) throw new HttpError(400, `알 수 없는 시간대입니다: '${tz}' (IANA 존 — 예: Asia/Seoul, UTC)`);
        patch.timezone = tz || DEFAULT_TZ;
      }
      return { profile: await updateOrgProfile(patch, actorOf(user), "web") };
    }, {
      name: z.string().optional().describe("조직 이름"),
      display_name: z.string().optional().describe("조직 표시명"),
      gateway_url: z.string().optional().describe("게이트웨이 주소(구성원 설치·접속의 기준)"),
      timezone: z.string().optional().describe("IANA 시간대(예 Asia/Seoul) — 스케줄러 cron 의 벽시계이자 웹터미널 세션 TZ. 빈 문자열이면 기본값 복귀"),
    }),

  // ── 항상-주입 섹션(injection='always' 문서) 관리 — N개 생성/편집/삭제/재정렬 (#335). ──
  //  매 세션 컨텍스트에 sort 순으로 조립된다. 죽은 ${rules}(지식-always)·고정 3섹션 화이트리스트 폐기.
  restOnly("org_update_section", "조직 섹션 저장",
    "항상-주입 섹션(injection='always' markdown 문서)을 생성/편집한다. 신규는 sort 말미. 본문에 ${team}/${categories}/${wiki} 치환됨. "
    + "⚠ 제품 소유 가이드(context-ontology-guide)는 편집 불가 — 코드가 단일 출처(릴리스마다 자동 갱신)이고, 주입 여부만 org_runtime_update 의 inject_ontology_guide 로 제어한다(#1245).",
    [{ method: "POST", paths: ["/api/ui/org/section"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const section = str(input.section, "section", 64).trim().toLowerCase();
      // 섹션 키 = knowledge.name(PK) — 슬러그(소문자·숫자·하이픈, 2–64자)만 허용.
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(section)) {
        throw new HttpError(400, "섹션 키는 소문자·숫자·하이픈만(2–64자) 허용됩니다");
      }
      // (#1245) 잠금(제품 소유) 섹션 — 편집을 서버에서 차단(웹·REST·MCP 공통 choke-point). DB 행을 만들어 봤자
      //  본문은 무시되지만, 행 생성 자체를 막아 '편집했는데 반영 안 됨' 혼란과 #537류 동결 재발을 원천 차단한다.
      if (GUIDE_SECTION_DEFAULTS[section] !== undefined) {
        throw new HttpError(409, `'${section}' 은 제품이 소유하는 가이드입니다(코드 단일 출처 — 릴리스마다 자동 갱신). 편집할 수 없고, 주입 여부만 [세션 주입] 토글(org_runtime_update 의 inject_ontology_guide)로 제어하세요`);
      }
      // 이름 충돌 차단 — 같은 name 의 '일반 지식'(injection!=always)을 섹션화(덮어쓰기) 금지. 기존 섹션 편집은 OK.
      if (await sectionNameInUse(section) === "knowledge") {
        throw new HttpError(409, `'${section}' 은 이미 일반 지식 이름입니다 — 다른 섹션 키를 쓰세요`);
      }
      const body = str(input.body_md ?? "", "body_md", 60000);
      // 항상-주입 비용 가드 — 섹션은 매 세션 전문이 실린다. 32KiB 초과 차단(과편집·본문 오입력 방지).
      if (Buffer.byteLength(body, "utf8") > 32 * 1024) {
        throw new HttpError(400, "섹션이 너무 깁니다(32KiB 초과) — 항상-주입 문서는 짧게 유지하세요");
      }
      assertNoHardSecrets(body, "body_md"); // P8: 섹션은 합성 컨텍스트에 항상 실린다 — 평문 시크릿 hard-block(ctx_save 와 동일 choke-point)
      return { section: await updateSection(section, body, actorOf(user), "web") };
    }, {
      section: z.string().describe("섹션 키(=knowledge.name) — 소문자·숫자·하이픈 2~64자"),
      body_md: z.string().optional().describe("섹션 본문(markdown) — 매 세션 전문이 주입되므로 32KiB 이하. ${team}/${categories}/${wiki} 치환됨"),
    }),

  // ── 섹션 삭제 — 감사 스냅샷 보존(복원가능). 기본 문서(context-ontology-guide 등)도 삭제 가능 — UI 가 경고/확인. ──
  restOnly("org_delete_section", "조직 섹션 삭제",
    "항상-주입 섹션을 삭제한다(감사 스냅샷으로 보존 — content_restore 복원가능).",
    [{ method: "POST", paths: ["/api/ui/org/section/delete"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const section = str(input.section, "section", 64);
      return { deleted: await deleteSection(section, actorOf(user), "web") };
    }, {
      section: z.string().describe("삭제할 섹션 키 — 감사 스냅샷으로 보존돼 content_restore 로 복원 가능"),
    }),

  // ── 섹션 주입 순서 — sort 일괄 설정(orderedNames 순서 = 조립 순서). ──
  restOnly("org_reorder_sections", "조직 섹션 순서",
    "항상-주입 섹션의 주입 순서(sort)를 일괄 설정한다(order 배열 순서대로).",
    [{ method: "POST", paths: ["/api/ui/org/sections/order"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const order = Array.isArray(input.order) ? input.order.map((x) => String(x)) : [];
      if (!order.length) throw new HttpError(400, "order 배열이 필요합니다");
      await setSectionsOrder(order, actorOf(user), "web");
      return { ok: true };
    }, {
      order: z.array(z.string()).describe("섹션 키 배열 — 이 배열 순서대로 sort(=세션 주입 순서)를 부여한다"),
    }),
];
