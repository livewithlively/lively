// #4427(#4213 T6) 구성원 Claude 커넥터 기록 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서(.github/workflows/test.yml), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/org/store/member-ai-connectors.pg-test.mjs
//
// 왜 이 계층인가: 판정이 전부 SQL 이다 — «목록에 없는 앱은 removed» 는 `NOT (app = ANY(…))` 한 줄, «상태가 바뀐 줄만
//  status_at 이 움직인다» 는 ON CONFLICT 의 CASE, «옛 관측은 버린다» 는 FOR UPDATE 뒤 비교, 중재자는 (tenant_id, …) 로 재작성된
//  PK 다. 목 풀로는 이 중 어느 것도 안 보인다. 그래서 반환값이 아니라 **read-back** 으로 판정한다.
//
//  엣지 표: R1 첫 기록 · R2 상태가 바뀐 줄만 status_at · R3 목록에 없는 앱 → removed(seen_at 보존) · R4 실패 확인은 앱 줄을
//   안 건드린다 · R5 옛 관측은 버린다 · R6 앱 필터(대소문자 무시 · removed 제외) · R7 끊었다 다시 연결 → first_seen 보존 ·
//   R8 정책(기본 허용 · 바뀔 때만 감사) · R9 수집 실행 0개 → 실패 · R10 확인 오케스트레이션(정책 꺼짐 · 15초 · 겹침 · 자리 부족) ·
//   R11 안내문 주입·관리 화면이 정책을 따른다 · R12 빈 전체 목록([])은 «하나도 없다»(전부 removed) ·
//   R13 정책 막음 → 수집 실행 403(자리를 띄우기 전) · R14 잃은 실행·시작 시각 모름 → 확인 줄을 덮지 않는다 ·
//   R15 «전부 사라짐» 은 두 번 연속일 때만 반영 · R16 앞날 관측 시각은 지금으로 · R17 비활성 구성원은 목록에서 빠진다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/org/store/member-ai-connectors.js`);
const pr = await import(`${DIST}/terminal/member-ai-connector-probe.js`);
const { previewMemberContext } = await import(`${DIST}/org/delivery/publish.js`);
const { sectionsPayload } = await import(`${DIST}/capabilities/delivery/org-content.js`);
const { MEMBER_AI_CONNECTORS_GUIDE } = await import(`${DIST}/org/delivery/knowledge-index.js`);
const { startCollectRun } = await import(`${DIST}/terminal/collect-run.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "__ac_pg_";
const M1 = `${P}m1`, M2 = `${P}m2`, M3 = `${P}m3`, M4 = `${P}m4`, M5 = `${P}m5`, M6 = `${P}m6`, M8 = `${P}m8`, M9 = `${P}m9`, M10 = `${P}m10`;
const ACTOR = `${P}actor`;
const at = (min) => new Date(Date.UTC(2026, 9, 16, 0, min, 0));
const T0 = at(0), T1 = at(1), T2 = at(2), T3 = at(3), T4 = at(4), T5 = at(5), T6 = at(6);
const iso = (d) => d.toISOString();
const S = (name, status) => ({ name, status });
const one = async (memberId, includeRemoved = true) => (await st.listMemberAiConnectors({ memberId, includeRemoved }))[0];
const byApp = (v) => Object.fromEntries((v?.connectors ?? []).map((c) => [c.app, c]));

//  정리는 접두어가 **정확히** 같은 줄만(LIKE 의 _ 는 아무 글자다) · 정책은 시험 전 값으로 되돌린다.
const ORIGINAL_POLICY = (await itemsPool.query(`SELECT allow_member_ai_connectors FROM org_runtime_config WHERE id=1`)).rows[0]?.allow_member_ai_connectors !== false;
async function cleanup() {
  await itemsPool.query(`DELETE FROM member_ai_connector WHERE left(member_id, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM member_ai_connector_scan WHERE left(member_id, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [M8]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE actor=$1`, [ACTOR]);
  await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors=$1 WHERE id=1`, [ORIGINAL_POLICY]);
}

try {
  await cleanup();
  await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors=TRUE WHERE id=1`);

  // R1 첫 기록 — 로컬 MCP 는 버리고 claude.ai 만. 세 시각이 모두 관측 시각.
  {
    const v = await st.recordMemberAiConnectors({ memberId: M1, origin: "probe", at: T1,
      servers: [S("claude.ai Slack", "connected"), S("claude.ai Notion", "needs-auth"), S("lively", "connected")] });
    const a = byApp(v);
    chk("R1 확인 줄 ok · connected 1", v.scan?.ok === true && v.scan.connected === 1 && v.scan.origin === "probe", JSON.stringify(v.scan));
    chk("R1 앱 줄 둘(로컬 MCP 없음)", Object.keys(a).sort().join(",") === "Notion,Slack", Object.keys(a).join(","));
    chk("R1 상태 · 세 시각 = 관측 시각", a.Slack.status === "connected" && a.Notion.status === "needs-auth"
      && [a.Slack.first_seen_at, a.Slack.seen_at, a.Slack.status_at].every((x) => x === iso(T1)), JSON.stringify(a.Slack));
  }

  // R2 상태가 바뀐 줄만 status_at 이 움직인다 · 새 앱은 first_seen = 이번
  {
    const v = await st.recordMemberAiConnectors({ memberId: M1, origin: "probe", at: T2,
      servers: [S("claude.ai Slack", "connected"), S("claude.ai Notion", "connected"), S("claude.ai Gmail", "connected")] });
    const a = byApp(v);
    chk("R2 안 바뀐 Slack 은 status_at 그대로", a.Slack.status_at === iso(T1) && a.Slack.seen_at === iso(T2), JSON.stringify(a.Slack));
    chk("R2 바뀐 Notion 은 status_at = 이번", a.Notion.status === "connected" && a.Notion.status_at === iso(T2), JSON.stringify(a.Notion));
    chk("R2 새 Gmail first_seen = 이번 · connected 3", a.Gmail.first_seen_at === iso(T2) && v.scan.connected === 3, JSON.stringify(a.Gmail));
  }

  // R3 목록에 없는 앱 → removed(status_at = 이번, seen_at 은 마지막으로 본 때 그대로) · 기본 조회에선 빠진다
  {
    await st.recordMemberAiConnectors({ memberId: M1, origin: "collect", at: T3, servers: [S("claude.ai Slack", "connected"), S("lively", "connected")] });
    const all = byApp(await one(M1, true)), live = byApp(await one(M1, false));
    chk("R3 Gmail·Notion removed · status_at = 이번 · seen_at 보존",
      all.Gmail.status === "removed" && all.Gmail.status_at === iso(T3) && all.Gmail.seen_at === iso(T2) && all.Notion.status === "removed", JSON.stringify(all.Gmail));
    chk("R3 기본 조회는 removed 를 뺀다", Object.keys(live).join(",") === "Slack", Object.keys(live).join(","));
    chk("R3 removed 줄의 origin 은 그걸 내린 확인", all.Gmail.origin === "collect", all.Gmail.origin);
  }

  // R4 목록을 못 얻은 확인은 앱 줄을 안 건드린다 · 확인 줄은 사유와 함께 · connected 는 지난 값
  {
    const v = await st.recordMemberAiConnectors({ memberId: M1, origin: "probe", at: T4, servers: null, error: "not-logged-in" });
    chk("R4 확인 줄 ok=false · 사유 · 시각", v.scan.ok === false && v.scan.error === "not-logged-in" && v.scan.scanned_at === iso(T4), JSON.stringify(v.scan));
    chk("R4 connected 는 지난 값(1)", v.scan.connected === 1, String(v.scan.connected));
    chk("R4 앱 줄 그대로(Slack connected, seen_at T3)", byApp(v).Slack.status === "connected" && byApp(v).Slack.seen_at === iso(T3), JSON.stringify(byApp(v).Slack));
  }

  // R5 옛 관측(마지막 확인보다 앞선 시각)은 버린다
  {
    await st.recordMemberAiConnectors({ memberId: M1, origin: "collect", at: T0, servers: [S("claude.ai Gmail", "connected"), S("lively", "connected")] });
    const v = await one(M1, true);
    chk("R5 확인 줄은 그대로(T4)", v.scan.scanned_at === iso(T4) && v.scan.ok === false, JSON.stringify(v.scan));
    chk("R5 Gmail 은 그대로 removed", byApp(v).Gmail.status === "removed", byApp(v).Gmail.status);
  }

  // R6 앱 필터 — 대소문자 무시 · 그 앱 줄이 있는 사람만 · removed 는 기본 제외
  {
    await st.recordMemberAiConnectors({ memberId: M2, origin: "probe", at: T1, servers: [S("claude.ai Slack", "needs-auth"), S("lively", "connected")] });
    const slack = await st.listMemberAiConnectors({ app: "slack" });
    const mine = slack.filter((m) => m.member_id.startsWith(P)).map((m) => m.member_id).sort();
    chk("R6 slack(소문자) → M1·M2", mine.join(",") === [M1, M2].sort().join(","), mine.join(","));
    chk("R6 필터 결과엔 그 앱 줄만", slack.filter((m) => m.member_id.startsWith(P)).every((m) => m.connectors.length === 1 && m.connectors[0].app === "Slack"));
    const gmail = (await st.listMemberAiConnectors({ app: "Gmail" })).filter((m) => m.member_id.startsWith(P));
    chk("R6 removed Gmail 은 기본 필터에서 빠진다", gmail.length === 0, JSON.stringify(gmail));
  }

  // R7 끊었다 다시 연결 → first_seen 은 처음 본 때 그대로, status_at = 이번
  {
    const v = await st.recordMemberAiConnectors({ memberId: M1, origin: "probe", at: T5,
      servers: [S("claude.ai Slack", "connected"), S("claude.ai Gmail", "connected"), S("lively", "connected")] });
    const g = byApp(v).Gmail;
    chk("R7 Gmail connected · first_seen T2 · status_at T5", g.status === "connected" && g.first_seen_at === iso(T2) && g.status_at === iso(T5), JSON.stringify(g));
  }

  // R12 빈 전체 목록([]) — «다 봤는데 하나도 없다» 다: 확인 줄 ok · connected 0 · 앱 줄 전부 removed
  {
    await st.recordMemberAiConnectors({ memberId: M2, origin: "probe", at: T2, servers: [S("claude.ai Slack", "connected")] });
    const v = await st.recordMemberAiConnectors({ memberId: M2, origin: "probe", at: T3, servers: [] });
    chk("R12 [] → ok · connected 0 · Slack removed", v.scan.ok === true && v.scan.connected === 0 && byApp(v).Slack.status === "removed", JSON.stringify(v));
  }

  // R8 정책 — 기본 허용 · 바뀔 때만 적고 감사에 남긴다
  {
    const audits = async () => (await itemsPool.query(
      `SELECT count(*)::int AS n FROM org_content_audit WHERE actor=$1 AND op='allow_member_ai_connectors'`, [ACTOR])).rows[0].n;
    chk("R8 기본 허용", (await st.memberAiConnectorsAllowed()) === true);
    const c1 = await st.setMemberAiConnectorsAllowed(false, { actor: ACTOR, source: "pgtest" });
    chk("R8 끄기 → changed · 읽기 false · 감사 1", c1 === true && (await st.memberAiConnectorsAllowed()) === false && (await audits()) === 1);
    const c2 = await st.setMemberAiConnectorsAllowed(false, { actor: ACTOR, source: "pgtest" });
    chk("R8 같은 값 → changed=false · 감사 그대로", c2 === false && (await audits()) === 1);
    await st.setMemberAiConnectorsAllowed(true, { actor: ACTOR, source: "pgtest" });
    chk("R8 켜기 → 허용 · 감사 2", (await st.memberAiConnectorsAllowed()) === true && (await audits()) === 2);
  }

  // R9 수집 실행 결과 — claude.ai 0개는 실패(앱 줄 보존) · 정상은 실행 시작 시각으로 적는다
  {
    await st.recordFromCollectSummary(M2, { claude: { version: "2.1.301" }, servers: [S("lively", "connected")] }, { error: "no-connector" }, T6.getTime());
    const v = await one(M2, true);
    chk("R9 0개 → ok=false · 러너 코드 · 앱 줄 그대로(R12 가 내린 removed 그대로)", v.scan.ok === false && v.scan.error === "no-connector" && byApp(v).Slack.status === "removed", JSON.stringify(v));
    await st.recordFromCollectSummary(M6, { claude: { version: "2.1.301" }, servers: [S("claude.ai Notion", "connected")] }, { error: null }, T3.getTime());
    const w = await one(M6, true);
    chk("R9 정상 → origin collect · 관측 시각 = 실행 시작", w.scan.origin === "collect" && w.scan.scanned_at === iso(T3) && byApp(w).Notion.status === "connected", JSON.stringify(w));
  }

  // R14 잃은 실행(요약 없음) · 시작 시각을 모르는 끝은 확인 줄을 덮지 않는다
  {
    const before = JSON.stringify((await one(M6, true)).scan);
    await st.recordFromCollectSummary(M6, null, { error: "lost" }, Date.now());
    await st.recordFromCollectSummary(M6, { claude: { version: "2.1.301" }, servers: [S("claude.ai Notion", "needs-auth")] }, { error: null }, null);
    chk("R14 잃은 실행 · 시작 시각 모름 → 확인 줄 그대로", JSON.stringify((await one(M6, true)).scan) === before, before);
  }

  // R16 앞날 관측 시각은 지금으로 깎는다(안 깎으면 그 뒤 모든 확인이 «옛 관측» 으로 버려진다)
  {
    const future = new Date(Date.now() + 86_400_000);
    const v = await st.recordMemberAiConnectors({ memberId: M9, origin: "probe", at: future, servers: [S("claude.ai Slack", "connected")] });
    chk("R16 scanned_at ≤ 지금", Date.parse(v.scan.scanned_at) <= Date.now(), v.scan.scanned_at);
    const w = await st.recordMemberAiConnectors({ memberId: M9, origin: "probe", servers: [S("claude.ai Slack", "needs-auth")] });
    chk("R16 바로 다음 확인이 버려지지 않는다", byApp(w).Slack.status === "needs-auth", JSON.stringify(byApp(w).Slack));
  }

  // R17 비활성 구성원은 목록에서 빠진다(줄은 남는다)
  {
    await itemsPool.query(
      `INSERT INTO org_member(id, kind, display_name, email, state, scopes) VALUES($1,'human','커넥터시험','__ac_pg_m8@example.invalid','inactive','[]'::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE SET state='inactive'`, [M8]);
    await st.recordMemberAiConnectors({ memberId: M8, origin: "probe", servers: [S("claude.ai Slack", "connected")] });
    const all = (await st.listMemberAiConnectors({})).map((m) => m.member_id);
    const slack = (await st.listMemberAiConnectors({ app: "Slack" })).map((m) => m.member_id);
    chk("R17 비활성 → 전체·앱 필터 모두에서 빠진다", !all.includes(M8) && !slack.includes(M8), JSON.stringify({ all: all.filter((x) => x.startsWith(P)), slack }));
    const rows = (await itemsPool.query(`SELECT count(*)::int AS n FROM member_ai_connector WHERE member_id=$1`, [M8])).rows[0].n;
    chk("R17 줄은 지우지 않는다", rows === 1, String(rows));
  }

  // R10 확인 오케스트레이션 — 진짜 자리 대신 run 을 갈아 끼운다(무엇이 불렸나를 센다)
  {
    pr._resetProbeStateForTest();
    const OUT = '@@auth\n{"loggedIn":true,"authMethod":"claude.ai","email":"x@example.invalid"}\n\n@@list\n'
      + "claude.ai Slack: https://p.example.invalid - ✔ Connected\nclaude.ai Google Drive: https://p.example.invalid - ! Needs authentication\n"
      + "lively: /bin/lively mcp - ✔ Connected\n@@exit 0\n";
    const calls = [];
    const run = async (_u, _os, script) => { calls.push(script); return OUT; };
    const u3 = { userId: M3, email: "", scopes: [], projects: [] };
    let clock = 1_000_000;
    const r1 = await pr.probeMemberAiConnectors(u3, { run, now: () => clock });
    chk("R10 정상 → probed · Drive needs-auth · origin probe", r1.probed === true && r1.skipped === null
      && byApp(r1.record)["Google Drive"]?.status === "needs-auth" && r1.record.scan.origin === "probe", JSON.stringify(r1));
    chk("R10 실제로 auth 다음 mcp list 스크립트를 한 번 넘겼다", calls.length === 1 && calls[0].indexOf("auth status") < calls[0].indexOf("mcp list"), String(calls.length));
    chk("R10 이메일은 기록에 없다", !JSON.stringify(r1.record).includes("x@example.invalid"));
    clock += 5_000;
    const r2 = await pr.probeMemberAiConnectors(u3, { run, now: () => clock });
    chk("R10 15초 안 재요청 → recent · run 안 부름", r2.skipped === "recent" && calls.length === 1, `${r2.skipped} ${calls.length}`);
    // 겹친 요청은 한 번만 돈다
    const u5 = { userId: M5, email: "", scopes: [], projects: [] };
    let release;
    const slow = (_u, _os, script) => { calls.push(script); return new Promise((res) => { release = () => res(OUT); }); };
    const pA = pr.probeMemberAiConnectors(u5, { run: slow, now: () => clock });
    const pB = pr.probeMemberAiConnectors(u5, { run: slow, now: () => clock });
    //  release 가 생길 때까지(앞의 DB 조회가 끝나 run 이 불릴 때까지) 기다린다 — 고정 대기는 느린 DB 에서 흔들린다.
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 25));
    chk("R10 겹침 시험의 run 이 불렸다(관측 장치)", typeof release === "function");
    release();
    const [a, b] = await Promise.all([pA, pB]);
    chk("R10 겹친 두 요청 → run 한 번 · 같은 결과", calls.length === 2 && a === b, String(calls.length));
    // 자리 부족(브로커 400 LVLY_NODE_CAPACITY) → 던지지 않고 사유로 남긴다
    const u4 = { userId: M4, email: "", scopes: [], projects: [] };
    const r4 = await pr.probeMemberAiConnectors(u4, { run: async () => { throw new Error("400 LVLY_NODE_CAPACITY no room"); }, now: () => clock });
    chk("R10 자리 부족 → scan.ok=false · no-capacity", r4.probed === true && r4.record.scan?.ok === false && r4.record.scan.error === "no-capacity", JSON.stringify(r4.record.scan));
    // 정책 꺼짐 → 재지 않는다(새 사람이라 recent 가 아니다)
    await st.setMemberAiConnectorsAllowed(false, { actor: ACTOR, source: "pgtest" });
    const u6 = { userId: `${P}m7`, email: "", scopes: [], projects: [] };
    const before = calls.length;
    const r6 = await pr.probeMemberAiConnectors(u6, { run, now: () => clock + 60_000 });
    chk("R10 정책 꺼짐 → policy-off · run 안 부름 · 확인 줄 없음", r6.skipped === "policy-off" && calls.length === before && r6.record.scan === null, JSON.stringify(r6));
    await st.setMemberAiConnectorsAllowed(true, { actor: ACTOR, source: "pgtest" });
  }

  // R15 «원래 있던 커넥터가 전부 사라짐» 은 두 번 연속일 때만 반영한다(로그인 풀림과 모양이 같다)
  {
    pr._resetProbeStateForTest();
    await st.recordMemberAiConnectors({ memberId: M10, origin: "probe", at: T1, servers: [S("claude.ai Slack", "connected"), S("claude.ai Gmail", "connected")] });
    const EMPTY_OUT = '@@auth\n{"loggedIn":true,"authMethod":"claude.ai"}\n\n@@list\nChecking MCP server health…\n\n@@exit 0\n';
    const u10 = { userId: M10, email: "", scopes: [], projects: [] };
    let clk = 5_000_000;
    const a = await pr.probeMemberAiConnectors(u10, { run: async () => EMPTY_OUT, now: () => clk });
    chk("R15 첫 번째 → 미확정 · 앱 줄 그대로", a.record.scan.ok === false && a.record.scan.error === "unconfirmed-empty"
      && byApp(a.record).Slack.status === "connected" && byApp(a.record).Gmail.status === "connected", JSON.stringify(a.record));
    clk += 20_000;
    const b = await pr.probeMemberAiConnectors(u10, { run: async () => EMPTY_OUT, now: () => clk });
    chk("R15 두 번째 → 반영(전부 removed · ok · connected 0)", b.record.scan.ok === true && b.record.scan.connected === 0
      && byApp(b.record).Slack.status === "removed" && byApp(b.record).Gmail.status === "removed", JSON.stringify(b.record));
  }

  // R13 정책 막음 → 수집 실행은 자리를 띄우기 전에 403 으로 거절한다
  {
    await st.setMemberAiConnectorsAllowed(false, { actor: ACTOR, source: "pgtest" });
    let status = null;
    try { await startCollectRun({ userId: `${P}m11`, email: "", scopes: ["memory"], projects: [] }); }
    catch (e) { status = e?.status ?? e?.statusCode ?? null; }
    chk("R13 막음 → 403", status === 403, String(status));
    await st.setMemberAiConnectorsAllowed(true, { actor: ACTOR, source: "pgtest" });
  }

  // R11 안내문 — 라이브 주입(previewMemberContext)과 관리 화면(sectionsPayload)이 정책을 따른다
  {
    const ctxOn = await previewMemberContext("PG");
    chk("R11 허용 → 주입에 허용 줄", ctxOn.includes(MEMBER_AI_CONNECTORS_GUIDE.allowed) && !ctxOn.includes(MEMBER_AI_CONNECTORS_GUIDE.blocked));
    await st.setMemberAiConnectorsAllowed(false, { actor: ACTOR, source: "pgtest" });
    const ctxOff = await previewMemberContext("PG");
    chk("R11 막음 → 주입에 막음 줄 · 허용 줄 없음", ctxOff.includes(MEMBER_AI_CONNECTORS_GUIDE.blocked) && !ctxOff.includes(MEMBER_AI_CONNECTORS_GUIDE.allowed));
    chk("R11 주입에 자리 문자열이 안 남는다", !ctxOff.includes("${member_ai_connectors}"));
    const sp = await sectionsPayload();
    const body = sp.sections["context-ontology-guide"]?.body_md || "";
    chk("R11 관리 화면 본문도 막음 줄(화면 = 주입)", body.includes(MEMBER_AI_CONNECTORS_GUIDE.blocked) && !body.includes("${member_ai_connectors}"));
    await st.setMemberAiConnectorsAllowed(true, { actor: ACTOR, source: "pgtest" });
  }
} catch (e) {
  bad("예외", e && e.stack ? e.stack : String(e));
} finally {
  await cleanup().catch((e) => bad("정리", String(e)));
  await itemsPool.end().catch(() => undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
