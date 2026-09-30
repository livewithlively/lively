// lib/aside-guests.ts — 셸 우패널에 뜨는 **손님 화면**(같은 오리진 iframe, v2/aside-slot.ts)의 장부. 순수 함수.
//
//  손님은 두 가지다(#4233 격리 리뷰 · #1109 의 막힘 지적).
//   · 고정 문서(sticky) — 위키 덧창의 [우측 사이드바에 고정](원준 2026-09-26 «일하며 옆에 띄워 둘 문서»)만.
//     셸에 하나. 화면을 옮겨도 · 고정한 탭을 닫아도 남는다. 클래식 앱 액자 화면(관리 · 맥락 관리 · 문서 화면 같은 옛 전폭 화면)에서는
//     우패널을 열지 않고 물러났다가, 그 화면을 떠나면 돌아온다.
//     ⚠ 기준은 noAside 가 아니다 — 홈 · 위키 · AI 세션 · 세션 화면까지 거의 모든 화면이 noAside 라, 거기서 숨기면 고정한 그 자리에서부터 안 보인다.
//   · 미리보기 — 그 밖의 openInAside 전부(프로젝트 상세 · 관리탭 미리보기, 타임라인 산출물 링크). #1109 이전 규칙 그대로:
//     연 탭(주인)의 것이고, 주인 탭이 보일 때만 보이며, 주인 탭을 닫으면 걷힌다. 남의 탭 우패널을 열지 않는다. 탭마다 하나.
//  장부는 자리(slot) → 손님 key 다. 자리는 STICKY(고정 문서) 또는 주인 탭 id(미리보기). 셸(v2/main.ts)은 자리마다 iframe 하나를
//   쥐고, 이 장부가 «무엇을 걷고 무엇을 다시 쓰고 무엇을 보이나» 를 정한다. 시험: scripts/aside-guests.test.mjs.

/** 고정 문서의 자리. 탭 id 는 이 글자가 될 수 없다(tabs.ts 가 만든다). */
export const STICKY = '*';

/** 자리 → 손님 key. 값이다 — 바꾸는 함수는 새 장부를 돌려준다. */
export type GuestBook = Readonly<Record<string, string>>;
export const EMPTY_BOOK: GuestBook = Object.freeze({});

export interface GuestAsk {
  key: string;
  /** 고정 문서인가(위키의 [우측 사이드바에 고정]만 true). */
  sticky?: boolean;
  /** 부탁한 탭 id — 미리보기의 주인. */
  owner: string;
}

export const slotOf = (g: Pick<GuestAsk, 'sticky' | 'owner'>): string => (g.sticky ? STICKY : g.owner);

/**
 * 손님을 연다. slot = 그 손님이 앉을 자리. reuse = 같은 자리에 같은 key 가 이미 있다(다시 읽지 않는다).
 *  drop = 그 자리에 다른 손님이 있었다(부르는 쪽이 그 iframe 을 걷는다). 다른 자리(남의 탭 미리보기 · 고정 문서)는 건드리지 않는다.
 */
export function openGuest(book: GuestBook, g: GuestAsk): { book: GuestBook; slot: string; reuse: boolean; drop: boolean } {
  const slot = slotOf(g);
  const had = book[slot];
  if (had === g.key) return { book, slot, reuse: true, drop: false };
  return { book: { ...book, [slot]: g.key }, slot, reuse: false, drop: had !== undefined };
}

/** 한 자리를 비운다(손님 머리의 ×). */
export function closeSlot(book: GuestBook, slot: string): { book: GuestBook; drop: boolean } {
  if (book[slot] === undefined) return { book, drop: false };
  const next: Record<string, string> = { ...book };
  delete next[slot];
  return { book: next, drop: true };
}

/** 탭을 닫았다 — 그 탭의 미리보기만 걷는다. 고정 문서는 어느 탭의 것도 아니라 남는다. */
export function closeTabGuests(book: GuestBook, tabId: string): { book: GuestBook; drop: boolean } {
  if (tabId === STICKY) return { book, drop: false };
  return closeSlot(book, tabId);
}

/**
 * 지금 보이는 탭(active)에 보일 손님의 자리. 없으면 null(우패널을 손님 때문에 열지 않는다).
 *  제 미리보기가 먼저(주인 탭은 액자 화면이어도 연다 — 미리보기 단추가 사는 곳이 관리탭 · 클래식 프로젝트 상세다),
 *  없으면 고정 문서(액자 화면에서는 물러난다).
 */
export function shownSlot(book: GuestBook, active: { id: string; frame: boolean } | null): string | null {
  if (!active) return null;
  if (active.id !== STICKY && book[active.id] !== undefined) return active.id;
  if (book[STICKY] !== undefined && !active.frame) return STICKY;
  return null;
}
