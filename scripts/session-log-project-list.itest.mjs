// 프로젝트 세션-로그 목록(#905 C1 슬⑤b) 통합검증 — listSessionsForProject.
//  ⚠ 수동 실행(docker). 실행:  cd <repo> && npm run build && node scripts/session-log-project-list.itest.mjs
//  왜: 프로젝트 탭 '세션 기록'이 **텅 비었던 실제 사고**의 원인은 이 조인이었다 —
//   매핑(session_project)은 tmux-id 로, 로그(session/session_log)는 claude-uuid 로 키가 달라 JOIN 이 0행이었다.
//   그래서 매핑을 **로그와 같은 session id**(마커의 project_id 를 append 경로가 그대로 실어보냄)로 하도록 고쳤다.
//   이 테스트가 그 다리(같은 id → 목록에 나옴)와 회귀(id 어긋나면 누락)를 DB 로 못박는다.
//  계약(행위):
//   ① 같은 session id 로 트랜스크립트 append + 프로젝트 매핑 → 그 프로젝트 목록에 **읽을 수 있는 제목**(첫 사람 발화,
//      uuid 아님)·소유자·표시명·총바이트·시각으로 나온다.
//   ② 매핑된 프로젝트에만 나온다(다른 프로젝트 목록엔 없음).
//   ③ 매핑 없는 세션은 어느 프로젝트 목록에도 안 나온다.
//   ④ 🔴 매핑 id ≠ 로그 id(옛 tmux/uuid 불일치) → 조인 실패로 목록에서 누락(그 버그의 회귀 가드).
//   ⑤ 다중 append(여러 청크)라도 세션은 1행, 바이트는 합계(DISTINCT ON).
//   ⑥ last_seen 내림차순(최근 대화가 위로).
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59452;
const CNAME = "co-c1-projlist-itest";
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
  // 대상 함수들이 만지는 테이블만 격리 생성(전체 initV6Schema 는 pgvector 필요).
  await itemsPool.query(`
    CREATE TABLE session(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, harness TEXT, owner TEXT, title TEXT, parent_session_id TEXT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id));
    CREATE TABLE session_log(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL,
      bytes BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id));
    CREATE TABLE session_log_chunk(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL,
      at_offset BIGINT NOT NULL, data BYTEA NOT NULL, raw_len BIGINT, codec TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id, at_offset));
    CREATE TABLE session_project(session_id TEXT NOT NULL, project_id INT NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, valid_from));
    CREATE TABLE org_member(id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE project(id INT PRIMARY KEY, name TEXT);
  `);
  const { appendSessionLog, listSessionsForProject, listSubagentsForSession, listSessionsForOwner } = await import("../dist/v6/session-log-store.js");
  const { recordSessionProject } = await import("../dist/v6/project-store.js");

  await itemsPool.query(`INSERT INTO org_member(id, display_name) VALUES ('alice','Alice'),('bob','Bob')`);

  // listSessionsForProject 는 project 테이블을 안 본다 — session_project.project_id 로만 필터하므로 임의 id 로 충분.
  const P1 = 101, P2 = 202;
  const B = (s) => Buffer.from(s, "utf8");
  const transcript = (q) => B(
    JSON.stringify({ type: "user", message: { content: q } }) + "\n" +
    JSON.stringify({ type: "assistant", message: { content: "ok" } }) + "\n");
  // 세션 하나 전문 업로드(오프셋0). 총 바이트 반환.
  async function upload(sessionId, q, owner) {
    const d = transcript(q);
    const r = await appendSessionLog({ nodeId: "", sessionId, atOffset: 0, data: d, harness: "claude", owner });
    assert.equal(r.ok, true, "업로드 성공");
    return d.length;
  }

  // ── ① 다리: 같은 session id 로 append + 매핑 → 제목·소유자·표시명·바이트로 목록에 나온다 ──
  {
    const n = await upload("cu-1", "프로젝트 세션 목록 버그 고쳐줘", "alice");
    await recordSessionProject("cu-1", P1);
    const list = await listSessionsForProject(P1);
    assert.equal(list.length, 1, "P1 목록에 정확히 1건");
    const row = list[0];
    assert.equal(row.session_id, "cu-1", "그 세션");
    assert.equal(row.title, "프로젝트 세션 목록 버그 고쳐줘", "🔑 uuid 아닌 '첫 사람 발화'가 제목");
    assert.equal(row.owner, "alice", "소유자");
    assert.equal(row.owner_name, "Alice", "org_member 조인 → 표시명");
    assert.equal(row.bytes, n, "총 바이트");
    assert.ok(row.first_seen && row.last_seen, "시각 존재");
    ok("① 같은 id append+매핑 → 제목·소유자·표시명·바이트로 목록에 나옴");
  }

  // ── ② 스코프: P1 에 매핑된 세션은 P2 목록엔 안 나온다 ──
  {
    const list2 = await listSessionsForProject(P2);
    assert.ok(!list2.some((r) => r.session_id === "cu-1"), "cu-1 은 P2 에 없음");
    ok("② 매핑된 프로젝트에만 나온다(다른 프로젝트엔 없음)");
  }

  // ── ③ 미매핑 세션은 어느 프로젝트 목록에도 안 나온다 ──
  {
    await upload("cu-orphan", "매핑 안 된 세션", "bob");    // recordSessionProject 호출 안 함
    const l1 = await listSessionsForProject(P1), l2 = await listSessionsForProject(P2);
    assert.ok(![...l1, ...l2].some((r) => r.session_id === "cu-orphan"), "고아 세션은 목록에 없음");
    ok("③ 매핑 없는 세션 → 어느 프로젝트 목록에도 안 나옴");
  }

  // ── ④ 🔴 키 불일치(옛 버그 재현): 로그는 claude-uuid, 매핑은 다른 id(tmux-id) → 안 나온다 ──
  {
    await upload("cu-mismatch", "키 불일치 재현", "alice");
    await recordSessionProject("box-slug-deadbeef", P1);   // ← 로그의 cu-mismatch 와 다른 id(옛 tmux-id 형태)
    const list = await listSessionsForProject(P1);
    assert.ok(!list.some((r) => r.session_id === "cu-mismatch"),
      "🔴 매핑 id 가 로그 id 와 다르면 JOIN 실패 → 목록에서 누락");
    ok("④ 매핑 id ≠ 로그 id(옛 tmux/uuid 불일치) → 누락(그 사고의 회귀 가드)");
  }

  // ── ⑤ 다중 append(여러 청크)라도 세션은 1행, 바이트는 합계(DISTINCT ON) ──
  {
    const d0 = transcript("여러 청크 세션");
    await appendSessionLog({ nodeId: "", sessionId: "cu-multi", atOffset: 0, data: d0, owner: "bob" });
    const more = B('{"type":"assistant","message":{"content":"more"}}\n');
    await appendSessionLog({ nodeId: "", sessionId: "cu-multi", atOffset: d0.length, data: more, owner: "bob" });
    await recordSessionProject("cu-multi", P2);
    const rows = (await listSessionsForProject(P2)).filter((r) => r.session_id === "cu-multi");
    assert.equal(rows.length, 1, "여러 청크라도 세션은 1행");
    assert.equal(rows[0].bytes, d0.length + more.length, "바이트는 합계");
    ok("⑤ 다중 append → 세션 1행, 바이트 합계");
  }

  // ── ⑥ 정렬: last_seen 내림차순(최근 대화가 위로) ──
  {
    await upload("cu-older", "옛 세션", "alice"); await recordSessionProject("cu-older", P1);
    await upload("cu-newer", "새 세션", "alice"); await recordSessionProject("cu-newer", P1);
    await itemsPool.query(`UPDATE session SET last_seen='2025-01-01T00:00:00Z' WHERE session_id='cu-older'`);
    await itemsPool.query(`UPDATE session SET last_seen='2025-06-01T00:00:00Z' WHERE session_id='cu-newer'`);
    const list = await listSessionsForProject(P1);
    const idx = (s) => list.findIndex((r) => r.session_id === s);
    assert.ok(idx("cu-newer") >= 0 && idx("cu-older") >= 0, "둘 다 목록에");
    assert.ok(idx("cu-newer") < idx("cu-older"), "최근(last_seen 큰) 세션이 위로");
    ok("⑥ last_seen 내림차순 정렬");
  }

  // ── ⑦ 내용 없는(0바이트) 세션은 매핑돼 있어도 목록에서 제외(사용자 요청: 빈 세션 숨김) ──
  {
    await appendSessionLog({ nodeId: "", sessionId: "cu-empty", atOffset: 0, data: Buffer.alloc(0), owner: "bob" });
    await recordSessionProject("cu-empty", P1);   // 매핑은 됐지만 바이트 0
    const list = await listSessionsForProject(P1);
    assert.ok(!list.some((r) => r.session_id === "cu-empty"), "0바이트 세션은 목록에 안 나온다");
    ok("⑦ 내용 없는(0바이트) 세션은 매핑돼도 목록에서 제외");
  }

  // ── ⑧ 서브에이전트(#905 슬⑥): parent 있는 세션은 최상위 프로젝트 목록에서 제외 + listSubagentsForSession 으로만 조회 ──
  {
    await upload("cu-parent", "부모 세션", "alice"); await recordSessionProject("cu-parent", P1);
    await appendSessionLog({ nodeId: "", sessionId: "cu-sub1", atOffset: 0, data: transcript("서브 작업"), owner: "alice", parentSessionId: "cu-parent" });
    await recordSessionProject("cu-sub1", P1);   // 서브에이전트도 같은 프로젝트로 매핑됨(마커 동일)
    const list = await listSessionsForProject(P1);
    assert.ok(list.some((r) => r.session_id === "cu-parent"), "부모는 프로젝트 목록에 나온다");
    assert.ok(!list.some((r) => r.session_id === "cu-sub1"), "🔑 서브에이전트(parent 있음)는 최상위 목록에서 제외");
    const subs = await listSubagentsForSession("", "cu-parent");
    assert.deepEqual(subs.map((r) => r.session_id), ["cu-sub1"], "listSubagentsForSession 은 그 부모의 서브에이전트만");
    ok("⑧ 서브에이전트 — 최상위 목록 제외 + listSubagentsForSession 으로 부모 아래 조회");
  }

  // ── ⑨ 내 세션 목록(listSessionsForOwner)은 각 세션의 '최근 프로젝트명'을 함께 준다(터미널 탭 표시용) ──
  {
    await itemsPool.query(`INSERT INTO project(id, name) VALUES (700,'내 프로젝트 A'), (800,'내 프로젝트 B')`);
    await upload("mine-a", "프로젝트A 세션", "alice"); await recordSessionProject("mine-a", 700);
    await upload("mine-b", "재바인딩 세션", "alice"); await recordSessionProject("mine-b", 700); await recordSessionProject("mine-b", 800);  // 재바인딩 → 최근=800
    await upload("mine-none", "매핑 없는 세션", "alice");   // 프로젝트 미매핑
    const rows = await listSessionsForOwner("alice");
    const by = (sid) => rows.find((r) => r.session_id === sid);
    assert.equal(by("mine-a")?.project_name, "내 프로젝트 A", "매핑된 프로젝트명");
    assert.equal(by("mine-b")?.project_name, "내 프로젝트 B", "🔑 재바인딩 시 '최근' 프로젝트명");
    assert.equal(by("mine-none")?.project_name, null, "매핑 없으면 project_name null");
    ok("⑨ 내 세션 목록 — 각 세션에 최근 프로젝트명(재바인딩=최근) · 미매핑은 null");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
