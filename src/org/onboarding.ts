// 온보딩 상태 = 단일 SoT. 웹UI '온보딩' 페이지(GET /api/ui/org/onboarding)와 하네스 주입
//  (previewMemberContext → SessionStart 훅)이 **둘 다 이 한 곳**을 소비한다 → 드리프트 0.
//  목적(#269): ① 빈/익명 조직도 맥락 블라인드가 아니게(baseline) ② 셋업 단계를 한 곳에 명시
//             ③ AI 가 미완 단계를 사용자에게 알리고 안내.
import { itemsPool } from "../items/store.js";
import { getSection, getMemberOnboarding, type ReportedStep } from "./store.js";

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
async function exists(sql: string, params: unknown[]): Promise<boolean> {
  try { const r = await itemsPool.query(sql, params); return (r.rowCount ?? 0) > 0; }
  catch { return false; } // fail-open: 테이블 부재/오류 → 미완(안전 — '됐다'고 오인하지 않는다)
}

// 조직이 얼마나 셋업됐는지 라이브 계산(items DB 카운트 + org-defaults 섹션). 시크릿 없음.
export async function computeOnboardingStatus(): Promise<OnboardingStatus> {
  const [identity, knowledge, categories, members, dbSources] = await Promise.all([
    // baseline 시드(updated_by='bootstrap')만 있으면 '미완' — 관리자가 실제 편집해야 done(자동 시드로 완료 오인 방지).
    getSection("org-defaults").then((s) => !!s?.body_md?.trim() && s.updated_by !== "bootstrap").catch(() => false),
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

// ═══ 구성원(멤버) 축 온보딩 — 웹 전용 (#846 / 태스크 850) ══════════════════════════════
//  ⚠ 조직 축(위)과 달리 **하네스에 주입하지 않는다.** 항목이 보편적이지 않아(외부 서비스·레포는 사람마다
//   해당 없음) 세션에 체크리스트를 밀어 넣으면 "영원히 미완 → 매 세션 잔소리"가 된다. 조직 축이 자동
//   소멸(complete → "")로 피한 함정에 그대로 빠진다. → 웹 화면(#/start)이 유일한 표면이다.
//  ⚠ 그래도 **상태의 SoT 는 이 함수**다(화면이 아니다). 화면은 진입·완주 표면일 뿐이고, AI 도 REST 로
//   같은 함수를 읽는다 → 둘이 어긋나지 않는다(#269 패턴).
//
//  판정 우선순위: **자동 done > 보고(done/skipped) > todo**.
//   자동 신호는 조회 시점 라이브 계산이라 진실을 이긴다 — 사용자가 skipped 로 꺼 뒀어도 실제로 연결했으면
//   done 이다(거짓 진행률 방지). skipped 는 보고로만 설정된다(자동으로는 절대 skipped 가 안 된다).
export const MEMBER_STEPS = ["connect", "migrate", "credentials"] as const; // repos 폐지(#853) — '프로젝트 체험' 투어로 대체
export type MemberStepKey = (typeof MEMBER_STEPS)[number];
export const isMemberStep = (v: unknown): v is MemberStepKey =>
  typeof v === "string" && (MEMBER_STEPS as readonly string[]).includes(v);

export type MemberStepState = "done" | "todo" | "skipped";
export interface MemberOnboardingItem {
  key: string;
  label: string;
  state: MemberStepState;
  required: boolean;
  auto: boolean;            // 서버가 스스로 판정하는가(false = AI 보고 또는 수동 마킹만)
  how: string;              // 사람에게 보여줄 한 줄
  href?: string;            // 딥링크 — 이 페이지는 값을 편집하지 않고 여기로 보낸다
  by?: "auto" | "ai" | "self";
  at?: string;
  note?: string;
}
export interface MemberOnboardingStatus {
  items: MemberOnboardingItem[];
  done: number;
  total: number;            // skipped 제외(= 건너뛴 스텝은 분모에서 빠진다)
  pct: number;
  complete: boolean;        // **필수 스텝이 전부 done** — 선택 스텝의 todo 는 완료를 막지 않는다(잔소리 방지)
}

export async function computeMemberOnboarding(memberId: string): Promise<MemberOnboardingStatus> {
  const [connected, hasCred, reported] = await Promise.all([
    // AI 켜기 — 이 사람 **신원으로 MCP 툴이 실제 호출된 적 있나**. "claude mcp list 해보세요"라고 시키는
    //  것보다 강한 증거다(설치·인증·연결이 전부 성공해야 이 행이 남는다). 로컬/웹터미널 어느 쪽이든 잡힌다.
    exists("SELECT 1 FROM mcp_call_log WHERE actor=$1 AND ok LIMIT 1", [memberId]),
    exists("SELECT 1 FROM member_secret WHERE owner=$1 LIMIT 1", [`member:${memberId}`]),
    getMemberOnboarding(memberId).catch((): Record<string, ReportedStep> => ({})), // fail-open
  ]);

  const build = (
    key: string, label: string, required: boolean, autoSignal: boolean | null,
    how: string, href?: string,
  ): MemberOnboardingItem => {
    const auto = autoSignal !== null;
    if (autoSignal) return { key, label, state: "done", required, auto, how, href, by: "auto" };
    const r = reported[key];                       // 자동 신호가 없을 때만 보고를 본다
    if (r?.state === "done" || r?.state === "skipped") {
      return { key, label, state: r.state, required, auto, how, href, by: r.by, at: r.at, note: r.note };
    }
    return { key, label, state: "todo", required, auto, how, href };
  };

  const items: MemberOnboardingItem[] = [
    build("connect", "AI 설치하기", true, connected,
      "라이블리 웹에서 [내 AI 세션]을 바로 열거나, 내 컴퓨터의 AI(Claude Code·Codex)에 라이블리를 설치해서 쓸 수 있습니다.", "#/start/setup"),
    // 자동 신호가 없다(null) — 그 사람 노트북의 사실이라 서버가 볼 수 없다. AI 스킬이 스캔 후 보고한다
    //  (이관할 게 없으면 skipped 로). 그래서 화면이 페르소나를 물어볼 필요가 없다.
    build("migrate", "예전에 쓰던 AI 환경 가져오기", false, null,
      "AI 에게 \"온보딩 도와줘\" 라고 하면 예전 작업 메모·스킬·연결을 읽어서 보여주고 함께 정리합니다(원본은 안 건드립니다).",
      "#/start/migrate"),
    build("credentials", "외부 서비스 연결", false, hasCred,
      "AI 가 회사 서비스(깃랩·노션 등)를 대신 쓰려면 한 번 연결해 두면 됩니다.", "#/system"),
    // '프로젝트·코드 연결'(repos) 단계는 폐지(#853) — '프로젝트 체험'(#/start/project) 손수-하기 투어로 대체.
  ];

  const countable = items.filter((i) => i.state !== "skipped");   // 건너뛴 건 분모에서 뺀다
  const done = countable.filter((i) => i.state === "done").length;
  const total = countable.length;
  return {
    items, done, total,
    pct: total ? Math.round((done / total) * 100) : 100,
    complete: items.filter((i) => i.required).every((i) => i.state === "done"),
  };
}
