// #5616 — 아이패드(iPadOS 17 사파리)에서 앱을 열면 1.4초 뒤 화면 전체가 안 눌리던 것.
//  뿌리: 홈 실행 줄(run-picker)의 fit() 이 «글꼴이 아직 loading 이면 fonts.ready 뒤에 다시 잰다» 를 자기 안에서 걸었다.
//  iPadOS 17 은 ready 가 이미 풀린 채 status 가 'loading' 으로 남는 때가 있어(17.5 시뮬레이터 실측) ready.then → fit →
//  다시 건다 … 가 마이크로태스크로 끝없이 돌았다. 마이크로태스크는 이벤트 루프에 차례를 안 넘기므로 터치·타이머가 영영 안 돈다.
//  이 시험은 그 상태(ready 풀림 + status 'loading' 고정)를 그대로 만들고, 재기 함수가 스스로를 다시 부르는 고리를 만들지
//  않는지 — 즉 다음 타이머(매크로태스크)가 제때 돈다는 것을 잰다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const { refitAfterFonts } = await import(join(root, "public/app/lib/font-refit.js"));

/** iPadOS 17 의 그 상태 — ready 는 이미 풀렸는데 status 는 계속 'loading'. loadingdone 은 fire() 로 울린다. */
function stuckFonts() {
  const subs = [];
  return {
    status: "loading",
    ready: Promise.resolve(),
    addEventListener(type, fn, opts) { subs.push({ type, fn, once: !!(opts && opts.once) }); },
    fire(type) { for (const s of subs.splice(0)) { if (s.type === type) { s.fn(); if (!s.once) subs.push(s); } else subs.push(s); } },
    subs,
  };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ── 1. 멈춘 상태(ready 풀림 + status 'loading' 고정)에서 고리를 만들지 않는다 ─────────────
{
  const fonts = stuckFonts();
  const state = { armed: false };
  let calls = 0;
  // 안전장치: 고리가 생기면 1000번째에서 끊는다(시험 자체가 영원히 멈추지 않게) — 그때 calls 가 1001 로 남아 아래가 빨갛다.
  const fit = () => { calls++; if (calls > 1000) throw new Error("runaway"); refitAfterFonts(fonts, state, fit); };
  fit();
  const t0 = Date.now();
  await tick(20);
  ok(Date.now() - t0 < 1000, "1a 다음 타이머가 제때 돈다(이벤트 루프가 안 막힘)");
  ok(calls === 1, `1b 받기가 끝나기 전엔 다시 재지 않는다(재기 ${calls}번)`);
  ok(fonts.subs.length === 1 && fonts.subs[0].type === "loadingdone" && fonts.subs[0].once, "1c 기다리는 길은 loadingdone 한 번(once)");
}

// ── 2. 받기가 끝나면 정확히 한 번 다시 잰다 ─────────────────────────────────────
{
  const fonts = stuckFonts();
  const state = { armed: false };
  let calls = 0;
  const fit = () => { calls++; refitAfterFonts(fonts, state, fit); };
  fit();
  fonts.status = "loaded";
  fonts.fire("loadingdone");
  await tick();
  ok(calls === 2, `2a loadingdone 뒤 정확히 한 번 다시 잰다(재기 ${calls}번)`);
  ok(state.armed === false && fonts.subs.length === 0, "2b 다시 잰 뒤 걸린 것이 남지 않는다");
}

// ── 3. loadingdone 뒤에도 status 가 'loading' 으로 남아도 고리가 없다 ───────────────────
{
  const fonts = stuckFonts();
  const state = { armed: false };
  let calls = 0;
  const fit = () => { calls++; if (calls > 1000) throw new Error("runaway"); refitAfterFonts(fonts, state, fit); };
  fit();
  fonts.fire("loadingdone");          // status 는 그대로 'loading'
  await tick(20);
  ok(calls === 2, `3a 한 번만 다시 잰다(재기 ${calls}번)`);
  ok(fonts.subs.length === 1, "3b 다음 loadingdone 을 하나만 기다린다");
}

// ── 4·5·6. 겹쳐 걸지 않음 · 다 받았으면 안 건다 · FontFaceSet 이 없거나 모자라도 안 터진다 ────
{
  const fonts = stuckFonts();
  const state = { armed: false };
  ok(refitAfterFonts(fonts, state, () => {}) === true, "4a 처음엔 건다");
  ok(refitAfterFonts(fonts, state, () => {}) === false && fonts.subs.length === 1, "4b 걸린 동안 또 부르면 겹쳐 걸지 않는다");
  let touched = false;
  ok(refitAfterFonts({ status: "loaded", addEventListener() { touched = true; } }, { armed: false }, () => {}) === false && !touched, "5 다 받은 상태면 걸지 않는다");
  ok(refitAfterFonts(null, { armed: false }, () => {}) === false, "6a FontFaceSet 이 없는 브라우저");
  ok(refitAfterFonts(undefined, { armed: false }, () => {}) === false, "6b document.fonts 가 undefined");
  const s = { armed: false };
  ok(refitAfterFonts({ status: "loading" }, s, () => {}) === false && s.armed === false, "6c addEventListener 가 없으면 걸지도, armed 로 잠그지도 않는다");
}

// ── 7. 배선: 화면 코드가 이 길을 쓴다(fonts.ready.then 으로 되돌아가지 않는다) ─────────────
{
  const src = read("web/v2/run-picker.ts");
  ok(/refitAfterFonts\(/.test(src), "7a run-picker 의 fit() 이 refitAfterFonts 를 부른다");
  ok(!/fonts\.ready\.then/.test(src), "7b run-picker 에 fonts.ready.then 이 다시 생기지 않았다");
}

console.log(`\nfont-refit: ${pass} passed`);
