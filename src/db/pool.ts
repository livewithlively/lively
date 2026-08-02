import pg from "pg";
import { getSourceConfig, resolveConnectionString, type DbSource } from "./sources.js";
import { invalidateMysqlPool } from "./mysql-engine.js";
import { itemsPool } from "./client.js";

// 데이터소스별 lazy 풀 레지스트리 — db_query/db_schema 가 source 이름으로 풀을 얻는다.
// 각 소스는 반드시 읽기 전용 리플리카 + 읽기 전용 role 로 접속할 것(sources.ts / .env / org_db_source).
// 풀 키 = `name@fingerprint` — url/authMode/secretSource 가 바뀌면(UI 편집) 자연히 새 풀이 생기고 옛 풀은 drain.
// 값은 Promise<pg.Pool> — getPool 이 async(resolveConnectionString await)라, 생성 프라미스를 await 전에 즉시
//  등록해 'check-then-set' 경쟁(동시 첫 접근이 풀을 둘 만들어 하나가 end() 없이 고아)을 막는다.
const pools = new Map<string, Promise<pg.Pool>>();

function fingerprint(src: DbSource): string {
  return `${src.url}|${src.authMode}|${src.secretSource ?? ""}`;
}

export async function getPool(source: string): Promise<pg.Pool> {
  const cfg = getSourceConfig(source);
  if (!cfg) throw new Error(`알 수 없는 db source '${source}'`);
  if (cfg.driver !== "postgres") {
    // mysql 소스(#715)는 mysql-engine.getMysqlPool 경유 — 호출자(tools/db·catalog)가 driver 로 분기한다.
    throw new Error(`db source '${source}' driver '${cfg.driver}' 는 pg 풀 대상이 아닙니다(mysql-engine 경유)`);
  }
  // 내장 self 소스(#604) — 게이트웨이 자기 items 풀 재사용(새 풀/시크릿 해소 없이). itemsPool 은 RW 지만
  //  db_query 의 execReadQuery 가 BEGIN READ ONLY→ROLLBACK 으로 감싸 읽기전용을 보장. invalidatePool 대상 아님(공유 풀).
  if (cfg.origin === "builtin") return itemsPool;
  const key = `${source}@${fingerprint(cfg)}`;
  const existing = pools.get(key);
  if (existing) return existing;
  // 같은 이름의 옛 fingerprint 풀이 있으면 detach 후 비동기 drain(in-flight 보호).
  for (const [k, op] of pools) {
    if (k.startsWith(`${source}@`) && k !== key) {
      pools.delete(k);
      void op.then((p) => p.end()).catch(() => { /* drain 실패 무시 — 이미 detach */ });
    }
  }
  // 생성 프라미스를 await 이전에 즉시 등록 → check-then-set 사이에 await 가 없어 인터리브 창이 사라진다.
  const created = (async (): Promise<pg.Pool> => {
    const poolCfg = await resolveConnectionString(cfg);
    return new pg.Pool({ ...poolCfg, max: 10 });
  })();
  pools.set(key, created);
  created.catch(() => {
    if (pools.get(key) === created) pools.delete(key); // 생성 실패 시 키 제거(재시도 가능)
  });
  return created;
}

// 소스 upsert/remove 시 호출 — 해당 이름의 모든 풀(현/구 fingerprint)을 detach 후 drain.
//  mysql 풀(#715)도 함께 무효화 — 호출자(delivery)가 드라이버를 몰라도 한 번으로 정리되게 위임.
export function invalidatePool(source: string): void {
  for (const [k, p] of pools) {
    if (k === source || k.startsWith(`${source}@`)) {
      pools.delete(k);
      void p.then((pool) => pool.end()).catch(() => { /* drain 실패 무시 */ });
    }
  }
  invalidateMysqlPool(source);
}
