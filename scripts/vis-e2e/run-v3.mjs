// #1291 v3 e2e — self 소스가 **행 단위**로 걸리는지. v2 는 잠긴 게 하나라도 있으면 self 를 통째로 닫았다.
//  여기서 보는 것: ①잠겨 있어도 self 가 **열려 있다** ②그런데 잠긴 행은 결과에 **안 나온다**
//  ③비대상과 대상이 같은 SQL 에 다른 답을 받는다 ④소유자 권한으로 새어 나오지 않는다.
const BASE = process.env.BASE || "http://127.0.0.1:8099";
const SEED = JSON.parse(process.env.SEED || "{}");
const TOK = SEED.tokens || {};
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok   ${n}`); };
const bad = (n, why) => { fail++; console.log(`FAIL ${n} — ${why ?? ""}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why));

async function sql(who, text) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOK[who]}`, "content-type": "application/json",
      accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "db_query", arguments: { source: "self", sql: text } } }),
  });
  const t = await r.text();
  const line = t.startsWith("event:") || t.startsWith("data:")
    ? t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : t;
  let d = null; try { d = JSON.parse(line); } catch { return { err: t.slice(0, 200) }; }
  const c = d?.result?.content?.[0]?.text;
  let payload = null; try { payload = c ? JSON.parse(c) : null; } catch { payload = c; }
  return { isError: !!d?.result?.isError, payload };
}
const ids = (res) => (res.payload?.rows ?? []).map((r) => Number(r[0]));

(async () => {
  const { lockedProjectId, openProjectId, lockedListId } = SEED;

  // 배선 — 이게 없으면 "안 보인다"가 401 로도 통과한다
  for (const who of ["in", "out"]) {
    const me = await fetch(`${BASE}/api/ui/me`, { headers: { authorization: `Bearer ${TOK[who]}` } });
    chk(`[배선] ${who} 토큰 유효`, me.status === 200, `status=${me.status}`);
  }

  // ⚠ 배선 — self 가 아예 안 돌면 아래 "안 보인다" 단언이 **전부 공허하게 통과**한다.
  //  실제로 첫 실행에서 db 스코프가 없어 403 이 났고, 빈 결과를 "잠긴 게 안 보인다"로 오독했다.
  //  그래서 **잠금과 무관한 행이 실제로 돌아오는지**부터 확인한다.
  for (const who of ["in", "out"]) {
    const live = await sql(who, "select 1");
    chk(`[배선] ${who} 의 self 쿼리가 실제로 실행된다`,
      live.isError !== true && Number(live.payload?.rows?.[0]?.[0]) === 1,
      JSON.stringify(live.payload)?.slice(0, 160));
  }

  // ★ v3 핵심 ① — 잠긴 게 있어도 self 가 열려 있다(v2 는 여기서 전부 막혔다)
  const outAll = await sql("out", "select id from project where level='project' order by id");
  chk("★ 비대상도 self 를 쓸 수 있다(전면 차단 해제)", outAll.isError !== true,
    JSON.stringify(outAll.payload)?.slice(0, 200));

  // ★ ② 그런데 잠긴 프로젝트는 결과에 없다
  chk("★ 비대상의 SQL 결과에 잠긴 프로젝트가 없다", !ids(outAll).includes(lockedProjectId),
    `rows=${JSON.stringify(ids(outAll))}`);
  chk("  공개 프로젝트는 그대로 나온다(과차단 아님)", ids(outAll).includes(openProjectId),
    `rows=${JSON.stringify(ids(outAll))}`);

  // ★ ③ 대상자는 같은 SQL 로 그 행을 본다 — 신원에 따라 답이 갈린다
  const inAll = await sql("in", "select id from project where level='project' order by id");
  chk("★ 대상자의 같은 SQL 엔 잠긴 프로젝트가 나온다", ids(inAll).includes(lockedProjectId),
    `rows=${JSON.stringify(ids(inAll))}`);

  // ★ ④ 정면 조준(그 id 만 콕 집어도) 안 나온다
  const direct = await sql("out", `select id from project where id=${lockedProjectId}`);
  chk("★ id 를 직접 지정해도 비대상에겐 0행", ids(direct).length === 0, JSON.stringify(direct.payload)?.slice(0, 160));

  // ★ ⑤ 리스트 자체도 안 보인다
  const lists = await sql("out", "select id from project_list order by id");
  chk("★ 잠긴 리스트가 비대상의 SQL 에 안 나온다", !ids(lists).includes(lockedListId),
    `rows=${JSON.stringify(ids(lists))}`);

  // ★ ⑥ 자식 테이블(태스크 계열)로 우회되지 않는다 — v1 e2e 가 잡았던 누수 지점
  const tc = await sql("out", `select task_id from task_comment where task_id in (select id from project where parent_id=${lockedProjectId})`);
  chk("★ 잠긴 프로젝트의 태스크 코멘트도 안 나온다", (tc.payload?.rows ?? []).length === 0,
    JSON.stringify(tc.payload)?.slice(0, 160));

  // ⑦ 집계로도 존재가 새지 않는다
  const cnt = await sql("out", "select count(*)::int from project where level='project'");
  const inCnt = await sql("in", "select count(*)::int from project where level='project'");
  chk("★ count 조차 신원에 따라 다르다(존재 은닉)",
    Number(cnt.payload?.rows?.[0]?.[0]) < Number(inCnt.payload?.rows?.[0]?.[0]),
    `out=${cnt.payload?.rows?.[0]?.[0]} in=${inCnt.payload?.rows?.[0]?.[0]}`);

  // ⑧ 소유자 권한 누수 방지 — 정책 밖 테이블을 노려도 리더 롤엔 grant 가 없다
  const secret = await sql("out", "select * from auth_token limit 1");
  chk("  시크릿 테이블은 여전히 차단(allow-list)", secret.isError === true,
    JSON.stringify(secret.payload)?.slice(0, 120));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("e2e 예외:", e?.stack || e); process.exit(1); });
