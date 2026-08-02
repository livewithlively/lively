// webhook.ts 모듈 스코프 순수 함수 사양 테스트(#1313 R7) — 분해 선행 안전망(export 표면·행위만).
//  사양 출처: webhook.ts 헤더/함수 주석 — HMAC fail-closed(서명 불일치=false, 절대 throw 금지),
//  gitlab 은 토큰 양측 HMAC(길이 사이드채널 제거), branch 는 refs/heads/* 만, sanitize 는 안전 세그먼트.
//  실행: npm run build && node dist/domainmap/webhook.test.js
//
// ── 입력 조합 × 기대 (엣지 표 — 행마다 테스트 ≥1) ─────────────────────────────
// [verifyWebhook]
// 1  | github + 올바른 sha256=HMAC(rawBody)                | true
// 2  | github + 내용 다른 서명(같은 길이)                   | false (timingSafeEqual 경로)
// 3  | github + 'sha256=' 접두 없음                         | false
// 4  | github + 헤더 부재(빈 경우 행)                       | false
// 5  | github + body 1바이트 다름                           | false
// 6  | gitlab + 토큰===secret                               | true
// 7  | gitlab + 오토큰(길이 무관)                            | false
// 8  | gitlab + 토큰 부재/빈 문자열(빈 경우 행)              | false
// 9  | 미지 provider('bitbucket')                           | false (fail-closed)
// [branchFromRef]
// 10 | 'refs/heads/main'                                    | 'main'
// 11 | 'refs/heads/feat/x' (슬래시 포함 브랜치)              | 'feat/x'
// 12 | 'refs/tags/v1' / 'refs/heads/'(빈 브랜치) / '' / null | null (전부)
// [parsePushEvent]
// 13 | github: repository.full_name+name                    | names=[full,short] + ref/before/after 투과
// 14 | github: repository 부재(빈 경우 행)                   | names=[]
// 15 | gitlab: project.path_with_namespace+name             | names=[full,short]
// 16 | gitlab: project 부재 / name 만                        | names=[]/[name]
// [sanitizeName]
// 17 | 'a/b', '../x', 한글/공백                              | 불허문자 전부 '_' 치환
// 18 | 허용문자만('Repo-1.x_y')                              | 원형 유지
// 19 | null/undefined/''(빈 경우 행)                         | '' (caller 가 거부)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhook, branchFromRef, parsePushEvent, sanitizeName } from "./webhook.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

const SECRET = "s3cr3t";
const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }), "utf8");
const goodSig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

// ── verifyWebhook: github ──
t("#1 github 올바른 서명 → true", () => {
  assert.equal(verifyWebhook("github", SECRET, body, { "x-hub-signature-256": goodSig }), true);
});
t("#2 github 같은 길이·다른 내용 서명 → false", () => {
  const tampered = goodSig.slice(0, -1) + (goodSig.endsWith("0") ? "1" : "0");
  assert.equal(tampered.length, goodSig.length);
  assert.equal(verifyWebhook("github", SECRET, body, { "x-hub-signature-256": tampered }), false);
});
t("#3 github 'sha256=' 접두 없음 → false", () => {
  const bare = goodSig.slice("sha256=".length);
  assert.equal(verifyWebhook("github", SECRET, body, { "x-hub-signature-256": bare }), false);
  assert.equal(verifyWebhook("github", SECRET, body, { "x-hub-signature-256": "sha1=" + bare }), false);
});
t("#4 github 서명 헤더 부재 → false", () => {
  assert.equal(verifyWebhook("github", SECRET, body, {}), false);
});
t("#5 github body 1바이트 다름 → false", () => {
  const other = Buffer.concat([body, Buffer.from(" ")]);
  assert.equal(verifyWebhook("github", SECRET, other, { "x-hub-signature-256": goodSig }), false);
});

// ── verifyWebhook: gitlab ──
t("#6 gitlab 토큰===secret → true", () => {
  assert.equal(verifyWebhook("gitlab", SECRET, body, { "x-gitlab-token": SECRET }), true);
});
t("#7 gitlab 오토큰(같은 길이·다른 길이 모두) → false", () => {
  assert.equal(verifyWebhook("gitlab", SECRET, body, { "x-gitlab-token": "x3cr3t" }), false);
  assert.equal(verifyWebhook("gitlab", SECRET, body, { "x-gitlab-token": SECRET + "x" }), false);
});
t("#8 gitlab 토큰 부재/빈 문자열 → false", () => {
  assert.equal(verifyWebhook("gitlab", SECRET, body, {}), false);
  assert.equal(verifyWebhook("gitlab", SECRET, body, { "x-gitlab-token": "" }), false);
});

// ── verifyWebhook: fail-closed ──
t("#9 미지 provider → false", () => {
  assert.equal(verifyWebhook("bitbucket", SECRET, body, { "x-hub-signature-256": goodSig }), false);
});

// ── branchFromRef ──
t("#10 refs/heads/main → 'main'", () => {
  assert.equal(branchFromRef("refs/heads/main"), "main");
});
t("#11 refs/heads/feat/x → 'feat/x'(슬래시 브랜치 전체 보존)", () => {
  assert.equal(branchFromRef("refs/heads/feat/x"), "feat/x");
});
t("#12 tags/빈 브랜치/''/null/undefined → 전부 null", () => {
  for (const bad of ["refs/tags/v1", "refs/heads/", "", null, undefined, "main"]) {
    assert.equal(branchFromRef(bad), null, `branchFromRef(${JSON.stringify(bad)})`);
  }
});

// ── parsePushEvent ──
t("#13 github: full_name+name → names 순서 [full, short] · ref/before/after 투과", () => {
  const ev = parsePushEvent("github", {
    ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40),
    repository: { full_name: "org/repo", name: "repo" },
  });
  assert.deepEqual(ev.names, ["org/repo", "repo"]);
  assert.equal(ev.ref, "refs/heads/main");
  assert.equal(ev.before, "a".repeat(40));
  assert.equal(ev.after, "b".repeat(40));
});
t("#14 github: repository 부재 → names=[]", () => {
  assert.deepEqual(parsePushEvent("github", { ref: "refs/heads/main" }).names, []);
});
t("#15 gitlab: path_with_namespace+name → names=[full, short]", () => {
  const ev = parsePushEvent("gitlab", {
    ref: "refs/heads/main", project: { path_with_namespace: "grp/repo", name: "repo" },
  });
  assert.deepEqual(ev.names, ["grp/repo", "repo"]);
});
t("#16 gitlab: project 부재 → names=[] · name 만 → [name]", () => {
  assert.deepEqual(parsePushEvent("gitlab", {}).names, []);
  assert.deepEqual(parsePushEvent("gitlab", { project: { name: "repo" } }).names, ["repo"]);
});

// ── sanitizeName ──
t("#17 불허문자('/', '..', 한글, 공백) → '_' 치환(단일 세그먼트 보장)", () => {
  assert.equal(sanitizeName("a/b"), "a_b");
  assert.equal(sanitizeName("../x"), ".._x");
  assert.equal(sanitizeName("한글 repo"), "___repo"); // 한글 2자 + 공백 1자
  assert.ok(!sanitizeName("evil/../../etc").includes("/"));
});
t("#18 허용문자([A-Za-z0-9._-])만 → 원형 유지", () => {
  assert.equal(sanitizeName("Repo-1.x_y"), "Repo-1.x_y");
});
t("#19 null/undefined/'' → ''(caller 거부용)", () => {
  assert.equal(sanitizeName(null), "");
  assert.equal(sanitizeName(undefined), "");
  assert.equal(sanitizeName(""), "");
});

console.log(`\n${pass} passed`);
