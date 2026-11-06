// 조각으로 찾기(#5204) PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/knowledge-chunk-search.pg-test.mjs
//
// 왜 이 계층인가: 약속이 전부 SQL 이 어떤 문서를 어떤 자리로 내놓느냐다 — 벡터 · 공개범위 · 카테고리 · 임계가 한 문장에 묶여 있다. 벡터는 가짜 임베딩 서버가 정한다.
//
//  사양 · 엣지 표:
//   S1  조각이 덜 찼다 — 찾기 · 소환이 문서 벡터로 간다
//   S2  조각이 찼다 — 끝 절만 질의에 가까운 문서를 찾는다(문서 벡터는 멀다)
//   S3  스니펫 — 뜻으로 올라오면 맞은 절(`L<n>: «경로» 글`) · 낱말 순위가 더 높으면 맞은 줄 · context 를 달라면 맞은 줄 · names 는 스니펫 없음
//   S4  식별자 질의 — 낱말 채널만 · 임베딩을 안 부른다
//   S5  공개범위 — 숨은 문서의 조각이 가장 가까워도 안 나온다(찾기 · 소환) · 특권 신원에게는 나온다
//   S6  표를 맞추기 전의 조각 — 보관 · 검색 제외 문서가 안 나온다(찾기 · 소환)
//   S7  카테고리 · 주입 · 출처 제한 — 제한 밖 조각이 후보를 채워도 제한 안 문서가 나온다
//   S8  소환 기준선 · 건수 · 순서 · 문서마다 한 번 · 맞은 절의 자리
//   S9  소환 질의 — 앞 1,000자 · 짧으면 앞 턴 · 문서 벡터 길은 앞 2,000자
//   S10 되돌리기 스위치 — 끄면 찾기 · 소환이 문서 벡터로 · 켜면 돌아온다 · 상태가 말한다 · 값이 DB 에 남는다
//   S11 모델이 바뀌면 — 문서 벡터로 간다 · 조각을 다시 채우면 찾기는 돌아온다 · 기준선을 잰 모델이 아니면 소환은 문서 벡터로 남는다
//   S12 98% 문턱
//   S13 조각 SQL 이 실패해도 찾기 · 소환은 답한다
//   S14 벡터 칸이 vector 인 배포(옛 pgvector) — 그대로 돈다
//   S15 소환 입구 — 세션 호출을 기록한다 · 프롬프트 글은 안 남긴다 · 임베딩이 꺼지면 그렇다고 말한다
//   S16 사람 화면 찾기 — 검색 제외 문서를 글자로 찾는다
//   S17 탐색 폭이 트랜잭션 밖으로 새지 않는다
//   S18 저장 직후 — 그 문서의 조각만 곧 임베딩해 뜻으로 찾힌다 · 밀린 일은 안 건드린다 · 일시중지 · 하루 상한 · 문서당 상한(뒤 조각부터)
//   S19 약함 판정 — 조각으로 찾으면 조각으로 잰다(끝 절로만 맞는 문서가 «약하다» 가 안 된다)
//   S20 기록의 길 — 낱말 색인이 없으면 hybrid-chunk-grep
import pg from "pg";
import http from "node:http";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_chunksearch_5204";
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
const ks = await import(`${D}/v6/knowledge-search.js`);
const kst = await import(`${D}/v6/knowledge-store.js`);
const ls = await import(`${D}/v6/knowledge-lex-store.js`);
const cs = await import(`${D}/v6/knowledge-chunk-search.js`);
const { __resetQueryEmbedCache } = await import(`${D}/v6/search-util.js`);
const { embeddingsCapabilities } = await import(`${D}/capabilities/delivery/embeddings.js`);
const { recallCapabilities } = await import(`${D}/capabilities/recall.js`);
const { readNamedCapabilities, readStaticCapabilities } = await import(`${D}/capabilities/knowledge/read.js`);
const { getRuntimeConfig } = await import(`${D}/org/store.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const names = (rows) => rows.map((r) => r.name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 가짜 임베딩 서버 — 글 안의 «질의<n>» 이 축을 정한다. 받은 글을 남긴다. ──
const DIMS = Number((await q(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid='knowledge'::regclass AND attname='embedding_vector'`))[0]?.d) || 1024;
const basis = (i) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
//  축 i 와 코사인이 c 인 단위 벡터(남은 길이는 축 500 으로).
const near = (i, c) => Array.from({ length: DIMS }, (_, j) => (j === i ? c : j === 500 ? Math.sqrt(1 - c * c) : 0));
const lit = (v) => "[" + v.join(",") + "]";
const FAR = basis(900);
const seen = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const input = (JSON.parse(body || "{}").input ?? []).map(String);
    seen.push(...input);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: basis(Number(/질의(\d+)/.exec(t)?.[1] ?? 800)) })) }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
await q(`INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING`);
const cfg = (model) => JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${PORT}`, model, dimensions: DIMS, send_dimensions: false, request_timeout_ms: 5000, batch_size: 8 });
await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb, embedding_backfill_paused=true WHERE id=1`, [cfg("bge-m3")]);

const ctx = { actor: "pgt-s", source: "web" };
const HOME = "zshome";
await q(`INSERT INTO category(key, name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [HOME]);
const save = (name, title, body, extra = {}) => kst.upsertKnowledge({ name, title, body_md: body, type: "reference", category: HOME, ...extra }, ctx);
const settled = async () => { await sleep(40); for (let i = 0; i < 100; i++) { const n = Number((await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle'`))[0].n); if (!n) break; await sleep(10); } };
const sweep = async () => { await settled(); for (;;) { const r = await ls.sweepKnowledgeLex(); if (!r.indexed && !r.removed) break; } };
//  기본은 모든 벡터가 먼 축이다. 시험마다 필요한 조각 · 문서만 가깝게 둔다.
const fillAll = () => q(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model='bge-m3', embedding_updated_at=now() WHERE embedding_vector IS NULL`, [lit(FAR)]);
const fillDocs = () => q(`UPDATE knowledge SET embedding_vector=$1::vector, embedding_model='bge-m3', embedding_updated_at=now() WHERE embedding_vector IS NULL`, [lit(FAR)]);
const chunkVec = (name, seq, v) => q(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model='bge-m3', embedding_updated_at=now() WHERE name=$2 AND seq=$3`, [lit(v), name, seq]);
const docVec = (name, v) => q(`UPDATE knowledge SET embedding_vector=$1::vector, embedding_model='bge-m3', embedding_updated_at=now() WHERE name=$2`, [lit(v), name]);
const fresh = () => { cs.resetChunkIndex(); __resetQueryEmbedCache(); };
const search = async (query, opts = {}, viewer) => { const d = {}; const rows = await ks.hybridSearchKnowledge(query, { limit: 20, ...opts }, viewer, d); return { rows, route: d.route, n: names(rows) }; };
const recall = async (text, prev, viewer) => { const d = {}; const rows = await cs.recallKnowledge({ text, prev }, viewer, d); return { rows, route: d.route, n: names(rows), diag: d }; };

const T = "s";
try {
  await save(`${T}-tail`, "꼬리 문서", "# 머리 절\n머리 글\n\n## 둘째 절\n둘째 글\n\n## 끝 절\n끝에 덧붙인 결정");
  await save(`${T}-lex`, "낱말 문서", "첫 줄은 상관없다\n\n희귀낱말가나 가 든 줄");
  await sweep();

  // ── S1 ──
  await fillDocs();
  await docVec(`${T}-lex`, near(1, 0.61));
  fresh();
  chk("S1 전제 — 조각에 벡터가 없다", (await cs.chunkIndex()) === null);
  const s1 = await search("질의1 문장으로 찾기");
  chk("S1 찾기는 문서 벡터로", s1.route === "hybrid" && s1.n[0] === `${T}-lex`, JSON.stringify([s1.route, s1.n]));
  const r1 = await recall("질의1 문장으로 찾기");
  chk("S1 소환은 문서 벡터 0.6 으로 · 절의 자리가 없다", r1.route === "vector" && r1.n.join() === `${T}-lex` && r1.rows[0].line === undefined, JSON.stringify(r1.rows));

  // ── S2 ──
  await fillAll();
  await chunkVec(`${T}-tail`, 2, basis(2));
  fresh();
  chk("S2 조각을 쓴다", !!(await cs.chunkIndex()));
  const s2 = await search("질의2 끝 절을 묻는 문장");
  chk("S2 끝 절만 가까운 문서를 찾는다", s2.route === "hybrid-chunk" && s2.n[0] === `${T}-tail`, JSON.stringify([s2.route, s2.n]));

  // ── S3 ──
  const rowOf = (r, n) => r.rows.find((x) => x.name === n);
  chk("S3 뜻으로 맞으면 맞은 절", rowOf(s2, `${T}-tail`)?.snippet === "L8: «머리 절 › 끝 절» 끝에 덧붙인 결정", rowOf(s2, `${T}-tail`)?.snippet);
  const s3 = await search("희귀낱말가나 질의2 찾기");
  chk("S3 낱말 순위가 더 높으면 맞은 줄", rowOf(s3, `${T}-lex`)?.snippet?.startsWith("L3: 희귀낱말가나"), rowOf(s3, `${T}-lex`)?.snippet);
  const s3b = await search("끝에 덧붙인 질의2 결정", { context: 1 });
  chk("S3 context 를 달라면 맞은 줄", /^L7: /m.test(rowOf(s3b, `${T}-tail`)?.snippet ?? "") && !rowOf(s3b, `${T}-tail`)?.snippet.includes("«"), rowOf(s3b, `${T}-tail`)?.snippet);
  const s3c = await search("질의2 끝 절을 묻는 문장", { mode: "names" });
  chk("S3 names 는 스니펫 없음", s3c.route === "hybrid-chunk" && s3c.n[0] === `${T}-tail` && rowOf(s3c, `${T}-tail`).snippet === undefined, JSON.stringify(s3c.rows[0]));

  // ── S4 ──
  await save(`${T}-id`, "식별자 문서", "src/v6/recall_router_case.ts 를 고쳤다");
  await sweep(); await fillAll(); await fillDocs(); fresh();
  await cs.chunkIndex();
  seen.length = 0;
  const s4 = await search("recall_router_case.ts 어디서 고쳤지");
  chk("S4 식별자 질의는 낱말 채널만", s4.route === "lexical" && s4.n[0] === `${T}-id` && seen.length === 0, JSON.stringify([s4.route, s4.n, seen]));

  // ── S5 ──
  await save(`${T}-hid`, "숨은 문서", "# 비밀 절\n숨겨 둔 내용");
  await sweep(); await fillAll(); await fillDocs();
  await q(`UPDATE knowledge SET visibility='members' WHERE name=$1`, [`${T}-hid`]);
  await chunkVec(`${T}-hid`, 0, basis(3));
  await chunkVec(`${T}-tail`, 0, near(3, 0.7));
  fresh();
  const stranger = "pgt-stranger";
  const s5 = await search("질의3 문장으로 찾기", {}, stranger);
  chk("S5 찾기 — 숨은 문서가 안 나온다", !s5.n.includes(`${T}-hid`) && s5.n[0] === `${T}-tail`, JSON.stringify(s5.n));
  chk("S5 찾기 — 스니펫에 숨은 글이 없다", !JSON.stringify(s5.rows).includes("숨겨 둔 내용"));
  const r5 = await recall("질의3 문장으로 찾기", null, stranger);
  chk("S5 소환 — 숨은 문서가 안 나온다", r5.route === "chunk" && r5.n.join() === `${T}-tail`, JSON.stringify(r5.n));
  chk("S5 특권 신원에게는 나온다(양성 대조)", (await search("질의3 문장으로 찾기", {}, null)).n[0] === `${T}-hid` && (await recall("질의3 문장으로 찾기", null, null)).n[0] === `${T}-hid`);

  // ── S6 ──
  await save(`${T}-arch`, "보관 문서", "# 절\n보관된 글");
  await save(`${T}-off`, "제외 문서", "# 절\n제외된 글");
  await sweep(); await fillAll(); await fillDocs();
  await chunkVec(`${T}-arch`, 0, basis(4));
  await chunkVec(`${T}-off`, 0, basis(4));
  await chunkVec(`${T}-tail`, 1, near(4, 0.7));
  await q(`UPDATE knowledge SET lifecycle='archived' WHERE name=$1`, [`${T}-arch`]);
  await q(`UPDATE knowledge SET searchable=false WHERE name=$1`, [`${T}-off`]);
  fresh();
  const s6 = await search("질의4 문장으로 찾기");
  chk("S6 찾기 — 표를 맞추기 전의 조각이 안 나온다", !s6.n.includes(`${T}-arch`) && !s6.n.includes(`${T}-off`) && s6.n[0] === `${T}-tail`, JSON.stringify(s6.n));
  const r6 = await recall("질의4 문장으로 찾기");
  chk("S6 소환 — 표를 맞추기 전의 조각이 안 나온다", r6.n.join() === `${T}-tail`, JSON.stringify(r6.n));
  await q(`UPDATE knowledge SET lifecycle='active' WHERE name=$1`, [`${T}-arch`]);
  await q(`UPDATE knowledge SET searchable=true WHERE name=$1`, [`${T}-off`]);

  // ── S7 ──
  const catId = Number((await q(`INSERT INTO category(key, name) VALUES('zsin','zsin') RETURNING id`))[0].id);
  await save(`${T}-out`, "제한 밖", "# 절\n밖의 글");
  await save(`${T}-in`, "제한 안", "# 절\n안의 글", { category: "zsin" });
  await save(`${T}-always`, "주입 문서", "# 절\n늘 넣는 글", { injection: "always" });
  await sweep(); await fillAll(); await fillDocs();
  await chunkVec(`${T}-in`, 0, near(5, 0.8));
  await chunkVec(`${T}-always`, 0, near(5, 0.8));
  for (let i = 0; i < 260; i++) await q(`INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash, embedding_vector, embedding_model, embedding_updated_at) VALUES($1,$2,1,'밖',$3,$4::vector,'bge-m3',now())`, [`${T}-out`, 100 + i, `o${i}`, lit(near(5, 0.95))]);
  fresh();
  const plain = await search("질의5 문장으로 찾기");
  chk("S7 전제 — 제한이 없으면 후보를 밖의 조각이 채운다", plain.n[0] === `${T}-out` && !plain.n.includes(`${T}-in`), JSON.stringify(plain.n));
  const s7 = await search("질의5 문장으로 찾기", { categories: [catId] });
  chk("S7 카테고리 — 제한 안 문서가 나온다", s7.route === "hybrid-chunk" && s7.n.join() === `${T}-in`, JSON.stringify([s7.route, s7.n]));
  const s7b = await search("질의5 문장으로 찾기", { injection: "always" });
  chk("S7 주입 — 제한 안 문서가 나온다", s7b.n.join() === `${T}-always`, JSON.stringify(s7b.n));
  const s7c = await search("질의5 문장으로 찾기", { provenance: "observed" });
  chk("S7 출처 — 맞는 문서가 없으면 없다", s7c.n.length === 0, JSON.stringify(s7c.n));
  await q(`DELETE FROM knowledge_chunk WHERE name=$1 AND seq>=100`, [`${T}-out`]);

  // ── S8 ──
  const COS = { r1: 0.95, r2: 0.8, r3: 0.7, r4: 0.68, r5: 0.67, r6: 0.65 };
  for (const k of Object.keys(COS)) await save(`${T}-${k}`, `소환 ${k}`, `# 앞 절\n앞 글 ${k}\n\n# 뒤 절\n뒤 글 ${k}`);
  await sweep(); await fillAll(); await fillDocs();
  for (const [k, c] of Object.entries(COS)) await chunkVec(`${T}-${k}`, 1, near(6, c));
  await chunkVec(`${T}-r1`, 0, near(6, 0.9));
  fresh();
  const r8 = await recall("질의6 소환 문장을 충분히 길게 적어 둔다");
  chk("S8 코사인 순서 · 상위 4건", r8.n.join() === [`${T}-r1`, `${T}-r2`, `${T}-r3`, `${T}-r4`].join(), JSON.stringify(r8.n));
  chk("S8 문서마다 한 번 · 가장 가까운 조각의 자리", r8.rows[0].line === 5 && r8.rows[0].section === "뒤 절" && r8.rows[0].snippet === "뒤 글 r1", JSON.stringify(r8.rows[0]));
  chk("S8 similarity 는 코사인", Math.abs(r8.rows[1].similarity - 0.8) < 0.01, String(r8.rows[1].similarity));
  await chunkVec(`${T}-r1`, 0, FAR); await chunkVec(`${T}-r1`, 1, FAR); await chunkVec(`${T}-r2`, 1, FAR); await chunkVec(`${T}-r3`, 1, FAR); await chunkVec(`${T}-r4`, 1, FAR);
  const r8b = await recall("질의6 소환 문장을 충분히 길게 적어 둔다");
  chk("S8 기준선 0.66 — 0.67 은 들고 0.65 는 안 든다", r8b.n.join() === `${T}-r5`, JSON.stringify(r8b.rows.map((x) => [x.name, x.similarity])));

  // ── S9 ──
  const askedBy = async (text, prev) => { __resetQueryEmbedCache(); seen.length = 0; await recall(text, prev); return seen[0]; };
  chk("S9 짧은 프롬프트에 앞 턴을 앞에 붙인다", (await askedBy("질의6 응 그걸로", "앞 턴 말")) === "앞 턴 말\n질의6 응 그걸로");
  chk("S9 앞 턴이 없으면 프롬프트만", (await askedBy("질의6 응 그걸로", null)) === "질의6 응 그걸로");
  const t99 = "질".repeat(99), t100 = "질".repeat(100);
  chk("S9 경계 — 99자는 붙이고 100자는 안 붙인다", (await askedBy(t99, "앞")) === `앞\n${t99}` && (await askedBy(t100, "앞")) === t100);
  chk("S9 앞 턴은 앞 300자", (await askedBy("질의6", "가".repeat(500))) === `${"가".repeat(300)}\n질의6`);
  chk("S9 앞 1,000자", (await askedBy("가".repeat(3000), null)).length === 1000);

  // ── S10 ──
  const capOf = (n) => embeddingsCapabilities.find((x) => x.name === n);
  const admin = { userId: "x", scopes: ["admin"] };
  await docVec(`${T}-r6`, near(7, 0.62));
  await docVec(`${T}-r4`, near(7, 0.55));   // 문서 벡터 기준선 0.6 아래
  await chunkVec(`${T}-r5`, 1, FAR);
  await chunkVec(`${T}-tail`, 2, near(7, 0.8));
  fresh();
  chk("S10 켜져 있으면 조각", (await recall("질의7 소환 문장을 충분히 길게 적어 둔다")).n.join() === `${T}-tail`);
  const off = await capOf("org_embeddings_chunk_search").handler({ enabled: false }, admin, { source: "web" });
  chk("S10 끄면 곧바로 안 쓴다", off.enabled === false && off.active === false, JSON.stringify(off));
  __resetQueryEmbedCache();
  chk("S10 값이 DB 에 남는다", (await getRuntimeConfig()).knowledge_chunk_search === false);
  const s10 = await search("질의7 소환 문장을 충분히 길게 적어 둔다");
  chk("S10 끄면 찾기가 문서 벡터로", s10.route === "hybrid" && s10.n[0] === `${T}-r6`, JSON.stringify([s10.route, s10.n]));
  const r10 = await recall("질의7 소환 문장을 충분히 길게 적어 둔다");
  chk("S10 끄면 소환이 문서 벡터 0.6 으로", r10.route === "vector" && r10.n.join() === `${T}-r6`, JSON.stringify([r10.route, r10.n]));
  const st10 = await capOf("org_embeddings_status").handler({}, admin, { source: "web" });
  chk("S10 상태가 말한다(꺼짐)", st10.chunk_search.enabled === false && st10.chunk_search.active === false && Number(st10.chunk_backlog.total) > 0, JSON.stringify(st10.chunk_search));
  const on = await capOf("org_embeddings_chunk_search").handler({ enabled: true }, admin, { source: "web" });
  chk("S10 켜면 돌아온다", on.active === true, JSON.stringify(on));
  const st10b = await capOf("org_embeddings_status").handler({}, admin, { source: "web" });
  chk("S10 상태가 말한다(켜짐)", st10b.chunk_search.active === true && st10b.chunk_search.vector_type === "halfvec", JSON.stringify(st10b.chunk_search));
  let bad400 = false;
  await capOf("org_embeddings_chunk_search").handler({ enabled: "no" }, admin, { source: "web" }).catch(() => { bad400 = true; });
  chk("S10 boolean 이 아니면 거절", bad400);

  // ── S11 ──
  await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [cfg("new-model")]);
  fresh();
  chk("S11 모델이 바뀌면 조각을 안 쓴다(옛 벡터로 재지 않는다)", (await cs.chunkIndex()) === null);
  await q(`UPDATE knowledge_chunk SET embedding_model='new-model'`);
  fresh();
  chk("S11 다시 채우면 돌아온다", !!(await cs.chunkIndex()));
  chk("S11 찾기는 조각으로", (await search("질의7 소환 문장을 충분히 길게 적어 둔다")).route === "hybrid-chunk");
  chk("S11 기준선을 잰 모델이 아니면 소환은 문서 벡터로", (await recall("질의7 소환 문장을 충분히 길게 적어 둔다")).route === "vector");
  const st11 = await capOf("org_embeddings_status").handler({}, admin, { source: "web" });
  chk("S11 상태가 말한다", st11.chunk_search.active === true && st11.chunk_search.recall === false, JSON.stringify(st11.chunk_search));
  await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [cfg("bge-m3")]);
  await q(`UPDATE knowledge_chunk SET embedding_model='bge-m3'`);

  // ── S12 ──
  for (let i = 0; i < 300; i++) await q(`INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash) VALUES($1,$2,1,'밖',$3)`, [`${T}-out`, 1000 + i, `p${i}`]);
  const total = Number((await q(`SELECT count(*)::int AS n FROM knowledge_chunk`))[0].n);
  const holdAt = async (missing) => {
    await q(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model='bge-m3'`, [lit(FAR)]);
    await q(`UPDATE knowledge_chunk SET embedding_vector=NULL WHERE id IN (SELECT id FROM knowledge_chunk ORDER BY id LIMIT $1)`, [missing]);
    fresh();
    return !!(await cs.chunkIndex());
  };
  const okGap = Math.floor(total * 0.02);
  chk("S12 98% 면 쓴다", await holdAt(okGap), `${total}/${okGap}`);
  chk("S12 그보다 하나 적으면 안 쓴다", !(await holdAt(okGap + 1)), `${total}/${okGap}`);
  await q(`DELETE FROM knowledge_chunk WHERE name=$1 AND seq>=1000`, [`${T}-out`]);
  await holdAt(0);
  await chunkVec(`${T}-tail`, 2, basis(2));
  await chunkVec(`${T}-r2`, 1, near(8, 0.8));

  // ── S13 ──
  fresh();
  await cs.chunkIndex();
  await q(`ALTER TABLE knowledge_chunk RENAME TO knowledge_chunk_off`);
  const s13 = await search("질의8 문장으로 찾기");
  const r13 = await recall("질의8 소환 문장을 충분히 길게 적어 둔다");
  await q(`ALTER TABLE knowledge_chunk_off RENAME TO knowledge_chunk`);
  chk("S13 찾기는 문서 벡터로 답한다", s13.route === "hybrid", JSON.stringify([s13.route, s13.n]));
  chk("S13 소환은 문서 벡터로 답한다", r13.route === "vector" && r13.diag.degraded === undefined, JSON.stringify(r13.diag));

  // ── S14 ──
  await q(`DROP INDEX knowledge_chunk_embedding_hnsw`);
  await q(`ALTER TABLE knowledge_chunk ALTER COLUMN embedding_vector TYPE vector(${DIMS}) USING embedding_vector::vector`);
  await q(`CREATE INDEX knowledge_chunk_embedding_hnsw ON knowledge_chunk USING hnsw (embedding_vector vector_cosine_ops)`);
  fresh();
  const ix14 = await cs.chunkIndex();
  chk("S14 칸의 형을 읽는다", ix14?.cast === "vector", JSON.stringify(ix14));
  const s14 = await search("질의8 문장으로 찾기");
  chk("S14 찾기가 돈다", s14.route === "hybrid-chunk" && s14.n[0] === `${T}-r2`, JSON.stringify([s14.route, s14.n]));
  chk("S14 소환이 돈다", (await recall("질의8 소환 문장을 충분히 길게 적어 둔다")).n.join() === `${T}-r2`);
  await q(`DROP INDEX knowledge_chunk_embedding_hnsw`);
  await q(`ALTER TABLE knowledge_chunk ALTER COLUMN embedding_vector TYPE halfvec(${DIMS}) USING embedding_vector::halfvec`);
  await q(`CREATE INDEX knowledge_chunk_embedding_hnsw ON knowledge_chunk USING hnsw (embedding_vector halfvec_cosine_ops)`);

  // ── S15 ──
  fresh();
  const recallCap = recallCapabilities.find((x) => x.name === "knowledge_recall");
  const dana = { userId: "dana", scopes: ["memory"] };
  const before = Number((await q(`SELECT count(*)::int AS n FROM knowledge_search_log`))[0].n);
  const out = await recallCap.handler({ text: "질의8 비밀스러운 프롬프트 글을 길게 적어 둔다" }, dana, { source: "web", viewer: null, session: "box-s15" });
  await sleep(40);
  const logged = await q(`SELECT tool, route, q, names, n FROM knowledge_search_log ORDER BY id DESC LIMIT 1`);
  chk("S15 입구가 답한다 · 칸은 entries 다", out.entries.map((e) => e.name).join() === `${T}-r2` && out.entries[0].line === 5, JSON.stringify(out));
  chk("S15 세션 호출을 남긴다 · 글은 안 남긴다", logged[0]?.tool === "recall" && logged[0]?.route === "chunk" && logged[0]?.q === null && logged[0]?.names?.join() === `${T}-r2`, JSON.stringify(logged));
  await recallCap.handler({ text: "질의8 비밀스러운 프롬프트 글을 길게 적어 둔다" }, dana, { source: "web", viewer: null });
  await sleep(40);
  chk("S15 세션이 아니면 안 남긴다", Number((await q(`SELECT count(*)::int AS n FROM knowledge_search_log`))[0].n) === before + 1);
  await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [JSON.stringify({ provider: "off", explicit: true })]);
  fresh();
  const offOut = await recallCap.handler({ text: "질의8 소환 문장을 충분히 길게 적어 둔다" }, dana, { source: "web", viewer: null });
  chk("S15 임베딩이 꺼지면 그렇다고 말한다", offOut.entries.length === 0 && offOut.embeddings === "off", JSON.stringify(offOut));
  await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [cfg("bge-m3")]);

  // ── S16 ──
  await save(`${T}-keep`, "검색 제외 글자", "화면찾기낱말 이 든 글");
  await sweep(); await fillAll(); await fillDocs();
  await q(`UPDATE knowledge SET searchable=false WHERE name=$1`, [`${T}-keep`]);
  fresh();
  const s16 = await search("화면찾기낱말", { includeUnsearchable: true, plain: true });
  chk("S16 사람 화면은 검색 제외를 글자로 찾는다", s16.n.includes(`${T}-keep`) && s16.rows.find((r) => r.name === `${T}-keep`)?.searchable === false, JSON.stringify(s16.rows.map((r) => [r.name, r.searchable])));

  // ── S17 ──
  await search("질의8 문장으로 찾기");
  chk("S17 탐색 폭이 트랜잭션 밖으로 새지 않는다", (await q(`SHOW hnsw.ef_search`))[0]["hnsw.ef_search"] === "40");
  chk("S17 반복 탐색도 새지 않는다", (await q(`SHOW hnsw.iterative_scan`))[0]["hnsw.iterative_scan"] === "off");

  // ── S18 ──
  const eb = await import(`${D}/v6/embedding-backfill.js`);
  const filled = async (name) => Number((await q(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE name=$1 AND embedding_vector IS NOT NULL`, [name]))[0].n);
  const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return true; await sleep(30); } return false; };
  await q(`INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash) VALUES($1, 5000, 1, '밀린 글', 'backlog')`, [`${T}-out`]);
  await save(`${T}-paused`, "일시중지", "# 절\n글");
  await settled(); await sleep(150);
  chk("S18 일시중지면 안 채운다", (await filled(`${T}-paused`)) === 0);
  await q(`UPDATE org_runtime_config SET embedding_backfill_paused=false WHERE id=1`);
  await save(`${T}-fresh`, "새 문서", "# 첫 절\n질의9 새로 쓴 글\n\n# 둘째 절\n다른 글");
  chk("S18 저장 직후 그 문서의 조각이 찬다", await until(async () => (await filled(`${T}-fresh`)) === 2), String(await filled(`${T}-fresh`)));
  chk("S18 밀린 일은 안 건드린다", Number((await q(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE text_hash='backlog' AND embedding_vector IS NULL`))[0].n) === 1);
  await fillAll();
  fresh();
  chk("S18 뜻으로 찾힌다", (await search("어떤 뜻 질의9 문장")).n[0] === `${T}-fresh` && (await recall("어떤 뜻 질의9 문장을 충분히 길게 적어 둔다")).n[0] === `${T}-fresh`);
  const many = Array.from({ length: 50 }, (_, i) => `# 절${i}\n글${i}`).join("\n");
  await save(`${T}-many`, "큰 문서", many);
  chk("S18 문서당 상한 · 뒤 조각부터", await until(async () => (await filled(`${T}-many`)) === 40) && Number((await q(`SELECT min(seq)::int AS m FROM knowledge_chunk WHERE name=$1 AND embedding_vector IS NOT NULL`, [`${T}-many`]))[0].m) === 10, String(await filled(`${T}-many`)));
  await q(`INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash, embedding_model, embedding_updated_at) SELECT $1, 10000 + g, 1, 'x', 'b'||g, 'bge-m3', now() FROM generate_series(1, $2::int) g`, [`${T}-out`, eb.CHUNK_EMBED_DAILY_MAX]);
  await save(`${T}-budget`, "하루 상한", "# 절\n글");
  await settled(); await sleep(150);
  chk("S18 하루 상한이면 안 채운다", (await filled(`${T}-budget`)) === 0);
  await q(`DELETE FROM knowledge_chunk WHERE name=$1 AND seq >= 5000`, [`${T}-out`]);
  await q(`UPDATE org_runtime_config SET embedding_backfill_paused=true WHERE id=1`);
  await fillAll(); await fillDocs();

  // ── S19 ──
  await chunkVec(`${T}-r3`, 1, basis(10));
  await docVec(`${T}-r3`, FAR);
  fresh();
  const s19 = await ks.knowledgeSearchStrength("질의10 다른 말로 묻는 문장", [`${T}-r3`]);
  chk("S19 조각으로 잰다", Number(s19.topSim) > 0.99, JSON.stringify(s19));
  await capOf("org_embeddings_chunk_search").handler({ enabled: false }, admin, { source: "web" });
  const s19b = await ks.knowledgeSearchStrength("질의10 다른 말로 묻는 문장", [`${T}-r3`]);
  chk("S19 조각을 안 쓰면 문서 벡터로 잰다", Number(s19b.topSim) < 0.1, JSON.stringify(s19b));
  await capOf("org_embeddings_chunk_search").handler({ enabled: true }, admin, { source: "web" });

  // ── S20 ──
  await q(`DELETE FROM knowledge_lex_doc`);
  await ls.__resetLexReady();
  fresh();
  chk("S20 낱말 색인이 없으면 hybrid-chunk-grep", (await search("질의10 다른 말로 묻는 문장")).route === "hybrid-chunk-grep");
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
