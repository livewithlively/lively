// 증류 레인 설정이 저장·실행에서 실제로 듣는지(#5235) — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/org/distill/lane-settings.pg-test.mjs
//
//  왜 이 계층인가: 두 결함 다 «저장은 200 인데 동작이 안 바뀐다» 였다. 판정 함수만 재면 그 함수가 저장 경로에 어떻게 이어졌는지를
//   못 잰다(빈 값을 «비우려는 저장» 으로 보느냐, 현재 값을 되돌려 보낸 것으로 보느냐가 upsertDistiller 안에 있다). 그래서 실제 행으로 잰다.
//   ② 레인 목적지 — D 번호는 사양의 행. 응답이 아니라 **다시 읽은 행**으로 단언한다.
//   ③ 실행 전 안내·레인 몫만 — R 번호는 사양의 행. 무엇이 나갔는지는 요약 문구가 아니라 **접수된 org_task 행**으로 단언한다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const { upsertDistiller } = await import(`${DIST}/org/store/ingest.js`);
const { cronCapabilities } = await import(`${DIST}/capabilities/cron.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const cronRunNow = cronCapabilities.find((c) => c.name === "cron_run_now");
const run = (input) => cronRunNow.handler(input);
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const T = "t5235";                       // 이 시험만의 접두 — 남의 레인·축·자료와 안 섞인다
const JOB = `${T}-job`, OTHER_JOB = `${T}-other`, PIN_JOB = `${T}-pin`;
const SYS_LANE = `${T}-sys-lane`, SYS_FREE = `${T}-sys-free`;
const MEMBER = `${T}-member`;

const mkCategory = (key, state = "active") => itemsPool.query(
  `INSERT INTO category(key, name, origin, state) VALUES($1, $1, 'agent', $2)`, [key, state]);
const mkSources = async (system, count) => {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const r = await itemsPool.query(
      `INSERT INTO source(name, kind, title, body_md, external_system, external_id, fields, occurred_at)
       VALUES($1, 'slack', $1, '본문', $2, $1, '{}'::jsonb, now()) RETURNING id`, [`${system}-${i}`, system]);
    ids.push(Number(r.rows[0].id));
  }
  return ids;
};
const target = async (key) => (await itemsPool.query(`SELECT target_category FROM org_distiller WHERE key=$1`, [key])).rows[0]?.target_category ?? null;
/** 접수된 위탁 — 레인 배치는 cron:<잡>#<레인>, 기본 기준 배치는 cron:<잡>. 무엇이 나갔는지의 정본이다. */
const tasks = async () => (await itemsPool.query(
  `SELECT requester_session AS marker, prompt FROM org_task WHERE requester_session LIKE $1 ORDER BY id`, [`cron:${T}%`])).rows;
const clearRuns = async () => {
  await itemsPool.query(`DELETE FROM org_task WHERE requester_session LIKE $1`, [`cron:${T}%`]);
  await itemsPool.query(`DELETE FROM org_distiller_seen WHERE distiller_id IN (SELECT id FROM org_distiller WHERE key LIKE $1)`, [`${T}%`]);
  await itemsPool.query(`DELETE FROM org_stranded_seen WHERE source_id IN (SELECT id FROM source WHERE external_system LIKE $1)`, [`${T}%`]);
};
const lane = (over = {}) => upsertDistiller({
  key: `${T}-lane`, enabled: true, match_system: SYS_LANE, thread_aware: false, batch_size: 10, batch_max_msgs: 100,
  criteria_md: "시험 기준", ...over,
}, "test", "test");

//  다른 시험이 남긴 켜진 레인·자료가 있으면 «맡은 레인이 없는 자료 N건» 을 정확히 못 잰다 — 시험 동안만 치워 두고 되돌린다.
let parkedLanes = [], parkedSources = [], cronBefore = null;
async function cleanup() {
  await clearRuns().catch(() => {});
  await itemsPool.query(`DELETE FROM org_distiller WHERE key LIKE $1 OR key LIKE $2`, [`${T}%`, `liv-${T}%`]);
  await itemsPool.query(`DELETE FROM category WHERE key LIKE $1`, [`${T}%`]);
  await itemsPool.query(`DELETE FROM source WHERE external_system LIKE $1`, [`${T}%`]);
  await itemsPool.query(`DELETE FROM org_cron WHERE id LIKE $1`, [`${T}%`]);
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [MEMBER]);
  //  레인을 켜면 upsertDistiller 가 전체 잡을 마련한다(#2415) — 이 시험이 만들게 한 잡만 지운다.
  if (cronBefore) await itemsPool.query(`DELETE FROM org_cron WHERE NOT (id = ANY($1::text[]))`, [cronBefore]);
  if (parkedLanes.length) await itemsPool.query(`UPDATE org_distiller SET enabled=true WHERE id = ANY($1::bigint[])`, [parkedLanes]);
  if (parkedSources.length) await itemsPool.query(`UPDATE source SET lifecycle='active' WHERE id = ANY($1::int[])`, [parkedSources]);
  parkedLanes = []; parkedSources = [];
}

try {
  await cleanup();
  cronBefore = (await itemsPool.query(`SELECT id FROM org_cron`)).rows.map((r) => r.id);
  parkedLanes = (await itemsPool.query(`UPDATE org_distiller SET enabled=false WHERE enabled RETURNING id`)).rows.map((r) => r.id);
  parkedSources = (await itemsPool.query(`UPDATE source SET lifecycle='superseded' WHERE lifecycle='active' RETURNING id`)).rows.map((r) => r.id);

  // ═══ ② 레인 목적지 ═══
  await mkCategory(`${T}-a`);
  await mkCategory(`${T}-b`);
  await mkCategory(`${T}-dep`, "deprecated");
  const A = `${T}-a`, B = `${T}-b`, DEP = `${T}-dep`;
  const KA = `liv-${A}`, KX = `liv-${T}-x`, KDEP = `liv-${DEP}`;
  /** 없는 서랍이 박힌 레인 — 지금 코드로는 못 만드니 행을 직접 놓는다(그 상태로 남아 있는 조직이 고칠 수 있어야 한다). */
  const stuck = (key, value) => itemsPool.query(`UPDATE org_distiller SET target_category=$2 WHERE key=$1`, [key, value]);

  await upsertDistiller({ key: KA }, "test", "test");
  chk("D1 새 레인 · 목적지 미지정 · 서랍 있음 → 키에서 채운다", (await target(KA)) === A, String(await target(KA)));

  await upsertDistiller({ key: KX }, "test", "test");
  chk("D2 새 레인 · 목적지 미지정 · 서랍 없음 → 없는 서랍을 박지 않는다", (await target(KX)) === null, String(await target(KX)));

  await stuck(KX, `${T}-x`);
  await upsertDistiller({ key: KX, target_category: null }, "test", "test");
  chk("D3 없는 서랍이 박힌 레인 · null → 실제로 비워진다", (await target(KX)) === null, String(await target(KX)));

  await stuck(KX, `${T}-x`);
  await upsertDistiller({ key: KX, target_category: "" }, "test", "test");
  chk("D4 없는 서랍이 박힌 레인 · 빈 문자열 → 실제로 비워진다", (await target(KX)) === null, String(await target(KX)));

  {
    const e = await refused(() => upsertDistiller({ key: KA, target_category: null }, "test", "test"));
    chk("D5 서랍 있음 · null → 400", e?.status === 400, String(e?.status ?? e));
    chk("D5b 거절 이유가 서랍과 고칠 길을 말한다", e && e.message.includes(A) && e.message.includes("비울 수 없습니다"), e?.message);
    chk("D5c 거절되면 값은 그대로다", (await target(KA)) === A, String(await target(KA)));
    const e2 = await refused(() => upsertDistiller({ key: KA, target_category: "   " }, "test", "test"));
    chk("D6 서랍 있음 · 공백만 → 400", e2?.status === 400, String(e2?.status ?? e2));
  }

  await upsertDistiller({ key: KA, note: "부분 갱신" }, "test", "test");
  chk("D7 목적지를 안 보낸 부분 갱신 → 유지", (await target(KA)) === A, String(await target(KA)));

  await upsertDistiller({ key: KA, target_category: B }, "test", "test");
  chk("D13 다른 활성 카테고리로 옮긴다", (await target(KA)) === B, String(await target(KA)));
  {
    const e = await refused(() => upsertDistiller({ key: KA, target_category: null }, "test", "test"));
    chk("D8 옮긴 레인도 서랍이 있으면 비우기는 거절", e?.status === 400 && (await target(KA)) === B, String(e?.status ?? e));
  }

  await stuck(KA, null);
  await upsertDistiller({ key: KA, target_category: null, enabled: false }, "test", "test");
  chk("D9 이미 빈 목적지를 되돌려 보낸 저장(스위치) → 막지 않고 되살린다", (await target(KA)) === A, String(await target(KA)));

  await stuck(KA, null);
  await upsertDistiller({ key: KA, note: "다시" }, "test", "test");
  chk("D10 빈 목적지 · 미지정 · 서랍 있음 → 되살린다", (await target(KA)) === A, String(await target(KA)));

  await stuck(KX, null);
  await upsertDistiller({ key: KX, target_category: null }, "test", "test");
  chk("D11 빈 목적지 · null · 서랍 없음 → 빈 채로", (await target(KX)) === null, String(await target(KX)));

  await upsertDistiller({ key: KX, note: "다시" }, "test", "test");
  chk("D12 빈 목적지 · 미지정 · 서랍 없음 → 없는 서랍이 되살아나지 않는다", (await target(KX)) === null, String(await target(KX)));

  {
    const e = await refused(() => upsertDistiller({ key: KA, target_category: `${T}-ghost` }, "test", "test"));
    chk("D14 없는 카테고리 명시 → 400(기존 규칙)", e?.status === 400 && (await target(KA)) === A, String(e?.status ?? e));
  }

  await upsertDistiller({ key: KDEP }, "test", "test");
  await stuck(KDEP, DEP);
  await upsertDistiller({ key: KDEP, target_category: null }, "test", "test");
  chk("D15 비활성 서랍은 없는 서랍과 같다 → 비워진다", (await target(KDEP)) === null, String(await target(KDEP)));

  await upsertDistiller({ key: `${T}-plain`, target_category: B }, "test", "test");
  await upsertDistiller({ key: `${T}-plain`, target_category: null }, "test", "test");
  chk("D17 서랍 레인이 아니면 비우기가 그대로 먹는다", (await target(`${T}-plain`)) === null, String(await target(`${T}-plain`)));

  {
    const e = await refused(() => upsertDistiller({ key: `liv-${B}`, target_category: null }, "test", "test"));
    const row = (await itemsPool.query(`SELECT 1 FROM org_distiller WHERE key=$1`, [`liv-${B}`])).rowCount;
    chk("D18 새 레인 · 빈 값 명시 · 서랍 있음 → 400 이고 만들어지지 않는다", e?.status === 400 && row === 0, String(e?.status ?? e));
  }

  await stuck(KX, `${T}-ghost`);
  await upsertDistiller({ key: KX, note: "무관한 저장" }, "test", "test");
  chk("D20 없는 값이 박힌 레인의 무관한 저장을 막지 않는다", (await target(KX)) === `${T}-ghost`, String(await target(KX)));

  await itemsPool.query(`DELETE FROM org_distiller WHERE key LIKE $1`, [`liv-${T}%`]);
  await itemsPool.query(`DELETE FROM org_distiller WHERE key LIKE $1`, [`${T}%`]);

  // ═══ ③ 레인을 지정하지 않은 증류 실행 ═══
  const put = (id, action, params, enabled = false) => itemsPool.query(
    `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled) VALUES($1, $1, $2, $3::jsonb, 3600, $4)`,
    [id, action, JSON.stringify(params), enabled]);
  const jobParams = { requester: `${T}-runner` };
  await put(JOB, "distill_sources_headless", jobParams);
  await put(PIN_JOB, "distill_sources_headless", { ...jobParams, distiller: `${T}-lane` });
  await put(OTHER_JOB, "refresh_repo", { repo: "x" });

  //  전제 — 켜진 레인이 없을 때: 자료를 넣기 전에는 아무것도 안 나간다.
  {
    const r = await run({ id: JOB, dry_run: true });
    chk("전제 자료가 없으면 나갈 것이 없다", r.plan.lanes.length === 0 && r.plan.unassigned === null, JSON.stringify(r.plan));
  }

  const laneIds = await mkSources(SYS_LANE, 2);
  const freeIds = await mkSources(SYS_FREE, 3);
  await lane();

  // R1 · R2
  {
    const r = await run({ id: JOB, dry_run: true });
    const l = r.plan.lanes.find((x) => x.distiller === `${T}-lane`);
    chk("R1 레인 몫을 말한다", r.plan.lanes.length === 1 && l?.sources === 2 && l?.backlog === 2, JSON.stringify(r.plan));
    chk("R1b 기본 기준으로 나갈 자료를 말한다", r.plan.unassigned?.sources === 3 && r.plan.unassigned?.total === 3, JSON.stringify(r.plan));
    chk("R1c 응답 상태는 dry_run — 실행과 헷갈리지 않는다", r.status === "dry_run", r.status);
    chk("R1d 고를 길을 말한다", /lanes_only/.test(String(r.plan.notice)), String(r.plan.notice));
    chk("R2 접수된 위탁 0건", (await tasks()).length === 0, JSON.stringify(await tasks()));
    const job = (await itemsPool.query(`SELECT last_run_at, last_status FROM org_cron WHERE id=$1`, [JOB])).rows[0];
    chk("R2b 잡 기록이 안 바뀐다", job.last_run_at === null && job.last_status === null, JSON.stringify(job));
    const seen = Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_stranded_seen WHERE source_id = ANY($1::int[])`, [freeIds])).rows[0].n);
    const dseen = Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_distiller_seen WHERE source_id = ANY($1::int[])`, [laneIds])).rows[0].n);
    chk("R2c 판정 기록이 안 남는다", seen === 0 && dseen === 0, `stranded=${seen} lane=${dseen}`);
  }

  // R4 — 옵션 없이 돌리면 종전대로 둘 다 나간다. 이게 없으면 아래 R3 의 «없다» 가 무엇을 재는지 모른다(배선 단언).
  {
    await clearRuns();
    await run({ id: JOB });
    const t = await tasks();
    const markers = t.map((x) => x.marker).sort();
    chk("R4 옵션 없이 실행 → 레인 + 기본 기준 배치 둘 다 접수(#1631 그대로)",
      markers.length === 2 && markers[0] === `cron:${JOB}` && markers[1] === `cron:${JOB}#${T}-lane`, JSON.stringify(markers));
    const fallback = t.find((x) => x.marker === `cron:${JOB}`);
    chk("R4b 기본 기준 배치가 맡은 레인 없는 자료를 집었다", freeIds.every((id) => fallback?.prompt.includes(String(id))), String(fallback?.prompt).slice(0, 200));
  }

  // R3 — 레인 몫만
  {
    await clearRuns();
    const r = await run({ id: JOB, lanes_only: true });
    const markers = (await tasks()).map((x) => x.marker);
    chk("R3 lanes_only → 레인 배치만 접수 · 기본 기준 배치 0건", markers.length === 1 && markers[0] === `cron:${JOB}#${T}-lane`, JSON.stringify(markers));
    const seen = Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_stranded_seen WHERE source_id = ANY($1::int[])`, [freeIds])).rows[0].n);
    chk("R3b 뺀 자료에 판정 기록이 안 남는다 — 다음 실행에서 그대로 나갈 수 있다", seen === 0, `seen=${seen}`);
    chk("R3c 요약이 레인 몫만 돌렸다고 말한다", r.summary?.lanes_only === true, JSON.stringify(r.summary));
    const saved = (await itemsPool.query(`SELECT params FROM org_cron WHERE id=$1`, [JOB])).rows[0].params;
    chk("R3d 잡 설정은 안 바뀐다(이번 1회뿐)", !("lanes_only" in saved), JSON.stringify(saved));
    const after = await run({ id: JOB, dry_run: true });
    chk("R3e 다음 실행 안내에 그 자료가 그대로 있다", after.plan.unassigned?.sources === 3, JSON.stringify(after.plan));
  }

  // R5
  {
    await clearRuns();
    const r = await run({ id: JOB, dry_run: true, lanes_only: true });
    chk("R5 dry_run + lanes_only → 맡은 레인 없는 자료를 뺀 계획", r.plan.unassigned === null && r.plan.lanes.length === 1, JSON.stringify(r.plan));
  }

  // R8 — 레인이 전부 맡으면 묻지 않는다
  {
    await upsertDistiller({ key: `${T}-all`, enabled: true, thread_aware: false, batch_size: 10, batch_max_msgs: 100, criteria_md: "넓은 레인", priority: -100 }, "test", "test");
    const r = await run({ id: JOB, dry_run: true });
    chk("R8 맡은 레인 없는 자료 0건 → unassigned 없음", r.plan.unassigned === null && r.plan.notice === null, JSON.stringify(r.plan));
    await itemsPool.query(`DELETE FROM org_distiller WHERE key=$1`, [`${T}-all`]);
  }

  // R9 — 레인 몫이 없고 맡은 레인 없는 자료만 남았다
  {
    await lane({ match_system: `${T}-sys-none` });
    const plan = (await run({ id: JOB, dry_run: true })).plan;
    chk("R9 전제 — 레인 몫 0건 · 기본 기준 자료는 있다", plan.lanes.length === 0 && plan.unassigned?.sources === 5, JSON.stringify(plan));
    await clearRuns();
    const r = await run({ id: JOB, lanes_only: true });
    chk("R9b lanes_only → 접수 0건", (await tasks()).length === 0, JSON.stringify(await tasks()));
    chk("R9c 없는 것이 아니라 뺀 것이라고 말한다", /뺐습니다/.test(String(r.summary?.skipped)) && r.summary?.stranded === undefined, JSON.stringify(r.summary));
    await lane();
  }

  // R12 — 한 레인에 묶인 잡은 애초에 기본 기준 배치를 안 낸다
  {
    const r = await run({ id: PIN_JOB, dry_run: true });
    chk("R12 묶인 잡 → 그 레인만 · unassigned 없음", r.plan.lanes.length === 1 && r.plan.unassigned === null, JSON.stringify(r.plan));
  }

  // R10 · R11 — 듣지 않을 값을 조용히 받지 않는다
  {
    for (const opt of [{ dry_run: true }, { lanes_only: true }]) {
      const e = await refused(() => run({ id: OTHER_JOB, ...opt }));
      chk(`R10 증류가 아닌 잡에 ${Object.keys(opt)[0]} → 400`, e?.status === 400, String(e?.status ?? e));
    }
    const job = (await itemsPool.query(`SELECT last_run_at FROM org_cron WHERE id=$1`, [OTHER_JOB])).rows[0];
    chk("R10b 거절되면 그 잡은 안 돈다", job.last_run_at === null, JSON.stringify(job));
    const e = await refused(() => run({ id: `${T}-none`, dry_run: true }));
    chk("R11 없는 잡 → 404", e?.status === 404, String(e?.status ?? e));
    const r = await run({ id: `${T}-none` });
    chk("R11b 옵션 없는 호출의 종전 응답은 그대로", r.status === "error", JSON.stringify(r));
  }

  // R13 — 배치 상한 경계
  {
    await mkSources(`${T}-sys-many`, 48);   // 맡은 레인 없는 자료 3 + 48 = 51
    const r = await run({ id: JOB, dry_run: true });
    chk("R13 51건 → 이번 50건 · 전체 51건", r.plan.unassigned?.sources === 50 && r.plan.unassigned?.total === 51, JSON.stringify(r.plan.unassigned));
    await itemsPool.query(`DELETE FROM source WHERE external_system=$1`, [`${T}-sys-many`]);
  }

  // R14 — 처음 설정 대기 중이면 실행과 같은 말을 한다
  {
    const welcome = { flow: "files", done_at: new Date().toISOString(), upload_started_at: new Date().toISOString() };
    await itemsPool.query(`INSERT INTO org_member(id, display_name, state, kind, liv_profile) VALUES($1, $1, 'active', 'human', $2::jsonb)`, [MEMBER, JSON.stringify({ welcome })]);
    const r = await run({ id: JOB, dry_run: true });
    chk("R14 처음 설정 대기 → 나갈 것 없음 · 이유를 말한다", r.plan.lanes.length === 0 && r.plan.unassigned === null && /처음 설정/.test(String(r.plan.skipped)), JSON.stringify(r.plan));
    await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [MEMBER]);
  }

  // R6 · R7 — 켜진 레인이 하나도 없다(마지막에 둔다 — 레인을 끈다)
  {
    await itemsPool.query(`UPDATE org_distiller SET enabled=false WHERE key LIKE $1`, [`${T}%`]);
    await clearRuns();
    const r = await run({ id: JOB, dry_run: true });
    chk("R6 켜진 레인 없음 → 전부 기본 기준 자료", r.plan.lanes.length === 0 && r.plan.unassigned?.sources === 5 && r.plan.unassigned?.total === 5, JSON.stringify(r.plan));
    const lo = await run({ id: JOB, lanes_only: true });
    chk("R7 lanes_only → 접수 0건", (await tasks()).length === 0, JSON.stringify(await tasks()));
    chk("R7b «미증류 자료 없음» 이라고 거짓말하지 않는다", /켜진 증류기가 없어/.test(String(lo.summary?.skipped)) && !/미증류 자료 없음/.test(String(lo.summary?.skipped)), JSON.stringify(lo.summary));
    const dry = await run({ id: JOB, dry_run: true, lanes_only: true });
    chk("R7c dry_run 도 같은 이유를 말한다", /켜진 증류기가 없어/.test(String(dry.plan.skipped)), JSON.stringify(dry.plan));
    //  레인이 없는 폴백은 판정 기록을 안 본다 — 한 번 돌린 뒤에도 같은 자료가 다시 나간다. 전체 건수가 이번 건수 아래로 내려가면 거짓이다.
    await run({ id: JOB });
    await clearRuns();
    await itemsPool.query(`INSERT INTO org_stranded_seen(source_id, task_id) SELECT id, NULL FROM source WHERE external_system LIKE $1`, [`${T}%`]);
    const again = await run({ id: JOB, dry_run: true });
    chk("R6c 판정 기록이 있어도 이번 건수 ≤ 전체 건수", again.plan.unassigned?.sources === 5 && again.plan.unassigned?.total === 5, JSON.stringify(again.plan.unassigned));
  }

  // REST 어댑터 — 본문을 안 보낸 종전 호출(POST /cron/:id/run)이 그대로 돈다.
  {
    const parse = cronRunNow.expose.rest[0].parse;
    const empty = parse({ params: { id: "x" } });
    chk("REST 본문 없음 → 두 값 다 꺼짐", empty.dry_run === false && empty.lanes_only === false, JSON.stringify(empty));
    const on = parse({ params: { id: "x" }, body: { dry_run: true, lanes_only: true } });
    chk("REST 본문의 값을 읽는다", on.dry_run === true && on.lanes_only === true, JSON.stringify(on));
    const str = parse({ params: { id: "x" }, body: { dry_run: "false" } });
    chk("REST 불리언이 아닌 값은 꺼짐", str.dry_run === false, JSON.stringify(str));
  }
} catch (e) {
  bad("예외", (e && e.stack) || String(e));
} finally {
  await cleanup().catch((e) => bad("정리", String(e)));
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
