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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff, sanitizeName, repoClonePath, reposDir, withCloneLock, CloneBusyError, CLONE_LOCK_STALE_MS } from "./git-sync.js";
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

// ── 레포별 clone/fetch 잠금 — 두 색 프로세스·세 호출부(웹훅·git-pull·touch 유도)가 같은 클론을 fetch 한다 ──
//  잠금이 조용히 새면 git 의 ref 잠금 충돌이 웹훅 502·유도 failed 로 번지고, 낡은 잠금을 못 걷으면 fetch 가 영영 멈춘다.
{
  const prevDir = process.env.DOMAINMAP_REPOS_DIR;
  const dir = mkdtempSync(join(tmpdir(), "clone-lock-"));
  process.env.DOMAINMAP_REPOS_DIR = dir;
  const lockFile = join(dir, ".r.fetch.lock");
  const at = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
  try {
    await at("잠금을 쥔 동안 다른 시도는 상한까지 기다린 뒤 CloneBusyError · 끝나면 잠금 파일이 없다", async () => {
      let inner: unknown;
      await withCloneLock("r", async () => {
        inner = await withCloneLock("r", async () => "x", 150).catch((e) => e);
      });
      assert.ok(inner instanceof CloneBusyError, String(inner));
      assert.equal(existsSync(lockFile), false);
    });
    await at("앞 잠금이 풀리면 기다리던 시도가 이어 받는다", async () => {
      const order: string[] = [];
      let release!: () => void;
      const first = withCloneLock("r", () => new Promise<void>((r) => { order.push("a"); release = r; }));
      await new Promise((r) => setTimeout(r, 20));
      const second = withCloneLock("r", async () => { order.push("b"); }, 2_000);
      setTimeout(() => release(), 150);
      await Promise.all([first, second]);
      assert.deepEqual(order, ["a", "b"]);
    });
    await at("낡은 잠금(상한 나이 초과)은 걷고 잡는다", async () => {
      writeFileSync(lockFile, JSON.stringify({ pid: 1, at: Date.now() - CLONE_LOCK_STALE_MS - 1_000, token: "old" }));
      assert.equal(await withCloneLock("r", async () => "ran", 100), "ran");
    });
    await at("내 잠금이 아닌 파일은 지우지 않는다(낡은 것으로 걷힌 뒤 남이 다시 잡은 경우)", async () => {
      await withCloneLock("r", async () => {
        writeFileSync(lockFile, JSON.stringify({ pid: 1, at: Date.now(), token: "someone-else" }));
      });
      assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).token, "someone-else");
      rmSync(lockFile);
    });
    await at("fn 이 던져도 잠금은 풀린다", async () => {
      await assert.rejects(withCloneLock("r", async () => { throw new Error("boom"); }), /boom/);
      assert.equal(existsSync(lockFile), false);
    });
  } finally {
    if (prevDir === undefined) delete process.env.DOMAINMAP_REPOS_DIR; else process.env.DOMAINMAP_REPOS_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
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

// ── 잠금 자리도 클론 자리를 따른다(워크스페이스마다 따로) ──────────────────────
//  S4 | 열쇠 A 가 「app」 잠금을 쥔 동안 열쇠 B 의 「app」 | 막히지 않는다 — 잠금은 각 클론 자리 옆(@ws/<id>/.app.fetch.lock)
//  S5 | 같은 열쇠의 「app」 두 번                          | 여전히 서로 막는다(CloneBusyError)
//  두 워크스페이스가 같은 이름 레포를 가지면 클론은 따로인데 잠금이 공용 자리(reposDir/.app.fetch.lock)면, 한쪽의 fetch 가 남의
//   웹훅을 200(clone busy)으로 돌려보내고 git-pull 을 건너뛰게 한다 — 남의 레포 때문에 내 구조 변경이 밀린다.
{
  const prevDir = process.env.DOMAINMAP_REPOS_DIR;
  const dir = mkdtempSync(join(tmpdir(), "clone-lock-ws-"));
  process.env.DOMAINMAP_REPOS_DIR = dir;
  const at = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
  try {
    await at("S4 다른 워크스페이스의 같은 이름 레포는 잠금을 나누지 않는다 · 잠금은 그 클론 자리 옆", async () => {
      installWorkspaceDirKeyResolver(() => WA);
      let inner: unknown;
      let lockOfA = false;
      await withCloneLock("app", async () => {
        lockOfA = existsSync(join(dir, "@ws", WA, ".app.fetch.lock"));
        installWorkspaceDirKeyResolver(() => WB);
        inner = await withCloneLock("app", async () => "b", 150).catch((e) => e);
        installWorkspaceDirKeyResolver(() => WA);
      });
      assert.equal(inner, "b", `B 는 A 의 잠금에 막히지 않아야 한다: ${String(inner)}`);
      assert.ok(lockOfA, "A 의 잠금 파일은 A 의 클론 자리 옆(@ws/<A>/.app.fetch.lock)");
      assert.equal(existsSync(join(dir, ".app.fetch.lock")), false, "공용 자리에 잠금을 두지 않는다");
    });
    await at("S5 같은 워크스페이스 안에서는 여전히 서로 막는다", async () => {
      installWorkspaceDirKeyResolver(() => WB);
      let inner: unknown;
      await withCloneLock("app", async () => { inner = await withCloneLock("app", async () => "x", 150).catch((e) => e); });
      assert.ok(inner instanceof CloneBusyError, String(inner));
    });
  } finally {
    installWorkspaceDirKeyResolver(() => null);
    if (prevDir === undefined) delete process.env.DOMAINMAP_REPOS_DIR; else process.env.DOMAINMAP_REPOS_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed`);
