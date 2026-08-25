// 다크 테마 계약 고정(#1683) — 90-dark.css 는 같은 토큰 집합을 **두 번** 싣는다:
//   ① :root[data-theme="dark"]                       — 사람이 명시적으로 다크를 고른 경우
//   ② @media (prefers-color-scheme:dark) :root:not([data-theme="light"]) — 시스템 따름
// 왜 중복인가: 평문 CSS 에는 선언 묶음을 재사용할 문법이 없고(믹스인 없음), 이 레포의 스타일은 빌드를 거치지
//  않는 정적 자산이라(public/styles/README) 생성으로 풀 수도 없다. 대신 **두 벌이 갈라지는 것**을 여기서 막는다 —
//  갈라지면 증상이 고약하다: "OS 다크로 볼 땐 멀쩡한데 토글로 다크를 고르면 특정 색만 라이트" 같은,
//  재현 조건이 사람 설정에 숨는 버그가 된다.
//
// 함께 고정하는 것:
//  · 라이트에 있는 색 토큰은 다크에도 전부 있어야 한다(빠지면 그 토큰만 라이트 값으로 남아 다크에서 튄다).
//  · 다크 전용 토큰을 새로 만들 수 없다(라이트에 없는 이름은 라이트에서 미선언 = 유령 변수 재발).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dark = readFileSync(join(root, "public/styles/90-dark.css"), "utf8");
const base = readFileSync(join(root, "public/styles/01-base.css"), "utf8");

/** 블록 본문에서 `--이름: 값;` 을 뽑아 Map 으로. 주석은 제거한다. */
const declsOf = (css) => {
  const out = new Map();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim().replace(/\s+/g, " "));
  }
  return out;
};
/** 여는 중괄호 위치에서 짝이 맞는 닫는 중괄호까지 — 중첩(@media)을 건너뛰기 위해 센다. */
const blockAt = (css, openIdx) => {
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(openIdx + 1, i);
  }
  throw new Error("닫히지 않은 블록");
};

// ① 명시 선택 블록
const iExplicit = dark.indexOf('{', dark.indexOf(':root[data-theme="dark"]'));
const explicit = declsOf(blockAt(dark, iExplicit));
// ② 시스템 따름 블록 — @media 안의 :root:not([data-theme="light"])
const iSystem = dark.indexOf('{', dark.indexOf(':root:not([data-theme="light"])'));
const system = declsOf(blockAt(dark, iSystem));

console.log(`# 다크 토큰 — 명시 ${explicit.size}개 · 시스템 ${system.size}개`);

assert.ok(explicit.size > 40, "명시 다크 블록이 비었거나 파싱에 실패했다");
assert.deepEqual([...system.keys()].sort(), [...explicit.keys()].sort(),
  "★ 두 다크 블록의 토큰 목록이 다르다 — 한쪽에만 추가하면 그 토큰은 다른 경로에서 라이트 값으로 남는다");
for (const [k, v] of explicit) {
  assert.equal(system.get(k), v, `★ 토큰 ${k} 의 값이 두 블록에서 다르다 (명시 "${v}" vs 시스템 "${system.get(k)}")`);
}

// ③ 라이트 :root 의 색 토큰은 전부 다크에도 있어야 한다.
//    예외는 선언 옆에 `(theme-invariant)` 라고 적는다 — 의도가 토큰이 사는 자리에 남아야 다음 사람이 안다.
//    (--on-fill: 채운 색 위 글자는 양 테마 공통 백색 · --dark-1/2: 클로징 밴드는 두 테마에서 다 어둡다)
const lightRootRaw = blockAt(base, base.indexOf("{", base.indexOf(":root")));
const lightRoot = declsOf(lightRootRaw);
const invariant = new Set();
for (const m of lightRootRaw.matchAll(/(--[a-z0-9-]+)\s*:[^;]+;[^\n]*theme-invariant/g)) invariant.add(m[1]);
const isColor = (v) => /#[0-9a-fA-F]{3,8}|rgba?\(|color-mix|^\d+\s*,\s*\d+\s*,\s*\d+$/.test(v);
const missing = [...lightRoot].filter(([k, v]) => isColor(v) && !explicit.has(k) && !invariant.has(k)).map(([k]) => k);
assert.deepEqual(missing, [],
  `★ 라이트에만 있는 색 토큰이 있다 — 다크에서 라이트 값 그대로 튄다: ${missing.join(", ")}\n` +
  `   의도한 것이면 01-base.css 그 선언 옆에 '(theme-invariant)' 와 사유를 적어라.`);
console.log(`# 테마 불변 예외 ${invariant.size}개: ${[...invariant].join(", ")}`);

// ④ 다크 전용 토큰 금지 — 라이트(01-base :root)에 없는 이름은 유령 변수가 된다.
const orphan = [...explicit.keys()].filter((k) => !lightRoot.has(k));
assert.deepEqual(orphan, [],
  `★ 라이트에 선언이 없는 다크 전용 토큰: ${orphan.join(", ")} — 01-base.css :root 에 라이트 값을 먼저 두어라`);

// ⑤ 자기참조 금지 — `--x: var(--x)` 는 순환이라 **그 토큰이 통째로 무효**가 된다(unset). 값이 사라지는데
//    CSS 는 조용해서, 화면 전체가 색을 잃고서야 알게 된다. 리터럴→토큰 일괄 치환이 토큰 **정의 파일**을
//    지나가면 한 번에 수십 개가 이렇게 된다 — 이 프로젝트에서 실제로 두 번 밟았다.
for (const [file, css] of [["01-base.css", base], ["90-dark.css", dark]]) {
  const cycles = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (m[2].includes(`var(${m[1]})`)) cycles.push(m[1]);
  }
  assert.deepEqual(cycles, [],
    `★ ${file} 에 자기참조 토큰이 있다 — 그 토큰은 무효(unset)가 되어 화면에서 색이 사라진다: ${cycles.join(", ")}`);
}

console.log("✓ 다크 테마 계약 — 두 블록 일치 · 라이트/다크 토큰 집합 일치");
