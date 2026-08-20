// v2/browser-surface.ts — 임의의 웹을 **화면 한 칸 안에서** 보는 서피스 (#1829).
//
// 왜 iframe 이 아닌가: 많은 사이트가 `X-Frame-Options` / CSP `frame-ancestors` 로 프레임 삽입을 막는다
//  (실측: github.com 은 iframe 에서 "Framing … violates … frame-ancestors 'none'" 로 차단).
//  데스크톱 앱 안에서는 `<webview>` 가 **별도 WebContents**(중첩 브라우징 컨텍스트가 아니다)라 그 검사를 받지 않는다 —
//  같은 github.com 이 그대로 렌더된다. 지식: embed-real-browser-in-app-xfo-measured-2026-08.
//
// ⚠ 그래서 이 화면은 **어디서 열렸느냐에 따라 할 수 있는 일이 다르다.** 브라우저에서 연 웹 UI 에는 그 능력이 없다 —
//  브라우저는 자기 안에 또 브라우저를 주지 않는다. 그건 우리가 못 고치는 것이므로 **없는 척하지 않고 접는다**:
//  능력이 있으면 안에서 열고, 없으면 "새 탭에서 열기" 로 정직하게 내보낸다.
//  능력 감지는 기능 유무(`livelyDesktop.browserSurface`)로 한다 — 플랫폼·UA 로 추측하지 않는다(구 앱·새 웹 조합에서 어긋난다).
import { anchoredPopover, el, toast } from '../core.js';

interface SurfaceCap { version: number }
export interface ExtItem { id: string; name: string; version: string }
interface ExtBridge {
  list(): Promise<{ ok: boolean; items?: ExtItem[]; error?: string }>;
  install(): Promise<{ ok: boolean; canceled?: boolean; name?: string; error?: string }>;
  remove(id: string): Promise<{ ok: boolean; error?: string }>;
}
interface DesktopBridge { browserSurface?: SurfaceCap | null; browserExtensions?: ExtBridge | null }

/** 이 화면이 남의 사이트를 **안에서** 띄울 수 있나 — 데스크톱 앱 안일 때만 참. */
export function hasBrowserSurface(): boolean {
  const d = (window as any).livelyDesktop as DesktopBridge | undefined;
  return !!(d && d.browserSurface && typeof d.browserSurface.version === 'number');
}

/** 확장(애드온) 다리 — 데스크톱 안에서만 있다. 없으면 화면이 확장 UI 를 아예 안 그린다. */
function extBridge(): ExtBridge | null {
  const d = (window as any).livelyDesktop as DesktopBridge | undefined;
  return (d && d.browserExtensions) || null;
}

/** 사람이 주소창에 친 것을 URL 로 — 스킴이 없으면 https, 스킴이 있어도 http(s)가 아니면 검색으로 넘긴다. */
export function toUrl(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  // 공백이 있거나 점이 없으면 주소가 아니라 검색어로 본다(사람이 주소창에 말을 치는 건 흔하다).
  const looksLikeHost = !/\s/.test(raw) && (/^[a-z][a-z0-9+.-]*:/i.test(raw) || /\.[a-z]{2,}/i.test(raw) || raw.startsWith('localhost'));
  if (!looksLikeHost) return 'https://www.google.com/search?q=' + encodeURIComponent(raw);
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

export interface SurfaceOpts {
  url: string;           // 처음 열 주소
  title?: string;        // 머리에 적을 이름
}

/**
 * 서피스 하나를 만들어 돌려준다. 주소줄(뒤로·앞으로·새로고침·주소·외부열기) + 본문.
 *  능력이 없으면 본문 자리에 폴백 카드가 대신 들어간다(주소줄은 그대로 — 주소는 여전히 고칠 수 있고 새 탭으로 열 수 있다).
 */
export function browserSurface(opts: SurfaceOpts): HTMLElement {
  const start = toUrl(opts.url) || 'https://www.google.com/';
  const live = hasBrowserSurface();

  const addr = el('input', {
    class: 'v2-bs-addr', type: 'text', spellcheck: 'false', autocomplete: 'off',
    'aria-label': '주소', value: start, placeholder: '주소 또는 검색어',
  }) as HTMLInputElement;

  // 새 탭 링크는 항상 산다 — 안에서 못 열든(웹), 열리는데 밖에서 보고 싶든(데스크톱) 쓸 데가 있다.
  //  데스크톱에서 target=_blank 로 바깥 주소를 열면 메인이 시스템 브라우저로 넘긴다(web-shell.openTargetFor).
  const outLink = el('a', {
    class: 'btn-text', href: start, target: '_blank', rel: 'noopener noreferrer', text: '새 탭에서 열기 ↗',
  }) as HTMLAnchorElement;

  const body = el('div', { class: 'v2-bs-body' });
  const view = live
    ? (el('webview', { class: 'v2-bs-view', src: start, allowpopups: null }) as any)
    : null;

  const nav = (raw: string): void => {
    const u = toUrl(raw);
    if (!u) return;
    addr.value = u;
    outLink.href = u;
    if (view) { try { view.loadURL(u); } catch { view.setAttribute('src', u); } }
    else fallbackUrl(u);
  };

  addr.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    nav(addr.value);
  });
  // 주소줄을 누르면 전체 선택 — 브라우저 관용. 안 하면 긴 URL 중간에 커서가 꽂혀 다시 치기가 번거롭다.
  addr.addEventListener('focus', () => addr.select());

  const btn = (label: string, title: string, fn: () => void) =>
    el('button', { class: 'v2-bs-btn', type: 'button', title, 'aria-label': title, text: label, onclick: fn });

  const back = btn('‹', '뒤로', () => { if (view && view.canGoBack && view.canGoBack()) view.goBack(); }) as HTMLButtonElement;
  const fwd = btn('›', '앞으로', () => { if (view && view.canGoForward && view.canGoForward()) view.goForward(); }) as HTMLButtonElement;
  const reload = btn('↻', '새로고침', () => { if (view) view.reload(); else nav(addr.value); });

  const ext = extBridge();
  const head = el('div', { class: 'v2-bs-bar' },
    el('span', { class: 'v2-bs-navs' }, back, fwd, reload),
    addr,
    el('span', { class: 'v2-bs-acts' },
      ext ? el('button', { class: 'btn-text', type: 'button', text: '확장', title: '이 브라우저에 설치된 확장',
        onclick: (e: Event) => openExtensions(e.currentTarget as HTMLElement, ext) }) : null,
      outLink));

  // ── 폴백(브라우저에서 연 웹 UI) — 왜 안 되는지와 무엇을 하면 되는지를 같이 말한다. ──
  //  "지원하지 않습니다" 만 적으면 사람은 우리 버그로 읽는다. 막는 주체가 사이트라는 사실이 안내의 핵심이다.
  function fallbackUrl(u: string): void {
    const host = (() => { try { return new URL(u).host; } catch { return u; } })();
    body.replaceChildren(el('div', { class: 'v2-bs-fallback' },
      el('p', { class: 'v2-bs-fb-h', text: '이 화면 안에서는 열 수 없습니다.' }),
      el('p', { class: 'v2-bs-fb-p', text: '많은 사이트가 다른 페이지 안에 끼워 넣는 것을 스스로 막습니다. 브라우저에서는 그 제한을 넘을 수 없어요.' }),
      el('p', { class: 'v2-bs-fb-p', text: '라이블리 데스크톱 앱에서 열면 이 자리에 그대로 뜹니다.' }),
      el('a', { class: 'btn btn-primary btn-sm', href: u, target: '_blank', rel: 'noopener noreferrer', text: host + ' 새 탭에서 열기 ↗' })));
  }

  if (view) {
    body.replaceChildren(view);
    // 주소·버튼 상태를 실제 이동에 맞춘다(사이트가 스스로 옮겨가는 것도 잡힌다 — 리다이렉트·SPA 라우팅).
    const sync = () => {
      try {
        const u = view.getURL();
        if (u && u !== 'about:blank') { addr.value = u; outLink.href = u; }
        back.disabled = !(view.canGoBack && view.canGoBack());
        fwd.disabled = !(view.canGoForward && view.canGoForward());
      } catch { /* 아직 안 붙었다 — 다음 이벤트에서 다시 맞는다 */ }
    };
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-finish-load', 'dom-ready']) view.addEventListener(ev, sync);
    view.addEventListener('did-fail-load', (e: any) => {
      // -3(ERR_ABORTED)은 리다이렉트·중복 로드의 부수 신호라 오류가 아니다(데스크톱 main.mjs 와 같은 판정).
      if (!e || e.isMainFrame === false || e.errorCode === -3) return;
      body.replaceChildren(el('div', { class: 'v2-bs-fallback' },
        el('p', { class: 'v2-bs-fb-h', text: '페이지를 열지 못했습니다.' }),
        el('p', { class: 'v2-bs-fb-p', text: (e.errorDescription || '알 수 없는 오류') + ' — ' + (e.validatedURL || addr.value) }),
        el('button', { class: 'btn btn-sm', type: 'button', text: '다시 시도', onclick: () => { body.replaceChildren(view); view.reload(); } })));
    });
  } else {
    fallbackUrl(start);
  }

  return el('div', { class: 'v2-app v2-bs' }, head, body);
}

// ── 확장(애드온) 팝오버 (#1829) ──
//  ⚠ 여기서 파일 경로를 만들지 않는다 — `install()` 은 인자가 없고, 메인이 네이티브 선택창을 띄운다.
//   페이지가 경로를 정할 수 있으면 이 화면의 XSS 한 방이 임의 파일을 확장으로 심는 통로가 된다.
async function openExtensions(anchor: HTMLElement, ext: ExtBridge): Promise<void> {
  const body = el('div', { class: 'v2-bs-ext' });
  const closePop = anchoredPopover(anchor, body);   // 반환값 = 닫기 함수

  const draw = async (): Promise<void> => {
    body.replaceChildren(el('p', { class: 'v2-bs-ext-h', text: '확장' }));
    let items: ExtItem[] = [];
    try {
      const r = await ext.list();
      if (!r.ok) throw new Error(r.error || '목록을 읽지 못했습니다');
      items = r.items || [];
    } catch (e: any) {
      body.append(el('p', { class: 'v2-bs-ext-p', text: (e && e.message) || String(e) }));
    }
    if (!items.length) {
      body.append(el('p', { class: 'v2-bs-ext-p', text: '설치된 확장이 없습니다. .crx 나 .zip 파일을 고르면 이 브라우저에만 설치됩니다.' }));
    }
    for (const it of items) {
      body.append(el('div', { class: 'v2-bs-ext-row' },
        el('span', { class: 'v2-bs-ext-nm', text: it.name + (it.version ? ' ' + it.version : '') }),
        el('button', {
          class: 'btn-text', type: 'button', text: '제거',
          onclick: async () => {
            const r = await ext.remove(it.id);
            if (!r.ok) { toast(r.error || '제거하지 못했습니다'); return; }
            toast(it.name + ' 을(를) 제거했습니다. 다시 켜려면 브라우저를 새로 여세요.');
            void draw();
          },
        })));
    }
    body.append(el('button', {
      class: 'btn btn-sm', type: 'button', text: '확장 파일 고르기…',
      onclick: async () => {
        const r = await ext.install();
        if (r.canceled) return;
        if (!r.ok) { toast(r.error || '설치하지 못했습니다'); return; }
        toast((r.name || '확장') + ' 을(를) 설치했습니다.');
        void draw();
      },
    }));
  };
  void draw();
  void closePop;   // 닫기는 바깥 클릭이 한다 — 핸들은 잡아만 둔다(팝오버 계약)
}
