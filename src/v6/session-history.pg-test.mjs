// 「세션 이력」 앱(#4553)의 두 저장 경로 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/v6/session-history.pg-test.mjs
//
//  원준 2026-10-04: «그 A,B,C안을 그거 들어간 다음에 위에 상위 가로탭으로 만들어가지고 셋 다 구현해.»
//   · 맞은 말 단위 검색(conv-index-store searchConvMessages) — 「대화 찾기」 탭
//   · 작업 일지(session-journal-store sessionJournal) — 「작업 일지」 탭 · 「이 세션이 남긴 것」
//
// 왜 이 계층인가: 두 경로의 약속은 전부 SQL 조건이다 — «볼 수 있는 세션의 말만» · «휴지통·다른 워크스페이스·자동 실행 세션은
//  뺀다» · «기간 경계» · «가려진 프로젝트의 이름을 싣지 않는다» · «앞뒤 말은 대화 순서의 바로 옆 말». 목 풀로는 조건 하나를 지워도
//  초록이다. 그래서 실제 행을 넣고 **돌려받은 줄**로 판정한다.
//
// 엣지 표(행마다 시험 하나 — 스크래치패드 spec.md B · C):
//  M1 한 세션의 맞은 말 셋 = 줄 셋 · M2 앞뒤 말(고친 파일 행은 건너뛴다) · M3 첫 말·마지막 말의 앞뒤는 null · M4 말한 쪽 · M5 기간 ·
//  M6 프로젝트 · M7 프로젝트 없음(0) · M8 남의 세션 · M9 초대받은 세션(attach) · M10 가려진 프로젝트의 초대 세션(총계에도 없음) ·
//  M11 휴지통 · M12 다른 워크스페이스 · M13 고친 파일 행에만 든 낱말 · M14 낱말 둘 — 둘 다 든 말 먼저 · M15 limit=1(경계값) ·
//  M16 세션 상한 · M17 빈 검색어 · M18 서브에이전트·작업 상자
//  J1 작업 기록 · J2 산출 지식만 · J3 맡은 태스크 · J4 남의 세션 · J5 휴지통(대화·박스 표식 · 남의 표식은 무관) · J6 기간 경계 · J7 갈아탄 대화 ·
//  J8 목록 밖 형제 대화의 기록 · J9 연결이 빈 세션 · J10 질문 수·고친 파일 수 · J11 가려진 프로젝트 · J12 다른 워크스페이스 ·
//  J13 limit=1 + truncated · J14 서브에이전트·작업 상자 · J15 사람이 지은 이름 · J16 잠긴 지식 · J17 기간 안에 적은 기록만 · J18 시간 상한
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const S = await import(`${DIST}/v6/session-log-store.js`);
const C = await import(`${DIST}/v6/conv-index-store.js`);
const JS = await import(`${DIST}/v6/session-journal-store.js`);
const { PRIMARY_TENANT_ID } = await import(`${DIST}/org/tenancy/registry.js`);
const { PROJECT_SHARED_BASE, PROJECT_SUBDIR } = await import(`${DIST}/project/project-fs.js`);
const { invalidateVisibilityCache } = await import(`${DIST}/v6/visibility.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const eq = (n, got, want) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

const A = "__shxpg_a__", B = "__shxpg_b__";
const SID = (n) => `shxpg-${n}`;
const BOX = (n) => `box-__shxpg-${n}`;
const ALL = Array.from({ length: 60 }, (_, i) => SID(i));
const ALL_BOX = Array.from({ length: 60 }, (_, i) => BOX(i));
const W2 = "00000000-0000-4000-8000-00000000d0a2";
const LIST_NAME = "__shxpg_hidden_list__";
const PN = (s) => `__shxpg_${s}__`;
const KN = (s) => `shxpg-k-${s}`;

const J = (o) => JSON.stringify(o) + "\n";
const NOW = Date.now();
const ago = (days, plusSec = 0) => new Date(NOW - days * 86_400_000 + plusSec * 1000).toISOString();
const U = (text, ts = ago(0)) => J({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const AI = (text, ts = ago(0)) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
const AE = (file, ts = ago(0)) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] } });

const wm = (sid) => S.sessionLogWatermark("", sid);
async function put(sid, owner, text, parent = null) {
  const r = await S.appendSessionLog({ nodeId: "", sessionId: sid, atOffset: await wm(sid), data: Buffer.from(text, "utf8"), harness: "claude", owner, parentSessionId: parent });
  if (!r.ok) throw new Error(`append 실패 ${sid}: ${JSON.stringify(r)}`);
  await C.indexConvSession("", sid);
}
const q = (sql, params = []) => itemsPool.query(sql, params);
const one = async (sql, params = []) => (await q(sql, params)).rows[0];
const seen = (sid, first, last) => q(`UPDATE session SET first_seen=$2, last_seen=$3 WHERE node_id='' AND session_id=$1`, [sid, first, last]);
const box = (n, owner, conv, o = {}) => q(
  `INSERT INTO org_session_state(id, owner, invites, project_id, dir, label, label_source, claude_session_id) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8)`,
  [BOX(n), owner, JSON.stringify(o.invites ?? []), o.projectId ?? null, o.dir ?? null, o.label ?? null, o.labelSource ?? null, o.noState ? null : conv]);
const convLink = (n, conv, owner, first = ago(1), last = ago(0)) => q(
  `INSERT INTO org_session_conv(box_id, conv_uuid, owner, first_seen, last_seen) VALUES($1,$2,$3,$4,$5)`, [BOX(n), conv, owner, first, last]);
const activity = async (boxId, title, at, o = {}) => Number((await one(
  `INSERT INTO activity(type, title, summary, session_id, author_person, commit_sha, created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [o.type ?? "feature", title, o.summary ?? null, boxId, o.who ?? A, o.commit ?? null, at])).id);
const project = async (name, o = {}) => Number((await one(
  `INSERT INTO project(level, name, status, created_by, list_id, parent_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
  [o.level ?? "project", name, o.status ?? (o.level && o.level !== "project" ? "todo" : "active"), A, o.listId ?? null, o.parentId ?? null])).id);

const find = (requester, text, o = {}) => C.searchConvMessages({
  requester, q: text, attach: o.attach ?? true, workspaceId: PRIMARY_TENANT_ID, limit: o.limit ?? 50,
  since: o.since ?? null, role: o.role ?? null, projectId: o.projectId ?? null, ...(o.cap ? { sessionCap: o.cap } : {}),
});
const sids = (r) => [...new Set(r.hits.map((h) => h.session_id))].sort();
const texts = (r) => r.hits.map((h) => h.text);
const journal = (owner, o = {}) => JS.sessionJournal({ owner, workspaceId: PRIMARY_TENANT_ID, ...o });
const rowOf = (r, sid) => r.rows.find((x) => x.session_id === sid);

async function cleanup() {
  for (const t of ["session_msg", "session_msg_cursor", "session_log_chunk", "session_log", "session", "session_purged", "gw_session_map", "session_project"]) {
    await q(`DELETE FROM ${t} WHERE session_id = ANY($1::text[])`, [ALL]);
  }
  await q(`DELETE FROM org_session_trash WHERE session_id = ANY($1::text[]) OR session_id = ANY($2::text[])`, [ALL, ALL_BOX]);
  await q(`DELETE FROM org_session_conv WHERE box_id = ANY($1::text[])`, [ALL_BOX]);
  await q(`DELETE FROM org_session_state WHERE id = ANY($1::text[])`, [ALL_BOX]);
  await q(`DELETE FROM execution_session_task WHERE session_id = ANY($1::text[])`, [ALL_BOX]);
  await q(`DELETE FROM execution_session WHERE id = ANY($1::text[])`, [ALL_BOX]);
  await q(`DELETE FROM activity WHERE session_id = ANY($1::text[]) OR session_id = ANY($2::text[])`, [ALL_BOX, ALL]);   // activity_knowledge 는 CASCADE
  await q(`DELETE FROM knowledge WHERE name LIKE 'shxpg-k-%'`);
  await q(`DELETE FROM gw_workspace WHERE id = $1::uuid`, [W2]);
  await q(`DELETE FROM project WHERE name LIKE '\\_\\_shxpg\\_%' ESCAPE '\\'`);
  await q(`DELETE FROM project_list WHERE name = $1`, [LIST_NAME]);
}

try {
  await cleanup();
  invalidateVisibilityCache();
  const HIDDEN_LIST = Number((await one(`INSERT INTO project_list(name, visibility) VALUES($1, 'members') RETURNING id`, [LIST_NAME])).id);
  const P_OPEN = await project(PN("open"));
  const P_HIDDEN = await project(PN("hidden"), { listId: HIDDEN_LIST });
  const dirOf = (pid) => `${PROJECT_SHARED_BASE}/${PROJECT_SUBDIR}/${pid}`;

  // ══ 맞은 말 단위 검색 ═════════════════════════════════════════════════════════════════════
  // 세션 1(A · 프로젝트 없음): 사람 → AI → (파일 고침) → 사람 → AI. 「얼룩말」이 셋.
  //  ⚠ 세 번에 나눠 올린다 — 색인은 올릴 때마다 새 창(at_offset)으로 담는다. 한 번에 올리면 모든 말의 at_offset 이 같아
  //   «대화 순서 = (at_offset, idx)» 의 앞 칸을 틀리게 써도 초록이다(변이로 확인: 한 창짜리 픽스처에선 살아남았다).
  await put(SID(1), A, U("얼룩말 하나를 찾아 줘", ago(3, 0)));
  await put(SID(1), A, AI("얼룩말 둘째 대답", ago(3, 10)) + AE("/work/app/src/낙타.ts", ago(3, 20)));
  await put(SID(1), A, U("그냥 다른 말", ago(3, 30)) + AI("마지막 얼룩말 셋째", ago(3, 40)));
  {
    const r = await find(A, "얼룩말");
    eq("M1 한 세션의 맞은 말 셋은 줄 셋이다(세션당 한 줄이 아니다) · 늦은 말부터", texts(r), ["마지막 얼룩말 셋째", "얼룩말 둘째 대답", "얼룩말 하나를 찾아 줘"]);
    eq("M1 총계 — 맞은 말 3 · 세션 1 · 색칠할 낱말", [r.total, r.sessions, r.capped, r.words], [3, 1, false, ["얼룩말"]]);
    const mid = r.hits.find((h) => h.text === "얼룩말 둘째 대답");
    eq("M2 앞뒤 말은 대화 순서의 바로 옆 말 — 사이의 고친 파일 행은 건너뛴다", [mid.before?.text, mid.before?.role, mid.after?.text, mid.after?.role], ["얼룩말 하나를 찾아 줘", "user", "그냥 다른 말", "user"]);
    const first = r.hits.find((h) => h.text === "얼룩말 하나를 찾아 줘"), last = r.hits.find((h) => h.text === "마지막 얼룩말 셋째");
    eq("M3 첫 말의 앞 · 마지막 말의 뒤는 null", [first.before, first.after?.text, last.before?.text, last.after], [null, "얼룩말 둘째 대답", "그냥 다른 말", null]);
    const other = (await find(A, "그냥")).hits[0];
    eq("M2 앞 말은 바로 앞 창의 말이다(더 앞 창의 말이 아니다) · 창 안의 고친 파일 행은 건너뛴다", [other.before?.text, other.after?.text], ["얼룩말 둘째 대답", "마지막 얼룩말 셋째"]);
    eq("M1 줄마다 세션 좌표와 말한 쪽·시각이 실린다", [last.node_id, last.session_id, last.role, last.ts, last.project], ["", SID(1), "assistant", ago(3, 40), null]);
    eq("M1 화면이 그리는 칸만 싣는다(주인·프로젝트 id 같은 메타 없음)", Object.keys(last).sort(), ["after", "before", "name", "node_id", "project", "role", "session_id", "terms", "text", "ts"]);
    const u = await find(A, "얼룩말", { role: "user" });
    eq("M4 말한 쪽=사람 — 그쪽 말만 · 총계도 그쪽만", [texts(u), u.total], [["얼룩말 하나를 찾아 줘"], 1]);
    const a = await find(A, "얼룩말", { role: "assistant" });
    eq("M4 말한 쪽=AI", [texts(a), a.total], [["마지막 얼룩말 셋째", "얼룩말 둘째 대답"], 2]);
    const s = await find(A, "얼룩말", { since: ago(3, 15) });
    eq("M5 기간 — 그 시각 이후의 말만", [texts(s), s.total], [["마지막 얼룩말 셋째"], 1]);
    const edge = await find(A, "얼룩말", { since: ago(3, 40) });
    eq("M5 기간 경계 — 시각이 같은 말은 든다", texts(edge), ["마지막 얼룩말 셋째"]);
    eq("M13 고친 파일 행에만 든 낱말은 말이 아니다 — 안 나온다", (await find(A, "낙타")).hits.length, 0);
  }
  // 세션 2(A · 열린 프로젝트)
  await put(SID(2), A, U("프로젝트 안의 얼룩말", ago(2)));
  await q(`INSERT INTO session_project(session_id, project_id) VALUES($1, $2)`, [SID(2), P_OPEN]);
  {
    const p = await find(A, "얼룩말", { projectId: P_OPEN });
    eq("M6 프로젝트 — 그 프로젝트에 붙은 세션의 말만 · 이름이 실린다", [sids(p), p.total, p.hits[0].project], [[SID(2)], 1, PN("open")]);
    const none = await find(A, "얼룩말", { projectId: 0 });
    eq("M7 프로젝트 없음(0) — 프로젝트에 안 붙은 세션의 말만", [sids(none), none.total], [[SID(1)], 3]);
    eq("M6 대조: 거르개가 없으면 둘 다", sids(await find(A, "얼룩말")), [SID(1), SID(2)]);
  }
  // 프로젝트를 옮긴 세션 · 프로젝트에서 뗀 세션 — 거르개는 «지금 붙어 있는 프로젝트»(마지막 구간)를 본다
  {
    const P_NEXT = await project(PN("next"));
    await put(SID(11), A, U("옮긴 세션의 기러기", ago(2)));
    await q(`INSERT INTO session_project(session_id, project_id, valid_from) VALUES($1,$2,$3), ($1,$4,$5)`, [SID(11), P_OPEN, ago(6), P_NEXT, ago(5)]);
    await put(SID(12), A, U("뗀 세션의 기러기", ago(2)));
    await q(`INSERT INTO session_project(session_id, project_id, valid_from) VALUES($1,$2,$3), ($1,NULL,$4)`, [SID(12), P_OPEN, ago(6), ago(5)]);
    eq("M6 옮긴 세션은 옛 프로젝트로는 안 나오고(뗀 세션도) 새 프로젝트로 나온다", [sids(await find(A, "기러기", { projectId: P_OPEN })), sids(await find(A, "기러기", { projectId: P_NEXT }))], [[], [SID(11)]]);
    eq("M7 프로젝트에서 뗀 세션(마지막 구간이 없음)은 「프로젝트 없음」이다", sids(await find(A, "기러기", { projectId: 0 })), [SID(12)]);
    const moved = (await find(A, "기러기")).hits.find((h) => h.session_id === SID(11));
    eq("M6 줄의 프로젝트 이름도 지금 붙어 있는 프로젝트", moved.project, PN("next"));
  }
  // 남의 세션 · 초대받은 세션 · 가려진 프로젝트의 초대 세션
  await put(SID(3), B, U("B 혼자 쓰는 얼룩말", ago(1)));
  //  ⚠ 초대받은 두 세션(4 · 5)의 말 시각을 다르게 둔다 — 같으면 «늦게 맞은 세션부터 상한까지» 의 순서가 정해지지 않아
  //   M16(상한 1)이 어느 쪽을 집느냐에 따라 흔들린다(stage 판에서 실제로 가려진 쪽을 집어 빨갰다).
  await put(SID(4), B, U("B 가 A 를 초대한 얼룩말", ago(1, 60)));
  await box(4, B, SID(4), { invites: [A] }); await convLink(4, SID(4), B);
  await put(SID(5), B, U("가려진 프로젝트의 얼룩말", ago(1)));
  await box(5, B, SID(5), { invites: [A], projectId: P_HIDDEN, dir: dirOf(P_HIDDEN) }); await convLink(5, SID(5), B);
  invalidateVisibilityCache();
  {
    const r = await find(A, "얼룩말");
    chk("M8 초대 안 받은 남의 세션의 말은 안 나온다", !sids(r).includes(SID(3)), JSON.stringify(sids(r)));
    chk("M9 초대받은 세션(attach)의 말은 나온다", sids(r).includes(SID(4)), JSON.stringify(sids(r)));
    chk("M9 view_policy 가 attach 가 아니면 초대받아도 안 나온다", !sids(await find(A, "얼룩말", { attach: false })).includes(SID(4)));
    chk("M10 초대받았어도 가려진 프로젝트의 세션은 안 나온다", !sids(r).includes(SID(5)), JSON.stringify(sids(r)));
    eq("M10 총계에도 세지 않는다(내 것 3+1 · 초대 1)", [r.total, r.sessions], [5, 3]);
    chk("M10 대조: 주인은 자기 세션을 찾는다", sids(await find(B, "얼룩말")).includes(SID(5)));
  }
  // 휴지통 · 다른 워크스페이스 · 서브에이전트 · 작업 상자
  await put(SID(6), A, U("휴지통에 간 얼룩말", ago(1)));
  await q(`INSERT INTO org_session_trash(session_id, owner) VALUES($1, $2)`, [SID(6), A]);
  await q(`INSERT INTO gw_workspace(id, slug, name, owner_member, state) VALUES($1, 'shxpg-w2', 'w2', $2, 'active')`, [W2, A]);
  await put(SID(7), A, U("다른 워크스페이스의 얼룩말", ago(1)));
  await q(`INSERT INTO gw_session_map(session_id, workspace_id) VALUES($1, $2)`, [SID(7), W2]);
  await put(SID(8), A, U("서브에이전트의 얼룩말", ago(1)), SID(1));
  await put(SID(9), A, U("작업 상자의 얼룩말", ago(1)));
  await q(`UPDATE session SET run_kind='task' WHERE node_id='' AND session_id=$1`, [SID(9)]);
  {
    const got = sids(await find(A, "얼룩말"));
    chk("M11 휴지통 세션의 말은 안 나온다", !got.includes(SID(6)), JSON.stringify(got));
    chk("M12 다른 워크스페이스 세션의 말은 안 나온다", !got.includes(SID(7)), JSON.stringify(got));
    chk("M18 서브에이전트·작업 상자 세션의 말은 안 나온다", !got.includes(SID(8)) && !got.includes(SID(9)), JSON.stringify(got));
    eq("M11·M12·M18 대조: 남은 것은 내 둘 + 초대 하나", got, [SID(1), SID(2), SID(4)]);
  }
  // 낱말 둘 · 한 줄 상한 · 세션 상한 · 빈 검색어
  await put(SID(10), A, U("코끼리와 하마가 함께 든 옛 말", ago(20)) + U("코끼리만 든 새 말", ago(0)));
  {
    const r = await find(A, "코끼리 하마");
    eq("M14 낱말 둘 — 둘 다 든 말이 먼저다(더 오래됐어도)", r.hits.map((h) => [h.text, h.terms]), [["코끼리와 하마가 함께 든 옛 말", 2], ["코끼리만 든 새 말", 1]]);
    eq("M14 한 줄만 받아도 둘 다 든 말이 그 한 줄이다(자르기 전에 줄 세운다)", texts(await find(A, "코끼리 하마", { limit: 1 })), ["코끼리와 하마가 함께 든 옛 말"]);
    const l1 = await find(A, "얼룩말", { limit: 1 });
    eq("M15 limit=1 — 줄은 하나 · 총계는 전체", [l1.hits.length, l1.total], [1, 5]);
    const capped = await find(A, "얼룩말", { cap: 1 });
    eq("M16 세션 상한보다 맞은 세션이 많으면 capped", [capped.capped, capped.sessions], [true, 1]);
    eq("M16 대조: 상한 안이면 capped 아님", (await find(A, "얼룩말")).capped, false);
    const empty = await find(A, "   ");
    eq("M17 빈 검색어 — 빈 결과", [empty.hits, empty.total, empty.sessions], [[], 0, 0]);
    eq("M17 요청자 없음 — 빈 결과", (await find("", "얼룩말")).hits, []);
  }

  // ══ 작업 일지 ════════════════════════════════════════════════════════════════════════════
  // 세션 20(A · 박스 20): 작업 기록 둘 · 산출 지식 · 맡은 태스크 둘 · 사람이 지은 이름
  //  ⚠ 두 번에 나눠 올린다 — 색인은 한 창 안의 같은 파일을 한 번만 담는다. 창이 다르면 같은 파일이 두 줄이 되므로
  //   «서로 다른 파일 수» 와 «줄 수» 가 갈린다(한 창짜리 픽스처에선 줄 수로 세도 초록이었다).
  await put(SID(20), A, U("일지 첫 지시", ago(2)) + AE("/w/a/b/one.ts", ago(2, 1)) + AE("/w/a/b/two.ts", ago(2, 2)));
  await put(SID(20), A, U("둘째 지시", ago(2, 3)) + AE("/w/a/b/one.ts", ago(2, 4)) + AI("끝", ago(2, 5)));
  await seen(SID(20), ago(2), ago(2, 60));
  await box(20, A, SID(20), { label: "사람이 지은 이름", labelSource: "human", projectId: P_OPEN });
  await convLink(20, SID(20), A, ago(2), ago(2, 60));
  await q(`INSERT INTO session_project(session_id, project_id) VALUES($1, $2)`, [SID(20), P_OPEN]);
  const a1 = await activity(BOX(20), "먼저 한 일", ago(2, 10), { commit: "abc123" });
  const a2 = await activity(BOX(20), "나중에 한 일", ago(2, 50), { type: "docs", summary: "요약" });
  await q(`INSERT INTO knowledge(name, title, body_md) VALUES($1,'산출 지식','x'), ($2,'참조만 한 지식','x'), ($3,'잠긴 지식','x')`, [KN("made"), KN("ref"), KN("locked")]);
  await q(`UPDATE knowledge SET visibility='members' WHERE name=$1`, [KN("locked")]);
  await q(`INSERT INTO activity_knowledge(activity_id, name, relation) VALUES($1,$2,'produced'), ($1,$3,'references'), ($4,$2,'produced'), ($4,$5,'produced')`, [a1, KN("made"), KN("ref"), a2, KN("locked")]);
  const T1 = await project(PN("task1"), { level: "task", parentId: P_OPEN }), T2 = await project(PN("task2"), { level: "task", parentId: P_OPEN, status: "done" });
  const T_HID = await project(PN("task_hidden"), { level: "task", parentId: P_HIDDEN });
  await q(`INSERT INTO execution_session(id, owner, harness, task_id) VALUES($1, $2, 'claude', $3)`, [BOX(20), A, T1]);
  await q(`INSERT INTO execution_session_task(session_id, task_id, pos) VALUES($1,$2,0), ($1,$3,1), ($1,$4,2)`, [BOX(20), T1, T2, T_HID]);
  invalidateVisibilityCache();
  {
    const r = rowOf(await journal(A), SID(20));
    eq("J1 그 세션이 적은 작업 기록이 시각 순으로 붙는다", r.activities.map((x) => [x.title, x.type, x.commit, x.summary]), [["먼저 한 일", "feature", true, null], ["나중에 한 일", "docs", false, "요약"]]);
    eq("J2 산출(produced)로 이은 지식만 · 겹치지 않게 — 참조(references)는 안 실린다", r.knowledge, [{ name: KN("made"), title: "산출 지식" }]);
    eq("J16 잠긴 지식(members · 나는 대상 아님)은 기록 줄에도 안 실린다", r.activities[1].knowledge, [{ name: KN("made"), title: "산출 지식" }]);
    eq("J3 맡은 태스크 — 지금 태스크와 순서 목록을 겹치지 않게 · 순서대로", r.tasks.map((t) => [t.id, t.name, t.status, t.project_id]), [[T1, PN("task1"), "todo", P_OPEN], [T2, PN("task2"), "done", P_OPEN]]);
    chk("J11 가려진 프로젝트의 태스크는 안 실린다", !r.tasks.some((t) => t.id === T_HID), JSON.stringify(r.tasks));
    eq("J10 질문 수 = 사람 말 수 · 고친 파일 수 = 서로 다른 파일 수", [r.asks, r.edits], [2, 2]);
    eq("J15 사람이 지은 이름이 선다 · 박스 id · 프로젝트", [r.name, r.box_id, r.project_id, r.project_name, r.title], ["사람이 지은 이름", BOX(20), P_OPEN, PN("open"), "일지 첫 지시"]);
    eq("J17 기간이 없으면 앞선 기록 수는 0", r.activities_before, 0);
  }
  // 기간을 주면 줄의 «한 일» 은 그 기간에 적은 기록만 — 앞선 기간의 기록은 수로만, 뒤 기간의 기록은 싣지 않는다
  {
    const cut = ago(2, 30);                                     // a1(2일 전 +10초)과 a2(+50초) 사이
    const part = rowOf(await journal(A, { since: cut }), SID(20));
    eq("J17 기간 안에 적은 기록만 실린다 · 앞선 기록은 수로", [part.activities.map((x) => x.title), part.activities_before], [["나중에 한 일"], 1]);
    eq("J17 지식도 그 기간의 기록이 산출한 것만(먼저 한 일의 지식은 이 기간 것이 아니다 — 같은 지식을 나중 기록도 산출했다)", part.knowledge, [{ name: KN("made"), title: "산출 지식" }]);
    const edge = rowOf(await journal(A, { since: ago(2, 50) }), SID(20));
    eq("J17 경계 — 기간 시작 시각에 적은 기록은 기간 안", [edge.activities.map((x) => x.title), edge.activities_before], [["나중에 한 일"], 1]);
    await activity(BOX(20), "기간 뒤에 적은 일", ago(0, -5));
    await seen(SID(20), ago(2), ago(1, -100));                  // 마지막 활동을 until(1일 전) 바로 앞에 둔다
    const closed = rowOf(await journal(A, { since: ago(3), until: ago(1) }), SID(20));
    eq("J17 기간 뒤에 적은 기록은 싣지 않는다(끝 시각은 기간 밖)", closed.activities.map((x) => x.title), ["먼저 한 일", "나중에 한 일"]);
    eq("J17 대조: 기간이 없으면 셋 다", rowOf(await journal(A), SID(20)).activities.map((x) => x.title), ["먼저 한 일", "나중에 한 일", "기간 뒤에 적은 일"]);
  }
  // 남의 세션 · 휴지통 둘 · 다른 워크스페이스 · 서브에이전트 · 작업 상자 · 연결이 빈 세션 · 가려진 프로젝트에 붙은 내 세션
  await put(SID(21), B, U("B 의 세션", ago(2)));
  await put(SID(22), A, U("대화 uuid 로 버린 세션", ago(2)));
  await q(`INSERT INTO org_session_trash(session_id, owner) VALUES($1, $2)`, [SID(22), A]);
  await put(SID(23), A, U("박스 id 로 버린 세션", ago(2)));
  await box(23, A, SID(23)); await convLink(23, SID(23), A);
  await q(`INSERT INTO org_session_trash(session_id, owner) VALUES($1, $2)`, [BOX(23), A]);
  await put(SID(24), A, U("다른 워크스페이스 세션", ago(2)));
  await q(`INSERT INTO gw_session_map(session_id, workspace_id) VALUES($1, $2)`, [SID(24), W2]);
  await put(SID(25), A, U("서브에이전트", ago(2)), SID(20));
  await put(SID(26), A, U("작업 상자", ago(2)));
  await q(`UPDATE session SET run_kind='task' WHERE node_id='' AND session_id=$1`, [SID(26)]);
  await put(SID(27), A, U("아무 연결도 없는 세션", ago(2)));
  await q(`INSERT INTO org_session_trash(session_id, owner) VALUES($1, $2)`, [SID(27), B]);   // 남(B)이 제 휴지통에 넣은 표식 — 주인(A)의 일지와 무관하다
  await put(SID(28), A, U("가려진 프로젝트에 붙은 내 세션", ago(2)));
  await q(`INSERT INTO session_project(session_id, project_id) VALUES($1, $2)`, [SID(28), P_HIDDEN]);
  {
    const all = await journal(A, { limit: 500 });
    const got = all.rows.map((r) => r.session_id);
    chk("J4 남의 세션은 내 일지에 없다", !got.includes(SID(21)), JSON.stringify(got));
    eq("J4 남의 세션은 하나만 물어도 빈 결과", (await journal(A, { only: { nodeId: "", sessionId: SID(21) } })).rows, []);
    eq("J4 대조: 내 세션은 하나만 물으면 그 줄", (await journal(A, { only: { nodeId: "", sessionId: SID(20) } })).rows.map((r) => r.session_id), [SID(20)]);
    chk("J5 휴지통 — 대화 uuid 표식도 박스 id 표식도 빠진다", !got.includes(SID(22)) && !got.includes(SID(23)), JSON.stringify(got));
    eq("J5 휴지통 세션은 하나만 물어도 빈 결과", (await journal(A, { only: { nodeId: "", sessionId: SID(22) } })).rows, []);
    chk("J5 휴지통 표식은 주인의 것 — 남이 붙인 표식은 내 일지를 가리지 않는다", got.includes(SID(27)), JSON.stringify(got));
    chk("J12 다른 워크스페이스 세션은 없다", !got.includes(SID(24)), JSON.stringify(got));
    chk("J14 서브에이전트·작업 상자 세션은 없다", !got.includes(SID(25)) && !got.includes(SID(26)), JSON.stringify(got));
    const bare = rowOf(all, SID(27));
    eq("J9 연결이 빈 세션 — 줄은 서고 빈 배열 · 박스 모름", [bare.activities, bare.knowledge, bare.tasks, bare.box_id, bare.asks, bare.edits], [[], [], [], null, 1, 0]);
    const hid = rowOf(all, SID(28));
    eq("J11 내 세션이어도 그 프로젝트가 가려져 있으면 프로젝트 이름·id 를 싣지 않는다", [hid.project_id, hid.project_name], [null, null]);
  }
  // 기간 경계 · 상한
  {
    const SINCE = ago(10), UNTIL = ago(5);
    await put(SID(30), A, U("기간 시작 정각"));  await seen(SID(30), ago(11), SINCE);
    await put(SID(31), A, U("기간 끝 정각"));    await seen(SID(31), ago(11), UNTIL);
    await put(SID(32), A, U("기간 안"));         await seen(SID(32), ago(11), ago(7));
    await put(SID(33), A, U("기간 시작 직전"));  await seen(SID(33), ago(11), new Date(Date.parse(SINCE) - 1).toISOString());
    const r = await journal(A, { since: SINCE, until: UNTIL });
    eq("J6 기간 — since ≤ 마지막 활동 < until(시작 정각은 들고 끝 정각은 빠진다) · 늦은 것부터", r.rows.map((x) => x.session_id), [SID(32), SID(30)]);
    const l1 = await journal(A, { since: SINCE, until: UNTIL, limit: 1 });
    eq("J13 limit=1 — 한 줄 · 더 있다고 말한다", [l1.rows.map((x) => x.session_id), l1.truncated], [[SID(32)], true]);
    eq("J13 대조: 다 들어가면 truncated 아님", r.truncated, false);
  }
  // 한 박스가 대화를 갈아탔다(c40 → c41) — 기록은 그때 돌던 대화의 것
  {
    await put(SID(40), A, U("갈아타기 전 대화"));  await seen(SID(40), ago(9), ago(8));
    await put(SID(41), A, U("갈아탄 뒤 대화"));    await seen(SID(41), ago(1), ago(0, -60));
    await box(40, A, SID(41));                                     // 박스의 «지금 대화» 는 뒤 대화
    await convLink(40, SID(40), A, ago(9), ago(8));
    await convLink(40, SID(41), A, ago(1), ago(0, -60));
    const early = await activity(BOX(40), "앞 대화에서 한 일", ago(8, 3600));
    const late = await activity(BOX(40), "뒤 대화에서 한 일", ago(0, -3600));
    const all = await journal(A, { limit: 500 });
    eq("J7 갈아탄 박스 — 기록은 그때 돌던 대화의 줄에만", [rowOf(all, SID(40)).activities.map((x) => x.id), rowOf(all, SID(41)).activities.map((x) => x.id)], [[early], [late]]);
    eq("J7 두 대화 모두 같은 박스로 열린다", [rowOf(all, SID(40)).box_id, rowOf(all, SID(41)).box_id], [BOX(40), BOX(40)]);
    const recent = await journal(A, { since: ago(3) });
    eq("J8 앞 대화가 기간 밖이면 그 기록을 뒤 대화로 끌어오지 않는다", rowOf(recent, SID(41)).activities.map((x) => x.id), [late]);
    chk("J8 기간 밖 대화는 목록에 없다", !rowOf(recent, SID(40)));
  }
  // 시간 상한 — 일지가 읽는 표 하나를 잠가 두면 첫 문장이 그 잠금을 기다린다. 상한이 걸려 있으면 끊기고(57014), 없으면 매달린다.
  {
    const locker = await itemsPool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE org_session_trash IN ACCESS EXCLUSIVE MODE");
      const got = await Promise.race([
        journal(A, { timeoutMs: 300 }).then(() => "끝남", (e) => e?.code || String(e)),
        new Promise((z) => setTimeout(() => z("매달림"), 5000)),
      ]);
      eq("J18 문장이 시간 상한을 넘으면 끊긴다(57014) — 풀의 연결을 쥔 채 매달리지 않는다", got, "57014");
    } finally { await locker.query("ROLLBACK").catch(() => {}); locker.release(); }
    eq("J18 대조: 잠금이 풀리면 다시 읽힌다", (await journal(A, { only: { nodeId: "", sessionId: SID(27) } })).rows.length, 1);
  }
} catch (e) {
  bad("예외", (e && e.stack) || String(e));
} finally {
  await cleanup().catch((e) => console.error("cleanup 실패:", e?.message));
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
