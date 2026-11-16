// 하네스 자산 저장 시점 위험 패턴 차단 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서(.github/workflows/test.yml), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/capabilities/delivery/harness-asset-risk.pg-test.mjs
//
// 왜 이 계층인가: 규칙 자체는 순수 유닛(org/harness-asset-risk.test.ts)이 지킨다. 여기서 보는 것은 배선이다 —
//  정책 칸을 실제로 읽어 막는가, 막힌 저장이 DB 를 건드리지 않는가, risk_ack 가 감사에 남는가, 그리고
//  «꺼진 자산을 enabled:true 만 보내 켜는» 저장이 저장된 본문으로 검사되는가(초안 승격 검사를 건너뛰는 길).
//  전부 저장된 행·감사 행을 read-back 해서 판정한다.
//
//  엣지 표: H1 꺼짐 → 저장 + 경고 · H2 정책 바꾸기(바뀔 때만 감사) · H3 켜짐 + ack 없음 → 400, 행 그대로 ·
//   H4 켜짐 + ack → 저장 + risk_ack 감사 · H5 깨끗한 본문은 검사 흔적 없음 · H6 꺼진 자산 켜기 = 저장된 본문 검사 ·
//   H7 이미 켜진 자산의 표시 칸만 고치면 검사 안 함 · H8 초안 승격도 검사(막히면 초안 보존) · H9 목록에 risk_policy.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { harnessAssetsCapabilities } = await import(`${DIST}/capabilities/delivery/harness-assets.js`);
const store = await import(`${DIST}/org/store/harness-assets.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "hrisk-pg-";
const ACTOR = "__hrisk_pg_actor";
const admin = { userId: ACTOR, email: "", scopes: ["admin"], projects: ["*"] };
const ctx = { source: "web" };
const cap = (n) => harnessAssetsCapabilities.find((c) => c.name === n);
const upsert = (input) => cap("org_harness_asset_upsert").handler(input, admin, ctx);
const setPolicy = (block) => cap("org_harness_asset_risk_policy_set").handler({ block }, admin, ctx);
const RISKY = "# 설치\n\n```sh\ndocker run --privileged img\n```\n";
const rejectOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const auditRows = async (op, key) => (await itemsPool.query(
  `SELECT entity, entity_key, op, after FROM org_content_audit WHERE actor=$1 AND op=$2 AND ($3::text IS NULL OR entity_key=$3) ORDER BY id`,
  [ACTOR, op, key ?? null])).rows;

const orig = (await itemsPool.query(`SELECT block_risky_harness_assets FROM org_runtime_config WHERE id=1`)).rows[0];
if (!orig) throw new Error("org_runtime_config 에 id=1 행이 없다(스키마 준비가 덜 됐다)");
async function cleanup() {
  await itemsPool.query(`DELETE FROM org_harness_asset WHERE left(id, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE actor=$1`, [ACTOR]);
  await itemsPool.query(`UPDATE org_runtime_config SET block_risky_harness_assets=$1 WHERE id=1`, [orig.block_risky_harness_assets]);
}

try {
  await cleanup();
  await itemsPool.query(`UPDATE org_runtime_config SET block_risky_harness_assets=FALSE WHERE id=1`);

  // H1 꺼짐 — 저장되고, 응답에 경고가 실리고, risk_ack 감사는 없다.
  {
    const r = await upsert({ id: `${P}warn`, kind: "skill", body: RISKY });
    const row = await store.getOrgHarnessAsset(`${P}warn`);
    chk("H1 꺼짐 → 저장", row?.body === RISKY, JSON.stringify(row?.body));
    chk("H1 꺼짐 → risk_findings 경고 1건(body 4행)", r.risk_findings?.length === 1 && r.risk_findings[0].rule === "docker-privileged"
      && r.risk_findings[0].field === "body" && r.risk_findings[0].line === 4 && r.risk_acked === false, JSON.stringify(r.risk_findings));
    chk("H1 꺼짐 → risk_ack 감사 없음", (await auditRows("risk_ack")).length === 0);
  }

  // H2 정책 바꾸기 — 바뀔 때만 감사.
  {
    const a = await setPolicy(true);
    const b = await setPolicy(true);
    const rows = await auditRows("block_risky_harness_assets");
    chk("H2 켜기 changed · 같은 값 다시 = unchanged", a.changed === true && a.risk_policy === "block" && b.changed === false, JSON.stringify([a, b]));
    chk("H2 감사 1행(false→true)", rows.length === 1 && rows[0].after === true, JSON.stringify(rows));
    const bad1 = await rejectOf(() => cap("org_harness_asset_risk_policy_set").handler({ block: "yes" }, admin, ctx));
    chk("H2 block 이 불리언 아니면 400(도구 입력 계약)", bad1?.status === 400, String(bad1));
  }

  // H3 켜짐 + ack 없음 — 400, 화면이 분기할 body, 기존 행은 그대로.
  {
    await store.upsertOrgHarnessAsset({ id: `${P}block`, kind: "skill", body: "깨끗한 본문", enabled: true }, { actor: ACTOR, source: "web" });
    const e = await rejectOf(() => upsert({ id: `${P}block`, body: RISKY }));
    const row = await store.getOrgHarnessAsset(`${P}block`);
    chk("H3 400 + risk_ack_allowed + risk_findings", e?.status === 400 && e.body?.risk_ack_allowed === true && e.body?.risk_findings?.length === 1,
      JSON.stringify({ s: e?.status, b: e?.body }));
    chk("H3 막힌 저장은 행을 건드리지 않는다", row?.body === "깨끗한 본문" && row?.version === 1, JSON.stringify({ b: row?.body, v: row?.version }));
    //  parseRiskAck 유닛과 같은 입력이지만 여기서는 핸들러 배선을 본다 — 원문을 그대로 넘기면 공백 사유로 감사 없이 저장된다.
    const blank = await rejectOf(() => upsert({ id: `${P}block`, body: RISKY, risk_ack: "   " }));
    chk("H3 공백뿐인 risk_ack 는 사유 없음(핸들러 배선)", blank?.status === 400, String(blank));
  }

  // H4 켜짐 + ack — 저장되고, 사유·규칙·위치가 감사에 남는다.
  {
    const r = await upsert({ id: `${P}block`, body: RISKY, risk_ack: "  예시 코드블록 — 실행 안 함  " });
    const row = await store.getOrgHarnessAsset(`${P}block`);
    const rows = await auditRows("risk_ack", `${P}block`);
    const f = rows[0]?.after?.findings ?? [];
    chk("H4 저장 + risk_acked", row?.body === RISKY && r.risk_acked === true, JSON.stringify({ b: row?.body, r: r.risk_acked }));
    //  jsonb 는 키 순서를 제 식으로 저장한다 — 칸별로 견준다.
    chk("H4 risk_ack 감사 1행 — 사유(trim)·규칙·위치", rows.length === 1 && rows[0].entity === "org_harness_asset"
      && rows[0].after?.reason === "예시 코드블록 — 실행 안 함"
      && f.length === 1 && f[0].rule === "docker-privileged" && f[0].field === "body" && f[0].line === 4, JSON.stringify(rows));
  }

  // H5 깨끗한 본문 — 응답에 검사 흔적이 없다.
  {
    const r = await upsert({ id: `${P}clean`, kind: "skill", body: "docker run img" });
    chk("H5 깨끗 → risk_findings 키 없음", !("risk_findings" in r) && r.asset?.id === `${P}clean`, JSON.stringify(Object.keys(r)));
  }

  // H6 꺼진 자산을 enabled:true 만 보내 켠다 — 보내지 않은 본문도 저장된 값으로 검사한다.
  {
    await store.upsertOrgHarnessAsset({ id: `${P}off`, kind: "skill", body: RISKY, enabled: false }, { actor: ACTOR, source: "web" });
    const e = await rejectOf(() => upsert({ id: `${P}off`, enabled: true }));
    const still = await store.getOrgHarnessAsset(`${P}off`);
    chk("H6 꺼진 위험 자산 켜기 → 400, 여전히 꺼짐", e?.status === 400 && still?.enabled === false, JSON.stringify({ s: e?.status, en: still?.enabled }));
    await upsert({ id: `${P}off`, enabled: true, risk_ack: "검토함" });
    chk("H6 ack 로 켜기 → 켜짐", (await store.getOrgHarnessAsset(`${P}off`))?.enabled === true);
  }

  // H7 이미 켜진 위험 자산의 표시 칸만 고친다 — 다시 검사하지 않는다(정책을 켜도 기존 자산 운영이 안 막힌다).
  {
    await store.upsertOrgHarnessAsset({ id: `${P}legacy`, kind: "skill", body: RISKY, enabled: true }, { actor: ACTOR, source: "web" });
    const r = await upsert({ id: `${P}legacy`, summary: "한 줄 설명" });
    chk("H7 summary 만 수정 → 저장 · 경고 없음", r.asset?.summary === "한 줄 설명" && !("risk_findings" in r), JSON.stringify(Object.keys(r)));
  }

  // H8 초안 승격 — 검사하고, 막히면 초안을 지우지 않는다.
  {
    await store.upsertOrgHarnessAsset({ id: `${P}draft`, kind: "skill", body: RISKY, enabled: false }, { actor: ACTOR, source: "web" });
    const adopt = (extra) => cap("org_harness_asset_adopt").handler({ draft_id: `${P}draft`, new_id: `${P}adopted`, ...extra }, admin, ctx);
    const e = await rejectOf(() => adopt({}));
    chk("H8 위험 초안 승격 → 400, 초안 보존 · 새 자산 없음", e?.status === 400 && !!(await store.getOrgHarnessAsset(`${P}draft`))
      && !(await store.getOrgHarnessAsset(`${P}adopted`)), String(e));
    const r = await adopt({ risk_ack: "검토함" });
    chk("H8 ack 로 승격 → 새 자산 · 초안 제거 · risk_ack 감사", r.asset?.id === `${P}adopted` && r.risk_acked === true
      && !(await store.getOrgHarnessAsset(`${P}draft`)) && (await auditRows("risk_ack", `${P}adopted`)).length === 1, JSON.stringify(Object.keys(r)));
  }

  // H9 목록이 지금 정책을 보여 준다.
  {
    const r = await cap("org_harness_assets").handler({}, admin, ctx);
    chk("H9 org_harness_assets.risk_policy = block", r.risk_policy === "block", r.risk_policy);
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  await cleanup().catch((e) => bad("cleanup", String(e)));
  await itemsPool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
