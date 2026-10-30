// 로그인 판 작업 행(org_login_job) PG 통합 테스트 (#4067) — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/terminal/login-job-store.pg-test.mjs
//
// 왜 이 계층인가: 작업 수명의 규칙이 전부 SQL 조건에 있다 — «살아 있을 때만 끝낸다(먼저 온 끝이 이긴다)» ·
//  «붙여넣기는 꺼내며 지운다(동시 박동에도 한 번)» · «돌지 않은 행만 지운다» · «정리 감시는 살아 있거나 안 치운 행만».
//  가짜 저장소(login-job.test)는 이 규칙을 흉내 낼 뿐이라, 조건 하나를 지워도 그쪽은 초록이다. 그래서 되읽어 판정한다.
//  워크스페이스 격리(RLS·앱 role)는 scripts/login-job-store.itest.mjs(docker)가 본다 — 이 잡의 DB 는 소유자 접속이다.
//  사양·엣지 표: 스크래치패드 spec-4067-core.md — K8·K9·K15·K18·K25·K26 의 SQL 쪽.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const S = await import(`${DIST}/terminal/login-job-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return String(e?.message ?? e); } };

const M1 = "__loginjob_pg_1__", M2 = "__loginjob_pg_2__";
const cleanup = () => itemsPool.query(`DELETE FROM org_login_job WHERE member_id = ANY($1::text[])`, [[M1, M2]]);
const mk = (o = {}) => S.createLoginJob({ memberId: M1, harness: "codex", purpose: "login", secretHash: S.newJobSecret().hash, adminBasis: "none", ...o });

try {
  await cleanup();

  // ── P1 만들기 · 기본값 · 해시만 ──
  {
    const sec = S.newJobSecret();
    const j = await mk({ harness: "claude", purpose: "headless", secretHash: sec.hash, adminBasis: "member" });
    chk("P1 만들기 — starting · 빈 화면 · 박동 없음 · 근거 보존 · id 는 숫자",
      typeof j.id === "number" && j.status === "starting" && j.screen === "" && j.paste === null && j.unit_seen_at === null
        && j.admin_basis === "member" && j.reaped === false && j.created_at instanceof Date, JSON.stringify(j));
    chk("P1 해시로 대조한다 · 원문은 행에 없다",
      S.jobSecretMatches(j, sec.secret) && !S.jobSecretMatches(j, sec.secret + "x") && !JSON.stringify(j).includes(sec.secret));
  }

  // ── P2 running 표시는 starting 에서 한 번만 ──
  {
    const j = await mk();
    const a = await S.markLoginJobRunning(j.id, "lvly-task-t-1-l1");
    const b = await S.markLoginJobRunning(j.id, "lvly-task-t-2-l1");
    const r = await S.getLoginJob(j.id);
    chk("P2 running 표시는 한 번만(두 번째 유닛 이름은 무시)", a === "running" && b === null && r.status === "running" && r.unit === "lvly-task-t-1-l1",
      JSON.stringify({ a, b, r }));
  }

  // ── P2b 띄우는 사이에 끝난 작업 — 유닛은 적고 상태는 그대로 · 치움 표시를 되돌린다 ──
  {
    const j = await mk();
    await S.finishLoginJob(j.id, "cancelled", {});
    await S.markLoginJobReaped(j.id);   // 유닛을 모른 채 치움 표시가 먼저 찍힌 경우
    const st = await S.markLoginJobRunning(j.id, "lvly-task-t-3-l1");
    const r = await S.getLoginJob(j.id);
    const open = (await S.openLoginJobs()).some((x) => x.id === j.id);
    chk("P2b 끝난 행에도 유닛을 적고, 감시가 다시 보게 한다", st === "cancelled" && r.status === "cancelled" && r.unit === "lvly-task-t-3-l1"
      && r.reaped === false && open, JSON.stringify({ st, r, open }));
  }

  // ── P3 박동: 화면·박동 시각 · 붙여넣기는 꺼내며 지운다 ──
  {
    const j = await mk();
    const set = await S.setLoginJobPaste(j.id, "enc:1");
    const t1 = await S.tickLoginJob(j.id, "화면 1");
    const t2 = await S.tickLoginJob(j.id, "화면 2");
    const r = await S.getLoginJob(j.id);
    chk("P3 붙여넣기 한 번 · 화면 갱신 · 박동 시각", set === true && t1?.paste === "enc:1" && t2?.paste === null
      && r.screen === "화면 2" && r.unit_seen_at instanceof Date && r.paste === null, JSON.stringify({ t1, t2, r }));
  }

  // ── P4 동시 박동에도 코드는 한 번 ──
  {
    const j = await mk();
    let once = true;
    for (let i = 0; i < 5; i++) {
      await S.setLoginJobPaste(j.id, `enc:race-${i}`);
      const got = await Promise.all(Array.from({ length: 6 }, (_, k) => S.tickLoginJob(j.id, `동시 ${k}`)));
      const delivered = got.filter((g) => g && g.paste);
      if (delivered.length !== 1 || delivered[0].paste !== `enc:race-${i}`) { once = false; bad("P4", JSON.stringify(got)); break; }
    }
    if (once) ok("P4 동시 박동 6개 × 5회 — 코드는 매번 정확히 한 번");
  }

  // ── P5 끝: 살아 있을 때만 · 먼저 온 끝이 이긴다 · 끝나며 코드를 지운다 ──
  {
    const j = await mk();
    await S.setLoginJobPaste(j.id, "enc:left");
    const a = await S.finishLoginJob(j.id, "cancelled", { error: "취소" });
    const b = await S.finishLoginJob(j.id, "done", {});
    const r = await S.getLoginJob(j.id);
    chk("P5 먼저 온 끝이 이긴다 · 코드 삭제 · 끝난 시각", a === true && b === false && r.status === "cancelled" && r.error === "취소"
      && r.paste === null && r.finished_at instanceof Date, JSON.stringify({ a, b, r }));
    const t = await S.tickLoginJob(j.id, "끝난 뒤");
    const p = await S.setLoginJobPaste(j.id, "enc:late");
    const r2 = await S.getLoginJob(j.id);
    chk("P5 끝난 작업엔 박동·코드가 안 먹는다", t === null && p === false && r2.screen === r.screen && r2.paste === null, JSON.stringify({ t, p, r2 }));
  }

  // ── P6 끝의 부가 칸 — 준 것만 바꾼다 ──
  {
    const j = await mk();
    await S.tickLoginJob(j.id, "박동 화면");
    await S.finishLoginJob(j.id, "failed", { exitCode: 3 });
    const r = await S.getLoginJob(j.id);
    const k = await mk();
    await S.tickLoginJob(k.id, "박동 화면");
    await S.finishLoginJob(k.id, "expired", { error: "사유", screen: "끝 화면" });
    const r2 = await S.getLoginJob(k.id);
    chk("P6 사유·종료코드·화면은 준 것만", r.exit_code === 3 && r.error === null && r.screen === "박동 화면"
      && r2.error === "사유" && r2.screen === "끝 화면" && r2.exit_code === null, JSON.stringify({ r, r2 }));
  }

  // ── P7 최근 작업 — (사람·용도·하네스) 별 가장 큰 id ──
  {
    const a = await mk({ memberId: M2, harness: "grok" });
    const b = await mk({ memberId: M2, harness: "grok" });
    await mk({ memberId: M2, harness: "grok", purpose: "headless" });   // 용도가 다르면 다른 시도
    const c = await mk({ memberId: M2, harness: "codex" });
    const got = await S.latestLoginJob(M2, "login", "grok");
    const none = await S.latestLoginJob(M2, "login", "claude");
    const other = await S.latestLoginJob("__nobody__", "login", "grok");
    chk("P7 최근 작업", got?.id === b.id && got.id > a.id && none === null && other === null
      && (await S.latestLoginJob(M2, "login", "codex"))?.id === c.id, JSON.stringify({ a: a.id, b: b.id, got: got?.id }));
  }

  // ── P8 정리 감시 대상 — 살아 있거나 안 치운 것 · id 순 · 상한 ──
  {
    await cleanup();
    const live = await mk();
    const done = await mk();
    await S.finishLoginJob(done.id, "done", {});
    const reaped = await mk();
    await S.finishLoginJob(reaped.id, "failed", {});
    await S.markLoginJobReaped(reaped.id);
    const liveReaped = await mk();
    await S.markLoginJobReaped(liveReaped.id);
    const ids = (await S.openLoginJobs()).map((r) => r.id).filter((id) => [live.id, done.id, reaped.id, liveReaped.id].includes(id));
    const lim = await S.openLoginJobs(1);
    chk("P8 살아 있거나 안 치운 행만(치운 끝난 행 제외) · id 순", JSON.stringify(ids) === JSON.stringify([live.id, done.id, liveReaped.id]), JSON.stringify(ids));
    chk("P8 상한", lim.length === 1, String(lim.length));
  }

  // ── P9 지우기는 돌지 않은 행만 ──
  {
    const a = await mk();
    await S.deleteLoginJob(a.id);
    const b = await mk();
    await S.markLoginJobRunning(b.id, "lvly-task-t-9-l1");
    await S.deleteLoginJob(b.id);
    const c = await mk();
    await S.finishLoginJob(c.id, "failed", {});
    await S.deleteLoginJob(c.id);
    chk("P9 starting 행만 지운다", (await S.getLoginJob(a.id)) === null && (await S.getLoginJob(b.id)) !== null && (await S.getLoginJob(c.id)) !== null);
  }

  // ── P10 CHECK · 형식 밖 id ──
  {
    const e1 = await rejects(() => mk({ purpose: "admin" }));
    const e2 = await rejects(() => mk({ adminBasis: "root" }));
    const j = await mk();
    const e3 = await rejects(() => S.finishLoginJob(j.id, "weird", {}));
    chk("P10 CHECK — 모르는 용도·근거·상태", /check constraint/i.test(e1 ?? "") && /check constraint/i.test(e2 ?? "") && /check constraint/i.test(e3 ?? "")
      && (await S.getLoginJob(j.id)).status === "starting", JSON.stringify({ e1, e2, e3 }));
    let allNull = true;
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 60]) if ((await S.getLoginJob(id)) !== null) allNull = false;
    chk("P10 형식 밖 id 는 null", allNull);
  }

  // ── P11 화면 박동 ──
  {
    const j = await mk();
    const before = (await S.getLoginJob(j.id)).ui_seen_at.getTime();
    await new Promise((r) => setTimeout(r, 20));
    await S.touchLoginJobUi(j.id);
    chk("P11 화면 박동이 시각을 올린다", (await S.getLoginJob(j.id)).ui_seen_at.getTime() > before);
  }
} catch (e) {
  bad("예외", String(e?.stack ?? e));
} finally {
  await cleanup().catch(() => undefined);
  await itemsPool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
