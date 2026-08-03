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
import { initConnectorRegistry, initIngestPolicyAndDistillers, initSourceVisPolicy } from "./schema/connectors-ingest.js";
import { initDbAccessPolicies } from "./schema/db-access.js";
import { initSessionsInfra } from "./schema/sessions-infra.js";
import { initGroundTruthRegistries } from "./schema/registry.js";
import { initMemberAuth } from "./schema/member-auth.js";

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
  // (org_memory/org_content → knowledge_unit 1회복사 폐기 2026-06-24 — 원본 DROP, 복사 완료·v6 컷오버.)
}
