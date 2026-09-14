// 하네스 활동 보고(#1059·#1221)를 **그 세션의 호스트에 맡긴다** — 게이트웨이 tmux 호출 0 의 한 자리 (#2600 T2 d6).
//
//  ── 왜 ──
//  훅은 툴을 쓸 때마다(60초 스로틀) `POST …/active` 로 보고하고, 게이트웨이는 그때마다 그 세션 tmux 에 세 번 닿았다
//   (단계 읽기 · 단계 쓰기 · 활동 시각 쓰기). 매니지드에선 그 셋이 전부 중계 왕복이다(허브 → 노드 브로커 → exec).
//   2026-09-14 계수: 카나리아 `lively-46e3` 에 남은 게이트웨이 tmux 호출 22/분 중 10/분이 이 자리였다.
//  같은 tmux 를 그 세션의 호스트는 **자기 노드에서** 바로 만진다 — 멤버 PC 노드에 이미 쓰던 `markActive` op 그대로다.
//
//  ── 규율(d4 와 같다: 소유가 확인됐을 때만 맡기고, 모르면 종전) ──
//  · 맡길 호스트는 `registry.sessionHostFor` 한 곳이 고른다(자격·관측·op 지원 — 순수 판정 `self-node.sessionHostTarget`).
//  · 맡겼는데 실패하면 **게이트웨이가 직접** 새긴다 — 보고를 잃지 않는 쪽이다. 호스트가 이미 새긴 뒤 응답만 잃었어도
//    다시 새기는 것은 무해하다(같은 단계 재보고는 전이가 아니고, 활동 시각은 더 늦은 값으로 덮일 뿐이다).
//  · 활동 시각의 DB 미러(`last_busy` — 복원 카드 시간)는 **게이트웨이가** 쓴다. 호스트에는 DB 가 없다(#1791 ON_NODE).
//    쓰는 조건은 `markSessionActive` 와 같은 `isActivityProgress` 다 — 호스트가 돌려준 전이로 prev 를 되찾는다.
//  ⚠ 이 모듈은 게이트웨이 전용이다(registry 를 부른다). `phase.ts` 는 노드 번들에도 들어가므로 거기 두지 않는다.
import { logger } from "../log.js";
import { markSessionActive, isActivityProgress, type ReportedPhase, type SessionPhaseChange } from "./phase.js";
import { touchSessionBusy } from "../sessions/session-state.js";
import { sessionHostFor, nodeRpc } from "../node/registry.js";

/** 시험 seam — 기본값은 전부 프로덕션 경로다. */
export interface ActivityReportDeps {
  /** 이 세션을 맡을 호스트 — 없으면 null(종전 경로) */
  hostFor: (id: string) => string | null;
  /** 호스트에 `markActive` 를 맡긴다 */
  rpc: (host: string, args: { id: string; state: ReportedPhase | undefined }) => Promise<unknown>;
  /** 종전 경로 — 게이트웨이가 직접 새긴다 */
  local: (id: string, phase: ReportedPhase | undefined) => Promise<SessionPhaseChange | null>;
  /** 활동 시각 DB 미러 */
  touch: (id: string, sec: number) => Promise<void>;
  nowSec: () => number;
  warn: (o: Record<string, unknown>, msg: string) => void;
}

/**
 * 호스트 응답에서 전이를 꺼낸다 — 모양이 틀리면 null.
 *  구 번들은 `{ ok: true }` 만 돌려주고(#1842 이전), 실패는 문자열로 올 수 있다 — 그걸 전이로 읽으면 없는 알림이 나간다.
 */
export function relayedChange(r: unknown): SessionPhaseChange | null {
  const c = (r && typeof r === "object") ? (r as { change?: unknown }).change : undefined;
  if (!c || typeof c !== "object") return null;
  const { prev, phase, at } = c as Record<string, unknown>;
  if (typeof phase !== "string" || typeof at !== "number") return null;
  if (prev !== null && typeof prev !== "string") return null;
  return { prev: prev as ReportedPhase | null, phase: phase as ReportedPhase, at };
}

/**
 * 활동 보고 하나 — 전이(prev→phase)가 있으면 돌려준다(알림은 호출자가 정한다, `markSessionActive` 와 같은 계약).
 */
export async function reportSessionActivity(
  id: string, phase: ReportedPhase | undefined, deps: Partial<ActivityReportDeps> = {},
): Promise<SessionPhaseChange | null> {
  const hostFor = deps.hostFor ?? ((sid: string) => sessionHostFor(sid, "markActive"));
  const local = deps.local ?? markSessionActive;
  const host = hostFor(id);
  if (!host) return local(id, phase);

  const rpc = deps.rpc ?? ((h: string, args: { id: string; state: ReportedPhase | undefined }) => nodeRpc(h, "markActive", args));
  const warn = deps.warn ?? ((o: Record<string, unknown>, msg: string) => logger.warn(o, msg));
  let change: SessionPhaseChange | null;
  try {
    change = relayedChange(await rpc(host, { id, state: phase }));
  } catch (e) {
    warn({ err: e, id, host }, "활동 보고를 세션 호스트에 맡기지 못했다 — 게이트웨이가 직접 새긴다");
    return local(id, phase);
  }
  //  prev 되찾기: 전이가 있으면 그 prev, 없으면(같은 단계 재보고) 호스트가 본 단계가 지금 단계와 같았다는 뜻이다.
  if (isActivityProgress(phase, change ? change.prev : (phase ?? null))) {
    const touch = deps.touch ?? touchSessionBusy;
    const nowSec = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
    try { await touch(id, nowSec); } catch { /* 비치명 — 레코드 없음·DB 다운(markSessionActive 와 같다) */ }
  }
  return change;
}
