// 원격 PC(멤버 노드) 하네스 종료 규칙 (#5043) — 매니지드 하네스 종료 규칙(session-stop-rule.ts)을 구성원이 연결한 컴퓨터의 세션에도 적용한다.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────────────────────────
//  2026-10-27 맥미니 노드 실측: 이틀 넘게 논 하네스 세션 23개(최장 156시간) · 스왑 20.0/21GB. 매니지드는 «완료+안 봄 N분 · 질의+안 봄 M분» 으로
//   하네스를 끄지만 그 규칙은 세션 컨테이너 배포에서만 돌고(session-stop-rule.ts 범위), 옛 회수 시계도 노드 세션을 일부러 뺐다
//   (session-reaper.ts «범위 = 중앙 세션만»). 그래서 원격 PC 의 하네스는 사람이 닫기 전까지 영영 떠 있었다.
//
// ── 무엇을 다시 쓰나 ──────────────────────────────────────────────────────────────────────────────
//  판정(stopVerdict)과 집행(sweepSessionStopRule — 끄기 직전 화면 재확인 · 쪽지 · 한도 대기 · 작업 판정 · 한 판 상한)을 **그대로** 쓴다.
//   바꿔 끼우는 것은 부품뿐이다:
//   · 목록 = 그 컴퓨터가 올린 세션 스냅샷(node/registry.ts nodeSnapshotsInScope)
//   · 화면·키·작업 판정·한도 대기·안 본 결과 = 그 컴퓨터에 묻는다(node/stop-step.ts — 그 PC 의 tmux·프로세스·대화 파일로만 답할 수 있다)
//   · 보는 중 = 웹 화면 도장(session-presence) + 그 PC 터미널에서 사람이 직접 붙은 tmux 클라이언트
//   · 끄기 = 그 컴퓨터에 kill 을 릴레이하고 장부 행은 남긴다(보관 — 다시 열면 같은 대화로 이어진다 · reapNodeSession)
//  값은 컴퓨터별(org_node.stop_rule) → 비우면 워크스페이스 기본(session_reclaim_policy.node_stop_*) — node-stop-rule-policy.ts.
//   매니지드보다 넉넉하고(완료 30분 · 질의 180분) 상태 모름 안전망(24시간)이 하나 더 있다 — 원격 PC 엔 옛 회수 시계가 없어서다(StopMinutes 머리말).
//
// ── 범위 ────────────────────────────────────────────────────────────────────────────────────────
//  · 구성원 컴퓨터만 — 셀프 노드(게이트웨이 자신 · 같은 tmux)와 선언된 세션 호스트(매니지드 세션 컨테이너)는 중앙 규칙이 맡는다.
//  · 온라인 · 스냅샷이 신선 · `stopStep` 을 선언한 컴퓨터만. 윈도우(psmux)는 뺀다 — 색 캡처·클라이언트 목록의 표면이 다르다.
//  · **다시 열 수 없는 세션은 끄지 않는다**: 장부 행이 없거나 · 그 컴퓨터에서 직접 띄워 나중에 발견된 행(discovered — 복원 좌표가 없어
//    복원이 거절된다, session-state.ts) · 행의 노드가 이 컴퓨터가 아님 → 판정 재료에서 장부 행을 빼 «장부 행 없음» 으로 남긴다.
//  ⚠ 파괴적 갈래다(#2258) — 모르면 안 끈다: 그 PC 터미널 클라이언트를 못 가르면 그 컴퓨터를 이번 판에 통째로 건너뛴다.
import { logger } from "../log.js";
import { getRuntimeConfig } from "../org/store.js";
import { currentTenant, withTenant, type TenantContext } from "../org/tenant-context.js";
import { nodeSnapshotsInScope, nodeSupports, nodeRpc, NODE_STATE_STALE_MS, type NodeSnapshotFacts } from "../node/registry.js";
import { listNodes } from "../node/store.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import type { QuotaWait } from "../terminal/harness-io/quota-wait.js";
import { viewState, type ViewState } from "../terminal/session-presence.js";
import { sweepSessionStopRule, launchedAtMsOf, type StopRuleDeps, type StopRuleResult } from "./session-stop-rule.js";
import { effectiveSessionReclaimPolicy, normalizeSessionReclaimPolicy, type SessionReclaimPolicy } from "./session-reclaim-policy.js";
import { effectiveNodeStopRule, parseNodeStopRuleOverride, type NodeStopRuleEffective } from "./node-stop-rule-policy.js";
import { listAllSessionStates, markSessionEnded, revertSessionEnded, type SessionState } from "./session-state.js";
import { listManagedSessions } from "./managed-sessions.js";
import type { SessionEndInput } from "./session-end.js";

/** 컴퓨터를 이번 판에 건너뛴 이유. */
export type NodeSkipWhy =
  | "unregistered" | "disabled" | "off" | "self" | "session-host" | "offline" | "stale" | "platform" | "no-cap"
  | "no-sessions" | "viewers-unknown";

//  ⓘ 정비 주기(1분)의 정본은 outbox-request-sweep.ts NODE_STOP_RULE_SWEEP_MS 다 — 요청 정비표가 이 모듈을 정적으로 끌어오지 않게 그쪽에 둔다.
const ID_RE = /^box-[A-Za-z0-9._-]{1,120}$/;
const VIEWING: ViewState = { viewing: true, unknown: false, endedAtMs: 0 };

/**
 * (순수) 이 컴퓨터를 이번 판에 판정하나 — 건너뛸 이유, 판정하면 null. 위에서부터 먼저 걸리는 것이 답이다.
 *  등록이 없거나 꺼졌거나 규칙이 꺼진 컴퓨터부터 거른다(그 컴퓨터엔 RPC 를 하나도 안 보낸다).
 */
export function nodeStopEligibility(i: {
  snap: Pick<NodeSnapshotFacts, "online" | "stateAgeMs" | "declared" | "self">;
  row: { enabled: boolean; platform: string | null } | undefined;
  rule: Pick<NodeStopRuleEffective, "enabled">;
  supports: boolean;
  staleMs: number;
}): NodeSkipWhy | null {
  if (!i.row) return "unregistered";
  if (!i.row.enabled) return "disabled";
  if (!i.rule.enabled) return "off";
  if (i.snap.self) return "self";
  if (i.snap.declared) return "session-host";
  if (!i.snap.online) return "offline";
  if (!(i.snap.stateAgeMs <= i.staleMs)) return "stale";
  if (i.row.platform === "win32") return "platform";
  if (!i.supports) return "no-cap";
  return null;
}

/** (순수) `viewers` 걸음의 답 → 직접 붙은 클라이언트가 있는 세션. 모양이 틀리면 던진다(그 컴퓨터를 건너뛴다). */
export function localViewersOf(raw: unknown, asked: ReadonlySet<string>): Set<string> {
  const local = (raw as { local?: unknown } | null)?.local;
  if (!local || typeof local !== "object" || Array.isArray(local)) throw new Error("viewers 답의 모양이 틀렸다");
  const out = new Set<string>();
  for (const [id, n] of Object.entries(local as Record<string, unknown>)) if (asked.has(id) && typeof n === "number" && n > 0) out.add(id);
  return out;
}

/** (순수) `jobs` 걸음의 답 → 판정. 물은 세션만 받는다. 모양이 틀리면 던진다(그 판의 후보 전부가 «판정 불가» — session-stop-rule 이 안 끈다). */
export function jobVerdictsOf(raw: unknown, asked: ReadonlySet<string>): { jobs: Set<string>; unknown: Set<string> } {
  const r = raw as { jobs?: unknown; unknown?: unknown } | null;
  if (!r || !Array.isArray(r.jobs) || !Array.isArray(r.unknown)) throw new Error("jobs 답의 모양이 틀렸다");
  const pick = (xs: unknown[]): Set<string> => new Set(xs.filter((x): x is string => typeof x === "string" && asked.has(x)));
  return { jobs: pick(r.jobs), unknown: pick(r.unknown) };
}

/** (순수) `quota` 걸음의 답 → 한도 대기. null = 대기 없음. 모양이 틀리면 던진다(«판정 불가» — 이번 판엔 안 끈다). */
export function quotaWaitOf(raw: unknown): QuotaWait | null {
  if (raw === null || raw === undefined) return null;
  const r = raw as Partial<QuotaWait>;
  if ((r.kind !== "armed" && r.kind !== "resuming") || typeof r.atMs !== "number" || !Number.isFinite(r.atMs) || typeof r.text !== "string") {
    throw new Error("quota 답의 모양이 틀렸다");
  }
  const w: QuotaWait = { kind: r.kind, atMs: r.atMs, text: r.text.slice(0, 500) };
  if (typeof r.untilMs === "number" && Number.isFinite(r.untilMs)) w.untilMs = r.untilMs;
  return w;
}

/** 한 판의 결과 — CP 하우스키핑 틱이 그대로 찍는다. */
export interface NodeStopResult {
  enabled: boolean;
  why?: string;
  nodes: Array<{ id: string; skip?: NodeSkipWhy; rule?: { doneMin: number; askingMin: number; unknownMin: number }; result?: StopRuleResult }>;
  nextDueInSec?: number;
}

/** 시험 seam — 기본값은 전부 프로덕션 경로다. */
export interface NodeStopDeps {
  loadPolicy: () => Promise<SessionReclaimPolicy>;
  listNodeRows: () => Promise<Array<{ id: string; enabled: boolean; platform: string | null; stop_rule?: unknown }>>;
  snapshots: () => NodeSnapshotFacts[];
  supports: (nodeId: string) => boolean;
  /** 그 컴퓨터에 한 걸음을 묻는다(node/stop-step.ts) */
  step: (nodeId: string, args: Record<string, unknown>) => Promise<unknown>;
  listStates: () => Promise<SessionState[]>;
  listManaged: () => Promise<Array<{ session_id: string | null }>>;
  view: (id: string) => ViewState;
  reap: (nodeId: string, id: string, owner: string) => Promise<void>;
  /** 컴퓨터 하나를 판정·집행한다 — 기본은 매니지드와 같은 sweepSessionStopRule(부품만 바꿔 끼워 부른다) */
  sweep: (over: Partial<StopRuleDeps>) => Promise<StopRuleResult>;
  now: () => number;
  arm: (dueAtSec: number) => void;
  staleMs: number;
}

function defaultDeps(): NodeStopDeps {
  return {
    loadPolicy: () => effectiveSessionReclaimPolicy(async () => normalizeSessionReclaimPolicy((await getRuntimeConfig()).session_reclaim_policy)),
    listNodeRows: async () => (await listNodes()).map((n) => ({ id: n.id, enabled: n.enabled, platform: n.platform, stop_rule: n.stop_rule })),
    snapshots: () => nodeSnapshotsInScope(),
    supports: (nodeId) => nodeSupports(nodeId, "stopStep"),
    step: (nodeId, args) => nodeRpc(nodeId, "stopStep", args),
    listStates: () => listAllSessionStates(),
    listManaged: () => listManagedSessions(),
    view: (id) => viewState(id),
    reap: (nodeId, id, owner) => reapNodeSession(nodeId, id, owner),
    sweep: (over) => sweepSessionStopRule(over),
    now: () => Date.now(),
    arm: (dueAtSec) => armNodeStopTimer(dueAtSec),
    staleMs: NODE_STATE_STALE_MS,
  };
}

/** 테넌트마다 한 판씩만 — 요청 정비·CP 틱·마감 깨움이 겹쳐도 같은 컴퓨터에 같은 걸음을 두 번 묻지 않는다. */
const inFlight = new Set<string>();
const tenantKey = (): string => String(currentTenant()?.id ?? "");

/** 한 번에 묻는 세션 수 — 노드 걸음의 상한(node/stop-step.ts STOP_STEP_IDS_MAX)과 같다. 더 많으면 나눠 묻는다(무거운 컴퓨터일수록 빠지면 안 된다). */
const VIEWERS_CHUNK = 200;

/**
 * 이 세션들 중 그 PC 터미널에서 사람이 **지금** 직접 붙어 있는 것. 한 조각이라도 못 물으면 던진다(부르는 쪽이 «모름» 으로 다룬다 — 안 끈다).
 */
async function localViewersNow(d: NodeStopDeps, nodeId: string, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += VIEWERS_CHUNK) {
    const part = ids.slice(i, i + VIEWERS_CHUNK);
    for (const id of localViewersOf(await d.step(nodeId, { step: "viewers", ids: part }), new Set(part))) out.add(id);
  }
  return out;
}

/**
 * 이 테넌트의 원격 PC 를 한 판 판정·집행한다. **테넌트 컨텍스트 안에서** 부른다(요청 정비 · CP 하우스키핑 틱 · 셀프호스트 타이머 · 마감 깨움).
 *  컴퓨터 하나에서 난 실패(걸음 실패 · 끄기 실패)는 그 컴퓨터·그 세션에서 멈추고 다른 컴퓨터를 막지 않는다. 판 전체의 재료(정책 · 등록 · 장부)를
 *  못 읽으면 던진다 — 그 판은 아무것도 안 끈다(모르면 안 끈다).
 */
export async function sweepNodeStopRule(over: Partial<NodeStopDeps> = {}): Promise<NodeStopResult> {
  const d: NodeStopDeps = { ...defaultDeps(), ...over };
  //  노드가 없는 워크스페이스(대부분)는 DB 를 안 친다 — 스냅샷은 메모리에 있다.
  const snaps = d.snapshots();
  if (!snaps.length) return { enabled: false, why: "no-nodes", nodes: [] };
  const key = tenantKey();
  if (inFlight.has(key)) return { enabled: true, why: "in-flight", nodes: [] };
  inFlight.add(key);
  try {
    const [policy, rows] = await Promise.all([d.loadPolicy(), d.listNodeRows()]);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const out: NodeStopResult = { enabled: false, nodes: [] };
    let nextDue = Infinity;
    let shared: { states: SessionState[]; managed: Array<{ session_id: string | null }> } | null = null;
    for (const first of snaps) {
      //  앞 컴퓨터들의 판이 몇 초씩 걸린다 — 이 컴퓨터는 **지금의** 스냅샷으로 판정한다(판 시작에 읽은 것은 그만큼 낡았다 · 격리 리뷰).
      //   그새 목록에서 사라졌으면(지워짐) 끊긴 것으로 본다 — 옛 사진으로 걸음을 보내지 않는다.
      const snap = d.snapshots().find((x) => x.nodeId === first.nodeId) ?? { ...first, online: false };
      const row = rowById.get(snap.nodeId);
      const rule = effectiveNodeStopRule(policy, parseNodeStopRuleOverride(row?.stop_rule));
      if (rule.enabled && row?.enabled) out.enabled = true;
      const skip = nodeStopEligibility({ snap, row, rule, supports: d.supports(snap.nodeId), staleMs: d.staleMs });
      if (skip) { out.nodes.push({ id: snap.nodeId, skip }); continue; }
      const mins = { doneMin: rule.doneMin, askingMin: rule.askingMin, unknownMin: rule.unknownMin };
      const sessions = snap.sessions.filter((s) => ID_RE.test(s.id));
      if (!sessions.length) { out.nodes.push({ id: snap.nodeId, skip: "no-sessions", rule: mins }); continue; }
      const nodeId = snap.nodeId;
      //  ⓐ 그 PC 터미널에서 직접 붙은 클라이언트 — 못 가르면 이 컴퓨터는 이번 판에 아무것도 안 끈다(보는 중을 끄는 것이 첫째 금지).
      let local: Set<string>;
      try { local = await localViewersNow(d, nodeId, sessions.map((s) => s.id)); }
      catch (e) {
        logger.warn({ err: e, node: nodeId }, "원격 PC 하네스 종료 규칙: 직접 붙은 클라이언트를 못 가렸다 — 이 컴퓨터는 이번 판에 안 끈다");
        out.nodes.push({ id: nodeId, skip: "viewers-unknown", rule: mins });
        continue;
      }
      //  ⓑ 끄기(·질문 탭 넘기기) **직전에** 그 세션만 다시 묻는다 — ⓐ는 판 시작의 사진이라, 판이 도는 몇 초 사이 그 PC 터미널로 붙은 사람을 못 본다
      //   (session-stop-rule 의 마지막 확인은 웹 도장만 다시 읽는다 · 격리 리뷰 재현). 붙어 있거나 못 물으면 던진다 — 키는 안 보내고, 끄기는 «실패» 로
      //   세어 다음 판이 다시 본다.
      const stillAlone = async (id: string): Promise<void> => {
        if ((await localViewersNow(d, nodeId, [id])).has(id)) throw new Error("그 PC 터미널에서 방금 붙었다 — 끄지 않는다");
      };
      const sh = shared ??= { states: await d.listStates(), managed: await d.listManaged() };
      //  다시 열 수 있는 행만 판정 재료로 준다(머리말 «범위») — 나머지는 «장부 행 없음» 으로 남는다. 끄기는 장부의 주인 이름으로 보내므로
      //   주인을 모르거나 그 컴퓨터가 보고한 주인과 장부가 어긋난 행도 뺀다(쪽지를 적고 매 판 끄기에 실패하지 않게 — 판정 단계에서 남긴다).
      const snapOwner = new Map(sessions.map((s) => [s.id, s.owner || ""]));
      const states = sh.states.filter((st) => st.node_id === nodeId && !st.discovered && !!st.owner
        && (!snapOwner.get(st.id) || snapOwner.get(st.id) === st.owner));
      const stateById = new Map(states.map((st) => [st.id, st]));
      const result = await d.sweep({
        enabled: () => true,
        scopeKey: () => `${key}\u0000node:${nodeId}`,
        loadPolicy: async () => ({}),            // 분은 아래 minutesOf 가 준다(정책은 위에서 한 번 읽었다)
        minutesOf: () => mins,
        listLive: async () => sessions,
        listStates: async () => states,
        listManaged: async () => sh.managed,
        view: (id) => (local.has(id) ? VIEWING : d.view(id)),
        jobVerdicts: async (ids) => jobVerdictsOf(await d.step(nodeId, { step: "jobs", ids: [...ids] }), ids),
        capture: async (id) => {
          const v = await d.step(nodeId, { step: "capture", id });
          if (typeof v !== "string") throw new Error("capture 답이 글이 아니다");
          return v;
        },
        //  대화 파일은 훅이 보고한 경로를 먼저 본다(게이트웨이 resolveTranscript 와 같은 순서 — 규약 경로만 보면 심링크·긴 경로에서 놓쳐 «대기 없음» 이 된다).
        quotaWait: async (s: SessionInfo, nowMs: number) => {
          const st = stateById.get(s.id);
          return quotaWaitOf(await d.step(nodeId, {
            step: "quota", id: s.id, threadId: st?.claude_session_id || "", reportedPath: st?.transcript_path || "", launchedAtMs: launchedAtMsOf(s), nowMs,
          }));
        },
        keys: async (id, k) => { await stillAlone(id); await d.step(nodeId, { step: "keys", id, key: k }); },
        reap: async (id) => {
          const owner = stateById.get(id)?.owner;
          if (!owner) throw new Error("세션 주인을 모른다 — 그 컴퓨터에 끄기를 보낼 수 없다");   // 위 거르기 뒤라 오지 않는다(방어)
          await stillAlone(id);
          await d.reap(nodeId, id, owner);
        },
        arm: (dueAtSec) => { nextDue = Math.min(nextDue, dueAtSec); },
        logCtx: { node: nodeId },
      });
      out.nodes.push({ id: nodeId, rule: mins, result });
    }
    if (Number.isFinite(nextDue)) {
      out.nextDueInSec = Math.max(0, nextDue - Math.floor(d.now() / 1000));
      d.arm(nextDue);
    }
    return out;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * 5분 하우스키핑 틱의 판을 워크스페이스당 한 줄로 남긴다(«왜 안 껐나» — 컴퓨터별 건너뛴 이유 · 판정 분포). 컴퓨터가 없거나 다른 판이 돌던 중이면 안 찍는다.
 *  끈 판은 sweepSessionStopRule 이 컴퓨터 id 와 함께 따로 남긴다.
 */
export function logNodeStopRuleTick(
  r: NodeStopResult,
  log: (o: Record<string, unknown>) => void = (o) => logger.info(o, "원격 PC 하네스 종료 규칙 틱(#5043)"),
): void {
  if (!r.nodes.length) return;
  log({
    tenant: currentTenant()?.slug ?? null,
    nodes: r.nodes.map((n) => n.result
      ? { id: n.id, scanned: n.result.scanned, stopped: n.result.stopped.length, kept: n.result.kept, keptOldest: n.result.keptOldest }
      : { id: n.id, skip: n.skip }),
    nextDueInSec: r.nextDueInSec,
  });
}

// ── 끄기(보관) ─────────────────────────────────────────────────────────────────────────────────────

/** 시험 seam. */
export interface NodeReapDeps {
  /** 안 본 결과가 남았나(그 컴퓨터의 tmux 메타) — 못 물으면 undefined */
  seen: (nodeId: string, id: string) => Promise<boolean | undefined>;
  gone: (nodeId: string, id: string) => Promise<boolean | null>;
  kill: (nodeId: string, id: string, owner: string) => Promise<void>;
  markEnded: (id: string, e: SessionEndInput, atSec: number) => Promise<boolean>;
  revertEnded: (id: string, why: string, atSec: number) => Promise<boolean>;
  revokeTokens: (id: string) => Promise<unknown>;
  now: () => number;
}

/** 끄기 앞의 보조 작업(봤나 재기 · 사유 기록)이 끄기를 붙들지 않게 하는 상한 — sessions.ts reapCentralSession 과 같은 값. */
const END_PREP_MS = 3_000;
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

function defaultReapDeps(): NodeReapDeps {
  return {
    seen: async (nodeId, id) => {
      const v = await nodeRpc(nodeId, "stopStep", { step: "seen", id });
      return typeof v === "boolean" ? v : undefined;
    },
    gone: (nodeId, id) => nodeRpc<boolean>(nodeId, "gone", { id }),
    kill: async (nodeId, id, owner) => {
      const { relayNodeOp } = await import("../terminal/session-launch.js");
      await relayNodeOp(nodeId, "kill", { user: { userId: owner }, id });
    },
    markEnded: (id, e, atSec) => markSessionEnded(id, e, {}, atSec),
    revertEnded: (id, why, atSec) => revertSessionEnded(id, why, atSec),
    revokeTokens: async (id) => (await import("../terminal/profiles.js")).revokeSessionHookToken(id),
    now: () => Date.now(),
  };
}

/**
 * 원격 PC 세션을 **보관**으로 끈다 — 그 컴퓨터의 tmux 만 내리고 장부 행(좌표·대화 id)은 남긴다(다시 열면 같은 대화로 이어진다).
 *  순서와 사유는 시스템 끄기의 공용 문(sessions.ts reapCentralSession · #4783 — 끄기 **전에** 사유를 적고, 끄기가 실패하면 되돌린다)을 따른다.
 *  (사람이 누르는 보관 — DELETE …?reclaim=1 의 노드 갈래, terminal/routes.ts — 은 끈 뒤에 적는다. 여기는 그 순서가 아니다.)
 *   ① 사유를 먼저 적는다(안 본 결과가 남았는지 함께) → ② 그 컴퓨터에 «그 세션 있나» 를 묻고 있으면 kill 을 릴레이한다(kill 이 실패하면 한 번 더 물어
 *   정말 없을 때만 성공으로 친다 — 모르는 것을 성공으로 접지 않는다) → 실패면 ①을 되돌린다 → ③ 실어 준 훅·MCP 자격을 거둔다(복원은 새로 굽는다).
 */
export async function reapNodeSession(nodeId: string, id: string, owner: string, over: Partial<NodeReapDeps> = {}): Promise<void> {
  const d: NodeReapDeps = { ...defaultReapDeps(), ...over };
  const seen = await within(d.seen(nodeId, id), END_PREP_MS, undefined);
  const at = Math.floor(d.now() / 1000);
  const end: SessionEndInput = { why: "reclaim", ...(seen !== undefined ? { seen } : {}) };
  const wrote = await within(d.markEnded(id, end, at), END_PREP_MS, false);
  try {
    const gone = await d.gone(nodeId, id).catch(() => null);
    if (gone !== true) {
      try { await d.kill(nodeId, id, owner); }
      catch (e) {
        const goneNow = await d.gone(nodeId, id).catch(() => null);
        if (goneNow !== true) throw e;
      }
    }
  } catch (e) {
    if (wrote) await d.revertEnded(id, end.why, at).catch(() => false);
    throw e;
  }
  await Promise.resolve(d.revokeTokens(id)).catch((e) => logger.warn({ err: e, id, node: nodeId }, "원격 PC 하네스 종료 규칙: 훅·MCP 자격 회수 실패(비치명)"));
}

// ── 마감 깨움 ─────────────────────────────────────────────────────────────────────────────────────
//  요청 정비(1분)·CP 틱(5분)은 그 테넌트에 요청이 와야 돈다. 한 판이 «다음 마감» 을 알면 그 시각에 다시 판정하도록 깨움 하나를 건다(session-stop-rule.ts
//   armStopTimer 와 같은 꼴 — 자리만 따로다: 두 규칙의 깨움이 서로를 갈아 끼우지 않게).
const timers = new Map<string, { atMs: number; t: NodeJS.Timeout }>();
const ARM_MIN_MS = 5_000;
const ARM_MAX_MS = 10 * 60_000;
const ARM_SLACK_MS = 2_000;

export function armNodeStopTimer(dueAtSec: number, now = Date.now()): void {
  const tenant: TenantContext | null = currentTenant() ?? null;
  const k = String(tenant?.id ?? "");
  const atMs = dueAtSec * 1000 + ARM_SLACK_MS;
  const prev = timers.get(k);
  if (prev && prev.atMs <= atMs && prev.atMs > now) return;   // 더 이른 깨움이 이미 걸려 있다
  if (prev) clearTimeout(prev.t);
  const delay = Math.min(ARM_MAX_MS, Math.max(ARM_MIN_MS, atMs - now));
  const t = setTimeout(() => {
    timers.delete(k);
    const run = (): Promise<unknown> => sweepNodeStopRule();
    void (tenant ? withTenant(tenant, run) : run())
      .catch((err) => logger.warn({ err, tenant: tenant?.slug }, "원격 PC 하네스 종료 규칙: 마감 깨움 판정 실패(다음 요청·틱이 다시)"));
  }, delay);
  t.unref?.();
  timers.set(k, { atMs: now + delay, t });
}

/** 시험용 — 깨움과 진행 중 표시를 비운다. */
export function resetNodeStopRule(): void {
  for (const { t } of timers.values()) clearTimeout(t);
  timers.clear();
  inFlight.clear();
}
