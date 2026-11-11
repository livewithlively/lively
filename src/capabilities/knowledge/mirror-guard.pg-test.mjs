// 외부 미러 지식의 내용 쓰기 거절이 **핸들러에 실제로 걸려 있는가**(#1669). 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/mirror-guard.pg-test.mjs
//
//  왜 이 계층인가: 판정(mirror-guard.ts)은 순수 함수라 유닛 시험이 있지만, 그 판정이 knowledge_save · knowledge_set_title 의
//   «어떤 쓰기보다 먼저» 에 걸려 있는지는 핸들러를 불러 DB 를 다시 읽어야 보인다. 거절이 빠지면 저장은 성공으로 답하고
//   다음 재싱크에 내용이 조용히 사라진다(종전 동작 — 통째 저장이 provenance 까지 authored 로 뒤집었다).
//
//  사양 엣지 표(행마다 단언):
//   E1 미러(external_system 있음)에 knowledge_save(mode 없음) → 400 · 사유에 원본 주소 · 행 그대로(판 · 제목 · 본문 · provenance)
//   E2 미러에 knowledge_save append → 400 · 행 그대로
//   E3 미러에 knowledge_set_title → 400 · 행 그대로
//   E4 external_system 이 빈 문자열인 행(경계) → knowledge_save · knowledge_set_title 성공
//   E5 좌표 없는 observed 행(에이전트가 직접 쓴 관찰 기록) → knowledge_save · knowledge_set_title 성공
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSave, knowledgeSetTitle } = await import(`${DIST}/capabilities/knowledge/authoring.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "mgpg-";                                   // 이 시험의 지식 이름 접두
const SYS = "__mgpg__sys";                           // 이 시험만 쓰는 external_system
const ACTOR = "__mgpg__actor";
const URL_A = "https://git.example.com/wiki/-/blob/main/a.md";
const MIRROR = `${P}mirror`, EMPTY_SYS = `${P}empty-sys`, OBSERVED = `${P}observed`;

const ctx = { actor: ACTOR, source: "mcp", viewer: ACTOR };
const save = (input) => knowledgeSave.handler(input, { userId: ACTOR }, ctx);
const setTitle = (name, title) => knowledgeSetTitle.handler({ name, title }, { userId: ACTOR }, ctx);
const attempt = async (fn) => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, status: e?.status, msg: String(e?.message ?? e) }; }
};
const rowOf = async (name) => (await itemsPool.query(
  `SELECT title, body_md, version, provenance, confidence, source FROM knowledge WHERE name=$1`, [name])).rows[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND left(entity_key, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM knowledge WHERE left(name, $2) = $1`, [P, P.length]);
}

async function seed() {
  //  미러 행 — 커넥터가 적재한 꼴 그대로(외부 좌표 · observed). 공개(open)라 누구나 쓸 수 있는 문서다 — 막는 것은 오직 이 가드.
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source,
                           external_system, external_instance, external_id, external_url, last_synced_at, visibility)
     VALUES($1, '원본 제목', '원본 본문', 'recalled', 'observed', 'active', 'observed', $2, $2, 'inst', 'a.md', $3, now(), 'open')`,
    [MIRROR, SYS, URL_A]);
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source, external_system, visibility)
     VALUES($1, '빈 좌표', '본문', 'recalled', 'observed', 'active', 'ai', 'authored', '', 'open')`, [EMPTY_SYS]);
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source, visibility)
     VALUES($1, '관찰 메모', '본문', 'recalled', 'observed', 'active', 'ai', 'authored', 'open')`, [OBSERVED]);
}

try {
  await cleanup();
  await seed();
  const before = await rowOf(MIRROR);
  chk("준비 미러 행", before?.version === 1 && before.provenance === "observed", JSON.stringify(before));

  // E1
  const e1 = await attempt(() => save({ name: MIRROR, title: "고친 제목", body_md: "고친 본문" }));
  chk("E1 미러 통째 저장 → 400", !e1.ok && e1.status === 400, JSON.stringify(e1));
  chk("E1 사유에 원본 주소", !e1.ok && e1.msg.includes(URL_A), e1.msg);
  chk("E1 행 그대로", same(await rowOf(MIRROR), before), JSON.stringify(await rowOf(MIRROR)));
  // E2
  const e2 = await attempt(() => save({ name: MIRROR, mode: "append", body_md: "덧붙임" }));
  chk("E2 미러 append → 400", !e2.ok && e2.status === 400, JSON.stringify(e2));
  chk("E2 행 그대로", same(await rowOf(MIRROR), before), JSON.stringify(await rowOf(MIRROR)));
  // E3
  const e3 = await attempt(() => setTitle(MIRROR, "새 제목"));
  chk("E3 미러 제목 갱신 → 400", !e3.ok && e3.status === 400, JSON.stringify(e3));
  chk("E3 사유에 원본 주소", !e3.ok && e3.msg.includes(URL_A), e3.msg);
  chk("E3 행 그대로", same(await rowOf(MIRROR), before), JSON.stringify(await rowOf(MIRROR)));
  // E4
  const e4a = await attempt(() => save({ name: EMPTY_SYS, title: "빈 좌표 2", body_md: "본문 2" }));
  chk("E4 빈 external_system 행 통째 저장 → 성공", e4a.ok, JSON.stringify(e4a).slice(0, 300));
  const e4b = await attempt(() => setTitle(EMPTY_SYS, "빈 좌표 3"));
  chk("E4 빈 external_system 행 제목 갱신 → 성공", e4b.ok && (await rowOf(EMPTY_SYS))?.title === "빈 좌표 3", JSON.stringify(e4b).slice(0, 300));
  // E5
  const e5a = await attempt(() => save({ name: OBSERVED, title: "관찰 메모 2", body_md: "본문 2" }));
  chk("E5 좌표 없는 observed 행 통째 저장 → 성공", e5a.ok && (await rowOf(OBSERVED))?.body_md === "본문 2", JSON.stringify(e5a).slice(0, 300));
  const e5b = await attempt(() => setTitle(OBSERVED, "관찰 메모 3"));
  chk("E5 좌표 없는 observed 행 제목 갱신 → 성공", e5b.ok && (await rowOf(OBSERVED))?.title === "관찰 메모 3", JSON.stringify(e5b).slice(0, 300));
} catch (e) {
  fail++; console.error("FAIL 예외 —", e);
} finally {
  try { await cleanup(); } catch (e) { console.error("정리 실패:", e?.message ?? e); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await itemsPool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
