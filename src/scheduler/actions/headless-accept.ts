// 배치 «봤음» 표식을 남겨도 되는가 — 접수 판정 한 자리 (#3994 T5 · #1289 후속).
//
// 증류·분류 잡은 배치를 낸 **시점에** 그 자료·지식을 '판정함'으로 적는다(LLM 자기보고를 못 믿기 때문 —
//  안 적으면 LLM 이 넘긴 것이 매 배치 같은 집합으로 다시 올라온다, 실측 64% 재독).
//  그 대가로 **접수되지 않은 배치에 표식을 찍으면 그 자료는 아무도 안 본 채 인박스에서 영원히 빠진다.**
//
// ⚠ `status === "ok"` 는 접수의 증거가 아니다 — `enqueueHeadlessTask` 는 배치 없이도 ok 로 돌아온다
//  (중첩 스킵·하네스 해소 실패·태스크 생성 실패). #968 실측: 분류기가 942건을 «봤음» 으로 적어 두고
//  인박스가 0 으로 보였는데, 그 배치는 한 번도 실행되지 않았다.
// 그래서 **되돌릴 열쇠(task_id)까지 있을 때만** 표식을 남긴다 — 실패하면 markFinished 가 그 열쇠로 되돌린다.
export function acceptedTaskId(r: { status: string; summary?: unknown } | null | undefined): number | string | null {
  if (!r || r.status !== "ok") return null;
  const s = (r.summary ?? {}) as Record<string, unknown>;
  if (s.skipped) return null;                    // 중첩 스킵 — task_id 는 **이전** 태스크의 것이다
  const id = s.task_id;
  //  ⚠ 열쇠는 **되돌리기에 쓸 수 있는 값**이어야 한다 — org_task.id 는 1부터다. 0·음수·NaN 을 열쇠로 남기면
  //   그 표식은 어떤 실패로도 안 지워져 대상이 영구히 숨는다(유실은 무증상이고, 재독은 비용일 뿐이다).
  if (typeof id === "number") return Number.isFinite(id) && id > 0 ? id : null;
  if (typeof id === "string" && id.trim()) return id.trim();
  return null;
}
