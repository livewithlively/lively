// 사람에게 묻지 않는 형식 정리의 저장 경로 — 기준 날짜(감사 기록)·홈 경로 정리를 실제 Postgres 로 본다.
//  CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    node --max-old-space-size=1600 node_modules/typescript/bin/tsc -p tsconfig.json && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/style-resolve.pg-test.mjs
//
//  사양 엣지 표(행마다 단언):
//   S1 에이전트 저장의 개인 홈 경로(/Users/<계정>/)는 $HOME 으로 저장되고 ~/ 는 그대로다 · 사람의 웹 저장은 쓴 그대로
//   S6 읽기: 이미 있던 상태 서술 줄의 기준 날짜는 그 줄이 처음 저장된 판의 날이다
//   S7 그 기준 날짜를 적는 style_fix 저장은 통과하고, 다른 날짜를 적으면 422
//   S7b 굵게만 벗긴 style_fix 뒤에도 그 줄의 기준 날짜는 처음 판의 날이고, 형식 정리한 날을 적으면 422
//   S8 저장 응답의 시점 위반에 기준 날짜(anchors)와 고치는 법(fix)이 실리고 ask_human 은 없다(기준 날짜를 찾았으므로)
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSave } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
const { knowledgeGet } = await import(`${DIST}/capabilities/knowledge/read.js`);
//  형식 조회는 워크스페이스별로 캐시된다(runtime-config getWritingFormat) — DB 를 직접 고친 뒤엔 비워야 새 형식이 보인다.
const { invalidateWritingFormatCache } = await import(`${DIST}/org/store/runtime-config.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "srpg-";
const AGENT = "__srpg__agent";
const CAT = "srpg-cat";
const LIMIT = 8000;

const mcp = { actor: AGENT, source: "mcp", viewer: AGENT };
const save = (input) => knowledgeSave.handler(input, { userId: AGENT }, mcp);
const saveHuman = (input) => knowledgeSave.handler(input, { userId: AGENT, tokenSource: "session" }, { actor: AGENT, source: "web", viewer: AGENT });
const attempt = async (fn) => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, status: e?.status, msg: String(e?.message ?? e) }; }
};
const rowOf = async (name) => (await itemsPool.query(
  `SELECT name, title, body_md, version, visibility, lifecycle, parent_name FROM knowledge WHERE name=$1`, [name])).rows[0];
async function cleanup() {
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND left(entity_key, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM knowledge_category WHERE left(name, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM knowledge WHERE left(name, $2) = $1`, [P, P.length]);
}

let prevFormat = null;
try {
  await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas();
  await cleanup();
  await itemsPool.query(`INSERT INTO category(key, name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [CAT]);
  // 조직 형식 — 서술 형식을 켜고 본문 길이를 거부 규칙으로 둔다. 끝나면 되돌린다.
  if (!(await itemsPool.query(`SELECT 1 FROM org_runtime_config WHERE id=1`)).rowCount) await itemsPool.query(`INSERT INTO org_runtime_config(id) VALUES(1)`);
  prevFormat = (await itemsPool.query(`SELECT writing_format FROM org_runtime_config WHERE id=1`)).rows[0]?.writing_format ?? null;
  await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1 WHERE id=1`,
    [JSON.stringify({ enabled: true, rules: { body_length: "reject" }, limits: { body_max_chars: LIMIT } })]); invalidateWritingFormatCache();

  // ── S1 홈 경로 ──
  {
    const body = "로컬 스크립트 위치를 적는다.\n\n`/Users/someone/work/run.sh` 와 ~/work/notes 를 쓴다.";
    await save({ name: `${P}paths`, title: "로컬 스크립트 위치", body_md: body, category: CAT, type: "reference" });
    const r = await rowOf(`${P}paths`);
    //  ~/ 는 바꾸지 않는다 — 탐지가 위반으로 보지 않는 관례 표기다(writing-resolve 홈 경로 머리말).
    chk("S1 에이전트 저장의 홈 경로는 $HOME 으로 바뀌고 ~/ 는 그대로다", r.body_md.includes("`$HOME/work/run.sh`") && r.body_md.includes("~/work/notes") && !r.body_md.includes("/Users/someone"), r.body_md);
    await saveHuman({ name: `${P}paths-human`, title: "로컬 스크립트 위치", body_md: body, category: CAT, type: "reference" });
    chk("S1 사람의 웹 저장은 쓴 그대로다", (await rowOf(`${P}paths-human`)).body_md === body);
    const r1 = await save({ name: `${P}paths-2`, title: "로컬 스크립트 위치", body_md: body, category: CAT, type: "reference" });
    chk("S1 응답 home_paths 에 바꾼 건수가 실린다", r1.home_paths?.replaced === 1, JSON.stringify(r1.home_paths));
    await itemsPool.query(`UPDATE knowledge SET body_md = $2 WHERE name=$1`, [`${P}paths-2`, "기존 줄은 /Users/old/keep.sh 다."]);
    await save({ name: `${P}paths-2`, mode: "append", body_md: "새 줄은 /Users/new/add.sh 다." });
    const ap = (await rowOf(`${P}paths-2`)).body_md;
    chk("S1 append 는 보낸 조각만 바꾸고 기존 본문은 그대로 둔다", ap.includes("/Users/old/keep.sh") && ap.includes("$HOME/add.sh"), ap);
    const prev = (await itemsPool.query(`SELECT writing_format FROM org_runtime_config WHERE id=1`)).rows[0].writing_format;
    await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1 WHERE id=1`, [JSON.stringify({ ...prev, rules: { ...(prev.rules ?? {}), local_path: "off" } })]); invalidateWritingFormatCache();
    await save({ name: `${P}paths-off`, title: "로컬 스크립트 위치", body_md: body, category: CAT, type: "reference" });
    await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1 WHERE id=1`, [JSON.stringify(prev)]); invalidateWritingFormatCache();
    chk("S1 조직이 local_path 규칙을 끄면 바꾸지 않는다", (await rowOf(`${P}paths-off`)).body_md === body);
  }

  // ── S6·S7 기준 날짜 ──
  {
    const name = `${P}status`;
    const body = "배포 절차를 정한다.\n\n- 신한 연동은 아직 배포 대기 중이다.\n- 재시도는 3회다.";
    await save({ name, title: "배포 절차", body_md: body, category: CAT, type: "how-to" });
    // 그 판이 2026-09-05(KST)에 저장된 것으로 감사 기록과 행 시각을 옮긴다.
    await itemsPool.query(`UPDATE org_content_audit SET at = '2026-09-05T03:00:00Z' WHERE entity='knowledge' AND entity_key=$1`, [name]);
    await itemsPool.query(`UPDATE knowledge SET updated_at = '2026-09-05T03:00:00Z' WHERE name=$1`, [name]);
    const got = await knowledgeGet.handler({ name }, { userId: AGENT }, mcp);
    const und = got.style?.findings?.find((f) => f.rule === "undated_status");
    chk("S6 읽기: 상태 서술 줄의 기준 날짜는 그 줄이 처음 저장된 판의 날이다",
      und?.anchors?.[0]?.date === "2026-09-05" && und.anchors[0].basis === "first_version" && und.fix && !("ask_human" in und), JSON.stringify(und));
    const v = (await rowOf(name)).version;
    const wrong = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v,
      edits: [{ old: "아직 배포 대기 중이다.", new: "배포 대기 중이다(2026-09-07 기준)." }] }));
    chk("S7 기준 날짜가 아닌 날짜를 적은 style_fix 저장은 422", !wrong.ok && wrong.status === 422, `${wrong.status} ${wrong.msg?.slice(0, 200)}`);
    const right = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v,
      edits: [{ old: "아직 배포 대기 중이다.", new: "배포 대기 중이다(2026-09-05 기준)." }] }));
    chk("S7 기준 날짜를 적은 style_fix 저장은 통과한다", right.ok, right.msg);
  }

  // ── S7b 형식만 고친 style_fix 가 시점 줄의 기준 날짜를 오늘로 바꾸지 않는다 ──
  {
    const name = `${P}status-fmt`;
    const body = "배포 절차를 정한다.\n\n- **결제 연동**은 아직 배포 대기 중이다.\n- 재시도는 3회다.";
    await save({ name, title: "결제 배포 절차", body_md: body, category: CAT, type: "how-to" });
    await itemsPool.query(`UPDATE org_content_audit SET at = '2026-09-05T03:00:00Z' WHERE entity='knowledge' AND entity_key=$1`, [name]);
    await itemsPool.query(`UPDATE knowledge SET updated_at = '2026-09-05T03:00:00Z' WHERE name=$1`, [name]);
    const v1 = (await rowOf(name)).version;
    const r1 = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v1,
      edits: [{ old: "- **결제 연동**은", new: "- 결제 연동은" }] }));
    const und = r1.v?.style?.findings?.find((f) => f.rule === "undated_status");
    chk("S7b 굵게만 벗긴 줄의 기준 날짜는 이번 저장일이 아니라 처음 판의 날이다",
      r1.ok && und?.anchors?.[0]?.date === "2026-09-05" && und.anchors[0].basis === "first_version", `${r1.msg ?? ""} ${JSON.stringify(und)}`);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const v2 = (await rowOf(name)).version;
    const wrong = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v2,
      edits: [{ old: "아직 배포 대기 중이다.", new: `배포 대기 중이다(${today} 기준).` }] }));
    chk("S7b 다음 style_fix 가 형식 정리한 날을 기준 날짜로 적으면 422", today === "2026-09-05" || (!wrong.ok && wrong.status === 422), `${wrong.status} ${wrong.msg?.slice(0, 200)}`);
    const right = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v2,
      edits: [{ old: "아직 배포 대기 중이다.", new: "배포 대기 중이다(2026-09-05 기준)." }] }));
    chk("S7b 처음 판의 날을 적은 style_fix 는 통과한다", right.ok, right.msg);
  }

  // ── S8 저장 응답 ──
  {
    const r = await save({ name: `${P}fresh`, title: "새 규칙", body_md: "새 규칙을 정한다.\n\n오늘 정했고 머지 대기 중이다.", category: CAT, type: "decision" });
    const rel = r.style?.findings?.find((f) => f.rule === "relative_time");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    chk("S8 새 줄의 기준 날짜는 오늘이고 고치는 법이 있다", rel?.anchors?.[0]?.basis === "this_save" && rel.fix && !r.style.findings.some((f) => "ask_human" in f), JSON.stringify(r.style?.findings));
    chk("S8 기준 날짜는 조직 시간대의 오늘 또는 UTC 오늘이다", [today, new Date().toISOString().slice(0, 10)].includes(rel?.anchors?.[0]?.date), rel?.anchors?.[0]?.date);
    chk("S8 기준 날짜를 찾은 위반은 안내문이 사람에게 묻게 하지 않는다", !/사람에게 확인/.test(r.style?.note ?? "") && /anchors 의 기준 날짜/.test(r.style?.note ?? ""), r.style?.note);
  }
} catch (e) {
  bad("실행", e?.stack ?? String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1 WHERE id=1`, [prevFormat == null ? null : JSON.stringify(prevFormat)]).catch(() => {}); invalidateWritingFormatCache();
  await itemsPool.end().catch(() => {});
}
console.log(`style-resolve pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
