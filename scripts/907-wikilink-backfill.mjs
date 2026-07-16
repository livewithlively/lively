// #907 본문 [[위키링크]] → 지식↔지식 엣지 백필(1회) — 자동 해소가 붙기 전에 쌓인 '텍스트일 뿐인 링크'를 엣지로 만든다.
//  착수 시점 실측: 활성 지식 본문의 위키링크 939건 중 엣지가 있던 건 136건뿐 — 나머지는 백링크·그래프뷰·recall 에서 안 보였다.
//
//  실행: node --env-file=<게이트웨이 .env> scripts/907-wikilink-backfill.mjs        (DRY=1 미리보기 — 아무것도 안 쓴다)
//  로직은 dist 의 sweepWikiLinks 를 **그대로** 부른다(유지보수 잡 wikilink_sweep 과 한 벌 — 백필만 다르게 동작할 수 없다).
//  멱등·수렴형이라 몇 번을 돌려도 결과가 같다. 되돌리기: DELETE FROM knowledge_link WHERE origin='wikilink';
//   (origin 이 '본문 파생' 표식이라 사람이 knowledge_link 로 만든 엣지(origin='user')는 다치지 않는다.)
import pg from "pg";
import { extractWikiLinkTargets } from "../dist/v6/wikilink.js";
import { resolveWikiLinkTargets, sweepWikiLinks } from "../dist/v6/knowledge-store.js";

const DRY = process.env.DRY === "1";

async function preview() {
  const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 4 });
  try {
    const { rows } = await pool.query(`SELECT name, body_md FROM knowledge`);
    const existing = new Set(rows.map((r) => r.name));
    let docs = 0, edges = 0;
    const dangling = [];
    for (const r of rows) {
      const targets = extractWikiLinkTargets(r.body_md ?? "");
      if (!targets.length) continue;
      docs++;
      const { linked, unmatched } = resolveWikiLinkTargets(r.name, targets, existing);
      edges += linked.length;
      if (unmatched.length) dangling.push({ name: r.name, targets: unmatched });
    }
    const { rows: cur } = await pool.query(`SELECT count(*)::int AS n FROM knowledge_link WHERE origin='wikilink'`);
    console.log(`[DRY] 지식 ${rows.length}건 중 위키링크 보유 ${docs}건 → 엣지 ${edges}건 (현재 origin='wikilink' 엣지 ${cur[0].n}건)`);
    report(dangling);
  } finally {
    await pool.end();
  }
}

// 붕 뜬 링크는 사람이 볼 몫이다 — 오타면 본문을 고치고, 아직 없는 지식이면 그대로 둔다(대상이 생기면 다음 스윕이 잇는다).
function report(dangling) {
  if (!dangling.length) return console.log("붕 뜬 링크 없음.");
  const total = dangling.reduce((n, d) => n + d.targets.length, 0);
  console.log(`\n⚠ 붕 뜬 링크 ${total}건 (문서 ${dangling.length}개) — 대상 지식이 없어 엣지를 못 만든 것:`);
  for (const d of dangling) console.log(`  · ${d.name}\n      → ${d.targets.map((t) => `[[${t}]]`).join(" · ")}`);
}

async function main() {
  if (DRY) return preview();
  const r = await sweepWikiLinks();
  console.log(`지식 ${r.scanned}건 스캔 · 위키링크 보유 ${r.docs}건 → origin='wikilink' 엣지 ${r.edges}건 재작성 완료.`);
  report(r.dangling);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
