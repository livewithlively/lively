// #4135 — **이미 떠 있는 노드 세션에 자격 심기(`node-session-token-backfill.ts`)** 의 사양 시험 — 사양 D(되채우기 6–16)만 보고 쓴 블라인드 시험.
//
// ── 무엇이 고장나 있었나 ─────────────────────────────────────────────────────
// C(사전 발급)는 새로 뜨는 세션에만 닿는다. 이미 떠 있는 노드 세션은 토큰 없이 돌고 있고 살아 있는 프로세스의 env 는
//  못 바꾼다. 그래서 게이트웨이가 살아 있는 노드 세션을 볼 때마다 «아직 토큰 없는 것» 을 골라 그 주인 앞으로 구워
//  노드에 심는다(세션 토큰 파일). 이 시험은 그 «고르고·굽고·심고·되돌리는» 판정을 가짜 deps 로 본다.
//  ★ 보안(사양 개정): 주인은 **노드가 보고한 `SessionInfo.owner` 를 쓰지 않는다** — 노드는 남의 세션 id 에 제 이름을 붙여 보고할 수
//   있다. 게이트웨이 자신의 기록(`deps.verifiedOwners`)이 돌려준 주인만 민팅 인자가 된다.
//
// ── 여기서 지키는 것(createNodeSessionTokenBackfill(deps).run(nodeId, sessions)) ──
//   6. 셀프 노드(`deps.isSelf`)면 아무것도 하지 않는다(민팅·푸시·회수 0).
//   7. 세션 id 형식(`^box-[a-z0-9-]+-[a-f0-9]{8}$`)이 아닌 항목은 무시한다.
//   8. 이 기계가 **이 노드에** 심은 세션이 이번 스냅샷에 없으면 `deps.revoke(그 id)` 를 부르고(revoked+1), 다시 나타나면 다시 심는다.
//      여기서 심지 않은 세션(preissue 로 뜬 것)은 사라져도 회수하지 않는다.
//   9. `deps.supports(nodeId)` 가 false 면 여기서 멈춘다(민팅·푸시 0). 기억하지 않는다 — 다음 판에 true 면 그때 심는다.
//  10. 후보 = 아직 처리(성공·건너뜀)하지 않았고 백오프 중이 아닌 세션. 후보가 없으면 `haveTokens`·`verifiedOwners` 를 **부르지 않는다**.
//      후보가 있으면 `deps.haveTokens()` 를 판마다 **한 번만**, 이어서 `deps.verifiedOwners(nodeId, 후보 id 들)` 를 **한 번만** 부른다.
//  11. `haveTokens` 에 든 id 는 건너뛰고(skipped+1) 기억한다. ★ 주인은 `verifiedOwners` 가 돌려준 값만 쓴다 — 거기 없는 id 는
//      건너뛰고(skipped+1) 기억한다. `SessionInfo.owner` 가 무엇이든 민팅 인자에 영향이 없다.
//  12. 나머지는 `deps.mint(확인된 주인, id)` → 둘 다 null 이면 건너뛰고 기억한다. 하나라도 있으면 `deps.push(nodeId, id, tokens)`;
//      성공하면 minted+1, 기억한다, «이 노드에 심은 세션» 으로 적는다.
//  13. `push` 가 던지면 `deps.revoke(id)` 를 부르고(revoke 실패는 삼킨다) failed+1, `retryAfterMs`(기본 BACKFILL_RETRY_AFTER_MS) 동안은
//      후보가 아니다. 지나면 다시 후보다. `mint` 가 던져도 failed+1 · 같은 백오프.
//  14. `haveTokens` 또는 `verifiedOwners` 가 던지면 그 판은 아무것도 심지 않고 끝나며, 그 노드는 `haveRetryMs`(기본 BACKFILL_HAVE_RETRY_MS
//      = 60초) 동안 `haveTokens` 를 다시 부르지 않는다(후보가 있어도). 지나면 다시 부른다.
//  15. `run` 은 절대 던지지 않는다.
//  16. 직전 스냅샷엔 있었는데 이번에 없는 세션은 **기억(처리·백오프)을 지운다** — 같은 id 가 다시 나타나면 다시 판정한다(haveTokens·
//      verifiedOwners 를 다시 묻는다). 여기서 심은 세션이면 8 대로 회수도 한다.
//  17. 같은 노드의 앞 `run` 이 아직 끝나지 않았는데 다시 부르면 그 호출은 **아무것도 하지 않고** 전부 0 을 곧바로 돌려준다(haveTokens·mint·push 0).
//      앞 판이 끝나면 다음 호출은 정상. 다른 노드의 run 은 막지 않는다.
//  18. «확인했다» 는 기억은 `recheckMs`(기본 BACKFILL_RECHECK_MS = 10분) 동안만이다 — 지나면 다시 후보가 되어 10·11·12 를 다시 거친다
//      (토큰이 살아 있으면 haveTokens 에 있어 다시 건너뛰고 기억을 새로 찍는다; 토큰이 사라졌고 주인이 확인되면 다시 굽는다).
//  ⚠ 기본 deps 는 DB·노드를 만진다 — 언제나 호출을 전부 기록하는 가짜 deps 를 넘기고, 시간은 `now`·`retryAfterMs`·`haveRetryMs`·`recheckMs` 로 돌린다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKFILL_RETRY_AFTER_MS, BACKFILL_HAVE_RETRY_MS, BACKFILL_RECHECK_MS, createNodeSessionTokenBackfill,
} from "./node-session-token-backfill.js";
import type { BackfillDeps } from "./node-session-token-backfill.js";
import type { SessionInfo } from "./catalog.js";

// ── 재료 ────────────────────────────────────────────────────────────────────
const SESSION_ID_RE = /^box-[a-z0-9-]+-[a-f0-9]{8}$/;      // 사양 D7 의 세션 id 형식
const NODE = "node-lvly-linux-2";
const NODE2 = "node-lvly-mac-1";
const A = "box-wonjoon-jang-0123abcd";
const B = "box-wonjoon-jang-deadbeef";
const C = "box-sangmin-kim-cafebabe";
const OWNER = "wonjoon-jang";           // 게이트웨이 기록상 A·B 의 주인
const OWNER_C = "sangmin-kim";          // 게이트웨이 기록상 C 의 주인
const IMPOSTOR = "impostor-kim";        // 노드가 보고서에 멋대로 붙인 이름 — 민팅 인자에 절대 나오면 안 된다
const BAD_IDS = [
  "", "BOX-wonjoon-jang-0123abcd", "box-wonjoon-jang-0123ABCD", "box-wonjoon-jang-0123abc", "box-wonjoon-jang-0123abcd9",
  "box-", "not-a-session", "box-wonjoon_jang-0123abcd", "box-wonjoon-jang-0123abcd/../y", " box-wonjoon-jang-0123abcd",
];
for (const id of [A, B, C]) assert.match(id, SESSION_ID_RE, `시험 재료 오류: ${id}`);
for (const id of BAD_IDS) assert.doesNotMatch(id, SESSION_ID_RE, `시험 재료 오류(형식에 맞는다): ${id}`);

type Tokens = { hook: string | null; mcp: string | null };
const ZERO = { minted: 0, skipped: 0, revoked: 0, failed: 0 };

/** 가짜 스냅샷 항목 — 노드가 보고한 것. `owner` 는 **노드의 주장**이라 사양상 아무 영향이 없어야 한다. */
const sess = (id: string, owner = OWNER): SessionInfo =>
  ({ id, owner, label: "t", harness: "claude" } as unknown as SessionInfo);

type MintMode = "ok" | "null" | "hookOnly" | "mcpOnly" | "reject" | "throwSync";
type PushMode = "ok" | "reject" | "throwSync";
type ThrowMode = "ok" | "reject" | "throwSync";
interface MintCall { owner: string; id: string }
interface PushCall { nodeId: string; id: string; tokens: Tokens }
interface OwnersCall { nodeId: string; ids: string[] }

/** 민터가 주는 토큰 — id 가 실렸는지 push 인자에서 확인된다 */
const tokensOf = (id: string, mode: MintMode): Tokens => ({
  hook: mode === "mcpOnly" || mode === "null" ? null : `hook:${id}`,
  mcp: mode === "hookOnly" || mode === "null" ? null : `mcp:${id}`,
});

/**
 * 가짜 deps — 호출을 전부 기록하고(순서는 `seq`), 세션별·전역 모드에 따라 값·null·거부·동기 예외를 낸다.
 *  `verifiedOwners` 는 게이트웨이 기록의 가짜: 물어본 id 중 `unverified` 가 아닌 것에 `owners` 의 주인(없으면 A·B 는 OWNER, C 는 OWNER_C)을
 *  붙여 돌려준다. 필드를 시험 중간에 바꿔도(k.self, k.supports, k.have, k.clock, k.mintMode…) 다음 호출부터 반영된다.
 */
function fakeDeps(init: {
  self?: boolean; supports?: boolean; retryAfterMs?: number; haveRetryMs?: number; recheckMs?: number;
  have?: string[]; owners?: Record<string, string>; unverified?: string[];
} = {}) {
  const k = {
    self: init.self ?? false,
    supports: init.supports ?? true,
    have: new Set<string>(init.have ?? []),
    haveMode: "ok" as ThrowMode,
    owners: new Map<string, string>(Object.entries({ [C]: OWNER_C, ...(init.owners ?? {}) })),
    unverified: new Set<string>(init.unverified ?? []),
    ownersMode: "ok" as ThrowMode,
    mintMode: new Map<string, MintMode>(),
    pushMode: new Map<string, PushMode>(),
    revokeMode: "ok" as ThrowMode,
    clock: 1_700_000_000_000,
    seq: [] as string[],
    calls: {
      haveTokens: 0,
      verifiedOwners: [] as OwnersCall[],
      mint: [] as MintCall[],
      push: [] as PushCall[],
      revoke: [] as string[],
    },
    reset() { k.calls = { haveTokens: 0, verifiedOwners: [], mint: [], push: [], revoke: [] }; k.seq = []; },
  };
  const deps: BackfillDeps = {
    isSelf: () => k.self,
    supports: () => k.supports,
    haveTokens: () => {
      k.calls.haveTokens++; k.seq.push("haveTokens");
      if (k.haveMode === "throwSync") throw new Error("haveTokens 동기 예외");
      if (k.haveMode === "reject") return Promise.reject(new Error("haveTokens 실패"));
      return Promise.resolve(new Set(k.have));
    },
    verifiedOwners: (nodeId: string, sessionIds) => {
      const ids = Array.from(sessionIds as Iterable<string>);
      k.calls.verifiedOwners.push({ nodeId, ids }); k.seq.push("verifiedOwners");
      if (k.ownersMode === "throwSync") throw new Error("verifiedOwners 동기 예외");
      if (k.ownersMode === "reject") return Promise.reject(new Error("verifiedOwners 실패"));
      const m = new Map<string, string>();
      for (const id of ids) {
        if (k.unverified.has(id)) continue;
        m.set(id, k.owners.get(id) ?? OWNER);
      }
      return Promise.resolve(m);
    },
    mint: (owner: string, id: string) => {
      k.calls.mint.push({ owner, id }); k.seq.push("mint");
      const mode = k.mintMode.get(id) ?? "ok";
      if (mode === "throwSync") throw new Error(`mint 동기 예외: ${id}`);
      if (mode === "reject") return Promise.reject(new Error(`mint 실패: ${id}`));
      return Promise.resolve(tokensOf(id, mode));
    },
    push: (nodeId: string, id: string, tokens: Tokens) => {
      k.calls.push.push({ nodeId, id, tokens }); k.seq.push("push");
      const mode = k.pushMode.get(id) ?? "ok";
      if (mode === "throwSync") throw new Error(`push 동기 예외: ${id}`);
      if (mode === "reject") return Promise.reject(new Error(`push 실패: ${id}`));
      return Promise.resolve({ ok: true });
    },
    revoke: (id: string) => {
      k.calls.revoke.push(id); k.seq.push("revoke");
      if (k.revokeMode === "throwSync") throw new Error(`revoke 동기 예외: ${id}`);
      if (k.revokeMode === "reject") return Promise.reject(new Error(`revoke 실패: ${id}`));
      return Promise.resolve({ revoked: id });
    },
    now: () => k.clock,
    ...(init.retryAfterMs === undefined ? {} : { retryAfterMs: init.retryAfterMs }),
    ...(init.haveRetryMs === undefined ? {} : { haveRetryMs: init.haveRetryMs }),
    ...(init.recheckMs === undefined ? {} : { recheckMs: init.recheckMs }),
  };
  return Object.assign(k, { deps });
}
type Fake = ReturnType<typeof fakeDeps>;

const mintedIds = (k: Fake) => k.calls.mint.map((c) => c.id);
const pushedIds = (k: Fake) => k.calls.push.map((c) => c.id);
const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((x, y) => x.id.localeCompare(y.id));
/** «verifiedOwners 를 정확히 한 번, 이 노드로, 정확히 이 id 들로» */
function assertOwnersAsked(k: Fake, ids: string[], label = "") {
  assert.equal(k.calls.verifiedOwners.length, 1, `${label} verifiedOwners 호출 횟수: ${k.calls.verifiedOwners.length}`);
  const c = k.calls.verifiedOwners[0]!;
  assert.equal(c.nodeId, NODE, `${label} verifiedOwners 의 nodeId`);
  assert.deepEqual([...c.ids].sort(), [...ids].sort(), `${label} verifiedOwners 에 물은 id 들`);
}
/** 아무것도 묻지 않았다 — haveTokens 도 verifiedOwners 도 */
function assertNothingAsked(k: Fake, label = "") {
  assert.equal(k.calls.haveTokens, 0, `${label} haveTokens 를 불렀다`);
  assert.deepEqual(k.calls.verifiedOwners, [], `${label} verifiedOwners 를 불렀다`);
}

// ═══ 0. 상수 ═══════════════════════════════════════════════════════════════
test("D0 BACKFILL_RETRY_AFTER_MS 는 10분 · BACKFILL_HAVE_RETRY_MS 는 60초 · BACKFILL_RECHECK_MS 는 10분", () => {
  assert.equal(BACKFILL_RETRY_AFTER_MS, 10 * 60 * 1000);
  assert.equal(BACKFILL_HAVE_RETRY_MS, 60 * 1000);
  assert.equal(BACKFILL_RECHECK_MS, 10 * 60 * 1000);
});

// ═══ 6. 셀프 노드 ═══════════════════════════════════════════════════════════
test("D6-1 셀프 노드면 아무것도 하지 않는다 — haveTokens·verifiedOwners·mint·push·revoke 0, 결과 전부 0, 두 번 불러도 같다", async () => {
  const k = fakeDeps({ self: true });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO, "두 번째 판(B 가 사라졌지만 심은 적이 없다)");
  assertNothingAsked(k);
  assert.deepEqual(k.calls.mint, [], "mint");
  assert.deepEqual(k.calls.push, [], "push");
  assert.deepEqual(k.calls.revoke, [], "revoke");
});

// ═══ 7. 형식 위반 id ═══════════════════════════════════════════════════════
test("D7-1 세션 id 형식이 아닌 항목은 무시한다 — 형식에 맞는 것만 심고, 형식 위반은 verifiedOwners·mint·push 어디에도 안 나온다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  const out = await bf.run(NODE, [...BAD_IDS.map((id) => sess(id)), sess(A), sess(C, OWNER_C)]);
  assert.deepEqual(out, { ...ZERO, minted: 2 });
  assertOwnersAsked(k, [A, C]);
  assert.deepEqual(mintedIds(k).sort(), [A, C].sort());
  assert.deepEqual(pushedIds(k).sort(), [A, C].sort());
  for (const c of [...k.calls.mint, ...k.calls.push]) assert.match(c.id, SESSION_ID_RE, `형식 위반 id 가 새어 나왔다: ${c.id}`);
});

test("D7-2 형식 위반 항목뿐이면 후보가 없다 — haveTokens·verifiedOwners 도 부르지 않고 결과 전부 0", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, BAD_IDS.map((id) => sess(id))), ZERO);
  assertNothingAsked(k, "형식 위반뿐인데");
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
  assertNothingAsked(k, "후보가 없는데");
  // 계속 없는 상태 — 두 번 회수하지 않는다
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assert.deepEqual(k.calls.revoke, [], "이미 회수한 B 를 또 회수했다");
  assertNothingAsked(k);
});

test("D8-2 회수된 세션이 다시 나타나면 다시 심는다 — haveTokens·verifiedOwners([B])·mint·push 가 다시 불리고 minted+1", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  await bf.run(NODE, [sess(A), sess(B)]);
  await bf.run(NODE, [sess(A)]);                       // B 사라짐 → 회수
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1, "후보(B)가 있으니 haveTokens 한 번");
  assertOwnersAsked(k, [B], "A 는 처리된 채라 B 만");
  assert.deepEqual(k.calls.mint, [{ owner: OWNER, id: B }]);
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

test("D8-3b mint 가 둘 다 null 이거나 verifiedOwners 에 없어 건너뛴 세션도 «심은 세션» 이 아니다 — 사라져도 회수하지 않는다", async () => {
  const k = fakeDeps({ unverified: [B] });
  k.mintMode.set(A, "null");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, skipped: 2 });
  k.reset();
  assert.deepEqual(await bf.run(NODE, []), ZERO);
  assert.deepEqual(k.calls.revoke, []);
});

test("D8-4 «이 노드에» 심은 것만 본다 — 다른 노드의 판에 안 보인다고 회수하지 않는다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.deepEqual(await bf.run(NODE2, [sess(C, OWNER_C)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.verifiedOwners[1]!.nodeId, NODE2, "두 번째 판의 verifiedOwners 는 NODE2 로");
  k.reset();
  // NODE2 의 스냅샷엔 A 가 없는 게 당연하다 — A 는 NODE 에 심었다
  assert.deepEqual(await bf.run(NODE2, [sess(C, OWNER_C)]), ZERO);
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
test("D9-1 supports 가 false 면 멈춘다 — haveTokens·verifiedOwners·mint·push 0, 결과 0 · 기억하지 않아 다음 판에 true 면 그때 심는다", async () => {
  const k = fakeDeps({ supports: false });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO, "두 번째 판도 같다");
  assertNothingAsked(k, "지원 안 하는데");
  assert.deepEqual(k.calls.mint, []);
  assert.deepEqual(k.calls.push, []);
  assert.deepEqual(k.calls.revoke, []);
  // 이제 지원한다 — 둘 다 심는다(«지원 안 함» 을 처리로 기억하지 않았다)
  k.supports = true;
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A, B]);
  assert.deepEqual(mintedIds(k).sort(), [A, B].sort());
  assert.deepEqual(pushedIds(k).sort(), [A, B].sort());
});

// ═══ 10. 후보 · haveTokens → verifiedOwners 호출 횟수·순서 ═════════════════
test("D10-1 후보가 없으면 haveTokens·verifiedOwners 를 부르지 않는다 — 빈 스냅샷 · 전부 처리된 뒤의 같은 스냅샷", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, []), ZERO);
  assertNothingAsked(k, "빈 스냅샷:");
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, OWNER_C)]), { ...ZERO, minted: 3 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A, B, C]);
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, OWNER_C)]), ZERO);
  assertNothingAsked(k, "전부 처리된 뒤인데");
  assert.deepEqual(k.calls.mint, [], "전부 처리된 뒤인데 다시 구웠다");
  assert.deepEqual(k.calls.push, []);
});

test("D10-2 후보가 여럿이어도 haveTokens 한 번 · verifiedOwners 한 번(정확히 그 후보 id 들) — 새 후보가 생기면 그것만으로 다시 한 번", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  const ids = Array.from({ length: 12 }, (_, i) => `box-wonjoon-jang-${i.toString(16).padStart(8, "0")}`);
  const many = ids.map((id) => sess(id));
  assert.deepEqual(await bf.run(NODE, many), { ...ZERO, minted: 12 });
  assert.equal(k.calls.haveTokens, 1, "후보 12개에 haveTokens 를 여러 번 불렀다");
  assertOwnersAsked(k, ids, "후보 12개:");
  assert.equal(k.calls.mint.length, 12);
  k.reset();
  assert.deepEqual(await bf.run(NODE, [...many, sess(A)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1, "새 후보 하나에 정확히 한 번");
  assertOwnersAsked(k, [A], "새 후보 하나:");
  assert.deepEqual(mintedIds(k), [A]);
});

test("D10-3 순서 — haveTokens → verifiedOwners → mint → push · 민팅된 id 는 전부 verifiedOwners 에 물었던 id 다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, OWNER_C)]), { ...ZERO, minted: 3 });
  const at = (name: string) => k.seq.indexOf(name);
  assert.ok(at("haveTokens") >= 0 && at("verifiedOwners") >= 0 && at("mint") >= 0 && at("push") >= 0, k.seq.join(" → "));
  assert.ok(at("haveTokens") < at("verifiedOwners"), `haveTokens 가 verifiedOwners 보다 뒤다: ${k.seq.join(" → ")}`);
  assert.ok(at("verifiedOwners") < at("mint"), `verifiedOwners 전에 구웠다: ${k.seq.join(" → ")}`);
  assert.ok(at("mint") < at("push"), `굽기 전에 심었다: ${k.seq.join(" → ")}`);
  assert.equal(k.seq.filter((s) => s === "haveTokens").length, 1);
  assert.equal(k.seq.filter((s) => s === "verifiedOwners").length, 1);
  const asked = new Set(k.calls.verifiedOwners[0]!.ids);
  for (const id of mintedIds(k)) assert.ok(asked.has(id), `verifiedOwners 에 묻지 않은 id 를 구웠다: ${id}`);
});

// ═══ 11. haveTokens 에 든 id · 확인된 주인만 ═════════════════════════════════
test("D11-1 haveTokens 에 든 id 는 건너뛰고(skipped+1) 기억한다 — mint 없음, 다음 판엔 후보가 아니다(haveTokens·verifiedOwners 도 안 부른다)", async () => {
  const k = fakeDeps({ have: [A, C] });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, OWNER_C)]), { ...ZERO, minted: 1, skipped: 2 });
  assert.equal(k.calls.haveTokens, 1);
  // verifiedOwners 는 한 번 — 후보 id 들로(haveTokens 에 든 것을 미리 빼고 물어도 좋다). 구운 B 는 반드시 물었어야 한다.
  assert.equal(k.calls.verifiedOwners.length, 1);
  const asked = k.calls.verifiedOwners[0]!.ids;
  assert.ok(asked.includes(B), `B 를 verifiedOwners 에 묻지 않았다: ${asked.join(", ")}`);
  assert.ok(asked.every((id) => [A, B, C].includes(id)), `후보 밖의 id 를 물었다: ${asked.join(", ")}`);
  assert.deepEqual(mintedIds(k), [B], "haveTokens 에 든 id 를 구웠다");
  assert.deepEqual(pushedIds(k), [B]);
  k.reset();
  k.have.clear();   // 이제 haveTokens 가 비어 있어도 — 기억이 있으니 다시 묻지 않는다
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, OWNER_C)]), ZERO);
  assertNothingAsked(k, "건너뛴 세션을 기억하지 않았다:");
  assert.deepEqual(k.calls.mint, []);
});

test("D11-2 ★ 주인은 verifiedOwners 가 돌려준 값만 — SessionInfo.owner 가 비어 있든·남의 이름이든·아예 없든 mint 인자는 확인된 주인", async () => {
  const k = fakeDeps({ owners: { [A]: OWNER, [B]: OWNER, [C]: OWNER_C } });
  const bf = createNodeSessionTokenBackfill(k.deps);
  const noOwnerField = { id: C, label: "t", harness: "claude" } as unknown as SessionInfo;
  assert.deepEqual(await bf.run(NODE, [sess(A, ""), sess(B, IMPOSTOR), noOwnerField]), { ...ZERO, minted: 3 });
  assertOwnersAsked(k, [A, B, C]);
  assert.deepEqual(byId(k.calls.mint), byId([{ owner: OWNER, id: A }, { owner: OWNER, id: B }, { owner: OWNER_C, id: C }]),
    "노드가 보고한 owner 가 민팅 인자에 스몄다");
  for (const c of k.calls.mint) assert.notEqual(c.owner, IMPOSTOR, `노드의 주장(${IMPOSTOR})으로 구웠다: ${c.id}`);
  assert.deepEqual(pushedIds(k).sort(), [A, B, C].sort());
});

test("D11-2b 노드의 owner 가 옳더라도 그 값은 쓰이지 않는다 — 게이트웨이 기록이 다른 이름이면 그 이름으로 굽는다", async () => {
  const k = fakeDeps({ owners: { [A]: "gateway-says-this" } });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A, OWNER)]), { ...ZERO, minted: 1 });
  assert.deepEqual(k.calls.mint, [{ owner: "gateway-says-this", id: A }]);
});

test("D11-3 ★ verifiedOwners 에 없는 id 는 건너뛰고(skipped+1) 기억한다 — SessionInfo.owner 가 그럴듯해도 mint 없음, 다음 판에도 안 묻는다", async () => {
  const k = fakeDeps({ unverified: [A] });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A, OWNER), sess(B)]), { ...ZERO, minted: 1, skipped: 1 });
  assertOwnersAsked(k, [A, B]);
  assert.deepEqual(mintedIds(k), [B], "확인되지 않은 A 를 구웠다(노드의 owner 를 믿었다)");
  assert.deepEqual(pushedIds(k), [B]);
  k.reset();
  k.unverified.delete(A);   // 이제 기록이 생겨도 — 기억이 있으니 다시 묻지 않는다
  assert.deepEqual(await bf.run(NODE, [sess(A, OWNER), sess(B)]), ZERO);
  assertNothingAsked(k, "건너뛴 A 를 기억하지 않았다:");
  assert.deepEqual(k.calls.mint, []);
  // 전부 확인되지 않으면 전부 건너뛴다 — mint·push 0
  const k2 = fakeDeps({ unverified: [A, B] });
  const bf2 = createNodeSessionTokenBackfill(k2.deps);
  assert.deepEqual(await bf2.run(NODE, [sess(A), sess(B)]), { ...ZERO, skipped: 2 });
  assert.deepEqual(k2.calls.mint, []); assert.deepEqual(k2.calls.push, []);
});

test("D11-4 haveTokens 에 든 id 는 verifiedOwners 가 알아도 건너뛴다 · haveTokens 에 있으면서 확인도 안 되는 id 도 skipped 는 1", async () => {
  const k = fakeDeps({ have: [A, B], unverified: [B] });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, skipped: 2 });
  assert.deepEqual(k.calls.mint, []);
  assert.deepEqual(k.calls.push, []);
});

test("D11-5 verifiedOwners 가 묻지 않은 id 까지 돌려줘도 그 id 는 굽지 않는다 — 민팅은 스냅샷의 후보에 한한다", async () => {
  const k = fakeDeps();
  k.deps.verifiedOwners = (nodeId, sessionIds) => {
    const ids = Array.from(sessionIds as Iterable<string>);
    k.calls.verifiedOwners.push({ nodeId, ids });
    return Promise.resolve(new Map([...ids.map((id) => [id, OWNER] as const), [B, OWNER], [C, OWNER_C]]));
  };
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.deepEqual(k.calls.mint, [{ owner: OWNER, id: A }], "스냅샷에 없는 B·C 를 구웠다");
  assert.deepEqual(pushedIds(k), [A]);
});

// ═══ 12. mint → push ═══════════════════════════════════════════════════════
test("D12-1 mint(확인된 주인, id) 의 인자 · push(nodeId, id, tokens) 는 민터가 준 토큰 그대로", async () => {
  const k = fakeDeps({ owners: { [A]: OWNER, [C]: OWNER_C } });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A, IMPOSTOR), sess(C, IMPOSTOR)]), { ...ZERO, minted: 2 });
  assert.deepEqual(byId(k.calls.mint), byId([{ owner: OWNER, id: A }, { owner: OWNER_C, id: C }]));
  assert.deepEqual(byId(k.calls.push), byId([
    { nodeId: NODE, id: A, tokens: { hook: `hook:${A}`, mcp: `mcp:${A}` } },
    { nodeId: NODE, id: C, tokens: { hook: `hook:${C}`, mcp: `mcp:${C}` } },
  ]));
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
  assertNothingAsked(k);
  assert.deepEqual(k.calls.mint, []);
});

test("D12-3 hook 만·mcp 만 있어도 push 한다 — 토큰 객체 그대로(없는 쪽 null), minted+1, 기억한다", async () => {
  const k = fakeDeps();
  k.mintMode.set(A, "hookOnly");
  k.mintMode.set(B, "mcpOnly");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 });
  assert.deepEqual(byId(k.calls.push), byId([
    { nodeId: NODE, id: A, tokens: { hook: `hook:${A}`, mcp: null } },
    { nodeId: NODE, id: B, tokens: { hook: null, mcp: `mcp:${B}` } },
  ]));
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assertNothingAsked(k);
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
  // 백오프 안 — 후보가 아니다: haveTokens 도 verifiedOwners 도 mint 도 없다
  k.reset();
  k.pushMode.delete(A);
  k.clock += 999;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assertNothingAsked(k, "백오프 안인데");
  assert.deepEqual(k.calls.mint, [], "백오프 안인데 다시 구웠다");
  assert.deepEqual(k.calls.push, []);
  assert.deepEqual(k.calls.revoke, []);
  // 백오프가 지나면 — 다시 후보, 이번엔 성공
  k.reset();
  k.clock += 2;   // 총 +1001
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A]);
  assert.deepEqual(mintedIds(k), [A]);
  assert.deepEqual(pushedIds(k), [A]);
  assert.deepEqual(k.calls.revoke, []);
  // 성공 뒤엔 처리됨 — 다시 안 굽는다
  k.reset();
  k.clock += 10_000;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assertNothingAsked(k);
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
    assertNothingAsked(k, `${mintMode}: 백오프 안인데`);
    assert.deepEqual(k.calls.mint, [], mintMode);
    // 지나면 다시 후보
    k.reset();
    k.clock += 2;
    assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1 }, `${mintMode}: 백오프 뒤`);
    assertOwnersAsked(k, [A], `${mintMode}: 백오프 뒤`);
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

test("D13-5 백오프 중인 세션은 후보가 아니다 — 유일하면 haveTokens·verifiedOwners 없음 · 다른 후보가 있으면 verifiedOwners 엔 그것만", async () => {
  const k = fakeDeps({ retryAfterMs: 1_000 });
  k.pushMode.set(A, "reject");
  const bf = createNodeSessionTokenBackfill(k.deps);
  await bf.run(NODE, [sess(A)]);
  k.reset();
  k.clock += 10;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assertNothingAsked(k);
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [B], "백오프 중인 A 를 verifiedOwners 에 물었다:");
  assert.deepEqual(mintedIds(k), [B], "백오프 중인 A 를 다시 구웠다");
});

// ═══ 14. haveTokens · verifiedOwners 실패 → 그 노드의 have 백오프 ═══════════
test("D14-1 haveTokens 가 던지면 그 판은 아무것도 심지 않는다 — haveRetryMs 안엔 후보가 있어도 haveTokens 를 다시 부르지 않고, 지나면 다시 부르고 심는다", async () => {
  for (const haveMode of ["reject", "throwSync"] as const) {
    const k = fakeDeps({ haveRetryMs: 5_000 });
    k.haveMode = haveMode;
    const bf = createNodeSessionTokenBackfill(k.deps);
    let out: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(A), sess(B)]); }, haveMode);
    assert.equal(out!.minted, 0, `${haveMode}: minted`);
    assert.equal(k.calls.haveTokens, 1, haveMode);
    assert.deepEqual(k.calls.verifiedOwners, [], `${haveMode}: haveTokens 가 던졌는데 verifiedOwners 를 물었다`);
    assert.deepEqual(k.calls.mint, [], `${haveMode}: haveTokens 가 던졌는데 구웠다`);
    assert.deepEqual(k.calls.push, [], `${haveMode}: haveTokens 가 던졌는데 심었다`);
    // 백오프 안 — 이제 haveTokens 가 멀쩡해도, 후보가 있어도 부르지 않는다
    k.reset();
    k.haveMode = "ok";
    k.clock += 4_999;
    let out2: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out2 = await bf.run(NODE, [sess(A), sess(B), sess(C, OWNER_C)]); }, haveMode);
    assert.equal(out2!.minted, 0, `${haveMode}: 백오프 안인데 심었다`);
    assertNothingAsked(k, `${haveMode}: have 백오프 안인데`);
    assert.deepEqual(k.calls.mint, [], `${haveMode}: have 백오프 안인데 구웠다`);
    // 지나면 — 다시 묻고 전부 심는다(실패한 판의 후보는 처리된 게 아니다)
    k.reset();
    k.clock += 2;   // 총 +5001
    assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(C, OWNER_C)]), { ...ZERO, minted: 3 }, `${haveMode}: 백오프 뒤`);
    assert.equal(k.calls.haveTokens, 1, haveMode);
    assertOwnersAsked(k, [A, B, C], `${haveMode}: 백오프 뒤`);
    assert.deepEqual(mintedIds(k).sort(), [A, B, C].sort(), haveMode);
  }
});

test("D14-2 verifiedOwners 가 던져도 같다 — 그 판은 mint·push 0, haveRetryMs 안엔 haveTokens 를 다시 부르지 않고, 지나면 다시 부르고 심는다", async () => {
  for (const ownersMode of ["reject", "throwSync"] as const) {
    const k = fakeDeps({ haveRetryMs: 5_000 });
    k.ownersMode = ownersMode;
    const bf = createNodeSessionTokenBackfill(k.deps);
    let out: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(A), sess(B)]); }, ownersMode);
    assert.equal(out!.minted, 0, `${ownersMode}: minted`);
    assert.equal(k.calls.haveTokens, 1, ownersMode);
    assert.equal(k.calls.verifiedOwners.length, 1, ownersMode);
    assert.deepEqual(k.calls.mint, [], `${ownersMode}: verifiedOwners 가 던졌는데 구웠다`);
    assert.deepEqual(k.calls.push, [], `${ownersMode}: verifiedOwners 가 던졌는데 심었다`);
    // 백오프 안
    k.reset();
    k.ownersMode = "ok";
    k.clock += 4_999;
    let out2: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out2 = await bf.run(NODE, [sess(A), sess(B)]); }, ownersMode);
    assert.equal(out2!.minted, 0, `${ownersMode}: 백오프 안인데 심었다`);
    assertNothingAsked(k, `${ownersMode}: have 백오프 안인데`);
    assert.deepEqual(k.calls.mint, [], ownersMode);
    // 지나면
    k.reset();
    k.clock += 2;
    assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 }, `${ownersMode}: 백오프 뒤`);
    assert.equal(k.calls.haveTokens, 1, ownersMode);
    assertOwnersAsked(k, [A, B], `${ownersMode}: 백오프 뒤`);
    assert.deepEqual(mintedIds(k).sort(), [A, B].sort(), ownersMode);
  }
});

test("D14-3 haveRetryMs 를 안 주면 기본은 BACKFILL_HAVE_RETRY_MS(60초)", async () => {
  const k = fakeDeps();
  k.haveMode = "reject";
  const bf = createNodeSessionTokenBackfill(k.deps);
  await bf.run(NODE, [sess(A)]);
  assert.equal(k.calls.haveTokens, 1);
  k.reset();
  k.haveMode = "ok";
  k.clock += BACKFILL_HAVE_RETRY_MS - 1;
  assert.equal((await bf.run(NODE, [sess(A)])).minted, 0, "60초 안인데 심었다");
  assertNothingAsked(k, "60초 안인데");
  k.reset();
  k.clock += 2;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 }, "60초 뒤");
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A]);
});

test("D14-4 have 백오프는 노드별이다 — 한 노드의 haveTokens 실패가 다른 노드의 판을 막지 않는다", async () => {
  const k = fakeDeps({ haveRetryMs: 60_000 });
  k.haveMode = "reject";
  const bf = createNodeSessionTokenBackfill(k.deps);
  await bf.run(NODE, [sess(A)]);
  assert.equal(k.calls.haveTokens, 1);
  k.reset();
  k.haveMode = "ok";
  assert.deepEqual(await bf.run(NODE2, [sess(C, OWNER_C)]), { ...ZERO, minted: 1 }, "다른 노드가 막혔다");
  assert.equal(k.calls.haveTokens, 1);
  assert.equal(k.calls.verifiedOwners[0]!.nodeId, NODE2);
  assert.deepEqual(k.calls.mint, [{ owner: OWNER_C, id: C }]);
  // 실패한 노드는 여전히 백오프
  k.reset();
  assert.equal((await bf.run(NODE, [sess(A)])).minted, 0);
  assertNothingAsked(k, "실패한 노드가 백오프 안인데");
});

test("D14-5 have 백오프 중에도 사라진 세션의 회수(8)는 한다 — 회수는 haveTokens 앞의 일이다", async () => {
  const k = fakeDeps({ haveRetryMs: 60_000 });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  k.reset();
  k.haveMode = "reject";
  await bf.run(NODE, [sess(A), sess(B)]);     // B 가 후보 → haveTokens 실패 → 백오프
  assert.equal(k.calls.haveTokens, 1);
  k.reset();
  k.haveMode = "ok";
  k.clock += 10;
  const out = await bf.run(NODE, [sess(B)]);  // A 가 사라졌다
  assert.equal(out.revoked, 1, `revoked: ${JSON.stringify(out)}`);
  assert.deepEqual(k.calls.revoke, [A]);
  assertNothingAsked(k, "have 백오프 안인데");
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
    k.haveMode = mode; k.ownersMode = mode; k.revokeMode = mode;
    k.mintMode.set(A, mode); k.pushMode.set(B, mode);
    const bf = createNodeSessionTokenBackfill(k.deps);
    for (let i = 0; i < 3; i++) {
      await assert.doesNotReject(() => bf.run(NODE, [sess(A), sess(B)]), `${mode} #${i}`);
      k.clock += BACKFILL_HAVE_RETRY_MS + 1;
    }
    // haveTokens 만 살려도 — verifiedOwners 가 던지는 판
    k.haveMode = "ok";
    await assert.doesNotReject(() => bf.run(NODE, [sess(A), sess(B)]), `${mode}: verifiedOwners 만 던짐`);
    k.clock += BACKFILL_HAVE_RETRY_MS + 1;
    // 둘 다 살려도 — mint(A)·push(B) 가 던지는 판
    k.ownersMode = "ok";
    let out: Awaited<ReturnType<typeof bf.run>> | undefined;
    await assert.doesNotReject(async () => { out = await bf.run(NODE, [sess(A), sess(B)]); }, mode);
    assert.equal(out!.failed, 2, `${mode}: failed ${JSON.stringify(out)}`);
    assert.equal(out!.minted, 0, mode);
    // 결과는 늘 네 칸의 숫자
    assert.deepEqual(Object.keys(out!).sort(), ["failed", "minted", "revoked", "skipped"]);
    for (const v of Object.values(out!)) assert.equal(typeof v, "number");
  }
});

// ═══ 16. 사라진 세션의 기억은 지운다 — 다시 나타나면 다시 판정 ═══════════════
test("D16-1 haveTokens 에 있어 건너뛴 id 가 사라졌다 다시 나타나면 다시 묻는다 — 이번엔 haveTokens 에 없으면 심는다", async () => {
  const k = fakeDeps({ have: [A] });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, skipped: 1 });
  k.reset();
  assert.deepEqual(await bf.run(NODE, []), ZERO, "심지 않은 A 가 사라졌다고 회수하면 안 된다");
  assert.deepEqual(k.calls.revoke, []);
  k.reset();
  k.have.clear();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 }, "다시 나타난 A 를 다시 판정하지 않았다");
  assert.equal(k.calls.haveTokens, 1, "다시 나타난 A 에 haveTokens 를 다시 묻지 않았다");
  assertOwnersAsked(k, [A], "다시 나타난 A:");
  assert.deepEqual(k.calls.mint, [{ owner: OWNER, id: A }]);
  assert.deepEqual(pushedIds(k), [A]);
});

test("D16-2 verifiedOwners 에 없어 건너뛴 id 도 같다 — 사라졌다 다시 나타나면 다시 묻고, 이번에 기록이 있으면 심는다", async () => {
  const k = fakeDeps({ unverified: [A] });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, skipped: 1 });
  k.reset();
  assert.deepEqual(await bf.run(NODE, []), ZERO);
  k.reset();
  k.unverified.delete(A);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A]);
  assert.deepEqual(k.calls.mint, [{ owner: OWNER, id: A }]);
  // 기록이 여전히 없으면 다시 건너뛴다(skipped+1) — 다시 판정했다는 뜻
  const k2 = fakeDeps({ unverified: [A] });
  const bf2 = createNodeSessionTokenBackfill(k2.deps);
  await bf2.run(NODE, [sess(A)]);
  await bf2.run(NODE, []);
  k2.reset();
  assert.deepEqual(await bf2.run(NODE, [sess(A)]), { ...ZERO, skipped: 1 });
  assert.equal(k2.calls.haveTokens, 1);
  assertOwnersAsked(k2, [A]);
});

test("D16-3 백오프 중인 id 가 사라졌다 다시 나타나면 백오프도 지운다 — retryAfterMs 안이어도 곧바로 다시 판정한다", async () => {
  const k = fakeDeps({ retryAfterMs: 1_000_000 });
  k.pushMode.set(A, "reject");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, failed: 1 });
  assert.deepEqual(k.calls.revoke, [A]);
  k.reset();
  k.clock += 10;
  assert.deepEqual(await bf.run(NODE, []), ZERO, "push 에 실패한 A 는 심은 세션이 아니다 — 회수 없음");
  assert.deepEqual(k.calls.revoke, []);
  k.reset();
  k.pushMode.delete(A);
  k.clock += 10;   // 백오프(1,000,000ms) 한참 안이다
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 }, "다시 나타난 A 가 여전히 백오프에 묶여 있다");
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A]);
  assert.deepEqual(mintedIds(k), [A]);
  assert.deepEqual(pushedIds(k), [A]);
  // mint 실패 백오프도 같다
  const k2 = fakeDeps({ retryAfterMs: 1_000_000 });
  k2.mintMode.set(A, "reject");
  const bf2 = createNodeSessionTokenBackfill(k2.deps);
  assert.deepEqual(await bf2.run(NODE, [sess(A)]), { ...ZERO, failed: 1 });
  await bf2.run(NODE, []);
  k2.reset();
  k2.mintMode.delete(A);
  k2.clock += 10;
  assert.deepEqual(await bf2.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.deepEqual(mintedIds(k2), [A]);
});

test("D16-4 여기서 심은 세션이 사라졌다 다시 나타나면 — 8 대로 회수하고, 다시 묻고, 다시 심는다(기억은 사라진 것만 지운다)", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 });
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, revoked: 1 });
  assert.deepEqual(k.calls.revoke, [B]);
  assertNothingAsked(k, "A 는 처리된 채인데");
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [B], "남아 있던 A 의 기억까지 지웠다:");
  assert.deepEqual(mintedIds(k), [B]);
});

test("D16-5 «직전 스냅샷» 은 노드별이다 — 다른 노드의 판에 안 보였다고 이 노드의 기억을 지우지 않는다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.deepEqual(await bf.run(NODE2, [sess(C, OWNER_C)]), { ...ZERO, minted: 1 });
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assertNothingAsked(k, "다른 노드의 판이 이 노드의 기억을 지웠다:");
  assert.deepEqual(k.calls.mint, []);
  assert.deepEqual(k.calls.revoke, []);
});

// ═══ 17. 겹침 방지 — 같은 노드의 앞 run 이 끝나지 않았으면 다음 호출은 아무것도 하지 않는다 ═══
/** 조건이 참이 될 때까지 기다린다 — 가짜 mint·push 가 문을 잠근 사이 앞 판이 거기까지 갔는지 */
async function waitFor(pred: () => boolean, label: string, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    assert.ok(Date.now() - t0 < ms, `기다리다 지쳤다: ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}
/** 열어 줄 때까지 잠긴 문 */
function gate() { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; }

test("D17-1 같은 노드의 앞 run 이 mint 에 매달린 사이 다시 부르면 — 곧바로 전부 0, haveTokens·verifiedOwners·mint·push·revoke 0 · 앞 판이 끝나면 다음 호출은 정상", async () => {
  const k = fakeDeps();
  const g = gate();
  k.deps.mint = async (owner: string, id: string) => {
    k.calls.mint.push({ owner, id }); k.seq.push("mint");
    if (id === B) await g.p;                       // B 를 굽는 동안 앞 판이 매달린다
    return tokensOf(id, "ok");
  };
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(C, OWNER_C)]), { ...ZERO, minted: 2 });
  k.reset();
  const first = bf.run(NODE, [sess(A), sess(C, OWNER_C), sess(B)]);
  await waitFor(() => k.calls.mint.length === 1, "앞 판이 mint(B) 에 닿기");
  assert.equal(k.calls.haveTokens, 1);
  // 겹친 호출 — 스냅샷에서 C 가 빠졌지만(회수 대상) 아무것도 하지 않는다
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO, "겹친 호출이 0 이 아니다");
  assert.equal(k.calls.haveTokens, 1, "겹친 호출이 haveTokens 를 불렀다");
  assert.equal(k.calls.verifiedOwners.length, 1, "겹친 호출이 verifiedOwners 를 불렀다");
  assert.equal(k.calls.mint.length, 1, "겹친 호출이 구웠다");
  assert.deepEqual(k.calls.push, [], "겹친 호출이 심었다(또는 앞 판이 문을 넘었다)");
  assert.deepEqual(k.calls.revoke, [], "겹친 호출이 회수했다");
  // 앞 판을 풀어 준다
  g.open();
  assert.deepEqual(await first, { ...ZERO, minted: 1 });
  assert.deepEqual(pushedIds(k), [B]);
  // 다음 호출은 정상 — 심었던 C 가 없으니 회수(8), 새 후보 X 는 심는다
  k.reset();
  const X = "box-wonjoon-jang-00000abc";
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B), sess(X)]), { ...ZERO, minted: 1, revoked: 1 });
  assert.deepEqual(k.calls.revoke, [C]);
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [X]);
  assert.deepEqual(mintedIds(k), [X]);
  assert.deepEqual(pushedIds(k), [X]);
});

test("D17-2 다른 노드의 run 은 막지 않는다 — 한 노드의 push 가 매달린 사이 다른 노드의 판은 정상으로 끝난다, 같은 노드는 여전히 0", async () => {
  const k = fakeDeps();
  const g = gate();
  k.deps.push = async (nodeId: string, id: string, tokens: Tokens) => {
    k.calls.push.push({ nodeId, id, tokens }); k.seq.push("push");
    if (nodeId === NODE) await g.p;                // NODE 로 심는 동안만 매달린다
    return { ok: true };
  };
  const bf = createNodeSessionTokenBackfill(k.deps);
  const first = bf.run(NODE, [sess(A)]);
  await waitFor(() => k.calls.push.length === 1, "앞 판이 push(A) 에 닿기");
  // 다른 노드 — 막히지 않는다
  assert.deepEqual(await bf.run(NODE2, [sess(C, OWNER_C)]), { ...ZERO, minted: 1 }, "다른 노드가 막혔다");
  assert.equal(k.calls.haveTokens, 2);
  assert.equal(k.calls.verifiedOwners[1]!.nodeId, NODE2);
  assert.deepEqual(k.calls.mint[1], { owner: OWNER_C, id: C });
  assert.deepEqual(k.calls.push[1], { nodeId: NODE2, id: C, tokens: { hook: `hook:${C}`, mcp: `mcp:${C}` } });
  // 같은 노드는 여전히 막힌다
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assert.equal(k.calls.haveTokens, 2, "같은 노드의 겹친 호출이 haveTokens 를 불렀다");
  assert.equal(k.calls.mint.length, 2, "같은 노드의 겹친 호출이 구웠다");
  g.open();
  assert.deepEqual(await first, { ...ZERO, minted: 1 });
  // 풀린 뒤 같은 노드 정상 — B 만 새 후보
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [B]);
  assert.deepEqual(pushedIds(k), [B]);
});

test("D17-3 겹친 호출이 여럿이어도 전부 곧바로 0 · 앞 판이 실패로 끝나도 잠금은 풀린다", async () => {
  const k = fakeDeps({ retryAfterMs: 1 });
  const g = gate();
  let pushes = 0;
  k.deps.push = async (nodeId: string, id: string, tokens: Tokens) => {
    k.calls.push.push({ nodeId, id, tokens }); k.seq.push("push");
    if (++pushes === 1) { await g.p; throw new Error("push 실패(문이 열린 뒤)"); }
    return { ok: true };
  };
  const bf = createNodeSessionTokenBackfill(k.deps);
  const first = bf.run(NODE, [sess(A)]);
  await waitFor(() => k.calls.push.length === 1, "앞 판이 push(A) 에 닿기");
  const outs = await Promise.all([bf.run(NODE, [sess(A)]), bf.run(NODE, [sess(A), sess(B)]), bf.run(NODE, [])]);
  assert.deepEqual(outs, [ZERO, ZERO, ZERO]);
  assert.equal(k.calls.haveTokens, 1); assert.equal(k.calls.mint.length, 1); assert.equal(k.calls.push.length, 1);
  assert.deepEqual(k.calls.revoke, [], "겹친 호출이 회수했다");
  g.open();
  assert.deepEqual(await first, { ...ZERO, failed: 1 });
  assert.deepEqual(k.calls.revoke, [A], "push 실패의 revoke");
  // 잠금이 풀렸다 — 백오프(1ms)가 지난 A 와 새 후보 B 를 정상으로 심는다
  k.reset();
  k.clock += 2;
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 }, "실패로 끝난 앞 판이 잠금을 안 풀었다");
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A, B]);
  assert.deepEqual(pushedIds(k).sort(), [A, B].sort());
});

// ═══ 18. 재판정 — «확인했다» 는 기억은 recheckMs 동안만 ═══════════════════
test("D18-1 haveTokens 에 있어 건너뛴 id 는 recheckMs 가 지나면 다시 후보 — 여전히 있으면 다시 건너뛰고 기억을 새로 찍는다 · 사라졌으면 굽는다", async () => {
  const k = fakeDeps({ have: [A], recheckMs: 5_000 });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, skipped: 1 });
  // 안 — 후보가 아니다
  k.reset(); k.clock += 4_999;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assertNothingAsked(k, "recheckMs 안인데");
  // 지남 — 다시 묻는다; 토큰이 살아 있으니 다시 건너뛴다
  k.reset(); k.clock += 2;   // +5_001
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, skipped: 1 }, "recheckMs 가 지났는데 다시 판정하지 않았다");
  assert.equal(k.calls.haveTokens, 1, "recheckMs 가 지났는데 haveTokens 를 다시 묻지 않았다");
  assert.ok(k.calls.verifiedOwners.length <= 1 && k.calls.verifiedOwners.every((c) => c.nodeId === NODE && c.ids.every((id) => id === A)),
    `verifiedOwners: ${JSON.stringify(k.calls.verifiedOwners)}`);
  assert.deepEqual(k.calls.mint, [], "haveTokens 에 있는 A 를 구웠다");
  // 기억을 새로 찍었다 — 또 recheckMs 안엔 묻지 않는다
  k.reset(); k.clock += 4_999;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assertNothingAsked(k, "새로 찍은 기억의 recheckMs 안인데");
  // 지남 — 이번엔 토큰이 사라졌다 → 주인이 확인되니 굽는다
  k.reset(); k.clock += 2; k.have.clear();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A]);
  assert.deepEqual(k.calls.mint, [{ owner: OWNER, id: A }]);
  assert.deepEqual(pushedIds(k), [A]);
});

test("D18-2 심은 세션도 recheckMs 가 지나면 다시 후보 — 토큰이 살아 있으면(haveTokens 에 있음) 건너뛰고, 사라졌으면 다시 굽는다", async () => {
  const k = fakeDeps({ recheckMs: 5_000 });
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 });
  k.reset(); k.clock += 4_999;
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assertNothingAsked(k, "recheckMs 안인데");
  // 지남 — A 의 토큰은 살아 있고(haveTokens), B 의 토큰은 사라졌다
  k.reset(); k.clock += 2; k.have.add(A);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, skipped: 1, minted: 1 });
  assert.equal(k.calls.haveTokens, 1);
  assert.equal(k.calls.verifiedOwners.length, 1);
  const asked = k.calls.verifiedOwners[0]!.ids;
  assert.ok(asked.includes(B) && asked.every((id) => [A, B].includes(id)), `verifiedOwners 에 물은 id 들: ${asked.join(", ")}`);
  assert.deepEqual(k.calls.mint, [{ owner: OWNER, id: B }], "토큰이 살아 있는 A 를 구웠거나 사라진 B 를 안 구웠다");
  assert.deepEqual(pushedIds(k), [B]);
  assert.deepEqual(k.calls.revoke, []);
  // 다시 심은 B 는 «이 노드에 심은 세션» — 사라지면 회수
  k.reset();
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, revoked: 1 });
  assert.deepEqual(k.calls.revoke, [B]);
});

test("D18-3 recheckMs 를 안 주면 기본은 BACKFILL_RECHECK_MS(10분) — 안엔 묻지 않고, 지나면 다시 묻고 토큰이 없으면 다시 굽는다", async () => {
  const k = fakeDeps();
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  k.reset(); k.clock += BACKFILL_RECHECK_MS - 1;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO, "10분 안");
  assertNothingAsked(k, "10분 안인데");
  k.reset(); k.clock += 2;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 }, "10분 뒤");
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A]);
  assert.deepEqual(pushedIds(k), [A]);
});

test("D18-4 verifiedOwners 에 없어서·mint 가 둘 다 null 이라 건너뛴 기억도 recheckMs 동안만 — 지나면 다시 거쳐 이번에 되면 굽는다", async () => {
  const k = fakeDeps({ unverified: [A], recheckMs: 5_000 });
  k.mintMode.set(B, "null");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, skipped: 2 });
  k.reset(); k.clock += 4_999;
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), ZERO);
  assertNothingAsked(k, "recheckMs 안인데");
  k.reset(); k.clock += 2; k.unverified.delete(A); k.mintMode.delete(B);
  assert.deepEqual(await bf.run(NODE, [sess(A), sess(B)]), { ...ZERO, minted: 2 });
  assert.equal(k.calls.haveTokens, 1);
  assertOwnersAsked(k, [A, B]);
  assert.deepEqual(mintedIds(k).sort(), [A, B].sort());
  assert.deepEqual(pushedIds(k).sort(), [A, B].sort());
});

test("D18-5 백오프(13)는 recheckMs 와 무관하다 — recheckMs 가 지나도 retryAfterMs 안이면 여전히 후보가 아니다", async () => {
  const k = fakeDeps({ retryAfterMs: 100_000, recheckMs: 1_000 });
  k.pushMode.set(A, "reject");
  const bf = createNodeSessionTokenBackfill(k.deps);
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, failed: 1 });
  k.reset(); k.pushMode.delete(A); k.clock += 50_000;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), ZERO);
  assertNothingAsked(k, "retryAfterMs 안인데(recheckMs 는 지났다)");
  k.reset(); k.clock += 50_001;
  assert.deepEqual(await bf.run(NODE, [sess(A)]), { ...ZERO, minted: 1 });
  assertOwnersAsked(k, [A]);
});
