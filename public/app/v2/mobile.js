// v2/mobile.ts — 새 셸의 **모바일 크롬**(#1777, 상민님 2026-08-19 "모바일 화면 대응 — 특히 세션뷰").
//
//  ≤900px 에선 세 칸 그리드(사이드바 | 가운데 | 우패널)를 그대로 둘 수 없다 — 390px 폰에서 사이드바 220px 를 빼면
//  대화창이 164px 로 남는다(실측). 그래서 폭이 좁으면:
//   · 가운데가 화면 전부를 쓴다(1열).
//   · 사이드바 = 왼쪽 **서랍**(오프캔버스). ☰ 로 열고, 배경 탭·Esc·**어디로든 이동**(hashchange)하면 닫힌다.
//   · 우패널(타임라인) = 오른쪽 서랍. 상단 바 오른쪽 [타임라인] 으로 연다. no-aside 화면(앱 프레임)에선 버튼이 없다.
//   · 상단 바 하나(.v2-mbar): [☰] [셸 탭 줄] [타임라인]. 탭 줄(web/v2/tabs.ts)은 데스크톱에선 가운데 열 맨 위에 살고,
//     모바일에선 **이 바 가운데로 옮겨 온다**(같은 DOM — 상태 그대로). 제목을 따로 두지 않는다 — 활성 탭이 곧 제목이고,
//     한 줄을 아낀다(폰에서 크롬 한 줄은 대화 세 줄이다).
//  데스크톱(>900px)에선 바·배경막이 display:none 이고 서랍 클래스도 무시된다(40-v2.css) — 데스크톱 그림은 그대로다.
//  판정은 CSS 미디어쿼리 하나(MQ)와 같은 문턱을 JS 도 본다(matchMedia) — 두 곳이 어긋나면 서랍이 열렸는데 안 보인다.
import { el, sv } from '../core.js';
export const MOBILE_MQ = '(max-width: 900px)'; // = 40-v2.css 모바일 블록의 문턱(종전 우패널 숨김 문턱과 같다 — 태블릿 세로 포함)
/** #v2-root 에 모바일 크롬을 단다. bar 는 root 맨 앞, scrim 은 맨 뒤에 호출자가 끼운다(그리드 열 순서를 안 건드리게). */
export function mountMobileChrome(root, side, aside) {
    const mq = window.matchMedia(MOBILE_MQ);
    const isMobile = () => mq.matches;
    // 아이콘 — 라인, 채움 없음(DS 규약). 24 뷰박스, 사이드바·탭과 같은 붓.
    const icon = (paths) => sv('svg', { viewBox: '0 0 24 24', class: 'v2-mbar-ic', 'aria-hidden': 'true' }, ...paths.map((d) => sv('path', { d })));
    const menuBtn = el('button', { class: 'v2-mbar-btn v2-mbar-menu', type: 'button', 'aria-label': '탐색 열기', 'aria-expanded': 'false', 'aria-controls': 'v2-side' }, icon(['M4 7h16M4 12h16M4 17h16']));
    const slot = el('div', { class: 'v2-mbar-slot' });
    const asideBtn = el('button', { class: 'v2-mbar-btn v2-mbar-aside', type: 'button', 'aria-label': '타임라인 열기', 'aria-expanded': 'false', 'aria-controls': 'v2-aside', title: '이 화면의 타임라인' }, icon(['M12 4v16', 'M12 8h6', 'M12 14h6', 'M6 6h2', 'M6 12h2', 'M6 18h2']));
    const bar = el('div', { class: 'v2-mbar' }, menuBtn, slot, asideBtn);
    const scrim = el('div', { class: 'v2-scrim', hidden: true, 'aria-hidden': 'true' });
    side.id = side.id || 'v2-side';
    aside.id = aside.id || 'v2-aside';
    // 서랍 자체가 포커스를 받을 수 있어야 열었을 때 초점이 안으로 들어간다(검색칸에 바로 주면 iOS 키보드가 튀어 오른다).
    side.tabIndex = -1;
    aside.tabIndex = -1;
    let open = null;
    const paint = () => {
        root.classList.toggle('m-side', open === 'side');
        root.classList.toggle('m-aside', open === 'aside');
        scrim.hidden = !open;
        menuBtn.setAttribute('aria-expanded', String(open === 'side'));
        asideBtn.setAttribute('aria-expanded', String(open === 'aside'));
    };
    // returnFocus — 키보드(Esc)로 닫았을 때만 연 버튼으로 초점을 돌려준다(서랍이 닫혔는데 초점이 보이지 않는 곳에 남으면 키보드·
    //  스크린리더 사용자가 길을 잃는다). 손가락으로 닫았을 땐 초점을 흘려보낸다 — 버튼에 초점을 주면 브라우저가 포커스 링을 그린다.
    const closeAll = (returnFocus = false) => {
        if (!open)
            return;
        const was = open;
        open = null;
        paint();
        const panel = was === 'side' ? side : aside;
        if (returnFocus) {
            (was === 'side' ? menuBtn : asideBtn).focus({ preventScroll: true });
        }
        else if (panel.contains(document.activeElement))
            document.activeElement.blur();
    };
    const openOne = (w) => {
        if (!isMobile())
            return;
        open = w;
        paint();
        const panel = w === 'side' ? side : aside;
        panel.focus({ preventScroll: true });
        // 사이드바 트리는 수백 행 — 지금 보는 행이 보이게 살짝 굴린다(열린 뒤라야 굴릴 스크롤 상자가 화면 안에 있다).
        if (w === 'side') {
            const on = side.querySelector('.v2-tree .on');
            if (on)
                on.scrollIntoView({ block: 'center' });
        }
    };
    menuBtn.addEventListener('click', () => (open === 'side' ? closeAll() : openOne('side')));
    asideBtn.addEventListener('click', () => (open === 'aside' ? closeAll() : openOne('aside')));
    scrim.addEventListener('click', () => closeAll());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) {
        e.stopPropagation();
        closeAll(true);
    } }, true);
    // 서랍 안에서 어디로든 가면 닫는다 — 링크(프로젝트·세션·리브·앱)와 런치패드 버튼. 펼침 화살표·필터·돋보기는 stopPropagation 이라 안 닫힌다.
    //  같은 곳을 다시 누르면 hashchange 가 없으므로 클릭에서도 닫아야 한다.
    side.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('a[href], .v2-apps-btn, .v2-ws-item, .v2-ws-team-open'))
            closeAll();
    });
    aside.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('a[href]'))
            closeAll();
    });
    window.addEventListener('hashchange', () => closeAll());
    // 탭 줄 입양 — 모바일이면 바 가운데, 아니면 제자리. 회전·리사이즈로 문턱을 넘나들 때마다 옮긴다(DOM 이동이라 탭 상태는 그대로).
    let strip = null;
    const placeStrip = () => {
        if (!strip)
            return;
        if (isMobile()) {
            if (strip.el.parentElement !== slot)
                slot.replaceChildren(strip.el);
        }
        else if (strip.el.parentElement === slot)
            strip.restore();
    };
    // 창이 넓어지면(회전·리사이즈) 서랍 상태를 버린다 — 데스크톱 그리드에 m-side 가 남아 있으면 안 된다.
    const onMq = () => { if (!mq.matches)
        closeAll(); placeStrip(); };
    if (typeof mq.addEventListener === 'function')
        mq.addEventListener('change', onMq);
    else
        mq.addListener(onMq);
    return {
        bar, scrim, isMobile, closeAll: () => closeAll(),
        adoptStrip(el0, restore) { strip = { el: el0, restore }; placeStrip(); },
        setAside(on) {
            asideBtn.hidden = !on;
            if (!on && open === 'aside')
                closeAll();
        },
        openAside() { if (isMobile() && !asideBtn.hidden && open !== 'aside')
            openOne('aside'); },
    };
}
