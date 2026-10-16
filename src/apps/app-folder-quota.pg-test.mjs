// 앱 폴더 상한 · 사용량(#4785 앱 v2-20) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-folder-quota.pg-test.mjs
//
// 한 프로세스에 게이트웨이를 띄운다 — 진짜 인증(구성원 토큰) · 능력 REST(권한 범위 검사 포함). CP 의 쿼터 정비가 부르는 두 길
//  (상한 목록 · 사용량 보내기)은 운영 토큰과 같은 관리자 토큰으로 부른다.
//  P1 책임자가 상한을 건다 — 저장 · 응답 칸(can_set) · 감사      P2 관리자도 된다 · 남(책임자도 관리자도 아님) 403 · 못 보는 «나만» 앱 404
//  P3 상한 값 — 0 · 최댓값 + 1 · 소수 · 빠뜨린 값 · 틀린 키 · 빈 글 400(걸어 둔 상한 그대로) · null 은 없앰
//  P4 상한 목록 — 관리자만(구성원 403) · 설치된 앱 전부 · 값
//  P5 사용량 — 80% 를 처음 넘으면 책임자 + 관리자에게 알림 한 장씩 · 같은 단계는 다시 안 알림 · 100% 는 새로 · 내려가면 단계를 낮춰
//     다시 넘을 때 또 알린다 · 경계에서 오르내리면 다시 안 알림 · 없는 앱 건너뜀 · 상한 없는 앱은 알리지 않는다 · 구성원 403
//     단계 기록은 알림이 저장된 뒤에 오른다(받는 사람을 못 읽었거나 다 실패하면 다음 판에 다시) · 겹친 보고는 한 쪽만 알린다
//  P6 앱 목록 · 상세의 folder 칸 — 쓰는 양 · 걸린 상한 · 단계 · 바꿀 수 있나(책임자 true · 남 false) · 이 배포가 거나
//  P7 새 상한이 지금 쓰는 양보다 작으면 경고를 싣는다 · 단계는 정비 전까지 걸린 상한으로 낸다      P8 앱을 지우면 사용량 행도 지운다
//  P9 롤 중 마이그레이션 전 창(표 · 열 없음) — CP 두 길은 404 · 앱 지우기는 막히지 않는다
import pg from "pg";
import http from "node:http";
import crypto from "node:crypto";
import "../../scripts/test-apps-root.mjs";   // #4778 앱 폴더 자리를 임시 폴더로 — 앱을 만들고 지우는 시험이 실제 ~/apps 를 옮기지 않게

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_folder_quota_4785";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
process.env.CONNECTOR_SECRET_KEY = crypto.randomBytes(32).toString("hex");
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE"]) delete process.env[k];

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const GiB = 1024 ** 3;
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const J = (x) => JSON.stringify(x);

let server = null, itemsPool = null;
try {
  const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
  await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG — 렉시컬 폴백 */ });
  await dbc.end();
  const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
  await initAllSchemas({ quiet: true });
  ({ itemsPool } = await import(`${D}/db/client.js`));
  const express = (await import("express")).default;
  const { registerWebUi } = await import(`${D}/web.js`);
  const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
  const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
  const { upsertMember } = await import(`${D}/org/store/members.js`);
  const { mintToken } = await import(`${D}/org/store/tokens.js`);
  const cap = (n) => appCapabilities.find((c) => c.name === n);
  const admin = { userId: "pgt-admin", email: "a@x", scopes: ["admin", "items"] };
  const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;

  await upsertMember({ id: "pgt-admin", display_name: "관리자", state: "active", scopes: ["admin", "items"] }, "pgt");
  for (const id of ["pgt-alice", "pgt-bob", "pgt-carol"]) await upsertMember({ id, display_name: id, state: "active", scopes: ["items"] }, "pgt");
  const install = (id) => cap("org_app_install").handler({ source: { kind: "inline", files: [
    { path: "lively-app.json", content: J({ id, title: `앱 ${id}`, version: "0.1.0", ui: { pages: [{ key: "main", title: id, entry: "ui/index.html" }] } }) },
    { path: "ui/index.html", content: "<p>x</p>" }] } }, admin, { source: "mcp" });
  for (const id of ["crm", "memo", "secret", "note", "race"]) await install(id);
  await q(`UPDATE org_app SET owner_member='pgt-alice' WHERE id IN ('crm','memo','note','race')`);
  await q(`UPDATE org_app SET owner_member='pgt-carol', visibility='me' WHERE id='secret'`);   // carol 의 «나만» 앱

  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  registerWebUi(gw, new BearerVerifier());
  server = http.createServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const GW = `http://127.0.0.1:${server.address().port}`;
  const tok = {};
  for (const [id, scopes] of [["pgt-admin", ["admin", "items"]], ["pgt-alice", ["items"]], ["pgt-bob", ["items"]]]) {
    tok[id] = (await mintToken({ userId: id, memberId: id, scopes }, "pgt")).token;
  }
  const call = async (who, method, path, body) => {
    const r = await fetch(GW + path, { method, headers: { authorization: `Bearer ${tok[who]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: J(body) }) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 비JSON */ }
    return { status: r.status, json, text };
  };
  const limitOf = async (id) => (await q(`SELECT folder_limit_gb FROM org_app WHERE id=$1`, [id]))[0]?.folder_limit_gb ?? null;

  // ── P1 ──
  const p1 = await call("pgt-alice", "POST", "/api/ui/apps/crm/folder-limit", { limit_gb: 5 });
  const audits = await q(`SELECT count(*)::int AS n FROM org_content_audit WHERE entity='org_app' AND entity_key='crm' AND actor='pgt-alice'
    AND (after->>'folder_limit_gb')::int = 5`).catch(() => [{ n: -1 }]);
  chk("P1 책임자가 상한을 건다 — 저장(5) · 응답 folder 칸(can_set · 아직 안 잼) · 감사 행", p1.status === 200 && (await limitOf("crm")) === 5
    && p1.json?.folder?.limit_gb === 5 && p1.json?.folder?.can_set === true && p1.json?.folder?.used_bytes === null && audits[0].n >= 1,
    J({ p1: p1.json ?? p1.text, audits }));

  // ── P2 ──
  const p2a = await call("pgt-admin", "POST", "/api/ui/apps/memo/folder-limit", { limit_gb: 2 });
  const p2b = await call("pgt-bob", "POST", "/api/ui/apps/crm/folder-limit", { limit_gb: 50 });
  const p2c = await call("pgt-bob", "POST", "/api/ui/apps/secret/folder-limit", { limit_gb: 1 });
  chk("P2 관리자도 건다 · 남(책임자도 관리자도 아님)은 403 · 못 보는 «나만» 앱은 404 · 값은 그대로",
    p2a.status === 200 && (await limitOf("memo")) === 2 && p2b.status === 403 && (await limitOf("crm")) === 5 && p2c.status === 404 && (await limitOf("secret")) === null,
    J([p2a.status, p2b.status, p2c.status]));

  // ── P3 ──
  const bad = await Promise.all([{ limit_gb: 0 }, { limit_gb: 1001 }, { limit_gb: 1.5 }, {}, { limitGb: 7 }, { limit_gb: "" }]
    .map((b) => call("pgt-alice", "POST", "/api/ui/apps/crm/folder-limit", b)));
  const clear = await call("pgt-alice", "POST", "/api/ui/apps/memo/folder-limit", { limit_gb: null });
  chk("P3 0 · 최댓값 + 1(1001) · 소수 · 빠뜨린 값 · 틀린 키 · 빈 글은 400(걸어 둔 5 그대로) · null 만 상한을 없앤다",
    bad.every((r) => r.status === 400) && (await limitOf("crm")) === 5 && clear.status === 200 && (await limitOf("memo")) === null,
    J({ bad: bad.map((r) => r.status), crm: await limitOf("crm"), clear: clear.status }));

  // ── P4 ──
  const p4 = await call("pgt-admin", "GET", "/api/ui/app-folder-limits");
  const p4m = await call("pgt-bob", "GET", "/api/ui/app-folder-limits");
  const lim = Object.fromEntries((p4.json?.apps ?? []).map((a) => [a.app_id, a.limit_gb]));
  chk("P4 상한 목록 — 관리자만(구성원 403) · 설치된 앱 전부(나만 보는 앱 포함) · 값",
    p4.status === 200 && lim.crm === 5 && lim.memo === null && "secret" in lim && p4m.status === 403, J({ p4: p4.json, p4m: p4m.status }));

  // ── P5 ──
  const report = (apps) => call("pgt-admin", "POST", "/api/ui/app-folder-usage", { apps });
  const notes = async () => (await q(`SELECT member_id, dedupe_key FROM org_app_notification WHERE app_id='crm' AND dedupe_key LIKE 'app-folder-%' ORDER BY created_at, member_id`))
    .map((r) => `${r.dedupe_key}>${r.member_id}`);
  const r78 = await report([{ app_id: "crm", used_bytes: Math.floor(3.9 * GiB), limit_gb: 5 }]);
  const n0 = await notes();
  const r82 = await report([{ app_id: "crm", used_bytes: Math.floor(4.1 * GiB), limit_gb: 5 }, { app_id: "ghost", used_bytes: 1, limit_gb: 1 },
    { app_id: "memo", used_bytes: 900 * GiB, limit_gb: null }]);
  const n1 = await notes();
  const r84 = await report([{ app_id: "crm", used_bytes: Math.floor(4.2 * GiB), limit_gb: 5 }]);
  const n2 = await notes();
  const r100 = await report([{ app_id: "crm", used_bytes: 5 * GiB, limit_gb: 5 }]);
  const n3 = await notes();
  chk("P5a 78% 는 알리지 않는다 · 82% 를 처음 넘으면 책임자(alice) + 관리자에게 한 장씩 · 없는 앱은 건너뛰고 · 상한 없는 앱은 알리지 않는다",
    r78.status === 200 && r78.json?.stored === 1 && n0.length === 0 && r82.json?.stored === 2
      && J(r82.json?.notified) === J([{ app_id: "crm", level: 80 }]) && J(n1) === J(["app-folder-80:crm>pgt-admin", "app-folder-80:crm>pgt-alice"]),
    J({ r78: r78.json, r82: r82.json, n0, n1 }));
  chk("P5b 같은 단계(84%)는 다시 안 알리고 · 100% 는 새로 알린다", J(r84.json?.notified) === "[]" && n2.length === 2
    && J(r100.json?.notified) === J([{ app_id: "crm", level: 100 }]) && n3.filter((x) => x.startsWith("app-folder-100:")).length === 2, J({ r84: r84.json, r100: r100.json, n3 }));
  const down = await report([{ app_id: "crm", used_bytes: 1 * GiB, limit_gb: 5 }]);
  const lvl = (await q(`SELECT warned_level FROM org_app_folder_usage WHERE app_id='crm'`))[0]?.warned_level;
  const again = await report([{ app_id: "crm", used_bytes: Math.floor(4.5 * GiB), limit_gb: 5 }]);
  chk("P5c 내려가면 단계를 낮추고(0) 다시 80% 를 넘으면 또 알린다(알림 저장은 1분 쿨다운 — 판정만 본다)",
    J(down.json?.notified) === "[]" && lvl === 0 && J(again.json?.notified) === J([{ app_id: "crm", level: 80 }]), J({ down: down.json, lvl, again: again.json }));
  const p5m = await call("pgt-bob", "POST", "/api/ui/app-folder-usage", { apps: [{ app_id: "crm", used_bytes: 0, limit_gb: 5 }] });
  chk("P5d 사용량 보내기는 관리자만(구성원 403)", p5m.status === 403, String(p5m.status));
  const warnedOf = async (id) => (await q(`SELECT warned_level FROM org_app_folder_usage WHERE app_id=$1`, [id]))[0]?.warned_level ?? null;
  const r75 = await report([{ app_id: "crm", used_bytes: Math.floor(3.75 * GiB), limit_gb: 5 }]);
  const w75 = await warnedOf("crm");
  const r81 = await report([{ app_id: "crm", used_bytes: Math.floor(4.05 * GiB), limit_gb: 5 }]);
  const r90 = await report([{ app_id: "crm", used_bytes: Math.floor(4.5 * GiB), limit_gb: 5 }]);
  chk("P5e 경계에서 오르내려도(90% → 75% → 81% → 90%) 다시 알리지 않는다 — 80 단계는 70% 아래로 내려가야 놓는다",
    J(r75.json?.notified) === "[]" && w75 === 80 && J(r81.json?.notified) === "[]" && J(r90.json?.notified) === "[]",
    J({ r75: r75.json, w75, r81: r81.json, r90: r90.json }));
  //  받는 사람을 못 읽은 판 · 알림이 다 실패한 판 — 단계 기록을 올리지 않아 다음 판에 다시 알린다(능력 함수를 대역 의존으로 직접 부른다).
  const { recordAppFolderUsage } = await import(`${D}/apps/app-folder-quota.js`);
  const { getAppsByIds } = await import(`${D}/org/store/apps.js`);
  const noteRow = [{ app_id: "note", used_bytes: Math.floor(1.7 * GiB), limit_gb: 2 }];   // 85%
  const sent = [];
  const okNotify = async (n) => { sent.push(n.memberId); return { ok: true }; };
  const f1 = await recordAppFolderUsage(noteRow, { apps: getAppsByIds, admins: async () => { throw new Error("db down"); }, notify: okNotify });
  const w1 = await warnedOf("note"); const sent1 = sent.length;
  const f2 = await recordAppFolderUsage(noteRow, { apps: getAppsByIds, admins: async () => ["pgt-admin"], notify: async () => ({ ok: false }) });
  const w2 = await warnedOf("note");
  const f3 = await recordAppFolderUsage(noteRow, { apps: getAppsByIds, admins: async () => ["pgt-admin"], notify: okNotify });
  const w3 = await warnedOf("note");
  chk("P5f 단계 기록은 알림이 저장된 뒤에 오른다 — 관리자 목록을 못 읽은 판은 책임자에게도 안 보내고 기록 그대로 · 다 실패한 판도 그대로 · 다음 판에 둘 다 받는다",
    f1.stored === 1 && f1.notified.length === 0 && w1 === 0 && sent1 === 0 && f2.notified.length === 0 && w2 === 0
      && J(f3.notified) === J([{ app_id: "note", level: 80 }]) && w3 === 80 && J([...sent].sort()) === J(["pgt-admin", "pgt-alice"]),
    J({ f1, w1, sent1, f2, w2, f3, w3, sent }));
  //  겹친 보고(CP 리더 교대 · 수동 호출) — 단계는 비교 후 교체라 한 쪽만 이겨 알린다(알림 저장의 1분 쿨다운은 동시에 들어오면 못 막는다).
  const race = await Promise.all(Array.from({ length: 8 }, () => report([{ app_id: "race", used_bytes: Math.floor(1.7 * GiB), limit_gb: 2 }])));
  const raceNotes = (await q(`SELECT member_id FROM org_app_notification WHERE app_id='race' AND dedupe_key='app-folder-80:race' ORDER BY member_id`)).map((r) => r.member_id);
  const winners = race.filter((r) => (r.json?.notified ?? []).length > 0).length;
  chk("P5g 같은 앱 보고 8개가 겹쳐도 알림은 한 번 — 이긴 보고 하나만 notified · 받는 사람마다 한 장 · 단계 80",
    race.every((r) => r.status === 200) && winners === 1 && J(raceNotes) === J(["pgt-admin", "pgt-alice"]) && (await warnedOf("race")) === 80,
    J({ statuses: race.map((r) => r.status), winners, raceNotes, w: await warnedOf("race") }));

  // ── P6 ──
  const listA = await call("pgt-alice", "GET", "/api/ui/apps");
  const listB = await call("pgt-bob", "GET", "/api/ui/apps");
  const getA = await call("pgt-alice", "GET", "/api/ui/apps/crm");
  const fA = (listA.json?.apps ?? []).find((a) => a.id === "crm")?.folder;
  const fB = (listB.json?.apps ?? []).find((a) => a.id === "crm")?.folder;
  chk("P6 목록 · 상세의 folder 칸 — 쓰는 양 · 걸린 상한 · 단계 · 바꿀 수 있나(책임자 true · 남 false) · 이 배포가 거나(셀프호스트 false)",
    fA?.used_bytes === Math.floor(4.5 * GiB) && fA?.applied_limit_gb === 5 && fA?.limit_gb === 5 && fA?.level === 80 && fA?.can_set === true
      && fA?.enforced === false && fA?.stale === false && fB?.can_set === false && fB?.used_bytes === fA?.used_bytes && getA.json?.app?.folder?.level === 80
      && getA.json?.app?.folder?.can_set === true,
    J({ fA, fB, get: getA.json?.app?.folder }));

  // ── P7 ──
  const p7 = await call("pgt-alice", "POST", "/api/ui/apps/crm/folder-limit", { limit_gb: 4 });
  chk("P7 새 상한(4GiB)이 지금 쓰는 양(4.5GiB)보다 작으면 경고를 싣는다(값은 저장)", p7.status === 200 && /더 쓸 수 없습니다/.test(String(p7.json?.warning)) && (await limitOf("crm")) === 4,
    J(p7.json));
  const p7b = (await call("pgt-alice", "GET", "/api/ui/apps/crm")).json?.app?.folder;
  chk("P7b 정비 전(원하는 4 · 걸린 5 · 4.5GiB) 단계는 걸린 상한으로 낸다 — 80 이지 «가득»(100)이 아니다(아직 쓸 수 있다)",
    p7b?.limit_gb === 4 && p7b?.applied_limit_gb === 5 && p7b?.level === 80, J(p7b));

  // ── P8 ──
  await cap("org_app_remove").handler({ app_id: "crm" }, admin, { source: "mcp" });
  const left = await q(`SELECT count(*)::int AS n FROM org_app_folder_usage WHERE app_id='crm'`);
  chk("P8 앱을 지우면 사용량 행도 지운다", left[0].n === 0, J(left));

  // ── P9 ── 롤 중 마이그레이션 전 창(표 · 열이 아직 없다) — CP 두 길은 이 기능 전 코어처럼 404 · 앱 지우기는 막히지 않는다
  await q(`ALTER TABLE org_app_folder_usage RENAME TO org_app_folder_usage_hidden`);
  await q(`ALTER TABLE org_app RENAME COLUMN folder_limit_gb TO folder_limit_gb_hidden`);
  const nl = await call("pgt-admin", "GET", "/api/ui/app-folder-limits");
  const nu = await call("pgt-admin", "POST", "/api/ui/app-folder-usage", { apps: [{ app_id: "memo", used_bytes: 1, limit_gb: null }] });
  let removed = null;
  try { await cap("org_app_remove").handler({ app_id: "memo" }, admin, { source: "mcp" }); removed = true; } catch (e) { removed = String(e?.message ?? e); }
  await q(`ALTER TABLE org_app RENAME COLUMN folder_limit_gb_hidden TO folder_limit_gb`);
  await q(`ALTER TABLE org_app_folder_usage_hidden RENAME TO org_app_folder_usage`);
  chk("P9 표 · 열이 아직 없는 창 — 상한 목록 · 사용량 보내기는 404(CP 가 경보 없이 건너뛴다) · 앱 지우기는 된다",
    nl.status === 404 && nu.status === 404 && removed === true, J({ nl: nl.status, nu: nu.status, removed }));
} catch (e) {
  fail++; console.error("FAIL (예외)", e);
} finally {
  if (server) server.close();
  if (itemsPool) await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
