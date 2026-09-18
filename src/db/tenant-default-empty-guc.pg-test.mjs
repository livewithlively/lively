// 테넌트 기본값 식이 «관대해야 하는 자리» 를 실제로 지키는가 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/db/tenant-default-empty-guc.pg-test.mjs
//
// 왜 이 계층인가: 이 절의 판정은 전부 **Postgres 가 GUC 를 어떻게 돌려주나** 에 달려 있다.
//  `current_setting('app.tenant_id', true)` 는 «미설정이면 NULL» 로 읽히지만, 한 번이라도 설정했다가
//  치운 뒤에는 NULL 이 아니라 **빈 문자열**을 돌려준다 — 커스텀 GUC 의 reset 값이 '' 이기 때문이다.
//  `set_config(...,'')` 도 `RESET` 도 그 자리로 보낸다(미설정으로는 되돌릴 수 없다).
//  그러면 `COALESCE(…, '<상수>')` 가 NULL 을 못 봐서 폴백하지 못하고 `''::uuid` 로 죽는다.
//  이건 SQL 문자열을 읽어서는 보이지 않는다 — 실제로 GUC 를 그 상태로 만들고 INSERT 해야 드러난다.
//
//  그 '' 를 만드는 것은 우리 코드다: src/db/client.ts 의 release 훅이 커넥션을 반납하기 전에
//  `set_config('app.tenant_id','',false)` 를 건다(다음 차용자가 남의 테넌트를 물려받지 않게 — 정책
//  입장에선 fail-closed 가 맞다). 그 뒤 그 커넥션을 빌린 쪽이 컨텍스트 없이 기본값 경로를 타면 죽는다.
//
//  판정 대상은 **기본값 식 하나**(TENANT_DEFAULT_EXPR)다. 그 식이 심기는 자리는 tenant_id 를 가진 표
//  전부의 컬럼 DEFAULT 와 여러 런타임 쿼리인데(개수는 ensureTenantColumn 이 카탈로그로 정한다),
//  여기서는 식 자체를 임시 표에 걸어 세 상태를 직접 본다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { TENANT_DEFAULT_EXPR, SINGLE_TENANT_ID } = await import(`${DIST}/db/tenant-column.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const T = "__tenant_default_empty_guc__";
const OTHER = "11111111-2222-3333-4444-555555555555";

// 커넥션 하나를 잡고 끝까지 쓴다 — GUC 는 **세션** 상태라 풀에서 다른 커넥션을 받으면 관측 대상이 달라진다.
const c = await itemsPool.connect();
try {
  await c.query(`DROP TABLE IF EXISTS ${T}`);
  await c.query(`CREATE TABLE ${T}(id int primary key, tenant_id uuid NOT NULL DEFAULT ${TENANT_DEFAULT_EXPR})`);
  const tenantOf = async (id) => (await c.query(`SELECT tenant_id::text AS t FROM ${T} WHERE id=$1`, [id])).rows[0]?.t;
  const insert = async (id) => {
    try { await c.query(`INSERT INTO ${T}(id) VALUES($1)`, [id]); return null; }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  };

  // ① 컨텍스트가 **한 번도 없었던** 세션 — 자가호스팅의 정상 경로.
  chk("① 컨텍스트가 없으면 단일테넌트 상수로 떨어진다", await insert(1) === null, "INSERT 가 죽었다");
  chk("① 그 값이 단일테넌트 상수다", await tenantOf(1) === SINGLE_TENANT_ID, await tenantOf(1));

  // ② 컨텍스트가 있으면 그 값 — NULLIF 를 끼워도 이 경로가 바뀌면 안 된다(회귀 가드).
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [OTHER]);
  chk("② 컨텍스트가 있으면 그 값을 따른다", await insert(2) === null, "INSERT 가 죽었다");
  chk("② 그 값이 설정한 테넌트다", await tenantOf(2) === OTHER, await tenantOf(2));

  // ③ 🔴 컨텍스트를 **치운 뒤** — release 훅이 커넥션을 반납할 때 남기는 바로 그 상태.
  //    여기서 죽으면 그 커넥션을 물려받은 다음 요청이 «컨텍스트가 없다» 가 아니라 «uuid 구문 오류» 로 죽는다.
  await c.query(`SELECT set_config('app.tenant_id', '', false)`);
  const err = await insert(3);
  chk("③ 컨텍스트를 치운 뒤에도 단일테넌트 상수로 떨어진다", err === null,
    `INSERT 가 죽었다: ${err} — 기본값 식이 빈 문자열을 폴백하지 못한다`);
  //  ③ 이 죽었으면 값을 볼 행 자체가 없다 — 통과로 찍지 않는다(공허한 ok 는 초록을 거짓말하게 만든다).
  if (err === null) chk("③ 그 값이 단일테넌트 상수다", await tenantOf(3) === SINGLE_TENANT_ID, await tenantOf(3));

  // ④ `RESET` 도 같은 자리다 — «치우는 다른 방법» 이 있다고 오해하지 않게 못박는다.
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [OTHER]);
  await c.query(`RESET app.tenant_id`);
  const err4 = await insert(4);
  chk("④ RESET 으로 치워도 마찬가지다(미설정으로 돌아가지 않는다)", err4 === null,
    `INSERT 가 죽었다: ${err4} — RESET 도 빈 문자열을 남긴다`);

  await c.query(`DROP TABLE IF EXISTS ${T}`);
} finally {
  // 이 커넥션은 풀에 돌려보내지 않고 파기한다. 우리가 raw `set_config` 로 GUC 를 건드렸을 뿐이라
  //  src/db/client.ts 의 반납 초기화 훅이 **안 돈다**(그 훅은 sessionBound 일 때만 걸린다) — 즉
  //  이 커넥션의 오염은 아무도 치워 주지 않는다.
  c.release(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
await itemsPool.end();
process.exit(fail ? 1 : 0);
