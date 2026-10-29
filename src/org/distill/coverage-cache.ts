// coverage-cache.ts — 증류기 커버리지(잔량·사각지대) 집계의 짧은 캐시(#5147).
//
//  왜: 「수집 · 증류」 앱은 표지(사각지대 배지)·증류기 탭·증류기 설정 화면이 모두 GET /org/distillers 를 부르는데,
//   그 응답의 대부분이 distillerCoverage + classifierCoverage 다. 레인마다 배타 배정·사전필터(스레드 집계·정규식) 질의를
//   돌려서 실측 2.7~3.4초가 걸렸다(lively-46e3, 자료 레인 27 · 2026-10-29). 탭을 오갈 때마다 그 3초를 다시 기다렸다.
//  잔량·사각지대는 크론 주기(분 단위)로 움직이는 숫자라 몇십 초 늦어도 판단이 바뀌지 않는다. 그래서
//   · FRESH_MS 안이면 그대로 돌려준다.
//   · STALE_MS 안이면 옛 값을 바로 돌려주고 뒤에서 다시 센다(다음 요청이 새 값을 받는다).
//   · 그보다 오래됐거나 비었으면 센다(동시 요청은 한 번의 계산을 함께 기다린다).
//  ⚠ 레인 **목록**(켜짐·이름·기준)은 캐시하지 않는다 — 켜고 끈 결과는 곧바로 보여야 한다. 레인을 저장·삭제하면
//   store 가 bumpCoverageVersion()(coverage-version.ts)을 불러 다음 요청이 새로 센다(켠 레인의 잔량이 옛 숫자로 남지 않게).
import { distillerCoverage, type DistillerCoverage } from "./distiller.js";
import { classifierCoverage } from "../store/classifiers.js";
import { coverageVersion } from "./coverage-version.js";

const FRESH_MS = 30_000;
const STALE_MS = 10 * 60_000;

type KnowledgeCoverage = Awaited<ReturnType<typeof classifierCoverage>>;
export interface CoverageSnapshot {
  source: DistillerCoverage;
  /** 카테고리 붙이기 쪽 — 못 셌으면 null(0 과 구분. 자료 레인 커버리지까지 실패시키지 않는다). */
  knowledge: KnowledgeCoverage | null;
}

//  gen = 그 값을 셀 때의 무효화 세대. 읽을 때 지금 세대와 다르면 버린다 — 계산 도중에 레인이 바뀐 결과도 여기서 걸러진다
//   (옛 레인 기준 숫자가 새 값 행세를 하지 않게).
let cached: { at: number; gen: number; value: CoverageSnapshot } | null = null;
let inflight: { gen: number; p: Promise<CoverageSnapshot> } | null = null;

async function compute(): Promise<CoverageSnapshot> {
  const [source, knowledge] = await Promise.all([
    distillerCoverage(),
    classifierCoverage().catch(() => null),
  ]);
  return { source, knowledge };
}

function refresh(): Promise<CoverageSnapshot> {
  const myGen = coverageVersion();
  if (inflight && inflight.gen === myGen) return inflight.p;
  const p = compute().then((value) => {
    cached = { at: Date.now(), gen: myGen, value };
    return value;
  }).finally(() => { if (inflight?.p === p) inflight = null; });
  inflight = { gen: myGen, p };
  return p;
}

export async function cachedCoverage(): Promise<CoverageSnapshot> {
  const now = Date.now();
  if (cached && cached.gen === coverageVersion()) {
    const age = now - cached.at;
    if (age < FRESH_MS) return cached.value;
    if (age < STALE_MS) { void refresh().catch(() => { /* 다음 요청이 다시 센다 */ }); return cached.value; }
  }
  return refresh();
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function _resetCoverageCacheForTest(): void {
  cached = null; inflight = null;
}
