/** 다른 창의 브라우저 호스트가 보낸 «이 세션의 이 탭을 보여 달라» 사건. */
export interface BrowserRevealEvent {
  type: 'browser';
  kind: 'reveal';
  session: string;
  tab: string;
  key?: string;
  ts?: number;
}

/** 스트림 사건이 곁칸 마운트보다 먼저 온 짧은 순서 차이만 메운다. */
export const BROWSER_REVEAL_REPLAY_MS = 5_000;

/** 브라우저 탭 번호를 세션 곁칸 탭 열쇠로 바꾼다. */
export function browserRevealSlot(ev: BrowserRevealEvent, session: string | null): string | null {
  if (!session || ev.kind !== 'reveal' || ev.session !== session || !/^\d+$/.test(ev.tab)) return null;
  const n = Number(ev.tab);
  if (!Number.isSafeInteger(n) || n < 1 || n > 999) return null;
  return n === 1 ? 'web' : `web#${n}`;
}

/**
 * 셸 하나의 브라우저 표시 사건 허브. 세션마다 최신 한 건만 잠깐 보관해 마운트 순서 차이를 흡수한다.
 * 구독 콜백 하나가 던져도 나머지 화면은 계속 받는다.
 */
export class BrowserRevealHub {
  private readonly listeners = new Set<(ev: BrowserRevealEvent) => void>();
  private readonly recent = new Map<string, { ev: BrowserRevealEvent; at: number }>();

  push(ev: BrowserRevealEvent, now = Date.now()): void {
    for (const [session, row] of this.recent) {
      if (now - row.at > BROWSER_REVEAL_REPLAY_MS) this.recent.delete(session);
    }
    this.recent.set(ev.session, { ev, at: now });
    for (const fn of [...this.listeners]) { try { fn(ev); } catch { /* 한 곁칸의 오류가 다른 곁칸을 막지 않는다 */ } }
  }

  subscribe(fn: (ev: BrowserRevealEvent) => void, now = Date.now()): () => void {
    this.listeners.add(fn);
    for (const [session, row] of [...this.recent]) {
      if (now - row.at > BROWSER_REVEAL_REPLAY_MS) { this.recent.delete(session); continue; }
      try { fn(row.ev); } catch { /* 구독은 유지한다 — 다음 사건은 받을 수 있다 */ }
    }
    return () => { this.listeners.delete(fn); };
  }
}
