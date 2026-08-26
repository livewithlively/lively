// 구글 "팀 자료로 모으기"(#1881 G5 백엔드) — 드라이브·Gmail 수집기를 **토큰 복사 없이** 켠다.
//
//  슬랙(slack-connect.ts)과 같은 그림이다: 토글을 켠 **관리자 본인의 연결**을 수집기가 가리킨다
//  (`token_source=member:<id>`). 노션처럼 조직 슬롯을 따로 두지 않는 이유는 구글엔 봇/통합 개념이 없어
//  '조직의 토큰' 이라는 것이 존재하지 않기 때문이다 — 누군가의 계정으로 도는 수밖에 없고, 그러면 **누구 것인지가
//  화면에 보여야** 한다(그 사람이 나가면 수집이 멈추는 게 정상이고, 다른 관리자가 이어받는 경로가 있어야 한다).
//
//  ★ 서비스를 고르게 하는 것이 여기선 **비용 문제**다(지식 google-single-connect-design-1881 §9).
//   Gmail 은 제한범위라 CASA(연 $540~1,800) 또는 미검증 100명 한도를 끌고 오고, 드라이브·캘린더는 그렇지 않다.
//   그래서 "드라이브만 모으기"가 1급 선택지여야 한다 — 안 쓰는 Gmail 을 기본으로 끼우면 되돌릴 수 없는
//   100 한 칸을 태운다(그 카운트는 프로젝트 수명 누적이고 리셋 불가다).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { listCollectors, upsertCollector, type CollectorView } from "../org/store/collectors.js";
import { getMemberSecret, memberOwner } from "../org/credentials/member-secret-store.js";
import { GOOGLE_KIND, GOOGLE_LEGACY_KINDS, GOOGLE_DEFAULT_SERVICES, googleConsentTier, consumesUnverifiedUserCap, googleOfferedServices, isGoogleServiceOffered, googleScopeCovers, GOOGLE_SERVICE_SCOPES, type GoogleService } from "../org/credentials/google-oauth.js";
import { startGoogleConsent, completeGoogleInstall, googleReady } from "../org/credentials/oauth-broker.js";

/** 수집기 인스턴스 — 서비스마다 하나(캘린더는 수집 대상이 아니다: 일정은 자료가 아니라 도구 면에서 읽는다). */
export const GOOGLE_COLLECTORS = [
  { service: "drive" as const, preset: "gdrive", instance: "lively-gdrive", label: "Google Drive — 팀 문서" },
  { service: "gmail" as const, preset: "gmail", instance: "lively-gmail", label: "Gmail — 팀 메일" },
];
export type GoogleCollectService = (typeof GOOGLE_COLLECTORS)[number]["service"];

/**
 * ★ **수집기가 없는 '도구 전용' 서비스.** 일정은 자료가 아니다 — 모아 두면 낡고, 필요한 건 "지금 무슨 일정이
 *  있나"라서 그때 읽는 게 맞다. 그래서 캘린더는 수집기를 만들지 않고 **동의 범위만** 넓힌다.
 *
 *  ⚠ 이걸 축으로 세우지 않았던 게 결함이었다(2026-08-27 상민님 "캘린더 안떠"). 카드가 수집기 목록으로만
 *   그려져서 캘린더는 **칸이 아예 없었고**, [권한 넓히기]가 보내는 services 에도 안 실렸다 —
 *   즉 화면 어디를 눌러도 캘린더 권한을 받을 길이 없었다. 도구는 등록돼 있는데(google_calendar_*)
 *   그 도구를 켤 방법이 없는 상태 = ②·③ 과 같은 '막다른 길' 계열.
 */
export const GOOGLE_TOOL_ONLY_SERVICES = ["calendar"] as const;
export type GoogleToolOnlyService = (typeof GOOGLE_TOOL_ONLY_SERVICES)[number];

export function isGoogleToolOnlyService(s: string): s is GoogleToolOnlyService {
  return (GOOGLE_TOOL_ONLY_SERVICES as readonly string[]).includes(s);
}

/** 동의로 요청할 서비스 = 고른 수집 서비스 + 고른 도구 전용 서비스. 수집기 생성 대상과 **다르다**. */
export function splitGoogleServices(picked: readonly string[]): {
  collect: GoogleCollectService[]; toolOnly: GoogleToolOnlyService[];
} {
  const collect: GoogleCollectService[] = [];
  const toolOnly: GoogleToolOnlyService[] = [];
  for (const p of picked) {
    if (isGoogleToolOnlyService(p)) { if (!toolOnly.includes(p)) toolOnly.push(p); }
    else if (GOOGLE_COLLECTORS.some((c) => c.service === p)) {
      const c = p as GoogleCollectService;
      if (!collect.includes(c)) collect.push(c);
    }
  }
  return { collect, toolOnly };
}

function findInstance(all: CollectorView[], preset: string, instance: string): CollectorView | undefined {
  return all.find((c) => c.preset_key === preset && c.instance_key === instance);
}

/**
 * 이 사람이 구글에 연결돼 있는가 + 무엇에 동의했는가.
 *  통합 슬롯을 먼저 보고 없으면 구 kind 를 본다(도구 면 별칭과 같은 방향 — 예전에 붙은 관리자도 그대로 쓴다).
 *  ⚠ refresh_token 이 없으면 **연결로 치지 않는다**: 1시간 뒤 죽을 자격으로 수집기를 켜면 run 은 '성공'인데
 *   자료가 0건인 상태가 된다(이 코드베이스의 단골 고장).
 */
export async function memberGoogleConnection(memberId: string): Promise<{ kind: string; scope: string } | null> {
  for (const kind of [GOOGLE_KIND, ...GOOGLE_LEGACY_KINDS]) {
    const r = await getMemberSecret(memberOwner(memberId), kind, "").catch(() => null);
    if (!r?.secret) continue;
    try {
      const t = JSON.parse(r.secret) as { refresh_token?: unknown; scope?: unknown };
      if (typeof t.refresh_token !== "string" || !t.refresh_token) continue;
      return { kind, scope: typeof t.scope === "string" ? t.scope : "" };
    } catch { continue; }
  }
  return null;
}

/**
 * 동의된 scope 문자열에 그 서비스가 들어 있는가 — "켰는데 왜 안 모이지"를 화면이 미리 답하게 한다.
 *  ⚠ Gmail 은 `/auth/gmail.*` 만이 아니다 — 전체 접근 scope 는 `https://mail.google.com/` 라 그 접두가 없다.
 *   이걸 빼면 **가장 넓게 동의한 사람이 '동의 안 함'으로 판정돼** 수집기를 못 켠다(거짓 음성).
 *  판정은 넉넉한 쪽이 아니라 **정확한 쪽**이다: 없는 권한을 있다고 하면 run 은 ok 인데 자료가 0건이 된다.
 */
// 판정 본체는 google-oauth.ts 한 곳(googleScopeCovers) — 두 벌로 두면 한쪽만 고쳐져 어긋난다.
export function scopeCovers(scope: string, service: GoogleCollectService): boolean {
  return googleScopeCovers(scope, service);
}


/**
 * 토글 저장 때 서비스 하나를 **어떻게 할지** 정하는 순수 규칙. 핸들러 안에 묻어 두면 테스트가 못 닿는데,
 *  여기서 한 칸 틀리면 대가가 비대칭적으로 크다 — 한쪽은 불가역 한도 소모, 다른 쪽은 돌던 수집의 조용한 정지.
 *
 *  · not_offered — 1차 런칭 대상이 아님. **켜지도 끄지도 않는다.** 끄면 이미 잘 돌던 조직이 이 배포 하나로 멈춘다.
 *  · no_scope    — 동의하지 않은 범위. 켜면 run 은 ok 인데 자료가 0건인 '조용한 성공'이 된다.
 */
export type GoogleCollectAction =
  | { action: "enable" }
  | { action: "disable" }
  | { action: "none"; reason?: "not_offered" | "not_wanted" | "no_scope"; message?: string };

export function googleCollectAction(p: {
  service: GoogleCollectService; wanted: boolean; enabled: boolean; scopeOk: boolean;
}): GoogleCollectAction {
  if (!isGoogleServiceOffered(p.service)) {
    if (!p.wanted && !p.enabled) return { action: "none" };
    return {
      action: "none", reason: "not_offered",
      message: p.enabled
        ? "1차 런칭 대상이 아닙니다 — 이미 켜져 있어 그대로 둡니다(끄려면 수집기 화면에서 끄세요)"
        : "1차 런칭 대상이 아닙니다 — 제한범위라 구글 심사(CASA)와 되돌릴 수 없는 100명 한도가 붙습니다",
    };
  }
  if (!p.wanted) return p.enabled ? { action: "disable" } : { action: "none", reason: "not_wanted" };
  if (!p.scopeOk) {
    return {
      action: "none", reason: "no_scope",
      message: "이 서비스에 아직 동의하지 않았습니다 — [Google 연결]을 다시 눌러 범위를 넓히세요",
    };
  }
  return { action: "enable" };
}

export interface GoogleCollectState {
  /** 서비스별 수집기 상태. */
  collectors: Array<{ service: GoogleCollectService; enabled: boolean; collector_id: number | null; token_source: string | null; scope_ok: boolean; offered: boolean }>;
  /** 수집기가 없는 도구 전용 서비스(캘린더) — 동의 여부만 있다. */
  tools: Array<{ service: GoogleToolOnlyService; scope_ok: boolean; offered: boolean }>;
  /** 이 관리자의 구글 연결(없으면 null) — 수집은 이 연결로 돈다. */
  connected: { kind: string; scope: string } | null;
  /** 동의를 시작할 수 있는가 — OAuth 클라이언트(직결) 또는 CP 릴레이가 있어야 한다. */
  ready: boolean;
  /** ★ 지금 켜져 있는 조합이 미검증 100명 한도를 태우는가(화면이 정직하게 경고하는 근거). */
  consumes_user_cap: boolean;
  scope_tier: string;
}

export async function googleCollectState(memberId: string): Promise<GoogleCollectState> {
  const all = await listCollectors();
  const conn = await memberGoogleConnection(memberId);
  const collectors = GOOGLE_COLLECTORS.map((c) => {
    const inst = findInstance(all, c.preset, c.instance);
    return {
      service: c.service,
      enabled: !!inst?.enabled,
      collector_id: inst?.id ?? null,
      token_source: (inst?.config?.token_source as string | undefined) ?? null,
      scope_ok: conn ? scopeCovers(conn.scope, c.service) : false,
      // 1차 런칭에서 파는 서비스인가. false 인데 enabled 면 "예전에 켜 둔 것" — 화면은 보여만 주고 새로 못 켜게 한다.
      offered: isGoogleServiceOffered(c.service),
    };
  });
  // 도구 전용 서비스 — 수집기가 없으니 enabled 라는 개념이 없다. 있는 것은 "동의를 받았나" 뿐이다.
  const tools = GOOGLE_TOOL_ONLY_SERVICES.map((service) => ({
    service,
    scope_ok: conn ? googleScopeCovers(conn.scope, service) : false,
    offered: isGoogleServiceOffered(service),
  }));
  const on = collectors.filter((c) => c.enabled).map((c) => (c.service === "gmail" ? "gmail" : "drive") as GoogleService);
  return {
    collectors, tools, connected: conn,
    ready: await googleReady().catch(() => false),
    consumes_user_cap: on.length > 0 ? consumesUnverifiedUserCap(on) : false,
    scope_tier: on.length > 0 ? googleConsentTier(on) : "non_sensitive",
  };
}

// enum 에서 gmail 을 지우지 않는다 — 이미 켜 둔 조직의 저장 요청이 zod 400 으로 튕기면 드라이브까지 못 고친다.
//  거부는 스키마가 아니라 googleCollectAction 이 **사유와 함께** 한다(skipped).
const SERVICES = z.array(z.enum(["drive", "gmail", "calendar"])).describe("모을 서비스. 비우면 드라이브만. ★Gmail 은 1차 런칭 대상이 아니라 넣어도 켜지지 않는다. calendar 는 수집기가 없어 동의 범위만 넓힌다(도구 전용).");

const orgGoogleCollect: Capability = {
  name: "org_google_collect", title: "구글 팀 자료 수집 상태",
  description:
    "\"팀 자료로 모으기\" 상태 — 드라이브·Gmail 수집기의 켜짐 여부, 이 관리자의 구글 연결과 동의 범위, 동의 시작 가능 여부, " +
    "그리고 지금 조합이 구글 미검증 100명 한도를 태우는지(consumes_user_cap). 토글은 org_google_collect_set.",
  scope: "admin", input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/google/collect"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    return googleCollectState(user.userId);
  },
};

const orgGoogleCollectSet: Capability = {
  name: "org_google_collect_set", title: "구글 팀 자료 수집 켜기/끄기",
  description:
    "\"팀 자료로 모으기\" 토글(admin). enabled=true 인데 내 구글 연결이 없으면 needs_connect=true 와 authorization_url 을 " +
    "돌려준다 — 그 화면에서 [허용]하면 연결이 저장되고, 다시 이 토글을 부르면 수집기가 만들어진다(token_source=member:<나>, " +
    "토큰 복사 0). services 로 모을 서비스를 고른다. ★**Gmail 은 1차 런칭 대상이 아니다**(2026-08-26 결정) — 제한범위라 " +
    "CASA·불가역 100명 한도를 태운다. 넣어 불러도 켜지지 않고, 이미 켜져 있던 것은 건드리지 않고 skipped 로 알린다. " +
    "false 면 끈다(삭제 아님 — 커서·자료 보존).",
  scope: "admin",
  input: { enabled: z.boolean().describe("true=켜기 · false=끄기"), services: SERVICES.optional() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/google/collect"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user, ctx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as { enabled?: unknown; services?: unknown };
    const enabled = i.enabled === true;
    const actor = user.userId;
    const source = ctx?.source ?? "web";
    const all = await listCollectors();

    if (!enabled) {
      const changed: string[] = [];
      for (const c of GOOGLE_COLLECTORS) {
        const inst = findInstance(all, c.preset, c.instance);
        if (inst?.enabled) { await upsertCollector({ id: inst.id, enabled: false }, actor, source); changed.push(c.instance); }
      }
      return { ok: true, enabled: false, changed, state: await googleCollectState(actor) };
    }

    // 기본은 드라이브만 — Gmail 은 제한범위(CASA·100명 한도)라 **명시적으로 골라야** 켜진다(§9).
    // ★ 고른 것을 둘로 가른다: 수집기를 만들 것(collect) vs 동의 범위만 넓힐 것(toolOnly=캘린더).
    //  캘린더를 수집기 축에 섞으면 없는 프리셋으로 upsert 를 시도하게 된다.
    const rawPicked = Array.isArray(i.services) && i.services.length > 0 ? (i.services as string[]) : ["drive"];
    const split = splitGoogleServices(rawPicked);
    const want = new Set<GoogleCollectService>(split.collect);

    const conn = await memberGoogleConnection(actor);
    if (!conn) {
      // 아직 연결 전 — 여기서 동의를 시작한다(토글이 곧 연결). 고른 서비스만 요청한다(최소 권한).
      // 파는 것만 요청한다 — googleScopeString 이 한 번 더 막지만, 동의 화면에 뜨는 목록까지 정확해야
      //  사람이 자기가 무엇을 허용하는지 안다.
      const services: GoogleService[] = googleOfferedServices(
        [...[...want].map((s) => (s === "gmail" ? "gmail" : "drive") as GoogleService), ...split.toolOnly],
      );
      const c = await startGoogleConsent(actor, services.length > 0 ? services : GOOGLE_DEFAULT_SERVICES, actor);
      return { ok: false, needs_connect: true, authorization_url: c.authorizationUrl, state: await googleCollectState(actor) };
    }

    const changed: string[] = [];
    const skipped: Array<{ service: string; reason: string }> = [];
    for (const c of GOOGLE_COLLECTORS) {
      const inst = findInstance(all, c.preset, c.instance);
      const plan = googleCollectAction({
        service: c.service, wanted: want.has(c.service),
        enabled: !!inst?.enabled, scopeOk: scopeCovers(conn.scope, c.service),
      });
      if (plan.action === "none") {
        if (plan.message) skipped.push({ service: c.service, reason: plan.message });
        continue;
      }
      if (plan.action === "disable") {
        if (inst?.id) { await upsertCollector({ id: inst.id, enabled: false }, actor, source); changed.push(`-${c.instance}`); }
        continue;
      }
      // 항상 **호출자**의 연결로 갈아끼운다(전임자가 나가서 멈춘 수집기를 다른 관리자가 이어받는 경로).
      await upsertCollector({
        id: inst?.id, preset_key: c.preset, instance_key: c.instance,
        label: inst?.label ?? c.label, enabled: true,
        config: { ...(inst?.config ?? {}), token_source: `member:${actor}` },
        note: inst?.note ?? "[팀 자료로 모으기] 토글로 만들어진 수집기 — 켠 사람의 Google 연결로 돕니다(#1881). Client ID/Secret/Refresh Token 칸은 비워 두세요.",
      }, actor, source);
      changed.push(c.instance);
    }
    return { ok: true, enabled: changed.length > 0, changed, skipped, state: await googleCollectState(actor) };
  },
};

const orgGoogleCollectConnect: Capability = {
  name: "org_google_collect_connect", title: "구글 연결(범위 선택) 시작",
  description:
    "구글 동의를 시작한다(admin) — 반환된 authorization_url 을 열어 [허용]하면 내 금고에 저장된다. 이미 연결된 뒤에 " +
    "services 를 넓혀 부르면 **증분 인가**라 기존 동의를 잃지 않고 범위만 넓어진다.",
  scope: "admin", input: { services: SERVICES.optional() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/google/collect/connect"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const raw = (input as { services?: unknown })?.services;
    // 도구 전용(캘린더)도 그대로 실어 보낸다 — 여기서 떨구면 [권한 넓히기] 를 눌러도 캘린더가 안 열린다
    //  (2026-08-27 "캘린더 안떠" 의 원인이 정확히 이 자리였다).
    const asked: GoogleService[] = Array.isArray(raw) && raw.length > 0
      ? (raw as string[]).filter((s): s is GoogleService => s in GOOGLE_SERVICE_SCOPES)
      : GOOGLE_DEFAULT_SERVICES;
    // 안 파는 범위가 동의 화면에 뜨면 사람이 허용해 버리고, 그 순간 한도가 탄다(불가역).
    const services: GoogleService[] = googleOfferedServices(asked);
    const dropped = asked.filter((s) => !services.includes(s));
    if (services.length === 0) {
      throw new HttpError(400, `지금 연결할 수 있는 서비스가 없습니다 — ${dropped.join("·")} 는 1차 런칭 대상이 아닙니다`);
    }
    const c = await startGoogleConsent(user.userId, services, user.userId);
    return {
      ok: true, authorization_url: c.authorizationUrl, services, dropped,
      consumes_user_cap: consumesUnverifiedUserCap(services), scope_tier: googleConsentTier(services),
      message: "이 URL 의 구글 화면에서 [허용]하세요 — 완료되면 자동으로 저장됩니다.",
    };
  },
};

// 매니지드 릴레이 완료(#1881 G4) — CP 가 admin 토큰으로 부른다. state 검증·저장은 브로커. 응답에 토큰 없음.
const orgGoogleOauthComplete: Capability = {
  name: "org_google_oauth_complete", title: "구글 OAuth 릴레이 완료(CP 전용)",
  description: "라이블리 컨트롤플레인이 구글과 교환한 토큰 응답을 이 게이트웨이의 서명 state 와 함께 넣는다. 연결자의 금고 슬롯(google_oauth)에 저장한다. 사람이 직접 부를 일은 없다.",
  scope: "admin",
  input: { state: z.string().describe("이 게이트웨이가 발급한 서명 state"), token: z.record(z.unknown()).describe("구글 토큰 엔드포인트 응답 JSON 원문") },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/org/google/oauth-complete"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    const i = (input ?? {}) as { state?: unknown; token?: unknown };
    if (typeof i.state !== "string" || !i.state) throw new HttpError(400, "state 는 필수입니다");
    if (!i.token || typeof i.token !== "object") throw new HttpError(400, "token(구글 응답)은 필수입니다");
    try {
      const r = await completeGoogleInstall(i.state, i.token, user?.userId ?? "cp-relay");
      return { ok: true, member: r.memberId, google_email: r.email };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
};

export const googleConnectCapabilities: Capability[] = [orgGoogleCollect, orgGoogleCollectSet, orgGoogleCollectConnect, orgGoogleOauthComplete];
