// lib/mermaid.ts — 본문 속 ```mermaid 코드 블록을 그림으로 그린다 (#4685).
//  지시: 상민님(2026-10-14) «프로젝트나 태스크 본문에 mermaid 그래프 쓰는 경우 종종 있는데 렌더링이 안 돼서 불편해 —
//   지식이나 자료 md 뷰어도». md 를 그리는 화면은 전부 lib/markdown.ts 의 renderMarkdown 을 타므로, 그 코드 펜스 분기
//   한 자리가 ```mermaid 를 mermaidFigure 로 넘긴다. 항시 편집 본문(블록 에디터)은 editor/render.ts 가 mermaidPreview 를 붙인다.
//
//  ── 보안 — 그리기는 격리 프레임에서, 결과는 그림(<img>)으로만 ─────────────────────────────────────────────
//   · mermaid 는 그리는 동안 라벨을 innerHTML 로 꽂는다(DOMPurify 를 거친다). 앱과 같은 오리진에서 돌리면 그 정화를 빠져나가는
//     결함 하나가 곧 localStorage 토큰 탈취다. 그런 결함은 실제로 거듭 나왔다 — GHSA-8gwm-58g9-j8pw · GHSA-7rqq-prvp-x9jh
//     (2025, XSS — 11.10.0 에서 고침) · GHSA-ghcm-xqfw-q4vr(2026-05, HTML 주입) · GHSA-6x64-9x62-f2gx(2026-08, 그림 밖 CSS 주입).
//     그리고 이 렌더러를 타는 글은 사람이 쓴 것만이 아니다 — 메일·슬랙·노션에서 끌어온 자료도 탄다.
//   · 그래서 html 미리보기(lib/file-preview.ts htmlFrame)와 같은 수를 둔다: sandbox="allow-scripts" 프레임 하나에 mermaid 를
//     싣는다. allow-same-origin 이 **없어** 문서 오리진이 불투명하다 — 부모 DOM·쿠키·저장소에 손이 닿지 않는다.
//   · 돌려받은 svg 는 부모 DOM 에 심지 않고 data: 주소의 <img> 로만 띄운다. 그림으로 읽힌 svg 는 스크립트를 돌리지 않고
//     바깥 자원도 부르지 않는다(브라우저 규칙). 그래서 이 파일에도 innerHTML 은 없다(markdown.ts 의 P4b 불변식 그대로).
//   · 프레임의 말은 그 프레임 창(contentWindow)에서 온 것만 받고, 값은 문자열·숫자로만 다룬다(frame-bridge.ts 와 같은 규칙).
//
//  ── 글꼴 — 웹 글꼴을 쓰지 않는다 ──
//   그림으로 띄운 svg 는 웹 글꼴(Pretendard CDN)을 받지 못한다. 프레임이 글자 폭을 잴 때와 그림이 그릴 때 글꼴이 다르면 글자가
//   상자를 넘친다. 그래서 양쪽 다 시스템 글꼴 목록 하나(FONT)로 잰다 — Pretendard 를 설치한 사람은 양쪽 다 그걸 쓴다.
//
//  ── 색 — 지금 화면의 토큰 ──
//   테마 'base' 에 앱 토큰 값(--ink · --bg-tint-2 …)을 넣는다. 라이트·다크가 바뀌면(lv:theme-change) 떠 있는 그림을 다시 그린다.
//
//  ── 판 ──
//   mermaid 는 package.json 에 판을 못박고(devDependencies — 서버는 안 쓴다) scripts/build-web.mjs 가 dist/mermaid.min.js 를
//   vendor/mermaid 로 복사한다(pdf.js 와 같은 규율). 3.5MB 라 ```mermaid 가 화면에 처음 보일 때만 받는다.
import { el, replaceKids } from './dom.js';
import { type Picture, openViewer, svgUrl } from './mermaid-viewer.js';

/** 그림 글꼴 — 프레임(잴 때)과 <img>(그릴 때)가 같은 글꼴을 쓰게 시스템 글꼴만 적는다. */
const FONT = '"Pretendard", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Segoe UI", sans-serif';
const FONT_SIZE = '14px';
/** 본문 안 그림의 최소 배율 — 칸에 맞추느라 이보다 작아지면 글자를 못 읽는다. 그땐 칸에 맞추지 않고 가로로 민다(FIT_SPAN 안에서). */
const MIN_SCALE = 0.7;   // 14px 글자가 약 10px — 2026-10-14 #4478 의존 그래프(폭 2,000px대)로 0.6(8px대)·0.7 을 눈으로 대 보고 정했다
/** 단, 0.7배로도 칸의 이 배수보다 넓으면 그 자리에선 조각(대개 빈 여백)만 보인다 — 그땐 칸에 맞춰 통째로 줄인다(글은 [크게 보기]).
 *  2026-10-14 프리뷰 실측: 허브 본문 위젯(칸 370px)에 폭 2,032px 그래프를 0.7배로 두니 왼쪽 위 빈칸과 선 하나만 보였다. */
const FIT_SPAN = 2;
const LOAD_MS = 20_000;      // 프레임이 mermaid 를 싣고 «준비» 를 말할 때까지
const RETRY_MS = 30_000;     // 싣기에 실패하면 이 동안은 다시 싣지 않는다(그림마다 3.5MB 를 다시 부르지 않게)
//  그림 하나 — 넘기면 프레임을 버리고 새로 띄운다. mermaid 엔 무한 루프 결함이 실제로 있었다
//   (GHSA-6m6c-36f7-fhxh 간트 · GHSA-2v8p-3f2j-5mp7 XY 차트 — 지금 판은 고친 판이지만 다음 것을 기다리며 서 있을 수는 없다).
const DRAW_MS = 15_000;
const SVG_MAX = 8_000_000;   // 프레임이 돌려준 svg 상한(글자 수)
const CACHE_MAX = 48;

const NOTE_WAIT = '다이어그램을 그리고 있습니다…';
const NOTE_LOAD = '다이어그램 도구를 불러오지 못해 코드로 보여 드립니다.';
const NOTE_SYNTAX = '다이어그램 문법을 읽지 못했습니다. 코드를 확인해 주세요.';
const NOTE_SLOW = '다이어그램을 그리는 데 너무 오래 걸려 멈췄습니다. 코드로 보여 드립니다.';
const NOTE_EMPTY = '코드를 적으면 여기에 그림이 그려집니다.';

// ── 색 — mermaid 테마 변수 ← 앱 토큰 ───────────────────────────────────────────────────────────────
//  토큰이 비면(스타일을 안 실은 문서) 그 변수는 빼고 mermaid 기본값에 맡긴다.
const TOKEN_VARS: ReadonlyArray<readonly [string, string]> = [
  ['background', '--surface'], ['edgeLabelBackground', '--surface'],
  ['primaryColor', '--bg-tint-2'], ['mainBkg', '--bg-tint-2'],
  ['primaryBorderColor', '--node-blue-soft'], ['nodeBorder', '--node-blue-soft'],
  ['primaryTextColor', '--ink'], ['textColor', '--ink'], ['titleColor', '--ink'], ['noteTextColor', '--ink'],
  ['secondaryColor', '--bg-success'], ['tertiaryColor', '--bg-tint'],
  ['lineColor', '--muted-2'],
  ['clusterBkg', '--bg-tint'], ['clusterBorder', '--line-net-2'],
  ['noteBkgColor', '--warn-bg'], ['noteBorderColor', '--warn-line'],
  ['pieStrokeColor', '--surface'], ['pieOuterStrokeColor', '--line-net-2'],
  ['pieTitleTextColor', '--ink'], ['pieSectionTextColor', '--ink'], ['pieLegendTextColor', '--ink'],
  //  마인드맵 한가운데(root)·깃 그래프 첫 가지 — 그냥 두면 다크에서 어두운 원에 어두운 글자가 앉았다(2026-10-14 실측).
  ['git0', '--node-blue-soft'], ['gitBranchLabel0', '--ink'],
];
//  범주 색(파이 조각 pie1~ · 마인드맵·타임라인 가지 cScale0~) — 그냥 두면 mermaid 가 primaryColor 를 돌려 만드는데,
//  옅은 틴트에선 조각이 흰색에 가깝고(라이트) 다크에선 가지가 검게 나왔다(2026-10-14 실측). 두 테마에 쌍이 있는 옅은 면 토큰을 쓴다.
const CATEGORY_TOKENS = ['--node-blue-soft', '--node-mint-soft', '--warn-line', '--danger-line', '--line-net-2', '--line-note'];

type Palette = { key: string; vars: Record<string, unknown> };

function palette(): Palette {
  const de = document.documentElement;
  const t = de.getAttribute('data-theme');
  //  90-dark.css 와 같은 판정 — 명시한 다크, 또는 «라이트 명시 없음 + 시스템이 다크».
  const dark = t === 'dark' || (t !== 'light' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  const cs = getComputedStyle(de);
  const vars: Record<string, unknown> = { darkMode: dark, fontFamily: FONT, fontSize: FONT_SIZE, pieOpacity: '1' };
  const tok = (name: string): string => cs.getPropertyValue(name).trim();
  for (const [name, token] of TOKEN_VARS) {
    const v = tok(token);
    if (v) vars[name] = v;
  }
  const ink = tok('--ink');
  CATEGORY_TOKENS.forEach((token, i) => {
    const v = tok(token);
    if (!v) return;
    vars['pie' + (i + 1)] = v;
    vars['cScale' + i] = v;
    if (ink) vars['cScaleLabel' + i] = ink;
  });
  return { key: JSON.stringify(vars), vars };
}

// ── 엔진 — 격리 프레임 하나 ────────────────────────────────────────────────────────────────────────

/** vendor/mermaid 주소 — 이 모듈 주소 기준(/ui/ · /preview/<id>/ui/ 어디에 걸려도 맞다). 판 표지(?v=)를 이어 붙여야 1년 캐시를 탄다. */
function vendorSrc(): string {
  let me = '';
  try { me = String(import.meta.url || ''); } catch (_) { /* 묶음(iife) 시험엔 import.meta 가 없다 */ }
  const u = new URL('../vendor/mermaid/mermaid.min.js', me || location.href);
  let v = '';
  try { v = new URL(me).searchParams.get('v') || ''; } catch (_) { /* 위와 같다 */ }
  if (!v) {
    //  모듈 주소에 판이 안 붙어 온 경우(gen-watch.ts 가 한 번 데인 자리) — 진입 스크립트의 판을 쓴다.
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src*="?v="]');
    if (entry) v = new URL(entry.src, location.href).searchParams.get('v') || '';
  }
  if (v) u.searchParams.set('v', v);
  return u.href;
}

/* 프레임 안에서 도는 코드 — 문자열로 실려 가므로 이 모듈의 어떤 이름도 못 쓴다(자기완결이어야 한다).
 *  하는 일: 부모가 보낸 코드를 그려 svg 를 «그림으로 읽히는 XML» 로 다듬어 돌려준다.
 *   · mermaid 는 svg 를 HTML 직렬화로 준다(`<br>`·꼬리표 없는 이름공간). 그대로는 XML 로 안 읽혀 <img> 가 빈 그림이 된다
 *     → HTML 로 다시 읽고 XMLSerializer 로 직렬화한다(라벨 안 HTML 에 xmlns 가 붙고 `<br/>` 로 닫힌다).
 *   · 크기를 width·height 로 못박는다 — mermaid 기본값(width=100% + max-width)은 문서 안에서만 뜻이 있고, 그림으로는 크기를 못 낸다.
 *   · 말은 «준비» 때 부모에게 넘긴 전용 포트(MessageChannel)로만 주고받는다 — 아래 frameUp 머리말. */
function frameMain(): void {
  const W: any = window;
  const M = W.mermaid;
  if (!M || typeof M.render !== 'function') { W.parent.postMessage({ lv: 'mmd', op: 'ready', ok: false }, '*'); return; }
  const ch = new MessageChannel();
  const port = ch.port1;
  port.onmessage = async (e: MessageEvent) => {
    const d: any = e.data;
    if (!d || d.op !== 'draw') return;
    const id = Number(d.id) || 0;
    try {
      M.initialize({
        startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        theme: 'base', themeVariables: d.vars || {}, fontFamily: String(d.font || ''),
      });
      const r = await M.render('mmd' + id, String(d.code || ''));
      const svg = new DOMParser().parseFromString(String(r && r.svg || ''), 'text/html').querySelector('svg');
      if (!svg) throw new Error('그림이 비어 있습니다');
      const vb = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      const w = Math.ceil(vb[2] > 0 ? vb[2] : parseFloat(svg.getAttribute('width') || '') || 0);
      const h = Math.ceil(vb[3] > 0 ? vb[3] : parseFloat(svg.getAttribute('height') || '') || 0);
      if (!(w > 0 && h > 0)) throw new Error('그림 크기를 알 수 없습니다');
      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
      svg.style.removeProperty('max-width');
      const title = svg.querySelector(':scope > title');
      port.postMessage({ op: 'done', id, svg: new XMLSerializer().serializeToString(svg), w, h, title: title ? String(title.textContent || '') : '' });
    } catch (err: any) {
      port.postMessage({ op: 'done', id, err: String((err && (err.message || err.str)) || err || '') });
    } finally {
      //  실패한 그리기는 임시 칸(d<id>)을 남길 수 있다 — 다음 그리기의 측정을 흐리지 않게 걷는다.
      const junk = W.document.getElementById('dmmd' + id);
      if (junk) junk.remove();
    }
  };
  W.parent.postMessage({ lv: 'mmd', op: 'ready', ok: true }, '*', [ch.port2]);
}

function frameHtml(src: string): string {
  const attr = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  //  nonce CSP — 이 문서에서 도는 스크립트는 nonce 를 단 두 개(mermaid · frameMain)뿐이다. 라벨 정화가 뚫려 무엇이 꽂혀도
  //  인라인 스크립트·on* 속성·javascript: 주소는 돌지 않고, 밖으로 보내는 길(fetch·그림 주소)도 막힌다.
  //  mermaid 11.17.2 번들엔 eval·new Function·Worker 가 없다(2026-10-14 grep) — 그래서 'unsafe-eval' 없이 돈다.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const csp = "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; img-src data:";
  //  측정용 문서다. 글꼴은 그림과 같은 목록(FONT) — 위 머리말 «글꼴» 참조.
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
    + '<style>html,body{margin:0;background:transparent}body{font-family:' + FONT + ';font-size:' + FONT_SIZE + '}</style>'
    + '</head><body>'
    + '<script nonce="' + nonce + '" src="' + attr + '"></scr' + 'ipt>'
    + '<script nonce="' + nonce + '">(' + String(frameMain) + ')();</scr' + 'ipt></body></html>';
}

/** 그린 결과 — 그림이거나, 못 그린 까닭. load(도구를 못 실음)는 다시 하면 될 수 있어 캐시하지 않는다.
 *  syntax(문법)·slow(시간 상한)는 같은 코드면 또 그렇다 — 캐시해서 같은 본문을 다시 열 때 또 멈추지 않게 한다. */
type Drawn = Picture | { err: string; kind: 'syntax' | 'load' | 'slow' };
const isPic = (d: Drawn | null): d is Picture => !!d && !('err' in d);

let frame: HTMLIFrameElement | null = null;
let port: MessagePort | null = null;
let ready: Promise<boolean> | null = null;
let onReady: ((p: MessagePort | null) => void) | null = null;
let failedAt = 0;
let seq = 0;
let current: { id: number; done: (d: Drawn) => void } | null = null;
let chain: Promise<unknown> = Promise.resolve();
let listening = false;

function dropFrame(): void {
  const waiting = onReady;
  if (port) { port.onmessage = null; port.close(); }
  if (frame) frame.remove();
  frame = null; port = null; ready = null; onReady = null;
  //  기다리던 것이 있으면 지금 끝낸다 — 그 프레임은 이제 답하지 않는다(시간 상한까지 매달려 있지 않게).
  if (waiting) waiting(null);
  if (current) current.done({ err: '', kind: 'load' });
}

//  창 메시지는 «준비» 한 번만 받는다 — 우리 프레임 창(contentWindow)에서 온 것만.
function onWindowMessage(e: MessageEvent): void {
  if (!frame || e.source !== frame.contentWindow) return;
  const d: any = e.data;
  if (!d || typeof d !== 'object' || d.lv !== 'mmd' || d.op !== 'ready' || !onReady) return;
  onReady(d.ok === true && e.ports && e.ports[0] ? e.ports[0] : null);
}

function onPortMessage(e: MessageEvent): void {
  const d: any = e.data;
  if (!d || typeof d !== 'object' || d.op !== 'done' || !current || Number(d.id) !== current.id) return;
  const w = Number(d.w), h = Number(d.h);
  current.done(typeof d.svg === 'string' && d.svg.length <= SVG_MAX && w > 0 && h > 0 && w < 1e6 && h < 1e6
    ? { svg: d.svg, w, h, title: typeof d.title === 'string' ? d.title.trim().slice(0, 200) : '' }
    : { err: typeof d.err === 'string' && d.err ? d.err.slice(0, 600) : '그림을 받지 못했습니다', kind: 'syntax' });
}

/**
 * 프레임을 띄우고(없으면) mermaid 를 다 실었는지 답한다. 실패하면 RETRY_MS 동안은 다시 시도하지 않는다.
 *  말길을 «준비» 때 받은 전용 포트로 좁히는 까닭: 정화가 뚫린 그림이 프레임을 다른 주소로 옮기면(meta refresh 등) 그 뒤로
 *  contentWindow 에 보내는 말은 **옮겨 간 문서**가 받는다 — 다음에 그릴 다른 문서의 코드가 새어 나간다. 포트는 처음 문서의
 *  것이라 옮겨 간 문서는 쥘 수 없다. 그리고 프레임이 두 번째로 load 를 내면(=옮겨 갔다) 그 자리에서 버린다.
 */
function frameUp(): Promise<boolean> {
  if (frame && frame.isConnected && ready) return ready;
  if (Date.now() - failedAt < RETRY_MS) return Promise.resolve(false);
  dropFrame();
  if (!listening) { window.addEventListener('message', onWindowMessage); listening = true; }
  //  화면 밖에 두되 크기는 준다 — display:none 이면 레이아웃이 없어 글자 폭을 못 잰다.
  const f = el('iframe', {
    class: 'md-mermaid-engine', title: '다이어그램 그리기', 'aria-hidden': 'true', tabindex: '-1',
    sandbox: 'allow-scripts', referrerpolicy: 'no-referrer',
    style: 'position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;pointer-events:none',
  }) as HTMLIFrameElement;
  let loads = 0;
  f.addEventListener('load', () => { if (++loads > 1 && frame === f) dropFrame(); });
  f.srcdoc = frameHtml(vendorSrc());
  frame = f;
  const p = new Promise<MessagePort | null>((resolve) => {
    const t = setTimeout(() => resolve(null), LOAD_MS);
    onReady = (got) => { clearTimeout(t); onReady = null; resolve(got); };
  });
  ready = p.then((got) => {
    if (frame !== f) { if (got) got.close(); return false; }   // 그 사이 버려졌다
    if (!got) { failedAt = Date.now(); dropFrame(); return false; }
    port = got;
    port.onmessage = onPortMessage;
    return true;
  });
  document.body.append(f);
  return ready;
}

/** 한 번에 하나씩 그린다 — 시간 상한을 «보낸 때부터» 재야 줄 선 그림이 억울하게 잘리지 않는다. */
function draw(code: string, pal: Palette): Promise<Drawn> {
  const run = async (): Promise<Drawn> => {
    if (!(await frameUp()) || !port) return { err: '', kind: 'load' };
    const out = port;
    const id = ++seq;
    return new Promise<Drawn>((resolve) => {
      const t = setTimeout(() => {
        current = null;
        dropFrame();   // 멈춘 프레임은 버린다 — 다음 그림은 새 프레임에서
        resolve({ err: '', kind: 'slow' });
      }, DRAW_MS);
      current = { id, done: (d) => { clearTimeout(t); current = null; resolve(d); } };
      out.postMessage({ op: 'draw', id, code, vars: pal.vars, font: FONT });
    });
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

// 같은 코드·같은 색이면 같은 그림이다 — 화면이 본문을 다시 그릴 때마다(실시간 갱신·창 전환) 다시 그리지 않는다.
const cache = new Map<string, Drawn>();
const inflight = new Map<string, Promise<Drawn>>();
const keyOf = (pal: Palette, code: string): string => pal.key + '\u0000' + code;

function lookup(key: string): Drawn | undefined {
  const v = cache.get(key);
  if (v) { cache.delete(key); cache.set(key, v); }   // 최근 쓴 것을 뒤로(오래 안 쓴 것부터 비운다)
  return v;
}

function drawCached(code: string, pal: Palette): Promise<Drawn> {
  const key = keyOf(pal, code);
  const hit = lookup(key);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = draw(code, pal).then((d) => {
      inflight.delete(key);
      if (!('err' in d && d.kind === 'load')) {
        cache.set(key, d);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      }
      return d;
    });
    inflight.set(key, p);
  }
  return p;
}

// ── 그림 칸 — 본문용(mermaidFigure)과 에디터용(mermaidPreview)이 같은 칸을 쓴다 ─────────────────────────

type Fig = {
  code: string;
  edit: boolean;                 // 에디터 미리보기 — 코드는 에디터 칸이 쥔다
  pal: string;                   // 마지막으로 그리기 시작한 색 열쇠(테마가 바뀌었나 보려고)
  ticket: number;                // 그리는 사이 코드·색이 또 바뀌면 늦게 온 결과를 버린다
  seen: boolean;                 // 한 번이라도 화면에 들어왔나(들어오기 전엔 그리지 않는다)
  last: Drawn | null;
  view: HTMLElement;
  note: HTMLElement;
  zoomBtn: HTMLButtonElement;
  onState?: (ok: boolean) => void;
};
const FIGS = new WeakMap<HTMLElement, Fig>();

function noteFor(d: Drawn): string {
  if (isPic(d)) return '';
  if (d.kind === 'load') return NOTE_LOAD;
  if (d.kind === 'slow') return NOTE_SLOW;
  //  mermaid 의 문법 오류는 여러 줄이다 — «Parse error on line 3:» · 코드 발췌 · 화살표 줄 · «Expecting 'A', 'B', … got 'X'».
  //  발췌·화살표는 한 줄로 펴면 뜻이 없고 기대 토큰 목록은 열 개가 넘는다 — 어느 줄인지(첫 줄)와 무엇에 걸렸는지(got …)만 옮긴다.
  const lines = d.err.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = (lines[0] || '').replace(/:$/, '');
  const got = /\bgot\s+(\S+)\s*$/.exec(lines.slice(1).find((l) => /^Expecting\b/.test(l)) || '');
  const why = head + (got ? ' — got ' + got[1] : '');
  return NOTE_SYNTAX + (why ? ' (' + (why.length > 200 ? why.slice(0, 200) + '…' : why) + ')' : '');
}

function show(figEl: HTMLElement, st: Fig, d: Drawn): void {
  const ok = isPic(d);
  figEl.classList.remove('is-wait');
  figEl.classList.toggle('is-ok', ok);
  figEl.classList.toggle('is-err', !ok);
  st.note.textContent = noteFor(d);
  if (ok) {
    st.last = d;
    const img = el('img', { class: 'md-mermaid-img', alt: d.title || '다이어그램', decoding: 'async', draggable: 'false' }) as HTMLImageElement;
    img.width = d.w;
    img.height = d.h;
    sizeImg(img, d.w, innerWidth(st.view));   // 칸 폭이 바뀌면 fitRo 가 다시 잰다
    img.src = svgUrl(d.svg);
    img.addEventListener('click', () => openViewer(d, img));
    replaceKids(st.view, img);
  } else if (!st.edit) {
    replaceKids(st.view);   // 본문 칸 — 그림 대신 코드가 보인다(CSS .is-err)
  }
  //  에디터 칸이 틀린 코드를 받으면 직전 그림을 흐리게 남긴다 — 고치는 동안 그림이 깜빡이며 사라지지 않게(CSS .is-err .md-mermaid-img).
  st.zoomBtn.disabled = !isPic(st.last) || (!ok && !st.edit);
  if (st.onState) st.onState(ok);
}

// 칸 폭 정책 — 작은 그림은 키우지 않는다. 칸보다 넓으면 칸에 맞추되 MIN_SCALE 밑으로는 줄이지 않고 가로로 민다.
//  그래도 칸의 FIT_SPAN 배보다 넓으면(조각만 보인다) 칸에 맞춰 통째로 줄인다. 칸 폭(cw)을 모르면(아직 문서 밖) 앞의 규칙만.
//  CSS min()/max() 로는 못 쓴다 — 「0.7배 → 칸 폭」으로 뛰는 자리가 있어서다(연속 함수의 조합은 뛰지 못한다). 그래서 칸을 잰다.
/** 칸 안쪽 폭(여백 뺀 것) — 문서 밖이면 0(모른다). ResizeObserver 의 contentRect.width 와 같은 값이다. */
function innerWidth(view: HTMLElement): number {
  if (!view.isConnected) return 0;
  const cs = getComputedStyle(view);
  return Math.max(0, view.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
}
function sizeImg(img: HTMLImageElement, w: number, cw: number): void {
  img.style.width = cw > 0 && w * MIN_SCALE > cw * FIT_SPAN ? '100%' : `min(${w}px, max(100%, ${Math.ceil(w * MIN_SCALE)}px))`;
}
let fitRo: ResizeObserver | null = null;
function watchWidth(view: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return;
  if (!fitRo) {
    fitRo = new ResizeObserver((entries) => {
      for (const e of entries) {
        const fig = (e.target as HTMLElement).closest('figure.md-mermaid') as HTMLElement | null;
        const st = fig ? FIGS.get(fig) : undefined;
        const img = (e.target as HTMLElement).querySelector('img.md-mermaid-img') as HTMLImageElement | null;
        if (st && img && isPic(st.last)) sizeImg(img, st.last.w, e.contentRect.width);
      }
    });
  }
  fitRo.observe(view);
}

async function paint(figEl: HTMLElement): Promise<void> {
  const st = FIGS.get(figEl);
  if (!st) return;
  const ticket = ++st.ticket;
  if (!st.code.trim()) {
    st.last = null;
    figEl.classList.remove('is-ok', 'is-err');
    figEl.classList.add('is-wait');
    st.note.textContent = NOTE_EMPTY;
    replaceKids(st.view);
    st.zoomBtn.disabled = true;
    if (st.onState) st.onState(false);
    return;
  }
  const pal = palette();
  st.pal = pal.key;
  const hit = lookup(keyOf(pal, st.code));
  if (hit) { show(figEl, st, hit); return; }
  if (!st.last || !st.edit) {
    //  처음 그리거나(본문) — 자리 표시. 에디터가 고쳐 그리는 중이면 직전 그림을 그대로 둔다(깜빡임 없음).
    if (!figEl.classList.contains('is-ok')) {
      figEl.classList.add('is-wait');
      st.note.textContent = NOTE_WAIT;
    }
  }
  const d = await drawCached(st.code, pal);
  if (st.ticket !== ticket) return;   // 그 사이 코드·색이 바뀌었다 — 새 그리기가 이어 받는다
  show(figEl, st, d);
}

// 화면에 들어올 때 그린다 — 접힌 토글·안 보이는 탭·스크롤 아래의 그림 때문에 도구(3.5MB)를 받지 않는다.
let io: IntersectionObserver | null = null;
function whenSeen(figEl: HTMLElement): void {
  const st = FIGS.get(figEl);
  if (!st) return;
  if (typeof IntersectionObserver === 'undefined') { st.seen = true; void paint(figEl); return; }
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io!.unobserve(e.target);
        const s = FIGS.get(e.target as HTMLElement);
        if (s) { s.seen = true; void paint(e.target as HTMLElement); }
      }
    }, { rootMargin: '400px 0px' });
  }
  io.observe(figEl);
}

// 테마가 바뀌면 떠 있는 그림을 새 색으로 다시 그린다. 색 열쇠가 같으면(하네스 테마 동기 같은 다른 lv:theme-change) 건너뛴다.
let themeHooked = false;
function hookTheme(): void {
  if (themeHooked) return;
  themeHooked = true;
  const again = (): void => {
    const key = palette().key;
    document.querySelectorAll<HTMLElement>('figure.md-mermaid').forEach((f) => {
      const st = FIGS.get(f);
      if (st && st.seen && st.pal !== key) void paint(f);
    });
  };
  document.addEventListener('lv:theme-change', again);
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', again); } catch (_) { /* 구형 브라우저 — lv:theme-change 만으로 */ }
}

function makeFig(code: string, edit: boolean): { figEl: HTMLElement; st: Fig; acts: HTMLElement } {
  hookTheme();
  const view = el('div', { class: 'md-mermaid-view' });
  const note = el('p', { class: 'md-mermaid-note', role: 'status' });
  const zoomBtn = el('button', { type: 'button', class: 'md-mermaid-btn md-mermaid-zoombtn', text: '크게 보기', disabled: true }) as HTMLButtonElement;
  const acts = el('span', { class: 'md-mermaid-acts' }, zoomBtn);
  const figEl = el('figure', { class: 'md-mermaid is-wait' + (edit ? ' is-edit' : '') },
    view, el('figcaption', { class: 'md-mermaid-bar' }, note, acts));
  const st: Fig = { code, edit, pal: '', ticket: 0, seen: false, last: null, view, note, zoomBtn };
  zoomBtn.addEventListener('click', () => { if (isPic(st.last)) openViewer(st.last, zoomBtn); });
  FIGS.set(figEl, st);
  watchWidth(view);
  return { figEl, st, acts };
}

/**
 * 본문의 ```mermaid 한 덩어리 → 그림 칸. 그리는 동안·못 그렸을 때도 내용이 사라지지 않는다:
 *  못 그리면(문법 오류·도구를 못 실음) 코드를 그대로 보이고 까닭을 한 줄 적는다. [코드 보기]로 원문을 펼쳐 복사할 수 있다.
 *  같은 코드를 방금 그렸으면(캐시) 기다림 없이 바로 그림이 선다.
 */
export function mermaidFigure(code: string): HTMLElement {
  const { figEl, st, acts } = makeFig(code, false);
  //  코드 칸 — 감싸는 div 를 두는 까닭: 채팅·가이드가 렌더 뒤 <pre> 를 [복사] 래퍼로 감싼다(chat-view decorateCode ·
  //   guide/render decorate). 접고 펴는 일은 이 div 가 하므로 래퍼가 끼어도 함께 접힌다.
  const codeWrap = el('div', { class: 'md-mermaid-code' }, el('pre', { class: 'md-pre' }, el('code', { text: code })));
  const codeBtn = el('button', { type: 'button', class: 'md-mermaid-btn md-mermaid-codebtn', 'aria-expanded': 'false', text: '코드 보기' });
  codeBtn.addEventListener('click', () => {
    const on = !figEl.classList.contains('show-code');
    figEl.classList.toggle('show-code', on);
    codeBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    codeBtn.textContent = on ? '코드 접기' : '코드 보기';
  });
  figEl.insertBefore(codeWrap, st.view.nextSibling);
  acts.prepend(codeBtn);
  const pal = palette();
  const hit = lookup(keyOf(pal, code));
  if (hit) { st.seen = true; st.pal = pal.key; show(figEl, st, hit); }
  else { st.note.textContent = NOTE_WAIT; whenSeen(figEl); }
  return figEl;
}

/**
 * 블록 에디터의 mermaid 코드 블록 미리보기 — 코드는 에디터 칸이 쥐고, 여기는 그림만 그린다.
 *  set(code) 는 타이핑마다 불러도 된다(300ms 묶음). onState(ok) — 그림이 섰는지(에디터가 코드 칸을 접을지 정한다).
 *  [코드 편집]은 onEdit — 에디터가 코드 칸에 커서를 둔다.
 */
export function mermaidPreview(opts: { onEdit: () => void; onState: (ok: boolean) => void }): { el: HTMLElement; set: (code: string) => void } {
  const { figEl, st, acts } = makeFig('', true);
  figEl.setAttribute('contenteditable', 'false');
  st.onState = opts.onState;
  const editBtn = el('button', { type: 'button', class: 'md-mermaid-btn', text: '코드 편집' });
  editBtn.addEventListener('click', () => opts.onEdit());
  acts.prepend(editBtn);
  let timer: any = 0;
  let first = true;
  const set = (code: string): void => {
    st.code = code;
    clearTimeout(timer);
    if (first) {
      //  처음 한 번은 바로 — 캐시에 있으면 에디터가 뜨는 그 순간 그림이 선다.
      first = false;
      const pal = palette();
      const hit = code.trim() ? lookup(keyOf(pal, code)) : undefined;
      if (hit) { st.seen = true; st.pal = pal.key; show(figEl, st, hit); return; }
      st.note.textContent = code.trim() ? NOTE_WAIT : NOTE_EMPTY;
      whenSeen(figEl);
      return;
    }
    if (st.seen) timer = setTimeout(() => void paint(figEl), 300);
  };
  return { el: figEl, set };
}
