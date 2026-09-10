// 입력줄 선택·되돌리기 사양(#3778) — 스크래치패드 spec.md 의 엣지 표 40행에 1:1 대응한다.
//  검증 대상은 web/standalone/line-edit.ts 의 순수 판정(DOM·xterm·소켓 없음).
//  fail-first: 변이(mutation)로 red 를 눈으로 본 뒤 green 을 확인했다 — 어느 줄을 깨면 어느 행이 빨간불이 되는지는
//  각 절 머리말에 적어 뒀다.
// 실행: npm run build && node dist/terminal/line-edit.test.js
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD_URL = pathToFileURL(process.env.LINEEDIT_MOD || path.resolve(here, "..", "standalone", "line-edit.js")).href;
const mod: any = await import(MOD_URL);
const { decideKey, UndoStack, countTyped, SEQ, nativeUndoOk } = mod;

interface Ctx { mac: boolean; hasSel: boolean; select: boolean }
const MAC: Ctx = { mac: true, hasSel: false, select: true };
const SEL: Ctx = { mac: true, hasSel: true, select: true };
const k = (key: string, over: Record<string, unknown> = {}): any => ({ key, ...over });

const tests: Array<[string, () => void]> = [];
const t = (name: string, fn: () => void): void => { tests.push([name, fn]); };

// ── A. ⌘ 계열 넷 (변이: IS_MAC 분기 제거 → A5 red · kill 플래그 제거 → A3·A4 red) ──
t("A1 맥 ⌘← → 줄 처음으로", () => {
  assert.deepEqual(decideKey(k("ArrowLeft", { metaKey: true }), MAC), { k: "send", seq: SEQ.home });
});
t("A2 맥 ⌘→ → 줄 끝으로", () => {
  assert.deepEqual(decideKey(k("ArrowRight", { metaKey: true }), MAC), { k: "send", seq: SEQ.end });
});
t("A3 맥 ⌘⌫ → 앞 전부 지우기 + kill 표시", () => {
  assert.deepEqual(decideKey(k("Backspace", { metaKey: true }), MAC), { k: "send", seq: SEQ.killHead, kill: true });
});
t("A4 맥 ⌘⌦ → 뒤 전부 지우기 + kill 표시", () => {
  assert.deepEqual(decideKey(k("Delete", { metaKey: true }), MAC), { k: "send", seq: SEQ.killTail, kill: true });
});
t("A5 맥이 아니면 ⌘ 계열은 손대지 않는다", () => {
  assert.deepEqual(decideKey(k("ArrowLeft", { metaKey: true }), { ...MAC, mac: false }), { k: "pass" });
  assert.deepEqual(decideKey(k("Backspace", { metaKey: true }), { ...MAC, mac: false }), { k: "pass" });
});
t("A6 ⌘⌫ 인데 선택이 서 있으면 줄이 아니라 선택만 지운다", () => {
  assert.deepEqual(decideKey(k("Backspace", { metaKey: true }), SEL), { k: "del" });
  assert.deepEqual(decideKey(k("Delete", { metaKey: true }), SEL), { k: "del" });
});

// ── B. 선택 확장 (변이: select 조건 제거 → B5 red · unit 상수 바꾸기 → B1~B4 red) ──
t("B1 Shift+← → 한 글자 확장 · 보내는 바이트는 평범한 ←", () => {
  assert.deepEqual(decideKey(k("ArrowLeft", { shiftKey: true }), MAC), { k: "extend", seq: SEQ.left, unit: "char", dir: -1 });
});
t("B2 Shift+→ → 한 글자 확장", () => {
  assert.deepEqual(decideKey(k("ArrowRight", { shiftKey: true }), MAC), { k: "extend", seq: SEQ.right, unit: "char", dir: 1 });
});
t("B3 ⌥Shift+←/→ → 단어 확장", () => {
  assert.deepEqual(decideKey(k("ArrowLeft", { shiftKey: true, altKey: true }), MAC), { k: "extend", seq: SEQ.wordLeft, unit: "word", dir: -1 });
  assert.deepEqual(decideKey(k("ArrowRight", { shiftKey: true, altKey: true }), MAC), { k: "extend", seq: SEQ.wordRight, unit: "word", dir: 1 });
});
t("B4 ⌘Shift+←/→ · Shift+Home/End → 줄 확장", () => {
  assert.deepEqual(decideKey(k("ArrowLeft", { shiftKey: true, metaKey: true }), MAC), { k: "extend", seq: SEQ.home, unit: "line", dir: -1 });
  assert.deepEqual(decideKey(k("ArrowRight", { shiftKey: true, metaKey: true }), MAC), { k: "extend", seq: SEQ.end, unit: "line", dir: 1 });
  assert.deepEqual(decideKey(k("Home", { shiftKey: true }), MAC), { k: "extend", seq: SEQ.home, unit: "line", dir: -1 });
  assert.deepEqual(decideKey(k("End", { shiftKey: true }), MAC), { k: "extend", seq: SEQ.end, unit: "line", dir: 1 });
});
t("B5 설정이 꺼져 있으면 아무것도 가로채지 않는다", () => {
  const off = { ...MAC, select: false };
  assert.deepEqual(decideKey(k("ArrowLeft", { shiftKey: true }), off), { k: "pass" });
  assert.deepEqual(decideKey(k("ArrowRight", { shiftKey: true, altKey: true }), off), { k: "pass" });
  assert.deepEqual(decideKey(k("Home", { shiftKey: true }), off), { k: "pass" });
});
t("B6 Ctrl+Shift+← 는 터미널 제 기능 — 손대지 않는다", () => {
  assert.deepEqual(decideKey(k("ArrowLeft", { shiftKey: true, ctrlKey: true }), MAC), { k: "pass" });
});

// ── C. 선택이 서 있을 때 (변이: isComposing 가드 제거 → C4 red · Ctrl 제외 제거 → C6 red) ──
t("C1 선택 + ⌫·⌦ → 선택을 지운다", () => {
  assert.deepEqual(decideKey(k("Backspace"), SEL), { k: "del" });
  assert.deepEqual(decideKey(k("Delete"), SEL), { k: "del" });
});
t("C2 선택 + 글자 → 지우고 갈아치운다(키는 흘린다)", () => {
  assert.deepEqual(decideKey(k("a"), SEL), { k: "delThenPass" });
  assert.deepEqual(decideKey(k(" "), SEL), { k: "delThenPass" });
  assert.deepEqual(decideKey(k("가"), SEL), { k: "delThenPass" });
});
t("C3 선택 + IME 조합 시작(keyCode 229) → 한글로도 갈아치울 수 있다", () => {
  assert.deepEqual(decideKey(k("Process", { keyCode: 229 }), SEL), { k: "delThenPass" });
});
t("C4 ★선택 + 조합 중 → 아무것도 지우지 않는다(음절이 깨진다)", () => {
  assert.deepEqual(decideKey(k("Process", { keyCode: 229, isComposing: true }), SEL), { k: "clear" });
  assert.deepEqual(decideKey(k("Backspace", { isComposing: true }), SEL), { k: "clear" });
});
t("C5 선택 + ⌘C → 선택을 복사", () => {
  assert.deepEqual(decideKey(k("c", { metaKey: true }), SEL), { k: "copy" });
});
t("C6 ★선택 + Ctrl+C → 뺏지 않는다(터미널의 «중단»)", () => {
  assert.deepEqual(decideKey(k("c", { ctrlKey: true }), SEL), { k: "clear" });
});
t("C7 캐럿이 선택 밖으로 가거나 줄이 끝나는 키만 거둔다", () => {
  for (const key of ["Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Tab"]) {
    assert.deepEqual(decideKey(k(key), SEL), { k: "clear" }, key);
  }
});
t("C7b ★수정자 키를 누르는 것만으로는 선택이 사라지지 않는다 — 선택을 만드는 동작 자체가 선택을 죽이던 버그", () => {
  for (const key of ["Shift", "Meta", "Control", "Alt", "CapsLock", "AltGraph", "Dead"]) {
    assert.deepEqual(decideKey(k(key, { shiftKey: key === "Shift" }), SEL), { k: "pass" }, key);
  }
  // ⌘C 하려고 ⌘ 를 먼저 누르는 흐름: ⌘ keydown 에서 선택이 살아 있어야 그 다음 ⌘C 가 «선택 복사» 가 된다
  assert.deepEqual(decideKey(k("Meta", { metaKey: true }), SEL), { k: "pass" });
  assert.deepEqual(decideKey(k("c", { metaKey: true }), SEL), { k: "copy" });
});
t("C7c 기능키·미디어키처럼 모르는 키는 선택을 건드리지 않는다(모르면 그대로 둔다)", () => {
  for (const key of ["F5", "F12", "AudioVolumeUp", "Insert", "ContextMenu"]) {
    assert.deepEqual(decideKey(k(key), SEL), { k: "pass" }, key);
  }
});
t("C7d Shift+화살표 위/아래는 앱이 무시하므로 선택도 그대로 둔다", () => {
  assert.deepEqual(decideKey(k("ArrowUp", { shiftKey: true }), SEL), { k: "pass" });
  assert.deepEqual(decideKey(k("ArrowDown", { shiftKey: true }), SEL), { k: "pass" });
});
t("C7e Ctrl/⌘ + 글자는 줄을 건드리는 명령이라 선택을 거둔다(^C 중단 · ⌘V 붙여넣기)", () => {
  assert.deepEqual(decideKey(k("c", { ctrlKey: true }), SEL), { k: "clear" });
  assert.deepEqual(decideKey(k("u", { ctrlKey: true }), SEL), { k: "clear" });
  assert.deepEqual(decideKey(k("v", { metaKey: true }), SEL), { k: "clear" });
});
t("C8 선택이 없으면 ⌫ 는 손대지 않는다", () => {
  assert.deepEqual(decideKey(k("Backspace"), MAC), { k: "pass" });
  assert.deepEqual(decideKey(k("a"), MAC), { k: "pass" });
});
t("C9 키 이름이 비어 있어도 «글자» 로 오인하지 않고, 선택도 건드리지 않는다", () => {
  assert.deepEqual(decideKey(k(""), SEL), { k: "pass" });   // 모르는 것은 그대로 둔다
  assert.deepEqual(decideKey(k(""), MAC), { k: "pass" });
});

// ── D. 되돌리기 키 (#3864 사양 K1~K12 — 수정 전 판정으로 D2·D2b·D2c red, 변이로 D5·D6 red 확인) ──
t("D1 맥은 ⌘Z", () => { assert.deepEqual(decideKey(k("z", { metaKey: true }), MAC), { k: "undo" }); });
t("D2 ★Ctrl+Z 는 되돌리기다 — PTY 로 흘리면 하네스가 정지(SIGTSTP)되는데 웹 터미널 pane 엔 fg 칠 셸이 없다(#3864)", () => {
  assert.deepEqual(decideKey(k("z", { ctrlKey: true }), MAC), { k: "undo" });
  assert.deepEqual(decideKey(k("z", { ctrlKey: true }), { ...MAC, mac: false }), { k: "undo" });
  assert.deepEqual(decideKey(k("Z", { ctrlKey: true }), MAC), { k: "undo" }, "CapsLock 이 켜져 있어도");
});
t("D2b ★키 이름이 z 가 아니어도 keyCode 90 이면 Ctrl+Z 다 — xterm 은 key 가 아니라 keyCode 로 0x1a 를 만든다", () => {
  assert.deepEqual(decideKey(k("ㅋ", { ctrlKey: true, keyCode: 90 }), MAC), { k: "undo" });
  assert.deepEqual(decideKey(k("ㅋ", { ctrlKey: true, keyCode: 90 }), SEL), { k: "undo" }, "선택이 서 있어도 되돌리기가 먼저");
});
t("D2c ★입력줄 선택을 꺼도 Ctrl+Z 는 되돌리기 — 그 설정이 정지 위험을 되살리면 안 된다", () => {
  assert.deepEqual(decideKey(k("z", { ctrlKey: true, keyCode: 90 }), { ...MAC, select: false }), { k: "undo" });
});
t("D5 Ctrl+Shift+Z 는 되돌리기가 아니다 — 흘린다(다시하기는 없다)", () => {
  assert.deepEqual(decideKey(k("Z", { ctrlKey: true, shiftKey: true, keyCode: 90 }), MAC), { k: "pass" });
  assert.deepEqual(decideKey(k("Z", { ctrlKey: true, shiftKey: true, keyCode: 90 }), { ...MAC, mac: false }), { k: "pass" });
});
t("D6 경계: 수정자 없는 z 와 맥 ⌥Z(Ω) 는 keyCode 90 이어도 되돌리기가 아니다", () => {
  assert.deepEqual(decideKey(k("z", { keyCode: 90 }), MAC), { k: "pass" });
  assert.deepEqual(decideKey(k("Ω", { altKey: true, keyCode: 90 }), MAC), { k: "pass" });
});
t("D3 맥이 아니면 Alt+Z", () => {
  assert.deepEqual(decideKey(k("z", { altKey: true }), { ...MAC, mac: false }), { k: "undo" });
  assert.deepEqual(decideKey(k("z", { altKey: true }), MAC), { k: "pass" }); // 맥에서 ⌥Z 는 우리 것이 아니다
});
t("D4 ⌘⇧Z(다시하기)는 아직 없다 — 삼키지 않는다", () => {
  assert.deepEqual(decideKey(k("z", { metaKey: true, shiftKey: true }), MAC), { k: "pass" });
});

// ── E. 되돌리기 스택 (변이: breakRun 의 typed 초기화 제거 → E2 red · reset 제거 → E5 red) ──
t("E1 친 글자는 «한 번에 친 만큼» 이 한 덩이", () => {
  const u = new UndoStack();
  u.type(3); u.type(2);
  assert.deepEqual(u.pop(), { k: "typed", n: 5 });
  assert.equal(u.pop(), null);
});
t("E2 이동키가 들어오면 덩이가 끊긴다 — 둘이 따로 되돌아간다", () => {
  const u = new UndoStack();
  u.type(3); u.breakRun(); u.type(2);
  assert.deepEqual(u.pop(), { k: "typed", n: 2 });
  assert.deepEqual(u.pop(), { k: "typed", n: 3 });
});
t("E3 kill 은 yank 갈래로 들어간다", () => {
  const u = new UndoStack();
  u.push({ k: "yank" });
  assert.deepEqual(u.pop(), { k: "yank" });
});
t("E4 지운 선택은 글자 그대로 되돌아간다", () => {
  const u = new UndoStack();
  u.push({ k: "text", text: "안녕하세요" });
  assert.deepEqual(u.pop(), { k: "text", text: "안녕하세요" });
});
t("E5 ★보내고 나면(Enter) 되돌릴 것을 통째로 버린다", () => {
  const u = new UndoStack();
  u.type(4); u.push({ k: "yank" });
  u.reset();
  assert.equal(u.pop(), null);
  assert.equal(u.depth, 0);
});
t("E6 치던 것이 가장 먼저 되돌아간다", () => {
  const u = new UndoStack();
  u.push({ k: "yank" });
  u.type(2);
  assert.deepEqual(u.pop(), { k: "typed", n: 2 });
  assert.deepEqual(u.pop(), { k: "yank" });
});
t("E7 경계: 상한을 넘으면 가장 오래된 것부터 버린다", () => {
  const u = new UndoStack();
  for (let i = 0; i < 55; i++) u.push({ k: "text", text: "t" + i });
  assert.equal(u.depth, 50, "상한만큼만 남는다");
  assert.deepEqual(u.pop(), { k: "text", text: "t54" }, "가장 최근 것이 먼저");
  const rest: string[] = [];
  for (;;) { const e = u.pop(); if (!e) break; rest.push((e as any).text); }
  assert.equal(rest[rest.length - 1], "t5", "가장 오래된 다섯(t0~t4)은 버려졌다");
});
t("E8 아무것도 안 쳤으면 빈 덩이를 만들지 않는다", () => {
  const u = new UndoStack();
  u.type(0); u.breakRun();
  assert.equal(u.depth, 0);
  assert.equal(u.pop(), null);
});

// ── F. 타이핑 세기 (변이: 0x7f 분기 제거 → F3 red · ESC 분기 제거 → F4 red) ──
t("F1 평범한 글자는 글자 수", () => { assert.equal(countTyped("abc"), 3); });
t("F2 한글·이모지는 칸이 아니라 «글자» 수", () => {
  assert.equal(countTyped("안녕"), 2);
  assert.equal(countTyped("😀"), 1);
  assert.equal(countTyped("가😀나"), 3);
});
t("F3 ★DEL 은 방금 센 것을 되돌린다(백스페이스·사파리 IME 치환)", () => {
  assert.equal(countTyped("\x7f가"), 0);
  assert.equal(countTyped("\x7f"), -1);
  assert.equal(countTyped("ab\x7f"), 1);
});
t("F4 ESC 로 시작하면 타이핑이 아니다 → 덩이를 끊는다", () => {
  assert.equal(countTyped("\x1b[D"), null);
  assert.equal(countTyped("\x1b[200~x\x1b[201~"), null);
});
t("F5 제어문자가 섞여도 덩이를 끊는다", () => {
  assert.equal(countTyped("ab\r"), null);
  assert.equal(countTyped("\x03"), null);
});
t("F6 빈 문자열은 0", () => { assert.equal(countTyped(""), 0); });
t("F7 경계: 스페이스(0x20)는 글자 · 0x1f 는 제어", () => {
  assert.equal(countTyped(" "), 1);
  assert.equal(countTyped("\x1f"), null);
});

// ── N. 앱 자체 되돌리기를 부를 판인가 (#3864 사양 V1~V7 — 변이로 N1·N3 red 확인) ──
//  근거: 2.1.266 번들엔 입력칸 되돌리기가 없었고(#3778 바이너리 실측), 2.1.267 은 Ctrl+_(0x1f)로 한 덩이씩 되돌리고
//  지운 글자도 되살린다(#3864 격리 인스턴스 실측). 매니지드는 stable 채널(2026-09-10 기준 2.1.236)을 깐다.
t("N1 ★경계 최소치 2.1.267 은 앱 되돌리기", () => { assert.equal(nativeUndoOk("2.1.267"), true); });
t("N2 ★경계 바로 아래 2.1.266 은 합성", () => { assert.equal(nativeUndoOk("2.1.266"), false); });
t("N3 자리 올림도 앱 — 문자열 비교면 2.1.1000 을 옛 판으로 잘못 본다", () => {
  for (const v of ["2.1.300", "2.1.1000", "2.2.0", "3.0.0"]) assert.equal(nativeUndoOk(v), true, v);
});
t("N4 매니지드 stable(2.1.236)·더 옛 판은 합성", () => {
  for (const v of ["2.1.236", "2.0.999", "1.9.999"]) assert.equal(nativeUndoOk(v), false, v);
});
t("N5 버전이 아닌 이름은 합성 — 매니지드(docker)·셸·이름(claude)·npm 설치(node)·빈 값", () => {
  for (const v of ["docker", "zsh", "claude", "node", ""]) assert.equal(nativeUndoOk(v), false, v);
});
t("N6 ★pane 상태가 아예 없으면(undefined·null) 합성", () => {
  assert.equal(nativeUndoOk(undefined), false);
  assert.equal(nativeUndoOk(null), false);
});
t("N7 형식이 어긋나면(2.1 · v2.1.267) 합성", () => {
  for (const v of ["2.1", "v2.1.267"]) assert.equal(nativeUndoOk(v), false, v);
});

let pass = 0; const fails: string[] = [];
for (const [name, fn] of tests) {
  try { fn(); pass++; console.log("ok  " + name); }
  catch (e) { fails.push(name); console.log("FAIL " + name + "\n     " + String((e as Error).message).split("\n")[0]); }
}
console.log(`\n${pass}/${tests.length} pass` + (fails.length ? ` · ${fails.length} FAIL` : ""));
if (fails.length) process.exit(1);
