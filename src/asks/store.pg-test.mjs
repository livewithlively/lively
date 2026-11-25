// 세션 요청 저장소(#5713 — src/asks/store.ts) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖 · CI 의 pg 잡이 자동 수집).
//  로컬 수동 실행: npm run build && ITEMS_DATABASE_URL=… node src/asks/store.pg-test.mjs
//
// 왜 이 계층인가: 이 저장소의 약속은 전부 SQL 조건에 있다 — «요청은 건 사람 것»(모든 문장의 member_id) · «열려 있을 때만 닫힌다»
//  (두 탭이 동시에 답해도 하나만 이긴다) · «같은 것을 다시 물으면 앞 것을 내린다»(세션 · 종류 · slot 이 다 같을 때만) ·
//  «한 마디는 한 번만 넣는다»(told 잡기). 목 풀로는 조건 하나를 지워도 초록이다. 그래서 **부작용을 SELECT 로 되읽어** 판정한다.
//
// 사양 엣지표(행마다 시나리오 하나 이상):
//  | #   | 상태                                                   | 기대                                                    |
//  |-----|--------------------------------------------------------|---------------------------------------------------------|
//  | P1  | 걸고 본인이 읽는다                                       | open · payload 그대로 · id 는 주소에 실을 수 있는 모양      |
//  | P2  | **남의** id 로 읽기 · 닫기 · told 잡기 · 놓기              | null · null · false — 행은 한 글자도 안 바뀐다             |
//  | P3  | 같은 세션 · 종류 · slot 으로 다시 건다                     | 앞 것은 canceled(result.replaced) · 새 것만 open           |
//  | P4  | slot 은 같고 세션이 다르다 / 세션이 없다(null) / 종류가 다르다 / 사람이 다르다 | 서로 내리지 않는다                       |
//  | P5  | 닫힌 요청을 또 닫는다(두 탭)                               | 처음만 행을 돌려준다 · 두 번째는 null · 상태 · 결과 불변     |
//  | P6  | 열린 목록 — 전부 / 그 세션 / 세션 없이 건 것(null)          | 범위대로 · 건 순서 · 끝난 것은 없다                        |
//  | P7  | 그 세션의 그 종류만 내린다 / 종류 생략                      | 그 종류만 · 생략이면 그 세션의 열린 것 전부(다른 세션은 그대로) |
//  | P8  | told 잡기 — 열린 요청 / 끝난 요청 처음 / 두 번째 / 놓은 뒤   | false / true / false / true · result 의 다른 값은 남는다    |
//  | P9  | 새 id 로 복원된 세션에 넘기기 — 열린 것 / 끝난 것 / 같은 id   | 열린 것만 옮긴다 · 끝난 것은 옛 id 에 · 같은 id 면 0        |
//  | P10 | 최근 목록 — 상한 · 순서                                   | 최신 먼저 · limit 만큼 · 상태 무관                         |
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/asks/store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__ask_pg_a__", B = "__ask_pg_b__";
const S = (x) => `box-__pgtest-ask-${x}`;
const raw = async (id) => (await itemsPool.query(`SELECT member_id, session_id, kind, slot, status, result FROM org_session_ask WHERE id=$1`, [id])).rows[0] ?? null;
const J = (v) => JSON.stringify(v);
const open = (member, session, kind, slot, payload = {}) => st.createAsk({ member, session, kind, slot, payload });
const cleanup = () => itemsPool.query(`DELETE FROM org_session_ask WHERE member_id = ANY($1::text[])`, [[A, B]]);

try {
  await cleanup();

  // ── P1 ──
  {
    const { ask, replaced } = await open(A, S(1), "secret", "vault:x@", { label: "토큰", why: "왜" });
    const got = await st.getAsk(A, ask.id);
    chk("P1 걸면 열린 요청이 생기고 본인이 읽는다(payload 그대로)", !!got && got.status === "open" && got.session_id === S(1) && got.kind === "secret"
      && got.payload.label === "토큰" && got.payload.why === "왜" && Object.keys(got.payload).length === 2 && got.result === null && got.resolved_at === null && replaced.length === 0, J({ got, replaced }));
    chk("P1 id 는 주소에 그대로 실을 수 있는 모양이고 매번 다르다", /^ask_[A-Za-z0-9_-]{16}$/.test(ask.id) && st.newAskId() !== st.newAskId(), ask.id);
  }

  // ── P2 남의 요청 ──
  {
    const { ask } = await open(A, S(2), "choice", "key:k2", { question: "Q" });
    const before = J(await raw(ask.id));
    const read = await st.getAsk(B, ask.id);
    const closed = await st.resolveAsk(B, ask.id, "done", { stolen: true });
    const dismissed = await st.resolveAsk(B, ask.id, "dismissed", null);
    chk("P2 ★ 남의 요청은 id 를 알아도 못 읽고 못 닫는다 — 행이 그대로다", read === null && closed === null && dismissed === null && J(await raw(ask.id)) === before,
      J({ read, closed, dismissed, row: await raw(ask.id) }));
    await st.resolveAsk(A, ask.id, "done", { say: "한 마디" });
    const afterDone = J(await raw(ask.id));
    const claimed = await st.claimAskTold(B, ask.id);
    await st.releaseAskTold(B, ask.id);
    chk("P2 ★ 남의 요청의 «전했다» 를 잡지도 놓지도 못한다", claimed === false && J(await raw(ask.id)) === afterDone, J({ claimed, row: await raw(ask.id) }));
    const mineOpen = (await st.listOpenAsks(B)).map((r) => r.id);
    const mineRecent = (await st.listRecentAsks(B, S(2))).map((r) => r.id);
    const canceled = await st.cancelOpenAsks(B, S(2));
    chk("P2 남의 세션 id 를 대도 목록 · 내리기에 그 사람의 요청이 안 걸린다", mineOpen.length === 0 && mineRecent.length === 0 && canceled.length === 0, J({ mineOpen, mineRecent, canceled }));
  }

  // ── P3 같은 것을 다시 건다 ──
  {
    const first = await open(A, S(3), "choice", "key:k3", { question: "처음" });
    const second = await open(A, S(3), "choice", "key:k3", { question: "다시" });
    const r1 = await raw(first.ask.id), r2 = await raw(second.ask.id);
    chk("P3 같은 세션 · 종류 · slot 으로 다시 걸면 앞 것은 내려가고(replaced) 새 것만 열려 있다",
      J(second.replaced) === J([first.ask.id]) && r1.status === "canceled" && r1.result?.replaced === true && r2.status === "open"
      && J((await st.listOpenAsks(A, S(3))).map((r) => r.id)) === J([second.ask.id]), J({ replaced: second.replaced, r1, r2 }));
  }

  // ── P4 slot 만 같다 ──
  {
    const base = await open(A, S(4), "choice", "key:k4");
    const otherSession = await open(A, S("4b"), "choice", "key:k4");
    const noSession = await open(A, null, "choice", "key:k4");
    const noSession2 = await open(A, null, "choice", "key:k4-other");
    const otherKind = await open(A, S(4), "upload", "key:k4");
    const otherMember = await open(B, S(4), "choice", "key:k4");
    const all = [base, otherSession, noSession, noSession2, otherKind, otherMember];
    const statuses = await Promise.all(all.map(async (x) => (await raw(x.ask.id)).status));
    chk("P4 slot 이 같아도 세션 · 종류 · 사람이 다르면 서로 내리지 않는다(세션 없는 요청도 제 묶음끼리만)",
      all.every((x) => x.replaced.length === 0) && statuses.every((s) => s === "open"), J({ replaced: all.map((x) => x.replaced), statuses }));
    const again = await open(A, null, "choice", "key:k4");
    chk("P4 세션 없이 건 같은 slot 은 세션 없는 것끼리 갈린다(NULL 끼리 같은 것으로 본다)",
      J(again.replaced) === J([noSession.ask.id]) && (await raw(base.ask.id)).status === "open" && (await raw(noSession2.ask.id)).status === "open", J(again.replaced));
  }

  // ── P5 두 번 닫기 ──
  {
    const { ask } = await open(A, S(5), "secret", "s5");
    const a = await st.resolveAsk(A, ask.id, "done", { saved: true });
    const b = await st.resolveAsk(A, ask.id, "dismissed", { dismissed: true });
    const c = await st.resolveAsk(A, ask.id, "done", { saved: false });
    const row = await raw(ask.id);
    chk("P5 ★ 열려 있을 때만 닫힌다 — 두 번째(다른 탭)는 null 이고 처음의 상태 · 결과가 남는다",
      !!a && a.status === "done" && !!a.resolved_at && b === null && c === null && row.status === "done" && J(row.result) === J({ saved: true }), J({ a, b, c, row }));
  }

  // ── P6 열린 목록의 범위 ──
  {
    await cleanup();
    const s1a = await open(A, S(6), "choice", "a");
    const s1b = await open(A, S(6), "upload", "b");
    const s2 = await open(A, S("6b"), "choice", "a");
    const none = await open(A, null, "choice", "a");
    const done = await open(A, S(6), "secret", "c");
    await st.resolveAsk(A, done.ask.id, "done", {});
    await open(B, S(6), "choice", "a");
    const ids = (rows) => rows.map((r) => r.id);
    const all = ids(await st.listOpenAsks(A)), one = ids(await st.listOpenAsks(A, S(6))), nul = ids(await st.listOpenAsks(A, null));
    chk("P6 열린 목록 — 전부 / 그 세션 것 / 세션 없이 건 것, 건 순서대로, 끝난 것 · 남의 것은 없다",
      J(all) === J([s1a.ask.id, s1b.ask.id, s2.ask.id, none.ask.id]) && J(one) === J([s1a.ask.id, s1b.ask.id]) && J(nul) === J([none.ask.id]), J({ all, one, nul }));
  }

  // ── P7 내리기의 범위 ──
  {
    await cleanup();
    const c1 = await open(A, S(7), "choice", "a");
    const u1 = await open(A, S(7), "upload", "b");
    const other = await open(A, S("7b"), "choice", "a");
    const nul = await open(A, null, "choice", "a");
    const gone = await st.cancelOpenAsks(A, S(7), "choice");
    const afterKind = await Promise.all([c1, u1, other, nul].map(async (x) => (await raw(x.ask.id)).status));
    chk("P7 그 세션의 그 종류만 내린다", J(gone) === J([c1.ask.id]) && J(afterKind) === J(["canceled", "open", "open", "open"]), J({ gone, afterKind }));
    const rest = await st.cancelOpenAsks(A, S(7));
    const afterAll = await Promise.all([u1, other, nul].map(async (x) => (await raw(x.ask.id)).status));
    chk("P7 종류를 안 주면 그 세션의 열린 것 전부 — 다른 세션 · 세션 없는 요청은 그대로", J(rest) === J([u1.ask.id]) && J(afterAll) === J(["canceled", "open", "open"]), J({ rest, afterAll }));
    const nulGone = await st.cancelOpenAsks(A, null);
    chk("P7 세션 없이 건 것은 세션 없는 것끼리만 내린다", J(nulGone) === J([nul.ask.id]) && (await raw(other.ask.id)).status === "open", J(nulGone));
  }

  // ── P8 «전했다» 는 한 번 ──
  {
    const { ask } = await open(A, S(8), "choice", "a");
    const whileOpen = await st.claimAskTold(A, ask.id);
    await st.resolveAsk(A, ask.id, "done", { say: "«Q» — A", choices: ["a"] });
    const first = await st.claimAskTold(A, ask.id);
    const second = await st.claimAskTold(A, ask.id);
    const held = (await raw(ask.id)).result;
    await st.releaseAskTold(A, ask.id);
    const freed = (await raw(ask.id)).result;
    const third = await st.claimAskTold(A, ask.id);
    chk("P8 ★ 열린 요청은 못 잡는다 · 끝난 요청은 처음 한 번만 잡힌다(두 탭이 동시에 불러도 한 번만 넣는다)", whileOpen === false && first === true && second === false, J({ whileOpen, first, second }));
    chk("P8 잡고 놓아도 결과의 다른 값(한 마디 · 고른 것)은 그대로다 · 놓으면 다시 잡힌다",
      held.told === true && held.say === "«Q» — A" && !("told" in freed) && freed.say === "«Q» — A" && J(freed.choices) === J(["a"]) && third === true, J({ held, freed, third }));
    const nullResult = await open(A, S(8), "secret", "nr");
    await itemsPool.query(`UPDATE org_session_ask SET status='done', result=NULL WHERE id=$1`, [nullResult.ask.id]);
    chk("P8 결과가 비어 있는(NULL) 끝난 요청도 잡힌다", (await st.claimAskTold(A, nullResult.ask.id)) === true && (await raw(nullResult.ask.id)).result?.told === true, J(await raw(nullResult.ask.id)));
  }

  // ── P9 복원된 세션으로 넘기기 ──
  {
    await cleanup();
    const o1 = await open(A, S("9old"), "choice", "a");
    const o2 = await open(B, S("9old"), "secret", "b");
    const fin = await open(A, S("9old"), "upload", "c");
    await st.resolveAsk(A, fin.ask.id, "done", {});
    const elsewhere = await open(A, S("9other"), "choice", "a");
    const same = await st.carrySessionAsks(S("9old"), S("9old"));
    const empty = await st.carrySessionAsks("", S("9new"));
    const moved = await st.carrySessionAsks(S("9old"), S("9new"));
    const where = await Promise.all([o1, o2, fin, elsewhere].map(async (x) => (await raw(x.ask.id)).session_id));
    chk("P9 열린 요청만 새 세션 id 로 옮긴다(같이 쓰던 사람 것도) — 끝난 것 · 다른 세션 것은 그대로 · 같은 id · 빈 id 면 0",
      same === 0 && empty === 0 && moved === 2 && J(where) === J([S("9new"), S("9new"), S("9old"), S("9other")]), J({ same, empty, moved, where }));
    chk("P9 옮긴 뒤 새 세션의 열린 목록에 선다 · 주소(id)는 그대로다", J((await st.listOpenAsks(A, S("9new"))).map((r) => r.id)) === J([o1.ask.id]) && (await st.getAsk(A, o1.ask.id))?.session_id === S("9new"));
  }

  // ── P10 최근 목록 ──
  {
    await cleanup();
    const made = [];
    for (let i = 0; i < 4; i++) made.push((await open(A, S(10), "choice", `k${i}`)).ask.id);
    await st.resolveAsk(A, made[1], "dismissed", { dismissed: true });
    const all = (await st.listRecentAsks(A, S(10))).map((r) => r.id);
    const two = await st.listRecentAsks(A, S(10), 2);
    chk("P10 최근 목록 — 최신 먼저 · 상태 무관 · limit 만큼", J(all) === J([...made].reverse()) && J(two.map((r) => r.id)) === J([made[3], made[2]])
      && (await st.listRecentAsks(A, S(10))).find((r) => r.id === made[1])?.status === "dismissed", J({ all, two: two.map((r) => r.id) }));
    chk("P10 limit 의 바닥은 1 이다(0 · 음수를 줘도 하나는 준다)", (await st.listRecentAsks(A, S(10), 0)).length === 1 && (await st.listRecentAsks(A, S(10), -5)).length === 1);
  }
} catch (e) {
  bad("예외", e && e.stack || String(e));
} finally {
  await cleanup().catch((e) => console.error("정리 실패", e));
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
