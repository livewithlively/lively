// V4-P2a — 기계 kind 흡수(LLM 0, 결정론). 12 kind → 4 본질(R/K/H/W).
//   흡수: A/D/F/M/L/Z → K. (S/G = domainmap 파생 federated 뷰 = ku kind 아님, 라이브 0행.)
//   W·R·H·K 불변. provenance(confidence enum)·lifecycle·observed·116 총수 불변.
//
// 실행: npm run build && node --env-file=.env scripts/v4-absorb-kinds.mjs [--dry]
//   --dry: 카운트만 출력(쓰기 0). 미지정: 라이브 실행(백업→흡수→CHECK narrow→registry 정리→검증).
//
// 멱등·비파괴:
//   (1) 백업: knowledge_unit / _domain / _project 를 *_v4bak_p2a 로 물리 복사(IF NOT EXISTS, 존재 시 스킵).
//   (2) 흡수: UPDATE kind(56행)·kinds[] jsonb 정규화(17행, 흡수원소→K·dedup). 이미 K면 no-op.
//   (3) CHECK narrow: kind/kinds CHECK 를 (R,K,H,W)로. confidence_chk 식 DROP+probe(이미 4값이면 스킵).
//   (4) registry 정리: kind_registry 에서 R/K/H/W 외(A/D/F/G/M/L/S/Z) 삭제. 이미 4행이면 no-op.
//   ※ schema.ts(시드/CHECK 소스)도 같은 페이즈에서 4kind 로 갱신됨 — 부팅 initOrgSchema 가 재광역화/재시드 안 함.
//
//  주의: knowledge_unit·_domain·_project 는 ITEMS_DATABASE_URL(itemsPool). domainmap 은 별 DB(무관).
import { itemsPool } from "../dist/items/store.js";

const DRY = process.argv.includes("--dry");
const BAK = "_v4bak_p2a"; // 고정 백업 태그(멱등 — 재실행해도 같은 테이블, IF NOT EXISTS 로 1회만)
const KEEP = ["R", "K", "H", "W"];               // 본질 4종(유지)
const ABSORB = ["A", "D", "F", "M", "L", "Z"];   // → K 로 흡수
const REMOVE_REGISTRY = ["A", "D", "F", "G", "M", "L", "S", "Z"]; // registry 에서 제거(S/G 포함)
const BACKUP_TABLES = ["knowledge_unit", "knowledge_unit_domain", "knowledge_unit_project"];

const q = (s, a) => itemsPool.query(s, a).then((r) => r.rows);
const log = [];
const say = (m) => { log.push(m); console.log(m); };

// ── 사전 카운트(불변식 검증 기준선) ──
async function snapshot() {
  const [total] = await q(`SELECT count(*)::int n FROM knowledge_unit`);
  const [obs] = await q(`SELECT count(*)::int n FROM knowledge_unit WHERE confidence='observed'`);
  const kinds = await q(`SELECT kind, count(*)::int n FROM knowledge_unit GROUP BY kind ORDER BY kind`);
  const [absorbScalar] = await q(`SELECT count(*)::int n FROM knowledge_unit WHERE kind = ANY($1)`, [ABSORB]);
  const [absorbArr] = await q(`SELECT count(*)::int n FROM knowledge_unit WHERE kinds ?| $1::text[]`, [ABSORB]);
  const [sg] = await q(`SELECT count(*)::int n FROM knowledge_unit WHERE kind IN ('S','G') OR kinds ?| array['S','G']`);
  const reg = await q(`SELECT kind FROM kind_registry ORDER BY kind`);
  const dom = await q(`SELECT to_regclass('public.knowledge_unit_domain') t`).then((r) => r[0].t);
  const proj = await q(`SELECT to_regclass('public.knowledge_unit_project') t`).then((r) => r[0].t);
  const [kud] = dom ? await q(`SELECT count(*)::int n FROM knowledge_unit_domain`) : [{ n: null }];
  const [kup] = proj ? await q(`SELECT count(*)::int n FROM knowledge_unit_project`) : [{ n: null }];
  return { total: total.n, observed: obs.n, kinds, absorbScalar: absorbScalar.n, absorbArr: absorbArr.n, sg: sg.n, registry: reg.map((r) => r.kind), kud: kud.n, kup: kup.n };
}

// ── (1) 백업 ──
async function backup() {
  for (const t of BACKUP_TABLES) {
    const exists = await q(`SELECT to_regclass('public.${t}') t`).then((r) => r[0].t);
    if (!exists) { say(`  backup: ${t} 원본 없음 — 스킵`); continue; }
    const bakName = t + BAK;
    const bakExists = await q(`SELECT to_regclass('public.${bakName}') t`).then((r) => r[0].t);
    if (bakExists) {
      const [c] = await q(`SELECT count(*)::int n FROM ${bakName}`);
      say(`  backup: ${bakName} 이미 존재(${c.n}행) — 스킵(멱등)`);
      continue;
    }
    if (DRY) { say(`  [dry] backup: CREATE TABLE ${bakName} AS SELECT * FROM ${t}`); continue; }
    await itemsPool.query(`CREATE TABLE ${bakName} AS SELECT * FROM ${t}`);
    const [c] = await q(`SELECT count(*)::int n FROM ${bakName}`);
    say(`  backup: ${bakName} 생성(${c.n}행)`);
  }
}

// ── (2) 흡수 ──
async function absorb() {
  // scalar kind
  if (DRY) {
    const [c] = await q(`SELECT count(*)::int n FROM knowledge_unit WHERE kind = ANY($1)`, [ABSORB]);
    say(`  [dry] absorb scalar: ${c.n}행 kind → K`);
  } else {
    const r = await itemsPool.query(`UPDATE knowledge_unit SET kind='K' WHERE kind = ANY($1)`, [ABSORB]);
    say(`  absorb scalar: ${r.rowCount}행 kind → K`);
  }
  // kinds[] jsonb 정규화 — 흡수원소를 K 로 치환하고 중복 제거(예: ["D","K"]→["K"], ["F","M"]→["K"]).
  //  jsonb_array_elements 로 펼쳐 각 원소를 매핑(흡수→K, 그 외 유지)하고 DISTINCT 로 dedup 후 재집계.
  //  빈 배열/흡수원소 없는 배열은 결과가 동일 → 무변경(no-op).
  const NORMALIZE = `
    WITH src AS (
      SELECT name, kinds FROM knowledge_unit WHERE kinds ?| $1::text[]
    ), mapped AS (
      SELECT s.name,
             COALESCE(
               jsonb_agg(DISTINCT CASE WHEN e.val = ANY($1) THEN 'K' ELSE e.val END),
               '[]'::jsonb
             ) AS new_kinds
      FROM src s
      LEFT JOIN LATERAL jsonb_array_elements_text(s.kinds) AS e(val) ON true
      GROUP BY s.name
    )
    UPDATE knowledge_unit ku SET kinds = m.new_kinds
    FROM mapped m WHERE ku.name = m.name AND ku.kinds <> m.new_kinds`;
  if (DRY) {
    const [c] = await q(`SELECT count(*)::int n FROM knowledge_unit WHERE kinds ?| $1::text[]`, [ABSORB]);
    say(`  [dry] absorb kinds[]: ${c.n}행 정규화 대상(흡수원소→K·dedup)`);
  } else {
    const r = await itemsPool.query(NORMALIZE, [ABSORB]);
    say(`  absorb kinds[]: ${r.rowCount}행 정규화(흡수원소→K·dedup)`);
  }
}

// ── (3) CHECK narrow (DROP+probe 멱등) ──
//  현 kind_chk/kinds_chk 는 NOT EXISTS 가드라 12값 굳음. confidence_chk 가 쓰는 pg_get_constraintdef 프로브로
//  "이미 4값(=narrow)이면 스킵" 하고, 아니면 DROP 후 4값 재ADD. 반드시 흡수(2) 후 — 잔존 A/D/F/M 위반 방지.
async function narrowChecks() {
  const sql = `
    DO $$ BEGIN
      -- kind scalar CHECK: 4값 narrow. 이미 narrow(레거시 문자 미포함)면 스킵.
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_kind_chk'
          AND pg_get_constraintdef(oid) NOT LIKE '%''A''%'
          AND pg_get_constraintdef(oid) NOT LIKE '%''D''%'
          AND pg_get_constraintdef(oid) NOT LIKE '%''F''%'
      ) THEN
        ALTER TABLE knowledge_unit DROP CONSTRAINT IF EXISTS knowledge_unit_kind_chk;
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_kind_chk
          CHECK (kind IN ('R','K','H','W'));
      END IF;
      -- kinds[] jsonb CHECK: 4값 화이트리스트 narrow. 이미 narrow면 스킵.
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_kinds_chk'
          AND pg_get_constraintdef(oid) NOT LIKE '%"A"%'
          AND pg_get_constraintdef(oid) NOT LIKE '%"D"%'
          AND pg_get_constraintdef(oid) NOT LIKE '%"F"%'
      ) THEN
        ALTER TABLE knowledge_unit DROP CONSTRAINT IF EXISTS knowledge_unit_kinds_chk;
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_kinds_chk CHECK (
          jsonb_typeof(kinds) = 'array'
          AND kinds <@ '["R","K","H","W"]'::jsonb);
      END IF;
    END $$;`;
  if (DRY) {
    const defs = await q(`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conrelid='knowledge_unit'::regclass AND conname IN ('knowledge_unit_kind_chk','knowledge_unit_kinds_chk')`);
    say(`  [dry] narrow CHECK — 현재:`);
    for (const d of defs) say(`         ${d.conname}: ${d.def}`);
    return;
  }
  await itemsPool.query(sql);
  const defs = await q(`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
    WHERE conrelid='knowledge_unit'::regclass AND conname IN ('knowledge_unit_kind_chk','knowledge_unit_kinds_chk') ORDER BY conname`);
  for (const d of defs) say(`  narrow CHECK ${d.conname}: ${d.def}`);
}

// ── (4) registry 정리 ──
async function cleanRegistry() {
  if (DRY) {
    const rows = await q(`SELECT kind FROM kind_registry WHERE kind = ANY($1) ORDER BY kind`, [REMOVE_REGISTRY]);
    say(`  [dry] registry 정리: ${rows.map((r) => r.kind).join(",") || "(없음)"} 삭제 → R/K/H/W 4행`);
    return;
  }
  const r = await itemsPool.query(`DELETE FROM kind_registry WHERE kind = ANY($1)`, [REMOVE_REGISTRY]);
  const remain = await q(`SELECT kind FROM kind_registry ORDER BY kind`);
  say(`  registry 정리: ${r.rowCount}행 삭제 — 잔존 ${remain.map((x) => x.kind).join(",")}`);
}

async function main() {
  say(`=== V4-P2a 기계 kind 흡수 (${DRY ? "DRY" : "LIVE"}) ===`);
  const before = await snapshot();
  say(`[before] total=${before.total} observed=${before.observed} kud=${before.kud} kup=${before.kup}`);
  say(`[before] kind dist: ${before.kinds.map((k) => `${k.kind}:${k.n}`).join(" ")}`);
  say(`[before] absorb scalar=${before.absorbScalar} kinds[]=${before.absorbArr} S/G=${before.sg} registry=${before.registry.join(",")}`);

  say(`-- (1) 백업 --`);
  await backup();
  say(`-- (2) 흡수 (A/D/F/M/L/Z → K) --`);
  await absorb();
  say(`-- (3) CHECK narrow (R,K,H,W) --`);
  await narrowChecks();
  say(`-- (4) registry 정리 (R/K/H/W 만) --`);
  await cleanRegistry();

  const after = await snapshot();
  say(`[after] total=${after.total} observed=${after.observed} kud=${after.kud} kup=${after.kup}`);
  say(`[after] kind dist: ${after.kinds.map((k) => `${k.kind}:${k.n}`).join(" ")}`);
  say(`[after] absorb scalar=${after.absorbScalar} kinds[]=${after.absorbArr} registry=${after.registry.join(",")}`);

  // ── 불변식 검증 ──
  const inv = [];
  inv.push([`총수 불변 116`, after.total === before.total && (DRY || after.total === 116)]);
  inv.push([`observed 불변 71`, after.observed === before.observed && (DRY || after.observed === 71)]);
  inv.push([`kud 불변`, after.kud === before.kud]);
  inv.push([`kup 불변`, after.kup === before.kup]);
  if (!DRY) {
    inv.push([`kind = R/K/H/W 만`, after.kinds.every((k) => KEEP.includes(k.kind))]);
    inv.push([`absorb scalar 잔존 0`, after.absorbScalar === 0]);
    inv.push([`absorb kinds[] 잔존 0`, after.absorbArr === 0]);
    inv.push([`registry = R,K,H,W`, JSON.stringify(after.registry) === JSON.stringify(["H", "K", "R", "W"])]);
    const kExpected = (before.kinds.find((k) => k.kind === "K")?.n ?? 0) + before.absorbScalar;
    const kGot = after.kinds.find((k) => k.kind === "K")?.n ?? 0;
    inv.push([`K = 기존K + 흡수56 (${kExpected})`, kGot === kExpected]);
  }
  say(`-- 불변식 --`);
  let ok = true;
  for (const [name, pass] of inv) { say(`  [${pass ? "OK" : "FAIL"}] ${name}`); if (!pass) ok = false; }
  say(ok ? `=== ${DRY ? "DRY 통과(쓰기 0)" : "LIVE 완료 — 무손실 검증 통과"} ===` : `=== 검증 실패 — 확인 필요 ===`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => itemsPool.end().catch(() => {}));
