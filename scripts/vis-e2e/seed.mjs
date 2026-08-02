// #1291 e2e 시드 — 잠긴 구조와 공개 구조를 나란히 심는다(격리 DB).
//  잠금 대상: vis_in. 비대상: vis_out. 스페이스▸폴더▸리스트 2홉 상속도 함께 심어 실데이터로 확인한다.
import pg from "pg";
import crypto from "node:crypto";
const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];

const member = async (id, scopes) => pool.query(
  `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
     VALUES($1,'human',$1,$1||'@example.invalid','active',$2::jsonb)
   ON CONFLICT (id) DO UPDATE SET state='active', scopes=$2::jsonb`, [id, JSON.stringify(scopes)]);

// DB 토큰 발급 — 정적 토큰(AUTH_TOKENS_JSON)은 admin/runtime 이 의도적으로 제거되므로 admin 검증에 못 쓴다.
//  실효 권한 = intersection(토큰, 멤버)라 멤버 scope 도 같이 넣는다.
const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const mint = async (userId, scopes) => {
  const token = "lvk_e2e_" + userId + "_" + crypto.randomBytes(8).toString("hex");
  await pool.query(
    `INSERT INTO auth_token(token_hash, user_id, scopes, projects, label, member_id, created_by)
       VALUES($1,$2,$3::jsonb,'["*"]'::jsonb,$4,$2,'e2e')`,
    [sha256(token), userId, JSON.stringify(scopes), "vis-e2e"]);
  return token;
};

const out = {};
try {
  const base = ["items", "context", "memory"];
  // #1291 v3 — in/out 에도 db 스코프를 준다. v3 의 요점이 "비-admin 도 self 를 쓰되 행 단위로 걸린다"이고
  //  (고객사 A 실측 61/66명이 db 보유), 스코프가 없으면 403 이 나 e2e 가 **공허하게 통과**한다.
  await member("vis_in", [...base, "db"]); await member("vis_out", [...base, "db"]);
  await member("vis_admin", [...base, "admin", "db"]);
  out.tokens = {
    in: await mint("vis_in", [...base, "db"]),
    out: await mint("vis_out", [...base, "db"]),
    admin: await mint("vis_admin", [...base, "admin", "db"]),
  };

  // 스페이스 2개: 공개 / 잠김(대상 vis_in)
  const sOpen = await one(`INSERT INTO project_folder(name, visibility, settings) VALUES('VIS_SPACE_OPEN','open','{"kind":"space"}'::jsonb) RETURNING id`);
  const sLocked = await one(`INSERT INTO project_folder(name, visibility, settings) VALUES('VIS_SPACE_LOCKED','members','{"kind":"space"}'::jsonb) RETURNING id`);
  await pool.query(`INSERT INTO project_folder_member(folder_id, subject_kind, member_id) VALUES($1,'member','vis_in')`, [sLocked.id]);

  // 잠긴 스페이스 하위 폴더(자기는 open) → 그 아래 리스트: **2홉 상속**이 걸려야 안 보인다
  const subFolder = await one(`INSERT INTO project_folder(name, visibility, parent_id) VALUES('VIS_SUBFOLDER','open',$1) RETURNING id`, [sLocked.id]);

  const mkList = async (name, vis, folderId) => one(
    `INSERT INTO project_list(name, visibility, folder_id) VALUES($1,$2,$3) RETURNING id`, [name, vis, folderId]);
  const openList = await mkList("VIS_LIST_OPEN", "open", sOpen.id);
  const lockedList = await mkList("VIS_LIST_LOCKED", "members", sOpen.id);
  const spaceLockedList = await mkList("VIS_LIST_UNDER_LOCKED_SPACE", "open", subFolder.id);
  await pool.query(`INSERT INTO project_list_member(list_id, member_id) VALUES($1,'vis_in')`, [lockedList.id]);

  const mkProject = async (name, listId) => one(
    `INSERT INTO project(level, name, description, status, status_category, list_id)
       VALUES('project',$1,$2,'active','started',$3) RETURNING id`,
    [name, `${name} 본문 VISLOCKED 검색표식`, listId]);
  const openProject = await mkProject("VIS_PROJ_OPEN", openList.id);
  const lockedProject = await mkProject("VIS_PROJ_LOCKED", lockedList.id);

  // 태스크·서브태스크 — list_id 를 일부러 비운다(현실 그대로: createTask 가 안 채운다)
  const task = await one(`INSERT INTO project(level, parent_id, name, status, status_category)
      VALUES('task',$1,'VIS_TASK_LOCKED','todo','unstarted') RETURNING id`, [lockedProject.id]);
  const sub = await one(`INSERT INTO project(level, parent_id, name, status, status_category)
      VALUES('subtask',$1,'VIS_SUBTASK_LOCKED','todo','unstarted') RETURNING id`, [task.id]);

  // #1291 v4 — 증류 상속 테스트에 필요한 분류축(지식 저장은 category 필수).
  //  유니크는 (space,key) 부분 인덱스라 ON CONFLICT 대상이 못 된다 → 있으면 재사용, 없으면 생성.
  const cat = (await one(`SELECT id, key FROM category WHERE space='product' AND key='vis-e2e' AND state <> 'merged'`))
    || await one(`INSERT INTO category(key, name, space, state)
                  VALUES('vis-e2e','가시성 e2e','product','active') RETURNING id, key`);

  // #1291 v4 — 커넥터 수집물 흉내. mirrorSourceV6 가 넣는 모양 그대로(external_system + fields.container_*)라
  //  백필·정책 매칭이 실제 데이터에서 도는지 볼 수 있다.
  const srcEng = await one(`INSERT INTO source(kind, title, body_md, provenance, external_system, external_instance, external_id, fields)
      VALUES('message','V4_SRC_ENG','엔지니어 채널 원문','observed','slack','t1','v4-eng-1',
             '{"container_ref":"C-ENG","container_name":"eng-only"}'::jsonb) RETURNING id`);
  const srcGen = await one(`INSERT INTO source(kind, title, body_md, provenance, external_system, external_instance, external_id, fields)
      VALUES('message','V4_SRC_GEN','일반 채널 원문','observed','slack','t1','v4-gen-1',
             '{"container_ref":"C-GEN","container_name":"general"}'::jsonb) RETURNING id`);

  Object.assign(out, {
    v4SrcEngId: srcEng.id, v4SrcGenId: srcGen.id, v4Category: cat.key,
    lockedListId: lockedList.id, openListId: openList.id, spaceLockedListId: spaceLockedList.id,
    lockedProjectId: lockedProject.id, openProjectId: openProject.id,
    lockedTaskId: task.id, lockedSubtaskId: sub.id,
    spaceLockedId: sLocked.id, subFolderId: subFolder.id,
  });
  console.log(JSON.stringify(out));
} catch (e) {
  console.error("시드 실패:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
