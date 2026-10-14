// 지식 쓰기 게이트가 «저장 경로가 고칠 이름» 을 보는가. 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/write-gate-name.pg-test.mjs
//
//  왜 이 계층인가: 공개범위 검사(canSeeKnowledge)는 받은 이름 그대로 행을 찾고, 행이 없으면 «없는 문서» 로 통과시킨다.
//   그런데 저장 경로 일부(resolveKnowledgeGate · upsertKnowledge)는 이름을 slugify 한 뒤 그 이름의 행을 고친다.
//   두 이름이 다르면 검사는 빈 자리를 보고 쓰기는 구성원 전용 문서를 친다. 판정이 «그 이름의 행이 있나» 라
//   목으로는 안 보인다 — 핸들러(knowledge_set_title)를 부르고 DB 를 read-back 한다.
//
//  사양 엣지 표(행마다 단언):
//   N1 대소문자만 바꾼 이름 → 비대상은 404 · 제목 그대로
//   N2 64자를 넘겨 정규화하면 잘려서 구성원 전용 문서 이름이 되는 이름 → 404 · 제목 그대로
//   N3 구분자만 바꾼 이름(공백·밑줄) → 404 · 제목 그대로
//   N4 대상(직접 grant)은 대소문자를 바꿔 불러도 고쳐진다 — 정상 경로는 그대로
//   N5 open 문서는 비대상도 대소문자를 바꿔 불러 고친다 — 막는 건 «안 보이는 문서» 뿐
//   N6 쓰기 게이트 자체: 변형 이름 + 비대상 → 404 · 대상 → 통과 · 정확한 이름 + 비대상 → 404(종전 판정 유지)
import assert from "node:assert/strict";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSetTitle } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
const { assertKnowledgeWritable } = await import(`${DIST}/capabilities/knowledge/shared.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n}. ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

// 문서 이름은 slugify 결과와 같은 모양이어야 한다(정규화된 이름이 이 문서를 가리켜야 시나리오가 선다).
const P = "wgn-pg-test-";
const SECRET = `${P}secret`;                                   // 구성원 전용
const LONG = `${P}long-`.padEnd(64, "a");                       // 구성원 전용 · 정확히 64자(slugify 상한)
const OPEN = `${P}open`;                                       // 전원 공개
const INSIDER = "__wgn_pg_test__in";                            // SECRET·LONG 의 직접 grant 대상
const OUTSIDER = "__wgn_pg_test__out";                          // 비대상
assert.equal(LONG.length, 64);

const setTitle = (name, title, viewer) =>
  knowledgeSetTitle.handler({ name, title }, { userId: viewer }, { actor: viewer, source: "mcp", viewer });
const trySetTitle = async (name, title, viewer) => {
  try { await setTitle(name, title, viewer); return { threw: false }; }
  catch (e) { return { threw: true, status: e && e.status, msg: String((e && e.message) || e) }; }
};
const tryGate = async (name, viewer) => {
  try { await assertKnowledgeWritable(name, viewer); return { threw: false }; }
  catch (e) { return { threw: true, status: e && e.status }; }
};
const titleOf = async (name) => (await itemsPool.query(`SELECT title FROM knowledge WHERE name=$1`, [name])).rows[0]?.title;

async function cleanup() {
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${P}%`]);   // grant 는 FK CASCADE
}

async function seed() {
  const mk = (name, visibility) => itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility) VALUES($1, $1, '본문', 'authored', 'active', $2)`,
    [name, visibility]);
  await mk(SECRET, "members");
  await mk(LONG, "members");
  await mk(OPEN, "open");
  for (const name of [SECRET, LONG]) {
    await itemsPool.query(
      `INSERT INTO knowledge_member(name, subject_kind, member_id) VALUES($1, 'member', $2)`, [name, INSIDER]);
  }
}

try {
  await cleanup();
  await seed();

  {
    const r = await trySetTitle(SECRET.toUpperCase(), "바뀐 제목", OUTSIDER);
    chk("N1 대소문자만 바꾼 이름 → 404", r.threw && r.status === 404, JSON.stringify(r));
    chk("N1 제목 그대로", (await titleOf(SECRET)) === SECRET, await titleOf(SECRET));
  }
  {
    const r = await trySetTitle(`${LONG}-tail`, "바뀐 제목", OUTSIDER);
    chk("N2 64자를 넘긴 이름 → 404", r.threw && r.status === 404, JSON.stringify(r));
    chk("N2 제목 그대로", (await titleOf(LONG)) === LONG, await titleOf(LONG));
  }
  {
    const r = await trySetTitle(SECRET.replace(/-/g, "_").replace("secret", " secret"), "바뀐 제목", OUTSIDER);
    chk("N3 구분자만 바꾼 이름 → 404", r.threw && r.status === 404, JSON.stringify(r));
    chk("N3 제목 그대로", (await titleOf(SECRET)) === SECRET, await titleOf(SECRET));
  }
  {
    const r = await trySetTitle(SECRET.toUpperCase(), "대상이 바꾼 제목", INSIDER);
    chk("N4 대상은 변형 이름으로도 고친다", !r.threw, JSON.stringify(r));
    chk("N4 제목이 바뀌었다", (await titleOf(SECRET)) === "대상이 바꾼 제목", await titleOf(SECRET));
  }
  {
    const r = await trySetTitle(OPEN.toUpperCase(), "누구나 바꾼 제목", OUTSIDER);
    chk("N5 open 문서는 비대상도 고친다", !r.threw, JSON.stringify(r));
    chk("N5 제목이 바뀌었다", (await titleOf(OPEN)) === "누구나 바꾼 제목", await titleOf(OPEN));
  }
  {
    const g1 = await tryGate(SECRET.toUpperCase(), OUTSIDER);
    chk("N6 게이트: 변형 이름 + 비대상 → 404", g1.threw && g1.status === 404, JSON.stringify(g1));
    const g2 = await tryGate(`${LONG}-tail`, OUTSIDER);
    chk("N6 게이트: 64자 초과 이름 + 비대상 → 404", g2.threw && g2.status === 404, JSON.stringify(g2));
    const g3 = await tryGate(SECRET.toUpperCase(), INSIDER);
    chk("N6 게이트: 변형 이름 + 대상 → 통과", !g3.threw, JSON.stringify(g3));
    const g4 = await tryGate(SECRET, OUTSIDER);
    chk("N6 게이트: 정확한 이름 + 비대상 → 404(종전 판정)", g4.threw && g4.status === 404, JSON.stringify(g4));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
