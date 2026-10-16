// 지속 수집 트리거(#4213 T12 #4744) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/collect/collect-schedule.pg-test.mjs
//
// 왜 이 계층인가: 기본 주기의 약속은 **표가 지키는 사실**이다 — «다 읽은 판 뒤 다음 확인 시각이 주기 뒤로 적힌다» · «주기는 빈도가 정하고
//  사람이 정하면 고정» · «모으기로 켠 단위는 곧바로» · «실행이 실은 단위는 저장 단계가 끝날 때까지 붙잡혀 다시 안 뜬다» · «지금 담당의 판만
//  다음 확인을 쓴다» · «틱은 때가 된 단위의 담당자만, 도는 사람(실행 중 · 저장 중)·실패가 이어진 사람·하루 상한에 닿은 사람은 빼고 상한 안에서
//  띄운다» · «컨테이너 부족(503)은 그 사람만 물러서고 정책이 막혔을 때만 틱을 멈춘다» · «물러서기 기억은 워크스페이스마다» · «저장 단계를 못 탄
//  끝난 실행을 마저 처리하고, 오래 못 읽는 판만 닫는다». 판정(순수)은 schedule-plan.test.ts · schedule-harvest.test.ts.
//  여기는 noteUnitRead · leaseUnits · updateUnit · listAssignedUnits · dueAssignments · collectScheduleTick · ingestRun 을 실제 표에 대고 부른 뒤
//  **행을 되읽어** 판정한다. 수집 실행 자체(세션 컨테이너)는 띄우지 않는다 — 틱의 «띄우기·상태 읽기» 자리를 갈아 끼워 누구를 띄웠나만 본다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/collect/unit-store.js`);
const sched = await import(`${DIST}/org/collect/collect-schedule.js`);
const { noteUnitRead, leaseUnits, releaseRunLeases } = await import(`${DIST}/org/collect/unit-schedule.js`);
const { collectRunCapabilities } = await import(`${DIST}/capabilities/collect-run.js`);
const { ingestRun } = await import(`${DIST}/org/collect/run-ingest.js`);
const { NOW_MARGIN_SEC } = await import(`${DIST}/org/collect/collect-plan.js`);
const { withTenant } = await import(`${DIST}/org/tenant-context.js`);
const { initV6CollectTrigger } = await import(`${DIST}/v6/schema/collect-trigger.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__ci_sched_a__", B = "__ci_sched_b__", C = "__ci_sched_c__", D_ = "__ci_sched_d__";
const MEMBERS = [A, B, C, D_];
const TEAM = "T_CISCHED";
const CH = (n) => `C0CISCH${String(n).padStart(3, "0")}`;
const GDRIVE_REF = "1AbCdEfGhIjKlMn";   // 수집 실행이 못 읽는 앱의 단위(R9a)
const NOTION_REF = "abcdef01-2345-6789-abcd-ef01c15c0001";
//  지금(분 단위로 내림) — 주기를 «최근 14일» 표본으로 재고, updateUnit 은 서버 시계로 다시 맞추므로 고정 날짜를 쓰면 시험이 날짜가 지나며 깨진다.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const NOW_SEC = NOW / 1000;
const H = 3600, DAY = 86400;
const iso = (ms) => new Date(ms).toISOString();

const unitBy = async (ref, app = "slack") => (await itemsPool.query(`SELECT * FROM collect_unit WHERE app=$1 AND ref=$2`, [app, ref])).rows[0];
async function makeUnit(ref, member, o = {}) {
  const app = o.app ?? "slack";
  await store.recordUnitListing({ member, app, connector: app === "notion" ? "Notion" : "Slack", instance: app === "notion" ? "" : TEAM,
    items: [{ ref, kind: app === "notion" ? "page" : "channel", name: `#${ref}` }], verified: true });
  const u = await unitBy(ref, app);
  await itemsPool.query(`UPDATE collect_unit SET state=$2 WHERE id=$1`, [u.id, o.state ?? "active"]);
  if (o.set) await itemsPool.query(`UPDATE collect_unit SET ${o.set} WHERE id=$1`, [u.id]);
  return unitBy(ref, app);
}
async function addMembers() {
  for (const m of MEMBERS) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@cisched.test`]);
}
async function cleanup() {
  await itemsPool.query(`DELETE FROM collect_unit WHERE (app = 'slack' AND (instance=$1 OR ref LIKE 'C0CISCH%')) OR (app = 'gdrive' AND ref = $2) OR (app = 'notion' AND ref = $3)`, [TEAM, GDRIVE_REF, NOTION_REF]);
  await itemsPool.query(`DELETE FROM source WHERE (external_system='slack' AND external_instance=$1) OR (external_system='notion' AND external_id=$2)`, [TEAM, NOTION_REF]);
  await itemsPool.query(`DELETE FROM collect_assignee_state WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [MEMBERS]);
}
/** 틱의 갈아 끼우는 자리 — 누구를 띄웠나 · 무엇을 읽었나만 적는다. policy 는 값 하나 또는 차례로 줄 값들. */
function deps(o = {}) {
  const started = [], read = [];
  const policies = Array.isArray(o.policy) ? [...o.policy] : null;
  return {
    started, read,
    d: {
      force: true, now: () => o.now ?? NOW, running: () => new Set(o.running ?? []),
      policy: async () => (policies ? (policies.length > 1 ? policies.shift() : policies[0]) : (o.policy ?? "allowed")),
      maxConcurrent: o.max ?? 2, dailyMax: o.dailyMax, callDeadlineMs: o.deadlineMs,
      start: async (m) => {
        if (o.hang?.includes(m)) return new Promise(() => {});   // 중계가 멈춘 띄우기 — 끝나지 않는다
        if (o.startErr?.[m]) throw o.startErr[m]; started.push(m); return { runId: `cr-test-${m}` };
      },
      read: async (m, id) => { if (o.readErr?.[id]) throw o.readErr[id]; read.push(`${m}:${id}`); return {}; },
    },
  };
}
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
async function runRow(runId, member, o = {}) {
  await itemsPool.query(
    `INSERT INTO collect_run(run_id, member_id, started_at, ended_at, mode, outcome, ingest, plan, deadline_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
    [runId, member, o.started ?? new Date(NOW - 10 * 60_000), o.ended ?? null, o.mode ?? "collect", o.outcome ?? null,
      o.ingest == null ? null : JSON.stringify(o.ingest),   // null 은 SQL NULL(JSON null 이 아니다 — 저장 단계 전)
      o.plan == null ? null : JSON.stringify(o.plan), o.deadline ?? null]);
}
/** 앞 시험이 같은 DB 에 남긴 «때가 된 단위» · «도는 실행» 이 자리를 먹지 않게 이 시험 동안 비켜 둔다(시험 DB 전용). */
async function isolate() {
  const foreign = (await store.dueAssignments(NOW)).filter((d) => !MEMBERS.includes(d.member)).map((d) => d.unit_id);
  if (foreign.length) await itemsPool.query(`UPDATE collect_unit SET next_at = now() + interval '1 day' WHERE id = ANY($1::int[])`, [foreign]);
  await itemsPool.query(`UPDATE collect_run SET outcome = COALESCE(outcome, 'lost'), ingest = '{"state":"failed"}'::jsonb
                          WHERE (outcome IS NULL OR ingest IS NULL) AND NOT (member_id = ANY($1::text[]))`, [MEMBERS]);
}

try {
  await cleanup();
  sched._resetCollectScheduleForTest();
  await addMembers();

  // ── R1~R3 저장 단계 → 다음 확인 시각 ──
  {
    const u = await makeUnit(CH(1), A);
    //  다 읽은 판 — 7일에 글 70개(하루 10) → 주기 1시간.
    const r = await noteUnitRead(u.id, { outcome: "complete", sample: { e: NOW_SEC - 60, s: 7 * DAY, n: 70 }, now: NOW }, { member: A });
    const a = await unitBy(CH(1));
    chk("R1 다 읽고 따라잡음 → 다음 확인 = 지금 + 빈도 주기(하루 10개 → 1시간) · 주기 칸도 그 값(자동) · 표본·활동량이 남는다",
      r?.why === "interval" && new Date(a.next_at).getTime() === NOW + H * 1000 && a.interval_sec === H && a.interval_auto === true
        && a.sched?.hist?.length === 1 && a.sched?.fails === 0 && a.meta?.activity?.per_day === 10,
      JSON.stringify({ r, next_at: a.next_at, interval: a.interval_sec, sched: a.sched, act: a.meta?.activity }));
    await noteUnitRead(u.id, { outcome: "complete", behind: true, sample: { e: NOW_SEC - 7 * DAY, s: 7 * DAY, n: 0 }, now: NOW }, { member: A });
    const b = await unitBy(CH(1));
    chk("R2 다 읽었지만 밀림 → 곧바로(60초) · 표본 둘(70/14일 = 5 → 주기 1시간)",
      new Date(b.next_at).getTime() === NOW + 60_000 && b.sched?.why === "catchup" && b.sched?.hist?.length === 2 && b.interval_sec === H && b.meta?.activity?.per_day === 5,
      JSON.stringify({ next_at: b.next_at, sched: b.sched, interval: b.interval_sec, act: b.meta?.activity }));
    await noteUnitRead(u.id, { outcome: "incomplete", shrunk: true, stuck: true, now: NOW }, { member: A });
    const c1 = await unitBy(CH(1));
    await noteUnitRead(u.id, { outcome: "unread", now: NOW }, { member: A });
    const c2 = await unitBy(CH(1));
    chk("R3 못 다 읽음+더 못 줄임 → 10분 물러섬 · 이어서 안 읽음 → 20분(실패 수가 표에 남아 이어진다) · 표본은 그대로",
      new Date(c1.next_at).getTime() === NOW + 600_000 && c1.sched?.fails === 1 && new Date(c2.next_at).getTime() === NOW + 1200_000
        && c2.sched?.fails === 2 && c2.sched?.why === "retry" && c2.sched?.hist?.length === 2,
      JSON.stringify({ c1: [c1.next_at, c1.sched?.fails], c2: [c2.next_at, c2.sched] }));
    await noteUnitRead(u.id, { outcome: "incomplete", shrunk: false, now: NOW }, { member: A });
    const c3 = await unitBy(CH(1));
    chk("R3b 못 다 읽음인데 줄일 구간이 없다(노션 모양) → 곧바로가 아니라 물러섬(40분)", new Date(c3.next_at).getTime() === NOW + 2400_000 && c3.sched?.why === "retry",
      JSON.stringify({ next: c3.next_at, sched: c3.sched }));
    const gone = await noteUnitRead(999999999, { outcome: "complete", now: NOW }, { member: A });
    chk("R3c 없는 단위는 조용히 null(던지지 않는다)", gone === null, JSON.stringify(gone));
  }

  // ── L1~L3 임대 · 지금 담당만 ──
  {
    const u = await makeUnit(CH(40), A, { set: `next_at = '${iso(NOW - 60_000)}'` });
    const n = await leaseUnits([u.id], "cr-lease-1", NOW + 23 * 60_000);
    const leased = await unitBy(CH(40));
    const due = (await store.dueAssignments(NOW)).map((d) => d.unit_id);
    chk("L1 실행이 실은 단위는 붙잡힌다 — 다음 확인 = 그 판의 마감 + 여유 · sched.lease = 그 판 · 그동안 틱이 «때가 됨» 으로 안 본다",
      n === 1 && new Date(leased.next_at).getTime() === NOW + 23 * 60_000 && leased.sched?.lease?.run === "cr-lease-1" && !due.includes(u.id),
      JSON.stringify({ n, next: leased.next_at, sched: leased.sched, due }));
    //  담당이 B 로 바뀐다(A 의 로그인이 끊김) — A 의 늦은 판은 아무것도 안 쓰고 자기 임대만 푼다.
    await itemsPool.query(`INSERT INTO collect_assignee_state(member_id, connector, state, since, retry_at, fails) VALUES($1,'*','login_broken',now(), now() + interval '1 hour', 1)`, [A]);
    await store.recordUnitListing({ member: B, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: CH(40), kind: "channel", name: "#x" }], verified: true });
    const other = await noteUnitRead(u.id, { outcome: "unread", now: NOW }, { member: A, runId: "cr-lease-other" });
    const kept = await unitBy(CH(40));
    const mine = await noteUnitRead(u.id, { outcome: "unread", now: NOW }, { member: A, runId: "cr-lease-1" });
    const released = await unitBy(CH(40));
    chk("L2 지금 담당이 아닌 판은 아무것도 안 쓴다 — 남의 판 id 면 그대로 · 이 판이 건 임대면 풀어서 곧바로 새 담당(B) 차례",
      other === null && kept.sched?.lease?.run === "cr-lease-1" && kept.sched?.fails == null
        && mine === null && new Date(released.next_at).getTime() <= Date.now() + 1000 && released.sched?.lease == null && released.sched?.fails == null
        && (await store.dueAssignments(Date.now() + 1000)).some((d) => d.unit_id === u.id && d.member === B),
      JSON.stringify({ kept: kept.sched, released: [released.next_at, released.sched] }));
    await itemsPool.query(`DELETE FROM collect_assignee_state WHERE member_id = $1`, [A]);
    await leaseUnits([u.id], "cr-lease-2", NOW + 20 * 60_000);
    await noteUnitRead(u.id, { outcome: "complete", sample: { e: NOW_SEC - 60, s: DAY, n: 1 }, now: NOW }, { member: A, runId: "cr-lease-2" });
    const done = await unitBy(CH(40));
    chk("L3 담당의 판이 저장되면 판정이 임대를 대신한다(다음 확인 = 주기 뒤 · lease 없음)",
      done.sched?.lease == null && done.sched?.why === "interval" && new Date(done.next_at).getTime() === NOW + done.interval_sec * 1000,
      JSON.stringify({ next: done.next_at, sched: done.sched, iv: done.interval_sec }));
    //  판정 없이 끝난 판(저장 단계 실패 · 훑기가 닫음)은 자기 임대만 푼다 — 다음 확인 = 지금 + 10분(곧바로 같은 실패를 되풀이하지 않게).
    const x1 = await makeUnit(CH(41), A), x2 = await makeUnit(CH(42), A), y1 = await makeUnit(CH(43), A);
    await leaseUnits([x1.id, x2.id], "cr-lease-x", NOW + 23 * 60_000);
    await leaseUnits([y1.id], "cr-lease-y", NOW + 23 * 60_000);
    const freed = await releaseRunLeases("cr-lease-x", NOW);
    const [a1, a2, b1] = [await unitBy(CH(41)), await unitBy(CH(42)), await unitBy(CH(43))];
    chk("L4 판정 없이 끝난 판의 임대 풀기 — 그 판의 단위만 · 다음 확인 = 지금 + 10분 · 남의 판 임대는 그대로",
      freed === 2 && [a1, a2].every((x) => x.sched?.lease == null && new Date(x.next_at).getTime() === NOW + 600_000)
        && b1.sched?.lease?.run === "cr-lease-y" && new Date(b1.next_at).getTime() === NOW + 23 * 60_000,
      JSON.stringify({ freed, a1: [a1.next_at, a1.sched], b1: [b1.next_at, b1.sched] }));
  }

  // ── R4~R6 주기 고정·자동 · 모으기로 켜기 · 활동량 작성자 ──
  {
    const u = await makeUnit(CH(2), A, { set: `read_at = '${iso(NOW - 30 * 60_000)}'` });
    const actor = { member: A, isAdmin: false };
    await store.updateUnit(u.id, { interval_sec: 7200 }, actor);
    const p = await unitBy(CH(2));
    chk("R4 주기를 정하면 고정(interval_auto=false) · 다음 확인 = 읽은 시각 + 그 주기",
      p.interval_auto === false && p.interval_sec === 7200 && new Date(p.next_at).getTime() === NOW - 30 * 60_000 + 7200_000,
      JSON.stringify({ auto: p.interval_auto, iv: p.interval_sec, next: p.next_at }));
    await noteUnitRead(u.id, { outcome: "complete", sample: { e: NOW_SEC - 60, s: DAY, n: 100 }, now: NOW }, { member: A });
    const p2 = await unitBy(CH(2));
    chk("R4b 고정 주기는 빈도가 바꾸지 않는다(하루 100개여도 2시간)",
      p2.interval_sec === 7200 && new Date(p2.next_at).getTime() === NOW + 7200_000 && p2.meta?.activity?.per_day === 100,
      JSON.stringify({ iv: p2.interval_sec, next: p2.next_at, act: p2.meta?.activity }));
    await store.updateUnit(u.id, { interval_sec: null }, actor);
    const p3 = await unitBy(CH(2));
    chk("R5 null 이면 다시 자동 — 지금 빈도로 곧바로 다시 맞춘다(하루 100개 → 30분) · 다음 확인 = 읽은 시각 + 그 주기",
      p3.interval_auto === true && p3.interval_sec === 1800 && new Date(p3.next_at).getTime() === NOW - 30 * 60_000 + 1800_000,
      JSON.stringify({ auto: p3.interval_auto, iv: p3.interval_sec, next: p3.next_at }));
    await store.updateUnit(u.id, { meta: { activity: { per_day: 999 }, knowhow: "봇 글 제외" } }, actor);
    const p4 = await unitBy(CH(2));
    chk("R5b 활동량은 서버만 쓴다 — 고치기 입력의 meta.activity 는 무시하고 나머지(knowhow)만 합친다",
      p4.meta?.activity?.per_day === 100 && p4.meta?.knowhow === "봇 글 제외", JSON.stringify(p4.meta));
    const q = await makeUnit(CH(3), A, { state: "candidate", set: `next_at = '${iso(NOW + DAY * 1000)}'` });
    await store.updateUnit(q.id, { state: "active" }, actor);
    const q2 = await unitBy(CH(3));
    await itemsPool.query(`UPDATE collect_unit SET next_at=$2 WHERE id=$1`, [q.id, iso(NOW + H * 1000)]);
    await store.updateUnit(q.id, { state: "active" }, actor);
    const q3 = await unitBy(CH(3));
    chk("R6 모으기로 새로 켠 단위는 다음 확인을 비운다(곧바로 처음 수집) · 이미 켜진 단위에 같은 값을 줘도 그대로",
      q2.state === "active" && q2.next_at === null && q3.next_at != null && new Date(q3.next_at).getTime() === NOW + H * 1000,
      JSON.stringify({ q2: q2.next_at, q3: q3.next_at }));
  }

  // ── R7·R8 때가 된 단위 · 곧 때가 될 단위 · 틱이 볼 담당 ──
  {
    await cleanup(); await addMembers();
    await makeUnit(CH(10), A, { set: `next_at = '${iso(NOW - 1000)}', interval_sec = 3600` });
    await makeUnit(CH(11), A, { set: `next_at = '${iso(NOW + 20 * 60_000)}', interval_sec = 3600, sched = '{"why":"interval"}'` });
    await makeUnit(CH(12), A, { set: `next_at = '${iso(NOW + 50 * 60_000)}', interval_sec = 3600, sched = '{"why":"interval"}'` });
    await makeUnit(CH(13), A, { set: `next_at = '${iso(NOW + 5 * 60_000)}', interval_sec = 3600, sched = '{"why":"retry"}'` });
    await makeUnit(CH(14), A);
    await makeUnit(CH(15), A, { state: "candidate" });
    const only = (await store.listAssignedUnits(A, { dueOnly: true, now: NOW })).map((u) => u.ref).sort();
    const withSoon = await store.listAssignedUnits(A, { dueOnly: true, soon: true, now: NOW });
    const soonRow = withSoon.find((u) => u.ref === CH(11));
    chk("R7 때가 된 것만(다음 확인이 지남 · 처음 읽는 단위) · soon 이면 주기대로 기다리며 절반 넘게 지난 단위도 due:false 로 · 물러서는 단위·먼 단위·후보는 아님",
      JSON.stringify(only) === JSON.stringify([CH(10), CH(14)].sort())
        && withSoon.length === 3 && soonRow?.due === false && !withSoon.some((u) => [CH(12), CH(13), CH(15)].includes(u.ref)),
      JSON.stringify({ only, withSoon: withSoon.map((u) => [u.ref, u.due]) }));
    await makeUnit(CH(16), B, { set: `route = 'lively_collector', next_at = NULL` });
    const da = (await store.dueAssignments(NOW)).filter((d) => MEMBERS.includes(d.member));
    const refs = da.map((d) => d.ref).sort();
    chk("R8 틱이 볼 담당 — 구성원이 담당인 때가 된 단위만(꺼진 수집기 단위·먼 단위·후보는 아님) · 처음 읽는 단위는 때가 된 시각 0",
      JSON.stringify(refs) === JSON.stringify([CH(10), CH(14)].sort()) && da.every((d) => d.member === A)
        && da.find((d) => d.ref === CH(14))?.due_since_ms === 0 && da.find((d) => d.ref === CH(10))?.due_since_ms === NOW - 1000,
      JSON.stringify(da));
  }

  // ── R9 틱 — 누구를 띄우나 ──
  {
    await cleanup(); await addMembers();
    await isolate();
    await makeUnit(CH(20), A, { set: `next_at = '${iso(NOW - 5 * 60_000)}'` });       // A: 5분 기다림
    await makeUnit(CH(21), B, { set: `next_at = '${iso(NOW - 30 * 60_000)}'` });      // B: 30분 기다림(가장 오래)
    await makeUnit(CH(22), C, { set: `next_at = '${iso(NOW - 10 * 60_000)}'` });      // C: 10분
    //  D 의 때가 된 단위는 수집 실행이 못 읽는 앱(드라이브) — 띄우면 «맡은 단위 없음» 409 가 틱마다 되풀이된다.
    await store.recordUnitListing({ member: D_, app: "gdrive", connector: "Google Drive", instance: "default", items: [{ ref: GDRIVE_REF, kind: "folder", name: "폴더" }], verified: true });
    await itemsPool.query(`UPDATE collect_unit SET state='active' WHERE app='gdrive' AND ref=$1`, [GDRIVE_REF]);
    let t = deps({ max: 2 });
    let r = await sched.collectScheduleTick(t.d);
    chk("R9a 가장 오래 기다린 사람부터 상한(2)만큼 — B, C · 못 읽는 앱만 맡은 D 는 안 띄운다",
      JSON.stringify(t.started) === JSON.stringify([B, C]) && r.due_members === 3 && r.due_units === 3,
      JSON.stringify({ started: t.started, r }));
    await runRow("cr-run-b", B);
    t = deps({ max: 2, running: [C] });
    r = await sched.collectScheduleTick(t.d);
    chk("R9b 도는 사람(실행 기록 · 이 게이트웨이)은 빼고, 그만큼 자리도 찬다 → 아무도 안 띄움",
      t.started.length === 0 && r.running === 2, JSON.stringify({ started: t.started, r }));
    t = deps({ max: 3, running: [C] });
    r = await sched.collectScheduleTick(t.d);
    chk("R9c 자리가 하나 남으면 남은 사람(A)만", JSON.stringify(t.started) === JSON.stringify([A]), JSON.stringify({ started: t.started, r }));
    //  끝났지만 저장 단계가 아직인 판(B · 끝난 지 5분) — 그 판의 단위는 저장이 끝나야 다음 확인이 옮겨지므로 B 는 아직 «도는 사람».
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    await runRow("cr-b-ingesting", B, { outcome: "ok", ended: new Date(NOW - 5 * 60_000), ingest: null });
    await runRow("cr-c-ingested-old", C, { outcome: "ok", ended: new Date(NOW - 40 * 60_000), started: new Date(NOW - 41 * 60_000), ingest: null });
    t = deps({ max: 5, readErr: { "cr-b-ingesting": httpErr(502, "x"), "cr-c-ingested-old": httpErr(502, "x") } });
    r = await sched.collectScheduleTick(t.d);
    chk("R9c' 저장 단계가 아직인 판의 주인(끝난 지 15분 안)은 안 띄운다 · 그보다 오래된 판은 훑기 몫이라 막지 않는다",
      !t.started.includes(B) && t.started.includes(C) && t.started.includes(A), JSON.stringify({ started: t.started }));
    //  끝 기록이 없는 판 — 그 판의 마감 전이면 도는 사람(C) · 마감이 지났으면(지켜보던 게이트웨이가 사라진 판) 도는 사람이 아니다(B) ·
    //   마감을 모르는 옛 판은 가장 긴 상한(65분)으로(A — 20분 전 시작).
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    await runRow("cr-b-orphan", B, { started: new Date(NOW - 25 * 60_000), deadline: new Date(NOW - 7 * 60_000) });
    await runRow("cr-c-live", C, { started: new Date(NOW - 5 * 60_000), deadline: new Date(NOW + 13 * 60_000) });
    await runRow("cr-a-old", A, { started: new Date(NOW - 20 * 60_000) });
    t = deps({ max: 5, readErr: { "cr-b-orphan": httpErr(502, "x"), "cr-a-old": httpErr(502, "x") } });
    r = await sched.collectScheduleTick(t.d);
    chk("R9c'' 끝 기록 없는 판 — 마감 전이면 도는 사람(C) · 마감이 지났으면 아니다(B) · 마감을 모르는 옛 판은 65분까지 도는 사람(A)",
      t.started.includes(B) && !t.started.includes(C) && !t.started.includes(A), JSON.stringify({ started: t.started }));
    //  A 는 최근 두 판이 연달아 실패했다 → 마지막 실패 뒤 20분 물러섬.
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    sched._resetCollectScheduleForTest();
    await runRow("cr-a-1", A, { started: new Date(NOW - 40 * 60_000), ended: new Date(NOW - 39 * 60_000), outcome: "ok", ingest: { state: "done" } });
    await runRow("cr-a-2", A, { started: new Date(NOW - 20 * 60_000), ended: new Date(NOW - 19 * 60_000), outcome: "timeout", ingest: { state: "failed" } });
    await runRow("cr-a-3", A, { started: new Date(NOW - 10 * 60_000), ended: new Date(NOW - 9 * 60_000), outcome: "ok", ingest: { state: "failed" } });
    t = deps({ max: 5 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9d 실패가 이어진 사람(A — 시간 초과 · 저장 단계 실패)은 물러서는 동안 안 띄운다",
      !t.started.includes(A) && t.started.includes(B) && t.started.includes(C), JSON.stringify({ started: t.started }));
    t = deps({ max: 5, now: NOW - 9 * 60_000 + 20 * 60_000 + 1000 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9e 물러섬(마지막 실패 끝 + 20분)이 지나면 다시 띄운다", t.started.includes(A), JSON.stringify({ started: t.started }));
    //  띄우기 실패 — 409(그새 다른 판)는 실패가 아니다 · 503(세션 컨테이너 부족 — 정책은 허용)은 그 사람만 물러서고 뒤 사람은 띄운다.
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    sched._resetCollectScheduleForTest();
    t = deps({ max: 5, startErr: { [B]: httpErr(409, "이미 도는"), [C]: httpErr(503, "세션 컨테이너를 확보하지 못해") } });
    r = await sched.collectScheduleTick(t.d);
    chk("R9f 409 는 실패로 안 센다 · 503(정책 허용)은 그 사람만 실패로 적고 뒤 사람(A)은 띄운다(한 사람이 줄을 막지 않는다)",
      JSON.stringify(t.started) === JSON.stringify([A]) && r.failed.length === 1 && r.failed[0].member === C && r.failed[0].status === 503, JSON.stringify(r));
    t = deps({ max: 5 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9g 띄우기에 실패한 사람(C)은 물러서는 동안(10분) 다음 틱에도 빼고, 409 였던 사람(B)은 다시 본다",
      !t.started.includes(C) && t.started.includes(B), JSON.stringify({ started: t.started }));
    t = deps({ max: 5, now: NOW + 10 * 60_000 + 1000 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9h 띄우기 물러섬이 지나면 C 도 다시", t.started.includes(C), JSON.stringify({ started: t.started }));
    //  물러서기 기억은 워크스페이스마다 — 다른 워크스페이스의 같은 id 가 물러서도 이 워크스페이스의 C 는 그대로 띄운다.
    sched._resetCollectScheduleForTest();
    const wsA = { id: "00000000-0000-4000-8000-00000000a744", slug: "ws-a" };
    const wsB = { id: "00000000-0000-4000-8000-00000000b744", slug: "ws-b" };
    t = deps({ max: 5, startErr: { [C]: httpErr(500, "x") } });
    await withTenant(wsA, () => sched.collectScheduleTick(t.d));
    const tb = deps({ max: 5 });
    await withTenant(wsB, () => sched.collectScheduleTick(tb.d));
    const ta = deps({ max: 5 });
    await withTenant(wsA, () => sched.collectScheduleTick(ta.d));
    chk("R9h' 물러서기 기억은 워크스페이스마다 — ws-a 에서 실패한 C 가 ws-b 에서는 그대로 뜨고, ws-a 에서는 물러선다",
      tb.started.includes(C) && !ta.started.includes(C), JSON.stringify({ wsB: tb.started, wsA: ta.started }));
    //  정책 · 틱 간격 · 정책이 그새 막힘(403 → 다시 읽으니 blocked) · 끄개.
    sched._resetCollectScheduleForTest();
    t = deps({ policy: "blocked" });
    r = await sched.collectScheduleTick(t.d);
    chk("R9i 구성원 Claude 커넥터를 막은 워크스페이스는 아무것도 안 한다", r.skipped === "policy" && t.started.length === 0 && t.read.length === 0, JSON.stringify(r));
    t = deps({ policy: "unknown" });
    chk("R9i' 정책을 못 읽으면 막음", (await sched.collectScheduleTick(t.d)).skipped === "policy");
    process.env.LIVELY_COLLECT_SCHEDULE = "off";
    t = deps({});
    const off = await sched.collectScheduleTick(t.d);
    delete process.env.LIVELY_COLLECT_SCHEDULE;
    chk("R9i'' 끄개(env LIVELY_COLLECT_SCHEDULE=off)면 정책과 무관하게 아무것도 안 한다", off.skipped === "off" && t.started.length === 0, JSON.stringify(off));
    sched._resetCollectScheduleForTest();
    t = deps({ max: 5 });
    const first = await sched.collectScheduleTick({ ...t.d, force: false });
    const second = await sched.collectScheduleTick({ ...t.d, force: false, now: () => NOW + 30_000 });
    const third = await sched.collectScheduleTick({ ...t.d, force: false, now: () => NOW + 61_000 });
    chk("R9j 워크스페이스마다 1분에 한 번 — 30초 뒤 틱은 그냥 돌아가고 61초 뒤는 일한다",
      !first.skipped && second.skipped === "throttle" && !third.skipped, JSON.stringify({ first: first.skipped, second: second.skipped, third: third.skipped }));
    //  B 가 가장 오래 기다렸다 — B 를 띄우다 403 이 났고 다시 읽은 정책이 막힘이면 뒤의 C·A 는 이 틱에 안 띄운다.
    sched._resetCollectScheduleForTest();
    t = deps({ max: 5, policy: ["allowed", "blocked"], startErr: { [B]: httpErr(403, "막음") } });
    r = await sched.collectScheduleTick(t.d);
    chk("R9k 띄우는 중 403 이고 정책을 다시 읽으니 막혔다 → 그 틱은 거기서 멈춘다", t.started.length === 0 && r.failed.length === 1 && r.failed[0].member === B && r.failed[0].status === 403, JSON.stringify(r));
    //  하루 상한 — 최근 24시간 주기 판이 상한(3)에 닿은 사람(A)은 쉰다.
    sched._resetCollectScheduleForTest();
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    for (let i = 0; i < 3; i++) {
      await runRow(`cr-a-daily-${i}`, A, { started: new Date(NOW - (i + 2) * H * 1000), ended: new Date(NOW - (i + 2) * H * 1000 + 60_000),
        outcome: "ok", ingest: { state: "done" }, plan: { mode: "collect", trigger: "schedule", units: [] } });
    }
    await runRow("cr-b-manual", B, { started: new Date(NOW - 2 * H * 1000), ended: new Date(NOW - 2 * H * 1000 + 60_000), outcome: "ok", ingest: { state: "done" }, plan: { mode: "collect", units: [] } });
    t = deps({ max: 5, dailyMax: 3 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9l 최근 24시간 주기 판이 안전망(3)에 닿은 사람(A)은 늦춘다 · 사람이 직접 띄운 판은 안 센다(B)",
      !t.started.includes(A) && t.started.includes(B) && r.capped === 1, JSON.stringify({ started: t.started, capped: r.capped }));
    //  멈추지 않고 고르게 — 마지막 주기 판(2시간 전) + 24시간/3 = 6시간 뒤면 다시 띄운다(24시간 창에 아직 3판이 있어도).
    t = deps({ max: 5, dailyMax: 3, now: NOW + 6 * H * 1000 + 1000 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9l' 안전망은 멈춤이 아니라 늦춤 — 마지막 주기 판 + 24시간/상한이 지나면 다시 띄운다",
      t.started.includes(A) && r.capped === 0, JSON.stringify({ started: t.started, capped: r.capped }));
    //  중계가 멈춘 띄우기 — 마감(시험 50ms)이 지나면 그 사람만 실패로 세고 틱은 끝난다 · 다음 틱은 «도는 중» 이 아니다 · 그 사람은 물러선다.
    sched._resetCollectScheduleForTest();
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    t = deps({ max: 5, hang: [B], deadlineMs: 50 });
    r = await sched.collectScheduleTick(t.d);
    const t2 = deps({ max: 5 });
    const r2 = await sched.collectScheduleTick(t2.d);
    chk("R9m 중계가 멈춘 띄우기는 마감 뒤 그 사람만 실패 — 뒤 사람은 띄우고 · 다음 틱은 돈다 · 멈춘 사람은 물러선다",
      r.failed.length === 1 && r.failed[0].member === B && r.failed[0].status === null && t.started.includes(A) && t.started.includes(C)
        && !r2.skipped && !t2.started.includes(B),
      JSON.stringify({ r: { failed: r.failed, started: t.started }, r2: { skipped: r2.skipped, started: t2.started } }));
    //  마감이 없는 자리(정책 조회)에서 틱이 멈췄다 — 그동안의 틱은 «도는 중» 으로 돌아가고, 30분이 넘으면 다음 틱이 이어받는다.
    sched._resetCollectScheduleForTest();
    void sched.collectScheduleTick({ ...deps({}).d, policy: () => new Promise(() => {}) });   // 끝나지 않는 틱(기다리지 않는다)
    const during = await sched.collectScheduleTick(deps({ now: NOW + 60_000 }).d);
    const tn = deps({ max: 5, now: NOW + 31 * 60_000 });
    const after = await sched.collectScheduleTick(tn.d);
    chk("R9n 앞 틱이 멈춘 채면 «도는 중» 으로 돌아가다가 30분이 넘으면 이어받는다",
      during.skipped === "busy" && !after.skipped && tn.started.length > 0, JSON.stringify({ during: during.skipped, after: after.skipped, started: tn.started }));
  }

  // ── R10 훑기 — 저장 단계를 못 탄 끝난 실행 ──
  {
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    await isolate();
    sched._resetCollectScheduleForTest();
    await runRow("cr-sw-done", A, { outcome: "ok", ingest: null, ended: new Date(NOW - 5 * 60_000) });           // 끝 · 저장 전 → 읽는다
    await runRow("cr-sw-ingested", A, { outcome: "ok", ingest: { state: "done" } });                               // 이미 넣음 → 안 읽는다
    await runRow("cr-sw-running", B, { outcome: null, started: new Date(Date.now() - 5 * 60_000) });              // 도는 중 → 안 읽는다
    await runRow("cr-sw-lost", B, { outcome: null, started: new Date(Date.now() - 2 * 3600_000) });                // 상한을 넘김 → 읽는다
    await runRow("cr-sw-probe", C, { outcome: "ok", mode: "probe" });                                              // 점검 → 저장 단계 없음
    await runRow("cr-sw-gone", C, { outcome: "ok", ended: new Date(NOW - 60_000) });                               // 폴더 없음 → 두 번 보고 닫는다
    await runRow("cr-sw-stale", C, { outcome: "ok", started: new Date(Date.now() - 3 * DAY * 1000) });             // 이틀 넘음 → 안 본다
    const notFound = { "cr-sw-gone": httpErr(404, "그 수집 실행을 찾지 못했습니다") };
    let t = deps({ max: 0, readErr: notFound });
    let r = await sched.collectScheduleTick(t.d);
    const gone1 = (await itemsPool.query(`SELECT ingest FROM collect_run WHERE run_id='cr-sw-gone'`)).rows[0];
    chk("R10a 끝났는데 저장 전인 판 · 상한을 넘긴 판을 상태 읽기로 마저 처리 — 이미 넣은 판·도는 판·점검·이틀 넘은 판은 안 본다 · 404 한 번은 아직 안 닫는다",
      JSON.stringify(t.read.sort()) === JSON.stringify([`${A}:cr-sw-done`, `${B}:cr-sw-lost`].sort()) && r.swept === 2 && gone1.ingest === null,
      JSON.stringify({ read: t.read, swept: r.swept, gone1 }));
    t = deps({ max: 0, readErr: notFound });
    await sched.collectScheduleTick(t.d);
    const gone = (await itemsPool.query(`SELECT outcome, ingest FROM collect_run WHERE run_id='cr-sw-gone'`)).rows[0];
    chk("R10b 실행 폴더가 없는 판(404)은 두 번 확인한 뒤 «저장 단계 실패» 로 닫는다(다음 틱이 다시 집지 않게)",
      gone.ingest?.state === "failed" && /폴더/.test(gone.ingest?.error ?? "") && gone.outcome === "ok", JSON.stringify(gone));
    //  중계가 잠깐 끊긴 판 — 네 번 못 읽어도 한 시간이 안 됐으면 닫지 않는다(이미 비용을 낸 원문을 버리지 않게) · 한 시간이 넘으면 닫는다.
    await runRow("cr-sw-flaky", D_, { outcome: null, started: new Date(Date.now() - 2 * 3600_000) });
    const relay = { "cr-sw-flaky": httpErr(502, "중계 불통"), "cr-sw-lost": httpErr(502, "x"), "cr-sw-done": httpErr(502, "x") };
    for (let i = 0; i < 4; i++) await sched.collectScheduleTick(deps({ max: 0, readErr: relay, now: NOW + i * 60_000 }).d);
    const early = (await itemsPool.query(`SELECT outcome, ingest FROM collect_run WHERE run_id='cr-sw-flaky'`)).rows[0];
    await sched.collectScheduleTick(deps({ max: 0, readErr: relay, now: NOW + 3600_000 + 1000 }).d);
    const flaky = (await itemsPool.query(`SELECT outcome, ended_by, ingest FROM collect_run WHERE run_id='cr-sw-flaky'`)).rows[0];
    chk("R10c 네 번 못 읽어도 한 시간 전이면 그대로 · 한 시간이 넘으면 닫는다 — 끝 기록이 없었으면 «잃음»(게이트웨이 추정)",
      early.ingest === null && early.outcome === null && flaky.ingest?.state === "failed" && flaky.outcome === "lost" && flaky.ended_by === "gateway",
      JSON.stringify({ early, flaky }));
    //  마감을 아는 판 — 끝 기록이 없어도 마감이 지났으면(지켜보던 게이트웨이가 사라짐) 65분을 기다리지 않고 읽는다 · 마감 전이면 안 읽는다.
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    sched._resetCollectScheduleForTest();
    await runRow("cr-sw-orphan", A, { outcome: null, started: new Date(Date.now() - 25 * 60_000), deadline: new Date(Date.now() - 7 * 60_000) });
    await runRow("cr-sw-live", B, { outcome: null, started: new Date(Date.now() - 25 * 60_000), deadline: new Date(Date.now() + 30 * 60_000) });
    t = deps({ max: 0 });
    await sched.collectScheduleTick(t.d);
    chk("R10d 끝 기록 없는 판은 그 판의 마감이 지나면 읽는다(65분을 기다리지 않는다) · 마감 전이면 안 읽는다",
      JSON.stringify(t.read) === JSON.stringify([`${A}:cr-sw-orphan`]), JSON.stringify(t.read));
    //  닫는 판이 건 단위 임대는 풀린다 — 임대 끝(마감 + 여유)까지 묶이지 않게.
    const lu = await makeUnit(CH(44), C);
    await leaseUnits([lu.id], "cr-sw-closing", Date.now() + 23 * 60_000);
    await runRow("cr-sw-closing", C, { outcome: "ok", ended: new Date(NOW - 60_000) });
    const gone2 = { "cr-sw-closing": httpErr(404, "없음") };
    for (let i = 0; i < 2; i++) await sched.collectScheduleTick(deps({ max: 0, readErr: gone2 }).d);
    const lu2 = await unitBy(CH(44));
    chk("R10e 훑기가 닫은 판이 건 단위 임대는 풀린다 — 다음 확인이 지금 + 10분 안",
      lu2.sched?.lease == null && new Date(lu2.next_at).getTime() <= Date.now() + 600_000 + 1000,
      JSON.stringify({ next: lu2.next_at, sched: lu2.sched }));
  }

  // ── R11 저장 단계가 단위마다 다음 확인을 적는다 ──
  {
    await cleanup(); await addMembers();
    sched._resetCollectScheduleForTest();
    const u = await makeUnit(CH(30), A);
    const v = await makeUnit(CH(31), A);
    const nu = await makeUnit(NOTION_REF, A, { app: "notion" });
    const PLANNED = NOW_SEC;
    const since = `${PLANNED - 3 * DAY}.000000`;
    const chFile = (ch, msgs) => ({
      tool_name: "mcp__claude_ai_Slack__slack_read_channel", tool_input: { channel_id: ch, oldest: since, limit: 100 },
      tool_response: [{ type: "text", text: JSON.stringify({
        messages: [`Channel: #c (${ch})`, "", ...msgs.flatMap(([ts, body]) => [`=== Message from Kim <k@x.test> (U0CISCH01) at x ===`, `Message TS: ${ts}`, body, ""])].join("\n"),
        pagination_info: "There are no more messages available.\n" }) }],
    });
    const notionErr = { tool_name: "mcp__claude_ai_Notion__notion-fetch", tool_input: { id: NOTION_REF },
      tool_response: [{ type: "text", text: JSON.stringify({ error: "rate limited" }) }] };
    await leaseUnits([u.id, v.id, nu.id], "cr-r11", NOW + 20 * 60_000);
    const res = await ingestRun({
      member: A, now: NOW, runId: "cr-r11",
      plan: { mode: "collect", planned_at: PLANNED, units: [
        { id: u.id, app: "slack", instance: TEAM, ref: CH(30), kind: "channel", connector: "Slack", since, until: null },
        { id: v.id, app: "slack", instance: TEAM, ref: CH(31), kind: "channel", connector: "Slack", since, until: null },
        { id: nu.id, app: "notion", instance: "", ref: NOTION_REF, kind: "page", connector: "Notion", since: null, until: null },
      ] },
      files: [chFile(CH(30), [[`${PLANNED - 2 * DAY}.000100`, "하나"], [`${PLANNED - DAY}.000200`, "둘"], [`${PLANNED - H}.000300`, "셋"]]), notionErr],
    });
    const a = await unitBy(CH(30)), b = await unitBy(CH(31)), n = await unitBy(NOTION_REF, "notion");
    const pa = res.per_unit?.find((p) => p.id === u.id), pb = res.per_unit?.find((p) => p.id === v.id), pn = res.per_unit?.find((p) => p.id === nu.id);
    chk("R11a 다 읽은 단위 — 표본(3일 구간에 3개) · 주기 3시간 · 다음 확인 = 지금 + 3시간 · 임대가 판정으로 바뀐다 · 실행 기록에도 next",
      a.sched?.hist?.length === 1 && a.sched.hist[0].n === 3 && a.sched.hist[0].e === PLANNED - NOW_MARGIN_SEC && a.interval_sec === 3 * H
        && new Date(a.next_at).getTime() === NOW + 3 * H * 1000 && a.sched?.lease == null && pa?.next?.why === "interval" && pa?.next?.interval_sec === 3 * H,
      JSON.stringify({ sched: a.sched, iv: a.interval_sec, next: a.next_at, pa: pa?.next }));
    chk("R11b 맡겼는데 안 읽은 단위 — 10분 물러섬 · 위치·읽은 시각은 그대로 · 임대 풀림",
      new Date(b.next_at).getTime() === NOW + 600_000 && b.sched?.why === "retry" && b.read_at === null && b.sched?.lease == null && pb?.next?.why === "retry",
      JSON.stringify({ next: b.next_at, sched: b.sched, read_at: b.read_at, pb: pb?.next }));
    chk("R11c 노션 fetch 가 오류 모양(못 다 읽음 · 줄일 구간 없음) — 곧바로가 아니라 물러섬(리뷰 재현: 틱마다 되풀이되던 판)",
      n.sched?.why === "retry" && new Date(n.next_at).getTime() === NOW + 600_000 && pn?.next?.why === "retry",
      JSON.stringify({ next: n.next_at, sched: n.sched, pn: pn?.next }));
    //  담당이 바뀐 뒤 늦게 끝난 옛 담당(A)의 판 — 저장 단계가 그 단위를 «안 읽음» 으로 물러세우면 새 담당(B)이 이어받을 단위가 막힌다(리뷰 2026-10-17).
    const w = await makeUnit(CH(32), A);
    await store.recordUnitListing({ member: B, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: CH(32), kind: "channel", name: "#w" }], verified: true });
    await itemsPool.query(`INSERT INTO collect_assignee_state(member_id, connector, state, since, retry_at, fails) VALUES($1,'*','login_broken',now(), now() + interval '1 hour', 1)`, [A]);
    await leaseUnits([w.id], "cr-r11d", NOW + 20 * 60_000);
    const late = await ingestRun({
      member: A, now: NOW, runId: "cr-r11d",
      plan: { mode: "collect", planned_at: PLANNED, units: [{ id: w.id, app: "slack", instance: TEAM, ref: CH(32), kind: "channel", connector: "Slack", since, until: null }] },
      files: [],
    });
    const wl = await unitBy(CH(32));
    await itemsPool.query(`DELETE FROM collect_assignee_state WHERE member_id = $1`, [A]);
    chk("R11d 지금 담당이 아닌 사람(A)의 늦은 판 — 저장 단계가 물러서기·실패 수를 쓰지 않고, 그 판이 건 임대만 풀어 새 담당(B)이 곧바로 이어받는다",
      wl.sched?.fails == null && wl.sched?.lease == null && new Date(wl.next_at).getTime() <= Date.now() + 1000
        && late.per_unit?.[0]?.next == null,
      JSON.stringify({ next: wl.next_at, sched: wl.sched, per: late.per_unit?.[0] }));
  }
  // ── R12 수집 실행 띄우기 — 같은 사람을 동시에 두 번 부르면 하나만 지나간다 ──
  {
    const run = collectRunCapabilities.find((c) => c.name === "collect_claude_run");
    if (!run) throw new Error("collect_claude_run 를 못 찾았다(배선)");
    const user = { userId: "__ci_sched_nobody__", email: "", scopes: ["items", "context", "memory"], projects: [] };
    const call = () => run.handler({ mode: "collect" }, user, { source: "pg-test" });
    const both = await Promise.allSettled([call(), call()]);
    const after = await Promise.allSettled([call()]);
    const msgs = both.map((x) => x.reason?.message ?? "");
    chk("R12 같은 사람의 동시 띄우기 둘 — 둘 다 409 지만 하나는 자리 확인에서 막히고(다른 까닭) · 끝나면 자리가 풀려 다시 앞쪽 까닭으로 막힌다",
      both.every((x) => x.status === "rejected" && x.reason?.status === 409) && msgs[0] !== msgs[1]
        && after[0].status === "rejected" && after[0].reason?.status === 409 && msgs.includes(after[0].reason?.message),
      JSON.stringify({ msgs, after: after[0].reason?.message }));
  }

  // ── S1 칸을 처음 만들 때 — 이미 주기가 적힌 단위는 고정으로 남는다 ──
  {
    await cleanup(); await addMembers();
    const fixed = await makeUnit(CH(50), A, { set: `interval_sec = 7200` });
    const free = await makeUnit(CH(51), A);
    await itemsPool.query(`ALTER TABLE collect_unit DROP COLUMN interval_auto`);
    await initV6CollectTrigger(itemsPool);
    const f = await unitBy(CH(50)), g = await unitBy(CH(51));
    await initV6CollectTrigger(itemsPool);   // 칸이 있으면 아무것도 안 한다(두 번째 부팅)
    await itemsPool.query(`UPDATE collect_unit SET interval_auto = true WHERE id = $1`, [fixed.id]);
    await initV6CollectTrigger(itemsPool);
    const f2 = await unitBy(CH(50));
    chk("S1 interval_auto 칸을 처음 만들 때 주기가 적힌 단위(리브·사람이 정한 값)는 고정 · 안 적힌 단위는 자동 · 칸이 이미 있으면 다시 안 바꾼다",
      f.interval_auto === false && f.interval_sec === 7200 && g.interval_auto === true && free.id === g.id && f2.interval_auto === true,
      JSON.stringify({ f: [f.interval_auto, f.interval_sec], g: g.interval_auto, f2: f2.interval_auto }));
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  delete process.env.LIVELY_COLLECT_SCHEDULE;
  await cleanup().catch(() => {});
  console.log(`\ncollect-schedule pg-test: ${pass} passed, ${fail} failed`);
  await itemsPool.end?.().catch?.(() => {});
}
process.exit(fail ? 1 : 0);
