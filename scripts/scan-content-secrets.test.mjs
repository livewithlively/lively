// 콘텐츠 시크릿 스캔이 **지금 스키마**를 가리킨다 (#4501) — `scripts/scan-content-secrets.mjs` 회귀락.
//  2026-06-24 v6 컷오버로 knowledge_unit·domain 이 드랍됐는데 스캔은 그 테이블을 계속 조회했고, 없는 export(dmPool)를
//  import 해 **실행하자마자 죽는** 상태로 석 달을 지냈다. 런북(runbooks/secrets.md (e)(f))은 이 스크립트로 «hit 0» 을
//  확인하라고 한다 — 검증 도구가 죽어 있으면 유출 대응의 마지막 확인이 통째로 빈다.
//  그래서 ① 스크립트가 import 단계에서 살아 있는지 ② 스캔 대상 테이블·컬럼이 스키마 정의에 실제로 있는지를 락한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ① import — 없는 export·없는 모듈이면 여기서 ESM 링크 오류로 죽는다(직접 실행이 아니므로 스캔은 돌지 않는다).
const { SCAN_TARGETS } = await import("./scan-content-secrets.mjs");
assert.ok(Array.isArray(SCAN_TARGETS) && SCAN_TARGETS.length > 0, "SCAN_TARGETS 가 비었다(테스트가 대상을 잃음)");

// 스키마 정의 수집 — src 의 CREATE TABLE 블록 + ALTER TABLE … ADD COLUMN.
const tsFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) tsFiles.push(p);
  }
})(path.join(ROOT, "src"));
const src = tsFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");

function columnsOf(table) {
  const cols = new Set();
  const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\);`, "g");
  let found = false;
  for (const m of src.matchAll(create)) {
    found = true;
    for (const line of m[1].split(/,|\n/)) {
      const c = /^\s*([a-z_][a-z0-9_]*)\s+[A-Z]/.exec(line);
      if (c) cols.add(c[1]);
    }
  }
  for (const m of src.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*)`, "g"))) cols.add(m[1]);
  return found ? cols : null;
}

// ② 대상마다 — 테이블이 정의돼 있고, pk·컬럼이 전부 그 테이블에 있다.
for (const { table, pk, cols } of SCAN_TARGETS) {
  const defined = columnsOf(table);
  assert.ok(defined, `스캔 대상 테이블 ${table} 의 CREATE TABLE 정의가 src 에 없다(드랍·이름 변경?)`);
  for (const c of [pk, ...cols]) {
    assert.ok(defined.has(c), `${table}.${c} 가 스키마 정의에 없다 — 정의된 컬럼: ${[...defined].sort().join(", ")}`);
  }
}

// ③ 드랍된 옛 테이블을 다시 가리키지 않는다(src/v6/schema.ts 머리말: knowledge_unit/domain/org_project 드랍).
const tables = SCAN_TARGETS.map((t) => t.table);
for (const gone of ["knowledge_unit", "domain", "org_project"]) {
  assert.ok(!tables.includes(gone), `드랍된 테이블 ${gone} 을 스캔 대상에 두지 않는다`);
}

console.log(`✓ scan-content-secrets — import 정상 · 대상 ${tables.join(", ")} 전부 현 스키마에 있다`);
