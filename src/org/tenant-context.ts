// 요청 스코프 테넌트 컨텍스트 — "지금 이 요청은 누구의 것인가"를 콜스택 전체에 흘린다.
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// 지금 게이트웨이 프로세스 하나는 **워크스페이스 하나**를 서비스한다. 그래서 "누구의 데이터인가"가
//  프로세스 자체로 정해지고(전역 DB 풀 하나), 코드 어디에도 그 질문이 안 나온다.
//
// 그 가정을 풀고 싶은 배포가 있다 — 게이트웨이 하나가 여러 워크스페이스를 서비스하는 형태.
//  그때 필요한 건 "요청마다 다른 대상"을 **인자로 전부 넘기지 않고도** 알 수 있는 통로다.
//  DB 접근은 코드베이스 깊은 곳(스토어·증류·도메인맵)에서 일어나고, 그 전부에 테넌트 인자를
//  꿰는 건 현실적이지 않다(그리고 한 곳만 빠뜨리면 **남의 데이터를 읽는다**).
//
// ── 기본은 단일 테넌트다(OSS 무회귀) ────────────────────────────────────────
// 자가호스팅은 워크스페이스가 하나다 → 컨텍스트가 상수이므로 이 모듈은 사실상 no-op 이다.
//  `currentTenant()` 는 컨텍스트가 없으면 `null` 을 주고, 호출부는 종전 동작(전역 풀)을 그대로 쓴다.
//  **컨텍스트를 요구하는 코드를 쓰지 마라** — `requireTenant()` 는 멀티테넌트 배포 전용이다.
//
// ── AsyncLocalStorage 를 쓰는 이유와 그 함정 ────────────────────────────────
// 전역 변수(`let current = ...`)로 하면 **동시 요청이 서로를 덮는다.** Node 는 단일 스레드지만
//  await 마다 다른 요청으로 넘어가므로, A 의 await 뒤에 B 가 값을 바꿔 놓으면 A 가 깨어나 B 의
//  테넌트로 DB 를 읽는다. 재현이 어렵고(부하가 있어야 난다) 증상은 **데이터 유출**이다.
//  AsyncLocalStorage 는 비동기 체인마다 별도 저장소를 줘서 그 부류를 구조적으로 막는다.
//  ⚠ 그래도 함정은 남는다: `run()` 밖에서 만든 프라미스·타이머·이벤트 핸들러는 컨텍스트를 못 본다.
//   그래서 이 모듈은 "없으면 null" 로 두고, **묵시적으로 아무 테넌트를 고르지 않는다**.

import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  /** 테넌트 식별자(관리 평면의 키). 단일 테넌트 배포에는 이 개념이 없다. */
  id: string;
  /** 사람이 읽는 이름 — 로그·오류 메시지용. 판정에는 쓰지 않는다. */
  slug: string;
}

const store = new AsyncLocalStorage<TenantContext>();

/** 이 요청의 테넌트. 단일 테넌트 배포·컨텍스트 밖에서는 null(종전 동작). */
export function currentTenant(): TenantContext | null {
  return store.getStore() ?? null;
}

/**
 * 멀티테넌트 경로 전용 — 컨텍스트가 없으면 **던진다.**
 *
 * 왜 기본값으로 때우지 않는가: "모르면 첫 번째 테넌트" 같은 폴백은 조용히 남의 데이터를 준다.
 *  컨텍스트를 잃는 건 배선 버그이고, 배선 버그는 500 으로 드러나야 한다(잘못된 200 보다 낫다).
 */
export function requireTenant(): TenantContext {
  const t = store.getStore();
  if (!t) throw new Error("테넌트 컨텍스트가 없습니다 — 멀티테넌트 경로가 컨텍스트 밖에서 호출됐습니다");
  return t;
}

/** 이 콜체인 동안 테넌트를 고정한다. 중첩되면 안쪽이 이긴다. */
export function withTenant<T>(t: TenantContext, fn: () => T): T {
  return store.run(t, fn);
}

// ── 샤드 소속 ───────────────────────────────────────────────────────────────
//
// ★ 왜 지금 넣나: 게이트웨이를 하나로 합치면 "모두가 운명을 공유한다"가 된다. 그걸 줄이는 방법은
//  **복제**(같은 걸 N벌, 아무나 아무 테넌트를 처리)와 **샤딩**(N벌이 각자 정해진 테넌트만) 두 가지인데,
//  복제는 조율 비용이 크다 — 하우스키핑 크론이 둘, 같은 tmux 옵션 쓰기자가 둘, 인메모리 캐시 분기.
//  샤딩은 테넌트마다 담당이 정확히 하나라 그 문제가 **전부 사라지고** blast radius 는 1/N 이 된다.
//
//  그래서 처음부터 "이 게이트웨이가 담당하는 집합" 개념을 넣어 두고, 지금은 그게 '전부'인 샤드
//  하나로 돈다. 나중에 나누는 건 env 를 주는 일이 된다 — 코드에 개념이 없으면 그때 전면 개조가 된다.

/**
 * 이 프로세스가 담당하는 테넌트 집합. 빈 값 = **전부**(단일 샤드 = 기본).
 * 형식: 쉼표로 구분한 slug 목록. 호출 시점에 읽는다(재배포 없이 바꿀 여지를 남긴다).
 */
export function shardTenants(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = (env.LIVELY_GATEWAY_SHARD_TENANTS || "").trim();
  if (!raw) return null;
  const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return set.size ? set : null;
}

/** 이 프로세스가 그 테넌트를 담당하는가. 샤드 미설정이면 언제나 참(전부 담당). */
export function ownsTenant(slug: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const shard = shardTenants(env);
  return !shard || shard.has(slug);
}

// ── 요청에서 테넌트 해소 ────────────────────────────────────────────────────
//
// 멀티테넌트 배포에서는 앞단(라우터)이 이미 "이 요청이 누구 것인가"를 안다 — Host 로 찾아서
//  업스트림을 골랐으니까. 그 값을 헤더로 넘겨받으면 게이트웨이가 같은 조회를 두 번 하지 않는다.
//
// ★★ **그 헤더는 앞단에서 왔을 때만 믿는다.** 헤더는 누구나 붙일 수 있다 — 게이트웨이에 직접
//  닿을 수 있는 무엇이든 `x-lvly-tenant: <남의-slug>` 를 보내면 그대로 남의 데이터가 열린다.
//  그래서 **공유 비밀**을 함께 요구한다. 지금은 게이트웨이가 사설 IP·루프백에만 떠 있어서
//  네트워크로도 막히지만, 그 사실에 기대지 않는다 — 포트 노출은 설정 실수 하나로 생기고,
//  그때 인증이 없으면 격리가 통째로 사라진다(라우터를 우회하면 캡 집행도 함께 우회된다).

export const TENANT_HEADER = "x-lvly-tenant";
export const TENANT_ID_HEADER = "x-lvly-tenant-id";
export const TENANT_AUTH_HEADER = "x-lvly-tenant-auth";

export interface TenantResolveResult {
  ok: true;
  tenant: TenantContext;
}
export interface TenantResolveFail {
  ok: false;
  /** "disabled" = 단일 테넌트 배포(멀티테넌트 미설정) → 호출부는 종전 경로로 간다(오류 아님) */
  reason: "disabled" | "unauthenticated" | "missing" | "not-owned";
  detail: string;
}

/**
 * 헤더에서 테넌트를 해소한다(순수 — 헤더 맵과 env 만 본다).
 *
 * `LIVELY_TENANT_HEADER_SECRET` 이 없으면 **멀티테넌트가 꺼진 것**으로 보고 `disabled` 를 준다.
 *  자가호스팅은 이 값을 안 주므로 이 경로 전체가 없는 것과 같다(무회귀).
 *
 * ⚠ 비밀 비교는 길이가 같을 때만 timingSafeEqual 을 쓴다. 길이가 다르면 애초에 불일치이고,
 *  길이 차이로 던지지 않게 먼저 걸러야 한다(그 예외가 500 으로 새면 그것도 정보다).
 */
export function resolveTenantFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): TenantResolveResult | TenantResolveFail {
  const secret = (env.LIVELY_TENANT_HEADER_SECRET || "").trim();
  if (!secret) return { ok: false, reason: "disabled", detail: "단일 테넌트 배포" };

  const first = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : v) ? String(Array.isArray(v) ? v[0] : v).trim() : "";

  const got = first(headers[TENANT_AUTH_HEADER]);
  if (!got || !constantTimeEqual(got, secret)) {
    return { ok: false, reason: "unauthenticated", detail: "테넌트 헤더 인증 실패" };
  }
  const slug = first(headers[TENANT_HEADER]);
  const id = first(headers[TENANT_ID_HEADER]);
  // slug 형식을 여기서 다시 잰다 — 앞단을 믿더라도 이 값이 로그·소켓 경로·오류 메시지에 실린다.
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || !id) {
    return { ok: false, reason: "missing", detail: `테넌트 식별 정보 부족(slug=${slug || "없음"})` };
  }
  if (!ownsTenant(slug, env)) {
    // 샤딩에서 남의 샤드 요청이 온 것 — 앞단의 매핑이 낡았다는 신호다. 조용히 처리하면
    //  두 게이트웨이가 같은 테넌트를 만지게 되므로(크론·tmux 옵션 경합) 명확히 거절한다.
    return { ok: false, reason: "not-owned", detail: `이 게이트웨이의 샤드가 아닙니다: ${slug}` };
  }
  return { ok: true, tenant: { id, slug } };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
