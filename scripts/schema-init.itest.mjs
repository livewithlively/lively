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
    assert.ok(await has("org_app_instance", "execution_host_kind"), "org_app_instance.execution_host_kind 존재(실행 위치)");
    assert.ok(await has("org_app_runtime_asset", "code_hash"), "org_app_runtime_asset.code_hash 존재(worker 번들)");
    assert.ok(await has("org_app_worker_run", "status"), "org_app_worker_run.status 존재(worker 생애주기)");
    const cron = await itemsPool.query(`SELECT params FROM org_cron WHERE id='push-wiki-notion'`);
    assert.equal(cron.rowCount, 1, "push-wiki-notion 시드 삽입됨");
    assert.ok(cron.rows[0].params !== null, "push-wiki-notion params 는 NOT NULL(제약 준수)");
    ok("핵심 컬럼·시드 실재(session.title·owner · AppInstance/귀속이력 · push-wiki-notion params 비-null)");
  }

  // ── 실행 세션 ↔ 프로젝트 DB SoT(#1867) ──
  // cwd를 전혀 쓰지 않고 전환·해제·물리삭제가 revision/epoch과 이력을 함께 옮기는지 실 PG로 고정한다.
  {
    const { setExecutionSessionProject, executionSessionProject } = await import("../dist/v6/execution-session-store.js");
    const { upsertProjectFolderBinding, listProjectFolderBindings } = await import("../dist/v6/project-session-store.js");
    const made = await itemsPool.query(
      `INSERT INTO project(name, created_by) VALUES ('binding-e2e-a','itest'),('binding-e2e-b','itest') RETURNING id`);
    const [a, b] = made.rows.map((r) => Number(r.id)).sort((x, y) => x - y);
    const sid = "codex-thr-binding-e2e";

    const first = await setExecutionSessionProject({ id: sid, owner: "itest", harness: "codex", projectId: a });
    assert.deepEqual([first?.project_id, first?.desired_revision, first?.binding_epoch], [a, 1, 1]);
    const same = await setExecutionSessionProject({ id: sid, owner: "itest", harness: "codex", projectId: a });
    assert.deepEqual([same?.desired_revision, same?.binding_epoch], [1, 1], "같은 프로젝트 재지정은 멱등");
    const switched = await setExecutionSessionProject({ id: sid, owner: "itest", harness: "codex", projectId: b });
    assert.deepEqual([switched?.project_id, switched?.desired_revision, switched?.binding_epoch], [b, 2, 2]);
    const detached = await setExecutionSessionProject({ id: sid, owner: "itest", harness: "codex", projectId: null });
    assert.deepEqual([detached?.project_id, detached?.desired_revision, detached?.binding_epoch], [null, 3, 3]);
    const history = await itemsPool.query(
      `SELECT project_id, binding_epoch FROM session_project WHERE session_id=$1 ORDER BY binding_epoch`, [sid]);
    assert.deepEqual(history.rows.map((r) => [r.project_id == null ? null : Number(r.project_id), Number(r.binding_epoch)]),
      [[a, 1], [b, 2], [null, 3]], "해제까지 append-only 이력으로 남아야");

    await setExecutionSessionProject({ id: sid, owner: "itest", harness: "codex", projectId: a });
    await itemsPool.query(`DELETE FROM project WHERE id=$1`, [a]);
    const afterDelete = await executionSessionProject(sid, "itest");
    assert.deepEqual([afterDelete?.project_id, afterDelete?.desired_revision, afterDelete?.binding_epoch], [null, 5, 5],
      "프로젝트 물리삭제도 명시 detach 전환으로 보여야");
    const deleteTail = await itemsPool.query(
      `SELECT project_id, binding_epoch FROM session_project WHERE session_id=$1 ORDER BY binding_epoch DESC LIMIT 1`, [sid]);
    assert.equal(deleteTail.rows[0].project_id, null);
    assert.equal(Number(deleteTail.rows[0].binding_epoch), 5);

    await upsertProjectFolderBinding({ projectId: b, memberId: "u1", nodeId: "node-1", absPath: "/work/shared", bindingKind: "canonical" });
    await upsertProjectFolderBinding({ projectId: b, memberId: "u1", nodeId: "node-1", absPath: "/work/new", bindingKind: "canonical" });
    await upsertProjectFolderBinding({ projectId: b, memberId: "u1", nodeId: "node-2", absPath: "/work/shared", bindingKind: "canonical" });
    const folders = await listProjectFolderBindings(b);
    assert.deepEqual(folders.map((x) => [x.node_id, x.abs_path, x.binding_kind]), [
      ["node-1", "/work/new", "canonical"],
      ["node-1", "/work/shared", "ephemeral"],
      ["node-2", "/work/shared", "canonical"],
    ]);
    ok("실행 DB SoT — 전환·해제·삭제 revision 이력 + 프로젝트당 노드 canonical cwd 1개");
  }

  // ── 구 배포 세션 구제(#1867 후속) ──
  //  이 표가 생기기 전에 붙은 세션은 session_project 에만 바인딩이 있다. 그대로 두면 업그레이드 뒤 첫 프롬프트에서
  //  '미연결' 로 판정돼 새 프로젝트가 자동 생성된다(사람이 고른 소속이 갈린다). 구제는 current 만 세우고
  //  **이력은 건드리지 않는다**(이미 그 바인딩을 말하고 있다).
  {
    const { adoptLegacyExecutionSession, executionSessionProject } = await import("../dist/v6/execution-session-store.js");
    const made = await itemsPool.query(`INSERT INTO project(name, created_by) VALUES ('legacy-adopt-e2e','itest') RETURNING id`);
    const pid = Number(made.rows[0].id);
    const sid = "box-legacy-adopt01";
    await itemsPool.query(`INSERT INTO session_project(session_id, project_id, binding_epoch) VALUES($1,$2,0)`, [sid, pid]);
    const before = await executionSessionProject(sid, "itest");
    assert.equal(before, null, "구 세션은 아직 실행 표에 없다");

    const adopted = await adoptLegacyExecutionSession({ id: sid, owner: "itest", harness: "claude", projectId: pid });
    assert.deepEqual([adopted?.project_id, adopted?.desired_revision, adopted?.applied_revision, adopted?.binding_epoch], [pid, 1, 0, 1],
      "구제는 current 를 세우되 applied=0 — 다음 턴에 규칙이 한 번 주입돼야 한다");

    const history = await itemsPool.query(`SELECT count(*)::int AS n FROM session_project WHERE session_id=$1`, [sid]);
    assert.equal(history.rows[0].n, 1, "구제가 이력 행을 새로 만들면 같은 바인딩이 두 구간이 된다");

    // 두 번째 호출은 아무것도 바꾸지 않는다(정상 경로가 이미 세운 값을 덮지 않는다).
    await itemsPool.query(`UPDATE execution_session SET applied_revision=1 WHERE id=$1`, [sid]);
    const again = await adoptLegacyExecutionSession({ id: sid, owner: "itest", harness: "claude", projectId: 999999 });
    assert.deepEqual([again?.project_id, again?.applied_revision], [pid, 1], "이미 있으면 DO NOTHING");
    assert.equal(await executionSessionProject(sid, "other"), null, "남의 소유로는 안 보인다");
    ok("구 배포 세션 구제 — current 만 세우고 이력·기존 행은 건드리지 않는다");
  }

  // ── 자동 생성 껍데기는 세션마다 별개여야 한다(#1867) ──
  //  임시 이름("새 작업")은 서로 같으므로 이름 기반 중복차단(#1819)이 켜져 있으면 30초 안에 연 두 세션이 **한 프로젝트를
  //  공유**한다(dev 실측: 빈 세션과 슬래시 세션이 project/2009 를 함께 받았다) — 그러면 작업면까지 같이 쓰게 된다.
  {
    const { createProject } = await import("../dist/v6/project-store.js");
    const ctx = { actor: "itest-dedupe", source: "web" };
    const a = await createProject({ name: "새 작업", description: "x", dedupe: false }, ctx);
    const b = await createProject({ name: "새 작업", description: "x", dedupe: false }, ctx);
    assert.notEqual(a.id, b.id, "자동 생성 껍데기는 세션마다 자기 프로젝트를 가져야 한다");
    const c = await createProject({ name: "사람이 지은 이름", description: "x" }, ctx);
    const d = await createProject({ name: "사람이 지은 이름", description: "x" }, ctx);
    assert.equal(c.id, d.id, "사람 경로의 중복 차단(#1819)은 그대로 — IME 이중 Enter·에이전트 재시도가 실재한다");
    ok("자동 생성 껍데기 = 세션마다 별개 · 사람이 지은 이름 = 종전대로 중복 차단");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
