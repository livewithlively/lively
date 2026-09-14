// 묶음 삭제의 **원자성**(#1631) — 확인·재배정·삭제가 한 트랜잭션에서, 대상 행을 잡고 돈다.
//  실행: npx tsx --test src/v6/category-group-tx.test.ts  (빌드 경로: node dist/v6/category-group-tx.test.js)
//
//  왜 이 파일이 따로 있나: 앞선 판정 테스트(category-group-store.test.ts)는 **순수 함수**만 본다.
//   그런데 고아가 실제로 생기는 자리는 판정이 아니라 **문장 사이**다 — «비었나 확인» 과 «삭제» 가 각각 다른
//   커넥션에서 따로 돌면 그 틈에 끼어든 배정이 없는 묶음을 가리키게 된다. 그건 함수 반환값으로는 안 보이고
//   **어떤 SQL 이 어떤 순서로, 어느 커넥션에서 나갔는가**로만 보인다. 그래서 여기서는 DB 표면을 페이크로
//   갈아 끼우고(이 레포 관례 — domainmap/core/reconcile.test.ts 의 주입 seam) 그 발자국을 직접 읽는다.
//
//  ── 엣지 표 ────────────────────────────────────────────────────────────────
//   ⓐ 정상 삭제      → BEGIN → FOR UPDATE → 집계 → UPDATE category → DELETE → COMMIT (전부 한 커넥션)
//   ⓑ 거절(400)      → ROLLBACK 으로 끝나고 **쓰기 SQL 0건**(옮기다 만 상태가 없다)
//   ⓒ 없는 묶음(404) → 같은 규율(쓰기 0 · ROLLBACK)
//   ⓓ 감사 기록      → **커밋 뒤** 풀에서 나간다(롤백된 일을 append-only 로그에 남기지 않는다)
import test from "node:test";
import assert from "node:assert/strict";
import { itemsPool } from "../db/client.js";
import { removeCategoryGroup } from "./category-group-store.js";

type Call = { via: "tx" | "pool"; sql: string };
let calls: Call[] = [];
/** 그 묶음에 남아 있다고 답할 카테고리 수 — 시나리오마다 바꾼다. */
let inUse = 0;
/** 지울 묶음이 실재하는가(ⓒ 에서 false). */
let exists = true;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

//  ⚠ **async 로 둔다** — withTx 의 롤백 경로가 `client.query("ROLLBACK").catch(…)` 를 부른다.
//   동기값을 돌려주면 거기서 TypeError 가 나고, 그러면 이 테스트가 «롤백을 안 했다» 가 아니라 엉뚱한 이유로 빨개진다.
async function handle(via: "tx" | "pool", rawSql: unknown): Promise<{ rows: unknown[]; rowCount: number }> {
  const sql = norm(String(rawSql));
  calls.push({ via, sql });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
  //  ⚠ 잠금(FOR UPDATE)을 **매칭 조건에 넣지 않는다** — 넣으면 잠금을 뗀 코드가 «페이크가 모르는 SQL» 로
  //   죽어서, ⓐ 가 «잠금이 없다» 가 아니라 아무 이유로나 빨개진다(무엇이 깨졌는지 못 읽는 red 는 가드가 아니다).
  if (/FROM category_group WHERE key=\$1 AND state<>'archived'/.test(sql)) {
    return exists
      ? { rows: [{ id: 7, key: "make", name: "내가 만든 것", hint: "작업물", sort: 0, state: "active", origin: "welcome" }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (/count\(\*\)::int AS n FROM category WHERE group_key/.test(sql)) return { rows: [{ n: inUse }], rowCount: 1 };
  if (/SELECT key FROM category_group WHERE state='active' AND key<>/.test(sql)) {
    return { rows: [{ key: "ref" }, { key: "rule" }], rowCount: 2 };
  }
  if (/^UPDATE category SET group_key/.test(sql)) return { rows: [], rowCount: inUse };
  if (/^DELETE FROM category_group/.test(sql)) return { rows: [], rowCount: 1 };
  if (/INSERT INTO org_content_audit/.test(sql)) return { rows: [], rowCount: 1 };
  throw new Error("페이크가 모르는 SQL: " + sql);
}

// 주입 seam — 코드가 쓰는 DB 표면 둘(풀 직접 query · withTx 의 connect)을 갈아 끼운다.
//  두 표면을 **구분해서** 기록하는 것이 이 파일의 핵심이다: 같은 SQL 이라도 트랜잭션 밖에서 나가면 원자성이 없다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(itemsPool as any).query = (sql: unknown) => handle("pool", sql);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(itemsPool as any).connect = async () => ({ query: (sql: unknown) => handle("tx", sql), release() { /* no-op */ } });

const reset = (opts: { inUse: number; exists?: boolean }): void => {
  calls = []; inUse = opts.inUse; exists = opts.exists ?? true;
};
const sqls = (via?: "tx" | "pool"): string[] => calls.filter((c) => !via || c.via === via).map((c) => c.sql);
const writes = (): string[] => sqls().filter((s) => /^(UPDATE category|DELETE FROM category_group)\b/.test(s));

test("ⓐ 확인·재배정·삭제가 한 트랜잭션에서, 대상 행을 잡고 순서대로 돈다", async () => {
  reset({ inUse: 4 });
  const out = await removeCategoryGroup("make", { reassignTo: "ref" }, { actor: "u1", source: "web" });
  assert.deepEqual(out, { deleted: true, key: "make", moved: 4, reassign_to: "ref" });

  const tx = sqls("tx");
  assert.equal(tx[0], "BEGIN", "트랜잭션 밖에서 먼저 읽으면 그 읽기는 잠금 밖이다");
  assert.equal(tx[tx.length - 1], "COMMIT");
  //  ★ 대상 묶음 행을 **잠근다** — 이게 없으면 동시 삭제 둘이 모두 «비었다» 를 보고 둘 다 지운다.
  assert.ok(tx.some((s) => /FROM category_group WHERE key=\$1 .* FOR UPDATE/.test(s)), "FOR UPDATE 로 대상 행을 안 잡았다");
  //  순서: 잠금 → 집계 → 재배정 → 삭제. 집계가 잠금보다 먼저면 그 숫자는 잠금 밖에서 센 것이다.
  const at = (re: RegExp) => tx.findIndex((s) => re.test(s));
  const lock = at(/FOR UPDATE/), count = at(/count\(\*\)/), move = at(/^UPDATE category SET group_key/), del = at(/^DELETE FROM category_group/);
  assert.ok(lock >= 0 && lock < count && count < move && move < del, `순서가 어긋났다: ${JSON.stringify({ lock, count, move, del })}`);
  //  ★ 쓰기가 트랜잭션 밖(풀)으로 새지 않았다.
  assert.deepEqual(sqls("pool").filter((s) => /^(UPDATE|DELETE)/.test(s)), [], "쓰기가 트랜잭션 밖에서 나갔다");
});

test("ⓑ 거절되면 한 행도 안 바뀐다 — ROLLBACK 으로 끝나고 쓰기 SQL 이 0건", async () => {
  reset({ inUse: 3 });
  await assert.rejects(
    () => removeCategoryGroup("make", { reassignTo: null }, { actor: "u1", source: "web" }),
    /카테고리 3개가 있습니다/);
  assert.deepEqual(writes(), [], "거절인데 옮기거나 지웠다");
  assert.equal(sqls("tx").at(-1), "ROLLBACK", "거절이 ROLLBACK 으로 안 끝났다(반쪽 반영)");
  assert.ok(!sqls("tx").includes("COMMIT"));
});

test("ⓒ 없는 묶음도 같은 규율 — 쓰기 0 · ROLLBACK", async () => {
  reset({ inUse: 0, exists: false });
  await assert.rejects(() => removeCategoryGroup("유령", {}, { actor: "u1", source: "web" }), /없음/);
  assert.deepEqual(writes(), []);
  assert.equal(sqls("tx").at(-1), "ROLLBACK");
});

test("ⓓ 감사는 커밋 뒤에 남는다 — 롤백된 일이 append-only 로그에 남으면 되돌릴 수 없다", async () => {
  reset({ inUse: 4 });
  await removeCategoryGroup("make", { reassignTo: "ref" }, { actor: "u1", source: "web" });
  const audits = calls.filter((c) => /INSERT INTO org_content_audit/.test(c.sql));
  assert.equal(audits.length, 2, "재배정·삭제 두 줄이 남아야 한다");
  for (const a of audits) assert.equal(a.via, "pool", "감사가 트랜잭션 커넥션에서 나갔다(공유 풀이라 어차피 밖인데 순서가 뒤집힌다)");
  const commitAt = calls.findIndex((c) => c.sql === "COMMIT");
  for (const a of audits) assert.ok(calls.indexOf(a) > commitAt, "감사가 커밋보다 먼저 나갔다");

  //  거절된 삭제는 감사를 한 줄도 안 남긴다.
  reset({ inUse: 3 });
  await removeCategoryGroup("make", {}, { actor: "u1", source: "web" }).catch(() => { /* 기대된 거절 */ });
  assert.deepEqual(calls.filter((c) => /org_content_audit/.test(c.sql)), []);
});
