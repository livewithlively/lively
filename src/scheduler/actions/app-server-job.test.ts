// 앱 정기 작업을 누구 이름으로 돌리나(카드 정책 #326) — runAsOf 를 사양 B 대로 본다(사양 기반 · 구현을 보지 않고 썼다). DB 없음.
//  B1 차례: params.run_as(관리자가 정한 구성원 · "run_as") → app.owner_member(앱 책임자 · "owner") → app.installed_by(설치한 사람 · "installer") → job.created_by(잡을 만든 사람 · "creator")
//  B2 빈 글 · 공백만 · null · 글이 아닌 값은 건너뛴다 · 앞뒤 공백은 떼고 쓴다
//  B3 아무도 없으면 null · app 이 null 이어도 된다
import { strict as assert } from "node:assert";
import test from "node:test";
import { runAsOf } from "./app-server-job.js";

type Args = Parameters<typeof runAsOf>;
/** 글이 아닌 값도 넣어 보려고 인자 꼴을 풀어 부른다. */
const run = (params: unknown, app: unknown, job: unknown): unknown => runAsOf(params as Args[0], app as Args[1], job as Args[2]);

test("B1 차례 — run_as → owner → installer → creator", () => {
  const app = { owner_member: "owner-m", installed_by: "installer-m" };
  const job = { created_by: "creator-m" };
  assert.deepEqual(run({ run_as: "admin-pick" }, app, job), { member: "admin-pick", via: "run_as" });
  assert.deepEqual(run({}, app, job), { member: "owner-m", via: "owner" });
  assert.deepEqual(run({}, { installed_by: "installer-m" }, job), { member: "installer-m", via: "installer" });
  assert.deepEqual(run({}, {}, job), { member: "creator-m", via: "creator" });
});

test("B1 앞 차례가 있으면 뒤 차례는 보지 않는다", () => {
  assert.deepEqual(run({ run_as: "r" }, { owner_member: "o", installed_by: "i" }, { created_by: "c" }), { member: "r", via: "run_as" });
  assert.deepEqual(run({}, { owner_member: "o", installed_by: "i" }, { created_by: "c" }), { member: "o", via: "owner" });
  assert.deepEqual(run({}, { installed_by: "i" }, { created_by: "c" }), { member: "i", via: "installer" });
});

test("B2 건너뛰는 값 — 빈 글 · 공백만 · null · 글이 아닌 값", () => {
  const skipped: unknown[] = ["", "   ", "\t\n ", null, undefined, 42, 0, true, false, {}, ["m"]];
  for (const v of skipped) {
    const label = `${typeof v} ${JSON.stringify(v)}`;
    assert.deepEqual(run({ run_as: v }, { owner_member: "o" }, { created_by: "c" }), { member: "o", via: "owner" }, `run_as ${label}`);
    assert.deepEqual(run({}, { owner_member: v, installed_by: "i" }, { created_by: "c" }), { member: "i", via: "installer" }, `owner_member ${label}`);
    assert.deepEqual(run({}, { installed_by: v }, { created_by: "c" }), { member: "c", via: "creator" }, `installed_by ${label}`);
    assert.equal(run({}, {}, { created_by: v }), null, `created_by ${label}`);
  }
});

test("B2 건너뛰면 그다음 차례로 끝까지 내려간다", () => {
  assert.deepEqual(run({ run_as: "  " }, { owner_member: "", installed_by: null }, { created_by: "c" }), { member: "c", via: "creator" });
  assert.deepEqual(run({ run_as: 7 }, { owner_member: {}, installed_by: "i" }, { created_by: "c" }), { member: "i", via: "installer" });
});

test("B2 앞뒤 공백은 떼고 쓴다", () => {
  assert.deepEqual(run({ run_as: "  alice \n" }, null, {}), { member: "alice", via: "run_as" });
  assert.deepEqual(run({}, { owner_member: " bob " }, {}), { member: "bob", via: "owner" });
  assert.deepEqual(run({}, { installed_by: "\tcarol" }, {}), { member: "carol", via: "installer" });
  assert.deepEqual(run({}, null, { created_by: "dave  " }), { member: "dave", via: "creator" });
});

test("B3 아무도 없으면 null · app 이 null 이어도 된다", () => {
  assert.equal(run({}, null, {}), null);
  assert.equal(run({}, {}, {}), null);
  assert.equal(run({ run_as: "" }, { owner_member: " ", installed_by: null }, { created_by: undefined }), null);
  assert.deepEqual(run({ run_as: "x" }, null, {}), { member: "x", via: "run_as" });
  assert.deepEqual(run({}, null, { created_by: "c" }), { member: "c", via: "creator" });
});
