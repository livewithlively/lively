// 수집 단위 표(#4213 T10 #4742) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/collect/collect-unit.pg-test.mjs
//
// 왜 이 계층인가: 이 기능의 약속은 전부 SQL 이 지키는 사실이다 — «같은 외부 좌표는 자료 한 행» · «볼 수 있는 사람만 본다» ·
//  «남의 목록을 대신 적지 못한다» · «담당이 아니면 읽은 위치를 못 옮긴다» · «수집기가 1순위». 목 풀로는 조건 하나를 지워도
//  초록이다. 그래서 **부작용을 SELECT 로 되읽어** 판정한다(자료 행 수 · source_member · canSeeSource · 단위 행).
//
//  사양·엣지 표: as-built 지식 «수집 단위 표»(L·A·C·S·V·M 행) — 판정 순수 행(P·N·O·B)은 unit-plan.test.ts.
//  완료 조건 두 줄(태스크 #4742)을 E1·E2 로 그대로 재현한다: 두 구성원이 같은 채널을 볼 때 한 번만 모이고 둘 다에게 보인다 ·
//  담당의 로그인을 끊으면 다른 구성원에게 넘어간다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/collect/unit-store.js`);
const { mirrorSourceV6 } = await import(`${DIST}/v6/mirror/mirror-source.js`);
const { canSeeSource } = await import(`${DIST}/v6/source-store.js`);
const { invalidateSourceVisRules } = await import(`${DIST}/v6/source-vis-policy.js`);
const { invalidateVisAxes } = await import(`${DIST}/v6/visibility-axes.js`);
const { collectUnitCapabilities } = await import(`${DIST}/capabilities/collect-units.js`);
const { listConnectorRuns } = await import(`${DIST}/connectors/run-tracker.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const throwsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e?.message ?? e)); } };

const A = "__cu_pg_a__", B = "__cu_pg_b__", C = "__cu_pg_c__";
const MEMBERS = [A, B, C];
const APP = "cupg";                 // 이 시험만 쓰는 앱 키 — 남의 자료·수집기와 섞이지 않는다
const TEAM_SLACK = "T_CUPG";       // 이관 시험용 슬랙 팀(인스턴스)
const NOTION_INST = "cupg-notion";
const COLLECTOR_KEYS = ["pgtest-cu-slack", "pgtest-cu-gmail", "pgtest-cu-notion"];
const POLICY_NOTE = "pgtest-cu";
const notices = [];
const notify = async (n) => { notices.push(n); return { ok: true }; };

const item = (ext, body = "본문", o = {}) => ({
  type: "message", provenance: { category: "messenger", system: "x", instance: "y", external_id: ext },
  title: null, body, occurred_at: o.at ?? "2026-10-16T01:00:00Z", fields: {}, ...o.extra,
});
const srcRows = async (ext, app = APP) => (await itemsPool.query(
  `SELECT id, visibility FROM source WHERE external_system=$1 AND external_id=$2`, [app, ext])).rows;
const audience = async (sid) => (await itemsPool.query(
  `SELECT subject_kind || ':' || member_id AS s FROM source_member WHERE source_id=$1 ORDER BY 1`, [sid])).rows.map((r) => r.s);
const unitBy = async (ref, app = APP, inst = "") => (await itemsPool.query(
  `SELECT * FROM collect_unit WHERE app=$1 AND instance=$2 AND ref=$3`, [app, inst, ref])).rows[0];
const viewersOf = async (unitId) => (await itemsPool.query(
  `SELECT member_id, priority, via FROM collect_unit_member WHERE unit_id=$1 ORDER BY priority, member_id`, [unitId])).rows;
const listing = (member, refs, o = {}) => store.recordUnitListing({
  member, app: o.app ?? APP, connector: o.connector ?? "Cupg", instance: o.instance ?? "",
  items: refs.map((r) => (typeof r === "string" ? { ref: r, kind: "channel", name: `#${r}` } : r)), complete: o.complete,
});
const activate = (ref, app = APP, inst = "") =>
  itemsPool.query(`UPDATE collect_unit SET state='active' WHERE app=$1 AND instance=$2 AND ref=$3`, [app, inst, ref]);
const outcome = (member, runId, kind) => store.recordCollectOutcome({
  member, runId, notify,
  exit: kind === "ok" ? { error: null, code: 0 } : { error: "claude exit 1", code: 1 },
  summary: kind === "ok"
    ? { apps: ["Cupg"], allowed: ["Cupg"], missing: [], result: { subtype: "success", text: "done" } }
    : { apps: ["Cupg"], stderrTail: "Failed to authenticate. API Error: 401 OAuth access token has been revoked." },
});
const assigned = async (member) => (await store.listAssignedUnits(member)).map((u) => u.ref).sort();

async function cleanup() {
  await itemsPool.query(`DELETE FROM collect_unit WHERE app=$1 OR (app='slack' AND instance=$2) OR (app='notion' AND instance=$3)
                           OR (app='gmail' AND ref = ANY($4::text[]))`, [APP, TEAM_SLACK, NOTION_INST, MEMBERS.map((m) => `${m}@cupg.test`)]);
  await itemsPool.query(`DELETE FROM source WHERE external_system=$1 OR (external_system='slack' AND external_instance=$2)`, [APP, TEAM_SLACK]);
  await itemsPool.query(`DELETE FROM knowledge WHERE external_system='notion' AND external_instance=$1`, [NOTION_INST]);
  await itemsPool.query(`DELETE FROM collect_assignee_state WHERE member_id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`DELETE FROM connector_run WHERE collector_id IN (SELECT id FROM org_collector WHERE key = ANY($1::text[]))`, [COLLECTOR_KEYS]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_collector WHERE key = ANY($1::text[])`, [COLLECTOR_KEYS]);
  await itemsPool.query(`DELETE FROM org_source_vis_policy WHERE note=$1`, [POLICY_NOTE]);
  await itemsPool.query(`DELETE FROM team WHERE key='pgtest-cu-team'`);
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [MEMBERS]);
  await itemsPool.query(`UPDATE org_runtime_config SET visibility_axes = visibility_axes - 'source' WHERE id=1`).catch(() => {});
  invalidateSourceVisRules(); invalidateVisAxes();
}

try {
  await listConnectorRuns();   // connector_run 표는 첫 사용 때 만들어진다 — 시험 전에 보장
  await cleanup();
  for (const m of MEMBERS) {
    await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@cupg.test`]);
  }

  // ── E1 (완료 조건 ①) 두 구성원이 같은 채널을 볼 때 한 번만 모이고 둘 다에게 보인다 ──
  {
    const ra = await listing(A, ["ch1"]);
    const rb = await listing(B, ["ch1"]);
    const u = await unitBy("ch1");
    const vs = await viewersOf(u.id);
    chk("L2 처음 나온 단위는 후보(candidate) · 구성원 경로 · 첫 사람 우선순위 10",
      ra.created === 1 && u.state === "candidate" && u.route === "member_ai" && vs[0]?.member_id === A && vs[0]?.priority === 10, JSON.stringify({ ra, u: { state: u?.state, route: u?.route }, vs }));
    chk("L4 두 번째로 본 사람은 후보 줄 맨 뒤(20) · 단위는 하나", rb.created === 0 && rb.joined === 1 && vs[1]?.member_id === B && vs[1]?.priority === 20, JSON.stringify({ rb, vs }));
    const before = (await itemsPool.query(`SELECT seen_at FROM collect_unit_member WHERE unit_id=$1 AND member_id=$2`, [u.id, A])).rows[0].seen_at;
    const again = await listing(A, ["ch1"]);
    const vs2 = await viewersOf(u.id);
    const after = (await itemsPool.query(`SELECT seen_at FROM collect_unit_member WHERE unit_id=$1 AND member_id=$2`, [u.id, A])).rows[0].seen_at;
    chk("L5 같은 사람이 다시 훑으면 우선순위 그대로 · seen_at 만 갱신", again.seen === 1 && vs2[0].priority === 10 && new Date(after) >= new Date(before), JSON.stringify({ again, vs2 }));

    chk("E1-0 후보 상태에선 아무도 맡지 않는다", (await assigned(A)).length === 0 && (await assigned(B)).length === 0);
    await activate("ch1");
    const la = await assigned(A), lb = await assigned(B);
    chk("E1-1 수집 중이 되면 1순위 한 명만 맡는다(A) — B 의 실행에는 이 단위가 없다", la.includes("ch1") && !lb.includes("ch1"), JSON.stringify({ la, lb }));

    const s1 = await store.storeUnitItems(u.id, [item("m1", "첫 글"), item("m2", "둘째 글")]);
    const s2 = await store.storeUnitItems(u.id, [item("m1", "첫 글")]);
    const rows = await srcRows("m1");
    chk("A1 같은 외부 좌표를 두 번 저장해도 자료는 한 행", s1.inserted === 2 && s2.inserted === 0 && s2.stored === 1 && rows.length === 1, JSON.stringify({ s1, s2, rows }));
    const sid = rows[0].id;
    chk("A2 단위로 모은 새 자료는 그 단위를 볼 수 있는 구성원만(A·B) — 잠김", rows[0].visibility === "members" && JSON.stringify(await audience(sid)) === JSON.stringify([`member:${A}`, `member:${B}`]),
      JSON.stringify({ vis: rows[0].visibility, aud: await audience(sid) }));
    chk("E1-2 두 사람 다 보고, 단위를 못 보는 사람(C)은 못 본다", (await canSeeSource(sid, A)) && (await canSeeSource(sid, B)) && !(await canSeeSource(sid, C)));
  }

  // ── L6·L7·A7·L9 볼 수 있는 구성원이 바뀌면 이미 모은 자료도 따라간다 ──
  {
    const u = await unitBy("ch1");
    const sid = (await srcRows("m1"))[0].id;
    await listing(B, ["other-ch"], { complete: false });
    chk("L7 complete 가 아니면 목록에 없는 단위에서 빼지 않는다", (await viewersOf(u.id)).some((v) => v.member_id === B));
    const r = await listing(B, ["other-ch"], { complete: true });
    chk("L6 complete 목록에 없으면 그 단위에서 빠진다", r.left >= 1 && !(await viewersOf(u.id)).some((v) => v.member_id === B), JSON.stringify(r));
    chk("A7 빠진 사람은 이미 모은 자료도 못 본다", !(await canSeeSource(sid, B)) && (await canSeeSource(sid, A)), JSON.stringify(await audience(sid)));
    await listing(C, ["ch1"]);
    chk("L9 새로 볼 수 있게 된 사람은 이미 모은 자료도 본다", await canSeeSource(sid, C), JSON.stringify(await audience(sid)));
    await listing(B, ["ch1", "other-ch"]);   // 원상 복구(B 다시 후보 — 줄 맨 뒤)
  }

  // ── A3 같은 자료가 두 단위로(같은 메일이 두 사람 메일함에) → 합집합 ──
  {
    await listing(A, [{ ref: "box-a", kind: "label" }]);
    await listing(B, [{ ref: "box-b", kind: "label" }]);
    const ua = await unitBy("box-a"), ub = await unitBy("box-b");
    await store.storeUnitItems(ua.id, [item("mail-1")]);
    const after1 = await audience((await srcRows("mail-1"))[0].id);
    await store.storeUnitItems(ub.id, [item("mail-1")]);
    const rows = await srcRows("mail-1");
    chk("A3 같은 자료가 두 단위로 들어오면 한 행 · 볼 수 있는 사람은 합집합",
      rows.length === 1 && JSON.stringify(after1) === JSON.stringify([`member:${A}`])
        && JSON.stringify(await audience(rows[0].id)) === JSON.stringify([`member:${A}`, `member:${B}`]),
      JSON.stringify({ after1, now: await audience(rows[0].id) }));
  }

  // ── A4·A4b 조직 공개범위 정책이 묶었으면 그 안으로 · A5 아무도 없으면 닫힘 ──
  {
    await listing(A, ["pol-ch"]); await listing(B, ["pol-ch"]);
    const u = await unitBy("pol-ch");
    const p = (await itemsPool.query(
      `INSERT INTO org_source_vis_policy(match_system, match_channel, visibility, note) VALUES($1,'pol-ch','members',$2) RETURNING id`, [APP, POLICY_NOTE])).rows[0].id;
    await itemsPool.query(`INSERT INTO org_source_vis_policy_member(policy_id, subject_kind, member_id) VALUES($1,'member',$2),($1,'member',$3)`, [p, A, C]);
    invalidateSourceVisRules();
    await store.storeUnitItems(u.id, [item("pol-1")]);
    chk("A4 정책 대상(A·C) ∩ 단위 구성원(A·B) = A 만", JSON.stringify(await audience((await srcRows("pol-1"))[0].id)) === JSON.stringify([`member:${A}`]),
      JSON.stringify(await audience((await srcRows("pol-1"))[0].id)));
    const team = (await itemsPool.query(`INSERT INTO team(key, name) VALUES('pgtest-cu-team','시험 팀') RETURNING id`)).rows[0].id;
    await itemsPool.query(`INSERT INTO team_member(team_id, member_id) VALUES($1,$2)`, [team, B]);
    await itemsPool.query(`DELETE FROM org_source_vis_policy_member WHERE policy_id=$1`, [p]);
    await itemsPool.query(`INSERT INTO org_source_vis_policy_member(policy_id, subject_kind, member_id) VALUES($1,'team',$2)`, [p, String(team)]);
    invalidateSourceVisRules();
    await store.storeUnitItems(u.id, [item("pol-2")]);
    chk("A4b 팀 대상 정책이면 단위 구성원 중 그 팀원(B)만", JSON.stringify(await audience((await srcRows("pol-2"))[0].id)) === JSON.stringify([`member:${B}`]),
      JSON.stringify(await audience((await srcRows("pol-2"))[0].id)));
    await itemsPool.query(`DELETE FROM org_source_vis_policy WHERE id=$1`, [p]);
    invalidateSourceVisRules();

    const empty = (await itemsPool.query(
      `INSERT INTO collect_unit(app, instance, ref, kind, route, state) VALUES($1,'','nobody','channel','member_ai','active') RETURNING id`, [APP])).rows[0].id;
    await store.storeUnitItems(empty, [item("nobody-1")]);
    const r = (await srcRows("nobody-1"))[0];
    chk("A5 볼 사람이 없는 단위의 자료는 잠긴 채 아무에게도 안 보인다", r.visibility === "members" && (await audience(r.id)).length === 0 && !(await canSeeSource(r.id, A)));
  }

  // ── A6 단위 체계 밖에서 먼저 들어와 있던 자료(봇 수집기)는 공개범위를 건드리지 않는다 ──
  {
    const client = await itemsPool.connect();
    try {
      await client.query("BEGIN");
      await mirrorSourceV6(client, { ...item("bot-1"), provenance: { category: "messenger", system: APP, instance: "", external_id: "bot-1" } }, APP, "bot-1");
      await client.query("COMMIT");
    } finally { client.release(); }
    const u = await unitBy("ch1");
    const before = (await srcRows("bot-1"))[0];
    await store.storeUnitItems(u.id, [item("bot-1")]);
    const after = (await srcRows("bot-1"))[0];
    const link = (await itemsPool.query(`SELECT audience FROM collect_unit_source WHERE unit_id=$1 AND source_id=$2`, [u.id, after.id])).rows[0];
    chk("A6 봇이 먼저 모은 open 자료는 open 그대로 · 연결만(audience=false)",
      before.visibility === "open" && after.visibility === "open" && link && link.audience === false && (await canSeeSource(after.id, C)),
      JSON.stringify({ before, after, link }));
  }

  // ── L1 남의 목록은 못 적는다(표면) · L10 남의 메일함 ──
  {
    const cap = collectUnitCapabilities.find((c) => c.name === "collect_unit_listing");
    let refused = false;
    try { cap.expose.rest[0].parse({ body: { member: B, app: APP, items: [{ ref: "x" }] }, params: {}, query: {} }); } catch (e) { refused = e?.status === 400; }
    const viaHandler = await cap.handler({ app: APP, items: [{ ref: "self-only", kind: "channel" }] }, { userId: A, email: "", scopes: ["memory"], projects: [] }, { actor: A });
    const vs = await viewersOf((await unitBy("self-only")).id);
    chk("L1 REST 가 member 를 거절하고 · 핸들러는 늘 부르는 사람으로 적는다",
      refused && viaHandler.ok && vs.length === 1 && vs[0].member_id === A, JSON.stringify({ refused, vs }));
    const r = await store.recordUnitListing({ member: A, app: "gmail", instance: "default",
      items: [{ ref: `${B}@cupg.test`, kind: "mailbox" }, { ref: `${A}@cupg.test`, kind: "mailbox" }] });
    const gb = await unitBy(`${B}@cupg.test`, "gmail", "default");
    const ga = await unitBy(`${A}@cupg.test`, "gmail", "default");
    chk("L10 남의 메일함은 볼 수 있다고 적지 못한다 · 내 메일함은 된다",
      r.refused.length === 1 && !gb && ga && (await viewersOf(ga.id)).some((v) => v.member_id === A), JSON.stringify(r));
  }

  // ── C 읽은 위치 — 지금 담당만 ──
  {
    const u = await unitBy("ch1");
    const no = await store.advanceUnitCursor(u.id, { member: B }, { cursor: { ts: "999" } });
    const mid = await unitBy("ch1");
    chk("C1 담당이 아닌 사람(B)은 읽은 위치를 못 옮긴다", no.ok === false && no.reason === "not_assignee" && JSON.stringify(mid.cursor) === "{}", JSON.stringify({ no, cursor: mid.cursor }));
    const yes = await store.advanceUnitCursor(u.id, { member: A }, { cursor: { ts: "100" }, lastItemAt: "2026-10-16T05:00:00Z" });
    const later = await store.advanceUnitCursor(u.id, { member: A }, { cursor: { ts: "200" }, lastItemAt: "2026-10-16T01:00:00Z" });
    const after = await unitBy("ch1");
    chk("C2 담당(A)은 옮긴다 — cursor·read_at·read_by", yes.ok && later.ok && after.cursor.ts === "200" && after.read_by === A && after.read_at != null, JSON.stringify(after));
    chk("C3 마지막 글 시각은 늦은 쪽으로만", new Date(after.last_item_at).toISOString() === "2026-10-16T05:00:00.000Z", String(after.last_item_at));
  }

  // ── E2 (완료 조건 ②) 담당의 로그인을 끊으면 다른 구성원에게 넘어간다 · 혼자 보는 단위만 «다시 로그인» ──
  {
    await listing(A, ["solo-a"]); await activate("solo-a");
    notices.length = 0;
    chk("E2-0 처음엔 A 가 ch1·solo-a 를 맡는다", JSON.stringify(await assigned(A)) === JSON.stringify(["ch1", "solo-a"]), JSON.stringify(await assigned(A)));
    const o = await outcome(A, "cr-pg-1", "broken");
    const la = await assigned(A), lc = await assigned(C), lb = await assigned(B);
    chk("E2-1 A 의 로그인이 끊기면 ch1 은 다음 후보가 맡는다(C — B 는 다시 들어와 줄 맨 뒤)",
      o.changes[0]?.state === "login_broken" && !la.includes("ch1") && lc.includes("ch1") && !lb.includes("ch1"), JSON.stringify({ o, la, lb, lc }));
    chk("E2-2 «다시 로그인» 은 혼자 보는 단위(solo-a)의 A 에게만 한 번",
      notices.length === 1 && notices[0].memberId === A && /solo-a/.test(notices[0].body) && notices[0].appId === "ai-session" && notices[0].href === "#/me/ai",
      JSON.stringify(notices));
    const again = await outcome(A, "cr-pg-1", "broken");
    const st1 = (await itemsPool.query(`SELECT fails FROM collect_assignee_state WHERE member_id=$1 AND connector='*'`, [A])).rows[0];
    await outcome(A, "cr-pg-2", "broken");
    const st2 = (await itemsPool.query(`SELECT fails, retry_at, since FROM collect_assignee_state WHERE member_id=$1 AND connector='*'`, [A])).rows[0];
    chk("E2-3 같은 실행을 두 번 반영하지 않고 · 다음 실패는 연속 횟수만 늘린다 · 같은 끊김엔 다시 안 알린다",
      st1.fails === 1 && st2.fails === 2 && notices.length === 1, JSON.stringify({ again, st1, st2, n: notices.length }));
    const v = (await store.listUnitsFor({ member: A, canManage: false })).units.find((x) => x.ref === "ch1");
    chk("E2-4 단위 표가 «누가 왜» 를 말한다 — A 는 끊김, 담당은 C",
      v && v.assignee?.kind === "member" && v.assignee.member_id === C && v.candidates.find((c) => c.member_id === A)?.health === "login_broken",
      JSON.stringify(v && { assignee: v.assignee, candidates: v.candidates }));
    await outcome(A, "cr-pg-3", "ok");
    chk("E2-5 A 가 다시 정상이면 1순위로 돌아온다", (await assigned(A)).includes("ch1") && !(await assigned(C)).includes("ch1"));
  }

  // ── S 쪼개기 ──
  {
    const p = await unitBy("ch1");
    const kids = await store.splitUnit(p.id, [{ ref: "ch1-sub", name: "하위", viewers: [A] }], { member: A, canManage: false });
    const child = await unitBy("ch1-sub");
    chk("S1 자식은 같은 앱·인스턴스·상태 · parent_id · 준 구성원만(A)",
      kids.length === 1 && child.parent_id === p.id && child.state === "active" && JSON.stringify((await viewersOf(child.id)).map((v) => v.member_id)) === JSON.stringify([A]),
      JSON.stringify({ child }));
    const ex = (await store.listAssignedUnits(A)).find((u) => u.ref === "ch1");
    chk("S1b 부모를 읽을 때 자식 ref 는 건너뛴다(exclude_refs)", ex && ex.exclude_refs.includes("ch1-sub"), JSON.stringify(ex));
    chk("S2 부모를 볼 수 없는 구성원을 자식에 넣으면 거절", await throwsWith(
      () => store.splitUnit(p.id, [{ ref: "ch1-sub2", viewers: ["__nobody__"] }], { member: A, canManage: false }), /좁히기만/));
  }

  // ── V 조회·수정 권한 ──
  {
    const r = await store.listUnitsFor({ member: "__outsider__", canManage: true }, { app: APP });
    chk("V1 구성원 경로 단위는 관리하는 사람이라도 볼 수 있는 구성원이 아니면 안 보인다(개수만)", r.units.length === 0 && r.hidden > 0, JSON.stringify({ n: r.units.length, hidden: r.hidden }));
    const u = await unitBy("ch1");
    chk("V3 볼 수 없는 사람의 수정은 거절(없는 단위로 답한다)", await throwsWith(
      () => store.updateUnit(u.id, { state: "excluded" }, { member: "__outsider__", canManage: true }), /없습니다/));
    const upd = await store.updateUnit(u.id, { interval_sec: 1800, description: "제품 논의", meta: { character: "결정 많음" }, priorities: [C, A] }, { member: A, canManage: false });
    chk("V3b 볼 수 있는 구성원은 주기·설명·메타·후보 순서를 고친다",
      upd.interval_sec === 1800 && upd.description === "제품 논의" && upd.meta.character === "결정 많음" && upd.candidates[0].member_id === C,
      JSON.stringify({ upd: { i: upd.interval_sec, d: upd.description, m: upd.meta, c: upd.candidates.map((x) => x.member_id) } }));
    chk("V3c 경로 바꾸기는 관리하는 사람만", await throwsWith(
      () => store.updateUnit(u.id, { route: "lively_collector" }, { member: A, canManage: false }), /관리하는 사람만/));
  }

  // ── A8 자료 축이 꺼져 있으면 구성원 경로로 모으지 않는다 · 잠금은 그래도 적힌다 ──
  {
    await itemsPool.query(`UPDATE org_runtime_config SET visibility_axes = visibility_axes || '{"source": false}'::jsonb WHERE id=1`);
    invalidateVisAxes();
    const la = await assigned(A);
    const u = await unitBy("ch1");
    await store.storeUnitItems(u.id, [item("axis-off-1")]);
    const r = (await srcRows("axis-off-1"))[0];
    chk("A8 축이 꺼지면 맡는 단위가 없다 · 저장된 자료는 잠금·대상이 그대로 적힌다", la.length === 0 && r.visibility === "members" && (await audience(r.id)).length > 0,
      JSON.stringify({ la, vis: r.visibility }));
    await itemsPool.query(`UPDATE org_runtime_config SET visibility_axes = visibility_axes - 'source' WHERE id=1`);
    invalidateVisAxes();
  }

  // ── M 지금 수집기 설정 → 단위(이관) · 수집기 1순위 · 꺼짐/끊김 ──
  {
    const col = (await itemsPool.query(
      `INSERT INTO org_collector(key, preset_key, instance_key, enabled, config) VALUES('pgtest-cu-slack','slack','pgtest-cu',true,$1::jsonb) RETURNING id`,
      [JSON.stringify({ channels: "general", token_source: `bot:${TEAM_SLACK}` })])).rows[0].id;
    const client = await itemsPool.connect();
    try {
      for (const [ext, ref, name] of [["C9:1", "C9", "general"], ["C9:2", "C9", "general"], ["C8:1", "C8", "random"]]) {
        await client.query("BEGIN");
        await mirrorSourceV6(client, { ...item(ext), provenance: { category: "messenger", system: "slack", instance: TEAM_SLACK, external_id: ext },
          container_ref: ref, container_name: name, occurred_at: ext === "C9:2" ? "2026-10-15T09:00:00Z" : "2026-10-14T09:00:00Z" }, "slack", ext);
        await client.query("COMMIT");
      }
    } finally { client.release(); }
    await store.recordUnitListing({ member: A, app: "slack", instance: TEAM_SLACK, connector: "Slack", items: [{ ref: "C9", kind: "channel" }, { ref: "C7", kind: "channel" }] });
    await activate("C9", "slack", TEAM_SLACK);
    store._resetCollectorUnitsFreshForTest();
    const r = await store.syncCollectorUnits();
    const g = await unitBy("C9", "slack", TEAM_SLACK), rnd = await unitBy("C8", "slack", TEAM_SLACK), c7 = await unitBy("C7", "slack", TEAM_SLACK);
    chk("M1 켜진 수집기 범위 안의 모인 채널 → 단위(수집기 경로·수집 중·collector_id·마지막 글 시각) · 범위 밖(random) 은 안 올린다",
      g && g.route === "lively_collector" && Number(g.collector_id) === Number(col) && g.state === "active"
        && new Date(g.last_item_at).toISOString() === "2026-10-15T09:00:00.000Z" && !rnd,
      JSON.stringify({ r, g, rnd: !!rnd }));
    chk("M2 구성원 경로였던 같은 채널은 수집기 경로로(수집기 1순위) · 구성원은 후보로 남는다 · 수집기 범위 밖 채널(C7)은 그대로",
      r.rerouted >= 1 && (await viewersOf(g.id)).some((v) => v.member_id === A) && c7.route === "member_ai", JSON.stringify(r));
    const before = await store.syncCollectorUnits();
    chk("M3 다시 돌려도 같다(멱등)", before.created === 0, JSON.stringify(before));
    const la = await assigned(A);
    chk("M4 수집기가 정상이면 구성원은 그 채널을 맡지 않는다", !la.includes("C9"), JSON.stringify(la));

    await itemsPool.query(`INSERT INTO connector_run(system, status, finished_at, log, collector_id) VALUES('slack','error',now(),$1,$2)`,
      ['{"level":50,"err":"Failed to authenticate. API Error: 401 OAuth access token has been revoked."}', col]);
    const fb = (await store.listAssignedUnits(A)).find((u) => u.ref === "C9");
    chk("M5 수집기가 끊기면(마지막 실행이 자격 실패) 구성원 후보가 이어받는다 — 수집기 쪽 위치라 from_collector",
      fb && fb.from_collector === true && fb.last_item_at != null, JSON.stringify(fb));
    await itemsPool.query(`UPDATE org_collector SET enabled=false WHERE id=$1`, [col]);
    const v = (await store.listUnitsFor({ member: A, canManage: true }, { app: "slack" })).units.find((u) => u.ref === "C9" && u.instance === TEAM_SLACK);
    chk("M6 수집기를 끄면 담당 없음(collector_off) — 구성원 AI 계정이 대신 모으지 않는다",
      v && v.assignee == null && v.assignee_reason === "collector_off" && !(await assigned(A)).includes("C9"), JSON.stringify(v && { a: v.assignee, r: v.assignee_reason }));

    const gm = (await itemsPool.query(
      `INSERT INTO org_collector(key, preset_key, instance_key, enabled, config) VALUES('pgtest-cu-gmail','gmail','pgtest-cu',true,$1::jsonb) RETURNING id`,
      [JSON.stringify({ token_source: `member:${B}` })])).rows[0].id;
    await store.syncCollectorUnits();
    const box = await unitBy(`${B}@cupg.test`, "gmail", "default");
    chk("M7 메일 수집기 → 자격 주인의 메일함 단위 · 주인이 볼 수 있는 구성원",
      box && box.kind === "mailbox" && Number(box.collector_id) === Number(gm) && (await viewersOf(box.id)).some((x) => x.member_id === B && x.via === "migrate"),
      JSON.stringify(box));

    await itemsPool.query(
      `INSERT INTO org_collector(key, preset_key, instance_key, enabled, config) VALUES('pgtest-cu-notion','notion','pgtest-cu',true,$1::jsonb)`,
      [JSON.stringify({ instance: NOTION_INST })]);
    for (const [ext, parent, title] of [["pg-root", null, "맨 위"], ["pg-child", "pg-root", "아래"]]) {
      await itemsPool.query(
        `INSERT INTO knowledge(name, title, body_md, provenance, external_system, external_instance, external_id, parent_external_id)
         VALUES($1,$2,'',  'observed','notion',$3,$4,$5)`, [`pgtest-cu-${ext}`, title, NOTION_INST, ext, parent]);
    }
    await store.syncCollectorUnits();
    const root = await unitBy("pg-root", "notion", NOTION_INST), kid = await unitBy("pg-child", "notion", NOTION_INST);
    chk("M8 노션은 맨 위 페이지만 단위(아래 페이지는 그 안)", root && root.kind === "page" && !kid, JSON.stringify({ root, kid: !!kid }));
    await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE 'pgtest-cu-%'`);
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  await cleanup().catch((e) => console.error("cleanup 실패", e?.message));
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
