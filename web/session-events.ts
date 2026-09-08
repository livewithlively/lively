// 세션 상태 통로(#2439)의 **연결 한 벌** — 같은 세션을 보는 구독자들이 SSE 하나를 나눠 쓴다 (#3699).
//
//  ── 왜 뽑았나 ────────────────────────────────────────────────────────────────────
//  종전엔 이 통로를 `session-tasks.ts` 가 **혼자** 열었고, 그것도 `runtimeMode === 'chat'` 일 때만 열었다
//   («올 것이 없는 SSE 를 세션마다 여는 것은 낭비다» — 맞는 판단이었다). 그런데 #3699 이 이 통로에
//   «대화 파일이 자랐다» 를 실으면서 **터미널 모드 세션에도 올 것이 생겼다** — 폴링을 통보로 바꾸는
//   그 대상이 정확히 그 세션들이다. 그렇다고 화면마다 각자 열면 같은 세션에 연결이 둘이 된다.
//  그래서 연결은 여기 한 벌, 구독은 여럿. 마지막 구독이 떠나면 닫는다(서버에서 이 연결이 곧 감시자의
//   참조라, 안 닫으면 아무도 안 보는 세션의 감시가 남는다).
//
//  ── 이 층이 지키는 것 ────────────────────────────────────────────────────────────
//  · **말 없는 연결을 살아 있는 것으로 착각하지 않는다** — 서버가 25초마다 하트비트를 보내므로 그보다
//    넉넉한 동안 한 바이트도 안 오면 죽은 것이다. 종전에 이걸 안 봐서 재접속 루프가 통째로 멈췄고
//    화면이 영영 '작업 중' 으로 남았다(실측 2026-08-26, `session-codex-live.ts` 머리말이 정본).
//  · **구독자가 던져도 다른 구독자에게 계속 간다** — 화면 한 조각의 버그가 같은 연결의 나머지를
//    멈추게 하지 않는다(서버 `runtime-bus.emitSessionEvent` 와 같은 규율).
//  · EventSource 를 안 쓴다 — 헤더를 못 실어 토큰이 주소로 샌다. fetch 스트림으로 읽는다.
import { apiUrl, TOKEN_KEY } from './core.js';
import { splitSse } from './sse-frames.js';

export type SessionEventFn = (e: unknown) => void;

/** 서버 하트비트(25초)보다 넉넉한 침묵 상한 — 넘으면 끊고 새로 붙는다. */
const SILENCE_MS = 40_000;
/**
 * «이 세션엔 붙을 수 없다»(404) 를 받았을 때의 재시도 간격.
 *
 *  ★ 왜 따로 두나: 이 통로는 이제 **모든 세션 화면**이 연다(#3699 — 폴링을 줄일 대상이 터미널 모드
 *   박스 세션이라 하네스·모드를 안 가린다). 그런데 죽은 세션의 화면도 기록을 보려고 열려 있고,
 *   거기서 `/events` 는 계속 404 다. 평범한 백오프(≤15초)로 두면 그 화면이 열려 있는 내내
 *   15초마다 되묻는다 — **줄이려던 낭비를 다른 이름으로 되만드는 일**이다.
 *  ⚠ 그렇다고 영구 정지시키지 않는다: «죽었다» 는 판정은 틀릴 수 있고(#2108 — 3초 스냅샷 지연을
 *   죽음으로 읽었다), 영구 정지면 되살아난 세션의 화면이 영영 통보를 못 받는다. 느슨히 계속 본다.
 */
const GONE_RETRY_MS = 60_000;

interface Conn {
  subs: Set<SessionEventFn>;
  ctl: AbortController;
  closed: boolean;
}
const conns = new Map<string, Conn>();

function authHeaders(): Record<string, string> {
  const tok = localStorage.getItem(TOKEN_KEY);
  return tok ? { Authorization: 'Bearer ' + tok } : {};
}

async function pump(sessionId: string, c: Conn): Promise<void> {
  let wait = 1000;
  let gone = false;
  while (!c.closed) {
    const attempt = new AbortController();
    const onAbortAll = (): void => attempt.abort();
    c.ctl.signal.addEventListener('abort', onAbortAll);
    let silence: ReturnType<typeof setTimeout> | null = null;
    const beat = (): void => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => attempt.abort(), SILENCE_MS);
    };
    try {
      const res = await fetch(apiUrl(`/api/ui/terminal/sessions/${encodeURIComponent(sessionId)}/events`), {
        headers: authHeaders(), signal: attempt.signal, credentials: 'same-origin',
      });
      //  붙을 수 없는 세션(죽었거나 남의 것)은 **느슨히** 다시 본다 — 위 GONE_RETRY_MS 주석 참조.
      if (res.status === 404) { gone = true; throw new Error('세션 없음 (404)'); }
      if (!res.ok || !res.body) throw new Error(`스트림 실패 (${res.status})`);
      gone = false;
      wait = 1000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      beat();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        beat();
        acc += dec.decode(value, { stream: true });
        const cut = splitSse(acc);                       // 자르기 계약은 순수 모듈이 쥔다(web/sse-frames.ts)
        acc = cut.rest;
        for (const d of cut.data) {
          let ev: unknown;
          try { ev = JSON.parse(d); } catch { continue; }   // 깨진 프레임 한 장은 넘긴다
          for (const fn of [...c.subs]) {
            try { fn(ev); } catch { /* 한 구독자의 예외가 나머지를 막지 않는다 */ }
          }
        }
      }
    } catch { /* 끊겼다 — 아래에서 다시 붙는다 */ }
    finally {
      if (silence) clearTimeout(silence);
      c.ctl.signal.removeEventListener('abort', onAbortAll);
    }
    if (c.closed) break;
    await new Promise((r) => setTimeout(r, gone ? GONE_RETRY_MS : wait));
    wait = Math.min(wait * 1.6, 15_000);                 // 게이트웨이 재기동 중에 폭주하지 않게
  }
}

/**
 * 이 세션의 상태 통로를 구독한다. 반환값을 부르면 해지하고, **마지막 구독이 떠나면 연결을 닫는다**.
 *
 *  ⚠ 서버에선 이 연결 하나가 대화 파일 감시자의 참조를 쥔다(#3699) — 안 닫으면 아무도 안 보는
 *   세션의 감시가 남는다. 해지를 빠뜨리지 마라(화면 destroy 에서 반드시 부른다).
 */
export function onSessionEvents(sessionId: string, fn: SessionEventFn): () => void {
  let c = conns.get(sessionId);
  if (!c) {
    c = { subs: new Set(), ctl: new AbortController(), closed: false };
    conns.set(sessionId, c);
    void pump(sessionId, c);
  }
  const cur = c;
  cur.subs.add(fn);
  let off = false;
  return () => {
    if (off) return;                                     // 두 번 불러도 남의 구독을 지우지 않는다
    off = true;
    cur.subs.delete(fn);
    if (cur.subs.size) return;
    cur.closed = true;
    try { cur.ctl.abort(); } catch { /* noop */ }
    if (conns.get(sessionId) === cur) conns.delete(sessionId);
  };
}
