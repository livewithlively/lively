import { strict as assert } from "node:assert";
import test from "node:test";
import { authorizeFileAccess, assertWritableTarget, readableAppFolders, type FileAccessDeps, type FilePrincipal, type FileOp } from "./file-access.js";
import { parseAddress } from "./address.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";

// 파일 주소 권한 판정(#4673) — 권한표 #4671 ③ = 사양 표 F1~F20 · W1~W5 · R1~R5.
//  perms = 저장된 매니페스트의 permissions(저장 때 app_folder:true 는 file_url 도구를 함의한다 — apps/manifest.ts).
const app = (id: string, over: Partial<OrgApp> = {}, perms: Record<string, unknown> = { app_folder: true, tools: ["file_url"] }): OrgApp => ({
  id, title: id, version: "1.0.0", manifest: { permissions: perms }, source: {}, content_hash: null,
  status: "active", enabled: true, installed_by: "owner", installed_at: "", updated_at: "", updated_by: null,
  edit_mode: "all", edit_members: [], builtin_version: null, current_version_no: null,
  visibility: "all", published_version_no: null, published_at: null, published_by: null, draft_by: null,
  made_by: "owner", owner_member: "owner", build_session: null, origin_app_id: null, ...over,
} as OrgApp);
const grant = (appId: string, member: string, tools: string[] = ["file_url"], revoked = false): AppGrantRow => ({
  app_id: appId, member_id: member, scopes: [], tools, granted_at: "", granted_by: null, revoked_at: revoked ? "2026-10-15" : null,
});

interface World { apps: Map<string, OrgApp>; grants: AppGrantRow[]; shared: (member: string, rel: string) => boolean; views?: Map<string, OrgApp> }
function deps(w: World, calls: string[] = []): FileAccessDeps {
  return {
    getApp: async (id) => { calls.push(`getApp:${id}`); return w.apps.get(id) ?? null; },
    getGrant: async (id, m) => { calls.push(`getGrant:${id}:${m}`); return w.grants.find((g) => g.app_id === id && g.member_id === m && !g.revoked_at) ?? null; },
    sharedGate: async (m) => { calls.push(`sharedGate:${m}`); return { ok: (rel: string) => { calls.push(`ok:${rel}`); return w.shared(m, rel); } }; },
    ...(w.views ? { viewFor: async (a: OrgApp) => w.views!.get(a.id) ?? a } : {}),
  };
}
const ME: FilePrincipal = { member: "m1", scopes: ["memory"] };
const ASAPP: FilePrincipal = { member: "m1", scopes: ["memory"], app: "crm" };
const world = (over: Partial<World> = {}): World => ({
  apps: new Map([["crm", app("crm")], ["other", app("other")]]),
  grants: [grant("crm", "m1"), grant("other", "m1")],
  shared: () => true, ...over,
});
const ok = async (p: FilePrincipal, a: string, op: FileOp, w: World = world()): Promise<void> => authorizeFileAccess(p, parseAddress(a), op, deps(w));
const no = async (p: FilePrincipal, a: string, op: FileOp, status: number, w: World = world(), re?: RegExp): Promise<void> => {
  await assert.rejects(() => authorizeFileAccess(p, parseAddress(a), op, deps(w)),
    (e: { status?: number; message?: string }) => e.status === status && (!re || re.test(String(e.message))), `${a} ${op} → ${status}`);
};

// ── 사람 · 사람의 AI ─────────────────────────────────────────────────────────────
test("F1 사람 · 공유 읽기 · 공개범위 OK → 통과(판정에 경로가 그대로 간다)", async () => {
  const calls: string[] = [];
  await authorizeFileAccess(ME, parseAddress("shared/project/4670/a.md"), "read", deps(world(), calls));
  assert.deepEqual(calls, ["sharedGate:m1", "ok:project/4670/a.md"]);
});
test("F2 사람 · 공유 · 공개범위 NO → 404(존재 은닉)", async () => {
  await no(ME, "shared/project/9/x", "read", 404, world({ shared: () => false }));
});
test("F3 사람 · 공유 쓰기 · OK → 통과", async () => { await ok(ME, "shared/x/y.txt", "write"); });
test("F4 사람 · 앱 폴더 쓰기 → 403(앱 폴더는 그 앱이 쓴다)", async () => {
  await no(ME, "apps/crm/x", "write", 403, world(), /그 앱이 씁니다/);
});
test("F5 사람 · 앱 폴더 읽기 · 동의 · 켜짐 · 보임 → 통과", async () => { await ok(ME, "apps/crm/out/a.png", "read"); });
test("F6 사람 · 앱 폴더 읽기 · 동의 없음 → 403(동의 안내)", async () => {
  await no(ME, "apps/crm/x", "read", 403, world({ grants: [grant("crm", "m1", ["file_url"], true)] }), /동의하지 않아/);
});
test("F7 앱이 꺼져 있으면 409", async () => {
  await no(ME, "apps/crm/x", "read", 409, world({ apps: new Map([["crm", app("crm", { enabled: false })]]) }));
  await no(ME, "apps/crm/x", "read", 409, world({ apps: new Map([["crm", app("crm", { status: "failed" })]]) }));
});
test("F8 남의 «나만» 앱 · 없는 앱 → 404", async () => {
  await no(ME, "apps/crm/x", "read", 404, world({ apps: new Map([["crm", app("crm", { visibility: "me", owner_member: "someone" })]]) }));
  await no(ME, "apps/ghost/x", "read", 404);
});
test("F9 사람 · apps 맨 위(목록 자리) 읽기 → 통과(목록은 부르는 쪽이 거른다)", async () => { await ok(ME, "apps", "read"); });
test("F10 관리자도 동의 없이는 앱 폴더를 못 본다(우회 없음)", async () => {
  await no({ member: "admin1", scopes: ["admin", "memory"] }, "apps/crm/x", "read", 403);
});

// ── 앱 주체 ─────────────────────────────────────────────────────────────────────
test("F11 앱 crm · 제 앱 폴더 읽기 · 쓰기(선언 + 동의 도구) → 통과", async () => {
  await ok(ASAPP, "apps/crm/out/a.png", "write");
  await ok(ASAPP, "apps/crm/out/a.png", "read");
});
test("F12 앱 crm · 남의 앱 폴더 → 403", async () => {
  await no(ASAPP, "apps/other/x", "read", 403, world(), /제 앱 폴더/);
  await no(ASAPP, "apps/other/x", "write", 403);
  await no(ASAPP, "apps", "read", 403);
});
test("F13 앱 crm · 공유 폴더 → 403 이고 공유 판정을 부르지도 않는다", async () => {
  const calls: string[] = [];
  await assert.rejects(() => authorizeFileAccess(ASAPP, parseAddress("shared/project/4670/a.md"), "read", deps(world(), calls)), (e: { status?: number }) => e.status === 403);
  assert.deepEqual(calls, [], "앱 주체는 공유 폴더 판정까지 가면 안 된다");
});
test("F14 앱 crm · 앱 폴더 선언 없음 → 403", async () => {
  await no(ASAPP, "apps/crm/x", "read", 403, world({ apps: new Map([["crm", app("crm", {}, { tools: ["store_query"] })]]) }), /app_folder/);
});
test("F14b 앱 crm · 도구 이름(file_url · *)만 있고 app_folder 선언이 없으면 403 — 선언은 app_folder 다", async () => {
  for (const tools of [["file_url"], ["*"]]) {
    const w = world({ apps: new Map([["crm", app("crm", {}, { tools })]]), grants: [grant("crm", "m1", tools)] });
    await no(ASAPP, "apps/crm/x", "read", 403, w, /app_folder/);
    await no(ASAPP, "apps/crm/x", "write", 403, w, /app_folder/);
  }
});
test("F15 앱 crm · 그 사람의 동의 없음 → 403", async () => {
  await no(ASAPP, "apps/crm/x", "write", 403, world({ grants: [] }), /동의/);
});
test("F16 앱 crm · 선언했는데 동의가 옛 범위 → 403(다시 동의)", async () => {
  await no(ASAPP, "apps/crm/x", "write", 403, world({ grants: [grant("crm", "m1", ["store_query"])] }), /다시 동의/);
});
test("F17 앱 crm · 꺼짐 → 409", async () => {
  await no(ASAPP, "apps/crm/x", "read", 409, world({ apps: new Map([["crm", app("crm", { enabled: false })]]) }));
});
test("F18 선언은 이 사람이 보는 판으로 본다 — 공개 판에 선언이 없으면 403", async () => {
  const w = world({ views: new Map([["crm", app("crm", {}, { tools: [] })]]) });
  await no(ASAPP, "apps/crm/x", "read", 403, w, /app_folder/);
});
test("F19 구성원 빈 값 → 401", async () => {
  await no({ member: "", scopes: [] }, "shared/x", "read", 401);
});
test("F20 공유 판정은 같은 이름의 유니코드 꼴(NFC · NFD) 전부에 건다 — 잠금이 어느 꼴로 적혀 있어도", async () => {
  const NFC = "영업/비공개", NFD = NFC.normalize("NFD");
  assert.notEqual(NFC, NFD, "시험 전제: 두 꼴의 글자가 달라야 한다");
  for (const [locked, asked] of [[NFC, NFD], [NFD, NFC], [NFC, NFC]] as const) {
    //  sharedFolderGate 처럼 글자 그대로 접두를 비교하는 판정기 — 잠긴 꼴만 막는다.
    const w = world({ shared: (_m, rel) => !(rel === locked || rel.startsWith(locked + "/")) });
    await no(ME, `shared/${asked}/x.txt`, "read", 404, w);
    await no(ME, `shared/${asked}/x.txt`, "write", 404, w);
  }
  //  허락된 사람(어느 꼴도 막히지 않음)은 지나간다 · 판정기는 꼴마다 불린다.
  const calls: string[] = [];
  await authorizeFileAccess(ME, parseAddress(`shared/${NFD}/x.txt`), "write", deps(world(), calls));
  assert.deepEqual(calls.filter((c) => c.startsWith("ok:")).sort(), [`ok:${NFC}/x.txt`, `ok:${NFD}/x.txt`].sort());
});

// ── 쓰기 대상 ───────────────────────────────────────────────────────────────────
test("W1~W5 쓰기 대상은 파일 경로여야 한다", () => {
  const bad = (a: string): void => assert.throws(() => assertWritableTarget(parseAddress(a)), (e: { status?: number }) => e.status === 400, a);
  bad("shared"); bad("apps"); bad("apps/crm");
  assertWritableTarget(parseAddress("shared/x"));
  assertWritableTarget(parseAddress("apps/crm/x"));
});

// ── 탐색기 목록 ─────────────────────────────────────────────────────────────────
test("R1~R5 탐색기 root=apps 목록 — 동의 · 켜짐 · 보임만", () => {
  const apps = [
    app("ok"), app("revoked"), app("off", { enabled: false }), app("mine-other", { visibility: "me", owner_member: "x" }),
    app("nogrant"), app("mine-me", { visibility: "me", owner_member: "m1" }),
  ];
  const grants = [grant("ok", "m1"), grant("revoked", "m1", [], true), grant("off", "m1"), grant("mine-other", "m1"), grant("mine-me", "m1")];
  assert.deepEqual([...readableAppFolders(ME, apps, grants)].sort(), ["mine-me", "ok"]);
  //  관리자는 남의 «나만» 앱도 볼 수 있는 사람이다(canSeeApp) — 동의가 있으면 목록에 선다.
  assert.deepEqual([...readableAppFolders({ member: "m1", scopes: ["admin"] }, apps, grants)].sort(), ["mine-me", "mine-other", "ok"]);
  assert.deepEqual([...readableAppFolders(ME, apps, [])], []);
});
