// 앱이 선언한 MCP 도구를 게이트웨이 /mcp 에 올리고 부른다(#5050 앱 v2-40) — 보는 사람의 판으로, 요청마다.
//  배선: boot/mcp-transport.ts buildRegisteredServer 가 동적(http_proxy) · 프록시 MCP 도구 다음에 부른다(그래서 이름이 겹치면 그쪽이 이긴다).
//  선언 · 설치 검사 · 표시는 apps/app-mcp-tools.ts, 실행기는 apps/app-mcp-executors.ts, DB 읽기는 apps/app-mcp-store.ts.
//  명세: 지식 app-declared-mcp-tools-spec-v1 §4 등록 · §5 실행 · §6 권한 · §13 결정(상민 2026-10-28).
//
//  ── 누구에게 무엇이 보이나(목록) ────────────────────────────────────────────────────────────
//   · 세션 머리글 없는 연결(claude.ai · 데스크톱 · Claude Code 의 OAuth 연결)에서도 똑같이 — 라이블리 세션 · 앱 서버가 필요 없다.
//   · 앱: 켜짐 · 기본 앱 아님 · 빈 예약 아님 · 목록에 서는 앱(listsAppFor — 남이 만드는 나만 보는 앱은 관리자에게도 안 선다).
//   · 판: 그 사람이 보는 판(visibility.appViewFor) — 초안을 고친 사람은 초안의 도구, 나머지는 공개 판의 도구. org_app.manifest 를 바로 안 읽는다.
//   · 동의한 앱의 도구는 앱이 쓴 설명 · 입력 그대로, 동의 전에는 게이트웨이가 쓴 한 줄 설명 · 빈 입력(apps/app-mcp-tools.ts consentPresentation).
//   · 읽기 전용 연결(x-lively-mode=readonly)은 L0 만. 인코그니토는 부르는 쪽이 아예 안 부른다. 앱 토큰 · 앱 서버 주체엔 올리지 않는다(★5).
//   · 실행기가 없는 kind(새 코어에서 깔고 되돌린 앱)는 올리지 않는다.
//  ── 부르기(목록은 표시일 뿐 — 판정은 부를 때 처음부터 다시) ───────────────────────────────────
//   ① 토큰(앱 토큰 아님 · scope memory) ② 앱이 지금도 켜져 있고 이 사람의 목록에 서는가 ③ 그 사람의 판에 이 도구가 있고 약속 지문이 목록 때와 같은가
//   (다르면 «목록을 다시 받아라» — 하네스는 목록의 표시로 확인 절차를 정한다) ④ 읽기 전용 연결이면 L0 만 ⑤ 동의 — 없으면 동의 주소와 함께 거절(★3)
//   ⑥ 구성원 ⑦ 그 판의 입력 스키마로 인자 검사 ⑧ 실행기. 오류는 전부 도구 오류(isError)로 돌려주고 호출 기록(mcp_call_log)엔 그 앱으로 남는다.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope, type LivelyUser } from "../context.js";
import { getApp, getActiveGrant, listActiveGrants } from "../org/store/apps.js";
import { getMember } from "../org/store/members.js";
import { viewAppFor } from "../apps/app-view.js";
import { appViewFor, listsAppFor, isEmptyDraftApp, addressVariantFor, type Viewer } from "../apps/visibility.js";
import { isBuiltinSource } from "../apps/store-ddl.js";
import { appMcpToolsOf, appMcpToolContract, consentPresentation, appConsentUrl, renderToolResultText, appLabel, APP_TOOL_META_KEY, type AppMcpToolDecl } from "../apps/app-mcp-tools.js";
import { appMcpExecutor } from "../apps/app-mcp-executors.js";
import { listMcpToolApps, listPublishedMcpTools, type McpToolAppRow } from "../apps/app-mcp-store.js";
import { CONSENT_REQUIRED } from "../apps/app-consent.js";
import { jsonSchemaToZodShape } from "./json-schema.js";
import { gatewayUrl } from "../gateway-url.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";

/** 앱 도구를 부르는 데 토큰이 가져야 하는 scope — 조직 콘텐츠(지식 · 과업 · 자료)와 같은 축(docs/architecture.ko.md · 명세 §6). */
export const APP_MCP_CALL_SCOPE = "memory";

interface ToolText { type: "text"; text: string }
interface ToolResult { content: ToolText[]; isError?: boolean; _meta?: Record<string, unknown>; [k: string]: unknown }

const toolError = (text: string, code: string, extra: Record<string, unknown> = {}): ToolResult =>
  ({ content: [{ type: "text", text }], isError: true, _meta: { "lively/code": code, ...extra } });

const viewerOf = (u: LivelyUser): Viewer => ({ userId: u.userId, scopes: u.scopes ?? [] });

/** 목록에 올릴 앱 하나 — 그 사람이 보는 판의 이름표 · 선언. */
interface ListedApp { row: McpToolAppRow; title: string; decls: AppMcpToolDecl[] }

/** 이 사람의 목록에 설 앱과 도구(순수 — 판정만). 공개 판을 보는 앱의 선언은 heads 에서. */
export function listedAppsFor(rows: readonly McpToolAppRow[], heads: ReadonlyMap<string, { title: string; mcp_tools: unknown }>, who: Viewer, readOnly: boolean): ListedApp[] {
  const out: ListedApp[] = [];
  for (const row of rows) {
    if (isBuiltinSource(row.source) || isEmptyDraftApp(row) || !listsAppFor(row, who)) continue;
    const view = appViewFor(row, who);
    if (view === "none") continue;
    let mcp: unknown = row.mcp_tools;
    let title = row.title;
    if (view === "published") {
      const h = heads.get(row.id);
      //  공개 판 행이 없으면(불변식 위반) 설치된 상태를 보인다 — app-view.ts viewAppFor 와 같은 쪽으로 틀린다.
      if (h) { mcp = h.mcp_tools; title = h.title || row.title; }
      else logger.warn({ app: row.id, published: row.published_version_no }, "공개 판 행이 없어 설치된 상태의 도구를 보인다(#5050 · #4667 불변식)");
    }
    const decls = appMcpToolsOf({ mcp_tools: mcp }).filter((d) => !!appMcpExecutor(d.run.kind) && (!readOnly || d.level === "L0"));
    if (decls.length) out.push({ row, title, decls });
  }
  return out;
}

/**
 * 요청마다 — 이 사람이 볼 수 있는 앱의 선언 도구를 server 에 올린다. 올린 수. 실패는 부르는 쪽이 삼킨다(fail-open — 기본 표면은 그대로).
 *  user 가 없거나 앱 토큰 · 앱 서버 주체면 0(★5 — 앱 세션은 이미 store_* 를 쓴다). 부를 scope 가 없는 토큰에도 0(불러도 거절될 도구를 늘어놓지 않는다).
 */
export async function registerAppDeclaredTools(server: McpServer, user: LivelyUser | undefined, opts: { readOnly: boolean }): Promise<number> {
  if (!user?.userId || user.appId || user.appServer || !(user.scopes ?? []).includes(APP_MCP_CALL_SCOPE)) return 0;
  const rows = await listMcpToolApps();
  if (!rows.length) return 0;
  const who = viewerOf(user);
  const pubIds = rows.filter((r) => appViewFor(r, who) === "published").map((r) => r.id);
  const heads = pubIds.length ? await listPublishedMcpTools(pubIds) : new Map();
  const listed = listedAppsFor(rows, heads, who, opts.readOnly);
  if (!listed.length) return 0;
  const consented = new Set((await listActiveGrants(user.userId)).map((g) => g.app_id));
  let n = 0;
  for (const a of listed) {
    const agreed = consented.has(a.row.id);
    for (const d of a.decls) {
      const shown = agreed ? { title: d.title ?? d.name, description: d.description } : consentPresentation(a.title, d);
      const ref: CallRef = { appId: a.row.id, name: d.name, contract: appMcpToolContract(d), readOnly: opts.readOnly };
      try {
        server.registerTool(d.name, {
          title: shown.title,
          description: shown.description,
          //  동의 전에는 빈 입력(무엇이든 받는다) — 인자 모양이 틀려도 «동의가 필요하다» 가 먼저 보이게. 인자 검사는 부를 때 그 판의 스키마로 한다.
          inputSchema: agreed ? jsonSchemaToZodShape(d.input) : z.object({}).passthrough(),
          annotations: { readOnlyHint: d.level === "L0", destructiveHint: false },
          _meta: { [APP_TOOL_META_KEY]: a.row.id },
        } as never, ((args: Record<string, unknown>, extra: unknown) => callAppDeclaredTool(ref, args, extra)) as never);
        n++;
      } catch (err) {
        //  같은 이름이 이미 섰다 — 빌트인 · http_proxy · 프록시 도구 · 먼저 설치된 앱이 이긴다(설치 검사를 동시에 지났거나 그 뒤에 생긴 이름).
        logger.warn({ app: a.row.id, tool: d.name, err: (err as Error)?.message }, "앱 선언 도구 이름이 이미 쓰여 이 도구를 올리지 않았다(#5050)");
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
  if (!installed || installed.status !== "active" || !installed.enabled || isBuiltinSource(installed.source) || isEmptyDraftApp(installed) || !listsAppFor(installed, who)) return gone();
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
  try {
    const out = await executor.call({
      app: { id: installed.id, title: seen.app.title, view: seen.view, variant, content_hash: seen.app.content_hash },
      tool: decl,
      args,
      caller: {
        userId: user.userId, name, email: member.email ?? user.email ?? "", tokenScopes,
        grant: { scopes: [...grant.scopes], tools: [...grant.tools] },
        scopes: tokenScopes.filter((s) => grant.scopes.includes(s)),
        ...(user.oauthClientId ? { oauthClientId: user.oauthClientId } : {}),
        ...(user.tokenHashPrefix ? { tokenHashPrefix: user.tokenHashPrefix } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    const r = renderToolResultText(out?.data);
    return { content: [{ type: "text", text: r.text }], ...(r.truncated ? { _meta: { "lively/truncated": true, "lively/bytes": r.bytes } } : {}) };
  } catch (e) {
    if (e instanceof HttpError) return toolError(e.message, typeof e.body?.code === "string" ? e.body.code : `http_${e.status}`);
    logger.error({ app: ref.appId, tool: ref.name, kind: decl.run.kind, err: (e as Error)?.message, stack: (e as Error)?.stack }, "앱 선언 도구 실행 실패(#5050)");
    return toolError("도구를 실행하지 못했습니다 — 잠시 뒤 다시 하세요", "executor_failed");
  }
}
