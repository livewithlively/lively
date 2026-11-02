// 증류 잡 정비·같은 레인 겹침·1회성 시각(#5235 보강) — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/org/distill/lane-jobs.pg-test.mjs
//
//  왜 이 계층인가: 셋 다 판정 함수는 멀쩡해 보이고 **행이 어떻게 되는가**에서 틀렸다.
//   J 번호 — 레인 저장이 잡 행을 어떻게 바꾸나. 응답이 아니라 **다시 읽은 잡 행**으로 단언한다(upsert 가 꺼진 잡을 되살리는 것은 SQL 에 있다).
//   L 번호 — 두 잡이 같은 자료를 집나. 동시 실행을 **접수된 org_task 행**으로 잰다(요약 문구가 아니라).
//   O 번호 — 1회성 시각을 실제 틱으로 잰다(isDue 는 틱 안에 있다).
//   D 번호 — 줄에서 차례를 못 얻은 실행이 실행으로 기록되지 않는다. N 번호 — 수집 뒤 깨우기가 1회성의 시각을 깨지 않는다.
//
//  ⚠ 이 시험은 격리를 위해 증류 잡을 치우고 켜진 잡·레인을 끄고 활성 자료를 숨겼다가 되돌린다 — DB 이름이 `_test` 로 끝나지 않으면 시작하지 않는다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const { cronCapabilities } = await import(`${DIST}/capabilities/cron.js`);
const { ingestDistillersCapabilities } = await import(`${DIST}/capabilities/delivery/ingest-distillers.js`);
const { runSchedulerTickOnce } = await import(`${DIST}/scheduler/engine.js`);
const { upsertDistiller } = await import(`${DIST}/org/store/ingest.js`);
const { withDistillDispatch, distillDispatchLimits } = await import(`${DIST}/org/distill/dispatch-lock.js`);
const { nudgeDistillNow } = await import(`${DIST}/scheduler/actions/connector.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const T = "t5235j";                      // 이 시험만의 접두 — 남의 레인·자료와 안 섞인다
const ALL = "distill-lanes";             // 제품이 저절로 만드는 잡 — 이 시험이 지켜보는 대상
const SEEDED = "distill-local-files";
const LANE = `${T}-lane`, LANE2 = `${T}-lane2`;
const SYS = `${T}-sys`, SYS2 = `${T}-sys2`, SYS_FREE = `${T}-sys-free`;
const JOB_A = `${T}-a`, JOB_B = `${T}-b`, JOB_PIN = `${T}-pin`, JOB_CLASSIFY = `${T}-classify`;
const runner = { requester: `${T}-runner` };

const upsertLane = ingestDistillersCapabilities.find((c) => c.name === "org_distiller_upsert");
const cronRunNow = cronCapabilities.find((c) => c.name === "cron_run_now");
const cronSet = cronCapabilities.find((c) => c.name === "cron_set");
const run = (id) => cronRunNow.handler({ id });

const saveLane = (over = {}) => upsertLane.handler({
  key: LANE, enabled: true, match_system: SYS, thread_aware: false, batch_size: 10, batch_max_msgs: 100, criteria_md: "시험 기준", ...over,
}, { userId: "test" }, {});
const put = (id, params = {}, enabled = false, action = "distill_sources_headless", more = {}) => itemsPool.query(
  `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, note, fail_streak, auto_disabled_at, auto_disabled_reason)
   VALUES($1, $1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)`,
  [id, action, JSON.stringify(params), more.interval_sec ?? 3600, enabled, more.note ?? null, more.fail_streak ?? 0, more.auto_disabled_at ?? null, more.auto_disabled_reason ?? null]);
const jobRow = async (id) => (await itemsPool.query(
  `SELECT id, enabled, params, interval_sec, note, fail_streak, auto_disabled_at, auto_disabled_reason, last_run_at, version FROM org_cron WHERE id=$1`, [id])).rows[0];
const distillJobs = async () => (await itemsPool.query(`SELECT id FROM org_cron WHERE action='distill_sources_headless' ORDER BY id`)).rows.map((r) => r.id);
const dropJobs = () => itemsPool.query(`DELETE FROM org_cron WHERE action='distill_sources_headless' OR id LIKE $1`, [`${T}%`]);
const dropLanes = () => itemsPool.query(`DELETE FROM org_distiller WHERE key LIKE $1`, [`${T}%`]);

const mkSources = async (system, count, from = 0) => {
  const ids = [];
  for (let i = from; i < from + count; i++) {
    const r = await itemsPool.query(
      `INSERT INTO source(name, kind, title, body_md, external_system, external_id, fields, occurred_at)
       VALUES($1, 'slack', $1, '본문', $2, $1, '{}'::jsonb, now()) RETURNING id`, [`${system}-${i}`, system]);
    ids.push(Number(r.rows[0].id));
  }
  return ids;
};
/** 접수된 위탁 — 무엇이 나갔는지의 정본이다. */
const tasks = async () => (await itemsPool.query(
  `SELECT id, requester_session AS marker, prompt, status FROM org_task WHERE requester_session LIKE $1 ORDER BY id`, [`cron:${T}%`])).rows;
const clearRuns = async () => {
  await itemsPool.query(`DELETE FROM org_task WHERE requester_session LIKE $1`, [`cron:${T}%`]);
  await itemsPool.query(`DELETE FROM org_distiller_seen WHERE distiller_id IN (SELECT id FROM org_distiller WHERE key LIKE $1)`, [`${T}%`]);
  await itemsPool.query(`DELETE FROM org_stranded_seen WHERE source_id IN (SELECT id FROM source WHERE external_system LIKE $1)`, [`${T}%`]);
};
const laneSeen = async (ids) => Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_distiller_seen WHERE source_id = ANY($1::int[])`, [ids])).rows[0].n);
/** 위탁 지시문에 든 자료 id — 같은 자료가 두 위탁에 들었는지 본다. */
const inPrompts = (rows, ids) => ids.filter((id) => rows.filter((t) => new RegExp(`\\b${id}\\b`).test(t.prompt)).length > 1);

let parkedJobs = [], parkedEnabled = [], parkedLanes = [], parkedSources = [];
async function cleanup() {
  await clearRuns().catch(() => {});
  await dropLanes();
  await itemsPool.query(`DELETE FROM source WHERE external_system LIKE $1`, [`${T}%`]);
  await dropJobs();
  for (const j of parkedJobs) await itemsPool.query(`INSERT INTO org_cron SELECT * FROM json_populate_record(NULL::org_cron, $1::json)`, [JSON.stringify(j)]);
  if (parkedEnabled.length) await itemsPool.query(`UPDATE org_cron SET enabled=true WHERE id = ANY($1::text[])`, [parkedEnabled]);
  if (parkedLanes.length) await itemsPool.query(`UPDATE org_distiller SET enabled=true WHERE id = ANY($1::bigint[])`, [parkedLanes]);
  if (parkedSources.length) await itemsPool.query(`UPDATE source SET lifecycle='active' WHERE id = ANY($1::int[])`, [parkedSources]);
  parkedJobs = []; parkedEnabled = []; parkedLanes = []; parkedSources = [];
}

const dbName = (await itemsPool.query(`SELECT current_database() AS n`)).rows[0].n;
if (!/_test$/.test(dbName)) {
  console.error(`이 시험은 남의 잡·레인을 치우고 되돌린다 — DB '${dbName}' 은(는) 시험용이 아니라 시작하지 않습니다(이름이 _test 로 끝나야 한다)`);
  await itemsPool.end().catch(() => {});
  process.exit(1);
}

try {
  await clearRuns().catch(() => {});
  await dropLanes();
  parkedJobs = (await itemsPool.query(`DELETE FROM org_cron WHERE action='distill_sources_headless' RETURNING row_to_json(org_cron.*) AS j`)).rows.map((r) => r.j);
  parkedEnabled = (await itemsPool.query(`UPDATE org_cron SET enabled=false WHERE enabled RETURNING id`)).rows.map((r) => r.id);
  parkedLanes = (await itemsPool.query(`UPDATE org_distiller SET enabled=false WHERE enabled RETURNING id`)).rows.map((r) => r.id);
  parkedSources = (await itemsPool.query(`UPDATE source SET lifecycle='superseded' WHERE lifecycle='active' RETURNING id`)).rows.map((r) => r.id);

  // ═══ J — 레인을 켜면 생기는 잡 ═══
  {
    const r = await saveLane({ enabled: false });
    chk("J8 꺼진 채 저장 → job_plan 없음", !("job_plan" in r), JSON.stringify(r.job_plan));
    chk("J8b 꺼진 채 저장 → 잡이 안 생긴다", (await distillJobs()).length === 0, String(await distillJobs()));
  }
  {
    const r = await saveLane();
    const p = r.job_plan;
    chk("J1 잡이 없으면 만들고 그렇다고 말한다", p?.action === "create" && p?.job_id === ALL && p?.interval_sec === 600 && p?.uncovered === false, JSON.stringify(p));
    const j = await jobRow(ALL);
    chk("J1b 전체 잡이 실제로 생겼다(켜짐 · 무지정)", j?.enabled === true && !j?.params?.distiller, JSON.stringify(j));
    chk("J1c 응답의 레인 자리는 레인이다 — job_plan 이 섞이지 않는다", r.distiller?.key === LANE && !("job_plan" in r.distiller), JSON.stringify(Object.keys(r.distiller ?? {})).slice(0, 80));
    const again = await saveLane({ label: "다시 저장" });
    chk("J10 다시 저장 → 그 잡이 맡는다고 말한다 · 새 잡 없음", again.job_plan?.action === "none" && again.job_plan?.job_id === ALL && again.job_plan?.uncovered === false, JSON.stringify(again.job_plan));
    chk("J10b 잡은 그대로 하나", (await distillJobs()).join() === ALL, String(await distillJobs()));
  }
  //  J1d — 레인을 켠 채로 처음 만드는 길(화면의 «새 증류기»). 위는 이미 있는 레인을 고치는 길이라 INSERT 쪽을 안 지난다.
  {
    await dropLanes();
    await dropJobs();
    const r = await saveLane();
    chk("J1d 새 레인을 켠 채 만들어도 잡을 만들고 그렇다고 말한다", r.job_plan?.action === "create" && r.job_plan?.job_id === ALL && (await jobRow(ALL))?.enabled === true, JSON.stringify(r.job_plan));
    const plain = await upsertDistiller({ key: LANE, label: "행만" }, "test", "test");
    chk("J1e 저장소 함수는 행만 돌려준다 — 프리셋 응답에 job_plan 이 새지 않는다", plain.key === LANE && !("job_plan" in plain), JSON.stringify(Object.keys(plain)).slice(0, 80));
  }
  {
    await dropJobs();
    await put(`${T}-all`, {}, true);
    const r = await saveLane();
    chk("J2 켜진 무지정 잡이 있으면 그 잡을 말한다", r.job_plan?.action === "none" && r.job_plan?.job_id === `${T}-all` && r.job_plan?.uncovered === false, JSON.stringify(r.job_plan));
    chk("J2b 잡을 더 만들지 않는다", (await distillJobs()).join() === `${T}-all`, String(await distillJobs()));
  }
  {
    await dropJobs();
    await put(ALL, { requester: "kept" }, false, undefined, { interval_sec: 1234, note: "사람이 껐다" });
    await put(JOB_PIN, { distiller: `${T}-other` }, true);
    const before = await jobRow(ALL);
    const r = await saveLane();
    const after = await jobRow(ALL);
    chk("J3 ★ 사람이 끈 전체 잡은 전용 잡이 켜져 있어도 안 되살아난다", after.enabled === false, JSON.stringify(after));
    chk("J3b ★ 주기·params·메모도 그대로", after.interval_sec === 1234 && after.params?.requester === "kept" && after.note === "사람이 껐다" && Number(after.version) === Number(before.version), JSON.stringify(after));
    chk("J3c ★ 돌릴 잡이 없다고 말한다", r.job_plan?.action === "none" && r.job_plan?.uncovered === true && r.job_plan?.job_id === ALL, JSON.stringify(r.job_plan));
  }
  {
    await dropJobs();
    const when = new Date("2026-11-01T00:00:00Z");
    await put(ALL, {}, false, undefined, { fail_streak: 5, auto_disabled_at: when, auto_disabled_reason: "연속 실패 5회" });
    await put(JOB_PIN, { distiller: `${T}-other` }, true);
    await saveLane();
    const after = await jobRow(ALL);
    chk("J4 ★ 브레이커가 끈 잡도 안 되살아난다 · 정지 흔적이 그대로", after.enabled === false && after.fail_streak === 5 && after.auto_disabled_reason === "연속 실패 5회" && after.auto_disabled_at !== null, JSON.stringify(after));
  }
  {
    await dropJobs();
    await put(JOB_PIN, { distiller: `${T}-other` }, false);
    const r = await saveLane();
    chk("J5 증류 잡이 전부 꺼져 있으면 돌릴 잡이 없다고 말한다", r.job_plan?.action === "none" && r.job_plan?.uncovered === true, JSON.stringify(r.job_plan));
    chk("J5b 잡을 만들지 않는다", (await distillJobs()).join() === JOB_PIN, String(await distillJobs()));
  }
  {
    await dropJobs();
    await put(ALL, { distiller: `${T}-elsewhere` }, true);
    await put(JOB_PIN, { distiller: `${T}-other` }, true);
    const r = await saveLane();
    const after = await jobRow(ALL);
    chk("J6 ★ 다른 레인에 묶인 전체 잡을 덮지 않는다", after.params?.distiller === `${T}-elsewhere`, JSON.stringify(after.params));
    chk("J6b 돌릴 잡이 없다고 말한다", r.job_plan?.uncovered === true, JSON.stringify(r.job_plan));
  }
  {
    await dropJobs();
    await put(SEEDED, { distiller: "local-files", model: "sonnet" }, true);
    const r = await saveLane();
    const after = await jobRow(SEEDED);
    chk("J7 심은 잡은 넓히고 그렇다고 말한다", r.job_plan?.action === "widen" && r.job_plan?.job_id === SEEDED && !after.params?.distiller && after.params?.model === "sonnet", JSON.stringify({ p: r.job_plan, params: after.params }));
  }
  {
    await dropJobs();
    await put(JOB_PIN, { distiller: `${T}-other` }, true);
    const r = await saveLane();
    chk("J9 전체 잡이 없고 전용 잡만 켜져 있으면 만든다(종전 · #2415)", r.job_plan?.action === "create" && (await jobRow(ALL))?.enabled === true, JSON.stringify(r.job_plan));
  }
  //  J11 — 잡 목록을 읽은 뒤 쓰기 전에 다른 저장이 같은 id 를 끈 채 만들어 둔 경우. 읽기만 옛날 답을 돌려줘 그 순간을 만든다.
  {
    await dropJobs();
    await put(JOB_PIN, { distiller: `${T}-other` }, true);
    await put(ALL, {}, false, undefined, { note: "방금 다른 저장이 끄고 만들었다" });
    const real = itemsPool.query.bind(itemsPool);
    let stale = 0;
    itemsPool.query = (sql, ...rest) => {
      //  첫 읽기만 옛날 답 — 쓰기에서 지면 다시 읽어 지금 행으로 판정해야 한다.
      if (typeof sql === "string" && sql.includes("SELECT id, enabled, params FROM org_cron") && ++stale === 1) {
        return Promise.resolve({ rows: [{ id: JOB_PIN, enabled: true, params: { distiller: `${T}-other` } }] });
      }
      return real(sql, ...rest);
    };
    let r;
    try { r = await saveLane(); } finally { delete itemsPool.query; if (itemsPool.query !== real) itemsPool.query = real; }
    chk("J11 배선 — 읽기가 옛날 답을 돌려줬다", stale >= 1, `stale=${stale}`);
    const after = await jobRow(ALL);
    chk("J11b ★ 판정과 쓰기 사이에 생긴 잡을 덮지 않는다", after.enabled === false && after.note === "방금 다른 저장이 끄고 만들었다", JSON.stringify(after));
    chk("J11c ★ 만들었다고 말하지 않고, 먼저 만든 잡이 꺼져 있으면 돌릴 잡이 없다고 말한다", r.job_plan?.action === "none" && r.job_plan?.uncovered === true, JSON.stringify(r.job_plan));
  }

  // ═══ L — 같은 레인을 두 잡이 집지 못하게 ═══
  await dropJobs();
  await put(JOB_A, runner);
  await put(JOB_B, runner);
  await saveLane();
  const ids = await mkSources(SYS, 3);

  //  L1 — 무지정 잡 둘이 같은 틱에 돈다(#4052 실측 모양: 새 테넌트에 distill-lanes · distill-sources-headless 가 함께 켜짐).
  {
    const [a, b] = await Promise.all([run(JOB_A), run(JOB_B)]);
    const rows = await tasks();
    const laneTasks = rows.filter((t) => t.marker.endsWith(`#${LANE}`));
    chk("L1 배선 — 두 잡 다 돌았다", a.status === "ok" && b.status === "ok", JSON.stringify([a.status, b.status]));
    chk("L1b ★ 같은 레인 위탁은 하나다", laneTasks.length === 1, JSON.stringify(laneTasks.map((t) => t.marker)));
    chk("L1c ★ 같은 자료가 두 위탁에 안 들었다", inPrompts(rows, ids).length === 0, JSON.stringify(inPrompts(rows, ids)));
    chk("L1d 판정 기록은 한 벌", (await laneSeen(ids)) === ids.length, String(await laneSeen(ids)));
  }

  //  L3 — 앞 잡의 위탁이 도는 동안 새 자료가 왔다. 다른 잡이 그 레인의 다음 배치를 내면 레인이 두 배치로 돈다.
  const fresh = await mkSources(SYS, 2, 100);
  {
    const before = (await tasks()).length;
    const r = await run(JOB_B);
    const after = await tasks();
    chk("L3 ★ 다른 잡의 위탁이 도는 레인은 건너뛴다", after.length === before, JSON.stringify(after.map((t) => t.marker)));
    chk("L3b ★ 건너뛴 자료에 판정 기록이 안 남는다 — 다음에 나갈 수 있다", (await laneSeen(fresh)) === 0, String(await laneSeen(fresh)));
    const batch = (r.summary?.batches ?? []).find((b) => b.distiller === LANE);
    chk("L3c 건너뛴 이유를 말한다", !!batch?.skipped, JSON.stringify(r.summary).slice(0, 200));
  }
  //  L7 — 가드는 레인 단위다.
  {
    await saveLane({ key: LANE2, match_system: SYS2 });
    const other = await mkSources(SYS2, 1);
    await run(JOB_B);
    const rows = await tasks();
    chk("L7 다른 레인은 안 막힌다", rows.some((t) => t.marker.endsWith(`#${LANE2}`) && t.prompt.includes(String(other[0]))), JSON.stringify(rows.map((t) => t.marker)));
  }
  //  L4 — 앞 위탁이 끝나면 다른 잡이 이어 받는다(막기만 하면 레인이 굶는다).
  {
    await itemsPool.query(`UPDATE org_task SET status='done' WHERE requester_session LIKE $1`, [`cron:${T}%#${LANE}`]);
    await run(JOB_B);
    const rows = (await tasks()).filter((t) => t.marker === `cron:${JOB_B}#${LANE}` && t.status !== "done");
    chk("L4 앞 위탁이 끝나면 다른 잡이 이어 낸다", rows.length === 1 && fresh.every((id) => rows[0].prompt.includes(String(id))), JSON.stringify(rows.map((t) => t.marker)));
  }
  //  L5 — 카테고리 레인과 자료 레인은 key 공간이 따로다(둘 다 default 가 있다). 표식 끝만 비교하면 여기서 막힌다.
  {
    await clearRuns();
    await put(JOB_CLASSIFY, {}, false, "classify_knowledge");
    await run(JOB_A);                                                       // 위탁 행 하나를 얻는다
    await itemsPool.query(`UPDATE org_task SET requester_session=$1 WHERE requester_session=$2`, [`cron:${JOB_CLASSIFY}#${LANE}`, `cron:${JOB_A}#${LANE}`]);
    await itemsPool.query(`DELETE FROM org_distiller_seen WHERE distiller_id IN (SELECT id FROM org_distiller WHERE key = $1)`, [LANE]);
    await run(JOB_B);
    const rows = await tasks();
    chk("L5 ★ 같은 key 의 카테고리 레인 위탁은 자료 레인을 안 막는다", rows.some((t) => t.marker === `cron:${JOB_B}#${LANE}`), JSON.stringify(rows.map((t) => t.marker)));
  }
  //  L2 — 맡은 레인이 없는 자료. 표식이 cron:<잡> 이라 레인 가드가 안 듣는다 — 줄이 막아야 한다.
  {
    await clearRuns();
    const free = await mkSources(SYS_FREE, 3);
    await Promise.all([run(JOB_A), run(JOB_B)]);
    const rows = await tasks();
    const fallback = rows.filter((t) => !t.marker.includes("#"));
    chk("L2 배선 — 기본 기준 배치가 나갔다", fallback.length >= 1 && free.every((id) => fallback.some((t) => t.prompt.includes(String(id)))), JSON.stringify(fallback.map((t) => t.marker)));
    chk("L2b ★ 같은 자료가 두 기본 기준 배치에 안 들었다", inPrompts(fallback, free).length === 0, JSON.stringify(inPrompts(fallback, free)));
  }
  //  L8 — 레인 없는 배치는 표식이 cron:<잡> 하나다. 레인 가드를 넓히며 **자기 표식**을 빠뜨리면 이 경로와 증류 밖 헤드리스 잡 전부의 중첩 방지가 사라진다.
  {
    const owner = (await tasks()).find((t) => !t.marker.includes("#")).marker.slice("cron:".length);
    const before = (await tasks()).filter((t) => !t.marker.includes("#")).length;
    const extra = await mkSources(SYS_FREE, 1, 100);
    const r = await run(owner);
    const after = (await tasks()).filter((t) => !t.marker.includes("#"));
    chk("L8 ★ 앞 배치가 도는 잡은 기본 기준 배치도 새로 안 낸다(자기 표식 가드)", after.length === before, JSON.stringify(after.map((t) => t.marker)));
    chk("L8b 건너뛴 자료에 판정 기록이 안 남는다", Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_stranded_seen WHERE source_id = ANY($1::int[])`, [extra])).rows[0].n) === 0, JSON.stringify(r.summary).slice(0, 160));
  }
  //  L6 — 전용 잡이 켜진 레인은 전체 잡이 안 집는다(#4052 그대로). 줄이 이 규칙을 바꾸지 않는다.
  {
    await clearRuns();
    await put(JOB_PIN, { ...runner, distiller: LANE }, true);
    await Promise.all([run(JOB_A), run(JOB_PIN)]);
    const rows = (await tasks()).filter((t) => t.marker.endsWith(`#${LANE}`));
    chk("L6 전용 잡만 그 레인을 낸다", rows.length === 1 && rows[0].marker === `cron:${JOB_PIN}#${LANE}`, JSON.stringify(rows.map((t) => t.marker)));
  }

  // ═══ O — 1회성 잡의 시각(실제 틱) ═══
  await clearRuns();
  await dropLanes();
  await dropJobs();
  {
    const ONCE_FUTURE = `${T}-once-future`, ONCE_PAST = `${T}-once-past`, ONCE_PLAIN = `${T}-once-plain`, ONCE_REPEAT = `${T}-repeat`;
    const set = (id, over) => cronSet.handler({ id, action: "distill_sources_headless", enabled: true, ...over }, { userId: "test" }, { actor: "test" });

    //  이 달의 1일 0시가 아닌 다음 해 첫날 — 시험을 언제 돌려도 미래다.
    const future = await set(ONCE_FUTURE, { run_once: true, cron_expr: "0 0 1 1 *" });
    const firstAt = Date.parse(future.first_run_at);
    chk("O11 ★ cron_set 이 언제 도는지 말한다", Number.isFinite(firstAt) && firstAt > Date.now(), JSON.stringify(future.first_run_at));
    //  매 분 매치 + 저장이 2분 전 = 첫 매치가 이미 지났다.
    const past = await set(ONCE_PAST, { run_once: true, cron_expr: "* * * * *" });
    chk("O11b 응답의 잡 행은 그대로", past.job?.id === ONCE_PAST && past.job?.run_once === true, JSON.stringify(past.job?.id));
    await itemsPool.query(`UPDATE org_cron SET updated_at = now() - interval '2 minutes' WHERE id=$1`, [ONCE_PAST]);
    const plain = await set(ONCE_PLAIN, { run_once: true });
    chk("O12 시각 없는 1회성은 first_run_at 이 없다", !("first_run_at" in plain), JSON.stringify(plain.first_run_at));
    const repeat = await set(ONCE_REPEAT, { cron_expr: "0 0 1 1 *" });
    chk("O12b 반복 잡은 first_run_at 이 없다", !("first_run_at" in repeat), JSON.stringify(repeat.first_run_at));
    await itemsPool.query(`UPDATE org_cron SET enabled=false WHERE id=$1`, [ONCE_REPEAT]);
    const off = await set(`${T}-once-off`, { run_once: true, cron_expr: "0 0 1 1 *", enabled: false });
    chk("O12c 꺼진 1회성은 언제 돈다고 말하지 않는다 — 켜는 저장이 기준 시각을 옮긴다", !("first_run_at" in off), JSON.stringify(off.first_run_at));

    await runSchedulerTickOnce();
    //  틱은 잡을 띄우고 기다리지 않는다 — 돌아야 할 잡이 끝날 때까지 본다.
    for (let i = 0; i < 100; i++) {
      const [a, b] = [await jobRow(ONCE_PAST), await jobRow(ONCE_PLAIN)];
      if (a?.last_run_at && b?.last_run_at && a.enabled === false && b.enabled === false) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const [f, p, n] = [await jobRow(ONCE_FUTURE), await jobRow(ONCE_PAST), await jobRow(ONCE_PLAIN)];
    chk("O10 배선 — 시각 없는 1회성은 다음 틱에 돌고 꺼진다(종전)", !!n.last_run_at && n.enabled === false, JSON.stringify(n));
    chk("O10b ★ 시각이 아직이면 안 돈다(프로젝트 재현 — 다음 틱에 돌았다)", f.last_run_at === null && f.enabled === true, JSON.stringify(f));
    chk("O10c 시각이 지났으면 돌고 꺼진다", !!p.last_run_at && p.enabled === false, JSON.stringify(p));
    await runSchedulerTickOnce();
    await new Promise((res) => setTimeout(res, 200));
    chk("O10d 돈 1회성은 다시 안 돈다", String((await jobRow(ONCE_PAST)).last_run_at) === String(p.last_run_at), "");
    //  재현 — 저장 시각이 기준이다. 오래전에 만든 잡을 지금 저장했다고 지난 매치로 바로 돌지 않는다.
    const redo = await set(ONCE_FUTURE, { note: "시각은 그대로 메모만" });
    chk("O11c 수정 저장도 언제 도는지 말한다", Date.parse(redo.first_run_at) === firstAt, JSON.stringify(redo.first_run_at));

    // ═══ N — 수집 뒤 깨우기(nudgeDistillNow)는 due 를 안 본다 ═══
    await itemsPool.query(`UPDATE org_cron SET enabled=false WHERE id LIKE $1 AND id <> $2`, [`${T}%`, ONCE_FUTURE]);
    const EVERY = `${T}-every`;
    await set(EVERY, { interval_sec: 3600 });
    await nudgeDistillNow();
    const [held, every] = [await jobRow(ONCE_FUTURE), await jobRow(EVERY)];
    chk("N1 배선 — 반복 잡은 깨운다", !!every.last_run_at, JSON.stringify(every));
    chk("N2 ★ 시각을 정한 1회성은 수집 뒤에도 안 돈다 — 안 돌고 소모되지 않는다", held.last_run_at === null && held.enabled === true, JSON.stringify(held));

    // ═══ D — 줄에서 차례를 못 얻은 실행은 실행이 아니다 ═══
    await itemsPool.query(`UPDATE org_cron SET enabled=false WHERE id LIKE $1`, [`${T}%`]);
    const WAIT_ONCE = `${T}-wait-once`, WAIT_EVERY = `${T}-wait-every`;
    await set(WAIT_ONCE, { run_once: true });
    await set(WAIT_EVERY, { interval_sec: 600 });
    const earlier = new Date("2026-01-01T00:00:00Z");
    await itemsPool.query(`UPDATE org_cron SET last_run_at=$2, last_status='ok' WHERE id=$1`, [WAIT_EVERY, earlier]);
    let open = () => {};
    const holding = withDistillDispatch(() => new Promise((res) => { open = res; }));
    const usual = distillDispatchLimits.waitMs;
    distillDispatchLimits.waitMs = 20;
    let [once, cycle] = [null, null];
    try { [once, cycle] = [await run(WAIT_ONCE), await run(WAIT_EVERY)]; }
    finally { distillDispatchLimits.waitMs = usual; open(); await holding; }
    chk("D1 차례를 못 얻으면 안 돌았다고 돌려준다", once.status === "skipped" && !!once.summary?.skipped, JSON.stringify(once));
    const [w1, w2] = [await jobRow(WAIT_ONCE), await jobRow(WAIT_EVERY)];
    chk("D2 ★ 1회성이 안 돌고 소모되지 않는다", w1.last_run_at === null && w1.enabled === true, JSON.stringify(w1));
    chk("D3 ★ 주기 잡이 한 주기를 잃지 않는다 — 마지막 실행이 그대로라 다음 틱이 다시 본다", new Date(w2.last_run_at).getTime() === earlier.getTime() && cycle.status === "skipped", JSON.stringify(w2));
    await run(WAIT_ONCE);
    const w3 = await jobRow(WAIT_ONCE);
    chk("D4 줄이 풀리면 돌고 꺼진다", !!w3.last_run_at && w3.enabled === false, JSON.stringify(w3));
  }
} catch (e) {
  bad("예외", String(e?.stack ?? e));
} finally {
  await cleanup().catch((e) => bad("정리", String(e)));
  console.log(`${pass} passed, ${fail} failed`);
  await itemsPool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
