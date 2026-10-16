// 수집 실행의 저장 단계(#4213 T11) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/collect/collect-ingest.pg-test.mjs
//
// 왜 이 계층인가: 저장 단계의 약속은 원문을 푼 뒤 **T10 표가 지키는 사실**이다 — «목록으로 본 사람은 확인된 구성원» ·
//  «같은 좌표는 한 행(두 번 넣어도 새 행 없음)» · «요청 안 한 채널의 글은 안 들어간다» · «안 읽은 단위는 위치를 안 옮긴다» ·
//  «원문이 잘렸거나 저장이 실패한 판은 위치를 안 옮긴다» · «담당이 아니면 위치를 못 옮긴다» · «한 실행은 그 주인이 한 번만 처리».
//  풀기·위치 셈(순수)은 collect-plan.test.ts · connector-parse.test.ts. 여기는 run-ingest(ingestRun)를 실제 표에 대고 부른 뒤
//  **행을 되읽어** 판정한다(사양 I1~I6 · J2). 원문은 커넥터 결과의 모양(맥 실측)만 옮긴 합성 글이다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/collect/unit-store.js`);
const { ingestRun, resolveInstance, toIngestPlan } = await import(`${DIST}/org/collect/run-ingest.js`);
const { NOW_MARGIN_SEC, proofUnit } = await import(`${DIST}/org/collect/collect-plan.js`);
const { pendingProofs, proofDueMembers, requestProof } = await import(`${DIST}/org/collect/unit-proof.js`);
const { collectScheduleTick } = await import(`${DIST}/org/collect/collect-schedule.js`);
const { planCollectUnits } = await import(`${DIST}/terminal/collect-run.js`);
const log = await import(`${DIST}/org/collect/run-log.js`);
const { collectRunCapabilities } = await import(`${DIST}/capabilities/collect-run.js`);
const { invalidateSourceVisRules } = await import(`${DIST}/v6/source-vis-policy.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const statusOf = async (fn) => { try { await fn(); return 200; } catch (e) { return e?.status ?? 500; } };

const A = "__ci_pg_a__", B = "__ci_pg_b__", C = "__ci_pg_c__", D = "__ci_pg_d__", E = "__ci_pg_e__", Y = "__ci_pg_y__", NOBODY = "__ci_pg_none__";
const MEMBERS = [A, B, C, D, E, Y, NOBODY];
const TEAM = "T_CIPG";                       // 이 시험만 쓰는 슬랙 팀(인스턴스)
const TEAM2 = "T_CIPG_OTHER";                // 다른 팀 하나 더 — «팀이 하나뿐이면 그것»(②)이 답을 대신 내지 못하게
const NOTION_INST = "cipg-notion";
const CH1 = "C0CIPG0001", CH2 = "C0CIPG0002", CH3 = "C0CIPG0003", CH4 = "C0CIPG0004", CH6 = "C0CIPG0006", STRAY = "C0CIPG0009";
const CH10 = "C0CIPG0010", CH11 = "C0CIPG0011";
const BOX_A = "a@cipg.test";
const PAGE = "abcdef01-2345-6789-abcd-ef01cafe0001";
const POLICY_NOTE = "pgtest-ci";
const NOW = Date.parse("2026-10-16T10:00:00.000Z");
const PLANNED = Math.floor(NOW / 1000);
const SINCE = "1787000000.000000";

const file = (connector, tool, inner, input = {}) => ({
  tool_name: `mcp__claude_ai_${connector}__${tool}`, tool_input: input,
  tool_response: [{ type: "text", text: typeof inner === "string" ? inner : JSON.stringify(inner) }],
});
const listFile = (rows, o = {}) => file("Slack", "slack_list_user_channels", {
  result: [...rows.flatMap(([id, name, type, archived]) => [`### #${name}`, `- **ID:** ${id}`, `- **Type:** ${type}`, ...(archived ? ["- **Archived:** Yes"] : []), ""]),
    ...(o.cursor ? [`---\nPagination: More results available. Use cursor: "${o.cursor}"`] : [])].join("\n"),
}, { types: "public_channel,private_channel,mpim,im", limit: 200, exclude_archived: true, ...(o.inCursor ? { cursor: o.inCursor } : {}) });
const chFile = (ch, msgs, input = { channel_id: ch, oldest: SINCE, limit: 100 }) => file("Slack", "slack_read_channel", {
  messages: [`Channel: #c (${ch})`, "", ...msgs.flatMap(([ts, body, tail]) => [`=== Message from Kim <kim@cipg.test> (U0CIPG0001) at x ===`, `Message TS: ${ts}`, body, ...(tail ? [tail] : []), ""])].join("\n"),
  pagination_info: "There are no more messages available.\n",
}, input);
const thFile = (ch, parent, replies) => file("Slack", "slack_read_thread", {
  messages: ["=== THREAD PARENT MESSAGE ===", "From: Kim <kim@cipg.test> (U0CIPG0001)", "Time: x", `Message TS: ${parent}`, "부모", "",
    "=== THREAD REPLIES (n) ===", "", ...replies.flatMap((ts, i) => [`--- Reply ${i + 1} of ${replies.length} ---`, "From: Lee (U0CIPG0002)", "Time: y", `Message TS: ${ts}`, `답글 ${i + 1}`, ""])].join("\n"),
  pagination_info: "There are no more messages in this thread.\n",
}, { channel_id: ch, message_ts: parent, limit: 200 });
const GM = (id, threadId, o = {}) => ({ id, threadId, subject: "견적", sender: "Kim <kim@cipg.test>", date: "Thu, 2 Oct 2026 23:49:36 +0000", internalDate: "1790984976000",
  snippet: "요약", labelIds: [], viewUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(BOX_A)}#all/${id}`, ...o });

const unitBy = async (ref, app = "slack", inst = TEAM) => (await itemsPool.query(
  `SELECT * FROM collect_unit WHERE app=$1 AND instance=$2 AND ref=$3`, [app, inst, ref])).rows[0];
const viewer = async (unitId, member) => (await itemsPool.query(
  `SELECT verified_at FROM collect_unit_member WHERE unit_id=$1 AND member_id=$2`, [unitId, member])).rows[0];
const sources = async (app, inst, prefix) => (await itemsPool.query(
  `SELECT id, external_id, parent_external_id, body_md FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id LIKE $3 ORDER BY external_id`,
  [app, inst, `${prefix}%`])).rows;
const audienceHas = async (sid, member) => (await itemsPool.query(
  `SELECT 1 FROM source_member WHERE source_id=$1 AND member_id=$2`, [sid, member])).rowCount > 0;
const activate = (id) => itemsPool.query(`UPDATE collect_unit SET state='active' WHERE id=$1`, [id]);
const planned = (u, o = {}) => ({ id: u.id, app: u.app, instance: u.instance, ref: u.ref, kind: u.kind, connector: u.connector || "Slack",
  since: SINCE, until: null, ...o });

async function cleanup() {
  //  ref 로도 지운다 — 인스턴스를 못 정한 판(빈 값)으로 생긴 시험 단위가 남지 않게.
  await itemsPool.query(`DELETE FROM collect_unit WHERE (app='slack' AND (instance = ANY($1::text[]) OR ref LIKE 'C0CIPG%')) OR (app='notion' AND instance=$2) OR (app='gmail' AND lower(ref)=$3)`, [[TEAM, TEAM2], NOTION_INST, BOX_A]);
  await itemsPool.query(`DELETE FROM source WHERE (external_system='slack' AND external_instance = ANY($1::text[])) OR (external_system='notion' AND external_instance=$2)
                           OR (external_system='gmail' AND external_id LIKE '18c1a9%')`, [[TEAM, TEAM2], NOTION_INST]);
  await itemsPool.query(`DELETE FROM collect_assignee_state WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM org_source_vis_policy WHERE note=$1`, [POLICY_NOTE]);
  invalidateSourceVisRules();
}

try {
  await cleanup();
  for (const m of [A, B, C, D, E, Y]) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, m === A ? BOX_A : `${m}@cipg.test`]);
  //  볼 수 있는 사람 = «확인된 단위 구성원 ∩ 조직 정책». 같은 DB 를 쓰는 앞 시험이 슬랙 전체에 정책을 남겼어도 이 시험의 채널은
  //   «열림» 이 되게 채널 규칙(가장 좁은 규칙이 이긴다)을 둔다 — 그래야 I2b 가 정책이 아니라 단위 구성원을 본다(CI 실측 2026-10-16).
  for (const ch of [CH1, CH2]) {
    await itemsPool.query(`INSERT INTO org_source_vis_policy(match_system, match_channel, visibility, priority, note) VALUES('slack',$1,'open',1000,$2)`, [ch, POLICY_NOTE]);
  }
  invalidateSourceVisRules();
  //  이 워크스페이스가 이미 아는 슬랙 팀 — CH1 은 예전에 수집기·목록으로 생긴 단위다(인스턴스 TEAM).
  await store.recordUnitListing({ member: A, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: CH1, kind: "channel", name: "#c1" }], verified: true });
  await store.recordUnitListing({ member: B, app: "slack", connector: "Slack", instance: TEAM2, items: [{ ref: "C0CIPG0008", kind: "channel", name: "#other" }], verified: true });

  // ── I1 목록 실행 ──
  {
    const res = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, files: [
      listFile([[CH1, "c1", "Public Channel"], [CH3, "old", "Public Channel", true]], { cursor: "next" }),
      listFile([[CH2, "c2", "Private Channel"]], { inCursor: "next" }),
    ] });
    const u2 = await unitBy(CH2), u3 = await unitBy(CH3);
    const v2 = u2 ? await viewer(u2.id, A) : null;
    chk("I1 목록 — 이미 아는 팀으로 단위를 세우고(①) 새 단위는 «후보» · 그 사람은 확인된 볼 수 있는 구성원 · 보관 채널은 안 세운다 · 쪽 사슬이 끝나 «전부»",
      res.state === "done" && res.listed === 2 && res.created === 1 && res.instance === TEAM && res.complete === true
        && u2 && u2.state === "candidate" && u2.kind === "private_channel" && v2?.verified_at != null && !u3,
      JSON.stringify({ res, u2: u2 && { state: u2.state, kind: u2.kind }, v2, u3: !!u3 }));
    const again = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH1, "c1", "Public Channel"], [CH2, "c2", "Private Channel"]])] });
    chk("I1b 같은 목록을 또 넣어도 새 단위 없음", again.state === "done" && again.created === 0, JSON.stringify(again));
    const none = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, files: [chFile(CH1, [])] });
    chk("I1c 목록 도구를 안 부른 실행은 실패로 남긴다(단위를 지우지도 세우지도 않는다)", none.state === "failed" && /목록 도구/.test(none.error ?? ""), JSON.stringify(none));
    const r1 = await resolveInstance("slack", [CH2]), r2 = await resolveInstance("slack", ["C0CIPG0007"]), r3 = await resolveInstance("gmail", []);
    chk("I1d 인스턴스 — 같은 ref 의 기존 단위 팀(ref) · 모르는 ref 이고 팀이 둘이면 빈 값(none) · 지메일은 default",
      r1.instance === TEAM && r1.via === "ref" && r2.instance === "" && r2.via === "none" && r3.instance === "default", JSON.stringify({ r1, r2, r3 }));
    const trunc = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, truncated: true, files: [listFile([[CH1, "c1", "Public Channel"]])] });
    chk("I1e 원문이 잘린 목록은 «전부» 가 아니다", trunc.state === "done" && trunc.complete === false, JSON.stringify(trunc));
  }

  // ── I2·I3·I5 수집 실행 ──
  const u1 = await unitBy(CH1), u2 = await unitBy(CH2);
  await activate(u1.id); await activate(u2.id);
  {
    const mine = (await store.listAssignedUnits(A)).map((u) => u.ref).sort();
    chk("J 배선 — 켠 두 단위가 A 의 담당이다", mine.includes(CH1) && mine.includes(CH2), JSON.stringify(mine));
  }
  const files = [
    chFile(CH1, [["1787193938.792269", "부모", "Thread: 1 reply (latest: z)"], ["1787195400.000200", "나중 글"]]),
    thFile(CH1, "1787193938.792269", ["1787194200.111111"]),
    chFile(STRAY, [["1787195401.000000", "남의 채널 글"]]),
  ];
  const plan = { mode: "collect", units: [planned(u1), planned(u2)], planned_at: PLANNED };
  {
    const res = await ingestRun({ member: A, plan, files, now: NOW });
    const rows = await sources("slack", TEAM, "C0CIPG");
    const p1 = res.per_unit?.find((p) => p.id === u1.id), p2 = res.per_unit?.find((p) => p.id === u2.id);
    const reply = rows.find((r) => r.external_id === `${CH1}:1787194200.111111`);
    chk("I2 단위의 항목만 저장 — 좌표 `채널:ts` · 답글의 parent · 부모는 채널·스레드 양쪽에 나와도 한 행",
      res.state === "done" && p1?.stored === 3 && p1?.inserted === 3 && rows.length === 3
        && rows.every((r) => r.external_id.startsWith(`${CH1}:`)) && reply?.parent_external_id === `${CH1}:1787193938.792269`,
      JSON.stringify({ res: { ...res, per_unit: undefined }, rows: rows.map((r) => r.external_id) }));
    chk("I3 요청 안 한 채널의 글은 안 들어간다(stray)", res.stray === 1 && (await sources("slack", TEAM, STRAY)).length === 0, `stray=${res.stray}`);
    //  공개 채널 단위의 기본 공개범위는 «모두»(T10 #4742) — 자료는 열린 채로 남고 볼 수 있는 사람 행이 없다. 비공개 채널은 I2e 에서 본다.
    const openRows = (await itemsPool.query(`SELECT id, visibility FROM source WHERE id = ANY($1::int[])`, [rows.map((r) => r.id)])).rows;
    const sm = (await itemsPool.query(`SELECT count(*)::int AS n FROM source_member WHERE source_id = ANY($1::int[])`, [rows.map((r) => r.id)])).rows[0].n;
    chk("I2b 공개 채널(기본 «모두») 의 자료는 열린 채 · 볼 수 있는 사람 행 없음 · 단위 공개범위는 all",
      openRows.length === 3 && openRows.every((r) => r.visibility === "open") && sm === 0 && u1.visibility === "all",
      JSON.stringify({ openRows, sm, unitVis: u1.visibility }));
    const a1 = await unitBy(CH1), a2 = await unitBy(CH2);
    chk("I2c 끝까지 읽은 단위(끝이 «지금»)는 위치 = 계획 시각 − 60초 · 읽은 시각 = 이 판", a1.cursor?.ts === `${PLANNED - NOW_MARGIN_SEC}.000000`
      && new Date(a1.read_at).getTime() === NOW && p1?.cursor_moved === true && p1?.complete === true, JSON.stringify({ cursor: a1.cursor, read_at: a1.read_at, p1 }));
    chk("I2d 이 판이 안 읽은 단위는 위치·읽은 시각을 안 옮긴다(다음 판이 다시 맡는다) · 안 읽은 단위·남의 채널은 «확인 필요»", p2?.reads === 0 && p2?.reason === "이 판이 읽지 않음" && a2.read_at == null
      && JSON.stringify(a2.cursor ?? {}) === "{}" && res.unread === 1 && res.partial === true, JSON.stringify({ p2, read_at: a2.read_at, cursor: a2.cursor, unread: res.unread, partial: res.partial }));
    const again = await ingestRun({ member: A, plan, files, now: NOW + 60_000 });
    const rows2 = await sources("slack", TEAM, "C0CIPG");
    chk("I5 같은 원문을 다시 넣어도 새 행이 없다(inserted 0) — 같은 좌표", again.inserted === 0 && again.stored === 3 && rows2.length === 3, JSON.stringify({ ...again, per_unit: undefined }));
    const onlyOne = await ingestRun({ member: A, plan, files: [chFile(CH1, [["1787195400.000200", "나중 글"]])], now: NOW + 120_000 });
    chk("I2d' 맡긴 단위 하나를 안 읽은 판은 다른 이상이 없어도 «확인 필요»", onlyOne.unread === 1 && onlyOne.incomplete === 0 && onlyOne.stray === 0
      && onlyOne.unparsed === 0 && onlyOne.partial === true, JSON.stringify({ ...onlyOne, per_unit: undefined }));
  }
  {
    //  못 다 읽은 판 — 시작점은 그대로(못 다 읽은 구간을 넘기지 않는다) · 구간만 줄인다 · 읽은 항목은 저장한다.
    const res = await ingestRun({ member: A, plan: { ...plan, units: [planned(u2)] }, now: NOW,
      files: [chFile(CH2, [["1787300000.000001", "글", "Thread: 2 replies (latest: z)"]])] });
    const a2 = await unitBy(CH2), p = res.per_unit?.[0];
    const priv = (await sources("slack", TEAM, `${CH2}:`))[0];
    const privVis = priv ? (await itemsPool.query(`SELECT visibility FROM source WHERE id=$1`, [priv.id])).rows[0]?.visibility : null;
    chk("I2b' 비공개 채널(기본 «볼 수 있는 사람만») 의 자료는 잠기고 그 단위의 확인된 구성원(A)에게만 보인다",
      a2.visibility === "viewers" && privVis === "members" && !!priv && await audienceHas(priv.id, A) && !(await audienceHas(priv.id, B)),
      JSON.stringify({ unitVis: a2.visibility, privVis, priv: !!priv }));
    chk("I2e 답글 있는 부모의 스레드를 안 읽은 판 — 위치 그대로 + 구간 반 · 항목은 저장 · «확인 필요»",
      p?.complete === false && p?.cursor_moved === false && p?.window_shrunk === true && p?.inserted === 1 && a2.cursor?.ts === SINCE
        && a2.cursor?.span === 7 * 86400 / 2 && res.partial === true && res.incomplete === 1,
      JSON.stringify({ p, cursor: a2.cursor, partial: res.partial }));
  }
  {
    //  저장이 하나라도 실패한 판 · 원문이 잘린 판은 위치·구간·«마지막 글 시각» 을 아예 건드리지 않는다(수집기에서 넘어온 단위는 마지막 글
    //   시각이 곧 다음 시작점이다). 실패는 시험용 트리거로 낸다(NUL 은 이제 걷어 내므로 실패가 아니다).
    await itemsPool.query(`CREATE OR REPLACE FUNCTION pgtest_ci_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'pgtest-ci forced failure'; END $$ LANGUAGE plpgsql`);
    await itemsPool.query(`DROP TRIGGER IF EXISTS pgtest_ci_fail_trg ON source`);
    await itemsPool.query(`CREATE TRIGGER pgtest_ci_fail_trg BEFORE INSERT ON source FOR EACH ROW WHEN (NEW.external_id = '${CH1}:1787199000.000001') EXECUTE FUNCTION pgtest_ci_fail()`);
    const before = await unitBy(CH1);
    let nul, afterNul;
    try {
      nul = await ingestRun({ member: A, plan: { ...plan, planned_at: PLANNED + 3600 }, now: NOW + 3_600_000,
        files: [chFile(CH1, [["1787199000.000001", "실패할 글"], ["1787199100.000001", "멀쩡한\u0000글"]])] });
      afterNul = await unitBy(CH1);
    } finally {
      await itemsPool.query(`DROP TRIGGER IF EXISTS pgtest_ci_fail_trg ON source`);
      await itemsPool.query(`DROP FUNCTION IF EXISTS pgtest_ci_fail()`);
    }
    const pn = nul.per_unit?.find((p) => p.id === u1.id);
    const nulRow = (await itemsPool.query(`SELECT body_md FROM source WHERE external_system='slack' AND external_instance=$1 AND external_id=$2`, [TEAM, `${CH1}:1787199100.000001`])).rows[0];
    chk("I6a 저장 실패가 있으면 위치·마지막 글 시각을 안 옮긴다(다음 판이 다시 읽어 합친다) · 실패 수를 남긴다 · NUL 은 걷어 내고 저장",
      pn?.failed === 1 && pn?.stored === 1 && JSON.stringify(afterNul.cursor) === JSON.stringify(before.cursor)
        && String(afterNul.last_item_at) === String(before.last_item_at) && /저장 실패/.test(pn?.reason ?? "") && nul.partial === true && nulRow?.body_md === "멀쩡한글",
      JSON.stringify({ pn, before: [before.cursor, before.last_item_at], after: [afterNul.cursor, afterNul.last_item_at], nulRow }));
    const cut = await ingestRun({ member: A, plan: { ...plan, planned_at: PLANNED + 7200 }, now: NOW + 7_200_000, truncated: true,
      files: [chFile(CH1, [["1787199200.000001", "잘린 판의 글"]])] });
    const afterCut = await unitBy(CH1), pc = cut.per_unit?.find((p) => p.id === u1.id);
    chk("I6b 원문이 잘린 판(뒤쪽 결과를 못 봤다)은 위치·마지막 글 시각을 안 옮긴다 · 읽은 항목은 저장한다",
      pc?.inserted === 1 && JSON.stringify(afterCut.cursor) === JSON.stringify(before.cursor) && String(afterCut.last_item_at) === String(before.last_item_at)
        && pc?.reason === "원문이 잘림", JSON.stringify({ pc, after: [afterCut.cursor, afterCut.last_item_at], before: [before.cursor, before.last_item_at] }));
  }
  {
    //  B 는 이 단위를 볼 수 있는 구성원이 아니다 — 원문을 B 의 실행 결과로 넣으면 저장도 위치도 거절된다.
    const before = (await unitBy(CH1)).cursor;
    const res = await ingestRun({ member: B, plan: { ...plan, units: [planned(u1)] }, files: [chFile(CH1, [["1787199999.000001", "B 가 넣으려는 글"]])], now: NOW });
    const p = res.per_unit?.[0];
    const row = (await sources("slack", TEAM, `${CH1}:1787199999`))[0];
    chk("I6c 볼 수 있는 구성원이 아닌 실행은 저장·위치 이동 둘 다 못 한다", p?.stored === 0 && !row && JSON.stringify((await unitBy(CH1)).cursor) === JSON.stringify(before)
      && /볼 수 있는 구성원/.test(p?.reason ?? ""), JSON.stringify({ p, row: !!row }));
  }

  // ── 확인 읽기 — 이미 모인 자료가 있는 비공개 단위는 목록만으로 열리지 않는다(구성원이 고쳐 쓸 수 있는 원문을 믿지 않는다) ──
  {
    const priv = await unitBy(CH2);   // A 확인 · 자료 있음(I2e) · 비공개 채널이라 «볼 수 있는 사람만»
    const privSrc = (await sources("slack", TEAM, `${CH2}:`))[0];
    const proofRow = async (m) => (await itemsPool.query(`SELECT attempts, last_result FROM collect_proof WHERE unit_id=$1 AND member_id=$2`, [priv.id, m])).rows[0];
    //  CH4 = 이미 있는 비공개 단위지만 아직 모인 자료가 없다(A 가 먼저 목록으로 세움).
    await store.recordUnitListing({ member: A, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: CH4, kind: "private_channel", name: "c4" }], verified: true });
    const lst = await ingestRun({ member: B, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH1, "c1", "Public Channel"], [CH2, "c2", "Private Channel"], [CH4, "c4", "Private Channel"]])] });
    chk("G3 보호 단위는 목록만으로 확인 안 됨 — 확인 대기 · 자료 안 보임 · (G1) 공개 채널은 바로 확인",
      lst.proof_pending === 1 && (await viewer(priv.id, B))?.verified_at == null && (await proofRow(B))?.attempts === 0
        && !!privSrc && !(await audienceHas(privSrc.id, B)) && (await viewer(u1.id, B))?.verified_at != null,
      JSON.stringify({ lst, vb: await viewer(priv.id, B), pr: await proofRow(B) }));
    const u4 = await unitBy(CH4);
    chk("G2 이미 있는 «볼 수 있는 사람만» 단위라도 저장된 자료가 없으면 바로 확인(지킬 자료가 없다)",
      !!u4 && u4.visibility !== "all" && (await viewer(u4.id, A))?.verified_at != null && (await viewer(u4.id, B))?.verified_at != null
        && (await itemsPool.query(`SELECT 1 FROM collect_proof WHERE unit_id=$1`, [u4.id])).rowCount === 0, JSON.stringify(u4 && { vis: u4.visibility }));
    const againA = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH1, "c1", "Public Channel"], [CH2, "c2", "Private Channel"]])] });
    chk("G4 이미 확인된 사람은 그대로(대기 없음)", againA.proof_pending === 0 && !(await proofRow(A)) && (await viewer(priv.id, A))?.verified_at != null, JSON.stringify(againA));
    const pend = await pendingProofs(B, 5);
    chk("G13 대기 목록 — 그 단위와 확인 창에 쓸 가장 새로 저장된 글 ts", pend.length === 1 && pend[0].unit_id === priv.id && pend[0].newest_ts[0] === "1787300000.000001",
      JSON.stringify(pend));
    const pu = proofUnit({ id: priv.id, app: "slack", instance: TEAM, ref: CH2, kind: "private_channel" }, pend[0]?.newest_ts ?? []);
    const win = { channel_id: CH2, oldest: pu.since, latest: pu.until, limit: 20 };
    const beforeCursor = (await unitBy(CH2)).cursor;
    const bad = await ingestRun({ member: B, plan: { mode: "collect", units: [pu], planned_at: PLANNED }, now: NOW, files: [chFile(CH2, [["1787300000.000001", "가짜 본문"]], win)] });
    chk("G8 같은 좌표 · 다른 본문 — 확인 실패 · 시도 1 · 자료 안 보임 · 저장 없음",
      bad.proof_failed === 1 && (await proofRow(B))?.attempts === 1 && (await proofRow(B))?.last_result === "no_match" && !(await audienceHas(privSrc.id, B))
        && (await sources("slack", TEAM, `${CH2}:`)).length === 1, JSON.stringify({ ...bad, per_unit: bad.per_unit }));
    await ingestRun({ member: B, plan: { mode: "collect", units: [pu], planned_at: PLANNED }, now: NOW, files: [] });
    chk("G9 확인 단위를 안 읽은 판은 시도로 안 센다", (await proofRow(B))?.attempts === 1, JSON.stringify(await proofRow(B)));
    const good = await ingestRun({ member: B, plan: { mode: "collect", units: [pu], planned_at: PLANNED }, now: NOW,
      files: [chFile(CH2, [["1787300000.000001", "글", "Thread: 2 replies (latest: z)"], ["1787300000.500000", "새 글"]], win)] });
    chk("G7 저장된 글과 같은 본문 — 확인됨 · 자료 보임 · 대기 지움 · 확인 읽기는 저장·위치 이동 없음",
      good.proof_passed === 1 && (await viewer(priv.id, B))?.verified_at != null && await audienceHas(privSrc.id, B) && !(await proofRow(B))
        && (await sources("slack", TEAM, `${CH2}:`)).length === 1 && JSON.stringify((await unitBy(CH2)).cursor) === JSON.stringify(beforeCursor),
      JSON.stringify({ ...good }));
    await itemsPool.query(`INSERT INTO collect_proof(unit_id, member_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [priv.id, B]);
    const leftoverB = (await pendingProofs(B, 5)).some((p) => p.unit_id === priv.id);
    await ingestRun({ member: B, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH1, "c1", "Public Channel"], [CH2, "c2", "Private Channel"], [CH4, "c4", "Private Channel"]])] });
    chk("N3b 이미 확인된 사람에게 남은 대기 행은 싣지 않고 다음 목록에서 지운다", !leftoverB && !(await proofRow(B)), JSON.stringify({ leftoverB, row: await proofRow(B) }));
    const proofRowOf = async (m, uid = priv.id) => (await itemsPool.query(`SELECT attempts, misses, last_result FROM collect_proof WHERE unit_id=$1 AND member_id=$2`, [uid, m])).rows[0];
    //  확인 안 된 사람(D)이 보호 단위를 맡은 판 — 판정하지 않는다(수집 창엔 맞춰 볼 글이 없다) · 넣지도 확인하지도 않고 대기만.
    await ingestRun({ member: D, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH2, "c2", "Private Channel"]])] });
    const forged = await ingestRun({ member: D, plan: { mode: "collect", units: [planned(priv)], planned_at: PLANNED }, now: NOW,
      files: [chFile(CH2, [["1787300000.000001", "글"], ["1787300001.000001", "D 가 끼워 넣으려는 글"]])] });
    chk("G10 확인 안 된 사람이 맡은 보호 단위의 판은 저장된 글을 담아 와도 넣지도 확인하지도 않는다 — 확인 대기만",
      forged.per_unit?.[0]?.proof === "held" && forged.proof_held === 1 && forged.stored === 0 && (await viewer(priv.id, D))?.verified_at == null
        && (await sources("slack", TEAM, `${CH2}:1787300001`)).length === 0 && !!(await proofRowOf(D)), JSON.stringify(forged.per_unit?.[0]));
    //  창 밖의 옛 글 — 원문의 구간 표시(tool_input)를 넓게 꾸며도 계획한 창(가장 새로 저장된 최상위 글) 밖이면 증거가 아니다.
    const narrow = { ...pu, since: "1787300100.000000", until: "1787300200.000000" };
    const stale = await ingestRun({ member: D, plan: { mode: "collect", units: [narrow], planned_at: PLANNED }, now: NOW,
      files: [chFile(CH2, [["1787300000.000001", "글"]], { channel_id: CH2, oldest: "1787000000.000000", limit: 20 })] });
    chk("B2 창 밖의 옛 글은 같아도 증거가 아니다 — 확인 안 됨 · 시도 1(empty) · 자료 안 보임",
      stale.per_unit?.[0]?.proof === "empty" && (await viewer(priv.id, D))?.verified_at == null && (await proofRowOf(D))?.attempts === 1
        && !(await audienceHas(privSrc.id, D)), JSON.stringify(stale.per_unit?.[0]));
    chk("B2b 방금 시도한 대기는 한 시간 안에는 계획에도 다시 싣지 않는다(시도를 몇 분 사이에 다 쓰지 않게)",
      (await statusOf(() => planCollectUnits(D, { now: NOW }))) === 409);
    await itemsPool.query(`UPDATE collect_proof SET last_at = now() - interval '2 hours' WHERE unit_id=$1 AND member_id=$2`, [priv.id, D]);
    const planD = await planCollectUnits(D, { now: NOW });
    const pD = planD.units.find((u) => u.id === priv.id);
    const okD = await ingestRun({ member: D, plan: { mode: "collect", units: planD.units, planned_at: PLANNED }, now: NOW,
      files: [chFile(CH2, [["1787300000.000001", "글", "Thread: 2 replies (latest: z)"]], { channel_id: CH2, oldest: pD?.since, latest: pD?.until, limit: 20 })] });
    chk("G10b 다음 판은 확인 읽기로 싣고(D 는 담당이 아니다) · 창 안의 저장된 글과 같으면 확인된다",
      planD.units.length === 1 && pD?.proof === true && okD.proof_passed === 1 && (await viewer(priv.id, D))?.verified_at != null && await audienceHas(privSrc.id, D)
        && !(await proofRowOf(D)), JSON.stringify({ units: planD.units, per: okD.per_unit }));
    //  시도 상한 · 하루 뒤 다시 · 못 푼 결과
    await ingestRun({ member: C, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH2, "c2", "Private Channel"]])] });
    await itemsPool.query(`UPDATE collect_proof SET attempts=2 WHERE unit_id=$1 AND member_id=$2`, [priv.id, C]);
    const p2 = (await pendingProofs(C, 5)).length;
    await itemsPool.query(`UPDATE collect_proof SET attempts=3, last_at=now() WHERE unit_id=$1 AND member_id=$2`, [priv.id, C]);
    const p3 = (await pendingProofs(C, 5)).length;
    await itemsPool.query(`UPDATE collect_proof SET last_at=now() - interval '25 hours' WHERE unit_id=$1 AND member_id=$2`, [priv.id, C]);
    const pDay = (await pendingProofs(C, 5)).length;
    chk("G12 시도 3번(상한)이면 계획하지 않는다(2번은 계획) · 마지막 시도에서 하루가 지나면 다시 싣는다(영영 잠기지 않게)",
      p2 === 1 && p3 === 0 && pDay === 1, JSON.stringify({ p2, p3, pDay }));
    await itemsPool.query(`UPDATE collect_proof SET attempts=0, last_at=NULL WHERE unit_id=$1 AND member_id=$2`, [priv.id, C]);
    const only = await planCollectUnits(C, { now: NOW });
    chk("G6 맡은 단위가 없어도 확인할 것이 있으면 판을 띄운다 — 확인 읽기 단위만", only.units.length === 1 && only.units[0].id === priv.id && only.units[0].proof === true,
      JSON.stringify(only.units));
    const cu = only.units[0];
    const flaky = await ingestRun({ member: C, plan: { mode: "collect", units: [cu], planned_at: PLANNED }, now: NOW,
      files: [file("Slack", "slack_read_channel", "Error: ratelimited", { channel_id: CH2, oldest: cu.since, latest: cu.until, limit: 20 })] });
    chk("B3b 못 푼 결과(속도 제한 같은 일시 오류)는 시도로 세지 않는다 — 사유만", flaky.per_unit?.[0]?.proof === "unreadable"
      && (await proofRowOf(C))?.attempts === 0 && (await proofRowOf(C))?.misses === 1 && (await proofRowOf(C))?.last_result === "unreadable",
      JSON.stringify({ per: flaky.per_unit?.[0], row: await proofRowOf(C) }));
    for (let i = 0; i < 2; i++) {
      await ingestRun({ member: C, plan: { mode: "collect", units: [cu], planned_at: PLANNED }, now: NOW,
        files: [file("Slack", "slack_read_channel", "Error: ratelimited", { channel_id: CH2, oldest: cu.since, latest: cu.until, limit: 20 })] });
    }
    chk("B3c 못 푼 결과가 세 번 이어지면 시도 한 번으로 센다(그 대화를 못 읽는 사람도 같은 결과를 받는다)",
      (await proofRowOf(C))?.attempts === 1 && (await proofRowOf(C))?.misses === 0, JSON.stringify(await proofRowOf(C)));
    await itemsPool.query(`UPDATE collect_proof SET attempts=3, last_at=now() WHERE unit_id=$1 AND member_id=$2`, [priv.id, C]);
    chk("G6b 시도 상한에 닿은 대기만 있으면 409(빈 판을 띄우지 않는다)", (await statusOf(() => planCollectUnits(C, { now: NOW }))) === 409);
    //  확인된 사람이 모두 끊겨 확인 안 된 후보가 담당이 된 보호 단위 — 수집 창(읽은 위치 뒤)엔 맞춰 볼 저장된 글이 없으니 확인 읽기로 싣는다.
    //   그 단위에는 답글이 부모보다 새로 저장돼 있다 — 확인 창은 최상위 글로만 잡는다(채널 읽기는 최상위 글만 준다).
    await store.recordUnitListing({ member: C, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: CH6, kind: "private_channel", name: "c6" }], verified: false });
    const u6 = await unitBy(CH6);
    await activate(u6.id);
    await ingestRun({ member: C, plan: { mode: "collect", units: [planned(u6)], planned_at: PLANNED }, now: NOW, files: [
      chFile(CH6, [["1787400000.000001", "c6 글", "Thread: 2 replies (latest: z)"]]), thFile(CH6, "1787400000.000001", ["1787400100.000001", "1787400200.000001"])] });
    const c6 = await sources("slack", TEAM, `${CH6}:`);
    await itemsPool.query(`UPDATE collect_unit_member SET verified_at=NULL WHERE unit_id=$1 AND member_id=$2`, [u6.id, C]);
    const held = await planCollectUnits(C, { now: NOW });
    const h6 = held.units.find((u) => u.id === u6.id);
    chk("G6c 확인 안 된 담당의 보호 단위는 수집이 아니라 확인 읽기로 · 대기 행 · (B3a) 창은 최상위 글로만(더 새 답글은 빼고)",
      c6.length === 3 && held.units.length === 1 && h6?.proof === true && h6.since === "1787399999.000000" && h6.until === "1787400001.000000"
        && (await proofRowOf(C, u6.id))?.attempts === 0, JSON.stringify({ c6: c6.length, units: held.units }));
    //  확인 안 된 담당(C)의 보호 단위 — 확인 읽기가 통과 못 하거나 실을 수 없으면 그 단위를 물러서게 한다(때가 된 단위로 남아 틱마다 같은 판이 뜨지 않게).
    //  때가 된 단위로 만든다(다음 확인 · 마지막으로 읽은 시각을 비움).
    const makeDue = (id) => itemsPool.query(`UPDATE collect_unit SET next_at = NULL, read_at = NULL WHERE id=$1`, [id]);
    await makeDue(u6.id);
    const due0 = (await store.dueAssignments(NOW)).some((d) => d.unit_id === u6.id && d.member === C);
    const miss6 = await ingestRun({ member: C, plan: { mode: "collect", units: [h6], planned_at: PLANNED }, now: NOW,
      files: [chFile(CH6, [["1787400000.000001", "가짜 본문"]], { channel_id: CH6, oldest: h6.since, latest: h6.until, limit: 20 })] });
    const n6 = (await unitBy(CH6)).next_at;
    chk("A1 확인 안 된 담당의 확인 읽기가 통과 못 하면 그 단위를 물러서게 한다 — 때가 된 단위에서 빠진다",
      due0 && miss6.per_unit?.[0]?.proof === "no_match" && !!n6 && n6.getTime() > NOW && !(await store.dueAssignments(NOW)).some((d) => d.unit_id === u6.id),
      JSON.stringify({ due0, per: miss6.per_unit?.[0], n6 }));
    //  담당 + 못 푼 결과(속도 제한) — 시도로는 바로 안 세도, 그 단위는 물러선다.
    await makeDue(u6.id);
    await itemsPool.query(`UPDATE collect_unit SET sched = '{}'::jsonb WHERE id=$1`, [u6.id]);
    const flaky6 = await ingestRun({ member: C, plan: { mode: "collect", units: [h6], planned_at: PLANNED }, now: NOW,
      files: [file("Slack", "slack_read_channel", "Error: ratelimited", { channel_id: CH6, oldest: h6.since, latest: h6.until, limit: 20 })] });
    const n6c = (await unitBy(CH6)).next_at;
    chk("A1c 확인 안 된 담당의 확인 읽기가 못 푼 결과여도 그 단위를 물러서게 한다 — 때가 된 단위에서 빠진다",
      flaky6.per_unit?.[0]?.proof === "unreadable" && !!n6c && n6c.getTime() > NOW && !(await store.dueAssignments(NOW)).some((d) => d.unit_id === u6.id),
      JSON.stringify({ per: flaky6.per_unit?.[0], n6c }));
    await makeDue(u6.id);
    const st6 = await statusOf(() => planCollectUnits(C, { scheduled: true, now: NOW }));
    const n6b = (await unitBy(CH6)).next_at;
    chk("A2 맡은 보호 단위를 확인 읽기로도 못 실으면(방금 시도함) 409 앞에 그 단위를 물러서게 한다 — 틱마다 409 로 자리만 차지하지 않게",
      st6 === 409 && !!n6b && n6b.getTime() > NOW, JSON.stringify({ st6, n6b }));
    //  이 판의 몫이 아닌 단위는 건드리지 않는다 — 때가 안 된 단위(사람이 띄운 판) · 다른 앱만 정한 판.
    await itemsPool.query(`UPDATE collect_unit SET next_at = $2, read_at = $3, sched = '{}'::jsonb WHERE id=$1`, [u6.id, new Date(NOW + 7200_000), new Date(NOW)]);
    const keep1 = String((await unitBy(CH6)).next_at);
    const stManual = await statusOf(() => planCollectUnits(C, { now: NOW }));
    const keep2 = String((await unitBy(CH6)).next_at);
    await makeDue(u6.id);
    const stNotion = await statusOf(() => planCollectUnits(C, { app: "notion", scheduled: true, now: NOW }));
    const after3 = (await unitBy(CH6)).next_at;
    chk("A2b 때가 안 된 보호 단위(사람이 띄운 판) · 다른 앱만 정한 판의 보호 단위는 물러서게 하지 않는다",
      stManual === 409 && keep1 === keep2 && stNotion === 409 && after3 == null, JSON.stringify({ stManual, keep1, keep2, stNotion, after3 }));
    //  목록 상한(5,000) 너머의 단위는 판정도 기록도 하지 않는다 — 앞에 미끼 보호 단위를 두고 상한 너머에 노리는 보호 단위를 둬도 열리지 않는다.
    const junk = Array.from({ length: 4999 }, (_, i) => [`C0JK${String(i).padStart(6, "0")}`, `j${i}`, "Public Channel"]);
    const big = await ingestRun({ member: E, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH2, "c2", "Private Channel"], ...junk, [CH6, "c6", "Private Channel"]])] });
    chk("B1 목록 상한 너머(5,001번째)의 보호 단위는 열리지 않는다 — 미끼는 확인 대기",
      big.proof_pending === 1 && !(await viewer(u6.id, E)) && (await viewer(priv.id, E))?.verified_at == null && !(await audienceHas(c6[0].id, E)),
      JSON.stringify({ big, v6: await viewer(u6.id, E) }));
    //  일정·임대 칸을 먼저 정해 둔다(물러서기 상한에 이미 닿아 있으면 써도 값이 안 바뀌어 시험이 헛돈다).
    await itemsPool.query(`UPDATE collect_unit SET next_at = now() + interval '1 hour', sched = '{}'::jsonb WHERE id=$1`, [priv.id]);
    const c2before = await unitBy(CH2);
    const pe = proofUnit({ id: priv.id, app: "slack", instance: TEAM, ref: CH2, kind: "private_channel" }, ["1787300000.000001"]);
    const eMiss = await ingestRun({ member: E, plan: { mode: "collect", units: [pe], planned_at: PLANNED }, now: NOW,
      files: [chFile(CH2, [["1787300000.000001", "E 의 가짜"]], { channel_id: CH2, oldest: pe.since, latest: pe.until, limit: 20 })] });
    const c2after = await unitBy(CH2);
    chk("A1b 대기자(담당 아님)의 확인 읽기는 그 단위의 다음 확인·임대를 건드리지 않는다",
      eMiss.per_unit?.[0]?.proof === "no_match" && String(c2after.next_at) === String(c2before.next_at)
        && JSON.stringify(c2after.sched ?? null) === JSON.stringify(c2before.sched ?? null),
      JSON.stringify({ b: [c2before.next_at, c2before.sched], a: [c2after.next_at, c2after.sched] }));
    await itemsPool.query(`UPDATE collect_proof SET attempts = 0, last_at = NULL WHERE unit_id=$1 AND member_id=$2`, [priv.id, E]);
    //  목록에서 빠진 사람은 옛 대기 행으로 되살아나지 않는다.
    await itemsPool.query(`UPDATE collect_proof SET attempts=0, last_at=NULL WHERE unit_id=$1 AND member_id=$2`, [priv.id, C]);
    const leave = await ingestRun({ member: C, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH6, "c6", "Private Channel"]])] });
    const left = !(await viewer(priv.id, C)) && !(await proofRowOf(C));
    const back = await ingestRun({ member: C, plan: { mode: "collect", units: [cu], planned_at: PLANNED }, now: NOW,
      files: [chFile(CH2, [["1787300000.000001", "글"]], { channel_id: CH2, oldest: cu.since, latest: cu.until, limit: 20 })] });
    chk("N4 목록에서 빠지면 대기 행도 지운다 · 빠진 사람은 확인 읽기를 통과해도 구성원으로 되살아나지 않는다",
      leave.complete === true && left && back.per_unit?.[0]?.proof === "not_member" && !(await viewer(priv.id, C)), JSON.stringify({ leave, back: back.per_unit?.[0] }));
    //  다른 길로(관리자 정리 · 신고 목록의 «전부» 등) 구성원 행이 없어진 단위 — 대기 행이 남아 있어도 싣지 않는다.
    await itemsPool.query(`UPDATE collect_proof SET attempts = 0, last_at = NULL WHERE unit_id=$1 AND member_id=$2`, [u6.id, C]);
    const hadU6 = (await pendingProofs(C, 5)).some((p) => p.unit_id === u6.id);
    await itemsPool.query(`DELETE FROM collect_unit_member WHERE unit_id=$1 AND member_id=$2`, [u6.id, C]);
    const hasU6 = (await pendingProofs(C, 5)).some((p) => p.unit_id === u6.id);
    chk("N4b 구성원 행이 없는 단위의 대기는 싣지 않는다(대기 행이 남아 있어도)", hadU6 && !hasU6 && !!(await proofRowOf(C, u6.id)), JSON.stringify({ hadU6, hasU6 }));
    const tp = toIngestPlan("collect", { units: [cu, planned(u1)], planned_at: PLANNED });
    chk("P1 실행 기록에서 읽은 계획이 확인 읽기 표시를 잃지 않는다", JSON.stringify(tp?.units.map((u) => u.proof)) === "[true,false]", JSON.stringify(tp?.units));
  }

  // ── 확인 판정 오류는 그 단위만 실패 — 같은 판의 다른 단위는 그대로 저장 ──
  {
    await store.recordUnitListing({ member: A, app: "slack", connector: "Slack", instance: TEAM, verified: true,
      items: [{ ref: CH10, kind: "private_channel", name: "c10" }, { ref: CH11, kind: "private_channel", name: "c11" }] });
    const u10 = await unitBy(CH10), u11 = await unitBy(CH11);
    await activate(u10.id); await activate(u11.id);
    await ingestRun({ member: A, plan: { mode: "collect", units: [planned(u10)], planned_at: PLANNED }, now: NOW, files: [chFile(CH10, [["1787500000.000001", "c10 글"]])] });
    const yl = await ingestRun({ member: Y, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH10, "c10", "Private Channel"], [CH11, "c11", "Private Channel"]])] });
    await itemsPool.query(`CREATE OR REPLACE FUNCTION ci_pg_proof_boom() RETURNS trigger AS $$ BEGIN
      IF NEW.member_id = '${Y}' AND NEW.verified_at IS NOT NULL AND OLD.verified_at IS NULL THEN RAISE EXCEPTION 'ci boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await itemsPool.query(`CREATE TRIGGER ci_pg_proof_boom_t BEFORE UPDATE ON collect_unit_member FOR EACH ROW EXECUTE FUNCTION ci_pg_proof_boom()`);
    try {
      const p10 = proofUnit({ id: u10.id, app: "slack", instance: TEAM, ref: CH10, kind: "private_channel" }, ["1787500000.000001"]);
      const iso = await ingestRun({ member: Y, plan: { mode: "collect", units: [p10, planned(u11)], planned_at: PLANNED }, now: NOW, files: [
        chFile(CH10, [["1787500000.000001", "c10 글"]], { channel_id: CH10, oldest: p10.since, latest: p10.until, limit: 20 }), chFile(CH11, [["1787500100.000001", "c11 새 글"]])] });
      const r10 = iso.per_unit?.find((x) => x.id === u10.id), r11 = iso.per_unit?.find((x) => x.id === u11.id);
      chk("N5 확인 판정 중 오류는 그 단위만 실패로 — 같은 판의 다른 단위는 저장된다 · 확인되지 않는다",
        yl.proof_pending === 1 && iso.state === "done" && r10?.failed === 1 && /확인 읽기 오류/.test(r10?.reason ?? "") && r11?.stored === 1
          && (await sources("slack", TEAM, `${CH11}:`)).length === 1 && (await viewer(u10.id, Y))?.verified_at == null, JSON.stringify({ yl: yl.proof_pending, per: iso.per_unit }));
      const yRow = (await itemsPool.query(`SELECT last_at, misses, attempts FROM collect_proof WHERE unit_id=$1 AND member_id=$2`, [u10.id, Y])).rows[0];
      chk("N5b 판정 오류도 못 푼 결과로 남긴다 — 시도 시각이 남아 1시간 간격이 걸린다", !!yRow?.last_at && yRow.misses === 1 && yRow.attempts === 0, JSON.stringify(yRow));
    } finally {
      await itemsPool.query(`DROP TRIGGER IF EXISTS ci_pg_proof_boom_t ON collect_unit_member`);
      await itemsPool.query(`DROP FUNCTION IF EXISTS ci_pg_proof_boom()`);
    }
  }

  // ── 지메일 · 노션 ──
  {
    const lres = await ingestRun({ member: A, plan: { mode: "listing", app: "gmail" }, files: [file("Gmail", "search_threads", { threads: [{ id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001")] }] })] });
    const box = await unitBy(BOX_A, "gmail", "default");
    chk("I1f 지메일 목록 — 그 사람 이메일과 같은 메일함만 단위(T10 규칙) · 볼 수 있는 구성원", lres.created === 1 && box?.kind === "mailbox" && (await viewer(box.id, A))?.verified_at != null,
      JSON.stringify({ lres, box: box && box.kind }));
    const other = await ingestRun({ member: B, plan: { mode: "listing", app: "gmail" }, files: [file("Gmail", "search_threads", { threads: [{ id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001")] }] })] });
    chk("I1g 남의 메일함 주소로는 단위를 못 세운다(B 의 이메일 ≠ 메일함) · 받지 않은 수를 남긴다", other.created === 0 && other.refused === 1 && !(await viewer(box.id, B)), JSON.stringify(other));
    await activate(box.id);
    const gu = { ...planned(box, { connector: "Gmail" }), since: "1790900000", until: "1790986400" };
    const gfiles = [
      file("Gmail", "search_threads", { threads: [{ id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001")] }] }, { query: "after:1790900000 before:1790986400", pageSize: 50 }),
      file("Gmail", "get_thread", { id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001", { plaintextBody: "본문 전체 — 요약보다 길다" }), GM("18c1a90000000002", "18c1a90000000001", { plaintextBody: "답장" })] },
        { threadId: "18c1a90000000001", messageFormat: "PLAIN_TEXT" }),
    ];
    const gres = await ingestRun({ member: A, plan: { mode: "collect", units: [gu], planned_at: PLANNED }, files: gfiles, now: NOW });
    const g = await sources("gmail", "default", "18c1a9");
    const gb = await unitBy(BOX_A, "gmail", "default");
    chk("I2f 지메일 — 좌표 = 메시지 id · parent = 스레드 · 본문 전체(요약이 아니다) · 위치 = 구간 끝",
      gres.per_unit?.[0]?.inserted === 2 && g.length === 2 && g[0].body_md === "본문 전체 — 요약보다 길다" && g[1].parent_external_id === "18c1a90000000001" && gb.cursor?.after === 1790986400,
      JSON.stringify({ g: g.map((r) => [r.external_id, r.parent_external_id, r.body_md]), cursor: gb.cursor }));
    await itemsPool.query(`UPDATE collect_unit_member SET verified_at=NULL WHERE unit_id=$1 AND member_id=$2`, [box.id, A]);
    const relist = await ingestRun({ member: A, plan: { mode: "listing", app: "gmail" }, files: [file("Gmail", "search_threads", { threads: [{ id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001")] }] })] });
    chk("G5 메일함은 확인 읽기 대상이 아니다 — 자료가 있어도 주인 이메일 규칙으로 바로 확인",
      relist.proof_pending === 0 && (await viewer(box.id, A))?.verified_at != null
        && (await itemsPool.query(`SELECT 1 FROM collect_proof WHERE unit_id=$1`, [box.id])).rowCount === 0, JSON.stringify(relist));
  }
  {
    await store.recordUnitListing({ member: A, app: "notion", connector: "Notion", instance: NOTION_INST, items: [{ ref: PAGE, kind: "page", name: "회의록" }], verified: true });
    const pu = await unitBy(PAGE, "notion", NOTION_INST);
    await activate(pu.id);
    const nplan = { mode: "collect", units: [planned(pu, { connector: "Notion", since: null })], planned_at: PLANNED };
    const nres = await ingestRun({ member: A, plan: nplan, now: NOW, files: [
      file("Notion", "notion-fetch", { metadata: { type: "page" }, title: "회의록", url: `https://www.notion.so/x-${PAGE.replace(/-/g, "")}`, text: "<content>\n본문\n</content>", page_last_edited_at: "2026-08-25T10:37:30.618Z" }, { id: PAGE }),
    ] });
    const n = await sources("notion", NOTION_INST, PAGE);
    chk("I2g 노션 — 좌표 = 하이픈 UUID · 위치 = 수정 시각", nres.per_unit?.[0]?.inserted === 1 && n.length === 1 && (await unitBy(PAGE, "notion", NOTION_INST)).cursor?.edited_at === "2026-08-25T10:37:30.618Z",
      JSON.stringify({ nres: { ...nres, per_unit: undefined }, n: n.length }));
    const err = await ingestRun({ member: A, plan: nplan, now: NOW, files: [file("Notion", "notion-fetch", { error: "object_not_found" }, { id: PAGE })] });
    const n2 = await itemsPool.query(`SELECT title, body_md FROM source WHERE external_system='notion' AND external_instance=$1 AND external_id=$2`, [NOTION_INST, PAGE]);
    //  앱을 정한 판의 확인 대기 — 앱 거르기는 상한보다 먼저(다른 앱의 오래된 대기가 줄 앞을 막지 않게). E 는 슬랙 CH2 대기(B1)가 더 오래됐다.
    const nl = await ingestRun({ member: E, plan: { mode: "listing", app: "notion" }, files: [file("Notion", "notion-search", { results: [
      { type: "page", url: `https://www.notion.so/x-${PAGE.replace(/-/g, "")}`, title: "회의록" }] }, { query: "회의" })] });
    const pn = await pendingProofs(E, 1, { app: "notion" }), pany = await pendingProofs(E, 1);
    chk("N3 앱을 정하면 그 앱의 대기를 상한 안에서 고른다 · 정하지 않으면 오래된 것부터",
      nl.proof_pending === 1 && pn.length === 1 && pn[0].unit_id === pu.id && pany.length === 1 && pany[0].app === "slack", JSON.stringify({ nl, pn, pany }));
    //  #4744 주기 판 — 확인 대기만 있는 구성원(E: 담당 단위 없음)도 고르고, 그 판의 계획은 확인 읽기만으로 선다 · 같은 대기는 1시간 간격.
    const startedM = [];
    const tick = await collectScheduleTick({ force: true, maxConcurrent: 50, policy: async () => "allowed", running: () => new Set(), read: async () => null,
      start: async (m) => { startedM.push(m); return { runId: `cr-20261016100000-pg${startedM.length}` }; } });
    chk("S1 확인 대기만 있는 구성원도 주기 판에 오른다", (tick.proof_members ?? 0) >= 1 && startedM.includes(E), JSON.stringify({ tick, startedM }));
    const sp = await planCollectUnits(E, { scheduled: true, now: NOW });
    chk("S2 주기 판의 계획은 때가 된 단위 없이 확인 읽기만으로도 선다", sp.units.length === 2 && sp.units.every((u) => u.proof === true)
      && JSON.stringify(sp.units.map((u) => u.app).sort()) === '["notion","slack"]', JSON.stringify(sp.units));
    await itemsPool.query(`UPDATE collect_proof SET last_at = now() WHERE member_id = $1`, [E]);
    const soon = (await proofDueMembers()).some((x) => x.member === E);
    await itemsPool.query(`UPDATE collect_proof SET last_at = now() - interval '2 hours' WHERE member_id = $1`, [E]);
    const later = (await proofDueMembers()).find((x) => x.member === E);
    chk("S3 같은 대기를 틱마다 읽지 않는다 — 마지막 시도에서 1시간이 지나야 다시 고른다", !soon && later?.units === 2, JSON.stringify({ soon, later }));
    await itemsPool.query(`UPDATE collect_proof SET requested_at = now() - interval '15 days' WHERE member_id = $1`, [E]);
    const expired = !(await proofDueMembers()).some((x) => x.member === E);
    await requestProof(E, [pu.id]);
    const again = (await proofDueMembers()).find((x) => x.member === E);
    chk("S4 대기를 건 지 14일이 지나면 주기 판이 스스로 띄우지 않는다 · 대기를 다시 걸면(다시 목록) 그 단위만 다시 센다",
      expired && again?.units === 1, JSON.stringify({ expired, again }));
    chk("I2h 노션 오류 결과는 있던 페이지를 빈 페이지로 덮지 않는다", err.per_unit?.[0]?.unparsed === 1 && err.per_unit?.[0]?.stored === 0 && n2.rows[0]?.title === "회의록" && /본문/.test(n2.rows[0]?.body_md ?? ""),
      JSON.stringify({ err: err.per_unit?.[0], row: n2.rows[0] }));
  }
  {
    //  팀이 하나뿐이라 «그 팀» 으로 추정한 목록은 «전부» 로 넘기지 않는다(틀린 팀이면 그 팀의 via-listing 자리를 지운다).
    await itemsPool.query(`DELETE FROM collect_unit WHERE app='slack' AND instance=$1`, [TEAM2]);
    const res = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, files: [listFile([["C0CIPG0005", "fresh", "Public Channel"]])] });
    chk("I1h 추정한 팀(single)의 목록은 «전부» 가 아니다 — A 의 다른 단위에서 A 를 빼지 않는다",
      res.instance === TEAM && res.complete === false && !!(await viewer(u1.id, A)), JSON.stringify(res));
  }

  // ── I4 한 실행은 그 주인이 한 번만 ──
  {
    const runId = "cr-20261016100000-cipg01";
    await log.recordRunStart({ runId, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: new Date(NOW), mode: "collect", plan });
    chk("I4 남의 실행은 못 잡는다(주인 확인)", (await log.claimIngest(runId, B)) === null);
    const claims = await Promise.all([1, 2, 3, 4, 5].map(() => log.claimIngest(runId, A)));
    const won = claims.filter(Boolean);
    chk("I4b 동시에 다섯이 잡아도 하나만 · 계획·구성원은 실행 기록에서", won.length === 1 && won[0].member === A && won[0].mode === "collect" && won[0].plan?.units?.length === 2,
      JSON.stringify({ won: won.length }));
    const tp = toIngestPlan(won[0]?.mode, won[0]?.plan);
    chk("I4c 실행 기록의 계획 → 저장 단계 계획(계획 시각 포함 · 모양이 틀린 단위는 뺀다 · 점검은 없음)", tp?.units?.length === 2 && tp?.planned_at === PLANNED
      && toIngestPlan("collect", { units: [{ id: 1, app: "slack", ref: "bad ref", instance: "" }] })?.units?.length === 0 && toIngestPlan("probe", {}) === null, JSON.stringify(tp));
    await log.finishIngest(runId, { state: "done", stored: 3 });
    const v = await log.getRunIngest(runId);
    chk("I4d 끝낸 실행은 다시 안 잡히고 결과가 남는다", v?.state === "done" && v?.stored === 3 && v?.mode === "collect" && (await log.claimIngest(runId, A)) === null, JSON.stringify(v));
    const stuck = "cr-20261016100000-cipg02", fresh = "cr-20261016100000-cipg03";
    for (const id of [stuck, fresh]) await log.recordRunStart({ runId: id, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: new Date(NOW), mode: "collect", plan });
    await itemsPool.query(`UPDATE collect_run SET ingest = jsonb_build_object('state','running','at', now() - interval '16 minutes') WHERE run_id=$1`, [stuck]);
    await itemsPool.query(`UPDATE collect_run SET ingest = jsonb_build_object('state','running','at', now() - interval '14 minutes') WHERE run_id=$1`, [fresh]);
    chk("I4e 처리 중에 멈춘 지 15분이 지나면 다시 잡힌다(14분은 아니다)", !!(await log.claimIngest(stuck, A)) && (await log.claimIngest(fresh, A)) === null);
    const probe = "cr-20261016100000-cipg04";
    await log.recordRunStart({ runId: probe, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: new Date(NOW) });
    chk("I4f 점검 실행(종류 없음)은 저장 차례가 안 잡힌다", (await log.claimIngest(probe, A)) === null);
    const plans = (await itemsPool.query(`SELECT plan::text AS p FROM collect_run WHERE member_id=$1 AND plan IS NOT NULL`, [A])).rows.map((r) => r.p);
    chk("I4g 실행 기록의 계획에 단위 이름이 없다(비공개 채널·DM 이름은 collect_unit 에만)", plans.length > 0 && plans.every((p) => !p.includes("#c1") && !/"name"/.test(p)), plans[0]);
  }

  // ── J2 실행 종류 — 띄우기 전에 거절 ──
  {
    const run = collectRunCapabilities.find((c) => c.name === "collect_claude_run");
    if (!run) throw new Error("collect_claude_run 를 못 찾았다(배선)");
    const user = { userId: NOBODY, email: "", scopes: ["items", "context", "memory"], projects: [] };
    const s1 = await statusOf(() => run.handler({ mode: "collect" }, user, { source: "pg-test" }));
    const s2 = await statusOf(() => run.handler({ mode: "listing" }, user, { source: "pg-test" }));
    const s3 = await statusOf(() => run.handler({ mode: "listing", app: "jira" }, user, { source: "pg-test" }));
    chk("J2 맡은 단위가 없으면 409 · 목록에 앱이 없으면 400 · 모르는 앱 400 (세션을 띄우지 않는다)", s1 === 409 && s2 === 400 && s3 === 400, `${s1} ${s2} ${s3}`);
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  await cleanup().catch((e) => console.error("cleanup 실패", e?.message));
  await itemsPool.end().catch(() => {});
}
console.log(`collect-ingest pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
