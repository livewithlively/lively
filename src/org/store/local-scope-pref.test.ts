// 기록 범위(#5016 → 조직 기본값) — 구성원 컴퓨터별 오버라이드(org_member.local_scope_pref[machine_id])의 변경 규칙 · 유효 값 · 저장.
//  사양: 방식(scope)은 조직이 정하고 컴퓨터는 목록만 바꾼다. 목록마다 «이 컴퓨터 줄 통째 교체(웹) → 더하기 → 빼기» 순서.
//  조직 줄은 지울 수 없다 — 빼면 이 컴퓨터에서만 끄고, 끈 조직 줄을 더하면 다시 켠다. 허용 목록·제외 목록은 따로 다룬다.
//  같은 폴더는 끝 구분자 차이로 두 번 들어가지 않는다. 한 컴퓨터 목록은 200개까지(넘으면 거절).
//  저장은 그 행을 잠그고(FOR UPDATE) 그 컴퓨터 키만 바꾼다 — 웹·CLI 가 동시에 고쳐도 한쪽이 사라지지 않게. 구성원이 없으면 롤백하고 실패한다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { itemsPool } from "../../db/client.js";
import { applyLocalScopeChange, updateLocalScopePreference, MAX_WORK_ROOTS, type LocalScopePreference } from "./members.js";
import { localScopeView, parseScopePref, parseOrgRecordScope, defaultScopePref, type OrgRecordScope } from "./record-scope.js";

const base = (roots: string[] = [], more: Partial<LocalScopePreference> = {}): LocalScopePreference => ({ ...defaultScopePref(), work_roots: roots, ...more });
const NOW = new Date("2026-10-26T09:00:00Z");
const org = (o: Partial<OrgRecordScope> = {}): OrgRecordScope => ({ scope: "work_folders", work_roots: [], exclude_roots: [], updated_at: "", ...o });
const NO_ORG = org();

test("T1 더하기 — 목록에 붙고 바꾼 시각이 남는다", () => {
  const r = applyLocalScopeChange(base(["/a"]), { add: ["/b"] }, NO_ORG, NOW);
  assert.deepEqual(r.work_roots, ["/a", "/b"]);
  assert.equal(r.updated_at, NOW.toISOString());
});

test("T2 순서 — 통째 교체 뒤 더하고 뺀다", () => {
  const r = applyLocalScopeChange(base(["/old"]), { work_roots: ["/x", "/y"], add: ["/z"], remove: ["/y"] }, NO_ORG, NOW);
  assert.deepEqual(r.work_roots, ["/x", "/z"]);
});

test("T3 끝 구분자만 다른 같은 폴더는 두 번 들어가지 않는다", () => {
  assert.deepEqual(applyLocalScopeChange(base(["/a"]), { add: ["/a/"] }, NO_ORG, NOW).work_roots, ["/a"]);
});

test("T4 빼기는 끝 구분자가 달라도 같은 폴더를 뺀다", () => {
  assert.deepEqual(applyLocalScopeChange(base(["/a/", "/b"]), { remove: ["/a"] }, NO_ORG, NOW).work_roots, ["/b"]);
});

test("T5 ★ 방식(scope)은 컴퓨터가 못 바꾼다 — 보내도 그대로, 목록도 그대로", () => {
  const r = applyLocalScopeChange(base(["/a"]), { scope: "anywhere" }, NO_ORG, NOW);
  assert.equal(r.scope, "work_folders");
  assert.deepEqual(r.work_roots, ["/a"]);
  //  유효 값의 방식은 언제나 조직 것이다 — 옛 판이 저장한 «어디서나» 가 남아 있어도.
  assert.equal(localScopeView(org({ scope: "work_folders" }), base([], { scope: "anywhere" })).scope, "work_folders");
  assert.equal(localScopeView(org({ scope: "anywhere" }), base([], { scope: "work_folders" })).scope, "anywhere");
});

test("T6 경계 — 200개는 받고 201개째는 거절한다", () => {
  const full = Array.from({ length: MAX_WORK_ROOTS }, (_, i) => `/r${i}`);
  assert.equal(applyLocalScopeChange(base(), { work_roots: full }, NO_ORG, NOW).work_roots.length, MAX_WORK_ROOTS);
  assert.throws(() => applyLocalScopeChange(base(full), { add: ["/one-more"] }, NO_ORG, NOW), /200/);
  assert.throws(() => applyLocalScopeChange(base([], { exclude_roots: full }), { exclude_add: ["/one-more"] }, NO_ORG, NOW), /200/);
});

test("T11 등록은 절대경로·~ 로 시작하는 꼴만 받는다 — 상대경로는 거절(빼기는 받는다)", () => {
  assert.throws(() => applyLocalScopeChange(base(), { add: ["work"] }, NO_ORG, NOW), /절대경로/);
  assert.throws(() => applyLocalScopeChange(base(), { work_roots: ["./x"] }, NO_ORG, NOW), /절대경로/);
  assert.throws(() => applyLocalScopeChange(base(), { exclude_add: ["tmp"] }, NO_ORG, NOW), /절대경로/);
  for (const ok of ["~", "~/alphacut", "/abs/x", "C:\\work", "\\\\srv\\share"]) assert.doesNotThrow(() => applyLocalScopeChange(base(), { add: [ok] }, NO_ORG, NOW), ok);
  assert.deepEqual(applyLocalScopeChange(base(["work"]), { remove: ["work"] }, NO_ORG, NOW).work_roots, []);
});

test("T7 빈 값·너무 긴 경로는 버린다", () => {
  const r = applyLocalScopeChange(base(), { add: ["", "   ", "/ok", "/" + "x".repeat(1200)] }, NO_ORG, NOW);
  assert.deepEqual(r.work_roots, ["/ok"]);
});

// ── 조직 줄 오버라이드 ──
test("T12 ★ 조직 줄을 빼면 이 컴퓨터에서만 꺼진다 — 조직 목록은 그대로, 유효 목록에서만 빠진다", () => {
  const o = org({ work_roots: ["~/company", "/srv/repo"] });
  const r = applyLocalScopeChange(base(["/mine"]), { remove: ["~/company"] }, o, NOW);
  assert.deepEqual(r.work_roots, ["/mine"]);
  assert.deepEqual(r.off_work_roots, ["~/company"]);
  const v = localScopeView(o, r);
  assert.deepEqual(v.work_roots, ["/srv/repo", "/mine"]);
  assert.deepEqual(v.off_roots, ["~/company"]);
  assert.deepEqual(v.entries.work_roots, [
    { path: "~/company", origin: "org", on: false },
    { path: "/srv/repo", origin: "org", on: true },
    { path: "/mine", origin: "own", on: true },
  ]);
});

test("T13 끈 조직 줄을 다시 더하면 켜진다 — 이 컴퓨터 줄로 복제하지 않는다", () => {
  const o = org({ work_roots: ["~/company"] });
  const off = applyLocalScopeChange(base(), { remove: ["~/company"] }, o, NOW);
  const back = applyLocalScopeChange(off, { add: ["~/company/"] }, o, NOW);
  assert.deepEqual(back.off_work_roots, []);
  assert.deepEqual(back.work_roots, []);
  assert.deepEqual(localScopeView(o, back).work_roots, ["~/company"]);
});

test("T14 제외 목록도 같은 규칙 — 내 제외 줄 더하기·빼기, 조직 제외 줄 끄기·켜기", () => {
  const o = org({ scope: "anywhere", exclude_roots: ["~/personal"] });
  let p = applyLocalScopeChange(base(), { exclude_add: ["/tmp/scratch"] }, o, NOW);
  assert.deepEqual(localScopeView(o, p).exclude_roots, ["~/personal", "/tmp/scratch"]);
  p = applyLocalScopeChange(p, { exclude_remove: ["~/personal"] }, o, NOW);
  assert.deepEqual(p.off_exclude_roots, ["~/personal"]);
  const v = localScopeView(o, p);
  assert.deepEqual(v.exclude_roots, ["/tmp/scratch"]);
  assert.deepEqual(v.off_roots, [], "off_roots 는 작업 폴더(허용 목록)의 끈 조직 줄만 — 제외 목록은 설치 파일 사본이 없다");
  p = applyLocalScopeChange(p, { exclude_add: ["~/personal"], exclude_remove: ["/tmp/scratch"] }, o, NOW);
  assert.deepEqual(localScopeView(o, p).exclude_roots, ["~/personal"]);
});

test("T15 두 목록은 섞이지 않는다 — 허용 목록 변경이 제외 목록을 건드리지 않고 그 반대도 같다", () => {
  const o = org({ work_roots: ["/w"], exclude_roots: ["/x"] });
  const p = applyLocalScopeChange(base(["/a"], { exclude_roots: ["/b"] }), { remove: ["/x"], exclude_remove: ["/w"] }, o, NOW);
  assert.deepEqual(p.off_work_roots, [], "제외 목록의 /x 를 허용 목록 빼기로 끄지 않는다");
  assert.deepEqual(p.off_exclude_roots, []);
  assert.deepEqual([p.work_roots, p.exclude_roots], [["/a"], ["/b"]]);
});

test("T16 조직에서 없어진 줄의 «끔» 은 다음 저장 때 걷는다 — 다시 넣었을 때 옛 끄기가 몰래 살아나지 않게", () => {
  const p = applyLocalScopeChange(base(), { remove: ["/gone"] }, org({ work_roots: ["/gone", "/stay"] }), NOW);
  assert.deepEqual(p.off_work_roots, ["/gone"]);
  const after = applyLocalScopeChange(p, { add: ["/new"] }, org({ work_roots: ["/stay"] }), NOW);
  assert.deepEqual(after.off_work_roots, []);
});

test("T17 저장값 읽기 — 옛 판 값(scope·work_roots 만)도 읽고, scope 가 없거나 잡값이어도 목록은 살린다", () => {
  assert.deepEqual(parseScopePref({ scope: "anywhere", work_roots: ["/a"], updated_at: "t" }),
    { scope: "anywhere", work_roots: ["/a"], exclude_roots: [], off_work_roots: [], off_exclude_roots: [], updated_at: "t" });
  assert.deepEqual(parseScopePref({ work_roots: ["/a"] })?.work_roots, ["/a"]);
  assert.equal(parseScopePref({ scope: "bogus" })?.scope, "work_folders");
  assert.equal(parseScopePref(null), null);
  assert.equal(parseScopePref([1]), null);
});

test("T18 조직 값 읽기 — 빈 칸·잡값은 «작업 폴더에서만 · 빈 목록»(이 칸이 생기기 전 동작), 시각은 ISO 로", () => {
  assert.deepEqual(parseOrgRecordScope({}, [], null), { scope: "work_folders", work_roots: [], exclude_roots: [], updated_at: "" });
  const at = new Date("2026-11-11T01:02:03Z");
  assert.deepEqual(parseOrgRecordScope({ scope: "anywhere", exclude_roots: ["~/p", "~/p/"] }, ["/w", 3, ""], at),
    { scope: "anywhere", work_roots: ["/w", "3"], exclude_roots: ["~/p"], updated_at: at.toISOString() });
  assert.equal(parseOrgRecordScope({ scope: "everywhere" }, null, "x").scope, "work_folders");
});

test("T19 유효 값의 시각은 조직·이 컴퓨터 중 늦은 것 — 키트가 «더 새 사본을 옛 응답으로 덮지 않기» 를 그 값으로 잰다", () => {
  const v1 = localScopeView(org({ updated_at: "2026-11-11T00:00:00.000Z" }), base([], { updated_at: "2026-11-10T00:00:00.000Z" }));
  assert.equal(v1.updated_at, "2026-11-11T00:00:00.000Z");
  const v2 = localScopeView(org({ updated_at: "2026-11-11T00:00:00.000Z" }), base([], { updated_at: "2026-11-12T00:00:00.000Z" }));
  assert.equal(v2.updated_at, "2026-11-12T00:00:00.000Z");
  assert.equal(localScopeView(org(), null).updated_at, "");
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

test("T9 저장된 값이 없는 컴퓨터는 빈 오버라이드에서 시작한다", async () => {
  const fp = fakePool(null);
  try {
    const r = await updateLocalScopePreference("m1", "pc-new", { add: ["/w"] });
    assert.equal(r.scope, "work_folders", "옛 판으로 되돌려도 읽히게 scope 를 함께 저장한다");
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

test("T20 저장은 조직 값을 받아 조직 줄 빼기를 «이 컴퓨터에서 끔» 으로 남긴다", async () => {
  const fp = fakePool({ scope: "work_folders", work_roots: [], updated_at: "" });
  try {
    const r = await updateLocalScopePreference("m1", "pc-1", { remove: ["~/company"] }, { scope: "work_folders", work_roots: ["~/company"], exclude_roots: [], updated_at: "" });
    assert.deepEqual(r.off_work_roots, ["~/company"]);
    const upd = fp.log.find((x) => /^UPDATE org_member SET local_scope_pref/.test(x.sql));
    assert.deepEqual(JSON.parse(String(upd!.params[2])).off_work_roots, ["~/company"]);
  } finally { fp.restore(); }
});
