#!/usr/bin/env node
// 테스트 러너 — package.json 의 수기 && 체인(5,591자·143건)을 자동 발견으로 대체 (#1313 R1)
//
// 수집은 **소스 글롭 기준**이다(dist 글롭 금지 — 파일 이동·삭제 뒤 스테일 dist 산출물이
// 남으면 옛+새 테스트를 이중 실행해 false-green/크래시가 난다):
//   src/**/*.test.ts                     → dist/**/*.test.js 로 매핑해 실행(없으면 빌드 누락으로 실패)
//   kit|scripts|deploy/**/*.test.mjs     → 그대로 실행
// 제외: *.itest.mjs(수동·실DB) · *.pg-test.mjs(CI PG 전용) — scripts/README.md 테스트 계층 참조
// 특례: dist/org/delivery/static-context.test.js 는 --env-file-if-exists=.env (종전 체인과 동일)
// 직렬 실행, 비제로 exit 즉시 실패(fail-fast) — 종전 && 체인의 의미 보존.
//
// 사용: node scripts/run-tests.mjs           전체 실행
//       node scripts/run-tests.mjs --list    실행 없이 발견 목록만 출력
//       node scripts/run-tests.mjs <부분문자열>  경로에 부분문자열이 포함된 테스트만 실행
//       node scripts/run-tests.mjs --itest   ②계층: scripts/**/*.itest.mjs 실행(실 DB — .env 자동 적용)
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE_TESTS = new Set(["dist/org/delivery/static-context.test.js"]);

function collect(dir, re) {
  const base = path.join(ROOT, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true })
    .filter((p) => re.test(p) && !/\.itest\.mjs$|\.pg-test\.mjs$/.test(p))
    .map((p) => path.join(dir, p))
    .sort();
}

const arg = process.argv[2];
const ITEST = arg === "--itest";

let files;
if (ITEST) {
  // ②계층(itest) — 실 DB 필요. 기본 수집의 제외 규칙과 대칭이며, .env 를 자동 적용한다.
  files = readdirSync(path.join(ROOT, "scripts"), { recursive: true })
    .filter((p) => /\.itest\.mjs$/.test(p))
    .map((p) => path.join("scripts", p))
    .sort();
} else {
  const srcTests = collect("src", /\.test\.ts$/).map((p) =>
    path.join("dist", path.relative("src", p).replace(/\.ts$/, ".js")),
  );
  const mjsTests = ["kit", "scripts", "deploy"].flatMap((d) => collect(d, /\.test\.mjs$/));
  files = [...srcTests, ...mjsTests];
  if (arg && arg !== "--list") files = files.filter((f) => f.includes(arg));
}

if (arg === "--list") {
  for (const f of files) console.log(f);
  process.exit(0);
}

const missing = files.filter((f) => !existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.error(`빌드 산출물이 없습니다 (npm run build 먼저?):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const t0 = Date.now();
let n = 0;
for (const f of files) {
  n++;
  const args = ITEST || ENV_FILE_TESTS.has(f) ? ["--env-file-if-exists=.env", f] : [f];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✗ FAIL (${n}/${files.length}) ${f} — exit ${r.status}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\n✓ ${files.length} test files passed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
