// capability 레지스트리 조립 + 어댑터 2개(Stage①).
// - registerMcpCapabilities(server): registry 의 expose.mcp:true capability 를 전부 자동 등록
//   (resolveUser→requireScope→handler→json, throw 는 SDK 가 isError:true 로 변환). MCP 표면 단일 SoT.
// - restMounts(): web.ts 가 순회 마운트하는 [capability, mount] 목록.
// - registry: 파리티 스크립트의 직접 핸들러 호출 fallback 용 export.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope } from "../context.js";
import { viewerOf } from "./principal.js";
import { requireAppTool, requireAppToolMcp, appMcpHidden } from "../apps/principal.js";
import { agentFromExtra, sessionFromExtra, readOnlyFromExtra } from "../org/auth/agent-identity.js";
import { contextCapabilities, repoBranchCapabilities } from "./context.js";
import { deliveryCapabilities } from "./delivery.js";
import { domainmapCurationCapabilities } from "./domainmap-curation.js";
import { domainmapCrudCapabilities } from "./domainmap-crud.js";
import { domainmapIngestCapabilities } from "./domainmap-ingest.js";
// v6 은퇴(2026-06-24): mappingCapabilities(list_unmapped·mapping_candidates·curate_item_mapping) 폐기 — 레거시 item→domain 매핑(knowledge_unit_domain), v6 knowledge_link_category 대체.
import { activityCapabilities } from "./activity.js";
import { categoryCapabilities } from "./categories.js";
import { knowledgeCapabilities } from "./knowledge.js";
import { sourceCapabilities } from "./source.js";
import { projectV6Capabilities } from "./projects-v6.js";
import { listV6Capabilities } from "./lists-v6.js";
import { statusTemplateV6Capabilities } from "./status-templates-v6.js";
import { favoritesCapabilities } from "./favorites.js";
import { appCapabilities } from "./apps.js";
import { appToolCallCapabilities } from "./app-tool-call.js";
import { appStoreCapabilities } from "./app-store.js";
import { dashPrefsCapabilities } from "./dash-prefs.js";
import { sidePrefsCapabilities } from "./side-prefs.js";
import { folderV6Capabilities } from "./folders-v6.js";
import { sharedFolderCapabilities } from "./shared-folder.js";
import { viewV6Capabilities } from "./views-v6.js";
import { taskDetailV6Capabilities } from "./task-detail-v6.js";
import { taskFieldV6Capabilities } from "./task-field-v6.js";
import { teamCapabilities } from "./teams.js";
import { trashCapabilities } from "./trash.js";
import { visAxesCapabilities } from "./vis-axes.js";
import { undoCapabilities } from "./undo.js";
import { cronCapabilities } from "./cron.js";
import { feedTargetCapabilities } from "./feed-targets.js";
import { mappingCapabilities } from "./mapping.js";
import { managedSessionCapabilities } from "./managed-session.js";
import { sessionProjectCapabilities } from "./session-project.js";
import { previewEnvCapabilities } from "./preview-env.js";
import { stackProfileCapabilities } from "./stack-profiles.js";
import { delegateCapabilities } from "./delegate.js";
import { toolUsageCapabilities } from "./tool-usage.js";
import { livelyLogCapabilities } from "./lively-log.js";
import { recallCapabilities } from "./recall.js";
import { memberSecretCapabilities } from "./member-secret.js";
import { awsCredentialCapabilities } from "./aws-credentials.js";
import { oauthConnectCapabilities } from "./oauth-connect.js";
import { slackConnectCapabilities } from "./slack-connect.js";
import { notionConnectCapabilities } from "./notion-connect.js";
import { appInstanceCapabilities } from "./app-instances.js";
import { appNotificationCapabilities } from "./app-notifications.js";
import { channelPolicyCapabilities } from "./channel-policy.js";
import { brokerCapabilities } from "./broker.js";
import { meCapabilities, whoamiCapabilities } from "./whoami.js";
import type { Capability, RestMount } from "./types.js";
import { DB_TOOLS } from "../tools/db.js";
import type { ToolCandidate } from "../mcp/mcp-surface.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const all: Capability[] = [
  ...meCapabilities, // me — 웹 토큰 게이트 확인(REST 전용, avatar 포함). 정의는 whoami.ts(같은 신원 축).
  ...whoamiCapabilities, // #1072: whoami — 현재 로그인 신원(member_id·외부계정·팀·이 세션의 하네스/모드). scope=null, MCP+REST(/api/ui/me/whoami). me(웹 게이트, avatar 포함)의 하네스용 짝.
  ...contextCapabilities,
  ...domainmapCurationCapabilities, // propose_domain·domain_deprecate 만 expose.mcp=true(도메인 authoring), 나머지 REST 전용
  ...domainmapCrudCapabilities, // P-V3-4a: repo/domain 통제어휘 CRUD 5종 + hard-delete 2종(domain_delete·repo_delete) — 전부 expose.mcp=true(MCP+REST)
  ...domainmapIngestCapabilities, // 최초 is 부트스트랩 인제스트(POST /api/ui/domainmap/ingest, MCP domainmap_ingest) — payload 배치 write, insert-only·trust-first

  ...deliveryCapabilities, // 전달/관리(admin/runtime/read scope, REST 전용) — workflow-std 흡수: org-content 편집·발행·구성원·토큰 + learn(지식유형 ground-truth, P-V3-2)
  ...activityCapabilities, // P3: activity_log/activity_list — 작업(activity) 기록·조회(scope=memory). expose.mcp:true → 자동 등록.
  ...categoryCapabilities, // v6: 카테고리 CRUD + 도메인 의존엣지(should) — scope=context. category_* 8종 expose.mcp:true(자동등록)+REST(웹 3탭).
  ...teamCapabilities, // v6: 팀(스쿼드/사일로) CRUD + 멤버 + 카테고리 오너십 — scope=context. 표면화·주입의 '소프트 렌즈'(오너십≠권한). team_* expose.mcp:true(자동등록)+REST(어드민 팀 패널).
  ...knowledgeCapabilities, // v6: 지식 CRUD + lifecycle + 카테고리 연결(injection/provenance) — scope=memory. 대부분 expose.mcp:true(자동등록)+REST(웹 지식 탭). knowledge_graph 만 mcp:false(REST 전용, 그래프뷰).
  ...sourceCapabilities, // #290: 자료(source) CRUD + 지식 인용(knowledge_source) — scope=memory. raw 입력층(전사록·이메일·슬랙·미러), knowledge 와 분리(recall 미포함). expose.mcp:true(자동등록)+REST(웹 자료 탭 /api/ui/sources).
  ...projectV6Capabilities, // v6: 프로젝트/태스크/서브태스크 위계 + 카테고리·지식(필요/산출) 연결 — scope=memory(/api/ui/v6/projects). 전부 expose.mcp:true(자동등록)+REST. project_delete_v6·task_delete_v6 는 org_tool 기본 OFF(위험삭제, 운영자 토글).
  ...listV6Capabilities, // v6: 프로젝트 묶음(리스트=클릭업 List층) CRUD·멤버·프로젝트 소속 — scope=memory(/api/ui/v6/project-lists + /projects/:id/list). 네이티브 전용(외부 미러 없음). 전부 expose.mcp:true+REST.
  ...statusTemplateV6Capabilities, // v6(#729): 상태 체계 템플릿 — 스페이스 기본 + 이름있는 재사용 템플릿(/api/ui/v6/status-templates). inherit 리스트가 기본을 상속. 전부 expose.mcp:true+REST.
  ...favoritesCapabilities, // #670: 멤버별 즐겨찾기(리스트·카테고리 사이드바 핀) — scope=null(인증만), REST 전용(/api/ui/v6/favorites GET·POST).
  ...dashPrefsCapabilities, // #1129: 멤버별 대시보드 '내 프로젝트' 위젯 개인화(개요 리스트 순서·숨김·핀) — scope=null(인증만), REST 전용(/api/ui/v6/dash-prefs GET·POST). 기존 localStorage(기기별) 대체.
  ...sidePrefsCapabilities, // #1227: 멤버별 프로젝트 사이드바 개인화(폴더 접힘/펼침) — scope=null(인증만), REST 전용(/api/ui/v6/side-prefs GET·POST). 기존 인메모리 Map(새로고침 초기화) 대체.
  ...folderV6Capabilities, // v6(#475): 폴더(=클릭업 Folder층) CRUD + 리스트 소속 — scope=memory(/api/ui/v6/project-folders + /project-lists/:id/folder). 폴더는 정리용(멤버·권한 없음). 전부 expose.mcp:true+REST.
  ...sharedFolderCapabilities, // #1291 v2: 공유폴더 경로 공개범위(shared_folder_acl_get/_set — /api/ui/terminal/browse/acl). scope=memory, MCP+REST. 집행은 terminal-files.ts 가, 술어는 v6/shared-folder-store.ts 가.
  ...viewV6Capabilities, // v6(#541): 저장 뷰 조회(ClickUp 이관 뷰 — /api/ui/v6/project-views). 보드 '뷰' 피커 소비.
  ...taskDetailV6Capabilities, // v6: 태스크 상세 모달(클릭업형) — 태그·시간추적·체크리스트·의존성·댓글/활동피드. scope=memory. expose.mcp:true(자동등록)+REST(/api/ui/v6/tasks/:id/*).
  ...taskFieldV6Capabilities, // v6: 커스텀 필드(클릭업형 "+ 컬럼 추가") — 필드 정의 CRUD + 태스크별 값 패치. scope=memory. expose.mcp:true(자동등록)+REST(/api/ui/v6/projects/:id/fields, /fields/:id, /tasks/:id/fields/:fieldId). task_field_delete_v6 는 org_tool 기본 OFF(값 손실).
  ...trashCapabilities, // v6: 휴지통(deleted_list 조회 + content_restore 복원) — 감사로그 기반 공통 경로. 복원은 사람전용(에이전트 403). 삭제는 엔티티별(knowledge_delete·category_delete·project_delete_v6). #1291: 조회·복원 모두 공개범위 판정을 탄다(지우면 열린다가 되지 않게).
  // (커넥터별 자료 공개범위 **정책 정의·소급 백필**(source_vis_policy_*)은 #1601 로 Enterprise 로 갔다 —
  //  '강제'가 EE 이기 때문이다(위키 §1-3: 발견은 코어, 강제는 EE).
  //  ★ 그 정책을 **집행**하는 v6/source-vis-policy.ts(수집 시 스탬핑·증류 지식 상속)는 코어에 그대로다.
  //   집행까지 EE 로 보내면 EE 를 걷어낸 박스에서 이미 세운 정책이 무시돼 유출이 된다 — 집행이 코어라
  //   기존 정책은 계속 지켜지고, 없는 것은 '새 정책을 만드는 능력'뿐이다.)
  ...visAxesCapabilities, // #1291: 맥락 유형별 공개범위 켜기/끄기(vis_axis_list/_set). admin scope. 끄기는 잠긴 항목을 전원 공개시키므로 confirm+작업기록 필수.
  // (긴급 열람 vis_break_glass_* 는 #1601 로 Enterprise 로 갔다 — ee/capabilities/break-glass.ts.
  //  공개범위 판정과 긴급열람 **조회**(v6/visibility.ts)는 코어에 그대로다: 그게 EE 로 가면 가시성 자체가
  //  EE 의존이 된다.
  //  무료판에서 admin 이 잠긴 맥락을 봐야 하면 **그 리스트의 멤버에 자신을 넣는다**(project_list_set_members_v6,
  //  코어). EE 가 파는 건 그 우회가 아니라 *정책을 그대로 둔 채 사유·감사·통지와 함께 한시적으로 넘는 문*이다.
  //  ⚠ vis_axis_set 은 이 용도가 아니다 — 그건 축을 통째로 끄는 것이라 잠긴 항목이 **전원에게 공개**된다.)
  ...undoCapabilities, // #702: 전역 실행취소(Cmd+Z) — org_content_audit before/after 역적용(content_undo, REST 전용 /api/ui/undo). 사람전용(에이전트 403), 대상=내 웹 채널 변경만.
  ...feedTargetCapabilities, // #976 위키 아웃바운드 — 피드 목적지(feed_target)+카테고리 N:M 매핑 CRUD+드레인. admin scope, MCP+REST(/api/ui/feed-targets*). 관리탭 '위키 아웃바운드' 패널.
  ...cronCapabilities, // 서버사이드 스케줄 잡(org_cron) 관리 — admin scope. cron_list/set/delete/run_now(REST /api/ui/cron + MCP). 트리거 표준화: is 신선화·sync 를 게이트웨이가 주기 실행(웹훅 대체).
  ...mappingCapabilities, // 코드유닛→도메인 매핑 — context scope. list_unmapped(인박스)+map_code_unit(propose+근거, MCP+REST). LLM 판단주체: 에이전트가 도메인 should+DDD 로 분류.
  ...managedSessionCapabilities, // 상시 에이전트 세션 — admin scope. managed_session_list/set/delete/ensure. 격리 워크스페이스+keep-alive(createSession 재사용), 크론 타깃.
  ...sessionProjectCapabilities, // 세션↔프로젝트 변경(MCP+REST) + 실행 세션 동적 문맥(REST 전용). cwd가 아니라 x-lively-session/DB를 쓴다.
  ...previewEnvCapabilities, // #1036 프리뷰 환경 — code scope. preview_env_list/set/delete/ensure/stop. /preview/<id>/ 서브패스로 워크트리 public 정적 서빙(shared-proxy).
  ...repoBranchCapabilities, // repo_branch_list — 정의는 context.ts(repo_* 군집). 자리는 여기 고정(표면 순서 = tools/list 순서).
  ...stackProfileCapabilities, // '어떻게 띄우나' 정의(stack_profile_list/set/delete) — 조회는 code, 정의는 admin(start_cmd = 셸 명령).
  ...delegateCapabilities, // P2(#869): 작업 위탁 — delegate_run/status/list/cancel(context scope, MCP+REST /api/ui/delegate*). 예상 소모량 신고→스케줄러가 노드 리소스 대조 배치, 결과는 .lively-task/<id>/.
  ...toolUsageCapabilities, // #318: MCP 호출 통계 집계(tool_usage_stats) — admin scope, REST 전용(/api/ui/tool-usage). mcp_call_log 를 요약/툴별/하네스/일별/최근으로 집계(관리탭 대시보드).
  ...livelyLogCapabilities, // #1570: 내 라이블리 사용 내역(my_lively_log) — scope=null(본인 한정), REST 전용(/api/ui/me/lively-log). 같은 mcp_call_log 를 "나에게 무슨 이득이 됐나"로 읽는 개인 서사(대시보드 위젯).
  ...recallCapabilities, // #637: 컨텍스트 라우팅(recall_route) — memory scope, REST 전용(POST /api/ui/recall/route). 작업맥락(프롬프트+최근Read경로)→도메인 HUB·leaf 지식 포인터. 훅 전용(주입은 훅이 포맷).
  // P5/P4(#746) db 접근 감사(db_audit_*)·raw-PII 언마스크 grant(db_unmask_grant_*)는 **Enterprise 표면**이다.
  //  코어는 src/ee 를 정적으로 모르므로 여기 목록에 없고, EE 적재 시 addEnterpriseCapabilities 로 합류한다.
  ...memberSecretCapabilities, // P1(#746): per-user 백엔드 자격 vault — me_credential(s)(본인, 인증만)+org_credential(s)(통합, admin). 커넥터 툴이 resolveMemberSecret 로 해소. MCP+REST(/api/ui/{me,org}/credential*).
  ...awsCredentialCapabilities, // #746 파도2: AWS STS 브로커 — me_aws_credentials(role 가정→credential_process JSON, RoleSessionName=요청자). scope=null, MCP+REST(/api/ui/me/aws-credentials).
  ...oauthConnectCapabilities, // #746 T2: OAuth 커넥터 연결 — me_oauth_connect/disconnect(scope=null). auth_mode=oauth 프록시 MCP 에 per-user 동의. 콜백은 /oauth/callback(index.ts).
  ...slackConnectCapabilities, // #1881: "팀 자료로 모으기" — org_slack_collect(상태)/org_slack_collect_set(admin 토글). [Slack 연결] 금고를 token_source 로 가리키는 수집기 인스턴스(lively-search·lively-bot)를 만든다. 토큰 복사 0.
  ...notionConnectCapabilities, // #1881: 노션 "팀 자료로 모으기" — org_notion_collect(상태)/set(토글=동의 시작)/connect(페이지 더 고르기)/oauth_complete(CP 릴레이). 동의 화면의 페이지 선택이 곧 수집 범위, 수집기는 token_source=org 로 조직 슬롯을 가리킨다. 토큰 복사 0.
  ...appInstanceCapabilities, // #1780 v2.1: package와 분리된 실행 인스턴스 + nullable 프로젝트 맥락. REST-only 셸 배관.
  ...appNotificationCapabilities, // #1891: 앱이 쏘는 알림(권한 fail-closed) + 내 알림 이력·읽음. inbox 앱이 소비한다.
  ...channelPolicyCapabilities, // #1226: 대화 채널별 개인 열람/발송 허용 — me_slack_channels·me_channel_policy_set. **REST 전용·변경은 사람만**(AI 가 자기 차단을 못 풀게). 집행은 org/channels/channel-guard ← mcp-proxy.
  ...brokerCapabilities, // #746 T4: broker_run(scope=code) — per-member 브로커에서 D-도구(git·kubectl·terraform) 실행. 첫 호출에 자동 기동, 전용 uid 격리.
  ...appCapabilities, // #1780: 앱 레지스트리 — org_apps/org_app_get(조회 scope=null)·org_app_set_enabled(admin)·me_app_grant/revoke(동의 scope=null)·install/remove/activity/ui.
  ...appToolCallCapabilities, // #1780 PR5b: 앱 UI 브리지 tools/call(org_app_tool_call, REST 전용) — 앱 UI 의 도구 호출을 앱 principal 로 재판정 실행.
  ...appStoreCapabilities, // #1780 D6: 앱 데이터 store_*(insert/query/tables) — 앱이 자기 app 스키마 테이블을 RLS 격리 하에 읽고 쓴다.
];
// MCP 표면 = expose.mcp:true 인 capability 전부(registerMcpCapabilities 자동등록) + db 직접등록 3툴(db_query·db_schema·db_sources, tools/db.ts).
//  (하드코딩 카운트 금지 — 컷오버마다 썩는다. 실제 집합은 buildToolCandidates/isToolExposed 가 expose.mcp 로 결정.)
//  Phase 2(2026-06-24): names 배열 이중게이트 폐기 → expose.mcp 단일 SoT. domain_*·propose_domain 은 v6 category_* 로 이관(mcp:false, REST 보존),
//  knowledge_graph 만 mcp:false(REST 전용, 그래프뷰) — knowledge_set_wiki 는 mcp:true+REST 로 전환됨(구 REST 전용, #533 확인). project_delete_v6·task_delete_v6·task_field_delete_v6 는 expose.mcp:true + org_tool 기본 OFF. item(search_items·get_item)·mapping 은 폐기됨.
//  ku/knowledge 가 단일 캐노니컬 표면 — 지식 grep/단건 knowledge_grep·knowledge_get, 활동 activity_list·activity_log. REST 전용: GET /api/ui/learn(kind_registry+data_source ground-truth).

export const registry: Map<string, Capability> = new Map(all.map((c) => [c.name, c]));

// Enterprise(src/ee) 표면 합류 — 부팅 시 loadEnterprise() 가 EE 를 적재하면 ee/register.ts 가 이걸 호출한다.
//  ⚠ 반드시 buildToolCandidates()/restMounts() 가 처음 불리기 **전에** 끝나야 한다(index.ts 최상단에서 await).
//  EE 미탑재(무료 배포판)면 아무도 호출하지 않고, 그 표면은 존재하지 않는다.
export function addEnterpriseCapabilities(caps: Capability[]): void {
  for (const c of caps) {
    if (registry.has(c.name)) continue; // 중복 등록 방지(재적재·테스트)
    all.push(c);
    registry.set(c.name, c);
  }
}

const json = (d: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(d, null, 2) }] });

// ── MCP 표면 노출 판정 (웹 후보 buildToolCandidates 와 실제 노출 registerMcpCapabilities 가 공유하는 단일 SoT) ──
// 후보 = expose.mcp:true 인 capability(= "이건 MCP 도구다" 선언). 그 외(순수 웹 REST: org_*/dm_*/dash_*/task 상세)는 expose.mcp:false → MCP 표면 아님.
//  expose.mcp:false 는 org_tool 에 builtin 행이 잘못 들어와도 절대 노출 안 됨(표면 오염/취약 차단).
// "기본은 꺼두되 운영자가 켤 수 있는" 도구(project_delete_v6·task_delete_v6·task_field_delete_v6 등 위험삭제)도 expose.mcp:true(후보)로 두고,
//  기본 미노출은 org_tool 시드(enabled=false, schema init)로 표현한다 — 노출 상태의 SoT 는 DB(org_tool).
//  expose.mcp 는 "MCP 도구냐"만 선언하고 노출 여부를 코드에 하드코딩하지 않는다(구 MCP_TOGGLE_CANDIDATES Set 폐기 — stale 원천 제거).
export function isToolExposed(cap: Capability, overrides?: ReadonlyMap<string, boolean>): boolean {
  if (!cap.expose.mcp) return false;
  return overrides?.has(cap.name) ? overrides.get(cap.name)! : true;
}

// 신원 판정(viewerOf·isAdmin)의 본체는 ./principal.ts(import 0 leaf) — 여기는 기존 import 스펙 호환 재수출.
//  ⚠ 새 소비자는 principal 을 **직결** import 하라: 이 조립자를 경유하면 3줄 판정을 쓰려고 registry 전체
//   (delivery 포함 수백 op)를 로드하게 되고, capability 파일이면 index ↔ 자기 자신 순환이 된다(#1313 R25).
export { viewerOf, isAdmin } from "./principal.js";

// 읽기전용 모드(#1007) 판정의 단일 진실원천 — 이 capability 가 컨텍스트 스토어를 **변형(write)**하는가.
//  · cap.mutates 명시가 있으면 그것(POST인데 읽기·MCP전용 읽기 등 예외 표기).
//  · 없으면 REST 마운트 method 에서 파생: POST 마운트가 하나라도 있으면 쓰기, GET-only 면 읽기
//    (이 코드베이스 관례 = 읽기 GET·쓰기 POST. 드리프트 0 — 새 co-exposed 툴은 자동 분류).
//  · rest:false(MCP 전용) + 명시 없음 → 파생 신호 부재 → **fail-closed = 쓰기로 간주**.
//    보안 게이트라 미지정의 안전한 기본은 '차단'이다 — 새 MCP전용 쓰기 툴이 읽기전용 세션에서 조용히 새지 않게.
//    (그래서 순수 MCP전용 '읽기'는 반드시 mutates:false 를 달아야 읽기전용에서도 노출된다 — 실패해도 방향이 안전).
export function capMutates(cap: Capability): boolean {
  if (typeof cap.mutates === "boolean") return cap.mutates;
  const rest = cap.expose.rest;
  if (Array.isArray(rest) && rest.length) return rest.some((m) => m.method === "POST");
  return true;
}

// 읽기전용에서 차단 **예외**(#1007 사용자 스코프) — 컨텍스트 스토어 콘텐츠 쓰기가 아니라 '코드실행/오프로드'라 기밀 세션에서도 유지한다.
//  broker_run(브로커 도구 실행)·delegate_run/cancel(무거운 작업 위탁)은 읽기전용이어도 '일'(빌드·테스트)을 계속하게 둔다는 사용자 결정.
//  ⚠ 지식·프로젝트·작업 등 스토어 콘텐츠 쓰기는 여기 절대 넣지 않는다 — 그걸 막는 게 읽기전용의 본령이다.
export const READONLY_KEEP: ReadonlySet<string> = new Set(["broker_run", "delegate_run", "delegate_cancel"]);

// 읽기전용 세션이 이 capability 를 차단해야 하는가 — 쓰기(capMutates)이면서 예외(READONLY_KEEP)가 아닐 때.
//  MCP(등록 스킵)·REST(403) 두 어댑터가 공유하는 단일 판정 — 표면 간 read-only 정책 불일치 방지.
export function isReadOnlyBlocked(cap: Capability): boolean {
  return capMutates(cap) && !READONLY_KEEP.has(cap.name);
}

// MCP 툴 description 에 붙일 REST 등가 힌트(#550) — 이 capability 가 REST 로도 열려 있으면 경로를 노출한다.
//  co-exposed(같은 handler)라 REST body 필드 = 이 툴의 inputSchema 와 동일 → 에이전트가 소스를 뒤지지 않고
//  대량·기계적 작업 때 REST 반복호출 스크립트를 짤 수 있다(#533 '코드/대량은 REST', #550 실박스 계정 60+개 계기).
function restEquivHint(cap: Capability): string {
  const rest = cap.expose.rest;
  const paths = Array.isArray(rest) ? rest.flatMap((r) => r.paths.map((p) => `${r.method} ${p}`)) : [];
  return paths.length
    ? `\n\nREST 등가: ${paths.join(" · ")} — body 는 이 입력 스키마와 동일 필드(같은 handler). 대량·기계적 작업(예: 계정 수십 개 일괄)은 MCP 건별 대신 이 경로로 REST 반복호출 스크립트가 낫다.`
    : "";
}

// MCP 어댑터 — registry capability 를 isToolExposed 단일 판정으로 등록(후보 + 코드기본 + 운영자 override 한 경로).
// (과거엔 tools/*.ts 가 이름목록을 넘기는 이중 게이트라 expose.mcp:true 인데 목록 누락 시 "고스트"가 생겼다.)
export function registerMcpCapabilities(
  server: McpServer,
  overrides?: ReadonlyMap<string, boolean>,
  alwaysLoadOverrides?: ReadonlyMap<string, boolean>,
  harness?: string | null,
  readOnly?: boolean,
  incognito?: boolean,
  appId?: string | null, // 앱 토큰 세션(#1780 v2.1 R4-M1) — EXEMPT 배관 도구를 tools/list 에서 감춘다(핸들러도 403). 일반 세션 null.
): void {
  // 인코그니토 세션(#1007+): lively 툴을 **하나도** 등록하지 않는다 → tools/list 빈 표면 = 사실상 연결 없음(읽기·쓰기 모두 불가).
  //  (물리적 연결 차단은 per-session 으로 안 되므로 서버측 전체차단으로 대신.) 무상태 /mcp 라 요청마다 헤더로 재계산 = per-session.
  if (incognito) return;
  for (const cap of registry.values()) {
    if (!isToolExposed(cap, overrides)) continue;
    // 읽기전용 세션(#1007): 컨텍스트 스토어에 쓰는 툴은 아예 등록하지 않는다 → tools/list 에서 소거되어
    //  하네스가 그 툴의 존재조차 모른다(호출 시도·혼란 0). 무상태 /mcp 라 요청마다 헤더로 재계산 = per-session.
    if (readOnly && isReadOnlyBlocked(cap)) continue;
    // 앱 토큰(#1780): EXEMPT 배관 도구는 REST 전용 — LLM 도구 표면에서 소거(appMcpHidden 주석). 등록 필터는 UX,
    //  경계는 아래 핸들러의 requireAppToolMcp(sessioned 서버 재사용·헤더 드리프트에도 안전).
    if (appMcpHidden(appId, cap.name)) continue;
    const meta = resolveToolMeta(cap, alwaysLoadOverrides, harness);
    server.registerTool(
      cap.name,
      { title: cap.title, description: cap.description + restEquivHint(cap), inputSchema: cap.input, ...(meta ? { _meta: meta } : {}) },
      async (args: Record<string, unknown>, extra: unknown) => {
        const u = resolveUser(extra);
        if (cap.scope) requireScope(u, cap.scope);
        requireAppToolMcp(u, cap.name);    // #1780 v2.1: 앱 토큰이 EXEMPT 배관 도구를 MCP 로 부르면 403(REST 배관은 별도 어댑터)
        await requireAppTool(u, cap.name); // #1780: 앱 세션이면 그 앱 grant 의 도구 allowlist 로 축소(일반 세션은 통과)
        // 작업자(AI) — 게이트웨이가 접속 신원(x-lively-harness 헤더 우선, 없으면 User-Agent)으로 식별(프로젝트 #182). 자기보고 대신 권위 신원.
        const agent = agentFromExtra(extra) ?? undefined;
        // 작업이 이뤄진 터미널 세션 — 같은 원리로 접속 헤더(x-lively-session)에서(#852). 세션 밖이면 undefined.
        const session = sessionFromExtra(extra) ?? undefined;
        return json(await cap.handler(args, u, { source: "mcp", actor: u.userId, agent, session, readOnly: readOnlyFromExtra(extra), viewer: viewerOf(u) }));
      },
    );
  }
}

// 툴 _meta 계산 — alwaysLoad(상시로드) 비트를 하네스가 이해하는 키로 변환(#187 — 산출지식 mcp-tool-deferred-injection-harness-187).
//  · 코드 기본 cap.meta(anthropic/alwaysLoad)에서 출발 → 운영자 override(org_tool.always_load: true/false)가 그 비트만 덮어쓴다(다른 _meta 키 보존).
//  · claude-code(또는 미식별 null) → anthropic/alwaysLoad 유지(Claude Code v2.1.121+ 가 deferred 해제). 미식별도 emit = 현행 무회귀
//    (Claude 가 UA 만 보내거나 헤더 누락해도 상시로드가 꺼지지 않게 — null 은 Claude 로 간주).
//  · 양성 식별된 비-Anthropic 하네스(codex 등) → 이 키 무의미(Codex 는 서버 _meta defer 미지원, 전부 upfront 주입) → 제거.
export function resolveToolMeta(
  cap: Capability,
  alwaysLoadOverrides?: ReadonlyMap<string, boolean>,
  harness?: string | null,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = { ...(cap.meta ?? {}) };
  const codeDefault = cap.meta?.["anthropic/alwaysLoad"] === true;
  const alwaysLoad = alwaysLoadOverrides?.has(cap.name) ? alwaysLoadOverrides.get(cap.name)! : codeDefault;
  const anthropicHarness = harness == null || harness === "claude-code";
  if (alwaysLoad && anthropicHarness) base["anthropic/alwaysLoad"] = true;
  else delete base["anthropic/alwaysLoad"];
  return Object.keys(base).length ? base : undefined;
}

// capability.input(zod raw shape) → JSON Schema(하네스가 tools/list 에서 보는 입력 표면). 변환 실패 시 빈 객체 스키마.
function toInputSchema(input: unknown): unknown {
  try {
    return zodToJsonSchema(z.object((input ?? {}) as z.ZodRawShape), { $refStrategy: "none" });
  } catch { return { type: "object", properties: {} }; }
}

// 웹 도구탭·검증용 후보 — expose.mcp:true 인 capability + db 직접등록. 부팅 시 mcp-surface 에 주입.
//  여기 후보 집합 == registerMcpCapabilities 가 노출할 수 있는 집합(isToolExposed) — 둘 다 expose.mcp 를 본다.
//  description/inputSchema 는 하네스가 보는 MCP 표면 그대로(웹 도구탭에서 운영자가 확인). db 직등록은 db.ts 의 DB_TOOLS 가 보유.
export function buildToolCandidates(): ToolCandidate[] {
  const out: ToolCandidate[] = [];
  for (const cap of registry.values()) {
    if (!cap.expose.mcp) continue;
    out.push({
      name: cap.name, title: cap.title, description: cap.description,
      defaultExposed: cap.expose.mcp, kind: "capability", inputSchema: toInputSchema(cap.input),
      alwaysLoadDefault: cap.meta?.["anthropic/alwaysLoad"] === true,
    });
  }
  for (const d of DB_TOOLS) out.push({
    name: d.name, title: d.title, description: d.description,
    defaultExposed: true, kind: "db", inputSchema: d.inputSchema, alwaysLoadDefault: false,
  });
  return out;
}

// REST 어댑터 입력 — web.ts 가 순회하며 동일 경로(+alias)에 마운트한다.
export function restMounts(): { cap: Capability; mount: RestMount }[] {
  const out: { cap: Capability; mount: RestMount }[] = [];
  for (const cap of registry.values()) {
    if (!cap.expose.rest) continue;
    for (const mount of cap.expose.rest) out.push({ cap, mount });
  }
  return out;
}
