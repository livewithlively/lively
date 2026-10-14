#!/usr/bin/env node
// 헤드리스 크롬 시험 틀(scripts/headless-chrome.mjs dumpDom) — «숨 고르기»(BREATHE_URL)가 가상 시간을 진짜 비동기에 맞춘다
//
//  CI 실측(2026-10-07~14): side-files-finder-runtime 이 main · 머지 큐 · PR 에서 일주일에 20번 빨갰다 — 미리보기 3/4(R23) ·
//   복제 1/2(R28) · 결과 없음(PENDING). 셋 다 같은 까닭이다: `--virtual-time-budget` 의 가상 시계는 blob 읽기 ·
//   createImageBitmap · canvas.toBlob 같은 **진짜 비동기**를 기다려 주지 않는다. 그동안 sleep(20) 으로 폴링하면 가상
//   시계만 흘러 4초(가상) 대기가 실시간 몇 ms 만에 끝나고, 타이머 없이 기다리면 가상 시계가 예산 끝으로 뛰어 DOM 을 뜬다.
//   크롬은 네트워크 요청이 걸려 있는 동안 가상 시간을 멈추므로, 대기마다 짧은 진짜 요청(숨 고르기)을 끼우면 가상 대기가
//   실시간 진척과 함께 간다.
//
// 사양(행마다 단언 하나 이상):
//  B1 html 에 BREATHE_URL 이 있으면 dumpDom 이 그 자리에 살아 있는 주소를 싣는다(페이지가 불러 «ok» 를 받는다)
//  B2 숨 고르기를 끼운 폴링은 진짜 비동기(8MB blob 읽기 20번)를 4초(가상) 안에 잡는다
//  B3 페이지에 BREATHE_URL 이 없으면 html 을 그대로 싣는다(종전 시험은 바뀌지 않는다)
//
// fail-first(2026-10-14 실측, 맥 크롬): B2 의 폴링에서 숨 고르기를 빼면 done=false · 가상 4000ms · 200바퀴로 놓친다.
//  (기계가 빠르면 빼도 잡을 수 있어 «빼면 놓친다» 는 단언으로 걸지 않는다 — 걸면 그 단언이 흔들린다.)
import { BREATHE_URL, dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 숨 고르기 검증 미실행"); process.exit(0); }

let pass = 0, fail = 0;
const check = (c, n, info = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${info}`); } };

const PAGE = `<!doctype html><meta charset="utf-8"><pre id="out">PENDING</pre><script>
(async () => {
  const R = {};
  const realFetch = window.fetch.bind(window);
  const breathe = () => realFetch("${BREATHE_URL}").then((r) => r.text()).catch((e) => "ERR " + e);
  const tick = (ms) => new Promise((z) => setTimeout(z, ms));
  R.b1 = await breathe();
  let done = false;
  const big = new Blob([new Uint8Array(8e6)]);
  (async () => { for (let i = 0; i < 20; i++) await big.arrayBuffer(); done = true; })();
  const t0 = performance.now(); let it = 0;
  while (!done && performance.now() - t0 < 4000) { await breathe(); await tick(20); it++; }
  R.b2 = { done, virt: Math.round(performance.now() - t0), it };
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
})().catch((e) => { document.getElementById("out").textContent = JSON.stringify({ fatal: String(e) }) + "ENDRESULT"; });
</script>`;

const res = readOut(await dumpDom(chrome, { html: PAGE, prefix: "hc-breathe-", virtualTimeBudget: 60000 }));
check(res.text !== null, "배선: 페이지가 결과를 냈다", `out=${JSON.stringify(res.out)}`);
const R = res.text ? JSON.parse(res.text) : {};
check(R.b1 === "ok", "B1 BREATHE_URL 자리에 살아 있는 주소가 실렸다", JSON.stringify(R.b1));
check(R.b2 && R.b2.done === true, "B2 숨 고르기를 끼운 폴링은 진짜 비동기를 4초(가상) 안에 잡는다", JSON.stringify(R.b2));

//  B3 — 자리 글자가 없는 페이지는 그대로 싣는다: 페이지가 제 html 에 남긴 표지를 그대로 읽어 온다.
const PLAIN = `<!doctype html><pre id="out">PENDING</pre><script>document.getElementById("out").textContent = "plain-__LV_X__ENDRESULT";</script>`;
const plain = readOut(await dumpDom(chrome, { html: PLAIN, prefix: "hc-breathe-plain-", virtualTimeBudget: 2000 }));
check(plain.text === "plain-__LV_X__", "B3 자리 글자가 없으면 html 을 그대로 싣는다", JSON.stringify(plain));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
