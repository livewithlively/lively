// 프로젝트 초대제(#5598) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/v6/project-invite-only.pg-test.mjs
//
// 왜 이 계층인가: 규칙이 전부 **SQL 과 설정 행**에 산다.
//  ① «초대제 프로젝트는 만든 사람과 팀원만 본다» 는 초안(#5522)과 한 술어(v6/visibility.ts privateProjectSql)다 — 목 풀로는
//    OR 한 쪽이 빠져도 초록이다. 그리고 «초안이 풀려도 닫혀 있다» 는 두 칸(draft · invite_only)이 실제로 따로 움직여야 성립한다.
//  ② «새 프로젝트 공개 방식» 은 org_runtime_config 한 칸이고, createProject 가 그걸 읽어 표시를 찍는다.
//  ③ 공개 범위 바꾸기(만든 사람만)는 UPDATE 의 WHERE 가 지킨다.
//
//  사양 · 엣지 표
//   M1  설정이 비어 있으면(NULL) 초대제 · 모르는 값도 초대제
//   M2  초대제에서 사람이 만든 프로젝트 → invite_only=true
//   M3  전체 공개에서 사람이 만든 프로젝트 → invite_only=false
//   M4  명시값(invite_only)은 설정을 이긴다(양쪽 다)
//   M5  만든 사람이 없으면(ctx.actor 없음) 초대제여도 닫지 않는다(볼 사람이 없는 프로젝트가 된다)
//   M6  ★설정을 바꿔도 이미 있는 프로젝트의 표시는 그대로다(양방향)
//   M7  setProjectAccessMode — 모르는 값은 거절
//   V1  초대제 프로젝트 — 만든 사람은 본다(단건 · 목록 · 상세 · 검색)
//   V2  ★남은 못 본다(단건 · 목록 · 상세 · 검색 · «숨은 프로젝트» 집합) — 리스트가 없어도 · 초안이 아니어도
//   V3  팀원은 본다 · 태스크 · 서브태스크도 뿌리를 따라 같은 판정
//   V4  ★초안이 풀려도(산출 · 본문 수정 · 완료 · draft:false) 초대제 프로젝트는 닫혀 있다
//   V5  ★전체 공개 방식의 초안은 풀리면 남에게 보인다(종전 동작 — 대조)
//   V6  PUBLIC_VIEWER — 목록에서는 빠진다 · «숨은 프로젝트»(= 잠긴 프로젝트) 집합에는 **안 든다**(기록 범위가 뒤집히지 않게)
//   V7  프로젝트 축을 끄면 초대제 프로젝트도 전원에게 보인다 · 다시 켜면 닫힌다
//   V8  열린 리스트에 넣어도 초대제 프로젝트는 닫혀 있다 · 잠긴 리스트 ∧ 초대제 = 둘 다 통과해야 본다
//   V9  inviteOnlyProjectIds(밖으로 내보내는 자리) — 초대제만 들고 초안 · 열린 것은 안 든다 · 축이 꺼지면 빈 집합
//   A1  setProjectAccess(open) — 만든 사람: 열린다 · 곧바로 남에게 보인다 · 초안이면 초안도 내린다
//   A2  setProjectAccess(invite) — 만든 사람: 닫힌다 · 곧바로 남에게서 사라진다 · 팀원은 계속 본다
//   A3  ★만든 사람이 아니면 양방향 모두 거절(ProjectAccessOwnerError) · 값이 안 바뀐다 — 팀원이어도
//   A4  만든 사람이 비어 있는 행은 닫을 수 없다
//   A5  같은 값으로 부르면 아무것도 안 바뀐다(updated_at 그대로)
//   A6  ★닫을 때 — 그 프로젝트의 세션에 초대돼 있던 사람이 팀원이 된다(세션에서 밀려나지 않게)
//   I1  ★초대제 프로젝트(초안 아님)의 세션에 초대 → 초대받은 사람이 팀원이 되고 프로젝트를 본다
//   I2  열린 프로젝트의 세션 초대는 팀원을 만들지 않는다(무회귀)
//   I3  나중에 초대제 프로젝트에 붙인 세션도 초대받은 사람을 팀원으로 맞춘다
//   R1  팀원 저장 규칙(순수) — 닫힌 프로젝트에서 남을 빼는 것은 만든 사람만 · 자기만 빼기 · 넣기는 통과 · 열린 프로젝트는 종전대로
//   R2  새로 들어온 사람(알림 대상) — 이전 팀원 · 만든 사람 · 저장한 사람 제외
//   M8  ★프로젝트 축이 꺼진 워크스페이스에서는 초대제여도 표시를 찍지 않는다(나중에 축을 켜는 순간 한꺼번에 닫히지 않게) · 명시값은 따른다
//   M9  설정 행이 없는 워크스페이스에서도 방식을 저장할 수 있다(행을 만든다)
//   M10 ★생성은 방식을 보관값이 아니라 지금 값으로 읽는다(다른 프로세스가 «전체 공개 → 초대제» 로 바꾼 직후에도 닫힌 채 태어난다)
//   A7  ★닫을 때 — 그 프로젝트의 태스크 · 서브태스크 담당자(구성원)도 팀원이 된다 · 구성원이 아닌 담당자(외부 신원)는 안 넣는다
//   T1  지운 초대제 프로젝트는 휴지통 개수에서 만든 사람에게만 센다 · 줄에 판정 근거가 실린다
//   T2  ★초대제 프로젝트에서 지운 태스크 · 서브태스크 — 남의 휴지통 목록 · 개수에 없고 · 남이 되살리거나 미리 볼 수 없다 ·
//       만든 사람과 팀원은 본다 · 열린 프로젝트에서 지운 태스크는 종전대로 전원(무회귀)
//   T3  뿌리를 못 찾는 지운 태스크(뿌리 프로젝트도 지워졌다) — 그 태스크를 만든 사람에게만
//   N1  ★댓글 알림 — 초대제 프로젝트의 태스크 댓글에서 팀원이 아닌 사람을 언급해도 그 사람에게 알림이 안 간다(이름 · 발췌가 새지 않는다) ·
//       팀원에게는 간다 · 열린 프로젝트에서는 종전대로 언급된 사람에게 간다(무회귀)
//   L1  축 끄기 확인 화면의 «제한 중» 수가 초대제 프로젝트를 닫으면 1 늘고 열면 1 준다
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const ps = await import(`${DIST}/v6/project-store.js`);
const vis = await import(`${DIST}/v6/visibility.js`);
const axes = await import(`${DIST}/v6/visibility-axes.js`);
const access = await import(`${DIST}/v6/project-access.js`);
const invite = await import(`${DIST}/v6/project-invite.js`);
const draft = await import(`${DIST}/v6/project-draft.js`);
const ss = await import(`${DIST}/sessions/session-state.js`);
const trash = await import(`${DIST}/v6/trash-store.js`);
const { trashCapabilities } = await import(`${DIST}/capabilities/trash.js`);
const cn = await import(`${DIST}/v6/comment-notify.js`);
const { AUTO_CREATED_MARK } = await import(`${DIST}/project/first-prompt-project.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = "__inviteonly_pg__";
const A = `${TAG}a`;          // 만든 사람
const B = `${TAG}b`;          // 남
const C = `${TAG}c`;          // 초대받은 사람 · 팀원
const D = `${TAG}d`;          // 세션에 초대돼 있던 사람
const ctxA = { actor: A, source: "web" };
const ctxB = { actor: B, source: "web" };
const ctxC = { actor: C, source: "web" };
const SHELL = `> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다\n\n## 첫 지시(원문)\n\n초대제 비밀 지시\n\n${AUTO_CREATED_MARK}`;

const rowOf = async (id) => (await itemsPool.query(`SELECT draft, invite_only, updated_at FROM project WHERE id=$1`, [id])).rows[0];
const mk = async (name, extra = {}, ctx = ctxA) =>
  (await ps.createProject({ name: `${TAG} ${name}`, description: "사람이 만든 것", dedupe: false, ...extra }, ctx)).id;
const mkShell = async (name, extra = {}, ctx = ctxA) =>
  (await ps.createProject({ name: `${TAG} ${name}`, description: SHELL, dedupe: false, name_source: "rule", draft: true, ...extra }, ctx)).id;
const inList = async (viewer, id) => (await ps.listProjects({ viewerVis: viewer })).some((p) => p.id === id);
const inSearch = async (viewer, q, id) => (await ps.searchProjects(q, { viewer, plain: true, limit: 100 })).some((p) => p.id === id);
const fresh = () => vis.invalidateVisibilityCache();
const members = async (id) => (await itemsPool.query(`SELECT member_id FROM project_member WHERE project_id=$1 ORDER BY member_id`, [id])).rows.map((r) => r.member_id);
const setMode = async (mode) => {
  if (mode === null) { await itemsPool.query(`UPDATE org_runtime_config SET project_access = NULL WHERE id=1`); access.invalidateProjectAccessMode(); }
  else await access.setProjectAccessMode(mode);
};
const throwsOwner = async (fn) => { try { await fn(); return false; } catch (e) { return e instanceof ps.ProjectAccessOwnerError; } };

const cap = (name) => trashCapabilities.find((c) => c.name === name);
const asUser = (id) => [{ userId: id, email: "", scopes: ["memory"], projects: ["*"] }, { viewer: id, actor: id, source: "web" }];
const trashKeys = async (viewer) => new Set(((await cap("deleted_list").handler({ entity: "project", limit: 500 }, ...asUser(viewer))).entries || []).map((e) => e.key));
const refuses = async (fn) => { try { await fn(); return false; } catch (e) { return Number(e?.status) === 404 || Number(e?.statusCode) === 404 || /없|not found/i.test(String(e?.message)); } };
const notesFor = async (member) => (await itemsPool.query(
  `SELECT title, body, href, kind FROM org_app_notification WHERE member_id = $1 ORDER BY created_at`, [member])).rows;

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_app_notification WHERE member_id LIKE $1`, [`${TAG}%`]).catch(() => undefined);
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1`, [`${TAG}%`]).catch(() => undefined);
  await itemsPool.query(`DELETE FROM org_session_state WHERE id LIKE $1`, [`${TAG}%`]).catch(() => undefined);
  await itemsPool.query(`DELETE FROM project WHERE created_by LIKE $1 OR name LIKE $2`, [`${TAG}%`, `${TAG}%`]);
  await itemsPool.query(`DELETE FROM project_list WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${TAG}%`]);
}

const modeBefore = (await itemsPool.query(`SELECT project_access FROM org_runtime_config WHERE id=1`)).rows[0]?.project_access ?? null;

try {
  await cleanup();
  await axes.setVisAxes({ project: true }); axes.invalidateVisAxes();
  //  구성원 명부 — 담당자 넣기(A7)는 구성원만 넣고, 댓글 언급(N1)은 명부의 표시 이름으로 찾는다.
  for (const [id, name] of [[A, "초대시험가"], [B, "초대시험나"], [C, "초대시험다"], [D, "초대시험라"]]) {
    await itemsPool.query(`INSERT INTO org_member(id, display_name, updated_by) VALUES($1, $2, 'pg-test')`, [id, name]);
  }

  // ── M1 ~ M7 ──
  await setMode(null);
  chk("M1 설정이 비어 있으면 초대제(기본값)", (await access.projectAccessMode()) === "invite");
  await itemsPool.query(`UPDATE org_runtime_config SET project_access = 'something-else' WHERE id=1`); access.invalidateProjectAccessMode();
  chk("M1b 모르는 값도 초대제(닫는 쪽)", (await access.projectAccessMode()) === "invite");
  await setMode(null);
  const pInvite = await mk("M2 초대제에서 만든 것");
  chk("M2 ★초대제에서 사람이 만든 프로젝트 → invite_only=true", (await rowOf(pInvite)).invite_only === true);
  const shellInvite = await mkShell("M2b 초대제에서 저절로 생긴 초안");
  chk("M2b 초대제의 초안 → draft=true 이고 invite_only=true", (await rowOf(shellInvite)).draft === true && (await rowOf(shellInvite)).invite_only === true);
  chk("M4 명시값 false 는 초대제 설정을 이긴다", (await rowOf(await mk("M4 명시 열림", { invite_only: false }))).invite_only === false);
  {
    const orphan = (await ps.createProject({ name: `${TAG} M5 만든 사람 없음`, dedupe: false }, { source: "connector" })).id;
    chk("M5 ★만든 사람이 없으면 초대제여도 닫지 않는다", (await rowOf(orphan)).invite_only === false);
    const orphan2 = (await ps.createProject({ name: `${TAG} M5b 만든 사람 없음 · 명시 true`, dedupe: false, invite_only: true }, { source: "connector" })).id;
    chk("M5b 만든 사람이 없으면 명시 true 여도 닫지 않는다", (await rowOf(orphan2)).invite_only === false);
  }
  await setMode("open");
  chk("M3 (전제) 전체 공개로 바꿨다", (await access.projectAccessMode()) === "open");
  const pOpen = await mk("M3 전체 공개에서 만든 것");
  chk("M3 ★전체 공개에서 사람이 만든 프로젝트 → invite_only=false", (await rowOf(pOpen)).invite_only === false);
  const shellOpen = await mkShell("M3b 전체 공개의 초안");
  chk("M3b 전체 공개의 초안 → draft=true 이고 invite_only=false(풀리면 열린다)", (await rowOf(shellOpen)).draft === true && (await rowOf(shellOpen)).invite_only === false);
  chk("M4b 명시값 true 는 전체 공개 설정을 이긴다", (await rowOf(await mk("M4b 명시 닫힘", { invite_only: true }))).invite_only === true);
  chk("M6 ★설정을 전체 공개로 바꿔도 초대제로 만든 프로젝트는 그대로 닫혀 있다", (await rowOf(pInvite)).invite_only === true && !(await vis.canSeeProjectRow(pInvite, B)));
  await setMode("invite");
  fresh();
  chk("M6b ★설정을 초대제로 바꿔도 전체 공개로 만든 프로젝트는 그대로 열려 있다", (await rowOf(pOpen)).invite_only === false && (await vis.canSeeProjectRow(pOpen, B)) && (await inList(B, pOpen)));
  {
    let threw = false;
    try { await access.setProjectAccessMode("everyone"); } catch { threw = true; }
    chk("M7 모르는 방식은 저장을 거절한다", threw && (await access.projectAccessMode()) === "invite");
  }

  // ── M8 · M9 ──
  {
    await axes.setVisAxes({ project: false }); axes.invalidateVisAxes();
    const offDefault = await mk("M8 축 꺼짐 · 초대제 · 생략");
    chk("M8 ★프로젝트 축이 꺼져 있으면 초대제여도 표시를 찍지 않는다", (await access.projectAccessMode()) === "invite" && (await rowOf(offDefault)).invite_only === false);
    chk("M8b 축이 꺼져 있어도 명시값(true)은 따른다", (await rowOf(await mk("M8b 축 꺼짐 · 명시 닫힘", { invite_only: true }))).invite_only === true);
    await axes.setVisAxes({ project: true }); axes.invalidateVisAxes(); fresh();
    chk("M8c ★축을 다시 켜도 그 프로젝트는 닫히지 않는다(만들 때 화면이 «나만» 이라고 말한 적이 없다)", (await vis.canSeeProjectRow(offDefault, B)) && (await inList(B, offDefault)));
    //  M9 — 설정 행이 없는 워크스페이스. 행을 지웠다가 저장 → 생기고 값이 읽힌다. 끝나면 원래 행을 되살린다.
    const keep = (await itemsPool.query(`SELECT * FROM org_runtime_config WHERE id=1`)).rows[0];
    await itemsPool.query(`DELETE FROM org_runtime_config WHERE id=1`);
    try {
      access.invalidateProjectAccessMode();
      chk("M9 (전제) 행이 없으면 초대제로 읽는다", (await access.projectAccessMode()) === "invite");
      await access.setProjectAccessMode("open");
      chk("M9b ★행이 없어도 저장된다(행을 만든다)", (await access.projectAccessMode()) === "open"
        && (await itemsPool.query(`SELECT project_access FROM org_runtime_config WHERE id=1`)).rows[0]?.project_access === "open");
    } finally {
      await itemsPool.query(`DELETE FROM org_runtime_config WHERE id=1`);
      if (keep) {
        const cols = Object.keys(keep);
        await itemsPool.query(`INSERT INTO org_runtime_config(${cols.map((c) => `"${c}"`).join(",")}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(",")})`,
          cols.map((c) => (keep[c] !== null && typeof keep[c] === "object" && !(keep[c] instanceof Date) ? JSON.stringify(keep[c]) : keep[c])));
      }
      await setMode("invite");
    }
  }

  // ── M10 — 생성은 보관값이 아니라 지금 값을 읽는다(다른 프로세스가 방식을 바꾼 직후) ──
  {
    await setMode("open");
    chk("M10 (전제) 이 프로세스가 «전체 공개» 를 보관하고 있다", (await access.projectAccessMode()) === "open");
    //  다른 프로세스가 바꾼 것처럼 — 이 프로세스의 보관값은 버리지 않고 DB 만 바꾼다.
    await itemsPool.query(`UPDATE org_runtime_config SET project_access = 'invite' WHERE id=1`);
    const born = await mk("M10 방식이 방금 초대제로 바뀐 뒤 만든 것");
    chk("M10b ★보관값이 «전체 공개» 여도 방금 초대제로 바뀌었으면 닫힌 채 태어난다(열린 채 태어난 프로젝트는 되돌릴 수 없다)", (await rowOf(born)).invite_only === true);
    access.invalidateProjectAccessMode();
    await setMode("invite");
  }

  // ── V1 ~ V3 ──
  const t1 = (await ps.createTask({ projectId: pInvite, name: `${TAG} 초대제 태스크` }, ctxA)).id;
  const s1 = (await ps.createTask({ projectId: pInvite, parentTaskId: t1, name: `${TAG} 초대제 서브` }, ctxA)).id;
  fresh();
  chk("V1 만든 사람은 본다 — 단건 · 목록 · 상세 · 검색",
    (await vis.canSeeProjectRow(pInvite, A)) && (await inList(A, pInvite)) && !!(await ps.getProject(pInvite, A)) && (await inSearch(A, "M2 초대제에서", pInvite)));
  chk("V2 ★남은 못 본다 — 단건", !(await vis.canSeeProjectRow(pInvite, B)));
  chk("V2b ★남 — 목록에 없다", !(await inList(B, pInvite)));
  chk("V2c ★남 — 상세(getProject)는 없는 것처럼 undefined", (await ps.getProject(pInvite, B)) === undefined);
  chk("V2d ★남 — 검색에 없다", !(await inSearch(B, "M2 초대제에서", pInvite)));
  chk("V2e ★남 — «숨은 프로젝트» 집합에 든다(리스트도 없고 초안도 아닌데 — 세션 · 파일 · 자료가 함께 가려지는 근거)", (await vis.hiddenProjects(B)).ids.has(pInvite));
  chk("V2f 만든 사람의 «숨은 프로젝트» 집합에는 없다", !(await vis.hiddenProjects(A)).ids.has(pInvite));
  chk("V3 (전제) 초대 전에는 태스크 · 서브태스크도 남에게 안 보인다", !(await vis.canSeeProjectRow(t1, C)) && !(await vis.canSeeProjectRow(s1, C)));
  await ps.setProjectMembers(pInvite, [C], ctxA);
  chk("V3b ★팀원(초대한 사람)은 본다 — 단건 · 목록 · 태스크 · 서브태스크",
    (await vis.canSeeProjectRow(pInvite, C)) && (await inList(C, pInvite)) && (await vis.canSeeProjectRow(t1, C)) && (await vis.canSeeProjectRow(s1, C)));
  chk("V3c 팀원이 생겨도 남은 여전히 못 본다", !(await vis.canSeeProjectRow(pInvite, B)) && !(await vis.canSeeProjectRow(t1, B)));
  chk("V3d 특권(null) · 뷰어 미지정(내부 경로)은 본다", (await vis.canSeeProjectRow(pInvite, null)) && (await ps.listProjects({})).some((p) => p.id === pInvite));

  // ── V4 · V5 ──
  {
    const viaRelease = await mkShell("V4 풀리는 초대제 초안");
    chk("V4 (전제) 초대제 초안 — 남은 못 본다", !(await vis.canSeeProjectRow(viaRelease, B)));
    chk("V4a 초안 풀기(releaseProjectDraft)가 돈다", (await draft.releaseProjectDraft(viaRelease, "produced_knowledge", ctxA)) === viaRelease);
    chk("V4b ★풀린 뒤에도 닫혀 있다 — draft=false · invite_only=true · 남은 못 본다",
      (await rowOf(viaRelease)).draft === false && (await rowOf(viaRelease)).invite_only === true && !(await vis.canSeeProjectRow(viaRelease, B)) && !(await inList(B, viaRelease)));
    const viaEdit = await mkShell("V4c 본문 고치는 초대제 초안");
    await ps.updateProject(viaEdit, { append_description: "정리한 본문" }, ctxA);
    chk("V4c ★본문을 고쳐 초안이 풀려도 닫혀 있다", (await rowOf(viaEdit)).draft === false && !(await vis.canSeeProjectRow(viaEdit, B)));
    const viaFlag = await mkShell("V4d draft false 초대제 초안");
    await ps.updateProject(viaFlag, { draft: false }, ctxA);
    chk("V4d ★«초안 풀기»(draft:false)는 공개가 아니다 — 닫혀 있다", (await rowOf(viaFlag)).draft === false && (await rowOf(viaFlag)).invite_only === true && !(await vis.canSeeProjectRow(viaFlag, B)));
    const viaDone = await mkShell("V4e 완료하는 초대제 초안");
    await ps.updateProjectStatus(viaDone, "done", null, ctxA);
    chk("V4e ★완료해 초안이 풀려도 닫혀 있다", (await rowOf(viaDone)).draft === false && !(await vis.canSeeProjectRow(viaDone, B)));
    const swept = await mkShell("V4f 스윕이 푸는 초대제 초안");
    await ps.createTask({ projectId: swept, name: `${TAG} 일부러 만든 태스크` }, ctxA);
    await draft.sweepDraftReleases();
    chk("V4f ★스윕이 풀어도 닫혀 있다", (await rowOf(swept)).draft === false && (await rowOf(swept)).invite_only === true && !(await vis.canSeeProjectRow(swept, B)));
    // 대조 — 전체 공개 방식의 초안은 풀리면 열린다(#5522 그대로).
    chk("V5 (전제) 전체 공개의 초안 — 남은 못 본다", !(await vis.canSeeProjectRow(shellOpen, B)));
    await draft.releaseProjectDraft(shellOpen, "produced_knowledge", ctxA);
    chk("V5b 전체 공개의 초안은 풀리면 남에게 보인다(종전 동작)", (await vis.canSeeProjectRow(shellOpen, B)) && (await inList(B, shellOpen)));
  }

  // ── V6 ──
  chk("V6 PUBLIC_VIEWER 목록에는 초대제 프로젝트가 없다(조직 전체에 나가는 산출물에 실리지 않는다)", !(await inList(vis.PUBLIC_VIEWER, pInvite)));
  fresh();
  chk("V6b ★PUBLIC_VIEWER 의 «숨은 프로젝트»(= 잠긴 프로젝트)에는 초대제 프로젝트가 안 든다 — 들면 거의 모든 세션의 기록 범위가 «대상 제한» 으로 파생된다",
    !(await vis.hiddenProjects(vis.PUBLIC_VIEWER)).ids.has(pInvite));

  // ── V7 ──
  await axes.setVisAxes({ project: false }); axes.invalidateVisAxes(); fresh();
  chk("V7 프로젝트 축을 끄면 초대제 프로젝트도 남에게 보인다(축이 꺼진 조직에서는 아무것도 가려지지 않는다)", (await vis.canSeeProjectRow(pInvite, B)) && (await inList(B, pInvite)));
  chk("V9c 축이 꺼지면 inviteOnlyProjectIds 는 빈 집합(반출도 종전대로)", (await vis.inviteOnlyProjectIds()).size === 0);
  await axes.setVisAxes({ project: true }); axes.invalidateVisAxes(); fresh();
  chk("V7b 다시 켜면 닫힌다", !(await vis.canSeeProjectRow(pInvite, B)) && !(await inList(B, pInvite)));

  // ── V8 ──
  {
    const openL = Number((await itemsPool.query(`INSERT INTO project_list(name) VALUES($1) RETURNING id`, [`${TAG} 열린 리스트`])).rows[0].id);
    const inOpenList = await mk("V8 열린 리스트 안의 초대제", { list_id: openL });
    fresh();
    chk("V8 ★열린 리스트에 넣어도 초대제 프로젝트는 닫혀 있다", (await rowOf(inOpenList)).invite_only === true && !(await vis.canSeeProjectRow(inOpenList, B)) && !(await inList(B, inOpenList)));
    const lockedL = Number((await itemsPool.query(`INSERT INTO project_list(name, visibility) VALUES($1, 'members') RETURNING id`, [`${TAG} 잠긴 리스트`])).rows[0].id);
    await itemsPool.query(`INSERT INTO project_list_member(list_id, member_id) VALUES($1, $2), ($1, $3)`, [lockedL, A, B]);
    const inLocked = await mk("V8b 잠긴 리스트 안의 초대제", { list_id: lockedL });
    await ps.setProjectMembers(inLocked, [C], ctxA);
    fresh();
    chk("V8b 잠긴 리스트 ∧ 초대제 — 리스트 대상이어도 팀원이 아니면 못 본다(B)", !(await vis.canSeeProjectRow(inLocked, B)));
    chk("V8c 잠긴 리스트 ∧ 초대제 — 팀원이어도 리스트 대상이 아니면 못 본다(C)", !(await vis.canSeeProjectRow(inLocked, C)));
    chk("V8d 잠긴 리스트 ∧ 초대제 — 만든 사람(리스트 대상)은 본다", await vis.canSeeProjectRow(inLocked, A));
  }

  // ── V9 ──
  {
    const ids = await vis.inviteOnlyProjectIds();
    chk("V9 inviteOnlyProjectIds — 초대제 프로젝트가 든다", ids.has(pInvite));
    //  ⚠ 초안은 **아직 풀리지 않은 것**으로 잰다(위 V5 가 shellOpen 을 풀었다 — 그걸로 재면 «초안은 안 든다» 를 재지 못한다).
    const stillDraft = await mkShell("V9b 아직 초안인 전체 공개 초안", { invite_only: false });
    const ids2 = await vis.inviteOnlyProjectIds();
    chk("V9b 열린 프로젝트는 안 든다", !ids2.has(pOpen));
    chk("V9b2 ★전체 공개의 초안(아직 초안)은 안 든다 — 초안의 반출은 종전대로다", (await rowOf(stillDraft)).draft === true && !ids2.has(stillDraft));
  }

  // ── A1 ~ A6 ──
  {
    const a1 = await mkShell("A1 여는 초대제 초안");
    chk("A1 (전제) 닫혀 있고 초안이다", (await rowOf(a1)).invite_only === true && (await rowOf(a1)).draft === true && !(await vis.canSeeProjectRow(a1, B)));
    const opened = await ps.setProjectAccess(a1, "open", ctxA);
    chk("A1b ★만든 사람이 연다 — invite_only=false · 초안도 내린다", opened.invite_only === false && opened.draft === false);
    chk("A1c ★곧바로 남에게 보인다(«숨은 프로젝트» 캐시가 버려진다)", (await vis.canSeeProjectRow(a1, B)) && (await inList(B, a1)) && !(await vis.hiddenProjects(B)).ids.has(a1));
    await ps.setProjectMembers(a1, [C], ctxA);
    const closed = await ps.setProjectAccess(a1, "invite", ctxA);
    chk("A2 ★만든 사람이 닫는다 — invite_only=true · 초안은 그대로(false)", closed.invite_only === true && closed.draft === false);
    chk("A2b ★곧바로 남에게서 사라진다", !(await vis.canSeeProjectRow(a1, B)) && !(await inList(B, a1)) && (await vis.hiddenProjects(B)).ids.has(a1));
    chk("A2c 팀원은 계속 본다", (await vis.canSeeProjectRow(a1, C)) && (await inList(C, a1)));

    chk("A3 ★남이 열려 하면 거절(ProjectAccessOwnerError)", await throwsOwner(() => ps.setProjectAccess(a1, "open", ctxB)));
    chk("A3b ★팀원이 열려 해도 거절 — 초대받은 사람이 남의 프로젝트를 전원에게 열 수 없다", await throwsOwner(() => ps.setProjectAccess(a1, "open", ctxC)));
    chk("A3c 거절 뒤 값이 그대로다", (await rowOf(a1)).invite_only === true);
    chk("A3d ★남이 열린 프로젝트를 닫으려 해도 거절 — 남의 프로젝트를 모두에게서 숨길 수 없다",
      (await throwsOwner(() => ps.setProjectAccess(pOpen, "invite", ctxB))) && (await rowOf(pOpen)).invite_only === false);
    chk("A3e 신원이 없으면 거절", await throwsOwner(() => ps.setProjectAccess(a1, "open", { source: "web" })));

    const orphan = Number((await itemsPool.query(
      `INSERT INTO project(level, name, status) VALUES('project', $1, 'active') RETURNING id`, [`${TAG} A4 만든 사람 없는 행`])).rows[0].id);
    chk("A4 ★만든 사람이 비어 있는 행은 닫을 수 없다(닫으면 아무도 못 본다)",
      (await throwsOwner(() => ps.setProjectAccess(orphan, "invite", ctxA))) && (await rowOf(orphan)).invite_only === false);

    const before = (await rowOf(a1)).updated_at;
    await ps.setProjectAccess(a1, "invite", ctxA);
    chk("A5 같은 값으로 부르면 아무것도 안 바뀐다(updated_at 그대로)", String((await rowOf(a1)).updated_at) === String(before));

    // A6 — 열린 프로젝트의 세션에 D 가 초대돼 있다(그때는 팀원이 안 된다) → 닫으면 팀원이 된다.
    const a6 = await mk("A6 세션이 있는 열린 프로젝트", { invite_only: false });
    const sessBase = (id, projectId, invites, owner = A) => ({
      id, owner, label: "세션", harness: "claude", dir: null, root_key: "personal", subpath: null, flags: {}, auto_approve: false,
      invites, project_id: projectId, project_src: projectId ? "v6" : null, read_only: false, incognito: false, created: 1, last_busy: 1,
    });
    await ss.upsertSessionState(sessBase(`${TAG}s-a6`, a6, [D, A]));
    chk("I2 열린 프로젝트의 세션 초대는 팀원을 만들지 않는다(무회귀)", (await members(a6)).length === 0);
    await ps.setProjectAccess(a6, "invite", ctxA);
    chk("A6 ★닫을 때 — 세션에 초대돼 있던 사람이 팀원이 된다(만든 사람 자신은 안 든다)", JSON.stringify(await members(a6)) === JSON.stringify([D]), JSON.stringify(await members(a6)));
    chk("A6b 그 사람은 닫힌 뒤에도 프로젝트를 본다(초대받은 세션에서 밀려나지 않는다)", (await vis.canSeeProjectRow(a6, D)) && !(await vis.hiddenProjects(D)).ids.has(a6));
    chk("A6c 초대받지 않은 남은 못 본다", !(await vis.canSeeProjectRow(a6, B)));

    // ── A7 — 닫을 때 담당자도 팀원으로 ──
    const a7 = await mk("A7 담당자가 있는 열린 프로젝트", { invite_only: false });
    const a7t = (await ps.createTask({ projectId: a7, name: `${TAG} A7 태스크` }, ctxA)).id;
    const a7s = (await ps.createTask({ projectId: a7, parentTaskId: a7t, name: `${TAG} A7 서브` }, ctxA)).id;
    await itemsPool.query(`UPDATE project SET assignee = $2 WHERE id = $1`, [a7t, C]);                       // 단일 담당자 칸 — 구성원
    await itemsPool.query(`INSERT INTO task_assignee(task_id, member_id) VALUES($1, $2), ($1, $3)`, [a7s, D, "clickup:999 외부 담당"]);   // 서브태스크 · 구성원 + 외부 신원
    await ps.setProjectAccess(a7, "invite", ctxA);
    chk("A7 ★닫을 때 — 태스크 · 서브태스크 담당자(구성원)가 팀원이 된다", JSON.stringify(await members(a7)) === JSON.stringify([C, D].sort()), JSON.stringify(await members(a7)));
    chk("A7b 그 담당자는 닫힌 뒤에도 제 태스크를 본다", (await vis.canSeeProjectRow(a7t, C)) && (await vis.canSeeProjectRow(a7s, D)));
    chk("A7c 구성원이 아닌 담당자(외부 신원)는 팀원으로 넣지 않는다", !(await members(a7)).includes("clickup:999 외부 담당"));

    // ── I1 · I3 ──
    const i1 = await mk("I1 초대제(초안 아님)");
    chk("I1 (전제) 초대제 · 초안 아님 · C 는 못 본다", (await rowOf(i1)).invite_only === true && (await rowOf(i1)).draft === false && !(await vis.canSeeProjectRow(i1, C)));
    await ss.upsertSessionState(sessBase(`${TAG}s-i1`, i1, [C]));
    chk("I1b ★초대제 프로젝트의 세션에 초대 → 초대받은 사람이 팀원이 된다", (await members(i1)).includes(C));
    chk("I1c ★그 사람이 프로젝트를 본다 · «숨은 프로젝트» 집합에서 곧바로 빠진다", (await vis.canSeeProjectRow(i1, C)) && !(await vis.hiddenProjects(C)).ids.has(i1));
    await ss.updateSessionStateMeta(`${TAG}s-i1`, { invites: [C, D] });
    chk("I1d 초대를 더하면 그 사람도 팀원", (await members(i1)).includes(D));
    await ss.updateSessionStateMeta(`${TAG}s-i1`, { invites: [] });
    chk("I1e 초대를 거둬도 팀원에서 빼지 않는다(프로젝트에서 빼는 것은 프로젝트의 [공유])", (await members(i1)).includes(C) && (await members(i1)).includes(D));
    const i3 = await mk("I3 나중에 붙이는 초대제");
    await ss.upsertSessionState(sessBase(`${TAG}s-i3`, null, [C]));
    chk("I3 (전제) 프로젝트 없이 연 세션 — 팀원 없음", (await members(i3)).length === 0);
    await ss.updateSessionStateMeta(`${TAG}s-i3`, { project_id: i3, project_src: "v6" });
    chk("I3b ★나중에 초대제 프로젝트에 붙이면 그때 초대받은 사람이 팀원이 된다", (await members(i3)).includes(C));
  }

  // ── R1 · R2 (순수 규칙 — 같은 dist 에서 불러 판정만) ──
  {
    const r = invite.memberEditRefusal;
    chk("R1 닫힌 프로젝트 — 만든 사람은 누구든 뺀다", r({ private: true, owner: A, actor: A, prev: [B, C], next: [] }) === null);
    chk("R1b ★닫힌 프로젝트 — 초대받은 사람이 남을 빼면 거절", typeof r({ private: true, owner: A, actor: B, prev: [B, C], next: [B] }) === "string");
    chk("R1c 닫힌 프로젝트 — 초대받은 사람이 자기만 빼는 것(나가기)은 통과", r({ private: true, owner: A, actor: B, prev: [B, C], next: [C] }) === null);
    chk("R1d 닫힌 프로젝트 — 초대받은 사람이 넣기만 하는 것은 통과", r({ private: true, owner: A, actor: B, prev: [B], next: [B, C, D] }) === null);
    chk("R1e ★닫힌 프로젝트 — 넣으면서 남을 빼면 거절", typeof r({ private: true, owner: A, actor: B, prev: [B, C], next: [B, D] }) === "string");
    chk("R1f 열린 프로젝트 — 종전대로 누구나 넣고 뺀다", r({ private: false, owner: A, actor: B, prev: [B, C], next: [] }) === null);
    chk("R1g 닫힌 프로젝트 — 신원이 없으면 남을 못 뺀다", typeof r({ private: true, owner: A, actor: null, prev: [C], next: [] }) === "string");
    chk("R1h isPrivateProject — 초대제 · 초안 · 둘 다 아님", invite.isPrivateProject({ invite_only: true }) && invite.isPrivateProject({ draft: true }) && !invite.isPrivateProject({ draft: false, invite_only: false }) && !invite.isPrivateProject(null));
    const n = invite.newProjectInvitees;
    chk("R2 새로 들어온 사람 — 이전 팀원 · 만든 사람 · 저장한 사람을 뺀다", JSON.stringify(n([B], [B, C, A, D], A, D)) === JSON.stringify([C]));
    chk("R2b 이전 명단을 모르면 전부 새 사람(만든 사람 · 저장한 사람 제외)", JSON.stringify(n(null, [B, A], A, A)) === JSON.stringify([B]));
    const t = invite.projectInviteNotifyText("상민", "프로젝트 초대제");
    chk("R2c 알림 문구 — 누가 · 어느 프로젝트에", t.title.includes("상민") && t.title.includes("«프로젝트 초대제»") && t.title.includes("초대"));
    chk("R2d 알림 주소 — 프로젝트 화면", invite.projectHref(42) === "#/projects2/p/42");
  }

  // ── T1 ──
  {
    const id = await mk("T1 지울 초대제");
    const base = { gate: true, visibleListIds: null };
    const beforeA = (await trash.countDeleted({ ...base, privateViewer: A })).project;
    const beforeB = (await trash.countDeleted({ ...base, privateViewer: B })).project;
    await ps.deleteProject(id, ctxA);
    const afterA = (await trash.countDeleted({ ...base, privateViewer: A })).project;
    const afterB = (await trash.countDeleted({ ...base, privateViewer: B })).project;
    chk("T1 ★지운 초대제 프로젝트 — 만든 사람의 휴지통 개수에는 는다", afterA === Math.min(beforeA + 1, trash.TRASH_COUNT_CAP), JSON.stringify({ beforeA, afterA }));
    chk("T1b ★지운 초대제 프로젝트 — 남의 휴지통 개수에는 안 는다", afterB === beforeB, JSON.stringify({ beforeB, afterB }));
    const row = (await trash.listDeleted(500, 0, "project", false)).find((r) => r.key === String(id));
    chk("T1c 휴지통 줄에 판정 근거(invite_only · created_by)가 실린다", !!row && row.invite_only === true && row.draft === false && row.created_by === A,
      JSON.stringify(row && { invite_only: row.invite_only, draft: row.draft, created_by: row.created_by }));
  }

  // ── T2 · T3 — 지운 태스크는 뿌리 프로젝트의 공개 범위를 탄다 ──
  {
    const pr = await mk("T2 태스크를 지울 초대제");
    await ps.setProjectMembers(pr, [C], ctxA);
    const tk = (await ps.createTask({ projectId: pr, name: `${TAG} T2 비밀 태스크` }, ctxA)).id;
    const sb = (await ps.createTask({ projectId: pr, parentTaskId: tk, name: `${TAG} T2 비밀 서브` }, ctxA)).id;
    const tk2 = (await ps.createTask({ projectId: pr, name: `${TAG} T2 남을 태스크` }, ctxA)).id;
    const sb2 = (await ps.createTask({ projectId: pr, parentTaskId: tk2, name: `${TAG} T2 지울 서브` }, ctxA)).id;
    const openPr = await mk("T2 열린 프로젝트", { invite_only: false });
    const openTk = (await ps.createTask({ projectId: openPr, name: `${TAG} T2 열린 태스크` }, ctxA)).id;
    const base = { gate: true, visibleListIds: null };
    const cntB0 = (await trash.countDeleted({ ...base, privateViewer: B })).project;
    const cntA0 = (await trash.countDeleted({ ...base, privateViewer: A })).project;
    const cntC0 = (await trash.countDeleted({ ...base, privateViewer: C })).project;
    await ps.deleteTaskNode(sb2, ctxA);      // 서브태스크만(부모 태스크는 살아 있다)
    await ps.deleteTaskNode(tk, ctxA);       // 태스크(그 서브태스크 sb 는 함께 사라진다 — 스냅샷은 태스크 행)
    await ps.deleteTaskNode(openTk, ctxA);
    const keysA = await trashKeys(A), keysB = await trashKeys(B), keysC = await trashKeys(C);
    chk("T2 (배선) 만든 사람의 휴지통 목록에는 지운 태스크 · 서브태스크가 있다", keysA.has(String(tk)) && keysA.has(String(sb2)), JSON.stringify([...keysA].slice(0, 8)));
    chk("T2b ★남의 휴지통 목록에는 초대제 프로젝트에서 지운 태스크 · 서브태스크가 없다", !keysB.has(String(tk)) && !keysB.has(String(sb2)));
    chk("T2c 팀원의 휴지통 목록에는 있다(그 프로젝트를 보는 사람이다)", keysC.has(String(tk)) && keysC.has(String(sb2)));
    chk("T2d 열린 프로젝트에서 지운 태스크는 종전대로 남에게도 보인다(무회귀)", keysB.has(String(openTk)));
    const cntB1 = (await trash.countDeleted({ ...base, privateViewer: B })).project;
    const cntA1 = (await trash.countDeleted({ ...base, privateViewer: A })).project;
    const cntC1 = (await trash.countDeleted({ ...base, privateViewer: C })).project;
    const capd = (n) => Math.min(n, trash.TRASH_COUNT_CAP);
    chk("T2e ★개수 — 남에게는 열린 프로젝트의 태스크 1건만 는다", cntB1 === capd(cntB0 + 1), JSON.stringify({ cntB0, cntB1 }));
    chk("T2f 개수 — 만든 사람 · 팀원에게는 3건 는다(개수 = 목록 길이)", cntA1 === capd(cntA0 + 3) && cntC1 === capd(cntC0 + 3), JSON.stringify({ cntA0, cntA1, cntC0, cntC1 }));
    chk("T2g ★남은 그 태스크를 되살릴 수 없다(없는 것과 같은 답)", await refuses(() => cap("content_restore").handler({ entity: "project", key: String(tk) }, ...asUser(B))));
    chk("T2h ★남은 그 태스크의 스냅샷(본문)을 미리 볼 수 없다", await refuses(() => cap("content_snapshot").handler({ entity: "project", key: String(tk) }, ...asUser(B))));
    chk("T2i 거절 뒤에도 태스크는 지워진 채다", (await itemsPool.query(`SELECT 1 FROM project WHERE id=$1`, [tk])).rows.length === 0);
    chk("T2j deletedTaskRootId — 태스크는 부모가 뿌리 · 서브태스크는 조부모가 뿌리 · 프로젝트 행은 null",
      (await trash.deletedTaskRootId("task", pr)) === pr && (await trash.deletedTaskRootId("subtask", tk2)) === pr
      && (await trash.deletedTaskRootId("project", pr)) === null && (await trash.deletedTaskRootId("subtask", null)) === null
      && (await trash.deletedTaskRootId("subtask", tk)) === null);
    void sb;
    // T3 — 뿌리 프로젝트까지 지워졌다 → 뿌리를 못 찾는다 → 그 태스크를 만든 사람에게만.
    const gone = await mk("T3 통째로 지울 열린 프로젝트", { invite_only: false });
    const goneTk = (await ps.createTask({ projectId: gone, name: `${TAG} T3 고아 태스크` }, ctxB)).id;   // B 가 만든 태스크
    await ps.deleteTaskNode(goneTk, ctxB);
    await ps.deleteProject(gone, ctxA);
    chk("T3 ★뿌리를 못 찾는 지운 태스크 — 그 태스크를 만든 사람에게만 보인다", (await trashKeys(B)).has(String(goneTk)) && !(await trashKeys(C)).has(String(goneTk)));
  }

  // ── N1 — 댓글 알림은 그 프로젝트를 보는 사람에게만 ──
  {
    const pr = await mk("N1 댓글 초대제");
    await ps.setProjectMembers(pr, [C], ctxA);
    const tk = (await ps.createTask({ projectId: pr, name: `${TAG} N1 인원 계획` }, ctxA)).id;
    await itemsPool.query(`DELETE FROM org_app_notification WHERE member_id LIKE $1`, [`${TAG}%`]);
    await cn.notifyTaskComment(tk, { author: A, body: "@초대시험나 @초대시험다 이 계획은 아직 비밀이에요" }, 1);
    const nb = await notesFor(B), nc = await notesFor(C);
    chk("N1 ★팀원이 아닌 사람을 언급해도 그 사람에게 알림이 안 간다(태스크 이름 · 발췌가 새지 않는다)", nb.length === 0, JSON.stringify(nb));
    chk("N1b (배선) 팀원에게는 언급 알림이 간다 — 알림 장치가 실제로 돈다", nc.length === 1 && nc[0].kind === "mention" && String(nc[0].body).includes("비밀"), JSON.stringify(nc));
    const openPr = await mk("N1 댓글 열린 프로젝트", { invite_only: false });
    const openTk = (await ps.createTask({ projectId: openPr, name: `${TAG} N1 열린 태스크` }, ctxA)).id;
    await cn.notifyTaskComment(openTk, { author: A, body: "@초대시험나 확인 부탁해요" }, 2);
    chk("N1c 열린 프로젝트에서는 종전대로 언급된 사람에게 간다(무회귀)", (await notesFor(B)).length === 1);
  }

  // ── L1 ──
  {
    const locked = async () => (await axes.axisLockSummary()).find((s) => s.axis === "project").locked;
    const n0 = await locked();
    const l1 = await mk("L1 열린 프로젝트", { invite_only: false });
    chk("L1 (전제) 열린 프로젝트를 만들어도 «제한 중» 수는 그대로다", (await locked()) === n0);
    await ps.setProjectAccess(l1, "invite", ctxA);
    chk("L1b ★초대제로 닫으면 «제한 중» 수가 1 는다(축을 끄면 그만큼이 전원에게 열린다)", (await locked()) === n0 + 1, JSON.stringify({ n0, now: await locked() }));
    await ps.setProjectAccess(l1, "open", ctxA);
    chk("L1c 다시 열면 1 준다", (await locked()) === n0);
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await axes.setVisAxes({ project: true }).catch(() => undefined);
  await itemsPool.query(`UPDATE org_runtime_config SET project_access = $1 WHERE id=1`, [modeBefore]).catch(() => undefined);
  await cleanup().catch(() => undefined);
  await itemsPool.end().catch(() => undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
