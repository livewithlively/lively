// 앱 UI 브리지 tools/call (#1780 PR5b) — 샌드박스 iframe 의 앱 UI 가 postMessage 로 요청한 도구 호출을,
//  호스트(웹 셸)가 **멤버 토큰**으로 이 REST 로 넘긴다. 서버가 (멤버, app_id)로 **앱-principal 유저**를 구성해
//  기존 집행 경로(requireScope→requireAppTool→handler)를 **그대로** 태운다 — 앱 세션이 MCP 로 도구를 부르는 것과
//  동일한 경계다(브라우저엔 앱 자격을 두지 않는다 = 서버 프록시 재판정).
//
//  삼중 게이트: ① 매니페스트가 admin·runtime scope 하드거부(manifest.ts) → 앱은 그 권한을 못 가짐
//   ② requireScope(appUser, cap.scope) — appUser.scopes = 멤버 ∩ grant 로 축소 → 스코프 초과 차단
//   ③ requireAppTool(appUser, name) — 그 앱 grant 의 도구 allowlist 로 축소(토큰이 아니라 appId+grant 로 판정)
//  + 방어심화 denylist: 신원/자격/grant 자체를 바꾸는 scope-null 도구는 grant 에 있어도 브리지에서 거부(앱이 자기 권한을
//   스스로 넓히는 경로 차단). 결과는 호스트가 iframe 으로 되돌린다(PR5a app-ui.ts 브리지).
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { requireScope, type LivelyUser } from "../context.js";
import { viewerOf } from "./principal.js";
import { requireAppTool } from "../apps/principal.js";
import { needsRegrant } from "../apps/grant.js";
import { getActiveGrant } from "../org/store/apps.js";
import { getApp } from "../org/store/apps.js";
import { canSeeApp } from "../apps/visibility.js";
import { viewAppFor } from "../apps/app-view.js";
import { logToolCall } from "../org/policies/tool-log.js";
import { logger } from "../log.js";
import type { AppScreenSource } from "../apps/app-screen-sources.js";
import { CONSENT_REQUIRED } from "../apps/app-consent.js";

/** 세션 id 꼴(box-<slug>-<8hex> 등) — 형식만. 권한은 소비처(ai-runs 구독 tie)가 본다. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// 방어심화: grant 에 있어도 UI 브리지가 절대 호출하지 않는 도구(신원·자격·grant·앱관리 mutator). 관리자 도구는
//  이미 scope 게이트로 막히므로(앱은 admin/runtime 불가), 여기선 scope-null 이면서 보안상태를 바꾸는 것들을 겨냥한다.
const BRIDGE_DENY = /^(me_app_|me_credential|me_git_credential|me_oauth_|org_app_tool_call$)/;

const appToolCall: Capability = {
  name: "org_app_tool_call",
  title: "앱 UI 도구 호출(브리지)",
  description: "샌드박스 앱 UI 가 요청한 도구를 그 앱 principal 로 실행한다(호스트 중개). 호출자(멤버)가 이 앱에 grant 가 있어야 하고, 도구는 그 grant allowlist 안이어야 하며, appUser 스코프(멤버∩grant)로 판정된다. REST 전용.",
  scope: null,
  input: {
    app_id: z.string(), name: z.string(), arguments: z.record(z.unknown()).optional(),
    session_id: z.string().max(128).optional().describe("띄운 쪽(라이블리 화면)이 싣는 붙은 세션 id — 앱 arguments 의 것이 아니다. 구독 AI 실행의 «초대받은 사람» 판정(#4488)"),
  },
  expose: {
    mcp: false, // 브라우저 UI 브리지 전용 — 하네스 세션은 앱 토큰으로 직접 MCP 를 쓴다(이 우회 불필요).
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/tool-call"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { app_id: (req.params as Record<string, string>)?.id, name: b.name, arguments: b.arguments, session_id: b.session_id };
      } }],
  },
  handler: async (input: Record<string, unknown>, member: LivelyUser | undefined) => {
    if (!member?.userId) throw new HttpError(401, "인증이 필요합니다");
    const appId = String(input.app_id ?? "").trim();
    const name = String(input.name ?? "").trim();
    if (!appId || !name) throw new HttpError(400, "app_id 와 name 이 필요합니다");
    //  세션 id 는 띄운 쪽(라이블리 화면 opts.sessionId)이 본문에 싣는다 — 앱 arguments 의 것이 아니다. 형식을 보고, **그 사람이 들어갈 수 있는 세션일 때만**
    //  ctx.session 으로 넘긴다 — ctx.session 을 믿는 다른 도구(앱 변경 알림 · 지식 공개범위 · 위탁 출처)에 남의 세션 id 가 새지 않게(격리 리뷰 blocking 2). 아니면 세션 없이.
    let sid = typeof input.session_id === "string" && SESSION_ID_RE.test(input.session_id) ? input.session_id : undefined;
    if (sid) {
      const { requireSessionParticipant } = await import("../apps/session-apps.js");
      try { await requireSessionParticipant(sid, member.userId); }
      catch (e) { logger.warn({ session: sid, member: member.userId, err: (e as Error)?.message }, "[app-tool-call] 본문의 세션 id 를 버린다 — 들어갈 수 없는 세션"); sid = undefined; }
    }
    const result = await runAppTool(member, appId, name, input.arguments ?? {}, { source: "app-ui", sessionId: sid });
    return { app_id: appId, name, result };
  },
};

/** 동의가 없거나 예전 범위라 막혔다 — 화면(web/v2/app-ui.ts)은 글의 «동의» 로, 앱 주소의 /_lively/* 는 이 code 로 가른다(apps/app-consent.ts). */
export { CONSENT_REQUIRED };

/**
 * 앱 화면이 부른 도구 하나를 그 앱 주체(그 사람 ∩ 그 사람의 앱 동의)로 실행한다 — 라이블리 화면의 다리(org_app_tool_call)와
 *  앱 주소의 `/_lively/*`(apps/app-front-api.ts, #4482)가 **같은 판정**을 탄다. 결과는 그 도구의 결과 그대로.
 *  opts.address — 앱 주소로 들어온 호출이면 그 주소의 판(pub|draft): 선언(도구 · 표)을 사람이 아니라 주소의 판에서 읽는다(Viewer.address).
 */
export async function runAppTool(member: LivelyUser, appId: string, name: string, rawArgs: unknown,
  opts: { source: AppScreenSource; address?: "pub" | "draft"; sessionId?: string }): Promise<unknown> {
  if (!member?.userId) throw new HttpError(401, "인증이 필요합니다");
  if (BRIDGE_DENY.test(name)) throw new HttpError(403, `이 도구는 앱 UI 에서 호출할 수 없습니다: ${name}`);
  //  앱을 보는 사람(앱 공개범위 판정용) — 아래 핸들러 ctx 의 viewer(데이터 공개범위 · 문자열)와 다르다.
  const appViewer = { userId: member.userId, scopes: member.scopes ?? [], ...(opts.address ? { address: opts.address } : {}) };

  // 앱 존재·활성 확인. #4667 — 남이 만들고 있는(나만 보는) 앱은 없는 앱과 같다(404).
  const installed = await getApp(appId);
  if (!installed || !canSeeApp(installed, appViewer)) throw new HttpError(404, `앱 없음: ${appId}`);
  if (installed.status !== "active" || !installed.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다`);
  //  선언은 **이 사람이 보는 판**의 것 — 공개 판을 보는 사람의 화면이 남의 초안이 새로 선언한 도구를 쓰지 않게.
  //   앱 주소로 들어온 호출이면 그 주소의 판(#4482 — 공개 주소는 초안을 고친 사람에게도 공개 판).
  const seen = await viewAppFor(installed, appViewer);
  if (seen.view === "none") throw new HttpError(404, `앱 없음: ${appId}`);
  const app = seen.app;

  // 호출자(멤버)가 이 앱에 동의(grant)했나 — 없으면 이 UI 는 도구를 못 쓴다.
  const grant = await getActiveGrant(appId, member.userId);
  if (!grant) throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다`, { body: { code: CONSENT_REQUIRED } });

  // #4225 — 동의가 **옛 범위**다: 앱이 갱신돼 새로 선언한 도구인데 예전 동의엔 없다(빌트인 「안녕 앱」 0.2 가 store_* 를 얻은 경우).
  //  종전엔 아래 requireAppTool 의 «앱 권한 밖» 403 으로 끝나 화면이 막다른 길이었다. «동의» 로 말하면 호스트가 그 자리에서
  //  동의 창을 띄우고(web/v2/app-ui.ts — /동의|grant/) 새 범위로 다시 동의한 뒤 한 번 재시도한다. 선언 밖 도구는 종전 그대로 막힌다.
  const declared = (() => {
    const p = (app.manifest as { permissions?: { tools?: unknown; ext_tools?: unknown } } | null)?.permissions;
    return [...(Array.isArray(p?.tools) ? p.tools : []), ...(Array.isArray(p?.ext_tools) ? p.ext_tools : [])].map(String);
  })();
  if (needsRegrant(grant.tools, declared, name)) {
    throw new HttpError(403, `앱 '${appId}' 의 사용 동의가 예전 범위라 '${name}' 을 쓸 수 없습니다 — 다시 동의(grant)하면 됩니다`, { body: { code: CONSENT_REQUIRED } });
  }

  // 앱-principal 유저 — 스코프는 멤버 ∩ grant 로 축소, appId 를 실어 requireAppTool 이 grant 도구로 판정하게 한다.
  const appUser: LivelyUser = {
    ...member,
    appId,
    scopes: (member.scopes ?? []).filter((s) => grant.scopes.includes(s)),
    ...(opts.address ? { appAddress: opts.address } : {}),
  };

  // 대상 능력 조회(registry) — 동적 import 로 순환 회피(index → 이 파일 → index).
  const { registry } = await import("./index.js");
  const cap = registry.get(name);
  if (!cap) throw new HttpError(404, `도구 없음: ${name}`);
  if (cap.expose.mcp === false) throw new HttpError(403, `호출할 수 없는 도구입니다: ${name}`); // REST 전용 내부 능력은 브리지 대상 아님

  // 집행 — 앱 세션 MCP 경로와 동일: 스코프 → 앱 도구 allowlist.
  if (cap.scope) requireScope(appUser, cap.scope);
  await requireAppTool(appUser, name);

  // 입력 검증(MCP 표면과 동일 zod 셰이프). 실패 = 400.
  let args: unknown;
  try { args = z.object(cap.input as z.ZodRawShape).parse(rawArgs ?? {}); }
  catch (e) { throw new HttpError(400, `인자 검증 실패: ${(e as Error)?.message ?? e}`); }

  const started = Date.now();
  try {
    //  열람 신원(#1291)은 앱 세션 MCP 경로(capabilities/index.ts)와 같다 — 도구는 그 사람의 공개범위로 읽고 쓴다.
    //  session 은 다리가 확인한 사람 세션(#4488 구독 선) — 없으면 칸을 안 둔다.
    const result = await cap.handler(args as Record<string, unknown>, appUser, { source: opts.source, actor: member.userId, viewer: viewerOf(member), ...(opts.sessionId ? { session: opts.sessionId } : {}) });
    logToolCall({ tool: name, harness: opts.source, actor: member.userId, app: appId, args, ok: true, durationMs: Date.now() - started });
    return result;
  } catch (e) {
    logToolCall({ tool: name, harness: opts.source, actor: member.userId, app: appId, args, ok: false, error: (e as Error)?.message ?? String(e), durationMs: Date.now() - started });
    throw e;
  }
}

export const appToolCallCapabilities: Capability[] = [appToolCall];
