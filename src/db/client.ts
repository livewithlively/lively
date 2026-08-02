// 전역 DB 클라이언트(#1313 R10) — 전역 pg 풀(itemsPool) + 최소 쿼리 헬퍼(q/one/withTx/endPool)의 단일 출처(leaf).
//  ⚠ 계층 계약: 이 파일은 pg 계열 외 **어떤 상위 계층도 import 하지 않는다**(items/·v6/·org/·domainmap/·capabilities/… 금지)
//   — 'DB 풀이 어디 있나'를 이름으로 찾게 하는 leaf 라, 여기서 위를 보면 허브 순환이 되살아난다.
//  기존 이원 경로의 원문 이동: 풀 생성부는 items/store.ts 에서, q/one/withTx/endPool 은 domainmap/db.ts 에서
//  로직·설정 불변으로 옮겼다. 두 파일의 동명 재수출은 구 소비자·스크립트 호환 shim — 신규 코드는 여기를 직결한다.
import pg from "pg";

// 통합 DB(P1): domainmap 엔진(itemsPool)도 이 풀을 공유한다 — withTx 장기점유 + 커넥터 ingest +
// activity_log 원자기록의 동시 부하를 감안해 max 명시(기본 10 → 20, 풀 고갈 방지).
export const itemsPool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 20 });

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
