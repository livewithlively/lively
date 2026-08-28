// «멤버 토큰 수집기 토글» 팩토리(#2247) — 슬랙(slack-connect.ts)·구글(google-connect.ts)이 각자 들고 있던 같은 80줄을 하나로.
//
//  한 앱의 «모아 두기»가 하는 일은 늘 같다: 수집기 인스턴스 1행을 upsert 하고 config.token_source 로 **켠 사람의 금고**를
//  가리킨다. 토큰은 복사되지 않는다. 앱마다 다른 것은 프리셋·자격 kind·범위 필드뿐이라 그 셋을 표로 받고 나머지는 여기서 한다.
//  불변식(슬랙·노션·구글에서 굳은 규약):
//   ① 켤 때는 **항상 호출자**의 연결로 갈아끼운다 — 전임자가 나가서 멈춘 수집기를 다른 관리자가 이어받는 경로.
//   ② 끄기 = enabled:false. 삭제가 아니다 — 커서·자료가 남고 다시 켜면 이어받는다.
//   ③ 자격이 없으면 켜지 않고 needs_connect 로 말한다(400 이 아니라 200 — 화면이 «먼저 토큰을 저장하세요» 로 안내한다).
//   ④ 범위가 필요한 앱(피그마: 파일 링크/팀 id)은 범위 없이는 켜지 않고 needs_scope 로 말한다 — 안 그러면 크론이 붙어
//      매 주기 «수집할 파일이 없습니다» 실패 로그만 쌓인다(노션 needs_connect 와 같은 모양의 «아직 못 켬» 응답).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { listCollectors, upsertCollector, type CollectorView } from "../org/store/collectors.js";
import { getMemberSecret, listMemberSecretsPublic, memberOwner } from "../org/credentials/member-secret-store.js";
import { resetConnectorConfigCache } from "../connectors/config.js";

export interface MemberCollectSpec {
  /** REST 경로·capability 이름의 축 — org_<system>_collect(_set) · /api/ui/org/<system>/collect. */
  system: string;
  /** org_collector.preset_key. */
  preset: string;
  /** org_collector.instance_key — 커서 네임스페이스. 토글이 만드는 인스턴스 하나. */
  instance: string;
  /** 켠 사람의 금고에서 찾을 자격 kind(예 figma_token). scope_key 는 ''(단일 대상 kind). */
  credKind: string;
  /** true 면 scope_key 를 가리지 않고 그 kind 슬롯이 하나라도 있으면 연결로 본다(github_pat: 호스트 키 PAT 또는 '' 키 OAuth 묶음). */
  credAnyScope?: boolean;
  /** 범위가 비어 있을 때 채울 기본값(예 [GitHub 연결]에서 고른 저장소). 이것도 비면 needs_scope. */
  defaultScope?: () => Promise<Record<string, string>>;
  /** 켤 때 함께 저장할 설정(예 GitLab host = 그 사람 토큰의 호스트). 입력 scope 가 우선한다. */
  extraConfig?: (actor: string) => Promise<Record<string, string>>;
  /** 앱 이름(응답 문장). */
  appLabel: string;
  /** 수집기 label 기본값. */
  label: string;
  /** 수집기 note(관리탭에서 «왜 생겼나»를 읽게). */
  note: string;
  /** 사람이 자격을 저장하는 화면 — needs_connect 문장. */
  connectHint: string;
  /** 범위를 담는 config 키들(프리셋 필드에 있어야 저장된다). 이 중 하나라도 비어 있지 않아야 켠다(requireScope). */
  scopeKeys?: string[];
  /** true 면 범위 없이는 켜지 않는다(needs_scope). */
  requireScope?: boolean;
  /** needs_scope 문장. */
  scopeHint?: string;
  /** 켜진 뒤 한 번 더 할 일(예 피그마 증류기 준비). best-effort — 실패가 토글을 되돌리면 안 된다. */
  onEnabled?: (ctx: { actor: string; source: string }) => Promise<void>;
  /** 토글 설명에 붙는 한 줄(무엇이 어디로 가는지). */
  outcome: string;
}

export interface MemberCollectState {
  enabled: boolean;
  collector_id: number | null;
  /** 켜져 있으면 누구의 연결로 도는지. */
  member: string | null;
  /** 그 사람의 자격이 아직 금고에 있는지(null = 켜져 있지 않음). */
  member_connected: boolean | null;
  /** 호출자 본인이 자격을 저장해 뒀는가 — 켜기 버튼의 활성 조건. */
  me_connected: boolean;
  /** 지금 저장된 범위(scopeKeys 의 값). */
  scope: Record<string, string>;
  /** 범위가 필요한데 비어 있다(켜기 전·후 모두 의미 있음). */
  needs_scope: boolean;
}

/** 범위가 찼는가 — 순수. scopeKeys 가 없거나 requireScope 가 아니면 늘 참. */
export function scopeSatisfied(spec: Pick<MemberCollectSpec, "scopeKeys" | "requireScope">, config: Record<string, unknown>): boolean {
  if (!spec.requireScope || !spec.scopeKeys?.length) return true;
  return spec.scopeKeys.some((k) => String(config[k] ?? "").trim().length > 0);
}

/** 토글 한 번이 할 행동 — 순수(테스트가 표를 돈다). */
export type MemberCollectAction = "disable" | "needs_connect" | "needs_scope" | "enable";
export function memberCollectPlan(i: { enabled: boolean; meConnected: boolean; scopeOk: boolean }): MemberCollectAction {
  if (!i.enabled) return "disable";
  if (!i.meConnected) return "needs_connect";
  if (!i.scopeOk) return "needs_scope";
  return "enable";
}

function tokenSourceMember(c: CollectorView | undefined): string | null {
  const ts = c?.config?.token_source ?? "";
  return ts.startsWith("member:") ? ts.slice("member:".length) : null;
}
function pickScope(spec: MemberCollectSpec, config: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of spec.scopeKeys ?? []) { const v = config?.[k]; if (typeof v === "string" && v) out[k] = v; }
  return out;
}
/** 입력 scope 를 문자열 맵으로 — 배열은 공백 구분으로 합친다(피그마 file_keys 는 공백·줄바꿈 구분 규약). */
export function normalizeScopeInput(spec: Pick<MemberCollectSpec, "scopeKeys">, raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of spec.scopeKeys ?? []) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join(" ") : String(v).trim();
  }
  return out;
}

export function makeMemberTokenCollect(spec: MemberCollectSpec): Capability[] {
  const find = (all: CollectorView[]): CollectorView | undefined =>
    all.find((c) => c.preset_key === spec.preset && c.instance_key === spec.instance);
  const connected = async (memberId: string): Promise<boolean> => {
    if (spec.credAnyScope) {
      const rows = await listMemberSecretsPublic(memberOwner(memberId)).catch(() => []);
      return rows.some((r) => r.kind === spec.credKind && r.has_secret);
    }
    const r = await getMemberSecret(memberOwner(memberId), spec.credKind, "").catch(() => null);
    return !!r?.secret;
  };
  const stateOf = async (callerId: string): Promise<MemberCollectState> => {
    const inst = find(await listCollectors());
    const member = tokenSourceMember(inst);
    const scope = pickScope(spec, inst?.config);
    return {
      enabled: !!inst?.enabled, collector_id: inst?.id ?? null, member,
      member_connected: inst?.enabled && member ? await connected(member) : null,
      me_connected: await connected(callerId),
      scope, needs_scope: !scopeSatisfied(spec, inst?.config ?? {}),
    };
  };

  const get: Capability = {
    name: `org_${spec.system}_collect`, title: `${spec.appLabel} 팀 자료 수집 상태`,
    description: `"팀 자료로 모으기" 상태 — ${spec.appLabel} 수집기(켠 사람의 연결로 돈다)의 켜짐 여부·누구의 연결인지·내 자격 유무·범위. 토글은 org_${spec.system}_collect_set.`,
    scope: "admin", input: {},
    expose: { mcp: true, rest: [{ method: "GET", paths: [`/api/ui/org/${spec.system}/collect`], parse: () => ({}) }] },
    handler: async (_input, user) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      return stateOf(user.userId);
    },
  };

  const scopeDesc = spec.scopeKeys?.length ? ` scope 로 범위를 넣는다(${spec.scopeKeys.join("·")}).` : "";
  const set: Capability = {
    name: `org_${spec.system}_collect_set`, title: `${spec.appLabel} 팀 자료 수집 켜기/끄기`,
    description:
      `"팀 자료로 모으기" 토글(admin). enabled=true 면 호출자의 ${spec.appLabel} 자격(금고 ${spec.credKind})으로 수집기를 만들거나 켠다` +
      `(token_source=member:<나>, 토큰 복사 0). ${spec.outcome}${scopeDesc} 자격이 없으면 needs_connect, ` +
      (spec.requireScope ? "범위가 비어 있으면 needs_scope 로 답하고 켜지 않는다. " : "") +
      "false 면 끈다(삭제 아님 — 커서·자료 보존).",
    scope: "admin",
    input: {
      enabled: z.boolean().describe("true=켜기(내 자격으로) · false=끄기"),
      scope: z.record(z.union([z.string(), z.array(z.string())])).optional().describe(
        spec.scopeKeys?.length ? `범위(${spec.scopeKeys.join(" | ")}) — 켜면서 함께 저장. 켜진 뒤 범위만 바꿀 때도 enabled:true 와 함께` : "이 앱은 범위 입력이 없다"),
    },
    expose: { mcp: true, rest: [{ method: "POST", paths: [`/api/ui/org/${spec.system}/collect`], parse: (req) => req.body ?? {} }] },
    handler: async (input, user, ctx) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      const i = (input ?? {}) as { enabled?: unknown; scope?: unknown };
      const actor = user.userId;
      const source = ctx?.source ?? "web";
      const inst = find(await listCollectors());
      let scopeIn = normalizeScopeInput(spec, i.scope);
      let merged: Record<string, unknown> = { ...(inst?.config ?? {}), ...scopeIn };
      // 범위가 비면 앱이 아는 기본값(예 [GitHub 연결]에서 고른 저장소)으로 채운다 — 그 선택이 곧 범위라 사람이 두 번 고르지 않는다.
      if (i.enabled === true && spec.defaultScope && !scopeSatisfied(spec, merged)) {
        const dflt = normalizeScopeInput(spec, await spec.defaultScope().catch(() => ({})));
        if (scopeSatisfied(spec, dflt)) { scopeIn = { ...dflt, ...scopeIn }; merged = { ...merged, ...scopeIn }; }
      }
      const plan = memberCollectPlan({
        enabled: i.enabled === true, meConnected: await connected(actor), scopeOk: scopeSatisfied(spec, merged),
      });

      if (plan === "disable") {
        if (inst?.enabled) { await upsertCollector({ id: inst.id, enabled: false }, actor, source); resetConnectorConfigCache(); }
        return { ok: true, enabled: false, state: await stateOf(actor) };
      }
      if (plan === "needs_connect") {
        return { ok: false, needs_connect: true, message: `먼저 ${spec.connectHint} — 팀 자료 수집은 그 자격으로 돕니다.`, state: await stateOf(actor) };
      }
      if (plan === "needs_scope") {
        // 범위 입력이 왔지만 아직 부족하면(비어 있는 값) 저장할 것도 없다 — 켜지 않고 무엇이 필요한지만 말한다.
        return { ok: false, needs_scope: true, message: spec.scopeHint ?? "모을 범위를 먼저 넣어 주세요.", state: await stateOf(actor) };
      }
      // enable — 항상 호출자의 자격으로. 범위 입력은 프리셋 필드에 있는 키만 저장된다(upsertCollector 계약).
      const extra = spec.extraConfig ? await spec.extraConfig(actor).catch(() => ({})) : {};
      await upsertCollector({
        id: inst?.id, preset_key: spec.preset, instance_key: spec.instance,
        label: inst?.label ?? spec.label, enabled: true,
        config: { ...extra, ...scopeIn, token_source: `member:${actor}` },
        note: inst?.note ?? spec.note,
      }, actor, source);
      resetConnectorConfigCache();
      if (spec.onEnabled) {
        try { await spec.onEnabled({ actor, source }); }
        catch (e) { console.warn(`${spec.system} collect onEnabled 실패(무시): ${(e as Error).message}`); }
      }
      return { ok: true, enabled: true, state: await stateOf(actor) };
    },
  };
  return [get, set];
}
