#!/usr/bin/env node
// 터미널 우클릭 [복사] — **런타임** 회귀 테스트 (#3778)
//
// 사양: 우클릭은 메뉴를 띄우는 동작이다. 우클릭 자체가 사람의 선택을 만들거나·바꾸거나·지워선 안 된다.
//  메뉴가 [복사] 대상으로 읽는 것은 그 전에 사람이 만든 선택이어야 한다.
//
// 왜 소스 정규식(ctx-menu-wiring E10h~E10j)으로 부족한가:
//  그것들은 web/standalone/terminal.ts 의 **글자 모양**만 본다. 이 레포는 같은 날 «문자열은 실렸는데
//  규칙이 죽어 있던» 거짓 초록을 세 번 겪었다(#830 CSS 특이도 · #835 주석 잔류 · 번들 한글 이스케이프).
//  우클릭 축도 같은 모양이다 — 옵션 한 글자(rightClickSelectsWord)와 리스너 위상(capture/bubble) 하나가
//  서로를 덮어 «설정은 있는데 xterm 이 먼저 이긴다» 가 된다. 그래서 여기서는 실제 vendored xterm 을
//  헤드리스 크롬에 띄워 우클릭을 쏘고, 그 순간 우리 메뉴가 읽게 될 term.getSelection() 을 잰다.
//
// 프로덕션 설정은 소스에서 뽑아 쓴다 — 누가 옵션을 되돌리면 이 테스트가 빨간불이 된다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
//
// ⚠ 헤드리스 한계(실측): 디스플레이가 없어 requestAnimationFrame 이 안 돌고, 그래서 xterm 이 **행을
//  그리지 않는다**(.xterm-rows 자식의 textContent 가 비고 rect 가 0). 선택 좌표 계산은 렌더가 아니라
//  .xterm-screen 의 rect 로 하므로 그건 정상 동작한다 — 그래서 클릭은 전부 **첫 행**에만 쏘고, 선택
//  범위를 옮겨 「안쪽/바깥쪽」을 만든다. 겨냥이 맞았다는 것은 고장 설정이 실제로 'bravo' 를 집어내는
//  것으로 증명한다(아래 G1).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 런타임 우클릭 검증 미실행");
  process.exit(0);
}

const VENDOR = path.join(ROOT, "public/vendor/xterm");
for (const f of ["xterm.min.js", "xterm.min.css"]) {
  if (!existsSync(path.join(VENDOR, f))) { console.error(`FAIL  vendored xterm 없음: ${f}`); process.exit(1); }
}

// ── 프로덕션 설정을 소스에서 뽑는다 ──────────────────────────────────────────
const SRC = readFileSync(path.join(ROOT, "web/standalone/terminal.ts"), "utf8");
const optM = SRC.match(/rightClickSelectsWord:\s*(true|false)\s*,/);
if (!optM) { console.error("FAIL  terminal.ts 에서 rightClickSelectsWord 를 못 찾았다"); process.exit(1); }
const prodRcsw = optM[1] === "true";
const prodCapture = /\], '터미널'\);\s*\}, true\);/.test(SRC);

const L0 = "alpha bravo charlie", L1 = "delta echo foxtrot", L2 = "golf hotel india";
const WORD_COL = 6;    // 첫 행 'bravo' 안쪽
const BLANK_COL = 30;  // 첫 행에서 글자가 없는 열
const SEL_01 = L0 + "\n" + L1;   // 1~2행 선택 — 첫 행 클릭이 «안쪽»
const SEL_12 = L1 + "\n" + L2;   // 2~3행 선택 — 첫 행 클릭이 «바깥»

const PAGE = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.min.css">
<style>html,body{margin:0}</style><pre id="out">PENDING</pre>
<script src="xterm.min.js"></script>
<script id="cfg" type="application/json">__CASES__</script>
<script>
function scenario(c) {
  return new Promise(function (resolve) {
    var host = document.createElement('div');
    host.style.width = '900px'; host.style.height = '300px';
    document.body.insertBefore(host, document.getElementById('out'));
    var term = new Terminal({ rightClickSelectsWord: c.rcsw, cols: 40, rows: 6 });
    term.open(host);
    var body = ${JSON.stringify(L0 + "\r\n" + L1 + "\r\n" + L2 + "\r\n")};
    // 마우스모드 행은 실제로 켠다(\\x1b[?1000h) — «앱이 마우스를 가져간 화면» 을 흉내가 아니라 상태로 만든다
    term.write((c.mouse ? '\\x1b[?1000h' : '') + body, function () {
     setTimeout(function () {
      var mouseMode = 'none';
      try { mouseMode = String((term.modes && term.modes.mouseTrackingMode) || 'none'); } catch (_) {}
      if (c.selectLines) term.selectLines(c.selectLines[0], c.selectLines[1]);
      var before = term.getSelection() || '';
      var xsel = null;
      host.addEventListener('contextmenu', function (e) {
        xsel = term.hasSelection() ? String(term.getSelection() || '') : '';   // 프로덕션과 같은 순서
        e.preventDefault(); e.stopPropagation();
      }, c.capture);
      var screen = host.querySelector('.xterm-screen');
      var sr = screen.getBoundingClientRect();
      var cw = sr.width / term.cols, chh = sr.height / term.rows;
      screen.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: sr.left + cw * (c.col + 0.5), clientY: sr.top + chh * 0.5 }));   // 항상 첫 행
      setTimeout(function () {
        var out = { id: c.id, before: before, mouseMode: mouseMode,
                    xsel: xsel === null ? '<no-handler>' : xsel };
        // ⚠ 시나리오마다 반드시 치운다 — 터미널을 쌓아 두면 뒤쪽 것이 뷰포트 밖으로 밀리고,
        //   xterm 의 좌표→셀 변환이 화면 밖에서 어긋나 «단어를 못 집는» 거짓 결과가 나온다(실측).
        try { term.dispose(); } catch (_) {}
        host.remove();
        resolve(out);
      }, 30);
     }, 60);
    });
  });
}
(async function () {
  var cases = JSON.parse(document.getElementById('cfg').textContent);
  var out = [];
  for (var i = 0; i < cases.length; i++) out.push(await scenario(cases[i]));
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(out) + 'ENDRESULT';
})();
</script>`;

// 엣지 표(spec) 한 행 = 시나리오 하나. prod / 알려진 고장 두 설정으로 각각 돌린다.
const EDGES = [
  { id: "E1", desc: "마우스모드·선택없음·단어 위", mouse: true, col: WORD_COL, selectLines: null, expect: "" },
  { id: "E2", desc: "마우스모드·선택없음·공백 위", mouse: true, col: BLANK_COL, selectLines: null, expect: "" },
  { id: "E3", desc: "셸·여러 줄 선택·선택 안쪽", mouse: false, col: WORD_COL, selectLines: [0, 1], expect: SEL_01 },
  { id: "E4", desc: "셸·여러 줄 선택·선택 바깥 단어 위", mouse: false, col: WORD_COL, selectLines: [1, 2], expect: SEL_12 },
  { id: "E5", desc: "셸·여러 줄 선택·선택 바깥 공백 위", mouse: false, col: BLANK_COL, selectLines: [1, 2], expect: SEL_12 },
  { id: "E6", desc: "셸·선택없음·단어 위", mouse: false, col: WORD_COL, selectLines: null, expect: "" },
];
const cases = [
  ...EDGES.map((e) => ({ ...e, id: e.id + ".prod", rcsw: prodRcsw, capture: prodCapture })),
  ...EDGES.map((e) => ({ ...e, id: e.id + ".broken", rcsw: true, capture: false })),
];

// 크롬 실행·표지 대기·임시 디렉터리 치우기는 scripts/headless-chrome.mjs 한 벌이 맡는다(#3890 — 치우기 경주로
//  단언 0개 종료가 나던 자리). 이 페이지는 xterm 이 타이머를 계속 걸어 가상시간을 넉넉히 준다.
const dom = await dumpDom(chrome, {
  html: PAGE.replace("__CASES__", JSON.stringify(cases)),
  copy: ["xterm.min.js", "xterm.min.css"].map((f) => path.join(VENDOR, f)),
  prefix: "ctx-rclick-",
});
const m = dom.match(/RESULT(\[.*?\])ENDRESULT/s);   // 표지 없이 끝났으면 여기서 잡는다
if (!m) {
  console.error("FAIL  크롬이 결과를 안 냈다 — 페이지가 끝까지 못 갔다");
  process.exit(1);
}
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const results = JSON.parse(unesc(m[1]));

const by = Object.fromEntries(results.map((r) => [r.id, r]));
// 진단용 — 무엇이 실제로 잡혔는지 한 줄씩 보고 싶을 때 RCLICK_DEBUG=1
if (process.env.RCLICK_DEBUG) for (const r of results) console.log("DBG", r.id, "mouse=" + r.mouseMode, "before=" + JSON.stringify(r.before), "xsel=" + JSON.stringify(r.xsel));
let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log("ok   " + label); }
  else { fail++; console.log("FAIL " + label + "  ← " + detail); }
};
const shown = (v) => JSON.stringify(v === undefined ? "<missing>" : v);
const got = (id) => by[id] && by[id].xsel;

// ── 0) 배선 단언 — 관측 장치가 죽어 있으면 아래 판정이 전부 무의미하다 ──────
ok(results.length === cases.length, "W1 모든 시나리오가 돌았다", `${results.length}/${cases.length}`);
ok(EDGES.every((e) => got(e.id + ".prod") !== "<no-handler>" && got(e.id + ".prod") !== undefined),
  "W2 우클릭이 실제로 우리 핸들러까지 왔다", "핸들러 미발화 케이스가 있다");
ok(by["E1.prod"] && by["E1.prod"].mouseMode !== "none" && by["E6.prod"] && by["E6.prod"].mouseMode === "none",
  "W3 마우스모드 행은 실제로 마우스모드다(셸 행은 아니다)",
  `E1=${shown(by["E1.prod"] && by["E1.prod"].mouseMode)} E6=${shown(by["E6.prod"] && by["E6.prod"].mouseMode)}`);
ok(by["E3.prod"] && by["E3.prod"].before === SEL_01 && by["E4.prod"] && by["E4.prod"].before === SEL_12,
  "W4 우클릭 직전 선택이 의도대로 만들어졌다",
  `E3=${shown(by["E3.prod"] && by["E3.prod"].before)} E4=${shown(by["E4.prod"] && by["E4.prod"].before)}`);

// ── 1) 소스 설정 ────────────────────────────────────────────────────────────
ok(prodRcsw === false, "R1 프로덕션은 xterm 우클릭 단어선택을 끈다", `rightClickSelectsWord=${prodRcsw}`);
ok(prodCapture === true, "R2 프로덕션 contextmenu 는 capture 다", `capture=${prodCapture}`);

// ── 2) 재현 게이트 — 하네스가 고장을 볼 줄 아는가 + 겨냥이 맞았는가 ────────
ok(got("E1.broken") === "bravo",
  "G1 [재현] 옛 설정은 마우스모드에서 커서 밑 단어를 훔친다(신고된 「복사 N자」) · 겨냥이 그 단어에 맞았다",
  `xsel=${shown(got("E1.broken"))}`);
ok(got("E4.broken") !== SEL_12,
  "G2 [재현] 옛 설정은 셸에서 선택 바깥 우클릭에 여러 줄 선택을 잃는다",
  `xsel=${shown(got("E4.broken"))}`);

// ── 3) 본 판정 — 엣지 표 전 행 ──────────────────────────────────────────────
for (const e of EDGES) {
  ok(got(e.id + ".prod") === e.expect, `${e.id} ${e.desc} → ${e.expect ? "선택 보존" : "선택 없음"}`,
    `기대=${shown(e.expect)} 실제=${shown(got(e.id + ".prod"))}`);
}

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
