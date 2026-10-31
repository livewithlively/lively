// 조각 색인 · 찾기의 워크스페이스 격리(#5204) PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/knowledge-chunk-rls.pg-test.mjs
//
// 왜 이 계층인가: 조각 검색의 벡터 후보에는 워크스페이스 조건이 SQL 에 없다 — 행 보안이 격리의 전부다. 슈퍼유저로는 재지 못하므로 매니지드 게이트웨이와 같은 조건
//  (비특권 앱 역할 · ensureTenantPolicies 가 건 FORCE RLS · 요청마다 워크스페이스 값)으로 실제 찾기 · 소환 · 스윕을 돌린다.
//
//  사양 · 엣지 표:
//   R1 배선 — 앱 역할은 RLS 를 못 넘고, 조각 표에 정책이 걸렸다(새 표가 정책 도입부에 자동으로 잡힌다)
//   R2 같은 이름의 문서 — 찾기 · 소환이 자기 워크스페이스의 글만 내놓는다
//   R3 다른 워크스페이스의 조각이 더 가까워도 나오지 않는다
//   R4 준비 판정은 워크스페이스마다 — 한쪽이 찼어도 다른 쪽은 문서 벡터로 간다
//   R5 하루 상한은 워크스페이스마다 센다
//   R6 스윕 · 저장 직후 임베딩 · 정비가 자기 워크스페이스 행만 쓴다
//   R7 다른 워크스페이스 값으로 조각 행을 고치거나 지울 수 없다
//   R8 한 워크스페이스의 백필 일시중지가 다른 워크스페이스를 멈추지 않는다 · 마지막 정비 결과도 워크스페이스마다
import pg from "pg";
import http from "node:http";
import { execFileSync } from "node:child_process";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_chunkrls_5204";
const ROLE = `lvly_app_${DB}`;            // org/tenancy/activate.ts appRoleName(current_database()) 과 같은 이름 — 정책이 이 역할에 걸린다
const ROLE_PW = "pgt-chunkrls";
const dsnFor = (db, role) => { const u = new URL(BASE); u.pathname = "/" + db; if (role) { u.username = role.name; u.password = role.pw; } return u.toString(); };
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const TA = "aaaaaaaa-0000-4000-8000-00000000000a", TB = "bbbbbbbb-0000-4000-8000-00000000000b", TC = "cccccccc-0000-4000-8000-00000000000c";

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`DROP ROLE IF EXISTS ${ROLE}`);
let dbc = null, itemsPool = null, server = null;
try {
  await su.query(`CREATE DATABASE ${DB}`);
  await su.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  const OWNER = dsnFor(DB);
  dbc = new pg.Client({ connectionString: OWNER }); await dbc.connect();
  await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");
  const childEnv = { ...process.env, ITEMS_DATABASE_URL: OWNER };
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID", "EMBEDDINGS_PROVIDER"]) delete childEnv[k];
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { initAllSchemas } = await import(${J(`${D}/boot/schemas.js`)});
    await initAllSchemas({ quiet: true });
    const { ensureTenantPolicies } = await import(${J(`${D}/org/tenancy/activate.js`)});
    const r = await ensureTenantPolicies();
    const { itemsPool } = await import(${J(`${D}/db/client.js`)});
    await itemsPool.end();
    process.stdout.write("\\n@@policies " + JSON.stringify(r) + "\\n");
    process.exit(0);`], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 300_000 });
  const policies = JSON.parse(/^@@policies (.+)$/m.exec(out)?.[1] ?? "null");
  await dbc.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);

  process.env.ITEMS_DATABASE_URL = dsnFor(DB, { name: ROLE, pw: ROLE_PW });
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER"]) delete process.env[k];
  let CUR = TA;
  const client = await import(`${D}/db/client.js`);
  itemsPool = client.itemsPool;
  client.installTenantResolver(() => CUR);
  const ks = await import(`${D}/v6/knowledge-search.js`);
  const kst = await import(`${D}/v6/knowledge-store.js`);
  const ls = await import(`${D}/v6/knowledge-lex-store.js`);
  const cs = await import(`${D}/v6/knowledge-chunk-search.js`);
  const eb = await import(`${D}/v6/embedding-backfill.js`);
  const { __resetQueryEmbedCache } = await import(`${D}/v6/search-util.js`);

  const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
  const owner = async (sql, params = []) => (await dbc.query(sql, params)).rows;
  const dims = Number((await owner(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid='knowledge'::regclass AND attname='embedding_vector'`))[0]?.d) || 1024;
  const basis = (i) => Array.from({ length: dims }, (_, j) => (j === i ? 1 : 0));
  const near = (i, c) => Array.from({ length: dims }, (_, j) => (j === i ? c : j === 500 ? Math.sqrt(1 - c * c) : 0));
  const lit = (v) => "[" + v.join(",") + "]";

  server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const input = (JSON.parse(body || "{}").input ?? []).map(String);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: basis(Number(/질의(\d+)/.exec(t)?.[1] ?? 800)) })) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${server.address().port}`, model: "bge-m3", dimensions: dims, send_dimensions: false, request_timeout_ms: 5000, batch_size: 8 });
  const ctx = { actor: "pgt-r", source: "web" };
  const save = (name, title, body) => kst.upsertKnowledge({ name, title, body_md: body, type: "reference", category: "zrhome" }, ctx);
  const inTenant = async (t, fn) => { CUR = t; return fn(); };
  const settled = async () => { await sleep(60); for (let i = 0; i < 100; i++) { const n = Number((await owner(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state<>'idle'`, [ROLE]))[0].n); if (!n) break; await sleep(10); } };
  const fresh = () => { cs.resetChunkIndex(); __resetQueryEmbedCache(); };
  const search = async (query) => { const d = {}; const rows = await ks.hybridSearchKnowledge(query, { limit: 20 }, null, d); return { rows, route: d.route, n: rows.map((r) => r.name) }; };
  const recall = async (text) => { const d = {}; const rows = await cs.recallKnowledge({ text }, null, d); return { rows, route: d.route, n: rows.map((r) => r.name) }; };

  for (const t of [TA, TB, TC]) {
    await inTenant(t, async () => {
      await q(`INSERT INTO org_runtime_config(id, embedding_config, embedding_backfill_paused) VALUES(1, $1::jsonb, true) ON CONFLICT (tenant_id, id) DO UPDATE SET embedding_config=EXCLUDED.embedding_config, embedding_backfill_paused=true`, [cfg]);
      await q(`INSERT INTO category(key, name) VALUES('zrhome','zrhome') ON CONFLICT DO NOTHING`);
    });
  }
  await inTenant(TA, () => save("r-same", "에이 문서", "# 에이 절\n에이 워크스페이스의 글"));
  await settled();
  await inTenant(TB, async () => { await save("r-same", "비 문서", "# 비 절\n비 워크스페이스의 글"); await save("r-b-only", "비 전용", "# 전용 절\n비 쪽 전용 글"); });
  await settled();
  await inTenant(TC, () => save("r-same", "씨 문서", "# 씨 절\n씨 워크스페이스의 글"));
  await settled();

  // ── R1 ──
  const role = (await q(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`))[0];
  const rel = (await owner(`SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE relname='knowledge_chunk'`))[0];
  const pols = (await owner(`SELECT polname FROM pg_policy WHERE polrelid='knowledge_chunk'::regclass`)).map((r) => r.polname);
  chk("R1 앱 역할은 RLS 를 못 넘고 조각 표에 격리 정책이 있다", Number(policies?.tables) > 0 && role?.rolsuper === false && role?.rolbypassrls === false && rel?.on === true && rel?.forced === true && pols.includes("tenant_isolation"), J({ role, rel, pols }));
  chk("R1 전제 — 조각이 워크스페이스마다 있다", J((await owner(`SELECT count(DISTINCT tenant_id)::int AS n FROM knowledge_chunk`))[0].n) === "3");
  const seenA = await inTenant(TA, () => q(`SELECT name FROM knowledge_chunk`));
  chk("R1 앱 역할로는 자기 행만 보인다", seenA.length === 1, J(seenA));

  // ── R2 ──
  const vec = (t, name, v) => owner(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model='bge-m3', embedding_updated_at=now() WHERE tenant_id=$2 AND name=$3`, [lit(v), t, name]);
  await vec(TA, "r-same", near(1, 0.9));
  await vec(TB, "r-same", basis(1));
  await vec(TB, "r-b-only", basis(1));
  fresh();
  const a2 = await inTenant(TA, () => search("질의1 문장으로 찾기"));
  chk("R2 찾기 — 자기 글만", a2.route === "hybrid-chunk" && a2.n.join() === "r-same" && a2.rows[0].snippet.includes("에이 워크스페이스의 글") && a2.rows[0].title === "에이 문서", J(a2));
  const a2r = await inTenant(TA, () => recall("질의1 문장을 충분히 길게 적어 둔 프롬프트"));
  chk("R2 소환 — 자기 글만", a2r.route === "chunk" && a2r.n.join() === "r-same" && a2r.rows[0].snippet === "에이 워크스페이스의 글", J(a2r));
  fresh();
  const b2 = await inTenant(TB, () => search("질의1 문장으로 찾기"));
  chk("R2 다른 쪽에서는 그쪽 글", b2.rows.find((r) => r.name === "r-same")?.snippet.includes("비 워크스페이스의 글"), J(b2));

  // ── R3 ──
  chk("R3 다른 워크스페이스의 더 가까운 조각이 안 나온다", !a2.n.includes("r-b-only") && !J(a2.rows).includes("비 쪽 전용 글") && !J(a2r.rows).includes("비 "), J(a2.n));
  chk("R3 공용 인덱스에 다른 쪽 행이 있어도 자기 행을 찾는다(후보가 안 빈다)", a2.n.length === 1);

  // ── R4 ──
  fresh();
  chk("R4 다 찬 워크스페이스는 조각을 쓴다", !!(await inTenant(TA, () => cs.chunkIndex())));
  chk("R4 안 찬 워크스페이스는 문서 벡터로 간다", (await inTenant(TC, () => cs.chunkIndex())) === null);
  chk("R4 판정이 섞이지 않는다", !!(await inTenant(TA, () => cs.chunkIndex())) && (await inTenant(TC, () => cs.chunkIndex())) === null);

  // ── R5 ──
  await owner(`INSERT INTO knowledge_chunk(tenant_id, name, seq, start_line, body, text_hash, embedding_model, embedding_updated_at) SELECT $1, 'r-same', 1000 + g, 1, 'x', 'x'||g, 'bge-m3', now() FROM generate_series(1, $2::int) g`, [TA, eb.CHUNK_EMBED_DAILY_MAX]);
  chk("R5 한쪽이 상한이어도", (await inTenant(TA, () => eb.chunkEmbedRoom())) === 0);
  chk("R5 다른 쪽은 남는다", (await inTenant(TC, () => eb.chunkEmbedRoom())) === eb.CHUNK_EMBED_SWEEP_MAX);
  await owner(`DELETE FROM knowledge_chunk WHERE tenant_id=$1 AND seq >= 1000`, [TA]);

  // ── R6 ──
  const counts = async () => Object.fromEntries((await owner(`SELECT tenant_id, count(embedding_vector)::int AS n FROM knowledge_chunk GROUP BY 1`)).map((r) => [r.tenant_id, r.n]));
  await owner(`UPDATE org_runtime_config SET embedding_backfill_paused=false`);
  const before = await counts();
  const sw = await inTenant(TC, () => eb.sweepChunkEmbeddings());
  const after = await counts();
  chk("R6 정비가 자기 워크스페이스만 채운다", sw.embedded === 1 && after[TC] === before[TC] + 1 && after[TA] === before[TA] && after[TB] === before[TB], J({ sw, before, after }));
  await inTenant(TC, () => save("r-c-new", "씨 새 문서", "# 절\n질의2 새 글"));
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) { ok = Number((await owner(`SELECT count(embedding_vector)::int AS n FROM knowledge_chunk WHERE tenant_id=$1 AND name='r-c-new'`, [TC]))[0].n) === 1; if (!ok) await sleep(30); }
  chk("R6 저장 직후 임베딩이 그 워크스페이스에 쓴다", ok);
  chk("R6 다른 워크스페이스는 그대로", J((({ [TA]: a, [TB]: b }) => [a, b])(await counts())) === J([after[TA], after[TB]]));
  await inTenant(TB, () => save("r-b-new", "비 새 문서", "# 절\n글"));
  await settled();
  const sweepA = await inTenant(TA, () => ls.sweepKnowledgeLex());
  chk("R6 낱말 스윕이 다른 쪽 문서를 고아로 안 지운다", sweepA.removed === 0 && Number((await owner(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE tenant_id=$1 AND name='r-b-new'`, [TB]))[0].n) === 1, J(sweepA));

  // ── R7 ──
  const hit = await inTenant(TA, () => itemsPool.query(`DELETE FROM knowledge_chunk WHERE name='r-b-only'`));
  chk("R7 다른 워크스페이스 행을 지우지 못한다", hit.rowCount === 0 && Number((await owner(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE tenant_id=$1 AND name='r-b-only'`, [TB]))[0].n) === 1);
  const up = await inTenant(TA, () => itemsPool.query(`UPDATE knowledge_chunk SET body='변조' WHERE name='r-b-only'`));
  chk("R7 다른 워크스페이스 행을 고치지 못한다", up.rowCount === 0);
  // ── R8 ──
  await owner(`UPDATE org_runtime_config SET embedding_backfill_paused=true WHERE tenant_id=$1`, [TB]);
  chk("R8 전제 — 다른 워크스페이스는 안 멈췄다", (await inTenant(TA, () => eb.refreshBackfillPausedFromDb())) === false);
  chk("R8 일시중지한 워크스페이스", (await inTenant(TB, () => eb.refreshBackfillPausedFromDb())) === true && (await inTenant(TB, () => eb.isBackfillPaused())) === true);
  chk("R8 다른 워크스페이스는 그대로다", (await inTenant(TA, () => eb.isBackfillPaused())) === false);
  await inTenant(TB, () => eb.sweepChunkEmbeddings());
  chk("R8 마지막 정비 결과가 섞이지 않는다", (await inTenant(TB, () => eb.lastChunkSweep()))?.skipped === "paused" && (await inTenant(TA, () => eb.lastChunkSweep()))?.skipped !== "paused");
} catch (e) {
  fail++; console.error("FAIL 예외", e);
} finally {
  if (server) await new Promise((r) => server.close(r));
  await itemsPool?.end().catch(() => {});
  await dbc?.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);
