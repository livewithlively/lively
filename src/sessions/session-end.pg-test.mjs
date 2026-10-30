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
  created: 10_000, last_busy: null, label_source: "human", kind: "human", end_mark: true, ...over,
});
const note = async (id) => (await itemsPool.query("SELECT end_note FROM org_session_state WHERE id=$1", [id])).rows[0]?.end_note ?? null;

async function cleanup() {
  const ids = Array.from({ length: 30 }, (_, i) => S(i));
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

  // ── P8 끝을 보고하지 않는 판(셸·grok·opencode·대화 런타임)은 표식이 없다 — 사유 없이 사라져도 고장으로 확인할 근거가 아니다 ──
  {
    const id = S(11);
    await st.upsertSessionState(row0(id, { end_mark: false }));
    chk("P8a 표식 없는 판은 end_note 가 비어 있다", (await note(id)) === null, JSON.stringify(await note(id)));
    await st.markSessionEnded(id, { why: "stop", by: A }, {}, 70_000);
    await st.upsertSessionState(row0(id, { end_mark: false, created: 80_000 }));
    chk("P8b 같은 id 다시 쓰기 — 지난 사유를 지우고 표식도 없다", (await note(id)) === null, JSON.stringify(await note(id)));
    await st.upsertSessionState(row0(id, { end_mark: true, created: 90_000 }));
    chk("P8c 보고 런처로 다시 뜨면 표식이 선다", JSON.stringify(await note(id)) === JSON.stringify({ v: 1 }), JSON.stringify(await note(id)));
  }

  // ── P9 임시 사유(기동 실패 뒤 셸이 남은 판) — 그 뒤 작업이 있었으면 시스템 끄기가 덮고, 없으면 기동 실패가 끝으로 남는다 · 사람의 멈춤은 언제나 덮는다 ──
  {
    const keep = S(12), redo = S(13), stopped = S(14), real = S(15);
    for (const id of [keep, redo, stopped, real]) await st.upsertSessionState(row0(id));
    for (const id of [keep, redo, stopped]) await st.markSessionEnded(id, { why: "launch_fail", code: 1, prov: true }, { owner: A, t0: 10_001 }, 10_050);
    await st.markSessionEnded(real, { why: "harness_crash", code: 1 }, { owner: A, t0: 10_001 }, 10_050);
    await st.touchSessionBusy(redo, 10_500);   // 사람이 셸에서 하네스를 다시 띄워 일했다
    await st.touchSessionBusy(real, 10_500);
    const wk = await st.markSessionEnded(keep, { why: "reclaim" }, {}, 11_000);
    const wr = await st.markSessionEnded(redo, { why: "reclaim", seen: true }, {}, 11_000);
    const ws = await st.markSessionEnded(stopped, { why: "stop", by: A }, {}, 11_000);
    const wx = await st.markSessionEnded(real, { why: "reclaim" }, {}, 11_000);
    chk("P9a 다시 안 띄우고 꺼짐 → 기동 실패가 그 판의 끝", wk === false && (await note(keep))?.why === "launch_fail", JSON.stringify(await note(keep)));
    chk("P9b 다시 띄워 일한 뒤 꺼짐 → 시스템 끄기가 덮는다", wr === true && (await note(redo))?.why === "reclaim" && (await note(redo))?.prov === undefined, JSON.stringify(await note(redo)));
    chk("P9c 사람의 멈춤은 임시 사유를 언제나 덮는다", ws === true && (await note(stopped))?.why === "stop", JSON.stringify(await note(stopped)));
    chk("P9d 임시가 아닌 사유는 작업이 있었어도 안 덮인다(첫 사실)", wx === false && (await note(real))?.why === "harness_crash", JSON.stringify(await note(real)));
  }

  // ── P10 확인한 그 판에만(created) — 확인하는 사이 같은 id 로 되살아났으면 안 적는다 ──
  {
    const id = S(16);
    await st.upsertSessionState(row0(id, { created: 20_000 }));
    await st.upsertSessionState(row0(id, { created: 20_500 }));   // 되살아남(새 판)
    const wOld = await st.markSessionEnded(id, { why: "lost" }, { created: 20_000 }, 21_000);
    chk("P10a 옛 판(created 20000)의 확답 → 새 판엔 안 적힌다", wOld === false && !(await note(id))?.why, JSON.stringify(await note(id)));
    const wNew = await st.markSessionEnded(id, { why: "lost" }, { created: 20_500 }, 21_000);
    chk("P10b 그 판(created 20500)이면 적힌다", wNew === true && (await note(id))?.why === "lost", JSON.stringify(await note(id)));
  }

  // ── P11 끄기가 실패하면 방금 적은 사유를 되돌린다(내가 적은 그대로일 때만) ──
  {
    const id = S(17), other = S(18);
    await st.upsertSessionState(row0(id)); await st.upsertSessionState(row0(other));
    await st.markSessionEnded(id, { why: "reclaim" }, {}, 30_000);
    await st.markSessionEnded(other, { why: "reclaim" }, {}, 30_000);
    const r1 = await st.revertSessionEnded(id, "reclaim", 30_000);
    const r2 = await st.revertSessionEnded(other, "reclaim", 30_001);
    chk("P11a 같은 사유·같은 시각 → 표식만 남긴다", r1 === true && JSON.stringify(await note(id)) === JSON.stringify({ v: 1 }), JSON.stringify(await note(id)));
    chk("P11b 시각이 다르면(남이 적은 것) 안 건드린다", r2 === false && (await note(other))?.why === "reclaim", JSON.stringify(await note(other)));
  }

  // ── P12 같은 id 되살리기가 실패하면 지난 판의 사유를 되돌린다 — 새 판이 무언가 적었으면 안 건드린다 ──
  {
    const id = S(19), id2 = S(20);
    for (const x of [id, id2]) { await st.upsertSessionState(row0(x)); await st.markSessionEnded(x, { why: "stop", by: A }, {}, 40_000); }
    const prev = (await st.getSessionState(id)).end_note;
    const prev2 = (await st.getSessionState(id2)).end_note;
    await st.upsertSessionState(row0(id, { created: 41_000 }));
    await st.upsertSessionState(row0(id2, { created: 41_000 }));
    await st.markSessionEnded(id2, { why: "harness_crash", code: 1 }, {}, 41_100);   // 새 판이 이미 끝을 적었다
    const r1 = await st.restoreSessionEndNote(id, prev);
    const r2 = await st.restoreSessionEndNote(id2, prev2);
    chk("P12a 되살리기 실패 → 지난 판의 «사람이 멈춤» 이 돌아온다", r1 === true && (await note(id))?.why === "stop" && (await note(id))?.at === 40_000, JSON.stringify(await note(id)));
    chk("P12b 새 판이 적은 사유는 안 덮는다", r2 === false && (await note(id2))?.why === "harness_crash", JSON.stringify(await note(id2)));
    const id3 = S(21);
    await st.upsertSessionState(row0(id3, { end_mark: false }));
    await st.upsertSessionState(row0(id3, { created: 42_000 }));
    const r3 = await st.restoreSessionEndNote(id3, null);
    chk("P12c 지난 판에 사유가 없었으면(null) 그대로 비운다", r3 === true && (await note(id3)) === null, JSON.stringify(await note(id3)));
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
