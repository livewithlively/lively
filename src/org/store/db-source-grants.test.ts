// DB 소스 지정의 DB 없는 부분 (#5799) — 대상 목록 정리, 그리고 DB 를 읽지 않고 답이 나는 판정 갈래.
//  실제 지정 · 팀 구성원으로 푸는 판정은 db-source-grants.pg-test.mjs 가 잰다.
//  ★ 이 시험은 ITEMS_DATABASE_URL 없이 돈다 — 여기서 통과하는 판정은 DB 를 읽지 않았다는 뜻이다(읽으면 연결 오류로 던진다).
//
//  엣지 표:
//   D1 대상 정리 — 모르는 종류 · 빈 id · null 은 버린다 · 같은 대상은 한 번만 · 숫자 id 는 글로 · 순서는 들어온 대로
//   D2 옛 구성원 — 종전 그대로: db 가 있으면 전 소스 · 없으면 불가 · 내장 self 는 admin
//   D3 역할 구성원 · DB 조회 자격 없음 → 지정을 보지도 않고 불가
//   D4 역할 구성원 · 내장 self → 관리 고치기가 있을 때만(DB 자격 · 지정과 무관)
//   D5 거절 문구는 종전 꼴
//   D6 배선 — DB 도구 셋(db_sources · db_schema · db_query)이 이 판정을 쓴다(옛 동기 판정을 직접 부르지 않는다)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeSubjects, dbSourceAllowed, requireDbSourceAccess } from "./db-source-grants.js";
import type { LivelyUser } from "../../context.js";
import { ROLE_GRANTS } from "../../auth/permissions.js";

const user = (over: Partial<LivelyUser>): LivelyUser => ({ userId: "u1", email: "", scopes: [], projects: ["*"], ...over });

test("D1 대상 목록 정리", () => {
  assert.deepEqual(normalizeSubjects([
    { kind: "member", id: "alice" }, { kind: "team", id: 4 }, { kind: "member", id: " alice " }, { kind: "team", id: "4" },
    { kind: "group", id: "x" }, { kind: "member", id: "" }, { kind: "member", id: "   " }, { kind: "member" }, { id: "bob" },
    { kind: "member", id: null }, { kind: "member", id: {} }, { kind: "member", id: "bob" },
  ]), [{ kind: "member", id: "alice" }, { kind: "team", id: "4" }, { kind: "member", id: "bob" }]);
  assert.deepEqual(normalizeSubjects([]), []);
  assert.deepEqual(normalizeSubjects(null), []);
  assert.deepEqual(normalizeSubjects(undefined), []);
  // 같은 id 라도 종류가 다르면 다른 대상이다
  assert.deepEqual(normalizeSubjects([{ kind: "member", id: "7" }, { kind: "team", id: "7" }]), [{ kind: "member", id: "7" }, { kind: "team", id: "7" }]);
});

test("D2 옛 구성원은 종전 그대로다(지정 표를 보지 않는다)", async () => {
  assert.equal(await dbSourceAllowed(user({ scopes: ["db"] }), "crm"), true);
  assert.equal(await dbSourceAllowed(user({ scopes: ["db"] }), "anything-else"), true);
  assert.equal(await dbSourceAllowed(user({ scopes: ["memory", "context", "items", "code"] }), "crm"), false);
  assert.equal(await dbSourceAllowed(user({ scopes: ["admin"] }), "crm"), false);
  assert.equal(await dbSourceAllowed(user({ scopes: ["admin"] }), "self"), true, "내장 self 는 admin 에게");
  assert.equal(await dbSourceAllowed(user({ scopes: ["memory"] }), "self"), false);
  assert.equal(await dbSourceAllowed(user({ scopes: ["db"], grants: undefined }), "crm"), true);
});

test("D3 역할 구성원에게 DB 조회 자격이 없으면 지정을 보지도 않고 불가", async () => {
  assert.equal(await dbSourceAllowed(user({ scopes: ["db"], grants: ROLE_GRANTS.guest }), "crm"), false, "사본 scopes 의 db 로 열리지 않는다");
  assert.equal(await dbSourceAllowed(user({ scopes: ["db"], grants: {} }), "crm"), false);
  assert.equal(await dbSourceAllowed(user({ scopes: ["db"], grants: { content: "write", admin: "write" } }), "crm"), false, "관리자여도 자격이 없으면 불가");
});

test("D4 역할 구성원의 내장 self — 관리 고치기가 있으면 열리고, 없으면 «모든 소스» 지정을 본다", async () => {
  assert.equal(await dbSourceAllowed(user({ grants: ROLE_GRANTS.owner }), "self"), true);
  assert.equal(await dbSourceAllowed(user({ grants: ROLE_GRANTS.admin }), "self"), true);
  assert.equal(await dbSourceAllowed(user({ grants: { admin: "read", content: "write" } }), "self"), false, "DB 조회 자격이 없으면 지정을 보지도 않고 닫힌다");
  //  DB 조회 자격이 있으면 «모든 소스» 지정이 있는지 표를 읽는다(옛 db 가 self 도 열었던 것을 잇는다 — 실제 판정은 auth/role-migration.pg-test A14).
  //   이 시험에는 DB 가 없어 그 조회가 던진다 = 닫힌 쪽이다(지정을 확인하지 못하면 열지 않는다).
  await assert.rejects(() => dbSourceAllowed(user({ grants: ROLE_GRANTS.member }), "self"));
  await assert.rejects(() => dbSourceAllowed(user({ grants: { admin: "read", db: "read" } }), "self"));
});

test("D5 거절 문구는 종전 꼴이다", async () => {
  await assert.rejects(() => requireDbSourceAccess(user({ userId: "carol", scopes: ["memory"] }), "crm"), /^Error: Forbidden: user 'carol' lacks db access to source 'crm'$/);
  await assert.doesNotReject(() => requireDbSourceAccess(user({ scopes: ["db"] }), "crm"));
});

test("D6 배선 — DB 도구가 소스별 지정까지 보는 판정을 쓴다", () => {
  const SRC_ROOT = new URL("../../", import.meta.url).pathname.replace("/dist/", "/src/");
  const code = readFileSync(path.join(SRC_ROOT, "tools/db.ts"), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.equal((code.match(/await requireDbSourceAccess\(user, src\)/g) ?? []).length, 2, "db_schema · db_query 가 소스마다 판정한다");
  assert.match(code, /allowed: await dbSourceAllowed\(user, s\.name\)/, "db_sources 의 allowed 표시도 같은 판정이다");
  assert.doesNotMatch(code, /\brequireDbSource\(|\bcanAccessDbSource\(/, "옛 동기 판정을 직접 부르면 역할 구성원에게 지정이 안 걸린다");
});
