// 처음 설정 «AI 잇기» — 로그인 뒤 «사람 없이 도는 작업» 허용을 **로그인의 연속**으로 (#4012 T12 · #4051 후속).
//  사양·엣지 표(O1~O17)는 스크래치패드 spec-onboarding-headless.md — 아래 이름의 번호가 그 행이다.
//
//  무엇이 문제였나(상민님 실측 2026-09-17, 새 워크스페이스):
//   처음 설정에서 Claude 로그인을 마쳤는데 [내 AI 계정]은 «사람 없이 도는 작업 — Claude 연결 안 됨» 이었다.
//   허용 칸은 있었지만 «연결됐어요.» 제목 아래의 **곁다리** 버튼 [연결하기]였고, 사람은 주 버튼 [계속]을 눌렀다.
//   이제 허용이 남았으면 장면의 제목·주 버튼이 그 사실을 말하고, 절차는 **누르지 않아도** 뜬다.
//
//  두 절로 잠근다.
//   · 배선(W) — 장면(onboarding.ts)이 칸의 상태를 한 벌로 읽고, 로그인이 끝나면 확인으로 넘어가는가.
//   · 런타임(R) — 칸(onboarding-headless.ts)을 **실제 공용 프로토콜**(lib/ai-login-inline)과 함께 esbuild 로 묶어
//     헤드리스 크롬에서 돌린다. 갈아 끼우는 것은 서버와 주고받는 `api` 하나뿐이다(호출을 기록한다).
//     크롬이 없는 면에서는 런타임 절만 건너뛴다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
//  주석은 계약이 아니다 — «종전엔 이랬다» 를 설명한 줄에 걸리면 검열이지 검사가 아니다.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };
const show = (v) => JSON.stringify(v);

const ONB = read("web/v2/onboarding.ts");
const OFFER = read("web/v2/onboarding-headless.ts");
ok(ONB.length > 10000 && OFFER.length > 2000, "W0 [배선] 두 소스를 실제로 읽었다");

// ── W — 장면의 배선 ─────────────────────────────────────────────────────────
{
  const c = code(ONB);
  //  O9 — 헤드리스 상태를 로그인 판정과 **같이** 묻는다. 따로 물으면 장면이 «연결됐어요» 로 먼저 그려졌다가 바뀐다.
  const fn = c.slice(c.indexOf("async function checkAi()"), c.indexOf("const aiOnKeys"));
  ok(fn.length > 100, "W1′ [배선] checkAi 를 찾았다");
  const iLoad = fn.indexOf("const hl = HL.load(h);");
  const iCheck = fn.indexOf("/api/ui/me/ai-accounts/check");
  const iAwait = fn.indexOf("await hl;");
  ok(iLoad > 0 && iCheck > iLoad && iAwait > iCheck, "W1 O9 checkAi 가 헤드리스 상태를 로그인 판정과 나란히 묻고, 둘 다 끝나야 돌아온다",
    show({ iLoad, iCheck, iAwait }));
  ok(/if \(AIC && AIC\.harness && AIC\.harness !== h\) await HL\.load\(AIC\.harness\);/.test(fn),
    "W1″ O10 서버가 다른 하네스로 답하면 그 하네스로 다시 묻는다");

  //  O1·O2 — 연결됨 갈래의 제목·주 버튼·카드는 칸과 **같은 값**(HL.pending)으로 정한다.
  const i = c.indexOf("if (aiOn(c.harness)) {");
  const j = c.indexOf("if (c.installed === false) {", i);
  const branch = c.slice(i, j);
  ok(i > 0 && j > i, "W2′ [배선] 연결됨 갈래를 찾았다");
  ok(/const hlWait = HL\.pending\(c\.harness\);/.test(branch), "W2 O1 허용이 남았나는 칸의 상태 한 벌에서 읽는다");
  ok(/hlWait \? '한 번만 더 허용해 주세요\.' : '연결됐어요\.'/.test(branch), "W3 O1·O2 허용이 남았으면 «연결됐어요» 라고 하지 않는다");
  ok(/\$\{hlWait \? '' : cards\}/.test(branch), "W4 O1 다른 AI 카드는 허용이 끝난 뒤에 보인다");
  ok(/hlWait\s*\?\s*`<button class="ob-q-skip" id="cGo">지금은 건너뛸게요<\/button>`\s*:\s*`<button class="ob-btn ob-btn-pri" id="cGo">이만하면 됐어요, 계속<\/button>`/.test(branch),
    "W5 O1 남았으면 주 버튼 대신 조용한 건너뛰기 문(가두지 않는다) · 끝났으면 주 버튼 [계속]");
  ok(/id="hlBox" data-wait="\$\{hlWait \? '1' : '0'\}"/.test(branch), "W6 O12 칸은 장면이 그린 판단(data-wait)을 들고 있다 — 사실이 바뀌면 칸이 장면을 다시 그린다");
  ok(/HEADLESS_INLINE\[c\.harness\] \?/.test(branch) && (ONB.match(/id="hlBox"/g) || []).length === 1,
    "W7 O8 칸은 화면에서 받을 수 있는 하네스의 연결됨 갈래에만 있다(로그인 전 갈래에는 없다)");

  //  떠나는 중에는 칸이 장면을 다시 그리지 않는다(합류자는 떠나기 전에 최대 2.5초 기다린다).
  ok(/const HL = createHeadlessOffer\(\{ rerender: \(\) => \{ if \(!leavingAi && S\.scene === 'claude'\) renderScene\('claude', false\); \}, toast \}\);/.test(c),
    "W16 칸의 다시 그리기는 아직 이 장면에 있고 떠나는 중이 아닐 때만");
  const la = c.slice(c.indexOf("async function leaveAi()"), c.indexOf("const QPROG_ALL"));
  ok(/leavingAi = true;\s*try \{[\s\S]*goNext\('claude'\);\s*\} finally \{ leavingAi = false; \}/.test(la),
    "W17 떠나는 표시는 기다림 앞에서 켜지고, 무슨 일이 있어도 꺼진다");

  //  bind — 칸을 채운다(허용이 남았으면 칸이 스스로 시작한다).
  ok(/const hb = \$\('#hlBox', el\); if \(hb\) void HL\.paint\(hb, AIC\.harness,/.test(c), "W8 연결됨 장면은 칸을 그린다");
  ok(/toast\(HL\.pending\(key\) \? '로그인됐어요\. 한 번만 더 허용해 주세요\.' : '연결됐어요\.'\)/.test(c), "W9 O1 확인 알림도 남은 허용을 숨기지 않는다");

  //  O7 — 대화형 로그인이 끝나면 사람을 기다리지 않고 확인(cGo)으로 넘어간다.
  const lf = c.slice(c.indexOf("inlineHandle = startInlineAiLogin(h, {"), c.indexOf("failed: (m) => note("));
  ok(lf.length > 100, "W10′ [배선] 대화형 로그인의 done 을 찾았다");
  ok(/setTimeout\(\(\) => \{ const go2 = \$\('#cGo', el\); if \(go2 && go2\.isConnected && !go2\.disabled\) go2\.click\(\); \}, LOGIN_DONE_ADVANCE_MS\);/.test(lf),
    "W10 O7 로그인이 끝나면 누른 것과 같은 길(cGo)로 저절로 넘어간다 — 사람이 먼저 눌렀거나(disabled) 장면이 바뀌었으면 안 건드린다");
  ok(/g2\.onclick = \(\) => go2\.click\(\)/.test(lf), "W11 O7 [계속] 수동 문은 그대로다");
  const ms = Number((c.match(/const LOGIN_DONE_ADVANCE_MS = (\d+);/) || [])[1]);
  ok(ms >= 300 && ms <= 3000, "W12 O7 ✓ 를 볼 만큼만 기다린다(0.3~3초)", String(ms));

  //  한 벌 — 장면은 헤드리스 발급을 스스로 띄우지 않는다(칸 모듈 하나가 한다).
  ok(!/purpose: 'headless'/.test(c) && !/paintHeadlessOffer/.test(c), "W13 장면 안에 헤드리스 발급 사본이 없다");
  ok(/from '\.\/onboarding-headless\.js'/.test(ONB), "W14 장면은 칸 모듈을 가져온다");
  const oc = code(OFFER);
  ok(/from '\.\.\/lib\/ai-login-inline\.js'/.test(OFFER) && !/headless-login\//.test(oc),
    "W15 칸도 공용 프로토콜만 부른다(발급 경로를 스스로 두드리지 않는다)");
}

// ── R — 런타임(헤드리스 크롬) ────────────────────────────────────────────────
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 런타임 절(R)을 건너뜁니다(CHROME_BIN 으로 지정)");
  console.log(`\n${pass} passed`);
  process.exit(0);
}

//  서버와 주고받는 한 곳(api — 칸은 core.js, 공용 프로토콜은 net.js 로 부른다)만 갈아 끼운다.
//   칸·공용 프로토콜·session-open 은 진짜다.
const bundled = await build({
  stdin: {
    contents: "import { createHeadlessOffer, headlessSeenOf, HEADLESS_FRESH_MS, HEADLESS_RETRY_GAP_MS } from './onboarding-headless.ts'; window.__H = { createHeadlessOffer, headlessSeenOf, HEADLESS_FRESH_MS, HEADLESS_RETRY_GAP_MS };",
    resolveDir: path.join(root, "web/v2"), loader: "ts",
  },
  bundle: true, format: "iife", write: false, logLevel: "silent",
  plugins: [{
    name: "net-stub",
    setup(b) {
      b.onResolve({ filter: /(^|\/)net\.js$|^\.\.\/core\.js$/ }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export function api(p, o) { return window.__API(p, o); } export function appUrl(p) { return p; } export function apiUrl(p) { return p; }",
        loader: "js",
      }));
    },
  }],
});
const BUNDLE = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
ok(!/window\.__API\(p, o\)/.test(read("web/lib/net.ts")) && BUNDLE.includes("window.__API"), "R0″ [배선] 번들의 api 는 기록하는 가짜다(진짜 net 이 섞이지 않았다)");

const SCENARIOS = String.raw`
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var CALLS = [], ROUTES = {};
window.__API = function (p, o) {
  var body = o && o.body ? JSON.parse(o.body) : null;
  CALLS.push({ p: p, body: body });
  var key = p.indexOf('/api/ui/me/headless-login/') === 0 ? p.slice('/api/ui/me/headless-login/'.length).split('?')[0]
    : (p === '/api/ui/me/headless' ? 'status' : p);
  var h = ROUTES[key];
  if (!h) return Promise.reject(new Error('404 ' + p));
  try { return Promise.resolve(h(body, p)); } catch (e) { return Promise.reject(e); }
};
function reset(routes) { CALLS = []; ROUTES = routes; }
function calls(k) { return CALLS.filter(function (c) { return c.p.indexOf(k) >= 0; }); }
function statusN() { return CALLS.filter(function (c) { return c.p === '/api/ui/me/headless'; }).length; }
var ST = function (claude, codex) { return function () { return { harnesses: [
  Object.assign({ key: 'claude' }, claude || { connected: false, failure: null }),
  Object.assign({ key: 'codex' }, codex || { connected: false, failure: null }),
] }; }; };
function mk(o) {
  var box = document.createElement('div');
  box.id = 'hlBox';
  box.dataset.wait = o && o.wait ? '1' : '0';
  box.hidden = true;
  document.body.appendChild(box);
  return box;
}
function offer(clock) {
  var log = { rerender: 0, toast: [] };
  var off = __H.createHeadlessOffer({
    rerender: function () { log.rerender++; },
    toast: function (m) { log.toast.push(m); },
    now: clock ? function () { return clock.t; } : undefined,
  });
  return { off: off, log: log };
}
var q = function (box, s) { return box.querySelector(s); };
var vis = function (el) { return !!el && !el.hidden; };
var R = {};

(async function () {
  // R1 O1 — 허용이 남았다: 누르지 않아도 시작(이어받기), 칸이 보이고 주소가 온다.
  reset({ status: ST(), start: function () { return { ok: true }; },
    state: function () { return { step: 'waiting_code', url: 'https://claude.ai/oauth/authorize?r1=1', needsPaste: true }; } });
  var a = offer(); await a.off.load('claude');
  var box = mk({ wait: true });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(80);
  R.R1 = { pending: a.off.pending('claude'), hidden: box.hidden, starts: calls('/headless-login/start').map(function (c) { return c.body; }),
    addr: (q(box, '#hlAddr') || {}).textContent, open: vis(q(box, '#hlOpen')), paste: vis(q(box, '#hlPasteRow')),
    rerender: a.log.rerender, status: calls('/api/ui/me/headless').filter(function (c) { return c.p === '/api/ui/me/headless'; }).length };
  box.remove(); await sleep(10);

  // R2 O2 — 이미 연결됨: 연결됨 한 줄, 시작 0건.
  reset({ status: ST({ connected: true, failure: null }), start: function () { return { ok: true }; } });
  a = offer(); await a.off.load('claude');
  box = mk({ wait: false });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(50);
  R.R2 = { pending: a.off.pending('claude'), hidden: box.hidden, text: box.textContent, starts: calls('/headless-login/start').length, rerender: a.log.rerender };
  box.remove();

  // R3 O3 — 구 서버(상태 경로 없음): 모름 → 칸 숨김, 시작 0건.
  reset({ start: function () { return { ok: true }; } });
  a = offer(); await a.off.load('claude');
  box = mk({ wait: false });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(50);
  R.R3 = { pending: a.off.pending('claude'), seen: a.off.seen(), hidden: box.hidden, starts: calls('/headless-login/start').length, rerender: a.log.rerender };
  box.remove();
  //  R3b — 모양이 다른 응답(행 없음)도 모름이다.
  reset({ status: function () { return { rows: [] }; } });
  a = offer(); await a.off.load('claude');
  R.R3b = { pending: a.off.pending('claude'), seen: a.off.seen() };
  //  R3c — 장면은 «남았다» 로 그렸는데 지금 조회가 실패했다(모름): 장면을 한 번 다시 그리고, 다시 그린 칸은 숨긴다.
  //   다시 그린 칸은 되묻지 않는다(«모름» 도 물은 것으로 센다 — 안 세면 장면이 오락가락할 때마다 되묻는다).
  var clock = { t: 1000 };
  reset({ start: function () { return { ok: true }; } });
  a = offer(clock);
  box = mk({ wait: true }); box.hidden = false;
  await a.off.paint(box, 'claude', 'Claude'); await sleep(30);
  var r3c = { rerender: a.log.rerender, starts: calls('/headless-login/start').length, status: statusN() };
  box.remove();
  box = mk({ wait: false }); box.hidden = false;
  await a.off.paint(box, 'claude', 'Claude'); await sleep(30);
  R.R3c = { first: r3c, rerender: a.log.rerender, hidden: box.hidden, starts: calls('/headless-login/start').length, status: statusN() };
  box.remove();

  // R4 O4 — 저장돼 있지만 인증 실패: 다시 허용(남은 일).
  reset({ status: ST({ connected: true, failure: { reason: 'auth_failure' } }), start: function () { return { ok: true }; },
    state: function () { return { step: 'starting' }; } });
  a = offer(); await a.off.load('claude');
  box = mk({ wait: true });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(50);
  R.R4 = { pending: a.off.pending('claude'), failed: (a.off.seen() || {}).failed, starts: calls('/headless-login/start').length,
    note: (q(box, '#hlNote') || {}).textContent || '' };
  box.remove();

  // R5 O5·O13 — 같은 사실로 다시 그리면 이어받기(restart false)만, [새 주소 받기]만 새로 띄운다, 연타는 흘린다.
  clock = { t: 100000 };
  reset({ status: ST(), start: function () { return { ok: true }; }, state: function () { return { step: 'starting' }; } });
  a = offer(clock); await a.off.load('claude');
  var b1 = mk({ wait: true }); await a.off.paint(b1, 'claude', 'Claude');
  b1.remove();
  var b2 = mk({ wait: true }); await a.off.paint(b2, 'claude', 'Claude'); await sleep(30);
  var before = calls('/headless-login/start').map(function (c) { return c.body.restart; });
  q(b2, '#hlRetry').click();                 // 방금 시작했다(0초) — 흘린다
  clock.t += __H.HEADLESS_RETRY_GAP_MS - 1; q(b2, '#hlRetry').click(); // 경계 직전 — 흘린다
  clock.t += 1; q(b2, '#hlRetry').click();    // 경계 — 새로 띄운다
  q(b2, '#hlRetry').click();                  // 곧바로 한 번 더 — 흘린다
  await sleep(30);
  R.R5 = { before: before, after: calls('/headless-login/start').map(function (c) { return c.body.restart; }),
    harness: calls('/headless-login/start').map(function (c) { return c.body.harness; }) };
  b2.remove();

  // R6 O6 — 서버가 저장했다: 상태가 연결됨으로, 알림 한 줄, 장면을 한 번 다시 그린다.
  var n6 = 0;
  reset({ status: ST(), start: function () { return { ok: true }; }, cancel: function () { return { ok: true }; },
    state: function () { n6++; return n6 === 1 ? { step: 'waiting_code', url: 'https://claude.ai/oauth/authorize?r6=1', needsPaste: true } : { step: 'done', stored: true }; } });
  a = offer(); await a.off.load('claude');
  box = mk({ wait: true });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(60);
  var mid = { pending: a.off.pending('claude'), rerender: a.log.rerender };
  await sleep(2300);
  R.R6 = { mid: mid, pending: a.off.pending('claude'), connected: (a.off.seen() || {}).connected, rerender: a.log.rerender,
    toast: a.log.toast, cancel: calls('/headless-login/cancel').length };
  box.remove();

  // R8 O8 — 화면에서 못 받는 하네스: 묻지도 그리지도 않는다.
  reset({ status: ST(), start: function () { return { ok: true }; } });
  a = offer(); await a.off.load('grok');
  box = mk({ wait: false });
  await a.off.paint(box, 'grok', 'Grok'); await sleep(30);
  R.R8 = { calls: CALLS.length, pending: a.off.pending('grok'), hidden: box.hidden, seen: a.off.seen() };
  box.remove();

  // R10 O10·O17 — 캐시는 그 하네스의 것만 쓴다. 비어 있으면 모름(false)이고 load 가 묻는다.
  reset({ status: ST(null, { connected: true, failure: null }) });
  clock = { t: 5000 };
  a = offer(clock);
  var empty = { seen: a.off.seen(), pending: a.off.pending('claude') };
  await a.off.load('claude');
  var afterClaude = CALLS.length;
  var codexBefore = a.off.pending('codex');   // 캐시는 claude 것 — codex 로 읽지 않는다
  await a.off.load('codex', 5000);            // 방금 쟀어도 하네스가 다르면 다시 묻는다
  R.R10 = { empty: empty, afterClaude: afterClaude, codexBefore: codexBefore, afterCodex: CALLS.length,
    codexPending: a.off.pending('codex'), claudeNow: a.off.pending('claude'), seenHarness: (a.off.seen() || {}).harness };

  // R11 O11 — 캐시 나이 경계.
  reset({ status: ST() });
  clock = { t: 10000 };
  a = offer(clock);
  await a.off.load('claude');            // 1
  clock.t = 10000 + __H.HEADLESS_FRESH_MS - 1;
  await a.off.load('claude', __H.HEADLESS_FRESH_MS);   // 상한 직전 — 안 묻는다
  var justUnder = CALLS.length;
  clock.t = 10000 + __H.HEADLESS_FRESH_MS;
  await a.off.load('claude', __H.HEADLESS_FRESH_MS);   // 상한 — 묻는다
  var atLimit = CALLS.length;
  await a.off.load('claude');                          // 상한 0 — 늘 묻는다
  R.R11 = { justUnder: justUnder, atLimit: atLimit, zero: CALLS.length };

  // R12 O12 — 장면은 «남았다» 로 그렸는데 지금은 연결됨: 장면을 한 번 다시 그리고, 칸을 채우거나 시작하지 않는다.
  reset({ status: ST({ connected: true, failure: null }), start: function () { return { ok: true }; } });
  a = offer();
  box = mk({ wait: true });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(30);
  var first = { rerender: a.log.rerender, starts: calls('/headless-login/start').length, html: box.innerHTML };
  box.remove();
  box = mk({ wait: false });                 // 다시 그린 장면은 같은 값을 본다
  await a.off.paint(box, 'claude', 'Claude'); await sleep(30);
  R.R12 = { first: first, rerender: a.log.rerender, starts: calls('/headless-login/start').length, text: box.textContent };
  box.remove();

  // R14 O14 — 칸이 사라지면 폴링이 멈춘다.
  reset({ status: ST(), start: function () { return { ok: true }; }, state: function () { return { step: 'starting' }; } });
  a = offer(); await a.off.load('claude');
  box = mk({ wait: true });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(2200);
  var polled = calls('/headless-login/state').length;
  box.remove();
  await sleep(4500);
  R.R14 = { polled: polled, after: calls('/headless-login/state').length };

  // R15 O15 — 시작 실패: 사유 한 줄, 폴링 없음, [새 주소 받기]로 다시.
  clock = { t: 50000 };
  var fail = true;
  reset({ status: ST(), start: function () { if (fail) throw new Error('이 서버에는 자격을 암호화해 둘 키가 없어'); return { ok: true }; },
    state: function () { return { step: 'starting' }; } });
  a = offer(clock); await a.off.load('claude');
  box = mk({ wait: true });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(2300);
  var err = (q(box, '#hlErr') || {}).textContent || '';
  var polls = calls('/headless-login/state').length;
  fail = false; clock.t += 3000; q(box, '#hlRetry').click(); await sleep(50);
  R.R15 = { err: err, polls: polls, starts: calls('/headless-login/start').map(function (c) { return c.body.restart; }),
    errAfter: (q(box, '#hlErr') || {}).textContent || '', pollsAfter: calls('/headless-login/state').length };
  box.remove();

  // R16 O16 — claude 코드 붙여넣기: 입력칸이 열리고, 넣은 코드가 그대로 간다.
  reset({ status: ST(), start: function () { return { ok: true }; }, paste: function () { return { ok: true }; },
    state: function () { return { step: 'waiting_code', url: 'https://claude.ai/oauth/authorize?r16=1', needsPaste: true }; } });
  a = offer(); await a.off.load('claude');
  box = mk({ wait: true });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(80);
  var row = vis(q(box, '#hlPasteRow'));
  q(box, '#hlIn').value = '  ac_Q9x-7#pQ  ';
  q(box, '#hlPut').click(); await sleep(30);
  R.R16 = { row: row, paste: calls('/headless-login/paste').map(function (c) { return c.body; }), put: q(box, '#hlPut').textContent };
  box.remove();

  // R17 — codex: 코드 칩이 보이고, 붙여넣기 칸은 없다.
  reset({ status: ST(), start: function () { return { ok: true }; },
    state: function () { return { step: 'waiting_browser', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' }; } });
  a = offer(); await a.off.load('codex');
  box = mk({ wait: true });
  await a.off.paint(box, 'codex', 'ChatGPT'); await sleep(80);
  R.R17 = { chip: vis(q(box, '#hlCodeChip')), code: (q(box, '#hlCode') || {}).textContent, paste: !!q(box, '#hlPasteRow'),
    starts: calls('/headless-login/start').map(function (c) { return c.body; }) };
  box.remove();

  // R19 O14 — 상태를 묻는 사이에 칸이 사라졌다: 아무것도 띄우지 않는다.
  reset({ status: ST(), start: function () { return { ok: true }; }, state: function () { return { step: 'starting' }; } });
  a = offer();
  box = mk({ wait: true });
  var pr = a.off.paint(box, 'claude', 'Claude');
  box.remove();
  await pr; await sleep(30);
  R.R19 = { starts: calls('/headless-login/start').length, rerender: a.log.rerender, status: statusN() };

  // R20 O12 — 묻는 중에 장면이 다시 그려졌다: 새 칸은 **오는 답**을 기다린다(낡은 값으로 시작하지 않는다).
  clock = { t: 0 };
  reset({ status: ST(), start: function () { return { ok: true }; }, state: function () { return { step: 'starting' }; } });
  a = offer(clock);
  await a.off.load('claude');                              // 남음(0초)
  clock.t = 6000;                                          // 캐시가 식었다
  ROUTES.status = function () { return new Promise(function (r) { setTimeout(function () { r(ST({ connected: true, failure: null })()); }, 200); }); };
  var bx1 = mk({ wait: true });
  var p1 = a.off.paint(bx1, 'claude', 'Claude');           // 되묻는 중(200ms)
  bx1.remove();
  var bx2 = mk({ wait: true });
  var p2 = a.off.paint(bx2, 'claude', 'Claude');           // 방금 물었다 → 그 답을 기다린다
  await p1; await p2; await sleep(30);
  R.R20 = { starts: calls('/headless-login/start').length, rerender: a.log.rerender, status: statusN(), pending: a.off.pending('claude') };
  bx2.remove();

  // R21 O10 — 다른 하네스로 겹쳐 물었는데 옛 답(claude)이 늦게 왔다: 새 답(codex)을 덮지 않는다.
  reset({ status: function () { return new Promise(function (r) { setTimeout(function () { r(ST(null, { connected: true, failure: null })()); }, 300); }); } });
  a = offer();
  var slow = a.off.load('claude');                          // 먼저 물었지만 늦게 온다(300ms)
  ROUTES.status = ST(null, { connected: true, failure: null });
  await a.off.load('codex');                                // 나중에 물었고 먼저 온다
  var mid21 = (a.off.seen() || {}).harness;
  await slow; await sleep(20);
  R.R21 = { mid: mid21, seen: (a.off.seen() || {}).harness, codexPending: a.off.pending('codex'), status: statusN() };

  // R22 O6·O10 — 묻는 중에 저장이 끝났다: 늦게 온 «아직» 답이 방금 저장한 사실을 덮지 않는다.
  var n22 = 0;
  reset({ status: ST(), start: function () { return { ok: true }; }, cancel: function () { return { ok: true }; },
    state: function () { n22++; return n22 === 1 ? { step: 'waiting_code', url: 'https://claude.ai/oauth/authorize?r22=1', needsPaste: true } : { step: 'done', stored: true }; } });
  a = offer(); await a.off.load('claude');
  box = mk({ wait: true });
  await a.off.paint(box, 'claude', 'Claude'); await sleep(50);
  ROUTES.status = function () { return new Promise(function (r) { setTimeout(function () { r(ST()()); }, 3000); }); };
  var stale = a.off.load('claude');                        // 되묻는 중(3초) — 답은 «아직»
  await sleep(2300);                                       // 그 사이(2초 폴링) «저장됨» 을 받는다
  var mid22 = { connected: (a.off.seen() || {}).connected, rerender: a.log.rerender };
  await stale; await sleep(20);                            // 옛 답(«아직»)이 저장 **뒤에** 도착한다
  R.R22 = { mid: mid22, pending: a.off.pending('claude'), connected: (a.off.seen() || {}).connected, rerender: a.log.rerender, status: statusN() };
  box.remove();

  // R18 — 이름은 그대로 글자로 들어간다(칸은 innerHTML 로 그린다).
  reset({ status: ST({ connected: true, failure: null }) });
  a = offer(); await a.off.load('claude');
  box = mk({ wait: false });
  await a.off.paint(box, 'claude', '<img src=x onerror="window.__XSS=1">');
  R.R18 = { imgs: box.querySelectorAll('img').length, xss: !!window.__XSS };
  box.remove();
})().then(function () {
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
}, function (e) {
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify({ CRASH: String((e && e.stack) || e) }) + 'ENDRESULT';
});
`;

const PAGE = `<!doctype html><meta charset="utf-8"><pre id="out">PENDING</pre>
<script>${BUNDLE}</script>
<script>${SCENARIOS}</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "onb-headless-rt-", virtualTimeBudget: 60000 });
const m = dom.match(/RESULT(\{.*?\})ENDRESULT/s);
ok(!!m, "R0 [배선] 크롬이 시나리오를 끝까지 돌려 결과를 냈다");
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const R = JSON.parse(unesc(m[1]));
ok(!R.CRASH, "R0′ [배선] 칸이 페이지 안에서 죽지 않았다", R.CRASH);
if (process.env.ONB_HEADLESS_DEBUG) console.log("DBG", show(R));

ok(R.R1.status === 1, "R1′ [배선] 상태를 실제로 물었다", show(R.R1));
ok(R.R1.pending === true && R.R1.hidden === false, "R1 O1 허용이 남았으면 칸이 보인다", show(R.R1));
ok(show(R.R1.starts) === show([{ harness: "claude", restart: false }]),
  "R1″ O1·O5 누르지 않아도 한 번 시작한다 — 이어받기(restart false)로", show(R.R1.starts));
ok(R.R1.addr === "claude.ai/oauth/authorize?r1=1" && R.R1.open === true && R.R1.paste === true,
  "R1‴ O1 주소·[열기]·코드 칸이 이 자리에 뜬다(공용 프로토콜이 실제로 돈다)", show(R.R1));
ok(R.R1.rerender === 0, "R1⁗ O12 사실이 그린 판단과 같으면 장면을 다시 그리지 않는다", show(R.R1));

ok(R.R2.pending === false && R.R2.hidden === false && /연결돼 있어요/.test(R.R2.text), "R2 O2 이미 연결됨 — 연결됨 한 줄", show(R.R2));
ok(R.R2.starts === 0 && R.R2.rerender === 0, "R2′ O2 연결됐으면 발급을 띄우지 않는다", show(R.R2));

ok(R.R3.pending === false && R.R3.seen === null && R.R3.hidden === true && R.R3.starts === 0,
  "R3 O3 상태를 모르면(구 서버) 종전 화면 — 칸 숨김, 발급 0건", show(R.R3));
ok(R.R3b.pending === false && R.R3b.seen === null, "R3b O3 행이 없는 응답도 모름이다", show(R.R3b));

ok(R.R3c.first.rerender === 1 && R.R3c.first.starts === 0 && R.R3c.first.status === 1,
  "R3c O3·O12 «남았다» 로 그린 장면인데 지금은 모름 — 장면을 다시 그린다(칸을 채우거나 시작하지 않는다)", show(R.R3c));
ok(R.R3c.rerender === 1 && R.R3c.hidden === true && R.R3c.starts === 0 && R.R3c.status === 1,
  "R3c′ O3·O11 다시 그린 칸은 숨고, 방금 «모름» 을 받았으니 되묻지 않는다(오락가락 없음)", show(R.R3c));
ok(R.R4.pending === true && R.R4.failed === true && R.R4.starts === 1 && /더는 통하지 않아요/.test(R.R4.note),
  "R4 O4 저장됐어도 인증이 실패했으면 다시 허용받는다(사유를 말한다)", show(R.R4));

ok(show(R.R5.before) === show([false, false]), "R5 O5 같은 사실로 다시 그리면 이어받기만 한다(받은 주소가 안 죽는다)", show(R.R5));
ok(show(R.R5.after) === show([false, false, true]), "R5′ O5·O13 [새 주소 받기]만 새로 띄우고, 2.5초 안의 연타·직전 값은 흘린다", show(R.R5));
ok(R.R5.harness.every((x) => x === "claude"), "R5″ 시작은 늘 그 하네스다", show(R.R5));

ok(R.R6.mid.pending === true && R.R6.mid.rerender === 0, "R6′ O6 저장 전에는 남은 일이다", show(R.R6));
ok(R.R6.pending === false && R.R6.connected === true && R.R6.rerender === 1, "R6 O6 저장되면 연결됨으로 바꾸고 장면을 한 번 다시 그린다", show(R.R6));
ok(R.R6.toast.length === 1 && /연결했어요/.test(R.R6.toast[0]) && R.R6.cancel === 1, "R6″ O6 알림 한 줄 · 발급 자리를 치운다", show(R.R6));

ok(R.R8.calls === 0 && R.R8.pending === false && R.R8.hidden === true && R.R8.seen === null,
  "R8 O8 화면에서 못 받는 하네스는 묻지도 그리지도 않는다", show(R.R8));

ok(R.R10.empty.seen === null && R.R10.empty.pending === false, "R10 O17 비어 있으면 모름 — 남은 일로 치지 않는다", show(R.R10));
ok(R.R10.afterClaude === 1 && R.R10.codexBefore === false, "R10′ O10 캐시는 그 하네스(claude)의 것 — codex 로 읽지 않는다", show(R.R10));
ok(R.R10.afterCodex === 2 && R.R10.seenHarness === "codex" && R.R10.codexPending === false && R.R10.claudeNow === false,
  "R10″ O10 방금 쟀어도 하네스가 다르면 다시 묻고, 캐시는 새 하네스의 것이 된다", show(R.R10));

ok(R.R11.justUnder === 1, "R11 O11 상한 직전 — 다시 묻지 않는다", show(R.R11));
ok(R.R11.atLimit === 2, "R11′ O11 상한 — 다시 묻는다", show(R.R11));
ok(R.R11.zero === 3, "R11″ O11 상한 0 — 늘 묻는다", show(R.R11));

ok(R.R12.first.rerender === 1 && R.R12.first.starts === 0 && R.R12.first.html === "",
  "R12 O12 그린 판단과 사실이 다르면 장면을 다시 그린다(칸을 채우거나 시작하지 않는다)", show(R.R12));
ok(R.R12.rerender === 1 && R.R12.starts === 0 && /연결돼 있어요/.test(R.R12.text), "R12′ O12 다시 그린 장면에서는 반복하지 않는다", show(R.R12));

ok(R.R14.polled >= 1, "R14′ [배선] 칸이 있는 동안은 폴링한다", show(R.R14));
ok(R.R14.after === R.R14.polled, "R14 O14 칸이 사라지면 폴링이 멈춘다", show(R.R14));

ok(/암호화해 둘 키가 없어/.test(R.R15.err) && /새 주소 받기/.test(R.R15.err), "R15 O15 시작 실패는 사유와 다음 행동을 말한다", show(R.R15));
ok(R.R15.polls === 0, "R15′ O15 띄운 것이 없으면 폴링하지 않는다(사유를 덮지 않는다)", show(R.R15));
ok(show(R.R15.starts) === show([false, true]) && R.R15.errAfter === "" && R.R15.pollsAfter >= 1,
  "R15″ O15 [새 주소 받기]로 새로 띄우면 사유가 지워지고 폴링이 시작된다", show(R.R15));

ok(R.R16.row === true && show(R.R16.paste) === show([{ harness: "claude", code: "ac_Q9x-7#pQ" }]) && R.R16.put === "넣었어요",
  "R16 O16 claude 코드 칸 — 넣은 코드가 앞뒤 공백만 걷혀 그대로 간다", show(R.R16));
ok(R.R17.chip === true && R.R17.code === "ABCD-EFGH" && R.R17.paste === false && show(R.R17.starts) === show([{ harness: "codex", restart: false }]),
  "R17 codex — 코드 칩이 보이고 붙여넣기 칸은 없다", show(R.R17));
ok(R.R18.imgs === 0 && R.R18.xss === false, "R18 이름은 글자로 들어간다(마크업이 되지 않는다)", show(R.R18));
ok(R.R21.status === 2 && R.R21.mid === "codex" && R.R21.seen === "codex" && R.R21.codexPending === false,
  "R21 O10 다른 하네스로 겹쳐 물으면 늦게 온 옛 답이 새 답을 덮지 않는다", show(R.R21));
ok(R.R22.mid.connected === true && R.R22.mid.rerender === 1, "R22′ [배선] 옛 답이 오기 전에 저장이 먼저 끝났다(순서가 시나리오대로다)", show(R.R22));
ok(R.R22.status === 2 && R.R22.rerender === 1 && R.R22.connected === true && R.R22.pending === false,
  "R22 O6 묻는 중에 저장이 끝나면, 늦게 온 «아직» 답이 저장 사실을 덮지 않는다", show(R.R22));
ok(R.R19.starts === 0 && R.R19.rerender === 0 && R.R19.status === 1, "R19 O14 묻는 사이에 칸이 사라지면 아무것도 띄우지 않는다", show(R.R19));
ok(R.R20.status === 2 && R.R20.starts === 0 && R.R20.rerender === 1 && R.R20.pending === false,
  "R20 O12 묻는 중에 다시 그린 칸은 오는 답(연결됨)을 기다린다 — 낡은 «남음» 으로 발급을 띄우지 않는다", show(R.R20));

console.log(`\n${pass} passed`);
