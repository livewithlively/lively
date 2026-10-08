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
import { putIntoSession } from './sess-input.js';   // #4594 멈춘 세션에 보내려던 글을 그 세션 화면의 입력칸에 넣어 둔다(잎 모듈)
//  #4530 앱 화면 안의 ⌘K → 셸 통합검색. omni.ts 를 직접 들이지 않는다 — 셸 화면 모듈 묶음(사이드바·자료 …)이 통째로 딸려 와
//   앱 화면 묶음이 커지고, 창이 없는 곳에서 이 모듈을 실으면 그 묶음이 터진다(scripts/session-app-pane.test.mjs 가 잡았다).
//   대신 셸이 듣는 같은 오리진 신호(OMNI_MSG, 가벼운 lib/omni-chord.ts 에 한 벌)를 이 창에 보낸다 — 셸의 bindOmniKey 가 받아 연다.
import { OMNI_MSG } from '../lib/omni-chord.js';
let lastOmniAsk = 0;   // 앱이 보낸 «통합검색 열기» 의 마지막 때(1초에 한 번)

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
export interface AppUiFrame {
  root: HTMLElement;
  destroy(): void;
  /** 호스트 → 앱 알림(JSON-RPC notification, id 없음). 앱 SDK 가 method 로 가른다(#4225 ui/notifications/data-changed). */
  notify(method: string, params?: Record<string, unknown>): void;
  /** 앱이 그 주제를 구독했나(SDK lively.store.onChange → ui/subscribe {topic:'data'}). 다시 불러오면 새 문서가 다시 구독한다. */
  subscribed(topic: string): boolean;
  /** 같은 HTML 로 앱 화면을 처음부터 다시 띄운다 — 구독하지 않은 앱에 «최신을 보여 주는» 가장 단순한 길. */
  reload(): void;
  /** 이 프레임의 가장자리를 호스트가 가리는 폭(px)을 앱에 알린다(#4592 — 곁칸의 독). 다시 불러온 새 문서에도 처음에 한 번 다시 알린다. */
  setInsets(i: AppInsets): void;
}
export interface AppInsets { top: number; right: number; bottom: number; left: number }

/**
 * 앱 UI 를 샌드박스 iframe 으로 만들어 **프레임 + 정리 함수**를 돌려준다(호출부가 원하는 자리에 붙인다).
 *  브리지(postMessage)는 이 프레임에만 반응하는 핸들러로 걸리고 destroy() 가 떼어 낸다 — 여러 앱 UI 공존 안전.
 */
/** 앱이 호스트에 메뉴를 열어 달라고 했다 — items 는 앱의 항목(맨 위에 선다), x · y 는 **이 창** 기준 자리. 고른 앱 항목의 id 또는 null. */
export interface AppMenuRequest { items: Array<{ id: string; label: string }>; x: number; y: number }
export interface AppUiMountOpts {
  page?: string; title?: string; instanceId?: string; sessionId?: string;
  /** 앱이 호스트의 머리줄을 접거나 펴 달라고 했다(lively.ui.chrome). init = 새 문서가 막 인사했다(아직 아무것도 청하지 않았다). 없으면 그 능력이 없는 자리다. */
  onChrome?: (c: { head: boolean; init?: boolean }) => void;
  /** 앱이 호스트 메뉴를 열어 달라고 했다(lively.ui.openMenu). 없으면 못 여는 자리(인사의 capabilities.menu = false · 부르면 -32601). */
  onMenu?: (req: AppMenuRequest) => Promise<string | null>;
  /** #4443 앱 화면 안 글 상자에 초점이 들었다(true) · 났다(false). SDK 런타임이 바뀔 때만 알린다(ui/typing). 새 문서 · 다시 불러오기 ·
   *  내려가기에선 호스트가 false 를 한 번 부른다(옛 문서는 «났다» 를 못 보낸다). 없으면 버린다. */
  onTyping?: (on: boolean) => void;
}
export async function mountAppUiFrame(appId: string, opts?: AppUiMountOpts): Promise<AppUiFrame> {
  const q = opts?.page ? '/' + encodeURIComponent(opts.page) : '';
  const data = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/ui' + q) as AppUiData;
  if (!data || typeof data.html !== 'string') throw new Error('UI 를 받지 못했습니다');
  const doc = wrapAppHtml(data.html, data.csp);
  const frame = el('iframe', {
    class: 'v2-appui-frame', title: opts?.title || data.title || appId,
    sandbox: 'allow-scripts',        // ⚠ allow-same-origin 없음 = 불투명 오리진(부모 토큰·스토리지 격리). 폼·팝업·top 이동 불허.
    srcdoc: doc,
  }) as HTMLIFrameElement;
  const topics = new Set<string>();   // 앱이 구독한 주제(ui/subscribe) — 다시 불러오면 비운다(새 문서가 다시 구독한다)
  let insets: AppInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  const sendInsets = (): void => { frame.contentWindow?.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/insets', params: insets }, '*'); };
  let loads = 0;

  // 브리지 — 이 프레임(불투명 오리진)에서 온 메시지만. 응답 target 은 '*'(불투명 오리진이라 특정 못 함 — 이 프레임만 받는다).
  const onMsg = (ev: MessageEvent): void => {
    if (ev.source !== frame.contentWindow) return;
    const msg = ev.data as { method?: string; id?: unknown; params?: { name?: string; arguments?: unknown } } | null;
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return;
    const reply = (payload: unknown): void => frame.contentWindow?.postMessage(payload, '*');
    if (msg.method === 'ui/subscribe') {
      // 알림(id 없음) — 답하지 않는다. 앱이 «바깥에서 바뀐 것을 스스로 다시 읽겠다»고 알린 것(#4225).
      const topic = String((msg.params as { topic?: unknown } | undefined)?.topic ?? '');
      if (topic) topics.add(topic);
      return;
    }
    if (msg.method === 'ui/typing') {
      // 알림(id 없음)이라 답하지 않는다. 앱 화면 안 글 상자에 초점이 들고 났다(#4443 폰: 쓰는 동안 셸이 아래 탭 바를 걷는다).
      opts?.onTyping?.((msg.params as { on?: unknown } | undefined)?.on === true);
      return;
    }
    if (msg.method === 'ui/omniOpen') {
      // 알림(id 없음) — 앱 화면 안에서 통합검색 키를 눌렀다(#4530). 셸이 연다. 답하지 않는다.
      //  사람의 키가 보내는 신호라 1초에 한 번이면 충분하다 — 앱이 연달아 보내 입력칸 초점을 빼앗지 못하게(격리 리뷰).
      const now = Date.now();
      if (now - lastOmniAsk > 1000) { lastOmniAsk = now; window.postMessage({ type: OMNI_MSG, open: true }, location.origin); }
      return;
    }
    if (msg.method === 'ui/initialize') {
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { host: 'lively', app: appId, instance: opts?.instanceId ?? null, page: data.page_key ?? null, session: opts?.sessionId ?? null, capabilities: { tools: true, menu: !!opts?.onMenu, chrome: !!opts?.onChrome } } });
      opts?.onChrome?.({ head: true, init: true });   // 새 문서 — 머리줄을 접어 달라는 말은 이 문서가 다시 해야 한다
      opts?.onTyping?.(false);                        // 새 문서엔 초점 든 글 상자가 없다(옛 문서가 쓰던 중이었어도)
      //  새 문서(처음 · 다시 불러옴)는 가려진 폭을 모른다 — 인사 뒤에 한 번 알린다(가리는 것이 없으면 보내지 않는다).
      if (insets.top || insets.right || insets.bottom || insets.left) sendInsets();
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
    } else if (msg.method === 'chat/send') {
      // #4594 — 앱 화면이 **붙은 세션**에 글을 바로 보낸다(원준: 채우기가 아니라 보내기). 세션에 붙어 열린 화면에만 세션이 있다.
      //  서버가 세 겹(동의·주인·붙음)을 다시 보고 표식 한 줄을 붙여 /prompt 와 같은 통로로 넣는다. 멈춘 세션(409 draft)은 실패로
      //  끝내지 않고 그 세션 화면의 입력칸에 글을 넣어 둔다 — 사람이 보내면 그 말이 세션을 깨운다(#2439 되살리기 규칙).
      //  ★ 세션은 **이 프레임을 띄운 쪽(opts)** 이 안다 — 앱이 params 로 세션 id 를 말해도 믿지 않는다(남의 세션에 보내는 통로가 된다).
      //  ★ 사람이 누른 동작에서만 보낸다(격리 리뷰 차단 2b): iframe 안의 클릭은 부모 창의 transient activation 으로 전파되므로
      //   `navigator.userActivation.isActive` 가 거짓이면 앱 코드가 저 혼자(타이머·데이터 변경 콜백) 보내는 것이다 → 거부.
      //   그 API 가 없는 옛 브라우저는 막지 않는다(막으면 기능이 통째로 죽는다 — 서버의 빈도 상한이 남는다).
      const sid = opts?.sessionId ?? '';
      const text = String((msg.params as { text?: unknown } | undefined)?.text ?? '');
      if (!sid) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: '붙은 세션이 없습니다 — 세션에 붙은 앱 화면에서만 보낼 수 있습니다' } }); return; }
      const ua = (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation;
      if (ua && !ua.isActive) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: '사람이 누른 동작에서만 보낼 수 있습니다' } }); return; }
      const send = (): Promise<any> => api('/api/ui/apps/' + encodeURIComponent(appId) + '/chat-send', { method: 'POST', body: JSON.stringify({ session_id: sid, text }) });
      void send()
        .catch(async (e: any) => {
          if (e?.status !== 403 || !/동의|grant/i.test(String(e?.message || ''))) throw e;   // tools/call 과 같은 «그 자리에서 동의» 규칙(예전 범위 동의 포함)
          if (!(await ensureAppGrant(appId, opts?.title || data.title))) throw e;
          return send();
        })
        .then((out: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { sent: true, session: sid, transport: out?.transport ?? null } }))
        .catch((e: any) => {
          if (e?.status === 409 && e?.body?.draft) {
            //  멈춘 세션 — 서버가 표식을 붙인 글(draft_text)을 그 세션 화면의 입력칸에 넣어 둔다(sess-input 잎 모듈 — 화면이 떠 있어야 넣힌다).
            const draft = String(e.body.draft_text || text);
            const put = putIntoSession([sid], draft);
            toast(put ? '세션이 멈춰 있어 입력칸에 넣어 두었어요 — 보내면 세션이 깨어납니다.' : '세션이 멈춰 있어요 — 세션 화면을 열고 다시 보내 주세요.');
            reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { sent: false, session: sid, draft: put } });
            return;
          }
          reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: e?.status === 403 ? -32001 : -32000, message: (e && e.message ? e.message : String(e)) } });
        });
    } else if (msg.method === 'ui/chrome') {
      // #4592 — 제 머리줄이 있는 앱이 호스트의 앱 머리줄(이름 · 판 · ⋯)을 접어 달라고 한다. 그 줄을 그리는 쪽(세션의 앱 칸)만 받는다.
      const headOn = (msg.params as { head?: unknown } | undefined)?.head !== false;
      if (opts?.onChrome) opts.onChrome({ head: headOn });
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { ok: !!opts?.onChrome } });
    } else if (msg.method === 'ui/menu') {
      // #4592 — 앱의 ⋯ 가 호스트의 앱 메뉴를 연다(앱의 항목이 맨 위). 자리는 프레임 안의 좌표로 오고, 여기서 이 창의 좌표로 옮긴다.
      //  항목은 글자뿐이다(라벨 60자 · 12개까지) — 앱이 호스트 메뉴에 그림 · 마크업을 넣을 길이 없다. 고른 것은 id 만 돌려준다.
      if (!opts?.onMenu) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: '이 화면에서는 호스트 메뉴를 열 수 없습니다' } }); return; }
      const mp = (msg.params ?? {}) as { items?: unknown; x?: unknown; y?: unknown };
      const items = (Array.isArray(mp.items) ? mp.items : []).slice(0, 12)
        .map((it) => ({ id: String((it as { id?: unknown })?.id ?? '').slice(0, 40), label: String((it as { label?: unknown })?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) }))
        .filter((it) => it.id && it.label);
      const r = frame.getBoundingClientRect();
      const num = (v: unknown, max: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };
      void opts.onMenu({ items, x: r.left + num(mp.x, r.width), y: r.top + num(mp.y, r.height) })
        .then((picked) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { picked: picked && items.some((it) => it.id === picked) ? picked : null } }))
        .catch(() => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { picked: null } }));
    } else if (msg.method === 'files/list' || msg.method === 'files/read') {
      // #4592 — 앱 화면이 **붙은 세션의 프로젝트 자료**에서 파일 목록 · 내용을 읽는다(읽기만). 서버가 선언 · 동의 · 주인 · 붙음 · 프로젝트 가시성을 다시 본다.
      //  ★ 세션은 이 프레임을 띄운 쪽(opts)이 안다 — chat/send 와 같은 까닭(앱이 말한 세션 id 를 믿으면 남의 세션 프로젝트를 읽는 통로가 된다).
      const sid = opts?.sessionId ?? '';
      if (!sid) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: '붙은 세션이 없습니다 — 세션에 붙은 앱 화면에서만 파일을 볼 수 있습니다' } }); return; }
      const p = (msg.params ?? {}) as { ext?: unknown; limit?: unknown; path?: unknown };
      const qs = new URLSearchParams({ session_id: sid });
      const list = msg.method === 'files/list';
      if (list) {
        const ext = (Array.isArray(p.ext) ? p.ext : (p.ext == null ? [] : [p.ext])).map((x) => String(x)).filter(Boolean);
        if (ext.length) qs.set('ext', ext.join(','));
        if (p.limit != null && Number.isFinite(Number(p.limit))) qs.set('limit', String(Math.round(Number(p.limit))));
      } else qs.set('path', String(p.path ?? ''));
      const read = (): Promise<any> => api('/api/ui/apps/' + encodeURIComponent(appId) + (list ? '/files?' : '/file?') + qs.toString());
      void read()
        .catch(async (e: any) => {
          if (e?.status !== 403 || !/동의|grant/i.test(String(e?.message || ''))) throw e;   // «그 자리에서 동의» — 앱이 갱신돼 이 권한을 새로 얻었을 때도
          if (!(await ensureAppGrant(appId, opts?.title || data.title))) throw e;
          return read();
        })
        .then((out: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: out }))
        .catch((e: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: e?.status === 403 ? -32001 : -32000, message: (e && e.message ? e.message : String(e)) } }));
    } else if (msg.method === 'prefs/get' || msg.method === 'prefs/set') {
      // #4601 — 앱 × 보는 사람의 개인 설정. 샌드박스 화면은 localStorage 가 없고(불투명 오리진) SDK 에 신원이 없어 서버가 든다.
      //  동의와 무관하다(설정은 라이블리 데이터가 아니라 그 사람이 앱을 보는 방식) — 그래서 tools/call 이 아니라 별도 경로.
      const path = '/api/ui/apps/' + encodeURIComponent(appId) + '/prefs';
      const req = msg.method === 'prefs/get'
        ? api(path)
        : api(path, { method: 'POST', body: JSON.stringify({ patch: (msg.params as { patch?: unknown } | undefined)?.patch ?? {} }) });
      void req
        .then((out: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { prefs: (out && out.prefs) || {} } }))
        .catch((e: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: e?.status === 413 ? -32602 : -32000, message: (e && e.message ? e.message : String(e)) } }));
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
  return {
    root: frame,
    destroy: () => { window.removeEventListener('message', onMsg); frame.remove(); opts?.onTyping?.(false); },
    notify: (method, params) => { frame.contentWindow?.postMessage({ jsonrpc: '2.0', method, params: params ?? {} }, '*'); },
    subscribed: (topic) => topics.has(topic),
    // 같은 값을 다시 넣으면 브라우저가 다시 띄우지 않을 수 있어 매번 끝에 주석 한 줄을 바꿔 단다(문서 밖 — 앱은 모른다).
    //  WindowProxy 는 같은 프레임이면 그대로라 브리지(ev.source 비교)는 새 문서에도 그대로 맞는다.
    reload: () => { topics.clear(); opts?.onTyping?.(false); frame.srcdoc = doc + '<!-- lively:reload ' + (++loads) + ' -->'; },
    setInsets: (i) => {
      const n = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
      const next = { top: n(i.top), right: n(i.right), bottom: n(i.bottom), left: n(i.left) };
      if (next.top === insets.top && next.right === insets.right && next.bottom === insets.bottom && next.left === insets.left) return;
      insets = next; sendInsets();
    },
  };
}

// ── 모달로 열기(전역 런치패드용) — 세션 화면 밖에서 앱 UI 를 띄울 때. panes 탭은 mountAppUiFrame 을 직접 쓴다. ──
let uiEl: HTMLElement | null = null;
let openFrame: AppUiFrame | null = null;

//  #4600 sessionId — 붙은 앱 탭의 「크게 보기」가 같은 세션에 붙은 채로 크게 띄운다(앱 안의 lively.session 이 그대로 선다).
export async function openAppUi(appId: string, opts?: { page?: string; title?: string; sessionId?: string }): Promise<boolean> {
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
          //  «(Esc)» 는 키보드가 있는 화면의 안내다. 폰(50-mobile.css)은 걷는다(#4443).
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => closeAppUi() }, el('span', { text: '닫기' }), el('span', { class: 'v2-appui-esc', text: '(Esc)' }))),
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
