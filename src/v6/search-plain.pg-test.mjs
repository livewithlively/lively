// 화면 검색(⌘K) 서버 술어 PG 통합 테스트(#4530) — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 postgres 잡(.github/workflows/test.yml)에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/search-plain.pg-test.mjs
//
// 왜 이 계층인가: 고친 것이 전부 **SQL 의 모양**이다 — LIKE 이스케이프 · 정렬 머리(제목 먼저) · 휴지통 NOT EXISTS · 뿌리 보관 JOIN.
//  문자열 단위 시험(search-util.test.ts)은 SQL 조각의 모양만 잠그고, 그 조각이 실제 행을 어떻게 고르는지는 DB 만 안다.
//
//  사양·엣지 표(S1~S10) — 원준 2026-10-01 «너가 얘기한 문제 다 좀 고쳐» · 점검 #4530 항목 20·22·27·31:
//   S1 지식 plain: «통합검색(⌘K)» 가 제목에 그대로 있으면 찾는다(종전 grep 은 괄호를 정규식 묶음으로 읽어 0건)
//   S2 지식 plain: 조사를 붙여 쳐도(«검색을») 조사 없는 글(«검색») 을 찾는다
//   S3 지식 grep: 제목에 낱말이 든 옛 문서가 본문만 스친 새 문서보다 먼저(LIMIT 1 로 잘라도 남는다)
//   S4 자료: «%» 는 글자 그대로(종전엔 와일드카드라 태그가 든 자료가 전부 맞았다)
//   S5 자료: 낱말 AND — 떨어져 있어도 둘 다 들어 있으면 맞는다(종전엔 붙은 구절만)
//   S6 자료: 제목에 낱말이 든 것이 먼저(종전엔 시각 순뿐)
//   S7 프로젝트: 휴지통 프로젝트와 그 태스크·서브태스크는 grep·count 어디에도 안 나온다(plain 이든 아니든)
//   S8 프로젝트 행: archived(뿌리 기준)·draft·parent_name 이 실린다
//   S9 프로젝트 grep: 이름에 낱말이 든 옛 프로젝트가 본문만 스친 새 프로젝트보다 먼저
//   S10 유사(id 기준 · 저장된 벡터): 휴지통 제외 + 행 표식 동일 · 지식 유사(text)는 임베딩 off 면 diag.embeddings="off"
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const ks = await import(`${DIST}/v6/knowledge-search.js`);
const ps = await import(`${DIST}/v6/project-store.js`);
const ss = await import(`${DIST}/v6/source-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = "zqplain" + Math.floor(Math.random() * 1e6);
const mkK = async (name, title, body, updatedAt) => itemsPool.query(
  `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source, visibility, updated_at)
     VALUES($1,$2,$3,'recalled','authored','active','ai','authored','open',$4)`, [name, title, body, updatedAt]);
const mkS = async (name, title, body, occurredAt) => (await itemsPool.query(
  `INSERT INTO source(name, kind, title, body_md, lifecycle, occurred_at) VALUES($1,'note',$2,$3,'active',$4) RETURNING id`,
  [name, title, body, occurredAt])).rows[0].id;
const mkP = async (level, name, opts = {}) => (await itemsPool.query(
  `INSERT INTO project(level, name, description, status, created_by, parent_id, draft, updated_at)
     VALUES($1,$2,$3,'active',$4,$5,$6,COALESCE($7, now())) RETURNING id`,
  [level, name, opts.description ?? "", TAG, opts.parent ?? null, opts.draft ?? false, opts.updatedAt ?? null])).rows[0].id;
const cleanup = async () => {
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [TAG + "%"]);
  await itemsPool.query(`DELETE FROM source WHERE name LIKE $1`, [TAG + "%"]);
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1 AND level='subtask'`, [TAG]);
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1 AND level='task'`, [TAG]);
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1`, [TAG]);
};

try {
  await cleanup();
  const OLD = "2026-01-01T00:00:00Z", NEW = "2026-09-30T00:00:00Z";

  // ── S1·S2·S3 지식 ──
  await mkK(TAG + "_paren", `통합검색(⌘K) 결함 점검 ${TAG}`, "본문", OLD);
  await mkK(TAG + "_josa", `조사 시험 ${TAG}`, `여기서 세션 검색 결함을 본다 ${TAG}`, OLD);
  await mkK(TAG + "_title", `배포절차 안내 ${TAG}`, "본문은 짧다", OLD);
  await mkK(TAG + "_body", `다른 문서 ${TAG}`, `본문에 배포절차 가 스친다 ${TAG}`, NEW);
  {
    const plain = await ks.searchKnowledge(`통합검색(⌘K) ${TAG}`, { plain: true, limit: 5 });
    const legacy = await ks.searchKnowledge(`통합검색(⌘K) ${TAG}`, { limit: 5 });
    chk("S1 지식 plain: 괄호 든 제목을 글자 그대로 찾는다", plain.some((r) => r.name === TAG + "_paren"), JSON.stringify(plain.map((r) => r.name)));
    chk("S1b 종전 grep(에이전트 계약)은 그대로 정규식 — 이 글은 0건(그래서 화면은 plain 을 쓴다)", legacy.length === 0, JSON.stringify(legacy.map((r) => r.name)));
    const josa = await ks.searchKnowledge(`검색을 ${TAG}`, { plain: true, limit: 5 });
    chk("S2 지식 plain: «검색을» 로 «검색» 이 든 글을 찾는다", josa.some((r) => r.name === TAG + "_josa"), JSON.stringify(josa.map((r) => r.name)));
    const n = await ks.countKnowledgeGrep(`검색을 ${TAG}`, { plain: true });
    chk("S2b count 도 같은 술어", n === josa.length, `count=${n} rows=${josa.length}`);
    const tf = await ks.searchKnowledge(`배포절차 ${TAG}`, { plain: true, limit: 1 });
    chk("S3 지식 grep: 제목에 든 옛 문서가 본문만 스친 새 문서보다 먼저(LIMIT 1)", tf[0]?.name === TAG + "_title", JSON.stringify(tf.map((r) => r.name)));
    const tfLegacy = await ks.searchKnowledge(`배포절차 ${TAG}`, { limit: 1 });
    chk("S3b 에이전트 grep(토큰)도 제목 먼저", tfLegacy[0]?.name === TAG + "_title", JSON.stringify(tfLegacy.map((r) => r.name)));
  }

  // ── S4·S5·S6 자료 ──
  const sPct = await mkS(TAG + "_pct", `할인 100% 안내 ${TAG}`, "본문", OLD);
  const sNo = await mkS(TAG + "_nopct", `일반 안내 ${TAG}`, "퍼센트 기호 없음", NEW);
  const sSplit = await mkS(TAG + "_split", `회의 메모 ${TAG}`, `배포 이야기를 하다가 한참 뒤에 장애 이야기 ${TAG}`, OLD);
  const sTitle = await mkS(TAG + "_stitle", `회의록 정리 ${TAG}`, "짧은 본문", OLD);
  const sBody = await mkS(TAG + "_sbody", `t25.log ${TAG}`, `로그 안에 회의록 이라는 낱말 ${TAG}`, NEW);
  {
    const pct = await ss.listSources({ q: `% ${TAG}` });
    const ids = pct.map((r) => Number(r.id));
    chk("S4 자료: «%» 는 글자 그대로 — % 가 든 자료만", ids.includes(sPct) && !ids.includes(sNo), JSON.stringify(ids));
    const n = await ss.countSources({ q: `% ${TAG}` });
    chk("S4b 자료 총계도 같은 술어", n === ids.length, `count=${n} rows=${ids.length}`);
    const split = (await ss.listSources({ q: `배포 장애 ${TAG}` })).map((r) => Number(r.id));
    chk("S5 자료: 떨어진 두 낱말도 AND 로 맞는다", split.includes(sSplit), JSON.stringify(split));
    const order = (await ss.listSources({ q: `회의록 ${TAG}`, limit: 5 })).map((r) => Number(r.id));
    chk("S6 자료: 제목에 든 것이 본문만 스친 새 로그보다 먼저", order[0] === sTitle && order.includes(sBody), JSON.stringify(order));
  }

  // ── S7·S8·S9 프로젝트 ──
  const pOk = await mkP("project", `zqp ${TAG} 살아있음`);
  const pTrash = await mkP("project", `zqp ${TAG} 버린것`);
  const tTrash = await mkP("task", `zqp ${TAG} 버린것의 태스크`, { parent: pTrash });
  const stTrash = await mkP("subtask", `zqp ${TAG} 버린것의 서브`, { parent: tTrash });
  await itemsPool.query(`UPDATE project SET trashed_at=now() WHERE id=$1`, [pTrash]);
  const pArch = await mkP("project", `zqa ${TAG} 보관된것`);
  const tArch = await mkP("task", `zqa ${TAG} 보관된것의 태스크`, { parent: pArch });
  const stArch = await mkP("subtask", `zqa ${TAG} 보관된것의 서브`, { parent: tArch });
  await itemsPool.query(`UPDATE project SET archived_at=now() WHERE id=$1`, [pArch]);
  const pDraft = await mkP("project", `zqd ${TAG} 초안`, { draft: true });
  const pName = await mkP("project", `zqn ${TAG} 배포절차`, { updatedAt: OLD });
  const pDesc = await mkP("project", `zqn ${TAG} 다른 일`, { description: `본문에 배포절차 가 스친다`, updatedAt: NEW });
  {
    for (const plain of [true, false]) {
      const rows = await ps.searchProjects(`zqp ${TAG}`, { plain, limit: 20 });
      const ids = rows.map((r) => r.id);
      chk(`S7 프로젝트 grep(plain=${plain}): 휴지통과 그 태스크·서브태스크는 없다`,
        ids.includes(pOk) && !ids.includes(pTrash) && !ids.includes(tTrash) && !ids.includes(stTrash), JSON.stringify(ids));
      const n = await ps.countProjectGrep(`zqp ${TAG}`, { plain });
      chk(`S7b 프로젝트 count(plain=${plain}): 같은 술어`, n === ids.length, `count=${n} rows=${ids.length}`);
    }
    const arch = await ps.searchProjects(`zqa ${TAG}`, { plain: true, limit: 20 });
    const by = new Map(arch.map((r) => [r.id, r]));
    chk("S8 보관: 뿌리가 보관이면 태스크·서브태스크도 archived", by.get(pArch)?.archived === true && by.get(tArch)?.archived === true && by.get(stArch)?.archived === true, JSON.stringify(arch.map((r) => [r.id, r.archived])));
    chk("S8b parent_name: 태스크는 프로젝트 이름 · 서브태스크는 태스크 이름 · 프로젝트는 null",
      by.get(tArch)?.parent_name === `zqa ${TAG} 보관된것` && by.get(stArch)?.parent_name === `zqa ${TAG} 보관된것의 태스크` && by.get(pArch)?.parent_name === null,
      JSON.stringify(arch.map((r) => [r.id, r.parent_name])));
    const dr = await ps.searchProjects(`zqd ${TAG}`, { plain: true });
    chk("S8c draft 표식", dr.length === 1 && dr[0].draft === true && dr[0].archived === false, JSON.stringify(dr));
    const tf = await ps.searchProjects(`zqn ${TAG} 배포절차`, { plain: true, limit: 1 });
    chk("S9 프로젝트 grep: 이름에 든 옛 것이 본문만 스친 새 것보다 먼저(LIMIT 1)", tf[0]?.id === pName, JSON.stringify(tf.map((r) => r.id)) + ` desc=${pDesc}`);
  }

  // ── S10 유사(저장된 벡터 · 임베딩 off) ──
  {
    const dimRow = (await itemsPool.query(
      `SELECT atttypmod AS d FROM pg_attribute WHERE attrelid='project'::regclass AND attname='embedding_vector'`)).rows[0];
    const dims = Number(dimRow?.d) > 0 ? Number(dimRow.d) : 1024;
    const vec = (seed) => "[" + Array.from({ length: dims }, (_, i) => (i === seed ? 1 : 0.001)).join(",") + "]";
    for (const id of [pOk, pTrash, tTrash, pArch, tArch]) await itemsPool.query(`UPDATE project SET embedding_vector=$2::vector WHERE id=$1`, [id, vec(0)]);
    const ref = await mkP("project", `zqref ${TAG}`);
    await itemsPool.query(`UPDATE project SET embedding_vector=$2::vector WHERE id=$1`, [ref, vec(0)]);
    const sim = await ps.findSimilarProjects({ id: ref, limit: 50, includeDone: true });
    const ids = sim.map((r) => r.id);
    chk("S10 유사(id): 휴지통과 그 태스크는 없다", ids.includes(pOk) && !ids.includes(pTrash) && !ids.includes(tTrash), JSON.stringify(ids));
    const t = sim.find((r) => r.id === tArch);
    chk("S10b 유사 행에도 archived(뿌리)·parent_name", !!t && t.archived === true && t.parent_name === `zqa ${TAG} 보관된것`, JSON.stringify(t));
    const diag = {};
    const none = await ks.findSimilarKnowledge({ text: "아무 글" }, undefined, diag);
    const cfg = (await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`)).rows[0]?.embedding_config;
    const offCfg = !cfg || cfg.provider === "off" || !cfg.provider;
    chk("S10c 지식 유사(text): 임베딩 off 면 diag.embeddings='off'(빈 결과의 까닭)",
      !offCfg || (none.length === 0 && diag.embeddings === "off"), JSON.stringify({ cfg, diag, n: none.length }));
  }
} catch (e) {
  bad("예외", e && e.stack || String(e));
} finally {
  try { await cleanup(); } catch { /* 정리 실패는 결과에 섞지 않는다 */ }
  await itemsPool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
