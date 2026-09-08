// 세션 범위 실행 경계 (#3668 T2) — 사양 기반 엣지 표.
//
// ── 사양 (프로젝트 #3668 §7-4 · 태스크 T2) ──────────────────────────────────
// 멤버 홈에서 도는 op 를 **실행 대상**으로 가른다.
//  · 순수 파일 op(ls·stat·read·write·mkdir) — 게이트웨이가 쓴 명령이라 파일 «내용» 이 실행되지 않는다.
//    자리는 종전 그대로 **멤버 경계**(LIVELY_MEMBER_EXEC → 테넌트 파일 op 컨테이너 / 셀프호스트는 sudo→box-spawn).
//  · 프로그램 실행 op — 설치 번들(`node user-install.mjs`·`bash register-clients.sh`)과 git(그 멤버의
//    `~/.gitconfig` 가 alias·pager·credential.helper 로 실행할 코드를 정한다). 자리는 **그 세션의 컨테이너**
//    (LIVELY_SESSION_EXEC, gVisor 유지). #3668 T3 가 파일 op 자리에서 gVisor 를 걷을 수 있는 근거가 이 갈래다.
//
// ── 이 시험이 막으려는 사고 ────────────────────────────────────────────────
//  ① 파일 op 가 조용히 세션 경계로 새는 것 — 세션이 없을 때도 돌아야 하는 op(루트 브라우저·세션 생성 전 업로드)가
//     «컨테이너가 없습니다» 로 죽는다.
//  ② stdin 을 세션 경계로 보내는 것 — 세션 중계는 우리 stdin 의 EOF 를 컨테이너로 전파하지 않는다
//     (session-exec-relay.cjs `pipe(socket,{end:false})`). `cat > file` 이 **조용히 매달린다**(상한까지 90초).
//  ③ 순서가 되돌아가는 것 — 준비가 ensure 보다 앞서면 보낼 컨테이너가 아직 없어 멤버 경계로 조용히 떨어진다.
//
// ⚠ 가짜 중계는 argv 와 stdin 을 **기록만 하고 종료 0** 이다(실행하지 않는다) — `git config --global` 이
//  이 머신의 실제 ~/.gitconfig 를 만지면 안 된다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t2-exec-"));
const MEMBER_LOG = path.join(tmp, "member.log");
const SESSION_LOG = path.join(tmp, "session.log");

/** 기록만 하는 가짜 중계 — argv 와 stdin 을 한 줄 JSON 으로 남기고 0 으로 끝난다. */
function fakeRelay(logPath: string, tag: string): string {
  const file = path.join(tmp, `relay-${tag}.mjs`);
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    `const LOG = ${JSON.stringify(logPath)};`,
    "const argv = process.argv.slice(2);",
    "let stdin = '';",
    "let done = false;",
    "const fin = () => { if (done) return; done = true; fs.appendFileSync(LOG, JSON.stringify({ argv, stdin }) + '\\n'); process.exit(0); };",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (d) => { stdin += d; });",
    "process.stdin.on('end', fin);",
    "process.stdin.on('error', fin);",
    "process.stdin.on('close', fin);",
  ].join("\n"));
  return file;
}
const MEMBER_BIN = fakeRelay(MEMBER_LOG, "member");
const SESSION_BIN = fakeRelay(SESSION_LOG, "session");
const MEMBER_RELAY = `${process.execPath} ${MEMBER_BIN}`;
const SESSION_RELAY = `${process.execPath} ${SESSION_BIN}`;

const read = (p: string): Array<{ argv: string[]; stdin: string }> =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const reset = (): void => { fs.rmSync(MEMBER_LOG, { force: true }); fs.rmSync(SESSION_LOG, { force: true }); };

const { installTenantSlugResolver } = await import("./catalog.js");
const { execAtArgv, memberSh } = await import("./terminal-member-fs.js");
const { ensureGitSafeDirectory } = await import("../org/credentials/git-credential-materialize.js");

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

/** 두 중계를 모두 켠 «매니지드» 표면. */
const managed = (): void => {
  process.env.LIVELY_MEMBER_EXEC = MEMBER_RELAY;
  process.env.LIVELY_SESSION_EXEC = SESSION_RELAY;
  installTenantSlugResolver(() => "acme");
};
const clearEnv = (): void => {
  delete process.env.LIVELY_MEMBER_EXEC;
  delete process.env.LIVELY_SESSION_EXEC;
  installTenantSlugResolver(() => null);
};

const SID = "box-yoon-4b6ca04d";
const OS_USER = "box_yoon";
const atMember = [process.execPath, MEMBER_BIN, OS_USER, "--"];
const atSession = [process.execPath, SESSION_BIN, SID, "--"];

// ─────────────────────────────────────────────────────────────────────────────
// A. 경계 선택 — execAtArgv (순수)
// ─────────────────────────────────────────────────────────────────────────────

await t("[B1] 문자열 osUser 는 세션 중계가 켜져 있어도 **멤버 경계**다 — 파일 op 은 세션을 안 탄다", () => {
  managed();
  assert.deepEqual(execAtArgv(OS_USER, ["ls"]), [...atMember, "ls"]);
});

await t("[B2] { osUser, sessionId } 는 **그 세션 컨테이너 안**이다 — `<중계> <sid> -- <argv>`", () => {
  managed();
  assert.deepEqual(execAtArgv({ osUser: OS_USER, sessionId: SID }, ["sh", "-c", "true"]), [...atSession, "sh", "-c", "true"]);
});

await t("[B3] sessionId 가 null·undefined·빈문자열이면 멤버 경계 — «세션 없는 op» 는 종전 그대로", () => {
  managed();
  assert.deepEqual(execAtArgv({ osUser: OS_USER, sessionId: null }, ["ls"]), [...atMember, "ls"]);
  assert.deepEqual(execAtArgv({ osUser: OS_USER }, ["ls"]), [...atMember, "ls"]);
  assert.deepEqual(execAtArgv({ osUser: OS_USER, sessionId: "" }, ["ls"]), [...atMember, "ls"]);
});

await t("[B4] 세션 중계 미설정(셀프호스트) — sessionId 를 줘도 멤버 경계로 떨어진다(무회귀)", () => {
  managed();
  delete process.env.LIVELY_SESSION_EXEC;
  assert.deepEqual(execAtArgv({ osUser: OS_USER, sessionId: SID }, ["ls"]), [...atMember, "ls"]);
});

await t("[B5] ★ 세션 중계가 {slug} 인데 테넌트 컨텍스트가 없으면 던진다 — 남의 컨테이너로 폴백 금지", () => {
  clearEnv();
  process.env.LIVELY_SESSION_EXEC = "srelay {slug}";
  assert.throws(() => execAtArgv({ osUser: OS_USER, sessionId: SID }, ["ls"]), /테넌트 컨텍스트/);
});

await t("[B6] ★ 세션 id 형식이 틀리면 던진다 — 그 값이 컨테이너 이름의 재료다", () => {
  managed();
  assert.throws(() => execAtArgv({ osUser: OS_USER, sessionId: "bad id" }, ["ls"]), /세션 id 형식/);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. stdin 규율 — 세션 경계는 EOF 를 전파하지 않는다
// ─────────────────────────────────────────────────────────────────────────────

await t("[B7] ★★ 세션 경계 + stdin 은 **거절한다** — 그대로 보내면 EOF 를 못 받아 조용히 매달린다", async () => {
  managed();
  reset();
  await assert.rejects(() => memberSh({ osUser: OS_USER, sessionId: SID }, 'cat > "$HOME/x"', "시크릿"), /stdin/);
  assert.equal(read(SESSION_LOG).length, 0, "거절했으면 중계를 부르지도 않아야 한다");
  assert.equal(read(MEMBER_LOG).length, 0, "멤버 경계로 조용히 떨어져서도 안 된다(그건 자리를 숨긴다)");
});

await t("[B8] 멤버 경계 + stdin 은 종전대로 흐른다 — 시크릿은 argv 가 아니라 stdin", async () => {
  managed();
  reset();
  await memberSh(OS_USER, 'cat > "$HOME/.lively/token"', "tok-SECRET");
  const calls = read(MEMBER_LOG);
  assert.equal(calls.length, 1, "★ 배선 — 가짜 중계가 실제로 불렸나(0건이면 아래 단언이 공허하다)");
  assert.equal(calls[0]!.stdin, "tok-SECRET");
  assert.ok(!calls[0]!.argv.join(" ").includes("tok-SECRET"), "시크릿이 argv 에 새면 ps 로 보인다");
  assert.equal(read(SESSION_LOG).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// C. git — `git config` 는 프로그램 실행이다
// ─────────────────────────────────────────────────────────────────────────────

await t("[G1] ★ ensureGitSafeDirectory 는 세션 자리를 받으면 **세션 컨테이너**에서 git 을 부른다", async () => {
  managed();
  reset();
  await ensureGitSafeDirectory({ osUser: OS_USER, sessionId: SID });
  const s = read(SESSION_LOG);
  assert.equal(s.length, 1, "★ 배선 — 세션 중계가 한 번 불려야 한다");
  assert.equal(s[0]!.argv[0], SID, "세션 중계 계약: <sid> -- <argv…>");
  assert.ok(s[0]!.argv.join(" ").includes("safe.directory"), "그 명령이 safe.directory 설정이어야 한다");
  assert.equal(read(MEMBER_LOG).length, 0, "git 은 파일 op 자리로 가면 안 된다(T3 가 거기서 gVisor 를 걷는다)");
});

await t("[G2] ensureGitSafeDirectory(문자열) — 세션이 없는 호출은 종전 멤버 경계", async () => {
  managed();
  reset();
  await ensureGitSafeDirectory(OS_USER);
  assert.equal(read(SESSION_LOG).length, 0);
  const m = read(MEMBER_LOG);
  assert.equal(m.length, 1, "★ 배선 — 멤버 중계가 불렸나");
  assert.equal(m[0]!.argv[0], OS_USER);
});

// ─────────────────────────────────────────────────────────────────────────────
// D. 구조 — 순서와 자리를 소스로 못박는다
//    (createSession 은 DB·tmux·브로커를 타서 여기서 부를 수 없다. 그래서 «어느 것이 먼저 오나» 는 소스로 본다.)
// ─────────────────────────────────────────────────────────────────────────────

// 빌드 후 dist/terminal/ 에서 돌므로 레포 루트는 ../../ 다.
const repo = (rel: string): string => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const SESSIONS_TS = repo("src/terminal/sessions.ts");
const GIT_GATEWAY_TS = repo("src/org/credentials/git-credential-materialize-gateway.ts");
// ★ 배선 0 — 파일을 정말 읽었나. 비었으면 아래 위치 단언이 전부 공허해진다.
assert.ok(SESSIONS_TS.length > 200 && GIT_GATEWAY_TS.length > 200, "소스를 못 읽었다 — 아래 단언이 전부 공허하다");

await t("[O1] ★★ 생성 순서 — ensure(컨테이너) 가 멤버 홈 준비보다 **앞**이다", () => {
  const ensure = SESSIONS_TS.indexOf("await ensureSessionContainerViaRelay(");
  const prepare = SESSIONS_TS.indexOf("await prepareMemberHome(");
  assert.ok(ensure > 0, "★ 배선 — ensureSessionContainerViaRelay 호출을 못 찾았다(이 시험이 헛돈다)");
  assert.ok(prepare > 0, "★ 배선 — prepareMemberHome 호출을 못 찾았다(이 시험이 헛돈다)");
  assert.ok(ensure < prepare,
    "시딩·git 이 컨테이너 확보보다 앞선다 — 보낼 세션 컨테이너가 아직 없어 멤버 경계로 조용히 떨어진다(#3668 §3-3)");
});

await t("[O2] 준비는 판(pane) 명령보다 앞이다 — 하네스가 뜰 때 훅·자격이 이미 있어야 한다", () => {
  const prepare = SESSIONS_TS.indexOf("await prepareMemberHome(");
  const pane = SESSIONS_TS.indexOf("args.push(...sessionPaneArgv(");
  assert.ok(pane > 0, "★ 배선 — 판 명령 조립을 못 찾았다(이 시험이 헛돈다)");
  assert.ok(prepare > 0 && prepare < pane, "준비가 판보다 뒤면 첫 세션의 훅·대화창 매핑이 비는 창이 생긴다");
});

await t("[O3] ★ createSession 은 세션 컨테이너 경로에서만 세션 id 를 싣는다 — 아니면 세션 경계가 영영 안 쓰인다", () => {
  assert.match(SESSIONS_TS, /prepareMemberHome\(user, inside \? \{ osUser, sessionId: id \} : osUser\)/);
});

await t("[G3] git 자격 ④ — 시크릿 쓰기(stdin)와 `git config` 가 **다른 자리**로 갈라져 있다", () => {
  // 한 sh -c 에 둘이 붙어 있으면 세션 경계로 보낼 수 없다(stdin) → git 이 파일 op 자리에 남는다.
  const credWrite = GIT_GATEWAY_TS.indexOf('cat > "$HOME/.lively/git-credentials"');
  const gitConfig = GIT_GATEWAY_TS.indexOf("git config --global credential.helper");
  assert.ok(credWrite > 0 && gitConfig > 0, "★ 배선 — ④ 의 두 조각을 못 찾았다(이 시험이 헛돈다)");
  assert.match(GIT_GATEWAY_TS, /await memberSh\(at, 'git config --global credential\.helper/,
    "git config 는 실행 자리(at)로 가야 한다 — 문자열 osUser 로 남으면 T3 에서 gVisor 밖에서 돈다");
  assert.ok(credWrite < gitConfig, "helper 가 가리키는 파일을 먼저 써야 한다(없는 파일을 가리키는 창 금지)");
});

clearEnv();
console.log(`\n${pass} passed`);
