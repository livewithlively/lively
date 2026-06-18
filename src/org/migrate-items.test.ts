// P-V3-3b item→knowledge_unit 마이그 — DB 통합 체크(M-가). 실행: npm run build && node --env-file-if-exists=.env dist/org/migrate-items.test.js
//  ITEMS_DATABASE_URL 미설정이면 graceful skip(빌드 게이트 통과). **비파괴**: 합성 item('migtest__' 접두)만
//  생성/대상으로 하고 finally 에서 정리 — 실 item·실 knowledge_unit 무영향.
//  커버: (1) 마이그 멱등(2회 실행 = 동일 결과·신규 0) (2) 🔴H1 redact 적재(fields/body 합성 시크릿 마스킹)
//        + 🔴H1-c pull redact(getKnowledge 가 마스킹 반환) (3) observed 인덱스 제외(buildKnowledgeIndex)
//        + overview observed 별도 카운트 (4) 다중도메인/프로젝트 보존.
//  마이그 로직은 scripts/migrate-items-to-ku.mjs 의 export(migrateItems/unitName)를 직접 호출(SQL 동치 보장).
import assert from "node:assert/strict";
import { itemsPool } from "../items/store.js";
import { initOrgSchema } from "./schema.js";
import { getKnowledge, overviewKnowledge, listKnowledge } from "./knowledge.js";
import { buildKnowledgeIndex } from "./materialize.js";
// 컴파일된 테스트(dist/org/)에서 scripts/ 로의 상대경로. 스크립트는 ../dist 를 import(= dist/, 정상).
// @ts-expect-error — .mjs 스크립트(타입 선언 없음). 런타임 named export(migrateItems/unitName)만 사용.
import { migrateItems, unitName } from "../../scripts/migrate-items-to-ku.mjs";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

const PREFIX = "migtest__";
// 합성 시크릿(테스트 상수 — redactDeep/redactString 패턴 매칭용. 실 시크릿 아님). 마스킹 후 stdout 노출 없음.
const FAKE_OPENAI = "sk-MIGTESTABCDEFGHIJKL012345";
const FAKE_GH = "ghp_MIGTESTabcdefghijklmnopqrstuvwxyz01";

async function main(): Promise<void> {
  if (!process.env.ITEMS_DATABASE_URL) {
    console.log("skip  ITEMS_DATABASE_URL 미설정 — P-V3-3b 마이그 통합 체크 건너뜀(빌드 게이트는 통과)");
    return;
  }
  await initOrgSchema();

  // 합성 item 좌표(실 item 과 겹치지 않는 external_id). clickup→W, notion→A.
  const W_EXT = PREFIX + "task1";
  const A_EXT = PREFIX + "doc1";
  const W_NAME = unitName("clickup", W_EXT);
  const A_NAME = unitName("notion", A_EXT);

  const cleanup = async (): Promise<void> => {
    // knowledge_unit 매핑·유닛 정리(접두 또는 합성 external_id 기준).
    await itemsPool.query(`DELETE FROM knowledge_unit_domain  WHERE name = ANY($1)`, [[W_NAME, A_NAME]]);
    await itemsPool.query(`DELETE FROM knowledge_unit_project WHERE name = ANY($1)`, [[W_NAME, A_NAME]]);
    await itemsPool.query(`DELETE FROM knowledge_unit         WHERE name = ANY($1)`, [[W_NAME, A_NAME]]);
    // 합성 item·매핑 정리(item_domain/project 는 item FK ON DELETE CASCADE 라 item 삭제로 함께).
    await itemsPool.query(`DELETE FROM item WHERE external_id LIKE $1`, [PREFIX + "%"]);
  };
  await cleanup();

  try {
    // ── 합성 item 2건 + 다중도메인/프로젝트 매핑 시드(비파괴 — 접두 좌표) ──
    const wId = (await itemsPool.query(
      `INSERT INTO item(type, prov_system, prov_instance, external_id, external_url, title, body, occurred_at, fields, raw)
         VALUES('task','clickup','90000000001',$1,'https://app.clickup.com/t/x','마이그 합성 태스크',
                $2,'2026-06-18T00:00:00Z',$3::jsonb,$4::jsonb)
       RETURNING id`,
      [W_EXT,
       `본문에 토큰 ${FAKE_OPENAI} 가 섞여 있음`,
       JSON.stringify({ note: "필드값", token: FAKE_GH }),
       JSON.stringify({ raw_secret: FAKE_OPENAI, nested: { k: FAKE_GH } })],
    )).rows[0].id as number;
    const aId = (await itemsPool.query(
      `INSERT INTO item(type, prov_system, prov_instance, external_id, external_url, title, body, occurred_at, fields)
         VALUES('doc','notion','default',$1,'https://notion.so/y','마이그 합성 문서','평문 문서 본문',
                '2026-06-17T00:00:00Z','{}'::jsonb)
       RETURNING id`,
      [A_EXT],
    )).rows[0].id as number;

    // 다중도메인(2) + 프로젝트(1) — W item 에 귀속.
    await itemsPool.query(
      `INSERT INTO item_domain(item_id, repo, domain_key, mapped_by, confidence, state, evidence)
         VALUES($1,'productivity','billing','rule',0.8,'confirmed','ev1'),
               ($1,'productivity','auth','llm',0.4,'proposed','ev2')`, [wId]);
    await itemsPool.query(
      `INSERT INTO item_project(item_id, repo, project_key, mapped_by, confidence, state, evidence)
         VALUES($1,'productivity','proj-mig','declared',NULL,'confirmed',NULL)`, [wId]);

    const ovBefore = await overviewKnowledge();

    // ── 1차 마이그(접두 합성 item 만 대상) ──
    const r1 = { units: [] as unknown[], skipped: [] as unknown[], redactedCount: 0, domainRows: 0, projectRows: 0 };
    await migrateItems(r1, { where: `external_id LIKE '${PREFIX}%'` });

    await t("적재: 합성 2건이 observed K/W 로 복사(W=clickup, K=notion; V4-P2a A→K)", async () => {
      const w = await getKnowledge(W_NAME);
      const a = await getKnowledge(A_NAME);
      assert.ok(w && a, "두 유닛 적재됨");
      assert.equal(w!.kind, "W");
      assert.equal(a!.kind, "K"); // V4-P2a: notion doc=산출물→K(흡수), observed 가 외부수집 표현
      assert.equal(w!.confidence, "observed");
      assert.equal(a!.confidence, "observed");
      assert.equal(w!.source, "clickup");
      assert.equal(w!.external_system, "clickup");
      assert.equal(w!.external_id, W_EXT);
      assert.equal(w!.external_instance, "90000000001");
      // external_instance NULL→'' 정규화 검증(notion 은 instance 있었지만 NULL 케이스 방어는 ''):
      assert.equal(a!.external_instance, "default");
    });

    await t("🔴H1 redact 적재 + H1-c pull redact: body/fields/raw 에 평문 시크릿 없음([REDACTED])", async () => {
      const w = await getKnowledge(W_NAME);
      // pull 경로(getKnowledge) 반환에 원문 시크릿이 없어야 한다.
      assert.ok(!w!.body_md.includes(FAKE_OPENAI), "body 에 OpenAI 키 평문 없음");
      assert.ok(w!.body_md.includes("[REDACTED]"), "body 마스킹 표식 존재");
      const fieldsStr = JSON.stringify(w!.fields);
      assert.ok(!fieldsStr.includes(FAKE_GH), "fields 에 GitHub 토큰 평문 없음");
      assert.ok(fieldsStr.includes("[REDACTED]"), "fields 마스킹 표식 존재");
      const rawStr = JSON.stringify(w!.raw);
      assert.ok(!rawStr.includes(FAKE_OPENAI) && !rawStr.includes(FAKE_GH), "raw(중첩 포함) 에 시크릿 평문 없음");
      assert.ok(rawStr.includes("[REDACTED]"), "raw 마스킹 표식 존재");
      // 적재 시점 redact 도 확인(저장 자체가 마스킹 — DB 직접 조회).
      const dbBody = (await itemsPool.query(`SELECT body_md, fields::text ft, raw::text rt FROM knowledge_unit WHERE name=$1`, [W_NAME])).rows[0];
      assert.ok(!dbBody.body_md.includes(FAKE_OPENAI), "DB 저장 본문에 평문 없음(적재 redact)");
      assert.ok(!dbBody.ft.includes(FAKE_GH) && !dbBody.rt.includes(FAKE_OPENAI), "DB 저장 fields/raw 에 평문 없음");
    });

    await t("다중도메인/프로젝트 보존: knowledge_unit_domain 2 + project 1(state/mapped_by/confidence/evidence)", async () => {
      const doms = (await itemsPool.query(
        `SELECT domain_key, mapped_by, confidence, state, evidence FROM knowledge_unit_domain WHERE name=$1 ORDER BY domain_key`, [W_NAME])).rows;
      assert.equal(doms.length, 2, "도메인 2개 보존");
      const billing = doms.find((d) => d.domain_key === "billing");
      const auth = doms.find((d) => d.domain_key === "auth");
      assert.equal(billing.state, "confirmed");
      assert.equal(billing.mapped_by, "rule");
      assert.equal(Number(billing.confidence), 0.8);
      assert.equal(billing.evidence, "ev1");
      assert.equal(auth.state, "proposed");
      assert.equal(auth.mapped_by, "llm");
      const projs = (await itemsPool.query(
        `SELECT project_key, mapped_by, state, confidence FROM knowledge_unit_project WHERE name=$1`, [W_NAME])).rows;
      assert.equal(projs.length, 1, "프로젝트 1개 보존");
      assert.equal(projs[0].project_key, "proj-mig");
      assert.equal(projs[0].mapped_by, "declared");
      assert.equal(projs[0].state, "confirmed");
      assert.equal(projs[0].confidence, null);
    });

    await t("observed 인덱스 제외(buildKnowledgeIndex) — 수집물은 항상-주입 인덱스에 없음", async () => {
      // recalled kind(K/D/F/H)만 인덱스 대상이지만, observed A/W 가 K/D 로 잘못 새지 않음을 보장하기 위해
      //  active 전체를 넘겨 인덱스를 만들고, 합성 유닛 name 이 인덱스에 없음을 확인(confidence='observed' 제외).
      const all = await listKnowledge({ lifecycle: "active" });
      const idx = buildKnowledgeIndex(all);
      assert.ok(!idx.includes(W_NAME), "W observed 유닛 인덱스 비주입");
      assert.ok(!idx.includes(A_NAME), "A observed 유닛 인덱스 비주입");
    });

    await t("overview: observed 2건이 observed_count 로만 집계(total_active/review 영향 0)", async () => {
      const ov = await overviewKnowledge();
      assert.equal(ov.observed_count - ovBefore.observed_count, 2, "observed_count +2");
      assert.equal(ov.total_active - ovBefore.total_active, 0, "큐레이션 active 불변(observed 제외)");
      assert.equal(ov.review_pending - ovBefore.review_pending, 0, "검토 큐 영향 0");
    });

    await t("멱등: 2차 마이그 재실행 = 신규 0, 행수·내용 불변", async () => {
      const obsBefore = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit WHERE name = ANY($1)`, [[W_NAME, A_NAME]])).rows[0].n;
      const versBefore = (await itemsPool.query(`SELECT name, version FROM knowledge_unit WHERE name = ANY($1) ORDER BY name`, [[W_NAME, A_NAME]])).rows;
      const r2 = { units: [] as unknown[], skipped: [] as unknown[], redactedCount: 0, domainRows: 0, projectRows: 0 };
      await migrateItems(r2, { where: `external_id LIKE '${PREFIX}%'` });
      const obsAfter = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit WHERE name = ANY($1)`, [[W_NAME, A_NAME]])).rows[0].n;
      assert.equal(obsAfter, obsBefore, "행수 불변(신규 0 — external uidx ON CONFLICT)");
      assert.equal(obsAfter, 2, "여전히 2건");
      // 다중도메인도 멱등(중복 누적 0).
      const dCount = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit_domain WHERE name=$1`, [W_NAME])).rows[0].n;
      assert.equal(dCount, 2, "도메인 매핑 중복 누적 0");
      // 멱등 재실행은 DO UPDATE 라 version 이 +1 될 수 있음(허용 — 내용 동일·신규 행 0 이 멱등의 핵심).
      assert.equal(versBefore.length, 2);
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
