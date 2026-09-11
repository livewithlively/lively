// 선언 안 된 CSS 변수를 대체값 없이 쓰지 못하게 고정한다(#3778).
//
// 왜 필요한가: `var(--없는-이름)` 은 오류가 아니라 **그 선언 한 줄을 조용히 무효로 만든다**(계산값 시점 무효 →
//  상속값·초기값으로 돌아간다). 화면이 깨지는 게 아니라 «원래 브라우저 모양» 이 되어서 문자열 검사도 눈검수도
//  잘 못 잡는다. 좌측 사이드바 `.v2-app-list:hover` 의 스크롤바 색이 #1883 부터 그랬다 — 쓰던 토큰이 한 번도
//  선언된 적이 없어, 손을 얹는 순간 브라우저 기본 스크롤바가 밝은 트랙째 끼어들어 «사이드바에 흰 세로줄» 로 보였다
//  (헤드리스 computed 실측: 평소 `rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)` → 손 얹으면 `auto`).
//
// dark-theme-contract ④ 가 «선언 쪽 유령 변수»(다크에만 있는 이름)를 막는다면, 이 테스트는 «쓰는 쪽 유령 변수» 를 막는다.
//
// 선언으로 인정하는 자리 —
//  · public/styles/*.css 어디든 `--이름:` (index.html 이 싣는 스타일시트 세트 — 셀렉터가 달라도 상속으로 닿는다고 본다)
//  · web/**/*.ts 가 런타임에 박는 것 — `setProperty('--이름'` · 인라인 style 문자열 `'--이름:'` (예: `style: '--tag:' + color`)
//  · public/index.html 의 인라인 style
//  web/standalone 은 terminal.html 전용 번들이라 이 스타일시트 세트에 닿지 않아 뺀다.
// `var(--이름, 대체값)` 처럼 대체값을 준 쓰임은 의도로 보고 세지 않는다. 주석 안의 것은 쓰임도 선언도 아니다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** 주석을 같은 길이의 공백으로 덮는다 — 줄 번호를 지키려고 지우지 않는다. */
const blankComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

/** 런타임 선언으로 읽을 소스인가 — terminal.html 전용 번들은 이 스타일시트 세트와 무관하다. */
const isRuntimeSource = (relPath) => relPath.endsWith(".ts") && !relPath.split(/[\\/]/).includes("standalone");

/**
 * @param {{ sheets: {file: string, css: string}[], runtime: string[] }} input
 * @returns {{ declared: Set<string>, uses: number, ghosts: Map<string, string[]> }}
 */
function findUndeclaredVars({ sheets, runtime }) {
  const code = sheets.map(({ file, css }) => ({ file, css: blankComments(css) }));
  const declared = new Set();
  for (const { css } of code) for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) declared.add(m[1]);
  for (const src of runtime) {
    for (const m of src.matchAll(/setProperty\(\s*['"`](--[A-Za-z0-9_-]+)/g)) declared.add(m[1]);
    for (const m of src.matchAll(/(--[A-Za-z0-9_-]+)['"`]?\s*:/g)) declared.add(m[1]);
  }
  const ghosts = new Map();
  let uses = 0;
  for (const { file, css } of code) {
    for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
      uses++;
      if (declared.has(m[1])) continue;
      const at = `${file}:${css.slice(0, m.index).split("\n").length}`;
      ghosts.set(m[1], [...(ghosts.get(m[1]) || []), at]);
    }
  }
  return { declared, uses, ghosts };
}

/** 부채 목록 대조 — 새 유령(fresh)과 이미 고쳐졌는데 목록에 남은 이름(stale). */
const againstDebt = (ghosts, debt) => ({
  fresh: [...ghosts.keys()].filter((n) => !debt.has(n)).sort(),
  stale: [...debt].filter((n) => !ghosts.has(n)).sort(),
});

// ── 시나리오(사양 엣지 표) ─────────────────────────────────────────────────────────
const scan = (sheets, runtime = []) => findUndeclaredVars({ sheets, runtime }).ghosts;
const one = (css) => [{ file: "a.css", css }];

// E1 미선언 + 대체값 없음 → 잡힌다(파일:줄)
assert.deepEqual([...scan(one(".x {}\n.y:hover { scrollbar-color: var(--ghost) transparent; }"))], [["--ghost", ["a.css:2"]]], "E1");
// E2 대체값 있으면 세지 않는다
assert.equal(scan(one(".y { color: var(--ghost, #123); }")).size, 0, "E2");
// E3 다른 스타일시트의 선언도 선언이다
assert.equal(scan([{ file: "base.css", css: ":root { --tok: #fff; }" }, { file: "b.css", css: ".y { color: var(--tok); }" }]).size, 0, "E3");
// E4 TS setProperty 로 런타임에 박는 이름
assert.equal(scan(one(".y { width: var(--side-w); }"), ["el.style.setProperty('--side-w', w + 'px');"]).size, 0, "E4");
// E5 TS 인라인 style 문자열
assert.equal(scan(one(".tag { background: var(--tag); }"), ["el('span', { style: '--tag:' + color })"]).size, 0, "E5");
// E6 주석 안의 쓰임은 쓰임이 아니다
assert.equal(scan(one("/* 예전엔 var(--ghost) 였다 */\n.y { color: red; }")).size, 0, "E6");
// E7 주석 안의 선언은 선언이 아니다
assert.deepEqual([...scan(one("/* :root { --ghost: #fff; } */\n.y { color: var(--ghost); }")).keys()], ["--ghost"], "E7");
// E8·E9 부채 목록 — 줄기만 한다
assert.deepEqual(againstDebt(new Map([["--old", ["a.css:1"]]]), new Set(["--old"])), { fresh: [], stale: [] }, "E9");
assert.deepEqual(againstDebt(new Map(), new Set(["--old"])), { fresh: [], stale: ["--old"] }, "E8");
assert.deepEqual(againstDebt(new Map([["--new", ["a.css:1"]]]), new Set(["--old"])), { fresh: ["--new"], stale: ["--old"] }, "E1+E8");
// E11 괄호 안 공백
assert.deepEqual([...scan(one(".y { color: var( --ghost ); }")).keys()], ["--ghost"], "E11");
// E12 TS 의 쉼표 대체값 쓰임은 선언이 아니다
assert.deepEqual([...scan(one(".y { font-family: var(--mono); }"), ["`font-family: var(--mono, ui-monospace)`"]).keys()], ["--mono"], "E12");
// E13 standalone 번들은 런타임 선언 소스가 아니다
assert.equal(isRuntimeSource("v2/side.ts"), true, "E13 a");
assert.equal(isRuntimeSource("standalone/terminal.ts"), false, "E13 b");
assert.equal(isRuntimeSource("v2/side.js"), false, "E13 c");
// E14 중첩 — 바깥은 대체값이 있고 안쪽만 없다
assert.deepEqual([...scan(one(".y { color: var(--a, var(--b)); }")).keys()], ["--b"], "E14");
// E15 이름 경계 — 숫자·밑줄까지 한 이름, 접두만 선언돼 있어도 다른 이름이다
assert.equal(scan([{ file: "base.css", css: ":root { --muted-3-line: #ccc; --a_b: 1px; }" }, { file: "b.css", css: ".y { color: var(--muted-3-line); width: var(--a_b); }" }]).size, 0, "E15 a");
assert.deepEqual([...scan([{ file: "base.css", css: ":root { --muted: #ccc; }" }, { file: "b.css", css: ".y { color: var(--muted-3-line); }" }]).keys()], ["--muted-3-line"], "E15 b");

// ── 실제 레포 ──────────────────────────────────────────────────────────────────────
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const styleDir = join(root, "public/styles");
const sheets = readdirSync(styleDir).filter((n) => n.endsWith(".css")).sort()
  .map((n) => ({ file: `public/styles/${n}`, css: readFileSync(join(styleDir, n), "utf8") }));
const runtime = [
  ...readdirSync(join(root, "web"), { recursive: true }).filter(isRuntimeSource).map((p) => readFileSync(join(root, "web", p), "utf8")),
  readFileSync(join(root, "public/index.html"), "utf8"),
];
const { declared, uses, ghosts } = findUndeclaredVars({ sheets, runtime });

// E10 배선 — 아무것도 안 읽고 통과하는 것을 막는다(경로가 옮겨지면 여기서 먼저 빨갛게 된다)
assert.ok(sheets.length >= 40, `스타일시트를 못 읽었다(${sheets.length}개) — public/styles 경로가 바뀌었나`);
assert.ok(declared.has("--muted-3-line") && declared.size > 150, `선언을 못 읽었다(${declared.size}개)`);
assert.ok(uses > 1000, `대체값 없는 var() 쓰임을 거의 못 읽었다(${uses}건) — 매처가 죽었나`);

// 이미 있던 부채 — 이 목록은 **줄기만 한다.** 고쳤으면 여기서 지운다(안 지우면 아래 ② 가 실패한다).
// 새 이름을 여기에 더하지 마라 — 있는 토큰으로 바꾸거나, 새 토큰이면 01-base.css :root 와 90-dark.css 두 블록에 함께 선언하라.
// (2026-09-11, #3778 에서 사이드바 스크롤바를 고치며 함께 발견. 화면마다 의도한 색을 확인해야 해 그 작업 범위 밖으로 남겼다.)
const KNOWN_DEBT = new Set([
  "--bg-danger",  // 07-knowledge-map · 13-projects · 16/17-projects-board
  "--bg-soft",    // 16-projects-board
  "--ink-faint",  // 27-start-onboarding
  "--text",       // 32-file-share
  "--mono",       // 40-v2 — 다른 자리는 전부 var(--mono, ui-monospace, monospace)
  "--bg-sub",     // 40-v2
]);
const { fresh, stale } = againstDebt(ghosts, KNOWN_DEBT);
const where = (names) => names.map((n) => `${n} ← ${ghosts.get(n).join(", ")}`).join("\n   ");
console.log(`# CSS 변수 — 스타일시트 ${sheets.length}개 · 선언 ${declared.size}개 · 대체값 없는 쓰임 ${uses}건 · 미선언 이름 ${ghosts.size}개(알려진 부채 ${KNOWN_DEBT.size})`);

// ① 새 유령 변수 금지
assert.deepEqual(fresh, [],
  `★ 선언된 적 없는 CSS 변수를 대체값 없이 쓴다 — 그 선언 한 줄이 통째로 무효가 되어 브라우저 기본값으로 돌아간다:\n   ${where(fresh)}\n` +
  `   → 있는 토큰으로 바꾸거나(01-base.css), 새 토큰이면 01-base.css :root 와 90-dark.css 두 블록에 함께 선언하라.`);
// ② 부채 목록은 줄기만 한다 — 고쳐졌는데 목록에 남으면 다음 사람이 그 이름을 다시 써도 안 걸린다.
assert.deepEqual(stale, [], `★ 이미 고쳐진 이름이 KNOWN_DEBT 에 남아 있다 — 목록에서 지워라: ${stale.join(", ")}`);

console.log("✓ 대체값 없는 var() 는 전부 선언된 이름을 가리킨다(알려진 부채 제외) · 시나리오 E1~E15");
