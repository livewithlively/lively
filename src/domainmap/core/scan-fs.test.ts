// 순수 단위 체크(테스트 러너 없이 node:assert) — deriveModules(파일목록 → 모듈 유닛 도출).
// 실행: npm run build && node dist/domainmap/core/scan-fs.test.js
// DB·git·파일시스템 무접촉(PURE) — 결정론적·재현 가능.
import assert from "node:assert/strict";
import { deriveModules } from "./scan-fs.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("마커(build.gradle) 있는 디렉터리 = 모듈, 하위 파일은 그 모듈로 롤업", () => {
  const { units } = deriveModules([
    "domain/credit-apply-domain/build.gradle",
    "domain/credit-apply-domain/src/main/kotlin/Foo.kt",
    "domain/credit-apply-domain/src/main/kotlin/pkg/Bar.kt",
    "domain/css-domain/build.gradle",
    "domain/css-domain/src/Baz.kt",
  ]);
  assert.deepEqual(units, ["domain/credit-apply-domain", "domain/css-domain"]);
});

t("중첩 마커 → longest-prefix(가장 깊은 모듈)가 소유", () => {
  const { units } = deriveModules([
    "a/build.gradle",
    "a/x.kt",
    "a/sub/build.gradle",
    "a/sub/y.kt",
  ]);
  // a/sub 파일은 a 가 아니라 a/sub 소유. a 는 자기 build.gradle+x.kt 로 유닛.
  assert.deepEqual(units, ["a", "a/sub"]);
});

t("레포-루트 마커(루트 package.json)는 전 레포 뭉침 방지 — fallback depth 그룹으로", () => {
  const { units } = deriveModules([
    "package.json",
    "src/domainmap/core/refresh.ts",
    "src/domainmap/core/aggregate.ts",
    "src/items/store.ts",
    "web/admin.ts",
  ]);
  // 루트 package.json 은 경계에서 제외 → 파일들은 fallback depth=2 로 그룹.
  assert.deepEqual(units, ["package.json", "src/domainmap", "src/items", "web"]);
});

t("비-루트 npm 패키지(package.json)는 모듈 경계로 존중", () => {
  const { units } = deriveModules([
    "package.json",              // 루트(무시)
    "packages/api/package.json", // 비-루트 마커 → 모듈
    "packages/api/src/index.ts",
    "packages/api/src/util/x.ts",
    "packages/web/package.json",
    "packages/web/main.ts",
  ]);
  assert.deepEqual(units, ["package.json", "packages/api", "packages/web"]);
});

t("top-level 파일은 자기 자신이 유닛(aggregate.ts top-level 관례와 일치)", () => {
  const { units } = deriveModules(["README.md", "tsconfig.json", "src/a/b.ts"]);
  assert.deepEqual(units, ["README.md", "src/a", "tsconfig.json"]);
});

t("fallbackDepth 오버라이드(=1) → 최상위 세그먼트로 거칠게 그룹", () => {
  const { units } = deriveModules(
    ["src/domainmap/core/refresh.ts", "src/items/store.ts", "web/admin.ts"],
    { fallbackDepth: 1 },
  );
  assert.deepEqual(units, ["src", "web"]);
});

t("depth 보다 얕은 파일은 자기 부모 디렉터리까지만(초과 절단 안 함)", () => {
  // src/a.ts 는 세그먼트 2개 → min(depth2, len-1=1)=1 → 'src'
  const { units } = deriveModules(["src/a.ts", "src/b/c.ts"]);
  assert.deepEqual(units, ["src", "src/b"]);
});

t("dedup·정렬·경로 정규화(역슬래시·선행 ./ ·중복)", () => {
  const { units } = deriveModules([
    "src\\a\\x.ts",   // windows 구분자
    "./src/a/y.ts",   // 선행 ./
    "src/a/x.ts",     // 중복(정규화 후 동일 모듈)
    "src/b/z.ts",
  ]);
  assert.deepEqual(units, ["src/a", "src/b"]);
});

t("detected_stack: 마커 종류·언어 확장자·파일수 카운트", () => {
  const { detected_stack } = deriveModules([
    "domain/a/build.gradle",
    "domain/a/Foo.kt",
    "domain/b/build.gradle.kts",
    "domain/b/Bar.kt",
    "svc/go.mod",
    "svc/main.go",
  ]);
  assert.equal(detected_stack.markers.gradle, 2);
  assert.equal(detected_stack.markers.go, 1);
  assert.equal(detected_stack.languages.kt, 2);
  assert.equal(detected_stack.languages.go, 1);
  assert.equal(detected_stack.files, 6);
});

t("빈 입력·비문자열 방어 → 유닛 0", () => {
  assert.deepEqual(deriveModules([]).units, []);
  assert.deepEqual(deriveModules(undefined).units, []);
  assert.deepEqual(deriveModules([null, "", 3, {}] as unknown[]).units, []);
});

t("멱등: 같은 입력 두 번 → 같은 결과(결정론)", () => {
  const files = ["a/build.gradle", "a/x.kt", "b/y.ts", "b/z.ts", "top.md"];
  assert.deepEqual(deriveModules(files), deriveModules(files));
});

console.log(`\n${pass} checks passed`);
