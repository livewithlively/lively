// 원격 PC(멤버 노드) 하네스 종료 규칙의 **유효값** (#5043) — 워크스페이스 기본값(session_reclaim_policy.node_stop_*) 위에
//  컴퓨터별 값(org_node.stop_rule)을 얹는다.
//
//  ⚠ 순수 모듈이다(DB·tmux 무접촉). 컴퓨터 화면(node/routes.ts — 사람에게 보여 줄 값)과 정비(sessions/node-stop-rule.ts —
//   실제로 끄는 값)가 **같은 함수**를 쓴다. 두 벌이면 화면에 적힌 분과 실제로 끄는 분이 갈린다.
//
//  컴퓨터별 값의 뜻: 칸마다 «비움(null·없음) = 워크스페이스 기본값을 따른다». 그래서 관리자가 기본값을 바꾸면 비워 둔 컴퓨터는
//   함께 따라가고, 직접 정한 컴퓨터는 그대로다.
import { RECLAIM_TTL_MIN_MAX, RECLAIM_TTL_MIN_MIN, type SessionReclaimPolicy } from "./session-reclaim-policy.js";

/** org_node.stop_rule 에 저장하는 모양. 칸이 없거나 null 이면 그 칸은 워크스페이스 기본값. */
export interface NodeStopRuleOverride {
  enabled?: boolean | null;
  done_minutes?: number | null;
  asking_minutes?: number | null;
  unknown_minutes?: number | null;
}

/** 이 컴퓨터에 실제로 적용되는 값과 각 값의 출처. */
export interface NodeStopRuleEffective {
  enabled: boolean;
  doneMin: number;
  askingMin: number;
  unknownMin: number;
  source: { enabled: NodeStopRuleSource; done: NodeStopRuleSource; asking: NodeStopRuleSource; unknown: NodeStopRuleSource };
}
export type NodeStopRuleSource = "node" | "workspace";

type WorkspaceNodeStop = Pick<SessionReclaimPolicy,
  "node_stop_enabled" | "node_stop_done_minutes" | "node_stop_asking_minutes" | "node_stop_unknown_minutes">;

const MINUTE_KEYS = ["done_minutes", "asking_minutes", "unknown_minutes"] as const;

/** 분 값 하나 — 정수 0~43200 이면 그 값, 아니면 undefined(«이 칸 없음»). DB 의 깨진 값이 판정에 새지 않게 읽을 때도 거른다. */
function minuteOf(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  return v >= RECLAIM_TTL_MIN_MIN && v <= RECLAIM_TTL_MIN_MAX ? v : undefined;
}

/**
 * DB 값(JSONB) → 컴퓨터별 값. 모양이 틀린 칸은 버린다(그 칸은 기본값을 따르게 된다 — 손으로 넣은 값·깨진 행이 끄는 시각을 흔들지 않게).
 *  남는 칸이 없으면 null.
 */
export function parseNodeStopRuleOverride(raw: unknown): NodeStopRuleOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: NodeStopRuleOverride = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  for (const k of MINUTE_KEYS) {
    const m = minuteOf(r[k]);
    if (m !== undefined) out[k] = m;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 화면에서 온 변경(REST 본문)을 지금 값에 합친다. 칸이 **있으면** 그 값으로 바꾸고(null = 기본값으로 되돌림), **없으면** 지금 값을 둔다.
 *  잘못된 값은 조용히 버리지 않고 사람의 말로 거절한다 — «저장됐다» 고 믿었는데 기본값이 도는 일이 없게.
 *  @returns 합친 결과(남는 칸이 없으면 null = 이 컴퓨터는 전부 기본값을 따른다)
 */
export function mergeNodeStopRuleOverride(
  current: NodeStopRuleOverride | null, body: unknown,
): { ok: true; value: NodeStopRuleOverride | null } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "본문은 객체여야 합니다" };
  const b = body as Record<string, unknown>;
  const next: Record<string, unknown> = { ...(current ?? {}) };
  if ("enabled" in b) {
    if (b.enabled === null) delete next.enabled;
    else if (typeof b.enabled === "boolean") next.enabled = b.enabled;
    else return { ok: false, message: "enabled 는 true·false·null(기본값 따름) 중 하나여야 합니다" };
  }
  for (const k of MINUTE_KEYS) {
    if (!(k in b)) continue;
    const v = b[k];
    if (v === null) { delete next[k]; continue; }
    const m = typeof v === "number" ? minuteOf(v) : undefined;
    if (m === undefined) return { ok: false, message: `${k} 는 ${RECLAIM_TTL_MIN_MIN}~${RECLAIM_TTL_MIN_MAX} 정수(분)이거나 null(기본값 따름)이어야 합니다 (0=그 상태는 끄지 않음)` };
    next[k] = m;
  }
  return { ok: true, value: parseNodeStopRuleOverride(next) };
}

/** 워크스페이스 기본값 + 컴퓨터별 값 → 이 컴퓨터에 적용되는 값. */
export function effectiveNodeStopRule(ws: WorkspaceNodeStop, o: NodeStopRuleOverride | null | undefined): NodeStopRuleEffective {
  const pick = (own: number | null | undefined, base: number): [number, NodeStopRuleSource] =>
    typeof own === "number" ? [own, "node"] : [base, "workspace"];
  const [enabled, sEnabled]: [boolean, NodeStopRuleSource] = typeof o?.enabled === "boolean" ? [o.enabled, "node"] : [!!ws.node_stop_enabled, "workspace"];
  const [doneMin, sDone] = pick(o?.done_minutes, ws.node_stop_done_minutes);
  const [askingMin, sAsking] = pick(o?.asking_minutes, ws.node_stop_asking_minutes);
  const [unknownMin, sUnknown] = pick(o?.unknown_minutes, ws.node_stop_unknown_minutes);
  return { enabled, doneMin, askingMin, unknownMin, source: { enabled: sEnabled, done: sDone, asking: sAsking, unknown: sUnknown } };
}
