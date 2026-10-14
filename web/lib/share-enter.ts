// lib/share-enter.ts — 세션 공유 창의 Enter 가 무엇을 하나 · 순수 (#3870, 원준 2026-10-14).
//
//  신고: «+버튼 한 번 누르고 사람 이름 누르고 엔터 치면 그 사람 초대가 되는데, 저장 버튼은 또 따로 마우스로 가져가서 눌러야 하거든?
//        이거 그냥 엔터 한 번 더 치면 초대되게 할 수 있어? 보통은 한 명을 초대하니까. 여러 명을 초대하는 경우는 … 너가 생각해서.»
//
//  규칙 — **찾기칸이 비어 있으면 Enter 는 저장**, 글자가 있으면 맨 위 사람 담기:
//   · 한 명:  이름 → ↵(담기 · 칸이 비워진다) → ↵(초대). 손이 키보드를 안 떠난다.
//   · 여러 명: 이름 → ↵ → 이름 → ↵ → … → 빈 칸에서 ↵(초대). 담을 때마다 칸이 비워지므로 «다음 이름을 치거나, 한 번 더 ↵» 가 늘 같은 자리다.
//   · ⌘/Ctrl+↵ 는 칸에 글자가 있어도 곧바로 저장(바뀐 게 있을 때).
//   · 바뀐 게 없는데 빈 칸에서 ↵ — 종전대로 맨 위 사람 담기(창을 열자마자 ↵ 로 첫 사람을 고르던 손을 깨지 않는다).
//  ⚠ 한글 조합 중의 Enter 는 확정이지 명령이 아니다 — 부르는 쪽이 isComposing 으로 먼저 거른다(share-session.ts).
//  ↵ 표식은 **이 함수가 고른 쪽 하나**에만 단다 — 눌러 보기 전에 무엇이 일어날지 보이게.

export type ShareEnter = 'pick' | 'save' | 'none';

export function shareEnterAction(o: { query: string; hasTop: boolean; dirty: boolean; mod?: boolean }): ShareEnter {
  if (o.mod) return o.dirty ? 'save' : 'none';
  if (o.query.trim()) return o.hasTop ? 'pick' : 'none';
  if (o.dirty) return 'save';
  return o.hasTop ? 'pick' : 'none';
}

/** 저장할 명단이 처음 명단과 다른가(순서 무관). */
export function inviteDirty(before: readonly string[], now: Iterable<string>): boolean {
  const a = new Set(before), b = new Set(now);
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}

/** 이번에 새로 담은 사람(처음 명단에 없던) — 저장 단추 글자(초대/저장)와 토스트가 쓴다. */
export function inviteAdded(before: readonly string[], now: Iterable<string>): string[] {
  const a = new Set(before);
  return [...new Set(now)].filter((x) => !a.has(x));
}
