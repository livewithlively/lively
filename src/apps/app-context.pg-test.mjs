// 앱 맥락 범위(#5100 앱 v2-43) PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-context.pg-test.mjs
//
// 왜 이 계층인가: 범위는 전부 **SQL 의 모양**이다 — 공개범위 술어에 AND 로 붙는 카테고리 조건 · 하이브리드 검색의 두 후보 CTE · 벡터 채널의
//  «떠 두고 정확히 재기»(MATERIALIZED) · 자료 종류. 범위 밖 문서가 후보 상위 N 을 채우는 모양은 실제 행과 실제 벡터 순위에서만 드러난다.
//  벡터 채널은 가짜 임베딩 서버(이 파일 안의 HTTP — OpenAI 호환 /v1/embeddings)로 질의 벡터를 정해 실제 pgvector 거리 순서로 잰다.
//
//  사양 · 엣지 표(#5100 완료 기준 + 상민 2026-10-28 결정 ①②③):
//   E1  범위 앱 · 하이브리드 렉시컬: 범위 밖 문서 60건이 제목으로 렉시컬 후보 50을 채워도 범위 안 문서가 나오고 범위 밖 0건(전제: 범위 없으면 그 문서는 안 나온다)
//   E2  범위 앱 · 하이브리드 벡터: 범위 밖 문서 60건이 질의 벡터에 더 가까워도 범위 안 문서가 벡터로 나오고 범위 밖 0건(전제: 범위 없으면 안 나온다)
//       — 순차 스캔을 끈 DB(HNSW 계획)에서 잰다: 후보에 조건만 얹으면 근사탐색 목록(ef_search) 안에서 사후로 걸러져 비는 모양을 본다
//   E3  범위 앱 · grep(렉시컬 단독) · 목록 · 총계: 범위 밖 0건, 총계도 같은 수
//   E4  범위 앱 · knowledge_get: 범위 밖 = 403 out_of_app_context + 도구 호출 기록(REST 길) · 범위 안 = 열림 · 공개범위로 안 보이는 문서 = «없음»(범위 밖이라 말하지 않는다)
//   E5  범위 앱 · knowledge_similar: 범위 밖 문서를 기준(name)으로 = 403 · text 로 찾으면 범위 밖 0건
//   E6  범위를 선언하지 않은 앱(범위 없음) = 종전과 같다 — 같은 검색에 범위 밖 문서가 그대로 나오고 knowledge_get 도 열린다
//   E7  category 인자: grep · search · similar 가 그 카테고리 안에서만 · 없는 key 는 400 · 숫자 id 도 된다 · 범위 ∩ category = 교집합(밖이면 0건)
//       · 숫자만으로 된 key 는 key 로 찾는다(id 로 먼저 읽지 않는다) · knowledge_list 도 같은 category 인자(categoryId 를 함께 주면 categoryId)
//   E8  범위 앱 · 없는 이름 = «보인다»(새 지식 저장을 막지 않는다 — 존재 판정은 호출부)
//   E9  범위 앱 · 링크: 범위 안 문서의 링크 목록에 범위 밖 이웃이 안 실린다(종전 knowledgeVisSql 직결 자리)
//   E10 범위 앱 · 자료: 선언한 종류만 · 범위 밖 source_get = 403 + 기록 · 종류를 안 적으면 0건(닫힘)
//   E11 범위 앱 · self 소스 = 거절(이름 · 연결 표가 정책 밖이라) · 범위 없으면 종전
//   E12 매니페스트 · 저장: 없는 카테고리 key = 400 · folders = 400 · 맞는 key 는 저장된다
//   E13 어느 판(결정 ③): 공개 앱에 초안 — 고친 사람은 초안의 범위 · 다른 사람은 공개 판의 범위 · 공개 주소는 고친 사람에게도 공개 판 · 초안 주소는 초안
//   E14 어댑터 배선(runWithAppReadScope): 앱 토큰 사용자로 knowledge_search 핸들러를 부르면 그 앱의 범위로 좁혀진다 · 앱 토큰이 아니면 그대로
import "../../scripts/test-apps-root.mjs";   // #4778 앱 폴더 자리를 임시 폴더로(앱을 만들고 지우는 시험이 실제 ~/apps 를 옮기지 않게)
import pg from "pg";
import http from "node:http";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_context_5100";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
//  운영의 벡터 채널은 HNSW 근사탐색을 탄다(표가 커서 플래너가 인덱스를 고른다). 이 시험의 표는 작아서 그대로 두면 플래너가 순차 스캔 + 정렬을
//   골라 «근사탐색 사후 필터로 결과가 빈다» 는 모양 자체가 안 생긴다 — 순차 스캔을 꺼 운영과 같은 계획에서 잰다(E2 · E5b 가 그 모양을 본다).
//   순차 스캔만 끄면 플래너가 비트맵 스캔 + 정렬로 비켜 가서 정렬과 비트맵도 끈다(벌점일 뿐이라 다른 쿼리는 같은 답을 낸다 — 느려질 뿐).
for (const g of ["enable_seqscan", "enable_bitmapscan", "enable_sort"]) await su.query(`ALTER DATABASE ${DB} SET ${g} = off`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");   // 벡터 채널 시험이라 pgvector 필수(없으면 여기서 실패 — 폴백하지 않는다)
await dbc.end();
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER"]) delete process.env[k];
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const rs = await import(`${D}/v6/read-scope.js`);
const ks = await import(`${D}/v6/knowledge-search.js`);
const kst = await import(`${D}/v6/knowledge-store.js`);
const ss = await import(`${D}/v6/source-store.js`);
const vis = await import(`${D}/v6/visibility.js`);
const { __resetQueryEmbedCache } = await import(`${D}/v6/search-util.js`);
const { readStaticCapabilities, readNamedCapabilities } = await import(`${D}/capabilities/knowledge/read.js`);
const { sourceCapabilities } = await import(`${D}/capabilities/source.js`).catch(() => ({}));
const appCtx = await import(`${D}/apps/app-context.js`);
const { requireSelfSourceAllowed } = await import(`${D}/db/self/self-guard.js`);
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const capOf = (arr, n) => (arr ?? []).find((c) => c.name === n);
const kCap = (n) => capOf([...readStaticCapabilities, ...readNamedCapabilities], n);
const sCap = (n) => capOf(sourceCapabilities, n);
const aCap = (n) => capOf(appCapabilities, n);
const thrown = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 가짜 임베딩 서버 — 질의 글에 든 표지로 벡터를 정한다(문서 벡터는 아래에서 SQL 로 직접 심는다) ──
const dimRow = (await q(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid='knowledge'::regclass AND attname='embedding_vector'`))[0];
const DIMS = Number(dimRow?.d) > 0 ? Number(dimRow.d) : 1024;
const basis = (i) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const mix = (a, i, b, j) => Array.from({ length: DIMS }, (_, k) => (k === i ? a : k === j ? b : 0));
const lit = (v) => "[" + v.join(",") + "]";
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const input = (JSON.parse(body || "{}").input ?? []);
    const data = input.map((t, index) => ({ index, embedding: /zqvq/.test(String(t)) ? basis(0) : basis(7) }));
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
await q(`INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING`);
await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`,
  [JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${PORT}`, model: "fake", dimensions: DIMS, send_dimensions: false, request_timeout_ms: 5000 })]);

// ── 데이터 ──
const TAG = "zq" + Math.floor(Math.random() * 1e6);
const VIEWER = "pgt-carol";
const mkCat = async (key) => Number((await q(`INSERT INTO category(key, name) VALUES($1,$1) RETURNING id`, [key]))[0].id);
const C_IN = `${TAG}-policy`, C_OUT = `${TAG}-design`;
const idIn = await mkCat(C_IN), idOut = await mkCat(C_OUT);
const mkK = async (name, title, body, catId, opts = {}) => {
  await q(`INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source, visibility, updated_at)
           VALUES($1,$2,$3,'recalled','authored','active','ai','authored',$4,$5)`, [name, title, body, opts.visibility ?? "open", opts.at ?? "2026-09-01T00:00:00Z"]);
  if (catId) await q(`INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1,$2,'manual','confirmed')`, [name, catId]);
  if (opts.vec) await q(`UPDATE knowledge SET embedding_vector=$2::vector WHERE name=$1`, [name, lit(opts.vec)]);
};
const LEX = `zqlex${TAG}`;              // 렉시컬 낱말(질의 벡터는 basis(7) — 문서 어느 것과도 멀다)
const VQ = `zqvq ${TAG} 환불 규정`;     // 벡터 질의(표지 zqvq → basis(0)) — 본문 어디에도 이 낱말들이 없다(렉시컬 0건)
for (let i = 0; i < 60; i++) {
  //  범위 밖 문서 60건 — 제목에 렉시컬 낱말이 있고(제목 먼저 · 최신) 벡터는 질의에 거의 같다. 두 채널의 후보 50을 모두 채운다.
  //   벡터는 문서마다 조금씩 다르게 둔다 — pgvector HNSW 는 같은 벡터를 한 원소로 묶어(원소 하나에 행 여럿) ef_search 가 행 수를 못 막는다.
  await mkK(`${TAG}-out-${i}`, `${LEX} 설계 문서 ${i}`, `앱을 만드는 과정의 설계 ${i}`, idOut, { at: "2026-10-20T00:00:00Z", vec: mix(1, 0, 0.001 * (i + 1), 10 + i) });
}
await mkK(`${TAG}-in-lex`, `정책 안내`, `본문에만 ${LEX} 가 한 번 나온다`, idIn, { at: "2026-01-01T00:00:00Z", vec: basis(3) });
await mkK(`${TAG}-in-vec`, `정책 일반`, `벡터로만 찾힌다`, idIn, { at: "2026-01-01T00:00:00Z", vec: mix(0.6, 0, 0.8, 1) });
await mkK(`${TAG}-in-locked`, `잠긴 정책`, `${LEX} 잠긴 본문`, idIn, { visibility: "members" });   // 누구에게도 지정 안 됨 → 공개범위로 안 보인다
await q(`INSERT INTO knowledge_link(from_name, to_name, relation, origin) VALUES($1,$2,'related','user')`, [`${TAG}-in-lex`, `${TAG}-out-0`]);
const inScope = (name) => name.startsWith(`${TAG}-in-`);
const outCount = (rows) => rows.filter((r) => !inScope(r.name)).length;
const names = (rows) => rows.map((r) => r.name);

const SCOPE = { appId: "ctx-pol", knowledgeCategoryIds: [idIn], sourceKinds: ["slack"] };
const scoped = (fn, scope = SCOPE) => rs.withReadScope(async () => scope, fn);
const webCtx = { source: "web", actor: VIEWER, viewer: VIEWER };
const carol = { userId: VIEWER, email: "c@x", scopes: ["memory"], projects: ["*"] };

try {
  __resetQueryEmbedCache();
  // ── E1 하이브리드 · 렉시컬 채널 ──
  {
    const un = await ks.hybridSearchKnowledge(LEX, { limit: 20 }, VIEWER);
    chk("E1 전제: 범위 없으면 범위 안 문서(in-lex)가 렉시컬 후보 50 밖이라 안 나온다", !names(un).includes(`${TAG}-in-lex`) && outCount(un) > 0, JSON.stringify(names(un).slice(0, 5)));
    const sc = await scoped(() => ks.hybridSearchKnowledge(LEX, { limit: 20 }, VIEWER));
    chk("E1 범위 앱 하이브리드(렉시컬): 범위 안 문서가 나온다", names(sc).includes(`${TAG}-in-lex`), JSON.stringify(names(sc)));
    chk("E1b 범위 앱 하이브리드(렉시컬): 범위 밖 0건", outCount(sc) === 0, JSON.stringify(names(sc)));
    chk("E1c 공개범위로 안 보이는 범위 안 문서는 여전히 안 나온다", !names(sc).includes(`${TAG}-in-locked`), JSON.stringify(names(sc)));
  }
  // ── E2 하이브리드 · 벡터 채널 ──
  {
    const un = await ks.hybridSearchKnowledge(VQ, { limit: 20 }, VIEWER);
    chk("E2 전제: 범위 없으면 범위 안 문서(in-vec)가 벡터 후보 50 밖이라 안 나온다", !names(un).includes(`${TAG}-in-vec`) && outCount(un) > 0, JSON.stringify(names(un).slice(0, 5)));
    const sc = await scoped(() => ks.hybridSearchKnowledge(VQ, { limit: 20 }, VIEWER));
    chk("E2 범위 앱 하이브리드(벡터): 범위 안 문서가 벡터로 나온다", names(sc).includes(`${TAG}-in-vec`), JSON.stringify(names(sc)));
    chk("E2b 범위 앱 하이브리드(벡터): 범위 밖 0건", outCount(sc) === 0, JSON.stringify(names(sc)));
    const order = sc.map((r) => r.name);
    chk("E2c 벡터 순서가 정확하다 — 가까운 in-vec 이 먼 in-lex 보다 먼저", order.indexOf(`${TAG}-in-vec`) >= 0 && (order.indexOf(`${TAG}-in-lex`) < 0 || order.indexOf(`${TAG}-in-vec`) < order.indexOf(`${TAG}-in-lex`)), JSON.stringify(order));
  }
  // ── E3 grep · 목록 · 총계 ──
  {
    const g = await scoped(() => ks.searchKnowledge(LEX, { limit: 100 }, VIEWER));
    chk("E3 grep: 범위 밖 0건 · 범위 안 문서 있음", outCount(g) === 0 && names(g).includes(`${TAG}-in-lex`), JSON.stringify(names(g)));
    const n = await scoped(() => ks.countKnowledgeGrep(LEX, {}, VIEWER));
    chk("E3b grep 총계도 범위 기준", n === g.length, `count=${n} rows=${g.length}`);
    const list = await scoped(() => kst.listKnowledge({ q: TAG, limit: 500 }, VIEWER));
    const total = await scoped(() => kst.countKnowledge({ q: TAG }, VIEWER));
    chk("E3c 목록 · 총계: 범위 밖 0건 · 같은 수", outCount(list) === 0 && total === list.length && list.length >= 2, `list=${list.length} total=${total}`);
  }
  // ── E4 knowledge_get ──
  {
    const get = kCap("knowledge_get");
    const e = await scoped(() => thrown(() => get.handler({ name: `${TAG}-out-1` }, carol, webCtx)));
    chk("E4 범위 밖 knowledge_get = 403 out_of_app_context", e?.status === 403 && e?.body?.code === "out_of_app_context", String(e?.status) + " " + e?.message);
    let logged = [];
    for (let i = 0; i < 20 && !logged.length; i++) { await sleep(100); logged = await q(`SELECT tool, app, ok FROM mcp_call_log WHERE app=$1 AND tool='knowledge_get'`, [SCOPE.appId]); }
    chk("E4b 거절이 도구 호출 기록에 남는다(REST 길 — 앱 · 실패)", logged.length === 1 && logged[0].ok === false, JSON.stringify(logged));
    const okIn = await scoped(() => get.handler({ name: `${TAG}-in-lex` }, carol, webCtx));
    chk("E4c 범위 안 knowledge_get 은 열린다", okIn?.knowledge?.name === `${TAG}-in-lex`, JSON.stringify(okIn?.knowledge?.name));
    const locked = await scoped(() => thrown(() => get.handler({ name: `${TAG}-in-locked` }, carol, webCtx)));
    chk("E4d 공개범위로 안 보이는 문서는 «없음»(범위 밖이라 말하지 않는다)", !!locked && locked.status !== 403 && /없음/.test(locked.message), String(locked?.status) + " " + locked?.message);
    const mcpDeny = await scoped(() => thrown(() => get.handler({ name: `${TAG}-out-2` }, carol, { ...webCtx, source: "mcp" })));
    await sleep(300);
    const after = await q(`SELECT count(*)::int AS n FROM mcp_call_log WHERE app=$1 AND tool='knowledge_get'`, [SCOPE.appId]);
    chk("E4e MCP 길은 여기서 두 번 적지 않는다(instrument 가 적는다) — 403 이고 행은 그대로 1", mcpDeny?.status === 403 && after[0].n === 1, `status=${mcpDeny?.status} rows=${after[0].n}`);
  }
  // ── E5 knowledge_similar ──
  {
    const sim = kCap("knowledge_similar");
    const e = await scoped(() => thrown(() => sim.handler({ name: `${TAG}-out-3` }, carol, webCtx)));
    chk("E5 범위 밖 문서를 기준(name)으로 = 403", e?.status === 403 && e?.body?.code === "out_of_app_context", String(e?.status) + " " + e?.message);
    __resetQueryEmbedCache();
    const r = await scoped(() => sim.handler({ text: VQ, limit: 20 }, carol, webCtx));
    chk("E5b text 유사: 범위 밖 0건 · 범위 안 문서가 나온다(후보가 범위 밖으로 차도)", outCount(r.entries) === 0 && names(r.entries).includes(`${TAG}-in-vec`), JSON.stringify(names(r.entries)));
    const un = await sim.handler({ text: VQ, limit: 20 }, carol, webCtx);
    chk("E5c 전제: 범위 없으면 범위 밖 문서가 나온다", outCount(un.entries) > 0, JSON.stringify(names(un.entries).slice(0, 3)));
  }
  // ── E6 범위를 선언하지 않은 앱 = 종전 ──
  {
    const none = (fn) => rs.withReadScope(async () => null, fn);
    const a = await none(() => ks.hybridSearchKnowledge(LEX, { limit: 20 }, VIEWER));
    const b = await ks.hybridSearchKnowledge(LEX, { limit: 20 }, VIEWER);
    chk("E6 범위 없음: 하이브리드 결과가 앱 밖과 같다", JSON.stringify(names(a)) === JSON.stringify(names(b)) && outCount(a) > 0, JSON.stringify(names(a).slice(0, 3)));
    const g = await none(() => kCap("knowledge_get").handler({ name: `${TAG}-out-1` }, carol, webCtx));
    chk("E6b 범위 없음: 범위 밖이던 문서도 knowledge_get 이 열린다", g?.knowledge?.name === `${TAG}-out-1`);
  }
  // ── E7 category 인자 ──
  {
    const grep = kCap("knowledge_grep"), search = kCap("knowledge_search"), sim = kCap("knowledge_similar");
    const gIn = await grep.handler({ q: LEX, limit: 100, category: C_IN }, carol, webCtx);
    chk("E7 grep category=범위 안 key: 그 카테고리만", gIn.entries.length > 0 && outCount(gIn.entries) === 0, JSON.stringify(names(gIn.entries)));
    const gOut = await grep.handler({ q: LEX, limit: 100, category: C_OUT }, carol, webCtx);
    chk("E7b grep category=다른 key: 그 카테고리만", gOut.entries.length > 0 && gOut.entries.every((r) => !inScope(r.name)), JSON.stringify(names(gOut.entries).slice(0, 3)));
    const cnt = await grep.handler({ q: LEX, mode: "count", category: C_IN }, carol, webCtx);
    chk("E7c grep count 도 category 를 탄다", cnt.total === gIn.entries.length, JSON.stringify(cnt));
    __resetQueryEmbedCache();
    const sIn = await search.handler({ q: VQ, limit: 20, category: C_IN }, carol, webCtx);
    chk("E7d search category: 벡터로만 찾히는 범위 안 문서가 나오고 다른 카테고리 0건", names(sIn.entries).includes(`${TAG}-in-vec`) && outCount(sIn.entries) === 0, JSON.stringify(names(sIn.entries)));
    const sId = await search.handler({ q: LEX, limit: 20, category: String(idIn) }, carol, webCtx);
    chk("E7e 숫자 id 도 된다", names(sId.entries).includes(`${TAG}-in-lex`) && outCount(sId.entries) === 0, JSON.stringify(names(sId.entries)));
    const simIn = await sim.handler({ text: VQ, limit: 20, category: C_IN }, carol, webCtx);
    chk("E7f similar category: 그 카테고리만", names(simIn.entries).includes(`${TAG}-in-vec`) && outCount(simIn.entries) === 0, JSON.stringify(names(simIn.entries)));
    const bad = await thrown(() => grep.handler({ q: LEX, category: `${TAG}-nope` }, carol, webCtx));
    chk("E7g 없는 카테고리 = 400", bad?.status === 400 && /카테고리/.test(bad.message), String(bad?.status) + " " + bad?.message);
    const both = await scoped(() => grep.handler({ q: LEX, limit: 100, category: C_OUT }, carol, webCtx));
    chk("E7h 범위 ∩ category: 범위 밖 카테고리를 고르면 0건", both.entries.length === 0, JSON.stringify(names(both.entries)));
    //  숫자만으로 된 key — 그 숫자가 다른 카테고리의 id 와 같아도 key 로 찾는다(같은 숫자 id 를 가진 카테고리를 먼저 만들어 둔다).
    const numKey = String(idOut);   // 숫자 key = 범위 밖 카테고리의 id 와 같은 글
    const idNum = await mkCat(numKey);
    await mkK(`${TAG}-num-1`, `숫자 key 문서`, `${LEX} 숫자 key 본문`, idNum);
    const gNum = await grep.handler({ q: LEX, limit: 100, category: numKey }, carol, webCtx);
    chk("E7i 숫자만으로 된 key 는 key 로 찾는다(같은 숫자의 id 가 아니다)", names(gNum.entries).length === 1 && names(gNum.entries)[0] === `${TAG}-num-1`, JSON.stringify(names(gNum.entries).slice(0, 3)));
    const list = kCap("knowledge_list");
    const lIn = await list.handler({ category: C_IN, q: TAG, limit: 500 }, carol, webCtx);
    chk("E7j knowledge_list category=key: 그 카테고리만 · 총계도", lIn.entries.length >= 2 && outCount(lIn.entries) === 0 && lIn.total === lIn.entries.length, JSON.stringify({ n: lIn.entries.length, total: lIn.total }));
    const lBoth = await list.handler({ category: C_IN, categoryId: idOut, q: TAG, limit: 500 }, carol, webCtx);
    chk("E7k knowledge_list: categoryId 를 함께 주면 categoryId 가 이긴다", lBoth.entries.length > 0 && lBoth.entries.every((r) => r.category_key === C_OUT), JSON.stringify(lBoth.entries.slice(0, 2).map((r) => r.category_key)));
  }
  // ── E8 없는 이름 ──
  {
    const seen = await scoped(() => vis.canSeeKnowledge(`${TAG}-brand-new`, VIEWER));
    chk("E8 범위 앱: 없는 이름은 «보인다»(새 지식 저장을 막지 않는다)", seen === true);
    const out = await scoped(() => vis.canSeeKnowledge(`${TAG}-out-4`, VIEWER));
    chk("E8b 범위 앱: 있는 범위 밖 문서는 안 보인다", out === false);
    const priv = await scoped(() => vis.canSeeKnowledge(`${TAG}-out-4`, null));
    chk("E8c 특권 뷰어(null — 내부 경로)에는 범위를 걸지 않는다", priv === true);
  }
  // ── E9 링크 ──
  {
    const un = await kst.getKnowledge(`${TAG}-in-lex`, VIEWER);
    chk("E9 전제: 범위 없으면 링크에 범위 밖 이웃이 실린다", (un?.links?.outgoing ?? []).some((l) => l.name === `${TAG}-out-0`), JSON.stringify(un?.links));
    const sc = await scoped(() => kst.getKnowledge(`${TAG}-in-lex`, VIEWER));
    chk("E9b 범위 앱: 링크에 범위 밖 이웃이 안 실린다", !(sc?.links?.outgoing ?? []).some((l) => l.name === `${TAG}-out-0`), JSON.stringify(sc?.links));
  }
  // ── E10 자료 ──
  {
    const mkS = async (name, kind) => Number((await q(`INSERT INTO source(name, kind, title, body_md, lifecycle, occurred_at) VALUES($1,$2,$3,'본문','active',now()) RETURNING id`, [name, kind, `${TAG} ${kind}`]))[0].id);
    const sSlack = await mkS(`${TAG}-s-slack`, "slack"), sMail = await mkS(`${TAG}-s-mail`, "email");
    const lst = await scoped(() => ss.listSources({ q: TAG, limit: 50 }, VIEWER));
    const ids = lst.map((r) => Number(r.id));
    chk("E10 범위 앱 자료 목록: 선언한 종류(slack)만", ids.includes(sSlack) && !ids.includes(sMail), JSON.stringify(ids));
    const get = sCap("source_get");
    if (get) {
      const e = await scoped(() => thrown(() => get.handler({ id: sMail }, carol, webCtx)));
      chk("E10b 범위 밖 source_get = 403 out_of_app_context", e?.status === 403 && e?.body?.code === "out_of_app_context", String(e?.status) + " " + e?.message);
      let logged = [];
      for (let i = 0; i < 20 && !logged.length; i++) { await sleep(100); logged = await q(`SELECT tool FROM mcp_call_log WHERE app=$1 AND tool='source_get'`, [SCOPE.appId]); }
      chk("E10c 자료 거절도 기록된다", logged.length === 1, JSON.stringify(logged));
      const okS = await scoped(() => get.handler({ id: sSlack }, carol, webCtx));
      chk("E10d 범위 안 source_get 은 열린다", Number(okS?.source?.id) === sSlack);
    } else chk("E10b source_get 능력을 찾는다", false, "sourceCapabilities 없음");
    const closed = await scoped(() => ss.listSources({ q: TAG, limit: 50 }, VIEWER), { ...SCOPE, sourceKinds: [] });
    chk("E10e 자료 종류를 안 적으면 자료 0건(닫힘)", closed.length === 0, JSON.stringify(closed.map((r) => r.id)));
  }
  // ── E11 self 소스 ──
  {
    const e = await scoped(() => thrown(() => requireSelfSourceAllowed({ scopes: ["db"], userId: VIEWER }, "self")));
    chk("E11 범위 앱: self 소스 거절", !!e && /맥락 범위/.test(e.message), e?.message);
    const ok = await thrown(() => requireSelfSourceAllowed({ scopes: ["db"], userId: VIEWER }, "self"));
    chk("E11b 범위 없으면 self 는 종전(이 DB 엔 잠긴 맥락 판정만)", !ok || !/맥락 범위/.test(ok.message), ok?.message);
  }
  // ── E12 매니페스트 · 저장 ──
  const bob = { userId: "pgt-bob", email: "b@x", scopes: ["memory"], projects: ["*"] };
  const files = (id, context, html = "<p>x</p>") => [
    { path: "lively-app.json", content: JSON.stringify({ id, title: id, version: "1.0.0", permissions: { scopes: ["memory"], tools: ["knowledge_search", "knowledge_get"] }, ...(context === undefined ? {} : { context }), ui: { pages: [{ key: "main", title: id, entry: "ui/index.html" }] } }) },
    { path: "ui/index.html", content: html },
  ];
  {
    const save = aCap("app_save");
    const e1 = await thrown(() => save.handler({ files: files("ctx-bad", { knowledge_categories: [`${TAG}-nope`] }) }, bob, { source: "mcp" }));
    chk("E12 없는 카테고리 key = 400", e1?.status === 400 && /없는 카테고리/.test(e1.message), String(e1?.status) + " " + e1?.message);
    const e2 = await thrown(() => save.handler({ files: files("ctx-bad", { knowledge_categories: [C_IN], folders: ["shared/x"] }) }, bob, { source: "mcp" }));
    chk("E12b folders = 400(다음 판)", e2?.status === 400 && /folders/.test(e2.message), String(e2?.status) + " " + e2?.message);
    const e3 = await thrown(() => save.handler({ files: files("ctx-bad", { knowledge_category: [C_IN] }) }, bob, { source: "mcp" }));
    chk("E12c 오타 칸(knowledge_category) = 400(좁히는 선언은 모르는 칸을 버리지 않는다)", e3?.status === 400, String(e3?.status) + " " + e3?.message);
    const okSave = await save.handler({ files: files("ctx-pol", { knowledge_categories: [C_IN], source_kinds: ["slack"] }) }, bob, { source: "mcp" });
    chk("E12d 맞는 key 는 저장된다", !!okSave && !okSave.error, JSON.stringify(okSave).slice(0, 200));
  }
  // ── E13 어느 판 ──
  {
    appCtx._clearAppContextCache();
    await aCap("app_visibility_set").handler({ app_id: "ctx-pol", visibility: "all" }, bob, { source: "mcp" });
    //  공개 뒤 bob 이 다시 저장 → bob 의 초안(범위 = design 카테고리) · 공개 판은 policy 카테고리.
    await aCap("app_save").handler({ files: files("ctx-pol", { knowledge_categories: [C_OUT] }, "<p>draft</p>") }, bob, { source: "mcp" });
    const row = (await q(`SELECT draft_by, published_version_no FROM org_app WHERE id='ctx-pol'`))[0];
    chk("E13 전제: 공개 앱에 bob 의 초안이 걸려 있다", row?.draft_by === "pgt-bob" && row?.published_version_no != null, JSON.stringify(row));
    appCtx._clearAppContextCache();
    const sBob = await appCtx.resolveAppReadScope({ appId: "ctx-pol", userId: "pgt-bob", scopes: ["memory"] });
    const sCarol = await appCtx.resolveAppReadScope({ appId: "ctx-pol", userId: VIEWER, scopes: ["memory"] });
    const sPub = await appCtx.resolveAppReadScope({ appId: "ctx-pol", userId: "pgt-bob", scopes: ["memory"], appAddress: "pub" });
    const sDraft = await appCtx.resolveAppReadScope({ appId: "ctx-pol", userId: "pgt-bob", scopes: ["memory"], appAddress: "draft" });
    chk("E13b 고친 사람(앱 세션 · 작업)은 초안의 범위", JSON.stringify(sBob?.knowledgeCategoryIds) === JSON.stringify([idOut]), JSON.stringify(sBob));
    chk("E13c 다른 사람은 공개 판의 범위", JSON.stringify(sCarol?.knowledgeCategoryIds) === JSON.stringify([idIn]) && JSON.stringify(sCarol?.sourceKinds) === JSON.stringify(["slack"]), JSON.stringify(sCarol));
    chk("E13d 공개 주소는 고친 사람에게도 공개 판의 범위", JSON.stringify(sPub?.knowledgeCategoryIds) === JSON.stringify([idIn]), JSON.stringify(sPub));
    chk("E13e 초안 주소는 초안의 범위", JSON.stringify(sDraft?.knowledgeCategoryIds) === JSON.stringify([idOut]), JSON.stringify(sDraft));
    await aCap("app_save").handler({ files: files("ctx-none", undefined) }, bob, { source: "mcp" });
    const sNone = await appCtx.resolveAppReadScope({ appId: "ctx-none", userId: "pgt-bob", scopes: ["memory"] });
    chk("E13f 범위를 선언하지 않은 앱 = null(종전)", sNone === null, JSON.stringify(sNone));
    const notApp = await appCtx.resolveAppReadScope({ userId: VIEWER, scopes: ["memory"] });
    chk("E13g 앱 토큰이 아니면 null", notApp === null);
  }
  // ── E14 어댑터 배선(runWithAppReadScope) ──
  {
    appCtx._clearAppContextCache();
    const search = kCap("knowledge_search");
    const appUser = { ...carol, appId: "ctx-pol" };   // carol 은 공개 판(policy) 범위
    __resetQueryEmbedCache();
    const viaApp = await appCtx.runWithAppReadScope(appUser, () => search.handler({ q: LEX, limit: 20 }, appUser, webCtx));
    chk("E14 앱 토큰 사용자: knowledge_search 가 그 앱의 범위로(범위 밖 0건 · 범위 안 문서 있음)", outCount(viaApp.entries) === 0 && names(viaApp.entries).includes(`${TAG}-in-lex`), JSON.stringify(names(viaApp.entries)));
    const plain = await appCtx.runWithAppReadScope(carol, () => search.handler({ q: LEX, limit: 20 }, carol, webCtx));
    chk("E14b 앱 토큰이 아니면 그대로(범위 밖 문서가 나온다)", outCount(plain.entries) > 0);
    const noneUser = { ...carol, appId: "ctx-none" };
    const viaNone = await appCtx.runWithAppReadScope(noneUser, () => search.handler({ q: LEX, limit: 20 }, noneUser, webCtx));
    chk("E14c 범위를 선언하지 않은 앱 토큰도 그대로", JSON.stringify(names(viaNone.entries)) === JSON.stringify(names(plain.entries)));
  }
} catch (e) {
  fail++; console.error("FAIL 예외 —", e && e.stack || String(e));
} finally {
  server.close();
  await itemsPool.end().catch(() => undefined);
  if (!process.env.KEEP_TEST_DB) await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);   // KEEP_TEST_DB=1 — 계획을 들여다볼 때
  await su.end();
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
