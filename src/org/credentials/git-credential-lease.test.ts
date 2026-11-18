// 로컬 도구용 git 자격 리스 — 누가 받나 · 무엇을 내주나(순수 판정) + 능력 선언의 모양.
//  실행: npm run build && node dist/org/credentials/git-credential-lease.test.js
//  DB 없이 돈다. 실 PG · 실 게이트웨이 끝단은 scripts/integration/git-credential-lease-pg.mjs.
//
//  사양(«입력 조합 × 기대»):
//   S  누가 받나 — 회수할 수 있는 접속 열쇠(DB 토큰)로 온 구성원 본인 → 허용
//      웹 로그인 세션 · 앱 토큰 · 앱 서버가 실어 온 신원 · 도구 상한이 실린 토큰(빈 상한 포함) · OAuth 클라이언트 · 정적 토큰 · 신원 없음 → 거절
//   T  무엇을 내주나 — https 주소 + 본인 HTTPS 토큰 → 내준다(사용자 이름이 없으면 x-access-token)
//      SSH 자격 → 안 내준다(개인키는 어떤 칸으로도 안 나간다) · https 가 아닌 주소 → 안 내준다 · 자격 없음 · 레포 미등록 → 안 내준다(까닭 구분)
//      토큰이 빈 값인 HTTPS 자격 → 안 내준다
//   W  능력 선언 — REST 전용(MCP 도구가 아니다) · 저장소를 바꾸지 않는다(읽기전용 세션도 부른다) · POST
//      선언 자체가 조직 자격을 집지 않는다(본인 자격 관문만 탄다)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LivelyUser } from "../../context.js";
import type { GitCredentialSecret } from "./git-credential-store.js";

process.env.CONNECTOR_SECRET_KEY = "unit-test-key-do-not-use-in-prod-0123456789";
const { localGitLeaseDenial, localGitLeaseOf, isHttpsGitUrl, gitOriginOf } = await import("./git-credential-lease.js");

let pass = 0;
const ok = (name: string): void => { pass++; console.log(`ok  ${name}`); };

const member = (over: Partial<LivelyUser> = {}): LivelyUser =>
  ({ userId: "m1", email: "m1@example.com", scopes: ["context"], projects: ["*"], tokenSource: "db", ...over });

// ── S 누가 받나 ──
{
  assert.equal(localGitLeaseDenial(member()), null);
  ok("S 접속 열쇠(DB 토큰)로 온 구성원 본인은 받는다");

  const denied: Array<[string, LivelyUser | undefined | null]> = [
    ["웹 로그인 세션", member({ tokenSource: "session" })],
    ["정적 토큰", member({ tokenSource: "static" })],
    ["출처 없는 주체", member({ tokenSource: undefined })],
    ["앱 토큰", member({ appId: "app-1" })],
    ["앱 서버가 실어 온 사람 신원", member({ appServer: true })],
    ["앱 작업 신원(앱 id + 앱 서버)", member({ appId: "app-1", appServer: true, appJobId: 7 })],
    ["도구 상한이 실린 토큰", member({ toolCeiling: ["knowledge_search"] })],
    ["빈 도구 상한이 실린 토큰", member({ toolCeiling: [] })],
    ["OAuth 클라이언트 토큰", member({ oauthClientId: "chat-client" })],
    ["신원 없음(undefined)", undefined],
    ["신원 없음(null)", null],
    ["userId 가 빈 주체", member({ userId: "" })],
  ];
  for (const [name, user] of denied) {
    const why = localGitLeaseDenial(user);
    assert.ok(typeof why === "string" && why.length > 0, `${name} 이 통과했다`);
    ok(`S 거절: ${name}`);
  }
  //  거절 사유가 주체마다 구분된다 — 한 문구로 뭉치면 «왜 안 되는지» 를 부른 쪽이 알 수 없다.
  assert.notEqual(localGitLeaseDenial(member({ tokenSource: "session" })), localGitLeaseDenial(member({ tokenSource: "static" })));
  assert.notEqual(localGitLeaseDenial(member({ appId: "a" })), localGitLeaseDenial(member({ oauthClientId: "c" })));
  ok("S 거절 사유가 주체 종류마다 다르다");
}

// ── T 무엇을 내주나 ──
{
  const https = (over: Partial<GitCredentialSecret> = {}): GitCredentialSecret =>
    ({ owner: "member:m1", host: "github.com", kind: "https", ssh_public_key: null, ssh_private_key: null, https_username: "octo", https_token: "ghp_SECRET", ...over });
  const ssh: GitCredentialSecret =
    { owner: "member:m1", host: "github.com", kind: "ssh", ssh_public_key: "ssh-ed25519 AAAA", ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE\n", https_username: null, https_token: null };
  const URL_HTTPS = "https://github.com/acme/repo.git";

  assert.deepEqual(localGitLeaseOf(URL_HTTPS, "github.com", https()),
    { host: "github.com", origin: "https://github.com", credential: { kind: "https", username: "octo", token: "ghp_SECRET" }, reason: null });
  ok("T https 주소 + 본인 HTTPS 토큰 → 내준다(쓸 자리 origin 과 함께)");

  //  쓸 자리 — 로컬 도구가 git 의 원격과 글자 그대로 대조한다(scheme · 포트까지). 박힌 자격 · 경로는 빠진다.
  assert.equal(gitOriginOf("https://GitHub.com/acme/repo.git"), "https://github.com");
  assert.equal(gitOriginOf("https://git.example.com:8443/a/b.git"), "https://git.example.com:8443");
  assert.equal(gitOriginOf("https://git.example.com:443/a/b.git"), "https://git.example.com");      // 기본 포트는 생략(로컬과 같은 표기)
  assert.equal(gitOriginOf("http://git.internal/a/b.git"), "http://git.internal");                   // scheme 이 자리의 일부다
  assert.notEqual(gitOriginOf("http://git.example.com/a"), gitOriginOf("https://git.example.com/a"));
  assert.equal(gitOriginOf("https://user:secret-pw@git.example.com/a/b.git"), "https://git.example.com");
  for (const bad of ["git@github.com:a/b.git", "ssh://git@github.com/a/b", "file:///x", "", null, undefined, "https://", "not a url"]) assert.equal(gitOriginOf(bad), null, String(bad));
  ok("T 쓸 자리(origin): 소문자 · 포트 보존 · 기본 포트 생략 · scheme 구분 · 박힌 자격 제외 · http(s) 아니면 없음");
  assert.equal(localGitLeaseOf("https://git.example.com:8443/a/b.git", "git.example.com", https()).origin, "https://git.example.com:8443");
  ok("T 포트가 있는 등록 주소: 응답의 자리에 포트가 실린다");

  assert.equal(localGitLeaseOf(URL_HTTPS, "github.com", https({ https_username: null })).credential?.username, "x-access-token");
  assert.equal(localGitLeaseOf(URL_HTTPS, "github.com", https({ https_username: "" })).credential?.username, "x-access-token");
  ok("T 사용자 이름이 없으면 x-access-token");

  const fromSsh = localGitLeaseOf(URL_HTTPS, "github.com", ssh);
  assert.equal(fromSsh.credential, null);
  assert.equal(fromSsh.reason, "ssh-credential");
  assert.ok(!JSON.stringify(fromSsh).includes("PRIVATE"), "SSH 개인키가 응답에 실렸다");
  ok("T SSH 자격 → 안 내준다 · 개인키는 어떤 칸으로도 안 나간다");

  for (const url of ["git@github.com:acme/repo.git", "ssh://git@github.com/acme/repo.git", "git://github.com/acme/repo.git", "file:///srv/repo.git"]) {
    const r = localGitLeaseOf(url, "github.com", https());
    assert.equal(r.credential, null, `${url} 에 토큰을 내줬다`);
    assert.equal(r.reason, "not-https-url");
    assert.ok(!JSON.stringify(r).includes("ghp_SECRET"));
  }
  ok("T https 가 아닌 주소 → 토큰을 내주지 않는다(쓸 데 없는 시크릿은 안 내보낸다)");

  assert.deepEqual(localGitLeaseOf(URL_HTTPS, "github.com", null), { host: "github.com", origin: "https://github.com", credential: null, reason: "no-credential" });
  assert.deepEqual(localGitLeaseOf(URL_HTTPS, "github.com", undefined), { host: "github.com", origin: "https://github.com", credential: null, reason: "no-credential" });
  ok("T 등록한 자격이 없다 → 까닭 no-credential");

  for (const [url, host] of [[null, null], ["", null], [undefined, null], [URL_HTTPS, null]] as Array<[string | null | undefined, string | null]>) {
    const r = localGitLeaseOf(url, host, https());
    assert.equal(r.credential, null);
    assert.equal(r.reason, "repo-unregistered");
    assert.ok(!JSON.stringify(r).includes("ghp_SECRET"));
  }
  ok("T 레포가 등록돼 있지 않거나 주소가 없다 → 까닭 repo-unregistered · 토큰 없음");

  for (const tok of ["", null]) {
    const r = localGitLeaseOf(URL_HTTPS, "github.com", https({ https_token: tok }));
    assert.equal(r.credential, null);
  }
  ok("T 토큰이 빈 HTTPS 자격 → 내주지 않는다");

  //  자격이 박힌 등록 주소(https://token@host/…)도 https 로 본다 — 박힌 값은 응답에 실리지 않는다.
  const embedded = localGitLeaseOf("https://embedded-pat@github.com/acme/repo.git", "github.com", https());
  assert.equal(embedded.credential?.token, "ghp_SECRET");
  assert.ok(!JSON.stringify(embedded).includes("embedded-pat"));
  ok("T 자격이 박힌 등록 주소: 박힌 값은 응답에 실리지 않는다");

  assert.equal(isHttpsGitUrl("HTTPS://GitHub.com/a/b"), true);
  assert.equal(isHttpsGitUrl("http://git.internal/a/b"), true);
  assert.equal(isHttpsGitUrl("  https://github.com/a/b  "), true);
  assert.equal(isHttpsGitUrl("httpsx://github.com/a/b"), false);
  assert.equal(isHttpsGitUrl(null), false);
  ok("T 주소 판정: 대소문자 · 앞뒤 공백 · http 허용 · 비슷한 scheme 거절");
}

// ── W 능력 선언 ──
{
  const { gitCredentialCapabilities } = await import("../../capabilities/delivery/git-credentials.js");
  const { capMutates } = await import("../../capabilities/index.js");
  const cap = gitCredentialCapabilities.find((c) => c.name === "me_git_credential_lease");
  assert.ok(cap, "me_git_credential_lease 가 등록돼 있지 않다");
  assert.equal(cap.expose.mcp, false);
  ok("W REST 전용이다(AI 가 부르는 MCP 도구가 아니다)");
  assert.equal(capMutates(cap), false);
  ok("W 저장소를 바꾸지 않는다(읽기전용 세션도 레포를 읽는다)");
  const rest = Array.isArray(cap.expose.rest) ? cap.expose.rest : [];
  assert.deepEqual(rest.map((m) => `${m.method} ${m.paths.join(",")}`), ["POST /api/ui/me/git-credential/lease"]);
  ok("W POST 한 길(시크릿 응답이 GET 캐시 · 주소 기록에 실리지 않는다)");

  //  핸들러 — 거절 주체는 DB 를 묻기 전에 막힌다(자격 조회 자체가 일어나지 않는다).
  for (const user of [member({ tokenSource: "session" }), member({ appId: "a" }), member({ toolCeiling: [] })]) {
    await assert.rejects(async () => cap.handler({ repo: "any" }, user, {}), (e: { status?: number }) => e.status === 403);
  }
  await assert.rejects(async () => cap.handler({ repo: "any" }, undefined as unknown as LivelyUser, {}), (e: { status?: number }) => e.status === 401);
  ok("W 핸들러: 거절 주체는 403 · 신원 없음은 401");
  for (const repo of ["", "..", "a/b", "x".repeat(101), "re po"]) {
    await assert.rejects(async () => cap.handler({ repo }, member(), {}), (e: { status?: number }) => e.status === 400, `repo=${JSON.stringify(repo)}`);
  }
  ok("W 핸들러: 레포 이름이 아닌 값은 400(경로 · 빈 값 · 길이)");

  //  조직 자격을 집는 함수를 이 능력 파일이 리스 길에서 부르지 않는다 — 본인 자격 관문(resolveRepoInject → leaseGitSecretForNode "member")만 탄다.
  const src = readFileSync(new URL("../../../src/capabilities/delivery/git-credentials.ts", import.meta.url), "utf8");
  const at = src.indexOf('name: "me_git_credential_lease"');
  const block = src.slice(at, src.indexOf('restOnly("org_git_credential_get"', at));
  assert.ok(at > 0 && block.length > 200, "리스 능력 블록을 못 찾았다");
  assert.ok(/resolveRepoInject\(repo, user\.userId, "member"\)/.test(block), "본인 자격 관문을 타지 않는다");
  assert.ok(!/resolveGitSecret|getGitSecret|GATEWAY_OWNER|"worker"/.test(block), "리스 길이 조직 자격을 집을 수 있다");
  ok("W 리스 길은 본인 자격 관문만 탄다(조직 자격 · worker 갈래를 부르지 않는다)");
}

console.log(`\ngit-credential-lease: ${pass} passed`);
