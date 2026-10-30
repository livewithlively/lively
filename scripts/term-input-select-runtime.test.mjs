#!/usr/bin/env node
// Claude Code 입력칸 선택 — **런타임** 시험 (#4406 후속, 2026-09-28)
//
// 신고(원준 2026-09-28): «⌘+↓, ↑↓ 로 윗줄 아랫줄까지 선택이 잘 안 되고, ⌘X 잘라내기가 여전히 안 된다.»
// 사양(스크래치패드 spec-kbsel.md 엣지 표): 선택 범위는 웹이 글자 단위로 정해 칠하고(앱으로 0바이트), 지우기·잘라내기·덮어쓰기
//  순간에만 합성 끌기로 앱에 선택시킨 뒤 **앱이 그 칸들을 칠한 것을 화면에서 확인하고** ⌫ 하나를 보낸다. 확인이 안 되면 안 지운다.
//
// 장치: 헤드리스 크롬 + vendored xterm 5.5 + 프로덕션 web/standalone/terminal.ts(esbuild, 장면마다 새 인스턴스).
//  boot() 가 거는 그 배선(wireInputSelection · setupClipboard · setupOscClipboard · onData=handleTermData)을 그대로 건다.
//  앱 자리에는 «가짜 Claude» 를 둔다 — 격리 tmux 의 실제 Claude Code 2.1.283 에서 잰 규칙만 흉내 낸다:
//   · 마우스 누름→눌린 채 이동→뗌 = 칸 범위 선택(방향 무관, 양끝 포함) · 빈칸까지 선택 색(48;5;189)으로 칠한다
//   · 제자리 누름·뗌 = 클릭(그 글자 앞으로 캐럿) · 0.5초 안·1칸 이내 재누름 = 더블클릭(여기선 «사고» 로 센다)
//   · 선택한 채 ⌫ = [첫 칸의 글자 위치, 끝 칸 다음 칸의 글자 위치) 삭제 · 선택을 놓으면 자동복사(OSC52, 화면 글자 그대로)
//  앱 왕복은 15ms 로 흉내 낸다(메아리가 늦게 오는 판을 재기 위해 — 즉시 응답하면 기다림 로직을 못 잰다).
//
// fail-first: `TERM_SRC=<변이 소스>`(web/standalone 안 — 상대 import) 로 다른 terminal.ts 를 물린다. 변이·결과는 PR 본문.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 입력칸 선택 런타임 검증 미실행");
  process.exit(0);
}
const VENDOR = path.join(ROOT, "public/vendor/xterm");
for (const f of ["xterm.min.js", "xterm.min.css"]) {
  if (!existsSync(path.join(VENDOR, f))) { console.error(`FAIL  vendored xterm 없음: ${f}`); process.exit(1); }
}
const SRC = process.env.TERM_SRC || path.join(ROOT, "web/standalone/terminal.ts");
const bundle = buildSync({
  entryPoints: [SRC], bundle: true, format: "iife", globalName: "TM", write: false,
  platform: "browser", target: "es2020", define: { TERMJS_BUILD: JSON.stringify("test") }, logLevel: "silent",
}).outputFiles[0].text;

const L3 = ["첫째 줄 안녕하세요", "둘째 줄 반갑습니다", "셋째 줄 좋은 하루"];

const PAGE = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.min.css">
<style>html,body{margin:0} .term-sel{position:absolute}</style><pre id="out">PENDING</pre>
<script>
// 맥/그 밖 — 모듈은 로드 순간 navigator.platform 을 읽는다(IS_MAC). 장면마다 바꿔 끼운다.
window.__plat = 'MacIntel';
Object.defineProperty(navigator, 'platform', { configurable: true, get: function () { return window.__plat; } });
// 클립보드 기록 — 동기 복사(copy 이벤트 setData)와 API 쓰기 둘 다
window.__clip = null;
var _sd = DataTransfer.prototype.setData;
DataTransfer.prototype.setData = function (t, v) { if (t === 'text/plain') window.__clip = v; return _sd.call(this, t, v); };
try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function (t) { window.__clip = t; return Promise.resolve(); }, readText: function () { return Promise.resolve(''); } } }); } catch (_) {}
</script>
<script src="xterm.min.js"></script>
<script type="text/plain" id="tmsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>
var TMSRC = document.getElementById('tmsrc').textContent;
function freshModule() { return (new Function(TMSRC + '\\n;return TM;'))(); }
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var wide = function (ch) { return /[\\u1100-\\u115f\\u2e80-\\ua4cf\\uac00-\\ud7a3\\uf900-\\ufaff\\uff00-\\uff60]/.test(ch); };
var W = function (ch) { return wide(ch) ? 2 : 1; };

// ── 가짜 Claude — 실측한 앱 규칙만(머리말) ──
function FakeClaude(term, lines, opt) {
  var app = this; opt = opt || {};
  app.term = term; app.R = term.rows; app.C = term.cols;
  app.lines = lines.map(function (l) { return Array.from(l); });
  app.caret = { line: app.lines.length - 1, idx: app.lines[app.lines.length - 1].length };
  app.sel = null; app.press = null; app.moved = false; app.lastPress = null;
  app.doubleClicks = 0; app.interrupts = 0; app.mouse = opt.mouse !== false; app.lit = opt.lit !== false; app.first = true;
  app.top = function () { return app.R - 2 - app.lines.length; };
  app.offsetAt = function (li, col) { var x = 2, ch = app.lines[li] || []; for (var i = 0; i < ch.length; i++) { var w = W(ch[i]); if (col < x + w) return i; x += w; } return ch.length; };
  app.colOf = function (li, idx) { var x = 2, ch = app.lines[li] || []; for (var i = 0; i < idx; i++) x += W(ch[i]); return x; };
  app.inBox = function (r) { return r >= app.top() && r < app.top() + app.lines.length; };
  app.ordered = function () { var a = app.sel.a, f = app.sel.f; return (a.row < f.row || (a.row === f.row && a.col <= f.col)) ? [a, f] : [f, a]; };
  app.isSel = function (r, x) { if (!app.sel || !app.lit) return false; var o = app.ordered(), p = r * 10000 + x; return p >= o[0].row * 10000 + o[0].col && p <= o[1].row * 10000 + o[1].col; };
  app.rowCells = function (r) {
    var top = app.top(), C = app.C, cells = [];
    var push = function (s) { Array.from(s).forEach(function (ch) { cells.push(ch); if (wide(ch)) cells.push(''); }); };
    if (r === top - 1 || r === app.R - 2) push(new Array(C + 1).join('─'));
    else if (app.inBox(r)) { push(r === top ? '❯\\u00a0' : '  '); push(app.lines[r - top].join('')); }
    else if (r === app.R - 1) push('  ⏵⏵ auto mode on');
    while (cells.length < C) cells.push(' ');
    return cells.slice(0, C);
  };
  app.render = function () {
    var out = app.first ? ('\\x1b[?1049h' + (app.mouse ? '\\x1b[?1003h\\x1b[?1006h' : '')) : '';
    app.first = false;
    for (var r = 0; r < app.R; r++) {
      var cells = app.rowCells(r), s = '\\x1b[' + (r + 1) + ';1H\\x1b[49m', on = false;
      for (var x = 0; x < app.C; x++) {
        var sel = app.isSel(r, x);
        if (sel && !on) { s += '\\x1b[48;5;189m'; on = true; } else if (!sel && on) { s += '\\x1b[49m'; on = false; }
        if (cells[x] !== '') s += cells[x];
      }
      out += s + '\\x1b[49m';
    }
    var cr = app.top() + app.caret.line, cc = app.colOf(app.caret.line, app.caret.idx);
    out += '\\x1b[' + (cr + 1) + ';' + (cc + 1) + 'H';
    term.write(out);
  };
  app.text = function () { return app.lines.map(function (l) { return l.join(''); }).join('\\n'); };
  app.screenText = function () { // 앱 자동복사 — 화면 글자 그대로(들여쓰기 포함)
    var o = app.ordered(), rows = [];
    for (var r = o[0].row; r <= o[1].row; r++) { var c = app.rowCells(r), x0 = r === o[0].row ? o[0].col : 0, x1 = r === o[1].row ? o[1].col : app.C - 1; rows.push(c.slice(x0, x1 + 1).join('').replace(/\\s+$/, '')); }
    return rows.join('\\n');
  };
  app.del = function () {
    var o = app.ordered(), top = app.top();
    var sl = o[0].row - top, el_ = o[1].row - top;
    var si = app.offsetAt(sl, o[0].col), ei = app.offsetAt(el_, o[1].col + 1);
    var head = app.lines[sl].slice(0, si), tail = app.lines[el_].slice(ei);
    app.lines.splice(sl, el_ - sl + 1, head.concat(tail));
    app.caret = { line: sl, idx: si };
  };
  app.input = function (d) {
    var re = /\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])|\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~|\\x1b\\[[0-9;]*[A-Za-z~]|\\x1b[\\s\\S]|[\\s\\S]/g, m;
    while ((m = re.exec(d))) {
      var tok = m[0];
      if (m[1] !== undefined) {
        var b = +m[1], col = +m[2] - 1, row = +m[3] - 1, up = m[4] === 'm';
        if (b & 64) continue;
        if (b & 32) { if (app.press && (b & 3) !== 3) { app.moved = true; app.sel = { a: app.press, f: { row: row, col: col } }; } continue; }
        if (!up) {
          var now = performance.now();
          if (app.lastPress && now - app.lastPress.t < 500 && Math.abs(app.lastPress.row - row) <= 1 && Math.abs(app.lastPress.col - col) <= 1) app.doubleClicks++;
          app.lastPress = { row: row, col: col, t: now }; app.press = { row: row, col: col }; app.moved = false; app.sel = null;
        } else {
          if (app.press && app.moved) {
            app.sel = { a: app.press, f: { row: row, col: col } };
            var t = app.screenText();
            if (t.trim()) term.write('\\x1b]52;c;' + btoa(unescape(encodeURIComponent(t))) + '\\x07');
          } else if (app.inBox(row)) { app.caret = { line: row - app.top(), idx: app.offsetAt(row - app.top(), col) }; app.sel = null; }
          app.press = null;
        }
        continue;
      }
      if (m[5] !== undefined) { app.insert(m[5]); continue; }
      if (tok === '\\x7f') {
        if (app.sel && app.inBox(app.sel.a.row) && app.inBox(app.sel.f.row)) app.del();
        else if (app.caret.idx > 0) { app.lines[app.caret.line].splice(app.caret.idx - 1, 1); app.caret.idx--; }
        app.sel = null; continue;
      }
      if (tok === '\\x03') { if (app.sel) app.sel = null; else app.interrupts++; continue; }
      if (tok === '\\x1b[D') { if (app.caret.idx > 0) app.caret.idx--; app.sel = null; continue; }
      if (tok === '\\x1b[C') { if (app.caret.idx < app.lines[app.caret.line].length) app.caret.idx++; app.sel = null; continue; }
      if (tok.charCodeAt(0) === 0x1b) continue;
      if (tok.charCodeAt(0) < 0x20) continue;
      app.insert(tok);
    }
    app.render();
  };
  app.insert = function (s) { var ch = Array.from(s); var line = app.lines[app.caret.line]; line.splice.apply(line, [app.caret.idx, 0].concat(ch)); app.caret.idx += ch.length; app.sel = null; };
}

// 한 장면 — 새 터미널 · 새 모듈 · 가짜 Claude. mac=false 면 Windows/리눅스 단축키.
function scene(opt) {
  return new Promise(function (resolve) {
    window.__plat = opt.mac === false ? 'Win32' : 'MacIntel';
    var host = document.createElement('div');
    host.style.width = '480px'; host.style.height = '240px';
    document.body.insertBefore(host, document.getElementById('out'));
    var term = new Terminal({ cols: 40, rows: 12, fontSize: 14, macOptionClickForcesSelection: true, rightClickSelectsWord: false });
    term.open(host);
    var tm = freshModule();
    var s = { term: term, host: host, tm: tm, sent: [], sentAt: [] };
    var app = new FakeClaude(term, opt.lines || ${JSON.stringify(L3)}, opt);
    s.app = app;
    tm.__injectRefsForTest({ term: term, panesEl: host, ws: { readyState: 1, send: function (msg) {
      var o = JSON.parse(msg); if (o.t !== 'i') return;
      s.sent.push(o.d); s.sentAt.push(performance.now());
      setTimeout(function () { app.input(o.d); }, 15);
    }, close: function () {} } });
    tm.setupClipboard(); tm.setupOscClipboard(); tm.setupPaste(); tm.wireInputSelection(host);
    term.onData(tm.handleTermData);
    window.__clip = null;
    app.render();
    term.write('', function () { setTimeout(function () { term.focus(); resolve(s); }, 40); });
  });
}
// keyCode — xterm 은 Backspace(8) 같은 특수키를 key 가 아니라 keyCode 로 알아본다(0 이면 아무것도 안 보낸다).
function key(s, k, mods, keyCode) {
  var m = mods || {};
  s.term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: keyCode || 0, shiftKey: !!m.shift, metaKey: !!m.meta, ctrlKey: !!m.ctrl, altKey: !!m.alt, bubbles: true, cancelable: true }));
}
function typeChar(s, ch) {
  key(s, ch, {}, ch.toUpperCase().charCodeAt(0));
  s.term.textarea.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
}
function overlay(s) {
  var r = s.host.querySelector('.xterm-screen').getBoundingClientRect(), cw = r.width / s.term.cols, ch = r.height / s.term.rows;
  return Array.prototype.map.call(s.host.querySelectorAll('.xterm-screen .term-sel'), function (d) {
    return [Math.round(parseFloat(d.style.top) / ch), Math.round(parseFloat(d.style.left) / cw), Math.round((parseFloat(d.style.left) + parseFloat(d.style.width)) / cw)];
  });
}
function sgrPresses(s) { var out = []; s.sent.forEach(function (d, i) { var re = /\\x1b\\[<0;(\\d+);(\\d+)M/g, m; while ((m = re.exec(d))) out.push({ col: +m[1] - 1, row: +m[2] - 1, at: s.sentAt[i] }); }); return out; }
function drag(s, row, from, to) {
  var r = s.host.querySelector('.xterm-screen').getBoundingClientRect(), cw = r.width / s.term.cols, chh = r.height / s.term.rows;
  var at = function (c) { return { clientX: r.left + (c + 0.5) * cw, clientY: r.top + (row + 0.5) * chh }; };
  var ev = function (type, c, buttons) { var p = at(c); (type === 'mousedown' ? s.host.querySelector('.xterm-screen') : document).dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: p.clientX, clientY: p.clientY, button: 0, buttons: buttons, detail: type === 'mousemove' ? 0 : 1 })); };
  ev('mousedown', from, 1);
  for (var c = from + 1; c <= to; c++) ev('mousemove', c, 1);
  ev('mouseup', to, 0);
}
function after(s, n) { return s.sent.slice(n); }

(async function () {
  var R = {}, s, n;
  try {
    // 입력칸: 12행 화면 — 가로줄 6·10행, 입력 7~9행, 커서는 셋째 줄 끝(9, 19)
    s = await scene({});
    R.W = { mode: s.term.modes.mouseTrackingMode, cursor: [s.term.buffer.active.cursorX, s.term.buffer.active.cursorY] };
    n = s.sent.length; key(s, 'ArrowLeft', { shift: true }); await sleep(60);
    R.K1 = { overlay: overlay(s), sent: after(s, n) };
    key(s, 'ArrowUp', { shift: true }); await sleep(60);
    R.K2 = { overlay: overlay(s), sent: after(s, n) };
    key(s, 'Backspace', {}, 8); await sleep(400);
    R.D1 = { text: s.app.text(), sent: after(s, n), dbl: s.app.doubleClicks, clip: window.__clip, overlay: overlay(s) };

    s = await scene({});
    key(s, 'ArrowUp', { shift: true, meta: true }); await sleep(60);
    R.K6 = { overlay: overlay(s) };
    key(s, 'x', { meta: true }, 88); await sleep(400);
    R.X1 = { text: s.app.text(), clip: window.__clip };

    s = await scene({});
    key(s, 'ArrowLeft', { shift: true }); key(s, 'ArrowLeft', { shift: true }); await sleep(60);
    n = s.sent.length; key(s, 'c', { meta: true }, 67); await sleep(200);
    R.C1 = { clip: window.__clip, overlay: overlay(s), sent: after(s, n), text: s.app.text() };

    s = await scene({});
    key(s, 'ArrowLeft', { shift: true }); key(s, 'ArrowLeft', { shift: true }); await sleep(60);
    n = s.sent.length; typeChar(s, 'Z'); await sleep(400);
    R.T1 = { text: s.app.text(), sent: after(s, n) };

    s = await scene({});
    key(s, 'ArrowLeft', { shift: true }); key(s, 'ArrowLeft', { shift: true }); await sleep(60);
    key(s, 'ArrowLeft'); await sleep(250);
    R.A1 = { caret: [s.app.caret.line, s.app.caret.idx], overlay: overlay(s) };

    s = await scene({});
    n = s.sent.length; key(s, 'ArrowUp', { meta: true }); await sleep(250);
    var once = after(s, n).length;
    key(s, 'ArrowUp', { meta: true }); await sleep(250);
    R.H1 = { caret: [s.app.caret.line, s.app.caret.idx], firstSends: once, secondSends: s.sent.length - n - once };

    s = await scene({});
    drag(s, 8, 10, 13); s.tm.flushMouseReports(); await sleep(250); // 헤드리스는 rAF 가 안 돈다 — 프레임 묶음을 직접 내보낸다(실브라우저 ≤16ms)
    R.X2pre = { lit: s.app.sel ? s.app.screenText() : null };
    key(s, 'x', { meta: true }, 88); await sleep(300);
    R.X2 = { text: s.app.text(), clip: window.__clip };

    s = await scene({ mac: false });
    key(s, 'Home', { shift: true }); await sleep(60);
    key(s, 'x', { ctrl: true }, 88); await sleep(400);
    R.X1w = { text: s.app.text(), clip: window.__clip };

    s = await scene({ lit: false });
    key(s, 'ArrowLeft', { shift: true }); await sleep(60);
    n = s.sent.length; key(s, 'Backspace', {}, 8); await sleep(1300);
    R.D2 = { text: s.app.text(), sent: after(s, n) };

    s = await scene({ mouse: false });
    n = s.sent.length; key(s, 'ArrowLeft', { shift: true }); await sleep(80);
    R.N1 = { sent: after(s, n), overlay: overlay(s), mode: s.term.modes.mouseTrackingMode };

    // 한 칸 글자(영문)를 연달아 두 번 지운다 — 두 번째 합성 누름이 첫 누름과 1칸 이내 · 0.6초 안이 되는 자리
    s = await scene({ lines: ['abc', 'def', 'ghij'] });
    key(s, 'ArrowLeft', { shift: true }); await sleep(30); key(s, 'Backspace', {}, 8); await sleep(150);
    key(s, 'ArrowLeft', { shift: true }); await sleep(30); key(s, 'Backspace', {}, 8); await sleep(1300);
    R.P1 = { text: s.app.text(), dbl: s.app.doubleClicks, presses: sgrPresses(s) };

    s = await scene({});
    key(s, 'ArrowLeft', { shift: true }); await sleep(60);
    s.app.lines[2].unshift('!'); s.app.caret.idx++; s.app.render(); await sleep(60); // 앱이 입력칸을 다시 그렸다(글자가 바뀜)
    n = s.sent.length; key(s, 'Backspace', {}, 8); await sleep(300);
    R.S1 = { text: s.app.text(), sent: after(s, n) };

    s = await scene({});
    drag(s, 8, 10, 13); s.tm.flushMouseReports(); await sleep(250);
    typeChar(s, 'Z'); await sleep(400);
    R.X4 = { text: s.app.text() };

    s = await scene({});
    drag(s, 8, 10, 13); s.tm.flushMouseReports(); await sleep(250);
    var dt = new DataTransfer(); dt.setData('text/plain', 'Q');
    s.host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); await sleep(400);
    R.X5 = { text: s.app.text() };

    // 지우는 도중(합성 끌기 → 확인 → ⌫ 가 아직 안 끝난 사이)에 누른 Shift+← 는 받지 않는다
    s = await scene({});
    key(s, 'ArrowLeft', { shift: true }); await sleep(60);
    key(s, 'Backspace', {}, 8); key(s, 'ArrowLeft', { shift: true }); await sleep(450);
    R.P2 = { text: s.app.text(), overlay: overlay(s), presses: sgrPresses(s).length };

    s = await scene({});
    key(s, 'ArrowLeft', { shift: true }); await sleep(60);
    s.host.querySelector('.xterm-screen').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: 5, clientY: 5, button: 0, buttons: 1, detail: 1 }));
    await sleep(60);
    R.M1 = { overlay: overlay(s) };
  } catch (e) { R.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, {
  html: PAGE, prefix: "term-sel-", marker: "ENDRESULT", virtualTimeBudget: 60000,
  copy: [path.join(VENDOR, "xterm.min.js"), path.join(VENDOR, "xterm.min.css")],
});
const m = dom.match(/RESULT(\{[\s\S]*?\})ENDRESULT/);
if (!m) { console.error("FAIL  페이지가 결과를 내지 않았다\n" + dom.slice(-1500)); process.exit(1); }
const R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (R.error) { console.error("FAIL  페이지 스크립트 오류: " + R.error); process.exit(1); }

let failed = 0, passed = 0;
const check = (id, ok, detail) => {
  if (ok) { passed++; console.log(`ok   ${id}`); }
  else { failed++; console.log(`FAIL ${id}\n     ${JSON.stringify(detail)}`); }
};
const has = (arr, re) => arr.some((d) => re.test(d));
const DRAG = /\x1b\[<0;\d+;\d+M(\x1b\[<32;\d+;\d+M)+\x1b\[<0;\d+;\d+m/;

check("W1 가짜 Claude 는 마우스 보고를 켰고 커서는 셋째 줄 끝(9행 19칸)", R.W.mode === "any" && R.W.cursor[0] === 19 && R.W.cursor[1] === 9, R.W);
check("K1 ⇧← = «루» 한 글자(17~19칸)를 웹이 칠한다", JSON.stringify(R.K1.overlay) === JSON.stringify([[9, 17, 19]]), R.K1.overlay);
check("K1 · 선택하는 동안 앱으로 보낸 바이트 0", R.K1.sent.length === 0, R.K1.sent);
check("K2 ⇧↑ = 둘째 줄 같은 열(«니» 16칸)부터 커서까지 두 줄에 걸쳐 칠한다", JSON.stringify(R.K2.overlay) === JSON.stringify([[8, 16, 21], [9, 2, 19]]), R.K2.overlay);
check("K2 · 여전히 앱으로 0바이트", R.K2.sent.length === 0, R.K2.sent);
check("D1 ⌫ = 앱이 정확히 그 범위만 지운다(두 줄 → «둘째 줄 반갑습»)", R.D1.text === "첫째 줄 안녕하세요\n둘째 줄 반갑습", R.D1.text);
check("D1 · 보낸 것 = 합성 끌기 한 번 → ⌫ 한 번(순서대로)", R.D1.sent.length === 2 && DRAG.test(R.D1.sent[0]) && R.D1.sent[1] === "\x7f", R.D1.sent);
check("D1 · 앱이 더블클릭으로 읽은 누름 0", R.D1.dbl === 0, R.D1.dbl);
check("D1 · 지우려고 세운 합성 선택의 자동복사는 클립보드를 덮지 않는다", R.D1.clip === null, R.D1.clip);
check("D1 · 지운 뒤 칠한 흔적이 없다", R.D1.overlay.length === 0, R.D1.overlay);
check("K6 ⌘⇧↑ = 입력 처음까지 세 줄", R.K6.overlay.length === 3 && R.K6.overlay[0][0] === 7 && R.K6.overlay[0][1] === 2, R.K6.overlay);
check("X1 ⌘X = 클립보드엔 사람이 친 글 그대로(들여쓰기 없음) · 입력은 비었다", R.X1.clip === "첫째 줄 안녕하세요\n둘째 줄 반갑습니다\n셋째 줄 좋은 하루" && R.X1.text === "", R.X1);
check("C1 ⌘C = «하루» 복사 · 선택은 남고 · ^C 도 ⌫ 도 안 보낸다", R.C1.clip === "하루" && R.C1.overlay.length === 1 && R.C1.sent.length === 0 && R.C1.text.endsWith("좋은 하루"), R.C1);
check("T1 선택 + 글자 = 지운 뒤 그 글자(«하루» → «Z», 순서 보존)", R.T1.text.endsWith("셋째 줄 좋은 Z") && R.T1.sent.indexOf("\x7f") >= 0 && R.T1.sent.indexOf("\x7f") < R.T1.sent.indexOf("Z"), R.T1);
check("A1 선택 + 맨 ← = 캐럿을 선택 앞(«하» 앞 = 셋째 줄 8번째 뒤)으로 · 칠함 거둠", R.A1.caret[0] === 2 && R.A1.caret[1] === 8 && R.A1.overlay.length === 0, R.A1);
check("H1 ⌘↑ = 입력 맨 앞으로(합성 클릭) · 이미 거기면 다시 안 보낸다", R.H1.caret[0] === 0 && R.H1.caret[1] === 0 && R.H1.firstSends === 1 && R.H1.secondSends === 0, R.H1);
check("X2 마우스로 «반갑» 을 끌어 둔 뒤 ⌘X — 앱 칠함을 읽어 잘라낸다", R.X2pre.lit === "반갑" && R.X2.clip === "반갑" && R.X2.text.split("\n")[1] === "둘째 줄 습니다", { pre: R.X2pre, x2: R.X2 });
check("X1 Windows — Shift+Home 으로 줄 선택, Ctrl+X 로 잘라내기", R.X1w.clip === "셋째 줄 좋은 하루" && R.X1w.text === "첫째 줄 안녕하세요\n둘째 줄 반갑습니다\n", R.X1w);
check("D2 앱이 안 칠하면(확인 실패) ⌫ 를 보내지 않는다 — 글자 그대로", R.D2.text === L3.join("\n") && R.D2.sent.indexOf("\x7f") < 0, R.D2);
check("N1 앱이 마우스를 안 쓰는 화면(Codex·셸)은 종전 그대로 — 평범한 ← 를 보내고 합성 끌기는 없다", R.N1.mode === "none" && R.N1.sent.length === 1 && R.N1.sent[0] === "\x1b[D", R.N1);
check("P1 빠른 연속 지우기 — 두 번 다 정확히 지우고(«ghij» → «gh») 더블클릭으로 읽힌 누름 0", R.P1.text === "abc\ndef\ngh" && R.P1.dbl === 0, R.P1);
check("S1 선택 뒤 앱이 입력칸을 다시 그렸으면(글자 바뀜) 낡은 좌표로 안 지운다 — 평범한 ⌫ 한 글자", R.S1.text.endsWith("!셋째 줄 좋은 하") && !has(R.S1.sent, DRAG), R.S1);
check("X4 마우스로 끈 «반갑» 위에 글자를 치면 갈아치운다(앱은 캐럿 자리에 넣기만 한다)", R.X4.text.split("\n")[1] === "둘째 줄 Z습니다", R.X4);
check("X5 마우스로 끈 «반갑» 위에 붙여넣으면 갈아치운다", R.X5.text.split("\n")[1] === "둘째 줄 Q습니다", R.X5);
check("P2 지우는 도중 누른 Shift+← 는 무시 — 합성 누름 한 번 · 새 선택 없음 · «루» 만 지움", R.P2.text.endsWith("셋째 줄 좋은 하") && R.P2.presses === 1 && R.P2.overlay.length === 0, R.P2);
check("M1 마우스 누름 = 웹 선택 거둠(마우스는 앱 것)", R.M1.overlay.length === 0, R.M1);

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
