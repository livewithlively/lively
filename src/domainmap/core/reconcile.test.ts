// reconcile(ingest) 사양 기반 테스트(#1313 R7) — 분해 선행 안전망. 얇은 Db 페이크(쿼리 라우팅 스텁,
//  node-usable-gate.test.ts 의 주입 페이크 계열 — 여기선 itemsPool.query/connect 를 페이크로 치환)로
//  실 DB 없이 결정론 검증. export 표면(ingest/refresh)·행위만 본다 — 분해 후에도 무수정 통과가 계약.
//  사양 출처: reconcile.ts 헤더 — P6a 신뢰우선(자동매핑/도메인은 proposed 림보 없이 곧바로 confirmed),
//  '비-agent 소유(origin∈{human,source}) 절대 미덮어쓰기'(다르면 drift 기록 후 보존), mapping kept-* 는
//  change_log 무기록, 모든 쓰기 단일 트랜잭션. + refresh.ts 헤더의 HARD INVARIANT(refresh 는 mapping
//  테이블에 어떤 쓰기도 하지 않는다 — rename 은 같은 code_unit 행 UPDATE, delete 는 soft)를 실행 단언으로.
//  실행: npm run build && node dist/domainmap/core/reconcile.test.js
//
// ── 입력 조합 × 기대 (엣지 표 — 행마다 테스트 ≥1) ─────────────────────────────
// #   | 시나리오(입력 조합)                                      | 기대
// R1  | 신규 도메인+code_unit+매핑 agent ingest                  | category/mapping 즉시 status='confirmed'·origin='agent'(신뢰우선), tally domain:insert/code_unit/mapping:insert
// R2  | R1 과 동일 페이로드 재인제스트(멱등)                     | domain:unchanged·mapping:unchanged, category UPDATE 미실행, change_log 무증가
// R3  | agent 자기 confirmed 행 + 값 변경 재인제스트             | domain:update + category 값 갱신 + change_log op='update'
// R4  | human 소유 category 에 agent 가 다른 값 제안             | domain:drift, 기존 값 보존(UPDATE category 미실행), change_log op='drift'
// R5  | human 소유 category 에 agent 가 같은 값                  | domain:unchanged (drift 아님)
// R6  | human 소유 mapping 재인제스트(agent)                     | mapping:kept-confirmed, change_log 무기록, mapping 행 불변
// R7  | agent 소유 rejected mapping 재인제스트                   | mapping:kept-rejected (사람 기각 보존)
// R8  | 매핑의 domain_key 가 어디에도 없음(빈 경우 행)           | mapping:skip-nodomain (매핑 미생성)
// R9  | 매핑 target 이 payload code_units 에 없음(빈 경우 행)    | mapping:skip-notarget (매핑 미생성)
// R10 | 도메인 선언 생략 + DB 기존 category 존재(멀티레포 공유)  | DB 폴백 해소 → mapping:insert, category 신규 미생성
// R11 | 트랜잭션: 페이로드 중도 실패                             | ingest reject + ROLLBACK 발행(부분 상태 없음)
// R12 | HARD INVARIANT: refresh(R/D/A) 실행                      | mapping 테이블 쓰기 0건, rename=같은 행 UPDATE(id 불변), delete=soft(state='removed'), 매핑 스냅샷 그대로, orphan 표면화(tally.orphaned)
import assert from "node:assert/strict";
import { itemsPool } from "../db.js";
import { ingest } from "./reconcile.js";
import { refresh } from "./refresh.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// ── 얇은 Db 페이크 — SQL fragment 라우팅 + 인메모리 테이블. 트랜잭션 문(BEGIN 등)은 no-op. ──
type Row = Record<string, any>;
class FakeDb {
  seq = 0;
  repos: Row[] = []; scanRuns: Row[] = []; categories: Row[] = []; codeUnits: Row[] = [];
  dataEntities: Row[] = []; mappings: Row[] = []; changeLog: Row[] = []; debts: Row[] = [];
  log: { sql: string; params: unknown[] }[] = [];
  failOn: string | null = null;      // 이 fragment 매치 시 1회 throw(트랜잭션 롤백 검증용)
  lockAfterFinish = false;           // 다음 scan_run finish '이후'의 비-트랜잭션 쿼리 거부(refresh post-txn 백스톱 차단)
  finished = false;
  nid() { return ++this.seq; }
  armPostFinishLock() { this.lockAfterFinish = true; this.finished = false; }

  async query(sqlIn: unknown, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const sql = String(sqlIn).replace(/\s+/g, " ").trim();
    this.log.push({ sql, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] }; // 트랜잭션 제어문은 락다운과 무관하게 통과
    if (this.lockAfterFinish && this.finished) throw new Error("post-finish lockdown (test)");
    if (this.failOn && sql.includes(this.failOn)) { this.failOn = null; throw new Error("forced failure (test)"); }
    const p = params as any[];

    // repo
    if (sql.startsWith("SELECT * FROM repo WHERE name=")) return { rows: this.repos.filter((r) => r.name === p[0]) };
    if (sql.startsWith("INSERT INTO repo(")) {
      const r = { id: this.nid(), name: p[0], root_path: p[1], detected_stack: p[2], last_refreshed_sha: null };
      this.repos.push(r); return { rows: [{ id: r.id }] };
    }
    if (sql.startsWith("UPDATE repo SET root_path=")) {
      const r = this.repos.find((x) => x.id === p[3]); if (r) { r.root_path = p[0]; r.detected_stack = p[1]; } return { rows: [] };
    }
    if (sql.startsWith("UPDATE repo SET last_refreshed_sha=")) {
      const r = this.repos.find((x) => x.id === p[1]); if (r) r.last_refreshed_sha = p[0]; return { rows: [] };
    }

    // scan_run
    if (sql.startsWith("INSERT INTO scan_run(")) {
      const r = { id: this.nid(), repo_id: p[0] }; this.scanRuns.push(r); return { rows: [{ id: r.id }] };
    }
    if (sql.startsWith("UPDATE scan_run SET finished_at=")) { this.finished = true; return { rows: [] }; }

    // category (도메인) — upsertCategory(SELECT *)와 매핑 폴백(SELECT id) 둘 다.
    if (/^SELECT (\*|id) FROM category WHERE space='product' AND key=/.test(sql)) {
      return { rows: this.categories.filter((c) => c.key === p[0] && c.state !== "merged") };
    }
    if (sql.startsWith("INSERT INTO category(")) {
      const r = { id: this.nid(), space: "product", key: p[0], name: p[1], description: p[2], state: p[3], cross_cutting: p[4], origin: p[5], status: "confirmed" };
      this.categories.push(r); return { rows: [{ id: r.id }] };
    }
    if (sql.startsWith("UPDATE category SET name=")) {
      const r = this.categories.find((c) => c.id === p[3]); if (r) { r.name = p[0]; r.description = p[1]; } return { rows: [] };
    }

    // change_log — 유일 writer 인 logChange 의 컬럼 순서(파라미터 위치) 기준.
    if (sql.startsWith("INSERT INTO change_log(")) {
      const r = { id: this.nid(), repo_id: p[0], entity_type: p[1], entity_id: p[2], op: p[3], actor_type: p[4], note: p[10] };
      this.changeLog.push(r); return { rows: [{ id: r.id }] };
    }

    // code_unit — 구체 매치를 앞에(상태 필터·dest 변형 → 일반형 순).
    if (sql.includes("FROM code_unit") && sql.includes("COALESCE(state,'active')='active'") && sql.startsWith("SELECT *")) {
      return { rows: this.codeUnits.filter((u) => u.repo_id === p[0] && u.path === p[1] && (u.state ?? "active") === "active") };
    }
    if (sql.startsWith("SELECT id, COALESCE(state,$2) state FROM code_unit")) {
      return { rows: this.codeUnits.filter((u) => u.repo_id === p[0] && u.path === p[2]).map((u) => ({ id: u.id, state: u.state ?? p[1] })) };
    }
    if (sql.startsWith("SELECT path FROM code_unit WHERE repo_id=")) {
      return { rows: this.codeUnits.filter((u) => u.repo_id === p[0] && (u.state ?? "active") === "active").map((u) => ({ path: u.path })) };
    }
    if (/^SELECT (\*|id) FROM code_unit WHERE repo_id=\$1 AND path=\$2$/.test(sql)) {
      return { rows: this.codeUnits.filter((u) => u.repo_id === p[0] && u.path === p[1]) };
    }
    if (sql.startsWith("INSERT INTO code_unit(repo_id,kind,path,label,state")) { // refresh addPath(6컬럼)
      const r = { id: this.nid(), repo_id: p[0], kind: p[1], path: p[2], label: p[3], state: p[4] };
      this.codeUnits.push(r); return { rows: [{ id: r.id }] };
    }
    if (sql.startsWith("INSERT INTO code_unit(repo_id,kind,path,label,created_at)")) { // reconcile(5컬럼)
      const r = { id: this.nid(), repo_id: p[0], kind: p[1], path: p[2], label: p[3], state: "active" };
      this.codeUnits.push(r); return { rows: [{ id: r.id }] };
    }
    if (sql.startsWith("UPDATE code_unit SET path=$1,prev_path=$2")) {
      const r = this.codeUnits.find((u) => u.id === p[3]); if (r) { r.path = p[0]; r.prev_path = p[1]; } return { rows: [] };
    }
    if (sql.startsWith("UPDATE code_unit SET state='removed'")) {
      const r = this.codeUnits.find((u) => u.id === p[1]); if (r) r.state = "removed"; return { rows: [] };
    }
    if (sql.startsWith("UPDATE code_unit SET state='active'")) {
      const r = this.codeUnits.find((u) => u.id === p[1]); if (r) r.state = "active"; return { rows: [] };
    }

    // data_entity
    if (sql.startsWith("SELECT id FROM data_entity")) {
      return { rows: this.dataEntities.filter((e) => e.repo_id === p[0] && e.kind === p[1] && e.name === p[2] && (e.source ?? "") === p[3]) };
    }
    if (sql.startsWith("INSERT INTO data_entity(")) {
      const r = { id: this.nid(), repo_id: p[0], kind: p[1], name: p[2], source: p[3] };
      this.dataEntities.push(r); return { rows: [{ id: r.id }] };
    }

    // mapping — SELECT 는 허용(HARD INVARIANT 는 '쓰기' 금지).
    if (sql.startsWith("SELECT * FROM mapping WHERE target_kind=")) {
      return { rows: this.mappings.filter((m) => m.target_kind === p[0] && m.target_id === p[1] && m.category_id === p[2]) };
    }
    if (sql.startsWith("SELECT m.id, c.key domain_key")) { // refresh 의 orphan confirmed 매핑 조회(읽기)
      return {
        rows: this.mappings.filter((m) => m.target_kind === "code_unit" && m.target_id === p[0] && m.status === "confirmed")
          .map((m) => { const c = this.categories.find((x) => x.id === m.category_id); return { id: m.id, domain_key: c?.key, domain_name: c?.name }; }),
      };
    }
    if (sql.startsWith("INSERT INTO mapping(")) {
      const r = { id: this.nid(), repo_id: p[0], target_kind: p[1], target_id: p[2], category_id: p[3], origin: p[4], confidence: p[5], status: "confirmed", run_id: p[6] };
      this.mappings.push(r); return { rows: [{ id: r.id }] };
    }

    // debt_finding(refresh 의 flagStructuralDrift)
    if (sql.startsWith("SELECT * FROM debt_finding WHERE repo_id=")) {
      return { rows: this.debts.filter((d) => d.repo_id === p[0] && d.title === p[1]) };
    }
    if (sql.startsWith("INSERT INTO debt_finding(")) {
      const r = { id: this.nid(), repo_id: p[0], kind: p[1], title: p[2], status: "open" };
      this.debts.push(r); return { rows: [{ id: r.id }] };
    }

    // is-엣지 stale sweep(이 테스트에선 잔여 없음)
    if (sql.includes("FROM category_edge")) return { rows: [] };

    throw new Error("unhandled SQL in FakeDb: " + sql);
  }
}

const fake = new FakeDb();
// 주입 seam: 코드가 쓰는 유일한 DB 표면(itemsPool.query / withTx 의 connect)을 페이크로 치환.
(itemsPool as any).query = (sql: unknown, params?: unknown[]) => fake.query(sql, params ?? []);
(itemsPool as any).connect = async () => ({
  query: (sql: unknown, params?: unknown[]) => fake.query(sql, params ?? []),
  release() { /* no-op */ },
});

const payload = (over: Record<string, unknown> = {}) => ({
  repo: { name: "repo-a", root_path: "/r" },
  run: { actor_type: "agent", actor_id: "tester" },
  domains: [{ key: "billing", name: "빌링", description: "결제" }],
  code_units: [{ kind: "module", path: "src/billing", label: "billing" }],
  mappings: [{ target_kind: "code_unit", target: "src/billing", domain_key: "billing", confidence: 0.9 }],
  ...over,
});

// mapping 테이블에 대한 '쓰기' SQL 로그 필터(HARD INVARIANT 판정) — mapping_* 유사명 오탐 없게 \b 경계.
const mappingWrites = () =>
  fake.log.filter((e) => /(INSERT INTO|UPDATE|DELETE FROM)\s+mapping\b/i.test(e.sql));

async function main() {
  // R1 — 신뢰우선: 신규 도메인/매핑이 proposed 림보 없이 곧바로 confirmed 로 착지, origin=actor.type.
  const r1 = await ingest(payload());
  assert.deepEqual(r1.tally, { "domain:insert": 1, "code_unit": 1, "mapping:insert": 1 });
  assert.equal(fake.categories.length, 1);
  assert.equal(fake.categories[0].status, "confirmed");
  assert.equal(fake.categories[0].origin, "agent");
  assert.equal(fake.mappings.length, 1);
  assert.equal(fake.mappings[0].status, "confirmed");
  assert.equal(fake.mappings[0].origin, "agent");
  ok("R1 신뢰우선 — 신규 도메인/매핑 즉시 confirmed(origin=agent), tally insert");

  // R2 — 멱등 재인제스트: 전부 unchanged, category UPDATE 미실행, change_log 무증가.
  const logsBefore = fake.changeLog.length;
  const r2 = await ingest(payload());
  assert.equal(r2.tally["domain:unchanged"], 1);
  assert.equal(r2.tally["mapping:unchanged"], 1);
  assert.equal(fake.changeLog.length, logsBefore);
  assert.ok(!fake.log.some((e) => e.sql.startsWith("UPDATE category SET name=")));
  ok("R2 동일 페이로드 재인제스트 → unchanged · change_log 무증가 · UPDATE 미실행");

  // R3 — agent 자기 confirmed 행 값 변경 → 정상 update + change_log op='update'.
  const r3 = await ingest(payload({ domains: [{ key: "billing", name: "빌링v2", description: "결제" }] }));
  assert.equal(r3.tally["domain:update"], 1);
  assert.equal(fake.categories[0].name, "빌링v2");
  assert.ok(fake.changeLog.some((c) => c.entity_type === "category" && c.op === "update"));
  ok("R3 agent 자기 행 값 변경 → domain:update + 값 갱신 + change_log update");

  // R4 — human 소유 행에 agent 가 다른 값 → drift 기록 + 기존 값 보존(덮어쓰기 금지).
  fake.categories[0].origin = "human"; // 사람 큐레이션 소유로 전환(사양: origin 이 소유 판별 키)
  const catUpdatesBefore = fake.log.filter((e) => e.sql.startsWith("UPDATE category")).length;
  const r4 = await ingest(payload({ domains: [{ key: "billing", name: "agent 제안", description: "다른설명" }] }));
  assert.equal(r4.tally["domain:drift"], 1);
  assert.equal(fake.categories[0].name, "빌링v2", "human 소유 값은 보존되어야 함");
  assert.equal(fake.log.filter((e) => e.sql.startsWith("UPDATE category")).length, catUpdatesBefore, "UPDATE category 미실행");
  assert.ok(fake.changeLog.some((c) => c.entity_type === "category" && c.op === "drift"));
  ok("R4 human 소유 + agent 제안 상이 → drift 기록·기존 값 보존·UPDATE 0건");

  // R5 — human 소유 + 같은 값 → unchanged (drift 아님).
  const r5 = await ingest(payload({ domains: [{ key: "billing", name: "빌링v2", description: "결제" }] }));
  assert.equal(r5.tally["domain:unchanged"], 1);
  assert.equal(r5.tally["domain:drift"], undefined);
  ok("R5 human 소유 + 동일 값 → unchanged(드리프트 아님)");

  // R6 — human 소유 mapping → kept-confirmed, change_log 무기록, 행 불변.
  fake.mappings[0].origin = "human";
  const mapSnapshot = JSON.stringify(fake.mappings[0]);
  const mapLogsBefore6 = fake.changeLog.filter((c) => c.entity_type === "mapping").length;
  const r6 = await ingest(payload({ domains: [] }));
  assert.equal(r6.tally["mapping:kept-confirmed"], 1);
  assert.equal(fake.changeLog.filter((c) => c.entity_type === "mapping").length, mapLogsBefore6, "kept-* 는 change_log 무기록");
  assert.equal(JSON.stringify(fake.mappings[0]), mapSnapshot, "mapping 행 불변");
  ok("R6 human 소유 mapping → kept-confirmed · change_log 무기록 · 행 불변");

  // R7 — agent 소유 rejected mapping(사람 기각) → kept-rejected.
  fake.mappings[0].origin = "agent";
  fake.mappings[0].status = "rejected";
  const r7 = await ingest(payload({ domains: [] }));
  assert.equal(r7.tally["mapping:kept-rejected"], 1);
  assert.equal(fake.mappings[0].status, "rejected", "기각 상태 보존");
  fake.mappings[0].status = "confirmed"; // 이후 시나리오 복원
  ok("R7 agent 소유 rejected → kept-rejected(사람 기각 보존)");

  // R8 — 미지 domain_key(도메인 선언도 DB 행도 없음) → skip-nodomain, 매핑 미생성.
  const mapsBefore8 = fake.mappings.length;
  const r8 = await ingest(payload({
    domains: [], mappings: [{ target_kind: "code_unit", target: "src/billing", domain_key: "ghost", confidence: 0.5 }],
  }));
  assert.equal(r8.tally["mapping:skip-nodomain"], 1);
  assert.equal(fake.mappings.length, mapsBefore8);
  ok("R8 미지 domain_key → mapping:skip-nodomain · 매핑 미생성");

  // R9 — 매핑 target 이 payload code_units 에 없음 → skip-notarget.
  const r9 = await ingest(payload({
    domains: [], code_units: [],
    mappings: [{ target_kind: "code_unit", target: "src/unknown", domain_key: "billing", confidence: 0.5 }],
  }));
  assert.equal(r9.tally["mapping:skip-notarget"], 1);
  ok("R9 payload 에 없는 target → mapping:skip-notarget");

  // R10 — 도메인 선언 생략 + DB 기존 category → DB 폴백으로 해소(멀티레포 공유), 신규 category 미생성.
  const catsBefore10 = fake.categories.length;
  const r10 = await ingest(payload({
    domains: [],
    code_units: [{ kind: "module", path: "src/billing-b", label: "b" }],
    mappings: [{ target_kind: "code_unit", target: "src/billing-b", domain_key: "billing", confidence: 0.7 }],
  }));
  assert.equal(r10.tally["mapping:insert"], 1);
  assert.equal(fake.categories.length, catsBefore10, "기존 category 공유 — 신규 생성 없음");
  const newMap = fake.mappings[fake.mappings.length - 1];
  assert.equal(newMap.category_id, fake.categories[0].id);
  ok("R10 도메인 선언 생략 + DB 기존 category → 같은 행 공유로 매핑 착지");

  // R11 — 트랜잭션: 중도 실패 → reject + ROLLBACK 발행(단일 트랜잭션 사양).
  fake.failOn = "INSERT INTO mapping";
  const rollbacksBefore = fake.log.filter((e) => /^ROLLBACK/i.test(e.sql)).length;
  await assert.rejects(() => ingest(payload({
    domains: [], code_units: [{ kind: "module", path: "src/c", label: "c" }],
    mappings: [{ target_kind: "code_unit", target: "src/c", domain_key: "billing", confidence: 0.5 }],
  })), /forced failure/);
  assert.equal(fake.log.filter((e) => /^ROLLBACK/i.test(e.sql)).length, rollbacksBefore + 1);
  ok("R11 페이로드 중도 실패 → ingest reject + ROLLBACK(부분 상태 없음)");

  // R12 — HARD INVARIANT: refresh 는 mapping 테이블에 어떤 쓰기도 하지 않는다.
  //  rename: 같은 code_unit 행 UPDATE(row identity 로 매핑 생존) · delete: soft(state='removed') + orphan 표면화.
  const unit = fake.codeUnits.find((u) => u.path === "src/billing")!;
  const unitId = unit.id;
  const mappingsSnapshot = JSON.stringify(fake.mappings);
  const writesBefore = mappingWrites().length; // (이전 ingest 의 정당한 INSERT 들)
  fake.armPostFinishLock(); // post-txn 백스톱(domain-debt)은 이 테스트 범위 밖 — 결정론 차단
  const r12 = await refresh("repo-a", {
    head: "b".repeat(40),
    changes: [
      { status: "R", from: "src/billing", to: "src/billing-core", score: 95 },
      { status: "D", path: "src/billing-b" },
      { status: "A", path: "src/fresh" },
    ],
  }, { type: "agent", id: "tester" });
  fake.lockAfterFinish = false;
  assert.equal(mappingWrites().length, writesBefore, "HARD INVARIANT: refresh 중 mapping 쓰기 0건");
  assert.equal(JSON.stringify(fake.mappings), mappingsSnapshot, "mapping 행 스냅샷 그대로");
  const renamed = fake.codeUnits.find((u) => u.id === unitId)!;
  assert.equal(renamed.path, "src/billing-core", "rename = 같은 행 UPDATE(id 불변)");
  assert.equal(renamed.prev_path, "src/billing");
  const removed = fake.codeUnits.find((u) => u.path === "src/billing-b")!;
  assert.equal(removed.state, "removed", "delete 는 soft — 행 존속");
  assert.equal(r12.tally.renamed, 1);
  assert.equal(r12.tally.deleted, 1);
  assert.equal(r12.tally.added, 1);
  assert.equal(r12.tally.orphaned, 1, "confirmed 매핑 붙은 삭제는 orphan 으로 표면화(침묵 금지)");
  ok("R12 HARD INVARIANT — refresh: mapping 무쓰기·row-identity rename·soft delete·orphan 표면화");
}

main().then(
  () => { console.log(`\n${pass} passed`); },
  (err) => { console.error(err); process.exit(1); },
);
