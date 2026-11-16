// 외부 좌표 지식 미러의 «무변경 재싱크»(#1667) PG 통합 테스트 — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서(스키마 체인 스텝 뒤), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/v6/mirror/resync-noop.pg-test.mjs
//
//  왜 이 계층인가: 판정(resync-noop.ts isNoopResync)은 순수 함수라 유닛 시험이 있다. 그러나 그 판정이 보는 값은 pg 가
//   돌려준 행(jsonb 는 객체 · timestamptz 는 Date)이고, 무변경일 때 고치는 칸(last_synced_at · sync_state)과 안 고치는 칸
//   (version · updated_at)은 SQL 이 정한다. 무변경으로 잘못 보면 원본 변경이 조용히 버려지고, 놓치면 전량 재인입 커넥터가
//   주기마다 수천 행의 판을 올린다 — 행을 깔고 mirrorKnowledgeV6 를 부른 뒤 다시 읽는다.
//  모든 행은 이 시험만의 external_system(`__rnpg__`)에 둔다.
//
//  사양 엣지 표(행마다 단언):
//   D1 같은 항목 재싱크 → true · 판 · updated_at 그대로 · last_synced_at 늘어남 · 수집기 표식 · 감사 0
//   D2 다른 수집기 표식으로 재싱크 → 표식 둘 · 판 그대로
//   D3 fields · raw 키 순서만 · occurred_at 같은 순간 다른 표기 → 판 그대로
//   D4 fields 배열 순서 바뀜 → 판 +1 · 감사 0(제목 · 본문 같음)
//   D5 본문 바뀜 → 판 +1 · 임베딩 리셋 · 감사 +1
//   D6 provenance 를 누가 authored 로 바꿔 둠 → 재싱크가 observed 로 되돌림 · 판 +1
//   D7 sort 미지정(DB 값과 다름) → 그대로 · 같은 값 → 그대로 · 다른 값 → +1
//   D8 원본 보관 → archived · +1 → 다시 나타남 → active · +1
//   D9 pending(검토 대기) 행의 무변경 재싱크 → pending 유지 · 판 그대로
//   D10 external_url · occurred_at · 부모 변경 → 각각 +1
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { mirrorKnowledgeV6 } = await import(`${DIST}/v6/mirror/mirror-knowledge.js`);

delete process.env.ANTHROPIC_API_KEY; // 신규 적재 분류기(LLM) 호출 금지 — 정책 축만

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const SYS = "__rnpg__";
const INST = "__rnpg__inst";
const C1 = "domain-wiki:__rnpg__a", C2 = "domain-wiki:__rnpg__b";   // 수집기 표식 둘
const URL_A = "https://git.example.com/wiki/-/blob/main/a.md", URL_B = "https://git.example.com/wiki/-/blob/main/b.md";

const item = (o = {}) => ({
  type: "doc",
  provenance: { category: "vcs", system: SYS, instance: INST, external_id: "doc-1", external_url: o.url ?? URL_A },
  title: "제목 A",
  body: o.body ?? "본문 A",
  occurred_at: o.occurred_at ?? "2026-11-01T00:00:00.000Z",
  parent_external_id: o.parent,
  sort: o.sort,
  fields: o.fields ?? { domain_wiki: { relpath: "a.md", id_mode: "path" }, tags: ["x", "y"] },
  raw: o.raw ?? { a: 1, b: { c: 2 } },
});
async function mirror(it, claim = C1) {
  const c = await itemsPool.connect();
  try {
    await c.query("BEGIN");
    const r = await mirrorKnowledgeV6(c, it, SYS, it.provenance.external_id, claim);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
const row = async () => (await itemsPool.query(
  `SELECT name, title, body_md, version, updated_at, last_synced_at, lifecycle, provenance, sync_state, sort, embedding_model
     FROM knowledge WHERE external_system=$1 AND external_instance=$2 AND external_id='doc-1'`, [SYS, INST])).rows[0];
const audits = async (name) => Number((await itemsPool.query(
  `SELECT count(*)::int n FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1`, [name])).rows[0].n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  const names = (await itemsPool.query(`SELECT name FROM knowledge WHERE external_system=$1`, [SYS])).rows.map((r) => r.name);
  if (names.length) await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND entity_key = ANY($1::text[])`, [names]);
  await itemsPool.query(`DELETE FROM knowledge WHERE external_system=$1`, [SYS]);
}

try {
  await cleanup();
  chk("준비 신규 적재 true", await mirror(item()) === true);
  const r0 = await row();
  chk("준비 판 1 · active · observed", r0?.version === 1 && r0.lifecycle === "active" && r0.provenance === "observed", JSON.stringify(r0));
  const name = r0.name;
  const a0 = await audits(name);

  // D1
  await sleep(20);
  chk("D1 같은 항목 재싱크 → true", await mirror(item()) === true);
  const r1 = await row();
  chk("D1 판 그대로", r1.version === 1, `version=${r1.version}`);
  chk("D1 updated_at 그대로", r1.updated_at.getTime() === r0.updated_at.getTime(), `${r0.updated_at.toISOString()} → ${r1.updated_at.toISOString()}`);
  chk("D1 last_synced_at 늘어남", r1.last_synced_at.getTime() > r0.last_synced_at.getTime(), `${r0.last_synced_at.toISOString()} → ${r1.last_synced_at.toISOString()}`);
  chk("D1 수집기 표식", !!r1.sync_state?.seen_by?.[C1], JSON.stringify(r1.sync_state));
  chk("D1 감사 0", await audits(name) === a0);
  // D2
  await mirror(item(), C2);
  const r2 = await row();
  chk("D2 표식 둘 · 판 그대로", r2.version === 1 && !!r2.sync_state?.seen_by?.[C1] && !!r2.sync_state?.seen_by?.[C2], JSON.stringify({ v: r2.version, s: r2.sync_state }));
  // D3
  await mirror(item({ fields: { tags: ["x", "y"], domain_wiki: { id_mode: "path", relpath: "a.md" } }, raw: { b: { c: 2 }, a: 1 }, occurred_at: "2026-11-01T09:00:00+09:00" }));
  chk("D3 키 순서 · 시간대 표기만 다름 → 판 그대로", (await row()).version === 1);
  // D4
  const F2 = { domain_wiki: { relpath: "a.md", id_mode: "path" }, tags: ["y", "x"] };
  await mirror(item({ fields: F2 }));
  chk("D4 fields 배열 순서 바뀜 → 판 2", (await row()).version === 2);
  chk("D4 감사 0(제목 · 본문 같음)", await audits(name) === a0);
  // D5
  await itemsPool.query(`UPDATE knowledge SET embedding_model='m' WHERE name=$1`, [name]);
  await mirror(item({ fields: F2, body: "본문 B" }));
  const r5 = await row();
  chk("D5 본문 바뀜 → 판 3 · 본문 B · 임베딩 리셋", r5.version === 3 && r5.body_md === "본문 B" && r5.embedding_model === null, JSON.stringify({ v: r5.version, b: r5.body_md, e: r5.embedding_model }));
  chk("D5 감사 +1", await audits(name) === a0 + 1);
  const cur = { fields: F2, body: "본문 B" };
  // D6
  await itemsPool.query(`UPDATE knowledge SET provenance='authored' WHERE name=$1`, [name]);
  await mirror(item(cur));
  const r6 = await row();
  chk("D6 provenance 뒤집힘 → observed 로 · 판 4", r6.provenance === "observed" && r6.version === 4, JSON.stringify({ p: r6.provenance, v: r6.version }));
  // D7
  await itemsPool.query(`UPDATE knowledge SET sort=7 WHERE name=$1`, [name]);
  await mirror(item(cur));
  chk("D7 sort 미지정 → 판 그대로(4)", (await row()).version === 4);
  await mirror(item({ ...cur, sort: 7 }));
  chk("D7 sort 같은 값 → 판 그대로(4)", (await row()).version === 4);
  await mirror(item({ ...cur, sort: 8 }));
  const r7 = await row();
  chk("D7 sort 다른 값 → 판 5 · sort 8", r7.version === 5 && Number(r7.sort) === 8, JSON.stringify({ v: r7.version, s: r7.sort }));
  const cur8 = { ...cur, sort: 8 };
  // D8
  await mirror(item({ ...cur8, fields: { ...F2, archived: true } }));
  const r8a = await row();
  chk("D8 원본 보관 → archived · 판 6", r8a.lifecycle === "archived" && r8a.version === 6, JSON.stringify({ l: r8a.lifecycle, v: r8a.version }));
  await mirror(item(cur8));
  const r8b = await row();
  chk("D8 다시 나타남 → active · 판 7", r8b.lifecycle === "active" && r8b.version === 7, JSON.stringify({ l: r8b.lifecycle, v: r8b.version }));
  // D9
  await itemsPool.query(`UPDATE knowledge SET lifecycle='pending' WHERE name=$1`, [name]);
  await mirror(item(cur8));
  const r9 = await row();
  chk("D9 pending 유지 · 판 그대로(7)", r9.lifecycle === "pending" && r9.version === 7, JSON.stringify({ l: r9.lifecycle, v: r9.version }));
  await itemsPool.query(`UPDATE knowledge SET lifecycle='active' WHERE name=$1`, [name]);
  // D10
  await mirror(item({ ...cur8, url: URL_B }));
  chk("D10 원본 주소 변경 → 판 8", (await row()).version === 8);
  await mirror(item({ ...cur8, url: URL_B, occurred_at: "2026-11-02T00:00:00Z" }));
  chk("D10 occurred_at 변경 → 판 9", (await row()).version === 9);
  await mirror(item({ ...cur8, url: URL_B, occurred_at: "2026-11-02T00:00:00Z", parent: "doc-0" }));
  chk("D10 부모 변경 → 판 10", (await row()).version === 10);
} catch (e) {
  fail++; console.error("FAIL 예외 —", e);
} finally {
  try { await cleanup(); } catch (e) { console.error("정리 실패:", e?.message ?? e); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await itemsPool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
