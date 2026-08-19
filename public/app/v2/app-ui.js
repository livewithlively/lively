// web/v2/app-ui.ts — 설치된 앱의 UI 페이지를 **샌드박스 iframe** 으로 연다 (#1780 PR5, MCP Apps 문법).
//  전달: 인증 API(GET /api/ui/apps/:id/ui)로 entry HTML 을 받아 <iframe sandbox="allow-scripts" srcdoc>로 싣는다.
//   → 앱 UI 는 **오리진 격리(불투명)**: 부모(라이블리 셸)의 토큰·localStorage 에 못 닿는다. 주입한 CSP 로 네트워크도 막는다
//     (default-src 'none' … connect-src 'none') — 앱 UI 는 인라인 스크립트/스타일 + postMessage 만 쓸 수 있다.
//  부작용 있는 tools/call 은 postMessage 로 **호스트가 중개**한다. v1(PR5a)은 ui/initialize 핸드셰이크만 응답하고
//   tools/call 은 "아직 미지원"으로 답한다 — 앱 grant 로 제약하는 브리지는 principal 결정 후 PR5b.
import { api, el, toast } from '../core.js';
// 앱 UI iframe 이 쓸 수 있는 것: 인라인 스크립트·스타일, data: 이미지/폰트, postMessage. **네트워크 없음**(connect/img/media/frame 차단).
const SANDBOX_CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'\">";
/** CSP meta 를 문서 head 최상단에 주입(doctype 뒤 · 없으면 맨 앞). srcdoc 은 HTTP 헤더가 없어 CSP 는 meta 로만 건다. */
function injectCsp(html) {
    const m = /<!doctype[^>]*>/i.exec(html);
    if (m) {
        const i = m.index + m[0].length;
        return html.slice(0, i) + SANDBOX_CSP + html.slice(i);
    }
    return SANDBOX_CSP + html;
}
let uiEl = null;
let msgHandler = null;
/** 앱 UI 페이지를 연다. page 미지정이면 첫 페이지. 실패하면 toast + false. */
export async function openAppUi(appId, opts) {
    try {
        const q = opts?.page ? '/' + encodeURIComponent(opts.page) : '';
        const out = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/ui' + q);
        if (!out || typeof out.html !== 'string')
            throw new Error('UI 를 받지 못했습니다');
        mount(appId, { ...out, title: out.title || opts?.title });
        return true;
    }
    catch (e) {
        toast('앱 UI 를 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
        return false;
    }
}
function mount(appId, data) {
    closeAppUi();
    const frame = el('iframe', {
        class: 'v2-appui-frame', title: data.title || appId,
        sandbox: 'allow-scripts', // ⚠ allow-same-origin 없음 = 불투명 오리진(부모 토큰·스토리지 격리). 폼·팝업·top 이동도 불허.
        srcdoc: injectCsp(data.html),
    });
    // 브리지 — 이 iframe(불투명 오리진)에서 온 메시지만 처리. 불투명 오리진이라 응답 target 은 '*'(이 iframe 만 받는다).
    msgHandler = (ev) => {
        if (ev.source !== frame.contentWindow)
            return;
        const msg = ev.data;
        if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string')
            return;
        const reply = (payload) => frame.contentWindow?.postMessage(payload, '*');
        if (msg.method === 'ui/initialize') {
            // 앱 UI 에게 호스트 컨텍스트를 알린다. v1: tools 미지원(핸드셰이크만).
            reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { host: 'lively', app: appId, page: data.page_key ?? null, capabilities: { tools: false } } });
        }
        else if (msg.method === 'tools/call') {
            reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'tools/call 은 아직 지원되지 않습니다(PR5b 브리지 예정)' } });
        }
        // 그 밖(ui/message 등)은 v1 에선 무시.
    };
    window.addEventListener('message', msgHandler);
    uiEl = el('div', { class: 'v2-appui-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': (data.title || appId) + ' 앱',
        onclick: (e) => { if (e.target === uiEl)
            closeAppUi(); } }, el('div', { class: 'v2-appui' }, el('div', { class: 'v2-appui-h' }, el('b', { class: 'v2-appui-t', text: data.title || appId }), el('span', { class: 'v2-appui-badge', text: '앱 UI' }), el('span', { class: 'v2-appui-spacer' }), el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기 (Esc)', onclick: () => closeAppUi() })), frame));
    document.body.append(uiEl);
    document.addEventListener('keydown', uiKey);
}
function uiKey(e) { if (e.key === 'Escape')
    closeAppUi(); }
export function closeAppUi() {
    if (msgHandler) {
        window.removeEventListener('message', msgHandler);
        msgHandler = null;
    }
    if (uiEl) {
        uiEl.remove();
        uiEl = null;
    }
    document.removeEventListener('keydown', uiKey);
}
