// #4794 — 터미널 액자가 «하네스가 처음 그렸다» 를 언제 알리나 · 숨은 액자인가 — 순수 판정과 배선.
//
//  세션 화면은 말을 보낸 직후 액자를 숨긴 채 먼저 붙여 두고, 액자가 lively-term-painted 를 알리면 터미널로 넘긴다
//   (web/session-chat.ts termWarm · 런타임은 term-warm-runtime.test.mjs). 여기는 그 신호의 판정 표다:
//   U1 빈 글 · 공백·줄바꿈만 · NBSP 만 → «안 그렸다»      U2 글자 하나라도 → «그렸다»(상자 선 글자도)
//   U3 처음 그린 직후 → 멎기를 기다린다(0.3초)              U4 상한까지 0.3초 미만 남음 → 남은 만큼만
//   U5 정확히 상한 · 상한 지남 → 0(음수 아님)              U6 액자 밖(액자 요소를 못 읽음) → «숨지 않았다»(종전처럼 초점)
//   U7 액자 요소가 inert 조상 아래 · visibility:hidden → «숨었다» · 둘 다 아니면 «보인다»
//  배선(무엇이 무엇을 부르는가)은 소스 텍스트로 본다 — 순수 함수 시험으로는 못 잡는 자리(terminal-restore-gate 와 같은 규율).
// 실행: npm run build && node scripts/term-first-paint.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");
const mod = await importTerminalModule();
for (const k of ["screenHasInk", "firstPaintDelay", "frameHiddenNow", "watchFirstPaint"]) {
  assert.equal(typeof mod[k], "function", `${k} 가 모듈에서 노출돼야 한다`);
}
const { screenHasInk, firstPaintDelay, frameHiddenNow, FIRST_PAINT_QUIET_MS: QUIET, FIRST_PAINT_MAX_MS: MAX } = mod;

let pass = 0;
const ok = (m) => { pass++; console.log(`ok  ${m}`); };

// U1·U2 — «그렸나»
for (const [s, want, why] of [
  ["", false, "빈 글"],
  [null, false, "글 없음(null)"],
  ["   \n  \n\t", false, "공백·줄바꿈·탭만"],
  ["  \n", false, "NBSP 만"],
  ["\n\n          >", true, "글자 하나(입력줄 표식)"],
  ["╭───╮", true, "상자 선 글자"],
  ["안녕", true, "한글"],
]) assert.equal(screenHasInk(s), want, `screenHasInk(${JSON.stringify(s)}) — ${why}`);
ok("U1·U2 «그렸나» — 공백·줄바꿈·NBSP 만은 아니다 · 글자 하나라도(상자 선·한글 포함) 그렇다");

// 상수 자체 — 이 값이 바뀌면 런타임 시험의 시간 창과 세션 화면 상한(12초)도 함께 봐야 한다
assert.equal(QUIET, 300); assert.equal(MAX, 1500);
ok("상수 — 멎기 0.3초 · 처음 그린 때부터 상한 1.5초");

// U3·U4·U5 — 기다릴 시간
const t = 10_000;
assert.equal(firstPaintDelay(t, t), QUIET, "처음 그린 직후 → 멎기만큼");
assert.equal(firstPaintDelay(t, t + 600), QUIET, "중간 → 멎기만큼(그 사이 출력이 오면 다시 잰다)");
assert.equal(firstPaintDelay(t, t + MAX - QUIET), QUIET, "상한까지 정확히 멎기만큼 남음(경계) → 멎기만큼");
assert.equal(firstPaintDelay(t, t + MAX - QUIET + 1), QUIET - 1, "상한까지 멎기보다 1ms 덜 남음 → 남은 만큼");
assert.equal(firstPaintDelay(t, t + MAX - 1), 1, "상한 1ms 전 → 1");
assert.equal(firstPaintDelay(t, t + MAX), 0, "정확히 상한 → 0");
assert.equal(firstPaintDelay(t, t + MAX + 5000), 0, "상한 지남 → 0(음수 아님)");
assert.equal(firstPaintDelay(t, t, 100, 1000), 100, "멎기·상한을 넘겨 줄 수 있다");
ok("U3·U4·U5 기다릴 시간 — 멎기(0.3초) · 상한(1.5초) 경계 · 음수 없음");

// U6 — 액자 밖이면 «숨지 않았다»(종전처럼 붙자마자 초점)
assert.equal(frameHiddenNow(), false, "frameElement 가 없다(단독 창 · 노드)");
globalThis.frameElement = null;
assert.equal(frameHiddenNow(), false, "frameElement 가 null(다른 출처라 못 읽음)");
Object.defineProperty(globalThis, "frameElement", { configurable: true, get() { throw new Error("SecurityError"); } });
assert.equal(frameHiddenNow(), false, "frameElement 를 읽다 던진다");
delete globalThis.frameElement;
ok("U6 액자 밖·못 읽는 액자 → 숨지 않았다(종전 동작)");

// U7 — 숨겨 붙인 액자(세션 화면의 .sc-term-warm: inert · visibility:hidden)는 «숨었다»
const fakeFrame = (inertAncestor, vis) => ({ closest: (sel) => (sel === "[inert]" && inertAncestor ? {} : null), __vis: vis });
globalThis.getComputedStyle = (el) => ({ visibility: el.__vis });
try {
  globalThis.frameElement = fakeFrame(true, "visible");
  assert.equal(frameHiddenNow(), true, "inert 조상 아래 → 숨었다");
  globalThis.frameElement = fakeFrame(false, "hidden");
  assert.equal(frameHiddenNow(), true, "visibility:hidden → 숨었다");
  globalThis.frameElement = fakeFrame(false, "visible");
  assert.equal(frameHiddenNow(), false, "둘 다 아니면 → 보인다");
} finally { delete globalThis.frameElement; delete globalThis.getComputedStyle; }
ok("U7 inert 조상 · visibility:hidden 이면 숨었다 · 아니면 보인다");

// 배선 — boot() 가 터미널을 만든 뒤 신호를 걸고, onopen 의 초점은 숨은 액자에서 멈춘다
const boot = src.slice(src.indexOf("export async function boot()"));
const at = (s) => boot.indexOf(s);
assert.ok(at("term = new Terminal(") > 0 && at("watchFirstPaint();") > at("term = new Terminal("), "boot() 가 터미널을 만든 뒤 watchFirstPaint() 를 건다");
assert.match(src, /if \(!glassIdle && !frameHiddenNow\(\)\) term\.focus\(\);/, "onopen 의 첫 초점이 숨은 액자에서 멈춘다");
//  onopen 안의 **모든** 초점 호출이 그 가드를 거친다 — 나중에 한 줄 더 붙어도 숨은 액자가 초점을 가져가면 안 된다.
{
  const open = src.slice(src.indexOf("sock.onopen = () => {"), src.indexOf("sock.onmessage = (e) => {"));
  const focusLines = open.split("\n").filter((l) => /term\.focus\(\)/.test(l) && !/^\s*\/\//.test(l));
  assert.ok(open.length > 200 && focusLines.length >= 1, "onopen 본문을 못 찾았다(배선 시험이 헛돈다)");
  assert.ok(focusLines.every((l) => /!frameHiddenNow\(\)/.test(l)), "onopen 에 숨은 액자 가드 없는 term.focus() 가 있다: " + focusLines.join(" | "));
}
assert.match(src, /postMessage\(\{ type: 'lively-term-painted', id: SESSION_ID \}, location\.origin\)/, "신호는 같은 출처의 부모에게 세션 id 를 실어 간다");
assert.match(src, /if \(!\(EMBED && window\.parent !== window\)\) return;\s*\n\s*let inkAt = 0;/, "신호는 액자 안(embed=1)에서만");
ok("배선 — boot 순서 · onopen 초점 가드 · 신호 모양(같은 출처 · 세션 id) · 액자 안에서만");

console.log(`\nterm-first-paint: ${pass} 통과`);
