// 지식 링크 해제(dismissed_at) · 관리기 모순 링크 · 숨은 대체 이웃 · 관리기 발견 마감 PG 통합 테스트 — **실제 Postgres 필요**
//  (.github/workflows/test.yml 의 pg 잡이 자동 수집).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/knowledge-link-dismiss.pg-test.mjs
//
// 왜 이 계층인가: 규칙의 절반이 트랜잭션 경계다 — 반려와 재보고가 엇갈릴 때, 적용 도중 사람이 반려할 때. 행 잠금과 커밋 순서,
//  트리거, 정렬 규칙(least/greatest)은 실제 DB 에서만 드러난다. 경합은 다른 연결이 행을 쥐고 있는 동안 작업을 띄운 뒤 놓아 재현한다.
//
//  사양:
//   B1~B4 body_updated_at — 새 행은 채워지고, 같은 본문 재저장·제목만 수정에는 그대로, 본문이 바뀌면 오른다(upsert · INSERT … ON CONFLICT 양쪽)
//   C1  모순 보고는 쌍을 least/greatest 로 맞춘다(보고 방향과 무관하게 한 행) · C2 contradicts 링크(origin manager:<key>)가 생긴다
//   C3  같은 쌍을 다시 보고하면 again — 행·링크가 늘지 않는다
//   C4  knowledge_get 양쪽(나가는·들어오는)에 contradicts_warning · 모순이 없으면 키가 없다
//   C5  사람이 관리기 링크를 해제하면 지우지 않고 dismissed_at — 링크 목록·경고·그래프에서 빠진다
//   C6  해제된 쌍을 관리기가 다시 보고해도 링크가 되살아나지 않는다
//   C7  사람이 같은 쌍을 다시 링크하면 user 링크로 되살아난다(dismissed_at 비움)
//   C8  모순 발견을 반려하면 그 쌍의 관리기 링크가 해제된다 · 사람 링크는 그대로 · 반려 뒤 재보고는 skipped
//   C9  정규화 전 반대 방향 행 — 반려돼 있으면 저장·링크 없음, 열려 있으면 그 행을 이어 쓴다
//   C10 반대 방향 사람 링크가 있으면 관리기 링크를 만들지 않는다
//   C11 반려와 재보고 경합 — 어느 쪽이 먼저 잠그든 발견은 rejected, 살아 있는 관리기 링크 0
//   C12 recheck — 링크 뒤 한쪽만 고치면 false, 양쪽 다 고치면 true
//   S1  대체된 이웃은 links.superseded 에(나가는·들어오는, 후속 포함) — outgoing·incoming 에서는 빠진다
//   V1  안 보이는 이웃은 경고·대체 목록에서 빠지고, 안 보이는 후속은 null(특권 조회는 그대로)
//   P1  일괄 적용 — 분류를 옮기고 accepted
//   P2  적용 도중 사람이 반려하면(발견 행 잠금) 적용하지 않는다 — 분류 그대로 · rejected 유지
//   P3  발견 이후 분류가 바뀌었으면 옮기지 않고 resolved「분류 변경으로 해소」 · P4 옮길 분류가 활성이 아니어도 같다
//   M1  mismatch 근접 후보는 활성 분류만 — deprecated 분류로 옮기라고 제안하지 않는다
//   A0  재판정 스위치(ontology_loops.l2_autoresolve)가 꺼져 있으면 아무것도 닫지 않는다 · 저장은 보낸 키만 바꾼다
//   A1  outdated — 본문을 고치면 「본문 갱신으로 해소」 · 판정식 밖(cites)이 된 발견은 「판정 기준 변경으로 해소」
//   A2  메타데이터만 바뀐 지식의 outdated 는 닫히지 않는다 · 스코프 밖이어도 성립하면 열린 채 · 반려된 발견은 그대로
//   A3  mismatch — 분류를 옮기면 「분류 변경으로 해소」
//   A4  닫힌 발견도 다시 성립하면 다음 탐지가 다시 연다
//   R1  열린 outdated 발견이 있으면 knowledge_get 에 review_hint · 닫히면 없다
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_link_dismiss";
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
const links = await import(`${D}/v6/knowledge-links.js`);
const mstore = await import(`${D}/org/store/managers.js`);
const rm = await import(`${D}/org/manage/run-manager.js`);
const det = await import(`${D}/org/manage/detectors.js`);
const rc = await import(`${D}/org/store/runtime-config.js`);
const { setVisAxes } = await import(`${D}/v6/visibility-axes.js`);
const { invalidateVisibilityCache } = await import(`${D}/v6/visibility.js`);
const { readNamedCapabilities } = await import(`${D}/capabilities/knowledge/read.js`);
const { classificationCapabilities } = await import(`${D}/capabilities/knowledge/classification.js`);
const { managersCapabilities } = await import(`${D}/capabilities/delivery/managers.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const attempt = async (fn) => { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, status: e?.status ?? 500, msg: String(e?.message ?? e) }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (r) => JSON.stringify(r);
const capOf = (arr, n) => arr.find((c) => c.name === n);
async function waitingOnLock(min) {
  for (let i = 0; i < 100; i++) {
    const n = Number((await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'`, [DB]))[0].n);
    if (n >= min) return true;
    await sleep(50);
  }
  return false;
}
async function otherConn() { const c = new pg.Client({ connectionString: dsnFor(DB) }); await c.connect(); return c; }

const TAG = "zd" + Math.floor(Math.random() * 1e6);
const ME = "pgt-ld", OTHER = "pgt-ld-out";
const user = (id) => ({ userId: id, email: `${id}@x`, scopes: ["memory", "admin"], projects: ["*"] });
const web = (id) => ({ source: "web", actor: id, viewer: id });
const k = (s) => `${TAG}-${s}`;
const mkCat = async (key, state = "active") => Number((await q(`INSERT INTO category(key, name, state) VALUES($1,$1,$2) RETURNING id`, [key, state]))[0].id);
const CK = `cat${TAG}`;
const mk = (name, extra = {}) => kst.upsertKnowledge({ name, title: name, body_md: `본문 ${name}`, type: "reference", category: CK, ...extra }, { actor: ME, source: "web" });
const get = capOf(readNamedCapabilities, "knowledge_get");
const linkCap = capOf(classificationCapabilities, "knowledge_link");
const report = capOf(managersCapabilities, "org_manager_finding_report");
const resolveCap = capOf(managersCapabilities, "org_manager_finding_resolve");
const applyCap = capOf(managersCapabilities, "org_manager_findings_apply");
const runCap = capOf(managersCapabilities, "org_manager_run");
const kget = (name, who = ME) => attempt(() => get.handler({ name }, user(who), web(who)));
const pairOf = async (x, y) => (await q(`SELECT least($1::text,$2::text) AS a, greatest($1::text,$2::text) AS b`, [x, y]))[0];
const linkRows = async (x, y) => q(
  `SELECT from_name, to_name, origin, dismissed_at FROM knowledge_link
    WHERE relation='contradicts' AND ((from_name=$1 AND to_name=$2) OR (from_name=$2 AND to_name=$1)) ORDER BY from_name`, [x, y]);
const findingRows = async (mid, x, y) => q(
  `SELECT id, target_ref, dedup_key, state, resolution FROM org_manager_finding
    WHERE manager_id=$1 AND ((target_ref=$2 AND dedup_key=$3) OR (target_ref=$3 AND dedup_key=$2)) ORDER BY id`, [mid, x, y]);
const findingById = async (id) => (await q(`SELECT id, state, resolution FROM org_manager_finding WHERE id=$1`, [id]))[0];
const rep = (mkey, x, y) => attempt(() => report.handler({ manager_key: mkey, target_ref: x, dedup_key: y, severity: "warn", summary: "어긋남", evidence: "인용" }, user(ME), web(ME)));
// 1024 차원 벡터 — 앞 세 축만 쓴다
const vec = (a, b, c) => "[" + [a, b, c, ...Array(1021).fill(0)].join(",") + "]";
const catOf = async (name) => (await q(`SELECT category_id FROM knowledge_category WHERE name=$1`, [name])).map((r) => Number(r.category_id));
const insFinding = async (mid, kind, ref, dedup, state = "open", action = null, lastSeen = "now()") => Number((await q(
  `INSERT INTO org_manager_finding(manager_id, kind, target_kind, target_ref, dedup_key, severity, summary, state, proposed_action, last_seen_at)
   VALUES($1,$2,'knowledge',$3,$4,'note','s',$5,$6::jsonb, ${lastSeen}) RETURNING id`, [mid, kind, ref, dedup, state, action ? JSON.stringify(action) : null]))[0].id);

//  절마다 따로 잡는다 — 한 절의 예외(구 스키마의 없는 칸 등)가 뒤 절의 판정을 가리지 않게.
const section = async (name, fn) => { try { await fn(); } catch (e) { fail++; console.error(`FAIL ${name} 예외 —`, e?.message ?? e); } };
const B = k("b");
try {
  await mkCat(CK);

  await section("B", async () => {
  // ── B body_updated_at ──
  await mk(B);
  const bt = async () => (await q(`SELECT body_updated_at AS t FROM knowledge WHERE name=$1`, [B]))[0]?.t;
  const b0 = await attempt(bt);
  chk("B1 새 행은 body_updated_at 이 채워진다", b0.ok && b0.v instanceof Date, show(b0));
  await sleep(20);
  await mk(B);
  const b1 = await attempt(bt);
  chk("B2 같은 본문 재저장은 그대로", b1.ok && b0.ok && b1.v?.getTime() === b0.v?.getTime(), show({ b0, b1 }));
  await q(`UPDATE knowledge SET title='다른 제목', updated_at=now() WHERE name=$1`, [B]);
  const b2 = await attempt(bt);
  chk("B3 제목만 고치면 그대로", b2.ok && b0.ok && b2.v?.getTime() === b0.v?.getTime(), show({ b0, b2 }));
  await sleep(20);
  await mk(B, { body_md: "바뀐 본문" });
  const b3 = await attempt(bt);
  chk("B4 본문이 바뀌면 오른다(upsert)", b3.ok && b0.ok && b3.v?.getTime() > b0.v?.getTime(), show({ b0, b3 }));
  await sleep(20);
  await q(`INSERT INTO knowledge(name, title, body_md) VALUES($1,'t','바뀐 본문') ON CONFLICT (tenant_id, name) DO UPDATE SET body_md=EXCLUDED.body_md`, [B]);
  const b4 = await attempt(bt);
  await sleep(20);
  await q(`INSERT INTO knowledge(name, title, body_md) VALUES($1,'t','또 바뀐 본문') ON CONFLICT (tenant_id, name) DO UPDATE SET body_md=EXCLUDED.body_md`, [B]);
  const b5 = await attempt(bt);
  chk("B4 INSERT … ON CONFLICT — 같은 본문이면 그대로, 바뀌면 오른다",
    b4.ok && b5.ok && b4.v?.getTime() === b3.v?.getTime() && b5.v?.getTime() > b4.v?.getTime(), show({ b3, b4, b5 }));

  });

  await section("C", async () => {
  // ── C 관리기 모순 링크 ──
  const MC = (await mstore.upsertManager({ key: `${TAG}-mc`, kind: "contradiction", enabled: true }, ME, "web"));
  const [KA, KB] = [k("ca"), k("cb")];
  await mk(KA); await mk(KB);
  const ab = await pairOf(KA, KB);
  const r1 = await rep(MC.key, ab.b, ab.a);   // 큰 이름을 target_ref 로 보고
  const f1 = await findingRows(MC.id, KA, KB);
  chk("C1 쌍을 least/greatest 로 맞춘다(한 행)", r1.ok && f1.length === 1 && f1[0].target_ref === ab.a && f1[0].dedup_key === ab.b, show({ r1, f1 }));
  const l1 = await linkRows(KA, KB);
  chk("C2 contradicts 링크(origin manager:<key>)", l1.length === 1 && l1[0].from_name === ab.a && l1[0].origin === `manager:${MC.key}` && l1[0].dismissed_at === null, show(l1));
  const r2 = await rep(MC.key, ab.a, ab.b);
  chk("C3 다시 보고하면 again — 행·링크 그대로", r2.ok && r2.v.result === "again" && (await findingRows(MC.id, KA, KB)).length === 1 && (await linkRows(KA, KB)).length === 1,
    show({ r2, f: await findingRows(MC.id, KA, KB), l: await linkRows(KA, KB) }));
  const ga = await kget(ab.a), gb = await kget(ab.b);
  chk("C4 knowledge_get 양쪽에 contradicts_warning",
    ga.ok && gb.ok && ga.v.contradicts_warning?.with?.[0]?.name === ab.b && gb.v.contradicts_warning?.with?.[0]?.name === ab.a && ga.v.contradicts_warning.with[0].recheck === false,
    show({ a: ga.ok ? ga.v.contradicts_warning : ga, b: gb.ok ? gb.v.contradicts_warning : gb }));
  const gB = await kget(B);
  chk("C4 모순이 없으면 키가 없다", gB.ok && !("contradicts_warning" in gB.v) && !("review_hint" in gB.v), show(gB.ok ? Object.keys(gB.v) : gB));

  const un = await attempt(() => linkCap.handler({ name: ab.a, to: ab.b, relation: "contradicts", unlink: true }, user(ME), web(ME)));
  const l2 = await linkRows(KA, KB);
  chk("C5 관리기 링크 해제 = 지우지 않고 dismissed_at", un.ok && l2.length === 1 && l2[0].dismissed_at !== null, show({ un, l2 }));
  const lk = await kst.listKnowledgeLinks(ab.a, null);
  const ga2 = await kget(ab.a);
  const graph = await kst.knowledgeGraphData(2000, null);
  chk("C5 링크 목록·경고·그래프에서 빠진다",
    !lk.outgoing.some((x) => x.name === ab.b) && ga2.ok && !("contradicts_warning" in ga2.v)
      && !graph.edges.some((e) => e.from_name === ab.a && e.to_name === ab.b && e.relation === "contradicts"),
    show({ out: lk.outgoing, w: ga2.ok ? ga2.v.contradicts_warning : ga2 }));
  await rep(MC.key, ab.b, ab.a);
  const l3 = await linkRows(KA, KB);
  chk("C6 해제된 쌍을 다시 보고해도 되살아나지 않는다", l3.length === 1 && l3[0].dismissed_at !== null, show(l3));
  await linkCap.handler({ name: ab.a, to: ab.b, relation: "contradicts" }, user(ME), web(ME));
  const l4 = await linkRows(KA, KB);
  const ga3 = await kget(ab.a);
  chk("C7 사람이 다시 링크하면 user 로 되살아난다", l4.length === 1 && l4[0].origin === "user" && l4[0].dismissed_at === null && ga3.ok && ga3.v.contradicts_warning?.with?.length === 1,
    show({ l4, w: ga3.ok ? ga3.v.contradicts_warning : ga3 }));

  // C8 반려 연쇄
  const [KC, KD, KG, KH] = [k("cc"), k("cd"), k("cg"), k("ch")];
  for (const n of [KC, KD, KG, KH]) await mk(n);
  await rep(MC.key, KC, KD);
  const cd = await findingRows(MC.id, KC, KD);
  const gh = await pairOf(KG, KH);
  await kst.linkKnowledge(gh.a, gh.b, "contradicts", { actor: ME, source: "web" });   // 사람이 먼저 건 모순
  await rep(MC.key, KG, KH);
  const ghF = await findingRows(MC.id, KG, KH);
  const rj = await attempt(() => resolveCap.handler({ id: cd[0]?.id, state: "rejected" }, user(ME), web(ME)));
  const rj2 = await attempt(() => resolveCap.handler({ id: ghF[0]?.id, state: "rejected" }, user(ME), web(ME)));
  const lcd = await linkRows(KC, KD), lgh = await linkRows(KG, KH);
  chk("C8 반려하면 그 쌍의 관리기 링크가 해제된다", rj.ok && lcd.length === 1 && lcd[0].dismissed_at !== null, show({ rj, lcd }));
  chk("C8 사람 링크는 반려에도 그대로", rj2.ok && lgh.length === 1 && lgh[0].origin === "user" && lgh[0].dismissed_at === null, show({ rj2, lgh }));
  const r3 = await rep(MC.key, KD, KC);
  chk("C8 반려 뒤 재보고는 skipped · 링크 그대로 해제", r3.ok && r3.v.result === "skipped" && (await linkRows(KC, KD))[0]?.dismissed_at !== null
    && (await findingRows(MC.id, KC, KD)).length === 1, show({ r3, l: await linkRows(KC, KD) }));

  // C9 정규화 전 반대 방향 행
  const [KI, KJ, KK, KL] = [k("ci"), k("cj"), k("ck"), k("cl")];
  for (const n of [KI, KJ, KK, KL]) await mk(n);
  const ij = await pairOf(KI, KJ), kl = await pairOf(KK, KL);
  await insFinding(MC.id, "contradiction", ij.b, ij.a, "rejected");
  const r4 = await rep(MC.key, ij.a, ij.b);
  chk("C9 반대 방향 행이 반려돼 있으면 저장·링크 없음", r4.ok && r4.v.result === "skipped" && (await findingRows(MC.id, KI, KJ)).length === 1 && (await linkRows(KI, KJ)).length === 0,
    show({ r4, f: await findingRows(MC.id, KI, KJ), l: await linkRows(KI, KJ) }));
  const legacy = await insFinding(MC.id, "contradiction", kl.b, kl.a, "open");
  const r5 = await rep(MC.key, kl.a, kl.b);
  const fkl = await findingRows(MC.id, KK, KL);
  chk("C9 반대 방향 행이 열려 있으면 그 행을 이어 쓴다", r5.ok && r5.v.result === "again" && fkl.length === 1 && Number(fkl[0].id) === legacy, show({ r5, fkl }));

  // C10 반대 방향 사람 링크
  const [KM, KN] = [k("cm"), k("cn")];
  await mk(KM); await mk(KN);
  const mn = await pairOf(KM, KN);
  await kst.linkKnowledge(mn.b, mn.a, "contradicts", { actor: ME, source: "web" });
  await rep(MC.key, mn.a, mn.b);
  const lmn = await linkRows(KM, KN);
  chk("C10 반대 방향 사람 링크가 있으면 관리기 링크를 만들지 않는다", lmn.length === 1 && lmn[0].from_name === mn.b && lmn[0].origin === "user", show(lmn));

  // C11 반려와 재보고 경합 — 발견 행을 다른 연결이 쥔 동안 둘을 띄우고 놓는다
  for (let i = 0; i < 3; i++) {
    const [X, Y] = [k(`rx${i}`), k(`ry${i}`)];
    await mk(X); await mk(Y);
    await rep(MC.key, X, Y);
    const [f] = await findingRows(MC.id, X, Y);
    const hold = await otherConn();
    await hold.query("BEGIN");
    await hold.query(`SELECT id FROM org_manager_finding WHERE id=$1 FOR UPDATE`, [f.id]);
    const a = attempt(() => mstore.resolveFinding(Number(f.id), "rejected", ME, null));
    const b = rep(MC.key, Y, X);
    await waitingOnLock(1);
    await hold.query("COMMIT"); await hold.end();
    const [ra, rb] = await Promise.all([a, b]);
    const fs = await findingRows(MC.id, X, Y);
    const alive = (await linkRows(X, Y)).filter((r) => r.dismissed_at === null && String(r.origin).startsWith("manager:"));
    chk(`C11 경합 ${i + 1} — 발견 rejected · 살아 있는 관리기 링크 0`, ra.ok && rb.ok && fs.length === 1 && fs[0].state === "rejected" && alive.length === 0,
      show({ ra: ra.ok || ra, rb: rb.ok ? rb.v : rb, fs, alive }));
  }

  // C12 recheck
  const [KE, KF] = [k("ce"), k("cf")];
  await mk(KE); await mk(KF);
  await kst.linkKnowledge(KE, KF, "contradicts", { actor: ME, source: "web" });
  await sleep(20);
  await mk(KE, { body_md: "고침 1" });
  const ge1 = await kget(KE);
  await mk(KF, { body_md: "고침 2" });
  const ge2 = await kget(KE);
  chk("C12 한쪽만 고치면 recheck=false · 양쪽 다 고치면 true",
    ge1.ok && ge2.ok && ge1.v.contradicts_warning?.with?.[0]?.recheck === false && ge2.v.contradicts_warning?.with?.[0]?.recheck === true,
    show({ ge1: ge1.ok ? ge1.v.contradicts_warning : ge1, ge2: ge2.ok ? ge2.v.contradicts_warning : ge2 }));

  });

  await section("S·V", async () => {
  // ── S 숨은 대체 이웃 ──
  const [S1, S2, S3, S4] = [k("s1"), k("s2"), k("s3"), k("s4")];
  for (const n of [S1, S2, S3, S4]) await mk(n);
  await kst.linkKnowledge(S1, S2, "related", { actor: ME, source: "web" });
  await kst.linkKnowledge(S4, S1, "refines", { actor: ME, source: "web" });
  await kst.setKnowledgeLifecycle(S2, "superseded", { actor: ME, source: "web" }, { supersededBy: S3 });
  await kst.setKnowledgeLifecycle(S4, "superseded", { actor: ME, source: "web" }, { supersededBy: S3 });
  const sl = await kst.listKnowledgeLinks(S1, null);
  const s2 = sl.superseded?.find((x) => x.name === S2), s4 = sl.superseded?.find((x) => x.name === S4);
  chk("S1 대체된 이웃은 links.superseded 에(나가는·들어오는, 후속 포함)",
    s2?.direction === "outgoing" && s2?.relation === "related" && s2?.superseded_by === S3 && s4?.direction === "incoming" && s4?.superseded_by === S3,
    show(sl.superseded));
  chk("S1 outgoing·incoming 에서는 빠진다", !sl.outgoing.some((x) => x.name === S2) && !sl.incoming.some((x) => x.name === S4), show(sl));
  const gs1 = await kget(S1);
  chk("S1 knowledge_get 응답의 links.superseded", gs1.ok && gs1.v.knowledge.links?.superseded?.length === 2, show(gs1.ok ? gs1.v.knowledge.links : gs1));

  // ── V 공개범위 — 지식 축을 켜고 members(대상 없음)로 잠근다 ──
  const [W1, W2, S5] = [k("w1"), k("w2"), k("s5")];
  for (const n of [W1, W2, S5]) await mk(n);
  await kst.linkKnowledge(W1, W2, "contradicts", { actor: ME, source: "web" });
  await kst.linkKnowledge(S1, S5, "related", { actor: ME, source: "web" });
  await kst.setKnowledgeLifecycle(S5, "superseded", { actor: ME, source: "web" }, { supersededBy: S3 });
  await q(`UPDATE knowledge SET visibility='members' WHERE name = ANY($1::text[])`, [[W2, S3, S5]]);
  await setVisAxes({ knowledge: true });
  invalidateVisibilityCache();
  const gw = await kget(W1, OTHER);
  chk("V1 안 보이는 모순 이웃은 경고에서 빠진다", gw.ok && !("contradicts_warning" in gw.v), show(gw.ok ? gw.v.contradicts_warning : gw));
  const vl = await kst.listKnowledgeLinks(S1, OTHER);
  chk("V1 안 보이는 대체 이웃은 빠지고, 안 보이는 후속은 null",
    !vl.superseded?.some((x) => x.name === S5) && vl.superseded?.find((x) => x.name === S2)?.superseded_by === null, show(vl.superseded));
  const vp = await kst.listKnowledgeLinks(S1, null);
  chk("V1 특권 조회는 그대로", vp.superseded?.find((x) => x.name === S2)?.superseded_by === S3 && vp.superseded?.some((x) => x.name === S5), show(vp.superseded));
  });
  await setVisAxes({ knowledge: false });
  invalidateVisibilityCache();

  await section("P·M·A", async () => {
  // ── P 발견 적용(한 트랜잭션) ──
  const [CA, CB, CC, CDEP] = [`${TAG}-pa`, `${TAG}-pb`, `${TAG}-pc`, `${TAG}-pdep`];
  const ca = await mkCat(CA), cb = await mkCat(CB), cc = await mkCat(CC), cdep = await mkCat(CDEP, "deprecated");
  const MP = await mstore.upsertManager({ key: `${TAG}-mp`, kind: "mismatch", enabled: true, action_level: "propose" }, ME, "web");
  const mkIn = async (name, catKey) => mk(name, { category: catKey });
  const mv = (name, from, to) => ({ op: "move_category", name, from_category_id: from, to_category_id: to });
  const [P1n, P2n, P3n, P4n] = [k("p1"), k("p2"), k("p3"), k("p4")];
  await mkIn(P1n, CA); await mkIn(P2n, CA); await mkIn(P3n, CC); await mkIn(P4n, CA);
  const F1 = await insFinding(MP.id, "mismatch", P1n, `${CA}->${CB}`, "open", mv(P1n, ca, cb));
  const ap1 = await attempt(() => applyCap.handler({ ids: [F1] }, user(ME), web(ME)));
  chk("P1 일괄 적용 — 분류를 옮기고 accepted", ap1.ok && ap1.v.applied === 1 && (await findingById(F1)).state === "accepted" && show(await catOf(P1n)) === show([cb]),
    show({ ap1, f: await findingById(F1), c: await catOf(P1n) }));
  const F2 = await insFinding(MP.id, "mismatch", P2n, `${CA}->${CB}`, "open", mv(P2n, ca, cb));
  const hold = await otherConn();
  await hold.query("BEGIN");
  await hold.query(`UPDATE org_manager_finding SET state='rejected', resolved_at=now(), resolved_by='사람' WHERE id=$1`, [F2]);
  const ap2p = attempt(() => applyCap.handler({ ids: [F2] }, user(ME), web(ME)));
  await waitingOnLock(1);
  await hold.query("COMMIT"); await hold.end();
  const ap2 = await ap2p;
  chk("P2 적용 도중 반려되면 적용하지 않는다 — 분류 그대로 · rejected 유지",
    ap2.ok && (await findingById(F2)).state === "rejected" && show(await catOf(P2n)) === show([ca]), show({ ap2, f: await findingById(F2), c: await catOf(P2n) }));
  const F3 = await insFinding(MP.id, "mismatch", P3n, `${CA}->${CB}`, "open", mv(P3n, ca, cb));
  const F4 = await insFinding(MP.id, "mismatch", P4n, `${CA}->${CDEP}`, "open", mv(P4n, ca, cdep));
  await attempt(() => applyCap.handler({ ids: [F3, F4] }, user(ME), web(ME)));
  const f3 = await findingById(F3), f4 = await findingById(F4);
  chk("P3 분류가 이미 바뀌었으면 옮기지 않고 「분류 변경으로 해소」", f3.state === "resolved" && f3.resolution === "분류 변경으로 해소" && show(await catOf(P3n)) === show([cc]), show({ f3, c: await catOf(P3n) }));
  chk("P4 옮길 분류가 활성이 아니면 같다", f4.state === "resolved" && show(await catOf(P4n)) === show([ca]), show({ f4, c: await catOf(P4n) }));

  // ── M · A3 mismatch — 벡터를 직접 둔다 ──
  await q(`UPDATE category SET embedding_vector=$2::vector WHERE id=$1`, [ca, vec(1, 0, 0)]);
  await q(`UPDATE category SET embedding_vector=$2::vector WHERE id=$1`, [cb, vec(0, 1, 0)]);
  await q(`UPDATE category SET embedding_vector=$2::vector WHERE id=$1`, [cdep, vec(0, 0, 1)]);
  const [MM1, MM2] = [k("mm1"), k("mm2")];
  await mkIn(MM1, CA); await mkIn(MM2, CA);
  await q(`UPDATE knowledge SET embedding_vector=$2::vector WHERE name=$1`, [MM1, vec(0.1, 1, 0)]);
  await q(`UPDATE knowledge SET embedding_vector=$2::vector WHERE name=$1`, [MM2, vec(0, 0.6, 1)]);
  const MMm = await mstore.upsertManager({ key: `${TAG}-mm`, kind: "mismatch", enabled: true, match_categories: [CA, CB, CDEP] }, ME, "web");
  const dm = await det.detectMismatch(MMm, 50);
  const d2 = dm.find((f) => f.target_ref === MM2);
  chk("M1 근접 후보는 활성 분류만 — deprecated 로 옮기라고 하지 않는다", d2 && d2.dedup_key === `${CA}->${CB}` && d2.proposed_action?.to_category_id === cb, show(dm));

  // ── A 재판정 ──
  const MO = await mstore.upsertManager({ key: `${TAG}-mo`, kind: "outdated", enabled: true, match_categories: [CK], stale_days: 30 }, ME, "web");
  const CK2 = `${TAG}-out`;
  await mkCat(CK2);
  const [O1, O2, O3, O4, O5, O6] = [k("o1"), k("o2"), k("o3"), k("o4"), k("o5"), k("o6")];
  for (const n of [O1, O2, O3, O4, O6]) await mk(n);
  await mk(O5, { category: CK2 });
  const src = async (name, relation) => {
    const id = Number((await q(`INSERT INTO source(kind, title, body_md, occurred_at, updated_at) VALUES('other', $1, 'b', now(), now()) RETURNING id`, [name]))[0].id);
    await q(`INSERT INTO knowledge_source(name, source_id, relation, created_at) VALUES($1,$2,$3,now())`, [name, id, relation]);
  };
  for (const n of [O1, O2, O3, O5, O6]) await src(n, "derived_from");
  await src(O4, "cites");
  const age = async (name) => {
    await q(`UPDATE knowledge SET updated_at=now() - interval '60 days' WHERE name=$1`, [name]);
    await attempt(() => q(`UPDATE knowledge SET body_updated_at=now() - interval '60 days' WHERE name=$1`, [name]));
  };
  for (const n of [O1, O2, O3, O4, O5, O6]) await age(n);
  const FO4 = await insFinding(MO.id, "outdated", O4, "", "open", null, "now() - interval '1 day'");
  const FO5 = await insFinding(MO.id, "outdated", O5, "", "open");
  await q(`UPDATE knowledge SET body_md='고친 본문' WHERE name=$1`, [O6]);   // 성립하지 않는 반려 발견
  const FO6 = await insFinding(MO.id, "outdated", O6, "", "rejected");
  const MMF = (await findingRows(MMm.id, MM1, `${CA}->${CB}`))[0];

  const run = (m) => attempt(() => runCap.handler({ key: m.key }, user(ME), web(ME)));
  const run1 = await run(MO);
  const fo = async (name) => (await q(`SELECT id, state, resolution FROM org_manager_finding WHERE manager_id=$1 AND target_ref=$2`, [MO.id, name]))[0];
  chk("A0 스위치가 꺼져 있으면 닫지 않는다", run1.ok && run1.v.resolved === undefined && (await findingById(FO4)).state === "open", show({ run1, f: await findingById(FO4) }));
  const fo2 = await fo(O2);
  chk("A0 (전제) 탐지가 열었다", (await fo(O1))?.state === "open" && fo2?.state === "open" && (await fo(O3))?.state === "open", show({ o1: await fo(O1), o2: fo2, o3: await fo(O3) }));

  await rc.updateRuntimeConfig({ ontology_loops: { l2_autoresolve: true } }, ME, "web");
  await rc.updateRuntimeConfig({ inject_ontology_guide: true }, ME, "web");
  chk("A0 스위치 저장 — 다른 설정 저장에도 그대로", (await rc.getRuntimeConfig()).ontology_loops?.l2_autoresolve === true, show((await rc.getRuntimeConfig()).ontology_loops));

  await sleep(20);
  await mk(O2, { body_md: "본문 고침" });
  await q(`UPDATE knowledge SET title='제목만', updated_at=now() WHERE name=$1`, [O3]);
  const run2 = await run(MO);
  const [a1, a2, a3, a4, a5] = [await fo(O1), await fo(O2), await fo(O3), await findingById(FO4), await findingById(FO5)];
  chk("A1 본문을 고치면 「본문 갱신으로 해소」", a2?.state === "resolved" && a2?.resolution === "본문 갱신으로 해소", show({ run2, a2 }));
  chk("A1 판정식 밖(cites)이 된 발견은 「판정 기준 변경으로 해소」", a4?.state === "resolved" && a4?.resolution === "판정 기준 변경으로 해소", show(a4));
  chk("A2 메타데이터만 바뀐 지식은 열린 채 · 성립하는 발견도 열린 채", a3?.state === "open" && a1?.state === "open", show({ a1, a3 }));
  chk("A2 스코프 밖이어도 성립하면 열린 채", a5?.state === "open", show(a5));
  chk("A2 반려된 발견은 그대로", (await findingById(FO6)).state === "rejected", show(await findingById(FO6)));
  chk("A1 실행 요약에 닫은 수", run2.ok && run2.v.resolved === 2, show(run2));

  const gr1 = await kget(O1), gr4 = await kget(O4);
  chk("R1 열린 outdated 발견 → review_hint", gr1.ok && gr1.v.review_hint?.[0]?.kind === "outdated" && Number(gr1.v.review_hint[0].finding_id) === Number(a1?.id), show(gr1.ok ? gr1.v.review_hint : gr1));
  chk("R1 닫힌 발견은 review_hint 없음", gr4.ok && !("review_hint" in gr4.v), show(gr4.ok ? gr4.v.review_hint : gr4));

  await q(`UPDATE knowledge SET body_updated_at=now() - interval '60 days', updated_at=now() - interval '60 days' WHERE name=$1`, [O2]);
  await run(MO);
  chk("A4 다시 성립하면 다음 탐지가 다시 연다", (await fo(O2))?.state === "open", show(await fo(O2)));

  chk("A3 (전제) mismatch 발견이 열려 있다", MMF?.state === "open" || (await det.detectMismatch(MMm, 50)).some((f) => f.target_ref === MM1), show(MMF));
  await run(MMm);
  const mmOpen = (await q(`SELECT id, state FROM org_manager_finding WHERE manager_id=$1 AND target_ref=$2`, [MMm.id, MM1]))[0];
  await q(`DELETE FROM knowledge_category WHERE name=$1`, [MM1]);
  await q(`INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1,$2,'manual','confirmed')`, [MM1, cb]);
  await run(MMm);
  const mmAfter = await findingById(mmOpen?.id);
  chk("A3 분류를 옮기면 「분류 변경으로 해소」", mmOpen?.state === "open" && mmAfter?.state === "resolved" && mmAfter?.resolution === "분류 변경으로 해소", show({ mmOpen, mmAfter }));
  });
} catch (e) {
  fail++; console.error("FAIL 예외 —", e);
} finally {
  await itemsPool.end().catch(() => undefined);
  if (!process.env.KEEP_TEST_DB) await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await su.end().catch(() => undefined);
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
