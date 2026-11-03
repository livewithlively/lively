// 브라우저 탭 제목 = 지금 보는 화면의 이름 (#5301) — 값 · 배선 · **런타임** 셋으로 고정한다.
//
//  요청: 세션 창을 여럿 띄워 두는 일이 잦은데 브라우저 탭이 전부 «Lively Context» 라 어느 창이 어느 세션인지 고를 수 없다.
//  원인: public/index.html 의 고정 제목을 셸(web/v2)이 한 번도 바꾸지 않았다. 셸 탭 기계(web/v2/tabs.ts)는 화면마다 이름을
//   매기고 있었지만(main.ts titleFor — 사이드바와 같은 규칙) 그 이름이 탭 줄(지금은 안 그린다) 밖으로 나가지 않았다.
//  고친 것: 탭 기계가 이름을 다시 매길 때마다(paint 끝 · onRetitled) 셸이 지금 보는 탭의 이름으로 document.title 을 맞춘다
//   (lib/doc-title.ts). 숨은 창은 목록을 새로 받지 않으므로, 보이는 창이 목록에서 새 이름을 알게 되면 그 세션 하나의 이름을
//   같은 브라우저의 다른 창에 알리고(BroadcastChannel) 숨은 창은 제목만 맞춘다.
//
// 엣지 표(사양의 행 번호 그대로)
//  D1 이름 → «이름 · Lively» · D1b 경계: 한 글자 · D2 빈 이름(''·null·undefined·공백뿐·줄바꿈뿐) → «Lively»
//  D3 줄바꿈 · 탭 · 연속 공백은 한 칸 · D4 앞뒤 공백은 걷는다
//  D5 탭이 없으면(null · undefined) 제목을 안 건드린다 · D6 탭이 있으면 그 이름으로 · D7 같은 값(공백만 다른 것 포함)이면 다시 안 쓴다
//  M1 알림 말은 창 사이 복제를 거쳐도 그대로 읽힌다 · M2 엉뚱한 말은 버린다
//  A1 숨음 + 지금 그 세션 + 새 이름 → 맞춘다 · A2 보임 → 무시 · A3 다른 세션을 봄 → 무시 · A4 세션 아닌 화면 → 무시
//  A5 탭 없음 → 무시 · A6 엉뚱한 말 → 무시 · A7 같은 이름 → 쓰기 0
//  R0 아무 탭도 안 켰으면 원래 제목 · R1 세션 탭을 켜면 그 세션 이름 · R2 다른 세션 · R3 돌아가기
//  R4 보는 세션 이름이 바뀌면(paint) 새 이름 · R5 안 보는 탭이 바뀌면 그대로 · R6 같은 탭 주소 이동(routed)
//  R7 ★목록에 아직 없는 세션은 저장된 이름(id 꼬리 아님) · R8 이름을 모르는 세션은 `세션 <id꼬리>` · R9 줄바꿈 이름은 한 줄
//  R10 보던 탭을 닫으면 옮겨 간 탭의 이름 · R11 홈 · R12 이름이 그대로면 <title> 을 다시 안 쓴다(대조: 바꾸면 쓴다)
//  R13 onRetitled 를 안 준 엔진도 깨지지 않는다 · B1 진짜 BroadcastChannel 알림 + 숨음 → 맞춘다 · B2 보임 → 그대로
//  W 셸 배선(아래 각 줄)
//
// fail-first: `SRC_ROOT=<고치기 전 트리>` 로 돌리면 그 트리의 lib/doc-title.ts · tabs.ts · main.ts 를 잰다. 런타임 절의 제목 맞추기 함수만은
//  이 트리(ROOT)의 것을 쓴다 — 고치기 전 탭 기계가 그걸 **부르지 않는다**는 것이 곧 빨강이다.
//  실측(2026-11-03, origin/main 4f3ae5d7e 의 web/): 21건 빨강(D0 · W1~W6 · R1~R12 — R1~R11 은 전부 «Lively Context» 그대로) ·
//  초록 6(R0 · R13 · B1 · B2 · 배선 둘 — 종전 동작이거나 이 트리의 함수만 재는 줄). 변형 시험: 공백 접기 제거 → D3 · D7 /
//  같은 값 다시 쓰기 → D7 / 숨음 무시 → A2 / 세션 대조 제거 → A3 / onRetitled 를 이름 고치기 전(paint 머리)으로 → R4 · R9 /
//  말 종류 검사 제거 → M2 · A6 / 빌린 이름도 알리기 → W3.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BREATHE_URL, dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const read = (p) => readFileSync(path.join(SRC_ROOT, p), "utf8");
//  «있어야 할 것 · 없어야 할 것» 은 **코드에서만** 센다 — 걷어낸 식을 주석으로 인용해도 거짓 초록 · 거짓 빨강이 나지 않게.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => { const i = l.indexOf("//"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");

let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const show = (v) => JSON.stringify(v);
const finish = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };

// ── D · M · A — 값: 이 트리(SRC_ROOT)의 lib/doc-title.ts 를 묶어 노드에서 잰다 ─────────────────
const DT_SRC = path.join(SRC_ROOT, "web/lib/doc-title.ts");
//  가짜 문서 — 제목을 몇 번 썼는지 센다(D7 · A7). 진짜 문서처럼 읽을 때 공백을 접지는 않는다(값이 같으면 안 쓰는지만 본다).
const fakeDoc = (title) => { let t = title, sets = 0; return { get title() { return t; }, set title(v) { sets++; t = v; }, get sets() { return sets; } }; };
if (!existsSync(DT_SRC)) {
  ok(false, "D0 web/lib/doc-title.ts 가 있다", "없음 — 브라우저 탭 제목을 맞추는 자리가 없다");
} else {
  const js = (await build({ entryPoints: [DT_SRC], bundle: true, format: "esm", write: false, platform: "neutral", logLevel: "silent" })).outputFiles[0].text;
  const { docTitle, syncDocTitle, sessTitleMsg, readSessTitleMsg, applySessTitleMsg } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

  ok(docTitle("결제 백오프") === "결제 백오프 · Lively", "D1 이름 → «이름 · Lively»(이름이 앞이다 — 좁은 탭엔 앞 몇 글자만 보인다)", show(docTitle("결제 백오프")));
  ok(docTitle("x") === "x · Lively", "D1b 경계 — 한 글자 이름도 이름이다", show(docTitle("x")));
  const empties = ["", null, undefined, "   ", "\n\t "].map((v) => docTitle(v));
  ok(empties.every((v) => v === "Lively"), "D2 빈 이름은 제품 이름만", show(empties));
  ok(docTitle("첫 줄\n둘째 줄\t  끝") === "첫 줄 둘째 줄 끝 · Lively", "D3 줄바꿈 · 탭 · 연속 공백은 한 칸으로", show(docTitle("첫 줄\n둘째 줄\t  끝")));
  ok(docTitle("  앞뒤 공백  ") === "앞뒤 공백 · Lively", "D4 앞뒤 공백은 걷는다", show(docTitle("  앞뒤 공백  ")));
  {
    const d = fakeDoc("Lively Context");
    syncDocTitle(d, null); syncDocTitle(d, undefined);
    ok(d.title === "Lively Context" && d.sets === 0, "D5 탭이 없으면 제목을 안 건드린다(부팅 중)", show({ title: d.title, sets: d.sets }));
    syncDocTitle(d, { title: "한글 자모분리" });
    ok(d.title === "한글 자모분리 · Lively" && d.sets === 1, "D6 탭이 있으면 그 이름으로 맞춘다", show({ title: d.title, sets: d.sets }));
    syncDocTitle(d, { title: "한글 자모분리" }); syncDocTitle(d, { title: " 한글  자모분리 " });
    ok(d.sets === 1, "D7 같은 값이면 다시 쓰지 않는다(공백만 다른 이름도 같은 값)", show({ sets: d.sets }));
  }

  const back = readSessTitleMsg(structuredClone(sessTitleMsg("box-yoon-2df0bd45", " 노드 연결 오류 ")));
  ok(show(back) === show({ id: "box-yoon-2df0bd45", name: "노드 연결 오류" }), "M1 알림 말은 창 사이 복제를 거쳐도 그대로 읽힌다 · 앞뒤 공백은 걷는다", show(back));
  const junk = [null, undefined, "sess-title", 42, {}, { id: "a", name: "b" },
    { ...sessTitleMsg("a", "b"), type: "other" }, { ...sessTitleMsg("a", "b"), id: 7 }, { ...sessTitleMsg("a", "b"), name: null },
    sessTitleMsg("", "b"), sessTitleMsg("a", "   ")].map((v) => readSessTitleMsg(v));
  ok(junk.every((v) => v === null), "M2 엉뚱한 말은 버린다", show(junk));

  //  A — 받은 알림 적용. 한 줄마다 새 탭 · 새 문서로 잰다(앞 줄의 결과가 다음 줄을 가리지 않게).
  const A = (over) => {
    const tab = { title: "옛 이름" }, doc = fakeDoc("옛 이름 · Lively");
    const v = { hidden: true, tab, sessionId: "box-a", doc, ...over };
    const did = applySessTitleMsg(over && "msg" in over ? over.msg : sessTitleMsg("box-a", "새 이름"), v);
    return { did, tab: v.tab ? v.tab.title : null, doc: doc.title, sets: doc.sets };
  };
  const a1 = A({});
  ok(a1.did === true && a1.tab === "새 이름" && a1.doc === "새 이름 · Lively" && a1.sets === 1, "A1 숨은 창이 지금 그 세션을 보면 탭 이름 · 문서 제목을 맞춘다", show(a1));
  const a2 = A({ hidden: false });
  ok(a2.did === false && a2.tab === "옛 이름" && a2.sets === 0, "A2 보이는 창은 무시한다(제 목록으로 맞춘다)", show(a2));
  const a3 = A({ sessionId: "box-b" });
  ok(a3.did === false && a3.tab === "옛 이름" && a3.sets === 0, "A3 다른 세션을 보는 창은 무시한다", show(a3));
  const a4 = A({ sessionId: "" });
  ok(a4.did === false && a4.tab === "옛 이름" && a4.sets === 0, "A4 세션이 아닌 화면은 무시한다", show(a4));
  const a5 = A({ tab: null });
  ok(a5.did === false && a5.sets === 0, "A5 탭이 없으면 무시한다", show(a5));
  const a6 = A({ msg: { type: "other", id: "box-a", name: "새 이름" } });
  ok(a6.did === false && a6.tab === "옛 이름" && a6.sets === 0, "A6 엉뚱한 말은 무시한다", show(a6));
  const a7 = A({ msg: sessTitleMsg("box-a", "옛 이름") });
  ok(a7.did === false && a7.sets === 0, "A7 받은 이름이 지금과 같으면 쓰지 않는다", show(a7));
}

// ── W — 셸 배선(main.ts 는 셸 전체를 끌고 와 따로 묶을 수 없다 — 붙이는 줄만 코드에서 잰다) ──────────────
{
  const tabs = code(read("web/v2/tabs.ts"));
  const main = code(read("web/v2/main.ts"));
  ok(/onRetitled\?\(active: ShellTab \| null\): void;/.test(tabs), "W1 탭 기계가 onRetitled 를 선언한다(셸이 안 주면 안 부른다 — R13)");
  ok(/onRetitled: \(tab\) => syncDocTitle\(document, tab\),/.test(main), "W2 셸이 onRetitled 로 document 제목을 맞춘다");
  ok(/if \(t\.named && rememberSessName\(sid, title\)\) announceSessName\(sid, title\);/.test(main),
    "W3 세션 갈래가 그 세션의 이름을 **새로** 기억할 때만 다른 창에 알린다(빌린 pane 제목 · 같은 이름은 안 알린다)");
  const r0 = main.indexOf("function rememberSessName("), r1 = main.indexOf("\n}", r0);
  const remember = r0 >= 0 && r1 > r0 ? main.slice(r0, r1) : "";
  ok(/\): boolean \{/.test(remember) && /sessNames\.get\(id\) === n\) return false;/.test(remember) && /return true;\s*$/.test(remember),
    "W3′ 기억이 그대로면(같은 이름 · 폴백 모양 · 빈 이름) 거짓 · 바뀌었을 때만 참을 돌려준다", show(remember.slice(-120)));
  const l0 = main.indexOf("function listenSessTitles(): void {"), l1 = main.indexOf("\n}", l0);
  const listen = l0 >= 0 && l1 > l0 ? main.slice(l0, l1) : "";
  ok(/typeof BroadcastChannel !== 'function'\) return;/.test(listen) && /new BroadcastChannel\(SESS_TITLE_CHANNEL\)/.test(listen)
    && /applySessTitleMsg\(ev\.data, \{ hidden: document\.hidden, tab, sessionId: k\.startsWith\('s:'\) \? k\.slice\(2\) : '', doc: document \}\)/.test(listen),
    "W4 받는 쪽은 통로가 없으면 조용히 빠지고, 받은 말은 숨음 · 지금 세션 · 이 문서로 applySessTitleMsg 에 넘긴다", show(listen.slice(0, 500)));
  ok(/sessTitleChan\?\.postMessage\(sessTitleMsg\(id, name\)\)/.test(main), "W4′ 알리는 쪽도 통로가 없으면 조용히 빠진다(?.)");
  const bootAt = main.indexOf("export async function bootV2");
  ok(bootAt >= 0 && main.indexOf("listenSessTitles();", bootAt) > bootAt && main.indexOf("listenSessTitles();") > bootAt,
    "W5 귀는 셸 시작(bootV2)에서만 연다(main.ts 의 맨 위 코드는 클래식 화면에서도 불려 온다)");
  const writers = readdirSync(path.join(SRC_ROOT, "web/v2")).filter((f) => f.endsWith(".ts"))
    .filter((f) => /document\.title\s*=(?!=)/.test(code(read("web/v2/" + f))));
  ok(writers.length === 0 && existsSync(DT_SRC) && /doc\.title = next/.test(code(readFileSync(DT_SRC, "utf8"))),
    "W6 셸에서 제목을 쓰는 자리는 lib/doc-title.ts 하나다(두 자리가 쓰면 서로 덮는다)", show(writers));
}

// ── R · B — 런타임: 진짜 탭 기계(web/v2/tabs.ts)와 진짜 BroadcastChannel 을 헤드리스 크롬에서 ────────────
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 런타임 절(R · B)을 건너뜁니다(CHROME_BIN 으로 지정)");
  finish();
}
//  셸 의존(core · shell-prefs · embed)만 얇게 갈아 끼운다 — tab-landing.test.mjs 와 같은 꼴. el/sv 는 진짜 lib/dom.ts.
const STUBS = {
  "../core.js": `export { el, sv } from ${JSON.stringify(path.join(SRC_ROOT, "web/lib/dom.ts"))}; export function anchoredPopover() { return function () {}; }`,
  "./shell-prefs.js": "export function deviceStore(base) { return base; }",
  "./embed.js": "export const EMBEDDED = false;",
};
const DT_RT = JSON.stringify(path.join(ROOT, "web/lib/doc-title.ts"));
const bundled = await build({
  stdin: {
    contents: `import { createTabs } from './tabs.ts'; import * as DT from ${DT_RT}; window.__T = { createTabs, DT };`,
    resolveDir: path.join(SRC_ROOT, "web/v2"), loader: "ts",
  },
  bundle: true, format: "iife", write: false, logLevel: "silent",
  plugins: [{
    name: "shell-stubs",
    setup(b) {
      b.onResolve({ filter: /^(\.\.\/core|\.\/shell-prefs|\.\/embed)\.js$/ }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js", resolveDir: ROOT }));
    },
  }],
});
const BUNDLE = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

//  titleFor 는 셸(main.ts)의 규칙을 흉내 낸다: 아는 세션은 그 이름 · 목록에 없는 세션은 id 꼬리(provisional) · 새 세션 자리 · 홈.
//  onRetitled 는 셸과 똑같이 건다(W2 가 셸의 그 줄을 잰다).
const SCENARIOS = String.raw`
localStorage.removeItem('lively_v2_tabs');
var NAMES = { 'box-a': '결제 백오프', 'box-b': '한글 자모분리' };
function titleFor(r) {
  var m = /^#\/s\/([^?]+)/.exec(r);
  if (m) {
    var id = decodeURIComponent(m[1]);
    if (NAMES[id]) return { title: NAMES[id], noAside: true };
    return { title: '세션 ' + (id.split('-').pop() || id).slice(0, 6), noAside: true, unresolved: true, provisional: true };
  }
  if (/^#\/p\//.test(r)) return { title: '새 세션', noAside: true, kind: 'new' };
  return { title: '홈', noAside: true };
}
function engine(withHook) {
  var center = document.createElement('div'), aside = document.createElement('div');
  document.body.append(center, aside);
  var hooks = { titleFor: titleFor, onActivate: function () {}, onClose: function () {} };
  if (withHook) hooks.onRetitled = function (tab) { __T.DT.syncDocTitle(document, tab); };
  return __T.createTabs(center, aside, hooks);
}
var T = function () { return document.title; };
var R = {};
// R13 — 훅을 안 준 엔진(종전 호출자)도 깨지지 않고 제목을 안 건드린다. 맨 먼저 돌린다(뒤 엔진이 제목을 바꾸기 전).
(function () {
  var e = engine(false);
  e.paint(); var x = e.add('#/s/box-a'); NAMES['box-a'] = '결제 백오프'; e.paint(); e.close(x);
  R.R13 = { title: T(), tabs: e.tabs.length };
  localStorage.removeItem('lively_v2_tabs');
})();
var api = engine(true);
api.paint(); R.R0 = T();
var a = api.add('#/s/box-a'); R.R1 = T();
var b = api.add('#/s/box-b'); R.R2 = T();
api.activate(a); R.R3 = T();
NAMES['box-a'] = '결제 재시도'; api.paint(); R.R4 = T();
NAMES['box-b'] = '자모 합치기'; api.paint(); R.R5 = T();
a.route = '#/p/7'; api.routed(a); R.R6 = T();
var g = api.add('#/s/box-gone-c0ffee12', { activate: false, title: '알던 이름' });
api.activate(g); R.R7 = T();
api.add('#/s/box-new-deadbeef'); R.R8 = T();
NAMES['box-b'] = '  여러 줄\n  이름 '; api.activate(b); R.R9 = T();
api.close(b); R.R10 = { title: T(), cur: api.current() && api.current().route };
api.add('#/'); R.R11 = T();
`;

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Lively Context</title></head><body><pre id="out">PENDING</pre>
<script>${BUNDLE}</script>
<script>
(async function () {
  var out = document.getElementById('out');
  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  //  숨 고르기 — BroadcastChannel 은 브라우저 프로세스를 한 번 거쳐 오는 **진짜 비동기**라 가상 시간의 setTimeout 만으로 기다리면
  //   메시지가 오기 전에 대기가 끝난다(실측: 고치기 전 트리로 돌린 판에서 50틱 안에 한 통도 안 왔다). 요청이 걸려 있는 동안
  //   크롬이 가상 시간을 멈추므로, 기다릴 때마다 작은 진짜 요청을 끼운다(headless-chrome.mjs BREATHE_URL 머리말).
  var realFetch = window.fetch.bind(window);
  var breathe = function () { return realFetch('${BREATHE_URL}').then(function (r) { return r.text(); }).catch(function () { return ''; }); };
  try {
${SCENARIOS}
    //  R12 — 이름이 그대로면 paint 를 거듭해도 <title> 을 다시 쓰지 않는다(셸은 8초 틱마다 paint 한다).
    //   대조군: 이름을 바꾸고 paint 하면 변이가 잡힌다 — 관측 장치가 살아 있어야 «0» 이 뜻을 가진다.
    var muts = 0;
    new MutationObserver(function (l) { muts += l.length; }).observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });
    api.paint(); api.paint(); api.paint();
    await tick();
    var idle = muts;
    var h = api.current(); NAMES['box-a'] = 'x'; h.route = '#/s/box-a'; api.routed(h);
    await tick();
    R.R12 = { idle: idle, changed: muts - idle, title: T() };
    //  B — 진짜 BroadcastChannel: 보내는 통로 하나 · 받는 통로 하나(같은 이름 — 다른 창의 셸이 여는 통로와 같다).
    //   받는 쪽은 셸과 같이 applySessTitleMsg 에 넘긴다(W4). 숨음은 인자로 준다(헤드리스 문서는 숨길 수 없다).
    var cur = api.current();
    var send = new BroadcastChannel(__T.DT.SESS_TITLE_CHANNEL), recv = new BroadcastChannel(__T.DT.SESS_TITLE_CHANNEL);
    var got = [];
    var hidden = true;
    recv.onmessage = function (ev) { got.push(__T.DT.applySessTitleMsg(ev.data, { hidden: hidden, tab: cur, sessionId: 'box-a', doc: document })); };
    send.postMessage(__T.DT.sessTitleMsg('box-a', 'AI 가 지은 이름'));
    for (var i = 0; i < 100 && got.length < 1; i++) await breathe();
    R.B1 = { got: got.slice(), title: T(), tab: cur.title };
    hidden = false;
    send.postMessage(__T.DT.sessTitleMsg('box-a', '보이는 창엔 안 온다'));
    for (var j = 0; j < 100 && got.length < 2; j++) await breathe();
    R.B2 = { got: got.slice(1), title: T() };
    send.close(); recv.close();
    out.textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
  } catch (e) {
    out.textContent = 'RESULT' + JSON.stringify({ CRASH: String((e && e.stack) || e) }) + 'ENDRESULT';
  }
})();
</script></body></html>`;

//  serve — BroadcastChannel 은 출처가 있어야 한다(file:// 는 출처가 불투명하다). 정적 서버로 싣는다.
const dom = await dumpDom(chrome, { html: PAGE, prefix: "doc-title-rt-", virtualTimeBudget: 5000, serve: true });
const mm = dom.match(/RESULT(\{.*?\})ENDRESULT/s);
ok(!!mm, "R· [배선] 크롬이 시나리오를 끝까지 돌려 결과를 냈다", dom.slice(-300));
if (!mm) finish();
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const R = JSON.parse(unesc(mm[1]));
ok(!R.CRASH, "R·′ [배선] 탭 기계가 페이지 안에서 죽지 않았다", R.CRASH);
if (process.env.DOC_TITLE_DEBUG) console.log("DBG", show(R));
if (!R.CRASH) {
  ok(R.R13 && R.R13.title === "Lively Context" && R.R13.tabs >= 1, "R13 onRetitled 를 안 준 엔진도 깨지지 않고 제목을 안 건드린다", show(R.R13));
  ok(R.R0 === "Lively Context", "R0 아무 탭도 안 켰으면 index.html 의 제목 그대로", show(R.R0));
  ok(R.R1 === "결제 백오프 · Lively", "R1 ★요청 — 세션 탭을 켜면 브라우저 탭 제목이 그 세션 이름이다", show(R.R1));
  ok(R.R2 === "한글 자모분리 · Lively", "R2 다른 세션을 열면 그 세션 이름", show(R.R2));
  ok(R.R3 === "결제 백오프 · Lively", "R3 앞 세션으로 돌아가면 그 이름", show(R.R3));
  ok(R.R4 === "결제 재시도 · Lively", "R4 보는 세션의 이름이 바뀌면(목록 갱신 → paint) 제목도 바뀐다", show(R.R4));
  ok(R.R5 === "결제 재시도 · Lively", "R5 안 보는 탭의 이름이 바뀌어도 제목은 지금 탭의 것", show(R.R5));
  ok(R.R6 === "새 세션 · Lively", "R6 같은 탭에서 주소가 옮겨 가면(routed) 새 화면 이름", show(R.R6));
  ok(R.R7 === "알던 이름 · Lively", "R7 ★목록에 아직 없는 세션(켠 직후 · 되살린 세션)은 저장해 둔 이름 — id 꼬리로 덮지 않는다", show(R.R7));
  ok(R.R8 === "세션 deadbe · Lively", "R8 이름을 한 번도 모르는 세션은 사이드바와 같은 id 꼬리(종전 폴백)", show(R.R8));
  ok(R.R9 === "여러 줄 이름 · Lively", "R9 줄바꿈이 든 이름은 한 줄로", show(R.R9));
  ok(R.R10 && R.R10.cur === "#/s/box-new-deadbeef" && R.R10.title === "세션 deadbe · Lively", "R10 보던 탭을 닫으면 옮겨 간 탭(가장 최근에 보던 것)의 이름", show(R.R10));
  ok(R.R11 === "홈 · Lively", "R11 홈은 «홈 · Lively»", show(R.R11));
  ok(R.R12 && R.R12.idle === 0 && R.R12.changed >= 1 && R.R12.title === "x · Lively",
    "R12 이름이 그대로면 paint 를 거듭해도 <title> 을 다시 쓰지 않는다(대조: 이름이 바뀌면 쓴다 — 관측 장치가 살아 있다)", show(R.R12));
  ok(R.B1 && show(R.B1.got) === show([true]) && R.B1.title === "AI 가 지은 이름 · Lively" && R.B1.tab === "AI 가 지은 이름",
    "B1 진짜 BroadcastChannel 로 온 새 이름 — 숨은 창이 그 세션을 보면 탭 이름 · 문서 제목을 맞춘다", show(R.B1));
  ok(R.B2 && show(R.B2.got) === show([false]) && R.B2.title === "AI 가 지은 이름 · Lively", "B2 같은 알림이 보이는 창에 오면 그대로 둔다", show(R.B2));
}
finish();
