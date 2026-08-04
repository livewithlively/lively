// OAuth 인가서버 HTTP 배선 (#1473 T2) — SDK 의 mcpAuthRouter 를 **공개 주소가 정해진 뒤에** 띄운다.
//
//  왜 lazy 인가: mcpAuthRouter 는 생성 시점에 issuer 를 굳혀 메타데이터를 만든다(createOAuthMetadata).
//   그런데 우리 공개 주소는 org 프로필(DB)이 권위라 **부팅 시점엔 아직 없을 수 있다**(#1438 단일소스).
//   그래서 첫 요청에서 해소하고, 주소가 바뀌면 다시 만든다. 주소를 못 정하면 이 라우터는 통째로 비활성이다
//   (= /authorize·/token·.well-known 이 404). 인가서버는 안정적 issuer 없이는 존재할 수 없으므로 이게 맞다.
//
//  ⚠ issuer 를 **요청 헤더에서 뽑지 않는다**(gatewayUrlForRequest 를 안 쓴다). Host 헤더는 요청자가 통제하므로
//   그걸로 issuer 를 만들면 issuer 혼동 공격이 열린다 — 토큰을 남의 이름으로 광고하게 된다.
import express from "express";
import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { LivelyOAuthProvider } from "./oauth-provider.js";
import { verifyClientSecret } from "./oauth-clients.js";
import { resourceIds, type ResourceIds } from "../../auth/resource-id.js";
import { SCOPES, DANGEROUS_SCOPES } from "../../auth/scopes.js";
import { logger } from "../../log.js";

const provider = new LivelyOAuthProvider();
const RESOURCE_NAME = "Lively 컨텍스트 게이트웨이";

// 광고하는 scope = **실제로 발급될 수 있는 것만**. 위험 scope(admin·runtime)는 이 경로로 어떤 경우에도
//  나가지 않으므로(store/oauth.ts 의 grantableScopes) 목록에 넣으면 거짓 광고다 — 클라이언트가 요청했다가
//  조용히 좁혀진 토큰을 받고 "왜 admin 이 안 되지"를 디버깅하게 된다. 광고와 실제를 일치시킨다.
const ADVERTISED_SCOPES = SCOPES.filter((s) => !DANGEROUS_SCOPES.has(s));

// SDK 가 /token·/revoke 앞에 세우는 authenticateClient 는 `client.client_secret !== 제시값` **평문 비교**를 한다.
//  우리는 시크릿을 sha256 으로만 보관하므로 getClient 가 시크릿을 비워 보내고(oauth-clients.ts 머리주석 ★★),
//  대신 이 게이트가 해시로 검증한다. **이 게이트를 빼면 클라이언트 시크릿 검사가 통째로 사라진다.**
export function clientSecretGate(): express.RequestHandler {
  return (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    // client_id 가 없거나 미등록이면 판단을 SDK 에 넘긴다 — invalid_request/invalid_client 문구를 한 곳에서만 낸다.
    if (!clientId) { next(); return; }
    const presented = typeof body.client_secret === "string" ? body.client_secret : undefined;
    verifyClientSecret(clientId, presented).then((verdict) => {
      if (verdict === "ok" || verdict === "unknown") { next(); return; }
      logger.warn({ clientId, verdict }, "OAuth 클라이언트 인증 실패");
      res.status(401).json({ error: "invalid_client", error_description: "client authentication failed" });
    }).catch((err) => {
      logger.error({ err }, "클라이언트 시크릿 검증 실패");
      res.status(500).json({ error: "server_error" });
    });
  };
}

// RFC 9728 보호자원 메타데이터를 **경로 없는 루트**에도 낸다.
//  SDK 는 자원 식별자의 경로를 붙인 `/.well-known/oauth-protected-resource/mcp` 만 서빙한다(사양 정본).
//  그런데 여러 클라이언트가 서버 origin 을 자원으로 보고 루트를 먼저 친다 — 거기서 404 를 받으면 인가서버를
//  발견하지 못하고 401 에서 멈춘다(실측: 2026-08-04 dev.lvly.io 프로브). 같은 문서를 한 벌 더 낸다.
//
//  ⚠ **정본과 한 글자도 달라선 안 된다.** issuer 는 RFC 8414/9207 에서 문자열 동등 비교 대상이라
//   `https://gw` 와 `https://gw/`(URL 정규화가 붙이는 말미 슬래시)는 서로 다른 값이다. 손으로 만들면
//   반드시 어긋난다 — 실제로 첫 구현이 그렇게 어긋났다(통합테스트가 잡음). 그래서 issuer 는 SDK 자신의
//   메타데이터 생성기(createOAuthMetadata)에서 뽑고, 자원 식별자도 같은 URL 정규화를 통과시킨다.
function prmRootAlias(ids: ResourceIds, issuer: string): express.RequestHandler {
  const doc = {
    resource: new URL(ids.mcp).href,
    authorization_servers: [issuer],
    scopes_supported: [...ADVERTISED_SCOPES],
    resource_name: RESOURCE_NAME,
  };
  const router = express.Router();
  const cors = (res: express.Response): void => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
  };
  router.options("/.well-known/oauth-protected-resource", (_req, res) => { cors(res); res.status(204).end(); });
  router.get("/.well-known/oauth-protected-resource", (_req, res) => { cors(res); res.status(200).json(doc); });
  return router;
}

function build(ids: ResourceIds): express.RequestHandler {
  const opts = {
    provider,
    issuerUrl: new URL(ids.base),
    resourceServerUrl: new URL(ids.mcp),
    scopesSupported: [...ADVERTISED_SCOPES],
    resourceName: RESOURCE_NAME,
  };
  // 같은 옵션으로 SDK 가 만들 메타데이터를 먼저 뽑아 issuer 문자열을 얻는다(루트 별칭이 정본과 어긋나지 않게).
  const issuer = createOAuthMetadata(opts).issuer;
  const router = express.Router();
  router.use(prmRootAlias(ids, issuer));
  router.use(mcpAuthRouter(opts));
  return router;
}

// 이 라우터가 소유하는 경로. **앱 루트에 마운트되므로**(SDK 요구) 모든 요청이 여기를 지난다 —
//  자기 경로가 아니면 async 로 들어가기 전에 동기로 걸러낸다. 안 그러면 /healthz 같은 얕은 경로에까지
//  주소 해소(캐시 미스 시 DB 조회)가 끼어든다.
const OWNED = ["/authorize", "/token", "/register", "/revoke", "/.well-known/oauth-"];
const owns = (p: string): boolean => OWNED.some((o) => p === o || p.startsWith(o));

/** /authorize · /token · /register · /revoke · /.well-known/* 를 앱 **루트**에 마운트한다(SDK 요구사항). */
export function oauthAuthorizationServer(): express.RequestHandler {
  let cached: { base: string; handler: express.RequestHandler } | null = null;
  let warnedFor = "";
  return (req, res, next) => {
    if (!owns(req.path)) { next(); return; }
    resourceIds().then((ids) => {
      if (!ids) { next(); return; }               // 공개 주소 미설정 — OAuth 비활성(위 머리주석)
      if (cached?.base !== ids.base) {
        try {
          cached = { base: ids.base, handler: build(ids) };
          logger.info({ issuer: ids.base, resource: ids.mcp }, "OAuth 2.1 인가서버 활성화");
        } catch (err) {
          // issuer 가 https 가 아니면 SDK 가 던진다(localhost 는 예외). 게이트웨이 자체는 계속 떠야 하므로
          //  OAuth 만 끄고 지나간다 — 같은 주소로는 한 번만 경고한다(로그 폭주 방지).
          if (warnedFor !== ids.base) {
            logger.warn({ err: (err as Error).message, base: ids.base },
              "OAuth 인가서버 비활성 — issuer 가 https 가 아니거나 형태가 부적합(공개 HTTPS 주소가 필요)");
            warnedFor = ids.base;
          }
          cached = null;
          next();
          return;
        }
      }
      cached.handler(req, res, next);
    }).catch((err) => {
      logger.error({ err }, "OAuth 라우터 해소 실패");
      next();
    });
  };
}
