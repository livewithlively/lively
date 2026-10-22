// 도달 불가 세션 판정의 배선 (#4939 재설계 v2 — 판정 한 곳) — 판정은 순수 모듈 session-unreachable-rule.ts, 여기는 재료·손·기억.
//
//  정비 표(outbox-request-sweep `session-unreachable`)가 요청에 얹어 테넌트마다 부른다. 기억(상시 세션 표식 · 말한 것)은 테넌트별 메모리다 —
//   게이트웨이가 다시 뜨면 비고, 그러면 상시 세션 표식도 사라진다(장부가 «끝남» 을 안 싣는다 = 브로커가 안 걷는다 = 다음 판정까지 늦어질 뿐이다).
import { logger } from "../log.js";
import { currentTenant } from "../org/tenant-context.js";
import { sessionHostContainerViews } from "../node/registry.js";
import { getLastBusy } from "../terminal/tmux-exec.js";
import { listUnreachableRuleRows, markSessionUnreachable, reviveUnreachableSession } from "./session-state.js";
import { listManagedSessions } from "./managed-sessions.js";
import { lostRuleModeOf, runUnreachableSweep, type LostRuleMode, type UnreachableSweepDeps } from "./session-unreachable-rule.js";

const tenantKey = (): string => String(currentTenant()?.id ?? "");
const marksByTenant = new Map<string, Map<string, number>>();
const saidByTenant = new Map<string, Map<string, string>>();
const inFlight = new Set<string>();

/** 이 테넌트에서 이 규칙이 «끝남» 으로 적은 상시 세션(id → 판정 시각 ms) — 세션 장부가 «끝남» 행으로 싣는다(DB 행이 없는 것이 설계 — #1059 E). */
export function unreachableManagedMarks(): ReadonlyMap<string, number> {
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
    const dec = await runUnreachableSweep({
      mode,
      nowMs: Date.now(),
      upMs: process.uptime() * 1000,
      hosts: () => sessionHostContainerViews(),
      rows: () => listUnreachableRuleRows(),
      managed: async () => (await listManagedSessions()).map((m) => m.session_id).filter((x): x is string => !!x),
      lastBusyMem: (id) => getLastBusy(id),
      markRow: (id, sinceMs) => markSessionUnreachable(id, sinceMs),
      reviveRow: (id) => reviveUnreachableSession(id),
      marks,
      said,
      log: (level, obj, msg) => logger[level](obj, msg),
      tenant: currentTenant()?.slug ?? null,
      ...over,
    });
    return { mode, blind: dec?.blind ?? null, mark: dec?.mark.length ?? 0, revive: dec?.revive.length ?? 0, hold: dec?.hold.length ?? 0 };
  } finally {
    inFlight.delete(key);
  }
}
