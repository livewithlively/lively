// P-V3-6 증류 v1 CLI — **opt-in 트리거**(자동 아님). 사람이 명시적으로 돌린다.
//  Stop 훅/cron 자동화는 v2(미검토 후보 적체 위험 — TTL 만 두면 폭주). v1 은 손으로 돌리고 결과를 본다.
//
//  실행:
//    node --env-file=/Users/lively/.openclaw/workspace/productivity/context-ontology/.env scripts/distill.mjs --run
//      → 규칙 실행 + 멱등 적재(신규 후보 생성) + TTL 만료. 결과 요약 출력.
//    node ... scripts/distill.mjs --dry
//      → DB 미쓰기. 어떤 후보가 나올지·캡/TTL 영향만 출력(사전 점검).
//    node ... scripts/distill.mjs --confirm <name>
//      → 후보를 승인(confidence ai→human, distill 마커 해제 → 항상-주입 인덱스 진입).
//    node ... scripts/distill.mjs --list
//      → 현재 살아있는 증류 후보(검토 대기) 목록.
//
//  옵션: --ttl-days N (기본 30) · --cap N (기본 20) · --min-domain N (기본 3) · --min-project N (기본 3)
//
//  로직은 dist/org/distill.js(TS, 타입체크·테스트됨)의 export 를 그대로 호출(SQL 동치 보장). 이 파일은 얇은 CLI.
import { runDistill, confirmCandidate, DISTILL_DEFAULTS, DISTILL_SOURCE_PREFIX } from "../dist/org/distill.js";
import { itemsPool } from "../dist/items/store.js";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return def;
  return process.argv[i + 1];
}
function num(name, def) {
  const v = arg(name, null);
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const DRY = process.argv.includes("--dry");
const RUN = process.argv.includes("--run");
const LIST = process.argv.includes("--list");
const CONFIRM = process.argv.includes("--confirm");

async function listCandidates() {
  const rows = (await itemsPool.query(
    `SELECT name, kind, title, domain_key, source_ref, lifecycle, updated_at
       FROM knowledge_unit
      WHERE confidence='ai' AND lifecycle='active' AND source_ref LIKE $1
      ORDER BY updated_at DESC, name`,
    [DISTILL_SOURCE_PREFIX + "%"],
  )).rows;
  console.log(`\n증류 후보(검토 대기) ${rows.length}건:`);
  for (const r of rows) {
    console.log(`  · [${r.kind}] ${r.name}  — ${r.title ?? ""}  (${r.source_ref})  ${r.updated_at?.toISOString?.() ?? r.updated_at}`);
  }
  return rows.length;
}

async function main() {
  const opts = {
    dry: DRY,
    ttlDays: num("--ttl-days", DISTILL_DEFAULTS.ttlDays),
    cap: num("--cap", DISTILL_DEFAULTS.cap),
    minWorkPerDomain: num("--min-domain", DISTILL_DEFAULTS.minWorkPerDomain),
    minWorkPerProject: num("--min-project", DISTILL_DEFAULTS.minWorkPerProject),
  };

  if (CONFIRM) {
    const name = arg("--confirm", null);
    if (!name) { console.error("--confirm <name> 필요"); process.exit(2); }
    await confirmCandidate(name);
    console.log(`confirm: '${name}' → confidence=human, distill 마커 해제(인덱스 진입).`);
    await itemsPool.end();
    return;
  }

  if (LIST && !RUN && !DRY) {
    await listCandidates();
    await itemsPool.end();
    return;
  }

  if (!RUN && !DRY) {
    console.log("사용법: --run | --dry | --confirm <name> | --list  [--ttl-days N --cap N --min-domain N --min-project N]");
    await itemsPool.end();
    return;
  }

  console.log(`[distill v1] dry=${opts.dry} ttlDays=${opts.ttlDays} cap=${opts.cap} minDomain=${opts.minWorkPerDomain} minProject=${opts.minWorkPerProject}`);
  const report = await runDistill(opts);

  console.log("\n── 규칙 산출 후보(캡 적용 전) ──");
  for (const c of report.candidates) {
    console.log(`  · [${c.kind}] ${c.rule}:${c.seed} → ${c.name}  | ${c.evidence}`);
  }

  console.log("\n── summary ──");
  console.log(JSON.stringify({
    dry: report.dry,
    ttlDays: report.ttlDays,
    cap: report.cap,
    rulesProduced: report.candidates.length,
    created: report.created,
    refreshed: report.refreshed,
    cappedOut: report.cappedOut,
    expired: report.expired,
    expiredNames: report.expiredNames,
  }, null, 2));

  if (!opts.dry) await listCandidates();
  if (opts.dry) console.log("\n(--dry: DB 미변경 — 적재하려면 --run)");

  await itemsPool.end();
}

main().catch((err) => {
  console.error("distill 오류:", err?.stack ?? err);
  process.exit(1);
});
