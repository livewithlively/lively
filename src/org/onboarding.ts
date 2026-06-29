// 온보딩 상태 = 단일 SoT. 웹UI '온보딩' 페이지(GET /api/ui/org/onboarding)와 하네스 주입
//  (previewMemberContext → SessionStart 훅)이 **둘 다 이 한 곳**을 소비한다 → 드리프트 0.
//  목적(#269): ① 빈/익명 조직도 맥락 블라인드가 아니게(baseline) ② 셋업 단계를 한 곳에 명시
//             ③ AI 가 미완 단계를 사용자에게 알리고 안내.
import { itemsPool } from "../items/store.js";
import { getSection } from "./store.js";

export interface OnboardingItem {
  key: string;
  label: string;
  done: boolean;
  how: string;       // 어디서/어떻게 하는지(웹UI 탭 또는 MCP 도구)
  href?: string;     // 웹UI 내 바로가기 해시(있으면)
  count?: number;    // 참고 카운트(지식/카테고리/구성원 수 등)
}
export interface OnboardingStatus {
  items: OnboardingItem[];
  done: number;
  total: number;
  pct: number;       // 0~100
  complete: boolean;
}

async function count(sql: string): Promise<number> {
  try { const r = await itemsPool.query(sql); return Number((r.rows[0] as { n?: number })?.n ?? 0); }
  catch { return 0; }   // fail-open: 테이블 부재/오류 → 0(미완으로 표시, 안전)
}

// 조직이 얼마나 셋업됐는지 라이브 계산(items DB 카운트 + org-defaults 섹션). 시크릿 없음.
export async function computeOnboardingStatus(): Promise<OnboardingStatus> {
  const [identity, knowledge, categories, members, dbSources] = await Promise.all([
    getSection("org-defaults").then((s) => !!s?.body_md?.trim()).catch(() => false),
    // 섹션(injection='always': org-defaults·managed-policy·가이드)은 제외 — '지식' 단계는 recalled 지식(런북·결정·설계)만.
    count("SELECT count(*)::int AS n FROM knowledge WHERE lifecycle='active' AND injection <> 'always'"),
    count("SELECT count(*)::int AS n FROM category"),
    count("SELECT count(*)::int AS n FROM org_member WHERE state='active'"),
    count("SELECT count(*)::int AS n FROM org_db_source"),
  ]);

  const items: OnboardingItem[] = [
    { key: "identity", label: "회사·페르소나·업무규칙", done: identity,
      how: "웹UI 관리 탭 ▸ 맥락 관리(org-defaults) — 매 세션 항상 주입되는 조직 정체성", href: "#/system" },
    { key: "categories", label: "카테고리(도메인 분류축)", done: categories > 0, count: categories,
      how: "사업/제품/시스템 분류축. category_* 도구 또는 관리 탭", href: "#/knowledge" },
    { key: "knowledge", label: "지식(런북·결정·설계)", done: knowledge > 0, count: knowledge,
      how: "knowledge_save 로 저작하거나 커넥터(Slack/ClickUp/Notion) 싱크", href: "#/knowledge" },
    { key: "members", label: "구성원 등록 + 토큰", done: members > 1, count: members,
      how: "웹UI 관리 탭 ▸ 구성원. 토큰 발급 → 멤버 로컬 설치(/install)", href: "#/system" },
    { key: "dbsource", label: "고객 제품 DB(읽기전용 리플리카)", done: dbSources > 0, count: dbSources,
      how: "웹UI 관리 탭 ▸ 데이터소스 — db_query 가 읽는 운영 DB", href: "#/system" },
  ];

  const done = items.filter((i) => i.done).length;
  const total = items.length;
  return { items, done, total, pct: Math.round((done / total) * 100), complete: done === total };
}

// 하네스 주입용 마크다운 렌더 — 완료면 ""(실제 조직 맥락이 대신 주입됨). 미완이면 baseline + 단계 + AI 지침.
//  ※ 웹 페이지와 동일 status(SoT)에서 렌더 → 둘이 항상 일치.
export function renderOnboardingBlock(status: OnboardingStatus): string {
  if (status.complete) return "";
  const L: string[] = [];
  L.push(`> ⚠ **이 lively 인스턴스는 온보딩이 진행 중입니다 (${status.done}/${status.total} 완료).** 조직 맥락이 아직 비어 있어 baseline 안내가 표시됩니다. 설정을 채우면 이 블록은 사라지고 실제 조직 맥락이 주입됩니다.`);
  L.push("");
  L.push("**lively = 조직 컨텍스트 저장소.** 사람과 여러 AI 에이전트가 하나의 맥락(지식·프로젝트·도메인맵) 위에서 일하게 한다. 맥락은 MCP 도구(`mcp__lively__*` — knowledge_search/save·project_*·category_* 등)로 읽고 쓴다.");
  L.push("");
  L.push("## 셋업 단계 (관리자 — 웹UI `/ui/#/onboarding` 에서 진행상황 확인)");
  status.items.forEach((it, i) => {
    const c = it.count !== undefined ? ` (현재 ${it.count})` : "";
    L.push(`${i + 1}. [${it.done ? "x" : " "}] **${it.label}**${c} — ${it.how}`);
  });
  L.push("");
  L.push("(인프라 — 게이트웨이 배포·중앙박스 키트·Claude 로그인 — 는 설치 단계에서 완료. 상세: `deploy/README.md`.)");
  L.push("");
  L.push("## AI 에이전트 지침 (온보딩 미완)");
  L.push("- 사용자가 **온보딩·셋업·설정**을 물으면 위 단계(특히 미완 `[ ]`)로 친절히 안내하라.");
  L.push("- 세션을 시작하면 미완 항목이 있을 때 **사용자에게 한 번** 간단히 알리고 다음 단계를 제안하라. 다른 작업에 집중 중이면 반복하지 말 것.");
  L.push("- 요청 시 MCP 도구로 직접 도울 수 있다(예: `category_create`, `knowledge_save`; 구성원·데이터소스는 관리 탭) — 사용자 승인 하에.");
  return L.join("\n");
}
