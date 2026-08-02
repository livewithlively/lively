// #1313 R44 — 커서 전진 불변식 회귀 잠금. SPI 라이프사이클 훅(postSync)으로 특례를 이관하면서
//  "모든 단계 성공 후에만 커서를 전진"이 훅 반환값(PostSyncResult)으로 보존되는지를 **페이크 커넥터**로 고정한다.
//  라이브 커넥터 실행은 증분 커서라 재현 불가 → 조건 조합(freezeCursor 유무 × ingested 0/>0 ×
//  mirrorFailures 유무 × 시각 진전 유무 × retry 목록 변화)을 순수 판정(planCursorWrite)에 직접 먹인다.
//
//  판정 ↔ run-sync 대응(이 테스트가 지키는 계약):
//   · plan.freeze  → run-sync 는 `return true`(exit 1) + connector_state **미기록**.
//   · plan.write   → 그 페이로드 그대로 setConnectorState. null 이면 기록 자체를 생략.
//   · plan.advance → 완료 로그의 cursorAdvanced/cursorIso.
//  실행: npm run build && node dist/connectors/sync-cursor.test.js  (순수 함수 — DB/네트워크 무의존)
import assert from "node:assert/strict";
import { planCursorWrite } from "./sync-cursor.js";
import type { Connector, PostSyncCtx, PostSyncResult } from "./types.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; console.log(`ok  ${name}`); });

const PREV_ISO = "2026-07-01T00:00:00.000Z";
const PREV_MS = Date.parse(PREV_ISO);
const NEW_MS = PREV_MS + 60_000;
const NEW_ISO = new Date(NEW_MS).toISOString();

// ── 페이크 커넥터 3종 — 실제 구현(notion/domain-wiki/훅 없는 커넥터)의 반환 계약만 흉내낸다. ──
const fakeBackfill = async function* (): AsyncIterable<never> {}; // 이 테스트는 커서 판정만 본다
/** 훅 없는 커넥터(slack/discord/gmail/…) — postSync 자체가 없다. */
const plainConnector: Connector = { name: "fake-plain", backfill: fakeBackfill };
/** domain-wiki 형 — 스윕만 하고 커서 시맨틱은 건드리지 않는다(항상 빈 결과). */
const sweepConnector: Connector = {
  name: "fake-sweep", backfill: fakeBackfill,
  postSync: async (_ctx: PostSyncCtx): Promise<PostSyncResult> => ({}),
};
/** notion 형 — 실패 성격에 따라 동결/재시도목록/청산을 반환한다. */
const notionLikeConnector = (r: PostSyncResult): Connector => ({
  name: "fake-notion", backfill: fakeBackfill,
  postSync: async (_ctx: PostSyncCtx): Promise<PostSyncResult> => r,
});

const ctx = (over: Partial<PostSyncCtx> = {}): PostSyncCtx => ({
  pool: null as never, runStartIso: PREV_ISO, incremental: false, ingested: 3, mirrorFailures: 0, ...over,
});
/** 커넥터의 postSync 를 실제로 태워(훅 없으면 null) 커서 계획을 얻는다 — run-sync 의 배선과 동일 순서. */
async function planFor(conn: Connector, over: { maxMs?: number; mirrorFailures?: number; ingested?: number; prevRetry?: string[] } = {}) {
  const mirrorFailures = over.mirrorFailures ?? 0;
  const post = conn.postSync
    ? await conn.postSync(ctx({ ingested: over.ingested ?? 3, mirrorFailures }))
    : null;
  return planCursorWrite({
    prevIso: PREV_ISO, prevMs: PREV_MS, maxMs: over.maxMs ?? NEW_MS,
    mirrorFailures, prevRetry: over.prevRetry ?? [], post,
  });
}

// ── ① 훅 없는 커넥터 — 시각 진전 + 무실패면 전진. ──
await t("훅 없는 커넥터: 무실패 + 관측 진전 → 커서 전진", async () => {
  const p = await planFor(plainConnector);
  assert.equal(p.freeze, false);
  assert.equal(p.advance, true);
  assert.deepEqual(p.write, { max_updated_iso: NEW_ISO });
});

await t("훅 없는 커넥터: 미러 실패 있으면 진전해도 동결(전진 금지·기록 생략) #541", async () => {
  const p = await planFor(plainConnector, { mirrorFailures: 2 });
  assert.equal(p.advance, false);
  assert.equal(p.write, null);   // 쓸 것이 없으면 기록 자체를 안 한다
  assert.equal(p.freeze, false); // 미러 실패는 run 실패 판정(mirrorFailures>0)이지 훅 동결이 아니다
});

await t("훅 없는 커넥터: 무진전(maxMs<=prevMs)이면 전진 금지 — 시계 추측 금지", async () => {
  assert.equal((await planFor(plainConnector, { maxMs: PREV_MS })).advance, false);
  assert.equal((await planFor(plainConnector, { maxMs: PREV_MS - 1 })).advance, false);
  assert.equal((await planFor(plainConnector, { maxMs: PREV_MS })).write, null);
});

// ── ② 스윕형 훅(domain-wiki) — 커서 시맨틱 불변: ingested 0/>0 어느 쪽도 커서 판정을 바꾸지 않는다. ──
await t("스윕형 훅: ingested>0 이든 0 이든 커서 판정 동일(훅이 빈 결과)", async () => {
  const withRows = await planFor(sweepConnector, { ingested: 5 });
  const empty = await planFor(sweepConnector, { ingested: 0 });
  assert.deepEqual(withRows, empty);
  assert.equal(withRows.advance, true);
  assert.deepEqual(withRows.write, { max_updated_iso: NEW_ISO });
});

await t("스윕형 훅 + 미러 실패: 전진 금지(스윕 생략 경로여도 커서는 동결)", async () => {
  const p = await planFor(sweepConnector, { mirrorFailures: 1, ingested: 0 });
  assert.equal(p.advance, false);
  assert.equal(p.write, null);
});

// ── ③ freezeCursor — 훅이 '무엇을 놓쳤는지 모르는 실패'를 신고하면 진전·무실패여도 무조건 동결. ──
await t("freezeCursor: 관측 진전 + 미러 실패 0 이어도 커서 미기록 + run 실패", async () => {
  const p = await planFor(notionLikeConnector({ freezeCursor: true }));
  assert.equal(p.freeze, true);
  assert.equal(p.advance, false);
  assert.equal(p.write, null);
});

await t("freezeCursor: retryIds 를 함께 반환해도 기록하지 않는다(동결이 우선)", async () => {
  const p = await planFor(notionLikeConnector({ freezeCursor: true, retryIds: ["a"] }), { prevRetry: [] });
  assert.equal(p.freeze, true);
  assert.equal(p.write, null);
});

// ── ④ 부분 성공 시맨틱(#586) — 커서는 전진/보존하고 재시도 목록만 기록. ──
await t("retryIds 신규: 시각 무진전이어도 이전 커서를 보존한 채 retry_ids 기록", async () => {
  const p = await planFor(notionLikeConnector({ retryIds: ["p1", "p2"] }), { maxMs: PREV_MS, prevRetry: [] });
  assert.equal(p.freeze, false);
  assert.equal(p.advance, false);
  assert.deepEqual(p.write, { max_updated_iso: PREV_ISO, retry_ids: ["p1", "p2"] }); // 커서 유지(퇴행 금지)
});

await t("retryIds 신규 + 진전: 전진한 커서와 함께 기록", async () => {
  const p = await planFor(notionLikeConnector({ retryIds: ["p1"] }));
  assert.equal(p.advance, true);
  assert.deepEqual(p.write, { max_updated_iso: NEW_ISO, retry_ids: ["p1"] });
});

await t("retryIds 청산: 이전 목록이 있으면 빈 목록으로 기록(다음 run 재시도 시드 제거)", async () => {
  const p = await planFor(notionLikeConnector({ retryIds: [] }), { maxMs: PREV_MS, prevRetry: ["p1"] });
  assert.deepEqual(p.write, { max_updated_iso: PREV_ISO, retry_ids: [] });
});

await t("retryIds 무변화 + 무진전: 기록 생략(무의미한 write 노이즈 방지)", async () => {
  const p = await planFor(notionLikeConnector({ retryIds: ["p1"] }), { maxMs: PREV_MS, prevRetry: ["p1"] });
  assert.equal(p.write, null);
});

await t("retryIds 동수·다른 원소: 변경으로 보고 기록", async () => {
  const p = await planFor(notionLikeConnector({ retryIds: ["p2"] }), { maxMs: PREV_MS, prevRetry: ["p1"] });
  assert.deepEqual(p.write, { max_updated_iso: PREV_ISO, retry_ids: ["p2"] });
});

await t("retryIds + 미러 실패: 시각커서는 전진하지 않고 목록만 기록", async () => {
  const p = await planFor(notionLikeConnector({ retryIds: ["p1"] }), { mirrorFailures: 1, prevRetry: [] });
  assert.equal(p.advance, false);
  assert.deepEqual(p.write, { max_updated_iso: PREV_ISO, retry_ids: ["p1"] });
});

// ── ⑤ 첫 run(저장된 커서 없음) — max_updated_iso 없이 retry 만 기록되는 경계. ──
await t("첫 run: prevIso 없음 + 무진전 + retry 변경 → max_updated_iso 키 자체가 없다", () => {
  const p = planCursorWrite({
    prevIso: undefined, prevMs: 0, maxMs: 0, mirrorFailures: 0, prevRetry: [], post: { retryIds: ["p1"] },
  });
  assert.deepEqual(p.write, { retry_ids: ["p1"] });
});

await t("첫 run: prevIso 없음 + 관측 있음 → 관측 최대로 전진", () => {
  const p = planCursorWrite({
    prevIso: undefined, prevMs: 0, maxMs: NEW_MS, mirrorFailures: 0, prevRetry: [], post: null,
  });
  assert.equal(p.advance, true);
  assert.deepEqual(p.write, { max_updated_iso: NEW_ISO });
});

console.log(`\n${pass} passed`);
