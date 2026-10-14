// 프로젝트 자료 파일의 색인(#4629 — 앱 화면의 «전체 자료» 목록) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/project-file-index.pg-test.mjs
//
// 왜 이 계층인가: listProjectFileIndex 의 약속은 전부 SQL 조건이다 — «그 확장자만» · «지워진 프로젝트의 파일은 없다» ·
//  «container_ref 가 이상한 줄 하나가 목록 전체를 죽이지 않는다(정수 캐스트 없음)» · «찾는 말은 경로에서만, % · _ 는 글자» ·
//  «그 세션이 만든 것» · «최신순 · limit». 순수 시험(app-project-files.test.ts)은 색인을 통째로 가짜로 세우므로 조건 하나를
//  지워도 초록이다. 실제 행을 넣고 돌려받은 줄로 판정한다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { listProjectFileIndex } = await import(`${DIST}/v6/source-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why === undefined ? "" : JSON.stringify(why)));

const WHO = "__pfi_pg__";
const mkProject = async (name, trashed = false) => (await itemsPool.query(
  `INSERT INTO project(level, name, status, created_by, trashed_at) VALUES('project',$1,'active',$2,$3) RETURNING id`, [name, WHO, trashed ? new Date() : null])).rows[0].id;
let seq = 0;
const mkFile = (ref, path, over = {}) => itemsPool.query(
  `INSERT INTO source(name, kind, title, external_system, external_id, fields, lifecycle, occurred_at)
   VALUES($1,'local_file',$2,'local',$3,$4::jsonb,$5,$6)`,
  [`${WHO}-${++seq}`, path.split("/").pop(), `${WHO}/${seq}`,
    JSON.stringify({ path, root: over.root ?? "project", ext: over.ext ?? path.split(".").pop().toLowerCase(), bytes: over.bytes ?? 1000, container_ref: ref, ...(over.session ? { entry_session: over.session } : {}) }),
    over.lifecycle ?? "active", new Date(Date.parse("2026-10-11T00:00:00Z") - (over.ago ?? seq) * 60000)]);
const cleanup = async () => {
  await itemsPool.query(`DELETE FROM source WHERE name LIKE $1`, [`${WHO}-%`]);
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1`, [WHO]);
};
const mine = (rows, ids) => rows.filter((r) => ids.includes(r.project_id));

try {
  await cleanup();
  const A = await mkProject("덱 프로젝트"), B = await mkProject("보고 프로젝트"), GONE = await mkProject("지운 프로젝트", true);
  const ids = [A, B, GONE];
  await mkFile(`project:${A}`, "덱/out/리뉴얼.html", { ago: 1, bytes: 3862792, session: "box-a" });
  await mkFile(`project:${A}`, "덱/out/옛판.HTM", { ago: 50, ext: "htm" });
  await mkFile(`project:${A}`, "덱/메모.md", { ago: 2 });
  await mkFile(`project:${A}`, "덱/100%_완성.html", { ago: 3 });
  await mkFile(`project:${A}`, "덱/100점_완성.html", { ago: 4 });
  await mkFile(`project:${A}`, "덱/지운것.html", { ago: 5, lifecycle: "superseded" });
  await mkFile(`project:${B}`, "보고/주간.html", { ago: 10, session: "box-b" });
  await mkFile(`project:${GONE}`, "x/유령.html", { ago: 0 });
  await mkFile(`personal:${WHO}`, "내것.html", { ago: 0, root: "personal" });
  //  ★ 이상한 container_ref — 정수 범위를 넘거나 숫자가 아니어도 목록이 죽으면 안 된다
  await mkFile(`project:99999999999999999999`, "넘침.html", { ago: 0 });
  await mkFile(`project:abc`, "글자.html", { ago: 0 });

  // ── I1 그 확장자만 · 지워진 프로젝트 · 개인 폴더 · 내려간 자료는 없다 · 최신순
  {
    const all = await listProjectFileIndex({ exts: ["html", "htm"], limit: 500 });
    const r = mine(all, ids);
    chk("I1 이상한 container_ref 가 있어도 조회가 선다 · 그 줄은 없다", !all.some((x) => /넘침|글자|내것/.test(x.path)), all.map((x) => x.path).filter((p) => /넘침|글자|내것/.test(p)));
    chk("I1 html · htm 만(md 없음) · 내려간 자료 없음 · 지워진 프로젝트 없음", r.map((x) => x.path).join("|") === "덱/out/리뉴얼.html|덱/100%_완성.html|덱/100점_완성.html|보고/주간.html|덱/out/옛판.HTM", r.map((x) => x.path));
    chk("I1 줄마다 프로젝트 id · 이름 · 크기 · 시각 · 만든 세션", r[0].project_id === A && r[0].project_name === "덱 프로젝트" && r[0].size === 3862792 && r[0].mtime === Date.parse("2026-10-11T00:00:00Z") - 60000 && r[0].session === "box-a", r[0]);
    chk("I1 만든 세션이 없는 파일은 빈 글", r[4].session === "", r[4]);
    const onlyHtml = mine(await listProjectFileIndex({ exts: ["html"], limit: 500 }), ids);
    chk("I1 확장자는 대소문자를 가리지 않고 요청한 것만", !onlyHtml.some((x) => /옛판/.test(x.path)) && onlyHtml.length === 4, onlyHtml.map((x) => x.path));
    chk("I1 확장자가 비면 빈 목록(전부가 아니다)", (await listProjectFileIndex({ exts: [], limit: 500 })).length === 0);
  }
  // ── I2 찾는 말 — 경로에서만 · 낱말끼리 AND · % 와 _ 는 글자 · NUL 은 죽이지 않는다
  {
    const f = async (q) => mine(await listProjectFileIndex({ exts: ["html", "htm"], limit: 500, q }), ids).map((x) => x.path);
    chk("I2 낱말 AND(폴더 + 이름)", (await f("out 리뉴얼")).join("|") === "덱/out/리뉴얼.html", await f("out 리뉴얼"));
    chk("I2 대소문자 무시", (await f("htm 옛판")).length === 1);
    chk("I2 ★ % 는 글자다(전부에 맞지 않는다)", (await f("100%")).join("|") === "덱/100%_완성.html", await f("100%"));
    chk("I2 ★ _ 는 글자다(한 글자 아무거나가 아니다)", (await f("%_완")).join("|") === "덱/100%_완성.html", await f("%_완"));
    chk("I2 맞는 것이 없으면 빈 목록", (await f("없는말xyz")).length === 0);
    let threw = null; try { await f("리뉴\0얼"); } catch (e) { threw = e; }
    chk("I2 NUL 이 섞여도 죽지 않는다", threw === null, String(threw));
  }
  // ── I3 프로젝트 · 세션으로 좁히기(그 세션이 만든 것)
  {
    const r = await listProjectFileIndex({ exts: ["html", "htm"], limit: 500, projectId: A, session: "box-a" });
    chk("I3 그 프로젝트에서 그 세션이 만든 파일만", r.map((x) => x.path).join("|") === "덱/out/리뉴얼.html", r.map((x) => x.path));
    chk("I3 다른 프로젝트의 세션은 안 섞인다", (await listProjectFileIndex({ exts: ["html"], limit: 500, projectId: A, session: "box-b" })).length === 0);
    chk("I3 지워진 프로젝트는 지목해도 없다", (await listProjectFileIndex({ exts: ["html"], limit: 500, projectId: GONE })).length === 0);
  }
  // ── I4 limit — 최신 것부터 그만큼
  {
    const r = await listProjectFileIndex({ exts: ["html", "htm"], limit: 2, projectId: A });
    chk("I4 limit 만큼 · 최신순", r.map((x) => x.path).join("|") === "덱/out/리뉴얼.html|덱/100%_완성.html", r.map((x) => x.path));
  }
  // ── I5 보는 사람을 주어도(자료 · 프로젝트 공개범위 술어가 붙는다) 문장이 선다 — 미분류 프로젝트는 전원에게 보인다
  {
    let rows = null, threw = null;
    try { rows = mine(await listProjectFileIndex({ exts: ["html", "htm"], limit: 500 }, WHO), ids); } catch (e) { threw = e; }
    chk("I5 보는 사람을 준 조회가 선다", threw === null, String(threw));
    chk("I5 미분류 프로젝트의 파일은 그 사람에게 보인다", rows && rows.length === 5, rows && rows.map((x) => x.path));
  }
} catch (e) {
  bad("예외", e instanceof Error ? e.stack : String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
