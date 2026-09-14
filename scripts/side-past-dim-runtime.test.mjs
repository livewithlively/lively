#!/usr/bin/env node
// 지난 세션 줄이 **눈에 띄게** 흐린가 — 런타임(헤드리스 computed) 회귀 테스트 (#3870)
//
// 사양 — 원준 2026-09-09 «세션 아이콘이나 이름도 좀 덜 진하게 해서 비활성화되어 있는 느낌»,
//         2026-09-13 «지난 세션들 조금 흐리게 해서 비활성화된 느낌 주라고 했는데 … 그냥 차이가 없는데?»
//  ① 지난 세션 줄의 이름은 같은 자리의 살아 있는 줄보다 **눈에 띄게** 옅다 — 명도 차 ΔL* ≥ 15
//     (#3778 판은 --ink-sub → --muted 한 단계라 ΔL* 7 남짓이었고, 사람 눈엔 «차이가 없었다»)
//  ② 그래도 읽힌다 — 바탕 대비 ≥ 2.5:1
//  ③ 고른 줄(.on)은 제 농도로 돌아온다 — 살아 있는 고른 줄과 ΔL* ≤ 2
//  ④ 조작(압정·×·휴지통)은 흐림을 물려받지 않는다 — 부모 사슬의 opacity 곱 = 1
//  ⑤ 살아 있는 줄은 흐리지 않는다
//  ⑥ 이름만이 아니라 줄 내용이 함께 흐리다 — 둘째 줄(내 마지막 말) · 남의 세션 얼굴
//  세 자리(홈 카드 한 줄 · [AI 세션] 두 줄 · 프로젝트 트리) × 라이트·다크.
//
// 왜 소스 문자열로 부족한가: 이 규칙은 **두 번** «실렸는데 안 보였다». #2208 판은 같은 토큰 재도색 + 특이도 패배로
//  죽어 있었고(#3778 실측), #3778 판은 살아났지만 차이가 너무 작았다. 둘 다 문자열 검사로는 초록이다.
//  그래서 실제 스타일시트를 헤드리스 크롬에 물려 **계산된 색·농도를 실제 바탕에 합성한 명도**(사람이 보는 값)를 잰다.
//  ⚠ 호버는 여기서 못 쏜다(--dump-dom 에는 포인터가 없다) — 되찾기는 .on 으로 잰다(같은 :is() 규칙이다).
//  ⚠ 글자는 ASCII 만 쓴다 — 계산값은 글리프와 무관하고, 글꼴 없는 면에서 한글 조판이 크롬을 죽인 적이 있다(#3870 실측).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 지난 세션 흐림 런타임 검증 미실행");
  process.exit(0);
}

const STYLES = path.join(ROOT, "public/styles");
const CSS = ["01-base.css", "40-v2.css", "90-dark.css"].map((f) => path.join(STYLES, f));
for (const f of CSS) if (!existsSync(f)) { console.error(`FAIL  스타일시트 없음: ${path.relative(ROOT, f)}`); process.exit(1); }

const MIN_DL = 15, MIN_CONTRAST = 2.5, MAX_ON_DL = 2;
// 배선 — 스타일시트가 실제로 물렸는지는 토큰이 풀리는 값으로 본다(안 물리면 전부 기본색이라 «살아 있는 줄 안 흐림» 류가 공짜로 초록이 된다).
const CANVAS = { light: "#E6EBF3", dark: "#0C111D" };

// 행 모양은 web/v2/side.ts 의 appRowEl · sessRow 가 만드는 그대로다(클래스·자식 순서).
const icon = '<svg class="v2-app-inst-ic" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';
const inst = (id, cls, title, second = "") =>
  `<div class="v2-app-inst ${cls}" id="${id}"><button class="v2-app-inst-open" type="button">${icon}<span class="v2-app-inst-title">${title}</span></button>` +
  `<button class="v2-app-inst-pin" type="button"></button><button class="v2-app-inst-close" type="button"></button>${second}</div>`;
const ask = '<span class="v2-app-inst-ask"><span class="v2-app-inst-askt">last ask</span></span>';
// 트리 줄: 점 · 이름 · (남의 세션이면 얼굴) · (지난 세션이면 시각) · (내 세션이면 단추)
const tree = (id, cls, { past = false, face = false, ctrl = true } = {}) =>
  `<a class="v2-ss-row ${cls}" id="${id}" href="#"><span class="v2-dot quiet"></span><span class="v2-ss-main"><span class="t">session name</span></span>` +
  `${face ? '<span class="v2-ss-face">AB</span>' : ""}${past ? '<span class="w">3h</span>' : ""}${ctrl ? '<button class="v2-ss-x" type="button"></button>' : ""}</a>`;

const IDS = ["c-live", "c-past", "c-live-on", "c-past-on", "s-live", "s-past", "t-live", "t-past", "t-live-on", "t-past-on", "t-past-other"];

const page = (theme) => `<!doctype html><html${theme === "dark" ? ' data-theme="dark"' : ""}><meta charset="utf-8">
<link rel="stylesheet" href="01-base.css"><link rel="stylesheet" href="40-v2.css"><link rel="stylesheet" href="90-dark.css">
<body><div class="v2-side" style="width:300px">
<div class="v2-pg open"><div class="v2-pg-list">
${inst("c-live", "v2-app-inst--1", "live session")}
${inst("c-past", "v2-app-inst--1 v2-app-inst--past", "past session")}
${inst("c-live-on", "v2-app-inst--1 on", "live session")}
${inst("c-past-on", "v2-app-inst--1 v2-app-inst--past on", "past session")}
</div></div>
${inst("s-live", "", "live session", ask)}
${inst("s-past", "v2-app-inst--past", "past session", ask)}
<div class="v2-ss-list">
${tree("t-live", "")}
${tree("t-past", "past", { past: true })}
${tree("t-live-on", "on")}
${tree("t-past-on", "past on", { past: true })}
${tree("t-past-other", "past other", { past: true, face: true, ctrl: false })}
</div></div>
<pre id="out">PENDING</pre>
<script>
(function () {
  var nums = function (c) { var m = String(c).match(/[\\d.]+/g) || [0, 0, 0]; return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 }; };
  var lin = function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  var lum = function (c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); };
  var lstar = function (y) { return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y; };
  var chain = function (el) { var a = 1; for (var e = el; e; e = e.parentElement) a *= parseFloat(getComputedStyle(e).opacity); return a; };
  var bgOf = function (el) { for (var e = el; e; e = e.parentElement) { var c = nums(getComputedStyle(e).backgroundColor); if (c.a >= 0.999) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  var measure = function (row, textSel, ctrlSel) {
    var t = row.querySelector(textSel), c = nums(getComputedStyle(t).color), bg = bgOf(t), op = chain(t), a = c.a * op;
    var eff = { r: c.r * a + bg.r * (1 - a), g: c.g * a + bg.g * (1 - a), b: c.b * a + bg.b * (1 - a) };
    var ye = lum(eff), yb = lum(bg);
    var ctrl = ctrlSel ? row.querySelector(ctrlSel) : null;
    return { L: +lstar(ye).toFixed(2), contrast: +((Math.max(ye, yb) + 0.05) / (Math.min(ye, yb) + 0.05)).toFixed(2), op: +op.toFixed(3),
      ctrlParentOp: ctrl ? +chain(ctrl.parentElement).toFixed(3) : null, color: getComputedStyle(t).color };
  };
  var res = {};
  try {
    ['c-live', 'c-past', 'c-live-on', 'c-past-on', 's-live', 's-past'].forEach(function (id) { res[id] = measure(document.getElementById(id), '.v2-app-inst-title', '.v2-app-inst-close'); });
    ['t-live', 't-past', 't-live-on', 't-past-on', 't-past-other'].forEach(function (id) { res[id] = measure(document.getElementById(id), '.t', '.v2-ss-x'); });
    res.sPastAskOp = +chain(document.querySelector('#s-past .v2-app-inst-askt')).toFixed(3);
    res.otherFaceOp = +chain(document.querySelector('#t-past-other .v2-ss-face')).toFixed(3);
    res.canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  } catch (e) { res.error = String(e && e.message || e); }
  document.getElementById('out').textContent = encodeURIComponent(JSON.stringify(res)) + 'END' + 'RESULT';
})();
</script>`;

let fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fail++;
};

for (const theme of ["light", "dark"]) {
  const dom = await dumpDom(chrome, { html: page(theme), copy: CSS, marker: "ENDRESULT", prefix: "past-dim-" });
  const m = dom.match(/<pre id="out">([^<]*?)ENDRESULT/);
  if (!m) { check(false, `${theme} W2 결과를 못 받았다(페이지 스크립트가 안 돌았다)`, dom.slice(0, 300)); continue; }
  const r = JSON.parse(decodeURIComponent(m[1]));
  // ── 배선 ──
  check(!r.error, `${theme} W2 측정 스크립트가 끝까지 돌았다`, r.error || "");
  check(IDS.every((id) => r[id] && Number.isFinite(r[id].L)), `${theme} W2 측정 대상 ${IDS.length}줄이 전부 잡혔다`, IDS.filter((id) => !(r[id] && Number.isFinite(r[id].L))).join(" "));
  check(String(r.canvas).toUpperCase() === CANVAS[theme], `${theme} W1 스타일시트가 실제로 물렸다(--canvas = ${CANVAS[theme]})`, `--canvas=${r.canvas}`);
  if (r.error || !IDS.every((id) => r[id])) continue;

  const dl = (a, b) => Math.abs(r[a].L - r[b].L);
  for (const [past, live, where, edge] of [["c-past", "c-live", "홈 카드(한 줄 · 곁 자식 없음)", "E1·E10"], ["s-past", "s-live", "[AI 세션](두 줄)", "E2"], ["t-past", "t-live", "프로젝트 트리", "E3"], ["t-past-other", "t-live", "프로젝트 트리 · 남의 지난 세션", "E9"]]) {
    check(dl(past, live) >= MIN_DL, `${theme} ${edge} ${where}: 지난 세션 이름이 눈에 띄게 옅다(ΔL* ≥ ${MIN_DL})`,
      `ΔL* ${dl(past, live).toFixed(1)} · 살아 있는 ${r[live].color} L*${r[live].L} vs 지난 ${r[past].color}×${r[past].op} L*${r[past].L}`);
    check(r[past].contrast >= MIN_CONTRAST, `${theme} E4 ${where}: 그래도 읽힌다(대비 ≥ ${MIN_CONTRAST}:1)`, `${r[past].contrast}:1`);
    if (r[past].ctrlParentOp !== null) check(r[past].ctrlParentOp === 1, `${theme} E6 ${where}: 조작 단추는 흐림을 물려받지 않는다`, `부모 사슬 opacity ${r[past].ctrlParentOp}`);
  }
  for (const [live, where] of [["c-live", "홈 카드"], ["s-live", "[AI 세션]"], ["t-live", "프로젝트 트리"]]) {
    check(r[live].op === 1, `${theme} E7 ${where}: 살아 있는 줄은 흐리지 않는다`, `opacity ${r[live].op}`);
  }
  for (const [past, live, where] of [["c-past-on", "c-live-on", "홈 카드(한 줄)"], ["t-past-on", "t-live-on", "프로젝트 트리"]]) {
    check(dl(past, live) <= MAX_ON_DL, `${theme} E5 ${where}: 고른 지난 줄은 제 농도로 돌아온다(ΔL* ≤ ${MAX_ON_DL})`, `ΔL* ${dl(past, live).toFixed(1)} · opacity ${r[past].op}`);
  }
  check(r.sPastAskOp < 1, `${theme} E8 [AI 세션](두 줄): 둘째 줄(내 마지막 말)도 함께 흐리다`, `opacity ${r.sPastAskOp}`);
  check(r.otherFaceOp < 1, `${theme} E9 프로젝트 트리: 남의 지난 세션은 얼굴도 함께 흐리다`, `opacity ${r.otherFaceOp}`);
}

if (fail) { console.error(`\n${fail}건 실패`); process.exit(1); }
console.log("\n지난 세션 흐림 — 전부 통과");
