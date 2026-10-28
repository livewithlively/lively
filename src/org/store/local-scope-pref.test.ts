// 기록 범위(#5016) — 컴퓨터별 설정(org_member.local_scope_pref[machine_id])의 변경 규칙과 저장.
//  사양: 변경 하나 = 통째 교체(웹) → 더하기 → 빼기 순서. 같은 폴더는 끝 구분자 차이로 두 번 들어가지 않는다.
//  한 컴퓨터 목록은 200개까지(넘으면 거절). 저장은 그 행을 잠그고(FOR UPDATE) 그 컴퓨터 키만 바꾼다 — 웹·CLI 가 동시에 고쳐도
//  한쪽이 사라지지 않게. 구성원이 없으면 롤백하고 실패한다. 단언은 결과 값과 가짜 풀이 받은 SQL·인자로 한다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { itemsPool } from "../../db/client.js";
import { applyLocalScopeChange, updateLocalScopePreference, MAX_WORK_ROOTS, type LocalScopePreference } from "./members.js";

const base = (roots: string[] = [], scope: LocalScopePreference["scope"] = "work_folders"): LocalScopePreference => ({ scope, work_roots: roots, updated_at: "" });
const NOW = new Date("2026-10-26T09:00:00Z");

test("T1 더하기 — 목록에 붙고 범위는 그대로, 바꾼 시각이 남는다", () => {
  const r = applyLocalScopeChange(base(["/a"]), { add: ["/b"] }, NOW);
  assert.deepEqual(r.work_roots, ["/a", "/b"]);
  assert.equal(r.scope, "work_folders");
  assert.equal(r.updated_at, NOW.toISOString());
});

test("T2 순서 — 통째 교체 뒤 더하고 뺀다", () => {
  const r = applyLocalScopeChange(base(["/old"]), { work_roots: ["/x", "/y"], add: ["/z"], remove: ["/y"] }, NOW);
  assert.deepEqual(r.work_roots, ["/x", "/z"]);
});

test("T3 끝 구분자만 다른 같은 폴더는 두 번 들어가지 않는다", () => {
  assert.deepEqual(applyLocalScopeChange(base(["/a"]), { add: ["/a/"] }, NOW).work_roots, ["/a"]);
});

test("T4 빼기는 끝 구분자가 달라도 같은 폴더를 뺀다", () => {
  assert.deepEqual(applyLocalScopeChange(base(["/a/", "/b"]), { remove: ["/a"] }, NOW).work_roots, ["/b"]);
});

test("T5 범위만 바꾸면 목록은 남는다(«어디서나» 에서 돌아오면 그대로 쓴다)", () => {
  const r = applyLocalScopeChange(base(["/a"]), { scope: "anywhere" }, NOW);
  assert.equal(r.scope, "anywhere");
  assert.deepEqual(r.work_roots, ["/a"]);
});

test("T6 경계 — 200개는 받고 201개째는 거절한다", () => {
  const full = Array.from({ length: MAX_WORK_ROOTS }, (_, i) => `/r${i}`);
  assert.equal(applyLocalScopeChange(base(), { work_roots: full }, NOW).work_roots.length, MAX_WORK_ROOTS);
  assert.throws(() => applyLocalScopeChange(base(full), { add: ["/one-more"] }, NOW), /200/);
});

test("T11 등록은 절대경로·~ 로 시작하는 꼴만 받는다 — 상대경로는 거절(빼기는 받는다)", () => {
  assert.throws(() => applyLocalScopeChange(base(), { add: ["work"] }, NOW), /절대경로/);
  assert.throws(() => applyLocalScopeChange(base(), { work_roots: ["./x"] }, NOW), /절대경로/);
  for (const ok of ["~", "~/alphacut", "/abs/x", "C:\\work", "\\\\srv\\share"]) assert.doesNotThrow(() => applyLocalScopeChange(base(), { add: [ok] }, NOW), ok);
  assert.deepEqual(applyLocalScopeChange(base(["work"]), { remove: ["work"] }, NOW).work_roots, []);
});

test("T7 빈 값·너무 긴 경로는 버린다", () => {
  const r = applyLocalScopeChange(base(), { add: ["", "   ", "/ok", "/" + "x".repeat(1200)] }, NOW);
  assert.deepEqual(r.work_roots, ["/ok"]);
});

// ── 저장 — 가짜 풀로 «무엇을 잠그고 무엇을 썼나» 를 잰다 ──
function fakePool(row: unknown) {
  const log: { sql: string; params: unknown[] }[] = [];
  let released = 0;
  const pool = itemsPool as unknown as { connect: unknown };
  const had = Object.hasOwn(pool, "connect");
  const orig = pool.connect;
  pool.connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/^SELECT/i.test(sql.trim())) return { rows: row === undefined ? [] : [{ pref: row }] };
      return { rows: [] };
    },
    release: () => { released++; },
  });
  return { log, released: () => released, restore: () => { if (had) pool.connect = orig; else delete (pool as Record<string, unknown>).connect; } };
}

test("T8 저장은 그 행을 잠그고 그 컴퓨터 키만 바꾼다", async () => {
  const fp = fakePool({ scope: "work_folders", work_roots: ["/a"], updated_at: "" });
  try {
    const r = await updateLocalScopePreference("m1", "pc-1", { add: ["/b"] });
    assert.deepEqual(r.work_roots, ["/a", "/b"]);
    const sqls = fp.log.map((x) => x.sql);
    assert.equal(sqls[0], "BEGIN");
    assert.match(sqls[1], /FOR UPDATE/);
    const upd = fp.log.find((x) => /^UPDATE org_member SET local_scope_pref/.test(x.sql));
    assert.ok(upd, "UPDATE 가 없다");
    assert.equal(upd!.params[1], "pc-1");
    assert.deepEqual(JSON.parse(String(upd!.params[2])).work_roots, ["/a", "/b"]);
    assert.equal(sqls.at(-1), "COMMIT");
    assert.equal(fp.released(), 1);
  } finally { fp.restore(); }
});

test("T9 저장된 값이 없는 컴퓨터는 기본값(작업 폴더에서만)에서 시작한다", async () => {
  const fp = fakePool(null);
  try {
    const r = await updateLocalScopePreference("m1", "pc-new", { add: ["/w"] });
    assert.equal(r.scope, "work_folders");
    assert.deepEqual(r.work_roots, ["/w"]);
  } finally { fp.restore(); }
});

test("T10 구성원이 없으면 롤백하고 실패한다(연결은 돌려준다)", async () => {
  const fp = fakePool(undefined);
  try {
    await assert.rejects(() => updateLocalScopePreference("nobody", "pc-1", { add: ["/w"] }));
    assert.ok(fp.log.some((x) => x.sql === "ROLLBACK"));
    assert.ok(!fp.log.some((x) => /^UPDATE/.test(x.sql)));
    assert.equal(fp.released(), 1);
  } finally { fp.restore(); }
});
