// v2/hist-side.ts — 셸 쪽: 「세션 이력」 앱 사이드바의 재료와 고른 것의 한 자리(#4553 안 A, 원준 2026-10-05 «A안으로 고고»).
//
//  세션 이력 앱은 액자(클래식 화면) 안에 있고 사이드바는 셸에 있다. 줄은 **액자 안 앱이 보낸다**(sessions-scope.ts) — 그 앱의
//  「세션 목록」 탭이 보이는 줄 그대로라 사이드바의 수와 본문의 수가 같다. 셸은 받아서 그리고(side.ts renderHistorySection),
//  사람이 고른 것을 액자에 돌려보낸다. 규칙(묶기 · 범위)은 lib/hist-scope.ts 한 벌을 양쪽이 읽는다.
//  고른 것은 기억하지 않는다(페이지 수명) — 「세션 목록」 사이드바(sess-scope.ts)와 같은 규칙. 액자가 다시 서도(앱을 떠났다 돌아옴)
//  셸이 쥔 값을 다시 알려 주므로 보던 범위가 그대로다.
import {
  HIST_FIND_MSG, HIST_ROWS_MSG, HIST_SCOPE0, HIST_SCOPE_MSG, parseHistRows, type HistScope, type HistSideRow,
} from '../lib/hist-scope.js';

let rows: HistSideRow[] | null = null;
/** 줄에 «남긴 것» 이 실려 왔나 — 아니면 «남긴 것별» 카드는 아직 못 센다. */
let kinds = false;
/** 액자가 일지를 받으려다 실패했다 — «세는 중» 대신 그렇다고 말한다. */
let kindsFailed = false;
/** 줄이 한 축만 받은 판이다(도는 세션 · 기록 가운데 하나가 실패) — 수가 덜 찼을 수 있어 고른 것을 풀지 않는다. */
let partial = false;
/** 액자가 줄을 하나도 못 받았다고 알려 왔다 — 받아 둔 줄이 없을 때만 읽는다(«받는 중» 대신 그렇다고 말한다). 줄이 한 번 오면 더는 안 읽힌다. */
let failed = false;
let scope: HistScope = { ...HIST_SCOPE0 };
let onChange: (() => void) | null = null;
let bound = false;

/** 세션 이력 앱을 실은 액자들 — 셸 탭마다 하나씩 설 수 있다. 신호는 이 창들하고만 주고받는다. */
function frames(): Window[] {
  const out: Window[] = [];
  for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe.v2-frame'))) {
    if (f.dataset.appKey === 'sessions' && f.contentWindow) out.push(f.contentWindow);
  }
  return out;
}
/** 그 가운데 지금 화면에 보이는 것(감춰 둔 셸 탭의 액자는 뺀다). */
function visibleFrames(): Window[] {
  const out: Window[] = [];
  for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe.v2-frame'))) {
    if (f.dataset.appKey === 'sessions' && f.contentWindow && f.getClientRects().length > 0) out.push(f.contentWindow);
  }
  return out;
}
function post(msg: unknown, to: Window[] = frames()): void {
  for (const w of to) { try { w.postMessage(msg, location.origin); } catch { /* 떠난 액자 */ } }
}

export function histSideRows(): HistSideRow[] | null { return rows; }
export function histSideKinds(): boolean { return kinds; }
export function histSideKindsFailed(): boolean { return kindsFailed && !kinds; }
export function histSidePartial(): boolean { return partial; }
export function histSideFailed(): boolean { return failed; }
export function histSideScope(): HistScope { return scope; }
/**
 * 고른 것을 바꾸고 액자에 알린다. pick = 사람이 방금 눌렀다 — 액자가 대화록 단독 화면이면 앱으로 돌아와 그 범위를 보인다.
 *  사라진 카드를 푸는 것처럼 셸이 스스로 바꾼 것은 pick 이 아니다(보던 화면을 옮기지 않는다).
 */
export function setHistSideScope(next: HistScope, pick = false): void {
  scope = next;
  if (next.by === 'kind' && !kinds) kindsFailed = false;   // 다시 청한다 — 답이 올 때까지는 «세는 중»
  //  «사람이 눌렀다» 는 지금 보이는 액자에만 싣는다 — 감춰 둔 셸 탭의 액자가 대화록 단독 화면이면 그 표에 앱으로 튕긴다.
  const all = frames();
  const seen = pick ? visibleFrames() : [];
  post({ type: HIST_SCOPE_MSG, scope, pick: true }, seen);
  post({ type: HIST_SCOPE_MSG, scope }, all.filter((w) => !seen.includes(w)));
}
/** 사이드바의 찾기 단추 — 액자의 「대화 찾기」 탭으로. */
export function askHistFind(): void { post({ type: HIST_FIND_MSG }); }

/** 액자가 보내는 줄을 듣는다(한 번만 건다). cb = 줄이 왔다 — 사이드바를 다시 그릴 자리. */
export function bindHistSide(cb: () => void): void {
  onChange = cb;
  if (bound) return;
  bound = true;
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== location.origin) return;
    const m: any = ev.data;
    if (!m || typeof m !== 'object' || m.type !== HIST_ROWS_MSG) return;
    const src = ev.source as Window | null;
    if (!src || !frames().includes(src)) return;   // 세션 이력 액자가 보낸 것만
    //  줄 없는 신호는 인사다 — 지금 고른 것만 알려 준다(액자가 첫 화면을 그 범위로 그린다). failed = 줄을 못 받았다는 알림(받아 둔 줄은 그대로 둔다).
    if (m.rows !== undefined) {
      const got = parseHistRows(m.rows);
      if (!got) return;
      rows = got;
      kinds = !!m.kinds;
      kindsFailed = !!m.kindsFailed;
      partial = !!m.partial;
    } else if (m.failed === true) failed = true;
    post({ type: HIST_SCOPE_MSG, scope }, [src]);
    if ((m.rows !== undefined || m.failed === true) && onChange) onChange();
  });
}
