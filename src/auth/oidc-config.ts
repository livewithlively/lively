// OIDC 설정 seam(#1520) — 관리탭에서 정하고(DB) 없으면 배포 env 로 폴백한다.
//  embedding_config(#172)와 같은 구조다: **DB 우선, 비면 env 시드**. 그 이유도 같다 —
//  고객 실박스가 SSM 전용이면 .env 편집이 비현실적이라(secret-box.ts 머리주석) 관리탭이 유일한 창구가 된다.
//  반대로 에어갭·자동화 배포는 env 로 굽는 게 자연스럽다. 둘 다 살려 둔다.
//
//  ⚠ 무순환: 이 모듈은 store 를 import 하지 않는다(store 가 이걸 쓴다 — embedding-provider.ts 와 같은 관례).
//  ⚠ client_secret 은 **암호문만** 저장한다(secret-box, AES-256-GCM). 평문은 DB 에 절대 두지 않는다.
//   그래서 이 파일은 암호문을 '들고만' 있고 복호화는 실제 사용처(auth/oidc.ts)가 한다.

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
}
