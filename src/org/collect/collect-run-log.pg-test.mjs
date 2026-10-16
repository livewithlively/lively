// 수집 실행 기록 · 수집 세션 크기(#4213 T11) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/collect/collect-run-log.pg-test.mjs
//
// 왜 이 계층인가: 약속이 전부 SQL 이다 — «같은 판의 끝은 처음 것이 남는다(단 게이트웨이 추정은 러너 끝이 덮는다)» 는
//  ON CONFLICT … WHERE 이고, «크기를 안 건드린 저장은 그 칸을 그대로 둔다» 는 긴 INSERT 의 매개변수 자리 하나다.
//  목 풀로는 자리를 하나 밀어도 초록이다. 그래서 **행을 되읽어** 판정한다.
//  사양·엣지 표: 순수 행(P·O·M·A)은 sessions/collect-session-policy.test.ts · org/collect/run-outcome.test.ts. 여기는 P9~P11 · R · D 행.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const log = await import(`${DIST}/org/collect/run-log.js`);
const rc = await import(`${DIST}/org/store/runtime-config.js`);
const { effectiveCollectSessionPolicy } = await import(`${DIST}/sessions/session-memory-policy.js`);
const { runtimeConfigCapabilities } = await import(`${DIST}/capabilities/delivery/runtime-config.js`);
const { collectRunCapabilities } = await import(`${DIST}/capabilities/collect-run.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const statusOf = async (fn) => { try { await fn(); return 200; } catch (e) { return e?.status ?? 500; } };

delete process.env.LIVELY_COLLECT_MEM_MB;
delete process.env.LIVELY_COLLECT_MEM_REQUEST_MB;
const ADMIN = { userId: "__crl_pg_admin__", email: "", scopes: ["items", "context", "memory", "admin"], projects: [] };
const A = "__crl_pg_a__", B = "__crl_pg_b__";
const update = runtimeConfigCapabilities.find((c) => c.name === "org_runtime_update");
const stats = collectRunCapabilities.find((c) => c.name === "collect_claude_run_stats");
if (!update || !stats) throw new Error("capability 를 못 찾았다(배선)");
const save = (body) => update.handler(body, ADMIN, { source: "pg-test" });
const rawPolicy = async (col) => (await itemsPool.query(`SELECT ${col} AS v FROM org_runtime_config WHERE id=1`)).rows[0]?.v ?? null;
const runRow = async (id) => (await itemsPool.query(`SELECT * FROM collect_run WHERE run_id=$1`, [id])).rows[0];

// 시험 전 원래 값을 쥐어 둔다(공유 DB 에서 돌려도 남의 설정을 남기지 않게).
const before = { collect: await rawPolicy("collect_session_policy"), mem: await rawPolicy("session_memory_policy") };
const resetCollect = () => itemsPool.query(`UPDATE org_runtime_config SET collect_session_policy='{}'::jsonb WHERE id=1`);
const cleanup = async () => {
  await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [[A, B]]);
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [[A]]);
};
await cleanup();

try {
  // ── 크기 정책 ──────────────────────────────────────────────────────────────
  await save({ writeback_notice: null });   // 행을 만든다(빈 DB) — 크기 칸은 안 건드린 저장
  await resetCollect();
  {
    const c = (await rc.getRuntimeConfig()).collect_session_policy;
    chk("R1 기본 1024/640 · 출처 default", c.max_mb === 1024 && c.request_mb === 640 && (await rc.getCollectSessionPolicySource()) === "default", JSON.stringify(c));
  }
  {
    const r = await save({ collect_session_policy: { max_mb: 1536 } });
    const c = r.runtimeConfig.collect_session_policy;
    const raw = await rawPolicy("collect_session_policy");
    chk("R2 상한만 저장 → 1536/640 · DB 에 그 값 · 출처 db", c.max_mb === 1536 && c.request_mb === 640 && raw?.max_mb === 1536 && (await rc.getCollectSessionPolicySource()) === "db",
      JSON.stringify({ c, raw }));
  }
  {
    const s1 = await statusOf(() => save({ collect_session_policy: { request_mb: 2000 } }));
    const raw = await rawPolicy("collect_session_policy");
    chk("P9 예약 > 상한 저장 → 400 · DB 그대로", s1 === 400 && raw?.max_mb === 1536 && raw?.request_mb === 640, `${s1} ${JSON.stringify(raw)}`);
  }
  {
    const codes = [];
    for (const body of [{ max_mb: 255 }, { max_mb: 8193 }, { max_mb: "x" }, { max_mb: 1.5 }, { request_mb: 127 }]) codes.push(await statusOf(() => save({ collect_session_policy: body })));
    codes.push(await statusOf(() => save({ collect_session_policy: [1] })));
    codes.push(await statusOf(() => save({ collect_session_policy: "1024" })));
    const okEdge = await statusOf(() => save({ collect_session_policy: { max_mb: 256, request_mb: 128 } }));
    const raw = await rawPolicy("collect_session_policy");
    chk("P10 범위 밖·숫자 아님·객체 아님 → 400 · 경계(256/128)는 저장", codes.every((c) => c === 400) && okEdge === 200 && raw?.max_mb === 256 && raw?.request_mb === 128,
      `${codes} ${okEdge} ${JSON.stringify(raw)}`);
    await save({ collect_session_policy: { max_mb: 1536, request_mb: 640 } });
  }
  {
    await save({ session_memory_policy: { per_session_max_mb: 1536 } });
    const c = (await rc.getRuntimeConfig()).collect_session_policy;
    chk("R3 일반 세션 메모리 저장은 수집 크기를 안 건드린다", c.max_mb === 1536 && c.request_mb === 640, JSON.stringify(c));
  }
  {
    await resetCollect();
    await save({ writeback_notice: null });
    const raw = await rawPolicy("collect_session_policy");
    chk("R4 크기를 안 건드린 저장 → 그 칸은 비어 있는 그대로(기본값이 DB 로 굳지 않는다)", raw && Object.keys(raw).length === 0, JSON.stringify(raw));
  }
  {
    await save({ collect_session_policy: { max_mb: 1536, request_mb: 700 } });
    const r = await save({ collect_session_policy: null });
    const raw = await rawPolicy("collect_session_policy");
    const c = r.runtimeConfig.collect_session_policy;
    chk("R6 null 저장 = 기본값으로 되돌리기 — 저장값을 비우고 1024/640 · 출처 default", raw && Object.keys(raw).length === 0 && c.max_mb === 1024 && c.request_mb === 640
      && (await rc.getCollectSessionPolicySource()) === "default", JSON.stringify({ raw, c }));
  }
  {
    //  P11 의 서버 쪽 반 — 세션 생성이 읽는 그 함수가 저장 직후 새 값을 낸다(브로커 인자는 매니지드 실측으로 본다)
    const load = () => rc.getRuntimeConfig().then((c) => c.collect_session_policy);
    const a = await effectiveCollectSessionPolicy(load);
    await save({ collect_session_policy: { max_mb: 2048, request_mb: 700 } });
    const b = await effectiveCollectSessionPolicy(load);
    chk("R5 저장 즉시 다음 수집 세션이 새 크기를 본다(캐시 무효화)", a.max_mb === 1024 && b.max_mb === 2048 && b.request_mb === 700, JSON.stringify({ a, b }));
  }

  // ── 실행 기록 ──────────────────────────────────────────────────────────────
  const now = Date.now();
  const id = (n) => `cr-${new Date(now - n * 60_000).toISOString().replace(/[-:T]/g, "").slice(0, 14)}-pgt${String(n).padStart(3, "0")}`;
  const startedOf = (n) => new Date(now - n * 60_000);
  const okExit = { startedAt: new Date(now).toISOString(), endedAt: new Date(now + 17_000).toISOString(), durationMs: 17000, timedOut: false, code: 0, signal: null, error: null };
  const okSum = { apps: ["Slack"], allowed: ["Slack"], missing: [], captures: 2, stderrTail: "",
    mem: { cgroupMax: null, container: { totalMb: 1024, startMb: 120, peakMb: 657 } },
    calls: [{ tool: "mcp__claude_ai_Slack__slack_read_channel", error: false }, { tool: "x", error: true }],
    result: { subtype: "success", error: false, turns: 3, durationMs: 15000, costUsd: 0.0041, text: "수집한 내용 — 저장하면 안 된다" } };
  const oomExit = { ...okExit, code: null, signal: "SIGKILL", error: "claude exit null" };
  await itemsPool.query(`INSERT INTO org_member(id, display_name) VALUES($1,$2) ON CONFLICT DO NOTHING`, [A, "PG 시험 A"]);

  const r1 = id(1);
  await log.recordRunStart({ runId: r1, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: startedOf(1) });
  {
    const row = await runRow(r1);
    chk("D1 시작 — 한 행 · 결과 비고 · 그때 크기", row && row.outcome === null && row.cap_mb === 1024 && row.request_mb === 640 && row.apps?.[0] === "Slack" && row.model === "haiku",
      JSON.stringify(row));
  }
  await log.recordRunEnd({ runId: r1, member: A, exit: okExit, summary: okSum, by: "runner", startedAt: startedOf(1) });
  {
    const row = await runRow(r1);
    const noText = !Object.values(row).some((v) => typeof v === "string" && v.includes("수집한 내용"));
    chk("D2 끝 — 결과·메모리·시간·비용·도구 · 결과 문장은 싣지 않는다", row.outcome === "ok" && row.mem_peak_mb === 657 && row.mem_limit_mb === 1024 && row.mem_start_mb === 120
      && Number(row.duration_ms) === 17000 && Math.abs(row.cost_usd - 0.0041) < 1e-9 && row.turns === 3 && row.tool_calls === 2 && row.tool_errors === 1 && row.captures === 2
      && row.ended_by === "runner" && row.ended_at && noText, JSON.stringify(row));
  }
  {
    const again = await log.recordRunEnd({ runId: r1, member: A, exit: oomExit, summary: null, by: "runner", startedAt: startedOf(1) });
    const row = await runRow(r1);
    chk("D3 같은 판의 끝을 또 적어도 처음 것이 남는다", again === null && row.outcome === "ok" && row.mem_peak_mb === 657, JSON.stringify({ again, o: row.outcome }));
  }
  const r2 = id(2);
  await log.recordRunStart({ runId: r2, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: startedOf(2) });
  await log.recordRunEnd({ runId: r2, member: A, exit: { code: null, error: "runner-gone", endedAt: new Date(now).toISOString(), by: "gateway" }, summary: null, by: "gateway", startedAt: startedOf(2) });
  {
    const g = await runRow(r2);
    await log.recordRunEnd({ runId: r2, member: A, exit: okExit, summary: okSum, by: "runner", startedAt: startedOf(2) });
    const row = await runRow(r2);
    chk("D4 게이트웨이 추정(gone) 뒤 러너 끝 → 러너 것으로", g.outcome === "gone" && g.ended_by === "gateway" && row.outcome === "ok" && row.ended_by === "runner" && row.mem_peak_mb === 657,
      JSON.stringify({ g: g.outcome, row: row.outcome }));
  }
  const r3 = id(3);
  await log.recordRunStart({ runId: r3, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: startedOf(3) });
  await log.recordRunEnd({ runId: r3, member: A, exit: oomExit, summary: { ...okSum, result: null }, by: "runner", startedAt: startedOf(3) });
  await log.recordRunEnd({ runId: r3, member: A, exit: { code: null, error: "lost", by: "gateway" }, summary: null, by: "gateway", startedAt: startedOf(3) });
  {
    const row = await runRow(r3);
    chk("D5 러너 끝 뒤 게이트웨이 추정은 덮지 못한다", row.outcome === "oom" && row.ended_by === "runner", JSON.stringify({ o: row.outcome, by: row.ended_by }));
  }
  const r4 = id(4);
  await log.recordRunEnd({ runId: r4, member: B, exit: okExit, summary: { ...okSum, apps: ["Notion"] }, by: "runner", startedAt: startedOf(4) });
  {
    const row = await runRow(r4);
    chk("D6 시작 행 없이 끝만 와도 행이 생긴다(시작 시각 · 앱)", row && row.outcome === "ok" && new Date(row.started_at).getTime() === startedOf(4).getTime() && row.apps?.[0] === "Notion",
      JSON.stringify(row && { s: row.started_at, apps: row.apps }));
  }
  {
    const old = "cr-20260101000000-pgtold", keep = "cr-20260101000000-pgtkep";
    await itemsPool.query(`INSERT INTO collect_run(run_id, member_id, started_at) VALUES($1,$2,$3),($4,$2,$5) ON CONFLICT DO NOTHING`,
      [old, B, new Date(now - 91 * 86400_000), keep, new Date(now - 89 * 86400_000)]);
    //  지우기는 테넌트마다 한 시간에 한 번 — 시계를 두 시간 뒤로 넘겨 이번 시작 기록이 지우게 한다
    await log.recordRunStart({ runId: id(5), member: B, apps: [], model: "haiku", capMb: 1024, requestMb: 640, startedAt: startedOf(5), now: now + 2 * 3600_000 });
    const gone = await runRow(old), kept = await runRow(keep);
    chk("D7 90일 지난 행은 지운다(89일은 남긴다)", !gone && !!kept, JSON.stringify({ gone: !!gone, kept: !!kept }));
  }
  {
    const v = await stats.handler({ days: 1, tz: "Asia/Seoul", recent: 200 }, ADMIN);
    const mine = v.recent.filter((x) => x.member_id === A || x.member_id === B);
    const a1 = v.recent.find((x) => x.run_id === r1);
    const okN = v.stats.ok, oomN = v.stats.outcomes.find((o) => o.outcome === "oom")?.count ?? 0;
    chk("S1 지표 — 내 실행이 실리고 이름이 붙는다 · 결과별로 센다 · 지금 크기와 출처", mine.length >= 4 && a1?.member_name === "PG 시험 A" && a1?.mem_peak_mb === 657
      && okN >= 3 && oomN >= 1 && v.stats.memory.samples >= 3 && v.policy.max_mb === 2048 && v.policy.source === "db" && v.window.tz === "Asia/Seoul",
      JSON.stringify({ mine: mine.length, name: a1?.member_name, okN, oomN, policy: v.policy }));
    chk("S2 지표 표면은 관리자만(scope admin)", stats.scope === "admin", String(stats.scope));
  }
} finally {
  await cleanup();
  await itemsPool.query(`UPDATE org_runtime_config SET collect_session_policy=$1::jsonb, session_memory_policy=$2::jsonb WHERE id=1`,
    [JSON.stringify(before.collect ?? {}), JSON.stringify(before.mem ?? {})]).catch(() => undefined);
  await itemsPool.end().catch(() => undefined);
}

console.log(`collect-run-log pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
