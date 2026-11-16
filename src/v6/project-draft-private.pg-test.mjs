// 초안 프로젝트 비공개 + 풀리는 조건(#5522) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/v6/project-draft-private.pg-test.mjs
//
// 왜 이 계층인가: 두 규칙이 전부 **SQL** 에 산다.
//  ① «초안은 만든 사람과 팀원만 본다» 는 목록 · 검색 · 단건 판정이 공유하는 술어(v6/visibility.ts projectVisPredicate)이고,
//    태스크 행은 조상 프로젝트까지 타고 올라가야 판정된다 — 목 풀로는 조인 방향 하나가 틀려도 초록이다.
//  ② «무언가를 남기면 풀린다» 는 UPDATE 의 WHERE(뿌리 해소)와 스윕의 CTE 다 — 저장 뒤 draft 를 SELECT 로 되읽어 판정한다.
//
//  사양 · 엣지 표
//   V1  만든 사람은 제 초안을 본다(단건 · 목록 · 상세 · 검색)
//   V2  남은 못 본다(단건 · 목록 · 상세 · 검색 · «숨은 프로젝트» 집합)
//   V3  팀원(project_member)은 본다
//   V4  초안의 태스크 · 서브태스크도 뿌리를 따라 같은 판정
//   V5  특권(null) · 뷰어 미지정(내부 경로)은 전부 본다
//   V6  PUBLIC_VIEWER — 목록에서는 초안이 빠진다 · ★«숨은 프로젝트»(= 잠긴 프로젝트) 집합에는 초안이 **안 든다**
//   V7  초안이 아닌 미분류 프로젝트는 종전대로 전원(무회귀)
//   V8  프로젝트 축을 끄면 초안도 전원에게 보인다
//   V9  뷰어 id 에 따옴표 · 역슬래시가 있어도 판정이 깨지지 않는다(술어에 글자로 들어간다)
//   V10 남의 초안의 태스크가 내게 배정돼 있어도 «내 할 일» 에 안 뜬다(배정은 열람 근거가 아니다)
//   R1  산출지식 연결 → 풀림 · 필요지식 연결 → 그대로
//   R2  작업기록(프로젝트 · 태스크에 단 것) → 풀림 · 수집해 온 기록(external_id) → 그대로
//   R3  코멘트(태스크에 단 것) → 뿌리 프로젝트가 풀림
//   R4  리스트 지정 → 풀림 · 미분류로 되돌리기(null) → 그대로
//   R5  스윕: 세션이 만든 파일(entry=generated) → 풀림 · 사람이 올린 파일(upload) → 그대로
//   R6  스윕: 일부러 만든 태스크(name_source NULL) → 풀림 · 세션 태스크(session) → 그대로
//   R7  첫 턴에 저절로 일어나는 일(이름 승계 · 세션 태스크)은 쓰는 자리에서도 스윕에서도 안 푼다
//   R8  스윕은 멱등 · 초안 아닌 것은 안 건드린다 · updated_at 을 안 바꾼다
//   R9  releaseProjectDraft — 초안 아닌 것 · 없는 id 는 null
//   R10 풀리면 곧바로 남에게 보인다(«숨은 프로젝트» 캐시가 버려진다)
//   I1  세션 생성(초대 있음 · 초안 프로젝트) → 초대받은 사람이 팀원이 되고 초안을 본다
//   I2  초대 변경 → 새로 초대한 사람도 팀원 · 초대를 거둬도 팀원에서 안 뺀다
//   I3  초안이 아닌 프로젝트의 세션 초대는 팀원을 만들지 않는다
//   I4  프로젝트에 나중에 붙인 세션(project_id 변경)도 초대받은 사람을 팀원으로 맞춘다
//   T1  지운 초안은 휴지통 개수에서 만든 사람에게만 센다
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const ps = await import(`${DIST}/v6/project-store.js`);
const vis = await import(`${DIST}/v6/visibility.js`);
const axes = await import(`${DIST}/v6/visibility-axes.js`);
const draft = await import(`${DIST}/v6/project-draft.js`);
const lists = await import(`${DIST}/v6/list-store.js`);
const act = await import(`${DIST}/activity/store.js`);
const td = await import(`${DIST}/v6/task-detail-store.js`);
const ss = await import(`${DIST}/sessions/session-state.js`);
const trash = await import(`${DIST}/v6/trash-store.js`);
const { AUTO_CREATED_MARK } = await import(`${DIST}/project/first-prompt-project.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = "__draftpriv_pg__";
const A = `${TAG}a`;          // 만든 사람
const B = `${TAG}b`;          // 남
const C = `${TAG}c`;          // 초대받은 사람 · 팀원
const D = `${TAG}d`;          // 나중에 초대받은 사람
const Q = `${TAG}o'brien\\x`; // 따옴표 · 역슬래시가 든 id
const ctxA = { actor: A, source: "web" };
const SHELL = `> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다\n\n## 첫 지시(원문)\n\n비밀스러운 첫 지시\n\n${AUTO_CREATED_MARK}`;

const draftOf = async (id) => (await itemsPool.query(`SELECT draft FROM project WHERE id=$1`, [id])).rows[0].draft;
const mkShell = async (name, actor = A) =>
  (await ps.createProject({ name: `${TAG} ${name}`, description: SHELL, dedupe: false, name_source: "rule", draft: true }, { actor, source: "web" })).id;
const mkPlain = async (name, actor = A) =>
  (await ps.createProject({ name: `${TAG} ${name}`, description: "사람이 만든 것", dedupe: false }, { actor, source: "web" })).id;
const inList = async (viewer, id) => (await ps.listProjects({ viewerVis: viewer })).some((p) => p.id === id);
const inSearch = async (viewer, q, id) => (await ps.searchProjects(q, { viewer, plain: true, limit: 100 })).some((p) => p.id === id);
const fresh = () => vis.invalidateVisibilityCache();
const members = async (id) => (await itemsPool.query(`SELECT member_id FROM project_member WHERE project_id=$1 ORDER BY member_id`, [id])).rows.map((r) => r.member_id);

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_session_state WHERE id LIKE $1`, [`${TAG}%`]).catch(() => undefined);
  await itemsPool.query(`DELETE FROM source WHERE external_system='local' AND title LIKE $1`, [`${TAG}%`]).catch(() => undefined);
  await itemsPool.query(`DELETE FROM activity WHERE title LIKE $1`, [`${TAG}%`]).catch(() => undefined);
  await itemsPool.query(`DELETE FROM project WHERE created_by LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM project_list WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${TAG}%`]);
}

try {
  await cleanup();
  // 프로젝트 축이 켜진 상태에서 시작한다(기본값 — 키가 없으면 켜짐). 다른 시험이 꺼 뒀을 수 있어 명시로 켠다.
  await axes.setVisAxes({ project: true }); axes.invalidateVisAxes();

  // ── V1 ~ V5 ──
  const d1 = await mkShell("V 초안");
  const t1 = (await ps.createTask({ projectId: d1, name: `${TAG} 세션 태스크`, name_source: "session" }, ctxA)).id;
  const s1 = (await ps.createTask({ projectId: d1, parentTaskId: t1, name: `${TAG} 서브`, name_source: "session" }, ctxA)).id;
  fresh();
  chk("V1 만든 사람은 제 초안을 본다 — 단건", await vis.canSeeProjectRow(d1, A));
  chk("V1b 만든 사람 — 목록", await inList(A, d1));
  chk("V1c 만든 사람 — 상세(getProject)", !!(await ps.getProject(d1, A)));
  chk("V1d 만든 사람 — 검색", await inSearch(A, "V 초안", d1));
  chk("V2 ★남은 초안을 못 본다 — 단건", !(await vis.canSeeProjectRow(d1, B)));
  chk("V2b ★남 — 목록에 없다", !(await inList(B, d1)));
  chk("V2c ★남 — 상세(getProject)는 없는 것처럼 undefined", (await ps.getProject(d1, B)) === undefined);
  chk("V2d ★남 — 검색에 없다(첫 지시 글로 찾아도)", !(await inSearch(B, "비밀스러운 첫 지시", d1)) && !(await inSearch(B, "V 초안", d1)));
  chk("V2e 남 — «숨은 프로젝트» 집합에 든다(세션 · 파일 · 자료가 함께 가려지는 근거)", (await vis.hiddenProjects(B)).ids.has(d1));
  chk("V2f 만든 사람의 «숨은 프로젝트» 집합에는 없다", !(await vis.hiddenProjects(A)).ids.has(d1));
  {
    // ★ 남의 초안이 따로 있어도 내 초안은 내게 숨지 않는다 — 술어의 하위 질의가 «이 행» 을 가리켜야 한다(맨 id 를 넘기면
    //  «안 보이는 초안이 하나라도 있으면 전부 숨김» 으로 뒤집힌다 — 2026-11-16 이 줄이 없을 때 실제로 그랬다).
    const dB = await mkShell("V 남의 초안", B);
    fresh();
    const hA = (await vis.hiddenProjects(A)).ids, hB = (await vis.hiddenProjects(B)).ids;
    chk("V2g ★초안이 사람마다 따로 있을 때 — 각자 제 것은 보고 남의 것만 숨는다(«숨은 프로젝트» 집합)",
      !hA.has(d1) && hA.has(dB) && hB.has(d1) && !hB.has(dB), JSON.stringify({ aOwn: hA.has(d1), aOther: hA.has(dB), bOther: hB.has(d1), bOwn: hB.has(dB) }));
    chk("V2h ★같은 상황의 목록 — 각자 제 초안만", (await inList(A, d1)) && !(await inList(A, dB)) && (await inList(B, dB)) && !(await inList(B, d1)));
  }
  chk("V4 ★초안의 태스크 — 남은 못 본다(태스크 행의 list_id · draft 는 비어 있다 → 뿌리로 판정)", !(await vis.canSeeProjectRow(t1, B)) && (await vis.canSeeProjectRow(t1, A)));
  chk("V4b ★초안의 서브태스크 — 남은 못 본다", !(await vis.canSeeProjectRow(s1, B)) && (await vis.canSeeProjectRow(s1, A)));
  chk("V4c 초안의 태스크는 남의 검색에 없다", !(await inSearch(B, "세션 태스크", t1)) && (await inSearch(A, "세션 태스크", t1)));
  chk("V5 특권(null)은 본다 — 단건", await vis.canSeeProjectRow(d1, null));
  chk("V5b 뷰어 미지정(내부 경로) 목록에는 있다", (await ps.listProjects({})).some((p) => p.id === d1));

  // ── V3 ──
  await ps.setProjectMembers(d1, [C], ctxA);
  chk("V3 팀원은 초안을 본다 — 단건 · 목록 · 태스크", (await vis.canSeeProjectRow(d1, C)) && (await inList(C, d1)) && (await vis.canSeeProjectRow(t1, C)));
  chk("V3b 팀원의 «숨은 프로젝트» 집합에서 곧바로 빠진다(팀원 설정이 캐시를 버린다)", !(await vis.hiddenProjects(C)).ids.has(d1));
  chk("V3c 팀원이 생겨도 남은 여전히 못 본다", !(await vis.canSeeProjectRow(d1, B)));

  // ── V6 ──
  chk("V6 PUBLIC_VIEWER 목록에는 초안이 없다(조직 전체에 나가는 산출물에 초안이 실리지 않는다)", !(await inList(vis.PUBLIC_VIEWER, d1)));
  fresh();
  chk("V6b ★PUBLIC_VIEWER 의 «숨은 프로젝트»(= 잠긴 프로젝트)에는 초안이 안 든다 — 들면 새 세션의 기록 범위가 전부 «대상 제한» 으로 파생된다",
    !(await vis.hiddenProjects(vis.PUBLIC_VIEWER)).ids.has(d1));

  // ── V7 ──
  const p1 = await mkPlain("V 평범");
  chk("V7 초안이 아닌 미분류 프로젝트는 종전대로 남도 본다(단건 · 목록)", (await vis.canSeeProjectRow(p1, B)) && (await inList(B, p1)));

  // ── V9 ──
  {
    const dq = await mkShell("V 따옴표", Q);
    fresh();
    let threw = null, own = false, other = true, bSees = true;
    try {
      own = await vis.canSeeProjectRow(dq, Q);
      other = await vis.canSeeProjectRow(d1, Q);       // Q 는 d1 의 팀원이 아니다
      bSees = await vis.canSeeProjectRow(dq, B);
      await ps.listProjects({ viewerVis: Q });
      await vis.hiddenProjects(Q);
    } catch (e) { threw = e; }
    chk("V9 ★뷰어 id 에 따옴표 · 역슬래시가 있어도 SQL 이 깨지지 않는다", threw === null, String(threw?.message));
    chk("V9b 그 뷰어도 제 초안은 보고 남의 초안은 못 본다(글자로 넣은 값이 그대로 견줘진다)", own === true && other === false && bSees === false, JSON.stringify({ own, other, bSees }));
  }

  // ── V10 ──
  {
    await itemsPool.query(`UPDATE project SET assignee=$2, status='todo', status_category='unstarted' WHERE id=$1`, [t1, B]);
    const mine = await ps.listMyTasks(B, 200, B);
    chk("V10 남의 초안의 태스크가 내게 배정돼 있어도 «내 할 일» 에 안 뜬다", !mine.some((t) => t.id === t1));
    const mineA = await ps.listMyTasks(B, 200, null);
    chk("V10b (대조) 특권으로 보면 그 태스크가 있다 — 위 판정이 공허하지 않다", mineA.some((t) => t.id === t1));
  }

  // ── V8 ──
  {
    await axes.setVisAxes({ project: false }); axes.invalidateVisAxes(); fresh();
    const off = await axes.axisOn("project");
    if (off) { chk("V8 (전제) 프로젝트 축을 끌 수 있다", false, "org_runtime_config 단일행이 없어 축을 끄지 못했다"); }
    else {
      chk("V8 프로젝트 축을 끄면 초안도 남에게 보인다(끄면 전원 공개 — 리스트와 같은 규칙)", (await vis.canSeeProjectRow(d1, B)) && (await inList(B, d1)));
    }
    await axes.setVisAxes({ project: true }); axes.invalidateVisAxes(); fresh();
    chk("V8b 다시 켜면 다시 가려진다", !(await vis.canSeeProjectRow(d1, B)));
  }

  // ── R1 ──
  {
    const id = await mkShell("R1");
    await itemsPool.query(`INSERT INTO knowledge(name, title, body_md) VALUES($1,$1,'x') ON CONFLICT DO NOTHING`, [`${TAG}k1`]);
    await ps.linkProjectKnowledge(id, `${TAG}k1`, "required", ctxA);
    chk("R1 필요지식 연결은 초안 그대로(정리지 산출이 아니다)", (await draftOf(id)) === true);
    await ps.linkProjectKnowledge(id, `${TAG}k1`, "produced", ctxA);
    chk("R1b ★산출지식 연결 → 풀린다", (await draftOf(id)) === false);
    chk("R10 풀리면 곧바로 남에게 보인다 — 단건 · «숨은 프로젝트» 에서 빠짐", (await vis.canSeeProjectRow(id, B)) && !(await vis.hiddenProjects(B)).ids.has(id));
  }

  // ── R2 ──
  {
    const id = await mkShell("R2 수집");
    await act.logActivity({ type: "other", title: `${TAG} 수집해 온 기록`, projectId: id, external_system: "clickup", external_id: `${TAG}ext1` }, A);
    chk("R2 수집해 온 작업기록(external_id)은 초안 그대로", (await draftOf(id)) === true);
    await act.logActivity({ type: "decision", title: `${TAG} 직접 남긴 기록`, projectId: id }, A);
    chk("R2b ★직접 남긴 작업기록 → 풀린다", (await draftOf(id)) === false);
    const id2 = await mkShell("R2 태스크");
    const tk = (await ps.createTask({ projectId: id2, name: `${TAG} 세션 태스크`, name_source: "session" }, ctxA)).id;
    chk("R7 세션 태스크 생성(name_source=session)은 초안 그대로", (await draftOf(id2)) === true);
    await act.logActivity({ type: "review", title: `${TAG} 태스크에 단 기록`, projectId: tk }, A);
    chk("R2c ★태스크에 단 작업기록 → 뿌리 프로젝트가 풀린다", (await draftOf(id2)) === false);
  }

  // ── R3 ──
  {
    const id = await mkShell("R3");
    const tk = (await ps.createTask({ projectId: id, name: `${TAG} 세션 태스크`, name_source: "session" }, ctxA)).id;
    const sub = (await ps.createTask({ projectId: id, parentTaskId: tk, name: `${TAG} 서브`, name_source: "session" }, ctxA)).id;
    await td.postComment(sub, "서브태스크에 단 코멘트", ctxA);
    chk("R3 ★서브태스크에 단 코멘트 → 뿌리 프로젝트가 풀린다(두 단을 타고 올라간다)", (await draftOf(id)) === false);
  }

  // ── R4 ──
  {
    const id = await mkShell("R4");
    const lid = (await itemsPool.query(`INSERT INTO project_list(name) VALUES($1) RETURNING id`, [`${TAG} 리스트`])).rows[0].id;
    await lists.setProjectListForProject(id, null, ctxA);
    chk("R4 미분류로 두기(null)는 초안 그대로", (await draftOf(id)) === true);
    await lists.setProjectListForProject(id, lid, ctxA);
    chk("R4b ★리스트 지정 → 풀린다", (await draftOf(id)) === false);
  }

  // ── R7 ──
  {
    const id = await mkShell("R7");
    await ps.claimProjectName(id, `${TAG} 세션이 지은 이름`, "session", ctxA);
    await ps.claimProjectName(id, `${TAG} 에이전트가 지은 이름`, "agent", ctxA);
    await ps.createTask({ projectId: id, name: `${TAG} 세션 태스크`, name_source: "session" }, ctxA);
    chk("R7b ★이름 승계 · 세션 태스크는 초안 그대로(첫 턴에 저절로 일어난다)", (await draftOf(id)) === true);
    const n = await draft.sweepDraftReleases();
    chk("R7c ★스윕도 그 초안을 안 푼다", (await draftOf(id)) === true, `sweep released=${n}`);
  }

  // ── R5 · R6 · R8 ──
  {
    const fGen = await mkShell("R5 만든 파일");
    const fUp = await mkShell("R5 올린 파일");
    const tExplicit = await mkShell("R6 일부러 만든 태스크");
    const tSession = await mkShell("R6 세션 태스크");
    const plain = await mkPlain("R8 평범");
    const src = (pid, entry, n) => itemsPool.query(
      `INSERT INTO source(kind, title, body_md, external_system, external_instance, external_id, fields)
       VALUES('local_file', $1, '', 'local', '', $2, $3::jsonb)`,
      [`${TAG} ${n}`, `project:${pid}/${n}`, JSON.stringify({ entry, root: "project", path: n })]);
    await src(fGen, "generated", "report.md");
    await src(fUp, "upload", "uploads/photo.png");
    await ps.createTask({ projectId: tExplicit, name: `${TAG} 일부러 만든 태스크` }, ctxA);                 // name_source NULL
    await ps.createTask({ projectId: tSession, name: `${TAG} 세션 태스크`, name_source: "session" }, ctxA);
    const before = (await itemsPool.query(`SELECT updated_at FROM project WHERE id=$1`, [fGen])).rows[0].updated_at;
    const n1 = await draft.sweepDraftReleases();
    const after = (await itemsPool.query(`SELECT updated_at FROM project WHERE id=$1`, [fGen])).rows[0].updated_at;
    chk("R5 ★스윕 — 세션이 만든 파일(entry=generated)이 있으면 풀린다", (await draftOf(fGen)) === false, `released=${n1}`);
    chk("R5b ★스윕 — 사람이 올린 파일(upload)만 있으면 초안 그대로(첫 지시 첨부가 저절로 옮겨진다)", (await draftOf(fUp)) === true);
    chk("R6 ★스윕 — 일부러 만든 태스크(name_source NULL)가 있으면 풀린다", (await draftOf(tExplicit)) === false);
    chk("R6b ★스윕 — 세션 태스크뿐이면 초안 그대로", (await draftOf(tSession)) === true);
    chk("R8 스윕은 updated_at 을 안 바꾼다(목록의 «최근 수정» 순서를 뒤섞지 않는다)", new Date(before).getTime() === new Date(after).getTime());
    chk("R8b 스윕은 초안 아닌 프로젝트를 안 건드린다", (await draftOf(plain)) === false);
    const n2 = await draft.sweepDraftReleases();
    chk("R8c 스윕은 멱등 — 다시 돌리면 0건", n2 === 0, `released=${n2}`);
    // 스윕이 놓친 것이 없는지: 위 R1~R4 로 이미 풀린 것 말고, 남은 초안은 «남긴 것이 없는» 것뿐이어야 한다.
    chk("R8d 남긴 것이 없는 초안들은 스윕 뒤에도 초안이다(d1 · 올린 파일 · 세션 태스크)", (await draftOf(d1)) === true && (await draftOf(fUp)) === true && (await draftOf(tSession)) === true);
  }

  // ── R9 ──
  {
    const plain = await mkPlain("R9");
    chk("R9 releaseProjectDraft — 초안 아닌 프로젝트는 null(아무 일도 없다)", (await draft.releaseProjectDraft(plain, "comment", ctxA)) === null && (await draftOf(plain)) === false);
    chk("R9b releaseProjectDraft — 없는 id 는 null(던지지 않는다)", (await draft.releaseProjectDraft(2147483000, "comment", ctxA)) === null);
    const id = await mkShell("R9c");
    const tk = (await ps.createTask({ projectId: id, name: `${TAG} 세션 태스크`, name_source: "session" }, ctxA)).id;
    chk("R9c releaseProjectDraft(태스크 id) — 뿌리 프로젝트 id 를 돌려준다", (await draft.releaseProjectDraft(tk, "task", ctxA)) === id && (await draftOf(id)) === false);
  }

  // ── I1 ~ I4 ──
  {
    const sessBase = (id, projectId, invites) => ({
      id, owner: A, label: "세션", harness: "claude", dir: null, root_key: "personal", subpath: null, flags: {}, auto_approve: false,
      invites, project_id: projectId, project_src: projectId ? "v6" : null, read_only: false, incognito: false, created: 1, last_busy: 1,
    });
    const id = await mkShell("I1");
    chk("I1 (전제) 초대 전에는 C 가 그 초안을 못 본다", !(await vis.canSeeProjectRow(id, C)));
    await ss.upsertSessionState(sessBase(`${TAG}s1`, id, [C]));
    chk("I1b ★세션 생성(초대 C · 초안 프로젝트) → C 가 팀원이 된다", (await members(id)).includes(C), JSON.stringify(await members(id)));
    {
      const sees = await vis.canSeeProjectRow(id, C), hidden = (await vis.hiddenProjects(C)).ids.has(id);
      chk("I1c ★C 가 초안을 본다 — 단건 · «숨은 프로젝트» 에 없음(세션 판정이 초대받은 사람에게 닫히지 않는다)", sees && !hidden, JSON.stringify({ sees, hidden }));
    }
    chk("I1d 초대받지 않은 B 는 여전히 못 본다", !(await vis.canSeeProjectRow(id, B)));
    await ss.updateSessionStateMeta(`${TAG}s1`, { invites: [C, D] });
    chk("I2 ★초대 변경 → 새로 초대한 D 도 팀원", (await members(id)).includes(D) && (await vis.canSeeProjectRow(id, D)));
    await ss.updateSessionStateMeta(`${TAG}s1`, { invites: [] });
    chk("I2b 초대를 거둬도 팀원에서는 안 뺀다(다른 길로 들어온 팀원과 가를 근거가 없다)", (await members(id)).includes(C) && (await members(id)).includes(D));
    await ss.upsertSessionState(sessBase(`${TAG}s2`, id, [A, C]));
    chk("I1e 만든 사람 자신은 팀원 행으로 안 넣는다(이미 created_by 로 본다)", !(await members(id)).includes(A));

    const plain = await mkPlain("I3");
    await ss.upsertSessionState(sessBase(`${TAG}s3`, plain, [C]));
    chk("I3 초안이 아닌 프로젝트의 세션 초대는 팀원을 만들지 않는다(종전 동작 그대로)", (await members(plain)).length === 0, JSON.stringify(await members(plain)));

    const late = await mkShell("I4");
    await ss.upsertSessionState(sessBase(`${TAG}s4`, null, [C]));
    chk("I4 (전제) 프로젝트 없이 연 세션 — 팀원 없음", (await members(late)).length === 0);
    await ss.updateSessionStateMeta(`${TAG}s4`, { project_id: late, project_src: "v6" });
    chk("I4b ★나중에 초안 프로젝트에 붙이면 그때 초대받은 사람이 팀원이 된다", (await members(late)).includes(C));
  }

  // ── T1 ──
  {
    const id = await mkShell("T1 지울 초안");
    const base = { gate: true, visibleListIds: null };
    const beforeA = (await trash.countDeleted({ ...base, draftViewer: A })).project;
    const beforeB = (await trash.countDeleted({ ...base, draftViewer: B })).project;
    await ps.deleteProject(id, ctxA);
    const afterA = (await trash.countDeleted({ ...base, draftViewer: A })).project;
    const afterB = (await trash.countDeleted({ ...base, draftViewer: B })).project;
    chk("T1 ★지운 초안 — 만든 사람의 휴지통 개수에는 는다", afterA === Math.min(beforeA + 1, trash.TRASH_COUNT_CAP), JSON.stringify({ beforeA, afterA }));
    chk("T1b ★지운 초안 — 남의 휴지통 개수에는 안 는다", afterB === beforeB, JSON.stringify({ beforeB, afterB }));
    const rows = await trash.listDeleted(500, 0, "project", false);
    const row = rows.find((r) => r.key === String(id));
    chk("T1c 휴지통 줄에 판정 근거(draft · created_by)가 실린다", !!row && row.draft === true && row.created_by === A, JSON.stringify(row && { draft: row.draft, created_by: row.created_by }));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await axes.setVisAxes({ project: true }).catch(() => undefined);
  await cleanup().catch(() => undefined);
  await itemsPool.end().catch(() => undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
