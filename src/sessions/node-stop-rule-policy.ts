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

/**
 * (순수) 규칙이 켜졌는데 이 컴퓨터는 판정하지 않는 까닭 — 화면에 «켬» 대신 보여 줄 사람의 말. 판정 대상이거나 규칙이 꺼졌으면 null.
 *  정비의 건너뛰기(node-stop-rule.ts nodeStopEligibility) 중 **오래가는** 이유만 말한다 — 오프라인·낡은 스냅샷 같은 잠깐의 상태는 말하지 않는다
 *  (다시 붙으면 돈다). 옛 연결 프로그램(걸음 미선언)은 붙어 있을 때만 안다 — 끊긴 컴퓨터의 선언은 모른다.
 */
export function nodeStopRuleNote(i: {
  ruleEnabled: boolean; platform: string | null; self: boolean; sessionHost: boolean; online: boolean; supportsStep: boolean;
}): string | null {
  if (!i.ruleEnabled) return null;
  if (i.self) return "중앙 컴퓨터 자신과 같은 자리라 적용하지 않습니다 — 그 세션은 중앙 컴퓨터의 규칙을 따릅니다.";
  if (i.sessionHost) return "중앙 세션을 맡은 컴퓨터라 적용하지 않습니다 — 그 세션은 중앙 컴퓨터의 규칙을 따릅니다.";
  if (i.platform === "win32") return "윈도우 컴퓨터는 아직 지원하지 않아 세션을 끄지 않습니다.";
  if (i.online && !i.supportsStep) return "이 컴퓨터의 라이블리 연결 프로그램이 옛 버전이라 아직 적용되지 않습니다 — 다시 연결되면 새 버전을 받아 적용됩니다.";
  return null;
}
