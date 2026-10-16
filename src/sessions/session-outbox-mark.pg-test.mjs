// 아웃박스 결말 SQL(#4697 T7) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/sessions/session-outbox-mark.pg-test.mjs
//
// 왜 이 계층인가: 배달 결말을 새기는 UPDATE(session-outbox.ts mark)는 **모든 프롬프트 배달**이 지나는 자리다. 이 SQL 이 틀리면
//  (문법 · 타입 · 칸 이름) 배달 루프가 결말마다 던져 사람의 말이 하나도 안 간다 — 목 풀로는 SQL 문자열이 무엇이든 초록이다.
//  그래서 실제 표에 행을 넣고 결말을 새긴 뒤 **부작용을 SELECT 로 되읽어** 판정한다. 측정 값(기다린 시간 · 들고 있던 시간 · 답 문장)은
//  DB 의 now() 로 재므로 그것도 여기서만 진짜로 본다.
//
//  사양·엣지 표: 작업 스크래치 spec.md E10.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { markOutboxRowForTest: mark } = await import(`${DIST}/sessions/session-outbox.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const SID = "box-__pgtest-outbox-mark";
const cleanup = () => itemsPool.query(`DELETE FROM org_session_outbox WHERE session_id = $1`, [SID]);
/** 큐에 든 지 ageSec 초 된 행 하나 — stalledSec 이 있으면 그만큼 전부터 못 닿던 행. */
async function put(seq, text, { ageSec = 5, stalledSec = null, kind = "prompt" } = {}) {
  const r = await itemsPool.query(
    `INSERT INTO org_session_outbox(session_id, seq, text, status, kind, created_at, stalled_since)
     VALUES ($1, $2, $3, 'queued', $4, now() - make_interval(secs => $5), CASE WHEN $6::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $6::float8) END)
     RETURNING id`, [SID, seq, text, kind, ageSec, stalledSec]);
  return Number(r.rows[0].id);
}
const read = async (id) => (await itemsPool.query(`SELECT status, last_error, delivered_at FROM org_session_outbox WHERE id = $1`, [id])).rows[0];

try {
  await cleanup();

  // ── E10a delivered — 상태·delivered_at 이 새겨지고, 측정은 DB 시계로 잰 기다린 시간·들고 있던 시간·답 문장 ──
  {
    const id = await put(1, "앞서 물은 ‹가장 좋아하는 색은?›에 대한 답: ‹파랑›\n(이 세션은 질문에 답을 기다리다 꺼졌다가 다시 열렸어요.)", { ageSec: 7, stalledSec: 4 });
    const m = await mark(id, "delivered");
    const r = await read(id);
    chk("E10a delivered — 상태·delivered_at 을 새긴다", r.status === "delivered" && r.last_error === null && !!r.delivered_at, JSON.stringify(r));
    chk("E10a 측정 — 기다린 시간(≈7초)·들고 있던 시간(≈4초)·답 문장 · 글은 안 싣는다",
      m && m.status === "delivered" && m.sessionId === SID && m.seq === 1 && m.kind === "prompt"
        && m.waitMs >= 6500 && m.waitMs < 60_000 && m.heldMs >= 3500 && m.heldMs < m.waitMs && m.answer === true
        && !JSON.stringify(m).includes("파랑"),
      JSON.stringify(m));
  }

  // ── E10b sending — 상태만 바꾸고 측정은 없다(결말이 아니다) ──
  {
    const id = await put(2, "다음 일을 해 줘");
    const m = await mark(id, "sending");
    const r = await read(id);
    chk("E10b sending — 상태만 바뀌고 측정 줄은 없다", r.status === "sending" && !r.delivered_at && m === null, JSON.stringify({ r, m }));
    // ── E10c 이어서 failed(사유) — 사유가 새겨지고 측정에 실린다 · 막힌 적 없으면 heldMs 없음 · 답 문장 아님 ──
    const m2 = await mark(id, "failed", "send: host-unknown");
    const r2 = await read(id);
    chk("E10c failed — 사유를 새기고 측정에 싣는다 · 막힌 적이 없으면 들고 있던 시간 칸이 없다 · 답 문장 아님",
      r2.status === "failed" && r2.last_error === "send: host-unknown" && !r2.delivered_at
        && m2 && m2.status === "failed" && m2.error === "send: host-unknown" && !("heldMs" in m2) && !("answer" in m2),
      JSON.stringify({ r2, m2 }));
  }

  // ── E10d sent(설정 명령) — delivered_at 은 안 새기고 측정은 남는다 ──
  {
    const id = await put(3, "/model opus", { kind: "control" });
    const m = await mark(id, "sent", "control-no-echo");
    const r = await read(id);
    chk("E10d sent — delivered_at 은 그대로(없음) · 측정은 남는다", r.status === "sent" && !r.delivered_at && m && m.kind === "control" && m.error === "control-no-echo",
      JSON.stringify({ r, m }));
  }

  // ── E10e 없는 행 — 던지지 않고 측정도 없다 ──
  {
    let threw = null, m;
    try { m = await mark(-12345, "delivered"); } catch (e) { threw = e; }
    chk("E10e 없는 행 — 던지지 않고 측정 줄도 없다", threw === null && m === null, String(threw));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);
