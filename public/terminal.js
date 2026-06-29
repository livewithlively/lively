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

const FONTS = [
  { v: "'JetBrains Mono', monospace", label: 'JetBrains Mono' },
  { v: "'Fira Code', monospace", label: 'Fira Code' },
  { v: "'Source Code Pro', monospace", label: 'Source Code Pro' },
  { v: "'IBM Plex Mono', monospace", label: 'IBM Plex Mono' },
  { v: "'Roboto Mono', monospace", label: 'Roboto Mono' },
  { v: "'D2Coding', monospace", label: 'D2Coding (한글)' },
  { v: "Menlo, monospace", label: 'Menlo' },
  { v: "'SF Mono', SFMono-Regular, monospace", label: 'SF Mono' },
  { v: "Monaco, monospace", label: 'Monaco' },
  { v: "Consolas, monospace", label: 'Consolas' },
];
const THEMES = {
  dark:      { name: '다크', dark: true,  theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70' } },
  light:     { name: '라이트', dark: false, theme: { background: '#fdfdfd', foreground: '#2a2a2a', cursor: '#5566ff', selectionBackground: '#cfe3ff' } },
  dracula:   { name: 'Dracula', dark: true, theme: { background: '#282a36', foreground: '#f8f8f2', cursor: '#ff79c6', selectionBackground: '#44475a' } },
  solarized: { name: 'Solarized Dark', dark: true, theme: { background: '#002b36', foreground: '#93a1a1', cursor: '#cb4b16', selectionBackground: '#073642' } },
  nord:      { name: 'Nord', dark: true, theme: { background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', selectionBackground: '#434c5e' } },
  github:    { name: 'GitHub Light', dark: false, theme: { background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#b6e3ff' } },
};

function prefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (_) { /* default */ }
  const browserDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return Object.assign({ fontFamily: FONTS[0].v, fontSize: 14, theme: browserDark ? 'dark' : 'light', cursorStyle: 'bar' }, p);
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
const sUrl = (suffix) => '/api/ui/terminal/sessions/' + encodeURIComponent(SESSION_ID) + suffix;

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
// 첫 진입 시 화면이 창에 안 맞게 그려지는 문제 해소 — 마운트 직후 applyFit 은 웹폰트 로드 전에
//  셀 크기를 재 cols/rows 가 어긋날 수 있다. 그래서 '폰트 준비(document.fonts.ready) + 소켓 open'
//  이후 forceRedraw('화면 복구')를 한 번 자동 실행해 현재 창에 정확히 맞춘다. 가드로 진입당 1회만.
function initialSettleRedraw() {
  if (didInitialFit) return;
  didInitialFit = true;
  const run = () => {
    // 폰트 로드 후 글자 셀 폭 '재측정'을 강제 — fontSize 를 +1 했다 즉시 되돌려, xterm 의 CharSizeService
    //  재측정 + 렌더러 글리프 아틀라스 재생성을 유발한다(환경설정에서 크기 바꿨다 되돌리면 정상화되는 것과
    //  동일 원리). fit/refresh 만으로는 자간(특히 한글 더블폭 셀)이 폰트 로드 전 측정값으로 굳는 게 안 풀린다.
    //  같은 값으로 다시 세팅하면 xterm 이 무변동으로 건너뛰므로, 반드시 다른 값(+1)을 한 번 거친다.
    try { const fs = term.options.fontSize; term.options.fontSize = fs + 1; term.options.fontSize = fs; } catch (_) { /* noop */ }
    // 셀 px 가 바뀌었으니 그 위에서 grid 재맞춤(cols/rows)·pty 재전송·재렌더.
    try { requestAnimationFrame(forceRedraw); } catch (_) { forceRedraw(); }
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => setTimeout(run, 60)).catch(() => setTimeout(run, 120));
  else setTimeout(run, 120);
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
function copyText(text) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).catch(() => execCopy(text));
  else execCopy(text);
  toast('복사됨');
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
    // Option/Alt + ←/→ = 단어 단위 이동. xterm 기본(macOptionIsMeta 미설정)으론 Option+방향키가 단어이동이 안 되므로
    //  Meta-b/Meta-f(\eb/\ef — bash readline·zsh 기본 바인딩)를 직접 셸로 흘려 비개발자도 단어 점프가 되게 한다.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d: e.key === 'ArrowLeft' ? '\x1bb' : '\x1bf' })); } catch (_) { /* noop */ } }
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

// 마우스 휠 = 스크롤바처럼 로컬 스크롤백을 직접 오르내림(하드 요구사항). control mode 에선 xterm 이
//  스크롤백을 소유하므로 normal buffer 에선 휠을 항상 로컬 스크롤로 처리하고 앱으로 흘리지 않는다(false 반환).
//  단 pane 안의 alt-screen 앱(vim/less 등)은 그쪽이 휠을 쓰도록 그대로 전달(true).
function setupWheel() {
  if (!term.attachCustomWheelEventHandler) return; // 구버전 xterm — 네이티브 휠(스크롤백 미사용 시 무동작)
  term.attachCustomWheelEventHandler((e) => {
    try { if (term.buffer.active.type === 'alternate') return true; } catch (_) { /* noop */ }
    let lines;
    if (e.deltaMode === 1) lines = e.deltaY;                 // line 단위
    else if (e.deltaMode === 2) lines = e.deltaY * term.rows; // page 단위
    else lines = e.deltaY / 18;                               // pixel → 대략 셀높이로 환산
    const n = Math.trunc(lines) || (e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0);
    if (n) term.scrollLines(n);
    return false;
  });
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
  const apply = () => {
    const np = { fontFamily: fontSel.value, fontSize: Number(sizeI.value) || 14, theme: themeSel.value, cursorStyle: cursorSel.value };
    term.options.fontFamily = np.fontFamily; term.options.fontSize = np.fontSize; term.options.cursorStyle = np.cursorStyle;
    term.options.theme = (THEMES[np.theme] || THEMES.dark).theme;
    savePrefs(np); applyChrome(np.theme); doResize();
  };
  for (const c of [fontSel, themeSel, cursorSel]) c.addEventListener('change', apply);
  sizeI.addEventListener('input', apply);
  const back = el('div', { class: 'pop-back', onclick: (e) => { if (e.target === back) back.remove(); } },
    el('div', { class: 'pop' }, el('h3', { text: '환경 설정' }),
      el('div', { class: 'field' }, el('label', { text: '폰트' }), fontSel),
      el('div', { class: 'field' }, el('label', { text: '크기(px)' }), sizeI),
      el('div', { class: 'field' }, el('label', { text: '테마' }), themeSel),
      el('div', { class: 'field' }, el('label', { text: '커서' }), cursorSel),
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
        kb(['Ctrl W'], '커서 앞 단어 하나 지우기'),
        kb(['Ctrl K'], '커서 오른쪽을 끝까지 지우기')),
      sec('화면 · 실행',
        kb(['Ctrl L'], '화면 비우기 (위로 스크롤하면 남아 있음)'),
        kb(['Ctrl C'], '멈춘·실행 중인 명령 강제 중단'),
        kb(['휠 ↑'], '위로 스크롤해 지난 출력 보기')),
      sec('도구 (오른쪽 위 버튼)',
        tool('공유 워크스페이스', '파일 업로드·다운로드 (끌어다 놓아도 됨)'),
        tool('화면 복구', '글자·줄이 깨질 때 다시 그림'),
        tool('환경 설정', '글꼴·크기·테마·커서 모양')),
      sec('클로드 코드',
        kb(['Esc'], '에이전트가 하던 작업 멈추기'),
        kb(['/'], '쓸 수 있는 명령 목록'))));
  const back = el('div', { class: 'pop-back', onclick: (e) => { if (e.target === back) back.remove(); } }, pop);
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
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
    el('button', { class: 'tbtn', text: '📁 공유 워크스페이스 열기', title: '파일 탐색기 열기/닫기', onclick: toggleExplorer }),
    titleEl,
    el('span', { class: 'spacer' }), statusEl,
    el('button', { class: 'tbtn', text: '⟳ 화면 복구', title: '화면이 깨지거나 어긋났을 때 현재 창에 맞춰 복구', onclick: forceRedraw }),
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
  setupClipboard();
  setupPaste();
  setupWheel();
  applyFit();
  window.addEventListener('resize', doResize);
  // window.resize 만으로는 '호스트가 0→풀사이즈로 처음 레이아웃되는 순간'을 못 잡는다(창은 리사이즈된 적
  //  없으므로). 그 타이밍에 fit 이 한 번 작게 잡히면 80x24 기본으로 굳어 화면을 안 채운다 → 호스트를
  //  ResizeObserver 로 직접 감시해 초기 사이징·탐색기 폭변화까지 모두 재맞춤(observe 시 1회 즉시 발화).
  try { if (window.ResizeObserver) { const ro = new ResizeObserver(doResize); ro.observe(host); } } catch (_) { /* noop */ }

  // 입력 핸들러는 '한 번만' 등록(재연결마다 붙이면 키 입력이 중복 전송됨). 현재 ws 를 참조해 전송.
  term.onData((d) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } } });
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
let reconnectTimer = null, reconnectDelay = 1500, wasConnected = false, connecting = false;
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectNow, reconnectDelay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000); // 지수 백오프, 최대 5s
}
async function connectNow() {
  if (connecting) return;
  if (ws && ws.readyState <= 1) return; // 이미 OPEN/CONNECTING
  connecting = true;
  clearTimeout(reconnectTimer);
  // 재기동 시 인메모리 티켓이 비워지므로 매 연결마다 티켓을 새로 발급받는다.
  try { await api('/api/ui/terminal/ticket', { method: 'POST' }); }
  catch (e) { connecting = false; statusEl.textContent = '재연결 중…'; statusEl.className = 'status err'; scheduleReconnect(); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(proto + '://' + location.host + '/terminal/ws?session=' + encodeURIComponent(SESSION_ID));
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
    onExit: () => { try { sock.close(); } catch (_) { /* noop */ } },
  });
  sock.onopen = () => {
    connecting = false; wasConnected = true; reconnectDelay = 1500;
    statusEl.textContent = '연결됨'; statusEl.className = 'status ok';
    lastCols = 0; lastRows = 0; // 재attach 후 사이즈 강제 재동기화(→ control mode: refresh-client -C 재전송)
    applyFit(); setTimeout(applyFit, 350);
    initialSettleRedraw(); // 첫 연결 1회: 폰트 준비 후 자동 화면복구(초기 어긋남 방지)
    term.focus();
  };
  sock.onmessage = (e) => {
    const bytes = (e.data instanceof ArrayBuffer) ? new Uint8Array(e.data) : (typeof e.data === 'string' ? new TextEncoder().encode(e.data) : null);
    if (!bytes) return;
    ctrl.feed(bytes);
    // control mode 로 확인되면 페이지 로드 후 첫 연결에 한 번만 현재 화면+스크롤백 백필(재연결 시엔 생략 — 중복 방지).
    if (!didBackfill && ctrl.isControl()) { didBackfill = true; try { sock.send(JSON.stringify({ t: 'cap', n: BACKFILL_LINES })); } catch (_) { /* noop */ } }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return; // 교체된 옛 소켓의 close 는 무시
    connecting = false;
    if (e && e.code === 4403) { // 서버가 입장 거부 — 무한 재연결 대신 이유를 명확히 안내하고 멈춘다.
      clearTimeout(reconnectTimer);
      gate('이 세션에 입장할 수 없습니다.\n\n프로젝트 팀원만 입장할 수 있어요. 또는 이 세션이 더 이상 프로젝트에 연결되어 있지 않을 수 있습니다(폴더 이동·프로젝트 삭제 등). 프로젝트 페이지에서 세션을 다시 확인해 주세요.');
      return;
    }
    statusEl.textContent = wasConnected ? '연결 끊김 — 재연결 중…' : '재연결 중…';
    statusEl.className = 'status err';
    scheduleReconnect();
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
