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

// ── 휠 — 대화창이 터미널과 같은 줄 수로 굴러간다(#4797 상민님 «설정값에따라 똑같은속도로 느껴지게») ──────────
//  세션 터미널의 한 번 굴림은 두 단계다 — ① 터미널 페이지가 휠 이벤트를 SGR 휠 틱으로 바꾸고(terminal.ts wheelStep)
//  ② Claude Code 가 틱마다 몇 줄 굴릴지 가속한다. 대화창은 둘을 옮겨 적었다(web/lib/term-prefs.ts). ①은 실제 터미널 함수와
//  맞대고, ②는 Claude Code 실행 파일에서 그대로 떼어 낸 원본 함수로 뽑은 값과 맞댄다.

/** 정해진 씨앗의 섞인 이벤트 열 — 마우스 노치(맥 가속 크기) · 트랙패드 픽셀(잔 이동 · 큰 휙) · 방향 전환 · 쉼(잔차가 남는 쉼 ·
 *  버려지는 쉼 — 경계 300ms 양쪽) · line/page 단위. */
function wheelEvents(seed, n) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [];
  let dir = 1;
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.08) dir = -dir;                                   // 가끔 방향을 바꾼다
    const r = rnd();
    const pause = () => { const q = rnd(); return q < 0.06 ? 250 : q < 0.1 ? 299 : q < 0.13 ? 301 : q < 0.17 ? 400 : 10 + Math.floor(rnd() * 15); };
    if (r < 0.3) out.push({ notch: true, mode: 0, dy: dir * [4, 22, 69, 73, 120, 161][Math.floor(rnd() * 6)], gap: 30 + Math.floor(rnd() * 70) });
    else if (r < 0.8) out.push({ notch: false, mode: 0, dy: dir * (1 + Math.floor(rnd() * 12)) * (rnd() < 0.5 ? 1 : 0.5), gap: pause() });
    else if (r < 0.9) out.push({ notch: false, mode: 0, dy: dir * (40 + Math.floor(rnd() * 60)), gap: pause() });   // 큰 휙 — 한 이벤트가 12줄을 넘는다
    else if (r < 0.97) out.push({ notch: true, mode: 1, dy: dir * 3, gap: 60 });
    else out.push({ notch: true, mode: 2, dy: dir, gap: 120 });
  }
  return out;
}

test("휠 틱 — 대화창의 셈(termWheelTicks)이 터미널의 셈(wheelStep · alt+앱 마우스모드)과 같다", () => {
  assert.equal(typeof TERM.wheelStep, "function");
  //  마우스 휠 속도 2 이상(1 이하는 터미널이 xterm 에 맡긴다 — 아래 따로) × 트랙패드 배수 · 칸 높이 둘.
  for (const [speed, gain, cell] of [[3, 3, 18], [2, 0.5, 18], [5, 1.5, 21], [12, 6, 15], [7, 0.2, 18]]) {
    for (const seed of [1, 7, 4797]) {
      const accT = { px: 0, at: 0 }, accW = W.newWheelTickAcc();
      let t = 1000;
      wheelEvents(seed, 400).forEach((ev, i) => {
        t += ev.gap;
        const e = { deltaY: ev.dy, deltaMode: ev.mode, timeStamp: t };
        const { lines, reps } = TERM.wheelStep({ ...e }, ev.notch, speed, gain, cell, 40, accT);
        const want = reps ? (lines < 0 ? -reps : reps) : 0;
        assert.equal(W.termWheelTicks({ ...e }, ev.notch, { scrollSpeed: speed, padGain: gain }, cell, 40, accW), want,
          `speed ${speed} · gain ${gain} · cell ${cell} · seed ${seed} · #${i} ${JSON.stringify(ev)}`);
      });
    }
  }
});

test("휠 틱 — 마우스 휠 속도 1 이하는 xterm 이 보낸다: 쌓인 줄이 한 줄 이상인 이벤트마다 한 틱(몇 줄이든 한 틱)", () => {
  const p = { scrollSpeed: 1, padGain: 3 };
  //  칸 18px — 4px(0.22줄) 0틱 · 22px(누적 1.44) 1틱 · 69px(누적 4.27) 1틱 · 73px(누적 4.33) 1틱
  const acc = W.newWheelTickAcc();
  assert.deepEqual([4, 22, 69, 73].map((dy) => W.termWheelTicks({ deltaY: dy, deltaMode: 0 }, true, p, 18, 40, acc)), [0, 1, 1, 1]);
  const up = W.newWheelTickAcc();
  assert.deepEqual([-4, -22, -69].map((dy) => W.termWheelTicks({ deltaY: dy, deltaMode: 0 }, true, p, 18, 40, up)), [0, -1, -1]);
  //  line 단위는 늘 한 틱 · Shift 를 누른 굴림은 xterm 이 보내지 않는다
  assert.equal(W.termWheelTicks({ deltaY: 3, deltaMode: 1 }, true, p, 18, 40, W.newWheelTickAcc()), 1);
  assert.equal(W.termWheelTicks({ deltaY: 120, deltaMode: 0, shiftKey: true }, true, p, 18, 40, W.newWheelTickAcc()), 0);
});

//  Claude Code 2.1.301 실행 파일의 휠 가속 함수(avt · 상태 dvt(false, 1, false, true) — tmux 안의 값)를 그대로 떼어 내 돌린 결과.
//  [방향, 도착 시각 ms] → 그 틱에 굴린 줄 수. 같은 시각이 이어진 것 = 터미널이 한 이벤트의 틱을 한 번에 보낸 것.
const CC_GOLDEN = {
  "트랙패드처럼 17ms 간격 10틱 — 40ms 안이면 틱마다 0.3씩 가속": { steps: [[1, 1000], [1, 1017], [1, 1034], [1, 1051], [1, 1068], [1, 1085], [1, 1102], [1, 1119], [1, 1136], [1, 1153]], rows: [1, 1, 1, 1, 2, 2, 2, 3, 3, 3] },
  "마우스 노치 3틱 묶음 × 3(65ms 간격) — 묶음마다 처음부터": { steps: [[-1, 1000], [-1, 1000], [-1, 1000], [-1, 1065], [-1, 1065], [-1, 1065], [-1, 1130], [-1, 1130], [-1, 1130]], rows: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
  "5틱 묶음 × 4(30ms 간격) — 묶음을 넘어 가속이 이어진다": { steps: [[1, 1000], [1, 1000], [1, 1000], [1, 1000], [1, 1000], [1, 1030], [1, 1030], [1, 1030], [1, 1030], [1, 1030], [1, 1060], [1, 1060], [1, 1060], [1, 1060], [1, 1060], [1, 1090], [1, 1090], [1, 1090], [1, 1090], [1, 1090]], rows: [1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6] },
  "방향 전환 — 뒤집힌 첫 틱은 0줄, 이어지면 새 방향": { steps: [[1, 1000], [1, 1020], [1, 1040], [-1, 1060], [-1, 1070], [-1, 1090], [-1, 1110]], rows: [1, 1, 1, 0, 1, 1, 1] },
  "되튐(200ms 안에 원래 방향) → 센 가속(반감기 150ms) → 1.5초 쉬면 풀림": { steps: [[1, 1000], [1, 1020], [-1, 1040], [1, 1070], [1, 1080], [1, 1130], [1, 1230], [1, 1530], [1, 3600], [1, 3610]], rows: [1, 1, 0, 4, 7, 10, 13, 7, 1, 1] },
  "되튐 경계 — 뒤집힌 뒤 150ms 에 원래 방향이면 되튐(센 가속)": { steps: [[1, 1000], [1, 1020], [-1, 1040], [1, 1190], [1, 1200], [1, 1210]], rows: [1, 1, 0, 4, 7, 10] },
  "되튐 경계 — 210ms 뒤면 되튐이 아니다(처음부터)": { steps: [[1, 1000], [1, 1020], [-1, 1040], [1, 1250], [1, 1260], [1, 1270]], rows: [1, 1, 0, 1, 1, 1] },
  "센 가속은 1.2초 쉬어도 이어진다(풀리는 건 1.5초)": { steps: [[1, 1000], [1, 1020], [-1, 1040], [1, 1070], [1, 1080], [1, 2280], [1, 2290], [1, 2300]], rows: [1, 1, 0, 4, 7, 1, 4, 7] },
  "센 가속 중 5ms 안 연타 — 1줄씩, 다섯 번째에 풀림": { steps: [[1, 1000], [-1, 1010], [1, 1020], [1, 1021], [1, 1022], [1, 1023], [1, 1024], [1, 1025], [1, 1026], [1, 1100]], rows: [1, 0, 4, 1, 1, 1, 1, 1, 1, 1] },
  "1ms 간격 40틱 — 상한 6줄": { steps: Array.from({ length: 40 }, (_, i) => [1, 1000 + i]), rows: [1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, ...Array(20).fill(6)] },
  "40ms 경계 — 40ms 는 이어짐 · 41ms 는 처음부터": { steps: [[1, 1000], [1, 1040], [1, 1080], [1, 1121], [1, 1161]], rows: [1, 1, 1, 1, 1] },
};

test("Claude Code 휠 가속 — 원본에서 뽑은 줄 수와 같다(ccWheelRows)", () => {
  for (const [name, { steps, rows }] of Object.entries(CC_GOLDEN)) {
    const h = W.newCcWheel();
    assert.deepEqual(steps.map(([d, t]) => W.ccWheelRows(h, d, t)), rows, name);
  }
});

test("둘을 이으면 — 같은 설정에서 마우스 한 번 = 터미널이 보내는 틱 수 · 트랙패드 스와이프는 가속까지 같다", () => {
  const roll = (events, speed, gain) => {
    const acc = W.newWheelTickAcc(), cc = W.newCcWheel();
    let t = 1000, lines = 0;
    for (const ev of events) {
      t += ev.gap;
      const ticks = W.termWheelTicks({ deltaY: ev.dy, deltaMode: 0, timeStamp: t }, ev.notch, { scrollSpeed: speed, padGain: gain }, 18, 40, acc);
      for (let i = 0; i < Math.abs(ticks); i++) lines += W.ccWheelRows(cc, ticks < 0 ? -1 : 1, t);
    }
    return lines;
  };
  //  마우스: 노치 이벤트 하나 = 속도만큼 틱 = (한 이벤트 안에선 0.3씩 가속) — 속도 3 → 3줄 · 5 → 6줄. deltaY 크기(맥 가속)는 줄 수를 안 바꾼다.
  assert.equal(roll([{ notch: true, dy: 4, gap: 100 }], 3, 3), 3);
  assert.equal(roll([{ notch: true, dy: 161, gap: 100 }], 3, 3), 3);
  assert.equal(roll([{ notch: true, dy: 120, gap: 100 }], 5, 3), 6);
  //  트랙패드: 6px × 20회(17ms 간격) × 배수 3 = 360px = 20틱 — 틱마다 가속돼 67줄(종전 대화창은 픽셀 그대로 20줄이었다)
  assert.equal(roll(Array.from({ length: 20 }, () => ({ notch: false, dy: 6, gap: 17 })), 3, 3), 67);
});
