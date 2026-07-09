// per-user 자격 vault(P1, #746) 단위 체크 — kind/scope_key 정규화(순수). 저장·해소 체인은 실 pg 통합(scripts/integration/member-secret-pg.mjs).
// 실행: npm run build && node dist/org/member-secret-store.test.js
import assert from "node:assert/strict";
import { normalizeKind, normalizeScopeKey, memberOwner, GATEWAY_OWNER } from "./member-secret-store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("normalizeKind: 소문자·숫자·_ 통과, 대문자 소문자화", () => {
  assert.equal(normalizeKind("gitlab_pat"), "gitlab_pat");
  assert.equal(normalizeKind("Slack_User_Token"), "slack_user_token");
});
t("normalizeKind: 형식 위반 throw(공백·특수문자·빈값·과길이)", () => {
  for (const bad of ["", "a b", "kind!", "has-dash", "x".repeat(41)]) {
    assert.throws(() => normalizeKind(bad), /kind 형식 오류/, `should reject: ${bad}`);
  }
});
t("normalizeScopeKey: 빈값(단일) 허용, host/account 형태 통과", () => {
  assert.equal(normalizeScopeKey(""), "");
  assert.equal(normalizeScopeKey(undefined), "");
  assert.equal(normalizeScopeKey("git.honestfund.kr"), "git.honestfund.kr");
  assert.equal(normalizeScopeKey("425515538094:ap-northeast-2"), "425515538094:ap-northeast-2");
});
t("normalizeScopeKey: 인젝션 표면 문자 throw(공백·슬래시·따옴표)", () => {
  for (const bad of ["a b", "a/b", "a'b", "x".repeat(121)]) {
    assert.throws(() => normalizeScopeKey(bad), /scope_key 형식 오류/, `should reject: ${bad}`);
  }
});
t("owner 헬퍼", () => {
  assert.equal(memberOwner("u1"), "member:u1");
  assert.equal(GATEWAY_OWNER, "gateway");
});

console.log(`\nmember-secret-store tests: ${pass} passed`);
