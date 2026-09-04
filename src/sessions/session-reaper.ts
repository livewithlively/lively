// 세션 자동 회수(reaper) — 축이 **둘**이고, 스코프가 다르다 (#1059 F · #1220 · #2509).
//
//  ┌ 유휴 축(reapIdleSessions)  — 신호: 그 워크스페이스 세션의 마지막 활동 · 스코프: **테넌트**
//  └ 압박 축(reapPressureSessions) — 신호: `/proc` 의 물리·스왑        · 스코프: **박스 전역**
//
// ⚠ **왜 갈랐나(#2509).** 종전엔 한 함수가 둘을 다 했다. 그러면 정비 순회(#2479 forEachTenant)에 얹을 수가 없다 —
//  얹는 순간 스왑이 임계를 넘을 때 **워크스페이스 수만큼의 tick 이 같은 전역 신호를 읽고** 각자 완화 TTL 로
//  회수한다. 어느 회수도 압박을 덜기 전에 다음 tick 이 또 같은 판정을 내린다. **전역 트리거를 테넌트마다
//  곱하는 꼴**이다. 그 배선은 가상의 위험이 아니었다: 매니지드는 CP 가 `/api/ops/housekeeping/tick` 을
//  **running 테넌트마다** 부르고(lvly-cloud control/src/tenanttick.ts) 그 틱이 이 회수를 돌린다 — 즉
//  곱셈은 이미 배선돼 있었고, 비-primary 정책이 전부 `{}`(0=끔)라 오늘 안 터졌을 뿐이다
//  (실측 2026-09-01 dev.lvly.io: `org_runtime_config.session_reclaim_policy` 가 95곳 전부 `{}`).
//
// 갈라 놓으면 각 축이 자기 스코프의 배선을 탄다: 유휴는 `perTenant(...)` 순회에, 압박은 **스스로 순회하는**
//  전역 정비로. `SweepJob.scope: "tenant" | "global"` 이 이미 쓰던 어휘 그대로다(새 개념을 만들지 않는다).
//
// ── 유휴 축(#1059 F) ──
// 오래 idle 인 **중앙** 세션을 주기적으로 회수하되 desired-state 를 보존해 열 때 lazy resume(E) 되게 한다.
//  admission control(동시 세션 하드 상한, 정당 세션까지 차단)을 기각하고 채택된 근본대책.
//  왜: 고객사 A 박스 다운의 만성 축 = claude 세션 누적 baseline(~8GB). 이 reaper 가 baseline 을 억눌러 급성
//  스파이크(Ollama 3.3GB)와 겹쳐도 물리 초과가 안 나게 한다. 정책은 관리탭(session_reclaim_policy),
//  기본 0=끔(무회귀) — 운영자가 넉넉한 TTL 을 걸어야 작동.
//
// ⚠ **회수 안전 불변식**(정당 세션 오kill 금지 — #687 교훈). **두 축이 이 불변식을 공유한다**(pickReapCandidates):
//  ① managed(상시 세션): keep-alive 가 소유 → 회수 무의미(되살아남). 제외.
//  ② attached>0: 누가 보는 중 → 제외. **단 무기한은 아니다**(#2148) — `attach_idle_minutes` 를 켜면 그 시간 넘게
//     입출력이 없는 attach 는 존중하지 않는다(원격 tmux 에서 유령 클라이언트가 이 신호를 영구 참으로 만들었다).
//     0(기본)이면 종전대로 무기한 존중이라 셀프호스트 동작은 그대로다.
//  ③ busy(작업 중)·waiting(승인/선택 대기): 죽이면 진행 중 작업·대기 중 결정을 잃는다 → 제외.
//  ④ **desired-state(org_session_state) 레코드가 있는 세션만 회수** — 회수 = 반드시 복원 가능(restorable)해야 한다.
//     레코드 없는(구버전·managed) 세션은 회수해도 복원 못 하므로 손대지 않는다(회수 ⊆ 복원가능 보장).
//  ⑤ idle 지속(now - last_busy, 없으면 created)이 TTL 미만이면 제외.
//  ⑥ **하네스가 띄운 작업이 살아 있으면 제외**(#2652). ③ 의 `working` 은 셋 다 «턴»에 묶여 있어서
//     (스피너 · 훅 보고 Stop=idle · shellWorking=셸 하네스 전용), **AI 가 백그라운드로 긴 작업을 걸어 두고 턴을
//     끝낸 세션**은 어느 신호로도 작업 중이 아니었다. 실측 2026-09-04: 50분짜리 감시를 `run_in_background` 로
//     걸어 둔 세션이 26분째에 압박 회수로 죽었다(회수는 복원 가능하지만 **그 작업은 안 살아난다** — 재개 지점이
//     대화에만 있고 프로세스엔 없다). 판정은 프로세스 그룹으로 한다(session-rss `sessionsWithLiveJobs`).
//     ⓘ 이 불변식만 **후보를 고른 뒤** 적용한다 — 프로세스 표를 뜨는 유일한 불변식이라, 평시(후보 0건)엔
//      비용이 0 이어야 한다. 순수 함수(pickReapCandidates)에 넣지 않는 이유도 같다(그 함수는 tmux·DB 무접촉).
//
// ⚠ **범위 = 중앙 세션만.** 노드 세션(#869)은 멤버 자기 PC 의 tmux 라 중앙 박스 메모리 압박(#1059)과 무관하고,
//  중앙 desired-state 가 없어 복원도 안 된다(node 자체 영속). 멤버 PC 의 idle 세션을 중앙이 죽일 이유가 없다 → 제외.
//  (노드 수명관리가 필요해지면 relayNodeOp{op:'kill'} 로 별도 확장 — 이 과업 범위 밖.)
//
// ── 압박 축(#1220 · #1675 ⑤ · #2509) ──
//  위 TTL 회수가 **평시 baseline 관리**라면, 이건 **급성 압박 대응**이다. 메모리 사용률이 임계를 넘으면 평시 TTL 을
//  기다리지 않고(완화 TTL 로) 회수한다. 왜 게이트웨이가 해야 하나: 그 자리를 종전엔 earlyoom 이 맡았는데
//  earlyoom 의 SIGTERM 은 **예고도 desired-state 보존 신호도 없어** 사용자 눈엔 세션이 그냥 사라진다(고객사 A
//  2026-07-28: 마이크가 '세션이 주기적으로 회수된다'고 신고했지만 F 는 꺼져 있었고 범인은 earlyoom 이었다).
//  같은 메모리 확보를 우리가 하면 회수는 desired-state 를 보존해 restorable 로 남고 링크를 열면 그 자리에서 복원된다.
//
//  ⚠ **무엇을 먼저 죽이냐가 이 기능의 전부다.** #1220 이 밝힌 earlyoom 의 실패는 "죽여도 압박이 안 풀린다"였고,
//   원인은 커널 oom_score 가 분자에 swap 을 포함해 **swap 으로 밀려난(=RSS 는 작은) 세션**을 최우선으로 골랐다는
//   것이다. 그래서 여기서는 **RSS 내림차순**으로 고른다 — 회수로 실제 돌아오는 RAM 이 큰 것부터(session-rss.ts).
//   목표(임계 밑)에 닿으면 **거기서 멈춘다** — 필요 이상으로 남의 세션을 걷어내지 않는다.
//
//  ⚠⚠ **전역이 되면서 새로 생긴 질문: 여러 워크스페이스 중 누구부터 걷나.** 답을 코드에 박지 않고
//   **관리탭 노브 세 개**로 뺐다(운영 대시보드 ▸ 세션 메모리·회수 ▸ 메모리 압박 회수):
//    · 참가 — `pressure_used_pct`/`pressure_swap_pct` 가 **그 워크스페이스의 동의서**다. 둘 다 0 이면
//      그 워크스페이스 세션은 후보에 **아예 들어오지 않는다**(tmux 조회조차 안 한다). 오늘 비-primary 가
//      전부 `{}` 이므로 이 배포는 정의상 무회귀다. 박스 전체 기본값이 필요하면 env 시드가 그 자리다
//      (`LIVELY_SESSION_PRESSURE_*` 는 프로세스 전역 → 모든 워크스페이스의 base, DB 저장이 그걸 이긴다).
//    · 순번 — `pressure_priority`(낮을수록 먼저). 전부 같으면(기본 100) 순수 RSS 내림차순 = #1220 교리 그대로.
//    · 상한 — `pressure_max_reap`(한 tick 에 이 워크스페이스에서 걷을 최대 세션 수). 폭발반경 제한.
//    · 여유 — `pressure_release_margin_pct`(임계보다 이만큼 더 내려갈 때까지 걷는다). 매 tick 재발동 방지.
//   ⓘ **순번 안에서의 정렬(RSS 내림차순)은 노브로 열지 않았다.** 그걸 뒤집는 것이 #1220 이 고친 바로 그
//    실패(작은 것부터 죽여서 압박이 안 풀린다)라, 고를 수 있게 두면 그 사고를 설정으로 재현할 수 있다.
//
//  ⚠ **한계를 숨기지 않는다.** 압박을 만든 워크스페이스가 회수를 안 켰으면 그 세션은 못 건드린다(동의가 없다).
//   그러면 켜 둔 워크스페이스만 계속 걷히고 박스는 안 풀린다 — 그래서 결과에 **불참 워크스페이스 수**를 남긴다.
//   이 숫자가 크면서 압박이 안 풀리면, 고칠 곳은 코드가 아니라 그 워크스페이스의 정책이다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../log.js";
import { listSessionsRaw, listSessionPanePids, reapCentralSession } from "../terminal/terminal-sessions.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import { listAllSessionStates } from "./session-state.js";
import { listManagedSessions } from "./managed-sessions.js";
import { getRuntimeConfig } from "../org/store.js";
import { effectiveSessionReclaimPolicy, normalizeSessionReclaimPolicy, type SessionReclaimPolicy } from "./session-reclaim-policy.js";
import { memAvailableMb, memTotalMb, swapUsageMb } from "../ops/host-mem.js";
import { readProcTable, parsePsTable, sessionRssMb, sessionsWithLiveJobs, type ProcEntry } from "./session-rss.js";
import { sessionExecConfigured, sessionSpawnArgv } from "../terminal/session-exec.js";
import { withTenant, type TenantContext } from "../org/tenant-context.js";
import { schedulerTargets } from "../scheduler/tenant-fanout.js";

const execFileAsync = promisify(execFile);

/**
 * 왜 안 걷었나 — 이유별 카운트. **두 축이 같은 표를 쓴다**(로그·관측이 갈리면 진단이 두 벌이 된다).
 *  · target = 압박 회수가 **목표(임계 밑)에 닿아 남겨둔** 후보 수 — '왜 더 안 걷었나'의 답(정상·바람직한 종료).
 *  · cap    = `pressure_max_reap`(워크스페이스당 tick 상한)에 걸려 남은 수 — 위와 뜻이 정반대라 섞으면 안 된다
 *             (target 은 "필요 없어서", cap 은 "필요한데 못 해서"다).
 *  유휴 축에서 둘은 늘 0 이다(압박 전용 개념) — 없애지 않고 0 으로 남기는 이유는 로그 모양을 한 벌로 두기 위해서다.
 */
export interface ReapSkipReasons {
  managed: number; noState: number; attached: number; working: number; recent: number; failed: number; target: number; cap: number;
  /** ⑥ 하네스가 띄운 작업(백그라운드 셸·빌드 등)이 살아 있어 남겨둔 수(#2652). 두 축이 같이 쓴다. */
  jobs: number;
}

const emptyReasons = (): ReapSkipReasons => ({ managed: 0, noState: 0, attached: 0, working: 0, recent: 0, failed: 0, target: 0, cap: 0, jobs: 0 });

/** 유휴 축의 tick 결과. **CP(reclaimhealth·tenanttick)가 이 모양을 읽는다** — 필드를 지우지 마라. */
export interface ReapResult {
  enabled: boolean; ttlMin: number; scanned: number; reaped: string[]; skipped: number; skipReasons?: ReapSkipReasons;
}

/**
 * 압박 회수의 **정지 조건**(순수) — 발동한 축이 **전부** 목표에 닿으면 true(= 더 걷지 않는다).
 *
 * 축마다 목표가 다르다:
 *  · 물리 축: 되찾은 만큼 사용률이 내려간다(`usedPct' = usedPct − freed/total×100`) → 임계 밑이면 해소.
 *  · 스왑 축: 스왑에 밀려난 페이지를 직접 되돌릴 수단은 없다. 대신 **물리 메모리를 그만큼 되찾으면 그만큼
 *    스왑 압력이 준다**는 근사로, `초과분(overMb)` 만큼 회수하면 해소로 본다.
 *
 * `undefined` 인 축은 이번 tick 에 발동하지 않은 것 → 자동 만족(그 축 때문에 더 걷지 않는다).
 *
 * ⚠ 물리 축에서 `totalMb<=0`(못 잼)이면 **해소로 치지 않는다** — 종전 동작과 같다. 못 재는 상태에서
 *  '목표 달성'을 선언하면 압박이 안 풀린 채 방어가 멈춘다.
 *
 * ⓘ `pressure_release_margin_pct`(여유)는 여기 인자로 오지 않는다 — 호출부가 **임계에서 미리 빼서** 넘긴다.
 *  그래야 이 함수가 축 두 개의 관계만 말하고, 여유는 '임계를 어떻게 정하나'의 문제로 남는다.
 */
export function reclaimTargetReached(o: {
  freedMb: number;
  mem?: { usedPct: number; thresholdPct: number; totalMb: number };
  swap?: { overMb: number };
}): boolean {
  const memOk = !o.mem || (o.mem.totalMb > 0 && o.mem.usedPct - (o.freedMb / o.mem.totalMb) * 100 < o.mem.thresholdPct);
  const swapOk = !o.swap || o.freedMb >= o.swap.overMb;
  return memOk && swapOk;
}

/** 회수 후보 한 건 — 불변식을 통과했고, 얼마나 오래 놀았는지를 안다. */
export interface ReapCandidate { id: string; idleSince: number }

/**
 * **회수 안전 불변식**을 적용해 후보를 고른다(순수 — tmux·DB 무접촉). 두 축이 이 함수를 공유한다.
 *  다르게 두면 «압박일 땐 왜 이건 살아남았지»를 두 곳에서 따로 읽어야 하고, 실제로 한쪽에만 보호가
 *  추가되는 사고가 난다(#1221 이 정확히 그랬다 — busy 만 구제하고 waiting 을 빠뜨렸다).
 *
 * @param cutoffSec       이 시각 **이하**로 유휴면 회수 대상(축마다 TTL 이 다르다 — 평시 TTL vs 완화 TTL).
 * @param attachTtlMin    0 = attach 를 무기한 존중(종전 동작). >0 이면 그 시간 넘게 조용한 attach 는 안 존중.
 */
export function pickReapCandidates(o: {
  live: ReadonlyArray<SessionInfo>;
  restorable: ReadonlySet<string>;
  managedIds: ReadonlySet<string>;
  nowSec: number;
  cutoffSec: number;
  attachTtlMin: number;
  reasons: ReapSkipReasons;
}): ReapCandidate[] {
  const { live, restorable, managedIds, nowSec, cutoffSec, attachTtlMin, reasons } = o;
  const candidates: ReapCandidate[] = [];
  for (const s of live) {
    if (managedIds.has(s.id)) { reasons.managed++; continue; }                 // ① managed
    if (!restorable.has(s.id)) { reasons.noState++; continue; }                // ④ 복원 불가면 손대지 않음
    // ⑤ 유휴 판정에 쓸 마지막 활동 시각 — ② 의 attach TTL 판정도 이 값을 쓰므로 **먼저** 구한다.
    const lastSeen = Math.max(s.lastActive || 0, s.lastAttached || 0);  // 마지막 활동 = 작업 또는 열람
    const idleSince = lastSeen || s.created || 0;
    // ② 누가 보는 중 — **다만 무기한은 아니다**(#2148).
    //  attach 는 '지금 보는 중'을 뜻하지만 그 신호가 거짓일 수 있다: 원격 tmux 에서는 웹 탭이 재연결할 때마다
    //  옛 클라이언트가 안 끊겨 쌓이고, 그러면 `attached>0` 이 영구히 참이 되어 **회수가 영원히 멈춘다**
    //  (2026-08-27 실측: 세션당 유령 6~7개 · 유휴 6~8시간 세션이 어느 경로로도 안 걷힘).
    //  근본 수정은 그 유령을 끊는 것이고(terminal-pty detachGhostClients), 여기 TTL 은 **그게 또 새더라도
    //  회수가 멈추지 않게 하는 안전망**이다. 0 = 종전대로 무기한 존중(셀프호스트 기본 · 무회귀).
    //  같은 교리가 테넌트 축엔 이미 있다(#1445 attach_idle_ttl_min) — 세션 축만 예외로 남아 있었다.
    if (s.attached) {
      const attachCutoffSec = nowSec - attachTtlMin * 60;
      if (attachTtlMin <= 0 || !idleSince || idleSince > attachCutoffSec) { reasons.attached++; continue; }
    }
    // ③ 작업/대기 중 — **접속 여부와 무관한 `working` 을 함께 본다.** agentState 는 attached==0 이면 busy 여도
    //  offline 이 되므로(탭=온라인 규칙), 그 값만 보면 **아무도 안 붙은 채 크론·빌드가 도는 세션이 '작업 중'으로
    //  안 잡혀** 회수된다(상민님 지적 2026-07-28). lastActive(⑤)는 폴링 타이밍에 따라 놓칠 수 있어 보호가 얇았다.
    //  #1221 — `awaiting`(접속 무관 '승인 대기')도 함께 본다. working 을 도입할 때 busy 만 구제하고 waiting 은
    //  남겨 둬서, **탭을 닫아 둔 채 승인 다이얼로그가 떠 있는 세션은 여전히 회수 대상**이었다(agentState 가
    //  offline 으로 덮이고 working=false). 그걸 죽이면 사람이 내리려던 결정이 통째로 사라진다.
    if (s.working || s.awaiting || s.agentState === "busy" || s.agentState === "waiting") { reasons.working++; continue; }
    // ⑤ idle 판정 = **마지막 활동 시각** — 세 축의 최대값을 쓴다.
    //   · lastActive(@box_last_busy): AI 가 돈 시각. busy 관측 기반이라 **대화 대기 중엔 갱신되지 않고, 셸 세션엔 아예 없다.**
    //   · lastAttached(session_last_attached): 마지막으로 탭이 붙은 시각 = **사람이 보고 있었다는 신호.**
    //   · created: 활동 신호가 **하나도 없을 때만** 쓰는 폴백(생성은 활동이 아니다 — max 에 섞으면 갓 만든 세션의
    //     created 가 늘 최신이라 모든 세션이 영구 보존된다. 테스트 #2 가 이 실수를 즉시 잡았다).
    //  ⚠ lastAttached 를 빼면 **지금 보고 있던 세션이 회수된다** — 2026-07-28 실측 사고: VPN 이 끊겨 attached=0 이
    //   된 순간, 42분 전까지 열람 중이던 세션이 'lastActive 149시간 전' 으로 판정돼 회수됐다(그 세션은 대화만 하고
    //   있어서 busy 로 관측된 적이 오래됐다). attached 는 '지금 보는 중'만 말하고 '방금까지 보고 있었다'는
    //   lastAttached 에만 있다 — 네트워크가 잠깐 끊기는 것과 방치를 가르는 유일한 신호다.
    if (!idleSince || idleSince > cutoffSec) { reasons.recent++; continue; }  //   TTL 미만 = 최근 → 보존
    candidates.push({ id: s.id, idleSince });
  }
  return candidates;
}

/** 유휴 회수가 한 워크스페이스에서 쓰는 조회 seam(테스트는 tmux·DB 없이 판정만 검증). */
interface ReapSources {
  loadPolicy?: () => Promise<Partial<SessionReclaimPolicy>>;
  listLive?: () => Promise<Awaited<ReturnType<typeof listSessionsRaw>>>;
  listStates?: () => Promise<Array<{ id: string }>>;
  listManaged?: () => Promise<Array<{ session_id: string | null }>>;
  reap?: (id: string) => Promise<void>;
  now?: () => number;
  /**
   * ⑥ 이 세션들 중 **하네스가 띄운 작업이 살아 있는** 것(#2652). 두 축이 같은 seam 을 쓴다.
   *  `table` 은 이미 뜬 프로세스 표(압박 축은 RSS 때문에 어차피 뜬다) — 주면 다시 뜨지 않는다.
   */
  liveJobs?: (ids: ReadonlySet<string>, table?: Map<number, ProcEntry>) => Promise<ReadonlySet<string>>;
}

/**
 * ⑥ 의 기본 구현 — 프로세스 표 + pane pid 로 «작업이 도는 세션»을 고른다. **후보가 있을 때만** 불린다.
 *
 * ⚠ tmux 가 pane 을 못 보여주면(`ok:false`) **후보 전부를 보호**한다. 여기서 "못 봤다"를 "작업 없다"로 읽으면
 *  하필 tmux 가 느려지는 때(=메모리 압박·스래싱, 즉 이 회수가 도는 바로 그 순간)에 보호가 통째로 사라진다.
 *  판정 못 함의 대가가 «회수 한 tick 밀림» 대 «작업 중인 세션 사망»이라 방향이 자명하다(#1251 과 같은 교리).
 */
async function liveJobSessions(ids: ReadonlySet<string>, table?: Map<number, ProcEntry>): Promise<ReadonlySet<string>> {
  if (!ids.size) return new Set();
  const panes = await listSessionPanePids();
  if (!panes.ok) return new Set(ids);                                   // 못 봤다 ≠ 작업 없다 → 전부 보호
  return resolveLiveJobs(ids, panes, table ?? await readProcTable(), probeSessionProcTable);
}

/**
 * ⑥ 판정의 **두 단계**(주입 가능 — 컨테이너 프로브 없이 단위테스트한다).
 *  ① 이 프로세스의 표로 판정한다(셀프호스트는 여기서 끝난다).
 *  ② 그 표로 **판정조차 못 한** 세션만 골라 그 컨테이너 안에서 다시 본다(매니지드).
 *
 * ⚠ ② 가 왜 필요한가: 매니지드는 세션마다 컨테이너가 따로라(`lvly-s-<slug>-<sid>`) 게이트웨이의 `/proc` 에
 *  그 프로세스가 **아예 없다**(실측 2026-09-04: gw-central 이 보는 프로세스 10개 = 전부 자기 것).
 *  그러면 ① 은 조용히 «작업 없음» 이 되고 ⑥ 이 **매니지드에서만 꺼진 채로** 남는다 — 하필 그쪽 유휴 TTL 이
 *  120분으로 셀프호스트(1440분)보다 짧아, 같은 사고가 더 쉽게 난다.
 * ⚠ 프로브 실패·타임아웃은 **그 세션만** 판정 불가로 두고 넘어간다(회수를 막지 않는다 — S5).
 */
export async function resolveLiveJobs(
  ids: ReadonlySet<string>,
  view: { ok: boolean; panes: Map<string, number[]> },
  local: Map<number, ProcEntry>,
  probe: (sid: string) => Promise<Map<number, ProcEntry>>,
): Promise<ReadonlySet<string>> {
  const found = liveJobsFromView(ids, view, local);
  const unresolved = [...ids].filter((sid) => !found.has(sid) && !judgedLocally(sid, view.panes, local));
  if (!unresolved.length) return found;
  const extra = await Promise.all(unresolved.map(async (sid) => {
    const panePids = view.panes.get(sid);
    if (!panePids?.length) return null;
    try {
      const t = await probe(sid);
      if (!t.size) return null;                                          // 프로브 실패·중계 없음 → 판정 불가
      return sessionsWithLiveJobs(t, new Map([[sid, panePids]])).has(sid) ? sid : null;
    } catch (e) {
      logger.warn({ err: e, id: sid }, "session-reaper: 세션 컨테이너 작업 프로브 실패(그 세션만 판정 불가)");
      return null;
    }
  }));
  const out = new Set(found);
  for (const sid of extra) if (sid) out.add(sid);
  return out;
}

/** 이 프로세스의 표만으로 그 세션을 **판정할 수 있었나** — pane pid 가 표에 있으면 참(= 컨테이너 프로브 불요). */
function judgedLocally(sid: string, panes: Map<string, number[]>, table: Map<number, ProcEntry>): boolean {
  return (panes.get(sid) ?? []).some((pid) => table.has(pid));
}

/** 그 세션 **컨테이너 안**의 프로세스 표. 중계가 없거나 실패하면 빈 표(판정 불가). */
async function probeSessionProcTable(sid: string): Promise<Map<number, ProcEntry>> {
  if (!sessionExecConfigured()) return new Map();          // 셀프호스트 — 중계가 없다(F4)
  const argv = sessionSpawnArgv(sid, ["ps", "-eo", "pid=,ppid=,pgid=,tpgid=,rss=,comm="]);
  if (!argv.length) return new Map();
  const { stdout } = await execFileAsync(argv[0]!, argv.slice(1), { timeout: SESSION_PROBE_TIMEOUT_MS, maxBuffer: 4 << 20 });
  return parsePsTable(stdout);
}

/** 컨테이너 프로브 상한. 중계가 uid 프로브 + exec 두 왕복이라 넉넉히 주되, 회수 tick 을 잡아 두지 않는다. */
const SESSION_PROBE_TIMEOUT_MS = 8_000;

/** ⑥ 의 **판정만** 떼어낸 순수 함수(관측 주입) — "못 봤다"의 처리가 여기 한 줄로 보인다. */
export function liveJobsFromView(
  ids: ReadonlySet<string>,
  view: { ok: boolean; panes: Map<string, number[]> },
  table: Map<number, ProcEntry>,
): ReadonlySet<string> {
  if (!ids.size) return new Set();
  if (!view.ok) return new Set(ids);                                        // 못 봤다 ≠ 작업 없다 → 전부 보호
  const mine = new Map([...view.panes].filter(([sid]) => ids.has(sid)));    // 후보 서브트리만 걷는다
  return sessionsWithLiveJobs(table, mine);
}

/** ⑥ 적용 — 후보에서 «작업이 도는 세션»을 뺀다. 판정 자체가 실패하면 종전대로 진행한다(방어를 멈추지 않는다). */
async function dropLiveJobs(
  candidates: ReapCandidate[], reasons: ReapSkipReasons, deps?: ReapSources, table?: Map<number, ProcEntry>,
): Promise<ReapCandidate[]> {
  if (candidates.length === 0) return candidates;
  const probe = deps?.liveJobs ?? liveJobSessions;
  let busy: ReadonlySet<string>;
  try { busy = await probe(new Set(candidates.map((c) => c.id)), table); }
  catch (e) { logger.warn({ err: e }, "session-reaper: 작업 판정 실패 — ⑥ 없이 진행"); return candidates; }
  if (!busy.size) return candidates;
  reasons.jobs += candidates.filter((c) => busy.has(c.id)).length;
  return candidates.filter((c) => !busy.has(c.id));
}

const policyOf = (deps?: ReapSources): Promise<SessionReclaimPolicy> => {
  const load = deps?.loadPolicy ?? (() => getRuntimeConfig().then((c) => c.session_reclaim_policy));
  //  정규화를 한 겹 씌운다 — 부분 정책(구 DB 행·테스트 주입)에도 새 필드가 기본값으로 채워져
  //  `pressure_used_pct` 가 undefined 로 새는 일이 없다(멱등이라 이미 정규화된 값엔 무해).
  return effectiveSessionReclaimPolicy(async () => normalizeSessionReclaimPolicy(await load()));
};

/**
 * **유휴 축** 한 tick — 정책(idle TTL)을 읽어 조건에 맞는 중앙 세션을 회수한다. 정책 0=끔이면 no-op.
 *
 *  ⚠ **여기서 `/proc` 을 읽지 않는다**(#2509). 압박은 박스의 성질이라 이 함수의 스코프(테넌트) 밖이다 —
 *   그 축은 `reapPressureSessions` 가 전역으로 한 번만 판정한다. 덕분에 이 함수는 **순회해도 안전하다**
 *   (`perTenant("idle-reap", …)`): 워크스페이스마다 자기 TTL 로 자기 세션만 본다.
 *
 *  주입 seam(loadPolicy·now)으로 단위테스트에서 결정 로직만 검증 가능(tmux·DB 없이). 실사용은 인자 없이.
 */
export async function reapIdleSessions(deps?: ReapSources): Promise<ReapResult> {
  const policy = await policyOf(deps);
  const ttlMin = policy.idle_ttl_minutes;
  if (!ttlMin || ttlMin <= 0) return { enabled: false, ttlMin: 0, scanned: 0, reaped: [], skipped: 0 };

  const listLive = deps?.listLive ?? listSessionsRaw;
  const listStates = deps?.listStates ?? listAllSessionStates;
  const listManaged = deps?.listManaged ?? listManagedSessions;
  const reap = deps?.reap ?? reapCentralSession;
  const now = deps?.now ?? Date.now;

  const [live, states, managed] = await Promise.all([listLive(), listStates(), listManaged()]);
  const restorable = new Set(states.map((s) => s.id));                 // 불변식 ④ — 복원 가능한 세션만 회수
  const managedIds = new Set(managed.map((m) => m.session_id).filter((x): x is string => !!x)); // 불변식 ①
  const nowSec = Math.floor(now() / 1000);

  // 이유별 카운트 — **왜 안 죽였나**가 없으면 진단이 불가능하다. 실측(2026-07-28): 고객사 A에서 F 를 켰는데 회수가
  //  0건이었고, 로그가 침묵해서(종전엔 reaped>0 일 때만 로그) 운영자도 우리도 tick 이 돌았는지조차 몰랐다.
  const reasons = emptyReasons();
  const picked = pickReapCandidates({
    live, restorable, managedIds, nowSec,
    cutoffSec: nowSec - ttlMin * 60,
    attachTtlMin: policy.attach_idle_minutes ?? 0,
    reasons,
  });
  // ⑥ 하네스가 띄운 작업이 도는 세션은 뺀다(#2652). **후보가 나온 뒤에만** 프로세스를 본다 — 평시엔 후보가
  //  0건이라(실측: dev 박스 며칠간 유휴 회수 0건) 이 경로의 평시 비용도 0 이다. 점유(RSS)는 여전히 안 잰다.
  const candidates = await dropLiveJobs(picked, reasons, deps);
  // 평시 순서 = **오래 idle 인 것부터**(사용자 피해가 가장 적은 순). 점유는 재지 않는다 — 불필요한 /proc 스캔 금지.
  candidates.sort((a, b) => a.idleSince - b.idleSince);

  const reaped: string[] = [];
  for (const c of candidates) {
    try {
      await reap(c.id);                                                // tmux 만 죽이고 desired-state 보존 → restorable
      reaped.push(c.id);
    } catch (e) {
      reasons.failed++;
      logger.warn({ err: e, id: c.id }, "session-reaper: 회수 실패(계속)");
    }
  }
  const skipped = reasons.managed + reasons.noState + reasons.attached + reasons.working + reasons.recent + reasons.failed + reasons.jobs;
  // 정책이 켜져 있으면 **매 tick** 남긴다(회수 0건도) — 5분에 한 줄이고, 이 한 줄이 없으면 "왜 아무것도 안 죽었나"를
  //  박스에서 추측으로 파야 한다. noState 가 크면 백필(session-state-backfill)이 필요하다는 신호다.
  //  ⚠ **무엇을 걷었는지(id)도 남긴다**(#2652) — 종전엔 개수뿐이라, 사라진 세션의 주인이 «왜 회수됐나»를 물으면
  //   대화기록 파일의 mtime 을 tick 시각과 대조하는 수밖에 없었다(실측 2026-09-04 조사가 정확히 그랬다).
  logger.info({ ttlMin, scanned: live.length, reaped: reaped.length, reapedIds: reaped.slice(0, 20), skipped, skipReasons: reasons },
    "session-reaper tick(idle 세션 회수 — desired-state 보존 → restorable)");
  return { enabled: true, ttlMin, scanned: live.length, reaped, skipped, skipReasons: reasons };
}

// ── 압박 축(전역) ────────────────────────────────────────────────────────────────────────

/**
 * 전역 압박 스윕의 **최소 간격**. 이 가드가 이 파일에서 제일 중요한 한 줄이다.
 *
 *  ⚠ 이 함수는 **여러 자리에서 불린다** — 하우스키핑 5분 타이머(셀프호스트), CP 의 테넌트별 틱
 *   (매니지드 — running 테넌트마다 온다). 전역 스윕을 호출 수만큼 돌리면 #2509 가 고치려던 그 곱셈을
 *   이름만 바꿔 되살리는 것이다. 그래서 **시간으로 잠근다**: 누가 몇 번 부르든 이 간격에 한 번만 돈다.
 *  ⓘ 5분(하우스키핑 주기)이 아니라 60초인 이유: 압박은 급성이라 5분을 기다리면 earlyoom 이 먼저 이긴다
 *   (#1675 ⑤ 가 임계 상한을 90 으로 낮춘 것과 같은 계산 — tick 지연이 곧 방어 여유다).
 */
export const PRESSURE_SWEEP_MIN_INTERVAL_MS = 60_000;

/** 마지막으로 전역 스윕이 **실제로 돈** 시각. 인메모리 — 재기동하면 비는데, 그게 맞다(첫 tick 이 곧바로 돈다). */
let lastPressureSweepAt = 0;

/** 테스트용 — 전역 디바운스를 비운다. */
export function resetPressureSweepDebounce(): void { lastPressureSweepAt = 0; }

/** 이 tick 에 압박 회수가 발동한 축(그 워크스페이스 기준). undefined 인 축은 발동하지 않은 것. */
export interface PressureAxes {
  mem?: { usedPct: number; thresholdPct: number; totalMb: number };
  swap?: { overMb: number };
}

/** 워크스페이스 한 곳의 참가 여부 — '왜 손을 못 댔나'를 사람이 읽을 수 있게 남긴다. */
export interface PressureWorkspaceReport {
  slug: string;
  /** 그 워크스페이스의 압박 임계가 이번 박스 상태에서 발동했나. false 면 후보를 한 건도 안 냈다(tmux 조회도 안 했다). */
  participated: boolean;
  /** 불참 사유 — "정책 꺼짐"(둘 다 0) / "임계 미달"(켜 뒀지만 아직 안 넘음) / "조회 실패". */
  why?: string;
  candidates?: number;
  reaped?: number;
  /**
   * 이 워크스페이스의 세션 점유를 **실제로 쟀나**. 전역 요약(`rssMeasured`)만으로는 부족하다 —
   *  한 곳은 재고 한 곳은 못 재면 요약은 참인데 **못 잰 쪽만 조용히 과다 회수된다**(못 잰 세션은 0 으로
   *  기여해 목표가 영영 안 서고 후보를 끝까지 걷는다). 그 자리를 여기서 가른다.
   */
  rssMeasured?: boolean;
}

export interface PressureReapResult {
  /** 이번 호출이 실제로 돌았나. false = 디바운스에 걸림(throttled) 또는 압박 신호를 못 읽음. */
  ran: boolean;
  throttled: boolean;
  /** 박스 전역 신호 — 못 쟀으면 -1(0 과 구분해야 한다: 0% 는 정상값이다). */
  usedPct: number;
  swapPct: number;
  totalMb: number;
  /** 순회한 워크스페이스 수 / 그중 참가한 수. **불참이 많은데 압박이 안 풀리면 고칠 곳은 그 워크스페이스 정책이다.** */
  workspaces: number;
  participating: number;
  scanned: number;
  reaped: string[];
  skipped: number;
  skipReasons: ReapSkipReasons;
  /** 회수한 세션들의 RSS 합(MB) = 이번에 되찾은 것으로 **추정**되는 양. 측정 불가 세션은 0 으로 기여. */
  freedMb: number;
  /**
   * 목표에 닿아 남은 후보를 남겨두고 멈춘 일이 **있었나**(=필요한 만큼만 걷었다).
   * ⚠ 워크스페이스가 여럿이면 «전부 해소»가 아니라 **«적어도 한 곳이 자기 목표에 닿았다»** 는 뜻이다 —
   *  정지 판정은 후보마다 그 워크스페이스의 임계로 하기 때문이다(임계가 다르면 동시에 풀리지 않는다).
   *  정확한 수는 `skipReasons.target`, 어디가 풀렸는지는 `perWorkspace` 를 봐라.
   */
  reachedTarget: boolean;
  /**
   * 세션 점유(RSS)를 **실제로 잴 수 있었나**. false 면 이번 tick 은 '필요한 만큼만'이 성립하지 않는다 —
   * 되찾은 양을 0 으로만 볼 수 있어 목표 판정이 영영 안 서고, 후보를 전부 걷게 된다(의도된 폴백: 압박 상황에서
   * 측정 실패로 방어를 멈추는 것보다 낫다).
   * ⚠ 이 플래그가 없으면 **"측정을 못 해 다 걷었다"와 "안전한 후보가 애초에 없었다"가 로그에서 구분되지 않는다**
   *  (둘 다 reachedTarget=false). 사고 중 운영자가 가장 먼저 알아야 할 구분이라 따로 남긴다.
   * ⚠ 이건 **전역 요약**(어디든 한 곳이라도 쟀나)이다 — 한 곳은 재고 한 곳은 못 재면 참인데 못 잰 쪽만
   *  조용히 과다 회수된다. 워크스페이스별 판정은 `perWorkspace[].rssMeasured` 에 있다.
   */
  rssMeasured: boolean;
  perWorkspace: PressureWorkspaceReport[];
}

/** 전역 후보 — 어느 워크스페이스 것인지, 그 워크스페이스의 순번·임계가 무엇인지를 지고 다닌다. */
interface GlobalCandidate extends ReapCandidate {
  tenant: TenantContext | null;
  slug: string;
  priority: number;
  rssMb: number;
  axes: PressureAxes;
  maxReap: number;
  /** 그 워크스페이스가 이번 tick 에 점유를 **실제로 쟀나**. 못 쟀으면 정지 조건이 안 서므로 상한이 달라진다. */
  rssMeasured: boolean;
}

export interface PressureReapDeps extends ReapSources {
  /** 순회 대상. `null` = 단일 테넌트 배포 → 종전 경로(컨텍스트를 만들지 않고 1회). */
  targets?: () => Promise<TenantContext[] | null>;
  /** 테넌트 컨텍스트 진입 seam. 기본은 `withTenant`(단일 테넌트면 그대로 실행). */
  within?: <T>(t: TenantContext | null, fn: () => Promise<T>) => Promise<T>;
  memUsedPct?: () => Promise<number>;
  memTotal?: () => number;
  /** 스왑 사용량(총/여유 MB). null = 못 잼 또는 스왑 없는 박스 → 스왑 축 비활성. */
  swapUsage?: () => Promise<{ totalMb: number; freeMb: number } | null>;
  /** 박스 전역 /proc 표 — **한 번만** 읽는다(워크스페이스마다 읽으면 그게 곧 곱셈이다). */
  procTable?: () => Promise<Map<number, ProcEntry>>;
  /** 그 워크스페이스의 세션→RSS(MB). 테넌트 컨텍스트 **안**에서 불린다(pane pid 는 그 tmux 서버의 것). */
  sessionRss?: (table: Map<number, ProcEntry>) => Promise<Map<string, number>>;
  minIntervalMs?: number;
}

/**
 * **압박 축** 한 tick — 박스 전역이다. 스스로 워크스페이스를 순회하므로 `perTenant(...)` 로 감싸지 마라
 *  (감싸면 워크스페이스 수만큼 같은 전역 판정이 돈다 = #2509 가 고친 그 곱셈).
 *
 *  ── 순서 ──
 *  ① 박스 신호를 **한 번** 읽는다(`/proc` 물리·스왑, proc 표).
 *  ② 워크스페이스마다 그 정책으로 **참가 여부**를 정한다 — 임계가 0 이거나 아직 안 넘었으면 후보를 안 낸다
 *     (그 워크스페이스의 tmux 는 조회조차 안 한다 — 95곳짜리 박스에서 이게 곧 비용이다).
 *  ③ 참가한 곳들의 후보를 **한 통에 모아** 전역 정렬한다(순번 오름차순 → RSS 내림차순 → 오래 idle 순).
 *  ④ 걷는다. 각 후보는 **자기 워크스페이스의 임계**가 아직 안 풀렸을 때만 걷는다 — 남의 임계를 만족시키려고
 *     동의 범위 밖까지 걷지 않는다. 워크스페이스별 `pressure_max_reap` 도 여기서 건다.
 */
export async function reapPressureSessions(deps?: PressureReapDeps): Promise<PressureReapResult> {
  const now = deps?.now ?? Date.now;
  const minInterval = deps?.minIntervalMs ?? PRESSURE_SWEEP_MIN_INTERVAL_MS;
  const reasons = emptyReasons();
  const idle = (over: Partial<PressureReapResult>): PressureReapResult => ({
    ran: false, throttled: false, usedPct: -1, swapPct: -1, totalMb: 0,
    workspaces: 0, participating: 0, scanned: 0, reaped: [], skipped: 0, skipReasons: reasons,
    freedMb: 0, reachedTarget: false, rssMeasured: false, perWorkspace: [], ...over,
  });

  const nowMs = now();
  if (lastPressureSweepAt > 0 && nowMs - lastPressureSweepAt < minInterval) return idle({ throttled: true });
  lastPressureSweepAt = nowMs;

  // ── ① 박스 신호(전역) — 한 번만 ──
  const memTotal = deps?.memTotal ?? memTotalMb;
  const memUsedPct = deps?.memUsedPct ?? (async () => {
    const totalMb = memTotal(), availableMb = await memAvailableMb();     // box-watch 의 메모리 경보와 **같은 식**
    return totalMb > 0 ? Math.round(((totalMb - availableMb) / totalMb) * 100) : 0;
  });
  const loadSwap = deps?.swapUsage ?? swapUsageMb;

  let usedPct = -1;
  try { usedPct = await memUsedPct(); }
  catch (e) {
    // 메모리를 못 재면 물리 축은 발동하지 않는다(모르면 사용자 자산을 건드리지 않는다). 스왑 축은 따로 잰다.
    logger.warn({ err: e }, "session-reaper: 메모리 조회 실패 — 물리 압박 축 생략");
  }
  let swapPct = -1;
  let swapUsedMb = 0, swapTotalMb = 0;
  try {
    const su = await loadSwap();
    // totalMb<=0 = 스왑 없는 박스 → 이 축은 성립하지 않는다(0/0 을 100% 로 읽어 상시 발동하면 재앙이다).
    if (su && su.totalMb > 0) {
      swapTotalMb = su.totalMb;
      swapUsedMb = Math.max(0, su.totalMb - su.freeMb);
      swapPct = Math.round((swapUsedMb / su.totalMb) * 100);
    }
  } catch (e) { logger.warn({ err: e }, "session-reaper: 스왑 조회 실패 — 스왑 축 생략"); }

  if (usedPct < 0 && swapPct < 0) return idle({ ran: false });   // 두 축 다 못 읽음 — 판정 근거가 없다

  const totalMb = memTotal();

  // ── ② 워크스페이스별 참가 판정 + 후보 수집 ──
  const targetsOf = deps?.targets ?? schedulerTargets;
  const within = deps?.within ?? (<T,>(t: TenantContext | null, fn: () => Promise<T>) => (t ? withTenant(t, fn) : fn()));
  const listLive = deps?.listLive ?? listSessionsRaw;
  const listStates = deps?.listStates ?? listAllSessionStates;
  const listManaged = deps?.listManaged ?? listManagedSessions;
  const reap = deps?.reap ?? reapCentralSession;
  const loadProc = deps?.procTable ?? readProcTable;
  const loadRss = deps?.sessionRss ?? (async (table: Map<number, ProcEntry>) => sessionRssMb(table, (await listSessionPanePids()).panes));

  const targets = await targetsOf();
  //  `null` = 레지스트리 없는 단일 테넌트 배포 → 지금 컨텍스트에서 종전 그대로 1회(무회귀가 기본값이다).
  const workspaces: Array<TenantContext | null> = targets === null ? [null] : targets;
  const nowSec = Math.floor(nowMs / 1000);

  const perWorkspace: PressureWorkspaceReport[] = [];
  const all: GlobalCandidate[] = [];
  let scanned = 0;
  let procTable: Map<number, ProcEntry> | null = null;

  for (const t of workspaces) {
    const slug = t?.slug ?? "(single)";
    try {
      const collected = await within(t, async (): Promise<{ report: PressureWorkspaceReport; candidates: GlobalCandidate[] }> => {
        const policy = await policyOf(deps);
        const memThreshold = policy.pressure_used_pct ?? 0;
        const swapThreshold = policy.pressure_swap_pct ?? 0;
        if (memThreshold <= 0 && swapThreshold <= 0) {
          return { report: { slug, participated: false, why: "정책 꺼짐(임계 0)" }, candidates: [] };
        }
        // 여유(#2509) — 임계보다 이만큼 더 내려갈 때까지 걷는다. 매 tick 재발동(임계 바로 밑에서 진동)을 막는다.
        //  ⚠ 임계 자체를 낮추는 것과 다르다: **발동**은 원래 임계로 하고 **정지**만 더 내려간다.
        const margin = policy.pressure_release_margin_pct ?? 0;
        const axes: PressureAxes = {};
        if (memThreshold > 0 && usedPct >= 0 && usedPct >= memThreshold) {
          axes.mem = { usedPct, thresholdPct: Math.max(1, memThreshold - margin), totalMb };
        }
        if (swapThreshold > 0 && swapPct >= 0 && swapPct >= swapThreshold) {
          // 임계까지 내리는 데 필요한 양 — 물리 메모리를 이만큼 되찾으면 그만큼 스왑 압력이 준다는 근사.
          const targetPct = Math.max(1, swapThreshold - margin);
          axes.swap = { overMb: Math.max(0, Math.round(swapUsedMb - (swapTotalMb * targetPct) / 100)) };
        }
        if (!axes.mem && !axes.swap) {
          return { report: { slug, participated: false, why: "임계 미달" }, candidates: [] };
        }

        const [live, states, managed] = await Promise.all([listLive(), listStates(), listManaged()]);
        const restorable = new Set(states.map((s) => s.id));
        const managedIds = new Set(managed.map((m) => m.session_id).filter((x): x is string => !!x));
        const pickedRaw = pickReapCandidates({
          live, restorable, managedIds, nowSec,
          //  압박이면 **완화 TTL**로 갈아탄다 — 다만 "방금까지 쓰던 세션"은 그래도 안 건드린다(그 하한선이 이 값이다).
          cutoffSec: nowSec - (policy.pressure_idle_minutes ?? 0) * 60,
          attachTtlMin: policy.attach_idle_minutes ?? 0,
          reasons,
        });
        scanned += live.length;

        // 점유(RSS)는 후보가 있을 때만 잰다. proc 표는 **박스 전역**이라 한 번만 읽고 워크스페이스끼리 공유한다;
        //  pane pid 는 그 tmux 서버의 것이라 컨텍스트 안에서 워크스페이스마다 읽는다.
        let rss = new Map<string, number>();
        if (pickedRaw.length > 0) {
          try {
            if (!procTable) procTable = await loadProc();
            rss = await loadRss(procTable);
          } catch (e) { logger.warn({ err: e, workspace: slug }, "session-reaper: 세션 RSS 측정 실패 — 이 워크스페이스는 0 으로 본다"); }
        }
        // ⑥ 작업이 도는 세션은 압박 중에도 안 걷는다(#2652). 급성 압박이라도 «사람이 시켜 놓은 작업»을 죽여
        //  얻는 메모리는 그 작업을 처음부터 다시 시키는 비용보다 싸지 않다. 표는 위에서 이미 떴으니 재사용한다.
        const picked = await dropLiveJobs(pickedRaw, reasons, deps, procTable ?? undefined);
        const priority = policy.pressure_priority ?? 100;
        const maxReap = policy.pressure_max_reap ?? 0;
        //  '쟀다'의 기준 = 후보 중 **하나라도 양수 RSS 를 얻었나**. 맵이 비어 있지 않아도 값이 전부 0 이면 못 잰 것이다
        //  (hidepid 로 남의 uid /proc 를 못 읽는 격리 박스가 정확히 이 모양이 된다 — 이 기능이 노리는 바로 그 환경).
        const rssMeasured = picked.some((c) => (rss.get(c.id) ?? 0) > 0);
        const mine = picked.map((c) => ({ ...c, tenant: t, slug, priority, rssMb: rss.get(c.id) ?? 0, axes, maxReap, rssMeasured }));
        return {
          report: { slug, participated: true, candidates: picked.length, reaped: 0, rssMeasured },
          candidates: mine,
        };
      });
      perWorkspace.push(collected.report);
      all.push(...collected.candidates);
    } catch (err) {
      // 한 워크스페이스의 실패가 나머지를 막지 않는다(#2479 순회와 같은 규율).
      logger.warn({ err, workspace: slug }, "session-reaper: 압박 후보 수집 실패(그 워크스페이스만 건너뜀)");
      perWorkspace.push({ slug, participated: false, why: "조회 실패" });
    }
  }

  const participating = perWorkspace.filter((w) => w.participated).length;
  if (all.length === 0) {
    const skipped = reasons.managed + reasons.noState + reasons.attached + reasons.working + reasons.recent + reasons.jobs;
    logger.info({ usedPct, swapPct, workspaces: workspaces.length, participating, scanned, skipped, skipReasons: reasons, perWorkspace },
      "session-reaper tick(압박 회수 — 걷을 후보 없음)");
    //  ⚠ `perWorkspace` 를 반드시 함께 돌려준다 — «왜 한 건도 안 걷었나»의 답이 전부 여기 있다.
    //   로그에만 남기면 CP·관리탭이 그 답을 못 읽어서, 정책이 꺼진 것과 후보가 없던 것이 똑같이 «0건»으로 보인다.
    return idle({ ran: true, usedPct, swapPct, totalMb, workspaces: workspaces.length, participating, scanned, skipped, perWorkspace });
  }

  // ── ③ 전역 정렬 ── 순번(낮을수록 먼저) → RSS 내림차순(#1220 교리) → 오래 idle 순(동점 tie-break).
  all.sort((a, b) => (a.priority - b.priority) || (b.rssMb - a.rssMb) || (a.idleSince - b.idleSince));

  // ── ④ 회수 ── 자기 워크스페이스의 임계가 아직 안 풀렸을 때만 걷는다.
  //  ⚠ 판정은 회수한 세션들의 RSS 합(추정)으로 한다. 실측 재조회로 하면 `tmux kill-session` 은 SIGHUP 을 보내고
  //   바로 반환하므로 **아직 반환되지 않은 메모리**를 못 봐서 필요 이상 걷어낸다(회수는 되돌릴 수 없다 —
  //   과다 회수가 과소 회수보다 나쁘다). 측정 못 한 세션은 0 으로 기여해 목표 도달이 늦어질 뿐, 불변식은 유지된다.
  //  ⚠ 목표에 닿은 후보에서 `break` 하지 않고 `continue` 한다 — 뒤에 **더 엄격한 임계**를 가진 워크스페이스의
  //   후보가 남아 있을 수 있다(순번·RSS 로 정렬돼 있지 임계 순이 아니다). 단일 워크스페이스면 결과는 종전과 같다.
  const reaped: string[] = [];
  const reapedBySlug = new Map<string, number>();
  let freedMb = 0;
  let reachedTarget = false;
  for (const c of all) {
    // 상한 — 운영자가 정한 `pressure_max_reap` 이 우선이고, **안 정했는데 점유도 못 쟀으면 tick 당 1건**이다(#2652).
    //  왜 1인가: 못 재면 `freedMb` 가 늘 0 이라 «목표에 닿으면 멈춘다»(reclaimTargetReached)가 **구조적으로 참이 될 수
    //  없다** → 종전엔 그 워크스페이스의 후보를 **전부** 걷었다(실측 2026-09-03~04 맥미니: 13회 발동 전부
    //  rssMeasured=false·reachedTarget=false, 30세션). 판정 근거가 없을 때 취할 수 있는 가장 작은 걸음이 1건이고,
    //  압박이 진짜면 다음 tick(≥60초)에 또 걷는다 — 오판의 대가가 «해소가 1분 늦다»로 유계가 된다.
    //  ⓘ 맥에서 이 자리에 오는 일 자체가 이제 드물다(readProcTable 이 darwin 을 지원해 대개 잰다) — 남는 건
    //   hidepid 격리 박스처럼 **정말로 못 재는** 경우다.
    const cap = c.maxReap > 0 ? c.maxReap : (c.rssMeasured ? 0 : 1);
    if (cap > 0 && (reapedBySlug.get(c.slug) ?? 0) >= cap) { reasons.cap++; continue; }
    if (reclaimTargetReached({ freedMb, mem: c.axes.mem, swap: c.axes.swap })) { reasons.target++; reachedTarget = true; continue; }
    try {
      await within(c.tenant, () => reap(c.id));                        // tmux 만 죽이고 desired-state 보존 → restorable
      reaped.push(c.id);
      reapedBySlug.set(c.slug, (reapedBySlug.get(c.slug) ?? 0) + 1);
      freedMb += c.rssMb;
    } catch (e) {
      reasons.failed++;
      logger.warn({ err: e, id: c.id, workspace: c.slug }, "session-reaper: 회수 실패(계속)");
    }
  }
  for (const w of perWorkspace) if (w.participated) w.reaped = reapedBySlug.get(w.slug) ?? 0;

  //  '쟀다'의 기준 = 후보 중 **하나라도 양수 RSS 를 얻었나**. 맵이 비어 있지 않아도 값이 전부 0 이면 못 잰 것이다
  //  (hidepid 로 남의 uid /proc 를 못 읽는 격리 박스가 정확히 이 모양이 된다 — 이 기능이 노리는 바로 그 환경).
  const rssMeasured = all.some((c) => c.rssMb > 0);
  const skipped = reasons.managed + reasons.noState + reasons.attached + reasons.working + reasons.recent
    + reasons.failed + reasons.target + reasons.cap + reasons.jobs;
  //  ⚠ 압박 회수는 **사후 추적이 특히 중요하다** — 사용자에겐 "세션이 사라졌다"로 보이므로, 무엇을 왜 걷었는지가
  //   로그에 없으면 #1220 이 고치려던 그 상황(earlyoom 이 죽였는데 아무도 몰라 '회수'로 오인)을 우리가 재현한다.
  //   ⓘ 그 주석을 적어 놓고 **정작 id 는 안 남기고 있었다**(#2652 실측: 사라진 세션의 주인이 물었을 때, 답을
  //    맞추려고 대화기록 파일의 mtime 을 tick 시각과 대조해야 했다). `reapedIds` 가 그 자리다.
  logger.info({
    usedPct, swapPct, totalMb, workspaces: workspaces.length, participating,
    scanned, reaped: reaped.length, reapedIds: reaped.slice(0, 20), skipped, skipReasons: reasons,
    freedMb, reachedTarget, rssMeasured, perWorkspace,
  }, "session-reaper tick(압박 회수 — 전역 · 순번→RSS 순, desired-state 보존 → restorable)");

  return {
    ran: true, throttled: false, usedPct, swapPct, totalMb,
    workspaces: workspaces.length, participating, scanned, reaped, skipped, skipReasons: reasons,
    freedMb, reachedTarget, rssMeasured, perWorkspace,
  };
}
