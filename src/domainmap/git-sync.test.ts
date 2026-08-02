// git-sync.parseDiff 골든 테스트(#1313 R23) — webhook.ts·git-pull.ts 가 통복사하던 파서를 단일 구현으로
//  합칠 때의 안전망. 사양 출처: parseDiff 주석 + `git diff --name-status -M50` 실제 출력 형식.
//  실행: npm run build && node dist/domainmap/git-sync.test.js
//
// ── 입력 × 기대 (골든 표 — 행마다 테스트 1개) ────────────────────────────────
//  #  | 입력 라인                        | 기대 changes[]
//  1  | 'A\tsrc/a.ts'                    | [{status:'A', path:'src/a.ts'}]
//  2  | 'D\tsrc/a.ts'                    | [{status:'D', path:'src/a.ts'}]
//  3  | 'M\tsrc/a.ts'                    | [{status:'M', path:'src/a.ts'}]
//  4  | 'T\tsrc/a.ts'                    | [{status:'M', path:'src/a.ts'}]  (타입변경 → 수정 취급)
//  5  | 'R100\told\tnew'                 | [{status:'R', from:'old', to:'new', score:100}]
//  6  | 'R087\told\tnew'                 | [{status:'R', ..., score:87}]    (0 패딩 → 십진수)
//  7  | 'R\told\tnew'                    | [{status:'R', ..., score:0}]     (⚠ score 없음 → Number('')===0, null 아님)
//  8  | 'C75\tsrc\tcopy'                 | [{status:'A', path:'copy'}]      (복사 = to 의 신규추가)
//  9  | 'C75\tsrc'  (to 누락)             | []                                (불완전 행 스킵)
// 10  | 'R100\told' (to 누락)             | []                                (불완전 행 스킵)
// 11  | 'A\t' (빈 경로)                   | []                                (빈 경우 행)
// 12  | 'U\tsrc/a.ts' / 'X\ta'           | []                                (미병합/미지 상태 무시)
// 13  | '' / '\n\n' (빈 입력·빈 줄)       | []                                (빈 경우 행)
// 14  | 다중 라인 혼합 + 후행 개행         | 순서 보존한 전 행 파싱
// 15  | 경로에 공백/한글                   | 탭 분리라 원형 보존
import assert from "node:assert/strict";
import { parseDiff, sanitizeName, repoClonePath, reposDir } from "./git-sync.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// ── parseDiff 골든 표 ──────────────────────────────────────────────────────
const GOLDEN: [string, string, unknown[]][] = [
  ["1  A → add", "A\tsrc/a.ts", [{ status: "A", path: "src/a.ts" }]],
  ["2  D → delete", "D\tsrc/a.ts", [{ status: "D", path: "src/a.ts" }]],
  ["3  M → modify", "M\tsrc/a.ts", [{ status: "M", path: "src/a.ts" }]],
  ["4  T(타입변경) → modify", "T\tsrc/a.ts", [{ status: "M", path: "src/a.ts" }]],
  ["5  R100 → rename+score", "R100\tsrc/old.ts\tsrc/new.ts",
    [{ status: "R", from: "src/old.ts", to: "src/new.ts", score: 100 }]],
  ["6  R087(0패딩) → score 87", "R087\ta\tb", [{ status: "R", from: "a", to: "b", score: 87 }]],
  // ⚠ 실측 고정: Number("") === 0 (NaN 아님) → score null 이 아니라 0. 'R' 단독 코드는 git 이 내지 않지만
  //  파서의 실제 거동이므로 골든으로 못박는다(통합 전 두 사본 모두 동일 거동).
  ["7  R(스코어 없음) → score 0", "R\ta\tb", [{ status: "R", from: "a", to: "b", score: 0 }]],
  ["8  C75(복사) → to 의 A", "C75\tsrc/a.ts\tsrc/b.ts", [{ status: "A", path: "src/b.ts" }]],
  ["9  C 인데 to 누락 → 스킵", "C75\tsrc/a.ts", []],
  ["10 R 인데 to 누락 → 스킵", "R100\tsrc/old.ts", []],
  ["11 A 인데 경로 빈 문자열 → 스킵", "A\t", []],
  ["12 U/X(미병합·미지) → 무시", "U\tsrc/a.ts\nX\tsrc/b.ts", []],
  ["13 빈 입력·빈 줄만 → []", "\n\n", []],
  ["14 혼합 다중행 + 후행 개행 → 순서 보존",
    "A\tsrc/new.ts\nM\tsrc/mod.ts\nD\tsrc/gone.ts\nR100\tsrc/old.ts\tsrc/moved.ts\nC50\tsrc/a.ts\tsrc/copy.ts\nT\tsrc/link.ts\n",
    [
      { status: "A", path: "src/new.ts" },
      { status: "M", path: "src/mod.ts" },
      { status: "D", path: "src/gone.ts" },
      { status: "R", from: "src/old.ts", to: "src/moved.ts", score: 100 },
      { status: "A", path: "src/copy.ts" },
      { status: "M", path: "src/link.ts" },
    ]],
  ["15 공백·한글 경로 원형 보존", "M\tsrc/한 글 파일.ts", [{ status: "M", path: "src/한 글 파일.ts" }]],
];
for (const [name, input, expected] of GOLDEN) {
  t(`parseDiff ${name}`, () => { assert.deepEqual(parseDiff(input), expected); });
}

// R 스코어가 유한하지 않으면 null — 'Rx9' 같은 쓰레기 코드도 throw 없이 흡수(웹훅은 절대 500 나면 안 됨).
t("parseDiff R 스코어 비수치 → null(throw 없음)", () => {
  assert.deepEqual(parseDiff("Rzz\ta\tb"), [{ status: "R", from: "a", to: "b", score: null }]);
});

// ── sanitizeName / repoClonePath (통합으로 흡수한 나머지 헬퍼의 계약 고정) ──
t("sanitizeName 불허문자 → '_', 허용문자 원형", () => {
  assert.equal(sanitizeName("a/b"), "a_b");
  assert.equal(sanitizeName("../x"), ".._x");
  assert.equal(sanitizeName("Repo-1.x_y"), "Repo-1.x_y");
});
t("sanitizeName null/undefined/'' → ''(caller 가 거부)", () => {
  assert.equal(sanitizeName(null), "");
  assert.equal(sanitizeName(undefined), "");
  assert.equal(sanitizeName(""), "");
});
t("repoClonePath 은 reposDir 하위 단일 세그먼트(경로탈출 불가)", () => {
  assert.equal(repoClonePath("../../etc"), reposDir() + "/.._.._etc");
  assert.throws(() => repoClonePath(""), /invalid repo name for clone dir/);
});

console.log(`\n${pass} passed`);
