// 분류축에서 고정 공간축(space)을 걷어내는 마이그레이션 통합검증(#1631). 실 PG 로 돈다.
//  ⚠ 수동 실행(docker). 실행:  node scripts/category-space-drop.itest.mjs
//
//  왜 실 DB 인가: 이 변경의 위험은 타입이 아니라 **데이터**다. 종전 유니크가 (space,key) 라 옛 DB 엔
//   같은 key 가 space 만 다르게 둘 이상 있을 수 있고, 컬럼만 지우면 key 유일 인덱스가 조용히 안 걸린다
//   (softUniqueIndex 가 보류) → 두 축이 같은 이름으로 공존하고 getCategoryByKey 가 아무거나 준다.
//   그래서 **space 가 있는 옛 스키마를 실제로 만들어 놓고** 마이그레이션을 태운다.
//
//  사양·엣지 표: 이 파일 아래 시나리오가 spec 의 ④⑤⑥ 행과 1:1 이다(④ 빈 DB · ⑤ 충돌 2건 · ⑥ 대체 이름도 선점).
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59473, CNAME = "co-catspace-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
//  ⚠ pgvector 이미지여야 한다 — plain postgres 면 embedding_vector 컬럼이 통째로 안 생겨
//   listCategories(정의-내용 불일치 집계가 그 컬럼을 읽는다)가 42703 으로 죽는다(docker-compose.yml 과 같은 불변식).
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "pgvector/pgvector:pg17"], { stdio: "ignore" });

try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js");
  //  마이그레이션 조각만 부르지 않고 **부팅과 같은 전체 체인**을 태운다 — 조각만 돌리면 뒤 마이그레이션이
  //   더한 컬럼(entry_name·view_mode·embedding_vector…)이 없어 스토어 함수가 그 자리에서 죽는다.
  //   프로덕션에서 이 마이그레이션이 도는 자리도 바로 그 체인 안이다.
  const { initAllSchemas } = await import("../dist/boot/schemas.js");

  const hasSpace = async () => (await itemsPool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='category' AND column_name='space'`)).rowCount === 1;
  const keysById = async () => Object.fromEntries((await itemsPool.query(
    `SELECT id, key FROM category ORDER BY id`)).rows.map((r) => [Number(r.id), r.key]));

  // ── ⑤⑥ 옛 스키마를 **실제로** 만든다 — space NOT NULL + (space,key) 부분 유니크. ──
  //  배선 단언: 마이그레이션 전에 space 가 **있는지** 먼저 확인한다. 없는 걸 지우고 통과하면 vacuous 다.
  await itemsPool.query(`
    CREATE TABLE category(
      id SERIAL PRIMARY KEY, space TEXT NOT NULL, key TEXT NOT NULL, name TEXT,
      description TEXT, should TEXT, cross_cutting BOOLEAN DEFAULT false, origin TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed', state TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    ALTER TABLE category ADD CONSTRAINT category_space_chk CHECK (space IN ('business','product','system'));
    CREATE UNIQUE INDEX category_space_key_uq ON category(space, key) WHERE state <> 'merged';
    CREATE INDEX category_space_idx ON category(space);
  `);
  assert.ok(await hasSpace(), "배선 확인 — 마이그레이션 **전에** space 컬럼이 있어야 한다(없으면 이 시험은 아무것도 안 본다)");

  //  ⑤ 같은 key 가 두 space 에: id 작은 쪽이 원래 key 를 지킨다.
  //  ⑥ 'ops-system' 이 **이미 쓰이고 있다** → 대체 이름이 막혀 `ops-<id>` 로 피해야 한다.
  const seeded = (await itemsPool.query(`
    INSERT INTO category(space, key, name) VALUES
      ('business','ops','운영(사업)'),
      ('system','ops','운영(시스템)'),
      ('product','ops-system','오래전에 이 이름을 쓰던 축'),
      ('business','brewing','양조'),
      ('system','ops-merged-tmp','머지된 옛 행')
    RETURNING id, space, key`)).rows;
  const [bizOps, sysOps, taken, brewing, dup] = seeded.map((r) => Number(r.id));
  //  merged 는 부분 유니크 밖이라 (system,'ops') 를 셋째로 가질 수 있다 — 그 행은 마이그레이션이 안 건드려야 한다.
  //   유니크가 살아 있는 동안엔 INSERT 로 못 넣으므로 state 를 먼저 옮기고 key 를 바꾼다.
  await itemsPool.query(`UPDATE category SET state='merged' WHERE id=$1`, [dup]);
  await itemsPool.query(`UPDATE category SET key='ops' WHERE id=$1`, [dup]);
  const before = await keysById();

  // ── 마이그레이션(= 부팅) ──
  await initAllSchemas();

  {
    assert.equal(await hasSpace(), false, "space 컬럼이 사라져야 한다");
    const idx = (await itemsPool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='category'`)).rows.map((r) => r.indexname);
    assert.ok(!idx.includes("category_space_key_uq"), "옛 (space,key) 유니크가 남으면 안 된다");
    assert.ok(idx.includes("category_key_uq"), "key 단독 유니크가 걸려야 한다");
    const chk = (await itemsPool.query(
      `SELECT 1 FROM pg_constraint WHERE conrelid='category'::regclass AND conname='category_space_chk'`)).rowCount;
    assert.equal(chk, 0, "space CHECK 도 함께 사라져야 한다");
    ok("① 축이 사라진다 — 컬럼·CHECK·옛 유니크 제거, key 단독 유니크 신설");
  }

  {
    const after = await keysById();
    assert.equal(after[bizOps], "ops", "⑤ id 가 작은 쪽이 원래 key 를 지킨다");
    assert.equal(after[sysOps], `ops-${sysOps}`,
      "⑥ 대체 이름 'ops-system' 이 이미 쓰이고 있으므로 `ops-<id>` 로 피해야 한다");
    assert.equal(after[taken], "ops-system", "선점하고 있던 축의 이름은 안 건드린다");
    assert.equal(after[brewing], "brewing", "충돌 없는 축은 그대로");
    assert.equal(after[dup], before[dup], "merged 행은 유니크 밖 — 이름을 바꾸지 않는다");
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(),
      "★ id 는 하나도 안 바뀐다 — knowledge_category·team_category·mapping·debt_finding 이 전부 id 로 매달려 있다");
    ok("⑤⑥ key 충돌을 가르되 **매핑은 무손실** — id 불변, merged 행 불변");
  }

  {
    //  ④ 재실행 멱등 — 부팅마다 도는 코드다. 두 번째엔 space 가 없으니 DO 블록이 통째로 건너뛴다.
    const snap = await keysById();
    await initAllSchemas();
    assert.deepEqual(await keysById(), snap, "재실행이 이름을 또 바꾸면 부팅마다 key 가 늘어난다");
    ok("④ 재실행 멱등 — 두 번째 부팅은 아무것도 안 바꾼다");
  }

  {
    //  ④ 새 워크스페이스(행 0건)에서 목록 — 빈 배열, 오류 없음.
    await itemsPool.query(`DELETE FROM category`);
    const { listCategories } = await import("../dist/v6/category-store.js");
    assert.deepEqual(await listCategories(null), [], "빈 DB 의 목록은 빈 배열");
    ok("④ 분류축이 하나도 없어도 목록이 조용히 빈 배열을 준다");
  }

  {
    //  ② 옛 클라이언트가 space 를 보내와도 만들어져야 한다(배포 순서 — 서버가 먼저 나간다). ③ 같은 key 는 두 번 못 만든다.
    const { createCategory } = await import("../dist/v6/category-store.js");
    const should = "이 축이 무엇을 담고 무엇을 담지 않는지를 적는 자리입니다. 실제 정의는 사람이 씁니다.";
    const made = await createCategory({ space: "product", key: "legacy-client", name: "옛 클라이언트", should });
    assert.equal(made.key, "legacy-client", "② space 를 보내와도 무시하고 만들어진다");
    assert.equal("space" in made, false, "응답에 space 가 남으면 안 된다");
    await assert.rejects(() => createCategory({ key: "legacy-client", name: "중복", should }),
      /duplicate key|unique/i, "③ 같은 key 는 두 번 못 만든다");
    ok("②③ 옛 space 입력은 무시되고, key 는 워크스페이스 안에서 유일하다");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
