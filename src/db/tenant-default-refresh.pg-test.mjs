// 기본값 따라잡기(`refreshTenantDefault`) — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/db/tenant-default-refresh.pg-test.mjs
//  ⚠ 이 파일은 `refreshTenantDefault()` 를 부른다 — 즉 **마이그레이션을 실행한다**(자기가 만든 네 표만이
//   아니라 그 DB 의 옛 식 표 전부에 ALTER 가 나간다). 붙는 DB 를 보고 돌려라.
//
// 왜 이 계층인가: 이 함수의 판정은 전부 **카탈로그가 기본값을 어떻게 렌더하나** 에 걸려 있다.
//  대상 선별이 `pg_get_expr()` 결과에 대한 문자열 매치라, 소스를 읽어서는 무엇이 잡히고 무엇이
//  안 잡히는지 알 수 없다. 게다가 **실패 방향이 조용하다** — 못 잡으면 오류가 아니라 «0표» 로
//  끝나고 부팅 로그는 정상으로 보인다. 그래서 세 갈래를 실제 표로 깔고 부작용을 되읽어 판정한다.
//
//  실제로 그 사고가 났다: 선별 조회가 `public` 스키마로 고정돼 있어 앱 데이터 표(`app.<물리명>`,
//  apps/store-schema.ts)가 통째로 빠졌는데, 로그는 «0표» 라 고쳐진 것처럼 보였다. 코드 읽기로만
//  잡혔고 어떤 테스트도 울지 않았다 — 그 자리를 이 파일이 메운다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { TENANT_DEFAULT_EXPR, SINGLE_TENANT_ID, refreshTenantDefault } = await import(`${DIST}/db/tenant-column.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

//  이름은 이 파일 전용 접두사로 — 같은 DB 를 쓰는 다른 pg-test 와 섞이지 않게.
const PUB = "__tdr_stale_pub", FINE = "__tdr_fine", STRICT = "__tdr_strict", APP = "__tdr_stale_app";
const OLD = `COALESCE(current_setting('app.tenant_id', true), '${SINGLE_TENANT_ID}')::uuid`;
//  바깥 정책 계층이 걸어 둔 모양(missing_ok 없음) — 코어가 덮어쓰면 그 배포의 fail-closed 계약이 깨진다.
const OUTER_STRICT = `current_setting('app.tenant_id')::uuid`;

const defaultOf = async (rel) => (await itemsPool.query(
  `SELECT pg_get_expr(d.adbin, d.adrelid) AS e
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = $1::regclass AND a.attname = 'tenant_id'`, [rel])).rows[0]?.e ?? null;

const drop = async () => {
  for (const rel of [`public.${PUB}`, `public.${FINE}`, `public.${STRICT}`, `app.${APP}`]) {
    await itemsPool.query(`DROP TABLE IF EXISTS ${rel}`);
  }
};

try {
  await itemsPool.query(`CREATE SCHEMA IF NOT EXISTS app`);
  await drop();
  await itemsPool.query(`CREATE TABLE public.${PUB}(id int, tenant_id uuid NOT NULL DEFAULT ${OLD})`);
  await itemsPool.query(`CREATE TABLE app.${APP}(id int, tenant_id uuid NOT NULL DEFAULT ${OLD})`);
  await itemsPool.query(`CREATE TABLE public.${STRICT}(id int, tenant_id uuid NOT NULL DEFAULT ${OUTER_STRICT})`);
  await itemsPool.query(`CREATE TABLE public.${FINE}(id int, tenant_id uuid NOT NULL DEFAULT ${TENANT_DEFAULT_EXPR})`);
  const strictBefore = await defaultOf(`public.${STRICT}`);

  const r1 = await refreshTenantDefault();
  const got = r1.refreshed.filter((t) => t.includes("__tdr_")).sort();

  // ① 옛 식을 가진 표는 고친다 — **스키마를 건너서도**. 이게 빠지면 앱 데이터 표가 영영 안 고쳐진다.
  chk("① 옛 기본값 표를 고친다 — public 과 app 둘 다",
    got.join(",") === `app.${APP},public.${PUB}`, `고친 표: ${got.join(", ") || "(없음)"}`);
  //  «바뀌었다» 의 기준을 문자열로 적지 않는다 — 식이 또 바뀌면 그 복제가 기능과 무관한 이유로 깨진다.
  //  기준은 바로 옆에 있다: 현행 식으로 만든 FINE 표를 같은 PG 가 렌더한 결과와 **완전 일치**해야 한다.
  const want = await defaultOf(`public.${FINE}`);
  chk("① public 표의 기본값이 현행 식과 같아졌다", await defaultOf(`public.${PUB}`) === want, `${await defaultOf(`public.${PUB}`)} ≠ ${want}`);
  chk("① app 표의 기본값이 현행 식과 같아졌다", await defaultOf(`app.${APP}`) === want, `${await defaultOf(`app.${APP}`)} ≠ ${want}`);

  // ② 남의 것은 건드리지 않는다 — 바깥 정책 계층의 strict 기본값은 일부러 엄격한 것이다.
  chk("② 바깥 계층의 strict 기본값은 그대로 둔다",
    await defaultOf(`public.${STRICT}`) === strictBefore, `${strictBefore} → ${await defaultOf(`public.${STRICT}`)}`);

  // ③ 이미 맞는 표는 대상이 아니다 — 매 부팅 ACCESS EXCLUSIVE 를 잡을 이유가 없다.
  chk("③ 이미 지금 식인 표는 고치지 않는다", !got.includes(`public.${FINE}`), `대상에 들어갔다: ${got.join(", ")}`);

  // ④ 멱등 — 두 번째 부팅은 아무 것도 하지 않는다.
  const r2 = await refreshTenantDefault();
  const again = r2.refreshed.filter((t) => t.includes("__tdr_"));
  chk("④ 두 번째 실행은 무동작이다", again.length === 0, `또 고쳤다: ${again.join(", ")}`);

  await drop();
} finally {
  await itemsPool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
