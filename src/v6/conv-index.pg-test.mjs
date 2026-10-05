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
const K = await import(`${DIST}/v6/session-card-store.js`);
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
const ALL = Array.from({ length: 84 }, (_, i) => SID(i));
const ALL_BOX = Array.from({ length: 84 }, (_, i) => BOX(i));
const W2 = "00000000-0000-4000-8000-00000000c0a2", W3 = "00000000-0000-4000-8000-00000000c0a3";   // 다른 워크스페이스 · 보관된 워크스페이스
const LIST_NAME = "__convpg_hidden_list__", PROJ_NAMES = ["__convpg_hidden_proj__", "__convpg_open_proj__", "__convpg_num_proj__", "__convpg_num_task__"];

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
/** 세션 요약 카드 한 줄(없으면 null). */
const cardOf = async (sid) => (await itemsPool.query(
  `SELECT card, src_bytes, ver, (embedding_vector IS NOT NULL) AS has_vec, updated_at FROM session_card WHERE node_id='' AND session_id=$1`, [sid])).rows[0] ?? null;
/** 1024차원 벡터 글 — 지정한 자리만 값이 있다(뜻 검색 시험: 방향이 같으면 가깝고 직각이면 0). */
const vecOf = (parts) => { const a = new Array(1024).fill(0); for (const [i, v] of Object.entries(parts)) a[Number(i)] = v; return a; };
const vecLit = (parts) => "[" + vecOf(parts).join(",") + "]";
/** 카드에 벡터를 직접 심는다(임베딩 서버 없이 뜻 검색을 잰다). 카드 줄이 없으면 만든다. */
const plant = (sid, parts, card = "심은 카드") => itemsPool.query(
  `INSERT INTO session_card(node_id, session_id, card_id, card, src_bytes, ver, embedding_vector) VALUES('', $1, $2, $3, 1, 1, $4::vector)
   ON CONFLICT (tenant_id, node_id, session_id) DO UPDATE SET card = EXCLUDED.card, embedding_vector = EXCLUDED.embedding_vector`, [sid, "|" + sid, card, vecLit(parts)]);
const cursorOf = async (sid) => (await itemsPool.query(
  `SELECT indexed_to FROM session_msg_cursor WHERE node_id='' AND session_id=$1`, [sid])).rows[0]?.indexed_to ?? null;
const search = (requester, q, o = {}) => C.searchConversations({
  requester, q, sort: o.sort ?? "relevance", since: o.since ?? null, limit: o.limit ?? 20, workspaceId: PRIMARY_TENANT_ID, attach: o.attach ?? true,
  ...(o.cap ? { sessionCap: o.cap } : {}),
  //  뜻으로 찾기는 기본으로 끈다(임베딩 서버가 없다) — 재는 장면만 벡터를 직접 넣는다(o.vec).
  semantic: o.vec ? { vec: vecOf(o.vec) } : "off",
});
const ids = (r) => r.results.map((x) => x.session_id);
/** 맞는 결과(문턱을 넘은 것)만 — «찾는다» 의 뜻. 권한·가림은 ids(전부)로 잰다(덜 맞는 결과로도 새면 안 된다). */
const matchIds = (r) => r.results.filter((x) => x.tier !== "weak").map((x) => x.session_id);

async function cleanup() {
  for (const t of ["session_msg", "session_msg_cursor", "session_card", "session_log_chunk", "session_log", "session", "session_purged", "gw_session_map"]) {
    await itemsPool.query(`DELETE FROM ${t} WHERE session_id = ANY($1::text[])`, [ALL]);
  }
  await itemsPool.query(`DELETE FROM org_session_trash WHERE session_id = ANY($1::text[]) OR session_id = ANY($2::text[])`, [ALL, ALL_BOX]);
  await itemsPool.query(`DELETE FROM org_session_conv WHERE box_id = ANY($1::text[])`, [ALL_BOX]);
  await itemsPool.query(`DELETE FROM execution_session_task WHERE session_id = ANY($1::text[])`, [ALL_BOX]);
  await itemsPool.query(`DELETE FROM session_project WHERE session_id = ANY($1::text[])`, [ALL]);
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
    //  #4530 «뜻으로 찾기» — 세션 요약 카드(대화에서 뽑은 글)도 사본이다. 지우기 전에 만들어 두고 함께 사라지는지 본다.
    const built9 = await K.buildCardFor("", SID(9));
    const card9 = await cardOf(SID(9));
    await S.purgeSessionLog("", SID(9), A);
    const left = (await msgs(SID(9))).length;
    const cur = await cursorOf(SID(9));
    const a = ids(await search(A, "슬랙", { since: ago(30) }));
    chk("D11 완전 삭제 뒤 색인·커서가 없고 검색에도 안 나온다", left === 0 && cur === null && !a.includes(SID(9)), JSON.stringify({ left, cur, a }));
    chk("D11 완전 삭제 뒤 세션 요약 카드도 없다", built9 === "built" && !!card9 && (await cardOf(SID(9))) === null, JSON.stringify({ built9, card9: !!card9, after: await cardOf(SID(9)) }));
  }

  // ── D12 보존 정리(reap) → 색인·커서도 사라진다 ──
  {
    await put(SID(10), A, U("보존기간이 지날 슬랙 이야기"));
    await C.indexConvSession("", SID(10));
    const before = (await msgs(SID(10))).length;
    await K.buildCardFor("", SID(10));
    const card10 = await cardOf(SID(10));
    await itemsPool.query(`UPDATE session_log SET updated_at = now() - interval '40 days' WHERE node_id='' AND session_id=$1`, [SID(10)]);
    const r = await S.reapSessionLogs(30);
    const after = (await msgs(SID(10))).length;
    chk("D12 reap 뒤 그 세션의 색인·커서가 사라진다", before === 1 && after === 0 && (await cursorOf(SID(10))) === null && r.logs >= 1, JSON.stringify({ before, after, r }));
    chk("D12 reap 뒤 세션 요약 카드도 사라진다", !!card10 && (await cardOf(SID(10))) === null, JSON.stringify({ had: !!card10, after: await cardOf(SID(10)) }));
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
    chk("D36 낱말 둘 — 숫자는 둘 다 맞은 세션만(하나만 맞은 세션은 세지 않는다)", two.total === 1 && matchIds(two).join() === SID(43) && (await search(B, "기린")).total === 3, JSON.stringify([two.total, ids(two)]));
    //  #4530 3차 — 하나만 맞은 세션은 «덜 맞는 결과» 로(맞는 결과가 적을 때) · 빠진 낱말을 말한다 · 숫자(total)에는 들지 않는다.
    chk("D36 하나만 맞은 세션은 덜 맞는 결과 — 빠진 낱말 «물소»", two.weak === 2 && two.results.filter((x) => x.tier === "weak").every((x) => x.missing.join() === "물소" && [SID(18), SID(19)].includes(x.session_id)),
      JSON.stringify(two.results.map((x) => [x.session_id, x.tier, x.missing])));
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
    //  #4530 3차 — 낱말 일부만 맞은 세션은 «덜 맞는 결과» 로는 설 수 있다(맞는 결과가 적을 때). 여기서 재는 것은 «맞는 결과» 가 아니라는 것.
    const pre = await search(A, "lively 키보드");
    chk("D21 경로 앞부분(work 등)으로는 그 세션이 고친 파일 때문에 맞지 않는다(맞는 결과 아님 · 빠진 낱말은 lively)",
      !matchIds(pre).includes(SID(32)) && (pre.results.find((x) => x.session_id === SID(32))?.missing ?? ["lively"]).join() === "lively", JSON.stringify(pre.results.map((x) => [x.session_id, x.tier, x.missing])));
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
    chk("D22 한 낱말이라도 세션 어디에도 없으면 맞는 결과가 아니다", !matchIds(await search(A, "기린 코뿔소")).includes(SID(33)));
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

  // ── D37~D44 #4530 3차 — 글자가 조금 달라도 찾는다 · 충분히 맞는 것만 «맞는 결과» ──────────────────────
  //  원준 2026-10-05: «검색의 퀄리티가 너무 구린 것 같은데» · «결국 세션을 해야함». 매니지드 실측: 붙여 쓰면 6% · 한 글자 틀리면 0% ·
  //   군말을 더하면 48% · 영어↔한글 58% 만 찾았다. 낱말은 이 시험에만 있는 것으로 쓴다(다른 장면의 세션이 섞이지 않게).
  {
    const t = (m) => new Date(NOW - 3_600_000 + m * 60_000).toISOString();
    await put(SID(44), A, U("귤나무 정원 창을 다시 짜 줘", t(0)) + AI("목록과 미리 보기 두 칸으로 바꿨습니다", t(1)));
    await put(SID(45), A, U("deploy 순서를 알려 줘", t(2)) + AI("스테이지 다음 메인입니다", t(3)) + U("그리고 rollback 은 어떻게 해", t(3.5)));
    await put(SID(46), A, U("이 방법 말고 다른 길로 가자", t(4)));
    await put(SID(47), A, U("아무 말이나 하나", t(5)) + AI("참고로 석류즙 이야기도 있었습니다", t(6)));
    await put(SID(48), A, U("다른 말 하나", t(7)) + AI("석류즙 하나", t(8)) + AI("석류즙 둘", t(9)) + AI("석류즙 셋", t(10)));
    await put(SID(49), B, U("귤나무 정원 비밀 이야기", t(11)));   // 남(B)의 세션 — A 는 초대받지 않았다
    for (const n of [44, 45, 46, 47, 48, 49]) await C.indexConvSession("", SID(n));
    const row = (r, sid) => r.results.find((x) => x.session_id === sid);

    //  D37 붙여 쓴 말 — 엄격하게는 0건, 느슨한 2차가 «귤나무 정원» 을 찾는다. 추측이므로 덜 맞는 결과 · 무엇을 느슨하게 봤는지 말한다.
    const joined = await search(A, "귤나무정원");
    const j44 = row(joined, SID(44));
    chk("D37 붙여 쓴 말(«귤나무정원») → 띄어 쓴 글의 세션을 찾는다(덜 맞는 결과 · loose · 실제 글)", !!j44 && j44.tier === "weak" && j44.loose.join() === "귤나무정원"
      && j44.marks.join() === "귤나무 정원" && /귤나무 정원/.test(j44.best?.text ?? "") && joined.total === 0 && joined.loosened.join() === "귤나무정원",
      JSON.stringify([joined.total, joined.loosened, joined.results.map((x) => [x.session_id, x.tier, x.loose, x.marks])]));
    chk("D37 느슨한 2차에서도 남의 세션은 안 나온다", !ids(joined).includes(SID(49)), JSON.stringify(ids(joined)));

    //  D38 한 글자 틀림 — 다른 낱말(«정원»)로 좁혀진 세션 안에서만 틀린 낱말을 느슨하게 본다.
    const typo = await search(A, "귤나므 정원");
    const t44 = row(typo, SID(44));
    chk("D38 한 글자 틀린 낱말(«귤나므») → 그 세션을 찾는다(덜 맞는 결과 · 실제 글 «귤나무»)", !!t44 && t44.tier === "weak" && t44.loose.join() === "귤나므" && t44.marks.includes("귤나무")
      && !ids(typo).includes(SID(49)), JSON.stringify(typo.results.map((x) => [x.session_id, x.tier, x.loose, x.marks])));
    const typoOnly = await search(A, "귤나므");
    chk("D38 틀린 낱말 하나만 쳐도(좁힐 낱말 없음) 사람 말에서 찾는다", row(typoOnly, SID(44))?.tier === "weak" && !ids(typoOnly).includes(SID(49)), JSON.stringify(typoOnly.results.map((x) => [x.session_id, x.tier])));

    //  D39 다른 표기 — «배포» 로 쳐도 «deploy» 라고 말한 세션을 찾는다(맞는 결과 · alias).
    const alias = await search(A, "배포 순서");
    const a45 = row(alias, SID(45));
    chk("D39 다른 표기(배포 = deploy) → 맞는 결과 · alias 에 친 낱말", !!a45 && a45.tier === "match" && a45.alias.join() === "배포" && /deploy/.test(a45.best?.text ?? ""), JSON.stringify(alias.results.map((x) => [x.session_id, x.tier, x.alias])));

    //   첫 지시(제목)가 아닌 말에만 있는 다른 표기도 찾는다 — 제목은 화면 밖(JS)에서도 재므로, 이 줄이 SQL 쪽 맞춤을 잠근다.
    const alias2 = await search(A, "롤백 순서");
    chk("D39 다른 표기가 첫 지시가 아닌 말에만 있어도 맞는 결과(롤백 = rollback)", row(alias2, SID(45))?.tier === "match" && row(alias2, SID(45))?.alias.join() === "롤백", JSON.stringify(alias2.results.map((x) => [x.session_id, x.tier, x.alias, x.missing])));

    //  D40 군말 — «방법» 은 없어도 된다. 군말만 든 세션은 후보가 아니다.
    const filler = await search(A, "귤나무 방법");
    chk("D40 군말(«방법»)이 없는 세션도 맞는 결과 · 군말만 든 세션은 나오지 않는다", row(filler, SID(44))?.tier === "match" && !ids(filler).includes(SID(46)) && filler.total === 1,
      JSON.stringify([filler.total, filler.results.map((x) => [x.session_id, x.tier, x.missing])]));

    //  D41 AI 가 한두 번 스친 말로만 맞은 세션은 덜 맞는 결과 — 세 번 이상 이야기했으면 맞는 결과. 숫자(total)는 맞는 결과만.
    const ai = await search(A, "석류즙");
    chk("D41 AI 가 한 번 스친 세션은 덜 맞는 결과 · 세 번 이야기한 세션은 맞는 결과", row(ai, SID(47))?.tier === "weak" && row(ai, SID(48))?.tier === "match" && ai.total === 1 && ai.weak === 1
      && ids(ai).indexOf(SID(48)) < ids(ai).indexOf(SID(47)), JSON.stringify([ai.total, ai.weak, ai.results.map((x) => [x.session_id, x.tier])]));

    //  D42 가려진 프로젝트의 초대 세션(D16 의 18번)은 느슨한 2차로도 안 나온다 — 열린 프로젝트의 초대 세션(19번)은 나온다.
    const hid = await search(A, "기린이야기");
    chk("D42 느슨한 2차도 가려진 프로젝트의 초대 세션을 감춘다(열린 쪽은 찾는다)", !ids(hid).includes(SID(18)) && ids(hid).includes(SID(19)), JSON.stringify(hid.results.map((x) => [x.session_id, x.tier, x.loose])));

    //  D43 미리보기 — 느슨하게 찾은 세션의 맞은 말도 보인다(실제 글을 준다) · 다른 표기로도 맞은 말을 센다.
    const hits = (who, sid, q) => C.sessionHits({ requester: who, attach: true, workspaceId: PRIMARY_TENANT_ID, nodeId: "", sessionId: sid, q });
    const pv = await hits(A, SID(44), "귤나무정원");
    chk("D43 미리보기 — 붙여 쓴 말로도 맞은 말이 선다(marks = 실제 글)", !!pv && pv.hits.length === 1 && pv.total === 1 && pv.marks.join() === "귤나무 정원" && /귤나무 정원/.test(pv.hits[0].text), JSON.stringify(pv && [pv.total, pv.marks, pv.hits.map((h) => h.text)]));
    const pvAlias = await hits(A, SID(45), "배포");
    chk("D43 미리보기 — 다른 표기(deploy)로 맞은 말을 센다 · 엄격하게 맞으면 marks 는 비어 있다", !!pvAlias && pvAlias.total === 1 && pvAlias.marks.length === 0, JSON.stringify(pvAlias && [pvAlias.total, pvAlias.marks]));

    //  D44 엄격하게 충분히 찾았으면 느슨한 2차는 돌지 않는다 — 띄어 쓴 다른 세션이 끼지 않는다.
    await put(SID(50), A, U("감나무 가지치기 하나", t(12)));
    await put(SID(51), A, U("감나무 가지치기 둘", t(13)));
    await put(SID(52), A, U("감나무 가지치기 셋", t(14)));
    await put(SID(53), A, U("감 나무 옮겨 심기", t(15)));
    for (const n of [50, 51, 52, 53]) await C.indexConvSession("", SID(n));
    const enough = await search(A, "감나무");
    chk("D44 엄격하게 셋을 찾았으면 느슨한 2차는 돌지 않는다", enough.total === 3 && enough.loosened.length === 0 && !ids(enough).includes(SID(53)), JSON.stringify([enough.total, enough.loosened, ids(enough)]));
  }

  // ── D45~D50 #4530 «뜻으로 찾기» — 세션 요약 카드 · 벡터로 찾기 ───────────────────────────────────
  //  원준 2026-10-05: «결국 세션을 해야함 … 다를 전부 하도록». 매니지드 실측: 어렴풋한 말 15개 중 세션은 7개만 5위 안(글자가 맞아야만 찾혀서).
  //  임베딩 서버 없이 잰다 — 카드에 벡터를 직접 심고(plant) 검색어의 벡터를 넣는다(o.vec). 방향이 같으면 1, 직각이면 0.
  {
    const t = (m) => new Date(NOW - 3_600_000 + m * 60_000).toISOString();
    const E = (path, ts) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: path, old_string: "a", new_string: "b" } }] } });
    //  D45 카드 만들기 — 이름·사람이 한 말·고친 파일·마지막 답이 글이 되고, 색인 위치와 판이 적힌다.
    await put(SID(54), A, U("세션을 지우면 목록이 깜빡거려", t(0)) + AI("원인을 찾겠습니다", t(1)) + E("/w/web/v2/side.ts", t(2)) + U("고쳐서 올려 줘", t(3)) + AI("깜빡임을 없앴습니다", t(4)));
    await C.indexConvSession("", SID(54));
    const b54 = await K.buildCardFor("", SID(54));
    const c54 = await cardOf(SID(54));
    chk("D45 카드 = 처음 시킨 말 · 이어서 한 말 · 고친 파일 · 마지막 답 — 색인 위치·판이 적힌다", b54 === "built" && !!c54
      && /처음 시킨 말: 세션을 지우면 목록이 깜빡거려/.test(c54.card) && /이어서 한 말: 고쳐서 올려 줘/.test(c54.card) && /고친 파일: v2\/side\.ts/.test(c54.card)
      && /마지막 답: 깜빡임을 없앴습니다/.test(c54.card) && Number(c54.src_bytes) === Number(await cursorOf(SID(54))) && c54.ver >= 1 && c54.has_vec === false,
      JSON.stringify({ b54, c54 }));
    chk("D45 대화가 그대로면 다시 만들어도 same", (await K.buildCardFor("", SID(54))) === "same");
    await put(SID(54), A, U("다른 화면에서도 같은지 봐 줘", t(5)));
    await C.indexConvSession("", SID(54));
    chk("D45 대화가 늘면 글이 바뀐다(built)", (await K.buildCardFor("", SID(54))) === "built" && /다른 화면에서도 같은지 봐 줘/.test((await cardOf(SID(54))).card));
    //  글이 바뀌면 옛 벡터는 버린다(임베딩 대기로) — 옛 글의 벡터로 찾아 주면 안 된다. 글이 그대로면 벡터도 그대로.
    //   임베딩이 켜져 있을 때의 일이라 설정을 잠깐 켠다(서버를 부르지는 않는다 — 벡터를 비우기만 한다).
    {
      const cfg0 = (await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id = 1`)).rows[0]?.embedding_config ?? null;
      await itemsPool.query(`INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING`);
      await itemsPool.query(`UPDATE org_runtime_config SET embedding_config = $1::jsonb WHERE id = 1`, [JSON.stringify({ provider: "http", base_url: "http://127.0.0.1:9", model: "test", dimensions: 1024 })]);
      try {
        await itemsPool.query(`UPDATE session_card SET embedding_vector = $2::vector WHERE node_id='' AND session_id=$1`, [SID(54), vecLit({ 3: 1 })]);
        const keep = (await K.buildCardFor("", SID(54))) === "same" && (await cardOf(SID(54))).has_vec === true;
        await put(SID(54), A, U("마지막으로 하나만 더", t(5.5)));
        await C.indexConvSession("", SID(54));
        const reset = (await K.buildCardFor("", SID(54))) === "built" && (await cardOf(SID(54))).has_vec === false;
        chk("D45 글이 그대로면 벡터를 두고, 글이 바뀌면 옛 벡터를 비운다(임베딩 대기)", keep && reset, JSON.stringify({ keep, reset }));
      } finally {
        await itemsPool.query(`UPDATE org_runtime_config SET embedding_config = $1::jsonb WHERE id = 1`, [cfg0 === null ? null : JSON.stringify(cfg0)]);
      }
    }
    //  긴 세션 — 파일을 아주 많이 고친 뒤에 한 말도 카드에 든다(앞에서만 읽으면 뒤의 말이 영영 못 들어왔다, 격리 리뷰).
    {
      let big = U("긴세션 맨 처음에 시킨 말", t(20));
      for (let i = 0; i < 3100; i++) big += E(`/w/long/f${i}.ts`, t(21));
      big += U("긴세션 맨 나중에 덧붙인 말입니다", t(22));
      await put(SID(72), A, big);
      await C.indexConvSession("", SID(72));
      await K.buildCardFor("", SID(72));
      const c72 = (await cardOf(SID(72)))?.card ?? "";
      chk("D45 파일을 3,100번 고친 뒤에 한 말도 카드에 든다 · 처음 말도 그대로", /긴세션 맨 처음에 시킨 말/.test(c72) && /긴세션 맨 나중에 덧붙인 말입니다/.test(c72) && /고친 파일: /.test(c72), c72.slice(0, 200) + " … " + c72.slice(-160));
    }
    //  카드 글의 토큰 모양은 가린다 — 임베딩 서버로 나가는 글이다.
    await put(SID(73), A, U("이 키로 올려 줘 ghp_abcdefghijklmnopqrstuvwxyz0123456789 부탁해", t(23)));
    await C.indexConvSession("", SID(73));
    await K.buildCardFor("", SID(73));
    chk("D45 카드에 토큰 모양이 남지 않는다", !/ghp_abcdefghijklmnopqrstuvwxyz0123456789/.test((await cardOf(SID(73)))?.card ?? "x ghp_abcdefghijklmnopqrstuvwxyz0123456789") && /이 키로 올려 줘/.test((await cardOf(SID(73))).card));

    //  사람이 한 말이 없는 세션은 빈 카드로 적어 둔다(정비가 되풀이해 집지 않게) · 없는 세션은 gone.
    await put(SID(55), A, AI("혼자 한 말", t(6)));
    await C.indexConvSession("", SID(55));
    chk("D45 사람이 한 말이 없으면 empty(빈 카드 줄) · 없는 세션은 gone", (await K.buildCardFor("", SID(55))) === "empty" && (await cardOf(SID(55)))?.card === "" && (await K.buildCardFor("", "convpg-없는세션")) === "gone");

    //  D46 정비 — 카드가 없는 세션을 집는다 · 서브에이전트 세션은 안 집는다 · 방금 만든 카드는 대화가 늘어도 곧바로 다시 만들지 않는다.
    await put(SID(56), A, U("정비가 집을 세션의 첫 말", t(7)));
    await put(SID(57), A, U("서브에이전트가 한 말", t(8)), SID(56));
    for (const n of [56, 57]) await C.indexConvSession("", SID(n));
    const sw = await K.sweepSessionCards({ max: 200 });
    chk("D46 정비가 카드 없는 세션의 카드를 만든다 · 서브에이전트 세션은 만들지 않는다", !!(await cardOf(SID(56))) && (await cardOf(SID(57))) === null && sw.built >= 1, JSON.stringify(sw));
    await put(SID(56), A, U("조금 뒤에 한 말", t(9)));
    await C.indexConvSession("", SID(56));
    await K.sweepSessionCards({ max: 200 });
    const fresh = (await cardOf(SID(56))).card;
    await itemsPool.query(`UPDATE session_card SET updated_at = now() - interval '11 minutes' WHERE node_id='' AND session_id=$1`, [SID(56)]);
    await K.sweepSessionCards({ max: 200 });
    chk("D46 방금 만든 카드는 대화가 늘어도 곧바로 다시 만들지 않는다 — 10분이 지나면 다시 만든다", !/조금 뒤에 한 말/.test(fresh) && /조금 뒤에 한 말/.test((await cardOf(SID(56))).card), JSON.stringify({ fresh }));

    //  D47 뜻으로 찾기 — 글자가 하나도 안 맞아도 벡터가 가까운 세션을 «덜 맞는 결과» 로 준다. 문턱: 0.5 미만은 버리고, 1등과 0.08 넘게
    //   떨어진 것도 버린다. 못 보는 세션(남의 것)은 안 나온다.
    await put(SID(58), A, U("뜻검색 과녁 하나", t(10)));
    await put(SID(59), A, U("뜻검색 과녁 둘", t(11)));
    await put(SID(60), A, U("뜻검색 조금 먼 것", t(12)));
    await put(SID(61), A, U("뜻검색 직각", t(13)));
    await put(SID(62), B, U("뜻검색 남의 세션", t(14)));
    for (const n of [58, 59, 60, 61, 62]) await C.indexConvSession("", SID(n));
    await plant(SID(58), { 0: 1 });
    await plant(SID(59), { 0: 1, 1: 0.3 });        // 코사인 0.958
    await plant(SID(60), { 0: 1, 1: 1 });          // 0.707 — 1등(1.0)과 0.08 넘게 떨어진다
    await plant(SID(61), { 2: 1 });                // 0
    await plant(SID(62), { 0: 1 });                // 남(B)의 세션
    const semr = await search(A, "어디에도없는말zz", { vec: { 0: 1 } });
    const semIds = ids(semr);
    chk("D47 뜻으로만 가까운 세션 = 덜 맞는 결과 · sem 값 · 맞은 자리 없음 — 가까운 순", semIds.join() === [SID(58), SID(59)].join() && semr.results.every((x) => x.tier === "weak" && x.fields.length === 0 && x.best === null)
      && semr.results[0].sem === 1 && semr.results[1].sem === 0.96 && semr.total === 0 && semr.weak === 2, JSON.stringify(semr.results.map((x) => [x.session_id, x.tier, x.sem])));
    chk("D47 1등과 멀리 떨어진 것 · 직각인 것 · 남의 세션은 안 나온다", !semIds.includes(SID(60)) && !semIds.includes(SID(61)) && !semIds.includes(SID(62)), JSON.stringify(semIds));
    chk("D47 뜻 검색을 끄면 뜻으로만 온 줄이 없다", (await search(A, "어디에도없는말zz")).results.length === 0);
    const lowOnly = await search(A, "어디에도없는말zz", { vec: { 0: 1, 9: 3 } });   // 가장 가까운 것도 0.32 — 문턱(0.5) 아래
    chk("D47 가장 가까운 것도 문턱 아래면 아무것도 주지 않는다", lowOnly.results.length === 0, JSON.stringify(lowOnly.results.map((x) => [x.session_id, x.sem])));

    //  D48 가려진 프로젝트의 초대 세션(D16 의 18번)은 뜻으로도 안 나온다 — 열린 프로젝트의 초대 세션(19번)은 나온다.
    await plant(SID(18), { 5: 1 });
    await plant(SID(19), { 5: 1 });
    const semHid = ids(await search(A, "어디에도없는말zz", { vec: { 5: 1 } }));
    chk("D48 뜻 검색도 가려진 프로젝트의 초대 세션을 감춘다(열린 쪽은 찾는다)", !semHid.includes(SID(18)) && semHid.includes(SID(19)), JSON.stringify(semHid));

    //  D49 글자로 맞은 세션이 뜻으로도 가까우면 맨 위 셋을 고르는 관련도에 얹는다 — 뜻이 가까운 옛 세션이 맨 위로, 줄에 sem 이 실린다.
    await put(SID(63), A, U("매실청 담그는 이야기 옛날", ago(20)));
    await put(SID(64), A, U("매실청 담그는 이야기 요즘", ago(0)));
    for (const n of [63, 64]) await C.indexConvSession("", SID(n));
    const plain = await search(A, "매실청", { sort: "recent" });
    await plant(SID(63), { 7: 1 });
    const boosted = await search(A, "매실청", { sort: "recent", vec: { 7: 1 } });
    chk("D49 뜻이 가까운 옛 세션이 맨 위 «가장 맞는 결과» 로 — 뜻 검색 없이는 최근 것이 먼저", ids(plain)[0] === SID(64) && ids(boosted)[0] === SID(63) && boosted.results[0].top === true
      && boosted.results[0].sem === 1 && boosted.results[0].tier === "match" && boosted.total === 2 && boosted.weak === 0, JSON.stringify([ids(plain), boosted.results.map((x) => [x.session_id, x.top, x.sem, x.tier])]));

    //  D49b 줄 수 상한에 잘린 «맞는 결과» 는 «뜻이 비슷함» 으로 다시 나오지 않는다 — 같은 세션을 두 번 세지 않는다(격리 리뷰).
    //   71번 = AI 가 세 번 말해 «맞는 결과» 이지만(이름에는 없다) 관련도가 낮아 상한(2)에 잘린다 · 뜻으로는 가깝다(0.55 — 가산을 얹어도 못 올라온다).
    await put(SID(69), A, U("살구잼 만드는 이야기 하나", ago(1)));
    await put(SID(70), A, U("살구잼 만드는 이야기 둘", ago(2)));
    await put(SID(71), A, U("과일로 무언가 만드는 이야기", ago(3)) + AI("살구잼 을 만들 수 있습니다", ago(3)) + AI("살구잼 은 설탕이 듭니다", ago(3)) + AI("살구잼 을 병에 담습니다", ago(3)));
    for (const n of [69, 70, 71]) await C.indexConvSession("", SID(n));
    await plant(SID(71), { 11: 0.55, 13: Math.sqrt(1 - 0.55 * 0.55) });
    await plant(SID(60), { 11: 0.56, 14: Math.sqrt(1 - 0.56 * 0.56) }, "글자로는 안 맞는 카드");   // 대조 — 글자로 안 맞은 세션은 뜻으로 온다
    const cut = await search(A, "살구잼", { sort: "relevance", limit: 2, vec: { 11: 1 } });
    chk("D49b 잘린 맞는 결과는 «뜻이 비슷함» 으로 다시 서지 않는다 · 수도 한 번만 센다(글자로 안 맞은 세션은 뜻으로 온다)",
      cut.total === 3 && matchIds(cut).join() === [SID(69), SID(70)].join() && !ids(cut).includes(SID(71))
      && cut.results.some((x) => x.session_id === SID(60) && x.tier === "weak" && x.sem === 0.56) && cut.weak === 1,
      JSON.stringify({ total: cut.total, weak: cut.weak, rows: cut.results.map((x) => [x.session_id, x.tier, x.sem ?? null]) }));

    //  D50 기간 — 뜻으로만 온 줄도 기간 밖(마지막 활동 기준)이면 빠진다.
    await itemsPool.query(`UPDATE session SET last_seen = now() - interval '40 days' WHERE node_id='' AND session_id=$1`, [SID(58)]);
    const semSince = ids(await search(A, "어디에도없는말zz", { vec: { 0: 1 }, since: ago(10) }));
    chk("D50 기간으로 좁히면 기간 밖의 세션은 뜻으로도 안 나온다", !semSince.includes(SID(58)) && semSince.includes(SID(59)), JSON.stringify(semSince));
  }

  // ── D51~D53 #4530 번호로 찾기 — 그 번호의 프로젝트에 묶인 세션 · 그 번호의 태스크를 맡은 세션 ──────────────────
  //  원준 2026-10-05: «프로젝트나 세션의 4자리? 더 늘어날수도있긴한. 검색하면 어떤게 나올지는 너가 알아서 좀 잘».
  //  종전엔 대화 안에 그 숫자가 적힌 세션만 걸렸다 — 그 프로젝트에서 일한 세션인데도 번호를 말하지 않았으면 안 나왔다.
  {
    const t = (m) => new Date(NOW - 3_600_000 + m * 60_000).toISOString();
    const NP = (await itemsPool.query(`INSERT INTO project(level, name, status, created_by) VALUES('project', $1, 'active', $2) RETURNING id`, [PROJ_NAMES[2], A])).rows[0].id;
    const NT = (await itemsPool.query(`INSERT INTO project(level, name, status, created_by, parent_id) VALUES('task', $1, 'todo', $2, $3) RETURNING id`, [PROJ_NAMES[3], A, NP])).rows[0].id;
    await put(SID(65), A, U("번호시험 첫째 세션", t(0)));                 // 프로젝트 NP 에 묶였다(대화에 번호는 없다)
    await put(SID(66), A, U("번호시험 둘째 세션", t(1)));                 // 태스크 NT 를 맡았다(박스 66 이 돌린 대화)
    await put(SID(67), B, U("번호시험 남의 세션", t(2)));                 // B 의 세션 — 같은 프로젝트에 묶였지만 A 는 못 본다
    await put(SID(68), A, U(`대화에 ${NP} 번호를 적은 세션`, t(3)));      // 묶이지 않았지만 대화에 그 숫자가 있다
    for (const n of [65, 66, 67, 68]) await C.indexConvSession("", SID(n));
    await itemsPool.query(`INSERT INTO session_project(session_id, project_id) VALUES($1, $2), ($3, $2)`, [SID(65), NP, SID(67)]);
    await itemsPool.query(`INSERT INTO org_session_conv(box_id, conv_uuid, owner) VALUES($1, $2, $3)`, [BOX(66), SID(66), A]);
    await itemsPool.query(`INSERT INTO execution_session_task(session_id, task_id, pos) VALUES($1, $2, 0)`, [BOX(66), NT]);
    const row = (r, sid) => r.results.find((x) => x.session_id === sid);

    const byP = await search(A, String(NP));
    chk("D51 프로젝트 번호 → 그 프로젝트에 묶인 세션이 맞는 결과로(대화에 번호가 없어도) · nums 에 그 번호 · 맞은 말은 없다",
      row(byP, SID(65))?.tier === "match" && JSON.stringify(row(byP, SID(65))?.nums) === JSON.stringify([NP]) && row(byP, SID(65))?.best === null && row(byP, SID(65))?.fields.includes("ident"),
      JSON.stringify(byP.results.map((x) => [x.session_id, x.tier, x.nums, x.fields])));
    chk("D51 대화에 그 숫자를 적은 세션도 그대로 찾는다 · 남의 세션은 묶여 있어도 안 나온다 · 태스크만 맡은 세션은 프로젝트 번호로는 안 나온다",
      row(byP, SID(68))?.tier === "match" && !ids(byP).includes(SID(67)) && !ids(byP).includes(SID(66)), JSON.stringify(ids(byP)));
    //  가려진 프로젝트의 초대 세션(18번)은 번호로 묶여 있어도 안 나온다 — 열린 프로젝트의 초대 세션(19번)은 나온다(같은 2차 판정).
    await itemsPool.query(`INSERT INTO session_project(session_id, project_id) VALUES($1, $2), ($3, $2)`, [SID(18), NP, SID(19)]);
    const hidNum = ids(await search(A, String(NP)));
    chk("D51 번호로 찾기도 가려진 프로젝트의 초대 세션을 감춘다(열린 쪽은 찾는다)", !hidNum.includes(SID(18)) && hidNum.includes(SID(19)), JSON.stringify(hidNum));
    const byT = await search(A, "#" + NT);
    chk("D52 태스크 번호(#붙여도) → 그 태스크를 맡은 세션(박스가 돌린 대화)", row(byT, SID(66))?.tier === "match" && JSON.stringify(row(byT, SID(66))?.nums) === JSON.stringify([NT]) && !ids(byT).includes(SID(65)),
      JSON.stringify(byT.results.map((x) => [x.session_id, x.tier, x.nums])));
    const mix = await search(A, `${NP} 첫째`);
    chk("D53 번호 + 낱말 — 번호는 묶음으로 · 낱말은 대화로 맞아야 맞는 결과(둘째 세션은 아니다)", row(mix, SID(65))?.tier === "match" && !matchIds(mix).includes(SID(66)) && !matchIds(mix).includes(SID(68)),
      JSON.stringify(mix.results.map((x) => [x.session_id, x.tier, x.missing])));
    chk("D53 아무 데도 없는 번호는 아무것도 주지 않는다", (await search(A, "2147480000")).results.length === 0);
    //  숫자는 번호다 — 띄어 쓴 숫자(«98 76 54»)를 «비슷한 글자» 로 찾지 않는다(글자 낱말은 그렇게 찾는다 — D37 이 대조).
    await put(SID(74), A, U("번호시험 전화는 98 76 54 로 걸어 줘", t(4)));
    await C.indexConvSession("", SID(74));
    const spaced = await search(A, "987654");
    chk("D53 숫자 낱말은 느슨하게 찾지 않는다(띄어 쓴 숫자는 다른 것이다)", !ids(spaced).includes(SID(74)) && spaced.loosened.length === 0, JSON.stringify({ ids: ids(spaced), loosened: spaced.loosened }));
  }

  // ── D54~D56 #4530 배포 뒤 — 한 글자 낱말 · 군말만 든 말은 훑지 않는다 · 뜻이 꽤 가까운 세션의 자리 ───────────────
  //  매니지드 실측(판 bbe59161): «미리 보기 환경이 안 뜸» 이 4초 상한에 걸려 실패했고(한 글자 낱말이 말을 거의 다 훑게 했다),
  //   «세션 지우면 깜빡거림» 으로 0.76 까지 가까운 «세션 삭제 깜빡임» 이 낱말 일부만 맞은 두 세션 뒤에 섰다.
  {
    const t = (m) => new Date(NOW - 7_200_000 + m * 60_000).toISOString();
    //  D54 한 글자 낱말 — 다른 낱말이 둘 이상이면 없어도 되는 낱말. 둘뿐이면 있어야 한다.
    await put(SID(76), A, U("북어 국물 끓이는 이야기", t(0)));                  // «쌀» 이 없다
    await put(SID(77), A, U("북어 국물 에 쌀 을 넣는 이야기", t(1)));            // «쌀» 도 있다
    for (const n of [76, 77]) await C.indexConvSession("", SID(n));
    const three = await search(A, "북어 국물 쌀");
    chk("D54 낱말 셋 중 한 글자(쌀)는 없어도 맞는 결과 — 있는 세션이 관련도에서 앞", matchIds(three).includes(SID(76)) && matchIds(three).includes(SID(77))
      && ids(three).indexOf(SID(77)) < ids(three).indexOf(SID(76)) && !three.results.find((x) => x.session_id === SID(76)).missing.length, JSON.stringify(three.results.map((x) => [x.session_id, x.tier, x.missing])));
    const two = await search(A, "북어 쌀");
    chk("D54 낱말이 둘뿐이면 한 글자도 있어야 한다(없는 세션은 맞는 결과가 아니다)", matchIds(two).includes(SID(77)) && !matchIds(two).includes(SID(76)), JSON.stringify(two.results.map((x) => [x.session_id, x.tier, x.missing])));

    //  D55 군말만 든 말은 훑지 않는다 — 군말(«방법»)이 다른 말에만 있어도 결과는 같다(맞는 결과 · 맞은 수는 있어야 하는 낱말이 든 말만 센다).
    await put(SID(78), A, U("청국장 띄우는 이야기", t(2)) + U("방법 을 알려 줘", t(3)) + U("방법 이 궁금해", t(4)));
    await C.indexConvSession("", SID(78));
    const fil = await search(A, "청국장 방법");
    const r78 = fil.results.find((x) => x.session_id === SID(78));
    chk("D55 군말만 든 말은 맞은 수에 들지 않는다 — 있어야 하는 낱말이 든 말 하나", !!r78 && r78.tier === "match" && r78.hits === 1, JSON.stringify(r78 && [r78.tier, r78.hits]));

    //  D57 다른 표기 · 느슨한 꼴은 사람이 한 말에만 댄다 — AI 만 «branch» 라고 쓴 세션은 «브랜치» 로 찾는 세션이 아니다(길고 많은 AI 의 말을
    //   꼴마다 훑지 않는다). 사람이 쓴 것은 대소문자와 상관없이 찾는다(글을 한 번 소문자로 바꿔 견준다).
    await put(SID(82), A, U("급한 수정 zqbr 이야기", t(8)) + AI("zqbr branch 를 만들었습니다", t(9)) + AI("zqbr branch 를 올렸습니다", t(9)) + AI("zqbr branch 끝", t(9)));
    await put(SID(83), A, U("zqbr Branch 하나 따 줘", t(10)) + U("이번엔 ZQCASE 값을 확인해 줘", t(11)));
    for (const n of [82, 83]) await C.indexConvSession("", SID(n));
    const ko = await search(A, "zqbr 브랜치");
    chk("D57 다른 표기는 사람 말에만 — AI 만 쓴 세션은 맞는 결과가 아니고, 사람이 (대문자를 섞어) 쓴 세션은 맞는 결과다", matchIds(ko).includes(SID(83)) && !matchIds(ko).includes(SID(82))
      && (ko.results.find((x) => x.session_id === SID(82))?.missing || []).includes("브랜치"), JSON.stringify(ko.results.map((x) => [x.session_id, x.tier, x.missing])));
    chk("D57 첫 지시가 아닌 말의 대문자 낱말도 소문자로 쳐서 찾는다", matchIds(await search(A, "zqcase")).includes(SID(83)));
    const en = await search(A, "zqbr branch");
    chk("D57 친 낱말 그대로는 AI 의 말에서도 찾는다(대소문자 무관)", matchIds(en).includes(SID(82)) && matchIds(en).includes(SID(83)), JSON.stringify(en.results.map((x) => [x.session_id, x.tier])));

    //  D56 뜻이 꽤 가까운(0.6 이상) 세션은 «덜 맞는 결과» 의 맨 앞 — 낱말 일부만 맞은 세션보다 앞. 그보다 먼 것은 끝.
    await put(SID(79), A, U("도토리묵 쑤는 이야기", t(5)));                    // 낱말 일부만(도토리묵) — 덜 맞는 결과
    await put(SID(80), A, U("뜻으로 아주 가까운 세션", t(6)));
    await put(SID(81), A, U("뜻으로 조금 가까운 세션", t(7)));
    for (const n of [79, 80, 81]) await C.indexConvSession("", SID(n));
    await plant(SID(80), { 21: 0.95, 22: Math.sqrt(1 - 0.95 * 0.95) });
    await plant(SID(81), { 21: 0.9, 23: Math.sqrt(1 - 0.9 * 0.9) });
    const near = await search(A, "도토리묵 양념장", { vec: { 21: 1 } });
    chk("D56 뜻이 꽤 가까운 세션(0.95 · 0.9)이 낱말 일부만 맞은 세션보다 앞 — 모두 덜 맞는 결과", ids(near).join() === [SID(80), SID(81), SID(79)].join() && near.results.every((x) => x.tier === "weak"), JSON.stringify(near.results.map((x) => [x.session_id, x.tier, x.sem ?? null])));
    await plant(SID(80), { 21: 0.58, 22: Math.sqrt(1 - 0.58 * 0.58) });
    await plant(SID(81), { 21: 0.55, 23: Math.sqrt(1 - 0.55 * 0.55) });
    const far = await search(A, "도토리묵 양념장", { vec: { 21: 1 } });
    chk("D56 그보다 먼 것(0.58 · 0.55)은 낱말 일부만 맞은 세션 뒤", ids(far).join() === [SID(79), SID(80), SID(81)].join(), JSON.stringify(far.results.map((x) => [x.session_id, x.tier, x.sem ?? null])));
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
