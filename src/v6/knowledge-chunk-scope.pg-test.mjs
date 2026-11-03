// 조각 검색을 켤지 — 찾기가 볼 범위의 조각으로 잰다 · PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/knowledge-chunk-scope.pg-test.mjs
//
// 왜 이 계층인가: 약속이 «어느 조각을 세느냐» 다 — 카테고리 연결 · 생애 · 검색 제외 · 벡터의 모델이 한 판정에 묶여 있고, 그 판정을 찾기 · 소환 · 약함 판정이
//  따른다. 벡터는 가짜 임베딩 서버가 정한다(글 안의 «범위축<n>» 이 축). 사양만 보고 썼다(구현 블라인드) — 기대값은 사양 문장에서 왔다.
//
//  사양 · 엣지 표(괄호 = 사양 절):
//   C1  범위 판정(1·2) — A(조각이 다 참)만 → 쓴다 · B(빈 조각 많음)만 → 안 쓴다 · A∪B → 합친 조각이 98% 미만이라 안 쓴다 ·
//        제한 없음(인자 없음 · categories:null) → 전체로 재서 안 쓴다 · A∪B 는 합친 조각으로 잰다(B 만으로는 미만이어도 합쳐서 98% 이상이면 쓴다)
//   C2  찾기(2) — A 로 좁히면 조각(끝 절만 가까운 A 문서가 1위 · 그 문서 벡터는 멀다) · B · A∪B · 제한 없음은 문서 벡터
//   C3  앱 읽기 범위(1·2) — 소환: 범위 A → 조각 · 범위 B → 문서 벡터 · 범위 없음 → 전체 기준 · 뷰어가 구성원 문자열이 아니면 범위가 안 걸린다
//        찾기: 범위 A 에서 category 인자 없이 → A 기준 · 범위 A ∩ 인자 [A,B] = A · 범위 [A,B] ∩ 인자 [A] = A · 범위 [A,B] 인자 없음 → A∪B 기준 ·
//        뷰어가 구성원 문자열이 아니면 범위가 안 걸려 전체 기준
//   C4  범위에 «든» 지식만 센다(1) — 보관 · 검색 제외 · 거절 연결 지식의 조각은 빈 쪽으로도(판정을 내리지 않음) 찬 쪽으로도(모자란 범위를 채우지 않음)
//        세지 않는다 · 제안(proposed) 연결은 «거절이 아닌 연결» 이라 센다
//   C5  빈 범위(1) — 지식 없는 카테고리 · 보관 지식만 든 카테고리 · 빈 목록 · 교집합이 빈 목록 · 앱 범위가 빈 목록 → 조각을 안 쓴다 ·
//        빈 목록은 제한 없음이 아니다(전체가 98% 이상이어도 안 쓴다 — C6 장면에서 본다)
//   C6  98% 경계(1) — 범위 안 정확히 98/100 → 쓴다(그때 전체는 98% 미만) · 97/100 → 안 쓴다(그때 전체는 98% 이상) · 찾기 · 소환도 같은 판정을 따른다
//   C7  판정 기억(3) — 범위를 번갈아 물어도 각자 맞다(어느 범위를 먼저 물어도) · 순서 · 중복만 다른 목록은 같은 판정이고 같은 기억을 쓴다 ·
//        30초 안에는 기억한 판정 · 30초가 지나면 다시 잰다 · 한 범위의 기억이 다른 범위 · 제한 없음에 섞이지 않는다 · resetChunkIndex 는 모든 기억을 비운다 ·
//        기억 칸이 1,000개를 넘으면 비운다(그 뒤에는 30초 안이어도 다시 잰다)
//   C8  되돌리기 스위치(5) — 끄면 범위가 다 차 있어도 곧바로 조각을 안 쓴다(찾기 · 앱 범위 소환 · 판정) · 켜면 돌아온다
//   C9  옛 모델 벡터(배경 · 5) — 범위 안에서도 «없음» · 모델이 바뀌면 범위 안 조각을 새 모델로 채운 범위만 쓴다
//   C10 diag.chunkIndex(4) — 조각으로 찾으면 색인 객체(truthy) · 문서 벡터로 돌면 null · 벡터 채널이 안 돌면(식별자 질의) 칸이 없다(undefined)
//   C11 약함 판정(4) — chunkIndex 에 색인 → 전체 판정과 상관없이 조각으로 · chunkIndex:null → 문서 벡터로(전체가 조각을 써도) · 안 줌 → 전체 판정을 따른다 ·
//        knowledge_search 의 «가져올 곳» 길(collectHintFor)도 넘긴 값을 그대로 잇는다
//   C12 상태 도구(5) — chunk_search.active 는 전체 기준(범위 판정을 기억해 둔 뒤에도 · 앱 범위 안에서 물어도)
//   (다루지 않음: «워크스페이스마다» 따로 기억 — 이 틀은 워크스페이스 하나다)
//
//  DB 를 다른 시험과 나눠 쓰는 자리(예: 로컬 PGlite 접속 서버 — CREATE DATABASE 로 나뉘지 않는다)에서도 덜 흔들리게:
//   축을 고르는 낱말(«범위축<n>»)과 축 번호(637)는 다른 시험의 문서와 겹치지 않게 골랐고, 시작할 때 이 시험의 이름만 지운다.
//   그래도 «전체» 를 재는 항목은 남의 조각이 같이 세어진다. 그리고 제한 없는 조각 찾기 · 소환의 (양성 대조)는 근사 색인(HNSW)을 타서,
//   남의 조각이 많거나 같은 DB 에 이 시험을 여러 번 돌려 색인에 지난 실행의 잔재가 쌓이면 외딴 조각 하나를 놓칠 수 있다 —
//   다시 돌릴 때는 새 DB 를 쓴다(판정은 빈 DB · CI 의 새 DB 를 기준으로 한다).
import pg from "pg";
import http from "node:http";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_chunkscope";
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
const rs = await import(`${D}/v6/read-scope.js`);
const { __resetQueryEmbedCache } = await import(`${D}/v6/search-util.js`);
const { embeddingsCapabilities } = await import(`${D}/capabilities/delivery/embeddings.js`);
const { collectHintFor } = await import(`${D}/org/collect/unit-find.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const names = (rows) => rows.map((r) => r.name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => { try { return JSON.stringify(x); } catch { return String(x); } };

// ── 가짜 임베딩 서버 — 글 안의 «범위축<n>» 이 축을 정한다(기존 시험의 «질의<n>» 과 같은 방식 · 낱말만 다르다). 받은 글을 남긴다. ──
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
    res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: basis(Number(/범위축(\d+)/.exec(t)?.[1] ?? 800)) })) }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const MODEL = "bge-m3";
await q(`INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING`);
const cfg = (model) => JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${PORT}`, model, dimensions: DIMS, send_dimensions: false, request_timeout_ms: 5000, batch_size: 8 });
await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb, embedding_backfill_paused=true WHERE id=1`, [cfg(MODEL)]);

const ctx = { actor: "pgt-cs", source: "web" };
const settled = async () => { await sleep(40); for (let i = 0; i < 100; i++) { const n = Number((await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle'`))[0].n); if (!n) break; await sleep(10); } };
const sweep = async () => { await settled(); for (;;) { const r = await ls.sweepKnowledgeLex(); if (!r.indexed && !r.removed) break; } };
const catOf = async (key) => {
  const got = await q(`SELECT id FROM category WHERE key=$1 LIMIT 1`, [key]);
  if (got.length) return Number(got[0].id);
  return Number((await q(`INSERT INTO category(key, name) VALUES($1,$1) RETURNING id`, [key]))[0].id);
};
const save = (name, title, body, category) => kst.upsertKnowledge({ name, title, body_md: body, type: "reference", category }, ctx);

//  조각 · 문서 벡터 손질. 조각 «벡터 없음» 은 벡터 · 모델 칸을 같이 비운다.
const addChunks = (name, n, from = 100) => q(
  `INSERT INTO knowledge_chunk(name, seq, start_line, body, text_hash)
   SELECT $1::text, $2::int + g, 1, '덧붙인 조각', 'pgt-' || $1::text || '-' || ($2::int + g)::text FROM generate_series(0, $3::int - 1) g`, [name, from, n]);
const vecChunks = (list, v = FAR) => q(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model=$2, embedding_updated_at=now() WHERE name = ANY($3::text[])`, [lit(v), MODEL, list]);
const dropChunks = (list) => q(`UPDATE knowledge_chunk SET embedding_vector=NULL, embedding_model=NULL, embedding_updated_at=NULL WHERE name = ANY($1::text[])`, [list]);
const emptyFirst = (name, k) => q(`UPDATE knowledge_chunk SET embedding_vector=NULL, embedding_model=NULL, embedding_updated_at=NULL WHERE id IN (SELECT id FROM knowledge_chunk WHERE name=$1 ORDER BY id LIMIT $2)`, [name, k]);
const chunkVec = (name, seq, v) => q(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model=$2, embedding_updated_at=now() WHERE name=$3 AND seq=$4`, [lit(v), MODEL, name, seq]);
const docVec = (name, v) => q(`UPDATE knowledge SET embedding_vector=$1::vector, embedding_model=$2, embedding_updated_at=now() WHERE name=$3`, [lit(v), MODEL, name]);
const fillDocs = () => q(`UPDATE knowledge SET embedding_vector=$1::vector, embedding_model=$2, embedding_updated_at=now() WHERE embedding_vector IS NULL`, [lit(FAR), MODEL]);
const nChunks = async (name) => Number((await q(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE name=$1`, [name]))[0].n);

//  사양 1절의 정의 그대로 센 비율 — 시험 장면이 의도대로 섰나(전제)를 확인하는 데만 쓴다. cats=null 이면 워크스페이스의 조각 전부.
const ratio = async (cats, model = MODEL) => {
  const params = [model];
  let from = "knowledge_chunk c", where = "TRUE";
  if (cats) {
    params.push(cats);
    from = "knowledge_chunk c JOIN knowledge k ON k.name = c.name";
    where = `k.lifecycle='active' AND k.searchable AND EXISTS(SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name AND kc.state<>'rejected' AND kc.category_id = ANY($2::int[]))`;
  }
  const r = (await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE c.embedding_vector IS NOT NULL AND c.embedding_model=$1)::int AS have FROM ${from} WHERE ${where}`, params))[0];
  return { total: r.total, have: r.have, ok: r.total > 0 && r.have >= r.total * 0.98 };
};

const fresh = () => { cs.resetChunkIndex(); __resetQueryEmbedCache(); };
const search = async (query, opts = {}, viewer) => { const d = {}; const rows = await ks.hybridSearchKnowledge(query, { limit: 20, ...opts }, viewer, d); return { rows, route: d.route, n: names(rows), d }; };
const recall = async (text, prev, viewer) => { const d = {}; const rows = await cs.recallKnowledge({ text, prev }, viewer, d); return { rows, route: d.route, n: names(rows), d }; };
//  앱 읽기 범위 — 뷰어가 구성원 문자열일 때만 걸린다(read-scope.ts).
const inScope = (ids, fn) => rs.withReadScope(async () => ({ appId: "pgt-app", knowledgeCategoryIds: ids, sourceKinds: [] }), fn);
const MEMBER = "pgt-member";
//  낱말 색인이 덜 찬 배포는 -grep 꼴로 기록한다(사양 배경) — 어느 벡터를 썼나만 가른다.
const isChunk = (r) => r === "hybrid-chunk" || r === "hybrid-chunk-grep";
const isDoc = (r) => r === "hybrid" || r === "hybrid-grep";
const chOf = (d) => (d.chunkIndex === undefined ? "칸 없음" : d.chunkIndex === null ? "null" : typeof d.chunkIndex);
//  topSim — 재지 않았으면(null · undefined) NaN 이라 어느 부등식도 참이 안 된다.
const sim = (g) => (g?.topSim === null || g?.topSim === undefined ? NaN : Number(g.topSim));
const capOf = (n) => embeddingsCapabilities.find((x) => x.name === n);
const admin = { userId: "x", scopes: ["admin"] };
const setSwitch = (enabled) => capOf("org_embeddings_chunk_search").handler({ enabled }, admin, { source: "web" });
const status = (c = { source: "web" }) => capOf("org_embeddings_status").handler({}, admin, c);

//  뜻 질의 — 축 AX. 낱말(범위축 · 637 · 엉뚱한 · 표현 · 여쭙 · 문의)은 어느 문서의 이름 · 제목 · 본문에도 없다(낱말이 맞으면 약함 판정이 topSim 을 안 잰다).
const AX = 637;
const QV = `범위축${AX} 엉뚱한 표현으로 여쭙는 문의`;
const RV = `범위축${AX} 엉뚱한 표현으로 여쭙는 문의를 길게 적어 둔다`;
const QID = "scope_probe_case.ts 어디서 고쳤지";

const T = "cs";
const H_BULK = `${T}-h-bulk`;
const A_TAIL = `${T}-a-tail`, A_DECOY = `${T}-a-decoy`, A_ID = `${T}-a-id`;
const X_ARCH = `${T}-x-arch`, X_OFF = `${T}-x-off`, X_REJ = `${T}-x-rej`, X_PROP = `${T}-x-prop`;
const B_NEAR = `${T}-b-near`, B_BULK = `${T}-b-bulk`;
const C_MAIN = `${T}-c-main`;
const F_ARCH = `${T}-f-arch`;
const ALL = [H_BULK, A_TAIL, A_DECOY, A_ID, X_ARCH, X_OFF, X_REJ, X_PROP, B_NEAR, B_BULK, C_MAIN, F_ARCH];
const B_DOCS = [B_NEAR, B_BULK];
//  시험마다 조각 수를 바꾸는 문서 — mainState 가 손으로 넣은 조각(seq>=100)을 정해진 수로 되돌린다.
const MUTABLE = [A_ID, X_ARCH, X_OFF, X_REJ, X_PROP, F_ARCH, C_MAIN];

let HOME, A, B, C, E, F, natural = {}, tailSeq = 0;

//  기본 장면 — A 의 조각은 모두 지금 모델 벡터 · B 는 모두 비었다(그래서 전체는 98% 미만) · C 는 100 조각이 다 찼다 ·
//   A 꼬리 문서의 끝 절만 질의 축(문서 벡터는 멀다) · A 미끼 문서는 문서 벡터만 질의에 0.75 · B 가까움 문서는 문서 벡터만 0.65.
const mainState = async () => {
  await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [cfg(MODEL)]);
  await setSwitch(true);
  await q(`DELETE FROM knowledge_chunk WHERE seq >= 100 AND name = ANY($1::text[])`, [MUTABLE]);
  for (const x of [X_ARCH, X_OFF, X_REJ, X_PROP]) await addChunks(x, 5);
  await addChunks(C_MAIN, 100 - natural[C_MAIN]);
  await q(`UPDATE knowledge_chunk SET embedding_vector=$1::vector, embedding_model=$2, embedding_updated_at=now()
            WHERE (embedding_vector IS NULL OR embedding_model IS DISTINCT FROM $2) AND NOT (name = ANY($3::text[]))`, [lit(FAR), MODEL, B_DOCS]);
  await dropChunks(B_DOCS);
  await chunkVec(A_TAIL, tailSeq, basis(AX));
  fresh();
};
const section = async (name, fn) => {
  try { await mainState(); await fn(); }
  catch (e) { fail++; console.error(`FAIL ${name} 예외 —`, e?.stack ?? e); }
};

try {
  // ── 차리기 ──
  HOME = await catOf("cshome"); A = await catOf("csa"); B = await catOf("csb"); C = await catOf("csc"); E = await catOf("cse"); F = await catOf("csf");
  //  나눠 쓰는 DB 에서 다시 돌릴 때 — 이 시험의 이름만 지운다(새 DB 에선 할 일이 없다). 낱말 색인 행도 같이 지운다 —
  //   knowledge_lex_doc 만 남으면 저장 길이 «글이 그대로» 라고 보고 조각을 다시 안 만든다(knowledge-lex-store 머리말).
  await q(`DELETE FROM knowledge_lex_posting WHERE doc_id IN (SELECT id FROM knowledge_lex_doc WHERE name = ANY($1::text[]))`, [ALL]);
  await q(`DELETE FROM knowledge_lex_doc WHERE name = ANY($1::text[])`, [ALL]);
  await q(`DELETE FROM knowledge_chunk WHERE name = ANY($1::text[])`, [ALL]);
  await q(`DELETE FROM knowledge WHERE name = ANY($1::text[])`, [ALL]);
  await save(H_BULK, "묶음", "# 절\n묶음 글", "cshome");
  await save(A_TAIL, "꼬리", "# 머리 절\n머리 글\n\n## 둘째 절\n둘째 글\n\n## 끝 절\n끝에 덧붙인 결정", "csa");
  await save(A_DECOY, "미끼", "# 절\n미끼 글", "csa");
  await save(A_ID, "식별자", "src/v6/scope_probe_case.ts 를 고쳤다", "csa");
  await save(X_ARCH, "보관", "# 절\n보관 글", "csa");
  await save(X_OFF, "제외", "# 절\n제외 글", "csa");
  await save(X_REJ, "거절", "# 절\n거절 글", "csa");
  await save(X_PROP, "제안", "# 절\n제안 글", "csa");
  await save(B_NEAR, "비 가까움", "# 절\n비 글", "csb");
  await save(B_BULK, "비 묶음", "# 절\n비 묶음 글", "csb");
  await save(C_MAIN, "경계", "# 절\n경계 글", "csc");
  await save(F_ARCH, "보관만", "# 절\n보관만 글", "csf");
  await sweep();
  for (const n of ALL) natural[n] = await nChunks(n);
  tailSeq = Number((await q(`SELECT max(seq)::int AS s FROM knowledge_chunk WHERE name=$1`, [A_TAIL]))[0].s);
  chk("전제 — 저장한 문서마다 조각이 있고 꼬리 문서는 절이 여럿", ALL.every((n) => natural[n] >= 1) && natural[A_TAIL] >= 2 && natural[C_MAIN] < 100, J(natural));
  //  스윕은 여기서 끝 — 뒤에 스윕을 돌리면 보관 · 검색 제외 문서의 조각을 표에서 뺀다(그 조각이 시험 재료다).
  await addChunks(H_BULK, 300);
  await addChunks(B_BULK, 60);
  await q(`UPDATE knowledge SET lifecycle='archived' WHERE name = ANY($1::text[])`, [[X_ARCH, F_ARCH]]);
  await q(`UPDATE knowledge SET searchable=false WHERE name=$1`, [X_OFF]);
  await q(`UPDATE knowledge_category SET state='rejected' WHERE name=$1`, [X_REJ]);
  await q(`UPDATE knowledge_category SET state='proposed' WHERE name=$1`, [X_PROP]);
  await fillDocs();
  await docVec(A_DECOY, near(AX, 0.75));
  await docVec(B_NEAR, near(AX, 0.65));
  const want = {
    [H_BULK]: [HOME, "confirmed", "active", true], [A_TAIL]: [A, "confirmed", "active", true], [A_DECOY]: [A, "confirmed", "active", true],
    [A_ID]: [A, "confirmed", "active", true], [X_ARCH]: [A, "confirmed", "archived", true], [X_OFF]: [A, "confirmed", "active", false],
    [X_REJ]: [A, "rejected", "active", true], [X_PROP]: [A, "proposed", "active", true], [B_NEAR]: [B, "confirmed", "active", true],
    [B_BULK]: [B, "confirmed", "active", true], [C_MAIN]: [C, "confirmed", "active", true], [F_ARCH]: [F, "confirmed", "archived", true],
  };
  const states = await q(`SELECT k.name, k.lifecycle, k.searchable, kc.category_id, kc.state FROM knowledge k LEFT JOIN knowledge_category kc ON kc.name=k.name WHERE k.name = ANY($1::text[])`, [ALL]);
  chk("전제 — 카테고리 · 연결 상태 · 생애 · 검색 제외가 뜻한 대로", states.length === ALL.length && states.every((r) => { const w = want[r.name]; return Number(r.category_id) === w[0] && r.state === w[1] && r.lifecycle === w[2] && r.searchable === w[3]; }), J(states));

  // ── C1 범위 판정 ──
  await section("C1", async () => {
    const rA = await ratio([A]), rB = await ratio([B]), rAB = await ratio([A, B]), rAll = await ratio(null);
    chk("C1 전제 — A 는 다 찼고 B · A∪B · 전체는 98% 미만", rA.total > 0 && rA.have === rA.total && rB.total > 0 && !rB.ok && !rAB.ok && !rAll.ok, J({ rA, rB, rAB, rAll }));
    chk("C1 A 만 — 조각을 쓴다", !!(await cs.chunkIndex({ categories: [A] })));
    chk("C1 B 만 — 안 쓴다", (await cs.chunkIndex({ categories: [B] })) === null);
    chk("C1 A∪B — 합친 조각이 98% 미만이라 안 쓴다", (await cs.chunkIndex({ categories: [A, B] })) === null);
    chk("C1 제한 없음(인자 없음) — 전체로 재서 안 쓴다", (await cs.chunkIndex()) === null);
    chk("C1 제한 없음(categories:null) — 전체로 재서 안 쓴다", (await cs.chunkIndex({ categories: null })) === null);
    //  A∪B 는 합친 조각으로 잰다 — B 만으로는 98% 미만이어도 A 와 합쳐 98% 이상이면 쓴다
    await addChunks(A_ID, 50); await vecChunks([A_ID]);
    await vecChunks(B_DOCS); await emptyFirst(B_BULK, 2);
    fresh();
    const uA = await ratio([A]), uB = await ratio([B]), uAB = await ratio([A, B]);
    chk("C1 전제 — B 만은 98% 미만 · A∪B 는 98% 이상", uA.ok && uB.total > 0 && !uB.ok && uAB.ok, J({ uA, uB, uAB }));
    chk("C1 A∪B 는 합친 조각으로 잰다 — 합쳐서 98% 이상이면 쓴다", !!(await cs.chunkIndex({ categories: [A, B] })));
    chk("C1 그때도 B 만은 안 쓴다", (await cs.chunkIndex({ categories: [B] })) === null);
  });

  // ── C2 찾기 ──
  await section("C2", async () => {
    const sA = await search(QV, { categories: [A] });
    chk("C2 A 로 좁힌 찾기는 조각으로 — 끝 절만 가까운 A 문서가 1위(문서 벡터는 멀다)", isChunk(sA.route) && sA.n[0] === A_TAIL, J([sA.route, sA.n]));
    const sB = await search(QV, { categories: [B] });
    chk("C2 B 로 좁힌 찾기는 문서 벡터로", isDoc(sB.route) && sB.n[0] === B_NEAR, J([sB.route, sB.n]));
    const sAB = await search(QV, { categories: [A, B] });
    chk("C2 A 와 B 를 함께 — A∪B 가 98% 미만이라 문서 벡터로", isDoc(sAB.route) && sAB.n[0] === A_DECOY, J([sAB.route, sAB.n]));
    const s0 = await search(QV);
    chk("C2 제한 없는 찾기는 문서 벡터로(종전)", isDoc(s0.route) && s0.n[0] === A_DECOY, J([s0.route, s0.n]));
  });

  // ── C3 앱 읽기 범위 ──
  await section("C3", async () => {
    const rcA = await inScope([A], () => recall(RV, null, MEMBER));
    chk("C3 소환 — 앱 범위 A 면 조각으로", rcA.route === "chunk" && rcA.n.join() === A_TAIL, J([rcA.route, rcA.n]));
    const rcB = await inScope([B], () => recall(RV, null, MEMBER));
    chk("C3 소환 — 앱 범위 B 면 문서 벡터로", rcB.route === "vector" && rcB.n.join() === B_NEAR, J([rcB.route, rcB.n]));
    const rc0 = await recall(RV, null, MEMBER);
    chk("C3 소환 — 범위가 없으면 전체 기준(98% 미만 → 문서 벡터)", rc0.route === "vector" && rc0.n[0] === A_DECOY, J([rc0.route, rc0.n]));
    const rcN = await inScope([A], () => recall(RV, null, null));
    chk("C3 소환 — 뷰어가 null 이면 앱 범위가 안 걸려 전체 기준(문서 벡터)", rcN.route === "vector", J([rcN.route, rcN.n]));
    const ssA = await inScope([A], () => search(QV, {}, MEMBER));
    chk("C3 찾기 — 앱 범위 A 안에서 category 인자 없이 → A 기준(조각)", isChunk(ssA.route) && ssA.n[0] === A_TAIL, J([ssA.route, ssA.n]));
    const ssA2 = await inScope([A], () => search(QV, { categories: [A, B] }, MEMBER));
    chk("C3 찾기 — 앱 범위 A ∩ 인자 [A,B] = A → 조각", isChunk(ssA2.route) && ssA2.n[0] === A_TAIL, J([ssA2.route, ssA2.n]));
    const ssAB1 = await inScope([A, B], () => search(QV, { categories: [A] }, MEMBER));
    chk("C3 찾기 — 앱 범위 [A,B] ∩ 인자 [A] = A → 조각", isChunk(ssAB1.route) && ssAB1.n[0] === A_TAIL, J([ssAB1.route, ssAB1.n]));
    const ssAB = await inScope([A, B], () => search(QV, {}, MEMBER));
    chk("C3 찾기 — 앱 범위 [A,B] 에서 인자 없이 → A∪B 기준(문서 벡터)", isDoc(ssAB.route) && ssAB.n[0] === A_DECOY, J([ssAB.route, ssAB.n]));
    const ssU = await inScope([A], () => search(QV, {}, undefined));
    chk("C3 찾기 — 뷰어가 구성원 문자열이 아니면 앱 범위가 안 걸려 전체 기준(문서 벡터)", isDoc(ssU.route) && ssU.n[0] === A_DECOY, J([ssU.route, ssU.n]));
  });

  // ── C10 diag.chunkIndex ──
  await section("C10", async () => {
    const d1 = await search(QV, { categories: [A] });
    chk("C10 조각으로 찾으면 diag.chunkIndex 는 그때 쓴 색인 객체", isChunk(d1.route) && !!d1.d.chunkIndex && typeof d1.d.chunkIndex === "object", J([d1.route, chOf(d1.d)]));
    const d2 = await search(QV, { categories: [B] });
    chk("C10 문서 벡터로 돌면 diag.chunkIndex 는 null(B 로 좁힘)", isDoc(d2.route) && d2.d.chunkIndex === null, J([d2.route, chOf(d2.d)]));
    const d3 = await search(QV);
    chk("C10 문서 벡터로 돌면 diag.chunkIndex 는 null(제한 없음)", isDoc(d3.route) && d3.d.chunkIndex === null, J([d3.route, chOf(d3.d)]));
    await cs.chunkIndex({ categories: [A] }); await cs.chunkIndex();
    seen.length = 0;
    const d4 = await search(QID, { categories: [A] });
    chk("C10 전제 — 식별자 질의는 낱말 채널만(임베딩을 안 부른다 · A 로 좁힘)", !/hybrid/.test(String(d4.route)) && d4.n[0] === A_ID && seen.length === 0, J([d4.route, d4.n, seen.length]));
    chk("C10 벡터 채널이 안 돌면 diag.chunkIndex 칸이 없다(A 로 좁힘 — A 는 조각을 쓸 수 있는 범위)", d4.d.chunkIndex === undefined, chOf(d4.d));
    seen.length = 0;
    const d5 = await search(QID);
    chk("C10 벡터 채널이 안 돌면 diag.chunkIndex 칸이 없다(제한 없음)", !/hybrid/.test(String(d5.route)) && d5.n[0] === A_ID && seen.length === 0 && d5.d.chunkIndex === undefined, J([d5.route, d5.n, seen.length, chOf(d5.d)]));
  });

  // ── C11 약함 판정 — 전체가 98% 미만일 때 ──
  await section("C11", async () => {
    const sg = await search(QV, { categories: [A] });
    chk("C11 전제 — A 로 좁힌 찾기가 조각으로 돌았다", isChunk(sg.route) && !!sg.d.chunkIndex, J([sg.route, chOf(sg.d)]));
    const g1 = await ks.knowledgeSearchStrength(QV, [A_TAIL], { chunkIndex: sg.d.chunkIndex });
    chk("C11 그 diag.chunkIndex 로 재면 — 전체가 98% 미만이어도 조각으로(끝 절의 코사인)", sim(g1) > 0.99, J(g1));
    const g1b = await ks.knowledgeSearchStrength(QV, [A_DECOY], { chunkIndex: sg.d.chunkIndex });
    chk("C11 색인을 주면 문서 벡터를 안 본다(미끼 문서는 조각이 멀다)", sim(g1b) < 0.1, J(g1b));
    const g2 = await ks.knowledgeSearchStrength(QV, [A_TAIL], { chunkIndex: null });
    chk("C11 chunkIndex:null 이면 문서 벡터로 잰다(꼬리 문서는 문서 벡터가 멀다)", sim(g2) < 0.1, J(g2));
    const g2b = await ks.knowledgeSearchStrength(QV, [A_DECOY], { chunkIndex: null });
    chk("C11 chunkIndex:null 이면 문서 벡터로 잰다(미끼 문서의 문서 벡터 0.75)", Math.abs(sim(g2b) - 0.75) < 0.02, J(g2b));
    const sB = await search(QV, { categories: [B] });
    const g2c = await ks.knowledgeSearchStrength(QV, [B_NEAR], { chunkIndex: sB.d.chunkIndex });
    chk("C11 B 로 좁혀 문서 벡터로 찾은 diag.chunkIndex(null)로 재면 문서 벡터로(0.65)", sB.d.chunkIndex === null && Math.abs(sim(g2c) - 0.65) < 0.02, J([chOf(sB.d), g2c]));
    const g3 = await ks.knowledgeSearchStrength(QV, [A_TAIL]);
    chk("C11 chunkIndex 를 안 주면 전체 판정(98% 미만 → 안 씀)을 따라 문서 벡터로(꼬리)", sim(g3) < 0.1, J(g3));
    const g3b = await ks.knowledgeSearchStrength(QV, [A_DECOY], {});
    chk("C11 chunkIndex 칸이 없는 옵션도 안 준 것과 같다(미끼 0.75)", Math.abs(sim(g3b) - 0.75) < 0.02, J(g3b));
    //  값 전달 — knowledge_search 가 «가져올 곳» 을 만들 때(collectHintFor) 찾기의 diag.chunkIndex 를 약함 판정까지 그대로 잇는다
    const h1 = await collectHintFor({ q: QV, names: [A_TAIL], member: MEMBER, isAdmin: false, chunkIndex: sg.d.chunkIndex });
    chk("C11 가져올 곳 — 찾기가 넘긴 색인으로 재면 끝 절이 맞아 강하다(안내 없음)", h1 === null, J(h1));
    const h2 = await collectHintFor({ q: QV, names: [A_TAIL], member: MEMBER, isAdmin: false, chunkIndex: null });
    chk("C11 가져올 곳 — null 을 넘기면 문서 벡터로 재서 약하다", h2?.reason === "weak", J(h2));
    const h3 = await collectHintFor({ q: QV, names: [A_TAIL], member: MEMBER, isAdmin: false });
    chk("C11 가져올 곳 — 안 넘기면 전체 판정(98% 미만)을 따라 약하다", h3?.reason === "weak", J(h3));
  });

  // ── C12 상태 도구 — 전체가 98% 미만일 때 ──
  await section("C12", async () => {
    chk("C12 전제 — 범위 A 판정(쓴다)을 기억해 둔다", !!(await cs.chunkIndex({ categories: [A] })));
    const st1 = await status();
    chk("C12 상태의 active 는 전체 기준 — A 가 다 차 있어도 전체가 98% 미만이면 false", st1?.chunk_search?.active === false, J(st1?.chunk_search));
    const st2 = await inScope([A], () => status({ source: "web", viewer: MEMBER }));
    chk("C12 앱 범위 A 안에서 물어도 전체 기준(false)", st2?.chunk_search?.active === false, J(st2?.chunk_search));
  });

  // ── C7 판정 기억 ──
  await section("C7", async () => {
    const seq = [[[B], false], [[A], true], [null, false], [[A], true], [[A, B], false], [[B], false], [[A], true]];
    const got1 = [];
    for (const [cats, w] of seq) got1.push([cats, w, !!(await cs.chunkIndex(cats ? { categories: cats } : undefined))]);
    chk("C7 같은 30초 안에 범위를 번갈아 물어도 각자 맞다(B 를 먼저)", got1.every(([, w, g]) => w === g), J(got1));
    fresh();
    const a1 = await cs.chunkIndex({ categories: [A] }), w1 = await cs.chunkIndex(), b1 = await cs.chunkIndex({ categories: [B] });
    chk("C7 A 를 먼저 물어도 그 참이 제한 없음 · B 에 섞이지 않는다", !!a1 && w1 === null && b1 === null, J([!!a1, w1, b1]));
    fresh();
    const m = [
      (await search(QV, { categories: [B] })).route, (await search(QV, { categories: [A] })).route, (await search(QV)).route,
      (await inScope([A], () => recall(RV, null, MEMBER))).route, (await inScope([B], () => recall(RV, null, MEMBER))).route,
      (await recall(RV, null, MEMBER)).route, (await inScope([A], () => search(QV, {}, MEMBER))).route, (await search(QV, { categories: [A] })).route,
    ];
    chk("C7 찾기 · 소환을 번갈아도 각자 맞다", isDoc(m[0]) && isChunk(m[1]) && isDoc(m[2]) && m[3] === "chunk" && m[4] === "vector" && m[5] === "vector" && isChunk(m[6]) && isChunk(m[7]), J(m));
    fresh();
    const o1 = await cs.chunkIndex({ categories: [A, A] }), o2 = await cs.chunkIndex({ categories: [B, A] }), o3 = await cs.chunkIndex({ categories: [A, B, B, A] });
    chk("C7 순서 · 중복만 다른 목록은 같은 판정([A,A]=[A] 참 · [B,A]=[A,B,B,A] 거짓)", !!o1 && o2 === null && o3 === null, J([!!o1, o2, o3]));

    //  같은 범위(순서 · 중복만 다름)는 같은 기억 · 30초 · 다른 범위와 제한 없음은 따로
    fresh();
    const t0 = Date.now();
    const k1 = await cs.chunkIndex({ categories: [A, B], now: () => t0 });
    await vecChunks(B_DOCS);   // B 가 다 찬다 → A∪B · B · 전체가 다 찬다
    const after = { AB: await ratio([A, B]), B: await ratio([B]), all: await ratio(null) };
    const k2 = await cs.chunkIndex({ categories: [B, A, A], now: () => t0 + 10_000 });
    const kB = await cs.chunkIndex({ categories: [B], now: () => t0 + 10_000 });
    const kW = await cs.chunkIndex({ now: () => t0 + 10_000 });
    const k3 = await cs.chunkIndex({ categories: [A, B], now: () => t0 + 31_000 });
    chk("C7 전제 — 처음엔 A∪B 를 안 쓰고, B 를 채운 뒤에는 A∪B · B · 전체가 98% 이상", k1 === null && after.AB.ok && after.B.ok && after.all.ok, J([k1, after]));
    chk("C7 30초 안에는 같은 범위(순서 · 중복만 다른 [B,A,A])의 기억을 쓴다", k2 === null, J(k2 === null ? null : "다시 잼"));
    chk("C7 다른 범위(B)는 그 기억과 상관없이 따로 잰다", !!kB);
    chk("C7 제한 없음도 그 기억과 상관없이 따로 잰다", !!kW);
    chk("C7 30초가 지나면 다시 잰다", !!k3);
    await dropChunks(B_DOCS);   // B 를 다시 비운다
    const k4 = await cs.chunkIndex({ categories: [B, A], now: () => t0 + 40_000 });
    cs.resetChunkIndex();
    const k5 = await cs.chunkIndex({ categories: [A, B], now: () => t0 + 41_000 });
    chk("C7 다시 잰 판정도 30초 기억한다(B 를 비워도 아직 쓴다)", !!k4);
    chk("C7 resetChunkIndex 뒤에는 30초 안이어도 다시 잰다", k5 === null);

    //  resetChunkIndex 는 «모든» 기억을 비운다 — 세 범위의 판정을 함께 뒤집는다
    fresh();
    const t1 = Date.now();
    const at = (ms) => () => t1 + ms;
    const x0 = [await cs.chunkIndex({ categories: [A], now: at(0) }), await cs.chunkIndex({ categories: [B], now: at(0) }), await cs.chunkIndex({ now: at(0) })];
    await dropChunks([A_DECOY]); await vecChunks(B_DOCS);   // A 는 모자라고 B · 전체는 찬다
    const flipped = { A: await ratio([A]), B: await ratio([B]), all: await ratio(null) };
    const x1 = [await cs.chunkIndex({ categories: [A], now: at(10_000) }), await cs.chunkIndex({ categories: [B], now: at(10_000) }), await cs.chunkIndex({ now: at(10_000) })];
    cs.resetChunkIndex();
    const x2 = [await cs.chunkIndex({ categories: [A], now: at(11_000) }), await cs.chunkIndex({ categories: [B], now: at(11_000) }), await cs.chunkIndex({ now: at(11_000) })];
    const tf = (xs) => xs.map((x) => (x ? "쓴다" : x === null ? "null" : String(x)));
    chk("C7 전제 — 처음엔 A 만 쓰고, 바꾼 뒤에는 A 는 98% 미만 · B · 전체는 98% 이상", !!x0[0] && x0[1] === null && x0[2] === null && !flipped.A.ok && flipped.B.ok && flipped.all.ok, J([tf(x0), flipped]));
    chk("C7 30초 안에는 범위마다 기억한 판정(A 씀 · B 안 씀 · 제한 없음 안 씀)", !!x1[0] && x1[1] === null && x1[2] === null, J(tf(x1)));
    chk("C7 resetChunkIndex 는 모든 범위의 기억을 비운다(A 안 씀 · B 씀 · 제한 없음 씀)", x2[0] === null && !!x2[1] && !!x2[2], J(tf(x2)));

    //  기억 칸 상한 — 서로 다른 범위를 1,000개 물으면 기억을 비운다. 그 뒤 A 는 30초 안이어도 다시 잰다.
    await mainState();
    const t2 = Date.now();
    const c0 = await cs.chunkIndex({ categories: [A], now: () => t2 });
    for (let i = 0; i < 1000; i++) await cs.chunkIndex({ categories: [900_000 + i], now: () => t2 });
    await dropChunks([A_DECOY]);   // A 가 모자라게 한다
    const c1 = await cs.chunkIndex({ categories: [A], now: () => t2 + 1_000 });
    chk("C7 기억 칸이 1,000개를 넘으면 비운다 — 30초 안이어도 A 를 다시 잰다(쓴다 → 안 씀)", !!c0 && c1 === null, J([!!c0, c1]));
  });

  // ── C4 범위에 든 지식만 센다 ──
  await section("C4", async () => {
    const docState = async (name) => (await q(`SELECT k.lifecycle, k.searchable, kc.category_id, kc.state,
        (SELECT count(*)::int FROM knowledge_chunk c WHERE c.name=k.name) AS chunks,
        (SELECT count(*)::int FROM knowledge_chunk c WHERE c.name=k.name AND c.embedding_vector IS NULL) AS empty
      FROM knowledge k LEFT JOIN knowledge_category kc ON kc.name=k.name WHERE k.name=$1`, [name]))[0];
    const emptyCase = async (name, label, counted) => {
      await dropChunks([name]);
      fresh();
      const s = await docState(name);
      chk(`C4 전제 — ${label} 지식이 A 에 연결돼 있고 그 조각(${s?.chunks})이 모두 비었다`, Number(s?.category_id) === A && s.chunks >= 5 && s.empty === s.chunks, J(s));
      const got = await cs.chunkIndex({ categories: [A] });
      if (counted) chk(`C4 ${label} 연결은 «든 지식» — 그 빈 조각으로 A 가 98% 미만이 되어 안 쓴다`, got === null);
      else chk(`C4 ${label} 지식의 빈 조각은 세지 않는다 — A 는 여전히 쓴다`, !!got);
      await vecChunks([name]);
    };
    await emptyCase(X_ARCH, "보관(lifecycle=archived)", false);
    await emptyCase(X_OFF, "검색 제외(searchable=false)", false);
    await emptyCase(X_REJ, "거절(rejected) 연결", false);
    await emptyCase(X_PROP, "제안(proposed)", true);
    fresh();
    chk("C4 제안 지식의 조각을 채우면 A 는 다시 쓴다", !!(await cs.chunkIndex({ categories: [A] })));
    //  찬 쪽 — 빼야 할 지식의 «벡터 있는» 조각으로 모자란 A 를 채우지 않는다
    await dropChunks([A_DECOY]);
    for (const x of [X_ARCH, X_OFF, X_REJ]) await addChunks(x, 60, 1000);
    await vecChunks([X_ARCH, X_OFF, X_REJ]);
    fresh();
    const r = await ratio([A]);
    const minX = Math.min(await nChunks(X_ARCH), await nChunks(X_OFF), await nChunks(X_REJ));
    chk("C4 전제 — A 는 98% 미만이고, 뺄 지식 하나만 세어도 98% 를 넘는다", !r.ok && (r.have + minX) >= (r.total + minX) * 0.98, J({ r, minX }));
    chk("C4 보관 · 검색 제외 · 거절 지식의 찬 조각으로 모자란 A 를 채우지 않는다", (await cs.chunkIndex({ categories: [A] })) === null);
  });

  // ── C5 빈 범위 ──
  await section("C5", async () => {
    chk("C5 지식이 하나도 없는 카테고리 → 안 쓴다", (await cs.chunkIndex({ categories: [E] })) === null);
    await addChunks(F_ARCH, 3); await vecChunks([F_ARCH]);
    fresh();
    const fs = (await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE c.embedding_vector IS NOT NULL)::int AS v FROM knowledge_chunk c WHERE c.name=$1`, [F_ARCH]))[0];
    const rF = await ratio([F]);
    chk("C5 전제 — F 에는 보관 지식만 있고 그 조각은 다 찼다 · 범위 안 조각은 0", fs.n >= 4 && fs.v === fs.n && rF.total === 0, J({ fs, rF }));
    chk("C5 범위 안 조각이 0(보관 지식만 든 카테고리) → 안 쓴다", (await cs.chunkIndex({ categories: [F] })) === null);
    chk("C5 빈 목록 → 안 쓴다", (await cs.chunkIndex({ categories: [] })) === null);
    const sE = await search(QV, { categories: [E] });
    chk("C5 빈 카테고리로 좁힌 찾기는 조각을 안 쓴다", !isChunk(sE.route) && !sE.d.chunkIndex, J([sE.route, chOf(sE.d)]));
    const sX = await inScope([B], () => search(QV, { categories: [A] }, MEMBER));
    chk("C5 교집합이 빈 목록(앱 범위 B ∩ 인자 A) → 조각을 안 쓴다", !isChunk(sX.route) && !sX.d.chunkIndex, J([sX.route, chOf(sX.d), sX.n]));
    const sZ = await inScope([], () => search(QV, {}, MEMBER));
    chk("C5 앱 범위가 빈 목록인 찾기 → 조각을 안 쓴다", !isChunk(sZ.route) && !sZ.d.chunkIndex, J([sZ.route, chOf(sZ.d), sZ.n]));
    const rZ = await inScope([], () => recall(RV, null, MEMBER));
    chk("C5 앱 범위가 빈 목록인 소환 → 조각을 안 쓴다", rZ.route !== "chunk", J([rZ.route, rZ.n]));
  });

  // ── C8 되돌리기 스위치 ──
  await section("C8", async () => {
    chk("C8 전제 — 범위 A 는 다 차서 조각을 쓴다(판정을 기억해 둔다)", !!(await cs.chunkIndex({ categories: [A] })));
    const off = await setSwitch(false);
    __resetQueryEmbedCache();
    const s8 = await search(QV, { categories: [A] });
    chk("C8 끄면 곧바로 — 범위가 다 차 있어도 찾기가 문서 벡터로", off?.enabled === false && isDoc(s8.route) && s8.n[0] === A_DECOY, J([off, s8.route, s8.n]));
    const r8 = await inScope([A], () => recall(RV, null, MEMBER));
    chk("C8 끄면 — 앱 범위 A 소환도 문서 벡터로", r8.route === "vector" && r8.n.join() === A_DECOY, J([r8.route, r8.n]));
    fresh();
    chk("C8 끄면 — 범위 A 판정이 null", (await cs.chunkIndex({ categories: [A] })) === null);
    await setSwitch(true);
    fresh();
    const s8b = await search(QV, { categories: [A] });
    chk("C8 켜면 돌아온다", !!(await cs.chunkIndex({ categories: [A] })) && isChunk(s8b.route) && s8b.n[0] === A_TAIL, J([s8b.route, s8b.n]));
  });

  // ── C9 옛 모델 벡터 ──
  await section("C9", async () => {
    await q(`UPDATE knowledge_chunk SET embedding_model='old-model' WHERE name=$1`, [A_DECOY]);   // 벡터는 그대로 둔다
    fresh();
    const old = (await q(`SELECT count(*)::int AS n FROM knowledge_chunk WHERE name=$1 AND embedding_vector IS NOT NULL AND embedding_model='old-model'`, [A_DECOY]))[0].n;
    const r = await ratio([A]);
    chk("C9 전제 — A 의 조각 하나가 옛 모델 벡터(벡터는 있다) · 지금 모델로는 98% 미만", old >= 1 && !r.ok, J({ old, r }));
    chk("C9 지금 모델이 아닌 벡터는 범위 안에서도 «없음» — A 를 안 쓴다", (await cs.chunkIndex({ categories: [A] })) === null);
    await q(`UPDATE knowledge_chunk SET embedding_model=$1 WHERE name=$2`, [MODEL, A_DECOY]);
    await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [cfg("new-model")]);
    fresh();
    chk("C9 모델이 바뀌면 다 찼던 A 도 안 쓴다(옛 벡터)", (await cs.chunkIndex({ categories: [A] })) === null);
    await q(`UPDATE knowledge_chunk SET embedding_model='new-model' WHERE name IN (SELECT name FROM knowledge_category WHERE category_id=$1)`, [A]);
    fresh();
    const rn = await ratio([A], "new-model"), rw = await ratio(null, "new-model");
    chk("C9 전제 — A 의 조각은 새 모델로 다 찼고 전체는 아니다", rn.ok && rn.have === rn.total && !rw.ok, J({ rn, rw }));
    chk("C9 범위 A 의 조각을 새 모델로 채우면 A 는 쓴다", !!(await cs.chunkIndex({ categories: [A] })));
    chk("C9 그때 제한 없음은 안 쓴다", (await cs.chunkIndex()) === null);
  });

  // ── C6 98% 경계 (+ C3 · C11 · C12 의 «전체가 98% 이상» 쪽) ──
  await section("C6", async () => {
    //  정확히 98/100 — 그때 전체는 98% 미만(B 가 비어 있다)
    await emptyFirst(C_MAIN, 2);
    fresh();
    const r98 = await ratio([C]), w98 = await ratio(null);
    chk("C6 전제 — 범위 C 는 100 조각 중 98 · 전체는 98% 미만", r98.total === 100 && r98.have === 98 && !w98.ok, J({ r98, w98 }));
    chk("C6 범위 안 정확히 98% → 쓴다", !!(await cs.chunkIndex({ categories: [C] })));
    chk("C6 그때 제한 없음은 안 쓴다(전체로 잰다)", (await cs.chunkIndex()) === null);
    const s98 = await search(QV, { categories: [C] });
    chk("C6 C 로 좁힌 찾기도 조각으로", isChunk(s98.route) && !!s98.d.chunkIndex, J([s98.route, chOf(s98.d)]));
    //  하나 모자람 97/100 — 그때 전체는 98% 이상(B 를 채운다)
    await emptyFirst(C_MAIN, 3);
    await vecChunks(B_DOCS);
    fresh();
    const r97 = await ratio([C]), w97 = await ratio(null);
    chk("C6 전제 — 범위 C 는 100 조각 중 97 · 전체는 98% 이상", r97.total === 100 && r97.have === 97 && w97.ok, J({ r97, w97 }));
    chk("C6 범위 안 하나 모자람(97%) → 안 쓴다", (await cs.chunkIndex({ categories: [C] })) === null);
    chk("C6 그때 제한 없음은 쓴다(범위 판정이 섞이지 않는다)", !!(await cs.chunkIndex()));
    chk("C5 빈 목록은 제한 없음이 아니다 — 전체가 98% 이상이어도 범위 [] 는 안 쓴다", (await cs.chunkIndex({ categories: [] })) === null);
    const s97 = await search(QV, { categories: [C] }), s97all = await search(QV);
    chk("C6 찾기 — C 로 좁히면 문서 벡터(diag.chunkIndex null) · 제한 없으면 조각", isDoc(s97.route) && s97.d.chunkIndex === null && isChunk(s97all.route), J([s97.route, chOf(s97.d), s97all.route]));
    chk("C6 (양성 대조) 제한 없는 조각 찾기가 끝 절만 가까운 꼬리 문서를 1위로 낸다", s97all.n[0] === A_TAIL, J(s97all.n));
    const rcC = await inScope([C], () => recall(RV, null, MEMBER));
    const rc0 = await recall(RV, null, MEMBER);
    chk("C6 소환 — 앱 범위 C(97%)는 문서 벡터 · 범위 없는 소환은 전체(98% 이상) 기준 조각", rcC.route === "vector" && rc0.route === "chunk", J([rcC.route, rcC.n, rc0.route, rc0.n]));
    chk("C6 (양성 대조) 범위 없는 조각 소환이 꼬리 문서를 낸다", rc0.n.join() === A_TAIL, J(rc0.n));
    //  C12 — 범위 C 판정(안 씀)을 기억해 둔 뒤에도 상태는 전체 기준
    await cs.chunkIndex({ categories: [C] });
    const st = await status();
    chk("C12 상태의 active 는 전체 기준 — 범위 C 가 모자라도 전체가 98% 이상이면 true", st?.chunk_search?.active === true, J(st?.chunk_search));
    //  C11 — 전체가 조각을 쓸 때
    const g1 = await ks.knowledgeSearchStrength(QV, [A_TAIL]);
    chk("C11 chunkIndex 를 안 주면 전체 판정(98% 이상 → 씀)을 따라 조각으로", sim(g1) > 0.99, J(g1));
    const g2 = await ks.knowledgeSearchStrength(QV, [A_DECOY], { chunkIndex: null });
    chk("C11 chunkIndex:null 이면 전체가 조각을 써도 문서 벡터로(미끼 0.75)", Math.abs(sim(g2) - 0.75) < 0.02, J(g2));
    const g3 = await ks.knowledgeSearchStrength(QV, [A_TAIL], { chunkIndex: null });
    chk("C11 chunkIndex:null 이면 전체가 조각을 써도 문서 벡터로(꼬리는 멀다)", sim(g3) < 0.1, J(g3));
  });
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
