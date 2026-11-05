// 관리기 분류 보정 적용 · code_drift 후보 · 수집기 끄기 — PG 통합 시험. **실제 Postgres 필요**(기본 npm test 체인 밖).
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/org/manage/manager-apply-collector-stop.pg-test.mjs
//
// 왜 이 계층인가: 세 결함 모두 SQL 이 실제 스키마와 만나는 자리에서만 드러난다.
//  유닛(manager-pure.test)은 move_category 의 거절 경로만 보고 SQL 에 닿지 않는다.
//
//  사양 행:
//   A1 분류 보정(move_category)이 지식당 분류 1행 유니크(knowledge_category_single_uq)에 걸리지 않고 적용된다 —
//      결과 true · 행은 옮긴 분류 하나 · mapped_by='rule'
//   A2 발견 이후 분류가 이미 바뀐 지식에는 적용하지 않는다(false · 행 그대로)
//   D1 code_drift 후보가 mapping 으로 붙은 코드유닛을 센다(unit_count 1) · 코드유닛이 없는 도메인은 후보가 아니다
//   C1 켜진 수집기를 끄면 그 수집기의 진행 중 실행이 canceled 로 닫힌다 · 다른 수집기의 실행은 그대로
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { applyAction } = await import(`${DIST}/org/manage/run-manager.js`);
const { findCodeDriftCandidates } = await import(`${DIST}/org/manage/detectors.js`);
const { upsertCollector } = await import(`${DIST}/org/store/collectors.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = `pgmgr${Date.now().toString(36)}`;
const q = (sql, p) => itemsPool.query(sql, p);
const cat = async (suffix, should = "") =>
  Number((await q(`INSERT INTO category(key, name, origin, should) VALUES($1, $1, 'human', $2) RETURNING id`, [`${TAG}-${suffix}`, should])).rows[0].id);
const know = async (name, categoryId) => {
  await q(`INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility) VALUES($1, $1, '본문', 'authored', 'active', 'open')`, [name]);
  await q(`INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1, $2, 'manual', 'confirmed')`, [name, categoryId]);
};
const rowsOf = async (name) => (await q(`SELECT category_id, mapped_by, state FROM knowledge_category WHERE name=$1`, [name])).rows;

//  정리 대상 — 중간에 예외가 나도 finally 가 지우도록 바깥에 둔다(CI 의 같은 DB 를 다른 pg-test 가 쓴다).
const made = { runs: [], collectors: [], units: [], knowledge: [] };

try {
  // ── A1 · A2 ──
  const a = await cat("a"), b = await cat("b"), c = await cat("c");
  const k1 = `${TAG}-k1`;
  await know(k1, a);
  made.knowledge.push(k1);
  const moved = await applyAction({ op: "move_category", name: k1, from_category_id: a, to_category_id: b }, "pg-test");
  const r1 = await rowsOf(k1);
  chk("A1 분류 보정이 적용된다", moved === true, `applyAction=${moved}`);
  chk("A1 옮긴 분류 한 행만 남는다", r1.length === 1 && Number(r1[0].category_id) === b && r1[0].mapped_by === "rule",
    JSON.stringify(r1));

  const stale = await applyAction({ op: "move_category", name: k1, from_category_id: a, to_category_id: c }, "pg-test");
  const r2 = await rowsOf(k1);
  chk("A2 분류가 이미 바뀐 지식엔 적용하지 않는다", stale === false && r2.length === 1 && Number(r2[0].category_id) === b,
    `applyAction=${stale} rows=${JSON.stringify(r2)}`);

  // ── D1 ──
  const withCode = await cat("dw", "이 도메인은 이렇게 동작해야 한다");
  const noCode = await cat("dn", "코드가 아직 없는 도메인");
  const unit = Number((await q(`INSERT INTO code_unit(repo_id, kind, path, label, created_at, updated_at)
                                VALUES(NULL, 'file', $1, $1, now(), now()) RETURNING id`, [`${TAG}/a.ts`])).rows[0].id);
  made.units.push(unit);
  await q(`INSERT INTO mapping(target_kind, target_id, category_id, origin, status, created_at, updated_at)
           VALUES('code_unit', $1, $2, 'human', 'confirmed', now(), now())`, [unit, withCode]);
  const cands = await findCodeDriftCandidates({ match_categories: [`${TAG}-dw`, `${TAG}-dn`] }, 10);
  chk("D1 코드유닛이 붙은 도메인이 후보로 나온다(unit_count 1)",
    cands.length === 1 && cands[0].category_id === withCode && cands[0].unit_count === 1, JSON.stringify(cands));
  chk("D1 코드유닛이 없는 도메인은 후보가 아니다", !cands.some((x) => x.category_id === noCode), JSON.stringify(cands));

  // ── C1 ──
  //  켜진 행을 SQL 로 직접 만든다 — upsertCollector 로 켜면 첫 수집이 실제로 시작된다.
  const mk = async (suffix) => Number((await q(
    `INSERT INTO org_collector(key, preset_key, instance_key, label, enabled, config, secrets, sync_interval_sec, output_mode, output_config, sort)
     VALUES($1, 'slack', $1, $1, true, '{}'::jsonb, '{}'::jsonb, 600, 'preset', '{}'::jsonb, 0) RETURNING id`, [`${TAG}-${suffix}`])).rows[0].id);
  const off = await mk("off"); made.collectors.push(off);
  const other = await mk("keep"); made.collectors.push(other);
  //  pid 는 살아 있는 프로세스가 아닌 값 — 취소는 «행을 닫는다» 경로를 탄다.
  const run = async (collectorId) => Number((await q(
    `INSERT INTO connector_run(system, collector_id, mode, trigger, status, started_at, pid)
     VALUES('slack', $1, 'full', 'cron', 'running', now(), 2147483646) RETURNING id`, [collectorId])).rows[0].id);
  const runOff = await run(off); made.runs.push(runOff);
  const runOther = await run(other); made.runs.push(runOther);
  await upsertCollector({ id: off, enabled: false }, "pg-test", "test");
  const st = async (id) => (await q(`SELECT status FROM connector_run WHERE id=$1`, [id])).rows[0]?.status;
  chk("C1 끈 수집기의 진행 중 실행이 canceled 로 닫힌다", (await st(runOff)) === "canceled", await st(runOff));
  chk("C1 다른 수집기의 실행은 그대로다", (await st(runOther)) === "running", await st(runOther));

} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  const leftover = (e) => console.warn(`정리 실패 — 시험 데이터가 남았을 수 있다: ${e?.message ?? e}`);
  const ids = made.collectors.map(String);
  await q(`DELETE FROM connector_run WHERE id = ANY($1::bigint[])`, [made.runs]).catch(leftover);
  await q(`DELETE FROM org_cron WHERE id = ANY($1::text[])`, [ids.flatMap((id) => [`collector-${id}`, `collector-${id}-full`])]).catch(leftover);
  await q(`DELETE FROM org_collector WHERE id = ANY($1::int[])`, [made.collectors]).catch(leftover);
  await q(`DELETE FROM mapping WHERE target_kind='code_unit' AND target_id = ANY($1::int[])`, [made.units]).catch(leftover);
  await q(`DELETE FROM code_unit WHERE id = ANY($1::int[])`, [made.units]).catch(leftover);
  await q(`DELETE FROM knowledge WHERE name = ANY($1::text[])`, [made.knowledge]).catch(leftover);
  await q(`DELETE FROM category WHERE key LIKE $1`, [`${TAG}-%`]).catch(leftover);
}

console.log(`\n${pass} pass, ${fail} fail`);
await itemsPool.end().catch(() => {});
process.exit(fail ? 1 : 0);
