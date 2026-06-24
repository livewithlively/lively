// v6 데이터 이행 — 레거시(domain/knowledge_unit/knowledge_unit_domain/mapping) → v6(category/knowledge/project/knowledge_category).
//  **비파괴**(레거시 보존)·**멱등**(WHERE NOT EXISTS). 기본 dry-run, `--apply` 로 실제 적용.
//  매핑 규칙:
//   · domain → category (space 그대로, business/org → system). (space,key) 유니크 dedup.
//   · knowledge_unit(R) → knowledge injection=always; (H·K 비observed) → recalled/authored; (K observed) → observed.
//   · knowledge_unit(W) → project(level=task) — knowledge 아님(external_* 멱등).
//   · knowledge_unit_domain → knowledge_category (domain_key→category, knowledge 존재분만).
//   · mapping.domain_id → category_id 백필.
import { itemsPool } from "../dist/items/store.js";
const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[dry-run]";
const spaceOf = (space, key) => (space === "business" && key === "org" ? "system" : space);

async function main() {
  // ── 1. domain → category ──
  const dom = (await itemsPool.query(
    `SELECT space, key, name, description, should, cross_cutting, origin, status FROM domain WHERE state<>'merged'`)).rows;
  const seen = new Set(); const cats = [];
  for (const d of dom) {
    const sp = spaceOf(d.space, d.key); const k = sp + "/" + d.key;
    if (seen.has(k)) continue; seen.add(k); cats.push({ ...d, space: sp });
  }
  console.log(`${tag} 1) domain→category: ${dom.length} legacy → ${cats.length} unique (space,key) [${[...new Set(cats.map((c) => c.space))].join(",")}]`);
  let catIns = 0;
  if (APPLY) for (const c of cats) {
    const r = await itemsPool.query(
      `INSERT INTO category(space,key,name,description,should,cross_cutting,origin,status,state,created_at,updated_at)
       SELECT $1,$2,$3,$4,$5,COALESCE($6,false),$7,COALESCE($8,'confirmed'),'active',now(),now()
       WHERE NOT EXISTS (SELECT 1 FROM category WHERE space=$1 AND key=$2 AND state<>'merged')`,
      [c.space, c.key, c.name, c.description, c.should, c.cross_cutting, c.origin, c.status]);
    catIns += r.rowCount;
  }
  if (APPLY) console.log(`   inserted ${catIns} categories`);

  // ── 2. knowledge_unit → knowledge / project ──
  const ku = (await itemsPool.query(
    `SELECT name, title, body_md, kind, confidence, source, external_system, external_instance, external_id, external_url,
            occurred_at, last_synced_at, as_of, parent_name, summary, author, source_ref, sort, supersedes
     FROM knowledge_unit WHERE lifecycle='active'`)).rows;
  const toKnow = ku.filter((u) => u.kind !== "W");
  const toProj = ku.filter((u) => u.kind === "W");
  const alwaysN = toKnow.filter((u) => u.kind === "R").length;
  const obsN = toKnow.filter((u) => u.confidence === "observed").length;
  console.log(`${tag} 2) knowledge_unit→knowledge: ${toKnow.length} (always:${alwaysN}, observed:${obsN}, authored-recalled:${toKnow.length - alwaysN - obsN}) | →project(W,task): ${toProj.length}`);
  let knIns = 0, projIns = 0;
  if (APPLY) {
    for (const u of toKnow) {
      const injection = u.kind === "R" ? "always" : "recalled";
      const provenance = u.confidence === "observed" ? "observed" : "authored";
      const confidence = ["ai", "rule", "human", "observed"].includes(u.confidence) ? u.confidence : "human";
      const r = await itemsPool.query(
        `INSERT INTO knowledge(name,title,body_md,injection,provenance,lifecycle,supersedes,confidence,source,
           external_system,external_instance,external_id,external_url,occurred_at,last_synced_at,as_of,parent_name,summary,author,source_ref,sort,version,updated_at)
         SELECT $1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,COALESCE($20,0),1,now()
         WHERE NOT EXISTS (SELECT 1 FROM knowledge WHERE name=$1)`,
        [u.name, u.title, u.body_md ?? "", injection, provenance, u.supersedes, confidence, u.source ?? "authored",
         u.external_system, u.external_instance, u.external_id, u.external_url, u.occurred_at, u.last_synced_at, u.as_of, u.parent_name, u.summary, u.author, u.source_ref, u.sort]);
      knIns += r.rowCount;
    }
    for (const u of toProj) {
      // external 멱등: external_id 있는 것만 NOT EXISTS 가드(없으면 name 기준 1회).
      const r = await itemsPool.query(
        `INSERT INTO project(level,name,description,status,external_system,external_instance,external_id,external_url,created_at,updated_at)
         SELECT 'task',$1::text,$2::text,'active',$3::text,$4::text,$5::text,$6::text,now(),now()
         WHERE NOT EXISTS (
           SELECT 1 FROM project WHERE level='task' AND (
             ($5::text IS NOT NULL AND external_system=$3::text AND external_instance IS NOT DISTINCT FROM $4::text AND external_id=$5::text)
             OR ($5::text IS NULL AND name=$1::text)))`,
        [u.title ?? u.name, u.body_md, u.external_system, u.external_instance, u.external_id, u.external_url]);
      projIns += r.rowCount;
    }
    console.log(`   inserted ${knIns} knowledge, ${projIns} project(task)`);
  }

  // ── 3. knowledge_unit_domain → knowledge_category (knowledge 존재분만) ──
  const kud = (await itemsPool.query(
    `SELECT kud.name, kud.domain_key, kud.mapped_by, kud.state, kud.confidence, kud.evidence, d.space AS dspace
     FROM knowledge_unit_domain kud JOIN domain d ON d.key=kud.domain_key AND d.state<>'merged'`)).rows;
  console.log(`${tag} 3) knowledge_unit_domain→knowledge_category: ${kud.length} legacy maps (knowledge 존재분만 적재)`);
  let kcIns = 0;
  if (APPLY) for (const m of kud) {
    const sp = spaceOf(m.dspace, m.domain_key);
    const r = await itemsPool.query(
      `INSERT INTO knowledge_category(name,category_id,mapped_by,confidence,state,evidence,created_at)
       SELECT $1, c.id, $3, $4, $5, $6, now()
       FROM category c
       WHERE c.space=$7 AND c.key=$2 AND c.state<>'merged'
         AND EXISTS (SELECT 1 FROM knowledge k WHERE k.name=$1)
         AND NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name=$1 AND kc.category_id=c.id)`,
      [m.name, m.domain_key, m.mapped_by, m.confidence, m.state, m.evidence, sp]);
    kcIns += r.rowCount;
  }
  if (APPLY) console.log(`   inserted ${kcIns} knowledge_category`);

  // ── 4. mapping.domain_id → category_id 백필 ──
  console.log(`${tag} 4) mapping.category_id 백필`);
  if (APPLY) {
    const r = await itemsPool.query(
      `UPDATE mapping m SET category_id=c.id
       FROM domain d
       JOIN category c ON c.key=d.key
         AND c.space=(CASE WHEN d.space='business' AND d.key='org' THEN 'system' ELSE d.space END)
         AND c.state<>'merged'
       WHERE m.domain_id=d.id AND m.category_id IS NULL`);
    console.log(`   updated ${r.rowCount} mapping rows`);
  }

  // ── 5. org_project → project(level=project) — 라이블리 자체 프로젝트 보드. ──
  //  멤버(project_member)는 컷오버 시 — 현재 project_member FK 가 레거시 org_project 를 가리켜(CREATE IF NOT EXISTS
  //  선점) v6 project.id 로의 멤버 적재가 FK 위반. 컷오버에서 FK 를 v6 project 로 재지정 후 멤버 이행. 보드 카드는 멤버 0 으로 표시.
  const ops = (await itemsPool.query(
    `SELECT id, name, description, status, folder, created_by, completed_at, created_at FROM org_project`)).rows;
  console.log(`${tag} 5) org_project→project(level=project): ${ops.length}`);
  let opIns = 0;
  if (APPLY) for (const op of ops) {
    const r = await itemsPool.query(
      `INSERT INTO project(level,name,description,status,folder,created_by,completed_at,external_system,external_id,created_at,updated_at)
       SELECT 'project',$1::text,$2::text,COALESCE($3::text,'active'),$4::text,$5::text,$6::timestamptz,'legacy_org_project',$7::text,COALESCE($8::timestamptz,now()),now()
       WHERE NOT EXISTS (SELECT 1 FROM project WHERE external_system='legacy_org_project' AND external_id=$7::text)`,
      [op.name, op.description, op.status, op.folder, op.created_by, op.completed_at, String(op.id), op.created_at]);
    opIns += r.rowCount;
  }
  if (APPLY) console.log(`   inserted ${opIns} project(level=project)`);

  const cat2 = (await itemsPool.query(`SELECT count(*)::int n FROM category WHERE state<>'merged'`)).rows[0].n;
  const kn2 = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge`)).rows[0].n;
  const pjP = (await itemsPool.query(`SELECT count(*)::int n FROM project WHERE level='project'`)).rows[0].n;
  const pjT = (await itemsPool.query(`SELECT count(*)::int n FROM project WHERE level='task'`)).rows[0].n;
  console.log(`\n현재 v6 상태: category=${cat2}, knowledge=${kn2}, project(project)=${pjP}, project(task)=${pjT}`);
}
main().catch((e) => { console.error("MIGRATE FAILED:", e.message, "\n", e.stack); process.exitCode = 1; }).finally(() => itemsPool.end());
