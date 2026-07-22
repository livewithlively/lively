// idle 세션 회수 결정 로직 테스트 (#1059 F) — 정당 세션 오kill 금지 안전 불변식(#687 교훈)이 핵심.
//  주입 seam(deps)으로 tmux·DB 없이 결정만 검증한다. 엣지 표(스크래치패드 spec.md)의 모든 행 = 시나리오.
import assert from "node:assert/strict";
import { reapIdleSessions } from "./session-reaper.js";
import { invalidateSessionReclaimPolicyCache } from "./org/session-reclaim-policy.js";
import type { SessionInfo } from "./terminal-sessions.js";

const NOW_SEC = 1_000_000;
const now = (): number => NOW_SEC * 1000;
const TTL = 60;                       // 분
const CUTOFF = NOW_SEC - TTL * 60;    // 996400 — idleSince ≤ cutoff 면 회수

function sess(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "box-u-1", label: "l", harness: "claude", dir: "/d", autoApprove: false,
    owner: "u", owned: true, created: NOW_SEC, attached: false, invites: [], flags: {},
    agentState: "offline", lastActive: undefined, ...over,
  };
}

async function run(opts: {
  ttl?: number; live?: SessionInfo[]; states?: Array<{ id: string }>;
  managed?: Array<string | null>; reapThrows?: Set<string>;
}): Promise<{ res: Awaited<ReturnType<typeof reapIdleSessions>>; reaped: string[] }> {
  const { ttl = TTL, live = [], states, managed = [], reapThrows = new Set<string>() } = opts;
  invalidateSessionReclaimPolicyCache(); // 시나리오마다 다른 ttl 을 쓰므로 30초 정책 캐시를 비운다(프로덕션은 tick 마다 갱신)
  const reaped: string[] = [];
  const res = await reapIdleSessions({
    loadPolicy: async () => ({ idle_ttl_minutes: ttl }),
    listLive: async () => live,
    listStates: async () => states ?? live.map((s) => ({ id: s.id })), // 기본: 라이브 전부 desired-state 있음
    listManaged: async () => managed.map((id) => ({ session_id: id })),
    reap: async (id: string) => { if (reapThrows.has(id)) throw new Error("boom"); reaped.push(id); },
    now,
  });
  return { res, reaped };
}

// #1 ttl=0(끔) — 낡고 idle 해도 회수 0
{
  const { res, reaped } = await run({ ttl: 0, live: [sess({ lastActive: 1 })] });
  assert.equal(res.enabled, false, "ttl=0 이면 disabled");
  assert.deepEqual(reaped, [], "회수 끔이면 아무것도 안 죽인다");
}

// #2 happy — 회수됨
{
  const { reaped } = await run({ live: [sess({ id: "box-u-old", lastActive: CUTOFF - 100 })] });
  assert.deepEqual(reaped, ["box-u-old"], "idle·복원가능·비managed·비attached·낡음 → 회수");
}

// #3 managed 제외 (불변식①)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-m", lastActive: CUTOFF - 100 })], managed: ["box-u-m"] });
  assert.deepEqual(reaped, [], "managed 는 keep-alive 소유 → 회수 안 함");
}

// #4 desired-state 없음 → skip (불변식④ 회수 ⊆ 복원가능)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-ns", lastActive: CUTOFF - 100 })], states: [] });
  assert.deepEqual(reaped, [], "복원 불가(레코드 없음) 세션은 회수하지 않는다");
}

// #5 attached → skip (불변식②)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-a", lastActive: CUTOFF - 100, attached: true })] });
  assert.deepEqual(reaped, [], "누가 보는 중이면 회수 안 함");
}

// #6/#7 busy/waiting → skip (불변식③)
{
  const busy = await run({ live: [sess({ id: "box-u-b", lastActive: CUTOFF - 100, agentState: "busy" })] });
  assert.deepEqual(busy.reaped, [], "작업 중(busy) 회수 안 함");
  const waiting = await run({ live: [sess({ id: "box-u-w", lastActive: CUTOFF - 100, agentState: "waiting" })] });
  assert.deepEqual(waiting.reaped, [], "승인/선택 대기(waiting) 회수 안 함");
}

// #8 최근 lastActive → skip (불변식⑤)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-r", lastActive: CUTOFF + 100 })] });
  assert.deepEqual(reaped, [], "TTL 이내(최근 작업)면 보존");
}

// #9 lastActive 없음 + created 최근 → skip (created 폴백)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-cr", lastActive: undefined, created: CUTOFF + 100 })] });
  assert.deepEqual(reaped, [], "작업 이력 없으면 created 로 판정 — 최근 생성이면 보존");
}

// #10 lastActive 없음 + created 낡음 → 회수
{
  const { reaped } = await run({ live: [sess({ id: "box-u-co", lastActive: undefined, created: CUTOFF - 100 })] });
  assert.deepEqual(reaped, ["box-u-co"], "작업 이력 없고 오래 전 생성 → 회수");
}

// #11 lastActive·created 둘 다 0/부재 → skip (미상은 안전하게 보존)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-z", lastActive: undefined, created: 0 })] });
  assert.deepEqual(reaped, [], "idle 기준 미상이면 보존(오kill 금지)");
}

// #12 경계: idleSince == cutoff → 회수(> cutoff 아님)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-eq", lastActive: CUTOFF })] });
  assert.deepEqual(reaped, ["box-u-eq"], "정확히 TTL 경과(==cutoff) → 회수");
}

// #13 경계: idleSince == cutoff+1 → skip(막 TTL 안쪽)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-p1", lastActive: CUTOFF + 1 })] });
  assert.deepEqual(reaped, [], "cutoff+1(막 TTL 안쪽) → 보존");
}

// #14 reap() 하나 throw → 그 세션만 skip, 나머지 계속
{
  const { res, reaped } = await run({
    live: [sess({ id: "box-u-t1", lastActive: CUTOFF - 100 }), sess({ id: "box-u-t2", lastActive: CUTOFF - 100 })],
    reapThrows: new Set(["box-u-t1"]),
  });
  assert.deepEqual(reaped, ["box-u-t2"], "한 세션 회수 실패가 다른 세션 회수를 막지 않는다");
  assert.ok(res.skipped >= 1, "실패는 skipped 로 집계");
}

// #15 혼합 다수 — 회수대상만 회수
{
  const live = [
    sess({ id: "reap-1", lastActive: CUTOFF - 100 }),
    sess({ id: "skip-managed", lastActive: CUTOFF - 100 }),
    sess({ id: "skip-attached", lastActive: CUTOFF - 100, attached: true }),
    sess({ id: "skip-busy", lastActive: CUTOFF - 100, agentState: "busy" }),
    sess({ id: "skip-recent", lastActive: CUTOFF + 500 }),
    sess({ id: "reap-2", lastActive: undefined, created: CUTOFF - 100 }),
    sess({ id: "skip-nostate", lastActive: CUTOFF - 100 }),
  ];
  const states = live.filter((s) => s.id !== "skip-nostate").map((s) => ({ id: s.id }));
  const { reaped } = await run({ live, states, managed: ["skip-managed"] });
  assert.deepEqual(reaped.sort(), ["reap-1", "reap-2"], "회수 대상 2개만 정확히 회수");
}

// 새 변수 엣지: managedIds 에 null/빈 session_id 섞여도 무해(필터링)
{
  const { reaped } = await run({ live: [sess({ id: "box-u-ok", lastActive: CUTOFF - 100 })], managed: [null, "", "other"] });
  assert.deepEqual(reaped, ["box-u-ok"], "null/빈 managed session_id 는 필터링돼 회수를 막지 않는다");
}

console.log("session-reaper: all passed");
