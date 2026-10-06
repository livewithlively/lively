// «이 대화의 지금 프로젝트»(#4553, session-log-store convProjectIdSql) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/v6/conv-project.pg-test.mjs
//
//  원준 2026-10-05 «ㅇㅇ 해결해» — 「기타 (미분류) 93」 가운데 72개는 세션 자체(박스)에는 프로젝트가 붙어 있는데 세션 이력 앱에서만
//   프로젝트 없음으로 나왔다. 실측(2026-10-06, 원준 계정): 그 72개 대화의 id 로 적힌 소속은 0건 — 한 번도 안 적혔다.
//
// 왜 이 계층인가: 판정이 SQL 식 하나이고 읽는 자리가 일곱이다(기록 목록 · 작업 일지 · 맞은 말 찾기의 이름과 거르개 · ⌘K 세션 찾기의
//  이름 셋과 번호로 찾기). 목 풀로는 식의 가지 하나를 지워도 초록이다. 실제 행을 넣고 **돌려받은 값**으로 판정한다.
//
// 엣지 표(행마다 시험 — 스크래치패드 spec-convproj.md):
//  P1 대화에 적힌 것이 박스보다 먼저 · P2 마지막이 «뗌» 이면 없음(박스를 보지 않는다) · P3 지금 그 대화를 돌리는 박스 ·
//  P4 대화 사슬로만 이어진 박스 · P5 박스 없음 · P6 박스에 프로젝트 없음 · P7 둘이면 늦게 본 쪽 · P8 늦게 본 쪽에 프로젝트가 없으면 이른 쪽 ·
//  P9 남의 박스 · P10 옛 계열(org) 번호 · P11 지워진 프로젝트를 가리키는 박스 · P12 대화 id 가 곧 박스 id · P13 기록의 주인이 비었다 ·
//  P14 본 시각이 같다(경계)
//  R1 기록 목록 · R2 작업 일지 · R3 맞은 말 찾기의 이름 · R4 맞은 말 찾기의 프로젝트 거르개 · R5 ⌘K 세션 찾기(이름 · 번호 · 뜻) · R6 배선
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const S = await import(`${DIST}/v6/session-log-store.js`);
const C = await import(`${DIST}/v6/conv-index-store.js`);
const JS = await import(`${DIST}/v6/session-journal-store.js`);
const { PRIMARY_TENANT_ID } = await import(`${DIST}/org/tenancy/registry.js`);
const { invalidateVisibilityCache } = await import(`${DIST}/v6/visibility.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const eq = (n, got, want) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
/** 세션 id → 값 표를 견준다(돌려받은 줄의 순서는 재지 않는다). */
const eqMap = (n, got, want) => eq(n, Object.entries(got).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), Object.entries(want).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const A = "__cpjpg_a__", B = "__cpjpg_b__";
const SID = (n) => `cpjpg-${n}`;
const BOX = (n) => `box-__cpjpg-${n}`;
const ALL = Array.from({ length: 60 }, (_, i) => SID(i));
const ALL_BOX = Array.from({ length: 60 }, (_, i) => BOX(i));
const PN = (s) => `__cpjpg_${s}__`;
/** 어느 프로젝트의 번호도 아닌 값 — «지워진 프로젝트를 가리키는 박스» 를 만든다(org_session_state.project_id 에는 FK 가 없다). */
const GONE = 2147480001;

const J = (o) => JSON.stringify(o) + "\n";
const NOW = Date.now();
const ago = (days, plusSec = 0) => new Date(NOW - days * 86_400_000 + plusSec * 1000).toISOString();
const U = (text, ts = ago(0)) => J({ type: "user", timestamp: ts, message: { role: "user", content: text } });

const q = (sql, params = []) => itemsPool.query(sql, params);
const one = async (sql, params = []) => (await q(sql, params)).rows[0];
async function put(sid, owner, text) {
  const r = await S.appendSessionLog({ nodeId: "", sessionId: sid, atOffset: await S.sessionLogWatermark("", sid), data: Buffer.from(text, "utf8"), harness: "claude", owner, parentSessionId: null });
  if (!r.ok) throw new Error(`append 실패 ${sid}: ${JSON.stringify(r)}`);
  await C.indexConvSession("", sid);
}
/** 박스 한 줄. conv = 그 박스가 지금 돌리는 대화(없으면 null) · seen = 마지막으로 살아 있는 것을 본 때. */
const box = (id, owner, conv, o = {}) => q(
  `INSERT INTO org_session_state(id, owner, project_id, project_src, claude_session_id, last_seen) VALUES($1,$2,$3,$4,$5,$6)`,
  [id, owner, o.projectId ?? null, o.projectId != null ? (o.src ?? "v6") : null, conv, o.seen ?? ago(0)]);
/** 대화 사슬 한 줄 — 그 박스가 그 대화를 돌렸다. */
const link = (boxId, conv, owner, last = ago(0)) => q(
  `INSERT INTO org_session_conv(box_id, conv_uuid, owner, first_seen, last_seen) VALUES($1,$2,$3,$4,$4)`, [boxId, conv, owner, last]);
const bind = (sid, pid, at) => q(`INSERT INTO session_project(session_id, project_id, valid_from) VALUES($1,$2,$3)`, [sid, pid, at]);
const project = async (name) => Number((await one(
  `INSERT INTO project(level, name, status, created_by) VALUES('project', $1, 'active', $2) RETURNING id`, [name, A])).id);

/** 식 그대로 — 기록 한 줄의 «지금 프로젝트» 번호. */
const projOf = async (sid) => {
  const r = await one(`SELECT ${S.convProjectIdSql()} AS pid FROM session s WHERE s.node_id = '' AND s.session_id = $1`, [sid]);
  if (!r) throw new Error(`기록이 없다: ${sid}`);
  return r.pid == null ? null : Number(r.pid);
};

async function cleanup() {
  for (const t of ["session_msg", "session_msg_cursor", "session_card", "session_log_chunk", "session_log", "session", "session_purged", "gw_session_map", "session_project"]) {
    await q(`DELETE FROM ${t} WHERE session_id = ANY($1::text[])`, [ALL]);
  }
  await q(`DELETE FROM org_session_conv WHERE box_id = ANY($1::text[]) OR box_id = ANY($2::text[])`, [ALL_BOX, ALL]);
  await q(`DELETE FROM org_session_state WHERE id = ANY($1::text[]) OR id = ANY($2::text[])`, [ALL_BOX, ALL]);
  await q(`DELETE FROM project WHERE name LIKE '\\_\\_cpjpg\\_%' ESCAPE '\\'`);
}

try {
  await cleanup();
  invalidateVisibilityCache();
  const PA = await project(PN("a")), PB = await project(PN("b")), PC = await project(PN("c"));
  const nameOf = { [PA]: PN("a"), [PB]: PN("b"), [PC]: PN("c") };

  // ── 재료: 기록마다 낱말 「코뿔소」 하나(찾기가 전부를 후보로 삼게) ─────────────────────────────────────
  const CONVS = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19];
  for (const n of CONVS) await put(SID(n), A, U(`코뿔소 ${n}번 대화`, ago(2, n)));

  // P1 — 대화에 A 가 적혀 있고 박스는 B.
  await bind(SID(1), PA, ago(6));
  await box(BOX(1), A, SID(1), { projectId: PB });
  // P2 — 대화에 A 가 적혔다가 떼였고(마지막 = 뗌) 박스는 B.
  await bind(SID(2), PA, ago(6)); await bind(SID(2), null, ago(5));
  await box(BOX(2), A, SID(2), { projectId: PB });
  // P3 — 한 번도 안 적혔고, 지금 이 대화를 돌리는 박스가 B.
  await box(BOX(3), A, SID(3), { projectId: PB });
  // P4 — 한 번도 안 적혔고, 박스는 다른 대화로 갈아탔다(대화 사슬로만 이어진다).
  await box(BOX(4), A, "cpjpg-other-conv", { projectId: PB });
  await link(BOX(4), SID(4), A, ago(3));
  // P5 — 박스 없음.  P6 — 박스에 프로젝트 없음.
  await box(BOX(6), A, SID(6));
  // P7 — 둘: 늦게 본 쪽(B)이 박스 id 로는 뒤다 — id 순으로 고르면 C 가 나온다. 한쪽은 «지금 대화», 한쪽은 대화 사슬.
  await box(BOX(27), A, "cpjpg-other-conv-7", { projectId: PC }); await link(BOX(27), SID(7), A, ago(3));
  await box(BOX(28), A, SID(7), { projectId: PB, seen: ago(1) });
  // P8 — 둘: 늦게 본 쪽은 프로젝트가 없고 이른 쪽이 C.
  await box(BOX(29), A, SID(9), { seen: ago(1) });
  await box(BOX(30), A, "cpjpg-other-conv-9", { projectId: PC }); await link(BOX(30), SID(9), A, ago(4));
  // P9 — 남(B)이 끼어든 연결. ① 박스도 사슬도 B 의 것 ② 사슬은 A 이름으로 적혔지만 박스의 주인은 B
  //  ③ 박스는 A 의 것인데 사슬을 B 가 적었다(남이 내 박스에 내 다른 대화를 매달았다).
  await box(BOX(10), B, SID(10), { projectId: PB }); await link(BOX(10), SID(10), B, ago(1));
  await box(BOX(11), B, "cpjpg-other-conv-11", { projectId: PB }); await link(BOX(11), SID(11), A, ago(1));
  await box(BOX(19), A, "cpjpg-other-conv-19", { projectId: PB }); await link(BOX(19), SID(19), B, ago(1));
  // P10 — 박스의 번호가 옛 계열(org) 프로젝트의 것(우연히 B 의 번호와 같다).
  await box(BOX(12), A, SID(12), { projectId: PB, src: "org" });
  // P11 — 늦게 본 박스가 지워진 프로젝트를 가리키고 이른 박스가 C / 하나뿐인 박스가 지워진 프로젝트.
  await box(BOX(31), A, SID(13), { projectId: GONE, seen: ago(1) });
  await box(BOX(32), A, "cpjpg-other-conv-13", { projectId: PC }); await link(BOX(32), SID(13), A, ago(4));
  await box(BOX(14), A, SID(14), { projectId: GONE });
  // P12 — 대화 id 가 곧 박스 id(노드 세션 · 옛 경로).
  await box(SID(15), A, null, { projectId: PB });
  // P13 — 기록의 주인이 비었다(옛 행). 박스는 A 의 것이고 B 가 붙어 있다.
  await box(BOX(16), A, SID(16), { projectId: PB });
  await q(`UPDATE session SET owner = NULL WHERE node_id = '' AND session_id = $1`, [SID(16)]);
  // P14 — 두 박스가 그 대화를 본 시각이 같다(대화 사슬 둘 · 같은 시각). id 가 앞인 쪽이 B.
  const SAME = ago(2);
  await box(BOX(33), A, "cpjpg-other-conv-17a", { projectId: PB }); await link(BOX(33), SID(17), A, SAME);
  await box(BOX(34), A, "cpjpg-other-conv-17b", { projectId: PC }); await link(BOX(34), SID(17), A, SAME);

  // ══ P. 판정(식 그대로) ═══════════════════════════════════════════════════════════════════
  eq("P1 대화에 적힌 소속이 박스보다 먼저다", await projOf(SID(1)), PA);
  eq("P2 마지막이 «뗌» 이면 프로젝트 없음 — 박스로 넘어가지 않는다(#1867)", await projOf(SID(2)), null);
  eq("P3 한 번도 안 적혔으면 지금 그 대화를 돌리는 박스의 프로젝트", await projOf(SID(3)), PB);
  eq("P4 박스가 다른 대화로 갈아탔어도 대화 사슬로 이어진다", await projOf(SID(4)), PB);
  eq("P5 박스가 없으면 없음", await projOf(SID(5)), null);
  eq("P6 박스에 프로젝트가 없으면 없음", await projOf(SID(6)), null);
  eq("P7 박스가 둘이면 그 대화를 늦게 본 쪽(박스 id 순이 아니다)", await projOf(SID(7)), PB);
  eq("P8 늦게 본 박스에 프로젝트가 없으면 프로젝트가 붙은 이른 박스", await projOf(SID(9)), PC);
  eq("P9 남의 박스가 내 대화를 가리켜도 읽지 않는다(박스도 사슬도 남의 것)", await projOf(SID(10)), null);
  eq("P9 사슬이 내 이름으로 적혔어도 박스의 주인이 남이면 읽지 않는다", await projOf(SID(11)), null);
  eq("P9 내 박스여도 남이 적은 사슬로는 읽지 않는다", await projOf(SID(19)), null);
  eq("P10 옛 계열(org) 프로젝트의 번호는 읽지 않는다", await projOf(SID(12)), null);
  eq("P11 지워진 프로젝트를 가리키는 박스는 건너뛴다 — 다른 박스의 프로젝트", await projOf(SID(13)), PC);
  eq("P11 그 박스뿐이면 없음", await projOf(SID(14)), null);
  eq("P12 대화 id 가 곧 박스 id 인 세션", await projOf(SID(15)), PB);
  eq("P13 기록의 주인이 비었으면 박스를 읽지 않는다", await projOf(SID(16)), null);
  eq("P14 본 시각이 같으면 박스 id 순 — 매번 같은 답", [await projOf(SID(17)), await projOf(SID(17))], [PB, PB]);
  //  대조: 박스로 읽던 대화에 소속이 적히면(세션을 옮김 · 기록을 올림) 그때부터는 적힌 것이 이긴다 — 뗌도 마찬가지.
  await put(SID(18), A, U("코뿔소 18번 대화", ago(2, 18)));
  await box(BOX(18), A, SID(18), { projectId: PB });
  eq("P3 대조: 적히기 전에는 박스의 것", await projOf(SID(18)), PB);
  await bind(SID(18), PC, ago(1));
  eq("P1 대조: 적힌 뒤에는 적힌 것", await projOf(SID(18)), PC);
  await bind(SID(18), null, ago(0.5));
  eq("P2 대조: 뗀 뒤에는 없음", await projOf(SID(18)), null);

  // ══ R. 읽는 자리 ═════════════════════════════════════════════════════════════════════════
  //  기대 — 주인이 A 인 기록 전부(16번은 주인이 비어 A 의 목록에 없다 — 그 줄은 위 P13 이 식으로 잰다).
  const WANT = { 1: PA, 2: null, 3: PB, 4: PB, 5: null, 6: null, 7: PB, 9: PC, 10: null, 11: null, 12: null, 13: PC, 14: null, 15: PB, 17: PB, 18: null, 19: null };
  const wantIds = Object.fromEntries(Object.entries(WANT).map(([n, p]) => [SID(n), p]));
  const wantNames = Object.fromEntries(Object.entries(WANT).map(([n, p]) => [SID(n), p == null ? null : nameOf[p]]));
  const mine = (rows) => rows.filter((x) => ALL.includes(x.session_id));

  // R1 기록 목록
  const list = mine(await S.listSessionsForOwner(A, 2000, PRIMARY_TENANT_ID));
  eqMap("R1 기록 목록 — 줄마다 프로젝트 번호", Object.fromEntries(list.map((x) => [x.session_id, x.project_id == null ? null : Number(x.project_id)])), wantIds);
  eqMap("R1 기록 목록 — 줄마다 프로젝트 이름", Object.fromEntries(list.map((x) => [x.session_id, x.project_name ?? null])), wantNames);

  // R2 작업 일지
  const jr = mine((await JS.sessionJournal({ owner: A, workspaceId: PRIMARY_TENANT_ID })).rows);
  eqMap("R2 작업 일지 — 줄마다 프로젝트 번호", Object.fromEntries(jr.map((x) => [x.session_id, x.project_id])), wantIds);
  eqMap("R2 작업 일지 — 줄마다 프로젝트 이름", Object.fromEntries(jr.map((x) => [x.session_id, x.project_name])), wantNames);

  // R3 · R4 맞은 말 찾기
  const find = (o = {}) => C.searchConvMessages({ requester: A, q: "코뿔소", attach: true, workspaceId: PRIMARY_TENANT_ID, limit: 100, since: null, role: null, projectId: o.projectId ?? null });
  const sids = (r) => [...new Set(r.hits.map((h) => h.session_id))].sort();
  const withProj = (p) => Object.entries(WANT).filter(([, v]) => v === p).map(([n]) => SID(n)).sort();
  const all = await find();
  eqMap("R3 맞은 말 찾기 — 줄마다 프로젝트 이름", Object.fromEntries(all.hits.map((h) => [h.session_id, h.project])), wantNames);
  eq("R4 프로젝트 거르개 = B → 박스로 읽은 대화까지 잡힌다", sids(await find({ projectId: PB })), withProj(PB));
  eq("R4 프로젝트 거르개 = C", sids(await find({ projectId: PC })), withProj(PC));
  eq("R4 프로젝트 거르개 = A(대화에 적힌 것)", sids(await find({ projectId: PA })), withProj(PA));
  eq("R4 «프로젝트 없음» 거르개 → 박스로 읽은 대화는 빠지고 뗀 대화 · 박스 없는 대화는 남는다", sids(await find({ projectId: 0 })), withProj(null));

  // R5 ⌘K 세션 찾기 — 이름(글자로 맞은 줄) · 번호로 찾기 · 뜻으로 찾기
  const search = (text, o = {}) => C.searchConversations({
    requester: A, q: text, sort: "relevance", since: null, limit: 100, workspaceId: PRIMARY_TENANT_ID, attach: true, semantic: o.vec ? { vec: o.vec } : "off" });
  const byWord = await search("코뿔소");
  eqMap("R5 ⌘K 글자로 찾기 — 줄마다 프로젝트 이름", Object.fromEntries(byWord.results.map((x) => [x.session_id, x.project])), wantNames);
  const numHit = (r) => r.results.filter((x) => x.nums.length).map((x) => x.session_id).sort();
  const byB = await search(String(PB));
  eq("R5 ⌘K 번호(B)로 찾기 → B 로 읽히는 대화 전부(박스로 읽은 것까지)", numHit(byB), withProj(PB));
  eq("R5 ⌘K 번호로 온 줄의 프로젝트 이름", [...new Set(byB.results.filter((x) => x.nums.length).map((x) => x.project))], [nameOf[PB]]);
  eq("R5 ⌘K 번호(A)로 찾기 → 뗀 대화(2번)는 안 잡힌다", numHit(await search(String(PA))), withProj(PA));
  eq("R5 ⌘K 번호(C)로 찾기", numHit(await search("#" + PC)), withProj(PC));
  //  뜻으로 찾기 — 3번(박스로 읽는 대화)과 2번(뗀 대화)에 같은 방향의 카드를 심는다.
  const vec = (i) => { const a = new Array(1024).fill(0); a[i] = 1; return a; };
  for (const n of [2, 3]) await q(
    `INSERT INTO session_card(node_id, session_id, card_id, card, src_bytes, ver, embedding_vector) VALUES('', $1, $2, '심은 카드', 1, 1, $3::vector)
     ON CONFLICT (tenant_id, node_id, session_id) DO UPDATE SET card = EXCLUDED.card, embedding_vector = EXCLUDED.embedding_vector`, [SID(n), "|" + SID(n), "[" + vec(7).join(",") + "]"]);
  const bySem = await search("하마", { vec: vec(7) });
  const sem = Object.fromEntries(bySem.results.filter((x) => x.sem != null).map((x) => [x.session_id, x.project]));
  eqMap("R5 ⌘K 뜻으로 온 줄의 프로젝트 이름", sem, { [SID(2)]: null, [SID(3)]: nameOf[PB] });

  // R6 배선 — 읽는 자리가 전부 같은 식을 쓴다 · 시험이 실제 행으로 돌았다.
  const src = (f) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
  const OLD = /FROM\s*\(\s*SELECT\s+sp\.project_id\s+FROM\s+session_project\s+sp/;
  for (const f of ["session-log-store.ts", "session-journal-store.ts", "conv-index-store.ts"]) {
    const text = src(f);
    chk(`R6 ${f} — «대화에 적힌 것만 읽는» 옛 조회가 남아 있지 않다`, !OLD.test(text), "옛 조회가 남아 있다");
    chk(`R6 ${f} — 같은 식(convProjectIdSql)을 쓴다`, /\$\{convProjectIdSql\(/.test(text) || /= convProjectIdSql\(/.test(text), "식을 쓰는 자리가 없다");
  }
  eq("R6 시험이 실제 행으로 돌았다 — 목록 · 일지 · 찾기가 돌려준 줄 수", [list.length, jr.length, all.hits.length, byWord.results.length], [17, 17, 17, 17]);
} catch (e) {
  bad("예외", (e && e.stack) || String(e));
} finally {
  await cleanup().catch((e) => console.error("cleanup 실패:", e?.message));
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
