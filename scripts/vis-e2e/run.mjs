// #1291 맥락 가시성 — **실 게이트웨이 e2e**(pilot-box, 격리 DB, 포트 8099).
//
//  이 검증이 답해야 하는 질문은 하나다: **"사람과 그 사람의 AI 에 동시에 적용되는가"**(기획 원문 R1).
//  그래서 같은 신원으로 **REST(사람 화면이 쓰는 표면)와 MCP(AI 가 쓰는 표면)를 나란히** 때려
//  두 표면이 같은 답을 내는지 본다 — 유닛·SQL 테스트로는 이걸 못 본다.
//
//  잠그는 것은 시드로 직접 넣는다(SQL) — 관리 API 를 경유하면 무엇이 검증되는지 흐려진다.
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

// MCP 는 JSON-RPC over HTTP(streamable). tools/call 로 같은 capability 를 부른다.
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
  // 스트리밍 응답이면 SSE 프레임에서 data: 를 걷어낸다.
  const jsonLine = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;
  let parsed = null;
  try { parsed = JSON.parse(jsonLine); } catch { return { status: r.status, raw: text.slice(0, 200) }; }
  const content = parsed?.result?.content?.[0]?.text;
  let payload = null;
  try { payload = content ? JSON.parse(content) : null; } catch { payload = content; }
  return { status: r.status, isError: !!parsed?.result?.isError, payload, error: parsed?.error };
}

const names = (arr, key = "name") => (arr || []).map((x) => x[key]);

(async () => {
  // ─────────────────────────────────────────────────────────────
  // 1) 비대상(vis_out) — 잠긴 리스트의 것이 하나도 안 보여야 한다
  // ─────────────────────────────────────────────────────────────
  const seed = SEED;
  const { lockedListId, openListId, lockedProjectId, openProjectId, lockedTaskId, lockedSubtaskId, spaceLockedListId } = seed;

  // ── 배선 확인 — 이게 없으면 401 로도 "차단됨"이 통과해 아무것도 검증하지 못한다(공허한 테스트) ──
  for (const who of ["in", "out", "admin"]) {
    const me = await rest(who, "/api/ui/me");
    chk(`[배선] ${who} 토큰이 살아있다(${me.body?.userId ?? "?"})`, me.status === 200 && !!me.body?.userId,
      `status=${me.status}`);
  }
  const openProbe = await rest("out", "/api/ui/v6/projects");
  chk("[배선] 비대상도 공개 프로젝트는 받는다(응답이 비어 있지 않다)",
    (openProbe.body?.projects || []).length > 0, `n=${(openProbe.body?.projects || []).length}`);

  // ── 프로젝트 목록: REST vs MCP ──
  const listRest = await rest("out", "/api/ui/v6/projects");
  const listMcp = await mcp("out", "project_list_v6", {});
  const restIds = (listRest.body?.projects || []).map((p) => p.id);
  const mcpIds = (listMcp.payload?.projects || []).map((p) => p.id);
  chk("[REST] 비대상 목록에 잠긴 프로젝트 없음", !restIds.includes(lockedProjectId), JSON.stringify(restIds));
  chk("[MCP ] 비대상 목록에 잠긴 프로젝트 없음", !mcpIds.includes(lockedProjectId), JSON.stringify(mcpIds));
  chk("[REST] 공개 프로젝트는 보인다(과차단 아님)", restIds.includes(openProjectId));
  chk("[MCP ] 공개 프로젝트는 보인다(과차단 아님)", mcpIds.includes(openProjectId));
  chk("★ 두 표면의 답이 같다(목록)", JSON.stringify(restIds.sort()) === JSON.stringify(mcpIds.sort()),
    `rest=${restIds} mcp=${mcpIds}`);

  // ── 상세: 404(존재 은닉) ──
  const detRest = await rest("out", `/api/ui/v6/projects/${lockedProjectId}`);
  const detMcp = await mcp("out", "project_get_v6", { id: lockedProjectId });
  chk("[REST] 잠긴 프로젝트 상세 404", detRest.status === 404, `status=${detRest.status}`);
  chk("[MCP ] 잠긴 프로젝트 상세 거부", detMcp.isError === true, JSON.stringify(detMcp.payload ?? detMcp.error));
  const detOpen = await rest("out", `/api/ui/v6/projects/${openProjectId}`);
  chk("[REST] 공개 프로젝트 상세는 200", detOpen.status === 200, `status=${detOpen.status}`);

  // ── 검색(grep) — 목록만 막고 검색이 열려 있던 게 원래 구멍이었다 ──
  const grepRest = await rest("out", `/api/ui/v6/projects/search?q=VISLOCKED`);
  const grepMcp = await mcp("out", "project_grep", { q: "VISLOCKED" });
  const grepRestNames = names(grepRest.body?.projects);
  const grepMcpNames = names(grepMcp.payload?.projects);
  chk("[REST] 검색에 잠긴 프로젝트 안 나옴",
    !grepRestNames.includes("VIS_PROJ_LOCKED") && grepRestNames.includes("VIS_PROJ_OPEN"), JSON.stringify(grepRestNames));
  chk("[MCP ] 검색에 잠긴 프로젝트 안 나옴",
    !grepMcpNames.includes("VIS_PROJ_LOCKED") && grepMcpNames.includes("VIS_PROJ_OPEN"), JSON.stringify(grepMcpNames));

  // ── 태스크: 자기 list_id 가 비어 있어 조상 해소가 없으면 전부 새는 자리 ──
  const taskRest = await rest("out", `/api/ui/v6/tasks/${lockedTaskId}/detail`);
  const taskMcp = await mcp("out", "task_detail_v6", { id: lockedTaskId });
  chk("[REST] 잠긴 프로젝트의 태스크 차단", taskRest.status === 404, `status=${taskRest.status}`);
  chk("[MCP ] 잠긴 프로젝트의 태스크 차단", taskMcp.isError === true || taskMcp.payload?.task == null,
    JSON.stringify(taskMcp.payload)?.slice(0, 120));
  const subMcp = await mcp("out", "task_detail_v6", { id: lockedSubtaskId });
  chk("[MCP ] 서브태스크도 2홉 위까지 올라가 차단", subMcp.isError === true || subMcp.payload?.task == null);

  // ── 파일·타임라인·세션: projBase 한 곳이 덮는 표면 ──
  const fileRest = await rest("out", `/api/ui/v6/projects/${lockedProjectId}/files`);
  const tlRest = await rest("out", `/api/ui/v6/projects/${lockedProjectId}/activity`);
  const sessRest = await rest("out", `/api/ui/v6/projects/${lockedProjectId}/sessions`);
  chk("[REST] 잠긴 프로젝트 파일 목록 404", fileRest.status === 404, `status=${fileRest.status}`);
  chk("[REST] 잠긴 프로젝트 타임라인 404", tlRest.status === 404, `status=${tlRest.status}`);
  chk("[REST] 잠긴 프로젝트 세션 목록 404", sessRest.status === 404, `status=${sessRest.status}`);

  // ── 쓰기: 안 보이는 것은 만질 수도 없다 ──
  const wRest = await rest("out", `/api/ui/v6/projects/${lockedProjectId}`, {
    method: "POST", body: JSON.stringify({ name: "탈취시도" }) });
  const wMcp = await mcp("out", "project_update_v6", { id: lockedProjectId, name: "탈취시도" });
  chk("[REST] 잠긴 프로젝트 수정 차단", wRest.status === 404, `status=${wRest.status}`);
  chk("[MCP ] 잠긴 프로젝트 수정 차단", wMcp.isError === true);

  // ── 리스트 설정 탈취(잠금 되돌리기) ──
  const unlock = await rest("out", `/api/ui/v6/project-lists/${lockedListId}`, {
    method: "POST", body: JSON.stringify({ visibility: "open" }) });
  chk("[REST] 비대상이 공개범위를 되돌릴 수 없다", unlock.status === 404, `status=${unlock.status}`);

  // ── 리스트/폴더 목록: 껍데기가 남지 않아야 한다 ──
  const listsRest = await rest("out", "/api/ui/v6/project-lists");
  const foldersRest = await rest("out", "/api/ui/v6/project-folders");
  const listIds = (listsRest.body?.lists || []).map((l) => l.id);
  chk("[REST] 잠긴 리스트는 목록에 없음", !listIds.includes(lockedListId), JSON.stringify(listIds));
  chk("[REST] 잠긴 스페이스 하위(2홉) 리스트도 없음", !listIds.includes(spaceLockedListId), JSON.stringify(listIds));
  const folderCounts = (foldersRest.body?.folders || []).map((f) => `${f.name}:${f.list_count}`);
  chk("[REST] 폴더 목록에 잠긴 스페이스 없음",
    !(foldersRest.body?.folders || []).some((f) => f.name === "VIS_SPACE_LOCKED"), JSON.stringify(folderCounts));

  // ─────────────────────────────────────────────────────────────
  // 2) 대상(vis_in) — 같은 것이 보여야 한다(잠금이 과차단이 아님)
  // ─────────────────────────────────────────────────────────────
  const inList = await rest("in", "/api/ui/v6/projects");
  const inListMcp = await mcp("in", "project_list_v6", {});
  chk("[REST] 대상에겐 잠긴 프로젝트가 보인다",
    (inList.body?.projects || []).map((p) => p.id).includes(lockedProjectId));
  chk("[MCP ] 대상에겐 잠긴 프로젝트가 보인다",
    (inListMcp.payload?.projects || []).map((p) => p.id).includes(lockedProjectId));
  const inDet = await rest("in", `/api/ui/v6/projects/${lockedProjectId}`);
  chk("[REST] 대상은 상세도 200", inDet.status === 200, `status=${inDet.status}`);
  const inTask = await rest("in", `/api/ui/v6/tasks/${lockedTaskId}/detail`);
  chk("[REST] 대상은 태스크도 본다", inTask.status === 200, `status=${inTask.status}`);
  const inFiles = await rest("in", `/api/ui/v6/projects/${lockedProjectId}/files`);
  chk("[REST] 대상은 파일 목록도 본다", inFiles.status === 200,
    `status=${inFiles.status} body=${JSON.stringify(inFiles.body)?.slice(0, 160)}`);

  // ─────────────────────────────────────────────────────────────
  // 3) admin — 우회(조직 운영)
  // ─────────────────────────────────────────────────────────────
  // ⚠ v2 에서 정책이 바뀌었다: admin 도 **내용**은 못 본다(그 사람의 AI 가 잠긴 내용을 공개 지식으로
  //  되뱉는 걸 막기 위해). 우회는 긴급 열람으로만 — 그건 run-v2.mjs 가 검증한다.
  const admList = await rest("admin", "/api/ui/v6/projects");
  chk("[REST] admin 도 잠긴 프로젝트는 못 본다(v2)",
    !(admList.body?.projects || []).map((p) => p.id).includes(lockedProjectId));

  // ─────────────────────────────────────────────────────────────
  // 4) db_query self — v3 부터 **차단이 아니라 행 단위 필터**다(SQL 우회는 여전히 봉쇄).
  //    v1·v2 는 "잠긴 게 있으면 self 를 통째로 닫는다"였는데, 리스트 하나 잠근 대가로 조직 전체가
  //    SQL 조회를 잃는 게 너무 거칠어 바뀌었다(고객사 A 실측 61/66명 영향).
  //    ⚠ "열린다"만 단언하면 필터가 죽어도 통과한다 → **신원별로 답이 갈리는지**를 본다.
  // ─────────────────────────────────────────────────────────────
  const cnt = async (who) => {
    const r = await mcp(who, "db_query", { source: "self", sql: "select count(*)::int as n from project where level='project'" });
    return r.isError ? -1 : Number(r.payload?.rows?.[0]?.[0]);
  };
  const [nIn, nOut, nAdmin] = [await cnt("in"), await cnt("out"), await cnt("admin")];
  chk("[MCP ] self SQL 이 열려 있다(v3 — 전면 차단 폐지)", nOut >= 0 && nIn >= 0 && nAdmin >= 0,
    `in=${nIn} out=${nOut} admin=${nAdmin}`);
  chk("★[MCP ] 대상자가 비대상보다 더 본다(행 필터가 살아 있다)", nIn > nOut, `in=${nIn} out=${nOut}`);
  chk("★[MCP ] admin 도 비대상과 같은 만큼만 본다(admin 비우회)", nAdmin === nOut, `admin=${nAdmin} out=${nOut}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("e2e 예외:", e?.stack || e); process.exit(1); });
