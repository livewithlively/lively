// 작업 컨테이너 작업 행(org_agent_job) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖) (#4490 앱 v2-11).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/agent-jobs/store.pg-test.mjs
//
// 왜 이 계층인가: 이 설계의 약속 — 워크스페이스 동시 상한 · 대기열 상한 · 일회용 부트 · 한 번만 끝남 · 무응답 재확인 · 일시 실패 되돌리기 —
//  이 전부 **SQL 한 문장의 조건이거나 테넌트 잠금 안의 셈**이다. 가짜 저장소(service.test)는 그 조건을 흉내 낼 뿐이라 조건을 지워도 초록이다
//  (격리 리뷰 blocking). «청/녹 두 슬롯이 같은 작업을 본다» 는 전제를 여기서 잰다 — 병렬로 부르고, 행을 되읽어 판정한다.
//  행 번호(A~J)는 지식 agent-job-container-research-4490 의 엣지 표다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 이 필요하다(실 Postgres)"); process.exit(2); }
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/agent-jobs/store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const REQ = "__agentjob_pg__";
const cleanup = () => itemsPool.query(`DELETE FROM org_agent_job WHERE requester LIKE $1`, [`${REQ}%`]);
const row = async (id) => (await itemsPool.query(`SELECT * FROM org_agent_job WHERE id=$1`, [id])).rows[0];
const job = (who, extra = {}) => ({
  requester: `${REQ}${who}`, accountKind: "subscription", accountMember: `${REQ}${who}`, appId: null, projectId: 1,
  cwd: "/work/shared/project/1", harness: "claude", model: null, label: null, prompt: "pg-test", resumeConversation: null,
  resumeJobId: null, timeoutSec: 900, ...extra,
});
const ROOMY = { max_queued: 500, max_running: 20 };
const add = async (who) => {
  const r = await st.insertAgentJob(job(who), ROOMY);
  if (!r.row) throw new Error(`접수가 막혔다: ${JSON.stringify(r)}`);
  return r.row.id;
};
let seq = 0;
const mint = (id) => ({ sessionId: `job-${id}-${(++seq).toString(16).padStart(8, "0")}`, boot: st.newJobSecret() });
const WIDE = { max_running: 20, max_running_per_member: 20 };
const claimAll = () => st.claimAgentJobs(WIDE, mint);
const byStatus = async () => (await itemsPool.query(
  `SELECT status, account_member, count(*)::int AS c FROM org_agent_job WHERE requester LIKE $1 GROUP BY 1, 2`, [`${REQ}%`])).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let savedPolicy;   // J 블록이 건드리기 전의 워크스페이스 설정(agent_job_policy)
/** 저장소 함수가 쓰는 것과 같은 테넌트 잠금 열쇠(테넌트 GUC 가 없으면 상수). */
const LOCK = `SELECT pg_advisory_xact_lock(hashtextextended('lvly-agent-job:' || COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '-'), 0))`;
const running = async (who) => {
  const id = await add(who);
  const got = await claimAll();
  const c = got.find((x) => x.row.id === id);
  await st.bootAgentJob(id, c.row.boot_hash, "a".repeat(64));
  return id;
};

try {
  await cleanup();
  //  셈(대기·동시)은 표 전체를 본다 — 남의 행이 있으면 이 시험은 판정할 수 없다.
  const others = (await itemsPool.query(`SELECT count(*)::int AS n FROM org_agent_job WHERE requester NOT LIKE $1 AND status IN ('queued','starting','running')`, [`${REQ}%`])).rows[0].n;
  if (others > 0) throw new Error(`이 DB 에 시험 밖의 열린 작업이 ${others}건 있다 — 빈 DB 에서 돌린다`);

  // ── A. 셈은 테넌트 잠금 안에서 ─────────────────────────────────────────────
  // A1 — 같은 열쇠를 쥔 트랜잭션이 있으면 자리 주기·접수가 그 트랜잭션이 끝날 때까지 기다린다(셈과 넘기기가 한 줄로 선다).
  for (const [label, call] of [
    ["자리 주기", () => st.claimAgentJobs(WIDE, mint)],
    ["접수", () => st.insertAgentJob(job("lock"), ROOMY)],
  ]) {
    await cleanup(); await add("a1");
    const side = await itemsPool.connect();
    await side.query("BEGIN");
    await side.query(LOCK);
    let done = false;
    const p = call().then((x) => { done = true; return x; });
    await sleep(500);
    chk(`A1 잠금을 쥔 트랜잭션이 있으면 ${label}가 기다린다`, done === false, "기다리지 않았다");
    await side.query("COMMIT"); side.release();
    await p;
    chk(`A1 잠금이 풀리면 ${label}가 끝난다`, done === true);
  }

  // A2 — 병렬 자리 주기 8개 × 15판: 워크스페이스 상한 · 사람당 상한을 넘지 않는다.
  {
    let worst = 0, worstPer = 0;
    for (let round = 0; round < 15; round++) {
      await cleanup();
      for (let i = 0; i < 12; i++) await add(`m${i % 6}`);
      await Promise.all(Array.from({ length: 8 }, () => st.claimAgentJobs({ max_running: 3, max_running_per_member: 1 }, mint)));
      const live = (await byStatus()).filter((r) => r.status === "starting");
      worst = Math.max(worst, live.reduce((a, r) => a + r.c, 0));
      worstPer = Math.max(worstPer, 0, ...live.map((r) => r.c));
    }
    chk("A2 병렬 자리 주기 — 워크스페이스 동시 상한(3)을 넘지 않는다", worst === 3, `최대 ${worst}`);
    chk("A2 병렬 자리 주기 — 사람당 상한(1)을 넘지 않는다", worstPer === 1, `최대 ${worstPer}`);
  }

  // A3 — 병렬 접수 20건: 대기열 상한(5)만큼만 들어간다.
  {
    await cleanup();
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => st.insertAgentJob(job(`q${i}`), { max_queued: 5, max_running: 2 })));
    const took = res.filter((r) => r.row).length;
    const queued = (await byStatus()).filter((r) => r.status === "queued").reduce((a, r) => a + r.c, 0);
    chk("A3 병렬 접수 — 대기열 상한(5)만큼만 받고 나머지는 «참»(full)", took === 5 && queued === 5 && res.filter((r) => r.full).length === 15, `받음 ${took} · 대기 ${queued}`);
  }

  // A4 — 대기열 0: 자리가 있고 대기가 비었을 때만 받는다.
  {
    await cleanup();
    const a = await st.insertAgentJob(job("z1"), { max_queued: 0, max_running: 1 });
    const b = await st.insertAgentJob(job("z2"), { max_queued: 0, max_running: 1 });
    chk("A4 대기열 0 — 첫 건은 받고, 대기가 생기면 거절", !!a.row && !!b.full, JSON.stringify({ a: !!a.row, b }));
  }

  // A4b — 대기열 0 에서 «띄우는 중» 은 실행으로 센다(자리가 없으면 대기가 비어도 거절).
  {
    await cleanup();
    const a = await st.insertAgentJob(job("z3"), { max_queued: 0, max_running: 1 });
    await claimAll();                                           // 그 작업이 자리를 받아 띄우는 중이 됐다
    const b = await st.insertAgentJob(job("z4"), { max_queued: 0, max_running: 1 });
    chk("A4b 대기열 0 — 띄우는 중인 작업이 자리를 차지하면 다음 접수는 거절", !!a.row && !!b.full && b.full.running === 1 && b.full.queued === 0, JSON.stringify(b));
  }

  // A5 — 끝난 작업은 대기열 셈에 들지 않는다(셈이 열린 작업만 본다).
  {
    await cleanup();
    for (const id of [await add("e1"), await add("e2")]) await st.finishAgentJob(id, { status: "failed", error: "x" });
    const r = await st.insertAgentJob(job("e3"), { max_queued: 1, max_running: 2 });
    chk("A5 끝난 작업은 대기열 셈에 안 든다", !!r.row, JSON.stringify(r));
  }

  // A6 — 사람당 상한에 걸린 앞줄 뒤의 남의 작업도 자리를 받는다(배차가 대기열을 끝까지 본다).
  {
    await cleanup();
    for (let i = 0; i < 230; i++) await add("hog");
    const tail = await add("late");
    const got = await st.claimAgentJobs({ max_running: 3, max_running_per_member: 1 }, mint);
    chk("A6 앞줄 230건이 한 사람 것이어도 그 뒤의 남의 작업이 선다", got.some((x) => x.row.id === tail) && got.length === 2, JSON.stringify(got.map((x) => x.row.account_member)));
  }

  // ── B. 일회용 부트 ─────────────────────────────────────────────────────────
  {
    await cleanup();
    const id = await add("b1");
    const [c] = await claimAll();
    const wrong = await st.bootAgentJob(id, "0".repeat(64), "f".repeat(64));
    chk("B1 부트 해시가 다르면 아무것도 안 바꾼다", wrong === null && (await row(id)).status === "starting");
    const first = await st.bootAgentJob(id, c.row.boot_hash, "a".repeat(64));
    const second = await st.bootAgentJob(id, c.row.boot_hash, "b".repeat(64));
    const r = await row(id);
    chk("B1 첫 부트만 running 으로 넘기고 부트 비밀을 지운다", first?.status === "running" && r.boot_hash === null && r.secret_hash === "a".repeat(64), JSON.stringify({ s: r.status, b: r.boot_hash }));
    chk("B1 두 번째 부트는 null — 콜백 비밀을 덮지 않는다", second === null && r.secret_hash === "a".repeat(64));
    const id2 = await add("b2");
    const c2 = (await claimAll()).find((x) => x.row.id === id2);
    const both = await Promise.all([st.bootAgentJob(id2, c2.row.boot_hash, "c".repeat(64)), st.bootAgentJob(id2, c2.row.boot_hash, "d".repeat(64))]);
    chk("B2 같은 비밀로 두 판이 겹쳐 물어도 하나만 선다", both.filter(Boolean).length === 1, JSON.stringify(both.map((x) => !!x)));
  }

  // ── C. 한 번만 끝난다 ──────────────────────────────────────────────────────
  {
    await cleanup();
    const q = await add("f1");
    const e1 = await st.finishAgentJob(q, { status: "canceled", error: "x" });
    const e2 = await st.finishAgentJob(q, { status: "failed", error: "y" });
    chk("C1 대기 중 끝내기 — 걷을 것이 없으니 바로 걷음 · 두 번째 끝내기는 null", e1?.reaped === true && e2 === null && (await row(q)).status === "canceled");
    const s = await add("f2");
    await claimAll();
    const e3 = await st.finishAgentJob(s, { status: "failed", error: "z", from: ["starting"] });
    chk("C2 띄우는 중 끝내기 — 컨테이너가 있으니 아직 안 걷음 · 부트 비밀은 지운다", e3?.reaped === false && e3?.boot_hash === null, JSON.stringify(e3 && { r: e3.reaped, b: e3.boot_hash }));
    const r1 = await running("f3");
    const ends = await Promise.all([
      st.finishAgentJob(r1, { status: "done", error: null, from: ["running"] }),
      st.finishAgentJob(r1, { status: "failed", error: "감시", from: ["running"] }),
    ]);
    chk("C3 결과 보고와 감시가 겹쳐도 한 번만 끝난다", ends.filter(Boolean).length === 1, JSON.stringify(ends.map((x) => x?.status ?? null)));
    const f = await add("f4");
    chk("C4 from 이 맞지 않으면 끝내지 않는다(대기 작업을 «도는 중» 조건으로)", (await st.finishAgentJob(f, { status: "failed", from: ["running"] })) === null && (await row(f)).status === "queued");
  }

  // ── D. 취소 × 자리 주기 ────────────────────────────────────────────────────
  {
    await cleanup();
    const a = await add("c1"); const b = await add("c2");
    await st.requestCancelAgentJob(a);
    const got = await claimAll();
    chk("D1 취소 요청된 대기 작업은 자리를 받지 않는다", got.length === 1 && got[0].row.id === b, JSON.stringify(got.map((x) => x.row.id)));
    const c = await add("c3");
    const [claimed, ended] = await Promise.all([claimAll(), st.finishAgentJob(c, { status: "canceled", error: "취소", from: ["queued"] })]);
    const won = (claimed.some((x) => x.row.id === c) ? 1 : 0) + (ended ? 1 : 0);
    chk("D2 취소(대기 → 끝)와 자리 주기가 겹쳐도 한쪽만 이긴다", won === 1, JSON.stringify({ claimed: claimed.map((x) => x.row.id), ended: !!ended }));
    const d = await add("c4");
    chk("D3 끝난 작업엔 취소 요청을 달지 않는다", (await st.finishAgentJob(d, { status: "failed" })) !== null && (await st.requestCancelAgentJob(d)) === null);
    //  D4 — 결정적으로: 자리 주기가 그 행을 고른 **뒤** 다른 쪽(취소 · 감시 — 테넌트 잠금 밖)이 끝내면, 자리 주기는 그 행을 넘기지 않는다.
    //   다른 트랜잭션이 행을 끝내 놓고(아직 커밋 전) 쥐고 있으면 자리 주기의 UPDATE 가 그 행에서 기다렸다가, 커밋 뒤의 행으로 조건을 다시 본다.
    await cleanup();
    const e = await add("c5");
    const side = await itemsPool.connect();
    await side.query("BEGIN");
    await side.query(`UPDATE org_agent_job SET status='canceled', ended_at=now(), error='취소' WHERE id=$1`, [e]);
    let claimedRows = null;
    const pc = claimAll().then((x) => { claimedRows = x; });
    await sleep(400);
    await side.query("COMMIT"); side.release();
    await pc;
    const er = await row(e);
    chk("D4 고른 뒤 끝난 행은 넘기지 않는다(끝난 작업이 띄워지지 않는다)", claimedRows.length === 0 && er.status === "canceled" && er.session_id === null,
      JSON.stringify({ claimed: claimedRows.map((x) => x.row.id), status: er.status, sid: er.session_id }));
    //  D5 — 고른 뒤 취소 요청이 걸리면(끝내기 전) 넘기지 않는다 — 취소된 작업의 컨테이너·하네스가 첫 박동까지 도는 틈을 닫는다.
    await cleanup();
    const f5 = await add("c6");
    const side2 = await itemsPool.connect();
    await side2.query("BEGIN");
    await side2.query(`UPDATE org_agent_job SET cancel_requested=true WHERE id=$1`, [f5]);
    let claimed5 = null;
    const pc5 = claimAll().then((x) => { claimed5 = x; });
    await sleep(400);
    await side2.query("COMMIT"); side2.release();
    await pc5;
    const fr = await row(f5);
    chk("D5 고른 뒤 취소 요청이 걸린 행은 넘기지 않는다", claimed5.length === 0 && fr.status === "queued" && fr.cancel_requested === true,
      JSON.stringify({ claimed: claimed5.map((x) => x.row.id), status: fr.status }));
  }

  // ── E. 무응답은 쓰는 순간 다시 잰다 ────────────────────────────────────────
  {
    await cleanup();
    const id = await running("s1");
    await itemsPool.query(`UPDATE org_agent_job SET last_tick_at = now() - interval '120 seconds' WHERE id=$1`, [id]);
    await st.tickAgentJob(id, { tail: "살아 있다", conversationId: null });       // 감시가 읽은 뒤 박동이 왔다
    const no = await st.finishAgentJob(id, { status: "failed", error: "조용", from: ["running"], silentSec: 60 });
    chk("E1 방금 박동한 작업은 무응답으로 끝내지 않는다", no === null && (await row(id)).status === "running");
    await itemsPool.query(`UPDATE org_agent_job SET last_tick_at = now() - interval '61 seconds' WHERE id=$1`, [id]);
    const yes = await st.finishAgentJob(id, { status: "failed", error: "조용", from: ["running"], silentSec: 60 });
    chk("E2 마지막 박동이 상한을 넘었으면 끝낸다", yes?.status === "failed");
    const id2 = await running("s2");
    await itemsPool.query(`UPDATE org_agent_job SET last_tick_at = NULL, started_at = now() - interval '61 seconds' WHERE id=$1`, [id2]);
    chk("E3 박동이 한 번도 없으면 시작 시각으로 잰다", (await st.finishAgentJob(id2, { status: "failed", from: ["running"], silentSec: 60 }))?.status === "failed");
    const id3 = await running("s3");
    chk("E4 silentSec 를 주지 않으면(결과·취소·시간 초과) 시각과 무관하게 끝낸다", (await st.finishAgentJob(id3, { status: "done", from: ["running"] }))?.status === "done");
    chk("E5 박동은 도는 작업에만", (await st.tickAgentJob(id3, { tail: "x", conversationId: null })) === null);
  }

  // ── F. 일시 실패 되돌리기 ─────────────────────────────────────────────────
  {
    await cleanup();
    const id = await add("r1");
    await claimAll();
    const back = await st.requeueAgentJob(id, "띄우기 실패 — 다시 기다립니다: x", 5);
    const r = await row(id);
    chk("F1 띄우는 중이면 대기열로 되돌리고 세션·부트 비밀·자리 받은 시각을 지운다",
      back === true && r.status === "queued" && r.session_id === null && r.boot_hash === null && r.claimed_at === null && /다시 기다립니다/.test(r.error),
      JSON.stringify({ back, s: r.status, sid: r.session_id }));
    chk("F2 대기 중이면 되돌릴 것이 없다(false)", (await st.requeueAgentJob(id, "x", 5)) === false);
    await claimAll();
    await st.requestCancelAgentJob(id);
    chk("F3 취소 요청이 있으면 되돌리지 않는다", (await st.requeueAgentJob(id, "x", 5)) === false && (await row(id)).status === "starting");
    //  F4 — 다시 자리를 받으면 지난 실패 사유를 비우고 시도 횟수를 센다 · F5 — 시도 상한에 닿으면 되돌리지 않는다.
    await cleanup();
    const r2 = await add("r2");
    await claimAll();
    await st.requeueAgentJob(r2, "띄우기 실패 — 다시 기다립니다: y", 5);
    await claimAll();
    const again = await row(r2);
    chk("F4 다시 자리를 받으면 지난 실패 사유를 비우고 시도 횟수가 2", again.status === "starting" && again.error === null && again.attempts === 2,
      JSON.stringify({ s: again.status, e: again.error, a: again.attempts }));
    chk("F5 시도 상한(2)에 닿았으면 되돌리지 않는다(부르는 쪽이 실패로 끝낸다)", (await st.requeueAgentJob(r2, "z", 2)) === false && (await row(r2)).status === "starting");
    chk("F5 상한 밑이면 되돌린다", (await st.requeueAgentJob(r2, "z", 3)) === true && (await row(r2)).status === "queued");
    //  F6 — 되돌린 작업은 쉬는 동안(retryGapSec) 다시 받지 않는다 — 그 자리는 뒤 작업이 쓴다 · 쉬고 나면 다시 받는다.
    const behind = await add("r3");
    const during = await st.claimAgentJobs({ max_running: 5, max_running_per_member: 5 }, mint, { retryGapSec: 30 });
    chk("F6 쉬는 동안엔 되돌린 작업을 건너뛰고 뒤 작업을 받는다", !during.some((x) => x.row.id === r2) && during.some((x) => x.row.id === behind),
      JSON.stringify(during.map((x) => x.row.id)));
    await itemsPool.query(`UPDATE org_agent_job SET updated_at = now() - interval '31 seconds' WHERE id=$1`, [r2]);
    const after = await st.claimAgentJobs({ max_running: 5, max_running_per_member: 5 }, mint, { retryGapSec: 30 });
    chk("F6 쉬고 나면 다시 받는다(시도 3)", after.some((x) => x.row.id === r2) && (await row(r2)).attempts === 3, JSON.stringify(after.map((x) => x.row.id)));
  }

  // ── G·H. 작업 토큰 ────────────────────────────────────────────────────────
  {
    await cleanup();
    const id = await running("t1");
    const h = "0123456789abcdef".repeat(4);
    chk("G1 작업 토큰 해시는 도는 작업에 단다", (await st.setAgentJobMcpToken(id, h)) === true);
    chk("H1 작업 토큰 판별 — 걷지 않은 작업의 토큰 앞자리면 참", (await st.isAgentJobToken(h.slice(0, 12))) === true);
    chk("H2 LIKE 꼴 글자 · 짧은 앞자리 · 대문자는 받지 않는다",
      (await st.isAgentJobToken("%")) === false && (await st.isAgentJobToken("_".repeat(12))) === false && (await st.isAgentJobToken("0123")) === false && (await st.isAgentJobToken("0123456789AB")) === false);
    await st.finishAgentJob(id, { status: "done" });
    chk("H3 끝났지만 아직 안 걷은 작업의 토큰도 작업 토큰이다", (await st.isAgentJobToken(h.slice(0, 12))) === true);
    await st.markAgentJobReaped(id);
    chk("H4 걷은 작업의 토큰은 아니다(이미 폐기됐다)", (await st.isAgentJobToken(h.slice(0, 12))) === false);
    chk("G2 끝난 작업엔 토큰을 달지 않는다(false)", (await st.setAgentJobMcpToken(id, "f".repeat(64))) === false && (await row(id)).mcp_token_hash === h);
  }

  // ── I. 읽는 칸 ─────────────────────────────────────────────────────────────
  {
    await cleanup();
    const id = await running("l1");
    await st.finishAgentJob(id, { status: "done", result: { text: "가".repeat(1000) }, tail: "꼬리", from: ["running"] });
    const a = await st.getAgentJobAuth(id);
    chk("I1 콜백 대조는 다섯 칸만 읽는다(비밀 셋 — 부트 · 실패 보고 #4829 · 콜백)", a && Object.keys(a).sort().join(",") === "boot_hash,fail_hash,id,secret_hash,status", JSON.stringify(a && Object.keys(a)));
    chk("I1 없는 작업은 null", (await st.getAgentJobAuth(987654321)) === null);
    const [l] = await st.listAgentJobs({ requester: `${REQ}l1`, limit: 5 });
    const leaked = ["prompt", "result", "output_tail", "boot_hash", "fail_hash", "secret_hash", "mcp_token_hash"].filter((k) => k in l);
    chk("I2 목록은 요약만 — 프롬프트·결과 전문·꼬리·비밀 해시 없음 · 답 앞머리 280자", leaked.length === 0 && l.result_preview.length === 280 && l.has_result === true,
      JSON.stringify({ leaked, len: l.result_preview?.length }));
    await itemsPool.query(`UPDATE org_agent_job SET reaped=false, error=$2 WHERE id=$1`, [id, "e".repeat(5000)]);
    const open = (await st.openAgentJobs(50)).find((x) => x.id === id);
    chk("I3 감시가 읽는 행엔 프롬프트·결과가 없고 오류는 600자까지", open && !("prompt" in open) && !("result" in open) && open.error.length === 600, JSON.stringify(open && Object.keys(open)));
  }

  // ── K. 멈춘 사유 ──────────────────────────────────────────────────────────
  {
    await cleanup();
    const a = await running("k1");
    await st.requestCancelAgentJob(a, "앱을 더 쓸 수 없게 돼 멈췄습니다");
    const ea = await st.finishAgentJob(a, { status: "canceled", error: "취소했습니다", from: ["running"] });
    chk("K1 사람이 아닌 쪽이 멈춘 작업은 그 사유로 끝난다", ea?.error === "앱을 더 쓸 수 없게 돼 멈췄습니다", JSON.stringify(ea?.error));
    const b = await running("k2");
    await st.requestCancelAgentJob(b);
    const eb = await st.finishAgentJob(b, { status: "canceled", error: "취소했습니다", from: ["running"] });
    chk("K2 사람이 누른 취소는 «취소했습니다»", eb?.error === "취소했습니다", JSON.stringify(eb?.error));
    const c = await running("k3");
    await st.requestCancelAgentJob(c, "사유");
    const ec = await st.finishAgentJob(c, { status: "done", error: null, from: ["running"] });
    chk("K3 취소가 걸렸어도 답을 내고 끝났으면(done) 사유를 오류로 적지 않는다", ec?.status === "done" && ec?.error === null, JSON.stringify(ec && { s: ec.status, e: ec.error }));
  }

  // ── BF. 시작 실패 보고(#4829) — 실패 보고 비밀(fail_hash = 부트 비밀) · 첫 박동 전까지만 ──────────────────
  //  «박동 전» 은 데이터다 — 부트는 실패 보고 비밀을 남기고 첫 박동 · 되돌리기 · 끝내기가 지운다. 그 쓰기들이 SQL 조건이라 가짜 저장소로는 못 잰다.
  {
    await cleanup();
    const id = await add("bf1");
    const [c] = await claimAll();
    chk("BF1 자리를 주면 실패 보고 비밀을 부트 비밀과 같은 값으로 단다", c.row.fail_hash === c.row.boot_hash && /^[0-9a-f]{64}$/.test(c.row.fail_hash ?? ""));
    chk("BF2 해시가 다르면 아무것도 안 바꾼다", (await st.failBootAgentJob(id, "0".repeat(64), "x")) === null && (await row(id)).status === "starting");
    const e1 = await st.failBootAgentJob(id, c.row.fail_hash, "작업 컨테이너가 게이트웨이에 닿지 못했습니다");
    const r1 = await row(id);
    chk("BF3 띄우는 중 — 그 사유로 failed · 끝난 때 · 두 비밀을 지운다 · 컨테이너가 있으니 아직 안 걷음",
      e1?.status === "failed" && r1.error === "작업 컨테이너가 게이트웨이에 닿지 못했습니다" && r1.ended_at !== null
        && r1.fail_hash === null && r1.boot_hash === null && r1.reaped === false,
      JSON.stringify({ s: r1.status, f: r1.fail_hash, b: r1.boot_hash, reaped: r1.reaped }));
    chk("BF3 한 번만 — 두 번째 보고는 null", (await st.failBootAgentJob(id, c.row.fail_hash, "y")) === null && (await row(id)).error === "작업 컨테이너가 게이트웨이에 닿지 못했습니다");

    //  부트는 받았는데(부트 비밀은 지워졌다) 응답이 판에 못 닿은 판 — 도는 중이지만 박동 전.
    const id2 = await add("bf2");
    const c2 = (await claimAll()).find((x) => x.row.id === id2);
    await st.bootAgentJob(id2, c2.row.boot_hash, "a".repeat(64));
    const b2 = await row(id2);
    chk("BF4 부트는 부트 비밀만 지우고 실패 보고 비밀은 남긴다",
      b2.status === "running" && b2.boot_hash === null && b2.fail_hash === c2.row.boot_hash,
      JSON.stringify({ s: b2.status, b: b2.boot_hash, f: b2.fail_hash }));
    const e2 = await st.failBootAgentJob(id2, c2.row.boot_hash, "응답 못 받음");
    chk("BF5 도는 중이라도 박동 전이면 실패로 끝낸다", e2?.status === "failed" && (await row(id2)).fail_hash === null);

    const id3 = await add("bf3");
    const c3 = (await claimAll()).find((x) => x.row.id === id3);
    await st.bootAgentJob(id3, c3.row.boot_hash, "b".repeat(64));
    await st.tickAgentJob(id3, { tail: "도는 중", conversationId: null });
    chk("BF6 첫 박동이 실패 보고 비밀을 지운다 — 박동이 온 판(살아 있다)은 실패 보고로 끝낼 수 없다",
      (await row(id3)).fail_hash === null && (await st.failBootAgentJob(id3, c3.row.boot_hash, "x")) === null && (await row(id3)).status === "running");
    await st.finishAgentJob(id3, { status: "done", error: null, from: ["running"] });
    chk("BF7 끝내면 실패 보고 비밀도 지운다", (await row(id3)).fail_hash === null);

    const id4 = await add("bf4");
    const c4 = (await claimAll()).find((x) => x.row.id === id4);
    await st.requeueAgentJob(id4, "띄우기 실패 — 다시 기다립니다: x", 5);
    chk("BF8 대기열로 되돌리면 앞 컨테이너의 실패 보고 비밀을 지운다(그 비밀로는 못 끝낸다)",
      (await row(id4)).fail_hash === null && (await st.failBootAgentJob(id4, c4.row.boot_hash, "x")) === null && (await row(id4)).status === "queued");

    const id5 = await add("bf5");
    const c5 = (await claimAll()).find((x) => x.row.id === id5);
    const race = await Promise.all([
      st.failBootAgentJob(id5, c5.row.boot_hash, "판 보고"),
      st.finishAgentJob(id5, { status: "failed", error: "감시", from: ["starting"] }),
      st.failBootAgentJob(id5, c5.row.boot_hash, "판 보고 2"),
    ]);
    chk("BF9 실패 보고 둘과 감시가 겹쳐도 한 번만 끝난다", race.filter(Boolean).length === 1, JSON.stringify(race.map((x) => x?.error ?? null)));

    //  끝내는 길은 모두 비밀을 지운다 — 그래도 상태 조건이 마지막 울타리다: 비밀이 남은 끝난 행(앞으로 생길 다른 끝내기 길)을 덮어쓰지 않는다.
    const id6 = await add("bf6");
    const c6 = (await claimAll()).find((x) => x.row.id === id6);
    await itemsPool.query(`UPDATE org_agent_job SET status='done', error=NULL, ended_at=now() WHERE id=$1`, [id6]);
    chk("BF10 끝난 작업은 비밀이 남아 있어도 실패 보고로 덮어쓰지 않는다",
      (await st.failBootAgentJob(id6, c6.row.boot_hash, "x")) === null && (await row(id6)).status === "done" && (await row(id6)).error === null);
  }

  // ── HL. 홈 없는 작업(#4891) — 접수가 그 표시를 그대로 적고(기본 false) 행 · 목록 요약에 실린다 ──────────────────
  {
    await cleanup();
    const plain = await add("hl-plain");
    const put = await st.insertAgentJob(job("hl-app", {
      accountKind: "api_key", accountMember: null, appId: "crm", projectId: null, cwd: "/work/apps/crm", homeless: true,
    }), ROOMY);
    const hid = put.row?.id;
    chk("HL1 접수 — 표시를 안 주면 false · 주면 true 로 적는다(되읽기) · 접수 응답에도 실린다",
      (await row(plain)).homeless === false && put.row?.homeless === true && (await row(hid)).homeless === true,
      JSON.stringify({ plain: (await row(plain)).homeless, put: put.row?.homeless, read: hid && (await row(hid)).homeless }));
    const [l] = await st.listAgentJobs({ requester: `${REQ}hl-app`, limit: 5 });
    chk("HL2 목록 요약에도 실린다", l?.homeless === true, JSON.stringify(l && { id: l.id, homeless: l.homeless }));
  }

  // ── P. 보존 정리(#4828) — 끝났고 걷은 작업 가운데 끝난 지 보존 일수가 지난 행만 지운다 ──────────────────
  //  조건이 SQL 한 문장(store.pruneAgentJobs)이라 가짜 저장소로는 못 잰다 — 여기서 행을 되읽어 판정한다.
  {
    await cleanup();
    //  남의 오래된 끝난 행이 있으면 «지운 수» 를 판정할 수 없다 — 빈 DB 에서 돌린다(CI 가 그렇다).
    const foreign = (await itemsPool.query(
      `SELECT count(*)::int AS n FROM org_agent_job WHERE requester NOT LIKE $1 AND reaped AND ended_at < now() - interval '1 day'`, [`${REQ}%`])).rows[0].n;
    if (foreign > 0) throw new Error(`이 DB 에 시험 밖의 끝난 작업이 ${foreign}건 있다 — 빈 DB 에서 돌린다`);
    const mk = async (who, status, reaped, endedAgoDays) => {
      const id = await add(who);
      await itemsPool.query(
        `UPDATE org_agent_job SET status=$2, reaped=$3, ended_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END WHERE id=$1`,
        [id, status, reaped, endedAgoDays]);
      return id;
    };
    const old = await mk("p-old", "done", true, 91);
    const older = await mk("p-older", "canceled", true, 400);
    const fresh = await mk("p-fresh", "failed", true, 89);
    const unreaped = await mk("p-unreaped", "timeout", false, 400);
    const openOld = await mk("p-open", "running", false, null);
    await itemsPool.query(`UPDATE org_agent_job SET created_at = now() - interval '400 days' WHERE id=$1`, [openOld]);
    //  있어선 안 되는 모양(열린 작업인데 끝난 때 · 걷음 표시가 있다)이어도 열린 작업은 지우지 않는다 — 상태 조건이 마지막 울타리다.
    const openOdd = await mk("p-open-odd", "running", true, 400);
    const exists = async (id) => !!(await row(id));
    chk("P1 0(무기한)은 아무것도 지우지 않는다", (await st.pruneAgentJobs(0)) === 0 && (await exists(old)) && (await exists(older)));
    //  1 일 아래 소수 · 음수 · 숫자 아님도 무기한 — 버림 뒤 0 일(make_interval(days => 0))로 돌면 걷은 행을 다 지운다(격리 리뷰).
    chk("P1b 1 일 아래(0.5 · -3 · NaN)도 아무것도 지우지 않는다",
      (await st.pruneAgentJobs(0.5)) === 0 && (await st.pruneAgentJobs(-3)) === 0 && (await st.pruneAgentJobs(NaN)) === 0 && (await exists(old)) && (await exists(older)));
    const n1 = await st.pruneAgentJobs(90, 1);
    //  «가장 오래된 것부터» 는 ORDER BY 가 약속하고 부분 인덱스(ended_at)도 같은 순서로 읽는다 — ORDER BY 를 지워도 이 시험은 초록이다(격리 리뷰).
    chk("P2 한 판의 상한(batch) — batch 행까지만 · 끝난 때가 오래된 것이 먼저", n1 === 1 && !(await exists(older)) && (await exists(old)), JSON.stringify({ n1 }));
    const n2 = await st.pruneAgentJobs(90);
    chk("P3 보존 일수(90)가 지난 «끝났고 걷은» 행만 — 89일 · 걷기 전 · 열린 작업(끝난 때가 잘못 적혔어도)은 남긴다",
      n2 === 1 && !(await exists(old)) && (await exists(fresh)) && (await exists(unreaped)) && (await exists(openOld)) && (await exists(openOdd)),
      JSON.stringify({ n2, fresh: await exists(fresh), unreaped: await exists(unreaped), openOld: await exists(openOld), openOdd: await exists(openOdd) }));
    chk("P4 다시 돌리면 지울 것이 없다(멱등)", (await st.pruneAgentJobs(90)) === 0);
  }

  // ── J. 상한 고치기(관리자 도구 agent_job_limits_set) — 실제 DB 의 그 칸으로 ──────────────────
  {
    const caps = (await import(`${DIST}/capabilities/agent-jobs.js`)).agentJobCapabilities;
    const set = caps.find((c) => c.name === "agent_job_limits_set");
    const admin = { userId: `${REQ}admin`, email: "", scopes: ["admin"], projects: ["*"] };
    const ctx = { source: "pg-test" };
    const orig = (await itemsPool.query(`SELECT agent_job_policy FROM org_runtime_config WHERE id=1`)).rows[0];
    if (!orig) throw new Error("org_runtime_config 에 id=1 행이 없다(스키마 준비가 덜 됐다)");
    savedPolicy = orig.agent_job_policy;   // 끝나면 이 값으로 되돌린다(빈 DB 가 아닌 곳에서 돌려도 설정을 잃지 않게)
    await set.handler({ reset: true }, admin, ctx);
    const r1 = await set.handler({ max_running: 4 }, admin, ctx);
    const r2 = await set.handler({ max_queued: 7 }, admin, ctx);
    chk("J1 준 값만 바꾸고 이미 적힌 값은 남긴다", r1.policy.max_running === 4 && r2.workspace_setting.max_running === 4 && r2.workspace_setting.max_queued === 7,
      JSON.stringify(r2.workspace_setting));
    let rejected = null;
    try { await set.handler({ max_running_per_member: 9 }, admin, ctx); } catch (e) { rejected = e; }
    const stored = (await itemsPool.query(`SELECT agent_job_policy FROM org_runtime_config WHERE id=1`)).rows[0].agent_job_policy;
    //  jsonb 는 키 순서를 제 식으로 저장한다 — 칸별로 견준다.
    chk("J2 어긋난 조합(사람당 9 > 동시 4)은 400 으로 거절하고 저장값은 그대로",
      rejected?.status === 400 && Object.keys(stored).length === 2 && stored.max_running === 4 && stored.max_queued === 7,
      JSON.stringify({ status: rejected?.status, stored }));
    let ranged = null;
    try { await set.handler({ max_queued: 501 }, admin, ctx); } catch (e) { ranged = e; }
    chk("J3 범위 밖 값은 400", ranged?.status === 400);
    const r4 = await set.handler({ reset: true }, admin, ctx);
    chk("J4 reset 은 워크스페이스 값을 비운다", JSON.stringify(r4.workspace_setting) === "{}" && r4.source !== "db", JSON.stringify(r4.workspace_setting));
    //  #4828 보존 일수 — 기본 90 · 0(무기한)도 받는다 · 범위 밖(3651)은 400.
    const r5 = await set.handler({ keep_days: 0 }, admin, ctx);
    let tooLong = null;
    try { await set.handler({ keep_days: 3651 }, admin, ctx); } catch (e) { tooLong = e; }
    chk("J5 보존 일수(keep_days)를 고친다 — 기본 90 · 0(무기한)은 받고 3651 은 400",
      r4.policy.keep_days === 90 && r5.policy.keep_days === 0 && r5.workspace_setting.keep_days === 0 && tooLong?.status === 400,
      JSON.stringify({ before: r4.policy.keep_days, after: r5.workspace_setting, status: tooLong?.status }));
  }
} catch (e) {
  bad("예외", String((e && e.stack) || e));
} finally {
  await cleanup().catch(() => {});
  if (savedPolicy !== undefined) {
    await itemsPool.query(`UPDATE org_runtime_config SET agent_job_policy=$1::jsonb WHERE id=1`, [JSON.stringify(savedPolicy ?? {})]).catch(() => {});
  }
  await itemsPool.end().catch(() => {});
}

console.log(`agent-job store.pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
