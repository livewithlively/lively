#!/usr/bin/env node
// 가드 — **lively CLI 를 프로세스로 띄우는 테스트는 하네스(claude·codex)를 PATH 에서 가려야 한다** (#1431)
//  실행: node kit/cli/cli-spawn-harness-sandbox.test.mjs   (정적 스캔 — 프로세스를 띄우지 않는다)
//
// 왜 — 유닛 테스트가 **사람의 로컬 하네스 설치·MCP 설정에 시간과 결과를 의존하면** 같은 커밋이 사람마다
//  다르게 걸리고, CI(claude 없음)에서는 그 비용이 0이라 아무도 못 본다. 실측 사고(2026-08-03):
//  `kit/cli/project-status.test.mjs` 가 `lively status` 를 13번 띄웠고 그 프로브가 실제 `claude mcp list`
//  (등록 MCP 전체 헬스체크·최대 8s)를 불러 **혼자 36.5초 — 유닛 체인 전체의 30%** 였다. 스텁으로 가리자 1.6초.
//  → 원인을 프로브 쪽에서도 고쳤지만(우리 서버만 조회), **CLI 의 어떤 하위명령이 언제 하네스를 만질지는 모른다**
//    (`resume` 는 실제로 `claude` 를 띄우는 명령이다). 그래서 '띄우는 쪽'에 관례를 걸어 재침식을 막는다.
//
// 규칙 — `kit/**/*.test.mjs` 중 **CLI 경로를 argv 로 넘겨 프로세스를 띄우는** 파일은 그 파일 안에
//  `PATH:` 오버라이드가 있어야 한다(스텁 bin 을 앞에 두어 실제 claude·codex 를 가리는 관례 —
//  `kit/cli/lively.test.mjs` 의 newHome 이 원형이다). 닫힌 PATH 로 아예 없애는 것도 통과다.
//  ⚠ '문구' 가 아니라 **관례 존재**를 본다 — 무엇을 어떻게 스텁했는지는 각 테스트의 자유다.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

// CLI 를 프로세스로 띄우는가 — `[CLI` 가 spawn/execFile 호출의 argv 자리에 오는지 본다(호출이 여러 줄에 걸쳐도
//  잡히도록 앞 2줄까지 함께 본다). 문자열로 "lively.mjs" 만 언급하는 파일(정적 분석 테스트 등)은 대상이 아니다.
const SPAWN = /(spawnSync|spawn|execFile|execFileSync|pExecFile)\s*\(/;
function spawnsCli(src) {
  const lines = src.split("\n");
  return lines.some((l, i) => {
    if (!/\[\s*CLI\b/.test(l)) return false;
    return [l, lines[i - 1] ?? "", lines[i - 2] ?? ""].some((x) => SPAWN.test(x));
  });
}
const shieldsPath = (src) => /\bPATH:/.test(src);
// 위반이면 이유 문자열, 아니면 null.
const violation = (src) => (spawnsCli(src) && !shieldsPath(src) ? "CLI 를 띄우는데 PATH 오버라이드가 없다(실제 claude·codex 가 잡힌다)" : null);

// ── ① 레포 전수 스캔 ──
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.test\.mjs$/.test(e.name)) files.push(f);
  }
})(path.join(ROOT, "kit"));

const spawners = [], violations = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (!spawnsCli(src)) continue;
  const rel = path.relative(ROOT, f);
  spawners.push(rel);
  const why = violation(src);
  if (why) violations.push(`${rel} — ${why}`);
}
violations.length
  ? bad("① CLI 를 띄우는 테스트는 하네스를 PATH 에서 가린다", `위반 ${violations.length}건:\n    ` + violations.join("\n    "))
  : ok(`① CLI 를 띄우는 테스트 ${spawners.length}건 전부 하네스를 PATH 에서 가린다`);

// ── ② 배선 단언 — 스캐너가 실제로 뭔가를 찾았나. 0건이면 위 ①은 통과하면서 아무것도 안 본다 ──
spawners.length >= 3
  ? ok(`② 배선 — 스캐너가 CLI 스포너를 ${spawners.length}건 찾았다(공허한 통과 아님)`)
  : bad("② 배선 — CLI 스포너를 거의 못 찾았다(탐지 규칙이 깨졌을 가능성)", `찾은 것: ${JSON.stringify(spawners)}`);

// ── ③ 자기검증 — 규칙이 '무력화'되지 않았음을 known-bad / known-good 샘플로 증명 ──
const BAD = [
  // 실제로 있었던 형태 — env 를 주지만 PATH 는 안 건드린다(주변 PATH 의 실제 claude 가 잡힌다).
  'const c = spawn(process.execPath, [CLI, "resume", sid], { cwd, env: { ...process.env, LIVELY_HOME: home } });',
  // 여러 줄에 걸친 호출(실제 코드 스타일)
  'await pExecFile(process.execPath, [CLI, "status", "--json"], {\n  cwd, env: { ...process.env, LIVELY_HOME: HOME },\n});',
];
for (const s of BAD) {
  violation(s) ? ok(`③ known-bad 를 잡는다: ${s.split("\n")[0].slice(0, 60)}…`)
    : bad("③ 규칙이 known-bad 를 못 잡음(퇴화)", s.slice(0, 120));
}
const GOOD = [
  // 스텁 bin 을 앞에 둔 형태(관례)
  'spawn(process.execPath, [CLI, "share"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });',
  // 닫힌 PATH(실제 하네스가 아예 없다)
  'spawnSync(process.execPath, [CLI, "status"], { env: { PATH: `${bin}:/usr/bin:/bin` } });',
  // CLI 를 안 띄우는 파일 — 문자열로만 언급(정적 분석 테스트). 대상이 아니다.
  'const isSpawn = (l) => /(spawnSync|spawn)\\(/.test(l);  // "lively.mjs" 를 읽어 검사만 한다',
  // 다른 프로그램을 띄우는 파일
  'spawnSync(pwsh, ["-NoProfile", "-Command", parse], { encoding: "utf8" });',
];
for (const s of GOOD) {
  violation(s) === null ? ok(`③ 정상 샘플 오탐 없음: ${s.slice(0, 60)}…`)
    : bad("③ 정상인데 오탐", s.slice(0, 120));
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
