// idle 세션 회수 결정 로직 테스트 (#1059 F) — 정당 세션 오kill 금지 안전 불변식(#687 교훈)이 핵심.
//  주입 seam(deps)으로 tmux·DB 없이 결정만 검증한다. 엣지 표(스크래치패드 spec.md)의 모든 행 = 시나리오.
import assert from "node:assert/strict";
import { reapIdleSessions, reapPressureSessions, resetPressureSweepDebounce } from "./session-reaper.js";
import { invalidateSessionReclaimPolicyCache, type SessionReclaimPolicy } from "./session-reclaim-policy.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import type { TenantContext } from "../org/tenant-context.js";

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

// ── 유휴 축 harness ──
//  ⚠ **압박 관련 주입이 하나도 없다**(#2509). 이 함수는 이제 `/proc` 을 아예 안 읽는다 — 그래서
//   "평시엔 점유를 재지 않는다" 같은 성질이 시험이 아니라 **타입으로** 보장된다(그런 seam 자체가 없다).
async function run(opts: {
  ttl?: number; live?: SessionInfo[]; states?: Array<{ id: string }>;
  managed?: Array<string | null>; reapThrows?: Set<string>;
  // #2148 attach 전용 TTL — 미지정이면 '그 필드가 아예 없는 구 정책'(=종전 동작: attach 무기한 존중)
  attachIdle?: number;
}): Promise<{ res: Awaited<ReturnType<typeof reapIdleSessions>>; reaped: string[] }> {
  const { ttl = TTL, live = [], states, managed = [], reapThrows = new Set<string>(), attachIdle } = opts;
  invalidateSessionReclaimPolicyCache(); // 시나리오마다 다른 ttl 을 쓰므로 30초 정책 캐시를 비운다(프로덕션은 tick 마다 갱신)
  const reaped: string[] = [];
  const res = await reapIdleSessions({
    loadPolicy: async () => ({
      idle_ttl_minutes: ttl,
      ...(attachIdle === undefined ? {} : { attach_idle_minutes: attachIdle }),
    }),
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
  assert.deepEqual(res.skipReasons, { managed: 1, noState: 1, attached: 1, working: 1, recent: 1, failed: 0, target: 0, cap: 0 },
    "skip 사유별 카운트가 정확해야 한다(noState 가 크면 백필 필요 신호). target·cap 은 압박 회수 전용이라 평시엔 0");
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

// ── 평시 회수 순서 — 오래 idle 인 것부터(점유 무관) ────────────────────────────────
//  ⓘ 종전 P12 는 "평시엔 점유를 재지 않는다"를 rssCalls==0 으로 쟀다. 이제 유휴 축엔 **점유 seam 자체가 없어**
//   그 성질이 타입으로 보장된다 — 남은 것은 순서뿐이라 여기서 그것만 못 박는다.
const P_TTL = 1440;                                  // 평시 기준(분)
{
  const live = [
    sess({ id: "newer", lastActive: NOW_SEC - P_TTL * 60 - 100 }),
    sess({ id: "older", lastActive: NOW_SEC - P_TTL * 60 - 9000 }),
  ];
  const { reaped } = await run({ ttl: P_TTL, live });
  assert.deepEqual(reaped, ["older", "newer"], "평시는 오래 idle 인 것부터");
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

console.log("session-reaper(유휴 축): all passed");

// ══ 압박 축(전역) — reapPressureSessions ═══════════════════════════════════════════════
// 왜 이 축이 필요한가: 이 자리를 종전엔 earlyoom 이 맡았는데 그건 예고도 복원 신호도 없는 SIGTERM 이라
//  사용자 눈엔 세션이 그냥 사라진다. 게이트웨이가 **먼저** 같은 일을 하면 desired-state 가 보존돼 복원 가능하다.
// #2509 로 이 축은 **박스 전역**이 됐다 — 신호를 한 번 읽고 워크스페이스를 스스로 돈다. 그래서 표가 둘이다:
//  · P1~P13 — 종전 표 A(한 워크스페이스 안에서의 판정). 갈라도 그대로 성립해야 한다(무회귀).
//  · G1~G8  — 전역이 되면서 **새로 생긴** 질문(참가·순번·상한·여유·디바운스·컨텍스트).

const P_IDLE = 60;                                   // 압박 시 완화 기준(분)
const TWO_HOURS_AGO = NOW_SEC - 2 * 3600;            // 평시(1440분)로는 '최근' · 압박(60분)으로는 '낡음'
const pSess = (id: string): SessionInfo => sess({ id, lastActive: TWO_HOURS_AGO });

interface WsSpec {
  slug: string;
  policy?: Partial<SessionReclaimPolicy>;
  live?: SessionInfo[];
  states?: Array<{ id: string }>;
  managed?: Array<string | null>;
  rss?: Record<string, number>;
}

interface PressureOpts {
  /** 워크스페이스 목록. `null` = 레지스트리 없는 단일 테넌트 배포(종전 경로) — 그때는 `single` 을 쓴다. */
  workspaces?: WsSpec[] | null;
  single?: WsSpec;
  usedPct?: number; totalMb?: number;
  swapTotalMb?: number; swapFreeMb?: number;
  memThrows?: boolean; swapThrows?: boolean; procThrows?: boolean;
  reapThrows?: Set<string>;
}

async function runPressure(opts: PressureOpts): Promise<{
  res: Awaited<ReturnType<typeof reapPressureSessions>>;
  reaped: string[]; liveCalls: string[]; procCalls: number;
}> {
  const { workspaces, single, usedPct = 0, totalMb = 1000, swapTotalMb = 0, swapFreeMb = 0,
    memThrows = false, swapThrows = false, procThrows = false, reapThrows = new Set<string>() } = opts;
  const single0: WsSpec = single ?? { slug: "(single)" };
  const list: WsSpec[] = workspaces === undefined || workspaces === null ? [single0] : workspaces;
  const bySlug = new Map(list.map((w) => [w.slug, w]));
  let current: WsSpec = list[0]!;
  const reaped: string[] = [];
  const liveCalls: string[] = [];
  let procCalls = 0;

  resetPressureSweepDebounce();   // 시나리오마다 새 tick 이다(프로덕션은 60초 잠금이 목적)

  const res = await reapPressureSessions({
    targets: async () => workspaces === null || workspaces === undefined
      ? null
      : list.map((w): TenantContext => ({ id: w.slug, slug: w.slug })),
    // ⚠ 실제 `withTenant` 는 테넌트 컨텍스트를 세워 정책 캐시(tenantTtlCache)가 워크스페이스마다 갈린다.
    //  여기 가짜 seam 은 컨텍스트를 안 세우므로 캐시 키가 전부 null 로 겹친다 — 첫 워크스페이스의 정책이
    //  30초 동안 나머지에 적용된다. 그래서 진입 때마다 비운다(**프로덕션 경로의 성질이 아니라 이 가짜의 성질**).
    within: async (t, fn) => {
      current = bySlug.get(t?.slug ?? single0.slug) ?? single0;
      invalidateSessionReclaimPolicyCache();
      return fn();
    },
    loadPolicy: async () => current.policy ?? {},
    listLive: async () => { liveCalls.push(current.slug); return current.live ?? []; },
    listStates: async () => current.states ?? (current.live ?? []).map((s) => ({ id: s.id })),
    listManaged: async () => (current.managed ?? []).map((id) => ({ session_id: id })),
    reap: async (id: string) => { if (reapThrows.has(id)) throw new Error("boom"); reaped.push(id); },
    now,
    memUsedPct: async () => { if (memThrows) throw new Error("meminfo 못 읽음"); return usedPct; },
    memTotal: () => totalMb,
    swapUsage: async () => { if (swapThrows) throw new Error("swap 못 읽음"); return swapTotalMb > 0 ? { totalMb: swapTotalMb, freeMb: swapFreeMb } : null; },
    procTable: async () => { procCalls++; if (procThrows) throw new Error("/proc 못 읽음"); return new Map(); },
    sessionRss: async () => new Map(Object.entries(current.rss ?? {})),
  });
  return { res, reaped, liveCalls, procCalls };
}

/** 한 워크스페이스짜리 시나리오(종전 표 A) — 압박 정책을 그 한 곳에 준다. */
const one = (policy: Partial<SessionReclaimPolicy>, live: SessionInfo[], over: Partial<WsSpec> = {}): WsSpec =>
  ({ slug: "w1", policy, live, ...over });

// ── 표 A(무회귀) — 갈라도 한 워크스페이스 안의 판정은 그대로여야 한다 ──────────────────

// P1 — 임계 0(끔) + 사용률 99: 불참. **그 워크스페이스의 tmux 를 조회조차 하지 않는다**(끔은 완전히 꺼진 것).
//  ⓘ 종전엔 "메모리를 조회조차 안 한다"였는데, 전역이 되면서 메모리는 어차피 박스에서 한 번 읽는다.
//   같은 뜻의 더 강한 성질이 **세션 목록을 안 읽는다**이다 — 95곳짜리 박스에서 이게 곧 비용이다.
{
  const { res, reaped, liveCalls } = await runPressure({
    workspaces: [one({ pressure_used_pct: 0, pressure_swap_pct: 0 }, [pSess("a")])], usedPct: 99,
  });
  assert.deepEqual(liveCalls, [], "임계 0 이면 그 워크스페이스 세션 목록을 조회하지 않는다");
  assert.equal(res.participating, 0, "불참");
  assert.equal(res.perWorkspace[0]?.why, "정책 꺼짐(임계 0)", "왜 불참인지가 결과에 남아야 한다");
  assert.deepEqual(reaped, [], "꺼져 있으면 아무것도 안 걷는다");
}

// P2 — 경계 바로 아래(임계 90 · 사용률 89): 미발동
{
  const { res, reaped, liveCalls } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, [pSess("a")])], usedPct: 89,
  });
  assert.equal(res.participating, 0, "89 < 90 이면 압박 아님");
  assert.equal(res.perWorkspace[0]?.why, "임계 미달", "'꺼짐'과 '아직 안 넘음'은 다른 상태다");
  assert.deepEqual(liveCalls, [], "발동 안 했으면 세션 목록도 안 읽는다");
  assert.deepEqual(reaped, []);
}

// P3 — 경계 정확히(임계 90 · 사용률 90): 발동(>= 이다)
{
  const { res, reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, [pSess("a")], { rss: { a: 10 } })],
    usedPct: 90,
  });
  assert.equal(res.participating, 1, "사용률이 임계와 같으면 압박이다");
  assert.deepEqual(reaped, ["a"], "완화 기준(60분)으로 갈아타 회수");
}

// P4 — 평시 TTL(idle_ttl_minutes)과 **독립**이다: 평시가 꺼져 있어도 압박만으로 발동해야 한다
{
  const { res, reaped } = await runPressure({
    workspaces: [one({ idle_ttl_minutes: 0, pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, [pSess("a")], { rss: { a: 10 } })],
    usedPct: 95,
  });
  assert.equal(res.ran, true, "평시 회수가 꺼져 있어도 압박 회수는 돈다");
  assert.deepEqual(reaped, ["a"], "'평소엔 안 건드리고 위급할 때만' 이 성립해야 한다");
}

// P5 — 완화 기준보다 최근이면 압박이어도 보존(점유가 커도)
{
  const recent = sess({ id: "recent", lastActive: NOW_SEC - 10 * 60 });  // 10분 전 = 60분 기준으로 최근
  const { reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, [recent, pSess("old")], { rss: { recent: 500, old: 10 } })],
    usedPct: 95,
  });
  assert.deepEqual(reaped, ["old"], "압박이어도 방금 쓴 세션은 안 건드린다(점유가 커도)");
}

// P6 — 회수 순서 = 점유(RSS) 큰 것부터. 이게 이 기능의 핵심이다(작은 걸 죽이면 압박이 안 풀린다).
{
  const live = [pSess("a"), pSess("b"), pSess("c")];
  const { res, reaped, procCalls } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, live, { rss: { a: 100, b: 400, c: 200 } })],
    usedPct: 99, totalMb: 100_000,   // 목표 도달 안 되게 큰 전체
  });
  assert.equal(procCalls, 1, "압박이면 점유를 잰다(배선 확인)");
  assert.deepEqual(reaped, ["b", "c", "a"], "점유 큰 순서로 걷는다");
  assert.equal(res.rssMeasured, true, "실제로 쟀으면 그렇게 보고한다(P8 의 대조군)");
}

// P7 — 목표(임계 밑)에 닿으면 멈추고 남은 후보는 둔다. 전체 1000MB·사용률 95·임계 90 → 50MB 넘게 되찾으면 끝.
{
  const live = [pSess("big"), pSess("mid"), pSess("small")];
  const { res, reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, live, { rss: { big: 400, mid: 200, small: 100 } })],
    usedPct: 95, totalMb: 1000,
  });
  assert.deepEqual(reaped, ["big"], "400MB 하나로 목표 달성 → 나머지는 살려둔다(필요한 만큼만)");
  assert.equal(res.reachedTarget, true, "목표 도달이 결과에 드러나야 한다");
  assert.equal(res.freedMb, 400, "되찾은 양 보고");
  assert.equal(res.skipReasons.target, 2, "몇 개를 남겼는지 보고(진단 가능해야 한다)");
}

// P8 — 점유를 못 재도(빈 값) 회수는 막히지 않는다. 목표에 못 닿아 후보를 소진할 뿐.
{
  const live = [pSess("a"), pSess("b")];
  const { res, reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, live, { rss: {} })],
    usedPct: 95, totalMb: 1000,
  });
  assert.deepEqual(reaped.sort(), ["a", "b"], "측정 실패가 방어를 멈추면 안 된다");
  assert.equal(res.reachedTarget, false, "되찾은 양을 모르니 목표 도달로 치지 않는다");
  // 사고 중 운영자가 '측정을 못 해 다 걷었다'와 '안전한 후보가 없었다'를 가를 수 있어야 한다(둘 다 reachedTarget=false).
  assert.equal(res.rssMeasured, false, "점유를 못 쟀다는 사실이 결과에 남아야 한다");
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
  const { reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, live, {
      states, managed: ["s-managed"],
      rss: { ok: 1, "s-managed": 999, "s-attached": 999, "s-working": 999, "s-nostate": 999 },
    })],
    usedPct: 99, totalMb: 100_000,
  });
  assert.deepEqual(reaped, ["ok"], "상시·접속중·작업중·복원불가는 압박이어도 회수 대상이 아니다(점유가 제일 커도)");
}

// P10 — 메모리를 못 재면 물리 축은 발동하지 않는다(모르면 사용자 자산을 안 건드린다)
{
  const { res, reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, [pSess("a")], { rss: { a: 10 } })],
    memThrows: true,
  });
  assert.equal(res.ran, false, "두 축 다 못 읽으면 판정 근거가 없다 — 돌지 않는다");
  assert.deepEqual(reaped, [], "모르면 아무것도 안 걷는다");
}

// P11 — 전체 메모리가 0(못 잼): 0 나눗셈 없이 동작
{
  const live = [pSess("a"), pSess("b")];
  const { reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, live, { rss: { a: 400, b: 100 } })],
    usedPct: 95, totalMb: 0,
  });
  assert.deepEqual(reaped.sort(), ["a", "b"], "전체를 모르면 목표 판정을 못 하니 후보를 소진한다(NaN 으로 오작동 금지)");
}

// P13 — 정책에 압박 필드가 아예 없는 구 설정: 0 으로 채워져 미발동 = 종전 동작(무회귀)
{
  const { res, reaped, liveCalls } = await runPressure({
    workspaces: [one({ idle_ttl_minutes: P_TTL }, [pSess("a")])], usedPct: 99,   // pressure_* 미지정
  });
  assert.equal(res.participating, 0, "구 정책(필드 부재)은 압박 회수 끔으로 해석된다");
  assert.deepEqual(liveCalls, []);
  assert.deepEqual(reaped, [], "종전 동작 그대로");
}

// P14(#1675 ⑤) — 스왑 축은 물리 축과 **독립**이다. 물리 82% / 스왑 99.9% 가 어니스트 전면장애의 실측값이다.
{
  const { res, reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 0, pressure_swap_pct: 90, pressure_idle_minutes: P_IDLE }, [pSess("a")], { rss: { a: 5 } })],
    usedPct: 82, totalMb: 16_000, swapTotalMb: 8_000, swapFreeMb: 8,
  });
  assert.equal(res.participating, 1, "물리 임계가 꺼져 있어도 스왑만으로 발동한다");
  assert.deepEqual(reaped, ["a"], "스왑이 벼랑이면 걷는다");
}

// P15 — 스왑이 없는 박스(SwapTotal=0)는 이 축이 자동 비활성. 0/0 을 100% 로 읽어 상시 발동하면 재앙이다.
{
  const { res, reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 0, pressure_swap_pct: 90, pressure_idle_minutes: P_IDLE }, [pSess("a")])],
    usedPct: 10, swapTotalMb: 0,
  });
  assert.equal(res.participating, 0, "스왑 없는 박스에서 스왑 축은 성립하지 않는다");
  assert.deepEqual(reaped, []);
}

// ── 표 G — 전역이 되면서 새로 생긴 질문 ────────────────────────────────────────────────

// G1 ★ **참가는 그 워크스페이스의 동의다.** 압박은 박스 전역 신호지만, 임계를 안 켠 워크스페이스의 세션은
//  걷지 않는다 — 기본값 0=끔이 「무회귀·놀람 방지」라고 정책 파일이 반복해 못박은 그 약속이다.
//  (실측 2026-09-01 dev: 비-primary 95곳이 전부 `{}` — 이 배포가 그들에게 무해함이 여기서 증명된다.)
{
  const { res, reaped, liveCalls } = await runPressure({
    workspaces: [
      { slug: "on", policy: { pressure_swap_pct: 90, pressure_idle_minutes: P_IDLE }, live: [pSess("on-1")], rss: { "on-1": 10 } },
      { slug: "off", policy: {}, live: [pSess("off-1"), pSess("off-2")], rss: { "off-1": 9999, "off-2": 9999 } },
    ],
    usedPct: 10, totalMb: 100_000, swapTotalMb: 1000, swapFreeMb: 10,
  });
  assert.deepEqual(reaped, ["on-1"], "동의하지 않은 워크스페이스 세션은 점유가 제일 커도 안 걷는다");
  assert.deepEqual(liveCalls, ["on"], "불참 워크스페이스는 tmux 조회조차 하지 않는다");
  assert.equal(res.workspaces, 2);
  assert.equal(res.participating, 1, "불참 수가 결과에 남아야 한다 — 압박이 안 풀리면 고칠 곳이 그 정책이다");
}

// G2 ★ 순번(pressure_priority) — 낮을수록 먼저. **RSS 를 이긴다**(그게 순번의 존재 이유다).
{
  const pol = (priority: number): Partial<SessionReclaimPolicy> =>
    ({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE, pressure_priority: priority });
  const { reaped } = await runPressure({
    workspaces: [
      { slug: "prod", policy: pol(200), live: [pSess("prod-big")], rss: { "prod-big": 900 } },
      { slug: "dev", policy: pol(50), live: [pSess("dev-small")], rss: { "dev-small": 10 } },
    ],
    usedPct: 99, totalMb: 100_000,
  });
  assert.deepEqual(reaped, ["dev-small", "prod-big"], "순번이 낮은 워크스페이스부터 걷는다(RSS 가 작아도)");
}

// G3 — 순번이 같으면(기본 100) 순수 RSS 내림차순 = #1220 교리 그대로(무회귀).
{
  const pol: Partial<SessionReclaimPolicy> = { pressure_used_pct: 90, pressure_idle_minutes: P_IDLE };
  const { reaped } = await runPressure({
    workspaces: [
      { slug: "a", policy: pol, live: [pSess("a-small")], rss: { "a-small": 10 } },
      { slug: "b", policy: pol, live: [pSess("b-big")], rss: { "b-big": 900 } },
    ],
    usedPct: 99, totalMb: 100_000,
  });
  assert.deepEqual(reaped, ["b-big", "a-small"], "순번이 같으면 워크스페이스를 가로질러 RSS 순");
}

// G4 ★ **정지는 자기 워크스페이스 임계로 판정한다** — 남의 임계를 만족시키려고 동의 범위 밖까지 걷지 않는다.
//  전체 1000MB·사용률 95. loose(임계 94)는 6MB 만 되찾으면 해소 · strict(임계 90)는 50MB 넘게 필요.
//  RSS 순이면 loose 의 큰 세션이 먼저 걷히고, 그 한 건으로 loose 는 이미 해소된다 → loose 의 나머지는 남는다.
{
  const { res, reaped } = await runPressure({
    workspaces: [
      { slug: "loose", policy: { pressure_used_pct: 94, pressure_idle_minutes: P_IDLE, pressure_priority: 100 },
        live: [pSess("loose-big"), pSess("loose-2")], rss: { "loose-big": 30, "loose-2": 25 } },
      { slug: "strict", policy: { pressure_used_pct: 90, pressure_idle_minutes: P_IDLE, pressure_priority: 100 },
        live: [pSess("strict-1")], rss: { "strict-1": 28 } },
    ],
    usedPct: 95, totalMb: 1000,
  });
  assert.deepEqual(reaped, ["loose-big", "strict-1"],
    "loose 는 30MB 로 자기 임계(94)를 넘겨 해소 → 더 안 걷는다. strict 는 임계(90)가 아직이라 계속 걷는다");
  assert.equal(res.skipReasons.target, 1, "loose-2 는 '필요 없어서' 남았다(target)");
  //  ⚠ 목표에 닿은 후보에서 break 하면 뒤의 strict-1 을 못 본다 — 정렬이 임계 순이 아니기 때문이다.
  assert.ok(reaped.includes("strict-1"), "더 엄격한 임계를 가진 뒤쪽 후보를 건너뛰면 안 된다(break 금지)");
}

// G5 ★ 워크스페이스당 tick 상한(pressure_max_reap) — 폭발반경 제한. `target` 과 **다른 칸**으로 센다.
{
  const live = [pSess("s1"), pSess("s2"), pSess("s3")];
  const { res, reaped } = await runPressure({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE, pressure_max_reap: 2 }, live,
      { rss: { s1: 30, s2: 20, s3: 10 } })],
    usedPct: 99, totalMb: 100_000,   // 목표엔 절대 못 닿는다 → 멈추는 이유는 상한뿐
  });
  assert.deepEqual(reaped, ["s1", "s2"], "상한 2 를 넘겨 걷지 않는다");
  assert.equal(res.skipReasons.cap, 1, "상한에 막힌 수는 cap 으로 센다");
  assert.equal(res.skipReasons.target, 0, "'필요 없어서 남김'과 '상한에 막힘'은 정반대 뜻이라 섞이면 안 된다");
}

// G6 ★ 정지 여유(pressure_release_margin_pct) — 임계보다 더 내려갈 때까지 걷는다(재발동 방지).
//  전체 1000MB·사용률 95·임계 90 → 여유 0 이면 50MB 로 끝(P7). 여유 5 면 정지선 85 → 100MB 넘게 필요.
{
  const live = [pSess("big"), pSess("mid"), pSess("small")];
  const ws = (margin: number): WsSpec =>
    one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE, pressure_release_margin_pct: margin }, live,
      { rss: { big: 60, mid: 50, small: 40 } });
  const noMargin = await runPressure({ workspaces: [ws(0)], usedPct: 95, totalMb: 1000 });
  assert.deepEqual(noMargin.reaped, ["big"], "여유 0 = 종전 동작(임계 바로 밑에서 정지)");
  const withMargin = await runPressure({ workspaces: [ws(5)], usedPct: 95, totalMb: 1000 });
  assert.deepEqual(withMargin.reaped, ["big", "mid"], "여유 5 면 정지선이 85 라 한 건 더 걷는다");
}

// G7 ★ **전역 디바운스** — 이 함수는 하우스키핑 타이머와 CP 의 테넌트별 틱 양쪽에서 불린다.
//  잠그지 않으면 #2509 가 고친 곱셈이 이름만 바꿔 되살아난다.
{
  const spec = (): PressureOpts => ({
    workspaces: [one({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, [pSess("a"), pSess("b")], { rss: { a: 1, b: 1 } })],
    usedPct: 99, totalMb: 100_000,
  });
  const first = await runPressure(spec());   // runPressure 가 디바운스를 비우고 시작한다
  assert.equal(first.res.ran, true);
  assert.equal(first.res.throttled, false);
  // 같은 창 안에서 또 부른다(디바운스를 비우지 않고).
  const second = await reapPressureSessions({
    targets: async () => null,
    memUsedPct: async () => 99,
    memTotal: () => 100_000,
    swapUsage: async () => null,
    listLive: async () => { throw new Error("디바운스가 열려 있으면 여기까지 온다"); },
    now,
  });
  assert.equal(second.ran, false, "간격 안의 두 번째 호출은 돌지 않는다");
  assert.equal(second.throttled, true, "왜 안 돌았는지가 결과에 남아야 한다(안 돈 것과 구분)");
}

// G8 — 레지스트리 없는 단일 테넌트 배포(targets=null): 컨텍스트를 만들지 않고 종전 그대로 1회.
{
  const { res, reaped } = await runPressure({
    workspaces: null,
    single: { slug: "(single)", policy: { pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }, live: [pSess("a")], rss: { a: 10 } },
    usedPct: 95, totalMb: 100_000,
  });
  assert.equal(res.workspaces, 1, "순회 대상이 없으면 종전 경로 1회(무회귀가 기본값이다)");
  assert.deepEqual(reaped, ["a"]);
}

// G9 — 한 워크스페이스의 조회 실패가 나머지를 막지 않는다(#2479 순회와 같은 규율).
{
  let calls = 0;
  resetPressureSweepDebounce();
  const reaped: string[] = [];
  const res = await reapPressureSessions({
    targets: async () => [{ id: "bad", slug: "bad" }, { id: "good", slug: "good" }],
    within: async (t, fn) => { invalidateSessionReclaimPolicyCache(); calls++; if (t?.slug === "bad" && calls === 1) throw new Error("boom"); return fn(); },
    loadPolicy: async () => ({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE }),
    listLive: async () => [pSess("good-1")],
    listStates: async () => [{ id: "good-1" }],
    listManaged: async () => [],
    reap: async (id) => { reaped.push(id); },
    now,
    memUsedPct: async () => 95,
    memTotal: () => 100_000,
    swapUsage: async () => null,
    procTable: async () => new Map(),
    sessionRss: async () => new Map([["good-1", 10]]),
  });
  assert.deepEqual(reaped, ["good-1"], "실패한 워크스페이스를 건너뛰고 나머지는 계속한다");
  assert.equal(res.perWorkspace.find((w) => w.slug === "bad")?.why, "조회 실패");
}

console.log("session-reaper(압박 축): all passed");

// G10 ★ 점유 측정 실패는 **워크스페이스마다** 갈린다 — 전역 요약만 보면 못 잰 쪽의 과다 회수를 놓친다.
//
//  ⓘ 처음엔 "못 잰 쪽이 후보를 소진한다"를 두 워크스페이스에 같은 순번으로 두고 재려 했는데 안 잡혔다.
//   `freedMb` 는 **박스 전역**이라 잰 쪽이 되찾은 60MB 가 못 잰 쪽의 목표까지 함께 풀어 버린다 —
//   그게 맞는 동작이다(메모리는 한 박스의 것이다). 과다 회수가 실제로 드러나는 배치는 **못 잰 쪽이 먼저
//   걷히는** 순번이다: 그때는 되찾은 양이 0 으로만 세어져 목표가 영영 안 서고 자기 후보를 다 소진한다.
{
  resetPressureSweepDebounce();
  const reaped: string[] = [];
  const rssBySlug: Record<string, Record<string, number>> = {
    measured: { "m-1": 60, "m-2": 50 },
    unmeasured: {},                                  // hidepid 박스 — 남의 uid /proc 를 못 읽는다
  };
  //  못 잰 쪽을 **먼저** 걷는 순번으로 둔다(50 < 200) — 잰 쪽의 회수가 목표를 풀어 주기 전에 지나간다.
  const prioBySlug: Record<string, number> = { unmeasured: 50, measured: 200 };
  let cur = "unmeasured";
  const res = await reapPressureSessions({
    targets: async () => [{ id: "measured", slug: "measured" }, { id: "unmeasured", slug: "unmeasured" }],
    within: async (t, fn) => { cur = t?.slug ?? cur; invalidateSessionReclaimPolicyCache(); return fn(); },
    loadPolicy: async () => ({ pressure_used_pct: 90, pressure_idle_minutes: P_IDLE, pressure_priority: prioBySlug[cur] }),
    listLive: async () => (cur === "measured" ? [pSess("m-1"), pSess("m-2")] : [pSess("u-1"), pSess("u-2")]),
    listStates: async () => (cur === "measured" ? [{ id: "m-1" }, { id: "m-2" }] : [{ id: "u-1" }, { id: "u-2" }]),
    listManaged: async () => [],
    reap: async (id) => { reaped.push(id); },
    now,
    memUsedPct: async () => 95, memTotal: () => 1000, swapUsage: async () => null,
    procTable: async () => new Map(),
    sessionRss: async () => new Map(Object.entries(rssBySlug[cur] ?? {})),
  });
  assert.equal(res.rssMeasured, true, "전역 요약은 '한 곳이라도 쟀다'라 참이 된다 — 이것만 보면 아래를 놓친다");
  const byWs = new Map(res.perWorkspace.map((w) => [w.slug, w]));
  assert.equal(byWs.get("measured")?.rssMeasured, true);
  assert.equal(byWs.get("unmeasured")?.rssMeasured, false, "못 잰 워크스페이스가 결과에서 드러나야 한다");
  //  u-1·u-2 는 0 으로만 세어져 목표가 안 서고 둘 다 걷힌다. 그 뒤 m-1(60MB)로 목표(freed>50)에 닿아 m-2 는 남는다.
  assert.deepEqual(reaped, ["u-1", "u-2", "m-1"], "못 잰 쪽만 후보를 소진한다 — 그게 이 플래그가 알리는 사실이다");
  assert.equal(byWs.get("unmeasured")?.reaped, 2);
  assert.equal(byWs.get("measured")?.reaped, 1);
  assert.equal(res.skipReasons.target, 1, "목표에 닿아 남긴 건 m-2 하나뿐이다");
}

console.log("session-reaper(압박 축 — 워크스페이스별 관측): all passed");
