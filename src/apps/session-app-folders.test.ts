// 세션에 붙인 앱 폴더(#4684) — 무엇을 붙여 둘지(folderAppsFor) · 브로커에 맞추라고 알리기(syncSessionAppFolders).
//  행 번호는 태스크 #4684 의 lively 사양 표(L1~L9)와 같다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { folderAppsFor, resyncIfChangedAfterCreate, resyncSessions, syncSessionAppFolders, type FolderDeps, type FolderSync, type SyncDeps } from "./session-app-folders.js";
import type { SessionAppRow } from "./session-apps.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";
import type { SessionEnsureRequest } from "../terminal/session-tmux.js";

const app = (id: string, over: Partial<OrgApp> = {}): OrgApp => ({
  id, title: id, version: "1.0.0", manifest: {}, source: { kind: "installed" }, content_hash: null,
  status: "active", enabled: true, installed_by: "alice", installed_at: "", updated_at: "", updated_by: null, edit_mode: "all", edit_members: [],
  builtin_version: null, current_version_no: null, visibility: "all", published_version_no: null, published_at: null, published_by: null, draft_by: null, made_by: null, owner_member: null, build_session: null, origin_app_id: null, ...over,
});
const grant = (appId: string, member: string): AppGrantRow => ({ app_id: appId, member_id: member, scopes: [], tools: [], granted_at: "", granted_by: null, revoked_at: null });
const row = (appId: string, member = "alice"): SessionAppRow => ({ session_id: "box-a", app_id: appId, member_id: member, attached_at: "" });

function folderDeps(rows: SessionAppRow[], apps: Record<string, OrgApp | null>, grants: Array<[string, string]>, o: { owner?: string | null; invited?: string[] } = {}): FolderDeps {
  const owner = o.owner === undefined ? "alice" : o.owner;
  return {
    listAttached: async () => rows,
    getApp: async (id) => apps[id] ?? null,
    getGrant: async (id, m) => (grants.some(([a, b]) => a === id && b === m) ? grant(id, m) : null),
    sessionOwner: async () => owner,
    canEnter: async (_sid, m) => (o.invited ?? ["bob"]).includes(m),
  };
}

// ── 무엇을 붙여 둘지 ─────────────────────────────────────────────────────────

test("L1 붙은 앱 중 쓸 수 있는 것만 — 꺼진·설치 중·없는 앱 · 동의가 없는 사람(초대받은 bob)이 붙인 것은 빠진다", async () => {
  const d = folderDeps(
    [row("crm"), row("memo"), row("off"), row("busy"), row("gone"), row("nogrant", "bob")],
    { crm: app("crm"), memo: app("memo"), off: app("off", { enabled: false }), busy: app("busy", { status: "installing" }), gone: null, nogrant: app("nogrant") },
    [["crm", "alice"], ["memo", "alice"], ["off", "alice"], ["busy", "alice"], ["gone", "alice"]],
  );
  assert.deepEqual(await folderAppsFor("box-a", d), ["crm", "memo"]);
});

test("L2 붙인 사람이 못 보는 앱(남의 «나만» 앱)은 빠진다 · 책임자 자신의 «나만» 앱은 남는다", async () => {
  const d = folderDeps(
    [row("mine"), row("theirs")],
    { mine: app("mine", { visibility: "me", owner_member: "alice", made_by: "alice" }), theirs: app("theirs", { visibility: "me", owner_member: "carol", made_by: "carol" }) },
    [["mine", "alice"], ["theirs", "alice"]],
  );
  assert.deepEqual(await folderAppsFor("box-a", d), ["mine"]);
});

test("L2b ★ 초대받은 사람이 자기 «나만» 앱을 주인 세션에 붙여도 폴더는 안 열린다 — 폴더는 그 세션의 모두가 본다(주인이 못 보는 앱)", async () => {
  const d = folderDeps(
    [row("bobs", "bob"), row("shared", "bob")],
    { bobs: app("bobs", { visibility: "me", owner_member: "bob", made_by: "bob" }), shared: app("shared") },
    [["bobs", "bob"], ["shared", "bob"]],
  );
  assert.deepEqual(await folderAppsFor("box-a", d), ["shared"], "공개 앱은 초대받은 사람이 붙여도 열린다");
});

test("L2c 붙인 사람이 이제 그 세션에 못 들어가면(초대가 풀림) 빠진다 · 주인을 모르면 아무것도 안 붙인다", async () => {
  const gone = folderDeps([row("crm", "bob")], { crm: app("crm") }, [["crm", "bob"]], { invited: [] });
  assert.deepEqual(await folderAppsFor("box-a", gone), []);
  //  주인 말고는 다 통과하는 기록(공개 앱 · 초대받은 bob · 동의 있음) — 주인을 모른다는 것만으로 빠져야 한다.
  const noOwner = folderDeps([row("crm", "bob")], { crm: app("crm") }, [["crm", "bob"]], { owner: null });
  assert.deepEqual(await folderAppsFor("box-a", noOwner), []);
  const known = folderDeps([row("crm", "bob")], { crm: app("crm") }, [["crm", "bob"]]);
  assert.deepEqual(await folderAppsFor("box-a", known), ["crm"], "대조군: 주인을 알면 열린다");
});

test("L2d ★ 주인의 «나만» 앱을 초대받은 사람이 붙였으면 빠진다 — 붙인 사람이 그 앱을 못 본다(책임자가 «나만» 으로 바꾼 뒤의 다시 맞추기)", async () => {
  const mine = app("alices", { visibility: "me", owner_member: "alice", made_by: "alice" });
  const byBob = folderDeps([row("alices", "bob")], { alices: mine }, [["alices", "bob"]]);
  assert.deepEqual(await folderAppsFor("box-a", byBob), []);
  const byAlice = folderDeps([row("alices", "alice")], { alices: mine }, [["alices", "alice"]]);
  assert.deepEqual(await folderAppsFor("box-a", byAlice), ["alices"], "대조군: 주인이 붙였으면 열린다");
});

test("L2e 주인 조회가 **실패**하면 [] 로 접지 않고 던진다 — 맞추기는 브로커를 안 불러 도는 세션의 폴더를 모두 떼지 않는다", async () => {
  const d: FolderDeps = { ...folderDeps([row("crm")], { crm: app("crm") }, [["crm", "alice"]]), sessionOwner: async () => { throw new Error("db down"); } };
  await assert.rejects(() => folderAppsFor("box-a", d), /db down/);
  const s = syncDeps({ apps: (id) => folderAppsFor(id, d) });
  const r = await syncSessionAppFolders("box-f", s);
  assert.equal((r as { reason: string }).reason, "error");
  assert.equal(s.sent.length, 0, "모르는 채로 «붙일 것 없음» 을 보내면 도는 세션의 앱 폴더가 다 떨어진다");
});

test("L3 앱 id 형식 밖은 버린다 · 조회 실패는 빠진다(모르면 안 붙인다)", async () => {
  const d: FolderDeps = {
    listAttached: async () => [row("crm"), row("Bad_Id"), row("flaky")],
    getApp: async (id) => { if (id === "flaky") throw new Error("db down"); return app(id); },
    getGrant: async (id, m) => grant(id, m),
    sessionOwner: async () => "alice",
    canEnter: async () => false,
  };
  assert.deepEqual(await folderAppsFor("box-a", d), ["crm"]);
});

// ── 브로커에 맞추라고 알리기 ──────────────────────────────────────────────────

function syncDeps(over: Partial<SyncDeps> = {}): SyncDeps & { sent: Array<{ argv: readonly string[]; req: SessionEnsureRequest }> } {
  const sent: Array<{ argv: readonly string[]; req: SessionEnsureRequest }> = [];
  return {
    sent,
    slug: () => "acme",
    managed: () => true,
    state: async () => ({ dir: "/work/shared/project/7", node_id: null }),
    osUser: async () => "box_alice",
    apps: async () => ["crm"],
    ensure: async (argv, req) => { sent.push({ argv, req }); return { container: "lvly-s-acme-slot-1", created: false, apps: { supported: true, bound: ["crm"], failed: [] } }; },
    ...over,
  };
}

test("L4 매니지드가 아니면(셀프호스트·테넌트 없음·노드 세션) 브로커를 부르지 않는다", async () => {
  for (const over of [{ slug: () => null }, { managed: () => false }, { state: async () => ({ dir: "/x", node_id: "node-1" }) }] as Array<Partial<SyncDeps>>) {
    const d = syncDeps(over);
    assert.deepEqual(await syncSessionAppFolders("box-a", d), { applied: false, reason: "not-managed" });
    assert.equal(d.sent.length, 0);
  }
});

test("L5 붙이기·떼기는 «만들지 않는» 확보로 보낸다 — 목록 · 작업 폴더 · tmux 안쪽 · noCreate", async () => {
  const d = syncDeps();
  const r = await syncSessionAppFolders("box-a", d);
  assert.deepEqual(r, { applied: true, supported: true, bound: ["crm"], failed: [] });
  assert.equal(d.sent.length, 1);
  const { req } = d.sent[0];
  assert.equal(req.noCreate, true, "noCreate 가 빠지면 끝난 세션을 되살린다");
  assert.deepEqual(req.apps, ["crm"]);
  assert.equal(req.sessionId, "box-a");
  assert.equal(req.cwd, "/work/shared/project/7");
  assert.equal(req.tmux, "inside");
  assert.ok(!("fresh" in req) || !req.fresh, "붙이기가 새 자리를 청하면 안 된다");
});

test("L6 도는 컨테이너가 없으면 not-running(다음 확보가 붙인다) · 주인을 모르면 부르지 않는다", async () => {
  const d = syncDeps({ ensure: async () => { throw new Error("세션 컨테이너 확보 실패(훅 종료코드 1): lvly session-ensure-relay: 브로커가 거절했다(404): LVLY_NO_SESSION_CONTAINER: 이 노드에 …"); } });
  assert.deepEqual(await syncSessionAppFolders("box-a", d), { applied: false, reason: "not-running" });
  const d2 = syncDeps({ osUser: async () => null });
  const r2 = await syncSessionAppFolders("box-a", d2);
  assert.equal(r2.applied, false);
  assert.equal((r2 as { reason: string }).reason, "not-running");
  assert.equal(d2.sent.length, 0);
});

test("L7 다른 실패는 error 로 돌려주고 던지지 않는다(의존이 던져도)", async () => {
  const d = syncDeps({ ensure: async () => { throw new Error("허브 503"); } });
  const r = await syncSessionAppFolders("box-a", d);
  assert.equal(r.applied, false);
  assert.equal((r as { reason: string }).reason, "error");
  const boom = syncDeps({ osUser: async () => { throw new Error("tmux 없음"); } });
  assert.equal(((await syncSessionAppFolders("box-b", boom)) as { reason: string }).reason, "error");
});

test("L7b ★ 옛 브로커 — noCreate 를 몰라 새로 만들었거나(created) 앱 폴더를 모르면(apps 없음) old-broker", async () => {
  const made = syncDeps({ ensure: async () => ({ container: "lvly-s-acme-1", created: true }) });
  const r1 = await syncSessionAppFolders("box-a", made);
  assert.equal((r1 as { reason: string }).reason, "old-broker");
  assert.match(String((r1 as { detail?: string }).detail), /새로 만들었다/);
  const plain = syncDeps({ ensure: async () => ({ container: "lvly-s-acme-1", created: false }) });
  assert.equal(((await syncSessionAppFolders("box-c", plain)) as { reason: string }).reason, "old-broker");
});

test("L7c 끝났거나(사람이 닫음) 다른 id 로 이어진 세션엔 브로커를 부르지 않는다", async () => {
  for (const st of [{ dir: "/x", exited_at: "2026-10-15T00:00:00Z" }, { dir: "/x", superseded_by: "box-new" }]) {
    const d = syncDeps({ state: async () => st });
    assert.deepEqual(await syncSessionAppFolders("box-d", d), { applied: false, reason: "not-running" });
    assert.equal(d.sent.length, 0, "끝난 세션을 옛 브로커에 보내면 컨테이너를 만든다");
  }
});

test("L7d 같은 세션의 맞추기는 한 줄로 — 먼저 시작한 것이 끝난 뒤에 다음 것이 브로커에 간다", async () => {
  const order: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  const d = syncDeps({
    ensure: async (_argv, req) => {
      const k = ++n;
      order.push(`start${k}:${(req.apps ?? []).join(",")}`);
      if (k === 1) await gate;
      order.push(`end${k}`);
      return { container: "c", created: false, apps: { supported: true, bound: req.apps ?? [], failed: [] } };
    },
  });
  let lists = 0;
  const d1 = { ...d, apps: async () => (++lists === 1 ? ["old"] : ["new"]) };
  const p1 = syncSessionAppFolders("box-e", d1);
  const p2 = syncSessionAppFolders("box-e", d1);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["start1:old"], "두 번째가 첫 번째를 기다리지 않았다");
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["start1:old", "end1", "start2:new", "end2"]);
});

test("L8 브로커가 말한 실패·미지원을 그대로 옮긴다", async () => {
  const d = syncDeps({ ensure: async () => ({ container: "c", created: false, apps: { supported: false, bound: [], failed: [{ app: "crm", why: "링크다" }] } }) });
  assert.deepEqual(await syncSessionAppFolders("box-a", d), { applied: true, supported: false, bound: [], failed: [{ app: "crm", why: "링크다" }] });
});

test("L9b ★ 다시 맞추기 묶음은 옛 브로커를 만나면 그 자리에서 멈춘다(남은 세션마다 컨테이너를 만들 수 있다)", async () => {
  const seen: string[] = [];
  const sync = async (id: string): Promise<FolderSync> => {
    seen.push(id);
    return id === "box-a" ? { applied: false, reason: "old-broker", detail: "x" } : { applied: false, reason: "not-running" };
  };
  await resyncSessions(["box-a", "box-b", "box-c"], "시험", sync);
  assert.deepEqual(seen, ["box-a"]);
});

test("L9 여러 세션 다시 맞추기 — 세션마다 한 번 · 하나가 던져도 나머지는 간다", async () => {
  const seen: string[] = [];
  const sync = async (id: string): Promise<FolderSync> => {
    seen.push(id);
    if (id === "box-b") throw new Error("boom");
    return { applied: false, reason: "not-running" };
  };
  await resyncSessions(["box-a", "box-b", "box-a", "box-c"], "시험", sync);
  assert.deepEqual(seen, ["box-a", "box-b", "box-c"]);
});

test("L10 만든 직후 — 실은 목록과 지금 목록이 같으면 브로커를 부르지 않고, 다르면(만드는 사이 붙이거나 뗌) 한 번 맞춘다", async () => {
  const synced: string[] = [];
  const sync = async (id: string): Promise<FolderSync> => { synced.push(id); return { applied: true, supported: true, bound: [], failed: [] }; };
  await resyncIfChangedAfterCreate("box-a", ["memo", "crm"], { apps: async () => ["crm", "memo"], sync });
  assert.deepEqual(synced, [], "같은 목록인데 왕복했다");
  await resyncIfChangedAfterCreate("box-a", ["crm"], { apps: async () => ["crm", "memo"], sync });
  assert.deepEqual(synced, ["box-a"]);
  //  목록을 못 읽어도 던지지 않는다(세션 생성은 이미 끝났다).
  await resyncIfChangedAfterCreate("box-b", ["crm"], { apps: async () => { throw new Error("db down"); }, sync });
  assert.deepEqual(synced, ["box-a"]);
});

