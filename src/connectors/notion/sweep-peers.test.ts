// 노션 스윕의 «같은 워크스페이스를 맡은 다른 수집기» 판정(#4059) — 보관해도 되는지·어느 시각까지인지.
//  실행: npm run build && node dist/connectors/notion/sweep-peers.test.js
//
//  왜: 같은 워크스페이스를 수집기 여럿이 나눠 맡으면, 표식 없는 행이 «아무도 안 맡는다» 는 증거가 되려면
//   다른 수집기 **전부**가 그 뒤에 깨끗한 전체 점검을 마쳤어야 한다. 이 판정이 느슨하면 남의 몫을 보관하고
//   (soltimal 2026-09-17, 5,385건), 지나치게 빡빡하면 원본에서 지운 문서가 영영 안 내려간다.
import assert from "node:assert/strict";
import { planNotionSweep, loadNotionSweepPeers, recordNotionSweepReady, isoMicros, SWEEP_STATE_SYSTEM, type NotionSweepPeer } from "./sweep-peers.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const RUN = "2026-09-17T03:00:00.000Z";
const peer = (key: string, over: Partial<NotionSweepPeer> = {}): NotionSweepPeer =>
  ({ key, version: 3, ready: { at: "2026-09-16T18:00:00.000Z", version: 3 }, ...over });

// ── 엣지 표 A — 스윕 계획(순수) ──
await t("P1 다른 수집기가 없으면 단일로 보관하고 기준은 이번 run 시작이다", () => {
  assert.deepEqual(planNotionSweep({ runStartIso: RUN, selfChanged: false, peers: [] }),
    { archive: true, sole: true, cutoffIso: RUN });
});
await t("P2 내 설정이 바뀌었으면 다른 수집기가 없어도 보류한다", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: true, peers: [] });
  assert.equal(p.archive, false);
  assert.equal(p.archive === false && p.reason, "self_changed");
});
await t("P3 다른 수집기 정보를 못 읽었으면(null) 보류한다 — 단일로 착각하지 않는다", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false, peers: null });
  assert.equal(p.archive, false);
  assert.equal(p.archive === false && p.reason, "peers_unknown");
});
await t("P4 준비된 다른 수집기 1 — 기준은 그 준비 시각(더 이르다)", () => {
  assert.deepEqual(planNotionSweep({ runStartIso: RUN, selfChanged: false, peers: [peer("notion:cpo")] }),
    { archive: true, sole: false, cutoffIso: "2026-09-16T18:00:00.000Z" });
});
await t("P5 다른 수집기의 준비 시각이 이번 run 시작보다 늦으면 기준은 run 시작", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false,
    peers: [peer("notion:cpo", { ready: { at: "2026-09-17T03:05:00.000Z", version: 3 } })] });
  assert.deepEqual(p, { archive: true, sole: false, cutoffIso: RUN });
});
await t("P6 준비 기록이 없는 다른 수집기가 있으면 보류하고 그 수집기를 알린다", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false, peers: [peer("notion:cpo", { ready: null })] });
  assert.deepEqual(p, { archive: false, reason: "peers_not_ready", notReady: ["notion:cpo"] });
});
await t("P7 준비 기록 뒤에 설정이 바뀐(판 불일치) 수집기는 준비가 아니다", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false,
    peers: [peer("notion:cpo", { version: 4, ready: { at: "2026-09-16T18:00:00.000Z", version: 3 } })] });
  assert.deepEqual(p, { archive: false, reason: "peers_not_ready", notReady: ["notion:cpo"] });
});
await t("P8 판 없이 남은 준비 기록(null)은 숫자 판과 일치로 치지 않는다", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false,
    peers: [peer("notion:cpo", { ready: { at: "2026-09-16T18:00:00.000Z", version: null } })] });
  assert.equal(p.archive, false);
});
await t("P9 둘 다 준비됐으면 기준은 둘 중 이른 준비 시각", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false, peers: [
    peer("notion:a", { ready: { at: "2026-09-16T20:00:00.000Z", version: 3 } }),
    peer("notion:b", { ready: { at: "2026-09-16T10:00:00.000Z", version: 3 } }),
  ] });
  assert.deepEqual(p, { archive: true, sole: false, cutoffIso: "2026-09-16T10:00:00.000Z" });
});
await t("P10 둘 중 하나만 준비됐으면 보류하고 준비 안 된 것만 알린다", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false, peers: [
    peer("notion:a"), peer("notion:b", { ready: null }),
  ] });
  assert.deepEqual(p, { archive: false, reason: "peers_not_ready", notReady: ["notion:b"] });
});
await t("P11 준비 시각이 깨진 문자열이면 준비가 아니다(NaN 기준으로 보관하지 않는다)", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false,
    peers: [peer("notion:a", { ready: { at: "not-a-date", version: 3 } })] });
  assert.deepEqual(p, { archive: false, reason: "peers_not_ready", notReady: ["notion:a"] });
});
await t("P12 준비 시각이 run 시작과 같으면(경계) 기준은 그 시각", () => {
  const p = planNotionSweep({ runStartIso: RUN, selfChanged: false,
    peers: [peer("notion:a", { ready: { at: RUN, version: 3 } })] });
  assert.deepEqual(p, { archive: true, sole: false, cutoffIso: RUN });
});

await t("P13 같은 밀리초 안에서도 마이크로초로 더 이른 쪽이 기준이다(받은 문자열 그대로)", () => {
  const run = "2026-09-17T03:00:00.628900Z";
  const p = planNotionSweep({ runStartIso: run, selfChanged: false, peers: [
    peer("notion:a", { ready: { at: "2026-09-17T03:00:00.628700Z", version: 3 } }),
    peer("notion:b", { ready: { at: "2026-09-17T03:00:00.628750Z", version: 3 } }),
  ] });
  assert.deepEqual(p, { archive: true, sole: false, cutoffIso: "2026-09-17T03:00:00.628700Z" });
  const q = planNotionSweep({ runStartIso: run, selfChanged: false,
    peers: [peer("notion:a", { ready: { at: "2026-09-17T03:00:00.628950Z", version: 3 } })] });
  assert.deepEqual(q, { archive: true, sole: false, cutoffIso: run }, "run 시작이 같은 밀리초 안에서 더 이른데 준비 시각을 골랐다");
});
await t("P14 내 run 시작 시각을 못 읽으면 다른 수집기가 있든 없든 보류한다", () => {
  const p = planNotionSweep({ runStartIso: "garbage", selfChanged: false, peers: [peer("notion:a")] });
  assert.equal(p.archive, false);
  const q = planNotionSweep({ runStartIso: "garbage", selfChanged: false, peers: [] });
  assert.deepEqual(q, { archive: false, reason: "peers_unknown" }, "단일 수집기에서 깨진 시작 시각을 그대로 기준으로 넘겼다");
});
await t("isoMicros — 소수부를 버리지 않고 마이크로초로 읽는다", () => {
  const base = BigInt(Date.parse("2026-09-17T03:00:00Z")) * 1000n;
  assert.equal(isoMicros("2026-09-17T03:00:00Z"), base);
  assert.equal(isoMicros("2026-09-17T03:00:00.5Z"), base + 500000n);
  assert.equal(isoMicros("2026-09-17T03:00:00.123Z"), base + 123000n);
  assert.equal(isoMicros("2026-09-17T03:00:00.123456Z"), base + 123456n);
  assert.equal(isoMicros("2026-09-17T03:00:00.123456789Z"), base + 123456n, "나노초는 마이크로초로 자른다(Postgres 정밀도)");
  assert.equal(isoMicros("2026-09-17T12:00:00.000001+09:00"), base + 1n, "오프셋 표기도 같은 순간이다");
  assert.equal(isoMicros("2026-09-17 03:00:00"), null);
  assert.equal(isoMicros(""), null);
  assert.equal(isoMicros("2026-13-45T99:00:00Z"), null);
});

// ── 엣지 표 B/S18·S19 — 다른 수집기 목록(DB 는 가짜 러너) ──
type Row = { id: number; preset_key: string; instance_key: string; enabled: boolean; version: number; inst: string | null };
function peersDb(rows: Row[], states: Array<{ instance: string; cursor: Record<string, unknown> | null }>, opts: { failCollectors?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("FROM org_collector")) {
        if (opts.failCollectors) throw new Error("boom");
        const keys = (params?.[0] as string[]) ?? [];
        return { rows: rows.filter((r) => keys.includes(r.preset_key)), rowCount: 0 };
      }
      if (sql.includes("FROM connector_state")) {
        const keys = (params?.[1] as string[]) ?? [];
        return { rows: states.filter((s) => params?.[0] === SWEEP_STATE_SYSTEM && keys.includes(s.instance)), rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, calls };
}
const R = (id: number, instance_key: string, over: Partial<Row> = {}): Row =>
  ({ id, preset_key: "notion", instance_key, enabled: true, version: 1, inst: "ws-1", ...over });

// 프리셋 카탈로그는 주입한다 — 실제 카탈로그는 전역 풀로 읽는다(유닛 테스트가 DB 에 기대지 않게).
const BUILTIN_ONLY = async () => ({ keys: ["notion"], clones: new Set<string>() });
delete process.env.NOTION_INSTANCE;

await t("S18 같은 축의 켜진 수집기만 다른 수집기로 센다(꺼짐·다른 축·자기 제외)", async () => {
  const { db } = peersDb([
    R(1, "coo", { version: 7 }),                // 자기
    R(2, "cpo"),                                // 같은 축 · 켜짐 → 포함
    R(3, "cfo", { enabled: false }),            // 꺼짐 → 제외
    R(4, "other", { inst: "ws-2" }),            // 다른 워크스페이스 → 제외
  ], [{ instance: "notion:cpo", cursor: { ready_at: "2026-09-16T00:00:00.000Z", version: 1 } }]);
  const r = await loadNotionSweepPeers(db, { instance: "ws-1", claimKey: "notion:coo", boundId: 1, boundVersion: 7 }, { presetKeys: BUILTIN_ONLY });
  assert.equal(r.selfChanged, false);
  assert.deepEqual(r.peers, [{ key: "notion:cpo", version: 1, ready: { at: "2026-09-16T00:00:00.000Z", version: 1 } }]);
});

await t("S18 instance 가 빈 수집기는 NOTION_INSTANCE, 그것도 없으면 'default' 축이다", async () => {
  const rows = [R(1, "coo", { inst: null }), R(2, "cpo", { inst: "" })];
  const { db } = peersDb(rows, []);
  const onDefault = await loadNotionSweepPeers(db, { instance: "default", claimKey: "notion:coo", boundId: 1, boundVersion: 1 }, { presetKeys: BUILTIN_ONLY });
  assert.deepEqual(onDefault.peers?.map((p) => p.key), ["notion:cpo"]);
  const onWs = await loadNotionSweepPeers(db, { instance: "ws-1", claimKey: "notion:coo", boundId: 1, boundVersion: 1 }, { presetKeys: BUILTIN_ONLY });
  assert.deepEqual(onWs.peers, [], "빈 instance 가 다른 축으로 잡혔다");
  process.env.NOTION_INSTANCE = "ws-env";
  try {
    const onEnv = await loadNotionSweepPeers(db, { instance: "ws-env", claimKey: "notion:coo", boundId: 1, boundVersion: 1 }, { presetKeys: BUILTIN_ONLY });
    assert.deepEqual(onEnv.peers?.map((p) => p.key), ["notion:cpo"], "env 축을 안 따랐다");
  } finally { delete process.env.NOTION_INSTANCE; }
});

await t("S18 내 설정 판이 바인딩 때와 다르면 selfChanged", async () => {
  const { db } = peersDb([R(1, "coo", { version: 8 })], []);
  const r = await loadNotionSweepPeers(db, { instance: "ws-1", claimKey: "notion:coo", boundId: 1, boundVersion: 7 }, { presetKeys: BUILTIN_ONLY });
  assert.equal(r.selfChanged, true);
  assert.deepEqual(r.peers, []);
});

await t("S18 바인딩 없는(레거시) 실행은 판을 비교하지 않는다", async () => {
  const { db } = peersDb([R(1, "_", { version: 8 })], []);
  const r = await loadNotionSweepPeers(db, { instance: "ws-1", claimKey: "notion:_", boundId: null, boundVersion: null }, { presetKeys: BUILTIN_ONLY });
  assert.equal(r.selfChanged, false);
  assert.deepEqual(r.peers, []);
});

await t("S18 준비 기록이 없거나 ready_at 이 문자열이 아니면 ready=null", async () => {
  const { db } = peersDb([R(1, "coo"), R(2, "cpo"), R(3, "cto")],
    [{ instance: "notion:cto", cursor: { ready_at: 123, version: 1 } }]);
  const r = await loadNotionSweepPeers(db, { instance: "ws-1", claimKey: "notion:coo", boundId: 1, boundVersion: 1 }, { presetKeys: BUILTIN_ONLY });
  assert.deepEqual(r.peers, [
    { key: "notion:cpo", version: 1, ready: null },
    { key: "notion:cto", version: 1, ready: null },
  ]);
});

await t("S18 노션 복제 프리셋 수집기는 축을 모르므로 같은 축으로 친다(보수)", async () => {
  const { db, calls } = peersDb([R(1, "coo"), R(2, "x", { preset_key: "my-notion", inst: "ws-9" })], []);
  const r = await loadNotionSweepPeers(db, { instance: "ws-1", claimKey: "notion:coo", boundId: 1, boundVersion: 1 },
    { presetKeys: async () => ({ keys: ["notion", "my-notion"], clones: new Set(["my-notion"]) }) });
  assert.deepEqual(r.peers?.map((p) => p.key), ["my-notion:x"]);
  assert.deepEqual(calls[0].params[0], ["notion", "my-notion"], "복제 프리셋 수집기를 목록에서 찾지 않았다");
});

await t("S18 수집기 목록을 못 읽으면 peers=null(모르면 지우지 않는다)", async () => {
  const { db } = peersDb([], [], { failCollectors: true });
  const r = await loadNotionSweepPeers(db, { instance: "ws-1", claimKey: "notion:coo", boundId: 1, boundVersion: 1 }, { presetKeys: BUILTIN_ONLY });
  assert.equal(r.peers, null);
});

await t("S18 다른 수집기가 없으면 준비 기록을 읽지 않는다", async () => {
  const { db, calls } = peersDb([R(1, "coo")], []);
  const r = await loadNotionSweepPeers(db, { instance: "ws-1", claimKey: "notion:coo", boundId: 1, boundVersion: 1 }, { presetKeys: BUILTIN_ONLY });
  assert.deepEqual(r.peers, []);
  assert.ok(!calls.some((c) => c.sql.includes("connector_state")));
});

await t("S19 준비 기록은 notion:sweep 축에 {시작 시각, 판} 으로 upsert 한다", async () => {
  const { db, calls } = peersDb([], []);
  await recordNotionSweepReady(db, { claimKey: "notion:coo", runStartIso: RUN, boundVersion: 7 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT \(tenant_id, system, instance\) DO UPDATE/);
  assert.deepEqual(calls[0].params, [SWEEP_STATE_SYSTEM, "notion:coo", JSON.stringify({ ready_at: RUN, version: 7 })]);
});

console.log(`\n${pass} passed`);
