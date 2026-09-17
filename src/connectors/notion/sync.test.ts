// 노션 후처리(notionPostSync)의 **스윕 진입 조건과 배선**(#4059).
//  실행: npm run build && node dist/connectors/notion/sync.test.js
//
//  왜: 스윕 SQL 이 아무리 정확해도, 부분 실패한 run·증분 run·미러가 일부 실패한 run 에서 스윕이 돌면
//   «못 본 것» 에 «못 적은 것» 이 섞여 살아 있는 문서가 보관된다. 그리고 스윕·대사·관측이 **이 run 의 수집기 표식**
//   (ctx.claimKey)을 써야 같은 워크스페이스의 다른 수집기 몫을 건드리지 않는다. 가짜 풀로 나간 질의를 붙잡아 본다.
import assert from "node:assert/strict";
import { notionPostSync } from "./sync.js";
import type { NotionRunStats } from "./state.js";
import type { PostSyncCtx } from "../types.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const RUN = "2026-09-17T00:00:00.000Z";
const KEY = "notion:coo";

/** 질의를 기록하는 가짜 풀 — 대사 질의엔 written 을, 나머지는 빈 결과를 준다. connect() 도 같은 기록기로. */
function spyPool(written: number) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    if (sql.includes("count(*)::int AS n")) return { rows: [{ n: written }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { pool: pool as any, calls };
}
const stats = (over: Partial<NotionRunStats> = {}): NotionRunStats => ({
  instance: "ws-1", pages: 3, databases: 0, emitted: 2, failures: 0, failedIds: [], inaccessible: 0, inaccessibleIds: [],
  retryIds: [], unattributed: 0, observedIds: ["o-1"], assets: 0, assetFailures: 0, requests: 0, assetBytes: 0, ...over,
});
const ctx = (pool: unknown, over: Partial<PostSyncCtx> = {}): PostSyncCtx =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ({ pool: pool as any, runStartIso: RUN, incremental: false, ingested: 2, mirrorFailures: 0, claimKey: KEY, ...over });
const swept = (calls: Array<{ sql: string }>) => calls.some((c) => c.sql.includes("lifecycle='archived'") || c.sql.includes("SET sync_state = CASE"));
const readyRecorded = (calls: Array<{ sql: string }>) => calls.some((c) => c.sql.includes("INSERT INTO connector_state"));

await t("깨끗한 full run — 대사·관측·떼기·보관·준비 기록이 모두 이 run 의 표식으로 나간다", async () => {
  const { pool, calls } = spyPool(2);
  const r = await notionPostSync(ctx(pool), stats());
  assert.deepEqual(r, { retryIds: [] });
  const count = calls.find((c) => c.sql.includes("count(*)::int AS n"))!;
  assert.deepEqual(count.params, ["ws-1", KEY, RUN], "대사가 이 run 의 표식으로 세지 않는다");
  const observe = calls.find((c) => c.sql.includes("SET last_synced_at = now()"))!;
  assert.deepEqual(observe.params, [["o-1"], "ws-1", KEY], "관측이 이 run 의 표식을 안 남긴다");
  assert.ok(calls.indexOf(count) < calls.indexOf(observe), "관측이 대사보다 먼저 나갔다 — 관측분이 적재로 세어져 부족분을 가린다");
  const release = calls.find((c) => c.sql.includes("SET sync_state = CASE"))!;
  assert.deepEqual(release.params, [RUN, "ws-1", KEY]);
  const archive = calls.find((c) => c.sql.includes("lifecycle='archived'"))!;
  assert.equal(archive.params[1], "ws-1");
  const ready = calls.find((c) => c.sql.includes("INSERT INTO connector_state"))!;
  assert.deepEqual(ready.params, ["notion:sweep", KEY, JSON.stringify({ ready_at: RUN, version: null })]);
});

await t("항목 단위 미러 실패가 있으면 스윕·준비 기록을 하지 않는다", async () => {
  const { pool, calls } = spyPool(2);
  await notionPostSync(ctx(pool, { mirrorFailures: 1 }), stats());
  assert.ok(!swept(calls), "미러 실패 run 에서 스윕이 돌았다");
  assert.ok(!readyRecorded(calls), "미러 실패 run 이 준비로 기록됐다 — 다른 수집기가 이 run 을 완전한 관측으로 믿는다");
});

await t("증분 run 은 스윕하지 않는다", async () => {
  const { pool, calls } = spyPool(2);
  await notionPostSync(ctx(pool, { incremental: true }), stats());
  assert.ok(!swept(calls) && !readyRecorded(calls));
});

await t("커넥터 부분 실패(귀속)면 스윕 없이 재시도 목록만", async () => {
  const { pool, calls } = spyPool(2);
  const r = await notionPostSync(ctx(pool), stats({ failures: 1, retryIds: ["p-1"] }));
  assert.ok(!swept(calls) && !readyRecorded(calls));
  assert.deepEqual(r, { retryIds: ["p-1"] });
});

await t("적재 부족분(방출 > 이 수집기 적재)이면 스윕 없이 커서 동결", async () => {
  const { pool, calls } = spyPool(1);
  const r = await notionPostSync(ctx(pool), stats({ emitted: 2 }));
  assert.ok(!swept(calls) && !readyRecorded(calls));
  assert.deepEqual(r, { freezeCursor: true });
});

await t("통계가 없으면(backfill 미완) 스윕하지 않는다", async () => {
  const { pool, calls } = spyPool(0);
  await notionPostSync(ctx(pool), null);
  assert.ok(!swept(calls) && !readyRecorded(calls));
});

await t("다른 수집기 정보를 못 읽어도 떼기와 준비 기록은 하고, 보관은 하지 않는다", async () => {
  const { pool, calls } = spyPool(2);
  const orig = pool.query;
  pool.query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM org_collector")) throw new Error("boom");
    return orig(sql, params);
  };
  await notionPostSync(ctx(pool), stats());
  assert.ok(calls.some((c) => c.sql.includes("SET sync_state = CASE")), "떼기가 빠졌다");
  assert.ok(!calls.some((c) => c.sql.includes("lifecycle='archived'")), "다른 수집기를 모르는데 보관했다");
  assert.ok(readyRecorded(calls), "이 run 자체는 깨끗했으니 준비는 기록해야 한다");
});

console.log(`\n${pass} passed`);
