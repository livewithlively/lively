// #4993 (A) — 웹 판 원격 화면의 **순수** 판정 표(v2/remote-web-kit.js).
//
//  웹 브라우저로 연 라이블리의 [웹] 칸이 그 사람 데스크톱 앱 탭을 원격으로 쓴다(화면 = 스크린샷, 입력 = 원격 동작).
//  ① 키 → 원격 동작(K) · ② 보이는 그림 위의 점 → 스크린샷 좌표(P) · ③ 휠 → 원격 스크롤(W) · ④ 다음 화면 받기까지(D).
//  DOM 배선(숨긴 입력칸 · 두 번 누름 가르기 · 상태 문구)은 실제 브라우저 끝단 확인으로 잰다.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };

const { remoteKeyAction, toShotPoint, wheelToScroll, nextDelay } = await import(join(root, "public/app/v2/remote-web-kit.js"));
const K = (key, mods = {}) => ({ key, ...mods });
const mac = (e) => remoteKeyAction(e, true);
const win = (e) => remoteKeyAction(e, false);

// ── ① 키 ────────────────────────────────────────────────────────────────────
eq(["a", "가", " ", "+"].map((k) => mac(K(k))), ["a", "가", " ", "+"].map((text) => ({ kind: "text", text })), "K1 글자(명령 키 없음)는 글 그대로 — 공백 · + 포함");
eq(mac(K("A", { shiftKey: true })), { kind: "text", text: "A" }, "K1 shift 대문자도 글");
eq([mac(K("ㅎ", { isComposing: true })), mac(K("Process")), mac(K("Dead"))], [{ kind: "skip" }, { kind: "skip" }, { kind: "skip" }], "K2 조합 중 · Process · Dead 는 건너뜀");
const specials = ["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
eq(specials.map((k) => mac(K(k))), specials.map((keys) => ({ kind: "key", keys })), "K3 특수 키는 같은 이름의 키");
eq([mac(K("Tab", { shiftKey: true })), mac(K("ArrowLeft", { altKey: true }))], [{ kind: "key", keys: "shift+Tab" }, { kind: "key", keys: "alt+ArrowLeft" }], "K4 수식 + 특수 키");
eq([mac(K("a", { metaKey: true })), win(K("a", { ctrlKey: true }))], [{ kind: "key", keys: "cmd+a" }, { kind: "key", keys: "ctrl+a" }], "K5 명령 키+a — 맥 cmd · 그 밖 ctrl");
eq([mac(K("z", { metaKey: true })), mac(K("Z", { metaKey: true, shiftKey: true }))], [{ kind: "key", keys: "cmd+z" }, { kind: "key", keys: "cmd+shift+z" }], "K5 되돌리기 · 다시 하기(대문자로 와도 소문자)");
eq([mac(K("v", { metaKey: true })), win(K("v", { ctrlKey: true }))], [null, null], "K6 명령 키+v 는 null — 붙여넣기 사건이 글을 보낸다");
eq([mac(K("c", { metaKey: true })), mac(K("x", { metaKey: true })), win(K("c", { ctrlKey: true }))], [{ kind: "copy" }, { kind: "copy" }, { kind: "copy" }], "K7 명령 키+c · x 는 copy");
eq([mac(K("r", { metaKey: true })), win(K("r", { ctrlKey: true })), mac(K("F5"))], [{ kind: "reload" }, { kind: "reload" }, { kind: "reload" }], "K8 명령 키+r · F5 는 원격 새로고침");
eq([mac(K("r", { metaKey: true, shiftKey: true })), win(K("R", { ctrlKey: true, shiftKey: true }))], [null, null], "K8 경계 — ⇧⌘R 은 null(라이블리 화면 전체를 다시 싣는 탈출구는 사람 브라우저에)");
//  K9 — 브라우저는 수식키를 홀로 누를 때 그 수식 깃발도 함께 싣는다(Meta 를 누르면 metaKey: true). 깃발 없이 재면 이 행은 아무것도 못 잡는다.
eq([mac(K("Shift", { shiftKey: true })), mac(K("Control", { ctrlKey: true })), mac(K("Alt", { altKey: true })), mac(K("Meta", { metaKey: true })), win(K("Control", { ctrlKey: true })), mac(K("CapsLock"))],
  [null, null, null, null, null, null], "K9 수식키 홀로는 null(깃발이 함께 실려도 «cmd+meta» 같은 키를 만들지 않는다)");
eq([win(K("k", { ctrlKey: true, shiftKey: true })), mac(K("F2"))], [{ kind: "key", keys: "ctrl+shift+k" }, { kind: "key", keys: "F2" }], "K10 그 밖 명령 조합 · F2");
eq([mac(K("c", { ctrlKey: true }))], [{ kind: "key", keys: "ctrl+c" }], "K10 경계 — 맥의 ctrl+c 는 명령 키가 아니다(복사 아님, 키로)");
eq([mac({}), mac(K("")), remoteKeyAction(undefined, true)], [null, null, null], "K11 키가 없거나 빈 글이면 null");

// ── ② 좌표 ──────────────────────────────────────────────────────────────────
eq(toShotPoint(320, 245, 640, 490, 1279, 979), { x: 640, y: 490 }, "P1 반으로 보이는 그림의 가운데 → 스크린샷 가운데(반올림)");
eq([toShotPoint(-5, -5, 640, 490, 1279, 979), toShotPoint(9999, 9999, 640, 490, 1279, 979)], [{ x: 0, y: 0 }, { x: 1278, y: 978 }], "P2 그림 밖은 가장자리로 자른다");
eq([toShotPoint(1, 1, 0, 490, 1279, 979), toShotPoint(1, 1, 640, 490, 0, 979)], [null, null], "P3 보이는 크기 · 그림 크기가 0 이면 null");

// ── ③ 휠 ────────────────────────────────────────────────────────────────────
eq(wheelToScroll(0, 100, 640, 1279, 1), { direction: "down", amount: 200 }, "W1 아래 100(보이는 px) → 페이지 200");
eq(wheelToScroll(0, -50, 640, 1279, 1), { direction: "up", amount: 100 }, "W2 위 50 → 100");
eq([wheelToScroll(80, 10, 640, 1279, 1), wheelToScroll(-80, 10, 640, 1279, 1)], [{ direction: "right", amount: 160 }, { direction: "left", amount: 160 }], "W3 가로가 크면 좌우");
eq(wheelToScroll(0, 0.2, 640, 1279, 1), null, "W4 1px 도 안 되면 null");
eq(wheelToScroll(0, 100, 640, 1279, 0.5), { direction: "down", amount: 400 }, "W5 찍기 배율 0.5 면 거리 두 배");
eq(wheelToScroll(0, 1e9, 640, 1279, 1), { direction: "down", amount: 20000 }, "W6 상한 20,000");
eq([wheelToScroll(0, 100, 0, 1279, 1), wheelToScroll(0, 100, 640, 1279, 0), wheelToScroll(0, 100, 640, 1279, NaN)], [null, { direction: "down", amount: 200 }, { direction: "down", amount: 200 }], "W7 보이는 너비 0 은 null · 배율이 이상하면 1");

// ── ④ 받기 간격 ──────────────────────────────────────────────────────────────
const D = (o) => nextDelay({ visible: true, sinceInputMs: 5_000, changed: false, errors: 0, ...o });
eq(D({ visible: false }), null, "D1 안 보이면 멈춤");
eq([D({ sinceInputMs: 0 }), D({ sinceInputMs: 1_499 })], [150, 150], "D2 입력 1.5초 안이면 150ms");
eq(D({ changed: true }), 500, "D3 화면이 바뀌는 중이면 500ms");
eq([D({ sinceInputMs: 10_001 }), D({ sinceInputMs: 10_000 })], [2_000, 800], "D4 입력 없이 10초 넘으면 2초(경계 10초는 800)");
eq([D({ sinceInputMs: 1_500 }), D({ sinceInputMs: 5_000 })], [800, 800], "D5 그 사이는 800ms(경계 1.5초부터)");
eq([1, 2, 3, 4, 5, 50].map((n) => D({ errors: n })), [1_000, 2_000, 4_000, 8_000, 10_000, 10_000], "D6 오류가 이어지면 1·2·4·8초 · 상한 10초");

console.log(`\n${pass} 통과`);
