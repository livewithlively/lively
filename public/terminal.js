// 중앙 박스 — 단독 전체화면 터미널 워크스페이스(새 탭). xterm.js + 서버 node-pty(tmux).
// 좌측 접이식 파일 익스플로러(업/다운로드) · 탭 구조(터미널 + 파일 미리보기) · 보기설정(폰트/테마/크기).
// 인증: 세션 쿠키(메인 UI 이메일+비번 로그인) OR localStorage 토큰(에이전트) — 둘 다 수용(서버 sessionOrBearer).
//  진입 시 /api/ui/me 로 실제 인증을 확인(토큰 유무로 막지 않음) → ticket 쿠키 발급 → WS. md 렌더는 md.js 재사용.
'use strict';

const TOKEN_KEY = 'lively_ui_token';
const PREFS_KEY = 'lively_term_prefs';
const SESSION_ID = new URLSearchParams(location.search).get('session') || '';
// 세션 라벨 — 입장 링크가 ?label= 로 실어 보낸다(프로젝트/팀 세션은 개인 /sessions 목록에 없어 API 폴백이 못 찾음).
const SESSION_LABEL = new URLSearchParams(location.search).get('label') || '';
// 분산 노드(#869) — 이 세션이 원격 노드에서 돌면 ?node= 로 온다. WS/REST 에 그대로 실어 게이트웨이가 릴레이.
const NODE_ID = new URLSearchParams(location.search).get('node') || '';
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
  const merged = Object.assign({ fontFamily: FONTS[0].v, fontSize: 14, theme: browserDark ? 'dark' : 'light', cursorStyle: 'bar', scrollSpeed: 3 }, p);
  merged.fontFamily = withKR(merged.fontFamily);
  return merged;
}
function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* noop */ } }
function applyChrome(themeKey) {
  const t = THEMES[themeKey] || THEMES.dark;
  document.documentElement.dataset.theme = t.dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--term-bg', t.theme.background);
}

function authHeaders(extra) {
  const t = localStorage.getItem(TOKEN_KEY);
  return Object.assign({}, extra, t ? { Authorization: 'Bearer ' + t } : {});
}
async function api(path, opts = {}) {
  const headers = authHeaders(opts.headers);
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || ('요청 실패 ' + res.status));
  return data;
}
function fetchAuth(path, opts = {}) { return fetch(path, Object.assign({}, opts, { headers: authHeaders(opts.headers) })); }
const sUrl = (suffix) => '/api/ui/terminal/sessions/' + encodeURIComponent(SESSION_ID) + suffix + nodeQ(suffix.indexOf('?') >= 0 ? '&' : '?');

function toast(msg, isErr) {
  const t = el('div', { text: msg, style: 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:' + (isErr ? '#c0392b' : '#333') + ';color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:100;box-shadow:0 4px 16px rgba(0,0,0,.3)' });
  document.body.append(t); setTimeout(() => t.remove(), 2800);
}

// ── 상태 ──
let term, fit, ws, statusEl, explorerEl, tabbarEl, panesEl, termPane, titleEl;
let curDir = '';
const tabs = []; // { id, label, pane, closable }
let activeId = 'term';

let lastCols = 0, lastRows = 0, resizeTimer = null, didInitialFit = false;
let scrollSpeed = 1; // 휠 스크롤 속도 배수(환경설정에서 조절, prefs.scrollSpeed)
let shiftEnterPending = false; // Shift+Enter → 이 keydown 이 곧 낼 '\r'(onData)을 '\x1b\r'(줄바꿈)로 승격하는 1회성 플래그

// ── tmux control-mode 파서 ──
// 서버가 `tmux -CC` 로 붙으면 스트림은 화면 그림이 아니라 텍스트 프로토콜이다:
//  `\x1bP1000p` 도입자 → CRLF 줄 단위로 %output / %begin..%end / 각종 %알림.
//  %output %<pane> <value> : value 는 비출력문자·백슬래시를 8진(\ooo)으로 이스케이프 → 바이트 복원해 xterm 에 write.
//  %begin <t> <num> <flags> … %end/%error(같은 num) = 명령 응답 블록. 내용 있는 블록 = capture-pane 백필
//   (서버는 capture 외엔 '내용 있는' 명령을 내지 않는다 — send-keys/refresh-client 는 빈 응답).
// 옛 방식(plain attach)도 같은 코드로 받게: 도입자가 없으면 raw 모드로 자동 폴백(그대로 term.write).
const DCS_BYTES = [0x1b, 0x50, 0x31, 0x30, 0x30, 0x30, 0x70]; // 도입자 \x1bP1000p (바이트)
const BACKFILL_LINES = 600; // 첫 연결 시 capture-pane 로 회수할 히스토리 줄 수(현재 화면+모듈러 스크롤백 복원)
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
    if (ctrl && ctrl.isControl()) { try { ws.send(JSON.stringify({ t: 'cap', n: BACKFILL_LINES })); } catch (_) { /* noop */ } } // 깨끗이 재캡처
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
function loadTermFonts(family) {
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
function remeasureAfterFonts(family) {
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
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  } catch (_) { /* noop */ }
  try { term.focus(); } catch (_) { /* noop */ }
}
function copyText(text, silent) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).catch(() => execCopy(text));
  else execCopy(text);
  if (!silent) toast('복사됨');
}
// [#967→#762] 클립보드 불변식: **사용자의 명시적 동작 없이는 절대 클립보드를 쓰지 않는다.**
//  클립보드는 파괴적이다 — 한 번 덮이면 이전 내용이 소리 없이 사라진다. 그래서 쓰기 경로는 딱 둘:
//   ① 선택 후 Ctrl/Cmd+C (setupClipboard) ② '복사' 류 버튼 클릭. 그 외 자동 복사는 전부 제거했다.
//  · 제거: 드래그 선택 → 놓는 즉시 자동 복사(#252 copy-on-select). 미세한 클릭드래그(4px)에도 클립보드가
//    덮여 "엄한 걸 눌렀는데 복사됐다"의 주범이었다. 선택 자체는 그대로 되고, 복사만 명시적으로 한다.
//  · OSC 52 = 앱(Claude Code 등)이 '이 텍스트를 클립보드에 넣어줘'라고 터미널에 보내는 표준 신호(#252 에서
//    tmux set-clipboard 로 전달받아 자동으로 썼다). #967 이 자동 쓰기 대신 '복사 확인' 배너로 완화했지만,
//    배너조차 사용자가 원치 않는 시점(앱이 임의로 발신)에 떠서 거슬렸다(사용자 신고 #762) → **OSC52 는
//    클립보드에 아무것도 하지 않고 그냥 삼킨다(배너도 제거).** 앱 발신 복사는 무시하고, 복사가 필요하면
//    사용자가 위 두 경로(①②)로 직접 한다.
function setupOscClipboard() {
  try {
    // OSC52 를 삼켜서(true) xterm 기본 동작·앱 재처리를 막되, 클립보드엔 손대지 않는다(자동복사·배너 전면 제거 #762).
    term.parser.registerOscHandler(52, () => true);
  } catch (_) { /* noop */ }
}
// 입력(키스트로크/시퀀스)을 PTY 로 전송 — onData 와 동일 경로(터미널로 흘러 안에서 도는 프로그램이 받음).
function sendInput(d) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } } }
// 텍스트 붙여넣기 — 여러 줄(줄바꿈 포함)은 bracketed paste(\e[200~ … \e[201~)로 감싸 한 덩어리로 전달한다.
//  그래야 안에서 도는 프로그램(클로드 코드·zsh/bash)이 중간 줄바꿈을 'Enter(전송)'로 오인하지 않는다.
//  tmux control mode 에선 inner 의 DECSET 2004 가 xterm 까지 안 와 term.paste 가 감싸지 못하므로 직접 감싼다.
function pasteText(t) {
  if (!t) return;
  if (/[\r\n]/.test(t)) sendInput('\x1b[200~' + t.replace(/\r\n/g, '\n') + '\x1b[201~');
  else sendInput(t);
}
// 자동 전송 — 프로젝트 '클로드로 실행'이 만든 세션이면, 부팅이 끝나 클로드가 입력을 받을 때 프롬프트를 1회 주입.
//  ?autosend=1 + localStorage 핸드오프(같은 브라우저). 재연결엔 재전송 안 함(autosendDone).
//  ⚠ 트리거는 '출력 1.6s 침묵/12s 하드캡'으로 '시작'하되, 그것만 믿고 blind Enter 하지 않는다 — 인증 MCP·SessionStart 훅이
//   부팅 중 '침묵 갭'을 만들거나 시작 다이얼로그(신뢰폴더 등)가 떠 있으면 붙여넣기+Enter 가 씹혀 태스크가 유실됐다.
//   그래서 붙여넣은 뒤 xterm 버퍼를 readback 해 '실제로 입력창에 들어갔는지' 확인될 때만 Enter 하고, 안 됐으면 재시도한다.
//  ?welcome=1 (따라하기 투어를 마치고 만든 첫 세션)이면 온보딩 도우미를 자동으로 부른다 — 프롬프트가 고정이라
//   localStorage 핸드오프가 필요 없고, 주입은 autosend 와 같은 경로(붙여넣기 → readback 확인 → Enter)를 그대로 탄다.
//   ⚠ 이 세션은 중앙 박스(서버)에서 돈다 — 스킬이 그걸 감지해 로컬 스캔을 건너뛰고 사용법 안내로 분기한다(스킬 0단계).
const WELCOME_PROMPT = '라이블리를 이제 막 시작했어. 온보딩을 도와줘 — 내가 쓰던 기존 AI 환경(작업 메모리·개인 스킬·MCP 연결·레포)이 있으면 먼저 읽기만 해서 보여주고, 무엇을 라이블리로 올리고 무엇을 로컬에 둘지 함께 정리하자. 없으면 라이블리 사용법을 알려줘.';
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
let autosendDone = false, autosendLastOut = 0, autosendDeadline = 0, autosendTimer = null;
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
      try { toast(autosendIsWelcome ? '온보딩 도우미를 시작했어요' : '선택한 태스크를 클로드에게 전달했어요'); } catch (_) { /* noop */ }
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
// 이미지/파일을 작업폴더(cwd)의 uploads/ 로 업로드하고 그 상대경로를 입력창에 꽂는다. 웹 터미널은 이미지 바이트를
//  텍스트 스트림으로 못 흘리므로(터미널=텍스트), 파일로 올리고 경로를 입력해 안에서 도는 에이전트가 읽게 한다.
//  자동 전송 안 함 — 사용자가 설명을 덧붙여 Enter. (업로드 PUT 가 상위 폴더를 자동 생성.)
async function dropFileToAgent(file) {
  if (!file) return;
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  let name = (file.name || 'pasted').split(/[/\\]/).pop().replace(/[^\w.\-가-힣]/g, '_');
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.' + (((file.type || '').split('/')[1]) || 'png');
  const rel = 'uploads/' + stamp + '-' + name;
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
  toast('경로 삽입됨 — ' + abs + ' (설명 적고 Enter)');
  if (explorerLoaded) loadDir(curDir);
}
function setupClipboard() {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
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
    if (k === 'c' && term.hasSelection()) { copyText(term.getSelection()); return false; }
    if (k === 'v') {
      // 붙여넣기는 네이티브 paste 이벤트(setupPaste)가 처리한다 — 이미지 업로드+경로, 여러 줄은 bracketed paste.
      //  Mac Cmd+V 는 그대로 흘려 paste 이벤트가 뜨게 한다(xterm 은 Cmd 키로 셸에 아무 것도 안 보냄).
      //  Ctrl+V 는 xterm 이 \x16(SYN)을 셸로 보내는 걸 막아야 해서 가로채고, 보안 컨텍스트면 클립보드 API 로 직접 처리.
      if (e.metaKey && !e.ctrlKey) return true;
      if (navigator.clipboard && navigator.clipboard.read && window.isSecureContext) {
        navigator.clipboard.read().then(async (its) => {
          for (const it of its) {
            const t = (it.types || []).find((x) => x.startsWith('image/'));
            if (t) await dropFileToAgent(new File([await it.getType(t)], 'pasted.' + (t.split('/')[1] || 'png'), { type: t }));
            else if ((it.types || []).includes('text/plain')) pasteText(await (await it.getType('text/plain')).text());
          }
        }).catch(() => navigator.clipboard.readText().then((t) => pasteText(t)).catch(() => { /* noop */ }));
      }
      return false;
    }
    return true;
  });
}
// 붙여넣기(이미지·텍스트)를 네이티브 paste 이벤트로 처리 — 보안 컨텍스트 불문·권한 프롬프트 없이 동작(GitHub·Slack 방식).
//  capture 단계에서 xterm 텍스트영역보다 먼저 잡아 기본 붙여넣기를 막고 우리가 처리(중복 방지). 이미지=업로드+경로, 텍스트=bracketed.
function setupPaste() {
  const dz = panesEl || document.body;
  dz.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const img = [...(dt.items || [])].find((it) => it.kind === 'file' && (it.type || '').startsWith('image/'));
    if (img) {
      e.preventDefault(); e.stopImmediatePropagation();
      const blob = img.getAsFile();
      if (blob) dropFileToAgent(blob);
      return;
    }
    const text = dt.getData('text/plain') || dt.getData('text') || '';
    if (text) { e.preventDefault(); e.stopImmediatePropagation(); pasteText(text); }
  }, true);
}

// 마우스 휠 처리(속도 배수 scrollSpeed 적용, 환경설정에서 조절):
//  - normal buffer(셸 등): 로컬 스크롤백 직접 스크롤(하드 요구사항). 줄 수 × scrollSpeed.
//  - alt-screen + 앱 마우스모드(Claude Code 등): 휠을 앱으로 전달해 앱이 자기 스크롤백을 스크롤.
//     · scrollSpeed<=1(기본) → xterm 의 검증된 전달(return true) 그대로.
//     · scrollSpeed>1 → 휠 1틱당 SGR 마우스휠 이벤트를 그 개수만큼 보내(우리가 직접) 배수만큼 빠르게.
function setupWheel() {
  if (!term.attachCustomWheelEventHandler) return; // 구버전 xterm — 네이티브 휠(스크롤백 미사용 시 무동작)
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
  term.attachCustomWheelEventHandler((e) => {
    cancelPromptSeek(true); // 질문 위치 자동 탐색 중 사용자가 직접 휠을 굴리면 즉시 중단(#967)
    let alt = false, mouseOn = false;
    try { alt = term.buffer.active.type === 'alternate'; } catch (_) { /* noop */ }
    try { mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'); } catch (_) { /* noop */ }
    if (alt && mouseOn) {
      if (scrollSpeed <= 1) return true;                 // 기본 = xterm 검증 전달(회귀 없음)
      const c = cellFromEvent(e);
      const btn = e.deltaY < 0 ? 64 : 65;                // 64=휠↑ 65=휠↓ (SGR 1006)
      const reps = Math.min(Math.round(scrollSpeed), 12);
      let seq = '';
      for (let i = 0; i < reps; i++) seq += '\x1b[<' + btn + ';' + c.col + ';' + c.row + 'M';
      sendInput(seq);
      return false;
    }
    if (alt) return true;                                // 마우스모드 아닌 alt 앱(옛 pager 등) → xterm 기본
    let lines;
    if (e.deltaMode === 1) lines = e.deltaY;                 // line 단위
    else if (e.deltaMode === 2) lines = e.deltaY * term.rows; // page 단위
    else lines = e.deltaY / 18;                               // pixel → 대략 셀높이로 환산
    let n = Math.trunc(lines) || (e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0);
    if (n) { n = n * Math.max(1, Math.round(scrollSpeed)); term.scrollLines(n); }
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
  const cellH = () => {
    try {
      const scr = hostEl.querySelector('.xterm-screen') || hostEl;
      return Math.max(4, scr.getBoundingClientRect().height / term.rows);
    } catch (_) { return 17; }
  };
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
    accPx += dy;
    const h = cellH();
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
      const h = cellH();
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
async function loadDir(p) {
  curDir = p || '';
  const list = document.getElementById('exp-list');
  document.getElementById('exp-path').textContent = '/' + curDir;
  list.replaceChildren(el('div', { class: 'exp-item', text: '불러오는 중…' }));
  let data;
  try { data = await api(sUrl('/ls?path=' + encodeURIComponent(curDir))); }
  catch (e) { list.replaceChildren(el('div', { class: 'exp-item', text: '오류: ' + e.message })); return; }
  list.replaceChildren();
  if (data.parent !== null && curDir) list.append(el('div', { class: 'exp-item', onclick: () => loadDir(data.parent), title: '상위' }, el('span', { class: 'ic', text: '↩' }), '..'));
  for (const it of (data.items || [])) {
    const childPath = (curDir ? curDir + '/' : '') + it.name;
    const row = el('div', { class: 'exp-item', onclick: () => (it.type === 'dir' ? loadDir(childPath) : openPreview(childPath, it.name)) },
      el('span', { class: 'ic', text: fileIcon(it.name, it.type) }), it.name,
      it.type === 'file' ? el('span', { class: 'sz', text: fmtSize(it.size) }) : null,
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
  const input = document.getElementById('upload-input');
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
  const off = () => { dz.style.outline = ''; dz.style.outlineOffset = ''; };
  dz.addEventListener('dragover', (e) => {
    if (!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'))) return;
    e.preventDefault(); dz.style.outline = '2px dashed #4a9eff'; dz.style.outlineOffset = '-4px';
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

async function openPreview(p, name) {
  const id = 'file:' + p;
  const body = el('div', { class: 'preview-body' }, el('div', { class: 'gate-msg', text: '불러오는 중…' }));
  addPane(id, name, true, body);
  if (IMG_RE.test(name)) { renderImage(body, p, name); return; }
  if (isTextLike(name)) { renderTextPreview(body, p, MD_RE.test(name)); return; }
  // 미지원 타입 → 오버레이로 알리고 선택지 제공.
  body.replaceChildren(el('div', { class: 'unsupported' },
    el('div', { class: 'unsupported-card' },
      el('div', { class: 'unsupported-title', text: '미리보기를 지원하지 않는 파일' }),
      el('div', { class: 'unsupported-sub', text: name }),
      el('div', { class: 'unsupported-actions' },
        el('button', { class: 'tbtn', text: '그래도 미리보기', onclick: () => renderTextPreview(body, p, false) }),
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
    const text = await res.text();
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
  let curFamily = p.fontFamily;
  const apply = () => {
    const np = { fontFamily: fontSel.value, fontSize: Number(sizeI.value) || 14, theme: themeSel.value, cursorStyle: cursorSel.value, scrollSpeed: Math.max(1, Math.min(12, Number(speedI.value) || 1)) };
    term.options.fontFamily = np.fontFamily; term.options.fontSize = np.fontSize; term.options.cursorStyle = np.cursorStyle;
    term.options.theme = (THEMES[np.theme] || THEMES.dark).theme;
    scrollSpeed = np.scrollSpeed;
    savePrefs(np); applyChrome(np.theme); doResize();
    // 처음 고르는 글꼴은 아직 로드 전이라 같은 race 를 탄다 — 명시 로드 후 실제 준비 시점에 재측정.
    if (np.fontFamily !== curFamily) { curFamily = np.fontFamily; remeasureAfterFonts(np.fontFamily); }
  };
  for (const c of [fontSel, themeSel, cursorSel]) c.addEventListener('change', apply);
  sizeI.addEventListener('input', apply);
  speedI.addEventListener('input', apply);
  const back = el('div', { class: 'pop-back', onclick: (e) => { if (e.target === back) back.remove(); } },
    el('div', { class: 'pop' }, el('h3', { text: '환경 설정' }),
      el('div', { class: 'field' }, el('label', { text: '폰트' }), fontSel),
      el('div', { class: 'field' }, el('label', { text: '크기(px)' }), sizeI),
      el('div', { class: 'field' }, el('label', { text: '테마' }), themeSel),
      el('div', { class: 'field' }, el('label', { text: '커서' }), cursorSel),
      el('div', { class: 'field' }, el('label', { text: '스크롤 속도 (1~12, 클수록 빠름)' }), speedI),
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
        kb(['Shift 드래그'], 'Claude 안에서는 Shift 누른 채 드래그로 선택')),
      sec('도구 (오른쪽 위 버튼)',
        tool('내 질문', '이 세션에서 보낸 질문 목록 — 클릭하면 그 위치로 이동'),
        tool('파일 탐색기', '파일 업로드·다운로드 (끌어다 놓아도 됨)'),
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
function cancelPromptSeek(notice) {
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
  const BATCH = 6, WAIT = 110, MAX_BATCH = 600; // ≈3600틱 상한 — 그 안에 못 찾으면 포기(사용자는 언제든 키로 중단)
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
    if (iter >= MAX_BATCH || unchanged >= 5) { finish(-1); return; } // ≈550ms 무변화 = 맨 위 도달(또는 앱 무응답)
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
// '내 질문' 팝업 — #762(목록·검색, pop-help 셸)에 #967(클릭 = 그 질문 위치로 이동)을 얹었다.
//  복사는 항목의 '복사' 버튼(명시적 클릭)으로만 — 위 클립보드 불변식과 일관.
function openMyPrompts() {
  const head = el('div', { class: 'help-head' },
    el('h3', { text: '💬 내 질문' }),
    el('p', { class: 'help-intro', text: '이 세션에서 내가 보낸 질문을 최신 순으로. 클릭하면 그 질문 위치로 이동해요.' }));
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
        list.append(el('div', { class: 'q-item', title: '클릭하면 터미널에서 이 질문 위치로 이동', onclick: () => { back.remove(); jumpToPrompt(x.p.text); } },
          el('div', { class: 'q-meta' },
            el('span', { class: 'q-num', text: '#' + x.num }), el('span', { class: 'q-when', text: fmtWhen(x.p.ts) }),
            el('span', { class: 'q-spacer' }),
            el('button', { class: 'q-copy', title: '이 질문 텍스트 복사', text: '복사', onclick: (e) => { e.stopPropagation(); copyText(x.p.text); } })),
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
      el('a', { class: 'gate-cta', href: '/ui/', target: '_blank', rel: 'noopener', text: '새 탭에서 로그인하기 →' }),
      el('button', { class: 'gate-retry', text: '로그인했어요 — 다시 시도', onclick: () => boot() })));
}

// 상단 제목(+브라우저 탭 제목)을 세션 이름으로 — 갱신을 한 곳으로 모은다(라이브 반영 공용).
function setTitle(label) {
  if (!label || !titleEl) return;
  titleEl.textContent = label;
  document.title = label + ' · Lively';
}
// 세션 이름(라벨) — id 로 서버의 '현재 이름'을 읽는다(프로젝트/팀 세션 포함). 실패하면 URL ?label= 폴백.
//  생성 시점 ?label= 에 고정되지 않으므로 새로고침·재진입 시에도 바뀐 이름이 보인다.
async function loadSessionLabel() {
  try {
    const data = await api(sUrl(''));
    if (data && data.label) { setTitle(data.label); return; }
  } catch (_) { /* 무시하고 폴백 */ }
  if (SESSION_LABEL) setTitle(SESSION_LABEL);
}

async function boot() {
  const p = prefs();
  scrollSpeed = Math.max(1, Math.min(12, Number(p.scrollSpeed) || 3));
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
  // 제목 = 세션 이름(라벨). URL ?label= 이 있으면 즉시 그 이름, 없으면 '터미널' → loadSessionLabel 이 보정. id 는 tooltip.
  titleEl = el('span', { class: 'title', text: SESSION_LABEL || '터미널', title: SESSION_ID });
  if (SESSION_LABEL) document.title = SESSION_LABEL + ' · Lively';
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'tbtn', text: '📁 파일 탐색기', title: '파일 탐색기 열기/닫기 (업로드·다운로드)', onclick: toggleExplorer }),
    titleEl,
    el('span', { class: 'spacer' }), statusEl,
    el('button', { class: 'tbtn', text: '💬 내 질문', title: '이 세션에서 클로드에게 보낸 질문 목록 — 클릭하면 그 위치로 이동', onclick: openMyPrompts }),
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
  loadSessionLabel();

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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadSessionLabel(); });
  window.addEventListener('focus', () => { loadSessionLabel(); });

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
  setupOscClipboard();    // 앱 OSC52 는 무시 — 클립보드 안 건드림(#762, 배너도 제거)
  applyFit();
  window.addEventListener('resize', doResize);
  // window.resize 만으로는 '호스트가 0→풀사이즈로 처음 레이아웃되는 순간'을 못 잡는다(창은 리사이즈된 적
  //  없으므로). 그 타이밍에 fit 이 한 번 작게 잡히면 80x24 기본으로 굳어 화면을 안 채운다 → 호스트를
  //  ResizeObserver 로 직접 감시해 초기 사이징·탐색기 폭변화까지 모두 재맞춤(observe 시 1회 즉시 발화).
  try { if (window.ResizeObserver) { const ro = new ResizeObserver(doResize); ro.observe(host); } } catch (_) { /* noop */ }

  // 입력 핸들러는 '한 번만' 등록(재연결마다 붙이면 키 입력이 중복 전송됨). 현재 ws 를 참조해 전송.
  term.onData((d) => {
    cancelPromptSeek(true); // 질문 위치 자동 탐색 중 사용자가 입력하면 즉시 중단(#967 — 사용자 조작 우선)
    // Shift+Enter 승격: 이 keydown 이 낸 '\r' 을 '\x1b\r'(Option+Enter 와 동일 = 줄바꿈)로 바꿔 보낸다. 음절 등 다른 데이터는 그대로.
    if (shiftEnterPending && d === '\r') { shiftEnterPending = false; d = '\x1b\r'; }
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } }
  });
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
function endSession() {
  if (sessionEnded) return;
  sessionEnded = true;
  clearTimeout(reconnectTimer);
  try { if (ws && ws.readyState <= 1) ws.close(); } catch (_) { /* noop */ }
  try { statusEl.textContent = '세션 종료됨'; statusEl.className = 'status end'; } catch (_) { /* noop */ }
  try { term.options.disableStdin = true; term.blur(); } catch (_) { /* noop */ }
  if (!document.title.startsWith('(종료됨)')) document.title = '(종료됨) ' + document.title;
  const main = document.getElementById('main');
  if (!main || main.querySelector('.ended-bar')) return;
  main.insertBefore(el('div', { class: 'ended-bar' },
    el('span', { class: 'ended-ic', text: '⏹' }),
    el('span', { class: 'ended-txt' },
      el('b', { text: '이 세션은 종료되었습니다.' }),
      ' 세션이 끝났거나(exit) 삭제되어 서버에 더 이상 없습니다 — 접속 오류가 아닙니다. 아래 마지막 화면은 그대로 읽고 복사할 수 있어요.'),
    el('a', { class: 'ended-cta', href: '/ui/#/terminal', target: '_blank', rel: 'noopener', text: '세션 목록 열기 →' })), panesEl);
}
async function connectNow() {
  if (sessionEnded) return; // 종료 확정 세션 — 어떤 트리거(탭 복귀·포커스)로도 다시 붙지 않는다
  if (connecting) return;
  if (ws && ws.readyState <= 1) return; // 이미 OPEN/CONNECTING
  connecting = true;
  clearTimeout(reconnectTimer);
  // 재기동 시 인메모리 티켓이 비워지므로 매 연결마다 티켓을 새로 발급받는다.
  try { await api('/api/ui/terminal/ticket', { method: 'POST' }); }
  catch (e) { connecting = false; scheduleReconnect('게이트웨이 응답 없음 — 재연결 중…'); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(proto + '://' + location.host + '/terminal/ws?session=' + encodeURIComponent(SESSION_ID) + nodeQ('&'));
  sock.binaryType = 'arraybuffer'; // 서버가 raw 바이트(바이너리)로 보냄 → 바이트 레벨 파싱(멀티바이트 경계 안전)
  ws = sock;
  // 연결마다 새 control 파서(각 tmux -CC 스트림은 자기 도입자로 시작). 도입자 없으면 raw 모드로 자동 폴백.
  ctrl = makeControl({
    write: (str) => { try { term.write(str); } catch (_) { /* noop */ } },
    // 백필(capture 스냅샷)은 '현재 화면 전체'다 → 쓰기 전 화면+스크롤백을 비워(\e[H\e[2J\e[3J) 첫 연결 중
    //  attach~capture 사이에 먼저 흘러든 라이브 %output 과 겹쳐 줄이 중복되는 것을 막는다. 이후 라이브는 그대로 append.
    backfill: (text) => {
      try {
        // [#252] 재접속 alt-screen 보정. Claude Code 등 풀스크린 TUI 는 alt-screen + 마우스모드(1003/1006)인데,
        //  '이미 실행 중인' 세션에 나중에 붙은 클라는 최초의 alt-screen 진입(\e[?1049h)을 스트림에서 못 받아
        //  normal buffer 로 남는다(마우스모드는 재렌더로 받아 mouseTrackingMode 는 켜짐). 그러면 휠이 앱으로
        //  전달되지 않고 빈 로컬 스크롤백만 긁어 '스크롤이 안 되는' #252 증상. 앱이 마우스모드인데 클라가 normal
        //  이면 alt-screen 으로 맞춰준다(이미 alt 인 신선한 클라·마우스 안 쓰는 셸엔 영향 없음 — 조건 가드).
        if (term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'
            && term.buffer && term.buffer.active && term.buffer.active.type !== 'alternate') {
          term.write('\x1b[?1049h');
        }
        term.write('\x1b[H\x1b[2J\x1b[3J\x1b[0m'); term.write(text);
      } catch (_) { /* noop */ }
    },
    // tmux control 스트림의 %exit — 이 attach 클라가 끝났다는 뜻일 뿐, '세션이 죽었다'는 뜻은 아니다
    //  (게이트웨이 재배포로 attach PTY 가 kill 돼도 %exit 이다). 그래서 여기서 종료를 단정하지 않고, 곧바로
    //  재연결해 서버에게 물어본다(살아있으면 그대로 붙고, 진짜 없으면 4410 이 와서 종료 배너). 짧은 지연으로 빠르게 판정.
    onExit: () => { reconnectDelay = 400; try { sock.close(); } catch (_) { /* noop */ } },
  });
  sock.onopen = () => {
    connecting = false; wasConnected = true; reconnectDelay = 1500; denyRetries = 0; attempts = 0; // 붙었으면 입장 허용 확정 → 거부 카운트 리셋
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
    // control mode 로 확인되면 페이지 로드 후 첫 연결에 한 번만 현재 화면+스크롤백 백필(재연결 시엔 생략 — 중복 방지).
    if (!didBackfill && ctrl.isControl()) { didBackfill = true; try { sock.send(JSON.stringify({ t: 'cap', n: BACKFILL_LINES })); } catch (_) { /* noop */ } }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return; // 교체된 옛 소켓의 close 는 무시
    connecting = false;
    if (e && e.code === 4410) { endSession(); return; } // 세션 종료 확정(#835) — 서버가 tmux 에 확인함
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

boot();
