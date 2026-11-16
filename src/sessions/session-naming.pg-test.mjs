// 세션·태스크 제목이 한 번 정해지면 그대로 간다(#4418) — PG 통합 테스트. **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/sessions/session-naming.pg-test.mjs
//
// 왜 이 계층인가: 약속이 전부 SQL 조건이다 — «발견 행이면 출처·종류를 채운다»(ON CONFLICT 의 CASE) · «세션이 만든 태스크만
//  따라간다»(UPDATE … WHERE 순위) · «사람이 이름을 실제로 바꾸면 사람 것»(SET 의 CASE) · «사람이 고른 태스크는 사람 것».
//  목 풀로는 조건 하나를 지워도 초록이다. 그래서 진짜 함수(발견 기록 · 노드 미러 · 이름짓기)를 순서대로 부르고 **행을 되읽어** 판정한다.
//
//  사양·엣지 표: 스크래치패드 spec-4418.md — A1~A10(노드 경합 · 옛 발견 행 정리) · B1(복원 출처) · C1~C12(태스크 이름 승계 · 바깥 개명과 그 대조군 C11b ·
//   되살린 세션) · K1(사람이 고른 태스크).
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const ss = await import(`${DIST}/sessions/session-state.js`);
const nss = await import(`${DIST}/terminal/node-session-state.js`);
const st = await import(`${DIST}/v6/session-task.js`);
const ps = await import(`${DIST}/v6/project-store.js`);
const es = await import(`${DIST}/v6/execution-session-store.js`);
const { relabelSession } = await import(`${DIST}/terminal/session-relabel.js`);
const { sessionProjectContext } = await import(`${DIST}/terminal/session-project-routes.js`);
const mp = await import(`${DIST}/v6/mirror/mirror-project.js`);
const { initSessionsInfra } = await import(`${DIST}/org/schema/sessions-infra.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__naming_pg_a__";
const NODE = "__naming_pg_node__";
const S = (x) => `box-__pgtest-naming-${x}`;
//  #5552 — 라이블리가 띄우지 않은 외부 실행 세션의 id 꼴(`claude-<대화 id>`). 이름을 담을 org_session_state 행이 없다.
const EXT = (x) => `claude-pgtest-naming-${x}`;
const ALL_S = [...Array.from({ length: 40 }, (_, i) => S(i)), EXT(1), EXT(2)];

const row = async (id) => (await itemsPool.query(
  `SELECT label, label_source, kind, discovered, root_key FROM org_session_state WHERE id=$1`, [id])).rows[0] ?? null;
const taskRow = async (id) => (await itemsPool.query(`SELECT id, name, name_source FROM project WHERE id=$1`, [id])).rows[0] ?? null;
const taskIdOf = async (sid) => (await itemsPool.query(`SELECT task_id FROM execution_session WHERE id=$1`, [sid])).rows[0]?.task_id ?? null;
const mkProject = async (name) => (await itemsPool.query(
  `INSERT INTO project(level, name, status, created_by) VALUES('project',$1,'active',$2) RETURNING id`, [name, A])).rows[0].id;
/** 사람이 보드에서 만든 태스크 — createTask(출처 없이) 그대로. */
const humanTask = async (pid, name) => (await ps.createTask({ projectId: pid, name }, { actor: A, source: "web" })).id;
const bind = (sid, pid) => es.setExecutionSessionProject({ id: sid, owner: A, harness: "claude", projectId: pid });
/** 세션 미러 행 — 이름과 출처를 정해 둔다(생성 경로가 쓴 것과 같은 모양). */
const sessionRow = (sid, label, source) => itemsPool.query(
  `INSERT INTO org_session_state(id, owner, label, label_source) VALUES($1,$2,$3,$4)`, [sid, A, label, source]);

/** 노드가 띄운 세션 한 장(노드 상태 보고 · 생성 응답에 실리는 모양). */
const nodeInfo = (id, label, over = {}) => ({ id, label, harness: "claude", dir: `/Users/x/box/${id}`, autoApprove: false,
  owner: A, owned: true, created: 1_790_000_000, attached: false, invites: [], flags: {}, ...over });
/** 게이트웨이의 생성 요청(노드로 릴레이한 입력). */
const createInput = (over = {}) => ({ kind: "human", label: "", rootKey: "shared", subpath: "project/1", harness: "claude",
  flags: {}, autoApprove: false, ...over });

async function cleanup() {
  await itemsPool.query(`DELETE FROM external_outbox WHERE entity_id IN (SELECT id FROM project WHERE created_by=$1)`, [A]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_session_state WHERE id = ANY($1::text[])`, [ALL_S]);
  await itemsPool.query(`DELETE FROM session_project WHERE session_id = ANY($1::text[])`, [ALL_S]);
  await itemsPool.query(`DELETE FROM execution_session_task WHERE session_id = ANY($1::text[])`, [ALL_S]);
  await itemsPool.query(`DELETE FROM execution_session WHERE id = ANY($1::text[])`, [ALL_S]);
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1 AND level<>'project'`, [A]);
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1`, [A]);
}

try {
  await cleanup();

  // ══ A. 노드 세션 — 상태 보고(발견 행)가 생성 기록보다 먼저 와도 출처·종류가 정해진다 ══════════════════════
  //  실제 순서를 그대로 재현한다: ① discoverNodeSessions(노드의 상태 보고) ② mirrorNodeSession(게이트웨이의 생성 기록).
  {
    // A1 — 사람이 이름을 준 세션(태스크에서 열기), 발견 행이 먼저
    await nss.discoverNodeSessions(NODE, [nodeInfo(S(1), "[파일주소-2] 자료 보기 화면")]);
    const mid = await row(S(1));
    await nss.mirrorNodeSession(nodeInfo(S(1), "[파일주소-2] 자료 보기 화면"), NODE, createInput({ label: "[파일주소-2] 자료 보기 화면" }), A);
    const a1 = await row(S(1));
    chk("A1 사람이 이름을 준 노드 세션 — 발견 행이 먼저 와도 출처 human",
      mid?.discovered === true && mid?.label_source === null && a1?.label_source === "human",
      JSON.stringify({ mid, a1 }));
    // A6 — 생성 기록이 덮은 뒤엔 좌표를 아는 행이다
    chk("A6 생성 기록이 덮은 발견 행은 discovered=false · 좌표가 채워진다", a1?.discovered === false && a1?.root_key === "shared", JSON.stringify(a1));

    // A2 — 대조군: 생성 기록이 먼저(종전 정상 경로)
    await nss.mirrorNodeSession(nodeInfo(S(2), "앱 이름"), NODE, createInput({ label: "앱 이름" }), A);
    await nss.discoverNodeSessions(NODE, [nodeInfo(S(2), "앱 이름")]);
    chk("A2 생성 기록이 먼저 온 경우도 human(대조군)", (await row(S(2)))?.label_source === "human", JSON.stringify(await row(S(2))));

    // A3·A8 — 이름 없이 연 세션, 발견 행이 먼저 → 출처를 지어내지 않는다(비어 있음 = rule 로 읽힘)
    await nss.discoverNodeSessions(NODE, [nodeInfo(S(3), "첫 지시로 지은 이름")]);
    await nss.mirrorNodeSession(nodeInfo(S(3), "첫 지시로 지은 이름"), NODE, createInput({ label: "" }), A);
    const a3 = await row(S(3));
    chk("A3·A8 이름 없이 연 노드 세션 — 출처 비어 있음(rule) · 발견 표식은 거둔다", a3?.label_source === null && a3?.discovered === false, JSON.stringify(a3));

    // A4 — 앱 세션, 발견 행이 먼저 → kind=app
    await nss.discoverNodeSessions(NODE, [nodeInfo(S(4), "\"회의록\" 앱 제작", { appId: "app-x" })]);
    await nss.mirrorNodeSession(nodeInfo(S(4), "\"회의록\" 앱 제작"), NODE, createInput({ kind: "app", label: "\"회의록\" 앱 제작", appId: "app-x" }), A);
    const a4 = await row(S(4));
    chk("A4 앱 세션 — 발견 행이 먼저 와도 kind=app · 출처 human", a4?.kind === "app" && a4?.label_source === "human", JSON.stringify(a4));

    // A5 — 그 컴퓨터에서 직접 띄운 세션(생성 기록이 안 옴) → 발견 행 그대로(복원 거절의 근거)
    await nss.discoverNodeSessions(NODE, [nodeInfo(S(5), "직접 띄움")]);
    const a5 = await row(S(5));
    chk("A5 생성 기록이 안 오면 발견 행 그대로(discovered · 좌표 없음 · 출처 없음)",
      a5?.discovered === true && a5?.root_key === null && a5?.label_source === null, JSON.stringify(a5));

    // A7 — 발견 행이 아닌 기존 행(같은 id 복원 등)은 출처·종류가 안 바뀐다(#1979 · #2162 걸쇠)
    await ss.upsertSessionState({ ...nss.nodeSessionStateInput(nodeInfo(S(7), "AI 가 지은 이름"), NODE, createInput({ label: "" }), A) });
    await itemsPool.query(`UPDATE org_session_state SET label_source='agent', kind='human' WHERE id=$1`, [S(7)]);
    await ss.upsertSessionState({ ...nss.nodeSessionStateInput(nodeInfo(S(7), "AI 가 지은 이름"), NODE, createInput({ kind: "app", label: "AI 가 지은 이름" }), A) });
    const a7 = await row(S(7));
    chk("A7 발견 행이 아니면 다시 기록해도 출처·종류 그대로(agent · human)", a7?.label_source === "agent" && a7?.kind === "human", JSON.stringify(a7));

    // A10 — 이 고침 전에 경합으로 남은 옛 행(발견 표식 + 좌표 있음)은 스키마 정리가 표식을 거둔다 · 좌표 없는 발견 행은 그대로
    await itemsPool.query(`INSERT INTO org_session_state(id, owner, label, root_key, subpath, node_id, discovered)
      VALUES($1,$2,'옛 경합 행','shared','project/1',$3,true), ($4,$2,'직접 띄운 행',NULL,NULL,$3,true)`, [S(30), A, NODE, S(31)]);
    await initSessionsInfra(itemsPool);
    const a10 = await row(S(30)), a10b = await row(S(31));
    chk("A10 옛 경합 행(좌표 있음)은 발견 표식을 거두고 · 좌표 없는 발견 행은 그대로 · 출처는 지어내지 않는다",
      a10?.discovered === false && a10?.label_source === null && a10b?.discovered === true, JSON.stringify({ a10, a10b }));
  }

  // ══ B. 복원(새 id)은 원래 출처를 잇는다 ═══════════════════════════════════════════════════════════════
  {
    //  복원 라우트가 싣는 모양: 저장된 이름 + 저장된 출처. 발견 행이 먼저 와도 같다.
    await nss.discoverNodeSessions(NODE, [nodeInfo(S(8), "첫 지시로 지은 이름")]);
    await nss.mirrorNodeSession(nodeInfo(S(8), "첫 지시로 지은 이름"), NODE, createInput({ label: "첫 지시로 지은 이름", labelSource: "rule" }), A);
    await nss.mirrorNodeSession(nodeInfo(S(9), "AI 가 지은 이름"), NODE, createInput({ label: "AI 가 지은 이름", labelSource: "agent" }), A);
    const b8 = await row(S(8)), b9 = await row(S(9));
    chk("B1·B2 새 id 복원 — 규칙 이름은 rule · AI 이름은 agent 로 이어진다(사람 이름으로 굳지 않는다)",
      b8?.label_source === "rule" && b9?.label_source === "agent", JSON.stringify({ b8, b9 }));
  }

  const P = await mkProject("이름짓기 PG");

  // ══ C. 태스크 이름은 «세션이 스스로 만든 태스크» 만 한 번 따라간다(이름짓기 relabelSession 끝까지) ══════════
  {
    // C1 — 세션이 프로젝트에 붙으며 만든 태스크는 출처 session
    const ruleLabel = "우리 옛날에 회의해가지고 UI 개편 되게 많이 얘…";
    await bind(S(11), P);
    await sessionRow(S(11), ruleLabel, "rule");
    const made = await st.ensureSessionTask({ sessionId: S(11), owner: A, name: ruleLabel });
    const c1 = await taskRow(made?.id);
    chk("C1 세션이 만든 태스크 — 출처 session · 이름은 말줄임을 뗀 것",
      made?.created === true && c1?.name_source === "session" && c1?.name === "우리 옛날에 회의해가지고 UI 개편 되게 많이 얘",
      JSON.stringify({ made, c1 }));

    // C2·C3 — AI 가 이름을 지으면(규칙 이름 끝 «…» 때문에 글자가 달라도) 태스크가 따라간다
    const r = await relabelSession({ userId: A }, S(11), "UI 개편 회의 정리", "agent");
    const c2 = await taskRow(made?.id);
    chk("C2·C3 AI 이름짓기가 이기면 그 세션이 만든 태스크 이름이 따라간다(출처 agent)",
      r.applied === true && c2?.name === "UI 개편 회의 정리" && c2?.name_source === "agent", JSON.stringify({ r, c2 }));

    // C7 — 한 번만: 같은 세션의 두 번째 이름짓기는 걸쇠에 지고, 직접 승계를 불러도 태스크는 그대로
    const r2 = await relabelSession({ userId: A }, S(11), "다른 이름", "agent");
    const again = await st.renameSessionTaskForLabel({ sessionId: S(11), owner: A, name: "또 다른 이름" });
    const c7 = await taskRow(made?.id);
    chk("C7 한 번 따라간 태스크는 다시 안 바뀐다(세션 걸쇠 · 태스크 걸쇠 둘 다)",
      r2.applied === false && again === null && c7?.name === "UI 개편 회의 정리", JSON.stringify({ r2, again, c7 }));
  }

  {
    // C4 — ★#4418: 사람이 만든 태스크에서 연 세션. 세션 이름 = 태스크 이름인데 출처가 비어(rule) 이름짓기가 이기는 경우
    //  (종전 노드 경합이 정확히 이 상태를 만들었다). 이름짓기는 세션 이름만 바꾸고 태스크 이름은 그대로여야 한다.
    const name = "[앱] 앱 빌더 만들기 — 세션에 앱을 붙였다 떼는 방식으로 먼저";
    const tid = await humanTask(P, name);
    await bind(S(12), P);
    await st.bindSessionTask({ sessionId: S(12), owner: A, taskId: tid });
    await sessionRow(S(12), name, "rule");
    const r = await relabelSession({ userId: A }, S(12), "앱 붙였다 떼기", "agent");
    const c4 = await taskRow(tid);
    chk("C4 ★사람이 만든 태스크에서 연 세션의 이름짓기 — 태스크 이름 그대로",
      r.applied === true && c4?.name === name && r.task?.id === tid, JSON.stringify({ r, c4 }));
  }

  {
    // C5 — 세션이 만든 태스크를 사람이 다른 이름으로 고쳤다 → 그 뒤 이름짓기는 태스크를 안 바꾼다
    await bind(S(13), P);
    await sessionRow(S(13), "결제 실패 재시도 로직 정리해줘", "rule");
    const made = await st.ensureSessionTask({ sessionId: S(13), owner: A, name: "결제 실패 재시도 로직 정리해줘" });
    await ps.updateTask(made.id, { name: "결제 재시도(사람이 고침)" }, { actor: A, source: "web" });
    const mid = await taskRow(made.id);
    const r = await relabelSession({ userId: A }, S(13), "결제 백오프", "agent");
    const c5 = await taskRow(made.id);
    chk("C5 사람이 고친 태스크 이름(출처 human)은 이름짓기가 안 바꾼다",
      mid?.name_source === "human" && r.applied === true && c5?.name === "결제 재시도(사람이 고침)", JSON.stringify({ mid, r, c5 }));
  }

  {
    // C6 — 같은 이름을 다시 저장(폼 재전송)은 개명이 아니다 → 출처 그대로 → 이름짓기가 따라간다
    await bind(S(14), P);
    await sessionRow(S(14), "검색창 없애기 작업", "rule");
    const made = await st.ensureSessionTask({ sessionId: S(14), owner: A, name: "검색창 없애기 작업" });
    await ps.updateTask(made.id, { name: "검색창 없애기 작업", priority: "high" }, { actor: A, source: "web" });
    const mid = await taskRow(made.id);
    const r = await relabelSession({ userId: A }, S(14), "검색창 제거", "agent");
    const c6 = await taskRow(made.id);
    chk("C6 같은 이름 재저장은 출처를 안 바꾸고(session) 이름짓기가 따라간다",
      mid?.name_source === "session" && r.applied === true && c6?.name === "검색창 제거", JSON.stringify({ mid, r, c6 }));
  }

  {
    // C8 — 출처가 비어 있는 옛 태스크(이 칸 이전에 세션이 만든 것)는 따라가지 않는다(사람 이름으로 본다)
    const name = "옛 세션이 만든 태스크";
    const tid = (await itemsPool.query(
      `INSERT INTO project(level, parent_id, name, description, status, created_by) VALUES('task',$1,$2,$3,'in_progress',$4) RETURNING id`,
      [P, name, `> ⚙ 세션 «${name}»(\`${S(15)}\`)이 이름을 지으면서 **자동으로 만든** 태스크입니다`, A])).rows[0].id;
    await bind(S(15), P);
    await itemsPool.query(`UPDATE execution_session SET task_id=$2 WHERE id=$1`, [S(15), tid]);
    await sessionRow(S(15), name, "rule");
    const r = await relabelSession({ userId: A }, S(15), "새 이름", "agent");
    const c8 = await taskRow(tid);
    chk("C8 출처가 비어 있는 옛 태스크는 그대로(사람 이름으로 본다)", r.applied === true && c8?.name === name && c8?.name_source === null,
      JSON.stringify({ r, c8 }));
  }

  {
    // C9 — 다듬으니 빈 이름이면 아무것도 안 쓴다 / C10 — 이름짓기가 걸쇠에 지면 태스크를 손대지 않는다
    await bind(S(16), P);
    await sessionRow(S(16), "사람이 지은 세션 이름", "human");
    const made = await st.ensureSessionTask({ sessionId: S(16), owner: A, name: "사람이 지은 세션 이름" });
    const empty = await st.renameSessionTaskForLabel({ sessionId: S(16), owner: A, name: " … " });
    const r = await relabelSession({ userId: A }, S(16), "AI 가 지은 이름", "agent");
    const c9 = await taskRow(made.id);
    chk("C9·C10 빈 이름은 안 쓰고 · 걸쇠에 진 이름짓기는 태스크를 안 바꾼다",
      empty === null && r.applied === false && c9?.name === "사람이 지은 세션 이름" && c9?.name_source === "session",
      JSON.stringify({ empty, r, c9 }));
  }

  {
    // C11 — 세션이 만든 태스크를 바깥(ClickUp 등)에서 사람이 고쳤고 그 이름이 들어오는 미러로 왔다 → 사람 이름 → 이름짓기가 안 바꾼다
    await bind(S(19), P);
    await sessionRow(S(19), "외부 연동 태스크의 첫 지시 이름", "rule");
    const made = await st.ensureSessionTask({ sessionId: S(19), owner: A, name: "외부 연동 태스크의 첫 지시 이름" });
    const cur = (await itemsPool.query(`SELECT name, description, status_category FROM project WHERE id=$1`, [made.id])).rows[0];
    const ext = `__naming_pg_ext_${made.id}`;
    //  푸시가 끝나 바깥과 이어진 상태(링크백 · 공통 조상 = 지금 값 · 아웃박스 드레인 완료)를 만든다. 드레인 전이면 미러가 바깥 값을
    //   일부러 안 받는다(아웃박스 pending 가드 — 우리 값이 아직 안 나갔다) — 실제로도 바깥 개명은 드레인 뒤에만 들어온다.
    await itemsPool.query(`UPDATE project SET external_system='clickup', external_instance='__naming_pg__', external_id=$2, external_base=$3::jsonb WHERE id=$1`,
      [made.id, ext, JSON.stringify({ name: cur.name, description: cur.description, status_category: cur.status_category })]);
    await itemsPool.query(`UPDATE external_outbox SET done_at=now() WHERE entity_id=$1 AND done_at IS NULL`, [made.id]);
    const client = await itemsPool.connect();
    try {
      await mp.mirrorProjectV6(client, {
        type: "task", level: "task", title: "클릭업에서 사람이 고친 이름", body: cur.description ?? undefined,
        provenance: { category: "collab_tool", system: "clickup", instance: "__naming_pg__", external_id: ext },
        fields: { status_category: cur.status_category },
      }, "clickup", ext);
    } finally { client.release(); }
    const mid = await taskRow(made.id);
    const r = await relabelSession({ userId: A }, S(19), "AI 가 지은 이름", "agent");
    const c11 = await taskRow(made.id);
    chk("C11 바깥에서 사람이 고친 이름이 미러로 들어오면 human — 이름짓기가 안 바꾼다",
      mid?.name === "클릭업에서 사람이 고친 이름" && mid?.name_source === "human" && r.applied === true && c11?.name === "클릭업에서 사람이 고친 이름",
      JSON.stringify({ mid, r: { applied: r.applied, task: r.task }, c11 }));
  }

  {
    // C11b — 대조군: 바깥 이름이 그대로인 동기(평소의 싱크)는 개명이 아니다 → 출처 session 그대로 → 이름짓기가 따라간다.
    //  이게 없으면 «싱크 때마다 human» 으로 바뀌어도 C11 은 초록이다 — 그러면 바깥과 이은 태스크는 첫 싱크 뒤 영영 안 따라간다.
    await bind(S(22), P);
    await sessionRow(S(22), "바깥과 이은 태스크의 첫 지시 이름", "rule");
    const made = await st.ensureSessionTask({ sessionId: S(22), owner: A, name: "바깥과 이은 태스크의 첫 지시 이름" });
    const cur = (await itemsPool.query(`SELECT name, description, status_category FROM project WHERE id=$1`, [made.id])).rows[0];
    const ext = `__naming_pg_ext_${made.id}`;
    await itemsPool.query(`UPDATE project SET external_system='clickup', external_instance='__naming_pg__', external_id=$2, external_base=$3::jsonb WHERE id=$1`,
      [made.id, ext, JSON.stringify({ name: cur.name, description: cur.description, status_category: cur.status_category })]);
    await itemsPool.query(`UPDATE external_outbox SET done_at=now() WHERE entity_id=$1 AND done_at IS NULL`, [made.id]);
    const client = await itemsPool.connect();
    try {
      await mp.mirrorProjectV6(client, {
        type: "task", level: "task", title: cur.name, body: cur.description ?? undefined,
        provenance: { category: "collab_tool", system: "clickup", instance: "__naming_pg__", external_id: ext },
        fields: { status_category: cur.status_category },
      }, "clickup", ext);
    } finally { client.release(); }
    const mid = await taskRow(made.id);
    const r = await relabelSession({ userId: A }, S(22), "바깥 연동 확인", "agent");
    const c11b = await taskRow(made.id);
    chk("C11b 대조군 — 이름이 그대로인 싱크는 출처를 안 바꾸고(session) 이름짓기가 따라간다",
      mid?.name_source === "session" && r.applied === true && c11b?.name === "바깥 연동 확인" && c11b?.name_source === "agent",
      JSON.stringify({ mid, r: { applied: r.applied, task: r.task }, c11b }));
  }

  {
    // C12 — 새 id 로 되살린 세션(옛 세션의 태스크를 이어받는다)이 처음 이름을 지으면 그 태스크도 따라간다
    await bind(S(20), P);
    await sessionRow(S(20), "되살리기 전 첫 지시 이름", "rule");
    const old = await st.ensureSessionTask({ sessionId: S(20), owner: A, name: "되살리기 전 첫 지시 이름" });
    await itemsPool.query(`UPDATE org_session_state SET superseded_by=$2 WHERE id=$1`, [S(20), S(21)]);
    await bind(S(21), P);
    await sessionRow(S(21), "되살리기 전 첫 지시 이름", "rule");   // 복원이 실어 온 출처(rule) 그대로
    const r = await relabelSession({ userId: A }, S(21), "되살린 세션 이름", "agent");
    const c12 = await taskRow(old.id);
    chk("C12 되살린 세션의 첫 이름짓기 — 옛 태스크를 이어받고(새로 안 만든다) 그 이름으로 따라간다",
      r.applied === true && r.task?.id === old.id && r.task?.name === "되살린 세션 이름" && c12?.name === "되살린 세션 이름"
        && (await taskIdOf(S(21))) === old.id,
      JSON.stringify({ r: { applied: r.applied, task: r.task }, c12 }));
  }

  {
    // K1 — 사람이 고른 태스크(다른 세션이 만든 것이라도)는 사람 것이다: 고른 세션의 이름짓기가 그 이름을 안 바꾼다
    await bind(S(17), P);
    await sessionRow(S(17), "처음 세션이 만든 태스크 이름", "rule");
    const made = await st.ensureSessionTask({ sessionId: S(17), owner: A, name: "처음 세션이 만든 태스크 이름" });
    await bind(S(18), P);
    await sessionRow(S(18), "곁칸에서 고른 세션의 첫 지시", "rule");
    await st.bindSessionTask({ sessionId: S(18), owner: A, taskId: made.id });
    const mid = await taskRow(made.id);
    const r = await relabelSession({ userId: A }, S(18), "다른 세션의 이름", "agent");
    const k1 = await taskRow(made.id);
    chk("K1 사람이 세션에 고른 태스크는 출처 human — 그 세션의 이름짓기가 이름을 안 바꾼다",
      mid?.name_source === "human" && r.applied === true && k1?.name === "처음 세션이 만든 태스크 이름" && (await taskIdOf(S(18))) === made.id,
      JSON.stringify({ mid, r, k1 }));
  }

  // ══ N. 이름짓기 안내 훅에 주는 답(#5552) — 프로젝트 맥락 응답의 naming_open ════════════════════════════════
  //  약속: naming_open 은 **지금 session_rename 을 부르면 적용되나** 와 같은 값이다(안내와 집행이 갈리지 않는다).
  //   그래서 진짜 조회(sessionProjectContext)와 진짜 이름짓기(relabelSession)를 같은 행에 차례로 걸어 둘을 맞대 본다.
  //  🔴 틀리면: (true 로) 이미 이름이 정해진 세션에 세션 이름짓기가 안내돼 헛 툴콜과 «applied:false» 보고가 사람에게 보이고,
  //            (false 로) 아직 이름 없는 세션이 안내를 못 받는다.
  {
    const pid = await mkProject("이름짓기 안내 확인");
    /** 훅이 부르는 꼴 그대로 — 본문 없이(content=0), known 은 그때그때. */
    const ctxOf = (sid, known = -1) => sessionProjectContext({ userId: A }, sid, known, undefined, false);

    // N1 — 규칙 이름(첫 지시를 자른 것): 열려 있다 → 이름을 지으면 적용되고 → 닫힌다 → 다시 부르면 안 먹힌다
    await sessionRow(S(30), "첫 지시를 자른 이름…", "rule"); await bind(S(30), pid);
    const n1a = await ctxOf(S(30));
    const n1r = await relabelSession({ userId: A }, S(30), "이름짓기 안내", "agent");
    const n1b = await ctxOf(S(30));
    const n1r2 = await relabelSession({ userId: A }, S(30), "다른 이름", "agent");
    chk("N1 규칙 이름 세션 — 열림(true) → AI 가 지으면 적용 → 닫힘(false) → 다시 부르면 applied:false",
      n1a.naming_open === true && n1r.applied === true && n1b.naming_open === false && n1r2.applied === false,
      JSON.stringify({ a: n1a.naming_open, r: n1r.applied, b: n1b.naming_open, r2: n1r2.applied }));

    // N2 — 사람이 지은 이름(태스크에서 연 세션 · 웹에서 고친 이름): 닫혀 있고, 실제로도 안 먹힌다
    await sessionRow(S(31), "사람이 지은 이름", "human"); await bind(S(31), pid);
    const n2 = await ctxOf(S(31));
    const n2r = await relabelSession({ userId: A }, S(31), "AI 이름", "agent");
    chk("N2 사람이 지은 이름 — 닫힘(false) · 실제 이름짓기도 applied:false",
      n2.naming_open === false && n2r.applied === false, JSON.stringify({ open: n2.naming_open, applied: n2r.applied }));

    // N3 — 이름 없이 연 세션(id) · 출처 칸이 빈 행(옛 행 · 노드 발견 행): 열려 있다
    await sessionRow(S(32), S(32), "id"); await bind(S(32), pid);
    await sessionRow(S(33), "옛 행", null); await bind(S(33), pid);
    const n3a = await ctxOf(S(32)); const n3b = await ctxOf(S(33));
    const n3r = await relabelSession({ userId: A }, S(33), "옛 행 다듬기", "agent");
    chk("N3 id · 출처 없는 행 — 열림(true) · 출처 없는 행에 실제로 적용된다",
      n3a.naming_open === true && n3b.naming_open === true && n3r.applied === true,
      JSON.stringify({ id: n3a.naming_open, nul: n3b.naming_open, applied: n3r.applied }));

    // N4 — ★ 본문이 안 바뀐 턴(known = 지금 revision)에도 싣는다. 훅은 매 턴 이 꼴로 부른다 — 여기서 빠지면 첫 턴 값(열림)이
    //  로컬에 그대로 남아, AI 가 이름을 지은 뒤에도 세션 이름짓기가 다시 안내된다.
    //  (revision 은 바로 앞에서 다시 읽는다 — 같은 프로젝트에 태스크가 생기면 맥락 revision 이 오른다.)
    const n4 = await ctxOf(S(30), (await ctxOf(S(30))).revision);
    chk("N4 본문이 안 바뀐 턴에도 naming_open 을 싣는다",
      n4.changed === false && n4.naming_open === false, JSON.stringify({ changed: n4.changed, open: n4.naming_open }));

    // N5 — 라이블리가 띄운 세션인데 행이 없다(노드 생성 기록이 아직 안 닿은 틈): **모른다 → 싣지 않는다**(훅이 pane env 로 물러난다).
    //  닫힘(false)으로 답하면 그 세션은 안내를 못 받아 영영 이름을 못 얻는다.
    await bind(S(34), pid);
    const n5 = await ctxOf(S(34));
    chk("N5 행이 없는 라이블리 세션 — naming_open 을 싣지 않는다(모름)",
      n5.found === true && !("naming_open" in n5), JSON.stringify(n5));

    // N6 — ★ 행이 없는 외부 실행 세션(`claude-…`): 닫힘. 그리고 그 답이 맞다 — 실제 이름짓기가 applied:false(unknown)다.
    await bind(EXT(1), pid);
    const n6 = await ctxOf(EXT(1));
    const n6r = await relabelSession({ userId: A }, EXT(1), "외부 세션 이름", "agent");
    chk("N6 행이 없는 외부 실행 세션 — 닫힘(false) · 실제 이름짓기도 applied:false(unknown)",
      n6.naming_open === false && n6r.applied === false && n6r.reason === "unknown",
      JSON.stringify({ open: n6.naming_open, applied: n6r.applied, reason: n6r.reason }));

    // N7 — 프로젝트에 안 붙은 세션은 종전 응답 그대로다(행을 읽지 않는다 — 매 턴 모든 세션이 부르는 자리다).
    await sessionRow(S(35), "안 붙은 세션", "agent");
    const n7 = await ctxOf(S(35));
    chk("N7 프로젝트에 안 붙은 세션 — found:false · naming_open 없음(종전 응답)",
      n7.found === false && !("naming_open" in n7), JSON.stringify(n7));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
