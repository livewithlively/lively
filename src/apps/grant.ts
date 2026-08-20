// 앱 권한 해소 — 순수(#1780, design D3). 매니페스트 permissions(=상한)와 멤버 grant 요청을 결합해
//  실제 부여 scope/tool 을 정한다. 글롭 매칭은 appToolAllowed(PR2 런타임 필터)에서도 재사용한다.
//
// 불변식(design D3): grant 는 매니페스트 선언의 **부분집합**만 가능(사람이 좁힐 수는 있어도 넓힐 수는 없다).
//  admin·runtime scope 는 매니페스트 파서가 이미 거부하므로 여기 도달하지 않는다.
import { HttpError } from "../http-error.js";
import type { LivelyAppManifest } from "./manifest.js";

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
