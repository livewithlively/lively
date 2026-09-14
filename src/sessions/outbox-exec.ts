// 아웃박스의 **실행 자리** — 한 걸음(보기·누르기·치기)을 그 세션의 호스트에 맡길까, 게이트웨이가 직접 할까 (#2600 T2 d6 · #3773 PR2).
//
// ── 왜 ──────────────────────────────────────────────────────────────────────────
// d6 완료 조건은 «그 테넌트 게이트웨이 tmux 0» 이다. 아웃박스(`session-outbox`)는 준비 판정의 폴마다 화면·포그라운드를 읽고(tmux 둘)
//  신뢰 대화상자 키와 send-keys 를 게이트웨이 tmux 로 쳤다. 같은 tmux 를 그 세션의 호스트는 자기 노드에서 바로 만진다 —
//  호스트 op `outboxStep`(PR1 · `terminal/outbox-host-step`)이 그 걸음을 실행하고 **얼마나 했나까지 값으로** 돌려준다.
//
// ── 판정은 게이트웨이, 실행만 호스트 ─────────────────────────────────────────────
// 입력창이 떴나(`firstPromptStep`)·«Yes» 까지 몇 칸인가(`trustAcceptDowns`)는 여전히 게이트웨이가 호스트가 준 화면으로 판정한다.
//  여기는 «어디서 실행하나» 와 «실패를 어떻게 접나» 만 정한다.
//
// ── 실패를 접는 규칙 — 읽기는 늘 폴백, 쓰기는 «안 보냈다» 가 확실할 때만 ──────────────
// 활동 보고(#935 `session-activity-relay`)는 실패하면 무조건 게이트웨이가 다시 새겼다 — 두 번 새겨도 무해하다.
//  치기는 다르다: 다시 치면 같은 지시가 두 번 간다.
//  · 보기 — RPC 오류(종류 무관)·거절·모양 틀림이면 게이트웨이가 본다.
//  · 누르기·치기 — `sent === false`(연결 없음·미지원·ws.send 예외 — `rpc-error.rpcMaybeSent`)이거나 호스트가 **거절**(tmux 0)했을 때만
//    같은 시도를 게이트웨이가 한다. 누르기가 «눌렀을 수 있다» 면 삼킨다 — 다음 폴이 화면으로 다시 판정한다.
//    치기가 «쳤을 수 있다» 면 **다시 치지 않는다** — 에코만 본다(`session-outbox.sendReadyRow`).
//  · 강등 — 한 행 안에서 호스트 걸음이 그렇게 한 번 실패하면 그 행의 나머지 걸음은 게이트웨이가 한다. 폴(500ms)마다 RPC 시간 초과(15초)를
//    다시 치르면 준비 창(20초)이 그걸로 찬다. 값으로 온 세션 상태(닿았나·멈춘 자리)는 호스트 고장이 아니라 강등하지 않는다. 다음 행은 다시 고른다.
//
// ── 호스트 고르기 ─────────────────────────────────────────────────────────────────
// `registry.sessionHostTargetFor(id, "outboxStep")` 한 곳이 고른다(계수 `session:<사유>`). 새 세션은 호스트의 상태 push(3초) 전까지
//  스냅샷에 좌표가 없어 `no-coordinate` 로 떨어진다 — 자가호스팅의 모든 세션과 같은 사유다. 그래서 **목록 소유가 넘어간 테넌트**
//  (`gatewayDefersHere()`)일 때만 tmux 없이 잠깐(HOST_WAIT_CAP_MS) 기다렸다 다시 고른다. 소유 판정은 행당 한 번만 묻는다 —
//  폴마다 물으면 그 판정 계수 창이 아웃박스 기록으로 찬다.
//
// ⚠ 노드 번들: 이 모듈은 `session-outbox` 를 따라 노드 에이전트 번들에 실린다(`terminal/sessions` → `session-outbox` 는 부채 간선).
//  그래서 registry 를 import 하지 않는다 — import 하는 순간 노드 연결·스냅샷·노드 스토어 모듈 12개가 번들에 들어온다(실측). 호스트 재료는
//  게이트웨이가 부팅 때 꽂는 능력(`gateway-capabilities` 의 `outboxHost`)으로 받는다. DB 표면도 없다. 노드에서는 아웃박스가 돌지 않는다.
import { logger } from "../log.js";
import { rpcMaybeSent } from "../node/rpc-error.js";
import type { NodeOp } from "../node/protocol.js";
import type { SessionHostTargetWhy } from "../node/self-node.js";
import { tmux, isSessionGoneError } from "../terminal/tmux-exec.js";
import { sendKeysToSession, SendKeysNotStarted } from "../terminal/send-keys.js";
import { TMUX_TRUST_KEYS, type TrustKeys } from "../terminal/session-first-prompt.js";
import { OUTBOX_KEYS_MAX_DOWN, type PeekOutcome, type KeysOutcome, type TypeOutcome, type Reach } from "../terminal/outbox-host-step.js";
import { gatewayCapability } from "./gateway-capabilities.js";

/** 새 세션의 좌표를 기다리는 상한 — 호스트의 상태 push 주기(3초 · `node/agent` 의 STATE_PUSH_MS) + 여유 1초. 닿으면 게이트웨이가 한다. */
export const HOST_WAIT_CAP_MS = 4_000;
/** 기다리는 동안 다시 고르는 간격 — 고르기는 메모리 조회뿐이지만 한 번마다 판정 계수에 한 칸이 남는다(한 행에 최대 8칸). */
export const HOST_WAIT_POLL_MS = 500;

// ── 순수 판정 ────────────────────────────────────────────────────────────────────

/**
 * tmux 호출이 던졌다 — 이 세션은 **죽은 것인가, 못 닿는 것인가**(#2154 ②).
 *
 *  종전 코드는 `catch { return "gone" }` 였다. 그래서 노드 채널이 순간 빈 503(파킹 소켓 좀비) 하나, 중계
 *  타임아웃 하나로 그 세션의 대기 지시가 전부 버려졌다. 판정의 정본은 #835 의 isSessionGoneError 다 —
 *  tmux 가 **응답해서** "그런 세션 없음"이라고 말했거나(중계면 tmux 서버 증발까지) 그때만 gone 이다.
 *  #3773 — 게이트웨이가 직접 치는 칸(아래 `LOCAL_STEPS`)만 쓴다. 호스트 걸음의 닿았나는 호스트가 판정해 값(`reach`)으로 준다.
 */
export function readyVerdictOnError(err: unknown): "gone" | "unknown" {
  return isSessionGoneError(err) ? "gone" : "unknown";
}

/** 호스트 답을 못 읽었다 — `unsupported` 는 호스트가 거절했다(tmux 0), `malformed` 는 모양이 틀렸다(무엇을 했는지 모른다). */
export type StepFault = { fault: "unsupported" | "malformed" };

const isReach = (v: unknown): v is Reach => v === "gone" || v === "unknown";

/**
 * 호스트 답을 걸음별 모양으로 읽는다(순수) — 거절이면 `unsupported`, 모양이 틀리면 `malformed`.
 *  ⚠ `{ ok: true }` 뿐인 답은 누르기에서만 성공이다. 보기는 화면이 없고 치기는 얼마나 쳤는지(`typed`)가 없다 — 둘 다 `malformed` 로 두어
 *   부른 쪽이 안전 쪽으로 접게 한다(보기는 게이트웨이가 다시 본다 · 치기는 «쳤을 수 있다»).
 */
export function decodeStep(step: "peek", r: unknown): PeekOutcome | StepFault;
export function decodeStep(step: "keys", r: unknown): KeysOutcome | StepFault;
export function decodeStep(step: "type", r: unknown): TypeOutcome | StepFault;
export function decodeStep(step: "peek" | "keys" | "type", r: unknown): PeekOutcome | KeysOutcome | TypeOutcome | StepFault {
  if (!r || typeof r !== "object") return { fault: "malformed" };
  const o = r as Record<string, unknown>;
  if (o.ok === false && o.unsupported === true) return { fault: "unsupported" };
  if (step === "peek") {
    if (o.ok === true && typeof o.pane === "string" && typeof o.paneCmd === "string") return { ok: true, pane: o.pane, paneCmd: o.paneCmd };
    if (o.ok === false && isReach(o.reach)) return { ok: false, reach: o.reach };
    return { fault: "malformed" };
  }
  if (step === "keys") {
    if (o.ok === true) return { ok: true };
    if (o.ok === false && o.at === "check" && isReach(o.reach)) return { ok: false, at: "check", reach: o.reach };
    if (o.ok === false && (o.at === "down" || o.at === "enter")) return { ok: false, at: o.at };
    return { fault: "malformed" };
  }
  if (o.ok === true && o.typed === "full") return { ok: true, typed: "full" };
  if (o.ok === false && o.typed === "none" && isReach(o.reach)) return { ok: false, typed: "none", reach: o.reach };
  if (o.ok === false && o.typed === "partial" && (o.at === "text" || o.at === "enter")) return { ok: false, typed: "partial", at: o.at };
  return { fault: "malformed" };
}

/** 치기 뒤 할 일 — echo(다 쳤다) · echo-only(쳤는지 모른다) · local(안 보냈다 — 게이트웨이가 친다) · stall(한 글자도 안 갔다) · fail(치다 멈췄다). */
export type TypeNext = "echo" | "echo-only" | "local" | "stall:gone" | "stall:unknown" | "fail:text" | "fail:enter";

/**
 * 치기 결과 → 할 일(순수). **다시 쳐도 되는 것은 «안 갔다» 가 확실할 때뿐이다** — RPC 가 `sent === false` 거나 호스트가 거절했을 때.
 *  그 밖의 RPC 오류(시간 초과·응답 전 끊김·원격 오류·표식 없음)와 모양 틀린 답은 «쳤을 수 있다» 다.
 */
export function typeNext(r: TypeOutcome | StepFault | { rpcError: unknown }): TypeNext {
  if ("rpcError" in r) return rpcMaybeSent(r.rpcError) ? "echo-only" : "local";
  if ("fault" in r) return r.fault === "unsupported" ? "local" : "echo-only";
  if (r.ok) return "echo";
  return r.typed === "none" ? (`stall:${r.reach}` as const) : (`fail:${r.at}` as const);
}

/**
 * 호스트를 고른 이 순간 — 맡기나(go) · 기다리나(wait) · 게이트웨이가 하나(local) (순수).
 *  기다리는 것은 `no-coordinate` ∧ 소유가 넘어간 테넌트 ∧ cap 전 **하나뿐**이다. 새 세션의 3초 창이 그 사유로 보이기 때문이고,
 *  같은 사유인 자가호스팅(소유가 안 넘어감)은 기다리면 첫 지시만 늦어진다. 나머지 사유는 기다려도 바뀔 까닭이 없다.
 *  ⚠ 경계: 기다린 시간이 cap 과 **같으면** 더 기다리지 않는다.
 */
export function hostWait(o: { why: SessionHostTargetWhy; defers: boolean; waitedMs: number; capMs: number }): "go" | "wait" | "local" {
  if (o.why === "ok") return "go";
  if (o.why === "no-coordinate" && o.defers && o.waitedMs < o.capMs) return "wait";
  return "local";
}

// ── 실행 자리 ────────────────────────────────────────────────────────────────────

/** 준비 판정 한 폴에 볼 화면 — 못 봤으면 닿았나(`gone` 은 확답일 때뿐, #835). */
export type PaneSeen = { ok: true; pane: string; paneCmd: string } | { ok: false; verdict: Reach };

/** 치기 뒤 배달자가 할 일(`session-outbox.sendReadyRow` 머리말). */
export type TypeResult =
  | { next: "echo" }
  | { next: "echo-only" }
  | { next: "stall"; verdict: Reach }
  | { next: "fail"; error: string };

/** 한 행의 실행 자리 — `outboxExecFor` 가 행마다 하나 만든다. */
export interface OutboxExec {
  /** 이 행을 맡은 세션 호스트 — null 이면 게이트웨이가 직접 한다 */
  readonly host: string | null;
  /** 고른 사유 — `no-port` 는 게이트웨이 능력(`outboxHost`)이 안 꽂혔다 */
  readonly why: SessionHostTargetWhy | "no-port";
  /** 고르기까지 기다린 시간(ms) */
  readonly waitedMs: number;
  /** 화면 한 번 */
  peek(): Promise<PaneSeen>;
  /** `acceptTrustDialog` 에 줄 키 — 부를 때마다 새로 받는다 */
  trustKeys(): TrustKeys;
  /** 친다 */
  type(text: string): Promise<TypeResult>;
  /** 미제출 방어 Enter — 실패는 삼킨다(다음 에코 창이 판정한다) */
  enter(): Promise<void>;
}

/** 게이트웨이가 직접 하는 칸 — 종전 배달 루프의 경로 그대로다. */
export interface LocalSteps {
  peek: (id: string) => Promise<PaneSeen>;
  keys: TrustKeys;
  type: (id: string, text: string) => Promise<TypeResult>;
}

/** 시험 seam — 기본값은 전부 프로덕션 경로다(게이트웨이 능력 · 게이트웨이 tmux · 실제 대기·시계). */
export interface OutboxExecDeps {
  /** 호스트 고르기(사유 포함) — null 이면 고를 재료가 없다(능력 미등록) */
  hostPick: (sessionId: string, op: NodeOp) => { host: string | null; why: SessionHostTargetWhy } | null;
  rpc: (host: string, op: NodeOp, args: Record<string, unknown>) => Promise<unknown>;
  /** 이 테넌트의 목록 소유가 세션 호스트로 넘어갔나(`registry.gatewayDefersHere`) */
  defersHere: () => boolean;
  local: LocalSteps;
  warn: (o: Record<string, unknown>, msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** 게이트웨이 tmux 로 한 번 본다(종전 `waitReady` 의 두 읽기). */
async function localPeek(id: string): Promise<PaneSeen> {
  try {
    const [pane, paneCmd] = await Promise.all([
      tmux(["capture-pane", "-t", id, "-p"]),
      tmux(["display-message", "-p", "-t", id, "#{pane_current_command}"]).then((s) => s.trim()),
    ]);
    return { ok: true, pane, paneCmd };
  } catch (e) {
    return { ok: false, verdict: readyVerdictOnError(e) };
  }
}

/** 게이트웨이 tmux 로 친다(종전 배달 루프의 send-keys). */
async function localType(id: string, text: string): Promise<TypeResult> {
  try {
    await sendKeysToSession(id, text);
    return { next: "echo" };
  } catch (e) {
    // ⚠ **글자를 싣기 전에** 죽은 경우(SendKeysNotStarted = has-session 실패)만 되돌릴 수 있다 — 한 글자도
    //  안 갔으니 중복 위험이 없다. 실측 2026-08-27: 진짜 유실 5건 중 하나가 정확히 여기였다(`send:
    //  … has-session … node channel unavailable` → failed). 순간 장애 하나로 사람의 지시를 버리지 않는다.
    //  글자를 싣기 시작한 뒤의 실패는 종전대로 failed — 입력칸에 반쪽이 남아 있을 수 있다.
    if (e instanceof SendKeysNotStarted) return { next: "stall", verdict: readyVerdictOnError(e.cause) };
    return { next: "fail", error: `send: ${(e as Error)?.message ?? e}`.slice(0, 300) };
  }
}

/** 게이트웨이 칸의 기본 — 신뢰 대화상자 키는 첫 지시와 같은 키다(`session-first-prompt` 의 TMUX_TRUST_KEYS). */
export const LOCAL_STEPS: LocalSteps = { peek: localPeek, keys: TMUX_TRUST_KEYS, type: localType };

/**
 * 이 행의 실행 자리를 고른다 — 세션 호스트면 호스트, 아니면 게이트웨이. **행마다 한 번** 부른다.
 *  새 세션의 좌표 공백(`no-coordinate`)은 소유가 넘어간 테넌트일 때만 tmux 없이 기다렸다 다시 고른다(`hostWait`).
 */
export async function outboxExecFor(sessionId: string, deps: Partial<OutboxExecDeps> = {}): Promise<OutboxExec> {
  const d: OutboxExecDeps = {
    hostPick: deps.hostPick ?? ((id, op) => gatewayCapability("outboxHost")?.pick(id, op) ?? null),
    rpc: deps.rpc ?? ((host, op, args) => {
      const port = gatewayCapability("outboxHost");
      //  고를 때 있던 능력이 사라질 수는 없지만, 없으면 «안 보냈다» 로 접는다 — 표식 없는 오류는 «쳤을 수 있다» 로 읽힌다.
      return port ? port.rpc(host, op, args) : Promise.reject(Object.assign(new Error("outbox-host-unwired"), { sent: false }));
    }),
    defersHere: deps.defersHere ?? (() => gatewayCapability("outboxHost")?.defersHere() ?? false),
    local: deps.local ?? LOCAL_STEPS,
    warn: deps.warn ?? ((o, msg) => logger.warn(o, msg)),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  };
  const t0 = d.now();
  let defers: boolean | undefined;   // 행당 한 번 — 좌표가 없을 때만 묻는다
  for (;;) {
    const pick = d.hostPick(sessionId, "outboxStep");
    const waitedMs = d.now() - t0;
    if (!pick) return localExec(sessionId, "no-port", waitedMs, d);
    if (pick.why === "no-coordinate" && defers === undefined) defers = d.defersHere();
    const next = hostWait({ why: pick.why, defers: defers === true, waitedMs, capMs: HOST_WAIT_CAP_MS });
    if (next === "go" && pick.host) return hostExec(sessionId, pick.host, waitedMs, d);
    if (next !== "wait") return localExec(sessionId, pick.why, waitedMs, d);
    await d.sleep(HOST_WAIT_POLL_MS);
  }
}

/** 게이트웨이가 직접 하는 자리 — 종전 경로 그대로다. */
function localExec(sessionId: string, why: SessionHostTargetWhy | "no-port", waitedMs: number, d: OutboxExecDeps): OutboxExec {
  return {
    host: null, why, waitedMs,
    peek: () => d.local.peek(sessionId),
    trustKeys: () => d.local.keys,
    type: (text) => d.local.type(sessionId, text),
    enter: () => d.local.keys.enter(sessionId).catch(() => { /* 다음 에코 창에서 판정 */ }),
  };
}

/**
 * 세션 호스트가 실행하는 자리 — 실패는 머리말의 규칙으로 접는다.
 *  ⚠ 강등(`demoted`)은 이 행 안에서만 산다 — 다음 행은 `outboxExecFor` 가 다시 고른다.
 */
function hostExec(sessionId: string, host: string, waitedMs: number, d: OutboxExecDeps): OutboxExec {
  let demoted = false;
  const demote = (step: "peek" | "keys" | "type", cause: string, err?: unknown): void => {
    if (demoted) return;
    demoted = true;
    //  경고는 행당 한 번 — 호스트가 죽어 있는 동안 폴마다 남기면 로그가 폴 수만큼 쌓인다.
    d.warn({ err, sessionId, host, step, cause }, "outbox: 세션 호스트 걸음이 실패했다 — 이 행의 나머지 걸음은 게이트웨이가 직접 한다");
  };
  const rpcCause = (err: unknown): string => (rpcMaybeSent(err) ? "rpc-maybe-sent" : "rpc-not-sent");
  const ask = (args: Record<string, unknown>): Promise<unknown> => d.rpc(host, "outboxStep", { ...args, id: sessionId });

  /**
   * 누르기 — 아래로 `down` 칸, (enter 면) Enter 를 호스트에 **한 걸음으로** 싣는다. 호스트는 첫 실패에서 멈추므로 내리기가 실패했는데
   *  Enter 만 가서 커서가 선 «No, exit» 가 눌리는 일이 없다(PR1 P8c).
   */
  const press = async (down: number, enter: boolean): Promise<void> => {
    const onGateway = async (): Promise<void> => {
      if (down > 0) await d.local.keys.down(sessionId, down).catch(() => { /* 다음 폴에서 다시 본다 */ });
      if (enter) await d.local.keys.enter(sessionId).catch(() => { /* 다음 폴에서 다시 본다 */ });
    };
    if (demoted) return onGateway();
    if (down > OUTBOX_KEYS_MAX_DOWN) {
      //  상한보다 먼 선택지는 우리가 아는 대화상자가 아니다 — 대신 누르지 않는다(못 읽으면 안 누른다 · `trustAcceptDowns` 머리말).
      //   게이트웨이로 넘기지도 않는다: 호스트가 받지 않을 걸음을 게이트웨이 tmux 로 치면 상한이 뜻을 잃는다. 대화상자는 사람이 답할 수 있게 남는다.
      d.warn({ sessionId, host, down, max: OUTBOX_KEYS_MAX_DOWN }, "outbox: 선택지가 누르기 상한보다 멀다 — 대신 누르지 않는다");
      return;
    }
    let r: unknown;
    try {
      r = await ask({ step: "keys", down, enter });
    } catch (err) {
      demote("keys", rpcCause(err), err);
      if (!rpcMaybeSent(err)) await onGateway();   // 안 보냈다 — 같은 시도를 게이트웨이가
      return;                                     // 눌렀을 수 있다 — 삼킨다. 다음 폴이 화면으로 다시 판정한다
    }
    const out = decodeStep("keys", r);
    if (!("fault" in out)) return;   // 눌렀다 · 멈춘 자리(at) — 삼킨다(acceptTrustDialog 의 키 실패와 같다: 다음 폴이 다시 본다)
    demote("keys", out.fault);
    if (out.fault === "unsupported") await onGateway();   // 거절 = tmux 0 — 같은 시도를 게이트웨이가. 모양 틀림은 눌렀을 수 있어 삼킨다
  };

  return {
    host, why: "ok", waitedMs,
    async peek() {
      if (demoted) return d.local.peek(sessionId);
      let r: unknown;
      try {
        r = await ask({ step: "peek" });
      } catch (err) {
        demote("peek", rpcCause(err), err);   // 읽기는 늘 폴백 — 오류 종류와 무관하다
        return d.local.peek(sessionId);
      }
      const out = decodeStep("peek", r);
      if ("fault" in out) {
        demote("peek", out.fault);
        return d.local.peek(sessionId);
      }
      return out.ok ? { ok: true, pane: out.pane, paneCmd: out.paneCmd } : { ok: false, verdict: out.reach };
    },
    trustKeys() {
      //  `acceptTrustDialog` 는 내리기 → Enter 순서로 부른다. 내리기는 칸 수만 적어 두고 Enter 가 둘을 한 걸음으로 싣는다(위 press).
      //   부를 때마다 새 객체다 — 적어 둔 칸 수가 다음 Enter(미제출 방어)로 새지 않는다.
      let downs = 0;
      return {
        down: async (_id, times) => { downs = times; },
        enter: async () => press(downs, true),
      };
    },
    async type(text) {
      if (demoted) return d.local.type(sessionId, text);
      let next: TypeNext;
      try {
        const out = decodeStep("type", await ask({ step: "type", text }));
        next = typeNext(out);
        if ("fault" in out) demote("type", out.fault);
      } catch (err) {
        next = typeNext({ rpcError: err });
        demote("type", rpcCause(err), err);
      }
      switch (next) {
        case "echo": return { next: "echo" };
        case "echo-only": return { next: "echo-only" };          // 쳤을 수 있다 — **다시 치지 않는다**
        case "local": return d.local.type(sessionId, text);      // 안 보냈다·거절(tmux 0) — 같은 시도를 게이트웨이가
        case "stall:gone": return { next: "stall", verdict: "gone" };
        case "stall:unknown": return { next: "stall", verdict: "unknown" };
        case "fail:text": return { next: "fail", error: "send: text" };
        case "fail:enter": return { next: "fail", error: "send: enter" };
      }
    },
    enter: () => press(0, true),
  };
}
