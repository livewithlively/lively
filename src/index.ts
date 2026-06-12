import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { buildServer } from "./server.js";
import { BearerVerifier } from "./auth/bearer.js";
import { initItemSchema } from "./items/store.js";
import { registerWebUi } from "./web.js";
import { logger } from "./log.js";

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
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
