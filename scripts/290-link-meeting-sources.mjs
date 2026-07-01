// #290 회의 출처 인용 — 회의록(source)에서 나온 기존 지식을 knowledge_source(derived_from)로 잇는다.
//  회의록 정독(다온) 후 도출. 중복 저작 안 함 — 결정은 이미 지식으로 존재, 출처 추적 링크만 추가.
//  실행: node --env-file=<게이트웨이 .env> scripts/290-link-meeting-sources.mjs (DRY=1 미리보기)
import pg from "pg";
const DRY = process.env.DRY === "1";
const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 4 });

// source_id: 7=06-19-1, 5=06-19-2, 2=06-20, 4=06-23 minutes.
const LINKS = [
  ["context-os-v5-shipped", 7],
  ["activity-model-shipped", 7],
  ["honest-ai-first-pilot", 7],
  ["gtm-standard-feasibility", 5],
  ["central-box-design", 2],
  ["delivery-web-everyday-minimalism", 2],
  ["admin-console-dev-readable-redesign", 2],
  ["context-os-v6-redesign", 4],
  ["vector-search-172-design-pluggable-seam-oss", 4],
  ["컨텍스트-온톨로지-분류-링크-자료-재설계-결정-290-단일카테고리-knowledge-link-source층-page", 4],
];

async function main() {
  console.log(`\n=== #290 회의 출처 인용 ${DRY ? "[DRY]" : "[LIVE]"} ===\n`);
  // 회의록이 source 로 옮겨졌는지(이름→id) 확인.
  const srcs = await pool.query(`SELECT id, name FROM source WHERE kind='minutes'`);
  const validIds = new Set(srcs.rows.map((r) => r.id));
  let ok = 0, skipKnow = 0, skipSrc = 0;
  for (const [name, sid] of LINKS) {
    if (!validIds.has(sid)) { console.log(`   ⚠ source #${sid} 없음 — skip (${name})`); skipSrc++; continue; }
    const k = await pool.query(`SELECT 1 FROM knowledge WHERE name=$1 AND lifecycle='active'`, [name]);
    if (!k.rowCount) { console.log(`   ⚠ 지식 없음 — skip: ${name}`); skipKnow++; continue; }
    if (DRY) { console.log(`   [DRY] ${name} → source#${sid} (derived_from)`); ok++; continue; }
    await pool.query(
      `INSERT INTO knowledge_source(name, source_id, relation, created_at) VALUES($1,$2,'derived_from',now())
       ON CONFLICT (name, source_id, relation) DO NOTHING`, [name, sid]);
    console.log(`   ✓ ${name} → source#${sid}`);
    ok++;
  }
  console.log(`\n인용 ${ok}건${skipKnow ? ` · 지식없음 skip ${skipKnow}` : ""}${skipSrc ? ` · source없음 skip ${skipSrc}` : ""}`);
  const total = await pool.query(`SELECT count(*)::int n FROM knowledge_source`);
  console.log(`knowledge_source 총 ${total.rows[0].n}건`);
  await pool.end();
  console.log("=== 완료 ===\n");
}
main().catch((e) => { console.error("실패:", e); process.exit(1); });
