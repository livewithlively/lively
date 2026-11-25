// 슬랙 다리(#1782) — 슬랙 Web API 부르기. 주소는 https://slack.com/api/<메서드> 로 고정이고(메서드 이름만 바뀐다) 토큰은 이 함수 안에서만 산다 —
//  응답 · 오류 글에 토큰을 싣지 않는다. 시험은 base · fetch 를 바꿔 끼운다.
import { formBodyOf, isSlackFileUrl } from "./plan.js";

export const SLACK_API_BASE = "https://slack.com/api";
/** 응답 상한 — 앱에 돌려주는 슬랙 응답(conversations.replies 한 판 등)이 넉넉히 들어가는 크기. */
export const SLACK_RESPONSE_MAX = 512 * 1024;

export interface SlackApiDeps {
  base: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** 파일을 내려받아도 되는 주소인가(slackDownload) — 없으면 슬랙 파일 서버만(plan.isSlackFileUrl). 시험이 가짜 슬랙의 주소를 받게 바꿔 끼운다. */
  fileUrlOk?: (url: string) => boolean;
}
let apiOverride: SlackApiDeps | null = null;
/** 시험 전용 — 가짜 슬랙(로컬 서버)을 꽂는다. null 이면 되돌린다. 운영 코드는 부르지 않는다. */
export function setSlackApiForTest(d: SlackApiDeps | null): void { apiOverride = d; }
export const liveSlackApi = (): SlackApiDeps => apiOverride ?? ({ base: SLACK_API_BASE, fetch: (u, i) => fetch(u, i) });

export interface SlackResult {
  /** HTTP 상태 */
  status: number;
  /** 슬랙 응답(JSON). 슬랙은 실패도 HTTP 200 + { ok:false, error } 로 준다. JSON 이 아니면 null. */
  body: Record<string, unknown> | null;
  /** 응답이 상한을 넘어 잘렸나(그러면 body 는 null) */
  truncated: boolean;
}

/** 이 호출이 성공인가 — HTTP 2xx 이고 { ok: true }. */
export const slackOk = (r: SlackResult): boolean => r.status >= 200 && r.status < 300 && r.body?.ok === true;
/** 실패 까닭(슬랙 error 글 또는 HTTP 상태). */
export const slackError = (r: SlackResult): string =>
  r.truncated ? "응답이 너무 큽니다" : typeof r.body?.error === "string" ? r.body.error : r.status >= 200 && r.status < 300 ? "ok:false" : `HTTP ${r.status}`;

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return { text: "", truncated: true }; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), truncated: false };
}

/**
 * 메서드 하나를 부른다 — POST · JSON(쓰기 메서드) 또는 form 본문. 연결 실패 · 시간 초과는 던진다(토큰 없는 글로).
 *  메서드 이름은 «영문 · 점» 만 — 주소의 경로 한 칸으로만 들어간다.
 */
export async function slackCall(token: string, method: string, args: Record<string, unknown>, o: { json: boolean }, d: SlackApiDeps): Promise<SlackResult> {
  if (!/^[a-zA-Z]+(\.[a-zA-Z]+)+$/.test(method)) throw new Error(`슬랙 메서드 이름이 아닙니다: ${method.slice(0, 40)}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), d.timeoutMs ?? 10_000);
  try {
    const res = await d.fetch(`${d.base}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": o.json ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
        "User-Agent": "lively-slack-bridge",
      },
      body: o.json ? JSON.stringify(args) : formBodyOf(args),
      signal: ac.signal,
      redirect: "error",
    });
    const { text, truncated } = await readCapped(res, SLACK_RESPONSE_MAX);
    let body: Record<string, unknown> | null = null;
    if (!truncated) {
      try { const j = JSON.parse(text) as unknown; body = j && typeof j === "object" && !Array.isArray(j) ? j as Record<string, unknown> : null; } catch { body = null; }
    }
    return { status: res.status, body, truncated };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new Error(name === "AbortError" ? `슬랙 ${method} 응답이 늦습니다(시간 초과)` : `슬랙 ${method} 에 닿지 못했습니다: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** apps.connections.open — 앱 수준 토큰으로 이번 연결의 소켓 주소를 받는다(주소는 한 번 쓴다). */
export async function openSocketUrl(appToken: string, d: SlackApiDeps): Promise<string> {
  const r = await slackCall(appToken, "apps.connections.open", {}, { json: false }, d);
  if (!slackOk(r) || typeof r.body?.url !== "string") throw new Error(`apps.connections.open 실패: ${slackError(r)}`);
  return r.body.url;
}

export interface BotAuth { user_id: string | null; bot_id: string | null; team_id: string | null; team: string | null }
/** auth.test — 봇 토큰이 살아 있나 · 봇 자신(글 거르기) · 워크스페이스. */
export async function botAuthTest(botToken: string, d: SlackApiDeps): Promise<BotAuth> {
  const r = await slackCall(botToken, "auth.test", {}, { json: false }, d);
  if (!slackOk(r)) throw new Error(`봇 토큰 확인(auth.test) 실패: ${slackError(r)}`);
  const b = r.body ?? {};
  const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return { user_id: s(b.user_id), bot_id: s(b.bot_id), team_id: s(b.team_id), team: s(b.team) };
}

export interface SlackUserFacts { email: string | null; deleted: boolean; is_bot: boolean; email_confirmed: boolean | null; team_id: string | null }
/** users.info — 사람 매핑의 마지막 길(이메일). 이메일은 봇에 users:read.email 이 있어야 온다. */
export async function slackUserFacts(botToken: string, user: string, d: SlackApiDeps): Promise<SlackUserFacts> {
  const r = await slackCall(botToken, "users.info", { user }, { json: false }, d);
  if (!slackOk(r)) throw new Error(`users.info 실패: ${slackError(r)}`);
  const u = (r.body?.user && typeof r.body.user === "object" ? r.body.user : {}) as Record<string, unknown>;
  const profile = (u.profile && typeof u.profile === "object" ? u.profile : {}) as Record<string, unknown>;
  const email = typeof profile.email === "string" && profile.email.includes("@") ? profile.email.trim().toLowerCase() : null;
  return {
    email, deleted: u.deleted === true, is_bot: u.is_bot === true || u.is_app_user === true,
    email_confirmed: typeof u.is_email_confirmed === "boolean" ? u.is_email_confirmed : null,
    team_id: typeof u.team_id === "string" ? u.team_id : null,
  };
}

export interface SlackDownload {
  /** HTTP 상태 */
  status: number;
  /** 응답의 Content-Type(소문자 · 매개변수 뺌) */
  contentType: string | null;
  /** 받은 바이트 — 실패 · 상한 초과면 null */
  bytes: Uint8Array | null;
  /** 상한을 넘어 그만 받았나 */
  truncated: boolean;
}

/**
 * 슬랙 파일 하나를 봇 토큰으로 내려받는다(url_private · url_private_download — 봇에 files:read 가 있어야 한다).
 *  주소는 슬랙 파일 서버만(봇 토큰을 실어 보내는 자리 — 다른 곳으로 새지 않게) · 다른 곳으로 넘기는 응답(redirect)은 따라가지 않는다
 *  (슬랙은 권한이 없으면 로그인 화면으로 넘긴다 — 그 화면을 파일로 읽지 않게 상태 그대로 돌려준다). 연결 실패 · 시간 초과는 던진다(토큰 없는 글로).
 */
export async function slackDownload(token: string, url: string, maxBytes: number, d: SlackApiDeps): Promise<SlackDownload> {
  if (!(d.fileUrlOk ?? isSlackFileUrl)(url)) throw new Error("슬랙 파일 서버의 주소가 아닙니다");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), d.timeoutMs ?? 30_000);
  try {
    const res = await d.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, "User-Agent": "lively-slack-bridge" }, signal: ac.signal, redirect: "manual" });
    const contentType = res.headers.get("content-type")?.toLowerCase().split(";")[0]!.trim() || null;
    if (res.status < 200 || res.status >= 300 || !res.body) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, contentType, bytes: null, truncated: false };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); return { status: res.status, contentType, bytes: null, truncated: true }; }
      chunks.push(value);
    }
    return { status: res.status, contentType, bytes: new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c)))), truncated: false };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new Error(name === "AbortError" ? "슬랙 파일 받기가 늦습니다(시간 초과)" : `슬랙 파일 서버에 닿지 못했습니다: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}
