// 앱 백그라운드 작업(#4486 앱 v2-7) — 판정만(순수). 무엇을 받을지 · 작업 신원의 글 모양 · 검사 층의 보고를 어떤 상태로 적을지 · 감시가 무엇을 할지.
//
//  모양(설계 §3-C 실행 3단의 ② · 결정 상민 2026-10-20 — 태스크 #4486 댓글 539):
//   앱 서버(또는 앱 화면)가 «이 라우트를 뒤에서 돌려 달라» 고 하면 게이트웨이가 줄을 세우고(org_app_job), 자리가 나면 그 앱의 함수를 **비동기로** 부른다
//   (Lambda InvocationType=Event — 앞단 · 라우터 시한과 무관하게 함수 시간 15분까지). 부를 때 이벤트에 «한 번 쓰는 비밀»(부르기 신원)을 싣고,
//   함수 안 검사 층이 앱 코드보다 먼저 게이트웨이에 «이 작업 시작»(claim)을 확인받는다 — 이미 시작했거나 · 취소됐거나 · 비밀이 틀리면 앱 코드에 닿기 전에 거부.
//   AWS 는 같은 비동기 호출을 두 번 보낼 수 있고 실패하면 1분 · 2분 뒤 다시 부른다(공식 문서) — «한 번만» 은 게이트웨이 DB 만 기억할 수 있어서
//   서명(v2-0 ⑤-4 초안) 대신 이 확인 하나로 위조 · 재전송을 함께 막는다. 확인을 받으면 검사 층은 «도는 동안의 신원»(돌기 신원)을 받아 앱에 넘기고,
//   앱의 SDK 가 그것을 다시 실어 게이트웨이를 부른다(작업을 시작한 사람 ∩ 그 사람의 앱 동의 — 사람이 누른 요청과 같은 권한). 끝나면 검사 층이 결과를 보고한다.
//  이 파일은 DB · AWS · HTTP 를 모른다 — app-jobs.ts 가 사실을 모아 여기 묻는다(엣지 표로 시험한다).
import type { AppServerPolicy } from "./app-server-policy.js";

export type AppJobStatus = "queued" | "dispatched" | "running" | "done" | "failed" | "canceled";
/** 열린 작업 — 함수 판 · 토큰을 붙잡는다(배포가 회수 · 정리하지 않는다). */
export const OPEN_JOB_STATUSES: readonly AppJobStatus[] = Object.freeze(["queued", "dispatched", "running"]);
export const isJobEnded = (s: string): boolean => s === "done" || s === "failed" || s === "canceled";

/** 검사 층(app-server-guard) 판 — 이 판부터 작업을 받는다. 그 전 판의 함수는 다시 올려야 한다(app_server_outdated 와 같은 안내). */
export const JOB_GUARD_MIN = 4;
/** 라우트(경로 + 쿼리) 상한. */
export const JOB_ROUTE_MAX = 2048;
export const JOB_LABEL_MAX = 200;
/** 검사 층이 보고하는 앱 응답 본문 상한(바이트) — 그 너머는 버리고 truncated 를 단다. */
export const JOB_RESULT_MAX = 64 * 1024;
/** 오류 글 상한(문자). */
export const JOB_ERROR_MAX = 2000;
/** 작업이 시작한 작업의 깊이 상한 — 작업 안에서 다음 작업을 시작할 수 있다(나눠 돌리기). 끝없이 이어지지 않게. */
export const JOB_DEPTH_MAX = 3;
/** 검사 층의 박동 간격(초) — 이 사이에 취소를 알아챈다. */
export const JOB_TICK_SEC = 20;
/** 박동이 이만큼 없으면 함수가 죽었거나 시간이 넘은 것으로 본다(초). */
export const JOB_SILENT_SEC = 90;
/** 부른 뒤 이만큼 시작(claim)이 없으면 다시 부른다(초) — 차가운 시작 · Lambda 의 1분 · 2분 뒤 다시 하기보다 길게. */
export const JOB_DISPATCH_RETRY_SEC = 240;
/** 부르기 시도 상한 — 넘으면 «시작하지 못함». */
export const JOB_DISPATCH_ATTEMPTS = 3;
/** 함수 시간을 넘긴 뒤 결과 보고를 기다리는 여유(초). */
export const JOB_TIMEOUT_GRACE_SEC = 60;
/** «끝날 때까지 기다리기» 상한(초) — 앞단 · 라우터 시한(30초) 안. */
export const JOB_WAIT_MAX_SEC = 25;

// ── 작업 신원(글 모양) ──────────────────────────────────────────────────────────────────
//  부르기 신원 `lvjc1.<작업 id>.<비밀>` — 게이트웨이가 함수를 부를 때 이벤트의 X-Lively-Identity 에 싣는다. 검사 층만 쓴다(claim 한 번).
//  돌기 신원 `lvjr1.<작업 id>.<비밀>` — claim 이 돌려준다. 검사 층이 앱에 넘기고 앱의 SDK 가 게이트웨이 호출에 다시 싣는다(작업이 끝나면 못 쓴다).
//  ★ 사람 신원(`v1.<kid>.…` — app-identity.ts)과 앞머리로 갈린다. 게이트웨이는 돌기 신원만 받고(부르기 신원 거부), 검사 층은 부르기 신원만 받는다
//   (돌기 신원으로 함수를 직접 불러 작업을 다시 시작하지 못하게). DB 에는 비밀의 sha256 만 둔다.
export const JOB_CALL_PREFIX = "lvjc1";
export const JOB_RUN_PREFIX = "lvjr1";
const CRED_RE = /^(lvjc1|lvjr1)\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{32,128})$/;

export interface JobCredential { kind: "call" | "run"; id: number; secret: string }
export function jobCredential(kind: "call" | "run", id: number, secret: string): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`작업 id 형식 밖: ${id}`);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new Error("작업 비밀 형식 밖");
  return `${kind === "call" ? JOB_CALL_PREFIX : JOB_RUN_PREFIX}.${id}.${secret}`;
}
/** 작업 신원을 읽는다 — 모양이 아니면 null(사람 신원 · 빈 값 · 잘린 값). */
export function parseJobCredential(raw: unknown): JobCredential | null {
  const s = String((Array.isArray(raw) ? raw[0] : raw) ?? "").trim();
  const m = CRED_RE.exec(s);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id)) return null;
  return { kind: m[1] === JOB_CALL_PREFIX ? "call" : "run", id, secret: m[3]! };
}
/** 사람 신원 대신 작업 신원 모양인가(앞머리만 — 게이트웨이가 갈래를 고를 때). */
export const looksLikeJobCredential = (raw: unknown): boolean =>
  /^lvj[cr]1\./.test(String((Array.isArray(raw) ? raw[0] : raw) ?? "").trim());

// ── 받을 것 ──────────────────────────────────────────────────────────────────────────────
/** 작업 상한(앱 서버 상한 app_server_policy 의 작업 칸 — 관리자 app_server_limits_set). */
export type AppJobPolicy = Pick<AppServerPolicy, "job_timeout_s" | "jobs_running_workspace" | "jobs_running_app" | "jobs_queued_app" | "jobs_daily_app" | "job_wait_s" | "job_body_kb">;

/**
 * 라우트(경로 + 쿼리)를 본다 — 틀리면 사람에게 보일 까닭, 맞으면 null.
 *  `/_lively/*` 는 앱 주소 앞단이 앱으로 보내지 않는 우리 자리라 받지 않는다(검사 층의 준비 판정 자리도 그 아래다).
 */
export function jobRouteError(route: unknown): string | null {
  if (typeof route !== "string" || !route) return "route(작업으로 돌릴 앱 라우트 — 예 /api/jobs/transcribe)가 필요합니다";
  if (route.length > JOB_ROUTE_MAX) return `route 가 너무 깁니다(${JOB_ROUTE_MAX}자까지)`;
  if (!route.startsWith("/") || route.startsWith("//")) return "route 는 / 로 시작하는 앱 안 경로여야 합니다(예 /api/jobs/transcribe)";
  //  ASCII 보이는 글자만 — 빈칸 · 제어문자 · 한글 같은 글자는 인코딩해서 보낸다(이벤트의 경로 · 쿼리는 그대로 앱에 가고, 인코딩하지 않은 글자를
  //   웹 어댑터 · 앱이 어떻게 읽을지 정해져 있지 않다 — 받기 전에 까닭을 말하는 편이 «시작하지 못했습니다» 보다 낫다 · 격리 리뷰).
  if (/[^\x21-\x7e]|\\/.test(route)) return "route 에는 ASCII 글자만 씁니다 — 빈칸 · 제어문자 · 한글 같은 글자는 인코딩하세요(encodeURIComponent · 예 ?title=%ED%9A%8C%EC%9D%98) · 역슬래시는 쓸 수 없습니다";
  const path = route.split("?")[0]!.toLowerCase();
  if (path === "/_lively" || path.startsWith("/_lively/")) return "/_lively/* 는 라이블리 자리라 작업 라우트로 쓸 수 없습니다";
  return null;
}

/**
 * 작업 종류 — 이 입구는 «앱 서버 라우트를 뒤에서»(function)만 받는다. 에이전트 작업(파일 · 도구를 반복해 쓰는 AI)은 작업 컨테이너의 몫이다(설계 §3-C ③).
 *  넘는 요청은 여기서 까닭과 갈 곳을 말하고 거부한다(태스크 «초과 요청은 명확히 거부 · 안내»).
 */
export function jobTypeError(type: unknown): string | null {
  if (type === undefined || type === null || type === "" || type === "function") return null;
  if (type === "agent") return "에이전트 작업(AI 가 파일 · 도구를 반복해 쓰는 일 · 15분 넘는 일)은 이 입구가 아니라 AI 실행 입구로 보내세요 — 앱 화면 /_lively/ai/runs · lively.ai.run · 앱 서버 POST /api/ui/ai-runs(작업 컨테이너에서 돈다)";
  return `type 은 "function"(앱 서버 라우트를 뒤에서 돌리기)만 받습니다 — 받은 값: ${JSON.stringify(type).slice(0, 40)}`;
}

/** 요청한 시간 상한(초) — 함수 시간(job_timeout_s) 안이면 그 값(생략하면 함수 시간), 넘으면 까닭. */
export function jobTimeoutOf(want: unknown, p: Pick<AppJobPolicy, "job_timeout_s">): { timeout: number } | { error: string } {
  if (want === undefined || want === null || want === "") return { timeout: p.job_timeout_s };
  const n = typeof want === "number" ? want : Number(want);
  if (!Number.isInteger(n) || n < 1) return { error: "timeout_s 는 1 이상의 정수(초)여야 합니다" };
  if (n > p.job_timeout_s) {
    return { error: `백그라운드 작업은 한 번에 ${Math.floor(p.job_timeout_s / 60)}분(${p.job_timeout_s}초)까지입니다 — 더 긴 일은 여러 작업으로 나누거나(작업이 다음 작업을 시작한다 · ${JOB_DEPTH_MAX}단계까지), ` +
      "에이전트 작업(작업 컨테이너 — /_lively/ai/runs · lively.ai.run)으로 보내세요" };
  }
  return { timeout: n };
}

/** 요청 본문 → 함수에 실을 JSON 글. 생략하면 «{}». 상한(job_body_kb) 밖이면 까닭(큰 자료는 앱 폴더 · 파일 주소로 두고 경로를 넘긴다). */
export function encodeJobBody(body: unknown, p: Pick<AppJobPolicy, "job_body_kb">): { json: string; bytes: number } | { error: string; status: number } {
  let json: string;
  try { json = body === undefined ? "{}" : JSON.stringify(body); } catch { return { error: "body 를 JSON 으로 만들 수 없습니다", status: 400 }; }
  if (json === undefined) return { error: "body 를 JSON 으로 만들 수 없습니다", status: 400 };
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > p.job_body_kb * 1024) {
    return { error: `작업 본문이 너무 큽니다(${Math.ceil(bytes / 1024)}KB > ${p.job_body_kb}KB) — 큰 자료(파일 · 녹음)는 앱 폴더나 파일 주소(file_url)에 두고 경로만 넘기세요`, status: 413 };
  }
  return { json, bytes };
}

/** 라벨 — 다듬고 자른다(목록에 보이는 짧은 이름). */
export const jobLabelOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return s ? s.slice(0, JOB_LABEL_MAX) : null;
};

/** 앱 상한(사람에게 보일 까닭) — 앱 대기 줄 · 앱 하루 작업 수. 통과면 null. 동시에 도는 수는 줄을 세워 기다린다(거부가 아니다). */
export function jobAdmissionError(p: AppJobPolicy, have: { queuedApp: number; dailyApp: number }): { status: number; error: string } | null {
  if (have.dailyApp >= p.jobs_daily_app) {
    return { status: 429, error: `이 앱의 백그라운드 작업이 하루 상한(${p.jobs_daily_app.toLocaleString("ko-KR")}건 · 최근 24시간)에 닿았습니다 — 관리자가 app_server_limits_set jobs_daily_app 으로 올릴 수 있습니다` };
  }
  if (have.queuedApp >= p.jobs_queued_app) {
    return { status: 429, error: `이 앱에서 기다리는 백그라운드 작업이 상한(${p.jobs_queued_app}개)에 닿았습니다 — 앞 작업이 끝난 뒤 다시 하세요` };
  }
  return null;
}

// ── 부르기 ──────────────────────────────────────────────────────────────────────────────
/** 라우트 → 함수 주소(Function URL) 모양 이벤트(순수 — 시험 대상). 웹 어댑터가 이것을 앱의 HTTP 요청(POST)으로 바꾼다. */
export function jobInvokeEvent(j: { id: number; route: string; body: string; attempts: number }, credential: string, host: string, now: number): Record<string, unknown> {
  //  본문은 늘 JSON(최소 «{}» — encodeJobBody) — 빈 글이면 본문을 읽지 않은 가벼운 줄을 잘못 넘긴 것이다. 조용히 빈 본문으로 부르지 않는다(격리 리뷰).
  if (!j.body) throw new Error(`작업 ${j.id} 의 본문이 없습니다(가벼운 줄로 부르려 했다)`);
  const i = j.route.indexOf("?");
  const rawPath = i < 0 ? j.route : j.route.slice(0, i);
  const rawQueryString = i < 0 ? "" : j.route.slice(i + 1);
  const headers: Record<string, string> = {
    host, "x-forwarded-host": host, "x-forwarded-proto": "https", "content-type": "application/json", "user-agent": "lively-job/1",
    "x-lively-identity": credential,
  };
  return {
    version: "2.0", routeKey: "$default", rawPath, rawQueryString, headers,
    requestContext: {
      accountId: "anonymous", apiId: "lively", domainName: host, domainPrefix: host.split(".")[0] ?? host,
      http: { method: "POST", path: rawPath, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "lively-job/1" },
      requestId: `job-${j.id}-${j.attempts}`, routeKey: "$default", stage: "$default", time: new Date(now).toUTCString(), timeEpoch: now,
    },
    body: Buffer.from(j.body, "utf8").toString("base64"), isBase64Encoded: true,
  };
}


// ── 검사 층의 보고 → 상태 ────────────────────────────────────────────────────────────────
/** 검사 층이 보고하는 끝 — response(앱이 답했다) · timeout(시간 상한) · canceled(취소를 알아챔) · app_unreachable · app_bad_response · guard_error. */
export type JobOutcome = "response" | "timeout" | "canceled" | "app_unreachable" | "app_bad_response" | "guard_error";
const OUTCOMES: ReadonlySet<string> = new Set(["response", "timeout", "canceled", "app_unreachable", "app_bad_response", "guard_error"]);

export interface JobResultReport {
  outcome: JobOutcome;
  status_code: number | null;
  content_type: string | null;
  /** 앱 응답 본문(앞 JOB_RESULT_MAX 바이트 · base64). */
  body_b64: string | null;
  truncated: boolean;
  bytes: number | null;
  duration_ms: number | null;
}

/** 보고를 다듬는다(모양이 틀린 칸은 버린다 — 상태는 outcome 이 정한다). outcome 이 모르는 값이면 guard_error 로 본다. */
export function normalizeResultReport(raw: unknown): JobResultReport {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const outcome = (OUTCOMES.has(String(o.outcome)) ? String(o.outcome) : "guard_error") as JobOutcome;
  const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const b64 = typeof o.body_b64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(o.body_b64) ? o.body_b64 : null;
  //  base64 를 풀어 상한을 다시 본다 — 검사 층이 상한을 어겨도 DB 한 칸이 커지지 않게.
  let body = b64;
  let truncated = o.truncated === true;
  if (b64) {
    const buf = Buffer.from(b64, "base64");
    if (buf.length > JOB_RESULT_MAX) { body = buf.subarray(0, JOB_RESULT_MAX).toString("base64"); truncated = true; }
  }
  const ct = typeof o.content_type === "string" ? o.content_type.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) : null;
  return {
    outcome, status_code: int(o.status_code, 100, 599), content_type: ct || null, body_b64: body, truncated,
    bytes: int(o.bytes, 0, Number.MAX_SAFE_INTEGER), duration_ms: int(o.duration_ms, 0, 7 * 24 * 3600 * 1000),
  };
}

/** 저장할 결과(사람 · 앱이 읽는 꼴) — JSON 이면 json, 글이면 text, 그 밖은 base64. */
export interface JobResultView { status_code: number | null; content_type: string | null; json?: unknown; text?: string; base64?: string; truncated: boolean; bytes: number | null }

export function resultViewOf(r: JobResultReport): JobResultView | null {
  if (r.outcome !== "response") return null;
  const out: JobResultView = { status_code: r.status_code, content_type: r.content_type, truncated: r.truncated, bytes: r.bytes };
  if (!r.body_b64) return out;
  const buf = Buffer.from(r.body_b64, "base64");
  const ct = (r.content_type ?? "").toLowerCase();
  //  ⚠ NUL(U+0000)이 든 글은 글로 두지 않는다 — Postgres 는 jsonb 의 \u0000 을 받지 않아 결과 기록이 통째로 실패한다(격리 리뷰). 그 응답은 base64 로.
  const asText = (): string | null => { const s = buf.toString("utf8"); return Buffer.from(s, "utf8").equals(buf) && !s.includes("\u0000") ? s : null; };
  if (/\bjson\b/.test(ct) && !r.truncated) {
    const s = asText();
    if (s !== null) {
      try {
        const v: unknown = JSON.parse(s);
        //  글에 NUL 이 없어도 이스케이프(«\u0000»)로 들어올 수 있다 — 다시 써 본 글에 홀로 선 \u0000 · 짝 없는 서로게이트(\ud800~\udfff —
        //   이모지 가운데를 자른 글)가 있으면 base64 로(jsonb 가 둘 다 받지 않는다 · 너무 깊어 못 쓰는 것도).
        if (!JSONB_BAD_ESCAPE_RE.test(JSON.stringify(v))) { out.json = v; return out; }
      } catch { /* 글 · base64 로 둔다 */ }
    }
  }
  const s = asText();
  if (s !== null && (!ct || /^text\/|json|xml|javascript|x-www-form-urlencoded/.test(ct))) out.text = s;
  else out.base64 = r.body_b64;
  return out;
}

/**
 * JSON.stringify 결과 안의 jsonb 가 받지 않는 이스케이프 — NUL(\u0000)과 짝 없는 서로게이트(\ud800~\udfff). 앞의 역슬래시가 홀수 개일 때만 진짜
 *  이스케이프다(«\\u0000» 은 역슬래시 글자 + u0000). JSON.stringify 는 짝 맞는 서로게이트는 글자 그대로, 짝 없는 것만 소문자 \ud… 로 쓴다(ES2019).
 */
const JSONB_BAD_ESCAPE_RE = /(?:^|[^\\])(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/;

/** 보고 → 끝 상태 · 오류 글. 앱이 2xx 로 답했으면 done, 그 밖은 failed(앱이 고를 수 있게 상태 · 본문을 함께 남긴다). */
export function endOf(r: JobResultReport, ctx: { timeoutSec: number; cancelRequested: boolean }): { status: "done" | "failed" | "canceled"; error: string | null } {
  switch (r.outcome) {
    case "response": {
      const c = r.status_code ?? 0;
      if (c >= 200 && c < 300) return { status: "done", error: null };
      return { status: "failed", error: `앱 라우트가 ${c || "?"} 로 답했습니다${snippetOf(r) ? ` — ${snippetOf(r)}` : ""}` };
    }
    case "canceled": return { status: "canceled", error: "취소했습니다" };
    case "timeout":
      if (ctx.cancelRequested) return { status: "canceled", error: "취소했습니다" };
      return { status: "failed", error: `작업 시간 상한(${ctx.timeoutSec}초 — 함수가 끝나기 15초 전이 더 이르면 그때)을 넘어 검사 층이 끊었습니다 — 더 긴 일은 여러 작업으로 나누거나 에이전트 작업으로 보내세요` };
    case "app_unreachable": return { status: "failed", error: "앱 서버에 닿지 못했습니다(서버가 뜨지 않았거나 작업 도중 끝났습니다)" };
    case "app_bad_response": return { status: "failed", error: "앱 서버가 HTTP 응답으로 읽을 수 없는 답을 보냈습니다" };
    default: return { status: "failed", error: "앱 서버 앞의 검사 층이 작업을 끝맺지 못했습니다" };
  }
}

/** 오류 글에 덧붙일 앱 응답 앞부분(글이면 한 줄로 · 200자). */
function snippetOf(r: JobResultReport): string {
  if (!r.body_b64) return "";
  const s = Buffer.from(r.body_b64, "base64").toString("utf8").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 200);
}

// ── 감시(하우스키핑) ────────────────────────────────────────────────────────────────────
export interface SweepJobFacts {
  status: AppJobStatus;
  created_at: Date;
  dispatched_at: Date | null;
  claimed_at: Date | null;
  last_tick_at: Date | null;
  attempts: number;
  timeout_s: number;
  cancel_requested: boolean;
}
export type SweepAction =
  | { kind: "none" }
  | { kind: "requeue" }                                         // 부른 뒤 시작이 없다 — 새 비밀로 다시 부른다
  | { kind: "end"; status: "failed" | "canceled"; error: string };

/** (순수) 열린 작업 하나를 감시가 어떻게 할까. now = 지금(ms). */
export function sweepVerdict(j: SweepJobFacts, now: number, p: Pick<AppJobPolicy, "job_wait_s">): SweepAction {
  const ageS = (d: Date | null): number => (d ? (now - d.getTime()) / 1000 : Infinity);
  if (j.status === "queued") {
    if (j.cancel_requested) return { kind: "end", status: "canceled", error: "취소했습니다" };
    if (ageS(j.created_at) > p.job_wait_s) {
      return { kind: "end", status: "failed", error: `기다리는 시간 상한(${Math.round(p.job_wait_s / 60)}분)을 넘었습니다 — 이 앱 · 워크스페이스의 동시 작업 상한에 막혀 있었습니다` };
    }
    return { kind: "none" };
  }
  if (j.status === "dispatched") {
    if (j.cancel_requested) return { kind: "end", status: "canceled", error: "취소했습니다" };
    if (ageS(j.dispatched_at) <= JOB_DISPATCH_RETRY_SEC) return { kind: "none" };
    if (j.attempts < JOB_DISPATCH_ATTEMPTS) return { kind: "requeue" };
    return { kind: "end", status: "failed", error: `앱 서버가 작업을 시작하지 못했습니다(${j.attempts}번 불렀지만 응답이 없습니다 — 서버가 뜨지 못했거나 막혀 있습니다)` };
  }
  if (j.status === "running") {
    const over = ageS(j.claimed_at) > j.timeout_s + JOB_TIMEOUT_GRACE_SEC;
    const silent = ageS(j.last_tick_at ?? j.claimed_at) > JOB_SILENT_SEC;
    if (!over && !silent) return { kind: "none" };
    if (j.cancel_requested) return { kind: "end", status: "canceled", error: "취소했습니다" };
    if (over) return { kind: "end", status: "failed", error: `작업 시간 상한(${j.timeout_s}초)을 넘었습니다 — 함수가 끝맺지 못했습니다` };
    return { kind: "end", status: "failed", error: `앱 서버가 작업 도중 응답을 멈췄습니다(${JOB_SILENT_SEC}초 넘게 소식 없음 — 서버 프로그램이 죽었거나 함수가 끝났습니다)` };
  }
  return { kind: "none" };
}

// ── 보기 ──────────────────────────────────────────────────────────────────────────────────
export interface AppJobRowLike {
  id: number; app_id: string; status: AppJobStatus; requester: string; variant: "pub" | "draft"; alias: "cur" | "pub";
  route: string; label: string | null; body_bytes: number; timeout_s: number; parent_id: number | null; depth: number; attempts: number;
  status_code: number | null; result: JobResultView | null; error: string | null; cancel_requested: boolean; duration_ms: number | null;
  created_at: Date | string; dispatched_at: Date | string | null; claimed_at: Date | string | null; ended_at: Date | string | null;
}
const iso = (d: Date | string | null): string | null => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/**
 * 사람 · 앱이 보는 꼴. full = 작업을 시작한 사람(또는 그 앱의 같은 사람) — 결과 본문까지. 아니면(관리자가 남의 작업) 상태 · 오류만(AI 실행 · 작업 컨테이너와 같은 선).
 *  요청 본문은 싣지 않는다(크기만) — 앱이 보낸 자료라 앱이 이미 갖고 있다.
 */
export function jobView(r: AppJobRowLike, full: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: r.id, app_id: r.app_id, status: r.status, label: r.label, requester: r.requester,
    created_at: iso(r.created_at), started_at: iso(r.claimed_at), ended_at: iso(r.ended_at), duration_ms: r.duration_ms,
    error: r.error, cancel_requested: r.cancel_requested,
  };
  if (!full) return base;
  return {
    ...base, route: r.route, variant: r.variant, body_bytes: r.body_bytes, timeout_s: r.timeout_s, attempts: r.attempts,
    parent_id: r.parent_id, depth: r.depth, dispatched_at: iso(r.dispatched_at), status_code: r.status_code, result: r.result,
  };
}
