// page-decor.ts — #657 페이지 꾸미기 공용(노션형): 이모지 아이콘 피커 + 커버 피커/렌더.
//  지식 문서(knowledge-doc)·카테고리 대문(category-home)·작성 페이지(knowledge-edit)가 공유한다.
//  순환 import 금지: core 만 import(이 모듈은 최하층 위젯).
//  커버 값 포맷: 'grad:1'~'grad:8'(프리셋 그라디언트) | '#RRGGBB'(단색) | 'url:https://…'(이미지).
import { el, toast } from './core.js';
// ── 프리셋 커버(#657r) — 파스텔 무지개 대신 '아카이브 톤': 단색-계열 깊이 + 소수의 딥 톤. ──
//  리빙그린·잉크네이비·따뜻한 종이·차분한 슬레이트 — 지식 카탈로그의 절제된 표지. 각 그라디언트는
//  단일 색상 안에서 명도만 움직여(무지개 아님) 의도적으로 보이게 한다.
const COVER_GRADS = {
    '1': 'linear-gradient(135deg, #F0ECE2 0%, #E3DACB 100%)', // 샌드(따뜻한 종이)
    '2': 'linear-gradient(135deg, #E4E9F0 0%, #C8D2E1 100%)', // 슬레이트
    '3': 'linear-gradient(135deg, #DCF0E7 0%, #ADDBC6 100%)', // 리빙(그린 톤)
    '4': 'linear-gradient(135deg, #ECEBE4 0%, #D3D8C6 100%)', // 모스(세이지)
    '5': 'linear-gradient(135deg, #F1E7DF 0%, #E0C9B9 100%)', // 클레이(웜)
    '6': 'linear-gradient(135deg, #E8E7EA 0%, #CFCDD6 100%)', // 애쉬
    '7': 'linear-gradient(150deg, #244A3A 0%, #0FB07E 120%)', // 딥 리빙(다크 그린)
    '8': 'linear-gradient(150deg, #1B1E27 0%, #2B4B7E 120%)', // 딥 잉크(네이비)
};
const COVER_SOLIDS = ['#F0ECE2', '#E4E9F0', '#DCF0E7', '#ECEBE4', '#F1E7DF', '#E8E7EA', '#2B4B7E', '#1B1E27'];
// 커버 값 → element 배경 적용. url 커버는 https/http 만(그 외 무시 — CSS url 은 JS 실행이 없지만 형식은 강제).
//  적용 실패(미지 포맷)면 false — 호출부가 기본 그라디언트 폴백.
function applyCoverBg(node, cover) {
    const v = String(cover || '').trim();
    if (!v)
        return false;
    node.style.background = '';
    node.style.backgroundImage = '';
    if (v.startsWith('grad:') && COVER_GRADS[v.slice(5)]) {
        node.style.background = COVER_GRADS[v.slice(5)];
        return true;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        node.style.background = v;
        return true;
    }
    if (v.startsWith('url:')) {
        const u = v.slice(4).trim();
        if (!/^https?:\/\//i.test(u))
            return false;
        // 따옴표·역슬래시·괄호 제거 — url("…") 문맥 탈출 방지(스타일 프로퍼티 대입이라 HTML 주입은 원천 불가).
        const safe = u.replace(/["'\\()]/g, '');
        node.style.backgroundImage = 'url("' + safe + '")';
        node.style.backgroundSize = 'cover';
        node.style.backgroundPosition = 'center';
        return true;
    }
    return false;
}
// 결정적 기본 커버 — 키 해시로 톤 프리셋 중 하나(설정 0으로도 품위 있게). 딥 톤(7·8)은 기본에서 제외 —
//  아이콘/제목이 얹히는 대문은 밝은 톤 6종(1~6)이 안전(대비·가독).
function defaultCoverFor(seed) {
    let h = 0;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) % 6;
    return 'grad:' + (h + 1); // 1~6(딥 7·8 제외)
}
// ── 이모지 피커 — 앵커 근처 팝오버. onPick(emoji) / onClear(있으면 '제거' 노출). ──
const EMOJI_SET = [
    '📄', '📝', '📚', '📖', '📌', '📋', '🗂', '📁', '🗃', '🧭', '🗺', '🧠', '💡', '⚡', '🔥', '✨',
    '🎯', '🏁', '🚀', '🛠', '🔧', '⚙️', '🧩', '🔬', '🔭', '🧪', '📐', '📊', '📈', '📉', '💰', '💳',
    '🏦', '🤝', '🗣', '💬', '📣', '📢', '🔔', '🗓', '⏰', '⏳', '🕐', '📅', '✅', '☑️', '✍️', '🖊',
    '🎨', '🖼', '🌈', '🌟', '⭐', '🌙', '☀️', '🌊', '🌱', '🌿', '🍀', '🌳', '🏔', '🏗', '🏢', '🏠',
    '🚧', '🚦', '🧱', '🪜', '🔑', '🔒', '🔓', '🛡', '⚖️', '📎', '🔗', '🧲', '🧵', '🪄', '🎁', '🎉',
    '🥇', '🏆', '🎖', '🧿', '👀', '👋', '💪', '🙌', '❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '🖤',
];
function openEmojiPicker(anchor, opts) {
    const old = document.querySelector('.pd-emoji-pop');
    if (old)
        old.remove();
    const grid = el('div', { class: 'pd-emoji-grid' });
    for (const em of EMOJI_SET) {
        if (em.length > 4)
            continue; // 잘못 섞인 항목 방어
        const b = el('button', { class: 'pd-emoji-btn', type: 'button', text: em });
        b.onclick = () => { close(); opts.onPick(em); };
        grid.append(b);
    }
    // 자유 입력 — 목록에 없는 이모지/글자도 아이콘으로(최대 2자 표시).
    const freeIn = el('input', { type: 'text', class: 'pd-emoji-free', placeholder: '직접 입력(이모지·글자)', maxlength: '4' });
    const freeGo = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '적용' });
    freeGo.onclick = () => { const v = freeIn.value.trim(); if (!v) {
        freeIn.focus();
        return;
    } close(); opts.onPick(v); };
    freeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
        freeGo.click(); });
    const head = el('div', { class: 'pd-pop-head' }, el('span', { text: opts.title || '아이콘' }), opts.onClear ? el('button', { class: 'pd-pop-clear', type: 'button', text: '제거', onclick: () => { close(); opts.onClear(); } }) : null);
    const pop = el('div', { class: 'pd-emoji-pop' }, head, grid, el('div', { class: 'pd-emoji-freerow' }, freeIn, freeGo));
    positionPop(pop, anchor);
    const close = attachPopClose(pop, anchor);
    setTimeout(() => freeIn.focus(), 0);
}
// ── 커버 피커 — 그라디언트/단색 스와치 + 이미지 URL + 제거. onPick(value|null). ──
function openCoverPicker(anchor, opts) {
    const old = document.querySelector('.pd-cover-pop');
    if (old)
        old.remove();
    const sw = (value, styleNode, label) => {
        const b = el('button', { class: 'pd-cover-sw' + (opts.current === value ? ' on' : ''), type: 'button', title: label });
        styleNode(b);
        b.onclick = () => { close(); opts.onPick(value); };
        return b;
    };
    const grads = el('div', { class: 'pd-cover-row' }, ...Object.keys(COVER_GRADS).map((k) => sw('grad:' + k, (n) => { n.style.background = COVER_GRADS[k]; }, '그라디언트 ' + k)));
    const solids = el('div', { class: 'pd-cover-row' }, ...COVER_SOLIDS.map((c) => sw(c, (n) => { n.style.background = c; }, c)));
    const urlIn = el('input', { type: 'text', class: 'pd-cover-url', placeholder: '이미지 URL (https://…)' });
    if (opts.current && opts.current.startsWith('url:'))
        urlIn.value = opts.current.slice(4);
    const urlGo = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '적용' });
    urlGo.onclick = () => {
        const u = urlIn.value.trim();
        if (!/^https?:\/\//i.test(u)) {
            toast('https:// 로 시작하는 이미지 URL 을 입력하세요', true);
            urlIn.focus();
            return;
        }
        close();
        opts.onPick('url:' + u);
    };
    urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
        urlGo.click(); });
    const pop = el('div', { class: 'pd-cover-pop' }, el('div', { class: 'pd-pop-head' }, el('span', { text: '커버' }), el('button', { class: 'pd-pop-clear', type: 'button', text: '제거', onclick: () => { close(); opts.onPick(null); } })), el('div', { class: 'pd-pop-sec', text: '그라디언트' }), grads, el('div', { class: 'pd-pop-sec', text: '단색' }), solids, el('div', { class: 'pd-pop-sec', text: '이미지' }), el('div', { class: 'pd-cover-urlrow' }, urlIn, urlGo));
    positionPop(pop, anchor);
    const close = attachPopClose(pop, anchor);
}
// 팝오버 위치 — 앵커 아래 fixed(뷰포트 클램프). body 에 부착해 overflow 클립 회피.
function positionPop(pop, anchor) {
    pop.style.position = 'fixed';
    pop.style.visibility = 'hidden';
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth || 320, h = pop.offsetHeight || 200;
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    pop.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
    pop.style.visibility = '';
}
// 바깥 클릭/ESC 닫기 — close() 반환(선택 시 수동 닫기용).
function attachPopClose(pop, anchor) {
    const close = () => {
        pop.remove();
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
    };
    const onDoc = (ev) => { if (pop.contains(ev.target) || anchor.contains(ev.target))
        return; close(); };
    const onKey = (ev) => { if (ev.key === 'Escape') {
        ev.stopPropagation();
        close();
    } };
    setTimeout(() => {
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
    return close;
}
export { applyCoverBg, defaultCoverFor, openEmojiPicker, openCoverPicker, COVER_GRADS };
