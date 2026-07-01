// #290 데이터 마이그레이션 — 카테고리 단일화(33건) + page-type 휴리스틱 + (옵션)회의→자료.
//  실행: node --env-file=<게이트웨이 .env> scripts/290-single-and-source.mjs
//   · DRY=1 → 미리보기(쓰기 없음).  · MOVE_MEETINGS=1 → 회의 8행 knowledge→source 이동(deploy 시 동반 — 기본 off).
//  비파괴/되돌리기: 백업 테이블 knowledge_category_backup_290 / knowledge_backup_290 으로 복원 가능.
//  ⚠ 단일 UNIQUE 인덱스는 여기서 만들지 않는다 — 게이트웨이 재시작(initV6Schema)이 데이터 클린 후 생성(.catch 보류 패턴).
import pg from "pg";

const DRY = process.env.DRY === "1";
const MOVE_MEETINGS = process.env.MOVE_MEETINGS === "1";
const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 4 });

// 33건 단일 카테고리 판정(다온, 2026-06-30 — 제목·내용 기반). name → 남길 카테고리 key.
//  엔지니어링/제품빌드→canonical-context-store, 시장·경쟁 분석→market-competition, 브랜드·덱·디자인가이드→brand,
//  도메인맵 메커니즘→domain-cartography, 전략→gtm, 전달웹·하네스표준→workflow-standardization.
const KEEP = {
  "lively-problem-framing": "brand",
  "2026-06-12-고객배포-리팩터-설계결정": "canonical-context-store",
  "팀-기능-설계-구현-카테고리-오너십-소프트-렌즈-팀별-컨텍스트-주입-프로젝트-위키-탭-재구성": "canonical-context-store",
  "product-domains-3cut": "domain-cartography",
  "lively-sales-deck-pages": "brand",
  "domain-debt-market-position": "market-competition",
  "context-ontology-build-plan": "canonical-context-store",
  "web-terminal-reattach-altscreen-scroll-copy": "canonical-context-store",
  "web-terminal-cjk-corruption-window-size-latest": "canonical-context-store",
  "web-terminal-korean-font-d2coding-279": "canonical-context-store",
  "activity-model-shipped": "canonical-context-store",
  "honest-ai-first-pilot": "gtm",
  "anthropic-korea-ecosystem-tech-partner-2026-06": "market-competition",
  "architecture": "canonical-context-store",
  "ax-delivery-competitors-middle-lane-2026-06": "market-competition",
  "claude-connector-submission-gap-2026-06": "canonical-context-store",
  "cpn-select-first-two-deployments-2026-06": "gtm",
  "context-ontology-셀프호스트-배포-option2-ec2-파일럿": "canonical-context-store",
  "repo-consolidation-plan": "canonical-context-store",
  "gtm-standard-feasibility": "gtm",
  "2026-06-17-gtm-bm-자금조달-전략": "gtm",
  "domainmap-refresh-trigger-cron": "domain-cartography",
  "lively-brand-deck": "brand",
  "code-domain-mapping-llm-judge": "domain-cartography",
  "llm-msp-market-claude-partner-network-2026-06": "market-competition",
  "mcp-tool-deferred-injection-harness-187": "workflow-standardization",
  "audit-channel-normalize-invariant": "canonical-context-store",
  "2026-06-11-PM툴-신원-훅-통합-설계결정": "canonical-context-store",
  "제품조직-타깃-saas-서비스-지형맵-2026-06": "market-competition",
  "온보딩-진행상황-sot-웹페이지-하네스주입-단일소스": "canonical-context-store",
  "summary-2026-06-22": "canonical-context-store",
  "design-guide": "brand",
  "ui-hero-productivity-dev-pm": "workflow-standardization",
};

// page-type 휴리스틱(제목 키워드, 고신뢰만 — 나머지 NULL 유지). 순서 = 우선순위. 되돌리기 쉬움(nullable).
const TYPE_RULES = [
  ["decision", `(title ILIKE '%결정%' OR name ILIKE '%설계결정%' OR title ILIKE '%ADR%')`],
  ["research", `(title ILIKE '%deep-research%' OR title ILIKE '%시장 지도%' OR title ILIKE '%지형 맵%' OR title ILIKE '%지형맵%' OR title ILIKE '%경쟁지형%' OR title ILIKE '%리서치%' OR title ILIKE '%분석%')`],
  ["how-to", `(title ILIKE '%런북%' OR title ILIKE '%runbook%')`],
  ["reference", `(title ILIKE '%불변식%' OR title ILIKE '%ARCHITECTURE%' OR title ILIKE '%가이드%' OR title ILIKE '%스키마%')`],
];

const log = (...a) => console.log(...a);

async function main() {
  log(`\n=== #290 마이그레이션 ${DRY ? "[DRY-RUN 미리보기]" : "[LIVE 쓰기]"} ${MOVE_MEETINGS ? "(+회의 이동)" : "(회의 이동 보류)"} ===\n`);

  // 0) 새 스키마(비파괴 가산, idempotent) — 단일 UNIQUE 인덱스는 제외(게이트웨이 재시작이 클린 후 생성).
  if (!DRY) {
    await pool.query(`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS type TEXT`);
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge'::regclass AND conname='knowledge_type_chk') THEN ALTER TABLE knowledge ADD CONSTRAINT knowledge_type_chk CHECK (type IS NULL OR type IN ('decision','concept','how-to','reference','research','entity')); END IF; END $$;`);
    await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_link(id SERIAL PRIMARY KEY, from_name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE, to_name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE, relation TEXT NOT NULL DEFAULT 'related', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_link'::regclass AND conname='knowledge_link_relation_chk') THEN ALTER TABLE knowledge_link ADD CONSTRAINT knowledge_link_relation_chk CHECK (relation IN ('related','refines','contradicts','depends_on')); END IF; IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_link'::regclass AND conname='knowledge_link_noself_chk') THEN ALTER TABLE knowledge_link ADD CONSTRAINT knowledge_link_noself_chk CHECK (from_name <> to_name); END IF; END $$;`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_link_uq ON knowledge_link(from_name, to_name, relation)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_link_from_idx ON knowledge_link(from_name)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_link_to_idx ON knowledge_link(to_name)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS source(id SERIAL PRIMARY KEY, name TEXT, kind TEXT NOT NULL DEFAULT 'other', title TEXT, body_md TEXT NOT NULL DEFAULT '', raw JSONB, provenance TEXT NOT NULL DEFAULT 'observed', external_system TEXT, external_instance TEXT, external_id TEXT, external_url TEXT, sync_state JSONB NOT NULL DEFAULT '{}'::jsonb, occurred_at TIMESTAMPTZ, last_synced_at TIMESTAMPTZ, author TEXT, lifecycle TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT)`);
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='source'::regclass AND conname='source_provenance_chk') THEN ALTER TABLE source ADD CONSTRAINT source_provenance_chk CHECK (provenance IN ('authored','observed')); END IF; IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='source'::regclass AND conname='source_lifecycle_chk') THEN ALTER TABLE source ADD CONSTRAINT source_lifecycle_chk CHECK (lifecycle IN ('active','superseded')); END IF; END $$;`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS source_name_uq ON source(name) WHERE name IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS source_kind_idx ON source(kind)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_source(name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE, source_id INT NOT NULL REFERENCES source(id) ON DELETE CASCADE, relation TEXT NOT NULL DEFAULT 'derived_from', created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(name, source_id, relation))`);
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_source'::regclass AND conname='knowledge_source_relation_chk') THEN ALTER TABLE knowledge_source ADD CONSTRAINT knowledge_source_relation_chk CHECK (relation IN ('derived_from','cites')); END IF; END $$;`);
    log("0) 새 스키마 보장(type 컬럼·knowledge_link·source·knowledge_source) ✓ (단일 UNIQUE 인덱스는 게이트웨이 재시작이 생성)");
  } else {
    log("0) [DRY] 스키마 가산 생략");
  }

  // 1) 백업(idempotent — 이미 있으면 재생성 안 함).
  if (!DRY) {
    await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_category_backup_290 AS SELECT *, now() AS backed_up_at FROM knowledge_category`);
    const bk = await pool.query(`SELECT count(*)::int n FROM knowledge_category_backup_290`);
    log(`1) 백업 knowledge_category_backup_290 = ${bk.rows[0].n}행 ✓`);
  } else {
    const n = await pool.query(`SELECT count(*)::int n FROM knowledge_category`);
    log(`1) [DRY] 백업 예정 knowledge_category = ${n.rows[0].n}행`);
  }

  // 2) 카테고리 키→id 맵.
  const catRows = await pool.query(`SELECT id, key FROM category WHERE state<>'merged'`);
  const catId = Object.fromEntries(catRows.rows.map((r) => [r.key, r.id]));

  // 3) 33건 단일화 — keep 외 카테고리 매핑 삭제(keep 이 현 카테고리에 있을 때만).
  let collapsed = 0, removed = 0, skipped = 0;
  for (const [name, keepKey] of Object.entries(KEEP)) {
    const keepId = catId[keepKey];
    if (!keepId) { log(`   ⚠ ${name}: keep '${keepKey}' id 없음 — skip`); skipped++; continue; }
    const cur = await pool.query(`SELECT category_id FROM knowledge_category WHERE name=$1 AND state<>'rejected'`, [name]);
    const ids = cur.rows.map((r) => r.category_id);
    if (!ids.length) { log(`   ⚠ ${name}: 카테고리 0개 — skip`); skipped++; continue; }
    if (!ids.includes(keepId)) { log(`   ⚠ ${name}: keep '${keepKey}'(${keepId})가 현 카테고리[${ids}]에 없음 — skip(수동확인)`); skipped++; continue; }
    const toRemove = ids.filter((i) => i !== keepId);
    if (!toRemove.length) continue; // 이미 단일
    if (!DRY) await pool.query(`DELETE FROM knowledge_category WHERE name=$1 AND category_id <> $2`, [name, keepId]);
    collapsed++; removed += toRemove.length;
    log(`   ${DRY ? "[DRY] " : ""}${name} → ${keepKey}(${keepId}) (제거 ${toRemove.length})`);
  }
  log(`3) 단일화: ${collapsed}건 collapse, ${removed} 매핑 제거, ${skipped} skip`);

  // 4) page-type 휴리스틱(고신뢰만, NULL 만 채움).
  log("4) page-type 휴리스틱:");
  for (const [type, cond] of TYPE_RULES) {
    if (DRY) {
      const r = await pool.query(`SELECT count(*)::int n FROM knowledge WHERE type IS NULL AND lifecycle='active' AND ${cond}`);
      log(`   [DRY] ${type}: ${r.rows[0].n}건 예정`);
    } else {
      const r = await pool.query(`UPDATE knowledge SET type=$1 WHERE type IS NULL AND lifecycle='active' AND ${cond}`, [type]);
      log(`   ${type}: ${r.rowCount}건`);
    }
  }
  if (!DRY) {
    const left = await pool.query(`SELECT count(*)::int n FROM knowledge WHERE type IS NULL AND lifecycle='active'`);
    log(`   (미분류 NULL 잔여 ${left.rows[0].n}건 — 편집/후속)`);
  }

  // 5) (옵션) 회의 8행 knowledge→source. deploy 시 자료탭과 동반(MOVE_MEETINGS=1). 기본 보류.
  const meetings = await pool.query(`SELECT name, title FROM knowledge WHERE name LIKE 'meeting-%'`);
  if (MOVE_MEETINGS && !DRY) {
    await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_backup_290 AS SELECT * FROM knowledge WHERE 1=0`);
    // 백업(멱등 — 이미 백업된 회의는 재삽입 안 함). knowledge 엔 created_at 없음 → updated_at 만 보존.
    await pool.query(`INSERT INTO knowledge_backup_290 SELECT * FROM knowledge k WHERE k.name LIKE 'meeting-%' AND NOT EXISTS (SELECT 1 FROM knowledge_backup_290 b WHERE b.name=k.name)`);
    const ins = await pool.query(
      `INSERT INTO source(name, kind, title, body_md, provenance, occurred_at)
       SELECT k.name, CASE WHEN k.name LIKE '%-transcript' THEN 'transcript' WHEN k.name LIKE '%-minutes' THEN 'minutes' ELSE 'other' END,
              k.title, k.body_md, 'authored', k.occurred_at
       FROM knowledge k WHERE k.name LIKE 'meeting-%' AND NOT EXISTS (SELECT 1 FROM source s WHERE s.name=k.name)`);
    const del = await pool.query(`DELETE FROM knowledge WHERE name LIKE 'meeting-%'`);
    log(`5) 회의 이동: source 적재 ${ins.rowCount}, knowledge 삭제 ${del.rowCount} (백업 knowledge_backup_290) ✓`);
  } else {
    log(`5) 회의 ${meetings.rows.length}행 = ${DRY ? "[DRY] " : ""}이동 보류(MOVE_MEETINGS=1 + deploy 시). 현재 knowledge 에 잔류(observed).`);
  }

  // 6) 잔여 multi 일반 수렴(KEEP 밖 — 동시작업 중 구 코드로 생긴 것) → 최소 category_id 로 단일화. 그 후 단일 UNIQUE 인덱스 생성(데이터 클린 시).
  if (!DRY) {
    const stragglers = await pool.query(`SELECT name FROM knowledge_category WHERE state<>'rejected' GROUP BY name HAVING count(*)>1`);
    for (const r of stragglers.rows) {
      await pool.query(`DELETE FROM knowledge_category WHERE name=$1 AND category_id <> (SELECT min(category_id) FROM knowledge_category WHERE name=$1 AND state<>'rejected')`, [r.name]);
      log(`   잔여 단일화: ${r.name}`);
    }
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_category_single_uq ON knowledge_category(name)`)
      .then(() => log(`6) knowledge_category_single_uq 생성 ✓ (잔여 ${stragglers.rows.length}건 수렴 후)`))
      .catch((e) => log(`6) 단일 인덱스 보류: ${e.message}`));
    // project_category 도 단일화(결정 문서: 프로젝트도 단일). 백업 후 최소 category_id 로 수렴.
    await pool.query(`CREATE TABLE IF NOT EXISTS project_category_backup_290 AS SELECT *, now() AS backed_up_at FROM project_category`);
    const pstr = await pool.query(`SELECT project_id FROM project_category GROUP BY project_id HAVING count(*)>1`);
    for (const r of pstr.rows) {
      await pool.query(`DELETE FROM project_category WHERE project_id=$1 AND category_id <> (SELECT min(category_id) FROM project_category WHERE project_id=$1)`, [r.project_id]);
      log(`   프로젝트 단일화: #${r.project_id}`);
    }
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS project_category_single_uq ON project_category(project_id)`)
      .then(() => log(`   project_category_single_uq 생성 ✓ (잔여 ${pstr.rows.length}건 수렴 후)`))
      .catch((e) => log(`   project_category 단일 인덱스 보류: ${e.message}`));
  }

  // 검증 요약.
  const multi = await pool.query(`SELECT count(*)::int n FROM (SELECT name FROM knowledge_category WHERE state<>'rejected' GROUP BY name HAVING count(*)>1) t`);
  log(`\n검증: 복수카테고리 잔여 = ${multi.rows[0].n}건 (회의 제외 0 목표)`);
  await pool.end();
  log("=== 완료 ===\n");
}
main().catch((e) => { console.error("마이그레이션 실패:", e); process.exit(1); });
