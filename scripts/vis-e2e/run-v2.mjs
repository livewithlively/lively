// #1291 v2 e2e — **admin 비우회 + 긴급 열람**을 실 게이트웨이로 검증한다.
//
//  v1 e2e(run.mjs)가 "비대상은 못 본다"를 봤다면, 이건 v2 에서 바뀐 두 가지를 본다:
//   ① admin 도 이제 내용을 못 본다(그 사람의 AI 가 잠긴 내용을 공개 지식으로 되뱉는 걸 막기 위해)
//   ② 대신 메타데이터는 보이고, 사유를 적고 여는 긴급 열람이 한시적으로 우회한다
//  이건 유닛으로는 못 본다 — 어댑터가 채운 신원이 실제 응답 경로 끝까지 같은 규칙을 타는지를 봐야 한다.
const BASE = process.env.BASE || "http://127.0.0.1:8099";
const SEED = JSON.parse(process.env.SEED || "{}");
const TOK = SEED.tokens || {};

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok   ${n}`); };
const bad = (n, why) => { fail++; console.log(`FAIL ${n} — ${why ?? ""}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why));

async function rest(who, path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOK[who]}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 본문 없음 */ }
  return { status: r.status, body };
}

async function mcp(who, tool, args = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOK[who]}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await r.text();
  const line = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { return { status: r.status, raw: text.slice(0, 200) }; }
  const content = parsed?.result?.content?.[0]?.text;
  let payload = null;
  try { payload = content ? JSON.parse(content) : null; } catch { payload = content; }
  return { status: r.status, isError: !!parsed?.result?.isError, payload, error: parsed?.error };
}

(async () => {
  const { lockedListId, lockedProjectId, openProjectId, lockedTaskId } = SEED;

  // ── 배선 — 이게 없으면 401 로도 "차단됨"이 통과한다(v1 에서 실제로 그랬다) ──
  for (const who of ["in", "out", "admin"]) {
    const me = await rest(who, "/api/ui/me");
    chk(`[배선] ${who} 토큰 살아있음(${me.body?.userId ?? "?"})`, me.status === 200 && !!me.body?.userId, `status=${me.status}`);
  }
  const admMe = await rest("admin", "/api/ui/me");
  chk("[배선] admin 토큰이 실제로 admin scope 보유", (admMe.body?.scopes || []).includes("admin"),
    JSON.stringify(admMe.body?.scopes));

  // ─────────────────────────────────────────────────────────────
  // 1) v2 핵심 — admin 도 **내용**은 못 본다
  // ─────────────────────────────────────────────────────────────
  const admList = await rest("admin", "/api/ui/v6/projects");
  const admIds = (admList.body?.projects || []).map((p) => p.id);
  chk("★[REST] admin 목록에 잠긴 프로젝트 없음", !admIds.includes(lockedProjectId), JSON.stringify(admIds));
  chk("[REST] admin 도 공개 프로젝트는 본다(과차단 아님)", admIds.includes(openProjectId));

  const admDet = await rest("admin", `/api/ui/v6/projects/${lockedProjectId}`);
  chk("★[REST] admin 상세 404", admDet.status === 404, `status=${admDet.status}`);
  const admTask = await rest("admin", `/api/ui/v6/tasks/${lockedTaskId}/detail`);
  chk("★[REST] admin 태스크 404", admTask.status === 404, `status=${admTask.status}`);
  const admFiles = await rest("admin", `/api/ui/v6/projects/${lockedProjectId}/files`);
  chk("★[REST] admin 파일 목록 404", admFiles.status === 404, `status=${admFiles.status}`);

  const admGrep = await mcp("admin", "project_grep", { q: "VISLOCKED" });
  const admGrepNames = (admGrep.payload?.projects || []).map((p) => p.name);
  chk("★[MCP ] admin 검색에도 안 나옴", !admGrepNames.includes("VIS_PROJ_LOCKED"), JSON.stringify(admGrepNames));

  // v3 — self 는 닫히지 않고 **행 단위로** 걸린다. admin 도 우회하지 않으므로 잠긴 프로젝트는 안 나온다.
  const admDb = await mcp("admin", "db_query", { source: "self", sql: `select id from project where id=${lockedProjectId}` });
  chk("★[MCP ] admin 의 self SQL 에도 잠긴 프로젝트는 안 나온다", (admDb.payload?.rows ?? []).length === 0,
    JSON.stringify(admDb.payload ?? admDb.error)?.slice(0, 120));

  // ─────────────────────────────────────────────────────────────
  // 2) 메타데이터는 보인다 — 운영이 눈을 잃지 않게
  // ─────────────────────────────────────────────────────────────
  const admLists = await rest("admin", "/api/ui/v6/project-lists");
  const lockedRow = (admLists.body?.lists || []).find((l) => l.id === lockedListId);
  chk("★[REST] admin 은 잠긴 리스트의 **존재**를 안다", !!lockedRow, JSON.stringify((admLists.body?.lists || []).map((l) => l.id)));
  chk("[REST] 그 행에 locked 표시", !!lockedRow?.locked, JSON.stringify(lockedRow ?? null)?.slice(0, 120));
  const outLists = await rest("out", "/api/ui/v6/project-lists");
  chk("[REST] 비-admin 에겐 그 존재조차 안 보인다",
    !(outLists.body?.lists || []).some((l) => l.id === lockedListId));

  // ─────────────────────────────────────────────────────────────
  // 3) 긴급 열람 — 사유를 적고 열면 보이고, 닫으면 다시 막힌다
  // ─────────────────────────────────────────────────────────────
  const noReason = await rest("admin", "/api/ui/vis/break-glass", {
    method: "POST", body: JSON.stringify({ reason: "야" }) });
  chk("[REST] 사유가 부실하면 거절", noReason.status === 400, `status=${noReason.status}`);

  const notAdmin = await rest("out", "/api/ui/vis/break-glass", {
    method: "POST", body: JSON.stringify({ reason: "권한 없는 사람이 여는 시도" }) });
  chk("★[REST] 비-admin 은 긴급 열람을 못 연다", notAdmin.status === 403 || notAdmin.status === 401,
    `status=${notAdmin.status}`);

  const opened = await rest("admin", "/api/ui/vis/break-glass", {
    method: "POST", body: JSON.stringify({ reason: "e2e 검증 — 퇴사자 인수인계 시나리오", minutes: 5 }) });
  chk("[REST] admin 은 사유와 함께 열 수 있다", opened.status === 200 && !!opened.body?.id,
    `status=${opened.status} ${JSON.stringify(opened.body)?.slice(0, 100)}`);

  // 캐시 TTL(5초)이 있어 조금 기다렸다 확인한다 — 즉시성보다 '열리긴 하는가'가 이 테스트의 관심사다.
  await new Promise((r) => setTimeout(r, 6000));
  const admDet2 = await rest("admin", `/api/ui/v6/projects/${lockedProjectId}`);
  chk("★[REST] 긴급 열람 중에는 admin 이 상세를 본다", admDet2.status === 200, `status=${admDet2.status}`);
  const admDb2 = await mcp("admin", "db_query", { source: "self", sql: `select id from project where id=${lockedProjectId}` });
  chk("★[MCP ] 긴급 열람 중에는 잠긴 행까지 보인다", (admDb2.payload?.rows ?? []).length === 1,
    JSON.stringify(admDb2.payload ?? admDb2.error)?.slice(0, 120));

  const hist = await rest("admin", "/api/ui/vis/break-glass");
  const active = (hist.body?.entries || []).filter((e) => e.active);
  chk("[REST] 이력에 사유와 함께 남는다", active.length > 0 && !!active[0]?.reason,
    JSON.stringify(active[0] ?? null)?.slice(0, 140));

  const ended = await rest("admin", "/api/ui/vis/break-glass/end", { method: "POST", body: "{}" });
  chk("[REST] 종료된다", ended.status === 200 && (ended.body?.ended ?? 0) > 0, JSON.stringify(ended.body));
  await new Promise((r) => setTimeout(r, 6000));
  const admDet3 = await rest("admin", `/api/ui/v6/projects/${lockedProjectId}`);
  chk("★[REST] 닫으면 다시 404", admDet3.status === 404, `status=${admDet3.status}`);

  // ─────────────────────────────────────────────────────────────
  // 4) 회귀 — 대상자는 종전대로 본다
  // ─────────────────────────────────────────────────────────────
  const inDet = await rest("in", `/api/ui/v6/projects/${lockedProjectId}`);
  chk("[REST] 대상자는 그대로 200", inDet.status === 200, `status=${inDet.status}`);
  const outOpen = await rest("out", "/api/ui/v6/projects");
  chk("[REST] 비대상도 공개 프로젝트는 그대로", (outOpen.body?.projects || []).length > 0);

  // ─────────────────────────────────────────────────────────────
  // 5) 휴지통 — **지우면 열린다**가 되지 않는지 (맨 뒤: 시드 상태를 바꾼다)
  //    이 구멍은 유닛·리뷰 1라운드·e2e 3종을 전부 통과했다. 게이트가 스토어가 돌려주지도 않는
  //    필드를 읽어 **완전한 no-op** 이었는데, 아무도 휴지통을 때려보지 않았기 때문이다.
  // ─────────────────────────────────────────────────────────────
  const del = await rest("in", `/api/ui/v6/projects/${lockedProjectId}/delete`, { method: "POST", body: "{}" });
  chk("[REST] 대상자는 잠긴 프로젝트를 지울 수 있다", del.status === 200, `status=${del.status}`);

  const outTrash = await rest("out", "/api/ui/deleted");
  const outHas = (outTrash.body?.entries || []).some((e) => e.entity === "project" && String(e.key) === String(lockedProjectId));
  chk("★[REST] 지워도 비대상 휴지통엔 안 나온다", !outHas,
    JSON.stringify((outTrash.body?.entries || []).slice(0, 3)));

  const outRestore = await rest("out", "/api/ui/deleted/restore", {
    method: "POST", body: JSON.stringify({ entity: "project", key: String(lockedProjectId) }) });
  chk("★[REST] 비대상은 복원으로 꺼낼 수 없다(404)", outRestore.status === 404, `status=${outRestore.status}`);

  const inTrash = await rest("in", "/api/ui/deleted");
  chk("[REST] 대상자 휴지통엔 그대로 있다(과차단 아님)",
    (inTrash.body?.entries || []).some((e) => e.entity === "project" && String(e.key) === String(lockedProjectId)),
    JSON.stringify((inTrash.body?.entries || []).slice(0, 3)));

  const inRestore = await rest("in", "/api/ui/deleted/restore", {
    method: "POST", body: JSON.stringify({ entity: "project", key: String(lockedProjectId) }) });
  chk("[REST] 대상자는 복원할 수 있다", inRestore.status === 200, `status=${inRestore.status}`);
  const afterRestore = await rest("out", `/api/ui/v6/projects/${lockedProjectId}`);
  chk("★[REST] 복원된 프로젝트는 여전히 잠겨 있다(복원이 잠금을 풀지 않는다)",
    afterRestore.status === 404, `status=${afterRestore.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("e2e 예외:", e?.stack || e); process.exit(1); });
