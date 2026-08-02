// org-content 읽기/쓰기 — 전달 서브시스템의 진실원천 접근 계층.
// 모든 쓰기는 org_content_audit 에 before/after 를 남기고 version 을 올린다(낙관적 잠금 토대).
// 멤버 쓰기는 person/person_identity 로도 동기화 → 비개발자의 UI 편집이 즉시 게이트웨이 신원 매칭에 반영.
//
// (#1313 R18) 갓 모듈 해체 — 구현은 store/ 아래 관심사별 모듈로 verbatim 이동, 이 파일은 재수출 배럴
//  (소비 파일 무수정 유지). 새 코드는 배럴 대신 해당 모듈을 직접 import 해도 된다.
//  ⚠ 명시적 named 재수출인 이유: store/audit.ts 의 공유 헬퍼(audit·sha256)는 분할 전 private 였으므로
//  배럴 밖으로 새면 안 된다(export * 금지 — export 집합 전후 동일 불변식).

// ── 감사 seam(#549) — WriteCtx·관리 변경 감사 조회 ──
export { ADMIN_AUDIT_ENTITIES, listContentAudit } from "./store/audit.js";
export type { WriteCtx, ContentAuditRow, ContentAuditFilter } from "./store/audit.js";

// ── org_profile ──
export { getOrgProfile, updateOrgProfile } from "./store/profile.js";
export type { OrgProfile } from "./store/profile.js";

// ── org 섹션(항상-주입) + 구 org_memory 쓰기 래퍼 ──
export {
  getSection, listSections, updateSection, deleteSection, sectionNameInUse, setSectionsOrder,
  upsertMemory,
} from "./store/sections.js";
export type { OrgSection, OrgMemory, MemoryInput } from "./store/sections.js";

// ── org_member(+jsonb 부속: 온보딩 보고·하네스 관측·머신 별명·로컬 토글) ──
export {
  listMembers, getMember,
  getMemberOnboarding, setMemberOnboardingStep,
  getHarnessSnapshots, setHarnessSnapshot, removeHarnessMachine,
  getHarnessMachineAlias, setHarnessMachineAlias,
  getHarnessLocalPref, setHarnessLocalPref,
  memberIdByEmail, upsertMember, removeMember,
} from "./store/members.js";
export type {
  MemberIdentity, OrgMember, ReportedStep,
  HarnessSnapshotAsset, HarnessSnapshot, HarnessSnapshots, HarnessMachineAlias, HarnessLocalPref,
  MemberInput,
} from "./store/members.js";

// ── auth_token(발급·회수·유효권한·인증 핫패스) ──
export {
  mintToken, listTokens, revokeToken, computeEffectiveScopes, verifyDbToken, memberHasActiveToken,
} from "./store/tokens.js";
export type { TokenMeta } from "./store/tokens.js";

// ── org_runtime_config(런타임 설정 단일행 + 정책 seam 출처 판정) ──
export {
  HOOK_RELAY_DECISIONS, DEFAULT_HOOK_RELAY_DECISIONS,
  getRuntimeConfig, updateRuntimeConfig,
  getEmbeddingConfigSource, getStoragePolicySource, getCallLogPolicySource,
  getSessionMemoryPolicySource, getSessionReclaimPolicySource, getDelegatePolicySource,
} from "./store/runtime-config.js";
export type { OrgRuntimeConfig, HookRelayDecision } from "./store/runtime-config.js";

// ── org_mcp_server(MCP 서버 레지스트리 + 프록시 스냅샷) ──
export {
  listMcpServers, getMcpServer, upsertMcpServer, removeMcpServer, setMcpToolsSnapshot, listProxyServers,
} from "./store/mcp-servers.js";
export type { McpServer, McpServerInput } from "./store/mcp-servers.js";

// ── org_connector(커넥터 설정/토큰 + #586 자동 싱크 잡) ──
export { listConnectors, upsertConnector, removeConnector } from "./store/connectors.js";
export type { ConnectorView, ConnectorUpsertInput } from "./store/connectors.js";

// ── 자동 인입 라인(org_ingest_policy · org_distiller · 게이트 관측) ──
export {
  listIngestPolicies, upsertIngestPolicy, removeIngestPolicy,
  pickDistillerField, upsertDistiller, removeDistiller, recordDistillerRun,
  ingestObservability,
} from "./store/ingest.js";
export type {
  IngestPolicyRow, IngestPolicyUpsertInput, DistillerUpsertInput, IngestObservability,
} from "./store/ingest.js";

// ── db_query 접근 계층 5테이블(소스·테이블 정책·컬럼 마스크·subject key·언마스크 grant) ──
export {
  listDbSources, getDbSource, upsertDbSource, removeDbSource,
  listTablePolicies, upsertTablePolicy, removeTablePolicy,
  listColumnMasks, upsertColumnMask, removeColumnMask,
  listSubjectKeys, upsertSubjectKey, removeSubjectKey,
  listActiveUnmaskGrants, listUnmaskGrants, createUnmaskGrant, revokeUnmaskGrant,
} from "./store/db-access.js";
export type {
  DbSourceRow, DbSourceInput, DbTablePolicyRow, DbColumnMaskRow, DbSubjectKeyRow, DbUnmaskGrantRow,
} from "./store/db-access.js";

// ── org_hook(커스텀 훅) ──
export {
  listOrgHooks, listEnabledHooks, getOrgHook, recordHookFailures, upsertOrgHook, removeOrgHook,
} from "./store/hooks.js";
export type { HookHarness, OrgHook, OrgHookHealth, OrgHookInput } from "./store/hooks.js";

// ── org_tool(조직 정의 MCP 툴 + 빌트인 게이팅) ──
export {
  listTools, listEnabledProxyTools, listDisabledBuiltins, listBuiltinOverrides, listBuiltinAlwaysLoad,
  listAutoApproveTools, getTool, upsertTool, removeTool,
} from "./store/tools.js";
export type { ToolKind, OrgTool, OrgToolInput } from "./store/tools.js";

// ── org_harness_asset(하네스 자산) + org_asset_pref(per-member 오버라이드 #699) ──
export {
  assetContentHash, listOrgHarnessAssets, listEnabledAssets, getOrgHarnessAsset, countMemberDraftAssets,
  upsertOrgHarnessAsset, removeOrgHarnessAsset,
  getAssetPref, listAssetPrefs, setAssetPref, clearAssetPref, clearAssetPrefs,
} from "./store/harness-assets.js";
export type {
  AssetKind, OrgHarnessAsset, OrgHarnessAssetInput, AssetPrefKind, OrgAssetPref,
} from "./store/harness-assets.js";

// ── 프로젝트 타임라인(#1313 R18 ③) — v6 테이블만 조인하는 이질 구간이라 v6/project-activity-store.ts 로
//  이동(정본). 소비자(index.ts·itest 하네스)는 직결로 치환했고, 여기 재수출은 export 집합 전후 동일
//  불변식(기존 외부 소비 계약) 유지용이다 — 새 코드는 v6 모듈을 직접 import 할 것.
export { listProjectActivities } from "../v6/project-activity-store.js";
export type { ProjectActivity } from "../v6/project-activity-store.js";
