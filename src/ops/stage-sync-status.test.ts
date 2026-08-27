// #2116 — dev 동기 상태의 계약. 이 판정이 곧 "dev 가 낡았다는 걸 밖에서 알 수 있나"다.
//  🔴 경계가 틀리면 — 매 주기 degraded 로 깜빡이거나(과민), 몇십 분을 조용히 넘긴다(둔감. 이번 사고가 그것이다).
//  🔴 잡이 죽은 것을 못 잡으면 — 상태 파일이 옛날 채로 '동기됨'이라 말하고, 그게 가장 위험한 거짓말이다.
//  🔴 파일이 없는 설치에서 null 이 아니면 — serve-sync 를 안 쓰는 대다수 설치의 /readyz 에 헛 필드가 실린다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { stageSyncHealth } from "./stage-sync-status.js";

const T = Date.parse("2026-08-26T23:00:00Z");
const iso = (offsetSec: number): string => new Date(T + offsetSec * 1000).toISOString();
const STUCK = 600, STALE = 300;

test("E1 파일이 없거나 못 읽으면 null — 이 기능이 없는 설치다", () => {
  assert.equal(stageSyncHealth(null, T), null);
  assert.equal(stageSyncHealth(undefined, T), null);
  assert.equal(stageSyncHealth({}, T), null);
  assert.equal(stageSyncHealth({ at: "쓰레기", state: "synced" }, T), null, "🔴 시각을 못 읽는데 판정했다");
  assert.equal(stageSyncHealth({ at: iso(0), state: "무엇" }, T), null, "🔴 모르는 state 를 판정했다");
});

test("E2 동기됨 — ok, 막힌 시간 0", () => {
  const h = stageSyncHealth({ at: iso(-30), state: "synced" }, T, STUCK, STALE);
  assert.deepEqual(h, { ok: true, state: "synced", code: null, stuckSec: 0 });
});

test("E3 막 건너뛰기 시작 — 아직 정상", () => {
  const h = stageSyncHealth({ at: iso(-10), state: "skipped", code: "unpushed", since: iso(-60) }, T, STUCK, STALE);
  assert.equal(h?.ok, true);
  assert.equal(h?.code, "unpushed");
  assert.equal(h?.stuckSec, 60);
});

test("E4 ★ 경계 — 정확히 임계면 아직 정상(> 로 판정)", () => {
  const h = stageSyncHealth({ at: iso(-10), state: "skipped", code: "dirty", since: iso(-STUCK) }, T, STUCK, STALE);
  assert.equal(h?.ok, true, "🔴 경계에서 벌써 경보한다 — 매 주기 깜빡인다");
  assert.equal(h?.stuckSec, STUCK);
});

test("E5 ★ 임계 + 1초 — degraded 로 드러난다", () => {
  const h = stageSyncHealth({ at: iso(-10), state: "skipped", code: "unpushed", since: iso(-STUCK - 1) }, T, STUCK, STALE);
  assert.equal(h?.ok, false, "🔴 오래 막혀 있는데 정상이라 답했다 — 이번 사고가 정확히 이것이다");
  assert.equal(h?.code, "unpushed");
});

test("E6 ★ 잡이 죽었다 — 상태가 오래 안 갱신되면 'stale'(동기됨이라 우기지 않는다)", () => {
  const h = stageSyncHealth({ at: iso(-STALE - 1), state: "synced" }, T, STUCK, STALE);
  assert.equal(h?.state, "stale", "🔴 옛날 상태를 그대로 '동기됨'으로 답했다 — 가장 위험한 거짓말");
  assert.equal(h?.ok, false);
  // 경계: 정확히 staleSec 이면 아직 살아 있는 것으로 본다
  assert.equal(stageSyncHealth({ at: iso(-STALE), state: "synced" }, T, STUCK, STALE)?.state, "synced");
});

test("E7 since 가 없는 구 판 — at 을 시작으로 본다", () => {
  const h = stageSyncHealth({ at: iso(-120), state: "skipped", code: "merging" }, T, STUCK, STALE);
  assert.equal(h?.stuckSec, 120);
  assert.equal(h?.ok, true);
});

test("E8 시계가 어긋나 미래 시각이 와도 음수 나이를 만들지 않는다", () => {
  const h = stageSyncHealth({ at: iso(60), state: "skipped", since: iso(60) }, T, STUCK, STALE);
  assert.equal(h?.stuckSec, 0, "🔴 음수 나이는 '아주 신선함'으로 읽혀 경보를 삼킨다");
  assert.equal(h?.ok, true);
});

test("E9 사유가 비어 있어도 무엇인가는 말한다", () => {
  assert.equal(stageSyncHealth({ at: iso(-10), state: "skipped" }, T, STUCK, STALE)?.code, "unknown");
});
