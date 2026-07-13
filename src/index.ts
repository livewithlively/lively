import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { buildServer } from "./server.js";
import { BearerVerifier } from "./auth/bearer.js";
import { initItemSchema } from "./items/store.js";
import { initOrgSchema } from "./org/schema.js";
import { listBuiltinOverrides, listBuiltinAlwaysLoad } from "./org/store.js";
import { agentFromHeaders } from "./org/agent-identity.js";
import { buildToolCandidates } from "./capabilities/index.js";
import { setToolCandidates } from "./capabilities/mcp-surface.js";
import { registerDynamicTools } from "./capabilities/dynamic-tools.js";
import { registerProxiedMcpTools } from "./capabilities/mcp-proxy.js";
import { finishConsent, abandonConsent } from "./org/oauth-broker.js";
import { buildInstallBundle } from "./org/publish.js";
import { domainmapWebhookRouter } from "./domainmap/webhook.js";
import { init as initDomainmapSchema } from "./domainmap/core/schema.js";
import { initV6Schema } from "./v6/schema.js";
import { seedDefaultContent } from "./org/seed-content.js";
import { runAutoBackfillSweep } from "./v6/embedding-backfill.js";
import { registerWebUi } from "./web.js";
import { registerTerminal } from "./terminal.js";
import { killAttachedPtys } from "./terminal-pty.js";
import { registerProjectV6Routes } from "./project-routes.js";
import { getProject as v6GetProject, isProjectMember as v6IsProjectMember, setProjectFolder as v6SetProjectFolder } from "./v6/project-store.js";
import { listProjectActivities } from "./org/store.js";
import { createProjectFolder } from "./project-fs.js";
import { startScheduler } from "./scheduler.js";
import { ensureStateDirs } from "./state-dir.js";
import { recoverOrphanConnectorRuns } from "./connectors/run-tracker.js";
import { logger } from "./log.js";

const PORT = Number(process.env.PORT ?? 8080);

// ── 프로세스 안전망(최대한 안 죽게) — launchd KeepAlive 와 함께 2중 방어. ──
//  unhandledRejection: 미처리 promise 거부로 프로세스가 통째로 죽지 않게 — 로그만 남기고 계속(요청 1건 실패 ≠ 전체 다운).
//  uncaughtException: 상태가 오염됐을 수 있으니 로그 후 종료 → launchd 가 즉시 새 프로세스로 재기동(깨끗한 상태).
process.on("unhandledRejection", (reason) => logger.error({ reason }, "unhandledRejection — 무시하고 계속"));
process.on("uncaughtException", (err) => { logger.error({ err }, "uncaughtException — 종료 후 재기동"); try { killAttachedPtys(); } catch { /* noop */ } process.exit(1); });
// 정상 종료(재배포 SIGTERM·Ctrl+C SIGINT) 시 attach node-pty 를 전부 kill 하고 나간다(#687). 안 하면 자식이 init 로
//  재부모화돼 PTY 를 영구 점유(고아). 재시작이 잦은 게이트웨이라 이게 없으면 매 배포가 PTY 를 흘린다.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => { logger.info({ sig }, "shutdown — attach PTY 정리 후 종료"); try { killAttachedPtys(); } catch { /* noop */ } process.exit(0); });
}

// 부팅 시 MCP 툴 후보 주입 — registry(정적) + db 직접등록. 웹 도구탭(org_tools)·검증(org_tool_upsert)·http_proxy 섀도잉 차단이 참조.
setToolCandidates(buildToolCandidates());

const app = express();

// domainmap 웹훅(:7700 시절과 동일 경로) — 반드시 전역 express.json() '이전'에 마운트:
// HMAC 은 정확한 raw bytes 대상이라 JSON 파서가 스트림을 먼저 소비하면 검증이 영원히 실패한다.
// bearer 인증 밖(구 :7700 과 동일 — HMAC 자체가 fail-closed 인증). raw 파싱은 라우터 내부 소유.
app.use("/api/webhook", domainmapWebhookRouter());

app.use(express.json({ limit: "1mb" }));

const verifier = new BearerVerifier();
const auth = requireBearerAuth({ verifier });

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// 모든 MCP 요청은 bearer 인증 필수 → req.auth 가 핸들러의 extra.authInfo 로 전달됨.
// Stateless: 요청마다 새 서버+트랜스포트 (수평 확장 단순).
app.post("/mcp", auth, async (req, res) => {
  // (A) 빌트인 게이팅 + (A'') 주입모드 + (B) 동적 org_tool 등록 — DB 의존(ITEMS_DATABASE_URL). 실패는 fail-open(기본 표면 유지).
  let overrides: Map<string, boolean> | undefined;
  try { overrides = await listBuiltinOverrides(); } catch { overrides = undefined; }
  let alwaysLoad: Map<string, boolean> | undefined;
  try { alwaysLoad = await listBuiltinAlwaysLoad(); } catch { alwaysLoad = undefined; }
  // 하네스 신원(x-lively-harness 우선, 없으면 UA) — _meta(anthropic/alwaysLoad) 를 하네스별로 emit/생략(#187).
  const harness = agentFromHeaders(req.headers);
  const server = buildServer(overrides, alwaysLoad, harness);
  try { await registerDynamicTools(server); } catch (err) { logger.warn({ err }, "동적 툴 등록 실패(무시)"); }
  try { await registerProxiedMcpTools(server); } catch (err) { logger.warn({ err }, "프록시 MCP 등록 실패(무시)"); }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, "mcp request failed");
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

// 멤버 설치 — 토큰게이트 curl 모델(git clone 대체). 인증된 멤버 토큰이면 그 조직의 발행 아티팩트를
//  tar.gz 로 동적 생성해 스트림한다(DB→materialize→generator→tar). 설치 한 줄:
//    curl -fsSL -H "Authorization: Bearer <TOKEN>" <GW>/install | tar -xz -C <dir> && bash <dir>/setup/setup-mac.sh
//  격리 모델: **조직당 1 게이트웨이+DB 인스턴스**(배포 유형화 T1~T5, 멀티테넌트 SaaS 제외). 따라서 org-content
//  테이블에 org_id 컬럼이 없고 모든 멤버 토큰이 그 단일 조직 묶음을 받는다 — 이건 설계상 의도다.
//  ⚠️ 만약 한 게이트웨이를 여러 조직이 공유하도록 바꾼다면 org_id 격리(스키마+모든 쿼리 필터)가 선행 필수.
app.get("/install", auth, async (_req, res) => {
  try {
    const { buffer } = await buildInstallBundle("claude");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", 'attachment; filename="lively-context-setup.tgz"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, "install bundle 생성 실패");
    if (!res.headersSent) res.status(500).json({ error: "install_bundle_failed" });
  }
});

// OAuth 콜백(#746 T2) — 인가서버가 code+state 로 리다이렉트하는 착지점. 브라우저-facing 이라 bearer 인증 밖:
//  보안은 서명된 state(HMAC·만료·멤버 귀속)가 담보한다 — 위조 불가 → 타인 vault 에 토큰 주입 불가. finishConsent 가 검증·교환·저장.
const oauthPage = (msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Lively 커넥터</title><body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.6"><h2>Lively 커넥터</h2><p>${String(msg).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</p></body>`;
app.get("/oauth/callback", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  if (q.error) {
    if (q.state) await abandonConsent(String(q.state)).catch(() => { /* best-effort 정리 */ }); // 거부 시 임시 PKCE verifier 정리(리뷰 #1)
    return res.status(400).send(oauthPage(`인증이 거부되었습니다: ${q.error}`));
  }
  if (!q.code || !q.state) return res.status(400).send(oauthPage("code 또는 state 가 없습니다."));
  try {
    const r = await finishConsent(String(q.state), String(q.code));
    res.send(oauthPage(`연결이 완료되었습니다 — ${r.serverName}. 이 창을 닫아도 됩니다.`));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "oauth 콜백 실패");
    res.status(400).send(oauthPage(`연결에 실패했습니다: ${(err as Error).message}`));
  }
});

// Lively Context 웹 UI — /api/ui/*(REST, 동일 verifier 재사용) + /ui(정적 프론트).
registerWebUi(app, verifier);
// v6(projects2) 상세 — 동일 파일/세션/타임라인 로직, 데이터만 v6 project. folder 비면 lazy 생성(데이터 쓰기, 스키마 불변).
// (v1 registerProjectRoutes/projects.ts 폐기 2026-06-24 — projects2(v6) 통합, 고아 v1 제거)
registerProjectV6Routes(app, verifier, {
  getProject: async (id) => {
    const p = await v6GetProject(id);
    return p ? { id: p.id, name: p.name, folder: p.folder } : undefined;
  },
  isProjectMember: (id, m) => v6IsProjectMember(id, m),
  listProjectActivities: (id, a, l, o) => listProjectActivities(id, a, l, o),
  ensureFolder: async (project) => {
    const folder = await createProjectFolder(project.id);
    await v6SetProjectFolder(project.id, folder, { source: "web" });
    return folder;
  },
});

const server = app.listen(PORT, () => {
  logger.info(`context-ontology listening on :${PORT}/mcp`);
  // 런타임 쓰기 루트(#618) 보장 — 서비스 유저 소유 <cwd>/data 하위 디렉을 부팅 시 멱등 생성(스캐너 repos·notion-assets 등).
  //  DB 무관·비치명이라 스키마 체인 밖에서 즉시. 개별 기능도 각자 mkdir 하지만 여기서 '단일 지점' 보장(재발방지).
  ensureStateDirs().catch((err) => logger.warn({ err }, "state dir ensure 실패(비치명)"));
  // 중앙 박스 도그푸드 — ttyd 터미널을 정문 뒤로 프록시(/terminal). server 핸들(upgrade)이 필요해 listen 후 배선.
  registerTerminal(app, server, verifier);
  // 스키마 보장(비치명적) — **포트 바인딩 성공 후에만** 실행. 파괴적 마이그레이션(예: DROP COLUMN)이 EADDRINUSE
  //  (구 게이트웨이 미종료) 상황에서 구코드 밑의 컬럼을 떨어뜨리지 않게: listen 성공 = 포트 소유 확보 = 구 인스턴스 부재.
  // 통합 DB(P0+P1): items/org/domainmap 이 한 DB(ITEMS_DATABASE_URL)에 병합됨. 세 init 을 **직렬** 체인으로
  //  보장한다 — initV6Schema 의 activity_knowledge·project 정션이 knowledge/project/activity 를 FK 참조하므로
  //  initOrgSchema·initDomainmapSchema 가 먼저 끝나야 한다(분리 .then 은 레이스 → FK 'relation does not exist').
  //  (구 activity_ku_ref/activity_task→knowledge_unit FK 는 2026-06-24 v6 드랍됨.) listen 성공 후 실행 불변식 유지.
  if (process.env.ITEMS_DATABASE_URL) {
    initItemSchema()
      .then(() => logger.info("item schema ready"))
      .then(() => initOrgSchema())
      .then(() => logger.info("org schema ready"))
      .then(() => initDomainmapSchema())
      .then(() => logger.info("domainmap schema ready"))
      // v6 그린필드 스키마(category/knowledge/project + 정션) — 레거시 이후 직렬(FK 순서: category→knowledge/project→정션→activity·mapping·debt ALTER).
      .then(() => initV6Schema())
      .then(() => logger.info("v6 schema ready"))
      // 프로비저닝 디폴트 콘텐츠 시딩(#713) — 코드가 이름으로 전제하는 지식·훅·스킬(예: 모든 프로젝트 AGENTS.md 의
      //  knowledge_get('project-closeout-routine'), 도메인맵 is-부트스트랩 런북 2개, 커스텀훅·스킬)을 신규 게이트웨이에
      //  idempotent 주입한다(없을 때만 — 운영자 토글·편집 보존). org(훅·스킬)+v6(지식) 스키마가 모두 준비된 뒤. 비치명.
      .then(() => seedDefaultContent().catch((err) => logger.warn({ err }, "디폴트 콘텐츠 시딩 실패(비치명)")))
      // 부팅 스윕(#586) — 재시작으로 추적이 끊긴 connector_run 잔재 정리(유령 running 이 새 싱크를 막지 않게).
      //  스케줄러 기동 **전**에 — 크론 첫 tick 이 유령 행에 막히지 않도록.
      .then(() => recoverOrphanConnectorRuns().catch((err) => logger.warn({ err }, "부팅 스윕 실패(비치명) — 유령 run 은 하트비트 정리로 수렴")))
      // 스키마 직렬 체인 완료 후 인프로세스 스케줄러 기동(org_cron 테이블 보장됨) — 서버사이드 cron 트리거.
      //  ⚠ 스케줄러는 단일 프로세스 전제(리더선출 없음) — 보조/검증 인스턴스는 LIVELY_NO_SCHEDULER=1 로 꺼서
      //   라이브 게이트웨이와 org_cron tick 이 중복(동일 잡 동시 실행)되지 않게 한다. 같은 DB 를 공유하는 스모크용.
      .then(() => { if (process.env.LIVELY_NO_SCHEDULER !== "1") startScheduler(); })
      // 자동 pending 임베딩 백필(#669) — 부팅 30초 후 1회(배포/업데이트 직후 잔량 자가치유 — 30초는 사이드카
      //  Ollama 동시 부팅 박스의 헬스 확보 여유) + 10분 주기(미러 리셋·훅 실패 잔량 흡수; sync 완료 트리거의 폴백).
      //  provider off 면 설정 조회 후 no-op. 스케줄러와 같은 게이트 — 스모크 인스턴스(LIVELY_NO_SCHEDULER=1,
      //  같은 DB 공유)가 라이브와 중복 스윕(같은 행 이중 임베딩)하지 않게.
      .then(() => {
        if (process.env.LIVELY_NO_SCHEDULER === "1") return;
        setTimeout(() => { void runAutoBackfillSweep(); }, 30_000).unref();
        setInterval(() => { void runAutoBackfillSweep(); }, 600_000).unref();
      })
      .catch((err) => logger.error({ err }, "schema init failed"));
  }
});
// 포트 바인딩 실패(구 게이트웨이 미종료 등) → 마이그레이션 미실행 보장 + 즉시 종료(half-state 방지).
server.on("error", (err) => {
  logger.error({ err }, `listen failed on :${PORT} — 스키마 마이그레이션 미실행, 종료`);
  process.exit(1);
});
