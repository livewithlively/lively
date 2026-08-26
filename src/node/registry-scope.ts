// 노드 레지스트리의 **테넌트 스코프 판정** (#2044) — 순수. registry.ts 는 http.Server·WebSocketServer 를
//  들고 있어 단위테스트로 못 세우므로, 거기서 판단만 떼어 온다. 두 가지다:
//   ① 이 배포에서 인메모리 맵을 테넌트로 나눠야 하는가, 나눈다면 키는 무엇인가(scopeKey)
//   ② `/node/ws` 업그레이드를 받아도 되는가, 받는다면 어느 테넌트로 여는가(nodeUpgradeTenant)
//
// ── 왜 나눠야 하나 ──────────────────────────────────────────────────────────
// 공유 게이트웨이(매니지드 중앙 모드)는 한 프로세스가 여러 워크스페이스를 서비스한다. 그런데 노드 id 는
//  그 PC 의 **호스트명 슬러그**다(kit/cli/cmd-node.mjs slugHost) — `macbook-pro` 는 워크스페이스마다 겹친다.
//  id 만으로 맵 키를 잡으면 두 가지가 곧바로 깨진다:
//   ⓐ 뒤에 붙은 남의 노드를 **재연결로 오인해** 앞 노드를 terminate 한다(registry 의 교체 규칙).
//   ⓑ `nodeSessionsFor`·`nodeOfSession` 이 **남의 워크스페이스 노드 세션까지** 훑는다(멤버 id 도 겹칠 수 있다).
//  DB 는 RLS 가 막지만 이 맵들은 프로세스 메모리라 아무도 안 막는다.
//
// ⚠ **중앙 모드에서만 나눈다.** 자가호스팅(바인딩 off/fixed)과 registry(#1750 셀프호스트 다중 워크스페이스)는
//  스코프가 늘 빈 문자열이라 맵이 하나뿐이던 종전과 글자 그대로 같이 돈다(무회귀). registry 를 함께 나누지
//  않는 이유: 노드 WS 는 서명 헤더가 없어 소속을 알 방법이 자체가 없고(primary 로 붙는다), 요청 쪽만 나누면
//  살아 있는 노드를 못 찾게 된다 — 지금 도는 배포의 동작을 조용히 바꾸지 않는다.
import { resolveBindingMode } from "../db/tenant-binding-boot.js";
import { resolveTenantFromHeaders, type TenantContext } from "../org/tenant-context.js";

/** 스코프와 노드 id 의 경계 문자 — 둘 중 어디에도 못 들어가는 문자라 키가 값에 먹히지 않는다. */
export const SCOPE_SEP = "\u0000";

/**
 * 이 프로세스가 **요청별로 여러 테넌트**를 서비스하는가(= 맵을 나눠야 하는가).
 * 판정 출처는 `db/tenant-binding-boot.resolveBindingMode` 하나다 — 여기서 env 를 다시 해석하지 않는다.
 * 값이 이상해 던지면 false(나누지 않음) — 부팅이 이미 같은 값으로 검증했으므로 여기서 기동을 막을 이유가 없다.
 */
export function sharedGatewayMode(env: NodeJS.ProcessEnv = process.env): boolean {
  try { return resolveBindingMode(env).mode === "request"; } catch { return false; }
}

/**
 * 맵 키 — `<스코프><SEP><노드id>`. 스코프는 중앙 모드에서만 테넌트 id 이고 그 외엔 빈 문자열이다.
 * `nodeId` 에 빈 문자열을 주면 그 스코프의 **접두사**가 되어 순회 필터로 쓸 수 있다.
 */
export function scopeKey(nodeId: string, tenantId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const scope = sharedGatewayMode(env) ? (tenantId ?? "") : "";
  return scope + SCOPE_SEP + nodeId;
}

export type NodeUpgradeVerdict =
  | { ok: true; tenant: TenantContext | null }
  | { ok: false; reason: "unauthenticated" | "missing" | "not-owned"; detail: string };

/**
 * `/node/ws` 업그레이드를 받아도 되는가, 받는다면 어느 테넌트로 열 것인가.
 *
 * ★ 업그레이드는 Express 미들웨어를 **안 탄다** — 테넌트 컨텍스트가 여기엔 없다. 컨텍스트 없이 노드 토큰을
 *  조회하면 공유 게이트웨이에서는 RLS 정책이 `app.tenant_id` 를 못 읽어 쿼리가 오류나고, 그 오류가
 *  store 의 fail-closed catch 에 삼켜져 **'토큰 불일치'** 로 둔갑한다 → 매니지드에서 노드가 영원히 못 붙는다.
 *  (`terminal/terminal-pty.ts` 의 `/terminal/ws` 업그레이드가 이미 같은 이유로 같은 일을 한다.)
 *
 * `disabled`(= `LIVELY_TENANT_HEADER_SECRET` 미설정 = 자가호스팅)는 **오류가 아니라 종전 경로**다 —
 *  tenant=null 로 받아 컨텍스트 없이 그대로 진행한다.
 */
export function nodeUpgradeTenant(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): NodeUpgradeVerdict {
  const tr = resolveTenantFromHeaders(headers, env);
  if (tr.ok) return { ok: true, tenant: tr.tenant };
  if (tr.reason === "disabled") return { ok: true, tenant: null };
  return { ok: false, reason: tr.reason, detail: tr.detail };
}
