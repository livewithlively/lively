// #1291 맥락 가시성 — 술어 계층 PG 통합 테스트 (**실제 Postgres 필요**, 기본 npm test 체인 밖).
//  실행: npm run build && node --env-file=.env dist/../src/v6/visibility.pg-test.mjs
//   (device-auth.pg-test.mjs 와 같은 패턴 — dist 에서 컴파일된 모듈을 import 한다.)
//
//  왜 PG 통합인가: 이 계층의 버그는 전부 **SQL 술어**에 산다(조인 방향·NULL 처리·상속 AND·grant 경유).
//  목 pg 로는 "리스트가 members 인데 폴더는 open" 같은 조합에서 실제 행이 어떻게 걸러지는지 못 본다.
//  특히 **태스크 행의 list_id 는 항상 NULL** 이라 조상 해소 없이는 조용히 전부 새는데, 그건 실데이터로만 드러난다.
import crypto from "node:crypto";
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const vis = await import(`${DIST}/v6/visibility.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = "__vis_pg_test__";
const IN_MEMBER = `${TAG}_in`;      // 대상(grant 보유)
const OUT_MEMBER = `${TAG}_out`;    // 비대상
const TEAM_MEMBER = `${TAG}_team`;  // 팀 경유 대상
const ids = {};

async function mkMember(id) {
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
       VALUES($1,'human',$1,$1||'@example.invalid','active','["items","context","memory"]'::jsonb)
     ON CONFLICT (id) DO UPDATE SET state='active'`, [id]);
}

async function cleanup() {
  // 자식→부모 순. FK CASCADE 가 grant 를 지우지만, 테스트가 중간에 죽었을 때를 대비해 명시적으로.
  await itemsPool.query(`DELETE FROM project WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM project_list WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM project_folder WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM team_member WHERE member_id LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM team WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1`, [`${TAG}%`]);
}

async function seed() {
  for (const m of [IN_MEMBER, OUT_MEMBER, TEAM_MEMBER]) await mkMember(m);

  // 팀 — TEAM_MEMBER 만 소속.
  const t = await itemsPool.query(
    `INSERT INTO team(key, name) VALUES($1,$2) RETURNING id`, [`${TAG}_key`, `${TAG}_team_name`]);
  ids.team = t.rows[0].id;
  await itemsPool.query(`INSERT INTO team_member(team_id, member_id) VALUES($1,$2)`, [ids.team, TEAM_MEMBER]);

  // 스페이스(최상위 폴더) 2개: open / members(IN_MEMBER 만).
  const fOpen = await itemsPool.query(
    `INSERT INTO project_folder(name, visibility) VALUES($1,'open') RETURNING id`, [`${TAG}_folder_open`]);
  const fLocked = await itemsPool.query(
    `INSERT INTO project_folder(name, visibility) VALUES($1,'members') RETURNING id`, [`${TAG}_folder_locked`]);
  ids.folderOpen = fOpen.rows[0].id; ids.folderLocked = fLocked.rows[0].id;
  await itemsPool.query(
    `INSERT INTO project_folder_member(folder_id, subject_kind, member_id) VALUES($1,'member',$2)`,
    [ids.folderLocked, IN_MEMBER]);

  // 리스트 4개.
  const mkList = async (name, vis2, folderId) => (await itemsPool.query(
    `INSERT INTO project_list(name, visibility, folder_id) VALUES($1,$2,$3) RETURNING id`,
    [name, vis2, folderId ?? null])).rows[0].id;
  ids.listOpen = await mkList(`${TAG}_list_open`, "open", ids.folderOpen);
  ids.listMembers = await mkList(`${TAG}_list_members`, "members", ids.folderOpen);
  ids.listTeam = await mkList(`${TAG}_list_team`, "members", ids.folderOpen);
  ids.listUnderLocked = await mkList(`${TAG}_list_under_locked`, "open", ids.folderLocked); // 상속 확인용(자기는 open)
  // 2홉 — 잠긴 스페이스 ▸ 하위 폴더 ▸ 리스트. ClickUp 미러가 만드는 흔한 모양이라(라이브 실측 19건) 반드시 덮는다.
  const sub = await itemsPool.query(
    `INSERT INTO project_folder(name, visibility, parent_id) VALUES($1,'open',$2) RETURNING id`,
    [`${TAG}_subfolder`, ids.folderLocked]);
  ids.subFolder = sub.rows[0].id;
  ids.listTwoHops = await mkList(`${TAG}_list_two_hops`, "open", ids.subFolder);

  await itemsPool.query(`INSERT INTO project_list_member(list_id, member_id) VALUES($1,$2)`, [ids.listMembers, IN_MEMBER]);
  await itemsPool.query(`INSERT INTO project_list_team(list_id, team_id) VALUES($1,$2)`, [ids.listTeam, ids.team]);

  // 프로젝트 + 태스크 + 서브태스크 — 태스크는 list_id 를 비운다(현실 그대로: createTask 가 안 채운다).
  const mkProject = async (name, listId) => (await itemsPool.query(
    `INSERT INTO project(level, name, status, status_category, list_id) VALUES('project',$1,'active','started',$2) RETURNING id`,
    [name, listId])).rows[0].id;
  ids.projOpen = await mkProject(`${TAG}_proj_open`, ids.listOpen);
  ids.projLocked = await mkProject(`${TAG}_proj_locked`, ids.listMembers);
  ids.projUnfiled = await mkProject(`${TAG}_proj_unfiled`, null);

  const mkChild = async (level, name, parentId) => (await itemsPool.query(
    `INSERT INTO project(level, parent_id, name, status, status_category) VALUES($1,$2,$3,'todo','unstarted') RETURNING id`,
    [level, parentId, name])).rows[0].id;
  ids.taskLocked = await mkChild("task", `${TAG}_task_locked`, ids.projLocked);
  ids.subLocked = await mkChild("subtask", `${TAG}_sub_locked`, ids.taskLocked);
  ids.taskOpen = await mkChild("task", `${TAG}_task_open`, ids.projOpen);

  // 지식 3건: open / members-직접grant / members-리스트참조grant.
  const mkK = async (name, visibility) => itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source, visibility)
       VALUES($1,$1,'body','recalled','authored','active','ai','authored',$2)`, [name, visibility]);
  await mkK(`${TAG}_k_open`, "open");
  await mkK(`${TAG}_k_direct`, "members");
  await mkK(`${TAG}_k_vialist`, "members");
  await itemsPool.query(
    `INSERT INTO knowledge_member(name, subject_kind, member_id) VALUES($1,'member',$2)`, [`${TAG}_k_direct`, IN_MEMBER]);
  await itemsPool.query(
    `INSERT INTO knowledge_list_grant(name, list_id) VALUES($1,$2)`, [`${TAG}_k_vialist`, ids.listMembers]);
}

try {
  await cleanup();
  await seed();

  // ── ① visibleListIds — 상속(AND)·grant·특권 ──
  const inSet = await vis.visibleListIds(IN_MEMBER);
  const outSet = await vis.visibleListIds(OUT_MEMBER);
  const teamSet = await vis.visibleListIds(TEAM_MEMBER);
  const privSet = await vis.visibleListIds(null);

  chk("특권(null)은 필터 없음", privSet === null, `got ${privSet}`);
  chk("open 리스트는 전원에게 보인다", inSet.has(ids.listOpen) && outSet.has(ids.listOpen));
  chk("members 리스트는 대상에게만", inSet.has(ids.listMembers) && !outSet.has(ids.listMembers));
  chk("팀 grant 는 팀원에게만", teamSet.has(ids.listTeam) && !outSet.has(ids.listTeam) && !inSet.has(ids.listTeam));
  // 상속 = 단조 축소: 리스트가 open 이어도 상위 스페이스가 members 면 비대상에겐 안 보인다.
  //  ("리스트만 비공개면 스페이스·폴더가 껍데기로 보인다"의 반대 방향 — 상위를 잠그면 하위도 잠긴다.)
  chk("잠긴 스페이스 하위의 open 리스트는 비대상에게 숨는다",
    !outSet.has(ids.listUnderLocked) && inSet.has(ids.listUnderLocked));
  // 조상 체인을 1홉만 보면 이 단언이 깨진다 — 스페이스를 잠갔는데 그 안 폴더의 리스트가 전원에게 열린다.
  chk("2홉(스페이스▸폴더▸리스트)에도 상속된다",
    !outSet.has(ids.listTwoHops) && inSet.has(ids.listTwoHops));
  const outFolders = await vis.visibleFolderIds(OUT_MEMBER);
  const inFolders = await vis.visibleFolderIds(IN_MEMBER);
  chk("잠긴 스페이스는 비대상에게 숨는다", !outFolders.has(ids.folderLocked) && inFolders.has(ids.folderLocked));
  chk("그 하위 폴더도 함께 숨는다(자기는 open 이어도)",
    !outFolders.has(ids.subFolder) && inFolders.has(ids.subFolder));
  chk("폴더도 특권은 전부", (await vis.visibleFolderIds(null)) === null);

  // ── ② listIdPredicate — SQL 조립 ──
  {
    const sql = `SELECT id FROM project WHERE level='project' AND name LIKE '${TAG}%' AND ${vis.listIdPredicate("list_id", outSet)}`;
    const rows = (await itemsPool.query(sql)).rows.map((r) => Number(r.id));
    chk("술어: 비대상은 open·미분류만 본다",
      rows.includes(ids.projOpen) && rows.includes(ids.projUnfiled) && !rows.includes(ids.projLocked),
      JSON.stringify(rows));
    const sqlPriv = `SELECT id FROM project WHERE level='project' AND name LIKE '${TAG}%' AND ${vis.listIdPredicate("list_id", privSet)}`;
    chk("술어: 특권은 전부 본다", (await itemsPool.query(sqlPriv)).rows.length === 3);
  }
  {
    // 가시 집합이 비어도 미분류(NULL)는 통과해야 한다 — 빈 IN() 이 SQL 문법 오류가 되지 않는지도 함께 본다.
    const sql = `SELECT id FROM project WHERE level='project' AND name LIKE '${TAG}%' AND ${vis.listIdPredicate("list_id", new Set())}`;
    const rows = (await itemsPool.query(sql)).rows.map((r) => Number(r.id));
    chk("술어: 가시 집합이 비어도 미분류는 통과", rows.length === 1 && rows[0] === ids.projUnfiled, JSON.stringify(rows));
  }

  // ── ③ 태스크 조상 해소 — 이 계층의 최대 함정 ──
  {
    const listIdOfTask = await vis.projectRowListId(ids.taskLocked);
    chk("태스크의 판정 기준은 조상 프로젝트의 list_id", listIdOfTask === ids.listMembers, `got ${listIdOfTask}`);
    const listIdOfSub = await vis.projectRowListId(ids.subLocked);
    chk("서브태스크는 2홉 위(프로젝트)까지 올라간다", listIdOfSub === ids.listMembers, `got ${listIdOfSub}`);
    chk("잠긴 프로젝트의 태스크는 비대상에게 안 보인다", !(await vis.canSeeProjectRow(ids.taskLocked, OUT_MEMBER)));
    chk("잠긴 프로젝트의 서브태스크도 안 보인다", !(await vis.canSeeProjectRow(ids.subLocked, OUT_MEMBER)));
    chk("대상에겐 보인다", await vis.canSeeProjectRow(ids.taskLocked, IN_MEMBER));
    chk("open 프로젝트의 태스크는 전원", await vis.canSeeProjectRow(ids.taskOpen, OUT_MEMBER));
    chk("특권은 전부", await vis.canSeeProjectRow(ids.taskLocked, null));
    // 태스크 행 자체는 list_id 가 비어 있다 — '자기 행 기준' 구현이면 위 단언이 통과할 수 없다.
    const raw = (await itemsPool.query(`SELECT list_id FROM project WHERE id=$1`, [ids.taskLocked])).rows[0].list_id;
    chk("(전제) 태스크 행의 list_id 는 비어 있다", raw === null, `got ${raw}`);
  }

  // ── ④ 지식 — 직접 grant / 리스트 참조 grant ──
  chk("open 지식은 전원", await vis.canSeeKnowledge(`${TAG}_k_open`, OUT_MEMBER));
  chk("members 지식은 비대상에게 숨는다", !(await vis.canSeeKnowledge(`${TAG}_k_direct`, OUT_MEMBER)));
  chk("직접 grant 대상은 본다", await vis.canSeeKnowledge(`${TAG}_k_direct`, IN_MEMBER));
  chk("리스트 참조 grant — 그 리스트를 보는 사람만",
    (await vis.canSeeKnowledge(`${TAG}_k_vialist`, IN_MEMBER)) && !(await vis.canSeeKnowledge(`${TAG}_k_vialist`, OUT_MEMBER)));
  chk("지식도 특권은 전부", await vis.canSeeKnowledge(`${TAG}_k_direct`, null));

  // ── ⑤ 라이브 추종 — 리스트에서 빼면 그 순간 지식도 안 보인다(스냅샷이 아니다) ──
  await itemsPool.query(`DELETE FROM project_list_member WHERE list_id=$1 AND member_id=$2`, [ids.listMembers, IN_MEMBER]);
  chk("grant 회수는 즉시 반영(지식)", !(await vis.canSeeKnowledge(`${TAG}_k_vialist`, IN_MEMBER)));
  chk("grant 회수는 즉시 반영(프로젝트)", !(await vis.canSeeProjectRow(ids.taskLocked, IN_MEMBER)));
  await itemsPool.query(`INSERT INTO project_list_member(list_id, member_id) VALUES($1,$2)`, [ids.listMembers, IN_MEMBER]);

  // ── ⑥ CASCADE — 컨테이너가 사라지면 grant 도 사라진다(고아 grant 금지) ──
  {
    const before = (await itemsPool.query(`SELECT count(*)::int AS n FROM knowledge_list_grant WHERE list_id=$1`, [ids.listMembers])).rows[0].n;
    await itemsPool.query(`DELETE FROM project_list WHERE id=$1`, [ids.listMembers]);
    const after = (await itemsPool.query(`SELECT count(*)::int AS n FROM knowledge_list_grant WHERE list_id=$1`, [ids.listMembers])).rows[0].n;
    chk("리스트 삭제 시 참조 grant 는 CASCADE 로 정리", before === 1 && after === 0, `${before}→${after}`);
    // 근거가 사라진 members 지식은 열리는 게 아니라 닫힌다(빈 audience = admin 만).
    chk("근거를 잃은 members 지식은 개방되지 않는다", !(await vis.canSeeKnowledge(`${TAG}_k_vialist`, IN_MEMBER)));
  }

  // ── ⑦ CHECK 제약 — 비정규 값이 들어오면 두 술어가 서로 다르게 반응하므로 DB 가 막아야 한다 ──
  {
    let blocked = false;
    try { await itemsPool.query(`UPDATE project_list SET visibility='public' WHERE id=$1`, [ids.listOpen]); }
    catch { blocked = true; }
    chk("visibility 는 open|members 만 허용(CHECK)", blocked);
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
