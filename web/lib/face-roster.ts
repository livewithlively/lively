// lib/face-roster.ts — 세션 머리줄 얼굴 줄에 설 사람(#3870, 원준 2026-10-14 «초대명단이어야지»).
//
// 얼굴 줄은 «지금 보고 있는 사람» 이 아니라 **이 세션의 초대 명단**(소유자 + 초대받은 사람)이다 — 초대해 놓고 그 사람이
//  아직 안 열었다고 줄에서 빠지면 «초대가 됐나?» 를 알 길이 없다. 지금 보고 있는 사람(presence)은 **진하게**, 아직 안 보는
//  사람은 **흐리게** 같은 자리에 선다(here 표식). 명단에 없는데 보고 있는 사람(관리자 등)도 빠뜨리지 않는다.
//  순서: 보고 있는 사람(나 먼저) → 안 보는 소유자 → 안 보는 초대받은 사람(초대한 순서). 접을 때(FACE_MAX) 살아 있는 얼굴이 먼저 남는다.
export interface RosterFace { id: string; name: string; here: boolean }

export function faceRoster(
  owner: string,
  invites: readonly string[],
  viewers: ReadonlyArray<{ id: string; name: string }>,
  meId: string,
  nameFor: (id: string) => string = (id) => id,
): RosterFace[] {
  const seen = new Set<string>();
  const out: RosterFace[] = [];
  const here = new Map(viewers.filter((v) => v && v.id).map((v) => [String(v.id), v] as const));
  const push = (id: string, isHere: boolean): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const v = here.get(id);
    out.push({ id, name: (v && v.name) || nameFor(id) || id, here: isHere });
  };
  const roster = [owner, ...invites].filter(Boolean).map(String);
  const order = [...here.keys()].sort((a, b) => (a === meId ? -1 : b === meId ? 1 : 0));
  for (const id of order) push(id, true);
  for (const id of roster) push(id, false);
  return out;
}
