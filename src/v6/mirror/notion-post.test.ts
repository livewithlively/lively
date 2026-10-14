// 노션 후처리의 **범위 축**(#1881 N7 · #4059) — 스윕·원장이 external_instance 와 수집기 표식으로 좁혀지는지.
//  실행: npm run build && node dist/v6/mirror/notion-post.test.js
//
//  왜 이 테스트가 있나: 범위를 안 좁히면 워크스페이스 A 의 full run 이 B 의 문서를 전부(자기가 못 봤으니)
//  아카이브하고, 다음 run 에 B 가 A 를 죽인다. 같은 워크스페이스를 수집기 여럿이 나눠 맡아도 똑같다(#4059 —
//  8페이지만 맡은 수집기가 5,385건을 아카이브했다). 여기선 **무엇을 어떤 범위로 묻는가**(질의·파라미터)를 못 박고,
//  SQL 의 **의미**(표식 떼기·보관 조건)는 실 DB 로 notion-sweep.pg-test.mjs 가 본다.
import assert from "node:assert/strict";
import { sweepNotionArchived, loadNotionLedger, observeNotionRows, countNotionClaimedSince } from "./notion-post.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

/** 질의를 삼키고 기록만 하는 가짜 러너 — SQL 텍스트와 파라미터를 그대로 붙잡는다. */
function spyDb(rowsFor: (sql: string) => unknown[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = rowsFor(sql);
      return { rows, rowCount: rows.length };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, calls };
}

const RUN = "2026-09-17T00:00:00.000Z";
const SOLE = { archive: true as const, sole: true, cutoffIso: RUN };
const isRelease = (sql: string) => sql.includes("SET sync_state");
const isArchive = (sql: string) => sql.includes("lifecycle='archived'");

await t("스윕은 떼기·보관 둘 다 인스턴스와 수집기 표식을 파라미터로 넘긴다", async () => {
  const { db, calls } = spyDb();
  await sweepNotionArchived(db, { runStartIso: RUN, instance: "ws-A", claimKey: "notion:coo", plan: SOLE });
  const rel = calls.find((c) => isRelease(c.sql));
  assert.ok(rel, "표식 떼기 UPDATE 가 없다");
  assert.deepEqual(rel!.params, [RUN, "ws-A", "notion:coo"]);
  const upd = calls.find((c) => isArchive(c.sql));
  assert.ok(upd, "보관 UPDATE 가 없다");
  assert.match(upd!.sql, /external_instance=\$2/, "보관이 인스턴스를 안 좁힌다 — 타 워크스페이스를 아카이브한다");
  assert.deepEqual(upd!.params, [RUN, "ws-A", [], RUN]);
});

await t("혼자인 수집기면 이번에 뗀 마지막 표식 행만 곧바로 보관 후보로 넘긴다", async () => {
  const { db, calls } = spyDb((sql) => isRelease(sql)
    ? [{ name: "notion-a", orphaned: true }, { name: "notion-b", orphaned: false }] : []);
  const r = await sweepNotionArchived(db, { runStartIso: RUN, instance: "ws-A", claimKey: "notion:_", plan: SOLE });
  const upd = calls.find((c) => isArchive(c.sql))!;
  assert.deepEqual(upd.params[2], ["notion-a"], "남이 아직 맡은 행(notion-b)까지 보관 후보로 넘겼다");
  assert.equal(r.released, 2);
  assert.equal(r.orphaned, 1);
});

await t("다른 수집기가 있으면 이번에 뗀 행은 넘기지 않고 기준 시각만 쓴다", async () => {
  const { db, calls } = spyDb((sql) => isRelease(sql) ? [{ name: "notion-a", orphaned: true }] : []);
  const cutoff = "2026-09-16T00:00:00.000Z";
  await sweepNotionArchived(db, { runStartIso: RUN, instance: "ws-A", claimKey: "notion:coo",
    plan: { archive: true, sole: false, cutoffIso: cutoff } });
  const upd = calls.find((c) => isArchive(c.sql))!;
  assert.deepEqual(upd.params, [RUN, "ws-A", [], cutoff]);
});

await t("보관 보류 계획이면 표식만 떼고 보관 UPDATE 는 안 나간다", async () => {
  const { db, calls } = spyDb();
  const r = await sweepNotionArchived(db, { runStartIso: RUN, instance: "ws-A", claimKey: "notion:coo",
    plan: { archive: false, reason: "peers_not_ready", notReady: ["notion:cpo"] } });
  assert.ok(calls.some((c) => isRelease(c.sql)), "떼기는 보류와 무관하게 해야 한다");
  assert.ok(!calls.some((c) => isArchive(c.sql)), "보류인데 보관 UPDATE 가 나갔다");
  assert.equal(r.held, "peers_not_ready");
  assert.equal(r.archived, 0);
});

await t("스윕은 instance·claimKey 가 비면 질의 전에 던진다(범위 없는 전량 아카이브 금지)", async () => {
  const { db, calls } = spyDb();
  await assert.rejects(() => sweepNotionArchived(db, { runStartIso: RUN, instance: "", claimKey: "notion:_", plan: SOLE }), /instance/);
  await assert.rejects(() => sweepNotionArchived(db, { runStartIso: RUN, instance: "ws-A", claimKey: "", plan: SOLE }), /claimKey/);
  assert.equal(calls.length, 0, "던지기 전에 질의가 나갔다");
});

await t("원장의 모든 질의가 인스턴스로 좁혀진다(본문·자산·역링크)", async () => {
  const { db, calls } = spyDb();
  await loadNotionLedger(db, "ws-B");
  assert.equal(calls.length, 3, `원장 질의 수가 바뀌었다(${calls.length}) — 새 질의도 범위를 좁혔는지 확인하라`);
  for (const c of calls) {
    assert.match(c.sql, /external_instance=\$1/, `범위 없는 원장 질의: ${c.sql.slice(0, 80)}`);
    assert.equal(c.params[0], "ws-B");
  }
});

await t("원장은 DB 가 준 mine 을 항목에 싣고, 값이 없으면 내 몫으로 본다", async () => {
  const row = (id: string, mine: boolean | null) => ({ external_id: id, title: id, lifecycle: "active", mine });
  const { db, calls } = spyDb((sql) => sql.includes("FROM knowledge WHERE") ? [row("p-mine", true), row("p-peer", false), row("p-null", null)] : []);
  const led = await loadNotionLedger(db, "ws-B", "notion:coo");
  assert.deepEqual(calls[0].params, ["ws-B", "notion:coo"], "원장 질의에 수집기 표식이 안 실렸다");
  assert.equal(led.byId.get("p-mine")?.mine, true);
  assert.equal(led.byId.get("p-peer")?.mine, false, "남의 몫이 내 범위의 증거로 읽힌다");
  assert.equal(led.byId.get("p-null")?.mine, true);
  const { calls: calls2, db: db2 } = spyDb();
  await loadNotionLedger(db2, "ws-B");
  assert.deepEqual(calls2[0].params, ["ws-B", null], "표식 없이 읽으면 null 을 넘겨야 한다(전부 내 몫 — 종전 동작)");
});

await t("원장도 instance 가 비면 던진다", async () => {
  const { db } = spyDb();
  await assert.rejects(() => loadNotionLedger(db, ""), /instance/);
});

await t("가속 full 관측은 지정 id 를 인스턴스로 좁혀 내 표식과 함께 갱신한다", async () => {
  const { db, calls } = spyDb();
  await observeNotionRows(db, { instance: "ws-A", ids: ["x", "y"], claimKey: "notion:coo" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /external_instance=\$2/);
  assert.deepEqual(calls[0].params, [["x", "y"], "ws-A", "notion:coo"]);
});

await t("가속 full 관측은 5000건씩 끊어 보낸다", async () => {
  const { db, calls } = spyDb();
  const ids = Array.from({ length: 5001 }, (_, i) => `id-${i}`);
  await observeNotionRows(db, { instance: "ws-A", ids, claimKey: "notion:coo" });
  assert.equal(calls.length, 2);
  assert.equal((calls[0].params[0] as string[]).length, 5000);
  assert.deepEqual(calls[1].params[0], ["id-5000"]);
});

await t("미러 대사는 인스턴스·수집기 표식·시작 시각으로 센다", async () => {
  const { db, calls } = spyDb(() => [{ n: 3 }]);
  const n = await countNotionClaimedSince(db, { instance: "ws-A", claimKey: "notion:coo", sinceIso: RUN });
  assert.equal(n, 3);
  assert.deepEqual(calls[0].params, ["ws-A", "notion:coo", RUN]);
});

console.log(`\n${pass} passed`);
