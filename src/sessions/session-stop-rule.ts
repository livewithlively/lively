// 하네스 종료 규칙 (#4695 T5) — «필요할 때만 띄우고, 끝나면 곧 끈다». 정본: 지식 `session-harness-lifecycle-rules-4690`.
//
// ── 무엇을 하나 ───────────────────────────────────────────────────────────────────────────────────
//  매니지드 세션의 하네스를 **사람이 안 보는 채로** 아래 시간이 지나면 끈다(tmux kill-session — 장부 행은 남아 «복원 가능»).
//   · 작업 중 · 백그라운드 작업 · 예약 깨움(ScheduleWakeup·반복 예약) 대기 → **끄지 않는다(상한 없음)**
//   · 완료(턴 끝 ∧ 질의 아님 ∧ 기다리는 일 없음) → N분 뒤(기본 3)
//   · 사람에게 질의 중(승인·선택 대기) → M분 뒤(기본 60 — T2 «승인 대기 상한 1시간» 결정을 잇는다)
//   · 하네스가 끝나 셸만 남음(기동 실패 안내 — 런처 ③) → 완료와 같이 N분 뒤
//   · 보는 중이면 어느 상태든 유지. 다시 보거나 프롬프트가 오면 시계가 처음부터다(시계의 시작 = 마지막 활동과 «안 보기 시작» 중 나중).
//  끄기 **전에** 남긴다(저장 → 종료 순서): 하네스 입력창에 쓰다 만 글 · 질의 중이면 그 질문과 선택지(화면에서 읽는다 — claude 는 대화 파일에
//   그 질문이 안 남는다, 실측 3/3). 다음에 열면 대화창이 그 쪽지로 입력칸을 채우고 질문을 다시 보여 준다(web/session-chat.ts).
//  컨테이너 철거는 이 모듈 몫이 아니다 — tmux 가 끝나면 브로커가 걷는다(T6 #4696 이 «즉시» 로 바꾼다).
//
// ── 범위 ──────────────────────────────────────────────────────────────────────────────────────────
//  · 매니지드(세션 컨테이너 배포)만. 셀프호스트는 이 규칙을 안 돌린다(To-Be 의 대상이 매니지드다 — 무회귀).
//  · 사람 세션(kind human)만 — 위탁 워커·앱·로그인·상시 세션은 저마다 수명 관리자가 따로 있다.
//  · 하네스: claude · codex · antigravity(agy). grok·opencode 는 제외(옛 회수 방식 유지 — grok 은 같은 대화 이어 열기 불가, opencode 는 대화
//    파일 없음, T2). codex·agy 는 **대화 id 매핑이 있을 때만**(상민님 2026-10-15 · T2 조건) — 매핑 없이 끄면 다시 열 때 `resume --last`·
//    `--continue` 가 옆 세션 대화를 잡는다. claude 도 매핑이 없으면 빈 피커에 갇힐 수 있어 같은 조건을 건다.
//  · codex app-server·대화 런타임(chat) 세션은 pane 이 셸이라 이 판정의 재료(화면·훅)가 다르다 — 제외.
//
// ── ⚠ 파괴적 갈래다(#2258) ─────────────────────────────────────────────────────────────────────────
//  이 모듈은 tmux 세션을 죽인다. 그래서 **모르면 안 끈다**가 모든 갈래의 기본값이다: 관측 못 한 행 · 보는 중인지 모름(게이트웨이가 막 뜸) ·
//  예약을 못 셌다(옛 훅·옛 세션 호스트) · 프로세스 판정 실패 · 끄기 직전 화면이 그새 바뀜. 판정(순수 `stopVerdict`)과 집행(`sweepSessionStopRule`)을
//  가르고, 집행은 끄기 직전에 화면을 **다시** 읽어 «그새 턴이 시작됐나 · 답이 났나» 를 본다(목록 → 끄기 사이의 경합).
//  죽이는 함수는 `reapCentralSession` 하나다 — 옛 회수기와 같은 자리(행 보존 · restorable). 새 회수 갈래가 생겼다는 사실은
//  `scripts`·회수 가드 시험이 세는 «경로 수» 에 이 모듈이 더해진다는 뜻이다(호출자 감사: 아래 sweepSessionStopRule 한 곳).
import { logger } from "../log.js";
import { listCentralSessions } from "../node/registry.js";
import { reapCentralSession, type SessionInfo } from "../terminal/terminal-sessions.js";
import { tmux, tmuxQuiet } from "../terminal/tmux-exec.js";
import { tenantSlug, STOP_RULE_HARNESSES } from "../terminal/catalog.js";
import { tmuxInSessionContainer } from "../terminal/session-tmux.js";
import { viewState, PRESENCE_TTL_MS, type ViewState } from "../terminal/session-presence.js";
import { codexChatMode } from "../terminal/codex-chat-mode.js";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import {
  captureOf, draftFromScreen, questionFromScreen, questionItemFromScreen, questionTabs, screenAsks, screenRunning, clampDraft,
  type ScreenCapture,
} from "../terminal/harness-io/stop-capture.js";
import type { ReportedState } from "../terminal/phase.js";
import { listAllSessionStates, setSessionStopNote, type SessionState, type SessionStopNote, type StopQuestion } from "./session-state.js";
import { listManagedSessions } from "./managed-sessions.js";
import { getRuntimeConfig } from "../org/store.js";
import { effectiveSessionReclaimPolicy, normalizeSessionReclaimPolicy, type SessionReclaimPolicy } from "./session-reclaim-policy.js";
import { liveJobVerdicts, type JobVerdicts } from "./session-reaper.js";
import { currentTenant, withTenant, type TenantContext } from "../org/tenant-context.js";

/** 이 규칙을 따르는 하네스(카탈로그 키) — 런처 ①②③ 과 한 표다(catalog.ts). 그 밖은 옛 회수 방식(유휴·붙음·작업 시계)이 맡는다. */
export { STOP_RULE_HARNESSES };
/** 예약 깨움이 지난 뒤에도 이만큼은 «깨어날 참» 으로 본다 — 깨움은 하네스가 쉬고 있을 때 울려 새 턴을 연다(보통 수 초). */
export const WAKE_GRACE_SEC = 5 * 60;
/** «안 보기 시작» 의 재료 중 tmux 의 마지막 열람 시각(@box_last_seen)에 더하는 값 — 도장 만료(TTL)와 같다. */
const SEEN_TTL_SEC = Math.round(PRESENCE_TTL_MS / 1000);

/** 판정 재료 — 목록 행·장부 행에서 뽑는다(순수 판정이 tmux·DB 를 모르게). */
export interface StopFacts {
  harness: string;
  /** 관측한 행인가(목록이 tmux 를 못 보면 DB 행을 observed:false 로 채운다) */
  observed: boolean;
  /** 상시 세션 */
  managed: boolean;
  /** 장부(desired) 행이 있나 — 꺼도 다시 열 수 있나 */
  hasState: boolean;
  /** 세션 종류(human·task·managed·app·login — 장부 행이 없으면 human) */
  kind: string;
  /** 하네스 대화 id 를 아나(이어 열기 좌표) */
  convMapped: boolean;
  /** 대화가 어디서 도나 — tui(pane 의 하네스) · app-server(codex) · chat(대화 런타임) */
  runtime: "tui" | "app-server" | "chat";
  agentState: string;
  working: boolean;
  harnessWorking: boolean;
  awaiting: boolean;
  background: boolean;
  lastReport: ReportedState | null;
  /** 마지막 작업 시각(epoch초) */
  lastActive: number;
  /** tmux 에 새겨진 마지막 열람 시각(epoch초) — 게이트웨이를 다시 띄워도 남는다 */
  lastViewed: number;
  created: number;
}

export type StopState = "done" | "asking" | "exited";
export type KeepWhy =
  | "unobserved" | "managed" | "no-state" | "kind" | "harness" | "runtime" | "no-conv"
  | "viewing" | "view-unknown" | "working" | "background" | "scheduled" | "sched-unknown" | "off" | "no-clock" | "clock";
/** 판정은 끄라는데 집행이 멈춘 이유(stopOne · 집행 상한 · 작업 판별). */
export type HoldWhy = "jobs" | "jobs-unknown" | "turn-now" | "answered" | "asking-now" | "viewing-now" | "capped" | "failed" | "busy-sweep";
export type StopVerdict =
  | { act: "keep"; why: KeepWhy; state?: StopState; dueAt?: number }
  | { act: "stop"; state: StopState; since: number; dueAt: number };

/** 끄는 시각 — 분. 0 이면 그 상태는 끄지 않는다. */
export interface StopMinutes { doneMin: number; askingMin: number }

/**
 * (순수) 이 세션을 지금 끄나 — 사양 엣지 표 V1~V27(session-stop-rule.test.ts). 위에서부터 먼저 걸리는 것이 답이다.
 *  @param nowSec  지금(epoch초)
 */
export function stopVerdict(f: StopFacts, view: Pick<ViewState, "viewing" | "unknown" | "endedAtMs">, p: StopMinutes, nowSec: number): StopVerdict {
  // ① 범위 — 모르는 것·남의 관리 대상은 건드리지 않는다.
  if (!f.observed) return { act: "keep", why: "unobserved" };
  if (f.managed) return { act: "keep", why: "managed" };
  if (!f.hasState) return { act: "keep", why: "no-state" };
  if ((f.kind || "human") !== "human") return { act: "keep", why: "kind" };
  if (!STOP_RULE_HARNESSES.has(f.harness)) return { act: "keep", why: "harness" };
  if (f.runtime !== "tui") return { act: "keep", why: "runtime" };
  if (!f.convMapped) return { act: "keep", why: "no-conv" };
  // ② 보는 중이면 어느 상태든 유지. 모르면(게이트웨이가 막 떴다) 보는 중으로 본다.
  if (view.viewing) return { act: "keep", why: "viewing" };
  if (view.unknown) return { act: "keep", why: "view-unknown" };
  // ③ 상태 — 작업이 질의·완료보다 앞선다(둘 다 참이면 끄지 않는 쪽).
  let state: StopState;
  const r = f.lastReport;
  if (f.agentState === "exited") state = "exited";
  else if (f.working || f.harnessWorking || f.agentState === "busy") return { act: "keep", why: "working" };
  else if (f.awaiting || f.agentState === "waiting") state = "asking";
  else {
    if (f.background) return { act: "keep", why: "background" };
    if (r?.phase === "idle" && (r.bg ?? 0) > 0) return { act: "keep", why: "background" };
    if (r?.phase === "idle" && r.wake !== undefined) {
      if (r.wake > 0 && r.wake > nowSec - WAKE_GRACE_SEC) return { act: "keep", why: "scheduled" };
      if ((r.cron ?? 0) > 0) return { act: "keep", why: "scheduled" };
    }
    //  claude 는 예약(루프·반복 예약)을 갖는다 — 턴 끝 보고가 그걸 셌을 때만 «완료» 다. 옛 훅·옛 세션 호스트가 낸 보고엔 wake 칸이 없다.
    //  codex·agy 는 예약 도구가 없다 — 화면이 대기(idle)면 완료다(살아 있는 셸 작업은 집행 직전 프로세스 판정이 지킨다).
    if (f.harness === "claude" && !(r?.phase === "idle" && r.wake !== undefined)) return { act: "keep", why: "sched-unknown" };
    state = "done";
  }
  // ④ 시계 — 시작 = 마지막 활동(없으면 마지막 보고 → 만든 시각)과 «안 보기 시작» 중 나중. «안 보기 시작» 은 이 게이트웨이가 본 끝과
  //    tmux 에 새겨진 마지막 열람(+ 도장 TTL) 중 나중이다(게이트웨이를 다시 띄워도 끝난 시각을 안다).
  const min = state === "asking" ? p.askingMin : p.doneMin;
  if (!(min > 0)) return { act: "keep", why: "off", state };
  const base = f.lastActive || (r?.at ?? 0) || f.created || 0;
  const viewEnd = Math.max(Math.floor((view.endedAtMs || 0) / 1000), f.lastViewed > 0 ? f.lastViewed + SEEN_TTL_SEC : 0);
  const since = Math.max(base, viewEnd);
  if (!(since > 0)) return { act: "keep", why: "no-clock", state };
  const dueAt = since + min * 60;
  if (nowSec < dueAt) return { act: "keep", why: "clock", state, dueAt };
  return { act: "stop", state, since, dueAt };
}

// ── 옛 회수 시계와의 경계 (#4697 T7) ─────────────────────────────────────────────────────────────────────────────────
//  매니지드에서 옛 회수 시계(유휴 120 · 붙음 240 · 작업 480분 · 메모리 압박 — session-reaper.ts)는 **이 규칙이 판정하는 세션에서 손을 뗀다.**
//  판정하는 세션 = stopVerdict 가 «범위 안이고 판정할 재료가 있다» 고 답한 세션이다: 끈다 · 보는 중 · 모름(게이트웨이가 막 뜸) · 작업 중 ·
//   백그라운드 · 예약 · 시계가 가는 중. 그 밖은 옛 시계가 그대로 맡는다 — grok·opencode·셸(하네스 밖) · 대화 id 없음 · 위탁·앱·로그인(사람 세션 아님) ·
//   대화창 런타임 · 예약을 모름(옛 훅으로 뜬 claude) · 그 상태의 시계를 관리자가 꺼 둠(0) · 시계 재료 없음.
//  ⚠ 둘이 한 세션을 함께 보면 옛 시계가 이 규칙이 지키는 세션(보는 중 · 예약 깨움 대기 — 상한 없음)을 240·120분에 죽인다. 반대로 이 규칙이
//   판정하지 않는 세션에서까지 옛 시계를 빼면 그 세션은 아무도 끄지 않는다(실측 2026-10-16: 옛 훅으로 뜬 claude 세션 둘이 39시간째 «예약 모름» 으로 남았다).
//  ⚠ 두 분(N·M)을 모두 0 으로 두면 이 규칙이 아무것도 판정하지 않으니 옛 시계가 모든 세션을 다시 맡는다 — 관리자가 쥔 되돌리기 손잡이다.
const RULE_DECIDES: ReadonlySet<KeepWhy> = new Set<KeepWhy>(["viewing", "view-unknown", "working", "background", "scheduled", "clock"]);

/** (순수) 이 판정이 «이 규칙이 그 세션을 맡는다» 는 뜻인가 — 옛 회수 시계가 손을 떼는 조건(위 머리말). */
export function stopRuleDecides(v: StopVerdict): boolean {
  return v.act === "stop" || RULE_DECIDES.has(v.why);
}

/**
 * 이 판에서 이 규칙이 맡는 세션 id — 옛 회수기(session-reaper.ts)가 후보를 고르기 전에 묻는다. 테넌트 컨텍스트 안에서 부른다.
 *  셀프호스트(규칙이 안 도는 배포)면 늘 빈 집합이다 — 옛 회수기는 종전 그대로 돈다.
 *  @param policy  옛 회수기가 이미 읽은 같은 정책(N·M 을 거기서 읽는다 — 두 모듈이 정책을 따로 읽어 판이 갈리지 않게)
 */
export function sessionsUnderStopRule(
  live: ReadonlyArray<SessionInfo>,
  states: ReadonlyArray<{ id: string } & Partial<Pick<SessionState, "kind" | "claude_session_id">>>,
  managedIds: ReadonlySet<string>,
  policy: Partial<SessionReclaimPolicy>,
  over: Partial<Pick<StopRuleDeps, "enabled" | "view" | "now">> = {},
): ReadonlySet<string> {
  const enabled = over.enabled ?? (() => tmuxInSessionContainer(tenantSlug()));
  if (!enabled()) return new Set();
  const mins = stopMinutesOf(policy);
  if (!(mins.doneMin > 0) && !(mins.askingMin > 0)) return new Set();
  const view = over.view ?? ((id: string) => viewState(id));
  const nowSec = Math.floor((over.now ?? Date.now)() / 1000);
  const byId = new Map(states.map((s) => [s.id, s]));
  const out = new Set<string>();
  for (const s of live) {
    if (stopRuleDecides(stopVerdict(stopFactsOf(s, byId.get(s.id), managedIds), view(s.id), mins, nowSec))) out.add(s.id);
  }
  return out;
}

/** 목록 행 + 장부 행 → 판정 재료. 장부 행은 종류·대화 id 만 본다(옛 회수기는 id 만 든 행을 넘길 수 있다 — 그러면 «대화 id 없음»). */
export function stopFactsOf(s: SessionInfo, st: Partial<Pick<SessionState, "kind" | "claude_session_id">> | undefined, managedIds: ReadonlySet<string>): StopFacts {
  const appServer = codexChatMode({ harness: s.harness, stamp: s.runtimeRaw }) === "app-server";
  const runtime = appServer ? "app-server" : s.runtimeChoice === "chat" ? "chat" : "tui";
  return {
    harness: s.harness || "",
    observed: (s as SessionInfo & { observed?: boolean }).observed !== false,
    managed: !!s.managed || managedIds.has(s.id),
    hasState: !!st,
    kind: st?.kind || "human",
    convMapped: !!st?.claude_session_id,
    runtime,
    agentState: String(s.agentState || ""),
    working: !!s.working,
    harnessWorking: !!s.harnessWorking,
    awaiting: !!s.awaiting,
    background: !!s.background,
    lastReport: s.lastReport ?? null,
    lastActive: Number(s.lastActive) || 0,
    lastViewed: Number(s.lastViewed) || 0,
    created: Number(s.created) || 0,
  };
}

/** 끄는 시각(분)을 정책에서 읽는다 — 정책이 모르는 칸이면 기본값. */
export function stopMinutesOf(p: Partial<SessionReclaimPolicy>): StopMinutes {
  const n = Number(p.stop_done_minutes), m = Number(p.stop_asking_minutes);
  return { doneMin: Number.isFinite(n) && n >= 0 ? n : 3, askingMin: Number.isFinite(m) && m >= 0 ? m : 60 };
}

// ── 집행 ─────────────────────────────────────────────────────────────────────────────────────────

/** 시험 seam — 기본값은 전부 프로덕션 경로다. */
export interface StopRuleDeps {
  /** 이 배포(테넌트)에서 이 규칙을 도나 — 기본: 매니지드(세션 컨테이너 안 tmux)만 */
  enabled: () => boolean;
  loadPolicy: () => Promise<Partial<SessionReclaimPolicy>>;
  listLive: () => Promise<SessionInfo[]>;
  listStates: () => Promise<SessionState[]>;
  listManaged: () => Promise<Array<{ session_id: string | null }>>;
  view: (id: string) => ViewState;
  /** ⑥ 하네스가 띄운 작업 — 있음(jobs) · 판정 불가(unknown). 둘 다 이번 판엔 끄지 않는다. */
  jobVerdicts: (ids: ReadonlySet<string>) => Promise<JobVerdicts>;
  capture: (id: string) => Promise<string>;
  keys: (id: string, key: string) => Promise<void>;
  saveNote: (id: string, note: SessionStopNote) => Promise<unknown>;
  reap: (id: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** 다음 마감에 이 테넌트를 다시 판정하도록 깨움을 건다(시험은 끈다) */
  arm: (dueAtSec: number) => void;
}

/** 한 판의 결과 — CP 하우스키핑 틱·요청 정비 로그가 이 모양을 그대로 찍는다. */
export interface StopRuleResult {
  enabled: boolean;
  why?: string;
  doneMin?: number;
  askingMin?: number;
  scanned: number;
  stopped: Array<{ id: string; state: StopState; idleSec: number; draft: boolean; question: StopQuestion["kind"] | null }>;
  /** 남겨 둔 이유별 수 */
  kept: Partial<Record<KeepWhy | HoldWhy, number>>;
  /**
   * #4697 — 이유별로 가장 오래 논 세션(마지막 활동 → 지금, 초). 7일 측정이 «같은 세션이 며칠째 그 이유로 남는가» 를 본다 — 규칙이 맡은 세션은
   *  옛 시계가 손을 떼므로(session-reaper.ts), 이 규칙이 못 끄는 채 굳는 세션(보는 중 · 작업 중 · 판정 불가 …)은 여기서만 보인다(격리 리뷰).
   */
  keptOldest?: Partial<Record<KeepWhy | HoldWhy, { id: string; idleSec: number }>>;
  /** 다음 마감까지 남은 초(없으면 없음) */
  nextDueInSec?: number;
}

/** 테넌트마다 한 판씩만 — 요청 정비·CP 틱·마감 깨움이 겹쳐도 같은 세션을 두 번 끄지 않는다. */
const inFlight = new Set<string>();
const tenantKey = (): string => String(currentTenant()?.id ?? "");

/** 질문 탭을 넘길 때 화면이 다시 그려지기를 기다리는 시간 — 실측(2.1.300)에서 0.8초면 넘친다. */
const TAB_SETTLE_MS = 600;
/** claude AskUserQuestion 은 질문을 최대 4개까지 한 번에 묻는다(도구 설명). */
const MAX_TABS = 4;
/**
 * 한 판에 끄는 세션 수 상한(격리 리뷰 — 폭발 반경). 롤 직후 첫 판은 «3분 넘게 놀던» 세션을 한 테넌트에서 한꺼번에 만난다.
 *  판정이 틀렸다면(#2258 — 가드 없는 갈래가 살아 있는 세션 ~24개를 지웠다) 그 판 하나가 전부를 끈다. 넘친 것은 곧 다음 판(5초 뒤 깨움)이 잇는다.
 */
export const MAX_STOPS_PER_SWEEP = 10;
/** 하네스가 띄운 작업이 살아 있던 세션은 이만큼 다시 재지 않는다 — 30초마다 컨테이너 프로브를 맞지 않게(옛 회수기는 5분 간격). */
export const JOB_HOLD_MS = 3 * 60_000;
/** 테넌트·세션 → 작업 보호가 풀리는 시각(ms). */
const jobHold = new Map<string, number>();

function defaultDeps(): StopRuleDeps {
  return {
    enabled: () => tmuxInSessionContainer(tenantSlug()),
    loadPolicy: async () => (await getRuntimeConfig()).session_reclaim_policy,
    listLive: () => listCentralSessions(),
    listStates: () => listAllSessionStates(),
    listManaged: () => listManagedSessions(),
    view: (id) => viewState(id),
    jobVerdicts: (ids) => liveJobVerdicts(ids),
    capture: (id) => tmux(["capture-pane", "-t", id, "-p", "-e"]),
    keys: async (id, key) => { await tmuxQuiet(["send-keys", "-t", id, key]); },
    saveNote: (id, note) => setSessionStopNote(id, note),
    reap: (id) => reapCentralSession(id),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    arm: (dueAtSec) => armStopTimer(dueAtSec),
  };
}

/**
 * 한 테넌트를 한 판 판정·집행한다. **테넌트 컨텍스트 안에서** 부른다(요청 정비 · CP 하우스키핑 틱 · 마감 깨움).
 *  실패는 던지지 않고 결과에 센다 — 정비 한 판이 다음 판을 막지 않는다.
 */
export async function sweepSessionStopRule(over: Partial<StopRuleDeps> = {}): Promise<StopRuleResult> {
  const d: StopRuleDeps = { ...defaultDeps(), ...over };
  const kept: StopRuleResult["kept"] = {};
  const count = (k: keyof StopRuleResult["kept"]): void => { kept[k] = (kept[k] ?? 0) + 1; };
  const oldest: NonNullable<StopRuleResult["keptOldest"]> = {};
  const noteOldest = (k: keyof StopRuleResult["kept"], id: string, idleSec: number): void => {
    const o = oldest[k];
    if (!o || idleSec > o.idleSec) oldest[k] = { id, idleSec: Math.max(0, Math.round(idleSec)) };
  };
  if (!d.enabled()) return { enabled: false, why: "self-hosted", scanned: 0, stopped: [], kept };
  const key = tenantKey();
  if (inFlight.has(key)) { count("busy-sweep"); return { enabled: true, why: "in-flight", scanned: 0, stopped: [], kept }; }
  inFlight.add(key);
  try {
    //  정책은 회수기와 같은 테넌트별 캐시(30초)로 읽는다. 시험이 읽는 법을 바꿔 끼우면 캐시를 거치지 않는다(시험끼리 값이 새지 않게).
    const policy = over.loadPolicy
      ? normalizeSessionReclaimPolicy(await over.loadPolicy())
      : await effectiveSessionReclaimPolicy(async () => normalizeSessionReclaimPolicy(await d.loadPolicy()));
    const mins = stopMinutesOf(policy);
    if (!(mins.doneMin > 0) && !(mins.askingMin > 0)) return { enabled: false, why: "policy-off", ...mins, scanned: 0, stopped: [], kept };
    const [live, states, managed] = await Promise.all([d.listLive(), d.listStates(), d.listManaged()]);
    const byId = new Map(states.map((s) => [s.id, s]));
    const managedIds = new Set(managed.map((m) => m.session_id).filter((x): x is string => !!x));
    const nowSec = Math.floor(d.now() / 1000);
    const due: Array<{ s: SessionInfo; state: StopState; since: number }> = [];
    let nextDue = Infinity;
    for (const s of live) {
      const f = stopFactsOf(s, byId.get(s.id), managedIds);
      const v = stopVerdict(f, d.view(s.id), mins, nowSec);
      if (v.act === "keep") {
        count(v.why);
        noteOldest(v.why, s.id, nowSec - (f.lastActive || (f.lastReport?.at ?? 0) || f.created || nowSec));
        if (v.why === "clock" && v.dueAt) nextDue = Math.min(nextDue, v.dueAt);
        continue;
      }
      due.push({ s, state: v.state, since: v.since });
    }
    //  ⑥ 하네스가 띄운 작업(셸·빌드)이 살아 있으면 끄지 않는다 — 회수기와 같은 판별자(#2652). 판정 자체가 실패하면 **이번 판은 아무것도 안 끈다**
    //   (회수기는 «방어를 멈추지 않으려고» 종전대로 진행하지만, 이 규칙은 메모리 압박 방어가 아니라 «끝난 것을 치우는» 일이라 한 판 미뤄도 된다).
    //   세션 하나를 판정하지 못했으면(프로브 실패·타임아웃·빈 표) **그 세션만** 이번 판에 안 끈다(jobs-unknown — 격리 리뷰: 회수기처럼 «작업 없음» 으로
    //   접으면 `nohup … &` 로 띄운 서버가 3분 만에 죽는다). 작업이 살아 있던 세션은 JOB_HOLD_MS 동안 다시 재지 않는다.
    const nowMs = d.now();
    const holdKey = (id: string): string => key + "\u0000" + id;
    for (const [k, until] of jobHold) if (until <= nowMs) jobHold.delete(k);
    const held = due.filter((x) => jobHold.has(holdKey(x.s.id)));
    for (const x of held) { count("jobs"); noteOldest("jobs", x.s.id, nowSec - x.since); }
    const toJudge = due.filter((x) => !jobHold.has(holdKey(x.s.id)));
    //  상한은 프로브 **앞**에서도 건다 — 롤 직후처럼 후보가 많을 때 전부를 동시에 컨테이너 프로브하지 않게(격리 리뷰). 오래 논 것부터 본다.
    let capped = false;
    toJudge.sort((a, b) => a.since - b.since);
    for (const x of toJudge.splice(MAX_STOPS_PER_SWEEP * 2)) { count("capped"); noteOldest("capped", x.s.id, nowSec - x.since); capped = true; }
    let verdicts: JobVerdicts = { jobs: new Set(), unknown: new Set() };
    if (toJudge.length) {
      try { verdicts = await d.jobVerdicts(new Set(toJudge.map((x) => x.s.id))); }
      catch (e) {
        logger.warn({ err: e, candidates: toJudge.length }, "하네스 종료 규칙: 작업 판정 실패 — 이번 판은 끄지 않는다");
        for (const x of toJudge) { count("jobs-unknown"); noteOldest("jobs-unknown", x.s.id, nowSec - x.since); }
        toJudge.length = 0;
      }
    }
    const stopped: StopRuleResult["stopped"] = [];
    for (const { s, state, since } of toJudge) {
      if (verdicts.jobs.has(s.id)) { count("jobs"); noteOldest("jobs", s.id, nowSec - since); jobHold.set(holdKey(s.id), nowMs + JOB_HOLD_MS); continue; }
      if (verdicts.unknown.has(s.id)) { count("jobs-unknown"); noteOldest("jobs-unknown", s.id, nowSec - since); continue; }
      if (stopped.length >= MAX_STOPS_PER_SWEEP) { count("capped"); noteOldest("capped", s.id, nowSec - since); capped = true; continue; }
      try {
        const out = await stopOne(d, s, state);
        //  낡은 질의 표식으로 «답이 났다(answered)» 에 영영 걸리는 세션도 여기서 보인다(재검토 C).
        if (out.skip) { count(out.skip); noteOldest(out.skip, s.id, nowSec - since); continue; }
        stopped.push({ id: s.id, state, idleSec: Math.max(0, nowSec - since), draft: !!out.note.draft, question: out.note.question?.kind ?? null });
      } catch (e) {
        count("failed");
        noteOldest("failed", s.id, nowSec - since);
        logger.warn({ err: e, id: s.id, state }, "하네스 종료 규칙: 끄기 실패(다음 판에 다시)");
      }
    }
    //  상한에 걸려 남긴 세션은 곧바로 다음 판이 잇는다(깨움 하한 5초).
    if (capped) nextDue = Math.min(nextDue, nowSec);
    const nextDueInSec = Number.isFinite(nextDue) ? Math.max(0, nextDue - nowSec) : undefined;
    if (nextDueInSec !== undefined) d.arm(nextDue);
    const result: StopRuleResult = {
      enabled: true, ...mins, scanned: live.length, stopped, kept,
      ...(Object.keys(oldest).length ? { keptOldest: oldest } : {}),
      ...(nextDueInSec !== undefined ? { nextDueInSec } : {}),
    };
    //  끈 판은 무엇을 왜 껐는지 남긴다(#2652 교훈 — 개수만 남긴 로그는 사후에 아무것도 못 판다). 아무것도 안 끈 판은 조용히(30초마다 돈다).
    //  #4697 — 어느 워크스페이스의 판인지 싣는다(7일 측정이 워크스페이스별로 센다). 결과 모양(CP 가 읽는다)은 그대로 둔다.
    if (stopped.length) logger.info({ tenant: currentTenant()?.slug ?? null, ...result }, "하네스 종료 규칙: 하네스를 껐다(쪽지를 남기고 tmux 종료 — 행 보존 · 다시 열면 이어진다)");
    return result;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * #4697 T7 — 5분 하우스키핑 틱의 판을 워크스페이스당 한 줄로 남긴다(«왜 안 껐나» 분포 — 7일 측정이 센다: 예약 모름(옛 훅) 세션이 줄어드는가 ·
 *  보는 중·작업 중으로 오래 남는 세션이 있는가). 요청 정비(30초)·마감 깨움 판은 끈 것이 있을 때만 찍는다(위 sweepSessionStopRule) — 그 판까지 매번 찍으면
 *  워크스페이스마다 분당 두 줄이다. 다른 판이 돌던 중이라 이 판이 건너뛰었으면(in-flight) 안 찍는다(빈 표를 «아무것도 없다» 로 읽지 않게).
 */
export function logStopRuleTick(
  r: StopRuleResult,
  log: (o: Record<string, unknown>) => void = (o) => logger.info(o, "하네스 종료 규칙 틱(측정 #4697)"),
): void {
  if (!r.enabled || r.why === "in-flight") return;
  log({ tenant: currentTenant()?.slug ?? null, scanned: r.scanned, stopped: r.stopped.length, kept: r.kept, keptOldest: r.keptOldest, nextDueInSec: r.nextDueInSec });
}

/**
 * 한 세션을 끈다 — 저장 → 종료. 끄기 직전 화면을 다시 읽어 그새 바뀌었으면 끄지 않는다.
 *  @returns skip = 안 끈 이유 · note = 남긴 쪽지
 */
async function stopOne(d: StopRuleDeps, s: SessionInfo, state: StopState): Promise<{ skip?: "turn-now" | "answered" | "asking-now" | "viewing-now"; note: SessionStopNote }> {
  const harness = s.harness;
  const cap = captureOf(await d.capture(s.id));
  //  마지막 확인 — 목록을 본 뒤 그새 턴이 시작됐거나(깨움·알림이 연 턴) 질문에 답이 났으면 이번엔 안 끈다. 다음 판이 새 사실로 다시 판정한다.
  if (screenRunning(cap, harnessIo(harness)?.run ?? null)) return { skip: "turn-now", note: { at: 0, why: state, harness } };
  const asking = screenAsks(cap);
  if (state === "asking" && !asking) return { skip: "answered", note: { at: 0, why: state, harness } };
  if (state === "done" && asking) return { skip: "asking-now", note: { at: 0, why: state, harness } };
  const note: SessionStopNote = { at: Math.floor(d.now() / 1000), why: state, harness };
  const draft = clampDraft(draftFromScreen(harness, cap));
  if (draft) note.draft = draft;
  if (state === "asking") {
    //  질문 탭을 넘기기(→ 키) 전에도 본다 — 그새 사람이 돌아왔으면 그 사람이 보는 대화상자를 움직이지 않는다.
    const v0 = d.view(s.id);
    if (v0.viewing || v0.unknown) return { skip: "viewing-now", note };
    const q = await readQuestion(d, s.id, harness, cap);
    if (q) note.question = q;
  }
  //  마지막 확인 둘째 — 판정 뒤(작업 판별 · 앞 세션들 · 질문 탭 넘기기로 수 초가 지났다) 그새 사람이 돌아왔으면 끄지 않는다(보는 중을 끄는 것이 첫째 금지).
  const v = d.view(s.id);
  if (v.viewing || v.unknown) return { skip: "viewing-now", note };
  //  쪽지를 못 적어도 끈다 — 글이 있다고 끄기를 미루지 않는다(규칙 정본). 대신 실패는 남긴다.
  await Promise.resolve(d.saveNote(s.id, note)).catch((e) => logger.warn({ err: e, id: s.id }, "하네스 종료 규칙: 쪽지 저장 실패(끄기는 계속)"));
  await d.reap(s.id);
  return { note };
}

/** 질의 중인 화면의 질문을 읽는다 — claude 의 여러 질문(탭)은 → 키로 넘기며 하나씩 읽는다(Enter 는 안 누른다 — 제출되지 않는다, 실측). */
async function readQuestion(d: StopRuleDeps, id: string, harness: string, first: ScreenCapture): Promise<StopQuestion | null> {
  const q = questionFromScreen(harness, first);
  if (!q) return null;
  const tabs = harness === "claude" ? questionTabs(first).slice(0, MAX_TABS) : [];
  if (tabs.length > 1) {
    if (!q.items[0].header) q.items[0].header = tabs[0];
    for (let i = 1; i < tabs.length; i++) {
      try {
        await d.keys(id, "Right");
        await d.sleep(TAB_SETTLE_MS);
        const item = questionItemFromScreen(captureOf(await d.capture(id)));
        if (!item) break;
        //  못 넘겼으면(키 보내기 실패를 tmuxQuiet 가 삼킨다) 같은 질문이 다시 읽힌다 — 같은 것을 두 번 남기지 않는다.
        const prev = q.items[q.items.length - 1];
        if (prev && prev.text === item.text && JSON.stringify(prev.options) === JSON.stringify(item.options)) break;
        q.items.push({ ...item, header: item.header || tabs[i] });
      } catch { break; }   // 못 넘겼으면 읽은 데까지만 남긴다 — 곧 끈다
    }
  }
  return q;
}

// ── 마감 깨움 ─────────────────────────────────────────────────────────────────────────────────────
//  요청 정비(30초)·CP 틱(5분)은 그 테넌트에 요청이 와야 돈다. 아무도 안 쓰는 워크스페이스에서는 5분 틱만 남아 N=3 이 3~8분이 된다.
//  그래서 한 판이 «다음 마감» 을 알면 그 시각에 이 테넌트를 다시 판정하도록 깨움 하나를 건다(테넌트당 하나 — 더 이른 마감만 갈아 끼운다).
//  게이트웨이가 다시 뜨면 깨움은 사라진다 — 다음 요청·틱이 판정하며 다시 건다(그 사이 45초는 어차피 «모름» 이라 안 끈다).
const timers = new Map<string, { atMs: number; t: NodeJS.Timeout }>();
/** 깨움 하나의 범위 — 너무 이르면 판이 몰리고, 너무 늦으면 CP 틱(5분)보다 못하다. */
const ARM_MIN_MS = 5_000;
const ARM_MAX_MS = 10 * 60_000;
const ARM_SLACK_MS = 2_000;

export function armStopTimer(dueAtSec: number, now = Date.now()): void {
  const tenant: TenantContext | null = currentTenant() ?? null;
  const key = String(tenant?.id ?? "");
  const atMs = dueAtSec * 1000 + ARM_SLACK_MS;
  const prev = timers.get(key);
  if (prev && prev.atMs <= atMs && prev.atMs > now) return;   // 더 이른 깨움이 이미 걸려 있다
  if (prev) clearTimeout(prev.t);
  const delay = Math.min(ARM_MAX_MS, Math.max(ARM_MIN_MS, atMs - now));
  const t = setTimeout(() => {
    timers.delete(key);
    const run = (): Promise<unknown> => sweepSessionStopRule();
    void (tenant ? withTenant(tenant, run) : run())
      .catch((err) => logger.warn({ err, tenant: tenant?.slug }, "하네스 종료 규칙: 마감 깨움 판정 실패(다음 요청·틱이 다시)"));
  }, delay);
  t.unref?.();
  timers.set(key, { atMs: now + delay, t });
}

/** 시험용 — 걸린 깨움을 모두 거둔다. */
export function clearStopTimers(): void {
  for (const { t } of timers.values()) clearTimeout(t);
  timers.clear();
}

/** 시험용 — 모듈 상태(깨움 · 작업 보호 · 진행 중 표시)를 비운다. 시나리오끼리 새지 않게. */
export function resetStopRule(): void {
  clearStopTimers();
  jobHold.clear();
  inFlight.clear();
}
