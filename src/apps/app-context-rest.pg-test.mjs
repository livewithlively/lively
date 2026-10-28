// 앱 맥락 범위(#5100) — 실제 Express 길 PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(.github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-context-rest.pg-test.mjs
//
// 왜 따로인가: 범위의 경계는 «앱 토큰 요청을 범위 안에서 돌리는» 문(인증 문 · 능력 어댑터)이다. app-context.pg-test.mjs 는 저장소 · 핸들러를
//  직접 불러 술어를 재고, 여기는 진짜 Express(registerWebUi · registerTerminalFiles)에 앱 토큰으로 요청해 문이 실제로 걸리는지 잰다.
//  이 DB 에는 «대상 제한(members)» 지식을 두지 않는다 — filterVisibleByName 의 지름길(잠긴 지식이 없으면 판정 생략)이 켜진 모양을 재야 해서다.
//
//  사양 · 엣지 표(격리 리뷰 B1 · N1 · N2 · N3 · 재검토 B1' · 재재검토 B-1~B-3 · 재재재검토 반영):
//   W1  능력 REST · knowledge_get: 범위 밖 = 403 out_of_app_context · 범위 안 = 200 · 사람 토큰 = 200(무회귀) · 범위 없는 앱 토큰 = 200(무회귀)
//   W2  능력 REST · grep(/knowledge/search): 앱 = 범위 밖 0건 · 사람 = 범위 밖 있음
//   W3  맨 Express 길 /sources/:id/original(범위 밖 종류 local_file): 앱 = 404(내용 없음) · 사람 = 200(내용)   ← 인증 문이 범위를 물려준다
//   W4  휴지통 목록 · 미리보기: 범위 앱 = 403 out_of_app_context · 사람 = 200
//   W4d 휴지통 되살리기(지운 범위 밖 지식): 범위 앱 = 403 · 답에 본문 없음 · 되살아나지 않는다
//   W4e 휴지통 파기: 범위 앱 = 403 · 삭제 스냅샷의 본문이 그대로 남는다
//   W4f 실행 취소(그 사람의 마지막 웹 변경 = 그 지식을 지운 것): 범위 앱 = 403 · 되살아나지 않는다
//   W4g 범위를 선언하지 않은 앱 토큰 = 휴지통 목록 200(무회귀)
//   W4h 휴지통 개수: 범위 앱 = 403 · 사람 = 200(지운 문서 개수를 범위 없이 센다)
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
//   W15 맥락 파이프라인 읽기(이름 앞머리 org_distiller_ · org_manager_ 로 막는다): 카테고리 붙이기 미리보기(미분류 지식) · 증류기 조율(범위 밖 종류
//       자료의 낱말) · 관리기 발견 목록(지운 문서의 인용) · 증류기 목록 = 범위 앱 403 · 사람 = 200 이고 그 내용이 보인다(길이 살아 있다는 대조)
//   W16 관리기로 범위 넓히기 연쇄(미분류 문서를 범위 안 카테고리로 옮기기): 발견 보고 · 일괄 적용 · 처리(apply) = 범위 앱 403 · 발견이 안 생기고
//       문서는 미분류 그대로 · 그 문서는 여전히 범위 밖(403)
//   W17 파생 중복 알림(쓰기 답 — 훑기가 못 보는 길): 범위 앱이 범위 안 자료로 지식을 저장 · 연결하면 알림에 범위 안 형제만 실리고 범위 밖 · 미분류
//       형제의 이름은 없다 · 사람은 그 이름을 본다(같은 자료의 읽기와 같은 기준)
//   W18 번호로 부르는 쓰기: 범위 밖 문서의 수정 제안 승인 · 댓글 반응 = 범위 앱 404 · 답에 문서 이름이 없다(요청에 없던 이름) · 사람 반응 = 200
//   W18d 없는 댓글 번호 = 숨은 문서의 댓글과 같은 답(404 «댓글 없음» — 없는 번호만 500 으로 갈라지지 않는다) · 사람에게도 404
//   W19 새 자격: 본인 토큰 발급 · 장치 승인 = 범위 앱 403 out_of_app_context(새 토큰엔 앱 범위가 없다) · 토큰 없음 · 사람 = 토큰을 받는다
//   W8f 검토 대기 카테고리별 건수: 범위 앱 = 범위 밖 카테고리가 안 나온다 · 사람 = 나온다
//   W20 구성원 이름으로 AI 를 띄우는 도구(예약 작업 · 지금 실행 · 리브 열기 · 프로젝트 대화 · Claude 수집 실행)와 수집 미리보기 = 범위 앱 403
//       out_of_app_context(사람 대조는 부르지 않는다 — 진짜 실행이 뜬다)
//   W21 시험이 세션을 띄우지 않았다 — tmux 를 임시 자리로 떼어 놓고(scripts/test-tmux-isolation.mjs) 끝에 임시 자리 · 실제 자리 모두 시험 사용자의 세션 0
//   W14 사람 = 되살리기 200 · 되살아난다(앞의 403 들이 범위 판정이었다 — 이 토큰 · 이 자료로 되살리기는 된다)
//   W9  거절 기록 = 거절한 호출 하나에 한 줄씩 — 앱 w-app 의 (도구 · 길) 다중집합이 정확히 같다 · 모두 실패(REST = rest · 다리 = app-ui)
import "../../scripts/test-apps-root.mjs";
import { leftTmuxSessions, realTmuxSessionsWithPrefix } from "../../scripts/test-tmux-isolation.mjs";   // 터미널 모듈보다 먼저
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
const { registry } = await import(`${D}/capabilities/index.js`);
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
    "knowledge_revisions", "knowledge_revision_get", "knowledge_revision_review", "my_lively_log", "org_distiller_preview",
    "trash_counts", "org_distiller_category_preview", "org_distiller_tune", "org_manager_findings", "org_distiller_list",
    "org_manager_finding_report", "org_manager_findings_apply", "org_manager_finding_resolve",
    "knowledge_save", "source_link_knowledge", "knowledge_comment_reaction", "review_queue_summary", "org_token_mint_self", "device_approve",
    "cron_set", "cron_run_now", "me_liv_open", "project_chat_turn", "collect_claude_run", "org_collector_preview"];
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
  const revOut = await rev("w-out-1", "범위 밖 수정 제안 본문");
  await rev("w-in-1", "범위 안 수정 제안 본문");
  const revDel = await rev("w-del-1", "지운 문서의 수정 제안 본문");
  const alive = async (name) => (await q(`SELECT 1 FROM knowledge WHERE name=$1`, [name])).length > 0;
  //  맥락 파이프라인 — 미분류 문서 · 카테고리 붙이기 레인 · 자료 레인(조율용 범위 밖 종류 자료 7건) · 관리기 발견(있는 범위 밖 · 지운 문서)
  await q(`INSERT INTO knowledge(name,title,body_md,injection,provenance,lifecycle,confidence,source,visibility) VALUES('w-uncat-1','미분류 비밀 문서','미분류 비밀 본문','recalled','authored','active','ai','authored','open')`);
  const adminUser = { ...carolUser, scopes: ["memory", "context", "admin"] };
  const wctx = { source: "web", actor: CAROL, viewer: CAROL };
  await registry.get("org_distiller_category_upsert").handler({ key: "w-lane", label: "w lane", enabled: true }, adminUser, wctx);
  await registry.get("org_distiller_upsert").handler({ key: "w-d", label: "w d", enabled: false }, adminUser, wctx);
  for (let i = 0; i < 7; i++) {
    const sid = Number((await q(`INSERT INTO source(name,kind,title,body_md,lifecycle,occurred_at) VALUES($1,'email','메일','쿼카표지 환불 정책 내용','active',now()) RETURNING id`, [`w-mail-${i}`]))[0].id);
    await q(`INSERT INTO knowledge_source(name,source_id,relation) VALUES('w-in-1',$1,'derived_from')`, [sid]);
  }
  const mgrId = Number((await q(`INSERT INTO org_manager(key,label,kind,enabled) VALUES('w-mgr','w','contradiction',true) RETURNING id`))[0].id);
  await q(`INSERT INTO org_manager_finding(manager_id,kind,target_kind,target_ref,dedup_key,severity,summary,evidence) VALUES
    ($1,'contradiction','knowledge','w-out-1','f1','warn','범위 밖 발견 요약','범위 밖 발견 인용'),
    ($1,'contradiction','knowledge','w-del-1','f2','warn','지운 문서 발견 요약','지운 설계 비밀 본문 인용')`, [mgrId]);
  const fMove = Number((await q(`INSERT INTO org_manager_finding(manager_id,kind,target_kind,target_ref,dedup_key,severity,summary,evidence,proposed_action)
    VALUES($1,'mismatch','knowledge','w-uncat-1','f3','note','옮기기','x',$2::jsonb) RETURNING id`, [mgrId, JSON.stringify({ op: "move_category", name: "w-uncat-1", to_category_id: idIn })]))[0].id);
  const catsOf = async (name) => (await q(`SELECT category_id FROM knowledge_category WHERE name=$1`, [name])).map((r) => Number(r.category_id));
  //  범위 안 자료(slack)에서 파생된 형제 셋 — 범위 안 · 범위 밖 · 미분류(파생 중복 알림의 이름) · 범위 밖 문서의 댓글(번호로 부르는 반응)
  await q(`INSERT INTO knowledge_source(name,source_id,relation) VALUES('w-in-1',$1,'derived_from'),('w-out-1',$1,'derived_from'),('w-uncat-1',$1,'derived_from')`, [sSlack]);
  const cmtOut = Number((await q(`INSERT INTO knowledge_comment(name,author,body) VALUES('w-out-1',$1,'범위 밖 댓글') RETURNING id`, [BOB]))[0].id);
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
    const ca = await get("/api/ui/deleted/counts", "tok-app");
    const ch = await get("/api/ui/deleted/counts", "tok-human");
    chk("W4h 휴지통 개수: 범위 앱 = 403 · 사람 = 200", denied(ca) && ch.status === 200 && Number(ch.json?.knowledge) >= 1, `${ca.status} ${ca.text.slice(0, 100)} · 사람 ${ch.status} ${ch.text.slice(0, 80)}`);
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
  // ── W15 맥락 파이프라인 읽기 ──
  {
    const cp = await get("/api/ui/org/classifiers/preview?key=w-lane", "tok-app");
    const cph = await get("/api/ui/org/classifiers/preview?key=w-lane", "tok-human");
    chk("W15 카테고리 붙이기 미리보기: 범위 앱 = 403 · 사람 = 200 · 미분류 문서가 보인다", denied(cp) && cph.status === 200 && cph.text.includes("w-uncat-1"), `${cp.status} ${cp.text.slice(0, 100)} · 사람 ${cph.status} ${cph.text.slice(0, 100)}`);
    const tn = await post("/api/ui/org/distillers/tune", "tok-app", { key: "w-d" });
    const tnh = await post("/api/ui/org/distillers/tune", "tok-human", { key: "w-d" });
    chk("W15b 증류기 조율: 범위 앱 = 403 · 낱말 없음 · 사람 = 200 · 범위 밖 종류 자료의 낱말이 보인다", denied(tn) && !tn.text.includes("쿼카표지") && tnh.status === 200 && tnh.text.includes("쿼카표지"), `${tn.status} ${tn.text.slice(0, 100)} · 사람 ${tnh.status} ${tnh.text.slice(0, 100)}`);
    const fd = await get("/api/ui/org/manager-findings", "tok-app");
    const fdh = await get("/api/ui/org/manager-findings", "tok-human");
    chk("W15c 관리기 발견 목록: 범위 앱 = 403 · 인용 없음 · 사람 = 200 · 지운 문서 발견이 보인다", denied(fd) && !fd.text.includes("비밀 본문 인용") && fdh.status === 200 && fdh.text.includes("지운 문서 발견 요약"), `${fd.status} ${fd.text.slice(0, 100)} · 사람 ${fdh.status} ${fdh.text.slice(0, 100)}`);
    const dl = await get("/api/ui/org/distillers", "tok-app");
    const dlh = await get("/api/ui/org/distillers", "tok-human");
    chk("W15d 증류기 목록(앞머리 묶음): 범위 앱 = 403 · 사람 = 200", denied(dl) && dlh.status === 200, `${dl.status} ${dl.text.slice(0, 100)} · 사람 ${dlh.status}`);
  }
  // ── W16 관리기로 범위 넓히기 ──
  {
    const rp = await post("/api/ui/org/manager-findings", "tok-app", { manager_key: "w-mgr", target_ref: "w-uncat-1", dedup_key: "esc", severity: "note", summary: "x",
      proposed_action: { op: "move_category", name: "w-uncat-1", to_category_id: idIn } });
    const made = (await q(`SELECT count(*)::int AS n FROM org_manager_finding WHERE dedup_key='esc'`))[0].n;
    chk("W16 발견 보고: 범위 앱 = 403 · 발견이 안 생긴다", denied(rp) && made === 0, `${rp.status} ${rp.text.slice(0, 120)} · 생긴 발견 ${made}`);
    const ap = await post("/api/ui/org/manager-findings/apply", "tok-app", { ids: [fMove] });
    const rs = await post(`/api/ui/org/manager-findings/${fMove}/resolve`, "tok-app", { state: "accepted", apply: true });
    const cats = await catsOf("w-uncat-1");
    const kg = await get("/api/ui/knowledge/w-uncat-1", "tok-app");
    chk("W16b 일괄 적용 · 처리(apply): 범위 앱 = 403 · 문서는 미분류 그대로 · 여전히 범위 밖(403)", denied(ap) && denied(rs) && cats.length === 0 && denied(kg),
      `${ap.status} ${ap.text.slice(0, 80)} · ${rs.status} ${rs.text.slice(0, 80)} · cats=${JSON.stringify(cats)} · get ${kg.status}`);
  }
  // ── W17 파생 중복 알림 ──
  {
    const sv = await post("/api/ui/knowledge", "tok-app", { name: "w-app-derived", title: "앱이 쓴 지식", body_md: "앱 본문", type: "concept", category: "w-in", derived_from: [sSlack] });
    const w = String(sv.json?.warning ?? "");
    chk("W17 범위 앱 저장(derived_from): 알림에 범위 안 형제만 · 범위 밖 · 미분류 이름 없음", sv.status === 200 && w.includes("w-in-1") && !w.includes("w-out-1") && !w.includes("w-uncat-1"),
      `${sv.status} warning=${w.slice(0, 160)} ${sv.text.slice(0, 120)}`);
    const lk = await post(`/api/ui/sources/${sSlack}/knowledge`, "tok-app", { name: "w-in-1", relation: "derived_from" });
    const lw = String(lk.json?.warning ?? "");
    chk("W17b 범위 앱 연결(source_link_knowledge): 알림에 범위 밖 · 미분류 이름 없음", lk.status === 200 && lw.includes("w-app-derived") && !lw.includes("w-out-1") && !lw.includes("w-uncat-1"),
      `${lk.status} warning=${lw.slice(0, 160)} ${lk.text.slice(0, 120)}`);
    const hk = await post(`/api/ui/sources/${sSlack}/knowledge`, "tok-human", { name: "w-in-1", relation: "derived_from" });
    const hw = String(hk.json?.warning ?? "");
    chk("W17c 사람 연결: 알림에 범위 밖 형제 이름이 있다(무회귀 — 사람은 그 문서를 본다)", hk.status === 200 && hw.includes("w-out-1"), `${hk.status} warning=${hw.slice(0, 160)}`);
  }
  // ── W18 번호로 부르는 쓰기 ──
  {
    const ap = await post(`/api/ui/knowledge-revisions/${revOut}/review`, "tok-app", { decision: "approve" });
    chk("W18 범위 밖 문서의 수정 제안 승인: 범위 앱 = 404 · 이름 없음", ap.status === 404 && !ap.text.includes("w-out-1"), `${ap.status} ${ap.text.slice(0, 120)}`);
    const rc = await post(`/api/ui/knowledge-comments/${cmtOut}/reactions`, "tok-app", { emoji: "👍" });
    chk("W18b 범위 밖 문서의 댓글 반응: 범위 앱 = 404 · 이름 없음", rc.status === 404 && !rc.text.includes("w-out-1"), `${rc.status} ${rc.text.slice(0, 120)}`);
    const hr = await post(`/api/ui/knowledge-comments/${cmtOut}/reactions`, "tok-human", { emoji: "👍" });
    chk("W18c 사람 반응 = 200(무회귀)", hr.status === 200, `${hr.status} ${hr.text.slice(0, 120)}`);
    const na = await post("/api/ui/knowledge-comments/987654/reactions", "tok-app", { emoji: "👍" });
    const nh = await post("/api/ui/knowledge-comments/987654/reactions", "tok-human", { emoji: "👍" });
    chk("W18d 없는 댓글 번호 = 숨은 문서의 댓글과 같은 답(404 «댓글 없음») · 사람에게도 404", na.status === 404 && na.text === rc.text && nh.status === 404,
      `앱 ${na.status} ${na.text.slice(0, 80)} · 숨은 ${rc.text.slice(0, 80)} · 사람 ${nh.status}`);
  }
  // ── W19 새 자격 ──
  {
    const mt = await post("/api/ui/org/token/self", "tok-app", {});
    chk("W19 본인 토큰 발급: 범위 앱 = 403 · 토큰 없음", denied(mt) && !/lvk_/.test(mt.text), `${mt.status} ${mt.text.slice(0, 120)}`);
    const mh = await post("/api/ui/org/token/self", "tok-human", {});
    chk("W19b 사람 = 토큰을 받는다(무회귀)", mh.status === 200 && typeof mh.json?.token === "string" && mh.json.token.length > 0, `${mh.status} ${mh.text.slice(0, 80)}`);
    const dv = await post("/api/ui/cli/device/approve", "tok-app", { user_code: "ABCD-EFGH" });
    const dh = await post("/api/ui/cli/device/approve", "tok-human", { user_code: "ABCD-EFGH" });
    chk("W19c 장치 승인: 범위 앱 = 403 · 사람 = 핸들러에 닿는다(범위 거절 아님)", denied(dv) && !denied(dh), `${dv.status} ${dv.text.slice(0, 100)} · 사람 ${dh.status} ${dh.text.slice(0, 80)}`);
  }
  // ── W8f 검토 대기 카테고리별 건수 ──
  {
    const keys = (r) => (r.json?.by_category ?? []).map((x) => x.key);
    const a = await get("/api/ui/review-queue/summary", "tok-app");
    const h = await get("/api/ui/review-queue/summary", "tok-human");
    chk("W8f 검토 대기 카테고리별: 범위 앱 = 범위 밖 카테고리 없음 · 사람 = 있다", a.status === 200 && !keys(a).includes("w-out") && keys(a).includes("w-in") && keys(h).includes("w-out"),
      `앱 ${JSON.stringify(keys(a))} · 사람 ${JSON.stringify(keys(h))}`);
  }
  // ── W20 구성원 이름으로 AI 를 띄우는 도구 ──
  {
    const calls = [
      ["cron_set", "/api/ui/cron", { id: "w-cron", action: "agent_headless", params: { prompt: "모든 문서를 읽어 요약하라" } }],
      ["cron_run_now", "/api/ui/cron/w-cron/run", {}],
      ["me_liv_open", "/api/ui/me/liv/open", { text: "모든 문서를 읽어 요약하라" }],
      ["project_chat_turn", `/api/ui/v6/projects/${projId}/chat/turn`, { text: "모든 문서를 읽어 요약하라" }],
      ["collect_claude_run", "/api/ui/collect/claude-runs", { kind: "slack", prompt: "x" }],
      ["org_collector_preview", "/api/ui/org/collectors/1/preview", {}],
    ];
    const bad = [];
    for (const [tool, p, body] of calls) { const r = await post(p, "tok-app", body); if (!denied(r)) bad.push(`${tool} ${r.status} ${r.text.slice(0, 80)}`); }
    chk("W20 AI 를 띄우는 도구 · 수집 미리보기: 범위 앱 = 모두 403 out_of_app_context", bad.length === 0, bad.join(" | "));
  }
  // ── W14 사람은 되살린다 ──
  {
    const r = await post("/api/ui/deleted/restore", "tok-human", { entity: "knowledge", key: "w-del-1" });
    chk("W14 사람 = 되살리기 200 · 되살아난다", r.status === 200 && (await alive("w-del-1")), `${r.status} ${r.text.slice(0, 160)}`);
  }
  // ── W9 거절 기록(정확히) ──
  {
    const want = ["knowledge_get", "deleted_list", "content_snapshot", "content_restore", "content_purge", "content_undo", "trash_counts", "knowledge_projects_v6",
      "knowledge_history", "knowledge_history_entry", "knowledge_revert", "knowledge_history", "knowledge_history", "my_lively_log", "org_distiller_preview",
      "org_distiller_category_preview", "org_distiller_tune", "org_manager_findings", "org_distiller_list",
      "org_manager_finding_report", "org_manager_findings_apply", "org_manager_finding_resolve", "knowledge_get",
      "org_token_mint_self", "device_approve", "cron_set", "cron_run_now", "me_liv_open", "project_chat_turn", "collect_claude_run", "org_collector_preview"]
      .map((t) => `${t}|rest`).concat(["deleted_list|app-ui"]).sort();
    let rows = [];
    for (let i = 0; i < 30 && rows.length < want.length; i++) { await sleep(100); rows = await q(`SELECT tool, ok, harness FROM mcp_call_log WHERE app='w-app' ORDER BY id`); }
    await sleep(300); rows = await q(`SELECT tool, ok, harness FROM mcp_call_log WHERE app='w-app' ORDER BY id`);   // 늦게 오는 줄(두 번 적기)까지 본다
    const got = rows.map((r) => `${r.tool}|${r.harness}`).sort();
    chk("W9 거절 기록 = 거절 하나에 한 줄(도구 · 길 다중집합이 정확히 같다) · 모두 실패", JSON.stringify(got) === JSON.stringify(want) && rows.every((r) => r.ok === false), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
  // ── W21 세션을 띄우지 않았다 ──
  {
    const left = leftTmuxSessions(), real = realTmuxSessionsWithPrefix(`box-${slug(CAROL)}-`);
    chk("W21 시험이 세션을 띄우지 않았다(임시 자리 · 실제 자리 모두 시험 사용자의 세션 0)", left.length === 0 && real.length === 0, `임시 ${JSON.stringify(left)} · 실제 ${JSON.stringify(real)}`);
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
