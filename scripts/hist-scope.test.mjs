#!/usr/bin/env node
// #4553 안 A — 「세션 이력」 앱 사이드바의 규칙(web/lib/hist-scope.ts)을 값으로 잰다.
//
//  원준 2026-10-05 «A안으로 고고»(시안 `세션이력-사이드바-3안.html` 의 A): 사이드바는 「세션 목록」과 한 틀 — 묶기 고르개 하나 · 「전체」 ·
//  묶음마다 카드(줄 = 프로젝트). 셸(사이드바)과 액자 안 앱(본문)이 이 파일 하나로 «어느 묶음인가 · 범위 안인가» 를 정한다.
//  화면에서만 보이는 것(빵부스러기 · 탭마다 걸리는 범위 · 셸과 주고받는 신호)은 session-history-scope-runtime.test.mjs 가 잰다.
//
//  엣지 표(스크래치패드 spec-side.md L):
//   L1  시간 묶음 — 오늘 · 어제 · 이번 주(2~6일 전) · 달 · 다른 해의 달 · 모름 · 앞선 시각(시계 어긋남)
//   L2  경계값 — 자정 직전 · 자정 정각 · 6일 전 0시 · 7일 전 23:59
//   L3  달 이름 — 올해는 «9월», 다른 해는 «2025년 12월»
//   L4  카드 순서(시간별) — 오늘 → 어제 → 이번 주 → 최근 달 → 오래된 달 → 이전 · 빈 묶음은 없다
//   L5  카드 순서(남긴 것별 · 상태별) — 정해진 순서
//   L6  카드 안 줄 — 많은 순 · 같으면 최근 · 같으면 id · 프로젝트에 안 붙은 것(「기타 (미분류)」)도 제 수대로
//   L7  합 — 카드의 합 = 줄 수 · 카드 안 줄의 합 = 카드
//   L8  범위 판정 — 전체 · 묶음 · 묶음 × 프로젝트 · 묶지 않음 × 프로젝트 · 프로젝트에 안 붙은 것(0)
//   L9  고르기 — 다시 누르면 전체 · 기준을 바꾸면 풀림
//   L10 가라앉히기 — 고른 카드 · 줄이 사라졌을 때
//   L11 구간 — 묶음의 [since, until) · 이번 주와 겹치는 달 · 통째로 이번 주 안인 달
//   L12 빵부스러기
//   L13 신호로 온 값 읽기 — 틀린 것은 받지 않는다
//   L14 새로 들인 값이 비었을 때 — 줄이 없다 · 남긴 것을 아직 모른다
//
//  ⚠ 단언을 하나씩 끝까지 센다(첫 실패에서 멈추지 않는다). fail-first: 규칙 파일이 없던 트리(origin/main)에서 전부 빨갛고,
//   규칙을 한 줄씩 깨뜨린 변이에서도 그 줄을 재는 단언이 빨갛다(스크래치패드 mut-hist-scope.mjs).
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (got, want, name) => { const a = JSON.stringify(got), b = JSON.stringify(want); ok(a === b, `${name}${a === b ? "" : ` — 기대 ${b} · 실제 ${a}`}`); };

let L = null;
try { L = await import(pathToFileURL(join(root, "public/app/lib/hist-scope.js")).href); } catch { /* 아래 L0 가 빨갛다 */ }
ok(!!L, "L0 규칙이 잎 모듈(lib/hist-scope.ts)에 있다 — 셸과 액자가 같은 파일을 읽는다");
if (!L) { console.log(`\n#4553 세션 이력 사이드바 규칙: ${pass} passed, ${fail} FAILED`); process.exit(1); }

const {
  histDayKey, histGroupLabel, histGroupKey, histCards, histLines, inHistScope, withHistGroupBy, pickHistScope, settleHistScope,
  histScopeSpan, histCrumb, parseHistScope, parseHistRows, histScopeOn, HIST_SCOPE0, HIST_GROUP_BYS, hiddenHistCardsLabel,
} = L;

const at = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();
const NOW = at(2026, 10, 5, 14, 30);   // 월요일 낮
const row = (key, last, o = {}) => ({ key, conv: o.conv === undefined ? "c-" + key : o.conv, last, pid: o.pid ?? 0, pname: o.pname ?? (o.pid ? "P" + o.pid : ""), state: o.state ?? "rec", kind: o.kind === undefined ? "n" : o.kind });

// ── L1 · L2 시간 묶음 ──
eq([at(2026, 10, 5, 9), at(2026, 10, 4, 23), at(2026, 10, 3), at(2026, 9, 29), at(2026, 9, 28), at(2026, 9, 1), at(2025, 12, 31), 0, at(2026, 10, 6, 9)].map((t) => histDayKey(t, NOW)),
  ["d0", "d1", "d7", "d7", "m:2026-09", "m:2026-09", "m:2025-12", "old", "d0"], "L1 오늘 · 어제 · 이번 주(2일 전 · 6일 전) · 7일 전은 달 · 지난달 · 작년 · 모름 · 내일(시계 어긋남)은 오늘");
eq([at(2026, 10, 4, 23, 59), at(2026, 10, 5, 0, 0), at(2026, 9, 29, 0, 0), at(2026, 9, 28, 23, 59)].map((t) => histDayKey(t, NOW)),
  ["d1", "d0", "d7", "m:2026-09"], "L2 경계 — 자정 직전은 어제 · 자정 정각은 오늘 · 6일 전 0시는 이번 주 · 7일 전 23:59 는 달");
eq([NaN, -5, "x"].map((t) => histDayKey(t, NOW)), ["old", "old", "old"], "L2 시각이 수가 아니거나 0 이하면 «이전»");
// 달이 바뀐 직후 — 이번 주가 두 달에 걸친다. 지난달 끝은 «이번 주», 그 앞은 지난달.
eq([at(2026, 9, 30), at(2026, 9, 24)].map((t) => histDayKey(t, at(2026, 10, 1))), ["d1", "m:2026-09"], "L2 달이 바뀐 날 — 어제(9/30)는 어제, 7일 전(9/24)은 9월");

// ── L3 이름 ──
eq([["day", "d0"], ["day", "d1"], ["day", "d7"], ["day", "old"], ["day", "m:2026-09"], ["day", "m:2025-12"], ["kind", "k"], ["kind", "a"], ["kind", "n"], ["state", "live"], ["state", "off"], ["state", "rec"], ["state", "none"]]
  .map(([by, k]) => histGroupLabel(by, k, NOW)),
["오늘", "어제", "이번 주", "이전", "9월", "2025년 12월", "지식을 남긴 세션", "작업 기록만 남긴 세션", "남긴 기록이 없는 세션", "실행 중", "오프라인", "기록만", "기록 없음"], "L3 묶음의 이름 — 올해의 달은 «9월», 다른 해는 «2025년 12월»");
eq(HIST_GROUP_BYS.map((b) => b.key + ":" + b.label), ["day:시간별", "kind:남긴 것별", "state:상태별", "none:묶지 않음"], "L3 묶는 기준 넷 — 순서 그대로 드롭다운에 선다(사람별 · 리스트별은 없다)");

// ── L4~L7 카드 ──
const ROWS = [
  row("t1", at(2026, 10, 5, 9), { pid: 7, state: "live", kind: "k" }),
  row("t2", at(2026, 10, 5, 8), { pid: 7, state: "live", kind: "a" }),
  row("t3", at(2026, 10, 5, 7), { pid: 9, state: "off", kind: "n" }),
  row("y1", at(2026, 10, 4, 20), { pid: 0, state: "off", kind: "n" }),
  row("y2", at(2026, 10, 4, 10), { pid: 9, state: "rec", kind: "k" }),
  row("w1", at(2026, 10, 1), { pid: 9, state: "rec", kind: "n" }),
  row("s1", at(2026, 9, 20), { pid: 0, state: "rec", kind: "n" }),
  row("s2", at(2026, 9, 10), { pid: 0, state: "rec", kind: "a" }),
  row("s3", at(2026, 9, 2), { pid: 3, state: "rec", kind: "n" }),
  row("a1", at(2026, 8, 15), { pid: 3, state: "rec", kind: "n" }),
  row("o1", 0, { pid: 3, state: "none", kind: "n", conv: null }),
];
const dayCards = histCards(ROWS, "day", NOW);
eq(dayCards.map((c) => c.key + ":" + c.n), ["d0:3", "d1:2", "d7:1", "m:2026-09:3", "m:2026-08:1", "old:1"], "L4 시간별 카드 — 오늘 → 어제 → 이번 주 → 9월 → 8월 → 이전, 빈 묶음은 없다");
eq(histCards([row("a", at(2026, 1, 3)), row("b", at(2025, 12, 30)), row("c", at(2025, 2, 1))], "day", NOW).map((c) => c.key), ["m:2026-01", "m:2025-12", "m:2025-02"], "L4 해를 넘어도 늦은 달이 먼저다");
eq(histCards(ROWS, "kind", NOW).map((c) => c.key + ":" + c.n), ["k:2", "a:2", "n:7"], "L5 남긴 것별 — 지식 → 작업 기록만 → 없음");
eq(histCards(ROWS, "state", NOW).map((c) => c.key + ":" + c.n), ["live:2", "off:2", "rec:6", "none:1"], "L5 상태별 — 실행 중 → 오프라인 → 기록만 → 기록 없음");
eq(histCards(ROWS, "none", NOW), [], "L5 묶지 않음이면 카드가 없다(줄만)");
eq(histLines(ROWS).map((l) => l.pid + ":" + l.n), ["9:3", "0:3", "3:3", "7:2"], "L6 줄 — 많은 순, 같으면 최근 활동 순(9 → 0 → 3)");
eq(histLines([row("a", 100, { pid: 5 }), row("b", 100, { pid: 2 })]).map((l) => l.pid), [2, 5], "L6 수도 시각도 같으면 id 순");
eq(histLines([row("a", 100, { pid: 5, pname: "" }), row("b", 200, { pid: 5, pname: "이름" })])[0].name, "이름", "L6 프로젝트 이름은 아는 줄의 것을 쓴다(앞 줄이 이름을 몰라도)");
eq(dayCards[0].lines.map((l) => l.pid + ":" + l.n), ["7:2", "9:1"], "L6 카드 안 줄도 같은 규칙 — 오늘은 7(둘) → 9(하나)");
for (const by of ["day", "kind", "state"]) {
  const cs = histCards(ROWS, by, NOW);
  ok(cs.reduce((n, c) => n + c.n, 0) === ROWS.length, `L7 ${by} — 카드의 합 = 줄 수(${ROWS.length})`);
  ok(cs.every((c) => c.lines.reduce((n, l) => n + l.n, 0) === c.n), `L7 ${by} — 카드 안 줄의 합 = 카드의 수`);
}

// ── L8 범위 ──
const keysIn = (sc) => ROWS.filter((r) => inHistScope(r, sc, NOW)).map((r) => r.key);
eq(keysIn(HIST_SCOPE0).length, ROWS.length, "L8 전체 — 다 든다");
eq(keysIn({ by: "day", group: "d1", proj: null }), ["y1", "y2"], "L8 묶음(어제)");
eq(keysIn({ by: "day", group: "d0", proj: 7 }), ["t1", "t2"], "L8 묶음 × 프로젝트(오늘의 7)");
eq(keysIn({ by: "day", group: "d1", proj: 0 }), ["y1"], "L8 묶음 × 프로젝트에 안 붙은 것(0) — 0 은 «없음» 이지 «아무거나» 가 아니다");
eq(keysIn({ by: "none", group: null, proj: 3 }), ["s3", "a1", "o1"], "L8 묶지 않음 × 프로젝트");
eq(keysIn({ by: "none", group: null, proj: 0 }), ["y1", "s1", "s2"], "L8 묶지 않음 × 프로젝트에 안 붙은 것(0)");
eq(keysIn({ by: "kind", group: "k", proj: null }), ["t1", "y2"], "L8 남긴 것(지식)");
eq(keysIn({ by: "state", group: "rec", proj: 9 }), ["y2", "w1"], "L8 상태 × 프로젝트");
eq([histScopeOn(HIST_SCOPE0), histScopeOn({ by: "day", group: "d0", proj: null }), histScopeOn({ by: "none", group: null, proj: 0 })], [false, true, true], "L8 골랐나 — 0 을 고른 것도 고른 것이다");

// ── L9 고르기 ──
const A = { by: "day", group: "d1", proj: null };
eq(pickHistScope(HIST_SCOPE0, "d1", null), A, "L9 카드 머리를 누르면 그 묶음");
eq(pickHistScope(A, "d1", null), { by: "day", group: null, proj: null }, "L9 고른 것을 다시 누르면 전체");
eq(pickHistScope(A, "d1", 9), { by: "day", group: "d1", proj: 9 }, "L9 같은 카드의 줄을 누르면 그 줄");
eq(pickHistScope({ by: "day", group: "d1", proj: 9 }, "d1", null), A, "L9 줄을 고른 채 카드 머리를 누르면 카드 전체(풀리지 않는다)");
eq(pickHistScope({ by: "none", group: null, proj: 0 }, null, 0), { by: "none", group: null, proj: null }, "L9 묶지 않음 — 0 줄(기타)을 다시 누르면 풀린다");
eq(withHistGroupBy(A, "kind"), { by: "kind", group: null, proj: null }, "L9 기준을 바꾸면 고른 것이 풀린다");
ok(withHistGroupBy(A, "day") === A, "L9 같은 기준이면 그대로(같은 객체)");

// ── L10 가라앉히기 ──
ok(settleHistScope(A, dayCards) === A, "L10 고른 카드가 있으면 그대로(같은 객체 — 다시 그리지 않는다)");
eq(settleHistScope({ by: "day", group: "m:2024-01", proj: 3 }, dayCards), { by: "day", group: null, proj: null }, "L10 고른 카드가 사라지면 전체로");
eq(settleHistScope({ by: "day", group: "d1", proj: 7 }, dayCards), A, "L10 고른 줄만 사라지면 줄만 푼다");
eq(settleHistScope({ by: "day", group: null, proj: 7 }, dayCards), { by: "day", group: null, proj: null }, "L10 카드 없이 줄만 고른 꼴(묶는 기준에서는 없는 꼴)은 푼다");
eq(settleHistScope({ by: "none", group: null, proj: 99 }, [], histLines(ROWS)), { by: "none", group: null, proj: null }, "L10 묶지 않음 — 고른 줄이 사라지면 풀린다");
const N3 = { by: "none", group: null, proj: 3 };
ok(settleHistScope(N3, [], histLines(ROWS)) === N3, "L10 묶지 않음 — 고른 줄이 있으면 그대로");

// ── L11 구간 ──
const span = (g, now = NOW) => { const s = histScopeSpan({ by: "day", group: g, proj: null }, now); return s && [new Date(s.since).toLocaleDateString("sv"), new Date(s.until).toLocaleDateString("sv")]; };
eq([span("d0"), span("d1"), span("d7")], [["2026-10-05", "2026-10-06"], ["2026-10-04", "2026-10-05"], ["2026-09-29", "2026-10-04"]], "L11 오늘 · 어제 · 이번 주(6일 전 0시 ~ 어제 0시)");
eq(span("m:2026-09"), ["2026-09-01", "2026-09-29"], "L11 이번 주와 겹치는 달은 이번 주 앞에서 끊긴다(9/29 부터는 이번 주의 것)");
eq(span("m:2026-08"), ["2026-08-01", "2026-09-01"], "L11 겹치지 않는 달은 1일 ~ 다음 달 1일");
eq(span("m:2026-10"), null, "L11 통째로 이번 주 안인 달(10월 5일의 10월)은 구간이 없다");
eq([span("old"), histScopeSpan({ by: "kind", group: "k", proj: null }, NOW), histScopeSpan(HIST_SCOPE0, NOW)], [null, null, null], "L11 «이전» · 시간 묶음이 아닌 것 · 전체는 구간이 없다");
for (const g of ["d0", "d1", "d7", "m:2026-09", "m:2026-08"]) {
  const s = histScopeSpan({ by: "day", group: g, proj: null }, NOW);
  const inside = ROWS.filter((r) => r.last >= s.since && r.last < s.until).map((r) => r.key);
  eq(inside, ROWS.filter((r) => histDayKey(r.last, NOW) === g).map((r) => r.key), `L11 ${g} — 구간 안의 줄 = 그 묶음의 줄`);
}

// ── L12 빵부스러기 ──
const pn = (pid) => ({ 7: "통합검색", 9: "UI 수정" }[pid] || "");
eq(histCrumb(HIST_SCOPE0, NOW, pn), { trail: [], now: "세션 이력" }, "L12 전체 — 앱 이름만");
eq(histCrumb(A, NOW, pn), { trail: ["세션 이력", "시간별"], now: "어제" }, "L12 묶음");
eq(histCrumb({ by: "day", group: "d1", proj: 9 }, NOW, pn), { trail: ["세션 이력", "시간별", "어제"], now: "UI 수정" }, "L12 묶음 × 프로젝트");
eq(histCrumb({ by: "kind", group: "k", proj: 0 }, NOW, pn), { trail: ["세션 이력", "남긴 것별", "지식을 남긴 세션"], now: "기타 (미분류)" }, "L12 프로젝트에 안 붙은 것(0)은 「기타 (미분류)」 — 다른 화면과 같은 이름(lib/proj-none)");
eq(histCrumb({ by: "none", group: null, proj: 7 }, NOW, pn), { trail: ["세션 이력", "프로젝트"], now: "통합검색" }, "L12 묶지 않음 × 프로젝트");
eq(histCrumb({ by: "none", group: null, proj: 3 }, NOW, pn).now, "#3", "L12 이름을 모르는 프로젝트는 번호로");

// ── L13 신호로 온 값 ──
eq(parseHistScope({ by: "day", group: "d1", proj: 9 }), { by: "day", group: "d1", proj: 9 }, "L13 바른 범위는 그대로");
eq(parseHistScope({ by: "kind" }), { by: "kind", group: null, proj: null }, "L13 group · proj 가 없으면 전체");
eq(parseHistScope({ by: "none", group: "d1", proj: 0 }), { by: "none", group: null, proj: 0 }, "L13 묶지 않음에 묶음이 실려 오면 버린다");
eq([parseHistScope(null), parseHistScope("day"), parseHistScope({ by: "owner" }), parseHistScope({ by: "day", group: 5 }), parseHistScope({ by: "day", proj: -1 }), parseHistScope({ by: "day", proj: 1.5 }), parseHistScope({ by: "day", group: "x".repeat(65) })],
  [null, null, null, null, null, null, null], "L13 틀린 범위는 받지 않는다 — 없는 기준 · 글자가 아닌 묶음 · 음수 · 소수 · 너무 긴 묶음");
eq(parseHistRows("nope"), null, "L13 줄이 배열이 아니면 받지 않는다");
eq(parseHistRows([{ key: "a", conv: "c", last: 5, pid: 2, pname: "P", state: "live", kind: "k" }, null, { key: "" }, { conv: "x" }, { key: "b", last: "x", pid: -3, state: "weird", kind: "zzz" }]),
  [{ key: "a", conv: "c", last: 5, pid: 2, pname: "P", state: "live", kind: "k" }, { key: "b", conv: null, last: 0, pid: 0, pname: "", state: "none", kind: null }],
  "L13 모양이 틀린 줄은 버리고 · 모르는 값은 안전한 쪽으로(시각 0 · 프로젝트 0 · 상태 none · 남긴 것 모름)");
eq(parseHistRows(Array.from({ length: 12 }, (_, i) => ({ key: "k" + i })), 10).length, 10, "L13 한 번에 받는 줄 수에 상한이 있다");

// ── L14 비었을 때 ──
eq([histCards(null, "day", NOW), histCards([], "kind", NOW), histLines(null), histLines(undefined)], [[], [], [], []], "L14 줄이 없으면 카드도 줄도 없다(null · 빈 배열)");
const unknown = [row("u1", NOW, { kind: null }), row("u2", NOW, { kind: "k" })];
eq(histCards(unknown, "kind", NOW).map((c) => c.key + ":" + c.n), ["k:1", "?:1"], "L14 남긴 것을 아직 모르는 줄은 제 묶음(?)에 선다 — 아는 묶음에 섞이지 않는다");
eq(histGroupLabel("kind", "?", NOW), "확인 중", "L14 그 묶음의 이름은 «확인 중»");
eq(unknown.filter((r) => inHistScope(r, { by: "kind", group: "n", proj: null }, NOW)).length, 0, "L14 모르는 줄을 «남긴 기록이 없는 세션» 으로 세지 않는다");
eq(histGroupKey(row("x", 0), "none", NOW), "", "L14 묶지 않음의 묶음 key 는 빈 글자");
eq([hiddenHistCardsLabel("day", 3), hiddenHistCardsLabel("state", 2)], ["기간 3개 더", "묶음 2개 더"], "L14 접힌 카드 줄의 글");

console.log(`\n#4553 세션 이력 사이드바 규칙: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
