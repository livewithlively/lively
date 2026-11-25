// 앱 «조직 동의»(관리자가 구성원 모두를 대신해 하는 앱 동의) — 순수 함수(mergeOrgGrant · parseOrgGrant) 사양 기반 시험.
//  사양 문장만 보고 썼다(구현을 보지 않음). 이름 머리의 번호(D1 · F2 · G1 …)는 사양의 행위 번호다.
//  실 DB 를 타는 행위(A1 · B · C · E · F 의 문)는 app-org-grant.pg-test.mjs 가 잰다 — 여기는 합치기 규칙과 저장 값 읽기만.
//  이게 틀리면: 조직 동의가 본인 동의를 덮어써 선택 권한을 지우거나(D2), 조직 동의를 거뒀는데 조직 것이 본인 동의에 남거나(F2),
//   망가진 저장 값이 동의를 만들어 낸다(G1).
import { strict as assert } from "node:assert";
import test from "node:test";
import { mergeOrgGrant, parseOrgGrant } from "./grant.js";

type Mine = NonNullable<Parameters<typeof mergeOrgGrant>[2]>;
type Org = NonNullable<Parameters<typeof mergeOrgGrant>[3]>;
/** 결과를 재는 꼴 — 사양 «공개 진입점» 의 유효한 동의 모양(구현의 타입에 기대지 않는다). */
type View = {
  app_id: unknown; member_id: unknown; scopes: string[]; tools: string[];
  granted_at: unknown; granted_by: unknown; revoked_at: unknown; org_granted?: unknown;
};

const APP = "policy";
const MEMBER = "alice";
const MINE_AT = "2026-01-02T03:04:05.000Z";
const ORG_AT = "2026-03-04T05:06:07.000Z";

function mineOf(scopes: string[], tools: string[], over: Record<string, unknown> = {}): Mine {
  return { app_id: APP, member_id: MEMBER, scopes, tools, granted_at: MINE_AT, granted_by: MEMBER, revoked_at: null, ...over } as unknown as Mine;
}
function orgOf(scopes: string[], tools: string[], over: Record<string, unknown> = {}): Org {
  return { scopes, tools, granted_at: ORG_AT, granted_by: "admin", ...over } as unknown as Org;
}
function merge(mine: Mine | null, org: Org | null, appId = APP, memberId = MEMBER): View | null {
  return mergeOrgGrant(appId, memberId, mine, org) as unknown as View | null;
}
function parse(v: unknown): { scopes: string[]; tools: string[]; granted_at: unknown; granted_by: unknown } | null {
  return parseOrgGrant(v) as unknown as { scopes: string[]; tools: string[]; granted_at: unknown; granted_by: unknown } | null;
}
function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}
/** 같은 원소 · 같은 개수(중복이 있으면 길이가 달라 걸린다). 순서는 사양에 없어 보지 않는다. */
function assertSameSet(actual: readonly string[] | undefined, expected: readonly string[], msg?: string): void {
  assert.ok(Array.isArray(actual), `${msg ?? ""} — 배열이 아니다: ${JSON.stringify(actual)}`);
  assert.deepEqual(sorted(actual!), sorted(expected), msg);
}
/** 입력을 얼린다 — 입력을 고치는 구현은 여기서 던진다(모듈은 strict). 얼린 값은 JSON 사본과도 견준다. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
const snap = (x: unknown): string => JSON.stringify(x);

// ── 합치기 mergeOrgGrant ───────────────────────────────────────────────────────
test("A1 · F2 둘 다 없으면 null — 본인 동의도 조직 동의도 없는 사람은 동의가 없다", () => {
  assert.equal(merge(null, null), null);
  assert.equal(merge(null, null, "other-app", "bob"), null);
});

test("A1 · F2 조직 동의가 없으면 본인 동의를 그대로(같은 객체) 돌려준다 — 조직 것 표시가 붙지 않는다", () => {
  const mine = mineOf(["memory", "code"], ["store_tables", "repo_refs"]);
  const before = snap(mine);
  const r = merge(mine, null);
  assert.equal(r as unknown, mine as unknown, "같은 객체여야 한다(사본이 아니다)");
  assert.equal(snap(mine), before, "본인 동의가 바뀌었다");
  assert.notEqual(r!.org_granted, true, "조직 동의가 없는데 org_granted 가 붙었다");
});

test("C1 본인 동의가 없고 조직 동의만 있으면 — scope · 도구는 조직 동의의 것 · 앱 · 구성원은 부른 인자 · org_granted: true", () => {
  const org = orgOf(["memory", "context"], ["store_tables", "project_list_v6"]);
  const r = merge(null, org, "crm", "bob");
  assert.ok(r, "조직 동의가 있으면 동의가 있다");
  assert.equal(r!.app_id, "crm");
  assert.equal(r!.member_id, "bob");
  assertSameSet(r!.scopes, ["memory", "context"]);
  assertSameSet(r!.tools, ["store_tables", "project_list_v6"]);
  assert.equal(r!.org_granted, true);
});

test("C1 본인 동의가 없으면 granted_at · granted_by 는 조직 동의의 것 · revoked_at 은 null", () => {
  const r = merge(null, orgOf(["memory"], ["store_tables"]));
  assert.ok(r);
  assert.equal(r!.granted_at, ORG_AT);
  assert.equal(r!.granted_by, "admin");
  assert.equal(r!.revoked_at, null);
  const noBy = merge(null, orgOf(["memory"], ["store_tables"], { granted_by: null }));
  assert.ok(noBy);
  assert.equal(noBy!.granted_by, null, "조직 동의의 granted_by 가 null 이면 null");
  assert.equal(noBy!.granted_at, ORG_AT);
});

test("C1 조직 동의의 scope · 도구가 비어 있어도(권한을 선언하지 않은 앱) 조직 동의가 있으면 동의가 있다", () => {
  const r = merge(null, orgOf([], []));
  assert.ok(r, "조직 동의가 있는데 null 이다");
  assert.deepEqual(r!.scopes, []);
  assert.deepEqual(r!.tools, []);
  assert.equal(r!.org_granted, true);
});

test("D1 본인 동의 ∪ 조직 동의 — 한쪽에만 있는 scope · 도구가 모두 들고, 겹치는 것은 한 번만 · org_granted: true", () => {
  const mine = mineOf(["memory", "db"], ["store_tables", "db_query"]);
  const org = orgOf(["memory", "context"], ["store_tables", "project_list_v6"]);
  const r = merge(mine, org);
  assert.ok(r);
  assertSameSet(r!.scopes, ["memory", "db", "context"], "scopes 합집합(중복 없이)");
  assertSameSet(r!.tools, ["store_tables", "db_query", "project_list_v6"], "tools 합집합(중복 없이)");
  assert.equal(r!.org_granted, true);
  assert.equal(r!.app_id, APP);
  assert.equal(r!.member_id, MEMBER);
});

test("D1 좁힌 본인 동의(도구 하나)도 조직 동의가 있으면 조직 동의의 도구까지 넓어진다 · 조직 동의가 없으면 좁힌 그대로", () => {
  const mine = mineOf(["memory"], ["store_tables"]);
  const org = orgOf(["memory"], ["store_tables", "project_list_v6", "category_list"]);
  assertSameSet(merge(mine, org)!.tools, ["store_tables", "project_list_v6", "category_list"]);
  assertSameSet(merge(mine, null)!.tools, ["store_tables"], "조직 동의가 없으면 본인이 준 그대로");
});

test("D1 본인 동의가 조직 동의를 이미 다 품고 있어도 값은 같고 조직 동의가 들었다는 표시는 붙는다", () => {
  const mine = mineOf(["memory", "context"], ["store_tables", "project_list_v6"]);
  const r = merge(mine, orgOf(["memory"], ["store_tables"]));
  assert.ok(r);
  assertSameSet(r!.scopes, ["memory", "context"]);
  assertSameSet(r!.tools, ["store_tables", "project_list_v6"]);
  assert.equal(r!.org_granted, true);
});

test("D2 본인이 따로 받은 선택 권한(조직 동의에 없는 scope)은 조직 동의와 합쳐도 남는다", () => {
  const mine = mineOf(["memory", "code"], ["store_tables", "repo_refs"]);
  const org = orgOf(["memory"], ["store_tables", "repo_refs"]);
  const r = merge(mine, org);
  assert.ok(r);
  assert.ok(r!.scopes.includes("code"), `본인이 받은 선택 scope 가 빠졌다: ${JSON.stringify(r!.scopes)}`);
  assertSameSet(r!.scopes, ["memory", "code"]);
});

test("D2 한 사람의 선택 권한은 다른 구성원에게 퍼지지 않는다 — 같은 조직 동의로 이어서 합쳐도 조직 동의만 받은 사람에겐 없다", () => {
  const org = orgOf(["memory"], ["store_tables", "repo_refs"]);
  const orgBefore = snap(org);
  const admin = merge(mineOf(["memory", "code"], ["store_tables"], { member_id: "boss" }), org, APP, "boss");
  assert.ok(admin!.scopes.includes("code"), "시험 전제 — 받은 사람에겐 있다");
  const other = merge(null, org, APP, "bob");
  assert.ok(other);
  assertSameSet(other!.scopes, ["memory"], "조직 동의만 받은 사람의 scope 는 조직 동의의 것뿐");
  assert.ok(!other!.scopes.includes("code"), "다른 사람의 선택 권한이 퍼졌다");
  assert.equal(snap(org), orgBefore, "조직 동의 값이 합치는 동안 바뀌었다(다음 사람에게 퍼진다)");
  const third = merge(mineOf(["memory"], ["store_tables"], { member_id: "carl" }), org, APP, "carl");
  assertSameSet(third!.scopes, ["memory"], "본인 동의가 있는 다른 사람에게도 퍼지지 않는다");
});

test("F2 조직 동의를 거두면(조직 동의 null) 본인 동의는 본인이 준 그대로 — 조직 동의에서 온 것은 빠진다", () => {
  const mine = mineOf(["memory", "code"], ["store_tables"]);
  const org = orgOf(["memory", "context"], ["store_tables", "project_list_v6", "category_list"]);
  const withOrg = merge(mine, org);
  assert.ok(withOrg!.scopes.includes("context") && withOrg!.tools.includes("category_list"), "시험 전제 — 조직 동의가 있을 땐 넓다");
  const after = merge(mine, null);
  assert.equal(after as unknown, mine as unknown, "거둔 뒤에는 본인 동의 그대로(같은 객체)");
  assertSameSet(after!.scopes, ["memory", "code"], "조직 동의에서 온 context 가 본인 동의에 남았다");
  assertSameSet(after!.tools, ["store_tables"], "조직 동의에서 온 도구가 본인 동의에 남았다");
  assert.notEqual(after!.org_granted, true);
  assert.equal(merge(null, null), null, "조직 동의만으로 쓰던 사람은 동의가 없어진다");
});

test("입력을 고치지 않는다 — 얼린 본인 동의 · 조직 동의로 합쳐도 던지지 않고, 두 입력의 값이 그대로다", () => {
  const mine = deepFreeze(mineOf(["memory", "code"], ["store_tables", "repo_refs"]));
  const org = deepFreeze(orgOf(["memory", "context"], ["store_tables", "project_list_v6"]));
  const mineBefore = snap(mine);
  const orgBefore = snap(org);
  let r: View | null = null;
  let threw: unknown = null;
  try {
    r = merge(mine, org);
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, `얼린 입력을 고치려 했다: ${String(threw)}`);
  assert.ok(r, "합친 결과가 없다");
  assert.equal(snap(mine), mineBefore);
  assert.equal(snap(org), orgBefore);
  assert.ok(!("org_granted" in (mine as unknown as Record<string, unknown>)), "본인 동의 객체에 org_granted 를 적었다");
  assert.doesNotThrow(() => merge(null, org), "조직 동의만 있을 때 얼린 입력을 고치려 했다");
  assert.equal(snap(org), orgBefore);
});

test("입력을 고치지 않는다 — 얼리지 않은 입력도 합친 뒤 값이 그대로다(배열에 덧붙이지 않는다)", () => {
  const mine = mineOf(["memory"], ["store_tables"]);
  const org = orgOf(["memory", "context"], ["store_tables", "project_list_v6"]);
  const mineBefore = snap(mine);
  const orgBefore = snap(org);
  const r = merge(mine, org);
  assertSameSet(r!.tools, ["store_tables", "project_list_v6"]);
  assert.equal(snap(mine), mineBefore, "본인 동의가 바뀌었다 — 조직 동의를 거둬도 조직 것이 남게 된다(F2)");
  assert.equal(snap(org), orgBefore, "조직 동의가 바뀌었다");
});

// ── 저장 값 읽기 parseOrgGrant(G1) ─────────────────────────────────────────────
const GOOD = { scopes: ["memory", "context"], tools: ["store_tables", "ext__slack__*"], granted_at: ORG_AT, granted_by: "admin" };

test("G1 바른 값은 읽힌다 — scopes · tools · granted_at · granted_by 그대로", () => {
  const r = parse({ ...GOOD });
  assert.ok(r, "바른 값인데 null");
  assert.deepEqual(r!.scopes, GOOD.scopes);
  assert.deepEqual(r!.tools, GOOD.tools);
  assert.equal(r!.granted_at, ORG_AT);
  assert.equal(r!.granted_by, "admin");
  const nullBy = parse({ ...GOOD, granted_by: null });
  assert.ok(nullBy, "granted_by 가 null 인 값(누가 적었는지 모름)도 바른 값이다");
  assert.equal(nullBy!.granted_by, null);
  const empty = parse({ scopes: [], tools: [], granted_at: ORG_AT, granted_by: "admin" });
  assert.ok(empty, "빈 배열도 글의 배열이다(권한을 선언하지 않은 앱)");
  assert.deepEqual(empty!.scopes, []);
  assert.deepEqual(empty!.tools, []);
});

test("G1 값이 아예 없거나 객체가 아니면 null", () => {
  for (const v of [null, undefined, "oops", "", 0, 1, true, false, [], ["memory"], {}]) {
    assert.equal(parse(v), null, `값 ${JSON.stringify(v)}`);
  }
});

test("G1 scope 가 글의 배열이 아니면 null — 없음 · null · 글 하나 · 객체 · 글이 아닌 원소", () => {
  const { scopes: _drop, ...noScopes } = GOOD;
  void _drop;
  assert.equal(parse(noScopes), null, "scopes 칸 없음");
  const bad: unknown[] = [null, "memory", { 0: "memory" }, 7, true, [1], [null], ["memory", 2], [["memory"]], [{ s: "memory" }]];
  for (const s of bad) assert.equal(parse({ ...GOOD, scopes: s }), null, `scopes ${JSON.stringify(s)}`);
});

test("G1 도구가 글의 배열이 아니면 null — 없음 · null · 글 하나 · 객체 · 글이 아닌 원소", () => {
  const { tools: _drop, ...noTools } = GOOD;
  void _drop;
  assert.equal(parse(noTools), null, "tools 칸 없음");
  const bad: unknown[] = [null, "store_tables", { 0: "store_tables" }, 7, false, [1], [null], ["store_tables", 2], [["store_tables"]], [{ t: "store_tables" }]];
  for (const t of bad) assert.equal(parse({ ...GOOD, tools: t }), null, `tools ${JSON.stringify(t)}`);
});

test("G1 동의한 때(granted_at)가 없으면 null — 칸 없음 · null", () => {
  const { granted_at: _drop, ...noAt } = GOOD;
  void _drop;
  assert.equal(parse(noAt), null, "granted_at 칸 없음");
  assert.equal(parse({ ...GOOD, granted_at: null }), null, "granted_at null");
  assert.equal(parse({ ...GOOD, granted_at: undefined }), null, "granted_at undefined");
});

test("G1 (해석: 빈 글도 «동의한 때가 없음») granted_at 이 빈 글이면 null", () => {
  assert.equal(parse({ ...GOOD, granted_at: "" }), null);
});

test("G1 (해석: 사양이 꼽은 어긋남은 scope · 도구 · 동의한 때뿐) granted_by 칸이 없어도 읽히고 granted_by 는 비어 있다", () => {
  const { granted_by: _drop, ...noBy } = GOOD;
  void _drop;
  const r = parse(noBy);
  assert.ok(r, "granted_by 가 없다는 까닭만으로 조직 동의를 버렸다");
  assert.equal(r!.granted_by ?? null, null);
  assert.deepEqual(r!.scopes, GOOD.scopes);
});

test("G1 하나만 어긋나도 null — 나머지가 바르다고 살아남지 않는다", () => {
  assert.ok(parse({ ...GOOD }), "시험 전제 — 고치기 전 값은 읽힌다");
  assert.equal(parse({ ...GOOD, scopes: "memory" }), null, "scopes 만 어긋남");
  assert.equal(parse({ ...GOOD, tools: { store_tables: true } }), null, "tools 만 어긋남");
  assert.equal(parse({ ...GOOD, granted_at: null }), null, "granted_at 만 어긋남");
});

test("G1 잘못 적힌 값은 동의를 만들어 내지 않는다 — 읽은 값으로 합치면 조직 동의가 없는 것과 같다", () => {
  const broken: unknown[] = [
    { ...GOOD, scopes: "memory" },
    { ...GOOD, tools: null },
    { ...GOOD, granted_at: null },
    { scopes: ["memory"], tools: ["store_tables"] },
    "true",
    true,
    {},
  ];
  const mine = mineOf(["memory"], ["store_tables"]);
  for (const v of broken) {
    const org = parseOrgGrant(v);
    assert.equal(org, null, `읽기: ${JSON.stringify(v)}`);
    assert.equal(mergeOrgGrant(APP, MEMBER, null, org), null, `본인 동의 없는 사람에게 동의가 생겼다: ${JSON.stringify(v)}`);
    const withMine = mergeOrgGrant(APP, MEMBER, mine, org) as unknown;
    assert.equal(withMine, mine as unknown, `본인 동의가 그대로가 아니다: ${JSON.stringify(v)}`);
  }
  // 견줄 값 — 바른 값이면 같은 길로 동의가 생긴다(위 단언이 «늘 null» 이라서 통과한 게 아니다).
  const good = parseOrgGrant({ ...GOOD });
  const r = mergeOrgGrant(APP, MEMBER, null, good) as unknown as View | null;
  assert.ok(r, "바른 값으로는 동의가 생겨야 한다");
  assertSameSet(r!.scopes, GOOD.scopes);
  assertSameSet(r!.tools, GOOD.tools);
  assert.equal(r!.org_granted, true);
});
