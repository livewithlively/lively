// git 자격(#540) 단위 체크 — 봉투 암호화(secret-box)·SSH 키생성·provision 자격 주입(prepareGitAuth) 메커니즘.
//  DB 없이 도는 순수 로직만(CRUD 는 박스 DB 통합검증). 실행: npm run build && node dist/org/git-credential.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

process.env.ENCRYPTION_KEY = "unit-test-key-do-not-use-in-prod-0123456789";
const { encryptSecret, decryptSecret, secretBoxReady } = await import("./secret-box.js");
const { generateSshKeypair } = await import("./git-credential-store.js");
const { hostOf, prepareGitAuth } = await import("../project-provision.js");
const { safeHost, buildSshConfigBlock, buildGitCredLines } = await import("./git-credential-materialize.js");

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

// ── secret-box: 왕복·변조탐지·포맷 ──
{
  const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nabcDEF123\n한글도\n-----END OPENSSH PRIVATE KEY-----\n";
  assert.equal(secretBoxReady(), true);
  const blob = encryptSecret(secret);
  assert.notEqual(blob, secret);                         // 평문 노출 안 됨
  assert.ok(blob.startsWith("gcm1."));                   // 버전 프리픽스
  assert.equal(decryptSecret(blob), secret);             // 왕복 일치
  ok("secret-box 왕복(한글·개행 포함)");

  const parts = blob.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url"); // 암호문 변조
  assert.throws(() => decryptSecret(parts.join(".")));      // GCM 태그 불일치 → throw
  ok("secret-box 변조 탐지");

  assert.throws(() => decryptSecret("not-a-valid-blob"));
  ok("secret-box 포맷 오류 거부");

  const b2 = encryptSecret(secret);
  assert.notEqual(b2, blob);                              // 매 호출 IV 랜덤 → 암호문 상이
  ok("secret-box IV 랜덤(결정적 아님)");
}

// ── fail-closed: 키 없으면 암·복호 throw ──
{
  const saved = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  assert.equal(secretBoxReady(), false);
  assert.throws(() => encryptSecret("x"));
  ok("ENCRYPTION_KEY 미설정 → fail-closed");
  process.env.ENCRYPTION_KEY = saved;
  assert.equal(secretBoxReady(), true);
}

// ── SSH 키페어 생성: 유효한 ed25519 ──
{
  const kp = await generateSshKeypair("unit@lively-box");
  assert.ok(kp.publicKey.startsWith("ssh-ed25519 "), "공개키 ed25519");
  assert.ok(/BEGIN OPENSSH PRIVATE KEY/.test(kp.privateKey), "개인키 OpenSSH 포맷");
  assert.ok(kp.publicKey.includes("unit@lively-box"), "코멘트 반영");
  ok("generateSshKeypair 유효 ed25519 키");
}

// ── hostOf: URL·scp-식·정크 ──
{
  assert.equal(hostOf("https://github.com/org/repo.git"), "github.com");
  assert.equal(hostOf("https://GHE.example.com:8443/o/r"), "ghe.example.com");
  assert.equal(hostOf("git@github.com:org/repo.git"), "github.com");
  assert.equal(hostOf("ssh://git@gitlab.internal/o/r"), "gitlab.internal");
  assert.equal(hostOf(""), null);
  assert.equal(hostOf(null), null);
  ok("hostOf 파싱(url·scp·정크)");
}

// ── prepareGitAuth: SSH 주입 env + 키파일 600 + cleanup ──
{
  const a = await prepareGitAuth(null);
  assert.equal(a.env, undefined);
  await a.cleanup();
  ok("prepareGitAuth(null) = 무주입");

  const ssh = await prepareGitAuth({ owner: "member:x", host: "github.com", kind: "ssh", ssh_public_key: "ssh-ed25519 AAAA x", ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nKEY\n-----END OPENSSH PRIVATE KEY-----\n", https_username: null, https_token: null });
  assert.ok(ssh.env && ssh.env.GIT_SSH_COMMAND.includes("ssh -i "), "GIT_SSH_COMMAND -i");
  assert.ok(ssh.env!.GIT_SSH_COMMAND.includes("IdentitiesOnly=yes"), "IdentitiesOnly");
  assert.equal(ssh.env!.GIT_TERMINAL_PROMPT, "0");
  const keyFile = ssh.env!.GIT_SSH_COMMAND.match(/ssh -i (\S+)/)![1];
  const st = fs.statSync(keyFile);
  assert.equal(st.mode & 0o777, 0o600, "키파일 권한 600");
  assert.ok(fs.readFileSync(keyFile, "utf8").includes("OPENSSH PRIVATE KEY"), "키 내용 기록");
  await ssh.cleanup();
  assert.equal(fs.existsSync(keyFile), false, "cleanup 후 키파일 삭제");
  ok("prepareGitAuth SSH 주입·600·cleanup");
}

// ── prepareGitAuth: HTTPS askpass 스크립트가 user/pass 를 정확히 echo ──
{
  const https = await prepareGitAuth({ owner: "gateway", host: "github.com", kind: "https", ssh_public_key: null, ssh_private_key: null, https_username: "octocat", https_token: "ghp_SECRET_TOKEN" });
  const askpass = https.env!.GIT_ASKPASS;
  assert.ok(askpass && fs.existsSync(askpass), "askpass 스크립트 존재");
  assert.equal(https.env!.GIT_CRED_USER, "octocat");
  assert.equal(https.env!.GIT_CRED_PASS, "ghp_SECRET_TOKEN");
  // git 이 하는 것처럼 프롬프트 문자열을 인자로 실행 → env 로 준 값을 echo 하는지.
  const env = { ...process.env, ...https.env };
  const u = spawnSync("sh", [askpass, "Username for 'https://github.com':"], { env, encoding: "utf8" });
  const p = spawnSync("sh", [askpass, "Password for 'https://octocat@github.com':"], { env, encoding: "utf8" });
  assert.equal(u.stdout, "octocat", "askpass Username");
  assert.equal(p.stdout, "ghp_SECRET_TOKEN", "askpass Password");
  await https.cleanup();
  assert.equal(fs.existsSync(askpass), false, "cleanup 후 askpass 삭제");
  ok("prepareGitAuth HTTPS askpass echo·cleanup");
}

// ── Slice 2 materialize: 순수 문자열 빌더(주입안전·포맷) ──
{
  assert.equal(safeHost("github.com"), "github_com");
  assert.equal(safeHost("GitLab.Example.com"), "gitlab_example_com");
  assert.equal(safeHost("a/b;rm -rf"), "a_b_rm_rf");         // 셸/경로 위험문자 중화
  ok("safeHost 안전화");

  const cfg = buildSshConfigBlock(["github.com", "gitlab.internal"]);
  assert.ok(cfg.includes("# >>> lively-managed git") && cfg.includes("# <<< lively-managed git"), "마커");
  assert.ok(cfg.includes("Host github.com") && cfg.includes("IdentityFile ~/.ssh/id_lively_github_com"), "github 블록");
  assert.ok(cfg.includes("Host gitlab.internal") && cfg.includes("id_lively_gitlab_internal"), "gitlab 블록");
  assert.ok(cfg.includes("IdentitiesOnly yes"), "IdentitiesOnly");
  ok("buildSshConfigBlock 다중호스트·마커");

  // 토큰/유저의 특수문자가 URL 을 안 깨게 인코딩되는지
  const lines = buildGitCredLines([
    { host: "github.com", https_username: null, https_token: "p@ss:w/rd" },
    { host: "gh.example.com", https_username: "user name", https_token: "tok" },
  ]);
  assert.ok(lines.includes("https://x-access-token:p%40ss%3Aw%2Frd@github.com"), "토큰 인코딩·기본유저");
  assert.ok(lines.includes("https://user%20name:tok@gh.example.com"), "유저 인코딩");
  assert.ok(!lines.includes("p@ss"), "raw 특수문자 미노출");
  ok("buildGitCredLines URL 인코딩(URL 무결)");
}

console.log(`\n${pass} passed`);
