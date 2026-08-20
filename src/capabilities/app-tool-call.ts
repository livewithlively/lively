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
import { requireAppTool } from "../apps/principal.js";
import { getActiveGrant } from "../org/store/apps.js";
import { getApp } from "../org/store/apps.js";
import { logToolCall } from "../org/policies/tool-log.js";

// 방어심화: grant 에 있어도 UI 브리지가 절대 호출하지 않는 도구(신원·자격·grant·앱관리 mutator). 관리자 도구는
//  이미 scope 게이트로 막히므로(앱은 admin/runtime 불가), 여기선 scope-null 이면서 보안상태를 바꾸는 것들을 겨냥한다.
const BRIDGE_DENY = /^(me_app_|me_credential|me_git_credential|me_oauth_|org_app_tool_call$)/;

const appToolCall: Capability = {
  name: "org_app_tool_call",
  title: "앱 UI 도구 호출(브리지)",
  description: "샌드박스 앱 UI 가 요청한 도구를 그 앱 principal 로 실행한다(호스트 중개). 호출자(멤버)가 이 앱에 grant 가 있어야 하고, 도구는 그 grant allowlist 안이어야 하며, appUser 스코프(멤버∩grant)로 판정된다. REST 전용.",
  scope: null,
  input: { app_id: z.string(), name: z.string(), arguments: z.record(z.unknown()).optional() },
  expose: {
    mcp: false, // 브라우저 UI 브리지 전용 — 하네스 세션은 앱 토큰으로 직접 MCP 를 쓴다(이 우회 불필요).
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/tool-call"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { app_id: (req.params as Record<string, string>)?.id, name: b.name, arguments: b.arguments };
      } }],
  },
  handler: async (input: Record<string, unknown>, member: LivelyUser | undefined, ctx) => {
    if (!member?.userId) throw new HttpError(401, "인증이 필요합니다");
    const appId = String(input.app_id ?? "").trim();
    const name = String(input.name ?? "").trim();
    if (!appId || !name) throw new HttpError(400, "app_id 와 name 이 필요합니다");
    if (BRIDGE_DENY.test(name)) throw new HttpError(403, `이 도구는 앱 UI 에서 호출할 수 없습니다: ${name}`);

    // 앱 존재·활성 확인.
    const app = await getApp(appId);
    if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
    if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다`);

    // 호출자(멤버)가 이 앱에 동의(grant)했나 — 없으면 이 UI 는 도구를 못 쓴다.
    const grant = await getActiveGrant(appId, member.userId);
    if (!grant) throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다`);

    // 앱-principal 유저 — 스코프는 멤버 ∩ grant 로 축소, appId 를 실어 requireAppTool 이 grant 도구로 판정하게 한다.
    const appUser: LivelyUser = {
      ...member,
      appId,
      scopes: (member.scopes ?? []).filter((s) => grant.scopes.includes(s)),
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
    try { args = z.object(cap.input as z.ZodRawShape).parse(input.arguments ?? {}); }
    catch (e) { throw new HttpError(400, `인자 검증 실패: ${(e as Error)?.message ?? e}`); }

    const started = Date.now();
    try {
      const result = await cap.handler(args as Record<string, unknown>, appUser, { source: "app-ui", actor: member.userId });
      logToolCall({ tool: name, harness: "app-ui", actor: member.userId, app: appId, args, ok: true, durationMs: Date.now() - started });
      return { app_id: appId, name, result };
    } catch (e) {
      logToolCall({ tool: name, harness: "app-ui", actor: member.userId, app: appId, args, ok: false, error: (e as Error)?.message ?? String(e), durationMs: Date.now() - started });
      throw e;
    }
  },
};

export const appToolCallCapabilities: Capability[] = [appToolCall];
