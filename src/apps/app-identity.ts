// 앱 신원 토큰(X-Lively-Identity) — 앱 코드가 받아 보는 «사람 신원»의 서명 형식과 검증(#4483 · v2-1 #4480 과 합의 2026-10-14).
//
// ── 누가 무엇을 ──────────────────────────────────────────────────────────────────────────
//  앞단(CP 라우터, `*.lvly.app`)이 로그인한 구성원을 확인한 뒤 앱 서버로 가는 요청에 이 토큰을 붙인다. 앱 서버(Express ·
//  Lambda)는 게이트웨이를 부를 때 받은 토큰을 그대로 다시 싣는다(SDK 가 대신 한다). 게이트웨이는 «앱 서버 자격 + 같은 앱의
//  신원 토큰» 이 함께 왔을 때만 «그 구성원 ∩ 그 사람의 앱 동의» 로 실행한다(app-server-auth). v2-6 의 Lambda 층도 같은
//  모듈로 앱 코드보다 먼저 검사한다.
//  ⚠ 토큰 **혼자서는 아무것도 허락하지 않는다** — 앱 코드가 받아 보는 값이라서다(앱이 저장했다가 되쓸 수 있다).
//
// ── 형식 ────────────────────────────────────────────────────────────────────────────────
//  `v1.<kid>.<base64url(payload JSON)>.<base64url(Ed25519 서명)>`, 서명 입력 = 문자열 `v1.<kid>.<payloadB64>`(UTF-8).
//  payload = { ws: 테넌트 UUID, app: 앱 id, var: "pub"|"draft", sub: 구성원 id, name?: 표시 이름, iat, exp }(초).
//  비대칭 서명이다 — 서명 키는 앞단에만 있고 게이트웨이·Lambda 층은 공개 키(LIVELY_APP_IDENTITY_PUBKEYS = JSON {kid: base64url
//  32바이트})로만 검증한다. 그래서 비밀을 앱 쪽 환경변수에 뿌리지 않는다. 키는 한 쌍(+교체용 kid) — 공개 키로는 서명을
//  만들 수 없으니 앱마다 키를 둘 까닭이 없고, 다른 앱 토큰은 app 칸 대조로 막는다(설계 §3-C «앱별 키» 를 이렇게 구체화).
import crypto from "node:crypto";
import { HttpError } from "../http-error.js";

export const APP_IDENTITY_HEADER = "x-lively-identity";
/** 수명 상한(초) — 앞단은 10분을 준다. 그보다 긴 토큰은 서명이 맞아도 받지 않는다. */
export const APP_IDENTITY_MAX_TTL_SEC = 900;
/** 시계 어긋남 허용(초). */
export const APP_IDENTITY_SKEW_SEC = 30;
const MAX_TOKEN_LEN = 4096;

export interface AppIdentityClaims {
  ws: string;
  app: string;
  var: "pub" | "draft";
  sub: string;
  name?: string;
  iat: number;
  exp: number;
}

const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APP_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const unauthorized = (why: string): never => {
  throw new HttpError(401, `사람 신원(X-Lively-Identity)을 받을 수 없습니다 — ${why}`);
};

// ── 키 ──────────────────────────────────────────────────────────────────────────────────
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** 32바이트 시드 → Ed25519 키 쌍(공개 키는 raw 32바이트의 base64url). 시험·자가호스팅 서명용. */
export function ed25519FromSeed(seed: Buffer): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject; publicKeyB64: string } {
  if (seed.length !== 32) throw new Error("Ed25519 시드는 32바이트입니다");
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return { privateKey, publicKey, publicKeyB64: String(jwk.x) };
}

/** base64url raw 32바이트 공개 키 → KeyObject. 모양이 틀리면 throw. */
export function ed25519PublicKey(b64: string): crypto.KeyObject {
  if (!B64URL_RE.test(b64) || Buffer.from(b64, "base64url").length !== 32) throw new Error("Ed25519 공개 키는 base64url 32바이트입니다");
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64 }, format: "jwk" });
}

let cachedEnv: string | undefined;
let cachedKeys = new Map<string, crypto.KeyObject>();
/**
 * LIVELY_APP_IDENTITY_PUBKEYS(JSON {kid: base64url}) → kid 별 공개 키. 같은 값이면 기억해 둔다.
 *  비었거나 모양이 틀린 항목은 버린다(그 kid 의 토큰은 «모르는 키» 로 거부된다 — 받는 쪽으로 새지 않는다).
 */
export function appIdentityKeysFromEnv(env: NodeJS.ProcessEnv = process.env): Map<string, crypto.KeyObject> {
  const raw = String(env.LIVELY_APP_IDENTITY_PUBKEYS ?? "").trim();
  if (raw === cachedEnv) return cachedKeys;
  const keys = new Map<string, crypto.KeyObject>();
  if (raw) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [kid, v] of Object.entries(obj ?? {})) {
        if (!KID_RE.test(kid) || typeof v !== "string") continue;
        try { keys.set(kid, ed25519PublicKey(v)); } catch { /* 버린다 */ }
      }
    } catch { /* JSON 이 아니면 키 없음 */ }
  }
  cachedEnv = raw;
  cachedKeys = keys;
  return keys;
}

// ── 서명·검증 ────────────────────────────────────────────────────────────────────────────

/** 서명(앞단·시험·자가호스팅용). payload 칸 순서는 이 함수가 정한다 — 검증은 받은 바이트 그대로 하므로 순서와 무관하다. */
export function signAppIdentity(claims: AppIdentityClaims, privateKey: crypto.KeyObject, kid: string): string {
  if (!KID_RE.test(kid)) throw new Error(`kid 형식 오류: ${kid}`);
  const body: Record<string, unknown> = { ws: claims.ws, app: claims.app, var: claims.var, sub: claims.sub };
  if (claims.name !== undefined) body.name = claims.name;
  body.iat = claims.iat;
  body.exp = claims.exp;
  const input = `v1.${kid}.${Buffer.from(JSON.stringify(body), "utf8").toString("base64url")}`;
  const sig = crypto.sign(null, Buffer.from(input, "utf8"), privateKey).toString("base64url");
  return `${input}.${sig}`;
}

export interface VerifyAppIdentityOpts {
  /** 기본 = appIdentityKeysFromEnv(). */
  keys?: Map<string, crypto.KeyObject>;
  /** 지금(초) — 시험 주입. 기본 = 시계. */
  now?: number;
}

/**
 * 토큰을 검증하고 칸을 돌려준다. 이 요청의 워크스페이스(ws)·앱(app)과 같아야 한다. 아니면 HttpError(401) — 까닭을 말한다.
 *  검사: 형식 · kid 를 안다 · 서명 · 칸 모양 · exp ≥ 지금-30초 · iat ≤ 지금+30초 · exp-iat ≤ 900초 · ws · app · var.
 */
export function verifyAppIdentity(token: string, want: { ws: string; app: string }, opts: VerifyAppIdentityOpts = {}): AppIdentityClaims {
  const t = String(token ?? "").trim();
  if (!t) unauthorized("헤더가 비었습니다");
  if (t.length > MAX_TOKEN_LEN) unauthorized("너무 깁니다");
  const parts = t.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") unauthorized("형식이 아닙니다(v1.<kid>.<payload>.<서명>)");
  const [, kid, payloadB64, sigB64] = parts;
  if (!KID_RE.test(kid) || !B64URL_RE.test(payloadB64) || !B64URL_RE.test(sigB64)) unauthorized("형식이 아닙니다");
  const key = (opts.keys ?? appIdentityKeysFromEnv()).get(kid);
  if (!key) unauthorized(`모르는 서명 키(kid ${kid})입니다`);
  const sig = Buffer.from(sigB64, "base64url");
  if (sig.length !== 64) unauthorized("서명 길이가 맞지 않습니다");
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(`v1.${kid}.${payloadB64}`, "utf8"), key!, sig); } catch { ok = false; }
  if (!ok) unauthorized("서명이 맞지 않습니다");

  let c: Record<string, unknown>;
  try {
    const v = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not object");
    c = v as Record<string, unknown>;
  } catch { return unauthorized("payload 가 JSON 객체가 아닙니다"); }
  const ws = typeof c.ws === "string" ? c.ws.toLowerCase() : "";
  const app = typeof c.app === "string" ? c.app : "";
  const sub = typeof c.sub === "string" ? c.sub : "";
  const variant = c.var;
  const iat = c.iat, exp = c.exp;
  if (!UUID_RE.test(ws) || !APP_RE.test(app) || !sub || sub.length > 200) unauthorized("칸(ws·app·sub) 모양이 맞지 않습니다");
  if (variant !== "pub" && variant !== "draft") unauthorized("var 는 pub 또는 draft 여야 합니다");
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) unauthorized("iat·exp 는 정수(초)여야 합니다");
  if (c.name !== undefined && (typeof c.name !== "string" || c.name.length > 200)) unauthorized("name 모양이 맞지 않습니다");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if ((exp as number) < now - APP_IDENTITY_SKEW_SEC) unauthorized("만료됐습니다 — 화면을 새로 고치면 새 신원을 받습니다");
  if ((iat as number) > now + APP_IDENTITY_SKEW_SEC) unauthorized("발급 시각이 미래입니다(시계 확인)");
  if ((exp as number) - (iat as number) > APP_IDENTITY_MAX_TTL_SEC || (exp as number) < (iat as number)) unauthorized("수명이 허용 범위(15분)를 넘습니다");
  if (ws !== String(want.ws).toLowerCase()) unauthorized("다른 워크스페이스의 신원입니다");
  if (app !== want.app) unauthorized(`다른 앱(${app})의 신원입니다`);
  return { ws, app, var: variant as "pub" | "draft", sub, ...(typeof c.name === "string" ? { name: c.name } : {}), iat: iat as number, exp: exp as number };
}
