// domainmap 엔진 전용 DB 연결 — DOMAINMAP_DATABASE_URL 단독 (비즈니스 SQL 없음).
// 게이트웨이 메인 DATABASE_URL(읽기전용 lively 리플리카)로 절대 폴백하지 않는다 —
// 폴백하면 '조용히 잘못된 DB'에 쓰는 최악의 사고가 된다. 미설정이면 명시적 throw.
// Pool 은 lazy: import 시점이 아니라 첫 사용 시 생성 — DOMAINMAP_DATABASE_URL 없는
// 프로세스(예: items 전용 러너)가 이 모듈을 간접 import 해도 부팅이 죽지 않는다.
import pg from "pg";

let pool: pg.Pool | null = null;

export type Db = pg.Pool | pg.PoolClient;

export function dmPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DOMAINMAP_DATABASE_URL;
    if (!url) {
      // 문구 주의: wrap() 의 400 토큰(미지정/필수/형식)·404 토큰(없음) 회피 — 설정 사고는 5xx 가 맞다.
      throw new Error("DOMAINMAP_DATABASE_URL 미설정 — domainmap 엔진 비활성");
    }
    pool = new pg.Pool({ connectionString: url });
  }
  return pool;
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

// CLI 전용 종료 — 게이트웨이 프로세스는 절대 호출 금지(공용 풀 닫힘 사고 방지;
// CLI 는 프로세스가 분리돼 있어 안전).
export async function endPool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}
