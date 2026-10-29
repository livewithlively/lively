// 게이트웨이 → 앱 서버 동기 부르기(#5053 앱 v2-42) — 판정만(순수). 신원의 글 모양 · 도구 라우트 · 함수 이벤트 · 앱 답 → 도구 결과.
//
//  모양(결정 상민 2026-10-28 — #5052 ① (나) claim): 앱이 선언한 MCP 도구(run.kind "server")를 사람이 부르면 게이트웨이가 그 앱 서버의 라우트를
//   **동기로** 부른다(Lambda 흘려 받기 — 사람 요청과 같은 길 · 같은 30초 · 같은 처리 중 상한). 부를 때 이벤트의 X-Lively-Identity 에 «부르기 신원»
//   (lvsc1.<부르기>.<한 번 쓰는 비밀>)을 싣고, 함수 안 검사 층(app-server-guard 5 판)이 앱 코드보다 먼저 게이트웨이에 «이 부르기 시작»(claim)을
//   확인받는다 — 백그라운드 작업(#4486 lvjc1 → lvjr1)과 같은 꼴이라 서명 키(공개 키)를 쓰지 않는다(자가호스팅 박스에서도 키 없이 돈다).
//   claim 을 받으면 검사 층은 «돌기 신원»(lvsr1.…)과 부른 사람을 받아 앱에 넘기고(사람 요청과 같은 머리글), 앱의 SDK 가 그것을 다시 실어
//   게이트웨이를 부른다(부른 사람 ∩ 그 사람의 앱 동의 ∩ 그 연결(토큰)의 권한 — 부르기가 도는 동안만). 답은 흘려 받은 그대로 도구 결과가 된다.
//  ★ 작업 신원(lvj*)과는 앞머리로 갈린다 — 검사 층은 부르기 신원만, 게이트웨이는 돌기 신원만 받는다(돌기 신원으로 함수를 직접 불러 다시 시작하지 못하게).
//   DB 에는 비밀의 sha256 만 둔다(org_app_call · app-server-call-store).
//  이 파일은 DB · AWS · HTTP 를 모른다 — app-server-call.ts 가 사실을 모아 여기 묻는다.
import { JOB_ROUTE_MAX, routePostEvent } from "./app-jobs-plan.js";

/** 부르기 신원 — 게이트웨이가 함수를 부를 때 싣는다(검사 층만 쓴다 · claim 한 번). */
export const CALL_PREFIX = "lvsc1";
/** 돌기 신원 — claim 이 돌려준다(검사 층이 앱에 넘기고 앱의 SDK 가 게이트웨이 호출에 다시 싣는다 · 부르기가 끝나면 못 쓴다). */
export const CALL_RUN_PREFIX = "lvsr1";
/** 검사 층(app-server-guard GUARD_VERSION) 판 — 이 판부터 동기 부르기를 받는다. 그 전 판의 함수는 다시 올려야 한다(app_server_outdated). */
export const CALL_GUARD_MIN = 5;
/** 부른 뒤 이만큼 안에 claim 이 와야 한다(초) — 동기 부르기는 곧바로 닿는다(차가운 시작 1초 안팎). 늦게 닿은 부르기는 시작하지 않는다. */
export const CALL_CLAIM_WINDOW_SEC = 60;
/** 돌기 신원의 수명 = 요청 시간 + 이만큼(초) — 게이트웨이가 끝맺지 못한 부르기(그사이 교대 · 죽음)의 신원이 계속 살지 않게. */
export const CALL_RUN_GRACE_SEC = 30;
/** 도구 인자(JSON) 상한(바이트) — 검사 층이 claim 전에 본문을 다 받아 둔다(app-server-guard CALL_BODY_MAX 와 같은 값). */
export const CALL_BODY_MAX = 1024 * 1024;
/** 끝난 부르기 행을 남기는 날 — 누구 이름으로 어느 도구가 돌았나의 기록(인자 · 답은 적지 않는다). */
export const CALL_KEEP_DAYS = 7;

const CRED_RE = /^(lvsc1|lvsr1)\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{32,128})$/;

export interface CallCredential { kind: "call" | "run"; id: number; secret: string }
export function callCredential(kind: "call" | "run", id: number, secret: string): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`부르기 id 형식 밖: ${id}`);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new Error("부르기 비밀 형식 밖");
  return `${kind === "call" ? CALL_PREFIX : CALL_RUN_PREFIX}.${id}.${secret}`;
}
/** 부르기 신원을 읽는다 — 모양이 아니면 null(사람 신원 · 작업 신원 · 빈 값 · 잘린 값). */
export function parseCallCredential(raw: unknown): CallCredential | null {
  const s = String((Array.isArray(raw) ? raw[0] : raw) ?? "").trim();
  const m = CRED_RE.exec(s);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id)) return null;
  return { kind: m[1] === CALL_PREFIX ? "call" : "run", id, secret: m[3]! };
}
/** 사람 신원 대신 부르기 신원 모양인가(앞머리만 — 게이트웨이가 갈래를 고를 때). */
export const looksLikeCallCredential = (raw: unknown): boolean =>
  /^lvs[cr]1\./.test(String((Array.isArray(raw) ? raw[0] : raw) ?? "").trim());

// ── 선언의 라우트 ────────────────────────────────────────────────────────────────────────
/**
 * run.route → 부를 경로(+ 쿼리). «/api/tools/ask» 또는 «POST /api/tools/ask» — 도구는 늘 POST(인자를 JSON 본문으로)로 부른다.
 *  `/_lively/*` 는 앱 주소 앞단이 앱으로 보내지 않는 우리 자리라 받지 않는다(검사 층의 준비 판정 자리도 그 아래다). 틀리면 사람에게 보일 까닭.
 */
export function serverToolRouteOf(raw: unknown): { route: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "run.route(도구를 받을 앱 서버 라우트 — 예 \"POST /api/tools/ask\")가 필요합니다" };
  let route = raw.trim();
  const m = /^([A-Za-z]+)\s+(\S.*)$/.exec(route);
  if (m) {
    if (m[1]!.toUpperCase() !== "POST") return { error: `server 도구는 POST 로만 부릅니다(인자를 JSON 본문으로 보낸다) — '${m[1]}' 는 쓸 수 없습니다` };
    route = m[2]!;
  }
  if (route.length > JOB_ROUTE_MAX) return { error: `run.route 가 너무 깁니다(${JOB_ROUTE_MAX}자까지)` };
  if (!route.startsWith("/") || route.startsWith("//")) return { error: "run.route 는 / 로 시작하는 앱 안 경로여야 합니다(예 \"POST /api/tools/ask\")" };
  if (/[^\x21-\x7e]|\\/.test(route)) return { error: "run.route 에는 ASCII 글자만 씁니다 — 빈칸 · 제어문자 · 한글 같은 글자는 인코딩하세요 · 역슬래시는 쓸 수 없습니다" };
  const path = route.split("?")[0]!.toLowerCase();
  if (path === "/_lively" || path.startsWith("/_lively/")) return { error: "/_lively/* 는 라이블리 자리라 도구 라우트로 쓸 수 없습니다" };
  return { route };
}

/** 도구 부르기 → 함수 이벤트(POST · 본문 = 그 판의 입력으로 검사한 인자 JSON). */
export function callInvokeEvent(c: { id: number; route: string; body: string }, credential: string, host: string, now: number): Record<string, unknown> {
  return routePostEvent({ route: c.route, body: c.body, credential, host, now, requestId: `call-${c.id}`, userAgent: "lively-mcp-tool/1" });
}

// ── 앱의 답 → 도구 결과 ───────────────────────────────────────────────────────────────────
/** 흘려 받은 앱 서버의 답(게이트웨이가 모은 것) — body 는 앞 cap 바이트까지, bytes 는 전체 크기. */
export interface ServerCallReply { status: number; headers: Record<string, string>; body: Buffer; bytes: number }

/** 도구 결과 — ok 면 data(글 · JSON 값 · 잘렸으면 앞부분 글과 원래 크기 truncatedFrom), 아니면 도구 오류(status · code · 사람이 읽을 글). */
export type ToolReply =
  | { ok: true; data: unknown; truncatedFrom?: number }
  | { ok: false; status: number; code: string; message: string };

const isJsonType = (ct: string): boolean => /^application\/(?:[\w.+-]+\+)?json\b/i.test(ct.trim());
const isTextType = (ct: string): boolean => ct.trim() === "" || /^text\//i.test(ct.trim());
/** 앱이 보낸 오류 글 — JSON 의 message · error(글자)를 먼저, 아니면 본문 앞부분. 사람 · AI 가 읽을 만큼만. */
function appMessageOf(body: Buffer, ct: string): string {
  const text = body.toString("utf8");
  if (isJsonType(ct)) {
    try {
      const o = JSON.parse(text) as { message?: unknown; error?: unknown };
      const m = typeof o?.message === "string" ? o.message : typeof o?.error === "string" ? o.error : null;
      if (m) return m.slice(0, 1000);
    } catch { /* 본문 그대로 */ }
  }
  return text.trim().slice(0, 1000);
}

/**
 * 앱 서버의 답 → 도구 결과. 검사 층이 직접 낸 답(x-lively-guard)이 먼저다 — 시간 초과 · 신원 거부 · 앱에 못 닿음 · 앱의 잘못된 답.
 *  그다음 앱의 답: 2xx 면 결과(JSON 이면 값 · 글이면 글 · 그 밖의 종류는 오류 — 도구 라우트는 JSON 이나 글로 답한다), 3xx · 4xx · 5xx 면 앱의 글을 실은 오류.
 *  잘린 본문(bytes > body)은 JSON 으로 읽지 않는다(반쪽 JSON) — 글로 넘기면 틀이 잘림 표시를 붙인다.
 */
export function toolReplyOf(r: ServerCallReply, timeoutS: number): ToolReply {
  const guard = (r.headers["x-lively-guard"] ?? "").trim();
  const ct = r.headers["content-type"] ?? "";
  if (guard) {
    if (guard === "timeout") {
      return { ok: false, status: 504, code: "app_server_timeout", message: `앱 서버가 제때 답하지 않았습니다 — 도구 하나는 ${timeoutS}초까지입니다. 더 긴 일은 앱이 백그라운드 작업으로 넘겨야 합니다` };
    }
    if (guard === "denied") {
      let why = "";
      try { const o = JSON.parse(r.body.toString("utf8")) as { reason?: unknown; error?: unknown }; why = String(o?.reason ?? o?.error ?? ""); } catch { /* 까닭 없음 */ }
      return { ok: false, status: 502, code: "app_server_identity", message: `앱 서버의 검사 층이 이 부르기를 받지 않았습니다${why ? `(${why.slice(0, 80)})` : ""} — 잠시 뒤 다시 하세요` };
    }
    if (guard === "app-unreachable") return { ok: false, status: 502, code: "app_server_unavailable", message: "앱 서버 프로그램에 닿지 못했습니다 — 앱을 만든 사람이 서버 기록을 확인해야 합니다" };
    return { ok: false, status: 502, code: "app_server_error", message: "앱 서버가 이 도구 부르기를 처리하지 못했습니다 — 앱을 만든 사람이 서버 기록을 확인해야 합니다" };
  }
  if (r.status >= 300 && r.status < 400) {
    return { ok: false, status: 502, code: "app_error", message: `앱 서버가 다른 주소로 보냈습니다(HTTP ${r.status}) — 도구 라우트는 직접 답해야 합니다` };
  }
  if (r.status >= 400) {
    const msg = appMessageOf(r.body, ct);
    return { ok: false, status: r.status, code: "app_error", message: `앱 서버가 오류로 답했습니다(HTTP ${r.status})${msg ? `: ${msg}` : ""}` };
  }
  if (!isJsonType(ct) && !isTextType(ct)) {
    return { ok: false, status: 502, code: "app_bad_result", message: `앱 서버가 글이 아닌 답(${ct.split(";")[0]!.trim().slice(0, 80)})을 보냈습니다 — 도구 라우트는 JSON 이나 글로 답해야 합니다` };
  }
  const text = r.body.toString("utf8");
  if (r.bytes > r.body.length) return { ok: true, data: text, truncatedFrom: r.bytes };
  if (!isJsonType(ct) || !text.trim()) return { ok: true, data: text };
  try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; }
}
