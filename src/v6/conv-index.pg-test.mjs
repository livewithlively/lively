// ⌘K 대화 검색 색인·검색(#4517) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/conv-index.pg-test.mjs
//
// 왜 이 계층인가: 이 기능의 약속은 전부 SQL 조건이다 — «사람 말·AI 말만 행이 된다» · «줄 경계에서만 이어 읽는다» ·
//  «같은 창을 두 번 담지 않는다(CAS)» · «주인과 초대받은 사람만 찾는다» · «지운 대화는 색인도 사라진다». 목 풀로는
//  조건 하나를 지워도 초록이다. 그래서 **부작용을 SELECT 로 되읽어** 판정한다(session_msg 행 · 커서 · 검색 결과 id).
//
//  사양·엣지 표: 스크래치패드 spec.md E — D1~D15.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const S = await import(`${DIST}/v6/session-log-store.js`);
const C = await import(`${DIST}/v6/conv-index-store.js`);
const { PRIMARY_TENANT_ID } = await import(`${DIST}/org/tenancy/registry.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__convpg_a__", B = "__convpg_b__";
const SID = (n) => `convpg-${n}`;
const BOX = (n) => `box-__convpg-${n}`;
const ALL = Array.from({ length: 20 }, (_, i) => SID(i));
const ALL_BOX = Array.from({ length: 20 }, (_, i) => BOX(i));

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
});
const ids = (r) => r.results.map((x) => x.session_id);

async function cleanup() {
  for (const t of ["session_msg", "session_msg_cursor", "session_log_chunk", "session_log", "session", "session_purged"]) {
    await itemsPool.query(`DELETE FROM ${t} WHERE session_id = ANY($1::text[])`, [ALL]);
  }
  await itemsPool.query(`DELETE FROM org_session_conv WHERE box_id = ANY($1::text[])`, [ALL_BOX]);
  await itemsPool.query(`DELETE FROM org_session_state WHERE id = ANY($1::text[])`, [ALL_BOX]);
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

  // ── D4 창보다 긴 한 줄 — 건너뛰고 그 뒤를 이어 읽는다 ──
  {
    const giant = AI("거대한 " + "가".repeat(40_000));   // UTF-8 약 120KB — 창(64KB)보다 길다
    await put(SID(4), A, U("앞 말 검색") + giant + U("뒤 말 검색"));
    await C.indexConvSession("", SID(4), 64 * 1024 * 1024, 64 * 1024);
    const m = await msgs(SID(4));
    chk("D4 긴 줄 뒤의 말이 담긴다(긴 줄 자체는 건너뛴다 — 창보다 긴 줄)",
      m.map((x) => x.body).join("|") === "앞 말 검색|뒤 말 검색", JSON.stringify(m.map((x) => x.body.slice(0, 12))));
    chk("D4 커서가 끝까지 간다(긴 줄에서 멈추지 않는다)", Number(await cursorOf(SID(4))) === await wm(SID(4)));
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
    const rec = ids(await search(A, "코끼리 달리기", { sort: "recent" }));
    chk("D15 관련도순은 구절이 그대로 맞은 옛 세션이 먼저", rel[0] === SID(13) && rel[1] === SID(14), JSON.stringify(rel));
    chk("D15 최신순은 맞은 말이 늦은 세션이 먼저", rec[0] === SID(14) && rec[1] === SID(13), JSON.stringify(rec));
    const hit = (await search(A, "코끼리 달리기")).results[0];
    chk("D15 줄에 이름·대표 말·시각이 실린다", !!hit.name && hit.best.role === "user" && hit.best.text.includes("코끼리") && typeof hit.at === "string", JSON.stringify(hit));
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
