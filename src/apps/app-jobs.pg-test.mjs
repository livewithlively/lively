// 앱 백그라운드 작업(#4486 앱 v2-7) PG 통합 시험 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-jobs.pg-test.mjs
//
// 왜 이 계층인가: 이 설계의 약속 — 한 번만 시작(claim) · 끝은 한 번 · 동시 상한 안에서만 부름 · 대기 · 하루 상한을 동시에 와도 넘지 않음 ·
//  돌기 신원은 도는 동안만 · 다시 부르면 옛 비밀은 못 씀 — 이 전부 **SQL 한 문장의 조건**이다. 가짜 저장소로는 조건을 지워도 초록이다.
//  사양 엣지 표 C(spec-4486.md) C1~C16. Lambda 는 메모리 속 가짜(invokeAsync 를 적는다)다.
import "../../scripts/test-apps-root.mjs";
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_jobs_4486";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG */ });
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_SERVER_POLICY", "LIVELY_APP_SERVER_TENANTS", "LIVELY_APP_SERVER_PREFIX", "LIVELY_APP_DOMAIN", "AWS_REGION", "LIVELY_APP_SERVER_REGION"]) delete process.env[k];
process.env.LIVELY_APP_SERVER_EXEC_ROLE = "arn:aws:iam::111122223333:role/lvly-app-exec";
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const { upsertApp, upsertGrant, revokeGrant } = await import(`${D}/org/store/apps.js`);
const svc = await import(`${D}/apps/app-jobs.js`);
const js = await import(`${D}/apps/app-jobs-store.js`);
const { appServerUserId } = await import(`${D}/apps/app-server-id.js`);
const { resolveAppServerPrincipal } = await import(`${D}/apps/app-server-auth.js`);
const { setAppServerPolicy, appServerPolicy } = await import(`${D}/apps/app-server-store.js`);
const { appJobCapabilities } = await import(`${D}/capabilities/app-jobs.js`);
const { parseJobCredential, jobCredential } = await import(`${D}/apps/app-jobs-plan.js`);
const { removeServer } = await import(`${D}/apps/app-server-lifecycle.js`);
const { AwsError } = await import(`${D}/net/aws/aws-json.js`);
const { SINGLE_TENANT_ID } = await import(`${D}/db/tenant-column.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 사람 · 앱 · 서버 줄 ──
for (const [id, scopes] of [["pgt-alice", ["memory"]], ["pgt-bob", ["memory"]], ["pgt-boss", ["memory", "admin"]]]) {
  await q(`INSERT INTO org_member(id, kind, display_name, state, scopes) VALUES($1,'human',$2,'active',$3::jsonb)`, [id, id === "pgt-alice" ? "앨리스" : id, JSON.stringify(scopes)]);
}
const TOOLS = ["app_job_start", "app_job_get", "app_jobs", "app_job_cancel", "store_query"];
const mkApp = async (id, srv = { cur: "3", guard: 4 }) => {
  await upsertApp({ id, title: id, version: "1.0.0", manifest: { id, web: { server: {} } }, source: { kind: "inline" }, content_hash: `h-${id}`, status: "active", enabled: true });
  if (srv) {
    await q(`INSERT INTO org_app_server(app_id, function_name, cur_lambda_version, cur_token_hash, cur_guard, pub_lambda_version, pub_token_hash, pub_guard, stopped_at)
             VALUES ($1, $2, $3, $4, $5, $3, $4, $5, $6)`, [id, `lvly-app-${id}-ws`, srv.cur, srv.cur ? `th-${id}-${srv.cur}` : null, srv.guard, srv.stopped ? new Date() : null]);
  }
  for (const m of ["pgt-alice", "pgt-bob"]) await upsertGrant(id, m, ["memory"], TOOLS);
};
await mkApp("notes");
await mkApp("other");
await mkApp("oldsrv", { cur: "1", guard: null });
await mkApp("guard3", { cur: "1", guard: 3 });
await mkApp("halted", { cur: "2", guard: 4, stopped: true });
await mkApp("nosrv", null);

// 앱 서버 주체(SDK 가 사람 신원을 싣고 부른 것) · 앱 화면 주체 · 사람(MCP).
const srvUser = (app, member = "pgt-alice", address = "pub") => ({ userId: member, email: "", scopes: ["memory"], projects: ["*"], appId: app, appServer: true, appAddress: address });
const uiUser = (app, member = "pgt-alice") => ({ userId: member, email: "", scopes: ["memory"], projects: ["*"], appId: app });
const person = (member = "pgt-alice", scopes = ["memory"]) => ({ userId: member, email: "", scopes, projects: ["*"] });
const boss = person("pgt-boss", ["memory", "admin"]);
//  함수의 앱 서버 토큰 주체(콜백 · 돌기 신원 판정이 받는 것).
const tokUser = (app) => ({ userId: appServerUserId(SINGLE_TENANT_ID, app), email: "", scopes: [], projects: ["*"], appId: app, tokenSource: "db" });

// ── 가짜 Lambda(비동기 부르기) ──
const invokes = [];
let invokeMode = "ok";
let clock = Date.now();
const deps = {
  policy: () => appServerPolicy(),
  env: () => ({ region: "ap-northeast-2", execRoleArn: process.env.LIVELY_APP_SERVER_EXEC_ROLE, awsAccountId: "111122223333", layerArn: "x", prefix: "lvly-app-", runtime: "nodejs22.x", arch: "arm64", codeStorage: "REFERENCE" }),
  invokeAsync: async (_env, fn, qualifier, payload) => {
    if (invokeMode === "missing") throw new AwsError(404, "ResourceNotFoundException", "Function not found");
    if (invokeMode === "big") throw new AwsError(413, "RequestEntityTooLargeException", "Request must be smaller than 1048576 bytes");
    if (invokeMode === "flaky") throw new AwsError(500, "ServiceException", "boom");
    invokes.push({ fn, qualifier, payload });
  },
  domain: () => "lvly.test",
  slug: () => "ws",
  now: () => clock,
};
const credOf = (inv) => parseJobCredential(inv.payload.headers["x-lively-identity"]);
const lastInvoke = (jobId) => [...invokes].reverse().find((i) => credOf(i)?.id === jobId);
const start = (input, user = srvUser("notes")) => svc.startAppJob({ route: "/api/jobs/run", body: { n: 1 }, ...input }, user, {}, deps);
const jobRow = async (id) => js.getAppJob(id, { view: true });
const claimOf = async (id, app = "notes") => svc.onJobClaim(id, svc.jobCallerOf(tokUser(app)), credOf(lastInvoke(id)).secret);
const finish = async (id, report = { outcome: "response", status_code: 200, content_type: "application/json", body_b64: Buffer.from('{"ok":true}').toString("base64"), truncated: false, bytes: 11, duration_ms: 1234 }, run, app = "notes") =>
  svc.onJobResult(id, svc.jobCallerOf(tokUser(app)), run, report, deps);
const resetJobs = async () => { await q(`DELETE FROM org_app_job`); invokes.length = 0; invokeMode = "ok"; await setAppServerPolicy({}, { actor: "t" }); };

try {
  // ── C1 받기 → 곧바로 부름 ──
  const j1 = await start({ label: "회의 전사", body: { file: "a.mp3" } });
  const r1 = await jobRow(j1.id);
  const inv1 = lastInvoke(j1.id);
  chk("C1 받기 → 곧바로 부름 — dispatched · 그 함수 · 그 판(cur 3) · 부르기 신원 · 본문 그대로 · 시도 1",
    j1.status === "dispatched" && r1.status === "dispatched" && inv1?.fn === "lvly-app-notes-ws" && inv1?.qualifier === "3" && credOf(inv1)?.kind === "call"
      && Buffer.from(inv1.payload.body, "base64").toString() === '{"file":"a.mp3"}' && inv1.payload.rawPath === "/api/jobs/run" && r1.attempts === 1
      && r1.requester === "pgt-alice" && r1.variant === "pub" && r1.alias === "cur" && r1.token_hash === "th-notes-3" && r1.source === "app-server" && j1.label === "회의 전사",
    JSON.stringify({ j1, inv: inv1 && { fn: inv1.fn, q: inv1.qualifier } }));
  chk("C1b 부르기 비밀 값은 DB 에 없다(sha256 만)", r1.call_hash && r1.call_hash !== credOf(inv1).secret && /^[0-9a-f]{64}$/.test(r1.call_hash), r1.call_hash);

  // ── C2 시작 확인 왕복 ──
  const c2 = await claimOf(j1.id);
  const r2 = await jobRow(j1.id);
  chk("C2 시작 확인 — running · 돌기 신원 · 사람(이름) · 판 · 시간 · 박동 간격", c2.job === j1.id && parseJobCredential(c2.run)?.kind === "run" && c2.member === "pgt-alice" && c2.member_name === "앨리스"
    && c2.variant === "pub" && c2.timeout_s === 900 && c2.tick_s === 20 && r2.status === "running" && r2.claimed_at && r2.run_hash, JSON.stringify(c2));
  const again = await errOf(claimOf(j1.id));
  chk("C2b 같은 비밀로 다시(재전송 · AWS 중복 전달) → 409 claimed", again?.status === 409 && again?.body?.reason === "claimed", `${again?.status} ${JSON.stringify(again?.body)}`);
  const forged = await errOf(svc.onJobClaim(j1.id, svc.jobCallerOf(tokUser("notes")), "x".repeat(43)));
  chk("C2c 틀린 비밀 → 401", forged?.status === 401, String(forged?.status));
  const otherApp = await errOf(svc.onJobClaim(j1.id, svc.jobCallerOf(tokUser("other")), credOf(lastInvoke(j1.id)).secret));
  chk("C2d 다른 앱의 함수 토큰 → 404(어느 작업인지 말하지 않는다)", otherApp?.status === 404, String(otherApp?.status));
  const noTok = await errOf(Promise.resolve().then(() => svc.jobCallerOf(person())));
  chk("C2e 앱 서버 토큰이 아니면 401", noTok?.status === 401, String(noTok?.status));
  //  C2j 시작하면 요청 본문을 비운다(다시 부르지 않고 보기에도 없다 — 앱 자료를 30일 쥐지 않게) · 크기는 남긴다.
  const raw2 = (await q(`SELECT body, body_bytes FROM org_app_job WHERE id=$1`, [j1.id]))[0];
  chk("C2j 시작한 작업의 요청 본문은 비우고 크기는 남긴다", raw2.body === "" && raw2.body_bytes === Buffer.byteLength('{"file":"a.mp3"}'), JSON.stringify(raw2));
  //  C2k 다른 워크스페이스의 앱 서버 토큰(같은 앱 id)으로는 콜백 자체를 못 부른다 — 테넌트 대조(jobCallerOf).
  const otherWs = { ...tokUser("notes"), userId: appServerUserId("11111111-2222-4333-8444-555555555555", "notes") };
  const crossWs = await errOf(Promise.resolve().then(() => svc.jobCallerOf(otherWs)));
  chk("C2k 다른 워크스페이스의 토큰(같은 앱 id) → 401(claim · 박동 · 결과 모두 이 판정을 지난다)", crossWs?.status === 401 && /다른 워크스페이스/.test(crossWs.message), crossWs?.message);

  //  C2g 같은 부르기가 동시에 두 번 닿아도(AWS 중복 전달) 시작은 한 번 — 둘 다 «아직 안 시작» 을 읽어도 SQL 조건이 하나만 넘긴다.
  {
    const jr = await start({});
    const sec = credOf(lastInvoke(jr.id)).secret;
    const both = await Promise.allSettled(Array.from({ length: 6 }, () => svc.onJobClaim(jr.id, svc.jobCallerOf(tokUser("notes")), sec)));
    const won = both.filter((b) => b.status === "fulfilled");
    const lost = both.filter((b) => b.status === "rejected").map((b) => b.reason?.status);
    chk("C2g 동시에 여섯 번 닿은 같은 부르기 — 시작은 하나 · 나머지 409", won.length === 1 && lost.length === 5 && lost.every((x) => x === 409), `${won.length} ${lost}`);
    await svc.cancelAppJobFor(jr.id, srvUser("notes"), deps);
  }

  //  C2h 시작 SQL 의 조건 — 이미 running 인 줄은 같은 부르기 비밀로 다시 넘기지 않는다(서비스의 앞선 확인과 별개로 경합을 막는 마지막 문).
  {
    const jr = await start({});
    const callHash = (await jobRow(jr.id)).call_hash;
    const first = await js.claimAppJob(jr.id, callHash, "a".repeat(64));
    const second = await js.claimAppJob(jr.id, callHash, "b".repeat(64));
    chk("C2h 시작 SQL — 첫 번은 running · 둘째(같은 비밀)는 null · 돌기 신원은 첫 것 그대로", first?.status === "running" && second === null && (await jobRow(jr.id)).run_hash === "a".repeat(64),
      `${first?.status} ${second?.status}`);
    await svc.cancelAppJobFor(jr.id, srvUser("notes"), deps);
    const jc = await start({});
    const ch = (await jobRow(jc.id)).call_hash;
    await js.requestCancelAppJob(jc.id);   // 표시만(아직 dispatched) — 취소 처리(끝내기) 전에 시작 확인이 닿는 경합
    const third = await js.claimAppJob(jc.id, ch, "c".repeat(64));
    chk("C2i 취소 표시가 된 부른 작업(아직 dispatched)은 시작 SQL 이 넘기지 않는다", third === null && (await jobRow(jc.id)).status === "dispatched", String(third?.status));
    await svc.cancelAppJobFor(jc.id, srvUser("notes"), deps);
  }

  // ── C4 돌기 신원 → 사람 주체 ──
  const p4 = await resolveAppServerPrincipal(tokUser("notes"), c2.run);
  chk("C4 돌기 신원 → 작업을 시작한 사람 ∩ 동의 · 앱 서버 · 작업의 판 · 작업 번호",
    p4.userId === "pgt-alice" && p4.appId === "notes" && p4.appServer === true && p4.appAddress === "pub" && p4.appJobId === j1.id && p4.scopes.join() === "memory", JSON.stringify(p4));
  const callAsAuth = await errOf(resolveAppServerPrincipal(tokUser("notes"), jobCredential("call", j1.id, credOf(lastInvoke(j1.id)).secret)));
  chk("C4b 부르기 신원은 게이트웨이 호출에 못 쓴다 → 401", callAsAuth?.status === 401, String(callAsAuth?.status));
  const wrongApp = await errOf(resolveAppServerPrincipal(tokUser("other"), c2.run));
  chk("C4c 다른 앱의 토큰 + 이 작업의 돌기 신원 → 401", wrongApp?.status === 401, String(wrongApp?.status));
  const badRun = await errOf(resolveAppServerPrincipal(tokUser("notes"), jobCredential("run", j1.id, "y".repeat(43))));
  chk("C4d 틀린 돌기 비밀 → 401", badRun?.status === 401, String(badRun?.status));

  // ── C3 결과 → done · 끝난 뒤 박동 · 결과 다시 ──
  const t3 = await svc.onJobTick(j1.id, svc.jobCallerOf(tokUser("notes")), c2.run);
  const f3 = await finish(j1.id, undefined, c2.run);
  const r3 = await jobRow(j1.id);
  chk("C3 박동(취소 없음) → 결과 response 200 → done · 상태 코드 · 결과 json · 걸린 시간", t3.cancel === false && f3.status === "done" && r3.status === "done" && r3.status_code === 200
    && r3.result?.json?.ok === true && r3.duration_ms === 1234 && r3.ended_at, JSON.stringify(r3.result));
  const tickAfter = await errOf(svc.onJobTick(j1.id, svc.jobCallerOf(tokUser("notes")), c2.run));
  const resAgain = await errOf(finish(j1.id, undefined, c2.run));
  chk("C3b 끝난 뒤 박동 · 결과 다시 → 409(검사 층이 앱 요청을 끊는다 · 결과는 한 번)", tickAfter?.status === 409 && resAgain?.status === 409, `${tickAfter?.status} ${resAgain?.status}`);
  const after = await errOf(resolveAppServerPrincipal(tokUser("notes"), c2.run));
  chk("C4e 끝난 작업의 돌기 신원 → 401(답한 뒤의 호출은 막힌다)", after?.status === 401 && /끝난 작업/.test(after.message), after?.message);
  const ended = await errOf(svc.onJobClaim(j1.id, svc.jobCallerOf(tokUser("notes")), credOf(lastInvoke(j1.id)).secret));
  chk("C2f 끝난 작업의 옛 부르기 → 409 ended", ended?.status === 409 && ended?.body?.reason === "ended", JSON.stringify(ended?.body));
  //  앱이 500 → failed(앞부분)
  const j3 = await start({});
  const c3 = await claimOf(j3.id);
  await finish(j3.id, { outcome: "response", status_code: 500, content_type: "text/plain", body_b64: Buffer.from("transcribe api down").toString("base64"), truncated: false, bytes: 19, duration_ms: 5 }, c3.run);
  const r3b = await jobRow(j3.id);
  chk("C3c 앱이 500 → failed · 오류에 응답 앞부분 · 결과 text", r3b.status === "failed" && /500 로 답했습니다 — transcribe api down/.test(r3b.error) && r3b.result?.text === "transcribe api down", r3b.error);
  //  C3d jsonb 가 받지 않는 글(짝 없는 서로게이트 이스케이프 — 이모지 가운데를 자른 JSON)이어도 작업은 끝난다(결과 때문에 끝맺음을 잃지 않는다).
  const j3d = await start({});
  const c3d = await claimOf(j3d.id);
  const loneB64 = Buffer.from('{"t":"x\\ud83d","n":1}').toString("base64");
  const f3d = await finish(j3d.id, { outcome: "response", status_code: 200, content_type: "application/json", body_b64: loneB64, truncated: false, bytes: 18, duration_ms: 5 }, c3d.run);
  const r3d = await jobRow(j3d.id);
  chk("C3d 짝 없는 서로게이트가 든 JSON 결과 — done · 결과는 글(또는 base64)로 남는다", f3d.status === "done" && r3d.status === "done" && (typeof r3d.result?.text === "string" || typeof r3d.result?.base64 === "string") && r3d.result?.json === undefined,
    JSON.stringify(r3d.result));

  // ── C5 동시 상한 — 앱 2 · 워크스페이스 3 · 넘는 것은 줄 · 하나 끝나면 다음을 부름 ──
  await resetJobs();
  await setAppServerPolicy({ jobs_running_app: 2, jobs_running_workspace: 3 }, { actor: "t" });
  const n5 = [];
  for (let i = 0; i < 4; i++) n5.push(await start({ label: `n${i}` }));
  const o5 = [await start({}, srvUser("other")), await start({}, srvUser("other"))];
  const st5 = async () => (await q(`SELECT app_id, status, count(*)::int n FROM org_app_job GROUP BY 1,2 ORDER BY 1,2`)).map((x) => `${x.app_id}:${x.status}:${x.n}`).join(" ");
  const s5 = await st5();
  chk("C5 동시 상한 — notes 2 부름 · 2 줄 / other 1 부름(워크스페이스 3) · 1 줄", s5 === "notes:dispatched:2 notes:queued:2 other:dispatched:1 other:queued:1" && invokes.length === 3, s5);
  const c5 = await claimOf(n5[0].id);
  await finish(n5[0].id, undefined, c5.run);
  const s5b = await st5();
  chk("C5b 하나 끝나면 곧바로 다음 — 오래 기다린 것부터(notes 셋째)", s5b === "notes:dispatched:2 notes:done:1 notes:queued:1 other:dispatched:1 other:queued:1" && (await jobRow(n5[2].id)).status === "dispatched", s5b);

  // ── C6 대기 · 하루 상한 — 동시에 와도 넘지 않는다 ──
  await resetJobs();
  await setAppServerPolicy({ jobs_running_app: 1, jobs_running_workspace: 1, jobs_queued_app: 2 }, { actor: "t" });
  const burst = await Promise.allSettled(Array.from({ length: 8 }, () => start({})));
  const okN = burst.filter((b) => b.status === "fulfilled").length;
  const deny = burst.filter((b) => b.status === "rejected").map((b) => b.reason?.status);
  const s6 = await st5();
  chk("C6 대기 상한 2 — 동시에 여덟 번 와도 받은 수는 부름 1 + 줄 2 · 나머지 429", okN === 3 && deny.length === 5 && deny.every((s) => s === 429) && s6 === "notes:dispatched:1 notes:queued:2", `${okN} ${deny} ${s6}`);
  await resetJobs();
  await setAppServerPolicy({ jobs_daily_app: 2 }, { actor: "t" });
  await start({}); await start({});
  const d6 = await errOf(start({}));
  await q(`UPDATE org_app_job SET created_at = now() - interval '25 hours'`);
  const d6b = await start({});
  chk("C6b 하루 상한 2 — 셋째 429 · 24시간이 지난 줄은 안 센다", d6?.status === 429 && /하루/.test(d6.message) && d6b.id > 0, d6?.message);

  // ── C7 받지 않는 것 ──
  await resetJobs();
  const e7 = {};
  e7.nosrv = await errOf(start({}, srvUser("nosrv")));
  e7.old = await errOf(start({}, srvUser("oldsrv")));
  e7.g3 = await errOf(start({}, srvUser("guard3")));
  e7.halted = await errOf(start({}, srvUser("halted")));
  await revokeGrant("notes", "pgt-bob");
  e7.nogrant = await errOf(start({}, srvUser("notes", "pgt-bob")));
  await upsertGrant("notes", "pgt-bob", ["memory"], TOOLS);
  await q(`UPDATE org_app SET enabled=false WHERE id='other'`);
  e7.off = await errOf(start({}, srvUser("other")));
  await q(`UPDATE org_app SET enabled=true WHERE id='other'`);
  e7.cross = await errOf(start({ app_id: "other" }, srvUser("notes")));
  e7.agent = await errOf(start({ type: "agent" }));
  e7.long = await errOf(start({ timeout_s: 3600 }));
  e7.lively = await errOf(start({ route: "/_lively/ai/runs" }));
  e7.big = await errOf(start({ body: { pad: "x".repeat(300 * 1024) } }));
  chk("C7 받지 않는 것 — 서버 없음 409 · 옛 판(검사 층 칸 빔 · 3) 409 · 멈춤 503 · 동의 없음 403 · 앱 꺼짐 409 · 다른 앱 403 · agent 400 · 15분 넘음 400 · /_lively 400 · 본문 413",
    e7.nosrv?.status === 409 && e7.old?.status === 409 && /다시 올리/.test(e7.old.message) && e7.g3?.status === 409 && e7.halted?.status === 503 && e7.nogrant?.status === 403
      && e7.off?.status === 409 && e7.cross?.status === 403 && e7.agent?.status === 400 && /ai\/runs/.test(e7.agent.message) && e7.long?.status === 400 && /에이전트/.test(e7.long.message)
      && e7.lively?.status === 400 && e7.big?.status === 413 && (await q(`SELECT count(*)::int n FROM org_app_job`))[0].n === 0 && invokes.length === 0,
    JSON.stringify(Object.fromEntries(Object.entries(e7).map(([k, v]) => [k, v?.status]))));

  // ── C8 깊이 — 작업 안에서 시작한 작업 ──
  await resetJobs();
  const top = await start({});
  const topRun = (await claimOf(top.id)).run;
  const inJob = await resolveAppServerPrincipal(tokUser("notes"), topRun);
  const child = await start({}, inJob);
  const cr = await jobRow(child.id);
  let d = cr;
  for (let i = 0; i < 2; i++) { const run = (await claimOf(d.id)).run; d = await jobRow((await start({}, await resolveAppServerPrincipal(tokUser("notes"), run))).id); }
  const deepRun = (await claimOf(d.id)).run;
  const tooDeep = await errOf(start({}, await resolveAppServerPrincipal(tokUser("notes"), deepRun)));
  chk("C8 작업이 시작한 작업 — 부모 · 깊이+1 · 출처 app-job · 깊이 3 까지 · 넷째 409", cr.parent_id === top.id && cr.depth === 1 && cr.source === "app-job" && d.depth === 3 && tooDeep?.status === 409, `${cr.depth} ${d.depth} ${tooDeep?.status}`);

  // ── C9 취소 ──
  await resetJobs();
  await setAppServerPolicy({ jobs_running_app: 1 }, { actor: "t" });
  const run9 = await start({});
  const wait9 = await start({});
  const cq = await svc.cancelAppJobFor(wait9.id, srvUser("notes"), deps);
  chk("C9 기다리는 작업 취소 → 곧바로 canceled", cq.status === "canceled" && (await jobRow(wait9.id)).status === "canceled", cq.status);
  //  C9e 시작하지 못하고 끝난 작업도 요청 본문을 비운다(끝낸 뒤엔 다시 부르지 않는다 · 앱 자료를 보존 기간 동안 쥐지 않게).
  const body9 = (await q(`SELECT body FROM org_app_job WHERE id=$1`, [wait9.id]))[0].body;
  chk("C9e 기다리다 취소된 작업의 요청 본문도 비운다", body9 === "", JSON.stringify(body9));
  const c9 = await claimOf(run9.id);
  const byBob = await errOf(svc.cancelAppJobFor(run9.id, srvUser("notes", "pgt-bob"), deps));
  const cr9 = await svc.cancelAppJobFor(run9.id, srvUser("notes"), deps);
  const tick9 = await svc.onJobTick(run9.id, svc.jobCallerOf(tokUser("notes")), c9.run);
  const blocked = await errOf(resolveAppServerPrincipal(tokUser("notes"), c9.run));
  await finish(run9.id, { outcome: "canceled", status_code: null, content_type: null, body_b64: null, truncated: false, bytes: 0, duration_ms: 3 }, c9.run);
  chk("C9b 도는 작업 취소 — 같은 앱의 남은 404 · 표시 · 박동이 취소를 알림 · 그 작업의 라이블리 호출 401 · 결과 canceled",
    byBob?.status === 404 && cr9.cancel_requested === true && cr9.status === "running" && tick9.cancel === true && blocked?.status === 401 && (await jobRow(run9.id)).status === "canceled",
    `${byBob?.status} ${cr9.status} ${tick9.cancel} ${blocked?.status}`);
  const run9b = await start({});
  const adminCancel = await svc.cancelAppJobFor(run9b.id, boss, deps);
  chk("C9c 관리자는 남의 작업도 취소(보기는 상태 · 오류만)", adminCancel.status === "canceled" && adminCancel.result === undefined, JSON.stringify(adminCancel));
  const dispCancel = await start({});
  await svc.cancelAppJobFor(dispCancel.id, srvUser("notes"), deps);
  const lateClaim = await errOf(claimOf(dispCancel.id));
  chk("C9d 부른 뒤 취소 → 곧바로 canceled · 늦게 닿은 시작 확인은 409", (await jobRow(dispCancel.id)).status === "canceled" && lateClaim?.status === 409, String(lateClaim?.status));

  // ── C10 감시 ──
  await resetJobs();
  await setAppServerPolicy({ job_wait_s: 60, jobs_running_app: 1 }, { actor: "t" });
  const s10a = await start({});   // dispatched
  const s10b = await start({});   // queued
  await q(`UPDATE org_app_job SET created_at = now() - interval '61 seconds' WHERE id=$1`, [s10b.id]);
  clock = Date.now();
  await svc.sweepAppJobs(deps);
  chk("C10 기다리는 시간 상한을 넘은 줄 → failed(대기 초과)", (await jobRow(s10b.id)).status === "failed" && /기다리는 시간/.test((await jobRow(s10b.id)).error), (await jobRow(s10b.id)).error);
  const oldSecret = credOf(lastInvoke(s10a.id)).secret;
  await q(`UPDATE org_app_job SET dispatched_at = now() - interval '241 seconds' WHERE id=$1`, [s10a.id]);
  await svc.sweepAppJobs(deps);
  const re = await jobRow(s10a.id);
  const newSecret = credOf(lastInvoke(s10a.id)).secret;
  const oldClaim = await errOf(svc.onJobClaim(s10a.id, svc.jobCallerOf(tokUser("notes")), oldSecret));
  chk("C10b 부른 뒤 240초 넘게 시작 없음 → 새 비밀로 다시 부름(시도 2) · 늦게 온 옛 부르기는 401", re.status === "dispatched" && re.attempts === 2 && newSecret !== oldSecret && oldClaim?.status === 401,
    `${re.status} ${re.attempts} ${oldClaim?.status}`);
  await q(`UPDATE org_app_job SET dispatched_at = now() - interval '241 seconds', attempts = 3 WHERE id=$1`, [s10a.id]);
  await svc.sweepAppJobs(deps);
  chk("C10c 세 번 불러도 시작 없음 → failed(시작하지 못함)", (await jobRow(s10a.id)).status === "failed" && /시작하지 못했습니다/.test((await jobRow(s10a.id)).error), (await jobRow(s10a.id)).error);
  const s10c = await start({});
  await claimOf(s10c.id);
  await q(`UPDATE org_app_job SET last_tick_at = now() - interval '91 seconds' WHERE id=$1`, [s10c.id]);
  await svc.sweepAppJobs(deps);
  chk("C10d 박동이 91초 없음 → failed(응답을 멈춤)", (await jobRow(s10c.id)).status === "failed" && /응답을 멈췄습니다/.test((await jobRow(s10c.id)).error), (await jobRow(s10c.id)).error);
  const s10d = await start({});
  await claimOf(s10d.id);
  await q(`UPDATE org_app_job SET claimed_at = now() - interval '961 seconds', last_tick_at = now() WHERE id=$1`, [s10d.id]);
  await svc.sweepAppJobs(deps);
  chk("C10e 시작한 지 시간 상한+60초 넘음 → failed(시간 상한)", (await jobRow(s10d.id)).status === "failed" && /시간 상한/.test((await jobRow(s10d.id)).error), (await jobRow(s10d.id)).error);
  const s10e = await start({});
  const run10e = (await claimOf(s10e.id)).run;
  await svc.cancelAppJobFor(s10e.id, srvUser("notes"), deps);
  await q(`UPDATE org_app_job SET last_tick_at = now() - interval '91 seconds' WHERE id=$1`, [s10e.id]);
  await svc.sweepAppJobs(deps);
  const lateResult = await errOf(finish(s10e.id, undefined, run10e));
  chk("C10f 취소 표시된 작업이 박동 없이 → canceled · 늦게 온 결과는 409", (await jobRow(s10e.id)).status === "canceled" && lateResult?.status === 409, `${(await jobRow(s10e.id)).status} ${lateResult?.status}`);

  // ── C11 부르기 실패 ──
  await resetJobs();
  invokeMode = "missing";
  const m11 = await start({});
  chk("C11 함수(판) 없음(404) → 곧바로 failed(다시 해도 같다) · 오류 칸엔 AWS 짧은 이름만(원문 · 경로 없음)",
    m11.status === "failed" && /함수를 부르지 못했습니다: ResourceNotFoundException$/.test(m11.error) && !/Function not found|2015-03-31/.test(m11.error), JSON.stringify(m11));
  invokeMode = "big";
  const b11 = await start({});
  chk("C11b 이벤트 너무 큼(413) → failed", b11.status === "failed", b11.status);
  invokeMode = "flaky";
  const f11 = await start({});
  chk("C11c 일시 오류(500) → 줄로 되돌림(queued · 시도 1)", f11.status === "queued" && (await jobRow(f11.id)).attempts === 1 && (await jobRow(f11.id)).call_hash === null, `${f11.status}`);
  invokeMode = "ok";
  await svc.dispatchAppJobs(deps);
  chk("C11d 다음 부르기에서 새 비밀로 부름(시도 2)", (await jobRow(f11.id)).status === "dispatched" && (await jobRow(f11.id)).attempts === 2, (await jobRow(f11.id)).status);

  // ── C12 보기 권한 ──
  await resetJobs();
  const v12 = await start({ label: "앨리스 것" });
  const c12 = await claimOf(v12.id);
  await finish(v12.id, undefined, c12.run);
  const mine = await svc.getAppJobFor(v12.id, srvUser("notes"));
  const sameAppOther = await errOf(svc.getAppJobFor(v12.id, srvUser("notes", "pgt-bob")));
  const viaOtherApp = await errOf(svc.getAppJobFor(v12.id, srvUser("other")));
  const adminView = await svc.getAppJobFor(v12.id, boss);
  const viaMcp = await svc.getAppJobFor(v12.id, person());
  const list = await svc.listAppJobsFor({}, srvUser("notes"));
  const bobList = await svc.listAppJobsFor({}, srvUser("notes", "pgt-bob"));
  const adminList = await svc.listAppJobsFor({ app_id: "notes" }, boss);
  chk("C12 보기 — 시작한 사람은 결과까지 · 같은 앱의 남 404 · 다른 앱 404 · 관리자는 상태 · 오류만 · 목록도 같은 선(목록엔 결과 본문 없음)",
    mine.result?.json?.ok === true && sameAppOther?.status === 404 && viaOtherApp?.status === 404 && adminView.status === "done" && adminView.result === undefined
      && viaMcp.result?.json?.ok === true && list.jobs.length === 1 && !("result" in list.jobs[0]) && list.jobs[0].status_code === 200
      && bobList.jobs.length === 0 && adminList.jobs.length === 1 && adminList.jobs[0].result === undefined,
    JSON.stringify({ mine: !!mine.result, adm: adminView.result, b: bobList.jobs.length, l: list.jobs[0] }));
  //  C12d 자주 도는 읽기(박동 · 돌기 신원 · 기다리기 · 감시)는 큰 칸을 끌어오지 않는다 — 보기만 결과까지.
  const light = await js.getAppJob(v12.id);
  chk("C12d 가벼운 읽기엔 결과 · 본문이 없고 보기 읽기엔 결과가 있다", light.result === undefined && light.body === "" && (await js.getAppJob(v12.id, { view: true })).result?.json?.ok === true,
    JSON.stringify({ r: light.result, b: light.body }));
  const waited = await svc.getAppJobFor(v12.id, srvUser("notes"), 5);
  chk("C12b 끝난 작업은 wait 를 줘도 곧바로", waited.status === "done", waited.status);
  const pend = await start({});
  setTimeout(async () => { try { const cc = await claimOf(pend.id); await finish(pend.id, undefined, cc.run); } catch (e) { console.error(e); } }, 1500);
  const t0 = Date.now();
  const w2 = await svc.getAppJobFor(pend.id, srvUser("notes"), 10);
  chk("C12c wait — 끝나면 곧 돌려준다(시간 상한까지 안 기다림)", w2.status === "done" && Date.now() - t0 < 6000, `${w2.status} ${Date.now() - t0}ms`);

  // ── C13 배포 핀 ──
  await resetJobs();
  const p13 = await start({});
  await q(`UPDATE org_app_server SET cur_lambda_version='4', cur_token_hash='th-notes-4' WHERE app_id='notes'`);   // 그사이 새 판
  const p13b = await start({});
  const pins = await js.openJobPins("notes");
  chk("C13 열린 작업이 붙잡은 판 · 토큰 — 만들 때의 판(3 · 4) · 둘 다", pins.versions.sort().join() === "3,4" && pins.tokens.sort().join() === "th-notes-3,th-notes-4" && lastInvoke(p13.id).qualifier === "3" && lastInvoke(p13b.id).qualifier === "4",
    JSON.stringify(pins));
  await svc.cancelAppJobFor(p13.id, srvUser("notes"), deps);
  await svc.cancelAppJobFor(p13b.id, srvUser("notes"), deps);
  const pins2 = await js.openJobPins("notes");
  chk("C13b 끝나면 핀이 풀린다", pins2.versions.length === 0 && pins2.tokens.length === 0, JSON.stringify(pins2));
  await q(`UPDATE org_app_server SET cur_lambda_version='3', cur_token_hash='th-notes-3' WHERE app_id='notes'`);

  // ── C5c 고르기의 공평 — 상한에 닿은 앱의 긴 줄이 앞을 채워도 다른 앱의 작업을 부른다(앞 500줄만 보면 굶었다) ──
  await resetJobs();
  await setAppServerPolicy({ jobs_running_app: 1, jobs_running_workspace: 10 }, { actor: "t" });
  await q(`INSERT INTO org_app_job(app_id, status, requester, variant, alias, function_name, lambda_version, route, body, timeout_s)
           VALUES ('notes','running','pgt-alice','pub','cur','lvly-app-notes-ws','3','/r','{}',900)`);
  await q(`INSERT INTO org_app_job(app_id, status, requester, variant, alias, function_name, lambda_version, route, body, timeout_s)
           SELECT 'notes','queued','pgt-alice','pub','cur','lvly-app-notes-ws','3','/r','{}',900 FROM generate_series(1, 520)`);
  const lone = (await q(`INSERT INTO org_app_job(app_id, status, requester, variant, alias, function_name, lambda_version, route, body, timeout_s)
           VALUES ('other','queued','pgt-alice','pub','cur','lvly-app-other-ws','3','/r','{}',900) RETURNING id`))[0].id;
  const picked5c = await js.claimDispatchable({ workspace: 10, app: 1 });
  chk("C5c 상한에 닿은 앱(notes 1/1)의 줄 520 뒤에 선 다른 앱 작업도 부른다 — notes 는 하나도 안 고름",
    picked5c.length === 1 && Number(picked5c[0].row.id) === Number(lone) && picked5c[0].row.app_id === "other", JSON.stringify(picked5c.map((x) => [x.row.id, x.row.app_id])));

  // ── C10g 감시는 열린 작업을 끝까지 본다(앞 200줄만 보면 뒤의 죽은 작업이 남는다) ──
  await resetJobs();
  await q(`INSERT INTO org_app_job(app_id, status, requester, variant, alias, function_name, lambda_version, route, body, timeout_s, created_at)
           SELECT 'notes','queued','pgt-alice','pub','cur','lvly-app-notes-ws','3','/r','{}',900, now() - interval '2 hours' FROM generate_series(1, 450)`);
  const sw = await svc.sweepAppJobs({ ...deps, env: () => null });
  const left10g = (await q(`SELECT count(*)::int AS n FROM org_app_job WHERE status='queued'`))[0].n;
  chk("C10g 대기 초과 줄 450 — 한 번의 감시가 모두 끝낸다(판을 이어 본다)", sw.ended === 450 && left10g === 0, JSON.stringify({ sw, left10g }));

  // ── C14b 함수를 지우는 사이에 들어온 작업도 끝낸다(줄이 사라진 뒤엔 새 작업이 못 들어온다) ──
  await resetJobs();
  await mkApp("gone2");
  let slipped = null;
  await removeServer("gone2", {
    env: deps.env(),
    api: {
      getFunction: async () => ({ Tags: { "lvly:tenant": SINGLE_TENANT_ID } }),
      deleteFunction: async () => {
        slipped = (await q(`INSERT INTO org_app_job(app_id, status, requester, variant, alias, function_name, lambda_version, route, body, timeout_s)
                             VALUES ('gone2','queued','pgt-alice','pub','cur','lvly-app-gone2-ws','3','/r','{}',900) RETURNING id`))[0].id;
      },
      deleteLogGroup: async () => {},
    },
    revokeFunctionTokens: async () => 0,
  });
  const s14b = slipped ? (await jobRow(Number(slipped))) : null;
  chk("C14b 함수를 지우는 사이에 들어온 작업 — 지운 뒤 failed(줄로 남아 대기 초과까지 기다리지 않는다)", !!s14b && s14b.status === "failed" && /지워/.test(s14b.error),
    JSON.stringify({ slipped, s: s14b?.status }));

  // ── C15 새로 도입한 칸 부재 — 작업의 토큰 칸이 비어도 핀에 빈 값이 없다 ──
  await resetJobs();
  await q(`UPDATE org_app_server SET cur_token_hash=NULL WHERE app_id='other'`);
  await start({}, srvUser("other"));
  const pins15 = await js.openJobPins("other");
  chk("C15 토큰 칸이 빈 판의 작업 — 판은 핀 · 토큰 목록에 빈 값 없음", pins15.versions.join() === "3" && pins15.tokens.length === 0, JSON.stringify(pins15));
  await q(`UPDATE org_app_server SET cur_token_hash='th-other-3' WHERE app_id='other'`);

  // ── C14 앱(서버) 지우기 → 열린 작업 끝 ──
  await resetJobs();
  const a14 = await start({}, srvUser("other"));
  const a14b = await start({}, srvUser("other"));
  await claimOf(a14.id, "other");
  await removeServer("other", { api: { getFunction: async () => null, deleteFunction: async () => {}, deleteLogGroup: async () => {} }, revokeFunctionTokens: async () => 0 });
  chk("C14 서버를 지우면 열린 작업(도는 · 기다리는) 모두 failed", (await jobRow(a14.id)).status === "failed" && (await jobRow(a14b.id)).status === "failed" && /지워/.test((await jobRow(a14.id)).error),
    `${(await jobRow(a14.id)).status} ${(await jobRow(a14b.id)).status}`);

  // ── C16 보존 ──
  await resetJobs();
  const k1 = await start({}); await svc.cancelAppJobFor(k1.id, srvUser("notes"), deps);
  const k2 = await start({}); await svc.cancelAppJobFor(k2.id, srvUser("notes"), deps);
  const k3 = await start({});
  await q(`UPDATE org_app_job SET ended_at = now() - interval '31 days' WHERE id=$1`, [k1.id]);
  await q(`UPDATE org_app_job SET ended_at = now() - interval '29 days' WHERE id=$1`, [k2.id]);
  const pruned = await svc.pruneAppJobRecords();
  chk("C16 끝난 지 30일 넘은 줄만 지운다(29일 · 열린 줄은 남김)", pruned === 1 && !(await jobRow(k1.id)) && !!(await jobRow(k2.id)) && !!(await jobRow(k3.id)), String(pruned));
  //  C16b 보존 기간은 관리자 값(job_keep_days) — 45일이면 29일 · 40일 줄은 남고 50일 줄만 지운다.
  const k4 = await start({}); await svc.cancelAppJobFor(k4.id, srvUser("notes"), deps);
  const k5 = await start({}); await svc.cancelAppJobFor(k5.id, srvUser("notes"), deps);
  await q(`UPDATE org_app_job SET ended_at = now() - interval '40 days' WHERE id=$1`, [k4.id]);
  await q(`UPDATE org_app_job SET ended_at = now() - interval '50 days' WHERE id=$1`, [k5.id]);
  await setAppServerPolicy({ job_keep_days: 45 }, { actor: "t" });
  const pruned45 = await svc.pruneAppJobRecords();
  chk("C16b 보존 45일 — 50일 줄만 지운다(40일 · 29일 남김)", pruned45 === 1 && !(await jobRow(k5.id)) && !!(await jobRow(k4.id)) && !!(await jobRow(k2.id)), String(pruned45));
  //  C16c 보존 기간을 못 읽으면 지우지 않는다(기본 30일로 접으면 관리자가 늘린 기간의 기록이 지워진다).
  const failRead = await errOf(svc.pruneAppJobRecords(async () => { throw new Error("db down"); }));
  chk("C16c 보존 기간 읽기 실패 → 던지고 아무것도 안 지운다", failRead?.message === "db down" && !!(await jobRow(k4.id)) && !!(await jobRow(k2.id)), failRead?.message);

  // ── 능력 배선(MCP · REST 와 같은 handler) — 사람이 도구로(app_id 필수) ──
  await resetJobs();
  const capStart = appJobCapabilities.find((c) => c.name === "app_job_start");
  const viaCap = await capStart.handler({ app_id: "notes", route: "/api/jobs/run", body: { a: 1 } }, person(), { source: "mcp" });
  const noApp = await errOf(capStart.handler({ route: "/x" }, person(), { source: "mcp" }));
  chk("W1 능력 app_job_start — 사람(MCP) · app_id 로 · 출처 mcp · app_id 없으면 400", viaCap.id > 0 && (await jobRow(viaCap.id)).source === "mcp" && noApp?.status === 400, JSON.stringify(viaCap).slice(0, 200));
} catch (e) {
  fail++;
  console.error("시험 도중 예외:", e);
} finally {
  await itemsPool.end().catch(() => {});
  await dbc.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
