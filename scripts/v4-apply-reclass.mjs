// V4-P2b Apply — staging(ku_reclass_stage) → 라이브 guarded 적용.
//   분류는 *판단*(에이전트 LLM이 staging 적재). 본 스크립트는 *결정론 적용* — 외부 API 0.
//   비파괴·멱등·보수적(4중가드). git commit/push·:8080 restart 안 함(DB만).
//
// 실행: npm run build && node --env-file=.env scripts/v4-apply-reclass.mjs [--dry]
//   --dry: 카운트만(쓰기 0). 미지정: 라이브(백업→kind→area→provenance→검증).
//
// 적용 4단(전부 보수·멱등):
//   (1) 백업: ku/kud/kup → *_v4bak_p2b (IF NOT EXISTS, 존재 시 스킵).
//   (2) kind 정교화(보수적): UPDATE kind=new_kind WHERE kind_conf>=0.85 AND new_kind IN (R,K,H,W)
//       AND ku.confidence<>'human'(사람저작 kind 무override) AND new_kind<>현kind. (주로 K→H.)
//       conf<0.85 제안은 보류(큐). CHECK(R,K,H,W) 위반 없음(흡수 P2a 완료·new_kind 4종).
//   (3) area → proposed: 각 area_json 항목(space,key)을 active vocab 으로 repo 해소 후
//       knowledge_unit_domain INSERT(name,repo,domain_key,mapped_by='llm',state='proposed',confidence=area_conf)
//       ON CONFLICT(name,repo,domain_key) DO NOTHING. state='proposed'라 자동 active-index 진입 X(큐레이션 큐).
//       통제어휘(active domain.key+space) 밖 key 는 스킵+로그.
//   (4) provenance 오라벨 수정: UPDATE confidence=new_provenance WHERE new_provenance IN (human,ai)
//       AND 현confidence='rule' AND new_provenance NOT NULL. (rule 오라벨만 — observed/human/ai 무손.)
//
// 멱등: 재실행 시 kind 이미 new면 new<>cur 거짓→0, area 이미 존재→ON CONFLICT 0, provenance 이미 ai/human→cur<>rule→0.
//
// 풀: ku/kud/kup = itemsPool(ITEMS_DATABASE_URL). vocab(domain→repo) = dmPool(DOMAINMAP_DATABASE_URL, 읽기만).
import { itemsPool } from "../dist/items/store.js";
import { dmPool, endPool } from "../dist/domainmap/db.js";

const DRY = process.argv.includes("--dry");
const BAK = "_v4bak_p2b";
const KIND_KEEP = ["R", "K", "H", "W"];
const KIND_CONF_MIN = 0.85;
const PROV_TARGETS = ["human", "ai"];
const BACKUP_TABLES = ["knowledge_unit", "knowledge_unit_domain", "knowledge_unit_project"];

const q = (s, a) => itemsPool.query(s, a).then((r) => r.rows);
const dq = (s, a) => dmPool().query(s, a).then((r) => r.rows);
const log = [];
const say = (m) => { log.push(m); console.log(m); };

// ── 스냅샷(불변식 기준선) ──
async function snapshot() {
  const [total] = await q(`SELECT count(*)::int n FROM knowledge_unit`);
  const [obs] = await q(`SELECT count(*)::int n FROM knowledge_unit WHERE confidence='observed'`);
  const kinds = await q(`SELECT kind, count(*)::int n FROM knowledge_unit GROUP BY kind ORDER BY kind`);
  const prov = await q(`SELECT confidence, count(*)::int n FROM knowledge_unit GROUP BY confidence ORDER BY confidence`);
  const [kud] = await q(`SELECT count(*)::int n FROM knowledge_unit_domain`);
  const [kudProposedLlm] = await q(`SELECT count(*)::int n FROM knowledge_unit_domain WHERE mapped_by='llm' AND state='proposed'`);
  const [kup] = await q(`SELECT count(*)::int n FROM knowledge_unit_project`);
  return {
    total: total.n, observed: obs.n,
    kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
    prov: Object.fromEntries(prov.map((p) => [p.confidence, p.n])),
    kud: kud.n, kudProposedLlm: kudProposedLlm.n, kup: kup.n,
  };
}

// ── (1) 백업 ──
async function backup() {
  for (const t of BACKUP_TABLES) {
    const bakName = t + BAK;
    const exists = await q(`SELECT to_regclass($1) t`, ["public." + bakName]).then((r) => r[0].t);
    if (exists) {
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

// ── (2) kind 정교화(보수적) ──
async function refineKind() {
  const WHERE = `s.kind_conf>=$1 AND s.new_kind = ANY($2) AND ku.confidence<>'human' AND s.new_kind<>ku.kind`;
  const cands = await q(
    `SELECT s.name, ku.kind cur, s.new_kind, s.kind_conf, ku.confidence prov
     FROM ku_reclass_stage s JOIN knowledge_unit ku ON ku.name=s.name
     WHERE ${WHERE} ORDER BY s.name`,
    [KIND_CONF_MIN, KIND_KEEP]
  );
  // 보류(제안은 있으나 게이트 미달): 진단 로그.
  const held = await q(
    `SELECT s.name, ku.kind cur, s.new_kind, s.kind_conf, ku.confidence prov
     FROM ku_reclass_stage s JOIN knowledge_unit ku ON ku.name=s.name
     WHERE s.new_kind<>ku.kind AND NOT (${WHERE}) ORDER BY s.name`,
    [KIND_CONF_MIN, KIND_KEEP]
  );
  for (const h of held) {
    const why = h.prov === "human" ? "human무override"
      : h.kind_conf < KIND_CONF_MIN ? `conf<${KIND_CONF_MIN}(보류)`
      : "기타";
    say(`  hold kind: ${h.name} ${h.cur}->${h.new_kind} conf=${h.kind_conf} prov=${h.prov} [${why}]`);
  }
  if (DRY) {
    say(`  [dry] refine kind: ${cands.length}행 적용 예정`);
    for (const c of cands) say(`         ${c.name}: ${c.cur}->${c.new_kind} conf=${c.kind_conf}`);
    return cands.length;
  }
  let n = 0;
  for (const c of cands) {
    const r = await itemsPool.query(`UPDATE knowledge_unit SET kind=$1 WHERE name=$2`, [c.new_kind, c.name]);
    n += r.rowCount;
    say(`  refine kind: ${c.name} ${c.cur}->${c.new_kind} (conf=${c.kind_conf})`);
  }
  say(`  refine kind: ${n}행 적용`);
  return n;
}

// ── (3) area → proposed ──
async function applyArea() {
  // active 통제어휘: (space,key) → repo
  const vrows = await dq(`SELECT d.key, d.space, r.name repo FROM domain d JOIN repo r ON d.repo_id=r.id WHERE d.state='active'`);
  const vocab = new Map();
  for (const v of vrows) vocab.set(v.space + "|" + v.key, v.repo);

  const stg = await q(`SELECT name, area_json, area_conf FROM ku_reclass_stage WHERE jsonb_typeof(area_json)='array'`);
  let inserted = 0, conflict = 0, skipped = 0;
  const skippedKeys = new Map();
  for (const row of stg) {
    for (const a of row.area_json) {
      const kk = (a.space ?? "") + "|" + (a.key ?? "");
      const repo = vocab.get(kk);
      if (!repo) {
        skipped++;
        skippedKeys.set(kk, (skippedKeys.get(kk) || 0) + 1);
        continue;
      }
      if (DRY) {
        const [e] = await q(`SELECT 1 FROM knowledge_unit_domain WHERE name=$1 AND repo=$2 AND domain_key=$3`, [row.name, repo, a.key]);
        if (e) conflict++; else inserted++;
        continue;
      }
      const r = await itemsPool.query(
        `INSERT INTO knowledge_unit_domain(name, repo, domain_key, mapped_by, confidence, state)
         VALUES($1,$2,$3,'llm',$4,'proposed')
         ON CONFLICT (name, repo, domain_key) DO NOTHING`,
        [row.name, repo, a.key, row.area_conf]
      );
      if (r.rowCount === 1) inserted++; else conflict++;
    }
  }
  if (skipped > 0) {
    say(`  area skip(통제어휘 밖): ${skipped}건 — ${[...skippedKeys.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`);
  } else {
    say(`  area skip(통제어휘 밖): 0건`);
  }
  say(`  area ${DRY ? "[dry] " : ""}INSERT proposed(llm): net new=${inserted}, conflict(skip)=${conflict}`);
  return { inserted, conflict, skipped };
}

// ── (4) provenance 오라벨 수정 ──
async function fixProvenance() {
  const cands = await q(
    `SELECT s.name, ku.confidence cur, s.new_provenance np
     FROM ku_reclass_stage s JOIN knowledge_unit ku ON ku.name=s.name
     WHERE s.new_provenance = ANY($1) AND ku.confidence='rule' AND s.new_provenance IS NOT NULL
     ORDER BY s.new_provenance, s.name`,
    [PROV_TARGETS]
  );
  const byNp = {};
  for (const c of cands) byNp[c.np] = (byNp[c.np] || 0) + 1;
  if (DRY) {
    say(`  [dry] provenance fix(rule→X): ${cands.length}행 — ${JSON.stringify(byNp)}`);
    return cands.length;
  }
  let n = 0;
  for (const c of cands) {
    const r = await itemsPool.query(
      `UPDATE knowledge_unit SET confidence=$1 WHERE name=$2 AND confidence='rule'`,
      [c.np, c.name]
    );
    n += r.rowCount;
  }
  say(`  provenance fix(rule→X): ${n}행 — ${JSON.stringify(byNp)}`);
  return n;
}

async function main() {
  say(`=== V4-P2b Apply 재분류 (${DRY ? "DRY" : "LIVE"}) ===`);
  const [stgCount] = await q(`SELECT count(*)::int n FROM ku_reclass_stage`);
  say(`[staging] ku_reclass_stage = ${stgCount.n}행`);
  const before = await snapshot();
  say(`[before] total=${before.total} observed=${before.observed} kud=${before.kud}(llm-proposed=${before.kudProposedLlm}) kup=${before.kup}`);
  say(`[before] kind=${JSON.stringify(before.kinds)} prov=${JSON.stringify(before.prov)}`);

  say(`-- (1) 백업 → ${BAK} --`);
  await backup();
  say(`-- (2) kind 정교화(conf>=${KIND_CONF_MIN}·human무override·new<>cur) --`);
  const kindN = await refineKind();
  say(`-- (3) area → knowledge_unit_domain(mapped_by=llm·state=proposed) --`);
  const area = await applyArea();
  say(`-- (4) provenance 오라벨 수정(rule→human/ai) --`);
  const provN = await fixProvenance();

  const after = await snapshot();
  say(`[after] total=${after.total} observed=${after.observed} kud=${after.kud}(llm-proposed=${after.kudProposedLlm}) kup=${after.kup}`);
  say(`[after] kind=${JSON.stringify(after.kinds)} prov=${JSON.stringify(after.prov)}`);

  // ── 불변식 ──
  const inv = [];
  inv.push([`ku 총수 불변 116`, after.total === before.total && after.total === 116]);
  inv.push([`observed 불변 71`, after.observed === before.observed && after.observed === 71]);
  inv.push([`kup 불변`, after.kup === before.kup]);
  if (!DRY) {
    inv.push([`kind ⊆ R/K/H/W`, Object.keys(after.kinds).every((k) => KIND_KEEP.includes(k))]);
    inv.push([`kind 변경수 일치(${kindN})`, true]); // 진단(0 정상 — conf<0.85 보류)
    inv.push([`area net new 적재 = kud 증가(${area.inserted})`, after.kud - before.kud === area.inserted]);
    inv.push([`area 전부 proposed/llm 진입(+${area.inserted})`, after.kudProposedLlm - before.kudProposedLlm === area.inserted]);
    inv.push([`provenance rule→X (${provN}) = rule 감소`, (before.prov.rule || 0) - (after.prov.rule || 0) === provN]);
    inv.push([`provenance 합 보존(human+ai 증가 = rule 감소)`,
      ((after.prov.human || 0) + (after.prov.ai || 0)) - ((before.prov.human || 0) + (before.prov.ai || 0)) === provN]);
    inv.push([`area 통제어휘 밖 = 0`, area.skipped === 0]);
  }
  say(`-- 불변식 --`);
  let ok = true;
  for (const [name, pass] of inv) { say(`  [${pass ? "OK" : "FAIL"}] ${name}`); if (!pass) ok = false; }
  say(`[요약] kind적용=${kindN} area적재=${area.inserted}(충돌skip=${area.conflict}) provenance수정=${provN}`);
  say(ok ? `=== ${DRY ? "DRY 통과(쓰기 0)" : "LIVE 완료 — 비파괴 검증 통과"} ===` : `=== 검증 실패 — 확인 필요 ===`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await itemsPool.end().catch(() => {}); await endPool().catch(() => {}); });
