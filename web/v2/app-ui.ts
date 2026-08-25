// web/v2/app-ui.ts — 설치된 앱의 UI 페이지를 **샌드박스 iframe** 으로 연다 (#1780 PR5, MCP Apps 문법).
//  전달: 인증 API(GET /api/ui/apps/:id/ui)로 entry HTML 을 받아 <iframe sandbox="allow-scripts" srcdoc>로 싣는다.
//   → 앱 UI 는 **오리진 격리(불투명)**: 부모(라이블리 셸)의 토큰·localStorage 에 못 닿는다. 주입한 CSP 로 네트워크도 막는다
//     (default-src 'none' … connect-src 'none') — 앱 UI 는 인라인 스크립트/스타일 + postMessage 만 쓸 수 있다.
//  부작용 있는 tools/call 은 postMessage 로 **호스트가 중개**한다 — 호스트가 /api/ui/apps/:id/tool-call 로 넘기면
//   서버가 앱 grant 로 제약해 실행한다(PR5b). 브리지 핸들러는 **프레임별**이라 여러 앱 UI 가 공존할 수 있다
//   (모달 openAppUi · panes 세션화면 탭 appPart 둘 다 mountAppUiFrame 을 쓴다 — #1719 원준 panes 재편에 정합).
//  ★ SDK 주입(#1780 SDK): srcdoc 머리에 app-ui-runtime 을 끼워 넣어 앱이 `window.lively` 를 **설치·번들 없이** 쓴다.
//   (외부 스크립트가 CSP 로 막혀 있어 npm 배포가 성립하지 않는다 — 그래서 호스트 주입이 이 플랫폼의 SDK 전달 방식이다.)
//  ★ CSP 는 **앱이 선언한 만큼만**(manifest.csp — MCP Apps 채택): 기본은 네트워크·프레임 0, 선언하면 그만큼 열린다.
import { api, el, toast } from '../core.js';
import { APP_RUNTIME_JS } from './app-ui-runtime.js';
import { ensureAppGrant } from './app-session.js';

export interface AppCsp { connect_domains?: string[]; resource_domains?: string[]; frame_domains?: string[] }

/** 선언 도메인 목록 → CSP 소스 표현. 빈 목록이면 'none', `*` 이 있으면 https: (스킴 전체 — http 는 안 준다). */
function srcList(domains: string[] | undefined, extra?: string): string {
  const list = (domains ?? []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  const base = extra ? [extra] : [];
  if (!list.length) return base.length ? base.join(' ') : "'none'";
  if (list.includes('*')) return [...base, 'https:'].join(' ');
  return [...base, ...list.map((d) => 'https://' + d)].join(' ');
}

/**
 * 이 앱에 허용할 CSP — **기본은 아무것도 없음**(default-src 'none'), 앱이 매니페스트에 적은 만큼만 열린다.
 *  script-src 는 어떤 선언으로도 넓어지지 않는다(외부 스크립트 금지 = 앱 UI 안에서 도는 코드는 그 앱의 것뿐).
 */
function buildCsp(csp?: AppCsp): string {
  const parts = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",         // ⚠ 외부 스크립트는 어떤 선언으로도 열지 않는다
    "style-src 'unsafe-inline'",
    'img-src ' + srcList(csp?.resource_domains, 'data:'),
    'font-src ' + srcList(csp?.resource_domains, 'data:'),
    'media-src ' + srcList(csp?.resource_domains),
    'connect-src ' + srcList(csp?.connect_domains),
    'frame-src ' + srcList(csp?.frame_domains),
    "form-action 'none'",
    "base-uri 'none'",
  ];
  return '<meta http-equiv="Content-Security-Policy" content="' + parts.join('; ') + '">';
}

/** CSP meta + SDK 런타임을 문서 머리에 끼운다(doctype 뒤 · 없으면 맨 앞). srcdoc 은 HTTP 헤더가 없어 CSP 는 meta 로만. */
function wrapAppHtml(html: string, csp?: AppCsp): string {
  const head = buildCsp(csp) + '<script>' + APP_RUNTIME_JS + '</script>';
  const m = /<!doctype[^>]*>/i.exec(html);
  if (m) { const i = m.index + m[0].length; return html.slice(0, i) + head + html.slice(i); }
  return head + html;
}

interface AppUiData { html: string; title?: string; page_key?: string; app_id?: string; pages?: Array<{ key: string; title: string }>; csp?: AppCsp }
export interface AppUiFrame { root: HTMLElement; destroy(): void }

/**
 * 앱 UI 를 샌드박스 iframe 으로 만들어 **프레임 + 정리 함수**를 돌려준다(호출부가 원하는 자리에 붙인다).
 *  브리지(postMessage)는 이 프레임에만 반응하는 핸들러로 걸리고 destroy() 가 떼어 낸다 — 여러 앱 UI 공존 안전.
 */
export async function mountAppUiFrame(appId: string, opts?: { page?: string; title?: string; instanceId?: string }): Promise<AppUiFrame> {
  const q = opts?.page ? '/' + encodeURIComponent(opts.page) : '';
  const data = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/ui' + q) as AppUiData;
  if (!data || typeof data.html !== 'string') throw new Error('UI 를 받지 못했습니다');
  const frame = el('iframe', {
    class: 'v2-appui-frame', title: opts?.title || data.title || appId,
    sandbox: 'allow-scripts',        // ⚠ allow-same-origin 없음 = 불투명 오리진(부모 토큰·스토리지 격리). 폼·팝업·top 이동 불허.
    srcdoc: wrapAppHtml(data.html, data.csp),
  }) as HTMLIFrameElement;

  // 브리지 — 이 프레임(불투명 오리진)에서 온 메시지만. 응답 target 은 '*'(불투명 오리진이라 특정 못 함 — 이 프레임만 받는다).
  const onMsg = (ev: MessageEvent): void => {
    if (ev.source !== frame.contentWindow) return;
    const msg = ev.data as { method?: string; id?: unknown; params?: { name?: string; arguments?: unknown } } | null;
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return;
    const reply = (payload: unknown): void => frame.contentWindow?.postMessage(payload, '*');
    if (msg.method === 'ui/initialize') {
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { host: 'lively', app: appId, instance: opts?.instanceId ?? null, page: data.page_key ?? null, capabilities: { tools: true } } });
    } else if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (!name) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: 'params.name 이 필요합니다' } }); return; }
      const send = (): Promise<any> => api('/api/ui/apps/' + encodeURIComponent(appId) + '/tool-call', { method: 'POST', body: JSON.stringify({ name, arguments: args }) });
      // 첫 호출이 '동의 없음'(403)이면 **그 자리에서 동의 창**을 띄우고 한 번 재시도한다 —
      //  UI 앱은 열 때 동의를 묻지 않으므로(그냥 화면만 보는 앱도 있다), 능력이 실제로 필요해진 순간이 물어볼 자리다.
      void send()
        .catch(async (e: any) => {
          if (e?.status !== 403 || !/동의|grant/i.test(String(e?.message || ''))) throw e;
          if (!(await ensureAppGrant(appId, opts?.title || data.title))) throw e;
          return send();
        })
        .then((out: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: out?.result ?? out }))
        .catch((e: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: e?.status === 403 ? -32001 : -32000, message: (e && e.message ? e.message : String(e)) } }));
    } else if (msg.method === 'ui/openExternal') {
      // 샌드박스(allow-popups 없음)에선 앱이 새 탭을 못 연다 — 호스트가 대신 연다. http(s)만, noopener.
      const raw = String((msg.params as { url?: unknown } | undefined)?.url ?? '');
      let ok = false;
      try { const u = new URL(raw); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { ok = false; }
      if (!ok) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: 'http(s) 주소가 아닙니다' } }); return; }
      const w = window.open(raw, '_blank', 'noopener');
      if (!w) toast('새 탭이 팝업 차단으로 막혔어요 — 주소창 옆의 차단 아이콘에서 허용해 주세요.', true);
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { opened: !!w } });
    }
    // 그 밖(ui/message 등)은 v1 에선 무시.
  };
  window.addEventListener('message', onMsg);
  return { root: frame, destroy: () => { window.removeEventListener('message', onMsg); frame.remove(); } };
}

// ── 모달로 열기(전역 런치패드용) — 세션 화면 밖에서 앱 UI 를 띄울 때. panes 탭은 mountAppUiFrame 을 직접 쓴다. ──
let uiEl: HTMLElement | null = null;
let openFrame: AppUiFrame | null = null;

export async function openAppUi(appId: string, opts?: { page?: string; title?: string }): Promise<boolean> {
  try {
    const f = await mountAppUiFrame(appId, opts);
    closeAppUi();
    openFrame = f;
    uiEl = el('div', { class: 'v2-appui-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': (opts?.title || appId) + ' 앱',
        onclick: (e: Event) => { if (e.target === uiEl) closeAppUi(); } },
      el('div', { class: 'v2-appui' },
        el('div', { class: 'v2-appui-h' },
          el('b', { class: 'v2-appui-t', text: opts?.title || appId }),
          el('span', { class: 'v2-appui-badge', text: '앱 UI' }),
          el('span', { class: 'v2-appui-spacer' }),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기 (Esc)', onclick: () => closeAppUi() })),
        f.root));
    document.body.append(uiEl as HTMLElement);
    document.addEventListener('keydown', uiKey);
    return true;
  } catch (e: any) {
    toast('앱 UI 를 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
    return false;
  }
}

function uiKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeAppUi(); }
export function closeAppUi(): void {
  if (openFrame) { openFrame.destroy(); openFrame = null; }
  if (uiEl) { uiEl.remove(); uiEl = null; }
  document.removeEventListener('keydown', uiKey);
}
