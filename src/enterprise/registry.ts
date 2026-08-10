// Enterprise(EE) 훅 레지스트리 — 코어(AGPL-3.0)와 상용 EE 모듈(src/ee/)의 **유일한 경계**.
//
// 왜 이런 구조인가:
//  코어는 `src/ee/` 를 **정적으로 import 하지 않는다.** ee 디렉터리를 통째로 지워도 코어는 빌드되고 구동된다
//  (무료 배포판 = ee 없는 tarball). 대신 부팅 시 enterprise/load.ts 가 ee/register.js 를 **동적으로** 찾아
//  registerEnterprise() 를 호출하고, 그 뒤부터 아래 훅들이 채워진다. 미탑재면 훅은 undefined 로 남고
//  각 코어 shim 이 '컴플라이언스 기능 없음' 기본 동작으로 흐른다.
//
// ⚠ 기본 동작(EE 미탑재)의 안전 원칙:
//  '기능이 없다' 와 '정책이 무시된다' 는 완전히 다르다. 마스킹 정책이 DB 에 설정돼 있는데 EE 가 없어서
//  조용히 raw 가 나가면 그건 유출이다. 그래서 코어 shim 은 **정책이 설정돼 있는데 집행할 EE 가 없으면
//  거부(fail-closed)** 한다 — assertEnterpriseForCompliance() 참조.
import type express from "express";
import type { MaskStyle, FieldMeta, MaskTarget } from "../db/mask.js";
import type { SourcePolicy } from "../db/firewall.js";
import type { UnmaskResolution } from "../db/policy.js";
import type { DbAccessRecord, SubjectKeyCapture } from "../db/access-log.js";
import type { PiiScrubResult, PiiHit } from "../org/ingest/pii-scrub.js";
import type { IngestFacets, IngestDecision, IngestPolicyRule } from "../org/ingest/ingest-policy.js";

/** pg/mysql 공통 최소 질의 인터페이스(EE 훅이 카탈로그를 조회할 때). */
export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** 컬럼 마스킹(#186) — 결정론적 값 변환. */
export interface DbMaskHooks {
  maskValue(v: unknown, style: MaskStyle): unknown;
  planMaskTargets(fields: FieldMeta[], attrStyles: Map<string, MaskStyle>): MaskTarget[];
  applyRowMasking(rows: unknown[][], targets: MaskTarget[]): unknown[][];
}

/** 마스킹 정책·언마스크 grant·감사대상 컬럼(#746 P4/P5). 테이블 allow/deny 는 코어(db/policy.ts) 소관. */
export interface DbMaskPolicyHooks {
  /** 마스크/subject 스냅샷 갱신(코어 refreshPolicy 가 테이블 정책을 읽은 뒤 이어서 호출). */
  refreshMaskPolicy(force: boolean): Promise<void>;
  /** 코어가 조립한 기본 SourcePolicy 위에 마스킹 정보를 얹는다. */
  applyMaskOverlay(base: SourcePolicy, source: string, unmask?: ReadonlySet<string>): SourcePolicy;
  getSubjectColSet(source: string): Set<string>;
  resolveUnmaskKeys(userId: string, source: string): Promise<UnmaskResolution>;
  peekMaskedSrcKeyToCol(source: string): Map<string, string> | undefined;
  getMaskStyleMap(source: string, unmask?: ReadonlySet<string>): Map<string, MaskStyle>;
  resolveMaskedAttrs(source: string, q: Queryable, unmask?: ReadonlySet<string>): Promise<Map<string, MaskStyle>>;
  resolveSubjectAttrs(source: string, q: Queryable): Promise<Map<string, string>>;
  resetCacheForTest(): void;
  /** 이 박스에 컴플라이언스 정책(마스킹/subject)이 실제로 설정돼 있는가 — fail-closed 판정용. */
  hasComplianceConfig(): boolean;
}

/** db 접근 감사 해시체인(#746 P5) — 컴플라이언스 기록의 SoT. */
export interface DbAuditHooks {
  collectSubjectKeys(
    fields: Array<{ name: string; srcKey?: string | null }>,
    rows: unknown[][],
    subjectOf: (srcKey: string) => string | null,
  ): Record<string, SubjectKeyCapture> | null;
  persistAccessOrThrow(rec: DbAccessRecord): Promise<void>;
  persistAccessBestEffort(rec: DbAccessRecord): void;
}

/** PII 스크럽 — 프록시 응답/툴 출력에서 주민번호·카드번호 등을 지운다. */
export interface PiiHooks {
  scrubPii(input: unknown): PiiScrubResult;
  detectPii(input: unknown): PiiHit[];
  scrubPiiDeep<T>(v: T): { value: T; hits: PiiHit[]; total: number };
}

/** 인입 게이트 정책 — 자료가 지식이 될 때 자동/확인/드롭을 조직 규칙으로 강제. */
export interface IngestPolicyHooks {
  resolveIngestPolicy(facets: IngestFacets, rules: IngestPolicyRule[]): IngestDecision;
  getIngestPolicyRules(): Promise<IngestPolicyRule[]>;
  invalidateIngestPolicyCache(): void;
}

/**
 * 외부 IdP 웹 로그인(SSO/OIDC, #1601) — 조직이 구성원 인증을 IdP 로 통제한다.
 *
 * ⚠ 이 훅만 fail-closed 가 아니다. 다른 훅은 '정책이 있는데 집행할 EE 가 없으면 거부'지만, SSO 는 거부하면
 *  로그인 경로 자체가 막혀 **무료판이 못 쓰는 제품**이 된다(LICENSING.md 신 약속 위반). EE 가 없으면
 *  SSO 버튼이 안 뜨고 local 계정(auth/local-accounts.ts — 영구 코어 폴백 tier)만 남는 것이 정상 동작이다.
 *  대신 관리탭이 그 사실을 말한다(OidcSettingsPublic.enterprise_required) — 조용한 실패가 최악이므로.
 */
export interface SsoHooks {
  /** 지금 이 배포에 SSO 가 실제로 쓸 수 있게 설정돼 있는가(로그인 버튼 문구 포함). 미설정이면 null. */
  ssoProvider(): Promise<{ label: string } | null>;
  /** SSO 라우트(인가 개시·콜백·계정 갈림길·연결 해제)를 붙인다 — 부팅 시 1회. */
  registerSsoRoutes(app: express.Express): void;
  /** 내 IdP 연결 현황('내 로그인 수단' 화면). 비밀번호 보유 여부는 코어(local-accounts)가 답한다. */
  ssoLinkStatus(memberId: string): Promise<{ linked: boolean; email: string | null }>;
  /** IdP 연결 해제. 로컬 비밀번호가 없으면 거절한다(해제 즉시 로그인 수단이 0 이 되어 자기 계정에서 잠긴다). */
  ssoUnlink(memberId: string): Promise<{ ok: true } | { ok: false; reason: "would_lock_out" | "no_member" }>;
}

export interface EnterpriseHooks {
  dbMask?: DbMaskHooks;
  dbMaskPolicy?: DbMaskPolicyHooks;
  dbAudit?: DbAuditHooks;
  pii?: PiiHooks;
  ingestPolicy?: IngestPolicyHooks;
  sso?: SsoHooks;
}

let _hooks: EnterpriseHooks = {};
let _loaded = false;

/** src/ee/register.ts 가 부팅 시 호출한다. 두 번 호출되면 뒤엣것이 이긴다(테스트 편의). */
export function registerEnterprise(hooks: EnterpriseHooks): void {
  _hooks = hooks;
  _loaded = true;
}

/** 코어 shim 이 훅을 조회하는 유일한 창구. 미탑재면 빈 객체 — 각 필드가 undefined. */
export function ee(): EnterpriseHooks {
  return _hooks;
}

/** EE 모듈이 실제로 적재됐는가(관리 화면 표기·진단용). */
export function isEnterpriseLoaded(): boolean {
  return _loaded;
}

/** 테스트 전용 — 적재 상태 초기화. */
export function _resetEnterpriseForTest(): void {
  _hooks = {};
  _loaded = false;
}

/**
 * fail-closed 게이트 — "정책은 있는데 집행할 EE 가 없다" 를 조용히 통과시키지 않는다.
 * 컴플라이언스 설정이 남아 있는 박스에서 ee/ 만 걷어내면 마스킹이 사라진 채로 raw 가 나가므로,
 * 그 경우 데이터 접근 자체를 막는다. (설정이 없으면 아무 일도 하지 않는다 — 순수 무료판은 정상 동작.)
 */
export function assertEnterpriseForCompliance(what: string): void {
  if (_loaded) return;
  throw new Error(enterpriseRequiredMessage(what));
}

/**
 * 훅이 반드시 있어야 하는 자리(정책이 켜진 경로)에서 쓴다 — 없으면 거부, 있으면 그대로 반환.
 * 정책 플래그가 꺼져 있으면 이 경로 자체가 호출되지 않으므로, 무료판은 아무 영향이 없다.
 */
export function requireEnterprise<T>(hook: T | undefined, what: string): T {
  if (!hook) throw new Error(enterpriseRequiredMessage(what));
  return hook;
}

function enterpriseRequiredMessage(what: string): string {
  return (
    `${what} 기능이 요청됐으나 Enterprise 모듈(src/ee)이 적재되지 않았습니다 — ` +
    `안전을 위해 요청을 거부합니다. Enterprise 모듈을 설치하거나, 관리탭에서 해당 정책을 끄세요.`
  );
}
