// 세션 공유(세션이력 캡처) 정책(#905 C1) — 관리탭 ▸ 세션 공유 에서 완전 커스터마이징. runtime_config.session_share(jsonb).
//  순수 모듈(DB 무접촉) — resolve/normalize/기본값을 여기 모아 단위검증한다. store.ts 가 DB 입출력에서 이걸 쓴다.
//
//  기본값(#1752, 대표 결정 2026-08-18): **캡처 기본 켬.** 실행 노드 로컬의 대화이력을 중앙에 보관해, 노드가
//   오프라인이어도 같은 채팅 UI 에서 세션 기록을 읽을 수 있게 한다(읽기전용 — 프롬프트 전송은 라이브 세션만).
//   신뢰경계는 안 넘는다: 셀프호스트=자기 박스 DB, 매니지드=자기 테넌트 DB(원래 그 노드 파일이 속한 조직의 저장소).
//   view_policy=attach 라 그 세션이 붙었던 프로젝트의 멤버가 기록을 본다 — 끄려면 관리탭 ▸ 세션 공유에서
//   enabled=false(명시 false 는 영구 존중 — 재시딩·업그레이드가 되살리지 않는다).
//   (종전 기본 꺼짐의 근거였던 '롤아웃 안전'은 1년치 운용으로 소거 — 켜짐이 제품 기본 동작이 됐다.)

import { READABLE_HARNESSES } from "../terminal/harness-io/adapter.js";

export type SessionShareScope = "main" | "tree";     // main=주 트랜스크립트만 · tree=서브에이전트(<uuid>/subagents/*)까지
export type SessionShareStore = "slim" | "raw";      // slim=무손실 슬림(signature·toolUseResult·usage 버림, 본문 유지) · raw=원본 그대로
export type SessionShareViewPolicy = "attach" | "owner";  // 로그 열람 권한축: attach=입장가능자(canAttach) · owner=소유자만
export type SessionShareResumePolicy = "owner";      // 경로무관 resume 권한: 현재 owner(assertManage 동형)만. (확장 여지)

export interface SessionShareConfig {
  enabled: boolean;            // 마스터 스위치 — 캡처 자체 on/off. 기본 true(#1752 — 명시 false 만 끔).
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
// 선택지(파이프라인 실제 지원과 별개 — codex 는 D12).
// ⚠ #1695 판정: **화면으로 열람할 수 없는 하네스는 선택지에 두지 않는다**('못 지킬 켜기' 금지) — 캡처(수집)는 어떤 하네스든 원본
//  바이트로 되지만(어댑터가 Stop 에서 transcript_path 를 실어 조직 훅을 부른다), 파서가 없으면 켜도 화면이 빈다.
//  #1746 부터 그 판정을 **하네스 세션 I/O 어댑터의 파서 유무**(harness-io READABLE_HARNESSES)에서 파생한다 — 파서가 생기면 여기도
//  자동으로 열린다(claude·antigravity·grok). codex 는 파서 전이지만 종전 선택지였고 캡처가 실제로 되므로 유지한다(끄면 이미 켠 조직의
//  설정이 조용히 잘린다).
export const KNOWN_HARNESSES: readonly string[] = [...new Set(["claude", "codex", ...READABLE_HARNESSES])];
export const RETENTION_MAX_DAYS = 3650;   // 상한(10년) — 0=무제한과 구분, 실수로 거대값 입력 방어.

export const DEFAULT_SESSION_SHARE: SessionShareConfig = {
  enabled: true,          // #1752 — 기본 켬(중앙 보관·오프라인 읽기). 명시 false 만 끈다.
  harnesses: ["claude"],
  scope: "main",
  store: "slim",
  retention_days: 0,      // #1752 — 기본 무제한('중앙에서 관리'가 30일 시한부면 반쪽 — 기록은 남는 게 기본). 관리탭에서 조절.
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
    // #1752 기본 켬 — **명시 boolean 만 의미를 갖는다**: false=끔(영구 존중) · true=켬 · 부재/잡값=기본값(켬).
    //  구 규약(=== true, 부재=꺼짐)을 뒤집는 것이 이 변경의 본체다: 한 번도 설정 안 한 박스가 업그레이드로 켜진다.
    //  잡값이 기본(켬)으로 접히는 건 다른 필드(asEnum)와 같은 규약 — 명시적으로 끈 조직만 false 를 저장하고 있다.
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_SESSION_SHARE.enabled,
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
