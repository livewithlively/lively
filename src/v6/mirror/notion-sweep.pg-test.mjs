// 노션 전체 점검 스윕의 **수집기 몫**(#4059) PG 통합 테스트 — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서(스키마 체인 스텝 뒤), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/v6/mirror/notion-sweep.pg-test.mjs
//
//  왜 이 계층인가: 사고(soltimal 2026-09-17 — 8페이지만 맡은 수집기가 같은 워크스페이스 5,385건을 아카이브)의
//   판정이 전부 SQL 조건이다 — jsonb 표식 떼기·«아무도 안 맡음» 조건·비게 된 시각 비교. 목 러너로는 조건 하나를
//   지워도 초록이다. 그래서 실 DB 에 행을 깔고 **스윕 뒤 lifecycle·표식을 다시 읽어** 판정한다.
//  모든 행은 이 테스트만의 external_instance(`__sweep_pg__…`)에 둔다 — 남의 자료와 절대 안 섞인다.

const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const mirror = await import(`${DIST}/v6/connector-mirror.js`);
const peersMod = await import(`${DIST}/connectors/notion/sweep-peers.js`);
const { sweepNotionArchived, observeNotionRows, countNotionClaimedSince, loadNotionLedger, mirrorExternalToV6 } = mirror;
const { planNotionSweep, loadNotionSweepPeers, recordNotionSweepReady, SWEEP_STATE_SYSTEM } = peersMod;

delete process.env.ANTHROPIC_API_KEY; // 신규 적재 분류기(LLM) 호출 금지 — 정책 축만

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "__sweep_pg__";
const AX = (s) => `${P}${s}`;                         // 테스트 전용 축
const C = "notion:__sweep_pg__coo";                   // 스윕하는 수집기 표식
const D = "notion:__sweep_pg__cpo";                   // 같은 워크스페이스의 다른 수집기 표식
const ext = (s) => `${P}${s}`;
const nameOf = (s) => `notion-${ext(s)}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");

// run-sync 와 같은 식 — 점검 시작 시각을 마이크로초까지 문자열로(JS Date 를 거치면 밀리초로 잘린다).
const now = async () => (await itemsPool.query(
  `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`)).rows[0].t;
// pg 는 timestamptz 를 Date 로 돌려준다 — Date.parse(Date) 는 문자열화를 거쳐 밀리초를 버리므로 쓰지 않는다.
const ms = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));
const ago = (iso, ms) => new Date(Date.parse(iso) - ms).toISOString();
const H = 3_600_000;

/** 행 한 줄 — 표식·비게 된 시각·만든 시각·마지막 적재 시각을 직접 깐다. */
async function mk(id, { ax, lifecycle = "active", seen = null, unclaimedSince = null, createdAt = null, syncedAt = null } = {}) {
  const st = {};
  if (seen) st.seen_by = seen;
  if (unclaimedSince) st.unclaimed_since = unclaimedSince;
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source,
                           external_system, external_instance, external_id, last_synced_at, created_at, sync_state)
     VALUES($1, $2, 'b', 'recalled', 'observed', $3, 'observed', 'notion', 'notion', $4, $5, $6, COALESCE($7, now()), $8::jsonb)`,
    [nameOf(id), id, lifecycle, ax, ext(id), syncedAt, createdAt, JSON.stringify(st)]);
}
const row = async (id) => (await itemsPool.query(
  `SELECT lifecycle, sync_state, last_synced_at FROM knowledge WHERE name=$1`, [nameOf(id)])).rows[0];
const claims = async (id) => Object.keys((await row(id))?.sync_state?.seen_by ?? {}).sort();

async function cleanup() {
  const names = (await itemsPool.query(
    `SELECT name FROM knowledge WHERE external_system='notion' AND left(external_instance, $2) = $1`, [P, P.length])).rows.map((r) => r.name);
  if (names.length) await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND entity_key = ANY($1::text[])`, [names]);
  await itemsPool.query(`DELETE FROM knowledge WHERE external_system='notion' AND left(external_instance, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM connector_state WHERE system=$1 AND position($2 in instance) > 0`, [SWEEP_STATE_SYSTEM, P]);
  await itemsPool.query(`DELETE FROM org_collector WHERE left(instance_key, $2) = $1`, [P, P.length]);
}

const SOLE = (runStartIso) => ({ archive: true, sole: true, cutoffIso: runStartIso });

try {
  await cleanup();

  // ── S1 ★사고 재현 — 좁은 수집기(C)의 깨끗한 전체 점검이 D 가 맡은 행을 건드리지 않는다. ──
  //  가장 느슨한 계획(단일로 착각 · 기준=run 시작)을 줘도 **표식만으로** 지켜져야 한다.
  {
    const ax = AX("s1");
    for (let i = 0; i < 4; i++) await mk(`s1-c${i}`, { ax, seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    for (let i = 0; i < 20; i++) await mk(`s1-d${i}`, { ax, seen: { [D]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    const S = await now();
    await observeNotionRows(itemsPool, { instance: ax, ids: [0, 1, 2, 3].map((i) => ext(`s1-c${i}`)), claimKey: C });
    const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C, plan: SOLE(S) });
    const live = (await itemsPool.query(
      `SELECT count(*)::int AS n FROM knowledge WHERE external_instance=$1 AND lifecycle='active'`, [ax])).rows[0].n;
    chk("S1 좁은 수집기의 스윕이 다른 수집기 몫 20건을 하나도 보관하지 않는다", live === 24 && r.archived === 0,
      `active=${live}/24 archived=${r.archived}`);
    chk("S1 다른 수집기의 표식은 그대로다", JSON.stringify(await claims("s1-d7")) === JSON.stringify([D]),
      `claims=${JSON.stringify(await claims("s1-d7"))}`);
    chk("S1 이번에 본 내 행은 표식이 유지된다", JSON.stringify(await claims("s1-c2")) === JSON.stringify([C]), "");
    chk("S1 떼어 낸 표식 0", r.released === 0, `released=${r.released}`);
  }

  // ── S2 레거시 행 · 다른 수집기 있음 · 준비 안 됨 → 보류(실제 수집기 행·준비 기록으로 계획을 만든다). ──
  {
    const ax = AX("s2");
    await itemsPool.query(
      `INSERT INTO org_collector(key, preset_key, instance_key, enabled, config) VALUES
         ($1, 'notion', $2, true, $3::jsonb), ($4, 'notion', $5, true, $3::jsonb)`,
      [`${P}coo`, `${P}coo`, JSON.stringify({ instance: ax }), `${P}cpo`, `${P}cpo`]);
    await mk("s2-legacy", { ax, createdAt: "2026-09-01T00:00:00Z", syncedAt: "2026-09-01T00:00:00Z" });
    const S = await now();
    const selfRow = (await itemsPool.query(`SELECT id, version FROM org_collector WHERE instance_key=$1`, [`${P}coo`])).rows[0];
    const ps = await loadNotionSweepPeers(itemsPool, { instance: ax, claimKey: C, boundId: Number(selfRow.id), boundVersion: Number(selfRow.version) });
    const plan = planNotionSweep({ runStartIso: S, selfChanged: ps.selfChanged, peers: ps.peers });
    chk("S2 실제 수집기 행에서 같은 축의 다른 수집기를 찾는다(준비 기록 없음)",
      ps.peers?.length === 1 && ps.peers[0].key === D && ps.peers[0].ready === null && !ps.selfChanged,
      JSON.stringify(ps));
    chk("S2 계획은 보류(peers_not_ready)", plan.archive === false && plan.reason === "peers_not_ready", JSON.stringify(plan));
    const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C, plan });
    chk("S2 레거시 행은 보관되지 않는다", (await row("s2-legacy")).lifecycle === "active" && r.archived === 0 && r.held === "peers_not_ready",
      JSON.stringify(r));

    // S18-real — D 가 깨끗한 점검을 마치면(판 일치) 준비. 그 뒤 D 설정이 바뀌면(판 +1) 다시 준비 아님.
    const dRow = (await itemsPool.query(`SELECT version FROM org_collector WHERE instance_key=$1`, [`${P}cpo`])).rows[0];
    const readyAt = ago(S, H);
    await recordNotionSweepReady(itemsPool, { claimKey: D, runStartIso: readyAt, boundVersion: Number(dRow.version) });
    const ps2 = await loadNotionSweepPeers(itemsPool, { instance: ax, claimKey: C, boundId: Number(selfRow.id), boundVersion: Number(selfRow.version) });
    const plan2 = planNotionSweep({ runStartIso: S, selfChanged: ps2.selfChanged, peers: ps2.peers });
    chk("S18 준비 기록(판 일치)이 있으면 보관 계획 · 기준=그 준비 시각",
      plan2.archive === true && plan2.sole === false && plan2.cutoffIso === readyAt, JSON.stringify(plan2));
    await itemsPool.query(`UPDATE org_collector SET version=version+1 WHERE instance_key=$1`, [`${P}cpo`]);
    const ps3 = await loadNotionSweepPeers(itemsPool, { instance: ax, claimKey: C, boundId: Number(selfRow.id), boundVersion: Number(selfRow.version) });
    chk("S18 준비 뒤 설정이 바뀐 수집기는 다시 준비 아님",
      planNotionSweep({ runStartIso: S, selfChanged: false, peers: ps3.peers }).archive === false, JSON.stringify(ps3));
    await itemsPool.query(`UPDATE org_collector SET enabled=false WHERE instance_key=$1`, [`${P}cpo`]);
    const ps4 = await loadNotionSweepPeers(itemsPool, { instance: ax, claimKey: C, boundId: Number(selfRow.id), boundVersion: Number(selfRow.version) });
    chk("S18 꺼진 수집기는 다른 수집기로 세지 않는다", ps4.peers?.length === 0, JSON.stringify(ps4));
    await itemsPool.query(`UPDATE org_collector SET version=version+1 WHERE instance_key=$1`, [`${P}coo`]);
    const ps5 = await loadNotionSweepPeers(itemsPool, { instance: ax, claimKey: C, boundId: Number(selfRow.id), boundVersion: Number(selfRow.version) });
    chk("S18 내 설정 판이 바인딩 때와 다르면 selfChanged", ps5.selfChanged === true, JSON.stringify(ps5));
  }

  // ── S3·S10 레거시 행 · 단일 수집기 → run 시작 전에 만든 미관측 행은 보관(종전 동작), 그 뒤 만든 행·갱신된 행은 유지. ──
  {
    const ax = AX("s3");
    await mk("s3-old", { ax, createdAt: "2026-09-01T00:00:00Z", syncedAt: "2026-09-01T00:00:00Z" });
    const S = await now();
    await mk("s3-new", { ax, syncedAt: null });                                        // run 도중 표식 없이 생긴 행
    await mk("s3-touched", { ax, createdAt: "2026-09-01T00:00:00Z", syncedAt: null });
    await itemsPool.query(`UPDATE knowledge SET last_synced_at=now() WHERE name=$1`, [nameOf("s3-touched")]); // run 도중 갱신
    const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C, plan: SOLE(S) });
    chk("S3 run 시작 전 레거시 미관측 행은 보관(종전 동작)", (await row("s3-old")).lifecycle === "archived", "");
    chk("S3 run 도중 생긴 표식 없는 행은 유지", (await row("s3-new")).lifecycle === "active", "");
    chk("S10 run 도중 갱신된 표식 없는 행은 유지", (await row("s3-touched")).lifecycle === "active", "");
    chk("S3 보관 1건", r.archived === 1, `archived=${r.archived}`);
  }

  // ── S4 C 만 맡던 행을 이번에 못 봄 · 단일 → 표식 떼고 같은 스윕에서 보관 + 감사 1행. ──
  {
    const ax = AX("s4");
    await mk("s4", { ax, seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    const S = await now();
    const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C, plan: SOLE(S) });
    const x = await row("s4");
    chk("S4 단일 수집기가 못 본 자기 행은 같은 스윕에서 보관", x.lifecycle === "archived" && r.archived === 1 && r.orphaned === 1, JSON.stringify(r));
    chk("S4 표식이 빠지고 비게 된 시각이 남는다", !x.sync_state.seen_by && typeof x.sync_state.unclaimed_since === "string", JSON.stringify(x.sync_state));
    const au = (await itemsPool.query(
      `SELECT op, actor, after->>'lifecycle' AS lc FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1`, [nameOf("s4")])).rows;
    chk("S4 감사 1행(set_lifecycle · connector:notion · archived)",
      au.length === 1 && au[0].op === "set_lifecycle" && au[0].actor === "connector:notion" && au[0].lc === "archived", JSON.stringify(au));
  }

  // ── S5 둘이 맡던 행을 C 가 못 봄 → C 표식만 빠지고 활성 유지. ──
  {
    const ax = AX("s5");
    await mk("s5", { ax, seen: { [C]: "2026-09-16T00:00:00Z", [D]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    const S = await now();
    const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C, plan: SOLE(S) });
    const x = await row("s5");
    chk("S5 C 표식만 빠지고 D 표식·활성 유지", x.lifecycle === "active" && JSON.stringify(Object.keys(x.sync_state.seen_by)) === JSON.stringify([D]),
      JSON.stringify(x.sync_state));
    chk("S5 비게 된 시각 없음", x.sync_state.unclaimed_since === undefined && r.released === 1 && r.orphaned === 0, JSON.stringify(r));
  }

  // ── S6 C 만 맡던 행 · 다른 수집기 준비됨(과거) → 떼기만 하고 이번엔 보관 안 함. ──
  {
    const ax = AX("s6");
    await mk("s6", { ax, seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    const S = await now();
    const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C,
      plan: { archive: true, sole: false, cutoffIso: ago(S, 2 * H) } });
    const x = await row("s6");
    chk("S6 다른 수집기가 있으면 방금 비게 된 행은 보관하지 않는다", x.lifecycle === "active" && r.archived === 0, JSON.stringify(r));
    chk("S6 비게 된 시각이 기록된다(이번 run 시작 이후)",
      Date.parse(x.sync_state.unclaimed_since) >= Date.parse(S), JSON.stringify(x.sync_state));
  }

  // ── S7·S8 비게 된 시각 vs 기준 시각. ──
  {
    const ax = AX("s7");
    const S = await now();
    await mk("s7-before", { ax, unclaimedSince: ago(S, 3 * H), syncedAt: ago(S, 4 * H), createdAt: ago(S, 5 * H) });
    await mk("s8-after", { ax, unclaimedSince: ago(S, 1 * H), syncedAt: ago(S, 4 * H), createdAt: ago(S, 5 * H) });
    const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C,
      plan: { archive: true, sole: false, cutoffIso: ago(S, 2 * H) } });
    chk("S7 기준 시각 전에 비게 된 행은 보관", (await row("s7-before")).lifecycle === "archived", "");
    chk("S8 기준 시각 뒤에 비게 된 행은 유지", (await row("s8-after")).lifecycle === "active", "");
    chk("S7·S8 보관 1건", r.archived === 1, `archived=${r.archived}`);
  }

  // ── S7b 같은 밀리초 안의 앞뒤 — 비게 된 시각과 기준 시각을 마이크로초로 비교한다(리뷰가 3/9 로 재현한 흔들림). ──
  {
    const ax = AX("s7b");
    const S = await now();
    const ms = "2026-09-16T10:00:00.628";
    await mk("s7b-before", { ax, unclaimedSince: `${ms}501Z`, syncedAt: ago(S, 4 * H), createdAt: ago(S, 5 * H) });
    await mk("s7b-after", { ax, unclaimedSince: `${ms}901Z`, syncedAt: ago(S, 4 * H), createdAt: ago(S, 5 * H) });
    await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C,
      plan: planNotionSweep({ runStartIso: S, selfChanged: false,
        peers: [{ key: D, version: 1, ready: { at: `${ms}700Z`, version: 1 } }] }) });
    chk("S7b 같은 밀리초라도 기준보다 먼저 비게 된 행은 보관", (await row("s7b-before")).lifecycle === "archived", "");
    chk("S7b 같은 밀리초라도 기준보다 늦게 비게 된 행은 유지", (await row("s7b-after")).lifecycle === "active", "");
  }

  // ── S20 꺼진 수집기가 남긴 표식은 행을 계속 지킨다(보수 — 지운·끈 수집기의 자료는 사람이 내린다). ──
  {
    const ax = AX("s20");
    await itemsPool.query(
      `INSERT INTO org_collector(key, preset_key, instance_key, enabled, config) VALUES ($1, 'notion', $1, false, $2::jsonb)`,
      [`${P}off`, JSON.stringify({ instance: ax })]);
    await mk("s20", { ax, seen: { [`notion:${P}off`]: "2026-09-01T00:00:00Z" }, syncedAt: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z" });
    const S = await now();
    const ps = await loadNotionSweepPeers(itemsPool, { instance: ax, claimKey: C, boundId: null, boundVersion: null });
    const plan = planNotionSweep({ runStartIso: S, selfChanged: false, peers: ps.peers });
    chk("S20 꺼진 수집기는 보류 사유가 아니다(단일로 계획)", plan.archive === true && plan.sole === true, JSON.stringify(plan));
    const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C, plan });
    chk("S20 꺼진 수집기의 표식이 남은 행은 보관하지 않는다", (await row("s20")).lifecycle === "active" && r.archived === 0, JSON.stringify(r));
  }

  // ── S9 이번 run 중에 본 행 → 표식 유지·보관 안 함. S11 다른 축 → 불변. S12 보관·검토대기 → lifecycle 불변. ──
  {
    const ax = AX("s9"); const other = AX("s11");
    await mk("s9", { ax, seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    await mk("s11", { ax: other, seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    await mk("s12-arch", { ax, lifecycle: "archived", seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    await mk("s12-pend", { ax, lifecycle: "pending", seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    const S = await now();
    await observeNotionRows(itemsPool, { instance: ax, ids: [ext("s9")], claimKey: C });
    await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: C, plan: SOLE(S) });
    const s9 = await row("s9");
    chk("S9 이번 run 중에 본 행은 표식 유지·활성", s9.lifecycle === "active" && Date.parse(s9.sync_state.seen_by[C]) >= Date.parse(S),
      JSON.stringify(s9.sync_state));
    const s11 = await row("s11");
    chk("S11 다른 축의 행은 표식·lifecycle 불변", s11.lifecycle === "active" && s11.sync_state.seen_by?.[C] !== undefined, JSON.stringify(s11));
    const a = await row("s12-arch"); const p = await row("s12-pend");
    chk("S12 보관·검토대기 행은 lifecycle 불변(표식은 빠진다)",
      a.lifecycle === "archived" && p.lifecycle === "pending" && !a.sync_state.seen_by && !p.sync_state.seen_by,
      JSON.stringify({ a: a.sync_state, p: p.sync_state }));
  }

  // ── S13·S14 적재(미러)가 표식을 남긴다. ──
  {
    const ax = AX("s13");
    const item = (id, extra = {}) => ({
      type: "doc", title: `t-${id}`, body: `b-${id}`, occurred_at: null, fields: { notion: { kind: "page" }, ...extra },
      provenance: { system: "notion", instance: ax, external_id: ext(id), external_url: null },
    });
    const client = await itemsPool.connect();
    try {
      await mirrorExternalToV6(client, item("s13"), { claimKey: C });
      chk("S13 신규 적재가 적재한 수집기 표식을 남긴다", JSON.stringify(await claims("s13")) === JSON.stringify([C]), JSON.stringify(await row("s13")));
      await mirrorExternalToV6(client, item("s13"), { claimKey: D });
      chk("S13 다른 수집기의 재적재는 표식을 더한다(기존 표식 보존)", JSON.stringify(await claims("s13")) === JSON.stringify([C, D].sort()), "");
      await itemsPool.query(
        `UPDATE knowledge SET lifecycle='archived', sync_state = jsonb_build_object('unclaimed_since', '2026-09-01T00:00:00Z') WHERE name=$1`, [nameOf("s13")]);
      await mirrorExternalToV6(client, item("s13"), { claimKey: C });
      const x = await row("s13");
      chk("S13 보관·비게 된 행을 다시 적재하면 활성 복귀 + 비게 된 시각 제거 + 표식",
        x.lifecycle === "active" && x.sync_state.unclaimed_since === undefined && JSON.stringify(Object.keys(x.sync_state.seen_by)) === JSON.stringify([C]),
        JSON.stringify(x));
      await mirrorExternalToV6(client, item("s14"), {});
      chk("S14 표식 없는 신규 적재는 sync_state 가 비어 있다", JSON.stringify((await row("s14")).sync_state) === "{}", JSON.stringify(await row("s14")));
      await mirrorExternalToV6(client, item("s13"));
      chk("S14 표식 없는 재적재는 기존 표식을 보존한다", JSON.stringify(await claims("s13")) === JSON.stringify([C]), "");
    } finally { client.release(); }
  }

  // ── S15·S16 관측·대사. ──
  {
    const ax = AX("s15"); const other = AX("s15o");
    await mk("s15-a", { ax, syncedAt: "2026-09-01T00:00:00Z" });
    await mk("s15-b", { ax, syncedAt: "2026-09-01T00:00:00Z" });
    await mk("s15-a-other", { ax: other, syncedAt: "2026-09-01T00:00:00Z" });
    await itemsPool.query(`UPDATE knowledge SET external_id=$1 WHERE name=$2`, [ext("s15-a"), nameOf("s15-a-other")]); // 같은 id · 다른 축
    const S = await now();
    await observeNotionRows(itemsPool, { instance: ax, ids: [ext("s15-a")], claimKey: C });
    const a = await row("s15-a"), b = await row("s15-b"), o = await row("s15-a-other");
    chk("S15 관측은 지정 id 에만 표식·적재 시각을 남긴다",
      a.sync_state.seen_by?.[C] && ms(a.last_synced_at) >= ms(S) && !b.sync_state.seen_by, JSON.stringify({ a, b }));
    chk("S15 같은 id 라도 다른 축은 건드리지 않는다", !o.sync_state.seen_by && ms(o.last_synced_at) < ms(S), JSON.stringify(o));
    const client = await itemsPool.connect();
    try {
      const it = (id) => ({ type: "doc", title: id, body: id, fields: { notion: { kind: "page" } },
        provenance: { system: "notion", instance: ax, external_id: ext(id), external_url: null } });
      await mirrorExternalToV6(client, it("s16-c1"), { claimKey: C });
      await mirrorExternalToV6(client, it("s16-c2"), { claimKey: C });
      await mirrorExternalToV6(client, it("s16-d1"), { claimKey: D });   // 같은 축 · 동시에 다른 수집기가 적재
    } finally { client.release(); }
    const n = await countNotionClaimedSince(itemsPool, { instance: ax, claimKey: C, sinceIso: S });
    chk("S16 대사는 C 가 시작 뒤 적재·관측한 행만 센다(D 의 동시 적재 제외)", n === 3, `n=${n} (기대 3 = 적재 2 + 관측 1)`);
  }

  // ── S17 원장 mine. ──
  {
    const ax = AX("s17");
    await mk("s17-mine", { ax, seen: { [C]: "2026-09-16T00:00:00Z", [D]: "2026-09-16T00:00:00Z" } });
    await mk("s17-peer", { ax, seen: { [D]: "2026-09-16T00:00:00Z" } });
    await mk("s17-legacy", { ax });
    await mk("s17-released", { ax, unclaimedSince: "2026-09-16T00:00:00Z" });
    const led = await loadNotionLedger(itemsPool, ax, C);
    const m = (id) => led.byId.get(ext(id))?.mine;
    chk("S17 내 표식 → mine", m("s17-mine") === true, "");
    chk("S17 남의 표식만 → mine 아님", m("s17-peer") === false, "");
    chk("S17 표식이 한 번도 없던 행 → mine(전환기 호환)", m("s17-legacy") === true, "");
    chk("S17 비게 된 행 → mine 아님", m("s17-released") === false, "");
    const led2 = await loadNotionLedger(itemsPool, ax);
    chk("S17 표식 없이 읽은 원장은 전부 mine", [...led2.byId.values()].every((e) => e.mine === true) && led2.byId.size === 4, "");
  }

  // ── S19 준비 기록 upsert. ──
  {
    const key = `notion:${P}ready`;
    await recordNotionSweepReady(itemsPool, { claimKey: key, runStartIso: "2026-09-16T00:00:00.000Z", boundVersion: 2 });
    await recordNotionSweepReady(itemsPool, { claimKey: key, runStartIso: "2026-09-17T00:00:00.000Z", boundVersion: 3 });
    const st = (await itemsPool.query(`SELECT cursor FROM connector_state WHERE system=$1 AND instance=$2`, [SWEEP_STATE_SYSTEM, key])).rows;
    chk("S19 준비 기록은 최신 값 한 행", st.length === 1 && st[0].cursor.ready_at === "2026-09-17T00:00:00.000Z" && st[0].cursor.version === 3,
      JSON.stringify(st));
  }

  // ── E2E 두 수집기의 교대 스윕 — 한쪽에서 빠진 행은 **양쪽이 그 뒤에 점검을 마친 뒤에야** 보관된다. ──
  {
    const ax = AX("e2e");
    const sweep = async (key, observed, peers) => {
      const S = await now();
      await observeNotionRows(itemsPool, { instance: ax, ids: observed.map(ext), claimKey: key });
      const plan = planNotionSweep({ runStartIso: S, selfChanged: false, peers });
      const r = await sweepNotionArchived(itemsPool, { runStartIso: S, instance: ax, claimKey: key, plan });
      return { S, r, plan };
    };
    const readyOf = (key, at) => [{ key, version: 1, ready: at ? { at, version: 1 } : null }];
    await mk("e-c", { ax, seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    await mk("e-gone", { ax, seen: { [C]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    await mk("e-d", { ax, seen: { [D]: "2026-09-16T00:00:00Z" }, syncedAt: "2026-09-16T00:00:00Z" });
    // ① C 첫 점검(D 준비 전) — e-gone 은 C 범위에서 빠졌다: 떼기만, 보관 보류.
    const c1 = await sweep(C, ["e-c"], readyOf(D, null));
    chk("E2E① D 준비 전: 보류 · e-gone 활성", c1.plan.archive === false && (await row("e-gone")).lifecycle === "active", JSON.stringify(c1));
    // ② D 점검 — C 준비는 ①의 시작(< e-gone 비게 된 시각) → 보관 안 함.
    const d1 = await sweep(D, ["e-d"], readyOf(C, c1.S));
    chk("E2E② C 준비가 비게 된 시각보다 이르면 보관 안 함", d1.r.archived === 0 && (await row("e-gone")).lifecycle === "active", JSON.stringify(d1));
    chk("E2E② D 점검은 C 가 맡은 행을 건드리지 않는다", (await row("e-c")).lifecycle === "active" && JSON.stringify(await claims("e-c")) === JSON.stringify([C]), "");
    // ③ C 다음 점검 — D 준비(②의 시작)가 비게 된 시각보다 늦다 → e-gone 보관.
    const c2 = await sweep(C, ["e-c"], readyOf(D, d1.S));
    chk("E2E③ 양쪽 모두 그 뒤 점검을 마치면 e-gone 보관", c2.r.archived === 1 && (await row("e-gone")).lifecycle === "archived", JSON.stringify(c2));
    chk("E2E③ 두 수집기의 살아 있는 행은 끝까지 활성",
      (await row("e-c")).lifecycle === "active" && (await row("e-d")).lifecycle === "active", "");
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  try { await cleanup(); } catch (e) { console.error("정리 실패:", e?.message ?? e); }
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
