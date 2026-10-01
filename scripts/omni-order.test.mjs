// #4517 — 통합검색(⌘K)의 **정렬·기간** 규칙(web/lib/omni-order.ts). 원준 2026-09-30: «지금 완전 관련도 순으로만 나오는데
//  이러니까 최신순이 아예 안 되더라. 슬랙 참고해서 고쳐 줘. 필터가 필요한 건지 뭔지.»
//  엣지 표(스크래치패드 spec.md D) — 행마다 테스트 하나:
//
//  | #  | 입력                                                     | 기대                                               |
//  |----|----------------------------------------------------------|----------------------------------------------------|
//  | O1 | 저장값 recent / rel / null / 잡값                        | recent / rel / rel / rel                           |
//  | O2 | 기간 시작 all · d1 · d7 · d30 · d90                       | 0 · 오늘 0시 · 6일 전 0시 · 29일 전 0시 · 89일 전 0시 |
//  | O3 | inPeriod: 시각 없음+기간 · 기간 없음 · 경계 같음 · 1ms 전 | false · true · true · false                        |
//  | O4 | 날짜 묶음 경계(자정 정각 · 1ms 전 …)                       | 오늘 · 어제 · 최근 7일 · 최근 30일 · 그 이전 · 시각 모름 |
//  | O5 | 줄 시각 각 구간 + 미래 + 해 넘김                           | 방금 · n분 전 · n시간 전 · 어제 · n일 전 · M월 D일 · Y. M. D. |
//  | O6 | 최신순 비교                                               | 늦은 것 먼저 · 모름 맨 뒤                          |
//  | O7 | 서버 시각 읽기 ISO · 초 · 밀리초 · 잡값 · 여러 후보         | ms · 첫 유효값 · 없으면 undefined                  |
//
//  ⚠ 날짜 경계는 **현지 시각 자정**이다 — 시험도 현지 시각 생성자(new Date(y, m, d, …))로 만든다(CI 의 TZ 와 무관하게).
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SRC = process.env.OMNI_ORDER_SRC || path.join(root, "web/lib/omni-order.ts");
const out = mkdtempSync(path.join(tmpdir(), "omni-order-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [SRC, "--rootDir", path.dirname(SRC), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const M = await import(path.join(out, path.basename(SRC).replace(/\.ts$/, ".js")));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const eq = (got, want, n) => (Object.is(got, want) ? ok(n) : bad(n, `기대 ${JSON.stringify(want)} · 실제 ${JSON.stringify(got)}`));

// 기준 «지금» = 2026-09-30(수) 15:20 현지.
const NOW = new Date(2026, 8, 30, 15, 20, 0, 0).getTime();
const at = (mo, d, h = 0, mi = 0, s = 0, ms = 0, y = 2026) => new Date(y, mo, d, h, mi, s, ms).getTime();
const TODAY0 = at(8, 30);

// ── O1 정렬 저장값 ──
eq(M.readSort("recent"), "recent", "O1 저장값 recent → 최신순");
eq(M.readSort("rel"), "rel", "O1 저장값 rel → 관련도순");
eq(M.readSort(null), "recent", "O1 저장값 없음 → 최신순(기본, #4530)");
eq(M.readSort("RECENT"), "recent", "O1 잡값 → 최신순(기본)");
eq(M.SORT_KEY, "lively.omni.sort.v2", "O1 저장 키를 바꿨다 — 옛 기본으로 저장된 «관련도순» 이 새 기본을 가리지 않게(#4530)");

// ── O2 기간 시작 ──
eq(M.periodSince("all", NOW), 0, "O2 전체 기간 = 0(거르지 않는다)");
eq(M.periodSince("d1", NOW), TODAY0, "O2 오늘 = 오늘 0시");
eq(M.periodSince("d7", NOW), at(8, 24), "O2 최근 7일 = 오늘 포함 7일(9/24 0시)");
eq(M.periodSince("d30", NOW), at(8, 1), "O2 최근 30일 = 9/1 0시");
eq(M.periodSince("d90", NOW), at(6, 3), "O2 최근 90일 = 7/3 0시");
eq(M.periodSince("zzz", NOW), 0, "O2 모르는 값 = 전체 기간");

// ── O3 기간 안인가 ──
eq(M.inPeriod(undefined, TODAY0), false, "O3 시각 모름 + 기간 → 뺀다");
eq(M.inPeriod(undefined, 0), true, "O3 기간 없음이면 시각 몰라도 포함");
eq(M.inPeriod(TODAY0, TODAY0), true, "O3 경계 정각은 포함");
eq(M.inPeriod(TODAY0 - 1, TODAY0), false, "O3 경계 1ms 전은 뺀다");
eq(M.inPeriod(NaN, TODAY0), false, "O3 NaN 은 시각 모름");

// ── O4 날짜 묶음 ──
eq(M.dayBucket(NOW, NOW), "오늘", "O4 지금");
eq(M.dayBucket(TODAY0, NOW), "오늘", "O4 오늘 0시 정각");
eq(M.dayBucket(TODAY0 - 1, NOW), "어제", "O4 자정 1ms 전 = 어제");
eq(M.dayBucket(at(8, 29), NOW), "어제", "O4 어제 0시");
eq(M.dayBucket(at(8, 29) - 1, NOW), "최근 7일", "O4 그저께 끝 = 최근 7일");
eq(M.dayBucket(at(8, 24), NOW), "최근 7일", "O4 6일 전 0시 = 최근 7일(오늘 포함 7일)");
eq(M.dayBucket(at(8, 24) - 1, NOW), "최근 30일", "O4 7일 전 끝 = 최근 30일");
eq(M.dayBucket(at(8, 1), NOW), "최근 30일", "O4 29일 전 0시 = 최근 30일");
eq(M.dayBucket(at(8, 1) - 1, NOW), "그 이전", "O4 30일 전 끝 = 그 이전");
eq(M.dayBucket(undefined, NOW), "시각 모름", "O4 시각 없음");

// ── O5 줄 시각 ──
eq(M.whenLabel(NOW - 30_000, NOW), "방금", "O5 30초 전 = 방금");
eq(M.whenLabel(NOW + 3_600_000, NOW), "방금", "O5 미래(앞선 시계) = 방금");
eq(M.whenLabel(NOW - 5 * 60_000, NOW), "5분 전", "O5 5분 전");
eq(M.whenLabel(NOW - 59 * 60_000, NOW), "59분 전", "O5 59분 전");
eq(M.whenLabel(NOW - 3 * 3_600_000, NOW), "3시간 전", "O5 오늘 3시간 전");
eq(M.whenLabel(TODAY0, NOW), "15시간 전", "O5 오늘 0시 = 15시간 전(오늘이다)");
eq(M.whenLabel(TODAY0 - 1, NOW), "어제", "O5 자정 1ms 전 = 어제");
eq(M.whenLabel(at(8, 27, 23), NOW), "3일 전", "O5 사흘 전 밤 = 3일 전(날짜로 센다)");
eq(M.whenLabel(at(8, 24), NOW), "6일 전", "O5 6일 전 0시 = 6일 전");
eq(M.whenLabel(at(8, 23, 12), NOW), "9월 23일", "O5 7일 넘으면 날짜");
eq(M.whenLabel(at(11, 31, 12, 0, 0, 0, 2025), NOW), "2025. 12. 31.", "O5 해가 다르면 연도까지");
eq(M.whenLabel(undefined, NOW), "", "O5 시각 모름 = 빈 칸");

// ── O6 최신순 비교 ──
{
  const rows = [{ k: "a", at: 10 }, { k: "none" }, { k: "b", at: 30 }, { k: "c", at: 20 }, { k: "nan", at: NaN }];
  const got = [...rows].sort(M.byRecent).map((r) => r.k).join(",");
  eq(got.startsWith("b,c,a"), true, "O6 늦은 것 먼저 (" + got + ")");
  eq(got.endsWith("none,nan") || got.endsWith("nan,none"), true, "O6 시각 모름은 맨 뒤 (" + got + ")");
}

// ── O7 서버 시각 읽기 ──
eq(M.atOf("2026-09-30T01:02:03.000Z"), Date.parse("2026-09-30T01:02:03.000Z"), "O7 ISO");
eq(M.atOf(1790000000), 1790000000 * 1000, "O7 epoch 초 → ms");
eq(M.atOf(1790000000123), 1790000000123, "O7 epoch 밀리초 그대로");
eq(M.atOf("아님", null, "2026-09-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"), "O7 앞 후보를 못 읽으면 다음 후보");
eq(M.atOf("", undefined, 0, "zz"), undefined, "O7 다 못 읽으면 undefined");

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
