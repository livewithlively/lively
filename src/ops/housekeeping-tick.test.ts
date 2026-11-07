import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TICK_STEP_GROUPS, parseTickSkip, tickStepGroup, tickStepRunner } from "./housekeeping-tick.js";

// #4193 T3 — 매니지드 정비 틱(web.ts POST /api/ops/housekeeping/tick)의 «자동화 단계 빼기» 사양:
//  · 자동화 = 크론 실행기(scheduler) · 리브 2턴(liv-second-turn). 나머지(회수·스냅숏·정리·백필·시딩·앱 정비)는 정비다.
//  · 본문 { skip: ["automation"] } 만 받는다 — 모양이 틀리거나 모르는 값이면 아무것도 안 뺀다. 정비를 빼는 선택은 없다.
//  · 빠진 단계는 돌지 않고 "skipped" 로 적힌다. 응답은 적용한 선택을 돌려준다(선택을 모르는 옛 코어와 가르는 표지).
//  · 모르는 단계 이름은 정비 — 분류를 잊은 새 단계가 휴면 워크스페이스에서 조용히 멈추지 않는다.

const MAINTENANCE = [
  "seed-default-content", "call-log-prune", "session-backfill", "app-data-snapshot", "app-folder-archive",
  "app-bundles", "app-servers", "session-reaper", "session-stop-rule", "session-pressure-reaper", "session-end-lost",
];

test("[4206-H1] 자동화는 크론 실행기와 리브 2턴뿐이다 — 회수·스냅숏·정리·백필·시딩은 정비", () => {
  assert.equal(tickStepGroup("scheduler"), "automation");
  assert.equal(tickStepGroup("liv-second-turn"), "automation");
  for (const s of MAINTENANCE) assert.equal(tickStepGroup(s), "maintenance", s);
  const automation = [...TICK_STEP_GROUPS].filter(([, g]) => g === "automation").map(([n]) => n).sort();
  assert.deepEqual(automation, ["liv-second-turn", "scheduler"]);
});

test("[4206-H2] 모르는 단계 이름은 정비로 본다(빼지 않는다)", () => {
  for (const s of ["new-step", "", "constructor", "__proto__", "toString"]) {
    assert.equal(tickStepGroup(s), "maintenance", JSON.stringify(s));
  }
});

test("[4206-H3] 선택 읽기 — { skip: [\"automation\"] } 만 받고, 정비를 빼는 선택은 없다", () => {
  assert.deepEqual([...parseTickSkip({ skip: ["automation"] })], ["automation"]);
  assert.deepEqual([...parseTickSkip({ skip: ["maintenance", "automation"] })], ["automation"]);
  for (const bad of [
    undefined, null, {}, "automation", ["automation"], { skip: "automation" },
    { skip: ["maintenance"] }, { skip: [1] }, { skip: [{}] }, { skip: null },
  ]) {
    assert.deepEqual([...parseTickSkip(bad)], [], JSON.stringify(bad));
  }
});

test("[4206-H4] 단계 실행기 — 고른 묶음은 돌지 않고 \"skipped\" · 나머지는 돌고 · 한 단계가 던져도 이어 간다", async () => {
  const ran: string[] = [];
  const out: Record<string, unknown> = {};
  const step = tickStepRunner(parseTickSkip({ skip: ["automation"] }), out);
  await step("scheduler", async () => { ran.push("scheduler"); return "ticked"; });
  await step("liv-second-turn", async () => { ran.push("liv"); return { fired: 1 }; });
  await step("session-reaper", async () => { ran.push("reaper"); return { enabled: true }; });
  await step("call-log-prune", async () => { throw new Error("boom"); });
  await step("new-step", async () => { ran.push("new"); });
  assert.deepEqual(ran, ["reaper", "new"]);
  assert.equal(out.scheduler, "skipped");
  assert.equal(out["liv-second-turn"], "skipped");
  assert.deepEqual(out["session-reaper"], { enabled: true });
  assert.deepEqual(out["call-log-prune"], { error: "boom" });
  assert.equal(out["new-step"], "ok");

  //  선택이 없으면 전부 돈다(종전과 같다)
  const all: string[] = [];
  const o2: Record<string, unknown> = {};
  const s2 = tickStepRunner(parseTickSkip({}), o2);
  await s2("scheduler", async () => { all.push("scheduler"); return "ticked"; });
  await s2("liv-second-turn", async () => { all.push("liv"); });
  assert.deepEqual(all, ["scheduler", "liv"]);
  assert.equal(o2.scheduler, "ticked");
  assert.equal(o2["liv-second-turn"], "ok");
});

// ── 배선 — web.ts 의 틱이 이 분류·선택을 쓰는가 ──
const web = readFileSync(new URL("../../src/web.ts", import.meta.url), "utf8");
const at = web.indexOf('app.post("/api/ops/housekeeping/tick"');
const handler = at < 0 ? "" : web.slice(at, web.indexOf("\n  }));", at));

test("[4206-H5] 틱의 단계 목록과 분류표가 같다 — 단계를 더하면 분류도 정해야 한다", () => {
  assert.ok(at > 0, "web.ts 에 정비 틱이 없다");
  const names = [...handler.matchAll(/\bstep\("([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, [...TICK_STEP_GROUPS.keys()].sort());
});

test("[4206-H6] 틱이 본문의 선택을 읽어 단계 실행기에 넘기고, 적용한 선택을 응답에 싣는다", () => {
  assert.match(handler, /const skip = parseTickSkip\(req\.body\);/);
  assert.match(handler, /const step = tickStepRunner\(skip, out\);/);
  assert.match(handler, /res\.json\(\{ ok: true, steps: out, skip: \[\.\.\.skip\] \}\);/);
});
