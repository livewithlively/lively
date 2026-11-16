// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// 자료 공개범위 정책 소급(source_vis_policy_backfill)의 **자료 한 건 판정**(순수). 읽기·잠금·쓰기는 source-vis-policy.ts 가 한다.
//
//  왜 따로 있나: 백필은 같은 자료를 두 번 판정한다 — 맨 앞에 한꺼번에 읽은 값으로 한 번(미리보기 · 쓰기 트랜잭션을 열지 말지),
//   쓰기 트랜잭션 안에서 그 행을 잡고 다시 읽은 값으로 한 번. 최대 5만 건을 한 건씩 도는 사이 수집 단위가 그 자료를 좁히거나
//   대상이 바뀔 수 있어, 앞의 판정대로 쓰면 그 사이 좁혀진 자료를 정책 대상 전체로 덮어쓴다(넓어지는 쪽). 두 판정이 한 함수를
//   써야 미리보기가 세는 것과 실제로 쓰는 것이 같은 규칙을 따른다.

/**
 * 자료 한 건의 갈래.
 *  · no_rule — 이 자료에 걸리는 잠금 규칙이 없다
 *  · already — 잠겨 있고 대상도 규칙과 같다
 *  · unit_managed — 잠겨 있고 수집 단위가 공개범위를 정한다(단위 공개범위 ∩ 정책은 단위 쪽이 계산한다)
 *  · skipped_empty — 규칙 대상이 비었다(쓰면 아무도 못 본다)
 *  · resync_refused — 잠긴 자료를 넓히는데 부른 사람이 그 자료를 지금 못 본다
 *  · lock — 열린 자료를 규칙 대상으로 잠근다 / resync — 잠긴 자료의 대상을 규칙 대상으로 바꾼다
 */
export type BackfillVerdict = "no_rule" | "already" | "unit_managed" | "skipped_empty" | "resync_refused" | "lock" | "resync";

/** 판정에 쓰는 자료의 상태 — 어느 시점에 읽었든 같은 모양이다. */
export interface BackfillRowState {
  /** source.visibility */
  visibility: string;
  /** 지금 대상 — source_member 의 `kind:id` 열쇠들 */
  aud: readonly string[];
  /** 수집 단위가 공개범위를 정하는 자료인가(collect_unit_source.audience) */
  unitOwned: boolean;
}

/** 이 자료에 걸리는 규칙(pickRule 의 결과에서 판정에 쓰는 칸). */
export interface BackfillRule {
  visibility: string;
  members: ReadonlyArray<{ subject_kind: string; member_id: string }>;
}

/** 백필을 부른 사람 — privileged = 전체 긴급열람 중. */
export interface BackfillEditor {
  id: string;
  teams: ReadonlySet<string>;
  privileged: boolean;
}

/** 부른 사람이 이 대상에 들어 있나(직접 · 또는 그 사람의 팀). */
export function editorSees(editor: BackfillEditor, aud: readonly string[]): boolean {
  return aud.some((k) => k === `member:${editor.id}` || (k.startsWith("team:") && editor.teams.has(k.slice("team:".length))));
}

/** 쓰는 갈래인가 — 이 둘만 자료를 바꾼다. */
export function writesVisibility(v: BackfillVerdict): v is "lock" | "resync" {
  return v === "lock" || v === "resync";
}

/**
 * 자료 한 건을 판정한다. 순서가 곧 규칙이다:
 *  ① 이미 맞은 자료는 단위가 정하든 아니든 «이미 맞음» 이다(셀 때 단위 몫으로 빠지지 않게).
 *  ② 잠긴 단위 자료는 넓히든 좁히든 건드리지 않는다 — 단위가 좁힌 것을 정책 대상으로 덮으면 단위 공개범위가 깨진다.
 *     열린 단위 자료는 «모두» 단위의 것이라 단위 몫이 곧 정책 대상이다 — 그대로 잠근다.
 *  ③ 빈 대상으로는 잠그지도 다시 맞추지도 않는다 — 그 자료로 만든 지식까지 대상 0 이 되고 지식은 되넓힐 수 없다.
 *  ④ 잠긴 자료를 넓히는 것은 그 자료를 지금 보는 사람이나 전체 긴급열람 중인 사람만. 대상 0 으로 닫힌 자료(정책을 못 읽은 판의
 *     fail-closed)는 아무도 «지금 보는 사람» 이 아니므로 긴급열람으로만 채운다. 좁히기만 하는 변경은 새로 얻는 것이 없어 누구나.
 */
export function judgeBackfillRow(row: BackfillRowState, rule: BackfillRule, editor: BackfillEditor): BackfillVerdict {
  if (rule.visibility !== "members") return "no_rule";
  const cur = new Set(row.aud);
  const want = new Set(rule.members.map((m) => `${m.subject_kind}:${m.member_id}`));
  const widening = [...want].some((k) => !cur.has(k));
  const locked = row.visibility === "members";
  if (locked && !widening && cur.size === want.size) return "already";
  if (locked && row.unitOwned) return "unit_managed";
  if (!want.size) return "skipped_empty";
  if (locked && widening && !editor.privileged && !editorSees(editor, row.aud)) return "resync_refused";
  return locked ? "resync" : "lock";
}
