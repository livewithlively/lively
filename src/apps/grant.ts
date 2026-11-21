// 앱 권한 해소 — 순수(#1780, design D3). 매니페스트 permissions(=상한)와 멤버 grant 요청을 결합해
//  실제 부여 scope/tool 을 정한다. 글롭 매칭은 appToolAllowed(PR2 런타임 필터)에서도 재사용한다.
//
// 불변식(design D3): grant 는 매니페스트 선언의 **부분집합**만 가능(사람이 좁힐 수는 있어도 넓힐 수는 없다).
//  admin·runtime scope 는 매니페스트 파서가 이미 거부하므로 여기 도달하지 않는다.
import { HttpError } from "../http-error.js";
import { parseAppManifest, type LivelyAppManifest } from "./manifest.js";

/**
 * 글롭 매칭 — 앱 매니페스트의 tool allowlist 는 `ext__slack__*` 같은 글롭을 허용한다.
 *  `*` 는 임의 문자열(빈 문자열 포함)에 매치. 그 외 문자는 리터럴. 대소문자 무시(도구 이름은 소문자 규약이나 방어적).
 */
export function toolMatchesGlob(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (!p.includes("*")) return p === n;
  // 글롭 → 정규식(리터럴 이스케이프 후 * → .*).
  const rx = new RegExp("^" + p.split("*").map(escapeRe).join(".*") + "$");
  return rx.test(n);
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** name 이 allowlist(리터럴 또는 글롭들) 중 하나에 매치되나. */
export function toolAllowed(allowlist: readonly string[], name: string): boolean {
  return allowlist.some((p) => toolMatchesGlob(p, name));
}

/**
 * 동의가 **옛 범위**라서 막힌 것인가(#4225) — 앱이 선언한 도구인데 지금 동의엔 없다. 참이면 «다시 동의» 로 풀린다
 *  (앱이 갱신돼 새 도구를 얻은 경우). 선언 밖 도구는 거짓 — 다시 동의해도 못 얻으므로 종전 «권한 밖» 이 맞다.
 */
export function needsRegrant(grantTools: readonly string[], declaredTools: readonly string[], name: string): boolean {
  return !toolAllowed(grantTools, name) && toolAllowed(declaredTools, name);
}

/**
 * needsRegrant 의 scope 판(#1644) — 앱이 선언한 scope 인데 지금 동의엔 없고, 그 사람(구성원)은 그 scope 를 가졌다. 참이면 «다시 동의» 로 풀린다.
 *  구성원에게 없는 scope 는 거짓 — 다시 동의해도 앱이 그 사람 이름으로 못 얻는다(앱의 권한 = 구성원 ∩ 동의). 선언 밖 scope 도 거짓(종전 «권한 밖»).
 */
export function scopeNeedsRegrant(grantScopes: readonly string[], declaredScopes: readonly string[], scope: string, memberScopes: readonly string[]): boolean {
  return !grantScopes.includes(scope) && declaredScopes.includes(scope) && memberScopes.includes(scope);
}

/**
 * 앱 선언에서 «동의가 덮어야 할 것»(#1644) — 동의 창이 주는 것(요청 없는 resolveGrant = 선언 전체)과 같은 모양 · 같은 정규화
 *  (함의 도구까지 — ai_runs → AI 실행 도구 다섯 · notifications → app_notify · web.server → 작업 도구 넷 …). 동의 창은 늘 이것 전체로 동의한다
 *  (web/v2/app-session ensureAppGrant 가 빈 본문으로 POST /apps/:id/grant).
 *  저장된 매니페스트를 이 코어가 못 읽으면 null — 다시 동의(me_app_grant)도 같은 파서로 막히니 «다시 동의» 로 보내지 않는다(끝없이 도는 안내를 막는다).
 */
export function grantableOf(manifest: unknown): ResolvedGrant | null {
  let m: LivelyAppManifest;
  try { m = parseAppManifest(manifest); } catch { return null; }
  return resolveGrant(m);
}

/** 동의가 앱의 지금 선언을 덮지 못한 것(#1644) — 다시 동의하면 얻는 scope · 도구. */
export interface GrantGap { scopes: string[]; tools: string[] }

/**
 * 동의가 앱의 지금 선언(grantableOf)을 다 덮나 — 덮지 못한 scope · 도구(둘 다 비면 덮는다 · grantGapEmpty).
 *  · 도구: 선언한 이름(글롭 포함)마다 동의 목록이 그 이름을 덮나(toolAllowed — 같은 글롭 · 더 넓은 글롭도 덮는다).
 *  · scope: memberScopes 를 주면 그 사람이 가진 것만 센다(scopeNeedsRegrant 와 같은 까닭 — 구성원에게 없는 scope 는 다시 동의해도 못 얻는다).
 *    그 사람이 나중에 그 권한을 받으면 그때 «다시 동의» 가 된다.
 *  동의 창은 선언 전체로 동의하므로, 이게 비지 않는 것은 «앱이 동의한 뒤에 넓어졌다» 이거나 «사람이 API 로 일부만 동의했다» 둘 중 하나다.
 */
export function grantGap(grant: { scopes: readonly string[]; tools: readonly string[] }, declared: ResolvedGrant, memberScopes?: readonly string[]): GrantGap {
  const held = memberScopes ? new Set(memberScopes) : null;
  return {
    scopes: declared.scopes.filter((s) => !grant.scopes.includes(s) && (!held || held.has(s))),
    tools: declared.tools.filter((t) => !toolAllowed(grant.tools, t)),
  };
}

export function grantGapEmpty(g: GrantGap): boolean {
  return g.scopes.length === 0 && g.tools.length === 0;
}

/** 두 선언 모두에 있는 것만(a 의 이름 순서) — 도구는 b 가 그 이름을 덮나(toolAllowed)로 본다. «다시 동의로 얻을 수 있는 것» 으로 좁힐 때 쓴다. */
export function intersectGrantable(a: ResolvedGrant, b: ResolvedGrant): ResolvedGrant {
  return { scopes: a.scopes.filter((s) => b.scopes.includes(s)), tools: a.tools.filter((t) => toolAllowed(b.tools, t)) };
}

/** 덮지 못한 것을 한 줄로 — «scope db · 도구 db_query, app_ai_run 외 2개». 비면 빈 글. 앱 도구 오류 · 거절 글에 싣는다(사람 · AI 가 읽는다). */
export function describeGrantGap(g: GrantGap, max = 5): string {
  const list = (xs: readonly string[]): string => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} 외 ${xs.length - max}개`);
  return [g.scopes.length ? `scope ${list(g.scopes)}` : "", g.tools.length ? `도구 ${list(g.tools)}` : ""].filter(Boolean).join(" · ");
}

/**
 * «다시 동의» 거절 글 — 앱 화면 다리(#4225 runAppTool) · 앱 서버 · 앱 토큰이 같은 글을 쓴다(#1644 — 앱 서버가 그 까닭을 사람에게 그대로 전할 수 있게).
 *  what 은 조사까지 — regrantToolPhrase('store_query') = `'store_query' 을` · regrantScopePhrase('db') = `'db' 권한을`.
 *  웹 호스트(web/v2/app-ui.ts)는 이 글의 «동의» 를 보고 그 자리에서 동의 창을 띄운다 — 낱말을 바꾸면 그 이동이 끊긴다.
 */
export function regrantMessage(appId: string, what: string): string {
  return `앱 '${appId}' 의 사용 동의가 예전 범위라 ${what} 쓸 수 없습니다 — 다시 동의(grant)하면 됩니다`;
}
export const regrantToolPhrase = (name: string): string => `'${name}' 을`;
export const regrantScopePhrase = (scope: string): string => `'${scope}' 권한을`;

export interface ResolvedGrant { scopes: string[]; tools: string[] }

/**
 * 멤버 grant 를 해소한다.
 *  - requested 미지정(undefined) → 매니페스트 전체(상한)를 그대로 부여.
 *  - requested 지정 → **부분집합 검증**: 요청 scope 는 permissions.scopes 안이어야, 요청 tool 은
 *    permissions.tools ∪ ext_tools 의 어느 글롭에 매치돼야. 위반은 HttpError(400).
 *  tools 는 리터럴 이름으로 부여한다(요청이 글롭이면 매니페스트 글롭 부분집합인지 글롭 포함관계로 판정 —
 *   v1 은 단순화: 요청 tool 은 리터럴만 허용하고, 매니페스트 글롭에 매치되면 통과).
 */
export function resolveGrant(
  m: LivelyAppManifest,
  requested?: { scopes?: string[]; tools?: string[] },
): ResolvedGrant {
  const maniScopes = m.permissions.scopes;
  const maniTools = [...m.permissions.tools, ...m.permissions.ext_tools];

  if (!requested) return { scopes: [...maniScopes], tools: [...maniTools] };

  const scopes = requested.scopes ?? maniScopes;
  for (const s of scopes) {
    if (!maniScopes.includes(s)) throw new HttpError(400, `grant 오류: scope '${s}' 는 앱 선언(${maniScopes.join(",") || "없음"}) 밖입니다`);
  }
  const tools = requested.tools ?? maniTools;
  for (const t of tools) {
    if (t.includes("*")) {
      // 요청이 글롭이면 매니페스트에 **정확히 그 글롭**이 있어야 넓힘을 막는다(v1 보수).
      if (!maniTools.includes(t)) throw new HttpError(400, `grant 오류: 글롭 tool '${t}' 는 앱 선언에 없습니다`);
    } else if (!toolAllowed(maniTools, t)) {
      throw new HttpError(400, `grant 오류: tool '${t}' 는 앱 선언 밖입니다`);
    }
  }
  return { scopes: [...scopes], tools: [...tools] };
}
