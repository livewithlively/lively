// 보던 화면을 닫은 뒤 어디로 가나 (#3890, 상민님 신고 2026-09-11) — 값 · 배선 · **런타임** 셋으로 고정한다.
//  사양·엣지 표(L·S·K·C·P·W)는 스크래치패드 spec-3890.md — 아래 이름의 번호가 그 행이다.
//
//  무엇이 문제였나:
//   홈 사이드바에서 세션을 닫으면 셸은 **숨긴 탭 배열에서 닫힌 자리의 옆 칸**으로 갔다(탭 줄을 안 그리므로 사람은
//   그 순서를 볼 수 없다). 복원은 앞에서 12개(= 가장 오래 연 탭)를 남겨 옛 탭이 배열 앞쪽에 눌러앉았고, 그중 하나
//   — 서버가 이미 모르는 세션 — 가 옆 칸이라는 이유로 화면에 올라왔다.
//   규칙은 VS Code 기본값(focusRecentEditorAfterClose): **가장 최근에 보던 화면**으로 간다.
//
//  ⚠ 값만으로는 부족하다 — 규칙이 맞아도 엔진이 그걸 안 부르면 그대로다(obs-carry·hold-rules 테스트와 같은 이유).
//   그래서 실제 엔진(web/v2/tabs.ts)을 esbuild 로 묶어 헤드리스 크롬에서 돌린다(DOM·localStorage 가 진짜다).
//   엔진이 부르는 셸 의존(core·shell-prefs·embed)만 얇게 갈아 끼우고, el/sv 는 진짜 lib/dom.ts 를 쓴다.
//   크롬이 없는 면에서는 런타임 절만 건너뛴다(값·배선은 그대로 돈다).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
//  «없어야 할 것» 은 **코드에서만** 센다 — 걷어낸 식을 «왜 걷었나» 주석으로 인용하는 것은 좋은 주석이고, 그걸 세면
//   거짓 빨강이 난다(지식 change-request-deploy-set-dev-main-managed «주석 잔류는 구조다»).
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => { const i = l.indexOf("//"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");

let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };
const show = (v) => JSON.stringify(v);

// ── 규칙 모듈을 따로 컴파일해 값으로 잰다 ──────────────────────────────────────
const tmp = mkdtempSync(path.join(tmpdir(), "tab-landing-"));
try {
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/tab-landing.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { pickLanding, nextStamp, keepRecent, planRestore, seenValue } = await import(path.join(tmp, "tab-landing.js"));

  // ── L — 착지 pickLanding ─────────────────────────────────────────────────
  const T = (id, seenAt) => ({ id, seenAt });
  const id = (t) => (t ? t.id : null);
  ok(id(pickLanding([T("A", 10), T("B", 30), T("C", 20)])) === "B", "L1 가장 최근에 본 화면으로 간다");
  ok(id(pickLanding([T("A", 10), T("B", 30), T("C", 20)], (t) => t.id !== "B")) === "C",
    "L2 갈 수 없는 화면은 가장 최근이어도 건너뛰고 그다음으로 간다");
  ok(pickLanding([T("A", 0), { id: "B" }, T("C", NaN)]) === null, "L3 한 번도 본 적 없는 화면만 남으면 갈 곳이 없다(null)");
  ok(pickLanding([]) === null, "L4 남은 화면이 없으면 null");
  ok(id(pickLanding([T("A", 0), T("B", 5)])) === "B", "L5 앞 칸이어도 본 적 없는 화면(0)은 후보가 아니다");
  //  L6 — 닫힌 탭이 번호 0 이었다고 치면 옛 규칙(옆 칸)은 tabs[0] = X 를 골랐다
  ok(id(pickLanding([T("X", 10), T("B", 30), T("A", 20)])) === "B", "L6 배열의 자리(옆 칸)는 판정에 끼지 않는다");
  ok(id(pickLanding([T("A", 1), T("B", 2)], undefined)) === "B", "L7 canLand 를 안 주면 전부 후보다");
  ok(pickLanding([T("A", 10), T("B", 30)], () => false) === null, "L8 전부 갈 수 없으면 null");
  ok(pickLanding([T("A", Infinity), T("B", -5), T("C", "99")]) === null, "L9 Infinity·음수·문자열 시각은 «본 적 없음» 이다");
  ok(id(pickLanding([T("A", 0), T("B", 1)])) === "B", "L10 경계 — 가장 작은 양수(1)는 «봤다» 다");
  ok(id(pickLanding([T("A", 7), T("B", 7)])) === "A", "L11 같은 시각이면 앞선 것(안정)");
  {
    const asked = [];
    pickLanding([T("A", 10), T("B", 30), T("C", 20)], (t) => { asked.push(t.id); return true; });
    ok(asked.length > 0 && asked.includes("B"), "L2′ [배선] canLand 가 실제로 불린다", show(asked));
  }

  // ── S — 도장 nextStamp ───────────────────────────────────────────────────
  ok(nextStamp(100, 200) === 200, "S1 시계가 앞서 있으면 지금 시각");
  ok(nextStamp(200, 200) === 201, "S2 같은 ms 에 두 번 옮겨도 도장은 커진다");
  ok(nextStamp(500, 200) === 501, "S3 시계가 뒤로 가도(복원값이 앞서도) 도장은 커진다");
  ok(nextStamp(0, 200) === 200 && nextStamp(NaN, 200) === 200 && nextStamp(undefined, 200) === 200, "S4 이전 도장이 없으면 지금 시각");
  ok(seenValue(5) === 5 && seenValue("5") === 0 && seenValue(null) === 0, "S5 본 시각 읽기 — 숫자만");

  // ── K — 복원 상한 keepRecent ─────────────────────────────────────────────
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const same = (a, b) => show(a) === show(b);
  {
    const twelve = range(1, 12).map((x) => x * 10);
    ok(same(keepRecent(twelve, 11, 12), range(0, 11)), "K1 경계 — 정확히 12개면 전부 남는다");
    const thirteen = [50, 10, 70, 20, 90, 30, 110, 40, 130, 60, 80, 100, 120];   // 가장 작은 값은 번호 1(10)
    const k2 = keepRecent(thirteen, 8, 12);
    ok(k2.length === 12 && !k2.includes(1), "K2 경계 — 13개면 가장 오래 안 본 하나(번호 1)만 빠진다", show(k2));
    ok(same(keepRecent(Array(13).fill(0), 0, 12), [0, ...range(2, 12)]), "K3 옛 저장본(전부 0) — 보던 것 + 나중에 저장된(새로 연) 것이 남는다");
    const k4 = keepRecent(Array(14).fill(0), 13, 12);
    ok(k4.includes(13) && k4.length === 12, "K4 보던 화면은 본 시각이 0 이어도 남는다", show(k4));
    ok(same(k2, [...k2].sort((a, b) => a - b)), "K5 결과는 저장본 순서(오름차순)");
    ok(same(keepRecent([5, 1, 9], -1, 2), [0, 2]) && same(keepRecent([5, 1, 9], 99, 2), [0, 2]), "K6 보던 번호가 범위 밖이면 최근 순서만");
    ok(same(keepRecent([], 0, 12), []), "K7 빈 저장본은 빈 결과");
    ok(same(keepRecent([3, 0, 0, 0], -1, 1), [0]), "K8 본 적 있는 화면은 뒤 번호의 «본 적 없는» 화면보다 늘 먼저 남는다");
  }

  // ── C — 복원 계획 planRestore (엔진이 쓰는 모양 그대로) ──────────────────────
  {
    const keyOf = (r) => r.replace(/\?.*$/, "");
    const sticky = (r) => r !== "#/welcome";
    const rows = [
      { route: "#/s/a", seen: 10 }, { route: "#/welcome" }, null, { route: 7 },
      { route: "#/s/a?x=1", seen: 50 }, { route: "#/s/b", seen: 20 },
    ];
    ok(same(planRestore(rows, 5, 12, keyOf, sticky), [4, 5]),
      "C5 같은 화면 두 줄이면 더 최근에 본 쪽 · 지나가는 화면·깨진 줄은 뺀다", show(planRestore(rows, 5, 12, keyOf, sticky)));
    ok(same(planRestore([{ route: "#/s/a", seen: 90 }, { route: "#/s/a?y", seen: 10 }], 1, 12, keyOf, sticky), [1]),
      "C5′ 같은 화면이면 보던 줄이 본 시각보다 먼저 이긴다");
    const legacy = range(0, 13).map((i) => ({ route: "#/s/t" + i }));
    ok(same(planRestore(legacy, 13, 12, keyOf, sticky), range(2, 13)), "C1 옛 저장본 14줄·보던 것 13 — 오래 연 앞쪽 둘이 빠진다");
    ok(same(planRestore([], 0, 12, keyOf, sticky), []), "C7 빈 저장본");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── W — 셸 배선(main.ts) — 엔진 밖이라 소스로 본다. 엔진 배선은 아래 런타임이 실제로 돌려 본다 ──
{
  const main = code(read("web/v2/main.ts"));
  ok(/canLand:\s*\(tab\)\s*=>\s*tabTargetAlive\(tab\.route\)/.test(main),
    "W4 셸은 «서버가 아는 대상인가»(tabTargetAlive — 좌측 목록 ③ 과 같은 판정)를 착지 조건으로 넘긴다");
  const closeSide = main.slice(main.indexOf("async function closeSideRow"), main.indexOf("async function dismissSessionRow"));
  const dismiss = main.slice(main.indexOf("async function dismissSessionRow"), main.indexOf("function closeRowTabs"));
  ok(/closeRowTabs\(key\)/.test(closeSide) && /closeRowTabs\(key\)/.test(dismiss), "W5 행 닫기 두 자리가 같은 닫기 경로(closeRowTabs)를 탄다");
  ok(!/sideRowKey\(t\.route\)\s*===\s*key\)\s*tabsApi\.close\(t\)/.test(main), "W5′ 행의 창을 배열 순서대로 닫던 옛 반복이 남아 있지 않다");
  const crt = main.slice(main.indexOf("function closeRowTabs"), main.indexOf("function refreshSideNow"));
  ok(/Number\(a === cur\)\s*-\s*Number\(b === cur\)/.test(crt), "W5″ 보고 있는 창을 맨 나중에 닫는다(착지가 곧 닫힐 짝이 되지 않게)");
}

// ── R — 런타임: 진짜 엔진(web/v2/tabs.ts)을 헤드리스 크롬에서 ──────────────────
const CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.log("skip  크롬을 못 찾아 런타임 절(R)을 건너뜁니다(CHROME_BIN 으로 지정)");
  console.log(`\n${pass} passed`);
  process.exit(0);
}

const STUBS = {
  "../core.js": `export { el, sv } from ${JSON.stringify(path.join(root, "web/lib/dom.ts"))}; export function anchoredPopover() { return function () {}; }`,
  "./shell-prefs.js": "export function deviceStore(base) { return base; }",
  "./embed.js": "export const EMBEDDED = false;",
};
const bundled = await build({
  stdin: { contents: "import { createTabs } from './tabs.ts'; window.__T = { createTabs };", resolveDir: path.join(root, "web/v2"), loader: "ts" },
  bundle: true, format: "iife", write: false, logLevel: "silent",
  plugins: [{
    name: "shell-stubs",
    setup(b) {
      b.onResolve({ filter: /^(\.\.\/core|\.\/shell-prefs|\.\/embed)\.js$/ }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js", resolveDir: root }));
    },
  }],
});
const BUNDLE = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

//  시나리오는 페이지 안에서 **동기로** 돈다 — 엔진은 동기이고, localStorage 는 시나리오마다 새로 심는다.
const SCENARIOS = String.raw`
var KEY = 'lively_v2_tabs';
function mk(seed) {
  if (seed === undefined) localStorage.removeItem(KEY); else if (seed !== null) localStorage.setItem(KEY, JSON.stringify(seed));
  var center = document.createElement('div'), aside = document.createElement('div');
  document.body.append(center, aside);
  var log = { activated: [], closed: [], landAsked: 0 };
  var api = __T.createTabs(center, aside, {
    titleFor: function (r) { return { title: r, noAside: false }; },
    onActivate: function (t) { log.activated.push(t.route); },
    onClose: function (t) { log.closed.push(t.route); },
    canLand: function (t) { log.landAsked++; return t.route.indexOf('ghost') < 0; },
  });
  api.log = log;
  return api;
}
function cur(api) { var c = api.current(); return c ? c.route : null; }
function routes(api) { return api.tabs.map(function (t) { return t.route; }); }
function saved() { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
var R = {};

// R1 — 세 화면을 열고 첫 화면으로 돌아간 뒤 그걸 닫는다. 옆 칸은 b, 바로 전에 보던 것은 c.
(function () {
  var api = mk();
  var a = api.add('#/s/a'); api.add('#/s/b'); api.add('#/s/c');
  api.activate(a);
  api.close(a);
  R.R1 = { cur: cur(api), routes: routes(api) };
})();

// R2 — 신고 재현: 닫힐 탭의 옆 칸에 서버가 모르는 옛 세션(유령). 바로 전에 보던 건 prev.
(function () {
  var api = mk({ tabs: [
    { route: '#/s/box-0bfd8541', title: 'x', seen: 300 },
    { route: '#/s/box-ghost-034ec402', title: 'old', seen: 250 },
    { route: '#/s/box-prev', title: 'p', seen: 200 },
  ], active: 0 });
  var c = api.active();
  var asked0 = api.log.landAsked;
  api.close(c);
  R.R2 = { start: c.route, cur: cur(api), landAsked: api.log.landAsked - asked0, activated: api.log.activated };
})();

// R3 — 옛 저장본(본 시각 없음): 복원만 된 탭은 «돌아갈 곳» 이 아니다 → 홈.
(function () {
  var api = mk({ tabs: [{ route: '#/s/old1', title: '1' }, { route: '#/s/old2', title: '2' }, { route: '#/s/cur', title: 'c' }], active: 2 });
  var c = api.active();
  api.close(c);
  R.R3 = { start: c.route, cur: cur(api), routes: routes(api) };
})();

// R4 — 최근 순서가 새로고침을 넘는다: a·b·c 를 열고 a 로 돌아간 뒤, 엔진을 새로 만들어(새로고침) a 를 닫는다.
(function () {
  var api1 = mk();
  var a = api1.add('#/s/a'); api1.add('#/s/b'); api1.add('#/s/c');
  api1.activate(a);
  var s = saved();
  var api2 = mk(null);                       // 저장본을 그대로 둔 채 다시 만든다
  var c = api2.active();
  api2.close(c);
  R.R4 = { savedSeen: s.tabs.map(function (t) { return t.seen || 0; }), savedActive: s.active, start: c.route, cur: cur(api2) };
})();

// R5 — 상한: 옛 저장본 14줄, 보던 것은 마지막(13). 앞쪽(가장 오래 연) 둘이 빠지고 보던 화면으로 선다.
(function () {
  var tabs = []; for (var i = 0; i < 14; i++) tabs.push({ route: '#/s/t' + i, title: 't' + i });
  var api = mk({ tabs: tabs, active: 13 });
  R.R5 = { routes: routes(api), initial: api.initial() && api.initial().route };
})();

// R6 — 같은 화면 두 줄: 더 최근에 본 쪽이 남는다.
(function () {
  var api = mk({ tabs: [{ route: '#/s/a', title: 'old', seen: 10 }, { route: '#/s/a?x=1', title: 'new', seen: 50 }, { route: '#/s/b', title: 'b', seen: 20 }], active: 2 });
  R.R6 = { routes: routes(api) };
})();

// R7 — 갈 곳이 없으면 이미 있는 빈 홈을 쓴다(빈 홈을 하나 더 쌓지 않는다).
(function () {
  var api = mk();
  var h = api.add('#/', { activate: false });
  var x = api.add('#/s/x');
  api.close(x);
  R.R7 = { cur: cur(api), same: api.current() === h, count: api.tabs.length };
})();

// R8 — 쓰다 만 지시가 있는 홈은 «빈 홈» 이 아니다 → 새 홈을 연다.
(function () {
  var api = mk();
  var h = api.add('#/', { activate: false });
  h.draft = '쓰다 만 지시';
  var x = api.add('#/s/x');
  api.close(x);
  R.R8 = { cur: cur(api), same: api.current() === h, count: api.tabs.length };
})();

// R9 — 보고 있지 않은 화면을 닫으면 지금 화면은 그대로다.
(function () {
  var api = mk();
  var a = api.add('#/s/a'); api.add('#/s/b');
  var before = api.log.activated.length;
  api.close(a);
  R.R9 = { cur: cur(api), activatedAfter: api.log.activated.length - before };
})();

// R10 — 도장은 저장되고, 복원된 값이 시계보다 앞서 있어도 새 도장이 더 크다.
(function () {
  var far = Date.now() + 1e9;
  var api = mk({ tabs: [{ route: '#/s/a', title: 'a', seen: far }, { route: '#/s/b', title: 'b' }], active: 0 });
  api.active();
  api.activate(api.tabs[1]);
  var s = saved();
  R.R10 = { far: far, seen: s.tabs.map(function (t) { return t.seen || 0; }), active: s.active };
})();
`;

const PAGE = `<!doctype html><meta charset="utf-8"><pre id="out">PENDING</pre>
<script>${BUNDLE}</script>
<script>
(function () {
  var out = document.getElementById('out');
  try {
${SCENARIOS}
    out.textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
  } catch (e) {
    out.textContent = 'RESULT' + JSON.stringify({ CRASH: String((e && e.stack) || e) }) + 'ENDRESULT';
  }
})();
</script>`;

const dir = mkdtempSync(path.join(tmpdir(), "tab-landing-rt-"));
let R, child = null;
try {
  writeFileSync(path.join(dir, "page.html"), PAGE);
  //  크롬은 결과 표지가 stdout 에 보이는 순간 끊는다 — 종료를 기다리면 매달리는 판이 있다(ctx-rclick-runtime 실측).
  const dom = await new Promise((resolve, reject) => {
    child = spawn(chrome, [
      "--headless=old", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--disable-default-apps", "--disable-extensions", "--metrics-recording-only", "--mute-audio",
      "--disable-client-side-phishing-detection", "--no-pings", "--disable-domain-reliability",
      "--disable-breakpad", "--disable-crash-reporter",
      `--user-data-dir=${path.join(dir, "profile")}`,   // ⚠ temp 프로필 — 실 HOME 을 건드리지 않는다
      "--timeout=20000", "--virtual-time-budget=5000", "--dump-dom", `file://${path.join(dir, "page.html")}`,
    ], { env: { ...process.env, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errOut = "", settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch (_) {} fn(v); };
    const timer = setTimeout(() => done(reject, new Error("크롬이 30초 안에 결과를 안 냈다\n" + errOut.slice(0, 800))), 30_000);
    child.stdout.on("data", (b) => { out += b; if (out.includes("ENDRESULT")) done(resolve, out); });
    child.stderr.on("data", (b) => { errOut += b; });
    child.on("error", (e) => done(reject, e));
    child.on("close", () => done(resolve, out));
  });
  const m = dom.match(/RESULT(\{.*?\})ENDRESULT/s);
  ok(!!m, "R0 [배선] 크롬이 시나리오를 끝까지 돌려 결과를 냈다");
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  R = JSON.parse(unesc(m[1]));
} finally {
  //  ⚠ SIGKILL 뒤에도 크롬이 프로필에 잠깐 더 쓴다 — 곧바로 지우면 ENOTEMPTY 로 **단언을 하나도 안 돈 채** 죽는다(실측).
  //   끝나기를 잠깐 기다리고, 지우기는 재시도하고, 그래도 안 되면 알리기만 한다(임시 디렉터리다).
  if (child && child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once("close", r); setTimeout(r, 3000); });
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (e) { console.log(`note  임시 디렉터리를 못 지웠습니다(${e.code}) — ${dir}`); }
}
ok(!R.CRASH, "R0′ [배선] 엔진이 페이지 안에서 죽지 않았다", R.CRASH);
if (process.env.TAB_LANDING_DEBUG) console.log("DBG", show(R));

ok(R.R1.cur === "#/s/c", "R1 P1·P5 바로 전에 보던 화면(c)으로 간다 — 배열의 옆 칸(b)이 아니다", show(R.R1));
ok(R.R2.start === "#/s/box-0bfd8541" && R.R2.cur === "#/s/box-prev",
  "R2 P3 [신고 재현] 옆 칸의 유령 탭(서버가 모르는 세션)이 아니라 바로 전에 보던 세션으로 간다", show(R.R2));
ok(R.R2.landAsked > 0, "R2′ [배선] 엔진이 셸의 canLand 를 실제로 묻는다", show(R.R2));
ok(R.R3.start === "#/s/cur" && R.R3.cur === "#/" && R.R3.routes.length === 3 && !R.R3.routes.includes("#/s/cur"),
  "R3 P2·P4 본 기록이 없는 옛 탭으로는 안 간다 — 홈으로", show(R.R3));
ok(R.R4.savedSeen.every((v) => v > 0) && R.R4.start === "#/s/a" && R.R4.cur === "#/s/c",
  "R4 R2(사양) 최근 순서가 저장본에 실려 새로고침을 넘는다", show(R.R4));
ok(show(R.R5.routes) === show(Array.from({ length: 12 }, (_, i) => "#/s/t" + (i + 2))) && R.R5.initial === "#/s/t13",
  "R5 C1 상한 — 가장 오래 연 앞쪽 탭이 빠지고 보던 화면이 남는다", show(R.R5));
ok(show(R.R6.routes) === show(["#/s/a?x=1", "#/s/b"]), "R6 C5 같은 화면 두 줄이면 더 최근에 본 쪽이 남는다", show(R.R6));
ok(R.R7.cur === "#/" && R.R7.same === true && R.R7.count === 1, "R7 P4 갈 곳이 없으면 이미 있는 빈 홈을 쓴다", show(R.R7));
ok(R.R8.cur === "#/" && R.R8.same === false && R.R8.count === 2, "R8 P4 쓰다 만 지시가 있는 홈은 덮지 않고 새 홈을 연다", show(R.R8));
ok(R.R9.cur === "#/s/b" && R.R9.activatedAfter === 0, "R9 P6 보고 있지 않은 화면을 닫으면 지금 화면은 그대로다", show(R.R9));
ok(R.R10.active === 1 && R.R10.seen[0] > R.R10.far && R.R10.seen[1] > R.R10.seen[0],
  "R10 R1·R3 도장은 저장본에 실리고, 복원값이 시계보다 앞서도 새로 들어온 화면의 도장이 더 크다", show(R.R10));

console.log(`\n${pass} passed`);
