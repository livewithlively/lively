// 웹 터미널 설정 ↔ 세션 대화창 — 같은 설정을 같은 뜻으로 읽나 (#4707).
//
// 왜 이 테스트가 있나: 상민님 지시(2026-10-14) «웹터미널의 설정이 똑같이 대화화면에도 적용되도록». 터미널 페이지
//  (web/standalone/terminal.ts)는 SPA 와 따로 빌드되는 단독 번들이라 모듈을 나눠 쓸 수 없어서, 대화창이 알아야 하는
//  몫(글꼴 목록 · 테마 색 · 앱 따름 두 얼굴 · 저장 키 · 저장값 해석)을 web/lib/term-prefs.ts 에 **옮겨 적었다**.
//  두 벌은 갈라지면 소리 없이 틀린다 — 터미널은 Nord 인데 대화창은 엉뚱한 바탕, 혹은 터미널에서 고른 글꼴을 대화창이
//  모른 체한다. 화면을 봐야 아는 종류라 여기서 실제 터미널 모듈의 값·함수와 맞대어 잠근다.
// 실행: npm run build(터미널 tsc 산출) + npm run build:web(대화창 산출) 뒤 — 러너 `node scripts/run-tests.mjs --build`.
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = await import(pathToFileURL(path.join(ROOT, "public/app/lib/term-prefs.js")).href);
const TERM = await importTerminalModule();

const FACE_KEYS = ["background", "foreground", "cursor", "selectionBackground", "blue"];
const pick = (o) => Object.fromEntries(FACE_KEYS.map((k) => [k, String(o[k]).toLowerCase()]));

test("배선 · 두 모듈이 실제 값을 내보낸다", () => {
  assert.ok(Array.isArray(TERM.FONTS) && TERM.FONTS.length > 0);
  assert.ok(TERM.THEMES && TERM.THEMES.auto);
  assert.equal(typeof TERM.prefs, "function");
  assert.equal(typeof W.parseTermPrefs, "function");
});

test("저장 키가 같다(한쪽이 바꾸면 다른 쪽이 그 자리를 읽는다)", () => {
  assert.equal(W.TERM_PREFS_KEY, TERM.PREFS_KEY);
});

test("글꼴 목록이 같은 순서·같은 값", () => {
  assert.deepEqual(W.TERM_FONTS.map((f) => [f.v, f.label]), TERM.FONTS.map((f) => [f.v, f.label]));
});

test("앱 따름(auto)의 두 얼굴 — 바탕·글자·커서·선택·ANSI 파랑", () => {
  assert.deepEqual(pick(W.TERM_APP_DARK), pick(TERM.APP_DARK));
  assert.deepEqual(pick(W.TERM_APP_LIGHT), pick(TERM.APP_LIGHT));
  assert.equal(W.TERM_APP_DARK.dark, true);
  assert.equal(W.TERM_APP_LIGHT.dark, false);
});

test("이름 있는 테마 — 같은 키·순서·이름, 같은 색, 같은 어두운 판 판정", () => {
  assert.deepEqual(W.TERM_THEMES.map((t) => t.key), Object.keys(TERM.THEMES));
  for (const t of W.TERM_THEMES) {
    const tt = TERM.THEMES[t.key];
    assert.equal(t.name, tt.name, t.key);
    if (tt.auto) { assert.equal(t.face, null, t.key); continue; }
    assert.deepEqual(pick(t.face), pick(tt.theme), t.key);
    assert.equal(t.face.dark, !!tt.dark, t.key);
  }
});

/** 터미널의 prefs() 를 그 저장값으로 부른다(localStorage 를 그 값 하나로 바꿔 끼운다). */
function termPrefsOf(stored) {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => stored, setItem() { /* 이관 저장은 버린다 */ }, removeItem() { /* noop */ } };
  try { return TERM.prefs(); } finally { globalThis.localStorage = saved; }
}
const SHAPE = (p) => ({ fontFamily: p.fontFamily, fontSize: p.fontSize, theme: p.theme, cursorStyle: p.cursorStyle, scrollSpeed: Number(p.scrollSpeed), padGain: Number(p.padGain) });

test("저장값 해석 — 기본값·옛 dark/light 이관·이관 표시 존중·한글 폴백·사람이 고른 값", () => {
  const cases = [
    null,                                                                   // 저장값 없음 → 기본(JetBrains Mono 14 · auto · 막대 · 3 · 3)
    "{}",
    '{"theme":"dark"}',                                                     // 자동 판정이 굳은 옛 값 → auto
    '{"theme":"light"}',
    '{"theme":"dark","themeAutoMigrated":true}',                           // 이관 뒤에 사람이 고른 dark — 그대로
    '{"fontFamily":"Menlo, monospace"}',                                   // 한글 폴백 끼우기
    '{"fontFamily":"\'Fira Code\'"}',
    '{"theme":"nord","fontSize":16,"cursorStyle":"block","scrollSpeed":5,"padGain":1.5}',
  ];
  for (const raw of cases) assert.deepEqual(SHAPE(W.parseTermPrefs(raw, false)), SHAPE(termPrefsOf(raw)), String(raw));
});

test("모르는 테마 이름 — 둘 다 앱 따름 얼굴로 보인다", () => {
  const w = W.termFace(W.parseTermPrefs('{"theme":"zzz","themeAutoMigrated":true}', false).theme, false);
  const t = TERM.resolveTheme(termPrefsOf('{"theme":"zzz","themeAutoMigrated":true}').theme);
  assert.equal(String(w.background).toLowerCase(), String(t.background).toLowerCase());
});

test("저장 — 대화창이 쓴 값을 터미널이 같은 뜻으로 읽고, 모르는 칸은 지우지 않는다", () => {
  const p = W.parseTermPrefs('{"theme":"dracula","mobileDock":false,"lineSelect":"x"}', false);
  p.fontSize = 17; p.cursorStyle = "underline"; p.theme = "light";
  const s = W.serializeTermPrefs(p);
  const back = JSON.parse(s);
  assert.equal(back.mobileDock, false);
  assert.equal(back.lineSelect, "x");
  //  이관 표시를 남긴다 — 안 그러면 터미널이 사람이 고른 light 를 다음 부팅에 auto 로 되돌린다
  assert.equal(termPrefsOf(s).theme, "light");
  assert.equal(termPrefsOf(s).fontSize, 17);
  assert.equal(termPrefsOf(s).cursorStyle, "underline");
});
