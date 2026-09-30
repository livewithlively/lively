// P8 — 콘텐츠 스토어 시크릿 전수 스캔 (상시 검증용 · CI 후보).
//
//   제품 원칙: "시크릿은 어떤 콘텐츠에도 안 들어간다 — 외부 시크릿 매니저 + 멤버별 DB role."
//   이 스크립트는 콘텐츠 스토어(에이전트·사람이 자유 텍스트를 쓰는 본문 컬럼)를 전수 순회하며
//   src/org/ingest/redact.ts 의 choke-point 두 함수를 그대로 적용한다:
//     · assertNoHardSecrets — 저장이 거부됐어야 할 하드 시크릿(OpenAI/GitHub/Slack/AWS/lvk/개인키).
//     · redactDeep — 마스킹 대상 시크릿 패턴(토큰 모양 + Bearer 문맥 — hard-block 보다 넓은 집합).
//   hit 이 하나라도 있으면 exit 1(검증 실패). **값은 절대 출력하지 않는다** — 위치(테이블/PK/컬럼)와
//   매치한 패턴 라벨만 보고한다.
//
//   스캔 대상(자유텍스트 콘텐츠만 — env-이름 참조 필드(auth_env/auth_ref/url)는 별도 choke-point 가 가드):
//     단일 DB(ITEMS_DATABASE_URL — 도메인맵 테이블도 여기 병합됨, src/domainmap/db.ts). 목록은 아래 SCAN_TARGETS.
//     ⚠ 테이블·컬럼 이름이 스키마와 어긋나면 스캔이 통째로 죽는다(2026-06-24 v6 컷오버로 knowledge_unit·domain 이
//      드랍된 뒤 이 스크립트가 그 상태였다) — scripts/scan-content-secrets.test.mjs 가 스키마 정의와 대조한다.
//
//   실행(게이트웨이 앱 디렉터리에서, dist 빌드 필요): node --env-file=.env scripts/scan-content-secrets.mjs
//         (--env-file-if-exists 도 무방). DB 미설정이면 skip(보고만, fail 아님).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { itemsPool, endPool } from "../dist/db/client.js";
import { assertNoHardSecrets, redactDeep } from "../dist/org/ingest/redact.js";

// 스캔 대상 — 테이블 · PK · 자유텍스트 컬럼. 스키마 정의: src/v6/schema/knowledge.ts · src/v6/schema/category-team.ts ·
//  src/org/schema/core.ts · src/domainmap/core/schema.ts · src/v6/schema/project.ts · src/v6/schema/task-detail.ts.
export const SCAN_TARGETS = [
  { table: "knowledge", pk: "name", cols: ["name", "title", "body_md", "summary"] },
  { table: "category", pk: "key", cols: ["name", "description", "should"] },
  { table: "org_member", pk: "id", cols: ["display_name", "email", "body_md", "identities"] },
  { table: "debt_finding", pk: "id", cols: ["title", "detail"] },
  // #4501 결정 2-1 — v6 쓰기 입구에 hard-block 을 걸면서 프로젝트·태스크(같은 project 테이블)·댓글·체크리스트도 본다.
  { table: "project", pk: "id", cols: ["name", "description"] },
  { table: "task_comment", pk: "id", cols: ["body"] },
  { table: "task_checklist_item", pk: "id", cols: ["name"] },
  { table: "knowledge_comment", pk: "id", cols: ["body"] },
];

// 한 문자열 값에 시크릿 흔적이 있는지 — hard(저장거부 대상) + mask(마스킹 대상) 둘 다 검사.
//  값은 반환하지 않는다(불리언·종류만). hard 는 assertNoHardSecrets throw 여부로, mask 는
//  redactDeep 적용 전후가 달라지는지로 판정(둘 다 redact.ts 의 단일 패턴 출처를 그대로 쓴다).
function inspectValue(value) {
  if (typeof value !== "string" || value === "") return null;
  let hard = false;
  try {
    assertNoHardSecrets(value, "scan");
  } catch {
    hard = true; // 메시지에 시크릿 값은 없음(라벨만) — 그래도 메시지는 보고에 싣지 않는다.
  }
  const masked = redactDeep(value) !== value; // 마스킹으로 바뀌면 시크릿 패턴 매치(JWT/Bearer 등 포함).
  if (!hard && !masked) return null;
  return { hard, masked };
}

// 행의 여러 컬럼을 검사 — jsonb(identities) 는 통째 직렬화해 검사(redactDeep 가 깊은 순회로 마스킹하므로
//  문자열화 후 패턴 매치로 충분). value 출력 0.
function inspectRow(table, pk, cols, row) {
  const hits = [];
  for (const col of cols) {
    let raw = row[col];
    if (raw == null) continue;
    if (typeof raw === "object") raw = JSON.stringify(raw); // jsonb(identities 등)
    const r = inspectValue(String(raw));
    if (r) hits.push({ table, pk: String(row[pk] ?? "?"), column: col, hard: r.hard, masked: r.masked });
  }
  return hits;
}

// 테이블 하나를 전수 스캔 — 테이블이 없으면(해당 스키마 미초기화) skip 으로 보고한다(fail 아님).
async function scanTable({ table, pk, cols }, allHits) {
  const exists = (await itemsPool.query(`SELECT to_regclass($1) AS r`, [table])).rows[0].r !== null;
  if (!exists) {
    console.log(`[skip] 테이블 ${table} 없음 — 스캔 생략`);
    return { rows: 0, hit_rows: 0, skipped: true };
  }
  const res = await itemsPool.query(`SELECT ${[pk, ...cols.filter((c) => c !== pk)].join(", ")} FROM ${table}`);
  let hitRows = 0;
  for (const row of res.rows) {
    const hits = inspectRow(table, pk, cols, row);
    hitRows += hits.length ? 1 : 0;
    allHits.push(...hits);
  }
  return { rows: res.rows.length, hit_rows: hitRows };
}

async function main() {
  console.log("[P8 scan-content-secrets] 콘텐츠 스토어 전수 시크릿 스캔 (값 비출력)");
  if (!(process.env.ITEMS_DATABASE_URL ?? "").trim()) {
    console.log("[skip] ITEMS_DATABASE_URL 미설정 — 스캔 생략");
    process.exit(0);
  }
  const allHits = [];
  const summary = {};
  for (const target of SCAN_TARGETS) summary[target.table] = await scanTable(target, allHits);

  console.log("\n── 스캔 요약(행 수 / hit 행 수) ──");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n── 시크릿 hit (위치/패턴 라벨만 — 값 비출력) ──");
  if (allHits.length === 0) {
    console.log("  (없음) — 하드 시크릿 0, 마스킹 패턴 0");
  } else {
    for (const h of allHits) {
      console.log(`  HIT table=${h.table} pk=${h.pk} column=${h.column} hard=${h.hard} masked=${h.masked}`);
    }
  }

  await endPool().catch(() => {});

  if (allHits.length > 0) {
    console.error(`\nFAIL — 콘텐츠 스토어에 시크릿 패턴 ${allHits.length}건 발견(위 위치 확인 후 로테이션/제거).`);
    process.exit(1);
  }
  console.log("\nPASS — 콘텐츠 스토어 하드시크릿 0.");
  process.exit(0);
}

// 직접 실행일 때만 스캔한다(테스트는 SCAN_TARGETS 만 읽는다). ⚠ 심링크를 푼다 — 배포 레이아웃
//  (`current → releases/<id>`)에서 부르면 어휘 경로와 import.meta.url 이 어긋나 **출력 0줄·exit 0** 으로 조용히
//  건너뛴다(kit/setup/kit-manifest.mjs isDirectRun 과 같은 함정). 검증 스크립트의 침묵은 «PASS» 로 오독된다.
const directRun = (() => {
  try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (directRun) {
  main().catch((err) => {
    console.error("scan 오류:", err?.stack ?? err);
    process.exit(2);
  });
}
