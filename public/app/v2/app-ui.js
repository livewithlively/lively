// web/v2/app-ui.ts — 설치된 앱의 UI 페이지를 **샌드박스 iframe** 으로 연다 (#1780 PR5, MCP Apps 문법).
//  전달: 인증 API(GET /api/ui/apps/:id/ui)로 entry HTML 을 받아 <iframe sandbox="allow-scripts" srcdoc>로 싣는다.
//   → 앱 UI 는 **오리진 격리(불투명)**: 부모(라이블리 셸)의 토큰·localStorage 에 못 닿는다. 주입한 CSP 로 네트워크도 막는다
//     (default-src 'none' … connect-src 'none') — 앱 UI 는 인라인 스크립트/스타일 + postMessage 만 쓸 수 있다.
//  부작용 있는 tools/call 은 postMessage 로 **호스트가 중개**한다 — 호스트가 /api/ui/apps/:id/tool-call 로 넘기면
//   서버가 앱 grant 로 제약해 실행한다(PR5b). 브리지 핸들러는 **프레임별**이라 여러 앱 UI 가 공존할 수 있다
//   (모달 openAppUi · panes 세션화면 탭 appPart 둘 다 mountAppUiFrame 을 쓴다 — #1719 원준 panes 재편에 정합).
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
/**
 * 앱 UI 를 샌드박스 iframe 으로 만들어 **프레임 + 정리 함수**를 돌려준다(호출부가 원하는 자리에 붙인다).
 *  브리지(postMessage)는 이 프레임에만 반응하는 핸들러로 걸리고 destroy() 가 떼어 낸다 — 여러 앱 UI 공존 안전.
 */
export async function mountAppUiFrame(appId, opts) {
    const q = opts?.page ? '/' + encodeURIComponent(opts.page) : '';
    const data = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/ui' + q);
    if (!data || typeof data.html !== 'string')
        throw new Error('UI 를 받지 못했습니다');
    const frame = el('iframe', {
        class: 'v2-appui-frame', title: opts?.title || data.title || appId,
        sandbox: 'allow-scripts', // ⚠ allow-same-origin 없음 = 불투명 오리진(부모 토큰·스토리지 격리). 폼·팝업·top 이동 불허.
        srcdoc: injectCsp(data.html),
    });
    // 브리지 — 이 프레임(불투명 오리진)에서 온 메시지만. 응답 target 은 '*'(불투명 오리진이라 특정 못 함 — 이 프레임만 받는다).
    const onMsg = (ev) => {
        if (ev.source !== frame.contentWindow)
            return;
        const msg = ev.data;
        if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string')
            return;
        const reply = (payload) => frame.contentWindow?.postMessage(payload, '*');
        if (msg.method === 'ui/initialize') {
            reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { host: 'lively', app: appId, page: data.page_key ?? null, capabilities: { tools: true } } });
        }
        else if (msg.method === 'tools/call') {
            const name = String(msg.params?.name ?? '');
            const args = (msg.params?.arguments ?? {});
            if (!name) {
                reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: 'params.name 이 필요합니다' } });
                return;
            }
            void api('/api/ui/apps/' + encodeURIComponent(appId) + '/tool-call', { method: 'POST', body: JSON.stringify({ name, arguments: args }) })
                .then((out) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: out?.result ?? out }))
                .catch((e) => reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: e?.status === 403 ? -32001 : -32000, message: (e && e.message ? e.message : String(e)) } }));
        }
        // 그 밖(ui/message 등)은 v1 에선 무시.
    };
    window.addEventListener('message', onMsg);
    return { root: frame, destroy: () => { window.removeEventListener('message', onMsg); frame.remove(); } };
}
// ── 모달로 열기(전역 런치패드용) — 세션 화면 밖에서 앱 UI 를 띄울 때. panes 탭은 mountAppUiFrame 을 직접 쓴다. ──
let uiEl = null;
let openFrame = null;
export async function openAppUi(appId, opts) {
    try {
        const f = await mountAppUiFrame(appId, opts);
        closeAppUi();
        openFrame = f;
        uiEl = el('div', { class: 'v2-appui-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': (opts?.title || appId) + ' 앱',
            onclick: (e) => { if (e.target === uiEl)
                closeAppUi(); } }, el('div', { class: 'v2-appui' }, el('div', { class: 'v2-appui-h' }, el('b', { class: 'v2-appui-t', text: opts?.title || appId }), el('span', { class: 'v2-appui-badge', text: '앱 UI' }), el('span', { class: 'v2-appui-spacer' }), el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기 (Esc)', onclick: () => closeAppUi() })), f.root));
        document.body.append(uiEl);
        document.addEventListener('keydown', uiKey);
        return true;
    }
    catch (e) {
        toast('앱 UI 를 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
        return false;
    }
}
function uiKey(e) { if (e.key === 'Escape')
    closeAppUi(); }
export function closeAppUi() {
    if (openFrame) {
        openFrame.destroy();
        openFrame = null;
    }
    if (uiEl) {
        uiEl.remove();
        uiEl = null;
    }
    document.removeEventListener('keydown', uiKey);
}
