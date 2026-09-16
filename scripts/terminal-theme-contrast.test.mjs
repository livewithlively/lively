// 터미널 테마 팔레트 — 슬롯 누락과 대비를 고정한다.
//
// 왜 필요한가(2026-09 사용자 보고): 이름 있는 테마가 background·foreground·cursor·selection 넷만 주고 있었고,
//  xterm 은 빠진 ANSI 슬롯을 자기 기본 팔레트(우분투 계열)로 채운다. 그 색은 이 테마들의 배경을 전제로 고른 게
//  아니라서 Solarized 배경(#002b36) 위에서 black 1.19:1 · brightBlack 2.05:1 · blue 2.53:1 까지 떨어진다 —
//  하네스가 회색·파랑으로 찍는 보조 출력이 배경에 묻힌다. 슬롯이 하나라도 빠지면 그 순간 조용히 되돌아가는
//  회귀라서(화면을 봐야 아는 종류다) 여기서 기계로 잡는다.
// 실행: npm run build && node scripts/terminal-theme-contrast.test.mjs
import assert from "node:assert/strict";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const { THEMES, APP_DARK, APP_LIGHT, resolveTheme } = await importTerminalModule();

const ANSI_SLOTS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

/** WCAG 2.x 상대휘도. 형식을 먼저 막는다 — 잘못된 값이면 대비가 NaN 이 되고 `NaN < 4.5` 는 false 라
 *  «기준 미달» 목록에서 조용히 빠진다(통과로 보이는 false negative). */
function luminance(hex) {
  assert.match(String(hex), /^#[0-9a-f]{6}$/i, `색 값이 6자리 hex 가 아니다: ${hex}`);
  const h = String(hex).replace("#", "");
  const ch = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

// 자가검증 — 계산이 맞아야 아래 판정이 뜻을 갖는다(검은 글자/흰 배경 = 21:1).
assert.ok(Math.abs(contrast("#000000", "#ffffff") - 21) < 0.01, "대비 계산이 어긋났다");
ok("대비 계산 자가검증 (#000 on #fff = 21:1)");

// 1. 이름 있는 테마는 ANSI 16 슬롯을 전부 준다 — 하나라도 빠지면 xterm 기본 팔레트로 떨어진다.
for (const [key, t] of Object.entries(THEMES)) {
  if (t.auto) continue;
  const missing = ANSI_SLOTS.filter((s) => !/^#[0-9a-f]{6}$/i.test(String(t.theme[s])));
  assert.deepEqual(missing, [], `테마 '${key}' 에 ANSI 슬롯이 빠졌거나 형식이 틀렸다(xterm 기본 팔레트로 떨어진다): ${missing.join(", ")}`);
  ok(`'${key}' ANSI 16색 전부 정의`);
}

// 2. auto 가 해석되는 두 팔레트도 같은 규율.
for (const [label, pal] of [["APP_DARK", APP_DARK], ["APP_LIGHT", APP_LIGHT]]) {
  const missing = ANSI_SLOTS.filter((s) => !/^#[0-9a-f]{6}$/i.test(String(pal[s])));
  assert.deepEqual(missing, [], `${label} 에 ANSI 슬롯이 빠졌다: ${missing.join(", ")}`);
  ok(`${label} ANSI 16색 전부 정의`);
}

// 3. 고대비 테마는 배경 위에서 4.5:1(WCAG AA 본문)을 지킨다.
//    black 은 예외다 — 그 슬롯의 뜻이 '가장 어두운 색'이라 배경에 가까운 게 맞다(auto 팔레트도 같은 예외).
const HC_KEY = "solarized-hc";
assert.ok(THEMES[HC_KEY], `고대비 테마 '${HC_KEY}' 가 있어야 한다 — 저대비 공식 팔레트의 유일한 탈출구다`);
{
  const { theme } = THEMES[HC_KEY];
  const low = ANSI_SLOTS
    .filter((s) => s !== "black")
    .map((s) => [s, theme[s], contrast(theme[s], theme.background)])
    .filter(([, , r]) => r < 4.5);
  assert.deepEqual(low, [], `'${HC_KEY}' 에서 4.5:1 미만: ${low.map(([s, v, r]) => `${s} ${v} ${r.toFixed(2)}`).join(" · ")}`);
  ok(`'${HC_KEY}' ANSI 15색(black 제외) 배경 대비 4.5:1 이상`);
  assert.ok(contrast(theme.foreground, theme.background) >= 4.5, `'${HC_KEY}' 본문 글자색이 4.5:1 미만`);
  ok(`'${HC_KEY}' foreground 대비 4.5:1 이상`);
}

// 4. 커서와 선택영역도 읽혀야 한다 — ANSI 슬롯만 보면 '선택한 글자가 안 보이는' 조합을 놓친다.
{
  const { theme } = THEMES[HC_KEY];
  assert.ok(contrast(theme.cursor, theme.background) >= 4.5, `'${HC_KEY}' 커서가 배경 대비 4.5:1 미만`);
  assert.ok(contrast(theme.foreground, theme.selectionBackground) >= 4.5, `'${HC_KEY}' 선택영역 위 글자가 4.5:1 미만`);
  ok(`'${HC_KEY}' 커서·선택영역 대비 4.5:1 이상`);
}

// 5. Solarized brightBlack 은 종전(xterm 기본 팔레트 폴백)보다 읽힌다 — **이 슬롯 하나만** 재는 단언이다.
//    공식 팔레트를 넣는 것 자체가 목적이 아니다 — 목적은 읽히게 하는 것이고, Solarized 공식 brightBlack(base03)은
//    배경색과 같아 그 슬롯 글자를 통째로 지운다. 그래서 그 슬롯만 같은 팔레트의 base01 로 올려 뒀다(#586e75).
//    ⚠ 다른 슬롯까지 «종전보다 낫다» 는 뜻이 아니다. 공식값을 그대로 싣는 bright 계열은 폴백보다 낮아진다
//     (실측 #002b36 위: brightGreen 9.30→2.79 · brightYellow 12.09→3.37 · brightMagenta 4.56→3.43 · brightRed 3.59→3.26).
//     그 대비는 Solarized 의 설계(bright 넷 = 회색 계단)이고, 읽기가 우선이면 고대비 변형(3번)을 고르는 것이 이 PR 의 답이다.
{
  const { theme } = THEMES.solarized;
  assert.notEqual(theme.brightBlack, theme.background, "Solarized brightBlack 이 배경색과 같으면 그 글자는 보이지 않는다");
  const XTERM_FALLBACK_BRIGHT_BLACK = 2.05; // 종전에 떨어지던 값(#555753 on #002b36)
  assert.ok(contrast(theme.brightBlack, theme.background) > XTERM_FALLBACK_BRIGHT_BLACK,
    "Solarized brightBlack 이 종전 폴백보다 읽히지 않는다 — 이 변경의 목적과 반대다");
  ok("'solarized' brightBlack 이 종전 폴백보다 읽힌다");
}

// 6. 공식 값을 쓰는 테마는 임의로 '보기 좋게' 고치지 않는다 — 대비가 필요하면 고대비 변형이 할 일이다.
//    (위 brightBlack 하나가 유일한 예외이고, 그 이유는 terminal.ts 주석에 적혀 있다.)
assert.equal(THEMES.solarized.theme.blue, "#268bd2", "Solarized 공식 blue(base 스펙)를 바꾸지 않는다");
assert.equal(THEMES.nord.theme.brightBlack, "#4c566a", "Nord 공식 brightBlack(nord3)을 바꾸지 않는다");
// brightGreen 이 회색(base01)인 것은 Solarized 공식 매핑이다 — 복붙 실수로 오해받기 쉬워 여기 고정한다.
assert.equal(THEMES.solarized.theme.brightGreen, "#586e75", "Solarized 공식 brightGreen(base01)을 바꾸지 않는다");
ok("공식 팔레트 값 유지(대비가 낮아도 손대지 않는다)");

// 7. 테마 키 해석 — 하이픈이 든 키도 그대로 찾아지고, 모르는 키는 auto 로 떨어진다.
assert.equal(resolveTheme(HC_KEY).brightBlack, THEMES[HC_KEY].theme.brightBlack, `'${HC_KEY}' 키가 그대로 해석돼야 한다`);
assert.ok(resolveTheme("없는-테마-키").background, "모르는 키는 auto 팔레트로 떨어져야 한다");
ok("테마 키 해석(하이픈 키·미지의 키)");

console.log(`\n${pass} passed`);
