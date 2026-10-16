// #4697 T7 — 옛 회수기의 **기본 조립**을 매니지드 면(세션 컨테이너 배포)에서 그대로 태운다. session-reaper.test.ts 는 판정 seam 을 끼워
//  넣어 결정만 보므로(셀프호스트 면), «기본 seam 이 매니지드에서 정말 그렇게 이어지나» 는 거기서 안 보인다(격리 리뷰 B2·B3).
//  ⚠ 이 파일은 프로세스 env 를 바꾼다 — 그래서 따로 둔다(러너는 시험 파일마다 프로세스를 따로 띄운다). 실행 토폴로지는 확정 전엔
//   호출 시점의 env 를 읽는다(exec-topology). 중계 자리에는 아무 일도 안 하는 /bin/true · /bin/false 를 둔다 — 진짜 tmux·컨테이너 무접촉.
//  틀리면 티가 크다:
//   🔴 매니지드에서 규칙이 맡는 세션을 기본 조립이 못 알아보면 — 옛 시계가 그 세션(예약 깨움 대기·보는 중)을 120분에 죽인다.
//   🔴 매니지드 ⑥ 가 지목 없는 pane 목록으로 가면 — 후보 전부를 «작업 중» 으로 보호해 옛 회수기가 다시 멈춘다(9/11~10/16 실측).
import { strict as assert } from "node:assert";
import test from "node:test";

process.env.LIVELY_SESSION_ENSURE = "/bin/true {slug}";   // 세션 컨테이너 배포(매니지드) — tmuxInSessionContainer(slug) 가 참
process.env.LIVELY_SESSION_EXEC = "/bin/false {slug}";    // 세션 컨테이너 exec 중계 — sessionExecConfigured() 가 참, 부르면 실패

const { reapIdleSessions, liveJobSessions, resetUnknownHold, UNKNOWN_HOLD_TICKS } = await import("./session-reaper.js");
const { withTenant, currentTenant } = await import("../org/tenant-context.js");
const { installTenantSlugResolver } = await import("../terminal/catalog.js");
const { invalidateSessionReclaimPolicyCache } = await import("./session-reclaim-policy.js");
type SessionInfo = import("../terminal/terminal-sessions.js").SessionInfo;
installTenantSlugResolver(() => currentTenant()?.slug ?? null);   // 부팅 배선이 하는 일

const NOW_MS = 1_800_000_000_000;
const SEC = NOW_MS / 1000;
const TENANT = { id: "t-4697", slug: "acme-4697" };
const row = (o: Partial<SessionInfo>): SessionInfo => ({
  id: "box-x", label: "l", harness: "claude", dir: "/w", autoApprove: false, owner: "u", owned: true, created: SEC - 86_400,
  attached: false, invites: [], flags: {}, agentState: "idle", lastActive: SEC - 10 * 3600, ...o,
} as SessionInfo);

test("RM1 기본 조립(매니지드) — 규칙이 맡는 claude 세션은 옛 시계가 안 걷고 · grok·대화 id 없는 세션은 걷는다", async () => {
  invalidateSessionReclaimPolicyCache();
  const report = { phase: "idle" as const, at: SEC - 10 * 3600, bg: 0, wake: 0, cron: 0 };
  const reaped: string[] = [];
  const res = await withTenant(TENANT, () => reapIdleSessions({
    loadPolicy: async () => ({ idle_ttl_minutes: 120, attach_idle_minutes: 240, busy_idle_minutes: 480 }),
    listLive: async () => [row({ id: "box-claude", lastReport: report }), row({ id: "box-grok", harness: "grok" }), row({ id: "box-noconv", lastReport: report })],
    listStates: async () => [
      { id: "box-claude", kind: "human", claude_session_id: "c-1" }, { id: "box-grok", kind: "human", claude_session_id: "g-1" },
      { id: "box-noconv", kind: "human", claude_session_id: null },
    ],
    listManaged: async () => [],
    reap: async (id) => { reaped.push(id); },
    liveJobs: async () => new Set(),          // ⑥ 은 RM2 가 본다
    now: () => NOW_MS,
  }));
  assert.deepEqual(reaped.sort(), ["box-grok", "box-noconv"]);
  assert.equal(res.skipReasons?.stopRule, 1);
});

test("RM2 매니지드 ⑥ — 세션을 지목해 판정한다: 판정 불가는 압박 축(보류 없음)이면 곧바로 «작업 없음» · 유휴 축(보류)이면 한도까지 보호", async () => {
  resetUnknownHold();
  const ids = new Set(["box-x-1", "box-y-2"]);
  //  지목 없는 pane 목록(셀프호스트 갈래)으로 갔다면 그 목록이 실패해 둘 다 «작업 중» 으로 보호됐을 것이다(종전 매니지드의 실명).
  assert.deepEqual([...await withTenant(TENANT, () => liveJobSessions(ids))], [], "압박 축 — 판정 불가는 접는다");
  const seen: string[][] = [];
  for (let i = 0; i < UNKNOWN_HOLD_TICKS; i++) seen.push([...await withTenant(TENANT, () => liveJobSessions(ids, undefined, { holdUnknown: true }))].sort());
  assert.deepEqual(seen, [["box-x-1", "box-y-2"], ["box-x-1", "box-y-2"], []], "유휴 축 — 한도 전까지 보류, 한도째 접는다");
  resetUnknownHold();
});

test("RM2b 보류를 받을 자리(held)를 주면 보류분은 «작업 있음» 에 안 섞고 거기로 간다", async () => {
  resetUnknownHold();
  const held = new Set<string>();
  const r = await withTenant(TENANT, () => liveJobSessions(new Set(["box-x-1"]), undefined, { holdUnknown: true, held }));
  assert.deepEqual([[...r], [...held]], [[], ["box-x-1"]]);
  resetUnknownHold();
});

test("RM3 기본 조립 그대로 — 판정 불가 12개(대량)는 첫 두 틱 0건 · 셋째 틱에 접어 걷는다(퇴화 가드가 보류분을 세지 않는다)", async () => {
  resetUnknownHold();
  const ids = Array.from({ length: 12 }, (_, i) => `box-g-${i}`);
  const tickOnce = async (): Promise<{ reaped: string[]; held: number | undefined }> => {
    invalidateSessionReclaimPolicyCache();
    const reaped: string[] = [];
    const res = await withTenant(TENANT, () => reapIdleSessions({
      loadPolicy: async () => ({ idle_ttl_minutes: 120 }),
      listLive: async () => ids.map((id) => row({ id, harness: "grok" })),            // 규칙 밖(grok) — 옛 시계가 맡는다
      listStates: async () => ids.map((id) => ({ id, kind: "human", claude_session_id: `g-${id}` })),
      listManaged: async () => [],
      reap: async (id) => { reaped.push(id); },
      now: () => NOW_MS,                                                               // ⑥ 은 기본(세션 컨테이너 — 판정 불가)
    }));
    return { reaped, held: res.skipReasons?.jobsUnknown };
  };
  const t1 = await tickOnce(), t2 = await tickOnce(), t3 = await tickOnce();
  assert.deepEqual([t1.reaped.length, t1.held, t2.reaped.length, t2.held], [0, 12, 0, 12]);
  assert.equal(t3.reaped.length, 12, "연달아 한도째 — 접어서 걷는다(영영 남지 않는다)");
  resetUnknownHold();
});

test("RM4 보류의 연속은 워크스페이스마다 따로 센다 — 같은 세션 id 라도 섞이지 않는다", async () => {
  resetUnknownHold();
  const A = { id: "t-a", slug: "aa-4697" }, B = { id: "t-b", slug: "bb-4697" };
  const once = async (t: { id: string; slug: string }): Promise<string[]> => {
    const held = new Set<string>();
    await withTenant(t, () => liveJobSessions(new Set(["box-same"]), undefined, { holdUnknown: true, held }));
    return [...held];
  };
  assert.deepEqual(await once(A), ["box-same"]);   // A 1번째
  assert.deepEqual(await once(A), ["box-same"]);   // A 2번째
  assert.deepEqual(await once(B), ["box-same"]);   // B 1번째 — A 의 연속과 무관
  assert.deepEqual(await once(A), [], "A 3번째 — 접는다");
  assert.deepEqual(await once(B), ["box-same"], "B 2번째 — 아직 보류");
  resetUnknownHold();
});
