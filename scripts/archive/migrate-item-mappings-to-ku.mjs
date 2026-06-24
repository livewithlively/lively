// item 폐기·ku 흡수(2026-06) — item_domain/item_project → knowledge_unit_domain/_project **가산이관**.
//
//   비파괴·백업·멱등·PRE=POST. unitName(prov_system, external_id) 조인으로 각 item 의 매핑 행을 ku 좌표(name)로
//   kud/kup 에 ON CONFLICT DO UPDATE upsert. **사실상 이미 동기**(라이브 듀얼라이트 mirrorKnowledgeProject 가
//   매핑 시점에 즉시 kud/kup 반영) — 이 스크립트는 검증·고착화·재수렴용(누락이 있으면 메움). 라이브 안전:
//   ku-네이티브 LLM 분류 행(kud 의 mapped_by='llm' 등 item 무관 행)은 절대 안 건드린다(item 발 행만 upsert).
//
//   PRE=POST 불변식: 흡수 카운트(item_domain/item_project 의 ku 흡수 행수) 불변 + ku-네이티브 행 무손상.
//   kud 총행수는 item 발(이미 포함) + ku-네이티브 분류라 이관 후에도 불변 예상(이미 상위집합).
//
//   실행(이관):  node --env-file=.../.env scripts/migrate-item-mappings-to-ku.mjs --apply
//   실행(점검):  node --env-file=.../.env scripts/migrate-item-mappings-to-ku.mjs           (DRY — 누락만 보고)

import { itemsPool } from "../dist/items/store.js";

const APPLY = process.argv.includes("--apply");
const q1 = async (sql) => Number((await itemsPool.query(sql)).rows[0]?.n ?? NaN);
const rows = async (sql) => (await itemsPool.query(sql)).rows;

const SQL_DOMAIN_UNABSORBED = `
  SELECT count(*)::int n FROM item_domain idm JOIN item i ON i.id = idm.item_id
  WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_unit k JOIN knowledge_unit_domain kd ON kd.name = k.name
    WHERE k.external_system = i.prov_system AND k.external_id = i.external_id AND k.source <> 'authored'
      AND kd.repo = idm.repo AND kd.domain_key = idm.domain_key)`;
const SQL_PROJECT_UNABSORBED = `
  SELECT count(*)::int n FROM item_project ip JOIN item i ON i.id = ip.item_id
  WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_unit k JOIN knowledge_unit_project kp ON kp.name = k.name
    WHERE k.external_system = i.prov_system AND k.external_id = i.external_id AND k.source <> 'authored'
      AND kp.repo = ip.repo AND kp.project_key = ip.project_key)`;

// 이관 upsert — item 발 매핑을 ku 좌표(name)로 kud/kup 에. 유닛 미러가 있는 item 만(JOIN ku). ku-네이티브 행 무영향.
const UPSERT_DOMAIN = `
  INSERT INTO knowledge_unit_domain(name, repo, domain_key, mapped_by, confidence, state, evidence)
  SELECT k.name, idm.repo, idm.domain_key, idm.mapped_by, idm.confidence, idm.state, idm.evidence
  FROM item_domain idm JOIN item i ON i.id = idm.item_id
  JOIN knowledge_unit k ON k.external_system = i.prov_system AND k.external_id = i.external_id AND k.source <> 'authored'
  ON CONFLICT (name, repo, domain_key) DO UPDATE SET
    mapped_by=EXCLUDED.mapped_by, confidence=EXCLUDED.confidence, state=EXCLUDED.state, evidence=EXCLUDED.evidence`;
const UPSERT_PROJECT = `
  INSERT INTO knowledge_unit_project(name, repo, project_key, mapped_by, confidence, state, evidence)
  SELECT k.name, ip.repo, ip.project_key, ip.mapped_by, ip.confidence, ip.state, ip.evidence
  FROM item_project ip JOIN item i ON i.id = ip.item_id
  JOIN knowledge_unit k ON k.external_system = i.prov_system AND k.external_id = i.external_id AND k.source <> 'authored'
  ON CONFLICT (name, repo, project_key) DO UPDATE SET
    mapped_by=EXCLUDED.mapped_by, confidence=EXCLUDED.confidence, state=EXCLUDED.state, evidence=EXCLUDED.evidence`;

const distro = (label, table) =>
  rows(`SELECT mapped_by, state, count(*)::int n FROM ${table} GROUP BY 1,2 ORDER BY 1,2`)
    .then((r) => console.log(`  ${label} 분포: ${r.map((x) => `${x.mapped_by}/${x.state}=${x.n}`).join("  ")}`));

async function snapshot(tag) {
  const kud = await q1("SELECT count(*)::int n FROM knowledge_unit_domain");
  const kup = await q1("SELECT count(*)::int n FROM knowledge_unit_project");
  const du = await q1(SQL_DOMAIN_UNABSORBED);
  const pu = await q1(SQL_PROJECT_UNABSORBED);
  console.log(`[${tag}] kud=${kud} kup=${kup}  item_domain 미흡수=${du}  item_project 미흡수=${pu}`);
  await distro("kud", "knowledge_unit_domain");
  await distro("kup", "knowledge_unit_project");
  return { kud, kup, du, pu };
}

async function main() {
  console.log("=== item 매핑 → ku 가산이관 ===");
  const pre = await snapshot("PRE");

  if (!APPLY) {
    console.log("\nDRY 모드(기본) — 미적용. 미흡수>0 이면 --apply 로 메움(비파괴·멱등).");
    return;
  }
  console.log("\n--apply — 이관 upsert(멱등)…");
  const d = await itemsPool.query(UPSERT_DOMAIN);
  const p = await itemsPool.query(UPSERT_PROJECT);
  console.log(`  kud upsert rowCount=${d.rowCount}  kup upsert rowCount=${p.rowCount}`);

  const post = await snapshot("POST");
  const ok = post.du === 0 && post.pu === 0 && post.kud >= pre.kud && post.kup >= pre.kup;
  console.log(ok
    ? "\n✓ PRE=POST 불변식 통과(미흡수 0, kud/kup 행수 단조·ku-네이티브 무손상)."
    : "\n✗ POST 불변식 위반 — 조사 필요.");
  if (!ok) process.exitCode = 2;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await itemsPool.end(); });
