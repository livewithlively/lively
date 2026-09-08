// 분류축이 프로젝트·자료까지 닿는지, 잘못된 자리를 막는지 — 실 PG 통합검증(#1631).
//  ⚠ 수동 실행(docker). 실행:  node scripts/category-reach.itest.mjs
//
//  왜 실 DB 인가: 여기 있는 판정이 전부 SQL 이다(리스트 찾기·파생 카테고리 조인·지식 잔량 검사).
//   단위테스트로는 «쿼리를 그대로 다시 쓴 것» 밖에 못 돼서, 조인이 틀려도 초록불이 된다.
//
//  사양·엣지 표: scratchpad/spec-cat4.md — 이 파일의 시나리오가 그 표의 ①~⑦·⑨⑩ 과 1:1 이다.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59481, CNAME = "co-catreach-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
//  ⚠ 첫 실패에서 멈추면 red 증명이 «맨 앞 한 행» 만 보여 준다 — 나머지 행이 정말 그 변경을 지키는지
//   알 수 없다. 그래서 행마다 잡아 두고 끝에 한꺼번에 판정한다(초록 판정은 그대로 «실패 0»).
const fails = [];
const step = async (label, fn) => {
  try { await fn(); ok(label); }
  catch (e) { fails.push(label); console.log(`FAIL ${label}\n     ${(e && e.message) || e}`); }
};
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
//  pgvector 이미지여야 한다 — category.embedding_vector 를 listCategories 가 읽는다.
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "pgvector/pgvector:pg17"], { stdio: "ignore" });

try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initAllSchemas } = await import("../dist/boot/schemas.js");
  await initAllSchemas();

  const { createCategory, updateCategory, listCategories } = await import("../dist/v6/category-store.js");

  //  ★ 거절은 **상태코드까지** 본다. 평범한 Error 로 던지면 rest-util 이 500 «internal_error» 로 뭉개
  //   «무엇을 넣어야/옮겨야 하나» 안내가 통째로 사라진다 — dev 실측(2026-09-03·04)에서 두 번 그랬다.
  //   «막혔다» 만 보는 단언은 그 회귀를 못 잡는다(스토어에선 어느 쪽이든 똑같이 throw 하므로 초록이다).
  const rejects400 = async (fn, re, label) => {
    try { await fn(); assert.fail(`${label} — 거절돼야 하는데 통과했다`); }
    catch (e) {
      if (e?.code === "ERR_ASSERTION") throw e;
      assert.equal(e?.status, 400, `${label} — 400 이어야 한다(지금 ${e?.status ?? "상태 없음"} → 500 으로 뭉개진다)`);
      assert.match(String(e?.message ?? ""), re, `${label} — 무엇을 해야 하는지가 문구에 있어야 한다`);
    }
  };
  const { createProject, setProjectCategories } = await import("../dist/v6/project-store.js");
  const { listSources, getSource } = await import("../dist/v6/source-store.js");

  const SHOULD = "이 축이 무엇을 담고 무엇을 담지 않는지를 적는 자리입니다. 시험용이라 경계는 느슨합니다.";
  const ctx = { actor: "itest", source: "web" };
  const nLists = async () => (await itemsPool.query(`SELECT count(*)::int n FROM project_list`)).rows[0].n;

  const brewing = await createCategory({ key: "brewing", name: "양조·생산", should: SHOULD }, ctx);
  const partners = await createCategory({ key: "partners", name: "거래처", should: SHOULD }, ctx);
  //  ⑤ 경계 — 이름이 비어 있는 축(리스트 이름을 key 로 지어야 한다).
  const noName = await createCategory({ key: "no-name-axis", should: SHOULD }, ctx);

  // ── A. 프로젝트 — 카테고리를 정하면 자리가 만들어진다 ──
  await step("①② 카테고리를 정하면 자리가 만들어지고, 형제는 그 자리를 공유한다", async () => {
    //  ② 리스트도, 그 축을 소유한 리스트도 없다 → 축 이름으로 리스트가 생긴다.
    const p1 = await createProject({ name: "양조 기록 정리", dedupe: false }, ctx);
    assert.equal((await itemsPool.query(`SELECT list_id FROM project WHERE id=$1`, [p1.id])).rows[0].list_id, null,
      "배선 확인 — 자동 생성 프로젝트는 리스트 없이 태어난다(그게 이 시험의 전제다)");
    const before = await nLists();
    const r1 = await setProjectCategories(p1.id, [brewing.id], ctx);
    assert.equal(r1.applied, true, "② 리스트가 없어도 반영돼야 한다(종전엔 no-op 이었다)");
    assert.deepEqual(r1.categoryIds, [brewing.id]);
    assert.equal(await nLists(), before + 1, "② 리스트가 하나 생겨야 한다");
    const l1 = (await itemsPool.query(`SELECT pl.name, pl.category_id FROM project p JOIN project_list pl ON pl.id=p.list_id WHERE p.id=$1`, [p1.id])).rows[0];
    assert.equal(l1.name, "양조·생산", "② 리스트 이름은 축 이름");
    assert.equal(Number(l1.category_id), brewing.id);

    //  ① 형제가 같은 축을 고르면 **같은 리스트를 공유**한다(새로 만들지 않는다) — #541 의 의도.
    const p2 = await createProject({ name: "발효실 온도", dedupe: false }, ctx);
    const n2 = await nLists();
    await setProjectCategories(p2.id, [brewing.id], ctx);
    assert.equal(await nLists(), n2, "① 리스트를 새로 만들면 안 된다 — 이미 그 축을 소유한 리스트가 있다");
    const l2 = (await itemsPool.query(`SELECT list_id FROM project WHERE id=$1`, [p2.id])).rows[0].list_id;
    const l1id = (await itemsPool.query(`SELECT list_id FROM project WHERE id=$1`, [p1.id])).rows[0].list_id;
    assert.equal(Number(l2), Number(l1id), "① 형제는 같은 리스트를 공유한다");
  });

  await step("③ 해제는 자리를 만들지 않는다", async () => {
    //  ③ ★ 이번에 도입한 것의 **부재** 케이스 — 해제(빈 배열)는 리스트를 만들지 않는다.
    const p3 = await createProject({ name: "아직 주제 없음", dedupe: false }, ctx);
    const before = await nLists();
    const r = await setProjectCategories(p3.id, [], ctx);
    assert.equal(await nLists(), before, "③ 해제가 리스트를 만들면 안 된다 — 없는 것을 지우려고 자리를 만들 이유가 없다");
    assert.equal((await itemsPool.query(`SELECT list_id FROM project WHERE id=$1`, [p3.id])).rows[0].list_id, null,
      "③ 해제 뒤에도 리스트 없이 남는다");
    assert.equal(r.applied, false, "③ 반영 못 했음을 정직하게 답한다");
  });

  await step("④ 리스트가 있으면 그 리스트의 축만 바뀐다", async () => {
    //  ④ 리스트가 이미 있으면 그 리스트의 카테고리만 바뀐다(리스트를 새로 만들지 않는다).
    const p4 = await createProject({ name: "거래처 정리", dedupe: false }, ctx);
    await setProjectCategories(p4.id, [brewing.id], ctx);
    const listId = (await itemsPool.query(`SELECT list_id FROM project WHERE id=$1`, [p4.id])).rows[0].list_id;
    const before = await nLists();
    await setProjectCategories(p4.id, [partners.id], ctx);
    assert.equal(await nLists(), before, "④ 리스트가 있으면 새로 만들지 않는다");
    const after = (await itemsPool.query(`SELECT list_id, (SELECT category_id FROM project_list WHERE id=p.list_id) cat FROM project p WHERE p.id=$1`, [p4.id])).rows[0];
    assert.equal(Number(after.list_id), Number(listId), "④ 같은 리스트에 머문다");
    assert.equal(Number(after.cat), partners.id, "④ 그 리스트의 카테고리가 바뀐다");
  });

  await step("⑤ 이름 없는 축도 리스트 이름을 갖는다", async () => {
    //  ⑤ 경계 — 이름 없는 축이면 리스트 이름은 key.
    const p5 = await createProject({ name: "이름 없는 축", dedupe: false }, ctx);
    await setProjectCategories(p5.id, [noName.id], ctx);
    const nm = (await itemsPool.query(`SELECT pl.name FROM project p JOIN project_list pl ON pl.id=p.list_id WHERE p.id=$1`, [p5.id])).rows[0].name;
    assert.equal(nm, "no-name-axis", "⑤ 이름이 비면 key 로 짓는다 — 빈 이름은 사이드바에서 빈 줄이 된다");
  });

  // ── B. 자료의 분류 = 그 자료로 만든 지식의 분류 ──
  await step("⑥⑦ 자료의 분류는 그 자료로 만든 지식의 분류다 — 증류 전이면 빈 배열", async () => {
    const mkSource = async (name, title) => Number((await itemsPool.query(
      `INSERT INTO source(name, kind, title, body_md, provenance, lifecycle)
       VALUES($1,'other',$2,'본문','authored','active') RETURNING id`, [name, title])).rows[0].id);
    const mkKnowledge = async (name, catId) => {
      await itemsPool.query(
        `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle)
         VALUES($1,$1,'본문','recalled','authored','active')`, [name]);
      await itemsPool.query(
        `INSERT INTO knowledge_category(name, category_id, state) VALUES($1,$2,'confirmed')`, [name, catId]);
    };
    const distilled = await mkSource("src-distilled", "증류된 자료");
    const raw = await mkSource("src-raw", "증류 안 된 자료");
    await mkKnowledge("kn-a", brewing.id);
    await itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES('kn-a',$1,'derived_from')`, [distilled]);

    const byId = Object.fromEntries((await listSources({ limit: 100 }, null)).map((r) => [Number(r.id), r]));
    assert.deepEqual(byId[distilled].categories, [{ key: "brewing", name: "양조·생산" }],
      "⑥ 지식이 된 자료엔 그 지식의 분류가 실린다");
    assert.deepEqual(byId[raw].categories, [],
      "⑥ 증류 안 된 자료는 빈 배열 — 자료 자신은 분류를 갖지 않는다");

    //  ⑦ 한 자료가 지식 2건이 되고 축이 갈리면 둘 다, 중복 없이.
    await mkKnowledge("kn-b", partners.id);
    await mkKnowledge("kn-c", partners.id);   // 같은 축 — 중복이 나오면 안 된다
    for (const n of ["kn-b", "kn-c"]) {
      await itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES($1,$2,'derived_from')`, [n, distilled]);
    }
    const detail = await getSource(distilled, null);
    const keys = (detail.categories ?? []).map((c) => c.key).sort();
    assert.deepEqual(keys, ["brewing", "partners"], "⑦ 축이 갈리면 여럿, 같은 축이 겹치면 하나로");

    //  B4 — 카테고리로 자료를 좁힌다. 증류 안 된 자료는 어떤 값으로도 안 잡힌다.
    const only = await listSources({ categoryId: partners.id, limit: 100 }, null);
    assert.deepEqual(only.map((r) => Number(r.id)), [distilled], "카테고리 필터는 그 축의 지식이 나온 자료만");
    const none = await listSources({ categoryId: noName.id, limit: 100 }, null);
    assert.deepEqual(none, [], "지식이 없는 축으로 좁히면 0건");
  });

  // ── D. 축 치우기 ──
  await step("⑨ 비활성은 «비어 있을 때만» — 지식이 남으면 거절, merged 는 못 만든다", async () => {
    //  ⑨ 지식이 남아 있으면 비활성으로 못 만든다.
    await rejects400(() => updateCategory(brewing.id, { state: "deprecated" }, ctx),
      /지식 1건이 남아 있어.*먼저 다른 축으로 옮기세요/s, "⑨ 지식이 남아 있으면 거절 — 몇 건인지·무엇을 해야 하는지까지");

    //  ⑨ 비어 있으면 통과.
    const after = await updateCategory(noName.id, { state: "deprecated" }, ctx);
    assert.equal(after.state, "deprecated", "⑨ 비어 있는 축은 치울 수 있다");

    //  ⑨ 되살리기.
    assert.equal((await updateCategory(noName.id, { state: "active" }, ctx)).state, "active", "⑨ 되살릴 수 있다");
    await updateCategory(noName.id, { state: "deprecated" }, ctx);

    //  ⑨ merged 는 병합 경로가 소유한다.
    await rejects400(() => updateCategory(noName.id, { state: "merged" }, ctx),
      /active\|deprecated/, "⑨ merged 는 여기서 못 만든다");
  });

  await step("⑩ 비활성은 분류 후보에서만 빠지고 목록엔 남는다", async () => {
    //  ⑩ 비활성 축은 **분류 후보**(AI 카테고리 지도)에서 빠진다. 목록에는 남는다.
    const { categoryMapForIndex } = await import("../dist/org/delivery/knowledge-index.js");
    //  배선 단언 — 먼저 «활성일 때는 지도에 나온다» 를 확인하고 시작한다(원래 안 나오는 걸 확인하면 아무것도 안 본다).
    await updateCategory(noName.id, { state: "active" }, ctx);
    assert.ok((await categoryMapForIndex(null)).some((x) => x.key === "no-name-axis"),
      "배선 확인 — 활성 축은 지도에 나와야 한다");

    await updateCategory(noName.id, { state: "deprecated" }, ctx);
    assert.ok(!(await categoryMapForIndex(null)).some((x) => x.key === "no-name-axis"),
      "⑩ 비활성 축은 분류 후보에서 빠진다");
    assert.ok((await listCategories(null)).some((x) => x.key === "no-name-axis"),
      "⑩ 그래도 목록에는 남는다 — 되살릴 수 있어야 한다");
  });

  // ── C. 레인 목적지 — 저장 경로에서 실제로 막히나(순수 판정은 단위테스트가 본다) ──
  await step("⑧ 레인 목적지 — 없는 축·비활성 축은 저장 거절, 미지정은 검사 안 함", async () => {
    const { upsertDistiller } = await import("../dist/org/store/ingest.js");
    await upsertDistiller({ key: "lane-ok", target_category: "partners" }, "itest", "web");
    await upsertDistiller({ key: "lane-catchall", target_category: null }, "itest", "web");
    //  ★ 상태코드까지 본다. 평범한 Error 로 던지면 rest-util 이 500 «internal_error» 로 뭉개서
    //   «있는 축은 이것들이다» 안내가 통째로 사라진다 — dev 실측(2026-09-03)에서 실제로 그렇게 나갔다.
    //   «막혔다» 만 보는 단언은 그 회귀를 못 잡는다(스토어에선 똑같이 throw 하므로 초록이다).
    await rejects400(() => upsertDistiller({ key: "lane-bad", target_category: "comms" }, "itest", "web"),
      /'comms' 이\(가\) 없습니다.*있는 축:/s, "⑧ 없는 축(실측에서 실제로 저장돼 있던 값)");
    await rejects400(() => upsertDistiller({ key: "lane-dep", target_category: "no-name-axis" }, "itest", "web"),
      /비활성입니다/, "⑧ 비활성 축");
    //  부분 갱신에서 target_category 를 안 주면 검사하지 않는다(«안 건드림» 이라 기존 값을 지킨다).
    await upsertDistiller({ key: "lane-ok", batch_size: 5 }, "itest", "web");
  });

  await itemsPool.end();
  if (fails.length) { console.log(`\n${pass} passed · ${fails.length} FAILED — ${fails.join(" / ")}`); process.exitCode = 1; }
  else console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
