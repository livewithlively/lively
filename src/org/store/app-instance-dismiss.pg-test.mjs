// 세션 «보임 축» 저장(#3855 · #3857) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/store/app-instance-dismiss.pg-test.mjs
//
// 왜 이 계층인가: 치움의 정본은 org_app_instance 한 표의 두 칸(status · closed_reason)이고, 판정은 전부 SQL 조건에 있다
//  — «사유가 user 인 것만» · «이미 user 로 닫힌 행은 안 건드림(멱등)» · «행이 없으면 만든다» · «남의 행 불가» ·
//  «되살리기가 치움을 풀지 않는다». 목 풀로는 조건 하나를 지워도 초록이다. 그래서 **부작용을 SELECT 로 되읽어** 판정한다.
//
//  사양·엣지 표: 스크래치패드 workerA-spec.md — D1~D9(저장) · R1~R5(되살리기 승계).
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const inst = await import(`${DIST}/org/store/app-instances.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__dismiss_pg_a__", B = "__dismiss_pg_b__";
const S = (x) => `box-__pgtest-dismiss-${x}`;

const rowsOf = async (owner, ref) => (await itemsPool.query(
  `SELECT id, app_id, status, closed_reason, closed_at FROM org_app_instance
    WHERE owner_member=$1 AND subject_kind='session' AND subject_ref=$2 ORDER BY created_at`, [owner, ref])).rows;
const one = async (owner, ref) => { const r = await rowsOf(owner, ref); return r.length === 1 ? r[0] : { n: r.length }; };
const open = (owner, ref) => inst.createAppInstance({ appId: "ai-session", owner, projectId: null, subjectKind: "session", subjectRef: ref });

async function cleanup() {
  const ids = (await itemsPool.query(`SELECT id FROM org_app_instance WHERE owner_member = ANY($1::text[])`, [[A, B]])).rows.map((r) => r.id);
  if (ids.length) await itemsPool.query(`DELETE FROM org_app_instance_project WHERE instance_id = ANY($1::text[])`, [ids]);
  await itemsPool.query(`DELETE FROM org_app_instance WHERE owner_member = ANY($1::text[])`, [[A, B]]);
}

try {
  await cleanup();

  // ── D1 행이 없는(한 번도 안 연) 세션을 치운다 → closed·user 행이 생긴다 ──
  {
    const n = await inst.dismissSessionInstances(A, [S(1)]);
    const r = await one(A, S(1));
    chk("D1 한 번도 안 연 세션을 치우면 closed·user 행이 생긴다", n === 1 && r.status === "closed" && r.closed_reason === "user" && !!r.closed_at,
      JSON.stringify({ n, r }));
  }

  // ── D2 active 인스턴스를 치운다 ──
  {
    await open(A, S(2));
    const n = await inst.dismissSessionInstances(A, [S(2)]);
    const r = await one(A, S(2));
    chk("D2 목록에 둔(active) 세션을 치우면 closed·user", n === 1 && r.status === "closed" && r.closed_reason === "user", JSON.stringify({ n, r }));
  }

  // ── D3 시스템이 닫은 행을 사람이 치운다 → user 로 바뀐다 ──
  {
    await open(A, S(3));
    await inst.closeSessionAppInstances(S(3), "restore");
    const before = await one(A, S(3));
    const n = await inst.dismissSessionInstances(A, [S(3)]);
    const r = await one(A, S(3));
    chk("D3 시스템이 닫은(restore) 행도 사람이 치우면 user 로 바뀐다(행이 새로 생기지 않는다)",
      before.closed_reason === "restore" && n === 1 && r.status === "closed" && r.closed_reason === "user", JSON.stringify({ before, n, r }));
  }

  // ── D4 멱등 — 두 번 치워도 행 1개, 치운 시각이 그대로 ──
  {
    const first = await one(A, S(1));
    const n = await inst.dismissSessionInstances(A, [S(1)]);
    const r = await rowsOf(A, S(1));
    chk("D4 두 번 치워도 행 1개 · 두 번째는 바꾼 행 0 · 치운 시각 그대로(멱등)",
      n === 0 && r.length === 1 && String(r[0].closed_at) === String(first.closed_at), JSON.stringify({ n, rows: r.length }));
  }

  // ── D8 세션 종료 계열 닫기는 그 사유가 남는다 ──
  {
    for (const [x, why] of [[81, "kill"], [82, "purge"], [83, "janitor"]]) {
      await open(A, S(x));
      await inst.closeSessionAppInstances(S(x), why);
    }
    const [k, p, j] = [await one(A, S(81)), await one(A, S(82)), await one(A, S(83))];
    chk("D8 시스템 닫기(kill·purge·janitor)는 그 사유가 남는다",
      k.closed_reason === "kill" && p.closed_reason === "purge" && j.closed_reason === "janitor", JSON.stringify({ k, p, j }));
    await open(A, S(84));
    await inst.closeAppInstance((await one(A, S(84))).id, A, "system");
    chk("D8′ 열기 실패 뒷정리(closeAppInstance system)도 user 가 아니다", (await one(A, S(84))).closed_reason === "system");
  }

  // ── D5 치운 세션 목록 — user 사유만, 내 것만 ──
  {
    await inst.dismissSessionInstances(B, [S(9)]);
    const refs = new Set(await inst.listDismissedSessionRefs(A));
    const full = (await inst.listDismissedSessionInstances(A)).map((r) => r.subject_ref);
    chk("D5 치운 세션 목록은 user 사유만 — 시스템이 닫은 것(kill·purge·janitor·system)은 없다",
      refs.has(S(1)) && refs.has(S(2)) && refs.has(S(3)) && ![81, 82, 83, 84].some((x) => refs.has(S(x))), JSON.stringify([...refs]));
    chk("D5′ 남의 치움은 내 목록에 없다 · 화면용 전체 목록도 같은 집합", !refs.has(S(9)) && full.length === refs.size && full.every((x) => refs.has(x)),
      JSON.stringify({ full }));
  }

  // ── D6 되돌리기 — user 만 되돌린다 ──
  {
    const n = await inst.reopenSessionInstances(A, [S(2), S(81)]);
    const [r2, r81] = [await one(A, S(2)), await one(A, S(81))];
    chk("D6 되돌리기는 사람이 치운 것만 active 로(사유 비움) — kill 로 닫힌 건 되살리지 않는다",
      n === 1 && r2.status === "active" && r2.closed_reason === null && r81.status === "closed" && r81.closed_reason === "kill",
      JSON.stringify({ n, r2, r81 }));
  }

  // ── D7 다시 열기(화면의 멱등 생성 경로) → active · 사유 비움 ──
  {
    await open(A, S(1));
    const r = await one(A, S(1));
    chk("D7 치운 세션을 다시 열면 목록에 둠(active) · 사유가 지워진다", r.status === "active" && r.closed_reason === null, JSON.stringify(r));
  }

  // ── D9 남의 행 불가 ──
  {
    await inst.dismissSessionInstances(A, [S(5)]);
    const nOpen = await inst.reopenSessionInstances(B, [S(5)]);
    const nShut = await inst.dismissSessionInstances(B, [S(2)]);   // A 의 S(2) 는 D6 에서 active
    const [a5, a2, b2] = [await one(A, S(5)), await one(A, S(2)), await rowsOf(B, S(2))];
    chk("D9 남이 되돌려도 내 치움은 그대로 · 남이 치워도 내 목록에 둠은 그대로(바뀌는 건 그 사람 행뿐)",
      nOpen === 0 && a5.status === "closed" && a5.closed_reason === "user" && a2.status === "active" && nShut === 1 && b2.length === 1 && b2[0].closed_reason === "user",
      JSON.stringify({ nOpen, a5, a2, b2 }));
  }

  // ── R — 되살리기가 치움을 풀지 않는다(restore 꼬리: 새 id 등록 → 승계 → 옛 id 닫기) ──
  {
    const oldId = S("r-old"), newId = S("r-new");
    await open(A, oldId); await inst.dismissSessionInstances(A, [oldId]);      // A 가 치움
    await open(B, oldId); await inst.dismissSessionInstances(B, [oldId]);      // B 도 각자 치움
    await open(A, newId);                                                       // registerSessionInstance(새 id, 소유자)
    const carried = await inst.carrySessionDismissals(oldId, newId);
    await inst.closeSessionAppInstances(oldId, "restore");
    const [aNew, bNew, aOld] = [await one(A, newId), await one(B, newId), await one(A, oldId)];
    chk("R1 치운 세션을 일괄 복원해도 새 id 는 치운 채(closed·user) — 목록에 안 돌아온다",
      carried === 2 && aNew.status === "closed" && aNew.closed_reason === "user", JSON.stringify({ carried, aNew }));
    chk("R5 옛 id 를 각자 치운 두 사람 모두 새 id 에서 치운 채", bNew.status === "closed" && bNew.closed_reason === "user", JSON.stringify(bNew));
    const refs = new Set(await inst.listDismissedSessionRefs(A));
    chk("R3 되살린 옛 id 는 「치운 세션」에 안 뜬다 · 새 id 만 뜬다(같은 세션 두 줄 방지)",
      refs.has(newId) && !refs.has(oldId) && aOld.closed_reason === "restore", JSON.stringify({ refs: [...refs], aOld }));
    await open(A, newId);
    const aOpened = await one(A, newId);
    chk("R2 그 뒤 사람이 직접 열면 새 id 가 목록에 둠(active)", aOpened.status === "active" && aOpened.closed_reason === null, JSON.stringify(aOpened));
  }
  {
    const oldId = S("k-old"), newId = S("k-new");
    await open(A, oldId);                                                       // 치우지 않았다
    await open(A, newId);
    const carried = await inst.carrySessionDismissals(oldId, newId);
    await inst.closeSessionAppInstances(oldId, "restore");
    const aNew = await one(A, newId);
    chk("R4 치우지 않은 세션을 복원하면 새 id 는 목록에 둠 — 승계할 것이 없다", carried === 0 && aNew.status === "active", JSON.stringify({ carried, aNew }));
  }
} catch (e) {
  bad("예외", e && e.stack || String(e));
} finally {
  await cleanup().catch((e) => console.error("정리 실패", e));
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
