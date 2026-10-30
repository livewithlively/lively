// 지식 «검색 제외»(#5169 · 이슈 #1619) PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/knowledge-searchable.pg-test.mjs
//
// 왜 이 계층인가: 검색 제외는 전부 SQL 술어와 임베딩 스윕의 대상 조건이다 — 렉시컬·벡터 두 채널, 벡터 없이 카테고리로 고르는 추천(구제),
//  «최신 순» 으로 고르는 도메인 소환의 대표 지식, 스윕이 행을 고른 뒤 벡터를 쓰기까지의 틈. 실제 행과 실제 pgvector 거리에서만 드러난다.
//  벡터는 가짜 임베딩 서버(이 파일 안의 HTTP — OpenAI 호환 /v1/embeddings)가 글에 든 표지로 정한다.
//
//  사양 · 엣지 표(이슈 #1619 완료 기준 + 열린 질문 결정 — 에이전트의 grep 은 빼고, 사람 화면(⌘K · 링크 고르기)은 표시를 달아 남긴다 · 상민님 2026-10-30):
//   E1  grep — 같은 낱말이 든 검색 대상 A 와 검색 제외 B: A 만 나온다(전제: B 를 검색 대상으로 돌리면 B 도 나온다 — E13)
//   E2  grep 건수 — A 만 센다(E13 뒤엔 둘)
//   E3  하이브리드(knowledge_search) 렉시컬 채널 — B 0건
//   E4  하이브리드 벡터 채널 — B 에 질의와 가장 가까운 «남은 벡터» 를 심어도 B 0건 · 벡터로 가까운 검색 대상 C 는 나온다
//   E5  유사(text) — 남은 벡터가 있어도 B 0건 · 유사(name=B) 는 벡터를 비운 뒤 빈 결과
//   E6  추천 — B 가 같은 카테고리(벡터 없이 고르는 구제 경로)여도 B 0건 · 같은 카테고리의 검색 대상은 나온다
//   E7  도메인 소환 대표 지식(hub) — B 가 그 카테고리에서 가장 최근 수정이어도 hub 에 없다 · 검색 대상은 있다
//   E8  knowledge_get(B) — 그대로 읽힌다(searchable:false) · 카테고리 목록에 나온다
//   E9  목록 거르기 — searchable=false 면 B 만 · true 면 B 없음
//   E10 스윕(pending) — B 는 벡터 없이 남고 A 는 채워진다
//   E11 벡터 있던 검색 대상 C 를 끈다 — 벡터 비워짐 · 감사 set_searchable 1건 · changed:true
//   E12 같은 값으로 다시 끈다 — changed:false · 갱신 시각 그대로 · 감사 늘지 않음 / 같은 값이어도 남은 벡터는 비운다(B)
//   E13 다시 켠다 — 임베딩 대상 수 +1 → 스윕이 채움 → 검색에 다시 나온다
//   E14 저장 때 searchable:false 로 신규(도구 길 knowledge_save) — 처음부터 대상 아님(대상 수 그대로 · 스윕 뒤 벡터 없음 · 검색 0)
//   E15 searchable 없이 다시 저장(본문 바뀜) — false 가 유지되고 벡터 없음
//   E16 경합 — 스윕이 임베딩하는 사이 검색 제외로 바뀌면 스윕 뒤에도 그 문서에 벡터 없음
//   E17 REST 파서 — knowledge_save searchable 문자열 = 400 · 불리언 통과 / set_searchable 누락·문자열 = 400 · 불리언 통과 · 목록 ?searchable=false
//   E18 없는 이름 토글 = 404
//   E19 경계 — 칸을 안 실은 신규 저장은 검색 대상(true)
//   E20 되돌리기(content_undo) — set_searchable 을 되돌리면 이전 값
//   E21 벡터가 있는 검색 대상을 저장(knowledge_save 길)으로 끈다 — 표시 false · 벡터 비워짐
//   E22 지우고 휴지통에서 되살려도 검색 제외가 남는다
//   E23 검색 제외에 벡터가 남아 있으면(끌 때 비우기 실패) — 유사의 기준이 안 되고(빈 결과) 스윕이 걷는다 · c 자동 스윕도(pending 0 이어도)
//   E16b all 모드(전량 재임베딩) — 배치 도중 대상에서 빠진 행 때문에 뒤 행을 건너뛰지 않는다(done = 다음 배치 OFFSET)
//   (E11 에 덧붙임) 소환 설정 토글은 갱신 시각을 안 올린다(props_ui 토글과 같은 까닭)
//   E24 사람 화면 — REST 전용 인자가 있을 때만 검색 제외도 글자로 찾는다(grep · 건수 · 하이브리드 렉시컬) · 행에 표시 · 같은 급이면 검색 대상 먼저 ·
//       벡터 채널은 그대로 뺀다 · 인자 없는 호출의 응답 모양은 그대로 · MCP 길(zod)은 인자를 버린다
import pg from "pg";
import http from "node:http";
import { z } from "zod";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_searchable_5169";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");   // 벡터 채널 시험이라 pgvector 필수(없으면 여기서 실패 — 폴백하지 않는다)
await dbc.end();
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER"]) delete process.env[k];
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const ks = await import(`${D}/v6/knowledge-search.js`);
const kst = await import(`${D}/v6/knowledge-store.js`);
const eb = await import(`${D}/v6/embedding-backfill.js`);
const { routeRecall } = await import(`${D}/v6/recall-router.js`);
const { __resetQueryEmbedCache } = await import(`${D}/v6/search-util.js`);
const { authoringCapabilities } = await import(`${D}/capabilities/knowledge/authoring.js`);
const { readStaticCapabilities } = await import(`${D}/capabilities/knowledge/read.js`);
const { undoCapabilities } = await import(`${D}/capabilities/undo.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const thrown = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const capOf = (arr, n) => arr.find((c) => c.name === n);
const names = (rows) => rows.map((r) => r.name);
const hasVec = async (name) => (await q(`SELECT embedding_vector IS NOT NULL AS v FROM knowledge WHERE name=$1`, [name]))[0]?.v === true;
const flagOf = async (name) => (await q(`SELECT searchable FROM knowledge WHERE name=$1`, [name]))[0]?.searchable;
const auditCount = async (name, op) => Number((await q(
  `SELECT count(*)::int AS n FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op=$2`, [name, op]))[0].n);

// ── 가짜 임베딩 서버 — 표지로 벡터를 정한다. «zqv» = 질의 벡터 basis(0) · «zqrace» = 임베딩 도중 그 문서를 검색 제외로 바꾼다(E16) ──
const dimRow = (await q(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid='knowledge'::regclass AND attname='embedding_vector'`))[0];
const DIMS = Number(dimRow?.d) > 0 ? Number(dimRow.d) : 1024;
const basis = (i) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const mix = (a, i, b, j) => Array.from({ length: DIMS }, (_, k) => (k === i ? a : k === j ? b : 0));
const lit = (v) => "[" + v.join(",") + "]";
let raceHook = null;          // E16 — 표지가 든 글을 받으면 응답 전에 한 번 부른다
let raceFired = 0;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const input = (JSON.parse(body || "{}").input ?? []);
    if (raceHook && input.some((t) => /zqrace/.test(String(t)))) { const h = raceHook; raceHook = null; raceFired++; await h(); }
    const data = input.map((t, index) => ({ index, embedding: /zqv/.test(String(t)) ? basis(0) : basis(7) }));
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
await q(`INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING`);
await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`,
  [JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${PORT}`, model: "fake", dimensions: DIMS, send_dimensions: false, request_timeout_ms: 5000 })]);
//  저장이 깨우는 자동 스윕(nudge — 1초 뒤)은 멈춰 둔다 — 이 시험은 스윕을 직접 부르는 시점에만 벡터가 생겨야 «무엇이 채웠나» 를 가를 수 있다.
await q(`UPDATE org_runtime_config SET embedding_backfill_paused=true WHERE id=1`);
const sweep = async () => { const r = await eb.runEmbeddingBackfill({ mode: "pending" }); if (!r.ok) throw new Error(`스윕 실패: ${r.reason}`); return r; };
const targetTotal = async () => (await eb.countEmbeddingBacklog(eb.KNOWLEDGE_TARGET)).total;

// ── 데이터 ──
const TAG = "zs" + Math.floor(Math.random() * 1e6);
const VIEWER = "pgt-dana";
const CK = `zqhub${TAG}`;                         // 카테고리 key — 도메인 소환이 프롬프트 낱말로 고른다(E7)
const catId = Number((await q(`INSERT INTO category(key, name) VALUES($1,$1) RETURNING id`, [CK]))[0].id);
const LEX = `zqlex${TAG}`;                        // 렉시컬 낱말(질의 벡터는 basis(7) — 문서 벡터와 멀다)
const VQ = `zqv ${TAG} 환불 규정`;                 // 벡터 질의(basis(0)) — 어느 문서에도 이 낱말들이 함께 있지 않다(렉시컬 0건)
const A = `${TAG}-a`, B = `${TAG}-b`, C = `${TAG}-c`;
const ctx = { actor: VIEWER, source: "web" };
await kst.upsertKnowledge({ name: A, title: "정책 A", body_md: `검색 대상 본문 ${LEX}`, type: "reference", category: CK }, ctx);
await kst.upsertKnowledge({ name: B, title: "재집계 B", body_md: `같은 사실을 다시 모은 본문 ${LEX}`, type: "reference", category: CK, searchable: false }, ctx);
await kst.upsertKnowledge({ name: C, title: "벡터 C", body_md: "벡터로만 찾힌다", type: "reference", category: CK }, ctx);
//  E7 — B 가 그 카테고리에서 가장 최근(대표 지식은 핀 → 최신 순). A·C 는 옛것.
await q(`UPDATE knowledge SET updated_at=$2 WHERE name=$1`, [A, "2026-01-01T00:00:00Z"]);
await q(`UPDATE knowledge SET updated_at=$2 WHERE name=$1`, [C, "2026-02-01T00:00:00Z"]);
await q(`UPDATE knowledge SET updated_at=$2 WHERE name=$1`, [B, "2026-10-30T00:00:00Z"]);

const save = capOf(authoringCapabilities, "knowledge_save");
const setS = capOf(authoringCapabilities, "knowledge_set_searchable");
const list = capOf(readStaticCapabilities, "knowledge_list");
const undo = capOf(undoCapabilities, "content_undo");
const dana = { userId: VIEWER, email: "d@x", scopes: ["memory"], projects: ["*"] };

try {
  chk("배선: 새 도구 knowledge_set_searchable 이 등록돼 있다", !!setS && !!save && !!list && !!undo);
  // ── E19 · E14(저장소 길) ──
  chk("E19 칸을 안 실은 신규 저장 = 검색 대상", (await flagOf(A)) === true && (await flagOf(C)) === true);
  chk("E14 searchable:false 로 신규 저장 = 검색 제외", (await flagOf(B)) === false);

  // ── E10 스윕: B 는 벡터 없이 남고 A·C 는 채워진다 ──
  await sweep();
  chk("E10 스윕 뒤 검색 대상 A 는 벡터가 있다(배선 — 스윕이 실제로 돌았다)", await hasVec(A));
  chk("E10 스윕 뒤 검색 제외 B 는 벡터가 없다", !(await hasVec(B)));

  // ── E1 · E2 · E3 렉시컬 ──
  __resetQueryEmbedCache();
  const g = await ks.searchKnowledge(LEX, { limit: 20 }, VIEWER);
  chk("E1 grep: 검색 대상 A 는 나온다(배선)", names(g).includes(A), JSON.stringify(names(g)));
  chk("E1 grep: 검색 제외 B 는 안 나온다", !names(g).includes(B), JSON.stringify(names(g)));
  chk("E2 grep 건수: A 만 센다", (await ks.countKnowledgeGrep(LEX, {}, VIEWER)) === 1);
  const gn = await ks.searchKnowledge(LEX, { limit: 20, mode: "names", plain: true }, VIEWER);   // ⌘K 가 쓰는 꼴(plain)
  chk("E1 grep(plain · names · 인자 없음): B 안 나온다", names(gn).includes(A) && !names(gn).includes(B), JSON.stringify(names(gn)));
  __resetQueryEmbedCache();
  const h = await ks.hybridSearchKnowledge(LEX, { limit: 20 }, VIEWER);
  chk("E3 하이브리드 렉시컬: A 는 나오고 B 는 안 나온다", names(h).includes(A) && !names(h).includes(B), JSON.stringify(names(h)));

  // ── E24 사람 화면(⌘K · 링크 고르기) — 인자가 있을 때만 검색 제외도 글자로 찾는다 ──
  const humanOpts = { limit: 20, includeUnsearchable: true };
  const gh = await ks.searchKnowledge(LEX, { ...humanOpts, plain: true }, VIEWER);
  const rowB = gh.find((r) => r.name === B), rowA = gh.find((r) => r.name === A);
  chk("E24 사람 화면 grep: B 가 나오고 표시 false · A 는 표시 true", rowB?.searchable === false && rowA?.searchable === true, JSON.stringify(gh.map((r) => [r.name, r.searchable])));
  chk("E24 순위: 같은 급이면 검색 대상 A 가 먼저(B 가 더 최근이어도)", names(gh).indexOf(A) < names(gh).indexOf(B), JSON.stringify(names(gh)));
  chk("E24 인자 없는 호출의 행에는 표시 칸이 없다(에이전트 응답 모양 그대로)", g.length > 0 && !("searchable" in g[0]), JSON.stringify(Object.keys(g[0] ?? {})));
  chk("E24 사람 화면 건수: A·B 둘", (await ks.countKnowledgeGrep(LEX, { includeUnsearchable: true, plain: true }, VIEWER)) === 2);
  __resetQueryEmbedCache();
  const hh = await ks.hybridSearchKnowledge(LEX, humanOpts, VIEWER);
  chk("E24 사람 화면 하이브리드(렉시컬): B 가 표시를 달고 나온다", hh.find((r) => r.name === B)?.searchable === false, JSON.stringify(hh.map((r) => [r.name, r.searchable])));
  const grepCap = capOf(readStaticCapabilities, "knowledge_grep"), searchCap = capOf(readStaticCapabilities, "knowledge_search");
  const humanCtx = { source: "web", actor: VIEWER, viewer: VIEWER }, mcpCtx = { source: "mcp", actor: VIEWER, viewer: VIEWER };
  const grepRest = (query) => grepCap.expose.rest[0].parse({ query, params: {} }), searchRest = (query) => searchCap.expose.rest[0].parse({ query, params: {} });
  chk("E24 REST grep: 인자를 실으면 B 가 나온다", names((await grepCap.handler(grepRest({ q: LEX, plain: "1", include_unsearchable: "1" }), dana, humanCtx)).entries).includes(B));
  chk("E24 REST grep 건수도 같다", (await grepCap.handler(grepRest({ q: LEX, plain: "1", mode: "count", include_unsearchable: "1" }), dana, humanCtx)).total === 2);
  chk("E24 REST grep: 인자가 없으면 B 없음 · =0 도 없음",
    !names((await grepCap.handler(grepRest({ q: LEX }), dana, humanCtx)).entries).includes(B)
    && !names((await grepCap.handler(grepRest({ q: LEX, include_unsearchable: "0" }), dana, humanCtx)).entries).includes(B));
  __resetQueryEmbedCache();
  chk("E24 REST 하이브리드: 인자를 실으면 B 가 나온다", names((await searchCap.handler(searchRest({ q: LEX, include_unsearchable: "1" }), dana, humanCtx)).entries).includes(B));
  //  MCP 와 앱 도구 다리(app-tool-call)는 핸들러 앞에서 zod 로 거른다 — 에이전트 도구에는 이 길이 없다.
  const viaMcpGrep = z.object(grepCap.input).parse({ q: LEX, include_unsearchable: true });
  const viaMcpSearch = z.object(searchCap.input).parse({ q: LEX, include_unsearchable: true });
  chk("E24 MCP 길: zod 가 인자를 버린다", !("include_unsearchable" in viaMcpGrep) && !("include_unsearchable" in viaMcpSearch));
  chk("E24 MCP 길 grep: 인자를 실어도 B 없음", !names((await grepCap.handler(viaMcpGrep, dana, mcpCtx)).entries).includes(B));
  __resetQueryEmbedCache();
  chk("E24 MCP 길 하이브리드: 인자를 실어도 B 없음", !names((await searchCap.handler(viaMcpSearch, dana, mcpCtx)).entries).includes(B));

  // ── E4 · E5 벡터: B 에 질의와 똑같은 «남은 벡터» 를 심는다(벡터 유무가 아니라 표시로 가르는지) ──
  await q(`UPDATE knowledge SET embedding_vector=$2::vector WHERE name=$1`, [B, lit(basis(0))]);
  await q(`UPDATE knowledge SET embedding_vector=$2::vector WHERE name=$1`, [C, lit(mix(0.6, 0, 0.8, 1))]);
  __resetQueryEmbedCache();
  const hv = await ks.hybridSearchKnowledge(VQ, { limit: 20 }, VIEWER);
  chk("E4 하이브리드 벡터: 벡터로 가까운 검색 대상 C 는 나온다(배선 — 벡터 채널이 돈다)", names(hv).includes(C), JSON.stringify(names(hv)));
  chk("E4 하이브리드 벡터: 질의와 같은 벡터를 가진 검색 제외 B 는 안 나온다", !names(hv).includes(B), JSON.stringify(names(hv)));
  __resetQueryEmbedCache();
  const hvh = await ks.hybridSearchKnowledge(VQ, { limit: 20, includeUnsearchable: true }, VIEWER);
  chk("E24 사람 화면도 벡터 채널은 그대로 뺀다(남은 벡터로 B 가 안 나온다)", names(hvh).includes(C) && !names(hvh).includes(B), JSON.stringify(names(hvh)));
  __resetQueryEmbedCache();
  const sv = await ks.findSimilarKnowledge({ text: VQ, limit: 10 }, VIEWER);
  chk("E5 유사(text): C 는 나오고 B 는 안 나온다", names(sv).includes(C) && !names(sv).includes(B), JSON.stringify(sv.map((r) => [r.name, r.similarity])));

  // ── E12b 같은 값(false)으로 토글해도 남은 벡터는 비운다 → E5b 유사(name=B) 빈 결과 ──
  const sameB = await kst.setKnowledgeSearchable(B, false, ctx);
  chk("E12b 같은 값 토글 = changed:false", sameB.changed === false);
  chk("E12b 같은 값이어도 남은 벡터는 비운다", !(await hasVec(B)));
  chk("E5b 유사(name=B): 벡터가 없어 빈 결과", (await ks.findSimilarKnowledge({ name: B, limit: 10 }, VIEWER)).length === 0);

  // ── E6 추천(카테고리 구제 — 벡터 없이 고른다) ──
  const rec = await ks.findRecommendedKnowledge({ categoryIds: [catId], limit: 10 }, VIEWER);
  chk("E6 추천: 같은 카테고리의 검색 대상 A 는 나온다(배선)", names(rec).includes(A), JSON.stringify(names(rec)));
  chk("E6 추천: 같은 카테고리의 검색 제외 B 는 안 나온다", !names(rec).includes(B), JSON.stringify(names(rec)));

  // ── E7 도메인 소환 대표 지식(hub) ──
  //  프롬프트엔 이 카테고리 key 하나만 둔다 — 다른 낱말이 시드 카테고리 이름에 걸려 hub 자리(기본 2)를 먼저 차지하지 않게.
  const rr = await routeRecall({ text: CK, budget: { hubs: 5 } }, VIEWER);
  const hub = rr.hubs.find((x) => x.category_id === catId);
  chk("E7 배선: 프롬프트 낱말로 그 카테고리 hub 가 잡힌다", !!hub, JSON.stringify(rr.hubs.map((x) => x.category_key)));
  chk("E7 hub: 검색 대상 A 는 있고 가장 최근인 검색 제외 B 는 없다",
    !!hub && names(hub.index).includes(A) && !names(hub.index).includes(B), JSON.stringify(hub?.index));

  // ── E8 · E9 이름 · 목록으로는 그대로 ──
  const gotB = await kst.getKnowledge(B, VIEWER);
  chk("E8 knowledge_get(B): 그대로 읽히고 표시가 실린다", !!gotB && gotB.searchable === false && gotB.body_md.includes(LEX));
  const inCat = await kst.listKnowledge({ categoryId: catId, light: true }, VIEWER);
  chk("E8 카테고리 목록에 B 가 나온다", names(inCat).includes(B), JSON.stringify(names(inCat)));
  const onlyOff = await kst.listKnowledge({ categoryId: catId, searchable: false, light: true }, VIEWER);
  chk("E9 목록 searchable=false: B 만", JSON.stringify(names(onlyOff)) === JSON.stringify([B]), JSON.stringify(names(onlyOff)));
  const onlyOn = await kst.listKnowledge({ categoryId: catId, searchable: true, light: true }, VIEWER);
  chk("E9 목록 searchable=true: B 없고 A 있음", !names(onlyOn).includes(B) && names(onlyOn).includes(A), JSON.stringify(names(onlyOn)));
  chk("E9 총계도 같은 거르기", (await kst.countKnowledge({ categoryId: catId, searchable: false }, VIEWER)) === 1);

  // ── E15 searchable 없이 다시 저장(본문 바뀜) — false 유지 · 벡터 없음 ──
  await kst.upsertKnowledge({ name: B, body_md: `앱이 다시 그려 올린 본문 ${LEX} v2` }, ctx);
  chk("E15 칸을 안 실은 재저장 뒤에도 검색 제외", (await flagOf(B)) === false);
  await sweep();
  chk("E15 재저장 + 스윕 뒤에도 B 벡터 없음", !(await hasVec(B)));

  // ── E11 · E12 벡터 있던 검색 대상 C 를 끈다 ──
  chk("E11 전제: C 는 벡터가 있다", await hasVec(C));
  const updatedAt = async (name) => (await q(`SELECT updated_at::text AS t FROM knowledge WHERE name=$1`, [name]))[0].t;   // µs 까지(문자열)
  const at0 = await updatedAt(C);
  const offC = await kst.setKnowledgeSearchable(C, false, ctx);
  chk("E11 끄기 = changed:true · 표시 false", offC.changed === true && (await flagOf(C)) === false);
  chk("E11 소환 설정 토글은 갱신 시각을 안 올린다(최신 순 목록을 밀어올리지 않게)", (await updatedAt(C)) === at0, `${at0} → ${await updatedAt(C)}`);
  chk("E11 끄면 벡터를 비운다", !(await hasVec(C)));
  chk("E11 감사 set_searchable 1건", (await auditCount(C, "set_searchable")) === 1);
  const at1 = await updatedAt(C);
  const again = await kst.setKnowledgeSearchable(C, false, ctx);
  const at2 = await updatedAt(C);
  chk("E12 같은 값 = changed:false · 갱신 시각 그대로 · 감사 그대로",
    again.changed === false && at1 === at2 && (await auditCount(C, "set_searchable")) === 1, `${at1} → ${at2}`);

  // ── E13 다시 켠다 → 대상 수 +1 → 스윕이 채움 → 검색에 다시 나온다(E1·E2 의 전제도 여기서) ──
  const tBefore = await targetTotal();
  const onB = await kst.setKnowledgeSearchable(B, true, ctx);
  chk("E13 켜기 = changed:true", onB.changed === true && (await flagOf(B)) === true);
  chk("E13 임베딩 대상 수 +1", (await targetTotal()) === tBefore + 1, `${tBefore} → ${await targetTotal()}`);
  await sweep();
  chk("E13 스윕이 B 를 채운다", await hasVec(B));
  const g2 = await ks.searchKnowledge(LEX, { limit: 20 }, VIEWER);
  chk("E1 전제(E13): 검색 대상으로 돌린 B 는 grep 에 나온다", names(g2).includes(B), JSON.stringify(names(g2)));
  chk("E2 전제(E13): 건수 2", (await ks.countKnowledgeGrep(LEX, {}, VIEWER)) === 2);
  __resetQueryEmbedCache();
  chk("E13 B 가 하이브리드에 다시 나온다", names(await ks.hybridSearchKnowledge(LEX, { limit: 20 }, VIEWER)).includes(B));

  // ── E14(도구 길) knowledge_save 핸들러가 searchable:false 를 저장까지 싣는다 ──
  const N = `${TAG}-n`;
  const tN = await targetTotal();
  const r14 = await save.handler({ name: N, title: "색인 N", body_md: `색인 본문 ${LEX}`, type: "reference", category: CK, searchable: false },
    dana, { source: "web", actor: VIEWER, viewer: VIEWER });
  chk("E14 도구 길: 저장 응답의 지식이 검색 제외", r14?.knowledge?.searchable === false, JSON.stringify(r14?.knowledge?.searchable));
  chk("E14 도구 길: 임베딩 대상 수 그대로", (await targetTotal()) === tN);
  await sweep();
  chk("E14 도구 길: 스윕 뒤에도 벡터 없음 · grep 0", !(await hasVec(N)) && !names(await ks.searchKnowledge(LEX, { limit: 20 }, VIEWER)).includes(N));

  // ── E16 경합: 스윕이 임베딩하는 사이 검색 제외로 바뀐다 ──
  const R = `${TAG}-race`;
  await kst.upsertKnowledge({ name: R, title: "경합 R", body_md: "zqrace 임베딩 도중에 검색 제외가 된다", type: "reference", category: CK }, ctx);
  raceHook = async () => { await kst.setKnowledgeSearchable(R, false, { actor: "pgt-race", source: "web" }); };
  await sweep();
  chk("E16 배선: 임베딩 도중 훅이 실제로 불렸다", raceFired === 1, `fired=${raceFired}`);
  chk("E16 스윕 뒤 표시는 검색 제외", (await flagOf(R)) === false);
  chk("E16 스윕이 비운 뒤에 벡터를 도로 써 넣지 않았다", !(await hasVec(R)));

  // ── E17 REST 파서 ──
  const saveParse = save.expose.rest[0].parse, setParse = setS.expose.rest[0].parse, listParse = list.expose.rest[0].parse;
  const e17a = await thrown(() => saveParse({ body: { body_md: "x", searchable: "false" }, params: {}, query: {} }));
  chk("E17 knowledge_save searchable=\"false\"(문자열) = 400", e17a?.status === 400, String(e17a?.status ?? e17a));
  const ok17 = saveParse({ body: { body_md: "x", searchable: false }, params: {}, query: {} });
  chk("E17 knowledge_save searchable=false(불리언) 통과", ok17.searchable === false);
  chk("E17 knowledge_save 칸 없음 = undefined(기존값 보존)", saveParse({ body: { body_md: "x" }, params: {}, query: {} }).searchable === undefined);
  for (const [why, body] of [["누락", {}], ["문자열", { searchable: "false" }], ["숫자", { searchable: 0 }]]) {
    const e = await thrown(() => setParse({ body, params: { name: A }, query: {} }));
    chk(`E17 set_searchable ${why} = 400`, e?.status === 400, String(e?.status ?? e));
  }
  const okSet = setParse({ body: { searchable: false }, params: { name: A }, query: {} });
  chk("E17 set_searchable 불리언 통과", okSet.searchable === false && okSet.name === A);
  chk("E17 목록 ?searchable=false", listParse({ query: { searchable: "false" }, params: {} }).searchable === false);

  // ── E18 없는 이름 = 404 ──
  const e18 = await thrown(() => setS.handler({ name: `${TAG}-none`, searchable: false }, dana, { source: "web", actor: VIEWER, viewer: VIEWER }));
  chk("E18 없는 이름 토글 = 404", e18?.status === 404, String(e18?.status ?? e18));

  // ── E15b 재저장에 searchable:true 를 실으면 검색 대상으로 돌아오고(덮어쓰기) 스윕이 채운다 ──
  await kst.upsertKnowledge({ name: N, body_md: `색인 본문 ${LEX}`, searchable: true }, ctx);
  chk("E15b 명시 true 재저장 = 검색 대상", (await flagOf(N)) === true);
  await sweep();
  chk("E15b 스윕이 채우고 grep 에 나온다", (await hasVec(N)) && names(await ks.searchKnowledge(LEX, { limit: 20 }, VIEWER)).includes(N));

  // ── E20 되돌리기 — 사람(웹)이 끈 것을 content_undo 로 되돌리면 다시 검색 대상 ──
  const U = `${TAG}-undo`, UA = "pgt-undo";
  await kst.upsertKnowledge({ name: U, title: "되돌리기 U", body_md: "되돌리기 시험", type: "reference", category: CK }, { actor: "pgt-other", source: "web" });
  const offU = await setS.handler({ name: U, searchable: false }, { ...dana, userId: UA }, { source: "web", actor: UA, viewer: UA });
  chk("E20 전제: 도구로 끈다", offU?.changed === true && (await flagOf(U)) === false);
  let un = null, unErr = null;   // 되돌릴 작업을 못 찾으면 404 를 던진다 — 예외로 시험을 끊지 않고 이 행의 실패로 남긴다
  try { un = await undo.handler({ skip: [] }, { ...dana, userId: UA }, { source: "web", actor: UA, viewer: UA }); } catch (e) { unErr = e; }
  chk("E20 되돌린 작업이 set_searchable", un?.undone?.op === "set_searchable" && un?.undone?.key === U,
    unErr ? `${unErr.status ?? ""} ${unErr.message}` : JSON.stringify(un?.undone));
  chk("E20 되돌리면 다시 검색 대상", (await flagOf(U)) === true);

  // ── E21 벡터가 있는 검색 대상 A 를 저장(knowledge_save 길)으로 검색 제외 — 토글 도구를 안 거쳐도 벡터를 비운다 ──
  chk("E21 전제: A 는 벡터가 있다", await hasVec(A));
  await kst.upsertKnowledge({ name: A, body_md: `검색 대상 본문 ${LEX}`, searchable: false }, ctx);
  chk("E21 저장으로 끈 A: 표시 false · 벡터 비워짐", (await flagOf(A)) === false && !(await hasVec(A)));

  // ── E22 지우고 휴지통에서 되살려도 검색 제외가 남는다(복원은 삭제 때 스냅샷을 다시 넣는다) ──
  const Dn = `${TAG}-del`;
  await kst.upsertKnowledge({ name: Dn, title: "지울 D", body_md: "지우고 되살린다", type: "reference", category: CK, searchable: false }, ctx);
  await kst.deleteKnowledge(Dn, ctx);
  chk("E22 전제: 지워졌다", (await flagOf(Dn)) === undefined);
  const snap = (await q(`SELECT before FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='delete' ORDER BY id DESC LIMIT 1`, [Dn]))[0]?.before;
  await kst.restoreKnowledge(snap, ctx);
  chk("E22 되살린 문서도 검색 제외", (await flagOf(Dn)) === false);

  // ── E23 검색 제외에 벡터가 남아 있으면(끌 때 비우기 실패 등) — 유사의 기준이 되지 않고, 스윕이 걷는다 ──
  await q(`UPDATE knowledge SET embedding_vector=$2::vector WHERE name=$1`, [Dn, lit(basis(0))]);
  chk("E23 유사(name=남은 벡터를 가진 검색 제외) = 빈 결과", (await ks.findSimilarKnowledge({ name: Dn, limit: 10 }, VIEWER)).length === 0);
  await sweep();
  chk("E23 스윕이 검색 제외에 남은 벡터를 걷는다", !(await hasVec(Dn)));

  // ── E16b all 모드(전량 재임베딩): 배치 도중 대상에서 빠진 행 때문에 뒤 행을 건너뛰지 않는다(done = 다음 배치 OFFSET) ──
  //  배치 2 · 새 모델 «fake2» 로 전량을 다시 굽는다. 가장 최근 행 X 가 첫 배치에 들고, 임베딩 도중 검색 제외가 된다.
  const X = `${TAG}-allx`;
  await kst.upsertKnowledge({ name: X, title: "전량 X", body_md: "zqrace 전량 재임베딩 도중 빠진다", type: "reference", category: CK }, ctx);
  await q(`UPDATE knowledge SET updated_at='2030-01-01T00:00:00Z' WHERE name=$1`, [X]);   // 정렬(updated_at DESC) 맨 앞 = 첫 배치
  await q(`UPDATE org_runtime_config SET embedding_config = embedding_config || '{"batch_size": 2, "model": "fake2"}'::jsonb WHERE id=1`);
  raceHook = async () => { await kst.setKnowledgeSearchable(X, false, { actor: "pgt-race", source: "web" }); };
  const firedBefore = raceFired;
  const all = await eb.runEmbeddingBackfill({ mode: "all" });
  chk("E16b 배선: all 모드가 돌았고 임베딩 도중 훅이 불렸다", all.ok === true && raceFired === firedBefore + 1, JSON.stringify(all));
  const stale = await q(`SELECT name FROM knowledge WHERE lifecycle='active' AND searchable AND embedding_model IS DISTINCT FROM 'fake2'`);
  chk("E16b 대상 행은 하나도 건너뛰지 않고 새 모델로 다시 구워졌다", stale.length === 0, JSON.stringify(names(stale)));
  chk("E16b 도중에 빠진 X 에는 벡터가 없다", !(await hasVec(X)));

  // ── E23c 자동 스윕(10분 주기·부팅·nudge)도 걷는다 — 채울 것(pending)이 없어 백필 잡을 안 띄우는 스윕에서도 ──
  //  E16b 뒤라 대상 행은 모두 벡터가 있다(pending 0) — 그래서 이 스윕이 걷는 길은 잡이 아니라 스윕 자신이다.
  chk("E23c 전제: 채울 것이 없다", (await eb.countEmbeddingBacklog(eb.KNOWLEDGE_TARGET)).pending === 0);
  await q(`UPDATE knowledge SET embedding_vector=$2::vector WHERE name=$1`, [Dn, lit(basis(0))]);
  await q(`UPDATE org_runtime_config SET embedding_backfill_paused=false,
             embedding_config = embedding_config || '{"backfill_min_available_mb": 0}'::jsonb WHERE id=1`);
  await eb.runAutoBackfillSweep();
  await q(`UPDATE org_runtime_config SET embedding_backfill_paused=true WHERE id=1`);
  chk("E23c 자동 스윕이 검색 제외에 남은 벡터를 걷는다", !(await hasVec(Dn)));
} catch (e) {
  fail++; console.error("FAIL 예외 —", e);
} finally {
  server.close();
  await itemsPool.end().catch(() => undefined);
  if (!process.env.KEEP_TEST_DB) await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await su.end().catch(() => undefined);
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
