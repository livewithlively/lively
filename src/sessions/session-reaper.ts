// idle 세션 자동 회수(reaper) — #1059 F. 오래 idle 인 **중앙** 세션을 주기적으로 회수하되 desired-state 를 보존해
//  열 때 lazy resume(E) 되게 한다. admission control(동시 세션 하드 상한, 정당 세션까지 차단)을 기각하고 채택된 근본대책.
//
// 왜(#1059): 고객사 A 박스 다운의 만성 축 = claude 세션 누적 baseline(~8GB). 이 reaper 가 baseline 을 억눌러 급성
//  스파이크(Ollama 3.3GB)와 겹쳐도 물리 초과가 안 나게 한다. 정책(idle TTL)은 관리탭(session_reclaim_policy),
//  기본 0=끔(무회귀) — 운영자가 넉넉한 TTL 을 걸어야 작동.
//
// ⚠ **회수 안전 불변식**(정당 세션 오kill 금지 — #687 교훈):
//  ① managed(상시 세션): keep-alive 가 소유 → 회수 무의미(되살아남). 제외.
//  ② attached>0: 누가 보는 중 → 제외.
//  ③ busy(작업 중)·waiting(승인/선택 대기): 죽이면 진행 중 작업·대기 중 결정을 잃는다 → 제외.
//  ④ **desired-state(org_session_state) 레코드가 있는 세션만 회수** — 회수 = 반드시 복원 가능(restorable)해야 한다.
//     레코드 없는(구버전·managed) 세션은 회수해도 복원 못 하므로 손대지 않는다(회수 ⊆ 복원가능 보장).
//  ⑤ idle 지속(now - last_busy, 없으면 created)이 TTL 미만이면 제외.
//
// ⚠ **범위 = 중앙 세션만.** 노드 세션(#869)은 멤버 자기 PC 의 tmux 라 중앙 박스 메모리 압박(#1059)과 무관하고,
//  중앙 desired-state 가 없어 복원도 안 된다(node 자체 영속). 멤버 PC 의 idle 세션을 중앙이 죽일 이유가 없다 → 제외.
//  (노드 수명관리가 필요해지면 relayNodeOp{op:'kill'} 로 별도 확장 — 이 과업 범위 밖.)
//
// ── #1220 압박 회수(pressure reclaim) ──
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
import { logger } from "../log.js";
import { listSessionsRaw, listSessionPanePids, reapCentralSession } from "../terminal/terminal-sessions.js";
import { listAllSessionStates } from "./session-state.js";
import { listManagedSessions } from "./managed-sessions.js";
import { getRuntimeConfig } from "../org/store.js";
import { effectiveSessionReclaimPolicy, normalizeSessionReclaimPolicy, type SessionReclaimPolicy } from "./session-reclaim-policy.js";
import { memAvailableMb, memTotalMb } from "../ops/host-mem.js";
import { readProcTable, sessionRssMb } from "./session-rss.js";

/** target = #1220 압박 회수가 **목표(임계 밑)에 닿아 남겨둔** 후보 수 — '왜 더 안 걷었나'의 답(정상·바람직한 종료). */
export interface ReapSkipReasons { managed: number; noState: number; attached: number; working: number; recent: number; failed: number; target: number }
/** #1220 — 이번 tick 이 압박 회수로 발동했을 때의 상황(평시 TTL 회수면 undefined). */
export interface ReapPressure {
  /** 발동 시점 메모리 사용률(%). */
  usedPct: number;
  /** 정책 임계(%) — 이 밑으로 내리는 게 목표다. */
  thresholdPct: number;
  /** 회수한 세션들의 RSS 합(MB) = 이번에 되찾은 것으로 **추정**되는 양. 측정 불가 세션은 0 으로 기여. */
  freedMb: number;
  /** 목표에 도달해 남은 후보를 남겨두고 멈췄나(=필요한 만큼만 걷었다). */
  reachedTarget: boolean;
  /**
   * 세션 점유(RSS)를 **실제로 잴 수 있었나**. false 면 이번 tick 은 '필요한 만큼만'이 성립하지 않는다 —
   * 되찾은 양을 0 으로만 볼 수 있어 목표 판정이 영영 안 서고, 후보를 전부 걷게 된다(의도된 폴백: 압박 상황에서
   * 측정 실패로 방어를 멈추는 것보다 낫다).
   * ⚠ 이 플래그가 없으면 **"측정을 못 해 다 걷었다"와 "안전한 후보가 애초에 없었다"가 로그에서 구분되지 않는다**
   *  (둘 다 reachedTarget=false). 사고 중 운영자가 가장 먼저 알아야 할 구분이라 따로 남긴다.
   */
  rssMeasured: boolean;
}
export interface ReapResult {
  enabled: boolean; ttlMin: number; scanned: number; reaped: string[]; skipped: number; skipReasons?: ReapSkipReasons;
  pressure?: ReapPressure;
}

// 한 회수 tick — 정책(idle TTL)을 읽어 조건에 맞는 중앙 세션을 회수한다. 정책 0=끔이면 no-op.
//  주입 seam(loadPolicy·now)으로 단위테스트에서 결정 로직만 검증 가능(tmux·DB 없이). 실사용은 인자 없이.
export async function reapIdleSessions(deps?: {
  loadPolicy?: () => Promise<Partial<SessionReclaimPolicy>>;
  listLive?: () => Promise<Awaited<ReturnType<typeof listSessionsRaw>>>;
  listStates?: () => Promise<Array<{ id: string }>>;
  listManaged?: () => Promise<Array<{ session_id: string | null }>>;
  reap?: (id: string) => Promise<void>;
  now?: () => number;
  /** #1220 — 지금 메모리 사용률(%)·전체(MB)·세션별 RSS(MB). 주입 seam(테스트는 /proc·tmux 없이 판정만 검증). */
  memUsedPct?: () => Promise<number>;
  memTotal?: () => number;
  sessionRss?: () => Promise<Map<string, number>>;
}): Promise<ReapResult> {
  const loadPolicy = deps?.loadPolicy ?? (() => getRuntimeConfig().then((c) => c.session_reclaim_policy));
  //  정규화를 한 겹 씌운다 — 부분 정책(구 DB 행·테스트 주입)에도 새 필드가 기본값으로 채워져
  //  `pressure_used_pct` 가 undefined 로 새는 일이 없다(멱등이라 이미 정규화된 값엔 무해).
  const policy = await effectiveSessionReclaimPolicy(async () => normalizeSessionReclaimPolicy(await loadPolicy()));
  const ttlMin = policy.idle_ttl_minutes;

  const memTotal = deps?.memTotal ?? memTotalMb;
  const memUsedPct = deps?.memUsedPct ?? (async () => {
    const totalMb = memTotal(), availableMb = await memAvailableMb();     // box-watch 의 메모리 경보와 **같은 식**
    return totalMb > 0 ? Math.round(((totalMb - availableMb) / totalMb) * 100) : 0;
  });
  const loadRss = deps?.sessionRss ?? (async () => sessionRssMb(await readProcTable(), (await listSessionPanePids()).panes));

  // #1220 — 압박 판정을 **먼저** 한다. 평시 회수가 꺼져 있어도(idle_ttl=0) 압박 회수는 독립적으로 발동해야 한다:
  //  "평소엔 아무것도 안 건드리다가 위급할 때만 걷는다"가 성립해야 운영자가 켤 수 있다.
  const pressurePct = policy.pressure_used_pct ?? 0;
  let usedPct = 0;
  let underPressure = false;
  if (pressurePct > 0) {
    try {
      usedPct = await memUsedPct();
      underPressure = usedPct >= pressurePct;
    } catch (e) {
      // 메모리를 못 재면 압박 회수는 발동하지 않는다(모르면 사용자 자산을 건드리지 않는다). 평시 TTL 은 그대로 동작.
      logger.warn({ err: e }, "session-reaper: 메모리 조회 실패 — 압박 회수 생략(평시 TTL 만 적용)");
    }
  }
  // 압박이면 완화 TTL 로 갈아탄다. 둘 다 꺼져 있으면 할 일이 없다.
  const effTtlMin = underPressure ? (policy.pressure_idle_minutes ?? 0) : ttlMin;
  if (!underPressure && (!ttlMin || ttlMin <= 0)) return { enabled: false, ttlMin: 0, scanned: 0, reaped: [], skipped: 0 };

  const listLive = deps?.listLive ?? listSessionsRaw;
  const listStates = deps?.listStates ?? listAllSessionStates;
  const listManaged = deps?.listManaged ?? listManagedSessions;
  const reap = deps?.reap ?? reapCentralSession;
  const now = deps?.now ?? Date.now;

  const [live, states, managed] = await Promise.all([listLive(), listStates(), listManaged()]);
  const restorable = new Set(states.map((s) => s.id));                 // 불변식 ④ — 복원 가능한 세션만 회수
  const managedIds = new Set(managed.map((m) => m.session_id).filter((x): x is string => !!x)); // 불변식 ①
  const cutoffSec = Math.floor(now() / 1000) - effTtlMin * 60;   // 압박이면 완화 TTL(pressure_idle_minutes) 기준

  const reaped: string[] = [];
  // 이유별 카운트 — **왜 안 죽였나**가 없으면 진단이 불가능하다. 실측(2026-07-28): 고객사 A에서 F 를 켰는데 회수가
  //  0건이었고, 로그가 침묵해서(종전엔 reaped>0 일 때만 로그) 운영자도 우리도 tick 이 돌았는지조차 몰랐다.
  const reasons = { managed: 0, noState: 0, attached: 0, working: 0, recent: 0, failed: 0, target: 0 };
  let skipped = 0;
  // ── 1단계: 후보 선별(불변식) ── 회수는 정렬 뒤에 한다. 압박일 때 **무엇을 먼저 죽이냐**가 결과를 가르기 때문이다.
  const candidates: Array<{ id: string; idleSince: number }> = [];
  for (const s of live) {
    if (managedIds.has(s.id)) { skipped++; reasons.managed++; continue; }                 // ① managed
    if (!restorable.has(s.id)) { skipped++; reasons.noState++; continue; }                // ④ 복원 불가면 손대지 않음
    if (s.attached) { skipped++; reasons.attached++; continue; }                          // ② 누가 보는 중
    // ③ 작업/대기 중 — **접속 여부와 무관한 `working` 을 함께 본다.** agentState 는 attached==0 이면 busy 여도
    //  offline 이 되므로(탭=온라인 규칙), 그 값만 보면 **아무도 안 붙은 채 크론·빌드가 도는 세션이 '작업 중'으로
    //  안 잡혀** 회수된다(상민님 지적 2026-07-28). lastActive(⑤)는 폴링 타이밍에 따라 놓칠 수 있어 보호가 얇았다.
    //  #1221 — `awaiting`(접속 무관 '승인 대기')도 함께 본다. working 을 도입할 때 busy 만 구제하고 waiting 은
    //  남겨 둬서, **탭을 닫아 둔 채 승인 다이얼로그가 떠 있는 세션은 여전히 회수 대상**이었다(agentState 가
    //  offline 으로 덮이고 working=false). 그걸 죽이면 사람이 내리려던 결정이 통째로 사라진다.
    if (s.working || s.awaiting || s.agentState === "busy" || s.agentState === "waiting") { skipped++; reasons.working++; continue; }
    // ⑤ idle 판정 = **마지막 활동 시각** — 세 축의 최대값을 쓴다.
    //   · lastActive(@box_last_busy): AI 가 돈 시각. busy 관측 기반이라 **대화 대기 중엔 갱신되지 않고, 셸 세션엔 아예 없다.**
    //   · lastAttached(session_last_attached): 마지막으로 탭이 붙은 시각 = **사람이 보고 있었다는 신호.**
    //   · created: 활동 신호가 **하나도 없을 때만** 쓰는 폴백(생성은 활동이 아니다 — max 에 섞으면 갓 만든 세션의
    //     created 가 늘 최신이라 모든 세션이 영구 보존된다. 테스트 #2 가 이 실수를 즉시 잡았다).
    //  ⚠ lastAttached 를 빼면 **지금 보고 있던 세션이 회수된다** — 2026-07-28 실측 사고: VPN 이 끊겨 attached=0 이
    //   된 순간, 42분 전까지 열람 중이던 세션이 'lastActive 149시간 전' 으로 판정돼 회수됐다(그 세션은 대화만 하고
    //   있어서 busy 로 관측된 적이 오래됐다). attached 는 '지금 보는 중'만 말하고 '방금까지 보고 있었다'는
    //   lastAttached 에만 있다 — 네트워크가 잠깐 끊기는 것과 방치를 가르는 유일한 신호다.
    const lastSeen = Math.max(s.lastActive || 0, s.lastAttached || 0);  // 마지막 활동 = 작업 또는 열람
    const idleSince = lastSeen || s.created || 0;
    if (!idleSince || idleSince > cutoffSec) { skipped++; reasons.recent++; continue; }  //   TTL 미만 = 최근 → 보존
    candidates.push({ id: s.id, idleSince });
  }

  // ── 2단계: 순서 ── 평시엔 **오래 idle 인 것부터**(사용자 피해가 가장 적은 순). 압박이면 **RSS 큰 것부터** —
  //  #1220 의 교훈이 여기 있다: 회수로 실제 돌아오는 RAM 이 큰 것부터 걷어야 "죽여도 안 풀리는" 재현을 피한다.
  //  RSS 를 못 재는 환경(비-Linux·hidepid)에선 0 으로 떨어져 자연히 idle 순이 된다(측정 실패로 회수를 막지 않는다).
  let rss = new Map<string, number>();
  if (underPressure && candidates.length > 0) {
    try { rss = await loadRss(); } catch (e) { logger.warn({ err: e }, "session-reaper: 세션 RSS 측정 실패 — idle 순으로 회수"); }
  }
  candidates.sort((a, b) => (underPressure ? (rss.get(b.id) ?? 0) - (rss.get(a.id) ?? 0) : 0) || a.idleSince - b.idleSince);

  // ── 3단계: 회수 ── 압박이면 목표(사용률이 임계 밑)에 닿는 순간 멈춘다 — 필요한 만큼만 걷는다.
  //  ⚠ 판정은 회수한 세션들의 RSS 합(추정)으로 한다. 실측 재조회로 하면 `tmux kill-session` 은 SIGHUP 을 보내고
  //   바로 반환하므로 **아직 반환되지 않은 메모리**를 못 봐서 필요 이상 걷어낸다(회수는 되돌릴 수 없다 —
  //   과다 회수가 과소 회수보다 나쁘다). 측정 못 한 세션은 0 으로 기여해 목표 도달이 늦어질 뿐, 불변식은 유지된다.
  const totalMb = underPressure ? memTotal() : 0;
  let freedMb = 0;
  let reachedTarget = false;
  for (let i = 0; i < candidates.length; i++) {
    // 되찾은 만큼 사용률이 내려간다: usedPct' = usedPct - freed/total*100. 임계 밑이면 더 걷지 않는다.
    if (underPressure && totalMb > 0 && usedPct - (freedMb / totalMb) * 100 < pressurePct) {
      reachedTarget = true;
      skipped += candidates.length - i;      // 정렬돼 있으니 남은 후보는 볼 것 없다
      reasons.target += candidates.length - i;
      break;
    }
    const c = candidates[i];
    try {
      await reap(c.id);                                                // tmux 만 죽이고 desired-state 보존 → restorable
      reaped.push(c.id);
      freedMb += rss.get(c.id) ?? 0;
    } catch (e) {
      skipped++; reasons.failed++;
      logger.warn({ err: e, id: c.id }, "session-reaper: 회수 실패(계속)");
    }
  }
  // 정책이 켜져 있으면 **매 tick** 남긴다(회수 0건도) — 5분에 한 줄이고, 이 한 줄이 없으면 "왜 아무것도 안 죽었나"를
  //  박스에서 추측으로 파야 한다. noState 가 크면 백필(session-state-backfill)이 필요하다는 신호다.
  //  ⚠ 압박 회수는 **사후 추적이 특히 중요하다** — 사용자에겐 "세션이 사라졌다"로 보이므로, 무엇을 왜 걷었는지가
  //   로그에 없으면 #1220 이 고치려던 그 상황(earlyoom 이 죽였는데 아무도 몰라 '회수'로 오인)을 우리가 재현한다.
  //  '쟀다'의 기준 = 후보 중 **하나라도 양수 RSS 를 얻었나**. 맵이 비어 있지 않아도 값이 전부 0 이면 못 잰 것이다
  //  (hidepid 로 남의 uid /proc 를 못 읽는 격리 박스가 정확히 이 모양이 된다 — 이 기능이 노리는 바로 그 환경).
  const pressure: ReapPressure | undefined = underPressure
    ? { usedPct, thresholdPct: pressurePct, freedMb, reachedTarget, rssMeasured: candidates.some((c) => (rss.get(c.id) ?? 0) > 0) }
    : undefined;
  logger.info({ ttlMin: effTtlMin, scanned: live.length, reaped: reaped.length, skipped, skipReasons: reasons, pressure },
    underPressure
      ? "session-reaper tick(압박 회수 — RSS 큰 세션부터, desired-state 보존 → restorable)"
      : "session-reaper tick(idle 세션 회수 — desired-state 보존 → restorable)");
  return { enabled: true, ttlMin: effTtlMin, scanned: live.length, reaped, skipped, skipReasons: reasons, pressure };
}
