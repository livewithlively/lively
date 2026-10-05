// 통합검색 기록(#4530 검색 품질 «재는 장치») PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/search-log.pg-test.mjs
//
// 왜 이 계층인가: 약속이 전부 «무엇이 줄로 남고 요약이 무엇을 세나» 다 — 값 깎기(200자 · 모르는 탭·종류 · 음수)와 요약의 FILTER 조건은
//  SQL 과 그 매개변수다. 목 풀로는 조건 하나를 지워도 초록이다. 그래서 넣은 줄을 SELECT 로 되읽고 요약 수를 잰다.
//
//  사양·엣지 표(행마다 판정 하나):
//   | G1 | 결과를 열었다(open)            | 종류 · 열쇠 · 자리 · 층이 남는다                       |
//   | G2 | 안 열고 닫았다(close)          | 연 것 칸은 비어 있다(화면이 실어 보내도)               |
//   | G3 | 빈 검색어 · 요청자 없음        | 남기지 않는다(false)                                   |
//   | G4 | 긴 검색어 · 모르는 탭 · 모르는 종류 · 음수 · NUL | 200자로 · 'all' 로 · NULL 로 · NULL 로 · 걷어서 |
//   | G5 | 요약                           | 찾기 수 · 연 수 · 세션 0건 수 · 연 세션의 자리와 층 · 안 열고 닫은 검색어(자주 나온 것부터) |
//   | G6 | 요약의 기간                    | 기간 밖의 줄은 세지 않는다                             |
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const L = await import(`${DIST}/v6/search-log-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__searchlog_pg_a__", B = "__searchlog_pg_b__";
const cleanup = () => itemsPool.query(`DELETE FROM search_log WHERE member = ANY($1::text[])`, [[A, B]]);
const rows = async (m) => (await itemsPool.query(`SELECT * FROM search_log WHERE member = $1 ORDER BY id`, [m])).rows;

try {
  await cleanup();
  //  요약은 워크스페이스 전체를 센다 — 이 시험이 넣기 전의 수를 빼고 본다.
  const base = await L.searchLogSummary(14);

  // G1
  chk("G1 남기면 true", await L.logSearch({ member: A, q: "  배포 절차  ", tab: "sess", sort: "recent", period: "all", counts: { sess: 7, weak: 2, proj: 3, know: 9 },
    action: "open", opened: { kind: "sess", key: "s:box-1", rank: 1, tier: "match" }, settleMs: 1234, loosened: [] }) === true);
  let r = await rows(A);
  chk("G1 결과를 연 줄 — 검색어(다듬은 것) · 탭 · 수 · 종류 · 열쇠 · 자리 · 층 · 걸린 시간", r.length === 1 && r[0].q === "배포 절차" && r[0].tab === "sess" && r[0].n_sess === 7 && r[0].n_weak === 2
    && r[0].n_proj === 3 && r[0].n_know === 9 && r[0].n_src === null && r[0].action === "open" && r[0].opened_kind === "sess" && r[0].opened_key === "s:box-1"
    && r[0].opened_rank === 1 && r[0].opened_tier === "match" && r[0].settle_ms === 1234, JSON.stringify(r[0]));

  // G2 — 안 열고 닫았으면 연 것 칸은 비운다
  await L.logSearch({ member: A, q: "귤나무정원", tab: "all", counts: { sess: 0, weak: 0 }, action: "close", opened: { kind: "sess", key: "s:x", rank: 3, tier: "weak" }, loosened: ["귤나무정원"] });
  r = await rows(A);
  chk("G2 안 열고 닫은 줄 — 연 것 칸은 비어 있다 · 느슨하게 찾은 낱말이 남는다", r.length === 2 && r[1].action === "close" && r[1].opened_kind === null && r[1].opened_key === null
    && r[1].opened_rank === null && r[1].opened_tier === null && JSON.stringify(r[1].loosened) === JSON.stringify(["귤나무정원"]), JSON.stringify(r[1]));

  // G3
  chk("G3 빈 검색어 · 요청자 없음은 남기지 않는다", (await L.logSearch({ member: A, q: "   ", action: "close" })) === false && (await L.logSearch({ member: "", q: "배포", action: "close" })) === false
    && (await rows(A)).length === 2);

  // G4 — 화면이 보낸 것을 그대로 믿지 않는다
  await L.logSearch({ member: B, q: "가".repeat(300) + "\u0000", tab: "엉뚱한탭", counts: { sess: -5, proj: "많음", know: 3.9 }, action: "open",
    opened: { kind: "엉뚱한종류", key: "k".repeat(500), rank: -1, tier: "t".repeat(50) }, settleMs: 9e12, loosened: ["a", "", 7, "b".repeat(100)] });
  const b = (await rows(B))[0];
  chk("G4 값 깎기 — 200자 · 모르는 탭은 all · 모르는 종류는 NULL · 음수·글자는 NULL · 소수는 버림 · 긴 열쇠는 200자 · 큰 시간은 상한",
    b.q.length === 200 && !b.q.includes("\u0000") && b.tab === "all" && b.n_sess === null && b.n_proj === null && b.n_know === 3 && b.opened_kind === null
    && b.opened_key.length === 200 && b.opened_rank === null && b.opened_tier.length === 16 && b.settle_ms === 600000
    && JSON.stringify(b.loosened) === JSON.stringify(["a", "b".repeat(60)]), JSON.stringify({ ...b, q: b.q.length, opened_key: b.opened_key.length }));

  // G5 — 요약
  await L.logSearch({ member: A, q: "귤나무정원", tab: "all", counts: { sess: 0, weak: 0 }, action: "close" });
  await L.logSearch({ member: A, q: "감나무", tab: "all", counts: { sess: 4, weak: 1 }, action: "close" });
  await L.logSearch({ member: A, q: "감나무", tab: "sess", counts: { sess: 4, weak: 1 }, action: "open", opened: { kind: "sess", key: "s:2", rank: 3, tier: "match" } });
  await L.logSearch({ member: A, q: "석류즙", tab: "sess", counts: { sess: 0, weak: 2 }, action: "open", opened: { kind: "sess", key: "s:3", rank: 12, tier: "weak" } });
  await L.logSearch({ member: A, q: "문서", tab: "know", counts: { sess: 1, know: 5 }, action: "open", opened: { kind: "know", key: "k:doc", rank: 2 } });
  const s = await L.searchLogSummary(14);
  const d = (k) => s[k] - base[k];
  chk("G5 요약 — 찾기 8 · 연 것 5(B 의 한 줄은 종류를 모르는 open) · 세션이 하나도 없던 찾기 2(수를 모르는 B 의 줄은 0건이 아니다) · 느슨하게 찾은 찾기 2",
    d("total") === 8 && d("opened") === 5 && d("zeroSess") === 2 && d("loosened") === 2, JSON.stringify({ total: d("total"), opened: d("opened"), zero: d("zeroSess"), loosened: d("loosened") }));
  chk("G5 연 세션의 자리 — 1위 1 · 2~3위 1 · 10위 밖 1 · 층은 맞는 결과 2 · 덜 맞는 결과 1 · 종류별 수",
    s.sessRank.first - base.sessRank.first === 1 && s.sessRank.top3 - base.sessRank.top3 === 1 && s.sessRank.beyond - base.sessRank.beyond === 1 && s.sessRank.top10 - base.sessRank.top10 === 0
    && (s.sessTier.match || 0) - (base.sessTier.match || 0) === 2 && (s.sessTier.weak || 0) - (base.sessTier.weak || 0) === 1
    && (s.byKind.sess || 0) - (base.byKind.sess || 0) === 3 && (s.byKind.know || 0) - (base.byKind.know || 0) === 1, JSON.stringify({ rank: s.sessRank, tier: s.sessTier, kind: s.byKind }));
  const ab = s.abandoned.find((x) => x.q === "귤나무정원"), ab2 = s.abandoned.find((x) => x.q === "감나무");
  chk("G5 안 열고 닫은 검색어 — 두 번 나온 것이 한 번 나온 것보다 앞 · 0건이었는지 표시", !!ab && ab.n === 2 && ab.zero === true && !!ab2 && ab2.n === 1 && ab2.zero === false
    && s.abandoned.findIndex((x) => x.q === "귤나무정원") < s.abandoned.findIndex((x) => x.q === "감나무"), JSON.stringify(s.abandoned.slice(0, 6)));

  // G6 — 기간 밖의 줄은 세지 않는다
  //  G7 묵은 줄 지우기 — 180일 넘은 줄만 지운다(세션 기록 보존 정리에 얹혀 돈다). 쓰는 길의 «가끔» 이 아니다.
  {
    await L.logSearch({ member: A, q: "아주 옛날 검색어", action: "close" });
    await itemsPool.query(`UPDATE search_log SET ts = now() - interval '181 days' WHERE member = $1 AND q = '아주 옛날 검색어'`, [A]);
    const before = (await itemsPool.query(`SELECT count(*)::int AS n FROM search_log WHERE member = $1`, [A])).rows[0].n;
    const gone = await L.reapSearchLog();
    const after = (await itemsPool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE q = '아주 옛날 검색어')::int AS old FROM search_log WHERE member = $1`, [A])).rows[0];
    chk("G7 180일 넘은 줄만 지운다", gone >= 1 && after.old === 0 && after.n === before - 1, JSON.stringify({ gone, before, after }));
  }
  await itemsPool.query(`UPDATE search_log SET ts = now() - interval '30 days' WHERE member = $1 AND q = '문서'`, [A]);
  const s2 = await L.searchLogSummary(14);
  chk("G6 기간 밖(30일 전)으로 옮긴 줄은 14일 요약에서 빠지고 60일 요약에는 든다", s2.total === s.total - 1 && (await L.searchLogSummary(60)).total - (await L.searchLogSummary(14)).total >= 1, JSON.stringify([s.total, s2.total]));
} catch (e) {
  bad("예외", String(e && e.stack || e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
