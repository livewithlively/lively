#!/usr/bin/env node
// 로컬 레포 도구가 **라이블리에 등록한 내 HTTPS 토큰**으로 사설 레포를 받는지 — 실제 git · 실제 HTTP 인증으로 검증.
//  실행: node kit/cli/repo-worktree-git-credential.test.mjs   (npm test 체인에 포함)
//  네트워크는 127.0.0.1 뿐 · ~/.lively 무접촉 — tmp 에 원격을 만들고, 기본 인증(401)을 거는 작은 HTTP 서버로 내보낸다.
//
//  사양(«입력 조합 × 기대» — 행마다 시험 하나):
//   A  https 사설 레포 · 등록한 토큰 있음 · 이 컴퓨터 git 자격 없음        → 받는다. 원격이 본 자격 = 받아 온 사용자·토큰
//   B  등록한 토큰 없음 · 이 컴퓨터 git 자격 없음                          → 멈추지 않고 실패. 안내 = HTTPS 토큰 등록(호스트 포함)
//   C  받아 온 토큰이 거절됨 · 이 컴퓨터 git 자격 없음                     → 실패. 안내 = 등록한 토큰이 거절됨
//   D  받아 온 토큰이 거절됨 · 이 컴퓨터의 자격 도우미가 맞는 자격을 가짐   → 받는다(이 컴퓨터의 git 자격으로 한 번 더)
//   E  이 컴퓨터의 자격 도우미에 틀린 자격 · 받아 온 토큰은 맞음           → 받는다. 도우미는 불리지 않고 토큰을 저장받지도 않는다
//   F  받아 둔 base · 원격에 새 커밋 · 등록한 토큰 있음 → 핀               → 새 SHA. fetch_warning 없음
//   G  받아 둔 base · 원격에 새 커밋 · 등록한 토큰 없음 → 핀               → 던지지 않는다. 옛 SHA + fetch_warning(고치는 길 포함)
//   H  받아 둔 base 의 원격 자리(scheme://host[:port]) ≠ 등록 주소의 자리   → 토큰을 그 자리로 보내지 않는다
//      (호스트가 다름 · 같은 호스트의 다른 scheme · 다른 포트 · 응답에 자리가 없음)
//   X  토큰을 git 에 건네는 것 자체가 실패                                 → 이 컴퓨터 git 자격으로 한 번 더. 안내는 «토큰 거절» 이 아니다
//   Y  환경변수 설정을 모르는 옛 git(< 2.31 · 경계 2.31.0)                  → «토큰이 거절됐다» 고 말하지 않는다
//   I  이 길이 없는 옛 게이트웨이(404) · 게이트웨이 무응답                  → 이 컴퓨터 git 자격으로 시도. 안내가 사유를 말한다
//   J  ssh · file 주소                                                    → 토큰을 묻지 않는다(게이트웨이 호출 0)
//   K  받아 온 토큰은 git 인자에도 파일에도 남지 않는다
//   L  원격에 닿는 git 은 모두 묻지 않게 돈다(GIT_TERMINAL_PROMPT=0 + «터미널 없이» 표식) · 로컬 조작 git 에는 표식이 없다
//   M  이미 GIT_CONFIG_COUNT 가 있는 환경 → 그 뒤에 잇는다
//   N  주소 → 자격을 걸 자리: 포트 보존 · 호스트 소문자 · 박힌 자격 제외 · http(s) 가 아니면 없음
//   O  새 워크트리도 fetch 실패를 fetch_warning 으로 알린다
//   P  게이트웨이 응답이 비었거나 깨짐(null · 토큰 빈 문자열 · kind 가 https 아님) → 죽지 않는다. 토큰 없이 이 컴퓨터 자격으로
//   Q  받아 둔 base 에 origin 이 없다 → 토큰을 묻지 않는다. 던지지 않는다
//   R  GIT_CONFIG_COUNT 가 0 · 음수 · 숫자가 아님 → 0 부터 센다
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, realpathSync, rmSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";  // ⚠ 절대경로 동적 import 는 반드시 file:// URL 로(#1510)
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.error(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const SB = realpathSync(mkdtempSync(join(tmpdir(), "wt-gitcred-test-")));
const fwd = (p) => String(p).replace(/\\/g, "/");   // 윈도우: git 설정 · sh 에 넣는 경로는 슬래시로
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "wt-gitcred-test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "wt-gitcred-test@test.local";
process.env.CODEX_THREAD_ID = process.env.CODEX_SESSION_ID = process.env.CLAUDE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID = "";
process.env.LIVELY_SESSION_ID = "wt-gitcred-test-A";
// 이 컴퓨터의 git 설정(키체인 도우미 등)과 끊는다 — 시험이 고른 전역 설정 파일 하나만 본다.
const GLOBAL_CFG = join(SB, "gitconfig");
writeFileSync(GLOBAL_CFG, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
delete process.env.GIT_ASKPASS; delete process.env.SSH_ASKPASS; delete process.env.GIT_CONFIG_COUNT;
// 이 시험이 고치려는 고장이 «git 이 터미널에 묻고 멈춘다» 다 — 수정 전 코드로 돌려도 시험이 멈추지 않게 git 한 번에 상한을 둔다.
const GIT_TIMEOUT_MS = 60_000;

const TOKEN = "lvt_leased-TOKEN %1$s 한글";      // 특수문자 · 공백 · 비ASCII — 그대로 건너가야 한다
const calls = [];                                  // 코어가 띄운 명령 관측 — { args, env, noTty }
const sh = (cmd, args = [], { cwd = SB, allowFail = false, env, noTty } = {}) => {
  calls.push({ args: [cmd, ...args], env: env || null, noTty: noTty === true });
  try {
    return { stdout: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, ...(env ? { env: { ...process.env, ...env } } : {}) }), stderr: "", code: 0 };
  } catch (e) { if (!allowFail) throw e; return { stdout: String(e.stdout || ""), stderr: String(e.stderr || ""), code: e.status ?? 1 }; }
};
const raw = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// 기본 인증을 거는 정적 HTTP 서버(= git 의 «dumb» HTTP 원격). 별도 프로세스여야 한다 — 코어의 git 은 동기 실행이라
//  같은 프로세스의 서버는 그동안 응답하지 못한다. 받아들일 자격은 파일로 읽어 시험이 경우마다 바꾼다.
const SERVER_JS = `
const http = require("http"), fs = require("fs"), path = require("path");
const [root, logFile, allowFile] = process.argv.slice(2);
http.createServer((req, res) => {
  const auth = String(req.headers.authorization || "");
  fs.appendFileSync(logFile, JSON.stringify({ url: req.url, auth }) + "\\n");
  let allow = []; try { allow = JSON.parse(fs.readFileSync(allowFile, "utf8")); } catch {}
  const okAuth = allow.map((c) => "Basic " + Buffer.from(c).toString("base64"));
  if (!okAuth.includes(auth)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="lively-test"' }); res.end("auth required"); return; }
  const f = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(b); });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`;

(async () => {
  // ── 원격: bare 레포 하나를 HTTP 로 ──
  const work = join(SB, "src-work");
  raw(["init", "-q", "--initial-branch=main", work]);
  writeFileSync(join(work, "WHERE"), "v1\n");
  raw(["add", "-A"], work); raw(["commit", "-q", "-m", "v1"], work);
  const WWW = join(SB, "www");
  mkdirSync(WWW, { recursive: true });
  const bare = join(WWW, "origin.git");
  raw(["clone", "-q", "--bare", work, bare]);
  raw(["update-server-info"], bare);
  const publish = (text) => {                       // 원격에 새 커밋
    writeFileSync(join(work, "WHERE"), text + "\n");
    raw(["add", "-A"], work); raw(["commit", "-q", "-m", text], work);
    raw(["push", "-q", bare, "main"], work);
    raw(["update-server-info"], bare);
    return raw(["rev-parse", "refs/heads/main"], bare);
  };
  const tip = () => raw(["rev-parse", "refs/heads/main"], bare);

  const LOG = join(SB, "http.log"), ALLOW = join(SB, "allow.json");
  writeFileSync(LOG, ""); writeFileSync(join(SB, "server.cjs"), SERVER_JS);
  const allow = (...creds) => writeFileSync(ALLOW, JSON.stringify(creds));
  const server = spawn(process.execPath, [join(SB, "server.cjs"), WWW, LOG, ALLOW], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((res, rej) => {
    server.stdout.once("data", (d) => res(Number(String(d).trim())));
    server.once("exit", (c) => rej(new Error(`HTTP 서버가 죽었다(exit ${c})`)));
    setTimeout(() => rej(new Error("HTTP 서버가 포트를 알리지 않았다")), 15000);
  });
  const done = (code) => { try { server.kill(); } catch { /* */ } try { rmSync(SB, { recursive: true, force: true }); } catch { /* */ } process.exit(code); };
  process.on("uncaughtException", (e) => { console.error("테스트 하네스 오류:", e); done(1); });
  process.on("unhandledRejection", (e) => { console.error("테스트 하네스 오류:", e); done(1); });

  const URL_HTTP = `http://127.0.0.1:${port}/origin.git`;
  const seen = () => readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sentAuth = (since = 0) => seen().slice(since).map((r) => r.auth).filter(Boolean)
    .map((a) => Buffer.from(a.replace(/^Basic /, ""), "base64").toString("utf8"));

  const REPOS = join(SB, "repos");
  mkdirSync(REPOS, { recursive: true });
  process.env.LIVELY_REPOS_DIR = REPOS;
  process.env.TMPDIR = join(SB, "ostmp");                 // 핀 기본경로를 샌드박스 안으로
  mkdirSync(join(SB, "ostmp"), { recursive: true });
  const core = await import(pathToFileURL(join(HERE, "repo-worktree-core.mjs")));
  const { repoWorktree, repoPin } = core;
  //  수정 전 코드로 red 를 볼 때 없는 함수 — 부재는 아래 check 가 그대로 빨간불로 센다.
  const gitAuthEnv = core.gitAuthEnv || (() => ({}));
  const httpRemoteOf = core.httpRemoteOf || (() => undefined);

  // 게이트웨이 흉내 — 레포 목록 + 내 토큰 받기. lease 는 응답(무엇이든)이거나 던질 오류({ status }).
  //  origin = 등록 주소의 자리(scheme://host[:port]). 기본은 이 시험의 원격 그대로.
  const HERE_ORIGIN = `http://127.0.0.1:${port}`;
  const leased = (token = TOKEN, origin = HERE_ORIGIN) => ({ repo: "x", host: new URL(origin).hostname, origin, credential: { kind: "https", username: "lively-user", token }, reason: null });
  const none = (reason = "no-credential") => ({ repo: "x", host: "127.0.0.1", origin: HERE_ORIGIN, credential: null, reason });
  const mkCtx = (cwd, rows, lease) => {
    const c = {
      cwd, leaseCalls: [],
      sh: (cmd, a, o) => sh(cmd, a, { ...o, cwd: o?.cwd ?? cwd }),
      api: async (p, opts = {}) => {
        if (p === "/api/ui/repos") return { domainmapRepos: Object.entries(rows).map(([name, clone_url]) => ({ name, clone_url, default_branch: "main" })), repos: Object.keys(rows) };
        if (p === "/api/ui/me/git-credential/lease") {
          c.leaseCalls.push(opts);
          if (lease instanceof Error) throw lease;
          return lease;
        }
        throw new Error(`예상 밖 경로: ${p}`);
      },
    };
    return c;
  };
  const cwdOf = (n) => { const d = join(SB, "cwd", n); mkdirSync(d, { recursive: true }); return d; };
  const headOf = (p) => raw(["rev-parse", "HEAD"], p);
  const netCalls = (since) => calls.slice(since).filter((c) => c.args[0] === "git" && c.args.some((a) => a === "clone" || a === "fetch" || a === "ls-remote"));
  const attempt = async (fn) => { const t0 = Date.now(); try { return { out: await fn(), ms: Date.now() - t0 }; } catch (e) { return { err: String(e?.message ?? e), ms: Date.now() - t0 }; } };

  // 픽스처 배선 — 자격 없이는 정말 못 받아야 아래가 뜻을 가진다.
  {
    allow(`lively-user:${TOKEN}`);
    let denied = false;
    try { execFileSync("git", ["ls-remote", URL_HTTP], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: GIT_TIMEOUT_MS }); } catch { denied = true; }
    check("픽스처: 자격 없는 git 은 이 원격을 못 읽는다(401)", denied);
    check("픽스처: 원격이 요청을 기록한다(관측 장치 생존)", seen().length > 0);
  }

  // ── A 등록한 토큰으로 받는다 ──
  {
    allow(`lively-user:${TOKEN}`);
    const n0 = seen().length, c0 = calls.length;
    const c = mkCtx(cwdOf("a"), { a: URL_HTTP }, leased());
    const r = await attempt(() => repoWorktree(c, { repo: "a" }));
    check("A 사설 레포를 받는다(이 컴퓨터에 git 자격 없음)", !r.err && existsSync(join(r.out.worktree, "WHERE")), r.err);
    check("A 받은 코드가 원격 최신이다", !r.err && headOf(r.out.worktree) === tip(), r.err);
    check("A 원격이 본 자격 = 받아 온 사용자 · 토큰(특수문자 그대로)", sentAuth(n0).includes(`lively-user:${TOKEN}`), JSON.stringify(sentAuth(n0)));
    check("A 게이트웨이에 이 레포 이름으로 물었다(POST · 한 번)",
      c.leaseCalls.length === 1 && c.leaseCalls[0].method === "POST" && c.leaseCalls[0].body?.repo === "a", JSON.stringify(c.leaseCalls));
    check("A 새로 받았으면 fetch_warning 이 없다", !r.err && r.out.fetch_warning === undefined, r.out?.fetch_warning);
    // K — 토큰이 남는 자리
    const argv = calls.slice(c0).flatMap((x) => x.args).join("\n");
    check("K 받아 온 토큰이 git 인자에 실리지 않는다", calls.length > c0 && !argv.includes("lvt_leased"), "argv 에 토큰");
    const leaked = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "objects") walk(p); continue; }
      if (p === LOG || p === ALLOW || statSync(p).size > 2_000_000) continue;   // 원격의 기록 · 허용 목록은 시험 장치다
      if (readFileSync(p).includes(Buffer.from("lvt_leased"))) leaked.push(p);
    } };
    walk(SB);
    check("K 받아 온 토큰이 파일(레포 설정 · 임시 파일)에 남지 않는다", leaked.length === 0, leaked.join(", "));
    check("K 받아 둔 base 의 원격 주소에 자격이 박히지 않는다", existsSync(join(REPOS, "a")) && raw(["remote", "get-url", "origin"], join(REPOS, "a")) === URL_HTTP);
    // L — 묻지 않는다
    const net = netCalls(c0);
    check("L 원격에 닿는 git 은 창으로도 묻지 않는다(GCM_INTERACTIVE=never)", net.length > 0 && net.every((x) => x.env && x.env.GCM_INTERACTIVE === "never"), "env 누락");
    check("L 원격에 닿는 git 은 묻지 않게 돈다(GIT_TERMINAL_PROMPT=0)", net.length > 0 && net.every((x) => x.env && x.env.GIT_TERMINAL_PROMPT === "0"),
      JSON.stringify(net.map((x) => [x.args.slice(0, 4), x.env && x.env.GIT_TERMINAL_PROMPT])));
    //  ssh 의 물음(호스트키 지문 · 키 암호)은 GIT_TERMINAL_PROMPT 가 못 끈다 — 물을 수 없는 표면이 터미널 없이 띄우도록 표식을 싣는다.
    check("L 원격에 닿는 git 에는 «터미널 없이» 표식이 실린다", net.length > 0 && net.every((x) => x.noTty === true), JSON.stringify(net.map((x) => [x.args.slice(0, 3), x.noTty])));
    const local = calls.slice(c0).filter((x) => x.args[0] === "git" && !net.includes(x));
    check("L 원격에 닿지 않는 git 에는 그 표식이 없다(로컬 조작은 종전대로)", local.length > 0 && local.every((x) => x.noTty === false), JSON.stringify(local.filter((x) => x.noTty).map((x) => x.args.slice(0, 4))));
  }

  // ── B 등록한 토큰도 이 컴퓨터 자격도 없다 → 멈추지 않고 실패 + 등록 안내 ──
  {
    allow(`lively-user:${TOKEN}`);
    const c0 = calls.length;
    const c = mkCtx(cwdOf("b"), { b: URL_HTTP }, none());
    const r = await attempt(() => repoWorktree(c, { repo: "b" }));
    check("B 실패한다(받을 자격이 없다)", Boolean(r.err), "던지지 않음");
    check("B 멈추지 않는다(상한 훨씬 안쪽에서 끝난다)", r.ms < GIT_TIMEOUT_MS / 2, `${r.ms}ms`);
    check("B 안내: HTTPS 토큰 등록 + 호스트", /me_git_credential_set \{kind:"https", host:"127\.0\.0\.1"/.test(r.err || ""), r.err);
    check("B 안내: SSH 키 생성을 권하지 않는다(https 주소다)", Boolean(r.err) && !/ssh-keygen/.test(r.err), r.err);
    const net = netCalls(c0);
    check("L B 의 git 도 묻지 않게 돈다", net.length > 0 && net.every((x) => x.env && x.env.GIT_TERMINAL_PROMPT === "0"), "env 누락");
    check("B 받다 만 폴더를 남기지 않는다", !existsSync(join(REPOS, "b", ".git")));
  }

  // ── C 받아 온 토큰이 거절됐다 ──
  {
    allow("someone:else");
    const n0 = seen().length;
    const c = mkCtx(cwdOf("c"), { c: URL_HTTP }, leased("lvt_leased-EXPIRED"));
    const r = await attempt(() => repoWorktree(c, { repo: "c" }));
    check("C 실패한다", Boolean(r.err), "던지지 않음");
    check("C 받아 온 토큰으로 실제로 시도했다(배선)", sentAuth(n0).includes("lively-user:lvt_leased-EXPIRED"), JSON.stringify(sentAuth(n0)));
    check("C 안내: 등록한 토큰이 거절됐다 → 다시 등록", /토큰으로 인증하지 못했습니다/.test(r.err || "") && /me_git_credential_set \{kind:"https"/.test(r.err || ""), r.err);
    check("C 오류 문구에 토큰이 실리지 않는다", Boolean(r.err) && !r.err.includes("lvt_leased"), r.err);
  }

  // ── D 받아 온 토큰은 거절 · 이 컴퓨터의 자격 도우미가 맞는 자격을 가짐 → 받는다 ──
  // ── E 이 컴퓨터의 자격 도우미에 틀린 자격 · 받아 온 토큰은 맞음 → 받는다 · 도우미는 안 불린다 ──
  {
    const HELPER_LOG = fwd(join(SB, "helper.log"));
    //  도우미 = 이 컴퓨터에 깔린 자격(키체인 흉내). 불릴 때마다 동작(get · store · erase)과 받은 내용을 적는다.
    writeFileSync(GLOBAL_CFG, `[credential]\n\thelper = "!f() { echo \\"op=$1\\" >> '${HELPER_LOG}'; cat >> '${HELPER_LOG}'; test \\"$1\\" = get && printf 'username=ambient\\\\npassword=ambient-pass\\\\n'; }; f"\n`);
    const helperLog = () => { try { return readFileSync(HELPER_LOG, "utf8"); } catch { return ""; } };

    allow("ambient:ambient-pass");
    const cD = mkCtx(cwdOf("d"), { d: URL_HTTP }, leased("lvt_leased-EXPIRED"));
    const n0 = seen().length;
    const rD = await attempt(() => repoWorktree(cD, { repo: "d" }));
    check("D 받아 온 토큰이 거절돼도 이 컴퓨터의 git 자격으로 받는다", !rD.err && headOf(rD.out.worktree) === tip(), rD.err);
    check("D 먼저 받아 온 토큰으로 시도했다(순서)", sentAuth(n0)[0] === "lively-user:lvt_leased-EXPIRED", JSON.stringify(sentAuth(n0).slice(0, 2)));
    check("D 픽스처: 이 컴퓨터의 도우미가 실제로 불렸다(관측 장치 생존)", /op=get/.test(helperLog()), helperLog().slice(0, 120));

    writeFileSync(HELPER_LOG, "");
    allow(`lively-user:${TOKEN}`);                    // 이제 도우미의 자격(ambient)은 틀린 자격이다
    const cE = mkCtx(cwdOf("e"), { e: URL_HTTP }, leased());
    const n1 = seen().length;
    const rE = await attempt(() => repoWorktree(cE, { repo: "e" }));
    check("E 이 컴퓨터에 틀린 자격이 깔려 있어도 받아 온 토큰으로 받는다", !rE.err && headOf(rE.out.worktree) === tip(), rE.err);
    check("E 틀린 자격이 원격으로 나가지 않는다", sentAuth(n1).length > 0 && !sentAuth(n1).includes("ambient:ambient-pass"), JSON.stringify(sentAuth(n1)));
    check("E 이 컴퓨터의 도우미는 불리지 않고 토큰을 저장받지도 않는다", !rE.err && helperLog() === "", helperLog().slice(0, 200));
    writeFileSync(GLOBAL_CFG, "");
  }

  // ── F · G · O 받아 둔 base 의 fetch ──
  {
    allow(`lively-user:${TOKEN}`);
    const hasA = existsSync(join(REPOS, "a", ".git"));
    check("픽스처: A 에서 받아 둔 base 가 있다", hasA);
    if (hasA) {
      const cF = mkCtx(cwdOf("f"), { a: URL_HTTP }, leased());
      const before = headOf(join(REPOS, "a"));
      const fresh = publish("v2");
      check("픽스처: 원격이 앞으로 갔다", fresh !== before);
      const pF = await attempt(() => repoPin(cF, { repo: "a" }));
      check("F 받아 둔 base: 등록한 토큰으로 새 커밋을 받아 핀한다", !pF.err && headOf(pF.out.pin) === fresh, pF.err || `${pF.out?.sha}`);
      check("F fetch 가 됐으면 fetch_warning 이 없다", !pF.err && pF.out.fetch_warning === undefined, pF.out?.fetch_warning);

      const newer = publish("v3");
      const cG = mkCtx(cwdOf("g"), { a: URL_HTTP }, none());
      const pG = await attempt(() => repoPin(cG, { repo: "a" }));
      check("G 토큰이 없어 fetch 가 실패해도 던지지 않는다(받아 둔 코드로 일한다)", !pG.err, pG.err);
      check("G 핀은 받아 둔 origin 의 SHA 다(최신이 아니다)", !pG.err && headOf(pG.out.pin) === fresh && fresh !== newer, `${pG.out?.sha}`);
      check("G fetch_warning 이 «최신이 아닐 수 있다» 를 알린다", typeof pG.out?.fetch_warning === "string" && pG.out.fetch_warning.length > 0, String(pG.out?.fetch_warning));
      check("G fetch_warning 에 고치는 길(HTTPS 토큰 등록)이 실린다", /me_git_credential_set \{kind:"https"/.test(pG.out?.fetch_warning || ""), String(pG.out?.fetch_warning));

      const wO = await attempt(() => repoWorktree(mkCtx(cwdOf("o"), { a: URL_HTTP }, none()), { repo: "a" }));
      check("O 새 워크트리: fetch 실패를 fetch_warning 으로 알린다", !wO.err && typeof wO.out.fetch_warning === "string" && wO.out.fetch_warning.length > 0, wO.err || String(wO.out?.fetch_warning));

      // ── H 받아 둔 base 의 원격 자리가 등록 주소의 자리와 다르다 → 토큰을 보내지 않는다 ──
      //   호스트가 다른 것만이 아니다 — 호스트 이름이 같아도 scheme(https 로 등록 · 원격은 평문 http)이나 포트가 다르면 다른 자리다.
      publish("v4");
      const elsewhere = [
        ["호스트가 다르다", `http://git.registered.example:${port}`],
        ["같은 호스트 · https 로 등록했는데 원격은 평문 http", `https://127.0.0.1:${port}`],
        ["같은 호스트 · 포트가 다르다", `http://127.0.0.1:${port + 1}`],
        ["같은 호스트 · 포트 없이 등록", "http://127.0.0.1"],
      ];
      for (const [name, origin] of elsewhere) {
        const n0 = seen().length;
        const cH = mkCtx(cwdOf("h"), { a: URL_HTTP }, leased(TOKEN, origin));
        const pH = await attempt(() => repoPin(cH, { repo: "a" }));
        check(`H ${name}: 던지지 않는다 · 원격에는 닿았다(배선)`, !pH.err && seen().length > n0 && cH.leaseCalls.length === 1, pH.err || "요청 0건");
        check(`H ${name}: 토큰이 그 자리로 나가지 않는다`, !sentAuth(n0).some((a) => a.includes("lvt_leased")), JSON.stringify(sentAuth(n0)));
        check(`H ${name}: 못 받았다고 알린다`, typeof pH.out?.fetch_warning === "string", String(pH.out?.fetch_warning));
      }
      {
        //  자리를 안 실어 준 응답(origin 없음 · 문자열이 아님)도 «다른 자리» 다 — 대조할 수 없으면 보내지 않는다.
        for (const [name, patch] of [["origin 칸이 없다", { origin: undefined }], ["origin 이 문자열이 아니다", { origin: 12345 }], ["origin 이 빈 문자열", { origin: "" }]]) {
          const n0 = seen().length;
          const pH = await attempt(() => repoPin(mkCtx(cwdOf("h"), { a: URL_HTTP }, { ...leased(), ...patch }), { repo: "a" }));
          check(`H 응답에 ${name}: 토큰을 보내지 않는다`, !pH.err && seen().length > n0 && !sentAuth(n0).some((a) => a.includes("lvt_leased")), pH.err || JSON.stringify(sentAuth(n0)));
        }
      }
      {
        //  대조: 자리가 글자 그대로 같으면 받는다(위 거절들이 «늘 거절» 이 아님을 본다).
        const n0 = seen().length;
        const pOk = await attempt(() => repoPin(mkCtx(cwdOf("h"), { a: URL_HTTP }, leased()), { repo: "a" }));
        check("H 대조: 자리가 같으면 토큰으로 받는다", !pOk.err && pOk.out.fetch_warning === undefined && sentAuth(n0).includes(`lively-user:${TOKEN}`), pOk.err || String(pOk.out?.fetch_warning));
      }

      // ── Q 받아 둔 base 에 origin 이 없다 ──
      raw(["clone", "-q", pathToFileURL(bare).href, join(REPOS, "q")]);
      raw(["remote", "remove", "origin"], join(REPOS, "q"));
      const cQ = mkCtx(cwdOf("q"), { q: URL_HTTP }, leased());
      const rQ = await attempt(() => repoWorktree(cQ, { repo: "q", branch: "wt/q-test" }));
      check("Q origin 없는 base: 던지지 않는다 · 토큰을 묻지 않는다", !rQ.err && cQ.leaseCalls.length === 0, rQ.err || `lease ${cQ.leaseCalls.length}`);
    }
  }

  // ── X 토큰을 git 에 건네는 것 자체가 실패(건넨 설정을 git 이 못 읽음) → 이 컴퓨터 git 자격으로 한 번 더 · 안내는 «토큰 거절» 이 아니다 ──
  // ── Y 환경변수 설정을 모르는 옛 git(< 2.31) → «토큰이 거절됐다» 고 말하지 않는다 ──
  {
    //  받아 온 자격이 실린 호출(LIVELY_GIT_PASS 가 env 에 있다)만 가로채 실패시킨다 — 그 밖은 진짜 git.
    const withLeasedFailing = (c, stderr, version) => {
      const real = c.sh; let leasedCalls = 0, ambientNet = 0;
      c.sh = (cmd, a, o) => {
        if (version && a[0] === "version") return { stdout: `git version ${version}\n`, stderr: "", code: 0 };
        const net = a.some((x) => x === "clone" || x === "fetch" || x === "ls-remote");
        if (net && o?.env?.LIVELY_GIT_PASS) { leasedCalls++; return { stdout: "", stderr, code: 128 }; }
        if (net) ambientNet++;
        return real(cmd, a, o);
      };
      return { leased: () => leasedCalls, ambient: () => ambientNet };
    };
    writeFileSync(GLOBAL_CFG, `[credential]\n\thelper = "!f() { test \\"$1\\" = get && printf 'username=ambient\\\\npassword=ambient-pass\\\\n'; }; f"\n`);
    allow("ambient:ambient-pass");
    const cX = mkCtx(cwdOf("x1"), { x1: URL_HTTP }, leased());
    const seenX = withLeasedFailing(cX, "error: missing config value GIT_CONFIG_VALUE_0\nfatal: unable to parse command-line config");
    const rX = await attempt(() => repoWorktree(cX, { repo: "x1" }));
    check("X 건네기 실패: 이 컴퓨터의 git 자격으로 한 번 더 해서 받는다", !rX.err && seenX.leased() >= 1 && seenX.ambient() >= 1 && headOf(rX.out.worktree) === tip(), rX.err || `leased=${seenX.leased()} ambient=${seenX.ambient()}`);
    writeFileSync(GLOBAL_CFG, "");
    allow(`lively-user:${TOKEN}`);
    const cX2 = mkCtx(cwdOf("x2"), { x2: URL_HTTP }, leased());
    withLeasedFailing(cX2, "error: missing config value GIT_CONFIG_VALUE_0\nfatal: unable to parse command-line config");
    const rX2 = await attempt(() => repoWorktree(cX2, { repo: "x2" }));
    check("X 건네기 실패 + 이 컴퓨터 자격도 없음: 안내가 «토큰이 거절됐다» 고 하지 않는다", Boolean(rX2.err) && !/토큰으로 인증하지 못했습니다/.test(rX2.err) && /건네지 못했습니다/.test(rX2.err), rX2.err);
    const cX3 = mkCtx(cwdOf("x3"), { x3: URL_HTTP }, leased());
    const seenX3 = withLeasedFailing(cX3, "fatal: unable to access 'http://127.0.0.1/': Could not resolve host: nope");
    const rX3 = await attempt(() => repoWorktree(cX3, { repo: "x3" }));
    check("X 자격과 무관한 실패(네트워크)는 다시 하지 않는다", Boolean(rX3.err) && seenX3.leased() >= 1 && seenX3.ambient() === 0, `leased=${seenX3.leased()} ambient=${seenX3.ambient()}`);

    const AUTH_ERR = "fatal: could not read Username for 'http://127.0.0.1': terminal prompts disabled";
    const cY = mkCtx(cwdOf("y1"), { y1: URL_HTTP }, leased());
    withLeasedFailing(cY, AUTH_ERR, "2.30.2");
    const rY = await attempt(() => repoWorktree(cY, { repo: "y1" }));
    check("Y 옛 git(2.30): «토큰이 거절됐다» 고 하지 않고 git 업데이트를 말한다", Boolean(rY.err) && !/토큰으로 인증하지 못했습니다/.test(rY.err) && /2\.31/.test(rY.err), rY.err);
    const cY2 = mkCtx(cwdOf("y2"), { y2: URL_HTTP }, leased());
    withLeasedFailing(cY2, AUTH_ERR, "2.31.0");
    const rY2 = await attempt(() => repoWorktree(cY2, { repo: "y2" }));
    check("Y 경계: git 2.31.0 은 옛 판이 아니다(토큰 거절로 안내한다)", /토큰으로 인증하지 못했습니다/.test(rY2.err || ""), rY2.err);
    const cY3 = mkCtx(cwdOf("y3"), { y3: URL_HTTP }, leased());
    withLeasedFailing(cY3, AUTH_ERR, "1.9.5");
    const rY3 = await attempt(() => repoWorktree(cY3, { repo: "y3" }));
    check("Y 경계: git 1.x 도 옛 판이다", Boolean(rY3.err) && /2\.31/.test(rY3.err), rY3.err);
  }

  // ── I 옛 게이트웨이(이 길이 없다 — 404) · 게이트웨이 무응답 ──
  {
    allow(`lively-user:${TOKEN}`);
    const n0 = seen().length;
    const cI = mkCtx(cwdOf("i"), { i: URL_HTTP }, Object.assign(new Error("게이트웨이 404"), { status: 404 }));
    const r = await attempt(() => repoWorktree(cI, { repo: "i" }));
    check("I 이 컴퓨터 git 자격으로 시도하고 실패한다(자격 없음)", Boolean(r.err) && seen().length > n0 && cI.leaseCalls.length === 1, r.err || "던지지 않음");
    check("I 안내가 게이트웨이가 옛 판임을 말한다", /옛 판/.test(r.err || ""), r.err);
    const cI2 = mkCtx(cwdOf("i2"), { i2: URL_HTTP }, Object.assign(new Error("gateway down"), { status: 502 }));
    const r2 = await attempt(() => repoWorktree(cI2, { repo: "i2" }));
    check("I 게이트웨이가 답하지 않으면 git 실패로 끝나고 안내가 그 사유를 싣는다", /git clone 실패/.test(r2.err || "") && /gateway down/.test(r2.err || ""), r2.err);
  }

  // ── J ssh · file 주소는 토큰을 묻지 않는다 ──
  {
    const cJ = mkCtx(cwdOf("j"), { j: pathToFileURL(bare).href }, leased());
    const r = await attempt(() => repoWorktree(cJ, { repo: "j" }));
    check("J file 주소: 받는다 · 게이트웨이에 토큰을 묻지 않는다", !r.err && cJ.leaseCalls.length === 0, r.err || `lease ${cJ.leaseCalls.length}`);
    const cJ2 = mkCtx(cwdOf("j2"), { j2: "git@127.0.0.1:nope/nope.git" }, leased());
    let cloneTried = 0;
    cJ2.sh = (cmd, a, o) => (a[0] === "clone" ? (cloneTried++, { stdout: "", stderr: "git@127.0.0.1: Permission denied (publickey).", code: 128 }) : sh(cmd, a, { ...o, cwd: o?.cwd ?? cJ2.cwd }));
    const r2 = await attempt(() => repoWorktree(cJ2, { repo: "j2" }));
    check("J ssh 주소: 게이트웨이에 토큰을 묻지 않는다", Boolean(r2.err) && cloneTried > 0 && cJ2.leaseCalls.length === 0, `lease ${cJ2.leaseCalls.length}`);
    check("J ssh 주소의 안내는 HTTPS 토큰이 아니라 ssh 키다", Boolean(r2.err) && !/kind:"https"/.test(r2.err), r2.err);
  }

  // ── P 게이트웨이 응답이 비었거나 깨졌다 → 죽지 않는다 · 토큰 없이 이 컴퓨터 자격으로 ──
  {
    writeFileSync(GLOBAL_CFG, `[credential]\n\thelper = "!f() { test \\"$1\\" = get && printf 'username=ambient\\\\npassword=ambient-pass\\\\n'; }; f"\n`);
    allow("ambient:ambient-pass");
    const broken = [
      ["null", null],
      ["빈 객체", {}],
      ["토큰이 빈 문자열", { host: "127.0.0.1", origin: HERE_ORIGIN, credential: { kind: "https", username: "u", token: "" }, reason: null }],
      ["토큰이 문자열이 아님", { host: "127.0.0.1", origin: HERE_ORIGIN, credential: { kind: "https", username: "u", token: 12345 }, reason: null }],
      ["kind 가 https 가 아님", { host: "127.0.0.1", origin: HERE_ORIGIN, credential: { kind: "ssh", username: "u", token: "lvt_leased-SSH" }, reason: null }],
    ];
    let i = 0;
    for (const [name, resp] of broken) {
      const repo = `p${i++}`;
      const n0 = seen().length;
      const r = await attempt(() => repoWorktree(mkCtx(cwdOf(repo), { [repo]: URL_HTTP }, resp), { repo }));
      check(`P 응답이 ${name}: 죽지 않고 이 컴퓨터 git 자격으로 받는다`, !r.err && headOf(r.out.worktree) === tip(), r.err);
      check(`P 응답이 ${name}: 깨진 응답의 값이 원격으로 나가지 않는다`, sentAuth(n0).every((a) => a === "ambient:ambient-pass"), JSON.stringify(sentAuth(n0)));
    }
    writeFileSync(GLOBAL_CFG, "");
  }

  // ── M · N · R 순수 함수 ──
  {
    const remote = httpRemoteOf("https://Git.Example.com:8443/o/r.git");
    check("N 포트를 지키고 호스트는 소문자", Boolean(remote) && remote.origin === "https://git.example.com:8443" && remote.host === "git.example.com", JSON.stringify(remote));
    check("N 주소에 박힌 자격은 자리에 넣지 않는다", httpRemoteOf("https://user:pw@git.example.com/o/r.git")?.origin === "https://git.example.com");
    check("N http(s) 가 아니면 없음", httpRemoteOf("git@github.com:o/r.git") === null && httpRemoteOf("ssh://git@h.kr/o/r.git") === null
      && httpRemoteOf("file:///x/y.git") === null && httpRemoteOf("") === null && httpRemoteOf(undefined) === null);
    const at = remote || { origin: "https://git.example.com:8443", host: "git.example.com" };
    const e0 = gitAuthEnv(at, { username: "u", token: "tok-M" }, {});
    const cfg = (e) => Array.from({ length: Number(e.GIT_CONFIG_COUNT) || 0 }, (_, k) => [e[`GIT_CONFIG_KEY_${k}`], e[`GIT_CONFIG_VALUE_${k}`]]);
    check("M 이 컴퓨터의 도우미를 비운 뒤(빈 값) 그 원격에만 건다 — 이 순서",
      cfg(e0).length === 2 && cfg(e0)[0][0] === "credential.helper" && cfg(e0)[0][1] === ""
      && cfg(e0)[1][0] === "credential.https://git.example.com:8443.helper" && e0.GIT_TERMINAL_PROMPT === "0", JSON.stringify(e0));
    check("M git 설정 값에 토큰이 실리지 않는다(환경변수로만 건넨다)", cfg(e0).length > 0 && !cfg(e0).some(([k, v]) => String(k).includes("tok-M") || String(v).includes("tok-M")), JSON.stringify(cfg(e0)));
    const e3 = gitAuthEnv(at, { username: "", token: "t" }, { GIT_CONFIG_COUNT: "3" });
    check("M 이미 있는 GIT_CONFIG_COUNT 뒤에 잇는다(앞의 셋을 덮지 않는다)",
      e3.GIT_CONFIG_COUNT === "5" && e3.GIT_CONFIG_KEY_3 === "credential.helper" && String(e3.GIT_CONFIG_KEY_4).startsWith("credential.https://")
      && e3.GIT_CONFIG_KEY_0 === undefined && e3.GIT_CONFIG_KEY_2 === undefined, JSON.stringify(e3));
    for (const v of ["0", "-2", "abc", "", undefined]) {
      const e = gitAuthEnv(at, { username: "u", token: "t" }, v === undefined ? {} : { GIT_CONFIG_COUNT: v });
      check(`R GIT_CONFIG_COUNT=${JSON.stringify(v)} 이면 0 부터 센다`, e.GIT_CONFIG_COUNT === "2" && e.GIT_CONFIG_KEY_0 === "credential.helper", JSON.stringify(e));
    }
  }

  // ── V CLI 배선 — `lively repo pin` 이 같은 길로 받는다(코어에 넘기는 api · sh 가 POST 몸통과 env 를 떨어뜨리지 않는다) ──
  {
    allow(`lively-user:${TOKEN}`);
    const { createServer } = await import("node:http");
    const gwSeen = [];
    const gw = createServer((req, res) => {
      let body = ""; req.on("data", (d) => { body += d; });
      req.on("end", () => {
        gwSeen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
        const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
        if (req.url === "/api/ui/repos") return json({ domainmapRepos: [{ name: "cliv", clone_url: URL_HTTP, default_branch: "main" }], repos: ["cliv"] });
        if (req.url === "/api/ui/me/git-credential/lease" && req.method === "POST") return json(leased());
        res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
      });
    });
    await new Promise((r) => gw.listen(0, "127.0.0.1", r));
    const home = join(SB, "cli-home");
    mkdirSync(join(home, ".lively"), { recursive: true });
    writeFileSync(join(home, ".lively", "gateway-url"), `http://127.0.0.1:${gw.address().port}\n`);
    writeFileSync(join(home, ".lively", "token"), "lvk_cli-test\n");
    const n0 = seen().length;
    //  CLI 는 별도 프로세스다 — 실 홈 · 실 신원과 끊고(sandboxEnv), git 과 127.0.0.1 만 여는 샌드박스 모드로 돌린다.
    //   TMPDIR 은 물려준다(핀 기본 경로 · 샌드박스가 허용하는 자리). 신원은 이 홈의 파일(~/.lively/token)에서만 읽는다.
    //   레포 자리도 그 홈 아래로 준다 — 샌드박스는 홈 · 임시 폴더 아래의 git 만 연다.
    const cliRepos = join(home, "repos");
    const env = { ...process.env, ...sandboxEnv({ home }), LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", LIVELY_HOME: home, LIVELY_REPOS_DIR: cliRepos, NO_COLOR: "1" };
    delete env.LIVELY_MCP_TOKEN;
    const cli = await new Promise((res) => {
      const p = spawn(process.execPath, [join(HERE, "lively.mjs"), "repo", "pin", "cliv"], { env, cwd: cwdOf("v"), stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
      const t = setTimeout(() => p.kill(), 120_000);
      p.on("exit", (code) => { clearTimeout(t); res({ code, out }); });
    });
    await new Promise((r) => gw.close(r));
    const lease = gwSeen.find((g) => g.url === "/api/ui/me/git-credential/lease");
    check("V CLI: 게이트웨이에 POST 로 레포 이름을 실어 물었다", Boolean(lease) && lease.method === "POST" && lease.body === JSON.stringify({ repo: "cliv" }), JSON.stringify(gwSeen.map((g) => [g.method, g.url, g.body])));
    check("V CLI: 받아 온 토큰이 원격까지 건너갔다", sentAuth(n0).includes(`lively-user:${TOKEN}`), JSON.stringify(sentAuth(n0)));
    check("V CLI: 핀이 떴다(exit 0)", cli.code === 0 && existsSync(join(cliRepos, "cliv", ".git")), `exit=${cli.code} ${cli.out.slice(-300)}`);
    check("V CLI: 출력에 토큰이 실리지 않는다", !cli.out.includes("lvt_leased"), cli.out.slice(-200));
  }

  // ── U 실패 안내 — 까닭마다 다른 길(안내가 곧 이 고침의 산출물이다) ──
  {
    const authNote = core.authNote;
    const ERR = "fatal: could not read Username for 'https://git.x.kr': terminal prompts disabled";
    const URL_X = "https://git.x.kr/o/r.git";
    const by = (state, why) => authNote(ERR, URL_X, "pc", state ? { state, why } : null);
    check("U «묻지 않게 돌아 멈춘» 실패도 자격 문제로 본다", authNote("fatal: could not read Password for 'https://u@git.x.kr': terminal prompts disabled", URL_X, "pc") !== ""
      && authNote("fatal: unable to access 'https://git.x.kr/o/r.git/': The requested URL returned error: 403", URL_X, "pc") !== "");
    check("U 등록한 자격이 SSH 키: HTTPS 토큰 등록을 권하고, SSH 키가 바뀐다고 미리 말한다",
      /kind:"https", host:"git\.x\.kr"/.test(by("ssh-credential")) && /SSH 키는 토큰으로 바뀝니다/.test(by("ssh-credential")), by("ssh-credential"));
    check("U 원격 호스트가 등록 주소와 다름: 토큰 등록을 권하지 않는다(등록해도 안 쓴다)", by("host-mismatch") !== "" && !/me_git_credential_set/.test(by("host-mismatch")), by("host-mismatch"));
    check("U 옛 게이트웨이: 토큰 등록을 권하지 않는다(등록해도 안 내려온다)", by("unsupported") !== "" && !/me_git_credential_set/.test(by("unsupported")), by("unsupported"));
    check("U 받아 오지 못함: 사유를 싣는다", by("unavailable", "게이트웨이 502").includes("게이트웨이 502"), by("unavailable", "게이트웨이 502"));
    check("U 까닭마다 안내가 다르다", new Set(["used-failed", "ssh-credential", "unsupported", "unavailable", "host-mismatch", "no-credential"].map((s) => by(s))).size === 6);
    check("U 물어보지 않은 호출(옛 호출부)도 안내가 나온다", /kind:"https"/.test(by(null)), by(null));
    check("U 자격과 무관한 실패엔 안 붙는다(까닭이 있어도)", authNote("fatal: destination path 'x' already exists", URL_X, "pc", { state: "no-credential" }) === "");
    const evil = authNote(ERR.replace("git.x.kr", "$(id)"), "https://$(id)/o/r.git", "pc", { state: "no-credential" });
    check("U 주소의 호스트가 이름 글자가 아니면 복붙 명령에 넣지 않는다", evil !== "" && !evil.includes("$(id)"), evil);
  }

  console.error(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error("테스트 하네스 오류:", e); try { rmSync(SB, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
