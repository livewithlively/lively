import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { buildServer } from "./server.js";
import { BearerVerifier } from "./auth/bearer.js";
import { initItemSchema } from "./items/store.js";
import { initOrgSchema } from "./org/schema.js";
import { embeddingsEnabled, initEmbeddings } from "./embeddings/index.js";
import { listDisabledBuiltins } from "./org/store.js";
import { registerDynamicTools } from "./capabilities/dynamic-tools.js";
import { buildInstallBundle } from "./org/publish.js";
import { domainmapWebhookRouter } from "./domainmap/webhook.js";
import { init as initDomainmapSchema } from "./domainmap/core/schema.js";
import { registerWebUi } from "./web.js";
import { registerTerminal } from "./terminal.js";
import { logger } from "./log.js";

const PORT = Number(process.env.PORT ?? 8080);

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
  // (A) 빌트인 게이팅 + (B) 동적 org_tool 등록 — DB 의존(ITEMS_DATABASE_URL). 실패는 fail-open(기본 표면 유지).
  let disabled: Set<string> | undefined;
  try { disabled = await listDisabledBuiltins(); } catch { disabled = undefined; }
  const server = buildServer(disabled);
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

const server = app.listen(PORT, () => {
  logger.info(`context-ontology listening on :${PORT}/mcp`);
  // 중앙 박스 도그푸드 — ttyd 터미널을 정문 뒤로 프록시(/terminal). server 핸들(upgrade)이 필요해 listen 후 배선.
  registerTerminal(app, server, verifier);
  // 스키마 보장(비치명적) — **포트 바인딩 성공 후에만** 실행. 파괴적 마이그레이션(예: DROP COLUMN)이 EADDRINUSE
  //  (구 게이트웨이 미종료) 상황에서 구코드 밑의 컬럼을 떨어뜨리지 않게: listen 성공 = 포트 소유 확보 = 구 인스턴스 부재.
  if (process.env.ITEMS_DATABASE_URL) {
    initItemSchema()
      .then(() => logger.info("item schema ready"))
      .catch((err) => logger.error({ err }, "item schema init failed"));
    initOrgSchema()
      .then(() => logger.info("org schema ready"))
      // 임베딩 초기화(OFF 기본 — enabled 일 때만, 비치명). pgvector 부재 시 initEmbeddings 가 graceful 폴백
      //  (warn 후 throw 없이 반환)하므로 catch 는 방어선일 뿐. OFF 면 진입조차 안 한다 → 동작 변화 0.
      .then(() => { if (embeddingsEnabled()) return initEmbeddings(); })
      .catch((err) => logger.error({ err }, "org schema init failed"));
  }
  // domainmap 스키마(AREA 축: domain.space + business 시드6) — items/org 와 별 DB(DOMAINMAP_DATABASE_URL).
  //  부팅 배선 누락 시 신규 셀프호스트가 4축 중 AREA 만 통째로 못 받음(P6 적대검증 적발) → 부팅에 명시 배선.
  //  멱등(CREATE TABLE IF NOT EXISTS + ON CONFLICT)·비치명(catch). 라이브 단일테넌트는 이미 적재라 무변화.
  if (process.env.DOMAINMAP_DATABASE_URL) {
    initDomainmapSchema()
      .then(() => logger.info("domainmap schema ready"))
      .catch((err) => logger.error({ err }, "domainmap schema init failed"));
  }
});
// 포트 바인딩 실패(구 게이트웨이 미종료 등) → 마이그레이션 미실행 보장 + 즉시 종료(half-state 방지).
server.on("error", (err) => {
  logger.error({ err }, `listen failed on :${PORT} — 스키마 마이그레이션 미실행, 종료`);
  process.exit(1);
});
