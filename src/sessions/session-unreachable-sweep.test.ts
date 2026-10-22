// #4939 — 도달 불가 판정의 배선(session-unreachable-sweep). 판정 자체는 session-unreachable-rule.test 가 잰다 — 여기는 스위치·기억·장부로 가는 표식.
//  명제: ① off 는 아무것도 안 읽는다 ② shadow 는 상시 세션 표식을 안 남긴다(장부가 «끝남» 을 안 싣는다) ③ on 은 남기고 장부가 그것을 읽는다
//        ④ 같은 테넌트의 판이 겹치면 뒤 판은 그냥 돌아간다.
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { resetUnreachableMemory, sweepSessionUnreachable, unreachableMemoryMarks } from "./session-unreachable-sweep.js";
import type { HostView } from "./session-unreachable-rule.js";
import { withTenant } from "../org/tenant-context.js";

const NOW = Date.parse("2026-10-22T10:00:00.000Z");
const HOUR = 3_600_000;
const host = (): HostView => ({ nodeId: "i-a", fresh: true, known: true, listed: new Set(), missing: new Map([["box-m", { sinceMs: NOW - HOUR, container: "c-m" }]]) });
const deps = (calls: string[]) => ({
  nowMs: NOW, upMs: 2 * HOUR, lastBusyMem: () => 0,
  hosts: () => { calls.push("hosts"); return [host()]; },
  rows: async () => { calls.push("rows"); return []; },
  managed: async () => ["box-m"],
  markRow: async () => { calls.push("markRow"); return true; },
  reviveRow: async () => true,
  log: () => {},
});
afterEach(() => { resetUnreachableMemory(); delete process.env.LIVELY_SESSION_LOST_RULE; });

test("[S1] off 는 아무것도 안 읽는다 — env 로 끈다", async () => {
  process.env.LIVELY_SESSION_LOST_RULE = "off";
  const calls: string[] = [];
  assert.deepEqual(await sweepSessionUnreachable(deps(calls)), { mode: "off" });
  assert.deepEqual(calls, []);
});

test("[S2] ★ 기본(shadow) — 판정은 세지만 상시 세션 표식을 안 남긴다(장부가 «끝남» 을 안 싣는다)", async () => {
  const calls: string[] = [];
  const r = await sweepSessionUnreachable(deps(calls));
  assert.deepEqual(r, { mode: "shadow", blind: null, mark: 1, revive: 0, hold: 0, nullStreakMax: 0 });
  assert.equal(unreachableMemoryMarks().size, 0, "🔴 shadow 가 표식을 남겼다 — 브로커가 그 컨테이너를 걷는다");
});

test("[S3] on — 상시 세션 표식을 남기고 장부가 그것을 읽는다", async () => {
  process.env.LIVELY_SESSION_LOST_RULE = "on";
  await sweepSessionUnreachable(deps([]));
  assert.deepEqual([...unreachableMemoryMarks().keys()], ["box-m"]);
});

test("[S4] 같은 테넌트의 판이 겹치면 뒤 판은 그냥 돌아간다(in-flight)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = { ...deps([]), rows: async () => { await gate; return []; } };
  const first = sweepSessionUnreachable(slow);
  assert.deepEqual(await sweepSessionUnreachable(deps([])), { mode: "shadow", why: "in-flight" });
  release();
  assert.equal((await first).mark, 1);
});

test("[S5] ★ 기억은 테넌트별이다 — 한 테넌트의 표식이 다른 테넌트 장부에 실리지 않는다", async () => {
  process.env.LIVELY_SESSION_LOST_RULE = "on";
  const A = { id: "t-a", slug: "acme" }, B = { id: "t-b", slug: "beta" };
  await withTenant(A, () => sweepSessionUnreachable(deps([])));
  assert.deepEqual(withTenant(A, () => [...unreachableMemoryMarks().keys()]), ["box-m"]);
  assert.deepEqual(withTenant(B, () => [...unreachableMemoryMarks().keys()]), [], "🔴 남의 테넌트 표식이 보인다");
  //  B 의 판은 A 의 기억(말한 것·표식)을 건드리지 않는다.
  await withTenant(B, () => sweepSessionUnreachable({ ...deps([]), hosts: () => [{ ...host(), missing: new Map() }], managed: async () => [] }));
  assert.deepEqual(withTenant(A, () => [...unreachableMemoryMarks().keys()]), ["box-m"]);
});

test("[S6] 연속 null 판 수를 요약에 싣는다(그림자 대조 — 판정 재료 없는 호스트가 얼마나 오래 그랬나)", async () => {
  const r = await sweepSessionUnreachable({ ...deps([]), hosts: () => [{ ...host(), nullStreak: 3 }, { ...host(), nodeId: "i-b", nullStreak: 9 }] });
  assert.equal(r.nullStreakMax, 9);
});

test("[S7] 배선 — DB 에 적을 때 «안 보이기 시작한 시각» 을 그대로 넘기고 · 판정 재료는 «안 보임» sid 를 실어 묻고 · 위탁 작업은 남의 것으로 본다", () => {
  const src = readFileSync(new URL("../../src/sessions/session-unreachable-sweep.ts", import.meta.url), "utf8");
  assert.match(src, /markRow: \(id, sinceMs\) => markSessionUnreachable\(id, sinceMs\)/, "🔴 sinceMs 를 안 넘긴다 — 복원 경합 방어가 꺼진다");
  assert.match(src, /rows: \(missingIds\) => listUnreachableRuleRows\(missingIds\)/, "🔴 «안 보임» sid 의 행을 안 묻는다 — 행 있는 세션을 행 없는 세션으로 본다");
  assert.match(src, /ownedElsewhere: \(id\) => JOB_SESSION_ID_RE\.test\(id\)/, "🔴 위탁 작업 컨테이너를 판정한다");
});
