// 앱 «조직 동의»(관리자가 구성원 모두를 대신해 하는 앱 동의) PG 통합 시험 — **실제 Postgres 필요**(CI 의 pg 잡이 run-tests --pg 로 자동 수집).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-org-grant.pg-test.mjs
//
// 사양 문장만 보고 썼다(구현을 보지 않음). 이름 머리의 번호(A1 · B2 …)는 사양의 행위 번호다. 순수 합치기 규칙 · G1 은 grant-org.test.ts.
// 왜 이 계층인가: «조직 동의가 그 사람에게 닿나» 는 DB 의 사실(앱의 공개 판 · 조직 동의 · 본인 동의 행 · 구성원 상태와 권한)을 겹쳐 읽는 판정이고,
//  그 결과는 진짜 문(앱 토큰 발급 · 앱 서버가 부르는 능력 REST 의 도구 · scope 관문 · 시작 전 판정)에서 드러난다. 그래서 진짜 게이트웨이 REST
//  (registerWebUi · 앱 서버 토큰 · 서명된 사람 신원)에 앱 서버처럼 부르고, 앱 판을 실제 설치 능력으로 넓혀 가며 «앞 → 뒤» 를 같은 구성원으로 잰다.
//  A1 조직 동의 없음 — 동의 안 한 사람은 동의 없음 · 동의한 사람은 본인 것 그대로
//  B1 관리자 전용(능력 scope admin · REST 문) · B2 공개 판의 선언 전체 · B3 선택 권한은 안 든다 · B4 초안이 아니라 공개 판 · B5 답의 상태 · B6 404 · 409 · 409
//  C1 동의 안 한 활성 구성원도 동의한 것(활성 동의 · 토큰 · 앱 서버 호출 · 동의한 앱 목록) · C2 없는 권한은 안 생긴다 · C3 비활성 · 구성원 아님
//  D1 본인 ∪ 조직 · D2 본인의 선택 권한은 남고 퍼지지 않는다 · D3 예전 범위 본인 동의 + 덮는 조직 동의 → 안 막힘 · D4 범위 없이 다시 동의해도 선택 권한은 스스로 받은 것뿐
//  E1 뒤에 넓어진 것은 consent_required · 이미 든 것은 통과 · E2 org_app_get covers false · missing · hint · E3 설치 답의 org_grant · E4 한 번 더 부르면 따라온다
//  F1 본인 철회 뒤에도 조직 동의는 남는다(org_granted · note) · F2 관리자가 거두면 조직 것만 빠진다(revoked true / false)
import "../../scripts/test-apps-root.mjs";   // 앱 폴더 자리를 임시 폴더로 — 앱을 깔고 지우는 시험이 실제 ~/apps 를 건드리지 않게
import pg from "pg";
import http from "node:http";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_org_grant";
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
const { getActiveGrant, getMemberGrant, listActiveGrants } = await import(`${D}/org/store/apps.js`);
const { mintAppServerToken } = await import(`${D}/apps/app-server-auth.js`);
const { mintAppToken, _clearAppToolCache } = await import(`${D}/apps/principal.js`);
const { launchConsentGap } = await import(`${D}/apps/app-consent-gap.js`);
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
/** 같은 원소 · 같은 개수(중복이 있으면 길이가 달라 걸린다). 순서는 사양에 없어 보지 않는다. */
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && J([...a].sort()) === J([...b].sort());
/** 빠진 것(missing)이 정확히 그 scope · 도구인가(칸 순서는 보지 않는다). */
const missIs = (m, scopes, tools) => sameSet(m?.scopes, scopes) && sameSet(m?.tools, tools);
/** 부르고 답 · 오류를 함께 받는다 — «오류가 아니다» 와 답의 값을 한 번의 호출로 잰다. */
const tryCall = async (p) => { try { return { r: await p, e: null }; } catch (e) { return { r: null, e }; } };
/** 한 갈래의 예외가 뒤 갈래를 가리지 않게 — 갈래마다 따로 잡는다(예외는 그 갈래의 실패 1건). */
const step = async (name, fn) => { try { await fn(); } catch (e) { fail++; console.error(`FAIL ${name} (예외)`, e?.stack ?? e); } };

//  alice 한 번도 스스로 동의하지 않는다(조직 동의만으로 쓴다) · bob 본인 동의가 있다(좁힌 것 · 선택 권한) · carl 본인 동의를 줬다가 거둔다
//  dana 동의 창 그대로 동의(견줄 값) · 초안을 건다 · eve 조직 동의가 생긴 뒤 처음 동의한다 · nocx context 권한이 없다 · gone 뒤에 비활성이 된다
//  ghost 는 구성원이 아니다(만들지 않는다).
const MEMBER = ["memory", "context", "items"];
const SC = { admin: ["admin", ...MEMBER], alice: MEMBER, bob: MEMBER, carl: MEMBER, dana: MEMBER, eve: MEMBER, gone: MEMBER, nocx: ["memory", "items"] };
const P = (id) => ({ userId: id, email: `${id}@x.invalid`, scopes: SC[id], projects: ["*"] });
const ctx = { source: "mcp" };
const manifest = (id, perms, extra = {}) => ({ id, title: id, version: "0.1.0", permissions: perms, ...extra });
const install = (m) => cap("org_app_install").handler({ source: { kind: "inline", files: [{ path: "lively-app.json", content: J(m) }] } }, P("admin"), ctx);
const save = (who, m) => cap("app_save").handler({ files: [{ path: "lively-app.json", content: J(m) }] }, P(who), ctx);
const grant = (who, app, range = {}) => cap("me_app_grant").handler({ app_id: app, ...range }, P(who), ctx);
const revoke = (who, app) => cap("me_app_revoke").handler({ app_id: app }, P(who), ctx);
const setOrg = (app, extra = {}, who = "admin") => cap("org_app_grant_set").handler({ app_id: app, ...extra }, P(who), ctx);
const appGet = async (app) => (await cap("org_app_get").handler({ app_id: app }, P("admin"), ctx))?.app;
const appRow = async (app) => (await itemsPool.query(`SELECT visibility, enabled, draft_by, published_version_no FROM org_app WHERE id=$1`, [app])).rows[0] ?? null;
const hasApp = (list, app) => Array.isArray(list) && list.some((g) => g?.app_id === app);
//  앱 도구 게이트는 동의의 도구 목록을 5초 기억한다 — 판을 바꾸거나 동의를 적고 거둔 바로 뒤에 재려면 비운다.
const fresh = () => _clearAppToolCache();

const TOOLS = ["store_tables", "project_list_v6", "category_list"];   // category_list 는 scope context 가 있어야 돈다
const V1 = { scopes: ["memory"], tools: TOOLS };
const V2 = { ...V1, ai_runs: true };                                   // 도구만 넓힌다(AI 실행 도구 다섯)
const V3 = { ...V2, scopes: ["memory", "context"] };                   // 필수 scope 를 넓힌다

try {
  for (const [id, sc] of Object.entries(SC)) await upsertMember({ id, display_name: id, state: "active", scopes: sc }, "pgt");

  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  const verifier = new BearerVerifier();
  registerWebUi(gw, verifier);
  const GW = await listen(gw);
  process.env.PUBLIC_URL = GW;   // 동의 자리의 base(org 프로필 gateway_url 이 비어 있으면 PUBLIC_URL)

  const serverTokens = new Map();
  const serverToken = async (app) => { if (!serverTokens.has(app)) serverTokens.set(app, (await mintAppServerToken(app, "admin")).token); return serverTokens.get(app); };
  /** 앱 서버처럼 부른다 — 앱 서버 토큰 + 앞단이 서명한 그 사람의 신원(사람이 앱 화면에서 누른 요청과 같은 길). */
  const asApp = async (sub, path, app = "policy") => {
    const r = await fetch(GW + path, { headers: { authorization: `Bearer ${await serverToken(app)}`, "x-lively-identity": identity(sub, app, "pub") } });
    let body = null; try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  };
  /** 그 사람 이름의 앱 토큰에 실린 scope — 발급이 막히면 null. */
  const tokenScopes = async (who, app) => {
    const t = await mintAppToken(who, app, "pgt").catch(() => null);
    return t ? (await verifier.verifyAccessToken(t.token)).extra.scopes : null;
  };
  const PROJECTS = "/api/ui/v6/projects";      // 도구 project_list_v6
  const AI = "/api/ui/ai-targets";             // 도구 app_ai_targets(ai_runs 가 선언한다)
  const CATS = "/api/ui/categories";           // 도구 category_list · scope context

  // ════ policy — 조직 동의의 한살이(A1 · B2 · B5 · C1~C3 · D1 · D3 · E1~E4 · F1 · F2) ════
  await step("policy 한살이", async () => {
    const i1 = await install(manifest("policy", V1));
    await grant("dana", "policy");                                             // 동의 창 그대로(범위 없음) — B2 가 견줄 집합
    await grant("bob", "policy", { scopes: ["memory"], tools: ["store_tables"] });   // 좁힌 본인 동의
    fresh();
    const danaOwn = await getMemberGrant("policy", "dana");
    const g0 = await asApp("dana", PROJECTS);
    chk("G0 배선 — 앱 서버 토큰 + 서명된 신원으로 진짜 능력 REST 에 닿는다(본인 동의한 dana 200) · 동의 창 동의 = 필수 scope + 도구 전부",
      g0.status === 200 && sameSet(danaOwn?.scopes, ["memory"]) && sameSet(danaOwn?.tools, TOOLS), J({ g0, danaOwn }));

    // ── A1 조직 동의가 없을 때 ──
    const a = {
      active: await getActiveGrant("policy", "alice"), mint: await errOf(mintAppToken("alice", "policy", "pgt")), call: await asApp("alice", PROJECTS),
      list: await listActiveGrants("alice"), app: await appGet("policy"),
    };
    chk("A1 조직 동의 없음 — 동의한 적 없는 구성원은 동의가 없다(활성 동의 null · 토큰 발급 403 · 앱 서버 호출 403 · 동의한 앱 목록에 없음 · 앱 상세 org_grant 빔)",
      a.active === null && a.mint?.status === 403 && a.call.status === 403 && Array.isArray(a.list) && !hasApp(a.list, "policy") && a.app && a.app.org_grant == null,
      J({ active: a.active, mint: a.mint?.status, call: a.call, list: a.list, org_grant: a.app?.org_grant }));
    const bob0 = { active: await getActiveGrant("policy", "bob"), mine: await getMemberGrant("policy", "bob"), call: await asApp("bob", PROJECTS), list: await listActiveGrants("bob") };
    chk("A1 조직 동의 없음 — 동의한 구성원의 동의는 본인이 준 그대로(좁힌 도구 하나 · 조직 표시 없음 · 좁힌 밖의 도구는 막힌다)",
      sameSet(bob0.active?.scopes, ["memory"]) && sameSet(bob0.active?.tools, ["store_tables"]) && bob0.active?.org_granted !== true
        && sameSet(bob0.mine?.tools, ["store_tables"]) && bob0.call.status === 403 && hasApp(bob0.list, "policy"), J(bob0));
    chk("E3 조직 동의가 없는 앱의 설치 답에는 org_grant 칸이 없다(첫 설치)", i1 && i1.org_grant === undefined, J(i1?.org_grant));

    // ── B2 · B5 조직 동의를 적는다 ──
    const s1 = await setOrg("policy");
    fresh();
    const og1 = s1?.org_grant;
    chk("B2 org_app_grant_set — 공개 판이 지금 선언한 것 전체(필수 scope 전부 + 도구 전부)가 적힌다 · 동의 창에서 한 사람이 받는 것과 같은 집합",
      s1?.ok === true && s1?.app_id === "policy" && sameSet(og1?.scopes, ["memory"]) && sameSet(og1?.tools, TOOLS)
        && sameSet(og1?.scopes, danaOwn?.scopes) && sameSet(og1?.tools, danaOwn?.tools), J(s1));
    chk("B5 답에 조직 동의의 상태 — 누가(granted_by = 부른 관리자) · 언제(granted_at = 지금) · covers true · missing 빔",
      og1?.granted_by === "admin" && typeof og1?.granted_at === "string" && Math.abs(Date.parse(og1.granted_at) - Date.now()) < 10 * 60_000
        && og1?.covers === true && missIs(og1?.missing, [], []), J(og1));
    const app1 = await appGet("policy");
    chk("B5 앱 상세(org_app_get)에도 같은 상태가 실린다 — 적기 전엔 비어 있었다",
      a.app?.org_grant == null && sameSet(app1?.org_grant?.scopes, ["memory"]) && sameSet(app1?.org_grant?.tools, TOOLS)
        && app1?.org_grant?.granted_by === "admin" && Math.abs(Date.parse(app1?.org_grant?.granted_at) - Date.parse(og1?.granted_at)) < 1000 && app1?.org_grant?.covers === true, J(app1?.org_grant));

    // ── C1 동의한 적 없는 활성 구성원 ──
    const c = {
      active: await getActiveGrant("policy", "alice"), mine: await getMemberGrant("policy", "alice"), mint: await errOf(mintAppToken("alice", "policy", "pgt")),
      scopes: await tokenScopes("alice", "policy"), call: await asApp("alice", PROJECTS), list: await listActiveGrants("alice"),
    };
    chk("C1 활성 동의 — 동의한 적 없는 구성원에게 조직 동의의 scope · 도구가 나오고 조직 동의 표시(org_granted)가 있다 · 본인 동의 행은 여전히 없다",
      a.active === null && c.active?.app_id === "policy" && c.active?.member_id === "alice" && sameSet(c.active?.scopes, ["memory"]) && sameSet(c.active?.tools, TOOLS)
        && c.active?.org_granted === true && c.active?.granted_by === "admin" && c.active?.revoked_at == null && c.mine === null, J({ active: c.active, mine: c.mine }));
    chk("C1 그 사람 이름으로 앱 토큰을 발급할 수 있다(앞에선 403 이었다) — 토큰에 조직 동의의 scope 가 실린다",
      a.mint?.status === 403 && c.mint === null && Array.isArray(c.scopes) && c.scopes.includes("memory"), J({ before: a.mint?.status, after: c.mint?.message, scopes: c.scopes }));
    chk("C1 앱 서버가 그 사람 이름으로 앱이 선언한 도구를 부르면 통과한다(앞에선 403 이었다)", a.call.status === 403 && c.call.status === 200, J({ before: a.call, after: c.call.status, err: c.call.body?.error }));
    chk("C1 그 사람의 «동의한 앱 목록» 에 그 앱이 든다(앞에선 없었다)", !hasApp(a.list, "policy") && hasApp(c.list, "policy"), J(c.list));

    // ── C3 활성 구성원에게만 닿는다 ──
    const goneActive = await getActiveGrant("policy", "gone");
    await upsertMember({ id: "gone", display_name: "gone", state: "inactive", scopes: SC.gone }, "pgt");
    fresh();
    const goneAfter = { active: await getActiveGrant("policy", "gone"), list: await listActiveGrants("gone"), mint: await errOf(mintAppToken("gone", "policy", "pgt")) };
    chk("C3 비활성 구성원 — 활성일 땐 조직 동의가 닿았고, 비활성이 되면 동의가 없다(활성 동의 null · 동의한 앱 목록에 없음 · 토큰 발급 거절)",
      goneActive?.org_granted === true && goneAfter.active === null && !hasApp(goneAfter.list, "policy") && goneAfter.mint !== null,
      J({ goneActive, after: goneAfter.active, list: goneAfter.list, mint: goneAfter.mint?.message }));
    const ghost = { active: await getActiveGrant("policy", "ghost"), list: await listActiveGrants("ghost"), mint: await errOf(mintAppToken("ghost", "policy", "pgt")) };
    chk("C3 구성원이 아닌 id — 조직 동의가 있어도 동의가 없다(같은 앱에서 활성 구성원 alice 에겐 있다)",
      ghost.active === null && !hasApp(ghost.list, "policy") && ghost.mint !== null && c.active?.org_granted === true, J({ active: ghost.active, list: ghost.list, mint: ghost.mint?.message }));

    // ── D1 본인 동의 ∪ 조직 동의 ──
    const bob1 = { active: await getActiveGrant("policy", "bob"), mine: await getMemberGrant("policy", "bob"), call: await asApp("bob", PROJECTS) };
    chk("D1 본인 동의(도구 하나로 좁힘)가 있는 구성원의 유효한 동의 = 본인 ∪ 조직 — 조직 동의의 도구까지 넓어지고(앞의 403 → 200) 본인 동의 행은 그대로",
      bob0.call.status === 403 && bob1.call.status === 200 && sameSet(bob1.active?.tools, TOOLS) && sameSet(bob1.active?.scopes, ["memory"]) && bob1.active?.org_granted === true
        && sameSet(bob1.mine?.tools, ["store_tables"]) && bob1.mine?.org_granted !== true, J(bob1));

    // ── E 앱이 그 뒤에 넓어진다(도구) ──
    const i2 = await install(manifest("policy", V2, { version: "0.2.0" }));
    fresh();
    const e1 = { ai: await asApp("alice", AI), old: await asApp("alice", PROJECTS), active: await getActiveGrant("policy", "alice"), gap: await launchConsentGap(P("alice"), "policy", "alice") };
    chk("E1 조직 동의 뒤에 새로 선언된 도구 — 조직 동의만으로 쓰던 구성원은 «예전 범위» 거절(403 · consent_required) · 조직 동의는 그때의 선언 그대로",
      e1.ai.status === 403 && e1.ai.body?.code === "consent_required" && sameSet(e1.active?.tools, TOOLS) && e1.gap !== null
        && AI_RUN_TOOLS.every((t) => e1.gap?.missing?.tools?.includes(t)), J({ ai: e1.ai, tools: e1.active?.tools, gap: e1.gap }));
    chk("E1 조직 동의에 이미 든 것은 계속 통과한다(넓은 거절이 아니다)", e1.old.status === 200, J(e1.old));
    const app2 = await appGet("policy");
    chk("E2 앱 상세의 조직 동의 상태 — covers false · 빠진 것(missing.tools = 새 도구 다섯 · scopes 빔) · org_app_grant_set 을 다시 부르라는 hint",
      app2?.org_grant?.covers === false && missIs(app2?.org_grant?.missing, [], AI_RUN_TOOLS)
        && typeof app2?.org_grant?.hint === "string" && app2.org_grant.hint.includes("org_app_grant_set") && sameSet(app2?.org_grant?.tools, TOOLS), J(app2?.org_grant));
    chk("E3 조직 동의가 있는 앱을 업데이트하는 설치의 답에 org_grant — 넓어졌으면 covers false · missing · hint",
      i2?.org_grant?.covers === false && missIs(i2?.org_grant?.missing, [], AI_RUN_TOOLS) && typeof i2?.org_grant?.hint === "string" && i2.org_grant.hint.includes("org_app_grant_set"),
      J(i2?.org_grant));
    const bob2 = { ai: await asApp("bob", AI), gap: await launchConsentGap(P("bob"), "policy", "bob") };

    await grant("carl", "policy");                                             // 판 2 의 동의 창 그대로 — E4 가 견줄 집합(뒤에 F1 에서 거둔다)
    const carlOwn = await getMemberGrant("policy", "carl");
    const s2 = await setOrg("policy");
    fresh();
    const e4 = { ai: await asApp("alice", AI), gap: await launchConsentGap(P("alice"), "policy", "alice"), mine: await getMemberGrant("policy", "alice"), app: await appGet("policy") };
    chk("E4 org_app_grant_set 을 한 번 더 — 새 선언으로 고쳐 적힌다(covers true · missing 빔 · 새 도구가 든다 · 판 2 의 동의 창 집합과 같다)",
      s2?.ok === true && s2?.org_grant?.covers === true && missIs(s2?.org_grant?.missing, [], []) && AI_RUN_TOOLS.every((t) => s2?.org_grant?.tools?.includes(t))
        && sameSet(s2?.org_grant?.tools, carlOwn?.tools) && sameSet(s2?.org_grant?.scopes, carlOwn?.scopes) && e4.app?.org_grant?.covers === true, J({ s2, carlOwn }));
    chk("E4 구성원은 아무것도 하지 않아도 새로 선언된 것까지 통과한다(앞의 consent_required → 200 · 시작 전 판정 null · 본인 동의 행은 여전히 없다)",
      e1.ai.status === 403 && e4.ai.status === 200 && e1.gap !== null && e4.gap === null && e4.mine === null, J({ ai: e4.ai.status, err: e4.ai.body?.error, gap: e4.gap, mine: e4.mine }));
    const bob3 = { ai: await asApp("bob", AI), gap: await launchConsentGap(P("bob"), "policy", "bob"), mine: await getMemberGrant("policy", "bob") };
    chk("D3 본인 동의가 예전 범위여도 조직 동의가 지금 선언을 덮으면 막히지 않는다 — 조직 동의가 낡았을 땐 막혔고(consent_required), 다시 동의하지 않았는데 풀린다",
      bob2.ai.status === 403 && bob2.ai.body?.code === "consent_required" && bob2.gap !== null
        && bob3.ai.status === 200 && bob3.gap === null && sameSet(bob3.mine?.tools, ["store_tables"]), J({ before: bob2, after: { ai: bob3.ai.status, gap: bob3.gap, mine: bob3.mine } }));

    // ── E 앱이 그 뒤에 넓어진다(필수 scope) · C2 ──
    const i3 = await install(manifest("policy", V3, { version: "0.3.0" }));
    fresh();
    const e1s = { cats: await asApp("alice", CATS), ai: await asApp("alice", AI), scopes: await tokenScopes("alice", "policy"), app: await appGet("policy") };
    chk("E1 조직 동의 뒤에 새로 선언된 필수 scope(context) — 그 scope 가 드는 호출은 403 consent_required · 앱 토큰에 안 실린다 · 이미 든 도구는 통과",
      e1s.cats.status === 403 && e1s.cats.body?.code === "consent_required" && Array.isArray(e1s.scopes) && !e1s.scopes.includes("context") && e1s.ai.status === 200,
      J({ cats: e1s.cats, scopes: e1s.scopes, ai: e1s.ai.status }));
    chk("E2 · E3 scope 가 넓어진 판 — 앱 상세 · 설치 답 모두 covers false · missing = scope context 하나 · hint",
      e1s.app?.org_grant?.covers === false && missIs(e1s.app?.org_grant?.missing, ["context"], []) && String(e1s.app?.org_grant?.hint ?? "").includes("org_app_grant_set")
        && i3?.org_grant?.covers === false && missIs(i3?.org_grant?.missing, ["context"], []) && String(i3?.org_grant?.hint ?? "").includes("org_app_grant_set"),
      J({ get: e1s.app?.org_grant, install: i3?.org_grant }));
    const s3 = await setOrg("policy");
    fresh();
    const e4s = { cats: await asApp("alice", CATS), scopes: await tokenScopes("alice", "policy") };
    chk("E4 다시 적으면 새 필수 scope 도 따라온다 — 조직 동의 scope = memory · context · 구성원은 그대로인데 호출 200 · 앱 토큰에 context",
      sameSet(s3?.org_grant?.scopes, ["memory", "context"]) && s3?.org_grant?.covers === true && e4s.cats.status === 200 && e4s.scopes?.includes("context"),
      J({ og: s3?.org_grant, cats: e4s.cats.status, err: e4s.cats.body?.error, scopes: e4s.scopes }));
    const nocx = { scopes: await tokenScopes("nocx", "policy"), cats: await asApp("nocx", CATS), ok: await asApp("nocx", PROJECTS) };
    chk("C2 경계 — 구성원에게 없는 scope(context)는 조직 동의가 있어도 그 사람의 앱 토큰에 들지 않는다(같은 조직 동의로 alice 의 토큰엔 든다 · nocx 의 호출은 막힌다)",
      Array.isArray(nocx.scopes) && nocx.scopes.includes("memory") && !nocx.scopes.includes("context") && e4s.scopes?.includes("context")
        && nocx.cats.status === 403 && nocx.cats.body?.code !== "consent_required" && nocx.ok.status === 200, J(nocx));

    // ── E3 넓히지 않는 업데이트 ──
    const i3b = await install(manifest("policy", V3, { version: "0.3.1" }));
    fresh();
    chk("E3 조직 동의가 있는 앱의 업데이트 설치 답에는 넓어지지 않아도 org_grant 가 실린다(covers true)",
      i3b?.org_grant?.covers === true && sameSet(i3b?.org_grant?.scopes, ["memory", "context"]) && missIs(i3b?.org_grant?.missing, [], []), J(i3b?.org_grant));

    // ── F1 본인이 거둬도 조직 동의는 남는다 ──
    const carlBefore = await getMemberGrant("policy", "carl");
    const rv = await revoke("carl", "policy");
    fresh();
    const f1 = { mine: await getMemberGrant("policy", "carl"), active: await getActiveGrant("policy", "carl"), mint: await errOf(mintAppToken("carl", "policy", "pgt")),
      call: await asApp("carl", PROJECTS), list: await listActiveGrants("carl") };
    chk("F1 본인 철회의 답 — revoked true · org_granted true · 그 사실을 알리는 note(사람이 «껐다» 고 믿지 않게)",
      rv?.ok === true && rv?.app_id === "policy" && rv?.revoked === true && rv?.org_granted === true && typeof rv?.note === "string" && rv.note.trim().length > 0, J(rv));
    chk("F1 본인 동의를 거둬도 조직 동의는 남는다 — 본인 동의 행은 사라졌는데 여전히 동의한 것으로 취급(활성 동의 · 토큰 · 앱 서버 호출 · 동의한 앱 목록)",
      carlBefore !== null && (f1.mine === null || f1.mine.revoked_at != null) && f1.active?.org_granted === true && sameSet(f1.active?.scopes, ["memory", "context"])
        && f1.mint === null && f1.call.status === 200 && hasApp(f1.list, "policy"), J({ mine: f1.mine, active: f1.active, mint: f1.mint?.message, call: f1.call.status }));

    // ── F2 관리자가 조직 동의를 거둔다 ──
    const off = await setOrg("policy", { granted: false });
    fresh();
    const f2 = {
      alice: await getActiveGrant("policy", "alice"), aliceMint: await errOf(mintAppToken("alice", "policy", "pgt")), aliceCall: await asApp("alice", PROJECTS), aliceList: await listActiveGrants("alice"),
      carl: await getActiveGrant("policy", "carl"), app: await appGet("policy"),
      bob: await getActiveGrant("policy", "bob"), bobMine: await getMemberGrant("policy", "bob"), bobMint: await errOf(mintAppToken("bob", "policy", "pgt")), bobCall: await asApp("bob", PROJECTS),
      dana: await getActiveGrant("policy", "dana"),
    };
    chk("F2 org_app_grant_set {granted:false} 의 답 — org_grant null · revoked true · 앱 상세의 조직 동의도 빈다",
      off?.ok === true && off?.app_id === "policy" && off?.org_grant === null && off?.revoked === true && f2.app && f2.app.org_grant == null, J({ off, get: f2.app?.org_grant }));
    chk("F2 조직 동의만으로 쓰던 구성원은 동의가 없어진다 — 종전의 «동의 없음» 과 같다(활성 동의 null · 토큰 403 · 호출 403 · 목록에 없음 · 본인 동의를 거뒀던 carl 도)",
      e4.ai.status === 200 && f2.alice === null && f2.aliceMint?.status === 403 && f2.aliceCall.status === 403 && !hasApp(f2.aliceList, "policy") && f2.carl === null,
      J({ alice: f2.alice, mint: f2.aliceMint?.status, call: f2.aliceCall, carl: f2.carl }));
    chk("F2 본인 동의가 있던 구성원의 동의는 본인이 준 그대로 남는다 — 조직 동의에서 온 것(도구 · scope · 표시)은 빠진다",
      sameSet(f2.bob?.tools, ["store_tables"]) && sameSet(f2.bob?.scopes, ["memory"]) && f2.bob?.org_granted !== true && sameSet(f2.bobMine?.tools, ["store_tables"])
        && f2.bobMint === null && bob1.call.status === 200 && f2.bobCall.status === 403
        && sameSet(f2.dana?.scopes, danaOwn?.scopes) && sameSet(f2.dana?.tools, danaOwn?.tools) && f2.dana?.org_granted !== true, J({ bob: f2.bob, bobCall: f2.bobCall, dana: f2.dana }));
    const off2 = await tryCall(setOrg("policy", { granted: false }));
    chk("F2 이미 거둔(조직 동의가 없는) 앱에 거두기를 한 번 더 부르면 revoked false — 오류가 아니다(앞의 답은 revoked true 였다)",
      off?.revoked === true && off2.e === null && off2.r?.ok === true && off2.r?.org_grant === null && off2.r?.revoked === false, J({ err: off2.e?.message, r: off2.r }));
  });

  // ════ B1 관리자 전용 ════
  await step("B1", async () => {
    chk("B1 org_app_grant_set 은 관리자 전용 — 능력의 scope 가 admin(구성원이 스스로 하는 me_app_grant 는 admin 이 아니다)",
      cap("org_app_grant_set")?.scope === "admin" && !!cap("me_app_grant") && cap("me_app_grant").scope !== "admin", J({ set: cap("org_app_grant_set")?.scope, me: cap("me_app_grant")?.scope }));
    //  진짜 문 — 능력이 연 REST 길(있으면)에 사람 토큰으로 부른다. 관리자가 아닌 사람은 403 이고 아무것도 적히지 않는다. 같은 길에 관리자는 적힌다.
    const route = cap("org_app_grant_set")?.expose?.rest?.[0];
    const path = route?.paths?.[0] ?? route?.path;
    if (!route || typeof path !== "string") { console.log("--  B1 REST 문은 재지 않았다 — org_app_grant_set 이 REST 길을 열지 않았다(능력 scope 만 쟀다)"); return; }
    await install(manifest("b1app", V1));
    const method = String(route.method ?? "POST").toUpperCase();
    const call = async (token) => {
      const r = await fetch(GW + path.replace(/:[A-Za-z_]+/g, "b1app"), {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: method === "GET" ? undefined : J({ app_id: "b1app" }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const memberTok = (await mintToken({ userId: "nocx", memberId: "nocx", scopes: SC.nocx }, "pgt")).token;
    const adminTok = (await mintToken({ userId: "admin", memberId: "admin", scopes: SC.admin }, "pgt")).token;
    const denied = await call(memberTok);
    const afterDenied = await getActiveGrant("b1app", "alice");
    const allowed = await call(adminTok);
    fresh();
    const afterAllowed = await getActiveGrant("b1app", "alice");
    chk("B1 진짜 문 — 관리자가 아닌 사람의 토큰은 403 이고 조직 동의가 적히지 않는다 · 같은 길에 관리자 토큰은 적힌다",
      denied.status === 403 && afterDenied === null && allowed.status === 200 && allowed.body?.org_grant?.covers === true && afterAllowed?.org_granted === true,
      J({ method, path, denied, afterDenied, allowed, afterAllowed }));
  });

  // ════ B4 초안이 아니라 공개 판 ════
  await step("B4", async () => {
    const PUB = { scopes: ["memory"], tools: ["store_tables", "project_list_v6"] };
    await install(manifest("wiki2", PUB));
    await save("dana", manifest("wiki2", { scopes: ["memory", "context"], tools: ["store_tables", "project_list_v6", "category_list"] }));   // 초안이 선언을 넓혔다
    const w = await appRow("wiki2");
    const s = await setOrg("wiki2");
    fresh();
    const al = await getActiveGrant("wiki2", "alice");
    chk("B4 배선 — 공개 앱에 dana 의 초안이 걸렸다(공개 판은 그대로)", w?.visibility === "all" && w?.draft_by === "dana" && w?.published_version_no != null, J(w));
    chk("B4 공개 앱에 선언을 넓힌 초안이 걸려 있어도 조직 동의에는 공개 판의 선언이 적힌다(초안의 scope · 도구는 없다 · 공개 판을 다 덮는다)",
      sameSet(s?.org_grant?.scopes, PUB.scopes) && sameSet(s?.org_grant?.tools, PUB.tools) && s?.org_grant?.covers === true
        && !s?.org_grant?.scopes?.includes("context") && !s?.org_grant?.tools?.includes("category_list")
        && sameSet(al?.scopes, PUB.scopes) && sameSet(al?.tools, PUB.tools), J({ s, al }));
  });

  // ════ B6 거절 ════
  await step("B6", async () => {
    const none = await errOf(setOrg("no-such-app"));
    chk("B6 없는 앱 → 404", none?.status === 404, J({ status: none?.status, m: none?.message }));

    await save("admin", manifest("mine", { scopes: ["memory"], tools: ["store_tables"] }));   // 새 id 를 저장하면 «나만 보는 앱»
    const mineRow = await appRow("mine");
    const priv = await errOf(setOrg("mine"));
    fresh();
    const privGrant = await getActiveGrant("mine", "alice");
    await cap("app_visibility_set").handler({ app_id: "mine", visibility: "all" }, P("admin"), ctx);
    const pub = await errOf(setOrg("mine"));
    fresh();
    chk("B6 아직 공개되지 않은 앱(visibility me) → 409 · 아무것도 적히지 않는다 · 공개한 뒤에는 적힌다",
      mineRow?.visibility === "me" && priv?.status === 409 && privGrant === null && (await appRow("mine"))?.visibility === "all" && pub === null
        && (await getActiveGrant("mine", "alice"))?.org_granted === true, J({ mineRow, priv: priv?.status, privMsg: priv?.message, privGrant, pub: pub?.message }));

    await install(manifest("offapp", V1));
    await cap("org_app_set_enabled").handler({ app_id: "offapp", enabled: false }, P("admin"), ctx);
    const offRow = await appRow("offapp");
    const off = await errOf(setOrg("offapp"));
    await cap("org_app_set_enabled").handler({ app_id: "offapp", enabled: true }, P("admin"), ctx);
    fresh();
    const offGrant = await getActiveGrant("offapp", "alice");
    const on = await errOf(setOrg("offapp"));
    fresh();
    chk("B6 꺼진(비활성) 앱 → 409 · 아무것도 적히지 않는다 · 다시 켠 뒤에는 적힌다",
      offRow?.enabled === false && off?.status === 409 && offGrant === null && on === null && (await getActiveGrant("offapp", "alice"))?.org_granted === true,
      J({ offRow, off: off?.status, offMsg: off?.message, offGrant, on: on?.message }));
  });

  // ════ F1 · F2 · E3 조직 동의가 없는 앱(견줄 값) ════
  await step("조직 동의 없는 앱", async () => {
    await install(manifest("plain", V1));
    await grant("carl", "plain");
    const had = await getActiveGrant("plain", "carl");
    const rv = await revoke("carl", "plain");
    fresh();
    chk("F1 조직 동의가 없는 앱의 철회 답에는 org_granted · note 칸이 없다 — 거두면 동의가 없다",
      had !== null && had.org_granted !== true && rv?.ok === true && rv?.revoked === true && rv?.org_granted === undefined && rv?.note === undefined
        && (await getActiveGrant("plain", "carl")) === null, J({ had, rv }));
    const up = await install(manifest("plain", V2, { version: "0.2.0" }));
    chk("E3 조직 동의가 없는 앱의 업데이트 설치 답에는 org_grant 칸이 없다(넓어져도)", up && up.org_grant === undefined, J(up?.org_grant));
    const off = await tryCall(setOrg("plain", { granted: false }));
    chk("F2 조직 동의를 적은 적 없는 앱에 거두기 → 오류 없이 org_grant null · revoked false",
      off.e === null && off.r?.ok === true && off.r?.app_id === "plain" && off.r?.org_grant === null && off.r?.revoked === false, J({ err: off.e?.message, r: off.r }));
  });

  // ════ B3 · D2 · D4 선택 권한 ════
  await step("선택 권한", async () => {
    await install(manifest("optapp", { scopes: ["memory"], optional_scopes: ["context"], tools: TOOLS }));
    await grant("bob", "optapp", { optional_scopes: ["context"] });            // bob 만 선택 권한(context)을 따로 받았다
    fresh();
    const bobOwn0 = await getMemberGrant("optapp", "bob");
    const bobCats0 = await asApp("bob", CATS, "optapp");
    chk("D2 배선 — bob 의 본인 동의에 선택 권한 context 가 들었고 그 scope 가 드는 호출이 통과한다", sameSet(bobOwn0?.scopes, ["memory", "context"]) && bobCats0.status === 200, J({ bobOwn0, bobCats0 }));

    const s = await setOrg("optapp");
    fresh();
    chk("B3 선택 권한(optional_scopes)은 조직 동의에 들지 않는다 — scope 는 필수(memory)뿐 · 도구는 전부 · 그래도 공개 판을 다 덮는다(covers true · missing 에 context 없음)",
      sameSet(s?.org_grant?.scopes, ["memory"]) && !s?.org_grant?.scopes?.includes("context") && sameSet(s?.org_grant?.tools, TOOLS)
        && s?.org_grant?.covers === true && Array.isArray(s?.org_grant?.missing?.scopes) && !s.org_grant.missing.scopes.includes("context"), J(s));
    const d2 = {
      bob: await getActiveGrant("optapp", "bob"), bobScopes: await tokenScopes("bob", "optapp"), bobCats: await asApp("bob", CATS, "optapp"),
      alice: await getActiveGrant("optapp", "alice"), aliceScopes: await tokenScopes("alice", "optapp"), aliceCats: await asApp("alice", CATS, "optapp"), aliceOk: await asApp("alice", PROJECTS, "optapp"),
    };
    chk("D2 조직 동의가 생겨도 본인이 따로 받은 선택 권한은 그대로 남는다(유효한 동의 · 앱 토큰 · 호출)",
      d2.bob?.org_granted === true && sameSet(d2.bob?.scopes, ["memory", "context"]) && d2.bobScopes?.includes("context") && d2.bobCats.status === 200, J({ bob: d2.bob, scopes: d2.bobScopes, cats: d2.bobCats.status }));
    chk("D2 그 선택 권한은 그 사람만 갖는다 — 조직 동의만 받은 구성원(같은 권한을 가진 alice)에게 퍼지지 않는다(유효한 동의 · 앱 토큰 · 호출 403 · 조직 동의의 도구는 200)",
      d2.alice?.org_granted === true && sameSet(d2.alice?.scopes, ["memory"]) && Array.isArray(d2.aliceScopes) && !d2.aliceScopes.includes("context")
        && d2.aliceCats.status === 403 && d2.aliceOk.status === 200, J({ alice: d2.alice, scopes: d2.aliceScopes, cats: d2.aliceCats, ok: d2.aliceOk.status }));

    const s2 = await setOrg("optapp");                                          // 조직 동의가 다시 적힌다
    fresh();
    const d2b = { bobMine: await getMemberGrant("optapp", "bob"), bob: await getActiveGrant("optapp", "bob"), bobCats: await asApp("bob", CATS, "optapp"), alice: await getActiveGrant("optapp", "alice") };
    chk("D2 조직 동의가 다시 적혀도 — 본인의 선택 권한은 그대로(본인 동의 행 · 유효한 동의 · 호출) · 조직 동의에는 여전히 없다 · 다른 구성원에게도 여전히 없다",
      sameSet(s2?.org_grant?.scopes, ["memory"]) && sameSet(d2b.bobMine?.scopes, ["memory", "context"]) && sameSet(d2b.bob?.scopes, ["memory", "context"])
        && d2b.bobCats.status === 200 && sameSet(d2b.alice?.scopes, ["memory"]), J({ og: s2?.org_grant, ...d2b, bobCats: d2b.bobCats.status }));

    await grant("bob", "optapp");                                               // 범위 없이 다시 동의
    await grant("alice", "optapp");                                             // 선택 권한을 받은 적 없는 사람의 범위 없는 동의
    fresh();
    const d4 = { bob: await getMemberGrant("optapp", "bob"), alice: await getMemberGrant("optapp", "alice"), aliceAct: await getActiveGrant("optapp", "alice"), aliceCats: await asApp("alice", CATS, "optapp") };
    chk("D4 조직 동의가 있는 앱에서 범위 없이 다시 동의 — 스스로 받았던 선택 권한은 이어진다(bob 의 context)",
      sameSet(d4.bob?.scopes, ["memory", "context"]) && sameSet(d4.bob?.tools, TOOLS), J(d4.bob));
    chk("D4 조직 동의가 있는 앱에서 범위 없이 동의 — 받은 적 없는 선택 권한은 생기지 않는다(alice 의 본인 동의 · 유효한 동의 · 호출 403)",
      d4.alice !== null && sameSet(d4.alice?.scopes, ["memory"]) && sameSet(d4.aliceAct?.scopes, ["memory"]) && d4.aliceCats.status === 403, J({ mine: d4.alice, active: d4.aliceAct, cats: d4.aliceCats }));
  });

  // ════ D4 — 조직 동의에 든 scope 가 뒤 판에서 선택 권한이 됐을 때 ════
  //  조직 동의는 «그때의 선언»(E)이라 판 1 에서 필수였던 context 가 조직 동의에 남는다. 판 2 가 context 를 선택 권한으로 바꿔도,
  //  eve 가 범위 없이 동의할 때 «이어지는 선택 권한» 은 eve 가 스스로 받았던 것(없음)뿐이어야 한다 — 조직 동의의 context 가 eve 의 본인 동의로 옮겨 오면 안 된다.
  await step("D4 조직 동의의 scope 가 선택 권한이 된 판", async () => {
    await install(manifest("shift", { scopes: ["memory", "context"], tools: TOOLS }));
    await setOrg("shift");
    await install(manifest("shift", { scopes: ["memory"], optional_scopes: ["context"], tools: TOOLS }, { version: "0.2.0" }));
    fresh();
    const og = (await appGet("shift"))?.org_grant;
    const before = { mine: await getMemberGrant("shift", "eve"), active: await getActiveGrant("shift", "eve") };
    chk("D4 배선(E — 조직 동의는 그때의 선언) — 판이 바뀌어도 조직 동의에는 적을 때의 scope(context)가 그대로 있고 eve 는 본인 동의가 없다",
      sameSet(og?.scopes, ["memory", "context"]) && before.mine === null && before.active?.org_granted === true, J({ og, before }));
    await grant("eve", "shift");
    fresh();
    const mine = await getMemberGrant("shift", "eve");
    chk("D4 범위 없이 동의해도 조직 동의에 있던 scope 가 «선택 권한» 으로 본인 동의에 옮겨 오지 않는다 — eve 가 스스로 받은 적이 없다(본인 동의 = 필수 scope 뿐)",
      mine !== null && sameSet(mine?.scopes, ["memory"]) && sameSet(mine?.tools, TOOLS), J(mine));
  });

  // ── 격리 리뷰 뒤에 더한 절(구현을 본 사람이 썼다 — 위 절들과 달리 블라인드가 아니다) ──
  await step("R 사람이 아닌 구성원 · 「나만」 으로 되돌리기 · 앱 상세의 상태를 보는 사람", async () => {
    await install(manifest("revw", V1));
    await upsertMember({ id: "robot", display_name: "robot", kind: "agent", state: "active", scopes: MEMBER }, "pgt");
    SC.robot = MEMBER;
    await setOrg("revw");
    fresh();
    const human = await getActiveGrant("revw", "alice");
    const robot = await getActiveGrant("revw", "robot");
    chk("R1 조직 동의는 사람 구성원에게만 닿는다 — 활성이어도 kind agent 인 행에는 동의가 없다(목록에도 없다) · 같은 앱에서 사람에게는 닿는다",
      human?.org_granted === true && robot === null && !hasApp(await listActiveGrants("robot"), "revw"), J({ human, robot }));
    await grant("robot", "revw");
    const robotOwn = await getActiveGrant("revw", "robot");
    chk("R1b 그 행이 스스로 한 동의는 종전대로 선다(조직 동의 표시 없이)", robotOwn !== null && robotOwn.org_granted === undefined && sameSet(robotOwn.scopes, ["memory"]), J(robotOwn));

    const asAdmin = (await cap("org_app_get").handler({ app_id: "revw" }, P("admin"), ctx))?.app;
    const asMember = (await cap("org_app_get").handler({ app_id: "revw" }, P("alice"), ctx))?.app;
    const listed = await cap("org_apps").handler({}, P("alice"), ctx);
    const listedRow = (Array.isArray(listed) ? listed : listed?.apps ?? []).find((a) => a?.id === "revw");
    chk("R2 앱 상세의 조직 동의 상태는 관리자 · 책임자에게만 — 다른 구성원에게는 null · 목록의 앱 행에는 적힌 값이 실리지 않는다",
      asAdmin?.org_grant?.covers === true && asMember?.org_grant == null && listedRow !== undefined && !("org_grant" in listedRow),
      J({ a: asAdmin?.org_grant, m: asMember?.org_grant, listedKeys: listedRow && Object.keys(listedRow) }));

    const toMe = await cap("app_visibility_set").handler({ app_id: "revw", visibility: "me" }, P("admin"), ctx);
    fresh();
    const rawMe = (await itemsPool.query(`SELECT org_grant FROM org_app WHERE id=$1`, ["revw"])).rows[0];
    await cap("app_visibility_set").handler({ app_id: "revw", visibility: "all" }, P("admin"), ctx);
    fresh();
    const afterRepublish = await getActiveGrant("revw", "alice");
    chk("R3 「나만」 으로 되돌리면 조직 동의도 거둬진다 — 다시 공개해도 예전 조직 동의가 되살아나지 않는다(관리자가 다시 적어야 한다)",
      toMe?.changed === true && rawMe?.org_grant == null && afterRepublish === null, J({ toMe, rawMe, afterRepublish }));
  });

  // ── PR 리뷰에서 더한 절(구현을 본 사람이 썼다 — 블라인드가 아니다) — 롤 창 ──
  //  매니지드 롤은 새 게이트웨이를 먼저 띄우고 공용 DB 마이그레이션을 맨 끝에 돌린다. 그 사이에는 org_app.org_grant 칸이 없다.
  //  그때 동의 읽기(요청마다 도는 자리)가 42703 으로 깨지면 앱 호출이 전부 막힌다 — 칸이 없으면 «조직 동의 없음» 으로 읽고(본인 동의는 그대로),
  //  조직 동의를 적는 것만 실패해야 한다(닫힌 쪽). 칸을 지웠다가 같은 DDL 로 되살린다 — 맨 끝 절이라 지운 값은 다른 절에 영향이 없다.
  await step("RW 롤 창 — org_grant 칸이 아직 없을 때", async () => {
    await install(manifest("rollw", V1));
    await grant("dana", "rollw");
    await setOrg("rollw");
    fresh();
    const before = await getActiveGrant("rollw", "alice");
    await itemsPool.query(`ALTER TABLE org_app DROP COLUMN org_grant`);
    let rw = null;
    try {
      fresh();
      rw = {
        dana: await tryCall(getActiveGrant("rollw", "dana")), alice: await tryCall(getActiveGrant("rollw", "alice")),
        danaList: await tryCall(listActiveGrants("dana")), aliceList: await tryCall(listActiveGrants("alice")),
        danaMint: await errOf(mintAppToken("dana", "rollw", "pgt")), aliceMint: await errOf(mintAppToken("alice", "rollw", "pgt")),
        danaCall: await asApp("dana", PROJECTS, "rollw"), aliceCall: await asApp("alice", PROJECTS, "rollw"),
        get: await tryCall(cap("org_app_get").handler({ app_id: "rollw" }, P("admin"), ctx)),
        set: await errOf(setOrg("rollw")),
      };
    } finally {
      await itemsPool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS org_grant JSONB`);
    }
    chk("RW1 칸이 없을 때 동의 읽기가 깨지지 않는다 — 본인 동의는 그대로(dana) · 조직 동의만 받던 사람은 동의 없음(alice · 닫힌 쪽)",
      before?.org_granted === true && rw.dana.e === null && sameSet(rw.dana.r?.tools, TOOLS) && rw.dana.r?.org_granted === undefined
        && rw.alice.e === null && rw.alice.r === null, J({ before, dana: rw.dana, alice: rw.alice, err: rw.dana.e?.message ?? rw.alice.e?.message }));
    chk("RW2 칸이 없을 때 동의한 앱 목록도 깨지지 않는다 — dana 에는 들고 alice 에는 없다",
      rw.danaList.e === null && hasApp(rw.danaList.r, "rollw") && rw.aliceList.e === null && !hasApp(rw.aliceList.r, "rollw"),
      J({ dana: rw.danaList, alice: rw.aliceList, err: rw.danaList.e?.message ?? rw.aliceList.e?.message }));
    chk("RW3 칸이 없을 때 진짜 문 — dana 의 앱 토큰 · 앱 서버 호출은 200 · alice 는 종전의 «동의 없음»(403) · 앱 상세는 org_grant 없이 열린다",
      rw.danaMint === null && rw.danaCall.status === 200 && rw.aliceMint?.status === 403 && rw.aliceCall.status === 403
        && rw.get.e === null && rw.get.r?.app?.org_grant == null,
      J({ danaMint: rw.danaMint?.message, danaCall: rw.danaCall, aliceMint: rw.aliceMint?.status, aliceCall: rw.aliceCall.status, get: rw.get.e?.message ?? rw.get.r?.app?.org_grant }));
    chk("RW4 칸이 없을 때 조직 동의를 적는 것은 실패한다(조용히 성공한 척하지 않는다)", rw.set !== null, J({ set: rw.set?.message }));
    const s = await setOrg("rollw");
    fresh();
    const after = await getActiveGrant("rollw", "alice");
    chk("RW5 칸이 생기면 다시 적히고 조직 동의가 닿는다", s?.org_grant?.covers === true && after?.org_granted === true, J({ s, after }));
  });
} catch (e) {
  fail++;
  console.error("FAIL (예외)", e?.stack ?? e);
} finally {
  for (const s of servers) s.close();
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
}
console.log(`\napp-org-grant: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
