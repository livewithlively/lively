// #3970 — «아무도 모르는 초기 비번» 청소 마이그레이션을 **진짜 postgres 에** 돌려 본다.
//  실행:  node scripts/orphan-credential-cleanup.itest.mjs        (docker 필요 · 수동)
//
// 왜 itest 인가: 이 마이그레이션은 **자격을 지운다**. 조건 한 칸이 어긋나면 플랫폼 운영 계정(ops@lvly.io —
//  모든 테넌트에 심기고 로컬 비번으로만 로그인한다)의 자격이 사라지고, 그러면 CP 가 ops 토큰을 못 얻어
//  그 테넌트의 운영이 멈춘다. 문자열로 «조건이 들어 있나» 를 보는 테스트로는 그걸 못 잰다 — 실제로 돌려
//  **무엇이 남고 무엇이 사라지는지**를 행으로 본다. 표는 scratchpad/spec.md 의 C 표.
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const PORT = 59471, CNAME = "co-orphan-cred-itest";
let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", CNAME, "psql", "-U", "postgres", "-t", "-A", "-c", sql], { encoding: "utf8" }).trim();

// 마이그레이션 SQL 은 **소스에서 그대로 꺼낸다** — 여기 베껴 쓰면 둘이 갈라져 테스트가 거짓말을 한다.
const src = readFileSync(new URL("../src/org/schema/member-auth.ts", import.meta.url), "utf8");
const i = src.indexOf("DELETE FROM member_credential");
assert.ok(i > 0, "🔴 청소 마이그레이션을 소스에서 못 찾았다");
const CLEANUP_SQL = src.slice(i, src.indexOf("`);", i)).trim();

try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });
try {
  for (let n = 0; n < 60; n++) {
    try { psql("select 1"); break; } catch { execSync("sleep 0.5"); }
  }

  // 두 테이블의 **필요한 모양만** 세운다(전체 스키마 부팅은 schema-init.itest 의 몫).
  psql(`CREATE TABLE org_member(id TEXT PRIMARY KEY, identities JSONB);
        CREATE TABLE member_credential(member_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
          must_change BOOLEAN NOT NULL DEFAULT false);`);

  const cp = `'[{"system":"lvly_account","external_id":"a1"}]'::jsonb`;
  const other = `'[{"system":"oidc","external_id":"o1"}]'::jsonb`;
  psql(`
    INSERT INTO org_member(id, identities) VALUES
      ('c1-cp-untouched', ${cp}),      -- C1 라이블리 계정 + 한 번도 안 바꿈  → 지운다
      ('c2-ops',          '[]'::jsonb), -- C2 운영 계정(신원 없음)            → 보존(핵심)
      ('c3-cp-changed',   ${cp}),      -- C3 라이블리 계정인데 본인이 바꿈    → 보존
      ('c4-self',         ${other}),   -- C4 그 외                            → 보존
      ('c5-null-idents',  NULL);       -- C5 identities 가 null               → 보존 + 완주
    INSERT INTO member_credential(member_id, password_hash, must_change) VALUES
      ('c1-cp-untouched','h',true), ('c2-ops','h',true), ('c3-cp-changed','h',false),
      ('c4-self','h',false), ('c5-null-idents','h',true);`);

  assert.equal(psql("SELECT count(*) FROM member_credential"), "5", "픽스처가 5행이 아니다");
  ok("픽스처 5행(배선 확인 — 관측 장치가 살아 있다)");

  psql(CLEANUP_SQL);   // ← 소스의 그 SQL

  const left = psql("SELECT member_id FROM member_credential ORDER BY member_id").split("\n").filter(Boolean);
  assert.deepEqual(left, ["c2-ops", "c3-cp-changed", "c4-self", "c5-null-idents"],
    `🔴 청소 범위가 틀렸다 — 남은 행: ${JSON.stringify(left)}`);
  ok("C1 라이블리 계정 + 안 바뀐 초기 비번만 지워진다");
  ok("C2 ★ 운영 계정(ops)의 자격은 남는다 — 지우면 그 테넌트 운영이 멈춘다");
  ok("C3 본인이 바꾼 비번은 남는다");
  ok("C4 라이블리 계정이 아닌 사람은 남는다");
  ok("C5 identities 가 null 이어도 오류 없이 완주하고 그 행은 남는다");

  // 멱등 — 부팅마다 도는 자리다.
  psql(CLEANUP_SQL);
  assert.equal(psql("SELECT count(*) FROM member_credential"), "4", "🔴 두 번째 실행이 더 지운다");
  ok("멱등 — 다시 돌려도 같은 상태");

  console.log(`\n✓ ${pass}/${pass} 통과`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
