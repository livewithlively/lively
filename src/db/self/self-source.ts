// 내장 'self' 소스 — 게이트웨이 자기 items DB(ITEMS_DATABASE_URL)로의 admin 전용 읽기 창(#604).
//
//  왜: 고객 실박스(예: 고객사 A)는 db_query 에 붙일 소스가 없다. org_db_source 로 자기 items DB 를 등록하려면
//    시크릿ref(allowed_db_secret_refs)·host(allowed_db_hosts) 화이트리스트가 필요하고, 애초에 org/schema.ts 는
//    ITEMS_DATABASE_URL 자기참조를 '게이트웨이 자기 DB 탈취(권한상승)'로 일부러 막는다. 그래서 admin 이면
//    별도 등록 없이 자기 콘텐츠(지식·프로젝트·도메인맵)를 SQL 로 조회할 수 있도록 코드에 내장 소스를 둔다
//    (트러블슈팅·중복분석 등 — 고객사 직원/AI 의 실수요).
//
//  ⚠ #1291 — allow-list 에 project·project_list·knowledge·activity 가 들어 있어 이 창이 열려 있으면
//   `SELECT * FROM project` 한 줄로 콘텐츠 공개범위를 통째로 우회할 수 있다. 그래서 **공개범위가 지정된 맥락이
//   하나라도 생기면 그 시점부터 self 는 admin 전용**이 된다(tools/db.ts requireSelfSourceAllowed).
//   아무것도 안 잠근 조직에선 종전 그대로다 — 잠그기 전까지 아무것도 달라지지 않는다는 게 이 기능의 전제다.
//   (행 단위로 걸러 주려면 비특권 롤 + RLS 가 필요하다 — 접속 롤이 소유자/슈퍼유저라 정책만으론 안 걸린다. 후속.)
//
//  안전(이중 방어):
//   1) default-DENY allow-list — 아래 콘텐츠 테이블만 열고, 시크릿·자격증명·세션·PII·설정·감사·**앞으로
//      추가될 모든 테이블**은 기본 차단(deny). policy.getSourcePolicy 가 이 목록을 tableMode 에 시드한다.
//   2) firewall.DENIED_TABLES — 소스 무관 하드 백스톱(시크릿/자격증명/세션/콜로그는 self allow-list 에도
//      없지만, 혹시 웹 table-policy 로 잘못 열어도 코드가 차단).
//  읽기전용은 tools/db.execReadQuery 의 BEGIN READ ONLY→ROLLBACK 로 보장(itemsPool 이 RW 여도 트랜잭션이 RO).

export const SELF_SOURCE = "self";

// admin 이 자기 조직 콘텐츠를 읽는 데 필요한 테이블만(default-deny allow-list).
//  ⚠ 의도적 제외(=기본 차단): 시크릿(auth_token · member_credential · git_credential · org_connector ·
//    web_session · org_mcp_server · org_hook · org_tool · org_db_source), PII(person* · org_member),
//    감사·로그(org_content_audit · pm_write_audit · mcp_call_log), 설정·운영(org_profile ·
//    org_runtime_config · org_cron · org_managed_session · org_db_column_mask · org_db_table_policy ·
//    external_outbox · connector_state · data_source). 필요하면 웹 table-policy(source='self')로 개별 허용.
export const ITEMS_CONTENT_TABLES: readonly string[] = [
  // 지식·분류 (v6)
  "knowledge", "knowledge_link", "knowledge_category", "knowledge_source",
  "knowledge_comment", "knowledge_comment_reaction", "knowledge_view_config",
  "category", "category_edge", "category_repo", "source", "activity_knowledge",
  // 프로젝트·태스크 (v6)
  "project", "project_category", "project_edge", "project_folder", "project_knowledge",
  "project_list", "project_list_member", "project_member", "project_repo", "project_view", "session_project",
  // #1291 공개범위 — 누가 무엇을 볼 수 있는지 admin 이 SQL 로 감사할 수 있어야 한다(잠금 현황·고아 grant 점검).
  "project_list_team", "project_folder_member", "knowledge_member", "knowledge_list_grant", "source_member",
  "task", "task_assignee", "task_attachment", "task_checklist", "task_checklist_item",
  "task_comment", "task_comment_reaction", "task_field", "task_field_value",
  "task_link", "task_tag", "task_tag_link", "task_time_entry",
  "team", "team_category", "team_member",
  // 활동·도메인맵
  "activity", "activity_touch", "change_log", "code_unit", "data_entity",
  "debt_finding", "mapping", "repo", "scan_run", "dash_watch", "kind_registry",
];

// self 소스 베이스 tableMode(순수) — 콘텐츠 테이블 → 'allow'. 나머지는 source 의 tableDefault('deny')로 떨어진다.
//  policy.getSourcePolicy 가 이 위에 web(org_db_table_policy 'self') 오버레이를 얹는다(운영자 미세조정).
export function selfBaseTableMode(): Map<string, "allow" | "deny"> {
  const m = new Map<string, "allow" | "deny">();
  for (const t of ITEMS_CONTENT_TABLES) m.set(t, "allow");
  return m;
}
