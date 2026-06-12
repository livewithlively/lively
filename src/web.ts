// Lively Context 웹 UI — 얇은 REST 어댑터(/api/ui/*) + 정적 프론트(/ui). DESIGN §10.1, Stage①.
// 라우트별 도메인 로직은 전부 src/capabilities/* 로 이동 — 여기는 restMounts() 를 순회해
// 기존 경로(+alias)에 그대로 마운트만 한다(경로·검증 메시지·응답 shape byte-compat).
// 인증: /mcp 와 동일한 BearerVerifier 재사용. requiredScopes 는 미들웨어 인스턴스 고정이므로
// items/context/인증만 3개를 분리(SDK 가 401/403 + WWW-Authenticate 자동 처리).
// 정적 자산은 비인증(사내망 전제) — 데이터는 전부 /api/ui 토큰 뒤. domainmap 은 무인증 서비스라
// 이 프록시의 bearer 가 신뢰 경계(절대 비인증 프록시 금지).
import express from "express";
import { fileURLToPath } from "node:url";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { restMounts } from "./capabilities/index.js";
import { wrap } from "./capabilities/rest-util.js";

export function registerWebUi(app: express.Express, verifier: BearerVerifier): void {
  // requiredScopes 는 인스턴스별 고정 — 스코프별 미들웨어 분리. scope null = 인증만(me).
  const authOnly = requireBearerAuth({ verifier });
  const authItems = requireBearerAuth({ verifier, requiredScopes: ["items"] });
  const authContext = requireBearerAuth({ verifier, requiredScopes: ["context"] });
  const mw = (scope: "items" | "context" | null): express.RequestHandler =>
    scope === "items" ? authItems : scope === "context" ? authContext : authOnly;

  for (const { cap, mount } of restMounts()) {
    const handler = wrap(async (req, res) => {
      const input = mount.parse(req); // 기존 qstr/qint/parseMappingBody 검증 그대로(HttpError → wrap)
      // 웹은 partial user 허용(me 가 null-default 구성) — MCP 의 resolveUser throw 와 다른 기존 정책 유지.
      const user = (req.auth?.extra ?? {}) as unknown as LivelyUser;
      res.json(await cap.handler(input, user, { source: "web" }));
    });
    for (const path of mount.paths) {
      if (mount.method === "GET") app.get(path, mw(cap.scope), handler);
      else app.post(path, mw(cap.scope), handler);
    }
  }

  // ── 정적 프론트 — dist/web.js 기준 레포루트/public. 해시 라우팅이라 서버 폴백 불필요. ──
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use("/ui", express.static(publicDir));
  app.get("/", (_req, res) => res.redirect("/ui/"));
}
