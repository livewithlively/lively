// 새 셸 개인화 저장(#2460 · #3887) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/shell-pref-store.pg-test.mjs
//
// 왜 이 계층인가: 이 절의 판정은 전부 **DB 가 무엇을 돌려주나** 에 있다.
//  · 저장소 단위 병합은 SQL 한 문장(`prefs - 지울 칸 || 넣을 칸`)이다 — 목 풀로는 연산자 하나를 지워도 초록이다.
//  · jsonb 는 객체 키 순서를 지키지 않는다 — «넘치면 오래된 치움부터 버린다» 는 순서 칸(~order)이 실제 jsonb 를
//    지나서도 순서를 되살려야 성립한다. 순수 시험은 jsonb 가 정말 순서를 흐트러뜨리는지부터 못 본다.
//  그래서 **부작용을 SELECT 로 되읽어** 판정한다.
//
//  사양·엣지 표: 스크래치패드 spec.md — E16~E21 · O2·O3.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/v6/shell-pref-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const A = "__shellpref_pg_a__", B = "__shellpref_pg_b__";
const PIN = "lively_v2_app_pin", OPENED = "lively_v2_side_grpopened", DISMISS = "lively_v2_side_dismissed", GROUP = "lively_v2_side_group";
const ORDER = `~order:${DISMISS}`;

/** DB 에 실제로 적힌 문서(정규화 전). */
const raw = async (m) => (await itemsPool.query(`SELECT prefs FROM member_shell_pref WHERE member_id = $1`, [m])).rows[0]?.prefs ?? null;
const cleanup = () => itemsPool.query(`DELETE FROM member_shell_pref WHERE member_id = ANY($1::text[])`, [[A, B]]);

try {
  await cleanup();

  // ── E18 행이 없는 멤버의 patch → 행이 생기고 그 저장소만 담긴다 ──
  {
    const r = await store.patchShellPrefs(A, { [PIN]: ["sess:box-1"] });
    const db = await raw(A);
    chk("E18 행이 없어도 patch 가 행을 만들고 그 저장소만 담는다",
      r.saved === true && same(r.prefs, { [PIN]: ["sess:box-1"] }) && same(db, { [PIN]: ["sess:box-1"] }), JSON.stringify({ r, db }));
  }

  // ── ★E16 patch 는 **든 저장소만** 바꾼다 — 다른 기기가 해 둔 저장소는 그대로 ──
  {
    await store.setShellPrefs(A, { [PIN]: ["sess:box-1"], [OPENED]: ["p:1"], [DISMISS]: { "route:sources": "" }, [GROUP]: "proj" });
    const r = await store.patchShellPrefs(A, { [OPENED]: ["p:1", "p:2"] });
    const db = await raw(A);
    chk("★E16 patch 한 저장소만 바뀌고 나머지(고정·치움·묶는 축)는 그대로다 — 낡은 기기의 접힘 저장이 다른 기기의 고정을 덮지 않는다",
      same(db[OPENED], ["p:1", "p:2"]) && same(db[PIN], ["sess:box-1"]) && same(db[DISMISS], { "route:sources": "" }) && db[GROUP] === "proj"
        && same(r.prefs[PIN], ["sess:box-1"]) && r.prefs[GROUP] === "proj",
      JSON.stringify({ db, r: r.prefs }));
  }

  // ── E17 null · 빈 값 = 그 저장소를 지운다(맵이면 순서 칸도) ──
  {
    await store.patchShellPrefs(A, { [OPENED]: null });
    const afterNull = await raw(A);
    await store.patchShellPrefs(A, { [DISMISS]: {} });
    const afterEmpty = await raw(A);
    chk("E17 patch 의 null 은 그 저장소를 지운다(나머지 그대로)",
      !(OPENED in afterNull) && same(afterNull[PIN], ["sess:box-1"]) && afterNull[GROUP] === "proj", JSON.stringify(afterNull));
    chk("E17 patch 의 빈 맵은 그 저장소와 **순서 칸까지** 지운다",
      !(DISMISS in afterEmpty) && !(ORDER in afterEmpty) && same(afterEmpty[PIN], ["sess:box-1"]), JSON.stringify(afterEmpty));
  }

  // ── E19 patch 가 없는 저장(구버전 화면)은 종전대로 통째 교체 ──
  {
    const r = await store.setShellPrefs(A, { [GROUP]: "proj" });
    const db = await raw(A);
    chk("E19 prefs 만 오면 통째 교체다 — 요청에 없는 저장소는 지워진다(구버전 화면의 «비움» 이 서버에 닿는다)",
      same(db, { [GROUP]: "proj" }) && same(r.prefs, { [GROUP]: "proj" }), JSON.stringify(db));
  }

  // ── E20 허용목록 밖 키만 든 patch 는 아무것도 안 바꾼다 ──
  {
    const before = await raw(A);
    const r = await store.patchShellPrefs(A, { evil_store: ["x"], "~order:lively_v2_side_dismissed": ["route:x"] });
    const db = await raw(A);
    chk("E20 허용목록 밖 키(저장 전용 순서 칸 포함)만 든 patch 는 문서를 안 바꾸고 지금 문서를 돌려준다",
      same(db, before) && same(r.prefs, { [GROUP]: "proj" }), JSON.stringify({ before, db, r }));
  }

  // ── ★E21 patch 에도 상한·형식이 걸리고, 버린 개수를 알린다 ──
  {
    const map = {};
    for (let i = 0; i < 501; i++) map[`route:raw:projects2/p/${i}`] = "";
    map["route:raw:activate?code=ZZZZ-0000"] = "";
    const r = await store.patchShellPrefs(A, { [DISMISS]: map });
    const db = await raw(A);
    const keys = Object.keys(r.prefs[DISMISS] || {});
    chk("★E21 patch 의 넘침은 오래된 쪽을 버리고(방금 것 남음) 쓰레기 키는 없다",
      keys.length === 500 && keys[0] === "route:raw:projects2/p/1" && keys[499] === "route:raw:projects2/p/500" && !keys.some((k) => k.includes("activate")),
      JSON.stringify({ n: keys.length, first: keys[0], last: keys[499] }));
    chk("E21 버린 개수를 응답으로 알린다(값은 싣지 않는다)",
      Object.keys(r.dropped || {}).length === 1 && r.dropped?.[DISMISS]?.overflow === 1 && r.dropped?.[DISMISS]?.invalid === 1
        && !JSON.stringify(r.dropped).includes("ZZZZ"), JSON.stringify(r.dropped));
    chk("E21 DB 에도 500 항목 + 같은 순서의 순서 칸이 적힌다",
      Object.keys(db[DISMISS]).length === 500 && Array.isArray(db[ORDER]) && same(db[ORDER], keys), JSON.stringify({ n: Object.keys(db[DISMISS]).length, order: (db[ORDER] || []).length }));
  }

  // ── ★O2 jsonb 는 객체 키 순서를 흐트러뜨린다 → 순서 칸이 **조회에서** 순서를 되살린다 ──
  {
    await cleanup();
    const long = "route:raw:projects2/p/1", short = "route:sources";   // 치운 순서: 긴 키 → 짧은 키
    await store.patchShellPrefs(A, { [DISMISS]: { [long]: "", [short]: "" } });
    const db = await raw(A);
    const got = await store.getShellPrefs(A);
    //  전제부터 잰다 — jsonb 가 정말 순서를 바꾸지 않는다면 이 시험은 아무것도 증명하지 않는다.
    chk("O2 (전제) jsonb 가 객체 키를 짧은 것부터 다시 늘어놓는다", same(Object.keys(db[DISMISS]), [short, long]), JSON.stringify(Object.keys(db[DISMISS])));
    chk("★O2 조회는 치운 순서(긴 키 → 짧은 키)를 되살린다 — 없으면 넘칠 때 «오래된 것» 이 아니라 «짧은 키» 가 먼저 나간다",
      same(Object.keys(got.prefs[DISMISS]), [long, short]), JSON.stringify(Object.keys(got.prefs[DISMISS])));
  }

  // ── O3 통째 교체(구버전 화면) 경로도 순서 칸을 적는다 ──
  {
    const long = "route:raw:projects2/p/9", short = "route:home";
    await store.setShellPrefs(A, { [DISMISS]: { [long]: "", [short]: "" } });
    const got = await store.getShellPrefs(A);
    chk("O3 통째 교체로 저장한 맵도 조회에서 순서가 되살아난다", same(Object.keys(got.prefs[DISMISS]), [long, short]), JSON.stringify(Object.keys(got.prefs[DISMISS])));
  }

  // ── O4 순서 칸이 없는 옛 문서(옛 서버가 쓴 것)도 읽힌다 ──
  {
    await itemsPool.query(`UPDATE member_shell_pref SET prefs = $2::jsonb WHERE member_id = $1`,
      [A, JSON.stringify({ [DISMISS]: { "route:raw:projects2/p/7": "", "route:home": "done" }, [GROUP]: "proj" })]);
    const got = await store.getShellPrefs(A);
    chk("O4 순서 칸 없는 옛 문서도 맵·다른 저장소가 온전히 내려간다",
      Object.keys(got.prefs[DISMISS]).length === 2 && got.prefs[DISMISS]["route:home"] === "done" && got.prefs[GROUP] === "proj", JSON.stringify(got.prefs));
  }

  // ── E16′ 동시에 온 두 patch(다른 저장소)가 서로를 지우지 않는다 — 한 문장 병합 ──
  {
    await cleanup();
    await store.setShellPrefs(B, { [GROUP]: "proj" });
    let lost = 0;
    for (let i = 0; i < 20; i++) {
      await Promise.all([
        store.patchShellPrefs(B, { [PIN]: [`sess:box-${i}`] }),
        store.patchShellPrefs(B, { [OPENED]: [`p:${i}`] }),
      ]);
      const db = await raw(B);
      if (!(same(db[PIN], [`sess:box-${i}`]) && same(db[OPENED], [`p:${i}`]) && db[GROUP] === "proj")) lost++;
    }
    chk("E16′ 동시 patch 20판 모두 두 저장소가 함께 남는다(읽고-고쳐-쓰기였다면 한쪽이 사라진다)", lost === 0, `잃은 판 ${lost}/20`);
  }

  // ── 남의 행 불가 — patch 는 자기 행만 ──
  {
    await store.setShellPrefs(A, { [GROUP]: "proj" });
    await store.patchShellPrefs(B, { [GROUP]: null });
    const a = await raw(A);
    chk("E16″ 다른 멤버의 patch 가 내 행을 안 건드린다", a && a[GROUP] === "proj", JSON.stringify(a));
  }
} catch (e) {
  bad("예외", e && e.stack ? e.stack : String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
