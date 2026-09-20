// 세션 = 태스크(#4084) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/session-task.pg-test.mjs
//
// 왜 이 계층인가: 이 기능의 약속은 전부 SQL 조건이다 — «비어 있을 때만 잇는다(한 번만 만든다)» · «이 프로젝트의
//  태스크만» · «주인만» · «소속이 바뀌면 연결을 푼다» · «휴지통 세션은 칩에 안 뜬다». 목 풀로는 조건 하나를 지워도
//  초록이다. 그래서 **부작용을 SELECT 로 되읽어** 판정한다(태스크 행 수 · task_id · status · assignee).
//
//  사양·엣지 표: 스크래치패드 spec.md — D1~D13 · N1~N2(이름 승계) · I1~I2(복원 이어받기) · T1(휴지통) · R1~R2(배선).
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/v6/session-task.js`);
const es = await import(`${DIST}/v6/execution-session-store.js`);
const { relabelSession } = await import(`${DIST}/terminal/session-relabel.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__sesstask_pg_a__", B = "__sesstask_pg_b__";
const S = (x) => `box-__pgtest-sesstask-${x}`;
const ALL_S = Array.from({ length: 20 }, (_, i) => S(i));

const mkProject = async (name) => (await itemsPool.query(
  `INSERT INTO project(level, name, status, created_by) VALUES('project',$1,'active',$2) RETURNING id`, [name, A])).rows[0].id;
const mkTask = async (pid, name, extra = {}) => (await itemsPool.query(
  `INSERT INTO project(level, parent_id, name, status, status_category, created_by, assignee, status_raw)
   VALUES('task',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [pid, name, extra.status ?? "todo", extra.status === "done" ? "done" : "unstarted", A, extra.assignee ?? null, extra.status_raw ?? null])).rows[0].id;
const bind = (sid, owner, pid) => es.setExecutionSessionProject({ id: sid, owner, harness: "claude", projectId: pid });
const tasksOf = async (pid) => (await itemsPool.query(
  `SELECT id, name, status, assignee, status_raw, completed_at FROM project WHERE parent_id=$1 AND level='task' ORDER BY id`, [pid])).rows;
const taskIdOf = async (sid) => (await itemsPool.query(`SELECT task_id FROM execution_session WHERE id=$1`, [sid])).rows[0]?.task_id ?? null;
const taskRow = async (id) => (await itemsPool.query(`SELECT id, status, assignee, status_raw, completed_at FROM project WHERE id=$1`, [id])).rows[0];

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_session_trash WHERE session_id = ANY($1::text[])`, [ALL_S]);
  await itemsPool.query(`DELETE FROM org_session_state WHERE id = ANY($1::text[])`, [ALL_S]);
  await itemsPool.query(`DELETE FROM session_project WHERE session_id = ANY($1::text[])`, [ALL_S]);
  await itemsPool.query(`DELETE FROM execution_session WHERE id = ANY($1::text[])`, [ALL_S]);
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1 AND level<>'project'`, [A]);
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1`, [A]);
}

try {
  await cleanup();
  const P1 = await mkProject("세션태스크 PG 1");
  const P2 = await mkProject("세션태스크 PG 2");

  // ── D1 프로젝트 세션의 첫 이름 → 태스크 1개·연결·진행 중·담당자=주인 ──
  {
    await bind(S(1), A, P1);
    const t = await st.ensureSessionTask({ sessionId: S(1), owner: A, name: "결제 백오프" });
    const rows = await tasksOf(P1);
    chk("D1 첫 이름으로 태스크 1개가 생기고 이 세션에 이어진다(진행 중·담당자=주인·created)",
      !!t && t.created === true && rows.length === 1 && rows[0].name === "결제 백오프" && rows[0].status === "in_progress"
        && rows[0].assignee === A && (await taskIdOf(S(1))) === rows[0].id && t.id === rows[0].id,
      JSON.stringify({ t, rows, taskId: await taskIdOf(S(1)) }));
  }

  // ── D2 같은 세션 두 번째 보장 → 같은 태스크, 새 행 0 ──
  {
    const before = (await tasksOf(P1)).length;
    const t = await st.ensureSessionTask({ sessionId: S(1), owner: A, name: "다른 이름" });
    const rows = await tasksOf(P1);
    chk("D2 두 번째 보장은 같은 태스크(created=false)·행 증가 0·이름 불변",
      !!t && t.created === false && rows.length === before && rows[0].name === "결제 백오프" && t.id === rows[0].id,
      JSON.stringify({ t, rows }));
  }

  // ── D3 프로젝트 없는 세션 → null, 태스크 0 (새로 도입한 연결 칸이 빈 경우) ──
  {
    await bind(S(3), A, null);
    const t = await st.ensureSessionTask({ sessionId: S(3), owner: A, name: "소속 없음" });
    const t2 = await st.ensureSessionTask({ sessionId: S(19), owner: A, name: "행조차 없음" });
    chk("D3 소속 없는 세션·실행 세션 행이 없는 세션은 태스크를 만들지 않는다", t === null && t2 === null && (await taskIdOf(S(3))) === null,
      JSON.stringify({ t, t2 }));
  }

  // ── D4 남의 세션 → null, 아무것도 안 바뀐다 ──
  {
    const before = (await tasksOf(P1)).length;
    const t = await st.ensureSessionTask({ sessionId: S(1), owner: B, name: "가로채기" });
    const seen = await st.sessionTaskOf(S(1), B);
    chk("D4 남의 세션으로는 만들지도 보지도 못한다", t === null && seen === null && (await tasksOf(P1)).length === before,
      JSON.stringify({ t, seen }));
  }

  // ── D5 동시 보장 2건 → 태스크 정확히 1개 ──
  {
    await bind(S(5), A, P2);
    const [x, y] = await Promise.all([
      st.ensureSessionTask({ sessionId: S(5), owner: A, name: "경합" }),
      st.ensureSessionTask({ sessionId: S(5), owner: A, name: "경합" }),
    ]);
    const rows = (await tasksOf(P2)).filter((r) => r.name === "경합");
    const tid = await taskIdOf(S(5));
    chk("D5 동시 두 요청이어도 남는 태스크는 하나이고 둘 다 그 태스크를 가리킨다",
      rows.length === 1 && tid === rows[0].id && x?.id === tid && y?.id === tid && [x, y].filter((r) => r?.created).length === 1,
      JSON.stringify({ x, y, rows, tid }));
  }

  // ── D6 다른 프로젝트의 태스크를 잇기 → 거부, 연결 불변 ──
  {
    await bind(S(6), A, P1);
    const foreign = await mkTask(P2, "남의 프로젝트 태스크");
    const r = await st.bindSessionTask({ sessionId: S(6), owner: A, taskId: foreign });
    const also = await st.taskForProjectSession(P1, foreign);
    chk("D6 다른 프로젝트의 태스크는 잇지도(null) 세션 열기 재료로 받지도(null) 않는다",
      r === null && also === null && (await taskIdOf(S(6))) === null && (await taskRow(foreign)).status === "todo",
      JSON.stringify({ r, also, tid: await taskIdOf(S(6)) }));
  }

  // ── D7 할 일(담당자 없음) / 완료(담당자 있음) 태스크 잇기 ──
  {
    await bind(S(7), A, P1);
    const todo = await mkTask(P1, "환불 버튼");
    const r = await st.bindSessionTask({ sessionId: S(7), owner: A, taskId: todo });
    const row = await taskRow(todo);
    chk("D7a 할 일 태스크를 이으면 진행 중·담당자=연 사람", !!r && (await taskIdOf(S(7))) === todo && row.status === "in_progress" && row.assignee === A,
      JSON.stringify({ r, row }));

    await bind(S(8), A, P1);
    const done = await mkTask(P1, "영수증 메일", { status: "done", assignee: B });
    const r2 = await st.bindSessionTask({ sessionId: S(8), owner: A, taskId: done });
    const row2 = await taskRow(done);
    chk("D7b 완료된 태스크를 이으면 다시 진행 중(completed_at 비움)·기존 담당자는 유지",
      !!r2 && row2.status === "in_progress" && row2.assignee === B && row2.completed_at === null, JSON.stringify({ r2, row2 }));
  }

  // ── D8 이은 뒤 이름짓기 보장 → 이은 태스크 그대로, 새 태스크 0 ──
  {
    const before = (await tasksOf(P1)).length;
    const t = await st.ensureSessionTask({ sessionId: S(7), owner: A, name: "세션이 지은 이름" });
    chk("D8 태스크에서 연 세션은 이름을 지어도 새 태스크를 만들지 않는다",
      !!t && t.created === false && t.name === "환불 버튼" && (await tasksOf(P1)).length === before, JSON.stringify({ t }));
  }

  // ── D9 완료로(커스텀 상태 키 있음) → done·완료시각·status_raw 비움 ──
  {
    await bind(S(9), A, P1);
    const custom = await mkTask(P1, "커스텀 상태", { status: "todo", status_raw: "review" });
    await st.bindSessionTask({ sessionId: S(9), owner: A, taskId: custom });
    await itemsPool.query(`UPDATE project SET status_raw='review' WHERE id=$1`, [custom]);   // 잇기가 비운 키를 다시 세운다(완료 경로만 본다)
    const r = await st.setSessionTaskStatus({ sessionId: S(9), owner: A, status: "done" });
    const row = await taskRow(custom);
    chk("D9 세션이 완료로 바꾸면 done·완료시각·커스텀 상태 키 비움", r?.status === "done" && row.status === "done" && !!row.completed_at && row.status_raw === null,
      JSON.stringify({ r, row }));
    const back = await st.setSessionTaskStatus({ sessionId: S(9), owner: A, status: "in_progress" });
    const row2 = await taskRow(custom);
    chk("D9b 후속 작업이면 다시 진행 중(완료시각 비움)", back?.status === "in_progress" && row2.status === "in_progress" && row2.completed_at === null,
      JSON.stringify({ back, row2 }));
  }

  // ── D10 세션이 다른 프로젝트로 옮겨지면 연결이 풀린다(태스크 상태는 그대로) ──
  {
    const tid = await taskIdOf(S(1));
    await bind(S(1), A, P2);
    const row = await taskRow(tid);
    chk("D10 프로젝트를 옮기면 task_id 가 비고, 옛 태스크 상태는 건드리지 않는다",
      (await taskIdOf(S(1))) === null && row.status === "in_progress", JSON.stringify({ now: await taskIdOf(S(1)), row }));
    const again = await st.ensureSessionTask({ sessionId: S(1), owner: A, name: "결제 백오프" });
    const inP2 = (await tasksOf(P2)).filter((r) => r.name === "결제 백오프");
    chk("D10b 옮긴 뒤 보장은 새 프로젝트에 새로 만든다", !!again && again.created && again.project_id === P2 && inP2.length === 1,
      JSON.stringify({ again, inP2 }));
  }

  // ── D11 태스크별 세션 — 최근 것 먼저, 휴지통 세션 제외 ──
  {
    const tid = await mkTask(P1, "여러 세션");
    await bind(S(11), A, P1); await st.bindSessionTask({ sessionId: S(11), owner: A, taskId: tid });
    await itemsPool.query(`UPDATE execution_session SET created_at = now() - interval '1 hour' WHERE id=$1`, [S(11)]);
    await bind(S(12), A, P1); await st.bindSessionTask({ sessionId: S(12), owner: A, taskId: tid });
    await bind(S(13), A, P1); await st.bindSessionTask({ sessionId: S(13), owner: A, taskId: tid });
    await itemsPool.query(`INSERT INTO org_session_state(id, owner, label, label_source) VALUES($1,$2,'두번째','agent')`, [S(12), A]);
    await itemsPool.query(`INSERT INTO org_session_trash(session_id, owner) VALUES($1,$2)`, [S(13), A]);
    const m = await st.sessionsOfTasks([tid]);
    const got = (m.get(tid) || []).map((x) => x.id);
    const lbl = (m.get(tid) || []).find((x) => x.id === S(12))?.label;
    chk("D11 태스크의 세션은 최근 것 먼저·휴지통 세션 제외·이름은 세션 미러에서",
      JSON.stringify(got) === JSON.stringify([S(12), S(11)]) && lbl === "두번째", JSON.stringify({ got, lbl }));
  }

  // ── D12 태스크 삭제 → 세션 연결만 풀린다 ──
  {
    const tid = await taskIdOf(S(7));
    await itemsPool.query(`DELETE FROM project WHERE id=$1`, [tid]);
    const exists = (await itemsPool.query(`SELECT 1 FROM execution_session WHERE id=$1`, [S(7)])).rowCount;
    chk("D12 태스크가 지워지면 세션은 남고 task_id 만 빈다", exists === 1 && (await taskIdOf(S(7))) === null && (await st.sessionTaskOf(S(7), A)) === null);
  }

  // ── D13 맡은 태스크 없는 세션의 상태 변경 → null, 아무것도 안 바뀐다 ──
  {
    const before = JSON.stringify(await tasksOf(P1));
    const r = await st.setSessionTaskStatus({ sessionId: S(3), owner: A, status: "done" });
    chk("D13 맡은 태스크가 없으면 상태 변경은 null·무변경", r === null && JSON.stringify(await tasksOf(P1)) === before, JSON.stringify({ r }));
  }

  // ── N1·N2 이름 승계 — 자동으로 만든 태스크만, 사람이 손댔으면 물러난다 ──
  {
    await bind(S(16), A, P1);
    const t = await st.ensureSessionTask({ sessionId: S(16), owner: A, name: "사이드바 검색창 제거" });
    const r1 = await st.renameSessionTaskForLabel({ sessionId: S(16), owner: A, name: "검색창 제거", expectName: "사이드바 검색창 제거" });
    const row1 = await taskRow(t.id);
    chk("N1 세션이 더 나은 이름을 등록하면 태스크 이름이 한 번 따라간다", r1?.name === "검색창 제거" && (await tasksOf(P1)).some((x) => x.id === t.id && x.name === "검색창 제거"),
      JSON.stringify({ r1, row1 }));
    await itemsPool.query(`UPDATE project SET name='사람이 고친 이름' WHERE id=$1`, [t.id]);
    const r2 = await st.renameSessionTaskForLabel({ sessionId: S(16), owner: A, name: "또 다른 이름", expectName: "검색창 제거" });
    chk("N2 사람이 태스크 이름을 고쳤으면 승계가 물러난다", r2 === null && (await tasksOf(P1)).some((x) => x.id === t.id && x.name === "사람이 고친 이름"), JSON.stringify({ r2 }));
  }

  // ── I1·I2 복원 이어받기 — 이정표(superseded_by)를 따라 옛 세션의 태스크를 물려받는다 ──
  {
    await bind(S(17), A, P1);
    const old = await st.ensureSessionTask({ sessionId: S(17), owner: A, name: "복원 전 세션" });
    await itemsPool.query(`INSERT INTO org_session_state(id, owner, label, label_source, superseded_by) VALUES($1,$2,'복원 전 세션','agent',$3)`, [S(17), A, S(18)]);
    await bind(S(18), A, P1);
    const before = (await tasksOf(P1)).length;
    const got = await st.ensureSessionTask({ sessionId: S(18), owner: A, name: "복원 전 세션" });
    chk("I1 복원으로 id 가 바뀐 세션은 옛 태스크를 이어받는다(새로 만들지 않는다)",
      got?.id === old.id && got?.created === false && (await tasksOf(P1)).length === before && (await taskIdOf(S(18))) === old.id,
      JSON.stringify({ old: old?.id, got, n: (await tasksOf(P1)).length, before }));

    // I2 — 옛 세션의 태스크가 **다른 프로젝트**면 물려받지 않는다(새로 만든다)
    await itemsPool.query(`UPDATE execution_session SET task_id=NULL WHERE id=$1`, [S(18)]);
    const foreign = await mkTask(P2, "남의 프로젝트 태스크(이어받기 금지)");
    await itemsPool.query(`UPDATE execution_session SET task_id=$2 WHERE id=$1`, [S(17), foreign]);
    const n2 = await st.ensureSessionTask({ sessionId: S(18), owner: A, name: "복원 전 세션" });
    chk("I2 옛 세션의 태스크가 다른 프로젝트면 이어받지 않고 새로 만든다", !!n2 && n2.created === true && n2.id !== foreign && n2.project_id === P1,
      JSON.stringify({ n2, foreign }));
  }

  // ── T1 휴지통에 든 태스크는 «맡은 태스크 없음» 이다 ──
  {
    await bind(S(10), A, P1);
    const t = await st.ensureSessionTask({ sessionId: S(10), owner: A, name: "곧 버릴 태스크" });
    await itemsPool.query(`UPDATE project SET trashed_at=now() WHERE id=$1`, [t.id]);
    chk("T1 태스크가 휴지통에 들어가면 그 세션은 «맡은 태스크 없음»", (await st.sessionTaskOf(S(10), A)) === null);
    await itemsPool.query(`UPDATE project SET trashed_at=NULL WHERE id=$1`, [t.id]);
  }

  // ── R1·R2 이름짓기(relabelSession) 배선 — 첫 이름이면 태스크가 결과에 실린다 · 걸쇠에 져도 실린다 ──
  {
    await bind(S(15), A, P1);
    await itemsPool.query(`INSERT INTO org_session_state(id, owner, label, label_source) VALUES($1,$2,$1,'id')`, [S(15), A]);
    const r1 = await relabelSession({ userId: A }, S(15), "배선 확인", "agent");
    const tid = await taskIdOf(S(15));
    chk("R1 첫 이름(agent)이면 applied 이고 결과에 방금 만든 태스크(created)가 실린다",
      r1.applied === true && r1.task?.created === true && r1.task?.id === tid && tid != null && typeof r1.task_hint === "string",
      JSON.stringify({ r1, tid }));
    const r2 = await relabelSession({ userId: A }, S(15), "두 번째 이름", "agent");
    chk("R2 걸쇠에 진 두 번째 이름(applied:false)에도 맡은 태스크가 실린다(created=false)",
      r2.applied === false && r2.task?.id === tid && r2.task?.created === false, JSON.stringify(r2));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
