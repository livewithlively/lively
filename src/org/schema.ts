// org-content 스키마 — workflow-std(전달 서브시스템)의 진실원천을 git 파일에서 이 DB로 이관.
// items DB(itemsPool)에 co-locate: 멤버 신원(person/person_identity)이 이미 거기 있고, 쓰기 풀이라
// 게이트웨이 firewall(읽기전용 db_query 경로)을 우회한다. 발행 시에만 DB→임시디렉토리 materialize 후
// 기존 file-based generator 를 subprocess 로 재사용한다(ARCHITECTURE.md 전달층 흡수).
//
// 멱등 마이그레이션 패턴은 items/store.ts 와 동일: CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS
//  + pg_constraint 프로브로 CHECK enum 멱등 적용. 부팅 시 1회(비치명적) 호출.
//
// #1313 R19b: 구 1,500줄 단일 initOrgSchema 를 관심사 조각(schema/*.ts)으로 분할 — 이 파일은 **오케스트레이터**다.
//  ⚠ await 순서는 분할 전 실행 시퀀스 그대로(SCHEMA_SQL_LOG 스냅샷 diff 0 으로 증명 — scripts/schema-init.itest.mjs
//   헤더 참조). 같은 조각의 진입점이 떨어져 여러 번 불리는 것(core·runtime-config·mcp-tools·connectors-ingest)은
//   역사적 누적 순서를 보존한 것이다 — 재배열하려면 스냅샷 증명을 다시 떠라.
import { itemsPool } from "../db/client.js";
import { initOrgCore, initOrgCoreLateAdditions } from "./schema/core.js";
import { initRuntimeConfigTable, initRuntimeConfigPolicyColumns } from "./schema/runtime-config.js";
import { initMcpServerRegistry, initToolAndAssetRegistry, initOrgHookHealthColumn } from "./schema/mcp-tools.js";
import { initConnectorRegistry, initCollectorRegistry, initCollectorPresets, initClassifierRegistry, initManagerRegistry, initIngestPolicyAndDistillers, initSourceVisPolicy } from "./schema/connectors-ingest.js";
import { initDbAccessPolicies } from "./schema/db-access.js";
import { initSessionsInfra } from "./schema/sessions-infra.js";
import { initGroundTruthRegistries } from "./schema/registry.js";
import { initMemberAuth } from "./schema/member-auth.js";
import { initOAuthServer } from "./schema/oauth.js";
import { initCanary } from "./schema/canary.js";
import { initPromotion } from "./schema/promotion.js";
import { initNodeSessionMap } from "./schema/node-session-map.js";
import { initNodeState } from "./schema/node-state.js";
import { initWorkspaceRegistry } from "./schema/workspace-registry.js";
import { initAppRegistry } from "./schema/apps.js";

export async function initOrgSchema(): Promise<void> {
  await initOrgCore(itemsPool);                    // org_profile·org_member·org_content_audit·mcp_call_log·auth_token
  await initRuntimeConfigTable(itemsPool);         // org_runtime_config 기본형(테이블+단일행)
  await initMcpServerRegistry(itemsPool);          // org_mcp_server
  await initConnectorRegistry(itemsPool);          // org_connector
  await initToolAndAssetRegistry(itemsPool);       // org_hook·org_tool·org_harness_asset·org_asset_pref + 빌트인 시드
  await initRuntimeConfigPolicyColumns(itemsPool); // org_runtime_config 정책 노브 ALTER 연발
  await initOrgHookHealthColumn(itemsPool);        // org_hook.health(훅 실행 실패 관측)
  await initDbAccessPolicies(itemsPool);           // org_db_*(소스·정책·마스킹·grant) + db_access_log
  await initSessionsInfra(itemsPool);              // org_cron·managed_session·session_state·preview_env·stack_profile·node·task
  await initIngestPolicyAndDistillers(itemsPool);  // org_ingest_policy·org_distiller(+seen·prefilter)
  await initSourceVisPolicy(itemsPool);           // #1291 v4: 커넥터별 자료 공개범위 정책
  await initOrgCoreLateAdditions(itemsPool);       // org_member.status_message·project_member·org_content_audit 확장
  await initGroundTruthRegistries(itemsPool);      // kind_registry·data_source(+시드) + 레거시 DROP
  await initMemberAuth(itemsPool);                 // member_credential·member_secret·channel_policy/meta·web_session·git_credential·pending_device_auth
  await initOAuthServer(itemsPool);                // #1473 T2: oauth_client·oauth_auth_code·oauth_refresh + auth_token 확장(client_id·resource·expires_at)
  //  ⚠ initMemberAuth 뒤여야 한다 — 같은 인증 계열이고, auth_token 은 initOrgCore 가 이미 만들어 둔 뒤라 ALTER 가 안전하다.
  // ⚠ 신규 조각은 **맨 끝에 붙인다**(#1419 T1) — 위 순서는 분할 전 시퀀스를 보존한 계약이라, 중간에 끼우면
  //  SCHEMA_SQL_LOG 스냅샷 diff 가 '무관한 이동'으로 오염돼 다음 리팩토링의 증명이 어려워진다. org_collector 는
  //  기존 어느 테이블도 참조하지 않아(FK 없음) 순서 자유도가 있고, 끝에 두면 기존 시퀀스가 그대로 앞에 남는다.
  await initCollectorRegistry(itemsPool);          // org_collector(수집기 인스턴스 n개 — org_connector 의 system PK 해체)
  await initCollectorPresets(itemsPool);           // org_collector_preset(커스텀 프리셋)·collector_webhook_event(웹훅 수신함)
  await initCanary(itemsPool);                     // #1657: canary_result(상류 회귀 자동탐지 실행 기록)
  await initClassifierRegistry(itemsPool);         // org_classifier(+seen — 분류기 n개. 증류기의 분류판)
  await initManagerRegistry(itemsPool);            // org_manager(+finding — 관리기 4종: 어긋남·아웃데이티드·모순·코드괴리)
  await initPromotion(itemsPool);                  // #1750: org_promotion_request(개인→팀 워크스페이스 승격 요청 큐) — 맨 끝(신규 조각 규약)
  await initNodeSessionMap(itemsPool);             // #1752 갭2: org_node_session_map(노드 세션 box-id↔대화 uuid) — 맨 끝(신규 조각 규약)
  await initWorkspaceRegistry(itemsPool);          // #1750 S1: gw_workspace(+member) — 셀프호스트 다중 워크스페이스 등록부(전역 — 테넌트화 제외)
  await initAppRegistry(itemsPool);                // #1780: org_app(+component·grant) — OS/앱 계층 앱 레지스트리 + auth_token/session_state/mcp_call_log 앱 축 — 맨 끝(신규 조각 규약)
  await initNodeState(itemsPool);                  // #1834: org_node_state(노드 세션 스냅샷의 정본 — 게이트웨이 재배포에도 목록이 남는다) — 맨 끝(신규 조각 규약)
  // (org_memory/org_content → knowledge_unit 1회복사 폐기 2026-06-24 — 원본 DROP, 복사 완료·v6 컷오버.)
}
