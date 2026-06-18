// P-V3-3a 단일스토어 스키마 확장 — DB 통합 체크. 실행: npm run build && node --env-file-if-exists=.env dist/org/schema-p3a.test.js
//  ITEMS_DATABASE_URL 미설정이면 graceful skip(보고만, 실패 아님 — 순수 빌드 게이트 환경 보호).
//  **비파괴**: 모든 쓰기는 'p3a_test__' 접두 임시 행으로만, finally 에서 정리. CHECK 위반은 SAVEPOINT/ROLLBACK 으로
//   격리해 실 데이터 무영향. 커버: (1) observed enum CHECK (2) 다중도메인/프로젝트 조인 + cascade
//   (3) 멱등 재실행(initOrgSchema 2회) (4) overview 의 observed 별도 카운트(인덱스/검토 제외 배선) (5) 신 컬럼/인덱스 존재.
import assert from "node:assert/strict";
import { itemsPool } from "../items/store.js";
import { initOrgSchema } from "./schema.js";
import { upsertKnowledge, overviewKnowledge, removeKnowledge } from "./knowledge.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

const PREFIX = "p3a_test__";

async function main(): Promise<void> {
  if (!process.env.ITEMS_DATABASE_URL) {
    console.log("skip  ITEMS_DATABASE_URL 미설정 — P-V3-3a DB 통합 체크 건너뜀(빌드 게이트는 통과)");
    return;
  }

  // 스키마 보장(멱등 1회).
  await initOrgSchema();

  // 정리(이전 잔여 + 종료 시) — 임시 접두 행만 삭제(실 데이터 무영향).
  const cleanup = async (): Promise<void> => {
    await itemsPool.query(`DELETE FROM knowledge_unit_domain  WHERE name LIKE $1`, [PREFIX + "%"]);
    await itemsPool.query(`DELETE FROM knowledge_unit_project WHERE name LIKE $1`, [PREFIX + "%"]);
    await itemsPool.query(`DELETE FROM knowledge_unit         WHERE name LIKE $1`, [PREFIX + "%"]);
  };
  await cleanup();

  try {
    // ── (5) 신 컬럼 존재(가산적 ADD COLUMN) ──
    await t("신 컬럼 존재: source/external_*/sync_state/last_synced_at/occurred_at/parent_*/fields/raw", async () => {
      const cols = (await itemsPool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='knowledge_unit'`,
      )).rows.map((r) => r.column_name as string);
      for (const c of ["source", "external_system", "external_instance", "external_id", "external_url",
        "sync_state", "last_synced_at", "occurred_at", "parent_external_id", "parent_name", "fields", "raw"]) {
        assert.ok(cols.includes(c), `컬럼 누락: ${c}`);
      }
    });

    await t("신 인덱스/테이블 존재: external uidx · trgm(가용시) · 조인 테이블 2종", async () => {
      const idx = (await itemsPool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename='knowledge_unit'`,
      )).rows.map((r) => r.indexname as string);
      assert.ok(idx.includes("knowledge_unit_external_uidx"), "부분 유니크 인덱스 누락");
      assert.ok(idx.includes("knowledge_unit_source_idx"));
      const tabs = (await itemsPool.query(
        `SELECT to_regclass('knowledge_unit_domain') d, to_regclass('knowledge_unit_project') p`,
      )).rows[0];
      assert.ok(tabs.d, "knowledge_unit_domain 누락");
      assert.ok(tabs.p, "knowledge_unit_project 누락");
      // pg_trgm 은 가용 시에만(graceful) — 가용이면 인덱스도 있어야.
      const trgm = (await itemsPool.query(`SELECT 1 FROM pg_extension WHERE extname='pg_trgm'`)).rowCount;
      if (trgm) {
        assert.ok(idx.includes("knowledge_unit_title_trgm_idx"), "trgm 가용인데 title 인덱스 누락");
        assert.ok(idx.includes("knowledge_unit_body_trgm_idx"), "trgm 가용인데 body 인덱스 누락");
        console.log("    (pg_trgm 가용 — GIN trgm 인덱스 적용 확인)");
      } else {
        console.log("    (pg_trgm 미가용 — graceful skip, ILIKE 인덱스 없이 동작)");
      }
    });

    // ── (1) observed enum CHECK — confidence 에 observed 허용, 잘못된 값 거부 ──
    await t("confidence CHECK: 'observed' 허용 / 잘못된 값 거부", async () => {
      // observed 직접 INSERT 통과(upsertKnowledge 는 source 로 confidence 강제하므로 raw INSERT 로 enum 검증).
      const okName = PREFIX + "obs1";
      await itemsPool.query(
        `INSERT INTO knowledge_unit(name, kind, confidence, lifecycle, source, external_system, external_id)
           VALUES($1,'K','observed','active','slack','slack','ext-1')
         ON CONFLICT (name) DO UPDATE SET confidence='observed'`, [okName]); // V4-P2a: A→K(흡수), observed 가 외부수집 표현
      const got = (await itemsPool.query(`SELECT confidence FROM knowledge_unit WHERE name=$1`, [okName])).rows[0];
      assert.equal(got.confidence, "observed");
      // 잘못된 값은 CHECK 위반(에러) — SAVEPOINT 없이 단일 쿼리라 트랜잭션 오염 없음.
      await assert.rejects(
        itemsPool.query(`INSERT INTO knowledge_unit(name, confidence) VALUES($1,'bogus')`, [PREFIX + "bad"]),
        /knowledge_unit_confidence_chk|violates check/i,
      );
      // ai/rule/human 도 여전히 허용(부분집합 무손상).
      for (const c of ["ai", "rule", "human"]) {
        await itemsPool.query(
          `INSERT INTO knowledge_unit(name, confidence) VALUES($1,$2)
             ON CONFLICT (name) DO UPDATE SET confidence=$2`, [PREFIX + "c_" + c, c]);
      }
    });

    // ── (4) overview: observed 는 active_count/total_active 에서 빠지고 observed_count 로만 집계(인덱스/검토 제외 배선) ──
    await t("overview: observed 별도 카운트(active/review 와 분리)", async () => {
      const before = await overviewKnowledge();
      // 큐레이션 1 + observed 1 을 K kind 로 추가.
      await upsertKnowledge({ name: PREFIX + "ov_curated", kind: "K", title: "큐", body_md: "x" }, "test", "web"); // → human
      await itemsPool.query(
        `INSERT INTO knowledge_unit(name, kind, confidence, lifecycle, title, body_md, source)
           VALUES($1,'K','observed','active','수집','y','slack')
         ON CONFLICT (name) DO UPDATE SET confidence='observed', kind='K', lifecycle='active'`, [PREFIX + "ov_obs"]);
      const after = await overviewKnowledge();
      assert.ok("observed_count" in after, "observed_count 필드 존재");
      assert.equal(after.observed_count - before.observed_count, 1, "observed 1 증가");
      assert.equal(after.total_active - before.total_active, 1, "큐레이션 active 만 +1(observed 제외)");
      // K kind active_count 는 큐레이션만 +1(observed 제외).
      const kBefore = before.kinds.find((k) => k.kind === "K")?.active_count ?? 0;
      const kAfter = after.kinds.find((k) => k.kind === "K")?.active_count ?? 0;
      assert.equal(kAfter - kBefore, 1, "K active_count 는 큐레이션만(observed 제외)");
      // review_pending 은 'ai' 만 — observed 추가는 review 에 영향 0.
      assert.equal(after.review_pending - before.review_pending, 0, "observed 는 검토 큐에 영향 0");
    });

    // ── (2) 다중도메인/프로젝트 조인 + cascade ──
    await t("다중도메인 조인: 한 단위가 도메인 여러개 귀속 + cascade 삭제", async () => {
      const name = PREFIX + "multi";
      await upsertKnowledge({ name, kind: "K", title: "수집물", body_md: "z" }, "test", "mcp"); // → ai (V4-P2a: A→K)
      await itemsPool.query(
        `INSERT INTO knowledge_unit_domain(name, repo, domain_key, mapped_by, confidence, state)
           VALUES ($1,'r','billing','rule',0.9,'confirmed'), ($1,'r','auth','llm',0.5,'proposed')
         ON CONFLICT DO NOTHING`, [name]);
      await itemsPool.query(
        `INSERT INTO knowledge_unit_project(name, repo, project_key, mapped_by, state)
           VALUES ($1,'r','proj-x','declared','confirmed')
         ON CONFLICT DO NOTHING`, [name]);
      const dCount = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit_domain WHERE name=$1`, [name])).rows[0].n;
      const pCount = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit_project WHERE name=$1`, [name])).rows[0].n;
      assert.equal(dCount, 2, "도메인 2개 귀속");
      assert.equal(pCount, 1, "프로젝트 1개 귀속");
      // cascade: 단위 삭제 → 조인 행도 삭제.
      await removeKnowledge(name, "test", "mcp");
      const dAfter = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit_domain WHERE name=$1`, [name])).rows[0].n;
      assert.equal(dAfter, 0, "단위 삭제 시 도메인 매핑 cascade 삭제");
    });

    await t("조인 테이블 CHECK: state/mapped_by enum 위반 거부", async () => {
      const name = PREFIX + "multi"; // 위에서 cascade 로 비었지만 단위가 없으므로 FK 위반 전에 단위 재생성.
      await upsertKnowledge({ name, kind: "K", body_md: "z" }, "test", "mcp"); // V4-P2a: A→K
      await assert.rejects(
        itemsPool.query(`INSERT INTO knowledge_unit_domain(name, repo, domain_key, state) VALUES($1,'r','d','bogus')`, [name]),
        /state_chk|violates check/i,
      );
      await assert.rejects(
        itemsPool.query(`INSERT INTO knowledge_unit_domain(name, repo, domain_key, mapped_by) VALUES($1,'r','d2','bogus')`, [name]),
        /mappedby_chk|violates check/i,
      );
      await removeKnowledge(name, "test", "mcp");
    });

    // ── (3) 멱등 재실행: initOrgSchema 2회 더 호출해도 throw 없음 + 4 kind(R/K/H/W) 무손상 ──
    //  V4-P2a: 본질 4종 narrow — 시드 4행 + legacy DELETE 가 멱등(재실행해도 4 유지).
    await t("멱등: initOrgSchema 재실행 무피해 + 4 kind(R/K/H/W) 유지", async () => {
      const kindBefore = (await itemsPool.query(`SELECT count(*)::int n FROM kind_registry`)).rows[0].n;
      await initOrgSchema();
      await initOrgSchema();
      const kindAfter = (await itemsPool.query(`SELECT count(*)::int n FROM kind_registry`)).rows[0].n;
      assert.equal(kindAfter, kindBefore, "kind_registry 행수 불변(멱등)");
      assert.equal(kindAfter, 4, "4 kind(R/K/H/W) 유지");
      const kinds = (await itemsPool.query(`SELECT kind FROM kind_registry ORDER BY kind`)).rows.map((r) => r.kind);
      assert.deepEqual(kinds, ["H", "K", "R", "W"], "R/K/H/W 만 남음(legacy 제거)");
    });

  } finally {
    await cleanup();
    await itemsPool.end();
  }

  console.log(`\n${pass} checks passed`);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
