// 지식 lifecycle 전환 가드 — 순수 판정(DB·HTTP 무관). 핸들러가 이걸 태우고 403 으로 옮긴다.
//  핸들러 안에 if 로 흩어 두면 호출 경로(MCP·웹 REST·다른 클라이언트)마다 규칙이 갈리고,
//  실제로 #638 미러 규칙이 한동안 web/wiki-doc.ts 의 버튼 숨김 한 겹으로만 서 있었다(REST 는 그대로 통과).

/** 지식이 가질 수 있는 lifecycle 전량(knowledge.lifecycle). */
export type Lifecycle = "active" | "pending" | "superseded" | "archived";
/** 원본을 누가 소유하나 — authored=우리가 쓴 것, observed=외부 원본의 미러. */
export type Provenance = "authored" | "observed";

export type LifecycleGuardInput = {
  /** 호출 경로 — "mcp" 면 에이전트, 그 외("web" 등)는 사람. undefined 는 내부 호출. */
  source: string | null | undefined;
  /** 바꾸려는 값 — 핸들러가 zod enum 으로 이미 검증한 뒤 넘긴다. */
  target: Lifecycle;
  /** DB 의 현재 값 — 행이 없으면 undefined(그 경우 현재값을 보는 가드는 적용하지 않는다). */
  current: Lifecycle | string | null | undefined;
  /** DB 의 현재 값 — 행이 없으면 undefined. */
  provenance: Provenance | string | null | undefined;
  /** 외부 좌표 — 싱크가 따라오는 진짜 미러만 여기에 값이 있다. */
  externalSystem: string | null | undefined;
};

/** 막아야 하면 사람이 읽을 사유, 통과면 null. */
export function denyLifecycleChange(i: LifecycleGuardInput): string | null {
  // 🔒 #638 미러 «복원» 금지 — 소스 무관(사람도 못 한다).
  //  미러의 archived 는 사람이 정한 상태가 아니라 원본에서 전파된 것이라, 여기서 active 로 올려도
  //  다음 재싱크 upsert 가 원본의 archived 로 조용히 되돌린다 — 성공 응답만 거짓이 된다.
  //  원본이 복원되면 싱크가 알아서 올리므로 사람이 손댈 일 자체가 없다.
  //  ⚠ archived 에서 올라오는 것만 막는다. 미러도 인입정책이 confirm 이면 pending 으로 들어오고
  //  (mirror-knowledge.ts, resolveIngestPolicy), 그 검토 승인(pending→active)은 사람이 하는 정상 경로다 —
  //  target 만 보고 막으면 미러 승인이 통째로 403 된다.
  //  ⚠ 미러의 표식은 provenance 가 아니라 external_system 이다. 싱크·스윕이 전부 external_system 으로
  //  대상을 고르고(mirror-knowledge.ts), knowledge_save 는 external_system 을 받지 않는다 —
  //  좌표가 있으면 곧 미러다. provenance 로 재면 knowledge_save replace 가 미러 행의 provenance 를
  //  'authored' 로 뒤집을 수 있어(authoring.ts, replace 는 안 막는다) 가드가 조용히 빠진다.
  //  반대로 좌표가 없는 행은 어느 싱크도 안 건드리므로 여기가 유일한 복원 경로다 — 막으면 복원이 0 이 된다.
  if (i.target === "active" && i.current === "archived" && i.externalSystem) {
    return "미러 지식은 여기서 복원할 수 없습니다 — 원본에서 복원하면 다음 싱크가 따라옵니다.";
  }
  if (i.source === "mcp") {
    // 🔒 #783 자가승인 차단 — 에이전트가 pending 으로 저장한 뒤 스스로 승인하면 게이트가 통째로 무력화된다.
    if (i.target === "active") {
      return "승인(→active)은 사람이 웹 검토 큐에서 합니다 — 에이전트는 자기가 쓴 지식을 스스로 승인할 수 없습니다.";
    }
    // 검토 큐에서 몰래 치우는 경로도 같이 막는다.
    if (i.current === "pending") {
      return "검토 대기 중인 지식의 상태 변경은 사람만 할 수 있습니다(검토 큐).";
    }
  }
  return null;
}
