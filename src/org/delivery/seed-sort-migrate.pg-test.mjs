// 시드 훅 기본 sort 이행(seed-content.ts LEGACY_SEED_SORT) + 러너 응답(org_runner_hooks)의 sort·concurrent — 실제 Postgres 필요.
//  CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/org/delivery/seed-sort-migrate.pg-test.mjs
//  seedDefaultContent 는 기본 훅·스킬·지식을 통째로 심는다 — 받은 DB(다른 시험과 함께 쓰는 DB)를 더럽히지 않게
//   그 서버에 **임시 데이터베이스**를 만들어 그 안에서 돌고, 끝나면 지운다.
//
//  왜 실 DB 인가: 이행은 «행의 sort 가 옛 기본값일 때만» 옮기고 enabled·updated_by 를 남겨야 한다. upsert 로 옮기면
//   updated_by 가 'system' 으로 바뀌어, 사람이 끈 훅을 기본값 승격 블록(PROMOTE_ENABLED)이 «손 안 댄 시드» 로 보고
//   **다음 부팅에** 다시 켠다 — 부팅을 두 번 돌려 봐야 드러나는 결함이라 목으로는 안 보인다.
//
//  사양:
//   M1 옛 기본값(sort 0)인 시드 둘은 새 기본값으로 옮겨지고 enabled·updated_by 는 그대로 · 두 번째 부팅은 아무것도 바꾸지 않는다
//   M2 사람이 끈 훅(enabled=false · updated_by=사람 · sort 0)은 sort 만 옮겨지고, 다음 부팅들에도 꺼진 채 · updated_by 그대로
//   M3 조직이 바꾼 sort(옛 기본값이 아님)는 건드리지 않는다
//   M4 org_runner_hooks 응답 — 훅마다 숫자 sort 를 (sort, id) 순으로 싣고, concurrent 는 기본 false · 조직 설정을 켜면 true
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL 이 필요합니다"); process.exit(1); }
const TMPDB = `lively_seed_sort_${process.pid}`;
const admin = new pg.Client({ connectionString: BASE });
await admin.connect();
await admin.query(`CREATE DATABASE ${TMPDB}`);
const tmpUrl = new URL(BASE); tmpUrl.pathname = `/${TMPDB}`;
process.env.ITEMS_DATABASE_URL = tmpUrl.toString();   // 아래 dist 모듈이 읽기 전에 바꾼다

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
let itemsPool;
try {
  ({ itemsPool } = await import(`${DIST}/db/client.js`));
  const { initAllSchemas } = await import(`${DIST}/boot/schemas.js`);
  const { seedDefaultContent } = await import(`${DIST}/org/delivery/seed-content.js`);
  const { DEFAULT_HOOKS } = await import(`${DIST}/org/delivery/default-content.js`);
  const { hooksCapabilities } = await import(`${DIST}/capabilities/delivery/hooks.js`);
  const { updateRuntimeConfig } = await import(`${DIST}/org/store/runtime-config.js`);

  await initAllSchemas();
  await seedDefaultContent();

  const IDS = ["project-pull-turn", "project-push-tool"];
  const NEW = Object.fromEntries(IDS.map((id) => [id, DEFAULT_HOOKS.find((h) => h.id === id)?.sort]));
  const rows = async () => Object.fromEntries((await itemsPool.query(
    `SELECT id, sort, enabled, updated_by, version FROM org_hook WHERE id = ANY($1)`, [IDS])).rows.map((r) => [r.id, r]));
  const set = (cols) => itemsPool.query(`UPDATE org_hook SET ${cols} WHERE id = ANY($1)`, [IDS]);
  const fmt = (rs) => JSON.stringify(Object.values(rs).map((r) => [r.id, r.sort, r.enabled, r.updated_by, Number(r.version)]));
  chk("M0 새 기본 sort 가 옛 기본값(0)과 다르다(이행할 것이 있다)", IDS.every((id) => typeof NEW[id] === "number" && NEW[id] > 0), JSON.stringify(NEW));

  {
    await set(`sort=0, enabled=true, updated_by='system'`);
    await seedDefaultContent();
    const r1 = await rows();
    chk("M1a 옛 기본값 → 새 기본값 · enabled·updated_by 그대로",
      IDS.every((id) => r1[id].sort === NEW[id] && r1[id].enabled === true && r1[id].updated_by === "system"), fmt(r1));
    await seedDefaultContent();
    const r2 = await rows();
    chk("M1b 두 번째 부팅은 바꾸지 않는다(version 그대로)", IDS.every((id) => Number(r2[id].version) === Number(r1[id].version)), `${fmt(r1)} → ${fmt(r2)}`);
  }
  {
    await set(`sort=0, enabled=false, updated_by='alice'`);
    await seedDefaultContent();
    const b1 = await rows();
    chk("M2a 사람이 끈 훅 — sort 만 옮기고 enabled=false · updated_by=alice 그대로",
      IDS.every((id) => b1[id].sort === NEW[id] && b1[id].enabled === false && b1[id].updated_by === "alice"), fmt(b1));
    await seedDefaultContent();
    await seedDefaultContent();
    const b3 = await rows();
    chk("M2b ★ 다음 부팅들에도 꺼진 채다(승격 블록이 되살리지 않는다)",
      IDS.every((id) => b3[id].enabled === false && b3[id].updated_by === "alice"), fmt(b3));
  }
  {
    await set(`sort=3, enabled=true, updated_by='alice'`);
    await seedDefaultContent();
    const r = await rows();
    chk("M3 조직이 바꾼 sort 는 건드리지 않는다", IDS.every((id) => r[id].sort === 3), fmt(r));
  }
  {
    await set(`enabled=true`);
    for (const id of IDS) await itemsPool.query(`UPDATE org_hook SET sort=$2 WHERE id=$1`, [id, NEW[id]]);
    const cap = hooksCapabilities.find((c) => c.name === "org_runner_hooks");
    const res = await cap.handler({ event: "UserPromptSubmit" }, { userId: null });
    const hs = res?.hooks ?? [];
    const sorted = hs.every((h, i) => i === 0 || hs[i - 1].sort < h.sort || (hs[i - 1].sort === h.sort && hs[i - 1].id < h.id));
    chk("M4a 러너 응답의 훅마다 숫자 sort · (sort, id) 순", hs.length > 0 && hs.every((h) => typeof h.sort === "number") && sorted,
      JSON.stringify(hs.map((h) => [h.id, h.sort])));
    chk("M4b concurrent 는 기본 false", res?.concurrent === false, JSON.stringify({ concurrent: res?.concurrent }));
    await updateRuntimeConfig({ hooks: { concurrent: true } }, "seed-sort-migrate-pg-test", "test");
    const on = await cap.handler({ event: "UserPromptSubmit" }, { userId: null });
    chk("M4c 조직 설정을 켜면 concurrent=true", on?.concurrent === true, JSON.stringify({ concurrent: on?.concurrent }));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await itemsPool?.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${TMPDB} WITH (FORCE)`).catch((e) => console.error(`임시 DB 정리 실패: ${e?.message ?? e}`));
  await admin.end().catch(() => {});
}

console.log(`\nseed-sort-migrate pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
