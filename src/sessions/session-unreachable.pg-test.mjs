// 도달 불가 판정(#4939 재설계 v2)의 DB 쪽 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서(스키마 마이그레이션 뒤), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=<테스트 DB> node src/sessions/session-unreachable.pg-test.mjs
//
// 왜 이 계층인가: «사람이 끝낸 표식은 안 덮는다» · «이어진 행은 안 적는다» · «안 보이기 시작한 뒤 살아 있다는 기록(생성·복원·작업)을 받은 행은
//  안 적는다(복원 경합)» · «되살림은 이 규칙이 적은 것만» 이 **전부 UPDATE 의 WHERE** 다. 목 풀로는 조건 하나를 지워도 초록이다 —
//  부작용을 SELECT 로 되읽어 판정한다. 화면 쪽(복원 가능 목록 행이 «사람이 끝냄» 으로 안 그려지나)도 실제 행으로 잰다.
//  ⚠ 실 테이블을 쓴다 — 이 시험 전용 id·주인만 쓰고 끝에 지운다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/sessions/session-state.js`);
const { listRestorableSessions } = await import(`${DIST}/terminal/sessions.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__unreach_pg_a__";
const S = (x) => `box-__pgtest-unreach-${x}`;
const row0 = (id, over = {}) => ({
  id, owner: A, label: "도달 불가 시험", harness: "claude", dir: "/work/personal/__unreach_pg_a__", root_key: "personal", subpath: "",
  flags: {}, auto_approve: false, invites: [], project_id: null, project_src: null, read_only: false, incognito: false,
  created: 10_000, last_busy: null, label_source: "human", kind: "human", end_mark: true, ...over,
});
const get = async (id) => (await itemsPool.query("SELECT exited_at, exit_reason, superseded_by FROM org_session_state WHERE id=$1", [id])).rows[0];
//  안 보이기 시작한 시각 — 행의 last_seen(upsert 가 now() 로 찍는다)보다 뒤(= 그 뒤로 살아 있다는 기록이 없다) · 앞(= 그 뒤에 기록을 받았다).
const AFTER = () => Date.now() + 10 * 60_000;
const BEFORE = () => Date.now() - 10 * 60_000;

async function cleanup() {
  const ids = Array.from({ length: 16 }, (_, i) => S(i));
  await itemsPool.query(`DELETE FROM org_session_state WHERE id = ANY($1::text[])`, [ids]);
}

try {
  await cleanup();

  // ── U1 원하는 행 · 그 뒤 기록 없음 → 적는다 ──
  {
    const id = S(1);
    await st.upsertSessionState(row0(id));
    const w = await st.markSessionUnreachable(id, AFTER());
    const r = await get(id);
    chk("U1 끝남으로 적는다(exited_at · exit_reason=unreachable)", w === true && !!r?.exited_at && r?.exit_reason === "unreachable", JSON.stringify({ w, r }));
    const again = await st.markSessionUnreachable(id, AFTER());
    chk("U1b 이미 적힌 행은 다시 안 적는다(첫 시각 유지)", again === false, String(again));
  }

  // ── U2 사람이 끝낸 행(사유 있음)은 덮지 않는다 ──
  {
    const id = S(2);
    await st.upsertSessionState(row0(id));
    await st.markSessionExited(id, A, "prompt_input_exit");
    const w = await st.markSessionUnreachable(id, AFTER());
    const r = await get(id);
    chk("U2 사람 종료 사유를 안 덮는다", w === false && r?.exit_reason === "prompt_input_exit", JSON.stringify({ w, r }));
    const rv = await st.reviveUnreachableSession(id);
    chk("U2b 되살림은 사람 종료 표식을 안 지운다", rv === false && !!(await get(id))?.exited_at, String(rv));
  }

  // ── U3 이어진 행은 안 적는다 ──
  {
    const id = S(3);
    await st.upsertSessionState(row0(id));
    await st.markSessionSuperseded(id, S(4));
    const w = await st.markSessionUnreachable(id, AFTER());
    chk("U3 이어진 행(superseded)은 안 적는다", w === false && !(await get(id))?.exited_at, String(w));
  }

  // ── U4 ★ 안 보이기 시작한 뒤 살아 있다는 기록을 받은 행은 안 적는다 — 복원(upsert) · 작업 표시(touchSessionBusy) ──
  {
    const id = S(5);
    await st.upsertSessionState(row0(id));
    const w = await st.markSessionUnreachable(id, BEFORE());
    chk("U4 그 뒤 생성·복원 기록(last_seen)이 있으면 안 적는다(복원 경합)", w === false && !(await get(id))?.exited_at, String(w));
    const id2 = S(6);
    await st.upsertSessionState(row0(id2));
    await itemsPool.query("UPDATE org_session_state SET last_seen = now() - interval '2 hours' WHERE id=$1", [id2]);
    await st.touchSessionBusy(id2, Math.floor(Date.now() / 1000));
    const w2 = await st.markSessionUnreachable(id2, Date.now() - 60 * 60_000);
    chk("U4b 그 뒤 작업 표시(touchSessionBusy)가 있으면 안 적는다", w2 === false, String(w2));
    await itemsPool.query("UPDATE org_session_state SET last_seen = now() - interval '2 hours' WHERE id=$1", [id2]);
    chk("U4c 마지막 기록이 안 보이기 시작한 시각보다 앞이면 적는다(경계의 반대편)", (await st.markSessionUnreachable(id2, Date.now() - 60 * 60_000)) === true);
  }

  // ── U5 되살림 — 이 규칙이 적은 것만 지운다 ──
  {
    const id = S(7);
    await st.upsertSessionState(row0(id));
    await st.markSessionUnreachable(id, AFTER());
    const rv = await st.reviveUnreachableSession(id);
    const r = await get(id);
    chk("U5 도달 불가 표식을 지운다", rv === true && r?.exited_at === null && r?.exit_reason === null, JSON.stringify({ rv, r }));
  }

  // ── U6 판정 재료 · 장부 행 — 사유와 마지막 작업이 실린다 ──
  {
    const id = S(8);
    await st.upsertSessionState(row0(id, { last_busy: 12_345 }));
    await st.markSessionUnreachable(id, AFTER());
    const rr = (await st.listUnreachableRuleRows()).find((x) => x.id === id);
    chk("U6 판정 재료(last_busy 숫자 · 사유)", rr?.last_busy === 12_345 && rr?.exit_reason === "unreachable" && !!rr?.exited_at, JSON.stringify(rr));
    const all = await st.listUnreachableRuleRows();
    chk("U6c 판정 밖 행(이어진 행 · 사람이 끝낸 행)은 안 읽는다", !all.some((x) => x.id === S(3) || x.id === S(2)), JSON.stringify(all.filter((x) => x.id === S(3) || x.id === S(2))));
    const lr = (await st.listSessionLedgerRows()).find((x) => x.id === id);
    chk("U6b 장부 행에 사유가 실린다(브로커가 판정 시각을 읽는다)", lr?.exit_reason === "unreachable" && !!lr?.exited_at, JSON.stringify(lr));
  }

  // ── U8 ★ OOM 사유가 적힌 행(exited_at 없음 · exit_reason=oom)은 «도달 불가» 로 덮지 않는다 ──
  {
    const id = S(11);
    await st.upsertSessionState(row0(id));
    await st.markSessionOomKilled(id);
    const w = await st.markSessionUnreachable(id, AFTER());
    const r = await get(id);
    chk("U8 OOM 표식을 덮지 않는다", w === false && r?.exit_reason === "oom" && r?.exited_at === null, JSON.stringify({ w, r }));
    const rr = (await st.listUnreachableRuleRows()).find((x) => x.id === id);
    chk("U8b OOM 행은 판정 재료(원하는 행)로 안 읽는다", rr === undefined, JSON.stringify(rr));
  }

  // ── U9 되살림 창 — 오래전에 적은 표식은 30초마다 읽지 않는다 · 호스트가 «안 보임» 으로 보고한 sid 의 행은 상태 무관 읽는다 ──
  {
    const old = S(12), ex = S(13);
    await st.upsertSessionState(row0(old));
    await st.markSessionUnreachable(old, AFTER());
    await itemsPool.query("UPDATE org_session_state SET exited_at = now() - interval '2 days' WHERE id=$1", [old]);
    const plain = await st.listUnreachableRuleRows();
    chk("U9 되살림 창(1일)을 넘긴 표식은 안 읽는다", !plain.some((x) => x.id === old), JSON.stringify(plain.filter((x) => x.id === old)));
    await st.upsertSessionState(row0(ex));
    await st.markSessionExited(ex, A, "prompt_input_exit");
    const asked = await st.listUnreachableRuleRows([old, ex]);
    chk("U9b «안 보임» sid 의 행은 상태 무관 읽는다(행이 있는지가 «행 없는 세션» 판정의 근거)",
      asked.some((x) => x.id === old) && asked.find((x) => x.id === ex)?.exit_reason === "prompt_input_exit", JSON.stringify(asked.filter((x) => x.id === old || x.id === ex)));
  }

  // ── U7 화면 — 도달 불가로 적힌 세션은 «사람이 끝냄» 이 아니라 «중단됨(복원 가능)» ──
  {
    const id = S(9), ex = S(10);
    await st.upsertSessionState(row0(id));
    await st.markSessionUnreachable(id, AFTER());
    await st.upsertSessionState(row0(ex));
    await st.markSessionExited(ex, A, "prompt_input_exit");
    const rows = await listRestorableSessions({ userId: A, scopes: [] }, new Set());
    const u = rows.find((x) => x.id === id), e = rows.find((x) => x.id === ex);
    chk("U7 도달 불가 → exitedByUser false · 복원 가능", u?.exitedByUser === false && u?.restorable === true, JSON.stringify({ exitedByUser: u?.exitedByUser, restorable: u?.restorable }));
    chk("U7b 사람 종료 → exitedByUser true(종전 그대로)", e?.exitedByUser === true, JSON.stringify({ exitedByUser: e?.exitedByUser }));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  try { await cleanup(); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
  await itemsPool.end().catch(() => {});
  console.log(`\n${pass} ok · ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
