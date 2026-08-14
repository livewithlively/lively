// 테넌트에 묶인 DB 접근 — **이 파일이 멀티테넌트 격리의 전부다.**
//
// ── 지키는 명제 ─────────────────────────────────────────────────────────────
//   요청 하나가 만지는 행은 그 요청의 테넌트 것뿐이다. 예외는 없다.
//
// 그걸 코드 규율(모든 쿼리에 WHERE tenant_id)로 지키면 반드시 새는데, 이유는 사람이 아니라 구조다 —
//  쿼리는 계속 늘고, 리뷰는 한 곳을 놓치고, 놓친 곳은 **조용히** 남의 데이터를 준다.
//  그래서 격리를 DB 에 맡기고, 이 파일은 "DB 가 판단할 재료를 정확히 주는 일"만 한다.
//
// ── 왜 트랜잭션 스코프인가(가장 중요한 설계 결정) ───────────────────────────
// 커넥션 풀에서 테넌트 컨텍스트를 세션 변수로 두면(`SET app.tenant_id = …`) **그 커넥션을 다음에
//  쓰는 요청이 남의 컨텍스트를 물려받는다.** 실무에서 실제로 나는 사고 유형이고, 우리 코드가
//  `RESET` 을 빠뜨리지 않는지에 안전이 걸린다 — 즉 사람 규율에 다시 의존한다.
//
// `SET LOCAL`(= `set_config(..., true)`)은 **트랜잭션이 끝나면 Postgres 가 되돌린다.** 우리 코드가
//  무엇을 잊든 관계없다. 그래서 이 모듈은 모든 접근을 **명시적 트랜잭션 안**에서만 허용한다.
//  대가: 단문 조회도 BEGIN/COMMIT 을 탄다(왕복 2회 추가). 그 값을 지불한다 — 유출의 대가가 비교가 안 된다.
//
// ── 왜 RLS 인가(2026-08-14 결정, 조사 근거) ─────────────────────────────────
// 셋을 비교했다. 스키마-per-테넌트와 DB-per-테넌트는 **둘 다 수백 테넌트를 못 넘긴다**(PlanetScale).
//  스키마 방식은 실명 사례가 우리와 좌표가 같다 — Influitive: 고객 100+ · 테이블 100+ 에서 마이그레이션이
//  O(1)→O(N), 인덱스 변경은 더 나쁘고, RDS r3.4xl(월 ~$3천)을 써야 했고, 클라이언트가 접속만 해도
//  전 스키마 메타데이터 캐싱으로 ~500MB 를 먹었다. 그들은 결국 **tenant_id 컬럼 방식으로 이주**했다.
//  우리 테이블은 129개다 — 100 테넌트면 12,900 테이블이고, 그게 정확히 그들이 무너진 지점이다.
// tenant_id + RLS 만이 수천 테넌트까지 권장되는 방식이고, Notion·Figma·GitLab 이 모두 이 축이다.

import type pg from "pg";
import { itemsPool } from "./client.js";
import { currentTenant, type TenantContext } from "../org/tenant-context.js";

/** 테넌트를 DB 에 알리는 방식. 미설정이면 단일 테넌트(바인딩 없음) — 자가호스팅 기본. */
export type TenantBinding = "none" | "rls";

export function tenantBinding(env: NodeJS.ProcessEnv = process.env): TenantBinding {
  return (env.LIVELY_TENANT_BINDING || "").trim().toLowerCase() === "rls" ? "rls" : "none";
}

/**
 * 바인딩 SQL(순수) — 트랜잭션 시작 직후 딱 한 번 실행할 문장들.
 *
 * ⚠ **전부 트랜잭션 로컬이어야 한다.** `set_config(...,true)` 와 `SET LOCAL` 만 쓴다.
 *  하나라도 세션 스코프면 그 커넥션을 다음에 쓰는 요청으로 새어 나간다.
 */
export function bindingStatements(
  binding: TenantBinding,
  t: TenantContext,
): Array<{ sql: string; params: unknown[] }> {
  switch (binding) {
    case "rls":
      // 정책이 읽는 값. 파라미터로 넘기므로 인젝션 표면이 없다.
      //  ★ 정책 쪽은 `current_setting('app.tenant_id')` 를 **missing_ok 없이** 읽는다 — 값이 없으면
      //   0행이 아니라 **오류**가 난다. RLS 의 가장 큰 실무 고통("조용히 0행")을 그렇게 없앤다.
      return [{ sql: "SELECT set_config('app.tenant_id', $1, true)", params: [t.id] }];
    case "none":
      return [];
  }
}

export class TenantIsolationError extends Error {}

/**
 * 테넌트에 묶인 트랜잭션. **멀티테넌트 배포에서 DB 에 닿는 유일한 정문이다.**
 *
 * · 멀티테넌트(바인딩 설정됨)인데 컨텍스트가 없으면 **던진다.** 폴백은 없다 —
 *   "모르면 아무 테넌트" 는 곧 유출이고, 배선 버그는 500 으로 드러나야 한다.
 * · 단일 테넌트(바인딩 none)면 종전과 같이 그냥 트랜잭션이다(자가호스팅 무회귀).
 */
export async function withTenantDb<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  opts?: { tenant?: TenantContext | null; env?: NodeJS.ProcessEnv },
): Promise<T> {
  const env = opts?.env ?? process.env;
  const binding = tenantBinding(env);
  const t = opts?.tenant ?? currentTenant();

  if (binding !== "none" && !t) {
    throw new TenantIsolationError(
      "테넌트 컨텍스트 없이 DB 에 접근했습니다 — 멀티테넌트 배포에서는 허용되지 않습니다",
    );
  }

  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    if (binding !== "none" && t) {
      for (const s of bindingStatements(binding, t)) {
        await client.query(s.sql, s.params as never[]);
      }
    }
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { /* 커넥션이 이미 죽었으면 무의미 */ });
    throw e;
  } finally {
    // ⚠ 반납은 반드시 한다. 트랜잭션 로컬 설정은 COMMIT/ROLLBACK 에서 Postgres 가 되돌리므로
    //  여기서 RESET 을 할 필요가 없다 — 그게 이 설계를 택한 이유다(우리가 잊어도 안전하다).
    client.release();
  }
}
