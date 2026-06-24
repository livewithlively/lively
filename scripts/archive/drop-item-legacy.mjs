// item 폐기·ku 흡수(2026-06) — **레거시 item 물리 드랍 스크립트(미실행 기본·가드)**.
//
//   ⚠⚠⚠ 라이브 가드: 기본은 DRY(아무것도 안 씀). 실제 드랍은 `--execute` 플래그 + 불변식 PRE 가드 통과 +
//        ITEM_DROP_CONFIRM=YES 환경변수 3중 잠금이 모두 맞아야만 수행한다. 윤상민이 라이브 작업 중이면
//        절대 실행하지 말 것 — 커밋/재기동/물리 드랍 금지 제약(과제 규칙)과 충돌한다.
//
//   배경: ku(knowledge_unit)가 단일 캐노니컬 표면. item/item_domain/item_project/item_mapping_audit/
//        relation/item_legacy(VIEW) 는 레거시 — observed 미러(71)·kud/kup(가산이관 완료)로 ku 가 상위집합.
//        search_items/get_item MCP·REST 제거 + ctx_* 흡수 완료 후, 이 레거시 물리 객체를 마지막으로 드랍한다.
//
//   보존(드랍 금지 — item 무관 또는 별개 신원/감사층):
//     · connector_state (커넥터 증분 커서 — item 무관)
//     · person / person_identity / person_identity_audit (actor 귀속 — ku.author 와 별개 신원층)
//     · pm_write_audit (item FK 없음)
//     · knowledge_unit / knowledge_unit_domain / knowledge_unit_project (캐노니컬 — 보존)
//
//   드랍 전 불변식(PRE 가드 — 위반 시 abort, 데이터 손실 방지):
//     ① 모든 item 이 ku observed 에 미러됨 (미러 누락 0)
//     ② item_domain 전부 kud 에 흡수됨 (미흡수 0)
//     ③ item_project 전부 kup 에 흡수됨 (미흡수 0)
//   ①②③ 중 하나라도 0 이 아니면 드랍하면 데이터가 ku 로 안 넘어간 채 사라지므로 즉시 abort.
//
//   순서(FK 의존 역순): pg_dump 백업 → DROP VIEW item_legacy → DROP TABLE relation(item FK 먼저)
//     → item_domain / item_project (item FK CASCADE) → item_mapping_audit → item.
//     ※ initItemSchema(src/items/store.ts)의 해당 CREATE/ALTER 블록도 동반 삭제해야 재부팅 재생성을 막는다
//        (이 스크립트는 DB 만 — 코드 정리는 별도. 스키마 재생성 방지 미적용 시 재부팅하면 빈 테이블이 되살아남).
//
//   백업: pg_dump --data-only --table=... 로 item·item_domain·item_project·item_mapping_audit·relation 덤프
//     (스키마+데이터). 복원: psql < 덤프(롤백 — knowledge_unit 은 안 건드렸으므로 ku 는 불변).
//
//   실행(드랍):  ITEM_DROP_CONFIRM=YES node --env-file=.../.env scripts/drop-item-legacy.mjs --execute
//   실행(점검):  node --env-file=.../.env scripts/drop-item-legacy.mjs            (DRY — PRE 불변식만 측정·보고)

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { itemsPool } from "../dist/items/store.js";

const EXECUTE = process.argv.includes("--execute");
const CONFIRMED = process.env.ITEM_DROP_CONFIRM === "YES";

const q1 = async (sql) => Number((await itemsPool.query(sql)).rows[0]?.n ?? NaN);

// 미러 누락 = ku observed 에 대응 유닛이 없는 item.
const SQL_UNMIRRORED = `
  SELECT count(*)::int n FROM item i
  WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_unit k
    WHERE k.external_system = i.prov_system AND k.external_id = i.external_id AND k.source <> 'authored')`;

// item_domain 미흡수 = kud(ku 좌표 조인)에 같은 (repo, domain_key) 매핑이 없는 행.
const SQL_DOMAIN_UNABSORBED = `
  SELECT count(*)::int n FROM item_domain idm JOIN item i ON i.id = idm.item_id
  WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_unit k JOIN knowledge_unit_domain kd ON kd.name = k.name
    WHERE k.external_system = i.prov_system AND k.external_id = i.external_id AND k.source <> 'authored'
      AND kd.repo = idm.repo AND kd.domain_key = idm.domain_key)`;

// item_project 미흡수 = kup 에 같은 (repo, project_key) 매핑이 없는 행.
const SQL_PROJECT_UNABSORBED = `
  SELECT count(*)::int n FROM item_project ip JOIN item i ON i.id = ip.item_id
  WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_unit k JOIN knowledge_unit_project kp ON kp.name = k.name
    WHERE k.external_system = i.prov_system AND k.external_id = i.external_id AND k.source <> 'authored'
      AND kp.repo = ip.repo AND kp.project_key = ip.project_key)`;

async function main() {
  console.log("=== item 레거시 드랍 — PRE 불변식 측정 ===");
  const itemCount = await q1("SELECT count(*)::int n FROM item");
  const unmirrored = await q1(SQL_UNMIRRORED);
  const domainUnabsorbed = await q1(SQL_DOMAIN_UNABSORBED);
  const projectUnabsorbed = await q1(SQL_PROJECT_UNABSORBED);
  console.log(`  item=${itemCount}  미러누락=${unmirrored}  item_domain 미흡수=${domainUnabsorbed}  item_project 미흡수=${projectUnabsorbed}`);

  const ok = unmirrored === 0 && domainUnabsorbed === 0 && projectUnabsorbed === 0;
  if (!ok) {
    console.error("✗ ABORT — 불변식 위반(미러/흡수 누락). 드랍하면 데이터가 ku 로 안 넘어간 채 사라진다. 먼저 가산이관을 완료하라.");
    process.exitCode = 2;
    return;
  }
  console.log("✓ PRE 불변식 통과(미러·흡수 누락 0).");

  if (!EXECUTE) {
    console.log("\nDRY 모드(기본) — 아무것도 드랍하지 않음. 실제 드랍은 `ITEM_DROP_CONFIRM=YES … --execute`.");
    return;
  }
  if (!CONFIRMED) {
    console.error("\n✗ --execute 지정됐으나 ITEM_DROP_CONFIRM=YES 미설정 — 3중 잠금 미충족. 드랍 안 함.");
    process.exitCode = 2;
    return;
  }

  // ── 1) 백업(pg_dump) — 드랍 대상 테이블 스키마+데이터. ITEMS_DATABASE_URL 사용. ──
  const url = process.env.ITEMS_DATABASE_URL;
  if (!url) { console.error("✗ ITEMS_DATABASE_URL 없음 — 백업 불가, 드랍 중단."); process.exitCode = 2; return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = `/tmp/item-legacy-backup-${stamp}`;
  mkdirSync(dir, { recursive: true });
  const dumpPath = `${dir}/item-legacy.sql`;
  console.log(`\n백업 pg_dump → ${dumpPath}`);
  try {
    execFileSync("pg_dump", [
      url, "--no-owner", "--no-privileges",
      "-t", "item", "-t", "item_domain", "-t", "item_project", "-t", "item_mapping_audit", "-t", "relation",
      "-f", dumpPath,
    ], { stdio: ["ignore", "inherit", "inherit"] });
  } catch (e) {
    console.error(`✗ pg_dump 실패 — 드랍 중단(백업 없이 드랍 금지): ${e.message}`);
    process.exitCode = 2;
    return;
  }

  // ── 2) 드랍(FK 의존 역순) — 단일 트랜잭션. ──
  console.log("\n드랍 실행(트랜잭션)…");
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP VIEW IF EXISTS item_legacy");
    await client.query("DROP TABLE IF EXISTS relation");          // item FK
    await client.query("DROP TABLE IF EXISTS item_domain");        // item FK CASCADE
    await client.query("DROP TABLE IF EXISTS item_project");       // item FK CASCADE
    await client.query("DROP TABLE IF EXISTS item_mapping_audit"); // FK 없음(append-only 감사) — 백업에 보존
    await client.query("DROP TABLE IF EXISTS item");
    await client.query("COMMIT");
    console.log("✓ 드랍 완료(트랜잭션 커밋).");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`✗ 드랍 실패 — 롤백함: ${e.message}`);
    console.error(`  복원 불요(롤백됨). 백업은 ${dumpPath} 에 있음.`);
    process.exitCode = 2;
    return;
  } finally {
    client.release();
  }
  console.log(`\n롤백 방법: psql "$ITEMS_DATABASE_URL" < ${dumpPath}`);
  console.log("⚠ 재부팅 시 initItemSchema 가 빈 테이블을 재생성하므로, src/items/store.ts 의 해당 CREATE/ALTER 블록도 제거해야 영구 폐기.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await itemsPool.end(); });
