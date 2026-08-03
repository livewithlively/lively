// 중앙 박스 — 단독 전체화면 터미널 워크스페이스(새 탭). xterm.js + 서버 node-pty(tmux).
// 좌측 접이식 파일 익스플로러(업/다운로드) · 탭 구조(터미널 + 파일 미리보기) · 보기설정(폰트/테마/크기).
// 인증: 세션 쿠키(메인 UI 이메일+비번 로그인) OR localStorage 토큰(에이전트) — 둘 다 수용(서버 sessionOrBearer).
//  진입 시 /api/ui/me 로 실제 인증을 확인(토큰 유무로 막지 않음) → ticket 쿠키 발급 → WS. md 렌더는 md.js 재사용.
// (#1313 R51) 손편집 public/terminal.js 를 그대로 옮긴 TS 소스 — 산출물은 esbuild iife 번들 public/terminal.js.
//  부팅 호출(boot())은 번들 엔트리 terminal.entry.ts 에 있다(이 모듈을 import 하는 것만으로 부팅되지 않게 —
//  테스트가 브라우저 없이 순수 판정 함수를 직접 import 할 수 있는 이유).
'use strict';

import { el, renderMarkdown } from './md.js';

// xterm.js 는 CDN 클래식 스크립트로 먼저 로드된다(terminal.html) — 번들 대상이 아니라 전역으로 온다.
declare const Terminal: any;
declare const FitAddon: any;
declare const WebglAddon: any;
declare const CanvasAddon: any;
// 빌드 스탬프 — 빌드 시 esbuild define 이 주입한다(scripts/build-standalone.mjs). 종전엔 손으로 고치는 상수였다.
declare const TERMJS_BUILD: string;
declare global {
  interface Window {
    Terminal?: any; FitAddon?: any; WebglAddon?: any; CanvasAddon?: any;
    livelyTermDiag?: () => string;
    livelyJumpToPrompt?: (text: string) => void;
  }
}
const TOKEN_KEY = 'lively_ui_token';
const PREFS_KEY = 'lively_term_prefs';
const SESSION_ID = new URLSearchParams(location.search).get('session') || '';
// 세션 라벨 — 입장 링크가 ?label= 로 실어 보낸다(프로젝트/팀 세션은 개인 /sessions 목록에 없어 API 폴백이 못 찾음).
const SESSION_LABEL = new URLSearchParams(location.search).get('label') || '';
// 분산 노드(#869) — 이 세션이 원격 노드에서 돌면 ?node= 로 온다. WS/REST 에 그대로 실어 게이트웨이가 릴레이.
const NODE_ID = new URLSearchParams(location.search).get('node') || '';
// #1059 — 이 페이지가 **자동 복원으로 열린** 것인지(복원이 붙여 주는 표식). 루프 차단에 쓴다:
//  복원한 세션이 곧 다시 죽으면(예: 이어받을 대화가 없어 claude 가 즉시 종료) 또 4410 이 오는데,
//  그때 다시 자동 복원하면 '복원→즉사→복원' 이 끝없이 돈다(2026-07-28 실측: 화면이 계속 새로고침).
const RESTORED = new URLSearchParams(location.search).get('restored') === '1';
const nodeQ = (joiner) => (NODE_ID ? joiner + 'node=' + encodeURIComponent(NODE_ID) : '');

// 모든 라틴 글꼴 뒤에 자체호스팅 'D2Coding'(public/fonts, OFL)을 한글 폴백으로 둔다 →
// 어떤 글꼴을 골라도 한글은 D2Coding 으로 또렷하게 렌더된다(#279 한글 가독성). @font-face=terminal.html.
const FONTS = [
  { v: "'JetBrains Mono', 'D2Coding', monospace", label: 'JetBrains Mono' },
  { v: "'D2Coding', monospace", label: 'D2Coding · 한글 코딩' },
  { v: "'Fira Code', 'D2Coding', monospace", label: 'Fira Code' },
  { v: "'Source Code Pro', 'D2Coding', monospace", label: 'Source Code Pro' },
  { v: "'IBM Plex Mono', 'D2Coding', monospace", label: 'IBM Plex Mono' },
  { v: "'Roboto Mono', 'D2Coding', monospace", label: 'Roboto Mono' },
  { v: "Menlo, 'D2Coding', monospace", label: 'Menlo' },
  { v: "'SF Mono', SFMono-Regular, 'D2Coding', monospace", label: 'SF Mono' },
  { v: "Monaco, 'D2Coding', monospace", label: 'Monaco' },
  { v: "Consolas, 'D2Coding', monospace", label: 'Consolas' },
];
const THEMES = {
  dark:      { name: '다크', dark: true,  theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70' } },
  light:     { name: '라이트', dark: false, theme: { background: '#fdfdfd', foreground: '#2a2a2a', cursor: '#5566ff', selectionBackground: '#cfe3ff' } },
  dracula:   { name: 'Dracula', dark: true, theme: { background: '#282a36', foreground: '#f8f8f2', cursor: '#ff79c6', selectionBackground: '#44475a' } },
  solarized: { name: 'Solarized Dark', dark: true, theme: { background: '#002b36', foreground: '#93a1a1', cursor: '#cb4b16', selectionBackground: '#073642' } },
  nord:      { name: 'Nord', dark: true, theme: { background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', selectionBackground: '#434c5e' } },
  github:    { name: 'GitHub Light', dark: false, theme: { background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#b6e3ff' } },
};

// 저장된 글꼴에 한글 폴백(D2Coding)이 없으면 끼워 넣는다 — 옛 prefs 사용자도 새로고침만으로 한글 가독성 확보(#279).
function withKR(ff) {
  ff = String(ff || FONTS[0].v);
  if (/D2Coding/i.test(ff)) return ff;
  if (/,?\s*monospace\s*$/i.test(ff)) return ff.replace(/,?\s*monospace\s*$/i, ", 'D2Coding', monospace");
  return ff + ", 'D2Coding', monospace";
}
function prefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (_) { /* default */ }
  const browserDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const merged = Object.assign({ fontFamily: FONTS[0].v, fontSize: 14, theme: browserDark ? 'dark' : 'light', cursorStyle: 'bar', scrollSpeed: 3, padGain: 3 }, p);
  merged.fontFamily = withKR(merged.fontFamily);
  return merged;
}
function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* noop */ } }
function applyChrome(themeKey) {
  const t = THEMES[themeKey] || THEMES.dark;
  document.documentElement.dataset.theme = t.dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--term-bg', t.theme.background);
}

// ── API 베이스(#1091·#1169 를 이 페이지에도) — 프리뷰 서브패스(/preview/<id>/)에서 뜬 화면은 API 도 그 프리뷰로 가야 한다. ──
//  SPA(web/core.ts)는 이미 이렇게 하는데 이 페이지(클래식 스크립트)엔 없어서, 프리뷰로 웹터미널을 열면
//  **새 프론트 + 라이브(구) 백엔드** 조합이 됐다 — 새 API 를 쓰는 기능이 프리뷰에서 조용히 옛 동작으로 보였다
//  (#1059 딥링크 자동 복원이 프리뷰에서 '종료됨' 배너로 뜬 실제 원인). 화면이 놓인 경로에서 접두사를 유도한다.
export const API_PREFIX = (() => {
  const m = /^(\/preview\/[A-Za-z0-9][A-Za-z0-9._-]*)\//.exec(location.pathname);
  return m ? m[1] : '';
})();
// 루트 절대경로만 접두사를 받는다(상대·절대URL 은 그대로). fetch 와 내비게이션 둘 다 같은 규칙.
export const apiUrl = (path) => (API_PREFIX && String(path).charAt(0) === '/' ? API_PREFIX + path : path);
// ⚠ WS(/terminal/ws)에는 붙이지 않는다 — PTY 세션 실체는 게이트웨이 본체에 있고 프리뷰 라우트는 upgrade 를
//  처리하지 않는다(#1169 와 같은 판단). 그래서 프리뷰에서도 4410 은 본체에서 정상적으로 온다.

function authHeaders(extra) {
  const t = localStorage.getItem(TOKEN_KEY);
  return Object.assign({}, extra, t ? { Authorization: 'Bearer ' + t } : {});
}
// opts.mainOrigin=true 면 프리뷰 접두사를 붙이지 않고 **게이트웨이 본체**로 보낸다 — WS 와 짝이어야 하는 요청(티켓)용.
//  붙이면 티켓은 프리뷰 자식에 발급되는데 WS 는 본체로 붙어(아래 주석) 본체가 그 티켓을 몰라 계속 재연결한다(실측).
async function api(path, opts: any = {}) {
  const headers = authHeaders(opts.headers);
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(opts.mainOrigin ? path : apiUrl(path), Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || ('요청 실패 ' + res.status));
  return data;
}
function fetchAuth(path, opts: any = {}) { return fetch(apiUrl(path), Object.assign({}, opts, { headers: authHeaders(opts.headers) })); }
const sUrl = (suffix) => '/api/ui/terminal/sessions/' + encodeURIComponent(SESSION_ID) + suffix + nodeQ(suffix.indexOf('?') >= 0 ? '&' : '?');

function toast(msg, isErr?) {
  const t = el('div', { text: msg, style: 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:' + (isErr ? '#c0392b' : '#333') + ';color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:100;box-shadow:0 4px 16px rgba(0,0,0,.3)' });
  document.body.append(t); setTimeout(() => t.remove(), 2800);
}

// ── 상태 ──
let term, fit, ws, statusEl, explorerEl, tabbarEl, panesEl, termPane, titleEl, projectBtnEl;

// ⚠ 테스트 주입 전용(#1313 R51) — 종전 vm 하네스는 이 파일을 클래식 스크립트로 평가해 전역 슬롯(term/ws/…)에
//  스텁을 직접 꽂았다. ESM 은 밖에서 import 바인딩을 재할당할 수 없어, 그 주입을 세터로 대신한다.
//  브라우저 실행 경로는 종전과 동일하게 boot()/connectNow() 가 채운다(여기서 값을 만들지 않는다).
export function __injectRefsForTest(refs: Record<string, any>): void {
  if ('term' in refs) term = refs.term;
  if ('ws' in refs) ws = refs.ws;
  if ('statusEl' in refs) statusEl = refs.statusEl;
  if ('panesEl' in refs) panesEl = refs.panesEl;
}
let curDir = '';
let sessionProjectId = 0; // 프로젝트 세션이면 그 id(loadSessionMeta 가 채움) — 업로드 위치를 뭐라 부를지 가른다(#1235)
const tabs = []; // { id, label, pane, closable }
let activeId = 'term';

let lastCols = 0, lastRows = 0, resizeTimer = null, didInitialFit = false;
let scrollSpeed = 1; // 마우스 휠 배수(환경설정 prefs.scrollSpeed) — 이산 노치 입력에만 적용
let padGain = 3;     // 트랙패드 배수(환경설정 prefs.padGain) — 연속 픽셀 입력에 적용. 1 = 손가락 이동 1:1.
                     //  기본 3 = 마우스 휠 속도 3 과 같은 증폭(실측 재생: 2.96배 vs 2.94배)이 되는 값 — 이게 두 입력의 '단위 맞춤' 지점(#1168)
let shiftEnterPending = false; // Shift+Enter → 이 keydown 이 곧 낼 '\r'(onData)을 '\x1b\r'(줄바꿈)로 승격하는 1회성 플래그

// ── 입력 진단 링버퍼(#1117) ──
// 이 터미널의 입력 버그류는 '간헐 + 환경(OS/브라우저)별 + 재현 불가'가 특징이라(키만 눌러도 특정 문자열 입력,
//  붙여넣기 오염, 사파리 복사 불능…) 제보 시점엔 이미 증거가 사라져 있었다. 그래서 입력 경로의 사건(키다운
//  특수분기·IME 조합·붙여넣기·복사 시도/결과·OSC52·textarea 위생 청소·pane 상태동기·ws 개폐)을 링버퍼로
//  상시 기록하고, 사용법 안내 ▸ [입력 진단 복사]로 사용자가 직접 복사해 제보에 붙인다. 서버 전송은 없다(프라이버시
//  — 내용 미리보기는 diagPreview 로 짧게 자른다). 콘솔에선 livelyTermDiag() 로 열람.
const DIAG_MAX = 400;
const diagBuf = [];
function diagPreview(s, n?) {
  return String(s).slice(0, n || 48).replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}
function dlog(kind, info?) {
  try {
    diagBuf.push(new Date().toISOString().slice(11, 23) + ' ' + kind + (info ? ' ' + info : ''));
    if (diagBuf.length > DIAG_MAX) diagBuf.splice(0, diagBuf.length - DIAG_MAX);
  } catch (_) { /* noop */ }
}
function diagText() {
  return ['# 웹터미널 입력 진단 (#1117) · build ' + TERMJS_BUILD, 'ua: ' + navigator.userAgent, 'session: ' + SESSION_ID + (NODE_ID ? ' node=' + NODE_ID : ''),
    'secure: ' + window.isSecureContext + ' · exported: ' + new Date().toISOString(), ''].concat(diagBuf).join('\n');
}
window.livelyTermDiag = () => diagText();
// 사파리 판별 — 클립보드 정책이 크롬과 다르다(제스처 밖·비동기 쓰기 거부 → 복사 경로가 갈린다, #1117 버그C).
const IS_SAFARI = /Apple/i.test(navigator.vendor || '') && !/CriOS|FxiOS|Chrome|Chromium|Edg/i.test(navigator.userAgent || '');
let imeComposing = false;  // setupTextareaHygiene 이 관리 — IME 조합 중엔 textarea 를 절대 건드리지 않는다(#633 교훈)
let appDragSelect = false; // 앱(마우스모드) 화면에서 '드래그 선택'이 관측된 상태 — Cmd+C→^C 브리지 발동 조건(#1117 버그C)

// ── tmux control-mode 파서 ──
// 서버가 `tmux -CC` 로 붙으면 스트림은 화면 그림이 아니라 텍스트 프로토콜이다:
//  `\x1bP1000p` 도입자 → CRLF 줄 단위로 %output / %begin..%end / 각종 %알림.
//  %output %<pane> <value> : value 는 비출력문자·백슬래시를 8진(\ooo)으로 이스케이프 → 바이트 복원해 xterm 에 write.
//  %begin <t> <num> <flags> … %end/%error(같은 num) = 명령 응답 블록. 내용 있는 블록은 둘: ① capture-pane 백필,
//   ② pane 실상태(STATE_MARKER 로 시작, 아래 참조 — 화면에 안 쓰고 상태 동기화로 라우팅). send-keys/refresh-client 는 빈 응답.
// 옛 방식(plain attach)도 같은 코드로 받게: 도입자가 없으면 raw 모드로 자동 폴백(그대로 term.write).
const DCS_BYTES = [0x1b, 0x50, 0x31, 0x30, 0x30, 0x30, 0x70]; // 도입자 \x1bP1000p (바이트)
const BACKFILL_LINES = 600; // 첫 연결 시 capture-pane 로 회수할 히스토리 줄 수(현재 화면+모듈러 스크롤백 복원)
// 서버가 백필 '직전'에 보내는 pane 실상태 블록의 마커(= src/terminal-pty.ts stateCmd 과 일치). capture-pane 백필은
//  화면 텍스트만 담고 DECSET(alt-screen·마우스모드)·커서위치는 못 담아 클라가 '추측'할 수밖에 없다 → 마우스 stuck·
//  커서 어긋남의 근원. 이 마커로 시작하는 블록은 화면에 쓰지 않고 상태 동기화로 라우팅한다(applyPaneState).
const STATE_MARKER = '__LTSTATE__';
// control-mode 파서는 '바이트 레벨'로 동작한다(서버가 raw 바이너리로 보냄). 이유: tmux 는 멀티바이트 UTF-8
//  문자를 %output 알림 '경계'에서 쪼갤 수 있는데(문자의 앞바이트가 한 %output 끝, 뒷바이트가 다음 %output
//  시작 — 사이에 `\n%output %<pane> ` 프레이밍이 끼어듦), 스트림을 문자열로 먼저 디코드하면 그 자리가 깨진다(�).
//  → %output 의 '값 바이트'만 모아 streaming UTF-8 디코더(경계의 partial 바이트를 버퍼링)로 디코드해 재조립한다.
function makeControl(opts) {
  // opts: { write(string), backfill(string), onExit() }
  let mode = null;                  // null=미정, 'control', 'raw'
  let pending = new Uint8Array(0);  // 부분 줄/도입자 판별용 바이트 잔여
  let inBlock = false, blockNum = '', blockParts = [];
  const outDec = new TextDecoder('utf-8'); // 라이브 %output 전용 — stream:true 로 %output 경계 분할 재조립
  const rawDec = new TextDecoder('utf-8'); // legacy raw 모드 전용 streaming 디코더
  const ascii = (b, s, e) => { let r = ''; for (let i = s; i < e; i++) r += String.fromCharCode(b[i]); return r; };
  function append(chunk) {
    if (pending.length === 0) { pending = chunk; return; }
    const c = new Uint8Array(pending.length + chunk.length); c.set(pending); c.set(chunk, pending.length); pending = c;
  }
  // 값 바이트의 \ooo(8진) → raw 바이트로 복원(리터럴 바이트는 그대로). ASCII 전용 연산이라 경계 안전.
  function octalDecode(b, s, e) {
    const out = [];
    for (let i = s; i < e; i++) {
      if (b[i] === 0x5c) { // '\'
        let o = '', j = i + 1;
        while (j < e && o.length < 3 && b[j] >= 0x30 && b[j] <= 0x37) { o += String.fromCharCode(b[j]); j++; }
        if (o.length) { out.push(parseInt(o, 8) & 0xff); i = j - 1; continue; }
        out.push(0x5c);
      } else out.push(b[i]);
    }
    return new Uint8Array(out);
  }
  function handleLine(s, e0) { // pending[s,e0) — 줄(개행 제외). 끝 \r 제거.
    let e = e0; if (e > s && pending[e - 1] === 0x0d) e--;
    if (inBlock) {
      const head = ascii(pending, s, Math.min(e, s + 8));
      if ((head.startsWith('%end ') || head.startsWith('%error ')) && ascii(pending, s, e).split(' ')[2] === blockNum) {
        inBlock = false;
        // 블록(capture 백필) 내용 = 실제 ESC + 리터럴 멀티바이트(줄 안에선 안 쪼개짐). 줄 사이 구분자는
        //  `\e[0m\r\n`(SGR 리셋 + CRLF) — capture-pane -N 으로 보존한 줄 끝 배경색이 '다음 줄'로 새지 않게 한다.
        const SEP = [0x1b, 0x5b, 0x30, 0x6d, 0x0d, 0x0a]; // \e[0m\r\n
        let len = 0; for (const p of blockParts) len += p.length; len += Math.max(0, blockParts.length - 1) * SEP.length;
        const merged = new Uint8Array(len); let off = 0;
        for (let k = 0; k < blockParts.length; k++) { if (k) { for (let z = 0; z < SEP.length; z++) merged[off++] = SEP[z]; } merged.set(blockParts[k], off); off += blockParts[k].length; }
        blockParts = [];
        const text = new TextDecoder('utf-8').decode(merged);
        // 상태 블록(서버가 백필 직전에 보낸 pane 실상태) = 화면에 쓰지 않고 상태 동기화로 라우팅.
        if (text.startsWith(STATE_MARKER)) { if (opts.state) opts.state(text); return; }
        if (text.length) opts.backfill(text);
        return;
      }
      blockParts.push(pending.slice(s, e));
      return;
    }
    if (ascii(pending, s, Math.min(e, s + 8)) === '%output ') {
      let p = s + 8; while (p < e && pending[p] !== 0x20) p++;   // pane id 스킵
      const vstart = p + 1;
      if (vstart <= e) { const str = outDec.decode(octalDecode(pending, vstart, e), { stream: true }); if (str) opts.write(str); }
      return;
    }
    const head = ascii(pending, s, Math.min(e, s + 18));
    if (head.startsWith('%begin ')) { inBlock = true; blockNum = ascii(pending, s, e).split(' ')[2] || ''; blockParts = []; }
    else if (head.startsWith('%extended-output ')) {            // pause-after 형태: `... : <value>`
      const full = ascii(pending, s, Math.min(e, s + 200)); const mk = full.indexOf(' : ');
      if (mk >= 0) { const str = outDec.decode(octalDecode(pending, s + mk + 3, e), { stream: true }); if (str) opts.write(str); }
    }
    else if (head.startsWith('%exit')) opts.onExit();
    // 그 외 %session-changed/%window-*/%layout-change … 알림 무시
  }
  function processLines() {
    let start = 0;
    for (let i = 0; i < pending.length; i++) if (pending[i] === 0x0a) { handleLine(start, i); start = i + 1; }
    pending = start ? pending.slice(start) : pending;
  }
  function feed(bytes) { // Uint8Array
    if (mode === 'raw') { const s = rawDec.decode(bytes, { stream: true }); if (s) opts.write(s); return; }
    append(bytes);
    if (mode === null) {
      const n = Math.min(pending.length, DCS_BYTES.length);
      for (let i = 0; i < n; i++) if (pending[i] !== DCS_BYTES[i]) { // 도입자 아님 → raw 폴백
        mode = 'raw'; const s = rawDec.decode(pending, { stream: true }); pending = new Uint8Array(0); if (s) opts.write(s); return;
      }
      if (pending.length < DCS_BYTES.length) return;  // 더 받아 판별
      mode = 'control'; pending = pending.slice(DCS_BYTES.length);
    }
    processLines();
  }
  return { feed, isControl: () => mode === 'control' };
}
let ctrl = null, didBackfill = false; // didBackfill: 페이지 로드 후 첫 control 연결만 백필(재연결 중복 방지)
let syncedThisConn = false;           // 이 연결에서 재접속 상태동기(t:'st')를 이미 보냈나(연결마다 1회)
// ── pane 실상태 동기화(#1092) ──
// 서버가 백필 직전에 보낸 `__LTSTATE__ alt=.. any=.. btn=.. std=.. sgr=.. cx=.. cy=..` 한 줄을 파싱한다.
//  capture 텍스트엔 없는 '앱의 진짜 상태'(tmux 가 아는) — 클라 xterm 을 이 진실에 맞춰 alt-screen·마우스모드·
//  커서를 동기화한다(추측이 아니라). 다음 백필의 커서 복원용으로 pendingPaneState 에 담아둔다.
// ⚠ 불변식(반드시 유지): capture(백필)를 트리거하는 모든 곳은 `{t:'cap', …, st:1}` 로 보내야 한다 — 그래야 서버가
//  상태 블록을 capture '바로 앞'에 실어 pendingPaneState 가 그 백필의 실커서로 갱신된 뒤 소비된다. 만약 st:1 없이
//  cap 을 보내면(옛 서버로의 degrade 는 예외 — 그땐 상태 자체가 안 옴), state-only(t:'st')가 남긴 stale 커서가
//  엉뚱한 백필에 적용돼 이 버그(커서 desync)가 재발한다. 새 cap 송신부를 추가하면 st:1 을 반드시 함께.
let pendingPaneState = null, lastStateAt = 0, lastMouseResetAt = 0, lastMouseProbeAt = 0, mouseResetTries = 0;
function parsePaneState(line) {
  const m: any = {};
  for (const tok of String(line).trim().split(/\s+/)) { const i = tok.indexOf('='); if (i > 0) m[tok.slice(0, i)] = tok.slice(i + 1); }
  const num = (k) => { const n = parseInt(m[k], 10); return Number.isFinite(n) ? n : null; };
  const any = num('any'), btn = num('btn'), std = num('std'), sgr = num('sgr'), cx = num('cx'), cy = num('cy');
  return {
    alt: num('alt') === 1,
    mouseOn: any === 1 || btn === 1 || std === 1,   // 1003/1002/1000 중 하나라도 = tmux flag 상 마우스 리포트 요구
    any: any === 1, btn: btn === 1, std: std === 1, sgr: sgr === 1,
    cmd: m.cmd || '',                               // foreground 프로세스 — flag 가 stale 인지 가리는 단서(paneMouseMode)
    cx, cy, hasCursor: cx !== null && cy !== null,
  };
}
// 클라 xterm 이 가져야 할 마우스 트래킹 모드를 tmux pane 상태에서 낸다 — 순수 함수(전역 의존 없음).
// ⚠ tmux flag 를 그대로 믿으면 안 된다: tmux 는 앱이 켠 마우스모드를 **앱이 죽어도 영원히 안 지운다**(실측 —
//  하드킬·미reset 로 셸에 돌아온 뒤에도 mouse_any_flag=1 이 clear/명령실행에도 유지). 그 상태를 그대로 되살리면
//  앱 없는 셸 프롬프트에 마우스 이동마다 리포트가 주입돼 `;EB1` 류 garbage 가 쏟아지고, 붙을 때마다 되살아나므로
//  **새로고침해도 안 풀린다**(#1092 수정이 '추측 제거'와 함께 들여온 새 실패면 — 그 전엔 새로고침이 해결책이었다).
//  판별: 셸은 마우스 트래킹을 켜는 일이 없다 → foreground 가 셸이면 그 flag 는 죽은 앱의 잔재다.
//  (alt-screen 여부로는 못 가른다 — 하드킬은 alt=1 도 같이 남기고, fzf --height 처럼 normal 화면에서 마우스를
//   쓰는 앱도 있다. foreground 명령이 훨씬 정확한 축이다.)
//  cmd 가 비면(구 서버 — 마커에 cmd 없음) 게이팅하지 않고 옛 동작으로 degrade 한다.
export function paneMouseMode(st) {
  if (!st || !(st.any || st.btn || st.std)) return 'none';
  const cmd = String(st.cmd || '').replace(/^-/, '').replace(/^.*\//, '').toLowerCase();
  if (cmd && ['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'ash'].indexOf(cmd) >= 0) return 'none';
  return st.any ? 'any' : st.btn ? 'drag' : 'vt200';  // 1003 > 1002 > 1000 (상위모드 우선)
}
// xterm 이 내보낸 데이터가 마우스 리포트인가 — SGR(1006) `\e[<b;x;yM|m` · urxvt(1015) `\e[b;x;yM` · X10 `\e[M`+3바이트.
//  순수 함수(전역 의존 없음). 드리프트 가드에서만 쓴다.
export function isMouseReport(d) { return /^\x1b\[(<[0-9;]+[Mm]|[0-9;]+M|M)/.test(String(d || '')); }
// 클라 xterm 상태를 tmux pane 실상태에 맞춘다. 모든 쓰기는 '실제 불일치일 때만'(가드) — 일치하면 no-op.
export function applyPaneState(st) {
  if (!term || !st) return;
  pendingPaneState = st; // 바로 뒤따르는 백필의 커서 복원용
  lastStateAt = Date.now();
  // alt-screen 동기화 — 추측(옛 #252)이 아니라 tmux 실상태로. 앱 alt인데 클라 normal → 진입(#252 재접속 보정),
  //  앱 normal인데 클라 alt(stuck) → 복귀(프롬프트/입력 위·아래 어긋남 = 버그2 계열의 한 원인).
  try {
    const isAlt = !!(term.buffer && term.buffer.active && term.buffer.active.type === 'alternate');
    if (st.alt && !isAlt) term.write('\x1b[?1049h');
    else if (!st.alt && isAlt) term.write('\x1b[?1049l');
  } catch (_) { /* noop */ }
  // 마우스모드 동기화 — 앱이 mouse-off 했는데(재접속 갭에 1003l 놓침) 클라가 ON으로 굳으면 마우스 이동마다 셸에
  //  SGR 리포트가 주입돼 `;EB1` 류 garbage(버그1). tmux 실상태의 '트래킹 모드'(any>drag>std 우선)로 정확히 맞춘다 —
  //  단순 on↔off 뿐 아니라 '서브모드 불일치'(예: 클라 drag인데 앱 any)까지 교정하고, 이미 같은 모드면 no-op(flicker 없음).
  //  단, tmux flag 가 stale(앱은 죽었는데 플래그만 남음)이면 되살리지 않고 끈다 — paneMouseMode 참조.
  try {
    let xtMode = 'none';
    try { xtMode = (term.modes && term.modes.mouseTrackingMode) || 'none'; } catch (_) { /* noop */ }
    const xtOn = xtMode !== 'none';
    const wantMode = paneMouseMode(st);
    // tmux 는 마우스 ON 이라는데 그 pane 에 앱이 없다 = 죽은 앱이 남긴 flag. 이 클라만 안 켜고 끝내면 tmux 의 잘못된
    //  진실은 그대로라 다른 클라·실 터미널 attach 는 계속 flood 를 받는다 → 서버에 pane 상태 복구를 요청한다(스로틀).
    if (st.mouseOn && wantMode === 'none') requestMouseReset();
    if (wantMode === 'none') {
      if (xtOn) term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l'); // 앱 off → 전 모드 해제
    } else if (wantMode !== xtMode) {
      // 앱이 원하는 모드로 정확히 맞춘다(꺼져있었거나 다른 서브모드였거나). 다른 트래킹이 켜져있었으면 먼저 정리.
      let seq = xtOn ? '\x1b[?1000l\x1b[?1002l\x1b[?1003l' : '';
      if (st.std) seq += '\x1b[?1000h';
      if (st.btn) seq += '\x1b[?1002h';
      if (st.any) seq += '\x1b[?1003h';
      if (st.sgr) seq += '\x1b[?1006h';
      term.write(seq);
    }
  } catch (_) { /* noop */ }
}
// stale 마우스모드를 tmux 쪽에서 지워달라고 요청한다(서버가 pane tty 에 DECRST → 고쳐진 상태를 되돌려줌).
//  스로틀 + 횟수 상한: 복구가 안 먹는 환경(권한 등)에서 상태 블록마다 재요청하면 세션마다 영구 백그라운드 루프가
//  된다(탭 수 × 세션 수만큼). 못 고쳐도 이 클라의 마우스는 이미 꺼져 있어(paneMouseMode) garbage 는 안 나므로,
//  몇 번 시도하고 포기해도 사용자가 보는 증상은 그대로 해결된 상태다.
function requestMouseReset() {
  const now = Date.now();
  if (mouseResetTries >= 3 || now - lastMouseResetAt < 10000) return;
  lastMouseResetAt = now; mouseResetTries++;
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'mr' })); } catch (_) { /* noop */ } }
}
// fit 후 '크기가 실제로 바뀐 경우에만' pty resize 전송 — 불필요한 SIGWINCH(→ 쉘 프롬프트 재출력이
//  tmux 히스토리에 중복으로 쌓이는 원인) 제거.
function applyFit() {
  if (!fit || !term) return;
  try { fit.fit(); } catch (_) { /* noop */ }
  if (ws && ws.readyState === 1 && (term.cols !== lastCols || term.rows !== lastRows)) {
    lastCols = term.cols; lastRows = term.rows;
    try { ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); } catch (_) { /* noop */ }
  }
}
// 창 드래그 중 리사이즈 폭주 방지 — 디바운스.
function doResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyFit, 130); }
// '화면 복구' 버튼 — fit + 크기 재전송 후, control mode 면 tmux 에서 화면을 다시 '캡처'해 깨끗이 복원한다.
//  (term.refresh 만으로는 이미 깨지거나 중복된 xterm 버퍼를 그대로 다시 그릴 뿐 → 리사이즈로 깨진 화면·이력
//   중복이 안 풀린다. capture-pane 백필은 clear + 현재 화면 재수신이라 그 상태를 실제로 복원한다.)
function forceRedraw() {
  if (!fit || !term) return;
  try { fit.fit(); } catch (_) { /* noop */ }
  if (ws && ws.readyState === 1) {
    lastCols = term.cols; lastRows = term.rows;
    try { ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); } catch (_) { /* noop */ }
    if (ctrl && ctrl.isControl()) { try { ws.send(JSON.stringify({ t: 'cap', n: BACKFILL_LINES, st: 1 })); } catch (_) { /* noop */ } } // 깨끗이 재캡처(+상태 동기화)
  }
  try { term.refresh(0, term.rows - 1); } catch (_) { /* noop */ }
}
// '화면 복구' 버튼(소프트 새로고침). forceRedraw(=fit+재캡처)는 '내용만' 다시 그려 깊은 클라 상태
//  (예: 재접속 시 alt-screen 누락, 렌더러 꼬임)는 못 고쳤다(페이지 새로고침으로만 풀리던 이유). 그래서
//  버튼은 ws 를 끊고 '재연결'한다 → 새 파서로 onopen 의 fit·크기재전송·백필(alt-screen 보정 포함)·재렌더를
//  다시 수행해 페이지 새로고침에 준하는 복구를 한다(이미 검증된 자동재연결 경로 재사용, tmux 세션은 영속).
function softReconnect() {
  if (sessionEnded) return;      // 종료된 세션엔 붙을 곳이 없다(#835) — 마지막 화면을 그대로 둔다
  try { if (fit && term) fit.fit(); } catch (_) { /* noop */ }
  didBackfill = false;           // 재연결 시 현재 화면 백필을 다시 받게
  reconnectDelay = 250;          // 즉시성 — onclose 자동재연결이 곧바로 붙도록 짧게
  if (ws && ws.readyState <= 1) { try { ws.close(); } catch (_) { /* noop */ } } // onclose → scheduleReconnect → connectNow
  else { connectNow(); }         // 이미 끊겨 있으면 바로 연결
  try { statusEl.textContent = '복구 중…'; statusEl.className = 'status'; } catch (_) { /* noop */ }
}
// 웹폰트(자체호스팅 D2Coding ~1.5MB·Google 라틴 글꼴)를 '명시적으로' 즉시 로드한다 — 새로고침 폰트
//  미적용의 근본 원인 차단. @font-face 는 '글리프가 실제로 그려질 때' lazy 로드되므로, 첫 진입처럼
//  한글이 아직 출력되기 전엔 D2Coding 다운로드가 시작조차 안 된다 → 이때 document.fonts.ready 는
//  '로드 중인 폰트 없음'으로 즉시 resolve 해버려(조기 resolve 함정) 폴백 글꼴 측정값이 굳는다. 그래서
//  document.fonts.load 로 한글 샘플과 함께 다운로드를 직접 트리거하고, 그 promise 가 '실제로' 끝난
//  시점을 잡아 재측정한다. (memo: 인자 없을 때 1회만 — 부팅 시 호출로 다운로드를 WS 와 병렬 시작.)
let fontReadyPromise = null;
function loadTermFonts(family?) {
  if (!(document.fonts && document.fonts.load)) return Promise.resolve();
  if (!family && fontReadyPromise) return fontReadyPromise;
  const sz = (term && term.options.fontSize) || 14;
  const fam = String(family || (term && term.options.fontFamily) || '');
  // 한글은 항상 D2Coding(폴백)에 의존 → 정자/볼드 둘 다 한글 샘플로 로드.
  const want = [['가힣글꼴', "'D2Coding'"], ['가힣글꼴', "bold 'D2Coding'"]];
  // 선택된 패밀리의 첫 라틴 글꼴도 같은 race 를 탄다 — 라틴 샘플로 함께 로드(monospace 등 시스템 키워드 제외).
  try {
    const first = fam.split(',')[0].trim();
    if (first && !/D2Coding/i.test(first) && !/^(ui-)?monospace$/i.test(first)) {
      want.push(['AaWgMm0', first], ['AaWgMm0', 'bold ' + first]);
    }
  } catch (_) { /* noop */ }
  const pr = Promise.all(want.map(([t, f]) => document.fonts.load(f.replace(/^(bold )?/, '$1' + sz + 'px '), t).catch(() => null)));
  if (!family) fontReadyPromise = pr;
  return pr;
}
// 폰트가 '실제로' 준비된 시점에 글자 셀 폭을 재측정한다 — fontSize 를 +1 했다 즉시 되돌려, xterm 의
//  CharSizeService 재측정 + 렌더러 글리프 아틀라스 재생성을 유발한다(환경설정에서 크기 바꿨다 되돌리면
//  정상화되는 것과 동일 원리). fit/refresh 만으로는 자간(특히 한글 더블폭 셀)이 폰트 로드 전 측정값으로
//  굳는 게 안 풀린다. 같은 값 재설정은 xterm 이 무변동으로 건너뛰므로 반드시 다른 값(+1)을 한 번 거친다.
function remeasureAfterFonts(family?) {
  const run = () => {
    try { const fs = term.options.fontSize; term.options.fontSize = fs + 1; term.options.fontSize = fs; } catch (_) { /* noop */ }
    try { requestAnimationFrame(forceRedraw); } catch (_) { forceRedraw(); } // 셀 px 변동 → grid 재맞춤·pty 재전송·재렌더
  };
  loadTermFonts(family)
    .then(() => (document.fonts && document.fonts.ready) || null) // 추가 안전망(레이아웃 settle)
    .then(() => setTimeout(run, 30))
    .catch(() => setTimeout(run, 120));
}
// 첫 진입 시 화면이 창에 안 맞게 그려지는 문제 해소 — 마운트 직후 applyFit 은 웹폰트 로드 전에 셀 크기를
//  재 cols/rows 가 어긋날 수 있다. 그래서 '폰트 실제 준비 + 소켓 open' 이후 자동 1회 재측정·재그림. 가드로 1회만.
function initialSettleRedraw() {
  if (didInitialFit) return;
  didInitialFit = true;
  remeasureAfterFonts();
}

function loadRenderer() {
  try {
    if (window.WebglAddon && window.WebglAddon.WebglAddon) {
      const w = new WebglAddon.WebglAddon();
      w.onContextLoss(() => { try { w.dispose(); } catch (_) { /* noop */ } try { if (window.CanvasAddon) term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (__) { /* DOM */ } });
      term.loadAddon(w);
      return;
    }
  } catch (_) { /* webgl 불가 → canvas */ }
  try { if (window.CanvasAddon && window.CanvasAddon.CanvasAddon) term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (_) { /* DOM 폴백 */ }
}

// 복사/붙여넣기 — Ctrl/Cmd+C(선택 있으면 복사, 없으면 SIGINT 통과) · Ctrl/Cmd+V(붙여넣기).
//  http(비보안 origin)에선 navigator.clipboard 가 없어 execCommand 폴백, 붙여넣기는 네이티브 paste 이벤트로 흘림.
function execCopy(text) {
  let ok = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    ok = !!document.execCommand('copy'); document.body.removeChild(ta);
  } catch (_) { /* noop */ }
  try { term.focus(); } catch (_) { /* noop */ }
  return ok;
}
// 동기 복사(#1117 버그C) — '사용자 제스처 핸들러 안'에서만 유효. 일회용 copy 리스너로 원하는 텍스트를 실어
//  execCommand('copy')로 그 자리에서 커밋한다: 권한 프롬프트·secure-context 요구·비동기 제스처 만료가 전부 없어
//  사파리 포함 모든 브라우저에서 동작하는 가장 호환적인 경로다(포커스도 안 건드림 — execCopy 와 달리 무부작용).
//  stopImmediatePropagation: xterm 의 element 'copy' 리스너가 자기 선택 텍스트로 clipboardData 를 되덮지 못하게.
function copySyncViaEvent(text) {
  let ok = false;
  const fill = (e) => {
    try { e.clipboardData.setData('text/plain', text); e.preventDefault(); e.stopImmediatePropagation(); ok = true; } catch (_) { /* noop */ }
  };
  try {
    document.addEventListener('copy', fill, true);
    document.execCommand('copy');
  } catch (_) { /* noop */ }
  document.removeEventListener('copy', fill, true);
  return ok;
}
// 제스처 밖(OSC52 등)에서 쓰기가 거부된 텍스트 — 다음 사용자 제스처(키/마우스)에서 동기 플러시한다(사파리 폴백).
//  플러시는 포커스를 안 건드리는 copySyncViaEvent 만 쓴다(임시 textarea 방식은 진행 중인 키 입력을 삼킬 수 있다).
let pendingCopy = null;
function stashPendingCopy(text) { pendingCopy = text; dlog('copy-stash', 'len=' + text.length); }
function flushPendingCopy(ev) {
  if (!pendingCopy) return;
  // ⚠ IME 조합을 절대 건드리지 않는다 — 조합 중 keydown 에서 execCommand/클립보드 조작이 돌면 사파리가
  //  조합을 그 자리에서 중단시켜 음절이 첫 자모만 커밋된다("안녕하" → "ㅇㄴㅎ", #1117 사파리 실기기 실측).
  //  조합이 아닌 다음 제스처(스페이스·클릭 등)에서 플러시해도 늦지 않다.
  if (imeComposing || (ev && (ev.isComposing || ev.keyCode === 229))) return;
  const t = pendingCopy;
  pendingCopy = null; // 재시도 폭주 금지 — 이 제스처에서 아래 두 경로로 끝낸다(매 키마다 되풀이하며 입력을 방해했던 회귀의 원인)
  if (copySyncViaEvent(t)) { dlog('copy-flush-ok', 'sync len=' + t.length); return; }
  // 여기는 '진짜 사용자 제스처 핸들러 안'이라 사파리도 writeText 를 허용한다 — 동기 경로가 안 통하면 이걸로 1회.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(() => dlog('copy-flush-ok', 'api len=' + t.length), () => dlog('copy-flush-fail'));
  } else dlog('copy-flush-fail');
}
document.addEventListener('keydown', flushPendingCopy, true);
document.addEventListener('mousedown', flushPendingCopy, true);
// 복사 진입점. gesture=true 는 '사용자 제스처 핸들러 안'(키다운·클릭) 호출 표시 — 동기 경로를 1순위로 쓴다.
//  ⚠ 순서가 수정의 핵심(#1117 버그C): 예전엔 writeText(비동기) 먼저 → 실패 시 execCommand 폴백이었는데, 사파리는
//  writeText 를 제스처 밖/비동기로 판정해 거부하고, 그 rejection 이 돌아올 땐 제스처가 만료돼 폴백도 죽었다
//  → '사파리에선 복사가 아예 안 됨'(비나 제보). 제스처 안에서는 동기 경로부터, 비동기 API 는 마지막 폴백.
export function copyText(text, silent?, gesture?) {
  if (!text) return;
  // 동기 경로는 '명시적으로 제스처 핸들러 안'이라고 표시된 호출만 탄다. userActivation.isActive 추정은 쓰지
  //  않는다 — OSC52 가 최근 클릭/키의 활성화 창(수 초) 안에 도착하면 제스처 밖인데도 execCopy(임시 textarea
  //  포커스 이동)가 돌아 타이핑 중 IME 조합을 끊었다(#1117 사파리 한글 깨짐 회귀의 한 축).
  const inGesture = !!gesture;
  if (inGesture && copySyncViaEvent(text)) dlog('copy-ok', 'sync len=' + text.length);
  else if (inGesture && execCopy(text)) dlog('copy-ok', 'exec len=' + text.length);
  else if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(
      () => dlog('copy-ok', 'api len=' + text.length),
      () => { dlog('copy-fail', 'api len=' + text.length); stashPendingCopy(text); });
  } else if (!execCopy(text)) stashPendingCopy(text);
  if (!silent) toast('복사됨');
}
// 사파리 OSC52 사전 커밋(#1117 버그C): 사파리는 제스처 밖 클립보드 쓰기를 거부해 OSC52(앱 복사 신호) 자동 쓰기가
//  조용히 실패한다. 그래서 '복사 의도가 확실한 제스처'(마우스모드 앱 화면의 Ctrl/Cmd+C)에서 ClipboardItem 에
//  promise 를 실어 write 를 '먼저' 시작해 두고, 곧 도착할 OSC52 데이터로 resolve 한다(WebKit 이 공식 지원하는
//  비동기 복사 패턴). 시간 안에 안 오면 reject — 실패한 write 는 클립보드를 바꾸지 않는다. 크롬은 불필요(직접 쓰기 허용).
let osc52Resolve = null, osc52Timer = null;
function armClipboardPromise() {
  if (!IS_SAFARI || !window.ClipboardItem || !(navigator.clipboard && navigator.clipboard.write)) return;
  if (osc52Resolve) return; // 이미 대기 중 — 중복 커밋 금지
  try {
    const p: any = new Promise((res, rej) => {
      osc52Resolve = (t) => { res(new Blob([t], { type: 'text/plain' })); };
      osc52Timer = setTimeout(() => { osc52Resolve = null; rej(new Error('osc52-timeout')); }, 2000);
    });
    navigator.clipboard.write([new ClipboardItem({ 'text/plain': p })])
      .then(() => dlog('copy-ok', 'osc52-armed'), () => dlog('copy-arm-miss'));
    dlog('copy-arm');
  } catch (_) { osc52Resolve = null; }
}
// 선택 없는 Cmd+C 안내(브리지 미발동 시). 연타에 시끄럽지 않게 8초 rate-limit.
let copyHintAt = 0;
function copyHintToast() {
  if (Date.now() - copyHintAt < 8000) return;
  copyHintAt = Date.now();
  toast('복사할 선택이 없어요 — 드래그로 선택한 뒤 ⌘C (웹 선택은 Shift+드래그)');
}
// 앱(마우스모드) 화면의 '드래그 선택' 관측(#1117 버그C) — xterm 이 앱으로 보내는 SGR 마우스 리포트(onData 로
//  나가는 \e[<b;x;y M/m)를 읽어 누름(버튼 0~2) → 눌린 채 이동 → 뗌 이면 앱에 선택이 생겼다고 본다. 제자리
//  클릭(이동 없이 뗌)이나 일반 키보드 입력이 오면 해제 — Claude 는 클릭·타이핑에 선택을 잃는다. 휠(64+)과
//  호버 이동(버튼비트 3)은 선택 상태와 무관. ESC 로 시작하는 onData(방향키 등)는 선택을 건드리지 않는다.
let dragPress = null, dragMoved = false;
function trackAppMouse(d) {
  if (!(d.charCodeAt(0) === 0x1b && d.charCodeAt(1) === 0x5b && d.charCodeAt(2) === 0x3c)) { // '\e[<' 아님
    if (d.charCodeAt(0) !== 0x1b) appDragSelect = false; // 일반 타이핑/IME — 앱 선택 해제로 간주
    return;
  }
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m;
  while ((m = re.exec(d))) {
    const b = Number(m[1]) & ~(4 | 8 | 16); // Shift/Meta/Ctrl 수정자 비트 제거
    const isUp = m[4] === 'm';
    if (b >= 64) continue;                                    // 휠 — 선택과 무관
    if (b >= 32) { if (!isUp && (b & 3) !== 3 && dragPress) dragMoved = true; continue; } // 눌린 채 이동(호버 3 제외)
    if (!isUp) { dragPress = m[2] + ',' + m[3]; dragMoved = false; }
    else {
      appDragSelect = !!(dragPress && (dragMoved || dragPress !== (m[2] + ',' + m[3])));
      if (appDragSelect) dlog('app-drag-select');
      dragPress = null; dragMoved = false;
    }
  }
}
// 동일 청크 반복 전송 워치독(#1117 버그A) — '어떤 키를 눌러도 같은 문자열이 입력'되는 병리 상태를 감지한다.
//  6자 이상 동일 데이터가 2초 안에 3회 연속 나가는 건 정상 타이핑·IME 로는 안 나오는 패턴 → 히든 textarea 를
//  청소해 그 자리에서 자가치유하고 진단에 남긴다. 전송 차단은 하지 않는다(오탐 시 정상 입력을 삼키지 않도록
//  보수적으로 — setupTextareaHygiene 이 원인 자체를 없애므로 이 워치독은 최후 안전망 + 관측 장치다).
let repChunk = '', repCount = 0, repAt = 0;
function spamGuard(d) {
  if (d.length < 6 || d.charCodeAt(0) === 0x1b) { repChunk = ''; repCount = 0; return; }
  if (d === repChunk && Date.now() - repAt < 2000) {
    if (++repCount >= 3) {
      repCount = 0;
      dlog('spam-detect', 'x3 ' + diagPreview(d));
      try { const ta = term.textarea; if (ta && !imeComposing && ta.value) { dlog('spam-clean', diagPreview(ta.value)); ta.value = ''; } } catch (_) { /* noop */ }
    }
  } else { repChunk = d; repCount = 1; }
  repAt = Date.now();
}
// ── 사파리 무(無)조합이벤트 IME 어댑터(#1300) ──
// 실측(사파리 26.3, 실기기 트레이스): 한글 입력 시 composition 이벤트가 '전혀' 발화되지 않는다. 첫 자모는
//  insertText(게다가 input 이 keydown 229 보다 먼저 도착), 이후 음절 조합은 insertReplacementText 로 textarea 를
//  직접 치환한다. xterm(5.5)의 IME 처리는 composition 이벤트에 전적으로 의존하고 input 은 insertText 만
//  (_keyDownSeen 레이스로 산발적으로) 처리하므로 — 완성 음절은 영영 전송되지 않고 첫 자모만 새어 나갔다
//  ("안녕하세요" → "ㅇㄴㅎ세요"). textarea 안에는 문장이 완벽하게 조합돼 있었다(전송 계층만 실패).
// 해법: xterm 이 듣지 않는 beforeinput 에서 음절 상태를 우리가 추적해 '즉시 에코'한다 — 네이티브 앱처럼
//  조합 과정이 실시간으로 보인다(사용자 피드백: 확정 시점 보류 방식은 표시가 너무 늦었다).
//  불변식 — 출력 스트림 = 사파리 IME 가 textarea 에 조합한 결과와 '키 단위로' 동일.
//  · 한글 단일문자 insertText → 즉시 전송 + 에코 추적(imeEcho).
//  · insertReplacementText(음절 치환: 아→안) → DEL(\x7f)+새 음절을 '한 메시지'로 전송(지우고 다시 쓰기 —
//    라인 편집기(CC 입력창·zsh·vim insert)는 DEL 을 문자 단위로 처리해 CJK 폭과 무관하게 정확). 빈 치환은 DEL 만.
//  · 비IME 키다운(Space/Enter 등) = IME 커밋 신호 → 에코 추적만 해제(이미 다 전송돼 있음 — 지연 0).
//    커밋 뒤 치환이 오는 비정상 순서엔 DEL 없이 새로 쓴다(엉뚱한 글자를 지우지 않게 방어적).
//  · xterm 이 같은 이벤트로 유출하는 자모는 이벤트 단위로 1회 삼킨다(imeSwallow — beforeinput 에서 예약,
//    우리 input 리스너(xterm 것보다 뒤에 등록됨)에서 해제 → 정상 반복 타이핑엔 절대 안 걸림).
//  · 진짜 composition 이벤트가 관측되면(imeComposing) 어댑터는 물러난다(구형 사파리 = xterm 경로 존중). 비사파리 미설치.
let imeEcho = '', imeEchoDone = '', imeSwallow = null;
const HANGUL_CH_RE = /^[ㄱ-ㆎ가-힣]$/; // 호환 자모 + 완성형 음절 1글자
const MODIFIER_KEYCODES = { 16: 1, 17: 1, 18: 1, 20: 1, 91: 1, 93: 1 }; // Shift·Ctrl·Alt·CapsLock·Meta — 자체로는 IME 커밋이 아니다
export function setupWebkitImeAdapter() {
  if (!IS_SAFARI) return;
  const ta = term.textarea;
  if (!ta) return;
  ta.addEventListener('beforeinput', (e) => {
    if (imeComposing) return; // 진짜 조합 이벤트가 있는 환경 — xterm 의 CompositionHelper 가 담당
    const t = (e && e.inputType) || '', d = (e && e.data) || '';
    if (t === 'insertReplacementText') {
      // 커밋 재확인 치환(#1300 후속): 사파리는 다른 키 입력 시 '마지막 음절을 같은 값으로 치환'하며 커밋한다
      //  (예: 안녕하세요 + Shift+1 → repl 요 → ins !). 이미 에코된 값과 같으면 보낼 게 없다 — 스킵하지 않으면
      //  키다운 리셋과 맞물려 DEL 없는 재전송이 되어 '마지막 글자 반복'(안녕하세요요!)이 난다(실기기 제보).
      if (d && d === imeEcho) { dlog('ime', 'repl=echo skip'); return; }
      if (d && !imeEcho && d === imeEchoDone) { imeEchoDone = ''; dlog('ime', 'repl=done skip'); return; } // 키다운 리셋 '직후' 도착한 커밋 치환(이벤트 순서 변형 방어)
      const seq = (imeEcho ? '\x7f' : '') + d;                   // 에코된 음절 지우고 새 상태로(커밋 후 새 내용이면 DEL 생략)
      if (seq) sendInput(seq);
      imeEcho = d;
      dlog('ime', 'repl ' + diagPreview(d, 8));
      return;
    }
    if (t === 'insertText' && d && (imeEcho || (d.length === 1 && HANGUL_CH_RE.test(d)))) {
      imeSwallow = d;                                            // xterm 의 산발 유출(같은 이벤트) 1회 삼킴 예약
      userTyped = true;                                          // #1059 — 어댑터 경로 타이핑도 사용자 입력이다
      sendInput(d);                                              // 즉시 에코 — 지연 없음
      imeEcho = (d.length === 1 && HANGUL_CH_RE.test(d)) ? d : ''; // 한글이면 이후 치환 대상, 비한글(숫자 등)은 불변
      imeEchoDone = '';                                          // 새 입력 시작 — 직전 커밋 기억은 무효
      appDragSelect = false;                                     // 타이핑 = 앱 선택 해제 — 이 경로는 handleTermData(trackAppMouse)를 안 지나므로 여기서(#1117 Cmd+C 게이팅과 정합)
      dlog('ime', 'echo ' + diagPreview(d, 8));
    }
  }, true);
  // xterm 의 input 리스너보다 '뒤'에 등록되므로, 이 시점이면 xterm 의 (있었다면) 유출 전송이 끝났다 — 삼킴 해제.
  ta.addEventListener('input', () => { imeSwallow = null; }, true);
}
// 키/IME/마우스 입력(xterm onData)의 단일 처리 본체 — boot 가 term.onData 에 '한 번만' 등록한다.
//  최상위 함수로 분리한 이유: 회귀 테스트(src/terminal-client-input.test.ts)가 실제 배선 그대로 직접 호출한다(#1117).
export function handleTermData(d) {
  userTyped = true;       // #1059 — 이 탭에서 입력이 있었다 = 세션이 죽으면 '내가 끝냈을 수 있다'(자동 복원 금지)
  // 사파리 IME 어댑터의 삼킴(#1300) — beforeinput 이 예약한 '그 이벤트의 xterm 유출' 1회만 걸러낸다.
  if (imeSwallow !== null && d === imeSwallow) { imeSwallow = null; dlog('ime', 'swallow ' + diagPreview(d, 8)); return; }
  // 실제 전송 바이트 트레이스(IME 트레이스와 짝) — 마우스 리포트는 제외(링버퍼 오염 방지).
  if (!(d.charCodeAt(0) === 0x1b && d.charCodeAt(1) === 0x5b && d.charCodeAt(2) === 0x3c)) dlog('out', diagPreview(d, 16));
  trackAppMouse(d);       // 앱 드래그 선택 관측(#1117 버그C — Cmd+C 브리지 발동 조건, 일반 타이핑 시 해제)
  spamGuard(d);           // 동일 청크 반복 전송 감지 → textarea 자가치유 + 진단(#1117 버그A 안전망)
  cancelPromptSeek(true); // 질문 위치 자동 탐색 중 사용자가 입력하면 즉시 중단(#967 — 사용자 조작 우선)
  // Shift+Enter 승격: 이 keydown 이 낸 '\r' 을 '\x1b\r'(Option+Enter 와 동일 = 줄바꿈)로 바꿔 보낸다. 음절 등 다른 데이터는 그대로.
  if (shiftEnterPending && d === '\r') { shiftEnterPending = false; d = '\x1b\r'; }
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } }
  // 드리프트 가드(#1302) — 붙어 있는 동안 앱이 죽으면(마우스 off 를 못 보내고) 클라는 다음 동기화(포커스·재연결)까지
  //  그 사실을 모른 채 리포트를 계속 흘린다. 리포트가 '실제로 나가는 순간'(=증상이 시작된 그 순간)에만, 그리고
  //  마지막 상태동기가 낡았을 때만 상태를 다시 물어 갭을 한 왕복으로 줄인다(정상 앱 사용 중엔 8초에 1회 이하).
  if (isMouseReport(d) && Date.now() - lastStateAt > 8000 && Date.now() - lastMouseProbeAt > 8000) {
    lastMouseProbeAt = Date.now();
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'st' })); } catch (_) { /* noop */ } }
  }
}
// 복사 경로는 셋 — ① 선택 후 Ctrl/Cmd+C (setupClipboard) ② '복사' 류 버튼 클릭 ③ 앱(Claude Code)의 OSC52 복사 신호.
//  · [#972] copy-on-select(드래그 놓는 즉시 자동복사, #252)는 되살리지 않는다 — 미세한 클릭드래그(4px)에도
//    클립보드가 덮여 "엄한 걸 눌렀는데 복사됐다"의 주범이라 #967 이 제거했다. 선택은 그대로 되고, 드래그로는
//    자동복사하지 않는다. 셸/Claude 모두 선택 후 Ctrl/Cmd+C 로 복사(Claude 마우스모드에선 Shift+드래그로 선택).
//  · [#972] OSC 52 = 앱(Claude Code 등)이 '이 텍스트를 클립보드에 넣어줘'라고 보내는 표준 신호. 웹터미널+tmux+ssh
//    너머라 그냥 두면 Claude 의 'copied N chars' 가 맥북 클립보드까지 안 닿는다(그 세션 tmux 버퍼엔 들어가도 다른
//    세션·로컬엔 못 붙임 — 사용자 신고 #972). #252 원본대로 디코드해 브라우저 클립보드에 **조용히**(토스트·배너 없이)
//    직접 쓴다 → Claude 네이티브 복사가 실동작. tmux set-clipboard 가 on|external 이면 OSC52 가 xterm 까지 통과(현재 external).
//    ⚠ #967 이 넣었던 '복사 확인 배너'는 되살리지 않는다 — 배너가 거슬렸던 게 #762 신고였다. OSC52 는 배너 없이 쓴다.
export function setupOscClipboard() {
  try {
    term.parser.registerOscHandler(52, (data) => {
      try {
        const i = data.indexOf(';');
        const b64 = i >= 0 ? data.slice(i + 1) : data;
        if (b64 && b64 !== '?') {
          let text = '';
          try { text = decodeURIComponent(escape(atob(b64))); } catch (_) { try { text = atob(b64); } catch (__) { text = ''; } }
          if (text) {
            dlog('osc52', 'len=' + text.length);
            // 사파리에서 Ctrl/Cmd+C 제스처가 promise 를 미리 커밋해 뒀으면(armClipboardPromise) 그걸 resolve —
            //  제스처 밖 writeText 거부를 우회해 앱 복사가 실제로 클립보드에 닿는다. 그 외(크롬 등)는 직접 쓴다.
            if (osc52Resolve) { const r = osc52Resolve; osc52Resolve = null; clearTimeout(osc52Timer); r(text); }
            else copyText(text, true); // 앱이 이미 'copied' 안내하므로 토스트는 생략
          }
        }
      } catch (_) { /* noop */ }
      return true; // 처리함(앱으로 다시 안 흘림)
    });
  } catch (_) { /* noop */ }
}
// 입력(키스트로크/시퀀스)을 PTY 로 전송 — onData 와 동일 경로(터미널로 흘러 안에서 도는 프로그램이 받음).
function sendInput(d) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } } }
// 붙여넣기 위생(#1117 버그B) — 클립보드가 어디서 왔든(타 터미널 화면·웹페이지·앱) '보이는 텍스트'만 넣는다.
//  · CR/CRLF/유니코드 줄구분자(U+2028/29) → \n 정규화 — 터미널에서 \r 은 Enter 로 해석돼 의도치 않은 '제출'이 된다.
//  · ESC 시퀀스(CSI/OSC/DCS/…)·C0 제어문자(탭·개행 제외)·C1 제거 — ① 화면캡처 유래 제어 바이트(커서이동·삭제·색)가
//    입력창에서 '유령 타이핑/지움'으로 재생되는 것(#1117 제보: 꺾쇠·지운 흔적이 붙여넣어짐)을 차단하고,
//    ② bracketed paste 조기 종료 주입(내용 속 \e[201~ 가 괄호를 닫아 나머지가 '타이핑=실행'되는 보안 구멍)을 막는다.
//  정상 텍스트(한글·이모지·탭·개행 포함)는 그대로 통과한다.
export function sanitizePasteText(t) {
  return String(t)
    .replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n')
    .replace(/\x1b\[[0-9:;?<=>!"'$#% ]*[@-~]/g, '')          // CSI (\e[ … 종결자)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')      // OSC (\e] … BEL/ST)
    .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, '')           // DCS/SOS/PM/APC (\eP|X|^|_ … ST)
    .replace(/\x1b[\s\S]?/g, '')                             // 남은 ESC(+후속 1글자)
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g, '');  // C0(탭 \x09·개행 \x0a 제외)·DEL·C1
}
// 텍스트 붙여넣기 — 여러 줄(줄바꿈 포함)은 bracketed paste(\e[200~ … \e[201~)로 감싸 한 덩어리로 전달한다.
//  그래야 안에서 도는 프로그램(클로드 코드·zsh/bash)이 중간 줄바꿈을 'Enter(전송)'로 오인하지 않는다.
//  tmux control mode 에선 inner 의 DECSET 2004 가 xterm 까지 안 와 term.paste 가 감싸지 못하므로 직접 감싼다.
export function pasteText(t) {
  if (!t) return;
  t = sanitizePasteText(t);
  if (!t) return;
  dlog('paste', 'len=' + t.length + (/\n/.test(t) ? ' multiline' : ''));
  if (/\n/.test(t)) sendInput('\x1b[200~' + t + '\x1b[201~');
  else sendInput(t);
}
// 자동 전송 — 프로젝트 '클로드로 실행'이 만든 세션이면, 부팅이 끝나 클로드가 입력을 받을 때 프롬프트를 1회 주입.
//  ?autosend=1 + localStorage 핸드오프(같은 브라우저). 재연결엔 재전송 안 함(autosendDone).
//  ⚠ 트리거는 '출력 1.6s 침묵/12s 하드캡'으로 '시작'하되, 그것만 믿고 blind Enter 하지 않는다 — 인증 MCP·SessionStart 훅이
//   부팅 중 '침묵 갭'을 만들거나 시작 다이얼로그(신뢰폴더 등)가 떠 있으면 붙여넣기+Enter 가 씹혀 태스크가 유실됐다.
//   그래서 붙여넣은 뒤 xterm 버퍼를 readback 해 '실제로 입력창에 들어갔는지' 확인될 때만 Enter 하고, 안 됐으면 재시도한다.
//  ?welcome=1 (따라하기 투어를 마치고 만든 첫 세션)이면 라이블리 사용법 안내를 자동으로 요청한다 — 프롬프트가 고정이라
//   localStorage 핸드오프가 필요 없고, 주입은 autosend 와 같은 경로(붙여넣기 → readback 확인 → Enter)를 그대로 탄다.
//   ⚠ 이 세션은 중앙 박스(서버)에서 돈다 — 로컬 환경(메모리·개인 스킬·MCP)이 없어 온보딩 스킬(로컬 스캔 전제)을 부르면 안 된다.
//   그래서 '온보딩'·'처음 시작' 등 그 스킬 트리거 문구를 빼고 처음부터 '사용법 안내'만 요청한다(#1030).
const WELCOME_PROMPT = '라이블리 사용법을 알려줘 — 라이블리가 어떤 도구이고 뭘 할 수 있는지, 그리고 맥락(지식·프로젝트·카테고리·도메인맵)을 어떻게 기록하고 불러오는지 핵심 흐름을 예시와 함께 보여줘. 마지막에 지금 바로 해볼 만한 걸 하나 제안해줘.';
let autosendIsWelcome = false;
const AUTOSEND = (() => {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('autosend')) {
      const k = 'lively:autosend:' + SESSION_ID;
      const v = localStorage.getItem(k) || '';
      if (v) localStorage.removeItem(k);
      return v;
    }
    if (q.get('welcome')) { autosendIsWelcome = true; return WELCOME_PROMPT; }
    return '';
  } catch (_) { return ''; }
})();
let autosendDone: any = false, autosendLastOut = 0, autosendDeadline = 0, autosendTimer = null;
const AUTOSEND_MAX_TRIES = 8; // 붙여넣기 재시도 상한(부팅 침묵 갭·다이얼로그가 걷힐 때까지 ~수 초 커버).
// 현재 뷰포트(입력박스가 있는 화면)를 문자열로 읽는다 — 붙여넣기가 실제로 입력창에 들어갔는지 확인(readback)용.
function autosendReadScreen() {
  try {
    const b = term.buffer.active;
    const rows = term.rows || 24;
    const out = [];
    for (let i = 0; i < rows; i++) { const ln = b.getLine(b.baseY + i); if (ln) out.push(ln.translateToString(true)); }
    return out.join('\n');
  } catch (_) { return ''; }
}
// 붙여넣은 프롬프트가 입력창에 안착했는지: 멀티라인은 '[Pasted text +N lines]'/'paste again to expand' placeholder 로 접히고,
//  짧으면 본문 앞부분이 그대로 보인다(둘 중 하나면 안착으로 본다).
function autosendLanded(screen) {
  if (/\[Pasted text|paste again to expand|\+\s*\d+\s*lines?/i.test(screen)) return true;
  const probe = AUTOSEND.replace(/\s+/g, ' ').trim().slice(0, 24);
  return probe.length >= 6 && screen.replace(/\s+/g, ' ').indexOf(probe) !== -1;
}
// 부팅 중 뜰 수 있는 '입력창이 아닌' 시작 다이얼로그(신뢰 폴더/권한 확인). 이 위에서 Enter 치면 다이얼로그가 그 Enter 를
//  먹고(예: '신뢰함' 확정) 붙여넣은 태스크가 날아간다 → 다이얼로그가 보이면 붙여넣기·Enter 를 미룬다.
//  ⚠ 정상 입력박스의 하단 표시 '⏵⏵ bypass permissions on' 은 다이얼로그가 아니다 — 'Bypass Permissions mode' 경고창(대문자·mode)
//   과 구분해 오판(정상 박스를 다이얼로그로 보고 영영 대기)을 막는다. 차단 다이얼로그는 'Enter to confirm'·번호선택 메뉴가 특징.
function autosendBlockingDialog(screen) {
  return /trust (this|the) folder|Do you trust|Enter to confirm|❯\s*1\.\s|\bNo, exit\b|Bypass Permissions mode|accept the risk/i.test(screen);
}
// 붙여넣기 → readback 확인 → (확인 시)Enter, (미확인 시)재시도. 다이얼로그면 대기. 최후엔 다이얼로그 아닐 때만 1회 폴백 Enter.
function autosendPasteTry(n) {
  if (autosendDone !== 'firing') return;
  if (autosendBlockingDialog(autosendReadScreen()) && n < AUTOSEND_MAX_TRIES) { setTimeout(() => autosendPasteTry(n + 1), 900); return; }
  try { pasteText(AUTOSEND); } catch (_) { /* noop */ }
  setTimeout(() => {
    if (autosendLanded(autosendReadScreen())) {
      autosendDone = true;
      try { sendInput('\r'); } catch (_) { /* noop */ }               // 안착 확인 후에만 제출.
      try { toast(autosendIsWelcome ? '라이블리 사용법 안내를 시작했어요' : '선택한 태스크를 클로드에게 전달했어요'); } catch (_) { /* noop */ }
    } else if (n < AUTOSEND_MAX_TRIES) {
      setTimeout(() => autosendPasteTry(n + 1), 800);                 // 아직 준비 전/씹힘 → 잠시 후 재시도.
    } else {
      autosendDone = true;
      if (!autosendBlockingDialog(autosendReadScreen())) { try { sendInput('\r'); } catch (_) { /* noop */ } } // 폴백(다이얼로그 아닐 때만).
    }
  }, 400); // 붙여넣기 바이트가 서버 send-keys→tmux→렌더→WS→xterm 버퍼로 왕복해 보일 여유(원격 RTT 포함) — 너무 짧으면 조기 오탐→중복붙여넣기.
}
function scheduleAutosend() {
  if (!AUTOSEND || autosendDone) return;
  clearTimeout(autosendTimer);
  autosendTimer = setTimeout(() => {
    if (autosendDone) return;
    const quiet = Date.now() - autosendLastOut;
    if ((autosendLastOut && quiet >= 1600) || (autosendDeadline && Date.now() >= autosendDeadline)) {
      autosendDone = 'firing';                                        // 재진입 방지(문자열 sentinel), 안착 확인/폴백 시 true 로 확정.
      try { if (term) term.focus(); } catch (_) { /* noop */ }
      autosendPasteTry(0);
    } else { scheduleAutosend(); }
  }, 500);
}
// 업로드가 어디로 가는지를 사람 말로(#1235). 세션 작업 폴더(@box_dir) 아래 uploads/ 인데, 프로젝트 세션이면
//  그 작업 폴더가 곧 프로젝트 폴더 = 팀이 함께 보는 공유 폴더다. 개인 세션엔 '공유'라고 하면 거짓이라 갈라 쓴다.
const uploadDestLabel = () => (sessionProjectId > 0 ? '이 프로젝트 공유 폴더' : '세션 작업 폴더');

// 첫 진입 파일 드롭 안내(#1235) — 드래그드롭이 되는 줄 아무도 몰랐다(사용법 안내에도 '파일 탐색기' 한 줄뿐이었다).
//  '다시 보지 않기' 를 체크해야 영구히 안 뜬다(체크 없이 닫으면 다음 진입에 또 뜬다) — 그리드 첫 진입 안내와 같은 언어.
//  ⚠ 그리드 셀 안에서는 띄우지 않는다: 그 화면은 이 페이지를 iframe 으로 여러 장 띄우므로 팝업이 셀 수만큼 겹친다.
//   그리드 사용자는 그리드 자신의 첫 진입 안내(terminal-grid.html)에서 같은 내용을 본다.
const HINT_DROP_KEY = 'lively_term_hint_filedrop';
function showDropHint() {
  const main = document.getElementById('main');
  if (!main || document.querySelector('.pop-hint')) return;
  if (main.querySelector('.ended-bar')) return; // 끝난 세션에 '파일 주세요'는 소용없다
  try { if (window.top !== window.self) return; } catch (_) { return; } // 크로스오리진이면 프레임 안으로 간주
  try { if (localStorage.getItem(HINT_DROP_KEY) === '1') return; } catch (_) { /* 스토리지 차단 — 그냥 보여준다 */ }
  const step = (n, title, sub) => el('div', { class: 'hint-step' },
    el('span', { class: 'n', text: String(n) }),
    el('span', { class: 't' }, title, el('small', { text: sub })));
  const dont = el('input', { type: 'checkbox' });
  const ok = el('button', { class: 'hint-ok', text: '알겠어요' });
  const pop = el('div', { class: 'pop pop-hint' },
    el('h3', { text: '파일은 끌어다 놓으면 됩니다' }),
    el('p', { class: 'hint-sub', text: '이미지·문서를 클로드에게 줄 때 경로를 직접 칠 필요가 없어요.' }),
    el('div', { class: 'hint-steps' },
      step(1, '화면 아무 데나 끌어다 놓기', '캡처한 이미지는 ⌘V(Ctrl+V)로 붙여넣어도 됩니다'),
      step(2, uploadDestLabel() + '에 복사', 'uploads/ 폴더에 올라가 나중에도 다시 찾을 수 있어요'),
      step(3, '경로가 입력창에 자동 삽입', '설명을 덧붙이고 Enter — 보내는 건 직접 하셔야 합니다')),
    el('div', { class: 'hint-row' },
      el('label', {}, dont, '다시 보지 않기'),
      el('span', { class: 'spacer' }), ok));
  const back = el('div', { class: 'pop-back' }, pop);
  const close = () => {
    if (dont.checked) { try { localStorage.setItem(HINT_DROP_KEY, '1'); } catch (_) { /* noop */ } }
    back.remove(); document.removeEventListener('keydown', esc);
  };
  function esc(ev) { if (ev.key === 'Escape') close(); }
  ok.onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  document.addEventListener('keydown', esc);
  document.body.append(back);
  ok.focus();
}

// uploads/ 안에서 겹치지 않는 이름 — 원래 이름을 그대로 쓰되, 이미 있으면 '이름-2.png' 로 번호를 올린다(#1235).
//  왜 타임스탬프(20260729-143022-) 를 안 쓰나: 그 접두어가 통째로 입력창에 꽂혀 경로를 길게 만들고, 사람이 자기 파일을
//  못 알아본다. 덮어쓰기(서버 PUT 은 그냥 쓴다)는 막아야 하므로 조회로 회피한다 — 목록을 못 읽으면(폴더 없음 등)
//  겹칠 것도 없다고 보고 그대로 쓴다.
async function uniqueUploadName(name) {
  const taken = new Set();
  try {
    const d = await api(sUrl('/ls?path=' + encodeURIComponent('uploads')));
    for (const it of (d.items || [])) taken.add(it.name);
  } catch (_) { return name; }
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) { const c = stem + '-' + i + ext; if (!taken.has(c)) return c; }
  return stem + '-' + Math.floor(Math.random() * 1e6) + ext;
}
// 이미지/파일을 작업폴더(cwd)의 uploads/ 로 업로드하고 그 경로를 입력창에 꽂는다. 웹 터미널은 이미지 바이트를
//  텍스트 스트림으로 못 흘리므로(터미널=텍스트), 파일로 올리고 경로를 입력해 안에서 도는 에이전트가 읽게 한다.
//  자동 전송 안 함 — 사용자가 설명을 덧붙여 Enter. (업로드 PUT 가 상위 폴더를 자동 생성.)
async function dropFileToAgent(file) {
  if (!file) return;
  let name = (file.name || 'pasted').split(/[/\\]/).pop().replace(/[^\w.\-가-힣]/g, '_');
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.' + (((file.type || '').split('/')[1]) || 'png');
  name = await uniqueUploadName(name);
  const rel = 'uploads/' + name;
  toast('업로드 중… ' + name);
  let abs = rel; // 폴백: 서버가 절대경로를 안 주면 기존처럼 상대경로
  try {
    const res = await fetchAuth(sUrl('/file?path=' + encodeURIComponent(rel)), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const j = await res.json().catch(() => null);
    if (!res.ok) { throw new Error((j && j.error) || ('' + res.status)); }
    if (j && j.path) abs = j.path; // 서버가 준 절대경로 — 클코 cwd 가 세션 루트와 달라도 바로 찾음
  } catch (e) { toast('업로드 실패 — ' + e.message, true); return; }
  // 절대경로엔 공백·한글이 흔해(프로젝트 폴더명) 작은따옴표로 감싼다(내부 ' 는 '\'' 로 이스케이프). 전송은 사용자가.
  const quoted = "'" + abs.replace(/'/g, "'\\''") + "'";
  sendInput(' ' + quoted + ' '); // 경로를 입력창에 삽입(앞뒤 공백)
  // 알림은 파일명 기준으로 말한다(#1235) — 절대경로는 입력창에 이미 보이고, 사람이 자기가 넣은 걸 알아보는 단서는 이름이다.
  //  ⚠ 입력창 표시 자체를 파일명으로 바꿀 수는 없다: sendInput 은 PTY 로 바이트를 흘릴 뿐이고 그 줄을 그리는 건
  //   클로드 코드 TUI 라, 화면에 보이는 문자열이 곧 클로드가 받는 문자열이다(표시만 갈아끼울 층이 없다).
  toast('첨부: ' + name + ' — 경로가 입력창에 들어갔어요(설명 적고 Enter)');
  if (explorerLoaded) loadDir(curDir);
}
export function setupClipboard() {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // [#1300] 비IME 키(Space/Enter/Backspace/화살표 등) = 사파리 IME 커밋 신호 — 에코 추적만 해제한다
    //  (음절은 이미 실시간 에코돼 있어 보낼 것이 없다. 해제해 두면 이후 치환이 와도 엉뚱한 글자를 지우지 않는다).
    //  ⚠ 수정자 키(Shift/Ctrl/Alt/Cmd/CapsLock) 자체는 커밋이 아니다 — 예: 안녕하세요 + Shift+1 은
    //  kd16(Shift) → repl 요(커밋 치환) → kd49(!) 순서라, Shift 에서 해제하면 repl 요가 'DEL 없는 재전송'이 되어
    //  마지막 글자가 반복된다(안녕하세요요! — 실기기 제보). 해제 시 직전 값은 imeEchoDone 에 남겨 순서 변형도 방어.
    if (imeEcho && e.keyCode !== 229 && !e.isComposing && !MODIFIER_KEYCODES[e.keyCode]) { imeEchoDone = imeEcho; imeEcho = ''; }
    // Shift+Enter = 줄바꿈(제출 아님). xterm 은 Shift 유무와 무관하게 Enter 를 CR('\r')로만 보내 클로드 코드가 '제출'로 받는다.
    //  (Option/Alt+Enter 는 xterm 이 Meta+Enter '\x1b\r' 로 보내 클로드가 '줄바꿈'으로 받음 — 이미 동작). Shift 엔 그 경로가
    //  없으니, xterm 이 낼 그 '\r' 을 아래 onData 에서 '\x1b\r'(= Option+Enter 와 동일 바이트)로 바꿔치기해 같은 줄바꿈으로 만든다.
    //  ⚠ 왜 여기서 직접 sendInput('\x1b\r')(return false) 하지 않고 통과(return true) + onData 바꿔치기냐 — #633 계열 순서 문제:
    //   한글 조합 중이면 xterm 의 compositionHelper.keydown 이 '이 keydown 안에서' 음절을 동기 확정(→ onData 로 음절 먼저 전송)한
    //   뒤 evaluate 가 '\r' 을 낸다. 그 '\r' 만 바꾸면 '음절 → 줄바꿈' 순서가 저절로 맞아(우리가 IME 확정 타이밍을 안 건드림),
    //   직접 전송 시 비동기 음절보다 줄바꿈이 앞서 나가는 버그(#633 의 '야바보')를 원천 회피한다. 조합이 없으면 evaluate 가 바로 '\r'.
    if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); // 브라우저 기본(히든 textarea 개행 삽입)이 IME 상태를 오염시키지 않게 — 실제 줄바꿈은 onData 바꿔치기가 담당
      shiftEnterPending = true;                                    // 이 keydown 이 곧 낼 '\r' 을 승격 대상으로 표시
      Promise.resolve().then(() => { shiftEnterPending = false; }); // 이 keydown 의 동기 onData 처리 직후 해제(다른 Enter 로 안 새게)
      return true; // xterm 통과 → (조합이면 음절 확정 후) '\r' 발생 → onData 가 '\x1b\r' 로 승격
    }
    // Option/Alt + ←/→ = 단어 단위 이동. xterm 기본(macOptionIsMeta 미설정)으론 Option+방향키가 단어이동이 안 되므로
    //  Meta-b/Meta-f(\eb/\ef — bash readline·zsh 기본 바인딩)를 직접 셸로 흘려 비개발자도 단어 점프가 되게 한다.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const wordSeq = e.key === 'ArrowLeft' ? '\x1bb' : '\x1bf';
      // #633 preventDefault 필수: return false 는 xterm '자체' 처리만 막을 뿐 브라우저 기본동작은 안 막는다
      //  (실측 defaultPrevented=false). 안 막으면 브라우저가 Option+←/→ 기본동작 = xterm 히든 textarea 안에서
      //  '단어 단위 캐럿 이동'(실측 9→6)을 해 IME 상태를 오염시켜 '직전 글자가 눌러붙어 반복'된다. → 항상 차단.
      e.preventDefault(); // 항상: 커서이동(브라우저 캐럿=반복버그 + xterm 기본 Alt+화살표 시퀀스=따라감) 원천차단
      // #633 실측(실브라우저 콘솔 로그): macOS 한글 IME 는 조합 중 Option+←/→ 를 keydown '두 번' 준다 —
      //  ① isComposing=true(조합 중) → 그 사이 IME 가 미완성 음절을 '스스로' 확정(compositionend → xterm 이
      //  '비동기'로 그 음절을 셸에 전송) → ② isComposing=false(확정 후). 즉 우리가 손대지 않아도 음절은 IME 가
      //  알아서 제자리에서 확정한다(과거의 synthetic compositionend·blur·textarea.value 읽기는 전부 불필요·유해였다:
      //  따라감/사라짐/줄중복/자모누출의 원인). → ①(조합 중 keydown)에선 '아무 것도 안 하고', ②(비조합 keydown,
      //  영문 타이핑도 이 경로)에서만 단어이동을 보낸다. 단, xterm 의 음절 전송이 비동기라 단어이동을 '동기'로
      //  보내면 음절보다 앞서 커서가 움직여 '야바보'가 되므로, setTimeout(0)로 미뤄 '음절 → 단어이동' 순서를 맞춘다.
      if (e.isComposing) return false; // ① 조합 중 keydown: IME 자연확정 방해 금지(아무 동작 안 함)
      const dSeq = wordSeq;            // ② 비조합 keydown: 단어이동을 한 틱 미뤄(비동기 음절 전송 뒤로) 보냄
      setTimeout(() => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d: dSeq })); } catch (_) { /* noop */ } } }, 0);
      return false;
    }
    // Alt/Option + Backspace = 커서 앞 '단어' 삭제(^W). Windows 크롬은 Ctrl+W 를 '탭 닫기'로 가로채 단어삭제로
    //  못 쓰므로(브라우저 예약 단축키라 preventDefault 불가), 가로채지지 않는 Alt+Backspace 로 동일 기능 제공.
    //  셸·Claude 입력 모두 backward-kill-word 로 동작(Mac 은 Option+Backspace).
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'Backspace') {
      e.preventDefault(); // #633: 같은 이유 — Alt+Backspace 브라우저 기본 'textarea 단어삭제'가 IME 상태를 깨뜨린다(우리 ^W 는 그대로 전송).
      if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d: '\x17' })); } catch (_) { /* noop */ } }
      return false;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;
    const k = (e.key || '').toLowerCase();
    if (k === 'c') {
      let mouseOn = false;
      try { mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'); } catch (_) { /* noop */ }
      // 웹(xterm) 선택이 있으면 그걸 복사 — 제스처 안이므로 동기 경로(사파리 포함 전 브라우저 동작, #1117 버그C).
      if (term.hasSelection()) { copyText(term.getSelection(), false, true); return false; }
      // [#972] Cmd+C 를 마우스모드 앱(Claude Code) 화면에선 Ctrl+C(\x03)로 브리지한다.
      //  Claude 는 마우스모드로 텍스트 선택을 자체 관리 → xterm 은 그 선택을 몰라(hasSelection=false) 위 copyText 를 못 탄다.
      //  게다가 macOS 는 xterm 이 Cmd(meta)키를 PTY 로 안 보내 앱이 Cmd+C 를 아예 못 받는다 — 반면 Ctrl+C 는 \x03 으로
      //  전달돼 앱의 '선택 복사 → OSC52'가 동작한다(그래서 Ctrl+C 만 됐다). 마우스모드면 Cmd+C 도 \x03 으로 보내 Ctrl+C 와
      //  동일하게 앱 복사를 트리거한다(셸 등 마우스모드 아님 화면은 손대지 않음 — 브라우저 기본 복사 유지).
      //  [#1117 버그C] 단, '무조건 브리지'는 사고를 냈다 — 선택이 없을 때 Cmd+C 를 누르면 앱엔 취소(^C)라서,
      //  두 번 누르면 Claude 가 종료됐다(복사하려다 앱을 죽임). 그래서 '앱 화면에서 드래그 선택이 실제로 관측된
      //  경우'(appDragSelect — onData 로 나가는 SGR 마우스 리포트를 trackAppMouse 가 추적)에만 브리지하고,
      //  아니면 아무 것도 보내지 않고 안내만 띄운다. Ctrl+C 는 게이팅하지 않는다(중단 기능이 본래 의미).
      if (e.metaKey && !e.ctrlKey) {
        if (mouseOn) {
          // ⚠ 관측은 '1회용'이다(#1117 후속, 사파리 실기기 사고): 앱(CC)은 복사 후·출력 후 선택을 스스로 잃는데
          //  우리는 그걸 볼 수 없다. 관측을 소비하지 않으면 Cmd+C 연타의 2번째부터가 선택 없는 ^C(= 취소,
          //  두 번이면 CC 종료)로 들어간다. 그래서 브리지 1회마다 소비하고, 다시 복사하려면 다시 드래그해야 한다.
          if (appDragSelect) { appDragSelect = false; armClipboardPromise(); sendInput('\x03'); dlog('cmdc-bridge', 'consume'); }
          else { dlog('cmdc-skip', 'no-app-selection'); copyHintToast(); }
          return false;
        }
        return true; // 마우스모드 아님 — 브라우저 기본 복사에 맡김(선택 없으면 자연히 no-op)
      }
      // Ctrl+C 를 마우스모드 앱에 그대로 흘리는 경로(아래 return true) — 드래그 선택이 관측돼 있으면 '복사 의도'로
      //  보고 사파리용 클립보드 promise 를 미리 커밋해 둔다(앱의 OSC52 가 곧 도착). 흐름은 바꾸지 않는다.
      if (e.ctrlKey && !e.metaKey && mouseOn && appDragSelect) armClipboardPromise();
      return true;
    }
    if (k === 'v') {
      // 붙여넣기는 네이티브 paste 이벤트(setupPaste)가 처리한다 — 이미지 업로드+경로, 여러 줄은 bracketed paste.
      //  Mac Cmd+V 는 그대로 흘려 paste 이벤트가 뜨게 한다(xterm 은 Cmd 키로 셸에 아무 것도 안 보냄).
      //  Ctrl+V 는 xterm 이 \x16(SYN)을 셸로 보내는 걸 막아야 해서 가로채되(return false), 붙여넣기 자체는
      //  역시 네이티브 paste 에 맡기고 클립보드 API 는 '폴백'으로만 쓴다 — 이유는 schedulePasteFallback 주석(#1084).
      if (e.metaKey && !e.ctrlKey) return true;
      schedulePasteFallback();
      return false;
    }
    return true;
  });
}
// ── 히든 textarea 위생(#1117 버그A 근본수정) ──
// xterm(5.5)의 히든 textarea 는 blur 와 Enter/Ctrl+C 때만 비워진다(실측·소스 확인). 그래서 IME 로 입력한 글자,
//  비키보드 입력(딕테이션·이모지 팔레트·길게눌러 악센트), 우클릭 메뉴용 선택 주입(xterm rightClickHandler)이
//  '잔류물'로 계속 쌓인다. 평소엔 무해하지만, 캐럿이 값 '중간'으로 옮겨지는 순간(막히지 않은 브라우저 기본동작 —
//  Cmd+Z 언두, select-all 후 치환 등) xterm CompositionHelper 의 인덱스 산술이 어긋난다:
//   · diff = newValue.replace(oldValue,'') 는 oldValue 가 부분문자열이 아니게 되면 '전체 값'을 반환 →
//     IME 활성 상태에선 어떤 키를 눌러도 잔류물 전체(과거 입력·주입 텍스트 = "특정 문자열")가 통째로 전송된다(버그A).
//   · substring(start,end) 는 엉뚱한 고정 글자를 전송한다(#633 의 '직전 글자 반복'이 이것의 1글자 변종).
//  '새로고침하면 낫는' 이유가 정확히 textarea 리셋이다 → 여기서 '유휴 300ms'마다 미리 리셋해 잔류물의 수명을
//  없앤다(원인 제거). xterm 의 조합 확정 읽기(setTimeout 0)와 keydown-diff 읽기(setTimeout 0)는 수 ms 안에 끝나므로
//  300ms 유휴 청소와 경합하지 않는다.
//  ⚠ 조합 중(imeComposing)엔 절대 청소 금지 — IME 상태를 건드리면 사라짐/중복/자모누출(#633 실패 목록 참조).
//  ⚠ 컨텍스트 메뉴가 떠 있는 동안도 보류 — xterm 이 '우클릭 메뉴의 복사'용으로 선택 텍스트를 textarea 에 넣어 두는데
//    그걸 지우면 메뉴 복사가 빈 값을 복사한다. 다음 상호작용(키/클릭/copy/paste)에서 재개.
export function setupTextareaHygiene() {
  const ta = term.textarea;
  if (!ta) return;
  let menuHold = false, timer = null;
  // 사파리(WebKit)는 IME 가 프로그램적 value 변경에 민감하다 — 청소 주기를 길게 잡아 IME 와의 상호작용을
  //  최소화한다(잔류물 수명 상한은 유지되므로 버그A 방어력은 그대로, #1117 사파리 회귀 예방적 완화).
  const IDLE = IS_SAFARI ? 1500 : 300;
  const sweep = () => {
    if (imeComposing || menuHold) return;
    try { if (ta.value) { dlog('hygiene', diagPreview(ta.value)); ta.value = ''; } } catch (_) { /* noop */ }
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(sweep, IDLE); };
  ta.addEventListener('compositionstart', () => { imeComposing = true; }, true);
  ta.addEventListener('compositionend', () => { imeComposing = false; arm(); }, true);
  ta.addEventListener('keydown', arm, true);
  ta.addEventListener('keyup', arm, true);
  ta.addEventListener('input', arm, true);
  try { if (term.element) term.element.addEventListener('contextmenu', () => { menuHold = true; }, true); } catch (_) { /* noop */ }
  const resume = () => { menuHold = false; arm(); };
  document.addEventListener('mousedown', resume, true);
  document.addEventListener('keydown', resume, true);
  document.addEventListener('copy', resume, true);
  document.addEventListener('paste', resume, true);
  arm();
}
// ── IME 이벤트 트레이스(#1117 사파리 한글 깨짐 규명용) ──
// 사파리에서 한글 조합이 깨지는 문제(라이브에서도 재현 = #1117 수정과 무관한 선재 버그)는 사파리의
//  keydown/composition/input 이벤트 '순서·타이밍'이 크롬과 달라 xterm CompositionHelper 의 인덱스 산술이
//  어긋나는 것으로 추정된다 — 정확한 지점을 잡으려면 실기기 이벤트 트레이스가 필요하다. 그래서 조합 관련
//  이벤트 전부와 실제 전송 바이트(out)를 진단 링버퍼에 남긴다. 타이핑 1문장 ≈ 60~80줄 — 링버퍼(400)로 충분.
//  [입력 진단 복사]에 그대로 실려 제보와 함께 온다. 성능 영향 무시 가능(문자열 push 뿐).
function setupImeTrace() {
  const ta = term.textarea;
  if (!ta) return;
  const st = () => { try { return ' len=' + ta.value.length + ' sel=' + ta.selectionStart; } catch (_) { return ''; } };
  ta.addEventListener('keydown', (e) => dlog('kd', (e.keyCode || 0) + (e.isComposing ? ' C' : '') + ' ' + diagPreview(e.key || '', 8) + st()), true);
  ta.addEventListener('compositionstart', (e) => dlog('cs', diagPreview((e && e.data) || '', 12) + st()), true);
  ta.addEventListener('compositionupdate', (e) => dlog('cu', diagPreview((e && e.data) || '', 12) + st()), true);
  ta.addEventListener('compositionend', (e) => dlog('ce', diagPreview((e && e.data) || '', 12) + st()), true);
  ta.addEventListener('input', (e) => dlog('in', ((e && e.inputType) || '?') + ' ' + diagPreview((e && e.data) || '', 12) + st()), true);
}
// [#1084] Ctrl+V 붙여넣기 경로는 '둘'이 될 수 있다 → 그래서 폴백은 '예약'하고 네이티브가 뜨면 취소한다.
//  ① 네이티브 paste 이벤트(setupPaste) ② 클립보드 API 직접 읽기. keydown 에서 return false 는 xterm '자체' 처리만
//  막을 뿐 브라우저 기본동작은 안 막으므로(#633 실측 — preventDefault 를 해야 막힌다), Ctrl+V 가 OS 붙여넣기
//  단축키인 윈도우에선 ①이 그대로 뜬다 → 예전처럼 ②를 keydown 에서 즉시 실행하면 **두 번 붙여넣어졌다**(사용자 신고).
//  맥은 Ctrl+V 가 OS 붙여넣기가 아니라 ①이 안 떠서 증상이 없었고(그래서 맥 Ctrl+V 는 ②가 유일한 경로 — 없애면 회귀).
//  → ②를 한 틱 미뤄 예약하고, ①이 실제로 처리하면 취소한다. 어느 플랫폼이든 정확히 한 번. (지연은 ①이 keydown
//   기본동작으로 즉시 디스패치되므로 사실상 체감 0 — 폴백이 실제로 도는 맥 Ctrl+V 에서만 60ms 늦다.)
let pasteFallbackTimer = null;
function cancelPasteFallback() { if (pasteFallbackTimer) { clearTimeout(pasteFallbackTimer); pasteFallbackTimer = null; } }
function schedulePasteFallback() {
  cancelPasteFallback();
  if (!(navigator.clipboard && navigator.clipboard.read && window.isSecureContext)) return; // 비보안 origin — 네이티브 paste 만이 경로
  pasteFallbackTimer = setTimeout(() => {
    pasteFallbackTimer = null;
    dlog('paste-src', 'fallback-api');
    navigator.clipboard.read().then(async (its) => {
      let textDone = false; // 클립보드가 항목을 여러 개로 쪼개 줘도 텍스트는 한 번만 붙인다(중복 방지)
      for (const it of its) {
        const t = (it.types || []).find((x) => x.startsWith('image/'));
        if (t) await dropFileToAgent(new File([await it.getType(t)], 'pasted.' + (t.split('/')[1] || 'png'), { type: t }));
        else if (!textDone && (it.types || []).includes('text/plain')) { textDone = true; pasteText(await (await it.getType('text/plain')).text()); }
      }
    }).catch(() => navigator.clipboard.readText().then((t) => pasteText(t)).catch(() => { /* noop */ }));
  }, 60);
}
// 붙여넣기(이미지·텍스트)를 네이티브 paste 이벤트로 처리 — 보안 컨텍스트 불문·권한 프롬프트 없이 동작(GitHub·Slack 방식).
//  capture 단계에서 xterm 텍스트영역보다 먼저 잡아 기본 붙여넣기를 막고 우리가 처리(중복 방지). 이미지=업로드+경로, 텍스트=bracketed.
//  실제로 처리한 분기에서만 폴백을 취소한다 — 내용이 비어 우리가 아무것도 못 한 paste 는 폴백이 이어받게(#1084).
export function setupPaste() {
  const dz = panesEl || document.body;
  dz.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const img = [...(dt.items || [])].find((it) => it.kind === 'file' && (it.type || '').startsWith('image/'));
    if (img) {
      e.preventDefault(); e.stopImmediatePropagation();
      const blob = img.getAsFile();
      if (blob) { cancelPasteFallback(); dlog('paste-src', 'native-image'); dropFileToAgent(blob); }
      return;
    }
    const text = dt.getData('text/plain') || dt.getData('text') || '';
    if (text) { e.preventDefault(); e.stopImmediatePropagation(); cancelPasteFallback(); dlog('paste-src', 'native'); pasteText(text); }
  }, true);
}

// 현재 셀(줄) 높이 px — 픽셀 단위 스크롤 입력(트랙패드·터치)을 줄 수로 환산하는 기준.
function cellHeightPx() {
  try {
    const scr = (term.element && term.element.querySelector('.xterm-screen')) || term.element;
    return Math.max(4, scr.getBoundingClientRect().height / term.rows);
  } catch (_) { return 17; }
}

// 휠 처리 — 마우스 휠(이산 노치)과 트랙패드(연속 픽셀)를 서로 다른 단위로 다룬다(#1168).
//  종전에는 한 배수(scrollSpeed)를 두 입력에 똑같이 곱하고 픽셀 잔차를 버렸다(`trunc(dy/18) || ±1` → 최소 1줄 강제).
//  트랙패드는 1~10px 델타가 17ms 간격으로 오므로(실측 307건: median 5px·17ms) 손가락 이동량과 무관하게 '이벤트 수'만큼
//  스크롤됐다 — 그래서 마우스 기준으로 맞춘 값(3)이 트랙패드에선 과속했다. 같은 값이 두 단위를 뜻한 셈.
//  · 마우스 휠 = 종전 공식 그대로(회귀 방지): 픽셀 근사 × scrollSpeed.
//  · 트랙패드 = 손가락 이동 픽셀을 실측 셀높이로 나눠 줄로 환산하고 소수 잔차는 다음 이벤트로 이월 × padGain(1이면 1:1).
//  분기는 종전과 같다: normal buffer=로컬 스크롤백 / alt+앱 마우스모드=SGR 휠 전달 / alt 만=xterm 기본.
function setupWheel() {
  if (!term.attachCustomWheelEventHandler) return; // 구버전 xterm — 네이티브 휠(스크롤백 미사용 시 무동작)
  const NOTCH_MIN_PX = 100; // wheelDeltaY 를 안 주는 브라우저용 폴백 임계 — 이보다 큰 픽셀 점프는 노치로 본다
  const cellFromEvent = (e) => {
    try {
      const scr = (term.element && term.element.querySelector('.xterm-screen')) || term.element;
      const r = scr.getBoundingClientRect();
      return {
        col: Math.min(term.cols, Math.max(1, Math.floor((e.clientX - r.left) / (r.width / term.cols)) + 1)),
        row: Math.min(term.rows, Math.max(1, Math.floor((e.clientY - r.top) / (r.height / term.rows)) + 1)),
      };
    } catch (_) { return { col: 1, row: 1 }; }
  };
  // 이산 노치(마우스 휠)인가 연속 픽셀(트랙패드)인가 — 브라우저가 주는 신호로만 판별한다.
  //  실측(맥 크롬 150): 마우스 66/66 이 wheelDeltaY 120 배수, 트랙패드 300/300 이 비배수(=deltaY×3) → 이 신호로 완전 분리된다.
  //  주의: 120 은 '노치다'라는 표지일 뿐 칸 수가 아니다 — 맥은 휠 한 칸을 여러 이벤트로 쪼개 보내며(dy 4→22→69→73)
  //  전부 wheelDeltaY=-120 을 싣는다. 그래서 칸 수를 세지 않고 종전처럼 deltaY 픽셀을 그대로 쓴다.
  const isNotch = (e) => {
    if (e.deltaMode !== 0) return true;              // line/page 단위 = 이산 노치(파이어폭스 마우스 휠 등)
    const wdy = e.wheelDeltaY;                       // Blink/WebKit legacy: 마우스 휠은 120 배수, 트랙패드는 임의값
    if (typeof wdy === 'number' && wdy !== 0) return Math.abs(wdy) % 120 === 0;
    return Math.abs(e.deltaY) >= NOTCH_MIN_PX;       // wheelDeltaY 없는 브라우저(파이어폭스 트랙패드 등) 폴백
  };
  let accPx = 0, accAt = 0;                          // 연속 입력의 픽셀 잔차(그리고 그 시각)
  term.attachCustomWheelEventHandler((e) => {
    cancelPromptSeek(true); // 질문 위치 자동 탐색 중 사용자가 직접 휠을 굴리면 즉시 중단(#967)
    let alt = false, mouseOn = false;
    try { alt = term.buffer.active.type === 'alternate'; } catch (_) { /* noop */ }
    try { mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'); } catch (_) { /* noop */ }
    const notch = isNotch(e);
    if (alt && mouseOn && notch && scrollSpeed <= 1) return true; // 1칸=1줄이면 xterm 의 검증된 전달 그대로(회귀 없음)
    // 이 이벤트가 몇 줄인지 산출 — 마우스는 종전 공식, 트랙패드는 실측 셀높이로 픽셀→줄 환산.
    let lines;
    if (e.deltaMode === 2) {                         // page 단위(드묾)
      lines = e.deltaY * term.rows;
    } else if (notch) {
      accPx = 0;                                     // 입력원이 바뀌었다 — 남은 픽셀 잔차는 버린다
      const approx = e.deltaMode === 1 ? e.deltaY : (Math.trunc(e.deltaY / 18) || (e.deltaY > 0 ? 1 : -1));
      lines = approx * Math.max(1, Math.round(scrollSpeed));
    } else {
      const now = e.timeStamp || 0;
      if (accPx && (Math.sign(accPx) !== Math.sign(e.deltaY) || now - accAt > 300)) accPx = 0; // 방향전환·묵은 잔차는 리셋
      accAt = now;
      accPx += e.deltaY * Math.max(0.2, padGain);
      const h = cellHeightPx();
      lines = Math.trunc(accPx / h);
      accPx -= lines * h;                            // 소수 잔차는 남겨 다음 이벤트로 이월(픽셀 정확)
    }
    const n = Math.trunc(lines);
    if (alt && mouseOn) {
      // 앱(Claude Code 등)에 SGR 휠을 직접 보낸다. 마우스는 종전처럼 '이벤트당 scrollSpeed 틱' 고정이어야 한다 —
      //  맥 가속으로 한 칸의 deltaY 가 4~161px 로 널뛰므로(실측) 픽셀 비례로 보내면 같은 한 칸이 최대 4배 빨라진다.
      //  트랙패드는 반대로 픽셀 누적으로 찬 줄 수만큼 보낸다(잔차는 다음 이벤트로 이월).
      const reps = notch ? Math.min(Math.max(1, Math.round(scrollSpeed)), 12) : Math.min(Math.abs(n), 12);
      if (!reps) return false;                       // 아직 한 줄이 안 찼다(미세 스와이프) — 잔차만 쌓고 대기
      const c = cellFromEvent(e);
      const btn = n < 0 ? 64 : 65;                   // 64=휠↑ 65=휠↓ (SGR 1006)
      let seq = '';
      for (let i = 0; i < reps; i++) seq += '\x1b[<' + btn + ';' + c.col + ';' + c.row + 'M';
      sendInput(seq);
      return false;
    }
    if (alt) return true;                            // 마우스모드 아닌 alt 앱(옛 pager 등) → xterm 기본
    if (n) term.scrollLines(n);
    return false;
  });
}

// 터치 스크롤(모바일, #585) — xterm.js 는 터치 스와이프를 자체 처리하지 않아 모바일에서 스크롤 무동작.
//  스와이프 이동량을 줄 수로 환산해 휠 핸들러(setupWheel)와 같은 분기를 태운다:
//   - normal buffer(셸 등): 로컬 스크롤백 직접 스크롤(term.scrollLines).
//   - alt-screen + 앱 마우스모드(Claude Code 등): SGR 휠 시퀀스로 앱에 전달(앱이 자기 스크롤백 스크롤).
//   - alt-screen + 마우스모드 아님(옛 pager 등): 방향키로 전달(xterm 의 alt 휠 기본과 동일한 관례).
//  손을 놓으면 속도에 따라 관성(플링) 스크롤을 이어간다. 멀티터치(핀치)는 건드리지 않는다.
function setupTouch() {
  const hostEl = term.element;
  if (!hostEl) return;
  const cellFromXY = (x, y) => {
    try {
      const scr = hostEl.querySelector('.xterm-screen') || hostEl;
      const r = scr.getBoundingClientRect();
      return {
        col: Math.min(term.cols, Math.max(1, Math.floor((x - r.left) / (r.width / term.cols)) + 1)),
        row: Math.min(term.rows, Math.max(1, Math.floor((y - r.top) / (r.height / term.rows)) + 1)),
      };
    } catch (_) { return { col: 1, row: 1 }; }
  };
  // lines>0 = 아래로 스크롤. 한 번에 보내는 시퀀스는 상한을 둬 앱 플러딩을 막는다.
  const emit = (lines, x, y) => {
    const n = Math.trunc(lines);
    if (!n) return 0;
    let alt = false, mouseOn = false;
    try { alt = term.buffer.active.type === 'alternate'; } catch (_) { /* noop */ }
    try { mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'); } catch (_) { /* noop */ }
    const reps = Math.min(Math.abs(n), 8);
    if (alt && mouseOn) {
      const c = cellFromXY(x, y);
      const btn = n < 0 ? 64 : 65; // 64=휠↑ 65=휠↓ (SGR 1006)
      let seq = '';
      for (let i = 0; i < reps; i++) seq += '\x1b[<' + btn + ';' + c.col + ';' + c.row + 'M';
      sendInput(seq);
    } else if (alt) {
      let seq = '';
      for (let i = 0; i < reps; i++) seq += n < 0 ? '\x1b[A' : '\x1b[B';
      sendInput(seq);
    } else {
      term.scrollLines(n);
    }
    return n; // 소비한 줄 수(부호 포함) — 나머지 픽셀은 누적 유지
  };
  let lastY = 0, lastX = 0, accPx = 0, vel = 0, lastT = 0, raf = 0, active = false;
  const stopFling = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  hostEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { active = false; return; }
    stopFling();
    active = true; accPx = 0; vel = 0;
    lastY = e.touches[0].clientY; lastX = e.touches[0].clientX; lastT = e.timeStamp;
  }, { passive: true });
  hostEl.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dy = lastY - t.clientY; // 손가락 위로 = 아래로 스크롤(네이티브 스크롤 방향)
    const dt = Math.max(1, e.timeStamp - lastT);
    vel = 0.8 * vel + 0.2 * (dy / dt); // px/ms, 살짝 평활
    lastY = t.clientY; lastX = t.clientX; lastT = e.timeStamp;
    accPx += dy; // 모바일 터치는 손가락 1:1 유지(트랙패드 padGain 과 별개 축)
    const h = cellHeightPx();
    const used = emit(accPx / h, t.clientX, t.clientY);
    accPx -= used * h;
    e.preventDefault(); // 페이지 바운스/스크롤 방지 — 스와이프는 터미널이 소비
  }, { passive: false });
  const endTouch = (e) => {
    if (!active) return;
    active = false;
    // 관성(플링): 속도가 충분하면 감쇠하며 이어서 스크롤.
    if (Math.abs(vel) < 0.15) return;
    const x = lastX, y = lastY;
    let v = Math.max(-4, Math.min(4, vel)), prev = 0, acc = 0;
    const step = (ts) => {
      raf = 0;
      if (!prev) prev = ts;
      const dt = Math.min(64, ts - prev); prev = ts;
      acc += v * dt;
      v *= Math.pow(0.994, dt); // 지수 감쇠
      const h = cellHeightPx();
      const used = emit(acc / h, x, y);
      acc -= used * h;
      if (Math.abs(v) > 0.03) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  hostEl.addEventListener('touchend', endTouch, { passive: true });
  hostEl.addEventListener('touchcancel', () => { active = false; }, { passive: true });
}

function setActive(id) {
  activeId = id;
  for (const t of tabs) t.pane.classList.toggle('active', t.id === id);
  for (const b of tabbarEl.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.id === id);
  if (id === 'term') setTimeout(doResize, 0);
}
function renderTabbar() {
  tabbarEl.style.display = tabs.length <= 1 ? 'none' : 'flex'; // 단일 탭이면 탭바 숨김
  tabbarEl.replaceChildren();
  for (const t of tabs) {
    const btn = el('button', { class: 'tab' + (t.id === activeId ? ' active' : ''), 'data-id': t.id, onclick: () => setActive(t.id) }, t.label);
    if (t.closable) btn.append(el('span', { class: 'x', text: '×', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }));
    tabbarEl.append(btn);
  }
}
function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id); if (i < 0) return;
  tabs[i].pane.remove(); tabs.splice(i, 1);
  if (activeId === id) activeId = 'term';
  renderTabbar(); setActive(activeId);
}
function addPane(id, label, closable, node) {
  const existing = tabs.find((t) => t.id === id);
  if (existing) { existing.pane.replaceChildren(node); renderTabbar(); setActive(id); return; }
  const pane = el('div', { class: 'pane' }, node);
  panesEl.append(pane);
  tabs.push({ id, label, pane, closable });
  renderTabbar(); setActive(id);
}

// ── 파일 익스플로러 ──
function fileIcon(name, type) {
  if (type === 'dir') return '📁';
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(name)) return '🖼';
  if (/\.md$/i.test(name)) return '📝';
  return '📄';
}
// ── 공유 링크(#1436) ─────────────────────────────────────────────────────────
//  세션 작업폴더가 공유/개인 루트의 어디인지는 서버가 /ls 응답에 실어 준다(shareRoot·sharePath —
//  src/terminal/terminal-files.ts). 그 좌표로 세션과 **무관한** 주소를 만든다: 세션 id 를 주소에 넣으면
//  세션을 종료한 순간 이미 뿌린 링크가 죽기 때문이다(자세한 근거는 web/lib/sharelink.ts 헤더).
//  ⚠ 이 페이지는 standalone 번들이라 web/lib 를 import 할 수 없다(rootDir 이 web/standalone) → 같은 주소
//   형식을 여기서 한 번 더 만든다. **형식을 바꿀 땐 두 곳을 함께** 고쳐야 한다(lib/sharelink.ts fileLinkHash).
let shareRoot: string | null = null;   // 'shared' | 'personal' | null(좌표 없음 = 원격 노드 등 → 버튼 안 그림)
let sharePath = '';                    // 현재 보고 있는 폴더의 루트기준 경로
function shareUrlFor(rel) {
  // 이 페이지는 /ui/terminal.html 이므로 파일명을 떼어 앱 루트(/ui/)를 얻는다(프리뷰 서브패스도 그대로 유지된다).
  const appBase = location.origin + location.pathname.replace(/[^/]*$/, '');
  return appBase + '#/f?root=' + encodeURIComponent(shareRoot || '') + '&path=' + encodeURIComponent(rel || '');
}
async function copyShareLink(rel, isDir) {
  const url = shareUrlFor(rel);
  const who = shareRoot === 'personal' ? '개인 폴더라 이 링크는 나만 열 수 있어요' : '볼 권한이 있는 팀원이 열 수 있어요';
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(url);
    toast((isDir ? '폴더' : '파일') + ' 링크 복사 — ' + who);
  } catch (_) {
    // 자동 복사가 막혔으면(비보안 컨텍스트 등) 주소를 보여준다 — 아무 일도 안 일어나면 고장으로 읽힌다.
    window.prompt('아래 주소를 복사해 보내세요', url);
  }
}

async function loadDir(p) {
  curDir = p || '';
  const list = document.getElementById('exp-list');
  document.getElementById('exp-path').textContent = '/' + curDir;
  list.replaceChildren(el('div', { class: 'exp-item', text: '불러오는 중…' }));
  let data;
  try { data = await api(sUrl('/ls?path=' + encodeURIComponent(curDir))); }
  catch (e) { list.replaceChildren(el('div', { class: 'exp-item', text: '오류: ' + e.message })); return; }
  shareRoot = data.shareRoot || null;
  sharePath = data.sharePath || '';
  list.replaceChildren();
  if (data.parent !== null && curDir) list.append(el('div', { class: 'exp-item', onclick: () => loadDir(data.parent), title: '상위' }, el('span', { class: 'ic', text: '↩' }), '..'));
  for (const it of (data.items || [])) {
    const childPath = (curDir ? curDir + '/' : '') + it.name;
    const isDir = it.type === 'dir';
    const shareRel = shareRoot ? (sharePath ? sharePath + '/' + it.name : it.name) : null;
    const row = el('div', { class: 'exp-item', onclick: () => (isDir ? loadDir(childPath) : openPreview(childPath, it.name, shareRel)) },
      el('span', { class: 'ic', text: fileIcon(it.name, it.type) }), it.name,
      // .sz 는 폴더에서도(빈 값으로) 항상 그린다 — 이 span 의 margin-left:auto 가 오른쪽 액션들을 끝으로 밀기
      //  때문이다(terminal.html .exp-item .sz). 폴더에서 빼면 🔗 가 이름 바로 옆에 붙어 열이 어긋난다.
      el('span', { class: 'sz', text: isDir ? '' : fmtSize(it.size) }),
      shareRel ? el('span', { class: 'exp-dl exp-share', text: '🔗', title: '링크 복사', onclick: (e) => { e.stopPropagation(); copyShareLink(shareRel, isDir); } }) : null,
      it.type === 'file' ? el('span', { class: 'exp-dl', text: '⬇', title: '다운로드', onclick: (e) => { e.stopPropagation(); downloadFile(childPath, it.name); } }) : null);
    list.append(row);
  }
}
const fmtSize = (n) => (n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(0) + 'K' : (n / 1048576).toFixed(1) + 'M');

async function downloadFile(p, name) {
  try {
    const res = await fetchAuth(sUrl('/file?path=' + encodeURIComponent(p) + '&download=1'));
    if (!res.ok) throw new Error('' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (e) { toast('다운로드 실패: ' + e.message, true); }
}
async function uploadFile(file, dir) {
  const rel = (dir ? dir + '/' : '') + file.name;
  const res = await fetchAuth(sUrl('/file?path=' + encodeURIComponent(rel)), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  if (!res.ok) { const d = await res.json().catch(() => null); throw new Error((d && d.error) || ('' + res.status)); }
}
async function uploadMany(files, dir) {
  for (const f of files) { try { await uploadFile(f, dir); toast('업로드: ' + f.name); } catch (e) { toast('업로드 실패: ' + f.name + ' — ' + e.message, true); } }
  loadDir(curDir);
}
function startUpload() {
  const input: any = document.getElementById('upload-input');
  input.value = '';
  input.onchange = () => { const files = [...(input.files || [])]; if (files.length) uploadMany(files, curDir); };
  input.click();
}
async function newFolder() {
  const name = prompt('새 폴더 이름'); if (!name || !name.trim()) return;
  const rel = (curDir ? curDir + '/' : '') + name.trim();
  try { await api(sUrl('/mkdir?path=' + encodeURIComponent(rel)), { method: 'POST' }); toast('폴더 생성: ' + name.trim()); loadDir(curDir); }
  catch (e) { toast('생성 실패: ' + e.message, true); }
}
// 드래그앤드랍 업로드 — 익스플로러 패널에 파일을 끌어다 놓으면 현재 폴더로 업로드.
function setupDnd() {
  const dz = explorerEl;
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', (e) => { if (e.target === dz) dz.classList.remove('drag'); });
  dz.addEventListener('drop', async (e) => {
    e.preventDefault(); dz.classList.remove('drag');
    if (!explorerLoaded) { explorerLoaded = true; await loadDir(''); }
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (files.length) uploadMany(files, curDir);
  });
}
// 터미널 화면에 파일(이미지 등)을 끌어다 놓으면 작업폴더로 업로드하고 경로를 입력창에 꽂는다(에이전트가 읽게).
//  파일 드래그일 때만 가로채고(텍스트 드래그는 그대로), 드롭 위치 강조는 인라인 아웃라인으로 표시.
function setupTermDrop() {
  const dz = panesEl;
  if (!dz) return;
  let note = null;
  // 끌어온 순간이 이 기능을 배우는 유일한 타이밍이라, 아웃라인만 그리지 말고 결과까지 말해 준다(#1235).
  const on = () => {
    dz.style.outline = '2px dashed #4a9eff'; dz.style.outlineOffset = '-4px';
    if (note) return;
    note = el('div', { class: 'drop-note' },
      el('b', { text: '여기에 놓으세요' }),
      el('span', { text: uploadDestLabel() + '(uploads/)에 복사되고, 그 경로가 입력창에 들어갑니다' }));
    dz.append(note);
  };
  const off = () => { dz.style.outline = ''; dz.style.outlineOffset = ''; if (note) { note.remove(); note = null; } };
  dz.addEventListener('dragover', (e) => {
    if (!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'))) return;
    e.preventDefault(); on();
  });
  dz.addEventListener('dragleave', (e) => { if (e.target === dz) off(); });
  dz.addEventListener('drop', async (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length) return;
    e.preventDefault(); off();
    for (const f of files) await dropFileToAgent(f);
  });
}

// ── 미리보기 ──
const IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;
const MD_RE = /\.(md|markdown)$/i;
const TEXT_RE = /\.(txt|text|log|json|jsonc|ya?ml|toml|ini|conf|cfg|env|csv|tsv|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|cc|hpp|cs|php|sh|bash|zsh|fish|sql|xml|gradle|properties)$/i;
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', '.gitignore', '.gitattributes', '.editorconfig', '.env']);
const isTextLike = (name) => MD_RE.test(name) || TEXT_RE.test(name) || TEXT_NAMES.has(name.toLowerCase());

// 세션 파일 탐색기의 미리보기(탭 패널).
//  ⭐ #1436 후속 — 이 페이지는 **standalone 번들**이라 web/lib 를 import 할 수 없다(standalone tsconfig 의 rootDir 이
//   web/standalone 이고, 산출물 경로를 바꾸면 dist/standalone 을 직접 import 하는 테스트가 깨진다). 그래서 공용
//   렌더러(lib/file-preview)를 **복제하지 않고 위임**한다:
//    · 여기서 인라인으로 보여주는 것 = 터미널 문맥에 맞는 것뿐(이미지 · md 렌더 · 텍스트/코드).
//    · pdf·표·음성·영상 등 나머지 = [⛶ 전체화면]으로 공용 렌더러(#/f)에 넘긴다.
//   종전엔 그 자리에 '그래도 미리보기'가 있어 **바이너리를 텍스트로 뿌렸다**(깨진 글자 화면) — 선택지처럼 보이지만
//   쓸 수 있는 답이 아니었다. 이제 실제로 볼 수 있는 곳으로 보낸다.
//  shareRel = 공유 링크 좌표(loadDir 이 서버 응답에서 받은 것). 없으면(원격 노드 등) 전체화면 버튼을 안 만든다.
async function openPreview(p, name, shareRel?) {
  const id = 'file:' + p;
  const body = el('div', { class: 'preview-body' }, el('div', { class: 'gate-msg', text: '불러오는 중…' }));
  // 상단 바 — 어떤 타입이든 같은 자리에 같은 선택지를 둔다(전체화면·링크·다운로드).
  const bar = el('div', { class: 'preview-bar' },
    el('span', { class: 'preview-bar-nm', title: name, text: name }),
    el('span', { class: 'preview-bar-sp' }),
    shareRel ? el('a', { class: 'tbtn', href: shareUrlFor(shareRel), target: '_blank', rel: 'noopener', title: '전체화면(새 탭)', text: '⛶ 전체화면' }) : null,
    shareRel ? el('button', { class: 'tbtn', text: '🔗 링크', title: '링크 복사', onclick: () => copyShareLink(shareRel, false) }) : null,
    el('button', { class: 'tbtn', text: '⬇ 다운로드', onclick: () => downloadFile(p, name) }));
  const pane = el('div', { class: 'preview-pane' }, bar, body);
  addPane(id, name, true, pane);
  if (IMG_RE.test(name)) { renderImage(body, p, name); return; }
  if (isTextLike(name)) { renderTextPreview(body, p, MD_RE.test(name)); return; }
  // 인라인으로 보여줄 수 없는 형식 → 볼 수 있는 곳(전체화면)으로 보낸다.
  body.replaceChildren(el('div', { class: 'unsupported' },
    el('div', { class: 'unsupported-card' },
      el('div', { class: 'unsupported-title', text: shareRel ? '이 형식은 전체화면에서 열려요' : '미리보기를 지원하지 않는 파일' }),
      el('div', { class: 'unsupported-sub', text: shareRel ? name + ' — PDF·표·음성·영상은 전체화면 미리보기가 렌더합니다.' : name }),
      el('div', { class: 'unsupported-actions' },
        shareRel ? el('a', { class: 'tbtn', href: shareUrlFor(shareRel), target: '_blank', rel: 'noopener', text: '⛶ 전체화면으로 열기' }) : null,
        el('button', { class: 'tbtn', text: '다운로드', onclick: () => downloadFile(p, name) })))));
}
async function renderImage(body, p, name) {
  try {
    const res = await fetchAuth(sUrl('/file?path=' + encodeURIComponent(p)));
    if (!res.ok) throw new Error('' + res.status);
    body.replaceChildren(el('img', { src: URL.createObjectURL(await res.blob()), alt: name }));
  } catch (e) { body.replaceChildren(el('div', { class: 'gate-msg', text: '불러오기 실패: ' + e.message })); }
}
async function renderTextPreview(body, p, asMd) {
  body.replaceChildren(el('div', { class: 'gate-msg', text: '불러오는 중…' }));
  try {
    const res = await fetchAuth(sUrl('/file?path=' + encodeURIComponent(p)));
    if (!res.ok) { const d = await res.json().catch(() => null); throw new Error((d && d.error) || ('' + res.status)); }
    let text = await res.text();
    // json 은 정렬해서 보여준다 — 한 줄로 밀린 json 은 사실상 못 읽는다(공용 렌더러와 같은 처리).
    if (/\.json$/i.test(p)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 원문 유지 */ } }
    body.replaceChildren(asMd ? renderMarkdown(text) : el('pre', { class: 'raw', text: text }));
  } catch (e) { body.replaceChildren(el('div', { class: 'gate-msg', text: '미리보기 실패: ' + e.message })); }
}

// ── 보기 설정 ──
function openSettings() {
  const p = prefs();
  const fontSel = el('select', {}, ...FONTS.map((f) => el('option', { value: f.v, selected: f.v === p.fontFamily ? '' : null }, f.label)));
  const sizeI = el('input', { type: 'number', min: '9', max: '30', value: String(p.fontSize) });
  const themeSel = el('select', {}, ...Object.entries(THEMES).map(([k, v]) => el('option', { value: k, selected: k === p.theme ? '' : null }, v.name)));
  const cursorSel = el('select', {}, ...['bar', 'block', 'underline'].map((c) => el('option', { value: c, selected: c === p.cursorStyle ? '' : null }, c)));
  const speedI = el('input', { type: 'number', min: '1', max: '12', step: '1', value: String(p.scrollSpeed || 3) });
  const gainI = el('input', { type: 'number', min: '0.5', max: '6', step: '0.5', value: String(p.padGain || 3) });
  let curFamily = p.fontFamily;
  const apply = () => {
    const np = { fontFamily: fontSel.value, fontSize: Number(sizeI.value) || 14, theme: themeSel.value, cursorStyle: cursorSel.value, scrollSpeed: Math.max(1, Math.min(12, Number(speedI.value) || 1)), padGain: Math.max(0.5, Math.min(6, Number(gainI.value) || 3)) };
    term.options.fontFamily = np.fontFamily; term.options.fontSize = np.fontSize; term.options.cursorStyle = np.cursorStyle;
    term.options.theme = (THEMES[np.theme] || THEMES.dark).theme;
    scrollSpeed = np.scrollSpeed; padGain = np.padGain;
    savePrefs(np); applyChrome(np.theme); doResize();
    // 처음 고르는 글꼴은 아직 로드 전이라 같은 race 를 탄다 — 명시 로드 후 실제 준비 시점에 재측정.
    if (np.fontFamily !== curFamily) { curFamily = np.fontFamily; remeasureAfterFonts(np.fontFamily); }
  };
  for (const c of [fontSel, themeSel, cursorSel]) c.addEventListener('change', apply);
  sizeI.addEventListener('input', apply);
  speedI.addEventListener('input', apply);
  gainI.addEventListener('input', apply);
  const back = el('div', { class: 'pop-back', onclick: (e) => { if (e.target === back) back.remove(); } },
    el('div', { class: 'pop' }, el('h3', { text: '환경 설정' }),
      el('div', { class: 'field' }, el('label', { text: '폰트' }), fontSel),
      el('div', { class: 'field' }, el('label', { text: '크기(px)' }), sizeI),
      el('div', { class: 'field' }, el('label', { text: '테마' }), themeSel),
      el('div', { class: 'field' }, el('label', { text: '커서' }), cursorSel),
      el('div', { class: 'field' }, el('label', { text: '마우스 휠 속도 (1~12)' }), speedI),
      el('div', { class: 'field' }, el('label', { text: '트랙패드 속도 (1 = 손가락 이동만큼)' }), gainI),
      el('button', { class: 'tbtn pop-close', text: '닫기', onclick: () => back.remove() })));
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
}

// 사용법 안내 — 이 터미널이 실제로 지원하는 동작(코드 근거)만 담는다(추측 키 금지). 비개발자 온보딩용.
function openHelp() {
  const kb = (keys, desc) => el('div', { class: 'help-item' },
    el('span', { class: 'k' }, ...keys.map((t) => el('span', { class: 'kbd', text: t }))),
    el('span', { class: 'd', text: desc }));
  const tool = (name, desc) => el('div', { class: 'help-tool' },
    el('b', { text: name }), el('span', { text: ' — ' + desc }));
  const sec = (title, ...items) => el('div', { class: 'help-sec' },
    el('div', { class: 'help-sec-t', text: title }),
    el('div', { class: 'help-list' }, ...items));
  const pop = el('div', { class: 'pop pop-help' },
    el('button', { class: 'help-x', title: '닫기', text: '✕', onclick: () => back.remove() }),
    el('div', { class: 'help-head' },
      el('h3', { text: '사용법 안내' }),
      el('p', { class: 'help-intro', text: '터미널이 처음이어도 이것만 알면 입력이 훨씬 빨라져요.' })),
    el('div', { class: 'help-body' },
      sec('이전에 친 명령 다시 쓰기',
        kb(['↑ ↓'], '바로 전에 입력한 명령들을 위/아래로 불러오기'),
        kb(['Ctrl R'], '예전 명령을 검색해서 찾기 (일부만 쳐도 됩니다)'),
        kb(['Tab'], '입력하다 누르면 파일·명령 이름 자동완성')),
      sec('한 줄에서 커서 이동',
        kb(['Option ←/→'], '한 단어씩 건너뛰며 이동 (Windows는 Alt)'),
        kb(['Ctrl A'], '줄 맨 앞으로'),
        kb(['Ctrl E'], '줄 맨 끝으로')),
      sec('잘못 친 것 지우기',
        kb(['Ctrl U'], '지금 친 줄을 통째로 지우기'),
        kb(['Alt ⌫'], '커서 앞 단어 하나 지우기 (Mac은 Option+⌫ · Windows에서 Ctrl+W는 탭이 닫혀요)'),
        kb(['Ctrl K'], '커서 오른쪽을 끝까지 지우기')),
      sec('화면 · 실행',
        kb(['Ctrl L'], '화면 비우기 (위로 스크롤하면 남아 있음)'),
        kb(['Ctrl C'], '멈춘·실행 중인 명령 강제 중단'),
        kb(['휠 ↑'], '위로 스크롤해 지난 출력 보기')),
      sec('복사',
        kb(['드래그 → ⌘/Ctrl C'], '드래그로 선택한 뒤 복사 — 자동 복사는 없어요(클립보드 안 덮임)'),
        kb(['Shift 드래그'], 'Claude 안에서는 Shift 누른 채 드래그로 선택'),
        kb(['Claude 복사'], 'Claude 가 복사한 내용은 내 컴퓨터 클립보드에도 자동으로 올라가요'),
        kb(['⌘C (선택 없이)'], 'Claude 화면에서 선택 없이 ⌘C 를 눌러도 이제 Claude 가 종료되지 않아요')),
      // 파일 전달은 이 화면에서 가장 안 알려진 기능이라 별도 섹션으로 앞에 둔다(#1235 — 종전엔 '파일 탐색기' 한 줄이 전부였다).
      sec('파일·이미지 주기',
        tool('끌어다 놓기', '화면 아무 데나 놓으면 ' + uploadDestLabel() + '(uploads/)에 올라가고 그 경로가 입력창에 들어갑니다'),
        tool('붙여넣기', '캡처한 이미지는 ⌘V(Windows 는 Ctrl+V)로 바로 — 같은 방식으로 전달됩니다'),
        tool('보낼 때', '경로 뒤에 설명을 적고 Enter 를 눌러야 클로드가 읽습니다 (자동 전송 안 함)')),
      sec('문제가 생겼을 때',
        tool('입력 진단 복사', '입력이 이상할 때(키만 눌러도 같은 문자열이 들어가는 등) 아래 버튼으로 최근 입력 기록을 복사해 제보에 붙여 주세요 — 서버로는 전송되지 않아요'),
        el('button', { class: 'tbtn', text: '🔍 입력 진단 복사', onclick: () => copyText(diagText(), false, true) }),
        tool('실행 중 빌드', TERMJS_BUILD + ' — 제보 시 이 값을 함께 알려 주세요(옛 캐시로 테스트하는 오인 방지)')),
      sec('도구 (오른쪽 위 버튼)',
        tool('질문', '이 세션에서 AI 에게 보낸 질문 전부 — 클릭하면 그 위치로 이동'),
        tool('파일 탐색기', '올린 파일 확인·다운로드 (여기에 놓으면 지금 열린 폴더로 업로드)'),
        tool('화면 복구', '화면이 깨지거나 스크롤이 안 될 때 재연결로 복구'),
        tool('환경 설정', '글꼴·크기·테마·커서·스크롤 속도')),
      sec('클로드 코드',
        kb(['Esc'], '에이전트가 하던 작업 멈추기'),
        kb(['/'], '쓸 수 있는 명령 목록'))));
  const back = el('div', { class: 'pop-back', onclick: (e) => { if (e.target === back) back.remove(); } }, pop);
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
}

// ── 내 질문(#967) — 이 세션에서 클로드에게 보낸 질문 목록 + 클릭하면 그 질문 위치로 화면 이동 ──
//  목록은 서버가 ~/.claude 트랜스크립트에서 추출(#745 /prompts 재사용, 노드 세션은 릴레이 #875).
//  '위치로 이동'은 대화 기록이 어디에 있느냐에 따라 두 경로로 갈린다:
//   · normal buffer(셸 등): 기록이 xterm 스크롤백에 있다 → 버퍼를 훑어 scrollToLine + 잠깐 하이라이트.
//   · alt-screen + 앱 마우스모드(Claude Code — 실측: 웹세션 tmux alternate_on=1, 기록은 앱 내부 스크롤백):
//     xterm 엔 현재 화면뿐이라 스크롤할 대상이 없다 → 휠업 이벤트를 앱에 보내 앱이 위로 스크롤하게 하면서
//     화면을 readback 해 질문이 보이면 멈춘다(자동 탐색). 사용자가 키·휠을 건드리면 즉시 중단(사용자 우선).
//  매칭은 공백 제거(stripWS) 문자열로 — 터미널 랩핑·"> " 프리픽스·연속행 들여쓰기가 끼어도 이어붙으면 잡힌다.
const stripWS = (s) => String(s || '').replace(/\s+/g, '');
function promptNeedles(text) {
  const first = (String(text || '').split('\n').find((l) => l.trim()) || '');
  const s = stripWS(first);
  const out = [];
  if (s.length >= 4) out.push(s.slice(0, 60));           // 기본: 첫 줄 앞 60자(공백 제거)
  if (s.length > 24) out.push(s.slice(0, 24));           // 표시가 중간에 잘린 경우 대비 — 점점 짧은 프리픽스로 재시도
  if (s.length > 12) out.push(s.slice(0, 12));
  if (!out.length && s) out.push(s);
  return [...new Set(out)];
}
// [from, from+count) 행 범위에서 needle 을 찾는다 — 행별 공백제거 문자열을 이어붙여 랩 경계 무관 매칭.
//  같은 텍스트가 여러 번 보이면(에이전트가 질문을 인용하는 등) '>' 로 시작하는 행(클로드 질문 표시)을 우선.
function findRowIn(from, count, needles) {
  let b;
  try { b = term.buffer.active; } catch (_) { return -1; }
  const n = Math.max(0, Math.min(count, b.length - from));
  if (!n) return -1;
  const offs = new Array(n + 1); offs[0] = 0;
  let big = '';
  for (let i = 0; i < n; i++) {
    const ln = b.getLine(from + i);
    const t = ln ? stripWS(ln.translateToString(true)) : '';
    big += t; offs[i + 1] = offs[i] + t.length;
  }
  const rowOf = (off) => { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (offs[m] <= off) lo = m; else hi = m - 1; } return from + lo; };
  for (const nd of needles) {
    const rows = [];
    let i = big.indexOf(nd);
    while (i !== -1 && rows.length < 50) { rows.push(rowOf(i)); i = big.indexOf(nd, i + 1); }
    if (!rows.length) continue;
    const anchored = rows.find((y) => { const ln = b.getLine(y); const s = ln ? ln.translateToString(true).trimStart() : ''; return s.startsWith('>'); });
    return anchored !== undefined ? anchored : rows[0];
  }
  return -1;
}
// 찾은 행을 잠깐 선택으로 하이라이트 — 자동 복사가 없으므로(#967 불변식) 선택해도 클립보드는 안 덮인다.
function flashRow(y) {
  try { term.clearSelection(); term.select(0, y, term.cols); setTimeout(() => { try { term.clearSelection(); } catch (_) { /* noop */ } }, 1600); } catch (_) { /* noop */ }
}
let promptSeek = null; // 진행 중 자동 탐색(동시에 하나만). 사용자 입력(onData·휠)이 오면 중단.
function cancelPromptSeek(notice?) {
  if (!promptSeek) return;
  promptSeek.stop = true; promptSeek = null;
  if (notice) toast('질문 위치 이동을 중단했어요');
}
// alt-screen 앱(Claude Code)에 휠업을 보내며 질문을 찾는다. 못 찾으면 보낸 만큼 휠다운으로 원위치(하단 클램프라 초과 무해).
function seekPromptInApp(needles) {
  const seek = { stop: false, ticks: 0 };
  promptSeek = seek;
  const colC = Math.max(1, Math.ceil(term.cols / 2)), rowC = Math.max(1, Math.ceil(term.rows / 2));
  const wheel = (btn, k) => { let s = ''; for (let i = 0; i < k; i++) s += '\x1b[<' + btn + ';' + colC + ';' + rowC + 'M'; sendInput(s); };
  const visible = () => { try { const b = term.buffer.active; return findRowIn(b.baseY, term.rows, needles); } catch (_) { return -1; } };
  // WAIT 는 재그림 왕복(send→tmux→%output→렌더) 여유 — 원격 노드 세션 RTT 포함(autosend 의 관찰과 동일 계열).
  const BATCH = 6, WAIT = 110, MAX_BATCH = 900; // ≈5400틱 상한 — 그 안에 못 찾으면 포기(사용자는 언제든 키로 중단)
  let unchanged = 0, last = '';
  const finish = (foundRow) => {
    if (foundRow >= 0) { if (promptSeek === seek) promptSeek = null; flashRow(foundRow); return; }
    toast('화면 기록에서 이 질문을 찾지 못했어요 — 원래 위치로 돌아갑니다', true);
    // 원위치 복귀(하단 클램프라 초과 무해). seek 를 유지한 채 되감아 사용자 입력이 오면 이것도 즉시 중단된다.
    const back = (left) => {
      if (left <= 0 || seek.stop) { if (promptSeek === seek) promptSeek = null; return; }
      const k = Math.min(40, left); wheel(65, k); setTimeout(() => back(left - k), 30);
    };
    back(seek.ticks);
  };
  const step = (iter) => {
    if (seek.stop) return;
    const y = visible();
    if (y >= 0) { finish(y); return; }
    if (iter >= MAX_BATCH || unchanged >= 8) { finish(-1); return; } // ≈880ms 무변화 = 맨 위 도달(또는 앱 무응답) — 스트리밍 중 조기 포기 방지 여유(#762)
    wheel(64, BATCH); seek.ticks += BATCH;
    setTimeout(() => {
      if (seek.stop) return;
      const cur = autosendReadScreen();
      if (cur === last) unchanged++; else { unchanged = 0; last = cur; }
      step(iter + 1);
    }, WAIT);
  };
  toast('질문 위치로 이동 중… (아무 키나 누르면 중단)');
  step(0);
}
function jumpToPrompt(text) {
  cancelPromptSeek();
  const needles = promptNeedles(text);
  if (!needles.length) { toast('이 질문은 내용이 너무 짧아 위치를 찾을 수 없어요', true); return; }
  let alt = false, mouseOn = false;
  try { alt = term.buffer.active.type === 'alternate'; } catch (_) { /* noop */ }
  try { mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'); } catch (_) { /* noop */ }
  if (!alt) { // 셸 등 — 기록이 xterm 스크롤백에 있다
    const y = findRowIn(0, term.buffer.active.length, needles);
    if (y < 0) { toast('화면 기록에서 이 질문을 찾지 못했어요 — 기록이 밀려났을 수 있어요', true); return; }
    try { term.scrollToLine(Math.max(0, y - 2)); } catch (_) { /* noop */ }
    flashRow(y);
    return;
  }
  if (!mouseOn || sessionEnded || !ws || ws.readyState !== 1) { // alt 인데 휠 전달 불가(연결 끊김 등) — 보이는 화면만 확인
    const b = term.buffer.active;
    const y = findRowIn(b.baseY, term.rows, needles);
    if (y >= 0) flashRow(y); else toast('지금 화면에선 이 질문을 찾지 못했어요 (세션 연결이 없어 스크롤 탐색 불가)', true);
    return;
  }
  seekPromptInApp(needles);
}
// 그리드(부모 프레임)의 통합검색이 '이 세션에서 물어본 질문'을 찾았을 때, 그 위치로 이동을 트리거한다.
//  같은 origin 이라 부모(terminal-grid.html)가 이 iframe 의 window.livelyJumpToPrompt(text) 를 직접 호출한다.
window.livelyJumpToPrompt = function (text) { try { jumpToPrompt(String(text || '')); } catch (_) { /* noop */ } };
// '내 질문' 팝업 — #762(목록·검색, pop-help 셸)에 #967(클릭 = 그 질문 위치로 이동)을 얹었다.
//  복사는 항목의 '복사' 버튼(명시적 클릭)으로만 — 위 클립보드 불변식과 일관.
function openMyPrompts() {
  const head = el('div', { class: 'help-head' },
    el('h3', { text: '💬 이 세션의 질문' }),
    el('p', { class: 'help-intro', text: '이 세션에서 AI 에게 보낸 질문을 누가 보냈든 최신 순으로. 클릭하면 그 질문 위치로 이동해요.' }));
  const body = el('div', { class: 'help-body' }, el('div', { class: 'q-empty', text: '불러오는 중…' }));
  const pop = el('div', { class: 'pop pop-help' },
    el('button', { class: 'help-x', title: '닫기', text: '✕', onclick: () => back.remove() }),
    head, body);
  const back = el('div', { class: 'pop-back', onclick: (e) => { if (e.target === back) back.remove(); } }, pop);
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);

  const fmtWhen = (ts) => {
    const d = new Date(ts); if (isNaN(d.getTime())) return '';
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return '방금';
    if (s < 3600) return Math.floor(s / 60) + '분 전';
    if (s < 86400) return Math.floor(s / 3600) + '시간 전';
    if (s < 604800) return Math.floor(s / 86400) + '일 전';
    return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  };

  api(sUrl('/prompts')).then((d) => {
    const prompts = (d && d.prompts) || [];
    const total = (d && d.total) || prompts.length;
    if (!prompts.length) {
      body.replaceChildren(el('div', { class: 'q-empty', text: (d && d.found) ? '이 세션에서 보낸 질문이 아직 없어요.' : '이 세션의 대화 기록을 찾지 못했어요.' }));
      return;
    }
    const multiAuthor = new Set(prompts.map((p) => p.author).filter(Boolean)).size > 1;
    const search = el('input', { class: 'q-search', type: 'search', placeholder: '이 세션의 질문 검색…' });
    const cap = el('div', { class: 'q-cap' });
    const list = el('div', { class: 'q-list' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const terms = q ? q.split(/\s+/).filter(Boolean) : [];
      const seq = prompts.map((p, i) => ({ p: p, num: i + 1 })).reverse(); // 최신 우선 + 원래 순번(#)
      const shown = terms.length ? seq.filter((x) => { const t = x.p.text.toLowerCase(); return terms.every((w) => t.indexOf(w) >= 0); }) : seq;
      cap.textContent = terms.length
        ? (shown.length + ' / ' + total + '개 일치')
        : (total + '개 질문 · 최신순' + (total > prompts.length ? ' (최근 ' + prompts.length + '개)' : '') + ' — 클릭하면 그 위치로 이동');
      list.replaceChildren();
      if (!shown.length) { list.append(el('div', { class: 'q-empty', text: '일치하는 질문이 없어요.' })); return; }
      shown.forEach((x) => {
        // 작성자 배지 — 이 세션에 질문한 사람이 둘 이상일 때만(혼자 쓴 세션엔 소음).
        const who = multiAuthor && x.p.author ? el('span', { class: 'q-who', title: '이 질문을 보낸 사람', text: x.p.author }) : null;
        list.append(el('div', { class: 'q-item', title: '클릭하면 터미널에서 이 질문 위치로 이동', onclick: () => { back.remove(); jumpToPrompt(x.p.text); } },
          el('div', { class: 'q-meta' },
            el('span', { class: 'q-num', text: '#' + x.num }), ...(who ? [who] : []), el('span', { class: 'q-when', text: fmtWhen(x.p.ts) }),
            el('span', { class: 'q-spacer' }),
            el('button', { class: 'q-copy', title: '이 질문 텍스트 복사', text: '복사', onclick: (e) => { e.stopPropagation(); copyText(x.p.text, false, true); } })),
          el('div', { class: 'q-text', text: x.p.text })));
      });
    };
    search.addEventListener('input', draw);
    body.replaceChildren(search, cap, list);
    draw();
    setTimeout(() => { try { search.focus(); } catch (_) { /* noop */ } }, 0); // 터미널이 아니라 검색창이 키를 받게
  }).catch((e) => {
    body.replaceChildren(el('div', { class: 'q-empty', text: '질문을 불러오지 못했어요 — ' + ((e && e.message) || e) }));
  });
}

// ── 부팅 ──
function gate(msg) { document.getElementById('root').replaceChildren(el('div', { class: 'gate-msg', text: msg })); }

// 미인증 진입 안내 — 메인 UI 로그인은 이메일+비밀번호(세션 쿠키)다. 이 탭은 그대로 두고, 새 탭에서 로그인한 뒤
//  '다시 시도'를 누르면 같은 origin 세션 쿠키가 공유되어 곧바로 연결된다(세션 주소를 잃지 않게 새 탭으로 연다).
function gateLogin() {
  document.getElementById('root').replaceChildren(
    el('div', { class: 'gate-card' },
      el('div', { class: 'gate-icon', text: '🔒' }),
      el('h2', { class: 'gate-title', text: '로그인이 필요해요' }),
      el('p', { class: 'gate-sub', text: '이 터미널 세션을 열려면 먼저 라이블리에 로그인하세요. 새 탭에서 로그인한 뒤 이 페이지로 돌아와 ‘다시 시도’를 누르면 바로 연결됩니다.' }),
      el('a', { class: 'gate-cta', href: apiUrl('/ui/'), target: '_blank', rel: 'noopener', text: '새 탭에서 로그인하기 →' }),
      el('button', { class: 'gate-retry', text: '로그인했어요 — 다시 시도', onclick: () => boot() })));
}

// 상단 제목(+브라우저 탭 제목)을 세션 이름으로 — 갱신을 한 곳으로 모은다(라이브 반영 공용).
function setTitle(label) {
  if (!label || !titleEl) return;
  titleEl.textContent = label;
  document.title = label + ' · Lively';
}
// 이 세션이 프로젝트 세션이면 상단 '프로젝트 페이지' 버튼을 그 프로젝트로 링크하고 표시(개인 세션이면 계속 숨김).
//  새 탭으로 SPA 앱의 프로젝트 페이지(#/projects2/p/<id>)를 연다 — 세션 화면(그리드 셀 포함)을 잃지 않는다.
function setProjectLink(projectId) {
  if (!projectBtnEl || !(projectId > 0)) return;
  projectBtnEl.href = apiUrl('/ui/#/projects2/p/') + projectId;
  projectBtnEl.style.display = '';
}
// 세션 메타(이름·프로젝트) — id 로 서버의 '현재 값'을 읽는다(프로젝트/팀 세션 포함). 실패하면 URL ?label= 폴백.
//  생성 시점 ?label= 에 고정되지 않으므로 새로고침·재진입 시에도 바뀐 이름·프로젝트 링크가 보인다.
async function loadSessionMeta() {
  let data = null;
  try { data = await api(sUrl('')); } catch (_) { /* 무시하고 폴백 */ }
  if (data && data.label) setTitle(data.label);
  else if (SESSION_LABEL) setTitle(SESSION_LABEL);
  if (data) setProjectLink(Number(data.projectId) || 0);
  sessionProjectId = (data && Number(data.projectId)) || 0;
  showDropHint(); // 메타를 받은 뒤에 띄운다 — 업로드 위치 문구가 프로젝트/개인 세션에 따라 갈리므로(#1235)
}

export async function boot() {
  const p = prefs();
  scrollSpeed = Math.max(1, Math.min(12, Number(p.scrollSpeed) || 3));
  padGain = Math.max(0.5, Math.min(6, Number(p.padGain) || 3));
  applyChrome(p.theme);
  if (!SESSION_ID) { gate('세션이 지정되지 않았습니다. 세션 목록에서 "열기"로 진입하세요.'); return; }
  if (!window.Terminal || !window.FitAddon) { gate('터미널 라이브러리(xterm) 로드 실패.'); return; }
  // 인증은 '토큰 유무'가 아니라 서버에 물어 확인한다 — 세션 쿠키(웹 로그인)·bearer(에이전트) 모두 /api/ui/me 가 수용.
  //  메인 UI 가 이메일+비번 로그인(세션 쿠키)로 바뀌며 localStorage 토큰이 없는 게 정상이 됐다(옛 토큰 게이트가 오인 차단했다).
  gate('연결 준비 중…');
  try { await api('/api/ui/me'); }
  catch (_) { gateLogin(); return; }

  // 셸 구성
  explorerEl = el('aside', { id: 'explorer' },
    el('div', { class: 'exp-head' }, el('span', { text: '파일' }), el('span', { class: 'spacer' }),
      el('button', { class: 'tbtn', text: '＋폴더', title: '새 폴더', onclick: newFolder }),
      el('button', { class: 'tbtn', text: '⬆', title: '업로드', onclick: startUpload }),
      el('button', { class: 'tbtn', text: '⟳', title: '새로고침', onclick: () => loadDir(curDir) })),
    el('div', { id: 'exp-path', class: 'exp-path' }), el('div', { id: 'exp-list' }));
  statusEl = el('span', { class: 'status', text: '연결 중…' });
  // 제목 = 세션 이름(라벨). URL ?label= 이 있으면 즉시 그 이름, 없으면 '터미널' → loadSessionMeta 가 보정. id 는 tooltip.
  titleEl = el('span', { class: 'title', text: SESSION_LABEL || '터미널', title: SESSION_ID });
  if (SESSION_LABEL) document.title = SESSION_LABEL + ' · Lively';
  // 프로젝트 세션이면 상단에서 그 프로젝트 페이지로 바로 이동 — 초기엔 숨김. loadSessionMeta 가 projectId 를 받으면 링크·표시.
  projectBtnEl = el('a', { class: 'tbtn', href: apiUrl('/ui/'), target: '_blank', rel: 'noopener',
    text: '🗂 프로젝트 페이지', title: '이 세션이 속한 프로젝트 페이지 열기(새 탭)',
    style: 'display:none; text-decoration:none' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'tbtn', text: '📁 파일 탐색기', title: '파일 탐색기 열기/닫기 (업로드·다운로드)', onclick: toggleExplorer }),
    projectBtnEl, titleEl,
    el('span', { class: 'spacer' }), statusEl,
    // #1018 로 임시로 숨겼던 버튼을 #1062 에서 되살렸다 — 당시 '제대로 작동하지 않던' 원인은 목록 수집이었다:
    //  서버가 공유 ~/.claude 의 **최신 대화 파일 하나**만 읽어, 멤버 프로필(#1014 이후 세션의 실제 기록 위치)과
    //  같은 폴더의 다른 대화가 통째로 빠졌다. 이제 전부 합쳐 준다(src/terminal-transcript.ts).
    //  '그 위치로 이동'은 여전히 화면 탐색 휴리스틱이라 못 찾을 수 있는데, 그 경우엔 조용히 실패하지 않고 토스트로 알린다.
    //  ⚠ 이 버튼은 그리드 각 셀(iframe=이 페이지)마다 하나씩 있어야 한다 — 그리드 상단 통합검색은 대체재가 아니다.
    el('button', { class: 'tbtn', text: '💬 질문', title: '이 세션에서 AI 에게 보낸 질문 전부(누가 보냈든) — 클릭하면 그 위치로 이동', onclick: openMyPrompts }),
    el('button', { class: 'tbtn', text: '⟳ 화면 복구', title: '화면이 깨지거나 어긋났을 때 재연결로 복구(소프트 새로고침)', onclick: softReconnect }),
    el('button', { class: 'tbtn', text: '⚙ 환경 설정', onclick: openSettings }),
    el('button', { class: 'tbtn', text: 'ⓘ 사용법 안내', title: '터미널·단축키 간단 사용법', onclick: openHelp }));
  const host = el('div', { id: 'term-host' });
  termPane = el('div', { class: 'pane active' }, host);
  tabbarEl = el('div', { id: 'tabbar' });
  panesEl = el('div', { id: 'panes' }, termPane);
  const main = el('div', { id: 'main' }, toolbar, tabbarEl, panesEl);
  document.getElementById('root').replaceChildren(el('div', { id: 'ws' }, explorerEl, main));
  tabs.push({ id: 'term', label: '터미널', pane: termPane, closable: false });
  renderTabbar();
  setupDnd();
  setupTermDrop();
  loadSessionMeta();

  // 이름 라이브 반영 — 다른 탭(프로젝트/세션 매니저)에서 이름을 바꾸면 같은 브라우저 안에선 즉시 받는다.
  try {
    const ch = new BroadcastChannel('lively-terminal');
    ch.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.type === 'session-label' && m.id === SESSION_ID && m.label) setTitle(m.label);
    };
  } catch (_) { /* BroadcastChannel 미지원 — 포커스 복귀/새로고침 시 서버값으로 보정 */ }
  // 폴백 보정 — 이 탭이 다시 보일 때 서버의 현재 이름을 다시 읽는다(BroadcastChannel 미지원·타 브라우저·기기 케이스).
  //  한 창의 탭 전환은 window 'focus' 가 안 뜨고 'visibilitychange' 만 뜨므로 둘 다 건다.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadSessionMeta(); });
  window.addEventListener('focus', () => { loadSessionMeta(); });

  // xterm — control mode 에선 tmux 가 화면을 안 그리고 pane 출력을 스트림으로 보내므로 스크롤백을 xterm 이
  //  직접 소유한다(iTerm 처럼). 그래서 scrollback 을 충분히 둔다 → 휠 스크롤이 로컬 버퍼를 직접 오르내리고
  //  resume/재출력이 신선하게 반영(옛 tmux copy-mode 의 '얼어붙은 히스토리' 문제 해소). 옛 줄중복은 우리가
  //  tmux 전체 재그림이 아니라 pane 출력만 받으므로 구조적으로 발생하지 않는다. 렌더러는 WebGL(폴백 Canvas).
  term = new Terminal({
    fontFamily: p.fontFamily, fontSize: p.fontSize, cursorStyle: p.cursorStyle, cursorBlink: true,
    theme: (THEMES[p.theme] || THEMES.dark).theme, scrollback: 10000, allowProposedApi: true,
    // tmux mouse on 이라도 선택할 수 있게: macOS 는 Option+드래그(iTerm 습관), 공통으로 Shift+드래그.
    macOptionClickForcesSelection: true, rightClickSelectsWord: true,
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  loadRenderer();
  loadTermFonts();        // 웹폰트 다운로드를 즉시 시작(WS 핸드셰이크와 병렬) — onopen 의 재측정이 빨리 확정되도록
  setupClipboard();
  setupPaste();
  setupWheel();
  setupTouch();           // 모바일 터치 스와이프 스크롤(#585)
  setupOscClipboard();    // 앱 OSC52 복사 신호 → 맥북 클립보드에 조용히 씀 (#972 · #252 방식 복원, 배너 없음)
  setupTextareaHygiene(); // 히든 textarea 잔류물 유휴 청소 — '키만 눌러도 특정 문자열 입력' 근본 차단(#1117 버그A)
  setupImeTrace();        // 조합 이벤트·전송 바이트 트레이스 — 사파리 한글 깨짐(선재 버그) 규명용(#1117)
  setupWebkitImeAdapter(); // 사파리 무조합이벤트 IME 어댑터 — 음절 확정 시점 단일 전송(#1300)
  applyFit();
  window.addEventListener('resize', doResize);
  // window.resize 만으로는 '호스트가 0→풀사이즈로 처음 레이아웃되는 순간'을 못 잡는다(창은 리사이즈된 적
  //  없으므로). 그 타이밍에 fit 이 한 번 작게 잡히면 80x24 기본으로 굳어 화면을 안 채운다 → 호스트를
  //  ResizeObserver 로 직접 감시해 초기 사이징·탐색기 폭변화까지 모두 재맞춤(observe 시 1회 즉시 발화).
  try { if (window.ResizeObserver) { const ro = new ResizeObserver(doResize); ro.observe(host); } } catch (_) { /* noop */ }

  // 입력 핸들러는 '한 번만' 등록(재연결마다 붙이면 키 입력이 중복 전송됨). 본체는 handleTermData(최상위) —
  //  회귀 테스트가 실제 배선 그대로 직접 호출할 수 있게 분리(#1117). userTyped(#1059)·드리프트 가드(#1302)도 본체에.
  term.onData(handleTermData);
  // 탭이 백그라운드→포그라운드로 돌아올 때: 끊겨 있으면 재연결, 연결돼 있으면 '이 탭'으로 창 크기를 다시 요구한다.
  //  서버는 window-size latest 라, 지금 보는 탭이 refresh-client 를 보내 '최근 활동'이 되면 pane 이 이 탭 크기로
  //  맞춰져 깨짐이 풀린다(다른 탭·잔존 연결이 더 큰 pane 을 잡고 있던 경우의 #252 증상 회복). forceRedraw =
  //  fit + refresh-client 재전송 + (control) 재캡처 → 크기 재요구와 깨끗한 재그림을 한 번에.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!ws || ws.readyState >= 2) { reconnectDelay = 1000; connectNow(); }
    else if (ws.readyState === 1) forceRedraw();
  });
  // 다른 브라우저 창에서 이 창으로 전환(같은 창 탭전환은 visibilitychange, 창 전환은 focus)될 때도 동일하게 크기 재요구.
  window.addEventListener('focus', () => { if (ws && ws.readyState === 1) forceRedraw(); });

  connectNow();
}

// 게이트웨이 재배포 등으로 끊겨도 tmux 세션은 살아있다 → 자동 재연결(티켓 재발급 후 같은 세션 재attach).
let reconnectTimer = null, reconnectDelay = 1500, wasConnected = false, connecting = false, attempts = 0;
// 4403(입장 거부)이 '일시적'일 수 있다(#687): 재배포 직후 tmux 과부하로 서버가 세션 소유자 메타를 못 읽으면
//  canAttach 가 false→4403 을 내는데, 이건 진짜 권한거부가 아니라 곧 풀리는 일시장애다. 그래서 4403 을 바로
//  영구 게이트로 띄우지 않고 이 횟수만큼 재시도한다 — 일시장애면 그 사이 복구돼 붙고, 진짜 거부면 계속 4403 이라
//  MAX 후 게이트로 간다(무한 재연결 방지 취지는 보존). 성공 연결(onopen) 시 0 으로 리셋.
// ⚠ 세션이 '진짜 종료'된 경우는 4403 이 아니라 4410(session-gone)으로 온다(#835) — 서버가 tmux 에게 확답을
//  받았을 때만 보낸다. 그래야 '살아있는데 죽었다고 오인'(#687) 없이 '죽었는데 영원히 재접속중'을 없앨 수 있다.
let denyRetries = 0; const MAX_DENY_RETRIES = 5;
let sessionEnded = false; // 4410 수신 = 세션 종료 확정 → 재연결 영구 중단(아래 endSession)
function scheduleReconnect(label) {
  clearTimeout(reconnectTimer);
  if (sessionEnded) return;
  attempts++;
  // 재시도 횟수를 같이 보여준다 — '멈춘 것처럼 보이는 재접속중'이 아니라 '지금 몇 번째로 시도 중'임을 알린다.
  try {
    statusEl.textContent = label + (attempts > 1 ? ' (' + attempts + '회째)' : '');
    statusEl.className = 'status err';
  } catch (_) { /* noop */ }
  reconnectTimer = setTimeout(connectNow, reconnectDelay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000); // 지수 백오프, 최대 5s
}
// 세션 종료 확정(#835) — 재연결을 멈추고 '닫힘'을 명시한다. 게이트로 화면을 덮지 않는 이유: 마지막 출력이
//  사용자에게 가장 필요한 정보다(무슨 일이 있었는지 읽고 복사해야 한다). 그래서 터미널은 그대로 두고
//  상단에 종료 배너 + 상태 pill 만 바꾸고, 입력만 막는다.
function endSession(opts?) {
  if (sessionEnded) return;
  sessionEnded = true;
  clearTimeout(reconnectTimer);
  try { if (ws && ws.readyState <= 1) ws.close(); } catch (_) { /* noop */ }
  try { statusEl.textContent = '세션 종료됨'; statusEl.className = 'status end'; } catch (_) { /* noop */ }
  try { term.options.disableStdin = true; term.blur(); } catch (_) { /* noop */ }
  if (!document.title.startsWith('(종료됨)')) document.title = '(종료됨) ' + document.title;
  showEndedBar(opts || {});
}
// 종료 배너 — 기본은 '이 세션은 종료되었습니다', #1059 E 의 복원 가능 세션이면 문구·CTA 를 그에 맞게 바꾼다.
//  게이트로 화면을 덮지 않는 이유: 마지막 출력이 사용자에게 가장 필요한 정보다(무슨 일이 있었는지 읽고 복사해야 한다).
function showEndedBar(o) {
  const main = document.getElementById('main');
  if (!main) return;
  const old = main.querySelector('.ended-bar');
  if (old) old.remove(); // 복원 시도 중 배너 → 결과 배너로 교체
  const txt = el('span', { class: 'ended-txt' }, el('b', { text: o.title || '이 세션은 종료되었습니다.' }), ' ' + (o.body
    || '세션이 끝났거나(exit) 삭제되어 서버에 더 이상 없습니다 — 접속 오류가 아닙니다. 아래 마지막 화면은 그대로 읽고 복사할 수 있어요.'));
  const bar = el('div', { class: 'ended-bar' + (o.info ? ' info' : '') }, el('span', { class: 'ended-ic', text: o.icon || '⏹' }), txt);
  if (o.restoreBtn) { // 내가 /exit 로 끝낸 세션 — 되살릴지는 사용자가 정한다(자동 복원 안 함).
    const rb = el('button', { class: 'ended-cta', text: o.restoreLabel || '다시 열기' });
    rb.onclick = () => { rb.disabled = true; rb.textContent = '여는 중…'; restoreThisSession(); };
    bar.append(rb);
  }
  bar.append(el('a', { class: 'ended-cta', href: apiUrl('/ui/#/terminal'), target: '_blank', rel: 'noopener', text: '세션 목록 열기 →' }));
  main.insertBefore(bar, panesEl);
}

// ── #1059 E — 이 화면에서의 lazy 복원 ──
// 4410(세션 종료 확정) 을 받으면, 그 세션이 '복원 가능'(desired-state 가 DB 에 남음)인지 서버에 묻고 되살린다.
//  종전엔 복원 경로가 목록 화면의 [복원] 버튼뿐이라, 세션 링크로 바로 들어온 사람은 종료 배너만 보고 목록으로
//  되돌아가야 했다. E 의 설계는 원래 '부팅 시 전부 자동 spawn 하지 않고 열 때 resume' 이고, 이 화면이 그 '열 때'다.
//  자동 복원은 **중단된 세션(재부팅·자동회수)만** — 내가 /exit 로 끝낸 세션(exitedByUser)은 되살아나는 게 의도와
//  어긋나므로 버튼으로 둔다. 노드 세션(#869)은 중앙 desired-state 가 없어 복원 대상이 아니다.
// 4410 뒤 무엇을 할지 — 순수 판정(scripts/terminal-restore-gate.test.mjs 가 이 표를 지킨다).
//  'end'=종료 배너(종전 동작) · 'notowner'=중단됐지만 남의 세션 · 'ask'=버튼으로 물어봄 · 'auto'=자동 복원.
export function goneMode(meta, isNode, alreadyRestored, typed) {
  if (isNode) return 'end';                       // 노드 세션(#869)은 중앙 desired-state 가 없어 복원 대상이 아니다
  if (!meta || !meta.restorable) return 'end';    // 기록이 없거나 남의 세션(403) — 진짜 끝난 세션
  if (!meta.canRestore) return 'notowner';        // 프로젝트 세션이라 보이지만 복원은 소유자 몫
  // 내가 끝냈다는 신호가 있으면 되살리지 않고 **묻는다**. 신호는 두 갈래 — 훅 기록(exitedByUser) 또는 이 탭의 입력.
  //  ⚠ exitedByUser 를 loop 보다 앞세운다: 복원해서 쓰다가 또 exit 한 경우까지 loop 로 잡으면 '대화를 못 찾았다'는
  //   엉뚱한 설명이 뜬다(2026-07-28 실측 신고).
  if (meta.exitedByUser || typed) return 'ask';
  // claude 가 아닌 세션(셸·코덱스)은 자동 복원하지 않는다. ① 이어받을 대화가 없어 복원의 이득이 없고(--resume 무의미)
  //  ② claude 훅이 없어 '사용자가 exit 했다'를 **원리적으로** 기록할 수 없다 → 자동 복원하면 셸에서 exit 한 것을
  //  무조건 되살려 exit 가 안 먹히는 UX 가 된다(실측 신고: 셸에서 exit → 자동 복원 → 또 exit → 루프 배너).
  if (meta.harness && meta.harness !== 'claude') return 'ask';
  if (alreadyRestored) return 'loop';             // 복원으로 열린 세션이 사용자 의도 없이 또 끊겼다 — 루프 차단
  return 'auto';                                  // 중단됨(재부팅·자동회수)인 claude 세션 = 자동 복원의 정확한 타깃
}
let restoreTried = false;
// 이 탭에서 사용자가 키를 눌렀나 — 자동 복원 금지의 **1차 신호**. 훅 기록(exited_at)은 claude 세션에만 있고
//  그마저 실패할 수 있는데, '링크를 열었더니 죽어 있다'(자동 복원의 목적)와 '내가 만지다 끝냈다'는 이 한 비트로
//  거의 정확히 갈린다 — exit·Ctrl-D·kill 은 전부 입력을 수반한다.
let userTyped = false;
async function onSessionGone() {
  if (sessionEnded || restoreTried) { endSession(); return; }
  restoreTried = true;
  clearTimeout(reconnectTimer);
  let meta = null;
  if (!NODE_ID) { try { meta = await api(sUrl('')); } catch (_) { /* 403(남의 세션)·기록 없음 → 일반 종료 배너 */ } }
  const mode = goneMode(meta, !!NODE_ID, RESTORED, userTyped);
  if (mode === 'end') { endSession(); return; }
  if (mode === 'loop') {
    // 복원은 됐는데 그 세션이 곧 또 끝났다. 가장 흔한 원인은 '이어받을 대화가 없음'(claude 가
    //  "No conversation found with session ID: …" 를 뱉고 즉시 종료 → exec 라 tmux 세션도 사라진다).
    //  자동으로 또 되살리면 루프가 되므로, 여기서 멈추고 사용자에게 맡긴다.
    endSession({ info: true, icon: '↻', title: '이어서 열었지만 세션이 곧 다시 종료됐어요.',
      body: '이어받을 대화를 찾지 못했을 수 있어요(예: 그 대화 기록이 이 폴더에 없음). 아래 버튼으로 다시 시도하면 대화 목록에서 직접 고를 수 있습니다.',
      restoreBtn: true, restoreLabel: '대화 목록에서 고르기' });
    return;
  }
  if (mode === 'notowner') {
    endSession({ info: true, icon: '↻', title: '이 세션은 중단되어 있습니다.', body: '이어서 여는 건 세션을 만든 사람만 할 수 있어요. 아래 마지막 화면은 그대로 읽고 복사할 수 있습니다.' });
    return;
  }
  if (mode === 'ask') {
    // 같은 'ask' 라도 왜 멈췄는지가 다르다 — 사유를 정확히 말한다(틀린 설명이 오해를 만든다).
    const shellish = !!(meta.harness && meta.harness !== 'claude');
    endSession(shellish
      ? { info: true, title: '이 세션은 종료되었습니다.',
          body: '이어받을 대화가 없는 세션(' + (meta.harness === 'shell' ? '셸' : meta.harness) + ')이에요. 같은 폴더·설정으로 다시 열 수 있습니다.',
          restoreBtn: true, restoreLabel: '다시 열기' }
      : meta.exitedByUser
      ? { info: true, title: '이 세션은 종료되었습니다.',
          body: '직접 종료(exit)한 세션이에요. 그때 대화를 이어서 다시 열 수 있습니다.', restoreBtn: true }
      : { info: true, title: '이 세션이 방금 끝났습니다.',
          body: '이 탭에서 조작한 뒤 끝났어요 — 직접 종료한 것이면 그대로 두시면 됩니다. 아니라면 대화를 이어서 다시 열 수 있습니다.',
          restoreBtn: true });
    return;
  }
  // 중단됨(재부팅·자동회수) — 자동 복원. 진행 상태를 배너로 알린다(조용히 새 세션으로 바뀌면 무슨 일이 났는지 모른다).
  //  ⚠ sessionEnded 를 먼저 세운다 — 아래 ws.close() 의 onclose 가 재연결 스케줄러를 깨우면 복원 중에 죽은 id 로
  //   계속 재접속을 시도한다(scheduleReconnect 의 유일한 정지 조건이 이 플래그). 복원되면 새 주소로 갈아타므로
  //   이 화면이 다시 붙을 일은 없다.
  sessionEnded = true;
  try { term.options.disableStdin = true; term.blur(); } catch (_) { /* noop */ }
  try { statusEl.textContent = '이어서 여는 중…'; statusEl.className = 'status'; } catch (_) { /* noop */ }
  showEndedBar({ info: true, icon: '↻', title: '중단된 세션을 이어서 여는 중…',
    body: '재부팅이나 자동 회수로 멈춘 세션이에요. 같은 폴더·설정으로 다시 열고 대화를 이어받습니다.' });
  restoreThisSession();
}
// 복원 실행 — 목록 카드 [복원] 과 같은 엔드포인트. 새 세션은 새 id 를 받으므로 그 주소로 갈아탄다(현재 URL 은 죽은 id).
async function restoreThisSession() {
  try { if (ws && ws.readyState <= 1) ws.close(); } catch (_) { /* noop */ }
  let r = null;
  try { r = await api(sUrl('/restore'), { method: 'POST', body: '{}' }); }
  catch (e) {
    sessionEnded = true;
    showEndedBar({ title: '열지 못했습니다.', body: (e && e.message || String(e)) + ' — 세션 목록에서 다시 시도해 주세요.' });
    return;
  }
  // 라이브 경합: 그새 세션이 다시 떠 있으면 새로 만들지 않고 이 주소로 그대로 재연결한다.
  if (r && r.already) { location.reload(); return; }
  const ns = r && r.session;
  if (ns && ns.id) {
    // restored=1 — 이 표식이 있는 페이지는 다시 자동 복원하지 않는다(루프 차단, 위 goneMode).
    location.replace(apiUrl('/ui/terminal.html?session=') + encodeURIComponent(ns.id)
      + '&label=' + encodeURIComponent(ns.label || SESSION_LABEL || '') + '&restored=1');
    return;
  }
  sessionEnded = true;
  showEndedBar({ title: '열지 못했습니다.', body: '서버가 새 세션을 돌려주지 않았어요 — 세션 목록에서 다시 시도해 주세요.' });
}
async function connectNow() {
  if (sessionEnded) return; // 종료 확정 세션 — 어떤 트리거(탭 복귀·포커스)로도 다시 붙지 않는다
  if (connecting) return;
  if (ws && ws.readyState <= 1) return; // 이미 OPEN/CONNECTING
  connecting = true;
  clearTimeout(reconnectTimer);
  // 재기동 시 인메모리 티켓이 비워지므로 매 연결마다 티켓을 새로 발급받는다.
  //  ⚠ 티켓은 **본체**에 발급받는다(mainOrigin) — 바로 아래 WS 가 본체로 붙으므로 짝이 맞아야 한다.
  try { await api('/api/ui/terminal/ticket', { method: 'POST', mainOrigin: true }); }
  catch (e) { connecting = false; scheduleReconnect('게이트웨이 응답 없음 — 재연결 중…'); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(proto + '://' + location.host + '/terminal/ws?session=' + encodeURIComponent(SESSION_ID) + nodeQ('&'));
  sock.binaryType = 'arraybuffer'; // 서버가 raw 바이트(바이너리)로 보냄 → 바이트 레벨 파싱(멀티바이트 경계 안전)
  ws = sock;
  // 연결마다 새 control 파서(각 tmux -CC 스트림은 자기 도입자로 시작). 도입자 없으면 raw 모드로 자동 폴백.
  ctrl = makeControl({
    write: (str) => { try { term.write(str); } catch (_) { /* noop */ } },
    // 상태 블록(백필 직전) — tmux pane 실상태로 alt-screen·마우스모드를 '지금' 동기화하고, 커서 좌표를 백필용으로 담아둠(#1092).
    state: (line) => { try { dlog('state', diagPreview(line, 96)); applyPaneState(parsePaneState(line)); } catch (_) { /* noop */ } },
    // 백필(capture 스냅샷)은 '현재 화면 전체'다 → 쓰기 전 화면+스크롤백을 비워(\e[H\e[2J\e[3J) 첫 연결 중
    //  attach~capture 사이에 먼저 흘러든 라이브 %output 과 겹쳐 줄이 중복되는 것을 막는다. 이후 라이브는 그대로 append.
    backfill: (text) => {
      try {
        const st = pendingPaneState; pendingPaneState = null;
        dlog('backfill', 'len=' + text.length + (st ? ' +state' : ''));
        // 상태 블록을 받았으면 alt/mouse 는 applyPaneState 가 이미 진실로 동기화함(이 백필 직전). 못 받은 경우(구 서버)만
        //  옛 #252 추측 폴백: 마우스모드 ON + normal buffer 면 alt-screen 진입 보정(신선 클라·셸엔 무영향, 가드).
        if (!st && term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'
            && term.buffer && term.buffer.active && term.buffer.active.type !== 'alternate') {
          term.write('\x1b[?1049h');
        }
        term.write('\x1b[H\x1b[2J\x1b[3J\x1b[0m'); term.write(text);
        // 커서 복원(#1092 버그2·3) — capture 텍스트엔 최종 커서위치가 없고, capture 는 pane 높이만큼(빈 줄 포함) 그려
        //  커서가 '쓴 마지막 줄'(대개 화면 맨 아래)에 남는다 → 프롬프트는 위, 입력/커서는 아래로 어긋남. tmux 실커서로 되돌린다.
        //  (cx/cy 는 0-based·가시영역 기준 → xterm CUP 은 1-based.)
        if (st && st.hasCursor) term.write('\x1b[' + (st.cy + 1) + ';' + (st.cx + 1) + 'H');
      } catch (_) { /* noop */ }
    },
    // tmux control 스트림의 %exit — 이 attach 클라가 끝났다는 뜻일 뿐, '세션이 죽었다'는 뜻은 아니다
    //  (게이트웨이 재배포로 attach PTY 가 kill 돼도 %exit 이다). 그래서 여기서 종료를 단정하지 않고, 곧바로
    //  재연결해 서버에게 물어본다(살아있으면 그대로 붙고, 진짜 없으면 4410 이 와서 종료 배너). 짧은 지연으로 빠르게 판정.
    onExit: () => { reconnectDelay = 400; try { sock.close(); } catch (_) { /* noop */ } },
  });
  sock.onopen = () => {
    dlog('ws', 'open');
    connecting = false; wasConnected = true; reconnectDelay = 1500; denyRetries = 0; attempts = 0; // 붙었으면 입장 허용 확정 → 거부 카운트 리셋
    syncedThisConn = false; // 이 연결에서 재접속 상태동기(t:'st')를 아직 안 보냄
    mouseResetTries = 0;    // 복구 시도 상한은 '연결 단위' — 새로 붙으면 다시 시도한다(그 사이 환경이 달라졌을 수 있다)
    statusEl.textContent = '연결됨'; statusEl.className = 'status ok';
    lastCols = 0; lastRows = 0; // 재attach 후 사이즈 강제 재동기화(→ control mode: refresh-client -C 재전송)
    applyFit(); setTimeout(applyFit, 350);
    initialSettleRedraw(); // 첫 연결 1회: 폰트 준비 후 자동 화면복구(초기 어긋남 방지)
    term.focus();
    if (AUTOSEND && !autosendDone) { autosendDeadline = Date.now() + 12000; autosendLastOut = Date.now(); scheduleAutosend(); }
  };
  sock.onmessage = (e) => {
    const bytes = (e.data instanceof ArrayBuffer) ? new Uint8Array(e.data) : (typeof e.data === 'string' ? new TextEncoder().encode(e.data) : null);
    if (!bytes) return;
    ctrl.feed(bytes);
    if (AUTOSEND && !autosendDone) autosendLastOut = Date.now();
    if (ctrl.isControl()) {
      // 첫 연결: 현재 화면+스크롤백 백필(상태 포함). 재연결: 백필은 생략(스크롤백 truncate 방지 — 중복 방지)하되
      //  상태만(t:'st') 1회 동기화해 재접속 갭에 놓친 마우스-off/alt-off 로 인한 stuck 을 해소(#1092 버그1).
      if (!didBackfill) { didBackfill = true; try { sock.send(JSON.stringify({ t: 'cap', n: BACKFILL_LINES, st: 1 })); } catch (_) { /* noop */ } }
      else if (!syncedThisConn) { syncedThisConn = true; try { sock.send(JSON.stringify({ t: 'st' })); } catch (_) { /* noop */ } }
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return; // 교체된 옛 소켓의 close 는 무시
    dlog('ws', 'close ' + ((e && e.code) || ''));
    connecting = false;
    if (e && e.code === 4410) { onSessionGone(); return; } // 세션 종료 확정(#835) — 복원 가능하면 되살리고(#1059 E), 아니면 종료 배너
    if (e && e.code === 4403) { // 서버가 입장 거부. 단, 일시장애(재배포 직후 tmux 과부하)로 인한 '가짜 4403'일 수 있어(#687)
      //  바로 게이트를 띄우지 않고 MAX_DENY_RETRIES 만큼 재시도 — 일시장애면 곧 복구돼 붙고, 진짜 거부면 계속 4403 이라
      //  아래 게이트로 간다(무한 재연결은 여전히 막힘). 성공 시 onopen 에서 denyRetries 리셋.
      if (++denyRetries <= MAX_DENY_RETRIES) { scheduleReconnect('연결 확인 중…'); return; }
      clearTimeout(reconnectTimer);
      gate('이 세션에 입장할 수 없습니다.\n\n프로젝트 팀원만 입장할 수 있어요. 또는 이 세션이 더 이상 프로젝트에 연결되어 있지 않을 수 있습니다(폴더 이동·프로젝트 삭제 등). 프로젝트 페이지에서 세션을 다시 확인해 주세요.');
      return;
    }
    scheduleReconnect(wasConnected ? '연결 끊김 — 재연결 중…' : '재연결 중…');
  };
  sock.onerror = () => { /* onclose 가 뒤따른다 */ };
}

let explorerLoaded = false;
function toggleExplorer() {
  explorerEl.classList.toggle('open');
  if (explorerEl.classList.contains('open') && !explorerLoaded) { explorerLoaded = true; loadDir(''); }
  setTimeout(doResize, 180); // 폭 변화 후 재맞춤(트랜지션 ~140ms)
}

