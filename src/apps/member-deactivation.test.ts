// 멤버 비활성 전이 → 앱 발자국 회수(#1780 v2 §7-1) — 사양 H5. deps 주입으로 부작용을 관측한다(무엇이 실제로 불렸나).
import { strict as assert } from "node:assert";
import test from "node:test";
import { reclaimMemberAppFootprint, type ReclaimDeps, type ReclaimSessionRow } from "./member-deactivation.js";

function fakes(rows: ReclaimSessionRow[], opts?: { failCentral?: string[] }) {
  const calls = { revoke: [] as string[], workers: [] as string[], central: [] as string[], node: [] as string[], deleted: [] as string[], list: [] as string[] };
  const deps: ReclaimDeps = {
    revokeGrants: async (m) => { calls.revoke.push(m); return 2; },
    listSessions: async (o) => { calls.list.push(o); return rows; },
    killCentral: async (id) => { if (opts?.failCentral?.includes(id)) throw new Error("tmux 죽음"); calls.central.push(id); },
    killNode: async (n, id) => { calls.node.push(`${n}:${id}`); },
    deleteState: async (id) => { calls.deleted.push(id); },
    stopWorkers: async (m) => { calls.workers.push(m); return 1; },
  };
  return { deps, calls };
}

test("앱 세션만 회수하고 일반 세션은 건드리지 않는다 · grant 는 멤버 단위로 전부 회수", async () => {
  const { deps, calls } = fakes([
    { id: "s-app", app_id: "browser" },
    { id: "s-plain", app_id: null },
    { id: "s-app-node", app_id: "hello", node_id: "mac-1" },
  ]);
  const r = await reclaimMemberAppFootprint("jieun", deps);
  assert.deepEqual(calls.revoke, ["jieun"], "grant 회수는 멤버 단위 1회");
  assert.deepEqual(calls.workers, ["jieun"], "별도 worker도 멤버 단위로 회수");
  assert.deepEqual(calls.list, ["jieun"], "세션 목록은 owner=멤버 로 조회");
  assert.deepEqual(calls.central, ["s-app"], "중앙 앱 세션만 중앙 kill");
  assert.deepEqual(calls.node, ["mac-1:s-app-node"], "노드 앱 세션은 그 노드로 kill");
  assert.deepEqual(calls.deleted.sort(), ["s-app", "s-app-node"], "회수한 앱 세션의 상태행 삭제(복원 카드 없음)");
  assert.ok(!calls.deleted.includes("s-plain") && !calls.central.includes("s-plain"), "일반 세션은 무변경");
  assert.deepEqual(r, { grants: 2, workers: 1, sessions: ["s-app", "s-app-node"], failed: [] });
});

test("한 세션의 kill 실패는 나머지 회수를 막지 않는다(failed 에 격리)", async () => {
  const { deps, calls } = fakes([{ id: "a", app_id: "x" }, { id: "b", app_id: "x" }], { failCentral: ["a"] });
  const r = await reclaimMemberAppFootprint("m", deps);
  assert.deepEqual(r.failed, ["a"]);
  assert.deepEqual(r.sessions, ["b"]);
  assert.deepEqual(calls.deleted, ["b"], "실패한 세션의 상태행은 지우지 않는다(다음 회수 기회 보존)");
});

test("#5081 공용 시트 지정도 지운다 · 지운 줄이 있으면 결과에 표시 · 실패해도 나머지 회수는 돈다", async () => {
  const dropped: string[] = [];
  const { deps, calls } = fakes([{ id: "s-app", app_id: "x" }]);
  const r = await reclaimMemberAppFootprint("seat", { ...deps, dropServiceSeat: async (m) => { dropped.push(m); return true; } });
  assert.deepEqual(dropped, ["seat"], "그 멤버의 지정을 지운다");
  assert.equal(r.service_seat_dropped, true);
  const none = await reclaimMemberAppFootprint("bob", { ...deps, dropServiceSeat: async () => false });
  assert.ok(!("service_seat_dropped" in none), "지운 줄이 없으면 표시 없음");
  const failing = fakes([{ id: "s-app", app_id: "x" }]);
  const rf = await reclaimMemberAppFootprint("seat", { ...failing.deps, dropServiceSeat: async () => { throw new Error("DB 막힘"); } });
  assert.deepEqual(rf.sessions, ["s-app"], "지정 지우기가 실패해도 앱 세션 회수는 돈다");
  assert.deepEqual(failing.calls.revoke, ["seat"]);
  assert.ok(!("service_seat_dropped" in rf));
  assert.deepEqual(calls.central, ["s-app", "s-app"], "지정을 지운 회수 · 지울 줄이 없던 회수 모두 앱 세션을 걷는다");
});

test("앱 세션 0 → grant 만 회수, kill 0회(경계)", async () => {
  const { deps, calls } = fakes([{ id: "p", app_id: null }]);
  const r = await reclaimMemberAppFootprint("m", deps);
  assert.equal(calls.central.length + calls.node.length + calls.deleted.length, 0);
  assert.equal(r.grants, 2);
});
