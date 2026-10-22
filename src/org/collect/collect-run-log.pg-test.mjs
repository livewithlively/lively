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
const policySet = collectRunCapabilities.find((c) => c.name === "collect_session_policy_set");
if (!update || !stats || !policySet) throw new Error("capability 를 못 찾았다(배선)");
const saveRuntime = (body) => update.handler(body, ADMIN, { source: "pg-test" });
const setSize = (body) => policySet.handler(body, ADMIN, { source: "pg-test" });
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
  // ── 크기 정책(«한 칸 전용 입구» — collect_session_policy_set · getCollectSessionPolicy) ─────────
  await saveRuntime({ writeback_notice: null });   // 행을 만든다(빈 DB)
  await resetCollect();
  {
    const c = await rc.getCollectSessionPolicy();
    const v = await rc.getCollectSessionPolicyView();
    chk("R1 기본 1024/640 · 출처 default · 되돌리면 1024/640", c.max_mb === 1024 && c.request_mb === 640 && v.source === "default"
      && v.reset_to.max_mb === 1024 && v.reset_to.request_mb === 640, JSON.stringify(v));
  }
  {
    const r = await setSize({ max_mb: 1536 });
    const raw = await rawPolicy("collect_session_policy");
    chk("R2 상한만 저장 → 1536/640 · DB 에 그 값 · 출처 db", r.policy.max_mb === 1536 && r.policy.request_mb === 640 && raw?.max_mb === 1536 && r.policy.source === "db",
      JSON.stringify({ p: r.policy, raw }));
  }
  {
    const s1 = await statusOf(() => setSize({ request_mb: 2000 }));
    const raw = await rawPolicy("collect_session_policy");
    chk("P9 예약 > 상한 저장 → 400 · DB 그대로", s1 === 400 && raw?.max_mb === 1536 && raw?.request_mb === 640, `${s1} ${JSON.stringify(raw)}`);
  }
  {
    const codes = [];
    for (const body of [{ max_mb: 255 }, { max_mb: 8193 }, { max_mb: "x" }, { max_mb: 1.5 }, { request_mb: 127 }, {}, { reset: true, max_mb: 1024 }]) {
      codes.push(await statusOf(() => setSize(body)));
    }
    const okEdge = await statusOf(() => setSize({ max_mb: 256, request_mb: 128 }));
    const raw = await rawPolicy("collect_session_policy");
    chk("P10 범위 밖·숫자 아님·빈 요청·되돌리기+값 → 400 · 경계(256/128)는 저장", codes.every((c) => c === 400) && okEdge === 200 && raw?.max_mb === 256 && raw?.request_mb === 128,
      `${codes} ${okEdge} ${JSON.stringify(raw)}`);
    await setSize({ max_mb: 1536, request_mb: 640 });
  }
  {
    await saveRuntime({ session_memory_policy: { per_session_max_mb: 1536 } });
    const c = await rc.getCollectSessionPolicy();
    chk("R3 일반 세션 메모리 저장은 수집 크기를 안 건드린다", c.max_mb === 1536 && c.request_mb === 640, JSON.stringify(c));
  }
  {
    await resetCollect();
    await saveRuntime({ writeback_notice: null });
    const raw = await rawPolicy("collect_session_policy");
    const cfg = await rc.getRuntimeConfig();
    chk("R4 다른 런타임 설정 저장은 이 칸을 그대로 둔다 · 큰 설정 읽기에 이 칸이 섞이지 않는다", raw && Object.keys(raw).length === 0 && !("collect_session_policy" in cfg),
      JSON.stringify(raw));
  }
  {
    await setSize({ max_mb: 1536, request_mb: 700 });
    const r = await setSize({ reset: true });
    const raw = await rawPolicy("collect_session_policy");
    chk("R6 되돌리기 — 저장값을 비우고 1024/640 · 출처 default", raw && Object.keys(raw).length === 0 && r.policy.max_mb === 1024 && r.policy.request_mb === 640
      && r.policy.source === "default", JSON.stringify({ raw, p: r.policy }));
  }
  {
    //  P11 의 서버 쪽 반 — 세션 생성이 읽는 그 함수가 저장 직후 새 값을 낸다(브로커 인자는 매니지드 실측으로 본다)
    const a = await effectiveCollectSessionPolicy(rc.getCollectSessionPolicy);
    await setSize({ max_mb: 2048, request_mb: 700 });
    const b = await effectiveCollectSessionPolicy(rc.getCollectSessionPolicy);
    chk("R5 저장 즉시 다음 수집 세션이 새 크기를 본다(캐시 무효화)", a.max_mb === 1024 && b.max_mb === 2048 && b.request_mb === 700, JSON.stringify({ a, b }));
  }
  {
    const count = async () => Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_content_audit WHERE entity='org_runtime_config' AND op='collect_session_policy'`)).rows[0]?.n ?? 0);
    const n0 = await count();
    await setSize({ max_mb: 2048, request_mb: 704 });
    await setSize({ max_mb: 2048, request_mb: 700 });
    const n1 = await count();
    chk("R7 크기 저장은 저장마다 감사에 남는다", n1 - n0 === 2, `${n0} → ${n1}`);
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
    //  cgroup v1 의 «무제한»(9223372036854771712) · 거대한 시간 — 지표는 비워도 끝(결과)은 남는다
    const r8 = id(8);
    const weird = { ...okSum, mem: { cgroupMax: "9223372036854771712", cgroupPeakMb: 500, container: null } };
    const res = await log.recordRunEnd({ runId: r8, member: B, exit: { ...okExit, durationMs: 9_000_000_000_000 }, summary: weird, by: "runner", startedAt: startedOf(8) });
    const row = await runRow(r8);
    chk("D8 INT 칸을 넘는 지표가 와도 끝은 남는다(그 지표만 비운다)", res?.outcome === "ok" && row?.outcome === "ok" && row.mem_limit_mb === null && row.duration_ms === "15000",
      JSON.stringify({ res, lim: row?.mem_limit_mb, dur: row?.duration_ms }));
  }
  {
    //  끝 기록이 먼저 행을 만들고(크기 실음) 시작 기록이 늦게 와도 — 끝이 적은 결과는 그대로, 빈 칸(모델)만 채운다
    const r9 = id(9);
    await log.recordRunEnd({ runId: r9, member: B, exit: okExit, summary: okSum, by: "runner", startedAt: startedOf(9), capMb: 1024, requestMb: 640 });
    await log.recordRunStart({ runId: r9, member: B, apps: ["Slack"], model: "haiku", capMb: 2048, requestMb: 900, startedAt: startedOf(9) });
    const row = await runRow(r9);
    chk("D9 끝 뒤에 온 시작 기록 — 결과·크기는 끝 것 그대로 · 모델만 채운다", row.outcome === "ok" && row.cap_mb === 1024 && row.request_mb === 640 && row.model === "haiku",
      JSON.stringify({ o: row.outcome, cap: row.cap_mb, req: row.request_mb, model: row.model }));
  }
  {
    //  끝 기록 없이 상한(1시간 + 3분)을 넘긴 판 — 지표가 «끝 신호를 못 받음» 으로 센다(도는 중으로 남아 실패율에서 빠지지 않게)
    const stale = "cr-" + new Date(now - 2 * 3600_000).toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-pgtstl";
    await log.recordRunStart({ runId: stale, member: B, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: new Date(now - 2 * 3600_000) });
    const v = await stats.handler({ days: 1, tz: "Asia/Seoul", recent: 200 }, ADMIN);
    const lost = v.stats.outcomes.find((o) => o.outcome === "lost")?.count ?? 0;
    const fresh = v.recent.find((x) => x.run_id === id(5));   // 방금 시작만 적은 판 — 아직 도는 중
    chk("D10 오래된 «도는 중» 은 끝 신호 못 받음으로 센다 · 방금 시작한 판은 도는 중", lost >= 1 && v.stats.running >= 1 && fresh && fresh.outcome === null,
      JSON.stringify({ lost, running: v.stats.running }));
  }
  {
    //  #4744 저장 결과의 «검색을 못 씀» 수가 목록 요약에 실린다(화면 «확인 필요» 의 이유).
    await itemsPool.query(`UPDATE collect_run SET ingest = $2::jsonb WHERE run_id = $1`,
      [r1, JSON.stringify({ state: "done", stored: 3, unsearched: 2, partial: true, per_unit: [{ unit_id: 1 }] })]);
    const v = await stats.handler({ days: 1, tz: "Asia/Seoul", recent: 200 }, ADMIN);
    const mine = v.recent.filter((x) => x.member_id === A || x.member_id === B);
    const a1 = v.recent.find((x) => x.run_id === r1);
    chk("S3 저장 결과 요약 — 검색을 못 쓴 단위 수(unsearched) · 확인 필요 · 단위 줄은 싣지 않는다",
      a1?.ingest?.unsearched === 2 && a1?.ingest?.partial === true && a1?.ingest?.stored === 3 && !("per_unit" in (a1?.ingest ?? {})), JSON.stringify(a1?.ingest));
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
