// 수정이력(작성자/리비전) 레거시 백필 — org_content_audit(entity='knowledge_unit')의 가산 컬럼
//  actor_kind/channel 을 멱등·비파괴로 채우고, 미러(커넥터) observed ku 중 리비전 이력이 *없는* 행에
//  v1 합성 리비전(op='mirror_backfill')을 append 한다. knowledge_unit 본체는 미변경(append-only INSERT/UPDATE 가산만).
//
//  실행: node --env-file-if-exists=.env scripts/backfill-ku-revision.mjs
//  멱등: ① channel/actor_kind 는 WHERE ... IS NULL 가드 → 재실행 0행. ② v1 합성은 NOT EXISTS(audit) 가드.
//  비파괴: PRE/POST 에서 knowledge_unit 건수 불변(PRE.ku === POST.ku) 검증 — ku 본체 무수술.
//  actor_kind 도출 규칙(deriveActorKind 동치, SQL):
//   ① channel='connector' 또는 actor LIKE 'connector:%' → 'connector'
//   ② channel='migration' 또는 actor LIKE 'migration%'  → 'system'
//   ③ org_member 조인(id 또는 email): agent→ai, human→human, system→system
//   ④ 그 외(미존재/email 미매칭) → 'unknown'
import pg from "pg";

const URL = process.env.ITEMS_DATABASE_URL;
if (!URL) { console.error("ITEMS_DATABASE_URL 미설정 — .env 확인"); process.exit(1); }
const pool = new pg.Pool({ connectionString: URL });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

async function snapshot(label) {
  const ku = await one(`SELECT count(*)::int n FROM knowledge_unit`);
  const audit = await one(`SELECT count(*)::int n FROM org_content_audit WHERE entity='knowledge_unit'`);
  const chanNull = await one(`SELECT count(*)::int n FROM org_content_audit WHERE entity='knowledge_unit' AND channel IS NULL`);
  const akNull = await one(`SELECT count(*)::int n FROM org_content_audit WHERE entity='knowledge_unit' AND actor_kind IS NULL`);
  const obsNoRev = await one(`
    SELECT count(*)::int n FROM knowledge_unit ku
     WHERE ku.confidence='observed'
       AND NOT EXISTS (SELECT 1 FROM org_content_audit a WHERE a.entity='knowledge_unit' AND a.entity_key=ku.name)`);
  return { label, knowledge_unit: ku.n, audit_rows: audit.n, channel_null: chanNull.n, actor_kind_null: akNull.n, observed_without_revision: obsNoRev.n };
}

(async () => {
  try {
    const PRE = await snapshot("PRE");
    console.log("=== PRE ===\n" + JSON.stringify(PRE, null, 1));

    // 1) channel = source(어댑터 채널) 멱등 백필. 단 enum(mcp/web/connector/cli/migration/unknown) 밖 잡값
    //    (cleanup/test/dogfood 등)은 CHECK 위반 → 'unknown' 으로 정규화(레거시 무손상, 신규는 어댑터가 정확히 채움).
    const VALID_CHAN = ["mcp", "web", "connector", "cli", "migration"];
    const r1a = await pool.query(`
      UPDATE org_content_audit SET channel=source
       WHERE entity='knowledge_unit' AND channel IS NULL AND source = ANY($1::text[])`, [VALID_CHAN]);
    const r1b = await pool.query(`
      UPDATE org_content_audit SET channel='unknown'
       WHERE entity='knowledge_unit' AND channel IS NULL`);
    console.log(`channel 백필: source 유효=${r1a.rowCount}, unknown 정규화=${r1b.rowCount} (멱등: 재실행 0)`);

    // 2) actor_kind 멱등 백필 — 우선순위 규칙(SQL). connector/migration 먼저, 그다음 org_member 조인, 폴백 unknown.
    const r2a = await pool.query(`
      UPDATE org_content_audit SET actor_kind='connector'
       WHERE entity='knowledge_unit' AND actor_kind IS NULL
         AND (channel='connector' OR actor LIKE 'connector:%')`);
    const r2b = await pool.query(`
      UPDATE org_content_audit SET actor_kind='system'
       WHERE entity='knowledge_unit' AND actor_kind IS NULL
         AND (channel='migration' OR actor LIKE 'migration%')`);
    const r2c = await pool.query(`
      UPDATE org_content_audit a SET actor_kind=
        CASE m.kind WHEN 'agent' THEN 'ai' WHEN 'human' THEN 'human' WHEN 'system' THEN 'system' ELSE 'unknown' END
       FROM org_member m
       WHERE a.entity='knowledge_unit' AND a.actor_kind IS NULL
         AND (m.id=a.actor OR m.email=a.actor)`);
    const r2d = await pool.query(`
      UPDATE org_content_audit SET actor_kind='unknown'
       WHERE entity='knowledge_unit' AND actor_kind IS NULL`);
    console.log(`actor_kind 백필: connector=${r2a.rowCount}, system=${r2b.rowCount}, member조인=${r2c.rowCount}, unknown폴백=${r2d.rowCount} (멱등: 재실행 0)`);

    // 3) 커넥터 observed ku 중 리비전 이력이 *없는* 행 → v1 합성(op='mirror_backfill'). 미러가 과거 audit 미경유라
    //    이력이 비어있던 71행에 현재 행 스냅샷으로 v1 을 채운다. NOT EXISTS 가드(멱등). after = 현재 ku 행 스냅샷
    //    (title/body_md/kind/source/confidence/author — 이미 redact 된 라이브 값). channel/actor_kind='connector'.
    const r3 = await pool.query(`
      INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel, actor_kind, at)
        SELECT 'knowledge_unit', ku.name, 'mirror_backfill', NULL,
               jsonb_build_object('name',ku.name,'kind',ku.kind,'title',ku.title,'body_md',ku.body_md,
                                  'source',ku.source,'confidence',ku.confidence,'author',ku.author),
               COALESCE(ku.author,'connector:'||COALESCE(ku.external_system,'unknown')),
               COALESCE(ku.external_system,'connector'), 'connector', 'connector',
               COALESCE(ku.last_synced_at, ku.updated_at, now())
          FROM knowledge_unit ku
         WHERE ku.confidence='observed'
           AND NOT EXISTS (SELECT 1 FROM org_content_audit a WHERE a.entity='knowledge_unit' AND a.entity_key=ku.name)`);
    console.log(`커넥터 observed v1 합성 리비전 append=${r3.rowCount} (멱등: NOT EXISTS 가드)`);

    const POST = await snapshot("POST");
    console.log("=== POST ===\n" + JSON.stringify(POST, null, 1));

    // 불변식: ku 본체 건수 불변(비파괴). audit 은 v1 합성만큼 증가 허용.
    if (PRE.knowledge_unit !== POST.knowledge_unit) {
      console.error(`❌ 불변식 위반: knowledge_unit 건수 변동 ${PRE.knowledge_unit}→${POST.knowledge_unit}`);
      process.exit(3);
    }
    if (POST.channel_null !== 0 || POST.actor_kind_null !== 0) {
      console.error(`❌ 백필 미완: channel_null=${POST.channel_null}, actor_kind_null=${POST.actor_kind_null}`);
      process.exit(3);
    }
    console.log(`✅ 불변식 OK: ku ${PRE.knowledge_unit}=${POST.knowledge_unit}(불변), channel/actor_kind NULL 0, audit ${PRE.audit_rows}→${POST.audit_rows}(+${POST.audit_rows - PRE.audit_rows} v1 합성)`);
  } catch (e) {
    console.error("백필 실패:", e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
