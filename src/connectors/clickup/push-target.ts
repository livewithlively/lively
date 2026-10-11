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

/** clickupFetch 가 던진 오류가 «부모가 이 리스트에 없다»(400 ITEM_137)인가. 상태코드 자리와 ECODE 를 함께 본다. */
export function isParentNotInList(e: unknown): boolean {
  return e instanceof Error && /^ClickUp 400 /.test(e.message) && /ITEM_137/.test(e.message);
}

export type ParentListLookup = { kind: "list"; listId: string } | { kind: "gone" };

/**
 * 자식 카드 생성 — 부모 리스트 좌표가 낡았으면 저쪽에서 다시 읽어 한 번 고쳐 만든다.
 *
 * 왜 필요한가: createListFor 가 쓰는 `list_ext` 는 인바운드가 마지막으로 본 값이다. 부모 카드가 ClickUp 에서
 *  다른 리스트로 옮겨진 뒤 수집 범위를 벗어나면 그 값이 영영 갱신되지 않고, 그 아래 새 자식은 매 틱 ITEM_137 로
 *  실패한다(2026-10-06: 08-11 값으로 남은 부모 아래 자식 1건이 5회 연속 실패해 push-clickup 이 자동 정지했다).
 *  좌표의 정본은 저쪽 카드이므로, 거절당했을 때 부모 카드를 단건 조회해 실제 리스트를 얻는다.
 *
 * 재시도는 **한 번**이다. 다시 읽은 리스트가 처음 것과 같으면 좌표 문제가 아니므로 원래 오류를 그대로 던진다
 *  (조용히 삼키지 않는다 — 원인이 다른 400 이면 사람이 봐야 한다).
 */
export async function createUnderParent<R>(o: {
  listId: string;
  parentExt: string | undefined;
  create: (listId: string, healed: boolean) => Promise<R>;
  lookupParentList: (parentExt: string) => Promise<ParentListLookup>;
  onHealed: (parentExt: string, listId: string) => Promise<unknown>;
}): Promise<{ kind: "created"; result: R; listId: string } | { kind: "parent_gone" }> {
  try {
    return { kind: "created", result: await o.create(o.listId, false), listId: o.listId };
  } catch (e) {
    if (!o.parentExt || !isParentNotInList(e)) throw e;
    const found = await o.lookupParentList(o.parentExt);
    if (found.kind === "gone") return { kind: "parent_gone" };
    const actual = found.listId.trim();
    if (!actual || actual === o.listId) throw e;
    await o.onHealed(o.parentExt, actual);
    return { kind: "created", result: await o.create(actual, true), listId: actual };
  }
}
