// DB 주소가 없으면 **소켓을 열지 않는다** (#2457) — 유닛 계층이 그 기계의 5432 상태에 시간을 의존하던 것.
//
// 실측 2026-08-31: `client.ts` 가 모듈 최상위에서 만드는 풀은 connectionString 이 비면 pg 가 libpq
//  기본값(localhost:5432)으로 붙는다. 그래서 같은 6개 유닛 테스트가 맥(5432 닫힘)에선 합계 1.8초,
//  CI(services.postgres 가 5432에 살아 있음)에선 363초였다 — CI 유닛 CPU 604초의 60%.
//  판정은 양쪽 다 fail-open 이라 같았고 바뀐 건 '기다렸다'뿐이다.
//
// 사양·엣지표: E1~E3(주소 없음의 세 표기) · E4(주소 있음 = 무회귀 배선) · E5(이유) · E6(connect) · E7(endPool) · E8(목 보호).
//  ⚠ E4 가 배선 단언이다 — 그게 없으면 "전부 막는" 구현도 E1~E3 만으로 통과한다(vacuous).
//
// 실행: npm run build && node dist/db/no-db-socket.test.js
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = JSON.stringify(pathToFileURL(path.join(HERE, "client.js")).href);

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 응답하지 않는 소켓 — CI 의 '5432 가 살아 있다' 를 **5432 를 건드리지 않고** 재현한다.
//  listen(0) 이라 병렬 실행에서도 포트가 겹치지 않는다(러너 관례).
const server = net.createServer(() => { /* accept 만 하고 아무 응답도 하지 않는다 */ });
await new Promise<void>((r) => { server.listen(0, "127.0.0.1", r); });
const port = (server.address() as net.AddressInfo).port;

type Probe = { status: number | null; signal: string | null; out: string };

/**
 * 자식에서 itemsPool 을 실제로 두드린다. PGHOST/PGPORT 로 pg 의 **기본 접속지**를 죽은 소켓에 겨눈다
 * (ITEMS_DATABASE_URL 이 없을 때 pg 가 어디로 가는지가 이 결함의 핵심이라, 그 경로를 그대로 재현한다).
 * 가드가 없으면 여기서 매달려 timeout → SIGKILL 이 뜬다. 그게 red 신호다.
 */
const probe = (body: string, env: Record<string, string | undefined>): Probe => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    encoding: "utf8",
    timeout: 8000,
    killSignal: "SIGKILL",
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(port), PGCONNECT_TIMEOUT: "60", ...env },
  });
  return { status: r.status, signal: r.signal, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const QUERY = `import { itemsPool } from ${CLIENT}; await itemsPool.query("select 1");`;
const CONNECT = `import { itemsPool } from ${CLIENT}; await itemsPool.connect();`;
const END = `import { endPool } from ${CLIENT}; await endPool(); console.log("ENDED");`;
const head = (r: Probe): string => `\n--- 자식 출력 ---\n${r.out.slice(0, 500)}`;

/** 주소가 없을 때의 공통 기대: 매달리지 않고(=SIGKILL 없음) 실패한다. */
const expectFastFail = (label: string, r: Probe): void => {
  assert.equal(r.signal, null, `${label}: 죽은 소켓에 매달려 강제종료됐다 — 접속을 시도했다는 뜻이다${head(r)}`);
  assert.notEqual(r.status, 0, `${label}: DB 가 없는데 성공했다${head(r)}`);
};

// E1 — 개발자 맥과 CI 유닛 스텝의 실제 상태(env 자체가 없음).
t("E1 주소가 없으면(undefined) query 가 즉시 실패한다", () => {
  expectFastFail("E1", probe(QUERY, { ITEMS_DATABASE_URL: undefined }));
});

// E2·E3 — 경계. 셸에서 `export ITEMS_DATABASE_URL=` 하면 빈 문자열이 온다.
t("E2 빈 문자열도 '주소 없음'으로 본다", () => {
  expectFastFail("E2", probe(QUERY, { ITEMS_DATABASE_URL: "" }));
});
t("E3 공백뿐인 값도 '주소 없음'으로 본다", () => {
  expectFastFail("E3", probe(QUERY, { ITEMS_DATABASE_URL: "   " }));
});

// E4 ★ 배선 단언 — 주소가 있으면 **종전대로 접속을 시도한다**. 죽은 소켓을 향하므로 매달리는 게 정상이고,
//   여기서 즉시 끝나면 가드가 정상 경로까지 삼킨 것이다. 이 행이 없으면 "전부 막는" 구현도 통과한다.
t("E4 주소가 있으면 종전대로 접속을 시도한다(가드가 정상 경로를 삼키지 않는다)", () => {
  const r = probe(QUERY, { ITEMS_DATABASE_URL: `postgres://u:p@127.0.0.1:${port}/db` });
  assert.equal(r.signal, "SIGKILL", `접속을 시도하지 않았다 — 가드가 너무 넓다${head(r)}`);
});

// E5 — 실패가 조용하거나 엉뚱한 이유로 위장하면 다음 사람이 DB 장애로 오진한다.
t("E5 실패 이유가 'ITEMS_DATABASE_URL 이 없다'라고 말한다", () => {
  const r = probe(QUERY, { ITEMS_DATABASE_URL: undefined });
  assert.match(r.out, /ITEMS_DATABASE_URL/, `이유에 env 이름이 없다${head(r)}`);
});

// E6 — withTx() 가 쓰는 경로. query 만 막고 connect 를 두면 트랜잭션 경로로 그대로 샌다.
t("E6 connect() 도 같게 막힌다(withTx 경로)", () => {
  expectFastFail("E6", probe(CONNECT, { ITEMS_DATABASE_URL: undefined }));
});

// E7 — 풀을 닫는 건 접속이 아니다. 여기까지 막으면 CLI 종료 경로(domainmap/cli.ts)가 깨진다.
t("E7 endPool() 은 주소가 없어도 성공한다(CLI 종료 경로 무회귀)", () => {
  const r = probe(END, { ITEMS_DATABASE_URL: undefined });
  assert.equal(r.signal, null, `endPool 이 매달렸다${head(r)}`);
  assert.equal(r.status, 0, `endPool 이 실패했다 — 가드가 접속이 아닌 경로까지 막았다${head(r)}`);
  assert.match(r.out, /ENDED/, `endPool 이 끝까지 가지 않았다${head(r)}`);
});

// E8 — 가드가 **테스트의 목을 가로채면 안 된다.** 여러 유닛이 `itemsPool.query = fake` 로 얇은 Db 페이크를
//   심는다(v6/project-store · domainmap/core/reconcile). 목은 소켓을 안 여니 막을 이유가 없고, 가로채면
//   그 테스트들이 통째로 깨진다 — 실제로 이 가드의 첫 판이 그렇게 깨뜨렸다(이 행이 그때 없던 엣지다).
t("E8 목이 걸린 query 는 가로채지 않는다(유닛의 Db 페이크 보호)", () => {
  const body = `import { itemsPool } from ${CLIENT};
    itemsPool.query = async () => ({ rows: [{ ok: 1 }] });
    const r = await itemsPool.query("select 1");
    if (r.rows[0].ok !== 1) { console.error("목이 안 불렸다"); process.exit(3); }
    console.log("MOCKED");`;
  const r = probe(body, { ITEMS_DATABASE_URL: undefined });
  assert.equal(r.signal, null, `목 경로가 매달렸다${head(r)}`);
  assert.equal(r.status, 0, `가드가 목을 가로챘다${head(r)}`);
  assert.match(r.out, /MOCKED/, `목이 실행되지 않았다${head(r)}`);
});

server.close();
console.log(`\nno-db-socket tests: ${pass} passed`);
