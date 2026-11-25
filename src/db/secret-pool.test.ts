// #1764 접속 인증 실패 → 시크릿 다시 읽기 → 한 번 더 — 단위 시험(스크래치 spec.md E · 엣지 E2).
//  pg: connectRetryingOnAuthFailure(SecretRefPgPool.connect 가 쓰는 재시도) — 실제 pg 연결은 secret-ref-rotation.pg-test.mjs 가 본다.
//  mysql: SourceMysqlPool 에 가짜 풀을 끼워 «값이 바뀌면 새 풀로 바꿔 한 번 더 · 그대로면 다시 붙지 않음 · 동시 실패는 한 번만 읽기 ·
//   옛 풀은 곧바로 닫지 않고 유예 뒤 닫음 · 환경변수 참조는 다시 읽지 않음» 을 본다.
// 실행: npm run build && node dist/db/secret-pool.test.js
import assert from "node:assert/strict";
import { mock } from "node:test";
import pg from "pg";
import type mysql from "mysql2/promise";
import { connectRetryingOnAuthFailure, isPgAuthFailure, SecretRefPgPool } from "./pool.js";
import { SourceMysqlPool, isMysqlAuthFailure, type MysqlResolved } from "./mysql-engine.js";
import { DbSecretError, readDbSecret, secretVersion, __setSecretStoreDepsForTest } from "./secret-store.js";

let pass = 0;
const tests: Array<[string, () => Promise<void>]> = [];
const t = (name: string, fn: () => Promise<void>): void => { tests.push([name, fn]); };
const pgAuth = (code = "28P01"): Error => Object.assign(new Error(`password authentication failed for user "ro"`), { code });
const myAuth = (): Error => Object.assign(new Error("Access denied for user 'ro'@'10.0.0.1' (using password: YES)"), { code: "ER_ACCESS_DENIED_ERROR", errno: 1045 });
const INFO = { source: "analytics", ref: "gcp-sm:my-project/db-pw" };

// ── pg ──
t("pg: 첫 시도 성공 → 다시 읽지 않는다", async () => {
  let refreshed = 0;
  assert.equal(await connectRetryingOnAuthFailure(async () => "c1", async () => { refreshed++; return true; }, INFO), "c1");
  assert.equal(refreshed, 0);
});
t("pg: 인증 아닌 오류 → 그대로 내고 다시 읽지 않는다", async () => {
  let refreshed = 0;
  const boom = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  await assert.rejects(connectRetryingOnAuthFailure(async () => { throw boom; }, async () => { refreshed++; return true; }, INFO), (e) => e === boom);
  assert.equal(refreshed, 0);
});
t("pg: 28P01 + 값이 바뀜 → 한 번 더 → 성공", async () => {
  let refreshed = 0;
  let n = 0;
  const v = await connectRetryingOnAuthFailure(async () => { if (n++ === 0) throw pgAuth(); return "c2"; }, async () => { refreshed++; return true; }, INFO);
  assert.equal(v, "c2");
  assert.equal(refreshed, 1);
  assert.equal(n, 2);
});
t("pg: 28000(없는 역할 등)도 값이 바뀌면 한 번 더", async () => {
  let n = 0;
  assert.equal(await connectRetryingOnAuthFailure(async () => { if (n++ === 0) throw pgAuth("28000"); return "c"; }, async () => true, INFO), "c");
  assert.equal(n, 2);
});
t("pg: 28P01 + 다시 읽은 값이 그대로 → 다시 붙지 않고 «값이 그대로» + 원래 code(실패 로그인을 늘리지 않는다)", async () => {
  let n = 0;
  await assert.rejects(
    connectRetryingOnAuthFailure(async () => { n++; throw pgAuth(); }, async () => false, INFO),
    (e: Error & { code?: string }) => /값이 그대로/.test(e.message) && e.code === "28P01",
  );
  assert.equal(n, 1, "값이 그대로인데 다시 로그인했다");
});
t("pg: 두 번째도 인증 실패 → «또 실패» + 원래 code, 세 번째는 없다", async () => {
  let n = 0;
  await assert.rejects(
    connectRetryingOnAuthFailure(async () => { n++; throw pgAuth(); }, async () => true, INFO),
    (e: Error & { code?: string }) => /다시 읽어 한 번 더/.test(e.message) && /analytics/.test(e.message) && e.code === "28P01",
  );
  assert.equal(n, 2);
});
t("pg: 다시 읽기가 실패하면 그 까닭을 낸다(두 번째 시도는 없다)", async () => {
  let n = 0;
  const why = new DbSecretError("permission_denied", INFO.ref, "x").withSource("analytics");
  await assert.rejects(connectRetryingOnAuthFailure(async () => { n++; throw pgAuth(); }, async () => { throw why; }, INFO), (e) => e === why);
  assert.equal(n, 1);
});
t("판정: pg · mysql 인증 실패 코드", async () => {
  assert.equal(isPgAuthFailure(pgAuth()), true);
  assert.equal(isPgAuthFailure({ code: "42P01" }), false);
  assert.equal(isPgAuthFailure(null), false);
  assert.equal(isMysqlAuthFailure(myAuth()), true);
  assert.equal(isMysqlAuthFailure({ code: "ER_DBACCESS_DENIED_ERROR", errno: 1044 }), false); // 스키마 권한 — 비밀번호와 무관
});

// ── pg — SecretRefPgPool.connect 덮어쓰기(콜백 · 프라미스 두 꼴) ──
//  부모(pg-pool)의 connect 를 가짜로 바꿔 «인증 실패 → 다시 읽기 → 한 번 더» 의 배선을 본다. 시크릿 저장소는 fetch 를 끼운 가짜 GCP.
const PREF = "gcp-sm:my-project/pg-pw";
let storeValue = "pw-1";
let storeCalls = 0;
const fakeStoreFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.includes("/computeMetadata/")) {
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200, headers: { "Metadata-Flavor": "Google", "content-type": "application/json" } });
  }
  storeCalls++;
  return new Response(JSON.stringify({ payload: { data: Buffer.from(storeValue).toString("base64") } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const stubbedPool = async (behaviors: Array<() => Promise<unknown>>, userFromSecret = false): Promise<{ pool: SecretRefPgPool; calls: () => number; restore: () => void }> => {
  __setSecretStoreDepsForTest({ fetch: fakeStoreFetch, gcpMetadataBase: () => "http://meta.test", gcpSecretManagerBase: "http://sm.test/v1", retryDelayMs: 0 });
  storeCalls = 0;
  await readDbSecret(PREF); // 풀을 만들 때처럼 한 번 읽어 기억해 둔다(값 판 1)
  let n = 0;
  const proto = pg.Pool.prototype as unknown as { connect: unknown };
  proto.connect = function stub(): Promise<unknown> { const b = behaviors[n] ?? behaviors[behaviors.length - 1]; n++; return b(); };
  const pool = new SecretRefPgPool({ host: "127.0.0.1", user: "ro" }, { source: "analytics", ref: PREF, userFromSecret });
  return { pool, calls: () => n, restore: () => { delete proto.connect; __setSecretStoreDepsForTest(null); } };
};
const fakeClient = (): { released: unknown[]; release: (x?: unknown) => void } => {
  const c = { released: [] as unknown[], release: (x?: unknown) => { c.released.push(x ?? "ok"); } };
  return c;
};

t("pg 풀(콜백 꼴 — pool.query 가 쓰는 길): 교체로 인증 실패 → 다시 읽어 한 번 더 → client · done 이 제대로 넘어온다", async () => {
  storeValue = "pw-1";
  const client = fakeClient();
  const h = await stubbedPool([async () => { throw pgAuth(); }, async () => client]);
  try {
    storeValue = "pw-2"; // 저장소는 이미 새 값(기억은 아직 pw-1)
    const got = await new Promise<{ err?: Error; c?: unknown; done?: (r?: unknown) => void }>((resolve) => {
      h.pool.connect((err, c, done) => resolve({ err, c, done }));
    });
    assert.equal(got.err, undefined);
    assert.equal(got.c, client);
    got.done?.();
    assert.deepEqual(client.released, ["ok"], "done 이 client.release 로 이어지지 않았다");
    assert.equal(h.calls(), 2);
    assert.equal(storeCalls, 2, "처음 읽기 + 인증 실패 뒤 다시 읽기");
  } finally { h.restore(); }
});
t("pg 풀(콜백 꼴): 인증 아닌 오류 → callback(err) · done 은 함수 · 다시 읽지 않는다", async () => {
  storeValue = "pw-1";
  const boom = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const h = await stubbedPool([async () => { throw boom; }]);
  try {
    const got = await new Promise<{ err?: Error; c?: unknown; done?: unknown }>((resolve) => {
      h.pool.connect((err, c, done) => resolve({ err, c, done }));
    });
    assert.equal(got.err, boom);
    assert.equal(got.c, undefined);
    assert.equal(typeof got.done, "function");
    assert.equal(storeCalls, 1, "인증 아닌 오류에 시크릿을 다시 읽었다");
  } finally { h.restore(); }
});
t("pg 풀(프라미스 꼴): 다시 읽은 값이 그대로 → 로그인은 한 번뿐 · «값이 그대로»", async () => {
  storeValue = "pw-1";
  const h = await stubbedPool([async () => { throw pgAuth(); }]);
  try {
    await assert.rejects(h.pool.connect(), (e: Error & { code?: string }) => /값이 그대로/.test(e.message) && e.code === "28P01");
    assert.equal(h.calls(), 1, "값이 그대로인데 다시 로그인했다");
    assert.equal(storeCalls, 2);
  } finally { h.restore(); }
});
t("pg 풀: 실패한 사이 다른 요청이 이미 새 값을 읽었으면 다시 읽지 않고 그 값으로 한 번 더", async () => {
  storeValue = "pw-1";
  const client = fakeClient();
  const h = await stubbedPool([
    async () => { storeValue = "pw-2"; await readDbSecret(PREF, { fresh: true }); throw pgAuth(); }, // 동시에 실패한 다른 요청이 먼저 다시 읽었다
    async () => client,
  ]);
  try {
    const before = secretVersion(PREF);
    assert.equal(await h.pool.connect(), client);
    assert.equal(storeCalls, 2, "이미 바뀐 값을 또 읽었다(처음 + 다른 요청의 다시 읽기 = 2)");
    assert.equal(secretVersion(PREF), before + 1);
  } finally { h.restore(); }
});
t("pg 풀: 사용자 이름이 시크릿에서 왔으면 다시 읽은 username 으로 갈아 낀다", async () => {
  storeValue = JSON.stringify({ username: "ro_a", password: "pw-1" });
  const h = await stubbedPool([async () => { throw pgAuth(); }, async () => fakeClient()], true);
  try {
    storeValue = JSON.stringify({ username: "ro_b", password: "pw-2" }); // 사용자를 번갈아 쓰는 교체
    await h.pool.connect();
    assert.equal(h.pool.options.user, "ro_b");
  } finally { h.restore(); }
});

// ── mysql — 가짜 풀 ──
interface FakePool { id: number; opts: mysql.PoolOptions; ended: boolean; getConnection: () => Promise<unknown>; query: (sql: string, v?: unknown) => Promise<unknown>; end: () => Promise<void> }
const harness = (behaviors: Array<{ conn?: () => Promise<unknown>; query?: () => Promise<unknown> }>) => {
  const made: FakePool[] = [];
  const create = (opts: mysql.PoolOptions): mysql.Pool => {
    const b = behaviors[made.length] ?? {};
    const p: FakePool = {
      id: made.length, opts, ended: false,
      getConnection: b.conn ?? (async () => ({ conn: made.length })),
      query: b.query ?? (async () => [[{ ok: 1 }], []]),
      end: async () => { p.ended = true; },
    };
    made.push(p);
    return p as unknown as mysql.Pool;
  };
  return { made, create };
};
const resolved = (key: string, password = "pw-" + key): MysqlResolved => ({ options: { host: "10.0.0.1", user: "ro", password }, credKey: key });
const SRC = { name: "analytics", secretSource: "aws-sm:ap-northeast-2/prod/db", timeoutMs: 5000 };

t("mysql(E2): 환경변수 참조(다시 읽기 없음) + 1045 → 원래 오류 그대로, 새 풀 없음", async () => {
  const err = myAuth();
  const h = harness([{ conn: async () => { throw err; } }]);
  const p = new SourceMysqlPool({ ...SRC, secretSource: "ANALYTICS_PW" }, resolved(""), null, h.create);
  await assert.rejects(p.getConnection(), (e) => e === err);
  assert.equal(h.made.length, 1);
});
t("mysql: 1045 + 값이 바뀜 → 새 값의 풀로 바꿔 한 번 더 · 옛 풀은 곧바로 닫지 않는다", async () => {
  const h = harness([{ conn: async () => { throw myAuth(); } }, { conn: async () => "conn-on-new" }]);
  let reads = 0;
  const p = new SourceMysqlPool(SRC, resolved("k1"), async () => { reads++; return resolved("k2"); }, h.create);
  assert.equal(await p.getConnection(), "conn-on-new");
  assert.equal(reads, 1);
  assert.equal(h.made.length, 2);
  assert.equal(h.made[1].opts.password, "pw-k2", "새 풀이 새 값으로 만들어지지 않았다");
  assert.equal(h.made[0].ended, false, "진행 중 질의가 있을 옛 풀을 곧바로 닫았다");
  await p.end();
  assert.equal(h.made[0].ended && h.made[1].ended, true, "end() 가 옛 풀까지 닫지 않았다");
});
t("mysql: 옛 풀은 유예(timeoutMs + 10초) 뒤 닫힌다", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = harness([{ conn: async () => { throw myAuth(); } }, {}]);
    const p = new SourceMysqlPool(SRC, resolved("k1"), async () => resolved("k2"), h.create);
    await p.getConnection();
    mock.timers.tick(SRC.timeoutMs + 10_000 - 1);
    assert.equal(h.made[0].ended, false, "유예가 끝나기 전에 닫았다");
    mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(h.made[0].ended, true, "유예가 끝났는데 닫지 않았다");
  } finally {
    mock.timers.reset();
  }
});
t("mysql: 1045 + 다시 읽은 값이 그대로 → 다시 붙지 않고 «값이 그대로» + errno", async () => {
  let tries = 0;
  const h = harness([{ conn: async () => { tries++; throw myAuth(); } }]);
  const p = new SourceMysqlPool(SRC, resolved("k1"), async () => resolved("k1"), h.create);
  await assert.rejects(p.getConnection(), (e: Error & { errno?: number }) => /값이 그대로/.test(e.message) && e.errno === 1045);
  assert.equal(h.made.length, 1, "값이 같은데 풀을 새로 만들었다");
  assert.equal(tries, 1, "값이 같은데 다시 붙었다");
});
t("mysql: 새 풀에서도 1045 → «또 실패»", async () => {
  const h = harness([{ conn: async () => { throw myAuth(); } }, { conn: async () => { throw myAuth(); } }]);
  const p = new SourceMysqlPool(SRC, resolved("k1"), async () => resolved("k2"), h.create);
  await assert.rejects(p.getConnection(), (e: Error) => /또 실패/.test(e.message));
  assert.equal(h.made.length, 2);
});
t("mysql: 동시에 실패한 요청 둘 → 다시 읽기는 한 번, 둘 다 새 풀에서 성공", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness([{ conn: async () => { await gate; throw myAuth(); } }, { conn: async () => "ok" }]);
  let reads = 0;
  const p = new SourceMysqlPool(SRC, resolved("k1"), async () => { reads++; return resolved("k2"); }, h.create);
  const both = Promise.all([p.getConnection(), p.getConnection()]);
  release();
  assert.deepEqual(await both, ["ok", "ok"]);
  assert.equal(reads, 1);
  assert.equal(h.made.length, 2);
});
t("mysql: query 길(catalog)도 같은 재시도", async () => {
  const h = harness([{ query: async () => { throw myAuth(); } }, { query: async () => [[{ table_name: "t" }], []] }]);
  const p = new SourceMysqlPool(SRC, resolved("k1"), async () => resolved("k2"), h.create);
  const [rows] = await p.query("SELECT 1", ["x"]);
  assert.deepEqual(rows, [{ table_name: "t" }]);
});
t("mysql: 인증 아닌 오류(1044) → 그대로, 다시 읽지 않는다", async () => {
  const e1044 = Object.assign(new Error("Access denied for user to database"), { code: "ER_DBACCESS_DENIED_ERROR", errno: 1044 });
  let reads = 0;
  const h = harness([{ conn: async () => { throw e1044; } }]);
  const p = new SourceMysqlPool(SRC, resolved("k1"), async () => { reads++; return resolved("k2"); }, h.create);
  await assert.rejects(p.getConnection(), (e) => e === e1044);
  assert.equal(reads, 0);
});
t("mysql: 다시 읽기가 실패하면 그 까닭을 낸다", async () => {
  const why = new DbSecretError("not_found", SRC.secretSource, "x").withSource("analytics");
  const h = harness([{ conn: async () => { throw myAuth(); } }]);
  const p = new SourceMysqlPool(SRC, resolved("k1"), async () => { throw why; }, h.create);
  await assert.rejects(p.getConnection(), (e) => e === why);
});

for (const [name, fn] of tests) {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
}
console.log(`\n${pass} passed`);
