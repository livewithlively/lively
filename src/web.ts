// Lively Context 웹 UI — 얇은 REST 어댑터(/api/ui/*) + 정적 프론트(/ui). DESIGN §10.1, Stage①.
// 라우트별 도메인 로직은 전부 src/capabilities/* 로 이동 — 여기는 restMounts() 를 순회해
// 기존 경로(+alias)에 그대로 마운트만 한다(경로·검증 메시지·응답 shape byte-compat).
// 인증(P4): 사람=웹 로그인 세션 쿠키(scope=멤버 LIVE) · 에이전트=bearer 토큰. 한 미들웨어가 둘 다 수용해
//  LivelyUser 로 정규화한다(세션 우선, 없으면 bearer). scope 게이트는 정규화된 user.scopes 로 공통 적용.
// 정적 자산은 비인증(사내망 전제) — 데이터는 전부 /api/ui 토큰/세션 뒤. domainmap 은 무인증 서비스라
// 이 프록시의 인증이 신뢰 경계(절대 비인증 프록시 금지).
import express from "express";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { stateDir } from "./state-dir.js";
import { fileURLToPath } from "node:url";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { restMounts, isReadOnlyBlocked } from "./capabilities/index.js";
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { DANGEROUS_SCOPES, type Scope } from "./capabilities/scopes.js";
import { sessionOrBearer } from "./auth/http-auth.js";
import { sessionFromHeaders, readOnlyFromHeaders, incognitoFromHeaders } from "./org/agent-identity.js"; // #852 세션 · #1007 읽기전용/인코그니토
import {
  parseSessionCookie, createSession, revokeSession, sessionCookie, clearSessionCookie,
} from "./auth/sessions.js";
import { verifyLogin, verifyOwnPassword, setMemberPassword } from "./auth/local-accounts.js";
import { getOrgProfile } from "./org/store.js";
import { startDeviceAuth, pollDeviceAuth } from "./org/device-auth.js";

// req.auth.extra 에 심긴 LivelyUser 를 꺼낸다(세션·bearer 공통 — 둘 다 이 형태로 채운다).
const userOf = (req: express.Request): LivelyUser =>
  ((req as unknown as { auth?: { extra?: unknown } }).auth?.extra ?? {}) as unknown as LivelyUser;

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

  // ── 로컬 로그인/로그아웃/비번변경(P4). 로그인은 미인증 접근(cap 마운트보다 먼저). ──
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
        throw new HttpError(403, "인코그니토 세션 — 라이블리 접근이 비활성화되어 있습니다(#1007). 이 세션의 LIVELY_INCOGNITO 를 끄고 다시 시도하세요.");
      }
      // 읽기전용: 컨텍스트 스토어에 쓰는 REST 만 403(isReadOnlyBlocked 는 MCP 스킵과 동일 판정).
      if (readOnly && isReadOnlyBlocked(cap)) {
        throw new HttpError(403, "읽기전용 세션 — 컨텍스트 스토어 쓰기가 비활성화되어 있습니다(#1007). 이 세션의 LIVELY_READONLY 를 끄고 다시 시도하세요.");
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
  // 게이트웨이 자기 주소(스크립트에 굽는 값): org 프로필 > PUBLIC_URL > 요청 헤더.
  //  ⚠ req.protocol 을 못 믿는 이유 — Caddy 가 TLS 를 종단해 게이트웨이는 http 로 받는다(auth/sessions.ts:68 과 같은 사정).
  //  그래서 공개 스킴은 org 프로필/PUBLIC_URL 이 권위고, 헤더는 최후 폴백이다.
  //  ⚠ 이 값은 실행되는 셸/PowerShell 스크립트의 문자열 리터럴 안으로 들어간다 → **반드시 형태를 검증**한다.
  //   헤더 폴백은 요청자가 통제할 수 있으니(Host), `"`·`$(…)`·백틱이 섞이면 자기 자신에게 셸 인젝션이 된다.
  //   실사용에선 org 프로필/PUBLIC_URL 이 먼저 잡혀 폴백이 거의 안 쓰이지만, 방어는 값싸다.
  const SAFE_URL = /^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/;
  const selfUrl = async (req: express.Request): Promise<string> => {
    const clean = (u: string): string => u.replace(/\/mcp$/, "").replace(/\/+$/, "");
    try {
      const p = await getOrgProfile();
      if (p.gateway_url && SAFE_URL.test(clean(p.gateway_url))) return clean(p.gateway_url);
    } catch { /* DB 미가동 등 — 폴백 */ }
    const pub = clean(process.env.PUBLIC_URL || "");
    if (pub && SAFE_URL.test(pub)) return pub;
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
    const guess = `${proto}://${req.get("host") ?? ""}`;
    if (SAFE_URL.test(guess)) return guess;
    throw new HttpError(500, "게이트웨이 주소를 확정할 수 없습니다 — 관리탭에서 게이트웨이 주소를 설정하세요.");
  };
  const serveBootstrap = (file: string): express.RequestHandler => wrap(async (req, res) => {
    const src = readFileSync(path.join(kitCliDir, file), "utf8");
    res.setHeader("Cache-Control", "no-store"); // 게이트웨이 주소가 바뀔 수 있다 — 부트스트랩은 항상 최신
    res.type("text/plain; charset=utf-8").send(src.replaceAll("__LIVELY_GATEWAY__", await selfUrl(req)));
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

  // ── 정적 프론트 — dist/web.js 기준 레포루트/public. 해시 라우팅이라 서버 폴백 불필요. ──
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  // #762/#766 후속 — 캐시 버스팅: index.html 의 로컬 자산(styles.css·app/main.js)에 파일 mtime 버전(?v=)을 박는다.
  //  기본 express.static 은 Cache-Control: max-age=0(재검증) 이지만 일부 브라우저가 재검증을 건너뛰어(bfcache·메모리캐시)
  //  배포 후 옛 CSS/JS 를 계속 보여주던 문제 방지 — 자산이 바뀌면 mtime→URL 이 바뀌어 브라우저가 강제 재요청한다.
  const assetVer = (rel: string): string => {
    try { return String(Math.floor(statSync(path.join(publicDir, rel)).mtimeMs)); } catch { return "0"; }
  };
  const serveIndex = (_req: express.Request, res: express.Response): void => {
    try {
      const html = readFileSync(path.join(publicDir, "index.html"), "utf8")
        .replace(/\.\/styles\.css/g, `./styles.css?v=${assetVer("styles.css")}`)
        .replace(/\.\/app\/main\.js/g, `./app/main.js?v=${assetVer("app/main.js")}`);
      res.setHeader("Cache-Control", "no-store"); // index.html 자체는 항상 최신(버전 스탬프가 최신이도록)
      res.type("html").send(html);
    } catch { res.sendFile(path.join(publicDir, "index.html")); } // 실패 시 원본 폴백
  };
  app.get(["/ui", "/ui/", "/ui/index.html"], serveIndex);
  // 로컬 앱 자산(JS/CSS/ES모듈)은 항상 재검증(no-cache) — main.js 에 버전(?v=)을 박아도 그 import 그래프(app/*.js:
  //  dashboard-home.js·projects.js 등)는 고정 URL 이라 브라우저 캐시에 남아 배포가 안 보이던 문제(#762 후속).
  //  no-cache = 캐시하되 매 사용 전 ETag 재검증(변경 O→200 새 코드, 변경 X→304 저비용). 정적자산은 미인증이라 안전.
  app.use("/ui", express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (/\.(?:css|js|mjs|html)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache"); // .html 포함 — terminal.html·terminal-grid.html 도 새로고침에 항상 최신(index.html 은 위 serveIndex 가 no-store 로 먼저 처리)
    },
  }));
  app.get("/", (_req, res) => res.redirect("/ui/"));
}
