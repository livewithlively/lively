// coverage-cache 사양 시험(#5147) — 실 DB 없이 itemsPool.query 를 페이크로 바꿔 «DB 를 몇 번 읽었나» 로만 단언한다.
//  실행: npm run build && node dist/org/distill/coverage-cache.test.js
//
// ── 입력 조합 × 기대 ─────────────────────────────────────────────
// C1 | 빈 캐시에서 두 번 연달아 요청                 | 첫 요청만 센다(둘째는 캐시)
// C2 | 동시에 두 요청(빈 캐시)                       | 한 번만 센다(같은 계산을 함께 기다린다)
// C3 | 레인 저장(bumpCoverageVersion) 뒤 요청         | 다시 센다
// C4 | 계산 도중 레인 저장                           | 그 계산 결과는 캐시에 안 남는다(다음 요청이 다시 센다)
// C5 | 경계: 29.999초 지난 값                        | 그대로(다시 세지 않는다)
// C6 | 30초 지난 값                                  | 옛 값을 바로 돌려주고 뒤에서 다시 센다
// C7 | 10분 지난 값                                  | 기다려서 새로 센다
import assert from "node:assert/strict";
import { itemsPool } from "../../db/client.js";
import { cachedCoverage, _resetCoverageCacheForTest } from "./coverage-cache.js";
import { bumpCoverageVersion } from "./coverage-version.js";

let queries = 0;
let gate: Promise<void> | null = null;
(itemsPool as any).query = async (sql: string) => {
  queries++;
  if (gate) await gate;
  //  org_distiller · org_classifier 목록은 빈 표, count(*) 류는 0 한 줄.
  if (/count\(\*\)/i.test(String(sql))) return { rows: [{ n: 0 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

async function main(): Promise<void> {
  // C1
  _resetCoverageCacheForTest(); queries = 0;
  const a = await cachedCoverage();
  const n1 = queries;
  assert.ok(n1 > 0, "배선: 첫 요청은 DB 를 읽는다(페이크가 실제로 불렸다)");
  assert.equal(a.source.total_undistilled, 0);
  await cachedCoverage();
  assert.equal(queries, n1, "둘째 요청은 캐시");
  ok("C1 연달아 두 번 → 한 번만 센다");

  // C2
  _resetCoverageCacheForTest(); queries = 0;
  await Promise.all([cachedCoverage(), cachedCoverage()]);
  assert.equal(queries, n1, "동시 두 요청도 계산 한 번");
  ok("C2 동시 두 요청 → 한 번만 센다");

  // C3
  queries = 0;
  bumpCoverageVersion();
  await cachedCoverage();
  assert.equal(queries, n1, "무효화 뒤엔 다시 센다");
  ok("C3 레인 저장 뒤 → 다시 센다");

  // C4
  _resetCoverageCacheForTest(); queries = 0;
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  const p = cachedCoverage();
  await settle();
  bumpCoverageVersion();
  open(); gate = null;
  await p;
  queries = 0;
  await cachedCoverage();
  assert.equal(queries, n1, "도중에 바뀐 계산은 캐시에 남지 않는다");
  ok("C4 계산 도중 레인 저장 → 결과를 캐시에 안 넣는다");

  // C5 — 방금(C4 끝) 센 값 기준으로 경계 직전
  queries = 0;
  clock += 29_999;
  await cachedCoverage();
  await settle();
  assert.equal(queries, 0, "30초 직전은 다시 세지 않는다");
  ok("C5 29.999초 → 그대로");

  // C6
  clock += 2;
  //  DB 를 막아 둔 채로 묻는다 — 옛 값을 바로 주면 막힘과 상관없이 응답이 온다.
  let open6!: () => void;
  gate = new Promise<void>((r) => { open6 = r; });
  const answered = await Promise.race([cachedCoverage().then(() => true), settle().then(() => false)]);
  assert.equal(answered, true, "옛 값을 기다림 없이 돌려준다");
  assert.ok(queries > 0, "뒤에서 다시 세기 시작했다");
  open6(); gate = null;
  await settle();
  assert.equal(queries, n1, "뒤에서 다시 센다");
  await cachedCoverage();
  assert.equal(queries, n1, "다시 센 값이 캐시에 들어갔다");
  ok("C6 30초 지난 값 → 옛 값 + 뒤에서 다시 셈");

  // C7
  queries = 0;
  clock += 11 * 60_000;
  await cachedCoverage();
  assert.equal(queries, n1, "오래된 값은 기다려 새로 센다");
  ok("C7 10분 지난 값 → 새로 센다");

  Date.now = realNow;
  console.log(`\n${pass} passed`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
