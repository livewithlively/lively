// 온보딩 상태 = 단일 SoT. 웹UI '온보딩' 페이지(GET /api/ui/org/onboarding)와 '시작하기' 배너가 소비한다.
//  목적(#269): 셋업 단계를 한 곳에 명시하고 어디까지 됐는지 보여준다.
//
//  ⚠ **세션 주입은 하지 않는다**(2026-08-12 결정, 상민님). 종전엔 미완일 때 체크리스트 블록을 매 세션
//   컨텍스트 맨 앞에 붙였는데(renderOnboardingBlock → publish.ts), 그 방식의 문제가 코드에 이미 적혀
//   있었다 — 아래 구성원 축 주석: "세션에 체크리스트를 밀어 넣으면 '영원히 미완 → 매 세션 잔소리'가
//   된다". 조직 축은 complete 시 자동 소멸로 그 함정을 피한다고 했지만, 파이프라인처럼 **정상 운영 중에도
//   미완일 수 있는 항목**이 들어오면 그 방어가 통하지 않는다(수집을 안 쓰는 조직은 영영 미완).
//   → 체크리스트의 표면은 웹 화면 하나로 통일한다. 구성원 축이 이미 그렇게 하고 있어 두 축이 일관된다.
//   빈 조직의 AI 가 맥락 블라인드가 되지도 않는다: context-ontology-guide 는 코드 소유 섹션이고
//   publish.ts 가 **DB 행이 없어도** 렌더하므로(신규 조직 보존), 라이블리가 뭔지·도구가 뭔지는 그대로 간다.
import { itemsPool } from "../../db/client.js";
import { getSection, getMemberOnboarding, getRuntimeConfig, type ReportedStep } from "../store.js";
import { computePipelineOverview, stuckStages } from "../store/pipeline.js";

export interface OnboardingItem {
  key: string;
  label: string;
  done: boolean;
  how: string;       // 어디서/어떻게 하는지(웹UI 탭 또는 MCP 도구)
  href?: string;     // 웹UI 내 바로가기 해시(있으면)
  count?: number;    // 참고 카운트(지식/카테고리/구성원 수 등)
  /** 진행률·complete 계산에서 뺀다(화면엔 '선택'으로 표시). 해당 없는 조직이 많은 항목. */
  optional?: boolean;
}
export interface OnboardingStatus {
  items: OnboardingItem[];
  done: number;
  total: number;
  pct: number;       // 0~100
  complete: boolean;
}

/**
 * 판정에 필요한 사실 — DB 를 안 타는 순수 입력. 판정 로직을 이 타입 위의 순수 함수로 분리한 이유:
 *  이 자리에서 실제로 **거짓 완료**가 났었다(시드 지식 3건을 조직 지식으로 세어 빈 워크스페이스가
 *  "지식 ✓"). 표로 놓고 테스트할 수 있어야 같은 종류의 오판정을 다시 안 만든다.
 */
export interface OnboardingFacts {
  identityEdited: boolean;
  knowledgeAuthored: number;      // 시드 제외 — 조직이 실제로 쓴 지식
  categories: number;
  categoriesNoDefinition: number;
  membersActive: number;
  membersWithToken: number;
  dbSources: number;
  embeddingsOn: boolean;
  /** 파이프라인에서 '멈춤'으로 판정된 단계 이름들(pipeline.ts stuckStages). */
  pipelineStuck: string[];
  /** 파이프라인을 물을 이유가 있는가 — 자료도 지식도 없으면 아직 물을 단계가 아니다. */
  pipelineApplicable: boolean;
}

async function count(sql: string): Promise<number> {
  try { const r = await itemsPool.query(sql); return Number((r.rows[0] as { n?: number })?.n ?? 0); }
  catch { return 0; }   // fail-open: 테이블 부재/오류 → 0(미완으로 표시, 안전)
}
async function exists(sql: string, params: unknown[]): Promise<boolean> {
  try { const r = await itemsPool.query(sql, params); return (r.rowCount ?? 0) > 0; }
  catch { return false; } // fail-open: 테이블 부재/오류 → 미완(안전 — '됐다'고 오인하지 않는다)
}

/**
 * 사실 → 항목. **순수 함수**(DB·시각 무접촉)라 표로 테스트한다.
 *
 * 필수/선택을 가르는 기준: **이게 없으면 라이블리가 라이블리가 아닌가.**
 *  · 필수 — 없으면 AI 가 조직 맥락 없이 대답하거나(정체성·분류축·지식), 사람이 못 쓰거나(구성원),
 *    맥락이 자라지 않는다(파이프라인).
 *  · 선택 — 해당하는 조직만. 없다고 셋업이 덜 된 게 아니다(제품 DB·의미검색).
 */
export function onboardingItems(f: OnboardingFacts): OnboardingItem[] {
  // 분류축은 '있다'로 부족하다 — 정의(should)가 비면 분류기가 판단할 근거가 없어서, 축을 만들어 두고도
  //  지식이 계속 미분류로 남는다. 그래서 '정의까지 채워졌나'를 묻는다.
  const categoriesDone = f.categories > 0 && f.categoriesNoDefinition === 0;
  const categoriesHow = f.categories === 0
    ? "사업·제품·시스템 아래 우리 분류축을 만듭니다. 처음이면 AI 에게 시키세요 — 분류축이 없으면 지식이 전부 미분류가 되고, 미분류는 검색으로 소환되지 않습니다."
    : f.categoriesNoDefinition > 0
      ? `정의가 빈 분류축이 ${f.categoriesNoDefinition}개 있습니다 — 정의가 없으면 분류 기준도 없습니다.`
      : "분류축과 정의가 채워져 있습니다.";

  return [
    { key: "identity", label: "회사·페르소나·업무규칙", done: f.identityEdited,
      how: "맥락 관리 ▸ 전달 ▸ 세션 주입 — 매 세션 항상 주입되는 조직 정체성", href: "#/context/deliver/injection" },
    { key: "categories", label: "분류축(카테고리)", done: categoriesDone, count: f.categories,
      how: categoriesHow, href: "#/context/classify/categories" },
    // ⚠ 시드 지식(updated_by='system')은 세지 않는다 — 신규 워크스페이스에 런북 3건이 자동으로 깔려서,
    //  조직이 한 건도 안 썼는데 '지식 ✓ (현재 3)'으로 통과했다. 바로 위 identity 가 같은 함정을
    //  updated_by≠'bootstrap' 으로 이미 막고 있었는데 여기만 빠져 있었다.
    { key: "knowledge", label: "지식(런북·결정·설계)", done: f.knowledgeAuthored > 0, count: f.knowledgeAuthored,
      how: "knowledge_save 로 저작하거나, 수집한 자료를 증류해서 쌓입니다.", href: "#/knowledge" },
    { key: "members", label: "구성원", done: f.membersActive > 1, count: f.membersActive,
      how: `등록 ${f.membersActive}명 · 접속 토큰 보유 ${f.membersWithToken}명. 웹으로만 쓰면 토큰이 없어도 되고, 로컬 설치(/install)에는 필요합니다.`,
      href: "#/system/members" },
    // 파이프라인 4단계를 **한 항목으로 접는다.** 넷을 다 펴면 체크리스트가 열 줄이 되어 처음 온 사람이
    //  안 읽는다 — 여기서 필요한 건 "돌고 있나"이고, 어디가 왜 막혔는지는 파이프라인 화면이 훨씬 잘 말한다.
    { key: "pipeline", label: "맥락 파이프라인(수집→증류→분류→관리)",
      done: f.pipelineStuck.length === 0,
      optional: !f.pipelineApplicable,
      how: f.pipelineStuck.length
        ? `멈춘 단계: ${f.pipelineStuck.join(" · ")}. 자동 실행을 켜지 않으면 자료가 지식이 되지 않고 쌓인 지식도 관리되지 않습니다.`
        : f.pipelineApplicable ? "네 단계가 돌고 있습니다." : "아직 수집한 자료도 지식도 없어 확인할 단계가 없습니다.",
      href: "#/context" },
    { key: "embeddings", label: "의미 검색(벡터)", done: f.embeddingsOn, optional: true,
      how: f.embeddingsOn
        ? "뜻으로 찾기가 켜져 있습니다."
        : "꺼져 있어 지금은 단어가 그대로 들어간 것만 찾습니다(검색이 실패하지는 않고 조용히 그렇게 동작합니다).",
      href: "#/context/deliver/embeddings" },
    { key: "dbsource", label: "제품 DB 연결(읽기전용)", done: f.dbSources > 0, count: f.dbSources, optional: true,
      how: "AI 가 운영 데이터를 직접 조회해야 할 때만 필요합니다. 해당 없으면 건너뛰세요.", href: "#/system/db-sources" },
  ];
}

/** 진행률 — **선택 항목은 빼고** 센다. 안 그러면 해당 없는 조직이 영영 100% 가 안 된다. */
export function summarizeOnboarding(items: OnboardingItem[]): Omit<OnboardingStatus, "items"> {
  const required = items.filter((i) => !i.optional);
  const done = required.filter((i) => i.done).length;
  const total = required.length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 100, complete: done === total };
}

// 조직이 얼마나 셋업됐는지 라이브 계산(사실 수집만 — 판정은 위 순수 함수). 시크릿 없음.
export async function computeOnboardingStatus(): Promise<OnboardingStatus> {
  const [identityEdited, knowledgeAuthored, categories, categoriesNoDefinition,
    membersActive, membersWithToken, dbSources, embeddingsOn, pipeline] = await Promise.all([
    // baseline 시드(updated_by='bootstrap')만 있으면 '미완' — 관리자가 실제 편집해야 done(자동 시드로 완료 오인 방지).
    getSection("org-defaults").then((s) => !!s?.body_md?.trim() && s.updated_by !== "bootstrap").catch(() => false),
    // 섹션(injection='always')은 제외 — '지식' 단계는 recalled 지식(런북·결정·설계)만.
    //  updated_by<>'system' = 우리가 심은 시드 런북 제외(위 항목 주석 참조).
    count("SELECT count(*)::int AS n FROM knowledge WHERE lifecycle='active' AND injection <> 'always' AND COALESCE(updated_by,'') <> 'system'"),
    count("SELECT count(*)::int AS n FROM category"),
    count("SELECT count(*)::int AS n FROM category WHERE COALESCE(should,'')=''"),
    count("SELECT count(*)::int AS n FROM org_member WHERE state='active'"),
    // ⚠ 테이블 이름은 auth_token 이다(org_token 아님). 처음에 틀린 이름으로 짰더니 count() 의 fail-open 이
    //  오류를 0 으로 삼켜 **"토큰 보유 0명"이 조용히 사실처럼 표시됐다**(실측: 실제로는 6명). 그래서
    //  이름을 손으로 다시 적지 않고 정본 판정(memberHasActiveToken)이 쓰는 조건을 그대로 쓴다.
    count("SELECT count(*)::int AS n FROM org_member m WHERE m.state='active' AND EXISTS (SELECT 1 FROM auth_token t WHERE t.member_id = m.id AND t.revoked_at IS NULL)"),
    count("SELECT count(*)::int AS n FROM org_db_source"),
    getRuntimeConfig().then((c) => c.embedding_config?.provider !== "off").catch(() => false),
    computePipelineOverview().catch(() => null),
  ]);

  const items = onboardingItems({
    identityEdited, knowledgeAuthored, categories, categoriesNoDefinition,
    membersActive, membersWithToken, dbSources, embeddingsOn,
    pipelineStuck: pipeline ? stuckStages(pipeline) : [],
    // 조회 실패(구 스키마 등)면 '물을 단계 아님'으로 — 못 본 것을 '멈췄다'고 단정하지 않는다(fail-open).
    pipelineApplicable: !!pipeline && (pipeline.stages.collect.output > 0 || pipeline.stages.distill.output > 0),
  });
  return { items, ...summarizeOnboarding(items) };
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
