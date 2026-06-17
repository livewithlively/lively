// P-V3-3c 듀얼라이트 — ingestItems/declareItemProject → knowledge_unit observed 미러(라이브 적재).
//  실행: npm run build && node --env-file-if-exists=.env dist/org/dualwrite.test.js
//  ITEMS_DATABASE_URL 미설정이면 graceful skip(빌드 게이트 통과). **비파괴**: 합성 좌표('dwtest__' external_id)만
//  생성/대상으로 하고 finally 에서 정리 — 실 item·실 knowledge_unit 무영향.
//  커버: (1) ingestItems 가 clickup task 를 ku observed W 로 미러(저작이 아닌 수집물) (2) 🔴H1 적재 redact +
//        H1-c pull redact (3) declareItemProject 가 knowledge_unit_project 미러 (4) 멱등(재적재=신규 0) (5)
//        분류 불가 조합(slack message)은 미러 skip(레거시 item 만) (6) item(레거시) 무손상 (7) item_legacy 뷰 동치.
import assert from "node:assert/strict";
import { itemsPool, initItemSchema, ingestItems, declareItemProject, getItemIdsByExternalIds, type RawItem } from "../items/store.js";
import { initOrgSchema } from "./schema.js";
import { getKnowledge } from "./knowledge.js";
import { unitName, knowledgeKindFor } from "./knowledge-mirror.js";
import { loadCandidates } from "../items/mapping-candidates.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

const PREFIX = "dwtest__";
// 합성 시크릿(테스트 상수 — redact 패턴 매칭용. 실 시크릿 아님). 마스킹 후 stdout 노출 없음.
const FAKE_OPENAI = "sk-DWTESTABCDEFGHIJKL012345";
const FAKE_GH = "ghp_DWTESTabcdefghijklmnopqrstuvwxyz01";
// 실 productivity 리스트(declare 가능한 project key) — 후보 vocab 에서 동적으로 고른다(하드코딩 금지).

async function main(): Promise<void> {
  if (!process.env.ITEMS_DATABASE_URL) {
    console.log("skip  ITEMS_DATABASE_URL 미설정 — P-V3-3c 듀얼라이트 통합 체크 건너뜀(빌드 게이트는 통과)");
    return;
  }
  await initOrgSchema();
  await initItemSchema();

  const TEAM = "90000000099"; // 합성 instance(실 clickup team 과 겹치지 않음)
  const W_EXT = PREFIX + "task1";
  const M_EXT = PREFIX + "msg1"; // slack message — 분류 불가(미러 skip) 대상
  const W_NAME = unitName("clickup", W_EXT);
  const M_NAME = unitName("slack", M_EXT);

  const cleanup = async (): Promise<void> => {
    await itemsPool.query(`DELETE FROM knowledge_unit_project WHERE name = ANY($1)`, [[W_NAME, M_NAME]]);
    await itemsPool.query(`DELETE FROM knowledge_unit_domain  WHERE name = ANY($1)`, [[W_NAME, M_NAME]]);
    await itemsPool.query(`DELETE FROM knowledge_unit         WHERE name = ANY($1)`, [[W_NAME, M_NAME]]);
    await itemsPool.query(`DELETE FROM item WHERE external_id LIKE $1`, [PREFIX + "%"]);
  };
  await cleanup();

  try {
    // ── 분류 매핑 단언(데이터 의존 없음) ──
    await t("knowledgeKindFor: clickup task→W, notion doc→A, slack message→null(skip)", async () => {
      assert.equal(knowledgeKindFor("task", "clickup"), "W");
      assert.equal(knowledgeKindFor("doc", "notion"), "A");
      assert.equal(knowledgeKindFor("message", "slack"), null);
    });

    // ── declare 가능한 실 project key 하나 확보(productivity 후보에서). 없으면 declare 단언만 skip. ──
    const cands = await loadCandidates("productivity");
    const someProjectKey = [...cands.projectsByKey.keys()][0] ?? null;

    // ── 1) clickup task 적재(듀얼라이트) — 본문/필드/raw 에 합성 시크릿 포함(redact 검증용) ──
    const wRaw: RawItem = {
      type: "task",
      provenance: { category: "pm_tool", system: "clickup", instance: TEAM, external_id: W_EXT, external_url: "https://app.clickup.com/t/dw" },
      title: "듀얼라이트 합성 태스크",
      body: `본문에 토큰 ${FAKE_OPENAI} 포함`,
      occurred_at: "2026-06-18T00:00:00Z",
      fields: { note: "필드값", token: FAKE_GH },
      raw: { raw_secret: FAKE_OPENAI, nested: { k: FAKE_GH } },
    };
    // ── slack message 적재 — 분류 불가(미러 skip) 대상 ──
    const mRaw: RawItem = {
      type: "message",
      provenance: { category: "messenger", system: "slack", instance: TEAM, external_id: M_EXT },
      body: "슬랙 메시지 본문",
      occurred_at: "2026-06-18T01:00:00Z",
    };
    await ingestItems([wRaw, mRaw]);

    await t("ingestItems: clickup task 가 ku observed W 로 미러(수집물 — author=connector:clickup)", async () => {
      const w = await getKnowledge(W_NAME);
      assert.ok(w, "W 유닛 미러됨");
      assert.equal(w!.kind, "W");
      assert.equal(w!.confidence, "observed");
      assert.equal(w!.source, "clickup");
      assert.equal(w!.external_system, "clickup");
      assert.equal(w!.external_id, W_EXT);
      assert.equal(w!.external_instance, TEAM);
      assert.equal(w!.author, "connector:clickup");
      assert.equal(w!.external_url, "https://app.clickup.com/t/dw");
    });

    await t("🔴H1 적재 redact + H1-c pull redact: body/fields/raw 평문 시크릿 없음([REDACTED])", async () => {
      const w = await getKnowledge(W_NAME);
      assert.ok(!w!.body_md.includes(FAKE_OPENAI), "pull body 평문 없음");
      assert.ok(w!.body_md.includes("[REDACTED]"), "pull body 마스킹 표식");
      const fs = JSON.stringify(w!.fields);
      assert.ok(!fs.includes(FAKE_GH) && fs.includes("[REDACTED]"), "pull fields 마스킹");
      const rs = JSON.stringify(w!.raw);
      assert.ok(!rs.includes(FAKE_OPENAI) && !rs.includes(FAKE_GH) && rs.includes("[REDACTED]"), "pull raw 마스킹");
      // 적재 시점 redact(DB 직접 — 저장 자체가 마스킹).
      const db = (await itemsPool.query(`SELECT body_md, fields::text ft, raw::text rt FROM knowledge_unit WHERE name=$1`, [W_NAME])).rows[0];
      assert.ok(!db.body_md.includes(FAKE_OPENAI), "DB 저장 body 평문 없음(적재 redact)");
      assert.ok(!db.ft.includes(FAKE_GH) && !db.rt.includes(FAKE_OPENAI), "DB 저장 fields/raw 평문 없음");
    });

    await t("분류 불가(slack message)는 ku 미러 skip — 레거시 item 만 적재", async () => {
      const m = await getKnowledge(M_NAME);
      assert.equal(m, null, "slack message 는 ku 미러 없음");
      const mItem = (await itemsPool.query(`SELECT count(*)::int n FROM item WHERE external_id=$1`, [M_EXT])).rows[0].n;
      assert.equal(mItem, 1, "slack message 는 레거시 item 에는 적재됨");
    });

    await t("item(레거시) 무손상 — 합성 2건 모두 item 에 존재 + item_legacy 뷰 동치", async () => {
      const ic = (await itemsPool.query(`SELECT count(*)::int n FROM item WHERE external_id LIKE $1`, [PREFIX + "%"])).rows[0].n;
      assert.equal(ic, 2, "item 2건(task+message)");
      const lc = (await itemsPool.query(`SELECT count(*)::int n FROM item_legacy WHERE external_id LIKE $1`, [PREFIX + "%"])).rows[0].n;
      assert.equal(lc, 2, "item_legacy 뷰도 동일 2건(동결 스냅샷 동치)");
    });

    if (someProjectKey) {
      const ids = await getItemIdsByExternalIds("clickup", TEAM, [W_EXT]);
      const wId = ids.get(W_EXT)!;
      await declareItemProject(
        { itemId: wId, projectKey: someProjectKey, repo: "productivity", evidence: "dualwrite test" },
        { candidates: cands, audit: { source: "dualwrite-test", actor: "test" } },
      );
      await t("declareItemProject: knowledge_unit_project 미러(declared·confirmed)", async () => {
        const p = (await itemsPool.query(
          `SELECT project_key, mapped_by, state FROM knowledge_unit_project WHERE name=$1`, [W_NAME])).rows;
        assert.equal(p.length, 1, "ku_project 미러 1건");
        assert.equal(p[0].project_key, someProjectKey);
        assert.equal(p[0].mapped_by, "declared");
        assert.equal(p[0].state, "confirmed");
        // 레거시 item_project 도 동시 반영(듀얼).
        const ip = (await itemsPool.query(`SELECT count(*)::int n FROM item_project WHERE item_id=$1`, [wId])).rows[0].n;
        assert.equal(ip, 1, "레거시 item_project 도 반영");
      });
    } else {
      console.log("skip  declare 미러 단언 — productivity 후보 프로젝트 0건(vocab 없음)");
    }

    await t("멱등: 재적재 = 신규 0(external uidx ON CONFLICT)", async () => {
      const before = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit WHERE name=$1`, [W_NAME])).rows[0].n;
      await ingestItems([wRaw]);
      const after = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_unit WHERE name=$1`, [W_NAME])).rows[0].n;
      assert.equal(after, before, "행수 불변");
      assert.equal(after, 1, "여전히 1건");
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
