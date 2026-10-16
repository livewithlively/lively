// 지속 수집 트리거(#4213 T12 #4744) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/collect/collect-schedule.pg-test.mjs
//
// 왜 이 계층인가: 기본 주기의 약속은 **표가 지키는 사실**이다 — «다 읽은 판 뒤 다음 확인 시각이 주기 뒤로 적힌다» · «주기는 빈도가 정하고
//  사람이 정하면 고정» · «모으기로 켠 단위는 곧바로» · «틱은 때가 된 단위의 담당자만, 도는 사람·실패가 이어진 사람은 빼고, 상한 안에서 띄운다» ·
//  «저장 단계를 못 탄 끝난 실행을 마저 처리하고, 못 읽는 판은 닫는다». 판정(순수)은 schedule-plan.test.ts · schedule-harvest.test.ts.
//  여기는 noteUnitRead · updateUnit · listAssignedUnits · dueAssignments · collectScheduleTick · ingestRun 을 실제 표에 대고 부른 뒤 **행을 되읽어** 판정한다.
//  수집 실행 자체(세션 컨테이너)는 띄우지 않는다 — 틱의 «띄우기·상태 읽기» 자리를 갈아 끼워 누구를 띄웠나만 본다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/collect/unit-store.js`);
const sched = await import(`${DIST}/org/collect/collect-schedule.js`);
const plan = await import(`${DIST}/org/collect/schedule-plan.js`);
const { ingestRun } = await import(`${DIST}/org/collect/run-ingest.js`);
const { NOW_MARGIN_SEC } = await import(`${DIST}/org/collect/collect-plan.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__ci_sched_a__", B = "__ci_sched_b__", C = "__ci_sched_c__", D_ = "__ci_sched_d__";
const MEMBERS = [A, B, C, D_];
const TEAM = "T_CISCHED";
const CH = (n) => `C0CISCH${String(n).padStart(3, "0")}`;
const GDRIVE_REF = "1AbCdEfGhIjKlMn";   // 수집 실행이 못 읽는 앱의 단위(R9a)
//  지금(분 단위로 내림) — 주기를 «최근 14일» 표본으로 재고, updateUnit 은 서버 시계로 다시 맞추므로 고정 날짜를 쓰면 시험이 날짜가 지나며 깨진다.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const NOW_SEC = NOW / 1000;
const H = 3600, DAY = 86400;
const iso = (ms) => new Date(ms).toISOString();

const unitBy = async (ref) => (await itemsPool.query(`SELECT * FROM collect_unit WHERE app='slack' AND instance=$1 AND ref=$2`, [TEAM, ref])).rows[0];
async function makeUnit(ref, member, o = {}) {
  await store.recordUnitListing({ member, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref, kind: "channel", name: `#${ref}` }], verified: true });
  const u = await unitBy(ref);
  await itemsPool.query(`UPDATE collect_unit SET state=$2 WHERE id=$1`, [u.id, o.state ?? "active"]);
  if (o.set) await itemsPool.query(`UPDATE collect_unit SET ${o.set} WHERE id=$1`, [u.id]);
  return unitBy(ref);
}
async function cleanup() {
  await itemsPool.query(`DELETE FROM collect_unit WHERE (app = 'slack' AND (instance=$1 OR ref LIKE 'C0CISCH%')) OR (app = 'gdrive' AND ref = $2)`, [TEAM, GDRIVE_REF]);
  await itemsPool.query(`DELETE FROM source WHERE external_system='slack' AND external_instance=$1`, [TEAM]);
  await itemsPool.query(`DELETE FROM collect_assignee_state WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [MEMBERS]);
}
/** 틱의 갈아 끼우는 자리 — 누구를 띄웠나 · 무엇을 읽었나만 적는다. */
function deps(o = {}) {
  const started = [], read = [];
  return {
    started, read,
    d: {
      force: true, now: () => o.now ?? NOW, policy: async () => o.policy ?? "allowed", running: () => new Set(o.running ?? []),
      maxConcurrent: o.max ?? 2,
      start: async (m) => { if (o.startErr?.[m]) throw o.startErr[m]; started.push(m); return { runId: `cr-test-${m}` }; },
      read: async (m, id) => { if (o.readErr?.[id]) throw o.readErr[id]; read.push(`${m}:${id}`); return {}; },
    },
  };
}
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
async function runRow(runId, member, o = {}) {
  await itemsPool.query(
    `INSERT INTO collect_run(run_id, member_id, started_at, ended_at, mode, outcome, ingest)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [runId, member, o.started ?? new Date(NOW - 10 * 60_000), o.ended ?? null, o.mode ?? "collect", o.outcome ?? null,
      o.ingest == null ? null : JSON.stringify(o.ingest)]);   // null 은 SQL NULL(JSON null 이 아니다 — 저장 단계 전)
}

try {
  await cleanup();
  sched._resetCollectScheduleForTest();
  for (const m of MEMBERS) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@cisched.test`]);

  // ── R1~R3 저장 단계 → 다음 확인 시각 ──
  {
    const u = await makeUnit(CH(1), A);
    //  다 읽은 판 — 7일에 글 70개(하루 10) → 주기 1시간.
    const r = await sched.noteUnitRead(u.id, { outcome: "complete", sample: { e: NOW_SEC - 60, s: 7 * DAY, n: 70 }, now: NOW });
    const a = await unitBy(CH(1));
    chk("R1 다 읽고 따라잡음 → 다음 확인 = 지금 + 빈도 주기(하루 10개 → 1시간) · 주기 칸도 그 값(자동) · 표본·활동량이 남는다",
      r?.why === "interval" && new Date(a.next_at).getTime() === NOW + H * 1000 && a.interval_sec === H && a.interval_auto === true
        && a.sched?.hist?.length === 1 && a.sched?.fails === 0 && a.meta?.activity?.per_day === 10,
      JSON.stringify({ r, next_at: a.next_at, interval: a.interval_sec, sched: a.sched, act: a.meta?.activity }));
    await sched.noteUnitRead(u.id, { outcome: "complete", behind: true, sample: { e: NOW_SEC - 7 * DAY, s: 7 * DAY, n: 0 }, now: NOW });
    const b = await unitBy(CH(1));
    chk("R2 다 읽었지만 밀림 → 곧바로(60초) · 표본은 둘(빈도는 14일 80…이 아니라 70/14일 = 5 → 주기 1시간)",
      new Date(b.next_at).getTime() === NOW + 60_000 && b.sched?.why === "catchup" && b.sched?.hist?.length === 2 && b.interval_sec === H && b.meta?.activity?.per_day === 5,
      JSON.stringify({ next_at: b.next_at, sched: b.sched, interval: b.interval_sec, act: b.meta?.activity }));
    await sched.noteUnitRead(u.id, { outcome: "incomplete", stuck: true, now: NOW });
    const c1 = await unitBy(CH(1));
    await sched.noteUnitRead(u.id, { outcome: "unread", now: NOW });
    const c2 = await unitBy(CH(1));
    chk("R3 못 다 읽음+더 못 줄임 → 10분 물러섬 · 이어서 안 읽음 → 20분(실패 수가 표에 남아 이어진다) · 표본은 그대로",
      new Date(c1.next_at).getTime() === NOW + 600_000 && c1.sched?.fails === 1 && new Date(c2.next_at).getTime() === NOW + 1200_000
        && c2.sched?.fails === 2 && c2.sched?.why === "retry" && c2.sched?.hist?.length === 2,
      JSON.stringify({ c1: [c1.next_at, c1.sched?.fails], c2: [c2.next_at, c2.sched] }));
    const gone = await sched.noteUnitRead(999999999, { outcome: "complete", now: NOW });
    chk("R3b 없는 단위는 조용히 null(던지지 않는다)", gone === null, JSON.stringify(gone));
  }

  // ── R4~R6 주기 고정·자동 · 모으기로 켜기 ──
  {
    const u = await makeUnit(CH(2), A, { set: `read_at = '${iso(NOW - 30 * 60_000)}'` });
    const actor = { member: A, isAdmin: false };
    await store.updateUnit(u.id, { interval_sec: 7200 }, actor);
    const p = await unitBy(CH(2));
    chk("R4 주기를 정하면 고정(interval_auto=false) · 다음 확인 = 읽은 시각 + 그 주기",
      p.interval_auto === false && p.interval_sec === 7200 && new Date(p.next_at).getTime() === NOW - 30 * 60_000 + 7200_000,
      JSON.stringify({ auto: p.interval_auto, iv: p.interval_sec, next: p.next_at }));
    await sched.noteUnitRead(u.id, { outcome: "complete", sample: { e: NOW_SEC - 60, s: DAY, n: 100 }, now: NOW });
    const p2 = await unitBy(CH(2));
    chk("R4b 고정 주기는 빈도가 바꾸지 않는다(하루 100개여도 2시간)",
      p2.interval_sec === 7200 && new Date(p2.next_at).getTime() === NOW + 7200_000 && p2.meta?.activity?.per_day === 100,
      JSON.stringify({ iv: p2.interval_sec, next: p2.next_at, act: p2.meta?.activity }));
    await store.updateUnit(u.id, { interval_sec: null }, actor);
    const p3 = await unitBy(CH(2));
    //  하루 100개 → 30분. read_at 은 noteUnitRead 가 안 옮겼으니 처음 값(30분 전) + 30분 = 지금.
    chk("R5 null 이면 다시 자동 — 지금 빈도로 곧바로 다시 맞춘다(하루 100개 → 30분) · 다음 확인 = 읽은 시각 + 그 주기",
      p3.interval_auto === true && p3.interval_sec === 1800 && new Date(p3.next_at).getTime() === NOW - 30 * 60_000 + 1800_000,
      JSON.stringify({ auto: p3.interval_auto, iv: p3.interval_sec, next: p3.next_at }));
    const q = await makeUnit(CH(3), A, { state: "candidate", set: `next_at = '${iso(NOW + DAY * 1000)}'` });
    await store.updateUnit(q.id, { state: "active" }, actor);
    const q2 = await unitBy(CH(3));
    await store.updateUnit(q.id, { description: "그대로" }, actor);
    await itemsPool.query(`UPDATE collect_unit SET next_at=$2 WHERE id=$1`, [q.id, iso(NOW + H * 1000)]);
    await store.updateUnit(q.id, { state: "active" }, actor);
    const q3 = await unitBy(CH(3));
    chk("R6 모으기로 새로 켠 단위는 다음 확인을 비운다(곧바로 처음 수집) · 이미 켜진 단위에 같은 값을 줘도 그대로",
      q2.state === "active" && q2.next_at === null && q3.next_at != null && new Date(q3.next_at).getTime() === NOW + H * 1000,
      JSON.stringify({ q2: q2.next_at, q3: q3.next_at }));
  }

  // ── R7·R8 때가 된 단위 · 곧 때가 될 단위 · 틱이 볼 담당 ──
  {
    await cleanup();
    for (const m of MEMBERS) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@cisched.test`]);
    const due = await makeUnit(CH(10), A, { set: `next_at = '${iso(NOW - 1000)}', interval_sec = 3600` });
    const soon = await makeUnit(CH(11), A, { set: `next_at = '${iso(NOW + 20 * 60_000)}', interval_sec = 3600, sched = '{"why":"interval"}'` });
    const far = await makeUnit(CH(12), A, { set: `next_at = '${iso(NOW + 50 * 60_000)}', interval_sec = 3600, sched = '{"why":"interval"}'` });
    const retry = await makeUnit(CH(13), A, { set: `next_at = '${iso(NOW + 5 * 60_000)}', interval_sec = 3600, sched = '{"why":"retry"}'` });
    const first = await makeUnit(CH(14), A);
    const off = await makeUnit(CH(15), A, { state: "candidate" });
    const only = (await store.listAssignedUnits(A, { dueOnly: true, now: NOW })).map((u) => u.ref).sort();
    const withSoon = await store.listAssignedUnits(A, { dueOnly: true, soon: true, now: NOW });
    const soonRow = withSoon.find((u) => u.ref === CH(11));
    chk("R7 때가 된 것만(다음 확인이 지남 · 처음 읽는 단위) · soon 이면 주기대로 기다리며 절반 넘게 지난 단위도 due:false 로 · 물러서는 단위·먼 단위·후보는 아님",
      JSON.stringify(only) === JSON.stringify([CH(10), CH(14)].sort())
        && withSoon.length === 3 && soonRow?.due === false && !withSoon.some((u) => [CH(12), CH(13), CH(15)].includes(u.ref)),
      JSON.stringify({ only, withSoon: withSoon.map((u) => [u.ref, u.due]) }));
    //  B 가 수집기 단위의 구성원이다(수집기가 꺼져 있으면 담당 없음 — 넘기지 않는다). C 는 단위를 못 본다.
    await makeUnit(CH(16), B, { set: `route = 'lively_collector', next_at = NULL` });
    const da = await store.dueAssignments(NOW);
    const refs = da.map((d) => d.ref).sort();
    chk("R8 틱이 볼 담당 — 구성원이 담당인 때가 된 단위만(꺼진 수집기 단위·먼 단위·후보는 아님) · 처음 읽는 단위는 때가 된 시각 0",
      JSON.stringify(refs) === JSON.stringify([CH(10), CH(14)].sort()) && da.every((d) => d.member === A)
        && da.find((d) => d.ref === CH(14))?.due_since_ms === 0 && da.find((d) => d.ref === CH(10))?.due_since_ms === NOW - 1000,
      JSON.stringify(da));
    void due; void soon; void far; void retry; void first; void off;
  }

  // ── R9 틱 — 누구를 띄우나 ──
  {
    await cleanup();
    for (const m of MEMBERS) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@cisched.test`]);
    //  같은 시험 DB 를 쓰는 앞 시험이 남긴 «때가 된 단위» · «도는 실행» 이 있으면 자리를 먹어 이 시험의 사람이 밀린다 — 이 시험 동안 비켜 둔다(시험 DB 전용).
    const foreign = (await store.dueAssignments(NOW)).filter((d) => !MEMBERS.includes(d.member)).map((d) => d.unit_id);
    if (foreign.length) await itemsPool.query(`UPDATE collect_unit SET next_at = now() + interval '1 day' WHERE id = ANY($1::int[])`, [foreign]);
    await itemsPool.query(`UPDATE collect_run SET outcome = 'lost' WHERE outcome IS NULL AND NOT (member_id = ANY($1::text[]))`, [MEMBERS]);
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
    //  B 가 도는 중(실행 기록에 끝 없음) · C 는 이 게이트웨이 안에서 도는 중 → 빈 자리 0.
    await runRow("cr-run-b", B);
    t = deps({ max: 2, running: [C] });
    r = await sched.collectScheduleTick(t.d);
    chk("R9b 도는 사람(실행 기록 · 이 게이트웨이)은 빼고, 그만큼 자리도 찬다 → 아무도 안 띄움",
      t.started.length === 0 && r.running === 2, JSON.stringify({ started: t.started, r }));
    t = deps({ max: 3, running: [C] });
    r = await sched.collectScheduleTick(t.d);
    chk("R9c 자리가 하나 남으면 남은 사람(A)만", JSON.stringify(t.started) === JSON.stringify([A]), JSON.stringify({ started: t.started, r }));
    //  A 는 최근 두 판이 연달아 실패했다 → 마지막 실패 뒤 20분 물러섬.
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    await runRow("cr-a-1", A, { started: new Date(NOW - 40 * 60_000), ended: new Date(NOW - 39 * 60_000), outcome: "ok", ingest: { state: "done" } });
    await runRow("cr-a-2", A, { started: new Date(NOW - 20 * 60_000), ended: new Date(NOW - 19 * 60_000), outcome: "timeout" });
    await runRow("cr-a-3", A, { started: new Date(NOW - 10 * 60_000), ended: new Date(NOW - 9 * 60_000), outcome: "ok", ingest: { state: "failed" } });
    t = deps({ max: 5 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9d 실패가 이어진 사람(A — 시간 초과 · 저장 단계 실패)은 물러서는 동안 안 띄운다",
      !t.started.includes(A) && t.started.includes(B) && t.started.includes(C), JSON.stringify({ started: t.started }));
    t = deps({ max: 5, now: NOW - 9 * 60_000 + 20 * 60_000 + 1000 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9e 물러섬(마지막 실패 끝 + 20분)이 지나면 다시 띄운다", t.started.includes(A), JSON.stringify({ started: t.started }));
    //  띄우기 실패 — 409(그새 다른 판)는 실패가 아니다 · 500(노드 자리 없음 등)은 그 사람만 물러선다.
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    sched._resetCollectScheduleForTest();
    t = deps({ max: 5, startErr: { [B]: httpErr(409, "이미 도는"), [C]: httpErr(500, "LVLY_NODE_CAPACITY") } });
    r = await sched.collectScheduleTick(t.d);
    chk("R9f 409 는 실패로 안 센다 · 500 은 실패로 적는다", JSON.stringify(t.started) === JSON.stringify([A])
      && r.failed.length === 1 && r.failed[0].member === C && r.failed[0].status === 500, JSON.stringify(r));
    t = deps({ max: 5 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9g 띄우기에 실패한 사람(C)은 물러서는 동안(10분) 다음 틱에도 빼고, 409 였던 사람(B)은 다시 본다",
      !t.started.includes(C) && t.started.includes(B), JSON.stringify({ started: t.started }));
    t = deps({ max: 5, now: NOW + 10 * 60_000 + 1000 });
    r = await sched.collectScheduleTick(t.d);
    chk("R9h 띄우기 물러섬이 지나면 C 도 다시", t.started.includes(C), JSON.stringify({ started: t.started }));
    //  정책 · 틱 간격 · 정책이 그새 막힘(403).
    t = deps({ policy: "blocked" });
    r = await sched.collectScheduleTick(t.d);
    chk("R9i 구성원 Claude 커넥터를 막은 워크스페이스는 아무것도 안 한다(못 읽음도 같다)", r.skipped === "policy" && t.started.length === 0 && t.read.length === 0, JSON.stringify(r));
    t = deps({ policy: "unknown" });
    chk("R9i' 정책을 못 읽으면 막음", (await sched.collectScheduleTick(t.d)).skipped === "policy");
    sched._resetCollectScheduleForTest();
    t = deps({ max: 5 });
    const first = await sched.collectScheduleTick({ ...t.d, force: false });
    const second = await sched.collectScheduleTick({ ...t.d, force: false, now: () => NOW + 30_000 });
    const third = await sched.collectScheduleTick({ ...t.d, force: false, now: () => NOW + 61_000 });
    chk("R9j 워크스페이스마다 1분에 한 번 — 30초 뒤 틱은 그냥 돌아가고 61초 뒤는 일한다",
      !first.skipped && second.skipped === "throttle" && !third.skipped, JSON.stringify({ first: first.skipped, second: second.skipped, third: third.skipped }));
    //  B 가 가장 오래 기다렸다 — B 를 띄우다 403 이 나면 뒤의 C·A 는 이 틱에 안 띄운다.
    t = deps({ max: 5, startErr: { [B]: httpErr(403, "막음") } });
    r = await sched.collectScheduleTick(t.d);
    chk("R9k 띄우는 중 정책이 막히면(403) 그 틱은 거기서 멈춘다", t.started.length === 0 && r.failed.length === 1 && r.failed[0].member === B && r.failed[0].status === 403, JSON.stringify(r));
  }

  // ── R10 훑기 — 저장 단계를 못 탄 끝난 실행 ──
  {
    await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
    sched._resetCollectScheduleForTest();
    await runRow("cr-sw-done", A, { outcome: "ok", ingest: null, ended: new Date(NOW - 5 * 60_000) });           // 끝 · 저장 전 → 읽는다
    await runRow("cr-sw-ingested", A, { outcome: "ok", ingest: { state: "done" } });                               // 이미 넣음 → 안 읽는다
    await runRow("cr-sw-running", B, { outcome: null, started: new Date(Date.now() - 5 * 60_000) });              // 도는 중 → 안 읽는다
    await runRow("cr-sw-lost", B, { outcome: null, started: new Date(Date.now() - 2 * 3600_000) });                // 상한을 넘김 → 읽는다
    await runRow("cr-sw-probe", C, { outcome: "ok", mode: "probe" });                                              // 점검 → 저장 단계 없음
    await runRow("cr-sw-gone", C, { outcome: "ok", ended: new Date(NOW - 60_000) });                               // 폴더 없음 → 닫는다
    await runRow("cr-sw-stale", C, { outcome: "ok", started: new Date(Date.now() - 3 * DAY * 1000) });             // 이틀 넘음 → 안 본다
    let t = deps({ max: 0, readErr: { "cr-sw-gone": httpErr(404, "그 수집 실행을 찾지 못했습니다") } });
    let r = await sched.collectScheduleTick(t.d);
    const gone = (await itemsPool.query(`SELECT outcome, ingest FROM collect_run WHERE run_id='cr-sw-gone'`)).rows[0];
    chk("R10a 끝났는데 저장 전인 판 · 상한을 넘긴 판을 상태 읽기로 마저 처리 — 이미 넣은 판·도는 판·점검·이틀 넘은 판은 안 본다",
      JSON.stringify(t.read.sort()) === JSON.stringify([`${A}:cr-sw-done`, `${B}:cr-sw-lost`].sort()) && r.swept === 2,
      JSON.stringify({ read: t.read, swept: r.swept }));
    chk("R10b 실행 폴더가 없는 판(404)은 «저장 단계 실패» 로 닫는다(다음 틱이 다시 집지 않게)",
      gone.ingest?.state === "failed" && /폴더/.test(gone.ingest?.error ?? "") && gone.outcome === "ok", JSON.stringify(gone));
    //  같은 판을 세 번 못 읽으면 닫는다 — 끝 기록이 없던 판은 «잃음».
    await runRow("cr-sw-flaky", D_, { outcome: null, started: new Date(Date.now() - 2 * 3600_000) });
    for (let i = 0; i < 3; i++) {
      t = deps({ max: 0, readErr: { "cr-sw-flaky": httpErr(502, "중계 불통"), "cr-sw-lost": httpErr(502, "x"), "cr-sw-done": httpErr(502, "x") } });
      await sched.collectScheduleTick(t.d);
    }
    const flaky = (await itemsPool.query(`SELECT outcome, ended_by, ingest FROM collect_run WHERE run_id='cr-sw-flaky'`)).rows[0];
    chk("R10c 세 번 못 읽은 판은 닫는다 — 끝 기록이 없었으면 «잃음»(게이트웨이 추정)",
      flaky.ingest?.state === "failed" && flaky.outcome === "lost" && flaky.ended_by === "gateway", JSON.stringify(flaky));
  }

  // ── R11 저장 단계가 단위마다 다음 확인을 적는다 ──
  {
    await cleanup();
    sched._resetCollectScheduleForTest();
    for (const m of MEMBERS) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@cisched.test`]);
    const u = await makeUnit(CH(30), A);
    const v = await makeUnit(CH(31), A);
    const PLANNED = NOW_SEC;
    const since = `${PLANNED - 3 * DAY}.000000`;
    const chFile = (ch, msgs) => ({
      tool_name: "mcp__claude_ai_Slack__slack_read_channel", tool_input: { channel_id: ch, oldest: since, limit: 100 },
      tool_response: [{ type: "text", text: JSON.stringify({
        messages: [`Channel: #c (${ch})`, "", ...msgs.flatMap(([ts, body]) => [`=== Message from Kim <k@x.test> (U0CISCH01) at x ===`, `Message TS: ${ts}`, body, ""])].join("\n"),
        pagination_info: "There are no more messages available.\n" }) }],
    });
    const res = await ingestRun({
      member: A, now: NOW,
      plan: { mode: "collect", planned_at: PLANNED, units: [
        { id: u.id, app: "slack", instance: TEAM, ref: CH(30), kind: "channel", connector: "Slack", since, until: null },
        { id: v.id, app: "slack", instance: TEAM, ref: CH(31), kind: "channel", connector: "Slack", since, until: null },
      ] },
      files: [chFile(CH(30), [[`${PLANNED - 2 * DAY}.000100`, "하나"], [`${PLANNED - DAY}.000200`, "둘"], [`${PLANNED - H}.000300`, "셋"]])],
    });
    const a = await unitBy(CH(30)), b = await unitBy(CH(31));
    const pa = res.per_unit?.find((p) => p.id === u.id), pb = res.per_unit?.find((p) => p.id === v.id);
    //  3일에 3개 = 하루 1개 → 주기 3시간.
    chk("R11a 다 읽은 단위 — 표본(3일 구간에 3개) · 주기 3시간 · 다음 확인 = 지금 + 3시간 · 실행 기록에도 next 가 실린다",
      a.sched?.hist?.length === 1 && a.sched.hist[0].n === 3 && a.sched.hist[0].e === PLANNED - NOW_MARGIN_SEC && a.interval_sec === 3 * H
        && new Date(a.next_at).getTime() === NOW + 3 * H * 1000 && pa?.next?.why === "interval" && pa?.next?.interval_sec === 3 * H,
      JSON.stringify({ sched: a.sched, iv: a.interval_sec, next: a.next_at, pa: pa?.next }));
    chk("R11b 맡겼는데 안 읽은 단위 — 10분 물러섬 · 위치·읽은 시각은 그대로",
      new Date(b.next_at).getTime() === NOW + 600_000 && b.sched?.why === "retry" && b.read_at === null && pb?.next?.why === "retry",
      JSON.stringify({ next: b.next_at, sched: b.sched, read_at: b.read_at, pb: pb?.next }));
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  await cleanup().catch(() => {});
  console.log(`\ncollect-schedule pg-test: ${pass} passed, ${fail} failed`);
  await itemsPool.end?.().catch?.(() => {});
}
process.exit(fail ? 1 : 0);
