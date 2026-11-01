// 백필 CLI(#5232) PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/embedding-backfill-cli.pg-test.mjs
//
// 왜 이 계층인가: 약속이 «`.env` 로 켠 박스에서 CLI 를 돌리면 DB 의 벡터가 실제로 채워지고, 종료코드가 그 결과를 말한다» 이다 — 설정 해석 · 배치 · 시간 상한 · 쓰기가
//  한 프로세스에 묶여 있다. CLI 를 자식 프로세스로 띄우고 가짜 임베딩 서버를 앞에 둔다. 설정은 DB 가 아니라 `.env` 와 같은 환경변수로만 준다.
//
//  사양 · 엣지 표(CLI 를 처음 켠 박스 기준):
//   D1  옵션 없음 · 지식 9건 — 0 · 전부 채움 · 임베딩 요청 8건 + 1건
//   D2  긴 문서가 1.5초 걸림(숫자 설정 없는 `.env`) — 0 · 채움 (수정 전: 1초 시간 초과로 실패)
//   D3  --max-seconds=1 · 끝나기 전에 상한 도달 — 0 · 배치 경계에서 멈춤 · 말한 건수가 DB 와 같다
//   D4  상한 안에 다 끝남 — 0 · 남은 것 없음
//   D5  일시중지 상태에서 상한 도달 — 0 · 이어받지 않는다고 말한다
//   D6  배치 실패 — 1
//   D7  엔드포인트 불가용 — 2
//   D8  --max-seconds 값이 잘못됨(빈 값 · 0 · 글자 · 음수 · 공백 꼴 · 값 없음) · 모르는 옵션(오타) — 2 · 임베딩 요청 0건
//   D10 --max-seconds + --all / --model-changed — 2 · 임베딩 요청 0건
//   C2  추천(findRecommendedKnowledge) — 벡터로 찾고, 같은 글은 질의 임베딩 기억을 지난다(embedQuery)
import pg from "pg";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_backfillcli_5232";
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

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;

// ── 가짜 임베딩 서버 — 요청마다 받은 글을 남기고, 시나리오가 지연 · 상태를 정한다. ──
const DIMS = 1024;
const isHealth = (input) => input.length === 1 && input[0] === "healthcheck";
let delayOf = () => 0;
let statusOf = () => 200;
let requests = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const input = (JSON.parse(body || "{}").input ?? []).map(String);
    requests.push(input);
    setTimeout(() => {
      const status = statusOf(input);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200
        ? JSON.stringify({ data: input.map((_t, index) => ({ index, embedding: new Array(DIMS).fill(0).map((_, j) => (j === 0 ? 1 : 0)) })) })
        : JSON.stringify({ error: { message: "backend failed" } }));
    }, delayOf(input));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const docBatches = () => requests.filter((i) => !isHealth(i));

// ── `.env` 그대로의 설정 — deploy/enable-embeddings.sh 가 쓰는 네 칸뿐이다. ──
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const cli = (args = []) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/backfill-embeddings.mjs", ...args], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, ITEMS_DATABASE_URL: process.env.ITEMS_DATABASE_URL,
      EMBEDDINGS_PROVIDER: "http", EMBEDDINGS_BASE_URL: `http://127.0.0.1:${PORT}`, EMBEDDINGS_MODEL: "bge-m3", EMBEDDINGS_DIMENSIONS: String(DIMS),
    },
  });
  let out = "", err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const guard = setTimeout(() => child.kill("SIGKILL"), 45_000);
  child.on("close", (code) => { clearTimeout(guard); resolve({ code, out, err }); });
});

const ctx = { actor: "pgt-bf", source: "web" };
const HOME = "zshome";
await q(`INSERT INTO category(key, name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [HOME]);
await q(`INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING`);
let serial = 0;
/** 시나리오를 새로 시작한다 — 앞 시나리오의 문서는 대상에서 빠지고, 서버는 평소 상태로 돌아간다. */
async function scene(n, body = (i) => `본문 ${i}`) {
  await q(`UPDATE knowledge SET lifecycle='archived' WHERE lifecycle='active'`);
  await q(`UPDATE org_runtime_config SET embedding_backfill_paused=false WHERE id=1`);
  delayOf = () => 0; statusOf = () => 200; requests = [];
  for (let i = 0; i < n; i++) {
    serial++;
    await kst.upsertKnowledge({ name: `bf-${serial}`, title: `문서 ${serial}`, body_md: body(i), type: "reference", category: HOME }, ctx);
  }
}
const counts = async () => {
  const [r] = await q(`SELECT count(*) FILTER (WHERE embedding_vector IS NOT NULL)::int AS filled, count(*) FILTER (WHERE embedding_vector IS NULL)::int AS pending FROM knowledge WHERE lifecycle='active' AND searchable`);
  return r;
};

await scene(9);
{
  const r = await cli();
  const c = await counts();
  chk("D1 옵션 없음 — 0 · 전부 채움", r.code === 0 && c.filled === 9 && c.pending === 0, JSON.stringify({ code: r.code, c, err: r.err.slice(-300) }));
  chk("D1 임베딩 요청은 8건 + 1건", JSON.stringify(docBatches().map((i) => i.length)) === "[8,1]", JSON.stringify(docBatches().map((i) => i.length)));
}

await scene(1, () => "긴문서 ".repeat(200));
delayOf = (input) => (input.some((t) => t.includes("긴문서")) ? 1500 : 0);
{
  const r = await cli();
  const c = await counts();
  chk("D2 ★ 1초를 넘기는 긴 문서 — 0 · 채움", r.code === 0 && c.filled === 1, JSON.stringify({ code: r.code, c, err: r.err.slice(-300) }));
}

await scene(24);
delayOf = (input) => (isHealth(input) ? 0 : 700);
{
  const r = await cli(["--max-seconds=1"]);
  const c = await counts();
  const said = /(\d+)건 임베딩 · (\d+)건 남음/.exec(r.out);
  chk("D3 ★ 시간 상한 — 0 · 일부만 채움", r.code === 0 && c.filled > 0 && c.pending > 0, JSON.stringify({ code: r.code, c, out: r.out.slice(-200), err: r.err.slice(-300) }));
  chk("D3 배치 경계에서 멈춘다", c.filled % 8 === 0, JSON.stringify(c));
  chk("D3 말한 건수가 DB 와 같다", said && Number(said[1]) === c.filled && Number(said[2]) === c.pending, `${said?.[0]} · ${JSON.stringify(c)}`);
  chk("D3 남은 것을 게이트웨이가 잇는다고 말한다", /게이트웨이/.test(r.out), r.out.slice(-200));
}

await scene(3);
{
  const r = await cli(["--max-seconds=60"]);
  const c = await counts();
  chk("D4 상한 안에 끝남 — 0 · 남은 것 없음", r.code === 0 && c.pending === 0 && !/남음/.test(r.out), JSON.stringify({ code: r.code, c, out: r.out.slice(-200) }));
}

await scene(24);
delayOf = (input) => (isHealth(input) ? 0 : 700);
await q(`UPDATE org_runtime_config SET embedding_backfill_paused=true WHERE id=1`);
{
  const r = await cli(["--max-seconds=1"]);
  const c = await counts();
  chk("D5 일시중지 — 0 · 이어받지 않는다고 말한다", r.code === 0 && c.pending > 0 && /채워지지 않습니다/.test(r.out) && !/이어서 채웁니다/.test(r.out), JSON.stringify({ code: r.code, c, out: r.out.slice(-200) }));
}

await scene(2);
statusOf = (input) => (isHealth(input) ? 200 : 500);
{
  const r = await cli();
  chk("D6 배치 실패 — 1", r.code === 1, JSON.stringify({ code: r.code, err: r.err.slice(-200) }));
  chk("D6 배선 — 배치를 실제로 보냈다", docBatches().length > 0);
}

await scene(2);
statusOf = () => 404;
{
  const r = await cli();
  chk("D7 불가용 — 2", r.code === 2, JSON.stringify({ code: r.code, err: r.err.slice(-200) }));
  chk("D7 문서는 보내지 않는다", docBatches().length === 0);
}

await scene(1);
for (const bad of [["--max-seconds="], ["--max-seconds=0"], ["--max-seconds=abc"], ["--max-seconds=-1"], ["--max-seconds"], ["--max-seconds", "300"], ["--max-second=300"]]) {
  requests = [];
  const r = await cli(bad);
  chk(`D8 ${bad.join(" ")} — 2 · 요청 0건`, r.code === 2 && requests.length === 0, JSON.stringify({ code: r.code, n: requests.length, err: r.err.slice(-200) }));
}
for (const mode of ["--all", "--model-changed"]) {
  requests = [];
  const r = await cli(["--max-seconds=5", mode]);
  chk(`D10 --max-seconds + ${mode} — 2 · 요청 0건`, r.code === 2 && requests.length === 0, JSON.stringify({ code: r.code, n: requests.length, err: r.err.slice(-200) }));
}

await scene(3);
await cli();
requests = [];
await q(`UPDATE org_runtime_config SET embedding_config=$1::jsonb WHERE id=1`, [JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${PORT}`, model: "bge-m3", dimensions: DIMS, send_dimensions: false, request_timeout_ms: 5000, batch_size: 8 })]);
{
  const first = await kst.findRecommendedKnowledge({ text: "추천 질의", limit: 5 });
  const second = await kst.findRecommendedKnowledge({ text: "추천 질의", limit: 5 });
  chk("C2 추천 — 벡터로 찾는다", first.length === 3 && second.length === 3, JSON.stringify({ first: first.length, second: second.length }));
  chk("C2 ★ 같은 글은 질의 임베딩 기억을 지난다(요청 1건)", requests.filter((i) => i[0] === "추천 질의").length === 1, JSON.stringify(requests));
}

server.closeAllConnections(); server.close();
await itemsPool.end().catch(() => {});
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
await su.end();
console.log(`\n${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);
