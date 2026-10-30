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

/** clickupFetch 가 던진 오류가 «부모가 이 리스트에 없다»(400 ITEM_137)인가. 상태코드 자리와 ECODE 를 함께 본다. */
export function isParentNotInList(e: unknown): boolean {
  return e instanceof Error && /^ClickUp 400 /.test(e.message) && /ITEM_137/.test(e.message);
}

export type ParentListLookup = { kind: "list"; listId: string } | { kind: "gone" };

/**
 * 부모 재조회 실패가 «이 행만» 막힌 것인가 — 상태코드 자리가 4xx 이고 429(레이트리밋)가 아니다.
 *  401·403 도 여기서는 행 고유다: 같은 토큰으로 방금 create 가 인증을 통과해 ITEM_137 을 받았으니, 그 부모 하나를
 *  못 읽는 것이다(비공개 공간 거부 등 — 지워짐·다른 워크스페이스는 조회 쪽이 이미 «gone» 으로 접는다).
 *  메시지에 실린 경로·본문의 숫자를 보지 않게 상태코드 자리만 본다(clickupFetch: `ClickUp ${status} ${path}: …`).
 */
export function isRowScopedLookupFailure(e: unknown): boolean {
  return e instanceof Error && /^ClickUp 4\d\d /.test(e.message) && !/^ClickUp 429 /.test(e.message);
}

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
 *
 * 부모 재조회가 행 고유 4xx(isRowScopedLookupFailure)로 막히면 **처음 거절(ITEM_137)을 던진다.** 조회 오류를 그대로
 *  던지면 401·403 이 시스템성으로 분류돼(push-failure.ts) 이 행 하나가 매 틱 실행 실패가 되고, 연속 실패 브레이커가
 *  반출 전체를 세운다 — 치유가 없을 때라면 ITEM_137(400)은 행 거절로 파킹됐을 행이다. 429·5xx·네트워크는 일시
 *  장애라 조회 오류를 그대로 던진다(재시도와 브레이커가 맞다).
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
    let found: ParentListLookup;
    try { found = await o.lookupParentList(o.parentExt); }
    catch (le) { throw isRowScopedLookupFailure(le) ? e : le; }
    if (found.kind === "gone") return { kind: "parent_gone" };
    const actual = found.listId.trim();
    if (!actual || actual === o.listId) throw e;
    await o.onHealed(o.parentExt, actual);
    return { kind: "created", result: await o.create(actual, true), listId: actual };
  }
}
