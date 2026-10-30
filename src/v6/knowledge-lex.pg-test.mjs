// 지식 낱말 색인(BM25) · 식별자 분기 · 찾기 기록(#5201) PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/knowledge-lex.pg-test.mjs
//
// 왜 이 계층인가: 색인이 knowledge 를 따라가는지, BM25 점수와 공개범위 · 수명 거르기가 맞는지, 쓰지 않는 매개변수를 Postgres 가 거부하지 않는지는 실제 SQL 에서만 드러난다.
//  벡터는 가짜 임베딩 서버(이 파일 안의 HTTP)가 정하고, 그 서버가 받은 요청 수로 «임베딩을 불렀나» 를 잰다.
//
//  사양 · 엣지 표:
//   X1  스윕이 활성 문서를 색인한다 · 낱말 수 · 문서 길이 · 빈 표에서 lexReady=false → 채운 뒤 true
//   X2  BM25 — 드문 낱말이 든 문서가 흔한 낱말만 든 문서보다 위 · 조사를 뗀 꼴로 맞는다 · 영문 조각으로 맞는다
//   X3  본문을 고치면 — 빠진 낱말은 안 맞고 새 낱말이 맞는다 · 그대로인 낱말 행은 다시 쓰지 않는다(끝 덧붙임이 표를 흔들지 않는다)
//   X4  글이 그대로면(시각만 올랐다) 시각만 맞춘다 · 다음 스윕에 다시 집지 않는다
//   X5  보관 · 검색 제외 · 삭제 — 스윕이 색인에서 뺀다 · 낱말 행도 같이 사라진다 · 스윕 전에도 결과에 안 나온다
//   X6  다시 활성으로 — 스윕이 되살린다
//   X7  식별자 질의 — 낱말 채널만(임베딩을 안 부른다 · route=lexical) · 정확한 이름이 1위
//   X8  식별자인데 낱말이 하나도 안 맞으면 — 하이브리드로 내려간다(임베딩을 부른다)
//   X9  문장 질의 — 낱말 + 벡터(route=hybrid) · 벡터로만 가까운 문서도 나온다
//   X10 임베딩이 꺼졌으면 — 낱말 채널만(종전엔 grep 이라 문장이 0건이었다)
//   X11 색인이 덜 찼으면 — 종전 길(hybrid-grep · grep)
//   X12 문장부호뿐인 질의 — 낱말 없음 · 오류 없이 종전 길
//   X13 knowledge_grep — 맞춤은 그대로(낱말 전부 AND) · 같은 급은 BM25 순(최신순이 아니다) · 이름 정확일치 > 제목 일치 · route=bm25-order
//   X14 grep 정규식 — 맞춤은 정규식 그대로 · 순서 BM25
//   X15 plain(사람 화면) · 검색 제외 포함 찾기 — BM25 를 안 탄다(최신순 · 검색 제외도 나온다)
//   X16 공개범위 — 멤버 전용 문서는 다른 사람에게 낱말 · 하이브리드 어느 길로도 안 나온다
//   X17 거르기 — injection · provenance · category 가 낱말 채널 후보에 걸린다
//   X18 워크스페이스 — 다른 tenant 값으로 부르면 낱말 행도 통계도 안 보인다
//   X19 스니펫 — 조사를 뗀 꼴로 줄을 찾는다(앞부분 미리보기로 떨어지지 않는다)
//   X20 동시 맞춤 — 같은 문서를 둘이 맞춰도 낱말 행이 어긋나지 않는다
//   X21 벡터 탐색 폭 — 트랜잭션 밖으로 새지 않는다
//   X22 찾기 기록 — 세션 호출만 남긴다(search · grep · similar · get) · 웹 화면 · 앱 토큰은 안 남긴다 · 검색어 200자 · 앞 10건 · 보존 기간 뒤 지운다
//   X23 스윕 시간 상한 — 상한을 넘으면 멈추고 다음 판이 잇는다
//   X24 BM25 SQL 이 실패해도 grep 은 답한다
//   X25 통계에 볼 수 없는 문서가 안 들어간다 — 숨은 문서가 있든 없든 다른 사람이 받는 순서 · 점수가 같다(hybrid · grep) · 특권 신원의 순서는 달라진다(양성 대조)
//   X26 낱말 규칙의 판이 다른 문서는 스윕이 다시 만든다
//   X27 저장 — 스윕 없이 곧 찾힌다
//   X28 세션 완전 삭제 · 보존기간 — 그 박스의 찾기 기록도 지운다
import pg from "pg";
import http from "node:http";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_lex_5201";
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
const { itemsPool, withTx } = await import(`${D}/db/client.js`);
const ks = await import(`${D}/v6/knowledge-search.js`);
const kst = await import(`${D}/v6/knowledge-store.js`);
const lx = await import(`${D}/v6/knowledge-lex.js`);
const ls = await import(`${D}/v6/knowledge-lex-store.js`);
const lg = await import(`${D}/v6/knowledge-search-log-store.js`);
const kc = await import(`${D}/v6/knowledge-common.js`);
const sessionLog = await import(`${D}/v6/session-log-store.js`);
const { __resetQueryEmbedCache } = await import(`${D}/v6/search-util.js`);
const { readStaticCapabilities, readNamedCapabilities } = await import(`${D}/capabilities/knowledge/read.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const names = (rows) => rows.map((r) => r.name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const capOf = (n) => [...readStaticCapabilities, ...readNamedCapabilities].find((c) => c.name === n);

// ── 가짜 임베딩 서버 — «zqv» 가 든 글은 basis(0), 나머지는 basis(7). 받은 글 수를 센다. ──
const dimRow = (await q(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid='knowledge'::regclass AND attname='embedding_vector'`))[0];
const DIMS = Number(dimRow?.d) > 0 ? Number(dimRow.d) : 1024;
const basis = (i) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const lit = (v) => "[" + v.join(",") + "]";
let embedCalls = 0;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const input = (JSON.parse(body || "{}").input ?? []);
    embedCalls += input.length;
    const data = input.map((t, index) => ({ index, embedding: /zqv/.test(String(t)) ? basis(0) : basis(7) }));
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
await q(`INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING`);
const embedOn = JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${PORT}`, model: "fake", dimensions: DIMS, send_dimensions: false, request_timeout_ms: 5000 });
await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb, embedding_backfill_paused=true WHERE id=1`, [embedOn]);

const ctx = { actor: "pgt-x", source: "web" };
const HOME = "zlhome";
await q(`INSERT INTO category(key, name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [HOME]);
const save = (name, title, body, extra = {}) => kst.upsertKnowledge({ name, title, body_md: body, type: "reference", category: HOME, ...extra }, ctx);
//  저장이 그 문서를 바로 맞추는 일(기다리지 않는다)이 끝나기를 기다린 뒤 스윕한다 — 안 그러면 시험의 세기가 그 일과 경합한다.
const settled = async () => { await sleep(30); for (let i = 0; i < 100; i++) { const n = Number((await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state <> 'idle' AND pid <> pg_backend_pid()`))[0].n); if (n === 0) return; await sleep(10); } };
const sweep = async () => { await settled(); let total = { indexed: 0, removed: 0, failed: 0 }; for (;;) { const r = await ls.sweepKnowledgeLex(); total.indexed += r.indexed; total.removed += r.removed; total.failed += r.failed; if (!r.indexed && !r.removed) return total; } };
const dirty = async () => Number((await q(
  `SELECT count(*)::int AS n FROM knowledge k LEFT JOIN knowledge_lex_doc d ON d.name=k.name WHERE k.lifecycle='active' AND k.searchable AND (d.id IS NULL OR d.source_updated_at < k.updated_at)`))[0].n);
const posts = async (name) => Number((await q(`SELECT count(*)::int AS n FROM knowledge_lex_posting p JOIN knowledge_lex_doc d ON d.id=p.doc_id WHERE d.name=$1`, [name]))[0].n);
const docRow = async (name) => (await q(`SELECT * FROM knowledge_lex_doc WHERE name=$1`, [name]))[0];
const bm = async (query) => { const p = []; return q(`WITH ${lx.bm25Sql(lx.lexQueryTerms(query), p, "TRUE")} SELECT name, score FROM bm ORDER BY score DESC, name`, p); };
const search = async (query, opts = {}, viewer) => { const d = {}; const rows = await ks.hybridSearchKnowledge(query, { limit: 20, ...opts }, viewer, d); return { rows, route: d.route, n: names(rows) }; };
const grep = async (query, opts = {}, viewer) => { const d = {}; const rows = await ks.searchKnowledge(query, { limit: 20, ...opts }, viewer, d); return { rows, route: d.route, n: names(rows) }; };

const T = "zl" + Math.floor(Math.random() * 1e6);
const LONG = "공통낱말 ".repeat(60);

try {
  // ── X1 ──
  chk("X1 빈 표 = 색인을 쓰지 않는다", (await ls.lexReady()) === false);
  await save(`${T}-rare`, "희귀 문서", `임베딩을 다시 돌렸다. 희귀규칙낱말 공통낱말 한 번.`);
  await save(`${T}-common`, "흔한 문서", `${LONG} 임베딩`);
  await save(`${T}-code`, "코드 문서", `src/v6/knowledge-store.ts 의 parseGrep 을 고쳤다. embedding_vector 칸.`);
  await save(`${T}-vec`, "벡터 문서", `낱말로는 안 맞는 글이다 환불`);
  await save(`${T}-arch`, "보관될 문서", `보관낱말 본문`);
  await save(`${T}-unsearch`, "제외될 문서", `제외낱말 본문`);
  const s1 = await sweep();
  chk("X1 활성 문서가 모두 색인됐다", s1.failed === 0 && (await dirty()) === 0 && Number((await q(`SELECT count(*)::int AS n FROM knowledge_lex_doc WHERE name LIKE $1`, [`${T}-%`]))[0].n) === 6, JSON.stringify(s1));
  ls.__resetLexReady();
  chk("X1 다 차면 색인을 쓴다", (await ls.lexReady()) === true);
  const dr = await docRow(`${T}-rare`);
  const toks = lx.lexTokens(lx.lexDocText({ name: `${T}-rare`, title: "희귀 문서", body_md: `임베딩을 다시 돌렸다. 희귀규칙낱말 공통낱말 한 번.` }));
  chk("X1 문서 길이 = 낱말 수(겹침 포함)", Number(dr.doc_len) === toks.length, `${dr.doc_len} vs ${toks.length}`);
  chk("X1 낱말 행 = 겹치지 않는 낱말 수", (await posts(`${T}-rare`)) === new Set(toks).size);

  // ── X2 ──
  const b1 = await bm(`희귀규칙낱말 공통낱말`);
  chk("X2 드문 낱말이 든 문서가 위다", b1[0]?.name === `${T}-rare`, JSON.stringify(b1.slice(0, 3)));
  chk("X2 흔한 낱말만 든 문서도 맞는다(점수는 낮다)", b1.some((r) => r.name === `${T}-common`));
  chk("X2 조사를 뗀 꼴로 맞는다", names(await bm(`임베딩이`)).includes(`${T}-rare`));
  chk("X2 파일 경로 조각으로 맞는다", names(await bm(`store`))[0] === `${T}-code`);
  chk("X2 낙타 표기 조각으로 맞는다", names(await bm(`grep`)).includes(`${T}-code`));

  // ── X3 ──
  const beforeXmin = (await q(`SELECT p.term, p.xmin::text AS x FROM knowledge_lex_posting p JOIN knowledge_lex_doc d ON d.id=p.doc_id WHERE d.name=$1`, [`${T}-rare`]));
  await save(`${T}-rare`, "희귀 문서", `임베딩을 다시 돌렸다. 희귀규칙낱말 공통낱말 한 번.\n\n덧붙인낱말`);
  await sweep();
  const afterXmin = new Map((await q(`SELECT p.term, p.xmin::text AS x FROM knowledge_lex_posting p JOIN knowledge_lex_doc d ON d.id=p.doc_id WHERE d.name=$1`, [`${T}-rare`])).map((r) => [r.term, r.x]));
  chk("X3 끝 덧붙임 — 새 낱말이 맞는다", names(await bm(`덧붙인낱말`))[0] === `${T}-rare`);
  chk("X3 끝 덧붙임 — 그대로인 낱말 행은 다시 쓰지 않는다", beforeXmin.length > 3 && beforeXmin.every((r) => afterXmin.get(r.term) === r.x));
  await save(`${T}-rare`, "희귀 문서", `임베딩을 다시 돌렸다. 공통낱말 한 번.`);
  await sweep();
  chk("X3 본문에서 빠진 낱말은 안 맞는다", !names(await bm(`희귀규칙낱말`)).includes(`${T}-rare`));

  // ── X4 ──
  const r4a = await docRow(`${T}-code`);
  await q(`UPDATE knowledge SET updated_at = now() + interval '1 second' WHERE name=$1`, [`${T}-code`]);
  chk("X4 시각이 오르면 스윕 대상이다", (await dirty()) === 1);
  chk("X4 글이 그대로면 낱말을 안 고친다", (await ls.syncKnowledgeLex(`${T}-code`)) === "unchanged");
  const r4b = await docRow(`${T}-code`);
  chk("X4 시각만 맞춘다", r4a.id === r4b.id && r4a.content_hash === r4b.content_hash && (await dirty()) === 0);

  // ── X5 ──
  await save(`${T}-del`, "지울 문서", `삭제낱말 본문`);
  await sweep();
  await q(`UPDATE knowledge SET lifecycle='archived', updated_at=now() WHERE name=$1`, [`${T}-arch`]);
  await q(`UPDATE knowledge SET searchable=false WHERE name=$1`, [`${T}-unsearch`]);
  await q(`DELETE FROM knowledge WHERE name=$1`, [`${T}-del`]);
  ls.__resetLexReady();
  chk("X5 스윕 전에도 보관 문서는 결과에 없다", !(await search(`보관낱말`)).n.includes(`${T}-arch`));
  chk("X5 스윕 전에도 검색 제외 문서는 결과에 없다", !(await search(`제외낱말`)).n.includes(`${T}-unsearch`));
  const s5 = await sweep();
  chk("X5 스윕이 색인에서 뺀다", s5.removed === 3 && !(await docRow(`${T}-arch`)) && !(await docRow(`${T}-unsearch`)) && !(await docRow(`${T}-del`)), JSON.stringify(s5));
  chk("X5 낱말 행도 같이 사라진다", (await bm(`삭제낱말`)).length === 0 && (await bm(`보관낱말`)).length === 0);

  // ── X6 ──
  await q(`UPDATE knowledge SET lifecycle='active', updated_at=now() WHERE name=$1`, [`${T}-arch`]);
  await sweep();
  chk("X6 다시 활성으로 — 색인에 돌아온다", names(await bm(`보관낱말`))[0] === `${T}-arch`);

  // ── 벡터 준비 — 벡터 문서만 질의 쪽(basis 0) ──
  await q(`UPDATE knowledge SET embedding_vector=$1::vector, embedding_model='fake', embedding_updated_at=now() WHERE name=$2`, [lit(basis(0)), `${T}-vec`]);
  await q(`UPDATE knowledge SET embedding_vector=$1::vector, embedding_model='fake', embedding_updated_at=now() WHERE name <> $2 AND embedding_vector IS NULL`, [lit(basis(7)), `${T}-vec`]);
  ls.__resetLexReady();

  // ── X7 ──
  __resetQueryEmbedCache(); embedCalls = 0;
  const r7 = await search(`src/v6/knowledge-store.ts`);
  chk("X7 식별자 — 낱말 채널만", r7.route === "lexical" && r7.n[0] === `${T}-code`, JSON.stringify([r7.route, r7.n]));
  chk("X7 식별자 — 임베딩을 안 부른다", embedCalls === 0, String(embedCalls));
  const r7b = await search(`${T}-code`);
  chk("X7 정확한 이름이 1위", r7b.n[0] === `${T}-code`, JSON.stringify(r7b.n));
  chk("X7 점수가 있다", Number(r7.rows[0].score) > 0);

  // ── X8 ──
  __resetQueryEmbedCache(); embedCalls = 0;
  const r8 = await search(`zqv_no_match_here`);
  chk("X8 식별자인데 안 맞으면 하이브리드로", r8.route === "hybrid" && embedCalls === 1 && r8.n[0] === `${T}-vec`, JSON.stringify([r8.route, embedCalls, r8.n.slice(0, 2)]));

  // ── X9 ──
  __resetQueryEmbedCache(); embedCalls = 0;
  const r9 = await search(`zqv 임베딩을 어떻게 돌렸나`);
  chk("X9 문장 — 낱말 + 벡터", r9.route === "hybrid" && embedCalls === 1, JSON.stringify([r9.route, embedCalls]));
  chk("X9 낱말로 맞는 문서가 나온다", r9.n.includes(`${T}-rare`), JSON.stringify(r9.n));
  chk("X9 벡터로만 가까운 문서가 나온다", r9.n.includes(`${T}-vec`), JSON.stringify(r9.n));

  // ── X10 ──
  await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [JSON.stringify({ provider: "off", explicit: true })]);
  __resetQueryEmbedCache();
  const r10 = await search(`임베딩을 어떻게 다시 돌렸는지 알려줘`);
  chk("X10 임베딩 꺼짐 — 낱말 채널로 문장을 찾는다", r10.route === "lexical" && r10.n.includes(`${T}-rare`), JSON.stringify([r10.route, r10.n]));
  await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [embedOn]);
  __resetQueryEmbedCache();

  // ── X11 ──
  const saved = await q(`SELECT id, name FROM knowledge_lex_doc`);
  await q(`DELETE FROM knowledge_lex_doc`);
  ls.__resetLexReady();
  const r11 = await search(`zqv 환불`);
  chk("X11 색인이 덜 찼으면 종전 길(hybrid-grep)", r11.route === "hybrid-grep", String(r11.route));
  const r11b = await grep(`임베딩`);
  chk("X11 grep 도 종전 순서", r11b.route === "grep", String(r11b.route));
  await q(`DELETE FROM knowledge_lex_posting`);
  await sweep();
  ls.__resetLexReady();
  chk("X11 다시 채우면 돌아온다", (await ls.lexReady()) === true && saved.length > 0);

  // ── X12 ──
  const r12 = await search(`?!()`);
  chk("X12 문장부호뿐 — 오류 없이 종전 길", r12.route === "hybrid-grep" || r12.route === "grep", String(r12.route));

  // ── X13 ──
  await save(`${T}-g-old`, "오래된 문서", `정산낱말 ${"정산낱말 ".repeat(20)} 환급낱말 짧다`);
  await save(`${T}-g-new`, "최근 문서", `정산낱말 환급낱말 ${"다른말 ".repeat(200)}`);
  await save(`${T}-g-title`, "정산낱말 환급낱말 제목", `본문에는 없다`);
  await save(`정산낱말`, "이름이 낱말과 같은 문서", `정산낱말만 있다`);
  await save(`${T}-g-one`, "한쪽만", `정산낱말 하나만 든다`);
  await q(`UPDATE knowledge SET updated_at=$2 WHERE name=$1`, [`${T}-g-old`, "2026-01-01T00:00:00Z"]);
  await sweep();
  const r13 = await grep(`정산낱말 환급낱말`);
  chk("X13 맞춤은 그대로 — 낱말 전부 AND", !r13.n.includes(`${T}-g-one`) && !r13.n.includes("정산낱말"), JSON.stringify(r13.n));
  chk("X13 제목에 낱말 전부 → BM25 순(최신순이면 뒤집힌다)", r13.n[0] === `${T}-g-title` && r13.n[1] === `${T}-g-old` && r13.n[2] === `${T}-g-new`, JSON.stringify(r13.n));
  chk("X13 길 표시", r13.route === "bm25-order");
  chk("X13 이름 정확일치가 먼저", (await grep(`정산낱말`)).n[0] === "정산낱말");
  chk("X13 names 모드도 같다", (await grep(`정산낱말 환급낱말`, { mode: "names" })).n[1] === `${T}-g-old`);

  // ── X14 ──
  const r14 = await grep(`정산낱말|환급낱말`);
  chk("X14 정규식 맞춤 + BM25 순", r14.n.includes(`${T}-g-one`) && r14.route === "bm25-order", JSON.stringify(r14.n));

  // ── X15 ──
  const r15 = await grep(`정산낱말 환급낱말`, { plain: true });
  chk("X15 plain — BM25 를 안 탄다(최신순)", r15.route === "grep" && r15.n.indexOf(`${T}-g-new`) < r15.n.indexOf(`${T}-g-old`), JSON.stringify(r15.n));
  const r15b = await search(`제외낱말`, { includeUnsearchable: true });
  chk("X15 검색 제외 포함 찾기 — 색인에 없어도 글자로 찾는다", r15b.n.includes(`${T}-unsearch`) && r15b.route !== "lexical", JSON.stringify([r15b.route, r15b.n]));

  // ── X16 ──
  await save(`${T}-private`, "멤버 전용", `비공개낱말 src/secret/private_file.ts`);
  await q(`UPDATE knowledge SET visibility='members' WHERE name=$1`, [`${T}-private`]);
  await sweep();
  const stranger = "pgt-stranger";
  chk("X16 낱말 채널 — 다른 사람에게 안 나온다", !(await search(`private_file.ts`, {}, stranger)).n.includes(`${T}-private`));
  chk("X16 하이브리드 — 다른 사람에게 안 나온다", !(await search(`비공개낱말 문장으로 찾기`, {}, stranger)).n.includes(`${T}-private`));
  chk("X16 grep — 다른 사람에게 안 나온다", !(await grep(`비공개낱말`, {}, stranger)).n.includes(`${T}-private`));
  chk("X16 특권 신원에게는 나온다(양성 대조)", (await search(`private_file.ts`, {}, null)).n.includes(`${T}-private`));

  // ── X17 ──
  await save(`${T}-always`, "항상 주입", `거르기낱말`, { injection: "always" });
  await save(`${T}-recalled`, "소환", `거르기낱말`);
  const CK = `zlcat${T}`;
  const cat = Number((await q(`INSERT INTO category(key, name) VALUES($1,$1) RETURNING id`, [CK]))[0].id);
  await save(`${T}-incat`, "카테고리 안", `거르기낱말`, { category: CK });
  await sweep();
  chk("X17 양성 대조 — 거르지 않으면 셋 다", (await search(`거르기낱말`)).n.length >= 3);
  const only = await search(`거르기낱말`, { injection: "always" });
  chk("X17 injection", only.n.includes(`${T}-always`) && !only.n.includes(`${T}-recalled`), JSON.stringify(only.n));
  const inCat = await search(`거르기낱말`, { categories: [cat] });
  chk("X17 category", inCat.n.length === 1 && inCat.n[0] === `${T}-incat`, JSON.stringify(inCat.n));
  chk("X17 provenance", (await search(`거르기낱말`, { provenance: "observed" })).n.length === 0);

  // ── X18 ──
  const other = "11111111-1111-1111-1111-111111111111";
  const seen = await withTx(async (c) => {
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [other]);
    const p = [];
    return (await c.query(`WITH ${lx.bm25Sql(lx.lexQueryTerms(`거르기낱말`), p, "TRUE")} SELECT (SELECT count(*) FROM bm)::int AS hit, (SELECT n FROM ls) AS n FROM ls LIMIT 1`, p)).rows[0];
  });
  chk("X18 다른 워크스페이스 값이면 낱말 행도 통계도 안 보인다", Number(seen.hit) === 0 && Number(seen.n) === 0, JSON.stringify(seen));

  // ── X19 ──
  await save(`${T}-snip`, "스니펫 문서", `첫 줄은 상관없다\n\n둘째 줄도 상관없다\n\n환불정책을 고쳤다\n`);
  await sweep();
  const r19 = await search(`환불정책이 뭐야`);
  const snip = r19.rows.find((r) => r.name === `${T}-snip`)?.snippet ?? "";
  chk("X19 조사를 뗀 꼴로 줄을 찾는다", snip.includes("L5:"), snip);

  // ── X20 ──
  await save(`${T}-race`, "동시", `동시낱말 ${"가나다 ".repeat(100)}`);
  await Promise.all(Array.from({ length: 6 }, () => ls.syncKnowledgeLex(`${T}-race`)));
  const want = new Set(lx.lexTokens(lx.lexDocText({ name: `${T}-race`, title: "동시", body_md: `동시낱말 ${"가나다 ".repeat(100)}` }))).size;
  chk("X20 동시 맞춤 — 낱말 행이 어긋나지 않는다", (await posts(`${T}-race`)) === want, `${await posts(`${T}-race`)} vs ${want}`);

  // ── X21 ──
  await search(`zqv 다시 찾기`);
  const c = await itemsPool.connect();
  try {
    await c.query(`SELECT '[1,2,3]'::vector`);   // pgvector 를 올려 둔다
    const v = (await c.query(`SHOW hnsw.ef_search`)).rows[0]["hnsw.ef_search"];
    chk("X21 벡터 탐색 폭이 연결에 남지 않는다", v === "40", String(v));
  } finally { c.release(); }

  // ── X22 ──
  await q(`DELETE FROM knowledge_search_log`);
  const dana = { userId: "pgt-dana", email: "d@x", scopes: ["memory"], projects: ["*"] };
  const mcp = { source: "mcp", viewer: null, session: "box-pgt-1" };
  await capOf("knowledge_search").handler({ q: `임베딩 ${"긴글".repeat(200)}`, limit: 3 }, dana, mcp);
  await capOf("knowledge_grep").handler({ q: "임베딩" }, dana, mcp);
  await capOf("knowledge_grep").handler({ q: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, dana, mcp);
  await capOf("knowledge_similar").handler({ text: "zqv 글" }, dana, mcp);
  await capOf("knowledge_similar").handler({ name: `${T}-vec` }, dana, mcp);   // 이름 기준 — 남기지 않는다
  await capOf("knowledge_get").handler({ name: `${T}-rare` }, dana, mcp);
  await capOf("knowledge_search").handler({ q: "웹화면" }, dana, { source: "web", viewer: null });              // 세션 아님 — 남기지 않는다
  await capOf("knowledge_get").handler({ name: `${T}-rare` }, dana, { source: "web", viewer: null });
  await capOf("knowledge_search").handler({ q: "앱토큰" }, { ...dana, appId: "app-x" }, mcp);                     // 앱 — 남기지 않는다
  for (let i = 0; i < 100 && (await q(`SELECT 1 FROM knowledge_search_log`)).length < 5; i++) await sleep(10);
  await sleep(50);   // 남기면 안 되는 줄이 늦게 오는지까지 본다
  const logs = await q(`SELECT * FROM knowledge_search_log ORDER BY id`);
  chk("X22 세션 호출 다섯만 남는다", logs.length === 5 && logs.map((l) => l.tool).sort().join() === "get,grep,grep,search,similar", JSON.stringify(logs.map((l) => l.tool)));
  chk("X22 검색어의 비밀 값은 가린다", !logs.some((l) => (l.q ?? "").includes("sk-ant-api03")), JSON.stringify(logs.map((l) => l.q)));
  const ls1 = logs.find((l) => l.tool === "search");
  chk("X22 검색어 200자 · 세션 · 사람 · 길 · 건수", ls1.q.length === 200 && ls1.session_id === "box-pgt-1" && ls1.member === "pgt-dana" && !!ls1.route && ls1.n >= 0, JSON.stringify(ls1));
  chk("X22 찾은 이름이 남는다", logs.find((l) => l.tool === "grep").names.includes(`${T}-rare`));
  chk("X22 자동 소환 길(similar)은 글을 남기지 않는다", logs.find((l) => l.tool === "similar").q === null);
  chk("X22 get 은 연 지식이 남는다", logs.find((l) => l.tool === "get").names[0] === `${T}-rare`);
  await q(`UPDATE knowledge_search_log SET ts = now() - interval '91 days' WHERE tool='get'`);
  chk("X22 보존 기간 뒤 지운다", (await lg.reapKnowledgeSearchLog()) === 1 && (await q(`SELECT 1 FROM knowledge_search_log`)).length === 4);

  // ── X25 ──
  //  공개 문서 둘을 잣대로 쓴다: 숨은 문서에 첫 낱말이 많을수록(그 낱말의 무게가 줄어) 둘의 순서가 뒤집힌다.
  await save(`${T}-p`, "공개 하나", `잣대알파 잣대알파 잣대알파 잣대베타`);
  await save(`${T}-q`, "공개 둘", `잣대알파 잣대베타 잣대베타`);
  await sweep();
  const orderOf = async (who) => ({ s: (await search(`잣대알파 잣대베타 문장으로`, {}, who)).rows.filter((r) => r.name.endsWith("-p") || r.name.endsWith("-q")).map((r) => [r.name, r.score]),
    g: (await grep(`잣대알파 잣대베타`, {}, who)).n });
  const statsOf = async (who) => { const p = []; const vis = await kc.knowledgeVisWhere(who, p); return (await q(`WITH ${lx.bm25Sql(lx.lexQueryTerms(`잣대알파`), p, vis)} SELECT name, score FROM bm ORDER BY score DESC`, p)); };
  const before = await orderOf(stranger); const beforeS = await statsOf(stranger); const adminBefore = await statsOf(null);
  for (let i = 0; i < 12; i++) await save(`${T}-hid-${i}`, "숨은 문서", `잣대알파 비공개`);
  await q(`UPDATE knowledge SET visibility='members' WHERE name LIKE $1`, [`${T}-hid-%`]);
  await sweep();
  const after = await orderOf(stranger); const afterS = await statsOf(stranger); const adminAfter = await statsOf(null);
  chk("X25 숨은 문서가 늘어도 다른 사람의 순서 · 점수가 같다(하이브리드)", JSON.stringify(before.s) === JSON.stringify(after.s), JSON.stringify([before.s, after.s]));
  chk("X25 숨은 문서가 늘어도 다른 사람의 순서가 같다(grep)", JSON.stringify(before.g) === JSON.stringify(after.g), JSON.stringify([before.g, after.g]));
  chk("X25 BM25 점수가 같다", JSON.stringify(beforeS) === JSON.stringify(afterS), JSON.stringify([beforeS, afterS]));
  chk("X25 특권 신원은 통계에 든다(양성 대조)", adminBefore[0].score !== adminAfter[0].score, JSON.stringify([adminBefore[0], adminAfter[0]]));

  // ── X26 ──
  await settled();
  const before26 = await posts(`${T}-rare`);
  await q(`UPDATE knowledge_lex_doc SET rules_version = rules_version - 1, content_hash='x' WHERE name=$1`, [`${T}-rare`]);
  await q(`DELETE FROM knowledge_lex_posting WHERE doc_id=(SELECT id FROM knowledge_lex_doc WHERE name=$1) AND term='임베딩'`, [`${T}-rare`]);
  chk("X26 판이 다르면 스윕 대상이다", (await ls.sweepKnowledgeLex()).indexed === 1);
  chk("X26 다시 만든다", (await posts(`${T}-rare`)) === before26 && Number((await docRow(`${T}-rare`)).rules_version) === lx.LEX_RULES_VERSION);

  // ── X27 ──
  await save(`${T}-fresh`, "방금 저장", `방금낱말 본문 src/fresh/just_saved.ts`);
  let found = false;
  for (let i = 0; i < 100 && !found; i++) { found = (await search(`just_saved.ts`)).n.includes(`${T}-fresh`); if (!found) await sleep(10); }
  chk("X27 저장 — 스윕 없이 곧 찾힌다", found);

  // ── X28 ──
  await q(`INSERT INTO session(node_id, session_id, owner) VALUES('n1','conv-a','pgt-dana')`);
  await q(`INSERT INTO org_session_conv(box_id, conv_uuid, owner, node_id) VALUES('box-x','conv-a','pgt-dana','n1')`);
  await lg.logKnowledgeSearch({ tool: "search", member: "pgt-dana", session: "box-x", q: "지울 검색어", names: [] });
  await lg.logKnowledgeSearch({ tool: "search", member: "pgt-dana", session: "box-y", q: "남을 검색어", names: [] });
  await sessionLog.purgeSessionLog("n1", "conv-a", "pgt-dana");
  const left = (await q(`SELECT q FROM knowledge_search_log WHERE session_id IN ('box-x','box-y')`)).map((r) => r.q);
  chk("X28 세션 완전 삭제 — 그 박스의 기록을 지운다", left.length === 1 && left[0] === "남을 검색어", JSON.stringify(left));
  await q(`UPDATE knowledge_search_log SET ts = now() - interval '10 days' WHERE session_id='box-y'`);
  await sessionLog.reapSessionLogs(30);
  chk("X28 보존기간 안의 줄은 남는다", (await q(`SELECT 1 FROM knowledge_search_log WHERE session_id='box-y'`)).length === 1);
  await sessionLog.reapSessionLogs(7);
  chk("X28 보존기간이 90일보다 짧으면 그 기간을 넘기지 않는다", (await q(`SELECT 1 FROM knowledge_search_log WHERE session_id='box-y'`)).length === 0);

  // ── X24 ──
  await q(`ALTER TABLE knowledge_lex_posting RENAME TO knowledge_lex_posting_off`);
  const r24 = await grep(`정산낱말 환급낱말`);
  await q(`ALTER TABLE knowledge_lex_posting_off RENAME TO knowledge_lex_posting`);
  chk("X24 BM25 가 실패해도 grep 은 답한다(최신순으로)", r24.route === "grep" && r24.n.length === 3, JSON.stringify([r24.route, r24.n]));

  // ── X23 ──
  for (let i = 0; i < 5; i++) await q(`INSERT INTO knowledge(name, title, body_md, updated_by) VALUES($1,'상한',$2,'x')`, [`${T}-budget-${i}`, `상한낱말 ${i}`]);
  const r23 = await ls.sweepKnowledgeLex(0);
  chk("X23 시간 상한을 넘으면 한 건 뒤 멈춘다", r23.indexed === 1, JSON.stringify(r23));
  await sweep();
  chk("X23 다음 판이 잇는다", (await dirty()) === 0);
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
