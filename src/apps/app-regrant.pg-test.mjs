// 예전 범위 동의 → «다시 동의»(#1644) PG 통합 시험 — **실제 Postgres 필요**(CI 의 pg 잡이 run-tests --pg 로 자동 수집).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-regrant.pg-test.mjs
//
// 왜 이 계층인가: «동의가 앱의 지금 선언을 덮나» 는 DB 의 사실(설치된 판 · 공개 판 · 동의 행 · 구성원 권한)을 겹쳐 읽는 판정이고, 그 거절은 진짜 문
//  (능력 REST 의 scope 문 · 앱 도구 게이트 · 앱 화면 다리)에서 나야 앱 서버가 받는다. 그래서 진짜 게이트웨이 REST(registerWebUi · 앱 서버 토큰 ·
//  서명된 사람 신원)에 앱 서버처럼 부르고, 앱 판을 실제 설치 능력으로 넓혀 가며 잰다(사양 표: 스크래치패드 spec-1644 — 이슈 본문 · 댓글).
//  Q1 앱 서버 · 도구만 새로 선언(ai_runs) → 403 consent_required · 앱 화면 다리와 같은 글 + 동의할 곳 · consent_url(앱 화면 꼴) · missing
//  Q2 선언 밖 도구 → 종전 «앱 권한 밖»(표지 없음) · Q2b 예전에 동의한 도구는 그대로 200(넓은 거절이 아니다) · Q3 동의를 거둔 앱 토큰 → 종전 «앱 권한 밖»
//  Q4 앱 서버 · scope 만 새로 선언(context) → 403 consent_required «'context' 권한을» · Q4b 그 scope 가 없는 구성원 → 종전 forbidden · Q5 사람 토큰 → 종전 forbidden
//  R1 앱 화면 다리 · scope 만 새로 → consent_required · R2 도구만 새로 → consent_required(#4225) · R3 구성원에게 없는 scope → 종전 Forbidden · R4 다시 동의 뒤 통과
//  T1 다시 동의 뒤 새 앱 토큰(작업 AI 의 토큰과 같은 발급)은 scope 가 넓어진다 · A 시작 전 판정(launchConsentGap) 실 DB · 동의 자리 꼴
//  X 주소의 판(공개)과 그 사람이 다시 동의하는 판(초안)이 다르면 다시 동의로 못 얻는 것은 «다시 동의» 로 말하지 않는다(끝없이 도는 안내를 막는다)
//  P9 이 코어가 못 읽는 매니페스트 — 다시 동의도 막히니 scope 로 «다시 동의» 를 내지 않는다(격리 리뷰)
//  G 배선 — 시험 서명 키 · 앱 서버 토큰 · 진짜 문을 탔다
import "../../scripts/test-apps-root.mjs";   // 앱 폴더 자리를 임시 폴더로 — 앱을 깔고 지우는 시험이 실제 ~/apps 를 건드리지 않게
import pg from "pg";
import http from "node:http";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_regrant_1644";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "PUBLIC_URL"]) delete process.env[k];

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const ID = await import(`${D}/apps/app-identity.js`);
const KEY = ID.ed25519FromSeed(Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"));
process.env.LIVELY_APP_IDENTITY_PUBKEYS = JSON.stringify({ "test-1": KEY.publicKeyB64 });

const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const express = (await import("express")).default;
const { registerWebUi } = await import(`${D}/web.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { mintToken } = await import(`${D}/org/store/tokens.js`);
const { mintAppServerToken } = await import(`${D}/apps/app-server-auth.js`);
const { mintAppToken, requireAppTool, _clearAppToolCache } = await import(`${D}/apps/principal.js`);
const { runAppTool } = await import(`${D}/capabilities/app-tool-call.js`);
const { launchConsentGap, calledFromAppScreen } = await import(`${D}/apps/app-consent-gap.js`);
const { AI_RUN_TOOLS } = await import(`${D}/apps/manifest.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const cap = (n) => appCapabilities.find((c) => c.name === n);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const J = (x) => JSON.stringify(x);
const SINGLE = "00000000-0000-0000-0000-000000000000";
const nowS = () => Math.floor(Date.now() / 1000);
const identity = (sub, app, v = "pub") => ID.signAppIdentity({ ws: SINGLE, app, var: v, sub, name: sub, iat: nowS(), exp: nowS() + 600 }, KEY.privateKey, "test-1");
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const servers = [];
const listen = (app) => new Promise((resolve) => { const s = http.createServer(app); servers.push(s); s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${s.address().port}`)); });

const SC = { alice: ["memory", "context", "items"], nocx: ["memory", "items"], carl: ["memory", "context", "items"], dana: ["memory", "context", "items"],
  admin: ["admin", "memory", "context", "items"] };
const P = (id) => ({ userId: id, email: `${id}@x.invalid`, scopes: SC[id], projects: ["*"] });
const ctx = { source: "mcp" };
const manifest = (id, perms, extra = {}) => ({ id, title: id === "policy" ? "정책 앱" : id, version: "0.1.0", permissions: perms, ...extra });
const install = (m) => cap("org_app_install").handler({ source: { kind: "inline", files: [{ path: "lively-app.json", content: J(m) }] } }, P("admin"), ctx);
const save = (who, m) => cap("app_save").handler({ files: [{ path: "lively-app.json", content: J(m) }] }, P(who), ctx);
const grant = (who, app) => cap("me_app_grant").handler({ app_id: app }, P(who), ctx);
const revoke = (who, app) => cap("me_app_revoke").handler({ app_id: app }, P(who), ctx);
const grantRow = async (who, app) => (await itemsPool.query(`SELECT scopes, tools FROM org_app_grant WHERE app_id=$1 AND member_id=$2 AND revoked_at IS NULL`, [app, who])).rows[0] ?? null;
//  앱 도구 게이트는 동의의 도구 목록을 5초 기억한다(principal grantTools) — 판을 바꾸거나 다시 동의한 바로 뒤에 재려면 비운다.
const fresh = () => _clearAppToolCache();

try {
  for (const [id, sc] of Object.entries(SC)) await upsertMember({ id, display_name: id, state: "active", scopes: sc }, "pgt");

  // ── 판 1 — scope memory · 도구 셋(category_list 는 scope context 가 있어야 돈다 · 판 1 은 context 를 선언하지 않았다) ──
  const V1 = { scopes: ["memory"], tools: ["store_tables", "project_list_v6", "category_list"] };
  await install(manifest("policy", V1));
  for (const m of ["alice", "nocx", "carl"]) await grant(m, "policy");
  const { token: appToken } = await mintAppServerToken("policy", "admin");

  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  const verifier = new BearerVerifier();
  registerWebUi(gw, verifier);
  const GW = await listen(gw);
  process.env.PUBLIC_URL = GW;   // 동의 자리의 base(org 프로필 gateway_url 이 비어 있으면 PUBLIC_URL)

  /** 앱 서버처럼 부른다 — 앱 서버 토큰 + 앞단이 서명한 그 사람의 신원(사람이 앱 화면에서 누른 요청과 같은 길). */
  const asApp = async (sub, path, { app = "policy", v = "pub", token = appToken } = {}) => {
    const r = await fetch(GW + path, { headers: { authorization: `Bearer ${token}`, "x-lively-identity": identity(sub, app, v) } });
    let body = null; try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  };
  const asPerson = async (token, path) => { const r = await fetch(GW + path, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const appUrl = (app, v = "pub") => `${GW}/ui/#/app-grant/${app}?v=${v}`;
  const mcpUrl = (app, v = "pub") => `${GW}/ui/#/app-grant/${app}?v=${v}&from=mcp`;

  const g0 = await asApp("alice", "/api/ui/v6/projects");
  chk("G0 배선 — 앱 서버 토큰 + 서명된 신원으로 진짜 능력 REST 에 닿는다(판 1 · 동의한 도구 200)", g0.status === 200, J(g0));
  const base1 = await asApp("alice", "/api/ui/ai-targets");
  chk("G1 판 1 — 선언하지 않은 도구는 종전 «앱 권한 밖»(표지 없음)", base1.status === 403 && /앱 권한 밖/.test(base1.body?.error ?? "") && base1.body?.code === undefined, J(base1));
  const base2 = await asApp("alice", "/api/ui/categories");
  chk("G2 판 1 — 선언하지 않은 scope(context)는 종전 forbidden(표지 없음 — 다시 동의해도 못 얻는다)",
    base2.status === 403 && /forbidden: 'context'/.test(base2.body?.error ?? "") && base2.body?.code === undefined, J(base2));

  // ── 판 2 — 도구만 넓힌다(permissions.ai_runs → AI 실행 도구 다섯 · 이슈 본문의 실측 그대로) ──
  await install(manifest("policy", { ...V1, ai_runs: true }));
  fresh();
  const q1 = await asApp("alice", "/api/ui/ai-targets");
  chk("Q1 앱 서버 · 도구만 새로 선언 → 403 consent_required · 앱 화면 다리와 같은 글 + 동의할 곳 · consent_url(앱 화면 꼴) · missing(AI 실행 도구 다섯)",
    q1.status === 403 && q1.body?.code === "consent_required"
      && /^앱 'policy' 의 사용 동의가 예전 범위라 'app_ai_targets' 을 쓸 수 없습니다 — 다시 동의\(grant\)하면 됩니다\. 동의할 곳: /.test(q1.body?.error ?? "")
      && q1.body?.consent_url === appUrl("policy") && String(q1.body?.error).endsWith(appUrl("policy"))
      && J(q1.body?.missing?.scopes) === "[]" && AI_RUN_TOOLS.every((t) => q1.body?.missing?.tools?.includes(t)) && q1.body?.missing?.tools?.length === AI_RUN_TOOLS.length,
    J(q1));
  const q2 = await asApp("alice", "/api/ui/activity/list");
  chk("Q2 선언 밖 도구(activity_list) → 종전 «앱 권한 밖» · 표지 · 주소 없음", q2.status === 403 && /앱 권한 밖/.test(q2.body?.error ?? "") && q2.body?.code === undefined && !("consent_url" in (q2.body ?? {})), J(q2));
  const q2b = await asApp("alice", "/api/ui/v6/projects");
  chk("Q2b 예전에 동의한 도구는 그대로 200 — 막힌 자리에서만 말한다(넓은 거절이 아니다)", q2b.status === 200, J(q2b));

  const r2 = await errOf(runAppTool(P("alice"), "policy", "app_ai_targets", {}, { source: "app-ui" }));
  chk("R2 앱 화면 다리 · 도구만 새로 → 403 consent_required «'app_ai_targets' 을»(#4225 그대로) · missing",
    r2?.status === 403 && r2?.body?.code === "consent_required" && /'app_ai_targets' 을 쓸 수 없습니다 — 다시 동의\(grant\)/.test(r2?.message ?? "")
      && r2?.body?.missing?.tools?.includes("app_ai_targets"), J({ m: r2?.message, b: r2?.body }));

  //  동의를 거둔 앱 토큰(앱 세션 · 작업 AI 의 토큰과 같은 발급) — 동의가 없으면 «다시 동의» 로 말하지 않는다(그 판정은 동의가 있는 사람의 것).
  const carlTok = (await mintAppToken("carl", "policy", "pgt")).token;
  const carlUser = (await verifier.verifyAccessToken(carlTok)).extra;
  await revoke("carl", "policy");
  fresh();
  const q3 = await errOf(requireAppTool(carlUser, "app_ai_targets"));
  chk("Q3 동의를 거둔 앱 토큰 → 종전 «앱 권한 밖» · 표지 없음", q3?.status === 403 && /앱 권한 밖/.test(q3?.message ?? "") && q3?.body?.code === undefined, J({ m: q3?.message, b: q3?.body }));

  await grant("alice", "policy");
  fresh();
  const q1b = await asApp("alice", "/api/ui/ai-targets");
  const g2row = await grantRow("alice", "policy");
  chk("R4a 다시 동의(선언 전체) 뒤 같은 호출이 통과한다 — 동의 행에 AI 실행 도구가 들어갔다",
    q1b.status === 200 && AI_RUN_TOOLS.every((t) => g2row?.tools?.includes(t)), J({ q1b: q1b.status, b: q1b.body?.error, g2row }));
  const r2b = await errOf(runAppTool(P("alice"), "policy", "app_ai_targets", {}, { source: "app-ui" }));
  chk("R4b 다시 동의 뒤 앱 화면 다리도 통과", r2b === null, String(r2b?.message));

  // ── 판 3 — scope 만 넓힌다(context · 댓글의 «범위만 새로 얻은 판» — 앱이 db 를 얻은 것과 같은 모양) ──
  await install(manifest("policy", { ...V1, ai_runs: true, scopes: ["memory", "context"] }));
  fresh();
  const tokBefore = (await verifier.verifyAccessToken((await mintAppToken("alice", "policy", "pgt")).token)).extra;
  const q4 = await asApp("alice", "/api/ui/categories");
  chk("Q4 앱 서버 · scope 만 새로 선언 → 403 consent_required «'context' 권한을» · consent_url · missing = scope context 하나",
    q4.status === 403 && q4.body?.code === "consent_required" && /예전 범위라 'context' 권한을 쓸 수 없습니다 — 다시 동의\(grant\)/.test(q4.body?.error ?? "")
      && q4.body?.consent_url === appUrl("policy") && J(q4.body?.missing) === J({ scopes: ["context"], tools: [] }), J(q4));
  const q4b = await asApp("nocx", "/api/ui/categories");
  chk("Q4b 그 scope 가 없는 구성원(nocx · 판 1 동의) → 종전 forbidden — 다시 동의해도 못 얻는 것은 묻지 않는다",
    q4b.status === 403 && /forbidden: 'context'/.test(q4b.body?.error ?? "") && q4b.body?.code === undefined, J(q4b));
  const nocxTok = (await mintToken({ userId: "nocx", memberId: "nocx", scopes: SC.nocx }, "pgt")).token;
  const q5 = await asPerson(nocxTok, "/api/ui/categories");
  chk("Q5 앱 주체가 아닌 사람 토큰 → 종전 forbidden(무회귀)", q5.status === 403 && /forbidden: 'context'/.test(q5.body?.error ?? "") && q5.body?.code === undefined, J(q5));

  const r1 = await errOf(runAppTool(P("alice"), "policy", "category_list", {}, { source: "app-ui" }));
  chk("R1 앱 화면 다리 · scope 만 새로 → 403 consent_required «'context' 권한을» — 종전엔 Forbidden 이라 화면이 동의 창을 못 띄웠다",
    r1?.status === 403 && r1?.body?.code === "consent_required" && /'context' 권한을 쓸 수 없습니다 — 다시 동의\(grant\)/.test(r1?.message ?? "")
      && J(r1?.body?.missing) === J({ scopes: ["context"], tools: [] }), J({ m: r1?.message, b: r1?.body }));
  const r3 = await errOf(runAppTool(P("nocx"), "policy", "category_list", {}, { source: "app-ui" }));
  chk("R3 앱 화면 다리 · 구성원에게 없는 scope → 종전 Forbidden(동의 표지 없음)", !!r3 && /Forbidden: .*'context'/.test(r3.message) && r3?.body?.code === undefined, String(r3?.message));

  const a1 = await launchConsentGap(P("alice"), "policy", "alice");
  const a1s = await launchConsentGap({ ...P("alice"), appId: "policy", appServer: true, appAddress: "pub" }, "policy", "alice");
  const a1n = await launchConsentGap(P("nocx"), "policy", "nocx");
  chk("A1 시작 전 판정(실 DB) — 덮지 못한 것 = scope context · 동의 자리는 부른 자리 꼴(사람·AI = from=mcp · 앱 화면의 앱 서버 = 앱 주소로 돌아가는 꼴)",
    J(a1?.missing) === J({ scopes: ["context"], tools: [] }) && a1?.consent_url === mcpUrl("policy") && a1s?.consent_url === appUrl("policy"), J({ a1, a1s }));
  chk("A1b 그 scope 가 없는 구성원은 판 1 동의의 도구 갈래만 남는다(AI 실행 도구 다섯) — scope 는 묻지 않는다",
    J(a1n?.missing?.scopes) === "[]" && AI_RUN_TOOLS.every((t) => a1n?.missing?.tools?.includes(t)), J(a1n));

  await grant("alice", "policy");
  fresh();
  const tokAfter = (await verifier.verifyAccessToken((await mintAppToken("alice", "policy", "pgt")).token)).extra;
  chk("T1 다시 동의 뒤 새 앱 토큰(작업 AI 의 토큰과 같은 발급)은 scope 가 넓어진다 — 앞 토큰엔 context 가 없었다",
    !tokBefore.scopes.includes("context") && tokAfter.scopes.includes("context"), J({ before: tokBefore.scopes, after: tokAfter.scopes }));
  const q4c = await asApp("alice", "/api/ui/categories");
  const r1b = await errOf(runAppTool(P("alice"), "policy", "category_list", {}, { source: "app-ui" }));
  const a2 = await launchConsentGap(P("alice"), "policy", "alice");
  chk("R4c 다시 동의 뒤 — 앱 서버 200 · 앱 화면 다리 통과 · 시작 전 판정 null", q4c.status === 200 && r1b === null && a2 === null, J({ q4c: q4c.status, r1b: r1b?.message, a2 }));

  // ── 동의 자리 꼴 — 앱 화면에서 온 호출인가(겉모양뿐 · 권한 판정 아님) ──
  const srcOf = (s) => async () => s;
  const cases = [
    [{ ...P("alice"), appId: "policy" }, undefined, false, "앱 토큰 · 앱 화면 다리(앱 서버 주체 아님)"],
    [{ ...P("alice"), appId: "policy", appServer: true, appAddress: "pub" }, undefined, true, "앞단이 서명한 신원(주소의 판)"],
    [{ ...P("alice"), appId: "policy", appServer: true, appAddress: "pub", appCallId: 7 }, undefined, false, "앱 선언 MCP 도구 부르기"],
    [{ ...P("alice"), appId: "policy", appServer: true }, undefined, false, "앱 서버 급 토큰(작업 AI — 주소 없음)"],
    ...["app-ui", "app-front", "app-server"].map((s) => [{ ...P("alice"), appId: "policy", appServer: true, appAddress: "pub", appJobId: 9 }, srcOf(s), true, `작업 source ${s}`]),
    ...["mcp-tool", "mcp", "slack-bridge", "app-job", null].map((s) => [{ ...P("alice"), appId: "policy", appServer: true, appAddress: "pub", appJobId: 9 }, srcOf(s), false, `작업 source ${s}`]),
  ];
  const bad = [];
  for (const [u, js, want, label] of cases) if ((await calledFromAppScreen(u, js)) !== want) bad.push(label);
  chk("A2 동의 자리 꼴 — 앞단 서명 신원 · 화면이 시작한 작업만 앱 주소로 돌아가는 꼴, 그 밖(도구 부르기 · 작업 AI · MCP · 슬랙 · 작업 안의 작업)은 from=mcp", bad.length === 0, J(bad));

  // ── P9 이 코어가 못 읽는 매니페스트(제목 · 판 칸 없음) — scope 로 «다시 동의» 를 내지 않는다(다시 동의도 같은 파서로 막혀 풀리지 않는다) ──
  await itemsPool.query(`INSERT INTO org_app(id, title, version, manifest, source, content_hash, status, enabled, current_version_no)
     VALUES('broken','깨진 앱','0.1.0',$1::jsonb,'{"kind":"inline"}'::jsonb,'hb','active',true,1)`,
    [J({ id: "broken", permissions: { scopes: ["memory", "context"], tools: ["category_list"] } })]);
  await itemsPool.query(`INSERT INTO org_app_grant(app_id, member_id, scopes, tools) VALUES('broken','alice','["memory"]'::jsonb,'["category_list"]'::jsonb)`);
  const regrantBroken = await errOf(grant("alice", "broken"));
  const p9 = await errOf(runAppTool(P("alice"), "broken", "category_list", {}, { source: "app-ui" }));
  chk("P9 못 읽는 매니페스트 — 다시 동의는 막히고(파서) 앱 화면 다리는 종전 Forbidden(동의 표지 없음 — 풀리지 않는 «다시 동의» 를 내지 않는다)",
    regrantBroken?.status === 400 && !!p9 && /Forbidden: .*'context'/.test(p9.message) && p9?.body?.code === undefined, J({ g: regrantBroken?.message, m: p9?.message, b: p9?.body }));

  // ── X 주소의 판 ≠ 다시 동의하는 판 — 공개 앱(공개 판: 도구 둘)에 다나의 초안(도구 하나 — project_list_v6 를 뺐다)이 걸렸다 ──
  await install(manifest("wiki2", { scopes: ["memory"], tools: ["store_tables", "project_list_v6"] }));
  await save("dana", manifest("wiki2", { scopes: ["memory"], tools: ["store_tables"] }));
  const w2 = (await itemsPool.query(`SELECT visibility, draft_by, published_version_no FROM org_app WHERE id='wiki2'`)).rows[0];
  await grant("dana", "wiki2");
  const danaRow = await grantRow("dana", "wiki2");
  const { token: wikiToken } = await mintAppServerToken("wiki2", "admin");
  fresh();
  const x1 = await asApp("dana", "/api/ui/v6/projects", { app: "wiki2", v: "pub", token: wikiToken });
  chk("X0 배선 — 공개 앱에 다나의 초안이 걸렸고 다나의 동의는 초안 판으로 쓰였다(project_list_v6 없음)",
    w2?.visibility === "all" && w2?.draft_by === "dana" && w2?.published_version_no != null && J(danaRow?.tools) === J(["store_tables"]), J({ w2, danaRow }));
  chk("X1 공개 주소로 온 앱 서버가 공개 판에만 있는 도구를 부르면 «다시 동의» 가 아니다 — 다나가 다시 동의해도 초안 판으로 쓰여 못 얻는다(종전 «앱 권한 밖»)",
    x1.status === 403 && /앱 권한 밖/.test(x1.body?.error ?? "") && x1.body?.code === undefined, J(x1));
} catch (e) {
  fail++;
  console.error("FAIL (예외)", e?.stack ?? e);
} finally {
  for (const s of servers) s.close();
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
}
console.log(`\napp-regrant(#1644): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
