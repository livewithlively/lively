// 앱 AI 실행 행(org_app_ai_run) · 프록시 계측(org_app_llm_call) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖 · CI 는 test.yml 에 등록) (#4488 앱 v2-9).
//    npm run build && ITEMS_DATABASE_URL=… node src/ai-runs/store.pg-test.mjs
//
// 왜 이 계층인가: 이 설계의 약속 — 한 번만 끝남 · 프록시 토큰은 열린 실행에만 · 사람당 동시 셈은 열린 실행만 · 하루 토큰은 오늘 · 그 앱 · 네 종류 합 ·
//  재시도는 열린 실행만 — 이 전부 **SQL 한 문장의 조건**이다. 가짜 저장소(service.test)는 그 조건을 흉내 낼 뿐이라 조건을 지워도 초록이다.
//  T1~T11. #4489 분기(T12~T16): «그 세션 분기만 거르기» · «재요청 표시는 열린 실행에 한 번» · «메모는 끝낼 때 한 번» ·
//  «안 읽은 알림은 그 세션 것만 · 먼저 온 것부터 · 전함 표시는 번호 하나하나(다른 세션 · 이미 읽은 것은 안 셈)» · 작업 행의 분기 좌표 왕복 ·
//  «끝맺기와 알림은 한 문장(T17)» · «분기 실행은 이어받을 대화가 아니다(T18)».
import { isDeepStrictEqual } from "node:util";
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
const SID = "__airun_pg_sess";
const cleanup = async () => {
  await itemsPool.query(`DELETE FROM org_session_notice WHERE session_id LIKE $1`, [`${SID}%`]);
  await itemsPool.query(`DELETE FROM org_app_llm_call WHERE app_id LIKE $1`, [`${APP}%`]);
  await itemsPool.query(`DELETE FROM org_app_ai_run WHERE app_id LIKE $1`, [`${APP}%`]);
  await itemsPool.query(`DELETE FROM org_agent_job WHERE requester LIKE $1`, [`${REQ}%`]);
};
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

  // ── T12 분기 칸 — 행에 그 세션 · 목록은 fork_session 으로 그 세션 분기만 ──
  const fk1 = await st.insertAiRun(base({ executor: "job", status: "queued", kind: "agent", accountKind: "subscription", accountMember: `${REQ}a`, forkSession: `${SID}A` }));
  const fk2 = await st.insertAiRun(base({ executor: "job", status: "queued", kind: "agent", accountKind: "subscription", accountMember: `${REQ}a`, forkSession: `${SID}B` }));
  const onlyA = await st.listAiRuns({ appId: APP, requester: null, status: null, limit: 50, forkSession: `${SID}A` });
  const all = await st.listAiRuns({ appId: APP, requester: null, status: null, limit: 50, forkSession: null });
  chk("T12 분기 칸 — 행에 세션 · fork_session 으로 그 세션 분기만 · 거르지 않으면 다", fk1.fork_session === `${SID}A` && onlyA.length === 1 && onlyA[0].id === fk1.id && onlyA[0].fork_session === `${SID}A`
    && all.some((r) => r.id === fk2.id) && all.some((r) => r.id === p1.id), JSON.stringify([fk1.fork_session, onlyA.map((r) => r.id), all.length]));

  // ── T13 재요청 표시 — 열린 실행에 한 번만 · 끝난 실행엔 안 된다 ──
  const m1 = await st.markAiRunRetried(fk1.id);
  const m2 = await st.markAiRunRetried(fk1.id);
  const m3 = await st.markAiRunRetried(j2.id);   // 끝난 행(T3 에서 failed · retries 0 — 횟수 조건이 아니라 상태 조건이 막아야 한다)
  const r13 = await row(fk1.id);
  const r13b = await row(j2.id);
  chk("T13 재요청 표시 — 열린 실행에 한 번(retries 1) · 두 번째 false · 끝난 행(retries 0) false", m1 === true && m2 === false && m3 === false && r13.retries === 1 && r13b.retries === 0,
    JSON.stringify([m1, m2, m3, r13.retries, r13b.retries]));

  // ── T14 메모는 끝낼 때 — 두 번째 끝내기가 덮지 못한다 ──
  const e1 = await st.finishAiRun(fk1.id, { status: "done", result: { text: "r" }, error: null, sessionNote: "앱이 묻고 답함" });
  const e2 = await st.finishAiRun(fk1.id, { status: "failed", result: null, error: "늦음", sessionNote: "덮어쓰기" });
  const r14 = await row(fk1.id);
  chk("T14 메모 — 끝낼 때 적히고 두 번째 끝내기는 null · 그대로", e1?.session_note === "앱이 묻고 답함" && e2 === null && r14.session_note === "앱이 묻고 답함", JSON.stringify([e1?.session_note, e2, r14.session_note]));

  // ── T15 세션 알림 — 그 세션 것만 · 먼저 온 것부터 · 전함은 번호 하나하나 ──
  const putNotice = async (sid, runId, text) => Number((await itemsPool.query(
    `INSERT INTO org_session_notice(session_id, kind, app_id, run_id, requester, text) VALUES($1,'ai_run',$2,$3,$4,$5) RETURNING id`, [sid, APP, runId, `${REQ}a`, text])).rows[0].id);
  const nA1 = await putNotice(`${SID}A`, fk1.id, "첫 메모");
  const nB1 = await putNotice(`${SID}B`, fk2.id, "B 메모");
  const nA2 = await putNotice(`${SID}A`, null, "둘째 메모");
  const nA3 = await putNotice(`${SID}A`, null, "셋째 메모");
  const u0 = await st.unreadSessionNotices(`${SID}A`, 20);
  const uLim = await st.unreadSessionNotices(`${SID}A`, 2);
  const a1 = await st.ackSessionNotices(`${SID}A`, [nA1, nA3, nB1]);   // B 의 번호는 A 에서 읽음이 되지 않는다
  const a2 = await st.ackSessionNotices(`${SID}A`, [nA1, nA3]);        // 이미 읽음 — 0
  const a3 = await st.ackSessionNotices(`${SID}A`, []);
  const u1 = await st.unreadSessionNotices(`${SID}A`, 20);
  const uB = await st.unreadSessionNotices(`${SID}B`, 20);
  chk("T15 알림 — 그 세션 것만 · 번호 순 · 상한 · 전함은 그 세션의 그 번호만(이미 읽은 것 · 다른 세션은 안 셈) · 빈 목록 0",
    u0.map((n) => n.id).join() === [nA1, nA2, nA3].join() && u0[0].text === "첫 메모" && u0[0].run_id === fk1.id && u0[0].kind === "ai_run"
      && uLim.length === 2 && a1 === 2 && a2 === 0 && a3 === 0 && u1.map((n) => n.id).join() === String(nA2) && uB.map((n) => n.id).join() === String(nB1),
    JSON.stringify({ u0: u0.map((n) => n.id), uLim: uLim.length, a1, a2, a3, u1: u1.map((n) => n.id), uB: uB.map((n) => n.id) }));

  // ── T16 작업 행의 분기 좌표 — 적고 그대로 읽는다(없으면 null) ──
  const spec = { session: `${SID}A`, conversation: "11111111-2222-3333-4444-555555555555", harness: "claude", model: null, effort: "high", auto_approve: false, block_connectors: true, app_folder: `.lively/apps/${APP}` };
  const fj = await jobs.insertAgentJob({ requester: `${REQ}a`, accountKind: "subscription", accountMember: `${REQ}a`, appId: APP, projectId: null, cwd: "/work/proj", harness: "claude",
    model: null, label: null, prompt: "p", resumeConversation: null, resumeJobId: null, timeoutSec: 60, fork: spec }, { max_queued: 500, max_running: 20 });
  const fjRead = await jobs.getAgentJob(fj.row.id);
  chk("T16 분기 좌표 왕복 · 보통 작업은 null", isDeepStrictEqual(fj.row.fork, spec) && isDeepStrictEqual(fjRead.fork, spec) && jr.row.fork === null,
    JSON.stringify([fj.row.fork, fjRead?.fork, jr.row.fork]));

  // ── T17 끝맺기와 알림은 한 문장 — 끝맺기가 된 때만 한 줄(run_id = 그 실행) · 이미 끝난 실행엔 안 생긴다 · notice 가 없으면 안 생긴다 ──
  const noticesOf = async (sid) => (await itemsPool.query(`SELECT run_id, text FROM org_session_notice WHERE session_id=$1 ORDER BY id`, [sid])).rows;
  const fk3 = await st.insertAiRun(base({ executor: "job", status: "queued", kind: "agent", forkSession: `${SID}C` }));
  const g1 = await st.finishAiRun(fk3.id, { status: "done", result: { text: "r" }, error: null, sessionNote: "메모", notice: { sessionId: `${SID}C`, appId: APP, requester: `${REQ}a`, text: "끝 알림" } });
  const g2 = await st.finishAiRun(fk3.id, { status: "failed", result: null, error: "늦음", notice: { sessionId: `${SID}C`, appId: APP, requester: `${REQ}a`, text: "늦은 알림" } });
  const fk4 = await st.insertAiRun(base({ executor: "job", status: "queued", kind: "agent", forkSession: `${SID}C` }));
  await st.finishAiRun(fk4.id, { status: "canceled", result: null, error: "취소", notice: null });
  const nC = await noticesOf(`${SID}C`);
  chk("T17 끝맺기와 알림 한 문장 — 끝낸 때만 한 줄(run_id 그 실행) · 이미 끝난 실행 · notice 없음은 0",
    g1?.status === "done" && g2 === null && nC.length === 1 && Number(nC[0].run_id) === fk3.id && nC[0].text === "끝 알림", JSON.stringify({ g1: g1?.status, g2, nC }));

  // ── T18 분기 실행은 «이어받을 대화» 목록에 안 나온다(분기 대화는 저장되지 않는다) ──
  const fj2 = await jobs.insertAgentJob({ requester: `${REQ}a`, accountKind: "subscription", accountMember: `${REQ}a`, appId: APP, projectId: null, cwd: "/work/proj", harness: "claude",
    model: null, label: null, prompt: "p", resumeConversation: null, resumeJobId: null, timeoutSec: 60, fork: spec }, { max_queued: 500, max_running: 20 });
  const fk5 = await st.insertAiRun(base({ executor: "job", status: "queued", kind: "agent", forkSession: `${SID}A` }));
  await st.setAiRunJob(fk5.id, fj2.row.id);
  await itemsPool.query(`UPDATE org_agent_job SET conversation_id='fork-conv-x' WHERE id=$1`, [fj2.row.id]);
  await st.finishAiRun(fk5.id, { status: "done", result: { text: "t" }, error: null });
  const convs = await st.appConversations(APP, `${REQ}a`);
  chk("T18 분기 실행은 이어받을 대화 목록에 없다 · 보통 실행(T10)은 그대로", !convs.some((c) => c.run_id === fk5.id) && convs.some((c) => c.conversation_id === "conv-x"),
    JSON.stringify(convs.map((c) => [c.run_id, c.conversation_id])));
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
