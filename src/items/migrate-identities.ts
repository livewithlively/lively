// 신원 통합 일회성 데이터 마이그레이션 — per-source person 사일로 → canonical person + person_identity.
// 결정적·멱등·재실행 안전(2회차 = 전부 0 tally). 단일 트랜잭션: 중간 실패는 전부 롤백.
// 의도적으로 initItemSchema 에 넣지 않음 — cross-repo(members 파일)를 읽는 데이터 마이그레이션이라
// 게이트웨이 부팅마다 돌면 안 된다. DDL 은 initItemSchema(매 부팅 멱등), 데이터는 이 CLI 1회.
//
// 절차(설계결정 2026-06-11 §0-6/7 머지플랜):
//   0. 사전 점검(드리프트 시 전체 중단) — junk 무참조 증명, 픽스처 식별(provenance 트리플)
//   1. 픽스처 아이템 삭제(전체 행 스냅샷 감사) — A1 참조 해소가 목적(삭제 후 junk 3종 전부 무참조)
//   2. junk person 삭제(슬랙 U123/U456, discord A1) — U123 이 yoon@lively.kr 을 들고 있어
//      어떤 이메일 로직보다 먼저 제거(잘못된 email-join 원천 차단). 전부 감사.
//   3. loadBindings — canonical person 4 + manual/confirmed 신원 6 upsert
//   4. 남은 per-source person 행의 일반 이동(바인딩 미커버분 → observed 신원; 라이브 데이터 기준 0건)
//   5. item.actor_id 재포인트(구 행별 감사 카운트) — FK 때문에 6보다 반드시 먼저
//   6. 구 per-source person 행 삭제(무참조 검증 후, 스냅샷 감사)
//   7. tally 출력 + COMMIT
//
// 사용: node --env-file-if-exists=.env dist/items/migrate-identities.js
import { itemsPool, initItemSchema } from "./store.js";
import { loadBindings } from "./load-bindings.js";

interface Tally {
  fixturesDeleted: number;
  junkDeleted: number;
  personsUpserted: number;
  identitiesBound: number;
  identitiesObserved: number;
  itemsRepointed: number;
  oldPersonsDeleted: number;
}

// 픽스처 아이템 — 식별은 provenance 트리플로만(숫자 id 금지).
const FIXTURES = [
  { system: "discord", instance: "G_LIVELY", external_id: "C_DISC:111111111111111111" },
  { system: "notion", instance: "lively-notion", external_id: "notion-uuid-1" },
];
// junk per-source person — 무참조 검증 후에만 삭제.
const JUNK_PERSONS = ["slack:U123", "slack:U456", "discord:A1"];

const SOURCE = "migrate-identities";

await initItemSchema();
const client = await itemsPool.connect();
const tally: Tally = {
  fixturesDeleted: 0, junkDeleted: 0, personsUpserted: 0, identitiesBound: 0,
  identitiesObserved: 0, itemsRepointed: 0, oldPersonsDeleted: 0,
};
const q = async (sql: string, params: unknown[] = []) => client.query(sql, params);
const audit = (action: string, fields: {
  person_id?: string | null; old_person_id?: string | null; system?: string | null;
  external_id?: string | null; item_count?: number | null; detail?: unknown;
}) => q(
  `INSERT INTO person_identity_audit(action, person_id, old_person_id, system, external_id, item_count, detail, source)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
  [action, fields.person_id ?? null, fields.old_person_id ?? null, fields.system ?? null,
   fields.external_id ?? null, fields.item_count ?? null,
   fields.detail != null ? JSON.stringify(fields.detail) : null, SOURCE],
);
const abort = (msg: string): never => { throw new Error(`사전 점검 실패(전체 롤백): ${msg}`); };

try {
  await q("BEGIN");

  // ── STEP 0: 사전 점검 ──
  // (a) slack junk 무참조 증명(픽스처와 무관하게 항상 0이어야 함).
  const slackRefs = (await q(
    `SELECT count(*)::int c FROM item WHERE actor_id IN ('slack:U123','slack:U456')`)).rows[0] as { c: number };
  if (slackRefs.c !== 0) abort(`slack junk person 을 참조하는 item ${slackRefs.c}건 존재`);
  // (b) 픽스처 식별 + 매핑/관계/자식 무참조 증명.
  const fixtureIds: number[] = [];
  for (const f of FIXTURES) {
    const row = (await q(
      `SELECT id FROM item WHERE prov_system=$1 AND prov_instance=$2 AND external_id=$3`,
      [f.system, f.instance, f.external_id])).rows[0] as { id: number } | undefined;
    if (!row) continue; // 재실행: 이미 삭제됨
    const refs = (await q(
      `SELECT (SELECT count(*)::int FROM item_domain WHERE item_id=$1)
            + (SELECT count(*)::int FROM item_project WHERE item_id=$1)
            + (SELECT count(*)::int FROM relation WHERE from_item=$1 OR to_item=$1)
            + (SELECT count(*)::int FROM item WHERE parent_id=$1) AS c`,
      [row.id])).rows[0] as { c: number };
    if (refs.c !== 0) abort(`픽스처 item ${row.id}(${f.system}:${f.external_id}) 에 매핑/관계/자식 참조 ${refs.c}건`);
    fixtureIds.push(Number(row.id));
  }
  // (c) discord:A1 은 픽스처 f1 외 참조 금지.
  const a1Extra = (await q(
    `SELECT count(*)::int c FROM item
     WHERE actor_id='discord:A1' AND NOT (prov_system=$1 AND prov_instance=$2 AND external_id=$3)`,
    [FIXTURES[0].system, FIXTURES[0].instance, FIXTURES[0].external_id])).rows[0] as { c: number };
  if (a1Extra.c !== 0) abort(`discord:A1 이 픽스처 외 item ${a1Extra.c}건에서 참조됨`);

  // ── STEP 1: 픽스처 아이템 삭제(전체 행 스냅샷 감사) ──
  for (const f of FIXTURES) {
    const del = await q(
      `DELETE FROM item WHERE prov_system=$1 AND prov_instance=$2 AND external_id=$3 RETURNING *`,
      [f.system, f.instance, f.external_id]);
    for (const row of del.rows) {
      await audit("fixture-item-deleted", {
        system: f.system, external_id: f.external_id, item_count: 1, detail: row,
      });
      tally.fixturesDeleted++;
    }
  }

  // ── STEP 2: junk person 삭제(트랜잭션 내 재검증 후) — U123(yoon@lively.kr) 이 어떤 이메일 로직보다 먼저 제거 ──
  for (const junkId of JUNK_PERSONS) {
    const exists = (await q(`SELECT 1 FROM person WHERE id=$1`, [junkId])).rowCount ?? 0;
    if (!exists) continue; // 재실행: 이미 삭제됨
    const refs = (await q(`SELECT count(*)::int c FROM item WHERE actor_id=$1`, [junkId])).rows[0] as { c: number };
    if (refs.c !== 0) abort(`junk person ${junkId} 를 참조하는 item ${refs.c}건 — 삭제 불가`);
    const del = await q(`DELETE FROM person WHERE id=$1 RETURNING *`, [junkId]);
    for (const row of del.rows) {
      await audit("person-deleted", { old_person_id: junkId, item_count: 0, detail: row });
      tally.junkDeleted++;
    }
  }

  // ── STEP 3: canonical person + 수동 바인딩(members frontmatter ground truth) ──
  const bound = await loadBindings(client);
  tally.personsUpserted = bound.personsUpserted;
  tally.identitiesBound = bound.identitiesBound;

  // ── STEP 4: 남은 per-source person 행의 일반 이동(바인딩 미커버 → observed 신원) ──
  const oldRows = (await q(
    `SELECT id, display_name, identities FROM person
     WHERE id LIKE '%:%' ORDER BY id`)).rows as { id: string; display_name: string | null; identities: unknown }[];
  for (const p of oldRows) {
    const sep = p.id.indexOf(":");
    const system = p.id.slice(0, sep);
    const ext = p.id.slice(sep + 1);
    const claimed = (await q(
      `SELECT 1 FROM person_identity WHERE system=$1 AND external_id=$2`, [system, ext])).rowCount ?? 0;
    if (claimed) continue; // 바인딩이 이미 커버
    const legacy = Array.isArray(p.identities) ? (p.identities as { email?: string | null }[])[0] : undefined;
    await q(
      `INSERT INTO person_identity(person_id, system, external_id, email, display_name, origin, state)
       VALUES($1,$2,$3,$4,$5,'observed','proposed')`,
      [p.id, system, ext, legacy?.email ?? null, p.display_name ?? null]);
    await audit("identity-observed", {
      person_id: p.id, system, external_id: ext,
      detail: { display_name: p.display_name, email: legacy?.email ?? null, fallback: true },
    });
    tally.identitiesObserved++;
  }

  // ── STEP 5: item.actor_id 재포인트(구 행별 — FK 때문에 STEP 6 보다 먼저) ──
  for (const p of oldRows) {
    const sep = p.id.indexOf(":");
    const system = p.id.slice(0, sep);
    const ext = p.id.slice(sep + 1);
    const target = (await q(
      `SELECT person_id FROM person_identity WHERE system=$1 AND external_id=$2`,
      [system, ext])).rows[0] as { person_id: string } | undefined;
    if (!target || target.person_id === p.id) continue; // 폴백 canonical(자기 자신) — 이동 없음
    const upd = await q(
      `UPDATE item SET actor_id=$1 WHERE actor_id=$2`, [target.person_id, p.id]);
    const moved = upd.rowCount ?? 0;
    if (moved > 0) {
      await audit("items-repointed", {
        person_id: target.person_id, old_person_id: p.id, system, external_id: ext, item_count: moved,
      });
      tally.itemsRepointed += moved;
    }
  }

  // ── STEP 6: 무참조가 된 구 per-source person 행 삭제(스냅샷 감사) ──
  const dead = await q(
    `DELETE FROM person p
     WHERE p.id LIKE '%:%'
       AND NOT EXISTS (SELECT 1 FROM item i WHERE i.actor_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM person_identity pi WHERE pi.person_id = p.id)
     RETURNING *`);
  for (const row of dead.rows as { id: string }[]) {
    await audit("person-deleted", { old_person_id: row.id, item_count: 0, detail: row });
    tally.oldPersonsDeleted++;
  }

  // ── STEP 7: tally + COMMIT ──
  await q("COMMIT");
  console.log(JSON.stringify(tally));
} catch (err) {
  await q("ROLLBACK").catch(() => {});
  console.error(`신원 마이그레이션 실패(롤백됨): ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await itemsPool.end();
}
