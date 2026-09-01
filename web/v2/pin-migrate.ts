// 복원으로 세션 id 가 바뀔 때 **핀을 새 id 로 옮기는 규칙**(#2402) — 순수 함수로 떼어 둔다.
//
//  왜 떼어 두나: 핀은 이 브라우저의 localStorage 에 **영속**한다. 그래서 여기서 실수하면 화면 한 판이 아니라
//   그 사람의 핀 목록이 **영구히** 망가진다 — 같은 id 로 부르면 핀이 사라지거나(delete 뒤 add 를 건너뜀),
//   빈 id 로 부르면 `sess:` 같은 쓰레기 키가 눌러앉는다. 그런 종류는 값으로 잠근다
//   (scripts/pin-migrate.test.mjs · sess-face.ts 와 같은 이유·같은 자리).
//
//  키 규약은 사이드바와 같다: 세션 행의 키는 `sess:<박스 id>`(web/v2/main.ts sideInstances).
export const sessPinKey = (id: string): string => "sess:" + String(id ?? "").trim();

export interface PinMigration {
  /** 옮긴 뒤의 핀 키 목록(순서 보존 — 옛 자리에 새 키가 들어간다). */
  keys: string[];
  /** 실제로 옮겼나. false 면 저장할 이유도 없다(호출부가 쓰기를 건너뛴다). */
  moved: boolean;
}

/**
 * 핀 집합에서 `oldId` 세션의 핀을 `newId` 로 옮긴다.
 *
 *  ⚠ **못 옮기는 경우엔 아무것도 바꾸지 않는다** — 핀을 '옮기다 흘리는' 것이 안 옮기는 것보다 나쁘다.
 *   · 옛 세션이 핀돼 있지 않다 → 그대로(moved=false)
 *   · 두 id 가 같다 → 그대로. 지우고 다시 넣는 순서로 짜면 여기서 핀이 증발한다.
 *   · 어느 쪽이든 비었다 → 그대로. `sess:` 라는 빈 키가 저장소에 눌러앉는 것을 막는다.
 *   · 새 id 가 이미 핀돼 있다 → 옛 키만 걷어낸다(중복 키를 만들지 않는다).
 */
export function migratePinKeys(pinned: Iterable<string>, oldId: string, newId: string): PinMigration {
  const keys = [...pinned];
  const from = String(oldId ?? "").trim();
  const to = String(newId ?? "").trim();
  if (!from || !to || from === to) return { keys, moved: false };
  const fromKey = sessPinKey(from);
  const toKey = sessPinKey(to);
  const at = keys.indexOf(fromKey);
  if (at < 0) return { keys, moved: false };
  //  새 키가 이미 있으면 옛 키만 뺀다 — 같은 세션이 두 줄로 서지 않게.
  if (keys.includes(toKey)) return { keys: keys.filter((k) => k !== fromKey), moved: true };
  const next = keys.slice();
  next[at] = toKey;   // 옛 자리를 그대로 물려준다(사람이 고른 순서를 흔들지 않는다)
  return { keys: next, moved: true };
}
