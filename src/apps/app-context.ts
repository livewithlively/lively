// 앱 맥락 범위(#5100 앱 v2-43) — 매니페스트 `context` 선언을 앱 토큰 요청의 읽기 범위(v6/read-scope.ts)로 푼다.
//
//  · 선언(매니페스트 · apps/manifest.ts contextSchema): knowledge_categories(카테고리 key) · source_kinds(자료 종류). 폴더는 다음 판.
//  · 어느 판의 선언인가(상민 2026-10-28 결정 ③) — 표 · 도구 선언과 같은 규칙(viewAppFor): 앱 주소 · 앱 서버 · 백그라운드 작업은 그 주소의
//    판(LivelyUser.appAddress), 앱 세션 · AI 작업 컨테이너는 그 사람이 보는 판(초안을 고친 사람만 초안). AI 작업 토큰엔 판이 없어 «그 사람이
//    보는 판» 이 된다 — 남의 초안이 넓힌 범위가 내 실행에 새지 않는다는 성질은 같다.
//  · 어디서 거나 — 어댑터 세 곳(MCP server.ts instrument · REST web.ts 능력 어댑터 · 앱 화면 다리 capabilities/app-tool-call.ts runAppTool)이
//    앱 토큰 요청을 runWithAppReadScope 로 감싼다. 판정은 공개범위 술어가 한다(read-scope.ts 머리말).
//  · 범위를 선언하지 않은 앱 · 앱 토큰이 아닌 요청은 아무것도 바뀌지 않는다(저장소에 범위가 없다 — 무회귀).
import type { LivelyUser } from "../context.js";
import { getApp } from "../org/store/apps.js";
import { viewAppFor } from "./app-view.js";
import { withReadScope, type ReadScope } from "../v6/read-scope.js";
import { itemsPool, q } from "../db/client.js";
import { currentTenant } from "../org/tenant-context.js";
import { HttpError } from "../http-error.js";
import { logToolCall } from "../org/policies/tool-log.js";
import { logger } from "../log.js";

/** 매니페스트의 맥락 범위 선언(정규화 · 중복 제거). */
export interface AppContextDecl { knowledgeCategories: string[]; sourceKinds: string[] }

/**
 * 저장된 매니페스트의 context 선언(순수 · 던지지 않는다). 칸이 없으면 null(범위 없음 = 종전).
 *  모양이 틀리면 **빈 선언**(닫힘) — 좁히려던 선언을 읽지 못했다고 넓게 열지 않는다. 저장 관문(parseAppManifest)이 모양을 막으니 보통은 오지 않는다.
 */
export function appContextDeclOf(manifest: unknown): AppContextDecl | null {
  if (!manifest || typeof manifest !== "object" || !("context" in manifest)) return null;
  const raw = (manifest as { context?: unknown }).context;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { knowledgeCategories: [], sourceKinds: [] };
  const o = raw as Record<string, unknown>;
  const strs = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];
  return { knowledgeCategories: strs(o.knowledge_categories), sourceKinds: strs(o.source_kinds) };
}

/** 카테고리 key → id(합쳐진 카테고리는 빼고 — category_key_uq 와 같은 기준). 없는 key 는 버린다(범위가 줄어드는 쪽). */
async function categoryIdsForKeys(keys: readonly string[]): Promise<number[]> {
  if (!keys.length) return [];
  const rows = await q(itemsPool, `SELECT id FROM category WHERE key = ANY($1::text[]) AND state <> 'merged'`, [[...keys]]);
  return rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
}

//  풀이 기억 — 앱 토큰 요청마다 앱 행 · 판 행 · 카테고리를 읽지 않게. 짧게 둬서 범위를 바꾸고 저장하면 몇 초 안에 반영된다
//   (앱 동의의 도구 목록 기억 apps/principal.ts grantCache 와 같은 5초). 키에 워크스페이스를 넣는다 — 한 게이트웨이가 여러 워크스페이스를
//   받을 때 같은 앱 id · 구성원 id 가 겹쳐도 남의 범위를 쓰지 않게. 판은 사람(초안을 고친 사람인가)과 주소로 갈리니 둘 다 넣는다.
const CACHE_TTL_MS = 5000;
const CACHE_MAX = 2000;   // 키는 워크스페이스 × 앱 × 사람 × 주소라 보통 작다 — 넘치면 통째로 비운다(다음 요청이 다시 푼다)
const cache = new Map<string, { scope: ReadScope | null; at: number }>();
/** 기억 비우기 — 앱을 설치 · 저장하면 부른다(install-run · 범위를 좁힌 저장이 이 게이트웨이에선 곧바로 반영되게). 다른 게이트웨이 프로세스는 5초 안에. */
export function clearAppContextCache(): void { cache.clear(); }

/** 닫힌 범위 — 앱을 못 찾았다(토큰 검증이 보통 먼저 막는다). 아무것도 읽지 못한다. */
const closed = (appId: string): ReadScope => ({ appId, knowledgeCategoryIds: [], sourceKinds: [] });

/** 이 앱 토큰 요청의 읽기 범위 — 앱 토큰이 아니거나 앱이 범위를 선언하지 않았으면 null. */
export async function resolveAppReadScope(user: Pick<LivelyUser, "appId" | "userId" | "scopes" | "appAddress">): Promise<ReadScope | null> {
  const appId = user.appId;
  if (!appId) return null;
  const key = [currentTenant()?.id ?? "", appId, user.userId ?? "", user.appAddress ?? ""].join("\0");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scope;
  const scope = await computeScope(appId, user);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { scope, at: Date.now() });
  return scope;
}

async function computeScope(appId: string, user: Pick<LivelyUser, "userId" | "scopes" | "appAddress">): Promise<ReadScope | null> {
  const app = await getApp(appId);
  if (!app) return closed(appId);
  //  판(결정 ③) — 표 · 도구와 같은 viewAppFor. 'none'(이 토큰의 scope 로는 그 판을 못 본다 — 관리자가 남의 «나만» 앱을 연 경우 등)이면
  //   설치된 판의 선언을 쓴다: 여기는 문을 여는 자리가 아니라(앱을 열 수 있나는 토큰 발급 · 다리가 이미 정했다) 선언을 찾는 자리다.
  //   앱 주소 길(appAddress 가 있는 요청)은 'none' 이면 app-front-api 가 먼저 404 로 막아 여기까지 오지 않는다(격리 리뷰 N8).
  const seen = await viewAppFor(app, { userId: String(user.userId ?? ""), scopes: user.scopes ?? [], ...(user.appAddress ? { address: user.appAddress } : {}) });
  const decl = appContextDeclOf(seen.view === "none" ? app.manifest : seen.app.manifest);
  if (!decl) return null;
  return { appId, knowledgeCategoryIds: await categoryIdsForKeys(decl.knowledgeCategories), sourceKinds: decl.sourceKinds };
}

/**
 * fn 을 이 요청의 앱 읽기 범위 안에서 돌린다 — 앱 토큰이 아니면 그대로 돈다(일반 세션 핫패스는 비용 0).
 *  범위는 지식 · 자료 술어가 처음 물을 때 한 번 푼다(앱 토큰 호출 대부분은 지식을 안 읽는다).
 */
export function runWithAppReadScope<T>(user: Pick<LivelyUser, "appId" | "userId" | "scopes" | "appAddress"> | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!user?.appId) return fn();
  return withReadScope(() => resolveAppReadScope(user), fn);
}

/**
 * 설치 · 저장 관문(#5100 «설치·판 저장 때 검증한다») — 선언한 카테고리 key 가 이 워크스페이스에 있어야 한다. 없으면 400.
 *  빈 결과로 두면 앱 제작자는 «그런 지식이 없다» 로 읽는다(오타 하나로 범위가 통째로 닫힌다). 자료 종류 · 모양은 파서(parseAppManifest)가 이미 봤다.
 *  나중에 카테고리를 지우거나 합치면 범위는 줄어드는 쪽으로만 바뀐다(categoryIdsForKeys 가 버린다) — 저장된 앱을 막지는 않는다.
 */
export async function assertContextInstallable(manifest: unknown): Promise<void> {
  const decl = appContextDeclOf(manifest);
  if (!decl?.knowledgeCategories.length) return;
  const rows = await q(itemsPool, `SELECT key FROM category WHERE key = ANY($1::text[]) AND state <> 'merged'`, [decl.knowledgeCategories]);
  const have = new Set(rows.map((r) => String(r.key)));
  const missing = decl.knowledgeCategories.filter((k) => !have.has(k));
  if (missing.length) {
    throw new HttpError(400, `매니페스트 오류 [context.knowledge_categories]: 이 워크스페이스에 없는 카테고리입니다 — ${missing.map((k) => `'${k}'`).join(", ")} (category_list 의 key 를 적으세요)`);
  }
}

/** 범위 밖 읽기를 거절할 때의 표지 — REST 는 본문 code 로, MCP 는 글로 받는다. */
export const OUT_OF_APP_CONTEXT = "out_of_app_context";

/**
 * 앱 맥락 범위 밖 읽기(#5100 «거부하고 기록을 남긴다») — 기록을 남기고 던질 오류를 돌려준다.
 *  기록 자리는 도구 호출 기록(mcp_call_log — 관리자 «앱 활동» org_app_activity 가 앱별 실패로 센다). MCP(server.ts instrument)와
 *  앱 화면 다리(runAppTool)는 실패한 호출을 이미 거기 적으므로, 어댑터가 적지 않는 REST 능력 호출(앱 서버 · 앱 작업)만 여기서 적는다
 *  (두 번 적지 않게). 운영 기록(logger)은 길마다 한 줄 — 어느 앱이 무엇을 열려다 막혔는지.
 */
export function appContextDeniedError(d: { appId: string; actor: string | null; tool: string; target: string; source?: string; message: string }): HttpError {
  logger.warn({ app: d.appId, actor: d.actor, tool: d.tool, target: d.target, source: d.source ?? null }, "[app-context] 앱 맥락 범위 밖 읽기를 거절했다(#5100)");
  if (d.source === "web") {
    logToolCall({ tool: d.tool, harness: "rest", actor: d.actor, app: d.appId, args: { target: d.target }, ok: false, error: d.message, durationMs: 0 });
  }
  return new HttpError(403, d.message, { body: { code: OUT_OF_APP_CONTEXT } });
}

//  범위를 못 지키는 도구(#5100 격리 리뷰 N2 · 재검토 B1' · 재재검토 B-1~B-3) — 지금 카테고리 연결이 없는 것(지운 행의 스냅샷 · 미분류 지식)이나
//   공개범위 술어를 지나지 않는 기록을 돌려주거나 되살리거나, 분류를 바꿔 범위 자체를 넓힌다. 범위를 가를 근거가 없으니 닫는다.
//   이름 → 거절 까닭(앱 제작자가 읽는 글).
const TRASH_WHY = "지운 지식 · 자료는 범위 안인지 가를 근거(카테고리 연결)가 남지 않습니다";
const NEW_TOKEN_OR_RUN_WHY = "새 토큰을 내주거나 구성원 이름으로 따로 실행을 띄웁니다 — 그 토큰 · 실행(과 그 기록)의 라이블리 읽기엔 앱 맥락 범위가 없습니다";
export const APP_CONTEXT_UNSAFE_TOOLS: ReadonlyMap<string, string> = new Map([
  ["deleted_list", TRASH_WHY],
  ["content_snapshot", TRASH_WHY],
  ["content_restore", TRASH_WHY],
  ["content_purge", TRASH_WHY],
  ["trash_counts", TRASH_WHY],
  ["content_undo", "그 사람의 마지막 웹 변경을 되돌립니다 — 지운 범위 밖 문서도 되살리고 제목을 돌려줍니다"],
  ["my_lively_log", "그 사람이 읽은 지식의 이름 · 제목을 도구 호출 기록에서 곧바로 읽습니다"],
  //  새 자격 · 실행(격리 재재재검토) — 새 토큰엔 앱이 없고(appId 없음 → 범위 없음), 구성원 이름으로 띄운 실행(위탁 · 브로커)은 그 사람의 토큰으로 읽는다.
  ["org_token_mint_self", NEW_TOKEN_OR_RUN_WHY],
  ["org_token_mint", NEW_TOKEN_OR_RUN_WHY],
  ["device_approve", NEW_TOKEN_OR_RUN_WHY],
  ["app_server_token_mint", NEW_TOKEN_OR_RUN_WHY],
  ["broker_run", NEW_TOKEN_OR_RUN_WHY],
  ["me_liv_open", NEW_TOKEN_OR_RUN_WHY],   // 리브 세션을 지시(text)와 함께 연다
]);
//  묶음은 이름 꼴로 막는다 — 이름을 하나씩 적으면 새 형제가 생길 때마다 열린다(재재검토에서 둘이, 재재재검토 뒤에 셋이 그렇게 빠졌다).
//   꼴로 막으면 같은 묶음의 새 도구도 기본이 닫힘이다.
//   · 맥락 파이프라인(수집 · 증류 · 카테고리 붙이기 · 관리기)은 워크스페이스 전체를 다룬다: 수집 미리보기 · 실행 기록 · 레인 표본 · 미분류 지식 ·
//     관리기 발견의 인용(지운 문서 것까지)을 공개범위 술어 없이 읽고, 관리기 «적용» 은 지식을 다른 카테고리로 옮긴다(앱이 제 범위를 넓히는 길).
//   · 구성원 이름의 실행(위탁 · 예약 작업 · 프로젝트 대화)은 그 사람의 토큰으로 도는 AI 를 띄우고 그 기록을 돌려준다.
const PIPELINE_WHY = "맥락 파이프라인(수집 · 증류 · 카테고리 붙이기 · 관리기) 도구는 워크스페이스 전체의 지식 · 자료를 범위 없이 다루고 분류를 바꿉니다";
export const APP_CONTEXT_UNSAFE_FAMILIES: ReadonlyArray<{ label: string; match: RegExp; why: string }> = [
  { label: "수집", match: /^(collect_|org_collector_|org_connector_)|^org_[a-z0-9]+_collect(_|$)/, why: PIPELINE_WHY },
  { label: "증류 · 카테고리 붙이기 · 관리기", match: /^org_(distiller|classifier|manager)_/, why: PIPELINE_WHY },
  { label: "위탁", match: /^delegate_/, why: NEW_TOKEN_OR_RUN_WHY },          // 워커 노드의 구성원 세션 · 그 상태 · 기록
  { label: "예약 작업", match: /^cron_/, why: NEW_TOKEN_OR_RUN_WHY },         // 헤드리스 AI 를 구성원 이름으로 예약 · 지금 실행
  { label: "프로젝트 대화", match: /^project_chat_/, why: NEW_TOKEN_OR_RUN_WHY },   // 헤드리스 대화 한 턴 · 그 기록
];

/** 범위를 못 지키는 도구면 거절 까닭, 아니면 null(순수). */
export function appContextUnsafeWhy(tool: string): string | null {
  const exact = APP_CONTEXT_UNSAFE_TOOLS.get(tool);
  if (exact) return exact;
  for (const f of APP_CONTEXT_UNSAFE_FAMILIES) if (f.match.test(tool)) return f.why;
  return null;
}

/**
 * 범위를 못 지키는 도구를 맥락 범위를 선언한 앱 토큰이 부르면 핸들러에 닿기 전에 거절(403)한다. 앱 토큰이 아니거나 범위를 선언하지 않은 앱이면
 *  아무것도 안 한다. 부르는 자리는 세 어댑터(MCP capabilities/index.ts · REST web.ts · 앱 화면 다리 runAppTool)의 앱 도구 판정(requireAppTool)
 *  바로 뒤다. 범위는 요청 저장소가 아니라 토큰에서 곧바로 푼다(resolveAppReadScope) — 감싸기 밖에서 불려도 같은 답이다.
 *  기록: REST(source "web")는 여기서 적고, MCP(instrument) · 다리(runAppTool 의 catch)는 각자 적는다.
 */
export async function assertAppContextSafeTool(user: Pick<LivelyUser, "appId" | "userId" | "scopes" | "appAddress">, tool: string, source?: string): Promise<void> {
  const why = appContextUnsafeWhy(tool);
  if (!why || !user.appId) return;
  const scope = await resolveAppReadScope(user);
  if (!scope) return;
  throw appContextDeniedError({ appId: scope.appId, actor: user.userId ?? null, tool, target: `tool:${tool}`, source,
    message: `'${tool}' 은(는) 맥락 범위(매니페스트 context)를 선언한 앱에서 쓸 수 없습니다 — ${why}` });
}
