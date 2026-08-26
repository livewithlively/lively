// v2/live-sync.ts — 서버가 사건을 **미는 그 순간** 셸이 다시 읽는다 (#2041)
//
// ── 무엇이 문제였나 (상민님 2026-08-26) ──────────────────────────────────────
//  "세션 상태가 바뀌어서 앱에서 알림이 오는 순간 사이드바를 보면 아직 바뀌기 전으로 보인다."
//  두 표면이 같은 사건을 **다른 시계**로 보고 있었다:
//   · 배너     — 데스크톱 앱이 SSE 로 받는다. 훅 보고 → 발행 → OS 배너까지 실측 평균 5ms(#1842 §6).
//   · 사이드바 — 웹 셸의 8초 폴링(v2/main.ts). 방금 끝난 세션은 최대 8초 뒤에야 목록에 반영된다.
//  즉 배너는 "끝났다"는데 목록은 아직 '작업 중'인 창이 최대 8초 열린다. 사람은 그 창에서 알림을
//  의심하거나 새로고침을 누른다 — 알림이 스스로를 못 미덥게 만드는 자리다.
//
// ── 어디에 맞출 것인가 — 받는 쪽이 아니라 **미는 쪽** ────────────────────────
//  게이트웨이는 전이가 일어난 그 순간을 이미 알고, 이미 밀고 있다(src/terminal/routes.ts → v6/notify-bus).
//  배너가 그 순간에 뜨는 것이라면 사이드바도 **같은 순간**을 봐야 한다. 그래서 새 시점을 정의하지 않고
//  이미 있는 시점에 얹는다 — 셸이 같은 스트림(`GET /api/ui/notify/stream`)을 함께 구독한다.
//  두 시계를 맞추는 게 아니라 시계를 하나로 만드는 쪽이다(맞추기는 반드시 다시 어긋난다).
//
// ── 경계 셋 (되돌리기 쉬운 자리라 적어 둔다) ─────────────────────────────────
//  ① **배너를 만들지 않는다.** 사건을 해석하지도 않는다 — "무언가 바뀌었으니 다시 읽어라"만 전한다.
//     해석·문구는 앱 한 곳이 한다(#1842 §3 · #1571 이 경계한 '판정이 두 벌로 갈라진다'). 여기서 배너까지
//     띄우면 데스크톱 앱 안에서 한 사건에 배너가 두 장이다.
//     ★ 다시 읽기는 몇 번 해도 결과가 같다(idempotent) — 그래서 데스크톱 앱 안이라고 물러나지 않아도 되고,
//      폴링을 끄지 않아도 된다. 배너는 그렇지 않다(#1842 의 streamAlive 게이팅이 필요했던 이유). 그 차이가
//      이 모듈이 배너 규율과 갈리는 유일한 근거다.
//  ② **폴링의 대체가 아니라 앞당기기다.** 스트림이 안 미는 변화(세션 생성·이름·프로젝트·앱 인스턴스)는
//     여전히 8초 폴링만 본다. 스트림이 끊기면 그 자리에서 폴링이 이어받는다 — 그래서 폴링을 그대로 둔다.
//  ③ **화면이 숨으면 끊는다.** HTTP/1.1 은 오리진당 연결이 6개뿐이라, 탭마다 스트림을 물고 있으면 그
//     예산을 갉아먹는다(웹터미널·파일·미리보기가 같은 예산을 쓴다). 숨은 동안은 8초 폴링도 건너뛰므로
//     스트림을 유지할 이유가 없고, 돌아오는 순간 visibilitychange 가 한 판 당긴다(main.ts).
import { TOKEN_KEY, apiUrl } from '../core.js';
import { parseSse, retryDelay, stableConnection } from './sse.js';
let started = false;
let ctl = null;
let timer = 0;
let tries = 0;
let dead = false; // 되살아날 수 없는 실패(401) — 로그인 게이트가 뜨고 새로고침이 따라온다
/**
 * 실시간 스트림을 켠다. 한 번만 켜지고(중복 호출 무해), 화면이 보일 때만 연결을 유지한다.
 * @param onChange 사건이 왔다 — "다시 읽어라". 해석할 것이 없으므로 인자를 주지 않는다.
 *  ⚠ 몰아 읽기(coalesce)는 **호출자 책임**이다: 세션 20개가 동시에 끝나면 이 콜백도 20번 불린다
 *   (#1842 가 겨냥한 바로 그 상황). main.ts 의 refreshSideSoon 이 창으로 합친다.
 */
export function startLiveSync(onChange) {
    if (started)
        return;
    started = true;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopStream();
            return;
        }
        tries = 0; // 돌아왔으면 기다리지 않는다 — 사람이 지금 보고 있다
        void connect(onChange);
    });
    if (!document.hidden)
        void connect(onChange);
}
/** 지금 스트림이 붙어 있나. 진단용(화면이 이 값으로 무엇을 바꾸지는 않는다). */
export function liveSyncAlive() { return !!ctl; }
function stopStream() {
    if (timer) {
        clearTimeout(timer);
        timer = 0;
    }
    const c = ctl;
    ctl = null;
    if (c) {
        try {
            c.abort();
        }
        catch { /* 이미 끝난 연결 */ }
    }
}
function scheduleRetry(onChange) {
    if (dead || timer || document.hidden)
        return; // 숨은 동안은 안 붙는다 — 돌아올 때 visibilitychange 가 붙인다
    timer = window.setTimeout(() => { timer = 0; void connect(onChange); }, retryDelay(tries++));
}
async function connect(onChange) {
    if (dead || ctl)
        return;
    const token = (() => { try {
        return localStorage.getItem(TOKEN_KEY) || '';
    }
    catch {
        return '';
    } })();
    if (!token) {
        scheduleRetry(onChange);
        return;
    } // 아직 로그인 전 — 곧 다시 본다
    const mine = new AbortController();
    ctl = mine;
    let openedAt = 0;
    try {
        const res = await fetch(apiUrl('/api/ui/notify/stream'), {
            headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' },
            signal: mine.signal,
        });
        // 401 = 죽은 토큰. 다시 붙어도 같은 답이라 그만둔다 — 로그인 게이트는 api() 가 띄운다(lib/net.ts).
        if (res.status === 401) {
            dead = true;
            return;
        }
        // 구 게이트웨이엔 이 표면이 없다(404) — 조용히 폴링만 쓴다(그래서 폴링을 없애지 않았다).
        //  게이트웨이가 올라오는 중일 수도 있으므로 백오프로 계속 두드린다.
        if (!res.ok || !res.body)
            return;
        openedAt = Date.now();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buf += dec.decode(value, { stream: true });
            const out = parseSse(buf);
            buf = out.rest;
            // 지금 이 스트림이 싣는 것은 세션 전이뿐이다. 모르는 종류가 늘어도 **다시 읽으면 그만**이므로
            //  종류를 좁혀 거르지 않는다 — 거르면 나중에 새 사건이 조용히 무시된다.
            if (out.events.length)
                onChange();
        }
    }
    catch { /* 끊김·타임아웃·게이트웨이 재시작·abort — 아래에서 다시 붙는다 */ }
    finally {
        if (ctl === mine) {
            ctl = null;
            // ⚠ '붙었으니 성공'이 아니다 — **붙어서 얼마나 살았나**로 되돌린다(sse.ts stableConnection 머리말:
            //  붙자마자 끊기는 서버에 초당 한 번씩 20초에 19번 재접속한 실측이 이 한 줄의 근거다).
            if (openedAt && stableConnection(Date.now() - openedAt))
                tries = 0;
            scheduleRetry(onChange);
        }
    }
}
