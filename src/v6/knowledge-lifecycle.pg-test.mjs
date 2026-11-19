// 지식 대체(superseded) 후속 포인터(superseded_by) PG 통합 테스트 — **실제 Postgres 필요**(.github/workflows/test.yml 의 pg 잡이 자동 수집).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/knowledge-lifecycle.pg-test.mjs
//
// 왜 이 계층인가: 규칙의 절반이 동시성이다 — 두 지식을 서로의 후속으로 동시에 거는 경합, 후속을 지우는 동안의 전환, 지운 뒤 되살리기.
//  행 잠금과 커밋 순서는 실제 트랜잭션에서만 드러난다. 경합은 다른 연결이 행을 쥐고 있는 동안 두 작업을 띄운 뒤 놓아 재현한다.
//
//  사양:
//   L1  superseded 로 바꾸며 후속을 안 주면 400 — 아무것도 안 바뀐다
//   L2  후속(active)을 주면 superseded + superseded_by=후속 · 감사 before/after 에 포인터
//   L3  후속이 없는 이름 · 자기 자신 · active 가 아닌 지식이면 400
//   L4  외부 미러 행(external_system)은 superseded 로 못 바꾼다(400)
//   L5  이미 superseded 이고 포인터가 있으면 후속 없이 다시 불러도 포인터 유지 · 다른 이름을 주면 교체
//   L6  포인터 없이 superseded 인 옛 행에 후속을 붙일 수 있다
//   L7  다른 lifecycle 로 바꾸면 포인터를 비운다 · 다른 lifecycle 에 후속을 실으면 400
//   L8  동시 전환 A→B · B→A — 둘 다 superseded 가 되지 않는다(하나는 400)
//   L9  후속으로 가리켜지는 지식은 지울 수 없다(409) · 가리키는 쪽을 보관하면 지울 수 있다
//   L10 전환과 후속 삭제가 엇갈려도(어느 쪽이 먼저 잠그든) 없는 후속을 가리키는 superseded 가 남지 않는다
//   L11 되살리기 — 후속이 그대로면 superseded+포인터로, 후속이 사라졌거나 active 가 아니면 포인터를 비우고 archived 로
//   L12 되돌리기(content_undo) — superseded 전환을 되돌리면 이전 상태·포인터 비움 / 포인터를 비운 전환을 되돌리면 그 후속으로 다시 건다 /
//       그 사이 후속이 지워졌으면 400 을 그대로 낸다(포인터 없이 superseded 로 되살리지 않는다)
//   L13 후속은 쓰기 게이트를 탄다 — 보는 사람에게 안 보이는 지식을 후속으로 걸 수 없다(없는 문서와 같은 404)
//   L14 응답의 포인터 — 보는 사람에게 안 보이는 후속·대체 대상은 get·list 에서 null 로 나간다(특권 조회는 그대로)
//   L15 supersedes(후속 쪽 표시) — 본문만 다시 저장해도 유지 · null 로 비움 · 되돌리기로 이전 값
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_knowledge_lifecycle";
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
const { setVisAxes } = await import(`${D}/v6/visibility-axes.js`);
const { invalidateVisibilityCache } = await import(`${D}/v6/visibility.js`);
const { authoringCapabilities } = await import(`${D}/capabilities/knowledge/authoring.js`);
const { undoCapabilities } = await import(`${D}/capabilities/undo.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const attempt = async (fn) => { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, status: e?.status ?? 500, msg: String(e?.message ?? e) }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = async (name) => (await q(`SELECT lifecycle, superseded_by, supersedes FROM knowledge WHERE name=$1`, [name]))[0];
const show = (r) => JSON.stringify(r);
// 없는 후속을 가리키는 superseded 행 — 어떤 경합 뒤에도 0 이어야 한다
const dangling = async () => (await q(
  `SELECT k.name FROM knowledge k WHERE k.lifecycle='superseded' AND k.superseded_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM knowledge t WHERE t.name=k.superseded_by)`)).map((r) => r.name);
// 다른 연결이 행을 쥐고 있는 동안 작업을 띄운다 — 놓기 전까지 그 작업은 잠금에서 기다린다
async function holdRows(names) {
  const c = new pg.Client({ connectionString: dsnFor(DB) }); await c.connect();
  await c.query("BEGIN");
  await c.query(`SELECT name FROM knowledge WHERE name = ANY($1::text[]) ORDER BY name FOR NO KEY UPDATE`, [names]);
  return { release: async () => { await c.query("COMMIT"); await c.end(); } };
}
async function waitingOnLock(min) {
  for (let i = 0; i < 100; i++) {
    const n = Number((await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'`, [DB]))[0].n);
    if (n >= min) return true;
    await sleep(50);
  }
  return false;
}

const TAG = "zl" + Math.floor(Math.random() * 1e6);
const CK = `cat${TAG}`;
await q(`INSERT INTO category(key, name) VALUES($1,$1)`, [CK]);
const ME = "pgt-lc", OTHER = "pgt-lc-out";
const user = (id) => ({ userId: id, email: `${id}@x`, scopes: ["memory"], projects: ["*"] });
const web = (id) => ({ source: "web", actor: id, viewer: id });
const mcp = (id) => ({ source: "mcp", actor: id, viewer: id });
const k = (s) => `${TAG}-${s}`;
const mk = (name, extra = {}) => kst.upsertKnowledge({ name, title: name, body_md: `본문 ${name}`, type: "reference", category: CK, ...extra }, { actor: ME, source: "web" });
const setLc = capOf(authoringCapabilities, "knowledge_set_lifecycle");
const save = capOf(authoringCapabilities, "knowledge_save");
const undo = capOf(undoCapabilities, "content_undo");
function capOf(arr, n) { return arr.find((c) => c.name === n); }
const lc = (name, lifecycle, superseded_by, who = ME, ctx = mcp) =>
  attempt(() => setLc.handler({ name, lifecycle, ...(superseded_by !== undefined ? { superseded_by } : {}) }, user(who), ctx(who)));

try {
  for (const s of ["a", "x", "y", "arch", "self", "mir", "leg"]) await mk(k(s));
  await q(`UPDATE knowledge SET lifecycle='archived' WHERE name=$1`, [k("arch")]);
  await q(`UPDATE knowledge SET external_system='notion', external_id=$2 WHERE name=$1`, [k("mir"), TAG]);

  // ── L1 ──
  const l1 = await lc(k("a"), "superseded");
  chk("L1 후속 없이 superseded = 400", !l1.ok && l1.status === 400, show(l1));
  chk("L1 아무것도 안 바뀐다", (await row(k("a"))).lifecycle === "active", show(await row(k("a"))));

  // ── L3 ──
  const l3a = await lc(k("a"), "superseded", k("nope"));
  const l3b = await lc(k("a"), "superseded", k("a"));
  const l3c = await lc(k("a"), "superseded", k("arch"));
  chk("L3 없는 후속 = 400", !l3a.ok && l3a.status === 400, show(l3a));
  chk("L3 자기 자신 = 400", !l3b.ok && l3b.status === 400, show(l3b));
  chk("L3 active 아닌 후속 = 400", !l3c.ok && l3c.status === 400, show(l3c));
  chk("L3 실패 뒤 그대로 active", (await row(k("a"))).lifecycle === "active");

  // ── L4 ──
  const l4 = await lc(k("mir"), "superseded", k("x"));
  chk("L4 미러 행 superseded = 400", !l4.ok && l4.status === 400, show(l4));
  chk("L4 미러 행 그대로", (await row(k("mir"))).lifecycle === "active");

  // ── L2 ──
  const l2 = await lc(k("a"), "superseded", k("x"));
  chk("L2 후속과 함께 superseded", l2.ok && (await row(k("a"))).lifecycle === "superseded" && (await row(k("a"))).superseded_by === k("x"), show(l2.ok ? await row(k("a")) : l2));
  const aud = (await q(`SELECT before, after FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='set_lifecycle' ORDER BY id DESC LIMIT 1`, [k("a")]))[0];
  chk("L2 감사 before(포인터 없음) · after(포인터)", aud && aud.before?.superseded_by == null && aud.after?.superseded_by === k("x"), show(aud));

  // ── L5 ──
  const l5a = await lc(k("a"), "superseded");
  chk("L5 후속 없이 다시 불러도 포인터 유지", l5a.ok && (await row(k("a"))).superseded_by === k("x"), show(l5a.ok ? await row(k("a")) : l5a));
  const l5b = await lc(k("a"), "superseded", k("y"));
  chk("L5 다른 후속을 주면 교체", l5b.ok && (await row(k("a"))).superseded_by === k("y"), show(await row(k("a"))));

  // ── L6 — 포인터 없이 superseded 가 된 옛 행(기능 이전·배포 중 옛 버전이 만든 것) ──
  await q(`UPDATE knowledge SET lifecycle='superseded', superseded_by=NULL WHERE name=$1`, [k("leg")]);
  const l6a = await lc(k("leg"), "superseded");
  chk("L6 옛 행도 후속 없이 다시 부르면 400", !l6a.ok && l6a.status === 400, show(l6a));
  const l6b = await lc(k("leg"), "superseded", k("x"));
  chk("L6 옛 행에 후속을 붙인다", l6b.ok && (await row(k("leg"))).superseded_by === k("x"), show(await row(k("leg"))));

  // ── L7 ──
  const l7a = await lc(k("leg"), "archived", k("x"));
  chk("L7 다른 lifecycle 에 후속 = 400", !l7a.ok && l7a.status === 400, show(l7a));
  const l7b = await lc(k("leg"), "archived");
  chk("L7 archived 로 바꾸면 포인터를 비운다", l7b.ok && (await row(k("leg"))).lifecycle === "archived" && (await row(k("leg"))).superseded_by === null, show(await row(k("leg"))));

  // ── L8 동시 전환 A→B · B→A ──
  const P = k("p"), Q = k("q");
  await mk(P); await mk(Q);
  const h8 = await holdRows([P, Q]);
  const r8 = [kst.setKnowledgeLifecycle(P, "superseded", { actor: ME, source: "mcp" }, { supersededBy: Q }),
              kst.setKnowledgeLifecycle(Q, "superseded", { actor: ME, source: "mcp" }, { supersededBy: P })].map((p) => p.then(() => "ok", (e) => e?.status ?? 500));
  chk("L8 전제: 두 전환이 잠금에서 기다린다", await waitingOnLock(2));
  await h8.release();
  const s8 = await Promise.all(r8);
  const both = [await row(P), await row(Q)];
  chk("L8 둘 다 superseded 가 되지 않는다", both.filter((r) => r.lifecycle === "superseded").length === 1, show({ s8, both }));
  chk("L8 진 쪽은 400", s8.filter((s) => s === "ok").length === 1 && s8.includes(400), show(s8));

  // ── L9 ──
  const l9a = await attempt(() => kst.deleteKnowledge(k("y"), { actor: ME, source: "web" }));
  chk("L9 후속으로 가리켜지는 지식 삭제 = 409", !l9a.ok && l9a.status === 409, show(l9a));
  chk("L9 그대로 남는다", !!(await row(k("y"))));
  await kst.setKnowledgeLifecycle(k("a"), "archived", { actor: ME, source: "web" });
  const l9b = await attempt(() => kst.deleteKnowledge(k("y"), { actor: ME, source: "web" }));
  chk("L9 가리키는 쪽을 보관하면 지울 수 있다", l9b.ok && !(await row(k("y"))), show(l9b));

  // ── L10 전환과 후속 삭제의 엇갈림 — 이름 순 잠금이라 옛 지식이 앞일 때·뒤일 때 두 갈래를 다 본다 ──
  for (const [label, oldN, succN] of [["옛 지식이 이름 앞", k("m1-a"), k("m1-b")], ["옛 지식이 이름 뒤", k("m2-b"), k("m2-a")]]) {
    await mk(oldN); await mk(succN);
    const h = await holdRows([oldN]);
    const tr = kst.setKnowledgeLifecycle(oldN, "superseded", { actor: ME, source: "mcp" }, { supersededBy: succN }).then(() => "ok", (e) => e?.status ?? 500);
    chk(`L10(${label}) 전제: 전환이 잠금에서 기다린다`, await waitingOnLock(1));
    const del = kst.deleteKnowledge(succN, { actor: ME, source: "web" }).then(() => "ok", (e) => e?.status ?? 500);
    await sleep(200);
    await h.release();
    const [st, sd] = await Promise.all([tr, del]);
    const o = await row(oldN), s = await row(succN);
    const consistent = (st === "ok" && sd === 409 && o.superseded_by === succN && !!s) || (st === 400 && sd === "ok" && o.lifecycle === "active" && !s);
    chk(`L10(${label}) 한쪽만 이긴다 — 끊긴 포인터 없음`, consistent && (await dangling()).length === 0, show({ st, sd, o, s, dangling: await dangling() }));
  }

  // ── L11 되살리기 ──
  const R1 = k("r1"), RS = k("rs");
  await mk(R1); await mk(RS);
  await kst.setKnowledgeLifecycle(R1, "superseded", { actor: ME, source: "web" }, { supersededBy: RS });
  const snapOf = async (name) => (await q(`SELECT before FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='delete' ORDER BY id DESC LIMIT 1`, [name]))[0].before;
  await kst.deleteKnowledge(R1, { actor: ME, source: "web" });
  await kst.restoreKnowledge(await snapOf(R1), { actor: ME, source: "web" });
  chk("L11 후속이 그대로면 superseded+포인터로 되살린다", show(await row(R1)) === show({ lifecycle: "superseded", superseded_by: RS, supersedes: null }), show(await row(R1)));
  await kst.deleteKnowledge(R1, { actor: ME, source: "web" });
  await kst.deleteKnowledge(RS, { actor: ME, source: "web" });
  await kst.restoreKnowledge(await snapOf(R1), { actor: ME, source: "web" });
  chk("L11 후속이 지워졌으면 포인터를 비우고 archived", show(await row(R1)) === show({ lifecycle: "archived", superseded_by: null, supersedes: null }), show(await row(R1)));
  const R2 = k("r2"), RT = k("rt");
  await mk(R2); await mk(RT);
  await kst.setKnowledgeLifecycle(R2, "superseded", { actor: ME, source: "web" }, { supersededBy: RT });
  await kst.deleteKnowledge(R2, { actor: ME, source: "web" });
  await kst.setKnowledgeLifecycle(RT, "archived", { actor: ME, source: "web" });
  await kst.restoreKnowledge(await snapOf(R2), { actor: ME, source: "web" });
  chk("L11 후속이 active 가 아니면 포인터를 비우고 archived", (await row(R2)).lifecycle === "archived" && (await row(R2)).superseded_by === null, show(await row(R2)));
  chk("L11 끊긴 포인터 없음", (await dangling()).length === 0, show(await dangling()));

  // ── L12 되돌리기 ──
  const UA = "pgt-lc-undo", U1 = k("u1"), US = k("us");
  await mk(U1); await mk(US);
  const u1 = await lc(U1, "superseded", US, UA, web);
  chk("L12 전제: 웹에서 superseded 전환", u1.ok, show(u1));
  const un1 = await attempt(() => undo.handler({ skip: [] }, user(UA), web(UA)));
  chk("L12 전환을 되돌리면 active · 포인터 비움", un1.ok && show(await row(U1)) === show({ lifecycle: "active", superseded_by: null, supersedes: null }), show(un1.ok ? await row(U1) : un1));
  await lc(U1, "superseded", US, UA, web);
  await lc(U1, "archived", undefined, UA, web);
  const un2 = await attempt(() => undo.handler({ skip: [] }, user(UA), web(UA)));
  chk("L12 포인터를 비운 전환을 되돌리면 그 후속으로 다시 건다", un2.ok && (await row(U1)).lifecycle === "superseded" && (await row(U1)).superseded_by === US, show(un2.ok ? await row(U1) : un2));
  await lc(U1, "archived", undefined, UA, web);
  await kst.deleteKnowledge(US, { actor: ME, source: "web" });
  const un3 = await attempt(() => undo.handler({ skip: [] }, user(UA), web(UA)));
  chk("L12 그 사이 후속이 지워졌으면 400 · 그대로 archived", !un3.ok && un3.status === 400 && (await row(U1)).lifecycle === "archived", show({ un3, r: await row(U1) }));

  // ── L13 · L14 공개범위 — 지식 축을 켜고 후속을 members(대상 없음)로 잠근다 ──
  const V1 = k("v1"), VH = k("vh"), VO = k("vo"), VL = k("vl");
  await mk(V1); await mk(VH); await mk(VO); await mk(VL);
  await kst.setKnowledgeLifecycle(V1, "superseded", { actor: ME, source: "web" }, { supersededBy: VH });
  await q(`UPDATE knowledge SET supersedes=$2 WHERE name=$1`, [VO, VH]);
  await q(`UPDATE knowledge SET visibility='members' WHERE name=$1`, [VH]);
  await setVisAxes({ knowledge: true });
  invalidateVisibilityCache();
  const l13 = await lc(VL, "superseded", VH, OTHER);
  chk("L13 안 보이는 후속 = 404(없는 문서와 같은 문구)", !l13.ok && l13.status === 404, show(l13));
  chk("L13 그대로 active", (await row(VL)).lifecycle === "active");
  const g = await kst.getKnowledge(V1, OTHER);
  chk("L14 get — 안 보이는 후속은 null", g && g.superseded_by === null && g.lifecycle === "superseded", show(g && { s: g.superseded_by }));
  const gs = await kst.getKnowledge(VO, OTHER);
  chk("L14 get — 안 보이는 대체 대상(supersedes)도 null", gs && gs.supersedes === null, show(gs && { s: gs.supersedes }));
  const ls = await kst.listKnowledge({ lifecycle: "superseded,active", categoryId: Number((await q(`SELECT id FROM category WHERE key=$1`, [CK]))[0].id), limit: 500 }, OTHER);
  const lv = ls.find((r) => r.name === V1);
  chk("L14 list — 안 보이는 후속은 null", lv && lv.superseded_by === null, show(lv && { s: lv.superseded_by }));
  const gp = await kst.getKnowledge(V1, null);
  chk("L14 특권 조회는 그대로", gp?.superseded_by === VH, show(gp && { s: gp.superseded_by }));
  await setVisAxes({ knowledge: false });
  invalidateVisibilityCache();

  // ── L15 supersedes 3상 ──
  const S1 = k("s1"), S0 = k("s0"), SA = "pgt-lc-save";
  await mk(S0);
  await save.handler({ name: S1, title: "s1", body_md: "첫 본문", type: "reference", category: CK, supersedes: S0 }, user(SA), web(SA));
  await save.handler({ name: S1, body_md: "본문만 다시" }, user(SA), web(SA));
  chk("L15 본문만 다시 저장해도 supersedes 유지", (await row(S1)).supersedes === S0, show(await row(S1)));
  await save.handler({ name: S1, body_md: "비움", supersedes: null }, user(SA), web(SA));
  chk("L15 null 로 비운다", (await row(S1)).supersedes === null, show(await row(S1)));
  const un15 = await attempt(() => undo.handler({ skip: [] }, user(SA), web(SA)));
  chk("L15 되돌리면 이전 값", un15.ok && (await row(S1)).supersedes === S0, show(un15.ok ? await row(S1) : un15));
  await save.handler({ name: S1, body_md: "다시 비움", supersedes: null }, user(SA), web(SA));
  await save.handler({ name: S1, body_md: "다시 설정", supersedes: S0 }, user(SA), web(SA));
  const un15b = await attempt(() => undo.handler({ skip: [] }, user(SA), web(SA)));
  chk("L15 값을 설정한 저장을 되돌리면 다시 비운다", un15b.ok && (await row(S1)).supersedes === null, show(un15b.ok ? await row(S1) : un15b));
} catch (e) {
  fail++; console.error("FAIL 예외 —", e);
} finally {
  await itemsPool.end().catch(() => undefined);
  if (!process.env.KEEP_TEST_DB) await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await su.end().catch(() => undefined);
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
