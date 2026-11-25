// 로컬 도구용 git 자격 리스 — **전 구간 끝단**(실 게이트웨이 프로세스 + 실 Postgres + 실 git · 실 HTTP 인증).
//  ②계층(itest): 스크래치 DB 로만 돌린다(운영 DB 금지 — 이름에 test 가 없으면 거절한다).
//   ⚠ 새로 만든 DB 의 첫 실행은 실패할 수 있다(게이트웨이 첫 부팅의 스키마 · 워크스페이스 등록부 준비가 도중에 끝난다 — 이 시험과 무관).
//     그때는 «게이트웨이가 부팅 직후 내려갔다» 로 멈춘다. 같은 DB 로 한 번 더 돌린다.
//    npm run build && CONNECTOR_SECRET_KEY=$(openssl rand -hex 32) \
//      ITEMS_DATABASE_URL=postgres://postgres:test@127.0.0.1:<port>/lively_test node scripts/git-credential-lease.itest.mjs
//
//  이 계층이 아니면 못 잡는 것: 인증 미들웨어 · scope 게이트 · 게이트웨이 부팅 때 꽂히는 자격 관문(leaseGitSecretForNode) · 봉투 암호화 왕복 ·
//   호출 기록 · 로컬 CLI 가 받은 토큰으로 실제 사설 레포를 받는 것. 단위 시험(git-credential-lease.test · repo-worktree-git-credential.test)은
//   그 사이의 배선을 보지 못한다.
//
//  사양:
//   ① 본인이 등록한 HTTPS 토큰은 그 사람의 접속 열쇠로 받는다
//   ② ★ 등록한 자격이 없는 구성원은 아무것도 못 받는다 — 조직(게이트웨이) 자격이 있어도 그 값은 나가지 않는다
//   ③ 거절: 인증 없음(401) · 웹 로그인 세션(403) · OAuth 클라이언트 토큰(403) · context 권한 없는 토큰(403) · GET(없는 길)
//   ④ 까닭 구분: 미등록 레포 · https 가 아닌 주소
//   ⑤ 호출 기록에 토큰이 남지 않는다
//   ⑥ 로컬 CLI(`lively repo pin`)가 이 컴퓨터에 git 자격 없이 사설 레포를 받는다 — 원격이 본 자격 = 본인 토큰
//   ⑦ 자격 없는 구성원의 CLI 는 멈추지 않고 실패하고 등록을 안내한다 — 조직 토큰은 원격으로 나가지 않는다
//   ⑧ 그 구성원이 토큰을 등록하면(라이블리에만 · 이 컴퓨터 git 설정 없음) 곧바로 받는다
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const DBURL = process.env.ITEMS_DATABASE_URL || "";
if (!DBURL) { console.error("ITEMS_DATABASE_URL 필요(스크래치 pg)"); process.exit(2); }
if (!/test/i.test(new URL(DBURL).pathname)) { console.error("스크래치 DB 가 아니다(이름에 test 가 없다) — 돌리지 않는다"); process.exit(2); }
if (!process.env.CONNECTOR_SECRET_KEY) { console.error("CONNECTOR_SECRET_KEY 필요(자격 봉투 암호화)"); process.exit(2); }

const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gitcred-itest-")));
const ALICE_TOKEN = "ghp_ALICE-" + crypto.randomBytes(8).toString("hex");
const BOB_TOKEN = "ghp_BOB-" + crypto.randomBytes(8).toString("hex");
const ORG_TOKEN = "ghp_ORG-" + crypto.randomBytes(8).toString("hex");
const PASSWORD = "itest-pw-" + crypto.randomBytes(6).toString("hex");
const REPO = "gitcred-itest-" + crypto.randomBytes(3).toString("hex");
const REPO_SSH = REPO + "-ssh";
const [ADMIN, ALICE, BOB] = ["__gc_admin__", "__gc_alice__", "__gc_bob__"];

// 기본 인증을 거는 정적 HTTP 서버(= git «dumb» HTTP 원격). 받아들일 자격은 파일로 읽는다.
const SERVER_JS = `
const http = require("http"), fs = require("fs"), path = require("path");
const [root, logFile, allowFile] = process.argv.slice(2);
http.createServer((req, res) => {
  const auth = String(req.headers.authorization || "");
  fs.appendFileSync(logFile, JSON.stringify({ url: req.url, auth }) + "\\n");
  let allow = []; try { allow = JSON.parse(fs.readFileSync(allowFile, "utf8")); } catch {}
  if (!allow.map((c) => "Basic " + Buffer.from(c).toString("base64")).includes(auth)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="t"' }); res.end(); return; }
  const f = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(b); });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`;

let gateway = null, gitSrv = null;
const cleanup = () => { try { gateway?.kill(); } catch { /* */ } try { gitSrv?.kill(); } catch { /* */ } try { rmSync(SB, { recursive: true, force: true }); } catch { /* */ } };
try {
  // ── 사설 원격 ──
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(SB, "gitconfig"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@test.local", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@test.local" };
  writeFileSync(path.join(SB, "gitconfig"), "");
  const git = (args, cwd) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const work = path.join(SB, "work"), WWW = path.join(SB, "www"), bare = path.join(WWW, "origin.git");
  git(["init", "-q", "--initial-branch=main", work]);
  writeFileSync(path.join(work, "SECRET_CODE"), "private\n");
  git(["add", "-A"], work); git(["commit", "-q", "-m", "v1"], work);
  mkdirSync(WWW, { recursive: true });
  git(["clone", "-q", "--bare", work, bare]); git(["update-server-info"], bare);
  const TIP = git(["rev-parse", "refs/heads/main"], bare);
  const LOG = path.join(SB, "http.log"), ALLOW = path.join(SB, "allow.json");
  writeFileSync(LOG, ""); writeFileSync(path.join(SB, "server.cjs"), SERVER_JS);
  const allow = (...c) => writeFileSync(ALLOW, JSON.stringify(c));
  gitSrv = spawn(process.execPath, [path.join(SB, "server.cjs"), WWW, LOG, ALLOW], { stdio: ["ignore", "pipe", "inherit"] });
  const gitPort = await new Promise((res, rej) => { gitSrv.stdout.once("data", (d) => res(Number(String(d).trim()))); setTimeout(() => rej(new Error("git 원격이 뜨지 않았다")), 15000); });
  const GIT_URL = `http://127.0.0.1:${gitPort}/origin.git`;
  const sent = (since = 0) => readFileSync(LOG, "utf8").split("\n").filter(Boolean).slice(since).map((l) => JSON.parse(l).auth).filter(Boolean)
    .map((a) => Buffer.from(a.replace(/^Basic /, ""), "base64").toString("utf8"));
  const seenCount = () => readFileSync(LOG, "utf8").split("\n").filter(Boolean).length;

  // ── 스키마(게이트웨이 부팅 전) ──
  const { itemsPool } = await import(`${ROOT}/dist/db/client.js`);
  const { initAllSchemas } = await import(`${ROOT}/dist/boot/schemas.js`);
  const { setMemberPassword } = await import(`${ROOT}/dist/auth/local-accounts.js`);
  const { mintToken } = await import(`${ROOT}/dist/org/store/tokens.js`);
  await initAllSchemas({ quiet: true });

  // ── 게이트웨이 기동 ──
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  gateway = spawn(process.execPath, [`${ROOT}/dist/index.js`], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), PUBLIC_URL: BASE, LIVELY_NO_SCHEDULER: "1", LOG_LEVEL: "info" },
  });
  let boot = "";
  gateway.stdout.on("data", (d) => { boot += d; }); gateway.stderr.on("data", (d) => { boot += d; });
  let gwExit = null;
  gateway.on("exit", (code, sig) => { gwExit = { code, sig }; });
  globalThis.__gw = { exit: () => gwExit, tail: () => boot.slice(-2500) };
  let up = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) { up = true; break; } } catch { /* 아직 */ } await sleep(500); }
  if (!up) throw new Error(`게이트웨이 기동 실패:\n${boot.slice(-2000)}`);
  //  첫 부팅의 뒷일(스키마 자식 · 등록부)이 끝나 5초 동안 계속 살아 있어야 시작한다.
  for (let i = 0; i < 10; i++) { await sleep(500); if (gwExit || !(await fetch(`${BASE}/healthz`).then((r) => r.ok, () => false))) throw new Error(`게이트웨이가 부팅 직후 내려갔다: ${JSON.stringify(gwExit)}\n${boot.slice(-2000)}`); }


  // ── 구성원 · 접속 열쇠 시드(부팅 뒤) ──
  //  게이트웨이가 가라앉은 **뒤에** 심는다 — 새 DB 의 첫 부팅은 워크스페이스 등록부를 그때 세우므로, 그 전에 구운 열쇠는
  //   부팅 뒤 «없는 열쇠»(401)가 된다(실측: 새 DB 첫 실행에서만 빨갰다).
  const seed = async (id, scopes) => itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, state, scopes) VALUES($1,'human',$1,$2,'active',$3::jsonb)
     ON CONFLICT ON CONSTRAINT org_member_pkey DO UPDATE SET state='active', email=$2, scopes=$3::jsonb`, [id, `${id}@example.invalid`, JSON.stringify(scopes)]);
  await seed(ADMIN, ["items", "context", "admin", "code"]);
  await seed(ALICE, ["items", "context", "code"]);
  await seed(BOB, ["items", "context", "code"]);
  await itemsPool.query("DELETE FROM git_credential WHERE owner IN ($1,$2,$3) OR (owner='gateway' AND host='127.0.0.1')", [`member:${ADMIN}`, `member:${ALICE}`, `member:${BOB}`]);
  await setMemberPassword(ALICE, PASSWORD, { mustChange: false, actor: "itest" });
  const mint = async (m, scopes, extra = {}) => (await mintToken({ userId: m, memberId: m, scopes, label: "gitcred-itest", ...extra }, "itest", "itest")).token;
  const T = {
    admin: await mint(ADMIN, ["items", "context", "admin", "code"]),
    alice: await mint(ALICE, ["items", "context", "code"]),
    bob: await mint(BOB, ["items", "context", "code"]),
    aliceNoContext: await mint(ALICE, ["items"]),
    aliceOauth: await mint(ALICE, ["items", "context", "code"], { clientId: "itest-chat-client" }),
  };

  const api = async (p, { token, method = "POST", body, cookie } = {}) => {
    const res = await fetch(BASE + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
  const must = async (name, p, opts) => { const r = await api(p, opts); if (r.status !== 200) throw new Error(`${name} 실패 ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
  const LEASE = "/api/ui/me/git-credential/lease";

  // ── 준비: 레포 등록(https 주소 · ssh 주소) + 조직 자격 + alice 자격 — 전부 제품 REST 로 ──
  await must("레포 생성", "/api/ui/domainmap/repo/create", { token: T.admin, body: { name: REPO } });
  await must("레포 생성(ssh)", "/api/ui/domainmap/repo/create", { token: T.admin, body: { name: REPO_SSH } });
  const srcPath = (await api("/api/ui/domainmap/repo/source", { token: T.admin, body: { name: REPO, git_url: GIT_URL, default_branch: "main" } }));
  if (srcPath.status !== 200) throw new Error(`레포 주소 연결 실패 ${srcPath.status}: ${srcPath.text.slice(0, 300)}`);
  await must("레포 주소 연결(ssh)", "/api/ui/domainmap/repo/source", { token: T.admin, body: { name: REPO_SSH, git_url: "git@127.0.0.1:acme/x.git", default_branch: "main" } });
  await must("조직 자격 등록", "/api/ui/org/git-credential", { token: T.admin, body: { kind: "https", host: "127.0.0.1", token: ORG_TOKEN } });
  await must("alice 자격 등록", "/api/ui/me/git-credential", { token: T.alice, body: { kind: "https", host: "127.0.0.1", token: `  ${ALICE_TOKEN}\n` } });
  const repos = await must("레포 목록", "/api/ui/repos", { token: T.alice, method: "GET" });
  const row = (repos.domainmapRepos || []).find((r) => r.name === REPO);
  chk("준비: 레포가 목록에 https 주소로 보인다", row && row.clone_url === GIT_URL, JSON.stringify(row));
  const orgPub = await must("조직 자격 조회", "/api/ui/org/git-credential", { token: T.admin, method: "GET" });
  chk("준비: 조직(게이트웨이) 자격이 실제로 등록돼 있다(②가 뜻을 가진다)", (orgPub.credentials || []).some((c) => c.host === "127.0.0.1" && c.has_https_token), JSON.stringify(orgPub));

  // ── ① 본인 토큰 ──
  const a = await api(LEASE, { token: T.alice, body: { repo: REPO } });
  chk("① alice: 본인이 등록한 HTTPS 토큰을 받는다(앞뒤 공백은 저장 때 걷혔다)",
    a.status === 200 && a.json?.credential?.kind === "https" && a.json.credential.token === ALICE_TOKEN && a.json.host === "127.0.0.1" && a.json.reason === null, a.text.slice(0, 300));
  chk("① alice: 토큰을 쓸 자리(등록 주소의 scheme://host:port)가 함께 온다", a.json?.origin === `http://127.0.0.1:${gitPort}`, String(a.json?.origin));
  chk("① alice: 사용자 이름 기본값 x-access-token", a.json?.credential?.username === "x-access-token", a.text.slice(0, 200));
  chk("① 응답에 조직 토큰이 섞이지 않는다", !a.text.includes(ORG_TOKEN));

  // ── ② ★ 자격 없는 구성원 — 조직 자격은 나가지 않는다 ──
  const b = await api(LEASE, { token: T.bob, body: { repo: REPO } });
  chk("② bob(등록한 자격 없음): 아무것도 못 받는다 · 까닭 no-credential", b.status === 200 && b.json?.credential === null && b.json?.reason === "no-credential", b.text.slice(0, 300));
  chk("② ★ 조직(게이트웨이) 토큰이 응답 어디에도 없다", !b.text.includes(ORG_TOKEN) && !b.text.includes("ghp_"), b.text.slice(0, 300));
  const adm = await api(LEASE, { token: T.admin, body: { repo: REPO } });
  chk("② 관리자도 본인 자격이 없으면 조직 토큰을 못 받는다", adm.status === 200 && adm.json?.credential === null && !adm.text.includes(ORG_TOKEN), adm.text.slice(0, 300));
  chk("② 남의 토큰이 섞이지 않는다(bob · 관리자 응답에 alice 토큰 없음)", !b.text.includes(ALICE_TOKEN) && !adm.text.includes(ALICE_TOKEN));

  // ── ③ 거절 ──
  const noAuth = await api(LEASE, { body: { repo: REPO } });
  chk("③ 인증 없음 → 401", noAuth.status === 401 && !noAuth.text.includes("ghp_"), `status=${noAuth.status}`);
  const login = await fetch(BASE + "/api/ui/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${ALICE}@example.invalid`, password: PASSWORD }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  chk("③ 준비: alice 웹 로그인이 됐다", login.status === 200 && cookie.includes("="), `status=${login.status}`);
  const viaWeb = await api(LEASE, { cookie, body: { repo: REPO } });
  chk("③ 웹 로그인 세션(쿠키) → 403 · 토큰 없음", viaWeb.status === 403 && !viaWeb.text.includes("ghp_"), `status=${viaWeb.status} ${viaWeb.text.slice(0, 200)}`);
  const webOwn = await api("/api/ui/me/git-credential", { cookie, method: "GET" });
  chk("③ 배선: 같은 쿠키로 다른 본인 조회는 된다(쿠키가 유효한데도 리스만 거절된 것)", webOwn.status === 200 && !webOwn.text.includes("ghp_"), `status=${webOwn.status}`);
  const viaOauth = await api(LEASE, { token: T.aliceOauth, body: { repo: REPO } });
  chk("③ OAuth 클라이언트 토큰 → 403 · 토큰 없음", viaOauth.status === 403 && !viaOauth.text.includes("ghp_"), `status=${viaOauth.status} ${viaOauth.text.slice(0, 200)}`);
  const noCtx = await api(LEASE, { token: T.aliceNoContext, body: { repo: REPO } });
  chk("③ context 권한 없는 토큰 → 403 · 토큰 없음", noCtx.status === 403 && !noCtx.text.includes("ghp_"), `status=${noCtx.status}`);
  const viaGet = await api(`${LEASE}?repo=${REPO}`, { token: T.alice, method: "GET" });
  chk("③ GET 으로는 받을 수 없다", viaGet.status !== 200 && !viaGet.text.includes("ghp_"), `status=${viaGet.status}`);
  const badName = await api(LEASE, { token: T.alice, body: { repo: "../etc" } });
  chk("③ 레포 이름이 아닌 값 → 400", badName.status === 400, `status=${badName.status}`);

  // ── ④ 까닭 구분 ──
  const unk = await api(LEASE, { token: T.alice, body: { repo: "no-such-repo-" + crypto.randomBytes(3).toString("hex") } });
  chk("④ 등록되지 않은 레포 → 토큰 없음 · repo-unregistered", unk.status === 200 && unk.json?.credential === null && unk.json?.reason === "repo-unregistered" && !unk.text.includes("ghp_"), unk.text.slice(0, 200));
  const sshRepo = await api(LEASE, { token: T.alice, body: { repo: REPO_SSH } });
  chk("④ https 가 아닌 주소의 레포 → 토큰 없음 · not-https-url(같은 호스트에 토큰이 있어도)", sshRepo.status === 200 && sshRepo.json?.credential === null && sshRepo.json?.reason === "not-https-url" && !sshRepo.text.includes("ghp_"), sshRepo.text.slice(0, 200));

  // ── ⑤ 호출 기록 ──
  await sleep(800);   // 호출 기록 적재는 비동기
  const logs = await itemsPool.query("SELECT tool, actor, args::text AS args, error FROM mcp_call_log WHERE tool='me_git_credential_lease'");
  const dump = JSON.stringify(logs.rows);
  chk("⑤ 호출 기록 표에 토큰이 없다(REST 호출은 그 표에 남지 않는다 — 0행이어도 통과)", !dump.includes("ghp_"), dump.slice(0, 300));
  chk("⑤ 게이트웨이 로그(부팅 이후 전체)에 토큰이 남지 않는다", !boot.includes(ALICE_TOKEN) && !boot.includes(ORG_TOKEN), "게이트웨이 로그에 토큰");
  chk("⑤ 내준 사실은 감사 로그에 남는다(누가 · 어느 레포)", boot.includes("git_credential_lease") && boot.includes(ALICE) && boot.includes(REPO), boot.slice(-400));

  // ── ⑥⑦⑧ 로컬 CLI — 이 컴퓨터에 git 자격이 전혀 없다 ──
  const cli = async (who, token, repo = REPO) => {
    const home = path.join(SB, `home-${who}`);
    mkdirSync(path.join(home, ".lively"), { recursive: true });
    writeFileSync(path.join(home, ".lively", "gateway-url"), BASE + "\n");
    writeFileSync(path.join(home, ".lively", "token"), token + "\n");
    writeFileSync(path.join(home, "gitconfig"), "");
    const cwd = path.join(home, "cwd"); mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, LIVELY_HOME: home, LIVELY_REPOS_DIR: path.join(home, "repos"), TMPDIR: path.join(home, "tmp"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), NO_COLOR: "1",
      LIVELY_TOKEN: "", LIVELY_MCP_TOKEN: "", LIVELY_GATEWAY_URL: "", LIVELY_SESSION_ID: "", LIVELY_HOST_EFFECTS: "", LIVELY_HOST_EFFECTS_TEST_MODE: "" };
    delete env.GIT_ASKPASS; delete env.SSH_ASKPASS; delete env.GIT_CONFIG_COUNT;
    mkdirSync(env.TMPDIR, { recursive: true });
    const t0 = Date.now();
    return await new Promise((res) => {
      const p = spawn(process.execPath, [path.join(ROOT, "kit/cli/lively.mjs"), "repo", "pin", repo], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
      const timer = setTimeout(() => p.kill(), 120_000);
      p.on("exit", (code) => { clearTimeout(timer); res({ code, out, ms: Date.now() - t0, home }); });
    });
  };
  const pinned = (home) => { try { return git(["rev-parse", "refs/remotes/origin/main"], path.join(home, "repos", REPO)); } catch { return null; } };

  allow(`x-access-token:${ALICE_TOKEN}`);
  let n0 = seenCount();
  const ca = await cli("alice", T.alice);
  chk("⑥ alice 의 CLI: git 자격 없는 컴퓨터에서 사설 레포를 받는다(exit 0 · 원격 최신)", ca.code === 0 && pinned(ca.home) === TIP, `exit=${ca.code} ${ca.out.slice(-400)}`);
  chk("⑥ 원격이 본 자격 = alice 본인 토큰", sent(n0).includes(`x-access-token:${ALICE_TOKEN}`), JSON.stringify(sent(n0).map((s) => s.slice(0, 24))));
  chk("⑥ CLI 출력 · 받아 둔 레포 설정에 토큰이 없다", !ca.out.includes("ghp_") && !readFileSync(path.join(ca.home, "repos", REPO, ".git", "config"), "utf8").includes("ghp_"));

  allow(`x-access-token:${ALICE_TOKEN}`, `x-access-token:${ORG_TOKEN}`);   // 조직 토큰이 나가면 원격이 받아 준다 — 나가지 않아야 한다
  n0 = seenCount();
  const cb = await cli("bob", T.bob);
  chk("⑦ bob 의 CLI: 실패한다(받을 자격이 없다)", cb.code !== 0 && pinned(cb.home) === null, `exit=${cb.code}`);
  chk("⑦ 멈추지 않는다", cb.ms < 60_000, `${cb.ms}ms`);
  chk("⑦ 원격에 실제로 닿았다(배선)", seenCount() > n0, "요청 0건");
  chk("⑦ ★ 조직 토큰이 원격으로 나가지 않는다", !sent(n0).some((s) => s.includes("ghp_")), JSON.stringify(sent(n0).map((s) => s.slice(0, 24))));
  chk("⑦ 안내: 라이블리에 HTTPS 토큰 등록(호스트 포함)", /me_git_credential_set \{kind:"https", host:"127\.0\.0\.1"/.test(cb.out), cb.out.slice(-500));

  await must("bob 자격 등록", "/api/ui/me/git-credential", { token: T.bob, body: { kind: "https", host: "127.0.0.1", username: "bob-user", token: BOB_TOKEN } });
  allow(`bob-user:${BOB_TOKEN}`);
  n0 = seenCount();
  const cb2 = await cli("bob", T.bob);
  chk("⑧ bob 이 라이블리에 토큰을 등록하면 같은 컴퓨터에서 곧바로 받는다", cb2.code === 0 && pinned(cb2.home) === TIP, `exit=${cb2.code} ${cb2.out.slice(-400)}`);
  chk("⑧ 원격이 본 자격 = bob 이 등록한 사용자 이름 · 토큰", sent(n0).includes(`bob-user:${BOB_TOKEN}`), JSON.stringify(sent(n0).map((s) => s.slice(0, 24))));
  chk("⑧ 이 컴퓨터의 git 설정은 그대로 비어 있다(라이블리 등록만으로 됐다)", readFileSync(path.join(cb2.home, "gitconfig"), "utf8") === "" && !existsSync(path.join(cb2.home, ".git-credentials")));

  await itemsPool.query("DELETE FROM git_credential WHERE owner IN ($1,$2,$3) OR (owner='gateway' AND host='127.0.0.1')", [`member:${ADMIN}`, `member:${ALICE}`, `member:${BOB}`]);
  await itemsPool.end().catch(() => { /* */ });
} catch (e) {
  bad("하네스", String(e?.stack ?? e).slice(0, 1500) + (globalThis.__gw ? `\n게이트웨이: ${JSON.stringify(globalThis.__gw.exit())}\n${globalThis.__gw.tail()}` : ""));
} finally {
  cleanup();
}
console.log(`\ngit-credential-lease itest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
