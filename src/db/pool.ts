import pg from "pg";
import { getSourceConfig, readSourceSecret, resolvePgPoolSpec, type DbSource } from "./sources.js";
import { invalidateMysqlPool } from "./mysql-engine.js";
import { itemsPool } from "./client.js";
import { secretAuthRetryFailed, secretVersion, type DbSecret } from "./secret-store.js";
import { logger } from "../log.js";

/** pg 접속 인증 실패 — SQLSTATE 28P01(invalid_password) · 28000(invalid_authorization_specification: 없는 역할 등). */
export const isPgAuthFailure = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "28P01" || code === "28000";
};

/**
 * #1764 — 접속 인증이 실패하면 refresh(시크릿을 fresh 로 다시 읽기)를 부르고, 값이 바뀌었으면(refresh 가 true) **한 번만** 더
 *  붙는다. 값이 그대로면 다시 붙지 않는다 — 비밀번호가 틀린 채로 두면 질의마다 실패 로그인이 두 배가 되고, DB 의 로그인 잠금
 *  정책에 먼저 걸린다. 두 번째도 인증 실패면 그 사실을 붙여 낸다(원래 SQLSTATE 는 code 로 남긴다). 시크릿을 못 읽으면 그
 *  까닭(DbSecretError)이 그대로 나간다. 인증 실패는 접속 단계의 오류라 질의는 아직 보내지 않았다 — 다시 붙어도 같은 질의가 두 번 돌지 않는다.
 */
export async function connectRetryingOnAuthFailure<C>(
  once: () => Promise<C>,
  refresh: () => Promise<boolean>,
  info: { source: string; ref: string },
): Promise<C> {
  try {
    return await once();
  } catch (e) {
    if (!isPgAuthFailure(e)) throw e;
    logger.info({ source: info.source, ref: info.ref, code: (e as { code?: unknown }).code }, "DB 인증 실패 — 시크릿을 다시 읽는다");
    if (!(await refresh())) throw secretAuthRetryFailed(info.source, info.ref, e, true);
    try {
      return await once();
    } catch (e2) {
      if (!isPgAuthFailure(e2)) throw e2;
      throw secretAuthRetryFailed(info.source, info.ref, e2);
    }
  }
}

// @types/pg 의 connect 콜백 꼴 그대로(done 의 인자는 release(err) 에 넘기는 값).
type PgConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: any) => void) => void;

/**
 * #1764 — 시크릿 저장소 참조(gcp-sm: · aws-sm:) 소스의 pg 풀. 비밀번호는 함수(sources.resolvePgPoolSpec)라 새 연결마다 5분
 *  기억한 값을 받고, 그 값으로 인증이 실패하면(시크릿이 막 교체됐다) fresh 로 다시 읽어 값이 바뀌었을 때만 한 번 더 붙는다.
 *  «바뀌었나» 는 값 판 번호(secret-store.secretVersion)로 가린다 — 이 시도가 시작된 뒤 다른 요청이 이미 새 값을 읽었으면
 *  (동시에 실패한 요청들) 다시 읽지 않고 그 값으로 붙는다.
 *  pg-pool 의 query() 도 this.connect(콜백) 을 거치므로 pool.connect · pool.query 어느 길이든 이 재시도를 탄다.
 */
export class SecretRefPgPool extends pg.Pool {
  readonly secret: { source: string; ref: string; userFromSecret: boolean };
  constructor(config: pg.PoolConfig, secret: { source: string; ref: string; userFromSecret: boolean }) {
    super(config);
    this.secret = secret;
  }
  connect(): Promise<pg.PoolClient>;
  connect(callback: PgConnectCallback): void;
  connect(callback?: PgConnectCallback): Promise<pg.PoolClient> | void {
    const { source, ref, userFromSecret } = this.secret;
    const startVersion = secretVersion(ref);
    const p = connectRetryingOnAuthFailure(() => super.connect(), async () => {
      let s: DbSecret;
      if (secretVersion(ref) !== startVersion) {
        s = await readSourceSecret(source, ref); // 이 시도가 시작된 뒤 값이 이미 바뀌었다 — 기억한 새 값으로 한 번 더
      } else {
        s = await readSourceSecret(source, ref, true);
        if (secretVersion(ref) === startVersion) return false; // 다시 읽어도 그대로 — 붙어 봐야 같은 실패다
      }
      // 사용자 이름도 시크릿에서 왔으면 함께 바꾼다(교체가 사용자를 번갈아 쓰는 방식일 때) — pg-pool 은 새 연결마다 this.options 로 만든다.
      if (userFromSecret && s.username) this.options.user = s.username;
      return true;
    }, this.secret);
    if (!callback) return p;
    p.then(
      (client) => callback(undefined, client, (release?: unknown) => client.release(release as boolean | Error | undefined)),
      (err: Error) => callback(err, undefined, () => undefined),
    );
  }
}

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
    const spec = await resolvePgPoolSpec(cfg);
    const poolCfg: pg.PoolConfig = { ...spec.config, max: 10 };
    // 시크릿 저장소 참조면 인증 실패 때 다시 읽는 풀(#1764). 환경변수 · 비밀번호 없음은 종전 그대로의 풀.
    const pool = spec.secretRef
      ? new SecretRefPgPool(poolCfg, { source, ref: spec.secretRef, userFromSecret: spec.userFromSecret })
      : new pg.Pool(poolCfg);
    // 외부 리플리카가 유휴 연결을 끊어도(재시작·프록시 유휴 타임아웃) 게이트웨이가 죽지 않게 — 리스너가 없으면
    //  pg-pool 의 'error' emit 이 throw 가 된다(#4501, client.ts rawPool 과 같은 부류). 그 연결은 풀이 이미 버렸다.
    pool.on("error", (err) => logger.warn({ source, err }, "db source 풀 유휴 연결 오류(연결을 버린다)"));   // err 로 넘긴다 — msg 키는 pino 의 메시지 칸과 겹친다
    return pool;
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
