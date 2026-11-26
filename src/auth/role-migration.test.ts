// 옛 방식 구성원을 역할로 옮기는 계획 (#5799) — planMemberMigration · planMigration · diffGrants(순수).
//  저장(역할 · DB 소스 지정)은 auth/role-migration.pg-test.mjs 가 잰다. 여기는 «누가 어느 역할로 가고 무엇을 얻고 잃는가» 의 규칙만.
//
//  엣지 표(입력 scopes → 기대):
//   T1 이미 역할인 구성원                         → 계획에서 빠진다(planMigration) · 단건은 skip='already-role'
//   T2 scopes 없음 · 모르는 이름뿐                → 옮기지 않는다(skip='no-permissions' · role null) — 게스트도 맥락 보기를 주므로 넓어진다
//   T3 기본 다섯(items·context·memory·db·code)    → 구성원 · 개별 권한 없음 · 얻는 것 = 하네스 설정 보기뿐 · 잃는 것 = 코드 고치기→보기 · DB 는 «모든 소스»('*' — 앞으로 등록될 소스까지)
//   T4 옛 기본 셋(items·context·memory)           → 구성원 · 얻는 것 = DB 조회 자격 · 하네스 설정 보기(둘 다 무해) · DB 소스는 지정하지 않는다
//   T5 items·context 둘뿐                         → 구성원이면 수집 · 증류와 세션을 새로 얻으므로 «직접 고른 권한»(게스트 + 지금 권한) · 얻는 것 · 잃는 것 없음
//   T6 다섯 + admin                               → 관리자 · 잃는 것 = 자격 고치기→보기 · 코드 고치기는 그대로
//   T7 items·context·memory·admin·runtime         → 소유자 · 잃는 것 없음 · 얻는 것 = DB 조회 자격뿐 · DB 소스는 지정하지 않는다
//   T8 keep                                       → 잃을 것을 개별 권한으로 얹는다(구성원 + 코드 고치기 · 관리자 + 자격 고치기) · 잃는 것 없음
//   T9 db:<소스>                                  → 그 소스만 지정 · 등록되지 않은 이름은 버린다 · db 가 함께 있으면 «모든 소스» · 등록된 소스가 0개여도 db 는 «모든 소스»
//   T10 runtime 뿐 · items 뿐(맥락 보기가 없던 구성원) → «직접 고른 권한» · 맥락 보기를 얻는다고 **보고한다**(역할의 바닥이라 피할 수 없다)
//   T11 admin 뿐                                  → 관리자(얻는 것이 많아도 관리자는 관리자다) · 얻는 것에 맥락이 보인다
//   T12 diffGrants                                → 올라간 것 · 내려간 것 · 같은 것은 없음 · 권한 순서대로
//   T13 계획의 결과는 항상 «역할 ∪ 개별 권한» 이고, 개별 권한은 역할이 주는 것보다 높은 것뿐이다(전 조합 128가지)
//   T14 «직접 고른 권한» 과 keep 은 아무것도 잃지 않는다 · 위험 권한(관리 · 자격 · 하네스 설정)의 고치기를 새로 얻는 계획은 없다(전 조합)
//   T15 selectPlans — ids 만 → 그 순서대로 · all 만 → 전원 · 둘 다 없음 / 둘 다 줌 → 거절 · 모르는 id 가 하나라도 있으면 전부 거절 · 겹친 id 는 한 번 · 빈 문자열은 없는 것
import test from "node:test";
import assert from "node:assert/strict";
import { planMemberMigration, planMigration, diffGrants, selectPlans, ALL_SOURCES } from "./role-migration.js";
import { ALL_DB_SOURCES } from "../org/store/db-source-grants.js";
import { ROLE_GRANTS, DANGEROUS_PERMISSIONS, legacyScopesToGrants, mergeGrants, type Grants } from "./permissions.js";
import { SCOPES } from "./scopes.js";

const FIVE = ["items", "context", "memory", "db", "code"];
const SOURCES = ["crm", "erp"];
const ALL = ["*"];   // «모든 소스» 지정 — 옛 db 는 지금 있는 소스와 앞으로 등록될 소스까지 전부였다
const plan = (scopes: string[], keep = false) => planMemberMigration({ id: "m", role: null, scopes }, { sources: SOURCES, keep });
const names = (cs: Array<{ perm: string; from: string | null; to: string | null }>): string[] => cs.map((c) => `${c.perm}:${c.from ?? "-"}>${c.to ?? "-"}`);

test("T1 이미 역할인 구성원은 계획에서 빠진다", () => {
  assert.equal(planMemberMigration({ id: "a", role: "member", scopes: FIVE }).skip, "already-role");
  const ps = planMigration([{ id: "a", role: "guest", scopes: [] }, { id: "b", role: null, scopes: FIVE }], { sources: SOURCES });
  assert.deepEqual(ps.map((p) => p.id), ["b"]);
});

test("T2 권한이 없는 구성원은 옮기지 않는다", () => {
  for (const scopes of [[], ["nope"], ["db:"]]) {
    const p = plan(scopes);
    assert.equal(p.role, null, JSON.stringify(scopes));
    assert.equal(p.skip, "no-permissions");
    assert.deepEqual(p.dbSources, []);
  }
  assert.equal(planMemberMigration({ id: "x" }).skip, "no-permissions", "scopes 칸이 없는 행");
  assert.equal(planMigration([{ id: "x", role: null, scopes: [] }]).length, 1, "까닭과 함께 계획에 남는다");
});

test("T3 기본 다섯은 구성원 역할로 간다", () => {
  const p = plan(FIVE);
  assert.equal(p.role, "member");
  assert.equal(p.custom, false);
  assert.deepEqual(p.grants, {});
  assert.deepEqual(names(p.gains), ["harness:->read"]);
  assert.deepEqual(names(p.losses), ["code:write>read"]);
  assert.deepEqual(p.dbSources, ALL, "옛 db 는 모든 소스 — 등록된 소스를 하나씩 적지 않는다");
  assert.equal(p.skip, null);
});

test("T4 옛 기본 셋은 구성원 역할로 가고 DB 소스는 지정하지 않는다", () => {
  const p = plan(["items", "context", "memory"]);
  assert.equal(p.role, "member");
  assert.equal(p.custom, false);
  assert.deepEqual(names(p.gains).sort(), ["db:->read", "harness:->read"]);
  assert.deepEqual(p.dbSources, [], "조회하던 것이 없으니 지정할 것도 없다");
});

test("T5 구성원 역할이 넓히면 지금 권한을 그대로 얹는다", () => {
  const p = plan(["items", "context"]);
  assert.equal(p.role, "guest");
  assert.equal(p.custom, true);
  assert.deepEqual(p.grants, { content: "write", external: "write", code: "write", run: "write" });
  assert.deepEqual(p.gains, []);
  assert.deepEqual(p.losses, []);
  assert.deepEqual(p.dbSources, []);
});

test("T6 admin 이 있으면 관리자 — 자격 고치기를 잃는다", () => {
  const p = plan([...FIVE, "admin"]);
  assert.equal(p.role, "admin");
  assert.deepEqual(p.grants, {});
  assert.deepEqual(names(p.losses), ["secrets:write>read"]);
  assert.deepEqual(names(p.gains), ["harness:->read"]);
  assert.deepEqual(p.dbSources, ALL);
});

test("T7 admin + runtime 은 소유자 — 잃는 것이 없다", () => {
  const p = plan(["items", "context", "memory", "admin", "runtime"]);
  assert.equal(p.role, "owner");
  assert.deepEqual(p.losses, []);
  assert.deepEqual(names(p.gains), ["db:->read"]);
  assert.deepEqual(p.dbSources, [], "db 가 없던 구성원에게 소스를 열지 않는다");
});

test("T8 keep 은 잃을 것을 개별 권한으로 남긴다", () => {
  const m = plan(FIVE, true);
  assert.equal(m.role, "member");
  assert.deepEqual(m.grants, { code: "write" });
  assert.deepEqual(m.losses, []);
  const a = plan([...FIVE, "admin"], true);
  assert.equal(a.role, "admin");
  assert.deepEqual(a.grants, { secrets: "write" });
  assert.deepEqual(a.losses, []);
  assert.deepEqual(plan(["items", "context", "memory", "admin", "runtime"], true).grants, {}, "소유자에게는 얹을 것이 없다");
});

test("T9 db:<소스> 는 그 소스만 지정한다", () => {
  assert.deepEqual(plan(["items", "context", "memory", "db:erp"]).dbSources, ["erp"]);
  assert.deepEqual(plan(["items", "context", "memory", "db:gone", "db:crm"]).dbSources, ["crm"], "등록되지 않은 이름은 버린다");
  assert.deepEqual(plan(["items", "context", "memory", "db", "db:erp"]).dbSources, ALL, "db 가 함께 있으면 모든 소스");
  assert.deepEqual(planMemberMigration({ id: "m", scopes: FIVE }).dbSources, ALL, "등록된 소스가 없어도 모든 소스 — 나중에 등록되는 소스를 본다");
  assert.deepEqual(planMemberMigration({ id: "m", scopes: ["items", "db:crm", "db:crm"] }, { sources: ["crm", "crm"] }).dbSources, ["crm"], "겹친 이름은 한 번");
  assert.deepEqual(planMemberMigration({ id: "m", scopes: ["items", "db:crm"] }).dbSources, [], "등록되지 않은 소스 이름은 지정하지 않는다");
  assert.equal(ALL_SOURCES, ALL_DB_SOURCES, "계획의 «모든 소스» 와 저장 계층의 값이 같다");
});

test("T10 맥락 보기가 없던 구성원 — 직접 고른 권한이고 맥락 보기를 얻는다고 보고한다", () => {
  const r = plan(["runtime"]);
  assert.equal(r.role, "guest");
  assert.equal(r.custom, true);
  assert.deepEqual(r.grants, { harness: "write" });
  assert.deepEqual(names(r.gains), ["content:->read"]);
  assert.deepEqual(r.losses, []);
  const i = plan(["items"]);
  assert.equal(i.custom, true);
  assert.deepEqual(i.grants, { external: "write" });
  assert.deepEqual(names(i.gains), ["content:->read"]);
  const d = plan(["db"]);
  assert.deepEqual(d.grants, { db: "read" });
  assert.deepEqual(d.dbSources, ALL);
});

test("T11 admin 뿐이어도 관리자다", () => {
  const p = plan(["admin"]);
  assert.equal(p.role, "admin");
  assert.equal(p.custom, false);
  assert.ok(names(p.gains).includes("content:->write"), names(p.gains).join(" "));
  assert.deepEqual(names(p.losses), ["secrets:write>read"]);
});

test("T12 diffGrants — 올라간 것과 내려간 것", () => {
  const d = diffGrants({ content: "write", code: "read", db: "read" }, { content: "read", code: "write", db: "read", session: "write" });
  assert.deepEqual(names(d.gains), ["code:read>write", "session:->write"]);
  assert.deepEqual(names(d.losses), ["content:write>read"]);
  assert.deepEqual(diffGrants({}, {}), { gains: [], losses: [] });
});

/** scope 7개의 전 조합(128가지). */
const allCombos = (): string[][] => {
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << SCOPES.length; mask++) out.push(SCOPES.filter((_, i) => mask & (1 << i)));
  return out;
};
const rank = (lv?: string | null): number => (lv === "write" ? 2 : lv === "read" ? 1 : 0);

test("T13 계획은 «역할 ∪ 개별 권한» 이고 개별 권한은 역할보다 높은 것뿐이다", () => {
  let moved = 0;
  for (const scopes of allCombos()) for (const keep of [false, true]) {
    const p = plan(scopes, keep);
    if (!p.role) { assert.equal(scopes.length, 0, `옮기지 않는 것은 빈 scopes 뿐: ${scopes}`); continue; }
    moved++;
    const role: Grants = ROLE_GRANTS[p.role];
    for (const [perm, lv] of Object.entries(p.grants)) {
      assert.ok(rank(lv) > rank((role as Record<string, string>)[perm]), `${scopes} — ${perm}:${lv} 는 역할이 이미 준다`);
    }
    assert.equal(p.custom, p.role === "guest", `${scopes} — 게스트로 가는 것은 직접 고른 권한뿐`);
    assert.equal(scopes.includes("admin") && scopes.includes("runtime"), p.role === "owner", `${scopes}`);
    assert.equal(scopes.includes("admin") && !scopes.includes("runtime"), p.role === "admin", `${scopes}`);
  }
  assert.equal(moved, 2 * 127);
});

test("T14 직접 고른 권한 · keep 은 잃지 않는다 · 위험 권한의 고치기를 새로 얻는 계획은 없다", () => {
  for (const scopes of allCombos()) for (const keep of [false, true]) {
    const p = plan(scopes, keep);
    if (!p.role) continue;
    if (p.custom || keep) assert.deepEqual(p.losses, [], `${scopes} keep=${keep}`);
    const now = legacyScopesToGrants(scopes);
    const after = mergeGrants(ROLE_GRANTS[p.role], p.grants);
    for (const perm of DANGEROUS_PERMISSIONS) {
      if (after[perm] === "write") assert.equal(now[perm], "write", `${scopes} — ${perm} 고치기를 새로 얻는다`);
    }
    //  구성원 역할로 가는 계획이 얻는 것은 하네스 설정 보기 · DB 조회 자격뿐이다.
    if (p.role === "member") for (const g of p.gains) assert.ok(["harness", "db"].includes(g.perm) && g.to === "read", `${scopes} — ${g.perm}:${g.to}`);
    //  DB 소스는 옛 db 가 있던 구성원에게만 지정한다.
    if (p.dbSources.length) assert.ok(scopes.includes("db"), `${scopes}`);
    if (scopes.includes("db")) assert.deepEqual(p.dbSources, ALL, `${scopes} — 옛 db 가 있던 구성원은 누구든 모든 소스를 잇는다`);
  }
});

test("T15 selectPlans — ids 또는 all 중 하나만", () => {
  const ps = planMigration([{ id: "a", scopes: FIVE }, { id: "b", scopes: ["items"] }, { id: "c", scopes: [] }], { sources: SOURCES });
  assert.deepEqual(selectPlans(ps, ["b", "a"], false).map((p) => p.id), ["b", "a"]);
  assert.deepEqual(selectPlans(ps, [], true).map((p) => p.id), ["a", "b", "c"]);
  assert.deepEqual(selectPlans(ps, ["a", "a", " a "], false).map((p) => p.id), ["a"]);
  assert.throws(() => selectPlans(ps, [], false), /하나만/);
  assert.throws(() => selectPlans(ps, ["a"], true), /하나만/);
  assert.throws(() => selectPlans(ps, ["", "  "], false), /하나만/, "빈 문자열뿐인 목록은 없는 것");
  assert.throws(() => selectPlans(ps, ["a", "zzz"], false), /옛 방식 구성원이 아닙니다.*zzz/);
  assert.deepEqual(selectPlans(ps, ["c"], false).map((p) => p.skip), ["no-permissions"], "옮기지 않을 구성원도 고를 수는 있다(적용이 건너뛴다)");
});
