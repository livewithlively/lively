// 앱이 선언한 MCP 도구를 게이트웨이 /mcp 에 올리고 부른다(#5050 앱 v2-40) — 보는 사람의 판으로, 요청마다.
//  배선: boot/mcp-transport.ts buildRegisteredServer 가 동적(http_proxy) · 프록시 MCP 도구 다음에 부른다(그래서 이름이 겹치면 그쪽이 이긴다).
//  선언 · 설치 검사 · 표시는 apps/app-mcp-decl.ts, 실행기는 apps/app-mcp-executors.ts, DB 읽기는 apps/app-mcp-store.ts.
//  명세: 지식 app-declared-mcp-tools-spec-v1 §4 등록 · §5 실행 · §6 권한 · §13 결정(상민 2026-10-28).
//
//  ── 누구에게 무엇이 보이나(목록) ────────────────────────────────────────────────────────────
//   · 세션 머리글 없는 연결(claude.ai · 데스크톱 · Claude Code 의 OAuth 연결)에서도 똑같이 — 라이블리 세션 · 앱 서버가 필요 없다.
//   · 앱: 켜짐 · 기본 앱 아님 · 빈 예약 아님 · 목록에 서는 앱(listsAppFor — 남이 만드는 나만 보는 앱은 관리자에게도 안 선다). 판정은 appToolsHolder 하나.
//   · 판: 그 사람이 보는 판(visibility.appViewFor) — 초안을 고친 사람은 초안의 도구, 나머지는 공개 판의 도구. org_app.manifest 를 바로 안 읽는다.
//   · 동의한 앱의 도구는 앱이 쓴 설명 · 입력 그대로, 동의 전에는 게이트웨이가 쓴 한 줄 설명 · 빈 입력(apps/app-mcp-decl.ts consentPresentation).
//   · 읽기 전용 연결(x-lively-mode=readonly)은 L0 만. 인코그니토는 부르는 쪽이 아예 안 부른다. 앱 토큰 · 앱 서버 주체 · scope memory 없는 토큰엔 안 올린다(★5).
//   · 실행기가 없는 kind(새 코어에서 깔고 되돌린 앱)는 올리지 않는다. 실행기가 하나도 없는 코어는 DB 도 안 본다.
//  ── 부르기(목록은 표시일 뿐 — 판정은 부를 때 처음부터 다시) ───────────────────────────────────
//   ① 토큰(앱 토큰 아님 · scope memory) ② 앱이 지금도 켜져 있고 이 사람의 목록에 서는가 ③ 그 사람의 판에 이 도구가 있고 약속 지문이 목록 때와 같은가
//   (sessioned 모드에서만 걸린다 — apps/app-mcp-decl.ts «약속 지문») ④ 읽기 전용 연결이면 L0 만 ⑤ 동의 — 없으면 동의 주소와 함께 거절(★3)
//   ⑥ 구성원 ⑦ 그 판의 입력 스키마로 인자 검사 ⑧ 실행기. 오류는 전부 도구 오류(isError)로 돌려주고 호출 기록(mcp_call_log)엔 그 앱으로 남는다.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope, type LivelyUser } from "../context.js";
import { getApp, getActiveGrant, listActiveGrants } from "../org/store/apps.js";
import { getMember } from "../org/store/members.js";
import { currentTenant } from "../org/tenant-context.js";
import { TOOL_APP_META_KEY } from "../org/policies/tool-log.js";
import { viewAppFor } from "../apps/app-view.js";
import { appViewFor, listsAppFor, isEmptyDraftApp, addressVariantFor, type AppVisState, type Viewer } from "../apps/visibility.js";
import { isBuiltinSource } from "../apps/store-ddl.js";
import { appMcpToolsOf, appMcpToolContract, consentPresentation, appConsentUrl, renderToolResultText, appLabel, wellFormedText, type AppMcpToolDecl } from "../apps/app-mcp-decl.js";
import { appMcpExecutor, appMcpExecutorKinds } from "../apps/app-mcp-executors.js";
import { listMcpToolApps, type McpToolAppRow } from "../apps/app-mcp-store.js";
import { CONSENT_REQUIRED } from "../apps/app-consent.js";
import { jsonSchemaToZodShape } from "./json-schema.js";
import { gatewayUrl } from "../gateway-url.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";

/** 앱 도구를 부르는 데 토큰이 가져야 하는 scope — 조직 콘텐츠(지식 · 과업 · 자료)와 같은 축(docs/architecture.ko.md · 명세 §6). */
export const APP_MCP_CALL_SCOPE = "memory";

interface ToolText { type: "text"; text: string }
interface ToolResult { content: ToolText[]; isError?: boolean; _meta?: Record<string, unknown>; [k: string]: unknown }

//  글에 실행기 · 앱이 정한 글자가 섞일 수 있다(HttpError 글 · 앱 이름) — 짝 없는 대리 글자는 걷어 싣는다.
const toolError = (text: string, code: string, extra: Record<string, unknown> = {}): ToolResult =>
  ({ content: [{ type: "text", text: wellFormedText(text) }], isError: true, _meta: { "lively/code": code, ...extra } });

const viewerOf = (u: LivelyUser): Viewer => ({ userId: u.userId, scopes: u.scopes ?? [] });

/**
 * 이 앱이 이 사람에게 도구를 내놓을 수 있는 자리인가 — 목록과 부르기가 같은 판정을 쓴다(한쪽만 바뀌어 어긋나지 않게).
 *  기본 앱(덮어쓴 것 포함) · 빈 예약 · 목록에 안 서는 앱(남이 만드는 나만 보는 앱)은 아니다. 켜짐 · 상태는 부르는 쪽이 각자 본다(목록 쿼리가 이미 거른다).
 */
export function appToolsHolder(app: AppVisState & { source: unknown; current_version_no?: number | null }, who: Viewer): boolean {
  return !isBuiltinSource(app.source) && !isEmptyDraftApp(app) && listsAppFor(app, who);
}

/** 목록에 올릴 앱 하나 — 그 사람이 보는 판의 이름표 · 선언. */
interface ListedApp { row: McpToolAppRow; title: string; decls: AppMcpToolDecl[] }

//  같은 까닭의 경고는 워크스페이스마다 한 번만 — 목록 짜기 · 등록은 MCP 요청마다 돈다(키가 1000개를 넘으면 비우고 다시 센다). 매니지드는 한 프로세스에
//   워크스페이스가 여럿이라 키와 기록에 워크스페이스를 넣는다. 키의 앱 id · 도구 이름엔 ':' 이 없다.
const warned = new Set<string>();
function warnOnce(key: string, obj: Record<string, unknown>, msg: string): void {
  const tenant = currentTenant()?.id ?? null;
  const k = `${tenant ?? "-"}:${key}`;
  if (warned.has(k)) return;
  if (warned.size > 1000) warned.clear();
  warned.add(k);
  logger.warn({ ...obj, tenant }, msg);
}

/** 이 사람의 목록에 설 앱과 도구(판정만 — 공개 판 행이 빠진 불변식 위반만 기록으로 알린다). 공개 판을 보는 앱의 선언은 row.published 에서. */
export function listedAppsFor(rows: readonly McpToolAppRow[], who: Viewer, readOnly: boolean): ListedApp[] {
  const out: ListedApp[] = [];
  for (const row of rows) {
    if (!appToolsHolder(row, who)) continue;
    const view = appViewFor(row, who);
    if (view === "none") continue;
    let mcp: unknown = row.mcp_tools;
    let title = row.title;
    if (view === "published") {
      //  공개 판 행이 없으면(불변식 위반) 설치된 상태를 보인다 — app-view.ts viewAppFor 와 같은 쪽으로 틀린다.
      if (row.published) { mcp = row.published.mcp_tools; title = row.published.title || row.title; }
      else {
        warnOnce(`published:${row.id}:${row.published_version_no}`, { app: row.id, published: row.published_version_no },
          "공개 판 행이 없어 설치된 상태의 도구를 보인다(#5050 · #4667 불변식)");
      }
    }
    const decls = appMcpToolsOf({ mcp_tools: mcp }).filter((d) => !!appMcpExecutor(d.run.kind) && (!readOnly || d.level === "L0"));
    if (decls.length) out.push({ row, title, decls });
  }
  return out;
}

/**
 * 요청마다 — 이 사람이 볼 수 있는 앱의 선언 도구를 server 에 올린다. 올린 수. 실패는 부르는 쪽이 삼킨다(fail-open — 기본 표면은 그대로).
 *  user 가 없거나 앱 토큰 · 앱 서버 주체면 0(★5 — 앱 세션은 이미 store_* 를 쓴다). 부를 scope 가 없는 토큰에도 0(불러도 거절될 도구를 늘어놓지 않는다).
 *  실행기가 하나도 없으면 DB 를 보기 전에 0 — 그 코어에선 어떤 선언도 목록에 못 선다.
 */
export async function registerAppDeclaredTools(server: McpServer, user: LivelyUser | undefined, opts: { readOnly: boolean }): Promise<number> {
  if (!user?.userId || user.appId || user.appServer || !(user.scopes ?? []).includes(APP_MCP_CALL_SCOPE)) return 0;
  if (!appMcpExecutorKinds().length) return 0;
  const rows = await listMcpToolApps();
  if (!rows.length) return 0;
  const listed = listedAppsFor(rows, viewerOf(user), opts.readOnly);
  if (!listed.length) return 0;
  const consented = new Set((await listActiveGrants(user.userId)).map((g) => g.app_id));
  let n = 0;
  for (const a of listed) {
    const agreed = consented.has(a.row.id);
    for (const d of a.decls) {
      try {
        const shown = agreed ? { title: d.title ?? d.name, description: d.description } : consentPresentation(a.title, d);
        const ref: CallRef = { appId: a.row.id, name: d.name, contract: appMcpToolContract(d), readOnly: opts.readOnly };
        //  `as never` 둘 — inputSchema 가 갈래마다 다른 모양(zod raw shape · zod object)이라 SDK 의 제네릭 추론이 한 꼴로 못 묶는다. 값은 둘 다 SDK 가 받는 꼴이다.
        server.registerTool(d.name, {
          title: shown.title,
          description: shown.description,
          //  동의 전에는 빈 입력(무엇이든 받는다) — 인자 모양이 틀려도 «동의가 필요하다» 가 먼저 보이게. 인자 검사는 부를 때 그 판의 스키마로 한다.
          inputSchema: agreed ? jsonSchemaToZodShape(d.input) : z.object({}).passthrough(),
          annotations: { readOnlyHint: d.level === "L0", destructiveHint: false },
          _meta: { [TOOL_APP_META_KEY]: a.row.id },
        } as never, ((args: Record<string, unknown>, extra: unknown) => callAppDeclaredTool(ref, args, extra)) as never);
        n++;
      } catch (err) {
        //  같은 이름이 이미 섰다 — 빌트인 · http_proxy · 프록시 도구 · 먼저 설치된 앱이 이긴다(설치 검사 밖에서 생긴 이름 · 그 뒤에 생긴 조직 도구).
        warnOnce(`clash:${a.row.id}:${d.name}`, { app: a.row.id, tool: d.name, err: (err as Error)?.message },
          "앱 선언 도구를 올리지 못했다 — 이름이 이미 쓰였거나 선언을 읽지 못함(#5050)");
      }
    }
  }
  return n;
}

interface CallRef { appId: string; name: string; contract: string; readOnly: boolean }

/** 부르기 — 머리말 ①~⑧. 목록 때 본 것은 이름 · 앱 · 약속 지문뿐이고 나머지는 지금 다시 읽는다. */
export async function callAppDeclaredTool(ref: CallRef, rawArgs: unknown, extra: unknown): Promise<ToolResult> {
  const user = resolveUser(extra);
  if (user.appId || user.appServer) return toolError("앱 토큰으로는 앱이 선언한 도구를 부를 수 없습니다", "app_token");
  try { requireScope(user, APP_MCP_CALL_SCOPE); }
  catch { return toolError(`이 연결(토큰)에는 앱 도구를 부를 권한(scope '${APP_MCP_CALL_SCOPE}')이 없습니다`, "scope"); }
  const who = viewerOf(user);
  const gone = (): ToolResult => toolError(`앱 '${ref.appId}' 의 도구 '${ref.name}' 을(를) 지금은 쓸 수 없습니다 — 도구 목록을 다시 받아 주세요`, "tool_unavailable");

  const installed = await getApp(ref.appId);
  if (!installed || installed.status !== "active" || !installed.enabled || !appToolsHolder(installed, who)) return gone();
  const seen = await viewAppFor(installed, who);
  if (seen.view === "none") return gone();
  const decl = appMcpToolsOf(seen.app.manifest).find((d) => d.name === ref.name);
  if (!decl) return gone();
  if (appMcpToolContract(decl) !== ref.contract) {
    return toolError(`앱 「${appLabel(seen.app.title)}」 의 도구 '${ref.name}' 선언이 바뀌었습니다 — 도구 목록을 다시 받아 확인한 뒤 다시 부르세요`, "tool_changed");
  }
  if (ref.readOnly && decl.level !== "L0") return toolError("읽기 전용 연결에서는 쓰는 도구(L1)를 부를 수 없습니다", "read_only");
  const executor = appMcpExecutor(decl.run.kind);
  if (!executor) return toolError(`이 게이트웨이는 실행기 '${decl.run.kind}' 를 모릅니다 — 관리자에게 알려 주세요`, "executor_unavailable");

  const variant = addressVariantFor(installed, who);
  const grant = await getActiveGrant(ref.appId, user.userId);
  if (!grant) {
    const url = appConsentUrl(await gatewayUrl().catch(() => null), ref.appId, variant);
    return toolError(
      `앱 「${appLabel(seen.app.title)}」 사용에 아직 동의하지 않았습니다 — 앱 화면에서 동의한 뒤 다시 부르세요.` + (url ? ` 동의할 곳: ${url}` : " (라이블리에서 이 앱을 열면 동의 창이 뜹니다)"),
      CONSENT_REQUIRED, url ? { "lively/consent_url": url } : {});
  }
  const member = await getMember(user.userId);
  if (!member || member.state !== "active") return toolError("이 워크스페이스의 활성 구성원만 앱 도구를 부를 수 있습니다", "member");

  const parsed = z.object(jsonSchemaToZodShape(decl.input)).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return toolError(`인자가 도구 '${ref.name}' 의 입력과 맞지 않습니다 [${first?.path.join(".") || "(전체)"}]: ${first?.message ?? "형식 오류"}`, "bad_args");
  }
  const args: Record<string, unknown> = parsed.data;

  const nick = String(member.nickname ?? "").trim();
  const name = (member.use_nickname && nick ? nick : String(member.display_name ?? "").trim()) || member.id;
  const tokenScopes = [...(user.scopes ?? [])];
  const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
  //  진행 알림 — 부른 쪽이 progressToken 을 실었을 때만(MCP 진행 규약). 무상태 /mcp 는 답을 SSE 로 흘리므로 기다리는 동안 알림이 먼저 나간다.
  const { _meta: reqMeta, sendNotification } = (extra ?? {}) as { _meta?: { progressToken?: unknown }; sendNotification?: (n: unknown) => Promise<void> };
  const progressToken = reqMeta?.progressToken;
  const progress = (typeof progressToken === "string" || typeof progressToken === "number") && typeof sendNotification === "function"
    ? async (p: { progress: number; total?: number; message?: string }): Promise<void> => {
      await sendNotification({ method: "notifications/progress", params: { progressToken, progress: p.progress, ...(p.total !== undefined ? { total: p.total } : {}),
        ...(p.message ? { message: wellFormedText(p.message) } : {}) } }).catch(() => undefined);   // 부른 쪽이 떠났다 — 실행기는 그대로 간다
    }
    : undefined;
  try {
    const out = await executor.call({
      app: { id: installed.id, title: seen.app.title, view: seen.view, variant, content_hash: seen.app.content_hash },
      tool: decl,
      args,
      caller: {
        userId: user.userId, name, tokenScopes,
        grant: { scopes: [...grant.scopes], tools: [...grant.tools] },
        scopes: tokenScopes.filter((s) => grant.scopes.includes(s)),
        ...(user.oauthClientId ? { oauthClientId: user.oauthClientId } : {}),
        ...(user.tokenHashPrefix ? { tokenHashPrefix: user.tokenHashPrefix } : {}),
      },
      ...(signal ? { signal } : {}),
      ...(progress ? { progress } : {}),
    });
    const r = renderToolResultText(out?.data, undefined, out?.truncatedFrom);
    const meta = { ...(out?.meta ?? {}), ...(r.truncated ? { "lively/truncated": true, "lively/bytes": r.bytes } : {}) };
    return { content: [{ type: "text", text: r.text }], ...(Object.keys(meta).length ? { _meta: meta } : {}) };
  } catch (e) {
    if (e instanceof HttpError) return toolError(e.message, typeof e.body?.code === "string" ? e.body.code : `http_${e.status}`);
    logger.error({ app: ref.appId, tool: ref.name, kind: decl.run.kind, err: (e as Error)?.message, stack: (e as Error)?.stack }, "앱 선언 도구 실행 실패(#5050)");
    return toolError("도구를 실행하지 못했습니다 — 잠시 뒤 다시 하세요", "executor_failed");
  }
}
