// 권한 판정의 이음매 (#5799 2단계) — 강제 지점이 새 판정(permits · capAllowed)을 쓰되, 옛 scope 만 가진 주체에겐 아무것도 바뀌지 않는다.
//  실행: npm run build && node dist/capabilities/cap-permission.test.js
//
//  사양
//   · 새 권한(grants)이 실리지 않은 주체는 **종전과 정확히 같은 판정**을 받는다 — 그 기능의 scope 를 갖고 있는가. 넓어지지도 좁아지지도 않는다.
//   · 새 권한이 실린 주체는 «그 기능이 요구하는 영역 × 수준을 덮는가» 로만 판정받는다. scopes 는 사본이라 보지 않는다.
//   · 로그인만인 기능은 누구든 통과한다.
//
//  엣지 표:
//   C1 옛 주체 × 등록부 전 기능 × 옛 scope 부분집합 128가지 — capAllowed 가 «scope 를 갖고 있는가» 와 전부 같다
//   C2 새 주체 — 보기만 받으면 조회는 되고 변경은 막힌다 · scopes 사본에 memory · admin 이 남아 있어도 얻는 것이 없다
//   C3 새 주체의 grants 가 빈 객체(권한 0개) — scope 있는 기능은 전부 막힌다(사본에 scope 가 다 있어도) · 로그인만인 기능은 된다
//   C4 permits 경계 — 요구 없음 · scope 없음 → 통과 / 주체 없음 · scopes 가 배열이 아님 → 거절 / grants 가 null 이면 옛 주체로 본다
//   C5 isAdmin · canManageWorkspace — 옛 주체 128가지에서 종전 식과 같다 · 새 주체는 관리 고치기 / 수집 · 증류 고치기만(보기는 아님)
//   C6 외부 앱 도구의 요구 — items 도구는 조회 등급(L0)만 보기, 그 밖 · 모르는 등급은 고치기 · 다른 scope 로 조인 도구는 그 조임을 잇는다
//   C7 외부 앱 도구 × 옛 주체 — 그 도구의 호출 scope 를 가졌는가 그대로(5 scope × 등급 4가지 × 128 부분집합)
//   C8 requireNeed — 막히면 종전 꼴의 문구(옛 scope 이름)로 던지고, 통과하면 조용하다
//   C9 배선 — MCP 어댑터에 등록된 핸들러를 실제로 부른다: 막힌 주체는 본체에 닿지 않고, 통과한 주체는 본체가 돈다
//   C10 막힘 문구 — 옛 주체는 종전 꼴 그대로(옛 scope 이름) · 역할 구성원은 화면 이름과 수준(보기/고치기/조회/있다없다)으로
import test from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registry, capMutates, capAllowed, capNeed, capDenialText, registerMcpCapabilities } from "./index.js";
import { needText } from "./cap-permission.js";
import type { Capability } from "./types.js";
import { isAdmin, canManageWorkspace } from "./principal.js";
import { needForExternalTool } from "./permission-map.js";
import { requireNeed, type LivelyUser } from "../context.js";
import { SCOPES, type Scope } from "../auth/scopes.js";
import { permits, ROLE_GRANTS, type Grants } from "../auth/permissions.js";

const caps: Capability[] = [...registry.values()];
const scoped = caps.filter((c) => c.scope !== null);
const loginOnly = caps.filter((c) => c.scope === null);
const subsets = <T>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
const ALL_SETS = subsets(SCOPES);
const cap = (name: string): Capability => {
  const c = registry.get(name);
  assert.ok(c, `등록부에 ${name} 이 있어야 한다`);
  return c;
};
const names = (cs: Capability[]): string[] => cs.map((c) => c.name).sort();
const user = (over: Partial<LivelyUser>): LivelyUser => ({ userId: "u1", email: "", scopes: [], projects: ["*"], ...over });

test("C0 배선 — 등록부와 부분집합이 실제로 실려 있다", () => {
  assert.ok(scoped.length > 400 && loginOnly.length > 100, `scope 있는 기능 ${scoped.length} · 로그인만 ${loginOnly.length}`);
  assert.equal(ALL_SETS.length, 128, "옛 scope 7개의 부분집합 전부");
});

test("C1 옛 주체는 전 기능 × 128가지에서 종전과 정확히 같은 판정을 받는다", () => {
  let checked = 0;
  for (const set of ALL_SETS) {
    for (const c of caps) {
      const legacy = c.scope === null || set.includes(c.scope);
      if (capAllowed({ scopes: set }, c) !== legacy) assert.fail(`${c.name} × [${set.join(" ")}] — 종전 ${legacy}, 지금 ${!legacy}`);
      checked++;
    }
  }
  assert.equal(checked, 128 * caps.length);
  // grants 가 null 이어도 옛 주체다
  assert.equal(capAllowed({ scopes: ["memory"], grants: null }, cap("knowledge_save")), true);
  assert.equal(capAllowed({ scopes: ["context"], grants: null }, cap("knowledge_save")), false, "영역이 합쳐졌어도 옛 주체에겐 넓어지지 않는다");
  assert.equal(capAllowed({ scopes: ["memory"] }, cap("category_list")), false, "memory 만으로 분류체계는 종전처럼 안 된다");
  assert.equal(capAllowed({ scopes: ["context"] }, cap("team_create")), true, "팀 편집도 옛 주체에겐 종전 그대로(관문은 context)");
});

test("C2 새 주체는 요구를 덮는가로만 판정받는다 — scopes 사본은 보지 않는다", () => {
  const viewer = { scopes: ["memory", "admin", "runtime"], grants: { content: "read" } as Grants };
  for (const [name, ok] of [
    ["knowledge_get", true], ["knowledge_search", true], ["category_list", true], ["project_get_v6", true],
    ["knowledge_save", false], ["task_create_v6", false], ["category_create", false],
    ["org_distiller_list", false], ["org_member_upsert", false], ["org_hooks", false], ["browser_status", false], ["repo_file", false],
  ] as const) assert.equal(capAllowed(viewer, cap(name)), ok, name);
  // 새 주체에겐 영역이 합쳐진다 — 맥락 고치기 하나로 지식과 분류체계를 둘 다 고친다
  const writer = { scopes: [], grants: { content: "write" } as Grants };
  assert.equal(capAllowed(writer, cap("knowledge_save")), true);
  assert.equal(capAllowed(writer, cap("category_create")), true);
  assert.equal(capAllowed(writer, cap("team_create")), true, "팀 편집은 표로는 맥락 고치기다(옛 방식과 같다) — 팀이 권한을 받는 단위가 된 조직에서 관리자만 받는 것은 핸들러의 검사다(teams.ts requireTeamWrite)");
  assert.equal(capAllowed({ scopes: [], grants: { content: "read" } as Grants }, cap("team_create")), false, "맥락 보기로는 팀을 못 만든다");
  // 역할 그대로
  assert.equal(capAllowed({ scopes: [], grants: ROLE_GRANTS.member }, cap("org_member_upsert")), false);
  assert.equal(capAllowed({ scopes: [], grants: ROLE_GRANTS.admin }, cap("org_member_upsert")), true);
  assert.equal(capAllowed({ scopes: [], grants: ROLE_GRANTS.admin }, cap("org_credential_set")), false, "관리자의 자격은 보기만");
  // 등록부 전체로: 새 주체의 판정은 «요구를 덮는가» 와 같다
  for (const g of [ROLE_GRANTS.guest, ROLE_GRANTS.member, ROLE_GRANTS.admin, ROLE_GRANTS.owner]) {
    for (const c of caps) {
      const need = capNeed(c);
      const want = need === null || (g[need.perm] !== undefined && (need.level === "read" || g[need.perm] === "write"));
      assert.equal(capAllowed({ scopes: [...SCOPES], grants: g }, c), want, `${c.name}`);
    }
  }
});

test("C3 새 주체의 권한이 0개면 scope 있는 기능은 전부 막힌다", () => {
  const none = { scopes: [...SCOPES], grants: {} as Grants };
  assert.deepEqual(names(scoped.filter((c) => capAllowed(none, c))), []);
  assert.deepEqual(names(loginOnly.filter((c) => !capAllowed(none, c))), [], "로그인만인 기능은 된다");
  assert.deepEqual(names(loginOnly.filter((c) => !capAllowed({ scopes: [] }, c))), [], "옛 주체도 마찬가지");
});

test("C4 permits 의 경계", () => {
  const need = { perm: "content", level: "write" } as const;
  assert.equal(permits({ scopes: [] }, "memory", null), true, "요구 없음");
  assert.equal(permits({ scopes: [] }, null, need), true, "scope 없음(로그인만)");
  assert.equal(permits(null, "memory", need), false);
  assert.equal(permits(undefined, "memory", need), false);
  assert.equal(permits({}, "memory", need), false, "scopes 없음");
  assert.equal(permits({ scopes: "memory" as unknown as string[] }, "memory", need), false, "scopes 가 배열이 아니면 닫는다");
  assert.equal(permits({ scopes: ["memory"] }, "memory", need), true);
  assert.equal(permits({ scopes: ["context"] }, "memory", need), false, "옛 주체는 번역하지 않는다 — context 는 memory 가 아니다");
  assert.equal(permits({ scopes: ["context"], grants: { content: "write" } }, "memory", need), true, "새 주체는 요구로 잰다");
  assert.equal(permits({ scopes: ["memory"], grants: { content: "read" } }, "memory", need), false);
  assert.equal(permits({ scopes: ["memory"], grants: null }, "memory", need), true, "grants 가 null 이면 옛 주체");
});

test("C5 isAdmin · canManageWorkspace", () => {
  for (const set of ALL_SETS) {
    assert.equal(isAdmin({ scopes: set }), set.includes("admin"), `isAdmin [${set.join(" ")}]`);
    assert.equal(canManageWorkspace({ scopes: set }), set.includes("memory") || set.includes("admin"), `canManage [${set.join(" ")}]`);
  }
  assert.equal(isAdmin(undefined), false);
  assert.equal(canManageWorkspace(undefined), false);
  // 새 주체
  assert.equal(isAdmin({ scopes: ["admin"], grants: { admin: "read" } }), false, "관리 보기는 관리자가 아니다");
  assert.equal(isAdmin({ scopes: [], grants: { admin: "write" } }), true);
  assert.equal(isAdmin({ scopes: ["admin"], grants: ROLE_GRANTS.member }), false);
  assert.equal(canManageWorkspace({ scopes: ["memory"], grants: { pipeline: "read" } }), false);
  assert.equal(canManageWorkspace({ scopes: [], grants: { pipeline: "write" } }), true);
  assert.equal(canManageWorkspace({ scopes: [], grants: { admin: "write" } }), true, "관리자는 함께 통과");
  assert.equal(canManageWorkspace({ scopes: [], grants: ROLE_GRANTS.guest }), false);
});

test("C6 외부 앱 도구의 요구", () => {
  assert.deepEqual(needForExternalTool("items", "L0"), { perm: "external", level: "read" });
  for (const lv of ["L1", "L2", null, undefined, "", "l0", "L3"]) {
    assert.deepEqual(needForExternalTool("items", lv), { perm: "external", level: "write" }, `items · ${String(lv)}`);
  }
  // 관리자가 다른 scope 로 조여 둔 도구 — 등급과 무관하게 그 조임을 잇는다
  for (const lv of ["L0", "L2", null]) {
    assert.deepEqual(needForExternalTool("code", lv), { perm: "code", level: "read" });
    assert.deepEqual(needForExternalTool("db", lv), { perm: "db", level: "read" });
    assert.deepEqual(needForExternalTool("memory", lv), { perm: "content", level: "write" });
    assert.deepEqual(needForExternalTool("context", lv), { perm: "content", level: "write" });
  }
  // 새 주체 — 외부 앱 보기는 조회 등급만, 고치기는 전부
  const ro = { scopes: [], grants: { external: "read" } as Grants }, rw = { scopes: [], grants: { external: "write" } as Grants };
  assert.equal(permits(ro, "items", needForExternalTool("items", "L0")), true);
  assert.equal(permits(ro, "items", needForExternalTool("items", "L2")), false);
  assert.equal(permits(ro, "items", needForExternalTool("items", null)), false, "등급을 모르면 고치기로 본다");
  assert.equal(permits(rw, "items", needForExternalTool("items", "L2")), true);
  assert.equal(permits(rw, "code", needForExternalTool("code", "L0")), false, "외부 앱 권한으로 code 로 조인 도구는 못 부른다");
  assert.equal(permits({ scopes: [], grants: { code: "read" } }, "code", needForExternalTool("code", "L2")), true);
});

test("C7 외부 앱 도구 × 옛 주체 — 그 도구의 호출 scope 를 가졌는가 그대로", () => {
  const callable: Scope[] = ["items", "context", "db", "memory", "code"];
  let checked = 0;
  for (const s of callable) {
    for (const lv of ["L0", "L1", "L2", null]) {
      for (const set of ALL_SETS) {
        assert.equal(permits({ scopes: set }, s, needForExternalTool(s, lv)), set.includes(s), `${s} · ${String(lv)} × [${set.join(" ")}]`);
        checked++;
      }
    }
  }
  assert.equal(checked, 5 * 4 * 128);
});

test("C8 requireNeed — 막히면 종전 꼴의 문구로 던진다", () => {
  const need = needForExternalTool("items", "L2");
  assert.doesNotThrow(() => requireNeed(user({ scopes: ["items"] }), need, "items"));
  assert.throws(() => requireNeed(user({ userId: "alice", scopes: ["memory"] }), need, "items"), /^Error: Forbidden: user 'alice' lacks scope 'items'$/);
  assert.throws(() => requireNeed(user({ userId: "bob", scopes: ["items"], grants: { external: "read" } }), need, "items"), /lacks scope 'items'/, "새 주체는 사본의 items 로 통과하지 못한다");
  assert.doesNotThrow(() => requireNeed(user({ scopes: [], grants: { external: "write" } }), need, "items"));
  assert.doesNotThrow(() => requireNeed(user({ scopes: [] }), null, "items"), "요구가 없으면 통과");
});

test("C9 배선 — MCP 어댑터에 등록된 핸들러가 이 판정을 실제로 쓴다", async () => {
  // 본체가 돌았는지 볼 수 있는 탐침 기능 둘(조회 · 변경)을 등록부에 잠깐 넣는다. scope memory · 표에 없는 이름 → 기본 배정(맥락).
  const ran: string[] = [];
  const probe = (name: string, mutates: boolean): Capability => ({
    name, title: name, description: name, scope: "memory", mutates, input: {},
    expose: { mcp: true, rest: false }, handler: async () => { ran.push(name); return { ok: true }; },
  });
  const READ = "perm_probe_read_5799", WRITE = "perm_probe_write_5799";
  registry.set(READ, probe(READ, false));
  registry.set(WRITE, probe(WRITE, true));
  try {
    const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<unknown>>();
    const fake = { registerTool: (name: string, _cfg: unknown, h: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>) => { handlers.set(name, h); } };
    registerMcpCapabilities(fake as unknown as McpServer);
    assert.ok(handlers.size > 200, `등록된 도구 ${handlers.size}개`);
    const call = async (name: string, u: LivelyUser): Promise<string> => {
      const h = handlers.get(name);
      assert.ok(h, `${name} 이 등록돼 있다`);
      try { await h({}, { authInfo: { extra: u } }); return "ran"; }
      catch (e) { return (e as Error).message; }
    };
    // 옛 주체 — memory 가 있으면 본체가 돌고, 없으면 본체에 닿지 않는다
    assert.equal(await call(READ, user({ scopes: ["memory"] })), "ran");
    assert.equal(await call(WRITE, user({ scopes: ["memory"] })), "ran");
    assert.deepEqual(ran, [READ, WRITE]);
    assert.match(await call(READ, user({ userId: "carol", scopes: ["context", "admin"] })), /^Forbidden: user 'carol' lacks scope 'memory'$/);
    assert.deepEqual(ran, [READ, WRITE], "막힌 호출은 본체를 돌리지 않는다");
    // 새 주체 — 맥락 보기만: 조회는 돌고 변경은 막힌다(사본에 memory 가 있어도)
    const viewer = user({ userId: "dave", scopes: ["memory"], grants: { content: "read" } });
    assert.equal(await call(READ, viewer), "ran");
    assert.equal(await call(WRITE, viewer), "Forbidden: «맥락» 고치기 권한이 필요합니다 — 관리자에게 요청하세요 (content:write)", "역할 구성원은 화면 이름으로 안내받는다");
    assert.deepEqual(ran, [READ, WRITE, READ]);
    // 새 주체 — 맥락 고치기: 사본에 scope 가 하나도 없어도 변경이 돈다
    assert.equal(await call(WRITE, user({ scopes: [], grants: { content: "write" } })), "ran");
    assert.equal(ran.length, 4);
    assert.equal(capMutates(registry.get(WRITE) as Capability), true);
  } finally {
    registry.delete(READ);
    registry.delete(WRITE);
  }
});

test("C10 막힘 문구", () => {
  // 옛 주체 — 글자 하나 바뀌지 않는다(시험 · 클라이언트가 이 꼴에 기댄다)
  assert.equal(capDenialText({ userId: "alice", scopes: ["memory"] }, cap("category_list"), "rest"), "forbidden: 'context' 권한이 필요합니다");
  assert.equal(capDenialText({ userId: "alice", scopes: ["memory"] }, cap("category_list"), "mcp"), "Forbidden: user 'alice' lacks scope 'context'");
  assert.equal(capDenialText({ userId: "alice", scopes: [], grants: null }, cap("org_member_upsert"), "rest"), "forbidden: 'admin' 권한이 필요합니다");
  // 역할 구성원 — 화면 이름과 수준으로
  const guest = { userId: "g", scopes: [], grants: ROLE_GRANTS.guest };
  assert.equal(capDenialText(guest, cap("knowledge_save"), "rest"), "forbidden: «맥락» 고치기 권한이 필요합니다 — 관리자에게 요청하세요");
  assert.equal(capDenialText(guest, cap("org_distiller_list"), "rest"), "forbidden: «수집 · 증류» 보기 권한이 필요합니다 — 관리자에게 요청하세요");
  assert.equal(capDenialText(guest, cap("org_hook_upsert"), "mcp"), "Forbidden: «하네스 설정» 고치기 권한이 필요합니다 — 관리자에게 요청하세요 (harness:write)");
  assert.equal(capDenialText(guest, cap("browser_navigate"), "rest"), "forbidden: «세션» 권한이 필요합니다 — 관리자에게 요청하세요", "있다/없다 권한은 수준을 말하지 않는다");
  assert.equal(capDenialText(guest, cap("delegate_status"), "rest"), "forbidden: «원격 실행» 권한이 필요합니다 — 관리자에게 요청하세요");
  assert.equal(needText({ perm: "db", level: "read" }), "«DB» 조회 권한이 필요합니다 — 관리자에게 요청하세요");
  // 옛 scope 이름이 새 문구에 새지 않는다
  assert.doesNotMatch(capDenialText(guest, cap("knowledge_save"), "rest"), /memory|scope/);
  // MCP 어댑터가 실제로 이 문구를 던진다(배선)
  assert.equal(needText({ perm: "admin", level: "read" }), "«관리» 보기 권한이 필요합니다 — 관리자에게 요청하세요");
});
