// #290 page-type 전수 분류 — NULL type 지식을 6종으로 (다온 판정, 제목·카테고리 기반). 되돌리기: type=NULL 로 재설정.
//  실행: node --env-file=<게이트웨이 .env> scripts/290-classify-types.mjs  (DRY=1 미리보기)
import pg from "pg";
const DRY = process.env.DRY === "1";
const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 4 });

const MAP = {
  decision: [
    "팀-기능-설계-구현-카테고리-오너십-소프트-렌즈-팀별-컨텍스트-주입-프로젝트-위키-탭-재구성",
    "웹터미널-새로고침-시-폰트-미적용-321-document-fonts-ready-조기-resolve-함정-docume",
    "인바운드-3-way-필드머지-6d-external-base-우리db-충돌타이브레이크-완전-양방향-라이브-177",
    "작업-activity-유형-재정립-8종-작업자-author-agent-게이트웨이-매핑-프로젝트-182",
    "activity-model-shipped",
    "agents-md-task-index-regen-on-task-mutations-234",
    "clickup-아웃바운드-write-through-6b-external-outbox-패턴-우리편집-clickup-연",
    "context-os-v5-shipped",
    "context-os-v6-redesign",
    "db-source-web-sot",
    "pjk-knowledge-flow-redesign-317",
    "project-board-list-grouping-280",
    "project-settings-modal-cleanup-246",
    "온보딩-진행상황-sot-웹페이지-하네스주입-단일소스",
    "status-정규화-2축-status-raw-category",
    "summary-2026-06-22",
    "vector-search-172-design-pluggable-seam-oss",
    "web-terminal-cjk-corruption-window-size-latest",
    "web-terminal-korean-font-d2coding-279",
    "web-terminal-reattach-altscreen-scroll-copy",
    "code-domain-mapping-llm-judge",
    "domainmap-refresh-trigger-cron",
    "product-domains-3cut",
    "2026-06-17-gtm-bm-자금조달-전략",
    "honest-ai-first-pilot",
    "honest-ai-pilot-scope",
    "service-pivot",
    "2026-06-17-오픈코어-경계-1차가설",
    "터미널-중앙-박스-세션-접근-모델-순수-초대제-공개-팀-폐기",
    "2026-06-16-hook-tool-crud-구현",
    "admin-console-dev-readable-redesign",
    "box-runner-repo-provision",
    "central-box-design",
    "delivery-web-everyday-minimalism",
    "knowledge-star-single-surface",
    "mcp-call-stats-dashboard-318",
    "mcp-tool-deferred-injection-harness-187",
    "repo-drop-install-unify-2026-06-24",
    "session-injection-map-admin-ia",
    "stop-hook-multi-fire-race-fix-270",
    "ui-hero-productivity-dev-pm",
  ],
  reference: [
    "brand",
    "company-name-full-spelling",
    "lively-sales-deck-pages",
    "2026-06-09-컨텍스트-온톨로지-저장소-배포-유형화",
    "코멘트-저장소-검토-activity-type-comment",
    "auth-2계층-사람세션-에이전트토큰-intersection",
    "content-deletion-recovery-model",
    "db-clickup-시드-매핑-project-task-list-아님-lively-재이관-완료-177",
    "프로젝트싱크-권위모델-우리db-master",
    "design-doc",
    "knowledge-grep-search-is-grep",
    "knowledge-grep-snippet-contract",
    "knowledge-retrieval-shared-core",
    "lively-mcp-store",
    "컨텍스트-스토어-데이터모델-드리프트-v6-category-테이블-레거시-domain-테이블-읽기경로-미컷오버",
    "vector-search-172-impl-status-activation",
    "anthropic-contact-cca-f-reference-2026-06",
    "cpn-select-first-two-deployments-2026-06",
    "honest-ai-demo-script",
    "honest-ai-design-partner-agreement-draft",
    "honest-ai-discovery-questions",
    "honest-ai-pilot-1pager",
    "context-ontology-guide",
    "founder-roles-titles",
    "org-defaults",
    "box-project-lively-marker",
    "프로젝트-폴더-네이밍-정수-id-기반-공유-워크스페이스-project-lt-id-gt",
    "incognito-blank-mode",
    "local-file-viewing-workflow",
    "work-approach-ultracode",
    "harness-facing-trap-remove-not-document",
  ],
  research: [
    "vector-search-172-use-cases-roadmap",
    "clickup-task-adoption-priority",
    "2026-06-09-파일럿-파트너-타깃-세그멘테이션",
    "gtm-standard-feasibility",
    "경쟁사-서비스-딜리버리-프로파일-2026-06",
    "2026-06-04-유사-플레이어-경쟁-랜드스케이프",
    "2026-06-17-3축-전체-경쟁지도",
    "2026-06-17-ddd-구현도구-경쟁비교",
    "2026-06-17-ddd-2026-담론-옹호-비판",
    "anthropic-korea-ecosystem-tech-partner-2026-06",
    "compare-clickup-atlassian-microsoft-work-management",
    "competitive-3axis-map",
    "domain-debt-market-position",
    "textcortex-assessment",
  ],
  concept: [
    "lively-problem-framing",
    "service-overview",
    "ui-calm-design-feedback",
    "2026-06-17-harness-vs-remote-memory",
  ],
  "how-to": [
    "install-onboarding-prereqs",
    "project-closeout-routine",
  ],
  entity: [
    "2026-06-17-port-corestory-프로파일",
  ],
};

async function main() {
  console.log(`\n=== #290 page-type 전수 분류 ${DRY ? "[DRY]" : "[LIVE]"} ===\n`);
  let total = 0, unmatched = [];
  for (const [type, names] of Object.entries(MAP)) {
    total += names.length;
    if (DRY) { console.log(`${type}: ${names.length}건 예정`); continue; }
    const r = await pool.query(`UPDATE knowledge SET type=$1 WHERE name = ANY($2::text[])`, [type, names]);
    console.log(`${type}: ${r.rowCount}/${names.length} 적용`);
    if (r.rowCount !== names.length) {
      // 미매칭 이름 찾기(오타·이미 변경 등)
      const found = await pool.query(`SELECT name FROM knowledge WHERE name = ANY($1::text[])`, [names]);
      const fs = new Set(found.rows.map((x) => x.name));
      unmatched.push(...names.filter((n) => !fs.has(n)));
    }
  }
  console.log(`\n합계 매핑 ${total}건`);
  if (unmatched.length) console.log(`⚠ 미매칭(이름 불일치): ${unmatched.join(", ")}`);
  const left = await pool.query(`SELECT name, title FROM knowledge WHERE type IS NULL AND lifecycle='active' AND name NOT LIKE 'meeting-%' ORDER BY name`);
  console.log(`\n잔여 NULL(자료 제외): ${left.rows.length}건`);
  for (const r of left.rows) console.log(`   · ${r.name} — ${r.title || ""}`);
  await pool.end();
  console.log("=== 완료 ===\n");
}
main().catch((e) => { console.error("실패:", e); process.exit(1); });
