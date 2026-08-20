// 순수 단위 체크(node:assert) — 노드 세션 스냅샷 정본의 쓰기·신선도 판정(#1834).
// 실행: npm run build && node dist/node/node-state-store.test.js
import assert from "node:assert/strict";
import { isFresh, sessionsDigest, shouldPersist, STATE_KEEP_MS, STATE_WRITE_MIN_MS } from "./node-state-store.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const T = 1_700_000_000_000;
const sess = (id: string, extra: Record<string, unknown> = {}): SessionInfo =>
  ({ id, label: id, owner: "yoon", agentState: "idle", attached: false, ...extra } as unknown as SessionInfo);

t("D1 같은 목록은 같은 서명, 세션이 늘거나 줄면 다른 서명", () => {
  assert.equal(sessionsDigest([sess("a"), sess("b")]), sessionsDigest([sess("a"), sess("b")]));
  assert.notEqual(sessionsDigest([sess("a")]), sessionsDigest([sess("a"), sess("b")]));
});
t("D2 세션 **속성**이 바뀌어도 서명이 바뀐다 — 목록 길이만 보면 상태 변화를 정본이 놓친다", () => {
  assert.notEqual(sessionsDigest([sess("a", { agentState: "run" })]), sessionsDigest([sess("a", { agentState: "idle" })]));
});
t("D3 빈 값·null·undefined 는 모두 빈 목록으로 — 정본에 'null' 이 들어가지 않는다", () => {
  assert.equal(sessionsDigest([]), "[]");
  assert.equal(sessionsDigest(null), "[]");
  assert.equal(sessionsDigest(undefined), "[]");
});

t("P1 처음 보는 노드는 무조건 쓴다(정본에 행이 없다)", () => {
  assert.equal(shouldPersist(null, "x", T), true);
  assert.equal(shouldPersist(undefined, "x", T), true);
});
t("P2 목록이 바뀌면 **즉시** 쓴다 — 세션이 뜨고 지는 순간이 정본에 늦게 반영되면 복구가 옛 목록을 되살린다", () => {
  assert.equal(shouldPersist({ digest: "old", at: T }, "new", T + 1), true);
});
t("P3 ★ 무변경 보고는 최소 간격 전까지 안 쓴다 — 노드는 3초마다 보고한다(그대로 쓰면 노드당 분당 20 write)", () => {
  assert.equal(shouldPersist({ digest: "same", at: T }, "same", T + 3_000), false);
  assert.equal(shouldPersist({ digest: "same", at: T }, "same", T + 30_000), false);
});
t("P4 무변경이어도 최소 간격이 지나면 쓴다 — reported_at 이 굳으면 살아 있는 노드가 보존 기한에 걸려 사라진다", () => {
  assert.equal(shouldPersist({ digest: "same", at: T }, "same", T + STATE_WRITE_MIN_MS), true);
  assert.equal(shouldPersist({ digest: "same", at: T }, "same", T + STATE_WRITE_MIN_MS - 1), false);
});

t("F1 방금 받은 스냅샷은 신선하다", () => { assert.equal(isFresh(T, T + 1000), true); });
t("F2 ★ 게이트웨이 재배포 창(수십 초~수 분)은 당연히 기한 안 — 복구가 목적이므로 여기서 걸리면 안 된다", () => {
  assert.equal(isFresh(T, T + 33_000), true);      // 노드 재연결 최악(백오프 30s + push 3s)
  assert.equal(isFresh(T, T + 10 * 60_000), true);
});
t("F3 경계 — 기한 직전은 신선하고, 넘으면 아니다", () => {
  assert.equal(isFresh(T, T + STATE_KEEP_MS - 1), true);
  assert.equal(isFresh(T, T + STATE_KEEP_MS), false);
});
t("F4 시각을 모르면(NaN) 보여주지 않는다 — 근거 없는 행을 목록에 올리지 않는다", () => {
  assert.equal(isFresh(NaN, T), false);
  assert.equal(isFresh(T, NaN), false);
});
t("F5 시계가 앞선 노드(미래 reported_at)는 신선한 쪽으로 — 시계 어긋남으로 세션을 숨기지 않는다", () => {
  assert.equal(isFresh(T + 60_000, T), true);
});

t("C1 상수 관계 — 쓰기 간격은 보고 주기(3s)보다 훨씬 크고, 보존 기한보다는 훨씬 작다", () => {
  assert.ok(STATE_WRITE_MIN_MS >= 10 * 3_000);
  assert.ok(STATE_WRITE_MIN_MS < STATE_KEEP_MS / 100);
});

console.log(`\n${pass} passed`);
