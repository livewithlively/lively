// 커버리지의 «사각지대 0» 은 뜻이 둘이다 — 그걸 가르는 값을 싣는지.
//
// 배경: 사각지대(uncovered)는 **판정 기록(org_stranded_seen)을 뺀 남은 몫**이다. 배치가 집을 집합과
//  화면 숫자를 일치시키려고 그렇게 정했다. 그 대가로 0 이 두 상태를 가리키게 됐다:
//    ① 켜진 레인이 전부 담당한다(해소됨)   ② 아무도 담당 안 하지만 폴백이 이미 훑고 버렸다(해소 안 됨)
//  ②를 ①로 읽으면 운영자는 레인을 안 붙이고, 새 자료가 올 때마다 폴백이 계속 돈다.
//  레인 축은 이 구분을 이미 갖고 있다(backlog=잔량 vs reviewed=판정) — 방치 축에도 같은 짝을 준다.
//
// ── 입력 조합 × 기대 (엣지 표 — 행마다 테스트 ≥1) ─────────────────────────────
// #  | 판정 기록 표의 상태  | 기대
// A  | 행 N건 존재          | uncovered_reviewed = N
// B  | 행 0건               | uncovered_reviewed = 0 (없는 값·undefined 가 아니라 **숫자 0**)
//
// ⚠ «표가 아예 없는 배포» 는 이 축의 엣지가 **아니다.** 바로 앞의 사각지대·채널 질의가 쓰는
//  strandedWhereSql 자체가 그 표를 배제절로 참조하므로, 표가 없으면 이 집계에 닿기 전에 이미 죽는다.
//  그래서 이 한 줄만 catch 로 감싸는 것은 «표가 없어도 패널이 산다» 는 없는 보장을 꾸며내는 것이라
//  일부러 맨몸으로 뒀다(표는 부팅의 initIngestPolicyAndDistillers 가 만든다. 레인 짝인
//  countDistillerSeen 도 같은 이유로 맨몸이다). 이 주석이 그 판단의 기록이다.
//
// 실행: npm run build && node dist/org/distill/coverage-stranded.test.js
import assert from "node:assert/strict";
import { itemsPool } from "../../db/client.js";
import { distillerCoverage } from "./distiller.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

// ── 얇은 Db 페이크 ──
//  레인은 0개로 둔다(레인별 잔량·판정 루프를 안 타 이 파일의 관심사만 남는다).
//  미처리 SQL 은 던진다 — 페이크가 조용히 빈 결과를 주면 테스트가 통과하면서 아무것도 안 본다.
const state = {
  strandedSeen: 0 as number, // 판정 기록 행 수
  seenCounted: 0,            // 배선 — 판정 집계가 실제로 불린 횟수
};

(itemsPool as unknown as { query: unknown }).query = async (sqlIn: unknown) => {
  const sql = String(sqlIn).replace(/\s+/g, " ").trim();
  if (sql.includes("FROM org_distiller ")) return { rows: [] }; // 레인 0개
  //  ⚠ source 를 **먼저** 가른다. 사각지대·채널 질의도 org_stranded_seen 을 배제절(NOT EXISTS)로
  //   품고 있어서, 표 이름만으로 라우팅하면 그 둘까지 판정 집계로 세어 배선 단언이 거짓으로 통과한다.
  if (sql.includes("FROM source s")) return { rows: [{ n: 7, channel: null }] };
  if (sql.includes("FROM org_stranded_seen")) { state.seenCounted++; return { rows: [{ n: state.strandedSeen }] }; }
  throw new Error("unhandled SQL in fake: " + sql);
};

const reset = (seen: number): void => { state.strandedSeen = seen; state.seenCounted = 0; };

// A — 폴백이 보고 버린 방치 자료가 있으면 그 수를 싣는다.
{
  reset(35_738);
  const cov = await distillerCoverage();
  assert.equal(cov.uncovered_reviewed, 35_738, "A 판정 건수를 안 싣는다 — «사각지대 0» 의 뜻을 가를 수 없다");
  //  ★ 배선 — 판정 집계가 **정확히 한 번** 불려야 한다. 0 이면 이 테스트는 공허하고,
  //   2 이상이면 다른 질의를 판정 집계로 잘못 세고 있다는 뜻이다(그러면 A 의 숫자도 못 믿는다).
  assert.equal(state.seenCounted, 1, "A 배선 — 판정 집계가 정확히 한 번 불려야 한다");
  //  같은 호출에서 사각지대(잔량)와 판정이 **따로** 나와야 구분이 성립한다.
  assert.equal(cov.uncovered, 7, "A 잔량과 판정이 한 값으로 뭉개졌다");
  ok("A 판정 기록 N건 → uncovered_reviewed=N (잔량과 별개로)");
}

// B — 아직 아무것도 안 버렸으면 0. undefined 가 아니라 숫자 0 이어야 화면이 «0건» 을 그린다.
{
  reset(0);
  const cov = await distillerCoverage();
  assert.equal(cov.uncovered_reviewed, 0);
  assert.equal(typeof cov.uncovered_reviewed, "number", "B undefined 면 호출자가 판정 유무를 못 가른다");
  assert.equal(state.seenCounted, 1, "B 배선 — 집계가 정확히 한 번 불려야 한다");
  ok("B 판정 기록 0건 → uncovered_reviewed=0 (숫자)");
}

console.log(`\ncoverage-stranded tests: ${pass} passed`);
