// 앱이 «무엇을 할 수 있나» — 앱 상세(#/connect/<key>)가 읽기·쓰기를 동사로 보여 주는 창구(#2243 3차).
//
// 왜 필요했나: 종전 상세는 «AI가 내 계정으로 직접 들어가 일해요» 한 문장뿐이라 **쓰기 권한이 가 있다는 느낌이
//  전혀 없었다**(원준 2026-08-30). 실제로는 GitHub 이슈를 만들고 Slack 메시지를 보낸다 — 받는 사람은 내가
//  한 것으로 본다. 그 사실을 화면이 말하려면 «이 앱의 도구가 무엇이고 어느 것이 쓰기인가»를 알아야 하는데,
//  그 창구가 org_tools(admin 전용 관리 표)뿐이라 일반 화면이 물어볼 곳이 없었다.
//
// level 은 org_tool 에 이미 박혀 있다 — L0 조회 / L1 제안 / L2 집행(#746). 이름 규칙이 아니라 명시 플래그다.
import { z } from "zod";
import { listTools, upsertTool } from "../org/store/tools.js";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";

/** 도구 이름 앞머리로 앱을 가른다 — http_proxy 프리셋이 `<app>_` 로 짓는 규약(http-tool-presets.ts). */
const PREFIX: Record<string, string[]> = {
  github: ["github_"], gitlab: ["gitlab_"], slack: ["slack_"], figma: ["figma_"],
  notion: ["notion_"], google: ["google_"], linear: ["ext__linear__", "linear_"],
  clickup: ["clickup_"], prometheus: ["prom_", "prometheus_"],
};

export interface AppTool { name: string; title: string; write: boolean; enabled: boolean }

/** 그 앱의 도구를 읽기/쓰기로 가른다 — 순수(테스트가 표를 돈다). */
export function splitAppTools(all: Array<{ name: string; title?: string | null; level?: string | null; enabled?: boolean }>, system: string): AppTool[] {
  const pfx = PREFIX[String(system ?? "").toLowerCase()] ?? [];
  if (!pfx.length) return [];
  return all
    .filter((t) => pfx.some((p) => t.name.startsWith(p)))
    .map((t) => ({
      name: t.name,
      title: String(t.title || t.name),
      write: String(t.level ?? "") === "L2",
      enabled: t.enabled !== false,
    }))
    .sort((a, b) => (a.write === b.write ? a.name.localeCompare(b.name) : a.write ? 1 : -1));
}

export const orgAppTools: Capability = {
  name: "org_app_tools", title: "이 앱으로 AI가 할 수 있는 일",
  description:
    "그 앱의 MCP 도구를 읽기/쓰기로 갈라 돌려준다 — 앱 상세가 «AI가 내 계정으로 하는 일»을 동사로 보여 주는 데 쓴다. " +
    "쓰기(write=true)는 org_tool.level='L2'(집행) — 그 앱에 **내 이름으로 기록이 남는** 도구다. " +
    "읽기 전용이고 권한을 넓히지 않는다. 도구가 없는 앱(ClickUp 등)은 빈 목록으로 답한다(에러가 아니다).",
  scope: "admin",
  input: { system: z.string().min(1).max(40).describe("앱 키(github · slack · gitlab · figma · linear …)") },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/:system/tools"], parse: (req) => ({ system: String((req.params as Record<string, string>)?.system ?? "") }) }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const system = String((input as { system?: unknown })?.system ?? "").toLowerCase();
    const all = await listTools().catch(() => []);
    const tools = splitAppTools(all, system);
    return {
      system,
      tools,
      reads: tools.filter((t) => !t.write && t.enabled).length,
      writes: tools.filter((t) => t.write && t.enabled).length,
      /** 쓰기는 켜져 있어도 무확인 실행 목록에서 강제 제외된다(#746) — 하네스가 실행 전에 사람에게 묻는다. */
      write_confirmed: true,
    };
  },
};

/**
 * 그 앱의 «쓰기»(L2) 도구를 통째로 끄고 켠다 — 앱 상세의 쓰기 스위치.
 *
 * ⚠ 이건 **워크스페이스 전체** 설정이다(org_tool.enabled). 멤버별 도구 on/off 표는 아직 없다
 *  (org_asset_pref 의 CHECK 가 도구를 명시적으로 배제한다 — mcp-tools.ts). 화면이 그 사실을 말한다.
 *  셀프서브(1인 워크스페이스)에서는 결과가 같고, 팀에서는 «나만»이 아니라는 걸 숨기면 거짓말이 된다.
 */
export const orgAppToolsSetWrite: Capability = {
  name: "org_app_tools_set_write", title: "이 앱의 쓰기 도구 끄기/켜기",
  description:
    "그 앱의 쓰기 도구(level=L2 — 이슈 만들기·메시지 보내기처럼 그 앱에 기록이 남는 것)를 한꺼번에 끈다/켠다(admin). " +
    "워크스페이스 전체에 적용된다(멤버별 도구 설정은 아직 없다). 읽기 도구(L0/L1)는 건드리지 않는다.",
  scope: "admin",
  input: {
    system: z.string().min(1).max(40).describe("앱 키(github · slack …)"),
    enabled: z.boolean().describe("true=쓰기 켜기 · false=쓰기 끄기"),
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/:system/tools/write"], parse: (req) => ({ ...(req.body ?? {}), system: String((req.params as Record<string, string>)?.system ?? "") }) }] },
  handler: async (input, user, ctx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as { system?: unknown; enabled?: unknown };
    const system = String(i.system ?? "").toLowerCase();
    const enabled = i.enabled === true;
    const all = await listTools().catch(() => []);
    const writes = splitAppTools(all, system).filter((t) => t.write);
    if (!writes.length) throw new HttpError(404, `'${system}' 에는 쓰기 도구가 없습니다`);
    const changed: string[] = [];
    for (const t of writes) {
      if (t.enabled === enabled) continue;
      await upsertTool({ name: t.name, enabled }, { actor: user.userId, source: ctx?.source ?? "web" });
      changed.push(t.name);
    }
    return { ok: true, enabled, changed, tools: splitAppTools(await listTools().catch(() => []), system) };
  },
};
