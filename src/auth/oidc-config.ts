// OIDC 설정 seam(#1520) — 관리탭에서 정하고(DB) 없으면 배포 env 로 폴백한다.
//  embedding_config(#172)와 같은 구조다: **DB 우선, 비면 env 시드**. 그 이유도 같다 —
//  고객 실박스가 SSM 전용이면 .env 편집이 비현실적이라(secret-box.ts 머리주석) 관리탭이 유일한 창구가 된다.
//  반대로 에어갭·자동화 배포는 env 로 굽는 게 자연스럽다. 둘 다 살려 둔다.
//
//  ★ 경계(#1601): 이 파일은 **코어(AGPL)** 다 — SSO 로 로그인시키는 구현은 Enterprise(src/ee/auth/oidc.ts)지만,
//   '설정을 저장하고 지금 무엇이 켜져 있는지 말하는' 계약은 코어에 남는다. 마스킹과 같은 선이다:
//   정책 설정 표면은 코어(capabilities/delivery/db-sources.ts), 집행·증빙만 EE.
//   그래서 EE 를 걷어낸 무료판도 관리탭에서 설정을 보고 저장할 수 있고, 화면은 '왜 안 켜지는지'를 말할 수 있다
//   (조용히 안 되는 게 최악이다 — OidcSettingsPublic.source 가 그 목적이다).
//   ⚠ 방향: EE 가 이 파일을 import 하는 건 정상, 코어가 src/ee 를 import 하는 건 금지(enterprise/registry.ts).
//
//  ⚠ 무순환: 이 모듈은 store 를 import 하지 않는다(store 가 이걸 쓴다 — embedding-provider.ts 와 같은 관례).
//  ⚠ client_secret 은 **암호문만** 저장한다(secret-box, AES-256-GCM). 평문은 DB 에 절대 두지 않는다.
//   그래서 이 파일은 암호문을 '들고만' 있고 복호화는 실제 사용처(ee/auth/oidc.ts)가 한다.
import { logger } from "../log.js";

export interface OidcSettings {
  enabled: boolean;              // 관리탭에서 켠 상태. false 면 DB 설정을 무시하고 env 시드로 내려간다.
  issuer: string;
  client_id: string;
  client_secret_enc: string | null; // secret-box 암호문(gcm$…). 평문 아님. 비면 '아직 입력 안 됨'.
  allowed_domains: string[];     // 자동 가입 허용 도메인(소문자, @ 제거)
  label: string | null;          // 로그인 버튼 문구. null 이면 issuer 로 추정한다.
  trust_unverified_email: boolean;
}

export const EMPTY_OIDC_SETTINGS: OidcSettings = {
  enabled: false, issuer: "", client_id: "", client_secret_enc: null,
  allowed_domains: [], label: null, trust_unverified_email: false,
};

export const normalizeDomains = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v.map(String) : String(v ?? "").split(",");
  const out: string[] = [];
  for (const d of raw) {
    const s = d.trim().toLowerCase().replace(/^@/, "");
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
};

// issuer 정규화 — 말미 슬래시 제거. https 강제는 검증 단계(호출부)에서 한다(여기선 저장 형태만 맞춘다).
export const normalizeIssuer = (v: unknown): string => String(v ?? "").trim().replace(/\/+$/, "");

export interface OidcSettingsPatch {
  enabled?: boolean;
  issuer?: string;
  client_id?: string;
  client_secret_enc?: string | null; // 호출부가 평문을 암호화해 넣는다. null = 지움, undefined = 보존.
  allowed_domains?: string[] | string;
  label?: string | null;
  trust_unverified_email?: boolean;
}

// 저장 형태 정규화 — 부분 패치를 기존 값 위에 얹는다(미전송 필드 보존).
export function mergeOidcSettings(before: OidcSettings, patch: OidcSettingsPatch): OidcSettings {
  return {
    enabled: patch.enabled ?? before.enabled,
    issuer: patch.issuer === undefined ? before.issuer : normalizeIssuer(patch.issuer),
    client_id: patch.client_id === undefined ? before.client_id : String(patch.client_id).trim(),
    // 시크릿은 3상태다: undefined=보존(관리탭이 매번 다시 입력하지 않아도 되게) · null=지움 · 문자열=교체.
    client_secret_enc: patch.client_secret_enc === undefined ? before.client_secret_enc : (patch.client_secret_enc || null),
    allowed_domains: patch.allowed_domains === undefined ? before.allowed_domains : normalizeDomains(patch.allowed_domains),
    label: patch.label === undefined ? before.label : ((patch.label ?? "").trim() || null),
    trust_unverified_email: patch.trust_unverified_email ?? before.trust_unverified_email,
  };
}

// DB 행(jsonb) → 설정. 형태가 깨져 있어도 로그인 경로를 죽이지 않는다(빈 설정 = OIDC 꺼짐).
export function readOidcSettings(raw: unknown): OidcSettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!o || typeof o !== "object") return { ...EMPTY_OIDC_SETTINGS };
  return {
    enabled: o.enabled === true,
    issuer: normalizeIssuer(o.issuer),
    client_id: String(o.client_id ?? "").trim(),
    client_secret_enc: typeof o.client_secret_enc === "string" && o.client_secret_enc ? o.client_secret_enc : null,
    allowed_domains: normalizeDomains(o.allowed_domains),
    label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : null,
    trust_unverified_email: o.trust_unverified_email === true,
  };
}

// ── 실효 설정(해석 결과) ─────────────────────────────────────────────────────
// OidcSettings(DB 저장형, 시크릿은 암호문)와 달리 이건 **바로 쓸 수 있는 형태**다 — 복호화된 client_secret 을 든다.
//  조립은 두 갈래: 관리탭(DB, 복호화 필요 → ee/auth/oidc.ts) 과 배포 env(아래 oidcEnvSeed).
//  타입이 코어에 있는 이유는 registry 훅 계약이 이걸 참조하기 때문이다(코어는 ee 를 정적으로 모른다).
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];   // 소문자. 비었으면 자동 가입 없음(기존 멤버만).
  label: string;
  trustUnverifiedEmail: boolean;
  scopes: string;
}

// 배포 env 시드 — 셋이 다 있어야 켜진다. 값이 없으면 null(제공자 미등록 → 로그인 화면에 버튼도 안 뜬다).
//  ★ 코어에 두는 이유: 관리탭이 'env 로도 설정돼 있는가'(OidcSettingsPublic.env_present)를 표시해야 하는데,
//   그 판정까지 EE 로 가면 무료판 관리탭이 자기 배포 상태를 못 읽는다. 판정은 코어, 그걸로 로그인하는 건 EE.
export function oidcEnvSeed(): OidcConfig | null {
  const issuer = (process.env.OIDC_ISSUER ?? "").trim().replace(/\/+$/, "");
  const clientId = (process.env.OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.OIDC_CLIENT_SECRET ?? "").trim();
  if (!issuer || !clientId || !clientSecret) return null;
  // issuer 는 https 만 — id_token 의 iss 대조 기준이자 discovery 대상이라 평문 HTTP 면 중간자가 신원을 통째로 바꾼다.
  //  (개발용 http IdP 를 붙일 일이 생기면 그때 명시적 escape hatch 를 추가할 것. 지금 열어두지 않는다.)
  if (!/^https:\/\//i.test(issuer)) {
    logger.warn({ issuer }, "[oidc] OIDC_ISSUER 가 https 가 아니라 OIDC 제공자를 켜지 않는다");
    return null;
  }
  const allowedDomains = (process.env.OIDC_ALLOWED_DOMAINS ?? "")
    .split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return {
    issuer, clientId, clientSecret, allowedDomains,
    label: (process.env.OIDC_LABEL ?? "").trim() || defaultOidcLabel(issuer),
    trustUnverifiedEmail: process.env.OIDC_TRUST_UNVERIFIED_EMAIL === "1",
    scopes: oidcScopes(),
  };
}

export const oidcScopes = (): string => (process.env.OIDC_SCOPES ?? "").trim() || "openid email profile";

// 버튼 문구 기본값 — 사람이 보는 건 IdP 이름이지 'OIDC' 가 아니다. 모르면 중립 문구.
export function defaultOidcLabel(issuer: string): string {
  const h = (() => { try { return new URL(issuer).hostname.toLowerCase(); } catch { return ""; } })();
  if (h.endsWith("accounts.google.com") || h.endsWith("google.com")) return "Google 계정으로 로그인";
  if (h.includes("microsoftonline") || h.includes("microsoft.com")) return "Microsoft 계정으로 로그인";
  if (h.includes("okta")) return "Okta 로 로그인";
  return "회사 SSO 로 로그인";
}

// 관리탭에 돌려줄 형태 — **암호문도 내보내지 않는다**. 사람이 알아야 하는 건 '설정돼 있나'뿐이다.
export interface OidcSettingsPublic {
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret_set: boolean;
  allowed_domains: string[];
  label: string | null;
  trust_unverified_email: boolean;
  source: "db" | "env" | "none"; // 지금 실제로 무엇이 쓰이는지 — '분명히 저장했는데 왜 안 켜지지'를 없앤다
  env_present: boolean;          // 배포 env 로도 설정돼 있는가(DB 를 끄면 그리로 되돌아간다)
  // ★ #1601 — 설정은 다 맞는데 Enterprise 모듈(src/ee)이 없어서 **실제로는 안 켜지는** 상태.
  //  SSO 는 EE 부재를 거부(fail-closed)로 다루지 않는다: 거부하면 로그인 자체가 막혀 무료판이 못 쓰는 제품이 된다.
  //  대신 local 로그인만 남고 버튼이 안 뜨는데, 그걸 화면이 말해주지 않으면 관리자는 설정을 계속 고치며 헤맨다.
  enterprise_required: boolean;
}
