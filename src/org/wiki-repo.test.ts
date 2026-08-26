// 등록 레포 → 위키 수집기 다리(#1881 G9) 순수 단위 체크 — DB/네트워크 불요.
// 실행: npm run build && node dist/org/wiki-repo.test.js
//  사양·엣지 표대로 행마다 시나리오 하나(B1~B12 · D1~D4 · W1~W4 · P1). fail-first 로 red 를 먼저 확인했다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wikiCollectorKey, wikiInstance, repoClonePath, detectContentSubdir, blobBaseUrl } from "./wiki-repo.js";
import { REPOS_SUBDIR } from "../project/project-provision.js";
import { PROJECT_SHARED_BASE } from "../project/project-fs.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ══ blobBaseUrl — 근거 칩이 원본을 여는 링크. 틀리면 조용히 남의 페이지로 간다 ══
t("B1·B2 GitHub 은 /blob/<branch> — https·ssh 두 형식 모두", () => {
  assert.deepEqual(blobBaseUrl("https://github.com/livewithlively/lively.git", "main"),
    { url: "https://github.com/livewithlively/lively/blob/main", guessed: false });
  assert.deepEqual(blobBaseUrl("git@github.com:livewithlively/lively.git", "develop"),
    { url: "https://github.com/livewithlively/lively/blob/develop", guessed: false });
});

t("B3 GitLab 은 /-/blob/<branch> — 서브그룹 경로를 잃지 않는다", () => {
  assert.deepEqual(blobBaseUrl("https://gitlab.com/acme/team/wiki.git", "main"),
    { url: "https://gitlab.com/acme/team/wiki/-/blob/main", guessed: false });
});

t("B4·B12 브랜치가 없거나 빈 문자열이면 main (경계)", () => {
  assert.equal(blobBaseUrl("git@gitlab.com:acme/wiki.git", null).url, "https://gitlab.com/acme/wiki/-/blob/main");
  assert.equal(blobBaseUrl("git@gitlab.com:acme/wiki.git", "").url, "https://gitlab.com/acme/wiki/-/blob/main");
  assert.equal(blobBaseUrl("git@gitlab.com:acme/wiki.git", "   ").url, "https://gitlab.com/acme/wiki/-/blob/main");
});

t("B5 모르는 호스트는 GitLab 문법으로 '추정'하되 추정임을 알린다", () => {
  const r = blobBaseUrl("git@git.company.com:infra/handbook.git", "master");
  assert.equal(r.url, "https://git.company.com/infra/handbook/-/blob/master");
  // 이 플래그가 없으면 사람은 깨진 링크를 눈치챌 방법이 없다 — 추정을 확정으로 보고하지 않는다.
  assert.equal(r.guessed, true);
});

t("B6·B7·B8 링크를 만들 수 없으면 만들지 않는다 (없는 링크 < 틀린 링크)", () => {
  assert.deepEqual(blobBaseUrl(null, "main"), { url: null, guessed: false });
  assert.deepEqual(blobBaseUrl(undefined, "main"), { url: null, guessed: false });
  assert.deepEqual(blobBaseUrl("   ", "main"), { url: null, guessed: false });
  assert.deepEqual(blobBaseUrl("not a url", "main"), { url: null, guessed: false });
  // http(s) 아닌 스킴 — 파일 URL 이 근거 링크로 나가면 안 된다.
  assert.equal(blobBaseUrl("file:///etc/passwd", "main").url, null);
});

t("B9 끝 슬래시·.git 접미를 정리한다", () => {
  assert.equal(blobBaseUrl("https://github.com/o/r/", "main").url, "https://github.com/o/r/blob/main");
  assert.equal(blobBaseUrl("https://github.com/o/r.git/", "main").url, "https://github.com/o/r/blob/main");
});

t("B10 ssh:// 접두가 붙은 형식도 파싱한다", () => {
  assert.equal(blobBaseUrl("ssh://git@gitlab.com/acme/wiki.git", "main").url,
    "https://gitlab.com/acme/wiki/-/blob/main");
});

t("B11 호스트는 대소문자를 가리지 않는다 — 판정도 출력도 소문자", () => {
  const a = blobBaseUrl("https://GitHub.com/o/r.git", "main");
  assert.deepEqual(a, { url: "https://github.com/o/r/blob/main", guessed: false });
  const b = blobBaseUrl("git@GitLab.COM:o/r.git", "main");
  assert.deepEqual(b, { url: "https://gitlab.com/o/r/-/blob/main", guessed: false },
    "대문자라고 GitLab 을 못 알아보면 자체호스팅으로 오판해 guessed 가 붙는다");
});

// ══ detectContentSubdir ══
t("D1·D2·D3 content 는 **디렉토리**일 때만 — 같은 이름의 파일은 루트로", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-repo-d-"));
  const file = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-repo-f-"));
  try {
    assert.equal(detectContentSubdir(dir), ".", "D2 없으면 루트");
    fs.mkdirSync(path.join(dir, "content"));
    assert.equal(detectContentSubdir(dir), "content", "D1");
    fs.writeFileSync(path.join(file, "content"), "not a dir");
    assert.equal(detectContentSubdir(file), ".", "D3 파일을 디렉토리로 오인하면 스캔 루트가 깨진다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(file, { recursive: true, force: true });
  }
});

t("D4 없는 경로에서 던지지 않는다 — 준비 단계가 예외로 죽으면 안내조차 못 한다", () => {
  assert.equal(detectContentSubdir(path.join(os.tmpdir(), "nope-does-not-exist-12345")), ".");
});

// ══ instance — 겹치면 한 레포의 스윕이 다른 레포의 지식을 아카이브한다 ══
t("W1 레포가 다르면 instance 도 다르다", () => {
  assert.notEqual(wikiInstance("lively"), wikiInstance("lively-docs"));
  assert.notEqual(wikiInstance("team-wiki"), wikiInstance("team_wiki"));
});

t("W2 대소문자만 다른 이름은 같은 칸으로 접힌다 — ensure 가 이 사실 위에서 막는다", () => {
  // 이 단언은 '접힌다'를 버그가 아니라 **알려진 성질**로 못 박는다. 슬러그를 대소문자 보존으로 바꾸면
  // 여기가 깨지고, 그때 ensure 의 충돌 가드(config.repo_path 비교)도 함께 재검토해야 한다.
  assert.equal(wikiCollectorKey("Lively"), wikiCollectorKey("lively"));
  assert.equal(wikiInstance("Lively"), wikiInstance("lively"));
});

t("W3 key 와 instance 가 같다 — 갈리면 수집기 범위와 지식 범위가 어긋난다", () => {
  for (const r of ["lively", "team-wiki", "Handbook"]) assert.equal(wikiInstance(r), wikiCollectorKey(r));
});

t("W4 경로·URL 에 넣어도 안전한 슬러그", () => {
  assert.equal(wikiCollectorKey("My Repo"), "wiki-my-repo");
  assert.equal(wikiCollectorKey("  UPPER  "), "wiki-upper");
  assert.match(wikiCollectorKey("a/b?c#d"), /^[a-z0-9._-]+$/);
  assert.equal(wikiCollectorKey("--x--"), "wiki-x", "앞뒤 구분자가 남으면 이름이 지저분해진다");
});

// ══ 클론 경로 ══
t("P1 클론 경로가 provision 이 쓰는 자리와 같다 — 다르면 수집기가 빈 폴더를 본다", () => {
  // 상수를 재진술하지 않고 **provision 의 SoT 를 그대로 임포트해** 비교한다(둘이 갈리는 순간 red).
  assert.equal(repoClonePath("lively"), path.join(PROJECT_SHARED_BASE, REPOS_SUBDIR, "lively"));
  assert.equal(repoClonePath("  lively  "), path.join(PROJECT_SHARED_BASE, REPOS_SUBDIR, "lively"));
});

console.log(`\nwiki-repo tests: ${pass} passed`);
