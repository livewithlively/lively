// 도달 불가 세션 판정의 배선 (#4939 재설계 v2 — 판정 한 곳) — 판정은 순수 모듈 session-unreachable-rule.ts, 여기는 재료·손·기억.
//
//  정비 표(outbox-request-sweep `session-unreachable`)가 요청에 얹어 테넌트마다 부른다. 기억(DB 행 없는 세션의 표식 · 말한 것)은 테넌트별 메모리다 —
//   게이트웨이가 다시 뜨면 비고, 그러면 그 표식도 사라진다(장부가 «끝남» 을 안 싣는다 = 브로커가 안 걷는다 = 다음 판정까지 늦어질 뿐이다 —
//   뜬 지 1시간이 지나야 메모리 근거로 다시 적는다).
//  ⚠ on 전환 전제와 후속 아이디어(org_node_state.reported_at 확인)는 session-unreachable-rule.ts 머리말.
import { logger } from "../log.js";
import { currentTenant } from "../org/tenant-context.js";
import { sessionHostContainerViews } from "../node/registry.js";
import { getLastBusy } from "../terminal/tmux-exec.js";
import { listUnreachableRuleRows, markSessionUnreachable, reviveUnreachableSession } from "./session-state.js";
import { listManagedSessions } from "./managed-sessions.js";
import { JOB_SESSION_ID_RE } from "../agent-jobs/plan.js";   // 위탁 작업 컨테이너 — 제 수명 주인(#4490 작업 컨테이너 감시)이 있다
import { lostRuleModeOf, runUnreachableSweep, type LostRuleMode, type UnreachableSweepDeps } from "./session-unreachable-rule.js";

const tenantKey = (): string => String(currentTenant()?.id ?? "");
const marksByTenant = new Map<string, Map<string, number>>();
const saidByTenant = new Map<string, Map<string, string>>();
const inFlight = new Set<string>();

/**
 * 이 테넌트에서 이 규칙이 «끝남» 으로 적은 DB 행 없는 세션(id → 판정 시각 ms) — 상시 세션(DB 행이 없는 것이 설계 — #1059 E)과
 *  행 없는 세션(keep-alive 가 갈아 끼운 옛 상시 세션 등). 세션 장부가 «끝남» 행으로 싣는다.
 */
export function unreachableMemoryMarks(): ReadonlyMap<string, number> {
  return marksByTenant.get(tenantKey()) ?? new Map();
}

/** 시험용 — 테넌트별 기억을 비운다. */
export function resetUnreachableMemory(): void { marksByTenant.clear(); saidByTenant.clear(); inFlight.clear(); }

export interface UnreachableSweepResult {
  mode: LostRuleMode;
  why?: "in-flight";
  blind?: string | null;
  mark?: number;
  revive?: number;
  hold?: number;
  /** 컨테이너 관측 없이 온 상태 push 가 가장 오래 이어진 호스트의 연속 판 수(그림자 대조용 — 0 이 아니면 그 호스트는 판정 재료가 없다). */
  nullStreakMax?: number;
}

/** 이 테넌트 한 판 — 정비 표가 부른다. 스위치는 env `LIVELY_SESSION_LOST_RULE`(기본 shadow). */
export async function sweepSessionUnreachable(over: Partial<UnreachableSweepDeps> = {}): Promise<UnreachableSweepResult> {
  const mode = over.mode ?? lostRuleModeOf(process.env.LIVELY_SESSION_LOST_RULE);
  if (mode === "off") return { mode };
  const key = tenantKey();
  if (inFlight.has(key)) return { mode, why: "in-flight" };
  inFlight.add(key);
  try {
    let marks = marksByTenant.get(key);
    if (!marks) marksByTenant.set(key, (marks = new Map()));
    let said = saidByTenant.get(key);
    if (!said) saidByTenant.set(key, (said = new Map()));
    let nullStreakMax = 0;
    const hostsOf = over.hosts ?? (() => sessionHostContainerViews());
    const dec = await runUnreachableSweep({
      mode,
      nowMs: Date.now(),
      upMs: process.uptime() * 1000,
      rows: (missingIds) => listUnreachableRuleRows(missingIds),
      managed: async () => (await listManagedSessions()).map((m) => m.session_id).filter((x): x is string => !!x),
      ownedElsewhere: (id) => JOB_SESSION_ID_RE.test(id),
      lastBusyMem: (id) => getLastBusy(id),
      markRow: (id, sinceMs) => markSessionUnreachable(id, sinceMs),
      reviveRow: (id) => reviveUnreachableSession(id),
      marks,
      said,
      log: (level, obj, msg) => logger[level](obj, msg),
      tenant: currentTenant()?.slug ?? null,
      ...over,
      //  호스트 재료는 연속 null 판 수를 함께 센다 — 주입한 손이어도 같은 자로 잰다.
      hosts: () => { const v = hostsOf(); nullStreakMax = Math.max(0, ...v.map((h) => h.nullStreak ?? 0)); return v; },
    });
    return {
      mode, blind: dec?.blind ?? null, mark: dec?.mark.length ?? 0, revive: dec?.revive.length ?? 0, hold: dec?.hold.length ?? 0, nullStreakMax,
    };
  } finally {
    inFlight.delete(key);
  }
}
