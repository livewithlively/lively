import { strict as assert } from "node:assert";
import test from "node:test";
import { requireAttachedApp, requireSessionOwner, requireUsableApp, type AttachDeps, type SessionAppRow } from "./session-apps.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";

// ── 세션에 붙은 앱으로 store_* 에 들어갈 수 있나 (#4225) ──────────────────────────
//  경계 셋 — ① 요청이 말한 세션의 주인인가 ② 지금 붙어 있나 ③ 그 사람의 동의 범위인가. 매 호출 다시 본다(캐시 없음).
//  이게 틀리면: ①이 빠지면 남의 세션 id 를 말해 그 세션에 붙은 앱의 데이터를 쓴다 · ②가 빠지면 떼도 계속 쓴다 ·
//  ③이 빠지면 AI 가 사람이 동의하지 않은 도구로 들어간다. 사양 표 S1 의 행마다 하나씩 못박는다.

const app = (id: string, over: Partial<OrgApp> = {}): OrgApp => ({
  id, title: id, version: "1.0.0", manifest: {}, source: { kind: "installed" }, content_hash: null,
  status: "active", enabled: true, installed_by: "alice", installed_at: "", updated_at: "", updated_by: null, edit_mode: "all", edit_members: [],
  builtin_version: null, current_version_no: null, ...over,
});
const grant = (tools: string[]): AppGrantRow => ({ app_id: "x", member_id: "alice", scopes: [], tools, granted_at: "", granted_by: null, revoked_at: null });
const row = (appId: string): SessionAppRow => ({ session_id: "box-a", app_id: appId, member_id: "alice", attached_at: "" });

interface World { owner: string | null; attached: string[]; apps: Record<string, OrgApp | null>; grants: Record<string, AppGrantRow | null> }
/** 가짜 세계 + 무엇을 읽었나(부작용으로 단언한다). */
function deps(over: Partial<World> = {}): AttachDeps & { reads: string[] } {
  const w: World = {
    owner: over.owner === undefined ? "alice" : over.owner,
    attached: over.attached ?? ["crm"],
    apps: over.apps ?? { crm: app("crm"), todo: app("todo") },
    grants: over.grants ?? { crm: grant(["store_*"]), todo: grant(["store_*"]) },
  };
  const reads: string[] = [];
  return {
    reads,
    sessionOwner: async () => { reads.push("owner"); return w.owner; },
    listAttached: async () => { reads.push("attached"); return w.attached.map(row); },
    getApp: async (id) => { reads.push("app:" + id); return id in w.apps ? w.apps[id] : null; },
    getGrant: async (id) => { reads.push("grant:" + id); return id in w.grants ? w.grants[id] : null; },
  };
}
const q = (over: Partial<{ member: string; appId: string | null; tool: string }> = {}) =>
  ({ sessionId: "box-a", member: over.member ?? "alice", appId: over.appId === undefined ? null : over.appId, tool: over.tool ?? "store_insert" });
const status = async (p: Promise<unknown>): Promise<number | "ok"> => {
  try { await p; return "ok"; } catch (e) { return (e as { status?: number }).status ?? -1; }
};

test("S1-1 주인 · 붙음 · 동의 범위 안 · app_id 지정 → 그 앱(세 경계를 전부 읽었다)", async () => {
  const d = deps();
  assert.equal(await requireAttachedApp(q({ appId: "crm" }), d), "crm");
  assert.deepEqual(d.reads, ["owner", "attached", "app:crm", "grant:crm"]);
});

test("S1-2 남의 세션(주인이 아님) → 403 — 세션 id 는 자기주장이라 주인을 다시 본다", async () => {
  assert.equal(await status(requireAttachedApp(q({ member: "mallory", appId: "crm" }), deps())), 403);
});

test("S1-3 모르는 세션(주인을 못 찾음) → 404", async () => {
  assert.equal(await status(requireAttachedApp(q({ appId: "crm" }), deps({ owner: null }))), 404);
});

test("S1-4 app_id 가 이 세션에 안 붙어 있음(뗐다 · 다른 앱만 붙음) → 403 — 떼는 순간 막힌다", async () => {
  assert.equal(await status(requireAttachedApp(q({ appId: "crm" }), deps({ attached: [] }))), 403);
  assert.equal(await status(requireAttachedApp(q({ appId: "todo" }), deps({ attached: ["crm"] }))), 403);
});

test("S1-5 app_id 생략 · 붙은 앱 정확히 하나 → 그 앱", async () => {
  assert.equal(await requireAttachedApp(q(), deps({ attached: ["todo"] })), "todo");
});

test("S1-6 app_id 생략 · 붙은 앱 없음 → 403", async () => {
  assert.equal(await status(requireAttachedApp(q(), deps({ attached: [] }))), 403);
});

test("S1-7 app_id 생략 · 붙은 앱 둘 → 400(고르라고) — 아무 쪽이나 고르지 않는다", async () => {
  const d = deps({ attached: ["crm", "todo"] });
  assert.equal(await status(requireAttachedApp(q(), d)), 400);
  assert.ok(!d.reads.some((r) => r.startsWith("grant:")), "고르지 않았으니 어느 앱의 동의도 보지 않는다");
});

test("S1-8 앱이 꺼졌거나 설치 중 → 409 · 사라졌으면 404", async () => {
  assert.equal(await status(requireAttachedApp(q({ appId: "crm" }), deps({ apps: { crm: app("crm", { enabled: false }) } }))), 409);
  assert.equal(await status(requireAttachedApp(q({ appId: "crm" }), deps({ apps: { crm: app("crm", { status: "installing" }) } }))), 409);
  assert.equal(await status(requireAttachedApp(q({ appId: "crm" }), deps({ apps: {} }))), 404);
});

test("S1-9 동의(grant)가 없음 → 403 — 붙이기가 동의를 대신하지 않는다", async () => {
  assert.equal(await status(requireAttachedApp(q({ appId: "crm" }), deps({ grants: { crm: null } }))), 403);
});

test("S1-10 동의 범위에 그 도구가 없음 → 403 · 리터럴·글롭으로 있으면 통과", async () => {
  assert.equal(await status(requireAttachedApp(q({ appId: "crm", tool: "store_delete" }), deps({ grants: { crm: grant(["store_query", "store_insert"]) } }))), 403);
  assert.equal(await requireAttachedApp(q({ appId: "crm", tool: "store_query" }), deps({ grants: { crm: grant(["store_query"]) } })), "crm");
  assert.equal(await requireAttachedApp(q({ appId: "crm", tool: "store_delete" }), deps({ grants: { crm: grant(["store_*"]) } })), "crm");
});

test("S1-11 주인이 아니면 붙은 목록·앱·동의를 읽지도 않는다(남의 세션에 무엇이 붙었는지 새지 않게)", async () => {
  const d = deps();
  await status(requireAttachedApp(q({ member: "mallory", appId: "crm" }), d));
  assert.deepEqual(d.reads, ["owner"]);
});

test("requireSessionOwner · requireUsableApp 단독", async () => {
  assert.equal(await status(requireSessionOwner("box-a", "alice", { sessionOwner: async () => "alice" })), "ok");
  assert.equal(await status(requireSessionOwner("box-a", "bob", { sessionOwner: async () => "alice" })), 403);
  assert.equal(await status(requireSessionOwner("box-a", "bob", { sessionOwner: async () => null })), 404);
  assert.throws(() => requireUsableApp(null, "x"), (e: { status?: number }) => e.status === 404);
  assert.equal(requireUsableApp(app("x"), "x").id, "x");
});
