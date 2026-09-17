import { strict as assert } from "node:assert";
import test from "node:test";
import { cleanEnterUrl, planNotifyRoutes, hereSlug, ownRouteNow, tenantBaseOf, type RoutePlanInput } from "./notify-scope.js";
import { withTenant } from "../org/tenant-context.js";

// ── 알림 스트림이 받을 자리 (#4054) — 사양 표 S1~S12 ─────────────────────────────
//  이 목록이 곧 «누가 무엇을 받나»의 경계다. 넓게 틀리면 남의 사건이 흘러들고(유출), 좁게 틀리면
//  다른 워크스페이스 알림이 조용히 사라진다. 그래서 넓히는 조건은 전부 행으로 못박는다.

const CP = "https://app.lvly.io";
const UUID_B = "4c72240a-e307-47e3-92fd-4c463809e8dd";
const UUID_C = "244ae282-255c-4cdb-843c-26c250e366a8";
const enter = (id: string, base = CP) => `${base}/ws/${id}/enter`;

const managed = (over: Partial<RoutePlanInput> = {}): RoutePlanInput => ({
  mode: "managed", me: "sangmin-yoon", here: { slug: "lively-46e3", name: "Lively" }, all: true,
  account: "4d255364-7dbb-4c53-b210-1588ebde1820", cpBase: CP,
  cpWorkspaces: [
    { slug: "lively-46e3", name: "Lively", enter_url: enter("de1e1dc2-3071-4f26-ab64-a35564325a06"), is_current: true },
    { slug: "wonjoon-jang-074e", name: "장원준의 워크스페이스", enter_url: enter(UUID_B), is_current: false },
    { slug: "soltimal-adce", name: "NCEO", enter_url: enter(UUID_C) },
  ],
  ...over,
});

test("S1 다른 워크스페이스를 청하지 않으면 어느 모드든 자기 워크스페이스 한 자리(구성원 아이디)뿐", () => {
  for (const mode of ["managed", "registry", "single"] as const) {
    const r = planNotifyRoutes({ ...managed(), mode, all: false, registryWorkspaces: [{ slug: "haru", name: "하루" }] });
    assert.equal(r.length, 1, mode);
    assert.deepEqual({ ws: r[0]!.ws, member: r[0]!.member, account: r[0]!.account }, { ws: "lively-46e3", member: "sangmin-yoon", account: undefined }, mode);
    assert.equal(r[0]!.label.current, true, mode);
    assert.equal(r[0]!.label.name, "Lively", mode);
  }
});

test("S2 단일 테넌트는 청해도 자기 워크스페이스뿐 — 가는 길은 same", () => {
  const r = planNotifyRoutes({ mode: "single", me: "alice", here: { slug: "primary", name: "우리 회사" }, all: true });
  assert.deepEqual(r, [{ ws: "primary", member: "alice", label: { slug: "primary", name: "우리 회사", current: true, via: "same" } }]);
});

test("S3 매니지드: 자기 + CP 가 준 다른 워크스페이스(계정 조건 · via=enter · 입장 주소), «지금 여기»는 뺀다", () => {
  const r = planNotifyRoutes(managed());
  assert.deepEqual(r.map((x) => x.ws), ["lively-46e3", "wonjoon-jang-074e", "soltimal-adce"]);
  const [own, b, c] = r;
  assert.deepEqual({ member: own!.member, account: own!.account, via: own!.label.via }, { member: "sangmin-yoon", account: undefined, via: "same" });
  assert.deepEqual(b, {
    ws: "wonjoon-jang-074e", account: "4d255364-7dbb-4c53-b210-1588ebde1820",
    label: { slug: "wonjoon-jang-074e", name: "장원준의 워크스페이스", current: false, via: "enter", enter: enter(UUID_B) },
  });
  assert.equal(b!.member, undefined, "다른 워크스페이스를 구성원 아이디로 맞추면 로컬파트가 같은 남의 사건이 들어온다");
  assert.equal(c!.label.enter, enter(UUID_C));
});

test("S3b CP 가 «지금 여기»를 못 붙였어도 자기 slug 와 같은 줄은 다른 워크스페이스로 세지 않는다", () => {
  const r = planNotifyRoutes(managed({ cpWorkspaces: [{ slug: "lively-46e3", name: "Lively", enter_url: enter(UUID_B) }] }));
  assert.deepEqual(r.map((x) => x.ws), ["lively-46e3"]);
  assert.equal(r[0]!.member, "sangmin-yoon", "자기 자리가 계정 자리로 덮였다");
});

test("S3c CP 가 «지금 여기»라고 한 줄은 slug 가 달라도 다른 워크스페이스로 세지 않는다(두 쪽 slug 가 어긋난 경우)", () => {
  const r = planNotifyRoutes(managed({ cpWorkspaces: [
    { slug: "renamed-46e3", name: "Lively", enter_url: enter(UUID_B), is_current: true },
    { slug: "soltimal-adce", name: "NCEO", enter_url: enter(UUID_C), is_current: false },
  ] }));
  assert.deepEqual(r.map((x) => x.ws), ["lively-46e3", "soltimal-adce"]);
});

test("S17 매니지드: 테넌트 주소 규칙을 알면 다른 워크스페이스의 웹 화면 주소를 싣는다(모르면 안 싣는다)", () => {
  const withBase = planNotifyRoutes(managed({ tenantBase: { scheme: "https", parent: "app.lvly.io" } }));
  assert.deepEqual(withBase.map((x) => x.label.url), [undefined, "https://wonjoon-jang-074e.app.lvly.io/ui/", "https://soltimal-adce.app.lvly.io/ui/"],
    "자기 워크스페이스엔 주소를 싣지 않고, 다른 워크스페이스엔 <slug>.<도메인>/ui/");
  assert.deepEqual(planNotifyRoutes(managed()).map((x) => x.label.url), [undefined, undefined, undefined]);
  // 등록부 모드엔 규칙이 와도 싣지 않는다(같은 주소에서 선택만 바꾼다)
  const reg = planNotifyRoutes({ mode: "registry", me: "alice", here: { slug: "primary", name: "" }, all: true,
    tenantBase: { scheme: "https", parent: "app.lvly.io" }, registryWorkspaces: [{ slug: "haru", name: "하루" }] });
  assert.equal(reg[1]!.label.url, undefined);
});

test("S18 테넌트 주소 규칙(tenantBaseOf) — «<자기 slug>.<도메인>» 꼴일 때만", () => {
  assert.deepEqual(tenantBaseOf("https://lively-46e3.app.lvly.io", "lively-46e3"), { scheme: "https", parent: "app.lvly.io" });
  assert.deepEqual(tenantBaseOf("https://Lively-46e3.App.lvly.io/", "LIVELY-46e3"), { scheme: "https", parent: "app.lvly.io" });
  assert.deepEqual(tenantBaseOf("http://acme.dev.example.com", "acme"), { scheme: "http", parent: "dev.example.com" });
  for (const [gw, slug] of [
    ["https://olddev.lvly.io", "primary"],              // 이름이 slug 로 시작하지 않는다(셀프호스트)
    ["https://lively-46e3.app.lvly.io/prefix", "lively-46e3"],   // 경로 접두
    ["https://lively-46e3.app.lvly.io:8443", "lively-46e3"],     // 포트
    ["https://lively-46e3.io", "lively-46e3"],          // 상위 도메인이 한 칸
    ["https://lively-46e3x.app.lvly.io", "lively-46e3"],         // 이름 경계(접두만 같다)
    ["ftp://lively-46e3.app.lvly.io", "lively-46e3"],
    ["", "lively-46e3"], [null, "lively-46e3"], ["https://lively-46e3.app.lvly.io", ""],
    ["https://u:p@lively-46e3.app.lvly.io", "lively-46e3"],
  ] as const) assert.equal(tenantBaseOf(gw, slug), null, `${gw} · ${slug}`);
});

test("S4 매니지드: 계정이 확인되지 않으면 다른 워크스페이스를 받지 않는다(fail-closed)", () => {
  for (const account of [null, undefined, "", "   "]) {
    const r = planNotifyRoutes(managed({ account }));
    assert.deepEqual(r.map((x) => x.ws), ["lively-46e3"], String(account));
  }
});

test("S5 매니지드: 입장 주소가 계정 서버 출처가 아니면 그 워크스페이스는 빠진다", () => {
  const r = planNotifyRoutes(managed({ cpWorkspaces: [
    { slug: "a-1", name: "A", enter_url: enter(UUID_B, "https://evil.example") },
    { slug: "a-2", name: "A2", enter_url: enter(UUID_B, "https://app.lvly.io.evil.example") },
    { slug: "a-3", name: "A3", enter_url: enter(UUID_B, "https://lively-46e3.app.lvly.io") },
    { slug: "a-4", name: "A4", enter_url: enter(UUID_B) },
  ] }));
  assert.deepEqual(r.map((x) => x.ws), ["lively-46e3", "a-4"]);
});

test("S6 매니지드: 입장 주소에 쿼리·조각·계정정보·다른 경로·낮은 스킴이 있으면 빠진다", () => {
  const bad = [
    `${enter(UUID_B)}?to=%23%2Fhome`,
    `${enter(UUID_B)}#/s/x`,
    `https://u:p@app.lvly.io/ws/${UUID_B}/enter`,
    `https://app.lvly.io/ws/${UUID_B}/leave`,
    `https://app.lvly.io/ws/${UUID_B}/enter/x`,
    `https://app.lvly.io/x/ws/${UUID_B}/enter`,
    `http://app.lvly.io/ws/${UUID_B}/enter`,
    `javascript:alert(1)`,
    "",
    undefined,
  ];
  for (const u of bad) assert.equal(cleanEnterUrl(u, CP), null, String(u));
  assert.equal(cleanEnterUrl(enter(UUID_B), CP), enter(UUID_B));
  // 기준 자체가 http(로컬 CP) 면 http 도 받는다 — 스킴을 낮추는 것만 막는다.
  assert.equal(cleanEnterUrl(`http://127.0.0.1:9000/ws/${UUID_B}/enter`, "http://127.0.0.1:9000"), `http://127.0.0.1:9000/ws/${UUID_B}/enter`);
  assert.equal(cleanEnterUrl(enter(UUID_B), null), null, "기준이 없으면 아무것도 받지 않는다");
  const r = planNotifyRoutes(managed({ cpWorkspaces: bad.map((u, i) => ({ slug: `b-${i}`, name: "x", enter_url: u as string })) }));
  assert.deepEqual(r.map((x) => x.ws), ["lively-46e3"]);
});

test("S7 slug 형식이 아니면 빠진다 — 주소·열쇠로 쓰이는 값이다", () => {
  const r = planNotifyRoutes(managed({ cpWorkspaces: [
    { slug: "Bad Slug", name: "x", enter_url: enter(UUID_B) },
    { slug: "-lead", name: "x", enter_url: enter(UUID_B) },
    { slug: "", name: "x", enter_url: enter(UUID_B) },
    { slug: "a".repeat(64), name: "x", enter_url: enter(UUID_B) },
    { slug: "ok-slug", name: "x", enter_url: enter(UUID_B) },
  ] }));
  assert.deepEqual(r.map((x) => x.ws), ["lively-46e3", "ok-slug"]);
  const reg = planNotifyRoutes({ mode: "registry", me: "alice", here: { slug: "primary", name: "P" }, all: true,
    registryWorkspaces: [{ slug: "../etc", name: "x" }, { slug: "haru", name: "하루" }] });
  assert.deepEqual(reg.map((x) => x.ws), ["primary", "haru"]);
});

test("S8 셀프호스트 다중: 자기(via=header) + 내 등록부 워크스페이스를 구성원 아이디로(via=header)", () => {
  const r = planNotifyRoutes({ mode: "registry", me: "alice", here: { slug: "haru", name: "하루" }, all: true,
    registryWorkspaces: [{ slug: "primary", name: "본사" }, { slug: "haru", name: "하루(중복)" }, { slug: "team-x", name: "팀 X" }] });
  assert.deepEqual(r, [
    { ws: "haru", member: "alice", label: { slug: "haru", name: "하루", current: true, via: "header" } },
    { ws: "primary", member: "alice", label: { slug: "primary", name: "본사", current: false, via: "header" } },
    { ws: "team-x", member: "alice", label: { slug: "team-x", name: "팀 X", current: false, via: "header" } },
  ]);
  // 등록부 모드엔 계정 조건이 없다 — CP 가 준 목록이 섞여 와도 쓰지 않는다.
  const mixed = planNotifyRoutes({ mode: "registry", me: "alice", here: { slug: "haru", name: "" }, all: true,
    account: "acct", cpBase: CP, cpWorkspaces: [{ slug: "cp-only", name: "x", enter_url: enter(UUID_B) }] });
  assert.deepEqual(mixed.map((x) => x.ws), ["haru"]);
});

test("S9 구성원 아이디나 자기 slug 가 비면 자리를 만들지 않는다", () => {
  assert.deepEqual(planNotifyRoutes(managed({ me: "" })), []);
  assert.deepEqual(planNotifyRoutes(managed({ me: "   " })), []);
  assert.deepEqual(planNotifyRoutes(managed({ here: { slug: "", name: "x" } })), []);
});

test("S10 같은 slug 가 두 번 오면 먼저 온 것", () => {
  const r = planNotifyRoutes(managed({ cpWorkspaces: [
    { slug: "dup", name: "첫째", enter_url: enter(UUID_B) },
    { slug: "dup", name: "둘째", enter_url: enter(UUID_C) },
  ] }));
  assert.deepEqual(r.map((x) => [x.ws, x.label.name]), [["lively-46e3", "Lively"], ["dup", "첫째"]]);
});

test("S11 이름은 한 줄로 접고 80자에서 자른다(배너 윗줄 한 줄)", () => {
  const long = "가".repeat(81);
  const r = planNotifyRoutes(managed({ here: { slug: "lively-46e3", name: "  라이블리\n 팀  " }, cpWorkspaces: [
    { slug: "long-one", name: long, enter_url: enter(UUID_B) },
    { slug: "no-name", enter_url: enter(UUID_C) },
  ] }));
  assert.equal(r[0]!.label.name, "라이블리 팀");
  assert.equal(r[1]!.label.name, "가".repeat(80));
  assert.equal(r[2]!.label.name, "");
});

test("S12 경계: 입장 주소의 uuid 자리가 36자가 아니면 빠진다", () => {
  assert.equal(cleanEnterUrl(`${CP}/ws/${UUID_B.slice(0, 35)}/enter`, CP), null);
  assert.equal(cleanEnterUrl(`${CP}/ws/${UUID_B}0/enter`, CP), null);
  assert.equal(cleanEnterUrl(`${CP}/ws/${UUID_B}/enter`, CP), `${CP}/ws/${UUID_B}/enter`);
});

test("자기 slug 는 요청 컨텍스트에서 — 없으면 primary(단일 테넌트·registry 의 primary)", () => {
  assert.equal(hereSlug(), "primary");
  withTenant({ id: "t-1", slug: "Lively-46e3" }, () => {
    assert.equal(hereSlug(), "lively-46e3");
    assert.deepEqual(ownRouteNow("alice"), [{ ws: "lively-46e3", member: "alice", label: { slug: "lively-46e3", name: "", current: true, via: "same" } }]);
  });
  assert.deepEqual(ownRouteNow(""), []);
});
