// asks/api.ts — 세션 요청(#5713)의 화면 쪽 통로: 서버 표면(src/capabilities/session-ask.ts) 부르기 + 목록 받아 보기.
//
//  세션 요청 = 세션의 AI 가 사람에게 화면으로 받는 것(값 입력 · 고르기 · 파일 올리기 …). 종전엔 리브 전용이라
//   리브 현황(GET /api/ui/me/liv 의 secretAsk 한 칸)을 6초마다 되물어 그렸다. 이제 요청마다 한 행이고 세션마다 여럿일 수 있다.
//  ── 받아 보기 ──
//  같은 범위(그 세션 · 전부)를 보는 자리들은 **한 벌**을 나눠 받는다(셸이 탭을 세울지 · 칸이 무엇을 그릴지 — 붙은 앱 목록과 같은 결,
//   v2/session-app-pane.ts watchSessionApps). 서버가 요청이 걸리고 끝나는 순간을 민다(live-sync onAskEvent) — 그때 다시 읽는다.
//   스트림이 끊긴 사이를 메우려고 느린 되묻기(15초 · 화면이 보일 때만)를 곁에 둔다.
import { api } from '../core.js';
import { onAskEvent } from '../v2/live-sync.js';

/** 요청 하나 — 서버 AskView 와 같은 모양. payload 에 값은 없다(무엇을 받을지만 있다). */
export interface Ask {
  id: string;
  kind: string;
  /** 종류의 사람 이름 — 화면이 그 종류를 모를 때(새 서버 · 옛 화면) 폴백 카드가 쓴다. */
  kind_label: string;
  title: string;
  session_id: string | null;
  status: 'open' | 'done' | 'dismissed' | 'canceled';
  created_at: string;
  resolved_at: string | null;
  payload: Record<string, any>;
  result: Record<string, any> | null;
}

const item = (id: string, tail = ''): string => '/api/ui/me/asks/item/' + encodeURIComponent(id) + tail;

/** 내 열린 요청 — session 을 주면 그 세션에서 건 것만. */
export async function listAsks(session?: string | null): Promise<Ask[]> {
  const out: any = await api('/api/ui/me/asks' + (session ? '?session=' + encodeURIComponent(session) : ''));
  return Array.isArray(out?.asks) ? out.asks : [];
}

/** 요청 하나(상태 무관). 없거나 남의 것이면 null. */
export async function getAsk(id: string): Promise<Ask | null> {
  try { const out: any = await api(item(id)); return out?.ask ?? null; } catch { return null; }
}

/** 답을 보낸다 — 몸통은 종류가 정한다. 돌아오는 say = 요청을 건 세션에 넣을 한 마디(없을 수 있다). */
export async function submitAsk(id: string, body: Record<string, unknown>): Promise<{ ask: Ask; say: string | null }> {
  const out: any = await api(item(id, '/submit'), { method: 'POST', body: JSON.stringify(body) });
  return { ask: out?.ask, say: out?.say ?? null };
}

export async function dismissAsk(id: string): Promise<void> {
  await api(item(id, '/dismiss'), { method: 'POST', body: '{}' });
}

/**
 * 끝난 요청의 한 마디를 그 세션에 넣어 달라고 한다. told=true 면 넣지 않고 «화면이 이미 보냈다» 만 적는다.
 *  delivered:false 면 못 넣은 것이다(로컬 터미널의 AI · 멈춘 세션) — say 를 사람에게 보여 직접 전하게 한다.
 */
export async function tellAsk(id: string, told = false): Promise<{ delivered: boolean; say?: string; reason?: string }> {
  try {
    const out: any = await api(item(id, '/tell'), { method: 'POST', body: JSON.stringify(told ? { told: true } : {}) });
    return { delivered: !!out?.delivered, say: out?.say, reason: out?.reason };
  } catch (_) { return { delivered: false, reason: 'error' }; }
}

// ── 받아 보기 ────────────────────────────────────────────────────────────────────────
/** 범위 열쇠 — 세션 id, 또는 «내 것 전부». */
export const ALL_ASKS = '*';
type Listener = (asks: Ask[], added: string[]) => void;
interface Entry { asks: Ask[] | null; subs: Set<Listener>; seq: number; poll: number }
const entries = new Map<string, Entry>();
const POLL_MS = 15_000;

/** 그리는 쪽이 «같은 요청인가» 를 가르는 표 — 요청의 내용이 바뀌면(같은 id 로는 안 바뀌지만 방어) 다시 그린다. */
export const askSignature = (a: Ask): string => a.id + ':' + a.status + ':' + JSON.stringify(a.payload);

/** 목록이 바뀐 만큼만 알린다 — 새로 생긴 요청 id(첫 판은 비교할 게 없어 빈 목록: 화면을 열자마자 탭을 뺏지 않게). 순수. */
export function asksDiff(prev: readonly Ask[] | null, next: readonly Ask[]): { added: string[]; changed: boolean } {
  if (prev === null) return { added: [], changed: true };
  const was = new Set(prev.map((a) => a.id));
  const added = next.filter((a) => !was.has(a.id)).map((a) => a.id);
  const changed = added.length > 0 || prev.length !== next.length || prev.some((a, i) => askSignature(a) !== askSignature(next[i]));
  return { added, changed };
}

/** 그 범위의 목록을 지금 다시 읽는다(범위를 안 주면 받아 보는 범위 전부). */
export function refreshAsks(scope?: string): void {
  for (const [key, e] of entries) {
    if (scope !== undefined && key !== scope) continue;
    const mine = ++e.seq;
    void listAsks(key === ALL_ASKS ? null : key).then((rows) => {
      if (mine !== e.seq || entries.get(key) !== e) return;          // 늦게 온 판 · 구독이 다 끊긴 뒤의 판
      const d = asksDiff(e.asks, rows);
      e.asks = rows;
      if (!d.changed) return;
      for (const fn of [...e.subs]) { try { fn(rows, d.added); } catch { /* 한 구독이 다른 구독을 막지 않는다 */ } }
    }).catch(() => { /* 판정 불가 — 받던 대로 둔다(빈 목록으로 덮으면 카드가 사라졌다 돌아온다) */ });
  }
}

/** 그 범위(세션 id · ALL_ASKS)의 열린 요청을 받는다. 이미 받은 판이 있으면 곧바로 한 번 부른다. 돌려주는 함수로 끊는다. */
export function watchAsks(scope: string, fn: Listener): () => void {
  let e = entries.get(scope);
  if (!e) {
    e = { asks: null, subs: new Set(), seq: 0, poll: 0 };
    entries.set(scope, e);
    e.poll = window.setInterval(() => { if (!document.hidden) refreshAsks(scope); }, POLL_MS);
  }
  e.subs.add(fn);
  if (e.asks) { try { fn(e.asks, []); } catch { /* */ } }
  if (e.subs.size === 1) refreshAsks(scope);
  const ent = e;
  return () => {
    ent.subs.delete(fn);
    if (!ent.subs.size) { window.clearInterval(ent.poll); if (entries.get(scope) === ent) entries.delete(scope); }
  };
}

//  서버가 민 사건 — 그 세션을 보는 범위와 «전부» 범위가 다시 읽는다. 세션을 모르는 요청(session null)은 «전부» 만.
onAskEvent((ev) => {
  if (ev.session && entries.has(ev.session)) refreshAsks(ev.session);
  if (entries.has(ALL_ASKS)) refreshAsks(ALL_ASKS);
});
