// 서명 주소의 토큰(#4673) — 주소 하나에 대한 짧은 수명 «받기(GET)/올리기(PUT)» 권한을 URL 하나에 싣는다. 순수 + 키 해소.
//
// ── 왜 서명 주소인가 ─────────────────────────────────────────────────────────────────────
//  앱 화면(lvly.app iframe — 라이블리와 출처가 달라 쿠키가 없다) · 앱 서버(Lambda) · 세션 AI(curl)가 같은 방식으로 파일을 주고받게.
//   «URL 받아서 PUT/GET»(앱 v2 설계 §2) — 1단계는 이 URL 이 게이트웨이(/api/files/s/<토큰>)를 가리키고 바이트도 게이트웨이가 나른다.
//   2단계(#4674 · JuiceFS S3 게이트웨이)에선 발급 응답의 url 자리에 S3 서명 주소가 들어간다 — 응답 모양이 같아 앱 코드는 안 바뀐다.
//
// ── 토큰이 싣는 것 · 싣지 않는 것 ───────────────────────────────────────────────────────────
//  싣는 것: 워크스페이스 · 방법(GET|PUT) · 주소(자리 + 경로) · 누가 발급했나(구성원 · 앱 주체면 앱) · 만료.
//  권한 자체는 싣지 않는다 — 받는 쪽(files/signed-routes)이 쓰는 순간 «그 구성원(∩ 그 앱 동의)» 으로 **다시 판정**한다.
//   그래서 동의 철회 · 앱 끄기 · 공개범위 변경 · 구성원 비활성이 남은 수명과 상관없이 바로 먹는다. 토큰은 «누가 · 어디를 · 언제까지»의 증명일 뿐이다.
//
// ── 키 ────────────────────────────────────────────────────────────────────────────────
//  게이트웨이만 아는 키 — 마스터 CONNECTOR_SECRET_KEY 에서 도메인을 갈라 파생한다(HKDF, info "lively-file-url-v1").
//   OAuth state 서명(org/credentials/oauth-broker.ts)과 같은 규약이라 새 비밀을 늘리지 않는다. 셀프호스트 설치기(deploy/install.sh ·
//   update.sh)가 이 키를 늘 채우고, 매니지드 게이트웨이도 싣는다(lvly-cloud deploy/lvly-gw.sh). 없으면 발급을 막는다(503 — 받는 쪽도 못 연다).
//  매니지드 중앙 게이트웨이는 키 하나로 모든 워크스페이스를 서명한다 — 그래서 토큰에 워크스페이스를 굽고, 받는 쪽이 요청의 워크스페이스와
//   대조한다(W1 에서 받은 URL 을 W2 주소로 보내도 안 열린다).
import crypto from "node:crypto";
import type { AddressRoot } from "./address.js";

export type FileUrlMethod = "GET" | "PUT";

export interface FileUrlClaims {
  /** 워크스페이스(테넌트) id — 단일 테넌트 배포는 "" */
  t: string;
  m: FileUrlMethod;
  r: AddressRoot;
  /** 자리 기준 상대경로(address.ts FileAddress.rel) */
  p: string;
  /** 발급한 구성원 id */
  s: string;
  /** 앱 주체면 그 앱 id(사람 · 사람의 AI 면 없음) */
  a?: string;
  /** 만료(유닉스 초) */
  e: number;
}

/** 기본 수명 15분 · 상한 60분(상민님 2026-10-15 «추천안으로»). */
export const FILE_URL_TTL_DEFAULT_SEC = 15 * 60;
export const FILE_URL_TTL_MAX_SEC = 60 * 60;
export const FILE_URL_TTL_MIN_SEC = 30;
/** 올리기 상한 — 다른 업로드 입구(terminal-files · project-routes MAX_UPLOAD)와 같은 값. */
export const FILE_URL_MAX_UPLOAD = 1024 * 1024 * 1024;
const SKEW_SEC = 30;
const MAX_TOKEN_LEN = 4096;
const KEY_ENV = "CONNECTOR_SECRET_KEY";
const KEY_INFO = "lively-file-url-v1";

export type FileUrlTokenFailure = "malformed" | "signature" | "expired";
export class FileUrlTokenError extends Error {
  constructor(readonly kind: FileUrlTokenFailure, message: string) { super(message); this.name = "FileUrlTokenError"; }
}

/** 마스터 키 → 서명 키. 키가 없으면 null(발급 · 검증 둘 다 못 한다). secret-box 의 마스터 규약(hex64 그대로 · 그 밖 sha256)을 따른다. */
export function fileUrlKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[KEY_ENV]?.trim();
  if (!raw) return null;
  const ikm = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : crypto.createHash("sha256").update(raw, "utf8").digest();
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(KEY_INFO), 32));
}

/** 요청한 수명(초) → 실제 수명. 없거나 틀리면 기본, 범위 밖이면 경계로. */
export function clampTtl(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (raw == null || raw === "" || !Number.isFinite(n)) return FILE_URL_TTL_DEFAULT_SEC;
  return Math.max(FILE_URL_TTL_MIN_SEC, Math.min(FILE_URL_TTL_MAX_SEC, n));
}

const mac = (key: Buffer, input: string): Buffer => crypto.createHmac("sha256", key).update(input, "utf8").digest();

/** 칸 → 토큰 `v1.<b64url(JSON)>.<b64url(HMAC-SHA256)>`. 칸 순서는 이 함수가 정한다(검증은 받은 바이트 그대로 한다). */
export function signFileUrlToken(c: FileUrlClaims, key: Buffer): string {
  const body: Record<string, unknown> = { t: c.t, m: c.m, r: c.r, p: c.p, s: c.s };
  if (c.a) body.a = c.a;
  body.e = c.e;
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `v1.${payload}.${mac(key, `v1.${payload}`).toString("base64url")}`;
}

/**
 * 토큰 → 칸. 틀리면 FileUrlTokenError(무엇이 틀렸나). 서명이 맞아야만 칸을 읽는다.
 *  워크스페이스 대조는 부르는 쪽이 한다(요청의 워크스페이스를 아는 쪽) — 여기선 서명 · 모양 · 만료만.
 */
export function verifyFileUrlToken(token: string, key: Buffer, nowSec: number = Math.floor(Date.now() / 1000)): FileUrlClaims {
  const t = String(token ?? "");
  if (!t || t.length > MAX_TOKEN_LEN) throw new FileUrlTokenError("malformed", "주소의 서명 부분이 비었거나 너무 깁니다");
  const parts = t.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) {
    throw new FileUrlTokenError("malformed", "주소의 서명 부분 모양이 맞지 않습니다");
  }
  const want = mac(key, `v1.${parts[1]}`);
  const got = Buffer.from(parts[2]!, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new FileUrlTokenError("signature", "주소의 서명이 맞지 않습니다");
  let c: Record<string, unknown>;
  try {
    const v = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not object");
    c = v as Record<string, unknown>;
  } catch { throw new FileUrlTokenError("malformed", "주소의 서명 부분을 읽을 수 없습니다"); }
  const ok = typeof c.t === "string" && (c.m === "GET" || c.m === "PUT") && (c.r === "shared" || c.r === "apps")
    && typeof c.p === "string" && typeof c.s === "string" && !!c.s && Number.isInteger(c.e)
    && (c.a === undefined || (typeof c.a === "string" && !!c.a));
  if (!ok) throw new FileUrlTokenError("malformed", "주소의 서명 부분 칸이 맞지 않습니다");
  //  만료는 같은 게이트웨이 시계로 찍고 같은 시계로 잰다 — 시계 어긋남 여유를 두지 않는다. 상한을 넘는 만료는 우리가 찍은 값이 아니다(겹 방어).
  if ((c.e as number) < nowSec) throw new FileUrlTokenError("expired", "주소가 만료됐습니다 — 새 주소를 받으세요");
  if ((c.e as number) > nowSec + FILE_URL_TTL_MAX_SEC + SKEW_SEC) throw new FileUrlTokenError("malformed", "주소의 만료가 허용 범위를 넘습니다");
  return { t: c.t as string, m: c.m as FileUrlMethod, r: c.r as AddressRoot, p: c.p as string, s: c.s as string, ...(c.a ? { a: c.a as string } : {}), e: c.e as number };
}
