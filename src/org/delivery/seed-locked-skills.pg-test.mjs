// 잠긴 연결 스킬 시딩(#4970) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/org/delivery/seed-locked-skills.pg-test.mjs
//
// 왜 이 계층인가: 잠긴 스킬을 «무조건 코드 판으로 맞춘다»는 규칙은 전부 SQL 한 문장(ON CONFLICT … DO UPDATE … WHERE)에 있다 —
//  손 댄 행(updated_by≠system)도 덮는가 · 꺼 둔 것·대상 좁힌 것도 되돌리는가 · 같으면 version 을 안 올리는가(멱등) ·
//  잠기기 전 개인 설정만 지우고 남의 것은 안 건드리는가. 목 풀로는 조건 하나를 지워도 초록이다. 그래서 부작용을 SELECT 로 되읽는다.
//  사양: 스크래치 spec.md «사양 1» P1·P5 의 시딩 쪽(DB 행 = 코드 판).
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { seedDefaultContent } = await import(`${DIST}/org/delivery/seed-content.js`);
const { connectSkills, lockedSkillIds } = await import(`${DIST}/org/delivery/connect-skills.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const IDS = lockedSkillIds();
const CODE = new Map(connectSkills("selfhost").map((s) => [s.id, s]));   // 테스트 환경엔 테넌트 헤더 비밀이 없다 = selfhost
const MINE = "__pg_locked_seed_mine__";
const rowsOf = async () => (await itemsPool.query(
  `SELECT id, body, description, summary, enabled, target_members, updated_by, version, content_hash FROM org_harness_asset WHERE id = ANY($1::text[])`,
  [IDS])).rows;

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_asset_pref WHERE member_id = $1`, ["__pg_locked_seed_member__"]);
  await itemsPool.query(`DELETE FROM org_harness_asset WHERE id = ANY($1::text[]) OR id = $2`, [IDS, MINE]);
}

try {
  await cleanup();

  // ── S1 행이 없으면 전부 코드 판으로 생긴다(켜짐·대상 전원·system) ──
  {
    await seedDefaultContent();
    const rows = await rowsOf();
    const allCode = rows.every((r) => r.body === CODE.get(r.id)?.body && r.content_hash === CODE.get(r.id)?.content_hash);
    chk("S1 잠긴 스킬 전부가 코드 본문으로 생긴다", rows.length === IDS.length && allCode,
      JSON.stringify({ n: rows.length, want: IDS.length, mismatch: rows.filter((r) => r.body !== CODE.get(r.id)?.body).map((r) => r.id) }));
    chk("S1 켜짐·대상 전원·updated_by=system", rows.every((r) => r.enabled === true && r.target_members === null && r.updated_by === "system"),
      JSON.stringify(rows.map((r) => [r.id, r.enabled, r.target_members, r.updated_by])));
  }

  // ── S2 사람이 고치고 끄고 대상을 좁힌 행 → 코드 판·켜짐·전원으로 되돌아오고 version 이 오른다 ──
  {
    const id = "liv-connect-slack";
    const before = (await rowsOf()).find((r) => r.id === id);
    await itemsPool.query(
      `UPDATE org_harness_asset SET body = '고친 본문', description = '고친 설명', enabled = false, target_members = '["someone"]'::jsonb,
              content_hash = 'tampered', updated_by = 'someone' WHERE id = $1`, [id]);
    await seedDefaultContent();
    const r = (await rowsOf()).find((x) => x.id === id);
    chk("S2 고친 본문·설명이 코드 판으로 돌아온다", r.body === CODE.get(id).body && r.description === CODE.get(id).description && r.content_hash === CODE.get(id).content_hash,
      JSON.stringify({ body: r.body.slice(0, 40), hash: r.content_hash }));
    chk("S2 꺼 둔 것·좁힌 대상이 풀린다(잠긴 스킬엔 조직의 결정이 없다)", r.enabled === true && r.target_members === null && r.updated_by === "system",
      JSON.stringify({ enabled: r.enabled, tm: r.target_members, by: r.updated_by }));
    chk("S2 실제로 바뀌었으니 version 이 오른다", r.version > before.version, `${before.version} → ${r.version}`);
  }

  // ── S3 멱등 — 이미 코드 판이면 두 번째 시딩은 아무 행도 안 바꾼다 ──
  {
    const before = new Map((await rowsOf()).map((r) => [r.id, r.version]));
    const res = await seedDefaultContent();
    const after = await rowsOf();
    chk("S3 두 번째 시딩은 잠긴 스킬 0건 갱신", !res.lockedSkills, JSON.stringify(res));
    chk("S3 version 그대로", after.every((r) => before.get(r.id) === r.version), JSON.stringify(after.map((r) => [r.id, before.get(r.id), r.version])));
  }

  // ── S4 잠기기 전 개인 설정은 지우고, 잠기지 않은 스킬의 개인 설정·행은 건드리지 않는다 ──
  {
    await itemsPool.query(
      `INSERT INTO org_harness_asset(id, kind, label, harness, description, body, frontmatter, enabled, sort, version, content_hash, created_by, updated_at, updated_by)
         VALUES($1,'skill',NULL,'all','조직 스킬','조직 본문','{}'::jsonb,true,0,1,'h','someone',now(),'someone')`, [MINE]);
    for (const ref of ["liv-connect-notion", MINE]) {
      await itemsPool.query(
        `INSERT INTO org_asset_pref(target_kind, ref_id, member_id, state, updated_at, updated_by) VALUES('harness_asset',$1,$2,false,now(),'t')
         ON CONFLICT DO NOTHING`, [ref, "__pg_locked_seed_member__"]);
    }
    await seedDefaultContent();
    const prefs = (await itemsPool.query(`SELECT ref_id FROM org_asset_pref WHERE member_id = $1 ORDER BY ref_id`, ["__pg_locked_seed_member__"])).rows.map((r) => r.ref_id);
    chk("S4 잠긴 스킬의 개인 끄기만 지워진다", prefs.length === 1 && prefs[0] === MINE, JSON.stringify(prefs));
    const mine = (await itemsPool.query(`SELECT body, updated_by FROM org_harness_asset WHERE id = $1`, [MINE])).rows[0];
    chk("S4 조직 스킬 행은 그대로", mine?.body === "조직 본문" && mine?.updated_by === "someone", JSON.stringify(mine));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
