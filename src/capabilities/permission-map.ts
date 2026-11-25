// 기능 → 새 권한 배정표 (#5799) — 등록부(capabilities/index.ts registry)의 기능마다 새 권한 10개 중 어디에 드는가.
//  방향 합의: 윤상민 2026-11-25 (지식 permission-model-redesign-direction-5799). 권한 정의는 auth/permissions.ts.
//
//  ⚠ **아직 강제에 쓰이지 않는다.** 요청을 막고 여는 것은 여전히 각 기능의 scope 다. 이 표는 전환할 때 쓸 **목표 배정**이고,
//   옛 판정과 어디서 갈리는지는 permission-map.test.ts 가 전 기능 × 옛 scope 로 잰다.
//
//  읽는 법
//   · scope 가 null 인 기능(로그인만)은 여기 적지 않는다 — 새 체계에서도 로그인만이다.
//   · 수준(보기 · 고치기)은 적지 않는다 — 기능이 컨텍스트를 바꾸는가(index.ts capMutates)에서 파생한다.
//     읽기전용 세션(#1007)이 쓰는 판정과 같은 것이라 «무엇이 쓰기인가» 가 두 벌이 되지 않는다.
//   · **scope 가 있는 기능을 새로 만들면 여기 한 줄을 더한다.** 안 더하면 시험이 이름을 짚어 실패한다(R1).
//     어디 넣을지 — 팀이 쌓는 내용이면 content, 그 내용이 쌓이는 방식의 설정이면 pipeline, 구성원 컴퓨터의 AI 도구에
//     깔리는 것이면 harness, 사람 · 정책이면 admin, 로그인 정보 · 토큰이면 secrets.
//
//  등록부 밖의 것(이 표가 다루지 않는다 — 강제를 붙이는 단계에서 같은 권한 이름으로 잇는다)
//   · DB 조회 3종(tools/db.ts) → db · 외부 앱 도구(mcp/dynamic-tools · mcp/mcp-proxy) → external(조회 등급 L0 = 보기)
//   · 웹 터미널 세션(terminal/routes — 종전 scope 검사 없음) → session · 상용 모듈(src/ee)의 기능 → 아래 LEGACY_DEFAULT
//
//  배치가 딱 맞지 않는 것(지금 되던 사람이 그대로 되게 두었다 — 옮기려면 NARROWED 에 이유와 함께 적는다)
//   · workspace_* 13종 → content. «관리» 로 보이지만 소유자 검사가 안에 있는 자가 관리다(워크스페이스 만들기 · 나가기).
//     admin 으로 옮기면 구성원이 자기 워크스페이스에서 나가지도 못한다.
//   · org_mcp_* 4종 → pipeline. 외부 도구 서버 관리는 구성원에게 열려 있다(2026-09-12 결정). 다만 실행 명령(stdio) ·
//     직접 등록(client) 서버는 구성원 컴퓨터에 깔리므로 harness 여야 한다 — 입력에 따라 갈리는 것이라 표가 아니라
//     핸들러 안 검사로 막는다(다음 단계).
//   · org_update_profile · org_app_tools · org_app_tools_set_write · org_app_set_enabled · org_app_activity → pipeline.
//     맥락 저장소 설정은 아니지만 같은 사람들이 하는 워크스페이스 운영이다.
//   · 개인 설정(notify_prefs_set · dash_watch_set · knowledge_view_set)이 content 고치기다 — 게스트는 못 바꾼다.
import type { Scope } from "../auth/scopes.js";
import type { Permission, Need } from "../auth/permissions.js";

export const CAPABILITY_PERMISSIONS: Readonly<Record<Permission, readonly string[]>> = {
  // 지식 · 자료 · 프로젝트 · 태스크 · 분류체계 · 도메인맵 · 공유폴더 파일 · 워크스페이스 자가 관리
  content: [
    "context_overview", "debt_list", "domainmap_proxy", "dm_domain_detail", "dm_debt_list", "dm_history", "dm_domainmap_view", "dm_mapping_confirm",
    "dm_mapping_reject", "dm_mapping_move", "dm_debt_status", "dm_restore", "dm_layout_save", "domainmap_ingest", "workspace_link_set",
    "workspace_link_remove", "workspace_promote", "workspace_promotion_resolve", "workspace_create", "workspace_update", "workspace_delete",
    "workspace_member_add", "workspace_member_remove", "workspace_leave", "workspace_invite", "workspace_invite_resend", "workspace_invite_resolve",
    "activity_log", "activity_list", "dash_people", "dash_members", "dash_watch_get", "dash_watch_set", "category_list", "category_get",
    "category_create", "category_update", "category_view_set", "category_delete", "category_set_repos", "category_group_list",
    "category_group_upsert", "category_group_remove", "category_edge_list", "category_edge_set", "category_edge_remove", "team_list", "team_get",
    "knowledge_list", "knowledge_grep", "knowledge_search", "knowledge_similar", "knowledge_graph", "knowledge_tree", "knowledge_screen_search",
    "knowledge_view_get", "knowledge_view_set", "knowledge_comment_reaction", "knowledge_revisions", "knowledge_revision_get",
    "knowledge_revision_review", "review_queue_summary", "knowledge_unmapped", "knowledge_classifications", "knowledge_get", "knowledge_save",
    "knowledge_set_lifecycle", "knowledge_set_wiki", "knowledge_delete", "knowledge_set_title", "knowledge_set_fields", "knowledge_set_searchable",
    "knowledge_link_category", "knowledge_propose_category", "knowledge_link", "knowledge_props_ui", "knowledge_comments", "knowledge_comment_post",
    "knowledge_history", "knowledge_history_entry", "knowledge_revert", "knowledge_move", "source_list", "source_undistilled", "source_tree",
    "source_get", "source_save", "source_link_knowledge", "source_delete", "source_artifact", "source_trash_list", "workspace_reclaim",
    "project_find_by_origin_v6", "project_bind_folder_v6", "my_tasks_v6", "project_tasks_v6", "project_list_v6", "project_grep", "project_search",
    "project_similar", "project_get_v6", "project_create_v6", "project_update_v6", "project_rename_v6", "project_set_repos_v6",
    "project_set_categories_v6", "project_delete_v6", "project_set_status_v6", "project_archive_v6", "project_trash_v6", "project_trash_preview_v6",
    "project_purge_v6", "project_set_members_v6", "project_set_access_v6", "project_my_status_v6", "project_link_category_v6",
    "project_link_knowledge_v6", "project_link_project_v6", "project_recommend_knowledge_v6", "knowledge_projects_v6", "task_create_v6",
    "task_set_status_v6", "task_update_v6", "task_reorder_v6", "project_reorder_v6", "task_delete_v6", "board_fields_v6", "project_list_set_teams_v6",
    "project_list_index_v6", "project_list_create_v6", "project_list_update_v6", "project_list_delete_v6", "project_list_set_members_v6",
    "project_set_list_v6", "project_list_set_settings_v6", "project_list_clickup_fields_v6", "project_list_reorder_v6",
    "project_status_template_index_v6", "project_status_template_create_v6", "project_status_template_set_default_v6",
    "project_status_template_update_v6", "project_status_template_delete_v6", "project_folder_index_v6", "project_folder_create_v6",
    "project_folder_update_v6", "project_folder_delete_v6", "project_list_set_folder_v6", "project_folder_reorder_v6", "shared_folder_acl_get",
    "shared_folder_acl_set", "project_view_index_v6", "task_detail_v6", "task_tag_list_v6", "task_tags_v6", "task_tag_update_v6",
    "task_tag_delete_v6", "task_time_v6", "task_checklist_v6", "task_links_v6", "task_link_targets_v6", "task_comment_v6", "task_comment_reaction_v6",
    "project_comments_v6", "notify_feed", "notify_prefs", "notify_prefs_set", "task_field_create_v6", "task_field_update_v6", "task_field_delete_v6",
    "task_field_value_set_v6", "task_field_catalog_v6", "deleted_list", "trash_counts", "content_restore", "content_snapshot", "content_purge",
    "project_access_get", "content_undo", "list_unmapped", "map_code_unit", "session_task", "recall_route", "knowledge_recall", "nas_find",
    "nas_list", "nas_manage",
  ],
  // 수집 · 증류 · 분류 · 관리기 · 예약 · 경보 · 임베딩 · AI 전달 · 외부 도구 서버 · 앱 켜기
  pipeline: [
    "org_connectors", "org_update_profile", "org_injection_update",
    "org_auto_runs", "org_auto_runs_daily", "org_auto_run_detail", "org_alert_status", "org_alert_set", "org_alert_delete", "org_alert_test",
    "org_embeddings_status", "org_embeddings_backfill", "org_project_embeddings_status", "org_project_embeddings_backfill",
    "org_embeddings_backfill_pause", "org_embeddings_chunk_search", "org_mcp_server_presets", "org_mcp_upsert", "org_mcp_refresh", "org_mcp_remove",
    "org_connector_upsert", "org_connector_sync_run", "org_connector_runs", "org_connector_run_log", "org_connector_run_cancel",
    "org_connector_discover", "org_connector_remove", "org_collector_upsert", "org_collector_sync_run", "org_pipeline_run_now",
    "org_collector_discover", "org_collector_preset_upsert", "org_collector_preset_remove", "org_collector_preview", "org_collector_remove",
    "org_wiki_repo_ensure", "org_ingest_policy_upsert", "org_ingest_policy_remove", "org_ingest_observability", "org_distiller_list",
    "org_distiller_upsert", "org_distiller_remove", "org_distiller_requeue", "org_distiller_preview", "org_distiller_tune",
    "org_distiller_local_ensure", "org_distiller_figma_ensure", "org_distiller_zotero_ensure", "org_source_channels", "org_distiller_category_list",
    "org_distiller_category_upsert", "org_distiller_category_preview", "org_distiller_category_remove", "org_classifier_list", "org_manager_list",
    "org_manager_upsert", "org_manager_run", "org_manager_findings", "org_manager_finding_resolve", "org_manager_findings_apply",
    "org_manager_finding_report", "org_manager_remove", "org_pipeline_overview", "org_connector_members", "feed_target_list", "feed_target_create",
    "feed_target_drain", "feed_target_update", "feed_target_delete", "feed_target_set_categories", "cron_list", "cron_set", "cron_delete",
    "cron_run_now", "cron_run_plan", "collect_claude_run", "collect_claude_run_get", "collect_units", "collect_unit_find", "collect_unit_listing",
    "collect_units_sync", "collect_unit_update", "collect_unit_split", "member_ai_connectors", "member_ai_connectors_refresh", "org_slack_collect",
    "org_slack_collect_set", "org_slack_app_manifest", "org_notion_collect", "org_notion_collect_set", "org_notion_collect_connect",
    "org_notion_workspace_disconnect", "org_github_app_register", "org_app_tools", "org_app_tools_set_write", "org_figma_collect",
    "org_figma_collect_set", "org_clickup_collect", "org_clickup_collect_set", "org_github_collect", "org_github_collect_set", "org_gitlab_collect",
    "org_gitlab_collect_set", "org_linear_collect", "org_linear_collect_set", "org_linear_collect_connect", "org_collect_scope_options",
    "org_outlook_collect", "org_outlook_collect_set", "org_outlook_connect", "org_zotero_collect", "org_zotero_collect_set", "org_google_collect",
    "org_google_collect_set", "org_google_collect_connect", "org_connect_register", "org_connect_registration", "org_connect_unregister",
    "org_connect_status", "org_app_set_enabled", "org_app_activity",
  ],
  // 외부 앱 연결 — 외부 앱 도구 호출 자체(http_proxy · MCP 프록시)는 등록부 밖이다(mcp/dynamic-tools · mcp/mcp-proxy)
  external: [
    "org_github_connect_status", "org_github_connect",
  ],
  // 레포 등록부 + 레포 판 읽기
  code: [
    "repo_list", "repo_refresh", "repo_discover", "repo_check", "repo_create", "repo_rename", "repo_set_source", "repo_deprecate", "repo_delete",
    "me_git_credential_lease", "repo_branch_list", "repo_refs", "repo_diff", "repo_file", "repo_grep",
  ],
  // 브라우저 도구 — 웹 터미널 세션은 등록부 밖이다(terminal/routes)
  session: [
    "browser_status", "browser_tabs", "browser_navigate", "browser_screenshot", "browser_act", "browser_read", "browser_fill", "browser_upload",
    "browser_text", "browser_eval", "browser_console", "browser_handoff",
  ],
  // 작업 위탁 · 에이전트 작업 · 프리뷰 환경 · 브로커
  run: [
    "preview_env_list", "preview_env_set", "preview_env_delete", "preview_env_ensure", "preview_env_stop", "stack_profile_list", "delegate_run",
    "delegate_status", "delegate_list", "delegate_logs", "delegate_cancel", "broker_run", "agent_job_run", "agent_job_get", "agent_job_list",
    "agent_job_cancel",
  ],
  // 등록부에 없다 — db_sources · db_schema · db_query 는 tools/db.ts 가 따로 등록한다
  db: [],
  // 구성원 · 팀 · 공개범위 정책 · DB 소스 · 앱 설치 · 런타임 설정 · 감사 · 이관
  admin: [
    "org_update_section", "org_delete_section", "org_reorder_sections",   // 세션 주입 문구 — 관리자만 바꾼다(#5801)
    "org_member_upsert", "org_member_reset_password", "org_member_remove", "org_runtime_update", "org_context_job_runner_fill",
    "org_record_scope_get", "org_record_scope_set", "org_storage_status", "org_workspace_status", "org_workspace_analyze", "org_workspace_reclaim",
    "org_canary_status", "org_canary_run", "org_canary_probes", "org_db_sources", "org_db_source_upsert", "org_db_source_remove",
    "org_db_source_schema", "org_db_table_policy_set", "org_db_column_mask_set", "org_audit_list", "workspace_activate", "team_create", "team_update",
    "team_delete", "team_set_members", "vis_axis_list", "vis_axis_set", "project_access_set", "project_access_existing",
    "project_access_existing_close", "org_app_job_set", "managed_session_list", "managed_session_set", "managed_session_delete",
    "managed_session_ensure", "collect_claude_run_stats", "collect_session_policy_set", "member_ai_connectors_policy_set", "stack_profile_set",
    "stack_profile_delete", "tool_usage_stats", "org_slack_bridges", "org_slack_bridge_set", "org_slack_bridge_remove", "org_app_grant_set",
    "org_app_install", "app_edit_policy_set", "app_owner_set", "org_app_remove", "app_data_snapshots", "app_data_restore", "app_archives",
    "app_archive_clear", "app_folder_archives", "app_folder_archive_clear", "app_folder_restore", "app_folder_orphans_archive", "app_sql_stats",
    "app_bundle_limits_set", "app_server_limits_set", "app_folder_limits", "app_folder_usage_report", "app_ai_limits_set", "agent_job_limits_set",
    "transfer_export_catalog", "transfer_export_catalog_knowledge", "transfer_export_preview", "transfer_imports", "transfer_import_get",
    "transfer_import_apply", "transfer_import_undo",
  ],
  // 토큰 · 서비스 로그인 · OAuth 앱 등록 · 조직 git 자격
  secrets: [
    "org_tokens", "org_token_mint", "org_session_mint", "org_git_credential_get", "org_git_credential_set", "org_git_credential_delete",
    "org_token_revoke", "org_oauth_clients", "org_oauth_client_upsert", "org_oauth_client_disable", "org_credentials", "org_credential_set",
    "org_credential_delete", "org_slack_oauth_complete", "org_notion_oauth_complete", "org_github_oauth_complete", "org_linear_oauth_complete",
    "org_outlook_oauth_complete", "org_google_oauth_complete", "app_server_token_mint",
  ],
  // 커스텀 훅 · AI 도구 정의 · 하네스 자산
  harness: [
    "org_hooks", "org_hook_upsert", "org_hook_remove", "org_tools", "org_tool_upsert", "org_http_tool_presets", "org_http_tool_preset_apply",
    "org_tool_remove", "org_harness_assets", "org_harness_asset_upsert", "org_harness_asset_remove", "org_harness_asset_adopt",
    "org_harness_asset_risk_policy_set", "org_asset_prefs", "org_asset_pref_set", "org_asset_members", "org_asset_prefs_clear",
  ],
};

const BY_NAME: ReadonlyMap<string, Permission> = new Map(
  (Object.entries(CAPABILITY_PERMISSIONS) as [Permission, readonly string[]][])
    .flatMap(([perm, names]) => names.map((n) => [n, perm] as const)),
);

/**
 * 표에 없는 기능의 기본 배정 — 종전 scope 의 본줄기 권한.
 *  등록부의 기능은 전부 표에 있어야 하므로(시험 R1) 이 기본값이 닿는 것은 **상용 모듈(src/ee)의 기능**뿐이다 — 코어가
 *  그 이름을 알 수 없어서다(지금 15종 전부 admin: 긴급 열람 · DB 조회 감사 · 마스킹 해제 승인 · 자료 공개범위 정책).
 */
export const LEGACY_DEFAULT: Readonly<Record<Scope, Permission>> = {
  items: "external", context: "content", memory: "content", code: "code", db: "db", admin: "admin", runtime: "harness",
};

/** 이 기능이 드는 새 권한. scope 가 null 이면(로그인만) null. */
export function permissionOf(name: string, legacyScope: Scope | null): Permission | null {
  if (legacyScope === null) return null;
  return BY_NAME.get(name) ?? LEGACY_DEFAULT[legacyScope];
}

/** 이 기능이 요구하는 것 — mutates 는 index.ts capMutates(cap) 의 값을 넘긴다(이 파일은 등록부를 import 하지 않는 잎이다). */
export function needFor(name: string, legacyScope: Scope | null, mutates: boolean): Need | null {
  const perm = permissionOf(name, legacyScope);
  return perm ? { perm, level: mutates ? "write" : "read" } : null;
}

/** 표가 이름으로 적은 기능인가(기본값으로 떨어진 것이 아니라). */
export function isMapped(name: string): boolean {
  return BY_NAME.has(name);
}

/**
 * 전환하면 **일부러 좁아지는** 기능 — 옛 scope 만으로는 더 못 한다. 이 목록 밖에서는 옛 scope 하나가 열던 기능이
 *  번역(auth/permissions.ts LEGACY_SCOPE_GRANTS) 뒤에도 전부 열린다(시험 R3 이 «이 목록이 전부» 임을 잰다).
 *  전환 단계는 이 목록의 기능을 쓰던 사람에게 필요한 권한을 개별로 얹어 옮긴다.
 */
export const NARROWED: Readonly<Record<string, string>> = {
  team_create: "팀이 권한을 받는 단위가 된다 — 팀 편집은 곧 권한 편집이다. 종전에도 팀 대상 공개범위가 하나라도 있으면 admin 이었다(teams.ts requireTeamWrite)",
  team_update: "위와 같다",
  team_delete: "위와 같다",
  team_set_members: "위와 같다",
  member_ai_connectors: "수집 설정 조회라 맥락 관리다 — context 만 있고 memory 가 없는 사람만 잃는다(기본 구성원은 둘 다 가진다)",
};
