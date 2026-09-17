// 알림 스트림이 **어느 워크스페이스의 누구 사건을 받나** (#4054) — notify-bus.ts 의 NotifyRoute 목록을 만든다.
//
// ── 무엇이 문제였나 (상민님 2026-09-17) ─────────────────────────────────────────────
//  "데스크톱 앱 알림이 내가 보고 있지 않은 워크스페이스 작업완료도 오는데, 누르면 워크스페이스가 전환되지 않고
//   보고 있는 워크스페이스에서 세션을 열려다 안 열린다. 그리고 모든 알림에 어느 워크스페이스의 것인지 적어야 한다."
//  뿌리는 버스의 주소가 구성원 아이디 하나였던 것이다(notify-bus.ts 머리말 ①②). 사건이 워크스페이스를 모르니
//  앱은 이름을 적을 수도, 옮겨 갈 수도 없었다.
//
// ── 규칙 ───────────────────────────────────────────────────────────────────────────
//  · 자기 워크스페이스는 언제나 받는다 — 같은 테넌트 안의 같은 구성원 아이디 = 같은 사람.
//  · 다른 워크스페이스는 **클라이언트가 청할 때만**(`?all=1`) 받는다. 데스크톱 앱은 청하고, 웹 셸(사이드바
//    다시 읽기, #2041)은 청하지 않는다 — 제 화면과 무관한 사건으로 목록을 다시 읽을 까닭이 없다.
//  · 매니지드: 다른 워크스페이스 목록과 «같은 사람» 판정을 **계정 서버(CP)가 준다.** 구성원 아이디는
//    워크스페이스마다 따로 만든 값이라 사람을 가리키지 못한다 — 계정 id 로 맞춘다(발행 쪽은 그 워크스페이스의
//    구성원 신원에서 계정 id 를 읽는다 → notifyAccountOf).
//    ⚠ 계정 id 는 코어가 자기 구성원 신원(`lvly_account`)에서 뽑아 CP 에 보내고, CP 는 «그 계정이 이 테넌트의
//     멤버인가»만 확인한다(lvly-cloud tenant-gate.ts ③). 그 신원을 워크스페이스 관리자가 고칠 수 있다는 것은
//     이 모듈 밖의 기존 약점이다(managed-cp.ts·me-account-delete.ts 가 같은 재료를 쓴다) — 고치는 자리는 그쪽이다.
//  · 셀프호스트 다중(registry): 신원이 박스 전역이라(db/tenant-column.ts IDENTITY_GLOBAL_TABLES) 구성원 아이디가
//    곧 사람이다 — 그 사람이 속한 등록부 워크스페이스를 같은 아이디로 받는다.
//  · 단일 테넌트: 자기 워크스페이스뿐이다.
//  · 모르면 넓히지 않는다 — CP 가 안 잡히거나 계정이 확인되지 않으면 자기 워크스페이스만 받는다(fail-closed).
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";
import { currentTenant } from "../org/tenant-context.js";
import type { NotifyRoute, NotifyWorkspace } from "./notify-bus.js";

export const PRIMARY_WS = "primary";

/** 워크스페이스 slug 형식 — CP·등록부가 쓰는 것과 같은 모양만 받는다(주소·열쇠로 쓰이는 값이다). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** 계정 서버 입장 주소의 경로 — `/ws/<uuid>/enter` 뿐이다(lvly-cloud ui.ts). */
const ENTER_PATH_RE = /^\/ws\/[0-9a-fA-F-]{36}\/enter$/;
/** 사람에게 보일 이름의 상한 — 배너 윗줄 한 줄이다. */
const NAME_MAX = 80;

const cleanName = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);

/**
 * 계정 서버가 준 입장 주소를 **다시 본다**(순수). 그 문자열은 사람의 브라우저가 열 주소가 되므로,
 *  계정 서버 출처(`cpBase`)와 `/ws/<uuid>/enter` 경로가 맞을 때만 쓴다. 쿼리·조각·계정 정보가 붙어 있으면 버린다.
 * @returns 정리된 주소 또는 null
 */
export function cleanEnterUrl(raw: unknown, cpBase: string | null | undefined): string | null {
  let base: URL, u: URL;
  try { base = new URL(String(cpBase ?? "")); u = new URL(String(raw ?? "")); } catch { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && base.protocol === "http:")) return null;
  if (u.origin !== base.origin) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!ENTER_PATH_RE.test(u.pathname)) return null;
  return `${u.origin}${u.pathname}`;
}

/**
 * 이 게이트웨이 주소가 «`<자기 slug>.<테넌트 도메인>`» 꼴이면 그 도메인을 돌려준다(순수) — 다른 워크스페이스의
 *  웹 화면 주소(`<slug>.<테넌트 도메인>`)를 만드는 재료다. 매니지드 테넌트 주소의 규칙이 그렇다(lvly-cloud router.hostToSlug).
 *  꼴이 아니면(경로 접두·포트·다른 이름) null — 그때는 주소를 짓지 않고 입장 주소만 준다.
 */
export function tenantBaseOf(gatewayUrl: unknown, slug: string): { scheme: "https" | "http"; parent: string } | null {
  let u: URL;
  try { u = new URL(String(gatewayUrl ?? "")); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.port || u.username || u.password || (u.pathname !== "/" && u.pathname !== "")) return null;
  const host = u.hostname.toLowerCase();
  const head = `${String(slug || "").trim().toLowerCase()}.`;
  if (!SLUG_RE.test(head.slice(0, -1)) || !host.startsWith(head)) return null;
  const parent = host.slice(head.length);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(parent)) return null;   // 점이 하나 이상인 도메인만(최상위 한 칸으로는 짓지 않는다)
  return { scheme: u.protocol === "https:" ? "https" : "http", parent };
}

export interface CpWorkspaceRow {
  slug?: string;
  name?: string;
  enter_url?: string;
  is_current?: boolean;
}

export interface RegistryWorkspaceRow {
  slug?: string;
  name?: string;
}

export interface RoutePlanInput {
  mode: "managed" | "registry" | "single";
  /** 이 워크스페이스 안의 내 구성원 아이디. */
  me: string;
  /** 이 스트림의 워크스페이스. */
  here: { slug: string; name: string };
  /** 클라이언트가 다른 워크스페이스까지 청했나(`?all=1`). */
  all: boolean;
  /** 매니지드 — CP 가 이 테넌트의 멤버로 확인한 계정 id. 없으면 다른 워크스페이스를 받지 않는다. */
  account?: string | null;
  /** 매니지드 — CP 가 준 내 워크스페이스 목록. */
  cpWorkspaces?: readonly CpWorkspaceRow[] | null;
  /** 매니지드 — 계정 서버 출처(입장 주소 검증 기준). */
  cpBase?: string | null;
  /** 매니지드 — 테넌트 주소 규칙(tenantBaseOf). 있으면 다른 워크스페이스의 웹 화면 주소를 싣는다. */
  tenantBase?: { scheme: "https" | "http"; parent: string } | null;
  /** registry — 내가 속한 등록부 워크스페이스(primary 포함 가능). */
  registryWorkspaces?: readonly RegistryWorkspaceRow[] | null;
}

/**
 * 받는 자리 목록(순수) — 표로 못박는다(notify-scope.test.ts).
 *
 * | 모드 | all | 자기 워크스페이스 | 다른 워크스페이스 |
 * |---|---|---|---|
 * | 전부 | 아님 | 구성원 아이디로 | 없음 |
 * | single | 청함 | 구성원 아이디로 | 없음(워크스페이스가 하나다) |
 * | managed | 청함 | 구성원 아이디로 | **CP 확인 계정 id** 로 · via=enter · 입장 주소 검증 통과한 것만 · 테넌트 주소 규칙을 알면 웹 화면 주소도 |
 * | managed | 청함 · 계정 미확인 | 구성원 아이디로 | 없음(fail-closed) |
 * | registry | 청함 | 구성원 아이디로 | 구성원 아이디로(박스 전역 신원) · via=header |
 */
export function planNotifyRoutes(i: RoutePlanInput): NotifyRoute[] {
  const me = String(i.me ?? "").trim();
  const hereSlug = String(i.here?.slug ?? "").trim().toLowerCase();
  if (!me || !hereSlug) return [];
  const own: NotifyRoute = {
    ws: hereSlug,
    member: me,
    label: { slug: hereSlug, name: cleanName(i.here?.name), current: true, via: i.mode === "registry" ? "header" : "same" },
  };
  const out: NotifyRoute[] = [own];
  if (!i.all) return out;
  const seen = new Set([hereSlug]);

  if (i.mode === "managed") {
    const account = String(i.account ?? "").trim();
    if (!account) return out;
    for (const w of i.cpWorkspaces ?? []) {
      const slug = String(w?.slug ?? "").trim().toLowerCase();
      if (!SLUG_RE.test(slug) || seen.has(slug) || w?.is_current) continue;
      const enter = cleanEnterUrl(w?.enter_url, i.cpBase);
      if (!enter) continue;                                   // 갈 길이 없는 자리는 만들지 않는다(눌러도 못 가는 배너)
      seen.add(slug);
      const label: NotifyWorkspace = { slug, name: cleanName(w?.name), current: false, via: "enter", enter };
      if (i.tenantBase) label.url = `${i.tenantBase.scheme}://${slug}.${i.tenantBase.parent}/ui/`;
      out.push({ ws: slug, account, label });
    }
    return out;
  }

  if (i.mode === "registry") {
    for (const w of i.registryWorkspaces ?? []) {
      const slug = String(w?.slug ?? "").trim().toLowerCase();
      if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
      seen.add(slug);
      out.push({ ws: slug, member: me, label: { slug, name: cleanName(w?.name), current: false, via: "header" } });
    }
    return out;
  }

  return out;
}

/** 이 요청의 워크스페이스 slug — 컨텍스트가 없으면(단일 테넌트·registry 의 primary) primary. */
export function hereSlug(): string {
  return String(currentTenant()?.slug || PRIMARY_WS).trim().toLowerCase() || PRIMARY_WS;
}

async function orgProfile(): Promise<{ name: string; gatewayUrl: string | null }> {
  try {
    const { getOrgProfile } = await import("../org/store/profile.js");
    const p = await getOrgProfile();
    return { name: cleanName(p?.display_name || p?.name || ""), gatewayUrl: p?.gateway_url ?? null };
  } catch { return { name: "", gatewayUrl: null }; }
}
async function orgName(): Promise<string> { return (await orgProfile()).name; }

async function registryName(slug: string): Promise<string> {
  try {
    const { getWorkspaceBySlug } = await import("../org/tenancy/registry.js");
    return cleanName((await getWorkspaceBySlug(slug))?.name || "");
  } catch { return ""; }
}

async function tenancyMode(): Promise<"managed" | "registry" | "single"> {
  const { managedMode, registryModeActive } = await import("../org/tenancy/state.js");
  if (managedMode()) return "managed";
  if (registryModeActive()) return "registry";
  return "single";
}

/**
 * 이 요청 워크스페이스의 표시(자기 워크스페이스) — 알림 피드 응답에 실어 데스크톱 앱이 폴링·사람 알림 배너에 쓴다.
 *  CP 를 부르지 않는다(30초마다 불리는 자리다). 이름은 조직 프로필 → (registry) 등록부 순.
 */
export async function hereWorkspaceLabel(): Promise<NotifyWorkspace> {
  const slug = hereSlug();
  const mode = await tenancyMode().catch(() => "single" as const);
  let name = "";
  if (mode === "registry") name = await registryName(slug);
  if (!name) name = await orgName();
  return { slug, name, current: true, via: mode === "registry" ? "header" : "same" };
}

/** 첫 등록용 — 이름을 모르는 채로 자기 워크스페이스만(스트림이 열리는 순간 사건을 놓치지 않게 먼저 건다). */
export function ownRouteNow(me: string): NotifyRoute[] {
  return planNotifyRoutes({ mode: "single", me, here: { slug: hereSlug(), name: "" }, all: false });
}

/**
 * 받는 자리를 실제로 정한다(외부 조회 포함). 실패는 **좁히는 쪽**으로 떨어진다:
 *  CP 를 못 부르면 자기 워크스페이스만 — 단, 호출자(스트림)가 이미 넓은 목록을 들고 있으면 그것을 유지하도록
 *  `{ transient: true }` 를 함께 준다(네트워크 한 번 흔들린 것으로 알림을 끊지 않는다).
 */
export async function resolveNotifyRoutes(user: LivelyUser, me: string, all: boolean): Promise<{ routes: NotifyRoute[]; transient: boolean }> {
  const slug = hereSlug();
  const mode = await tenancyMode();
  if (mode === "registry") {
    const name = (await registryName(slug)) || (await orgName());
    if (!all) return { routes: planNotifyRoutes({ mode, me, here: { slug, name }, all }), transient: false };
    let rows: RegistryWorkspaceRow[] = [];
    let transient = false;
    try {
      const reg = await import("../org/tenancy/registry.js");
      const mine = await reg.listWorkspacesForMember(me);
      const primary = await reg.getWorkspaceBySlug(reg.PRIMARY_SLUG).catch(() => null);
      // primary 는 명부 없이도 모두의 것이다(workspace-registry.ts 목록과 같은 규칙).
      rows = [...(primary ? [{ slug: primary.slug, name: primary.name }] : []), ...mine.map((w) => ({ slug: w.slug, name: w.name }))];
    } catch (err) {
      transient = true;
      logger.warn({ err }, "알림 스트림: 등록부 워크스페이스 조회 실패 — 이 워크스페이스만 받는다");
    }
    return { routes: planNotifyRoutes({ mode, me, here: { slug, name }, all, registryWorkspaces: rows }), transient };
  }

  const profile = await orgProfile();
  const name = profile.name;
  if (mode === "single" || !all) return { routes: planNotifyRoutes({ mode, me, here: { slug, name }, all }), transient: false };

  // 매니지드 — 다른 워크스페이스는 CP 가 확인해 준 것만.
  const { resolveCpTarget, callCp } = await import("../capabilities/delivery/managed-cp.js");
  let target: Awaited<ReturnType<typeof resolveCpTarget>> = null;
  try { target = await resolveCpTarget(user, { optional: true }); }
  catch (err) { logger.warn({ err }, "알림 스트림: 계정 서버 대상 확인 실패 — 이 워크스페이스만 받는다"); }
  if (!target) return { routes: planNotifyRoutes({ mode, me, here: { slug, name }, all: false }), transient: false };
  try {
    const r = await callCp<{ workspaces?: CpWorkspaceRow[] }>(target, "/api/tenant/workspaces", {}, { timeoutMs: 5_000 });
    const rows = Array.isArray(r?.workspaces) ? r.workspaces : [];
    const cur = rows.find((w) => w && w.is_current);
    return {
      routes: planNotifyRoutes({
        mode, me, all,
        here: { slug, name: cleanName(cur?.name) || name },
        account: target.accountId, cpWorkspaces: rows, cpBase: target.base,
        tenantBase: tenantBaseOf(profile.gatewayUrl, slug),
      }),
      transient: false,
    };
  } catch (err) {
    // 400·403(구성원 아님·계정 불일치)은 확답이다 — 넓히지 않는다. 502(못 닿음)는 일시적이다.
    const status = (err as { status?: number })?.status;
    const transient = !(status === 400 || status === 403 || status === 404);
    logger.warn({ err, status }, "알림 스트림: 계정 서버 워크스페이스 목록 실패 — 이 워크스페이스만 받는다");
    return { routes: planNotifyRoutes({ mode, me, here: { slug, name }, all: false }), transient };
  }
}

// ── 발행 쪽: 세션 주인의 계정 id ────────────────────────────────────────────────────
//  매니지드에서 다른 워크스페이스로 사건을 보내려면 «이 워크스페이스의 이 구성원이 어느 계정인가»를 알아야 한다.
//  훅 보고는 핫패스라 **계정 조건으로 받는 스트림이 있을 때만** 찾고(notify-bus accountRoutesActive), 찾은 값은
//  잠깐 기억한다. 신원은 거의 안 바뀌고, 바뀌어도 이 기억이 끝나면 따라간다.
const ACCOUNT_TTL_MS = 5 * 60_000;
const ACCOUNT_CACHE_MAX = 5_000;
const accountCache = new Map<string, { account: string | null; at: number }>();

/** 이 워크스페이스(현재 컨텍스트)의 구성원 → 계정 id. 매니지드가 아니거나 모르면 null. */
export async function notifyAccountOf(member: string, now: number = Date.now()): Promise<string | null> {
  const m = String(member ?? "").trim();
  if (!m) return null;
  if ((await tenancyMode()) !== "managed") return null;
  const t = currentTenant();
  const key = `${t?.id ?? ""}\u0000${m}`;
  const hit = accountCache.get(key);
  if (hit && now - hit.at < ACCOUNT_TTL_MS) return hit.account;
  let account: string | null = null;
  try {
    const { getMember } = await import("../org/store.js");
    const row = await getMember(m);
    account = String((row?.identities ?? []).find((idn) => idn.system === "lvly_account")?.external_id ?? "").trim() || null;
  } catch (err) {
    logger.warn({ err, member: m }, "알림 발행: 구성원 계정 조회 실패 — 다른 워크스페이스로는 보내지 않는다");
    return null;                                              // 실패는 기억하지 않는다(다음 사건에서 다시 본다)
  }
  if (accountCache.size >= ACCOUNT_CACHE_MAX) accountCache.delete(accountCache.keys().next().value!);
  accountCache.set(key, { account, at: now });
  return account;
}

/** 시험용 — 계정 기억을 비운다. */
export function resetNotifyAccountCache(): void { accountCache.clear(); }
