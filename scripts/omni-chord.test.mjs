// #4530 — 통합검색(⌘K)을 여는 키 판정과, 액자(클래식 ?embed=1)·앱 화면 안에서 그 키를 셸로 넘기는 다리.
//  원준 2026-10-01: «너가 얘기한 문제 다 좀 고쳐» — 점검 1번(화면 안을 누르면 ⌘K 가 안 먹는다) · 3번(한글 입력 상태 ⌘K) ·
//   5번(액자 안 우클릭 «검색» 이 무반응) · 2번(지식 문서 안에서는 다른 검색이 뜬다).
//
//  엣지 표(행마다 시험 하나) — 판정은 세 사본이 같은 표를 지나야 한다:
//   web/lib/omni-chord.ts(셸·액자) · web/standalone/omni-chord.ts(터미널 번들 사본) · web/v2/app-ui-runtime.ts(앱 화면 주입 문자열)
//
//  | #   | 키                                         | 연다   | 터미널이 넘긴다   |
//  |-----|--------------------------------------------|--------|-------------------|
//  | C1  | ⌘K (맥)                                     | 예     | 예                |
//  | C2  | Ctrl+K                                      | 예     | 아니오(kill-line) |
//  | C3  | Alt+K (윈도우·리눅스)                        | 예     | 예                |
//  | C4  | 맥 Option+K — key '˚' · code KeyK           | 예     | 예                |
//  | C5  | 한글 입력 ⌘K — key 'ㅏ' · code KeyK          | 예     | 예                |
//  | C6  | 한글 입력 Ctrl+K — key 'ㅏ'                  | 예     | 아니오            |
//  | C7  | 입력기 처리 중 Ctrl+K — key 'Process'        | 예     | 아니오            |
//  | C8  | ⌘⇧K (다른 단축키)                            | 아니오 | 아니오            |
//  | C9  | Alt+Shift+K                                 | 아니오 | 아니오            |
//  | C10 | K 단독                                      | 아니오 | 아니오            |
//  | C11 | 조합 중 K 단독(key 'ㅏ', isComposing)         | 아니오 | 아니오            |
//  | C12 | 조합 중 ⌘K(key 'Process', isComposing)       | 예     | 예                |
//  | C13 | 드보락 ⌘K — 글자 k · 자리 KeyV                | 예     | 예                |
//  | C14 | 드보락 ⌘+(자리 KeyK 의 글자 t)                | 아니오 | 아니오            |
//  | C15 | Alt+⌘+K                                     | 아니오 | 아니오            |
//  | C16 | 합성 이벤트(code 없음) Ctrl+'K'              | 예     | 아니오            |
//  | C17 | key '' · code 없음 + ⌘(빈 입력)               | 아니오 | 아니오            |
//
//  다리(v2/omni-frame.ts) — 행동으로 본다(가짜 window):
//   F1 끼워 넣은 판 + 부모가 있으면 ⌘K 를 캡처 단계에서 받아 셸에 부탁하고, 기본 동작·전파를 끊는다
//   F2 한글 입력 ⌘K(key 'ㅏ')도 넘긴다
//   F3 판정 밖의 키(K 단독)는 건드리지 않는다
//   F4 셸이 닫았다고 알리면 누르기 직전 초점 칸으로 돌아간다 · 다른 오리진·다른 창의 같은 신호는 무시한다
//   F5 끼워 넣은 판이 아니면(단독 탭) 아무것도 달지 않는다
//   F6 기억한 칸 없이 닫힘 신호가 와도 던지지 않고 아무 칸에도 초점을 주지 않는다
//   F7 끼워 넣은 판이라도 부모가 자기 자신(최상위 창)이면 아무것도 달지 않는다
//  배선 — 소스 글자가 아니라 구문 트리의 import·호출 관계로 본다:
//   W1 클래식 부팅(web/main.ts)이 installOmniForwarder 를 import 해서 부른다
//   W2 위키 전용 ⌘K(web/wiki-doc.ts)가 omniFrameActive() 로 액자에서 비키고, 판정은 isKKey(자판 위치)를 쓴다
//   W3 우클릭 메뉴(web/v2/ctx-shell.ts)의 검색 줄은 openSearch 를 부르고, openSearch 는 훅이 없으면 forwardOmniToShell 로 간다
//   W4 터미널(web/standalone/terminal.ts)이 isTerminalOmniChord 로 판정한다
//   W5 앱 화면 다리(web/v2/app-ui.ts)가 ui/omniOpen 을 받아 셸 신호(lively-omni-open)로 넘긴다(omni.ts 를 들이지 않는다)
//  앱 화면 주입 문자열 — vm 에서 실제로 돌린다:
//   A1 표의 «연다» 열과 같이 parent.postMessage({method:'ui/omniOpen'}) 를 보낸다(id 없는 알림) · 기본 동작을 끊는다
//
//  fail-first: OMNI_CHORD_SRC=<옛 판정 파일> 로 판정 표를 옛 규칙(e.key === 'k' 만 보는 것)에 돌리면 셸 판정은 C4·C5·C6·C7·C9·C12,
//   터미널 판정은 C4·C5·C8·C9·C12·C15 가 빨갛다(2026-10-01 실측).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.isAbsolute(rel) ? rel : path.join(root, rel), "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "omni-chord-"));
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? "\n  " + detail : ""}`); } };
function emitTs(srcText, outName) {
  const js = ts.transpileModule(srcText, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const out = path.join(tmp, outName);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, js);
  return out;
}
const load = async (file) => import(pathToFileURL(file).href);
const safe = (fn) => { try { return fn(); } catch (e) { return "THREW " + e; } };
//  판정은 참·거짓으로 본다(옛 판정은 undefined 를 돌려주기도 했다 — 값의 모양이 아니라 «열리나» 가 사양이다). 던지면 그 글을 돌려 빨갛게.
const yes = (fn) => { const r = safe(fn); return typeof r === "string" ? r : !!r; };

// ── 판정 표 ──
const T = [
  ["C1 ⌘K", { key: "k", code: "KeyK", metaKey: true }, true, true],
  ["C2 Ctrl+K", { key: "k", code: "KeyK", ctrlKey: true }, true, false],
  ["C3 Alt+K", { key: "k", code: "KeyK", altKey: true }, true, true],
  ["C4 맥 Option+K('˚')", { key: "˚", code: "KeyK", altKey: true }, true, true],
  ["C5 한글 ⌘K('ㅏ')", { key: "ㅏ", code: "KeyK", metaKey: true }, true, true],
  ["C6 한글 Ctrl+K('ㅏ')", { key: "ㅏ", code: "KeyK", ctrlKey: true }, true, false],
  ["C7 입력기 Process Ctrl+K", { key: "Process", code: "KeyK", ctrlKey: true }, true, false],
  ["C8 ⌘⇧K", { key: "K", code: "KeyK", metaKey: true, shiftKey: true }, false, false],
  ["C9 Alt+Shift+K", { key: "K", code: "KeyK", altKey: true, shiftKey: true }, false, false],
  ["C10 K 단독", { key: "k", code: "KeyK" }, false, false],
  ["C11 조합 중 K 단독", { key: "ㅏ", code: "KeyK", isComposing: true }, false, false],
  ["C12 조합 중 ⌘K", { key: "Process", code: "KeyK", metaKey: true, isComposing: true }, true, true],
  ["C13 드보락 ⌘K(글자 k · 자리 KeyV)", { key: "k", code: "KeyV", metaKey: true }, true, true],
  ["C14 드보락 ⌘+자리 KeyK 의 글자 t", { key: "t", code: "KeyK", metaKey: true }, false, false],
  ["C15 Alt+⌘+K", { key: "k", code: "KeyK", altKey: true, metaKey: true }, false, false],
  ["C16 합성 이벤트(code 없음) Ctrl+'K'", { key: "K", ctrlKey: true }, true, false],
  ["C17 빈 입력(key '' · code 없음) + ⌘", { key: "", metaKey: true }, false, false],
];

const LIB_SRC = process.env.OMNI_CHORD_SRC || "web/lib/omni-chord.ts";
const lib = await load(emitTs(read(LIB_SRC), "lib/omni-chord.js"));
const copy = await load(emitTs(read("web/standalone/omni-chord.ts"), "standalone/omni-chord.js"));
for (const [name, e, open, term] of T) {
  ok(yes(() => lib.isOmniChordLike(e)) === open, `${name} — 셸·액자 판정 ${open ? "연다" : "안 연다"}`);
  ok(yes(() => lib.isTerminalOmniChord(e)) === term, `${name} — 터미널 판정 ${term ? "넘긴다" : "안 넘긴다"}`);
  ok(yes(() => copy.isOmniChordLike(e)) === open && yes(() => copy.isTerminalOmniChord(e)) === term, `${name} — 터미널 번들 사본이 정본과 같다`);
}
ok(safe(() => lib.omniKeyHint(true)) === "⌘K" && safe(() => lib.omniKeyHint(false)) === "Alt K", "H1 단축키 이름 — 맥 ⌘K · 그 밖 Alt K(사이드바 검색 단추와 같은 이름)");

// ── 앱 화면 주입 문자열(A1) ──
{
  const rt = await load(emitTs(read("web/v2/app-ui-runtime.ts"), "v2/app-ui-runtime.js"));
  for (const [name, e, open] of T) {
    const posted = [];
    const keydown = [];
    const win = { addEventListener: (t, fn, cap) => { if (t === "keydown") keydown.push({ fn, cap }); } };
    const ctx = vm.createContext({ window: win, parent: { postMessage: (m) => posted.push(m) }, setTimeout, Promise, Error, Object, String });
    vm.runInContext(rt.APP_RUNTIME_JS, ctx);
    let prevented = false;
    const ev = { ...e, preventDefault() { prevented = true; }, stopPropagation() {} };
    for (const k of keydown) k.fn(ev);
    const sent = posted.filter((m) => m && m.method === "ui/omniOpen");
    ok(keydown.length === 1 && keydown[0].cap === true && (sent.length === 1) === open && prevented === open && sent.every((m) => m.id === undefined),
      `A1 ${name} — 앱 화면 안 키가 ${open ? "셸에 ui/omniOpen 알림을 보내고 기본 동작을 끊는다" : "그대로 간다"}`,
      JSON.stringify({ listeners: keydown.length, sent: sent.length, prevented }));
  }
}

// ── 다리(v2/omni-frame.ts) — 행동 ──
async function loadFrame({ embedded, topLevel = false }) {
  const dir = path.join(tmp, "frame-" + Math.random().toString(36).slice(2));
  mkdirSync(path.join(dir, "v2"), { recursive: true });
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  writeFileSync(path.join(dir, "lib/omni-chord.js"), readFileSync(path.join(tmp, "lib/omni-chord.js"), "utf8"));
  writeFileSync(path.join(dir, "v2/omni.js"),
    "export const OMNI_CLOSED_MSG = 'lively-omni-closed';\nexport const calls = [];\nexport function requestOmniFromParent(seed) { calls.push(seed); return true; }\n");
  writeFileSync(path.join(dir, "v2/embed.js"), `export const EMBEDDED = ${embedded ? "true" : "false"};\n`);
  writeFileSync(path.join(dir, "v2/omni-frame.js"),
    ts.transpileModule(read("web/v2/omni-frame.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  const listeners = [];
  let focused = null;
  const input = { isConnected: true, focus() { focused = this; } };
  const win = { focus() {}, addEventListener: (t, fn, cap) => listeners.push({ t, fn, cap: !!cap }) };
  const parentWin = topLevel ? win : { name: "parent" };
  win.parent = parentWin;
  globalThis.window = win;
  globalThis.document = { body: { tag: "body" }, activeElement: input };
  globalThis.location = { origin: "https://x" };
  const mod = await load(path.join(dir, "v2/omni-frame.js"));
  const omni = await load(path.join(dir, "v2/omni.js"));
  return { mod, omni, listeners, parentWin, input, focused: () => focused, setFocused: (v) => { focused = v; } };
}
const mkEv = (e) => { const st = { prevented: false, stopped: false }; return { ev: { ...e, preventDefault() { st.prevented = true; }, stopPropagation() { st.stopped = true; } }, st }; };
{
  const f = await loadFrame({ embedded: true });
  f.mod.installOmniForwarder();
  f.mod.installOmniForwarder();   // 두 번 불러도 한 벌
  const kd = f.listeners.filter((l) => l.t === "keydown");
  ok(kd.length === 1 && kd[0].cap === true, "F1 끼워 넣은 판이면 keydown 을 window 캡처 단계에 한 번 단다");
  let x = mkEv({ key: "k", code: "KeyK", metaKey: true });
  kd[0]?.fn(x.ev);
  ok(f.omni.calls.length === 1 && x.st.prevented && x.st.stopped, "F1 ⌘K 를 받아 셸에 부탁하고 기본 동작·전파를 끊는다(위키 전용 ⌘K 까지 안 간다)");
  x = mkEv({ key: "ㅏ", code: "KeyK", metaKey: true });
  kd[0]?.fn(x.ev);
  ok(f.omni.calls.length === 2 && x.st.prevented, "F2 한글 입력 ⌘K('ㅏ')도 넘긴다");
  const before = f.omni.calls.length;
  x = mkEv({ key: "k", code: "KeyK" });
  kd[0]?.fn(x.ev);
  ok(f.omni.calls.length === before && !x.st.prevented && !x.st.stopped, "F3 판정 밖의 키(K 단독)는 건드리지 않는다");
  const msg = f.listeners.find((l) => l.t === "message");
  f.setFocused(null);
  safe(() => msg.fn({ origin: "https://evil", source: f.parentWin, data: { type: "lively-omni-closed" } }));
  safe(() => msg.fn({ origin: "https://x", source: { name: "other" }, data: { type: "lively-omni-closed" } }));
  ok(!!msg && f.focused() === null, "F4 다른 오리진·다른 창이 보낸 닫힘 신호는 무시한다");
  safe(() => msg.fn({ origin: "https://x", source: f.parentWin, data: { type: "lively-omni-closed" } }));
  ok(f.focused() === f.input, "F4 셸이 닫았다고 알리면 누르기 직전의 입력칸으로 초점이 돌아간다");
  f.setFocused(null);
  const r = safe(() => msg.fn({ origin: "https://x", source: f.parentWin, data: { type: "lively-omni-closed" } }));
  ok(typeof r !== "string" && f.focused() === null, "F6 기억한 칸 없이 닫힘 신호가 와도 던지지 않고 초점을 주지 않는다", String(r));
}
{
  const f = await loadFrame({ embedded: false });
  f.mod.installOmniForwarder();
  ok(f.listeners.length === 0, "F5 끼워 넣은 판이 아니면(단독 탭) 아무것도 달지 않는다");
}
{
  const f = await loadFrame({ embedded: true, topLevel: true });
  f.mod.installOmniForwarder();
  ok(f.listeners.length === 0, "F7 부모가 자기 자신(최상위 창)이면 아무것도 달지 않는다");
}

// ── 배선(구문 트리) ──
function sf(rel) { return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.ES2022, true); }
function importsName(src, name, fromRe) {
  return src.statements.some((s) => ts.isImportDeclaration(s) && fromRe.test(s.moduleSpecifier.text)
    && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some((e) => e.name.text === name));
}
function calls(node, name) {
  let hit = false;
  const visit = (n) => { if (hit) return; if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) { hit = true; return; } ts.forEachChild(n, visit); };
  visit(node);
  return hit;
}
/** obj.name(...) 꼴의 부름이 있나(window.postMessage 같은 것). */
function callsMember(node, name) {
  let hit = false;
  const visit = (n) => { if (hit) return; if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name) { hit = true; return; } ts.forEachChild(n, visit); };
  visit(node);
  return hit;
}
function findFn(src, name) {
  let f = null;
  const visit = (n) => { if (f) return; if (ts.isFunctionDeclaration(n) && n.name?.text === name) { f = n; return; } ts.forEachChild(n, visit); };
  visit(src);
  return f;
}
function stringLiteralIn(node, text) {
  let hit = false;
  const visit = (n) => { if (hit) return; if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === text) { hit = true; return; } ts.forEachChild(n, visit); };
  visit(node);
  return hit;
}
{
  const m = sf("web/main.ts");
  ok(importsName(m, "installOmniForwarder", /\/v2\/omni-frame\.js$/) && calls(m, "installOmniForwarder"), "W1 클래식 부팅이 installOmniForwarder 를 import 해서 부른다");
  const w = sf("web/wiki-doc.ts");
  let wikiListener = null;
  const visit = (n) => {
    if (wikiListener) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "addEventListener"
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "document"
      && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "keydown"
      && calls(n, "openWikiSearch")) { wikiListener = n; return; }
    ts.forEachChild(n, visit);
  };
  visit(w);
  ok(!!wikiListener && calls(wikiListener, "omniFrameActive") && calls(wikiListener, "isKKey"),
    "W2 위키 전용 ⌘K 가 액자에서 비키고(omniFrameActive) 자판 위치(isKKey)로 판정한다");
  const c = sf("web/v2/ctx-shell.ts");
  const open = findFn(c, "openSearch");
  ok(!!open && calls(open, "omniAvailable") && calls(open, "omniOpen") && calls(open, "forwardOmniToShell"), "W3 openSearch 가 훅이 없으면 셸에 부탁한다");
  const common = findFn(c, "commonRows");
  ok(!!common && calls(common, "openSearch") && !calls(common, "omniOpen"), "W3 우클릭 «「…」 검색» 이 openSearch 로 간다(액자에서도)");
  const t = sf("web/standalone/terminal.ts");
  ok(importsName(t, "isTerminalOmniChord", /\.\/omni-chord\.js$/) && calls(t, "isTerminalOmniChord"), "W4 터미널이 isTerminalOmniChord 로 판정한다");
  const a = sf("web/v2/app-ui.ts");
  //  #4530 격리 리뷰 뒤: 앱 화면 다리는 omni.ts 를 들이지 않는다(셸 화면 모듈 묶음이 딸려 와 창 없는 곳에서 터졌다 — session-app-pane 시험).
  //   대신 셸이 듣는 같은 오리진 신호(lively-omni-open)를 제 창에 보낸다 — bindOmniKey 가 받아 연다.
  ok(!importsName(a, "omniOpen", /\/omni\.js$/) && stringLiteralIn(a, "ui/omniOpen") && stringLiteralIn(a, "lively-omni-open") && callsMember(a, "postMessage"),
    "W5 앱 화면 다리가 ui/omniOpen 을 받아 셸 신호(lively-omni-open)로 넘긴다 · omni.ts 를 들이지 않는다");
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} failed`);
