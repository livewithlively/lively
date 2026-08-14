// 전역 DB 클라이언트(#1313 R10) — 전역 pg 풀(itemsPool) + 최소 쿼리 헬퍼(q/one/withTx/endPool)의 단일 출처(leaf).
//  ⚠ 계층 계약: 이 파일은 pg 계열 외 **어떤 상위 계층도 import 하지 않는다**(items/·v6/·org/·domainmap/·capabilities/… 금지)
//   — 'DB 풀이 어디 있나'를 이름으로 찾게 하는 leaf 라, 여기서 위를 보면 허브 순환이 되살아난다.
//  기존 이원 경로의 원문 이동: 풀 생성부는 items/store.ts 에서, q/one/withTx/endPool 은 domainmap/db.ts 에서
//  로직·설정 불변으로 옮겼다. 두 파일의 동명 재수출은 구 소비자·스크립트 호환 shim — 신규 코드는 여기를 직결한다.
import pg from "pg";

// 통합 DB(P1): domainmap 엔진(itemsPool)도 이 풀을 공유한다 — withTx 장기점유 + 커넥터 ingest +
// activity_log 원자기록의 동시 부하를 감안해 max 명시(기본 10 → 20, 풀 고갈 방지).
const rawPool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 20 });

// ── 테넌트 바인딩 파사드 ─────────────────────────────────────────────────────
//
// **왜 풀을 감싸는가**: 이 코드베이스에는 `itemsPool.query(...)` 호출이 597개, 144개 파일에 있다.
//  멀티테넌트 배포에서 그 전부가 "지금 이 요청의 테넌트"를 DB 에 알려야 하는데, 597곳을 고치는 건
//  가능하지도 않고 **한 곳만 빠뜨리면 남의 데이터를 읽는다**. 그래서 호출부를 그대로 두고
//  풀의 입구에서 바인딩을 건다 — 빠뜨릴 곳이 존재하지 않게.
//
// ⚠ **바인딩이 꺼져 있으면(자가호스팅 기본) 이 파사드는 원래 풀을 그대로 위임한다.** 트랜잭션도
//  추가하지 않는다 — 종전과 바이트 단위로 같은 동작이어야 한다.
//
// 두 경로를 덮는다:
//  · `query()`      — 바인딩이 켜져 있으면 **그 한 문장을 트랜잭션으로 감싸** 바인딩을 건다.
//  · `connect()`    — 반환 클라이언트를 감싸 **`BEGIN` 직후 바인딩을 주입**한다. withTx 든 손으로 쓴
//                     트랜잭션이든 전부 덮인다(호출부는 BEGIN 을 원래대로 쓴다).
//
// 왜 트랜잭션인가는 tenant-binding.ts 머리말 참조 — `SET LOCAL` 은 커밋/롤백에서 Postgres 가
//  되돌리므로 **커넥션 재사용 누출이 구조적으로 불가능**하다.

function wrapClient(client: pg.PoolClient): pg.PoolClient {
  const origQuery = client.query.bind(client);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patched: any = (...args: any[]) => {
    const first = args[0];
    const text = typeof first === "string" ? first : (first && typeof first === "object" ? String(first.text ?? "") : "");
    const out = origQuery(...(args as Parameters<typeof origQuery>));
    // BEGIN 직후에 바인딩을 건다. 반환 프라미스를 이어 붙여야 순서가 보장된다 —
    //  호출부가 await 하기 전에 다른 쿼리를 던져도 이 체인이 먼저 실행된다.
    if (/^\s*(BEGIN|START\s+TRANSACTION)\b/i.test(text)) {
      const bind = tenantBindingSql();
      // pg 의 query 는 콜백 오버로드가 있어 반환형이 void 를 포함한다 — 프라미스일 때만 이어 붙인다.
      //  (콜백 스타일로 BEGIN 을 치는 코드는 이 코드베이스에 없다. 있으면 바인딩이 안 걸리므로
      //   정책이 오류를 내서 조용히 새지 않는다 — 실패 방향이 안전한 쪽이다.)
      if (bind && out && typeof (out as { then?: unknown }).then === "function") {
        return (out as Promise<unknown>).then(async (r) => {
          await (origQuery as (s: string, p: unknown[]) => Promise<unknown>)(bind.sql, bind.params);
          return r;
        }) as never;
      }
    }
    return out;
  };
  return new Proxy(client, {
    get(target, prop, recv) {
      if (prop === "query") return patched;
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as pg.PoolClient;
}

export const itemsPool: pg.Pool = new Proxy(rawPool, {
  get(target, prop, recv) {
    if (prop === "query" && tenantBindingActive()) {
      // 단문 조회 — 바인딩을 걸려면 트랜잭션이 필요하다(SET LOCAL 은 트랜잭션 스코프).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return async (...args: any[]) => {
        const client = await rawPool.connect();
        try {
          await client.query("BEGIN");
          const bind = tenantBindingSql();
          if (bind) await client.query(bind.sql, bind.params as never[]);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await (client.query as any)(...args);
          await client.query("COMMIT");
          return r;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => { /* 커넥션이 이미 죽었으면 무의미 */ });
          throw e;
        } finally {
          client.release();
        }
      };
    }
    if (prop === "connect" && tenantBindingActive()) {
      return async () => wrapClient(await rawPool.connect());
    }
    const v = Reflect.get(target, prop, recv);
    return typeof v === "function" ? v.bind(target) : v;
  },
}) as pg.Pool;

// ── 테넌트 바인딩(주입형) ────────────────────────────────────────────────────
//
// ⚠ **여기 사는 이유**: 이 파일은 leaf 라 우리 모듈을 하나도 import 할 수 없다(레포의 import 경계 검사가
//  강제한다). 그래서 테넌트 컨텍스트를 여기서 읽지 않고, **상위가 주입한 리졸버**를 호출한다.
//  주입이 없으면(자가호스팅 기본) 바인딩은 꺼진 것이고 풀은 종전과 완전히 같이 동작한다.
//
// ── 왜 트랜잭션 스코프인가(설계의 핵심) ─────────────────────────────────────
// 커넥션 풀에서 테넌트를 세션 변수로 두면(`SET app.tenant_id = …`) **그 커넥션을 다음에 쓰는 요청이
//  남의 컨텍스트를 물려받는다.** 실무에서 실제로 나는 사고 유형이고, 안전이 "우리가 RESET 을
//  빠뜨리지 않는가"에 걸린다 — 즉 사람 규율에 의존한다.
//
// `SET LOCAL`(= `set_config(..., true)`)은 **트랜잭션이 끝나면 Postgres 가 되돌린다.** 우리가 무엇을
//  잊든 관계없다. 실측으로 확인했다: 같은 커넥션에서 A/B/A/B 로 번갈아 써도 섞이지 않는다.
//
// ⚠ 정책 쪽은 `current_setting('app.tenant_id')` 를 **missing_ok 없이** 읽는다 — 컨텍스트가 없으면
//  0행이 아니라 **오류**다. RLS 의 가장 큰 실무 고통("조용히 0행")을 그렇게 없앤다.

export interface TenantBindingSql {
  sql: string;
  params: unknown[];
}

/** 상위 계층이 주입하는 리졸버 — "지금 이 비동기 컨텍스트의 테넌트 id". 없으면 null. */
type TenantResolver = () => string | null;

let resolver: TenantResolver | null = null;

/**
 * 바인딩을 켠다. **멀티테넌트 배포의 부팅 경로만 부른다.**
 * 자가호스팅은 이걸 안 부르므로 아래 두 함수가 항상 "꺼짐"을 답하고, 풀은 종전과 같이 돈다.
 */
export function installTenantResolver(fn: TenantResolver): void {
  resolver = fn;
}

/** 테스트·정리용 — 주입을 해제한다. */
export function clearTenantResolver(): void {
  resolver = null;
}

/** 바인딩이 켜져 있는가(= 리졸버가 주입됐는가). 풀 파사드가 이걸로 경로를 가른다. */
export function tenantBindingActive(): boolean {
  return resolver !== null;
}

/**
 * 지금 걸어야 할 바인딩 문장. 리졸버가 없거나 테넌트를 못 찾으면 null(= 걸지 않는다).
 *
 * ⚠ 여기서 **던지지 않는다.** 컨텍스트 없는 접근을 막는 건 이 층의 일이 아니다 —
 *  막는 주체는 **DB 의 정책**이다(`''::uuid` 에서 오류가 난다). 이 층이 던지면 시스템 경로
 *  (부팅 스키마·마이그레이션)까지 막혀 기동 자체가 불가능해진다.
 */
export function tenantBindingSql(): TenantBindingSql | null {
  const id = resolver?.() ?? null;
  if (!id) return null;
  return { sql: "SELECT set_config('app.tenant_id', $1, true)", params: [id] };
}

// ── ★★ 고정 바인딩은 **여기서 자가 설치**한다 ────────────────────────────────
//
// 실측으로 밟았다(E2E): 게이트웨이 부팅(`index.ts`)에서만 리졸버를 꽂았더니, **DB 를 만지는 다른
//  진입점**이 바인딩 없이 돌았다 — `deploy/bootstrap-admin.mjs` 가 그것이다. 그 스크립트는
//  게이트웨이가 아니라 별도 프로세스라 부팅 코드를 안 탄다. 결과:
//    error: unrecognized configuration parameter "app.tenant_id"
//  다행히 **시끄럽게** 실패했다(정책이 그렇게 설계됐다). 조용히 남의 데이터를 읽는 대신.
//
// 고정 모드는 env 하나로 결정되고 상위 계층이 필요 없다 → leaf 에서 스스로 켤 수 있다.
//  그러면 게이트웨이·부트스트랩·CLI 등 **모든 진입점**이 자동으로 덮인다.
//  (요청별 모드는 AsyncLocalStorage 가 필요해 상위가 주입한다 — 게이트웨이 부팅이 이걸 덮어쓴다.)
(() => {
  const mode = (process.env.LIVELY_TENANT_BINDING || "").trim().toLowerCase();
  if (mode !== "rls") return;
  const id = (process.env.LIVELY_TENANT_ID || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
  installTenantResolver(() => id);
})();

export type Db = pg.Pool | pg.PoolClient;

// store-core.mjs 의 q/one 과 동일한 헬퍼 — 단 db 를 첫 인자로 명시(기본 pool 숨김 의존 제거).
// db = 공유 풀(호출마다 auto-checkout) 또는 트랜잭션용으로 체크아웃한 단일 client.
export const q = async (db: Db, sql: string, params: unknown[] = []): Promise<any[]> =>
  (await db.query(sql, params as any[])).rows;
export const one = async (db: Db, sql: string, params: unknown[] = []): Promise<any> =>
  (await q(db, sql, params))[0];

// 단일 트랜잭션 헬퍼 — ingest/refresh/merge/sync 가 사용. store-core 의
// connect→BEGIN→COMMIT/ROLLBACK→release 패턴과 동일(중도 실패 시 전체 롤백).
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// CLI 전용 종료 — 게이트웨이 프로세스는 절대 호출 금지(공용 풀 닫힘 사고 방지).
// 통합 DB 단일 풀(itemsPool) — CLI 종료는 공용 itemsPool 을 닫는다(CLI 는 분리 프로세스라 안전;
// 게이트웨이가 부르면 공용 풀이 닫혀 사고. 호출처는 domainmap/cli.ts 종료 경로뿐).
export async function endPool(): Promise<void> {
  await itemsPool.end();
}
