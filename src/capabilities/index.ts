// capability 레지스트리 조립 + 어댑터 2개(Stage①).
// - registerMcpCapabilities(server): registry 의 expose.mcp:true capability 를 전부 자동 등록
//   (resolveUser→requireScope→handler→json, throw 는 SDK 가 isError:true 로 변환). MCP 표면 단일 SoT.
// - restMounts(): web.ts 가 순회 마운트하는 [capability, mount] 목록.
// - registry: 파리티 스크립트의 직접 핸들러 호출 fallback 용 export.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope, type LivelyUser } from "../context.js";
import { agentFromExtra, sessionFromExtra } from "../org/agent-identity.js";
import { contextCapabilities } from "./context.js";
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
import { folderV6Capabilities } from "./folders-v6.js";
import { viewV6Capabilities } from "./views-v6.js";
import { taskDetailV6Capabilities } from "./task-detail-v6.js";
import { taskFieldV6Capabilities } from "./task-field-v6.js";
import { teamCapabilities } from "./teams.js";
import { memberTeams, memberCategoryIds } from "../v6/team-store.js";
import { getMember } from "../org/store.js";
import { trashCapabilities } from "./trash.js";
import { undoCapabilities } from "./undo.js";
import { cronCapabilities } from "./cron.js";
import { mappingCapabilities } from "./mapping.js";
import { managedSessionCapabilities } from "./managed-session.js";
import { delegateCapabilities } from "./delegate.js";
import { toolUsageCapabilities } from "./tool-usage.js";
import { recallCapabilities } from "./recall.js";
import { dbAuditCapabilities } from "./db-audit.js";
import { dbGrantCapabilities } from "./db-grant.js";
import { memberSecretCapabilities } from "./member-secret.js";
import { awsCredentialCapabilities } from "./aws-credentials.js";
import { oauthConnectCapabilities } from "./oauth-connect.js";
import { brokerCapabilities } from "./broker.js";
import type { Capability, RestMount } from "./types.js";
import { DB_TOOLS } from "../tools/db.js";
import type { ToolCandidate } from "./mcp-surface.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ── me — 토큰 게이트 확인(스코프 불요, REST 전용). 핸들러가 partial user 에서 null-default 구성. ──
const me: Capability = {
  name: "me",
  title: "인증 확인",
  description: "bearer 토큰의 principal 확인 — {userId, email, scopes}. 웹 토큰 게이트 전용.",
  scope: null,
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/me"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    const u = (user ?? {}) as Partial<LivelyUser>;
    const memberId = u.userId ?? "";
    // 소속 팀 + '우리 팀' 카테고리 id(소유 ∪ 이해관계) — 프론트 사이드바 '우리 팀' 우선노출의 단일 소스.
    //  실패해도 게이트 확인은 막지 않는다(팀 미설정/스키마 초기 등 — 빈 배열 폴백).
    const [teams, cats, member] = memberId
      ? await Promise.all([
          memberTeams(memberId).catch(() => []),
          memberCategoryIds(memberId).catch(() => ({ all: [], owner: [] })),
          getMember(memberId).catch(() => null), // 표시 이름 — 우측 상단 '내 프로필' 라벨(이메일보다 우선)
        ])
      : [[], { all: [], owner: [] }, null];
    return {
      userId: u.userId ?? null, email: u.email ?? null, scopes: u.scopes ?? [],
      display_name: member?.display_name ?? null,
      avatar: member?.avatar ?? null, // 우측 상단 '내 프로필' 아바타(없으면 이니셜+색상 폴백)
      avatar_char: member?.avatar_char ?? null, avatar_color: member?.avatar_color ?? null, // 이미지 없을 때 커스텀 글자/배경색

      teams: teams.map((t) => ({ id: t.id, key: t.key, name: t.name })),
      team_category_ids: cats.all, team_owner_category_ids: cats.owner,
    };
  },
};

const all: Capability[] = [
  me, ...contextCapabilities,
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
  ...folderV6Capabilities, // v6(#475): 폴더(=클릭업 Folder층) CRUD + 리스트 소속 — scope=memory(/api/ui/v6/project-folders + /project-lists/:id/folder). 폴더는 정리용(멤버·권한 없음). 전부 expose.mcp:true+REST.
  ...viewV6Capabilities, // v6(#541): 저장 뷰 조회(ClickUp 이관 뷰 — /api/ui/v6/project-views). 보드 '뷰' 피커 소비.
  ...taskDetailV6Capabilities, // v6: 태스크 상세 모달(클릭업형) — 태그·시간추적·체크리스트·의존성·댓글/활동피드. scope=memory. expose.mcp:true(자동등록)+REST(/api/ui/v6/tasks/:id/*).
  ...taskFieldV6Capabilities, // v6: 커스텀 필드(클릭업형 "+ 컬럼 추가") — 필드 정의 CRUD + 태스크별 값 패치. scope=memory. expose.mcp:true(자동등록)+REST(/api/ui/v6/projects/:id/fields, /fields/:id, /tasks/:id/fields/:fieldId). task_field_delete_v6 는 org_tool 기본 OFF(값 손실).
  ...trashCapabilities, // v6: 휴지통(deleted_list 조회 + content_restore 복원) — 감사로그 기반 공통 경로. 복원은 사람전용(에이전트 403). 삭제는 엔티티별(knowledge_delete·category_delete·project_delete_v6).
  ...undoCapabilities, // #702: 전역 실행취소(Cmd+Z) — org_content_audit before/after 역적용(content_undo, REST 전용 /api/ui/undo). 사람전용(에이전트 403), 대상=내 웹 채널 변경만.
  ...cronCapabilities, // 서버사이드 스케줄 잡(org_cron) 관리 — admin scope. cron_list/set/delete/run_now(REST /api/ui/cron + MCP). 트리거 표준화: is 신선화·sync 를 게이트웨이가 주기 실행(웹훅 대체).
  ...mappingCapabilities, // 코드유닛→도메인 매핑 — context scope. list_unmapped(인박스)+map_code_unit(propose+근거, MCP+REST). LLM 판단주체: 에이전트가 도메인 should+DDD 로 분류.
  ...managedSessionCapabilities, // 상시 에이전트 세션 — admin scope. managed_session_list/set/delete/ensure. 격리 워크스페이스+keep-alive(createSession 재사용), 크론 타깃.
  ...delegateCapabilities, // P2(#869): 작업 위탁 — delegate_run/status/list/cancel(context scope, MCP+REST /api/ui/delegate*). 예상 소모량 신고→스케줄러가 노드 리소스 대조 배치, 결과는 .lively-task/<id>/.
  ...toolUsageCapabilities, // #318: MCP 호출 통계 집계(tool_usage_stats) — admin scope, REST 전용(/api/ui/tool-usage). mcp_call_log 를 요약/툴별/하네스/일별/최근으로 집계(관리탭 대시보드).
  ...recallCapabilities, // #637: 컨텍스트 라우팅(recall_route) — memory scope, REST 전용(POST /api/ui/recall/route). 작업맥락(프롬프트+최근Read경로)→도메인 HUB·leaf 지식 포인터. 훅 전용(주입은 훅이 포맷).
  ...dbAuditCapabilities, // P5(#746): db 접근 감사 — db_audit_list/verify(해시체인 검증) + org_db_subject_key(감사 대상 식별자 지정). admin scope, MCP+REST(/api/ui/db-audit*).
  ...dbGrantCapabilities, // P4(#746): raw-PII 언마스크 grant — db_unmask_grant(s)_create/revoke(직무 RBAC·JIT·maker-checker). admin scope, MCP+REST(/api/ui/org/db-source/unmask-grant*).
  ...memberSecretCapabilities, // P1(#746): per-user 백엔드 자격 vault — me_credential(s)(본인, 인증만)+org_credential(s)(통합, admin). 커넥터 툴이 resolveMemberSecret 로 해소. MCP+REST(/api/ui/{me,org}/credential*).
  ...awsCredentialCapabilities, // #746 파도2: AWS STS 브로커 — me_aws_credentials(role 가정→credential_process JSON, RoleSessionName=요청자). scope=null, MCP+REST(/api/ui/me/aws-credentials).
  ...oauthConnectCapabilities, // #746 T2: OAuth 커넥터 연결 — me_oauth_connect/disconnect(scope=null). auth_mode=oauth 프록시 MCP 에 per-user 동의. 콜백은 /oauth/callback(index.ts).
  ...brokerCapabilities, // #746 T4: broker_run(scope=code) — per-member 브로커에서 D-도구(git·kubectl·terraform) 실행. 첫 호출에 자동 기동, 전용 uid 격리.
];
// MCP 표면 = expose.mcp:true 인 capability 전부(registerMcpCapabilities 자동등록) + db 직접등록 3툴(db_query·db_schema·db_sources, tools/db.ts).
//  (하드코딩 카운트 금지 — 컷오버마다 썩는다. 실제 집합은 buildToolCandidates/isToolExposed 가 expose.mcp 로 결정.)
//  Phase 2(2026-06-24): names 배열 이중게이트 폐기 → expose.mcp 단일 SoT. domain_*·propose_domain 은 v6 category_* 로 이관(mcp:false, REST 보존),
//  knowledge_graph 만 mcp:false(REST 전용, 그래프뷰) — knowledge_set_wiki 는 mcp:true+REST 로 전환됨(구 REST 전용, #533 확인). project_delete_v6·task_delete_v6·task_field_delete_v6 는 expose.mcp:true + org_tool 기본 OFF. item(search_items·get_item)·mapping 은 폐기됨.
//  ku/knowledge 가 단일 캐노니컬 표면 — 지식 grep/단건 knowledge_grep·knowledge_get, 활동 activity_list·activity_log. REST 전용: GET /api/ui/learn(kind_registry+data_source ground-truth).

export const registry: Map<string, Capability> = new Map(all.map((c) => [c.name, c]));

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
): void {
  for (const cap of registry.values()) {
    if (!isToolExposed(cap, overrides)) continue;
    const meta = resolveToolMeta(cap, alwaysLoadOverrides, harness);
    server.registerTool(
      cap.name,
      { title: cap.title, description: cap.description + restEquivHint(cap), inputSchema: cap.input, ...(meta ? { _meta: meta } : {}) },
      async (args: Record<string, unknown>, extra: unknown) => {
        const u = resolveUser(extra);
        if (cap.scope) requireScope(u, cap.scope);
        // 작업자(AI) — 게이트웨이가 접속 신원(x-lively-harness 헤더 우선, 없으면 User-Agent)으로 식별(프로젝트 #182). 자기보고 대신 권위 신원.
        const agent = agentFromExtra(extra) ?? undefined;
        // 작업이 이뤄진 터미널 세션 — 같은 원리로 접속 헤더(x-lively-session)에서(#852). 세션 밖이면 undefined.
        const session = sessionFromExtra(extra) ?? undefined;
        return json(await cap.handler(args, u, { source: "mcp", actor: u.userId, agent, session }));
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
