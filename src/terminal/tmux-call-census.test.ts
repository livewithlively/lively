// tmux 호출 계수 — 창 단위 전수 계수 (#2600 T2 d4).
//
//  ── 왜 이 시험이 있나 ──
//  이 계수기는 완료 조건 «게이트웨이가 그 테넌트에 tmux 를 부른 횟수 0» 을 재는 **계기**다. 계기가 틀리면
//   그 조건은 «검증했다» 는 말만 남고 아무것도 안 지킨다 — 2026-09-08 에 실제로 그렇게 됐다: 그림자 로그로
//   동사를 세고 «list-sessions 0건» 이라 결론했는데, 같은 창의 요약은 compared 100 이었다(그림자는 불일치와
//   첫 건에만 동사를 싣는다). **틀린 계기로 «닫혔다» 고 말하는 것이 이 시험이 막으려는 것이다.**
//
//  엣지 표는 스크래치패드 `spec-census.md` 의 11행 — 행마다 시나리오 하나.
import assert from "node:assert/strict";
import test from "node:test";
import { makeTmuxCallCensus, CENSUS_NONE } from "./tmux-call-census.js";

// ── 창이 언제 닫히나 ────────────────────────────────────────────────────────
test("C1/C2 everyN 번째 호출에서만 창이 닫힌다", () => {
  const c = makeTmuxCallCensus(3);
  assert.equal(c.record("t", "list-sessions"), null);
  assert.equal(c.record("t", "list-sessions"), null);
  const rows = c.record("t", "list-sessions");
  assert.deepEqual(rows, [{ slug: "t", verb: "list-sessions", n: 3 }]);
});

test("C3 표는 (슬러그,동사)별 건수다", () => {
  const c = makeTmuxCallCensus(4);
  c.record("a", "list-sessions"); c.record("a", "set-option");
  c.record("b", "list-sessions"); const rows = c.record("a", "list-sessions");
  assert.deepEqual(rows, [
    { slug: "a", verb: "list-sessions", n: 2 },
    { slug: "a", verb: "set-option", n: 1 },
    { slug: "b", verb: "list-sessions", n: 1 },
  ]);
});

test("C4 ★ 보고 뒤 창이 비워진다 — 옛 창 숫자가 다음 창에 안 섞인다", () => {
  //  누적을 내면 «지금도 부르고 있나» 를 못 읽는다. 이 프로젝트가 재려는 것은 «남았나» 다.
  const c = makeTmuxCallCensus(2);
  c.record("t", "list-sessions"); c.record("t", "list-sessions");   // 창 1 닫힘
  c.record("t", "set-option");
  assert.deepEqual(c.record("t", "set-option"), [{ slug: "t", verb: "set-option", n: 2 }]);
});

// ── 없는 값 ─────────────────────────────────────────────────────────────────
test("C5 ★ 슬러그가 null·undefined·빈 문자열이면 이름 있는 버킷으로", () => {
  for (const v of [null, undefined, ""] as (string | null | undefined)[]) {
    const c = makeTmuxCallCensus(1);
    assert.deepEqual(c.record(v, "ls"), [{ slug: CENSUS_NONE, verb: "ls", n: 1 }], `slug=${JSON.stringify(v)}`);
  }
});

test("C6 ★ 동사가 null·undefined·빈 문자열이면 이름 있는 버킷으로", () => {
  //  argv 가 옵션뿐이면 동사가 없다(`tmuxSessionOf` 가 null 을 준다). 그 호출도 세야 «전수» 다.
  for (const v of [null, undefined, ""] as (string | null | undefined)[]) {
    const c = makeTmuxCallCensus(1);
    assert.deepEqual(c.record("t", v), [{ slug: "t", verb: CENSUS_NONE, n: 1 }], `verb=${JSON.stringify(v)}`);
  }
});

// ── 끄기·경계 ───────────────────────────────────────────────────────────────
test("C7 ★ everyN 이 0·음수면 영원히 보고하지 않는다 — 그래도 세기는 한다", () => {
  for (const n of [0, -1]) {
    const c = makeTmuxCallCensus(n);
    for (let i = 0; i < 50; i++) assert.equal(c.record("t", "ls"), null, `everyN=${n}`);
    assert.deepEqual(c.peek(), [{ slug: "t", verb: "ls", n: 50 }], `everyN=${n} 는 세기는 한다`);
  }
});

test("C8 ★ everyN=1(경계 최소)이면 매 호출마다 보고한다", () => {
  const c = makeTmuxCallCensus(1);
  assert.deepEqual(c.record("t", "ls"), [{ slug: "t", verb: "ls", n: 1 }]);
  assert.deepEqual(c.record("t", "ls"), [{ slug: "t", verb: "ls", n: 1 }]);   // 창이 매번 비워지므로 계속 1
});

// ── 정렬 ────────────────────────────────────────────────────────────────────
test("C9 ★ 많은 것부터, 동률이면 슬러그→동사 이름순", () => {
  //  창끼리 눈으로 견주려면 순서가 흔들리면 안 된다(삽입순으로 두면 로그가 매번 달라 보인다).
  const c = makeTmuxCallCensus(5);
  c.record("b", "zz"); c.record("a", "zz"); c.record("a", "aa"); c.record("c", "kill");
  const rows = c.record("c", "kill");
  assert.deepEqual(rows, [
    { slug: "c", verb: "kill", n: 2 },
    { slug: "a", verb: "aa", n: 1 },
    { slug: "a", verb: "zz", n: 1 },
    { slug: "b", verb: "zz", n: 1 },
  ]);
});

// ── 관측 장치 ───────────────────────────────────────────────────────────────
test("C10 peek 은 비우지 않는다", () => {
  const c = makeTmuxCallCensus(0);
  c.record("t", "ls");
  assert.deepEqual(c.peek(), [{ slug: "t", verb: "ls", n: 1 }]);
  assert.deepEqual(c.peek(), [{ slug: "t", verb: "ls", n: 1 }], "두 번 읽어도 같다");
});

test("C11 ★ 돌려준 표를 호출자가 고쳐도 내부가 안 망가진다", () => {
  const c = makeTmuxCallCensus(1);
  const rows = c.record("t", "ls")!;
  rows[0]!.n = 999; rows.push({ slug: "x", verb: "y", n: 7 });
  assert.deepEqual(c.record("t", "ls"), [{ slug: "t", verb: "ls", n: 1 }], "다음 창은 영향 없다");
});
