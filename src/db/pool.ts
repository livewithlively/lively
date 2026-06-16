import pg from "pg";
import { getSourceConfig } from "./sources.js";

// 데이터소스별 lazy 풀 레지스트리 — db_query/db_schema 가 source 이름으로 풀을 얻는다.
// 각 소스는 반드시 읽기 전용 리플리카 + 읽기 전용 role 로 접속할 것(sources.ts / .env).
// (domainmap dmPool 의 lazy 패턴과 동일 — import 시점이 아니라 첫 사용 시 생성. 소스별 풀 분리라
//  한 소스 과부하가 다른 소스의 연결을 막지 않는다.)
const pools = new Map<string, pg.Pool>();

export function getPool(source: string): pg.Pool {
  const existing = pools.get(source);
  if (existing) return existing;
  const cfg = getSourceConfig(source);
  if (!cfg) throw new Error(`알 수 없는 db source '${source}'`);
  if (cfg.driver !== "postgres") {
    throw new Error(`db source '${source}' driver '${cfg.driver}' 미지원(pg-only)`);
  }
  const pool = new pg.Pool({ connectionString: cfg.url, max: 10 });
  pools.set(source, pool);
  return pool;
}
