// #4783 — «사유 없이 사라진 판» 확인(session-end-lost.ts)의 배선을 가짜 재료로 고정한다. 사양: 엣지 표 C(스크래치패드 spec.md).
//  틀리면 티가 크다:
//   🔴 목록에 없다는 것만으로 적으면 — 중계가 못 본 한 틱에 살아 있는 세션 전부가 «오류» 로 뒤집힌다(#3846 과 같은 모양).
//   🔴 «모른다»(null)·시간 초과를 사라짐으로 읽으면 — 노드가 잠깐 안 답할 때마다 거짓 오류가 선다.
//   🔴 확인한 판이 아닌 판에 적으면 — 확인하는 사이 같은 id 로 되살아난 살아 있는 세션이 «고장» 이 된다(격리 리뷰).
//   🔴 영영 안 답하는 몇 개가 상한을 차지하면 — 나머지 후보가 굶는다(격리 리뷰).
import { strict as assert } from "node:assert";
import test from "node:test";
import { sweepLostSessions, lostSweepSwitchOn, LOST_MAX_PROBES, LOST_GRACE_SEC, LOST_RETRY_MS, LOST_CONCURRENCY, type LostSweepDeps } from "./session-end-lost.js";
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
type Gone = boolean | null | "throw" | "hang";
function deps(states: SessionState[], o: { live?: string[]; gone?: Record<string, Gone>; written?: Set<string>; enabled?: boolean; listFail?: boolean; retryAfter?: Map<string, number>; nowMs?: number } = {}) {
  const probed: string[] = [];
  const marked: Array<[string, number]> = [];
  let inFlight = 0, maxInFlight = 0;
  const d: Partial<LostSweepDeps> = {
    enabled: () => o.enabled !== false,
    listLive: async () => { if (o.listFail) throw new Error("relay"); return (o.live || []).map((id) => ({ id })); },
    listStates: async () => states,
    listManaged: async () => [],
    goneVerdict: async (id) => {
      probed.push(id); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        const v = o.gone?.[id];
        if (v === "throw") throw new Error("boom");
        if (v === "hang") return await new Promise<boolean | null>(() => { /* 영영 안 답한다 */ });
        return v === undefined ? true : v;
      } finally { inFlight--; }
    },
    markLost: async (id, created) => { if (o.written?.has(id)) return false; marked.push([id, created]); return true; },
    nowSec: () => NOW,
    nowMs: () => o.nowMs ?? NOW * 1000,
    retryAfter: o.retryAfter ?? new Map(),
    probeTimeoutMs: 60,
  };
  return { d, probed, marked, maxInFlight: () => maxInFlight };
}

test("S1 매니지드가 아니거나 손잡이가 꺼졌으면 아무것도 안 본다", async () => {
  const { d, probed } = deps([st("a")], { enabled: false });
  const r = await sweepLostSessions(d);
  assert.equal(r.enabled, false);
  assert.deepEqual(probed, []);
  for (const v of ["off", "OFF", "0", "false", "no", " off "]) assert.equal(lostSweepSwitchOn(v), false, v);
  for (const v of [undefined, "", "on", "1", "yes"]) assert.equal(lostSweepSwitchOn(v), true, String(v));
});

test("S2 목록을 못 받으면 그 판은 아무것도 안 한다", async () => {
  const { d, probed, marked } = deps([st("a")], { listFail: true });
  const r = await sweepLostSessions(d);
  assert.equal(r.skipped, "list-failed");
  assert.deepEqual(probed, []); assert.deepEqual(marked, []);
});

test("S3 확답(true)만 적는다 — 살아 있음·모름·확인 실패·시간 초과는 안 적는다", async () => {
  const { d, probed, marked } = deps([st("a"), st("b"), st("c"), st("d"), st("e")], { gone: { a: true, b: false, c: null, d: "throw", e: "hang" } });
  const r = await sweepLostSessions(d);
  assert.deepEqual(marked.map((m) => m[0]), ["a"]);
  assert.deepEqual(r.lost, ["a"]);
  assert.deepEqual([...probed].sort(), ["a", "b", "c", "d", "e"], "[배선] 다섯 다 확인을 받았다");
  assert.equal(r.kept.alive, 1); assert.equal(r.kept.unknown, 3, "모름 · 던짐 · 시간 초과");
});

test("S4 목록에 있는 것·옛 판·사유가 있는 것은 확인조차 안 한다", async () => {
  const { d, probed } = deps([st("live"), st("old", { end_note: null }), st("done", { end_note: { v: 1, at: 1, why: "reclaim" } }), st("x")], { live: ["live"] });
  await sweepLostSessions(d);
  assert.deepEqual(probed, ["x"]);
});

test("S5 목록이 통째로 비어도(노드가 죽은 판) 확답으로만 적는다 — 한 판의 확인 수·동시 수에 상한이 있고 오래된 판부터", async () => {
  const states = Array.from({ length: 30 }, (_, i) => st("s" + String(i).padStart(3, "0"), { created: NOW - LOST_GRACE_SEC - 10 - i }));
  const { d, probed, maxInFlight } = deps(states, { live: [] });
  const r = await sweepLostSessions(d);
  assert.equal(r.skipped, undefined, "대량이라고 건너뛰지 않는다 — 실제 대량 장애를 못 본다(격리 리뷰)");
  assert.equal(probed.length, LOST_MAX_PROBES);
  assert.equal(r.kept.capped, 30 - LOST_MAX_PROBES);
  assert.ok(maxInFlight() <= LOST_CONCURRENCY && maxInFlight() > 1, `동시 확인 ${maxInFlight()}`);
  assert.deepEqual([...probed].sort().slice(0, 1), ["s018"], "가장 오래된 열둘(s018~s029)");
  assert.ok(probed.includes("s029") && !probed.includes("s017"));
});

test("S6 확답을 못 받은 후보는 한동안 다시 안 본다 — 그 자리를 다른 후보가 쓴다", async () => {
  const retry = new Map<string, number>();
  const states = Array.from({ length: LOST_MAX_PROBES + 3 }, (_, i) => st("t" + String(i).padStart(2, "0"), { created: NOW - LOST_GRACE_SEC - 10 - i }));
  const gone: Record<string, Gone> = Object.fromEntries(states.map((s) => [s.id, null]));
  const first = deps(states, { gone, retryAfter: retry });
  await sweepLostSessions(first.d);
  assert.equal(first.probed.length, LOST_MAX_PROBES);
  const second = deps(states, { gone, retryAfter: retry, nowMs: NOW * 1000 + 1000 });
  const r2 = await sweepLostSessions(second.d);
  assert.deepEqual([...second.probed].sort(), ["t00", "t01", "t02"], "🔴 못 본 셋이 굶는다");
  assert.equal(r2.kept["retry-later"], LOST_MAX_PROBES);
  const third = deps(states, { gone, retryAfter: retry, nowMs: NOW * 1000 + LOST_RETRY_MS + 2000 });
  await sweepLostSessions(third.d);
  assert.equal(third.probed.length, LOST_MAX_PROBES, "기다린 뒤엔 다시 본다");
});

test("S7 확인한 그 판에만 적는다(판 시작 created 를 건다) · 이미 적혔으면 적었다고 세지 않는다", async () => {
  const a = deps([st("a", { created: NOW - 999 })]);
  await sweepLostSessions(a.d);
  assert.deepEqual(a.marked, [["a", NOW - 999]]);
  const w = deps([st("b")], { written: new Set(["b"]) });
  const r = await sweepLostSessions(w.d);
  assert.deepEqual(w.marked, []);
  assert.deepEqual(r.lost, []);
  assert.equal(r.kept.written, 1);
});
