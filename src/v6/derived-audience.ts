// #4824 — 증류 지식의 볼 수 있는 사람 계산(순수). DB 는 derived-visibility.ts 가 읽고 쓴다.
//
//  규칙 하나: **증류 지식(derived_from)을 볼 수 있는 사람 ⊆ 그 지식이 나온 잠긴 자료 각각을 볼 수 있는 사람.**
//   증류는 원문을 요약할 뿐 기밀성을 없애지 않는다(#1291 v4 상속과 같은 단조 축소).
//
//  주체는 문자열 열쇠 `member:<id>` · `team:<id>` 로 다룬다(knowledge_member·source_member 의 subject_kind:member_id).
//   교집합은 **열쇠가 똑같은 것만** 남긴다 — 팀은 팀 그대로라 팀원 변경이 따라온다. 한쪽이 팀이고 다른 쪽이 사람이면
//   (팀 T ∩ 사람 a) 지금 a 가 T 에 있어도 남기지 않는다: 사람으로 풀어 적으면 나중에 a 가 T 를 나가도 계속 보게 된다
//   (사본이 낡는다). 그 경우는 비거나 좁아지고, 새로 만드는 저장은 «아무도 못 본다» 로 거절돼 자료별로 나눠 쓰게 된다.
//
//  리스트 grant(knowledge_list_grant — 비공개 프로젝트 세션의 산출 지식)는 «그 리스트를 볼 수 있는 사람» 이라 OR 로만
//   적힌다. «리스트 ∩ 자료» 를 그대로 적을 칸이 없다. 그래서 잠긴 자료와 만나면 리스트 grant 를 걷는다(닫히는 쪽).
//   새로 잇는 길(저장·연결)은 이 경우를 미리 거절한다 — 걷히는 것은 이미 이어진 자료가 나중에 좁혀질 때뿐이다.

export type SubjectKey = string;

export interface KnowledgeAudience {
  open: boolean;
  /** knowledge_member 열쇠 */
  subjects: readonly SubjectKey[];
  /** knowledge_list_grant 의 리스트 id */
  lists: readonly number[];
}

export interface LockedSourceAudience {
  id: number;
  /** source_member 열쇠(잠긴 자료만 — 열린 자료는 넘기지 않는다) */
  subjects: readonly SubjectKey[];
}

export interface DerivedPlan {
  /** 맞춘 뒤의 공개범위. 잠긴 자료가 없으면 지금 그대로다. */
  next: { open: boolean; subjects: SubjectKey[]; lists: number[] };
  /** 저장할 것이 있나(공개범위 · 대상 · 리스트 중 하나라도 바뀜) */
  changed: boolean;
  /** 지금 이 지식을 보는 사람 중 못 보게 되는 사람이 있나(사람 단위로 풀어 비교 — 팀은 지금 팀원으로 푼다) */
  narrows: boolean;
  /** 잠겼는데 아무도 못 본다(관리자만) */
  empty: boolean;
  /** 리스트 grant 를 걷나 */
  dropsLists: boolean;
}

export const subjectKey = (kind: string, id: string): SubjectKey => `${kind}:${id}`;

export function splitSubject(key: SubjectKey): { kind: string; id: string } {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
}

/** 열쇠들을 사람 id 로 푼다. 팀은 teamMembers 로(모르는 팀은 아무도 아니다). */
export function expandMembers(subjects: Iterable<SubjectKey>, teamMembers: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const out = new Set<string>();
  for (const key of subjects) {
    const { kind, id } = splitSubject(key);
    if (kind === "member") out.add(id);
    else if (kind === "team") for (const m of teamMembers.get(id) ?? []) out.add(m);
  }
  return out;
}

const sorted = (xs: Iterable<SubjectKey>): SubjectKey[] => [...new Set(xs)].sort();

/**
 * 지식 k 를 잠긴 자료들에 맞춘다. 좁히기만 한다 — 결과가 k 보다 넓어지는 일은 없다.
 *
 *  · 잠긴 자료가 없으면 아무것도 바꾸지 않는다(열린 자료는 물려줄 제한이 없다).
 *  · k 가 열려 있으면 첫 잠긴 자료의 대상에서 시작하고, 나머지 자료와 차례로 교집합.
 *  · k 가 잠겨 있으면 k 의 대상에서 시작한다. 리스트 grant 는 걷는다(머리말).
 *
 *  narrows 는 «지금 보는 사람» 기준이다. k 가 열려 있었으면 잠그는 순간 늘 좁아진다(앞으로 들어올 사람까지 포함해서).
 *   리스트 grant 를 걷는 것도 좁아짐으로 친다 — 그 리스트를 보던 사람이 몇 명인지 여기서는 모르므로 닫히는 쪽으로 본다.
 */
export function planDerivedAudience(
  k: KnowledgeAudience,
  locked: readonly LockedSourceAudience[],
  teamMembers: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): DerivedPlan {
  const cur = { open: k.open, subjects: sorted(k.subjects), lists: [...new Set(k.lists)].sort((a, b) => a - b) };
  if (!locked.length) {
    return { next: cur, changed: false, narrows: false, empty: !cur.open && !cur.subjects.length && !cur.lists.length, dropsLists: false };
  }
  let acc: Set<SubjectKey> | null = k.open ? null : new Set(cur.subjects);
  for (const s of locked) {
    const here = new Set(s.subjects);
    acc = acc === null ? here : new Set([...acc].filter((x) => here.has(x)));
  }
  const next = { open: false, subjects: sorted(acc ?? []), lists: [] as number[] };
  const dropsLists = cur.lists.length > 0;
  const changed = cur.open || dropsLists
    || next.subjects.length !== cur.subjects.length || next.subjects.some((x, i) => x !== cur.subjects[i]);
  let narrows = cur.open || dropsLists;
  if (!narrows) {
    const after = expandMembers(next.subjects, teamMembers);
    for (const m of expandMembers(cur.subjects, teamMembers)) if (!after.has(m)) { narrows = true; break; }
  }
  return { next, changed, narrows, empty: !next.subjects.length, dropsLists };
}
