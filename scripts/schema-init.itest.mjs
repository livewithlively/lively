// 스키마 부팅 무결성 통합검증 — 빈 pg 에 전체 스키마 체인(item→org→domainmap→v6)을 순서대로 올려 **완주**하는지 본다.
//  ⚠ 수동 실행(docker). 실행:  node scripts/schema-init.itest.mjs
//  왜: 시드 한 줄이 제약(NOT NULL/CHECK/FK)을 어기면 그 init 이 throw 하고 **뒤따르는 모든 마이그레이션이 안 돈다**
//   (2026-07-20 실사고: org_cron push-wiki-notion params=NULL → initOrgSchema 중단 → initV6Schema 의 session.title
//    ALTER 미실행 → 웹뷰 500). 이 테스트가 그 계열 회귀를 부팅 전에 잡는다.
//  체인은 **initAllSchemas(boot/schemas.ts) 경유** — 프로덕션 부팅·run-sync CLI 와 같은 단일 출처를 그대로 검증한다
//   (#1313 R19a. 종전엔 4개 init 을 직접 순서대로 불러 '순서 규약' 자체는 이 테스트가 복제하고 있었다).
//
//  SQL 순서 스냅샷(#1313 R19a): SCHEMA_SQL_LOG=<파일> 이면 실행되는 모든 SQL 의 정규화 시퀀스(주석 제거·공백 압축,
//   쿼리당 1줄)를 그 파일에 append 한다. 용도: 스키마 파일 리팩토링(헬퍼 추출·조각 분할, R19a~c)의
//   '치환 전후 실행 SQL 동일' 증명 — 치환 전 채집 → 치환 후 채집 → diff 0. 구현은 이 스크립트 안에서
//   itemsPool.query 를 래핑(프로덕션 코드 무변경 — env 없으면 완전 no-op).
import { execFileSync, execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";

const PORT = 59460, CNAME = "co-schema-init-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

// SQL 정규화 — ① `--` 줄주석 제거(문자열 리터럴 안은 보존: '' 이스케이프 추적) ② 공백 연속 압축.
//  주석까지 지우는 이유: 주석은 실행에 무영향이라, '실행 SQL 동일' 비교에서 주석 이동/삭제가 잡음이 되면 안 된다.
function normalizeSql(sql) {
  let out = "", inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inStr) { out += c; if (c === "'") { if (sql[i + 1] === "'") { out += "'"; i++; } else inStr = false; } continue; }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; }
    out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}

try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js"); // 모든 init 이 공유하는 단일 풀(items/store 재수출과 동일 객체)
  if (process.env.SCHEMA_SQL_LOG) {
    const logPath = process.env.SCHEMA_SQL_LOG;
    const orig = itemsPool.query.bind(itemsPool);
    itemsPool.query = (...args) => {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
      if (typeof text === "string") appendFileSync(logPath, normalizeSql(text) + "\n");
      return orig(...args);
    };
    console.log(`· SQL 순서 스냅샷 → ${logPath}`);
  }
  const { initAllSchemas } = await import("../dist/boot/schemas.js");

  // ── 전체 체인 완주(순서=FK 의존; 하나라도 throw 하면 뒷 것이 안 돈다) — 프로덕션과 같은 initAllSchemas 경유 ──
  {
    await initAllSchemas(); // ← push-wiki-notion 등 org_cron 시드가 제약을 어기면 여기서 throw(뒤 v6 마이그레이션 미실행)
    ok("전체 스키마 체인(item→org→domainmap→v6, initAllSchemas 경유) throw 없이 완주");
  }

  // ── 재실행 멱등(부팅마다 도는 것 — 두 번째도 통과해야) ──
  {
    await initAllSchemas();
    ok("재실행 멱등 — 두 번째 부팅도 완주");
  }

  // ── 핵심 컬럼 실재(뒷 마이그레이션이 실제로 돌았다는 증거) ──
  {
    const has = async (table, col) => (await itemsPool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, col])).rowCount === 1;
    assert.ok(await has("session", "title"), "session.title 존재(v6 마이그레이션 완주 증거)");
    assert.ok(await has("session", "owner"), "session.owner 존재");
    assert.ok(await has("org_app_instance", "project_id"), "org_app_instance.project_id 존재(nullable 프로젝트 맥락)");
    assert.ok(await has("org_app_instance_project", "valid_from"), "org_app_instance_project.valid_from 존재(귀속 이력)");
    const cron = await itemsPool.query(`SELECT params FROM org_cron WHERE id='push-wiki-notion'`);
    assert.equal(cron.rowCount, 1, "push-wiki-notion 시드 삽입됨");
    assert.ok(cron.rows[0].params !== null, "push-wiki-notion params 는 NOT NULL(제약 준수)");
    ok("핵심 컬럼·시드 실재(session.title·owner · AppInstance/귀속이력 · push-wiki-notion params 비-null)");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
