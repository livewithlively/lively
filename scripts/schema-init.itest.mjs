// 스키마 부팅 무결성 통합검증 — 빈 pg 에 전체 스키마 체인(item→org→domainmap→v6)을 순서대로 올려 **완주**하는지 본다.
//  ⚠ 수동 실행(docker). 실행:  node scripts/schema-init.itest.mjs
//  왜: 시드 한 줄이 제약(NOT NULL/CHECK/FK)을 어기면 그 init 이 throw 하고 **뒤따르는 모든 마이그레이션이 안 돈다**
//   (2026-07-20 실사고: org_cron push-wiki-notion params=NULL → initOrgSchema 중단 → initV6Schema 의 session.title
//    ALTER 미실행 → 웹뷰 500). 이 테스트가 그 계열 회귀를 부팅 전에 잡는다.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59460, CNAME = "co-schema-init-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { initItemSchema, itemsPool } = await import("../dist/items/store.js");
  const { initOrgSchema } = await import("../dist/org/schema.js");
  const { init: initDomainmap } = await import("../dist/domainmap/core/schema.js");
  const { initV6Schema } = await import("../dist/v6/schema.js");

  // ── 전체 체인 완주(순서=FK 의존; 하나라도 throw 하면 뒷 것이 안 돈다) ──
  {
    await initItemSchema();
    await initOrgSchema();       // ← push-wiki-notion 등 org_cron 시드가 제약을 어기면 여기서 throw
    await initDomainmap(itemsPool);
    await initV6Schema(itemsPool); // ← session.title 등 뒷 마이그레이션은 앞이 완주해야 돈다
    ok("전체 스키마 체인(item→org→domainmap→v6) throw 없이 완주");
  }

  // ── 재실행 멱등(부팅마다 도는 것 — 두 번째도 통과해야) ──
  {
    await initItemSchema(); await initOrgSchema(); await initDomainmap(itemsPool); await initV6Schema(itemsPool);
    ok("재실행 멱등 — 두 번째 부팅도 완주");
  }

  // ── 핵심 컬럼 실재(뒷 마이그레이션이 실제로 돌았다는 증거) ──
  {
    const has = async (table, col) => (await itemsPool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, col])).rowCount === 1;
    assert.ok(await has("session", "title"), "session.title 존재(v6 마이그레이션 완주 증거)");
    assert.ok(await has("session", "owner"), "session.owner 존재");
    const cron = await itemsPool.query(`SELECT params FROM org_cron WHERE id='push-wiki-notion'`);
    assert.equal(cron.rowCount, 1, "push-wiki-notion 시드 삽입됨");
    assert.ok(cron.rows[0].params !== null, "push-wiki-notion params 는 NOT NULL(제약 준수)");
    ok("핵심 컬럼·시드 실재(session.title·owner · push-wiki-notion params 비-null)");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f ${CNAME}`); } catch { /* */ }
}
