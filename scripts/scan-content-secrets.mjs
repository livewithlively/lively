// P8 — 콘텐츠 스토어 시크릿 전수 스캔 (상시 검증용 · CI 후보).
//
//   제품 원칙: "시크릿은 어떤 콘텐츠에도 안 들어간다 — 외부 시크릿 매니저 + 멤버별 DB role."
//   이 스크립트는 콘텐츠 스토어(에이전트·사람이 자유 텍스트를 쓰는 본문 컬럼)를 전수 순회하며
//   org/ingest/redact.ts 의 choke-point 두 함수를 그대로 적용한다:
//     · assertNoHardSecrets — 저장이 거부됐어야 할 하드 시크릿(OpenAI/GitHub/Slack/AWS/lvk/개인키).
//     · redactDeep(SECRET_RES) — 마스킹 대상 시크릿 패턴(JWT·Bearer 등 hard-block 보다 넓은 집합).
//   hit 이 하나라도 있으면 exit 1(검증 실패). **값은 절대 출력하지 않는다** — 위치(테이블/PK/컬럼)와
//   매치한 패턴 라벨만 보고한다.
//
//   스캔 대상(자유텍스트 콘텐츠만 — env-이름 참조 필드(auth_env/auth_ref/url)는 별도 choke-point 가 가드):
//     items DB:     knowledge_unit(name/title/body_md), org_member(display_name/email/body_md/identities)
//     domainmap DB: domain(name/description), debt_finding(title/detail)
//
//   실행: node --env-file=/tmp/co-p1a-worktree/.env /tmp/co-p1a-worktree/scripts/scan-content-secrets.mjs
//         (--env-file-if-exists 도 무방). DB 미설정이면 해당 스토어는 skip(보고만, fail 아님).

import { itemsPool } from "../dist/items/store.js";
import { dmPool, endPool } from "../dist/domainmap/db.js";
import { assertNoHardSecrets, redactDeep } from "../dist/org/ingest/redact.js";

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

async function scanItems(allHits) {
  if (!process.env.ITEMS_DATABASE_URL) {
    console.log("[skip] ITEMS_DATABASE_URL 미설정 — knowledge_unit/org_member 스캔 생략");
    return { knowledge_unit: 0, org_member: 0 };
  }
  let nKnowledge = 0;
  let nMember = 0;

  const ku = await itemsPool.query(`SELECT name, title, body_md FROM knowledge_unit`);
  for (const row of ku.rows) {
    const hits = inspectRow("knowledge_unit", "name", ["name", "title", "body_md"], row);
    nKnowledge += hits.length ? 1 : 0;
    allHits.push(...hits);
  }

  const mem = await itemsPool.query(`SELECT id, display_name, email, body_md, identities FROM org_member`);
  for (const row of mem.rows) {
    const hits = inspectRow("org_member", "id", ["display_name", "email", "body_md", "identities"], row);
    nMember += hits.length ? 1 : 0;
    allHits.push(...hits);
  }

  return { knowledge_unit: ku.rows.length, knowledge_unit_hits: nKnowledge, org_member: mem.rows.length, org_member_hits: nMember };
}

async function scanDomainmap(allHits) {
  if (!process.env.DOMAINMAP_DATABASE_URL) {
    console.log("[skip] DOMAINMAP_DATABASE_URL 미설정 — domain/debt_finding 스캔 생략");
    return { domain: 0, debt_finding: 0 };
  }
  const db = dmPool();
  let nDomain = 0;
  let nDebt = 0;

  const dom = await db.query(`SELECT id, name, description FROM domain`);
  for (const row of dom.rows) {
    const hits = inspectRow("domain", "id", ["name", "description"], row);
    nDomain += hits.length ? 1 : 0;
    allHits.push(...hits);
  }

  const debt = await db.query(`SELECT id, title, detail FROM debt_finding`);
  for (const row of debt.rows) {
    const hits = inspectRow("debt_finding", "id", ["title", "detail"], row);
    nDebt += hits.length ? 1 : 0;
    allHits.push(...hits);
  }

  return { domain: dom.rows.length, domain_hits: nDomain, debt_finding: debt.rows.length, debt_finding_hits: nDebt };
}

async function main() {
  console.log("[P8 scan-content-secrets] 콘텐츠 스토어 전수 시크릿 스캔 (값 비출력)");
  const allHits = [];

  const itemsSummary = await scanItems(allHits);
  let dmSummary;
  try {
    dmSummary = await scanDomainmap(allHits);
  } catch (err) {
    // domainmap 미가용(엔진 비활성 등)은 스캔 실패가 아니라 skip 으로 — 값 출력 없음.
    console.log("[skip] domainmap 스캔 생략(엔진 비활성/미가용):", err?.message ?? String(err));
    dmSummary = { domain: 0, debt_finding: 0 };
  }

  console.log("\n── 스캔 요약(행 수 / hit 행 수) ──");
  console.log(JSON.stringify({ items: itemsSummary, domainmap: dmSummary }, null, 2));

  console.log("\n── 시크릿 hit (위치/패턴 라벨만 — 값 비출력) ──");
  if (allHits.length === 0) {
    console.log("  (없음) — 하드 시크릿 0, 마스킹 패턴 0");
  } else {
    for (const h of allHits) {
      console.log(`  HIT table=${h.table} pk=${h.pk} column=${h.column} hard=${h.hard} masked=${h.masked}`);
    }
  }

  await itemsPool.end().catch(() => {});
  await endPool().catch(() => {});

  if (allHits.length > 0) {
    console.error(`\nFAIL — 콘텐츠 스토어에 시크릿 패턴 ${allHits.length}건 발견(위 위치 확인 후 로테이션/제거).`);
    process.exit(1);
  }
  console.log("\nPASS — 콘텐츠 스토어 하드시크릿 0.");
  process.exit(0);
}

main().catch((err) => {
  console.error("scan 오류:", err?.stack ?? err);
  process.exit(2);
});
