// 테넌트 바인딩 배선 — 부팅 때 한 번, 리졸버를 풀에 꽂는다. (#1437 v1 3단계)
//
// ── 두 가지 모드, 그리고 왜 둘인가 ──────────────────────────────────────────
// 공유 게이트웨이로 가는 길에는 **분리할 수 있는 위험 두 개**가 있다:
//   ⓐ 데이터를 공용 DB(tenant_id + RLS)로 옮기는 것
//   ⓑ 게이트웨이 프로세스 하나가 여러 테넌트를 서비스하는 것
// 둘을 한 번에 하면 문제가 생겼을 때 어느 쪽인지 모른다. 그래서 모드를 둘로 나눈다.
//
//  `fixed`   — 이 프로세스는 **테넌트 하나**를 서비스한다(지금의 테넌트별 게이트웨이 그대로).
//              다만 DB 는 공용이고, 모든 쿼리가 `LIVELY_TENANT_ID` 로 바인딩된다.
//              → ⓐ만 켠다. 라우팅·세션·격리 구조는 한 줄도 안 바뀐다. 이관을 여기서 먼저 검증한다.
//  `request` — 요청마다 테넌트가 다르다(공유 게이트웨이). AsyncLocalStorage 컨텍스트를 읽는다.
//              → ⓑ까지 켠다.
//
// 아무것도 설정하지 않으면 **주입 자체를 안 한다** — 자가호스팅은 종전과 완전히 같이 돈다.
//
// ⚠ `fixed` 에서 값이 형식에 안 맞으면 **기동을 실패시킨다.** 잘못된 테넌트 id 로 뜨면 그 게이트웨이가
//  통째로 남의 데이터를 만지게 된다. 그건 500 보다 나쁘다 — 아예 뜨지 않는 게 맞다.

import { installTenantResolver } from "./client.js";
import { currentTenant } from "../org/tenant-context.js";
import { installTenantSlugResolver } from "../terminal/catalog.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BindingMode = "off" | "fixed" | "request";

/** 설정에서 모드를 읽는다(순수). 값이 이상하면 off 가 아니라 **던진다** — 조용히 안 켜지면 유출이다. */
export function resolveBindingMode(env: NodeJS.ProcessEnv = process.env): { mode: BindingMode; tenantId?: string } {
  const raw = (env.LIVELY_TENANT_BINDING || "").trim().toLowerCase();
  if (!raw || raw === "off") return { mode: "off" };
  if (raw !== "rls") throw new Error(`LIVELY_TENANT_BINDING 값이 잘못됐습니다: ${raw} (rls 또는 미설정)`);

  const fixed = (env.LIVELY_TENANT_ID || "").trim();
  if (!fixed) return { mode: "request" };
  if (!UUID_RE.test(fixed)) {
    // ★ 형식이 틀린 값으로 뜨면 그 게이트웨이의 **모든 쿼리**가 잘못된 소속으로 돈다.
    throw new Error(`LIVELY_TENANT_ID 가 UUID 형식이 아닙니다 — 기동을 중단합니다`);
  }
  return { mode: "fixed", tenantId: fixed };
}

/**
 * 부팅 배선. 반환: 사람이 읽는 한 줄(로그용). off 면 아무것도 하지 않는다.
 *
 * ⚠ **한 번만 부른다.** 두 번 부르면 나중 것이 이긴다 — 그 자체는 무해하지만, 두 번 부르는 코드는
 *  대개 부팅 순서를 잘못 이해한 것이므로 로그로 드러나야 한다.
 */
export function installTenantBinding(env: NodeJS.ProcessEnv = process.env): string {
  const r = resolveBindingMode(env);
  if (r.mode === "off") return "테넌트 바인딩: 꺼짐(단일 테넌트)";

  // ★ DB 뿐 아니라 **파일 루트**도 테넌트를 따라야 한다. 하나만 바인딩하면 "DB 는 내 것, 파일은
  //  남의 것" 이라는 반쪽 상태가 되고, 그건 파일 탐색기에서 곧바로 남의 파일로 드러난다.
  //  카탈로그는 leaf 라 컨텍스트를 import 할 수 없어 여기서 꽂는다(catalog.roots 머리말 참조).
  installTenantSlugResolver(() => currentTenant()?.slug ?? null);
  if (r.mode === "fixed") {
    const id = r.tenantId!;
    installTenantResolver(() => id);
    return `테넌트 바인딩: 고정(${id.slice(0, 8)}…) — 공용 DB, 이 프로세스는 테넌트 하나를 서비스한다`;
  }
  // request 모드 — 요청 스코프 컨텍스트를 읽는다. 컨텍스트가 없으면 null 을 주고(던지지 않는다),
  //  막는 주체는 DB 정책이다(`''::uuid` 오류). 자세한 이유는 client.ts 의 tenantBindingSql 주석 참조.
  installTenantResolver(() => currentTenant()?.id ?? null);
  return "테넌트 바인딩: 요청별 — 공유 게이트웨이";
}
