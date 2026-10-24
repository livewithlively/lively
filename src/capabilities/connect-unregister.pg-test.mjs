// #4991 앱 등록 바꾸기·지우기 · 노션 워크스페이스 연결 끊기 — PG 통합 시험. **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/capabilities/connect-unregister.pg-test.mjs
//  (금고 암호화 키가 없으면 이 시험이 시험용 키를 쓴다 — 실제 키는 필요 없다.)
//
// 왜 이 계층이 따로 있는가: 유닛(connect-unregister.test · connect-register.test)은 «지울 칸 표» 를 상수로만 본다.
//  그 표가 앱마다 준비 판정(*Ready)이 실제로 읽는 칸을 다 덮는지는, 실제 금고에 등록해 판정이 참이 되는 것을 보고
//  지운 뒤 거짓으로 뒤집히는 것을 봐야 안다(하나라도 남기면 «지웠는데 여전히 등록됨» 이 된다 — 구글 옛 kind · 깃허브 키 칸).
//  노션 끊기도 실제 수집기 행으로 «끄고 묶는다 · 지우지 않는다 · 다시 켜면 같은 수집기» 를 본다.
//
//  사양 행:
//   R1 앱 여섯 — 등록 → 준비 참 → 보기(source vault · client_id · 비밀 값 없음) → 지우기 → 준비 거짓 · 등록 칸 전부 없음
//   R2 지우기 뒤에도 구성원 연결 · 조직 자리(노션 워크스페이스 · 슬랙 봇 · 깃허브 설치) · 슬랙 연결 창구(MCP 행)는 그대로
//   R3 구글 — 옛 kind 의 client 칸까지 지운다(deleted 2) · 하나라도 남으면 준비가 참으로 남는다
//   R4 구글 — 서버 설정 앱이 있으면 지운 뒤에도 준비 참 · 응답 app_ready=true · 보기 source=env
//   R5 보기 impact — 기한 있는 구성원 연결 1명을 센다
//   R6 노션 끊기 — 칸 삭제 · 그 수집기 꺼짐(행·축 유지) · 다른 워크스페이스 칸·수집기 그대로 · 없는 워크스페이스 404
//   R7 안 묶인 옛 수집기(연결이 하나뿐) — 끄면서 그 워크스페이스에 묶는다(다른 워크스페이스가 접수하지 못한다)
//   R8 다시 연결하고 켜면 같은 수집기(id · 축 그대로)가 켜진다
if (!process.env.CONNECTOR_SECRET_KEY?.trim()) process.env.CONNECTOR_SECRET_KEY = "4991".repeat(16);
for (const k of ["LIVELY_TENANT_HEADER_SECRET", "SLACK_OAUTH_RELAY_URL", "NOTION_OAUTH_RELAY_URL", "GOOGLE_OAUTH_RELAY_URL",
  "LINEAR_OAUTH_RELAY_URL", "MICROSOFT_OAUTH_RELAY_URL", "GITHUB_OAUTH_RELAY_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
  "MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"]) delete process.env[k];

const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { registry } = await import(`${DIST}/capabilities/index.js`);
const store = await import(`${DIST}/org/credentials/member-secret-store.js`);
const broker = await import(`${DIST}/org/credentials/oauth-broker.js`);
const { REGISTRATION_SLOTS } = await import(`${DIST}/org/connect-unregister.js`);
const { upsertCollector, listCollectors, removeCollector } = await import(`${DIST}/org/store/collectors.js`);
const { getMcpServer, removeMcpServer } = await import(`${DIST}/org/store/mcp-servers.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const ADMIN = { userId: "__pg4991_admin__", email: "pg4991@example.invalid", scopes: ["memory", "admin"], projects: ["*"], tokenSource: "db" };
const MEMBER = { userId: "__pg4991_member__", email: "pg4991m@example.invalid", scopes: ["memory"], projects: ["*"], tokenSource: "db" };
const M_OWNER = store.memberOwner("__pg4991_conn__");
const G = store.GATEWAY_OWNER;
const cap = (n) => { const c = registry.get(n); if (!c) throw new Error(`registry 에 ${n} 가 없다`); return c; };
const REG = cap("org_connect_register"), VIEW = cap("org_connect_registration"), DEL = cap("org_connect_unregister");
const CUT = cap("org_notion_workspace_disconnect"), COLLECT = cap("org_notion_collect_set");
const status = (p) => p.then(() => 200, (e) => e?.status ?? 500);

const READY = {
  slack: broker.slackAppReady, notion: broker.notionPublicReady, google: broker.googleReady,
  linear: broker.linearAppReady, outlook: broker.microsoftReady, github: broker.githubAppReady,
};
//  키 판별 시험용 가짜 키 — 표지를 쪼개 이어 붙인다(파일에 키 모양 글자가 남으면 비밀 검사기가 진짜 키로 잡는다).
const PEM_MARK = (edge) => `-----${edge} RSA PRIVATE ` + "KEY-----";
const PEM = `${PEM_MARK("BEGIN")}\nZmFrZS1rZXktZm9yLWxpdmVseS00OTkxLXBnLXRlc3Q=\n${PEM_MARK("END")}`;
const SECRET = (app) => `pg4991-secret-${app}-do-not-leak`;
const VALUES = (app) => app === "github"
  ? { app_id: "4991", client_id: "Iv1.pg4991", client_secret: SECRET(app), private_key: PEM, app_slug: "pg4991-app" }
  : { client_id: `pg4991-client-${app}`, client_secret: SECRET(app) };

const WS = ["pg4991-ws-1", "pg4991-ws-2", "pg4991-ws-3"];
const MEMBER_KINDS = { slack: "slack_oauth", google: "google_oauth", linear: "linear_app", outlook: "microsoft_oauth", github: "github_pat" };
const createdCollectors = [];

async function cleanup() {
  for (const slots of Object.values(REGISTRATION_SLOTS)) for (const s of slots) await store.deleteMemberSecret(G, s.kind, s.scope_key);
  for (const k of Object.values(MEMBER_KINDS)) await store.deleteMemberSecret(M_OWNER, k, "");
  for (const w of WS) await store.deleteMemberSecret(G, "notion_public", w);
  await store.deleteMemberSecret(G, "slack_bot", "TPG4991");
  await store.deleteMemberSecret(G, "github_app_install", "4991001");
  for (const c of await listCollectors()) {
    if (String(c.key).startsWith("pg4991-") || createdCollectors.includes(c.id)) await removeCollector(c.id, ADMIN.userId, "pgtest").catch(() => {});
  }
}

async function slotRows(app) {
  const out = [];
  for (const s of REGISTRATION_SLOTS[app]) out.push(await store.getMemberSecretPublic(G, s.kind, s.scope_key));
  return out;
}

try {
  await cleanup();
  const hadSlackServer = !!(await getMcpServer("slack").catch(() => null));

  // ── R1·R2·R5 앱 여섯 ──
  for (const app of ["slack", "notion", "google", "linear", "outlook", "github"]) {
    const before = await READY[app]().catch(() => false);
    if (before) { bad(`R1 ${app}`, "시작 전에 이미 준비 참 — 다른 등록이 남아 있다(정리 실패)"); continue; }
    await REG.handler({ app, values: VALUES(app) }, ADMIN);
    chk(`R1 ${app}: 등록하면 준비 참`, await READY[app](), "등록 문이 쓴 칸을 준비 판정이 못 읽었다");
    // 이어진 연결 — 구성원 칸 하나(기한 있음) · 조직 자리
    if (MEMBER_KINDS[app]) {
      await store.setMemberSecret(M_OWNER, MEMBER_KINDS[app], "",
        { secret: JSON.stringify({ access_token: "pg4991-at", token_type: "bearer", expires_in: 3600 }), meta: { expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer" } }, "pgtest");
    }
    if (app === "notion") await store.setMemberSecret(G, "notion_public", WS[0], { secret: JSON.stringify({ access_token: "pg4991-nt", token_type: "bearer" }), meta: { workspace_name: "피지 워크스페이스" } }, "pgtest");
    if (app === "slack") await store.setMemberSecret(G, "slack_bot", "TPG4991", { secret: "xoxb-pg4991", meta: { team_name: "pg4991" } }, "pgtest");
    if (app === "github") await store.setMemberSecret(G, "github_app_install", "4991001", { secret: "4991001", meta: { installation_id: "4991001" } }, "pgtest");

    const view = await VIEW.handler({ app }, ADMIN);
    const json = JSON.stringify(view);
    chk(`R1 ${app}: 보기 source=vault · client_id`, view.current?.source === "vault" && view.current?.client_id === VALUES(app).client_id, json.slice(0, 200));
    chk(`R1 ${app}: 보기에 비밀 값이 없다`, !json.includes(SECRET(app)) && !json.includes("PRIVATE"), "비밀 값이 응답에 실렸다");
    if (MEMBER_KINDS[app]) chk(`R5 ${app}: 기한 있는 구성원 연결 1명을 센다`, view.impact.remove.some((l) => /구성원 1명.*끊겨요/.test(l)), view.impact.remove.join(" / "));
    if (app === "notion") chk("R5 notion: 워크스페이스 이름을 말한다", view.impact.remove.some((l) => /피지 워크스페이스/.test(l)), view.impact.remove.join(" / "));

    const r = await DEL.handler({ app }, ADMIN);
    const left = (await slotRows(app)).filter(Boolean);
    chk(`R1 ${app}: 지우면 준비 거짓 · 응답 app_ready=false`, !(await READY[app]()) && r.app_ready === false, JSON.stringify(r));
    chk(`R1 ${app}: 등록 칸이 하나도 남지 않는다(deleted=${r.deleted})`, left.length === 0 && r.deleted === (app === "github" ? 2 : 1), JSON.stringify(left.map((x) => `${x.kind}/${x.scope_key}`)));

    if (MEMBER_KINDS[app]) chk(`R2 ${app}: 구성원 연결은 그대로`, !!(await store.getMemberSecretPublic(M_OWNER, MEMBER_KINDS[app], ""))?.has_secret);
    if (app === "notion") chk("R2 notion: 워크스페이스 칸은 그대로", !!(await store.getMemberSecretPublic(G, "notion_public", WS[0]))?.has_secret);
    if (app === "slack") {
      chk("R2 slack: 슬랙 봇 칸은 그대로", !!(await store.getMemberSecretPublic(G, "slack_bot", "TPG4991"))?.has_secret);
      chk("R2 slack: 슬랙 연결 창구(MCP 행)는 그대로", !!(await getMcpServer("slack")));
    }
    if (app === "github") {
      chk("R2 github: 설치 칸은 그대로", !!(await store.getMemberSecretPublic(G, "github_app_install", "4991001"))?.has_secret);
      //  지울 칸 표와 따로 — 등록 문이 실제로 쓴 두 칸(client · 앱 키)을 이름으로 직접 본다.
      chk("R1 github: client 칸과 앱 키 칸이 둘 다 지워졌다",
        !(await store.getMemberSecretPublic(G, "github_app", "oauth:client")) && !(await store.getMemberSecretPublic(G, "github_app", "app:key")));
    }
    const again = await DEL.handler({ app }, ADMIN);
    chk(`R1 ${app}: 다시 지우면 deleted=0(조용히)`, again.deleted === 0 && again.ok === true, JSON.stringify(again));
  }
  if (!hadSlackServer) await removeMcpServer("slack", ADMIN.userId, "pgtest").catch(() => {});

  // ── R3 구글 옛 kind ──
  await REG.handler({ app: "google", values: VALUES("google") }, ADMIN);
  await store.setMemberSecret(G, "google_drive_oauth", "oauth:client", { secret: JSON.stringify({ client_id: "pg4991-legacy", client_secret: "pg4991-legacy-s" }) }, "pgtest");
  const r3 = await DEL.handler({ app: "google" }, ADMIN);
  chk("R3 구글: 옛 kind client 칸까지 지운다(deleted=2) · 준비 거짓", r3.deleted === 2 && !(await broker.googleReady()), JSON.stringify(r3));
  //  옛 kind 만 남은 상태도 준비 참이다(그래서 지울 칸에 들어 있어야 한다) — 표가 옛 kind 를 빠뜨리면 이 행이 «지웠는데 등록됨» 을 잡는다.
  await store.setMemberSecret(G, "google_gmail_oauth", "oauth:client", { secret: JSON.stringify({ client_id: "pg4991-legacy2", client_secret: "s2" }) }, "pgtest");
  chk("R3 구글: 옛 kind 만 남아도 준비 참(전제)", await broker.googleReady());
  const r3b = await DEL.handler({ app: "google" }, ADMIN);
  chk("R3 구글: 옛 kind 만 남은 등록도 지운다", r3b.deleted === 1 && !(await broker.googleReady()), JSON.stringify(r3b));

  // ── R4 구글 서버 설정 앱 ──
  process.env.GOOGLE_OAUTH_CLIENT_ID = "pg4991-env-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "pg4991-env-secret";
  try {
    await REG.handler({ app: "google", values: VALUES("google") }, ADMIN);
    const r4 = await DEL.handler({ app: "google" }, ADMIN);
    const v4 = await VIEW.handler({ app: "google" }, ADMIN);
    chk("R4 구글: 서버 설정 앱이 있으면 지운 뒤에도 준비 참 · app_ready=true · source=env",
      r4.deleted === 1 && r4.app_ready === true && v4.current.source === "env", JSON.stringify({ r4, src: v4.current.source }));
    chk("R4 구글: 지우기 문장이 서버 설정 앱으로 연결한다고 말한다", v4.impact.remove[0].includes("서버 설정"), v4.impact.remove[0]);
  } finally {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  }

  // ── R6·R7·R8 노션 끊기 ──
  await store.deleteMemberSecret(G, "notion_public", WS[0]);
  const slot = (w, name) => store.setMemberSecret(G, "notion_public", w, { secret: JSON.stringify({ access_token: `pg4991-${w}`, token_type: "bearer" }), meta: { workspace_name: name } }, "pgtest");
  const mk = async (key, token_source, instance) => {
    const c = await upsertCollector({ preset_key: "notion", key, instance_key: key, label: key, enabled: false, config: { token_source, ...(instance ? { instance } : {}) } }, ADMIN.userId, "pgtest");
    createdCollectors.push(c.id);
    //  켜기 전에 «이미 한 번 돈 것» 으로 표시한다 — 한 번도 안 돈 수집기를 켜면 첫 수집을 그 자리에서 미는데(kickFirstSync),
    //   그게 가짜 토큰으로 노션 API 를 부른다. 이 시험이 재는 것은 행과 칸이지 수집 실행이 아니다.
    await itemsPool.query(
      `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, created_by, last_run_at)
         VALUES($1,'pg4991','connector_sync','{}'::jsonb,600,false,'pgtest',now())
       ON CONFLICT (tenant_id, id) DO UPDATE SET last_run_at=now()`, [`collector-${c.id}`]);
    return upsertCollector({ id: c.id, enabled: true }, ADMIN.userId, "pgtest");
  };
  const byId = async (id) => (await listCollectors()).find((c) => c.id === id);

  // R7 — 연결이 하나뿐 · 안 묶인 옛 수집기만 있다
  await slot(WS[0], "하나");
  const legacy = await mk("pg4991-legacy", "org", null);
  await CUT.handler({ workspace_id: WS[0] }, MEMBER);
  const l2 = await byId(legacy.id);
  chk("R7 안 묶인 옛 수집기 — 꺼지고 그 워크스페이스에 묶인다(행은 남는다)", !!l2 && l2.enabled === false && l2.config.token_source === `org:${WS[0]}`, JSON.stringify(l2 && { enabled: l2.enabled, ts: l2.config.token_source }));
  chk("R6 칸이 지워졌다", !(await store.getMemberSecretPublic(G, "notion_public", WS[0])));

  // R6 — 워크스페이스 둘 · 각자 묶인 수집기
  await slot(WS[1], "둘");
  await slot(WS[2], "셋");
  const c2 = await mk("pg4991-ws2", `org:${WS[1]}`, WS[1]);
  const c3 = await mk("pg4991-ws3", `org:${WS[2]}`, WS[2]);
  chk("R6 없는 워크스페이스는 404", (await status(CUT.handler({ workspace_id: "pg4991-nope" }, MEMBER))) === 404);
  const r6 = await CUT.handler({ workspace_id: WS[1] }, MEMBER);
  const a2 = await byId(c2.id), a3 = await byId(c3.id);
  chk("R6 끊은 워크스페이스의 칸은 지워지고 다른 칸은 그대로",
    !(await store.getMemberSecretPublic(G, "notion_public", WS[1])) && !!(await store.getMemberSecretPublic(G, "notion_public", WS[2]))?.has_secret);
  chk("R6 그 수집기는 꺼지고 행·축이 남는다", !!a2 && a2.enabled === false && a2.config.instance === WS[1] && a2.config.token_source === `org:${WS[1]}`, JSON.stringify(a2 && a2.config));
  chk("R6 다른 워크스페이스의 수집기는 그대로 켜져 있다", !!a3 && a3.enabled === true);
  chk("R6 응답 — 멈춘 수집기 · 상태에서 그 워크스페이스가 빠졌다",
    Array.isArray(r6.stopped) && r6.stopped.includes(c2.id) && !r6.state.workspaces.some((w) => w.id === WS[1]) && r6.state.workspaces.some((w) => w.id === WS[2]), JSON.stringify(r6.stopped));

  // R8 — 같은 워크스페이스를 다시 연결하고 켠다
  await slot(WS[1], "둘");
  const r8 = await COLLECT.handler({ enabled: true, workspace_id: WS[1] }, MEMBER, { source: "pgtest" });
  const b2 = await byId(c2.id);
  const boundToWs1 = (await listCollectors()).filter((c) => c.preset_key === "notion" && c.config.token_source === `org:${WS[1]}`);
  chk("R8 다시 켜면 같은 수집기(id · 축 그대로)가 켜진다 · 새 수집기를 만들지 않는다",
    r8.ok === true && !!b2 && b2.enabled === true && b2.config.instance === WS[1] && boundToWs1.length === 1, JSON.stringify({ ok: r8.ok, n: boundToWs1.length }));
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch((e) => console.error("정리 실패:", e?.message));
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
