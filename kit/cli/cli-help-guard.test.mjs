#!/usr/bin/env node
// `--help` 는 어떤 명령도 실행하지 않는다(#5028) — 진짜 CLI + **요청을 전부 적는** 픽스처 게이트웨이 + 샌드박스 HOME.
//  계기: `lively delegate --help` 가 «--help» 라는 지시의 **실제 위탁**을 만들고 배치를 기다렸다(AI 세션들이 사용법을
//   보려다 반복해서 밟았다). 같은 자리에서 `uninstall --help`(제거) · `logout --help`(로그아웃) · `onboarding --help`
//   (claude 기동)도 실행됐다. `lively node --help`(#4006)는 lively-node.test.mjs ⑨ 가 따로 덮는다.
//  단언의 요지는 **부작용 0** 이다: 게이트웨이 요청 0건 · 샌드박스 HOME 무변경 · 하네스 기동 0 · 종료 코드 0.
//  실행: node kit/cli/cli-help-guard.test.mjs   (npm test 체인에 포함)
//
// ⚠ CLI 는 비동기(execFile)로 띄운다 — 픽스처가 이 프로세스에서 돌아서 execFileSync 로 막으면 자식의 요청이
//  전부 타임아웃해 «요청 0건» 단언이 공허하게 통과한다(lively.test.mjs 머리말의 그 함정). 그래서 끝에 **대조군**
//  (실제 위탁 1건이 픽스처에 닿는다)을 둔다 — 관측 장치가 살아 있다는 증거다.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxEnv, pathWith, writeStubBin } from "../testlib/os-sandbox.mjs";

const pExecFile = promisify(execFile);
const HERE = join(fileURLToPath(import.meta.url), "..");
const CLI = join(HERE, "lively.mjs");
const { parseDelegateArgv, delegateUsage } = await import(pathToFileURL(join(HERE, "cmd-delegate.mjs")));
const { helpRequest } = await import(pathToFileURL(CLI));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

// ── A. 순수 해석 — `lively delegate` 인자 표 ─────────────────────────────────
const D = (args) => parseDelegateArgv(args);
check("A1 --help → help", D(["--help"]).action === "help");
check("A2 -h → help", D(["-h"]).action === "help");
check("A3 첫 낱말 help → help", D(["help"]).action === "help");
check("A4 지시 뒤 --help 도 help(위탁 안 함)", D(["테스트 실행", "--ram", "2048", "--help"]).action === "help");
check("A5 하위 명령 뒤 --help 도 help", D(["logs", "3", "--help"]).action === "help");
{
  const r = D(["설명해", "--", "--help"]);
  check("A6 -- 뒤 --help 는 지시의 일부", r.action === "run" && r.prompt === "설명해 --help" && !r.error, JSON.stringify(r));
}
check("A7 모르는 옵션 → 오류", /알 수 없는 옵션: --detatch/.test(D(["x", "--detatch"]).error || ""));
check("A8 값 없는 --ram → 오류", /값이 필요/.test(D(["x", "--ram"]).error || ""));
check("A9 숫자 아닌 --ram → 오류", /양수/.test(D(["x", "--ram", "lots"]).error || ""));
check("A10 경계: --ram 0 → 오류", /양수/.test(D(["x", "--ram", "0"]).error || ""));
check("A11 --repo 뒤가 옵션이면 값 없음 오류", /값이 필요/.test(D(["x", "--repo", "--docker"]).error || ""));
check("A12 지시 없음 → 오류", /작업 지시가 필요/.test(D([]).error || ""));
check("A13 빈 꼬리 `x --` → 지시 x", D(["x", "--"]).prompt === "x" && !D(["x", "--"]).error);
check("A14 status 번호 없음 → 오류", D(["status"]).action === "status" && !!D(["status"]).error);
{
  const r = D(["npm test", "--ram", "2048", "--cpu", "2", "--docker", "--repo", "lively", "--ref", "main", "--node", "n1", "--timeout", "900", "--json"]);
  check("A15 정상 위탁 — 옵션 전부 해석", !r.error && r.action === "run" && r.prompt === "npm test" && r.json
    && r.need.need_ram_mb === 2048 && r.need.need_cpu === 2 && r.need.needs_docker === true && r.need.repo === "lively"
    && r.need.ref === "main" && r.need.node === "n1" && r.need.timeout_sec === 900, JSON.stringify(r));
}
check("A16 따옴표로 묶은 '-x …' 지시·음수는 옵션이 아니다", D(["-x 로 실행"]).prompt === "-x 로 실행" && D(["차이", "-1"]).prompt === "차이 -1");
check("A17 --json-events(전역 계약)는 무시", D(["x", "--json-events"]).prompt === "x" && !D(["x", "--json-events"]).error);
{
  const r = D(["x", "--ram=2048", "--repo=lively"]);
  check("A19 --ram=2048 · --repo=lively(값 붙인 꼴) → 옵션으로 해석", !r.error && r.prompt === "x" && r.need.need_ram_mb === 2048 && r.need.repo === "lively", JSON.stringify(r));
}
check("A20 --ram= (빈 값) → 오류", /값이 필요/.test(D(["x", "--ram="]).error || ""));
check("A21 모르는 --foo=bar → 오류(지시에 붙지 않음)", /알 수 없는 옵션: --foo=bar/.test(D(["x", "--foo=bar"]).error || ""));
check("A22 옵션 뒤 하위 명령(--json logs 3) → 위탁 아님 · 오류", /맨 앞에/.test(D(["--json", "logs", "3"]).error || ""));
check("A23 따옴표로 묶은 «logs 3 정리해» 는 지시", D(["logs 3 정리해"]).prompt === "logs 3 정리해" && !D(["logs 3 정리해"]).error);
check("A18 사용법이 «실제 위탁이 생성» 경고를 담는다", /실제 위탁이 생성/.test(delegateUsage()));

// ── B. 순수 해석 — 전역 helpRequest ──────────────────────────────────────────
const H = (s) => helpRequest(s.split(" ").filter(Boolean));
check("B1 lively --help → 전체", H("--help")?.topic === null);
check("B2 lively help → 전체", H("help")?.topic === null);
check("B3 lively help delegate → delegate", H("help delegate")?.topic === "delegate");
check("B4 lively --help delegate → delegate", H("--help delegate")?.topic === "delegate");
check("B5 lively uninstall -h → uninstall", H("uninstall -h")?.topic === "uninstall");
check("B6 lively repo help → repo", H("repo help")?.topic === "repo");
check("B7 lively run help 는 도움말 아님(하네스 인자 자리)", H("run help") === null);
check("B8 lively delegate x -- --help 는 도움말 아님", H("delegate x -- --help") === null);
check("B9 평범한 명령 · 빈 argv 는 null", H("status --json") === null && H("delegate 테스트") === null && H("") === null);

// ── C. e2e — 진짜 CLI 가 아무것도 하지 않는다 ─────────────────────────────────
const BOX = mkdtempSync(join(tmpdir(), "lively-help-guard-"));
const HOME = join(BOX, "home"); mkdirSync(HOME);
const BIN = join(BOX, "bin");
// claude 스텁 — onboarding/run 이 실제로 하네스를 띄우면 흔적 파일이 남는다.
const CLAUDE_TRACE = join(BOX, "claude-was-run");
writeStubBin(BIN, "claude", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(CLAUDE_TRACE)}, process.argv.slice(2).join(" ")); process.exit(7);`);
const requests = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ task: { id: 1 } }));
});
//  키트 시험 샌드박스(LIVELY_HOST_EFFECTS_TEST_MODE=sandbox)는 루프백 32768 이상만 연다 — 그 범위를 받을 때까지 다시 연다
//   (file-address.test.mjs 와 같은 사연). ⚠ 네트워크가 막힌 채면 «요청 0건» 이 가드 덕인지 차단 덕인지 구별되지 않는다.
for (let i = 0; ; i++) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  if (server.address().port >= 32768 || i >= 50) break;
  await new Promise((r) => server.close(r));
}
const GW = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, ...sandboxEnv({ home: HOME }), LIVELY_HOME: HOME, LIVELY_GATEWAY_URL: GW, LIVELY_TOKEN: "lvk_test_help_guard",
  LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", PATH: pathWith(BIN) };

async function lively(args, cli = CLI) {
  try {
    const { stdout, stderr } = await pExecFile(process.execPath, [cli, ...args], { env, timeout: 15000 });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) { return { code: e.code ?? -1, out: e.stdout || "", err: e.stderr || "" }; }
}

try {
  const DELEGATE_USAGE = /lively delegate "<작업 지시>"/;
  const cases = [
    [["delegate", "--help"], DELEGATE_USAGE],
    [["delegate", "-h"], DELEGATE_USAGE],
    [["delegate", "help"], DELEGATE_USAGE],
    [["delegate", "테스트 실행", "--ram", "2048", "--help"], DELEGATE_USAGE],
    [["delegate", "logs", "3", "--help"], DELEGATE_USAGE],
    [["help", "delegate"], DELEGATE_USAGE],
    [["--help", "delegate"], DELEGATE_USAGE],
    [["uninstall", "--help"], /uninstall\s+제거/],
    [["remove", "--help"], /uninstall\s+제거/],
    [["logout", "--help"], /logout\s+토큰만 지움/],
    [["login", "--help"], /login\s+접속 토큰 등록/],
    [["install", "--help"], /install\s+키트 설치/],
    [["update", "-h"], /update\s+지금 최신으로/],
    [["setup", "--help"], /setup\s+로그인 \+ 설치/],
    [["onboarding", "--help"], /onboarding\s+내 환경 정리/],
    [["run", "--help"], /run \[<프로젝트번호>\]/],
    [["init", "--create", "--help"], /init\s+지금 폴더를 프로젝트로/],
    [["mode", "readonly", "--help"], /mode \[<normal/],
    [["workspace", "switch", "--help"], /workspace\s+지금 매여 있는/],
    [["repo", "worktree", "lively", "--help"], /repo worktree <레포>/],
    [["file", "url", "x", "--help"], /file url <주소>/],
    [["share", "--help"], /share \[<세션id>\]/],
    [["resume", "abc", "--help"], /resume <세션id>/],
    [["backfill", "--help"], /backfill\s+이 PC 의 기존/],
    [["mcp", "--help"], /lively mcp\b/],
    [["mcp-local", "-h"], /lively mcp-local\b/],
    [["--help"], /lively — 라이블리 키트 명령/],
    [["help"], /lively — 라이블리 키트 명령/],
  ];
  for (const [args, re] of cases) {
    const before = requests.length;
    const r = await lively(args);
    const text = r.out + r.err;
    check(`C lively ${args.join(" ")} → 종료 0 · 사용법(stdout)`, r.code === 0 && re.test(r.out), `code=${r.code}\n${text.slice(0, 300)}`);
    check(`C lively ${args.join(" ")} → 게이트웨이 요청 0건`, requests.length === before, requests.slice(before).join(", "));
  }
  check("C ★ 샌드박스 HOME 무변경(설치·제거·토큰 파일 0)", readdirSync(HOME).length === 0, readdirSync(HOME).join(", "));
  check("C ★ 하네스(claude) 기동 0", !existsSync(CLAUDE_TRACE));

  // 모르는 명령 · 모르는 옵션은 실행하지 않고 2 로 끝난다.
  const u = await lively(["help", "nosuch"]);
  check("C help nosuch → 종료 2", u.code === 2 && /알 수 없는 명령: nosuch/.test(u.err), `code=${u.code}`);
  const t = await lively(["uninstall", "--dryrun"]);
  check("C uninstall --dryrun(오타) → 실행 안 함 · 종료 2", t.code === 2 && /알 수 없는 옵션: --dryrun/.test(t.err), `code=${t.code}\n${t.err.slice(0, 200)}`);
  const dt = await lively(["delegate", "run tests", "--detatch"]);
  check("C delegate --detatch(오타) → 종료 2", dt.code === 2, `code=${dt.code}`);
  check("C ★ 지금까지 POST 0건", !requests.some((x) => x.startsWith("POST")), requests.join(", "));

  // 부트스트랩 직후처럼 lively.mjs 한 파일만 있을 때도(형제 모듈 부재) delegate --help 는 위탁하지 않는다.
  const SOLO = join(BOX, "solo"); mkdirSync(SOLO);
  copyFileSync(CLI, join(SOLO, "lively.mjs"));
  const before = requests.length;
  const s = await lively(["delegate", "--help"], join(SOLO, "lively.mjs"));
  check("C 형제 모듈 부재 → HELP 절 폴백 · 종료 0 · 요청 0", s.code === 0 && /delegate "<작업>"/.test(s.out) && requests.length === before,
    `code=${s.code}\n${s.err.slice(0, 200)}`);

  // 대조군 — 관측 장치가 살아 있다(하네스 스텁이 실제로 불리면 흔적이 남는다).
  //  ⚠ onboarding 이 아니라 run 으로 잰다: onboarding 은 셸 없이 spawnSync("claude") 라 윈도우에선 .cmd 스텁이 애초에
  //   안 뜬다(그래서 윈도우 CI 에서 이 대조군이 빨갛게 나왔다). run 은 윈도우에서 셸을 거쳐 띄우므로 두 플랫폼 모두에서 뜬다.
  const rc = await lively(["run"]);
  check("C 대조: run(도움말 없이) → 하네스 스텁 기동 흔적", existsSync(CLAUDE_TRACE), `code=${rc.code}\n${rc.err.slice(0, 300)}`);

  // 대조군 — 네트워크 관측이 살아 있고, 가드가 정상 위탁을 막지 않는다(`--` 뒤의 --help 는 지시의 일부).
  const d = await lively(["delegate", "--detach", "--", "--help 옵션 설명해"]);
  check("C 대조: delegate --detach -- … → 실제 위탁(POST 1건)", d.code === 0 && requests.filter((x) => x.startsWith("POST /api/ui/delegate")).length === 1,
    `code=${d.code} reqs=${requests.join(", ")}\n${d.err.slice(0, 600)}`);
} finally {
  server.close();
  try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
