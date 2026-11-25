#!/usr/bin/env node
// `lively doctor` 의 git 접속(ssh) 점검 계약 — 실행: node kit/cli/doctor-git-ssh.test.mjs
//  실제 홈·실제 ssh·외부 네트워크 무접촉: HOME·LIVELY_HOME·임시폴더 샌드박스 + PATH 에는 스텁 폴더만(시스템 경로가 없어 진짜 ssh 가
//  잡힐 자리가 없다) + 루프백 스텁 게이트웨이. 자식은 늘 host-effects sandbox 모드(LIVELY_HOST_EFFECTS=deny + TEST_MODE=sandbox)로
//  띄운다 — 그 모드는 샌드박스(LIVELY_HOME·임시폴더) 안의 실행 파일만 허용하므로, 스텁 ssh 를 LIVELY_HOME 안에 두면 불리고 밖에 두면 막힌다.
//
// 왜 이 파일이 있나 — doctor 는 등록 레포의 ssh 호스트마다 `ssh -T` 를 대화 없이 띄운다(lively.mjs doctorGitSsh).
//  ① 그 레포 목록은 조직 전체라 코드를 안 만지는 구성원에게도 항목이 뜬다 → ! 로 보이되 «N건 문제»·exit code 에 세지 않는다.
//  ② ssh 가 없는 기계(spawn ENOENT)에선 항목을 만들지 않는다 — 모르는 것을 실패로 단정하지 않는다.
//  ③ 이 CLI 의 외부 프로세스는 전부 host-effects 가드를 거친다. ssh 만 가드 없는 spawn 으로 띄워 deny/sandbox 에서도 실제로
//     나갔다(PR #1734 리뷰 실측). 막히면 항목 없이 지나가고 doctor 는 끝까지 돈다.
//  ④ '-' 로 시작하는 호스트·사용자는 ssh 가 옵션으로 읽는다(-oProxyCommand=…) — 아예 부르지 않는다.
//  ⑤ 바뀐 호스트키의 해결 안내 — 22 가 아닌 포트는 known_hosts 에 [host]:port 로 적히므로 그 이름으로 지우라고 한다.
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxEnv, noBrowserEnv, writeStubBin, writeNoopBin } from "../testlib/os-sandbox.mjs";

if (process.platform === "win32") {
  //  윈도우의 spawn 은 셸 없이 이름 뒤에 .com·.exe 만 붙여 찾는다 — 스텁(.cmd 런처)으로 ssh 를 가로챌 수 없다.
  console.log("skip — POSIX 전용(윈도우는 ssh 를 스텁으로 가로챌 수 없다)");
  process.exit(0);
}

const pExecFile = promisify(execFile);
const CLI = join(fileURLToPath(import.meta.url), "..", "lively.mjs");
const { REQUIRED_HOOKS } = await import(pathToFileURL(CLI));   // 기준선 픽스처의 훅 파일 — 제품과 같은 목록을 쓴다
const BOX = realpathSync(mkdtempSync(join(tmpdir(), "lively-doctor-ssh-")));

let pass = 0, fail = 0;
const check = (n, cond, why) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why || "조건 불만족"}`); } };

// ── 스텁 게이트웨이 — doctor 가 묻는 것만 답한다. 레포 목록(REPOS)은 케이스마다 갈아끼운다. ──
let REPOS = [];
const srv = createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const url = req.url || "";
  if (url.startsWith("/api/ui/repos")) return send({ domainmapRepos: REPOS });
  if (url.startsWith("/api/ui/org/runtime-config")) return send({ kit_version: "kit-test", hooks: {} });
  if (url.startsWith("/api/ui/me/profile")) return send({ id: "tester", display_name: "테스터" });
  if (url.startsWith("/api/ui/org/runner/assets")) return send({ assets: [] });
  send({});
});
//  sandbox 모드는 루프백 32768 이상만 연다(host-effects sandboxPortMin) — 그 범위를 받을 때까지 다시 연다(cli-help-guard 와 같은 사연).
for (let i = 0; ; i++) {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  if (srv.address().port >= 32768 || i >= 50) break;
  await new Promise((r) => srv.close(r));
}
const GW = `http://127.0.0.1:${srv.address().port}`;

// 스텁 ssh — 받은 인자를 로그에 적고, 마지막 인자(user@host)의 호스트로 서버 반응을 흉내 낸다.
const sshStub = (log) => [
  'import { appendFileSync } from "node:fs";',
  "const a = process.argv.slice(2);",
  `appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");`,
  'const host = String(a[a.length - 1] || "").replace(/^.*@/, "");',
  'if (host === "h.kr") { process.stderr.write("git@h.kr: Permission denied (publickey).\\n"); process.exit(255); }',
  'if (host === "h2.kr") {',
  '  process.stderr.write("@@@@\\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\\nOffending ED25519 key in /u/.ssh/known_hosts:3\\nHost key verification failed.\\n");',
  "  process.exit(255);",
  "}",
  'process.stdout.write("Welcome to GitLab, @tester!\\n");',
].join("\n");
// 스텁 claude — doctor 가 묻는 `mcp get lively` 에 «등록·연결됨» 으로 답한다(기준선을 «모두 정상» 으로 만드는 칸).
const claudeStub = [
  'if (process.argv.slice(2).join(" ") === "mcp get lively") {',
  '  process.stdout.write("lively:\\n  Scope: User config (available in all your projects)\\n  Status: ✔ Connected\\n  Type: stdio\\n");',
  "}",
].join("\n");

// 케이스 하나 = 홈 하나. 설치가 끝난 모습으로 꾸며 기준선이 «모두 정상» 이 되게 한다 — 그래야 ①의 exit code 단언이 공허하지 않다.
//  ssh: "inside"(LIVELY_HOME 안 — sandbox 가 허용) · "outside"(샌드박스 밖 — sandbox 가 막는다) · "enoent"(있지만 spawn 하면 ENOENT)
function mkCase(name, { ssh = "inside" } = {}) {
  const root = join(BOX, name);
  const home = join(root, "home"), tmp = join(root, "tmp"), bin = join(home, "stub-bin"), outside = join(root, "outside-bin");
  const log = join(root, "ssh-argv.log");
  for (const d of [tmp, bin, outside, join(home, ".lively", "hooks"), join(home, ".claude")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".lively", "gateway-url"), GW + "\n");
  writeFileSync(join(home, ".lively", "token"), "lvk_test_doctor_ssh\n");
  writeFileSync(join(home, ".lively", "kit-version"), "kit-test\n");
  for (const f of REQUIRED_HOOKS) writeFileSync(join(home, ".lively", "hooks", f), "");
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command",
    command: `"${process.execPath}" "${join(home, ".lively", "hooks", "session-preload.mjs")}"` }] }] } }));
  writeStubBin(bin, "claude", claudeStub);
  writeNoopBin(bin, "lively");
  const sshPath = join(ssh === "outside" ? outside : bin, "ssh");
  if (ssh === "inside" || ssh === "outside") writeStubBin(ssh === "outside" ? outside : bin, "ssh", sshStub(log));
  //  해석기가 없는 실행 파일 — 파일은 있어 sandbox 가드를 통과하고, spawn 은 ENOENT 로 끝난다(ssh 미설치와 같은 spawn 결과).
  if (ssh === "enoent") { writeFileSync(sshPath, "#!/nonexistent/lively-test-interpreter\n"); chmodSync(sshPath, 0o755); }
  return { home, tmp, bin, outside, log, sshPath };
}

async function doctor(c) {
  const env = {
    ...process.env, ...sandboxEnv({ home: c.home, tmp: c.tmp }), ...noBrowserEnv(),
    LIVELY_HOME: c.home, LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", CLAUDE_CONFIG_DIR: join(c.home, ".claude"),
    PATH: [c.bin, c.outside].join(delimiter),   // 시스템 경로 없음 — 스텁 말고는 ssh 가 잡힐 자리가 없다
  };
  const r = await pExecFile(process.execPath, [CLI, "doctor"], { cwd: c.home, env, timeout: 60_000 })
    .then((o) => ({ code: 0, ...o }), (e) => ({ code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message) }));
  const lines = String(r.stderr).split("\n");   // 사람용 출력은 stderr(lively.mjs say)
  return {
    code: r.code,
    out: String(r.stderr),
    git: lines.filter((l) => /git 접속/.test(l)),
    // 끝 줄 — «모두 정상입니다.» 또는 «N건 문제 — …». 없으면 doctor 가 끝까지 못 간 것이다.
    summary: lines.map((l) => l.trim()).filter((l) => /^(모두 정상입니다\.|\d+건 문제)/.test(l)).pop() || null,
    fixOf: (name) => { const i = lines.findIndex((l) => l.includes(name)); return i >= 0 && /→ 해결:/.test(lines[i + 1] || "") ? lines[i + 1] : ""; },
  };
}
const sshCalls = (c) => (existsSync(c.log) ? readFileSync(c.log, "utf8").split("\n").filter(Boolean) : []);

try {
  // ── ① advisory — git 접속 항목은 ! 로 보이되 «N건 문제»·exit code 에 세지 않는다 ──
  {
    const c = mkCase("advisory");
    REPOS = [];
    const base = await doctor(c);
    check("① 기준선(ssh 레포 없음)은 «모두 정상» · exit 0 — 아래 비교가 공허하지 않으려면 이래야 한다",
      base.summary === "모두 정상입니다." && base.code === 0, `${base.summary} / exit ${base.code}\n${base.out}`);
    REPOS = [{ clone_url: "git@h.kr:a/x.git" }, { clone_url: "ssh://git@h2.kr:2222/r.git" }];
    const d = await doctor(c);
    check("① 시험 접속이 실제로 났다(관측 장치 생존)", sshCalls(c).length === 2, sshCalls(c).join(" | ") || "호출 0건");
    check("① 키 거부·바뀐 호스트키는 ! 로 보인다(✗ 아님)",
      d.git.length === 2 && d.git.every((l) => /^\s*! git 접속 /.test(l)), d.git.join("\n") || d.out);
    check("① «N건 문제»·exit code 는 기준선 그대로", d.summary === base.summary && d.code === base.code, `${d.summary} / exit ${d.code}`);
    // ⑤ 바뀐 호스트키의 해결 안내 — 22 가 아닌 포트는 known_hosts 에 [host]:port 로 적힌다
    const fix = d.fixOf("git 접속 h2.kr");
    check("⑤ 22 가 아닌 포트의 바뀐 호스트키는 [host]:port 로 지우라고 안내한다",
      fix.includes('ssh-keygen -R "[h2.kr]:2222"') && !fix.includes("ssh-keygen -R h2.kr"), fix || d.out);
  }

  // ── ② ssh 가 없으면(spawn ENOENT) 항목을 만들지 않는다 ──
  {
    const c = mkCase("no-ssh", { ssh: "enoent" });
    //  픽스처 자기 검증 — 이 스텁이 정말 ENOENT 를 내야 이 케이스가 그 갈래를 밟는다.
    const probe = spawnSync(c.sshPath, ["-V"]);
    check("② 픽스처: 스텁 ssh 는 spawn 이 ENOENT 로 끝난다", probe.error?.code === "ENOENT", String(probe.error?.code || `exit ${probe.status}`));
    REPOS = [{ clone_url: "git@h.kr:a/x.git" }, { clone_url: "ssh://git@h2.kr:2222/r.git" }];
    const d = await doctor(c);
    check("② git 접속 항목이 없다", d.git.length === 0, d.git.join("\n"));
    check("② doctor 는 끝까지 돈다(기준선과 같은 «모두 정상» · exit 0)", d.summary === "모두 정상입니다." && d.code === 0, `${d.summary} / exit ${d.code}\n${d.out}`);
  }

  // ── ③ host-effects sandbox — 샌드박스 밖 ssh 는 가드가 막는다. 항목 없이 지나가고 doctor 는 끝까지 돈다 ──
  {
    const c = mkCase("sandbox-deny", { ssh: "outside" });
    //  대조 — 밖에 둔 스텁도 직접 부르면 돈다(안 불린 까닭이 가드여야지 스텁 고장이면 안 된다). 그 흔적은 지우고 시작한다.
    const probe = spawnSync(c.sshPath, ["probe"]);
    check("③ 대조: 샌드박스 밖 스텁 ssh 도 직접 부르면 돈다", probe.status === 0 && sshCalls(c).length === 1, `exit ${probe.status} · ${sshCalls(c).join(" | ")}`);
    rmSync(c.log, { force: true });
    REPOS = [{ clone_url: "git@h.kr:a/x.git" }];
    const d = await doctor(c);
    check("③ 가드가 막은 ssh 는 불리지 않는다", sshCalls(c).length === 0, sshCalls(c).join(" | "));
    check("③ 막힌 호스트는 항목을 만들지 않는다", d.git.length === 0, d.git.join("\n"));
    check("③ doctor 는 죽지 않고 끝까지 돈다", d.summary === "모두 정상입니다." && d.code === 0 && !/HostEffects denied/.test(d.out),
      `${d.summary} / exit ${d.code}\n${d.out}`);
  }

  // ── ④ '-' 로 시작하는 호스트·사용자는 ssh 옵션이 된다 — 부르지 않는다(정상 호스트를 대조로 함께 둔다) ──
  {
    const c = mkCase("dash-host");
    REPOS = [
      { clone_url: "ssh://git@-oProxyCommand=x/r.git" },
      { clone_url: "git@-oProxyCommand=y:o/r.git" },
      { clone_url: "-oProxyCommand=z@h.kr:o/r.git" },
      { clone_url: "git@ok.kr:o/r.git" },
    ];
    const d = await doctor(c);
    const calls = sshCalls(c);
    check("④ '-' 호스트·사용자로는 ssh 를 부르지 않는다", !calls.some((l) => /ProxyCommand/.test(l)), calls.join(" | "));
    check("④ 대조: 정상 호스트는 한 번 불렸다", calls.length === 1 && /(^| )git@ok\.kr$/.test(calls[0]), calls.join(" | ") || "호출 0건");
    check("④ 항목은 정상 호스트 하나뿐", d.git.length === 1 && /✓ git 접속 ok\.kr/.test(d.git[0]), d.git.join("\n") || d.out);
  }

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
} finally {
  srv.close();
  rmSync(BOX, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
