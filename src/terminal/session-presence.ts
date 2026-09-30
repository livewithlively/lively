// 세션 열람 presence(#2116) — "지금 이 세션을 보고 있는 사람". 구글 문서의 얼굴 줄과 같은 것.
//
// ⭐ 왜 인메모리인가 — presence 는 **태생이 휘발**이다. "지금 보고 있다"는 사실은 창을 닫는 순간 거짓이 되고,
//  그 거짓을 DB 에 남겨두면 유령 얼굴이 붙는다(살아 있는 사실을 저장소가 늙히는 전형). 게이트웨이가 재시작하면
//  전원이 한 번 사라졌다가 다음 도장(≤15초)에 그대로 되돌아온다 — 그게 맞는 동작이라 복원할 것이 없다.
//
// ⭐ 왜 새 왕복이 없나 — 화면은 세션을 보고 있는 동안 이미 15초마다 `POST /sessions/:id/seen` 을 찍는다
//  (web/v2/main.ts SEEN_EVERY_MS, #1954 3차 열람 도장). 그 도장이 곧 심장박동이라, presence 는 그 요청에
//  얹혀 가고 응답으로 되돌아온다. 폴링을 하나 더 만들지 않는다.
//
// ⭐ 왜 도착 시각으로 세우나 — **사람은 얼굴의 자리로 누가 있는지를 읽는다.** 전원이 15초마다 도장을 다시
//  찍으므로 '마지막 도장' 순으로 세우면 줄이 15초마다 통째로 뒤바뀐다. 그래서 순서의 기준은 처음 도장(도착)이고,
//  하트비트는 그 자리를 **연장할 뿐 옮기지 않는다**. 만료된 뒤 다시 오면 그때는 진짜 새 도착이라 맨 뒤에 선다.
//
// ⚠ TTL 은 도장 주기의 3배다. 2배로 두면 한 번만 놓쳐도(탭 전환·네트워크 딸꾹) 얼굴이 깜빡이고,
//  presence 에서 깜빡임은 "나갔다"로 읽히므로, 늦게 사라지는 쪽으로 실패한다.
import { publishNotify } from "../v6/notify-bus.js";
import { hereSlug } from "../v6/notify-scope.js";
import { currentTenant } from "../org/tenant-context.js";

const TTL_MS = 45_000;
const STAMP_MS = 15_000;   // 화면의 도장 주기(참고값 — TTL 근거)

interface Stamp { first: number; last: number }
/** 자리 키(워크스페이스 + 세션 id) → (멤버 id → 도착·최근 도장). */
const stamps = new Map<string, Map<string, Stamp>>();

//  ⚠ 자리는 **워크스페이스마다** 따로다(#3870) — 매니지드 공유 게이트웨이는 한 프로세스가 전 워크스페이스를 서빙하고,
//   구성원 아이디는 워크스페이스끼리 겹칠 수 있다(같은 사람이 두 워크스페이스에 있다). 세션 id 만으로 두면 한 워크스페이스의
//   얼굴 줄이 다른 워크스페이스로 밀려 나갈 수 있다(pushViewers). 단일 테넌트 배포는 워크스페이스가 비어 종전과 같다.
const keyOf = (sessionId: string): string => (currentTenant()?.id ?? "") + "\u0000" + sessionId;

const fresh = (s: Stamp, now: number): boolean => now - s.last <= TTL_MS;   // 경계(정확히 TTL)는 아직 보고 있는 것

/** 이 사람이 지금 이 세션을 보고 있다. 멱등 — 이미 있으면 자리는 두고 시각만 연장한다. */
export function markViewing(sessionId: string, memberId: string, now = Date.now()): void {
  if (!sessionId || !memberId) return;
  const k = keyOf(sessionId);
  let m = stamps.get(k);
  if (!m) { m = new Map(); stamps.set(k, m); }
  const cur = m.get(memberId);
  // 살아 있는 도장은 **연장만** 한다 — first 를 그대로 두는 것이 곧 '자리 유지'다.
  if (cur && fresh(cur, now)) { cur.last = now; return; }
  // 처음 왔거나, 만료된 뒤 돌아왔다 — 그 사이 실제로 자리를 비웠으므로 새 도착으로 친다(first 를 지금으로).
  m.set(memberId, { first: now, last: now });
}

/** 지금 이 세션을 보고 있는 멤버 id — 도착 순. 늙은 도장은 여기서 함께 버린다. */
export function viewersOf(sessionId: string, now = Date.now()): string[] {
  return viewersAt(keyOf(sessionId), now);
}
function viewersAt(k: string, now: number): string[] {
  const m = stamps.get(k);
  if (!m) return [];
  for (const [uid, s] of m) if (!fresh(s, now)) m.delete(uid);
  if (!m.size) { stamps.delete(k); return []; }
  return [...m.entries()].sort((a, b) => a[1].first - b[1].first).map(([uid]) => uid);
}

/**
 * 이 사람이 이 세션 화면을 **떠났다**(다른 화면으로 옮겼다·창을 닫았다). TTL 을 기다리지 않고 자리를 비운다.
 *  ⚠ 창이 숨은 것(다른 앱으로 전환)은 떠난 것이 아니다 — 그건 도장이 멎고 TTL 이 늦게 지운다(머리말: 늦게 사라지는 쪽으로 실패).
 * @returns 실제로 자리를 비웠나(없던 사람이면 false)
 */
export function leaveViewing(sessionId: string, memberId: string): boolean {
  const k = keyOf(sessionId);
  const m = stamps.get(k);
  if (!m || !m.delete(memberId)) return false;
  if (!m.size) stamps.delete(k);
  return true;
}

// ── 밀기(#3870, 원준 2026-09-30: «아바타가 실시간으로 … 잘 안 되는 것 같다») ──────────────────────────────
//  종전엔 얼굴 줄이 **각자 찍는 도장의 응답**으로만 바뀌었다 — 누가 들어와도 나머지는 자기 다음 도장(≤16초)에야
//  알았고, 나간 사람은 TTL(45초) + 다음 도장까지 남았다. 그래서 줄이 바뀌면 그 세션을 보고 있는 사람들에게 민다.
//  무엇을 마지막으로 밀었나를 세션마다 기억해 **바뀐 때만** 민다(15초마다 같은 줄을 밀면 문패가 깜빡인다 — setViewers 머리말).
const pushed = new Map<string, string>();

/** 이 줄이 마지막으로 민 줄과 다른가 — 다르면 기억하고 true(= 지금 밀어라). 빈 줄이면 기억을 비운다(받을 사람이 없다). */
export function presenceShifted(sessionId: string, ids: readonly string[]): boolean {
  const k = keyOf(sessionId);
  const sig = ids.join("\n");
  if ((pushed.get(k) ?? "") === sig) return false;
  if (sig) pushed.set(k, sig); else pushed.delete(k);
  return true;
}

/**
 * 얼굴 줄이 바뀌었으면 **그 세션을 지금 보고 있는 사람들**에게 민다(실시간 스트림 notify/stream — 화면 web/v2/live-sync.ts).
 *  받을 사람을 보는 사람으로 좁히는 이유: 얼굴 줄은 그 세션 화면에만 있다. 세션 주인이라도 안 보고 있으면 받을 곳이 없다.
 *  워크스페이스는 이 요청의 것(hereSlug) — 매니지드 공유 게이트웨이에서 같은 아이디의 다른 워크스페이스로 새지 않는다(#4054).
 * @returns 민 스트림 수(안 바뀌었으면 0)
 */
export function pushViewers(sessionId: string, faces: ReadonlyArray<{ id: string; name: string }>): number {
  if (!presenceShifted(sessionId, faces.map((f) => f.id))) return 0;
  const ts = Date.now();
  const ws = hereSlug();
  const viewers = faces.map((f) => ({ id: f.id, name: f.name }));
  let n = 0;
  for (const f of faces) n += publishNotify({ ws, member: f.id }, { type: "presence", session: sessionId, viewers, key: `p:${sessionId}:${ts}`, ts });
  return n;
}

/** 아무도 안 보는 세션의 자리를 회수한다(게이트웨이 수명 내내 자라지 않게). */
export function sweepPresence(now = Date.now()): void {
  for (const k of [...stamps.keys()]) viewersAt(k, now);
  for (const k of [...pushed.keys()]) if (!stamps.has(k)) pushed.delete(k);
}

/** 세션이 사라졌다(종료·보관·복원) — 그 자리를 즉시 비운다. */
export function forgetPresence(sessionId: string): void {
  const k = keyOf(sessionId);
  stamps.delete(k);
  pushed.delete(k);
}

/** 관측용 — 지금 자리를 잡고 있는 세션 수. 자리 회수(sweep)가 실제로 되는지 밖에서 볼 수 있게 한다. */
export function presenceSessionCount(): number {
  return stamps.size;
}

export const PRESENCE_TTL_MS = TTL_MS;
export const PRESENCE_STAMP_MS = STAMP_MS;
