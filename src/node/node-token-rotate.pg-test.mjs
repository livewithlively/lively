// 노드 토큰 회전 PG 통합 테스트 — 회전이 겹쳐도 «살아 있는 노드 토큰 = org_node 에 붙은 그 하나» 가 지켜지는지 행을 되읽어 본다.
//    npm run build && ITEMS_DATABASE_URL=… node src/node/node-token-rotate.pg-test.mjs
//  왜 이 계층인가: 약속이 UPDATE 의 기대값 조건(token_hash IS NOT DISTINCT FROM <읽은 값>)이다. 조건이 빠지면 늦은 회전이 앞 회전의 새 토큰을
//   모른 채 덮어, 그 토큰은 회수되지 않은 채 남고 앞 호출자는 붙지 못하는 토큰을 받는다. 목으로는 조건을 지워도 초록이다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 이 필요하다(실 Postgres)"); process.exit(2); }
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/node/store.js`);

let pass = 0, fail = 0;
const chk = (n, c, why) => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why ?? ""}`); } };
const OWNER = "__noderotate_pg__";
const NODE = "noderotate-pg";
const liveTokens = async () => (await itemsPool.query(`SELECT token_hash FROM auth_token WHERE label=$1 AND revoked_at IS NULL`, [`node:${NODE}`])).rows.map((r) => r.token_hash);
const bound = async () => (await itemsPool.query(`SELECT token_hash FROM org_node WHERE id=$1`, [NODE])).rows[0]?.token_hash ?? null;
const cleanup = async () => {
  await itemsPool.query(`DELETE FROM org_node WHERE id=$1`, [NODE]).catch(() => {});
  await itemsPool.query(`DELETE FROM auth_token WHERE label=$1`, [`node:${NODE}`]).catch(() => {});
};
try {
  await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas();
  await cleanup();
  await itemsPool.query(`INSERT INTO org_member(id, kind, display_name, state, scopes) VALUES($1,'human','pg','active','[]'::jsonb) ON CONFLICT DO NOTHING`, [OWNER]);
  await store.createNode({ id: NODE, owner: OWNER });

  const one = await store.rotateNodeToken(NODE, OWNER);
  const live1 = await liveTokens();
  chk("R1 단독 회전 — 살아 있는 토큰은 붙은 것 하나", live1.length === 1 && live1[0] === one.node.token_hash, JSON.stringify(live1));

  //  겹침 강제 — 다른 연결이 노드 행을 잠근 동안 회전 둘을 띄운다. 둘 다 같은 구 토큰을 읽고(getNode 는 잠금과 무관한 SELECT) UPDATE 에서
  //   기다리다, 잠금이 풀리면 하나만 이기고 하나는 409 여야 한다.
  const blocker = await itemsPool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT 1 FROM org_node WHERE id=$1 FOR UPDATE`, [NODE]);
    const both = Promise.allSettled([store.rotateNodeToken(NODE, OWNER), store.rotateNodeToken(NODE, OWNER)]);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
      //  문장 접두는 store.ts rotateNodeToken 의 UPDATE 와 맞춰 둔다 — 그 SQL 을 고치면 여기 준비 확인이 0 으로 떨어진다.
      waiting = Number((await itemsPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE 'UPDATE org_node SET token_hash%'`)).rows[0].n);
    }
    chk("R3 (준비) 회전 둘이 같은 행 잠금에서 기다린다", waiting === 2, `waiting=${waiting}`);
    await blocker.query("COMMIT");
    const rs = await both;
    const ok409 = rs.filter((r) => r.status === "rejected" && r.reason?.status === 409).length;
    chk("R3 겹친 회전 — 하나는 이기고 하나는 409", rs.filter((r) => r.status === "fulfilled").length === 1 && ok409 === 1, JSON.stringify(rs.map((r) => r.status === "fulfilled" ? "ok" : String(r.reason?.status ?? r.reason))));
    const live = await liveTokens(), b = await bound();
    chk("R3 살아 있는 노드 토큰 = org_node 에 붙은 하나", live.length === 1 && live[0] === b, JSON.stringify({ live, b }));
  } finally { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); }
} catch (e) {
  fail++; console.error(`FAIL 예외 — ${e && e.stack || e}`);
} finally {
  await cleanup();
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [OWNER]).catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`node-token-rotate.pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
