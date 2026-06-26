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
import { buildInstallBundle } from "./org/publish.js";
import { domainmapWebhookRouter } from "./domainmap/webhook.js";
import { init as initDomainmapSchema } from "./domainmap/core/schema.js";
import { initV6Schema } from "./v6/schema.js";
import { registerWebUi } from "./web.js";
import { registerTerminal } from "./terminal.js";
import { registerProjectV6Routes } from "./project-routes.js";
import { getProject as v6GetProject, isProjectMember as v6IsProjectMember, setProjectFolder as v6SetProjectFolder } from "./v6/project-store.js";
import { listProjectActivities } from "./org/store.js";
import { createProjectFolder } from "./project-fs.js";
import { startScheduler } from "./scheduler.js";
import { logger } from "./log.js";

const PORT = Number(process.env.PORT ?? 8080);

// ── 프로세스 안전망(최대한 안 죽게) — launchd KeepAlive 와 함께 2중 방어. ──
//  unhandledRejection: 미처리 promise 거부로 프로세스가 통째로 죽지 않게 — 로그만 남기고 계속(요청 1건 실패 ≠ 전체 다운).
//  uncaughtException: 상태가 오염됐을 수 있으니 로그 후 종료 → launchd 가 즉시 새 프로세스로 재기동(깨끗한 상태).
process.on("unhandledRejection", (reason) => logger.error({ reason }, "unhandledRejection — 무시하고 계속"));
process.on("uncaughtException", (err) => { logger.error({ err }, "uncaughtException — 종료 후 재기동"); process.exit(1); });

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
  listProjectActivities: (id, a, l) => listProjectActivities(id, a, l),
  ensureFolder: async (project) => {
    const folder = await createProjectFolder(project.id);
    await v6SetProjectFolder(project.id, folder, { source: "web" });
    return folder;
  },
});

const server = app.listen(PORT, () => {
  logger.info(`context-ontology listening on :${PORT}/mcp`);
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
      // 스키마 직렬 체인 완료 후 인프로세스 스케줄러 기동(org_cron 테이블 보장됨) — 서버사이드 cron 트리거.
      .then(() => startScheduler())
      // 임베딩(pgvector) 폐기(2026-06-24): v6 knowledge 검색은 ILIKE 비-벡터 — embeddings 모듈 제거됨.
      .catch((err) => logger.error({ err }, "schema init failed"));
  }
});
// 포트 바인딩 실패(구 게이트웨이 미종료 등) → 마이그레이션 미실행 보장 + 즉시 종료(half-state 방지).
server.on("error", (err) => {
  logger.error({ err }, `listen failed on :${PORT} — 스키마 마이그레이션 미실행, 종료`);
  process.exit(1);
});
