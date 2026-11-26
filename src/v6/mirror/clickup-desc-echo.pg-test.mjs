// ClickUp 본문 왕복 보존 PG 통합 테스트 — 실제 Postgres 필요(기본 유닛 체인 밖).
//    npm run build && ITEMS_DATABASE_URL=… node src/v6/mirror/clickup-desc-echo.pg-test.mjs
//
//  ClickUp 은 푸시받은 markdown_description 을 자기 방언으로 다시 써서 돌려준다(`<!--` → `\<!--` 등). 푸시가 그 값을
//   external_base.description_echo 로 남기면, 인바운드 미러는 같은 값을 외부 편집으로 받지 않아야 한다.
//   판정 자체(unechoDescription)는 유닛이 보고, 여기서는 행에 남는 본문·base·아웃박스를 본다.
//  모든 행은 이 시험만의 external_system(`__echo_pg__`)에 둔다.
//
//  사양 엣지 표(행마다 단언):
//   E1 푸시 뒤 메아리(방언)가 들어온다 → 본문은 우리 값 · 아웃박스 안 쌓임 · base 에 메아리 유지
//   E2 같은 메아리가 다시 들어온다(다음 싱크) → 그대로(진동 없음)
//   E3 우리가 본문을 고쳤고 저쪽은 아직 메아리 → 우리 값 유지 · 아웃박스 쌓임 · base 에서 메아리 빠짐
//      (메아리는 옛 본문의 것이라 새 base 와 짝이 안 맞는다 — 남기면 푸시가 유실됐을 때 재적재가 멈춘다)
//   E4 저쪽 사람이 본문을 고쳤다(메아리와 다름) → 저쪽 값 채택 · base 에서 메아리 빠짐
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { initAllSchemas } = await import(`${DIST}/boot/schemas.js`);
const mp = await import(`${DIST}/v6/mirror/mirror-project.js`);

delete process.env.ANTHROPIC_API_KEY;

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const SYS = "__echo_pg__";
const INST = "__echo_pg_inst__";
const OURS = "## 첫 지시(원문)\n\n- 영업일 테이블 있어?\n<!-- lively:auto-created-from-first-prompt -->";
const ECHO = "## 첫 지시(원문)\n\n*  영업일 테이블 있어?\n\\<!-- lively:auto-created-from-first-prompt -->";

const inbound = async (ext, body) => {
  const client = await itemsPool.connect();
  try {
    await mp.mirrorProjectV6(client, {
      type: "task", level: "project", title: `왕복 ${ext}`, body,
      provenance: { category: "pm_tool", system: SYS, instance: INST, external_id: ext },
      fields: { status_category: "unstarted" },
    }, SYS, ext);
  } finally { client.release(); }
};
const row = async (ext) => (await itemsPool.query(
  `SELECT id, description, external_base FROM project WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
  [SYS, INST, ext])).rows[0];
const pendingOutbox = async (id) => Number((await itemsPool.query(
  `SELECT count(*) AS n FROM external_outbox WHERE entity_id=$1 AND done_at IS NULL`, [id])).rows[0].n);
// 푸시가 끝난 상태 — clickup-push 가 남기는 base(우리 값 + 메아리)와 드레인된 아웃박스.
const pushed = async (ext, description, echo) => {
  const r = await row(ext);
  const base = { ...(r.external_base ?? {}), description, description_echo: echo };
  await itemsPool.query(`UPDATE project SET description=$2, external_base=$3::jsonb WHERE id=$1`, [r.id, description, JSON.stringify(base)]);
  await itemsPool.query(`UPDATE external_outbox SET done_at=now() WHERE entity_id=$1 AND done_at IS NULL`, [r.id]);
  return r.id;
};

try {
  await initAllSchemas({ quiet: true });
  await itemsPool.query(`DELETE FROM project WHERE external_system=$1`, [SYS]);
  await itemsPool.query(`DELETE FROM external_outbox WHERE system=$1`, [SYS]);

  {
    const ext = "e1";
    await inbound(ext, OURS);                   // 최초 수입
    const id = await pushed(ext, OURS, ECHO);
    await inbound(ext, ECHO);
    const r = await row(ext);
    chk("E1 메아리는 외부 편집이 아니다 — 본문 우리 값 · 아웃박스 0 · base 에 메아리 유지",
      r.description === OURS && (await pendingOutbox(id)) === 0 && r.external_base?.description_echo === ECHO
        && r.external_base?.description === OURS,
      JSON.stringify({ d: r.description, base: r.external_base, ob: await pendingOutbox(id) }));

    await inbound(ext, ECHO);
    const r2 = await row(ext);
    chk("E2 같은 메아리의 다음 싱크 — 그대로(진동 없음)",
      r2.description === OURS && (await pendingOutbox(id)) === 0 && r2.external_base?.description_echo === ECHO,
      JSON.stringify({ d: r2.description, base: r2.external_base }));
  }

  {
    const ext = "e3";
    await inbound(ext, OURS);
    const id = await pushed(ext, OURS, ECHO);
    const EDITED = `${OURS}\n\n추가한 줄`;
    await itemsPool.query(`UPDATE project SET description=$2 WHERE id=$1`, [id, EDITED]);
    await inbound(ext, ECHO);
    const r = await row(ext);
    chk("E3 로컬 편집 + 저쪽 메아리 → 우리 값 유지 · 아웃박스 쌓임 · 메아리 빠짐",
      r.description === EDITED && (await pendingOutbox(id)) === 1 && r.external_base?.description_echo === undefined,
      JSON.stringify({ d: r.description, base: r.external_base, ob: await pendingOutbox(id) }));
  }

  {
    const ext = "e4";
    await inbound(ext, OURS);
    const id = await pushed(ext, OURS, ECHO);
    const THEIRS = "ClickUp 에서 사람이 고친 본문";
    await inbound(ext, THEIRS);
    const r = await row(ext);
    chk("E4 저쪽 사람 편집 → 채택 · 메아리 빠짐 · 아웃박스 0",
      r.description === THEIRS && r.external_base?.description_echo === undefined && (await pendingOutbox(id)) === 0,
      JSON.stringify({ d: r.description, base: r.external_base, ob: await pendingOutbox(id) }));
  }

} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  await itemsPool.query(`DELETE FROM project WHERE external_system=$1`, [SYS]).catch(() => {});
  await itemsPool.query(`DELETE FROM external_outbox WHERE system=$1`, [SYS]).catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
