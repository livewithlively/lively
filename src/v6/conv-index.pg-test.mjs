// ⌘K 대화 검색 색인·검색(#4517) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/conv-index.pg-test.mjs
//
// 왜 이 계층인가: 이 기능의 약속은 전부 SQL 조건이다 — «사람 말·AI 말만 행이 된다» · «줄 경계에서만 이어 읽는다» ·
//  «같은 창을 두 번 담지 않는다(CAS)» · «주인과 초대받은 사람만 찾는다» · «지운 대화는 색인도 사라진다». 목 풀로는
//  조건 하나를 지워도 초록이다. 그래서 **부작용을 SELECT 로 되읽어** 판정한다(session_msg 행 · 커서 · 검색 결과 id).
//
//  사양·엣지 표: 스크래치패드 spec.md E — D1~D15 · 격리 리뷰 뒤 D16~D20(가려진 프로젝트의 초대 세션 · 다른 워크스페이스 ·
//   휴지통 · NUL 글자와 깨진 시각 · 뽑는 규칙의 판) · D13c(한 번도 색인 안 된 작은 세션도 «색인 중» 으로 센다) ·
//   재검토 뒤 D4(창보다 긴 줄 · 스크린샷을 붙인 지시) · D16 밀린 수 · D16f(가려짐을 못 재면 닫는다) · D18i(휴지통 표식은 주인의 것) ·
//   D19(글자 그대로의 \u0000).
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const S = await import(`${DIST}/v6/session-log-store.js`);
const C = await import(`${DIST}/v6/conv-index-store.js`);
const { PRIMARY_TENANT_ID } = await import(`${DIST}/org/tenancy/registry.js`);
const { PROJECT_SHARED_BASE, PROJECT_SUBDIR } = await import(`${DIST}/project/project-fs.js`);
const { invalidateVisibilityCache } = await import(`${DIST}/v6/visibility.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__convpg_a__", B = "__convpg_b__";
const SID = (n) => `convpg-${n}`;
const BOX = (n) => `box-__convpg-${n}`;
const ALL = Array.from({ length: 45 }, (_, i) => SID(i));
const ALL_BOX = Array.from({ length: 45 }, (_, i) => BOX(i));
const W2 = "00000000-0000-4000-8000-00000000c0a2", W3 = "00000000-0000-4000-8000-00000000c0a3";   // 다른 워크스페이스 · 보관된 워크스페이스
const LIST_NAME = "__convpg_hidden_list__", PROJ_NAMES = ["__convpg_hidden_proj__", "__convpg_open_proj__"];

const J = (o) => JSON.stringify(o) + "\n";
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
const U = (text, ts = ago(0)) => J({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const UT = (ts = ago(0)) => J({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "도구 결과 속 슬랙" }] } });
const AI = (text, ts = ago(0)) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
const AT = (ts = ago(0)) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo 슬랙" } }] } });

const wm = (sid) => S.sessionLogWatermark("", sid);
async function put(sid, owner, text, parent = null) {
  const r = await S.appendSessionLog({ nodeId: "", sessionId: sid, atOffset: await wm(sid), data: Buffer.from(text, "utf8"), harness: "claude", owner, parentSessionId: parent });
  if (!r.ok) throw new Error(`append 실패 ${sid}: ${JSON.stringify(r)}`);
}
const msgs = async (sid) => (await itemsPool.query(
  `SELECT role, body FROM session_msg WHERE node_id='' AND session_id=$1 ORDER BY at_offset, idx`, [sid])).rows;
const cursorOf = async (sid) => (await itemsPool.query(
  `SELECT indexed_to FROM session_msg_cursor WHERE node_id='' AND session_id=$1`, [sid])).rows[0]?.indexed_to ?? null;
const search = (requester, q, o = {}) => C.searchConversations({
  requester, q, sort: o.sort ?? "relevance", since: o.since ?? null, limit: 20, workspaceId: PRIMARY_TENANT_ID, attach: o.attach ?? true,
  ...(o.cap ? { sessionCap: o.cap } : {}),
});
const ids = (r) => r.results.map((x) => x.session_id);

async function cleanup() {
  for (const t of ["session_msg", "session_msg_cursor", "session_log_chunk", "session_log", "session", "session_purged", "gw_session_map"]) {
    await itemsPool.query(`DELETE FROM ${t} WHERE session_id = ANY($1::text[])`, [ALL]);
  }
  await itemsPool.query(`DELETE FROM org_session_trash WHERE session_id = ANY($1::text[]) OR session_id = ANY($2::text[])`, [ALL, ALL_BOX]);
  await itemsPool.query(`DELETE FROM org_session_conv WHERE box_id = ANY($1::text[])`, [ALL_BOX]);
  await itemsPool.query(`DELETE FROM org_session_state WHERE id = ANY($1::text[])`, [ALL_BOX]);
  await itemsPool.query(`DELETE FROM gw_workspace WHERE id = ANY($1::uuid[])`, [[W2, W3]]);
  await itemsPool.query(`DELETE FROM project WHERE name = ANY($1::text[])`, [PROJ_NAMES]);
  await itemsPool.query(`DELETE FROM project_list WHERE name = $1`, [LIST_NAME]);
}

try {
  await cleanup();

  // ── D1 사람 말·AI 말만 행이 된다(도구 결과·도구 호출 없음) ──
  await put(SID(1), A, U("슬랙처럼 검색 고쳐 줘") + UT() + AT() + AI("관련도순과 최신순을 나눕니다"));
  await C.indexConvSession("", SID(1));
  {
    const m = await msgs(SID(1));
    chk("D1 사람 말·AI 말 두 줄만 색인된다(도구 결과·도구 호출은 없다)",
      m.length === 2 && m[0].role === "user" && m[0].body === "슬랙처럼 검색 고쳐 줘" && m[1].role === "assistant" && m[1].body === "관련도순과 최신순을 나눕니다",
      JSON.stringify(m));
    chk("D1 커서가 기록 끝(줄 경계)에 선다", Number(await cursorOf(SID(1))) === await wm(SID(1)), `${await cursorOf(SID(1))} vs ${await wm(SID(1))}`);
  }

  // ── D2 반 줄은 아직 담지 않고, 나머지가 오면 담는다(중복 없이) ──
  {
    const full = U("첫 말 검색");
    const half = U("둘째 말 검색");
    const cut = Math.floor(half.length / 2);
    await put(SID(2), A, full + half.slice(0, cut));
    await C.indexConvSession("", SID(2));
    const m1 = await msgs(SID(2));
    const c1 = Number(await cursorOf(SID(2)));
    chk("D2 쓰는 중인 반 줄은 아직 없다 · 커서는 첫 줄 끝", m1.length === 1 && m1[0].body === "첫 말 검색" && c1 === Buffer.byteLength(full), JSON.stringify({ m1, c1 }));
    await put(SID(2), A, half.slice(cut));
    await C.indexConvSession("", SID(2));
    const m2 = await msgs(SID(2));
    chk("D2 나머지가 오면 그 줄이 담긴다 — 첫 줄은 두 번 담기지 않는다",
      m2.length === 2 && m2[1].body === "둘째 말 검색" && m2.filter((x) => x.body === "첫 말 검색").length === 1, JSON.stringify(m2));
  }

  // ── D3 같은 창을 두 색인기가 동시에 — 한 벌만 ──
  {
    await put(SID(3), A, U("하나 검색") + U("둘 검색") + U("셋 검색"));
    await Promise.all([C.indexConvSession("", SID(3)), C.indexConvSession("", SID(3)), C.indexConvSession("", SID(3))]);
    const m = await msgs(SID(3));
    chk("D3 동시 색인 세 번에도 행은 한 벌(3)", m.length === 3, JSON.stringify(m.map((x) => x.body)));
  }

  // ── D4 창보다 긴 한 줄 — 상한 안이면 그 줄만 따로 읽고, 상한보다 길면 건너뛰고 그 뒤를 이어 읽는다 ──
  {
    const giant = AI("거대한 " + "가".repeat(40_000));   // UTF-8 약 120KB — 창(64KB)보다 길다
    await put(SID(4), A, U("앞 말 검색") + giant + U("뒤 말 검색"));
    await C.indexConvSession("", SID(4), { window: 64 * 1024 });
    const m = await msgs(SID(4));
    chk("D4 창보다 긴 한 줄도 상한 안이면 담긴다(앞·그 줄·뒤 세 줄)",
      m.length === 3 && m[0].body === "앞 말 검색" && m[1].body.startsWith("거대한 가") && m[2].body === "뒤 말 검색", JSON.stringify(m.map((x) => x.body.slice(0, 12))));
    chk("D4 커서가 끝까지 간다(긴 줄에서 멈추지 않는다)", Number(await cursorOf(SID(4))) === await wm(SID(4)));
    await put(SID(16), A, U("앞 말 검색") + giant + U("뒤 말 검색"));
    await C.indexConvSession("", SID(16), { window: 64 * 1024, longLineMax: 100 * 1024 });
    const m2 = await msgs(SID(16));
    chk("D4 상한보다 긴 줄은 건너뛰고 그 뒤를 이어 읽는다",
      m2.map((x) => x.body).join("|") === "앞 말 검색|뒤 말 검색" && Number(await cursorOf(SID(16))) === await wm(SID(16)), JSON.stringify(m2.map((x) => x.body.slice(0, 12))));
    //  스크린샷을 붙인 지시 — 그림(base64)이 사람 말과 같은 줄에 실려 창보다 길다(재검토 실측: 2.5MB·5MB 줄의 말이 통째로 빠졌다).
    const shot = J({ type: "user", timestamp: ago(0), message: { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(200_000) } },
      { type: "text", text: "스크린샷 붙인 얼룩말 지시" }] } });
    await put(SID(17), A, shot + AI("화면을 봤습니다"));
    await C.indexConvSession("", SID(17), { window: 64 * 1024 });
    const m3 = await msgs(SID(17));
    chk("D4 스크린샷을 붙인 지시의 글이 담긴다(그림은 버린다)",
      m3.length === 2 && m3[0].role === "user" && m3[0].body === "스크린샷 붙인 얼룩말 지시" && m3[1].body === "화면을 봤습니다", JSON.stringify(m3.map((x) => x.body.slice(0, 20))));
    chk("D4 그 지시를 대화 검색으로 찾는다", ids(await search(A, "얼룩말")).includes(SID(17)));
  }

  // ── D5~D8 볼 수 있는 세션 = 주인 + (attach) 초대받은 사람 ──
  await put(SID(5), B, U("B 가 A 를 초대한 세션의 슬랙 이야기"));
  await put(SID(6), B, U("B 혼자 쓰는 세션의 슬랙 이야기"));
  await itemsPool.query(`INSERT INTO org_session_state(id, owner, invites) VALUES($1, $2, $3::jsonb)`, [BOX(5), B, JSON.stringify([A])]);
  await itemsPool.query(`INSERT INTO org_session_conv(box_id, conv_uuid, owner) VALUES($1, $2, $3)`, [BOX(5), SID(5), B]);
  await itemsPool.query(`INSERT INTO org_session_state(id, owner, invites) VALUES($1, $2, '[]'::jsonb)`, [BOX(6), B]);
  await itemsPool.query(`INSERT INTO org_session_conv(box_id, conv_uuid, owner) VALUES($1, $2, $3)`, [BOX(6), SID(6), B]);
  for (const n of [5, 6]) await C.indexConvSession("", SID(n));
  {
    const a = ids(await search(A, "슬랙"));
    chk("D5 주인은 자기 세션을 찾는다", a.includes(SID(1)), JSON.stringify(a));
    chk("D6 초대받은 사람(attach)은 남의 세션을 찾는다", a.includes(SID(5)), JSON.stringify(a));
    chk("D7 초대 안 받은 남의 세션은 못 찾는다", !a.includes(SID(6)), JSON.stringify(a));
    const owner = ids(await search(A, "슬랙", { attach: false }));
    chk("D8 view_policy=owner 면 초대받아도 못 찾는다", owner.includes(SID(1)) && !owner.includes(SID(5)), JSON.stringify(owner));
    const b = ids(await search(B, "슬랙"));
    chk("D5 B 는 자기 둘을 찾고 A 의 세션은 못 찾는다", b.includes(SID(5)) && b.includes(SID(6)) && !b.includes(SID(1)), JSON.stringify(b));
  }

  // ── D9 서브에이전트·작업 상자 세션은 찾지 않는다 ──
  {
    await put(SID(7), A, U("가지에서 한 슬랙 이야기"), SID(1));
    await put(SID(8), A, U("작업 상자에서 한 슬랙 이야기"));
    await itemsPool.query(`UPDATE session SET run_kind='task' WHERE node_id='' AND session_id=$1`, [SID(8)]);
    for (const n of [7, 8]) await C.indexConvSession("", SID(n));
    const a = ids(await search(A, "슬랙"));
    chk("D9 서브에이전트·작업 상자 세션은 결과에 없다(색인돼 있어도)", !a.includes(SID(7)) && !a.includes(SID(8)), JSON.stringify(a));
  }

  // ── D10 기간(since) ──
  {
    await put(SID(9), A, U("옛날에 한 슬랙 이야기", ago(20)));
    await C.indexConvSession("", SID(9));
    const inside = ids(await search(A, "슬랙", { since: ago(30) }));
    const outside = ids(await search(A, "슬랙", { since: ago(10) }));
    chk("D10 기간 안이면 찾고, 기간 밖 말만 있는 세션은 안 나온다", inside.includes(SID(9)) && !outside.includes(SID(9)) && outside.includes(SID(1)),
      JSON.stringify({ inside, outside }));
  }

  // ── D11 완전 삭제 → 색인·커서도 사라진다 ──
  {
    await S.purgeSessionLog("", SID(9), A);
    const left = (await msgs(SID(9))).length;
    const cur = await cursorOf(SID(9));
    const a = ids(await search(A, "슬랙", { since: ago(30) }));
    chk("D11 완전 삭제 뒤 색인·커서가 없고 검색에도 안 나온다", left === 0 && cur === null && !a.includes(SID(9)), JSON.stringify({ left, cur, a }));
  }

  // ── D12 보존 정리(reap) → 색인·커서도 사라진다 ──
  {
    await put(SID(10), A, U("보존기간이 지날 슬랙 이야기"));
    await C.indexConvSession("", SID(10));
    const before = (await msgs(SID(10))).length;
    await itemsPool.query(`UPDATE session_log SET updated_at = now() - interval '40 days' WHERE node_id='' AND session_id=$1`, [SID(10)]);
    const r = await S.reapSessionLogs(30);
    const after = (await msgs(SID(10))).length;
    chk("D12 reap 뒤 그 세션의 색인·커서가 사라진다", before === 1 && after === 0 && (await cursorOf(SID(10))) === null && r.logs >= 1, JSON.stringify({ before, after, r }));
  }

  // ── D13 밀린 색인 수 — 큰 꼬리만 센다 · 색인 뒤 0 ──
  {
    const lines = Array.from({ length: 300 }, (_, i) => U(`밀린 말 ${i} ` + "나".repeat(400))).join("");   // 약 370KB
    await put(SID(11), A, lines);
    const p1 = await C.convIndexPending({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID });
    await C.indexConvSession("", SID(11));
    const p2 = await C.convIndexPending({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID });
    chk("D13 256KB 넘게 밀린 세션을 세고, 색인하면 0", p1 === 1 && p2 === 0, JSON.stringify({ p1, p2 }));
    //  도는 세션의 **쓰는 중인 꼬리**(반 줄)는 늘 조금 밀려 있다 — 그걸 세면 «색인 중» 안내가 영영 안 걷힌다.
    await put(SID(11), A, U("쓰는 중인 꼬리 " + "라".repeat(300)).slice(0, 200));
    await C.indexConvSession("", SID(11));
    const p3 = await C.convIndexPending({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID });
    const gap = (await wm(SID(11))) - Number(await cursorOf(SID(11)));
    chk("D13 쓰는 중인 작은 꼬리는 세지 않는다", gap > 0 && p3 === 0, JSON.stringify({ gap, p3 }));
    //  D13c — 한 번도 색인하지 않은 세션은 작아도 센다(그 세션의 말은 지금 하나도 안 찾아진다 — 리뷰 지적).
    await put(SID(20), A, U("한 번도 색인 안 된 작은 대화"));
    const p4 = await C.convIndexPending({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID });
    await C.indexConvSession("", SID(20));
    const p5 = await C.convIndexPending({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID });
    chk("D13c 한 번도 색인 안 된 작은 세션도 «색인 중» 으로 센다 · 색인하면 0", p4 === 1 && p5 === 0, JSON.stringify({ p4, p5 }));
  }

  // ── D14 커서가 기록보다 앞서면 처음부터 다시(옛 행 없음) ──
  {
    await put(SID(12), A, U("다시 만들 슬랙 색인"));
    await C.indexConvSession("", SID(12));
    await itemsPool.query(`INSERT INTO session_msg(node_id, session_id, at_offset, idx, role, ts, body) VALUES('', $1, 999999, 0, 'user', now(), '유령 슬랙')`, [SID(12)]);
    await itemsPool.query(`UPDATE session_msg_cursor SET indexed_to = indexed_to + 100000 WHERE node_id='' AND session_id=$1`, [SID(12)]);
    await C.indexConvSession("", SID(12));
    const m = (await msgs(SID(12))).map((x) => x.body);
    chk("D14 커서가 앞서면 색인을 다시 만든다 — 유령 행 없음 · 진짜 말 한 벌", m.length === 1 && m[0] === "다시 만들 슬랙 색인", JSON.stringify(m));
  }

  // ── D15 관련도순 · 최신순 순서 ──
  {
    await put(SID(13), A, U("코끼리 달리기 연습 기록", ago(30)));
    await put(SID(14), A, U("달리기 " + "다".repeat(150) + " 그리고 코끼리", ago(0)));
    for (const n of [13, 14]) await C.indexConvSession("", SID(n));
    const rel = ids(await search(A, "코끼리 달리기"));
    const recR = await search(A, "코끼리 달리기", { sort: "recent" });
    const rec = ids(recR);
    chk("D15 관련도순은 구절이 그대로 맞은 옛 세션이 먼저", rel[0] === SID(13) && rel[1] === SID(14), JSON.stringify(rel));
    //  #4530 — 최신순 = 슬랙 Recent + Top Results: 관련도 1등은 «가장 맞는 결과» 로 맨 위에 서고(top), 나머지가 늦은 것부터.
    chk("D15 최신순은 맨 위에 가장 맞는 세션(top) · 그 아래 맞은 때가 늦은 세션부터",
      rec[0] === SID(13) && recR.results[0].top === true && rec[1] === SID(14) && recR.results[1].top === false, JSON.stringify(recR.results.map((x) => [x.session_id, x.top])));
    const hit = (await search(A, "코끼리 달리기")).results[0];
    chk("D15 줄에 이름·대표 말·시각이 실린다", !!hit.name && hit.best.role === "user" && hit.best.text.includes("코끼리") && typeof hit.at === "string", JSON.stringify(hit));
    chk("D15 화면이 안 쓰는 메타(프로젝트 id·주인·점수)는 싣지 않는다",
      !["project_id", "project_name", "owner", "owner_name", "harness", "score"].some((k) => k in hit), JSON.stringify(Object.keys(hit)));
    chk("D15 프로젝트에 안 붙은 세션은 project 가 null(#4530 안 A — 목록 줄의 «어디에 있는 것인가»)", hit.project === null, JSON.stringify(hit.project));
  }

  // ── D16 초대받았어도 그 프로젝트가 나에게 가려져 있으면 못 찾는다(#1291 — 목록·입장과 같은 sessionVisible) ──
  {
    const L = (await itemsPool.query(`INSERT INTO project_list(name, visibility) VALUES($1, 'members') RETURNING id`, [LIST_NAME])).rows[0].id;
    const P = (await itemsPool.query(`INSERT INTO project(level, name, status, created_by, list_id) VALUES('project', $1, 'active', $2, $3) RETURNING id`, [PROJ_NAMES[0], B, L])).rows[0].id;
    const P2 = (await itemsPool.query(`INSERT INTO project(level, name, status, created_by) VALUES('project', $1, 'active', $2) RETURNING id`, [PROJ_NAMES[1], B])).rows[0].id;
    const dirOf = (pid) => `${PROJECT_SHARED_BASE}/${PROJECT_SUBDIR}/${pid}`;
    //  가려진 프로젝트 목록은 15초 보관된다(visibility.ts) — 앞 장면이 이미 A 의 목록을 읽어 두었을 수 있으니 비운다.
    invalidateVisibilityCache();
    const pend = () => C.convIndexPending({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID });
    const pBase = await pend();
    await put(SID(18), B, U("가려진 프로젝트 안의 기린 이야기"));
    await put(SID(19), B, U("열린 프로젝트 안의 기린 이야기"));
    await itemsPool.query(`INSERT INTO org_session_state(id, owner, invites, project_id, dir) VALUES($1, $2, $3::jsonb, $4, $5)`, [BOX(18), B, JSON.stringify([A]), P, dirOf(P)]);
    await itemsPool.query(`INSERT INTO org_session_conv(box_id, conv_uuid, owner) VALUES($1, $2, $3)`, [BOX(18), SID(18), B]);
    await itemsPool.query(`INSERT INTO org_session_state(id, owner, invites, project_id, dir) VALUES($1, $2, $3::jsonb, $4, $5)`, [BOX(19), B, JSON.stringify([A]), P2, dirOf(P2)]);
    await itemsPool.query(`INSERT INTO org_session_conv(box_id, conv_uuid, owner) VALUES($1, $2, $3)`, [BOX(19), SID(19), B]);
    const pNew = await pend();
    chk("D16 밀린 수에도 가려진 프로젝트의 초대 세션은 세지 않는다(열린 쪽 하나만 는다)", pNew - pBase === 1, JSON.stringify({ pBase, pNew }));
    for (const n of [18, 19]) await C.indexConvSession("", SID(n));
    const aAll = await search(A, "기린");
    const a = ids(aAll);
    chk("D16 초대받았어도 가려진 프로젝트의 세션은 대화로 못 찾는다", !a.includes(SID(18)), JSON.stringify(a));
    //  D36 — 맞은 세션 수(«세션» 탭의 숫자)에도 가려진 세션은 들지 않는다(세면 «있다» 는 사실이 숫자로 샌다).
    chk("D36 맞은 세션 수(total)는 보이는 것만 센다 — 가려진 프로젝트의 초대 세션은 빼고", aAll.total === a.length && (await search(B, "기린")).total === 2, JSON.stringify([aAll.total, a]));
    //   낱말이 둘이면 **둘 다 맞은** 세션만 센다(목록에 서는 것과 같은 문턱) — «기린» 만 든 세션은 후보이지만 숫자에 들지 않는다.
    await put(SID(43), B, U("기린과 물소가 같이 나오는 이야기"));
    await C.indexConvSession("", SID(43));
    const two = await search(B, "기린 물소");
    chk("D36 낱말 둘 — 숫자는 둘 다 맞은 세션만(하나만 맞은 세션은 세지 않는다)", two.total === 1 && ids(two).join() === SID(43) && (await search(B, "기린")).total === 3, JSON.stringify([two.total, ids(two)]));
    chk("D16 대조: 열린 프로젝트의 초대 세션은 찾는다(프로젝트 세션을 통째로 닫은 게 아니다)", a.includes(SID(19)), JSON.stringify(a));
    const b = ids(await search(B, "기린"));
    chk("D16 주인은 자기 세션을 늘 찾는다(가려짐 판정은 초대받은 사람에게만)", b.includes(SID(18)) && b.includes(SID(19)), JSON.stringify(b));
    //  미리보기(세션 하나의 맞은 말, #4530 안 A)도 같은 판정 — 초대받았어도 그 프로젝트가 가려져 있으면 안을 보여 주지 않는다.
    //   (돌연변이 확인: sessionHits 의 allowedInvites 판정을 빼면 이 줄이 빨강이다.)
    const pvHidden = await C.sessionHits({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID, nodeId: "", sessionId: SID(18), q: "기린" });
    const pvOpen = await C.sessionHits({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID, nodeId: "", sessionId: SID(19), q: "기린" });
    const pvOwner = await C.sessionHits({ requester: B, attach: true, workspaceId: PRIMARY_TENANT_ID, nodeId: "", sessionId: SID(18), q: "기린" });
    chk("D16 미리보기: 가려진 프로젝트의 초대 세션은 null · 열린 프로젝트의 초대 세션과 주인은 본다",
      pvHidden === null && !!pvOpen && pvOpen.hits.length === 1 && !!pvOwner && pvOwner.hits.length === 1, JSON.stringify({ hidden: pvHidden, open: pvOpen && pvOpen.total, owner: pvOwner && pvOwner.total }));

    //  D16f — 가려진 프로젝트를 못 재면(조회 실패) 프로젝트 폴더의 초대 세션은 닫는다(fail-closed). 개인 폴더의 초대 세션은 그대로.
    //   그 조회 한 줄만 이 프로세스 안에서 실패시킨다 — 표를 건드리지 않는다(개발 DB 를 함께 쓰는 게이트웨이에 영향이 없게).
    //   (`itemsPool.query = 페이크` 는 유닛 테스트가 쓰는 길이다 — client.ts 의 풀 가드가 자기 속성이면 비켜선다.)
    const realQuery = itemsPool.query;
    itemsPool.query = (text, ...rest) => {
      const sql = typeof text === "string" ? text : (text && text.text) || "";
      if (/FROM project\s+WHERE level='project' AND list_id IS NOT NULL/.test(sql)) return Promise.reject(new Error("가려진 프로젝트 조회 실패(시험)"));
      return realQuery(text, ...rest);
    };
    try {
      invalidateVisibilityCache();
      const shut = ids(await search(A, "기린"));
      const personal = ids(await search(A, "슬랙"));
      chk("D16f 가려진 프로젝트를 못 재면 프로젝트 폴더의 초대 세션은 둘 다 닫는다", !shut.includes(SID(18)) && !shut.includes(SID(19)), JSON.stringify(shut));
      chk("D16f 개인 폴더의 초대 세션은 그대로 찾는다", personal.includes(SID(5)), JSON.stringify(personal));
    } finally {
      delete itemsPool.query;
      invalidateVisibilityCache();
    }
  }

  // ── D17 워크스페이스 격리 — 세션 목록과 같은 술어(sessionWorkspaceWhere) ──
  {
    await itemsPool.query(`INSERT INTO gw_workspace(id, slug, name, owner_member, state) VALUES($1, 'convpg-w2', 'w2', $3, 'active'), ($2, 'convpg-w3', 'w3', $3, 'archived')`, [W2, W3, A]);
    await put(SID(21), A, U("다른 워크스페이스의 하마 이야기"));
    await put(SID(22), A, U("이 워크스페이스로 적힌 하마 이야기"));
    await put(SID(23), A, U("보관된 워크스페이스로 적힌 하마 이야기"));
    await itemsPool.query(`INSERT INTO gw_session_map(session_id, workspace_id) VALUES($1, $2), ($3, $4), ($5, $6)`, [SID(21), W2, SID(22), PRIMARY_TENANT_ID, SID(23), W3]);
    for (const n of [21, 22, 23]) await C.indexConvSession("", SID(n));
    const a = ids(await search(A, "하마"));
    chk("D17 다른 워크스페이스에 적힌 세션은 못 찾는다", !a.includes(SID(21)), JSON.stringify(a));
    chk("D17 이 워크스페이스에 적힌 세션은 찾는다", a.includes(SID(22)), JSON.stringify(a));
    chk("D17 보관된 워크스페이스에 적힌 것은 «모름» 이라 기본 귀속(이 워크스페이스)으로 찾는다", a.includes(SID(23)), JSON.stringify(a));
  }

  // ── D18 주인의 휴지통 — 대화 uuid 로 버린 것도, 그 대화를 돌린 박스 id 로 버린 것도 빠진다 ──
  {
    await put(SID(24), A, U("휴지통에 넣은 낙타 이야기"));
    await put(SID(25), A, U("박스째 버린 낙타 이야기"));
    await put(SID(26), A, U("남겨 둔 낙타 이야기"));
    await itemsPool.query(`INSERT INTO org_session_conv(box_id, conv_uuid, owner) VALUES($1, $2, $3)`, [BOX(25), SID(25), A]);
    await itemsPool.query(`INSERT INTO org_session_trash(session_id, owner) VALUES($1, $3), ($2, $3)`, [SID(24), BOX(25), A]);
    for (const n of [24, 25, 26]) await C.indexConvSession("", SID(n));
    const a = ids(await search(A, "낙타"));
    chk("D18 휴지통의 세션(대화 uuid 표식)은 못 찾는다", !a.includes(SID(24)), JSON.stringify(a));
    chk("D18 박스 id 로 버린 세션의 대화도 못 찾는다", !a.includes(SID(25)), JSON.stringify(a));
    chk("D18 대조: 버리지 않은 세션은 찾는다", a.includes(SID(26)), JSON.stringify(a));

    //  D18i — 휴지통 표식은 **주인의 것**이다. 주인이 버린 초대 세션은(대화 uuid 로든 박스 id 로든) 초대받은 사람도 못 찾고,
    //   초대받은 사람이 남긴 표식은 주인의 검색을 가리지 않는다(재검토 지적 — 이 규칙을 잠근 시험이 없었다).
    for (const n of [30, 31, 0]) {
      await put(SID(n), B, U(`초대받은 사람이 볼 수달 이야기 ${n}`));
      await itemsPool.query(`INSERT INTO org_session_state(id, owner, invites) VALUES($1, $2, $3::jsonb)`, [BOX(n), B, JSON.stringify([A])]);
      await itemsPool.query(`INSERT INTO org_session_conv(box_id, conv_uuid, owner) VALUES($1, $2, $3)`, [BOX(n), SID(n), B]);
      await C.indexConvSession("", SID(n));
    }
    await itemsPool.query(`INSERT INTO org_session_trash(session_id, owner) VALUES($1, $3), ($2, $3)`, [SID(30), BOX(31), B]);   // 주인 B 가 버림
    await itemsPool.query(`INSERT INTO org_session_trash(session_id, owner) VALUES($1, $2)`, [SID(0), A]);                       // 초대받은 A 의 표식
    const inv = ids(await search(A, "수달"));
    const own = ids(await search(B, "수달"));
    chk("D18i 주인이 대화 uuid 로 버린 초대 세션은 초대받은 사람도 못 찾는다", !inv.includes(SID(30)), JSON.stringify(inv));
    chk("D18i 주인이 박스 id 로 버린 초대 세션도 초대받은 사람이 못 찾는다", !inv.includes(SID(31)), JSON.stringify(inv));
    chk("D18i 초대받은 사람의 표식은 주인의 검색을 가리지 않는다", own.includes(SID(0)), JSON.stringify(own));
    chk("D18i 대조: 주인 자신도 버린 두 세션은 못 찾는다", !own.includes(SID(30)) && !own.includes(SID(31)), JSON.stringify(own));
  }

  // ── D19 DB 가 못 받는 글자(NUL)·깨진 시각이 색인을 멈추지 않는다(파서 상태에 실리는 경우 포함 — codex) ──
  {
    //  첫 지시에 NUL — 종전엔 이 append 가 세션 제목 INSERT 에서 터져 대화가 아예 안 올라갔다(firstUserPromptTitle 이 걷는다).
    await put(SID(27), A, U("널\u0000글자가 낀 펭귄 말", "시각 아님"));
    const title = (await itemsPool.query(`SELECT title FROM session WHERE session_id=$1`, [SID(27)])).rows[0]?.title;
    chk("D19 첫 지시에 NUL 이 있어도 기록이 올라가고 제목엔 NUL 이 없다", title === "널글자가 낀 펭귄 말", JSON.stringify(title));
    await C.indexConvSession("", SID(27));
    const m = await msgs(SID(27));
    const tsRow = (await itemsPool.query(`SELECT ts FROM session_msg WHERE session_id=$1`, [SID(27)])).rows[0];
    const ts = tsRow ? tsRow.ts : "행 없음";   // ⚠ `?? ` 로 쓰면 NULL 도 «없음» 으로 바뀐다 — 재려는 것이 바로 NULL 이다
    chk("D19 NUL 은 걷고 깨진 시각은 NULL — 커서가 끝까지 간다",
      m.length === 1 && m[0].body === "널글자가 낀 펭귄 말" && ts === null && Number(await cursorOf(SID(27))) === await wm(SID(27)), JSON.stringify({ m, ts }));
    const codexLine = JSON.stringify({ timestamp: ago(0), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "코덱스 \u0000 펭귄 지시" }] } }) + "\n";
    const r = await S.appendSessionLog({ nodeId: "", sessionId: SID(28), atOffset: 0, data: Buffer.from(codexLine, "utf8"), harness: "codex", owner: A });
    if (!r.ok) throw new Error("codex append 실패");
    await C.indexConvSession("", SID(28));
    const mc = await msgs(SID(28));
    chk("D19 파서 상태에 NUL 이 실려도(codex 의 중복 가리기) 커밋된다", mc.length === 1 && mc[0].body === "코덱스  펭귄 지시" && Number(await cursorOf(SID(28))) === await wm(SID(28)), JSON.stringify(mc));
    //  사람이 «\u0000» 이라는 글자를 그대로 친 경우 — NUL 이 아니다. 인코딩된 JSON 에서 그 글자를 지우면 역슬래시 하나가 남아
    //   jsonb 가 거부하고 그 창이 영영 커밋되지 못한다(재검토 실측).
    const literal = "글자 그대로 \\u0000 친 펭귄";
    const lit = JSON.stringify({ timestamp: ago(0), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: literal }] } }) + "\n";
    const r2 = await S.appendSessionLog({ nodeId: "", sessionId: SID(29), atOffset: 0, data: Buffer.from(lit, "utf8"), harness: "codex", owner: A });
    if (!r2.ok) throw new Error("codex append 실패");
    let err = null;
    try { await C.indexConvSession("", SID(29)); } catch (e) { err = (e && e.message) || String(e); }
    const ml = await msgs(SID(29));
    chk("D19 «\\u0000» 을 글자 그대로 친 말도 커밋되고 글자는 그대로 남는다",
      !err && ml.length === 1 && ml[0].body === literal && Number(await cursorOf(SID(29))) === await wm(SID(29)), JSON.stringify({ err, ml }));
  }

  // ── D20 뽑는 규칙의 판이 다르면 그 세션을 처음부터 다시 색인한다(옛 규칙의 행이 남지 않는다) ──
  {
    await itemsPool.query(`INSERT INTO session_msg(node_id, session_id, at_offset, idx, role, ts, body) VALUES('', $1, 999999, 0, 'user', now(), '옛 판의 유령')`, [SID(1)]);
    await itemsPool.query(`UPDATE session_msg_cursor SET ver = 0 WHERE node_id='' AND session_id=$1`, [SID(1)]);
    const p = await C.convIndexPending({ requester: A, attach: true, workspaceId: PRIMARY_TENANT_ID });
    await C.indexConvSession("", SID(1));
    const m = (await msgs(SID(1))).map((x) => x.body);
    const ver = (await itemsPool.query(`SELECT ver FROM session_msg_cursor WHERE session_id=$1`, [SID(1)])).rows[0]?.ver;
    chk("D20 판이 다른 세션을 «색인 중» 으로 세고, 다시 색인하면 옛 행이 없다", p >= 1 && m.length === 2 && !m.includes("옛 판의 유령") && ver === C.CONV_INDEX_VER,
      JSON.stringify({ p, m, ver }));
  }

  // ── #4530 «어렴풋하게 쳐서 그 세션을 찾는다» ──────────────────────────────────────────────
  const ED = (path, ts = ago(0)) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [
    { type: "tool_use", id: "e1", name: "Edit", input: { file_path: path, old_string: "a", new_string: "b" } },
    { type: "tool_use", id: "e2", name: "Read", input: { file_path: "/w/읽기만한파일.ts" } }] } });
  // ── D21 고친 파일 경로가 색인되고(role edit · 읽기만 한 파일은 아님), 그 파일 이름 + 다른 말의 낱말로 찾는다 ──
  {
    await put(SID(32), A, U("칩을 누르면 키보드가 끊겨", ago(1)) + ED("/work/lively/web/v2/omni.ts", ago(1)) + AI("고쳤습니다", ago(1)));
    await C.indexConvSession("", SID(32));
    const m = await msgs(SID(32));
    chk("D21 고친 파일은 role 'edit' 한 줄(경로 끝 세 마디) · 읽기만 한 파일은 없다",
      m.filter((x) => x.role === "edit").map((x) => x.body).join() === "web/v2/omni.ts" && !m.some((x) => /읽기만한파일/.test(x.body)), JSON.stringify(m));
    chk("D21 경로 앞부분(work 등)으로는 그 세션이 고친 파일 때문에 맞지 않는다", !ids(await search(A, "lively 키보드")).includes(SID(32)));
    const r = await search(A, "omni.ts 키보드");
    const hit = r.results.find((x) => x.session_id === SID(32));
    chk("D21 고친 파일 이름 + 사람 말의 낱말로 그 세션을 찾고, 맞은 파일을 줄에 싣는다",
      !!hit && hit.edit === "v2/omni.ts" && hit.fields.includes("edit") && hit.fields.includes("user"), JSON.stringify(r.results));
  }
  // ── D22 낱말이 서로 다른 말에 있어도 같은 세션이면 찾는다(종전: 한 말 안에 모두 있어야 했다) ──
  {
    await put(SID(33), A, U("기린 그림을 고쳐 줘", ago(2)) + AI("달팽이 모양으로 바꿨습니다", ago(2)));
    await C.indexConvSession("", SID(33));
    chk("D22 «기린 달팽이» — 사람 말과 AI 말에 나뉜 낱말", ids(await search(A, "기린 달팽이")).includes(SID(33)));
    chk("D22 한 낱말이라도 세션 어디에도 없으면 빠진다", !ids(await search(A, "기린 코뿔소")).includes(SID(33)));
  }
  // ── D23 조사를 붙여 쳐도 찾는다 · D24 첫 지시(세션 제목)에 든 낱말도 센다 ──
  {
    chk("D23 «달팽이를» 이 «달팽이» 만 든 말과 맞는다", ids(await search(A, "달팽이를")).includes(SID(33)));
    await itemsPool.query(`UPDATE session SET title = '얼음 왕국 지도 만들기' WHERE node_id='' AND session_id=$1`, [SID(33)]);
    chk("D24 첫 지시(제목)에 든 낱말 + 대화 낱말로 찾는다", ids(await search(A, "왕국 달팽이")).includes(SID(33)));
  }
  // ── D25 % _ 는 글자 그대로 — «%» 한 글자가 모든 말과 맞지 않는다 ──
  {
    await put(SID(34), A, U("할인율 100% 적용", ago(3)));
    await C.indexConvSession("", SID(34));
    const pct = ids(await search(A, "100%"));
    const any = ids(await search(A, "%"));
    chk("D25 «100%» 는 그 말을 찾고 «%» 한 글자는 % 가 든 말만", pct.includes(SID(34)) && any.length === 1 && any[0] === SID(34), JSON.stringify({ pct, any }));
  }

  // ── D26 상한이 판정보다 먼저 걸리지 않는다 — 흔한 낱말만 든 최근 세션들이 후보를 채워도, 흔한 + 드문 낱말이 둘 다 든 옛 세션이
  //  결과에 남는다(격리 리뷰: 종전엔 «최근 것부터» 로만 잘라 그 세션이 판정 전에 빠졌다).
  {
    for (const n of [35, 36, 37, 38]) { await put(SID(n), A, U("흔한낱말 이야기 " + n, ago(0))); await C.indexConvSession("", SID(n)); }
    await put(SID(39), A, U("흔한낱말 그리고 드문낱말", ago(20)));
    await C.indexConvSession("", SID(39));
    const r = await search(A, "흔한낱말 드문낱말", { cap: 3, sort: "recent" });
    chk("D26 상한 3 · 흔한 낱말만 든 최근 세션 넷 → 둘 다 든 옛 세션이 결과에 있다", ids(r).includes(SID(39)) && r.capped === true && r.cap === 3, JSON.stringify({ ids: ids(r), capped: r.capped, cap: r.cap }));
    //  드문 낱말이 첫 지시(제목)에만 있어도 줄 세우기에 든다 — 제목은 같은 매개변수로 상한 앞에서 잰다.
    await put(SID(40), A, U("흔한낱말 다시 정리", ago(25)));
    await C.indexConvSession("", SID(40));
    await itemsPool.query(`UPDATE session SET title = '제목에만있는말 정리' WHERE node_id='' AND session_id=$1`, [SID(40)]);
    const t = await search(A, "흔한낱말 제목에만있는말", { cap: 3, sort: "recent" });
    chk("D26 드문 낱말이 첫 지시(제목)에만 있어도 상한 앞 줄 세우기에 든다", ids(t).includes(SID(40)), JSON.stringify(ids(t)));
  }

  // ── D27~D31 세션 하나의 «맞은 말»(통합검색 미리보기, #4530 안 A) ──
  //  사양: 맞은 말은 낱말이 많이 든 것부터 · 앞뒤 말은 대화 순서의 이웃(고친 파일 행은 이웃이 아니다) · 고친 파일은
  //   낱말이 맞은 것 먼저(횟수는 싣지 않는다) · 못 보는 세션은 null · 낱말이 말에 없으면 처음·마지막 말로 무슨 세션인지 알려 준다.
  {
    const E = (path, ts) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: path, old_string: "a", new_string: "b" } }] } });
    const t = (m) => new Date(NOW - 3_600_000 + m * 60_000).toISOString();
    await put(SID(41), A,
      U("처음 시킨 말 미리보기낱말 없음", t(0)) + AI("알겠습니다 살펴보겠습니다", t(1)) +
      U("배포 절차가 어떻게 되지", t(2)) + AI("배포 절차는 스테이지 다음 메인입니다", t(3)) + E("/w/web/v2/omni.ts", t(4)) + E("/w/web/v2/omni.ts", t(5)) + E("/w/src/절차/store.ts", t(6)) +
      U("그럼 배포만 먼저 해 줘", t(7)) + AI("마지막 말입니다", t(8)));
    await C.indexConvSession("", SID(41));
    const hits = (who, sid, q, o = {}) => C.sessionHits({ requester: who, attach: o.attach ?? true, workspaceId: PRIMARY_TENANT_ID, nodeId: "", sessionId: sid, q, limit: o.limit, since: o.since });
    const r = await hits(A, SID(41), "배포 절차");
    chk("D27 맞은 말 셋 · 말 수 6 · 낱말 둘 든 말이 앞(사람 말 먼저)", !!r && r.total === 3 && r.msgs === 6 && r.hits.length === 3
      && r.hits[0].text === "배포 절차가 어떻게 되지" && r.hits[0].terms === 2 && r.hits[0].role === "user"
      && r.hits[1].text === "배포 절차는 스테이지 다음 메인입니다" && r.hits[2].terms === 1, JSON.stringify(r && r.hits.map((h) => [h.role, h.terms, h.text])));
    chk("D28 앞뒤 말 = 대화 순서의 이웃(고친 파일 행은 건너뛴다)", !!r
      && r.hits[0].before?.text === "알겠습니다 살펴보겠습니다" && r.hits[0].after?.text === "배포 절차는 스테이지 다음 메인입니다"
      && r.hits[1].after?.text === "그럼 배포만 먼저 해 줘" && r.hits[1].after?.role === "user", JSON.stringify(r && r.hits.map((h) => [h.before?.text, h.after?.text])));
    chk("D29 고친 파일 = 같은 파일은 한 줄 · 낱말이 맞은 파일 먼저 · 끝 두 마디", !!r && r.edits.length === 2
      && r.edits[0].path === "절차/store.ts" && r.edits[0].hit === true && r.edits[1].path === "v2/omni.ts" && r.edits[1].hit === false, JSON.stringify(r && r.edits));
    chk("D29 처음 시킨 말 · 마지막 말", !!r && r.first?.text === "처음 시킨 말 미리보기낱말 없음" && r.last?.text === "마지막 말입니다" && r.last?.role === "assistant", JSON.stringify(r && [r.first, r.last]));
    const one = await hits(A, SID(41), "배포 절차", { limit: 1 });
    chk("D27 limit 1 → 맞은 말 하나(총수는 그대로 3)", !!one && one.hits.length === 1 && one.total === 3, JSON.stringify(one && [one.hits.length, one.total]));
    const none = await hits(A, SID(41), "어디에도없는말zz");
    chk("D30 낱말이 말에 없으면 맞은 말 0 · 처음·마지막 말과 말 수는 준다", !!none && none.hits.length === 0 && none.total === 0 && none.msgs === 6 && !!none.first && !!none.last, JSON.stringify(none));
    const empty = await hits(A, SID(41), "");
    chk("D30 검색어가 없어도 처음·마지막 말 · 고친 파일은 준다", !!empty && empty.hits.length === 0 && empty.msgs === 6 && empty.edits.length === 2 && empty.edits.every((e) => !e.hit), JSON.stringify(empty));
    const josa = await hits(A, SID(41), "절차는");
    chk("D27 조사를 붙여 쳐도 맞은 말을 찾는다", !!josa && josa.total === 2, JSON.stringify(josa && josa.total));
    //  권한 — 검색과 같은 축: 남의 세션은 초대받았을 때만(attach) · 없는 세션 · 다른 워크스페이스는 null
    chk("D31 남(B)은 A 의 세션 미리보기를 못 본다", (await hits(B, SID(41), "배포")) === null);
    chk("D31 초대받은 사람(attach)은 본다 · attach 가 꺼져 있으면 못 본다", (await hits(A, SID(5), "슬랙")) !== null && (await hits(A, SID(5), "슬랙", { attach: false })) === null);
    chk("D31 초대 안 받은 남의 세션 · 없는 세션은 null", (await hits(A, SID(6), "슬랙")) === null && (await hits(A, "convpg-없는세션", "슬랙")) === null);
    //  D32 검색 결과 줄에 프로젝트 이름이 실린다 — 세션이 붙어 있는 가장 늦은 프로젝트.
    const PJ = (await itemsPool.query(`INSERT INTO project(level, name, status, created_by) VALUES('project', $1, 'active', $2) RETURNING id`, [PROJ_NAMES[1], A])).rows[0].id;
    await itemsPool.query(`INSERT INTO session_project(session_id, project_id) VALUES($1, $2)`, [SID(41), PJ]);
    const withProj = (await search(A, "미리보기낱말")).results.find((x) => x.session_id === SID(41));
    chk("D32 검색 결과 줄에 그 세션의 프로젝트 이름이 실린다", !!withProj && withProj.project === PROJ_NAMES[1], JSON.stringify(withProj && withProj.project));
    const otherWs = await C.sessionHits({ requester: A, attach: true, workspaceId: W2, nodeId: "", sessionId: SID(41), q: "배포" });
    chk("D31 다른 워크스페이스에서는 못 본다", otherWs === null, JSON.stringify(otherWs));
    //  D33 누구의 세션인가 — 화면이 사람 말에 «나» 를 붙일지 가른다. 초대받아 보는 남의 세션은 false.
    const invited = await hits(A, SID(5), "슬랙");
    chk("D33 주인이 보면 mine=true · 초대받은 사람이 보면 mine=false", !!r && r.mine === true && !!invited && invited.mine === false, JSON.stringify([r && r.mine, invited && invited.mine]));
    //  D34 기간 — «맞은 말» 은 그 시각 뒤의 것만(총수도). 앞 말은 대화 순서의 이웃이라 기간 밖이어도 보인다.
    const late = await hits(A, SID(41), "배포 절차", { since: t(5) });
    chk("D34 기간(since) 뒤의 맞은 말만 고른다 · 앞 말은 기간 밖이어도 이웃으로 보인다", !!late && late.total === 1 && late.hits.length === 1
      && late.hits[0].text === "그럼 배포만 먼저 해 줘" && late.hits[0].before?.text === "배포 절차는 스테이지 다음 메인입니다" && late.msgs === 6,
      JSON.stringify(late && [late.total, late.msgs, late.hits.map((h) => [h.text, h.before?.text])]));
    //  D35 고친 파일 순서 — 임시 폴더(scratchpad · tmp)의 파일은 작업 폴더의 파일 뒤(이름순으로는 앞이어도). 낱말이 맞으면 임시 파일도 앞.
    await put(SID(42), A, U("임시파일순서 확인", t(0)) + E("/w/a/scratchpad/gen.mjs", t(1)) + E("/w/b/tmp/out.json", t(2)) + E("/w/web/v2/panes.ts", t(3)) + AI("끝", t(4)));
    await C.indexConvSession("", SID(42));
    const ord = await hits(A, SID(42), "");
    chk("D35 고친 파일 — 작업 폴더의 파일이 임시 폴더(scratchpad·tmp)의 파일보다 앞", !!ord && ord.edits.map((e) => e.path).join(",") === "v2/panes.ts,scratchpad/gen.mjs,tmp/out.json", JSON.stringify(ord && ord.edits));
    const ordHit = await hits(A, SID(42), "gen.mjs");
    chk("D35 낱말이 맞은 임시 파일은 그래도 맨 앞", !!ordHit && ordHit.edits[0]?.path === "scratchpad/gen.mjs" && ordHit.edits[0]?.hit === true, JSON.stringify(ordHit && ordHit.edits));
    //  D36 검색이 맞은 세션 수를 준다(«세션» 탭의 숫자) — 못 보는 세션은 세지 않는다.
    const tot = await search(A, "미리보기낱말"), totB = await search(B, "미리보기낱말");
    chk("D36 검색 결과에 맞은 세션 수(total) — 주인은 1 · 남은 0", tot.total === 1 && totB.total === 0, JSON.stringify([tot.total, totB.total]));
  }

  // ── 주기 정비 — 밀린 세션을 집어 색인한다 ──
  {
    await put(SID(15), A, U("정비가 집을 슬랙 말"));
    await C.sweepConvIndex();
    chk("정비가 밀린 세션을 색인한다", (await msgs(SID(15))).length === 1);
  }
} catch (e) {
  bad("예외", (e && e.stack) || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
