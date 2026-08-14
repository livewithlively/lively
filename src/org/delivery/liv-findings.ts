// 리브가 홈에 띄우는 "지금 손볼 것" 카드(#1631) — **판정이 아니라 번역**이다.
//
// ⚠ 이 파일의 핵심은 **여기서 판정하지 않는다**는 것이다. 무엇이 덜 됐는지는 온보딩 체크리스트가 이미
//  계산한다(computeOnboardingStatus → OnboardingItem[], 그 안에 파이프라인 멈춤·의미검색까지 편입돼 있다).
//  리브가 자기 판정을 따로 가지면 화면과 다른 답을 하고, **두 화면이 서로 모순된 답을 주는 것**이 #1618 이
//  잡아낸 바로 그 실패다. 그래서 이 파일이 하는 일은 둘뿐이다:
//    ① 온보딩 항목을 카드로 옮긴다(등급·표시 여부)
//    ② 항목마다 **'리브에게 맡기기' 가 세션에 보낼 프롬프트**를 붙인다 — 사람이 터미널을 안 봐도 일이 되게.
//
//  ②가 리브의 고유분이다. 체크리스트는 "무엇이 덜 됐나"까지만 말하고 **누가 해 주지는 않는다.**

/** 온보딩 체크리스트 한 줄(computeOnboardingStatus 산출). 여기선 표시에 필요한 것만 받는다. */
export interface LivOnboardingItem {
  key: string; label: string; done: boolean;
  /** 사람 말로 된 사유·안내. 체크리스트가 이미 잘 쓴 문장이라 그대로 카드 본문으로 쓴다. */
  how?: string;
  /** 해당 없을 수 있는 항목(의미검색·제품 DB·아직 볼 것 없는 파이프라인). */
  optional?: boolean;
  href?: string;
}

export interface LivSnapshot {
  /** 관리자면 조직 항목까지. 아니면 개인 것만 — 못 하는 걸 카드로 꺼내지 않는다. */
  isAdmin: boolean;
  /** 조직 온보딩 항목. 조회 실패면 null — 모르는 걸 '안 됐다'로 적지 않는다. */
  org?: LivOnboardingItem[] | null;
  /** 이 사람 컴퓨터가 노드로 연결돼 있나. */
  nodes?: { registered: number; online: number } | null;
  /** 예전 환경 이관을 이미 보고했나(done·skipped 면 다시 묻지 않는다 — 잔소리 금지). */
  migrateReported?: boolean;
  /**
   * 사람이 **"그건 안 할게요"라고 한 카드 key** 들(liv_profile.declined).
   *
   * ⚠ 이게 없으면 리브는 매번 같은 걸 권하는 잔소리꾼이 된다. 상시로 뜨는 화면이라 그 위험이
   *  체크리스트보다 크다 — #850 이 멤버 온보딩을 세션 주입에서 뺀 이유와 같은 함정이다.
   */
  declined?: string[];
}

export interface LivFinding {
  key: string;
  severity: "p0" | "p1";
  scope: "org" | "member";
  title: string;
  detail: string;
  href?: string;
  /** '리브에게 맡기기' 가 세션에 보낼 프롬프트. 없으면 실행 버튼을 안 그린다(안내만). */
  prompt?: string;
}

/**
 * 항목별 리브 대응 — 제목(사람에게 보일 한 줄)과 맡길 프롬프트.
 *
 * **여기 없는 항목은 카드로 안 나온다.** 그게 의도다 — 체크리스트에 있다고 전부 홈을 차지할 이유는 없고
 * (예: 제품 DB 연결은 해당 조직만이다), 리브가 대신 해 줄 수 없는 일을 카드로 띄우면 버튼이 거짓말한다.
 */
const ORG_CARDS: Record<string, { title: string; severity: "p0" | "p1"; prompt?: string }> = {
  identity: {
    title: "회사·업무 규칙이 아직 비어 있습니다.", severity: "p0",
    prompt: "우리 조직의 회사 소개·페르소나·업무 규칙(org-defaults)을 나와 함께 초안부터 잡아줘.",
  },
  categories: {
    // 축이 없으면 인입 지식이 전부 미분류가 되고, 미분류는 소환되지 않는다 — 쌓아도 못 꺼낸다.
    title: "분류축이 아직 갖춰지지 않았습니다.", severity: "p0",
    prompt: "우리 조직 분류체계를 세워줘. lively-taxonomy 스킬을 따라서 진행해.",
  },
  knowledge: {
    title: "조직이 쓴 지식이 아직 없습니다.", severity: "p0",
    prompt: "우리 조직에 지금 필요한 지식이 무엇인지 같이 정리하고, 첫 문서를 함께 써줘.",
  },
  members: {
    title: "구성원이 아직 갖춰지지 않았습니다.", severity: "p1",
    // 초대·토큰 발급은 사람이 결정할 일이라 리브가 대신 하지 않는다 — 화면으로 보낸다.
  },
  pipeline: {
    // 체크리스트의 how 가 "멈춘 단계: 증류 · 관리" 처럼 어디가 막혔는지까지 말해 준다.
    title: "맥락 파이프라인이 멈춰 있습니다.", severity: "p1",
    prompt: "맥락 파이프라인에서 멈춘 단계를 찾아 실행 잡을 만들고 켜줘. 증류기·분류기가 없으면 먼저 설계해줘.",
  },
  embeddings: {
    title: "의미 검색이 꺼져 있습니다.", severity: "p1",
    prompt: "의미 검색(임베딩) 설정 현황을 보고, 켤 수 있는 상태인지와 무엇이 필요한지 알려줘.",
  },
};

/**
 * 스냅샷 → 카드 목록(등급 순).
 *
 * - **optional 이면서 미완인 항목은 카드로 내지만 등급을 올리지 않는다** — 해당 없는 조직도 있어서,
 *   이걸 p0 로 올리면 영영 미완인 사람이 생긴다(#850 이 멤버 온보딩에서 같은 함정을 짚었다).
 * - `ORG_CARDS` 에 없는 항목은 조용히 뺀다(예: 제품 DB 연결).
 */
export function livFindings(s: LivSnapshot): LivFinding[] {
  const out: LivFinding[] = [];

  if (s.isAdmin) {
    for (const it of s.org ?? []) {
      if (it.done) continue;
      const card = ORG_CARDS[it.key];
      if (!card) continue;
      out.push({
        key: `org.${it.key}`,
        // optional 항목은 등급을 한 칸 낮춘다 — '해당 없을 수 있는 것'이 급한 것을 밀어내면 안 된다.
        severity: it.optional ? "p1" : card.severity,
        scope: "org",
        title: card.title,
        detail: it.how ?? "",
        href: it.href,
        prompt: card.prompt,
      });
    }
  }

  // ── 개인 계층(전원) — 이미 보고했거나 노드가 붙어 있으면 묻지 않는다. ──
  if (!s.migrateReported && (s.nodes?.online ?? 0) === 0) {
    out.push({
      key: "member.local-import", severity: "p1", scope: "member",
      title: "예전에 쓰던 AI 설정을 아직 가져오지 않았습니다.",
      detail: "클로드 코드나 코덱스를 쓰고 계셨다면 그 설정을 이 워크스페이스로 가져올 수 있습니다.",
      prompt: "내가 예전에 쓰던 로컬 AI 환경을 가져오고 싶어. 지금 상황을 보고 어떻게 하면 되는지 알려줘.",
    });
  }

  // 거절한 것은 **아예 만들지 않는다**(뒤에서 숨기는 게 아니라). 화면·프롬프트·개수 어디에도 안 남아야
  //  "다시 꺼내지 않는다"가 지켜진다 — 카운트에만 남아도 사람은 그걸 본다.
  const declined = new Set(s.declined ?? []);
  const rank = { p0: 0, p1: 1 } as const;
  return out.filter((f) => !declined.has(f.key)).sort((a, b) => rank[a.severity] - rank[b.severity]);
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
 * - **개인 권유 카드 하나만 남은 건 성숙으로 본다** — "예전 설정을 가져오시겠어요"는 권유지 워크스페이스
 *   고장이 아니다. 그것 때문에 홈을 계속 리브가 차지하면 그게 잔소리다.
 */
export function livMature(findings: LivFinding[]): boolean {
  return !findings.some((f) => f.scope === "org" || f.severity === "p0");
}
