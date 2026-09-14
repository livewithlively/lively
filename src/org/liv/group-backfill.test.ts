// 묶음 보정 판정(#1631, 2026-09-14) — 엣지 표 F1~F7(scratchpad/spec.md) 행마다 한 검사.
//  계기: lively-agent-2-6a84 — 처음 설정·리브 2턴을 다 지났는데 묶음 0개. 심는 두 자리를 이미 지나간 워크스페이스를 한 번 채운다.
import test from "node:test";
import assert from "node:assert/strict";
import { planGroupBackfill, GROUPS_FEATURE_SINCE, type BackfillMember } from "./group-backfill.js";

const AFTER = "2026-09-14T03:10:00Z";
const owner = (over: Partial<BackfillMember> = {}): BackfillMember => ({
  id: "agent-2", welcome: { done_at: AFTER, stage: "solo" }, join: { via: "creator" },
  workAsis: "1인·프리랜서로 여러 일을 한다 · 디자인·크리에이티브", ...over,
});

test("F1 묶음이 이미 있으면 보정하지 않는다", () => {
  assert.equal(planGroupBackfill({ hasGroups: true, members: [owner()] }), null);
});

test("F2 묶음 0 · 기능 이후에 끝낸 주인 — 그 사람의 무대·직무로", () => {
  assert.deepEqual(planGroupBackfill({ hasGroups: false, members: [owner()] }),
    { memberId: "agent-2", stage: "solo", workAsis: "1인·프리랜서로 여러 일을 한다 · 디자인·크리에이티브" });
});

test("F3 기능 이전에 끝냈으면 옛 판 — 건드리지 않는다", () => {
  assert.equal(planGroupBackfill({ hasGroups: false, members: [owner({ welcome: { done_at: "2026-09-10T00:00:00Z", stage: "company" } })] }), null);
});

test("F4 합류자(via=invite)만 있으면 — 신입의 직무로 팀 묶음을 심지 않는다", () => {
  assert.equal(planGroupBackfill({ hasGroups: false, members: [owner({ id: "newbie", join: { via: "invite" } })] }), null);
});

test("F5 합류자와 주인이 같이 있으면 주인 답으로 — 합류자가 먼저 끝냈어도 · 주인이 둘이면 먼저 끝낸 사람", () => {
  const plan = planGroupBackfill({ hasGroups: false, members: [
    owner({ id: "newbie", join: { via: "invite" }, welcome: { done_at: "2026-09-14T02:00:00Z", stage: "company" } }),
    owner({ id: "boss", welcome: { done_at: "2026-09-14T04:00:00Z", stage: "company" }, workAsis: "회사·조직에서 팀과 함께 일한다 · 경영·전략" }),
  ] });
  assert.equal(plan?.memberId, "boss");
  assert.equal(plan?.stage, "company");
  const two = planGroupBackfill({ hasGroups: false, members: [
    owner({ id: "late", welcome: { done_at: "2026-09-14T05:00:00Z" } }),
    owner({ id: "early", welcome: { done_at: "2026-09-14T01:00:00Z" } }),
  ] });
  assert.equal(two?.memberId, "early");
});

test("F6 경계 — 정확히 기능 시각에 끝냈으면 보정한다(>=) · 1초 전이면 안 한다", () => {
  assert.equal(planGroupBackfill({ hasGroups: false, members: [owner({ welcome: { done_at: GROUPS_FEATURE_SINCE } })] })?.memberId, "agent-2");
  assert.equal(planGroupBackfill({ hasGroups: false, members: [owner({ welcome: { done_at: "2026-09-12T23:59:59Z" } })] }), null);
});

test("F7 끝낸 시각이 없거나 날짜가 아니면 보정하지 않는다 · join 기록이 없는 사람은 주인으로 본다", () => {
  assert.equal(planGroupBackfill({ hasGroups: false, members: [owner({ welcome: null })] }), null);
  assert.equal(planGroupBackfill({ hasGroups: false, members: [owner({ welcome: { done_at: "어제" } })] }), null);
  assert.equal(planGroupBackfill({ hasGroups: false, members: [owner({ join: null })] })?.memberId, "agent-2");
});
