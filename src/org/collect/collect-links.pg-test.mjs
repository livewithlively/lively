// 링크 따라 읽기(#4213 T12 #4744) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/collect/collect-links.pg-test.mjs
//
// 왜 이 계층인가: 이 기능의 약속은 **표가 지키는 사실**이다 — «글 속 링크가 (앱 · 대상 · 나온 단위) 한 줄로 적힌다(메일함 글은 안 적는다)» ·
//  «링크로 읽은 문서는 링크가 있던 단위가 아니라 그 문서의 단위에 들어간다(공개 채널이 비공개 페이지를 링크해도 채널을 보는 사람에게 안 열린다)» ·
//  «그 단위의 모을지 결정(모으지 않기로 함 · 수집기 경로 · 남의 나만 · 공개범위를 끈 곳의 검토 안 된 단위)을 따른다» · «노션 페이지 단위는 없으면
//  후보·볼 수 있는 사람만·읽은 사람만 확인으로 생긴다» · «슬랙은 그 채널이 단위이고 읽은 사람이 구성원일 때만» · «다음 판에는 넣을 수 있는 대상만
//  싣는다 · 오류 모양이면 쉬고 3번에서 멈춘다» · «연결 제안은 부르는 사람의 것 · 지금 연결 기준». 판정(순수)은 link-plan.test.ts · link-harvest.test.ts.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/collect/unit-store.js`);
const { ingestRun } = await import(`${DIST}/org/collect/run-ingest.js`);
const links = await import(`${DIST}/org/collect/link-store.js`);
const { extractAppLinks } = await import(`${DIST}/org/collect/link-plan.js`);
const { collectUnitCapabilities } = await import(`${DIST}/capabilities/collect-units.js`);
const { visAxes, setVisAxes } = await import(`${DIST}/v6/visibility-axes.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__ci_link_a__", B = "__ci_link_b__", C = "__ci_link_c__";
const MEMBERS = [A, B, C];
const TEAM = "T_CILINK";
const CH = "C0CILNK001", C2 = "C0CILNK002", C3 = "C0CILNK003", C4 = "C0CILNK004";
const hex = (n) => n.toString(16).padStart(32, "0");
const uuid = (n) => { const h = hex(n); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const N_UNIT = uuid(0x41a0), P1 = uuid(0x41b1), P2 = uuid(0x41b2), P3 = uuid(0x41b3), P5 = uuid(0x41b5), P6 = uuid(0x41b6), P7 = uuid(0x41b7), P8 = uuid(0x41b8), P9 = uuid(0x41b9);
const PC = uuid(0x41bc), OLD = uuid(0x4297), P11 = uuid(0x41c1), P12 = uuid(0x41c2), X1 = uuid(0x4210), X2 = uuid(0x4211);
const C5 = "C0CILNK005", C6 = "C0CILNK006", C7 = "C0CILNK007", C8 = "C0CILNK008", C9 = "C0CILNK009";
const EXTRA = Array.from({ length: 7 }, (_, i) => uuid(0x4200 + i));
const NOTION_REFS = [N_UNIT, P1, P2, P3, P5, P6, P7, P8, P9, PC, OLD, P11, P12, X1, X2, ...EXTRA, uuid(0x4299), uuid(0x4298)];
const MAILBOX = "__ci_link_a__@cilink.test";
const nlink = (id) => `https://www.notion.so/acme/Doc-${id.replace(/-/g, "")}`;
const PLANNED = Math.floor(Date.now() / 1000);
const D = 86400;

const unitBy = async (app, ref) => (await itemsPool.query(`SELECT * FROM collect_unit WHERE app=$1 AND ref=$2`, [app, ref])).rows[0];
async function makeUnit(app, ref, member, o = {}) {
  await store.recordUnitListing({ member, app, connector: app === "notion" ? "Notion" : app === "gmail" ? "Gmail" : "Slack",
    instance: app === "notion" ? "" : app === "gmail" ? "default" : TEAM,
    items: [{ ref, kind: o.kind ?? (app === "notion" ? "page" : app === "gmail" ? "mailbox" : "private_channel"), name: o.name ?? ref }], verified: true });
  const u = await unitBy(app, ref);
  await itemsPool.query(`UPDATE collect_unit SET state=$2 WHERE id=$1`, [u.id, o.state ?? "active"]);
  if (o.set) await itemsPool.query(`UPDATE collect_unit SET ${o.set} WHERE id=$1`, [u.id]);
  return unitBy(app, ref);
}
async function connector(member, app, status) {
  await itemsPool.query(
    `INSERT INTO member_ai_connector(member_id, provider, app, status, origin) VALUES($1,'claude',$2,$3,'probe')
     ON CONFLICT (tenant_id, member_id, provider, app) DO UPDATE SET status = EXCLUDED.status`, [member, app, status]);
}
async function cleanup() {
  await itemsPool.query(`DELETE FROM collect_link WHERE member_id = ANY($1::text[])`, [MEMBERS]).catch(() => {});
  await itemsPool.query(`DELETE FROM collect_proof WHERE member_id = ANY($1::text[])`, [MEMBERS]).catch(() => {});
  await itemsPool.query(`DELETE FROM collect_unit WHERE (app='slack' AND ref LIKE 'C0CILNK%') OR (app='notion' AND ref = ANY($1::text[])) OR (app='gmail' AND ref=$2)`, [NOTION_REFS, MAILBOX]);
  await itemsPool.query(`DELETE FROM source WHERE (external_system='slack' AND external_id LIKE 'C0CILNK%') OR (external_system='notion' AND external_id = ANY($1::text[])) OR (external_system='gmail' AND fields->>'container_ref' = $2)`, [NOTION_REFS, MAILBOX]);
  await itemsPool.query(`DELETE FROM member_ai_connector WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM collect_assignee_state WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE actor = ANY($1::text[])`, [MEMBERS]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [MEMBERS]);
}
const capFile = (tool, input, inner) => ({ tool_name: tool, tool_input: input, tool_response: [{ type: "text", text: JSON.stringify(inner) }] });
const chanFile = (ch, since, msgs) => capFile("mcp__claude_ai_Slack__slack_read_channel", { channel_id: ch, oldest: since, limit: 100 }, {
  messages: [`Channel: #c (${ch})`, "", ...msgs.flatMap(([ts, body]) => [`=== Message from Kim <k@x.test> (U0CILNK01) at x ===`, `Message TS: ${ts}`, body, ""])].join("\n"),
  pagination_info: "There are no more messages available.\n",
});
const threadFile = (ch, parent, replies) => capFile("mcp__claude_ai_Slack__slack_read_thread", { channel_id: ch, message_ts: parent, limit: 200 }, {
  messages: ["=== THREAD PARENT MESSAGE ===", "From: Kim (U0CILNK01)", "Time: x", `Message TS: ${parent}`, "부모 글", "",
    "=== THREAD REPLIES (n) ===", "", ...replies.flatMap((ts, i) => [`--- Reply ${i + 1} of ${replies.length} ---`, "From: Lee (U0CILNK02)", "Time: y", `Message TS: ${ts}`, `답글 ${i + 1}`, ""])].join("\n"),
  pagination_info: "There are no more messages in this thread.\n",
});
const pageFile = (id, body, title = "문서") => capFile("mcp__claude_ai_Notion__notion-fetch", { id }, {
  metadata: { type: "page" }, title, url: `https://www.notion.so/x-${id.replace(/-/g, "")}`, text: `<content>\n${body}\n</content>`,
  page_last_edited_at: new Date(Date.now() - D * 1000).toISOString(),
});
const slackPlanned = (u) => ({ id: u.id, app: "slack", instance: TEAM, ref: u.ref, kind: u.kind, connector: "Slack", since: `${PLANNED - 3 * D}.000000`, until: null });
const notionPlanned = (u, readAt = null) => ({ id: u.id, app: "notion", instance: u.instance, ref: u.ref, kind: "page", connector: "Notion", since: null, until: null, read_at: readAt });
const linkRows = async (member) => (await itemsPool.query(`SELECT app, ref, state, seen_count, tries, from_unit_id, target_unit_id, read_at FROM collect_link WHERE member_id=$1 ORDER BY app, ref`, [member])).rows;
const sourceCount = async (system, like) => Number((await itemsPool.query(`SELECT count(*)::int AS n FROM source WHERE external_system=$1 AND external_id LIKE $2`, [system, like])).rows[0].n);
const pendingRow = async (app, ref, fromUnit, member, o = {}) => itemsPool.query(
  `INSERT INTO collect_link(app, ref, kind, url, channel, thread, from_unit_id, member_id, state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
  [app, ref, app === "notion" ? "page" : "message", o.url ?? `https://x.test/${ref}`, o.channel ?? null, o.thread ?? null, fromUnit, member]);
const isMember = async (app, ref, m) => (await itemsPool.query(`SELECT 1 FROM collect_unit_member x JOIN collect_unit u ON u.id = x.unit_id WHERE u.app=$1 AND u.ref=$2 AND x.member_id=$3`, [app, ref, m])).rows.length > 0;

let axesBefore = null;
try {
  await cleanup();
  for (const m of MEMBERS) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@cilink.test`]);
  axesBefore = await visAxes();
  await setVisAxes({ source: true });

  // ── S1~S4 링크 기록 ──
  {
    const u = await makeUnit("slack", CH, A);
    await connector(A, "Slack", "connected");
    await connector(A, "Notion", "connected");
    await connector(A, "Google Drive", "connected");
    const body = [`결정 문서 ${nlink(P9)}`, "PR https://github.com/acme/web/pull/12", "시트 https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit",
      `메일 https://mail.google.com/mail/u/0/#inbox/abc`, `같은 채널 https://acme.slack.com/archives/${CH}/p${PLANNED - 2 * D}000100`].join("\n");
    const res = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-1",
      plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(u)] },
      files: [chanFile(CH, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000200`, body]])] });
    const rows = await linkRows(A);
    const by = Object.fromEntries(rows.map((r) => [r.app, r]));
    chk("S1 읽을 수 있는 앱(노션) 링크는 pending · 나온 단위 = 그 채널",
      by.notion?.ref === P9 && by.notion.state === "pending" && by.notion.from_unit_id === u.id && res.links?.recorded === rows.length,
      JSON.stringify({ rows, links: res.links }));
    chk("S3 수집 실행이 못 읽는 앱(드라이브·깃허브)은 unsupported · 메일 링크·같은 채널 링크는 안 적는다",
      by.gdrive?.state === "unsupported" && by.github?.state === "unsupported" && !by.gmail && !by.slack, JSON.stringify(rows));
    const ub = await makeUnit("slack", C2, B);
    await ingestRun({ member: B, now: Date.now(), runId: "cr-ci-link-2", plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(ub)] },
      files: [chanFile(C2, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000300`, `문서 ${nlink(P9)}`]])] });
    const rb = await linkRows(B);
    chk("S2 연결 여부는 줄에 굳히지 않는다 — B(노션 연결 안 함)의 줄도 pending", rb.length === 1 && rb[0].app === "notion" && rb[0].state === "pending", JSON.stringify(rb));
    await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-3", plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(u)] },
      files: [chanFile(CH, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000200`, body]])] });
    const again = (await linkRows(A)).filter((r) => r.app === "notion");
    chk("S4 같은 링크를 또 보면 한 줄 · seen_count + 1", again.length === 1 && again[0].seen_count === 2, JSON.stringify(again));
    //  메일함 글 속 링크는 적지 않는다(알림 · 바깥 발신자의 링크가 계획 칸을 채우지 않게). 단위 id 는 진짜(외래키가 막아 헛통과하지 않게).
    const before = (await linkRows(A)).length;
    const mailLinks = extractAppLinks(`새 페이지 ${nlink(uuid(0x4298))} 와 https://github.com/acme/web/issues/1`);
    const mr = await links.recordLinks(A, { id: u.id, app: "gmail", ref: MAILBOX }, mailLinks);
    chk("S1m 메일함 글 속 링크는 적지 않는다", mailLinks.length === 2 && mr.recorded === 0 && (await linkRows(A)).length === before,
      JSON.stringify({ mr, rows: await linkRows(A) }));
  }

  // ── S5~S7 · S10 · S15 노션 링크 읽기(같은 판 · 처음 읽는 단위) — 그 문서의 단위에 ──
  {
    const n = await makeUnit("notion", N_UNIT, A);
    const p2 = await makeUnit("notion", P2, A, { state: "candidate" });
    await makeUnit("notion", P3, C, { state: "candidate", set: `visibility = 'me', owner_member = '${C}'` });
    const before = await sourceCount("notion", N_UNIT);
    const res = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-4",
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(n)] },
      files: [pageFile(N_UNIT, `참고 ${nlink(P1)} · ${nlink(P2)} · ${nlink(P3)}`), pageFile(P1, "링크된 결정 문서", "결정"), pageFile(P2, "있던 단위"), pageFile(P3, "남의 나만")] });
    const u1 = await unitBy("notion", P1);
    const m1 = u1 ? (await itemsPool.query(`SELECT member_id, verified_at IS NOT NULL AS v FROM collect_unit_member WHERE unit_id=$1`, [u1.id])).rows : [];
    const rows = Object.fromEntries((await linkRows(A)).filter((r) => r.app === "notion").map((r) => [r.ref, r]));
    chk("S5 단위가 없던 페이지(P1) — 페이지 단위가 생긴다(후보 · 볼 수 있는 사람만 · 읽은 사람만 확인됨) · 자료가 들어가고 · 링크는 읽음(그 단위)",
      u1 && u1.kind === "page" && u1.state === "candidate" && u1.visibility === "viewers" && m1.length === 1 && m1[0].member_id === A && m1[0].v === true
        && (await sourceCount("notion", P1)) === 1 && rows[P1]?.state === "read" && rows[P1]?.target_unit_id === u1.id,
      JSON.stringify({ u1: u1 && { kind: u1.kind, state: u1.state, vis: u1.visibility }, m1, link: rows[P1], linked: res.links }));
    chk("S6 이미 있는 단위(P2 · 후보)이고 읽은 사람이 구성원 — 그 단위에 넣는다", (await sourceCount("notion", P2)) === 1 && rows[P2]?.state === "read" && rows[P2]?.target_unit_id === p2.id,
      JSON.stringify({ n: await sourceCount("notion", P2), link: rows[P2] }));
    chk("S7 남의 «나만» 단위(P3)에는 넣지 않고 읽은 사람을 구성원으로 더하지도 않는다 · 링크는 읽음이 아니다 · 시도로 세지 않는다",
      (await sourceCount("notion", P3)) === 0 && rows[P3]?.state === "pending" && rows[P3]?.tries === 0 && res.links?.linked?.refused === 1
        && !(await isMember("notion", P3, A)),
      JSON.stringify({ n: await sourceCount("notion", P3), link: rows[P3], linked: res.links?.linked }));
    chk("S10 링크로 읽은 문서는 링크가 있던 단위의 자료에 안 들어간다(그 단위 페이지 하나 그대로)",
      (await sourceCount("notion", N_UNIT)) === before + 1 && res.per_unit?.[0]?.stored === 1, JSON.stringify({ before, after: await sourceCount("notion", N_UNIT), per: res.per_unit }));
    //  다시 읽는 노션 단위(읽은 시각 있음) — 같은 판 링크 읽기를 받지 않는다(판마다 같은 문서를 다시 열지 않게).
    const p1Before = await sourceCount("notion", P1);
    const re = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-4b",
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(n, new Date().toISOString())] },
      files: [pageFile(N_UNIT, `참고 ${nlink(P1)}`), pageFile(P1, "다시 연 문서")] });
    chk("S15 다시 읽는 노션 단위의 같은 판 링크 읽기는 받지 않는다(링크 쪽으로 센다 — «지시를 벗어남» 아님) · 저장도 다시 안 한다",
      re.links?.linked?.read === 0 && re.stray === 0 && re.links?.stray === 1 && (await sourceCount("notion", P1)) === p1Before,
      JSON.stringify({ links: re.links, stray: re.stray }));
  }

  // ── S14 그 단위의 «모을지» 결정 ──
  {
    const n = await unitBy("notion", N_UNIT);
    await makeUnit("notion", P5, A, { state: "excluded" });
    await makeUnit("notion", P6, A, { set: `route = 'lively_collector'` });
    const res = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-8",
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(n)] },
      files: [pageFile(N_UNIT, `참고 ${nlink(P5)} · ${nlink(P6)}`), pageFile(P5, "모으지 않기로 한 페이지"), pageFile(P6, "수집기 경로 페이지")] });
    chk("S14 모으지 않기로 한 단위(P5) · 수집기 경로 단위(P6)에는 넣지 않는다(시도로도 세지 않는다)",
      (await sourceCount("notion", P5)) === 0 && (await sourceCount("notion", P6)) === 0 && res.links?.linked?.skipped === 2
        && (await linkRows(A)).filter((r) => [P5, P6].includes(r.ref)).every((r) => r.state === "pending" && r.tries === 0),
      JSON.stringify(res.links));
    //  공개범위를 끈 워크스페이스 — 검토 안 된 후보 단위에 넣지 않고 새 단위도 만들지 않는다 · 모으는 중인 단위에는 넣는다.
    await setVisAxes({ source: false });
    await makeUnit("notion", P8, A);   // 모으는 중(active)
    const p2Before = await sourceCount("notion", P2);
    const off = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-9",
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(n)] },
      files: [pageFile(N_UNIT, `참고 ${nlink(P7)} · ${nlink(P2)} · ${nlink(P8)}`), pageFile(P7, "새 페이지"), pageFile(P2, "후보 단위 — 바뀐 글"), pageFile(P8, "모으는 단위")] });
    const p2After = (await itemsPool.query(`SELECT body_md FROM source WHERE external_system='notion' AND external_id=$1`, [P2])).rows[0]?.body_md ?? "";
    await makeUnit("notion", PC, A, { state: "candidate" });
    await pendingRow("notion", PC, n.id, A, { url: nlink(PC) });
    const plannedOff = await links.pendingLinksFor(A, ["notion"], 20);
    await setVisAxes({ source: true });
    chk("S14b 공개범위를 끈 곳 — 새 페이지(P7) 단위를 만들지 않고 · 후보 단위(P2)에 새로 넣지 않고 · 모으는 단위(P8)에는 넣는다 · 계획도 모으는 단위만(P7 · 후보 PC 안 실음)",
      !(await unitBy("notion", P7)) && (await sourceCount("notion", P2)) === p2Before && !/바뀐 글/.test(p2After) && (await sourceCount("notion", P8)) === 1
        && off.links?.linked?.skipped === 2 && !plannedOff.some((l) => [P7, P2, PC].includes(l.ref)),
      JSON.stringify({ links: off.links, planned: plannedOff.map((l) => l.ref), p2After }));
  }

  // ── S8·S9·S8b·S13 슬랙 링크 읽기 — 그 채널이 단위이고 구성원일 때만 ──
  {
    const u = await unitBy("slack", CH);
    const c2 = await makeUnit("slack", C2, A);   // B 의 채널이었는데 A 도 구성원이 된다
    await makeUnit("slack", C4, B);             // A 는 구성원이 아니다
    const parent2 = `${PLANNED - 40 * D}.000100`, parent3 = `${PLANNED - 41 * D}.000100`, parent4 = `${PLANNED - 42 * D}.000100`;
    const res = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-5",
      plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(u)] },
      files: [
        chanFile(CH, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000500`,
          `옛 결정 https://acme.slack.com/archives/${C2}/p${parent2.replace(".", "")} · 다른 곳 https://acme.slack.com/archives/${C3}/p${parent3.replace(".", "")}` +
          ` · 남의 채널 https://acme.slack.com/archives/${C4}/p${parent4.replace(".", "")}`]]),
        threadFile(C2, parent2, [`${PLANNED - 39 * D}.000200`]),
        threadFile(C3, parent3, [`${PLANNED - 40 * D}.000200`]),
        threadFile(C4, parent4, [`${PLANNED - 41 * D}.000200`]),
      ] });
    const rows = Object.fromEntries((await linkRows(A)).filter((r) => r.app === "slack").map((r) => [r.ref.split(":")[0], r]));
    chk("S8 그 채널(C2)이 단위이고 읽은 사람이 구성원 — 그 채널에 넣는다(부모 + 답글) · 링크는 읽음",
      (await sourceCount("slack", `${C2}:%`)) >= 2 && rows[C2]?.state === "read" && rows[C2]?.target_unit_id === c2.id,
      JSON.stringify({ n: await sourceCount("slack", `${C2}:%`), link: rows[C2], linked: res.links?.linked }));
    chk("S9 단위가 아닌 채널(C3)은 넣지 않는다(종류를 몰라 단위를 만들지 않는다) · 링크는 pending · 시도로 세지 않는다",
      (await sourceCount("slack", `${C3}:%`)) === 0 && !(await unitBy("slack", C3)) && rows[C3]?.state === "pending" && rows[C3]?.tries === 0
        && res.links?.linked?.left === 2,
      JSON.stringify({ link: rows[C3], linked: res.links?.linked }));
    chk("S8b 그 채널(C4)이 단위여도 읽은 사람이 구성원이 아니면 넣지 않는다(구성원으로 더하지도 않는다)",
      (await sourceCount("slack", `${C4}:%`)) === 0 && rows[C4]?.state === "pending" && !(await isMember("slack", C4, A)),
      JSON.stringify({ n: await sourceCount("slack", `${C4}:%`), link: rows[C4] }));
    //  자료를 못 넣은 단위(C 는 CH 의 구성원이 아니다 — 저장 단계가 그 단위 글을 안 받는다)의 글에서는 링크도 적지 않는다.
    await connector(C, "Notion", "connected");
    await ingestRun({ member: C, now: Date.now(), runId: "cr-ci-link-7", plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(u)] },
      files: [chanFile(CH, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000900`, `문서 ${nlink(uuid(0x4299))}`]])] });
    const rc = await linkRows(C);
    chk("S13 자료를 못 넣은 단위의 글에서는 링크도 안 적는다", rc.length === 0, JSON.stringify(rc));
  }

  // ── S11 다음 판에 실을 링크 · 계획한 링크 읽기 · 시도 ──
  {
    const n = await unitBy("notion", N_UNIT);
    const chUnitOf = await unitBy("slack", CH);
    for (const id of EXTRA) await itemsPool.query(
      `INSERT INTO collect_link(app, ref, kind, url, from_unit_id, member_id, state) VALUES('notion',$1,'page',$2,$3,$4,'pending')`, [id, nlink(id), n.id, A]);
    const pend = await links.pendingLinksFor(A, ["notion", "gmail"], 5);
    chk("S11 다음 판에 실을 링크 — 그 앱만 · 상한 5 · 오래된 것부터 · 같은 대상은 한 번 · 넣을 수 없는 대상(남의 나만 P3 · 모으지 않기로 한 P5 · 수집기 경로 P6)은 안 싣는다",
      pend.length === 5 && pend.every((l) => l.app === "notion") && new Set(pend.map((l) => l.ref)).size === 5 && pend[0].ref === P9
        && !pend.some((l) => [P3, P5, P6].includes(l.ref)),
      JSON.stringify({ pend: pend.map((l) => l.ref) }));
    //  슬랙 — 단위가 아닌 채널(C3)·구성원이 아닌 채널(C4) 링크는 싣지 않는다 · C3 이 단위가 되고 A 가 구성원이 되면 실린다.
    const chUnit = await unitBy("slack", CH);
    await makeUnit("slack", C5, A, { state: "excluded" });
    await makeUnit("slack", C6, A, { set: `route = 'lively_collector'` });
    await makeUnit("slack", C7, A, { set: `visibility = 'me', owner_member = '${C}'` });
    for (const ch of [C5, C6, C7]) {
      const ts = `${PLANNED - 60 * D}.000100`;
      await pendingRow("slack", `${ch}:${ts}`, chUnit.id, A, { channel: ch, thread: ts });
    }
    const pendSlack = await links.pendingLinksFor(A, ["slack"], 5);
    await makeUnit("slack", C3, A);
    const pendSlack2 = await links.pendingLinksFor(A, ["slack"], 5);
    chk("S11b 슬랙 — 넣을 수 없는 채널 링크(단위 아님 C3 · 구성원 아님 C4 · 모으지 않기로 함 C5 · 수집기 경로 C6 · 남의 나만 C7)는 안 싣다가, C3 이 단위가 되고 구성원이 되면 싣는다",
      pendSlack.length === 0 && pendSlack2.length === 1 && pendSlack2[0].channel === C3, JSON.stringify({ pendSlack, pendSlack2 }));
    //  계획한 링크(P9)를 읽는다 — 글 속 링크가 없어도 받는다 · 그 페이지 단위가 생기고 링크는 읽음.
    const res = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-6",
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(n, new Date().toISOString())], links: [pend[0]] },
      files: [pageFile(N_UNIT, "링크 없음"), pageFile(P9, "지난 판이 적어 둔 링크의 문서")] });
    const p9 = await unitBy("notion", P9);
    const l9 = (await itemsPool.query(`SELECT state FROM collect_link WHERE app='notion' AND ref=$1 AND member_id=$2`, [P9, A])).rows;
    chk("S11c 계획한 링크 읽기 — 그 페이지 단위에 넣고 그 대상을 가리키는 그 사람의 줄은 모두 읽음",
      p9 && (await sourceCount("notion", P9)) === 1 && l9.every((r) => r.state === "read") && res.stray === 0, JSON.stringify({ l9, stray: res.stray, linked: res.links }));
    //  결과가 오류 모양 — 그 판에 한 번만 시도 수가 오르고 · 7일 쉬고 · 3번에서 멈춘다.
    const target = pend[1];
    const errFile = capFile("mcp__claude_ai_Notion__notion-fetch", { id: target.ref }, { error: "rate limited" });
    const tryOnce = async (tag) => ingestRun({ member: A, now: Date.now(), runId: `cr-ci-link-err-${tag}`,
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(n, new Date().toISOString())], links: [target] },
      files: [pageFile(N_UNIT, `참고 ${nlink(target.ref)}`), errFile] });
    const triesOf = async () => (await itemsPool.query(`SELECT tries, tried_at IS NOT NULL AS t FROM collect_link WHERE app='notion' AND ref=$1 AND member_id=$2`, [target.ref, A])).rows;
    await tryOnce(1);
    const t1 = await triesOf();
    const resting = (await links.pendingLinksFor(A, ["notion"], 20)).some((l) => l.ref === target.ref);
    await itemsPool.query(`UPDATE collect_link SET tried_at = now() - interval '8 days' WHERE app='notion' AND ref=$1 AND member_id=$2`, [target.ref, A]);
    const back = (await links.pendingLinksFor(A, ["notion"], 20)).some((l) => l.ref === target.ref);
    await tryOnce(2);
    await itemsPool.query(`UPDATE collect_link SET tried_at = now() - interval '8 days' WHERE app='notion' AND ref=$1 AND member_id=$2`, [target.ref, A]);
    await tryOnce(3);
    await itemsPool.query(`UPDATE collect_link SET tried_at = now() - interval '8 days' WHERE app='notion' AND ref=$1 AND member_id=$2`, [target.ref, A]);
    const t3 = await triesOf();
    const stopped = !(await links.pendingLinksFor(A, ["notion"], 20)).some((l) => l.ref === target.ref);
    chk("S11d 결과가 오류 모양 — 그 판에 시도 한 번 · 7일 쉬고 다시 · 3번에서 멈춘다",
      t1.length >= 1 && t1.every((r) => r.tries === 1 && r.t) && !resting && back && t3.every((r) => r.tries === 3) && stopped,
      JSON.stringify({ t1, resting, back, t3, stopped }));
    //  같은 판에 처음 본 링크를 읽었는데 오류 모양 — 새 줄도 시도 1 로 적는다(다음 판이 곧바로 다시 싣지 않게 · 한 판에 한 번만).
    const parentE = `${PLANNED - 50 * D}.000100`;
    await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-err-new",
      plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(chUnitOf)] },
      files: [chanFile(CH, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000700`, `옛 글 https://acme.slack.com/archives/${C2}/p${parentE.replace(".", "")}`]]),
        capFile("mcp__claude_ai_Slack__slack_read_thread", { channel_id: C2, message_ts: parentE, limit: 200 }, { error: "thread_not_found" })] });
    const te = (await itemsPool.query(`SELECT tries, tried_at IS NOT NULL AS t FROM collect_link WHERE app='slack' AND ref=$1 AND member_id=$2`, [`${C2}:${parentE}`, A])).rows;
    const teNext = (await links.pendingLinksFor(A, ["slack"], 20)).some((l) => l.ref === `${C2}:${parentE}`);
    chk("S11e 같은 판에 처음 본 링크를 읽었는데 오류 모양 — 새 줄도 시도 1 · 쉬는 동안 안 싣는다", te.length === 1 && te[0].tries === 1 && te[0].t && !teNext,
      JSON.stringify({ te, teNext }));
  }

  // ── S16 오래된 링크 줄 정리 — 마지막으로 본 뒤 180일 ──
  {
    const uch = await unitBy("slack", CH);
    await itemsPool.query(`INSERT INTO collect_link(app, ref, kind, url, from_unit_id, member_id, state, last_seen_at) VALUES('notion',$1,'page',$2,$3,$4,'pending', now() - interval '200 days')`,
      [OLD, nlink(OLD), uch.id, A]);
    const before = (await linkRows(A)).length;
    await links.recordLinks(A, { id: uch.id, app: "slack", ref: CH }, extractAppLinks("PR https://github.com/acme/web/pull/12"), {}, Date.now() + 2 * 3600_000);
    const after = await linkRows(A);
    chk("S16 마지막으로 본 지 180일이 넘은 줄은 지운다 · 나머지는 그대로", !after.some((r) => r.ref === OLD) && after.length === before - 1,
      JSON.stringify({ before, after: after.length }));
  }

  // ── S18 검토 전인데 모두에게 보이게 될 단위(«모두» 후보) — 공개범위 축을 켠 곳에서도 넣지 않는다 ──
  {
    const ch = await unitBy("slack", CH);
    const n = await unitBy("notion", N_UNIT);
    await makeUnit("slack", C9, A, { kind: "channel", state: "candidate", set: `visibility = 'all'` });
    await makeUnit("notion", P11, A, { state: "candidate", set: `visibility = 'all'` });
    const p9 = `${PLANNED - 45 * D}.000100`;
    const rs = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-allcand-s",
      plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(ch)] },
      files: [chanFile(CH, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000800`, `공개 채널 옛 글 https://acme.slack.com/archives/${C9}/p${p9.replace(".", "")}`]]),
        threadFile(C9, p9, [`${PLANNED - 44 * D}.000200`])] });
    const rn = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-allcand-n",
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(n)] },
      files: [pageFile(N_UNIT, `참고 ${nlink(P11)}`), pageFile(P11, "검토 전 «모두» 페이지")] });
    const plannedS = await links.pendingLinksFor(A, ["slack"], 20);
    const plannedN = await links.pendingLinksFor(A, ["notion"], 20);
    chk("S18 축을 켠 곳에서도 검토 전 «모두» 단위(공개 채널 후보 C9 · 노션 후보 P11)에는 넣지 않는다 · 계획에도 안 싣는다",
      (await sourceCount("slack", `${C9}:%`)) === 0 && (await sourceCount("notion", P11)) === 0
        && rs.links?.linked?.skipped === 1 && rn.links?.linked?.skipped === 1
        && !plannedS.some((l) => l.channel === C9) && !plannedN.some((l) => l.ref === P11),
      JSON.stringify({ s: rs.links?.linked, n: rn.links?.linked, plannedS: plannedS.map((l) => l.channel), plannedN: plannedN.map((l) => l.ref) }));
  }

  // ── S17 보호 단위(«모두» 아님 · 메일함 아님 · 이미 모인 자료 있음) — 읽은 사람이 확인된 구성원일 때만 ──
  {
    const ch = await unitBy("slack", CH);
    const n = await unitBy("notion", N_UNIT);
    //  B 가 모아 둔 비공개 채널 C8 — A 는 신고만 한(확인 안 된) 구성원.
    const c8 = await makeUnit("slack", C8, B, { set: `visibility = 'viewers'` });
    await ingestRun({ member: B, now: Date.now(), runId: "cr-ci-link-guard-b1",
      plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(c8)] },
      files: [chanFile(C8, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000100`, "비공개 결정 — 가격 인상"]])] });
    await store.recordUnitListing({ member: A, app: "slack", connector: "Slack", instance: TEAM, items: [{ ref: C8, kind: "private_channel", name: C8 }], verified: false });
    //  B 가 모아 둔 노션 페이지 P12 — A 는 구성원이 아니다.
    const p12 = await makeUnit("notion", P12, B, { set: `visibility = 'viewers'` });
    await ingestRun({ member: B, now: Date.now(), runId: "cr-ci-link-guard-b2",
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(p12)] }, files: [pageFile(P12, "B 의 비공개 페이지")] });
    const c8Before = await sourceCount("slack", `${C8}:%`);
    const p8 = `${PLANNED - 50 * D}.000300`;
    const rs = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-guard-a1",
      plan: { mode: "collect", planned_at: PLANNED, units: [slackPlanned(ch)] },
      files: [chanFile(CH, `${PLANNED - 3 * D}.000000`, [[`${PLANNED - D}.000900`, `옛 결정 https://acme.slack.com/archives/${C8}/p${p8.replace(".", "")}`]]),
        threadFile(C8, p8, [`${PLANNED - 49 * D}.000200`])] });
    const rn = await ingestRun({ member: A, now: Date.now(), runId: "cr-ci-link-guard-a2",
      plan: { mode: "collect", planned_at: PLANNED, units: [notionPlanned(n)] },
      files: [pageFile(N_UNIT, `참고 ${nlink(P12)}`), pageFile(P12, "A 가 링크로 연 페이지")] });
    const aC8 = (await itemsPool.query(`SELECT verified_at IS NOT NULL AS v FROM collect_unit_member WHERE unit_id=$1 AND member_id=$2`, [c8.id, A])).rows[0];
    const rowS = (await itemsPool.query(`SELECT state, tries FROM collect_link WHERE member_id=$1 AND app='slack' AND channel=$2`, [A, C8])).rows;
    const planS = await links.pendingLinksFor(A, ["slack"], 20);
    const planN = await links.pendingLinksFor(A, ["notion"], 20);
    const proofs = (await itemsPool.query(`SELECT unit_id FROM collect_proof WHERE member_id = $1 AND unit_id = ANY($2::int[])`, [A, [c8.id, p12.id]])).rows.map((x) => x.unit_id);
    chk("S17 보호 단위 — 확인 안 된 사람의 링크 읽기는 보류(held): 저장 안 함 · 구성원으로 안 올림(슬랙 확인 안 됨 그대로 · 노션 안 더함) · 시도로 안 셈 · 계획에도 안 실음 · 구성원 행이 있는 슬랙에만 확인 대기",
      rs.links?.linked?.held === 1 && rn.links?.linked?.held === 1 && (await sourceCount("slack", `${C8}:%`)) === c8Before
        && proofs.length === 1 && proofs[0] === c8.id
        && (await sourceCount("notion", P12)) === 1 && aC8?.v === false && !(await isMember("notion", P12, A))
        && rowS.length === 1 && rowS[0].state === "pending" && rowS[0].tries === 0
        && !planS.some((l) => l.channel === C8) && !planN.some((l) => l.ref === P12),
      JSON.stringify({ s: rs.links?.linked, n: rn.links?.linked, aC8, rowS, proofs, planS: planS.map((l) => l.channel), planN: planN.map((l) => l.ref) }));
    //  확인되면(확인 읽기 · 목록 실행) 다음 판에 실린다.
    await itemsPool.query(`UPDATE collect_unit_member SET verified_at = now() WHERE unit_id = $1 AND member_id = $2`, [c8.id, A]);
    const planS2 = await links.pendingLinksFor(A, ["slack"], 20);
    chk("S17b 확인된 구성원이 되면 그 링크가 다음 판에 실린다", planS2.some((l) => l.channel === C8), JSON.stringify(planS2.map((l) => l.channel)));
  }

  // ── S11f 쉬기 · 시도 상한은 그 사람의 그 대상 전체로 — 다른 단위에서 새로 생긴 줄이 멈춘·쉬는 대상을 다시 싣지 않는다 ──
  {
    const ch = await unitBy("slack", CH);
    const n = await unitBy("notion", N_UNIT);
    await itemsPool.query(`INSERT INTO collect_link(app, ref, kind, url, from_unit_id, member_id, state, tries, tried_at) VALUES('notion',$1,'page',$2,$3,$4,'pending',3, now() - interval '30 days')`, [X1, nlink(X1), n.id, A]);
    await itemsPool.query(`INSERT INTO collect_link(app, ref, kind, url, from_unit_id, member_id, state) VALUES('notion',$1,'page',$2,$3,$4,'pending')`, [X1, nlink(X1), ch.id, A]);
    await itemsPool.query(`INSERT INTO collect_link(app, ref, kind, url, from_unit_id, member_id, state, tries, tried_at) VALUES('notion',$1,'page',$2,$3,$4,'pending',1, now())`, [X2, nlink(X2), n.id, A]);
    await itemsPool.query(`INSERT INTO collect_link(app, ref, kind, url, from_unit_id, member_id, state) VALUES('notion',$1,'page',$2,$3,$4,'pending')`, [X2, nlink(X2), ch.id, A]);
    const plan = await links.pendingLinksFor(A, ["notion"], 50);
    chk("S11f 멈춘 대상(X1 — 다른 줄이 3번)·쉬는 대상(X2 — 다른 줄이 방금 실패)은 새 줄이 있어도 안 싣는다",
      !plan.some((l) => l.ref === X1 || l.ref === X2), JSON.stringify(plan.map((l) => l.ref)));
  }

  // ── S12 연결 제안 — 부르는 사람의 것 · 지금 연결 기준 · 개수만 ──
  {
    const h = collectUnitCapabilities.find((c) => c.name === "collect_units").handler;
    const asUser = (m) => ({ userId: m, email: `${m}@cilink.test`, scopes: ["memory"], projects: ["*"] });
    const outA = await h({}, asUser(A));
    const sugB = await links.linkSuggestionsFor(B);
    await connector(B, "Notion", "connected");
    const sugB2 = await links.linkSuggestionsFor(B);
    const appsA = (outA.link_suggestions ?? []).map((s) => s.app);
    chk("S12 연결 제안 — A 는 연결 안 한 깃허브만(연결한 노션·드라이브는 빠진다) · B 의 노션 링크는 B 에게만 · B 가 노션을 연결하면 빠진다 · 주소는 안 낸다",
      appsA.includes("github") && !appsA.includes("notion") && !appsA.includes("gdrive")
        && sugB.some((s) => s.app === "notion" && s.links === 1 && s.units === 1) && !sugB2.some((s) => s.app === "notion")
        && !JSON.stringify(outA.link_suggestions).includes("http"),
      JSON.stringify({ a: outA.link_suggestions, b: sugB, b2: sugB2 }));
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  if (axesBefore) await setVisAxes({ source: axesBefore.source }).catch(() => {});
  await cleanup().catch(() => {});
  console.log(`\ncollect-links pg-test: ${pass} passed, ${fail} failed`);
  await itemsPool.end?.().catch?.(() => {});
}
process.exit(fail ? 1 : 0);
