#!/usr/bin/env node
// 사람 한 명 고르기 칸 — **런타임** 회귀 테스트 (#4052)
//
// 사양(상민님 2026-09-17 «검색 + 드롭다운, id 말고 이름으로»):
//  R1 처음부터 고른 사람의 **이름**이 보인다(값은 id).
//  R2 칸에 들어가면 명부가 펼쳐지고, 치면 좁혀진다.
//  R3 ★ 목록의 사람을 누르면 값이 바뀌고 칸에 **그 이름**이 보인다 — 치던 검색어가 남지 않는다.
//  R4 ★ Enter 로 골라도 같다.
//  R5 Esc 는 찾던 글을 버리고 고른 이름으로 되돌린다(값은 그대로).
//  R6 ↑ 도 닫힌 목록을 연다.
//  R7 × 로 비우면 값이 비고, 칸을 떠나면 «비워 두면 …» 글이 보인다.
//  R8 명부에 없는 값은 지우지 않고 그대로 보이며, 없다고 말한다.
//  R9 값이 바뀔 때만 폼으로 change 가 올라간다 — 검색어 타이핑(input)은 폼으로 새지 않는다.
//  R10 명부가 크면 줄 수를 자르고 «더 있다» 를 말한다 — 지금 값이 잘린 쪽이면 끝에 붙여 ✓ 가 보인다.
//  R11 화면에 글자 «null» 이 새지 않는다(DOM replaceChildren 함정 — lib/dom 머리말).
//
// 왜 소스 정규식(runner-pick-wiring)으로 부족한가: 격리 리뷰(#4052)가 잡은 결함 — 고른 뒤에도 칸에 검색어가 남던 것 —
//  은 소스 모양으로는 안 보인다. 고르는 순간 칸이 포커스를 쥐고 있다는 **이벤트 순서**의 문제라, 실제 DOM 이벤트로 쏴야 잡힌다.
//  그래서 칸 모듈을 esbuild 로 한 파일에 묶어 헤드리스 크롬에 올리고, 명부 API 는 fetch 대역으로 준다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 사람 고르기 칸 런타임 검증 미실행");
  process.exit(0);
}

// 칸 모듈을 브라우저용 한 파일로 — 실제 소스 그대로(대역은 fetch 하나뿐).
//  두 벌을 따로 싣는다(PSEL · PSEL2): 명부 캐시가 모듈 전역이라, 큰 명부(R10)는 캐시가 빈 새 인스턴스로 재야 한다.
const build = (globalName) => buildSync({
  entryPoints: [path.join(ROOT, "web/lib/person-select.ts")],
  bundle: true, format: "iife", globalName, platform: "browser", target: "es2020",
  write: false, logLevel: "silent",
}).outputFiles[0].text;
const work = mkdtempSync(path.join(tmpdir(), "psel-bundle-"));
const bundlePath = path.join(work, "psel.js");
const bundlePath2 = path.join(work, "psel2.js");
writeFileSync(bundlePath, build("PSEL"));
writeFileSync(bundlePath2, build("PSEL2"));

// 명부 — ASCII 이름(글꼴 없는 면에서 한글 조판이 크롬을 죽인 적이 있다 — side-past-dim-runtime 머리말).
const SMALL = [
  { id: "alice", display_name: "Alice Kim" },
  { id: "bob", display_name: "Bob Lee" },
  { id: "carol", display_name: "Carol Park" },
];
const BIG = Array.from({ length: 70 }, (_, i) => ({ id: `m${i}`, display_name: `Member ${i}` }));

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><body>
<form id="f1"></form><form id="f2"></form><pre id="out"></pre>
<script>
window.__fetches = [];
window.__dir = ${JSON.stringify(SMALL)};
window.fetch = async (url) => {
  window.__fetches.push(String(url));
  if (String(url).includes('/api/ui/dash/members')) {
    return new Response(JSON.stringify({ members: window.__dir }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};
</script>
<script src="psel.js"></script>
<script src="psel2.js"></script>
<script>
//  결과 표지는 실행 중에 조립한다 — 스크립트 본문에 표지 글자가 그대로 있으면 덤프에서 그 본문이 먼저 걸릴 수 있다.
const MK = ['PSEL' + 'RESULT:', ':PSEL' + 'END'];
(async () => {
  const R = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const menu = () => document.querySelector('.psel-menu');
  const names = () => menu() ? [...menu().querySelectorAll('.psel-opt .proj-mp-name')].map((n) => n.textContent) : null;

  const f1 = document.getElementById('f1');
  const events = { change: 0, input: 0 };
  f1.addEventListener('change', () => events.change++);
  f1.addEventListener('input', () => events.input++);
  const picked = [];
  const ps = PSEL.personSelect({ value: 'bob', emptyText: 'EMPTY-TEXT', placeholder: 'SEARCH', onChange: (id) => picked.push(id) });
  f1.append(ps.el);
  await wait(30);
  const input = ps.el.querySelector('.psel-in');
  R.r1 = { text: input.value, value: ps.value(), face: !ps.el.querySelector('.psel-face').hidden };

  input.focus();
  if (document.activeElement !== input) input.dispatchEvent(new FocusEvent('focus'));
  R.realFocus = document.activeElement === input;
  await wait(10);
  R.r2open = names();
  //  R11 은 목록이 **열려 있는 동안** 잰다 — «더 있다» 줄이 없는(작은 명부) 목록이 null 이 새는 자리다.
  //  목록의 자식은 요소뿐이어야 한다 — 글자 노드가 끼면 그게 «null» 이다(글자로 찾으면 «Parknull» 처럼 붙어 \b 에 안 걸린다).
  const strayText = () => (menu() ? [...menu().childNodes].some((n) => n.nodeType === 3) : false);
  const nullWhileOpen = [];
  nullWhileOpen.push(strayText());
  type(input, 'car');
  await wait(10);
  R.r2filtered = names();
  nullWhileOpen.push(strayText());

  const row = [...menu().querySelectorAll('.psel-opt')].find((r) => r.textContent.includes('Carol'));
  const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  row.dispatchEvent(md);
  await wait(10);
  R.r3 = { text: input.value, value: ps.value(), menuOpen: !!menu(), prevented: md.defaultPrevented, focusKept: document.activeElement === input,
    sel: [input.selectionStart, input.selectionEnd] };

  type(input, 'ali');
  await wait(10);
  key(input, 'Enter');
  await wait(10);
  R.r4 = { text: input.value, value: ps.value(), menuOpen: !!menu() };

  type(input, 'zz');
  await wait(10);
  key(input, 'Escape');
  await wait(10);
  R.r5 = { text: input.value, value: ps.value(), menuOpen: !!menu() };

  key(input, 'ArrowUp');
  await wait(10);
  R.r6 = { menuOpen: !!menu() };

  const clear = ps.el.querySelector('.psel-clear');
  const cmd = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  clear.dispatchEvent(cmd);
  clear.click();
  await wait(10);
  R.r7clear = { text: input.value, value: ps.value(), clearHidden: clear.hidden, prevented: cmd.defaultPrevented };
  input.blur();
  input.dispatchEvent(new FocusEvent('blur'));
  await wait(30);
  R.r7blur = { text: input.value, placeholder: input.placeholder, menuOpen: !!menu() };

  ps.set('ghost');
  await wait(10);
  const note = ps.el.querySelector('.psel-note');
  R.r8 = { text: input.value, value: ps.value(), noteShown: !note.hidden, noteNamesValue: note.textContent.includes('ghost') };

  R.r9 = { picked, events };

  // R10 — 큰 명부. 첫 번들은 작은 명부를 캐시에 들고 있으니 캐시가 빈 둘째 번들(PSEL2)로 잰다.
  const uiNull1 = [...document.querySelectorAll('.psel')].some((n) => /\bnull\b/.test(n.textContent));
  window.__dir = ${JSON.stringify(BIG)};
  const f2 = document.getElementById('f2');
  const big = PSEL2.personSelect({ value: 'm65' });
  f2.append(big.el);
  await wait(30);
  const bin = big.el.querySelector('.psel-in');
  bin.focus();
  if (document.activeElement !== bin) bin.dispatchEvent(new FocusEvent('focus'));
  await wait(10);
  const rows = menu() ? [...menu().querySelectorAll('.psel-opt')] : [];
  R.r10 = {
    rows: rows.length,
    last: rows.length ? rows[rows.length - 1].getAttribute('title') : null,
    lastChecked: rows.length ? rows[rows.length - 1].getAttribute('aria-selected') : null,
    more: !!(menu() && menu().querySelector('.psel-more')),
    moreText: menu() && menu().querySelector('.psel-more') ? menu().querySelector('.psel-more').textContent.replace(/[^0-9]/g, '') : null,
    text: bin.value,
  };

  //  칸·목록의 글만 본다 — 페이지 스크립트 본문(body 안)에도 null 이라는 낱말이 있다.
  const uiNull2 = [...document.querySelectorAll('.psel, .psel-menu')].some((n) => /\bnull\b/.test(n.textContent)) || strayText();
  R.r11 = { nullText: uiNull1 || uiNull2 || nullWhileOpen.includes(true), measuredOpen: nullWhileOpen.length };
  R.fetches = window.__fetches.length;
  document.getElementById('out').textContent = MK[0] + JSON.stringify(R) + MK[1];
})().catch((e) => { document.getElementById('out').textContent = MK[0] + JSON.stringify({ error: String((e && e.stack) || e) }) + MK[1]; });
</script>`;

let R;
try {
  const dom = await dumpDom(chrome, { html, copy: [bundlePath, bundlePath2], prefix: "psel-", marker: ":PSELEND" });
  const m = /PSELRESULT:(.*?):PSELEND/s.exec(dom);
  assert.ok(m, "결과 표지가 안 나왔다 — 페이지 스크립트가 끝나지 않았다\n" + dom.slice(0, 600));
  R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
assert.ok(!R.error, "페이지 오류: " + R.error);

// 배선 — 명부 대역이 실제로 불렸다(안 불리면 칸은 «글자 받기» 로 떨어져 아래 단언 일부가 공짜로 통과한다).
assert.ok(R.fetches >= 2, `명부 API 를 두 번(작은·큰 명부) 불렀다 — ${R.fetches}`);

// R1
assert.deepEqual(R.r1, { text: "Bob Lee", value: "bob", face: true }, "R1 처음부터 이름");
// R2
assert.deepEqual(R.r2open, ["Alice Kim", "Bob Lee", "Carol Park"], "R2 들어가면 명부가 펼쳐진다");
assert.deepEqual(R.r2filtered, ["Carol Park"], "R2 치면 좁혀진다");
// ★ R3
assert.equal(R.r3.value, "carol", "R3 누르면 값이 바뀐다");
assert.equal(R.r3.text, "Carol Park", "★ R3 칸에는 고른 이름 — 치던 검색어(car)가 남지 않는다");
assert.equal(R.r3.menuOpen, false, "R3 목록이 닫힌다");
assert.equal(R.r3.prevented, true, "R3 mousedown 기본 동작을 막는다(칸이 blur 로 목록을 먼저 닫지 않게)");
//  이 판(헤드리스 --dump-dom)에서 실제 포커스가 서는지 먼저 본다 — 안 서면 아래 두 단언은 잴 수 없다(대신 합성 focus 로 돈다).
console.log(`note  실제 포커스: ${R.realFocus ? "섬" : "안 섬(합성 focus 이벤트로 진행)"}`);
if (R.realFocus) {
  assert.equal(R.r3.focusKept, true, "R3 고른 뒤에도 칸에 포커스가 남는다");
  assert.deepEqual(R.r3.sel, [0, "Carol Park".length], "R3 고른 이름이 통째로 선택돼 있다 — 이어서 치면 새 검색(«은서윤상» 방지)");
}
// ★ R4
assert.deepEqual(R.r4, { text: "Alice Kim", value: "alice", menuOpen: false }, "★ R4 Enter 로 골라도 이름이 보인다");
// R5
assert.deepEqual(R.r5, { text: "Alice Kim", value: "alice", menuOpen: false }, "R5 Esc 는 찾던 글을 버린다");
// R6
assert.deepEqual(R.r6, { menuOpen: true }, "R6 ↑ 도 목록을 연다");
// R7
assert.deepEqual(R.r7clear, { text: "", value: "", clearHidden: true, prevented: true }, "R7 × 로 비운다");
assert.deepEqual(R.r7blur, { text: "", placeholder: "EMPTY-TEXT", menuOpen: false }, "R7 떠나면 «비워 두면 …» 글");
// R8
assert.deepEqual(R.r8, { text: "ghost", value: "ghost", noteShown: true, noteNamesValue: true }, "R8 명부에 없는 값은 그대로 · 없다고 말한다");
// R9
assert.deepEqual(R.r9.picked, ["carol", "alice", ""], "R9 값이 바뀐 만큼만 onChange");
assert.equal(R.r9.events.change, 3, "R9 폼으로 오르는 change 는 값 변경 수만큼");
assert.equal(R.r9.events.input, 0, "R9 검색어 타이핑(input)은 폼으로 새지 않는다");
// R10
assert.equal(R.r10.text, "Member 65", "R10 큰 명부에서도 이름");
assert.equal(R.r10.rows, 61, "R10 60줄 + 잘린 쪽의 지금 값 1줄");
assert.equal(R.r10.last, "m65", "R10 지금 값이 끝에 붙는다");
assert.equal(R.r10.lastChecked, "true", "R10 그 줄에 ✓");
assert.equal(R.r10.more, true, "R10 «더 있다» 줄");
assert.equal(R.r10.moreText, "9", "R10 남은 수 = 70 - 61");
// R11
assert.equal(R.r11.measuredOpen, 2, "R11 배선 — 작은 명부 목록이 열린 채로 두 번 쟀다");
assert.equal(R.r11.nullText, false, "R11 글자 null 이 새지 않는다");

console.log("✓ person-select-runtime — R1~R11 (고른 뒤 이름 · Enter · Esc · ↑ · 비우기 · 모르는 값 · 이벤트 · 줄 상한 · null)");
