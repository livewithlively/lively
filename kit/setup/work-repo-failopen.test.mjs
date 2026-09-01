#!/usr/bin/env node
// #1155 사양 테스트 — "레포를 못 가져와도 run 자체는 된다(대화형 fail-open), 대신 그 사실을 사람·AI 양쪽에 남긴다".
//   실행: node kit/setup/work-repo-failopen.test.mjs   (exit 0=통과, 1=실패)
//   네트워크 불요 — 게이트웨이는 로컬 HTTP 스텁, git 실패는 전부 로컬 재현(없는 원본 clone·브랜치 점유).
//   ⚠ 구현 재진술 금지 — 관찰 가능한 결과만 단언한다: 종료코드 · 마커 파일(JSON) · 통지 반환값 · git 스텁의 argv/env 로그.
//
// 사양 엣지(spec 표 E1~E14):
//   E1 레포 0개 → 무회귀(실패 키 없음)                E8  git 은 자격 프롬프트 없이 호출된다
//   E2 경로에 레포 없고 git 주소도 없음               E9  통지: 이름·사유·복구안내·임의 clone 금지
//   E3 clone 실패                                     E10 통지: 기대경로에 코드가 이미 있으면 침묵
//   E4 worktree add 실패(브랜치 점유)                 E11 통지: 일부만 복구되면 나머지만
//   E5 부분 실패 — 나머지는 준비됨                    E12 통지: 마커/실패키 부재 → 침묵
//   E6 --require-repo → 즉시 실패                     E13 통지: 마커 파손 → 침묵(예외 없음)
//   E7 성공 실행이 실패 기록 제거 + 남의 키 보존      E14 통지: 하위 폴더에서 상위 마커 탐색
import { repoStatusNotice } from "../hooks/session-preload.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";
import { WIN, pathWith, writeStubBin } from "../testlib/os-sandbox.mjs";   // 스텁은 윈도우에서도 실행 가능해야 한다(#1510)

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why = "") => { cond ? ok(n) : bad(n, why); };
const run = async (n, fn) => { try { await fn(); } catch (e) { bad(n, `threw: ${(e && e.stack) || e}`); } };

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work.mjs");
const PID = "1155";
const b64 = (specs) => Buffer.from(JSON.stringify(specs), "utf8").toString("base64");
const NEVER = join(tmpdir(), "lively-1155-존재하지-않는-경로");  // 어떤 테스트도 만들지 않는 경로

// ── 게이트웨이 스텁 — work.mjs 는 시작 시 공유폴더 매니페스트를 받아야 진행한다(빈 목록 = pull 0건) ──
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ files: [], newest: 0, count: 0 }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

const trash = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); trash.push(d); return d; };
function newHome() {
  const h = tmp("wf-home-");
  mkdirSync(join(h, ".lively"), { recursive: true });
  writeFileSync(join(h, ".lively", "token"), "test-token\n");
  return h;
}
// work.mjs 1회 실행 — 하네스는 띄우지 않는다(--no-launch = 준비 단계까지). pathPrefix 로 git 스텁 주입 가능.
//  ⚠ 반드시 비동기 spawn — spawnSync 로 돌리면 이 프로세스의 이벤트루프가 멈춰 위 게이트웨이 스텁이 응답을 못 하고
//   work.mjs 가 매니페스트를 기다리며 영영 멈춘다(교착).
function runWork(home, extra, pathPrefix) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LIVELY_GATEWAY_URL: GW, LIVELY_TOKEN: "test-token" };
  if (pathPrefix) env.PATH = pathWith(pathPrefix);
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [WORK, PID, "--no-launch", ...extra], { env });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
  });
}
const projDir = (home) => join(home, "lively", "projects", PID);
const markerPath = (home) => join(projDir(home), ".lively", "project.json");
const markerOf = (home) => (existsSync(markerPath(home)) ? JSON.parse(readFileSync(markerPath(home), "utf8")) : null);
const failedOf = (home) => ((markerOf(home) || {}).repos_failed) || [];
// 준비에 성공할 수 있는 진짜 레포. commits=true 면 커밋 1개(worktree 를 만들려면 HEAD 가 필요).
function initRepo(dir, commits = false) {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore", env: { ...process.env, ...offlineLivelyEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  if (commits) { writeFileSync(join(dir, "f.txt"), "x\n"); g("add", "f.txt"); g("commit", "-qm", "init"); }
  return dir;
}

// ══════════════════════════════════════════════════════════════════════════
// E1 — 레포 spec 이 없으면 아무 실패도 없다(무회귀: 공유폴더만 쓰는 비개발자 경로)
await run("E1 레포 0개 → 실패 기록 없음", async () => {
  const home = newHome();
  const { code } = await runWork(home, []);
  const m = markerOf(home);
  check("E1 종료 0", code === 0, `code=${code}`);
  check("E1 마커 기록됨", !!m && m.project_id === 1155, JSON.stringify(m));
  check("E1 실패 키 부재", !!m && !("repos_failed" in m), JSON.stringify(m));
  check("E1 게이트웨이를 실제로 호출함(스텁 배선 확인)", hits.some((u) => u.includes("/shared/manifest")), JSON.stringify(hits));
});

// ══════════════════════════════════════════════════════════════════════════
// E2 — 경로에 레포도 없고 git 주소도 없다 → 죽지 않고 기록한다
await run("E2 레포 없음 + 주소 없음 → fail-open + 기록", async () => {
  const home = newHome();
  const missing = join(home, "없는-레포");
  const { code, out } = await runWork(home, ["--repos", b64([{ name: "ghost", path: missing, worktree: false }])]);
  const m = markerOf(home), f = failedOf(home);
  check("E2 종료 0(하네스 단계까지 도달)", code === 0, `code=${code}\n${out}`);
  check("E2 마커 기록됨(레포 실패가 마커 단계를 막지 않음)", !!m && m.project_id === 1155, JSON.stringify(m));
  check("E2 실패 1건", f.length === 1, JSON.stringify(f));
  check("E2 이름", f[0] && f[0].name === "ghost", JSON.stringify(f[0]));
  check("E2 사유 있음", !!(f[0] && f[0].reason), JSON.stringify(f[0]));
  check("E2 복구안내 있음", !!(f[0] && f[0].hint), JSON.stringify(f[0]));
  check("E2 기대경로 = 준비됐어야 할 자리", f[0] && f[0].expect === missing, JSON.stringify(f[0]));
  check("E2 성공목록 0건", !!m && Array.isArray(m.repos) && m.repos.length === 0, JSON.stringify(m && m.repos));
  check("E2 사람에게도 알림", /레포 준비 실패/.test(out), out.slice(-500));
});

// ══════════════════════════════════════════════════════════════════════════
// E3 — clone 실패(원본이 없는 주소) → 죽지 않고 기록한다
await run("E3 clone 실패 → fail-open + 기록", async () => {
  const home = newHome();
  const { code } = await runWork(home, ["--repos", b64([{ name: "broken", path: join(home, "dst"), gitUrl: NEVER, worktree: false }])]);
  const f = failedOf(home);
  check("E3 종료 0", code === 0, `code=${code}`);
  check("E3 실패 1건", f.length === 1, JSON.stringify(f));
  check("E3 사유가 clone 실패를 지목", /clone/i.test((f[0] || {}).reason || ""), JSON.stringify(f[0]));
  check("E3 복구안내 있음", !!(f[0] || {}).hint, JSON.stringify(f[0]));
});

// ══════════════════════════════════════════════════════════════════════════
// E4 — worktree add 실패(같은 브랜치를 다른 워크트리가 이미 쥠) → 죽지 않고, 안내가 그 상황을 지목
await run("E4 worktree 점유 → fail-open + 점유 안내", async () => {
  const home = newHome();
  const base = initRepo(join(home, "base-repo"), true);
  // project/1155 브랜치를 프로젝트 폴더 **밖**의 워크트리가 먼저 점유 → work.mjs 의 -b/attach 둘 다 실패한다.
  execFileSync("git", ["worktree", "add", join(home, "held"), "-b", `project/${PID}`], { cwd: base, stdio: "ignore" });
  const { code } = await runWork(home, ["--repos", b64([{ name: "base-repo", path: base, worktree: true }])]);
  const f = failedOf(home);
  check("E4 종료 0", code === 0, `code=${code}`);
  check("E4 실패 1건", f.length === 1, JSON.stringify(f));
  check("E4 안내가 '한 브랜치 두 워크트리'를 지목", /워크트리/.test((f[0] || {}).hint || ""), JSON.stringify(f[0]));
  check("E4 기대경로 = 프로젝트 폴더 아래 자리", (f[0] || {}).expect === join(projDir(home), "base-repo"), JSON.stringify(f[0]));
});

// ══════════════════════════════════════════════════════════════════════════
// E5 — 부분 실패: 하나가 실패해도 나머지는 준비된다
await run("E5 부분 실패 — 나머지는 정상 준비", async () => {
  const home = newHome();
  const good = initRepo(join(home, "good-repo"));
  const { code } = await runWork(home, ["--repos", b64([
    { name: "ghost", path: join(home, "없는-레포"), worktree: false },
    { name: "good", path: good, worktree: false },
  ])]);
  const m = markerOf(home);
  check("E5 종료 0", code === 0, `code=${code}`);
  check("E5 성공 1건", !!m && m.repos.length === 1 && m.repos[0].name === "good", JSON.stringify(m && m.repos));
  check("E5 실패 1건", failedOf(home).length === 1 && failedOf(home)[0].name === "ghost", JSON.stringify(failedOf(home)));
  check("E5 성공 레포는 접근 대상으로 배선됨",
    JSON.parse(readFileSync(join(projDir(home), ".claude", "settings.local.json"), "utf8")).additionalDirectories.includes(good),
    "add-dir 설정에 성공 레포가 없음");
});

// ══════════════════════════════════════════════════════════════════════════
// E6 — 엄격 모드(자동화·프로비저닝)는 종전 동작을 유지한다
await run("E6 --require-repo → 즉시 실패", async () => {
  const home = newHome();
  const { code, out } = await runWork(home, [
    "--repos", b64([{ name: "ghost", path: join(home, "없는-레포"), worktree: false }]), "--require-repo",
  ]);
  check("E6 종료 ≠ 0", code !== 0, `code=${code}`);
  check("E6 사유 출력", /레포 준비 실패/.test(out), out.slice(-500));
  check("E6 마커 미기록(준비 전 중단)", markerOf(home) === null, JSON.stringify(markerOf(home)));
});

// ══════════════════════════════════════════════════════════════════════════
// E7 — 성공하면 실패 기록이 사라진다 + 다른 writer 의 키는 보존된다
await run("E7 성공 실행이 실패 기록을 지우고 남의 키는 보존", async () => {
  const home = newHome();
  const good = initRepo(join(home, "good-repo"));
  await runWork(home, ["--repos", b64([{ name: "ghost", path: join(home, "없는-레포"), worktree: false }])]);
  check("E7 준비: 1차 실행이 실패를 남김", failedOf(home).length === 1, JSON.stringify(failedOf(home)));
  // 서버측 writeProvisionMarker 가 같은 파일에 쓰는 키를 흉내 — 우리 쓰기가 이걸 지우면 안 된다.
  const m0 = markerOf(home);
  m0.provisioned = [{ repo: "x", path: "/somewhere" }];
  writeFileSync(markerPath(home), JSON.stringify(m0, null, 2));
  await runWork(home, ["--repos", b64([{ name: "good", path: good, worktree: false }])]);
  const m = markerOf(home);
  check("E7 실패 키 제거", !("repos_failed" in m), JSON.stringify(m.repos_failed));
  check("E7 남의 키 보존", Array.isArray(m.provisioned) && m.provisioned[0].repo === "x", JSON.stringify(m.provisioned));
  check("E7 우리 키 정상", m.project_id === 1155 && !!m.sync && m.repos.length === 1, JSON.stringify(m));
});

// ══════════════════════════════════════════════════════════════════════════
// E8 — git 은 '대기'하지 않고 실패해야 한다: 자격 프롬프트 비활성으로 호출되는지 스텁으로 관측
await run("E8 git 호출 환경 — 자격 프롬프트 비활성", async () => {
  // ⚠ 윈도우에선 git 을 가로챌 수 없다 — work.mjs 는 `spawnSync("git", …)` 를 **셸 없이** 부르고,
  //  node 는 보안 수정(BatBadBut) 이후 shell:true 없이 .cmd/.bat 스폰을 거부한다. 스텁으로 만들 수 있는
  //  실행형은 .cmd 뿐이라(진짜 .exe 는 테스트가 못 만든다) 관측 자체가 성립하지 않는다.
  //  단언 대상(GIT_TERMINAL_PROMPT=0 등)은 플랫폼 무관 코드라 POSIX 실행이 그대로 덮는다(#1510).
  if (WIN) { console.log("skip E8 — 윈도우는 셸 없는 spawn 이라 git 스텁을 끼울 수 없다(.cmd 스폰 거부)"); return; }
  const home = newHome();
  const binDir = tmp("wf-bin-");
  const logFile = join(binDir, "git-calls.log");
  // PATH 앞에 놓는 git 스텁 — argv 와 관심 env 를 기록하고 실패로 끝난다(=clone 실패 경로 유도).
  // 스텁 본문은 JS 한 벌 — sh 로 쓰면 윈도우에서 실행조차 안 돼 가로채기가 조용히 실패한다(#1510).
  writeStubBin(binDir, "git", [
    'import { appendFileSync } from "node:fs";',
    `const LOG = ${JSON.stringify(logFile)};`,
    'const argv = process.argv.slice(2).join(" ");',
    'const e = (k) => process.env[k] ?? "";',
    'appendFileSync(LOG, `argv=${argv} prompt=[${e("GIT_TERMINAL_PROMPT")}] gcm=[${e("GCM_INTERACTIVE")}]\\n`);',
    "process.exit(1);",
  ].join("\n"));
  const { code } = await runWork(home, ["--repos", b64([{ name: "any", path: join(home, "dst"), gitUrl: NEVER, worktree: false }])], binDir);
  const calls = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : [];
  check("E8 스텁이 실제로 불림(관측 배선 확인)", calls.length > 0, "git 스텁 호출 0건 — 테스트가 아무것도 못 본다");
  check("E8 clone 이 시도됨", calls.some((l) => l.includes("clone")), JSON.stringify(calls));
  check("E8 모든 호출에 프롬프트 비활성", calls.every((l) => l.includes("prompt=[0]")), JSON.stringify(calls));
  check("E8 실패해도 종료 0", code === 0, `code=${code}`);
});

// ══════════════════════════════════════════════════════════════════════════
// E9~E14 — 세션 프리로드 통지(AI 가 읽는 채널)
function noticeDir(marker) {
  const d = tmp("wf-notice-");
  mkdirSync(join(d, ".lively"), { recursive: true });
  writeFileSync(join(d, ".lively", "project.json"), typeof marker === "string" ? marker : JSON.stringify(marker));
  return d;
}
const FAILED_GHOST = { name: "ghost", reason: "git clone 실패 — 인증 거부됨", hint: "gh auth login 후 다시 준비하세요", expect: NEVER };

await run("E9 통지 — 이름·사유·복구안내·임의 clone 금지", () => {
  const t = repoStatusNotice(noticeDir({ project_id: 1155, repos_failed: [FAILED_GHOST] }));
  check("E9 통지 생성", typeof t === "string" && t.length > 0, String(t));
  check("E9 레포 이름", /ghost/.test(t || ""), String(t));
  check("E9 사유", /인증 거부됨/.test(t || ""), String(t));
  check("E9 복구안내", /gh auth login/.test(t || ""), String(t));
  check("E9 기대경로", (t || "").includes(NEVER), String(t));
  check("E9 임의 clone 금지 지시", /clone 하지 마세요/.test(t || ""), String(t));
});

await run("E10 통지 — 기대경로에 코드가 이미 있으면 침묵(복구됨)", () => {
  const t = repoStatusNotice(noticeDir({ project_id: 1155, repos_failed: [{ ...FAILED_GHOST, expect: HERE }] }));
  check("E10 null", t === null, String(t));
});

await run("E11 통지 — 일부만 복구되면 나머지만 알린다", () => {
  const t = repoStatusNotice(noticeDir({ project_id: 1155, repos_failed: [
    { ...FAILED_GHOST, name: "fixed", expect: HERE },
    { ...FAILED_GHOST, name: "still-broken" },
  ] }));
  check("E11 복구 안 된 것 포함", /still-broken/.test(t || ""), String(t));
  check("E11 복구된 것 제외", !/fixed/.test(t || ""), String(t));
});

await run("E12 통지 — 마커 없음 / 실패 키 부재 → 침묵", () => {
  check("E12 마커 없음", repoStatusNotice(tmp("wf-empty-")) === null, "마커 없는 폴더에서 통지 생성됨");
  check("E12 실패 키 부재", repoStatusNotice(noticeDir({ project_id: 1155, repos: [] })) === null, "실패 키 없는 마커에서 통지 생성됨");
  check("E12 빈 배열", repoStatusNotice(noticeDir({ project_id: 1155, repos_failed: [] })) === null, "빈 실패 배열에서 통지 생성됨");
});

await run("E13 통지 — 마커 파손이 세션을 막지 않는다", () => {
  check("E13 파손 JSON → null", repoStatusNotice(noticeDir("{not json{")) === null, "파손 마커에서 통지 생성됨");
});

await run("E14 통지 — 하위 폴더에서도 상위 마커를 찾는다", () => {
  const d = noticeDir({ project_id: 1155, repos_failed: [FAILED_GHOST] });
  const sub = join(d, "a", "b");
  mkdirSync(sub, { recursive: true });
  check("E14 상위 탐색", /ghost/.test(repoStatusNotice(sub) || ""), String(repoStatusNotice(sub)));
});

// ── 정리 ──
server.close();
for (const d of trash) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
