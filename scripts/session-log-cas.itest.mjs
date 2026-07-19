// 세션로그 offset-CAS 통합검증(#905 C1 슬라이스1) — 버릴 pg 컨테이너에 실제 테이블 올려 진짜 CAS 를 때린다.
//  ⚠ **수동 실행**(docker 필요) — npm test CI 체인엔 DB 가 없어 안 넣는다. 순수 판정은 dist/v6/session-log-cas.test.js 가 본다.
//  실행:  cd <repo> && npm run build && node scripts/session-log-cas.itest.mjs   (docker 데몬 필요, 라이브 DB 무접촉)
//  검증: 순차 append·재시작 재push(멱등)·gap·overlap·**동시 N개→정확히 1개 성공(원자적 CAS)**·복합키·부분회수.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59437;
const CNAME = "co-c1-cas-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };

function sh(cmd) { return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString(); }
try { sh(`docker rm -f ${CNAME} 2>/dev/null`); } catch { /* */ }

console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw",
  "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

try {
  // ready 대기
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ }
    execSync("sleep 0.5");
  }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/items/store.js");
  // C1 테이블만 생성(전체 initV6Schema 는 pgvector 필요 — 여기선 대상 테이블만 격리 검증).
  await itemsPool.query(`
    CREATE TABLE session(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, harness TEXT, owner TEXT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id));
    CREATE TABLE session_log(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL,
      bytes BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id));
    CREATE TABLE session_log_chunk(node_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL,
      at_offset BIGINT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id, at_offset));
  `);
  const S = await import("../dist/v6/session-log-store.js");
  const B = (s) => Buffer.from(s, "utf8");

  // ── 순차 append — 워터마크가 정확히 증가, 청크 왕복 일치 ──
  {
    const r1 = await S.appendSessionLog({ nodeId: "", sessionId: "s1", atOffset: 0, data: B("hello ") });
    assert.deepEqual([r1.ok, r1.verdict, r1.bytes], [true, "append", 6]);
    const r2 = await S.appendSessionLog({ nodeId: "", sessionId: "s1", atOffset: 6, data: B("world") });
    assert.deepEqual([r2.ok, r2.verdict, r2.bytes], [true, "append", 11]);
    const read = await S.readSessionLog("", "s1", 0);
    assert.equal(read.data.toString(), "hello world");
    assert.equal(read.bytes, 11);
    ok("순차 append → 워터마크 정확 증가 + 회수 왕복 일치");
  }

  // ── 재시작 재push(duplicate) → 멱등 성공, 아무것도 안 씀 ──
  {
    const dup = await S.appendSessionLog({ nodeId: "", sessionId: "s1", atOffset: 0, data: B("hello ") });
    assert.deepEqual([dup.ok, dup.verdict, dup.bytes], [true, "duplicate", 11], "이미 가진 바이트 재push 는 멱등 성공");
    const read = await S.readSessionLog("", "s1", 0);
    assert.equal(read.data.toString(), "hello world", "중복이 로그를 오염시키면 안 된다");
    ok("재시작 재push(duplicate) → 멱등 성공, 로그 무오염");
  }

  // ── gap(사이 빔) → 거절 + 정정용 현재 bytes ──
  {
    const gap = await S.appendSessionLog({ nodeId: "", sessionId: "s1", atOffset: 99, data: B("X") });
    assert.deepEqual([gap.ok, gap.verdict, gap.bytes], [false, "gap", 11], "gap 은 거절하고 현재 워터마크를 알려준다");
    ok("gap → 거절 + 현재 bytes 정정");
  }

  // ── overlap(꼬리 겹침) → 거절 ──
  {
    const ov = await S.appendSessionLog({ nodeId: "", sessionId: "s1", atOffset: 9, data: B("ZZZZ") });  // 9<11<13
    assert.deepEqual([ov.ok, ov.verdict], [false, "overlap"], "부분중복은 거절(그대로 쓰면 오염)");
    ok("overlap → 거절");
  }

  // ── 🔑 동시성: 같은 offset 으로 N개 동시 append → 정확히 1개만 성공(원자적 직렬화) ──
  {
    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      S.appendSessionLog({ nodeId: "", sessionId: "conc", atOffset: 0, data: B(`d${i}=`) })));
    const appended = results.filter((r) => r.verdict === "append");
    assert.equal(appended.length, 1, `🔑 동시 ${N}개 중 정확히 1개만 append 여야(원자적 CAS) — 실제 ${appended.length}`);
    const wm = await S.sessionLogWatermark("", "conc");
    assert.equal(wm, appended[0].bytes, "최종 워터마크 = 유일하게 성공한 append 의 길이");
    // 청크도 정확히 1개(경쟁자들이 chunk 를 안 남겼다)
    const cnt = await itemsPool.query(`SELECT count(*)::int c FROM session_log_chunk WHERE session_id='conc'`);
    assert.equal(cnt.rows[0].c, 1, "🔑 성공한 append 만 청크를 남긴다(경쟁자 오염 없음)");
    ok(`🔑 동시 ${N}개 append(같은 offset) → 정확히 1개 성공 + 청크 1개(락 없는 원자적 CAS)`);
  }

  // ── 복합키: 같은 session_id, 다른 node → 독립 로그(스칼라면 병합됐을 것) ──
  {
    await S.appendSessionLog({ nodeId: "nodeA", sessionId: "shared", atOffset: 0, data: B("AAAA") });
    await S.appendSessionLog({ nodeId: "nodeB", sessionId: "shared", atOffset: 0, data: B("BB") });
    assert.equal(await S.sessionLogWatermark("nodeA", "shared"), 4);
    assert.equal(await S.sessionLogWatermark("nodeB", "shared"), 2, "다른 node 의 같은 session_id 는 별개 로그여야(복합키)");
    assert.equal((await S.readSessionLog("nodeA", "shared", 0)).data.toString(), "AAAA");
    assert.equal((await S.readSessionLog("nodeB", "shared", 0)).data.toString(), "BB");
    ok("복합키 (node,session) → 같은 session_id 라도 머신별 독립 로그");
  }

  // ── 부분 회수: 청크 경계 중간부터 from 요청 ──
  {
    const mid = await S.readSessionLog("", "s1", 3);   // "lo world"
    assert.equal(mid.data.toString(), "lo world", "from 이 청크 중간이면 그 지점부터 잘라 반환");
    assert.equal(mid.from, 3);
    ok("부분 회수 — from 이 경계 중간이어도 정확히 잘라 반환");
  }

  // ── 소유자(#905 슬2b) — 첫 append 가 owner 를 굳히고 이후 안 바뀐다(COALESCE). sessionOwner 조회. ──
  {
    await S.appendSessionLog({ nodeId: "", sessionId: "own1", atOffset: 0, data: B("hi"), owner: "alice" });
    assert.equal(await S.sessionOwner("", "own1"), "alice", "첫 append 한 멤버가 소유자");
    // bob 이 owner=bob 으로 또 append 해도 owner 는 안 바뀐다(COALESCE — 스토어는 소유자만 append 를 강제하지 않는다;
    //  그 게이트는 라우트가 sessionOwner 로 한다. 스토어는 owner 를 '최초 1회'만 굳히는 것만 보장).
    await S.appendSessionLog({ nodeId: "", sessionId: "own1", atOffset: 2, data: B("!"), owner: "bob" });
    assert.equal(await S.sessionOwner("", "own1"), "alice", "owner 는 최초값 유지(이후 append 가 못 덮음)");
    assert.equal(await S.sessionOwner("", "never"), null, "아무도 안 쓴 세션 → owner null");
    ok("소유자 — 첫 append 가 굳히고 불변(COALESCE) · 미기록 세션은 null");
  }

  // ── 🔑 소유자 레이스(리뷰 지적) — 서로 다른 두 멤버가 **새 세션**에 동시에 첫 append. "둘 다 통과하나?" 반증. ──
  //   session 행 락이 두 트랜잭션을 직렬화하므로 owner 를 굳힌 쪽이 CAS 도 먼저 이긴다 → owner-승자 == 데이터-승자.
  {
    const [ra, rb] = await Promise.all([
      S.appendSessionLog({ nodeId: "", sessionId: "ownrace", atOffset: 0, data: B("AAAA"), owner: "alice" }),
      S.appendSessionLog({ nodeId: "", sessionId: "ownrace", atOffset: 0, data: B("BBBB"), owner: "bob" }),
    ]);
    const owner = await S.sessionOwner("", "ownrace");
    assert.ok(owner === "alice" || owner === "bob", "소유자는 둘 중 한 명으로 굳는다(둘 다 아님)");
    const appended = [ra, rb].filter((r) => r.verdict === "append");
    assert.equal(appended.length, 1, "🔑 동시 첫 append 는 정확히 한 명만 성공(둘 다 통과 금지)");
    const cnt = await itemsPool.query(`SELECT count(*)::int c FROM session_log_chunk WHERE session_id='ownrace'`);
    assert.equal(cnt.rows[0].c, 1, "성공한 한 명의 청크만 남는다(진 쪽 오염 없음)");
    assert.equal(await S.sessionLogWatermark("", "ownrace"), 4, "워터마크 = 이긴 델타 길이(4)");
    const data = (await S.readSessionLog("", "ownrace", 0)).data.toString();
    assert.equal(data, owner === "alice" ? "AAAA" : "BBBB", "🔑 owner 를 굳힌 쪽의 데이터만 남는다(owner-승자 == 데이터-승자)");
    ok("🔑 서로 다른 두 멤버 동시 첫 append → owner 1명 확정 + append 1건 + owner·데이터 승자 일치");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f ${CNAME}`); } catch { /* */ }
}
