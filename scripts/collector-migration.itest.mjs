// 레거시 커넥터 → 수집기 마이그레이션 통합검증(#1419 T1) — 버릴 pg 컨테이너에 **실제 DDL** 을 올려 검증한다.
//  ⚠ **수동 실행**(docker 필요) — npm test CI 체인엔 DB 가 없다.
//  실행:  cd <repo> && npm run build && node scripts/collector-migration.itest.mjs   (라이브 DB 무접촉)
//
//  왜 이 테스트가 필요했나 — **가장 중요한 경로가 한 번도 실행된 적이 없었다.**
//   migrateConnectorsToCollectors 는 고객 박스가 부팅할 때마다 돌면서 구 크론(sync-<system>)을 **끄고**
//   새 크론(collector-<id>)을 등록한다. 그런데 릴리스 직전 점검에서 이 함수의 테스트가 0건이었고,
//   dev 박스의 유일한 커넥터는 꺼져 있어서 확인된 건 'enabled=false' 경로뿐이었다.
//   진짜 위험한 건 반대쪽이다: **돌고 있던 수집이 승계 후에도 계속 도는가.**
//   틀리면 구 크론은 꺼졌는데 새 크론이 없거나 파라미터가 틀린 상태가 되고, 이건 **조용하다** —
//   에러도 안 나고 아무도 모르는 채로 자료가 낡는다.
//
//  왜 실 DB 여야 하나: 검증 대상이 전부 SQL 안에 있다 — org_cron 의 action CHECK 제약(허용목록 밖 값이면
//   INSERT 자체가 실패), (preset_key, instance_key) 유니크(멱등의 근거), 구 잡의 interval 승계 SELECT.
//   그리고 **실제 DDL** 로 세워야 한다: 최소 스키마를 손으로 만들면 NOT NULL·CHECK 가 빠져 테스트는
//   통과하면서 프로덕션만 깨진다(그게 이 테스트가 막으려는 사고와 같은 부류다).
//  사양 엣지 표: C1~C7 (아래 각 케이스 주석)
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59473;
const CNAME = "co-collector-migration-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();

try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw",
  "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ }
    execSync("sleep 0.5");
  }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initConnectorRegistry, initCollectorRegistry, initCollectorPresets } =
    await import("../dist/org/schema/connectors-ingest.js");
  const { initSessionsInfra } = await import("../dist/org/schema/sessions-infra.js");
  const { migrateConnectorsToCollectors } = await import("../dist/org/store/collectors.js");

  await initConnectorRegistry(itemsPool);   // org_connector(레거시 원본)
  await initSessionsInfra(itemsPool);       // org_cron — **실제 DDL**(action CHECK 제약 포함)
  await initCollectorRegistry(itemsPool);   // org_collector
  await initCollectorPresets(itemsPool);
  ok("스키마 생성 (실제 DDL)");

  const cron = async (id) => (await itemsPool.query(
    `SELECT id, action, params, interval_sec, enabled FROM org_cron WHERE id=$1`, [id])).rows[0] ?? null;
  const collectorOf = async (preset) => (await itemsPool.query(
    `SELECT * FROM org_collector WHERE preset_key=$1`, [preset])).rows[0] ?? null;

  // ══ C1. org_connector 가 비어 있으면 옮길 게 없다 ══
  //  신규 설치가 이 경로를 탄다 — 여기서 예외가 나면 게이트웨이가 부팅 중에 죽는다(하우스키핑 스텝).
  {
    const r = await migrateConnectorsToCollectors("itest");
    assert.deepEqual(r.migrated, []);
    assert.equal((await itemsPool.query(`SELECT count(*)::int n FROM org_collector`)).rows[0].n, 0);
    ok("C1 빈 org_connector — migrated 0, 예외 없음");
  }

  // ══ C2. **켜져 있던 커넥터가 승계 후에도 계속 돈다** (이 테스트의 핵심) ══
  //  notion 을 쓰는 이유: 본 잡 + 일일 full 스윕 두 개를 만드는 유일한 프리셋이라 분기가 가장 넓다.
  await itemsPool.query(
    `INSERT INTO org_connector(system, enabled, config, secrets, note)
       VALUES('notion', true, '{"root_page_id":"p-abc"}'::jsonb, '{"token":"sec-xyz"}'::jsonb, '운영 메모')`);
  // 구 잡 — 주기를 기본값(600)과 다르게 둔다. 승계가 '그냥 기본값을 쓴 것'과 구별되게 하려고.
  await itemsPool.query(
    `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled)
       VALUES('sync-notion','구 노션 싱크','connector_sync','{"system":"notion"}'::jsonb, 900, true),
             ('sync-notion-full','구 노션 전체','connector_sync','{"system":"notion","full":true}'::jsonb, 86400, true)`);
  {
    const r = await migrateConnectorsToCollectors("itest");
    assert.deepEqual(r.migrated, ["notion"]);

    const c = await collectorOf("notion");
    assert.ok(c, "수집기가 안 만들어졌다");
    assert.equal(c.enabled, true, "켜진 커넥터가 꺼진 수집기로 승계됐다 — 수집이 멈춘다");
    assert.equal(c.instance_key, "_", "커서 네임스페이스가 '_' 가 아니면 전 자료를 처음부터 다시 훑는다");
    assert.equal(c.sync_interval_sec, 900, "구 잡의 주기를 승계하지 않았다");
    assert.equal(c.output_mode, "preset", "산출정책 기본값이 preset 이 아니면 기존 동작이 바뀐다");
    // 설정·자격 승계 — 빠지면 승계된 수집기가 인증에 실패한다(그리고 그건 다음 주기에나 드러난다).
    assert.equal(c.config.root_page_id, "p-abc");
    assert.equal(c.secrets.token, "sec-xyz");
    assert.equal(c.note, "운영 메모");
    ok("C2 켜진 커넥터 → 켜진 수집기 (커서키 '_' · 주기 900 승계 · config/secrets/note 승계)");

    // 새 잡이 **실제로 등록됐나** — 이게 없으면 구 잡만 꺼진 상태가 되고 수집이 조용히 멈춘다.
    const j = await cron(`collector-${c.id}`);
    assert.ok(j, `collector-${c.id} 잡이 없다 — 구 잡은 꺼졌는데 대체가 없다(수집 중단)`);
    assert.equal(j.enabled, true);
    assert.equal(j.action, "connector_sync");
    assert.equal(Number(j.params.collector_id), Number(c.id),
      "params 가 collector_id 로 안 넘어갔다 — 스케줄러가 어느 수집기인지 모른다");
    assert.equal(j.interval_sec, 900);
    ok("C2 새 잡 collector-<id> 등록 (enabled · params.collector_id · 주기 승계)");

    // notion 전용 일일 full 스윕 — 증분이 구조적으로 못 보는 것들(아카이브 전파 등)의 수렴 경로.
    const jf = await cron(`collector-${c.id}-full`);
    assert.ok(jf, "notion 인데 일일 full 스윕 잡이 없다 — 아카이브·완결성 수렴 경로가 사라진다");
    assert.equal(jf.enabled, true);
    assert.equal(jf.params.full, true);
    assert.equal(jf.interval_sec, 86400);
    ok("C2 notion 일일 full 스윕 잡도 등록 (full=true · 86400)");

    // 구 잡은 꺼진다 — 둘 다 켜져 있으면 같은 소스를 두 번 긁는다.
    assert.equal((await cron("sync-notion")).enabled, false);
    assert.equal((await cron("sync-notion-full")).enabled, false);
    ok("C2 구 잡 sync-notion / -full 둘 다 꺼짐 (이중 수집 방지)");

    // 원본 보존 — 구 코드로 롤백해도 그대로 돌아야 한다(무중단 계약 ③).
    const legacy = (await itemsPool.query(`SELECT enabled FROM org_connector WHERE system='notion'`)).rows[0];
    assert.ok(legacy, "org_connector 행이 사라졌다 — 롤백 경로가 끊긴다");
    assert.equal(legacy.enabled, true, "원본 행의 enabled 를 건드렸다");
    ok("C2 org_connector 원본 보존 (롤백 가능)");
  }

  // ══ C3. 꺼져 있던 커넥터는 꺼진 수집기 + **잡을 만들지 않는다** ══
  //  dev 박스에서 확인한 경로. 잡을 만들면 사람이 끈 수집이 되살아난다.
  await itemsPool.query(
    `INSERT INTO org_connector(system, enabled, config, secrets)
       VALUES('slack', false, '{}'::jsonb, '{}'::jsonb)`);
  {
    const r = await migrateConnectorsToCollectors("itest");
    assert.deepEqual(r.migrated, ["slack"], "이미 옮긴 notion 이 다시 잡혔다(멱등 깨짐)");
    const c = await collectorOf("slack");
    assert.equal(c.enabled, false);
    assert.equal(c.sync_interval_sec, 600, "구 잡이 없으면 기본 600 이어야 한다");
    assert.equal(await cron(`collector-${c.id}`), null,
      "꺼진 수집기에 잡을 만들었다 — 사람이 끈 수집이 되살아난다");
    ok("C3 꺼진 커넥터 → 꺼진 수집기 · 잡 없음 · 주기 기본 600 (C5 포함)");
  }

  // ══ C4. 멱등 — 재실행이 아무것도 바꾸지 않는다 ══
  //  부팅마다 도는 함수다. 두 번째 실행이 행을 늘리거나 사람이 끈 것을 켜면 매 재시작마다 사고가 난다.
  {
    const before = (await itemsPool.query(
      `SELECT id, enabled, sync_interval_sec FROM org_collector ORDER BY id`)).rows;
    const cronBefore = (await itemsPool.query(
      `SELECT id, enabled, params, interval_sec FROM org_cron ORDER BY id`)).rows;

    const r = await migrateConnectorsToCollectors("itest");
    assert.deepEqual(r.migrated, [], "재실행이 다시 옮겼다");

    assert.deepEqual((await itemsPool.query(
      `SELECT id, enabled, sync_interval_sec FROM org_collector ORDER BY id`)).rows, before,
      "재실행이 수집기 행을 바꿨다");
    assert.deepEqual((await itemsPool.query(
      `SELECT id, enabled, params, interval_sec FROM org_cron ORDER BY id`)).rows, cronBefore,
      "재실행이 크론을 바꿨다");
    ok("C4 멱등 — 재실행 후 수집기·크론 전부 동일");
  }

  // ══ C6. 코드에서 사라진 커넥터의 잔존 행은 되살리지 않는다 ══
  //  CONNECTOR_SPECS 에 없으면 수집 코드가 없다 — 수집기를 만들면 '설정은 있는데 아무것도 안 하는' 행이 된다.
  await itemsPool.query(
    `INSERT INTO org_connector(system, enabled, config, secrets) VALUES('사라진커넥터', true, '{}'::jsonb, '{}'::jsonb)`);
  {
    const r = await migrateConnectorsToCollectors("itest");
    assert.deepEqual(r.migrated, []);
    assert.equal(await collectorOf("사라진커넥터"), null, "코드에 없는 커넥터를 수집기로 되살렸다");
    ok("C6 CONNECTOR_SPECS 밖 잔존 행 — 건너뜀");
  }

  // ══ C7. 등록된 잡의 action 이 허용목록을 통과한다(제약이 실제로 켜져 있는지) ══
  //  이 단언이 있는 이유: 위 C2 가 통과했다는 건 곧 CHECK 를 통과했다는 뜻인데, 제약이 **아예 없어도**
  //  통과한다. 제약의 존재 자체를 확인해야 '허용목록을 지켰다'는 증명이 성립한다.
  {
    const def = (await itemsPool.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='org_cron_action_chk'`)).rows[0];
    assert.ok(def, "org_cron_action_chk 제약이 없다 — 임의 action 이 저장된다(보안 경계 상실)");
    assert.ok(def.d.includes("connector_sync"), "connector_sync 가 허용목록에 없다");
    assert.ok(def.d.includes("run_managers"),
      "run_managers 가 허용목록에 없다 — 관리기를 크론에 등록할 수 없다(#1419 T5)");
    ok("C7 org_cron action CHECK 제약 존재 + connector_sync·run_managers 포함");
  }

  console.log(`\n${pass} passed`);
  // ⚠ 컨테이너를 지우기 **전에** 풀을 닫는다 — 안 닫으면 살아 있는 커넥션이 사라진 서버를 물고
  //  'Connection terminated unexpectedly' 로 종료코드가 1 이 된다(단언은 전부 통과했는데 실패로 보인다).
  await itemsPool.end();
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
