// GitHub App 설치 → clone 자격(#1881 G8) 순수 단위 체크 — DB/네트워크 불요.
// 실행: npm run build && node dist/org/credentials/github-app-git.test.js
//  커버: clone 주소 파서(https·ssh·자격박힘·.git·끝슬래시·타호스트·서브경로) · 호스트 판정.
//  ※ githubAppGitSecret 자체는 DB(설치 목록)+상류 발급이라 여기 없다 — 실호출로만 확인된다(G11).
import assert from "node:assert/strict";
import { githubRepoFullName, isGithubAppHost, repoScopeNames } from "./github-repo-url.js";   // #2165 — 순수 함수는 잎 모듈로 옮겼다

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("R1·R2·R3 https·ssh·확장자 없는 주소 모두 owner/repo 로", () => {
  assert.equal(githubRepoFullName("https://github.com/livewithlively/lively.git"), "livewithlively/lively");
  assert.equal(githubRepoFullName("git@github.com:livewithlively/lively.git"), "livewithlively/lively");
  assert.equal(githubRepoFullName("https://github.com/livewithlively/lively"), "livewithlively/lively");
  assert.equal(githubRepoFullName("ssh://git@github.com/livewithlively/lively.git"), "livewithlively/lively");
});

t("R4 끝 슬래시와 .git 이 함께 와도 정리한다(순서 함정)", () => {
  assert.equal(githubRepoFullName("https://github.com/o/r.git/"), "o/r");
  assert.equal(githubRepoFullName("https://github.com/o/r/"), "o/r");
});

t("★ R10 자격이 박힌 주소에서도 호스트를 옳게 읽는다 — 정규식이면 'user' 를 호스트로 오인한다", () => {
  assert.equal(githubRepoFullName("https://user:ghp_TOKEN@github.com/o/r.git"), "o/r");
  assert.equal(githubRepoFullName("https://x-access-token:ghs_T@github.com/o/r.git"), "o/r");
});

t("R8 호스트는 대소문자를 가리지 않는다", () => {
  assert.equal(githubRepoFullName("https://GitHub.com/o/r.git"), "o/r");
  assert.equal(githubRepoFullName("git@GitHub.COM:o/r.git"), "o/r");
});

t("R5 다른 호스트는 null — 이 경로는 github.com 전용이다", () => {
  assert.equal(githubRepoFullName("https://gitlab.com/o/r.git"), null);
  assert.equal(githubRepoFullName("git@git.company.com:o/r.git"), null);
  // ⚠ 남의 호스트를 github.com 으로 오인하면 엉뚱한 설치에 토큰을 요청하게 된다.
  assert.equal(githubRepoFullName("https://github.com.evil.example/o/r.git"), null);
});

t("R7 owner/repo 두 칸이 아니면 null — 지어낸 이름으로 토큰을 좁히지 않는다", () => {
  assert.equal(githubRepoFullName("https://github.com/onlyone"), null);
  assert.equal(githubRepoFullName("https://github.com/a/b/c"), null);
  assert.equal(githubRepoFullName("https://github.com/"), null);
});

t("R6 빈 값·이상한 값은 null(던지지 않는다 — clone 경로가 예외로 죽으면 안 된다)", () => {
  assert.equal(githubRepoFullName(null), null);
  assert.equal(githubRepoFullName(undefined), null);
  assert.equal(githubRepoFullName("   "), null);
  assert.equal(githubRepoFullName("not a url"), null);
  assert.equal(githubRepoFullName("file:///etc/passwd"), null);
});

t("호스트 판정 — GHES(자체호스팅)는 앱이 달라 이 경로를 안 탄다", () => {
  assert.equal(isGithubAppHost("github.com"), true);
  assert.equal(isGithubAppHost("GitHub.com"), true);
  assert.equal(isGithubAppHost("github.acme.com"), false);
  assert.equal(isGithubAppHost(""), false);
});

t("★ 토큰을 좁힐 때는 저장소 '이름만' 넘긴다 — full name 을 넣으면 상류가 422 로 거부한다", () => {
  // 2026-08-26 실호출: 좁히지 않으면 발급 성공, 좁히면 전부 실패했다. 소유자는 installation 이 이미 안다.
  assert.deepEqual(repoScopeNames("livewithlively/lively-infra"), ["lively-infra"]);
  assert.deepEqual(repoScopeNames("o/r"), ["r"]);
});

t("좁힐 수 없으면 undefined — 설치 전체 토큰으로 떨어진다(동작은 한다)", () => {
  assert.equal(repoScopeNames(null), undefined);
  assert.equal(repoScopeNames("onlyname"), undefined);
  assert.equal(repoScopeNames("a/b/c"), undefined);
  assert.equal(repoScopeNames(""), undefined);
});

console.log(`\ngithub-app-git tests: ${pass} passed`);
