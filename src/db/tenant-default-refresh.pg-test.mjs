// 기본값 따라잡기(`refreshTenantDefault`) — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/db/tenant-default-refresh.pg-test.mjs
//  ⚠ 이 파일은 `refreshTenantDefault()` 를 부른다 — 즉 **마이그레이션을 실행한다**(자기가 만든 표만이
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
//  워크스페이스가 설치한 앱의 표는 `app` 이 아니라 `app_<테넌트 hex32>` 에 산다(#4224, apps/store-ddl.ts appSchemaName).
//  «app 스키마» 를 한 이름으로 적으면 이쪽이 통째로 빠진다 — 위 머리말의 사고와 같은 모양이다.
const WS_SCHEMA = "app_00000000000000000000000000dead01", WS = "__tdr_stale_ws";
//  앱 id 는 숫자로 시작할 수 있다(`3d-view` → `3d_view__x`, apps/store-ddl.ts). 그런 표 하나가 이름 검사에 걸려
//  던지면 따라잡기가 아니라 **부팅 전체**가 죽는다(실측) — 인용해서 그대로 고쳐야 한다.
const DIGIT = "3d__tdr_stale_digit";
//  앱 스키마 이름 규칙에 **안 맞는** 스키마 — 코어 소유가 아니므로 옛 식이어도 건드리면 안 된다(선별이 넘치지 않는가).
const FOREIGN_SCHEMA = "__tdr_foreign", FOREIGN = "__tdr_stale_foreign";
const OLD = `COALESCE(current_setting('app.tenant_id', true), '${SINGLE_TENANT_ID}')::uuid`;
//  바깥 정책 계층이 걸어 둔 모양(missing_ok 없음) — 코어가 덮어쓰면 그 배포의 fail-closed 계약이 깨진다.
const OUTER_STRICT = `current_setting('app.tenant_id')::uuid`;

const defaultOf = async (rel) => (await itemsPool.query(
  `SELECT pg_get_expr(d.adbin, d.adrelid) AS e
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = $1::regclass AND a.attname = 'tenant_id'`, [rel])).rows[0]?.e ?? null;

const drop = async () => {
  for (const rel of [`public.${PUB}`, `public.${FINE}`, `public.${STRICT}`, `app.${APP}`, `app."${DIGIT}"`]) {
    await itemsPool.query(`DROP TABLE IF EXISTS ${rel}`);
  }
  //  이 두 스키마는 이 파일이 만든 것이다 — 통째로 지운다.
  for (const sch of [WS_SCHEMA, FOREIGN_SCHEMA]) await itemsPool.query(`DROP SCHEMA IF EXISTS ${sch} CASCADE`);
};

try {
  await itemsPool.query(`CREATE SCHEMA IF NOT EXISTS app`);
  await drop();
  await itemsPool.query(`CREATE TABLE public.${PUB}(id int, tenant_id uuid NOT NULL DEFAULT ${OLD})`);
  await itemsPool.query(`CREATE TABLE app.${APP}(id int, tenant_id uuid NOT NULL DEFAULT ${OLD})`);
  await itemsPool.query(`CREATE TABLE app."${DIGIT}"(id int, tenant_id uuid NOT NULL DEFAULT ${OLD})`);
  await itemsPool.query(`CREATE SCHEMA ${WS_SCHEMA}`);
  await itemsPool.query(`CREATE TABLE ${WS_SCHEMA}.${WS}(id int, tenant_id uuid NOT NULL DEFAULT ${OLD})`);
  await itemsPool.query(`CREATE SCHEMA ${FOREIGN_SCHEMA}`);
  await itemsPool.query(`CREATE TABLE ${FOREIGN_SCHEMA}.${FOREIGN}(id int, tenant_id uuid NOT NULL DEFAULT ${OLD})`);
  await itemsPool.query(`CREATE TABLE public.${STRICT}(id int, tenant_id uuid NOT NULL DEFAULT ${OUTER_STRICT})`);
  await itemsPool.query(`CREATE TABLE public.${FINE}(id int, tenant_id uuid NOT NULL DEFAULT ${TENANT_DEFAULT_EXPR})`);
  const strictBefore = await defaultOf(`public.${STRICT}`);

  //  이름 하나에 던지면 여기서 예외로 끝난다 — 그 자체가 «부팅이 죽는다» 의 재현이다.
  const r1 = await refreshTenantDefault();
  const got = r1.refreshed.filter((t) => t.includes("__tdr_")).sort();

  // ① 옛 식을 가진 표는 고친다 — **스키마를 건너서도**. 이게 빠지면 앱 데이터 표가 영영 안 고쳐진다.
  chk("① 옛 기본값 표를 고친다 — public · 공유 app(숫자로 시작하는 이름 포함) · 워크스페이스별 app_<hex> 모두",
    got.join(",") === `app.${DIGIT},app.${APP},${WS_SCHEMA}.${WS},public.${PUB}`, `고친 표: ${got.join(", ") || "(없음)"}`);
  //  «바뀌었다» 의 기준을 문자열로 적지 않는다 — 식이 또 바뀌면 그 복제가 기능과 무관한 이유로 깨진다.
  //  기준은 바로 옆에 있다: 현행 식으로 만든 FINE 표를 같은 PG 가 렌더한 결과와 **완전 일치**해야 한다.
  const want = await defaultOf(`public.${FINE}`);
  chk("① public 표의 기본값이 현행 식과 같아졌다", await defaultOf(`public.${PUB}`) === want, `${await defaultOf(`public.${PUB}`)} ≠ ${want}`);
  chk("① app 표의 기본값이 현행 식과 같아졌다", await defaultOf(`app.${APP}`) === want, `${await defaultOf(`app.${APP}`)} ≠ ${want}`);
  chk("① 워크스페이스별 앱 스키마 표의 기본값도 현행 식과 같아졌다",
    await defaultOf(`${WS_SCHEMA}.${WS}`) === want, `${await defaultOf(`${WS_SCHEMA}.${WS}`)} ≠ ${want}`);
  chk("① 앱 스키마 규칙에 안 맞는 스키마의 표는 옛 식이어도 건드리지 않는다",
    await defaultOf(`${FOREIGN_SCHEMA}.${FOREIGN}`) !== want, "코어 소유가 아닌 스키마의 기본값을 바꿨다");

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
