// #697 미러 멤버 재해소 순수 로직 유닛테스트 — DB 불요(순수 함수).
//   실행: npm run build && node dist/v6/member-resolve.test.js
//   커버: (a) person_identity.email 역매칭(via=identity 소급의 핵심), (b) external_id/email 매칭, (c) 우선순위,
//         (d) 멱등(이미 member_id·미매칭 raw 불변), (e) 배열 재해소·순서보존·dedup·no-op(null).
import assert from "node:assert/strict";
import { buildMemberResolver, reresolveMemberList } from "./member-resolve.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 고객사 A 실데이터 형태의 매핑 소스.
const identities = [
  { external_id: "5776468", email: "namjo.yoon@example.com", member_id: "namjo-yoon" }, // via=identity(관리탭 수동 매핑)
  { external_id: "216133775", email: "admin@example.com", member_id: "daon" },
];
const memberEmails = [
  { email: "lively1@example.com", id: "lively1" }, // via=email(org_member.email 자동매칭)
  { email: "daon@example.com", id: "daon" },
];

t("buildMemberResolver: person_identity.email 역매칭(#697 via=identity 핵심)", () => {
  const r = buildMemberResolver(identities, memberEmails);
  // raw 이메일(org_member.email 과 다른 ClickUp 이메일)이 person_identity.email 로 해소 — 소급의 핵심 경로.
  assert.equal(r("namjo.yoon@example.com"), "namjo-yoon");
  assert.equal(r("NAMJO.YOON@example.com"), "namjo-yoon"); // 대소문자 무시
  assert.equal(r("5776468"), "namjo-yoon");                  // ClickUp 숫자 id(external_id)
});

t("buildMemberResolver: org_member.email 직접 매칭(②)", () => {
  const r = buildMemberResolver(identities, memberEmails);
  assert.equal(r("lively1@example.com"), "lively1");
});

t("buildMemberResolver: 이미 member_id(슬러그)·미매칭 raw 는 불변(멱등·손실0)", () => {
  const r = buildMemberResolver(identities, memberEmails);
  assert.equal(r("daon"), "daon");                          // 이미 org_member.id
  assert.equal(r("namjo-yoon"), "namjo-yoon");              // 이미 해소됨
  assert.equal(r("ghost@nowhere.io"), "ghost@nowhere.io");  // 매핑 없는 raw 보존
  assert.equal(r("99999999"), "99999999");                  // 매핑 없는 숫자 id
  assert.equal(r(""), "");
});

t("buildMemberResolver: 우선순위 person_identity > org_member.email", () => {
  const r = buildMemberResolver(
    [{ external_id: "999", email: "shared@x.com", member_id: "from-identity" }],
    [{ email: "shared@x.com", id: "from-email" }],
  );
  assert.equal(r("shared@x.com"), "from-identity");
});

t("reresolveMemberList: 치환 발생 → 새 배열(순서 보존)", () => {
  const r = buildMemberResolver(identities, memberEmails);
  assert.deepEqual(reresolveMemberList(["namjo.yoon@example.com", "lively1@example.com"], r),
    ["namjo-yoon", "lively1"]);
  assert.deepEqual(reresolveMemberList(["lively1@example.com", "5776468"], r),
    ["lively1", "namjo-yoon"]); // 순서 보존
});

t("reresolveMemberList: 변화 없으면 null(이미 해소·미매칭·빈배열)", () => {
  const r = buildMemberResolver(identities, memberEmails);
  assert.equal(reresolveMemberList(["namjo-yoon", "daon"], r), null); // 이미 member_id
  assert.equal(reresolveMemberList(["ghost@nowhere.io"], r), null);   // 미매칭
  assert.equal(reresolveMemberList([], r), null);
});

t("reresolveMemberList: 서로 다른 raw 가 같은 member 로 → dedup(축약, non-null)", () => {
  const r = buildMemberResolver(identities, memberEmails);
  // email 과 숫자 id 둘 다 namjo-yoon → 1개로 축약.
  assert.deepEqual(reresolveMemberList(["namjo.yoon@example.com", "5776468"], r), ["namjo-yoon"]);
});

console.log(`\n${pass} passed (#697 member re-resolve)`);
