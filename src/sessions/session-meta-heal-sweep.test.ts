// 세션 호스트 스냅샷 되채우기 정비 (#3892 후속) — 사양.
//
//  사건(2026-09-11, 매니지드 lively-46e3): 09:52:47Z 부터 세션 목록을 노드의 세션 호스트가 만든다. 호스트는 DB 가 없어
//   표식이 빈 판(box-sangmin-yoon-d78e541c)을 소유자 "" 로 올렸고, 게이트웨이 가시성이 그 행을 주인에게서도 걸러 DB 행이
//   «중단됨» 으로 섰다(대화창에서 보낸 말은 403). 게이트웨이 `collectSessions` 되채우기는 이 모드에서 안 불린다.
//  여기 잠그는 것: 무엇을 보고(스냅샷의 소유자 빈 행) · 누구에게 묻고(그 행들만 DB 한 번) · 무엇을 보내나(자격 행만, 공용 창구).
//  배선(정비 표·기본 의존)은 scripts/session-meta-heal-wiring.test.mjs.
import { strict as assert } from "node:assert";
import test from "node:test";
import { sweepSessionMetaHeal, type MetaHealSweepDeps } from "./session-meta-heal-sweep.js";
import type { SessionInfo } from "../terminal/catalog.js";
import type { SessionState } from "./session-state.js";

const snap = (p: Partial<SessionInfo> & { id: string }): SessionInfo => ({
  label: p.id, harness: "shell", dir: "", autoApprove: false, owner: "", owned: false, created: 1, attached: true,
  invites: [], flags: {}, projectId: 0, agentState: "shell", ...p,
} as SessionInfo);

const state = (id: string, p: Partial<SessionState> = {}): SessionState => ({
  id, owner: "sangmin-yoon", kind: null, label: "3749 진행해", label_source: "rule", harness: "claude",
  dir: "/work/shared/project/2600", root_key: "shared", subpath: "project/2600", flags: {}, auto_approve: false, invites: [],
  project_id: 2600, project_src: "v6", app_id: null, read_only: false, incognito: false, write_vis: null, restrict_read: false,
  created: 1, last_busy: null, last_seen: null, claude_session_id: null, transcript_path: null, exited_at: null, exit_reason: null,
  node_id: null, superseded_by: null, ...p,
});

/** 기록하는 가짜 의존 — **무엇을 물었나 · 무엇을 보냈나** 를 부작용으로 남긴다. */
function fake(rows: SessionInfo[], db: SessionState[], healOk: (id: string) => boolean = () => true) {
  const calls = { loadDesired: [] as string[][], heal: [] as Array<{ id: string; row: SessionState }> };
  const deps: MetaHealSweepDeps = {
    snapshotSessions: () => rows,
    loadDesired: async (ids) => { calls.loadDesired.push([...ids]); return new Map(db.filter((r) => ids.includes(r.id)).map((r) => [r.id, r])); },
    heal: (id, row) => { calls.heal.push({ id, row }); return healOk(id); },
  };
  return { deps, calls };
}

const D = "box-sangmin-yoon-d78e541c";

test("W-S1 ★ 사건 재현 — 호스트 행 d78e541c(소유자 빈 값) + DB 행 → 그 판을 그 행으로 한 번 되채운다 (E43)", async () => {
  const row = state(D);
  const { deps, calls } = fake([snap({ id: D, owner: "", harness: "shell", agentState: "shell", working: true } as Partial<SessionInfo> & { id: string })], [row]);
  const r = await sweepSessionMetaHeal(deps);
  assert.deepEqual(calls.loadDesired, [[D]], "그 행의 DB 행을 한 번 묻는다");
  assert.equal(calls.heal.length, 1, "한 번 보낸다");
  assert.equal(calls.heal[0]!.id, D);
  assert.equal(calls.heal[0]!.row, row, "DB 행 그대로 넘긴다(되채울 값의 정본)");
  assert.deepEqual(r, { scanned: 1, ownerless: 1, healed: [D] });
});

test("W-S2 소유자가 빈 행이 없으면 DB 를 묻지 않는다 — 소유자 빈 상시세션 행도 묻는 대상이 아니다 (E44·E48)", async () => {
  const { deps, calls } = fake([
    snap({ id: "box-a-00000001", owner: "sangmin-yoon" }),
    snap({ id: "box-b-00000002", owner: "wonjoon-jang" }),
    snap({ id: "box-c-00000003", owner: "", managed: "ks-1" }),
  ], [state("box-c-00000003")]);
  const r = await sweepSessionMetaHeal(deps);
  assert.equal(calls.loadDesired.length, 0, "평시(표식이 다 있는 판)엔 DB 왕복 0");
  assert.equal(calls.heal.length, 0);
  assert.deepEqual(r, { scanned: 3, ownerless: 0, healed: [] });
});

test("W-S3 소유자가 비었어도 DB 행이 없거나 노드 세션 행이면 안 보낸다 (E45·E46)", async () => {
  const { deps, calls } = fake([
    snap({ id: "box-x-00000001", owner: "" }),
    snap({ id: "box-y-00000002", owner: "" }),
  ], [state("box-y-00000002", { node_id: "haruui-macbookair" })]);
  const r = await sweepSessionMetaHeal(deps);
  assert.deepEqual(calls.loadDesired, [["box-x-00000001", "box-y-00000002"]]);
  assert.equal(calls.heal.length, 0, "정본 없음 · 게이트웨이가 칠 수 없는 판");
  assert.deepEqual(r.healed, []);
});

test("W-S4 쿨다운에 걸려 안 나간 판은 «보냈다» 에 넣지 않는다 (E47)", async () => {
  const { deps, calls } = fake([snap({ id: D, owner: "" })], [state(D)], () => false);
  const r = await sweepSessionMetaHeal(deps);
  assert.equal(calls.heal.length, 1, "창구까지는 갔다");
  assert.deepEqual(r.healed, [], "창구가 거절했으면 보낸 것이 아니다");
});

test("W-S5 섞인 행 — DB 에는 소유자 빈 비상시 행만 묻고, 자격 있는 판만 보낸다 (E49)", async () => {
  const ok1 = "box-sangmin-yoon-d78e541c", ok2 = "box-wonjoon-jang-39d499af";
  const { deps, calls } = fake([
    snap({ id: "box-sangmin-yoon-5dfbfef3", owner: "sangmin-yoon" }),
    snap({ id: ok1, owner: "" }),
    snap({ id: "box-lively-agent-3-00000001", owner: "", managed: "ks-2" }),
    snap({ id: ok2, owner: " " }),
    snap({ id: "box-ghost-00000009", owner: "" }),
  ], [state(ok1), state(ok2, { owner: "wonjoon-jang" }), state("box-lively-agent-3-00000001")]);
  const r = await sweepSessionMetaHeal(deps);
  assert.deepEqual(calls.loadDesired, [[ok1, ok2, "box-ghost-00000009"]]);
  assert.deepEqual(calls.heal.map((c) => c.id), [ok1, ok2]);
  assert.deepEqual(r, { scanned: 5, ownerless: 3, healed: [ok1, ok2] });
});
