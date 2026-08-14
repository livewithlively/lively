// 세션이력 웹뷰 열람 멤버십(#905 C1 슬2d) 통합검증 — sessionBoundToMemberProject.
//  ⚠ 수동 실행(docker). 실행:  node scripts/session-view-member.itest.mjs
//  계약(프라이버시): 이 세션이 **한 번이라도** 바인딩된 프로젝트의 생성자/멤버면 true, 그 외 false. 시간구간 전체 조회.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59441;
const CNAME = "co-c1-viewmem-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
function sh(cmd) { return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString(); }
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
  const { itemsPool } = await import("../dist/items/store.js");
  await itemsPool.query(`
    CREATE TABLE project(id SERIAL PRIMARY KEY, level TEXT DEFAULT 'project', name TEXT, created_by TEXT);
    CREATE TABLE project_member(project_id INT, member_id TEXT, PRIMARY KEY(project_id, member_id));
    CREATE TABLE session_project(session_id TEXT NOT NULL, project_id INT NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(session_id, valid_from));
  `);
  const { sessionBoundToMemberProject } = await import("../dist/v6/project-store.js");

  // P1: 생성자 alice, 멤버 bob. P2: 생성자 dave, 멤버 없음.
  await itemsPool.query(`INSERT INTO project(id, name, created_by) VALUES (1,'P1','alice'),(2,'P2','dave')`);
  await itemsPool.query(`INSERT INTO project_member(project_id, member_id) VALUES (1,'bob')`);
  await itemsPool.query(`SELECT setval('project_id_seq', 2, true)`);

  // ── 생성자·멤버는 true, 무관자는 false ──
  {
    await itemsPool.query(`INSERT INTO session_project(session_id, project_id) VALUES ('s1', 1)`);   // s1 → P1
    assert.equal(await sessionBoundToMemberProject("s1", "alice"), true, "P1 생성자 alice → 열람 가능");
    assert.equal(await sessionBoundToMemberProject("s1", "bob"), true, "P1 멤버 bob → 열람 가능");
    assert.equal(await sessionBoundToMemberProject("s1", "carol"), false, "🔴 무관자 carol → 열람 불가");
    ok("생성자·멤버 열람 가능 · 무관자 불가");
  }

  // ── 바인딩 없는 세션 → 누구에게도 false ──
  {
    assert.equal(await sessionBoundToMemberProject("nobound", "alice"), false, "바인딩 없는 세션 → false");
    ok("바인딩 없는 세션 → 아무도 열람 불가");
  }

  // ── 시간구간: 재바인딩돼도 **과거에 속했던** 프로젝트의 멤버면 열람 가능(전 구간 조회) ──
  {
    // s2: P2(dave) → 재바인딩 → P1(alice/bob). 두 구간 모두 고려돼야.
    await itemsPool.query(`INSERT INTO session_project(session_id, project_id, valid_from) VALUES
      ('s2', 2, now() - interval '2 days'), ('s2', 1, now() - interval '1 day')`);
    assert.equal(await sessionBoundToMemberProject("s2", "dave"), true, "옛 구간 P2 의 생성자 dave → 열람 가능");
    assert.equal(await sessionBoundToMemberProject("s2", "bob"), true, "현 구간 P1 의 멤버 bob → 열람 가능");
    assert.equal(await sessionBoundToMemberProject("s2", "carol"), false, "어느 구간에도 무관 → 불가");
    ok("시간구간 — 과거·현재 어느 구간의 멤버든 열람 가능");
  }

  // ── 빈 인자 방어 ──
  {
    assert.equal(await sessionBoundToMemberProject("", "alice"), false, "빈 sessionId → false");
    assert.equal(await sessionBoundToMemberProject("s1", ""), false, "빈 memberId → false");
    ok("빈 인자 → false(방어)");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
