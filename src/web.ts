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
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { SCOPES, DANGEROUS_SCOPES, type Scope } from "./capabilities/scopes.js";

export function registerWebUi(app: express.Express, verifier: BearerVerifier): void {
  // requiredScopes 는 인스턴스별 고정 — 스코프별 미들웨어를 단일 상수(capabilities/scopes.ts)에서 파생한다.
  //  scope null = 인증만(me). 새 scope 추가 시 여기 분기를 빠뜨려 "인증만으로 통과"하는 일이 구조적으로 불가능.
  const authOnly = requireBearerAuth({ verifier });
  const byScope = new Map<Scope, express.RequestHandler>();
  for (const s of SCOPES) byScope.set(s, requireBearerAuth({ verifier, requiredScopes: [s] }));
  // B1 fail-closed: 미지/누락 scope 는 인증만으로 통과시키지 않고 즉시 403.
  const deny403: express.RequestHandler = (_req, res) => res.status(403).json({ error: "forbidden: unknown scope" });
  const mw = (scope: Scope | null): express.RequestHandler =>
    scope === null ? authOnly : (byScope.get(scope) ?? deny403);

  for (const { cap, mount } of restMounts()) {
    const handler = wrap(async (req, res) => {
      const input = mount.parse(req); // 기존 qstr/qint/parseMappingBody 검증 그대로(HttpError → wrap)
      // 웹은 partial user 허용(me 가 null-default 구성) — MCP 의 resolveUser throw 와 다른 기존 정책 유지.
      const user = (req.auth?.extra ?? {}) as unknown as LivelyUser;
      // B3 defense-in-depth: 미들웨어(mw)에 더해 핸들러 경계에서도 scope 를 재확인한다(단일층 의존 제거,
      //  MCP 경로 capabilities/index.ts 의 requireScope 와 동형). mw 가 이미 막지만 회귀 방지용 2차 게이트.
      if (cap.scope && !(Array.isArray(user.scopes) && user.scopes.includes(cap.scope))) {
        throw new HttpError(403, `forbidden: '${cap.scope}' 권한이 필요합니다`);
      }
      // B5: 회수 불가한 정적 토큰(AUTH_TOKENS_JSON)으로는 fleet 제어·정책 변경(admin/runtime) 금지.
      if (cap.scope && DANGEROUS_SCOPES.has(cap.scope) && user.tokenSource === "static") {
        throw new HttpError(403, "정적 토큰으로는 관리/런타임 변경이 불가합니다 — 회수 가능한 발급 토큰(lvk_)을 사용하세요");
      }
      // /api/ui 응답은 전부 비공개(토큰 발급 평문 포함) — 프록시/브라우저 캐시 금지.
      res.setHeader("Cache-Control", "no-store");
      res.json(await cap.handler(input, user, {
        source: "web",
        actor: user.userId || user.email,
        tokenHashPrefix: user.tokenHashPrefix,
        ip: req.ip,
      }));
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
