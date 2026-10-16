// #4783 — «사유 없이 사라진 판» 확인(session-end-lost.ts)의 배선을 가짜 재료로 고정한다. 사양: 엣지 표 C(스크래치패드 spec.md).
//  틀리면 티가 크다:
//   🔴 목록에 없다는 것만으로 적으면 — 중계가 못 본 한 틱에 살아 있는 세션 전부가 «오류» 로 뒤집힌다(#3846 과 같은 모양).
//   🔴 «모른다»(null)를 사라짐으로 읽으면 — 노드가 잠깐 안 답할 때마다 거짓 오류가 선다.
//   🔴 상한·대량 가드가 없으면 — 노드 한 대가 죽은 판에 확인이 수십 번 몰리거나, 목록이 잘못 빈 판에 무더기로 적힌다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { sweepLostSessions, LOST_MAX_PROBES, LOST_GRACE_SEC, LOST_BULK_GUARD, type LostSweepDeps } from "./session-end-lost.js";
import type { SessionState } from "./session-state.js";

const NOW = 2_000_000;
function st(id: string, over: Partial<SessionState> = {}): SessionState {
  return {
    id, owner: "u1", kind: "human", label: id, harness: "claude", dir: "/x", root_key: "personal", subpath: "",
    flags: {}, auto_approve: false, invites: [], project_id: null, project_src: null, read_only: false, incognito: false,
    created: NOW - LOST_GRACE_SEC - 10, last_busy: null, last_seen: null, claude_session_id: null, transcript_path: null,
    exited_at: null, exit_reason: null, node_id: null, discovered: false, superseded_by: null, stop_note: null, end_note: { v: 1 },
    ...over,
  } as SessionState;
}
function deps(states: SessionState[], o: { live?: string[]; gone?: Record<string, boolean | null | "throw">; written?: Set<string>; enabled?: boolean; listFail?: boolean } = {}) {
  const probed: string[] = [];
  const marked: string[] = [];
  const d: Partial<LostSweepDeps> = {
    enabled: () => o.enabled !== false,
    listLive: async () => { if (o.listFail) throw new Error("relay"); return (o.live || []).map((id) => ({ id })); },
    listStates: async () => states,
    listManaged: async () => [],
    goneVerdict: async (id) => { probed.push(id); const v = o.gone?.[id]; if (v === "throw") throw new Error("boom"); return v === undefined ? true : v; },
    markLost: async (id) => { if (o.written?.has(id)) return false; marked.push(id); return true; },
    nowSec: () => NOW,
  };
  return { d, probed, marked };
}

test("S1 매니지드가 아니면 아무것도 안 본다", async () => {
  const { d, probed } = deps([st("a")], { enabled: false });
  const r = await sweepLostSessions(d);
  assert.equal(r.enabled, false);
  assert.deepEqual(probed, []);
});

test("S2 목록을 못 받으면 그 판은 아무것도 안 한다", async () => {
  const { d, probed, marked } = deps([st("a")], { listFail: true });
  const r = await sweepLostSessions(d);
  assert.equal(r.skipped, "list-failed");
  assert.deepEqual(probed, []); assert.deepEqual(marked, []);
});

test("S3 확답(true)만 적는다 — 살아 있음(false)·모름(null)·확인 실패(throw)는 안 적는다", async () => {
  const { d, probed, marked } = deps([st("a"), st("b"), st("c"), st("d")], { gone: { a: true, b: false, c: null, d: "throw" } });
  const r = await sweepLostSessions(d);
  assert.deepEqual(marked, ["a"]);
  assert.deepEqual(r.lost, ["a"]);
  assert.deepEqual([...probed].sort(), ["a", "b", "c", "d"], "[배선] 넷 다 확인을 받았다");
  assert.equal(r.kept.alive, 1); assert.equal(r.kept.unknown, 2);
});

test("S4 목록에 있는 것·옛 판·사유가 있는 것은 확인조차 안 한다", async () => {
  const { d, probed } = deps([st("live"), st("old", { end_note: null }), st("done", { end_note: { v: 1, at: 1, why: "reclaim" } }), st("x")], { live: ["live"] });
  await sweepLostSessions(d);
  assert.deepEqual(probed, ["x"]);
});

test("S5 후보가 많고 v1 판의 절반을 넘으면 그 판은 건너뛴다(목록이 잘못 비었을 수 있다)", async () => {
  const states = Array.from({ length: 10 }, (_, i) => st("s" + i));
  const { d, probed } = deps(states, { live: ["s0"] });   // 9 후보 / v1 10
  const r = await sweepLostSessions(d);
  assert.equal(r.skipped, "bulk");
  assert.deepEqual(probed, []);
  //  경계 — 후보가 정확히 상한(8)이면 대량이 아니다(넘어야 대량).
  const s8 = Array.from({ length: LOST_BULK_GUARD }, (_, i) => st("t" + i));
  const b = deps(s8);
  const r8 = await sweepLostSessions(b.d);
  assert.equal(r8.skipped, undefined);
  assert.equal(b.probed.length, LOST_BULK_GUARD);
});

test("S6 한 판의 확인 수에는 상한이 있다 — 남은 것은 다음 판(오래된 판부터)", async () => {
  const states = Array.from({ length: 100 }, (_, i) => st("s" + String(i).padStart(3, "0"), { created: NOW - LOST_GRACE_SEC - 10 - i }));
  const live = states.slice(20).map((s) => s.id);   // 후보 20 / v1 100 — 대량 가드엔 안 걸린다
  const { d, probed } = deps(states, { live });
  const r = await sweepLostSessions(d);
  assert.equal(probed.length, LOST_MAX_PROBES);
  assert.equal(r.kept.capped, 20 - LOST_MAX_PROBES);
  assert.equal(probed[0], "s019", "만든 시각이 가장 이른 판부터");
});

test("S7 확답 뒤에 이미 누가 적었으면(첫 사실이 이긴다) 적었다고 세지 않는다", async () => {
  const { d, marked } = deps([st("a")], { written: new Set(["a"]) });
  const r = await sweepLostSessions(d);
  assert.deepEqual(marked, []);
  assert.deepEqual(r.lost, []);
  assert.equal(r.kept.written, 1);
});
