// 관리기 발견 멱등·반려영속 통합검증(#1419 T5) — 버릴 pg 컨테이너에 실제 테이블 올려 진짜 ON CONFLICT 를 때린다.
//  ⚠ **수동 실행**(docker 필요) — npm test CI 체인엔 DB 가 없다. 순수 판정은 dist/org/manage/manager-pure.test.js 가 본다.
//  실행:  cd <repo> && npm run build && node scripts/manager-finding.itest.mjs   (docker 데몬 필요, 라이브 DB 무접촉)
//
//  왜 실 DB 여야 하나: 이 태스크에서 가장 중요한 두 불변식이 **SQL 안에** 있다 —
//   ① 멱등: 같은 (관리기, 대상, dedup_key) 는 한 행이고 재발견은 카운트만 오른다.
//      아니면 큐가 같은 항목의 사본으로 뒤덮여 아무도 안 본다.
//   ② 반려 영속: 사람이 '오탐'이라 한 것은 다음 주기에 되살아나지 않는다.
//      되살리면 관리기가 사람과 싸우고, "아니라니까"가 매 주기 무시당하면 큐 전체의 신뢰가 무너진다.
//  둘 다 ON CONFLICT ... DO UPDATE 의 CASE 식이라 모킹으로는 증명이 안 된다.
//  사양 엣지 표: <스크래치패드>/spec-t5.md (M1~M10, M15)
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59471;
const CNAME = "co-manager-finding-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();

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
  const { itemsPool } = await import("../dist/db/client.js");
  const { initManagerRegistry } = await import("../dist/org/schema/connectors-ingest.js");
  const store = await import("../dist/org/store/managers.js");

  // 감사 테이블 — upsertManager 가 변경을 남긴다(org_content_audit). 이 테스트의 관심사는 아니지만
  //  없으면 저장 자체가 실패하므로 최소 형태로 세운다(실제 스키마는 initOrgCore 가 만든다).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_content_audit(
      id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entity TEXT NOT NULL, entity_key TEXT, op TEXT NOT NULL,
      before JSONB, after JSONB, actor TEXT, actor_kind TEXT, actor_display TEXT,
      source TEXT, channel TEXT, token_hash_prefix TEXT, req_ip TEXT);
    -- audit() 이 actor_kind 를 org_member.kind 에서 파생 조인한다 — 없으면 INSERT 자체가 깨진다.
    CREATE TABLE IF NOT EXISTS org_member(id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'human');
    -- listFindings 가 대상 제목을 보여주려 knowledge 를 LEFT JOIN 하고, M15 가 분류 이동을 검증한다.
    --  실제 스키마(v6)는 훨씬 크지만 이 테스트가 만지는 컬럼만 세운다.
    CREATE TABLE IF NOT EXISTS category(id SERIAL PRIMARY KEY, key TEXT UNIQUE, space TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS knowledge(name TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE IF NOT EXISTS knowledge_category(
      name TEXT NOT NULL, category_id INT NOT NULL, mapped_by TEXT NOT NULL DEFAULT 'rule',
      confidence REAL, state TEXT NOT NULL DEFAULT 'proposed', evidence TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(name, category_id));`);
  await initManagerRegistry(itemsPool);
  ok("스키마 생성");

  // 관리기 2개 — 같은 대상을 서로 다른 관리기가 봐도 별개 행이어야 한다(M9).
  const m1 = await store.upsertManager({ key: "m-one", kind: "mismatch", enabled: true }, "itest");
  const m2 = await store.upsertManager({ key: "m-two", kind: "outdated", enabled: true }, "itest");
  ok("관리기 2개 생성");

  const F = (over = {}) => ({
    target_kind: "knowledge", target_ref: "k-알파", dedup_key: "",
    severity: "note", summary: "첫 요약", evidence: "첫 근거", ...over,
  });
  const countOf = async (ref) => Number((await itemsPool.query(
    `SELECT count(*)::int n FROM org_manager_finding WHERE target_ref=$1`, [ref])).rows[0].n);
  const rowOf = async (mid, ref, dk = "") => (await itemsPool.query(
    `SELECT * FROM org_manager_finding WHERE manager_id=$1 AND target_ref=$2 AND dedup_key=$3`, [mid, ref, dk])).rows[0];

  // ── M1 새 발견 ──
  assert.equal(await store.upsertFinding(m1.id, "mismatch", F()), "new");
  assert.equal(await countOf("k-알파"), 1);
  assert.equal((await rowOf(m1.id, "k-알파")).seen_count, 1);
  ok("M1 새 발견 — 행 1개, seen_count=1");

  // ── M2 같은 발견 재보고: 행이 늘지 않는다 ──
  assert.equal(await store.upsertFinding(m1.id, "mismatch", F()), "again");
  assert.equal(await countOf("k-알파"), 1, "재발견이 새 행을 만들었다 — 큐가 사본으로 덮인다");
  assert.equal((await rowOf(m1.id, "k-알파")).seen_count, 2);
  ok("M2 재발견 — 행 그대로, seen_count 만 증가");

  // ── M3 재보고 시 내용은 최신으로 ──
  await store.upsertFinding(m1.id, "mismatch", F({ summary: "새 요약", evidence: "새 근거", severity: "warn" }));
  const upd = await rowOf(m1.id, "k-알파");
  assert.equal(upd.summary, "새 요약");
  assert.equal(upd.evidence, "새 근거");
  assert.equal(upd.severity, "warn");
  ok("M3 재발견 — 요약·근거·심각도가 최신으로 갱신");

  // ── M8 같은 대상 + 다른 dedup_key = 별개 문제 ──
  assert.equal(await store.upsertFinding(m1.id, "mismatch", F({ dedup_key: "cat-a->cat-b" })), "new");
  assert.equal(await countOf("k-알파"), 2, "dedup_key 가 달라도 합쳐졌다 — 한 지식의 서로 다른 문제를 구분 못 한다");
  ok("M8 같은 대상 + 다른 dedup_key = 별개 행");

  // ── M9 다른 관리기 = 별개 행 ──
  assert.equal(await store.upsertFinding(m2.id, "outdated", F()), "new");
  assert.equal(await countOf("k-알파"), 3);
  ok("M9 다른 관리기 + 같은 대상 = 별개 행");

  // ── M10 반려 처리 ──
  const target = await rowOf(m1.id, "k-알파");
  const resolved = await store.resolveFinding(target.id, "rejected", "사람:윤상민", "오탐입니다");
  assert.equal(resolved.state, "rejected");
  assert.ok(resolved.resolved_at, "resolved_at 이 안 찍혔다");
  assert.equal(resolved.resolved_by, "사람:윤상민");
  ok("M10 반려 처리 — state·resolved_at·resolved_by 기록");

  // ── M4·M5 반려한 것은 되살아나지 않는다 (이 파일의 핵심) ──
  const before = await rowOf(m1.id, "k-알파");
  assert.equal(await store.upsertFinding(m1.id, "mismatch", F({ summary: "또 발견" })), "skipped");
  const after = await rowOf(m1.id, "k-알파");
  assert.equal(after.state, "rejected", "반려한 발견이 되살아났다 — 관리기가 사람 판단을 무시한다");
  assert.equal(Number(after.seen_count), Number(before.seen_count) + 1, "관측 자체는 남아야 한다");
  assert.ok(after.resolved_at, "반려 시각이 지워졌다");
  ok("M4·M5 반려는 영속 — 되살아나지 않고, 관측 카운트만 오른다");

  // ── M6 accepted 는 되살아난다(고쳤는데 또 발견 = 새 사실) ──
  const acc = await rowOf(m1.id, "k-알파", "cat-a->cat-b");
  await store.resolveFinding(acc.id, "accepted", "사람:윤상민");
  assert.equal((await rowOf(m1.id, "k-알파", "cat-a->cat-b")).state, "accepted");
  assert.equal(await store.upsertFinding(m1.id, "mismatch", F({ dedup_key: "cat-a->cat-b" })), "again");
  const reopened = await rowOf(m1.id, "k-알파", "cat-a->cat-b");
  assert.equal(reopened.state, "open", "accepted 후 재발견인데 안 열렸다 — 안 고쳐졌거나 재발한 것이다");
  assert.equal(reopened.resolved_at, null, "재개된 발견에 옛 처리시각이 남았다");
  ok("M6 accepted 후 재발견 — 다시 열린다");

  // ── M7 resolved 도 되살아난다 ──
  const res2 = await rowOf(m2.id, "k-알파");
  await store.resolveFinding(res2.id, "resolved", "사람:윤상민");
  assert.equal(await store.upsertFinding(m2.id, "outdated", F()), "again");
  assert.equal((await rowOf(m2.id, "k-알파")).state, "open");
  ok("M7 resolved 후 재발견 — 다시 열린다");

  // ── 목록: 기본은 열린 것만 ──
  const open = await store.listFindings({});
  assert.ok(open.every((f) => f.state === "open"), "기본 목록에 닫힌 발견이 섞였다");
  assert.ok(open.length >= 2);
  const rejected = await store.listFindings({ state: "rejected" });
  assert.equal(rejected.length, 1);
  ok("목록 — 기본은 열린 것만, state 지정 시 그것만");

  // ── 현황 집계 ──
  const ov = await store.managerOverview();
  assert.equal(ov.managers, 2);
  assert.equal(ov.enabled, 2);
  assert.equal(ov.open.total, open.length);
  ok("현황 집계 — 관리기 수·열린 발견 수");

  // ── M15 move_category 자동 조치: 기존 연결을 지우지 않고 rejected 로 내린다 ──
  await itemsPool.query(`INSERT INTO category(key, space, name) VALUES('cat-old','product','옛'),('cat-new','product','새')`);
  await itemsPool.query(`INSERT INTO knowledge(name) VALUES('k-이동')`);
  const oldId = (await itemsPool.query(`SELECT id FROM category WHERE key='cat-old'`)).rows[0].id;
  const newId = (await itemsPool.query(`SELECT id FROM category WHERE key='cat-new'`)).rows[0].id;
  await itemsPool.query(
    `INSERT INTO knowledge_category(name, category_id, state) VALUES('k-이동',$1,'confirmed')`, [oldId]);

  const { applyAction } = await import("../dist/org/manage/run-manager.js");
  const applied = await applyAction(
    { op: "move_category", name: "k-이동", from_category_id: oldId, to_category_id: newId }, "itest");
  assert.equal(applied, true, "분류 이동이 적용되지 않았다");
  const links = (await itemsPool.query(
    `SELECT category_id, state FROM knowledge_category WHERE name='k-이동' ORDER BY category_id`)).rows;
  assert.equal(links.length, 2, "옛 연결이 삭제됐다 — 되돌릴 수 없게 된다");
  assert.equal(links.find((l) => l.category_id === oldId).state, "rejected", "옛 연결이 rejected 로 안 내려갔다");
  assert.equal(links.find((l) => l.category_id === newId).state, "confirmed");
  ok("M15 분류 이동 — 옛 연결은 지우지 않고 rejected(되돌릴 수 있게), 새 연결 confirmed");

  // ── M16 비가역 op 는 자동 적용하지 않는다 ──
  assert.equal(await applyAction({ op: "review_knowledge", name: "k-이동" }, "itest"), false);
  assert.equal(await applyAction({ op: "delete_knowledge", name: "k-이동" }, "itest"), false);
  assert.equal(await applyAction(null, "itest"), false);
  ok("M16·M17 비가역·미지 op 는 적용 안 함");

  // ── M18 미발견 자동 해소 — 큐가 '고쳐서' 줄어든다 (#1419 도그푸드 2차) ──
  //  이게 없으면 사람이 문서를 고쳐도 발견이 open 으로 영원히 남아 큐가 단조증가한다.
  //  ⚠ 실DB 여야 하는 이유: 판정이 `last_seen_at < <스윕 시작 시각>` 이라 시각 비교와 상태 CASE 가
  //   SQL 안에 있다. 모킹으로는 '반려는 안 닫는다'를 증명할 수 없다.
  {
    const m3 = await store.upsertManager({ key: "m-sweep", kind: "mismatch", enabled: true }, "itest");
    const keep = await store.upsertFinding(m3.id, "mismatch", F({ target_ref: "k-유지", dedup_key: "a" }));
    const drop = await store.upsertFinding(m3.id, "mismatch", F({ target_ref: "k-사라짐", dedup_key: "b" }));
    const rej  = await store.upsertFinding(m3.id, "mismatch", F({ target_ref: "k-반려", dedup_key: "c" }));
    assert.deepEqual([keep, drop, rej], ["new", "new", "new"]);
    const idOf = async (ref) => (await store.listFindings({ managerId: m3.id, state: "open" }))
      .find((f) => f.target_ref === ref)?.id;
    await store.resolveFinding(await idOf("k-반려"), "rejected", "사람:윤상민", "오탐");

    // 스윕 시작 시각을 찍고 — k-유지만 다시 발견한다(나머지는 '이번에 못 본 것'이 된다).
    await new Promise((r) => setTimeout(r, 50));   // now() 해상도상 last_seen_at 과 확실히 갈리게
    const sweepStart = (await itemsPool.query("SELECT now() AS t")).rows[0].t;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await store.upsertFinding(m3.id, "mismatch", F({ target_ref: "k-유지", dedup_key: "a" })), "again");

    const n = await store.resolveUnseenFindings(m3.id, sweepStart, "itest");
    assert.equal(n, 1, "미발견 1건(k-사라짐)만 닫아야 한다");

    const open = (await store.listFindings({ managerId: m3.id, state: "open" })).map((f) => f.target_ref);
    assert.deepEqual(open, ["k-유지"], "다시 발견된 것만 열려 있어야 한다");
    const resolved = (await store.listFindings({ managerId: m3.id, state: "resolved" })).map((f) => f.target_ref);
    assert.deepEqual(resolved, ["k-사라짐"]);
    // 반려는 건드리지 않는다 — 사람의 '오탐이다'가 최신 판단이고, resolved 로 바꾸면 그 판단이 지워진다.
    const rejected = (await store.listFindings({ managerId: m3.id, state: "rejected" })).map((f) => f.target_ref);
    assert.deepEqual(rejected, ["k-반려"], "반려는 자동 해소가 건드리면 안 된다");
    ok("M18 미발견 자동 해소 — 다시 발견된 것만 열림 · 반려는 불변");
  }

  console.log(`\n${pass} passed`);
  await itemsPool.end();
} finally {
  try { sh(`docker rm -f ${CNAME}`); } catch { /* */ }
}
