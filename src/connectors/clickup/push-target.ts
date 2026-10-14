// 자식(Subtask)을 만들 리스트 — **부모 카드가 사는 리스트**에 만든다. 모르면 컨테이너로 폴백.
//  🔴 다른 리스트에 만들면서 parent 를 지정하면 ClickUp 이 400 ITEM_137("Parent not child of list")로 거절한다.
//   2026-09-22 push-clickup 이 이 경로로 5회 연속 실패해 자동 정지했다(부모는 「5월~7월 로드맵」·「개신대 주요
//   과업」에 있는데 자식을 컨테이너 「TO-DO List」에 만들려 했다).
//
//  왜 부모 한 칸이 아니라 **조상 체인**인가 — push 로 방금 만든 카드는 `external_base.list_ext` 가 비어 있다
//   (create 가 병합하는 base 에 그 키가 없다. 그 키는 인바운드가 theirs 로만 채운다 — mirror-project.ts 의
//   「미푸시 필드 base=theirs」 규율). 그래서 3단(인바운드 부모 → push 로 만든 중간 → 손자)에서 중간의
//   list_ext 가 null 이라 손자가 컨테이너로 떨어져 **같은 ITEM_137 이 재발한다**. 조상으로 한 칸 더 올라가면
//   맞는다: push-create 자식은 언제나 부모가 해소한 리스트에 태어나므로, list_ext 를 가진 가장 가까운 조상의
//   리스트 = 내 리스트다. 체인이 끝까지 비면(네이티브 top-level 계보) 컨테이너가 정답이다.
//  ⚠ 대안이던 "create 때 base.list_ext 를 써 두기"는 쓰지 않는다 — base 가 채워지면 첫 인바운드에서
//   theirs==base 가 되어 ours(네이티브 행의 `__local:N`/null)가 이겨 list_id 수렴이 뒤집힌다.
//
//  chainListExts: 직계 부모(index 0)부터 위로 올라가며 읽은 list_ext. 빈 문자열·공백은 '좌표 없음'으로 본다
//   (그대로 쓰면 `/list//task` 로 나가 무엇이 틀렸는지 알 수 없는 400 이 된다).
export function createListFor(chainListExts: readonly (string | null | undefined)[], containerId: string): string {
  for (const ext of chainListExts) {
    const v = (ext ?? "").trim();
    if (v) return v;
  }
  return containerId;
}

// 좌표 정규화 — createListFor 와 같은 규칙(빈 문자열·공백 = 좌표 없음).
const coordOf = (v: string | null | undefined): string | null => (v ?? "").trim() || null;

/**
 * 이 행을 위해 조상 체인을 읽어야 하나.
 *  · create(연결 없음) — 언제나. 부모가 올라갔는지 판정하고 태어날 리스트(createListFor)를 정한다.
 *    부모가 없는 비정상 행도 true 다 — 호출부가 그 행을 닫는다.
 *  · 갱신(연결된 카드) — **자기 좌표가 없을 때만.** push 로 만든 자식은 부모 리스트에 태어나지만(createListFor)
 *    `list_ext` 는 인바운드만 채우므로 첫 인바운드 전까지 비어 있다. 그 구간의 갱신이 컨테이너 상태셋으로 status
 *    이름을 뽑으면 리스트 어휘가 다를 때 ClickUp 이 거부하고(updateSafe 가 status 를 빼고 재시도), base 는 우리
 *    카테고리로 전진해 **다음 인바운드가 저쪽 옛 상태를 채택한다 — 로컬 상태 변경이 조용히 원복된다.**
 *    태어난 리스트는 create 때와 같은 체인 규칙으로 다시 풀린다.
 *  · project — 체인이 없다(최상위). 연결 없는 project 는 컨테이너에 태어난다.
 */
export function needsAncestorChain(o: { level: string; linked: boolean; ownListExt: string | null | undefined; hasParent: boolean }): boolean {
  if (o.level === "project") return false;
  if (!o.linked) return true;
  return o.hasParent && coordOf(o.ownListExt) == null;
}

/**
 * status 판정 기준 리스트 — 그 카드가 실제로 사는 리스트. 연결된 카드는 자기 좌표가 정본이고, 없으면(또는 아직
 *  카드가 없으면) 태어나는/태어난 리스트(createListFor 결과)다. 둘 다 없으면 null(상태셋 없음 → status 를 안 싣는다).
 */
export function statusListFor(o: { linked: boolean; ownListExt: string | null | undefined; createList: string }): string | null {
  return (o.linked ? coordOf(o.ownListExt) : null) ?? (o.createList || null);
}
