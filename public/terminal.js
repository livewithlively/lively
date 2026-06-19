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
let term, fit, ws, statusEl, explorerEl, tabbarEl, panesEl, termPane;
let curDir = '';
const tabs = []; // { id, label, pane, closable }
let activeId = 'term';

let lastCols = 0, lastRows = 0, resizeTimer = null;
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

// 복사/붙여넣기 — 터미널에서 Ctrl/Cmd+C(선택 있으면 복사, 없으면 SIGINT) · Ctrl/Cmd+V(붙여넣기).
//  비보안 origin(http)이면 clipboard API 가 없어 복사는 execCommand 폴백, 붙여넣기는 네이티브 paste 이벤트로 흘림.
function copyText(text) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).catch(() => execCopy(text)); }
  else execCopy(text);
}
function execCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  } catch (_) { /* noop */ }
  try { term.focus(); } catch (_) { /* noop */ }
}
function setupClipboard() {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;
    const k = (e.key || '').toLowerCase();
    if (k === 'c' && term.hasSelection()) { copyText(term.getSelection()); toast('복사됨'); return false; }
    if (k === 'v') {
      if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
        navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => { /* 권한거부 */ });
        return false;
      }
      return true; // http origin → 네이티브 paste(Cmd+V/Ctrl+V) 이벤트가 xterm 으로 흘러 붙여넣어짐
    }
    return true;
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
    el('div', { class: 'pop' }, el('h3', { text: '보기 설정' }),
      el('div', { class: 'field' }, el('label', { text: '폰트' }), fontSel),
      el('div', { class: 'field' }, el('label', { text: '크기(px)' }), sizeI),
      el('div', { class: 'field' }, el('label', { text: '테마' }), themeSel),
      el('div', { class: 'field' }, el('label', { text: '커서' }), cursorSel),
      el('button', { class: 'tbtn pop-close', text: '닫기', onclick: () => back.remove() })));
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
}

// ── 부팅 ──
function gate(msg) { document.getElementById('root').replaceChildren(el('div', { class: 'gate-msg', text: msg })); }

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
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'tbtn', text: '📁 파일', title: '파일 탐색기', onclick: toggleExplorer }),
    el('span', { class: 'title', text: '터미널' }),
    el('span', { class: 'sub', text: SESSION_ID }),
    el('span', { class: 'spacer' }), statusEl,
    el('button', { class: 'tbtn', text: '⟳ 다시 그리기', title: '리사이즈·재렌더', onclick: forceRedraw }),
    el('button', { class: 'tbtn', text: '⚙ 보기', onclick: openSettings }));
  const host = el('div', { id: 'term-host' });
  termPane = el('div', { class: 'pane active' }, host);
  tabbarEl = el('div', { id: 'tabbar' });
  panesEl = el('div', { id: 'panes' }, termPane);
  const main = el('div', { id: 'main' }, toolbar, tabbarEl, panesEl);
  document.getElementById('root').replaceChildren(el('div', { id: 'ws' }, explorerEl, main));
  tabs.push({ id: 'term', label: '터미널', pane: termPane, closable: false });
  renderTabbar();
  setupDnd();

  // xterm — scrollback 충분히 둠: 세션이 mouse off 라 휠이 이 스크롤백을 직접 굴린다(= 브라우저식 마우스 스크롤).
  //  렌더러는 WebGL(폴백 Canvas) — DOM 렌더러의 스크롤 잔상/중복 아티팩트 회피.
  term = new Terminal({ fontFamily: p.fontFamily, fontSize: p.fontSize, cursorStyle: p.cursorStyle, cursorBlink: true, theme: (THEMES[p.theme] || THEMES.dark).theme, scrollback: 5000, allowProposedApi: true });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  loadRenderer();
  setupClipboard();
  applyFit();
  window.addEventListener('resize', doResize);

  connect();
}

async function connect() {
  try { await api('/api/ui/terminal/ticket', { method: 'POST' }); }
  catch (e) { statusEl.textContent = '인증 실패 — ' + e.message; statusEl.className = 'status err'; return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/terminal/ws?session=' + encodeURIComponent(SESSION_ID));
  ws.onopen = () => {
    statusEl.textContent = '연결됨'; statusEl.className = 'status ok';
    applyFit(); setTimeout(applyFit, 350); // 폰트 로드 후 1회 재측정(크기 바뀔 때만 재전송 — dedupe)
    term.focus();
  };
  ws.onmessage = (e) => { if (typeof e.data === 'string') term.write(e.data); };
  ws.onclose = () => { statusEl.textContent = '연결 종료'; statusEl.className = 'status err'; };
  ws.onerror = () => { statusEl.textContent = '연결 오류'; statusEl.className = 'status err'; };
  term.onData((d) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } } });
}

let explorerLoaded = false;
function toggleExplorer() {
  explorerEl.classList.toggle('open');
  if (explorerEl.classList.contains('open') && !explorerLoaded) { explorerLoaded = true; loadDir(''); }
  setTimeout(doResize, 180); // 폭 변화 후 재맞춤(트랜지션 ~140ms)
}

boot();
