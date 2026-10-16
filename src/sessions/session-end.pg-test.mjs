// 이 판이 왜 끝났나(#4783)의 DB 쪽 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서(스키마 마이그레이션 뒤), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=<테스트 DB> node src/sessions/session-end.pg-test.mjs
//
// 왜 이 계층인가: «그 판의 첫 사실이 이긴다» · «남의 세션 보고는 안 받는다» · «옛 판의 보고는 버린다» · «판이 새로 서면 지운다» 가
//  **전부 SQL 조건**이다(UPDATE 의 WHERE · upsert 의 ON CONFLICT). 목 풀로는 조건 하나를 지워도 초록이다 — 부작용을 SELECT 로 되읽어 판정한다.
//  사양·엣지 표: 스크래치패드 spec.md 표 B.
//  ⚠ 실 테이블을 쓴다 — 이 시험 전용 id·주인만 쓰고 끝에 지운다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/sessions/session-state.js`);
const { listRestorableSessions } = await import(`${DIST}/terminal/sessions.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__end_pg_a__", B = "__end_pg_b__";
const S = (x) => `box-__pgtest-end-${x}`;
const row0 = (id, over = {}) => ({
  id, owner: A, label: "끝난 사유 시험", harness: "claude", dir: "/work/personal/__end_pg_a__", root_key: "personal", subpath: "",
  flags: {}, auto_approve: false, invites: [], project_id: null, project_src: null, read_only: false, incognito: false,
  created: 10_000, last_busy: null, label_source: "human", kind: "human", ...over,
});
const note = async (id) => (await itemsPool.query("SELECT end_note FROM org_session_state WHERE id=$1", [id])).rows[0]?.end_note ?? null;

async function cleanup() {
  const ids = Array.from({ length: 12 }, (_, i) => S(i));
  await itemsPool.query(`DELETE FROM org_session_state WHERE id = ANY($1::text[])`, [ids]);
}

try {
  await cleanup();

  // ── P1 판 시작 표식 · 첫 사실이 이긴다 ──
  {
    const id = S(1);
    await st.upsertSessionState(row0(id));
    chk("P1a 판이 서면 {v:1} 만 있다(사유 없음)", JSON.stringify(await note(id)) === JSON.stringify({ v: 1 }), JSON.stringify(await note(id)));
    const w1 = await st.markSessionEnded(id, { why: "reclaim", seen: false }, {}, 20_000);
    const w2 = await st.markSessionEnded(id, { why: "harness_exit", code: 0 }, {}, 20_001);
    const n = await note(id);
    chk("P1b 첫 사유(reclaim)가 적힌다", w1 === true, String(w1));
    chk("P1c 뒤늦은 사유(런처의 종료코드)는 아무것도 안 바꾼다", w2 === false && n?.why === "reclaim" && n?.seen === false && n?.at === 20_000, JSON.stringify({ w2, n }));
    const parsed = await st.getSessionState(id);
    chk("P1d 행을 읽으면 end_note 가 그대로 읽힌다", parsed?.end_note?.why === "reclaim" && parsed?.end_note?.v === 1, JSON.stringify(parsed?.end_note));
  }

  // ── P2 판이 새로 서면(같은 id 다시 쓰기) 지난 사유가 지워지고 다시 적을 수 있다 ──
  {
    const id = S(2);
    await st.upsertSessionState(row0(id));
    await st.markSessionEnded(id, { why: "stop", by: A }, {}, 20_000);
    await st.upsertSessionState(row0(id, { created: 30_000 }));
    chk("P2a 같은 id 다시 쓰기 → 표식만 남는다", JSON.stringify(await note(id)) === JSON.stringify({ v: 1 }), JSON.stringify(await note(id)));
    const w = await st.markSessionEnded(id, { why: "harness_crash", code: 1 }, { owner: A, t0: 30_005 }, 30_100);
    const n = await note(id);
    chk("P2b 새 판의 첫 사유가 적힌다", w === true && n?.why === "harness_crash" && n?.code === 1, JSON.stringify({ w, n }));
  }

  // ── P3 그 세션 자격으로 온 보고는 주인 행만 고친다 ──
  {
    const id = S(3);
    await st.upsertSessionState(row0(id));
    const wb = await st.markSessionEnded(id, { why: "harness_exit", code: 0 }, { owner: B, t0: 10_010 }, 10_100);
    chk("P3a 남의 세션 보고 → 안 바뀐다", wb === false && JSON.stringify(await note(id)) === JSON.stringify({ v: 1 }), JSON.stringify({ wb, n: await note(id) }));
    const wa = await st.markSessionEnded(id, { why: "harness_exit", code: 0 }, { owner: A, t0: 10_010 }, 10_100);
    chk("P3b 주인의 보고 → 적힌다", wa === true && (await note(id))?.why === "harness_exit", JSON.stringify(await note(id)));
  }

  // ── P4 그 판보다 먼저 뜬 하네스의 보고는 버린다(시계 여유 60초 — 경계 포함) ──
  {
    const early = S(4), edge = S(5);
    await st.upsertSessionState(row0(early, { created: 10_000 }));
    await st.upsertSessionState(row0(edge, { created: 10_000 }));
    const we = await st.markSessionEnded(early, { why: "harness_crash", code: 143 }, { owner: A, t0: 10_000 - 61 }, 10_100);
    const wd = await st.markSessionEnded(edge, { why: "harness_crash", code: 143 }, { owner: A, t0: 10_000 - 60 }, 10_100);
    chk("P4a 판 시작 − 61초에 뜬 하네스(옛 판)의 보고 → 버린다", we === false && !(await note(early))?.why, JSON.stringify(await note(early)));
    chk("P4b 판 시작 − 60초(경계) → 이 판의 보고로 받는다", wd === true && (await note(edge))?.why === "harness_crash", JSON.stringify(await note(edge)));
  }

  // ── P5 옛 판(표식 없음)에도 사유를 아는 자리는 적는다 ──
  {
    const id = S(6);
    await st.upsertSessionState(row0(id));
    await itemsPool.query("UPDATE org_session_state SET end_note=NULL WHERE id=$1", [id]);
    const w = await st.markSessionEnded(id, { why: "reclaim", seen: true }, {}, 40_000);
    const n = await note(id);
    chk("P5 옛 판 → 적힌다(판 표식과 함께)", w === true && n?.v === 1 && n?.why === "reclaim" && n?.seen === true, JSON.stringify({ w, n }));
  }

  // ── P6 열어 보면 «안 본 결과» 표시가 걷힌다 — 그 표시가 없는 행은 안 건드린다 ──
  {
    const unseen = S(7), noFlag = S(8), noWhy = S(9);
    await st.upsertSessionState(row0(unseen)); await st.markSessionEnded(unseen, { why: "reclaim", seen: false }, {}, 50_000);
    await st.upsertSessionState(row0(noFlag)); await st.markSessionEnded(noFlag, { why: "reclaim" }, {}, 50_000);
    await st.upsertSessionState(row0(noWhy));
    const r1 = await st.markSessionEndSeen(unseen);
    const r1b = await st.markSessionEndSeen(unseen);
    const r2 = await st.markSessionEndSeen(noFlag);
    const r3 = await st.markSessionEndSeen(noWhy);
    const n1 = await note(unseen);
    chk("P6a seen=false → true · 나머지 칸은 그대로", r1 === true && n1?.seen === true && n1?.why === "reclaim" && n1?.at === 50_000, JSON.stringify({ r1, n1 }));
    chk("P6b 두 번째 열람은 아무것도 안 바꾼다(멱등)", r1b === false, String(r1b));
    chk("P6c seen 칸이 없는 행 · 사유 없는 행은 안 건드린다", r2 === false && r3 === false && (await note(noFlag))?.seen === undefined && JSON.stringify(await note(noWhy)) === JSON.stringify({ v: 1 }), JSON.stringify({ r2, r3 }));
  }

  // ── P7 복원 가능 목록 행이 끝난 사유를 싣는다(멈춘 사람은 안 싣는다) ──
  {
    const id = S(10);
    await st.upsertSessionState(row0(id));
    await st.markSessionEnded(id, { why: "stop", by: A }, {}, 60_000);
    const rows = await listRestorableSessions({ userId: A, scopes: [] }, new Set());
    const r = rows.find((x) => x.id === id);
    chk("P7 목록 행 endNote = {why, at}(by 없음)", JSON.stringify(r?.endNote) === JSON.stringify({ why: "stop", at: 60_000 }), JSON.stringify(r?.endNote));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  try { await cleanup(); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
  await itemsPool.end().catch(() => {});
  console.log(`\n${pass} ok · ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
