// 세션에 붙인 앱 폴더(#4684) — 무엇을 붙여 둘지(folderAppsFor) · 브로커에 맞추라고 알리기(syncSessionAppFolders).
//  행 번호는 태스크 #4684 의 lively 사양 표(L1~L9)와 같다.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  folderAppsFor, resyncIfChangedAfterCreate, resyncSessions, syncSessionAppFolders, createSlots, resyncConcurrencyFromEnv, appFolderSyncStats,
  afterSessionCreate, periodicOutcome, sweepAppFolders, PERIODIC_MAX_SESSIONS, PERIODIC_RECHECK_ABSENT_MS, PERIODIC_OLD_BROKER_PAUSE_MS,
  RESYNC_CONCURRENCY_DEFAULT, type FolderDeps, type FolderSync, type SyncDeps, type AppFolderNote, type PeriodicDeps,
} from "./session-app-folders.js";
import type { SessionAppRow, AppFolderRecord } from "./session-apps.js";
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
  //  두 번째는 첫 번째가 브로커에 간 **뒤에** 부른다 — 그 전에 부르면 아직 목록을 안 계산한 첫 번째에 합쳐진다(#4787 K1).
  await new Promise((r) => setTimeout(r, 10));
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


// ── 겹친 요청 합치기 · 묶음 전체 동시 수(#4787) — 행 번호는 #4787 사양 표(K1~K12 · 옛 브로커 멈춤은 L9b) ────────────────

/** 다음 매크로태스크까지 — 줄 기록 정리(finally)가 돈 뒤를 본다. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** 하나씩 풀 수 있는 문 — 브로커 왕복을 붙잡아 «도는 동안» 을 만든다. arrivals(n) = 누적 n 번째가 문 앞에 올 때까지. */
function gates() {
  const open: Array<() => void> = [];
  const watchers: Array<{ n: number; r: () => void }> = [];
  let arrived = 0;
  return {
    wait: (): Promise<void> => new Promise<void>((r) => {
      open.push(r); arrived++;
      for (let i = watchers.length - 1; i >= 0; i--) if (arrived >= watchers[i].n) watchers.splice(i, 1)[0].r();
    }),
    arrivals: (n: number): Promise<void> => (arrived >= n ? Promise.resolve() : new Promise<void>((r) => { watchers.push({ n, r }); })),
    release: (): void => { const f = open.shift(); if (f) f(); },
  };
}
/** 목록이 «사건 번호» 를 따라가는 맞추기 의존 — 브로커가 받은 목록을 차례로 적고, 지정한 왕복은 문에서 붙잡는다. */
function laneDeps(g: ReturnType<typeof gates>, hold: (k: number) => boolean) {
  const state = { ver: 1, sent: [] as string[][] };
  const d = syncDeps({
    apps: async () => [`v${state.ver}`],
    ensure: async (_argv, req) => {
      state.sent.push([...(req.apps ?? [])]);
      if (hold(state.sent.length)) await g.wait();
      return { container: "c", created: false, apps: { supported: true, bound: req.apps ?? [], failed: [] } };
    },
  });
  return { d, state };
}

test("K1·K2 ★ 같은 세션 — 첫 왕복이 도는 동안 사건 10번이 와도 브로커 왕복은 2번 · 둘째 목록이 최신 · 합쳐진 호출은 같은 결과", async () => {
  const g = gates();
  const { d, state } = laneDeps(g, (k) => k === 1);
  const first = syncSessionAppFolders("box-k1", d);
  await g.arrivals(1);                                   // 첫 왕복이 브로커에서 붙잡혔다(목록 v1 은 이미 계산됨)
  const later: Array<Promise<FolderSync>> = [];
  for (let v = 2; v <= 11; v++) { state.ver = v; later.push(syncSessionAppFolders("box-k1", d)); }
  g.release();
  const [r0, ...rs] = await Promise.all([first, ...later]);
  assert.deepEqual(state.sent, [["v1"], ["v11"]], "사건 수만큼 왕복했거나 마지막 목록이 최신이 아니다");
  assert.deepEqual(r0, { applied: true, supported: true, bound: ["v1"], failed: [] });
  for (const r of rs) assert.equal(r, rs[0], "합쳐진 호출이 같은 맞추기의 결과를 받지 않았다");
  assert.deepEqual(rs[0], { applied: true, supported: true, bound: ["v11"], failed: [] });
});

test("K3 기다리던 맞추기가 시작한 뒤에 온 사건은 한 번 더 줄을 선다(놓치지 않는다) — 그 목록이 최신", async () => {
  const g = gates();
  const { d, state } = laneDeps(g, (k) => k <= 2);
  const p1 = syncSessionAppFolders("box-k3", d);
  await g.arrivals(1);
  state.ver = 2;
  const p2 = syncSessionAppFolders("box-k3", d);
  g.release();
  await g.arrivals(2);                                   // 둘째 왕복(v2)이 붙잡혔다 — 이제 «도는 것» 이다
  state.ver = 3;
  const p3 = syncSessionAppFolders("box-k3", d);
  g.release();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(state.sent, [["v1"], ["v2"], ["v3"]]);
  assert.notEqual(p3, p2, "시작한 맞추기에 합치면 그 뒤의 변경을 잃는다");
});

test("K4·K5 서로 다른 세션은 합치지 않고 · 겹치지 않은 연속 사건은 각자 왕복한다", async () => {
  const g = gates();
  const { d, state } = laneDeps(g, () => true);
  const a = syncSessionAppFolders("box-k4a", d);
  const b = syncSessionAppFolders("box-k4b", d);
  await g.arrivals(2);
  assert.equal(state.sent.length, 2, "다른 세션의 맞추기가 합쳐졌거나 줄을 섰다");
  g.release(); g.release();
  await Promise.all([a, b]);
  const { d: d2, state: s2 } = laneDeps(g, () => false);
  await syncSessionAppFolders("box-k5", d2);
  await syncSessionAppFolders("box-k5", d2);
  assert.equal(s2.sent.length, 2, "끝난 맞추기에 합쳐 뒤 사건을 버렸다");
});

test("K6·K7 묶음 전체의 동시 브로커 왕복은 상한까지 — 상한 2 면 최대 2 · 상한 1(경계)이면 묶음끼리도 하나씩 · 모두 끝까지 간다", async () => {
  for (const max of [2, 1]) {
    let now = 0, peak = 0;
    const d = syncDeps({ ensure: async (_a, req) => {
      now++; peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return { container: "c", created: false, apps: { supported: true, bound: req.apps ?? [], failed: [] } };
    } });
    const slots = createSlots(max);
    const seen: string[] = [];
    const sync = (id: string): Promise<FolderSync> => { seen.push(id); return syncSessionAppFolders(id, d); };
    await Promise.all([1, 2, 3, 4].map((b) => resyncSessions([`box-k6-${max}-${b}a`, `box-k6-${max}-${b}b`], `묶음 ${b}`, sync, slots)));
    assert.equal(peak, max, `상한 ${max} 인데 동시 ${peak}`);
    assert.equal(seen.length, 8, "묶음 일부가 끝까지 가지 않았다");
    assert.deepEqual(slots.stats(), { active: 0, waiting: 0 });
  }
});

test("K8 묶음 안의 맞추기가 던지거나 error 여도 자리가 풀린다 — 상한 1 에서 뒤 묶음이 끝까지 간다", async () => {
  const slots = createSlots(1);
  const seen: string[] = [];
  const sync = async (id: string): Promise<FolderSync> => {
    seen.push(id);
    if (id === "box-k8-throw") throw new Error("boom");
    return { applied: false, reason: "error", detail: "허브 503" };
  };
  await Promise.all([resyncSessions(["box-k8-throw", "box-k8-err"], "앞", sync, slots), resyncSessions(["box-k8-next"], "뒤", sync, slots)]);
  assert.deepEqual([...seen].sort(), ["box-k8-err", "box-k8-next", "box-k8-throw"]);
  assert.deepEqual(slots.stats(), { active: 0, waiting: 0 });
});

test("K9 ★ 같은 세션들을 두 묶음이 함께 돈다(앱 끄기 + 공개 바꾸기) — 세션마다 브로커 왕복은 2번 이하", async () => {
  const perSession = new Map<string, number>();
  const d = syncDeps({ ensure: async (_a, req) => {
    perSession.set(req.sessionId, (perSession.get(req.sessionId) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, 5));
    return { container: "c", created: false, apps: { supported: true, bound: req.apps ?? [], failed: [] } };
  } });
  const ids = ["box-k9a", "box-k9b", "box-k9c"];
  const sync = (id: string): Promise<FolderSync> => syncSessionAppFolders(id, d);
  const slots = createSlots(4);
  await Promise.all([resyncSessions(ids, "앱 끔", sync, slots), resyncSessions(ids, "공개", sync, slots), resyncSessions(ids, "동의 회수", sync, slots)]);
  for (const id of ids) {
    const n = perSession.get(id) ?? 0;
    assert.ok(n >= 1 && n <= 2, `${id} 왕복 ${n}번`);
  }
});

test("K10 붙이기 · 떼기(묶음 밖 호출)는 게이트웨이의 묶음 자리가 다 차 있어도 기다리지 않는다", async () => {
  //  운영과 같은 자리(기본 slots — 게이트웨이 하나에 하나)를 묶음으로 다 채운다. 자리 수는 그 자리를 만든 것과 같은 자(env)로 읽는다.
  const g = gates();
  const full = resyncConcurrencyFromEnv();
  const blocked = Array.from({ length: full }, (_, i) =>
    resyncSessions([`box-k10-batch${i}`], "묶음", async () => { await g.wait(); return { applied: false, reason: "not-running" }; }));
  await g.arrivals(full);
  assert.deepEqual(appFolderSyncStats().resync, { active: full, waiting: 0 }, "묶음이 기본 자리를 다 채우지 못했다 — 시험 전제가 깨졌다");
  const d = syncDeps();
  const r = await Promise.race([syncSessionAppFolders("box-k10-attach", d), new Promise<string>((res) => setTimeout(() => res("기다렸다"), 200))]);
  assert.notEqual(r, "기다렸다", "붙이기 응답이 묶음 줄 뒤에 섰다");
  assert.equal(d.sent.length, 1);
  for (let i = 0; i < full; i++) g.release();
  await Promise.all(blocked);
});

test("K11 LIVELY_APP_FOLDER_RESYNC_CONCURRENCY — 없음 · 이상함 · 0 · 음수는 기본 4 · 1 · 16 · 17→16 · 소수는 내림", () => {
  const cases: Array<[string | undefined, number]> = [[undefined, 4], ["", 4], ["abc", 4], ["0", 4], ["-3", 4], ["1", 1], ["16", 16], ["17", 16], ["2.7", 2], [" 3 ", 3]];
  for (const [v, want] of cases) {
    const env = v === undefined ? {} : { LIVELY_APP_FOLDER_RESYNC_CONCURRENCY: v };
    assert.equal(resyncConcurrencyFromEnv(env as NodeJS.ProcessEnv), want, `값 ${JSON.stringify(v)}`);
  }
  assert.equal(RESYNC_CONCURRENCY_DEFAULT, 4);
});

test("K12 다 끝난 뒤엔 줄 기록이 남지 않는다(세션마다 쌓이면 누수다)", async () => {
  const d = syncDeps();
  await Promise.all(["box-k12a", "box-k12b", "box-k12a", "box-k12a"].map((id) => syncSessionAppFolders(id, d)));
  await tick(); await tick();
  assert.equal(appFolderSyncStats().lanes, 0);
  assert.deepEqual(appFolderSyncStats().resync, { active: 0, waiting: 0 });
});

// ── 주기 재조정(#4786) — 행 번호는 #4786 사양 표(R · C · S) ─────────────────────────────────────

/** 맞춘 기록을 받아 적는 맞추기 의존. */
function recordingDeps(over: Partial<SyncDeps> = {}) {
  const notes: Array<{ id: string; note: AppFolderNote }> = [];
  const d = syncDeps({ record: async (id, note) => { notes.push({ id, note }); }, ...over });
  return { d, notes };
}

test("R1~R3 브로커가 답하면 그대로 남긴다 — 다 맞춤 ok · 일부 실패 failed(사유) · 접점 없는 옛 컨테이너 unsupported(bound [])", async () => {
  const ok = recordingDeps();
  await syncSessionAppFolders("box-r1", ok.d);
  assert.deepEqual(ok.notes, [{ id: "box-r1", note: { bound: ["crm"], state: "ok" } }]);
  const part = recordingDeps({ ensure: async () => ({ container: "c", created: false, apps: { supported: true, bound: ["memo"], failed: [{ app: "crm", why: "링크다" }] } }) });
  await syncSessionAppFolders("box-r2", part.d);
  assert.equal(part.notes[0].note.state, "failed");
  assert.deepEqual(part.notes[0].note.bound, ["memo"]);
  assert.match(String(part.notes[0].note.detail), /crm: 링크다/);
  const old = recordingDeps({ ensure: async () => ({ container: "c", created: false, apps: { supported: false, bound: [], failed: [] } }) });
  await syncSessionAppFolders("box-r3", old.d);
  assert.deepEqual([old.notes[0].note.state, old.notes[0].note.bound], ["unsupported", []]);
});

test("R4 컨테이너가 없다고 답하면 not-running(bound []) · 끝났거나 이어졌거나 주인을 모르면 브로커를 안 불렀으니 남기지 않는다", async () => {
  const gone = recordingDeps({ ensure: async () => { throw new Error(`브로커가 거절했다(404): ${"LVLY_NO_SESSION_CONTAINER"}`); } });
  await syncSessionAppFolders("box-r4", gone.d);
  assert.deepEqual(gone.notes, [{ id: "box-r4", note: { bound: [], state: "not-running" } }]);
  for (const over of [{ state: async () => ({ dir: "/x", exited_at: "2026-10-16T00:00:00Z" }) }, { state: async () => ({ dir: "/x", superseded_by: "box-n" }) }, { osUser: async () => null }] as Array<Partial<SyncDeps>>) {
    const skip = recordingDeps(over);
    await syncSessionAppFolders("box-r4b", skip.d);
    assert.equal(skip.notes.length, 0, "브로커에 묻지 않은 결과를 남겼다");
  }
});

test("R5·R6 실패 · 옛 브로커는 bound 를 모른다(null — 지난 기록 그대로) · 목록 판정이 던져도 error 로 남긴다", async () => {
  const err = recordingDeps({ ensure: async () => { throw new Error("허브 503"); } });
  await syncSessionAppFolders("box-r5", err.d);
  assert.deepEqual([err.notes[0].note.state, err.notes[0].note.bound], ["error", null]);
  assert.match(String(err.notes[0].note.detail), /허브 503/);
  const owner = recordingDeps({ apps: async () => { throw new Error("db down"); } });
  await syncSessionAppFolders("box-r5b", owner.d);
  assert.deepEqual([owner.notes[0].note.state, owner.notes[0].note.bound], ["error", null]);
  const old = recordingDeps({ ensure: async () => ({ container: "c", created: true }) });
  await syncSessionAppFolders("box-r6", old.d);
  assert.deepEqual([old.notes[0].note.state, old.notes[0].note.bound], ["old-broker", null]);
});

test("R7·R8 매니지드가 아니면 남기지 않고 · 기록이 던져도 맞추기 결과는 그대로다", async () => {
  const self = recordingDeps({ managed: () => false });
  assert.deepEqual(await syncSessionAppFolders("box-r7", self.d), { applied: false, reason: "not-managed" });
  assert.equal(self.notes.length, 0);
  const boom = syncDeps({ record: async () => { throw new Error("db down"); } });
  assert.deepEqual(await syncSessionAppFolders("box-r8", boom), { applied: true, supported: true, bound: ["crm"], failed: [] });
});

test("C1~C4 세션을 만든 직후의 기록 — 응답대로 · 빈 목록이면 ok [] · 목록을 못 읽었으면 error(맞추기 안 함) · 실었는데 응답에 apps 가 없으면 옛 브로커", async () => {
  const run = async (sent: readonly string[] | undefined, made: unknown) => {
    const calls: string[] = [];
    const notes: AppFolderNote[] = [];
    await afterSessionCreate("box-c", sent, made, {
      record: async (_id, n) => { calls.push("record"); notes.push(n); },
      resync: async (_id, s) => { calls.push(`resync:${s.join(",")}`); },
    });
    return { calls, note: notes[0] };
  };
  const c1 = await run(["crm"], { supported: true, bound: ["crm"], failed: [] });
  assert.deepEqual(c1.note, { bound: ["crm"], state: "ok" });
  assert.deepEqual(c1.calls, ["record", "resync:crm"], "기록 → 맞추기 순서여야 맞추기의 기록이 이긴다");
  assert.equal((await run(["crm"], { supported: true, bound: [], failed: [{ app: "crm", why: "x" }] })).note.state, "failed");
  assert.equal((await run(["crm"], { supported: false, bound: [], failed: [] })).note.state, "unsupported");
  const c2 = await run([], undefined);
  assert.deepEqual(c2.note, { bound: [], state: "ok" });
  const c3 = await run(undefined, undefined);
  assert.deepEqual([c3.note.state, c3.note.bound], ["error", []]);
  assert.deepEqual(c3.calls, ["record"], "목록을 못 읽었으면 견줄 것이 없다 — 맞추기는 주기 판이 한다");
  const c4 = await run(["crm"], undefined);
  assert.deepEqual([c4.note.state, c4.note.bound], ["old-broker", []]);
  //  기록이 던져도 맞추기는 간다 · 던지지 않는다.
  const calls: string[] = [];
  await afterSessionCreate("box-c", ["crm"], undefined, { record: async () => { throw new Error("db down"); }, resync: async () => { calls.push("resync"); } });
  assert.deepEqual(calls, ["resync"]);
});

const rec = (state: AppFolderRecord["state"], bound: string[]): AppFolderRecord => ({ session_id: "box-s", bound, state, checked_at: "2026-10-16T00:00:00Z" });
const okSync = (bound: string[]): FolderSync => ({ applied: true, supported: true, bound, failed: [] });

test("S4 주기 맞추기 결과 가르기(순수) — 처음 · 그대로 · 고침 · 실패 · 컨테이너 없음 · 옛 브로커", () => {
  const cases: Array<[AppFolderRecord | null, FolderSync, string]> = [
    [null, okSync(["crm"]), "first"],
    [rec("not-running", []), okSync(["crm"]), "first"],
    [rec("unsupported", []), okSync(["crm"]), "first"],
    [rec("old-broker", ["crm"]), okSync(["crm"]), "first"],
    [rec("ok", ["crm"]), okSync(["crm"]), "ok"],
    [rec("ok", ["crm", "memo"]), okSync(["memo", "crm"]), "ok"],
    [rec("ok", ["crm"]), okSync([]), "fixed"],
    [rec("ok", []), okSync(["crm"]), "fixed"],
    [rec("ok", ["crm"]), okSync(["memo"]), "fixed"],
    [rec("error", ["crm"]), okSync(["crm"]), "fixed"],
    [rec("failed", ["crm"]), okSync(["crm"]), "fixed"],
    [rec("ok", ["crm"]), { applied: true, supported: true, bound: [], failed: [{ app: "crm", why: "x" }] }, "failed"],
    [rec("ok", ["crm"]), { applied: true, supported: false, bound: [], failed: [] }, "gone"],
    [rec("ok", ["crm"]), { applied: false, reason: "not-running" }, "gone"],
    [rec("ok", ["crm"]), { applied: false, reason: "not-managed" }, "gone"],
    [rec("ok", ["crm"]), { applied: false, reason: "error", detail: "x" }, "failed"],
    [null, { applied: false, reason: "old-broker", detail: "x" }, "old-broker"],
  ];
  for (const [prev, r, want] of cases) assert.equal(periodicOutcome(prev, r), want, JSON.stringify({ prev, r }));
});

/** 주기 판 의존 — 대상과 결과를 표로 준다. */
function periodicDeps(slug: string, rows: Array<{ id: string; prev: AppFolderRecord | null; r: FolderSync }>, over: Partial<PeriodicDeps> = {}) {
  const seen = { prune: 0, targets: [] as Array<[number, number]>, synced: [] as string[], fixed: [] as string[] };
  let clock = 1_000_000;
  const d: PeriodicDeps & { advance: (ms: number) => void } = {
    advance: (ms) => { clock += ms; },
    slug: () => slug,
    managed: () => true,
    now: () => clock,
    prune: async () => { seen.prune++; return 2; },
    targets: async (limit, recheck) => { seen.targets.push([limit, recheck]); return rows.map((x) => ({ session_id: x.id, prev: x.prev })); },
    sync: async (id) => { seen.synced.push(id); return rows.find((x) => x.id === id)!.r; },
    markFixed: async (id) => { seen.fixed.push(id); },
    slots: createSlots(4),
    ...over,
  };
  return { d, seen };
}

test("S4b 한 판 — 대상 수 · 결과별 수 · 지운 기록 수를 돌려주고 고친 세션만 고친 횟수를 올린다 · 한도와 다시 보는 간격을 넘긴다", async () => {
  const { d, seen } = periodicDeps("acme-s4", [
    { id: "box-a", prev: null, r: okSync(["crm"]) },
    { id: "box-b", prev: rec("ok", ["crm"]), r: okSync(["crm"]) },
    { id: "box-c", prev: rec("error", ["crm"]), r: okSync([]) },
    { id: "box-d", prev: rec("ok", ["crm"]), r: { applied: false, reason: "error", detail: "허브 503" } },
    { id: "box-e", prev: rec("ok", ["crm"]), r: { applied: false, reason: "not-running" } },
  ]);
  const s = await sweepAppFolders(d);
  assert.deepEqual(s, { targets: 5, ok: 1, fixed: 1, first: 1, failed: 1, gone: 1, pruned: 2 });
  assert.deepEqual(seen.fixed, ["box-c"]);
  assert.deepEqual(seen.targets, [[PERIODIC_MAX_SESSIONS, PERIODIC_RECHECK_ABSENT_MS]]);
  assert.equal(PERIODIC_MAX_SESSIONS, 50);
  assert.equal(PERIODIC_RECHECK_ABSENT_MS, 30 * 60_000);
  //  기록 정리가 던져도 판은 간다.
  const { d: d2, seen: s2 } = periodicDeps("acme-s4b", [{ id: "box-a", prev: null, r: okSync([]) }], { prune: async () => { throw new Error("db down"); } });
  assert.deepEqual(await sweepAppFolders(d2), { targets: 1, ok: 0, fixed: 0, first: 1, failed: 0, gone: 0, pruned: 0 });
  assert.deepEqual(s2.synced, ["box-a"]);
});

test("S1 매니지드가 아니거나 워크스페이스가 없으면 아무것도 안 한다(정리 · 대상 조회도 안 함)", async () => {
  for (const over of [{ slug: () => null }, { managed: () => false }] as Array<Partial<PeriodicDeps>>) {
    const { d, seen } = periodicDeps("acme-s1", [{ id: "box-a", prev: null, r: okSync([]) }], over);
    assert.equal((await sweepAppFolders(d)).skipped, "not-managed");
    assert.deepEqual([seen.prune, seen.targets.length, seen.synced.length], [0, 0, 0]);
  }
});

test("S2 같은 워크스페이스의 앞 판이 아직 돌면 이번 판은 건너뛴다 · 다른 워크스페이스는 돈다 · 끝나면 다시 돈다", async () => {
  const g = gates();
  const { d } = periodicDeps("acme-s2", [{ id: "box-a", prev: null, r: okSync([]) }], { sync: async () => { await g.wait(); return okSync([]); } });
  const first = sweepAppFolders(d);
  await g.arrivals(1);
  assert.equal((await sweepAppFolders(d)).skipped, "running");
  const other = periodicDeps("acme-s2-other", [{ id: "box-b", prev: null, r: okSync([]) }]);
  assert.equal((await sweepAppFolders(other.d)).skipped, undefined);
  g.release();
  await first;
  const again = periodicDeps("acme-s2", [{ id: "box-a", prev: null, r: okSync([]) }]);
  assert.equal((await sweepAppFolders(again.d)).skipped, undefined, "판이 끝났는데 다음 판이 막혔다");
});

test("S3 ★ 옛 브로커를 만나면 그 판을 멈추고(남은 세션 안 부름) 그 워크스페이스는 한 시간 쉰다 · 지나면 다시 돈다", async () => {
  const rows = [
    { id: "box-a", prev: null, r: { applied: false, reason: "old-broker", detail: "x" } as FolderSync },
    { id: "box-b", prev: null, r: okSync([]) },
  ];
  const { d, seen } = periodicDeps("acme-s3", rows);
  const s = await sweepAppFolders(d);
  assert.equal(s.stopped, true);
  assert.deepEqual(seen.synced, ["box-a"], "옛 브로커 뒤 세션을 불렀다 — 그 세션마다 컨테이너를 만들 수 있다");
  d.advance(PERIODIC_OLD_BROKER_PAUSE_MS - 1);
  assert.equal((await sweepAppFolders(d)).skipped, "old-broker");
  d.advance(1);
  const after = await sweepAppFolders(d);
  assert.equal(after.skipped, undefined);
  assert.equal(PERIODIC_OLD_BROKER_PAUSE_MS, 60 * 60_000);
});
