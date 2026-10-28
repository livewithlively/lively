// 앱 맥락 범위(#5100) — 훑기(canary sweep) PG 통합 테스트 — **실제 Postgres(pgvector) 필요**(.github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-context-sweep.pg-test.mjs
//
// 왜 따로인가: 범위를 못 지키는 길은 리뷰 때마다 «적어 둔 목록 밖의 형제» 로 나왔다(휴지통 → 이력 → 수정 제안 → 맥락 파이프라인). 길 이름을 적은
//  시험(app-context-rest.pg-test)은 적은 길만 잰다. 여기는 범위 밖 표지(canary)를 심고 진짜 Express 의 **모든** 능력 REST GET 길 · 읽기 전용
//  POST 길 · 맨 GET 길을 범위 앱 토큰으로 불러, 답에 표지가 실린 길을 이름으로 알린다 — 새 길이 생겨도 따로 적지 않고 재진다.
//  ⚠ 쓰기 POST 는 부르지 않는다(이 시험의 빈자리). 내용 · 이름을 돌려주는 쓰기 길은 app-context-rest.pg-test 가 짚은 것만 잰다 —
//   휴지통 · 실행 취소 · 이력 되돌리기 · 수정 제안 승인 · 댓글 반응 · 파생 중복 알림(저장 · 연결) · 관리기 보고 → 적용 · 새 토큰.
//   MCP 전용 도구(REST 가 없는 것)도 여기 안 든다 — 이름 목록(app-context-wiring C6)과 app-context.pg-test 가 잰다.
//
//  사양 · 엣지 표:
//   S1 범위 앱 토큰의 답(2xx 든 아니든)에 범위 밖 표지가 없다 — 내용 표지는 그대로, 이름 표지는 요청에 없던 것만 센다(요청한 이름을 «없음» 으로
//      되돌려주는 것은 새는 것이 아니다 · 번호만 보냈는데 이름이 오면 샌다). 예외는 항상-주입 문서(규칙 · 페르소나 섹션 — 범위와 무관하게 모든 세션에
//      들어간다)를 돌려주는 길(ALWAYS_OK)뿐이고, 그 길에도 항상-주입 표지 말고 다른 표지는 없어야 한다
//   S2 (배선) 표지마다 사람 토큰으로 그것이 보이는 길이 적어도 하나 있다 — 못 심은 표지로 «안 샌다» 고 통과하지 않게
//   S3 (배선) 부른 길이 충분하다 — 능력 GET 300개 이상 · 맨 GET 1개 이상 · 범위 앱이 2xx 를 받은 길 80개 이상(훑기가 조용히 아무것도 안 부르지 않게)
//   S4 범위 안 표지(지식 · 자료)는 범위 앱에도 보인다(범위가 통째로 닫혀서 S1 이 통과하는 것이 아니다)
//   S5 (배선) 표지마다 «사람은 보는데 범위 앱은 못 보는» 길이 적어도 하나 있다 — 그 표지에 대해 S1 이 실제로 무엇인가를 가렸다
import "../../scripts/test-apps-root.mjs";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_context_sweep_5100";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pgt-5100-sweep-"));
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
const { restMounts, capMutates, registry } = await import(`${D}/capabilities/index.js`);
const { slug } = await import(`${D}/terminal/profiles.js`);
const { logToolCall } = await import(`${D}/org/policies/tool-log.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const kCap = (n) => knowledgeCapabilities.find((c) => c.name === n);
let server;

//  항상-주입 문서를 돌려주는 길 — 그 문서의 표지만 허용한다(S1 예외).
const ALWAYS_OK = new Set(["org_overview", "org_sections", "org_preview", "org_hooks_preview"]);
const ALWAYS_CANARIES = ["SWPX-ALWAYS", "swpx-always"];

try {
  // ── 표지 심기: 범위 밖(카테고리 swp-out) · 지운 것 · 미분류 · 항상-주입 · 자료(범위 밖 종류 · 개인 폴더 파일) · 활동 · 프로젝트 · 사용 기록 · 파이프라인 ──
  const CAROL = "pgt-sw-carol", BOB = "pgt-sw-bob", OWNER = "pgt-sw-owner";
  await q(`INSERT INTO org_member(id,email,display_name) VALUES($1,'c@x',$1),($2,'b@x',$2),($3,'o@x',$3) ON CONFLICT DO NOTHING`, [CAROL, BOB, OWNER]);
  const cat = async (key) => Number((await q(`INSERT INTO category(key,name,should) VALUES($1,$1,$2) RETURNING id`, [key, key + " 정의"]))[0].id);
  const idIn = await cat("swp-in"), idOut = await cat("swp-out");
  const mkK = async (name, title, body, catId, summary = null) => {
    await q(`INSERT INTO knowledge(name,title,body_md,summary,injection,provenance,lifecycle,confidence,source,visibility) VALUES($1,$2,$3,$4,'recalled','authored','active','ai','authored','open')`, [name, title, body, summary]);
    if (catId) await q(`INSERT INTO knowledge_category(name,category_id,mapped_by,state) VALUES($1,$2,'manual','confirmed')`, [name, catId]);
  };
  const human = { userId: CAROL, email: "c@x", scopes: ["memory", "context"], projects: ["*"] };
  const adminUser = { ...human, scopes: ["memory", "context", "admin"] };
  const wctx = { source: "web", actor: CAROL, viewer: CAROL };
  await mkK("swpi-in", "SWPI-IN-TITLE", "SWPI-IN-BODY", idIn);
  await mkK("swpx-hid", "SWPX-K-TITLE", "SWPX-K-BODY", idOut, "SWPX-K-SUMMARY");
  await q(`INSERT INTO knowledge_link(from_name,to_name,relation,origin) VALUES('swpi-in','swpx-hid','related','user')`);
  await q(`INSERT INTO knowledge_comment(name,author,body) VALUES('swpx-hid',$1,'SWPX-K-COMMENT')`, [BOB]);
  await q(`INSERT INTO knowledge_revision(name,mode,status,new_body_md,proposed_by,note,new_title) VALUES('swpx-hid','staged','pending','SWPX-REV-BODY',$1,'SWPX-REV-NOTE','SWPX-REV-TITLE')`, [BOB]);
  //  감사 이력 — 사람이 범위 밖 문서를 한 번 고친다
  await kCap("knowledge_save").handler({ name: "swpx-hid", title: "SWPX-K-TITLE", body_md: "SWPX-K-BODY v2", type: "concept", category: "swp-out" }, human, wctx);
  //  지운 범위 밖 문서 + 그 문서의 수정 제안(지식을 지워도 남는다)
  await mkK("swpx-del", "SWPX-DEL-TITLE", "SWPX-DEL-BODY", idOut);
  await q(`INSERT INTO knowledge_revision(name,mode,status,new_body_md,proposed_by,new_title) VALUES('swpx-del','staged','pending','SWPX-DELREV-BODY',$1,'SWPX-DELREV-TITLE')`, [BOB]);
  await kCap("knowledge_delete").handler({ name: "swpx-del" }, human, wctx);
  await mkK("swpx-uncat", "SWPX-UNCAT-TITLE", "SWPX-UNCAT-BODY", null);
  await mkK("swpx-always", "SWPX-ALWAYS-TITLE", "SWPX-ALWAYS-BODY", idOut);
  await q(`UPDATE knowledge SET injection='always' WHERE name='swpx-always'`);
  //  자료 — 범위 안 종류(slack) · 범위 밖 종류(email) · 개인 폴더 파일(local_file — 맨 길 /sources/:id/original)
  const sIn = Number((await q(`INSERT INTO source(name,kind,title,body_md,lifecycle,occurred_at) VALUES('swp-s-in','slack','SWPI-S-TITLE','SWPI-S-BODY','active',now()) RETURNING id`))[0].id);
  const sOut = Number((await q(`INSERT INTO source(name,kind,title,body_md,lifecycle,occurred_at) VALUES('swp-s-out','email','SWPX-S-TITLE','SWPX-S-BODY','active',now()) RETURNING id`))[0].id);
  await q(`INSERT INTO knowledge_source(name,source_id,relation) VALUES('swpi-in',$1,'derived_from'),('swpx-hid',$2,'derived_from')`, [sIn, sOut]);
  //  엇갈린 이웃 — 범위 밖 문서가 범위 안 자료에서 · 범위 안 문서가 범위 밖 종류 자료에서 나왔다 · 범위 밖 문서가 범위 안 문서를 가리킨다(역링크)
  await q(`INSERT INTO knowledge_source(name,source_id,relation) VALUES('swpx-hid',$1,'cites'),('swpi-in',$2,'cites')`, [sIn, sOut]);
  await q(`INSERT INTO knowledge_link(from_name,to_name,relation,origin) VALUES('swpx-hid','swpi-in','related','user')`);
  const pdir = path.join(TMP, "personal", slug(OWNER), "uploads");
  fs.mkdirSync(pdir, { recursive: true }); fs.writeFileSync(path.join(pdir, "secret.txt"), "SWPX-LOCAL-FILE-CONTENT");
  const sLocal = Number((await q(`INSERT INTO source(name,kind,title,body_md,lifecycle,occurred_at,external_system,external_instance,external_id,provenance)
    VALUES('swp-s-local','local_file','SWPX-LOCAL-TITLE','[BINARY]','active',now(),'local','default',$1,'observed') RETURNING id`, [`personal:${OWNER}/uploads/secret.txt`]))[0].id);
  //  활동 · 프로젝트의 지식 참조
  const actId = Number((await q(`INSERT INTO activity(type,title,summary,body,author_person,created_at) VALUES('docs','작업','요약','본문',$1,now()) RETURNING id`, [CAROL]))[0].id);
  await q(`INSERT INTO activity_knowledge(activity_id,name,relation) VALUES($1,'swpx-hid','produced')`, [actId]);
  const projId = Number((await q(`INSERT INTO project(name,level,status,created_by) VALUES('swp-project','project','active',$1) RETURNING id`, [CAROL]))[0].id);
  await q(`INSERT INTO project_knowledge(project_id,name,relation) VALUES($1,'swpx-hid','required')`, [projId]);
  //  사용 기록 — 그 사람이 범위 밖 문서를 연 호출
  logToolCall({ tool: "knowledge_get", harness: "claude-code", actor: CAROL, args: { name: "swpx-hid" }, ok: true, durationMs: 5 });
  //  맥락 파이프라인 — 카테고리 붙이기 레인(미분류 지식을 본다) · 관리기 발견(있는 범위 밖 문서 · 지운 문서)
  await registry.get("org_distiller_category_upsert").handler({ key: "swp-lane", label: "swp lane", enabled: true }, adminUser, wctx);
  const mgrId = Number((await q(`INSERT INTO org_manager(key,label,kind,enabled) VALUES('swp-mgr','swp','contradiction',true) RETURNING id`))[0].id);
  const fId = Number((await q(`INSERT INTO org_manager_finding(manager_id,kind,target_kind,target_ref,dedup_key,severity,summary,evidence) VALUES
    ($1,'contradiction','knowledge','swpx-hid','f1','warn','SWPX-FINDING-SUMMARY','SWPX-FINDING-EVIDENCE'),
    ($1,'contradiction','knowledge','swpx-del','f2','warn','SWPX-DELFINDING-SUMMARY','SWPX-DELFINDING-EVIDENCE') RETURNING id`, [mgrId]))[0].id);
  await new Promise((r) => setTimeout(r, 400));   // 사용 기록(fire-and-forget)이 들어가게
  const audit = Number((await q(`SELECT id FROM org_content_audit WHERE entity='knowledge' AND entity_key='swpx-hid' ORDER BY id DESC LIMIT 1`))[0]?.id ?? 1);
  const delAudit = Number((await q(`SELECT id FROM org_content_audit WHERE entity='knowledge' AND entity_key='swpx-del' AND op='delete' ORDER BY id DESC LIMIT 1`))[0]?.id ?? 1);
  const revId = Number((await q(`SELECT id FROM knowledge_revision WHERE name='swpx-hid'`))[0].id);
  const delRevId = Number((await q(`SELECT id FROM knowledge_revision WHERE name='swpx-del'`))[0].id);

  //  범위를 선언한 앱 — 도구 전부(*) · scope 다섯 · 범위 = swp-in + slack
  const bob = { userId: BOB, email: "b@x", scopes: ["memory"], projects: ["*"] };
  const files = [
    { path: "lively-app.json", content: JSON.stringify({ id: "swp-app", title: "swp", version: "1.0.0", permissions: { scopes: ["memory"], tools: ["*"] }, context: { knowledge_categories: ["swp-in"], source_kinds: ["slack"] }, ui: { pages: [{ key: "main", title: "swp", entry: "ui/index.html" }] } }) },
    { path: "ui/index.html", content: "<p>x</p>" },
  ];
  const saved = await appCapabilities.find((c) => c.name === "app_save").handler({ files }, bob, { source: "mcp" });
  if (saved?.error) throw new Error(`app_save: ${saved.error}`);
  await appCapabilities.find((c) => c.name === "app_visibility_set").handler({ app_id: "swp-app", visibility: "all" }, bob, { source: "mcp" });
  const SC = ["memory", "context", "items", "db", "code"];
  await upsertGrant("swp-app", CAROL, SC, ["*"], {});

  // ── 진짜 Express — 범위 앱 토큰 · 사람 토큰 ──
  const users = {
    "tok-app": { userId: CAROL, email: "c@x", scopes: SC, projects: ["*"], tokenSource: "db", appId: "swp-app" },
    "tok-human": { userId: CAROL, email: "c@x", scopes: SC, projects: ["*"], tokenSource: "db" },
  };
  const verifier = { verifyAccessToken: async (t) => { const u = users[t]; if (!u) throw new Error("bad token"); return { token: t, clientId: "x", scopes: u.scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: u }; } };
  const app = express(); app.use(express.json());
  registerWebUi(app, verifier);
  registerTerminalFiles(app, verifier);
  server = http.createServer(app); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const call = async (method, p, tok, body) => {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      return { status: r.status, text: await r.text() };
    } catch (e) { return { status: -1, text: String(e?.message ?? e) }; } finally { clearTimeout(to); }
  };

  const NAME_CANARIES = ["swpx-hid", "swpx-del", "swpx-uncat", "swpx-always"];   // 이름 — 요청에 없던 것만 센다(S1)
  const CANARIES = ["SWPX-K-TITLE", "SWPX-K-BODY", "SWPX-K-SUMMARY", "SWPX-K-COMMENT", "SWPX-REV", "SWPX-DEL-TITLE", "SWPX-DEL-BODY", "SWPX-DELREV",
    "SWPX-UNCAT", "SWPX-S-TITLE", "SWPX-S-BODY", "SWPX-LOCAL", "SWPX-FINDING", "SWPX-DELFINDING", "SWPX-ALWAYS", ...NAME_CANARIES];
  const hits = (text, req) => CANARIES.filter((c) => text.includes(c) && !(NAME_CANARIES.includes(c) && req.includes(c)));
  //  길 변수 — 이름은 범위 밖 · 지운 · 미분류 문서 셋, 이력 번호는 (문서, 그 문서의 감사 행) 짝, :id 는 심은 행 번호들
  const ids = [sOut, sLocal, sIn, projId, idOut, revId, delRevId, actId, fId, mgrId, audit, delAudit, 1];
  const rest = (p) => p.replace(/:key\b/g, "swp-lane").replace(/:repo\b/g, "x").replace(/:kind\b/g, "email").replace(/:system\b/g, "slack")
    .replace(/:tid\b/g, "1").replace(/:fieldId\b/g, "1");
  const variants = (p) => {
    let out = /:audit_id\b/.test(p)
      ? [["swpx-hid", audit], ["swpx-del", delAudit]].map(([n, a]) => p.replace(/:name\b/g, n).replace(/:audit_id\b/g, String(a)))
      : /:name\b/.test(p) ? ["swpx-hid", "swpx-del", "swpx-uncat", "swpi-in"].map((n) => p.replace(/:name\b/g, n)) : [p];
    out = out.map(rest);
    return /:id\b/.test(p) ? out.flatMap((v) => ids.map((i) => v.replace(/:id\b/g, String(i)))) : out;
  };
  //  쿼리는 두 벌 — 레인 · 범위 밖 문서를 가리키는 것, 지운 문서를 가리키는 것(휴지통 미리보기 등 key=이름 길)
  const QSS = ["q=SWPX&text=SWPX%20K%20BODY&name=swpx-hid&limit=50&entity=knowledge&key=swp-lane&since=2020-01-01T00:00:00Z&window=30d&status=pending",
    "q=SWPX&name=swpx-del&limit=50&entity=knowledge&key=swpx-del&since=2020-01-01T00:00:00Z&window=all"];
  const BODY = { key: "swp-lane", name: "swpx-hid", q: "SWPX", text: "SWPX K BODY", limit: 50, entity: "knowledge" };

  const leaks = new Map();   // "도구 길" → 표지
  const humanSeen = new Set(), scopeHid = new Set();
  let appOk = 0, capGets = 0, bareGets = 0, posts = 0;
  const appSawIn = new Set(), appSawInSource = new Set();
  const probe = async (capName, method, url, body) => {
    const req = url + (body ? JSON.stringify(body) : "");
    const a = await call(method, url, "tok-app", body);
    const h = await call(method, url, "tok-human", body);
    const humanHits = h.status >= 200 && h.status < 300 ? hits(h.text, req) : [];
    for (const c of humanHits) humanSeen.add(c);
    let found = hits(a.text, req);
    for (const c of humanHits) if (!found.includes(c)) scopeHid.add(c);
    if (a.status >= 200 && a.status < 300) {
      appOk++;
      if (a.text.includes("SWPI-IN-TITLE")) appSawIn.add(capName);
      if (a.text.includes("SWPI-S-TITLE")) appSawInSource.add(capName);
    }
    if (ALWAYS_OK.has(capName)) found = found.filter((c) => !ALWAYS_CANARIES.includes(c));
    if (found.length) leaks.set(`${capName} ${method} ${url.replace(/\?.*$/, "")} (${a.status})`, found);
  };

  //  ① 능력 REST GET · ② 읽기 전용 능력 POST
  const capPaths = new Set();
  for (const { cap, mount } of restMounts()) {
    for (const p of mount.paths) {
      capPaths.add(`${mount.method} ${p}`);
      if (mount.method === "GET") {
        for (const v of variants(p)) for (const qs of QSS) { capGets++; await probe(cap.name, "GET", v + (v.includes("?") ? "&" : "?") + qs); }
      } else if (mount.method === "POST" && !capMutates(cap)) {
        for (const v of variants(p)) { posts++; await probe(cap.name, "POST", v, BODY); }
      }
    }
  }
  //  ③ 맨 GET 길(능력 어댑터 밖 — 인증 문이 범위를 물려준다)
  for (const layer of app._router.stack) {
    const r = layer.route;
    if (!r || !r.methods?.get || typeof r.path !== "string" || !r.path.startsWith("/api/")) continue;
    if (capPaths.has(`GET ${r.path}`)) continue;
    for (const v of variants(r.path)) for (const qs of QSS) { bareGets++; await probe("(맨 길)", "GET", v + (v.includes("?") ? "&" : "?") + qs); }
  }

  console.log(`  부른 길: 능력 GET ${capGets} · 읽기 전용 POST ${posts} · 맨 GET ${bareGets} · 범위 앱 2xx ${appOk}`);
  chk("S1 범위 앱 토큰의 답에 범위 밖 표지가 없다(항상-주입 문서의 길 예외 · 이름은 요청에 없던 것만)", leaks.size === 0,
    [...leaks].map(([k, v]) => `\n     ${k} → ${v.join(",")}`).join(""));
  const unseen = CANARIES.filter((c) => !humanSeen.has(c));
  chk("S2 (배선) 표지마다 사람 토큰으로 보이는 길이 있다", unseen.length === 0, `사람에게도 안 보인 표지: ${unseen.join(", ")}`);
  chk("S3 (배선) 부른 길이 충분하다(능력 GET ≥ 300 · 맨 GET ≥ 1 · 범위 앱 2xx ≥ 80)", capGets >= 300 && bareGets >= 1 && appOk >= 80, `능력 GET ${capGets} · 맨 GET ${bareGets} · 2xx ${appOk}`);
  chk("S4 범위 안 표지(지식 · 자료)는 범위 앱에도 보인다", appSawIn.size > 0 && appSawInSource.size > 0, `지식 ${appSawIn.size} · 자료 ${appSawInSource.size}`);
  const notHidden = CANARIES.filter((c) => !scopeHid.has(c));
  chk("S5 (배선) 표지마다 사람은 보는데 범위 앱은 못 보는 길이 있다", notHidden.length === 0, `범위가 한 번도 가리지 않은 표지: ${notHidden.join(", ")}`);
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
