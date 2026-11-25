// lib/proj-relation.ts — 프로젝트와 «나의 관계»(#5630, 원준 2026-11-22).
//
//  #5598 로 프로젝트가 기본 초대제(만든 사람 + 초대한 사람만 본다)가 되었다. 그러면 목록에서 먼저 갈라야 하는 것은
//   «공개 범위» 가 아니라 «이 프로젝트가 나와 어떤 사이인가» 다 — 내가 초대받은 것 · 내가 만든 것 · 그 밖(전체 공개라 보이는 것).
//  셋은 서로 겹치지 않는다(만든 사람이 자기를 팀원으로 넣어도 «내가 만든» 이다).
//   · invited — 내가 팀원(project_member)이고 만든 사람은 아니다. 서버의 초대 알림(src/v6/project-invite.ts)과 같은 사람이다.
//   · mine    — 내가 만들었다(created_by).
//   · open    — 둘 다 아니다. 초대제에서는 전체 공개 프로젝트만 여기 든다(닫힌 프로젝트는 애초에 안 보인다).
//  잎 모듈(import 0) — proj-access.ts 와 같은 까닭(화면 코드 안에 있으면 시험할 데가 없다).

export type ProjRelation = 'invited' | 'mine' | 'open';

export interface RelationLike {
  created_by?: string | null;
  members?: ReadonlyArray<unknown> | null;
}

const idOf = (m: unknown): string =>
  typeof m === 'string' ? m : String((m as any)?.member_id ?? (m as any)?.id ?? '');

/** 묶음 순서 — 초대받은 것이 맨 위(남이 나를 불렀다 = 내가 놓치면 안 되는 것), 내가 만든 것, 그 밖. */
export const RELATIONS: ReadonlyArray<ProjRelation> = ['invited', 'mine', 'open'];

export const RELATION_LABEL: Record<ProjRelation, string> = {
  invited: '초대받은',
  mine: '내가 만든',
  open: '그 밖 · 전체 공개',
};

export function projRelation(p: RelationLike | null | undefined, meId: string): ProjRelation {
  if (!p || !meId) return 'open';
  if (String(p.created_by ?? '') === meId) return 'mine';
  for (const m of p.members || []) if (idOf(m) === meId) return 'invited';
  return 'open';
}

/** 관계별 수 — 사이드바 「초대받은」 · 「내가 만든」 줄이 쓴다. */
export function relationCounts(rows: ReadonlyArray<RelationLike>, meId: string): Record<ProjRelation, number> {
  const n: Record<ProjRelation, number> = { invited: 0, mine: 0, open: 0 };
  for (const p of rows) n[projRelation(p, meId)]++;
  return n;
}

/** 이 프로젝트의 사람 — 리드(만든 사람) 한 명 + 함께하는 사람(팀원, 리드 빼고). 화면의 «사람» 칸이 이 순서로 그린다. */
export function projPeople(p: RelationLike | null | undefined): { lead: string; crew: string[] } {
  if (!p) return { lead: '', crew: [] };
  const lead = String(p.created_by ?? '');
  const crew: string[] = [];
  for (const m of p.members || []) { const id = idOf(m); if (id && id !== lead && !crew.includes(id)) crew.push(id); }
  return { lead, crew };
}
