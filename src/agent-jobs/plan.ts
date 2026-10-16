// 작업 컨테이너 — 판정만(순수). 무엇을 띄울지 · 언제 끝난 것으로 볼지 · 판의 보고를 어떤 상태로 적을지 (#4490 앱 v2-11)
//
//  작업 1건 = 세션 노드의 gVisor 컨테이너 1개(사람 세션과 같은 브로커·번들, 다른 인스턴스). 끝나면 결과를 적고 바로 걷는다.
//  이 파일은 DB·브로커·tmux 를 모른다 — service.ts 가 사실을 모아 여기 묻고, 답대로 움직인다(엣지 표로 시험한다).
import type { AgentJobPolicy } from "../org/policies/agent-job-policy.js";

export type AgentJobStatus = "queued" | "starting" | "running" | "done" | "failed" | "timeout" | "canceled";
export const LIVE_JOB_STATUSES: readonly AgentJobStatus[] = Object.freeze(["starting", "running"]);
export const OPEN_JOB_STATUSES: readonly AgentJobStatus[] = Object.freeze(["queued", "starting", "running"]);
export const isEnded = (s: string): boolean => s === "done" || s === "failed" || s === "timeout" || s === "canceled";

/** 프롬프트 상한(문자) — 사람이 쓰는 지시와 앱이 붙이는 자료를 합쳐도 넉넉하고, DB 한 행·boot 응답 하나에 담긴다. */
export const PROMPT_MAX = 100_000;
/** 진행 꼬리 상한(문자) — 앱·사람이 «지금 무엇을 하나» 를 보는 요지. 전문은 하네스 대화 기록에 있다. */
export const TAIL_MAX = 16_000;
/** 최종 답 상한(문자) — 결과 JSON 한 칸. 넘으면 자르고 truncated 를 남긴다. */
export const RESULT_TEXT_MAX = 200_000;
/** 판이 보고하는 stderr 꼬리 상한. */
export const STDERR_TAIL_MAX = 8_000;
/** 판의 박동 간격 — silent_sec(기본 90초)의 1/18. 진행 꼬리도 이 간격으로 올라온다. */
export const TICK_MS = 5_000;
/** 라벨 상한(문자). */
export const LABEL_MAX = 120;

/** 앱 id 규칙(코어 manifest APP_ID_RE · 브로커 sessionapps.APP_ID_RE 와 같은 자) — 앱 폴더 경로 조각으로 안전하다. */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** 컨테이너 안 앱 폴더 자리(브로커 APP_FOLDER_CWD_ROOT · 파일 주소 체계 #4671 «프로젝트 없는 앱 에이전트 세션» 과 같은 값). */
export const APP_FOLDER_ROOT = "/work/apps";
/** 컨테이너 안 프로젝트 폴더 자리(세션 경로 표 `/work/shared` + project/<id>). */
export const PROJECT_FOLDER_ROOT = "/work/shared/project";

/** (순수) 앱 폴더 작업 폴더 — 앱 id 가 규칙 밖이면 던진다(경로를 만들지 않는다). */
export function appFolderCwd(appId: string): string {
  if (!APP_ID_RE.test(appId)) throw new Error(`앱 id 형식 밖: ${JSON.stringify(appId)}`);
  return `${APP_FOLDER_ROOT}/${appId}`;
}
/** (순수) 프로젝트 폴더 작업 폴더. */
export function projectFolderCwd(projectId: number): string {
  if (!Number.isSafeInteger(projectId) || projectId < 1) throw new Error(`프로젝트 id 형식 밖: ${projectId}`);
  return `${PROJECT_FOLDER_ROOT}/${projectId}`;
}

/**
 * (순수) 작업 컨테이너의 세션 id — `job-<작업 id>-<16진 8>`.
 *  ★ `box-` 로 시작하지 않는 것이 이 설계의 요점이다: 사람 세션 목록·복원 목록·MCP 세션 신원(`SESSION_ID_RE`)은 전부 `box-` 만
 *   보므로 작업 컨테이너는 따로 막지 않아도 사람 화면에 안 뜬다(desired 행도 없다). 브로커 세션 id 규칙
 *   (`^[a-z0-9][a-z0-9_-]{0,62}$`)과 tmux 해석기(SAFE)는 이 꼴을 받는다.
 */
export function jobSessionId(jobId: number, hex8: string): string {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error(`작업 id 형식 밖: ${jobId}`);
  if (!/^[0-9a-f]{8}$/.test(hex8)) throw new Error(`꼬리 형식 밖: ${hex8}`);
  return `job-${jobId}-${hex8}`;
}
export const JOB_SESSION_ID_RE = /^job-[1-9][0-9]{0,15}-[0-9a-f]{8}$/;

/** (순수) 요청한 실행 시간(분) → 초. 없으면 기본, 넘으면 최대로 접는다(거절하지 않는다 — 앱이 상한을 몰라도 돈다). */
export function timeoutSecOf(requestedMin: unknown, p: Pick<AgentJobPolicy, "default_timeout_min" | "max_timeout_min">): number {
  const n = typeof requestedMin === "number" && Number.isFinite(requestedMin) ? Math.floor(requestedMin) : NaN;
  const min = Number.isNaN(n) || n < 1 ? p.default_timeout_min : Math.min(n, p.max_timeout_min);
  return min * 60;
}

export interface ClaimCandidate { id: number; account_member: string | null }

/**
 * (순수) 이번에 자리를 줄 대기 작업을 고른다 — 먼저 온 것부터, 워크스페이스 상한과 실행 계정(사람)당 상한을 지킨다.
 *  live = 지금 띄우는 중·도는 작업(starting·running). queued = 기다리는 작업(먼저 온 순서로 받는다).
 *  ⚠ 사람당 상한에 걸린 작업은 **건너뛰고** 다음 사람의 작업을 본다 — 한 사람이 대기열 앞을 다 차지해도 남의 작업이 선다.
 */
export function planClaims(
  live: readonly ClaimCandidate[], queued: readonly ClaimCandidate[], p: Pick<AgentJobPolicy, "max_running" | "max_running_per_member">,
): number[] {
  let free = p.max_running - live.length;
  if (free <= 0) return [];
  const perMember = new Map<string, number>();
  for (const j of live) if (j.account_member) perMember.set(j.account_member, (perMember.get(j.account_member) ?? 0) + 1);
  const out: number[] = [];
  for (const j of queued) {
    if (free <= 0) break;
    const who = j.account_member ?? "";
    const n = perMember.get(who) ?? 0;
    if (who && n >= p.max_running_per_member) continue;
    out.push(j.id);
    if (who) perMember.set(who, n + 1);
    free--;
  }
  return out;
}

export interface SweepFacts {
  status: AgentJobStatus;
  createdAt: number;
  claimedAt: number | null;
  startedAt: number | null;
  lastTickAt: number | null;
  timeoutSec: number;
  cancelRequested: boolean;
  /**
   * 이 게이트웨이가 판의 말을 듣기 시작한 시각(프로세스 시작). 무응답은 «판이 조용했던 시간» 이지 «게이트웨이가 못 들은 시간» 이
   *  아니다 — 게이트웨이가 내려가 있던 동안 판의 박동은 갈 곳이 없었다. 그래서 침묵은 이 시각 이후부터만 센다(재기동 직후 살아 있는
   *  판을 한꺼번에 끊지 않게). 모르면(null) 접지 않는다.
   */
  listeningSince?: number | null;
  /** 대기 중인 작업의 마지막 띄우기 실패 사유(일시 실패로 대기열에 되돌린 것) — 대기 상한으로 끝낼 때 문장에 붙인다. */
  lastError?: string | null;
}
export type SweepAction =
  | { act: "none" }
  | { act: "end"; status: "failed" | "timeout" | "canceled"; error: string; kill: boolean };

/** 시간 상한을 판이 스스로 끊은 뒤 보고까지 기다려 주는 여유(초) — 판은 상한에서 SIGTERM, 10초 뒤 SIGKILL, 그다음 보고한다. */
export const TIMEOUT_GRACE_SEC = 120;

/**
 * (순수) 감시 — 열린 작업 하나를 지금 끝내야 하나. 끝내면 컨테이너를 걷을지(kill)도 함께 말한다.
 *  · 대기 중: 취소 요청이면 취소 · 대기 상한을 넘기면 실패(«자리가 안 났다»).
 *  · 띄우는 중(자리 받음, 판의 첫 말 없음): 상한을 넘기면 실패 — 컨테이너 확보·하네스 준비가 막혔다.
 *  · 도는 중: 판 말이 silent_sec 넘게 없으면 끊김 · 실행 상한 + 여유를 넘기면 시간 초과(판이 스스로 못 끊은 것).
 *  ⚠ 판정 시계는 관측된 시각만 쓴다 — 없는 시각(null)은 그 앞 단계 시각으로 접는다(모르는 것을 «오래됐다» 로 읽지 않는다).
 */
export function sweepDecision(f: SweepFacts, nowMs: number, p: Pick<AgentJobPolicy, "queue_wait_min" | "silent_sec" | "start_timeout_sec">): SweepAction {
  if (f.status === "queued") {
    if (f.cancelRequested) return { act: "end", status: "canceled", error: "대기 중에 취소했습니다", kill: false };
    if (nowMs - f.createdAt > p.queue_wait_min * 60_000) {
      const last = f.lastError ? ` — 마지막 띄우기 실패: ${f.lastError.slice(0, 300)}` : "";
      return { act: "end", status: "failed", error: `자리가 ${p.queue_wait_min}분 안에 나지 않았습니다(워크스페이스 동시 상한) — 다시 보내 주세요${last}`, kill: false };
    }
    return { act: "none" };
  }
  if (f.status === "starting") {
    const since = f.claimedAt ?? f.createdAt;
    if (nowMs - since > p.start_timeout_sec * 1000) {
      return { act: "end", status: "failed", error: `작업 컨테이너가 ${p.start_timeout_sec}초 안에 시작하지 않았습니다`, kill: true };
    }
    return { act: "none" };
  }
  if (f.status === "running") {
    const started = f.startedAt ?? f.claimedAt ?? f.createdAt;
    if (nowMs - started > (f.timeoutSec + TIMEOUT_GRACE_SEC) * 1000) {
      return { act: "end", status: "timeout", error: `실행 시간 상한(${Math.round(f.timeoutSec / 60)}분)을 넘겼습니다`, kill: true };
    }
    const heard = Math.max(f.lastTickAt ?? started, f.listeningSince ?? Number.NEGATIVE_INFINITY);
    if (nowMs - heard > p.silent_sec * 1000) {
      return { act: "end", status: "failed", error: `작업 컨테이너가 ${p.silent_sec}초 동안 응답하지 않았습니다(노드·컨테이너가 사라졌을 수 있습니다)`, kill: true };
    }
    return { act: "none" };
  }
  return { act: "none" };
}

/** 판이 보내는 마지막 보고(runner.ts 의 result 본문). */
export interface RunnerReport {
  exit_code: number | null;
  signal: string | null;
  /** 판이 스스로 끊었나 — 'timeout' | 'canceled' | null. */
  stopped: string | null;
  conversation_id: string | null;
  model: string | null;
  /** 하네스의 마지막 result 이벤트에서 고른 칸(없으면 null — 하네스가 답 없이 끝났다). */
  result: { text: string | null; is_error: boolean; subtype: string | null; num_turns: number | null; duration_ms: number | null; cost_usd: number | null; usage: Record<string, unknown> | null } | null;
  stderr_tail: string;
  tail: string;
}

/**
 * 로그인이 안 된(자격이 없는) 하네스가 남기는 말 — 사람에게 «AI 연결 필요» 로 바꿔 말한다(설계 §12 ④ «파일 존재 ≠ 유효»).
 *  ⚠ 맨 `/login` 은 넣지 않는다 — 작업이 고치던 파일 경로(`src/pages/login.tsx`)가 오류문에 실리면 «AI 연결 필요» 로 잘못 읽힌다(격리 리뷰 실측).
 */
export const AUTH_FAIL_RE = /(not logged in|please run \/login|invalid api key|authentication_error|oauth token (has )?expired|credit balance is too low)/i;

/**
 * (순수) 판의 마지막 보고 → 작업 상태·오류 문장.
 *  · 판이 끊었으면 그 사유(시간 초과 · 취소).
 *  · 하네스가 result 이벤트를 냈고 오류가 아니면 done — 종료코드가 0 이 아니어도 답이 있으면 답을 믿는다(하네스는 답을 내고 1 로 끝날 때가 있다).
 *  · 그 밖은 failed — 자격 문제로 보이면 «AI 연결 필요», 아니면 종료코드와 stderr 꼬리.
 */
export function finalOutcome(r: RunnerReport): { status: "done" | "failed" | "timeout" | "canceled"; error: string | null } {
  if (r.stopped === "canceled") return { status: "canceled", error: "취소했습니다" };
  if (r.stopped === "timeout") return { status: "timeout", error: "실행 시간 상한을 넘겨 멈췄습니다" };
  if (r.result && !r.result.is_error && typeof r.result.text === "string") return { status: "done", error: null };
  const blob = `${r.result?.text ?? ""}\n${r.stderr_tail ?? ""}`;
  if (AUTH_FAIL_RE.test(blob)) return { status: "failed", error: "AI 연결 필요 — 실행 계정의 Claude 로그인이 없거나 만료됐습니다" };
  if (r.result?.is_error) return { status: "failed", error: `하네스가 오류로 끝났습니다(${r.result.subtype ?? "error"}): ${(r.result.text ?? "").slice(0, 300)}` };
  const tail = (r.stderr_tail ?? "").trim().split("\n").slice(-3).join(" / ").slice(0, 400);
  return { status: "failed", error: `하네스가 답 없이 끝났습니다(종료코드 ${r.exit_code ?? "?"}${r.signal ? ` · ${r.signal}` : ""})${tail ? `: ${tail}` : ""}` };
}

/** (순수) 보고 본문을 모양대로 고른다 — 판이 보낸 것은 컨테이너 안(작업 AI 가 닿는 자리)에서 왔으므로 칸마다 거르고 자른다. */
export function parseRunnerReport(body: unknown): RunnerReport {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null => (typeof v === "string" ? wellFormed(noNul(v).slice(0, max)) : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const res = b.result && typeof b.result === "object" ? b.result as Record<string, unknown> : null;
  const usage = res?.usage && typeof res.usage === "object" && !Array.isArray(res.usage) ? res.usage as Record<string, unknown> : null;
  return {
    exit_code: int32(b.exit_code),
    signal: str(b.signal, 32),
    stopped: b.stopped === "timeout" || b.stopped === "canceled" ? b.stopped : null,
    conversation_id: convIdOf(b.conversation_id),
    model: str(b.model, 120),
    result: res ? {
      text: str(res.text, RESULT_TEXT_MAX),
      is_error: res.is_error === true,
      subtype: str(res.subtype, 60),
      num_turns: num(res.num_turns),
      duration_ms: num(res.duration_ms),
      cost_usd: num(res.cost_usd),
      usage: usage ? numericFields(usage) : null,
    } : null,
    stderr_tail: str(b.stderr_tail, STDERR_TAIL_MAX) ?? "",
    tail: str(b.tail, TAIL_MAX) ?? "",
  };
}

/**
 * (순수) 글에서 NUL 을 뺀다 — Postgres text·jsonb 는 `\u0000` 을 받지 않는다. 그대로 두면 보고 한 번이 500 이 되고, 판이 다시 보내다
 *  지쳐 빠지면 작업이 «응답 없음» 으로 끝나 결과가 사라진다.
 */
export function noNul(s: string): string {
  return s.includes("\u0000") ? s.split("\u0000").join("") : s;
}
/**
 * (순수) 짝 없는 서로게이트를 U+FFFD 로 — jsonb 는 `\ud83d` 같은 외톨이를 받지 않는다(«invalid input syntax for type json»).
 *  답이 상한에서 잘리며 이모지 한 쌍이 갈라지면 생긴다 — NUL 과 같은 계열(보고 한 번이 500 → 판이 지쳐 빠지면 결과 유실). 재리뷰 실측.
 */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}
/** 종료코드 — INT 칸에 들어가는 정수만(1.5 · 1e12 는 버린다). */
function int32(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? v : null;
}

/** 사용량은 숫자 칸만 남긴다(토큰 수 등) — 이름은 짧은 영숫자, 칸은 많아야 24개. 중첩·문자열은 버린다. */
function numericFields(o: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) {
    if (Object.keys(out).length >= 24) break;
    if (/^[a-z0-9_]{1,64}$/i.test(k) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 하네스 대화 id 모양 — claude 는 UUID. 그 밖의 값은 버린다(이어받기 인자로 쓰이므로 argv 에 들어간다). */
export const CONV_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function convIdOf(v: unknown): string | null {
  return typeof v === "string" && CONV_ID_RE.test(v) ? v.toLowerCase() : null;
}
