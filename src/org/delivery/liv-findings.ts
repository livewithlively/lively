// 리브가 홈에 띄우는 "지금 손볼 것" 판정(#1631) — 카드 한 장이 곧 여기 한 행이다.
//
// **왜 서버가 정하나**: 리브는 자기 판정을 갖지 않는다. 화면과 AI 가 다른 답을 하면 사람은 누구를 믿을지
//  모르고, 온보딩이 이미 같은 결론에 도달했다(#850 — 상태의 SoT 는 서버 함수, 화면은 표면). 그래서 카드도
//  스킬 프롬프트도 **이 함수 하나**를 읽는다.
//
// **왜 순수 함수인가**: 조회(DB·크론·설정)와 판정을 갈라야 "이 상태면 이 카드가 뜬다"를 표로 못박을 수 있다.
//  #1618 이 잡아낸 실패가 정확히 판정 실수였다 — 온보딩은 5/5 라는데 파이프라인 3단계가 8일째 멈춰 있었다.
//
// 등급은 #1618 의 필수도 판정을 그대로 쓴다:
//  · p0 = 없으면 제품 가치가 0 (AI 가 조직 맥락 없이 대답한다)
//  · p1 = 없으면 맥락이 자라지 않는다 (정적으로만 동작)
//  · p2 = 그 조직만 해당

/** 한 단계의 실행 잡 상태. `null` = 잡 자체가 없다(설정만 하고 아무것도 안 돈다). */
export interface LivJobState { enabled: boolean; any_enabled: boolean; last_status: string | null }

export interface LivSnapshot {
  /** 관리자면 조직 계층까지 본다. 아니면 개인 것만 — 못 하는 걸 카드로 꺼내지 않는다. */
  isAdmin: boolean;
  /** computeOnboardingStatus() — 미완 항목이 그대로 카드가 된다. */
  org?: { items: Array<{ key: string; label: string; done: boolean }> } | null;
  /** pipelineOverview().stages — 설정 수·잔량·실행 잡. */
  pipeline?: {
    collect?: { configured: number; enabled: number; recent_24h?: number };
    distill?: { configured: number; enabled: number; backlog: number; job: LivJobState | null };
    classify?: { categories: number; no_definition: number; backlog: number; job: LivJobState | null };
    manage?: { configured: number; enabled: number; job: LivJobState | null };
  } | null;
  /** 임베딩 provider 가 꺼져 있나 — 켜져 있는지 모르면 undefined(카드를 만들지 않는다). */
  embeddingOff?: boolean;
  /** 이 사람 컴퓨터가 노드로 연결돼 있나. */
  nodes?: { registered: number; online: number } | null;
  /** 이 사람이 예전 환경 이관을 이미 보고했나(done·skipped 면 다시 안 묻는다 — 잔소리 금지). */
  migrateReported?: boolean;
}

export interface LivFinding {
  key: string;
  severity: "p0" | "p1" | "p2";
  scope: "org" | "member";
  /** 화면 제목 — **어미까지 끝맺는다**(문구 규약). */
  title: string;
  /** 왜 급한지 한 줄. 카드가 사람을 설득하는 자리다. */
  detail: string;
  /** '리브에게 맡기기' 가 세션에 보낼 프롬프트. 없으면 카드에 실행 버튼을 안 그린다. */
  prompt?: string;
}

const P0 = "p0" as const, P1 = "p1" as const;

/**
 * 스냅샷 → 카드 목록. **등급 순으로 정렬**해 돌려준다(같은 등급 안에서는 아래 정의 순서).
 *
 * 판정하지 못하는 축은 **카드를 만들지 않는다** — 모르는 걸 "안 됐다"로 적으면 화면이 거짓말한다.
 * (조회가 실패했을 때 그 필드를 `undefined`/`null` 로 넘기면 그 축은 조용히 빠진다.)
 */
export function livFindings(s: LivSnapshot): LivFinding[] {
  const out: LivFinding[] = [];
  const p = s.pipeline ?? null;

  if (s.isAdmin) {
    // ── P0 조직 정체성·분류축 ──
    for (const it of s.org?.items ?? []) {
      if (it.done) continue;
      if (it.key === "identity") {
        out.push({ key: "org.identity", severity: P0, scope: "org",
          title: "회사·업무 규칙이 아직 비어 있습니다.",
          detail: "AI 가 매 세션 읽는 조직 정체성이라, 없으면 일반적인 답만 합니다.",
          prompt: "우리 조직의 회사 소개·페르소나·업무 규칙(org-defaults)을 나와 함께 초안부터 잡아줘." });
      } else if (it.key === "knowledge") {
        out.push({ key: "org.knowledge", severity: P0, scope: "org",
          title: "조직이 쓴 지식이 아직 없습니다.",
          detail: "AI 가 꺼내 쓸 우리 맥락이 없어 검색해도 나올 것이 없습니다.",
          prompt: "우리 조직에 지금 필요한 지식이 무엇인지 같이 정리하고, 첫 문서를 함께 써줘." });
      }
    }
    // 분류축 — #1618 이 '조용한 킬러'로 짚은 자리. 축이 0 이면 인입 지식이 전부 미분류가 되고,
    //  미분류는 recall 의 INNER JOIN 에서 소환되지 않는다(= 쌓아도 못 꺼낸다).
    if (p?.classify) {
      if (p.classify.categories === 0) {
        out.push({ key: "classify.no-category", severity: P0, scope: "org",
          title: "분류축이 아직 없습니다.",
          detail: "지식을 쌓아도 AI 가 꺼내지 못하는 상태입니다. 분류가 없으면 검색·주입에서 빠집니다.",
          prompt: "우리 조직 분류체계를 세워줘. lively-taxonomy 스킬을 따라서 진행해." });
      } else if (p.classify.no_definition > 0) {
        out.push({ key: "classify.no-definition", severity: P0, scope: "org",
          title: `정의가 비어 있는 분류축이 ${p.classify.no_definition}개 있습니다.`,
          detail: "정의가 없으면 분류기가 무엇을 넣을지 판단할 근거가 없습니다.",
          prompt: "정의(should)가 비어 있는 분류축을 찾아 정의를 채워줘. lively-taxonomy 스킬을 따라서." });
      }
    }

    // ── P1 파이프라인이 실제로 도는가 ──
    // ⚠ 여기가 이 화면의 존재 이유다: '설정됨'과 '돌고 있음'은 다르다. 관리기가 초록불인데 실행 잡이 없어
    //  8일째 멈춰 있던 것이 #1618 의 발견이고, 그건 화면 어디에도 안 보였다.
    if (p?.manage && p.manage.enabled > 0 && !jobRunning(p.manage.job)) {
      out.push({ key: "manage.no-job", severity: P1, scope: "org",
        title: "관리가 돌지 않고 있습니다.",
        detail: "관리기는 켜져 있지만 실행할 잡이 없습니다. 이 판정은 LLM 을 쓰지 않아 비용이 0 입니다.",
        prompt: "맥락 관리 4단계 중 '관리' 실행 잡을 만들고 켜줘." });
    }
    if (p?.distill && p.distill.backlog > 0 && !jobRunning(p.distill.job)) {
      out.push({ key: "distill.no-job", severity: P1, scope: "org",
        title: `자료 ${p.distill.backlog}건이 지식이 되지 못하고 있습니다.`,
        detail: "증류를 실행할 잡이 없어, 모아둔 원문이 그대로 쌓이기만 합니다.",
        prompt: "증류 실행 잡을 만들고 켜줘. 증류기가 없으면 distiller-authoring 스킬로 먼저 설계해줘." });
    }
    if (p?.classify && p.classify.backlog > 0 && p.classify.categories > 0 && !jobRunning(p.classify.job)) {
      out.push({ key: "classify.no-job", severity: P1, scope: "org",
        title: `분류되지 않은 지식이 ${p.classify.backlog}건 있습니다.`,
        detail: "분류를 실행할 잡이 없습니다. 미분류 지식은 검색·주입에서 빠집니다.",
        prompt: "분류 실행 잡을 만들고 켜줘." });
    }
    if (p?.collect && p.collect.configured > 0 && p.collect.enabled === 0) {
      out.push({ key: "collect.none-enabled", severity: P1, scope: "org",
        title: "켜져 있는 수집기가 없습니다.",
        detail: "새 자료가 들어오지 않아 맥락이 더 자라지 않습니다.",
        prompt: "수집기 현황을 보고 켤 수 있는 것을 켜줘." });
    }
    if (s.embeddingOff === true) {
      out.push({ key: "search.embedding-off", severity: P1, scope: "org",
        title: "의미 검색이 꺼져 있습니다.",
        detail: "검색이 실패하지 않고 조용히 단어 매칭으로 떨어져, 잘 안 맞는다고만 느끼게 됩니다.",
        prompt: "의미 검색(임베딩) 설정 현황을 보고 켤 수 있는지 알려줘." });
    }
  }

  // ── 개인 계층 (전원) ──
  // 이관은 **보고했으면 다시 묻지 않는다** — 상시 에이전트라 이 규칙이 없으면 매번 잔소리가 된다(#850).
  if (!s.migrateReported && (s.nodes?.online ?? 0) === 0) {
    out.push({ key: "member.local-import", severity: P1, scope: "member",
      title: "예전에 쓰던 AI 설정을 아직 가져오지 않았습니다.",
      detail: "클로드 코드나 코덱스를 쓰고 계셨다면 그 설정을 조직 자산으로 올릴 수 있습니다.",
      prompt: "내가 예전에 쓰던 로컬 AI 환경을 가져오고 싶어. 지금 상황을 보고 어떻게 하면 되는지 알려줘." });
  }

  const rank = { p0: 0, p1: 1, p2: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** 그 단계가 **실제로 도는가**. 잡이 없거나(null) 꺼져 있으면 안 돈다. */
function jobRunning(job: LivJobState | null | undefined): boolean {
  return !!job && (job.enabled || job.any_enabled);
}

/**
 * 화면에 한 번에 꺼낼 만큼만 자른다. 전부 나열하면 아무것도 안 된다 — 급한 것부터 3개가 상한이다.
 * (판정은 전부 하되 **보여주는 것만** 줄인다. 나머지는 리브가 대화에서 이어 말한다.)
 */
export function livTopFindings(all: LivFinding[], limit = 3): LivFinding[] {
  return all.slice(0, Math.max(0, limit));
}

/**
 * 이 워크스페이스가 **굴러가고 있나** — 홈에 대시보드를 띄울지 리브를 띄울지의 입력(livHomeMode 의 `mature`).
 *
 * 판정: **조직 카드가 하나라도 있거나 p0 가 있으면 아직 아니다.**
 * - p1 도 센다 — #1618 의 실패가 정확히 "P1 을 아무도 안 본다"였다(온보딩은 100% 인데 파이프라인 3단계 정지).
 *   p0 만 보면 그 상태에서 리브가 안 뜨고, 그러면 이 기능이 존재할 이유가 없어진다.
 * - **개인 카드 하나만 남은 건 성숙으로 본다** — "예전 설정을 가져오시겠어요"는 권유지 워크스페이스 고장이
 *   아니다. 그것 때문에 홈을 계속 리브가 차지하면 그게 잔소리다.
 */
export function livMature(findings: LivFinding[]): boolean {
  return !findings.some((f) => f.scope === "org" || f.severity === "p0");
}
