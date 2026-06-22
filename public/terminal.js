// 중앙 박스 — 단독 전체화면 터미널 워크스페이스(새 탭). xterm.js + 서버 node-pty(tmux).
// 좌측 접이식 파일 익스플로러(업/다운로드) · 탭 구조(터미널 + 파일 미리보기) · 보기설정(폰트/테마/크기).
// 인증: 동일 origin localStorage 토큰(메인 UI 로그인 공유) → ticket 쿠키 발급 → WS. md 렌더는 md.js 재사용.
'use strict';

const TOKEN_KEY = 'lively_ui_token';
const PREFS_KEY = 'lively_term_prefs';
const SESSION_ID = new URLSearchParams(location.search).get('session') || '';

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
const DCS_INTRO = '\x1bP1000p';
const BACKFILL_LINES = 600; // 첫 연결 시 capture-pane 로 회수할 히스토리 줄 수(현재 화면+모듈러 스크롤백 복원)
const _te = new TextEncoder();
function decodeOctal(v) {
  // %output value 복원 → 원래 바이트열(Uint8Array). 두 종류가 섞여 있다:
  //  · \ooo(8진) = tmux 가 이스케이프한 '비출력' 바이트(ESC/CR/백슬래시 \134 등) → raw 바이트로 push.
  //  · 그 외 리터럴 문자 = 이미 디코드된 출력 문자(ASCII + 한글 등 멀티바이트, node-pty 가 UTF-8 디코드함)
  //    → 리터럴 런을 모아 UTF-8 로 '재인코딩'해 바이트로(한글을 c&0xff 로 깨지 않게). 마지막에 term.write 가 UTF-8 디코드.
  const out = [];
  let lit = '';
  const flush = () => { if (lit) { const b = _te.encode(lit); for (let k = 0; k < b.length; k++) out.push(b[k]); lit = ''; } };
  for (let i = 0; i < v.length; i++) {
    if (v.charCodeAt(i) === 92) { // '\'
      let oct = '', j = i + 1;
      while (j < v.length && oct.length < 3 && v[j] >= '0' && v[j] <= '7') oct += v[j++];
      if (oct) { flush(); out.push(parseInt(oct, 8) & 0xff); i = j - 1; continue; }
      lit += '\\';
    } else lit += v[i];
  }
  flush();
  return new Uint8Array(out);
}
function makeControl(opts) {
  // opts: { write(Uint8Array), backfill(string), onExit() }
  let mode = null;        // null=미정, 'control', 'raw'
  let sniff = '';         // 도입자 판별용 초기 누적
  let buf = '';           // 부분 줄 잔여
  let inBlock = false, blockNum = '', blockLines = [];
  function handleLine(line) {
    if (inBlock) {
      if ((line.startsWith('%end ') || line.startsWith('%error ')) && line.split(' ')[2] === blockNum) {
        inBlock = false;
        const content = blockLines.join('\r\n'); blockLines = [];
        if (content.length) opts.backfill(content); // 내용 있는 블록 = capture 백필
        return;
      }
      blockLines.push(line);
      return;
    }
    if (line.startsWith('%output ')) {
      const rest = line.slice(8);          // '%<pane> <value>'
      const sp = rest.indexOf(' ');
      if (sp >= 0) opts.write(decodeOctal(rest.slice(sp + 1)));
    } else if (line.startsWith('%extended-output ')) {
      const m = line.match(/^%extended-output \S+ \d+ .*? : (.*)$/); // pause-after 형태
      if (m) opts.write(decodeOctal(m[1]));
    } else if (line.startsWith('%begin ')) {
      inBlock = true; blockNum = line.split(' ')[2] || ''; blockLines = [];
    } else if (line.startsWith('%exit')) {
      opts.onExit();
    }
    // 그 외 %session-changed/%window-*/%layout-change/%pane-mode-changed … 알림은 무시
  }
  function feed(data) {
    if (mode === 'raw') { opts.write(data); return; }
    if (mode === null) {
      sniff += data;
      if (DCS_INTRO.startsWith(sniff)) return;            // 아직 도입자 prefix — 더 받아 판별
      if (sniff.startsWith(DCS_INTRO)) { mode = 'control'; buf = sniff.slice(DCS_INTRO.length); }
      else { mode = 'raw'; opts.write(sniff); }           // 도입자 없음 → 옛 raw 스트림
      sniff = '';
      if (mode !== 'control') return;
    } else { buf += data; }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      handleLine(line);
    }
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
// '다시 그리기' 버튼 — 즉시 fit + 강제 재전송 + 재렌더(현재 크기로 화면을 다시 그림).
function forceRedraw() {
  if (!fit || !term) return;
  try { fit.fit(); } catch (_) { /* noop */ }
  if (ws && ws.readyState === 1) { lastCols = term.cols; lastRows = term.rows; try { ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); } catch (_) { /* noop */ } }
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
function setupClipboard() {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;
    const k = (e.key || '').toLowerCase();
    if (k === 'c' && term.hasSelection()) { copyText(term.getSelection()); return false; }
    if (k === 'v') {
      if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
        navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => { /* 권한거부 */ });
        return false;
      }
      return true; // http origin → 네이티브 paste(Cmd/Ctrl+V)가 xterm 으로 흘러 붙여넣어짐
    }
    return true;
  });
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
  const tool = (name, desc) => el('div', { class: 'help-line' }, el('b', { text: name }), el('span', { text: ' — ' + desc }));
  const sec = (title, ...items) => el('div', { class: 'help-sec' }, el('h4', { text: title }), el('div', { class: 'help-list' }, ...items));
  const pop = el('div', { class: 'pop pop-help' },
    el('h3', { text: '사용법 안내' }),
    el('p', { class: 'help-intro', text: '이 화면은 “터미널”이라 일반 웹페이지와 조작이 조금 달라요. 자주 쓰는 것만 모았어요.' }),
    sec('선택 · 복사 · 붙여넣기',
      kb(['Shift'], '누른 채 드래그하면 텍스트 선택 — 그냥 드래그는 안 돼요 (Mac은 Option 도 가능)'),
      kb(['우클릭'], '단어 선택'),
      kb(['⌘C'], '복사 (Windows는 Ctrl+C) — 먼저 선택하세요. 선택이 없으면 작업을 멈춤'),
      kb(['⌘V'], '붙여넣기 (Windows는 Ctrl+V)')),
    sec('화면 보기',
      kb(['휠 ↑'], '위로 스크롤해서 이전 출력 보기'),
      kb(['q'], '스크롤(과거 보기)을 끝내고 입력으로 돌아오기')),
    sec('도구 — 오른쪽 위 버튼',
      tool('공유 워크스페이스 열기', '왼쪽에서 파일 업로드·다운로드 (끌어다 놓아도 업로드)'),
      tool('화면 복구', '글자·줄이 깨져 보일 때 현재 창에 맞춰 다시 그림 (새로고침 아님)'),
      tool('환경 설정', '글꼴 · 글자 크기 · 테마 · 커서 모양 바꾸기')),
    sec('클로드 코드 — 에이전트',
      kb(['Enter'], '한국어로 자연스럽게 지시하고 보내기'),
      kb(['Esc'], '에이전트가 하던 작업 멈추기'),
      kb(['/'], '쓸 수 있는 명령 목록 보기')),
    el('p', { class: 'help-note', text: '연결이 끊겨도 자동으로 다시 연결되고 세션·작업은 그대로 유지돼요. 이 창은 Esc 또는 바깥을 눌러 닫을 수 있어요.' }),
    el('button', { class: 'tbtn pop-close', text: '닫기', onclick: () => back.remove() }));
  const back = el('div', { class: 'pop-back', onclick: (e) => { if (e.target === back) back.remove(); } }, pop);
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
}

// ── 부팅 ──
function gate(msg) { document.getElementById('root').replaceChildren(el('div', { class: 'gate-msg', text: msg })); }

// 세션 이름(라벨) — 상단 제목을 세션 id 대신 사람이 정한 이름으로. (id 는 제목 tooltip 으로 보존.)
async function loadSessionLabel() {
  try {
    const data = await api('/api/ui/terminal/sessions');
    const s = ((data && data.sessions) || []).find((x) => x.id === SESSION_ID);
    if (s && s.label) { titleEl.textContent = s.label; document.title = s.label + ' · Lively'; }
  } catch (_) { /* 라벨 못 가져오면 기본 제목 유지 */ }
}

function boot() {
  const p = prefs();
  applyChrome(p.theme);
  if (!localStorage.getItem(TOKEN_KEY)) { gate('로그인이 필요합니다. 메인 UI(/ui/)에서 토큰을 입력한 뒤 다시 여세요.'); return; }
  if (!SESSION_ID) { gate('세션이 지정되지 않았습니다. 세션 목록에서 "열기"로 진입하세요.'); return; }
  if (!window.Terminal || !window.FitAddon) { gate('터미널 라이브러리(xterm) 로드 실패.'); return; }

  // 셸 구성
  explorerEl = el('aside', { id: 'explorer' },
    el('div', { class: 'exp-head' }, el('span', { text: '파일' }), el('span', { class: 'spacer' }),
      el('button', { class: 'tbtn', text: '＋폴더', title: '새 폴더', onclick: newFolder }),
      el('button', { class: 'tbtn', text: '⬆', title: '업로드', onclick: startUpload }),
      el('button', { class: 'tbtn', text: '⟳', title: '새로고침', onclick: () => loadDir(curDir) })),
    el('div', { id: 'exp-path', class: 'exp-path' }), el('div', { id: 'exp-list' }));
  statusEl = el('span', { class: 'status', text: '연결 중…' });
  // 제목 = 세션 이름(라벨). 로드 전엔 '터미널', 로드되면 loadSessionLabel 이 교체. id 는 tooltip 으로 보존.
  titleEl = el('span', { class: 'title', text: '터미널', title: SESSION_ID });
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
  loadSessionLabel();

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
  setupWheel();
  applyFit();
  window.addEventListener('resize', doResize);
  // window.resize 만으로는 '호스트가 0→풀사이즈로 처음 레이아웃되는 순간'을 못 잡는다(창은 리사이즈된 적
  //  없으므로). 그 타이밍에 fit 이 한 번 작게 잡히면 80x24 기본으로 굳어 화면을 안 채운다 → 호스트를
  //  ResizeObserver 로 직접 감시해 초기 사이징·탐색기 폭변화까지 모두 재맞춤(observe 시 1회 즉시 발화).
  try { if (window.ResizeObserver) { const ro = new ResizeObserver(doResize); ro.observe(host); } } catch (_) { /* noop */ }

  // 입력 핸들러는 '한 번만' 등록(재연결마다 붙이면 키 입력이 중복 전송됨). 현재 ws 를 참조해 전송.
  term.onData((d) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } } });
  // 탭이 백그라운드→포그라운드로 돌아오면, 끊겨 있을 때 즉시 재연결.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (!ws || ws.readyState >= 2)) { reconnectDelay = 1000; connectNow(); } });

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
  ws = sock;
  // 연결마다 새 control 파서(각 tmux -CC 스트림은 자기 도입자로 시작). 도입자 없으면 raw 모드로 자동 폴백.
  ctrl = makeControl({
    write: (data) => { try { term.write(data); } catch (_) { /* noop */ } },
    // 백필(capture 스냅샷)은 '현재 화면 전체'다 → 쓰기 전 화면+스크롤백을 비워(\e[H\e[2J\e[3J) 첫 연결 중
    //  attach~capture 사이에 먼저 흘러든 라이브 %output 과 겹쳐 줄이 중복되는 것을 막는다. 이후 라이브는 그대로 append.
    backfill: (text) => { try { term.write('\x1b[H\x1b[2J\x1b[3J'); term.write(text); } catch (_) { /* noop */ } },
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
    if (typeof e.data !== 'string') return;
    ctrl.feed(e.data);
    // control mode 로 확인되면 페이지 로드 후 첫 연결에 한 번만 현재 화면+스크롤백 백필(재연결 시엔 생략 — 중복 방지).
    if (!didBackfill && ctrl.isControl()) { didBackfill = true; try { sock.send(JSON.stringify({ t: 'cap', n: BACKFILL_LINES })); } catch (_) { /* noop */ } }
  };
  sock.onclose = () => {
    if (ws !== sock) return; // 교체된 옛 소켓의 close 는 무시
    connecting = false;
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
