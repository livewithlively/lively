// 지식 조각 색인(#5203) PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/knowledge-chunk.pg-test.mjs
//
// 왜 이 계층인가: 약속이 전부 «어느 행이 살아남아 벡터를 지키나 · 어느 행이 비어 임베딩을 기다리나» 다. 행과 pgvector 칸을 실제로 봐야 한다.
//  벡터는 가짜 임베딩 서버(이 파일 안의 HTTP)가 정하고, 그 서버가 받은 요청의 크기를 잰다.
//
//  사양 · 엣지 표:
//   K1  저장 — 절마다 조각 · 순서 · 줄 · 경로 · 앞머리 · 벡터는 비어 있다
//   K2  끝 덧붙임 — 앞 조각은 같은 행이라 벡터가 남고, 새 조각만 비어 있다
//   K3  중간 삽입 — 뒤 조각은 같은 행 · 벡터가 남고 순서와 줄만 고친다
//   K4  제목 변경 — 경로가 있는 조각은 그대로다(문서 제목을 안 붙인다) · 경로 없는 조각만 다시 임베딩을 기다린다
//   K5  같은 글이 두 번 — 두 행 모두 남는다
//   K6  보관 · 검색 제외 · 삭제 — 조각이 사라진다 · 다시 활성으로 — 다시 생긴다
//   K7  조각이 없는 문서(chunk_key 비어 있음 · 규칙 판이 옛것) — 스윕이 조각만 만든다(낱말 행은 안 건드린다)
//   K8  벡터 칸은 halfvec · 인덱스는 halfvec_cosine_ops · 코사인 질의가 된다
//   K9  백필 — 빈 벡터를 채운다 · 한 요청 4건 이하 · maxRows 에서 멈춘다
//   K10 지식 벡터 스윕은 조각을 안 건드린다 — 저장이 깨우는 스윕이 조각에 묶이지 않는다
//   K11 조각 정비 — 한 판 100건 · 다음 판이 잇는다 · 하루 상한이면 건너뛴다 · 일시중지를 지킨다
//   K12 임베딩 서버가 실패하면(429 등) 한 시간 쉰다 — 다음 호출은 서버를 부르지 않는다
//   K13 모델이 바뀌면 옛 벡터도 대상이다 · 상태가 그 수를 말한다
//   K14 보관된 문서의 조각은 표에 남아 있어도 임베딩하지 않는다(글을 서버로 보내지 않는다)
//   K15 임베딩 칸이 사라져도 정비가 칸을 되살리고 채운다
//   K16 낱말 색인 행이 없는 이름의 조각(롤 중 옛 이미지가 지운 문서) — 스윕이 걷는다
//   K17 옛 이미지가 글 해시만 올린 문서 — 조각을 다시 맞춘다
//   K18 조각 표가 실패해도 낱말 색인은 맞춘다 · 표가 돌아오면 조각도 맞는다
//   K19 임베딩 꺼짐 — 조각은 만들고 벡터는 안 채운다
import pg from "pg";
import http from "node:http";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_chunk_5203";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");
await dbc.end();
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER"]) delete process.env[k];
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const kst = await import(`${D}/v6/knowledge-store.js`);
const ls = await import(`${D}/v6/knowledge-lex-store.js`);
const eb = await import(`${D}/v6/embedding-backfill.js`);
const { embeddingsCapabilities } = await import(`${D}/capabilities/delivery/embeddings.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dimRow = (await q(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid='knowledge'::regclass AND attname='embedding_vector'`))[0];
const DIMS = Number(dimRow?.d) > 0 ? Number(dimRow.d) : 1024;
const basis = (i) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const sizes = [];
let failStatus = 0;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const input = (JSON.parse(body || "{}").input ?? []);
    sizes.push(input.length);
    if (failStatus) { res.writeHead(failStatus, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "limit" })); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: basis(3) })) }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
await q(`INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING`);
const embedOn = JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${PORT}`, model: "fake", dimensions: DIMS, send_dimensions: false, request_timeout_ms: 5000, batch_size: 16 });
await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb, embedding_backfill_paused=true WHERE id=1`, [embedOn]);
const HOME = "zkhome";
await q(`INSERT INTO category(key, name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [HOME]);
const ctx = { actor: "pgt-k", source: "web" };
const save = (name, title, body) => kst.upsertKnowledge({ name, title, body_md: body, type: "reference", category: HOME }, ctx);
const rows = (name) => q(`SELECT id, seq, start_line, path, prefix, body, embedding_vector IS NOT NULL AS has FROM knowledge_chunk WHERE name=$1 ORDER BY seq`, [name]);
const fill = (name) => q(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model='fake', embedding_updated_at=now() WHERE name=$2`, ["[" + basis(3).join(",") + "]", name]);
const settle = async (name) => { await sleep(60); await ls.syncKnowledgeLex(name); };

try {
  // ── K1 ──
  await save("k-a", "문서 제목", "머리 글\n\n# 첫 절\n첫 글\n\n# 둘째 절\n둘째 글");
  await settle("k-a");
  const a = await rows("k-a");
  chk("K1 절마다 조각", a.length === 3, JSON.stringify(a));
  chk("K1 순서 · 줄 · 경로 · 앞머리", a[0].prefix === "문서 제목" && a[0].path === "" && a[1].prefix === "첫 절" && a[1].start_line === 4 && a[2].seq === 2 && a[2].start_line === 7, JSON.stringify(a.map((x) => [x.seq, x.start_line, x.prefix])));
  chk("K1 벡터는 비어 있다", a.every((x) => !x.has));

  // ── K2 ──
  await fill("k-a");
  await save("k-a", "문서 제목", "머리 글\n\n# 첫 절\n첫 글\n\n# 둘째 절\n둘째 글\n\n# 셋째 절\n덧붙인 글");
  await settle("k-a");
  const b = await rows("k-a");
  chk("K2 앞 조각은 같은 행 · 벡터가 남는다", b.length === 4 && a.every((x, i) => x.id === b[i].id && b[i].has), JSON.stringify(b.map((x) => [x.id, x.has])));
  chk("K2 새 조각만 비어 있다", b[3].has === false && b[3].path === "셋째 절");

  // ── K3 ──
  await fill("k-a");
  await save("k-a", "문서 제목", "머리 글\n\n# 끼운 절\n끼운 글\n\n# 첫 절\n첫 글\n\n# 둘째 절\n둘째 글\n\n# 셋째 절\n덧붙인 글");
  await settle("k-a");
  const c = await rows("k-a");
  const firstAfter = c.find((x) => x.path === "첫 절");
  chk("K3 뒤 조각은 같은 행 · 벡터가 남고 자리만 고친다", firstAfter.id === a[1].id && firstAfter.has && firstAfter.seq === 2 && firstAfter.start_line === 7, JSON.stringify(firstAfter));
  chk("K3 끼운 조각만 비어 있다", c.filter((x) => !x.has).length === 1 && c[1].path === "끼운 절");

  // ── K4 ──
  await fill("k-a");
  const before = await rows("k-a");
  await save("k-a", "바뀐 제목", "머리 글\n\n# 끼운 절\n끼운 글\n\n# 첫 절\n첫 글\n\n# 둘째 절\n둘째 글\n\n# 셋째 절\n덧붙인 글");
  await settle("k-a");
  const d = await rows("k-a");
  chk("K4 경로가 있는 조각은 제목이 바뀌어도 그대로다", d.slice(1).every((x, i) => x.id === before[i + 1].id && x.has));
  chk("K4 경로 없는 조각만 새로 임베딩을 기다린다", d[0].prefix === "바뀐 제목" && d[0].has === false);

  // ── K5 ──
  await save("k-dup", "같은 글", "# 절\n같은 글\n\n# 절\n같은 글");
  await settle("k-dup");
  await fill("k-dup");
  await save("k-dup", "같은 글", "# 절\n같은 글\n\n# 절\n같은 글\n\n# 절\n같은 글");
  await settle("k-dup");
  const dup = await rows("k-dup");
  chk("K5 같은 글이 여럿이어도 행이 맞다", dup.length === 3 && dup.filter((x) => x.has).length === 2, JSON.stringify(dup.map((x) => x.has)));

  // ── K6 ──
  await q(`UPDATE knowledge SET lifecycle='archived', updated_at=now() WHERE name='k-dup'`);
  await ls.sweepKnowledgeLex();
  chk("K6 보관 — 조각이 사라진다", (await rows("k-dup")).length === 0);
  await q(`UPDATE knowledge SET lifecycle='active', updated_at=now() WHERE name='k-dup'`);
  await ls.sweepKnowledgeLex();
  chk("K6 다시 활성 — 다시 생긴다", (await rows("k-dup")).length === 3);
  await q(`UPDATE knowledge SET searchable=false WHERE name='k-dup'`);
  await ls.sweepKnowledgeLex();
  chk("K6 검색 제외 — 조각이 사라진다", (await rows("k-dup")).length === 0);
  await save("k-del", "지울 것", "# 절\n글"); await settle("k-del");
  await q(`DELETE FROM knowledge WHERE name='k-del'`);
  await ls.sweepKnowledgeLex();
  chk("K6 삭제 — 조각이 사라진다", (await rows("k-del")).length === 0);

  // ── K7 ──
  await save("k-old", "옛 문서", "# 절\n옛 글"); await settle("k-old");
  await q(`DELETE FROM knowledge_chunk WHERE name='k-old'`);
  await q(`UPDATE knowledge_lex_doc SET chunk_key=NULL WHERE name='k-old'`);
  const xmin = (await q(`SELECT p.xmin::text AS x FROM knowledge_lex_posting p JOIN knowledge_lex_doc d ON d.id=p.doc_id WHERE d.name='k-old' ORDER BY p.term`)).map((r) => r.x).join();
  const s7 = await ls.sweepKnowledgeLex();
  chk("K7 조각이 없는 문서는 스윕이 조각을 만든다", s7.indexed === 1 && (await rows("k-old")).length === 1, JSON.stringify(s7));
  chk("K7 낱말 행은 안 건드린다", xmin === (await q(`SELECT p.xmin::text AS x FROM knowledge_lex_posting p JOIN knowledge_lex_doc d ON d.id=p.doc_id WHERE d.name='k-old' ORDER BY p.term`)).map((r) => r.x).join());
  await q(`UPDATE knowledge_lex_doc SET chunk_key = content_hash || ':0' WHERE name='k-old'`);
  chk("K7 규칙 판이 옛것이어도 스윕 대상이다", (await ls.sweepKnowledgeLex()).indexed === 1);

  // ── K8 ──
  const ty = (await q(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid='knowledge_chunk'::regclass AND attname='embedding_vector'`))[0]?.t;
  chk("K8 벡터 칸은 halfvec", ty === `halfvec(${DIMS})`, String(ty));
  const ix = (await q(`SELECT indexdef FROM pg_indexes WHERE indexname='knowledge_chunk_embedding_hnsw'`))[0]?.indexdef ?? "";
  chk("K8 인덱스는 halfvec_cosine_ops", /hnsw/.test(ix) && /halfvec_cosine_ops/.test(ix), ix);
  const near = await q(`SELECT name, 1 - (embedding_vector <=> $1::halfvec) AS s FROM knowledge_chunk WHERE embedding_vector IS NOT NULL ORDER BY embedding_vector <=> $1::halfvec LIMIT 1`, ["[" + basis(3).join(",") + "]"]);
  chk("K8 코사인 질의가 된다", Number(near[0]?.s) > 0.99, JSON.stringify(near));

  // ── K9 ──
  await q(`UPDATE knowledge_chunk SET embedding_vector=NULL, embedding_model=NULL, embedding_updated_at=NULL`);
  await q(`UPDATE org_runtime_config SET embedding_backfill_paused=false WHERE id=1`);
  await q(`INSERT INTO knowledge(name, title, body_md, updated_by) VALUES('k-many','많은 조각','','x')`);
  const addChunks = async (from, to, name = "k-many") => { for (let i = from; i < to; i++) await q(`INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash) VALUES($1, $2, 1, $3, $4)`, [name, i, `글 ${i}`, `h${i}`]); };
  await addChunks(0, 30);
  sizes.length = 0;
  const total = Number((await eb.countEmbeddingBacklog(eb.KNOWLEDGE_CHUNK_TARGET)).pending);
  const r9 = await eb.runEmbeddingBackfill({ mode: "pending", maxRows: 10 }, eb.KNOWLEDGE_CHUNK_TARGET);
  chk("K9 maxRows 에서 멈춘다", r9.ok && r9.embedded >= 10 && r9.embedded <= 13, JSON.stringify(r9));
  chk("K9 한 요청 4건 이하(설정이 16 이어도)", sizes.length > 0 && Math.max(...sizes) <= 4, JSON.stringify(sizes));
  chk("K9 남은 것은 대기로 남는다", Number((await eb.countEmbeddingBacklog(eb.KNOWLEDGE_CHUNK_TARGET)).pending) === total - r9.embedded);
  chk("K9 벡터와 모델이 써진다", (await q(`SELECT embedding_model FROM knowledge_chunk WHERE embedding_vector IS NOT NULL LIMIT 1`))[0]?.embedding_model === "fake");

  // ── K10 ──
  await addChunks(30, 260);
  await q(`UPDATE knowledge_chunk SET embedding_vector=NULL, embedding_model=NULL, embedding_updated_at=NULL`);
  await eb.runAutoBackfillSweep();
  chk("K10 지식 벡터 스윕은 지식을 채운다", (await q(`SELECT count(*)::int AS n FROM knowledge WHERE embedding_vector IS NULL AND lifecycle='active' AND searchable`))[0].n === 0);
  chk("K10 지식 벡터 스윕은 조각을 안 건드린다", (await q(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE embedding_vector IS NOT NULL`))[0].n === 0);

  // ── K11 ──
  const filled = async () => Number((await q(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE embedding_vector IS NOT NULL`))[0].n);
  chk("K11 판 상한", (await eb.chunkEmbedRoom()) === eb.CHUNK_EMBED_SWEEP_MAX);
  const s11 = await eb.sweepChunkEmbeddings();
  const f1 = await filled();
  chk("K11 한 판은 100건 안팎까지", f1 >= 100 && f1 <= 103 && s11.embedded === f1, JSON.stringify([s11, f1]));
  await eb.sweepChunkEmbeddings();
  chk("K11 다음 판이 잇는다", (await filled()) >= 200, String(await filled()));
  await q(`UPDATE org_runtime_config SET embedding_backfill_paused=true WHERE id=1`);
  chk("K11 일시중지를 지킨다", (await eb.sweepChunkEmbeddings()).skipped === "paused");
  await q(`UPDATE org_runtime_config SET embedding_backfill_paused=false WHERE id=1`);
  await q(`INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash, embedding_model, embedding_updated_at) SELECT 'k-many', g, 1, 'x', 'b'||g, 'fake', now() FROM generate_series(1000, $1::int) g`, [1000 + eb.CHUNK_EMBED_DAILY_MAX - (await filled()) - 40]);
  const room = await eb.chunkEmbedRoom();
  chk("K11 하루 상한에 가까우면 남은 만큼만", room > 0 && room < eb.CHUNK_EMBED_SWEEP_MAX, String(room));
  await q(`INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash, embedding_model, embedding_updated_at) SELECT 'k-many', g, 1, 'x', 'c'||g, 'fake', now() FROM generate_series(1, 100) g`);
  chk("K11 하루 상한을 넘으면 0", (await eb.chunkEmbedRoom()) === 0);
  chk("K11 상한이면 건너뛴다", (await eb.sweepChunkEmbeddings()).skipped === "budget");
  await q(`DELETE FROM knowledge_chunk WHERE text_hash ~ '^[bc][0-9]'`);

  // ── K12 ──
  failStatus = 429; sizes.length = 0;
  const s12 = await eb.sweepChunkEmbeddings();
  chk("K12 서버가 막으면 멈춘다", !!s12.skipped && s12.skipped !== "busy" && (await filled()) >= 200, JSON.stringify(s12));
  const called = sizes.length; failStatus = 0;
  const s12b = await eb.sweepChunkEmbeddings();
  chk("K12 쉬는 동안은 서버를 안 부른다", s12b.skipped === "backoff" && sizes.length === called, JSON.stringify(s12b));
  const later = Date.now() + 2 * 60 * 60_000;
  chk("K12 한 시간 뒤 다시 돈다", (await eb.sweepChunkEmbeddings(() => later)).embedded > 0);
  eb.__resetChunkRetry();

  // ── K13 ──
  await q(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model='old-model', embedding_updated_at=now() - interval '2 days' WHERE name='k-many'`, ["[" + basis(3).join(",") + "]"]);
  await q(`UPDATE knowledge_chunk SET embedding_updated_at=now() - interval '2 days' WHERE embedding_updated_at IS NOT NULL`);
  const st = await embeddingsCapabilities.find((x) => x.name === "org_embeddings_status").handler({}, { userId: "x", scopes: ["admin"] }, { source: "web" });
  chk("K13 상태가 옛 모델 벡터도 대기로 센다", st.chunk_backlog && Number(st.chunk_backlog.pending) >= 260 && Number(st.chunk_backlog.total) >= Number(st.chunk_backlog.pending), JSON.stringify(st.chunk_backlog));
  await eb.sweepChunkEmbeddings();
  const moved13 = Number((await q(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE embedding_model='fake' AND name='k-many'`))[0].n);
  chk("K13 모델이 바뀌면 옛 벡터도 다시 채운다", moved13 >= 100 && moved13 <= 103, String(moved13));

  // ── K14 ──
  await q(`UPDATE knowledge_chunk SET embedding_vector=NULL, embedding_model=NULL, embedding_updated_at=NULL`);
  await q(`UPDATE knowledge SET lifecycle='archived', updated_at=now() WHERE name='k-many'`);
  sizes.length = 0;
  const pendingAll = Number((await eb.countEmbeddingBacklog(eb.KNOWLEDGE_CHUNK_TARGET)).pending);
  const totalRows = Number((await q(`SELECT count(*)::int AS n FROM knowledge_chunk`))[0].n);
  chk("K14 보관된 문서의 조각은 대상이 아니다", pendingAll < totalRows - 200, JSON.stringify([pendingAll, totalRows]));
  await eb.sweepChunkEmbeddings();
  chk("K14 임베딩하지 않는다", Number((await q(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE name='k-many' AND embedding_vector IS NOT NULL`))[0].n) === 0);
  await ls.sweepKnowledgeLex();
  chk("K14 스윕이 걷는다", (await rows("k-many")).length === 0);

  // ── K15 ──
  await q(`DROP INDEX knowledge_chunk_embedding_hnsw`);
  await q(`ALTER TABLE knowledge_chunk DROP COLUMN embedding_vector`);
  const s15 = await eb.sweepChunkEmbeddings();
  chk("K15 칸이 사라져도 되살리고 채운다", s15.embedded > 0 && (await q(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid='knowledge_chunk'::regclass AND attname='embedding_vector' AND NOT attisdropped`))[0]?.t === `halfvec(${DIMS})`, JSON.stringify(s15));

  // ── K16 ──
  await q(`INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash) VALUES('k-orphan', 0, 1, '고아', 'o0')`);
  chk("K16 낱말 색인 행이 없는 이름의 조각도 걷는다", (await ls.sweepKnowledgeLex()).removed === 1 && (await rows("k-orphan")).length === 0);

  // ── K17 ──
  await save("k-roll", "롤", "# 절\n옛 글"); await settle("k-roll");
  await q(`UPDATE knowledge SET body_md=$1, updated_at=now() WHERE name='k-roll'`, ["# 절\n새 글"]);
  await q(`UPDATE knowledge_lex_doc d SET content_hash = md5(k.name || E'\n' || COALESCE(k.title, '') || E'\n' || k.body_md), source_updated_at = k.updated_at FROM knowledge k WHERE k.name = d.name AND d.name='k-roll'`);
  chk("K17 글 해시만 올라간 문서도 스윕 대상이다", (await ls.sweepKnowledgeLex()).indexed === 1 && (await rows("k-roll"))[0].body === "새 글", JSON.stringify(await rows("k-roll")));

  // ── K18 ──
  await sleep(60);
  await q(`ALTER TABLE knowledge_chunk RENAME TO knowledge_chunk_off`);
  await q(`INSERT INTO knowledge(name, title, body_md, updated_by) VALUES('k-fail','실패','# 절\n낱말분리시험','x')`);
  const s18 = await ls.sweepKnowledgeLex();
  await q(`ALTER TABLE knowledge_chunk_off RENAME TO knowledge_chunk`);
  chk("K18 조각이 실패해도 판은 끝나고 실패로 센다", s18.failed >= 1, JSON.stringify(s18));
  chk("K18 낱말 색인은 맞는다", (await q(`SELECT 1 FROM knowledge_lex_posting WHERE term='낱말분리시험'`)).length === 1);
  await ls.sweepKnowledgeLex();
  chk("K18 표가 돌아오면 조각도 맞는다", (await rows("k-fail")).length === 1);

  // ── K19 ──
  await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [JSON.stringify({ provider: "off", explicit: true })]);
  await save("k-off", "꺼짐", "# 절\n글"); await settle("k-off");
  chk("K19 임베딩이 꺼져도 조각은 만든다", (await rows("k-off")).length === 1);
  chk("K19 벡터는 안 채운다", (await eb.sweepChunkEmbeddings()).skipped === "off" && (await rows("k-off"))[0].has === false);
} catch (e) {
  fail++; console.error("FAIL 예외", e);
} finally {
  await new Promise((r) => server.close(r));
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);
