// 앱 주소 앞단(CP 라우터) → 게이트웨이 기계 헤더 `x-lvly-app-front` (#4480 v2-1). 순수 + 판정 — app-front-auth.test.ts.
//
//  왜 따로 서명하나: CP 라우터는 인터넷에서 온 **모든** 요청에 테넌트 헤더(x-lvly-tenant-auth = 공유 비밀)를 붙여 넘긴다
//   (워크스페이스 주소 <slug>.app.lvly.io 도 그렇다). 그러니 «테넌트 헤더가 맞다» 는 «앱 주소의 앞단이 보냈다» 가 아니다 —
//   그것만 보고 문을 열면 로그인 없이 `<slug>.app.lvly.io/api/app-front/me` 로 아무 구성원 행세를 할 수 있다.
//   그래서 세션 장부(terminal/session-ledger.ts)와 같은 꼴로 **비밀을 아는 쪽만 만들 수 있는 서명**을 하나 더 요구하고,
//   그 서명 안에 «누가(mid) · 어느 앱(app·var) · 언제(iat)» 를 같이 싣는다. 인터넷 클라이언트도 앱 코드도 비밀을 모른다.
//
//  형식(lvly-cloud control/src/appfront.ts 가 **같은 식**으로 만든다 — 한쪽만 바꾸면 401):
//    x-lvly-app-front: v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(Kf, "v1." + payloadB64))>
//    Kf = HMAC-SHA256(LIVELY_TENANT_HEADER_SECRET, "lvly-app-front/v1")
//    payload: 교환 {op:"redeem", t, ws, iat} · 그 밖 {op:"act", t, ws, app, var, mid, iat}
//  판정: t == 이 요청의 테넌트 id · ws == 슬러그 · |now − iat| ≤ 60초 · op 가 엔드포인트와 맞음.
//  ⓘ 재전송(같은 헤더를 60초 안에 다시 씀)은 막지 않는다 — 헤더는 CP 박스 안 루프백에서만 오가고, 다시 써도 같은 사람·같은
//   앱의 같은 요청일 뿐이다(신원을 바꿀 수 없다).
import crypto from "node:crypto";
import { APP_ID_RE } from "./manifest.js";
import type { AppVariant } from "./app-address.js";

export const APP_FRONT_HEADER = "x-lvly-app-front";
export const APP_FRONT_SKEW_SEC = 60;

export type AppFrontOp = "redeem" | "act";
export interface AppFrontRedeem { op: "redeem"; t: string; ws: string; iat: number }
export interface AppFrontAct { op: "act"; t: string; ws: string; app: string; var: AppVariant; mid: string; iat: number }
export type AppFrontPayload = AppFrontRedeem | AppFrontAct;

/** Kf — 테넌트 헤더 비밀에서 이 용도만의 열쇠를 판다(같은 비밀을 다른 서명과 섞어 쓰지 않게). */
export function appFrontKey(secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update("lvly-app-front/v1").digest();
}

/** 서명(시험·대조용 — 운영의 서명자는 CP 라우터다). */
export function signAppFront(secret: string, payload: AppFrontPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", appFrontKey(secret)).update(`v1.${body}`).digest("base64url");
  return `v1.${body}.${sig}`;
}

export type AppFrontVerdict =
  | { ok: true; payload: AppFrontPayload }
  | { ok: false; why: string };

/** 검증(순수) — 실패 사유는 로그용이다(밖에는 가르지 않고 401 하나로 답한다). */
export function verifyAppFront(
  header: unknown,
  o: { secret: string; tenant: { id: string; slug: string } | null; op: AppFrontOp; nowSec?: number },
): AppFrontVerdict {
  const raw = Array.isArray(header) ? header[0] : header;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!o.secret) return { ok: false, why: "비밀 없음" };
  if (!o.tenant) return { ok: false, why: "테넌트 컨텍스트 없음" };
  const m = /^v1\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/.exec(s);
  if (!m) return { ok: false, why: "형식" };
  const want = crypto.createHmac("sha256", appFrontKey(o.secret)).update(`v1.${m[1]}`).digest();
  const got = Buffer.from(m[2], "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: "서명 불일치" };
  let p: Record<string, unknown>;
  try { p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as Record<string, unknown>; } catch { return { ok: false, why: "본문" }; }
  if (!p || typeof p !== "object") return { ok: false, why: "본문" };
  if (p.op !== o.op) return { ok: false, why: `op 불일치(${String(p.op)})` };
  if (p.t !== o.tenant.id || p.ws !== o.tenant.slug) return { ok: false, why: "테넌트 불일치" };
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  const iat = Number(p.iat);
  if (!Number.isFinite(iat) || Math.abs(now - iat) > APP_FRONT_SKEW_SEC) return { ok: false, why: "시각" };
  if (o.op === "redeem") return { ok: true, payload: { op: "redeem", t: o.tenant.id, ws: o.tenant.slug, iat } };
  const app = String(p.app ?? "");
  const v = p.var === "draft" ? "draft" : p.var === "pub" ? "pub" : null;
  const mid = typeof p.mid === "string" ? p.mid : "";
  if (!APP_ID_RE.test(app) || !v || !mid || mid.length > 200) return { ok: false, why: "신원 칸" };
  return { ok: true, payload: { op: "act", t: o.tenant.id, ws: o.tenant.slug, app, var: v, mid, iat } };
}
