// v2/presence.ts — "지금 이 세션을 보고 있는 사람"(#2116)의 작은 집.
//
// 왜 따로 두나: 도장을 찍는 곳(main.ts 의 8초 틱 markViewedSessionSeen)과 얼굴을 그리는 곳(panes.ts 의 문패)이
//  서로를 모른다. 둘을 직접 잇자면 mountPanes 옵션에 콜백을 하나 더 뚫어야 하는데, 그러면 화면 하나를 위해
//  셸의 계약이 넓어진다. 둘 다 이 상자만 알면 된다 — main 은 넣고, 문패는 꺼내 그린다.
//
// 서버가 얼굴을 **열람 도장의 응답에 실어** 주므로 여기엔 폴링이 없다(src/terminal/chat-routes.ts viewerFaces).
//  term(#4996) — 그 사람이 이 세션을 **터미널로** 보고 있고 손길이 있다(서버 session-presence Stamp.term). 나중에 온 사람의 세션 화면이
//   이걸 보고 대화창으로 비켜 선다(web/session-chat.ts yieldTerm).
export interface Viewer { id: string; name: string; term?: boolean }

const byS = new Map<string, Viewer[]>();
const subs = new Set<(sid: string) => void>();
//  #4996 — 그 세션의 얼굴 줄을 서버에게 마지막으로 들은 때. 세션 화면이 «막 들은 줄이면 곧바로 판정, 아니면 첫 도장 응답을 기다린다» 를 가른다.
const heardAt = new Map<string, number>();
/** 이만큼 안에 들은 줄은 «지금» 으로 친다 — 도장 주기(15초)보다 조금 길게(그 안에 다시 들어온 화면은 도장을 안 찍는다 — SEEN_EVERY_MS). */
const FRESH_MS = 20_000;

const same = (a: Viewer[], b: Viewer[]): boolean => a.length === b.length && a.every((x, i) => x.id === b[i].id && !!x.term === !!b[i].term);

/** 서버가 준 얼굴 줄을 넣는다. **바뀐 게 없으면 아무에게도 알리지 않는다** — 15초마다 같은 얼굴을 다시 그리면 문패가 깜빡인다. */
export function setViewers(sid: string, list: Viewer[] | null | undefined): void {
  if (!sid) return;
  const next = (Array.isArray(list) ? list : [])
    .filter((v) => v && v.id)
    .map((v) => ({ id: String(v.id), name: String(v.name || v.id), term: !!v.term }));
  //  오래 묵은 줄 뒤에 처음 듣는 답이면 같아도 알린다 — 그 답을 기다리는 화면이 있다(#4996 세션 화면의 터미널 판정).
  const stale = !viewersFresh(sid);
  heardAt.set(sid, Date.now());
  if (!stale && same(byS.get(sid) || [], next)) return;
  byS.set(sid, next);
  for (const fn of [...subs]) { try { fn(sid); } catch (_) { /* 한 구독자가 넘어져도 나머지는 간다 */ } }
}

/** #4996 이 세션 화면을 떠났다 — 그 뒤엔 밀어 주는 줄을 못 받으므로 들은 줄이 곧 낡는다. 다시 오면 첫 도장 응답을 기다리게 한다. */
export function forgetHeard(sid: string | null | undefined): void { if (sid) heardAt.delete(sid); }

/** #4996 이 세션의 얼굴 줄을 방금(FRESH_MS 안) 들었나. */
export function viewersFresh(sid: string | null | undefined): boolean {
  return !!sid && Date.now() - (heardAt.get(sid) || 0) <= FRESH_MS;
}

export function viewersOf(sid: string | null | undefined): Viewer[] {
  return (sid && byS.get(sid)) || [];
}

export function onViewers(fn: (sid: string) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

// ── #4996 «손길» — 이 사람이 지금 이 창을 실제로 보고 있나 ─────────────────────────────────────────────
//  열어만 두고 안 보는 탭이 남의 터미널을 막으면 안 된다(상민님 2026-10-25: «예전에 열어 두고 안 보는 세션이 보고 있다고 인식되면
//   다른 사람이 들어왔을 때 대화로 넘어가서 불편하다»). 창이 숨으면 도장이 아예 멎는다(main.ts) — 여기서 가르는 것은 «창은 떠 있는데
//   사람은 다른 일을 한다»(다른 모니터 · 다른 앱 뒤 · 자리 비움)다. 손길 = 이 창에 초점이 있다 · 또는 ACTIVE_MS 안에 누르기·치기·휠·터치.
//   터미널 액자 안의 입력은 부모 창에 안 올라온다 — 액자에 초점이 있으면 document.hasFocus() 가 참이고, 초점 없이 굴린 휠은
//   세션 화면이 액자에서 받아 여기로 알린다(session-chat.ts ensureTermFrame).
const ACTIVE_MS = 120_000;
/** 세션 화면이 터미널 ↔ 대화로 보기를 바꿨다 — 셸이 열람 도장을 곧바로 다시 찍는다(다음 15초를 기다리지 않게). */
export const SESSION_VIEW_EVENT = 'lively:session-view';
let lastActivityAt = Date.now();
/** 사람이 이 창에 손을 댔다. */
export function noteActivity(): void { lastActivityAt = Date.now(); }
/** 지금 이 창을 보고 있다고 볼 만한가(초점 · 2분 안의 손길). */
export function activeNow(): boolean {
  let focused = false;
  try { focused = document.hasFocus(); } catch { focused = false; }
  return focused || Date.now() - lastActivityAt < ACTIVE_MS;
}
