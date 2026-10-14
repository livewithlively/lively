// 같은 id 복원(#4694 T4)의 DB 쪽 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서(스키마 마이그레이션 뒤), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=<테스트 DB> node src/sessions/session-revive.pg-test.mjs
//
// 왜 이 계층인가: 같은 id 로 되살린 세션이 «원하는 세션» 으로 읽히는지, 지난 판의 기억이 남는지, 사람이 치운 세션이 목록에
//  되올라오는지가 **전부 SQL 조건**이다 — upsert 의 ON CONFLICT 가 무엇을 덮고 무엇을 남기나, 정리 UPDATE 의 WHERE(주인·이음),
//  인스턴스 상태 판정의 status·closed_reason. 목 풀로는 조건 하나를 지워도 초록이다. 그래서 **부작용을 SELECT 로 되읽어** 판정한다.
//
//  사양·엣지 표: 스크래치패드 spec.md — R1~R7(«끝났다» 표식 정리) · I1~I5(인스턴스).
//  ⚠ 실 테이블을 쓴다(CI 의 테스트 DB 는 initAllSchemas 전체 체인) — 이 시험 전용 id·주인만 쓰고 끝에 지운다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/sessions/session-state.js`);
const inst = await import(`${DIST}/org/store/app-instances.js`);
const { reviveSessionInstance } = await import(`${DIST}/terminal/session-launch.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__revive_pg_a__", B = "__revive_pg_b__";
const S = (x) => `box-__pgtest-revive-${x}`;
const CONV = "6f1d3c1e-4a8b-4f2e-9c11-2b7f0a9e5d31";

const row0 = (id, over = {}) => ({
  id, owner: A, label: "되살릴 세션", harness: "claude", dir: "/work/shared/project/1", root_key: "shared", subpath: "project/1",
  flags: {}, auto_approve: false, invites: [], project_id: null, project_src: null, read_only: false, incognito: false,
  created: 1_000, last_busy: 1_100, label_source: "human", kind: "human", ...over,
});

async function cleanup() {
  const ids = Array.from({ length: 10 }, (_, i) => S(i));
  await itemsPool.query(`DELETE FROM org_session_conv WHERE box_id = ANY($1::text[])`, [ids]);
  await itemsPool.query(`DELETE FROM org_session_state WHERE id = ANY($1::text[])`, [ids]);
  const inIds = (await itemsPool.query(`SELECT id FROM org_app_instance WHERE owner_member = ANY($1::text[])`, [[A, B]])).rows.map((r) => r.id);
  if (inIds.length) await itemsPool.query(`DELETE FROM org_app_instance_project WHERE instance_id = ANY($1::text[])`, [inIds]);
  await itemsPool.query(`DELETE FROM org_app_instance WHERE owner_member = ANY($1::text[])`, [[A, B]]);
}

const instRow = async (owner, ref) => (await itemsPool.query(
  `SELECT status, closed_reason, state FROM org_app_instance WHERE owner_member=$1 AND subject_kind='session' AND subject_ref=$2`, [owner, ref])).rows;

try {
  await cleanup();

  // ── R1 지난 판을 /exit 로 끝낸 행을 **같은 id 로 다시 쓰고**(createSession reuseId 의 upsert) 정리한다 ──
  {
    const id = S(1);
    await st.upsertSessionState(row0(id));
    await st.setClaudeSessionId(id, CONV, A, `/home/box_a/.claude/projects/p/${CONV}.jsonl`);
    await st.markSessionExited(id, A, "prompt_input_exit");
    //  같은 id 재생성 — 생성 시각이 새로 오고, 이름 출처·종류는 다른 값이 와도(복원이 보내는 값) 바뀌면 안 된다.
    await st.upsertSessionState(row0(id, { created: 2_000, last_busy: null, label_source: "rule", kind: "task" }));
    const before = await st.getSessionState(id);
    chk("R1a upsert 만으로는 지난 판의 종료 표식이 남는다(그래서 정리가 필요하다 — 이 줄이 빨개지면 정리 자체가 불필요해진 것)",
      before?.exited_at !== null && before?.exit_reason === "prompt_input_exit", JSON.stringify(before));
    const r = await st.reviveSessionState(id, A);
    const after = await st.getSessionState(id);
    chk("R1 정리 → 종료 시각·사유가 비었다", r === true && after?.exited_at === null && after?.exit_reason === null, JSON.stringify({ r, after }));
    chk("R1 대화 id·대화 파일 경로는 남는다(같은 id 복원이 매핑을 잃지 않는다)",
      after?.claude_session_id === CONV && String(after?.transcript_path || "").endsWith(`${CONV}.jsonl`), JSON.stringify(after));
    chk("R1 이름 출처·종류는 남는다(복원 한 번에 걸쇠가 풀리지 않는다)", after?.label_source === "human" && after?.kind === "human", JSON.stringify(after));
    chk("R1 생성 시각은 새 판의 것이다(목록의 «시작 중» 유예가 새 판 기준으로 선다)", after?.created === 2_000, String(after?.created));
  }

  // ── R2 OOM 사유만 있는 행 ──
  {
    const id = S(2);
    await st.upsertSessionState(row0(id));
    await st.markSessionOomKilled(id);
    const mid = await st.getSessionState(id);
    await st.reviveSessionState(id, A);
    const after = await st.getSessionState(id);
    chk("R2 OOM 사유가 비었다(되살린 세션을 «메모리 부족으로 죽은 세션» 으로 그리지 않는다)",
      mid?.exit_reason === "oom" && after?.exit_reason === null, JSON.stringify({ mid: mid?.exit_reason, after: after?.exit_reason }));
  }

  // ── R3 노드 스냅샷에서 발견한 행 표식 ──
  {
    const id = S(3);
    await st.upsertSessionState(row0(id));
    await itemsPool.query(`UPDATE org_session_state SET discovered=true WHERE id=$1`, [id]);
    await st.reviveSessionState(id, A);
    const after = await st.getSessionState(id);
    chk("R3 발견 행 표식이 비었다(게이트웨이가 좌표를 정해 다시 띄웠다)", after?.discovered === false, JSON.stringify(after));
  }

  // ── R4 남의 주인 ──
  {
    const id = S(4);
    await st.upsertSessionState(row0(id));
    await st.markSessionExited(id, A, "logout");
    const r = await st.reviveSessionState(id, B);
    const after = await st.getSessionState(id);
    chk("R4 남의 주인으로는 안 바뀐다", r === false && after?.exited_at !== null, JSON.stringify({ r, exited: after?.exited_at }));
  }

  // ── R5 이어진(은퇴) 행 ──
  {
    const id = S(5);
    await st.upsertSessionState(row0(id));
    await st.markSessionExited(id, A, "logout");
    await st.markSessionSuperseded(id, S(6));
    const r = await st.reviveSessionState(id, A);
    const after = await st.getSessionState(id);
    chk("R5 이어진 행은 안 바뀐다(이음이 먼저 안내한다)", r === false && after?.exited_at !== null && after?.superseded_by === S(6),
      JSON.stringify({ r, after }));
  }

  // ── R6 행 없음 ──
  {
    let threw = null;
    let r;
    try { r = await st.reviveSessionState(S(9), A); } catch (e) { threw = e; }
    chk("R6 행이 없으면 false · 오류 없음", !threw && r === false, String(threw || r));
  }

  // ── R7 장부(브로커가 받는 행) ──
  {
    const rows = await st.listSessionLedgerRows();
    const r1 = rows.find((x) => x.id === S(1));
    const r4 = rows.find((x) => x.id === S(4));
    chk("R7 정리한 행은 장부에서 종료 표식이 없다(브로커가 «원한다» 로 읽는다) · 안 바뀐 행은 그대로",
      !!r1 && r1.exited_at === null && r1.superseded_by === null && !!r4 && r4.exited_at !== null, JSON.stringify({ r1, r4 }));
  }

  // ── I1 인스턴스 없음 → 세운다 ──
  {
    await reviveSessionInstance(S(1), A, { appId: null, projectId: null, title: "되살릴 세션" });
    const r = await instRow(A, S(1));
    chk("I1 인스턴스가 없으면 세운다(목록에 선다)", r.length === 1 && r[0].status === "active", JSON.stringify(r));
  }

  // ── I2 시스템이 닫음 → 다시 연다 ──
  {
    await inst.createAppInstance({ appId: "ai-session", owner: A, projectId: null, subjectKind: "session", subjectRef: S(2) });
    await inst.closeSessionAppInstances(S(2), "restore");
    await reviveSessionInstance(S(2), A, { appId: null, projectId: null, title: null });
    const r = await instRow(A, S(2));
    chk("I2 시스템이 닫은 인스턴스는 다시 연다(세션이 다시 산다)", r.length === 1 && r[0].status === "active", JSON.stringify(r));
  }

  // ── I3 목록에 있음 → 그대로(화면 상태 보존) ──
  {
    await inst.createAppInstance({ appId: "ai-session", owner: A, projectId: null, subjectKind: "session", subjectRef: S(3), state: { pane: "files" } });
    await reviveSessionInstance(S(3), A, { appId: null, projectId: null, title: null });
    const r = await instRow(A, S(3));
    chk("I3 목록에 있는 인스턴스는 그대로 — 화면 상태를 비우지 않는다",
      r.length === 1 && r[0].status === "active" && r[0].state && r[0].state.pane === "files", JSON.stringify(r));
  }

  // ── I4 사람이 치움 → 그대로 ──
  {
    await inst.createAppInstance({ appId: "ai-session", owner: A, projectId: null, subjectKind: "session", subjectRef: S(4) });
    await inst.dismissSessionInstances(A, [S(4)]);
    await reviveSessionInstance(S(4), A, { appId: null, projectId: null, title: null });
    const r = await instRow(A, S(4));
    chk("I4 사람이 치운 세션은 되살려도 치운 채로 남는다(보임 축은 사람만 바꾼다 #3857)",
      r.length === 1 && r[0].status === "closed" && r[0].closed_reason === "user", JSON.stringify(r));
  }

  // ── I5 다른 사람의 인스턴스 ──
  {
    await inst.createAppInstance({ appId: "ai-session", owner: B, projectId: null, subjectKind: "session", subjectRef: S(5) });
    await inst.dismissSessionInstances(B, [S(5)]);
    await reviveSessionInstance(S(5), A, { appId: null, projectId: null, title: null });
    const rb = await instRow(B, S(5));
    const ra = await instRow(A, S(5));
    chk("I5 다른 사람의 인스턴스(치움)는 손대지 않는다 · 주인 것만 세운다",
      rb.length === 1 && rb[0].status === "closed" && rb[0].closed_reason === "user" && ra.length === 1 && ra[0].status === "active",
      JSON.stringify({ rb, ra }));
  }
} catch (e) {
  bad("예외", e && e.stack ? e.stack : String(e));
} finally {
  await cleanup().catch((e) => console.error("정리 실패:", e));
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);
