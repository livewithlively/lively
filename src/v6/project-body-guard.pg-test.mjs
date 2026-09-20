// 프로젝트 본문 가드 저장(#4084) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/project-body-guard.pg-test.mjs
//
// 왜 이 계층인가: 약속이 **SQL 한 문장**이다 — «고치기 시작한 글 뒤에 꼬리만 붙었으면 그 꼬리를 살려 합치고, 다른 데가
//  바뀌었으면 아무것도 쓰지 않는다». 판정(left = base)과 합치기(new || substr)가 UPDATE 의 SET·WHERE 에 들어 있어
//  목 풀로는 조건을 지워도 초록이다. 그래서 **저장 뒤 본문을 SELECT 로 되읽어** 판정한다.
//  배경: 곁칸 «태스크» 부품의 [본문] 접이는 일하는 세션 바로 옆에 떠 있다. 세션은 append_description 으로 본문 끝에
//  기록을 붙이는데 사람의 자동저장은 통째 교체라, 가드가 없으면 그 사이에 붙은 기록이 조용히 사라진다.
//
//  사양·엣지 표: 스크래치패드 spec.md B1~B10 + B4c·B4d(빈 기준 — 격리 리뷰가 잡은 구멍) (B11·B12 의 REST 매핑은 scripts/task-pane.test.mjs 의 배선 단언).
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const ps = await import(`${DIST}/v6/project-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const A = "__bodyguard_pg__";
const mk = async (name, description) => (await itemsPool.query(
  `INSERT INTO project(level, name, status, created_by, description) VALUES('project',$1,'active',$2,$3) RETURNING id`, [name, A, description])).rows[0].id;
const rowOf = async (id) => (await itemsPool.query(`SELECT name, description FROM project WHERE id=$1`, [id])).rows[0];
const cleanup = () => itemsPool.query(`DELETE FROM project WHERE created_by=$1`, [A]);
/** 던진 오류를 값으로 받는다 — 안 던졌으면 null. */
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

try {
  await cleanup();

  // ── B1 base == DB → 새 글 ──
  {
    const id = await mk("가드 B1", "원문");
    const r = await ps.updateProject(id, { description: "고친 글", description_base: "원문" });
    const row = await rowOf(id);
    chk("B1 고치기 시작한 글과 DB 가 같으면 새 글로 바뀐다", row.description === "고친 글" && r.description === "고친 글", JSON.stringify({ row, ret: r.description }));
  }

  // ── B2 세션이 그 사이 덧붙였다 → 새 글 + 꼬리 ──
  {
    const id = await mk("가드 B2", "원문");
    await ps.updateProject(id, { append_description: "## 세션이 남긴 기록" });   // 실제 append 경로 그대로
    const r = await ps.updateProject(id, { description: "사람이 고친 글", description_base: "원문" });
    const row = await rowOf(id);
    chk("B2 ★그 사이 세션이 덧붙인 꼬리를 살려 합친다(통째 교체로 지우지 않는다)",
      row.description === "사람이 고친 글\n\n## 세션이 남긴 기록" && r.description === row.description, JSON.stringify(row));
  }

  // ── B3 꼬리가 아닌 곳이 바뀌었다 → 저장 안 함, 다른 키도 안 바뀜 ──
  {
    const id = await mk("가드 B3", "남이 앞을 고친 원문");
    const e = await caught(() => ps.updateProject(id, { name: "바뀌면 안 되는 이름", description: "내 글", description_base: "원문" }));
    const row = await rowOf(id);
    chk("B3 앞·중간이 다르면 ProjectBodyConflictError 로 던진다", e instanceof ps.ProjectBodyConflictError, String(e));
    chk("B3b 충돌이면 본문이 그대로다(덮지 않는다)", row.description === "남이 앞을 고친 원문", JSON.stringify(row));
    chk("B3c 같은 요청의 다른 키(이름)도 안 바뀐다 — 반쪽 저장 없음", row.name === "가드 B3", JSON.stringify(row));
  }

  // ── B4 빈 글에서 시작(DB 는 NULL) ──
  {
    const id = await mk("가드 B4", null);
    await ps.updateProject(id, { description: "처음 쓴 글", description_base: "" });
    chk("B4 본문이 없던(NULL) 프로젝트 — 빈 글을 기준으로 첫 저장이 된다", (await rowOf(id)).description === "처음 쓴 글");
    const id2 = await mk("가드 B4b", null);
    await ps.updateProject(id2, { description: "처음 쓴 글", description_base: null });
    chk("B4b 기준이 null 로 와도 빈 글과 같다", (await rowOf(id2)).description === "처음 쓴 글");
  }

  // ── B4c·B4d ★빈 기준인데 그 사이 누가 썼다 → 충돌(빈 문자열은 모든 글의 앞부분이라 «시작한다» 검사가 늘 참이다) ──
  {
    const id = await mk("가드 B4c", null);
    await ps.updateProject(id, { description: "Hello" });                       // 남이 먼저 썼다(통째 저장)
    const e = await caught(() => ps.updateProject(id, { description: "World", description_base: "" }));
    chk("B4c 빈 글에서 시작했는데 그 사이 본문이 생겼으면 충돌이다 — 두 글을 구분 없이 붙이지 않는다(`WorldHello` 금지)",
      e instanceof ps.ProjectBodyConflictError && (await rowOf(id)).description === "Hello", JSON.stringify({ e: String(e), row: await rowOf(id) }));
    const id2 = await mk("가드 B4d", null);
    await ps.updateProject(id2, { append_description: "세션의 첫 기록" });       // 빈 본문에 세션이 먼저 붙였다(구분자 없이 들어간다)
    const e2 = await caught(() => ps.updateProject(id2, { description: "사람의 첫 글", description_base: null }));
    chk("B4d 기준이 null 이어도 같다 — 빈 본문에 세션이 먼저 붙인 기록 앞에 내 글이 들러붙지 않는다",
      e2 instanceof ps.ProjectBodyConflictError && (await rowOf(id2)).description === "세션의 첫 기록", JSON.stringify({ e: String(e2), row: await rowOf(id2) }));
  }

  // ── B5 다 지웠다 → NULL ──
  {
    const id = await mk("가드 B5", "원문");
    await ps.updateProject(id, { description: null, description_base: "원문" });
    chk("B5 본문을 다 지우면 빈 문자열이 아니라 NULL 로 비워진다(종전 해제 규약과 같다)", (await rowOf(id)).description === null, JSON.stringify(await rowOf(id)));
  }

  // ── B6 기준을 안 보냄 → 종전대로 통째 교체 ──
  {
    const id = await mk("가드 B6", "아무 글");
    await ps.updateProject(id, { description: "통째 교체" });
    chk("B6 기준 없이 보내면 종전대로 통째 교체한다(MCP·옛 화면은 그대로 동작)", (await rowOf(id)).description === "통째 교체");
  }

  // ── B7 다 지웠는데 꼬리가 있다 → 꼬리는 남는다 ──
  {
    const id = await mk("가드 B7", "원문");
    await ps.updateProject(id, { append_description: "세션 기록" });
    await ps.updateProject(id, { description: null, description_base: "원문" });
    chk("B7 사람이 다 지워도 그 사이 붙은 꼬리는 남는다(비워지지 않는다)", (await rowOf(id)).description === "\n\n세션 기록", JSON.stringify(await rowOf(id)));
  }

  // ── B8 한글 — 글자 수로 자른다(바이트 수가 아니라) ──
  {
    const base = "가나다라 — 한글 본문 🙂";
    const id = await mk("가드 B8", base);
    await ps.updateProject(id, { append_description: "꼬리 기록 ✅" });
    await ps.updateProject(id, { description: "고친 한글", description_base: base });
    chk("B8 멀티바이트 본문에서도 꼬리가 글자 단위로 정확히 남는다", (await rowOf(id)).description === "고친 한글\n\n꼬리 기록 ✅", JSON.stringify(await rowOf(id)));
  }

  // ── B9 기준이 DB 보다 길다(누가 본문을 줄였다) → 충돌 ──
  {
    const id = await mk("가드 B9", "원문");
    const e = await caught(() => ps.updateProject(id, { description: "내 글", description_base: "원문 뒤에 더 있던 글" }));
    chk("B9 기준이 지금 본문보다 길면 충돌이다(앞부분이 같다고 통과시키지 않는다)",
      e instanceof ps.ProjectBodyConflictError && (await rowOf(id)).description === "원문", String(e));
  }

  // ── B10 이어서 두 번 — 첫 저장의 결과가 다음 기준 ──
  {
    const id = await mk("가드 B10", "원문");
    await ps.updateProject(id, { append_description: "꼬리" });
    const r1 = await ps.updateProject(id, { description: "첫 저장", description_base: "원문" });
    const r2 = await ps.updateProject(id, { description: r1.description + " + 둘째", description_base: r1.description });
    chk("B10 합쳐진 결과를 다음 기준으로 쓰면 이어지는 저장도 성공하고 꼬리가 두 번 붙지 않는다",
      r2.description === "첫 저장\n\n꼬리 + 둘째" && (await rowOf(id)).description === r2.description, JSON.stringify({ r1: r1.description, r2: r2.description }));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
