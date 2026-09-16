// codex 헤드리스 자격(`~/.codex/auth.json`) 해석 — 순수 (#4012 T2).
//
// ── 무엇 ────────────────────────────────────────────────────────────────────
// claude 는 무인 실행용 토큰(`claude setup-token`)이 따로 있어 한 줄 문자열로 빌려 준다. codex 는 그런 토큰이 없고,
//  ChatGPT 로그인 파일 **auth.json 통째**가 자격이다(액세스·리프레시·ID 토큰 + 마지막 갱신 시각). 그래서
//  ① 등록 때 형식을 본다 — 잘린 값·다른 파일을 저장해 두면 한참 뒤 증류가 조용히 실패할 때야 드러난다.
//  ② codex 는 판 안에서 토큰을 **갱신하면 auth.json 을 다시 쓴다**. 갱신본을 버리면 저장본이 낡고, refresh token 이
//     한 번 쓰고 버리는 방식이면 다음 판부터 전부 401 이다. 그래서 판이 돌려준 파일을 **같은 계정 · 더 새것**일 때만
//     받아들인다(codexReturnVerdict).
//
// ── ⚠ 판정의 한계 ───────────────────────────────────────────────────────────
// JWT 서명은 검증하지 않는다(여기엔 OpenAI 공개키가 없다). 그래서 «같은 계정» 판정은 **남의 계정으로 갈아 끼우는 것**
//  (판 안 에이전트가 자기 토큰을 심어 우리 자료를 자기 계정으로 흘리는 것)을 막는다 — 진짜 남의 토큰은 페이로드에
//  남의 계정이 박혀 있고, 그걸 고치면 서명이 깨져 OpenAI 가 받지 않는다. 막지 못하는 것은 «같은 계정인 척하는
//  깨진 파일» 로 저장본을 망가뜨리는 것(서비스 거부)이다 — 그러면 다음 판이 인증 실패로 멈추고 알림이 간다.

/** 멤버 비밀 종류 — member-secret-store 의 KIND_RE 를 지킨다(소문자·숫자·_). */
export const CODEX_AUTH_KIND = "codex_auth_json";
/**
 * 비밀값 상한(글자). ⚠ 종전 `me_credential_set` 은 모든 값을 4096 자에서 **거절**했다 — 한 줄 토큰엔 충분했지만
 *  auth.json 은 JWT 두 개가 들어가 4KB 를 넘을 수 있어, codex 자격은 등록 자체가 막힌다.
 *  op 의 자격 상한(64KB)보다 작게 둔다.
 */
export const CREDENTIAL_SECRET_MAX = 16 * 1024;

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

export interface CodexAuthInfo {
  mode: "chatgpt" | "apikey";
  /** ChatGPT 계정 식별자(토큰 페이로드 클레임 → 없으면 tokens.account_id). 키 모드는 null. */
  accountId: string | null;
  email: string | null;
  /** 마지막 갱신 시각(ms). 모르면 null. */
  lastRefresh: number | null;
  /** 액세스 토큰 만료(ms). 모르면 null. */
  accessExp: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** JWT 페이로드(서명 검증 없음 — 머리말 «한계»). 모양이 아니면 null. */
export function jwtPayload(token: unknown): Record<string, unknown> | null {
  const t = str(token);
  if (!t) return null;
  const parts = t.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    return isObj(v) ? v : null;
  } catch { return null; }
}

function accountClaim(p: Record<string, unknown> | null): string | null {
  const c = p?.[AUTH_CLAIM];
  return isObj(c) ? str(c.chatgpt_account_id) : null;
}

function emailClaim(p: Record<string, unknown> | null): string | null {
  if (!p) return null;
  const direct = str(p.email);
  if (direct) return direct;
  const prof = p[PROFILE_CLAIM];
  return isObj(prof) ? str(prof.email) : null;
}

/** auth.json 한 통 → 해석(순수). 계정을 못 가르면 null — 그런 파일은 저장·반환 둘 다 받지 않는다. */
export function parseCodexAuth(text: unknown): CodexAuthInfo | null {
  let v: unknown;
  try { v = JSON.parse(String(text ?? "")); } catch { return null; }
  if (!isObj(v)) return null;
  const tokens = isObj(v.tokens) ? v.tokens : null;
  if (tokens && str(tokens.access_token)) {
    const idp = jwtPayload(tokens.id_token);
    const acp = jwtPayload(tokens.access_token);
    const accountId = accountClaim(idp) ?? accountClaim(acp) ?? str(tokens.account_id);
    if (!accountId) return null;
    const lr = typeof v.last_refresh === "string" ? Date.parse(v.last_refresh) : NaN;
    const exp = typeof acp?.exp === "number" && Number.isFinite(acp.exp) ? acp.exp * 1000 : null;
    return {
      mode: "chatgpt", accountId,
      email: emailClaim(idp) ?? emailClaim(acp),
      lastRefresh: Number.isFinite(lr) ? lr : null,
      accessExp: exp,
    };
  }
  if (str(v.OPENAI_API_KEY)) return { mode: "apikey", accountId: null, email: null, lastRefresh: null, accessExp: null };
  return null;
}

export type CodexReturnVerdict = { accept: true } | { accept: false; why: string };

/**
 * 판이 돌려준 auth.json 을 저장본 대신 받아들일까(순수).
 *  받아들이는 경우는 하나뿐이다: **같은 계정 · 저장본보다 새 갱신 시각 · 내용이 다름**.
 *  ⚠ 저장본을 해석 못 하면 **받지 않는다** — 비교 기준 없이 바꾸면 무엇이든 들어온다.
 */
export function codexReturnVerdict(storedText: string | null | undefined, returnedText: string | null | undefined): CodexReturnVerdict {
  const ret = String(returnedText ?? "").trim();
  if (!ret) return { accept: false, why: "반환이 없다" };
  const stored = storedText ? parseCodexAuth(storedText) : null;
  if (!stored) return { accept: false, why: "저장된 codex 자격을 해석하지 못했다 — 비교할 기준이 없다" };
  if (stored.mode !== "chatgpt") return { accept: false, why: "키 방식 자격은 갱신할 것이 없다" };
  const next = parseCodexAuth(ret);
  if (!next || next.mode !== "chatgpt") return { accept: false, why: "반환된 파일을 codex 자격으로 해석하지 못했다" };
  if (next.accountId !== stored.accountId) return { accept: false, why: "다른 계정의 자격이다" };
  if (next.lastRefresh === null) return { accept: false, why: "반환된 파일에 갱신 시각이 없다" };
  if (stored.lastRefresh !== null && next.lastRefresh <= stored.lastRefresh) return { accept: false, why: "저장본보다 새것이 아니다" };
  if (ret === String(storedText).trim()) return { accept: false, why: "바뀐 것이 없다" };
  return { accept: true };
}

/** 확인 문장(순수) — 저장 직후 «어느 계정인지» 를 사람 말로. 네트워크를 타지 않는다. */
export function describeCodexAuth(info: CodexAuthInfo | null, now: number = Date.now()): { ok: boolean; message: string; who: string | null } {
  if (!info) {
    return {
      ok: false, who: null,
      message: "codex 로그인 파일(auth.json)로 읽히지 않아요 — `codex login` 뒤 `~/.codex/auth.json` 의 내용을 통째로 다시 붙여넣어 주세요.",
    };
  }
  if (info.mode === "apikey") return { ok: true, who: null, message: "OpenAI API 키 방식 자격이에요(사용량 과금)." };
  const who = info.email ?? info.accountId;
  const exp = info.accessExp;
  const tail = exp === null ? ""
    : exp <= now ? " 액세스 토큰은 이미 만료됐지만, 판이 처음 돌 때 codex 가 갱신합니다."
    : ` 액세스 토큰 만료: ${new Date(exp).toISOString().slice(0, 10)}.`;
  return { ok: true, who, message: `ChatGPT 계정 ${who} 로 로그인된 codex 자격이에요.${tail}` };
}
