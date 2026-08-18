// lib/inplace.ts — **제자리 갱신이 스크롤을 옮기지 않게** 하는 프리미티브 (#1635).
//  el/sv 와 같은 최하층 leaf 다 — 우리 모듈 import 0(순환 여지 없음). 소비 파일은 './core.js' 배럴에서 받는다.
//
// ── 왜 있나 ────────────────────────────────────────────────────────────────
//  "옵션 하나 바꿨더니 페이지가 맨 위로 튄다"는 신고(#1635 — 설정 ▸ 내 스킬·훅 토글, 어니스트 제보)의
//  원인은 둘이고, **둘 다 우리가 스크롤을 옮긴 적이 없다** — 브라우저가 클램프한 것이다:
//
//   ⓐ 비동기 재적재 중 문서 높이 붕괴.  자리를 '불러오는 중…' 한 줄로 비우고 fetch 를 기다리는 동안
//     문서가 짧아지고, 브라우저는 스크롤을 새 최대값으로 강제로 당긴다. 내용이 돌아와도 그 위치는
//     복구되지 않는다. 실측: 문서 6082→816px, scrollY 4000→64, 재적재 후 1611(누른 행은 화면 밖).
//     → busy() — 비우는 동안 **지금 높이를 예약**해 애초에 안 무너지게 한다.
//
//   ⓑ 사이드바 재생성.  좌측 사이드바는 sticky + overflow-y:auto 라 **자기 스크롤**을 갖는데, 항목을
//     고르면 페이지 전체를 다시 그려 사이드바가 새 DOM 노드로 바뀐다 → scrollTop 이 0 으로 돌아간다.
//     실측: 설정 300→0 · 프로젝트 400→0 · WIKI 문서 300→0(전부 sameNode:false).
//     → keepSideScroll() — 스크롤러의 위치를 key 로 기억했다가 같은 key 로 다시 만들어질 때 되돌린다.
//
//  ⚠ 프로젝트 탭의 pjvReloadKeepScroll/pjvRestoreScroll(projects/state.ts, #358·#1233)과 역할이 다르다 —
//   그쪽은 **본문(window·모달) 스크롤**을 전체 재렌더 너머로 나르는 장치고, 여기 둘은 (ⓐ) 애초에 무너뜨리지
//   않는 것과 (ⓑ) **사이드바 자체 스크롤**이다. 겹치지 않으므로 그대로 공존한다.
// ── ⓐ 높이를 예약한 채 비우기 ────────────────────────────────────────────────
//  해제는 '다음 내용이 들어올 때' 자동 — 호출부가 해제를 기억할 필요가 없다(비동기 경로마다 finally 를
//  다는 대신, 채우는 쪽의 childList 변경 1회를 신호로 쓴다. 실패해서 errorNote 를 넣어도 똑같이 풀린다).
const PINS = new WeakMap();
function unpin(host) {
    const p = PINS.get(host);
    if (!p)
        return;
    p.mo.disconnect();
    PINS.delete(host);
    host.style.minHeight = p.prev;
    host.removeAttribute('aria-busy');
}
// host 를 로딩 표시(nodes)로 비우되, 비어 있는 동안 **지금 높이를 예약**한다. replaceChildren 의 자리를 그대로 대체.
//  · 화면에 없거나 높이가 0 인 자리(첫 진입 렌더)는 예약할 것이 없다 → 평범한 replaceChildren 과 같다.
//  · aria-busy 를 함께 세워 스크린리더도 '갱신 중'을 안다(해제도 같이).
function busy(host, ...nodes) {
    if (!host)
        return;
    // 이미 예약 중이면 그 감시자를 먼저 끊는다 — 안 그러면 아래 replaceChildren 을 '내용이 들어왔다'로 읽고
    //  예약을 조기 해제한다(같은 자리를 연달아 재적재할 때 실제로 나던 구멍).
    const held = PINS.get(host);
    const prev = held ? held.prev : host.style.minHeight; // '예약 전' 원래 값을 잃지 않는다
    if (held) {
        held.mo.disconnect();
        PINS.delete(host);
    }
    const h = host.isConnected ? host.offsetHeight : 0; // box-sizing:border-box 전역(01-base.css) → min-height 와 같은 축
    if (h >= 1)
        host.style.minHeight = h + 'px';
    host.setAttribute('aria-busy', 'true');
    host.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null));
    // ⚠ observe() 는 위 replaceChildren **뒤**에 부른다 — MutationObserver 는 관측 시작 전의 변경을 기록하지
    //  않으므로, 방금 우리가 한 '비우기'는 해제 신호로 잡히지 않는다(이 순서가 계약이다).
    const mo = new MutationObserver(() => unpin(host));
    PINS.set(host, { mo, prev });
    mo.observe(host, { childList: true });
}
// ── ⓑ 사이드바 자체 스크롤 기억·복원 ────────────────────────────────────────
//  좌측 사이드바를 만드는 자리에서 한 줄 부르면 된다: keepSideScroll(node, 'admin').
//  key 는 화면(사이드바 종류)당 하나 — 같은 사이드바가 다시 만들어지면 그 위치로 돌아간다.
const SIDE_POS = new Map();
const SIDE_GEN = new Map(); // key 별 세대 — 새 사이드바가 뜨면 옛 노드의 복원 루프는 물러난다
let restoring = 0; // 복원하는 동안의 scroll 이벤트로 기억값이 오염되지 않게
function keepSideScroll(node, key) {
    if (!node || !key)
        return;
    // 사용자가 손으로 옮긴 위치만 기억한다(복원 중 발생한 scroll 은 무시).
    node.addEventListener('scroll', () => { if (!restoring)
        SIDE_POS.set(key, node.scrollTop); }, { passive: true });
    const gen = (SIDE_GEN.get(key) || 0) + 1;
    SIDE_GEN.set(key, gen);
    const want = SIDE_POS.get(key) || 0;
    if (!want)
        return;
    // 두 가지를 기다려야 해서 '한 번 세우고 끝'이 안 된다:
    //   ① 노드가 아직 문서에 안 붙었을 수 있다 — 사이드바를 만들고 **fetch 를 기다렸다가** 붙이는 화면이 있다
    //      (WIKI: createWikiSide → await ready → view.replaceChildren). 안 붙었으면 scrollTop 은 먹지 않는다.
    //   ② 붙어도 내용이 아직 짧으면 scrollTop 이 0 으로 클램프된다.
    //  그래서 목표에 앉을 때까지 창(2s) 안에서 매 프레임 다시 시도한다. 그 사이 사람이 스크롤하면 즉시 손을 뗀다
    //  (사람의 조작을 덮어쓰지 않는다 — projects/state.ts 의 pjvRestoreScroll 과 같은 규율).
    let done = false;
    const optsP = { passive: true, capture: true };
    const stop = () => { done = true; cleanup(); };
    const cleanup = () => {
        window.removeEventListener('wheel', stop, optsP);
        window.removeEventListener('touchmove', stop, optsP);
        window.removeEventListener('keydown', stop, true);
    };
    window.addEventListener('wheel', stop, optsP);
    window.addEventListener('touchmove', stop, optsP);
    window.addEventListener('keydown', stop, true);
    const t0 = Date.now();
    const tick = () => {
        if (done)
            return;
        if (SIDE_GEN.get(key) !== gen) {
            cleanup();
            return;
        } // 더 새 사이드바가 떴다 — 그쪽이 복원을 이어받는다
        if (node.isConnected) {
            restoring++;
            node.scrollTop = want;
            restoring--;
            if (node.scrollTop >= want - 1) {
                cleanup();
                return;
            }
        }
        if (Date.now() - t0 > 2000) {
            cleanup();
            return;
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
export { busy, keepSideScroll, };
