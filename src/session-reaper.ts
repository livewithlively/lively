// idle 세션 자동 회수(reaper) — #1059 F. 오래 idle 인 **중앙** 세션을 주기적으로 회수하되 desired-state 를 보존해
//  열 때 lazy resume(E) 되게 한다. admission control(동시 세션 하드 상한, 정당 세션까지 차단)을 기각하고 채택된 근본대책.
//
// 왜(#1059): 어니스트 박스 다운의 만성 축 = claude 세션 누적 baseline(~8GB). 이 reaper 가 baseline 을 억눌러 급성
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
import { logger } from "./log.js";
import { listSessionsRaw, reapCentralSession } from "./terminal-sessions.js";
import { listAllSessionStates } from "./org/session-state.js";
import { listManagedSessions } from "./org/managed-sessions.js";
import { getRuntimeConfig } from "./org/store.js";
import { effectiveSessionReclaimPolicy } from "./org/session-reclaim-policy.js";

export interface ReapResult { enabled: boolean; ttlMin: number; scanned: number; reaped: string[]; skipped: number; }

// 한 회수 tick — 정책(idle TTL)을 읽어 조건에 맞는 중앙 세션을 회수한다. 정책 0=끔이면 no-op.
//  주입 seam(loadPolicy·now)으로 단위테스트에서 결정 로직만 검증 가능(tmux·DB 없이). 실사용은 인자 없이.
export async function reapIdleSessions(deps?: {
  loadPolicy?: () => Promise<{ idle_ttl_minutes: number }>;
  listLive?: () => Promise<Awaited<ReturnType<typeof listSessionsRaw>>>;
  listStates?: () => Promise<Array<{ id: string }>>;
  listManaged?: () => Promise<Array<{ session_id: string | null }>>;
  reap?: (id: string) => Promise<void>;
  now?: () => number;
}): Promise<ReapResult> {
  const loadPolicy = deps?.loadPolicy ?? (() => getRuntimeConfig().then((c) => c.session_reclaim_policy));
  const policy = await effectiveSessionReclaimPolicy(loadPolicy);
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
  const cutoffSec = Math.floor(now() / 1000) - ttlMin * 60;

  const reaped: string[] = [];
  let skipped = 0;
  for (const s of live) {
    if (managedIds.has(s.id)) { skipped++; continue; }                 // ① managed
    if (!restorable.has(s.id)) { skipped++; continue; }                // ④ 복원 불가면 손대지 않음
    if (s.attached) { skipped++; continue; }                           // ② 누가 보는 중
    if (s.agentState === "busy" || s.agentState === "waiting") { skipped++; continue; } // ③ 작업/대기 중
    const idleSince = s.lastActive || s.created || 0;                  // ⑤ 마지막 작업(없으면 생성)
    if (!idleSince || idleSince > cutoffSec) { skipped++; continue; }  //   TTL 미만 = 최근 → 보존
    try {
      await reap(s.id);                                                // tmux 만 죽이고 desired-state 보존 → restorable
      reaped.push(s.id);
    } catch (e) {
      skipped++;
      logger.warn({ err: e, id: s.id }, "session-reaper: 회수 실패(계속)");
    }
  }
  if (reaped.length) logger.info({ ttlMin, reaped: reaped.length, skipped, scanned: live.length }, "session-reaper: idle 세션 회수(desired-state 보존 → restorable)");
  return { enabled: true, ttlMin, scanned: live.length, reaped, skipped };
}
