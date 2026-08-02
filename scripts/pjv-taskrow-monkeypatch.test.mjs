// pjvTaskRow 몽키패치 — '정의와 패치가 한 모듈, 소비자는 live binding' 불변식 가드 (#1313 R35)
//  태스크 행 렌더러 pjvTaskRow 는 **정의 뒤에 IIFE 2개가 런타임에 갈아끼우는** 바인딩이다:
//   ① __tmWrapped    — 제목 클릭 → 태스크 상세 모달(pjvOpenTaskModal) 배선
//   ② __cfDblWrapped — ① 의 결과를 다시 감싸, 행 캡처 단계에서 단일/더블 클릭을 가른다
//                      (1회=240ms 뒤 모달 · 2회=하위 태스크 인라인 추가 pjvShowInlineSubtask)
//  R35 가 이 셋을 web/projects.ts 에서 web/projects/detail-tasks.ts 로 함께 옮겼다. 함께가 핵심이다.
//
// 이 불변식이 깨지면 실제로 나는 일:
//  🔴 정의와 패치가 다른 모듈로 갈리면 — 로드 순서에 따라 패치가 아예 안 붙거나(가드 typeof 로 조용히 return)
//     붙어도 소비자가 잡은 값과 달라진다. 태스크 제목을 눌러도 아무 일이 없다(죽은 클릭).
//  🔴 배럴이 `export … from` 이 아니라 값 복사(import 후 로컬 재수출)로 바뀌면 — 소비자(taskmodal 의 하위
//     태스크 목록 등)가 **패치 이전 함수**를 굳혀 잡는다. 같은 화면인데 어떤 행은 모달이 열리고 어떤 행은 안 열린다.
//  🔴 두 IIFE 의 순서가 뒤집히면 — ② 가 감싸는 대상이 ① 이 아니게 되어 캡처 단계의 stopImmediatePropagation
//     이 제목 click(모달)을 못 눌러 단일클릭에 모달이 두 번 열린다.
//
// 러너는 web/ 을 수집하지 않으므로(src/**/*.test.ts 와 kit|scripts|deploy/**/*.test.mjs 만) 브라우저가 실제로
// 싣는 컴파일 산출물 public/app/projects/detail-tasks.js 를 읽어, 두 IIFE 의 **원문 그대로**를 vm 에서 돌린다
// (pjv-selection-singleton.test.mjs 동형 — 감싸이는 pjvTaskRow 본체만 최소 스텁으로 세운다).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS = readFileSync(join(root, "web/projects/detail-tasks.ts"), "utf8");
const JS = readFileSync(join(root, "public/app/projects/detail-tasks.js"), "utf8");
const BARREL = readFileSync(join(root, "web/projects.ts"), "utf8");
const DOOR = readFileSync(join(root, "web/projects/detail.ts"), "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ════════ ① 동거 — 정의와 패치 2개가 같은 모듈, 그 순서로 ════════
{
  const def = TS.indexOf("\nfunction pjvTaskRow(");
  const p1 = TS.indexOf("(pjvTaskRow as any).__tmWrapped = true;");
  const p2 = TS.indexOf("(pjvTaskRow as any).__cfDblWrapped = true;");
  assert.ok(def >= 0, "detail-tasks.ts 에 pjvTaskRow 정의가 없다 — 정의가 다른 모듈로 샜다");
  assert.ok(p1 >= 0 && p2 >= 0, "몽키패치 IIFE 2개(__tmWrapped·__cfDblWrapped)가 정의와 같은 모듈에 없다");
  assert.ok(def < p1 && p1 < p2, "배치 순서가 '정의 → __tmWrapped → __cfDblWrapped' 가 아니다");
  ok("① detail-tasks.ts 안에 정의 → __tmWrapped → __cfDblWrapped 순으로 인접 배치");

  // 정의 사본 0 — 사본이 생기면 패치된 쪽과 안 된 쪽이 공존한다.
  const files = readdirSync(join(root, "web"), { recursive: true })
    .filter((p) => typeof p === "string" && p.endsWith(".ts") && p !== join("projects", "detail-tasks.ts"));
  const dup = files.filter((f) => /^(?:export )?(?:async )?function pjvTaskRow\b/m.test(readFileSync(join(root, "web", f), "utf8")));
  assert.deepEqual(dup, [], `pjvTaskRow 정의 사본 발견(패치가 갈린다): ${dup.join(", ")}`);
  ok("① pjvTaskRow 정의는 detail-tasks.ts 단 한 곳(web/ 전역 사본 0)");
}

// ════════ ② live binding — 배럴은 값 복사가 아니라 재수출 체인 ════════
{
  // detail-tasks → detail.ts → projects.ts 두 홉 모두 `export … from` 이어야 한다.
  assert.match(DOOR, /export \{[^}]*\bpjvTaskRow\b[^}]*\} from '\.\/detail-tasks\.js'/,
    "projects/detail.ts 가 pjvTaskRow 를 `export … from './detail-tasks.js'` 로 중계하지 않는다");
  assert.match(BARREL, /export \{[^}]*\bpjvTaskRow\b[^}]*\} from '\.\/projects\/detail\.js'/,
    "projects.ts 가 pjvTaskRow 를 `export … from './projects/detail.js'` 로 재수출하지 않는다");
  ok("② 재수출 체인 detail-tasks → detail.ts → projects.ts 가 둘 다 `export … from`(live binding)");

  // 값 복사 경로 금지 — 어느 파일도 pjvTaskRow 를 import 해서 로컬 상수/변수에 굳히면 안 된다.
  const files = readdirSync(join(root, "web"), { recursive: true }).filter((p) => typeof p === "string" && p.endsWith(".ts"));
  const frozen = files.filter((f) => /^\s*(?:const|let|var) [A-Za-z_$][\w$]* = pjvTaskRow\s*;/m.test(readFileSync(join(root, "web", f), "utf8"))
    && f !== join("projects", "detail-tasks.ts"));   // 소유 모듈 안의 _origPjvTaskRow/_inner 는 패치 자신의 체인이다
  assert.deepEqual(frozen, [], `pjvTaskRow 를 로컬로 복사한 파일(패치 이전 함수를 굳힌다): ${frozen.join(", ")}`);
  ok("② 소유 모듈 밖에 pjvTaskRow 사본 대입 0 — 소비자는 import 바인딩으로만 부른다");
}

// ════════ ③ 행동 — 두 IIFE 원문을 돌려 교체·순서·멱등을 확인 ════════
//  컴파일 산출물에서 IIFE 2개를 **그대로** 떼어 최소 DOM 스텁 위에서 실행한다(로직 재작성 없음).
function iife(src, flag) {
  const at = src.indexOf(`pjvTaskRow.${flag} = true;`);
  assert.notEqual(at, -1, `${flag} IIFE 를 산출물에서 못 찾음 — 패치가 사라졌나?`);
  const start = src.lastIndexOf("\n(function () {", at);
  const end = src.indexOf("\n})();", at);
  assert.ok(start !== -1 && end !== -1 && end > at, `${flag} IIFE 경계를 못 찾음`);
  return src.slice(start + 1, end + 6);
}
const IIFE_TM = iife(JS, "__tmWrapped");
const IIFE_DBL = iife(JS, "__cfDblWrapped");

function sandbox() {
  const log = [];
  const listener = (kind) => (type, fn, capture) => log.push({ kind, type, capture: capture === true });
  const titleEl = { dataset: {}, classList: { add() {} }, title: "", addEventListener: listener("title") };
  const rowEl = { dataset: {}, addEventListener: listener("row"), querySelector: () => null };
  const subBox = { hidden: true };
  const node = {
    querySelector: (s) => (s === ".pjv-trow-title" ? titleEl : s === ".pjv-trow" ? rowEl : s === ".pjv-trow-subs" ? subBox : null),
  };
  const base = function pjvTaskRow() { log.push({ kind: "base" }); return node; };
  const ctx = createContext({
    pjvTaskRow: base,
    pjvOpenTaskModal() {}, pjvShowInlineSubtask() {},
    setTimeout() {}, clearTimeout() {},
  });
  return { log, ctx, base };
}
{
  const { log, ctx, base } = sandbox();
  runInContext(IIFE_TM, ctx);
  const after1 = runInContext("pjvTaskRow", ctx);
  assert.notEqual(after1, base, "① IIFE 를 돌렸는데 pjvTaskRow 가 그대로다 — 재할당(몽키패치)이 안 먹었다");
  assert.equal(after1.__tmWrapped, true, "__tmWrapped 플래그가 안 섰다");

  runInContext(IIFE_TM, ctx);   // 가드(__tmWrapped) — 다시 돌려도 재-래핑 없음
  assert.equal(runInContext("pjvTaskRow", ctx), after1, "① IIFE 재실행에 다시 감싸졌다 — __tmWrapped 가드가 무력화됐다");

  runInContext(IIFE_DBL, ctx);
  const after2 = runInContext("pjvTaskRow", ctx);
  assert.notEqual(after2, after1, "② IIFE 를 돌렸는데 pjvTaskRow 가 그대로다");
  assert.equal(after2.__cfDblWrapped, true, "__cfDblWrapped 플래그가 안 섰다");
  runInContext(IIFE_DBL, ctx);  // 가드(__cfDblWrapped)
  assert.equal(runInContext("pjvTaskRow", ctx), after2, "② IIFE 재실행에 다시 감싸졌다 — __cfDblWrapped 가드가 무력화됐다");
  ok("③ 두 IIFE 가 pjvTaskRow 를 순서대로 교체하고, 각자 플래그 가드로 재-래핑을 막는다");

  // 최종 함수 1회 호출 = 원본 1회 + 제목 click(버블) + 행 click(캡처) 각 1회.
  log.length = 0;
  runInContext("pjvTaskRow(7, { id: 1 }, [], function () {}, 0, [])", ctx);
  assert.deepEqual(log, [
    { kind: "base" },
    { kind: "title", type: "click", capture: false },
    { kind: "row", type: "click", capture: true },
  ], `배선 결과가 다르다: ${JSON.stringify(log)}`);
  ok("③ 패치본 1회 호출 — 원본 호출 + 제목 click(버블) + 행 click(캡처) 각 1회");
}

console.log(`\n${pass} passed — pjvTaskRow 몽키패치 동거·live binding 불변식 (#1313 R35)`);
