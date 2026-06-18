// P-V3-3b — item → knowledge_unit (observed A/W 유닛 복사). 비파괴·멱등·redact(H1).
//
//   목적: 기존 item(clickup task·notion doc) 71행을 knowledge_unit 에 **observed 수집물**로 복사해 통합 뷰에
//         표면화한다. item 원본은 **비파괴 보존**(읽기만 — 삭제·리네임·전환은 P-V3-3c).
//
//   매핑(data_source.into_kinds 참조):
//     · clickup task → kind 'W'(Work/Task)
//     · notion  doc  → kind 'A'(Artifact)
//     · 그 외 (type,system) 조합은 보수적으로 skip(보고만) — into_kinds 미정의 소스를 임의 분류하지 않는다.
//
//   name PK = 안정 슬러그 `${prov_system}-${external_id}`(소문자·영숫자/_/- 외 '-' 치환, 64자 상한).
//     external 좌표와 1:1 이라 name 충돌 = 동일 행(재실행 무피해). 슬러그 절단 충돌은 external 좌표가 캐노니컬이라
//     ON CONFLICT (external_system, external_instance, external_id) 가 흡수(아래).
//
//   멱등: knowledge_unit_external_uidx (부분 UNIQUE on external_system,external_instance,external_id WHERE external_id NOT NULL)
//     에 ON CONFLICT DO UPDATE — 재실행 시 신규 0, 동일 내용 재기록(오염 0). external_instance NULL→'' 정규화
//     (pg 는 NULL 을 distinct 로 보므로 부분 UNIQUE 가 안 막힘 → '' 로 정규화해 중복 차단).
//
//   confidence='observed'(서버강제 아닌 직접 INSERT — 커넥터 수집물 신뢰축). source=prov_system. lifecycle='active'.
//
//   🔴H1 redact: fields/raw/title/body 는 knowledge_unit 에 쓰기 **전** redactDeep/redactString 적용
//     (커넥터 원본의 평문 토큰/URL 마스킹). 마이그 로그에 시크릿 출력 금지(요약 카운트만).
//
//   다중도메인/프로젝트: item_domain/item_project → knowledge_unit_domain/knowledge_unit_project
//     (repo↔repo, domain_key/project_key↔key, mapped_by/confidence/state/evidence 보존). name↔item 좌표 1:1.
//
//   실행: node --env-file=/Users/lively/.openclaw/workspace/productivity/context-ontology/.env \
//           scripts/migrate-items-to-ku.mjs [--dry]
//         --dry : DB 미쓰기. 분류·redact 카운트만 출력(검증/사전점검).

import { itemsPool } from "../dist/items/store.js";
import { redactDeep, redactString } from "../dist/org/redact.js";

const DRY = process.argv.includes("--dry");
const ACTOR = "migration:P-V3-3b";
const SOURCE = "migration"; // org_content_audit.source 표기용(여기선 직접 INSERT 라 감사는 보고로 대체)

// (type, system) → kind. V4-P2a: 본질 4종 R/K/H/W — notion doc=산출물→K(A 흡수, observed 가 외부수집 표현),
//  clickup→W. knowledge-mirror.ts 의 KIND_MAP 와 동일(SQL 동치 보장). 미정의는 null(skip).
const KIND_MAP = {
  "task:clickup": "W",
  "doc:notion": "K",
};

// 안정 슬러그 — `${system}-${external_id}`. 소문자, 영숫자/_/- 외는 '-', 64자 상한, 선두 영숫자 보장.
export function unitName(system, externalId) {
  let s = `${system}-${externalId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "");
  if (!s || !/^[a-z0-9]/.test(s)) s = "ku-" + s; // 선두 비영숫자 방어
  return s.slice(0, 64);
}

// ── 메인 적재: item → knowledge_unit (observed). redact 후 INSERT … ON CONFLICT(external uidx) DO UPDATE. ──
//  opts.where: 테스트가 임시 접두 행만 대상으로 좁힐 수 있게(기본 = 전체 item).
export async function migrateItems(report, opts = {}) {
  const where = opts.where ? ` WHERE ${opts.where}` : "";
  const items = (await itemsPool.query(
    `SELECT id, type, prov_system, prov_instance, external_id, external_url,
            parent_external_id, title, body, occurred_at, updated_at, fields, raw
       FROM item${where} ORDER BY id`,
  )).rows;

  for (const it of items) {
    const key = `${it.type}:${it.prov_system}`;
    const kind = KIND_MAP[key];
    if (!kind) { report.skipped.push({ id: it.id, key }); continue; }

    const name = unitName(it.prov_system, it.external_id);
    // external_instance NULL→'' 정규화(부분 UNIQUE 중복차단 갭 메움 — pg NULL distinct 회피).
    const instance = it.prov_instance == null ? "" : String(it.prov_instance);

    // 🔴H1 redact — 쓰기 전 평문 시크릿 마스킹. title/body 는 문자열, fields/raw 는 깊은 순회.
    const title = it.title == null ? null : redactString(String(it.title));
    const body = redactString(String(it.body ?? ""));
    const fields = redactDeep(it.fields && typeof it.fields === "object" ? it.fields : {});
    const raw = it.raw == null ? null : redactDeep(it.raw);

    // redact 발생 여부(보고용 — 시크릿 자체는 출력 금지, 마스킹 적용 건수만).
    const redacted =
      (it.title != null && title !== String(it.title)) ||
      (body !== String(it.body ?? "")) ||
      (JSON.stringify(fields) !== JSON.stringify(it.fields ?? {})) ||
      (it.raw != null && JSON.stringify(raw) !== JSON.stringify(it.raw));
    if (redacted) report.redactedCount++;

    report.units.push({ id: it.id, name, kind, source: it.prov_system });

    if (DRY) continue;

    // parent_name = 부모 item 의 unitName(있으면) — 스레드 자기참조 내부 PK 연결. parent_external_id 는 그대로.
    const parentName = it.parent_external_id ? unitName(it.prov_system, it.parent_external_id) : null;

    await itemsPool.query(
      `INSERT INTO knowledge_unit(
          name, kind, title, body_md, lifecycle, confidence, source,
          external_system, external_instance, external_id, external_url,
          occurred_at, last_synced_at, parent_external_id, parent_name,
          fields, raw, author, updated_at, updated_by)
        VALUES($1,$2,$3,$4,'active','observed',$5,
               $5,$6,$7,$8,
               $9, now(), $10, $11,
               $12::jsonb, $13::jsonb, $14, now(), $15)
       ON CONFLICT (external_system, external_instance, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET
          kind=EXCLUDED.kind, title=EXCLUDED.title, body_md=EXCLUDED.body_md,
          lifecycle='active', confidence='observed', source=EXCLUDED.source,
          external_url=EXCLUDED.external_url, occurred_at=EXCLUDED.occurred_at,
          last_synced_at=now(), parent_external_id=EXCLUDED.parent_external_id, parent_name=EXCLUDED.parent_name,
          fields=EXCLUDED.fields, raw=EXCLUDED.raw,
          version=knowledge_unit.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [name, kind, title, body, it.prov_system,
       instance, it.external_id, it.external_url,
       it.occurred_at, it.parent_external_id, parentName,
       JSON.stringify(fields), raw == null ? null : JSON.stringify(raw), ACTOR, ACTOR],
    );

    // 다중도메인/프로젝트 매핑 복사 — item_domain/item_project → knowledge_unit_domain/_project.
    //  name 이 캐노니컬 PK. confidence(REAL)/state/mapped_by/evidence 보존. ON CONFLICT DO UPDATE(멱등).
    await migrateMappings(it.id, name, report);
  }
}

async function migrateMappings(itemId, name, report) {
  const doms = (await itemsPool.query(
    `SELECT repo, domain_key, mapped_by, confidence, state, evidence FROM item_domain WHERE item_id=$1`, [itemId],
  )).rows;
  for (const d of doms) {
    await itemsPool.query(
      `INSERT INTO knowledge_unit_domain(name, repo, domain_key, mapped_by, confidence, state, evidence)
         VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (name, repo, domain_key) DO UPDATE SET
         mapped_by=EXCLUDED.mapped_by, confidence=EXCLUDED.confidence, state=EXCLUDED.state, evidence=EXCLUDED.evidence`,
      [name, d.repo, d.domain_key, d.mapped_by ?? "rule", d.confidence, d.state ?? "proposed", d.evidence],
    );
    report.domainRows++;
  }
  const projs = (await itemsPool.query(
    `SELECT repo, project_key, mapped_by, confidence, state, evidence FROM item_project WHERE item_id=$1`, [itemId],
  )).rows;
  for (const p of projs) {
    await itemsPool.query(
      `INSERT INTO knowledge_unit_project(name, repo, project_key, mapped_by, confidence, state, evidence)
         VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (name, repo, project_key) DO UPDATE SET
         mapped_by=EXCLUDED.mapped_by, confidence=EXCLUDED.confidence, state=EXCLUDED.state, evidence=EXCLUDED.evidence`,
      [name, p.repo, p.project_key, p.mapped_by ?? "rule", p.confidence, p.state ?? "proposed", p.evidence],
    );
    report.projectRows++;
  }
}

async function main() {
  console.log(`[P-V3-3b migrate] dry=${DRY} actor=${ACTOR}`);

  const itemCount = (await itemsPool.query(`SELECT count(*)::int n FROM item`)).rows[0].n;
  const beforeObs = (await itemsPool.query(
    `SELECT count(*)::int n FROM knowledge_unit WHERE confidence='observed'`)).rows[0].n;
  const beforeByKind = (await itemsPool.query(
    `SELECT kind, count(*)::int n FROM knowledge_unit GROUP BY kind ORDER BY kind`)).rows;
  console.log(`BEFORE: item=${itemCount}, ku observed=${beforeObs}, ku by kind=${JSON.stringify(beforeByKind)}`);

  const report = {
    units: [], skipped: [], redactedCount: 0, domainRows: 0, projectRows: 0,
  };
  await migrateItems(report);

  // 비파괴 실증 — item 행수 무변(읽기만).
  const itemAfter = (await itemsPool.query(`SELECT count(*)::int n FROM item`)).rows[0].n;

  const afterObs = DRY ? beforeObs
    : (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit WHERE confidence='observed'`)).rows[0].n;
  const afterByKindObs = DRY ? []
    : (await itemsPool.query(
        `SELECT kind, count(*)::int n FROM knowledge_unit WHERE confidence='observed' GROUP BY kind ORDER BY kind`)).rows;

  const byKind = report.units.reduce((m, u) => ((m[u.kind] = (m[u.kind] || 0) + 1), m), {});

  console.log("\n── summary ──");
  console.log(JSON.stringify({
    dry: DRY,
    itemsRead: itemCount,
    itemsUnchanged: itemAfter === itemCount,
    itemAfter,
    mapped: report.units.length,
    mappedByKind: byKind,
    skipped: report.skipped,
    redactedUnits: report.redactedCount,
    domainMappings: report.domainRows,
    projectMappings: report.projectRows,
    observedBefore: beforeObs,
    observedAfter: afterObs,
    observedByKind: afterByKindObs,
  }, null, 2));

  if (DRY) console.log("\n(--dry: DB 미변경 — 실행하려면 --dry 없이)");

  await itemsPool.end();
  process.exit(0);
}

// 직접 실행 시에만 main() 구동(import 시엔 named export 만 — 테스트가 itemsPool 을 닫지 않고 재사용).
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("migrate 오류:", err?.stack ?? err);
    process.exit(1);
  });
}
