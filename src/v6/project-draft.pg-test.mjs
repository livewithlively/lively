// 프로젝트 초안(#4170) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/project-draft.pg-test.mjs
//
// 왜 이 계층인가: 초안에서 **나오는 조건이 UPDATE 의 SET 식**이다 — «제목이나 본문이 실제로 바뀔 때만 draft=false».
//  같은 글을 다시 저장하는 자동저장, 우선순위만 고친 저장, 세션 이름이 자동으로 옮겨 붙는 것(claimProjectName)은
//  초안을 내리면 안 된다. 목 풀로는 그 식을 지워도 초록이라 **저장 뒤 draft 를 SELECT 로 되읽어** 판정한다.
//  백필(schema/project.ts 5i)도 같다: 조건이 SQL 이고, «한 번 올린 프로젝트를 다음 부팅이 되돌리지 않는다» 는
//  NULL 만 따지는 WHERE 에 걸려 있다 — 실제로 init 을 두 번 돌려 본다.
//
//  사양·엣지 표(D1~D12):
//   D1 createProject(draft:true) → true · 생략 → false
//   D2 claimProjectName(session·agent) → 그대로(첫 턴 자동 이름은 정리가 아니다)
//   D3 같은 본문 재저장 · 우선순위만 → 그대로
//   D4 append_description → false
//   D5 description 교체(다른 글) → false
//   D6 가드 저장(description_base)으로 다른 글 → false · 같은 글 → 그대로
//   D7 name 변경 → false · 같은 이름 → 그대로
//   D8 draft:false 명시 → false(본문 그대로) · draft:true → true
//   D9 상태 done → false · in_progress → 그대로
//   D10 초안 아닌(false) 프로젝트는 무엇을 고쳐도 false · NULL(구 행)은 NULL 그대로
//   D11 백필: 표식+꼬리 없음+rule → true · 꼬리 있음/done/human/표식 없음 → false
//   D12 백필 재실행: 한 번 올린(false) 프로젝트는 다시 초안이 되지 않는다
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const ps = await import(`${DIST}/v6/project-store.js`);
const { initV6ProjectCore } = await import(`${DIST}/v6/schema/project.js`);
const { AUTO_CREATED_MARK } = await import(`${DIST}/project/first-prompt-project.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__draft_pg__";
const ctx = { actor: A, source: "web" };
const SHELL = `> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다\n\n## 첫 지시(원문)\n\n인프라 점검하자\n\n${AUTO_CREATED_MARK}`;
const draftOf = async (id) => (await itemsPool.query(`SELECT draft FROM project WHERE id=$1`, [id])).rows[0].draft;
const shell = async (name = "인프라 점검하자") =>
  (await ps.createProject({ name, description: SHELL, dedupe: false, name_source: "rule", draft: true }, ctx)).id;
const cleanup = () => itemsPool.query(`DELETE FROM project WHERE created_by=$1`, [A]);

try {
  await cleanup();

  // ── D1 ──
  {
    const r = await ps.createProject({ name: "초안 D1", description: SHELL, dedupe: false, name_source: "rule", draft: true }, ctx);
    chk("D1 draft:true 로 만들면 초안이다(돌려준 행과 DB 둘 다)", r.draft === true && (await draftOf(r.id)) === true, JSON.stringify({ ret: r.draft }));
    const h = await ps.createProject({ name: "초안 D1b", description: "사람이 만든 것", dedupe: false }, ctx);
    chk("D1b 생략하면 초안이 아니다(false — NULL 이 아니다)", (await draftOf(h.id)) === false, String(await draftOf(h.id)));
  }

  // ── D2 ──
  {
    const id = await shell();
    const r1 = await ps.claimProjectName(id, "인프라 점검", "session", ctx);
    const r2 = await ps.claimProjectName(id, "인프라 점검·개선", "agent", ctx);
    chk("D2 ★세션·에이전트 자동 이름(claimProjectName)은 초안을 내리지 않는다 — 첫 턴에 거의 늘 일어난다",
      r1.applied && r2.applied && (await draftOf(id)) === true, JSON.stringify({ r1: r1.applied, r2: r2.applied, draft: await draftOf(id) }));
  }

  // ── D3 ──
  {
    const id = await shell();
    await ps.updateProject(id, { description: SHELL }, ctx);
    chk("D3 ★같은 본문을 다시 저장(자동저장)해도 초안 그대로", (await draftOf(id)) === true, String(await draftOf(id)));
    await ps.updateProject(id, { priority: "high" }, ctx);
    chk("D3b 본문·제목 말고 다른 칸만 고치면 초안 그대로", (await draftOf(id)) === true, String(await draftOf(id)));
  }

  // ── D4 ──
  {
    const id = await shell();
    const r = await ps.updateProject(id, { append_description: "## 목표\n- 인프라 비용 줄이기" }, ctx);
    chk("D4 본문을 보태면(append) 초안에서 나온다", r.draft === false && (await draftOf(id)) === false, JSON.stringify({ ret: r.draft }));
  }

  // ── D5 ──
  {
    const id = await shell();
    await ps.updateProject(id, { description: "정리한 본문" }, ctx);
    chk("D5 본문을 다른 글로 바꾸면 초안에서 나온다", (await draftOf(id)) === false, String(await draftOf(id)));
  }

  // ── D6 ──
  {
    const id = await shell();
    await ps.updateProject(id, { description: SHELL, description_base: SHELL }, ctx);
    chk("D6 가드 저장 — 같은 글이면 초안 그대로", (await draftOf(id)) === true, String(await draftOf(id)));
    await ps.updateProject(id, { description: SHELL + "\n\n사람이 보탠 줄", description_base: SHELL }, ctx);
    chk("D6b 가드 저장 — 다른 글이면 초안에서 나온다", (await draftOf(id)) === false, String(await draftOf(id)));
  }

  // ── D7 ──
  {
    const id = await shell("같은 이름");
    await ps.updateProject(id, { name: "같은 이름" }, ctx);
    chk("D7 같은 이름으로 저장하면 초안 그대로", (await draftOf(id)) === true, String(await draftOf(id)));
    await ps.updateProject(id, { name: "인프라 비용 줄이기" }, ctx);
    chk("D7b 이름을 직접 고치면 초안에서 나온다", (await draftOf(id)) === false, String(await draftOf(id)));
  }

  // ── D8 ──
  {
    const id = await shell();
    const before = (await itemsPool.query(`SELECT description FROM project WHERE id=$1`, [id])).rows[0].description;
    await ps.updateProject(id, { draft: false }, ctx);
    const after = (await itemsPool.query(`SELECT description FROM project WHERE id=$1`, [id])).rows[0].description;
    chk("D8 «목록에 올리기»(draft:false) — 본문은 그대로 두고 초안에서 나온다", (await draftOf(id)) === false && before === after, JSON.stringify({ draft: await draftOf(id) }));
    await ps.updateProject(id, { draft: true }, ctx);
    chk("D8b draft:true 면 다시 초안", (await draftOf(id)) === true, String(await draftOf(id)));
  }

  // ── D9 ──
  {
    const id = await shell();
    await ps.updateProjectStatus(id, "in_progress", ctx);
    chk("D9 진행 중으로 바꾸는 것만으로는 초안 그대로", (await draftOf(id)) === true, String(await draftOf(id)));
    await ps.updateProjectStatus(id, "done", ctx);
    chk("D9b 완료하면 초안에서 나온다", (await draftOf(id)) === false, String(await draftOf(id)));
    await ps.updateProjectStatus(id, "active", ctx);
    chk("D9c 완료를 되돌려도 다시 초안이 되지 않는다", (await draftOf(id)) === false, String(await draftOf(id)));
  }

  // ── D10 ──
  {
    const h = await ps.createProject({ name: "초안 D10", description: "사람 글", dedupe: false }, ctx);
    await ps.updateProject(h.id, { append_description: "더" }, ctx);
    chk("D10 초안 아닌 프로젝트는 고쳐도 false", (await draftOf(h.id)) === false, String(await draftOf(h.id)));
    const legacy = (await itemsPool.query(
      `INSERT INTO project(level, name, status, created_by, description) VALUES('project','초안 D10b','active',$1,'구 행') RETURNING id`, [A])).rows[0].id;
    await ps.updateProject(legacy, { description: "구 행 고침" }, ctx);
    chk("D10b 아직 안 따져 본 구 행(NULL)은 고쳐도 NULL 그대로 — 백필의 몫을 뺏지 않는다", (await draftOf(legacy)) === null, String(await draftOf(legacy)));
  }

  // ── D11·D12 백필 ──
  {
    const ins = async (name, description, status = "active", nameSource = "rule") => (await itemsPool.query(
      `INSERT INTO project(level, name, status, created_by, description, name_source) VALUES('project',$1,$2,$3,$4,$5) RETURNING id`,
      [name, status, A, description, nameSource])).rows[0].id;
    const bare = await ins("백필 껍데기", SHELL + "\n\n  \n");
    const session = await ins("백필 세션이름", SHELL, "active", "session");
    const tailed = await ins("백필 꼬리", SHELL + "\n\n## 진행 기록\n- 했다");
    const done = await ins("백필 완료", SHELL, "done");
    const human = await ins("백필 사람이름", SHELL, "active", "human");
    const plain = await ins("백필 표식없음", "그냥 본문", "active", "human");
    await initV6ProjectCore(itemsPool);
    const d = async (id) => draftOf(id);
    chk("D11 표식 + 표식 뒤 빈칸뿐 + 기계 이름 → 초안", (await d(bare)) === true, String(await d(bare)));
    chk("D11b 세션 이름이 옮겨 붙었어도(session) 본문이 그대로면 초안", (await d(session)) === true, String(await d(session)));
    chk("D11c 표식 뒤에 글을 보탰으면 초안 아님", (await d(tailed)) === false, String(await d(tailed)));
    chk("D11d 완료된 것은 초안 아님", (await d(done)) === false, String(await d(done)));
    chk("D11e 사람이 이름을 고친 것(human)은 초안 아님", (await d(human)) === false, String(await d(human)));
    chk("D11f 표식이 없으면 초안 아님", (await d(plain)) === false, String(await d(plain)));
    await ps.updateProject(bare, { draft: false }, ctx);
    await initV6ProjectCore(itemsPool);
    chk("D12 ★한 번 올린 프로젝트는 다음 부팅(init 재실행)이 다시 초안으로 되돌리지 않는다", (await d(bare)) === false, String(await d(bare)));
    chk("D12b 재실행이 다른 판정도 흔들지 않는다(멱등)", (await d(session)) === true && (await d(tailed)) === false, JSON.stringify({ s: await d(session), t: await d(tailed) }));
  }
} catch (e) {
  bad("예외", e && e.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
