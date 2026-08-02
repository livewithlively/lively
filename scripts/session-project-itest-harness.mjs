// 세션↔프로젝트 시간구간 귀속 — 통합검증 **하니스**(#905 C1). 시나리오 파일이 이 헬퍼만 써서 행위를 검증한다.
//  ⚠ 이건 인프라(도커 pg 기동 + 스텁 테이블 + dist 로드 + 조작 헬퍼)다. 귀속 판정 로직 자체는 여기 없다 —
//    실제 dist(project-store.recordSessionProject, v6/project-activity-store.listProjectActivities)를 그대로 호출한다.
//  스텁 테이블은 listProjectActivities 가 만지는 컬럼만(FK 는 최소화). 전체 initV6Schema 는 pgvector 필요라 격리.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59438;
const CNAME = "co-c1-sp-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;

function sh(cmd) { return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString(); }

let itemsPool, recordSessionProject, listProjectActivities;

// 도커 pg 기동 + 스텁 테이블 + dist 로드. 반환: 아무것도(헬퍼가 모듈 상태를 씀).
export async function setup() {
  try { sh(`docker rm -f ${CNAME} 2>/dev/null`); } catch { /* */ }
  execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw",
    "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ }
    execSync("sleep 0.5");
  }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  ({ itemsPool } = await import("../dist/items/store.js"));
  ({ recordSessionProject } = await import("../dist/v6/project-store.js"));
  ({ listProjectActivities } = await import("../dist/v6/project-activity-store.js"));

  // listProjectActivities 가 만지는 테이블만 스텁으로. session_project 는 신규 시간구간 형태(복합키).
  await itemsPool.query(`
    CREATE TABLE project(id SERIAL PRIMARY KEY, level TEXT DEFAULT 'project', name TEXT);
    CREATE TABLE repo(id SERIAL PRIMARY KEY, name TEXT);
    CREATE TABLE activity(
      id SERIAL PRIMARY KEY, type TEXT NOT NULL DEFAULT 'note', title TEXT NOT NULL,
      summary TEXT, body TEXT, author_person TEXT, author_agent TEXT, session_id TEXT, repo_id INT,
      commit_sha TEXT, committed_at TIMESTAMPTZ,
      external_system TEXT, external_instance TEXT, external_id TEXT, external_url TEXT,
      should_review TEXT NOT NULL DEFAULT 'na', is_review TEXT NOT NULL DEFAULT 'na',
      project_id INT, created_at TIMESTAMPTZ);
    CREATE TABLE session_project(
      session_id TEXT NOT NULL, project_id INT NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, valid_from));
    CREATE INDEX session_project_project_idx ON session_project(project_id);
    CREATE TABLE knowledge(name TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE activity_knowledge(activity_id INT, name TEXT, relation TEXT, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE activity_touch(id SERIAL PRIMARY KEY, activity_id INT, target_kind TEXT, target_id INT);
  `);
}

export async function teardown() {
  try { if (itemsPool) await itemsPool.end(); } catch { /* */ }
  try { sh(`docker rm -f ${CNAME}`); } catch { /* */ }
}

// ── 조작 헬퍼(시나리오가 쓰는 유일한 표면) ──

// 프로젝트 하나 만들고 id 반환.
export async function mkProject(name) {
  const r = await itemsPool.query(`INSERT INTO project(name) VALUES($1) RETURNING id`, [name]);
  return r.rows[0].id;
}

// 실제 recordSessionProject 호출(세션 생성/재바인딩 경로). valid_from 은 지금(now()).
export async function recordBind(sessionId, projectId) {
  await recordSessionProject(sessionId, projectId);
}

// 특정 시각부터 유효한 바인딩 구간을 직접 심는다 — 구간 귀속을 결정적으로 세팅(now() 의존 제거).
export async function bindAt(sessionId, projectId, validFromISO) {
  await itemsPool.query(
    `INSERT INTO session_project(session_id, project_id, valid_from, created_at) VALUES($1,$2,$3,$3)`,
    [sessionId, projectId, validFromISO]);
}

// 작업 한 건 기록. atISO 가 발생시각(created_at). sessionId/projectId 는 선택.
export async function addActivity({ sessionId = null, projectId = null, title, atISO }) {
  const r = await itemsPool.query(
    `INSERT INTO activity(type, title, session_id, project_id, created_at) VALUES('note',$1,$2,$3,$4) RETURNING id`,
    [title, sessionId, projectId, atISO]);
  return r.rows[0].id;
}

// 프로젝트에 귀속된 작업 title 배열(실제 listProjectActivities → 최신 먼저).
export async function timeline(projectId) {
  const rows = await listProjectActivities(projectId, undefined, 200, 0);
  return rows.map((r) => r.title);
}

// 세션의 바인딩 구간들 [{projectId, validFrom}](valid_from 오름차순).
export async function rawBindings(sessionId) {
  const r = await itemsPool.query(
    `SELECT project_id, valid_from FROM session_project WHERE session_id=$1 ORDER BY valid_from ASC`, [sessionId]);
  return r.rows.map((row) => ({ projectId: row.project_id, validFrom: row.valid_from }));
}
