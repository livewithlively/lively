// #3870 — 트랙패드 두 손가락 확대(pinch)가 셸 격자를 창 밖으로 밀던 것.
//  원준 2026-10-08: «야 지금 화면이 우측과 하단이 잘려서 보여» · «새로고침해도 그대로임» — 사파리 한 탭이 1.04배로
//   확대돼 있었다(스크린샷 실측: 워크스페이스 타일 36 → 37.3 · 레일 76 → 79). 두 손가락을 오므리자 풀렸다.
//
//  엣지 표(행마다 시험 하나) — 규칙은 두 사본이 같은 표를 지나야 한다:
//   web/lib/pinch-guard.ts(셸 · 액자 안 화면) · web/standalone/pinch-guard.ts(터미널 번들 사본)
//
//  | #   | 맨 위 창 배율                    | 이 창 배율 | 제스처를 끊는다                 |
//  |-----|----------------------------------|------------|---------------------------------|
//  | G1  | 1                                | 1          | 예(확대가 시작되지 않게)        |
//  | G2  | 1.04(이번 신고)                  | 1          | 아니오(오므려 되돌릴 수 있게)   |
//  | G3  | 1.005(반올림 오차)               | 1          | 예                              |
//  | G4  | 1.01(경계)                       | 1          | 예                              |
//  | G5  | 닿을 수 없다(다른 출처 — 던진다) | 1          | 예                              |
//  | G6  | 닿을 수 없다                     | 2          | 아니오(이 창 값으로)            |
//  | G7  | visualViewport 없음              | 없음       | 예(모르면 1 로 본다)            |
//  | G8  | NaN                              | 1          | 예                              |
//  | G9  | 3                                | 1          | 아니오                          |
//
//  설치(가짜 window) — 행동으로 본다:
//   I1 gesturestart · gesturechange 둘에 건다 · 캡처 단계 · passive 아님(passive 면 preventDefault 가 무시된다)
//   I2 wheel 에는 걸지 않는다(창 전체의 passive 아닌 wheel 은 모든 스크롤을 메인 스레드에 묶는다)
//   I3 두 번 불러도 한 벌만 건다
//   I4 배율은 제스처가 올 때마다 다시 읽는다(걸 때 값으로 굳지 않는다)
//   I5 window 가 없으면 던지지 않는다
//  앱 화면 주입 문자열(web/v2/app-ui-runtime.ts) — vm 에서 실제로 돌린다:
//   A1 gesturestart · gesturechange 를 캡처 · passive 아님으로 걸고 늘 끊는다(바깥 배율을 못 읽는다)
//  배선 — 구문 트리의 import · 호출 관계로 본다:
//   W1 본 화면(web/main.ts)이 lib/pinch-guard 의 installPinchGuard 를 맨 바깥에서 부른다(셸 · 액자 · 로그인 전 모두)
//   W2 터미널(web/standalone/terminal.ts)의 boot 가 사본의 installPinchGuard 를 부른다
//
//  fail-first: PINCH_GUARD_SRC=<변이 파일> 로 규칙 · 설치 시험을 변이에 돌린다(아래 «변이» 는 2026-10-08 실측) —
//   늘 끊는 변이 · passive:true 변이 · wheel 을 거는 변이 · 표식 없는 변이 · 이 창 배율만 읽는 변이.
//   고치기 전 main 은 모듈이 없어 시험이 뜨지 않고, 배선 W1 · W2 · A1 은 고치기 전 세 파일에서 빨갛다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const SRC_ROOT = process.env.PINCH_GUARD_ROOT || root;   // fail-first: 고치기 전 소스 나무를 가리킨다
const read = (rel) => readFileSync(path.isAbsolute(rel) ? rel : path.join(SRC_ROOT, rel), "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "pinch-guard-"));
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond === true) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}
function emitTs(srcText, outName) {
  const js = ts.transpileModule(srcText, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const out = path.join(tmp, outName);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, js);
  return out;
}
const load = async (file) => import(pathToFileURL(file).href);

/** 가짜 창 — top: 숫자면 그 배율의 맨 위 창, 'throw' 면 닿을 수 없는 맨 위 창, undefined 면 visualViewport 없는 맨 위 창. */
function fakeWin({ top, own }) {
  const listeners = [];
  const win = { addEventListener: (t, fn, opt) => listeners.push({ t, fn, opt }) };
  if (own !== undefined) win.visualViewport = { scale: own };
  const state = { top };
  Object.defineProperty(win, "top", {
    get() {
      if (state.top === "throw") throw new Error("SecurityError");
      return state.top === undefined ? {} : { visualViewport: { scale: state.top } };
    },
  });
  return { win, listeners, state };
}
function fire(listeners, type) {
  let prevented = false;
  for (const l of listeners) if (l.t === type) l.fn({ type, preventDefault() { prevented = true; } });
  return prevented;
}

const T = [
  ["G1 배율 1", { top: 1, own: 1 }, true],
  ["G2 맨 위 창 1.04(이번 신고)", { top: 1.04, own: 1 }, false],
  ["G3 1.005(반올림 오차)", { top: 1.005, own: 1 }, true],
  ["G4 1.01(경계)", { top: 1.01, own: 1 }, true],
  ["G5 맨 위 창에 닿을 수 없다 · 이 창 1", { top: "throw", own: 1 }, true],
  ["G6 맨 위 창에 닿을 수 없다 · 이 창 2", { top: "throw", own: 2 }, false],
  ["G7 visualViewport 없음", { top: undefined, own: undefined }, true],
  ["G8 NaN", { top: NaN, own: 1 }, true],
  ["G9 맨 위 창 3", { top: 3, own: 1 }, false],
];

const SRCS = [
  ["정본", process.env.PINCH_GUARD_SRC || "web/lib/pinch-guard.ts"],
  ["터미널 번들 사본", process.env.PINCH_GUARD_SRC || "web/standalone/pinch-guard.ts"],
];
let n = 0;
for (const [who, src] of SRCS) {
  let mod = null;
  try { mod = await load(emitTs(read(src), `m${n++}/pinch-guard.js`)); } catch (e) { ok(false, `${who} — 모듈을 싣는다(${src})`, String(e.message || e)); continue; }
  for (const [name, w, blocks] of T) {
    const f = fakeWin(w);
    mod.installPinchGuard(f.win);
    const a = fire(f.listeners, "gesturestart"), b = fire(f.listeners, "gesturechange");
    ok(f.listeners.length > 0 && a === blocks && b === blocks, `${name} — ${who}: ${blocks ? "끊는다" : "그대로 둔다"}`, JSON.stringify({ listeners: f.listeners.length, gesturestart: a, gesturechange: b }));
  }
  {
    const f = fakeWin({ top: 1, own: 1 });
    mod.installPinchGuard(f.win);
    const g = f.listeners.filter((l) => l.t === "gesturestart" || l.t === "gesturechange");
    ok(g.length === 2 && new Set(g.map((l) => l.t)).size === 2 && g.every((l) => l.opt && l.opt.capture === true && l.opt.passive === false),
      `I1 ${who} — gesturestart · gesturechange 에 캡처 · passive 아님으로 건다`, JSON.stringify(f.listeners.map((l) => [l.t, l.opt])));
    ok(f.listeners.length > 0 && !f.listeners.some((l) => l.t === "wheel" || l.t === "mousewheel"), `I2 ${who} — wheel 에는 걸지 않는다`);
    const first = f.listeners.length;
    mod.installPinchGuard(f.win);
    ok(first === 2 && f.listeners.length === 2, `I3 ${who} — 두 번 불러도 한 벌만 건다`, `${first} → ${f.listeners.length}`);
    const before = fire(f.listeners, "gesturestart");
    f.state.top = 1.3;
    const zoomed = fire(f.listeners, "gesturestart");
    f.state.top = 1;
    const back = fire(f.listeners, "gesturestart");
    ok(before === true && zoomed === false && back === true, `I4 ${who} — 배율은 제스처마다 다시 읽는다`, JSON.stringify({ before, zoomed, back }));
    let threw = "";
    try { mod.installPinchGuard(null); } catch (e) { threw = String(e); }
    ok(threw === "", `I5 ${who} — window 가 없으면 던지지 않는다`, threw);
  }
}

// ── 앱 화면 주입 문자열(A1) ──
{
  const rt = await load(emitTs(read("web/v2/app-ui-runtime.ts"), "v2/app-ui-runtime.js"));
  const listeners = [];
  const win = { addEventListener: (t, fn, opt) => listeners.push({ t, fn, opt }) };
  const ctx = vm.createContext({ window: win, parent: { postMessage() {} }, setTimeout, Promise, Error, Object, String });
  vm.runInContext(rt.APP_RUNTIME_JS, ctx);
  const g = listeners.filter((l) => l.t === "gesturestart" || l.t === "gesturechange");
  ok(listeners.length > 0 && g.length === 2 && new Set(g.map((l) => l.t)).size === 2 && g.every((l) => l.opt && l.opt.capture === true && l.opt.passive === false)
    && fire(listeners, "gesturestart") === true && fire(listeners, "gesturechange") === true,
    "A1 앱 화면 — gesturestart · gesturechange 를 캡처 · passive 아님으로 걸고 늘 끊는다", JSON.stringify({ all: listeners.length, g: g.map((l) => [l.t, l.opt]) }));
  ok(listeners.length > 0 && !listeners.some((l) => l.t === "wheel"), "A1 앱 화면 — wheel 에는 걸지 않는다(다른 리스너는 실제로 걸렸다)");
}

// ── 배선(W) ──
{
  const sf = (rel) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.ES2022, true);
  const importsName = (s, name, from) => s.statements.some((st) => ts.isImportDeclaration(st) && from.test(st.moduleSpecifier.text)
    && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)
    && st.importClause.namedBindings.elements.some((e) => e.name.text === name));
  const isCall = (n, name) => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === name;
  const m = sf("web/main.ts");
  ok(importsName(m, "installPinchGuard", /^\.\/lib\/pinch-guard\.js$/) && m.statements.some((st) => isCall(st, "installPinchGuard")),
    "W1 본 화면 — lib/pinch-guard 의 installPinchGuard 를 맨 바깥에서 부른다(어느 갈래로 뜨든)");
  const t = sf("web/standalone/terminal.ts");
  const boot = t.statements.find((st) => ts.isFunctionDeclaration(st) && st.name?.text === "boot");
  ok(importsName(t, "installPinchGuard", /^\.\/pinch-guard\.js$/) && !!boot && boot.body.statements.some((st) => isCall(st, "installPinchGuard")),
    "W2 터미널 — boot 가 번들 사본의 installPinchGuard 를 부른다");
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} failed`);
