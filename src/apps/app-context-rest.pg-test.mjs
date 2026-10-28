// 앱 맥락 범위(#5100) — 실제 Express 길 PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(.github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-context-rest.pg-test.mjs
//
// 왜 따로인가: 범위의 경계는 «앱 토큰 요청을 범위 안에서 돌리는» 문(인증 문 · 능력 어댑터)이다. app-context.pg-test.mjs 는 저장소 · 핸들러를
//  직접 불러 술어를 재고, 여기는 진짜 Express(registerWebUi · registerTerminalFiles)에 앱 토큰으로 요청해 문이 실제로 걸리는지 잰다.
//  이 DB 에는 «대상 제한(members)» 지식을 두지 않는다 — filterVisibleByName 의 지름길(잠긴 지식이 없으면 판정 생략)이 켜진 모양을 재야 해서다.
//
//  사양 · 엣지 표(격리 리뷰 B1 · N1 · N2 · N3 · 재검토 B1' 반영):
//   W1  능력 REST · knowledge_get: 범위 밖 = 403 out_of_app_context · 범위 안 = 200 · 사람 토큰 = 200(무회귀) · 범위 없는 앱 토큰 = 200(무회귀)
//   W2  능력 REST · grep(/knowledge/search): 앱 = 범위 밖 0건 · 사람 = 범위 밖 있음
//   W3  맨 Express 길 /sources/:id/original(범위 밖 종류 local_file): 앱 = 404(내용 없음) · 사람 = 200(내용)   ← 인증 문이 범위를 물려준다
//   W4  휴지통 목록 · 미리보기: 범위 앱 = 403 out_of_app_context · 사람 = 200
//   W4d 휴지통 되살리기(지운 범위 밖 지식): 범위 앱 = 403 · 답에 본문 없음 · 되살아나지 않는다
//   W4e 휴지통 파기: 범위 앱 = 403 · 삭제 스냅샷의 본문이 그대로 남는다
//   W4f 실행 취소(그 사람의 마지막 웹 변경 = 그 지식을 지운 것): 범위 앱 = 403 · 되살아나지 않는다
//   W4g 범위를 선언하지 않은 앱 토큰 = 휴지통 목록 200(무회귀)
//   W5  activity_list 의 지식 참조: 앱 = 범위 밖 참조 없음 · 사람 = 있음
//   W6  project_get_v6 의 필요 지식: 앱 = 범위 밖 없음 · 사람 = 있음
//   W7  knowledge_projects_v6: 앱 · 범위 밖 이름 = 403 · 앱 · 범위 안 이름 = 200 · 사람 · 범위 밖 이름 = 200
//   W8  filterVisibleByName(잠긴 지식 없는 DB): 범위 앱 = 범위 밖 행을 뺀다 · 범위 없음 = 그대로(지름길)
//   W8d 같은 것을 REST knowledge_revisions 로: 범위 앱 = 있는 범위 밖 문서의 수정 제안이 빠진다 · 사람 = 보인다
//   W10 이력 · 되돌리기(지운 범위 밖 지식 — 감사 스냅샷이 남는다): 목록 · 단건 = 403 · 본문 · 제목 없음 · 되돌리기 = 403 · 되살아나지 않는다
//   W10d 있는 범위 밖 문서의 이력 = 403 out_of_app_context · W10e 범위 안 문서의 이력 = 200
//   W10f 한 번도 없던 이름의 이력 = 지운 문서와 같은 답(403 — 지운 문서가 있었는지 알리지 않는다)
//   W10g 사람 · 범위 없는 앱 = 지운 문서의 이력 200 · 항목 있음(무회귀)
//   W11 지운 범위 밖 지식의 수정 제안(knowledge_revision 은 지식을 지워도 남는다): 범위 앱 목록 = 빠진다 · 상세 = 404 · 승인 = 404 · 되살아나지 않는다
//       · 사람 목록 = 보인다 · 상세 = 200(무회귀)
//   W12 내 사용 내역 · 증류기 미리보기: 범위 앱 = 403 · 사람 = 핸들러에 닿는다(200 · 400 «key 또는 draft»)
//   W13 앱 화면 다리(runAppTool): 범위 앱의 휴지통 목록 = 403 out_of_app_context · 범위 없는 앱 = 열린다
//   W14 사람 = 되살리기 200 · 되살아난다(앞의 403 들이 범위 판정이었다 — 이 토큰 · 이 자료로 되살리기는 된다)
//   W9  거절 기록 = 거절한 호출 하나에 한 줄씩 — 앱 w-app 의 (도구 · 길) 다중집합이 정확히 같다 · 모두 실패(REST = rest · 다리 = app-ui)
import "../../scripts/test-apps-root.mjs";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_context_rest_5100";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pgt-5100-rest-"));
process.env.TERMINAL_ROOT_PERSONAL = path.join(TMP, "personal");
process.env.TERMINAL_ROOT_SHARED = path.join(TMP, "shared");
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector"); await dbc.end();
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER"]) delete process.env[k];
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { upsertGrant } = await import(`${D}/org/store/apps.js`);
const { registerWebUi } = await import(`${D}/web.js`);
const { registerTerminalFiles } = await import(`${D}/terminal/terminal-files.js`);
const { knowledgeCapabilities } = await import(`${D}/capabilities/knowledge.js`);
const { filterVisibleByName } = await import(`${D}/capabilities/knowledge/shared.js`);
const { runAppTool } = await import(`${D}/capabilities/app-tool-call.js`);
const rs = await import(`${D}/v6/read-scope.js`);
const { slug } = await import(`${D}/terminal/profiles.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const aCap = (n) => appCapabilities.find((c) => c.name === n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;

try {
  // ── 데이터: 범위 안 · 밖 지식, 자료 둘(slack 안 · local_file 밖 — 개인 폴더 파일), 지운 범위 밖 지식, 활동 참조, 프로젝트 필요 지식 ──
  const OWNER = "pgt-uploader", CAROL = "pgt-carol", BOB = "pgt-bob";
  const cat = async (key) => Number((await q(`INSERT INTO category(key,name) VALUES($1,$1) RETURNING id`, [key]))[0].id);
  const idIn = await cat("w-in"), idOut = await cat("w-out");
  const mkK = async (name, title, body, catId) => {
    await q(`INSERT INTO knowledge(name,title,body_md,injection,provenance,lifecycle,confidence,source,visibility) VALUES($1,$2,$3,'recalled','authored','active','ai','authored','open')`, [name, title, body]);
    await q(`INSERT INTO knowledge_category(name,category_id,mapped_by,state) VALUES($1,$2,'manual','confirmed')`, [name, catId]);
  };
  await mkK("w-in-1", "정책 문서", "환불 정책 wzq 본문", idIn);
  await mkK("w-out-1", "설계 문서", "앱을 만드는 과정의 설계 wzq 비밀", idOut);
  const sSlack = Number((await q(`INSERT INTO source(name,kind,title,body_md,lifecycle,occurred_at) VALUES('w-s1','slack','슬랙 자료','본문','active',now()) RETURNING id`))[0].id);
  const rel = "uploads/secret.txt";
  const pdir = path.join(TMP, "personal", slug(OWNER), "uploads");
  fs.mkdirSync(pdir, { recursive: true }); fs.writeFileSync(path.join(pdir, "secret.txt"), "TOP-SECRET-LOCAL-FILE-CONTENT");
  const sLocal = Number((await q(`INSERT INTO source(name,kind,title,body_md,lifecycle,occurred_at,external_system,external_instance,external_id,provenance)
    VALUES('w-s2','local_file','비밀 파일','[BINARY]','active',now(),'local','default',$1,'observed') RETURNING id`, [`personal:${OWNER}/${rel}`]))[0].id);
  void sSlack;

  // 앱 둘 — 범위를 선언한 앱 · 선언하지 않은 앱(무회귀 대조) — 저장 · 공개 · carol 동의
  const TOOLS = ["knowledge_search", "knowledge_grep", "knowledge_get", "source_get", "deleted_list", "content_snapshot", "activity_list", "project_get_v6", "knowledge_projects_v6",
    "content_restore", "content_purge", "content_undo", "knowledge_history", "knowledge_history_entry", "knowledge_revert",
    "knowledge_revisions", "knowledge_revision_get", "knowledge_revision_review", "my_lively_log", "org_distiller_preview"];
  const bob = { userId: BOB, email: "b@x", scopes: ["memory"], projects: ["*"] };
  const files = (id, context) => [
    { path: "lively-app.json", content: JSON.stringify({ id, title: id, version: "1.0.0", permissions: { scopes: ["memory"], tools: TOOLS }, ...(context ? { context } : {}), ui: { pages: [{ key: "main", title: id, entry: "ui/index.html" }] } }) },
    { path: "ui/index.html", content: "<p>x</p>" },
  ];
  await aCap("app_save").handler({ files: files("w-app", { knowledge_categories: ["w-in"], source_kinds: ["slack"] }) }, bob, { source: "mcp" });
  await aCap("app_save").handler({ files: files("w-free") }, bob, { source: "mcp" });
  for (const id of ["w-app", "w-free"]) {
    await aCap("app_visibility_set").handler({ app_id: id, visibility: "all" }, bob, { source: "mcp" });
    await upsertGrant(id, CAROL, ["memory"], TOOLS, {});
  }
  const carolUser = { userId: CAROL, email: "c@x", scopes: ["memory"], projects: ["*"] };
  await mkK("w-del-1", "지운 설계 문서", "지운 설계 비밀 본문", idOut);
  await knowledgeCapabilities.find((c) => c.name === "knowledge_delete").handler({ name: "w-del-1" }, carolUser, { source: "web", actor: CAROL, viewer: CAROL });
  const delAudit = Number((await q(`SELECT id FROM org_content_audit WHERE entity='knowledge' AND entity_key='w-del-1' AND op='delete' ORDER BY id DESC LIMIT 1`))[0].id);
  //  수정 제안 셋 — 있는 범위 밖 · 범위 안 · 지운 범위 밖(지식을 지워도 행이 남는다)
  const rev = async (name, body) => Number((await q(`INSERT INTO knowledge_revision(name,mode,status,base_title,base_body_md,new_title,new_body_md,proposed_by)
    VALUES($1,'staged','pending',$1,$2,$1,$2,$3) RETURNING id`, [name, body, BOB]))[0].id);
  await rev("w-out-1", "범위 밖 수정 제안 본문");
  await rev("w-in-1", "범위 안 수정 제안 본문");
  const revDel = await rev("w-del-1", "지운 문서의 수정 제안 본문");
  const alive = async (name) => (await q(`SELECT 1 FROM knowledge WHERE name=$1`, [name])).length > 0;
  const actId = Number((await q(`INSERT INTO activity(type,title,summary,body,author_person,created_at) VALUES('docs','작업 기록','요약','본문',$1,now()) RETURNING id`, [CAROL]))[0].id);
  await q(`INSERT INTO activity_knowledge(activity_id,name,relation) VALUES($1,'w-out-1','produced'),($1,'w-in-1','references')`, [actId]);
  const projId = Number((await q(`INSERT INTO project(name,level,status,created_by) VALUES('w-project','project','active',$1) RETURNING id`, [CAROL]))[0].id);
  await q(`INSERT INTO project_knowledge(project_id,name,relation) VALUES($1,'w-out-1','required'),($1,'w-in-1','required')`, [projId]);

  // ── 진짜 Express — 가짜 검증기(토큰 → 사람)로 앱 토큰 · 사람 토큰 · 범위 없는 앱 토큰 ──
  const users = {
    "tok-app": { ...carolUser, tokenSource: "db", appId: "w-app" },
    "tok-free": { ...carolUser, tokenSource: "db", appId: "w-free" },
    "tok-human": { ...carolUser, tokenSource: "db" },
  };
  const verifier = { verifyAccessToken: async (t) => { const u = users[t]; if (!u) throw new Error("bad token"); return { token: t, clientId: "x", scopes: u.scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: u }; } };
  const app = express(); app.use(express.json());
  registerWebUi(app, verifier);
  registerTerminalFiles(app, verifier);
  server = http.createServer(app); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const call = async (method, p, tok, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 파일 본문 */ } return { status: r.status, text, json };
  };
  const get = (p, tok) => call("GET", p, tok);
  const post = (p, tok, body) => call("POST", p, tok, body ?? {});
  const denied = (r) => r.status === 403 && r.json?.code === "out_of_app_context";

  // ── W1 knowledge_get ──
  {
    const out = await get("/api/ui/knowledge/w-out-1", "tok-app");
    chk("W1 능력 REST: 범위 밖 knowledge_get = 403 out_of_app_context", out.status === 403 && /out_of_app_context/.test(out.text), `${out.status} ${out.text.slice(0, 120)}`);
    const inn = await get("/api/ui/knowledge/w-in-1", "tok-app");
    chk("W1b 능력 REST: 범위 안 = 200", inn.status === 200 && inn.json?.knowledge?.name === "w-in-1", `${inn.status}`);
    const hum = await get("/api/ui/knowledge/w-out-1", "tok-human");
    chk("W1c 사람 토큰은 그대로 열린다(무회귀)", hum.status === 200 && hum.json?.knowledge?.name === "w-out-1", `${hum.status}`);
    const free = await get("/api/ui/knowledge/w-out-1", "tok-free");
    chk("W1d 범위를 선언하지 않은 앱 토큰도 그대로(무회귀)", free.status === 200 && free.json?.knowledge?.name === "w-out-1", `${free.status} ${free.text.slice(0, 120)}`);
  }
  // ── W2 grep ──
  {
    const a = await get("/api/ui/knowledge/search?q=wzq", "tok-app");
    const names = (r) => (r.json?.entries ?? []).map((e) => e.name);
    chk("W2 능력 REST grep: 앱 = 범위 밖 0건 · 범위 안 있음", names(a).includes("w-in-1") && !names(a).includes("w-out-1"), JSON.stringify(names(a)));
    const h = await get("/api/ui/knowledge/search?q=wzq", "tok-human");
    chk("W2b 사람 = 범위 밖도 나온다", names(h).includes("w-out-1"), JSON.stringify(names(h)));
  }
  // ── W3 맨 Express 길 ──
  {
    const a = await get(`/api/ui/sources/${sLocal}/original`, "tok-app");
    chk("W3 맨 길 /sources/:id/original: 범위 밖 종류 = 404 · 내용 없음", a.status === 404 && !a.text.includes("TOP-SECRET"), `${a.status} ${a.text.slice(0, 80)}`);
    const h = await get(`/api/ui/sources/${sLocal}/original`, "tok-human");
    chk("W3b 사람 = 200 · 내용", h.status === 200 && h.text.includes("TOP-SECRET-LOCAL-FILE-CONTENT"), `${h.status} ${h.text.slice(0, 80)}`);
  }
  // ── W4 휴지통 ──
  {
    const l = await get("/api/ui/deleted?entity=knowledge", "tok-app");
    chk("W4 휴지통 목록: 범위 앱 = 403", l.status === 403 && /out_of_app_context/.test(l.text), `${l.status} ${l.text.slice(0, 120)}`);
    const s = await get("/api/ui/deleted/snapshot?entity=knowledge&key=w-del-1", "tok-app");
    chk("W4b 휴지통 미리보기: 범위 앱 = 403", s.status === 403 && /out_of_app_context/.test(s.text), `${s.status} ${s.text.slice(0, 120)}`);
    const hl = await get("/api/ui/deleted?entity=knowledge", "tok-human");
    chk("W4c 사람 = 200 · 지운 문서가 보인다", hl.status === 200 && (hl.json?.entries ?? []).some((e) => e.key === "w-del-1"), `${hl.status} ${hl.text.slice(0, 160)}`);
    const rs1 = await post("/api/ui/deleted/restore", "tok-app", { entity: "knowledge", key: "w-del-1" });
    chk("W4d 휴지통 되살리기: 범위 앱 = 403 · 본문 없음 · 되살아나지 않는다", denied(rs1) && !rs1.text.includes("비밀 본문") && !(await alive("w-del-1")), `${rs1.status} ${rs1.text.slice(0, 160)}`);
    const pg1 = await post("/api/ui/deleted/purge", "tok-app", { entity: "knowledge", key: "w-del-1" });
    const snap = (await q(`SELECT before->>'body_md' AS b FROM org_content_audit WHERE id=$1`, [delAudit]))[0]?.b;
    chk("W4e 휴지통 파기: 범위 앱 = 403 · 삭제 스냅샷 본문이 그대로", denied(pg1) && snap === "지운 설계 비밀 본문", `${pg1.status} ${pg1.text.slice(0, 120)} · 스냅샷=${snap}`);
    const ud = await post("/api/ui/undo", "tok-app", {});
    chk("W4f 실행 취소: 범위 앱 = 403 · 되살아나지 않는다", denied(ud) && !(await alive("w-del-1")), `${ud.status} ${ud.text.slice(0, 160)}`);
    const fl = await get("/api/ui/deleted?entity=knowledge", "tok-free");
    chk("W4g 범위를 선언하지 않은 앱 토큰 = 휴지통 목록 200(무회귀)", fl.status === 200 && (fl.json?.entries ?? []).some((e) => e.key === "w-del-1"), `${fl.status} ${fl.text.slice(0, 120)}`);
  }
  // ── W5 activity_list 지식 참조 ──
  {
    const refNames = (r) => (Array.isArray(r.json) ? r.json : (r.json?.entries ?? r.json?.activities ?? [])).flatMap((x) => (x.refs ?? x.knowledge ?? []).map((k) => k.name));
    const a = await get("/api/ui/activity/list", "tok-app");
    const h = await get("/api/ui/activity/list", "tok-human");
    chk("W5 activity_list: 앱 = 범위 밖 참조 없음 · 범위 안 참조 있음", a.status === 200 && refNames(a).includes("w-in-1") && !refNames(a).includes("w-out-1"), `${a.status} ${JSON.stringify(refNames(a))} ${a.text.slice(0, 200)}`);
    chk("W5b 사람 = 범위 밖 참조도 있다", refNames(h).includes("w-out-1"), JSON.stringify(refNames(h)));
  }
  // ── W6 project_get_v6 필요 지식 ──
  {
    const req = (r) => (r.json?.project?.knowledge?.required ?? r.json?.knowledge?.required ?? []).map((k) => k.name);
    const a = await get(`/api/ui/v6/projects/${projId}`, "tok-app");
    const h = await get(`/api/ui/v6/projects/${projId}`, "tok-human");
    chk("W6 project_get_v6: 앱 = 범위 밖 필요 지식 없음 · 범위 안 있음", a.status === 200 && req(a).includes("w-in-1") && !req(a).includes("w-out-1"), `${a.status} ${JSON.stringify(req(a))} ${a.text.slice(0, 160)}`);
    chk("W6b 사람 = 범위 밖 필요 지식도 있다", req(h).includes("w-out-1"), JSON.stringify(req(h)));
  }
  // ── W7 knowledge_projects_v6 ──
  {
    const a = await get("/api/ui/knowledge/w-out-1/projects", "tok-app");
    chk("W7 knowledge_projects_v6: 앱 · 범위 밖 이름 = 403", a.status === 403 && /out_of_app_context/.test(a.text), `${a.status} ${a.text.slice(0, 120)}`);
    const ai = await get("/api/ui/knowledge/w-in-1/projects", "tok-app");
    chk("W7b 앱 · 범위 안 이름 = 200", ai.status === 200, `${ai.status} ${ai.text.slice(0, 120)}`);
    const h = await get("/api/ui/knowledge/w-out-1/projects", "tok-human");
    chk("W7c 사람 · 범위 밖 이름 = 200(무회귀)", h.status === 200, `${h.status}`);
  }
  // ── W8 filterVisibleByName 지름길(B1) ──
  {
    const locked = (await q(`SELECT count(*)::int AS n FROM knowledge WHERE visibility='members'`))[0].n;
    chk("W8 전제: 이 DB 엔 대상 제한 지식이 없다(지름길이 켜진 모양)", locked === 0, String(locked));
    const rows = [{ name: "w-in-1" }, { name: "w-out-1" }];
    const scoped = await rs.withReadScope(async () => ({ appId: "w-app", knowledgeCategoryIds: [idIn], sourceKinds: [] }), () => filterVisibleByName(rows, CAROL));
    chk("W8b 범위 앱: 지름길을 타지 않고 범위 밖 행을 뺀다", JSON.stringify(scoped.map((r) => r.name)) === JSON.stringify(["w-in-1"]), JSON.stringify(scoped));
    const plain = await filterVisibleByName(rows, CAROL);
    chk("W8c 범위 없음: 종전 그대로(두 행)", plain.length === 2, JSON.stringify(plain));
  }
  // ── W8d knowledge_revisions(REST · 지름길이 켜진 DB) ──
  {
    const revNames = (r) => (r.json?.entries ?? []).map((e) => e.name);
    const a = await get("/api/ui/knowledge-revisions", "tok-app");
    chk("W8d REST knowledge_revisions: 범위 앱 = 범위 안만(있는 범위 밖 · 지운 범위 밖 제안이 빠진다)", a.status === 200 && JSON.stringify(revNames(a)) === JSON.stringify(["w-in-1"]), `${a.status} ${JSON.stringify(revNames(a))}`);
    const h = await get("/api/ui/knowledge-revisions", "tok-human");
    chk("W8e 사람 = 셋 다 보인다(무회귀 — 지운 문서의 제안 포함)", ["w-in-1", "w-out-1", "w-del-1"].every((n) => revNames(h).includes(n)), JSON.stringify(revNames(h)));
  }
  // ── W10 이력 · 되돌리기 ──
  {
    const hs = await get("/api/ui/knowledge/w-del-1/history", "tok-app");
    chk("W10 지운 범위 밖 문서의 이력: 범위 앱 = 403 · 제목 없음", denied(hs) && !hs.text.includes("지운 설계 문서"), `${hs.status} ${hs.text.slice(0, 160)}`);
    const he = await get(`/api/ui/knowledge/w-del-1/history/${delAudit}`, "tok-app");
    chk("W10b 이력 단건: 범위 앱 = 403 · 본문 없음", denied(he) && !he.text.includes("비밀 본문"), `${he.status} ${he.text.slice(0, 160)}`);
    const rv = await post("/api/ui/knowledge/w-del-1/revert", "tok-app", { audit_id: delAudit, to: "before" });
    chk("W10c 되돌리기: 범위 앱 = 403 · 되살아나지 않는다", denied(rv) && !(await alive("w-del-1")), `${rv.status} ${rv.text.slice(0, 160)}`);
    const ho = await get("/api/ui/knowledge/w-out-1/history", "tok-app");
    chk("W10d 있는 범위 밖 문서의 이력 = 403 out_of_app_context", denied(ho), `${ho.status} ${ho.text.slice(0, 120)}`);
    const hi = await get("/api/ui/knowledge/w-in-1/history", "tok-app");
    chk("W10e 범위 안 문서의 이력 = 200", hi.status === 200 && Array.isArray(hi.json?.entries), `${hi.status} ${hi.text.slice(0, 120)}`);
    const hn = await get("/api/ui/knowledge/w-never-was/history", "tok-app");
    chk("W10f 한 번도 없던 이름 = 지운 문서와 같은 답(403)", denied(hn) && hn.status === hs.status, `${hn.status} ${hn.text.slice(0, 120)}`);
    const hh = await get("/api/ui/knowledge/w-del-1/history", "tok-human");
    const hf = await get("/api/ui/knowledge/w-del-1/history", "tok-free");
    chk("W10g 사람 · 범위 없는 앱 = 지운 문서의 이력 200 · 항목 있음(무회귀)", hh.status === 200 && (hh.json?.entries ?? []).length > 0 && hf.status === 200 && (hf.json?.entries ?? []).length > 0, `${hh.status} ${hf.status} ${hf.text.slice(0, 120)}`);
  }
  // ── W11 지운 문서의 수정 제안 ──
  {
    const g = await get(`/api/ui/knowledge-revisions/${revDel}`, "tok-app");
    chk("W11 지운 범위 밖 문서의 수정 제안 상세: 범위 앱 = 404 · 본문 없음", g.status === 404 && !g.text.includes("수정 제안 본문"), `${g.status} ${g.text.slice(0, 160)}`);
    const ap = await post(`/api/ui/knowledge-revisions/${revDel}/review`, "tok-app", { decision: "approve" });
    const st = (await q(`SELECT status FROM knowledge_revision WHERE id=$1`, [revDel]))[0]?.status;
    chk("W11b 승인: 범위 앱 = 404 · 되살아나지 않는다 · 제안은 그대로 대기", ap.status === 404 && !(await alive("w-del-1")) && st === "pending", `${ap.status} ${ap.text.slice(0, 160)} · status=${st}`);
    const hg = await get(`/api/ui/knowledge-revisions/${revDel}`, "tok-human");
    chk("W11c 사람 = 상세 200(무회귀)", hg.status === 200, `${hg.status} ${hg.text.slice(0, 120)}`);
  }
  // ── W12 사용 내역 · 증류기 미리보기 ──
  {
    const la = await get("/api/ui/me/lively-log", "tok-app");
    const lh = await get("/api/ui/me/lively-log", "tok-human");
    chk("W12 내 사용 내역: 범위 앱 = 403 · 사람 = 200", denied(la) && lh.status === 200, `${la.status} ${la.text.slice(0, 120)} · 사람 ${lh.status}`);
    const da = await get("/api/ui/org/distillers/preview", "tok-app");
    const dh = await get("/api/ui/org/distillers/preview", "tok-human");
    chk("W12b 증류기 미리보기: 범위 앱 = 403 · 사람 = 핸들러에 닿는다(400 key 또는 draft)", denied(da) && dh.status === 400 && /key 또는 draft/.test(dh.text), `${da.status} ${da.text.slice(0, 120)} · 사람 ${dh.status} ${dh.text.slice(0, 80)}`);
  }
  // ── W13 앱 화면 다리 ──
  {
    let err = null;
    try { await runAppTool(carolUser, "w-app", "deleted_list", { entity: "knowledge" }, { source: "app-ui" }); } catch (e) { err = e; }
    chk("W13 다리: 범위 앱의 휴지통 목록 = 403 out_of_app_context", err?.status === 403 && err?.body?.code === "out_of_app_context", `${err?.status} ${err?.message}`);
    const free = await runAppTool(carolUser, "w-free", "deleted_list", { entity: "knowledge" }, { source: "app-ui" });
    chk("W13b 다리: 범위 없는 앱 = 열린다(무회귀)", (free?.entries ?? []).some((e) => e.key === "w-del-1"), JSON.stringify(free).slice(0, 160));
  }
  // ── W14 사람은 되살린다 ──
  {
    const r = await post("/api/ui/deleted/restore", "tok-human", { entity: "knowledge", key: "w-del-1" });
    chk("W14 사람 = 되살리기 200 · 되살아난다", r.status === 200 && (await alive("w-del-1")), `${r.status} ${r.text.slice(0, 160)}`);
  }
  // ── W9 거절 기록(정확히) ──
  {
    const want = ["knowledge_get", "deleted_list", "content_snapshot", "content_restore", "content_purge", "content_undo", "knowledge_projects_v6",
      "knowledge_history", "knowledge_history_entry", "knowledge_revert", "knowledge_history", "knowledge_history", "my_lively_log", "org_distiller_preview"]
      .map((t) => `${t}|rest`).concat(["deleted_list|app-ui"]).sort();
    let rows = [];
    for (let i = 0; i < 30 && rows.length < want.length; i++) { await sleep(100); rows = await q(`SELECT tool, ok, harness FROM mcp_call_log WHERE app='w-app' ORDER BY id`); }
    await sleep(300); rows = await q(`SELECT tool, ok, harness FROM mcp_call_log WHERE app='w-app' ORDER BY id`);   // 늦게 오는 줄(두 번 적기)까지 본다
    const got = rows.map((r) => `${r.tool}|${r.harness}`).sort();
    chk("W9 거절 기록 = 거절 하나에 한 줄(도구 · 길 다중집합이 정확히 같다) · 모두 실패", JSON.stringify(got) === JSON.stringify(want) && rows.every((r) => r.ok === false), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
} catch (e) {
  fail++; console.error("FAIL 예외 —", e && e.stack || String(e));
} finally {
  if (server) server.close();
  await itemsPool.end().catch(() => undefined);
  if (!process.env.KEEP_TEST_DB) await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await su.end();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
