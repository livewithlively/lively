// #4135 — **이미 떠 있는 노드 세션에 자격 심기(`node-session-token-backfill.ts`)** 의 사양 시험 — 사양 D(되채우기 6–15)만 보고 쓴 블라인드 시험.
//
// ── 무엇이 고장나 있었나 ─────────────────────────────────────────────────────
// C(사전 발급)는 새로 뜨는 세션에만 닿는다. 이미 떠 있는 노드 세션은 토큰 없이 돌고 있고 살아 있는 프로세스의 env 는
//  못 바꾼다. 그래서 게이트웨이가 살아 있는 노드 세션을 볼 때마다 «아직 토큰 없는 것» 을 골라 그 주인 앞으로 구워
//  노드에 심는다(세션 토큰 파일). 이 시험은 그 «고르고·굽고·심고·되돌리는» 판정을 가짜 deps 로 본다.
//
// ── 여기서 지키는 것(createNodeSessionTokenBackfill(deps).run(nodeId, sessions)) ──
//   6. 셀프 노드(`deps.isSelf`)면 아무것도 하지 않는다(민팅·푸시·회수 0).
//   7. 세션 id 형식(`^box-[a-z0-9-]+-[a-f0-9]{8}$`)이 아닌 항목은 무시한다.
//   8. 이 기계가 **이 노드에** 심은 세션이 이번 스냅샷에 없으면 `deps.revoke(그 id)` 를 부르고(revoked+1), 다시 나타나면 다시 심는다.
//      여기서 심지 않은 세션(preissue 로 뜬 것)은 사라져도 회수하지 않는다.
//   9. `deps.supports(nodeId)` 가 false 면 여기서 멈춘다(민팅·푸시 0). 기억하지 않는다 — 다음 판에 true 면 그때 심는다.
//  10. 후보 = 아직 처리(성공·건너뜀)하지 않았고 백오프 중이 아닌 세션. 후보가 없으면 `deps.haveTokens` 를 **부르지 않는다**.
//      후보가 있으면 판마다 **한 번만** 부른다.
//  11. `haveTokens` 에 든 id 는 건너뛰고(skipped+1) 기억한다. 주인(`owner`)이 비어 있어도 같다.
//  12. 나머지는 `deps.mint(owner, id)` → 둘 다 null 이면 건너뛰고 기억한다. 하나라도 있으면 `deps.push(nodeId, id, tokens)`;
//      성공하면 minted+1, 기억한다, «이 노드에 심은 세션» 으로 적는다.
//  13. `push` 가 던지면 `deps.revoke(id)` 를 부르고(revoke 실패는 삼킨다) failed+1, `retryAfterMs`(기본 BACKFILL_RETRY_AFTER_MS) 동안은
//      후보가 아니다. 지나면 다시 후보다. `mint` 가 던져도 failed+1 · 같은 백오프.
//  14. `haveTokens` 가 던지면 그 판은 아무것도 심지 않고 끝난다(다음 판에 다시).
//  15. `run` 은 절대 던지지 않는다.
//  ⚠ 기본 deps 는 DB·노드를 만진다 — 언제나 호출을 전부 기록하는 가짜 deps 를 넘기고, 시간은 `now`·`retryAfterMs` 로 돌린다.
import test from "node:test";
import assert from "node:assert/strict";
import { BACKFILL_RETRY_AFTER_MS, createNodeSessionTokenBackfill } from "./node-session-token-backfill.js";
import type { BackfillDeps } from "./node-session-token-backfill.js";
import type { SessionInfo } from "./catalog.js";

// ── 재료 ────────────────────────────────────────────────────────────────────
const SESSION_ID_RE = /^box-[a-z0-9-]+-[a-f0-9]{8}$/;      // 사양 D7 의 세션 id 형식
const NODE = "node-lvly-linux-2";
const NODE2 = "node-lvly-mac-1";
const A = "box-wonjoon-jang-0123abcd";
const B = "box-wonjoon-jang-deadbeef";
const C = "box-sangmin-kim-cafebabe";
const BAD_IDS = [
  "", "BOX-wonjoon-jang-0123abcd", "box-wonjoon-jang-0123ABCD", "box-wonjoon-jang-0123abc", "box-wonjoon-jang-0123abcd9",
  "box-", "not-a-session", "box-wonjoon_jang-0123abcd", "box-wonjoon-jang-0123abcd/../y", " box-wonjoon-jang-0123abcd",
];
for (const id of [A, B, C]) assert.match(id, SESSION_ID_RE, `시험 재료 오류: ${id}`);
for (const id of BAD_IDS) assert.doesNotMatch(id, SESSION_ID_RE, `시험 재료 오류(형식에 맞는다): ${id}`);

type Tokens = { hook: string | null; mcp: string | null };
const ZERO = { minted: 0, skipped: 0, revoked: 0, failed: 0 };

/** 가짜 스냅샷 항목 — 사양이 말하는 필드는 id·owner 뿐 */
const sess = (id: string, owner = "wonjoon-jang"): SessionInfo =>
  ({ id, owner, label: "t", harness: "claude" } as unknown as SessionInfo);

type MintMode = "ok" | "null" | "hookOnly" | "mcpOnly" | "reject" | "throwSync";
type PushMode = "ok" | "reject" | "throwSync";
type ThrowMode = "ok" | "reject" | "throwSync";
interface MintCall { owner: string; id: string }
interface PushCall { nodeId: string; id: string; tokens: Tokens }

/** 민터가 주는 토큰 — id 가 실렸는지 push 인자에서 확인된다 */
const tokensOf = (id: string, mode: MintMode): Tokens => ({
  hook: mode === "mcpOnly" || mode === "null" ? null : `hook:${id}`,
  mcp: mode === "hookOnly" || mode === "null" ? null : `mcp:${id}`,
});

/**
 * 가짜 deps — 호출을 전부 기록하고, 세션별·전역 모드에 따라 값·null·거부·동기 예외를 낸다.
 *  필드를 시험 중간에 바꿔도(k.self, k.supports, k.have, k.clock, k.mintMode…) 다음 호출부터 반영된다.
 */
function fakeDeps(init: { self?: boolean; supports?: boolean; retryAfterMs?: number; have?: string[] } = {}) {
  const k = {
    self: init.self ?? false,
    supports: init.supports ?? true,
    have: new Set<string>(init.have ?? []),
    haveMode: "ok" as ThrowMode,
    mintMode: new Map<string, MintMode>(),
    pushMode: new Map<string, PushMode>(),
    revokeMode: "ok" as ThrowMode,
    clock: 1_700_000_000_000,
    calls: {
      haveTokens: 0,
      mint: [] as MintCall[],
      push: [] as PushCall[],
      revoke: [] as string[],
    },
    reset() { k.calls = { haveTokens: 0, mint: [], push: [], revoke: [] }; },
  };
  const deps: BackfillDeps = {
    isSelf: () => k.self,
    supports: () => k.supports,
    haveTokens: () => {
      k.calls.haveTokens++;
      if (k.haveMode === "throwSync") throw new Error("haveTokens 동기 예외");
      if (k.haveMode === "reject") return Promise.reject(new Error("haveTokens 실패"));
      return Promise.resolve(new Set(k.have));
    },
    mint: (owner: string, id: string) => {
      k.calls.mint.push({ owner, id });
      const mode = k.mintMode.get(id) ?? "ok";
      if (mode === "throwSync") throw new Error(`mint 동기 예외: ${id}`);
      if (mode === "reject") return Promise.reject(new Error(`mint 실패: ${id}`));
      return Promise.resolve(tokensOf(id, mode));
    },
    push: (nodeId: string, id: string, tokens: Tokens) => {
      k.calls.push.push({ nodeId, id, tokens });
      const mode = k.pushMode.get(id) ?? "ok";
      if (mode === "throwSync") throw new Error(`push 동기 예외: ${id}`);
      if (mode === "reject") return Promise.reject(new Error(`push 실패: ${id}`));
      return Promise.resolve({ ok: true });
    },
    revoke: (id: string) => {
      k.calls.revoke.push(id);
      if (k.revokeMode === "throwSync") throw new Error(`revoke 동기 예외: ${id}`);
      if (k.revokeMode === "reject") return Promise.reject(new Error(`revoke 실패: ${id}`));
      return Promise.resolve({ revoked: id });
    },
    now: () => k.clock,
    ...(init.retryAfterMs === undefined ? {} : { retryAfterMs: init.retryAfterMs }),
  };
  return Object.assign(k, { deps });
}

const mintedIds = (k: ReturnType<typeof fakeDeps>) => k.calls.mint.map((c) => c.id);
const pushedIds = (k: ReturnType<typeof fakeDeps>) => k.calls.push.map((c) => c.id);

// ═══ 0. 상수 ═══════════════════════════════════════════════════════════════
test("D0 BACKFILL_RETRY_AFTER_MS 는 10분", () => {
  assert.equal(BACKFILL_RETRY_AFTER_MS, 10 * 60 * 1000);
});

// ═══ 6. 셀프 노드 ═══════════════════════════════════════════════════════════
test("D6-1 셀프 노드면 아무것도 하지 않는다 — haveTokens·mint·push·revoke 0, 결과 전부 0, 두 번 불러도 같다", async () => {
  const k = fakeDeps({ self: true });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO, "두 번째 판(B 가 사라졌지만 심은 적이 없다)");
  assert.equal(k.calls.haveTokens, 0, "haveTokens");
  assert.deepEqual(k.calls.mint, [], "mint");
  assert.deepEqual(k.calls.push, [], "push");
  assert.deepEqual(k.calls.revoke, [], "revoke");
});

// ═══ 7. 형식 위반 id ═══════════════════════════════════════════════════════
test("D7-1 세션 id 형식이 아닌 항목은 무시한다 — 형식에 맞는 것만 심고, 형식 위반은 mint·push 어디에도 안 나온다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  const out = await bf.run(NODE, [...BAD_IDS.map((id) => sess(id)), sess(A), sess(C, "sangmin-kim")]);
  assert.deepEqual(out, { ...ZERO, minted: 2 });
  assert.deepEqual(mintedIds(k).sort(), [A, C].sort());
  assert.deepEqual(pushedIds(k).sort(), [A, C].sort());
  for (const c of [...k.calls.mint, ...k.calls.push]) assert.match(c.id, SESSION_ID_RE, `형식 위반 id 가 새어 나왔다: ${c.id}`);
});

test("D7-2 형식 위반 항목뿐이면 후보가 없다 — haveTokens 도 부르지 않고 결과 전부 0", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, BAD_IDS.map((id) => sess(id))), ZERO);
  assert.equal(k.calls.haveTokens, 0, "형식 위반뿐인데 haveTokens 를 불렀다");
  assert.deepEqual(k.calls.mint, []);
  assert.deepEqual(k.calls.push, []);
  assert.deepEqual(k.calls.revoke, []);
});

// ═══ 8. 사라진 세션 회수 · 다시 나타나면 다시 심기 ═══════════════════════════
test("D8-1 이 노드에 심은 세션이 스냅샷에서 빠지면 revoke(그 id) 를 정확히 한 번(revoked+1) — 다음 판에도 또 부르지 않는다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 });
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, revoked: 1 });
  assert.deepEqual(k.calls.revoke, [B], "사라진 B 만 회수해야 한다");
  assert.deepEqual(k.calls.mint, [], "A 는 이미 처리됐다");
  assert.equal(k.calls.haveTokens, 0, "후보가 없는데 haveTokens 를 불렀다");
  // 계속 없는 상태 — 두 번 회수하지 않는다
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assert.deepEqual(k.calls.revoke, [], "이미 회수한 B 를 또 회수했다");
});

test("D8-2 회수된 세션이 다시 나타나면 다시 심는다 — mint·push 가 다시 불리고 minted+1", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  await bf.run(NODE, [sess(A), sess(B)]);
  await bf.run(NODE, [sess(A)]);                       // B 사라짐 → 회수
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1, "후보(B)가 있으니 haveTokens 한 번");
  assert.deepEqual(k.calls.mint, [{ owner: "wonjoon-jang", id: B }]);
  assert.deepEqual(k.calls.push, [{ nodeId: NODE, id: B, tokens: { hook: `hook:${B}`, mcp: `mcp:${B}` } }]);
  assert.deepEqual(k.calls.revoke, []);
  // 또 사라지면 또 회수한다(다시 심은 것도 «이 노드에 심은 세션» 이다)
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, revoked: 1 });
  assert.deepEqual(k.calls.revoke, [B]);
});

test("D8-3 여기서 심지 않은 세션(haveTokens 에 있던 것 = preissue 로 뜬 것)은 사라져도 회수하지 않는다", async () => {
  const k = fakeDeps({ have: [A] });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1, skipped: 1 });
  assert.deepEqual(mintedIds(k), [B]);
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(B)]), ZERO, "A(preissue) 가 사라졌는데 revoked 가 올랐다");
  assert.deepEqual(k.calls.revoke, [], "preissue 로 뜬 A 를 회수했다");
  // 둘 다 사라지면 B 만 회수
  k.reset();
  assert.deepEqual(await bf.run(NODE, []), { ...ZERO, revoked: 1 });
  assert.deepEqual(k.calls.revoke, [B]);
});

test("D8-3b mint 가 둘 다 null 이라 건너뛴 세션도 «심은 세션» 이 아니다 — 사라져도 회수하지 않는다", async () => {
  const k = fakeDeps();
  k.mintMode.set(A, "null");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, skipped: 1 });
  k.reset();
  assert.deepEqual(await bf.run(NODE, []), ZERO);
  assert.deepEqual(k.calls.revoke, []);
});

test("D8-4 «이 노드에» 심은 것만 본다 — 다른 노드의 판에 안 보인다고 회수하지 않는다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.deepEqual(await bf.run(NODE2, [sess(C, "sangmin-kim")]), { ...ZERO, minted: 1 });
  k.reset();
  // NODE2 의 스냅샷엔 A 가 없는 게 당연하다 — A 는 NODE 에 심었다
  assert.deepEqual(await bf.run(NODE2, [sess(C, "sangmin-kim")]), ZERO);
  assert.deepEqual(k.calls.revoke, [], "다른 노드의 판에서 A 를 회수했다");
  // NODE 의 스냅샷에서 A 가 빠지면 그때 회수
  k.reset();
  assert.deepEqual(await bf.run(NODE, []), { ...ZERO, revoked: 1 });
  assert.deepEqual(k.calls.revoke, [A]);
});

test("D8-5 회수는 supports 판정보다 앞이다 — 노드가 더는 지원하지 않아도 심었던 세션이 사라지면 회수한다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  await bf.run(NODE, [sess(A), sess(B)]);
  k.reset();
  k.supports = false;
  const out = await bf.run(NODE, [sess(A)]);
  assert.equal(out.revoked, 1, `revoked: ${JSON.stringify(out)}`);
  assert.deepEqual(k.calls.revoke, [B]);
  assert.equal(out.minted, 0); assert.deepEqual(k.calls.mint, []); assert.deepEqual(k.calls.push, []);
});

// ═══ 9. supports ═══════════════════════════════════════════════════════════
test("D9-1 supports 가 false 면 멈춘다 — haveTokens·mint·push 0, 결과 0 · 기억하지 않아 다음 판에 true 면 그때 심는다", async () => {
  const k = fakeDeps({ supports: false });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO, "두 번째 판도 같다");
  assert.equal(k.calls.haveTokens, 0, "지원 안 하는데 haveTokens 를 불렀다");
  assert.deepEqual(k.calls.mint, []);
  assert.deepEqual(k.calls.push, []);
  assert.deepEqual(k.calls.revoke, []);
  // 이제 지원한다 — 둘 다 심는다(«지원 안 함» 을 처리로 기억하지 않았다)
  k.supports = true;
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 });
  assert.equal(k.calls.haveTokens, 1);
  assert.deepEqual(mintedIds(k).sort(), [A, B].sort());
  assert.deepEqual(pushedIds(k).sort(), [A, B].sort());
});

// ═══ 10. 후보 · haveTokens 호출 횟수 ═══════════════════════════════════════
test("D10-1 후보가 없으면 haveTokens 를 부르지 않는다 — 빈 스냅샷 · 전부 처리된 뒤의 같은 스냅샷", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, []), ZERO);
  assert.equal(k.calls.haveTokens, 0, "빈 스냅샷");
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, "sangmin-kim")]), { ...ZERO, minted: 3 });
  assert.equal(k.calls.haveTokens, 1);
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, "sangmin-kim")]), ZERO);
  assert.equal(k.calls.haveTokens, 0, "전부 처리된 뒤인데 haveTokens 를 불렀다");
  assert.deepEqual(k.calls.mint, [], "전부 처리된 뒤인데 다시 구웠다");
  assert.deepEqual(k.calls.push, []);
});

test("D10-2 후보가 여럿이어도 haveTokens 는 판마다 한 번 — 새 후보가 생기면 그 판에 다시 한 번", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  const many = Array.from({ length: 12 }, (_, i) => sess(`box-wonjoon-jang-${i.toString(16).padStart(8, "0")}`));
  assert.deepEqual(await bf.run(NODE, many), { ...ZERO, minted: 12 });
  assert.equal(k.calls.haveTokens, 1, "후보 12개에 haveTokens 를 여러 번 불렀다");
  assert.equal(k.calls.mint.length, 12);
  k.reset();
  assert.deepEqual(await bf.run(NODE, [...many, sess(A)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1, "새 후보 하나에 정확히 한 번");
  assert.deepEqual(mintedIds(k), [A]);
});

// ═══ 11. haveTokens 에 든 id · 주인 없음 → 건너뛰고 기억 ═════════════════════
test("D11-1 haveTokens 에 든 id 는 건너뛰고(skipped+1) 기억한다 — mint 없음, 다음 판엔 후보가 아니다(haveTokens 도 안 부른다)", async () => {
  const k = fakeDeps({ have: [A, C] });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, "sangmin-kim")]), { ...ZERO, minted: 1, skipped: 2 });
  assert.equal(k.calls.haveTokens, 1);
  assert.deepEqual(mintedIds(k), [B], "haveTokens 에 든 id 를 구웠다");
  assert.deepEqual(pushedIds(k), [B]);
  k.reset();
  k.have.clear();   // 이제 haveTokens 가 비어 있어도 — 기억이 있으니 다시 묻지 않는다
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, "sangmin-kim")]), ZERO);
  assert.equal(k.calls.haveTokens, 0, "건너뛴 세션을 기억하지 않았다");
  assert.deepEqual(k.calls.mint, []);
});

test("D11-2 주인(owner)이 비어 있으면 같다 — 건너뛰고(skipped+1) 기억한다, mint 를 부르지 않는다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A, ""), sess(B)]), { ...ZERO, minted: 1, skipped: 1 });
  assert.deepEqual(mintedIds(k), [B], "주인 없는 세션을 구웠다");
  assert.deepEqual(pushedIds(k), [B]);
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A, ""), sess(B)]), ZERO);
  assert.equal(k.calls.haveTokens, 0, "주인 없는 세션을 기억하지 않았다");
  assert.deepEqual(k.calls.mint, []);
  // owner 가 아예 없는(undefined) 항목도 같다
  const k2 = fakeDeps();
  const bf2 = createNodeSessionTokenBackfill(k2.deps);
  assert.deepEqual(await bf2.run(NODE, [{ id: A, label: "t", harness: "claude" } as unknown as SessionInfo]), { ...ZERO, skipped: 1 });
  assert.deepEqual(k2.calls.mint, []);
});

test("D11-3 haveTokens 에 든 id 는 주인이 비어 있어도 건너뛴다(skipped 는 세션당 1)", async () => {
  const k = fakeDeps({ have: [A] });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A, "")]), { ...ZERO, skipped: 1 });
  assert.deepEqual(k.calls.mint, []);
  assert.deepEqual(k.calls.push, []);
});

// ═══ 12. mint → push ═══════════════════════════════════════════════════════
test("D12-1 mint(owner, id) 의 인자 — 스냅샷의 owner 와 id 그대로 · push(nodeId, id, tokens) 는 민터가 준 토큰 그대로", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A, "wonjoon-jang"), sess(C, "sangmin-kim")]), { ...ZERO, minted: 2 });
  assert.deepEqual(k.calls.mint.sort((x, y) => x.id.localeCompare(y.id)),
    [{ owner: "wonjoon-jang", id: A }, { owner: "sangmin-kim", id: C }].sort((x, y) => x.id.localeCompare(y.id)));
  assert.deepEqual(k.calls.push.sort((x, y) => x.id.localeCompare(y.id)), [
    { nodeId: NODE, id: A, tokens: { hook: `hook:${A}`, mcp: `mcp:${A}` } },
    { nodeId: NODE, id: C, tokens: { hook: `hook:${C}`, mcp: `mcp:${C}` } },
  ].sort((x, y) => x.id.localeCompare(y.id)));
  assert.deepEqual(k.calls.revoke, []);
});

test("D12-2 mint 가 둘 다 null 이면 건너뛰고(skipped+1) 기억한다 — push 없음, 다음 판엔 후보가 아니다", async () => {
  const k = fakeDeps();
  k.mintMode.set(A, "null");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1, skipped: 1 });
  assert.deepEqual(mintedIds(k).sort(), [A, B].sort(), "mint 는 둘 다 불려야 한다");
  assert.deepEqual(pushedIds(k), [B], "null·null 을 push 했다");
  k.reset();
  k.mintMode.delete(A);   // 이제 민터가 주더라도 — 기억이 있으니 다시 묻지 않는다
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assert.equal(k.calls.haveTokens, 0);
  assert.deepEqual(k.calls.mint, []);
});

test("D12-3 hook 만·mcp 만 있어도 push 한다 — 토큰 객체 그대로(없는 쪽 null), minted+1, 기억한다", async () => {
  const k = fakeDeps();
  k.mintMode.set(A, "hookOnly");
  k.mintMode.set(B, "mcpOnly");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 });
  assert.deepEqual(k.calls.push.sort((x, y) => x.id.localeCompare(y.id)), [
    { nodeId: NODE, id: A, tokens: { hook: `hook:${A}`, mcp: null } },
    { nodeId: NODE, id: B, tokens: { hook: null, mcp: `mcp:${B}` } },
  ].sort((x, y) => x.id.localeCompare(y.id)));
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assert.equal(k.calls.haveTokens, 0);
  // 둘 다 «이 노드에 심은 세션» 이다 — 사라지면 회수
  assert.deepEqual(await bf.run(NODE, []), { ...ZERO, revoked: 2 });
  assert.deepEqual(k.calls.revoke.sort(), [A, B].sort());
});

// ═══ 13. push·mint 실패 → revoke · 백오프 ═══════════════════════════════════
test("D13-1 push 가 던지면 revoke(id) 를 부르고 failed+1 — retryAfterMs 안엔 후보가 아니고, 지나면 다시 후보다", async () => {
  const k = fakeDeps({ retryAfterMs: 1_000 });
  k.pushMode.set(A, "reject");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, failed: 1 });
  assert.deepEqual(mintedIds(k), [A]);
  assert.deepEqual(pushedIds(k), [A]);
  assert.deepEqual(k.calls.revoke, [A], "push 실패 뒤 revoke(id) 를 정확히 한 번");
  // 백오프 안 — 후보가 아니다: haveTokens 도 mint 도 없다
  k.reset();
  k.pushMode.delete(A);
  k.clock += 999;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assert.equal(k.calls.haveTokens, 0, "백오프 안인데 haveTokens 를 불렀다");
  assert.deepEqual(k.calls.mint, [], "백오프 안인데 다시 구웠다");
  assert.deepEqual(k.calls.push, []);
  assert.deepEqual(k.calls.revoke, []);
  // 백오프가 지나면 — 다시 후보, 이번엔 성공
  k.reset();
  k.clock += 2;   // 총 +1001
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assert.deepEqual(mintedIds(k), [A]);
  assert.deepEqual(pushedIds(k), [A]);
  assert.deepEqual(k.calls.revoke, []);
  // 성공 뒤엔 처리됨 — 다시 안 굽는다
  k.reset();
  k.clock += 10_000;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assert.equal(k.calls.haveTokens, 0);
});

test("D13-1b push 가 동기적으로 던져도(프로미스 밖) 같다 — revoke · failed+1 · 백오프", async () => {
  const k = fakeDeps({ retryAfterMs: 1_000 });
  k.pushMode.set(A, "throwSync");
  const bf = createNodeSessionTokenBackfill(k.deps);
  let out: Awaited<ReturnType<typeof bf.run>> | undefined;
  await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(A)]); });
  assert.deepEqual(out, { ...ZERO, failed: 1 });
  assert.deepEqual(k.calls.revoke, [A]);
  k.reset();
  k.clock += 500;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assert.deepEqual(k.calls.mint, []);
});

test("D13-2 push 실패 뒤 revoke 도 실패하면 — 삼킨다: run 은 거부되지 않고 failed+1, 백오프는 그대로", async () => {
  for (const revokeMode of ["reject", "throwSync"] as const) {
    const k = fakeDeps({ retryAfterMs: 1_000 });
    k.pushMode.set(A, "reject");
    k.revokeMode = revokeMode;
    const bf = createNodeSessionTokenBackfill(k.deps);
    let out: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(A), sess(B)]); }, revokeMode);
    assert.equal(out!.failed, 1, `${revokeMode}: failed`);
    assert.equal(out!.minted, 1, `${revokeMode}: B 는 멀쩡히 심겼어야 한다`);
    assert.deepEqual(k.calls.revoke, [A], revokeMode);
    k.reset();
    k.clock += 500;
    assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO, `${revokeMode}: 백오프 안`);
    assert.deepEqual(k.calls.mint, [], revokeMode);
  }
});

test("D13-3 mint 가 던져도 failed+1 · 같은 백오프 — push 는 불리지 않는다, 지나면 다시 후보", async () => {
  for (const mintMode of ["reject", "throwSync"] as const) {
    const k = fakeDeps({ retryAfterMs: 1_000 });
    k.mintMode.set(A, mintMode);
    const bf = createNodeSessionTokenBackfill(k.deps);
    let out: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(A), sess(B)]); }, mintMode);
    assert.deepEqual(out, { ...ZERO, minted: 1, failed: 1 }, mintMode);
    assert.deepEqual(mintedIds(k).sort(), [A, B].sort(), mintMode);
    assert.deepEqual(pushedIds(k), [B], `${mintMode}: 민터가 던진 A 를 push 했다`);
    // 백오프 안
    k.reset();
    k.mintMode.delete(A);
    k.clock += 999;
    assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO, `${mintMode}: 백오프 안`);
    assert.equal(k.calls.haveTokens, 0, mintMode);
    assert.deepEqual(k.calls.mint, [], mintMode);
    // 지나면 다시 후보
    k.reset();
    k.clock += 2;
    assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1 }, `${mintMode}: 백오프 뒤`);
    assert.deepEqual(mintedIds(k), [A], mintMode);
    assert.deepEqual(pushedIds(k), [A], mintMode);
  }
});

test("D13-4 retryAfterMs 를 안 주면 기본은 BACKFILL_RETRY_AFTER_MS(10분)", async () => {
  const k = fakeDeps();
  k.pushMode.set(A, "reject");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, failed: 1 });
  k.reset();
  k.pushMode.delete(A);
  k.clock += BACKFILL_RETRY_AFTER_MS - 1;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO, "10분 안");
  assert.deepEqual(k.calls.mint, [], "10분 안인데 다시 구웠다");
  k.reset();
  k.clock += 2;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 }, "10분 뒤");
  assert.deepEqual(mintedIds(k), [A]);
});

test("D13-5 백오프 중인 세션이 유일한 세션이면 후보가 없다 — haveTokens 를 부르지 않는다 · 다른 후보가 있으면 그것만 처리", async () => {
  const k = fakeDeps({ retryAfterMs: 1_000 });
  k.pushMode.set(A, "reject");
  const bf = createNodeSessionTokenBackfill(k.deps);
  await bf.run(NODE, [sess(A)]);
  k.reset();
  k.clock += 10;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assert.equal(k.calls.haveTokens, 0);
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assert.deepEqual(mintedIds(k), [B], "백오프 중인 A 를 다시 구웠다");
});

// ═══ 14. haveTokens 실패 ════════════════════════════════════════════════════
test("D14-1 haveTokens 가 던지면 그 판은 아무것도 심지 않는다 — mint·push 0 · 다음 판에 다시 haveTokens 를 부르고 심는다", async () => {
  for (const haveMode of ["reject", "throwSync"] as const) {
    const k = fakeDeps();
    k.haveMode = haveMode;
    const bf = createNodeSessionTokenBackfill(k.deps);
    let out: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(A), sess(B)]); }, haveMode);
    assert.equal(out!.minted, 0, `${haveMode}: minted`);
    assert.equal(k.calls.haveTokens, 1, haveMode);
    assert.deepEqual(k.calls.mint, [], `${haveMode}: haveTokens 가 던졌는데 구웠다`);
    assert.deepEqual(k.calls.push, [], `${haveMode}: haveTokens 가 던졌는데 심었다`);
    // 다음 판 — 다시 묻고 심는다(기억·백오프 없이)
    k.reset();
    k.haveMode = "ok";
    assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 }, `${haveMode}: 다음 판`);
    assert.equal(k.calls.haveTokens, 1, haveMode);
    assert.deepEqual(mintedIds(k).sort(), [A, B].sort(), haveMode);
  }
});

// ═══ 15. run 은 절대 던지지 않는다 ══════════════════════════════════════════
test("D15-1 사라진 세션의 revoke 가 던져도 run 은 거부되지 않는다 — 나머지 세션은 그대로 심긴다", async () => {
  for (const revokeMode of ["reject", "throwSync"] as const) {
    const k = fakeDeps();
    const bf = createNodeSessionTokenBackfill(k.deps);
    await bf.run(NODE, [sess(A)]);
    k.reset();
    k.revokeMode = revokeMode;
    let out: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(B)]); }, revokeMode);
    assert.deepEqual(k.calls.revoke, [A], revokeMode);
    assert.equal(out!.minted, 1, `${revokeMode}: B 가 심기지 않았다`);
    assert.deepEqual(pushedIds(k), [B], revokeMode);
  }
});

test("D15-2 deps 가 죄다 던져도 run 은 거부되지 않는다 — 동기·비동기 가리지 않고", async () => {
  for (const mode of ["reject", "throwSync"] as const) {
    const k = fakeDeps({ retryAfterMs: 0 });
    k.haveMode = mode; k.revokeMode = mode;
    k.mintMode.set(A, mode); k.pushMode.set(B, mode);
    const bf = createNodeSessionTokenBackfill(k.deps);
    for (let i = 0; i < 3; i++) {
      await assert.doesNotReject(() => bf.run(NODE, [sess(A), sess(B)]), `${mode} #${i}`);
    }
    // haveTokens 만 살려도 — mint(A)·push(B) 가 던지는 판
    k.haveMode = "ok";
    let out: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(A), sess(B)]); }, mode);
    assert.equal(out!.failed, 2, `${mode}: failed ${JSON.stringify(out)}`);
    assert.equal(out!.minted, 0, mode);
    // 결과는 늘 네 칸의 숫자
    assert.deepEqual(Object.keys(out!).sort(), ["failed", "minted", "revoked", "skipped"]);
    for (const v of Object.values(out!)) assert.equal(typeof v, "number");
  }
});
