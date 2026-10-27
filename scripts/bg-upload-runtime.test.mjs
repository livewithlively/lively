#!/usr/bin/env node
// 백그라운드 파일 올리기(web/v2/bg-upload.ts, #5060) — 런타임. 처음 설정에서 고른 파일이 화면을 옮겨 가도 계속 올라가는 대기열.
//
//  사양·엣지 표: <스크래치패드>/spec-bg-upload.md — 행마다 단언 하나 이상.
//   B1 동시에 셋까지(경계: 셋은 허용) · 전부 올라간다 · 다 비면 기다리던 것을 한 번 부른다
//   B2 도는 동안만 탭 닫기 경고(beforeunload) — 다 끝나면 뗀다
//   B3 같은 파일(경로·크기·수정 시각)을 다시 고르면 건너뛴다 · 크기가 다르면 새 파일
//   B4 실패는 따로 쥔다 · 띠에 [다시 시도] · 누르면 그것만 다시
//   B5 개인 폴더 uploads/<경로> 로 PUT · 토큰 · 워크스페이스(주소의 lvly_ws) / B5′ 워크스페이스 미선택이면 lvly_ws 없음
//   B6 띠 글 — 도는 중 «n / 전체» · 끝나면 «다 올렸어요»
//   B7 빈 목록 — 보내기 0 · 경고 안 건다 · 기다리던 것은 곧바로
//   B8 일시 오류(500·네트워크)는 스스로 다시 보낸다 — 누르지 않아도 올라간다 · 4xx 는 다시 보내지 않는다(B4)
//   B9 «다 올렸다» 판정(uploadVerdict) — 실패 0 · 더 보낼 것 없음 · 고른 수만큼 올라감(건너뜀 포함)일 때만 done.
//      대기열이 빈 것만으로는 done 이 아니다(실패만 남음 · 새로고침으로 대기열을 잃음 · 고른 것 0)
//   B10 건너뛰기 표지는 사람마다 — 같은 브라우저의 다른 계정이 올린 것을 «이미 올렸다» 로 건너뛰지 않는다
//  단언은 부작용으로 — 가짜 XHR 이 받은 요청(방법·주소·머리글·본문 이름)과 동시 수, beforeunload 를 건/뗀 횟수.
//  fail-first(2026-10-27 · 신규 모듈이라 mutation): 동시 상한 10 → B1 · 끝나도 경고 안 뗌 → B2 · 건너뛰기 표지 무시 → B3 ·
//   실패를 버림 → B4 · apiUrl 대신 날 경로 → B5 — 각각 그 행만 빨갛다(복원 뒤 전부 통과).
//  크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import assert from "node:assert/strict";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";
const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 백그라운드 올리기 런타임 검증 미실행"); process.exit(0); }
const bundle = buildSync({
  stdin: { contents: "export * from './web/v2/bg-upload.ts'; export { state } from './web/lib/state.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "BG", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

//  모듈보다 먼저 도는 준비 — 가짜 XHR · beforeunload 세기 · 토큰 · 워크스페이스.
function PAGE_PREP() {
  window.__R = { errors: [] };
  window.addEventListener("error", (e) => window.__R.errors.push(String(e.message || e)));
  localStorage.setItem("lively_ui_token", "tok-1");
  localStorage.setItem("lively.workspace", "acme");
  const guard = window.__guard = { add: 0, remove: 0 };
  const oAdd = window.addEventListener.bind(window), oRem = window.removeEventListener.bind(window);
  window.addEventListener = (t, f, o) => { if (t === "beforeunload") guard.add++; return oAdd(t, f, o); };
  window.removeEventListener = (t, f, o) => { if (t === "beforeunload") guard.remove++; return oRem(t, f, o); };
  //  fail — 이름 → 앞으로 돌려줄 상태들(차례로 하나씩 쓴다). 비면 200.
  const net = window.__net = { sent: [], live: 0, peak: 0, fail: { "bad.txt": [403], "flaky.txt": [500, 0] } };
  window.XMLHttpRequest = class {
    constructor() { this.h = {}; this.status = 0; }
    open(m, u) { this.m = m; this.u = u; }
    setRequestHeader(k, v) { this.h[k.toLowerCase()] = v; }
    send(body) {
      net.live++; net.peak = Math.max(net.peak, net.live);
      const name = body && body.name;
      net.sent.push({ m: this.m, u: this.u, h: this.h, name });
      setTimeout(() => {
        net.live--;
        const q = net.fail[name];
        const st = q && q.length ? q.shift() : 200;
        if (st === 0) { this.onerror && this.onerror(); return; }   // 네트워크 오류
        this.status = st;
        this.onload && this.onload();
      }, 40);
    }
  };
}

async function PAGE_MAIN() {
  const R = window.__R, net = window.__net, guard = window.__guard;
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const f = (name, size = 3, lm = 1000) => ({ file: new File(["x".repeat(size)], name, { lastModified: lm }), rel: "폴더/" + name });
  const barText = () => document.querySelector(".bgup-text")?.textContent || "";

  //  B7 — 빈 목록
  let idle0 = 0;
  const r0 = BG.bgUploadAdd([]);
  BG.bgUploadWhenIdle(() => { idle0++; });
  R.b7 = { added: r0.added, sent: net.sent.length, guardAdd: guard.add, idle: idle0 };

  //  B1·B2·B5·B6
  let idle = 0;
  const items = Array.from({ length: 10 }, (_, i) => f(`a${i}.md`));
  const r1 = BG.bgUploadAdd(items);
  BG.bgUploadWhenIdle(() => { idle++; });
  await sleep(10);
  R.b6run = barText();
  R.guardWhileRunning = { ...guard };
  await sleep(400);
  R.b1 = { added: r1.added, sent: net.sent.length, peak: net.peak, state: BG.bgUploadState(), idle };
  R.guardAfter = { ...guard };
  R.b5 = net.sent[0];
  R.b6done = barText();

  //  B3 — 같은 것 다시(셋) · 하나는 크기가 다르다
  const before = net.sent.length;
  const r3 = BG.bgUploadAdd(items.slice(0, 3).concat([f("a0.md", 9)]));
  await sleep(200);
  R.b3 = { added: r3.added, skipped: r3.skipped, newSends: net.sent.length - before };

  //  B4 — 실패 · 다시 시도
  BG.bgUploadAdd([f("bad.txt"), f("ok.txt")]);
  await sleep(200);
  const retry = () => Array.from(document.querySelectorAll(".bgup-btn")).find((b) => b.textContent === "다시 시도");
  R.b4a = { state: BG.bgUploadState(), retryBtn: !!retry() };
  const beforeRetry = net.sent.length;
  retry()?.click();
  await sleep(200);
  R.b4b = { state: BG.bgUploadState(), resent: net.sent.slice(beforeRetry).map((x) => x.name) };

  //  B8 — 일시 오류 둘(500 → 네트워크) 뒤 성공: 누르지 않아도 올라간다
  const b8Before = net.sent.length;
  BG.bgUploadAdd([f("flaky.txt")]);
  await sleep(6000);
  R.b8 = { state: BG.bgUploadState(), sends: net.sent.slice(b8Before).map((x) => x.name) };

  //  B9 — 판정표(순수)
  const S0 = { total: 0, done: 0, failed: 0, skipped: 0, running: false };
  R.b9 = [
    BG.uploadVerdict({ ...S0, total: 5, done: 5 }, 5),
    BG.uploadVerdict({ ...S0, total: 5, done: 4, failed: 1 }, 5),
    BG.uploadVerdict({ ...S0, total: 5, done: 2, running: true }, 5),
    BG.uploadVerdict(S0, 5),
    BG.uploadVerdict({ ...S0, skipped: 5 }, 5),
    BG.uploadVerdict({ ...S0, total: 3, done: 3, skipped: 2 }, 5),
    BG.uploadVerdict(S0, 0),
    BG.uploadVerdict({ ...S0, total: 6, done: 5, failed: 1 }, 5),
  ];

  //  B10 — 다른 사람으로 같은 파일
  BG.state.me = { userId: "other" };
  const b10Before = net.sent.length;
  const r10 = BG.bgUploadAdd([items[0]]);
  await sleep(150);
  R.b10 = { added: r10.added, skipped: r10.skipped, sends: net.sent.length - b10Before };
  BG.state.me = null;

  //  B5′ — 워크스페이스 미선택(primary): 머리글 없음
  localStorage.removeItem("lively.workspace");
  BG.bgUploadAdd([f("primary.md")]);
  await sleep(150);
  R.b5p = net.sent[net.sent.length - 1];

  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html><meta charset="utf-8"><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script>(${PAGE_PREP.toString()})();</script>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const dom = await dumpDom(chrome, { html: page, prefix: "bgup-", virtualTimeBudget: 30000 });
const res = readOut(dom);
assert.ok(res.text !== null, `결과를 못 받았다 — ${res.out}`);
const R = JSON.parse(res.text);
assert.ok(!R.fatal, R.fatal);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n")[0]}`); }
};
t("B1 동시에 셋까지 · 전부 올라간다 · 다 비면 한 번 부른다", () => {
  assert.equal(R.b1.added, 10);
  assert.equal(R.b1.sent, 10, `다 안 보냈다: ${R.b1.sent}`);
  assert.equal(R.b1.peak, 3, `★ 동시 수가 셋이 아니다(넘치면 큰 파일끼리 회선을 나누고, 하나면 작은 파일 수천 개가 왕복에 묶인다): ${R.b1.peak}`);
  assert.deepEqual({ ...R.b1.state }, { total: 10, done: 10, failed: 0, skipped: 0, running: false });
  assert.equal(R.b1.idle, 1, `다 비었을 때 부르기: ${R.b1.idle}`);
});
t("B2 도는 동안만 탭 닫기 경고 — 끝나면 뗀다", () => {
  assert.equal(R.guardWhileRunning.add, 1, "도는 동안 경고를 안 건다");
  assert.equal(R.guardAfter.remove, 1, "★ 다 끝났는데 탭 닫기를 계속 막는다");
});
t("B3 같은 파일은 건너뛴다 — 크기가 다르면 다른 파일", () => {
  assert.deepEqual(R.b3, { added: 1, skipped: 3, newSends: 1 });
});
t("B4 4xx 실패는 스스로 다시 보내지 않고 따로 쥔다 · [다시 시도]로 그것만 다시", () => {
  assert.equal(R.b4a.state.failed, 1);
  assert.equal(R.b4a.state.running, false, "4xx 를 스스로 다시 보내며 붙들고 있다");
  assert.equal(R.b4a.retryBtn, true, "[다시 시도]가 없다");
  assert.deepEqual(R.b4b.resent, ["bad.txt"], `다시 보낸 것: ${JSON.stringify(R.b4b.resent)}`);
  assert.equal(R.b4b.state.failed, 0);
});
t("B8 일시 오류는 스스로 다시 보낸다 — 누르지 않아도 올라간다", () => {
  assert.deepEqual(R.b8.sends, ["flaky.txt", "flaky.txt", "flaky.txt"], `★ 일시 오류에 곧바로 실패로 떨어진다: ${JSON.stringify(R.b8.sends)}`);
  assert.equal(R.b8.state.failed, 0);
  assert.equal(R.b8.state.running, false);
});
t("B9 «다 올렸다» 는 실패 0 · 고른 수만큼 올라갔을 때만", () => {
  assert.deepEqual(R.b9, ["done", "running", "running", "running", "done", "done", "running", "running"],
    "순서: 다 올림 · ★실패 남음 · 도는 중 · ★새로고침으로 대기열 잃음 · 전부 이미 올림 · 올림+건너뜀 · 고른 것 0 · ★수는 찼는데 실패가 남음(다시 고른 경우)");
});
t("B10 건너뛰기 표지는 사람마다", () => {
  assert.deepEqual(R.b10, { added: 1, skipped: 0, sends: 1 }, "★ 다른 계정이 올린 것을 «이미 올렸다» 로 건너뛴다");
});
t("B5 개인 폴더 uploads/<경로> · 토큰 · 워크스페이스(lvly_ws)", () => {
  assert.ok(R.b5, "배선 — 요청이 하나도 안 잡혔다");
  assert.equal(R.b5.m, "PUT");
  assert.match(R.b5.u, /\/api\/ui\/terminal\/browse\/file\?root=personal&path=uploads%2F%ED%8F%B4%EB%8D%94%2Fa0\.md(&|$)/, R.b5.u);
  assert.equal(R.b5.h.authorization, "Bearer tok-1");
  assert.match(R.b5.u, /[?&]lvly_ws=acme(&|$)/, "★ 셀프호스트 다중 워크스페이스에서 primary 로 올라간다");
});
t("B5′ 워크스페이스 미선택이면 워크스페이스를 싣지 않는다", () => {
  assert.equal(R.b5p?.name, "primary.md", "배선 — 그 요청이 안 잡혔다");
  assert.doesNotMatch(R.b5p.u, /lvly_ws=/, "primary 인데 워크스페이스를 싣는다");
});
t("B6 띠 글 — 도는 중 n / 전체 · 끝나면 다 올렸어요", () => {
  assert.match(R.b6run, /파일 올리는 중 · \d+ \/ 10/, R.b6run);
  assert.match(R.b6done, /파일 10개를 다 올렸어요/, R.b6done);
});
t("B7 빈 목록 — 보내기 0 · 경고 안 건다 · 기다리던 것은 곧바로", () => {
  assert.deepEqual(R.b7, { added: 0, sent: 0, guardAdd: 0, idle: 1 });
});
t("화면 오류 0", () => { assert.deepEqual(R.errors, []); });
console.log(`bg-upload-runtime.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
