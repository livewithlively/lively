// pg 풀을 만드는 자리는 반드시 'error' 리스너를 단다 (#4501) — 부류 가드.
//  pg-pool 은 유휴 클라이언트가 오류를 내면(DB 재시작·관리자 종료·프록시 유휴 타임아웃) 풀에 'error' 를 emit 하고,
//  리스너가 없으면 Node 가 그걸 throw 로 바꿔 **프로세스를 죽인다**. 본체 풀(src/db/client.ts)과 db source 풀
//  (src/db/pool.ts)이 그 상태였다 — 앱 SQL 풀(src/apps/app-sql-exec.ts)만 리스너가 있었다. 새 풀이 생길 때
//  같은 누락이 반복되지 않게, src 의 `new pg.Pool(` 마다 같은 파일에 `.on("error"` 가 짝으로 있는지 센다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|mjs|js)$/.test(e.name) && !/\.(test|itest|pg-test)\.(ts|mjs|js)$/.test(e.name)) files.push(p);
  }
})(path.join(ROOT, "src"));

const count = (s, re) => (s.match(re) ?? []).length;
const withPools = [];
for (const f of files) {
  const s = fs.readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");   // 주석 속 언급은 세지 않는다
  const pools = count(s, /new\s+pg\.Pool\s*\(/g);
  if (!pools) continue;
  withPools.push(path.relative(ROOT, f));
  const listeners = count(s, /\.on\(\s*["']error["']/g);
  assert.ok(listeners >= pools,
    `${path.relative(ROOT, f)}: pg 풀 ${pools}개인데 'error' 리스너 ${listeners}개 — 유휴 연결 오류 하나에 프로세스가 죽는다. 풀마다 .on("error", …) 를 단다`);
}
// 배선 단언 — 알려진 풀 자리를 못 찾으면 이 가드는 아무것도 안 본다.
assert.ok(withPools.includes(path.join("src", "db", "client.ts")), `본체 풀(src/db/client.ts)을 못 찾았다 — 찾은 곳: ${withPools.join(", ")}`);

console.log(`✓ pg 풀 ${withPools.length}곳(${withPools.join(", ")}) 전부 'error' 리스너가 있다`);
