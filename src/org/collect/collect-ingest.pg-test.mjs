// 수집 실행의 저장 단계(#4213 T11) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/collect/collect-ingest.pg-test.mjs
//
// 왜 이 계층인가: 저장 단계의 약속은 원문을 푼 뒤 **T10 표가 지키는 사실**이다 — «목록으로 본 사람은 확인된 구성원» ·
//  «같은 좌표는 한 행(두 번 넣어도 새 행 없음)» · «요청 안 한 채널의 글은 안 들어간다» · «안 읽은 단위는 위치를 안 옮긴다» ·
//  «담당이 아니면 위치를 못 옮긴다» · «한 실행은 한 번만 처리». 풀기 셈(순수)은 collect-plan.test.ts · connector-parse.test.ts.
//  여기는 run-ingest(ingestRun) 를 실제 표에 대고 부른 뒤 **행을 되읽어** 판정한다(사양 I1~I5 · J2).
//  원문은 커넥터 결과의 모양만 옮긴 합성 글이다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/collect/unit-store.js`);
const { ingestRun, resolveInstance } = await import(`${DIST}/org/collect/run-ingest.js`);
const log = await import(`${DIST}/org/collect/run-log.js`);
const { collectRunCapabilities } = await import(`${DIST}/capabilities/collect-run.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const statusOf = async (fn) => { try { await fn(); return 200; } catch (e) { return e?.status ?? 500; } };

const A = "__ci_pg_a__", B = "__ci_pg_b__", NOBODY = "__ci_pg_none__";
const MEMBERS = [A, B, NOBODY];
const TEAM = "T_CIPG";                       // 이 시험만 쓰는 슬랙 팀(인스턴스)
const TEAM2 = "T_CIPG_OTHER";                // 다른 팀 하나 더 — «팀이 하나뿐이면 그것»(②)이 답을 대신 내지 못하게
const NOTION_INST = "cipg-notion";
const CH1 = "C0CIPG0001", CH2 = "C0CIPG0002", CH3 = "C0CIPG0003", STRAY = "C0CIPG0009";
const BOX_A = "a@cipg.test";
const PAGE = "abcdef01-2345-6789-abcd-ef01cafe0001";

const file = (connector, tool, inner, input = {}) => ({
  tool_name: `mcp__claude_ai_${connector}__${tool}`, tool_input: input,
  tool_response: [{ type: "text", text: typeof inner === "string" ? inner : JSON.stringify(inner) }],
});
const listFile = (rows, cursor) => file("Slack", "slack_list_user_channels", {
  result: [...rows.flatMap(([id, name, type, archived]) => [`### #${name}`, `- **ID:** ${id}`, `- **Type:** ${type}`, ...(archived ? ["- **Archived:** Yes"] : []), ""]),
    ...(cursor ? [`There are more results available. Use cursor: "${cursor}"`] : [])].join("\n"),
});
const chFile = (ch, msgs) => file("Slack", "slack_read_channel", {
  messages: [`Channel: #c (${ch})`, "", ...msgs.flatMap(([ts, body, tail]) => [`=== Message from Kim <kim@cipg.test> (U0CIPG0001) at x ===`, `Message TS: ${ts}`, body, ...(tail ? [tail] : []), ""])].join("\n"),
  pagination_info: "",
}, { channel_id: ch });
const thFile = (ch, parent, replies) => file("Slack", "slack_read_thread", {
  messages: ["=== THREAD PARENT MESSAGE ===", "From: Kim <kim@cipg.test> (U0CIPG0001)", "Time: x", `Message TS: ${parent}`, "부모", "",
    "=== THREAD REPLIES (n) ===", "", ...replies.flatMap((ts, i) => [`--- Reply ${i + 1} of ${replies.length} ---`, "From: Lee (U0CIPG0002)", "Time: y", `Message TS: ${ts}`, `답글 ${i + 1}`, ""])].join("\n"),
}, { channel_id: ch, message_ts: parent });
const GM = (id, threadId, o = {}) => ({ id, threadId, subject: "견적", sender: "Kim <kim@cipg.test>", date: "2026-10-02T23:49:36Z", snippet: "요약",
  labelIds: [], viewUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(BOX_A)}#all/${id}`, ...o });

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
const planned = (u, o = {}) => ({ id: u.id, app: u.app, instance: u.instance, ref: u.ref, kind: u.kind, name: u.name, connector: u.connector || "Slack",
  since: "1787000000.000000", until: null, ...o });

async function cleanup() {
  await itemsPool.query(`DELETE FROM collect_unit WHERE (app='slack' AND instance = ANY($1::text[])) OR (app='notion' AND instance=$2) OR (app='gmail' AND lower(ref)=$3)`, [[TEAM, TEAM2], NOTION_INST, BOX_A]);
  await itemsPool.query(`DELETE FROM source WHERE (external_system='slack' AND external_instance=$1) OR (external_system='notion' AND external_instance=$2)
                           OR (external_system='gmail' AND external_id LIKE '18c1a9%')`, [TEAM, NOTION_INST]);
  await itemsPool.query(`DELETE FROM collect_assignee_state WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM collect_run WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [MEMBERS]);
}

try {
  await cleanup();
  for (const m of [A, B]) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, m === A ? BOX_A : "b@cipg.test"]);
  //  이 워크스페이스가 이미 아는 슬랙 팀 — CH1 은 예전에 수집기·목록으로 생긴 단위다(인스턴스 TEAM).
  await store.recordUnitListing({ member: A, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: CH1, kind: "channel", name: "#c1" }], verified: true });
  await store.recordUnitListing({ member: B, app: "slack", connector: "Slack", instance: TEAM2, items: [{ ref: "C0CIPG0008", kind: "channel", name: "#other" }], verified: true });

  // ── I1 목록 실행 ──
  {
    const res = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, files: [
      listFile([[CH1, "c1", "Public Channel"], [CH3, "old", "Public Channel", true]], "next"),
      listFile([[CH2, "c2", "Private Channel"]]),
    ] });
    const u1 = await unitBy(CH1), u2 = await unitBy(CH2), u3 = await unitBy(CH3);
    const v2 = u2 ? await viewer(u2.id, A) : null;
    chk("I1 목록 — 이미 아는 팀으로 단위를 세우고(①) 새 단위는 «후보» · 그 사람은 확인된 볼 수 있는 구성원 · 보관 채널은 안 세운다",
      res.state === "done" && res.listed === 2 && res.created === 1 && res.instance === TEAM && res.complete === true
        && u1 && u2 && u2.state === "candidate" && u2.kind === "private_channel" && v2?.verified_at != null && !u3,
      JSON.stringify({ res, u2: u2 && { state: u2.state, kind: u2.kind }, v2, u3: !!u3 }));
    const again = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, files: [listFile([[CH1, "c1", "Public Channel"], [CH2, "c2", "Private Channel"]])] });
    chk("I1b 같은 목록을 또 넣어도 새 단위 없음", again.state === "done" && again.created === 0, JSON.stringify(again));
    const none = await ingestRun({ member: A, plan: { mode: "listing", app: "slack" }, files: [chFile(CH1, [])] });
    chk("I1c 목록 도구를 안 부른 실행은 실패로 남긴다(단위를 지우지도 세우지도 않는다)", none.state === "failed" && /목록 도구/.test(none.error ?? ""), JSON.stringify(none));
    chk("I1d 인스턴스 — 같은 ref 를 가진 기존 단위의 팀(팀이 둘이어도) · 모르는 ref 이고 팀이 둘이면 빈 값 · 지메일은 default",
      (await resolveInstance("slack", [CH2])) === TEAM && (await resolveInstance("slack", ["C0CIPG0007"])) === "" && (await resolveInstance("gmail", [])) === "default");
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
  const plan = { mode: "collect", units: [planned(u1), planned(u2)] };
  const NOW = Date.parse("2026-10-16T10:00:00.000Z");
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
    const vis = await Promise.all(rows.map((r) => audienceHas(r.id, A)));
    chk("I2b 저장한 자료는 그 단위의 확인된 구성원에게 보인다", vis.every(Boolean), JSON.stringify(vis));
    const a1 = await unitBy(CH1), a2 = await unitBy(CH2);
    chk("I2c 끝까지 읽은 단위는 위치 = 채널에서 본 가장 새 ts · 읽은 시각 = 이 판", a1.cursor?.ts === "1787195400.000200" && new Date(a1.read_at).getTime() === NOW && p1?.cursor_moved === true,
      JSON.stringify({ cursor: a1.cursor, read_at: a1.read_at }));
    chk("I2d 이 판이 안 읽은 단위는 위치·읽은 시각을 안 옮긴다(다음 판이 다시 맡는다)", p2?.reads === 0 && p2?.reason === "이 판이 읽지 않음" && a2.read_at == null
      && JSON.stringify(a2.cursor ?? {}) === "{}", JSON.stringify({ p2, read_at: a2.read_at, cursor: a2.cursor }));
    const again = await ingestRun({ member: A, plan, files, now: NOW + 60_000 });
    const rows2 = await sources("slack", TEAM, "C0CIPG");
    chk("I5 같은 원문을 다시 넣어도 새 행이 없다(inserted 0) — 같은 좌표", again.inserted === 0 && again.stored === 3 && rows2.length === 3, JSON.stringify({ ...again, per_unit: undefined }));
  }
  {
    //  B 는 이 단위를 볼 수 있는 구성원이 아니다 — 원문을 B 의 실행 결과로 넣으면 저장도 위치도 거절된다.
    const res = await ingestRun({ member: B, plan: { mode: "collect", units: [planned(u1)] }, files: [chFile(CH1, [["1787199999.000001", "B 가 넣으려는 글"]])], now: NOW });
    const p = res.per_unit?.[0];
    const row = (await sources("slack", TEAM, `${CH1}:1787199999`))[0];
    const a1 = await unitBy(CH1);
    chk("I6 볼 수 있는 구성원이 아닌 실행은 저장·위치 이동 둘 다 못 한다", p?.stored === 0 && !row && a1.cursor?.ts === "1787195400.000200" && /볼 수 있는 구성원/.test(p?.reason ?? ""),
      JSON.stringify({ p, row: !!row, cursor: a1.cursor }));
  }

  // ── 지메일 · 노션 ──
  {
    const lres = await ingestRun({ member: A, plan: { mode: "listing", app: "gmail" }, files: [file("Gmail", "search_threads", { threads: [{ id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001")] }] })] });
    const box = await unitBy(BOX_A, "gmail", "default");
    chk("I1e 지메일 목록 — 그 사람 이메일과 같은 메일함만 단위(T10 규칙) · 볼 수 있는 구성원", lres.created === 1 && box?.kind === "mailbox" && (await viewer(box.id, A))?.verified_at != null,
      JSON.stringify({ lres, box: box && box.kind }));
    const other = await ingestRun({ member: B, plan: { mode: "listing", app: "gmail" }, files: [file("Gmail", "search_threads", { threads: [{ id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001")] }] })] });
    chk("I1f 남의 메일함 주소로는 단위를 못 세운다(B 의 이메일 ≠ 메일함)", other.created === 0 && !(await viewer(box.id, B)), JSON.stringify(other));
    await activate(box.id);
    const gfiles = [
      file("Gmail", "search_threads", { threads: [{ id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001")] }] }),
      file("Gmail", "get_thread", { id: "18c1a90000000001", messages: [GM("18c1a90000000001", "18c1a90000000001", { plaintextBody: "본문 전체 — 요약보다 길다" }), GM("18c1a90000000002", "18c1a90000000001", { plaintextBody: "답장" })] }),
    ];
    const gres = await ingestRun({ member: A, plan: { mode: "collect", units: [{ ...planned(box, { connector: "Gmail" }), since: "1790900000", until: "1790986400" }] }, files: gfiles, now: NOW });
    const g = await sources("gmail", "default", "18c1a9");
    const gb = await unitBy(BOX_A, "gmail", "default");
    chk("I2e 지메일 — 좌표 = 메시지 id · parent = 스레드 · 본문 전체(요약이 아니다) · 위치 = 구간 끝",
      gres.per_unit?.[0]?.inserted === 2 && g.length === 2 && g[0].body_md === "본문 전체 — 요약보다 길다" && g[1].parent_external_id === "18c1a90000000001" && gb.cursor?.after === 1790986400,
      JSON.stringify({ g: g.map((r) => [r.external_id, r.parent_external_id, r.body_md]), cursor: gb.cursor }));
  }
  {
    await store.recordUnitListing({ member: A, app: "notion", connector: "Notion", instance: NOTION_INST, items: [{ ref: PAGE, kind: "page", name: "회의록" }], verified: true });
    const pu = await unitBy(PAGE, "notion", NOTION_INST);
    await activate(pu.id);
    const nres = await ingestRun({ member: A, plan: { mode: "collect", units: [planned(pu, { connector: "Notion", since: null })] }, now: NOW, files: [
      file("Notion", "notion-fetch", { metadata: { type: "page" }, title: "회의록", url: `https://www.notion.so/x-${PAGE.replace(/-/g, "")}`, text: "<content>\n본문\n</content>", page_last_edited_at: "2026-08-25T10:37:30.618Z" }),
    ] });
    const n = await sources("notion", NOTION_INST, PAGE);
    chk("I2f 노션 — 좌표 = 하이픈 UUID · 위치 = 수정 시각", nres.per_unit?.[0]?.inserted === 1 && n.length === 1 && (await unitBy(PAGE, "notion", NOTION_INST)).cursor?.edited_at === "2026-08-25T10:37:30.618Z",
      JSON.stringify({ nres: { ...nres, per_unit: undefined }, n: n.length }));
  }

  // ── I4 한 실행은 한 번만 ──
  {
    const runId = "cr-20261016100000-cipg01";
    await log.recordRunStart({ runId, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: new Date(NOW), mode: "collect", plan });
    const c1 = await log.claimIngest(runId), c2 = await log.claimIngest(runId);
    chk("I4 차례 잡기 — 처음 한 번만 · 계획·구성원은 실행 기록에서", c1 && c1.member === A && c1.mode === "collect" && c1.plan?.units?.length === 2 && c2 === null, JSON.stringify({ c1: !!c1, c2 }));
    await log.finishIngest(runId, { state: "done", stored: 3 });
    const v = await log.getRunIngest(runId);
    chk("I4b 끝낸 실행은 다시 안 잡히고 결과가 남는다", v?.state === "done" && v?.stored === 3 && v?.mode === "collect" && (await log.claimIngest(runId)) === null, JSON.stringify(v));
    const stuck = "cr-20261016100000-cipg02";
    await log.recordRunStart({ runId: stuck, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: new Date(NOW), mode: "collect", plan });
    await itemsPool.query(`UPDATE collect_run SET ingest = jsonb_build_object('state','running','at', now() - interval '16 minutes') WHERE run_id=$1`, [stuck]);
    const fresh = "cr-20261016100000-cipg03";
    await log.recordRunStart({ runId: fresh, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: new Date(NOW), mode: "collect", plan });
    await itemsPool.query(`UPDATE collect_run SET ingest = jsonb_build_object('state','running','at', now() - interval '14 minutes') WHERE run_id=$1`, [fresh]);
    chk("I4c 처리 중에 멈춘 지 15분이 지나면 다시 잡힌다(14분은 아니다)", !!(await log.claimIngest(stuck)) && (await log.claimIngest(fresh)) === null);
    const probe = "cr-20261016100000-cipg04";
    await log.recordRunStart({ runId: probe, member: A, apps: ["Slack"], model: "haiku", capMb: 1024, requestMb: 640, startedAt: new Date(NOW) });
    chk("I4d 점검 실행(종류 없음)은 저장 차례가 안 잡힌다", (await log.claimIngest(probe)) === null);
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
