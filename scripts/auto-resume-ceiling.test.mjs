// #1820 후속 — "자동복원이 무한 연쇄가 되지 않는가"의 판정 표를 고정한다.
//
// 왜 이 테스트가 필요한가: #1820 은 "열면 되살린다"를 도입하며 스스로 불변식을 적었다 —
//  *"실패하면 이 기록 화면과 버튼이 그대로 남는다(자동이 막다른 길을 만들지 않는다)"*.
//  그런데 **성공했는데 되살아나지 않은 경우**가 빠져 있었다: 복원은 새 세션 id 로 주소를 옮기고, 그러면
//  화면이 새로 떠 화면 단위 가드(resumeAuto)가 리셋된다. 새 세션도 죽어 있으면 그 연쇄가 끝나지 않는다.
//  실측(2026-08-25 매니지드 도그푸드): 세션 컨테이너가 사라진 뒤 그 세션을 열자 '이어받기'가 무한 반복됐다.
// 눈으로 확인하기 비싼 갈림길이다 — 재현하려면 살아 있던 세션의 컨테이너를 실제로 죽여야 하고, 증상은
//  화면을 열어야 보인다. 그래서 판정을 순수 함수로 떼어 표로 고정한다.
// 틀리면 티가 크다:
//   🔴 상한이 없으면 — 사용자는 무한 루프를 본다(이번 사고 그 자체).
//   🔴 상한이 너무 빡세면 — 정상적인 자동복원(재부팅 뒤 첫 열기)이 안 걸려 #1820 이 도로 죽는다.
//   🔴 창(window)이 안 풀리면 — 한 번 막힌 브라우저 창에서 영영 자동복원이 안 된다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// web/ 는 브라우저 ESM 이라 그대로 import 하면 터진다 → 컴파일 산출물에서 선언 덩어리만 잘라 평가한다
//  (dash-layout-migration.test.mjs 와 같은 수법).
const bundle = readFileSync(join(root, "public/app/session-chat.js"), "utf8");
const start = bundle.indexOf("function judgeAutoResume(");
assert.ok(start >= 0, "public/app/session-chat.js 에 judgeAutoResume 이 없습니다 — 이름이 바뀌었다면 이 테스트도 같이 고치세요");
let depth = 0, seen = false, end = -1;
for (let i = bundle.indexOf("{", start); i < bundle.length; i++) {
  const c = bundle[i];
  if (c === "{") { depth++; seen = true; }
  else if (c === "}") { depth--; if (seen && depth === 0) { end = i + 1; break; } }
}
assert.ok(end > start, "judgeAutoResume 본문의 끝을 찾지 못했습니다");
// 상수도 함께 꺼낸다 — 함수가 그 값을 참조하므로(값을 테스트가 다시 적으면 구현 미러링이 된다).
const constsSrc = ["AUTO_RESUME_MAX", "AUTO_RESUME_WINDOW_MS"].map((n) => {
  const m = new RegExp(`(?:var|const|let)\\s+${n}\\s*=\\s*([0-9_]+)`).exec(bundle);
  assert.ok(m, `${n} 을 산출물에서 찾지 못했습니다`);
  return `const ${n} = ${m[1]};`;
}).join("\n");
const judge = new Function(`${constsSrc}\n${bundle.slice(start, end)}\nreturn judgeAutoResume;`)();
const MAX = Number(/AUTO_RESUME_MAX\s*=\s*([0-9]+)/.exec(bundle)[1]);
const WIN = Number(/AUTO_RESUME_WINDOW_MS\s*=\s*([0-9_]+)/.exec(bundle)[1].replace(/_/g, ""));

let pass = 0;
const eq = (got, want, n) => { assert.deepEqual(got, want, `${n}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${n}`); };
const T = 1_000_000;   // 기준 시각(고정 — Date.now 를 쓰지 않는다)

// ── 표. 자동복원 허용 판정 ──
eq(judge(null, T), { allow: true, next: { n: 1, at: T } }, "A1 첫 자동복원(기록 없음) → 허용 · 창을 연다");
eq(judge(undefined, T), { allow: true, next: { n: 1, at: T } }, "A2 기록이 undefined(구 브라우저·스토리지 막힘) → 허용");
eq(judge({ n: 1, at: T }, T + 1), { allow: true, next: { n: 2, at: T } }, "A3 창 안 2번째 → 허용 · 창 시작 시각은 유지");
eq(judge({ n: MAX, at: T }, T + 1), { allow: false, next: { n: MAX, at: T } }, `A4 경계: 창 안에서 ${MAX}회를 썼으면 → 차단(무한 연쇄 차단 그 자체)`);
eq(judge({ n: MAX + 5, at: T }, T + 1), { allow: false, next: { n: MAX + 5, at: T } }, "A5 상한을 넘긴 기록도 차단(방어)");
eq(judge({ n: MAX, at: T }, T + WIN), { allow: false, next: { n: MAX, at: T } }, "A6 경계: 창의 마지막 순간(== WINDOW)은 아직 같은 창 → 차단");
eq(judge({ n: MAX, at: T }, T + WIN + 1), { allow: true, next: { n: 1, at: T + WIN + 1 } }, "A7 경계: 창을 지나면 새 창 → 허용(영구 차단이 아니다)");
eq(judge({ n: 0, at: T }, T + 1), { allow: true, next: { n: 1, at: T + 1 } }, "A8 손상된 기록(n=0) → 새 창으로 취급");
eq(judge({ n: 1, at: 0 }, T), { allow: true, next: { n: 1, at: T } }, "A9 손상된 기록(at=0) → 새 창으로 취급");
eq(judge({ n: NaN, at: NaN }, T), { allow: true, next: { n: 1, at: T } }, "A10 손상된 기록(NaN) → 새 창으로 취급(스토리지는 남이 쓴 값일 수 있다)");

// ── 배선 — 판정이 실제 호출부에 걸려 있는가(판정만 맞고 안 부르면 버그는 그대로다) ──
const src = readFileSync(join(root, "web/session-chat.ts"), "utf8");
const gated = src.match(/autoResumeAllowed\(\)/g) || [];
assert.ok(gated.length >= 3, `자동복원 호출부 2곳 + 정의 1곳에 걸려 있어야 합니다(발견 ${gated.length})`);
pass++; console.log("ok  B1 자동복원 호출부 2곳이 모두 상한을 거친다");
assert.ok(/sessionStorage\.getItem\(AUTO_RESUME_KEY\)/.test(src) && /sessionStorage\.setItem\(AUTO_RESUME_KEY/.test(src),
  "상한 기록이 화면을 넘어 살아야 한다(sessionStorage) — 화면 안 변수면 이번 사고가 그대로 재발한다");
pass++; console.log("ok  B2 상한 기록은 화면을 넘어 산다(sessionStorage)");
assert.ok(/catch\s*{\s*\/\*[^*]*스토리지가 막힌/.test(src) || /catch\s*{[^}]*}/.test(src.slice(src.indexOf("AUTO_RESUME_KEY"))),
  "스토리지가 막힌 브라우저에서도 죽지 않아야 한다");
pass++; console.log("ok  B3 스토리지가 막혀도 동작한다");

console.log(`\n${pass} 개 통과`);
