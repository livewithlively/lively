// Lively Context 웹 UI — 얇은 REST 어댑터(/api/ui/*) + 정적 프론트(/ui). DESIGN §10.1, Stage①.
// 라우트별 도메인 로직은 전부 src/capabilities/* 로 이동 — 여기는 restMounts() 를 순회해
// 기존 경로(+alias)에 그대로 마운트만 한다(경로·검증 메시지·응답 shape byte-compat).
// 인증(P4): 사람=웹 로그인 세션 쿠키(scope=멤버 LIVE) · 에이전트=bearer 토큰. 한 미들웨어가 둘 다 수용해
//  LivelyUser 로 정규화한다(세션 우선, 없으면 bearer). scope 게이트는 정규화된 user.scopes 로 공통 적용.
// 정적 자산은 비인증(사내망 전제) — 데이터는 전부 /api/ui 토큰/세션 뒤. domainmap 은 무인증 서비스라
// 이 프록시의 인증이 신뢰 경계(절대 비인증 프록시 금지).
import express from "express";
import { runSchedulerTickOnce } from "./scheduler/engine.js";
import { seedDefaultContent } from "./org/delivery/seed-content.js";
import { requireAppTool } from "./apps/principal.js";
import { pruneCallLog } from "./org/policies/call-log-prune.js";
import { getRuntimeConfig } from "./org/store/runtime-config.js";
import { backfillSessionStates } from "./sessions/session-state-backfill.js";
import { reapIdleSessions } from "./sessions/session-reaper.js";
import path from "node:path";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { stateDir } from "./ops/state-dir.js";
import { fileURLToPath } from "node:url";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { restMounts, isReadOnlyBlocked } from "./capabilities/index.js";
import { viewerOf } from "./capabilities/principal.js";
import { wrap, HttpError } from "./http/rest-util.js";
import { DANGEROUS_SCOPES, type Scope } from "./auth/scopes.js";
import { sessionOrBearer } from "./auth/http-auth.js";
import { sessionFromHeaders, readOnlyFromHeaders, incognitoFromHeaders } from "./org/auth/agent-identity.js"; // #852 세션 · #1007 읽기전용/인코그니토
import {
  parseSessionCookie, createSession, revokeSession, sessionCookie, clearSessionCookie,
} from "./auth/sessions.js";
import { verifyLogin, verifyOwnPassword, setMemberPassword, hasCredential } from "./auth/local-accounts.js";
import { activeProviders } from "./auth/providers.js";
import { ee } from "./enterprise/registry.js"; // #1601 외부 IdP 로그인(SSO)은 Enterprise — 미탑재면 local 만 남는다
import { gatewayUrlForRequest } from "./gateway-url.js";
import { startDeviceAuth, pollDeviceAuth } from "./org/auth/device-auth.js";
import { exchangeSessionCode, exchangeLandingPath } from "./org/store.js"; // #1454 S1 — 세션 SSO 브리지(1회용 코드 → 세션)
import { bootstrapBody } from "./bootstrap-asset.js";
import { registerWebhookRoutes } from "./connectors/generic/webhook-routes.js"; // #1419 T2 — 무인증 웹훅 수신구

// req.auth.extra 에 심긴 LivelyUser 를 꺼낸다(세션·bearer 공통 — 둘 다 이 형태로 채운다).
const userOf = (req: express.Request): LivelyUser =>
  ((req as unknown as { auth?: { extra?: unknown } }).auth?.extra ?? {}) as unknown as LivelyUser;

const IMMUTABLE = "public, max-age=31536000, immutable";

/** 자산 응답의 Cache-Control 을 고른다 (#1760).
 *
 *  `?v=` 는 **캐시 키일 뿐 내용 선택자가 아니다** — 서버는 언제나 그 순간의 디스크 파일을 준다.
 *  그래서 요청이 든 v 가 지금 빌드버전과 다르면, 그 URL 로 받아 간 것이 **다른 세대와 섞인 조합일
 *  수 있다**(빌드 도중 스탬프된 HTML, 또는 배포를 넘긴 옛 탭). 그런 응답을 immutable(1년)로 굳히면
 *  모듈 그래프가 어긋난 채 캐시에 박혀, 사람이 강제 새로고침을 하기 전까지 화면이 백지로 고정된다
 *  — 실제 사고: v2/main.js(옛것)가 views.js(새것)에서 이미 옮겨간 심볼을 import 해 ESM 로드 실패.
 *
 *  그래서 **지금 세대와 일치할 때만** 굳힌다. 불일치는 no-store 로 흘려보내 다음 로드가 새 버전으로
 *  복구되게 한다(index.html 은 no-store 라 언제나 최신 버전 스탬프를 준다).
 */
export function assetCacheControl(reqV: string, currentV: string): string {
  if (reqV === "") return "no-cache"; // ?v= 없는 직접·구 URL 은 재검증(하위호환)
  return reqV === currentV ? IMMUTABLE : "no-store";
}

export function registerWebUi(app: express.Express, verifier: BearerVerifier): void {
  // 세션 쿠키(웹 로그인, scope=멤버 LIVE) OR bearer(에이전트) — 공통 미들웨어(http-auth). 터미널·프로젝트 라우트도 동일 사용.
  const authResolve = sessionOrBearer(verifier);

  // scope 게이트(세션·bearer 공통). null=인증만. fail-closed(미인증 401 / 권한부족 403).
  const requireScope = (scope: Scope | null): express.RequestHandler => (req, res, next) => {
    const user = userOf(req);
    if (!user || !user.userId) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (scope && !(Array.isArray(user.scopes) && user.scopes.includes(scope))) {
      res.status(403).json({ error: `forbidden: '${scope}' 권한이 필요합니다` }); return;
    }
    next();
  };

  const mw = (scope: Scope | null): express.RequestHandler[] => [authResolve, requireScope(scope)];

  // ── 테넌트 하우스키핑 틱(#1437 중앙 모드) ──────────────────────────────────
  // 요청별 테넌시에서는 부팅 하우스키핑·스케줄러가 전부 꺼진다(요청 밖엔 테넌트 컨텍스트가 없다 —
  //  boot/housekeeping.requestScopedTenancy). 그 일들을 **요청으로** 되살리는 자리가 여기다:
  //  CP 가 테넌트마다 주기적으로 이 엔드포인트를 두드리고, 요청 컨텍스트(테넌트 헤더) 안에서
  //  스케줄러 틱·시딩·정리가 그 테넌트 스코프로 돈다. itemsPool 파사드가 격리를 보장한다.
  //
  //  ⚠ 빨리 돌아온다 — 크론 잡 실행은 스케줄러 내부에서 fire-and-forget(중첩은 잡별 락이 막는다).
  //  ⚠ 자가호스팅(고정/단일 테넌트)에서는 부팅 경로가 이미 이 일들을 하므로 이 엔드포인트를 부를
  //   일이 없다 — 있어도 각 단계가 멱등이라 무해하다.
  app.post("/api/ops/housekeeping/tick", ...mw("admin"), wrap(async (_req, res) => {
    const out: Record<string, unknown> = {};
    const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try { out[name] = (await fn()) ?? "ok"; }
      catch (e) { out[name] = { error: e instanceof Error ? e.message : String(e) }; }
    };
    await step("scheduler", async () => { await runSchedulerTickOnce(); return "ticked"; });
    await step("seed-default-content", () => seedDefaultContent());
    await step("call-log-prune", async () => {
      const cfg = await getRuntimeConfig();
      return { deleted: await pruneCallLog(cfg.call_log_policy?.retention_days ?? 0) };
    });
    await step("session-backfill", async () => { await backfillSessionStates(); return "ok"; });
    await step("session-reaper", async () => { await reapIdleSessions(); return "ok"; });
    res.json({ ok: true, steps: out });
  }));

  // ── 로컬 로그인/로그아웃/비번변경(P4). 로그인은 미인증 접근(cap 마운트보다 먼저). ──
  // 매니지드(요청별 테넌시) 배포 노브 — 미인증 방문을 컨트롤플레인으로 돌려보낸다(#1437).
  //  테넌트의 자체 로그인 화면은 셀프호스팅용이다: 매니지드에선 계정이 CP(app.lvly.io)에 있어
  //  그 화면이 막다른 길이 된다. 값이 없으면(셀프호스팅) null — 프론트 게이트가 종전대로 뜬다.
  //  인증 불요(공개 설정값 하나뿐) · DB 무접촉(테넌트 컨텍스트 무관).
  app.get("/api/ui/auth-config", (_req, res) => {
    res.json({ login_redirect_url: process.env.LIVELY_LOGIN_REDIRECT_URL || null });
  });

  app.post("/api/ui/login", wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await verifyLogin(String(body.email ?? ""), String(body.password ?? ""));
    if (!result.ok) {
      res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다" }); return;
    }
    const { sessionId, expiresAt } = await createSession(result.memberId,
      { ip: req.ip, userAgent: (req.headers["user-agent"] as string) ?? null });
    res.setHeader("Set-Cookie", sessionCookie(sessionId, expiresAt));
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, memberId: result.memberId, mustChange: result.mustChange });
  }));

  // ── 활성 제공자 목록 — 로그인 화면이 어떤 버튼을 그릴지 묻는다. 라벨 외엔 아무 설정도 나가지 않는다. ──
  //  ★ #1601 — 외부 IdP 로그인(SSO/OIDC) 구현은 Enterprise(src/ee/auth/)로 갔다. EE 미탑재면 여기 local 하나만
  //   담겨 돌아오고 로그인 화면에 SSO 버튼이 안 뜬다 — 거부가 아니라 **그게 정상 동작**이다(auth/providers.ts 참조).
  app.get("/api/ui/auth/providers", wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ providers: await activeProviders() });
  }));

  // 외부 IdP 로그인(SSO) 라우트 — 인가 개시·콜백·계정 갈림길. 전부 **무인증**(세션을 얻기 전에 타는 문)이라
  //  코어의 scope 미들웨어를 태우지 않고 EE 가 직접 app 에 붙인다. 미탑재면 그 경로들이 아예 없다(404).
  ee().sso?.registerSsoRoutes(app);

  // ── 세션 SSO 브리지 교환(#1454 S1) — 컨트롤플레인이 발급한 1회용 코드(org_session_mint)를 웹 세션으로. ──
  //  **비인증**(로그인과 같은 성격 — 세션을 얻기 전에 탈 수 있는 유일한 문). code 자체가 비밀이다:
  //  TTL 60초·1회용·저장은 sha256 뿐(검증·소비·감사는 exchangeSessionCode 가 원자적으로 수행).
  //  브라우저 리다이렉트 흐름이라 JSON 이 아니라 302 로 답한다 — 성공은 /ui/(또는 `?to=#/…` 해시 착지 — #1771,
  //  CLI/데스크톱 디바이스 승인 `#/activate?code=…` 회귀), 실패는 게이트(로그인 화면)로.
  //  셀프호스트 무해: 발급 창구(admin 전용)를 안 쓰면 코드가 존재하지 않아 이 라우트는 항상 실패 리다이렉트다.
  app.get("/api/ui/session/exchange", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const r = await exchangeSessionCode(String(req.query?.code ?? ""), { ip: req.ip });
    if (!r) { res.redirect(302, "/ui/#/login?error=exchange"); return; }
    const { sessionId, expiresAt } = await createSession(r.memberId,
      { ip: req.ip, userAgent: (req.headers["user-agent"] as string) ?? null });
    res.setHeader("Set-Cookie", sessionCookie(sessionId, expiresAt));
    res.redirect(302, exchangeLandingPath(req.query?.to));
  }));

  app.post("/api/ui/logout", wrap(async (req, res) => {
    const sid = parseSessionCookie(req.headers.cookie);
    if (sid) await revokeSession(sid);
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  }));

  // 본인 비번 변경 — 세션/토큰 인증 필요. 현재 비번 확인 후 교체(8자+).
  app.post("/api/ui/password", ...mw(null), wrap(async (req, res) => {
    const user = userOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nextPw = String(body.next ?? "");
    if (nextPw.length < 8) { res.status(400).json({ error: "새 비밀번호는 8자 이상이어야 합니다" }); return; }
    const ok = await verifyOwnPassword(user.userId, String(body.current ?? ""));
    if (!ok) { res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다" }); return; }
    await setMemberPassword(user.userId, nextPw, { mustChange: false, actor: user.userId });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  }));

  // ── 내 로그인 수단(#1520 A) — '지금 무엇으로 들어올 수 있는가' + 회사 계정 연결 해제. ──
  //  연결 '시작'은 여기가 아니라 /api/ui/auth/oidc/start?link=1 이다(IdP 왕복이 필요하므로 302 흐름).
  app.get("/api/ui/me/logins", ...mw(null), wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const user = userOf(req);
    const providers = await activeProviders();
    // ★ #1601 — linked/email 은 EE(SSO) 소관, hasPassword 는 코어(local-accounts) 소관이다.
    //  EE 미탑재면 '안 붙었다'가 사실이므로 그대로 답한다(거부하지 않는다) — 화면은 비밀번호 수단을 계속 보여준다.
    const link = (await ee().sso?.ssoLinkStatus(user.userId)) ?? { linked: false, email: null };
    res.json({
      ...link,
      hasPassword: await hasCredential(user.userId),
      oidcAvailable: providers.some((p) => p.kind === "oidc" && p.enabled),
      oidcLabel: providers.find((p) => p.kind === "oidc")?.label ?? null,
    });
  }));

  // 해제 — 로컬 비밀번호가 없으면 거절한다(해제하는 순간 로그인 수단이 0이 되어 자기 계정에서 잠긴다).
  app.post("/api/ui/me/oidc/unlink", ...mw(null), wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const sso = ee().sso;
    // EE 미탑재면 애초에 붙일 수 있는 IdP 가 없다 — 해제할 것도 없으므로 404(정책 거부가 아니라 부재).
    if (!sso) { res.status(404).json({ error: "회사 계정 로그인이 이 배포에 설정되어 있지 않습니다" }); return; }
    const r = await sso.ssoUnlink(userOf(req).userId);
    if (!r.ok) {
      res.status(r.reason === "would_lock_out" ? 409 : 404).json({
        error: r.reason === "would_lock_out"
          ? "비밀번호를 먼저 설정하세요 — 지금 해제하면 로그인할 수단이 없어집니다"
          : "구성원을 찾을 수 없습니다",
      });
      return;
    }
    res.json({ ok: true });
  }));

  // ── #551 노션 자산(이미지/파일) 서빙 — 커넥터가 다운로드한 만료-URL 파일의 영구 사본. ──
  //  본문 데이터라 인증 필수(public 정적 서빙은 비인증이므로 그쪽에 두지 않는다). <img> 는 same-origin
  //  세션 쿠키가 실려 통과. 파일명은 커넥터 해시(경로문자 없음)지만 화이트리스트+정규화로 이중 방어.
  //  보안(#551 리뷰): 확장자는 노션 파일명에서 오는 공격자 제어 값 — 콘텐츠 스니핑 저장형 XSS 를 막기 위해
  //  ① X-Content-Type-Options: nosniff 상시 ② inline 은 미디어 화이트리스트만(svg/html 포함 그 외 전부
  //  octet-stream + attachment 강제 다운로드) ③ 타입은 확장자 맵으로 명시(sendFile 추론 비의존).
  //  경로는 관리탭(org_connector.asset_dir) 우선 — 커넥터 저장 경로와 서빙 경로의 분열 방지.
  const ASSET_INLINE_TYPES: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
    pdf: "application/pdf",
  };
  app.get("/api/ui/notion-assets/:file", ...mw(null), wrap(async (req, res) => {
    const file = String(req.params.file ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(file) || file.includes("..")) {
      res.status(400).json({ error: "잘못된 첨부 파일 이름" }); return;
    }
    // 커넥터와 같은 해소 순서: org_connector(관리탭) → env → 기본. config 계층 캐시라 요청당 DB 부하 0.
    let dir = process.env.NOTION_ASSET_DIR || "";
    try {
      const { resolveConnectorConfig } = await import("./connectors/config.js");
      dir = (await resolveConnectorConfig("notion")).asset_dir || dir;
    } catch { /* config 계층 실패 → env/기본 폴백 */ }
    const assetDir = dir || stateDir("notion-assets");
    const full = path.resolve(assetDir, file);
    if (full !== path.join(assetDir, file)) { res.status(400).json({ error: "잘못된 경로" }); return; }
    const fsMod = await import("node:fs");
    if (!fsMod.existsSync(full)) { res.status(404).json({ error: "첨부 파일 없음" }); return; }
    const ext = (file.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
    const inlineType = ASSET_INLINE_TYPES[ext];
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=86400"); // 파일명이 내용 좌표(해시)라 하루 캐시 무해
    res.setHeader("Content-Type", inlineType ?? "application/octet-stream");
    res.setHeader("Content-Disposition", inlineType ? "inline" : `attachment; filename="${file}"`);
    fsMod.createReadStream(full).on("error", () => { if (!res.headersSent) res.status(404).json({ error: "첨부 파일 없음" }); }).pipe(res);
  }));

  for (const { cap, mount } of restMounts()) {
    const handler = wrap(async (req, res) => {
      // 모드 게이트(#1007) — 파싱/핸들러 전에 헤더로 판정. MCP 는 tools/list 에서 이미 소거되지만, 헤더 실린 REST(스크립트·웹)도
      //  같은 정책으로 강제해 표면 간 불일치를 없앤다. ⚠ 헤더 미실린 raw curl 은 못 막는다(토큰 scope 영역).
      const readOnly = readOnlyFromHeaders(req.headers);
      const incognito = incognitoFromHeaders(req.headers);
      // 인코그니토(#1007+): me(모드 확인용, scope 없음) 빼고 **모든** lively REST 를 403(읽기 포함) = 사실상 연결없음.
      if (incognito && cap.name !== "me") {
        throw new HttpError(403, "인코그니토 세션 — 라이블리 접근이 비활성화되어 있습니다(#1007). 이 세션의 LIVELY_MODE(=incognito)를 해제하고 다시 시도하세요.");
      }
      // 읽기전용: 컨텍스트 스토어에 쓰는 REST 만 403(isReadOnlyBlocked 는 MCP 스킵과 동일 판정).
      if (readOnly && isReadOnlyBlocked(cap)) {
        throw new HttpError(403, "읽기전용 세션 — 컨텍스트 스토어 쓰기가 비활성화되어 있습니다(#1007). 이 세션의 LIVELY_MODE(=readonly)를 해제하고 다시 시도하세요.");
      }
      const input = mount.parse(req); // 기존 qstr/qint/parseMappingBody 검증 그대로(HttpError → wrap)
      const user = userOf(req);
      // B3 defense-in-depth: 미들웨어(mw)에 더해 핸들러 경계에서도 scope 재확인(단일층 의존 제거).
      if (cap.scope && !(Array.isArray(user.scopes) && user.scopes.includes(cap.scope))) {
        throw new HttpError(403, `forbidden: '${cap.scope}' 권한이 필요합니다`);
      }
      // B5: 회수 불가한 정적 토큰(AUTH_TOKENS_JSON)으로는 fleet 제어·정책 변경(admin/runtime) 금지(세션·DB 토큰은 허용).
      if (cap.scope && DANGEROUS_SCOPES.has(cap.scope) && user.tokenSource === "static") {
        throw new HttpError(403, "정적 토큰으로는 관리/런타임 변경이 불가합니다 — 접속 해제할 수 있는 발급 토큰(lvk_)을 사용하세요");
      }
      // #1780: 앱 세션 토큰이면 그 앱 grant 의 도구 allowlist 로 축소(MCP 핸들러와 같은 판정 — 표면 간 일관). 일반 세션은 통과.
      await requireAppTool(user, cap.name);
      // /api/ui 응답은 전부 비공개(토큰 발급 평문 포함) — 프록시/브라우저 캐시 금지.
      res.setHeader("Cache-Control", "no-store");
      res.json(await cap.handler(input, user, {
        source: "web",
        actor: user.userId || user.email,
        // 세션(#852) — REST(스크립트)도 x-lively-session 을 실으면 MCP 와 같은 규칙으로 기록된다(형식 검증 + 소비처 canAttach).
        //  ⚠ agent 는 일부러 안 채운다 — 여기서 User-Agent 를 읽으면 curl/스크립트의 UA("curl/8.4.0")가
        //   author_agent 를 이겨 버린다(normalizeHarness 는 모르는 값을 원문 보존). REST 는 body.author_agent 폴백 유지.
        session: sessionFromHeaders(req.headers) ?? undefined,
        tokenHashPrefix: user.tokenHashPrefix,
        ip: req.ip,
        readOnly, // #1007 — me 가 반환(모드 관측). 강제는 위 게이트가 이미 수행.
        incognito, // #1007+ — me 가 mode 반환
        viewer: viewerOf(user), // #1291 — 열람 신원. MCP 어댑터와 같은 규칙(v2: admin 도 특권이 아니다 — 우회는 긴급열람으로만).
      }));
    });
    for (const path of mount.paths) {
      if (mount.method === "GET") app.get(path, ...mw(cap.scope), handler);
      else app.post(path, ...mw(cap.scope), handler);
    }
  }

  // ── lively CLI 부트스트랩 (#864) — **비인증**. 코드일 뿐 비밀이 없다(/ui 정적 자산과 같은 성격). ──
  //  웹이 건네는 유일한 복붙 한 줄이 여기로 온다:   curl -fsSL <게이트웨이>/cli | sh
  //  종전 설치 한 줄은 **장기 토큰을 명령줄에 박아** ~/.zsh_history 에 영구히 남겼다. 이제 그 줄엔 토큰이 없고,
  //  토큰은 CLI 의 `lively login` 이 /dev/tty 가림 입력으로 받는다(화면·히스토리·클립보드 어디에도 안 남음).
  //  ⚠ 인증을 걸면 안 된다 — 부트스트랩은 **토큰을 얻기 전에** 실행되는 유일한 지점이다(닭-달걀).
  const kitCliDir = fileURLToPath(new URL("../kit/cli", import.meta.url));
  // 게이트웨이 자기 주소(스크립트에 굽는 값) — 확정 규칙(org 프로필 > PUBLIC_URL > 요청 헤더)과 형태 검증은
  //  gateway-url.ts 가 단일 소스로 소유한다(whoami·미리보기 주소도 같은 값을 쓴다). 여기선 부트스트랩의
  //  '없으면 실패' 정책만 얹는다 — 셸 스크립트에 빈 주소를 구워 보내면 안 되니 500 으로 세운다.
  const selfUrl = async (req: express.Request): Promise<string> => {
    const url = await gatewayUrlForRequest(req);
    if (!url) throw new HttpError(500, "게이트웨이 주소를 확정할 수 없습니다 — 관리탭에서 게이트웨이 주소를 설정하세요.");
    return url;
  };
  // 본문 변환(**선행 BOM 제거** + 게이트웨이 주소 굽기)은 bootstrap-asset.ts 가 소유한다 — 사연·불변식은 거기 주석.
  //  요지: 이 둘은 파일이 아니라 **문자열**로 인터프리터에 들어가서(`| iex` · `| sh`) BOM 이 파서까지 간다(#1087).
  const serveBootstrap = (file: string): express.RequestHandler => wrap(async (req, res) => {
    const src = readFileSync(path.join(kitCliDir, file), "utf8");
    res.setHeader("Cache-Control", "no-store"); // 게이트웨이 주소가 바뀔 수 있다 — 부트스트랩은 항상 최신
    res.type("text/plain; charset=utf-8").send(bootstrapBody(src, await selfUrl(req)));
  });
  app.get("/cli", serveBootstrap("bootstrap.sh"));
  app.get("/cli.ps1", serveBootstrap("bootstrap.ps1"));
  // CLI 본체 — 부트스트랩이 받아 ~/.lively/lib/lively.mjs 로 앉힌다. 설치 후엔 이 **같은 파일**이 /install 번들에도
  //  들어 있고(kit_version 지문에 포함) 자동 업데이트(#858)가 함께 갱신한다 = 한 파일, 두 개의 문.
  app.get("/cli/lively.mjs", wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("text/plain; charset=utf-8").send(readFileSync(path.join(kitCliDir, "lively.mjs"), "utf8"));
  }));

  // ── 디바이스 코드 로그인 (#880) — start/poll 은 **무인증**(pre-token, /cli 와 같은 성격). ──
  //  세션 라우트(lookup/approve/deny)는 capabilities 에서 sessionOrBearer 뒤에 마운트된다.
  //  토큰 응답이므로 no-store. verification_uri 는 selfUrl(호스트-only 검증) 재사용.
  app.post("/cli/device/start", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out = await startDeviceAuth(String(body.code_challenge ?? ""), body.label, await selfUrl(req));
    res.json(out);
  }));
  app.post("/cli/device/poll", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = await pollDeviceAuth(String(body.device_code ?? ""), String(body.code_verifier ?? ""));
    if (r.ok) { res.json({ token: r.token, scopes: r.scopes }); return; }
    // RFC 8628 계열 상태코드로 매핑 — CLI 가 이걸로 분기(pending/slow_down 계속, denied/expired/invalid 종료).
    const status = r.error === "authorization_pending" ? 202
      : r.error === "slow_down" ? 429
      : r.error === "access_denied" ? 403
      : r.error === "invalid_verifier" ? 401
      : 410; // expired_token
    res.status(status).json({ error: r.error, ...(r.interval ? { interval: r.interval } : {}) });
  }));

  // ── 웹훅 수신(#1419 T2) — 외부가 밀어넣는 인입구. **무인증**이라 자체 3중 가드를 갖는다(그 파일 헤더 참조).
  //  cap 마운트 밖에 두는 이유: capabilities 는 전부 sessionOrBearer 뒤에 붙는데, 깃허브·사내 시스템은
  //  우리 토큰을 갖고 있지 않다. 인증 대신 수집기 id + HMAC 서명 + 본문 상한으로 막는다.
  registerWebhookRoutes(app);

  // ── 정적 프론트 — dist/web.js 기준 레포루트/public. 해시 라우팅이라 서버 폴백 불필요. ──
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  // #1017 — 콘텐츠 해시 불변 캐싱: mtime·재검증 의존을 폐기한다.
  //  이전(#762/#766/#890)은 index.html→main.js·styles.css 두 자산에만 mtime 버전(?v=)을 박고, 나머지는 no-cache
  //  재검증에 맡겼다. 문제: main.js 가 정적 import 하는 20개 모듈(core.js·projects.js·admin.js …)은 **버전 없는
  //  고정 URL** 이라 전적으로 "브라우저가 no-cache 재검증을 성실히 수행하는가"에 의존했고, 이게 일반 새로고침에선
  //  신뢰할 수 없어(모듈 memory-cache·bfcache) '강제 새로고침해야 반영'이 반복됐다. weak ETag(size+mtime)도
  //  배포가 mtime 을 보존하는 경로(리눅스 고객 박스)에선 내용이 바뀌어도 304 로 옛 코드를 고정시킬 수 있었다.
  //  해법: ① 모든 로컬 자산의 **콘텐츠 해시**로 빌드버전 1개를 만든다(내용 기반 → mtime·배포방식·프록시 무관).
  //   ② HTML 의 로컬 자산 참조 + JS 모듈의 import 그래프 전체에 ?v=<버전> 을 서빙 시점에 주입한다.
  //   ③ ?v= 가 붙은 요청은 immutable 로 서빙 → 내용이 바뀐 자산은 새 URL 이라 무조건 새로 받고(F5 로 충분,
  //   강제 새로고침 불요), 안 바뀐 자산은 재검증 왕복 0(오히려 더 빠름). index.html 은 no-store 라 항상 최신 버전을 참조.
  // 로컬 자산 = public 최상위 *.{js,mjs,css} + public/app/**(하위 포함) *.{js,mjs} + public/styles/**/*.css.
  //  (fonts/img 는 자체로 거의 불변이라 제외 — 필요 시 확장.)
  //  #1313 R50 — 옛 단일 styles.css 를 화면별 public/styles/*.css 로 분할했다. 이 목록이 곧
  //  ① 빌드버전(콘텐츠 해시) 입력 ② ?v= immutable 스탬프 대상이라, styles/ 하위를 빼면 CSS 만
  //  버전 없는 고정 URL 이 돼 #1017 이 고친 '강제 새로고침해야 반영'이 CSS 에서 되살아난다.
  //  ⚠ #1313 R28/R29 — app/ 은 **재귀**로 훑는다. web/lib/ 분해로 public/app/lib/*.js 가 생겼는데
  //   비재귀면 그 파일들이 빌드버전 입력에서 빠져, 'lib 만 고친 배포'에서 버전이 안 올라 브라우저가
  //   immutable(1년) 로 캐시된 옛 모듈을 계속 쓴다. 하필 분해의 목적이 '이 파일만 바뀐다' 라서
  //   정확히 그 시나리오가 흔해진다. 하위 디렉터리가 늘어도 자동으로 잡히도록 재귀가 정답.
  const listLocalAssets = (): string[] => {
    const out: string[] = [];
    const norm = (p: string): string => p.split(path.sep).join("/");
    try { for (const f of readdirSync(publicDir)) if (/\.(?:js|mjs|css)$/.test(f)) out.push(f); } catch { /* noop */ }
    try {
      for (const f of readdirSync(path.join(publicDir, "app"), { recursive: true }) as string[])
        if (/\.(?:js|mjs)$/.test(String(f))) out.push(`app/${norm(String(f))}`);
    } catch { /* noop */ }
    try {
      for (const f of readdirSync(path.join(publicDir, "styles"), { recursive: true }) as string[])
        if (/\.css$/.test(String(f))) out.push(`styles/${norm(String(f))}`);
    } catch { /* noop */ }
    return out.sort();
  };
  // 빌드버전: 자산 콘텐츠의 통합 sha256(앞 12자). 재계산 트리거만 지문(size+mtime, 1s TTL)으로 판단한다 —
  //  dev 박스는 build:web 후 재시작 없이 즉시 반영되고(지문 변화 감지), 고객 박스는 배포=재시작이라 재계산이 보장된다.
  //  ⚠ 지문이 틀려도(mtime 보존 배포) 값 자체는 콘텐츠 해시라 재시작 한 번이면 정확해진다 — mtime 은 최적화일 뿐 정답성 근거 아님.
  const VER_TTL_MS = 1000;
  let verVal = "", verFp = "", verAt = 0;
  const assetVersion = (): string => {
    const now = Date.now();
    if (verVal && now - verAt < VER_TTL_MS) return verVal;
    verAt = now;
    const files = listLocalAssets();
    let fp = "";
    for (const rel of files) { try { const s = statSync(path.join(publicDir, rel)); fp += `${rel}:${s.size}:${Math.floor(s.mtimeMs)};`; } catch { /* 사라진 파일 무시 */ } }
    if (verVal && fp === verFp) return verVal;
    const h = createHash("sha256");
    for (const rel of files) { try { h.update(rel).update("\0").update(readFileSync(path.join(publicDir, rel))); } catch { /* noop */ } }
    verFp = fp; verVal = h.digest("hex").slice(0, 12);
    return verVal;
  };
  // 상대 자산 참조에 버전 주입.
  //  JS: 정적 import/re-export(`… from './x.js'`)·동적 import(`import('./x.js')`) 의 상대 스펙파이어. CDN(https://)·bare 는 제외(`./` 필수).
  //  HTML: <script src>·<link href> 의 상대 로컬 자산. 삽입은 문자열 리터럴 내부라 문법을 깨지 않는다(최악의 오탐도 무해한 쿼리 추가).
  //  ⚠ `../` 도 받는다(#1841). 종전엔 `./` 로 시작하는 것만 잡아서, web/v2/* 가 부모 폴더를 부르는
  //   `from '../core.js'` 류가 통째로 스탬프를 못 받았다 — 그 모듈들은 버전이 안 붙어 캐시 정책 밖으로 샜고,
  //   같은 파일이 `?v=` 있는 판과 없는 판 **두 벌로 로드**돼 모듈 인스턴스가 갈렸다(실측: gen-watch 가
  //   두 번 로드돼 v2 쪽 인스턴스는 자기 세대를 못 읽었다).
  const JS_IMPORT_RE = /((?:\bfrom|\bimport)\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?\.(?:js|mjs|css))(['"])/g;
  const HTML_ASSET_RE = /(\s(?:src|href)\s*=\s*)(['"])(\.{1,2}\/[^'"]+?\.(?:js|mjs|css))(['"])/g;
  const stampJs = (src: string, v: string): string => src.replace(JS_IMPORT_RE, (_m, pre, q1, spec, q2) => `${pre}${q1}${spec}?v=${v}${q2}`);
  const stampHtml = (src: string, v: string): string => src.replace(HTML_ASSET_RE, (_m, pre, q1, spec, q2) => `${pre}${q1}${spec}?v=${v}${q2}`);
  // 모듈 rewrite 결과 캐시(버전·mtime 키) — 큰 번들(projects.js 700KB+)의 매요청 정규식 치환 회피. immutable 이라 재요청도 드묾.
  const modCache = new Map<string, { v: string; mtime: number; body: string }>();
  const moduleBody = (full: string, v: string): string => {
    const mtime = Math.floor(statSync(full).mtimeMs);
    const c = modCache.get(full);
    if (c && c.v === v && c.mtime === mtime) return c.body;
    const body = stampJs(readFileSync(full, "utf8"), v);
    modCache.set(full, { v, mtime, body });
    return body;
  };
  // 경로 이탈(../) 차단 — 정규화 후 publicDir 하위만 허용.
  const safeAsset = (rel: string): string | null => {
    const full = path.resolve(publicDir, rel);
    return (full === publicDir || full.startsWith(publicDir + path.sep)) ? full : null;
  };
  const sendHtml = (full: string, res: express.Response): void => {
    res.setHeader("Cache-Control", "no-store"); // HTML 진입점은 항상 최신 — 버전 스탬프가 언제나 최신이도록
    res.type("html").send(stampHtml(readFileSync(full, "utf8"), assetVersion()));
  };
  const serveStatic: express.RequestHandler = (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
    let rel = decodeURIComponent(req.path).replace(/^\/+/, "");
    if (rel === "") rel = "index.html"; // /ui · /ui/ → index.html
    const full = safeAsset(rel);
    if (!full) { res.status(400).end(); return; }
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { next(); return; } // 없으면 다음(해시라우팅이라 SPA 폴백 불요)
    if (!st.isFile()) { next(); return; }
    // 캐시 정책은 assetCacheControl 참조(#1760) — 지금 세대와 일치하는 ?v= 만 immutable 로 굳힌다.
    const cacheHdr = assetCacheControl(typeof req.query.v === "string" ? req.query.v : "", assetVersion());
    if (/\.(?:js|mjs)$/.test(full)) {
      res.setHeader("Cache-Control", cacheHdr);
      res.type("application/javascript; charset=utf-8").send(moduleBody(full, assetVersion())); return;
    }
    if (/\.html?$/.test(full)) { sendHtml(full, res); return; }
    res.setHeader("Cache-Control", cacheHdr);
    res.sendFile(full, { cacheControl: false }); return; // cacheControl:false — express 가 우리 헤더를 덮어쓰지 않도록
  };
  // 세대 알림(#1841) — 지금 서빙 중인 자산 세대를 한 줄로 알려준다. 화면이 자기 세대와 비교해
  //  낡았으면 스스로 다시 싣는다(web/gen-watch.ts). 인증 불요(정적 자산과 같은 급), 캐시 금지.
  //  ⚠ 이게 필요한 이유: 데스크톱 앱 창은 닫아도 죽지 않고(hide) 다시 열 때 loadURL 을 건너뛴다.
  //   그래서 게이트웨이가 갱신돼도 앱은 처음 뜬 판을 영영 들고 있었다(실측 2026-08-21: 앱 세대
  //   7964959ed50d vs 서버 882a0a3d262e — 원준이 "반영 안 된 것 같다"를 세 번 말한 진짜 원인).
  app.get("/ui/__gen", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ v: assetVersion() });
  });
  app.use("/ui", serveStatic);
  app.get("/", (_req, res) => res.redirect("/ui/"));
}
