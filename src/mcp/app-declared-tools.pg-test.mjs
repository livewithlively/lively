// 앱이 선언한 MCP 도구(#5050 앱 v2-40) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/mcp/app-declared-tools.pg-test.mjs
//
//  무엇을 보나 — 완료 조건 그대로: **세션 머리글 없는 OAuth 토큰**(진짜 인가 흐름: 요청 → 승인 → 코드 교환)으로 실제 /mcp(express + 인증 +
//   요청마다 서버 굽기)에 붙어 tools/list 에 앱의 mcp_tools 가 **보는 사람의 판대로** 서고, 부르면 **실행기 인터페이스**로 넘어간다(시험 실행기 probe).
//   앱은 실제 설치 능력(org_app_install · app_save · app_visibility_set · me_app_grant)으로 깔고, 행 격리 정책을 켠 DB 에 앱 역할
//   (NOSUPERUSER · NOBYPASSRLS)로 붙는다(매니지드 게이트웨이와 같은 조건 — session-apps.pg-test.mjs 와 같은 꼴). 스키마 · 정책은 소유자 자식 프로세스가 건다.
//
//  E19 선언한 앱이 없으면 목록은 종전 그대로 · E1 OAuth 목록(동의함 — 앱 설명 · 앱 표지) · E2 부르기 → 실행기(호출자 = 토큰 구성원 · 표시 이름 ·
//  OAuth 클라이언트 · 검사한 인자 · 판) · 호출 기록(app) · E3 동의 없는 사람(동의 전 표시 · consent_required + 동의 주소 · 실행기 0) ·
//  E4 동의 → 성공 · 철회 → 다시 거절 · E5 초안에만 있는 도구 · E6 공개 판 · 초안 판 각자 · E7 나만 보는 앱(관리자 토큰 포함) · E8 끄기 · 지우기 ·
//  E9 기본 앱 · E10 읽기 전용 · E11 인코그니토 · 앱 토큰 · E12 설치 거부(남 앱 이름 · 조직 도구 이름 · 빌트인 이름 · 모르는 실행기 · 자기 재설치 통과) ·
//  E13 약속 지문(level 바뀜 → tool_changed · 설명만 바뀜 → 실행) · E14 워크스페이스 B(같은 이름 · 동의 · 도구가 A 에 안 샘) · E15 인자 ·
//  E16 실행기 오류 · E17 결과 상한 · E18 scope 없는 토큰 · E20 이름 겹침(먼저 설치된 앱) · E21 공개 주소 모름 ·
//  E6b 초안이 mcp_tools 칸을 통째로 뺀 공개 앱(공개 판 갈래) · E12b 되돌리기(app_revert)도 이름 검사 · E12c 같은 이름 동시 설치는 하나만 ·
//  E12d 조직 도구를 앱 도구 이름으로 못 만든다 · E12e 도구 묶음(프리셋) 이름 · E12f 이미 겹친 조직 도구는 고칠 수 있다 · E12g 이름 자리 대기 초과 · E22 비활성 구성원 ·
//  E23 비용 — 선언한 앱이 없으면 MCP 요청마다 쿼리 1번 · 실행기가 없으면 0번
//  G0 · G1 배선 — 정책 · 앱 역할 · 시험 실행기가 실제로 불렸다
import "../../scripts/test-apps-root.mjs";   // #4778 앱 폴더 자리를 임시 폴더로 — 앱을 만들고 지우는 시험이 실제 ~/apps 를 옮기지 않게
import pg from "pg";
import crypto from "node:crypto";
import http from "node:http";
import { execFileSync } from "node:child_process";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_mcp_tools_5050";
const ROLE = `lvly_app_${DB}`;            // org/tenancy/activate.ts appRoleName(current_database()) 과 같은 이름 — 정책이 이 역할에 걸린다
const ROLE_PW = crypto.randomBytes(16).toString("hex");
const dsnFor = (db, user) => { const u = new URL(BASE); u.pathname = "/" + db; if (user) { u.username = user.name; u.password = user.pw; } return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`DROP ROLE IF EXISTS ${ROLE}`);
const OWNER_DSN = dsnFor(DB);
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
let dbc = null, itemsPool = null, server = null;

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const J = (x) => JSON.stringify(x);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
//  A = 기본 워크스페이스(db/tenant-column SINGLE_TENANT_ID — 아래 G0b 가 대조한다). 이 DB 모양(자가호스팅 다중 워크스페이스 · ensureTenantPolicies)에서
//   구성원 · 토큰 · OAuth 표는 «신원 전역 표»(IDENTITY_GLOBAL_TABLES)라 기본 워크스페이스 자리에 산다 — OAuth 승인(getMember)이 A 에서 사람을 찾는다.
//   B 는 둘째 워크스페이스(정책이 걸린 콘텐츠 표만 갈린다). 그 앞에서 tenant-column 을 불러오면 풀이 슈퍼유저 접속으로 먼저 만들어져 문자로 둔다.
const TA = "00000000-0000-0000-0000-000000000000", TB = crypto.randomUUID();
let CUR = TA;
const inB = async (fn) => { const prev = CUR; CUR = TB; try { return await fn(); } finally { CUR = prev; } };

try {
  await su.query(`CREATE DATABASE ${DB}`);
  await su.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  dbc = new pg.Client({ connectionString: OWNER_DSN }); await dbc.connect();
  await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG — 렉시컬 폴백 */ });

  // ── 스키마 + 행 격리 정책 — 소유자 자식 프로세스(이 프로세스의 풀은 앱 역할로 붙어야 한다) ──
  const childEnv = { ...process.env, ITEMS_DATABASE_URL: OWNER_DSN };
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID"]) delete childEnv[k];
  const policyOut = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { initAllSchemas } = await import(${J(`${D}/boot/schemas.js`)});
    await initAllSchemas({ quiet: true });
    const { ensureTenantPolicies } = await import(${J(`${D}/org/tenancy/activate.js`)});
    const r = await ensureTenantPolicies();
    const { itemsPool } = await import(${J(`${D}/db/client.js`)});
    await itemsPool.end();
    process.stdout.write("\\n@@policies " + JSON.stringify(r) + "\\n");
    process.exit(0);`], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 300_000 });
  const policies = (() => { try { return JSON.parse(/^@@policies (.+)$/m.exec(policyOut)?.[1] ?? "null"); } catch { return null; } })();
  await dbc.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);

  // 이 프로세스는 앱 역할로 — 정책이 걸리는 자리. 테넌트는 위 CUR 이 정한다.
  process.env.ITEMS_DATABASE_URL = dsnFor(DB, { name: ROLE, pw: ROLE_PW });
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_MCP_SESSIONED"]) delete process.env[k];
  const client = await import(`${D}/db/client.js`);
  itemsPool = client.itemsPool;
  client.installTenantResolver(() => CUR);

  const express = (await import("express")).default;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
  const { bearerWithResourceMetadata } = await import(`${D}/auth/http-auth.js`);
  const { resetResourceIdCache } = await import(`${D}/auth/resource-id.js`);
  const { registerMcpTransport } = await import(`${D}/boot/mcp-transport.js`);
  const { buildToolCandidates } = await import(`${D}/capabilities/index.js`);
  const { setToolCandidates } = await import(`${D}/mcp/mcp-surface.js`);
  const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
  const { upsertMember } = await import(`${D}/org/store/members.js`);
  const { mintToken } = await import(`${D}/org/store/tokens.js`);
  const oauth = await import(`${D}/org/store/oauth.js`);
  const { registerAppMcpExecutor } = await import(`${D}/apps/app-mcp-executors.js`);
  const { appMcpToolsOf, appMcpToolContract } = await import(`${D}/apps/app-mcp-decl.js`);
  const { callAppDeclaredTool, registerAppDeclaredTools } = await import(`${D}/mcp/app-declared-tools.js`);
  const { withMcpToolNamesLock, MCP_TOOL_NAMES_LOCK } = await import(`${D}/apps/app-mcp-store.js`);
  const { appInstallLockKey } = await import(`${D}/org/store/apps.js`);
  const { toolsCapabilities } = await import(`${D}/capabilities/delivery/tools.js`);
  const { HttpError } = await import(`${D}/http-error.js`);
  setToolCandidates(buildToolCandidates());   // 부팅(index.ts)과 같게 — 빌트인 이름 충돌 검사가 실제 표면을 본다
  const { SINGLE_TENANT_ID } = await import(`${D}/db/tenant-column.js`);
  chk("G0b 배선 — 시험의 워크스페이스 A 는 기본 워크스페이스 자리(신원 전역 표가 사는 곳)", TA === SINGLE_TENANT_ID, SINGLE_TENANT_ID);

  chk("G0 스키마 · 정책 자식 프로세스가 콘텐츠 표에 정책을 걸었다", Number(policies?.tables) > 0, policyOut.slice(-300));
  const role = (await itemsPool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  const ISOLATED = ["org_app", "org_app_version", "org_app_grant", "org_tool"];
  //  한 클라이언트(dbc)에 쿼리를 겹쳐 보내지 않는다 — pg 가 경고하고(pg@9 에서 없어진다) 차례로 줄 세운다. 표마다 차례로.
  const rels = [];
  for (const t of ISOLATED) {
    rels.push({
      t, ...(await dbc.query(`SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE relname=$1 AND relkind='r'`, [t])).rows[0],
      pols: (await dbc.query(`SELECT polname FROM pg_policy WHERE polrelid=$1::regclass`, [t])).rows.map((r) => r.polname),
    });
  }
  chk("G1 앱 역할은 슈퍼유저 · BYPASSRLS 가 아니고, 이 기능이 읽는 넷(org_app · org_app_version · org_app_grant · org_tool) 모두 FORCE RLS · tenant_isolation",
    role && role.rolsuper === false && role.rolbypassrls === false && rels.every((r) => r.on === true && r.forced === true && r.pols.includes("tenant_isolation")), J({ role, rels }));

  // ── 게이트웨이(실제 /mcp — 인증 · 요청마다 서버) ──
  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  registerMcpTransport(gw, bearerWithResourceMetadata(new BearerVerifier()));
  server = http.createServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const GW = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = GW;                 // 자원 식별자(OAuth audience) · 동의 주소의 base
  resetResourceIdCache();

  // ── 시험 실행기 — 받은 부르기를 그대로 적고, 이름에 따라 오류 · 큰 결과를 낸다 ──
  const calls = [];
  const probe = {
    kind: "probe",
    call: async (c) => {
      calls.push(c);
      //  글 끝의 짝 없는 대리 글자 — 실행기가 낸 오류 글도 게이트웨이가 온전한 글자로 고쳐 싣는다(U+FFFD).
      if (c.tool.name === "boom_http") throw new HttpError(503, "앱이 지금 바쁩니다\uD83D", { body: { code: "app_server_busy" } });
      if (c.tool.name === "boom") throw new Error("secret internals 1234");
      if (c.tool.name === "big") return { data: "가".repeat(100_000) };   // 300,000바이트 > 256KiB
      return { data: { rows: [{ tool: c.tool.name, who: c.caller.userId, args: c.args, tag: c.tool.run.tag ?? null }] } };
    },
  };
  let offProbe = registerAppMcpExecutor(probe);
  const callsOf = (name) => calls.filter((c) => c.tool.name === name);

  // ── 사람 · 토큰(A) — OAuth 는 진짜 인가 흐름으로 받는다 ──
  const MEMBER_SCOPES = ["items", "context", "memory"];
  for (const [id, nm, sc] of [["alice", "앨리스", MEMBER_SCOPES], ["bob", "밥", MEMBER_SCOPES], ["dana", "다나", MEMBER_SCOPES], ["owen", "오웬", MEMBER_SCOPES],
    ["boss", "관리자", [...MEMBER_SCOPES, "admin"]], ["nosc", "스코프없음", ["items"]]]) {
    await upsertMember({ id, display_name: nm, state: "active", scopes: sc }, "pgt");
  }
  const CID = "pgt-mcp-client-5050", REDIR = "https://client.invalid/cb";
  await oauth.saveClient({ clientId: CID, kind: "static", clientName: "시험 커넥터", redirectUris: [REDIR] });
  const oauthToken = async (member) => {
    const rid = await oauth.createAuthRequest({ clientId: CID, redirectUri: REDIR, codeChallenge: "x".repeat(43), scopes: [], state: "s", resource: `${GW}/mcp` });
    const g = await oauth.approveAuthRequest(rid, member);
    if (!g) throw new Error(`OAuth 승인 실패(${member})`);
    const r = await oauth.redeemAuthCode({ clientId: CID, code: g.code, redirectUri: REDIR, resource: `${GW}/mcp` });
    if (!r?.accessToken) throw new Error(`OAuth 코드 교환 실패(${member})`);
    return r.accessToken;
  };
  const tok = { alice: await oauthToken("alice"), bob: await oauthToken("bob"), dana: await oauthToken("dana"), owen: await oauthToken("owen") };
  tok.boss = (await mintToken({ userId: "boss", memberId: "boss", scopes: [...MEMBER_SCOPES, "admin"] }, "pgt")).token;   // 관리자 — OAuth 는 admin 을 안 내준다
  tok.nosc = (await mintToken({ userId: "nosc", memberId: "nosc", scopes: ["items"] }, "pgt")).token;
  const verifier = new BearerVerifier();
  const userOf = async (t) => (await verifier.verifyAccessToken(t)).extra;
  const extraOf = async (t) => ({ authInfo: { extra: await userOf(t) } });

  const mcp = async (t, headers = {}) => {
    const c = new Client({ name: "pgt", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${GW}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t}`, ...headers } } }));
    return {
      //  도구가 하나도 없는 서버(인코그니토 — 빈 표면)는 tools 기능 자체를 알리지 않아 tools/list 가 -32601 이다 — 빈 목록으로 읽는다.
      list: async () => { try { return (await c.listTools()).tools; } catch (e) { if (/-32601/.test(String(e?.message))) return []; throw e; } },
      call: async (name, args = {}) => { try { return await c.callTool({ name, arguments: args }); } catch (e) { return { thrown: String(e?.message ?? e) }; } },
      close: () => c.close().catch(() => undefined),
    };
  };
  const toolMap = (tools) => new Map(tools.map((x) => [x.name, x]));
  const textOf = (r) => (r?.content ?? []).map((b) => b.text ?? "").join("");

  // ── 앱 설치 — 실제 설치 능력 ──
  const cap = (n) => appCapabilities.find((c) => c.name === n);
  const ctx = { source: "mcp" };
  const P = (id, admin = false) => ({ userId: id, email: `${id}@x.invalid`, scopes: admin ? [...MEMBER_SCOPES, "admin"] : MEMBER_SCOPES });
  const files = (id, title, tools, extra = {}) => [{ path: "lively-app.json", content: J({ id, title, version: "0.1.0", mcp_tools: tools, ...extra }) }];
  const install = (id, title, tools, by = "boss") => cap("org_app_install").handler({ source: { kind: "inline", files: files(id, title, tools) } }, P(by, true), ctx);
  const save = (who, id, title, tools) => cap("app_save").handler({ files: files(id, title, tools) }, P(who), ctx);
  const grant = (who, app) => cap("me_app_grant").handler({ app_id: app }, P(who), ctx);
  const revoke = (who, app) => cap("me_app_revoke").handler({ app_id: app }, P(who), ctx);
  const T = (name, o = {}) => ({ name, description: `${name} — 앱이 쓴 설명`, level: "L0", run: { kind: "probe" }, ...o });
  const CRM = [
    T("lookup", { input: { type: "object", properties: { q: { type: "string", description: "찾을 말" }, limit: { type: "integer" } }, required: ["q"] } }),
    T("propose", { level: "L1", input: { type: "object", properties: { kind: { type: "string" } } } }),
    T("boom_http"), T("boom"), T("big"),
  ];

  // ── E19 선언한 앱이 하나도 없을 때 — 목록은 종전 그대로(새 도구 0 · 오류 없음) ──
  const a0 = await mcp(tok.alice);
  const before = (await a0.list()).map((x) => x.name);
  await a0.close();
  chk("E19 선언한 앱이 없으면 목록은 종전 그대로 — 기본 표면이 서고 앱 도구는 없다", before.length > 50 && !before.includes("lookup"), `n=${before.length}`);
  //  쿼리 수 — 이 프로세스의 풀은 쿼리마다 테넌트 리졸버를 한 번 부른다(db/client tenantBindingSql). 그 횟수로 센다.
  //  앞 단계가 기다리지 않고 던진 쿼리(토큰 사용 시각 기록 등)가 끝나기를 잠깐 기다린 뒤 센다 — 그 쿼리가 세는 구간에 끼면 하나 더 센다.
  const queriesOf = async (fn) => {
    await new Promise((r) => setTimeout(r, 500));
    let q = 0; client.installTenantResolver(() => { q++; return CUR; });
    try { await fn(); } finally { client.installTenantResolver(() => CUR); }
    return q;
  };
  const fakeSrv = () => ({ registerTool: () => undefined });
  const aliceUser = await userOf(tok.alice);
  const q1 = await queriesOf(() => registerAppDeclaredTools(fakeSrv(), aliceUser, { readOnly: false }));
  offProbe();
  const q0 = await queriesOf(() => registerAppDeclaredTools(fakeSrv(), aliceUser, { readOnly: false }));
  offProbe = registerAppMcpExecutor(probe);
  chk("E23 비용 — 선언한 앱이 없는 워크스페이스는 MCP 요청마다 쿼리 1번 · 실행기가 하나도 없는 코어는 0번", q1 === 1 && q0 === 0, J({ q1, q0 }));

  await install("crm", "고객 관리", CRM);
  await install("wiki", "정책 위키", [T("shared_q", { description: "공개 설명", run: { kind: "probe", tag: "pub" } })]);
  await save("dana", "wiki", "정책 위키(고치는 중)", [T("shared_q", { description: "초안 설명", run: { kind: "probe", tag: "draft" } }), T("draft_only")]);
  await save("owen", "mine", "오웬의 앱", [T("mine_q")]);
  await install("off", "끌 앱", [T("off_q")]);
  //  기본 앱 — 설치 능력이 아니라 시딩이 까는 자리라 행으로 둔다(앱 역할 · 이 워크스페이스).
  await itemsPool.query(`INSERT INTO org_app(id, title, version, manifest, source, content_hash, status, enabled, current_version_no)
     VALUES('builtin-x','기본 앱','0.1.0',$1::jsonb,'{"kind":"builtin"}'::jsonb,'hb','active',true,1)`, [J({ id: "builtin-x", title: "기본 앱", version: "0.1.0", mcp_tools: [T("builtin_q")] })]);
  const wikiRow = (await itemsPool.query(`SELECT visibility, draft_by, published_version_no FROM org_app WHERE id='wiki'`)).rows[0];
  const mineRow = (await itemsPool.query(`SELECT visibility, owner_member FROM org_app WHERE id='mine'`)).rows[0];
  chk("E0 배선 — wiki 는 공개 앱에 다나의 초안이 걸렸고 mine 은 오웬의 나만 보는 앱", wikiRow?.visibility === "all" && wikiRow?.draft_by === "dana" && wikiRow?.published_version_no != null
    && mineRow?.visibility === "me" && mineRow?.owner_member === "owen", J({ wikiRow, mineRow }));
  await grant("alice", "crm"); await grant("alice", "wiki"); await grant("alice", "off");
  await grant("dana", "wiki"); await grant("owen", "mine");

  // ── E1 · E2 ──
  const A = await mcp(tok.alice);
  const al = toolMap(await A.list());
  const lk = al.get("lookup");
  chk("E1 세션 머리글 없는 OAuth 토큰 — 동의한 앱의 도구가 앱이 쓴 설명 · 입력 · 앱 표지로 선다",
    !!lk && lk.description === "lookup — 앱이 쓴 설명" && lk._meta?.["lively/app"] === "crm" && lk.annotations?.readOnlyHint === true
      && lk.inputSchema?.properties?.q?.description === "찾을 말" && J(lk.inputSchema?.required) === J(["q"])
      && al.get("propose")?.annotations?.readOnlyHint === false, J(lk));
  const r2 = await A.call("lookup", { q: "보험", limit: 3, extra: "버려질 칸" });
  const c2 = callsOf("lookup").at(-1);
  chk("E2 부르면 실행기가 받는다 — 호출자 = 토큰의 구성원 · 표시 이름 · OAuth 클라이언트 · 동의 · 검사한 인자(선언 밖 칸 없음) · 판",
    !r2.isError && J(JSON.parse(textOf(r2))) === J({ rows: [{ tool: "lookup", who: "alice", args: { q: "보험", limit: 3 }, tag: null }] })
      && c2?.caller.userId === "alice" && c2?.caller.name === "앨리스" && c2?.caller.oauthClientId === CID
      && c2?.caller.tokenScopes.includes("memory") && !c2?.caller.tokenScopes.includes("admin") && Array.isArray(c2?.caller.grant?.scopes)
      && c2?.caller.scopes.every((s) => c2.caller.tokenScopes.includes(s) && c2.caller.grant.scopes.includes(s))
      && J(c2?.args) === J({ q: "보험", limit: 3 }) && c2?.app.id === "crm" && c2?.app.view === "installed" && c2?.app.variant === "pub",
    J({ r2, c2: c2 && { caller: c2.caller, args: c2.args, app: c2.app } }));
  let logRow = null;
  for (let i = 0; i < 40 && !logRow; i++) {
    logRow = (await itemsPool.query(`SELECT actor, app, ok FROM mcp_call_log WHERE tool='lookup' ORDER BY id DESC LIMIT 1`)).rows[0] ?? null;
    if (!logRow) await new Promise((r) => setTimeout(r, 50));
  }
  chk("E2b 호출 기록(mcp_call_log)에 그 앱으로 남는다 — actor 는 토큰의 사람", logRow?.actor === "alice" && logRow?.app === "crm" && logRow?.ok === true, J(logRow));

  // ── E3 · E4 ──
  const B = await mcp(tok.bob);
  const bl = toolMap(await B.list());
  const blk = bl.get("lookup");
  chk("E3a 동의 없는 사람 — 목록엔 서되 앱이 쓴 설명 · 입력 설명이 없다(게이트웨이 글 · 빈 입력)",
    !!blk && !/앱이 쓴 설명|찾을 말/.test(J(blk)) && /동의하지 않아/.test(blk.description) && /고객 관리 · lookup \(동의 필요\)/.test(blk.title ?? "")
      && J(Object.keys(blk.inputSchema?.properties ?? {})) === "[]", J(blk));
  const n3 = calls.length;
  const r3 = await B.call("lookup", { q: "보험" });
  chk("E3b 부르면 consent_required + 동의 주소(from=mcp) · 실행기는 안 불린다",
    r3.isError === true && r3._meta?.["lively/code"] === "consent_required" && r3._meta?.["lively/consent_url"] === `${GW}/ui/#/app-grant/crm?v=pub&from=mcp`
      && /동의/.test(textOf(r3)) && calls.length === n3, J(r3));
  await grant("bob", "crm");
  const B2 = await mcp(tok.bob);
  const r4 = await B2.call("lookup", { q: "동의 뒤" });
  chk("E4a 동의하면 같은 사람에게 앱 설명이 보이고 부르기가 실행기로 간다",
    (await B2.list()).find((x) => x.name === "lookup")?.description === "lookup — 앱이 쓴 설명" && !r4.isError && callsOf("lookup").at(-1)?.caller.userId === "bob", J(r4));
  await revoke("bob", "crm");
  const n4 = calls.length;
  const r4b = await B2.call("lookup", { q: "철회 뒤" });
  chk("E4b 동의를 거두면 다시 consent_required · 실행기 0", r4b._meta?.["lively/code"] === "consent_required" && calls.length === n4, J(r4b));

  // ── E5 · E6 ──
  const Dn = await mcp(tok.dana);
  const dl = toolMap(await Dn.list());
  chk("E5a 초안에만 있는 도구는 초안을 만든 사람에게만 선다", dl.has("draft_only") && !al.has("draft_only") && !bl.has("draft_only"), J([...dl.keys()].filter((k) => /_q$|draft/.test(k))));
  const n5 = calls.length;
  const r5 = await A.call("draft_only", {});
  chk("E5b 남이 그 이름으로 불러도 없는 도구 — 실행기 0", (r5.isError === true || !!r5.thrown) && calls.length === n5, J(r5));
  const r6d = await Dn.call("shared_q", {});
  const c6d = callsOf("shared_q").at(-1);
  const r6a = await A.call("shared_q", {});
  const c6a = callsOf("shared_q").at(-1);
  chk("E6 공개 판과 초안 판이 다르면 각자 자기 판 — 설명 · run 칸 · view · variant",
    dl.get("shared_q")?.description === "초안 설명" && al.get("shared_q")?.description === "공개 설명"
      && !r6d.isError && c6d?.tool.run.tag === "draft" && c6d?.app.view === "installed" && c6d?.app.variant === "draft" && c6d?.caller.userId === "dana"
      && !r6a.isError && c6a?.tool.run.tag === "pub" && c6a?.app.view === "published" && c6a?.app.variant === "pub" && c6a?.caller.userId === "alice",
    J({ d: c6d && { run: c6d.tool.run, app: c6d.app }, a: c6a && { run: c6a.tool.run, app: c6a.app } }));
  //  공개 앱에 건 초안이 mcp_tools 칸을 통째로 뺐다 — 설치된 상태(초안)엔 칸이 없고 공개 판에만 있다. 목록 쿼리의 공개 판 갈래(v.manifest ? 'mcp_tools')가 이 앱을 고른다.
  const namesOf = async (t) => { const c = await mcp(t); try { return (await c.list()).map((x) => x.name); } finally { await c.close(); } };
  await install("pubonly", "공개만 도구", [T("pub_only_q")]);
  await save("dana", "pubonly", "공개만 도구(초안)", undefined);
  const pubRow = (await itemsPool.query(`SELECT draft_by, manifest ? 'mcp_tools' AS has FROM org_app WHERE id='pubonly'`)).rows[0];
  const l6bA = await namesOf(tok.alice);
  const l6bD = await namesOf(tok.dana);
  chk("E6b 공개 앱의 초안이 mcp_tools 칸을 통째로 빼도 다른 사람에게는 공개 판 도구가 선다 · 초안을 고친 사람에게는 안 선다",
    pubRow?.draft_by === "dana" && pubRow?.has === false && l6bA.includes("pub_only_q") && !l6bD.includes("pub_only_q"),
    J({ pubRow, alice: l6bA.includes("pub_only_q"), dana: l6bD.includes("pub_only_q") }));

  // ── E7 ──
  const O = await mcp(tok.owen);
  const Bs = await mcp(tok.boss);
  const ol = toolMap(await O.list());
  const bsl = toolMap(await Bs.list());
  chk("E7 나만 보는 앱 — 책임자에게만 선다(다른 구성원 · 관리자 토큰에도 안 선다)", ol.has("mine_q") && !al.has("mine_q") && !bl.has("mine_q") && !bsl.has("mine_q") && bsl.has("lookup"), J({ o: ol.has("mine_q"), boss: bsl.has("mine_q") }));
  await grant("alice", "mine").catch(() => undefined);   // 남의 나만 보는 앱엔 동의도 못 한다 — 동의가 있다고 쳐도 부르기가 막히는지 본다
  await dbc.query(`INSERT INTO org_app_grant(tenant_id, app_id, member_id, scopes, tools) VALUES($1,'mine','alice','[]'::jsonb,'[]'::jsonb) ON CONFLICT DO NOTHING`, [TA]);
  const mineRef = { appId: "mine", name: "mine_q", contract: appMcpToolContract(appMcpToolsOf({ mcp_tools: [T("mine_q")] })[0]), readOnly: false };
  const n7 = calls.length;
  const r7 = await callAppDeclaredTool(mineRef, {}, await extraOf(tok.alice));
  const r7o = await callAppDeclaredTool(mineRef, {}, await extraOf(tok.owen));
  chk("E7b 남의 나만 보는 앱 도구를 이름으로 직접 불러도 tool_unavailable(동의 행이 있어도) · 책임자는 된다", r7._meta?.["lively/code"] === "tool_unavailable" && calls.length === n7 + 1 && !r7o.isError && calls.at(-1)?.caller.userId === "owen", J({ r7, r7o }));
  //  관리자는 남의 나만 보는 앱을 «열 수» 있다(canSeeApp — 관리 화면에서 보고 지우려고). 그래도 그 앱의 도구는 목록에도 부르기에도 없다(listsAppFor).
  await dbc.query(`INSERT INTO org_app_grant(tenant_id, app_id, member_id, scopes, tools) VALUES($1,'mine','boss','[]'::jsonb,'[]'::jsonb) ON CONFLICT DO NOTHING`, [TA]);
  const n7c = calls.length;
  const r7c = await callAppDeclaredTool(mineRef, {}, await extraOf(tok.boss));
  chk("E7c 관리자가 남의 나만 보는 앱 도구를 이름으로 직접 불러도 tool_unavailable(동의 행이 있어도) · 실행기 0", r7c._meta?.["lively/code"] === "tool_unavailable" && calls.length === n7c, J(r7c));

  // ── E9 · E10 · E11 ──
  chk("E9 기본 앱(builtin)의 도구는 서지 않는다", !al.has("builtin_q") && !bsl.has("builtin_q"));
  const RO = await mcp(tok.alice, { "x-lively-mode": "readonly" });
  const rol = toolMap(await RO.list());
  chk("E10a 읽기 전용 연결 — L0(lookup) 은 서고 L1(propose) 은 안 선다", rol.has("lookup") && !rol.has("propose") && al.has("propose"));
  const lookupDecl = appMcpToolsOf({ mcp_tools: CRM });
  const refOf = (app, d, readOnly = false) => ({ appId: app, name: d.name, contract: appMcpToolContract(d), readOnly });
  const proposeD = lookupDecl.find((d) => d.name === "propose");
  const n10 = calls.length;
  const r10 = await callAppDeclaredTool(refOf("crm", proposeD, true), { kind: "x" }, await extraOf(tok.alice));
  chk("E10b 읽기 전용 연결에서 L1 을 직접 불러도 거절(read_only) · 실행기 0", r10.isError && r10._meta?.["lively/code"] === "read_only" && calls.length === n10, J(r10));
  const IN = await mcp(tok.alice, { "x-lively-mode": "incognito" });
  const inl = (await IN.list()).map((x) => x.name);
  const appTok = (await mintToken({ userId: "alice", memberId: "alice", scopes: MEMBER_SCOPES, appId: "crm" }, "pgt")).token;
  const AT = await mcp(appTok);
  const atl = (await AT.list()).map((x) => x.name);
  chk("E11 인코그니토 · 앱 토큰에는 앱 도구가 서지 않는다(★5)", !inl.includes("lookup") && atl.length > 0 && !atl.includes("lookup") && !atl.includes("shared_q"), J({ inl: inl.length, atl: atl.length }));
  const r11 = await callAppDeclaredTool(refOf("crm", lookupDecl[0]), { q: "x" }, await extraOf(appTok));
  chk("E11b 앱 토큰으로 직접 불러도 거절(app_token)", r11.isError && r11._meta?.["lively/code"] === "app_token", J(r11));

  // ── E12 설치 거부 ──
  await itemsPool.query(`INSERT INTO org_tool(name, kind, enabled, scope) VALUES('proxy_name','http_proxy',false,'memory')`);
  const e12a = await errOf(install("dup-app", "겹치는 앱", [T("lookup")]));
  const e12b = await errOf(install("dup-two", "조직 도구와 겹침", [T("proxy_name")]));
  const e12c = await errOf(install("dup-three", "빌트인과 겹침", [T("knowledge_search")]));
  const e12d = await errOf(install("dup-four", "모르는 실행기", [T("srv_q", { run: { kind: "server", route: "/api/tools/x" } })]));
  const e12e = await errOf(save("bob", "dup-five", "구성원이 겹치게", [T("shared_q")]));
  const gone12 = (await itemsPool.query(`SELECT id FROM org_app WHERE id = ANY($1::text[])`, [["dup-app", "dup-two", "dup-three", "dup-four", "dup-five"]])).rows;
  const e12f = await errOf(install("crm", "고객 관리", CRM));
  chk("E12 설치 거부 — 남 앱 이름 409 · 조직 도구 이름 409 · 빌트인 이름 400 · 모르는 실행기 400 · 구성원 저장(app_save)도 409 · 아무 앱도 안 생김 · 자기 재설치는 통과",
    e12a?.status === 409 && /'lookup'/.test(e12a.message) && e12b?.status === 409 && /'proxy_name'/.test(e12b.message)
      && e12c?.status === 400 && /빌트인/.test(e12c.message) && e12d?.status === 400 && /모르는 실행기/.test(e12d.message)
      && e12e?.status === 409 && /'shared_q'/.test(e12e.message) && gone12.length === 0 && e12f === null,
    J({ a: [e12a?.status, e12a?.message], b: [e12b?.status, e12b?.message], c: [e12c?.status, e12c?.message], d: [e12d?.status, e12d?.message], e: [e12e?.status, e12e?.message], gone12, f: e12f?.message }));

  // ── E13 약속 지문 ──
  const oldRef = refOf("crm", lookupDecl[0]);
  await install("crm", "고객 관리", CRM.map((x) => (x.name === "lookup" ? { ...x, level: "L1" } : x)));
  const n13 = calls.length;
  const r13a = await callAppDeclaredTool(oldRef, { q: "x" }, await extraOf(tok.alice));
  chk("E13a 목록 뒤 level 이 바뀌면(L0 → L1) 옛 목록의 ref 로 부른 것(sessioned 모드 — 등록한 서버가 요청을 넘어 산다)은 tool_changed · 실행기 0", r13a.isError && r13a._meta?.["lively/code"] === "tool_changed" && calls.length === n13, J(r13a));
  await install("crm", "고객 관리", CRM.map((x) => (x.name === "lookup" ? { ...x, description: "설명만 바꿈" } : x)));
  const r13b = await callAppDeclaredTool(oldRef, { q: "x" }, await extraOf(tok.alice));
  chk("E13b 설명만 바뀐 것은 같은 약속 — 그대로 실행", !r13b.isError && callsOf("lookup").at(-1)?.tool.description === "설명만 바꿈", J(r13b));

  // ── E12b 되돌리기도 이름 검사를 지난다 ──
  await save("dana", "rv", "되돌릴 앱", [T("rv_q")]);
  await save("dana", "rv", "되돌릴 앱", []);
  await install("rv-taker", "이름을 가져간 앱", [T("rv_q")]);
  const v1 = (await itemsPool.query(`SELECT version_no FROM org_app_version WHERE app_id='rv' AND manifest->'mcp_tools' @> '[{"name":"rv_q"}]'::jsonb ORDER BY version_no LIMIT 1`)).rows[0]?.version_no;
  const eRv = await errOf(cap("app_revert").handler({ app_id: "rv", version_no: Number(v1) }, P("dana"), ctx));
  const rvNow = (await itemsPool.query(`SELECT manifest->'mcp_tools' AS t FROM org_app WHERE id='rv'`)).rows[0]?.t;
  chk("E12b 그 이름을 다른 앱이 가져간 뒤 옛 판으로 되돌리면 409 · 앱은 그대로(도구 없음)", v1 != null && eRv?.status === 409 && /'rv_q'/.test(eRv.message) && J(rvNow) === "[]", J({ v1, eRv: eRv && [eRv.status, eRv.message], rvNow }));

  // ── E12c 같은 이름 동시 설치 ──
  const race = await Promise.allSettled([install("race-a", "경주 A", [T("race_q")]), install("race-b", "경주 B", [T("race_q")])]);
  const won = race.filter((r) => r.status === "fulfilled").length;
  const lost = race.filter((r) => r.status === "rejected" && r.reason?.status === 409).length;
  const raceRows = (await itemsPool.query(`SELECT id FROM org_app WHERE id IN ('race-a','race-b') AND manifest->'mcp_tools' @> '[{"name":"race_q"}]'::jsonb`)).rows;
  chk("E12c 다른 두 앱이 같은 이름으로 동시에 설치하면 하나만 되고 다른 하나는 409(도구 이름 자리 잠금)", won === 1 && lost === 1 && raceRows.length === 1,
    J({ race: race.map((r) => (r.status === "fulfilled" ? "ok" : `${r.reason?.status} ${r.reason?.message}`)), raceRows }));

  // ── E12d 반대 방향 — 조직 도구(http_proxy)를 앱 도구 이름으로 ──
  const eTool = await errOf(toolsCapabilities.find((c) => c.name === "org_tool_upsert").handler({ name: "lookup", kind: "http_proxy", url: "https://example.invalid/api" }, P("boss", true), ctx));
  const eToolOk = await errOf(toolsCapabilities.find((c) => c.name === "org_tool_upsert").handler({ name: "free_proxy_name", kind: "http_proxy", url: "https://example.invalid/api" }, P("boss", true), ctx));
  chk("E12d 앱이 선언한 이름으로 조직 도구를 만들면 409(앱 도구가 말없이 가려지지 않게) · 겹치지 않는 이름은 된다", eTool?.status === 409 && /'lookup'/.test(eTool.message) && eToolOk === null, J({ eTool: eTool && [eTool.status, eTool.message], eToolOk: eToolOk?.message }));

  // ── E12e 도구 묶음(프리셋) 이름 — 아직 심지 않았어도 앱이 못 쓴다 ──
  const presetTools = (await itemsPool.query(`SELECT name FROM org_tool WHERE name IN ('github_get_issue','slack_send_message')`)).rows;
  const ePreset = await errOf(install("dup-preset", "묶음 이름", [T("github_get_issue")]));
  const ePresetSave = await errOf(save("bob", "dup-preset-b", "묶음 이름(구성원)", [T("slack_send_message")]));
  const presetRows = (await itemsPool.query(`SELECT id FROM org_app WHERE id IN ('dup-preset','dup-preset-b')`)).rows;
  chk("E12e 라이블리 도구 묶음(프리셋) 이름은 아직 심지 않았어도 400 — 설치 · 구성원 저장 둘 다 · 아무 앱도 안 생김",
    presetTools.length === 0 && ePreset?.status === 400 && /도구 묶음/.test(ePreset.message) && /'github_get_issue'/.test(ePreset.message)
      && ePresetSave?.status === 400 && /'slack_send_message'/.test(ePresetSave.message) && presetRows.length === 0,
    J({ presetTools, ePreset: ePreset && [ePreset.status, ePreset.message], ePresetSave: ePresetSave && [ePresetSave.status, ePresetSave.message], presetRows }));

  // ── E12f 이미 겹친 조직 도구도 고치고 끌 수 있다 — 겹침은 검사 밖의 틈에서만 생긴다(여기선 앱 행을 바로 고쳐 만든다) ──
  await install("clash-app", "겹친 앱", [T("clash_q")]);
  await itemsPool.query(`UPDATE org_app SET manifest = jsonb_set(manifest, '{mcp_tools,0,name}', '"free_proxy_name"') WHERE id='clash-app'`);
  const eEdit = await errOf(toolsCapabilities.find((c) => c.name === "org_tool_upsert").handler({ name: "free_proxy_name", kind: "http_proxy", url: "https://example.invalid/v2", enabled: false }, P("boss", true), ctx));
  const edited = (await itemsPool.query(`SELECT enabled, url FROM org_tool WHERE name='free_proxy_name'`)).rows[0];
  await cap("org_app_remove").handler({ app_id: "clash-app" }, P("boss", true), ctx);
  chk("E12f 앱 도구와 이미 겹친 조직 도구는 고치고 끌 수 있다(새 이름만 409)", eEdit === null && edited?.enabled === false && edited?.url === "https://example.invalid/v2",
    J({ eEdit: eEdit && [eEdit.status, eEdit.message], edited }));

  // ── E12g 도구 이름 자리를 못 잡으면 — 잠금의 속 이름 대신 까닭(409) · 안의 일은 돌지 않는다 ──
  const lockKey = appInstallLockKey(MCP_TOOL_NAMES_LOCK);
  await dbc.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
  let ranLocked = false;
  const eLock = await errOf(withMcpToolNamesLock(async () => { ranLocked = true; }, { waitMs: 300 }));
  await dbc.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
  const eLockFree = await errOf(withMcpToolNamesLock(async () => { ranLocked = ranLocked || "after"; }, { waitMs: 300 }));
  chk("E12g 이름 자리 대기 시간 초과는 409 «다른 앱의 AI 도구 이름 확인이 진행 중» — 속 이름(__mcp_tool_names__)을 안 비춘다 · 풀리면 돈다",
    eLock?.status === 409 && /다른 앱의 AI 도구 이름 확인/.test(eLock.message) && !/__mcp_tool_names__/.test(eLock.message) && eLockFree === null && ranLocked === "after",
    J({ eLock: eLock && [eLock.status, eLock.message], eLockFree: eLockFree?.message, ranLocked, lockKey }));

  // ── E22 비활성 구성원 ──
  await upsertMember({ id: "ghost", display_name: "떠난 사람", state: "inactive", scopes: MEMBER_SCOPES }, "pgt");
  await dbc.query(`INSERT INTO org_app_grant(tenant_id, app_id, member_id, scopes, tools) VALUES($1,'crm','ghost','[]'::jsonb,'[]'::jsonb) ON CONFLICT DO NOTHING`, [TA]);
  const crmNow = appMcpToolsOf((await itemsPool.query(`SELECT manifest FROM org_app WHERE id='crm'`)).rows[0]?.manifest).find((d) => d.name === "lookup");
  const n22 = calls.length;
  const r22 = await callAppDeclaredTool(refOf("crm", crmNow), { q: "x" }, { authInfo: { extra: { userId: "ghost", email: "", scopes: MEMBER_SCOPES, projects: ["*"] } } });
  chk("E22 비활성 구성원(동의 행이 남아 있어도)은 member 로 거절 · 실행기 0", r22._meta?.["lively/code"] === "member" && calls.length === n22, J(r22));

  // ── E14 워크스페이스 B ──
  await dbc.query(`INSERT INTO org_member(tenant_id, id, kind, display_name, state, scopes) VALUES($1,'bea','human','베아','active','["items","context","memory","admin"]'::jsonb)`, [TB]);
  const e14 = await inB(() => errOf(install("crm", "B 의 고객 관리", [...CRM, T("b_only")], "bea")));
  await inB(() => grant("bea", "crm"));
  await dbc.query(`INSERT INTO org_app_grant(tenant_id, app_id, member_id, scopes, tools) VALUES($1,'crm','bob','[]'::jsonb,'[]'::jsonb)`, [TB]);
  const A14 = await mcp(tok.alice);
  const a14 = (await A14.list()).map((x) => x.name);
  const r14 = await (await mcp(tok.bob)).call("lookup", { q: "B 동의" });
  chk("E14 워크스페이스 B — A 와 같은 이름으로 설치가 통과(겹침 검사는 그 워크스페이스만) · B 의 도구는 A 목록에 없다 · B 의 동의는 A 에서 안 센다",
    e14 === null && !a14.includes("b_only") && a14.includes("lookup") && r14._meta?.["lively/code"] === "consent_required", J({ e14: e14?.message, b_only: a14.includes("b_only"), r14 }));

  // ── E15 · E16 · E17 ──
  const n15 = calls.length;
  const r15a = await A.call("lookup", { q: 123 });
  const r15b = await callAppDeclaredTool(refOf("crm", appMcpToolsOf({ mcp_tools: CRM.map((x) => (x.name === "lookup" ? { ...x, description: "설명만 바꿈" } : x)) })[0]),
    { q: 5 }, await extraOf(tok.alice));
  chk("E15 인자가 입력과 안 맞으면 실행기 전에 거절 — 목록의 입력(SDK) · 부르기의 재검사(bad_args) 둘 다", (r15a.isError === true || !!r15a.thrown)
    && r15b.isError && r15b._meta?.["lively/code"] === "bad_args" && calls.length === n15, J({ r15a, r15b }));
  const r16a = await A.call("boom_http", {});
  const r16b = await A.call("boom", {});
  chk("E16 실행기 오류 — HttpError 는 그 글(깨진 글자는 U+FFFD 로) · code, 그 밖의 예외는 글을 감춘다", r16a.isError && textOf(r16a) === "앱이 지금 바쁩니다\uFFFD" && r16a._meta?.["lively/code"] === "app_server_busy"
    && r16b.isError && !/secret/.test(textOf(r16b)) && r16b._meta?.["lively/code"] === "executor_failed", J({ r16a, r16b }));
  const r17 = await A.call("big", {});
  const t17 = textOf(r17);
  chk("E17 결과가 상한(256KiB)을 넘으면 잘라 표시 · 전체 바이트", !r17.isError && r17._meta?.["lively/truncated"] === true && r17._meta?.["lively/bytes"] === 300000
    && /잘렸습니다/.test(t17) && Buffer.byteLength(t17) < 270 * 1024, J({ meta: r17._meta, len: Buffer.byteLength(t17) }));

  // ── E18 ──
  const NS = await mcp(tok.nosc);
  const nsl = (await NS.list()).map((x) => x.name);
  const n18 = calls.length;
  const r18 = await callAppDeclaredTool(refOf("crm", lookupDecl[0]), { q: "x" }, await extraOf(tok.nosc));
  chk("E18 scope memory 없는 토큰 — 목록에 안 서고 직접 불러도 거절 · 실행기 0", !nsl.includes("lookup") && r18._meta?.["lively/code"] === "scope" && calls.length === n18, J({ r18 }));

  // ── E8 끄기 · 지우기 ──
  const offRef = refOf("off", appMcpToolsOf({ mcp_tools: [T("off_q")] })[0]);
  chk("E8a 켜진 앱의 도구는 선다(배선)", al.has("off_q"));
  await cap("org_app_set_enabled").handler({ app_id: "off", enabled: false }, P("boss", true), ctx);
  const a8 = (await (await mcp(tok.alice)).list()).map((x) => x.name);
  const r8a = await callAppDeclaredTool(offRef, {}, await extraOf(tok.alice));
  await cap("org_app_remove").handler({ app_id: "off" }, P("boss", true), ctx);
  const r8b = await callAppDeclaredTool(offRef, {}, await extraOf(tok.alice));
  chk("E8b 끄면 목록에서 빠지고 옛 목록으로 불러도 tool_unavailable · 지운 뒤도 같다", !a8.includes("off_q") && r8a._meta?.["lively/code"] === "tool_unavailable" && r8b._meta?.["lively/code"] === "tool_unavailable", J({ r8a, r8b }));

  // ── E20 이름 겹침(설치 검사를 거치지 않고 생긴 둘째 앱) ──
  await itemsPool.query(`INSERT INTO org_app(id, title, version, manifest, source, content_hash, status, enabled, current_version_no)
     VALUES('late-dup','늦게 깐 앱','0.1.0',$1::jsonb,'{"kind":"inline"}'::jsonb,'hd','active',true,1)`, [J({ id: "late-dup", title: "늦게 깐 앱", version: "0.1.0", mcp_tools: [T("lookup", { description: "가짜" })] })]);
  const A20 = await mcp(tok.alice);
  const l20 = await A20.list();
  const lk20 = l20.filter((x) => x.name === "lookup");
  chk("E20 같은 이름의 둘째 앱이 생겨도 목록은 정상 — 먼저 설치된 앱(crm)의 도구 하나만", lk20.length === 1 && lk20[0]._meta?.["lively/app"] === "crm" && l20.length > 50, J(lk20));

  // ── E21 공개 주소를 모를 때 ──
  delete process.env.PUBLIC_URL;
  const r21 = await callAppDeclaredTool(refOf("crm", lookupDecl[0]), { q: "x" }, await extraOf(tok.bob));
  process.env.PUBLIC_URL = GW;
  chk("E21 공개 주소를 모르면 동의 주소 없이 «라이블리에서 이 앱을 열면» 으로 안내", r21._meta?.["lively/code"] === "consent_required" && !("lively/consent_url" in (r21._meta ?? {})) && /라이블리에서 이 앱을 열면/.test(textOf(r21)), J(r21));

  chk("G2 배선 — 시험 실행기가 실제로 불렸다(HTTP 경로 · OAuth 클라이언트 표지)", calls.length >= 8 && calls.some((c) => c.caller.oauthClientId === CID), `calls=${calls.length}`);
  for (const c of [A, B, B2, Dn, O, Bs, RO, IN, AT, A14, NS, A20]) await c.close();
} catch (e) {
  fail++;
  console.error("FAIL 시험 도중 예외 —", e?.stack ?? e);
} finally {
  if (server) await new Promise((r) => server.close(() => r()));
  if (itemsPool) await itemsPool.end().catch(() => undefined);
  if (dbc) await dbc.end().catch(() => undefined);
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await su.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
  await su.end().catch(() => undefined);
}
console.log(`\napp-declared-tools pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
