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
export function grantableOf(manifest: unknown): DeclaredGrant | null {
  let m: LivelyAppManifest;
  try { m = parseAppManifest(manifest); } catch { return null; }
  const optional = m.permissions.optional_scopes ?? [];
  return { ...resolveGrant(m), ...(optional.length ? { optional_scopes: [...optional] } : {}) };
}

/**
 * 동의 판정이 견줄 앱 선언(grantableOf) — 동의 창이 주는 것(필수 scope · 도구 전부) + 선택 scope(앱 v2 #124 permissions.optional_scopes).
 *  선택 scope 는 동의 창이 주지 않고 필요한 사람만 따로 받으므로, 받지 않아도 빈칸이 아니다(grantGap).
 */
export interface DeclaredGrant extends ResolvedGrant { optional_scopes?: string[] }

/** 동의가 앱의 지금 선언을 덮지 못한 것(#1644) — 다시 동의하면 얻는 scope · 도구. */
export interface GrantGap { scopes: string[]; tools: string[] }

//  도구 이름 → 그 도구(라이블리 능력)가 요구하는 scope(앱 v2 #124). 능력 등록부(capabilities/index.ts)가 부팅 때 넣는다 — 이 모듈은 순수 잎이라
//   등록부를 import 하지 않는다(순환). 넣기 전 · 등록부에 없는 이름(앱 선언 도구 · 외부 도구 · 글롭)은 null(종전대로 센다).
let toolScopeOf: (name: string) => string | null = () => null;
export function setToolScopeResolver(fn: (name: string) => string | null): void { toolScopeOf = fn; }

/**
 * 동의가 앱의 지금 선언(grantableOf)을 다 덮나 — 덮지 못한 scope · 도구(둘 다 비면 덮는다 · grantGapEmpty).
 *  · 도구: 선언한 이름(글롭 포함)마다 동의 목록이 그 이름을 덮나(toolAllowed — 같은 글롭 · 더 넓은 글롭도 덮는다).
 *  · scope: memberScopes 를 주면 그 사람이 가진 것만 센다(scopeNeedsRegrant 와 같은 까닭 — 구성원에게 없는 scope 는 다시 동의해도 못 얻는다).
 *    그 사람이 나중에 그 권한을 받으면 그때 «다시 동의» 가 된다.
 *  · 도구도 같은 까닭으로(앱 v2 #124): memberScopes 를 주면, 그 도구가 요구하는 scope 를 그 사람이 갖지 않은 도구는 세지 않는다 — 다시 동의해도
 *    앱이 그 사람 이름으로 그 도구를 못 부른다(능력 관문 requireCapScope 가 그 사람의 scope 로 막는다). 이게 없으면 앱이 소수만 쓰는 도구
 *    (예: code scope 의 레포 판 읽기 — 관리자 이름으로 도는 정기 작업만 쓴다)를 더할 때 그 권한이 없는 구성원 모두가 쓰지도 못할 도구 때문에
 *    다시 동의해야 하고, 그동안 앱의 다른 일까지 막힌다(#1644 — 일 시작 전 거절).
 *  동의 창은 선언 전체로 동의하므로, 이게 비지 않는 것은 «앱이 동의한 뒤에 넓어졌다» 이거나 «사람이 API 로 일부만 동의했다» 둘 중 하나다.
 */
export function grantGap(grant: { scopes: readonly string[]; tools: readonly string[] }, declared: DeclaredGrant, memberScopes?: readonly string[]): GrantGap {
  const held = memberScopes ? new Set(memberScopes) : null;
  const optional = new Set(declared.optional_scopes ?? []);
  const unusable = (tool: string): boolean => {
    const need = toolScopeOf(tool);
    if (need == null) return false;
    if (held && !held.has(need)) return true;
    //  앱 v2 #124 선택 권한 — 그 도구가 기대는 scope 가 앱의 선택 권한이고 이 사람이 주지 않았으면, 다시 동의해도 앱이 그 사람 이름으로 못 부른다
    //   (동의 창은 선택 권한을 주지 않는다). 그 사람이 선택 권한을 준 뒤에는 다시 센다.
    return optional.has(need) && !grant.scopes.includes(need);
  };
  return {
    scopes: declared.scopes.filter((s) => !grant.scopes.includes(s) && (!held || held.has(s))),
    tools: declared.tools.filter((t) => !toolAllowed(grant.tools, t) && !unusable(t)),
  };
}

export function grantGapEmpty(g: GrantGap): boolean {
  return g.scopes.length === 0 && g.tools.length === 0;
}

/** 두 선언 모두에 있는 것만(a 의 이름 순서) — 도구는 b 가 그 이름을 덮나(toolAllowed)로 본다. «다시 동의로 얻을 수 있는 것» 으로 좁힐 때 쓴다. */
export function intersectGrantable(a: DeclaredGrant, b: DeclaredGrant): DeclaredGrant {
  //  선택 scope 는 어느 한쪽에서라도 선택이면 선택으로 본다 — 받지 않아도 되는 것을 «다시 동의» 로 요구하지 않는 쪽(빈칸을 덜 내는 쪽)이다.
  const optional = [...new Set([...(a.optional_scopes ?? []), ...(b.optional_scopes ?? [])])];
  return {
    scopes: a.scopes.filter((s) => b.scopes.includes(s)),
    tools: a.tools.filter((t) => toolAllowed(b.tools, t)),
    ...(optional.length ? { optional_scopes: optional } : {}),
  };
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

/** 받지 않은 선택 권한으로 막힌 거절의 표지(body.code) — 다시 동의(consent_required)와 가른다. */
export const OPTIONAL_SCOPE_REQUIRED = "optional_scope_required";

/**
 * 앱 v2 #124 — 선택 권한을 그 사람이 주지 않아 막혔다는 글. «동의» · «grant» 낱말을 쓰지 않는다: 웹 호스트(web/v2/app-ui.ts /동의|grant/)가
 *  그 낱말을 보고 그 자리에서 동의 창을 띄우는데, 동의 창은 선택 권한을 주지 않아 다시 해도 풀리지 않는다(#1644 — 풀리지 않는 안내를 내지 않는다).
 */
export function optionalScopeMessage(appId: string, scope: string, tool?: string): string {
  //  앱 id · 도구 이름 자체에 그 낱말이 들 수 있다(예: 앱 grants-tracker · 도구 me_app_grant) — 걸리는 이름만 빼고 쓴다(scope 이름에는 들지 않는다).
  const clean = (s: string): boolean => !CONSENT_DIALOG_WORDS.test(s);
  const app = clean(appId) ? `앱 '${appId}' 의` : "이 앱의";
  const what = !tool ? "그 권한이 드는 일을 할" : clean(tool) ? `'${tool}' 을 쓸` : "그 도구를 쓸";
  return `${app} 선택 권한 '${scope}' 을 이 사람이 주지 않아 ${what} 수 없습니다 — 선택 권한은 필요한 사람만 optional_scopes 로 따로 줍니다`;
}
/** 웹 호스트가 거절 글에서 «그 자리에서 동의 창» 을 띄우는 낱말(web/v2/app-ui.ts 와 같은 식). */
const CONSENT_DIALOG_WORDS = /동의|grant/i;

/**
 * 막힌 까닭이 «그 사람이 주지 않은 선택 권한» 인가 — 그렇다면 그 scope, 아니면 null. 도구면 그 도구가 기대는 scope(능력 등록부)로 본다.
 *  그 사람(구성원)에게 없는 scope 는 null — 주어도 앱이 그 사람 이름으로 못 얻는다(종전 «권한 밖»). 이미 준 scope 도 null.
 */
export function optionalScopeMissing(
  grantScopes: readonly string[], declared: DeclaredGrant, memberScopes: readonly string[], need: { tool: string } | { scope: string },
): string | null {
  const scope = "tool" in need ? toolScopeOf(need.tool) : need.scope;
  if (!scope || !(declared.optional_scopes ?? []).includes(scope)) return null;
  if (grantScopes.includes(scope) || !memberScopes.includes(scope)) return null;
  return scope;
}

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
  requested?: { scopes?: string[]; tools?: string[]; optional_scopes?: string[] },
  prior?: { scopes: readonly string[] } | null,
): ResolvedGrant {
  const maniScopes = m.permissions.scopes;
  const optional = m.permissions.optional_scopes ?? [];
  const maniTools = [...m.permissions.tools, ...m.permissions.ext_tools];

  //  앱 v2 #124 선택 권한 — optional_scopes 를 주면 그것만(선언한 선택 scope 안 · [] 면 하나도). 주지 않았으면:
  //   · 범위 없는 동의(동의 창 · me_app_grant {app_id}) — 이 사람이 이미 준 것(prior = 지금 살아 있는 동의) 가운데 이 판에서도 선택으로
  //     선언된 것을 그대로 둔다. 앱이 갱신돼 동의 창으로 다시 동의해도 정기 작업을 도는 사람의 선택 권한이 조용히 빠지지 않게.
  //   · 범위를 정해 준 동의(scopes · tools) — 정해 준 그대로다. 선택 권한은 옮기지 않는다(좁히려는 동의에 권한을 몰래 더하지 않는다).
  const ranged = !!requested && (requested.scopes !== undefined || requested.tools !== undefined);
  const extra = requested?.optional_scopes !== undefined
    ? requested.optional_scopes
    : ranged ? [] : (prior?.scopes ?? []).filter((s) => optional.includes(s));
  for (const s of extra) {
    if (!optional.includes(s)) throw new HttpError(400, `grant 오류: '${s}' 는 앱이 선언한 선택 권한(${optional.join(",") || "없음"})이 아닙니다`);
  }
  const withOptional = (scopes: readonly string[]): string[] => [...new Set([...scopes, ...extra])];

  if (!ranged || !requested) {
    return { scopes: withOptional(maniScopes), tools: [...maniTools] };
  }

  const scopes = requested.scopes ?? maniScopes;
  for (const s of scopes) {
    if (optional.includes(s)) throw new HttpError(400, `grant 오류: scope '${s}' 는 앱의 선택 권한입니다 — optional_scopes 로 줍니다`);
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
  return { scopes: withOptional(scopes), tools: [...tools] };
}
