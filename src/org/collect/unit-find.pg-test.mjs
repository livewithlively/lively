// 검색 실패 보조 안내 · 단위 찾기(#4213 T12 #4744) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/collect/unit-find.pg-test.mjs
//
// 왜 이 계층인가: 이 기능의 약속은 **누구에게 무엇을 보이나**다 — «가져올 곳» 은 질문한 사람이 다 보는 단위만(남의 비공개 단위 이름·설명이
//  새지 않게 — 설계 §6-3 필수 조건) · 모으지 않기로 한 단위는 권하지 않는다 · 지식이 강하면 안내가 안 붙는다 · 원문 자료가 있으면 그것이 먼저 ·
//  구성원 Claude 커넥터를 막은 워크스페이스는 단위를 싣지 않는다. 판정(순수)은 unit-find-plan.test.ts.
//  pgvector 가 있으면(CI) 가짜 임베딩 서버를 띄워 **뜻으로** 맞추는 길(단위 설명 벡터 · 지식 의미 거리)까지 잰다 — 없으면 그 행만 건너뛴다.
import http from "node:http";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/collect/unit-store.js`);
const { findUnitsFor, collectHintFor } = await import(`${DIST}/org/collect/unit-find.js`);
const { knowledgeSearch } = await import(`${DIST}/capabilities/knowledge/read.js`);
const { collectUnitCapabilities } = await import(`${DIST}/capabilities/collect-units.js`);
const { invalidateSourceVisRules } = await import(`${DIST}/v6/source-vis-policy.js`);
const { visAxes, setVisAxes } = await import(`${DIST}/v6/visibility-axes.js`);
const { __resetQueryEmbedCache } = await import(`${DIST}/v6/search-util.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const skip = (n, why) => console.log(`skip ${n} — ${why}`);

const A = "__ci_find_a__", B = "__ci_find_b__", C = "__ci_find_c__", ADM = "__ci_find_adm__";
const MEMBERS = [A, B, C, ADM];
const TEAM = "T_CIFIND";
const CH = (n) => `C0CIFND${String(n).padStart(3, "0")}`;
const KN = "ci-find-4744-knowledge";
const SRC = "ci-find-4744-source";
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const iso = (ms) => new Date(ms).toISOString();

const unitBy = async (ref) => (await itemsPool.query(`SELECT * FROM collect_unit WHERE app='slack' AND instance=$1 AND ref=$2`, [TEAM, ref])).rows[0];
async function makeUnit(ref, name, member, o = {}) {
  await store.recordUnitListing({ member, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref, kind: "channel", name }], verified: o.verified !== false });
  const u = await unitBy(ref);
  await itemsPool.query(`UPDATE collect_unit SET state=$2, description=$3, read_at=$4, route=$5 WHERE id=$1`,
    [u.id, o.state ?? "active", o.description ?? null, o.read_at ?? null, o.route ?? "member_ai"]);
  return unitBy(ref);
}
async function cleanup() {
  await itemsPool.query(`DELETE FROM collect_unit WHERE app='slack' AND (instance=$1 OR ref LIKE 'C0CIFND%')`, [TEAM]);
  await itemsPool.query(`DELETE FROM member_ai_connector WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name = $1`, [KN]);
  await itemsPool.query(`DELETE FROM source WHERE name = $1 OR (name LIKE $2)`, [SRC, `${SRC}-%`]);
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [MEMBERS]);
}
const handler = (name) => (name === "knowledge_search" ? knowledgeSearch : collectUnitCapabilities.find((c) => c.name === name)).handler;
const userOf = (m, admin = false) => ({ userId: m, email: `${m}@cifind.test`, scopes: admin ? ["memory", "admin"] : ["memory"], projects: ["*"] });

let policyBefore = null, embedBefore, axesBefore = null;
try {
  await cleanup();
  for (const m of MEMBERS) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@cifind.test`]);
  policyBefore = (await itemsPool.query(`SELECT allow_member_ai_connectors FROM org_runtime_config WHERE id=1`)).rows[0]?.allow_member_ai_connectors ?? null;
  await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors = true WHERE id=1`);
  //  자료 공개범위 축을 켠다(H4 — 잠긴 자료가 남에게 안 보이나). 앞 시험이 꺼 두고 갔을 수 있다. 끝나면 되돌린다.
  axesBefore = await visAxes();
  await setVisAxes({ source: true });
  invalidateSourceVisRules();

  const u1 = await makeUnit(CH(1), "#결제-출시", A, { description: "결제 기능 출시 일정과 버그를 정한다", read_at: iso(NOW - 2 * 3600_000) });
  await store.recordUnitListing({ member: B, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: CH(1), kind: "channel", name: "#결제-출시" }], verified: false });
  const u2 = await makeUnit(CH(2), "#채용", A, { description: "채용 공고와 면접 일정" });
  const u3 = await makeUnit(CH(3), "#결제-잡담", A, { description: "결제 잡담", state: "excluded" });
  const u4 = await makeUnit(CH(4), "#결제-알림", C, { description: "결제 알림 봇", route: "lively_collector" });
  const u5 = await makeUnit(CH(5), "#결제-비밀", C, { description: "결제 출시 비밀 논의" });
  const u6 = await makeUnit(CH(6), "#결제-후보", A, { description: "결제 출시 후보 채널", state: "candidate" });
  //  C 가 «나만» 으로 모으는 채널 — A 도 그 채널을 보는 확인된 구성원이다(자료는 A 에게 안 보인다).
  const u7 = await makeUnit(CH(7), "#결제-나만", C, { description: "결제 출시 나만 메모" });
  await store.recordUnitListing({ member: A, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: CH(7), kind: "channel", name: "#결제-나만" }], verified: true });
  await itemsPool.query(`UPDATE collect_unit SET visibility = 'me', owner_member = $2 WHERE id = $1`, [u7.id, C]);
  await itemsPool.query(`INSERT INTO member_ai_connector(member_id, provider, app, status, origin) VALUES($1,'claude','Slack','connected','probe')`, [A]);

  // ── F1~F4 단위 찾기 — 누가 무엇을 보나 ──
  {
    const r = await findUnitsFor({ member: A, isAdmin: false }, "결제 출시 일정", { now: NOW });
    const ids = r.map((x) => x.id);
    const p1 = r.find((x) => x.id === u1.id);
    chk("F1 다 보는 단위만 · 맞는 것만 — #결제-출시(낱말 셋 다)·#결제-후보(아직 안 모은 곳도 «가져올 곳») · 모으지 않기로 한 곳·남의 비공개·수집기 단위(관리자 아님)·안 맞는 곳은 없다",
      ids.includes(u1.id) && ids.includes(u6.id) && !ids.includes(u3.id) && !ids.includes(u5.id) && !ids.includes(u4.id) && !ids.includes(u2.id)
        && ids[0] === u1.id,
      JSON.stringify(r.map((x) => [x.name, x.match])));
    chk("F2 한 줄 — 커넥터 이름 · 경로 · 마지막 수집 시각 · 내 커넥터 상태 · 맞은 까닭 · 사람 말 안내",
      p1 && p1.connector === "Slack" && p1.route === "member_ai" && p1.last_collected_at === iso(NOW - 2 * 3600_000) && p1.my_connector === "connected"
        && p1.match.by === "text" && p1.match.score === 0.9 && /^2시간 전 수집했습니다/.test(p1.hint)
        && /^아직 모으지 않는 곳입니다/.test(r.find((x) => x.id === u6.id)?.hint ?? ""),
      JSON.stringify(p1));
    const rb = await findUnitsFor({ member: B, isAdmin: false }, "결제 출시 일정", { now: NOW });
    chk("F3 신고만 한 사람(B — 확인 안 됨)에게는 그 단위의 이름·설명도 안 나온다", rb.length === 0, JSON.stringify(rb));
    const ra = await findUnitsFor({ member: ADM, isAdmin: true }, "결제 알림", { now: NOW });
    const rc = await findUnitsFor({ member: C, isAdmin: false }, "결제 알림", { now: NOW });
    chk("F4 관리자라도 확인된 구성원이 아닌 단위(수집기 단위 포함)는 안 나온다 · 확인된 구성원(C)에게는 나온다(principal v2)",
      ra.length === 0 && rc.some((x) => x.id === u4.id), JSON.stringify({ adm: ra.map((x) => x.name), c: rc.map((x) => x.name) }));
    const r7 = await findUnitsFor({ member: A, isAdmin: false }, "결제 출시 나만", { now: NOW });
    const p7 = r7.find((x) => x.id === u7.id);
    chk("F6 남이 «나만» 으로 모으는 곳 — 그 채널을 보는 사람에게는 나오되 «N 전 수집» 이 아니라 «다른 사람만 보도록 모으는 곳» 으로",
      !!p7 && /^다른 사람만 보도록 모으는 곳입니다/.test(p7.hint), JSON.stringify(r7.map((x) => [x.name, x.hint])));
    const none = await findUnitsFor({ member: A, isAdmin: false }, "분기 재무 보고서", { now: NOW });
    chk("F5 맞는 단위가 없으면 빈 목록(아무 단위나 권하지 않는다)", none.length === 0, JSON.stringify(none.map((x) => x.name)));
  }

  // ── H1~H5 가져올 곳 — 지식 → 원문 자료 → 단위 ──
  {
    await itemsPool.query(`INSERT INTO knowledge(name, title, body_md, provenance, injection) VALUES($1,$2,$3,'authored','recalled')`,
      [KN, "결제 출시 일정", "결제 출시 일정은 11월 둘째 주로 정했다."]);
    const strong = await collectHintFor({ q: "결제 출시 일정", names: [KN], member: A, isAdmin: false, viewer: A, now: NOW });
    chk("H1 낱말이 다 든 지식이 있으면 안내가 안 붙는다(null)", strong === null, JSON.stringify(strong));
    const particles = await collectHintFor({ q: "결제의 출시 일정은 어떻게 돼", names: [KN], member: A, isAdmin: false, now: NOW });
    chk("H1b 조사가 붙은 자연어 질의도 조사를 떼고 낱말을 맞춘다(knowledge_grep plain 규칙) — 안내가 안 붙는다", particles === null, JSON.stringify(particles));
    const asked = await collectHintFor({ q: "출시 일정?", names: [KN], member: A, isAdmin: false, now: NOW });
    chk("H1c 질의 끝의 물음표는 떼고 맞춘다(«일정?» → «일정») — 안내가 안 붙는다", asked === null, JSON.stringify(asked));
    const most = await collectHintFor({ q: "결제 출시 일정 변경", names: [KN], member: A, isAdmin: false, now: NOW });
    const few = await collectHintFor({ q: "결제 변경 취소 사유", names: [KN], member: A, isAdmin: false, now: NOW });
    chk("H1d 낱말이 셋 이상이면 하나 빼고 다 든 지식이 있으면 강하다(«변경» 하나 없음 → 안내 없음) · 하나만 맞으면 약하다",
      most === null && few?.reason === "weak", JSON.stringify({ most, few: few && { reason: few.reason, note: few.note } }));
    await itemsPool.query(`INSERT INTO source(name, kind, title, body_md, provenance) VALUES($1,'doc',$2,$3,'observed')`,
      [SRC, "결제 출시 회의록", "결제 기능 출시를 11월로 미루자는 의견"]);
    //  이미 지식이 된 자료(knowledge_source 로 묶임)는 «아직 지식이 안 된 원문 자료» 가 아니다.
    await itemsPool.query(`INSERT INTO source(name, kind, title, body_md, provenance) VALUES($1,'doc',$2,$3,'observed')`,
      [`${SRC}-distilled`, "결제 출시 연기 결정", "결제 출시 연기 사유 정리"]);
    const did = (await itemsPool.query(`SELECT id FROM source WHERE name=$1`, [`${SRC}-distilled`])).rows[0].id;
    await itemsPool.query(`INSERT INTO knowledge_source(name, source_id) VALUES($1,$2)`, [KN, did]);
    const withSrc = await collectHintFor({ q: "결제 출시 연기 사유", names: [], member: A, isAdmin: false, viewer: A, now: NOW });
    chk("H2 지식이 없고 아직 지식이 안 된 원문 자료에 낱말 절반 이상이 든 것이 있으면 그 자료(단위는 아직 안 싣는다) · 지식이 된 자료는 빠진다",
      withSrc?.reason === "empty" && withSrc.sources?.some((s) => s.title === "결제 출시 회의록") && !withSrc.sources.some((s) => s.id === did) && !withSrc.units,
      JSON.stringify(withSrc));
    const toUnits = await collectHintFor({ q: "결제 롤아웃 날짜 확정", names: [], member: A, isAdmin: false, viewer: A, now: NOW });
    chk("H3 원문 자료에도 없으면 질문한 사람이 다 보는 단위(«결제» 가 든 #결제-출시 · #결제-후보) · 남의 비공개·제외 단위는 없다",
      toUnits?.units?.some((x) => x.id === u1.id) && !toUnits.units.some((x) => [u3.id, u5.id, u4.id].includes(x.id)) && !toUnits.sources,
      JSON.stringify(toUnits));
    //  자료 공개범위 — C 만 보는 원문 자료는 A 의 «원문 자료» 로 안 나온다(축이 켜져 있을 때).
    await itemsPool.query(`INSERT INTO source(name, kind, title, body_md, provenance, visibility) VALUES($1,'doc',$2,$3,'observed','members')`,
      [`${SRC}-locked`, "롤아웃 날짜 확정 메모", "결제 롤아웃 날짜 확정 메모(C 만)"]);
    const sid = (await itemsPool.query(`SELECT id FROM source WHERE name=$1`, [`${SRC}-locked`])).rows[0].id;
    await itemsPool.query(`INSERT INTO source_member(source_id, subject_kind, member_id) VALUES($1,'member',$2)`, [sid, C]);
    const locked = await collectHintFor({ q: "결제 롤아웃 날짜 확정", names: [], member: A, isAdmin: false, viewer: A, now: NOW });
    const forC = await collectHintFor({ q: "결제 롤아웃 날짜 확정", names: [], member: C, isAdmin: false, viewer: C, now: NOW });
    chk("H4 원문 자료도 질문한 사람의 공개범위대로 — C 만 보는 메모는 A 에게 안 나오고 C 에게는 나온다",
      !(locked?.sources ?? []).some((s) => s.id === sid) && (forC?.sources ?? []).some((s) => s.id === sid),
      JSON.stringify({ a: locked?.sources, c: forC?.sources }));
    await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors = false WHERE id=1`);
    const blocked = await collectHintFor({ q: "결제 롤아웃 날짜 확정", names: [], member: A, isAdmin: false, viewer: A, now: NOW });
    await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors = true WHERE id=1`);
    chk("H5 구성원 Claude 커넥터를 막은 워크스페이스는 «그 커넥터로 직접» 을 권하지 않는다 — 단위 없이 안내만",
      blocked && !blocked.units && blocked.reason === "empty", JSON.stringify(blocked));
    //  원문 자료 찾기가 시간 상한에 걸리면(다른 일이 표를 잠갔다) «원문 자료에도 없다» 고 단정하지 않는다 — 단위는 그대로 싣는다.
    const locker = await itemsPool.connect();
    let slow = null, ms = 0;
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE knowledge_source IN ACCESS EXCLUSIVE MODE");
      const t0 = Date.now();
      slow = await collectHintFor({ q: "결제 롤아웃 날짜 확정", names: [], member: A, isAdmin: false, now: NOW });
      ms = Date.now() - t0;
    } finally {
      await locker.query("ROLLBACK").catch(() => {});
      locker.release();
    }
    chk("H6 원문 자료 찾기가 시간 상한에 걸리면 «원문 자료에도 없다» 고 하지 않는다(sources_checked false) · 단위는 그대로 · 상한(1.2초) 무렵 끝난다",
      slow?.sources_checked === false && /찾아보지 못했습니다/.test(slow.note) && !/원문 자료에 맞는 것이 없습니다|원문 자료에도 맞는 것이 없습니다/.test(slow.note)
        && (slow.units ?? []).some((x) => x.id === u1.id) && ms >= 1000 && ms < 5000,
      JSON.stringify({ ms, slow: slow && { sources_checked: slow.sources_checked, note: slow.note, units: slow.units?.map((x) => x.name) } }));
    const lateHint = await collectHintFor({ q: "결제 롤아웃 날짜 확정", names: [], member: A, isAdmin: false, now: NOW, deadline: Date.now() - 1 });
    chk("H7 마감 시각이 지났으면 더 묻지 않는다(null — 부르는 쪽이 이미 검색 결과만 돌려줬다)", lateHint === null, JSON.stringify(lateHint));
  }

  // ── S1·S2 표면 — knowledge_search 의 collect_hint · collect_unit_find ──
  {
    const res = await handler("knowledge_search")({ q: "결제 롤아웃 날짜 확정" }, userOf(A), { source: "mcp", viewer: A });
    chk("S1 knowledge_search — 약하면 응답에 collect_hint(단위) · 강하면 없다",
      Array.isArray(res.entries) && res.collect_hint?.units?.some((x) => x.id === u1.id), JSON.stringify({ n: res.entries?.length, hint: res.collect_hint }));
    const strong = await handler("knowledge_search")({ q: "결제 출시 일정" }, userOf(A), { source: "mcp", viewer: A });
    chk("S1b 낱말이 다 든 지식이 결과에 있으면 collect_hint 가 없다", strong.entries?.some((e) => e.name === KN) && !strong.collect_hint,
      JSON.stringify({ names: strong.entries?.map((e) => e.name), hint: strong.collect_hint }));
    const web = await handler("knowledge_search")({ q: "결제 롤아웃 날짜 확정" }, userOf(A), { source: "web", viewer: A });
    const script = await handler("knowledge_search")({ q: "결제 롤아웃 날짜 확정" }, userOf(A), { source: "web", session: "box-ci-find-1", viewer: A });
    const mcp = await handler("knowledge_search")({ q: "결제 롤아웃 날짜 확정" }, userOf(A), { source: "mcp", viewer: A });
    chk("S1c 웹 화면의 의미검색(세션 헤더 없는 REST)에는 안내를 계산하지 않는다 · 세션이 부른 REST·MCP 에는 붙는다",
      !web.collect_hint && !!script.collect_hint?.units?.length && !!mcp.collect_hint?.units?.length,
      JSON.stringify({ web: !!web.collect_hint, script: !!script.collect_hint, mcp: !!mcp.collect_hint }));
    //  앱 화면 다리(열람 신원이 실리지 않는 app-ui · app-front)에는 계산하지 않는다 · 특권 열람 신원(null)으로 불러도 안내는 그 사람 것으로만.
    const appUi = await handler("knowledge_search")({ q: "결제 롤아웃 날짜 확정" }, userOf(A), { source: "app-ui", actor: A });
    const appFront = await handler("knowledge_search")({ q: "결제 롤아웃 날짜 확정" }, userOf(A), { source: "app-front", actor: A });
    const priv = await handler("knowledge_search")({ q: "롤아웃 날짜 확정 메모" }, userOf(A), { source: "mcp", viewer: null });
    const lockedId = (await itemsPool.query(`SELECT id FROM source WHERE name=$1`, [`${SRC}-locked`])).rows[0].id;
    const viaApp = await handler("knowledge_search")({ q: "결제 롤아웃 날짜 확정" }, { ...userOf(A), appId: "app-ci-find" }, { source: "mcp", viewer: A });
    chk("S1e 앱 세션 토큰(appId)으로 들어온 MCP 에는 안내를 안 붙인다(앱 동의 경계)", !viaApp.collect_hint && Array.isArray(viaApp.entries),
      JSON.stringify(Object.keys(viaApp)));
    chk("S1d 앱 화면 다리에는 안내를 안 붙인다 · 특권 열람 신원(null)으로 불러도 안내의 원문 자료는 그 사람 공개범위대로(C 만 보는 메모가 안 나온다)",
      !appUi.collect_hint && !appFront.collect_hint && !(priv.collect_hint?.sources ?? []).some((x) => x.id === lockedId),
      JSON.stringify({ appUi: !!appUi.collect_hint, appFront: !!appFront.collect_hint, priv: priv.collect_hint }));
    const f = await handler("collect_unit_find")({ q: "결제 출시 일정", limit: 1 }, userOf(A), { viewer: A });
    const fb = await handler("collect_unit_find")({ q: "결제 출시 일정" }, userOf(B), { viewer: B });
    chk("S2 collect_unit_find — 부르는 사람이 다 보는 단위만 · limit · 정책 상태를 싣는다",
      f.count === 1 && f.units[0].id === u1.id && f.member_ai_connectors === "allowed" && fb.count === 0, JSON.stringify({ f, fb }));
    await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors = false WHERE id=1`);
    const fBlocked = await handler("collect_unit_find")({ q: "결제 출시 일정", limit: 1 }, userOf(A), { viewer: A });
    await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors = true WHERE id=1`);
    chk("S2b 막은 워크스페이스 — 단위 찾기는 되지만 줄마다의 안내가 «그 커넥터로 직접» 이 아니라 조직 연결(ext__)로",
      fBlocked.member_ai_connectors === "blocked" && fBlocked.units[0]?.id === u1.id && /조직 연결\(ext__\)/.test(fBlocked.units[0]?.hint ?? "")
        && !/이 커넥터로 직접/.test(fBlocked.units[0]?.hint ?? ""), JSON.stringify(fBlocked.units));
  }

  // ── V1~V3 뜻으로 맞추기(pgvector 가 있을 때) — 가짜 임베딩 서버 ──
  {
    const col = (await itemsPool.query(
      `SELECT a.atttypmod AS dim FROM pg_attribute a WHERE a.attrelid = to_regclass('collect_unit') AND a.attname = 'embedding_vector' AND NOT a.attisdropped`)).rows[0];
    if (!col) {
      skip("V1~V3", "collect_unit.embedding_vector 칸이 없다(pgvector 없는 DB) — CI(pgvector)에서 돈다");
    } else {
      const DIM = Number(col.dim);
      //  낱말 → 축. «결제/payment» 0 · «출시/launch» 1 · «채용/hiring» 2 · 바탕 3(0 벡터를 피한다).
      const vec = (t) => {
        const s = String(t).toLowerCase();
        const v = new Array(DIM).fill(0);
        if (/결제|payment/.test(s)) v[0] = 1;
        if (/출시|launch/.test(s)) v[1] = 1;
        if (/채용|hiring|recruit/.test(s)) v[2] = 1;
        v[3] = 0.1;
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      };
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; }).on("end", () => {
          const j = JSON.parse(body || "{}");
          const input = Array.isArray(j.input) ? j.input : [j.input];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vec(t) })) }));
        });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port;
      embedBefore = (await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`)).rows[0]?.embedding_config ?? null;
      try {
        await itemsPool.query(`UPDATE org_runtime_config SET embedding_config = $1::jsonb WHERE id=1`,
          [JSON.stringify({ provider: "http", base_url: `http://127.0.0.1:${port}`, model: "ci-fake", dimensions: DIM })]);
        __resetQueryEmbedCache();
        const bf = await import(`${DIST}/v6/embedding-backfill.js`);
        const { started, job } = bf.startBackfillJob("pending", bf.COLLECT_UNIT_TARGET);
        while (started && job.running) await new Promise((r) => setTimeout(r, 100));
        const filled = (await itemsPool.query(`SELECT count(*)::int AS n FROM collect_unit WHERE ref LIKE 'C0CIFND%' AND embedding_vector IS NOT NULL`)).rows[0].n;
        const excludedFilled = (await itemsPool.query(`SELECT embedding_vector IS NOT NULL AS f FROM collect_unit WHERE id=$1`, [u3.id])).rows[0].f;
        chk("V1 백필이 단위 설명 벡터를 채운다(모으지 않기로 한 단위는 대상이 아니다)", filled >= 5 && excludedFilled === false,
          JSON.stringify({ filled, excludedFilled, job }));
        //  영어 질의 «hiring plan» — 낱말은 하나도 안 맞지만 뜻(채용)으로 #채용 이 맞는다.
        const r = await findUnitsFor({ member: A, isAdmin: false }, "hiring plan", { now: NOW });
        chk("V2 낱말이 안 맞아도 설명의 뜻이 가까우면 맞는다(by vector)", r[0]?.id === u2.id && r[0].match.by === "vector" && r[0].match.score > 0.9,
          JSON.stringify(r.map((x) => [x.name, x.match])));
        //  모델을 바꿨는데 옛 벡터가 남았다 — 다른 모델의 벡터와는 재지 않는다(낱말로만 맞춘다 → «hiring plan» 은 안 맞는다).
        await itemsPool.query(`UPDATE collect_unit SET embedding_model = 'old-model' WHERE id = $1`, [u2.id]);
        const stale = await findUnitsFor({ member: A, isAdmin: false }, "hiring plan", { now: NOW });
        await itemsPool.query(`UPDATE collect_unit SET embedding_model = 'ci-fake' WHERE id = $1`, [u2.id]);
        chk("V2b 지금 모델이 아닌 옛 벡터와는 재지 않는다", !stale.some((x) => x.id === u2.id), JSON.stringify(stale.map((x) => [x.name, x.match])));
        //  지식의 의미 거리 — 지식 벡터를 채우고, 뜻이 먼 질의는 약함(collect_hint) · 가까운 질의는 강함.
        const kj = bf.startBackfillJob("pending", bf.KNOWLEDGE_TARGET);
        while (kj.started && kj.job.running) await new Promise((r2) => setTimeout(r2, 100));
        const far = await collectHintFor({ q: "recruit pipeline", names: [KN], member: A, isAdmin: false, viewer: A, now: NOW });
        const near = await collectHintFor({ q: "payment launch timeline", names: [KN], member: A, isAdmin: false, viewer: A, now: NOW });
        chk("V3 결과가 있어도 뜻이 멀면(코사인 < 0.65) 약함 · 가까우면(≥ 0.65) 낱말이 안 맞아도 강함",
          far?.reason === "weak" && far.knowledge.top_similarity < 0.65 && near === null,
          JSON.stringify({ far: far && { reason: far.reason, k: far.knowledge }, near }));
        //  고치기 — 임베딩할 글이 그대로면 벡터를 안 비운다 · 바뀌면 비워 다시 임베딩한다(시각이 바뀐다).
        const stamp = async () => (await itemsPool.query(`SELECT embedding_updated_at AS t FROM collect_unit WHERE id=$1`, [u2.id])).rows[0].t?.toISOString?.() ?? null;
        const t0 = await stamp();
        await store.updateUnit(u2.id, { description: "채용 공고와 면접 일정", meta: { knowhow: "봇 글 제외" } }, { member: A, isAdmin: false });
        await new Promise((r2) => setTimeout(r2, 400));
        const t1 = await stamp();
        await store.updateUnit(u2.id, { description: "채용 공고와 면접 일정 — 인턴 포함" }, { member: A, isAdmin: false });
        let t2 = t0;
        for (let i = 0; i < 30 && t2 === t0; i++) { await new Promise((r2) => setTimeout(r2, 100)); t2 = await stamp(); }
        chk("V1b 고치기 — 임베딩할 글이 그대로(설명 같음 · 맥락 밖 메타만)면 벡터를 안 비우고, 설명이 바뀌면 비워 다시 임베딩한다",
          t0 != null && t1 === t0 && t2 !== t0, JSON.stringify({ t0, t1, t2 }));
      } finally {
        await itemsPool.query(`UPDATE org_runtime_config SET embedding_config = $1::jsonb WHERE id=1`, [embedBefore == null ? null : JSON.stringify(embedBefore)]);
        __resetQueryEmbedCache();
        await new Promise((r) => server.close(r));
      }
    }
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  await itemsPool.query(`UPDATE org_runtime_config SET allow_member_ai_connectors = $1 WHERE id=1`, [policyBefore ?? true]).catch(() => {});
  if (axesBefore) await setVisAxes({ source: axesBefore.source }).catch(() => {});
  await cleanup().catch(() => {});
  console.log(`\nunit-find pg-test: ${pass} passed, ${fail} failed`);
  await itemsPool.end?.().catch?.(() => {});
}
process.exit(fail ? 1 : 0);
