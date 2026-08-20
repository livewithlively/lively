// 앱 principal — 앱 세션의 권한 주체(#1780, design D3). 두 가지:
//  ① mintAppToken — 앱 세션이 쓸 토큰을 발급한다. scope = member ∩ grant.scopes, app_id 를 굽고 TTL 을 준다.
//     (env·헤더 자기주장이 아니라 **토큰에 구운 경계** — R1-F1·F2 가 밝힌 대로 env 레일은 프록시/폴백에서 새므로.)
//  ② requireAppTool — 능력 호출 직전 게이트. user.appId 가 있으면 그 앱 grant 의 도구 allowlist 로 축소한다.
//     보안 경계는 **핸들러 재판정**이다(등록 필터는 UX) — sessioned MCP 모드에서 등록이 동결돼도 안전(R2-3).
//
// ⚠ 왜 핸들러에서 막나: 등록 시점 필터(tools/list 숨김)만 두면, 무상태 /mcp 는 요청마다 재계산되지만
//  sessioned 모드는 initialize 시점 서버를 재사용해 필터가 동결된다. 그래서 requireScope 옆에서 매 호출 재판정한다.
import { HttpError } from "../http-error.js";
import type { LivelyUser } from "../context.js";
import { mintToken } from "../org/store/tokens.js";
import { getActiveGrant } from "../org/store/apps.js";
import { getApp } from "../org/store/apps.js";
import { toolAllowed } from "./grant.js";

// 앱 세션 토큰 기본 수명 — reaper 밖에서 죽는 세션(박스 재부팅·노드 종료)의 고아 토큰을 막는다(design R2-6).
//  세션이 살아 있으면 heartbeat 로 재발급/연장한다(PR3 스폰 배선). 12시간.
export const APP_TOKEN_TTL_SEC = 12 * 60 * 60;

/**
 * 앱 세션 토큰 발급. grant(멤버 동의)가 있어야 하고, scope 는 member 유효권한 ∩ grant.scopes 로 축소된다.
 *  실제 scope 축소는 verifyDbToken 이 intersection(token, member LIVE) 으로 한 번 더 하므로, 여기서 grant.scopes 를
 *  토큰 scope 로 심으면 최종 유효권한 = member ∩ grant ∩ member = member ∩ grant 가 된다(이중 안전).
 */
export async function mintAppToken(memberId: string, appId: string, actor?: string): Promise<{ token: string; expiresAt: Date | null }> {
  const app = await getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  if (!app.enabled || app.status !== "active") throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다(${app.status})`);
  const grant = await getActiveGrant(appId, memberId);
  if (!grant) throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다 — me_app_grant 필요`);
  const { token, expiresAt } = await mintToken({
    userId: memberId, memberId, scopes: grant.scopes,
    label: `app:${appId}`, appId, expiresInSec: APP_TOKEN_TTL_SEC,
  }, actor ?? "app-spawn", "terminal-sessions");
  return { token, expiresAt };
}

// grant.tools 캐시 — (tenant 는 요청 컨텍스트가 이미 고정하므로 키에 안 넣는다; app,member 로 충분).
//  revoke 즉시성은 **토큰 축**이 담당한다(verifyDbToken 이 매 요청 revoked 토큰을 거부) — grant 캐시는 tools 목록만.
//  짧은 TTL 로 grant 편집(도구 추가/축소)이 몇 초 내 반영되게 한다.
interface CacheEntry { tools: string[] | null; at: number }
const grantCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5000;
let nowMs: () => number = () => Date.now();
export function setAppToolClock(fn: () => number): void { nowMs = fn; } // 테스트 주입(캐시 TTL 검증용)

async function grantTools(appId: string, memberId: string): Promise<string[] | null> {
  const key = `${appId}\0${memberId}`;
  const hit = grantCache.get(key);
  if (hit && nowMs() - hit.at < CACHE_TTL_MS) return hit.tools;
  const grant = await getActiveGrant(appId, memberId);
  const tools = grant ? grant.tools : null; // null = grant 없음(앱 비활성 대우)
  grantCache.set(key, { tools, at: nowMs() });
  return tools;
}

/**
 * 앱 세션 무조건 통과 능력(EXEMPT) — grant 와 **무관하게** 허용되는 **세션 플럼빙** 능력들(#1780 PR3c).
 *
 *  왜 필요한가: 앱 세션의 grant 는 앱이 쓰는 **콘텐츠 도구**(knowledge_save·db_query·project_* …)를 좁히는 게 목적이지,
 *   세션이 돌기 위한 **인프라 배관**을 좁히는 게 아니다. 그런데 세션 안에서 도는 두 종류의 호출이 requireAppTool 을 만난다:
 *    ① LLM 자신의 인프라 호출(프록시 = 앱 토큰). 대표적으로 whoami(자기 신원) — 하네스가 부팅 때 부른다.
 *    ② 세션 훅(session-preload·sync-harness-assets·run-custom)의 인프라 fetch. 격리(box-spawn) 세션에선
 *       box-spawn 이 LIVELY_TOKEN=멤버토큰을 심어 훅이 멤버 토큰으로 나가므로(appId 없음) 게이트를 안 만나지만,
 *       비격리(단일유저 박스)에선 LIVELY_TOKEN 미주입 → LIVELY_HOME 을 존중하는 훅(run-custom·sync-harness-assets)이
 *       **앱 토큰**으로 나가 이 게이트에 걸린다. 이 목록이 없으면 그 경우 컨텍스트 주입·자산 동기화가 조용히 403 된다.
 *   즉 이 EXEMPT 는 배포형태(격리/비격리)·토큰출처(멤버/앱)와 **무관하게** 인프라 배관을 살려 두는 명시적 경계다.
 *
 *  ⚠ 안전 불변식: 여기 오르는 것은 **읽기/보고/인프라(전부 scope:null, 콘텐츠 미변경)** 뿐이다.
 *   콘텐츠 쓰기 능력(knowledge_save·source_save·db_query·project_create_v6 …)은 **절대** 넣지 않는다 — 계속 grant 로 게이트된다.
 *   목록을 좁게 유지하고, 각 항목은 '어느 훅/경로가 왜 필요로 하나'를 근거로만 추가한다(surface-snapshot 은 불변 — 능력 추가 아님).
 */
export const APP_TOOL_EXEMPT: ReadonlySet<string> = new Set([
  "whoami",                     // LLM 자기 신원 — 하네스가 부팅 때 호출(앱 토큰). 읽기(GET /api/ui/me/whoami).
  "org_preview",                // session-preload 컨텍스트 주입 — 멤버 정적 컨텍스트 렌더. 읽기·scope:null(GET /api/ui/org/preview).
  "org_runtime_config",         // session-preload 훅 토글/너지 동적 fetch. 읽기·scope:null(GET /api/ui/org/runtime-config).
  "org_runner_assets",          // sync-harness-assets 자산 materializer fetch. 읽기·scope:null(GET /api/ui/org/runner/assets).
  "org_runner_hooks",           // run-custom 커스텀 훅 소스 fetch. 읽기·scope:null(GET /api/ui/org/runner/hooks).
  "org_runner_hook_report",     // run-custom 훅 실패 텔레메트리(본인 신원으로만 기록). 보고·scope:null(POST /api/ui/org/runner/hook-report).
  "me_harness_report",          // sync-harness-assets 로컬 하네스 인벤토리 메타 보고(본문·메모리 미포함). 보고·scope:null(POST /api/ui/me/harness-report).
  "me_harness_local_pref_plan", // sync-harness-assets 이 머신 로컬 끄기 계획 pull. 읽기·scope:null(GET /api/ui/me/harness-local-pref/plan).
  // 제외 근거(의도적 미포함):
  //  · terminal/sessions/*(work-flag active/exited) — 능력이 아니라 bare Express 라우트(src/terminal/routes.ts) → requireAppTool 미경유.
  //  · recall_route·project_similar — 코어 훅이 아니라 **선택형 예제 org 훅**(domain-recall·project-bind-nudge)만 호출. 코어 의존 아님 → 좁게 유지.
]);

/**
 * 앱 도구 판정(순수) — appId·grant.tools·도구이름만으로 결정.
 *  - appId 없음(일반 세션) → 항상 허용
 *  - EXEMPT 인프라 능력 → grant 무관 허용(세션 배관 — 위 APP_TOOL_EXEMPT 주석)
 *  - appId 있는데 grant.tools 가 null(grant 사라짐) → 전부 차단(fail-closed)
 *  - 그 외 → toolAllowed(글롭 매칭)
 */
export function decideAppTool(appId: string | undefined, tools: string[] | null, toolName: string): boolean {
  if (!appId) return true;
  if (APP_TOOL_EXEMPT.has(toolName)) return true; // 읽기/보고/인프라 배관 — grant 무관(콘텐츠 쓰기는 여기 없음)
  if (tools === null) return false;
  return toolAllowed(tools, toolName);
}

/** 이 유저(앱 세션이면 user.appId 존재)가 이 도구를 호출할 수 있나. 일반 세션(appId 없음)은 항상 true. */
export async function appToolAllowed(user: LivelyUser, toolName: string): Promise<boolean> {
  if (!user.appId) return true; // DB 조회 없이 빠르게 통과(일반 세션 핫패스)
  const tools = await grantTools(user.appId, user.userId);
  return decideAppTool(user.appId, tools, toolName);
}

/** requireScope 옆에서 부르는 게이트. 앱 세션이 허용 밖 도구를 부르면 403. */
export async function requireAppTool(user: LivelyUser, toolName: string): Promise<void> {
  if (!(await appToolAllowed(user, toolName))) {
    throw new HttpError(403, `이 앱 세션은 '${toolName}' 도구를 쓸 수 없습니다(앱 권한 밖)`);
  }
}

// 테스트 훅 — grant 캐시 비우기.
export function _clearAppToolCache(): void { grantCache.clear(); }
