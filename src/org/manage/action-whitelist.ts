// 관리기 조치 화이트리스트(#1419 T9) — **leaf 모듈**. 의존 없음.
//
//  왜 따로 두나: 이 판정을 세 곳이 쓴다 — 실제 적용(run-manager.applyAction) · 목록 파생
//  (store/managers.listFindings 의 actionable) · 묶음 적용(store/managers.applyFindings).
//  run-manager 에 두면 store/managers 가 run-manager 를 import 하고 run-manager 는 store/managers 를
//  import 해 **순환**이 된다. ESM 이 견디긴 하지만 평가 순서에 따라 TDZ 로 터질 수 있는 구조라 만들지 않는다.
//
//  ⚠ 이 판정은 세 소비자가 **반드시 같아야** 한다. 어긋나면 '적용' 버튼이 있는데 눌러도 아무 일이 없거나
//   (사용자는 실패했다고 인지하지 못한다 — 더 나쁘다), 적용 가능한데 버튼이 안 나온다.

/**
 * 기계가 적용할 수 있는 조치안인가.
 *  여기 없는 op(review_knowledge 등)는 '읽어 보라'는 표식이지 기계가 적용할 조치가 아니다.
 *  **되돌릴 수 있는 것만** 넣는다 — 본문 수정·삭제 같은 비가역 조치는 영원히 이 목록 밖이다.
 */
export function isApplicableAction(action: unknown): boolean {
  const a = action as Record<string, unknown> | null;
  if (!a || typeof a.op !== "string") return false;
  if (a.op === "move_category") {
    // 대상 지식과 옮겨 갈 분류가 둘 다 있어야 성립. 없으면 DB 를 건드리기 전에 막는다.
    return Boolean(String(a.name ?? "").trim()) && Number(a.to_category_id ?? 0) > 0;
  }
  return false;
}
