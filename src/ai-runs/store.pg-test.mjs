// 앱 AI 실행 행(org_app_ai_run) · 프록시 계측(org_app_llm_call) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖 · CI 는 test.yml 에 등록) (#4488 앱 v2-9).
//    npm run build && ITEMS_DATABASE_URL=… node src/ai-runs/store.pg-test.mjs
//
// 왜 이 계층인가: 이 설계의 약속 — 한 번만 끝남 · 프록시 토큰은 열린 실행에만 · 사람당 동시 셈은 열린 실행만 · 하루 토큰은 오늘 · 그 앱 · 네 종류 합 ·
//  재시도는 열린 실행만 — 이 전부 **SQL 한 문장의 조건**이다. 가짜 저장소(service.test)는 그 조건을 흉내 낼 뿐이라 조건을 지워도 초록이다.
//  T1~T11 · #5081 T12~T16(설정 칸 잠금 · 감사는 같은 트랜잭션 · 공용 시트로 돈 실행은 시트 계정의 «내 실행» 이 아님 · 지정 도구 · 비활성 회수 · 실행 계정 설정 도구 · 처리기 단위 원자성).
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 이 필요하다(실 Postgres)"); process.exit(2); }
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/ai-runs/store.js`);
const jobs = await import(`${DIST}/agent-jobs/store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const APP = "__airun_pg__";
const REQ = "__airun_req__";
const cleanup = async () => {
  await itemsPool.query(`DELETE FROM org_app_llm_call WHERE app_id LIKE $1`, [`${APP}%`]);
  await itemsPool.query(`DELETE FROM org_app_ai_run WHERE app_id LIKE $1`, [`${APP}%`]);
  await itemsPool.query(`DELETE FROM org_agent_job WHERE requester LIKE $1`, [`${REQ}%`]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='org_runtime_config' AND (actor LIKE $1 OR before->>'member' LIKE $1 OR after->>'member' LIKE $1)`, [`${REQ}%`]);
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1`, [`${REQ}%`]);
};
//  이 시험이 남긴 설정 칸 감사 — 사람이 바꾼 것(actor)과 비활성 회수처럼 행위자가 없는 것(지정 줄의 member)을 함께 센다.
const audits = async (op) => Number((await itemsPool.query(
  `SELECT count(*)::int AS n FROM org_content_audit WHERE entity='org_runtime_config' AND op=$1
      AND (actor LIKE $2 OR before->>'member' LIKE $2 OR after->>'member' LIKE $2)`, [op, `${REQ}%`])).rows[0].n);
const row = async (id) => (await itemsPool.query(`SELECT * FROM org_app_ai_run WHERE id=$1`, [id])).rows[0];
const base = (extra = {}) => ({
  appId: APP, requester: `${REQ}a`, requesterKind: "member", source: "app-ui", jobName: null, kind: "single", accountKind: "api_key", accountMember: null,
  executor: "proxy", model: "m", label: "L", prompt: "지시 원문\n둘째 줄", systemPrompt: null, schema: null, status: "running", ...extra,
});
let savedPolicy, savedAccount;

try {
  await cleanup();

  // ── T1 접수 — 프록시는 running(started_at 있음) · 작업은 queued(started_at 없음) · 원문 그대로 ──
  const p1 = await st.insertAiRun(base());
  const j1 = await st.insertAiRun(base({ executor: "job", status: "queued", kind: "agent", schema: { type: "object" } }));
  chk("T1 프록시 running + started_at · 작업 queued · 지시 원문 그대로",
    p1.status === "running" && p1.started_at && j1.status === "queued" && j1.started_at === null && j1.prompt === "지시 원문\n둘째 줄" && j1.schema.type === "object",
    JSON.stringify([p1.status, !!p1.started_at, j1.status, j1.started_at]));

  // ── T2 한 번만 끝난다 — 두 번째 finish 는 null · 행은 첫 값 그대로 ──
  const f1 = await st.finishAiRun(p1.id, { status: "done", result: { text: "답" }, error: null, inputTokens: 3, outputTokens: 4, retries: 1 });
  const f2 = await st.finishAiRun(p1.id, { status: "failed", result: null, error: "늦은 실패" });
  const r2 = await row(p1.id);
  chk("T2 끝내기는 한 번 — 두 번째는 null · 결과 그대로 · retries 적힘", f1 && f1.status === "done" && f2 === null && r2.status === "done" && r2.result.text === "답" && r2.input_tokens === 3 && r2.retries === 1 && r2.ended_at, JSON.stringify(r2));

  // ── T3 프록시 토큰 → 열린 실행만 ──
  const j2 = await st.insertAiRun(base({ executor: "job", status: "queued", accountKind: "api_key" }));
  await st.setAiRunProxyToken(j2.id, "h2");
  const byTok = await st.getAiRunByToken("h2");
  await st.finishAiRun(j2.id, { status: "failed", result: null, error: "x" });
  const gone = await st.getAiRunByToken("h2");
  chk("T3 토큰 조회는 열린 실행만 — 끝나면 없는 토큰", byTok?.id === j2.id && gone === null, JSON.stringify([byTok?.id, gone]));

  // ── T4 markRunning 은 queued 에서만 · T5 재시도는 열린 실행만 ──
  await st.markAiRunRunning(j1.id);
  const r4 = await row(j1.id);
  await st.markAiRunRunning(p1.id);   // 끝난 행 — 바뀌지 않아야 한다
  const r4b = await row(p1.id);
  chk("T4 running 표시는 queued 에서만 · 끝난 행은 그대로", r4.status === "running" && r4.started_at && r4b.status === "done", JSON.stringify([r4.status, r4b.status]));
  await st.setAiRunJob(j1.id, 777);
  const re1 = await st.retryAiRun(j1.id, 778);
  const re2 = await st.retryAiRun(p1.id, 779);
  const r5 = await row(j1.id);
  chk("T5 재시도 — 열린 실행은 작업 갈아 끼우고 retries+1 · 끝난 실행은 false", re1 === true && re2 === false && Number(r5.job_id) === 778 && r5.retries === 1, JSON.stringify([re1, re2, r5.job_id, r5.retries]));

  // ── T6 사람당 열린 실행 셈 — 끝난 것 · 남의 것은 안 센다 ──
  await st.insertAiRun(base({ requester: `${REQ}b` }));
  const n6 = await st.openRunCountOf(`${REQ}a`);
  chk("T6 열린 실행 셈 — 그 사람 것만 · 끝난 것 제외", n6 === 1, String(n6));

  // ── T7 하루 토큰 — 네 종류 합 · 오늘 · 그 앱만 ──
  const call = (extra = {}) => st.insertLlmCall({ appId: APP, runId: null, caller: "run", member: null, model: "m", path: "/v1/messages", stream: false, status: 200,
    inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, durationMs: 5, error: null, ...extra });
  await call(); await call({ appId: `${APP}other` });
  await call(); await itemsPool.query(`UPDATE org_app_llm_call SET created_at = now() - interval '2 days' WHERE app_id=$1 AND id = (SELECT max(id) FROM org_app_llm_call WHERE app_id=$1)`, [APP]);
  const used = await st.tokensUsedTodayByApp(APP);
  chk("T7 하루 토큰 — 입력+출력+캐시 읽기·쓰기 · 오늘 · 그 앱만", used === 10, String(used));

  // ── T8 목록 — 앱 · 사람 · 상태 필터 · 요지 200자 · has_result ──
  const list = await st.listAiRuns({ appId: APP, requester: `${REQ}a`, status: null, limit: 10 });
  const done = await st.listAiRuns({ appId: APP, requester: null, status: "done", limit: 10 });
  //  T8b 사람 필터 = 보낸 사람 **또는** 그 구독의 주인(초대받은 사람이 보내 내 구독으로 도는 실행 — #4488 리뷰 반영). API 키 실행은 보낸 사람만.
  const inv = await st.insertAiRun(base({ requester: `${REQ}guest`, accountKind: "subscription", accountMember: `${REQ}owner`, executor: "job", status: "queued" }));
  const keyRun = await st.insertAiRun(base({ requester: `${REQ}guest2`, accountKind: "api_key", accountMember: null }));
  const byOwner = await st.listAiRuns({ appId: APP, requester: `${REQ}owner`, status: null, limit: 10 });
  const byGuest = await st.listAiRuns({ appId: APP, requester: `${REQ}guest`, status: null, limit: 10 });
  const byNobody = await st.listAiRuns({ appId: APP, requester: `${REQ}nobody`, status: null, limit: 10 });
  chk("T8b 목록 사람 필터 — 구독 주인도 · 보낸 사람도 · 제3자는 0 · API 키 실행은 주인 없음",
    byOwner.map((r) => r.id).join() === String(inv.id) && byGuest.map((r) => r.id).join() === String(inv.id) && byNobody.length === 0 && !byOwner.some((r) => r.id === keyRun.id),
    JSON.stringify([byOwner.map((r) => r.id), byGuest.map((r) => r.id), byNobody.length]));
  await st.finishAiRun(inv.id, { status: "canceled", result: null, error: "t8b" });   // 뒤 T9(열린 작업 실행만)에 끼지 않게 닫는다
  await st.finishAiRun(keyRun.id, { status: "done", result: { text: "t8b" }, error: null });
  chk("T8 목록 — 필터 · 요지(줄바꿈 공백) · has_result",
    list.length === 3 && list[0].id > list[1].id && list.every((r) => r.prompt_preview === "지시 원문 둘째 줄") && done.length === 1 && done[0].has_result === true && list.every((r) => r.prompt === undefined),
    JSON.stringify(list.map((r) => [r.id, r.status, r.prompt_preview, r.has_result])));

  // ── T9 정비 조회 — 열린 작업 실행만 · 오래 열린 프록시만 ──
  //  이 앱(APP) 행만 견준다 — 같은 DB 에 다른 열린 실행(끝단 시험 · 운영)이 있어도 판정이 흔들리지 않게.
  const open = (await st.openJobRuns()).filter((r) => r.app_id === APP);
  const stale0 = (await st.staleProxyRuns(3600)).filter((r) => r.app_id === APP);
  await itemsPool.query(`UPDATE org_app_ai_run SET started_at = now() - interval '2 hours' WHERE requester=$1 AND status='running' AND executor='proxy'`, [`${REQ}b`]);
  const stale1 = (await st.staleProxyRuns(3600)).filter((r) => r.app_id === APP);
  chk("T9 열린 작업 실행만 · 오래 열린 프록시만", open.length === 1 && open[0].id === j1.id && stale0.length === 0 && stale1.length === 1 && stale1[0].requester === `${REQ}b`,
    JSON.stringify([open.map((r) => r.id), stale0.length, stale1.length]));

  // ── T10 작업 행 → 실행 행(최신) · 이 앱이 만든 대화(작업 join · done · 대화 id 있음) ──
  const jr = await jobs.insertAgentJob({ requester: `${REQ}a`, accountKind: "api_key", accountMember: null, appId: APP, projectId: null, cwd: `/work/apps/${APP}`, harness: "claude",
    model: null, label: null, prompt: "p", resumeConversation: null, resumeJobId: null, timeoutSec: 60, bare: true }, { max_queued: 500, max_running: 20 });
  const jid = jr.row.id;
  chk("T10a 작업 행에 bare 가 적힌다", jr.row.bare === true, JSON.stringify(jr.row.bare));
  const c1 = await st.insertAiRun(base({ executor: "job", status: "queued" }));
  await st.setAiRunJob(c1.id, jid);
  const byJob = await st.getAiRunByJob(jid);
  const conv0 = await st.appConversations(APP, `${REQ}a`);
  await itemsPool.query(`UPDATE org_agent_job SET conversation_id='conv-x' WHERE id=$1`, [jid]);
  await st.finishAiRun(c1.id, { status: "done", result: { text: "t" }, error: null });
  const conv1 = await st.appConversations(APP, `${REQ}a`);
  const convOther = await st.appConversations(APP, `${REQ}b`);
  chk("T10 작업 → 실행 · 만든 대화는 끝난(done) 실행 + 대화 id 있는 작업만 · 그 사람 것만",
    byJob?.id === c1.id && conv0.length === 0 && conv1.length === 1 && conv1[0].conversation_id === "conv-x" && conv1[0].job_id === jid && convOther.length === 0,
    JSON.stringify([byJob?.id, conv0.length, conv1, convOther.length]));

  // ── T11 설정 칸 왕복 — 정책 · 실행 계정 ──
  savedPolicy = (await itemsPool.query(`SELECT app_ai_policy FROM org_runtime_config WHERE id=1`)).rows[0]?.app_ai_policy;
  savedAccount = (await itemsPool.query(`SELECT app_ai_account FROM org_runtime_config WHERE id=1`)).rows[0]?.app_ai_account;
  await st.writeAiRunPolicyRow({ max_inflight: 7 });
  await st.writeAiAccountRow({ default: { kind: "subscription", member: "alice" }, apps: { crm: { jobs: { s: { kind: "api_key" } } } } });
  const pol = await st.aiRunPolicyRow();
  const acc = await st.aiAccountRow();
  chk("T11 설정 칸 왕복", pol.max_inflight === 7 && acc.default.member === "alice" && acc.apps.crm.jobs.s.kind === "api_key", JSON.stringify([pol, acc]));

  // ── T12 설정 칸 고쳐 쓰기(#5081 updateAiAccountRow) — 행 잠금으로 동시 고치기가 서로를 지우지 않는다 · 던지면 아무것도 안 쓴다 ──
  //  관리자 승인과 본인 동의는 다른 사람이 거의 같이 적는다 — 읽고 → 쓰기 사이가 열려 있으면 한쪽이 사라진다(종전 writeAiAccountRow 는 그랬다).
  await st.writeAiAccountRow({});
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.all(["admin", "member"].map((part, i) => st.updateAiAccountRow(async (cur) => {
    await sleepMs(i === 0 ? 150 : 0);   // 첫째가 읽고 오래 쥔다 — 잠금이 없으면 둘째가 같은 옛 값을 읽어 덮어쓴다
    const s = { ...(cur ?? {}) };
    s.service_seats = { ...(s.service_seats ?? {}), seat: { ...(s.service_seats?.seat ?? {}), [part]: part === "admin" ? { by: "root", at: "t" } : { at: "t" } } };
    return { next: s, out: null };
  })));
  const both = (await st.aiAccountRow()).service_seats?.seat ?? {};
  chk("T12 동시 고치기 — 관리자 승인과 본인 동의가 둘 다 남는다", !!both.admin && !!both.member, JSON.stringify(both));
  let threw = null;
  try { await st.updateAiAccountRow(() => { throw Object.assign(new Error("거절"), { status: 409 }); }); } catch (e) { threw = e; }
  const after = (await st.aiAccountRow()).service_seats?.seat ?? {};
  chk("T12b fn 이 던지면 쓰지 않는다(그 오류가 그대로 나온다)", threw?.status === 409 && !!after.admin && !!after.member, JSON.stringify({ status: threw?.status, after }));
  //  T12c next 가 null 이면 쓰지 않는다 — fn 이 돌려준 out 만 나온다(바뀐 것 없음).
  const bumpTo = { service_seats: { seat: { admin: { by: "root", at: "t" } } } };
  const nullOut = await st.updateAiAccountRow(() => ({ next: null, out: "그대로" }));
  const still = (await st.aiAccountRow()).service_seats?.seat ?? {};
  chk("T12c next null → 쓰지 않는다", nullOut === "그대로" && !!still.admin && !!still.member, JSON.stringify({ nullOut, still }));
  //  T12d 감사는 같은 트랜잭션 — fn 안에서 audit(…, c) 뒤 던지면 감사도 없다 · 끝까지 가면 감사와 쓰기가 함께 남는다.
  const { audit } = await import(`${DIST}/org/store/audit.js`);
  const OP = "__pg5081_probe__";
  try {
    await st.updateAiAccountRow(async (cur, c) => { await audit("org_runtime_config", "1", OP, cur, bumpTo, `${REQ}adm`, "pg-test", c); throw Object.assign(new Error("거절"), { status: 409 }); });
  } catch { /* 위에서 409 */ }
  const afterThrow = await audits(OP);
  await st.updateAiAccountRow(async (cur, c) => { await audit("org_runtime_config", "1", OP, cur, bumpTo, `${REQ}adm`, "pg-test", c); return { next: bumpTo, out: null }; });
  const afterOk = await audits(OP);
  const wrote = (await st.aiAccountRow()).service_seats?.seat ?? {};
  chk("T12d 감사는 쓰기와 한 트랜잭션 — 던지면 감사 0 · 끝까지 가면 감사 1 + 쓰기", afterThrow === 0 && afterOk === 1 && !!wrote.admin && !wrote.member,
    JSON.stringify({ afterThrow, afterOk, wrote }));
  //  T12e next 가 null 도 객체도 아니면(undefined) 던지고 쓰지 않는다 — 빈 설정으로 덮어 두 동의 · 기본 실행 계정이 한꺼번에 사라지지 않게.
  let undefErr = null;
  try { await st.updateAiAccountRow(() => ({ next: undefined, out: null })); } catch (e) { undefErr = e; }
  const kept = (await st.aiAccountRow()).service_seats?.seat ?? {};
  chk("T12e next undefined → 던짐 · 설정 그대로", /next/.test(String(undefErr?.message ?? "")) && !!kept.admin, JSON.stringify({ err: undefErr?.message, kept }));

  // ── T13 실행 목록(#5081) — 공용 시트로 돈 실행은 시트 계정(구독 주인)의 «내 실행» 이 아니다 · 보낸 사람에겐 표시와 함께 · 관리자 목록엔 표시 ──
  //  표시는 실행 행의 칸이다(store.RUN_SHARED_SEAT_COL) — 작업 행이 지워져도(보존 정리) · 작업 행이 없어도(접수 실패) 남는다(격리 리뷰).
  await cleanup();   // 앞 시험(T1~T10)이 같은 보낸 사람으로 넣은 실행이 목록에 섞이지 않게
  const SEAT = `${REQ}seat`;
  const JOBP = { max_queued: 500, max_running: 20 };
  const newJob = async (requester, sharedSeat) => (await jobs.insertAgentJob({
    requester, accountKind: "subscription", accountMember: SEAT, appId: "crm", projectId: null, cwd: "/work/apps/crm", harness: "claude", model: null, label: null,
    prompt: "pg", resumeConversation: null, resumeJobId: null, timeoutSec: 600, bare: true, homeless: false, sharedSeat,
  }, JOBP)).row;
  const seatRun = (requester, prompt, sharedSeat) => st.insertAiRun(base({ executor: "job", status: "queued", accountKind: "subscription", accountMember: SEAT, requester, prompt, sharedSeat }));
  const sharedJob = await newJob(`${REQ}a`, true);
  const plainJob = await newJob(`${REQ}b`, false);
  const sharedRun = await seatRun(`${REQ}a`, "앨리스 질문", true);
  const plainRun = await seatRun(`${REQ}b`, "밥 일", false);
  const orphanRun = await seatRun(`${REQ}a`, "앨리스 질문(작업 없음)", true);   // 접수 중 대기열이 차 실패한 꼴 — 작업 행이 없다
  await st.setAiRunJob(sharedRun.id, sharedJob.id);
  await st.setAiRunJob(plainRun.id, plainJob.id);
  const ids = (rows) => rows.map((r) => r.id).sort((x, y) => x - y);
  const sorted = (...xs) => JSON.stringify(xs.sort((x, y) => x - y));
  const seatList = await st.listAiRuns({ appId: APP, requester: SEAT, status: null, limit: 50 });
  const aList = await st.listAiRuns({ appId: APP, requester: `${REQ}a`, status: null, limit: 50 });
  const allList = await st.listAiRuns({ appId: APP, requester: null, status: null, limit: 50 });
  const flag = (rows, id) => rows.find((r) => r.id === id)?.shared_seat;
  chk("T13 시트 계정의 목록 — 공용 시트가 아닌 내 구독 실행만(작업 없는 공용 시트 실행도 뺌) · 보낸 사람은 제 것을 표시와 함께 · 관리자 목록은 표시대로",
    JSON.stringify(ids(seatList)) === JSON.stringify([plainRun.id]) && JSON.stringify(ids(aList)) === sorted(sharedRun.id, orphanRun.id) && flag(aList, sharedRun.id) === true
      && flag(aList, orphanRun.id) === true && flag(allList, sharedRun.id) === true && flag(allList, plainRun.id) === false,
    JSON.stringify({ seat: ids(seatList), a: ids(aList), all: allList.map((r) => [r.id, r.shared_seat]) }));
  //  보존 정리가 작업 행을 지워도 — 실행 행의 표시는 남는다.
  await itemsPool.query(`DELETE FROM org_agent_job WHERE id=$1`, [sharedJob.id]);
  const seatAfterPrune = await st.listAiRuns({ appId: APP, requester: SEAT, status: null, limit: 50 });
  const marks = [await st.aiRunSharedSeat(sharedRun.id), await st.aiRunSharedSeat(orphanRun.id), await st.aiRunSharedSeat(plainRun.id), await st.aiRunSharedSeat(2 ** 40)];
  const rowKeys = Object.keys(await st.getAiRun(sharedRun.id));
  chk("T13a 작업 행이 지워져도 시트 계정 목록에 안 뜸 · 표시 읽기 true · true · false · 없는 id false · 행 읽기(COLS)엔 그 칸이 없다",
    JSON.stringify(ids(seatAfterPrune)) === JSON.stringify([plainRun.id]) && JSON.stringify(marks) === JSON.stringify([true, true, false, false]) && !rowKeys.includes("shared_seat"),
    JSON.stringify({ seat: ids(seatAfterPrune), marks, rowKeys }));
  //  T13b 칸이 아직 없을 때(롤 창) — 목록 · 표시 읽기 · 보통 접수는 돈다(표시 false), 공용 시트 실행 접수만 «없는 칸» 으로 실패한다. 끝나면 칸을 되돌린다(같은 DDL).
  await itemsPool.query(`ALTER TABLE org_app_ai_run DROP COLUMN IF EXISTS shared_seat`);
  let rollList = null, rollErr = null, rollMark = null, plainInsert = null, sharedInsert = null;
  try {
    try { rollList = await st.listAiRuns({ appId: APP, requester: SEAT, status: null, limit: 50 }); } catch (e) { rollErr = e; }
    rollMark = await st.aiRunSharedSeat(sharedRun.id);
    plainInsert = await seatRun(`${REQ}b`, "칸 없을 때 보통 실행", false);
    try { await seatRun(`${REQ}a`, "칸 없을 때 공용 시트 실행", true); } catch (e) { sharedInsert = e; }
  } finally { await itemsPool.query(`ALTER TABLE org_app_ai_run ADD COLUMN IF NOT EXISTS shared_seat BOOLEAN NOT NULL DEFAULT false`); }
  chk("T13b shared_seat 칸이 없을 때 — 목록은 돈다(표시 false · 종전 «내 구독» 가지) · 표시 읽기 false · 보통 접수 됨 · 공용 시트 접수만 42703",
    rollErr === null && (rollList ?? []).length >= 3 && (rollList ?? []).every((r) => r.shared_seat === false) && rollMark === false && plainInsert?.id > 0 && sharedInsert?.code === "42703",
    JSON.stringify({ err: rollErr?.message, rows: (rollList ?? []).map((r) => [r.id, r.shared_seat]), rollMark, plain: plainInsert?.id, code: sharedInsert?.code }));

  // ── T14 공용 시트 지정 도구(app_ai_service_seat_set) — 실제 구성원 표 · 설정 칸 · 감사 ──
  const { upsertMember } = await import(`${DIST}/org/store/members.js`);
  const people = [["adm", ["items", "context", "memory", "admin"]], ["seat", ["items", "context", "memory"]], ["ali", ["items", "context", "memory"]], ["dev", ["items", "context", "memory", "code"]]];
  for (const [id, scopes] of people) await upsertMember({ id: `${REQ}${id}`, display_name: id, kind: "human", state: "active", email: `${id}@example.invalid`, scopes }, "pg-test", "migration");
  const caps = (await import(`${DIST}/capabilities/ai-runs.js`)).aiRunCapabilities;
  const seatSet = caps.find((c) => c.name === "app_ai_service_seat_set");
  const who = (id, scopes) => ({ userId: `${REQ}${id}`, email: "", scopes, projects: ["*"] });
  const ADM = who("adm", ["items", "context", "memory", "admin"]), ALI = who("ali", ["items", "context", "memory"]), SEATU = who("seat", ["items", "context", "memory"]);
  const ctx = { source: "pg-test" };
  const tryIt = async (input, user) => { try { return { r: await seatSet.handler(input, user, ctx) }; } catch (e) { return { status: e?.status, msg: String(e?.message ?? e) }; } };
  await st.writeAiAccountRow({});
  const before0 = await audits("app_ai_service_seat");
  const a1 = await tryIt({ member: SEAT, on: true }, ADM);
  const s1 = a1.r?.seats?.find((x) => x.member === SEAT);
  const a2 = await tryIt({ member: SEAT, on: false }, ALI);
  const a3 = await tryIt({ member: `${REQ}dev`, on: true }, ADM);
  const a4 = await tryIt({ member: SEAT, on: true }, SEATU);
  const s4 = a4.r?.seats?.find((x) => x.member === SEAT);
  const afterOn = await audits("app_ai_service_seat");
  chk("T14 승인(대기) → 남 403 → 높은 권한(code) 409 → 본인 동의로 켜짐 · 감사 두 줄(거절은 안 남음)",
    s1?.state === "member_pending" && a2.status === 403 && a3.status === 409 && /높은 권한/.test(a3.msg ?? "") && s4?.state === "on" && s4?.on === true && afterOn - before0 === 2,
    JSON.stringify({ s1: s1?.state, a2: a2.status, a3: [a3.status, a3.msg], s4: s4?.state, audits: afterOn - before0 }));
  const n1 = await tryIt({ member: `${REQ}ali`, on: false }, ADM);   // 없는 줄 끄기 — 바뀐 것 없음
  const afterNoop = await audits("app_ai_service_seat");
  await st.updateAiAccountRow((cur) => ({ next: { ...cur, service_seats: { ...(cur.service_seats ?? {}), [`${REQ}gone`]: { admin: { by: `${REQ}adm`, at: "t" } } } }, out: null }));
  const g1 = await tryIt({ member: `${REQ}gone`, on: false }, ADM);   // 구성원 표에 없는 계정의 남은 줄
  const g2 = await tryIt({ member: `${REQ}gone`, on: true }, ADM);
  const off = await tryIt({ member: SEAT, on: false }, SEATU);
  const left = (await st.aiAccountRow()).service_seats ?? null;
  const afterAll = await audits("app_ai_service_seat");
  chk("T14b 없는 줄 끄기는 쓰지도 남기지도 않음 · 지워진 계정의 줄은 관리자가 지운다(켜기는 404) · 본인 끄기 → 줄째 지움 · 감사는 실제로 바뀐 것만",
    !!n1.r && afterNoop === afterOn && !!g1.r && g2.status === 404 && !!off.r && left === null && afterAll - afterNoop === 2,
    JSON.stringify({ noop: [!!n1.r, afterNoop - afterOn], g1: !!g1.r, g2: g2.status, off: !!off.r, left, audits: afterAll - afterNoop }));
  //  T14c 다시 켜기는 바뀐 것 없음 — 같은 관리자 · 다른 관리자가 다시 승인해도 처음 승인이 남고 감사도 안 늘어난다.
  const ADM2 = who("adm2", ["items", "context", "memory", "admin"]);
  await upsertMember({ id: `${REQ}adm2`, display_name: "adm2", kind: "human", state: "active", email: "adm2@example.invalid", scopes: ADM2.scopes }, "pg-test", "migration");
  await tryIt({ member: SEAT, on: true }, ADM);
  const firstApproval = (await st.aiAccountRow()).service_seats?.[SEAT]?.admin;
  const beforeRe = await audits("app_ai_service_seat");
  const reApprove1 = await tryIt({ member: SEAT, on: true }, ADM);
  const reApprove2 = await tryIt({ member: SEAT, on: true }, ADM2);
  const afterRe = (await st.aiAccountRow()).service_seats?.[SEAT]?.admin;
  chk("T14c 다시 승인(같은 · 다른 관리자) — 처음 승인 그대로 · 감사 0",
    !!reApprove1.r && !!reApprove2.r && JSON.stringify(afterRe) === JSON.stringify(firstApproval) && firstApproval?.by === `${REQ}adm` && (await audits("app_ai_service_seat")) === beforeRe,
    JSON.stringify({ firstApproval, afterRe, audits: (await audits("app_ai_service_seat")) - beforeRe }));
  //  T14d 구성원 비활성 · 삭제 때 회수(apps/member-deactivation → ai-runs/live.dropServiceSeatOf) — 지정을 지우고 감사 · 없으면 아무것도 안 씀.
  await tryIt({ member: SEAT, on: true }, SEATU);
  const live = await import(`${DIST}/ai-runs/live.js`);
  const beforeDrop = await audits("app_ai_service_seat");
  const d1 = await live.dropServiceSeatOf(SEAT);
  const seatGone = (await st.aiAccountRow()).service_seats?.[SEAT] ?? null;
  const d2 = await live.dropServiceSeatOf(SEAT);
  const afterDrop = await audits("app_ai_service_seat");
  chk("T14d 비활성 · 삭제 회수 — 켜진 지정을 지움(true · 감사 1) · 다시 부르면 false · 감사 그대로",
    d1 === true && seatGone === null && d2 === false && afterDrop - beforeDrop === 1, JSON.stringify({ d1, seatGone, d2, audits: afterDrop - beforeDrop }));

  // ── T15 실행 계정 설정 도구(app_ai_account_set) — 감사(op app_ai_account) · 같은 값은 쓰지도 남기지도 않음 · 켜진 공용 시트는 관리자가 건다 ──
  const acctSet = caps.find((c) => c.name === "app_ai_account_set");
  const tryAcct = async (input, user) => { try { return { r: await acctSet.handler(input, user, ctx) }; } catch (e) { return { status: e?.status, msg: String(e?.message ?? e) }; } };
  await st.writeAiAccountRow({});
  const acct0 = await audits("app_ai_account");
  const k1 = await tryAcct({ kind: "api_key" }, ADM);
  const k2 = await tryAcct({ kind: "api_key" }, ADM);   // 같은 값
  const acct1 = await audits("app_ai_account");
  const notOn = await tryAcct({ kind: "subscription", member: SEAT }, ADM);   // 아직 공용 시트가 아님 → 본인만
  await tryIt({ member: SEAT, on: true }, ADM); await tryIt({ member: SEAT, on: true }, SEATU);
  const k3 = await tryAcct({ kind: "subscription", member: SEAT }, ADM);
  const byMember = await tryAcct({ kind: "subscription", member: SEAT }, ALI);   // 관리자 아님
  const acct2 = await audits("app_ai_account");
  const dflt = (await st.aiAccountRow()).default;
  chk("T15 실행 계정 설정 — 바꾸면 감사 1 · 같은 값은 0 · 안 켜진 남의 구독 403 · 켜진 시트는 관리자가 걸고 감사 1 · 관리자 아니면 403",
    !!k1.r && !!k2.r && acct1 - acct0 === 1 && notOn.status === 403 && !!k3.r && byMember.status === 403 && acct2 - acct1 === 1 && dflt?.member === SEAT,
    JSON.stringify({ k: [!!k1.r, !!k2.r], audits: [acct1 - acct0, acct2 - acct1], notOn: notOn.status, k3: k3.msg, byMember: byMember.status, dflt }));

  // ── T16 처리기 단위 원자성 — 설정 칸 쓰기가 실패하면 처리기가 남긴 감사도 없다(감사를 따로 남기면 여기서 늘어난다) ──
  //  쓰기를 일부러 막는다(검사 제약 — 이 시험 동안만). 지정 도구 · 실행 계정 설정 도구 둘 다.
  const seatAuditT16 = await audits("app_ai_service_seat"), acctAuditT16 = await audits("app_ai_account");
  const settingsT16 = JSON.stringify(await st.aiAccountRow());
  await itemsPool.query(`ALTER TABLE org_runtime_config ADD CONSTRAINT t5081_block CHECK (false) NOT VALID`);
  let b1 = null, b2 = null;
  try {
    b1 = await tryIt({ member: SEAT, on: false }, ADM);
    b2 = await tryAcct({ kind: "api_key" }, ADM);
  } finally { await itemsPool.query(`ALTER TABLE org_runtime_config DROP CONSTRAINT IF EXISTS t5081_block`); }
  chk("T16 쓰기가 막히면 — 두 처리기 모두 실패 · 감사 0 · 설정 그대로",
    !b1?.r && !b2?.r && (await audits("app_ai_service_seat")) === seatAuditT16 && (await audits("app_ai_account")) === acctAuditT16 && JSON.stringify(await st.aiAccountRow()) === settingsT16,
    JSON.stringify({ b1: b1?.msg, b2: b2?.msg, seat: (await audits("app_ai_service_seat")) - seatAuditT16, acct: (await audits("app_ai_account")) - acctAuditT16 }));
} catch (e) {
  bad("예외", String((e && e.stack) || e));
} finally {
  await cleanup().catch(() => {});
  if (savedPolicy !== undefined) await itemsPool.query(`UPDATE org_runtime_config SET app_ai_policy=$1::jsonb WHERE id=1`, [JSON.stringify(savedPolicy ?? {})]).catch(() => {});
  if (savedAccount !== undefined) await itemsPool.query(`UPDATE org_runtime_config SET app_ai_account=$1::jsonb WHERE id=1`, [JSON.stringify(savedAccount ?? {})]).catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`ai-runs store.pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
