// 세션 호스트 자격 창구 (#2600 T2 (d) d5) — **브로커가** 부르는 기계 라우트.
//
// ── 왜 사용자 auth 가 없나 · 그런데 왜 서명을 또 받나 ───────────────────────
// 브로커에는 사람 세션도 ops 토큰도 없다. 있는 것은 CP↔코어가 이미 공유하는 테넌트 헤더 비밀
//  (`LIVELY_TENANT_HEADER_SECRET`)뿐이다 — MCP 프록시·세션 장부가 같은 열쇠를 쓴다. 새 자격을 만들지 않는다.
//
// ★★ 그런데 **테넌트 헤더만으로는 부족하다.** CP 라우터는 인터넷에서 온 모든 요청에 그 헤더를 붙여
//  게이트웨이로 넘기고(router.ts «이 접두는 우리만 만든다»), 세션 컨테이너의 MCP 프록시도 같은 헤더를
//  붙인다. 그 헤더만 보면 **로그인 없이 누구나** `<slug>.app.lvly.io` 로 이 라우트를 때려
//  **노드 토큰을 발급받는다** — 세션 장부(#2544)가 세션 id 목록에 대해 정확히 이 함정을 적어 뒀고,
//  여기서 새는 것은 목록이 아니라 **자격 그 자체**라 훨씬 나쁘다. 그래서 비밀을 아는 쪽만 계산할 수
//  있는 서명을 하나 더 요구한다 — `x-lvly-sesshost-auth = HMAC-SHA256(비밀, "sesshost:<slug>")`
//  (장부의 `ledgerAuthToken`·brokernet 의 `hubClientToken` 과 같은 꼴). 새 env 는 없다.
//
// ⚠ 응답의 `token` 은 **평문 노드 토큰**이다. 로그에 싣지 않는다(아래 로그는 발급 여부만 남긴다).
import crypto from "node:crypto";
import type express from "express";
import { wrap, HttpError } from "../http/rest-util.js";
import { resolveTenantFromHeaders } from "../org/tenant-context.js";
import { servedAgentVersion } from "./agent-bundle.js";
import { ensureSessionHostNode, sessionHostNodeId } from "./session-host-provision.js";
import { logger } from "../log.js";

export const SESSION_HOST_AUTH_HEADER = "x-lvly-sesshost-auth";

/** 서명(순수) — 브로커(lvly-cloud sesshost.ts)가 **같은 식**으로 만든다. 한쪽만 바꾸면 401 이 된다. */
export function sessionHostAuthToken(secret: string, slug: string): string {
  return crypto.createHmac("sha256", secret).update(`sesshost:${slug}`).digest("hex");
}

/**
 * 접근 판정(순수) — 비밀 미설정이면 404(경로가 없는 것과 같다: 셀프호스팅 무회귀), 테넌트 헤더가
 *  비밀과 안 맞거나 **서명이 없거나 틀리면** 401. 실패 사유를 밖에 가르지 않는다.
 */
export function sessionHostAccess(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): { status: 200 | 401 | 404; slug: string; why: string } {
  const secret = (env.LIVELY_TENANT_HEADER_SECRET || "").trim();
  if (!secret) return { status: 404, slug: "", why: "매니지드 배포가 아니다" };
  const r = resolveTenantFromHeaders(headers, env);
  if (!r.ok) return { status: 401, slug: "", why: r.detail };
  const raw = headers[SESSION_HOST_AUTH_HEADER];
  const got = (Array.isArray(raw) ? raw[0] : raw || "").trim();
  const want = sessionHostAuthToken(secret, r.tenant.slug);
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return { status: 401, slug: "", why: "세션 호스트 서명 없음/불일치" };
  }
  return { status: 200, slug: r.tenant.slug, why: "ok" };
}

/** 본문의 `issue` 를 읽는다(순수) — **정확히 true 일 때만** 발급이다(«관대하게 읽어 주는» 쪽이 더 위험하다). */
export function wantsIssue(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { issue?: unknown }).issue === true;
}

/**
 * 본문의 `node`(부르는 브로커가 도는 노드 이름)를 읽는다(순수). 없으면 **빈 문자열** (#3797 T7).
 *
 * ★ 이 값이 곧 축이다 — 세션 호스트는 (노드, 테넌트) 별로 하나이므로, 노드를 모르면 어느 행인지도
 *  모른다. **없으면 지어내지 않고 400** 이다(라우트): 관대하게 «테넌트 하나» 짜리 행으로 떨어지면
 *  그게 정확히 옛 축이고, 그 행을 두 노드가 다시 두고 싸운다.
 * ⚠ 그래서 **옛 브로커(#3797 이전)의 요청은 400 이 된다.** 오늘 그 경로로 서 있는 세션 호스트는
 *  0 이라(`LVLY_SESSHOST_TENANTS` 빈 값 — 실측 2026-09-09) 사람이 겪는 차이는 없다. 배포 순서는
 *  코어 먼저·브로커 나중이고, 그 사이 브로커는 «자격 조회 실패» 로 로그만 남기고 다음 스캔에 다시 본다.
 */
export function requestedNode(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const v = (body as { node?: unknown }).node;
  return typeof v === "string" ? v.trim() : "";
}

export function registerSessionHostRoute(app: express.Express): void {
  // ⚠ 사용자 auth 없음 — 머리말. 기계(브로커)가 테넌트 비밀 + 서명으로 연다.
  app.post("/api/ui/node/session-host/ensure", wrap(async (req, res) => {
    const a = sessionHostAccess(req.headers as Record<string, string | string[] | undefined>);
    if (a.status !== 200) throw new HttpError(a.status, a.status === 404 ? "not found" : "세션 호스트 인증 실패");
    const node = requestedNode(req.body);
    if (!node) throw new HttpError(400, "node(부르는 노드 이름)가 필요합니다 — 세션 호스트는 (노드, 테넌트) 별로 하나입니다");
    if (!sessionHostNodeId(a.slug, node)) throw new HttpError(400, "이 (슬러그, 노드) 로는 세션 호스트 노드 id 를 만들 수 없습니다");

    const issue = wantsIssue(req.body);
    const r = await ensureSessionHostNode(a.slug, node, issue);
    //  ★ 토큰은 **여기 안 찍는다.** 남기는 것은 «발급했나» 하나뿐 — 그것만 있어도 회전 폭주를 읽는다.
    logger.info({ slug: a.slug, on: node, node: r.nodeId, action: r.action, issued: !!r.token, enabled: r.enabled },
      "세션 호스트 자격 보장");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      nodeId: r.nodeId,
      owner: r.owner,
      enabled: r.enabled,
      sessionHost: r.sessionHost,
      action: r.action,
      //  브로커가 «지금 깔린 번들이 낡았나» 를 이 값으로 판정한다(노드 에이전트의 자가 갱신 판정과 같은 지문).
      //  ⚠ null 이면 «모름»이다(번들 미빌드) — 브로커는 모르면 안 건드린다.
      agentVer: servedAgentVersion(),
      token: r.token,
    });
  }));
}
