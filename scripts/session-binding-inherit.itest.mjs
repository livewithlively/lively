// 이어받기 소속 승계 — 실 PG 통합검증 (#1867).
//  ⚠ 수동 실행(docker 필요):  npm run build && node scripts/session-binding-inherit.itest.mjs
//  왜 실 DB 인가: 판정이 **SQL 안에** 있다(마지막 구간만 본다 · 휴지통은 제외). 가짜 조회로는 그 두 줄을 못 지킨다.
//
//  사양(행위):
//   ① 마지막 바인딩 구간의 프로젝트를 승계한다.
//   ② 그 프로젝트가 **휴지통**이면 승계하지 않는다(null) — 한 칸 더 옛날 바인딩으로 되살리지도 않는다.
//   ③ 마지막 구간이 detach(project_id NULL)면 null — '뗐다'는 사람의 의사다.
//   ④ 체인은 실행 세션 id 먼저, 없으면 이어받은 대화 uuid.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59461, CNAME = "co-binding-inherit-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };

try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* 없으면 그만 */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw",
  "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });
let ready = false;
for (let i = 0; i < 60; i++) {
  try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* 아직 */ }
  execSync("sleep 0.5");
}
assert.ok(ready, "pg 준비 실패");
execSync("sleep 0.5");

process.env.ITEMS_DATABASE_URL = url;
const { itemsPool } = await import("../dist/items/store.js");
const { latestProjectForSession, latestProjectForSessionChain, sessionsCurrentlyBound } = await import("../dist/v6/project-session-store.js");

try {
  // 스텁은 이 두 함수가 만지는 컬럼만(전체 initV6Schema 는 pgvector 필요라 격리 — schema-init.itest 가 그쪽을 본다).
  await itemsPool.query(`
    CREATE TABLE project(
      id SERIAL PRIMARY KEY, level TEXT NOT NULL DEFAULT 'project', name TEXT,
      folder TEXT, trashed_at TIMESTAMPTZ);
    CREATE TABLE session_project(
      tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
      session_id TEXT NOT NULL, project_id INT,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      binding_epoch BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (tenant_id, session_id, valid_from));
  `);
  const mk = async (name, folder) => (await itemsPool.query(
    `INSERT INTO project(name, folder) VALUES($1,$2) RETURNING id`, [name, folder])).rows[0].id;
  const bind = async (sid, pid, at) => itemsPool.query(
    `INSERT INTO session_project(session_id, project_id, valid_from, created_at) VALUES($1,$2,$3,$3)`,
    [sid, pid, at]);
  const trash = async (pid) => itemsPool.query(`UPDATE project SET trashed_at=now() WHERE id=$1`, [pid]);

  // ── ① 마지막 구간을 승계한다 ──
  {
    const A = await mk("A", "project/A"), B = await mk("B", "project/B");
    await bind("s1", A, "2026-08-20T00:00:00Z");
    await bind("s1", B, "2026-08-21T00:00:00Z");
    assert.deepEqual(await latestProjectForSession("s1"), { id: B, folder: "project/B" },
      "마지막 구간(B)이 답이다 — 옛 구간(A)이 아니다");
    ok("① 마지막 바인딩 구간을 승계");
  }

  // ── ② 휴지통이면 승계하지 않는다 ──
  //  근거(2026-08-26 실측): 껍데기를 휴지통에 넣는 게 정상 정리 절차(태스크 #2051)인데, 그 상태로 대화를
  //  이어받으면 세션이 **보드에 없는 프로젝트**에 붙어 맥락만 거기서 주입된다.
  {
    const A = await mk("A2", "project/A2"), B = await mk("B2", "project/B2");
    await bind("s2", A, "2026-08-20T00:00:00Z");
    await bind("s2", B, "2026-08-21T00:00:00Z");
    await trash(B);
    assert.equal(await latestProjectForSession("s2"), null, "휴지통 프로젝트는 승계 대상이 아니다");
    ok("② 마지막 바인딩이 휴지통 → null");
    // ★ 한 칸 더 옛날(A)로 되살리지 않는다: '옮긴 뒤 지웠다'가 되살아나면 사람 의사와 정반대가 된다.
    assert.notDeepEqual(await latestProjectForSession("s2"), { id: A, folder: "project/A2" });
    ok("② 옛 구간으로 부활시키지 않는다");
  }

  // ── ③ detach 가 마지막이면 null ──
  {
    const A = await mk("A3", "project/A3");
    await bind("s3", A, "2026-08-20T00:00:00Z");
    await bind("s3", null, "2026-08-21T00:00:00Z");
    assert.equal(await latestProjectForSession("s3"), null, "뗐으면 뗀 것이다");
    ok("③ detach 가 마지막 → null");
  }

  // ── ④ 체인: 실행 축 먼저, 없으면 대화 축 ──
  {
    const P = await mk("P4", "project/P4"), Q = await mk("Q4", "project/Q4");
    await bind("box-exec", P, "2026-08-21T00:00:00Z");
    await bind("conv-uuid", Q, "2026-08-20T00:00:00Z");
    assert.deepEqual(await latestProjectForSessionChain(["box-exec", "conv-uuid"]), { id: P, folder: "project/P4" },
      "실행 축이 이긴다");
    assert.deepEqual(await latestProjectForSessionChain(["box-new", "conv-uuid"]), { id: Q, folder: "project/Q4" },
      "실행 축에 이력이 없으면 이어받은 대화 축");
    ok("④ 체인 순서(실행 → 대화)");
    // 실행 축의 프로젝트가 휴지통이면 그 축은 '없음'이 되어 대화 축으로 넘어간다.
    await trash(P);
    assert.deepEqual(await latestProjectForSessionChain(["box-exec", "conv-uuid"]), { id: Q, folder: "project/Q4" },
      "실행 축이 휴지통이면 대화 축으로");
    ok("④ 실행 축이 휴지통 → 대화 축으로 넘어간다");
  }

  // ── ⑤ 휴지통 쓸어담기: '지금도 이 프로젝트 소속'인 세션만 ──
  //  근거(2026-08-26 실측): 소속을 옮긴 뒤 옛 껍데기를 버렸더니 **살아 있는 그 세션 카드가 함께 쓸려갔다**.
  //  목록(listSessionsForProject)은 이력 조인이라 옮긴 세션도 나온다 — 목록엔 맞고, 버리기엔 틀리다.
  {
    const OLD = await mk("O5", "project/O5"), NEW = await mk("N5", "project/N5");
    await bind("moved", OLD, "2026-08-20T00:00:00Z");
    await bind("moved", NEW, "2026-08-21T00:00:00Z");     // 옮겼다
    await bind("stayed", OLD, "2026-08-20T00:00:00Z");    // 그대로 남았다
    assert.deepEqual([...await sessionsCurrentlyBound(["moved", "stayed"], OLD)], ["stayed"],
      "옛 프로젝트를 버릴 때 딸려갈 세션은 아직 거기 있는 것뿐이다");
    ok("⑤ 옮긴 세션은 옛 프로젝트의 휴지통에 딸려가지 않는다");
    assert.deepEqual([...await sessionsCurrentlyBound(["moved", "stayed"], NEW)], ["moved"], "옮겨간 쪽에서는 포함된다");
    ok("⑤ 옮겨간 프로젝트에서는 포함된다");
    assert.equal((await sessionsCurrentlyBound([], OLD)).size, 0, "빈 입력은 DB 를 때리지 않는다");
    ok("⑤ 빈 입력 방어");
  }

  console.log(`\n통과 ${pass}건`);
} finally {
  try { await itemsPool.end(); } catch { /* */ }
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
