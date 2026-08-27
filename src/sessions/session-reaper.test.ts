// idle 세션 회수 결정 로직 테스트 (#1059 F) — 정당 세션 오kill 금지 안전 불변식(#687 교훈)이 핵심.
//  주입 seam(deps)으로 tmux·DB 없이 결정만 검증한다. 엣지 표(스크래치패드 spec.md)의 모든 행 = 시나리오.
import assert from "node:assert/strict";
import { reapIdleSessions } from "./session-reaper.js";
import { invalidateSessionReclaimPolicyCache } from "./session-reclaim-policy.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";

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
  // #1220 압박 회수 — 미지정이면 '압박 필드가 아예 없는 구 정책'(=표 A P13) 이 되어 종전 동작이어야 한다.
  pressurePct?: number; pressureIdle?: number;
  // #2148 attach 전용 TTL — 미지정이면 '그 필드가 아예 없는 구 정책'(=종전 동작: attach 무기한 존중)
  attachIdle?: number;
  usedPct?: number; totalMb?: number; rss?: Record<string, number>; memThrows?: boolean;
}): Promise<{ res: Awaited<ReturnType<typeof reapIdleSessions>>; reaped: string[]; memCalls: number; rssCalls: number }> {
  const { ttl = TTL, live = [], states, managed = [], reapThrows = new Set<string>(),
    pressurePct, pressureIdle, attachIdle, usedPct = 0, totalMb = 1000, rss, memThrows = false } = opts;
  invalidateSessionReclaimPolicyCache(); // 시나리오마다 다른 ttl 을 쓰므로 30초 정책 캐시를 비운다(프로덕션은 tick 마다 갱신)
  const reaped: string[] = [];
  let memCalls = 0, rssCalls = 0;
  const res = await reapIdleSessions({
    loadPolicy: async () => ({
      idle_ttl_minutes: ttl,
      ...(pressurePct === undefined ? {} : { pressure_used_pct: pressurePct }),
      ...(pressureIdle === undefined ? {} : { pressure_idle_minutes: pressureIdle }),
      ...(attachIdle === undefined ? {} : { attach_idle_minutes: attachIdle }),
    }),
    listLive: async () => live,
    listStates: async () => states ?? live.map((s) => ({ id: s.id })), // 기본: 라이브 전부 desired-state 있음
    listManaged: async () => managed.map((id) => ({ session_id: id })),
    reap: async (id: string) => { if (reapThrows.has(id)) throw new Error("boom"); reaped.push(id); },
    now,
    memUsedPct: async () => { memCalls++; if (memThrows) throw new Error("meminfo 못 읽음"); return usedPct; },
    memTotal: () => totalMb,
    sessionRss: async () => { rssCalls++; return new Map(Object.entries(rss ?? {})); },
  });
  return { res, reaped, memCalls, rssCalls };
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

// ── lastAttached(마지막 열람)도 idle 판정에 들어간다 — 2026-07-28 실측 사고 회귀락 ──────────────
// 사고: VPN 이 끊겨 attached=0 이 된 순간, **42분 전까지 보고 있던 세션**이 회수됐다. 그 세션은 대화만 하고 있어
//  busy 로 관측된 적이 오래됐고(lastActive 149시간 전), 셸 세션은 busy 관측이 아예 없어 lastActive 가 영원히 없다
//  (셸 안에서 `lively run` 으로 AI 를 돌리는 실제 사용 패턴). attached 는 '지금 보는 중'만 말하므로, 네트워크가
//  잠깐 끊긴 것과 진짜 방치를 가르는 신호는 lastAttached 뿐이다.
{
  const { reaped } = await run({ live: [sess({ id: "seen-recently", lastActive: CUTOFF - 100, lastAttached: CUTOFF + 500 })] });
  assert.deepEqual(reaped, [], "작업은 낡았지만 방금까지 열람 중이었으면 보존한다(VPN 끊김 회수 사고)");
}
{
  // 셸 세션 패턴: lastActive 가 아예 없고 created 는 아주 낡음 — lastAttached 만이 보호 신호다.
  const { reaped } = await run({ live: [sess({ id: "shell-cli", harness: "shell", lastActive: undefined, created: CUTOFF - 100_000, lastAttached: CUTOFF + 500 })] });
  assert.deepEqual(reaped, [], "셸 세션(작업 기록 없음)도 방금 열람했으면 보존");
}
{
  // 반대 방향 — 세 축 전부 낡으면 회수해야 한다(브레이크가 기능을 죽이지 않는지).
  const { reaped } = await run({ live: [sess({ id: "truly-idle", lastActive: CUTOFF - 100, lastAttached: CUTOFF - 50, created: CUTOFF - 200 })] });
  assert.deepEqual(reaped, ["truly-idle"], "작업·열람·생성 전부 TTL 밖이면 회수한다");
}
{
  // lastAttached 만 있고 낡은 경우(탭을 닫은 지 오래) → 회수 대상.
  const { reaped } = await run({ live: [sess({ id: "closed-long-ago", lastActive: undefined, created: CUTOFF - 999, lastAttached: CUTOFF - 10 })] });
  assert.deepEqual(reaped, ["closed-long-ago"], "오래 전에 닫은 세션은 회수한다");
}

// ── 관측성: 이유별 skip 카운트가 정확해야 로그로 진단이 된다 ──────────────────────────
// 실측(2026-07-28): 고객사 A에서 F 를 켰는데 회수가 0건이었고 로그가 침묵해 원인을 박스에서 추측으로 팠다.
//  이 카운트(특히 noState)가 곧 "백필이 필요하다"는 신호다 — 값이 틀리면 진단이 엉뚱한 곳을 가리킨다.
{
  const live = [
    sess({ id: "reap-me", lastActive: CUTOFF - 100 }),
    sess({ id: "s-managed", lastActive: CUTOFF - 100 }),
    sess({ id: "s-attached", lastActive: CUTOFF - 100, attached: true }),
    sess({ id: "s-busy", lastActive: CUTOFF - 100, agentState: "busy" }),
    sess({ id: "s-nostate", lastActive: CUTOFF - 100 }),
    sess({ id: "s-recent", lastActive: CUTOFF + 500 }),
  ];
  const states = live.filter((s) => s.id !== "s-nostate").map((s) => ({ id: s.id }));
  const { res, reaped } = await run({ live, states, managed: ["s-managed"] });
  assert.deepEqual(reaped, ["reap-me"]);
  assert.deepEqual(res.skipReasons, { managed: 1, noState: 1, attached: 1, working: 1, recent: 1, failed: 0, target: 0 },
    "skip 사유별 카운트가 정확해야 한다(noState 가 크면 백필 필요 신호). target 은 압박 회수 전용이라 평시엔 0");
}

// ── 접속 없이 도는 세션(크론·빌드) 보호 — 2026-07-28 상민님 지적 ──────────────────────────
// agentState 는 attached==0 이면 busy 여도 offline 이다(탭=온라인 규칙). 그 값만 보면 **아무도 안 붙은 채
//  크론이 claude 를 돌리는 세션이 '작업 중'으로 안 잡혀** 회수된다. lastActive 는 5분 폴링 스냅샷에 의존해
//  짧은 작업을 놓치므로 보호가 얇다 → attach 무관 신호(working)를 직접 본다.
{
  const { reaped } = await run({ live: [sess({ id: "cron-running", lastActive: CUTOFF - 100, attached: false, agentState: "offline", working: true })] });
  assert.deepEqual(reaped, [], "접속 없이 도는 세션(working)은 회수하지 않는다 — agentState 가 offline 이어도");
}
{
  // 반대: 안 도는 세션은 종전대로 회수(보호가 기능을 죽이지 않는지).
  const { reaped } = await run({ live: [sess({ id: "not-running", lastActive: CUTOFF - 100, working: false })] });
  assert.deepEqual(reaped, ["not-running"], "working=false 면 종전대로 회수");
}

// ── #1220 메모리 압박 회수 ─────────────────────────────────────────────────────────────────
// 왜 이 축이 필요한가: 이 자리를 종전엔 earlyoom 이 맡았는데 그건 예고도 복원 신호도 없는 SIGTERM 이라
//  사용자 눈엔 세션이 그냥 사라진다. 게이트웨이가 **먼저** 같은 일을 하면 desired-state 가 보존돼 복원 가능하다.
//  사양·엣지 표: 스크래치패드 spec.md 표 A(P1~P13).
const P_TTL = 1440;                                  // 평시 기준(분) — 압박 기준과 확실히 구분되게 크게 잡는다
const P_IDLE = 60;                                   // 압박 시 완화 기준(분)
const TWO_HOURS_AGO = NOW_SEC - 2 * 3600;            // 평시(1440분)로는 '최근' · 압박(60분)으로는 '낡음'
const pSess = (id: string) => sess({ id, lastActive: TWO_HOURS_AGO });

// P1 — 임계 0(끔) + 사용률 99: 압박 미발동. **메모리를 조회조차 하지 않는다**(끔은 완전히 꺼진 것).
{
  const { res, reaped, memCalls } = await run({ ttl: P_TTL, pressurePct: 0, usedPct: 99, live: [pSess("a")] });
  assert.equal(memCalls, 0, "임계 0 이면 메모리 조회 자체를 안 한다");
  assert.equal(res.pressure, undefined, "압박 정보 없음");
  assert.deepEqual(reaped, [], "평시 기준(1440분)엔 2시간 전 세션은 최근 → 보존");
}

// P2 — 경계 바로 아래(임계 90 · 사용률 89): 미발동
{
  const { res, reaped } = await run({ ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 89, live: [pSess("a")] });
  assert.equal(res.pressure, undefined, "89 < 90 이면 압박 아님");
  assert.deepEqual(reaped, [], "평시 기준으로 판정 → 보존");
}

// P3 — 경계 정확히(임계 90 · 사용률 90): 발동(>= 이다)
{
  const { res, reaped } = await run({ ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 90, live: [pSess("a")], rss: { a: 10 } });
  assert.ok(res.pressure, "사용률이 임계와 같으면 압박이다");
  assert.deepEqual(reaped, ["a"], "완화 기준(60분)으로 갈아타 회수");
}

// P4 — 평시가 꺼져 있어도(ttl=0) 압박만으로 발동해야 한다(독립성)
{
  const { res, reaped } = await run({ ttl: 0, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 95, live: [pSess("a")], rss: { a: 10 } });
  assert.equal(res.enabled, true, "평시 회수가 꺼져 있어도 압박 회수는 돈다");
  assert.deepEqual(reaped, ["a"], "'평소엔 안 건드리고 위급할 때만' 이 성립해야 한다");
}

// P5 — 완화 기준보다 최근이면 압박이어도 보존
{
  const recent = sess({ id: "recent", lastActive: NOW_SEC - 10 * 60 });  // 10분 전 = 60분 기준으로 최근
  const { reaped } = await run({ ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 95, live: [recent, pSess("old")], rss: { recent: 500, old: 10 } });
  assert.deepEqual(reaped, ["old"], "압박이어도 방금 쓴 세션은 안 건드린다(점유가 커도)");
}

// P6 — 회수 순서 = 점유(RSS) 큰 것부터. 이게 이 기능의 핵심이다(작은 걸 죽이면 압박이 안 풀린다).
{
  const live = [pSess("a"), pSess("b"), pSess("c")];
  const { res, reaped, rssCalls } = await run({
    ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 99, totalMb: 100_000, // 목표 도달 안 되게 큰 전체
    live, rss: { a: 100, b: 400, c: 200 },
  });
  assert.equal(rssCalls, 1, "압박이면 점유를 잰다(배선 확인)");
  assert.deepEqual(reaped, ["b", "c", "a"], "점유 큰 순서로 걷는다");
  assert.equal(res.pressure?.rssMeasured, true, "실제로 쟀으면 그렇게 보고한다(P8 의 대조군)");
}

// P7 — 목표(임계 밑)에 닿으면 멈추고 남은 후보는 둔다. 전체 1000MB·사용률 95·임계 90 → 50MB 넘게 되찾으면 끝.
{
  const live = [pSess("big"), pSess("mid"), pSess("small")];
  const { res, reaped } = await run({
    ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 95, totalMb: 1000,
    live, rss: { big: 400, mid: 200, small: 100 },
  });
  assert.deepEqual(reaped, ["big"], "400MB 하나로 목표 달성 → 나머지는 살려둔다(필요한 만큼만)");
  assert.equal(res.pressure?.reachedTarget, true, "목표 도달이 결과에 드러나야 한다");
  assert.equal(res.pressure?.freedMb, 400, "되찾은 양 보고");
  assert.equal(res.skipReasons?.target, 2, "몇 개를 남겼는지 보고(진단 가능해야 한다)");
}

// P8 — 점유를 못 재도(빈 값) 회수는 막히지 않는다. 목표에 못 닿아 후보를 소진할 뿐.
{
  const live = [pSess("a"), pSess("b")];
  const { res, reaped } = await run({ ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 95, totalMb: 1000, live, rss: {} });
  assert.deepEqual(reaped.sort(), ["a", "b"], "측정 실패가 방어를 멈추면 안 된다");
  assert.equal(res.pressure?.reachedTarget, false, "되찾은 양을 모르니 목표 도달로 치지 않는다");
  // 사고 중 운영자가 '측정을 못 해 다 걷었다'와 '안전한 후보가 없었다'를 가를 수 있어야 한다(둘 다 reachedTarget=false).
  assert.equal(res.pressure?.rssMeasured, false, "점유를 못 쟀다는 사실이 결과에 남아야 한다");
}

// P9 — 압박에서도 안전 불변식은 절대 완화되지 않는다(#687 오kill 교훈)
{
  const live = [
    pSess("ok"),
    pSess("s-managed"),
    sess({ id: "s-attached", lastActive: TWO_HOURS_AGO, attached: true }),
    sess({ id: "s-working", lastActive: TWO_HOURS_AGO, working: true }),
    pSess("s-nostate"),
  ];
  const states = live.filter((s) => s.id !== "s-nostate").map((s) => ({ id: s.id }));
  const { reaped } = await run({
    ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 99, totalMb: 100_000,
    live, states, managed: ["s-managed"], rss: { ok: 1, "s-managed": 999, "s-attached": 999, "s-working": 999, "s-nostate": 999 },
  });
  assert.deepEqual(reaped, ["ok"], "상시·접속중·작업중·복원불가는 압박이어도 회수 대상이 아니다(점유가 제일 커도)");
}

// P10 — 메모리를 못 재면 압박은 발동하지 않고 평시 기준만 적용된다(모르면 사용자 자산을 안 건드린다)
{
  const old = sess({ id: "old", lastActive: NOW_SEC - P_TTL * 60 - 100 });  // 평시 기준으로도 낡음
  const { res, reaped } = await run({ ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, memThrows: true, live: [old, pSess("two-hours")] });
  assert.equal(res.pressure, undefined, "메모리 조회 실패 → 압박 회수 생략");
  assert.deepEqual(reaped, ["old"], "평시 회수는 그대로 동작(압박만 생략)");
}

// P11 — 전체 메모리가 0(못 잼): 0 나눗셈 없이 동작
{
  const live = [pSess("a"), pSess("b")];
  const { reaped } = await run({ ttl: P_TTL, pressurePct: 90, pressureIdle: P_IDLE, usedPct: 95, totalMb: 0, live, rss: { a: 400, b: 100 } });
  assert.deepEqual(reaped.sort(), ["a", "b"], "전체를 모르면 목표 판정을 못 하니 후보를 소진한다(NaN 으로 오작동 금지)");
}

// P12 — 평시(비압박) 순서는 오래 idle 인 것부터(점유 무관). 점유는 재지도 않는다.
{
  const live = [
    sess({ id: "newer", lastActive: NOW_SEC - P_TTL * 60 - 100 }),
    sess({ id: "older", lastActive: NOW_SEC - P_TTL * 60 - 9000 }),
  ];
  const { reaped, rssCalls } = await run({ ttl: P_TTL, pressurePct: 90, usedPct: 10, live, rss: { newer: 999, older: 1 } });
  assert.equal(rssCalls, 0, "평시엔 점유를 재지 않는다(불필요한 /proc 스캔 금지)");
  assert.deepEqual(reaped, ["older", "newer"], "평시는 오래 idle 인 것부터");
}

// P13 — 정책에 압박 필드가 아예 없는 구 설정: 0 으로 채워져 미발동 = 종전 동작(무회귀)
{
  const { res, reaped, memCalls } = await run({ ttl: P_TTL, live: [pSess("a")] });  // pressurePct 미지정
  assert.equal(memCalls, 0, "구 정책(필드 부재)은 압박 회수 끔으로 해석된다");
  assert.equal(res.pressure, undefined);
  assert.deepEqual(reaped, [], "종전 동작 그대로");
}

// ── 탭 없이 승인 대기 중인 세션 보호(#1221) ────────────────────────────────────────────
// working 을 넣을 때 busy 만 구제하고 waiting 은 남겨 뒀다: agentState 는 attached==0 이면 waiting 도 offline 으로
//  덮으므로, **탭을 닫아 둔 채 승인 다이얼로그가 떠 있는 세션**은 어떤 보호에도 안 걸려 회수 대상이었다.
//  그걸 죽이면 사람이 내리려던 결정이 통째로 사라진다(되돌릴 수 없다) — busy 와 같은 등급의 보호가 맞다.
{
  const { reaped } = await run({ live: [sess({ id: "await-approval", lastActive: CUTOFF - 100, attached: false, agentState: "offline", working: false, awaiting: true })] });
  assert.deepEqual(reaped, [], "탭 없이 승인 대기 중인 세션은 회수하지 않는다 — agentState 가 offline 이어도");
}

// ── #2148 세션 단위 attach TTL ────────────────────────────────────────────────
// attach 는 '지금 보는 중'을 뜻하지만 그 신호가 거짓일 수 있다 — 원격 tmux 에서 재연결 잔재가 쌓이면
//  attached>0 이 영구히 참이 되어 회수가 영영 멈춘다(2026-08-27 실측: 세션당 유령 6~7개).
//  아래 표는 스크래치패드 spec-attach.md 의 6~15행이다.
const ATT = 180;                       // attach TTL(분)
const ATT_CUT = NOW_SEC - ATT * 60;    // 이 시각 이하로 유휴면 attach 여도 회수 대상

// #6 attachTtl 미설정(구 정책) — 아무리 오래 유휴여도 종전대로 무기한 존중
{
  const { reaped, res } = await run({ live: [sess({ id: "ghost", attached: true, lastActive: 1 })] });
  assert.deepEqual(reaped, [], "attach TTL 이 없으면 attached 는 무기한 존중(무회귀)");
  assert.equal(res.skipReasons?.attached, 1);
}

// #7 attach TTL 미달 — 아직 존중
{
  const { reaped, res } = await run({ attachIdle: ATT, live: [sess({ id: "recent", attached: true, lastActive: ATT_CUT + 60 })] });
  assert.deepEqual(reaped, [], "attach TTL 미달이면 보류");
  assert.equal(res.skipReasons?.attached, 1);
}

// #8 attach TTL 초과 + 기본 TTL 도 초과 → 회수
{
  const { reaped } = await run({ attachIdle: ATT, live: [sess({ id: "stale", attached: true, lastActive: ATT_CUT - 60 })] });
  assert.deepEqual(reaped, ["stale"], "attach TTL 을 넘긴 attach 는 존중하지 않는다");
}

// #9 attach TTL 초과여도 **작업 중이면 보류** — attach TTL 은 ②의 예외를 열 뿐, ③은 못 연다
{
  const { reaped, res } = await run({ attachIdle: ATT, live: [sess({ id: "busy", attached: true, working: true, lastActive: ATT_CUT - 60 })] });
  assert.deepEqual(reaped, [], "작업 중은 attach TTL 과 무관하게 보호");
  assert.equal(res.skipReasons?.working, 1);
}

// #10 복원 불가(desired-state 없음)면 보류 — 회수 ⊆ 복원가능 불변식은 못 연다
{
  const { reaped, res } = await run({ attachIdle: ATT, states: [], live: [sess({ id: "nostate", attached: true, lastActive: ATT_CUT - 60 })] });
  assert.deepEqual(reaped, [], "복원 불가 세션은 attach TTL 과 무관하게 보호");
  assert.equal(res.skipReasons?.noState, 1);
}

// #11 managed(상시)면 보류
{
  const { reaped, res } = await run({ attachIdle: ATT, managed: ["mg"], live: [sess({ id: "mg", attached: true, lastActive: ATT_CUT - 60 })] });
  assert.deepEqual(reaped, [], "managed 는 attach TTL 과 무관하게 보호");
  assert.equal(res.skipReasons?.managed, 1);
}

// #12 ★ attach TTL 은 넘겼지만 **기본 TTL 미달** — attach TTL 은 ②를 열 뿐 ⑤를 대신하지 않는다
//  (attachTtl 을 기본 TTL 보다 짧게 잘못 잡았을 때의 역전을 여기서 못박는다)
{
  const shortAttach = 1;   // 1분 — 기본 TTL(60분)보다 짧다
  const { reaped, res } = await run({ attachIdle: shortAttach, live: [sess({ id: "fresh", attached: true, lastActive: NOW_SEC - 5 * 60 })] });
  assert.deepEqual(reaped, [], "기본 TTL 미달이면 attach TTL 을 넘겨도 회수하지 않는다");
  assert.equal(res.skipReasons?.recent, 1);
}

// #13 미접속 세션은 attach TTL 과 무관하게 종전대로 기본 TTL 로 판정
{
  const { reaped } = await run({ attachIdle: ATT, live: [sess({ id: "det", attached: false, lastActive: CUTOFF - 10 })] });
  assert.deepEqual(reaped, ["det"], "미접속은 종전대로 기본 TTL 로 회수");
}

// #14 경계 — 유휴가 정확히 attach TTL 이면 회수(이상이면 통과)
{
  const { reaped } = await run({ attachIdle: ATT, live: [sess({ id: "edge", attached: true, lastActive: ATT_CUT })] });
  assert.deepEqual(reaped, ["edge"], "유휴 == attach TTL 은 회수 대상(경계 포함)");
}

// #15 ★ 활동 신호가 하나도 없으면 보류 — 모르면 안 죽인다
//  (lastActive·lastAttached·created 가 전부 비면 유휴를 계산할 수 없다. 그때 attach 를 깨면
//   '방금 뜬 세션'을 걷을 수 있다.)
{
  const { reaped, res } = await run({ attachIdle: ATT, live: [sess({ id: "unknown", attached: true, created: 0, lastActive: undefined, lastAttached: undefined })] });
  assert.deepEqual(reaped, [], "활동 신호가 없으면 attach 를 깨지 않는다");
  assert.equal(res.skipReasons?.attached, 1);
}

console.log("session-reaper: all passed");
