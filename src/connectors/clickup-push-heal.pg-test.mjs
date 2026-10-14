// ClickUp 반출 — 부모 좌표 치유(ITEM_137) 기록의 PG 통합 테스트 (**실제 Postgres 필요**, 기본 npm test 체인 밖).
//  실행: npm run build && ITEMS_DATABASE_URL=… node src/connectors/clickup-push-heal.pg-test.mjs
//   (device-auth.pg-test.mjs 와 같은 패턴 — dist 에서 컴파일된 모듈을 import 한다.)
//
//  왜 PG 통합인가: 약속이 **UPDATE 한 문장**에 산다(clickup-push.ts recordHealedParentList) — «원래 좌표가 있던 부모만 ·
//   로컬에서 옮긴 부모는 그대로 · 새 리스트가 미러돼 있으면 거기로, 아니면 list_id 를 그대로». CASE·서브쿼리·NULL 비교라
//   소스를 읽는 배선 시험은 조건 하나를 지워도 초록이고, 실제로 «미러 안 된 리스트면 list_id 가 NULL(미분류 = 전원 공개)»
//   결함이 그렇게 지나갔다. 행을 깔고 기록한 뒤 다시 읽어, 바깥 사람(PUBLIC_VIEWER)에게 보이는지까지 판정한다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { recordHealedParentList } = await import(`${DIST}/connectors/clickup-push.js`);
const vis = await import(`${DIST}/v6/visibility.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = "__clickup_heal_pg__";
const INST = "T_HEAL_PG";   // 이 시험의 ClickUp 워크스페이스(external_instance)
const q = (sql, p) => itemsPool.query(sql, p);

async function cleanup() {
  await q(`DELETE FROM project WHERE created_by=$1`, [TAG]);
  await q(`DELETE FROM project_list WHERE created_by=$1`, [TAG]);
}
const mkList = async (name, visibility, ext, inst = INST) => (await q(
  `INSERT INTO project_list(name, visibility, created_by, external_system, external_instance, external_id)
   VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
  [`${TAG}-${name}`, visibility, TAG, ext ? "clickup" : null, ext ? inst : null, ext])).rows[0].id;
const mkParent = async (name, listId, base) => (await q(
  `INSERT INTO project(level, name, status, created_by, list_id, external_system, external_instance, external_id, external_base)
   VALUES('project',$1,'active',$2,$3,'clickup',$4,$5,$6::jsonb) RETURNING id`,
  [`${TAG}-${name}`, TAG, listId, INST, `${TAG}-${name}-ext`, base == null ? null : JSON.stringify(base)])).rows[0].id;
const rowOf = async (id) => (await q(`SELECT list_id, external_base FROM project WHERE id=$1`, [id])).rows[0];

try {
  await cleanup();
  const restricted = await mkList("old-restricted", "members", "L_OLD");          // 잠긴 리스트(ClickUp L_OLD 의 미러)
  const openNew = await mkList("new-open", "open", "L_NEW_MIRRORED");             // 미러된 새 리스트
  const local = await mkList("local", "open", null);                              // 라이블리에만 있는 리스트
  const otherInst = await mkList("other-inst", "open", "L_OTHER", "T_OTHER_TEAM"); // 다른 ClickUp 워크스페이스의 같은 모양 리스트

  // H1 — 🔴 새 리스트가 미러돼 있지 않다(수집 범위 밖으로 옮겨짐 — 치유가 필요한 바로 그 상황): list_id 를 그대로 둔다.
  {
    const p = await mkParent("p1", restricted, { list_ext: "L_OLD", name: "p1" });
    //  전제부터 — 잠금이 안 걸려 있으면 아래 «여전히 안 보인다» 가 공허하게 통과한다.
    chk("H1 전제: 잠긴 리스트의 프로젝트는 바깥 사람에게 안 보인다", !(await vis.canSeeProjectRow(p, vis.PUBLIC_VIEWER)),
      "잠금 전제가 깨졌다(공개범위 축이 꺼졌나) — 이 판정이 무의미하다");
    await recordHealedParentList(p, "L_NOT_MIRRORED");
    const r = await rowOf(p);
    chk("H1 미러 안 된 리스트로 옮겨졌으면 list_id 유지", r.list_id === restricted,
      `list_id=${r.list_id} (기대 ${restricted}) — NULL 이면 미분류 = 전원 공개`);
    chk("H1 좌표는 기록한다(다음 자식부터 맞는 리스트로 바로 간다)", r.external_base?.list_ext === "L_NOT_MIRRORED", JSON.stringify(r.external_base));
    chk("H1 바깥 사람에게 여전히 안 보인다", !(await vis.canSeeProjectRow(p, vis.PUBLIC_VIEWER)),
      "치유 기록이 잠긴 프로젝트를 조직 전체에 열었다");
  }

  // H2 — 새 리스트가 미러돼 있다: 인바운드가 했을 것처럼 그 리스트로 옮긴다(다음 3-way 가 옛 리스트에 고정하지 않게).
  {
    const p = await mkParent("p2", restricted, { list_ext: "L_OLD" });
    await recordHealedParentList(p, "L_NEW_MIRRORED");
    const r = await rowOf(p);
    chk("H2 미러된 리스트로 옮겨졌으면 그 리스트로", r.list_id === openNew, `list_id=${r.list_id} (기대 ${openNew})`);
    chk("H2 좌표 기록", r.external_base?.list_ext === "L_NEW_MIRRORED", JSON.stringify(r.external_base));
  }

  // H3 — 로컬에서 따로 옮긴 부모(ours≠base): list_id 를 건드리지 않는다(mirror-project 3-way 의 로컬 이동 보존과 같다).
  {
    const p = await mkParent("p3", local, { list_ext: "L_OLD" });
    await recordHealedParentList(p, "L_NEW_MIRRORED");
    const r = await rowOf(p);
    chk("H3 로컬에서 옮긴 부모는 list_id 그대로", r.list_id === local, `list_id=${r.list_id} (기대 ${local})`);
  }

  // H4 — 좌표가 없던 부모(push 로 만든 네이티브 카드): 아무것도 쓰지 않는다(첫 인바운드의 list_id 수렴을 안 뒤집게).
  {
    const p = await mkParent("p4", local, { name: "p4" });
    await recordHealedParentList(p, "L_NEW_MIRRORED");
    const r = await rowOf(p);
    chk("H4 좌표가 없던 부모는 좌표·list_id 그대로", r.list_id === local && r.external_base?.list_ext === undefined, JSON.stringify(r));
  }

  // H5 — 다른 ClickUp 워크스페이스에 같은 id 의 리스트가 미러돼 있어도 그리로 옮기지 않는다(external_instance 대조).
  {
    const p = await mkParent("p5", restricted, { list_ext: "L_OLD" });
    await recordHealedParentList(p, "L_OTHER");
    const r = await rowOf(p);
    chk("H5 다른 워크스페이스의 리스트로 안 옮긴다", r.list_id === restricted && r.list_id !== otherInst, `list_id=${r.list_id}`);
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
