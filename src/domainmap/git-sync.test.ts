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
//
// ── 판정용 git 질의 3상(isAncestorStrict·commitExists) — 쓰기를 가르는 판정이라 오류를 「아니다」 로 읽지 않는다 ──
// 16 | 커밋 있음 / 조상임                         | true
// 17 | 커밋 없음·커밋 아닌 객체·sha 아닌 값 / 조상 아님 | false (git 의 「아니다」 = exit 1)
// 18 | 없는 sha 로 조상 판정(exit 128)            | throw
// 19 | 클론 디렉터리 없음 · git 실행 파일 없음(ENOENT) · 타임아웃 | throw
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff, sanitizeName, repoClonePath, reposDir, isAncestorStrict, commitExists } from "./git-sync.js";
import { installWorkspaceDirKeyResolver } from "../ops/workspace-dir-key.js";

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

{
  const dir = mkdtempSync(join(tmpdir(), "git-sync-answer-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();
  const O = { timeoutMs: 30_000 };
  try {
    g("init", "-q");
    writeFileSync(join(dir, "a"), "1"); g("add", "a"); g("commit", "-qm", "1");
    const c1 = g("rev-parse", "HEAD");
    writeFileSync(join(dir, "a"), "2"); g("commit", "-qam", "2");
    const c2 = g("rev-parse", "HEAD");
    const tree = g("rev-parse", "HEAD^{tree}");
    const missing = "d".repeat(40);
    const rejects = async (p: Promise<unknown>) => { let threw = false; try { await p; } catch { threw = true; } return threw; };

    assert.equal(await commitExists(dir, c1, O), true);
    assert.equal(await commitExists(dir, c1.slice(0, 7), O), true);
    assert.equal(await isAncestorStrict(dir, c1, c2, O), true);
    assert.equal(await isAncestorStrict(dir, c2, c2, O), true);
    pass++; console.log("ok  #16 있음·조상 → true");

    for (const v of [missing, missing.slice(0, 7), tree, "not-a-sha", "--help"]) assert.equal(await commitExists(dir, v, O), false, v);
    assert.equal(await isAncestorStrict(dir, c2, c1, O), false);
    pass++; console.log("ok  #17 없음·커밋 아님·sha 아님 / 조상 아님 → false");

    assert.equal(await rejects(isAncestorStrict(dir, missing, c2, O)), true);
    pass++; console.log("ok  #18 없는 sha 로 조상 판정(128) → throw");

    const gone = join(dir, "no-such-dir");
    assert.equal(await rejects(commitExists(gone, c1, O)), true);
    assert.equal(await rejects(isAncestorStrict(gone, c1, c2, O)), true);
    const path0 = process.env.PATH;
    process.env.PATH = join(dir, "empty-path");
    try {
      assert.equal(await rejects(commitExists(dir, c1, O)), true);
      assert.equal(await rejects(isAncestorStrict(dir, c1, c2, O)), true);
    } finally { process.env.PATH = path0; }
    // 타임아웃: 응답하지 않는 가짜 git 을 PATH 앞에 둔다.
    const slowBin = join(dir, "slow-bin");
    mkdirSync(slowBin);
    writeFileSync(join(slowBin, "git"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    process.env.PATH = `${slowBin}:${path0}`;
    try {
      assert.equal(await rejects(commitExists(dir, c1, { timeoutMs: 200 })), true);
      assert.equal(await rejects(isAncestorStrict(dir, c1, c2, { timeoutMs: 200 })), true);
    } finally { process.env.PATH = path0; }
    pass++; console.log("ok  #19 클론 없음·git 없음(ENOENT)·타임아웃 → throw");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 스캐너 클론 자리도 워크스페이스마다 따로 ──────────────────────────────────
//  S1 | 열쇠 없음            | reposDir/<name>                     (단일 워크스페이스 · primary — 종전 자리)
//  S2 | 열쇠 A · 열쇠 B      | reposDir/@ws/<id>/<name> — 같은 이름이어도 서로 다른 자리 · 종전 자리와도 다르다
//  S3 | 열쇠 꼴이 틀림       | 던진다(종전 자리로 떨어지지 않는다)
const WA = "aaaaaaaa-1111-2222-3333-444444444444", WB = "bbbbbbbb-1111-2222-3333-444444444444";
t("S1 열쇠가 없으면 스캐너 클론은 종전 자리", () => {
  installWorkspaceDirKeyResolver(() => null);
  assert.equal(repoClonePath("app"), reposDir() + "/app");
});
t("S2 열쇠가 있으면 워크스페이스마다 다른 자리 — 같은 이름이어도 겹치지 않는다", () => {
  try {
    installWorkspaceDirKeyResolver(() => WA);
    const a = repoClonePath("app");
    installWorkspaceDirKeyResolver(() => WB);
    const b = repoClonePath("app");
    assert.equal(a, `${reposDir()}/@ws/${WA}/app`);
    assert.equal(b, `${reposDir()}/@ws/${WB}/app`);
    assert.notEqual(a, b);
    assert.notEqual(a, reposDir() + "/app");
    assert.equal(repoClonePath("../../etc"), `${reposDir()}/@ws/${WB}/.._.._etc`, "이름 정리는 그대로다");
  } finally { installWorkspaceDirKeyResolver(() => null); }
});
t("S3 열쇠 꼴이 틀리면 던진다", () => {
  try {
    installWorkspaceDirKeyResolver(() => "../escape");
    assert.throws(() => repoClonePath("app"), /UUID 꼴이 아닙니다/);
  } finally { installWorkspaceDirKeyResolver(() => null); }
});

console.log(`\n${pass} passed`);
