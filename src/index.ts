import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { buildServer } from "./server.js";
import { BearerVerifier } from "./auth/bearer.js";
import { initItemSchema } from "./items/store.js";
import { domainmapWebhookRouter } from "./domainmap/webhook.js";
import { registerWebUi } from "./web.js";
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
  const server = buildServer();
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

// Lively Context 웹 UI — /api/ui/*(REST, 동일 verifier 재사용) + /ui(정적 프론트).
registerWebUi(app, verifier);

// Item store 스키마 보장(비치명적) — ITEMS_DATABASE_URL 설정 시에만.
if (process.env.ITEMS_DATABASE_URL) {
  initItemSchema()
    .then(() => logger.info("item schema ready"))
    .catch((err) => logger.error({ err }, "item schema init failed"));
}

app.listen(PORT, () => logger.info(`context-ontology listening on :${PORT}/mcp`));
