// 노션 후처리의 **범위 축**(#1881 N7) — 스윕·원장이 external_instance 를 반드시 좁히는지.
//  실행: npm run build && node dist/v6/mirror/notion-post.test.js
//
//  왜 이 테스트가 있나: 범위를 안 좁히면 워크스페이스 A 의 full run 이 B 의 문서를 전부(자기가 못 봤으니)
//  아카이브하고, 다음 run 에 B 가 A 를 죽인다. 조용히 데이터가 사라지는 종류라 SQL 문자열 수준에서 못 박는다.
import assert from "node:assert/strict";
import { sweepNotionArchived, loadNotionLedger } from "./notion-post.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

/** 질의를 삼키고 기록만 하는 가짜 러너 — SQL 텍스트와 파라미터를 그대로 붙잡는다. */
function spyDb(rowsFor: (sql: string) => unknown[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: rowsFor(sql), rowCount: 0 };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, calls };
}

await t("스윕은 external_instance 로 좁히고 그 값을 파라미터로 넘긴다", async () => {
  const { db, calls } = spyDb();
  await sweepNotionArchived(db, "2026-08-25T00:00:00.000Z", "ws-A");
  const upd = calls.find((c) => c.sql.includes("UPDATE knowledge SET lifecycle='archived'"));
  assert.ok(upd, "스윕 UPDATE 가 없다");
  assert.match(upd!.sql, /external_instance=\$2/, "스윕이 인스턴스를 안 좁힌다 — 타 워크스페이스를 아카이브한다");
  assert.deepEqual(upd!.params, ["2026-08-25T00:00:00.000Z", "ws-A"]);
});

await t("스윕은 instance 가 비면 던진다(범위 없는 전량 아카이브 금지)", async () => {
  const { db, calls } = spyDb();
  await assert.rejects(() => sweepNotionArchived(db, "2026-08-25T00:00:00.000Z", ""), /instance/);
  assert.equal(calls.length, 0, "던지기 전에 질의가 나갔다");
});

await t("원장의 모든 질의가 인스턴스로 좁혀진다(본문·자산·역링크)", async () => {
  const { db, calls } = spyDb();
  await loadNotionLedger(db, "ws-B");
  assert.equal(calls.length, 3, `원장 질의 수가 바뀌었다(${calls.length}) — 새 질의도 범위를 좁혔는지 확인하라`);
  for (const c of calls) {
    assert.match(c.sql, /external_instance=\$1/, `범위 없는 원장 질의: ${c.sql.slice(0, 80)}`);
    assert.deepEqual(c.params, ["ws-B"]);
  }
});

await t("원장도 instance 가 비면 던진다", async () => {
  const { db } = spyDb();
  await assert.rejects(() => loadNotionLedger(db, ""), /instance/);
});

console.log(`\n${pass} passed`);
