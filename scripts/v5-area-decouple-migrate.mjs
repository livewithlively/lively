// V5 area 탈-repo 라이브 비파괴 마이그 — business 6 도메인을 repo_id productivity→NULL 로 이행.
//  비파괴: 백업 테이블(IF NOT EXISTS) + 멱등(이미 NULL 이면 0행) + PRE=POST 불변식 출력.
//  스키마 DDL(부분유니크 인덱스 생성·옛 UNIQUE DROP)은 schema.ts init() 이 부팅 시 멱등 적용한다 —
//  이 스크립트는 **데이터 이행만** 담당(business repo_id NULL). items DB 는 수술 안 함(코드 조인키만 교체).
//  실행: node --env-file=.env scripts/v5-area-decouple-migrate.mjs
import pg from "pg";

const DM_URL = process.env.DOMAINMAP_DATABASE_URL;
if (!DM_URL) { console.error("DOMAINMAP_DATABASE_URL 미설정"); process.exit(1); }
const dm = new pg.Pool({ connectionString: DM_URL });

const q = async (sql, params = []) => (await dm.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

async function snapshot(label) {
  const prod = await one(`SELECT count(*)::int n FROM domain WHERE space='product' AND state<>'merged'`);
  const biz = await one(`SELECT count(*)::int n FROM domain WHERE space='business' AND state<>'merged'`);
  const bizNull = await one(`SELECT count(*)::int n FROM domain WHERE space='business' AND state<>'merged' AND repo_id IS NULL`);
  const merged = await one(`SELECT count(*)::int n FROM domain WHERE state='merged'`);
  const cross = await one(`SELECT count(*)::int n FROM (SELECT key FROM domain WHERE state<>'merged' GROUP BY key HAVING count(*)>1) t`);
  const bizKeys = (await q(`SELECT key FROM domain WHERE space='business' AND state<>'merged' ORDER BY key`)).map((r) => r.key);
  const prodDist = await q(`SELECT r.name, count(*)::int n FROM domain d LEFT JOIN repo r ON r.id=d.repo_id WHERE d.space='product' AND d.state<>'merged' GROUP BY r.name ORDER BY r.name`);
  return { label, product: prod.n, business: biz.n, business_repo_null: bizNull.n, merged: merged.n, cross_space_key_conflicts: cross.n, business_keys: bizKeys, product_repo_dist: prodDist };
}

(async () => {
  try {
    const PRE = await snapshot("PRE");
    console.log("=== PRE ===\n" + JSON.stringify(PRE, null, 1));

    // 0) 백업(PRE 스냅샷 보존, 재실행 멱등 — IF NOT EXISTS 라 첫 실행본만 보존).
    await dm.query(`CREATE TABLE IF NOT EXISTS domain__v5bak_areadecouple AS TABLE domain`);
    await dm.query(`CREATE TABLE IF NOT EXISTS repo__v5bak_areadecouple   AS TABLE repo`);
    const bak = await one(`SELECT count(*)::int n FROM domain__v5bak_areadecouple`);
    console.log(`백업 테이블 domain__v5bak_areadecouple 행수=${bak.n}`);

    // 1) 부분유니크 인덱스(멱등) — schema.ts init() 이 이미 걸지만 스크립트 단독 실행 대비 방어적 생성.
    await dm.query(`CREATE UNIQUE INDEX IF NOT EXISTS domain_space_key_uq ON domain(space, key) WHERE state <> 'merged'`);
    // 2) 옛 UNIQUE(repo_id,key) 폐기(멱등).
    await dm.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='domain'::regclass AND conname='domain_repo_id_key_key') THEN
        ALTER TABLE domain DROP CONSTRAINT domain_repo_id_key_key;
      END IF; END $$;`);

    // 3) business 6 → repo_id NULL(멱등: 이미 NULL 이면 0행). 라이블리 'productivity' 레포 아래 행만.
    const upd = await dm.query(`UPDATE domain SET repo_id=NULL, updated_at=now()
      WHERE space='business' AND state<>'merged'
        AND repo_id=(SELECT id FROM repo WHERE name='productivity')`);
    console.log(`business repo_id→NULL UPDATE 적용 행수=${upd.rowCount} (멱등: 재실행 시 0)`);

    const POST = await snapshot("POST");
    console.log("=== POST ===\n" + JSON.stringify(POST, null, 1));

    // PRE=POST 불변식(business 6 보존·product 30 보존·merged 보존·충돌 0). 유일 의도 변화 = business repo_null 6.
    const inv = [];
    const chk = (name, ok) => { inv.push({ name, ok }); if (!ok) console.error("불변식 위반:", name); };
    chk("business 6 보존", POST.business === PRE.business && POST.business === 6);
    chk("product 30 보존", POST.product === PRE.product && POST.product === 30);
    chk("product repo 분포 불변", JSON.stringify(POST.product_repo_dist) === JSON.stringify(PRE.product_repo_dist));
    chk("business key 집합 불변", JSON.stringify(POST.business_keys) === JSON.stringify(PRE.business_keys));
    chk("merged 보존", POST.merged === PRE.merged);
    chk("cross-space-key 충돌 0 유지", POST.cross_space_key_conflicts === 0);
    chk("business repo_id 전부 NULL(의도 변화)", POST.business_repo_null === 6);
    const allOk = inv.every((i) => i.ok);
    console.log("=== 불변식 ===\n" + JSON.stringify(inv, null, 1));
    console.log(allOk ? "✓ 모든 불변식 충족 — 비파괴 이행 성공" : "✗ 불변식 위반 — 롤백 검토");
    process.exit(allOk ? 0 : 2);
  } catch (e) {
    console.error("마이그 실패:", e);
    process.exit(1);
  } finally {
    await dm.end();
  }
})();
