#!/usr/bin/env node
// 테스트 러너 — package.json 의 수기 && 체인(5,591자·143건)을 자동 발견으로 대체 (#1313 R1)
//
// 수집은 **소스 글롭 기준**이다(dist 글롭 금지 — 파일 이동·삭제 뒤 스테일 dist 산출물이
// 남으면 옛+새 테스트를 이중 실행해 false-green/크래시가 난다):
//   src/**/*.test.ts                     → dist/**/*.test.js 로 매핑해 실행(없으면 빌드 누락으로 실패)
//   kit|scripts|deploy/**/*.test.mjs     → 그대로 실행
// 제외: *.itest.mjs(수동·실DB) · *.pg-test.mjs(CI PG 전용) — scripts/README.md 테스트 계층 참조
// 특례: dist/org/delivery/static-context.test.js 는 --env-file-if-exists=.env (종전 체인과 동일)
//
// ── 실행 정책 (#1431) ─────────────────────────────────────────────────────────
// 종전은 **직렬 + 첫 실패에서 즉시 중단**(수기 && 체인의 의미 보존)이었다. 그게 두 가지를 망쳤다:
//  ① 실패 1건이 뒤쪽 100여 건을 통째로 가려, 한 번 고치고 전체를 다시 돌려야 다음 실패를 본다.
//  ② 파일당 프로세스 하나인데 전부 직렬이라 10코어에서 1코어만 쓴다(실측 160건 120초).
// 그래서 기본을 바꿨다:
//  · **끝까지 실행** — 실패해도 남은 파일을 계속 돌리고, 끝에 실패 목록을 한 번에 모아 보고한다.
//    (`--fail-fast` 로 종전 동작 복원. 종료코드는 종전처럼 첫 실패의 exit code 를 그대로 전파.)
//  · **병렬 실행** — 기본 동시 실행수 = min(availableParallelism, 8). 이 계층이 병렬 안전한 근거:
//    파일 하나 = 프로세스 하나 · 실 DB 를 안 쓴다(*.itest/*.pg-test 는 수집 제외) · temp 는 전부 mkdtemp
//    (고정 경로 0건) · 포트는 listen(0) · HOME 은 샌드박스. 이 관례들은 가드가 지킨다
//    (src/ops/state-dir.test.ts = cwd-상대 런타임 쓰기 차단 · kit/cli/bootstrap-node-gate.test.mjs = 실 HOME 무접촉).
//    병렬일 때 자식 출력은 **파일 단위로 버퍼링**해 완료 시 한 덩어리로 낸다(섞임 방지).
//  · `-j 1` 은 종전처럼 자식 출력을 그대로 흘린다(한 건 디버깅용).
//  · `--itest` 는 실 DB 를 공유하니 직렬 고정(명시적 -j 로만 덮어씀).
//  ⚠ 병렬은 경과시간을 단정하는 테스트(예: project-provision-async 의 `elapsed < 500`)를 부하로 흔들 수 있다.
//   그런 flake 가 보이면 -j 를 낮추지 말고 해당 테스트의 상한을 부하 내성 있게 고치는 쪽이 맞다.
//
// 사용: node scripts/run-tests.mjs                    전체 실행(병렬 · 끝까지)
//       node scripts/run-tests.mjs <부분문자열>…       경로 부분일치만(여러 개면 OR)
//       node scripts/run-tests.mjs --list             실행 없이 발견 목록만
//       node scripts/run-tests.mjs --itest            ②계층: scripts/**/*.itest.mjs(실 DB — .env 자동 적용)
//       node scripts/run-tests.mjs --build            빌드(npm run build)까지 이 러너가 실행 — 빌드가 깨져도
//                                                     돌 수 있는 테스트는 돌린다(`npm test` 가 쓰는 경로)
//       node scripts/run-tests.mjs -j 4 | --jobs=4    동시 실행수(1 = 직렬·출력 그대로 흘림)
//       node scripts/run-tests.mjs --fail-fast        첫 실패에서 중단(종전 기본)
//       node scripts/run-tests.mjs --verbose          통과한 파일의 출력도 전부 표시(병렬 모드)
//       node scripts/run-tests.mjs --slowest[=N]      끝에 느린 파일 N건 표시(기본 10 · 병렬화 상한 진단용)
import { readdirSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotRealHome, verifyRealHome, formatChanges } from "./testguard-real-home.mjs";
import { testChildEnv } from "./test-runner-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE_TESTS = new Set(["dist/org/delivery/static-context.test.js"]);
// 기본 동시 실행수 — 코어 수를 그대로 쓰지 않고 8 에서 끊는다. 실측(160건 120초)에서 최장 1건이 36초라
//  병렬 상한이 그 파일에 걸려 j=4 와 j=10 의 wall 이 같다. 낮게 잡을수록 부하로 인한 타이밍 flake 가 적다.
const DEFAULT_JOBS = Math.min(availableParallelism(), 8);
const TEST_ENV = testChildEnv();

const opts = { list: false, itest: false, build: false, failFast: false, verbose: false, slowest: 0, jobs: null };
const filters = [];
const argv = process.argv.slice(2);
const die = (msg) => {
  console.error(msg);
  process.exit(2);
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const eq = a.indexOf("=");
  const key = eq > 0 ? a.slice(0, eq) : a;
  const val = eq > 0 ? a.slice(eq + 1) : null;
  const num = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) die(`${what} 는 1 이상의 정수여야 합니다: ${v}`);
    return n;
  };
  if (key === "--list") opts.list = true;
  else if (key === "--itest") opts.itest = true;
  else if (key === "--build") opts.build = true;
  else if (key === "--fail-fast") opts.failFast = true;
  else if (key === "--verbose") opts.verbose = true;
  else if (key === "--slowest") opts.slowest = val === null ? 10 : num(val, "--slowest");
  else if (key === "--jobs" || key === "-j") opts.jobs = num(val ?? argv[++i], "--jobs");
  else if (/^-j\d+$/.test(a)) opts.jobs = num(a.slice(2), "--jobs");
  // 알 수 없는 옵션을 부분문자열 필터로 삼으면 0 건 매치 → "✓ 0 test files passed" 로 **거짓 green** 이 된다.
  else if (a.startsWith("-")) die(`알 수 없는 옵션: ${a}\n(사용법은 ${path.relative(ROOT, fileURLToPath(import.meta.url))} 머리 주석)`);
  else filters.push(a);
}

// ── 빌드(선택) — `npm test` 는 종전 `npm run build && …` 였다. && 라서 빌드가 깨지면 테스트 결과를 하나도
//  못 봤다(웹 tsc 타입오류 하나가 노드 테스트 160건을 가린다). 여기서 돌리면 빌드 실패를 **기억해두고**
//  돌 수 있는 테스트는 돌린 뒤, 마지막에 둘 다 보고한다(빌드 실패는 종료코드에 그대로 반영).
let buildFailed = null;
if (opts.build) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // ⚠ shell:true 가 윈도우에선 필수다 — Node 는 CVE-2024-27980 이후 **shell 없는 .cmd/.bat 실행을 거부**한다
  //  (`spawnSync npm.cmd EINVAL`, status=null). 그래서 여기서 `npm test` 의 빌드 단계가 **출력 한 줄 없이**
  //  실패했고, 러너는 설계대로 "빌드 실패지만 계속"으로 넘어가 **스테일하거나 없는 dist 로** 테스트를 돌렸다
  //  (실측 2026-08-20: 첫 실행에서 src 테스트 190여 건이 전부 '빌드 산출물 없음'). CI 는 ubuntu 라 안 걸렸고,
  //  windows 잡은 러너 대신 PowerShell 로 kit·desktop 만 순회해서 이 경로를 지나지 않는다.
  //  같은 계열을 데스크톱 앱에서 이미 겪었다(#1541 — 심이 lively.cmd 라 앱이 CLI 를 한 번도 못 불렀다).
  //  인자가 고정 리터럴("run","build")이라 shell 경유로 인한 인젝션 여지는 없다.
  const r = spawnSync(npm, ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    buildFailed = r.signal ? `signal ${r.signal}` : `exit ${r.status ?? 1}`;
    console.error(`\n✗ 빌드 실패 (${buildFailed}) — 그래도 돌 수 있는 테스트는 계속 돌린다(#1431).`);
    console.error("  ⚠ dist 가 스테일하거나 빠져 있을 수 있다. 아래 테스트 결과는 그 전제에서 읽어라.\n");
  }
}

function collect(dir, re) {
  const base = path.join(ROOT, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true })
    .filter((p) => re.test(p) && !/\.itest\.mjs$|\.pg-test\.mjs$/.test(p))
    .map((p) => path.join(dir, p))
    .sort();
}

let files;
if (opts.itest) {
  // ②계층(itest) — 실 DB 필요. 기본 수집의 제외 규칙과 대칭이며, .env 를 자동 적용한다.
  files = readdirSync(path.join(ROOT, "scripts"), { recursive: true })
    .filter((p) => /\.itest\.mjs$/.test(p))
    .map((p) => path.join("scripts", p))
    .sort();
} else {
  const srcTests = collect("src", /\.test\.ts$/).map((p) =>
    path.join("dist", path.relative("src", p).replace(/\.ts$/, ".js")),
  );
  const mjsTests = ["kit", "scripts", "deploy", "desktop"].flatMap((d) => collect(d, /\.test\.mjs$/));
  files = [...srcTests, ...mjsTests];
}
if (filters.length) files = files.filter((f) => filters.some((s) => f.includes(s)));

if (opts.list) {
  for (const f of files) console.log(f);
  process.exit(0);
}
if (!files.length) {
  console.error(filters.length ? `일치하는 테스트가 없습니다: ${filters.join(" ")}` : "발견된 테스트가 없습니다");
  process.exit(1);
}

// 테스트를 하나라도 띄우기 전에 격리 린트를 선행한다. R3 위반 테스트가 setup/에 추가돼도 알파벳 순서나
// 병렬 스케줄 때문에 린트보다 먼저 실행되어 capability를 얻는 창이 없어야 한다. 필터로 한 파일만 돌려도 동일하다.
if (!opts.itest) {
  const isolationPreflight = path.join(ROOT, "kit", "testlib", "test-isolation-lint.test.mjs");
  const r = spawnSync(process.execPath, [isolationPreflight], { cwd: ROOT, stdio: "inherit", env: TEST_ENV });
  if (r.status !== 0) {
    console.error("\n✗ 테스트 격리 preflight 실패 — 어떤 테스트도 실행하지 않았습니다.");
    process.exit(r.status ?? 1);
  }
}

// 빌드 산출물 누락 — 종전엔 여기서 즉시 exit 해 **한 건 때문에 전체가 안 돌았다**. 이제 누락분만 실패로
//  기록하고(조용히 건너뛰면 거짓 green) 나머지는 그대로 돌린다.
const missing = new Set(files.filter((f) => !existsSync(path.join(ROOT, f))));
if (missing.size) {
  console.error(`빌드 산출물이 없습니다 (npm run build 먼저?):\n  ${[...missing].join("\n  ")}\n`);
}

// ── 실 홈 오염 가드 (전역 안전망) ────────────────────────────────────────────
//  아래 LIVELY_NO_BROWSER 와 같은 자리의 같은 논리다 — 개별 테스트가 각자 격리하는 게 원칙이지만,
//  **관례를 모르는 새 테스트**가 뚫는 걸 러너에서 한 번 더 막는다. 다만 브라우저와 달리 홈 오염은
//  막을 지점이 하나가 아니라(env 상속·PATH·직접 쓰기…) 사전 차단이 불가능하다. 그래서 결과를 본다:
//  실행 전 지문을 떠 두고, 끝나고 달라졌으면 되돌린 뒤 실패로 보고한다. 상세 근거는 testguard-real-home.mjs.
const homeSnap = snapshotRealHome();
let homeChanges = null;
const checkRealHome = () => {
  if (homeChanges) return homeChanges;               // 한 번만 — exit 핸들러와 보고부가 둘 다 부른다
  homeChanges = verifyRealHome(homeSnap);
  return homeChanges;
};
//  어떤 경로로 끝나도(예외·중단 포함) 사람의 환경은 원상태로 돌려준다. 보고는 아래 정상 경로가 맡는다.
process.on("exit", () => {
  const c = checkRealHome();
  if (c.length) {
    console.error(formatChanges(c));
    if (!process.exitCode) process.exitCode = 1;
  }
});

const jobs = Math.max(1, Math.min(opts.jobs ?? (opts.itest ? 1 : DEFAULT_JOBS), files.length));
const argsFor = (f) => (opts.itest || ENV_FILE_TESTS.has(f) ? ["--env-file-if-exists=.env", f] : [f]);
const label = (r) => (r.missing ? "빌드 산출물 없음" : r.signal ? `signal ${r.signal}` : `exit ${r.status ?? 1}`);

const results = new Array(files.length).fill(null);
const live = new Map(); // child → idx (중단 시 자식 정리용)
let done = 0;
let failed = 0;
let interrupted = false;
const t0 = Date.now();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n${sig} — 실행 중인 테스트 ${live.size}건 정리 후 중단합니다.`);
    for (const c of live.keys()) c.kill("SIGKILL");
  });
}

const record = (idx, r) => {
  results[idx] = r;
  done++;
  if (r.status !== 0) failed++;
};

if (jobs === 1) {
  // 직렬 — 종전과 같이 자식 출력을 그대로 흘린다(버퍼링 없음). 한 건을 눈으로 따라갈 때 이 모드.
  for (let idx = 0; idx < files.length; idx++) {
    if (interrupted) break;
    const f = files[idx];
    if (missing.has(f)) {
      record(idx, { f, ms: 0, status: 1, signal: null, missing: true });
    } else {
      const t = Date.now();
      const r = spawnSync(process.execPath, argsFor(f), { cwd: ROOT, stdio: "inherit", env: TEST_ENV });
      record(idx, { f, ms: Date.now() - t, status: r.status, signal: r.signal });
    }
    const r = results[idx];
    if (r.status !== 0) console.error(`\n✗ FAIL (${done}/${files.length}) ${f} — ${label(r)}`);
    if (failed && opts.failFast) break;
  }
} else {
  const report = (r) => {
    const secs = `${(r.ms / 1000).toFixed(1)}s`;
    if (r.status === 0) {
      if (opts.verbose && r.out?.trim()) console.log(`\n── ✓ ${r.f} (${secs}) ──\n${r.out.trimEnd()}`);
      else console.log(`✓ (${done}/${files.length}) ${r.f}  ${secs}`);
      return;
    }
    console.error(`\n──── ✗ FAIL ${r.f} — ${label(r)} (${secs}) ────`);
    if (r.out?.trim()) process.stderr.write(r.out.endsWith("\n") ? r.out : `${r.out}\n`);
    console.error(`──── ✗ FAIL 끝: ${r.f} ────`);
  };

  let next = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (!interrupted && !(opts.failFast && failed) && live.size < jobs && next < files.length) {
        const idx = next++;
        const f = files[idx];
        if (missing.has(f)) {
          record(idx, { f, ms: 0, status: 1, signal: null, missing: true });
          report(results[idx]);
          continue;
        }
        const t = Date.now();
        // LIVELY_NO_BROWSER: 어떤 테스트가 lively CLI 를 프로세스로 띄우든 **실행한 사람의 브라우저를 못 열게**
        //  한다(#1717 — device 로그인이 승인 URL 을 `open` 으로 띄워 `npm test` 한 번에 실 탭 5개가 떴다).
        //  개별 테스트도 noBrowserEnv() 로 각자 거는 게 원칙이지만(직접 실행 경로), 여기서 한 번 더 덮어
        //  **새로 추가되는 테스트가 이 관례를 몰라도** 러너 경로에선 안 뚫린다.
        const child = spawn(process.execPath, argsFor(f), { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: TEST_ENV });
        live.set(child, idx);
        const chunks = [];
        child.stdout.on("data", (d) => chunks.push(d));
        child.stderr.on("data", (d) => chunks.push(d));
        let settled = false;
        const finish = (status, signal, err) => {
          if (settled) return;
          settled = true;
          live.delete(child);
          const out = Buffer.concat(chunks).toString() + (err ? `\n[러너] 자식 실행 실패: ${err.message}\n` : "");
          record(idx, { f, ms: Date.now() - t, status, signal, out });
          report(results[idx]);
          pump();
        };
        child.on("error", (err) => finish(err.code === "ENOENT" ? 127 : 1, null, err));
        child.on("close", (status, signal) => finish(status, signal));
      }
      if (live.size === 0) resolve();
    };
    pump();
  });
}

// ── 보고 ──
const wall = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const ran = results.filter(Boolean);
const fails = ran.filter((r) => r.status !== 0);
const notRun = files.length - ran.length;
// 실 홈이 더럽혀졌으면 **테스트가 전부 통과해도 green 이 아니다** — 격리 실패는 그 자체로 결함이다.
//  상세 출력·원복은 exit 핸들러가 한다(여기선 판정만 — 두 번 찍지 않도록).
const homeDirty = checkRealHome();

if (opts.slowest) {
  const top = ran.filter((r) => !r.missing).sort((a, b) => b.ms - a.ms).slice(0, opts.slowest);
  const sum = ran.reduce((s, r) => s + r.ms, 0) || 1;
  console.log(`\n느린 ${top.length}건 (합계 ${(sum / 1000).toFixed(1)}s — 병렬 wall 의 하한은 최장 1건):`);
  for (const r of top) console.log(`  ${((r.ms / 1000).toFixed(1) + "s").padStart(7)}  ${((r.ms / sum) * 100).toFixed(1).padStart(4)}%  ${r.f}`);
}

const suffix = `${wall}${jobs > 1 ? `, -j ${jobs}` : ", 직렬"}`;
if (!fails.length && !buildFailed && !interrupted && !homeDirty.length) {
  console.log(`\n✓ ${ran.length} test files passed (${suffix})`);
  process.exitCode = 0;
} else {
  // 테스트는 다 통과했는데 빌드만 깨졌거나 중간에 중단된 경우가 있다 — 그때 "0/N 실패"는 오독을 부른다.
  const onlyCause = buildFailed ? "빌드 실패" : interrupted ? "중단" : "실 홈 오염(테스트 격리 실패)";
  console.error(
    fails.length
      ? `\n✗ ${fails.length}/${files.length} 실패 (${suffix})`
      : `\n✗ ${onlyCause} — 실행한 ${ran.length}건은 전부 통과 (${suffix})`,
  );
  for (const r of fails) console.error(`   ${r.f} — ${label(r)}`);
  if (buildFailed) console.error(`   [빌드] npm run build — ${buildFailed}`);
  if (notRun) console.error(`   … ${notRun}건 미실행 (${interrupted ? "중단" : "--fail-fast"})`);
  if (fails.length) console.error(`\n   실패분만 재실행: node scripts/run-tests.mjs ${fails.map((r) => r.f).join(" ")}`);
  // 종료코드: 종전과 같이 **첫 실패의 exit code** 를 전파(빌드 실패뿐이면 1, 중단은 130).
  process.exitCode = fails[0]?.status ?? (buildFailed ? 1 : interrupted ? 130 : 1);
}
