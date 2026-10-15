// 앱 주소(#4480 v2-1) — 앱마다 라이블리와 **다른 등록 도메인**의 자기 주소를 준다. 순수 — 값으로 검증한다(app-address.test.ts).
//
//  왜 다른 도메인인가: 앱이 라이블리와 같은 사이트(lvly.io 하위)에 뜨면 라이블리 로그인 쿠키의 요청 위조 방어(SameSite=Lax)가
//   무력해지고, 같은 주소면 앱이 라이블리 토큰(localStorage)을 읽는다(설계 app-framework-v2-general-web-design §3-A).
//
//  주소 규칙(CP 라우터 lvly-cloud control/src/appfront.ts 와 **같은 규칙** — 한쪽만 바꾸면 주소가 안 열린다):
//   · 공개 판  `<앱>-<워크스페이스 슬러그>.<앱 도메인>`       예 deck-edit-lively-46e3.lvly.app
//   · 초안 판  `<앱>-<워크스페이스 슬러그>-draft.<앱 도메인>` (만든 사람만 — v2-15 기록이 서면 켠다)
//   하이픈이 앱 id 와 슬러그 양쪽에 다 있어 문자열로는 못 가른다 — 가르는 것은 CP 라우터가 «끝부분이 실제 슬러그인 것» 을
//   찾아서 한다(슬러그끼리 꼬리가 겹치지 않게 CP 가 만들 때 거른다). 여기는 «이 앱의 주소가 무엇인가» 만 만든다.
//   라벨이 DNS 한 칸(63자)을 넘거나 IDNA 자리(3·4번째 `--`, `xn--`)에 걸리면 주소가 없다(null) — 화면은 종전 srcdoc 으로 띄운다.
//
//  스위치: env `LIVELY_APP_DOMAIN`(매니지드 = lvly.app). 비어 있으면 이 기능 전체가 꺼진다(자가호스팅·종전 동작 무회귀).
import { APP_ID_RE } from "./manifest.js";

export type AppVariant = "pub" | "draft";
export const APP_VARIANTS: readonly AppVariant[] = ["pub", "draft"];
export const DRAFT_SUFFIX = "-draft";

/** 워크스페이스 슬러그 — 코어 테넌트 헤더 검사(tenant-context.ts)와 같은 꼴. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** DNS 한 칸 — 영숫자로 시작·끝, 63자 이하. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 앱 도메인 — env 를 읽어 소문자로. 꼴이 틀리면(점 없음·이상한 글자) null = 꺼짐. */
export function appDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(env.LIVELY_APP_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!raw) return null;
  const labels = raw.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  return raw;
}

/**
 * 워크스페이스 단위 스위치(#4480 켜는 순서) — env `LIVELY_APP_DOMAIN_TENANTS`(쉼표로 가른 슬러그)에 든 워크스페이스만 켠다.
 *  비어 있거나 `*` 면 전부. 매니지드는 게이트웨이 하나가 모든 워크스페이스를 받아서, 도메인 스위치만으로는 «우리 워크스페이스에서
 *  먼저 실측 → 전체» 로 나눠 켤 수 없다 — 그 사이를 이 목록이 맡는다(CP cp.env `LVLY_APP_DOMAIN_TENANTS` → lvly-gw.sh 가 넘긴다).
 */
export function appDomainEnabledFor(slug: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.LIVELY_APP_DOMAIN_TENANTS ?? "").trim().toLowerCase();
  if (!raw || raw === "*") return true;
  const s = String(slug ?? "").trim().toLowerCase();
  if (!s) return false;
  return raw.split(",").map((x) => x.trim()).filter(Boolean).includes(s);
}

/** 그 워크스페이스에서 쓰는 앱 도메인 — 꺼졌거나(env 없음) 스위치 목록 밖이면 null. */
export function appDomainFor(slug: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const d = appDomain(env);
  return d && appDomainEnabledFor(slug, env) ? d : null;
}

/** 앱 주소의 첫 칸(라벨). 못 만들면 null. */
export function appHostLabel(slug: string, appId: string, variant: AppVariant = "pub"): string | null {
  const s = String(slug ?? "").trim().toLowerCase();
  const a = String(appId ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(s) || !APP_ID_RE.test(a)) return null;
  if (!APP_VARIANTS.includes(variant)) return null;
  const label = `${a}-${s}${variant === "draft" ? DRAFT_SUFFIX : ""}`;
  if (!LABEL_RE.test(label)) return null;              // 63자 초과 · 하이픈 끝
  if (label.slice(2, 4) === "--") return null;          // IDNA 예약 자리(xn-- 포함) — 브라우저가 퓨니코드로 읽을 수 있다
  return label;
}

/** 앱 주소(호스트). 도메인이 없거나 라벨을 못 만들면 null. */
export function appHost(slug: string, appId: string, variant: AppVariant, domain: string | null): string | null {
  if (!domain) return null;
  const label = appHostLabel(slug, appId, variant);
  return label ? `${label}.${domain}` : null;
}

export const appOrigin = (host: string): string => `https://${host}`;

/**
 * 로그인 뒤 갈 앱 안 경로 — 같은 주소의 **상대 경로**만 받는다(열린 리다이렉트 방지).
 *  `/` 로 시작 · `//`·`/\` 아님 · 2,048자 이하 · 공백·제어문자·역슬래시 없음. 틀리면 null(호출부가 400 또는 `/`).
 */
export function safeAppNext(next: unknown): string | null {
  if (next == null || next === "") return "/";
  if (typeof next !== "string") return null;
  if (next.length > 2048) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  if (/[\s\\\u0000-\u001f\u007f]/.test(next)) return null;
  return next;
}

/** 앱 주소 안 경로에서 v1 화면 고르기 — 경로는 `/` 뿐이고 `?page=<키>` 로 화면을, `__lively_probe=1` 로 앱 만들기 탐침을 고른다. */
export const PROBE_PARAM = "__lively_probe";
export function parseAppPath(path: unknown): { root: boolean; page: string | null; probe: boolean } | null {
  const p = safeAppNext(path);
  if (p === null) return null;
  let u: URL;
  try { u = new URL(p, "https://app.invalid"); } catch { return null; }
  const page = u.searchParams.get("page");
  return { root: u.pathname === "/", page: page ? page.slice(0, 64) : null, probe: u.searchParams.get(PROBE_PARAM) === "1" };
}
