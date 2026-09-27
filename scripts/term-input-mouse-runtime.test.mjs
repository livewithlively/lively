#!/usr/bin/env node
// 터미널 입력줄의 마우스 — **런타임** 회귀 테스트 (#4406, 2026-09-27)
//
// 사양: 마우스 누름·끌기·놓기는 그 화면에서 마우스를 받는 쪽의 것이다 — 앱이 마우스 보고를 켠 화면(Claude Code
//  전체화면: 1003+SGR)이면 앱이, 안 켠 화면(Codex·셸)이면 xterm 자체 선택이 받는다. 입력줄(커서가 있는 줄)도
//  다른 줄과 똑같다 — 웹은 누름을 삼키지 않고 방향키 등 어떤 바이트도 스스로 만들어 보내지 않는다. 누르면 터미널
//  입력이 포커스를 받는다. 웹이 더하는 일은 하나: 누름이 오면 웹이 키보드로 세운 선택(Shift+방향키)을 거둔다.
//
// 엣지 표(행마다 시나리오 하나 — 커서는 입력줄 «❯ 안녕하세요 반갑습니다» 끝 23칸, 한글은 한 글자 두 칸):
//  A1 앱 마우스·입력줄·넓은 글자 뒤 칸(16) 클릭 → 앱이 16칸의 누름·뗌을 받는다 · 웹이 보낸 바이트 0
//  A2 앱 마우스·입력줄 13→22 끌기               → 앱이 누름(13) → 눌린 채 이동 → 뗌(22)을 순서대로 받는다 · 웹 0
//  A3 앱 마우스·다른 줄 클릭(대조)              → 앱이 누름을 받는다(겨냥·장치가 맞다는 증거)
//  A4 앱 마우스·입력줄 누름(포커스는 딴 데)      → 터미널 입력이 포커스를 가져온다
//  A5 앱 마우스·입력줄·커서 칸 자체(경계: 거리 0) → 앱이 누름을 받는다 · 웹 0
//  A6 앱 마우스·입력줄·맨 앞 칸 ❯(경계)          → 앱이 누름을 받는다 · 웹 0(빈 입력의 ← 는 Claude Code «에이전트 보기» 다)
//  B1 마우스 없음·입력줄 13→22 끌기             → xterm 선택 = «반갑습니다» · 앱·웹 0
//  B2 마우스 없음·입력줄 클릭                   → 앱·웹 0(방향키로 커서를 끌고 다니지 않는다)
//  B3 마우스 없음·다른 줄 끌기(대조)            → xterm 선택 = 그 줄 글자
//  B4 마우스 없음·입력줄 누름(포커스는 딴 데)    → 터미널 입력이 포커스
//  D1 앱 마우스·입력줄 Shift+끌기(강제 선택)     → xterm 선택 = «반갑습니다» · 앱·웹 0
//  C1 키보드 선택 뒤 입력줄 누름               → 웹 선택을 거둔다
//  C2 키보드 선택 뒤 다른 줄 누름              → 웹 선택을 거둔다(앱·xterm 선택과 두 겹으로 남지 않게)
//
// 왜 런타임인가: 결함이 «capture 리스너 하나가 누름을 삼킨다» 와 «xterm 이 그 누름으로 무엇을 하나»(앱에 보고 · 선택 ·
//  포커스)의 조합이라 소스 모양으로는 안 보인다. 그래서 실제 vendored xterm 을 헤드리스 크롬에 띄우고, 프로덕션
//  소스(web/standalone/terminal.ts)를 esbuild 로 묶어 boot() 가 거는 배선 함수 wireInputLineMouse 를 그대로 건다.
//  «앱이 받았다» 는 xterm onData 로 나가는 SGR 마우스 보고로, «웹이 보냈다» 는 소켓 대역(ws.send)으로 잰다 — 문구가 아니라 부작용이다.
//
// fail-first: `TERM_SRC=<변이 소스>`(같은 web/standalone 폴더에 둬야 상대 import 가 풀린다)로 다른 terminal.ts 를 물린다.
//  입력줄 끌기를 가로채던 판(d39e1ba4 의 wireInputMouseSelect 본문)을 wireInputLineMouse 자리에 넣은 변이는
//  A1·A2·A4·A5·A6·B1·B2·B4·C2 가 빨간불이다(2026-09-27 실측). 해제 리스너를 뺀 변이는 C1·C2 가 빨간불이다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 입력줄 마우스 런타임 검증 미실행");
  process.exit(0);
}
const VENDOR = path.join(ROOT, "public/vendor/xterm");
for (const f of ["xterm.min.js", "xterm.min.css"]) {
  if (!existsSync(path.join(VENDOR, f))) { console.error(`FAIL  vendored xterm 없음: ${f}`); process.exit(1); }
}

// 프로덕션 소스를 그대로 묶는다(import 만으로는 부팅하지 않는다 — boot() 는 terminal.entry.ts 에 있다).
const SRC = process.env.TERM_SRC || path.join(ROOT, "web/standalone/terminal.ts");
const bundle = buildSync({
  entryPoints: [SRC], bundle: true, format: "iife", globalName: "TM", write: false,
  platform: "browser", target: "es2020", define: { TERMJS_BUILD: JSON.stringify("test") }, logLevel: "silent",
}).outputFiles[0].text;

const PROMPT = "❯ 안녕하세요 반갑습니다";   // ❯ 한 칸 · 공백 뒤 한글
const CURSOR_COL = 23;                          // 2 + 안녕하세요(10) + 공백(1) + 반갑습니다(10)
const INPUT_ROW = 3, OUT_ROW = 1;               // 0-기준 — 입력줄(커서) · 출력줄(대조)
const OUT_TEXT = "done: tests passed";
const WORD_FROM = 13, WORD_TO = 22;             // «반갑습니다» 가 차지하는 칸
const WIDE_TAIL = 16;                           // «갑»(15·16)의 뒤 칸

const PAGE = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.min.css">
<style>html,body{margin:0}</style><button id="elsewhere">elsewhere</button><pre id="out">PENDING</pre>
<script src="xterm.min.js"></script>
<script type="text/plain" id="tmsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>
var C = ${JSON.stringify({ PROMPT, INPUT_ROW, OUT_ROW, OUT_TEXT, WORD_FROM, WORD_TO, WIDE_TAIL, CURSOR_COL })};
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
// 장면마다 **새 모듈 인스턴스** — 모듈 전역(웹 선택 앵커 등)이 장면 사이로 새지 않게(단위 하네스의 ?n= 격리와 같다).
//  실측: 한 인스턴스를 돌려 쓰면 옛 판이 앞 장면에 남긴 선택이 다음 장면의 전제를 흐렸다. livelyTermDiag 도 새 인스턴스 것이 된다.
var TMSRC = document.getElementById('tmsrc').textContent;
function freshModule() { return (new Function(TMSRC + '\\n;return TM;'))(); }
// 한 장면 — 새 터미널에 프로덕션 배선을 건다. mouse=true 면 앱이 마우스 보고를 켠 화면(Claude Code 전체화면과 같은 모드).
function scene(mouse) {
  return new Promise(function (resolve) {
    var host = document.createElement('div');
    host.style.width = '480px'; host.style.height = '160px';
    document.body.insertBefore(host, document.getElementById('out'));
    // 프로덕션과 같은 마우스 옵션(나머지는 기본) — web/standalone/terminal.ts boot() 의 new Terminal
    var term = new Terminal({ cols: 40, rows: 6, fontSize: 14, macOptionClickForcesSelection: true, rightClickSelectsWord: false });
    term.open(host);
    var s = { term: term, host: host, sent: [], app: [], tm: freshModule() };
    s.tm.__injectRefsForTest({ term: term, ws: { readyState: 1, send: function (m) { s.sent.push(m); }, close: function () {} } });
    s.tm.wireInputLineMouse(host);                 // boot() 가 거는 그 함수
    term.onData(function (d) { s.app.push(d); });  // xterm 이 앱으로 내보내는 것(마우스 보고·키)
    var body = (mouse ? '\\x1b[?1003h\\x1b[?1006h' : '') + '\\x1b[' + (C.OUT_ROW + 1) + ';1H' + C.OUT_TEXT
      + '\\x1b[' + (C.INPUT_ROW + 1) + ';1H' + C.PROMPT;   // 마지막에 쓴 자리 = 커서(입력줄 끝)
    term.write(body, function () { setTimeout(function () { resolve(s); }, 30); });
  });
}
function xy(s, col, row) {
  var r = s.host.querySelector('.xterm-screen').getBoundingClientRect();
  return { x: r.left + (col + 0.5) * r.width / s.term.cols, y: r.top + (row + 0.5) * r.height / s.term.rows };
}
// 누름은 화면 요소에, 이동·뗌은 문서에 — 브라우저가 끌기 중에 보내는 자리 그대로.
//  detail = 클릭 횟수(브라우저가 누름·뗌에 싣는 값). xterm 은 detail===1 일 때만 한 번 클릭 선택을 시작한다 — 합성
//  이벤트의 기본값 0 으로 쏘면 선택이 아예 안 생겨 B·D 행이 장치 탓으로 빨개진다(2026-09-27 실측, 대조 B3 까지).
function fire(s, type, col, row, buttons, mods) {
  var p = xy(s, col, row), m = mods || {};
  var target = type === 'mousedown' ? s.host.querySelector('.xterm-screen') : document;
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window,
    clientX: p.x, clientY: p.y, button: 0, buttons: buttons, detail: type === 'mousemove' ? 0 : 1, shiftKey: !!m.shift }));
}
async function click(s, col, row) { fire(s, 'mousedown', col, row, 1); await sleep(90); fire(s, 'mouseup', col, row, 0); await sleep(250); }
async function drag(s, row, from, to, mods) {
  fire(s, 'mousedown', from, row, 1, mods); await sleep(60);
  for (var c = from + 1; c <= to; c++) { fire(s, 'mousemove', c, row, 1, mods); await sleep(40); }
  fire(s, 'mouseup', to, row, 0, mods); await sleep(250);
}
function sent(s) { return s.sent.map(function (m) { try { return JSON.parse(m); } catch (_) { return null; } }).filter(function (m) { return m && m.t === 'i'; }).map(function (m) { return m.d; }); }
function reports(s) { var out = []; s.app.join('').replace(/\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g, function (_, b, x, y, k) { out.push([+b, +x, +y, k]); return ''; }); return out; }
function focusElsewhere() { document.getElementById('elsewhere').focus(); return document.activeElement && document.activeElement.id; }
// 웹 선택을 세운다 — 사람과 같은 길(Shift+← keydown → 프로덕션 키 처리기)로.
async function keyboardSelect(s) {
  s.tm.setupClipboard();
  s.term.focus();
  s.term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }));
  await sleep(30);
}
function diag() { return String(window.livelyTermDiag()); }
async function clearedByPress(s, col, row) {
  await keyboardSelect(s);
  var d0 = diag(); await click(s, col, row); var d1 = diag();
  return { selOn: /sel-on/.test(d0), offAfter: (d1.slice(d0.length).match(/sel-off[^\\n]*/) || [''])[0] };
}
(async function () {
  var R = {}, s, b;
  try {
    s = await scene(true); R.W = { mode: s.term.modes.mouseTrackingMode, cursor: [s.term.buffer.active.cursorX, s.term.buffer.active.cursorY] };
    await click(s, C.WIDE_TAIL, C.INPUT_ROW); R.A1 = { reports: reports(s), sent: sent(s) };
    s = await scene(true); await drag(s, C.INPUT_ROW, C.WORD_FROM, C.WORD_TO); R.A2 = { reports: reports(s), sent: sent(s) };
    s = await scene(true); await click(s, 3, C.OUT_ROW); R.A3 = { reports: reports(s), sent: sent(s) };
    s = await scene(true); b = focusElsewhere(); await click(s, C.WIDE_TAIL, C.INPUT_ROW);
    R.A4 = { before: b, focused: document.activeElement === s.term.textarea };
    s = await scene(true); await click(s, C.CURSOR_COL, C.INPUT_ROW); R.A5 = { reports: reports(s), sent: sent(s) };
    s = await scene(true); await click(s, 0, C.INPUT_ROW); R.A6 = { reports: reports(s), sent: sent(s) };
    s = await scene(false); R.W.offMode = s.term.modes.mouseTrackingMode;
    await drag(s, C.INPUT_ROW, C.WORD_FROM, C.WORD_TO); R.B1 = { selection: s.term.getSelection(), app: s.app.slice(), sent: sent(s) };
    s = await scene(false); await click(s, C.WIDE_TAIL, C.INPUT_ROW); R.B2 = { app: s.app.slice(), sent: sent(s) };
    s = await scene(false); await drag(s, C.OUT_ROW, 0, 4); R.B3 = { selection: s.term.getSelection() };
    s = await scene(false); b = focusElsewhere(); await click(s, C.WIDE_TAIL, C.INPUT_ROW);
    R.B4 = { before: b, focused: document.activeElement === s.term.textarea };
    s = await scene(true); await drag(s, C.INPUT_ROW, C.WORD_FROM, C.WORD_TO, { shift: true });
    R.D1 = { selection: s.term.getSelection(), app: s.app.slice(), sent: sent(s) };
    s = await scene(true); R.C1 = await clearedByPress(s, C.WIDE_TAIL, C.INPUT_ROW);
    s = await scene(true); R.C2 = await clearedByPress(s, 3, C.OUT_ROW);
  } catch (e) { R.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, {
  html: PAGE, prefix: "term-mouse-", marker: "ENDRESULT", virtualTimeBudget: 30000,
  copy: [path.join(VENDOR, "xterm.min.js"), path.join(VENDOR, "xterm.min.css")],
});
const m = dom.match(/RESULT(\{[\s\S]*?\})ENDRESULT/);
if (!m) { console.error("FAIL  페이지가 결과를 내지 않았다\n" + dom.slice(0, 1500)); process.exit(1); }
const R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (R.error) { console.error("FAIL  페이지 스크립트 오류: " + R.error); process.exit(1); }

let failed = 0, passed = 0;
const check = (id, ok, detail) => {
  if (ok) { passed++; console.log(`ok   ${id}`); }
  else { failed++; console.log(`FAIL ${id}\n     ${JSON.stringify(detail)}`); }
};
const c1 = (c) => c + 1;   // SGR 보고는 1-기준
const r1 = (r) => r + 1;
// 그 칸의 누름(M)·뗌(m) — 왼쪽 버튼(0), 수정자 없음
const pressAt = (reps, col, row) => reps.findIndex((r) => r[0] === 0 && r[3] === "M" && r[1] === c1(col) && r[2] === r1(row));
const releaseAt = (reps, col, row) => reps.findIndex((r) => r[0] === 0 && r[3] === "m" && r[1] === c1(col) && r[2] === r1(row));

// 배선 — 장면이 뜻대로 섰나(틀리면 아래 판정은 아무것도 안 잰다)
check("W1 앱 마우스 장면은 실제로 마우스 보고가 켜져 있다(any)", R.W.mode === "any", R.W);
check("W2 마우스 없음 장면은 실제로 꺼져 있다", R.W.offMode === "none", R.W);
check("W3 커서가 입력줄 끝(23칸)에 섰다", R.W.cursor[0] === CURSOR_COL && R.W.cursor[1] === INPUT_ROW, R.W.cursor);
check("W4 키보드 선택이 실제로 섰다(C 행의 전제)", R.C1.selOn && R.C2.selOn, { C1: R.C1, C2: R.C2 });

check("A1 앱 마우스·입력줄·넓은 글자 뒤 칸 클릭 → 앱이 그 칸의 누름·뗌을 받는다",
  pressAt(R.A1.reports, WIDE_TAIL, INPUT_ROW) === 0 && releaseAt(R.A1.reports, WIDE_TAIL, INPUT_ROW) > 0, R.A1.reports);
check("A1 · 웹이 보낸 바이트 0", R.A1.sent.length === 0, R.A1.sent);
const a2 = R.A2.reports;
const a2p = pressAt(a2, WORD_FROM, INPUT_ROW);
const a2m = a2.findIndex((r) => (r[0] & 32) && (r[0] & 3) === 0 && r[3] === "M");   // 왼쪽 버튼을 쥔 채 이동
const a2u = releaseAt(a2, WORD_TO, INPUT_ROW);
check("A2 앱 마우스·입력줄 끌기 → 누름(13) → 눌린 채 이동 → 뗌(22) 순서로 앱에 간다", a2p === 0 && a2m > a2p && a2u > a2m, a2);
check("A2 · 웹이 보낸 바이트 0", R.A2.sent.length === 0, R.A2.sent);
check("A3 (대조) 다른 줄 클릭 → 앱이 누름을 받는다", pressAt(R.A3.reports, 3, OUT_ROW) === 0, R.A3.reports);
check("A4 앱 마우스·입력줄 누름 → 터미널 입력이 포커스를 가져온다", R.A4.before === "elsewhere" && R.A4.focused === true, R.A4);
check("A5 경계: 커서 칸 자체 클릭 → 앱이 누름을 받는다 · 웹 0", pressAt(R.A5.reports, CURSOR_COL, INPUT_ROW) === 0 && R.A5.sent.length === 0, R.A5);
check("A6 경계: 맨 앞 칸(❯) 클릭 → 앱이 누름을 받는다 · 웹 0", pressAt(R.A6.reports, 0, INPUT_ROW) === 0 && R.A6.sent.length === 0, R.A6);
check("B1 마우스 없음·입력줄 끌기 → xterm 선택 = «반갑습니다»", R.B1.selection === "반갑습니다", R.B1.selection);
check("B1 · 앱·웹으로 나간 것 0", R.B1.app.length === 0 && R.B1.sent.length === 0, { app: R.B1.app, sent: R.B1.sent });
check("B2 마우스 없음·입력줄 클릭 → 앱·웹으로 나간 것 0", R.B2.app.length === 0 && R.B2.sent.length === 0, R.B2);
// 끝점은 칸 가운데 기준으로 가까운 경계에 붙는다 — «:»(4칸) 가운데까지 끌면 «done»(0~3칸)이다.
check("B3 (대조) 다른 줄 끌기 → 그 줄 글자가 선택된다", R.B3.selection === OUT_TEXT.slice(0, 4), R.B3.selection);
check("B4 마우스 없음·입력줄 누름 → 터미널 입력이 포커스를 가져온다", R.B4.before === "elsewhere" && R.B4.focused === true, R.B4);
check("D1 앱 마우스·입력줄 Shift+끌기 → xterm 선택 = «반갑습니다» · 앱·웹 0",
  R.D1.selection === "반갑습니다" && R.D1.app.length === 0 && R.D1.sent.length === 0, R.D1);
check("C1 키보드 선택 뒤 입력줄 누름 → 웹 선택을 거둔다", /sel-off/.test(R.C1.offAfter), R.C1);
check("C2 키보드 선택 뒤 다른 줄 누름 → 웹 선택을 거둔다", /sel-off/.test(R.C2.offAfter), R.C2);

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
