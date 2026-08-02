// 세션 공유(세션이력 캡처) 정책(#905 C1) — 관리탭 ▸ 세션 공유 에서 완전 커스터마이징. runtime_config.session_share(jsonb).
//  순수 모듈(DB 무접촉) — resolve/normalize/기본값을 여기 모아 단위검증한다. store.ts 가 DB 입출력에서 이걸 쓴다.
//
//  기본값 = 권고: **캡처 메커니즘은 자동(무결성 — 죽는 세션의 성실성에 안 기댄다, 설계 §5)** 이되 **롤아웃은 꺼둠**.
//   enabled=false 라 켜기 전엔 아무 세션도 캡처 안 한다(C3 push 선례 — 조직이 명시적으로 켠다).
//   켜면 그때부터 harnesses·scope·store·retention·권한축을 관리탭에서 조절한다.

export type SessionShareScope = "main" | "tree";     // main=주 트랜스크립트만 · tree=서브에이전트(<uuid>/subagents/*)까지
export type SessionShareStore = "slim" | "raw";      // slim=무손실 슬림(signature·toolUseResult·usage 버림, 본문 유지) · raw=원본 그대로
export type SessionShareViewPolicy = "attach" | "owner";  // 로그 열람 권한축: attach=입장가능자(canAttach) · owner=소유자만
export type SessionShareResumePolicy = "owner";      // 경로무관 resume 권한: 현재 owner(assertManage 동형)만. (확장 여지)

export interface SessionShareConfig {
  enabled: boolean;            // 마스터 스위치 — 캡처 자체 on/off. 기본 false(롤아웃 안전).
  harnesses: string[];         // 캡처할 하네스. 기본 ["claude"]. codex 는 D12 구조적 배제(의미계층 포크 필요)라 켜도 파이프라인 미지원.
  scope: SessionShareScope;    // 기본 "main"(트리 캡처는 후속 슬라이스).
  store: SessionShareStore;    // 기본 "slim". (슬림 구현 전 슬라이스에선 파이프라인이 raw 로 폴백할 수 있음.)
  retention_days: number;      // 로그 보존일 — 지나면 reap. 기본 30. 0 = 무제한(디스크 주의).
  view_policy: SessionShareViewPolicy;   // 기본 "attach".
  resume_policy: SessionShareResumePolicy; // 기본 "owner".
}

export const SESSION_SHARE_SCOPES: readonly SessionShareScope[] = ["main", "tree"];
export const SESSION_SHARE_STORES: readonly SessionShareStore[] = ["slim", "raw"];
export const SESSION_SHARE_VIEW_POLICIES: readonly SessionShareViewPolicy[] = ["attach", "owner"];
export const KNOWN_HARNESSES: readonly string[] = ["claude", "codex"];   // 선택지(파이프라인 실제 지원과 별개 — codex 는 D12)
export const RETENTION_MAX_DAYS = 3650;   // 상한(10년) — 0=무제한과 구분, 실수로 거대값 입력 방어.

export const DEFAULT_SESSION_SHARE: SessionShareConfig = {
  enabled: false,
  harnesses: ["claude"],
  scope: "main",
  store: "slim",
  retention_days: 30,
  view_policy: "attach",
  resume_policy: "owner",
};

const asEnum = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  (typeof v === "string" && (allowed as readonly string[]).includes(v)) ? v as T : dflt;

// DB 값(jsonb 또는 부재) → 완전한 설정. 잡값·부재 필드는 기본값으로 접는다(구 DB·부분 저장 안전).
export function resolveSessionShare(raw: unknown): SessionShareConfig {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const harnesses = Array.isArray(o.harnesses)
    ? [...new Set(o.harnesses.filter((x): x is string => typeof x === "string" && KNOWN_HARNESSES.includes(x)))]
    : DEFAULT_SESSION_SHARE.harnesses;
  const rd = Number(o.retention_days);
  return {
    enabled: o.enabled === true,   // 기본 false — 명시적 true 일 때만 켜짐(부재/잡값 = 꺼짐)
    harnesses: harnesses.length ? harnesses : DEFAULT_SESSION_SHARE.harnesses,
    scope: asEnum(o.scope, SESSION_SHARE_SCOPES, DEFAULT_SESSION_SHARE.scope),
    store: asEnum(o.store, SESSION_SHARE_STORES, DEFAULT_SESSION_SHARE.store),
    retention_days: Number.isFinite(rd) && rd >= 0 ? Math.min(Math.floor(rd), RETENTION_MAX_DAYS) : DEFAULT_SESSION_SHARE.retention_days,
    view_policy: asEnum(o.view_policy, SESSION_SHARE_VIEW_POLICIES, DEFAULT_SESSION_SHARE.view_policy),
    resume_policy: "owner",   // v1 고정
  };
}

export type SessionSharePatch = Partial<SessionShareConfig>;

// 쓰기 정규화 — 기존값 위에 patch 를 얹고 resolve 로 검증. (storage_policy 와 동형: 안 건드린 필드는 before 유지.)
export function normalizeSessionShare(before: SessionShareConfig, patch: SessionSharePatch): SessionShareConfig {
  return resolveSessionShare({ ...before, ...(patch ?? {}) });
}
