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
//  · ★ **아무도 안 보는 동안은 붙어 있지 않는다** (#5398) — 구독마다 자기 화면(anchor)을 주고, 그 화면들이
//    하나도 안 보이면(브라우저 탭이 숨었거나 · 셸이 그 세션 화면을 숨겼다) 연결을 끊고, 하나라도 다시 보이면
//    기다림 없이 곧바로 붙는다. 평문 http(HTTP/1.1)는 같은 주소에 연결이 6개뿐이고 모든 탭이 그 한도를 함께
//    쓴다 — 숨은 화면이 스트림을 물고 있으면 새로 연 화면의 평범한 요청이 대기열에서 영영 안 나온다
//    (터미널 «연결 준비 중…» 멈춤, 원인 지식 http1-6conn-limit-terminal-gate-stuck-5267). 셸의 알림
//    스트림(v2/live-sync.ts ③)과 같은 규칙이다.
//    끊긴 동안 놓친 것은 **다시 붙는 순간 서버가 지금 상태를 다시 준다**(src/terminal/routes.ts `/events` 첫머리:
//    작업 목록 · 걸린 물음과 그 전체 목록 · 사실 · 사용량 · 감시 상태) — 구독자는 그 첫머리를 재동기의 자리로 쓴다.
//    ⚖ 고른 교환: 숨은 세션 화면은 그동안 승인 물음(permission.asked) · «대화가 자랐다» 를 받지 않는다 — 숨은 DOM 에
//     카드를 그려 봐야 사람은 못 본다. 사람이 보는 «승인 대기 · 작업 중» 표시는 이 통로가 아니라 세션 목록(8초 폴링)과
//     셸 알림 스트림(v2/live-sync.ts)이 낸다 — 열지 않은 세션과 같은 길이다. 돌아오면 첫머리가 걸린 물음을 다시 준다.
//     HTTPS(HTTP/2)에서도 같은 규칙이 돈다: 세션을 옮길 때마다 연결 하나를 새로 맺는 값이고, 서버의 대화 파일 감시는
//     참조가 0 이 돼도 20초 들고 있어(transcript-watch LINGER_MS) 잦은 전환에 감시자가 다시 뜨지 않는다.
import { apiUrl, TOKEN_KEY } from './core.js';
import { splitSse } from './sse-frames.js';
import { watchShown, type ShownWatch } from './lib/shown.js';

export type SessionEventFn = (e: unknown) => void;

export interface SessionEventsOpts {
  /**
   * 이 구독의 화면 — 이 요소가 그려져 있고 문서가 보일 때만 이 구독이 연결을 원한다(#5398).
   *  ⚠ 화면이 보이는 동안 **늘** 상자가 있는 요소를 준다(화면의 바깥 틀). 비어 있으면 숨는 조각(독·카드 자리)을
   *   주면 화면이 보이는데도 연결이 끊긴다. 안 주면 문서가 보이는지만 본다.
   */
  anchor?: Element | null;
}

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

interface Sub {
  fn: SessionEventFn;
  watch: ShownWatch;
}
interface Conn {
  subs: Set<Sub>;
  ctl: AbortController;
  closed: boolean;
  /** 지금 붙어 있는(또는 붙는 중인) 시도 — 아무도 안 보게 되면 이것을 끊는다. */
  attempt: AbortController | null;
  /** 숨어서 끊었다(실패가 아니다) — 다음 바퀴는 백오프 없이 곧바로 간다. */
  hidAbort: boolean;
  /** 마지막으로 잰 «누가 보나» — 안 보다가 보게 되는 순간(올라섬)을 가린다. */
  seen: boolean;
  /** 기다리는 동안(멈춤 · 백오프)의 깨우개 — 누가 다시 보는 순간 부른다. */
  wake: (() => void) | null;
}
const conns = new Map<string, Conn>();

function authHeaders(): Record<string, string> {
  const tok = localStorage.getItem(TOKEN_KEY);
  return tok ? { Authorization: 'Bearer ' + tok } : {};
}

/** 이 연결을 지금 누가 보고 있나 — 구독 중 하나라도 화면이 보이면 참. */
function wanted(c: Conn): boolean {
  for (const s of c.subs) if (s.watch.shown()) return true;
  return false;
}

/**
 * 보임이 바뀌었다 — 아무도 안 보면 도는 시도를 끊고(자리를 내준다), 안 보다가 누가 보게 되면 기다림을 깨운다.
 *  ★ 깨우는 것은 멈춤만이 아니다 — **백오프도** 깨운다. 게이트웨이 재기동 중이라 대기가 15초(죽은 세션은 60초)로
 *   늘어 있어도, 사람이 막 다시 본 화면은 그만큼 묵지 않는다(셸 알림 스트림 live-sync 의 «돌아왔으면 기다리지 않는다» 와 같다).
 *   올라서는 순간에만 깨운다 — 보는 채로 구독이 붙고 떨어지는 것으로 백오프를 건너뛰지 않는다.
 */
function reconcile(c: Conn): void {
  if (c.closed) return;
  const now = wanted(c);
  const rising = now && !c.seen;
  c.seen = now;
  if (rising) {
    const w = c.wake;
    c.wake = null;
    w?.();
  } else if (!now && c.attempt) {
    c.hidAbort = true;
    c.attempt.abort();
  }
}

/**
 * 기다린다 — ms 가 지나거나(false), 누가 다시 봐서 깨우거나(true), 연결이 닫히면(false) 돌아온다.
 *  ms 가 무한이면 «멈춤»(아무도 안 보는 동안)이다.
 */
function nap(c: Conn, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (c.closed) { resolve(false); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (woke: boolean): void => {
      if (timer) clearTimeout(timer);
      c.ctl.signal.removeEventListener('abort', onClose);
      if (c.wake === onWake) c.wake = null;
      resolve(woke);
    };
    const onWake = (): void => finish(true);
    const onClose = (): void => finish(false);
    c.wake = onWake;
    c.ctl.signal.addEventListener('abort', onClose);
    if (Number.isFinite(ms)) timer = setTimeout(() => finish(false), ms);
  });
}

async function pump(sessionId: string, c: Conn): Promise<void> {
  let wait = 1000;
  let gone = false;
  while (!c.closed) {
    //  ★ 아무도 안 보면 **붙지 않고 기다린다** — 숨은 화면이 연결 자리를 물지 않게(머리말 ★).
    if (!wanted(c)) { c.seen = false; await nap(c, Infinity); continue; }
    c.seen = true;
    const attempt = new AbortController();
    c.attempt = attempt;
    c.hidAbort = false;
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
          for (const s of [...c.subs]) {
            try { s.fn(ev); } catch { /* 한 구독자의 예외가 나머지를 막지 않는다 */ }
          }
        }
      }
    } catch { /* 끊겼다 — 아래에서 다시 붙는다 */ }
    finally {
      if (silence) clearTimeout(silence);
      c.ctl.signal.removeEventListener('abort', onAbortAll);
      if (c.attempt === attempt) c.attempt = null;
    }
    if (c.closed) break;
    //  숨어서 끊었다 — 실패가 아니므로 백오프 없이 다음 바퀴로 간다. 아직 숨어 있으면 위에서 멈추고, 그새(같은 틱에)
    //   다시 보였으면 곧바로 붙는다 — 그 사이에 «다시 보임» 은 이미 지나가서 아무도 깨워 주지 않는다.
    const byHide = c.hidAbort;
    c.hidAbort = false;
    if (byHide || !wanted(c)) continue;
    const woke = await nap(c, gone ? GONE_RETRY_MS : wait);
    if (woke) { wait = 1000; continue; }                 // 사람이 막 다시 봤다 — 기다리지 않는다(reconcile ★)
    wait = Math.min(wait * 1.6, 15_000);                 // 게이트웨이 재기동 중에 폭주하지 않게
  }
}

/**
 * 이 세션의 상태 통로를 구독한다. 반환값을 부르면 해지하고, **마지막 구독이 떠나면 연결을 닫는다**.
 *  구독의 화면(opts.anchor)이 하나도 안 보이는 동안은 연결을 끊어 둔다(#5398 — 머리말 ★).
 *
 *  ⚠ 서버에선 이 연결 하나가 대화 파일 감시자의 참조를 쥔다(#3699) — 안 닫으면 아무도 안 보는
 *   세션의 감시가 남는다. 해지를 빠뜨리지 마라(화면 destroy 에서 반드시 부른다).
 */
export function onSessionEvents(sessionId: string, fn: SessionEventFn, opts: SessionEventsOpts = {}): () => void {
  let c = conns.get(sessionId);
  const fresh = !c;
  if (!c) {
    c = { subs: new Set(), ctl: new AbortController(), closed: false, attempt: null, hidAbort: false, seen: false, wake: null };
    conns.set(sessionId, c);
  }
  const cur = c;
  const sub: Sub = { fn, watch: watchShown(opts.anchor ?? null, () => reconcile(cur)) };
  cur.subs.add(sub);
  if (fresh) void pump(sessionId, cur);
  else reconcile(cur);                                   // 멈춰 있던 연결에 보이는 구독이 붙었다 — 곧바로 깨운다
  let off = false;
  return () => {
    if (off) return;                                     // 두 번 불러도 남의 구독을 지우지 않는다
    off = true;
    sub.watch.stop();
    cur.subs.delete(sub);
    if (cur.subs.size) { reconcile(cur); return; }       // 남은 구독이 아무도 안 보면 그 자리에서 끊는다
    cur.closed = true;
    try { cur.ctl.abort(); } catch { /* noop */ }
    if (conns.get(sessionId) === cur) conns.delete(sessionId);
  };
}
