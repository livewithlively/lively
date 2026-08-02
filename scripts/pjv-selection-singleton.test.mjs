// 다중선택/드래그 싱글턴 — 'document 리스너 1회 등록' 불변식 가드 (#1313 R33)
//  web/projects.ts 에서 web/projects/selection.ts 로 떼어낸 세 개의 **1회-등록 관문**을 못박는다:
//   · pjvSelRenderBar — 하단 벌크바를 처음 만들 때 keydown(Esc=선택 해제)을 함께 1회
//   · pjvDragInit     — pjvDrag._init 가드로 pointerover/pointerup 을 1회
//   · pjvReorderInit  — pjvReorder._init 가드로 pointermove/pointerup 을 1회
//  셋 다 **플래그(pjvBulkBarEl·pjvDrag._init·pjvReorder._init)와 addEventListener 가 같은 모듈 스코프에
//  있어야만** 성립한다. 분해 중 플래그와 등록 코드가 다른 모듈로 갈리거나 모듈 사본이 생기면 가드가 무력화된다.
//
// 이 불변식이 깨지면 실제로 나는 일:
//  🔴 체크박스 드래그 한 번에 pointerover 핸들러가 두 번 돌아 범위 페인트가 두 겹으로 칠해진다(선택이 튄다).
//  🔴 행 재정렬 pointerup 이 두 번 발화해 tasks-reorder 를 두 번 POST 한다.
//  🔴 Esc 한 번에 keydown 이 두 번 돌아 선택 해제가 중복 실행된다.
//
// 러너는 web/ 을 수집하지 않으므로(src/**/*.test.ts 와 kit|scripts|deploy/**/*.test.mjs 만) 브라우저가
// 실제로 싣는 컴파일 산출물 public/app/projects/selection.js 를 읽어, 그 **원문 그대로**를 vm 에서 돌린다
// (block-editor-roundtrip.test.mjs · session-status.test.mjs 동형 — 다만 이 모듈은 DOM 의존이라 import 대신
//  해당 선언만 떼어 최소 DOM 스텁 위에서 실행한다).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS = readFileSync(join(root, "web/projects/selection.ts"), "utf8");
const JS = readFileSync(join(root, "public/app/projects/selection.js"), "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// 최상위 선언 떼어내기 — tsc 산출물은 최상위가 0칸, 본문이 4칸이라 닫는 '}' 가 열 0에 온다.
function topLevelFn(src, name) {
  const head = `function ${name}(`;
  const i = src.indexOf(`\n${head}`);
  assert.notEqual(i, -1, `${name} 선언을 못 찾음 — 이름이 바뀌었나?`);
  const end = src.indexOf("\n}\n", i);
  assert.notEqual(end, -1, `${name} 본문 끝을 못 찾음`);
  return src.slice(i + 1, end + 3);
}
function topLevelDecl(src, name) {
  const m = src.match(new RegExp(`^(?:const|let) ${name} = .*$`, "m"));
  assert.notEqual(m, null, `${name} 선언을 못 찾음`);
  return m[0];
}

// ════════ ① 구조 — document 리스너 등록은 세 관문 안에만 있다 ════════
{
  const tsHits = [...TS.matchAll(/document\.addEventListener\(\s*'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(tsHits, ["keydown", "pointermove", "pointerover", "pointerup", "pointerup"],
    `selection.ts 의 document 리스너 목록이 바뀌었다: ${JSON.stringify(tsHits)}`);
  ok("① 등록 지점 5개(keydown·pointerover·pointerup·pointermove·pointerup) — 그 이상도 이하도 아님");

  // 각 등록이 어느 최상위 함수 안에 있는지(컴파일 산출물 기준 — 최상위 '}' 로 구간이 갈린다)
  const owners = new Set();
  const bounds = [...JS.matchAll(/^function ([A-Za-z_$][\w$]*)\(/gm)].map((m) => ({ name: m[1], at: m.index }));
  for (const m of JS.matchAll(/document\.addEventListener\(/g)) {
    let owner = null;
    for (const b of bounds) if (b.at < m.index) owner = b.name; else break;
    owners.add(owner);
  }
  assert.deepEqual([...owners].sort(), ["pjvDragInit", "pjvReorderInit", "pjvSelRenderBar"],
    `등록이 1회-등록 관문 밖으로 샜다: ${JSON.stringify([...owners])}`);
  ok("① 등록 지점의 소속 함수 = {pjvSelRenderBar, pjvDragInit, pjvReorderInit} 뿐");

  // 관문의 가드가 등록보다 **먼저** 온다(가드 뒤에 등록이면 매 호출마다 붙는다).
  for (const [fn, guard] of [["pjvDragInit", "pjvDrag._init = true"], ["pjvReorderInit", "pjvReorder._init = true"]]) {
    const body = topLevelFn(JS, fn);
    assert.ok(body.indexOf(guard) < body.indexOf("document.addEventListener"), `${fn}: 가드가 등록보다 뒤에 있다`);
    ok(`① ${fn} — _init 가드가 등록보다 앞선다`);
  }
  const bar = topLevelFn(JS, "pjvSelRenderBar");
  const guardOpen = bar.indexOf("if (!pjvBulkBarEl) {");
  assert.ok(guardOpen >= 0 && guardOpen < bar.indexOf("document.addEventListener"), "pjvSelRenderBar: keydown 이 !pjvBulkBarEl 가드 밖이다");
  ok("① pjvSelRenderBar — keydown 등록이 최초 1회(!pjvBulkBarEl) 블록 안에 있다");
}

// ════════ ② 소유 — 플래그와 등록이 한 모듈에 산다(사본 0) ════════
{
  const files = readdirSync(join(root, "web"), { recursive: true })
    .filter((p) => typeof p === "string" && p.endsWith(".ts") && p !== join("projects", "selection.ts"));
  for (const flag of ["pjvDrag", "pjvReorder", "pjvBulkBarEl"]) {
    const dup = files.filter((f) => new RegExp(`^(?:const|let|var) ${flag}\\b`, "m").test(readFileSync(join(root, "web", f), "utf8")));
    assert.deepEqual(dup, [], `${flag} 선언 사본 발견(가드가 갈린다): ${dup.join(", ")}`);
  }
  ok("② pjvDrag·pjvReorder·pjvBulkBarEl 선언은 selection.ts 단 한 곳(web/ 전역 사본 0)");

  // 관문 호출은 이 모듈 안에서만 — 밖에서 부를 수 있으면 등록 경로가 둘이 된다.
  const outside = files.filter((f) => /pjv(Drag|Reorder)Init\s*\(/.test(readFileSync(join(root, "web", f), "utf8")));
  assert.deepEqual(outside, [], `pjvDragInit/pjvReorderInit 외부 호출: ${outside.join(", ")}`);
  ok("② pjvDragInit·pjvReorderInit 호출부도 selection.ts 안에만(pjvRowCheck·pjvRowGrip)");
}

// ════════ ③ 행동 — 두 번 진입해도 등록은 1회 ════════
//  컴파일 산출물의 **원문 그대로**를 최소 DOM 스텁 위에서 돌린다(로직 재작성 없음).
function sandbox() {
  const reg = [];
  const node = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    replaceChildren() {}, append() {}, setAttribute() {}, querySelector: () => null,
    style: {}, dataset: {},
  });
  return {
    reg,
    ctx: createContext({
      document: { addEventListener: (t) => reg.push(t), body: { append() {} }, querySelectorAll: () => [], querySelector: () => null },
      el: node, sv: node,
      pjvSel: { kind: null, ids: new Set(), items: new Map(), ctx: null },
      pjvSelReset() {}, pjvDragEnd() {}, pjvDragPaint() {}, pjvReorderMove() {}, pjvReorderEnd() {},
    }),
  };
}
for (const [label, decls, fn, want] of [
  ["pjvDragInit", ["pjvDrag"], "pjvDragInit", ["pointerover", "pointerup"]],
  ["pjvReorderInit", ["pjvReorder"], "pjvReorderInit", ["pointermove", "pointerup"]],
  ["pjvSelRenderBar", ["pjvBulkBarEl"], "pjvSelRenderBar", ["keydown"]],
]) {
  const { reg, ctx } = sandbox();
  runInContext([...decls.map((d) => topLevelDecl(JS, d)), topLevelFn(JS, fn)].join("\n"), ctx);
  runInContext(`${fn}(); ${fn}(); ${fn}();`, ctx);
  assert.deepEqual(reg, want, `${fn} 를 3번 불렀는데 등록이 ${JSON.stringify(reg)} — 1회 등록 불변식이 깨졌다`);
  ok(`③ ${label} — 3번 호출해도 document 리스너는 ${want.join("·")} 각 1회`);
}

console.log(`\n${pass} passed — 다중선택/드래그 싱글턴 1회 등록 불변식 (#1313 R33)`);
