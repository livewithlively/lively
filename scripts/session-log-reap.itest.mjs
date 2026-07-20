// 세션로그 retention reap 통합검증(#905 C1 슬③) — 버릴 pg 컨테이너에 실제 테이블 올려 reap 을 때린다.
//  ⚠ 수동 실행(docker). 실행:  node scripts/session-log-reap.itest.mjs
//  검증: 오래 손 안 댄 로그·청크만 통째 삭제 · 활성 로그 보존 · **session 레코드 불멸** · retention<=0 무제한(no-op).
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59440;
const CNAME = "co-c1-reap-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
function sh(cmd) { return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString(); }
try { sh(`docker rm -f ${CNAME} 2>/dev/null`); } catch { /* */ }

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
    CREATE TABLE session(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, harness TEXT, owner TEXT, title TEXT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id));
    CREATE TABLE session_log(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL,
      bytes BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id));
    CREATE TABLE session_log_chunk(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL,
      at_offset BIGINT NOT NULL, data BYTEA NOT NULL, raw_len BIGINT, codec TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id, at_offset));
    CREATE INDEX session_log_reap_idx ON session_log(updated_at);
  `);
  const S = await import("../dist/v6/session-log-store.js");
  const B = (s) => Buffer.from(s, "utf8");
  const chunkCount = async (sid) => (await itemsPool.query(`SELECT count(*)::int c FROM session_log_chunk WHERE session_id=$1`, [sid])).rows[0].c;

  // ── 오래된 로그(updated_at 40일 전)는 통째 reap, 활성 로그·session 레코드는 보존 ──
  {
    await S.appendSessionLog({ nodeId: "", sessionId: "old1", atOffset: 0, data: B("staledata"), owner: "u" });
    await itemsPool.query(`UPDATE session_log SET updated_at = now() - interval '40 days' WHERE session_id='old1'`);
    await S.appendSessionLog({ nodeId: "", sessionId: "fresh1", atOffset: 0, data: B("livedata"), owner: "u" });

    const res = await S.reapSessionLogs(30);
    assert.equal(res.logs, 1, "30일 지난 로그 1개만 reap");
    assert.ok(res.chunks >= 1, "reap 된 세션의 청크도 함께 삭제");
    assert.equal(await S.sessionLogWatermark("", "old1"), 0, "reap 된 로그의 워터마크 0(사라짐)");
    assert.equal(await chunkCount("old1"), 0, "reap 된 세션의 청크 0");
    assert.equal(await S.sessionLogWatermark("", "fresh1"), Buffer.byteLength("livedata"), "🔑 활성 로그는 보존(delete-all 아님)");
    assert.equal(await chunkCount("fresh1"), 1, "활성 세션의 청크 보존");
    assert.equal(await S.sessionOwner("", "old1"), "u", "🔑 로그가 reap 돼도 session 레코드(owner)는 불멸");
    ok("retention reap — 오래된 로그·청크만 통째 삭제, 활성 로그·session 레코드는 보존");
  }

  // ── retentionDays<=0 → 무제한(아무것도 안 지움) ──
  {
    await S.appendSessionLog({ nodeId: "", sessionId: "keep0", atOffset: 0, data: B("x") });
    await itemsPool.query(`UPDATE session_log SET updated_at = now() - interval '999 days' WHERE session_id='keep0'`);
    const res = await S.reapSessionLogs(0);
    assert.deepEqual(res, { logs: 0, chunks: 0 }, "retention 0 = 무제한 → reap 안 함");
    assert.equal(await S.sessionLogWatermark("", "keep0"), 1, "무제한이면 아주 오래된 것도 보존");
    ok("retention 0(무제한) → 아무것도 reap 안 함");
  }

  // ── 경계: 정확히 retention 안쪽(29일)은 남고, 바깥(31일)은 지운다 ──
  {
    await S.appendSessionLog({ nodeId: "", sessionId: "edge29", atOffset: 0, data: B("in") });
    await itemsPool.query(`UPDATE session_log SET updated_at = now() - interval '29 days' WHERE session_id='edge29'`);
    await S.appendSessionLog({ nodeId: "", sessionId: "edge31", atOffset: 0, data: B("out") });
    await itemsPool.query(`UPDATE session_log SET updated_at = now() - interval '31 days' WHERE session_id='edge31'`);
    await S.reapSessionLogs(30);   // 이전 테스트 잔여(keep0 999일)도 함께 reap 될 수 있어 총계 대신 대상별로 검증
    assert.equal(await S.sessionLogWatermark("", "edge29"), 2, "29일(안쪽)은 보존");
    assert.equal(await S.sessionLogWatermark("", "edge31"), 0, "31일(바깥)은 reap");
    ok("경계 — retention 안쪽(29일)은 보존, 바깥(31일)은 reap");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f ${CNAME}`); } catch { /* */ }
}
