// domainmap 엔진 DB 연결 — **통합 DB(P0+P1)**: domainmap 테이블이 items DB(ITEMS_DATABASE_URL)로
// 물리 병합돼, domainmap 엔진도 items 의 단일 풀(itemsPool)을 그대로 쓴다. 게이트웨이 메인
// DATABASE_URL(읽기전용 lively 리플리카)로는 절대 폴백하지 않는다(쓰기 통합 DB ≠ 읽기전용 리플리카).
import pg from "pg";
import { itemsPool } from "../items/store.js";

export type Db = pg.Pool | pg.PoolClient;

// 단일 풀 반환 — withTx 한 트랜잭션 안에서 knowledge_unit + domain/activity 등 cross-table 원자 쓰기가
// 가능해진다(통합의 핵심 이유). 옵션B(풀 2개·같은 DB)는 JOIN 만 되고 단일 txn 원자성을 못 얻으므로 폐기.
// itemsPool 은 store.ts 모듈 평가 시 생성되는 const — dmPool() 은 런타임 호출이라 순환 import 안전(TDZ 무관).
export function dmPool(): pg.Pool {
  return itemsPool;
}

// store-core.mjs 의 q/one 과 동일한 헬퍼 — 단 db 를 첫 인자로 명시(기본 pool 숨김 의존 제거).
// db = 공유 풀(호출마다 auto-checkout) 또는 트랜잭션용으로 체크아웃한 단일 client.
export const q = async (db: Db, sql: string, params: unknown[] = []): Promise<any[]> =>
  (await db.query(sql, params as any[])).rows;
export const one = async (db: Db, sql: string, params: unknown[] = []): Promise<any> =>
  (await q(db, sql, params))[0];

// 단일 트랜잭션 헬퍼 — ingest/refresh/merge/sync 가 사용. store-core 의
// connect→BEGIN→COMMIT/ROLLBACK→release 패턴과 동일(중도 실패 시 전체 롤백).
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await dmPool().connect();
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
// 통합 후 dmPool=itemsPool 이므로 CLI 종료는 공용 itemsPool 을 닫는다(CLI 는 분리 프로세스라 안전;
// 게이트웨이가 부르면 공용 풀이 닫혀 사고. 호출처는 domainmap/cli.ts 종료 경로뿐).
export async function endPool(): Promise<void> {
  await itemsPool.end();
}
