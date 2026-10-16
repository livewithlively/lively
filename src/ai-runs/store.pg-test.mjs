// 앱 AI 실행 행(org_app_ai_run) · 프록시 계측(org_app_llm_call) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖 · CI 는 test.yml 에 등록) (#4488 앱 v2-9).
//    npm run build && ITEMS_DATABASE_URL=… node src/ai-runs/store.pg-test.mjs
//
// 왜 이 계층인가: 이 설계의 약속 — 한 번만 끝남 · 프록시 토큰은 열린 실행에만 · 사람당 동시 셈은 열린 실행만 · 하루 토큰은 오늘 · 그 앱 · 네 종류 합 ·
//  재시도는 열린 실행만 — 이 전부 **SQL 한 문장의 조건**이다. 가짜 저장소(service.test)는 그 조건을 흉내 낼 뿐이라 조건을 지워도 초록이다.
//  T1~T11.
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
  const f1 = await st.finishAiRun(p1.id, { status: "done", result: { text: "답" }, error: null, inputTokens: 3, outputTokens: 4 });
  const f2 = await st.finishAiRun(p1.id, { status: "failed", result: null, error: "늦은 실패" });
  const r2 = await row(p1.id);
  chk("T2 끝내기는 한 번 — 두 번째는 null · 결과 그대로", f1 && f1.status === "done" && f2 === null && r2.status === "done" && r2.result.text === "답" && r2.input_tokens === 3 && r2.ended_at, JSON.stringify(r2));

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
  chk("T8 목록 — 필터 · 요지(줄바꿈 공백) · has_result",
    list.length === 3 && list[0].id > list[1].id && list.every((r) => r.prompt_preview === "지시 원문 둘째 줄") && done.length === 1 && done[0].has_result === true && list.every((r) => r.prompt === undefined),
    JSON.stringify(list.map((r) => [r.id, r.status, r.prompt_preview, r.has_result])));

  // ── T9 정비 조회 — 열린 작업 실행만 · 오래 열린 프록시만 ──
  const open = await st.openJobRuns();
  const stale0 = await st.staleProxyRuns(3600);
  await itemsPool.query(`UPDATE org_app_ai_run SET started_at = now() - interval '2 hours' WHERE requester=$1 AND status='running' AND executor='proxy'`, [`${REQ}b`]);
  const stale1 = await st.staleProxyRuns(3600);
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
