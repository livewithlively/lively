// 커버리지 표 계약 (#2439) — **«100%» 를 느낌으로 판정하지 않는다.**
//
//  이 표가 없어서 실제로 난 일: 대화창이 터미널의 무엇을 덮는지 목록도 없이 기본 화면을 바꿨고,
//  백그라운드 셸·서브에이전트·아티팩트가 통째로 빠진 화면이 남의 기본이 됐다(2026-08-31 사고).
import assert from "node:assert/strict";
import { COVERAGE, COVERAGE_AXES, coverageOf, isFullyCovered, terminalOnlyAxes } from "./coverage.js";
import { CHAT_ADAPTERS } from "./chat-adapters.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("[1] 우리가 여는 하네스가 **전부** 표에 있다", () => {
  for (const a of CHAT_ADAPTERS) assert.ok(coverageOf(a.key), `${a.key} 가 커버리지 표에 있다`);
  assert.equal(COVERAGE.length, CHAT_ADAPTERS.length, "유령 항목이 없다");
});

t("[2] ★ 모든 하네스가 **모든 축**을 답한다 — 빈칸은 «모른다» 가 아니라 «안 적었다» 다", () => {
  for (const c of COVERAGE) {
    for (const ax of COVERAGE_AXES) {
      assert.ok(["ok", "terminal", "n/a"].includes(c.axes[ax]), `${c.harness}.${ax} 가 답을 갖는다`);
    }
  }
});

t("[3] ★ «터미널로 가야 한다»·«없다» 는 **이유가 있어야 한다** — 다음 사람이 다시 재지 않게", () => {
  for (const c of COVERAGE) {
    for (const ax of COVERAGE_AXES) {
      if (c.axes[ax] === "ok") continue;
      const why = c.notes[ax];
      assert.ok(why && why.length > 10, `${c.harness}.${ax}=${c.axes[ax]} 의 이유가 적혀 있다`);
    }
  }
});

t("[4] 읽기·보내기는 **전 하네스에서 웹으로 된다** — 그게 대화창의 최소선이다", () => {
  for (const c of COVERAGE) {
    assert.equal(c.axes.read, "ok", `${c.harness} 읽기`);
    assert.equal(c.axes.send, "ok", `${c.harness} 보내기`);
  }
});

t("[5] 지금 상태 — 어디에 구멍이 있나(이 수가 줄어드는 것이 진척이다)", () => {
  const gaps = COVERAGE.map((c) => [c.harness, terminalOnlyAxes(c.harness)] as const);
  for (const [h, ax] of gaps) console.log(`     ${h.padEnd(12)} ${ax.length ? "터미널로: " + ax.join(", ") : "★ 100%"}`);
  const total = gaps.reduce((n, [, ax]) => n + ax.length, 0);
  console.log(`     → 총 구멍 ${total}개`);
  //  ⚠ 이 단언은 **래칫**이다: 구멍이 늘면 빨간불이 난다. 줄이면 이 수를 낮춘다(그게 진척의 기록).
  assert.ok(total <= 9, `구멍이 늘었다(${total}) — 줄이는 방향이어야 한다`);
});

t("[6] isFullyCovered 는 «n/a» 를 구멍으로 세지 않는다 — 벤더가 안 주는 것은 우리 탓이 아니다", () => {
  //  codex 의 slash 는 n/a(TUI 전용) — 그것 때문에 영영 100% 가 안 되면 표가 쓸모없어진다.
  assert.equal(coverageOf("codex")!.axes.slash, "n/a");
  assert.ok(!terminalOnlyAxes("codex").includes("slash"));
  assert.equal(isFullyCovered("모르는하네스"), true, "표에 없으면 셀 구멍도 없다(호출부가 coverageOf 로 판정한다)");
});

console.log(`\n${pass}건 통과`);
