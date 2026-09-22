// http_proxy 도구 프리셋 적용(#1655) — 묶음 하나를 org_tool 로 심고 url_allowlist 에 호스트를 더한다.
//  관리 창구(org_http_tool_preset_apply)와 **연결 직후 자동 적용**(#4211 Outlook — onMicrosoftInstalled)이 같은 함수를 부른다.
//  두 벌이면 한쪽만 allowlist 를 빠뜨려 «도구는 있는데 전부 차단»(구글 hosts_missing 실측)이 난다.
import { getRuntimeConfig, updateRuntimeConfig, listTools, upsertTool } from "../store.js";
import type { WriteCtx } from "../store/audit.js";
import { HTTP_TOOL_PRESETS, httpToolPresetToInput, type HttpToolPresetGroup } from "./http-tool-presets.js";

export function findHttpToolPresetGroup(key: string): HttpToolPresetGroup | undefined {
  return HTTP_TOOL_PRESETS.find((g) => g.key === key);
}

/** 이 묶음이 이미 **완성**돼 있나 — 도구가 전부 심겼고 호스트가 allowlist 에 다 있다(CP planPresetsToApply ⓐ 와 같은 판정). */
export function presetGroupComplete(group: HttpToolPresetGroup, haveTools: ReadonlySet<string>, allowlist: readonly string[]): boolean {
  const allow = new Set(allowlist.map((h) => h.toLowerCase()));
  return group.tools.every((t) => haveTools.has(t.name)) && group.hosts.every((h) => allow.has(h.toLowerCase()));
}

/**
 * 묶음 적용 — 같은 이름의 도구는 덮어쓴다(멱등). allowlist 는 **병합**만 한다(다른 커넥터가 쓰는 항목을 건드리지 않는다).
 *  allowlist 는 deny-all 기본이라 이걸 빠뜨리면 심어도 전부 차단된다.
 */
export async function applyHttpToolPresetGroup(group: HttpToolPresetGroup, ctx: WriteCtx): Promise<{ applied: string[]; added_hosts: string[] }> {
  const applied: string[] = [];
  for (const t of group.tools) {
    await upsertTool(httpToolPresetToInput(group, t), ctx); // 프리셋 자기검증이 여기서 먼저 돈다
    applied.push(t.name);
  }
  const cfg = await getRuntimeConfig();
  const want = group.hosts.map((h) => h.toLowerCase());
  const addedHosts = want.filter((h) => !cfg.url_allowlist.includes(h));
  if (addedHosts.length) {
    await updateRuntimeConfig({ url_allowlist: [...cfg.url_allowlist, ...addedHosts] }, ctx.actor, ctx.source ?? "web",
      { tokenHashPrefix: ctx.tokenHashPrefix ?? null, ip: ctx.ip ?? null });
  }
  return { applied, added_hosts: addedHosts };
}

/**
 * 완성돼 있지 않을 때만 적용 — 자동 경로(연결 직후)용. 관리자가 일부 도구를 **꺼 둔** 경우는 건드리지 않는다:
 *  listTools 는 꺼진 도구도 돌려주므로 «이름이 있다» 로 완성을 판정하고, 이미 있는 도구의 enabled 를 되살리지 않는다.
 */
export async function ensureHttpToolPresetGroup(key: string, ctx: WriteCtx): Promise<{ applied: string[]; added_hosts: string[]; skipped: boolean }> {
  const group = findHttpToolPresetGroup(key);
  if (!group) throw new Error(`그런 프리셋 묶음이 없습니다: ${key}`);
  const [tools, cfg] = await Promise.all([listTools(), getRuntimeConfig()]);
  const have = new Set(tools.map((t) => t.name));
  if (presetGroupComplete(group, have, cfg.url_allowlist)) return { applied: [], added_hosts: [], skipped: true };
  //  빠진 도구만 심는다 — 있는 도구를 다시 upsert 하면 관리자가 꺼 둔 것이 enabled:true 로 되살아난다.
  const missing: HttpToolPresetGroup = { ...group, tools: group.tools.filter((t) => !have.has(t.name)) };
  const r = await applyHttpToolPresetGroup(missing, ctx);
  return { ...r, skipped: false };
}
