// OAuth 동의 화면 (#1473 T2) — /authorize 와 인가코드 발급 사이에 사람이 끼어드는 자리.
//  **서버렌더 HTML** 이다(SPA 라우트가 아니라). 이유 셋:
//   ① 인가서버의 동의 화면은 프런트 빌드가 깨져도 떠야 하는 보안 경계 페이지다.
//   ② 챗 클라이언트가 여는 팝업/새 탭이라 SPA 셸(사이드바·부팅 fetch)이 통째로 불필요하다.
//   ③ 프런트 빌드와의 결합을 만들지 않아 T2 를 백엔드 하나로 닫을 수 있다.
//
//  미인증이면 같은 페이지에 **로컬 로그인 폼**을 그린다(웹 UI 와 같은 verifyLogin·세션 쿠키를 쓴다 —
//  인증 로직을 복제하지 않는다). 매니지드(CP 구글 SSO) 사용자는 아직 로컬 비밀번호가 없을 수 있으므로,
//  "웹 UI 에서 먼저 로그인한 뒤 이 페이지를 새로고침" 경로를 함께 안내한다(세션 쿠키는 공유된다).
//  → CP SSO 를 이 화면에 직접 브리지하는 건 T4(#1500, lvly-cloud) 몫이다.
//
//  CSRF: 승인/거부는 세션 쿠키(SameSite=Lax)를 요구한다 — 크로스사이트 POST 엔 쿠키가 실리지 않아 차단된다.
//   여기에 rid 자체가 비밀(256bit, 5분 만료, 1회용)이라 추측으로 남의 요청을 승인할 수도 없다.
import express from "express";
import { readAuthRequest, approveAuthRequest, denyAuthRequest } from "../store/oauth.js";
import { grantableScopes } from "./grant-util.js";
import { parseSessionCookie, userFromSession, createSession, sessionCookie } from "../../auth/sessions.js";
import { verifyLogin } from "../../auth/local-accounts.js";
import { activeProviders } from "../../auth/providers.js"; // #1520 외부 IdP 버튼(로컬 폼은 폴백으로 유지)
import { esc, page, errorPage } from "../../auth/auth-pages.js"; // 페이지 셸 공용(#1520 계정 연결 화면과 동일 스타일)
import { LivelyClientsStore, isCimdClientId } from "./oauth-clients.js";
import { logger } from "../../log.js";

// 클라이언트 조회는 **반드시** 이 스토어로 — DB 행만 보면 CIMD 클라이언트(문서 기반, DB 미러는 베스트에포트)를
//  "없는 클라이언트"로 오판해 정상 승인을 거절한다. CIMD 문서는 인가 개시 때 이미 받아 메모리 캐시에 있다.
const clients = new LivelyClientsStore();

export const OAUTH_CONSENT_PATH = "/oauth/consent";

// 구성원 권한 라벨 — web/admin-members.ts 의 MEMBER_SCOPE_OPTS 와 같은 문구(사람이 같은 말로 보게).
const SCOPE_LABEL: Record<string, string> = {
  items: "아이템 조회", context: "컨텍스트", memory: "지식·메모리",
  db: "DB 조회", code: "코드 도구", admin: "관리자(편집·적용)", runtime: "런타임(훅·툴 정의)",
};

// 클라이언트 표시명 — CIMD 문서의 client_name 은 **외부가 준 문자열**이라 반드시 이스케이프하고,
//  출처(도메인/등록방식)를 함께 보여준다. 이름만 믿고 승인하는 사고를 막기 위한 표기다.
function clientDisplay(clientId: string, clientName: string | null): { name: string; origin: string } {
  const name = clientName?.trim() || clientId;
  if (isCimdClientId(clientId)) {
    try { return { name, origin: new URL(clientId).host }; } catch { /* fallthrough */ }
  }
  return { name, origin: `클라이언트 ID ${clientId}` };
}

function redirectWithError(res: express.Response, redirectUri: string, error: string, state: string | null): void {
  try {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    if (state) u.searchParams.set("state", state);
    res.redirect(302, u.href);
  } catch {
    res.status(400).send(errorPage("돌아갈 주소가 올바르지 않습니다."));
  }
}

export function registerOAuthConsent(app: express.Express): void {
  const form = express.urlencoded({ extended: false });

  // ── 동의 화면 ──
  app.get(OAUTH_CONSENT_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const rid = String(req.query?.rid ?? "");
    const notice = String(req.query?.notice ?? "");
    try {
      const reqRow = rid ? await readAuthRequest(rid) : null;
      if (!reqRow) { res.status(400).send(errorPage("연결 요청이 만료되었거나 이미 처리되었습니다.")); return; }
      const client = await clients.getClient(reqRow.client_id);
      const disp = clientDisplay(reqRow.client_id, client?.client_name ?? null);

      const sid = parseSessionCookie(req.headers.cookie);
      const user = sid ? await userFromSession(sid) : null;
      if (!user) { res.send(loginView(rid, disp, notice)); return; }

      const grant = grantableScopes({ memberScopes: user.scopes, allowed: reqRow.scopes.length ? reqRow.scopes : null });
      res.send(consentView(rid, disp, user.email || user.userId, grant, reqRow.resource, notice));
    } catch (err) {
      logger.error({ err }, "OAuth 동의 화면 렌더 실패");
      res.status(500).send(errorPage("일시적인 오류가 발생했습니다."));
    }
  });

  // ── 로그인 / 승인 / 거부 ──
  app.post(OAUTH_CONSENT_PATH, form, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rid = String(body.rid ?? "");
    const action = String(body.action ?? "");
    try {
      const reqRow = rid ? await readAuthRequest(rid) : null;
      if (!reqRow) { res.status(400).send(errorPage("연결 요청이 만료되었거나 이미 처리되었습니다.")); return; }

      // ① 로그인 — 성공하면 세션 쿠키를 심고 GET 으로 되돌린다(PRG: 새로고침이 비밀번호를 재전송하지 않게).
      if (action === "login") {
        const result = await verifyLogin(String(body.email ?? ""), String(body.password ?? ""));
        if (!result.ok) {
          const client = await clients.getClient(reqRow.client_id);
          res.status(401).send(loginView(rid, clientDisplay(reqRow.client_id, client?.client_name ?? null),
            "", "이메일 또는 비밀번호가 올바르지 않습니다."));
          return;
        }
        const { sessionId, expiresAt } = await createSession(result.memberId,
          { ip: req.ip, userAgent: (req.headers["user-agent"] as string) ?? null });
        res.setHeader("Set-Cookie", sessionCookie(sessionId, expiresAt));
        // 임시 비밀번호(관리자 발급)면 알린다 — 웹 UI 의 강제 변경 모달과 같은 사실을 여기서도 숨기지 않는다.
        const notice = result.mustChange ? "임시 비밀번호로 로그인했습니다. 승인 후 웹 UI 에서 비밀번호를 변경하세요." : "";
        res.redirect(303, `${OAUTH_CONSENT_PATH}?rid=${encodeURIComponent(rid)}${notice ? `&notice=${encodeURIComponent(notice)}` : ""}`);
        return;
      }

      // ② 거부 — 요청을 소비하고 클라이언트에 access_denied 로 돌려보낸다(사양대로).
      if (action === "deny") {
        await denyAuthRequest(rid);
        redirectWithError(res, reqRow.redirect_uri, "access_denied", reqRow.state);
        return;
      }

      // ③ 승인 — 세션 필수. 인가코드 발급(요청 소비와 한 트랜잭션) 후 클라이언트로 302.
      if (action !== "approve") { res.status(400).send(errorPage("알 수 없는 요청입니다.")); return; }
      const sid = parseSessionCookie(req.headers.cookie);
      const user = sid ? await userFromSession(sid) : null;
      if (!user) { res.status(401).send(errorPage("로그인이 필요합니다. 이 창을 새로고침해 주세요.")); return; }
      // 인가 개시 이후 관리자가 클라이언트를 껐을 수 있다 — 승인 직전에 다시 확인한다.
      if (!(await clients.getClient(reqRow.client_id))) {
        redirectWithError(res, reqRow.redirect_uri, "unauthorized_client", reqRow.state);
        return;
      }
      const grant = await approveAuthRequest(rid, user.userId);
      if (!grant) { res.status(400).send(errorPage("연결 요청이 만료되었거나 이미 처리되었습니다.")); return; }
      logger.info({ clientId: reqRow.client_id, memberId: user.userId, scopes: grant.scopes }, "OAuth 동의 승인 — 인가코드 발급");
      const u = new URL(grant.redirectUri);
      u.searchParams.set("code", grant.code);
      if (grant.state) u.searchParams.set("state", grant.state);
      res.redirect(302, u.href);
    } catch (err) {
      logger.error({ err }, "OAuth 동의 처리 실패");
      res.status(500).send(errorPage("일시적인 오류가 발생했습니다."));
    }
  });
}

// ── 뷰 ──

function clientBox(disp: { name: string; origin: string }): string {
  return `<div class="box"><dt>연결을 요청한 앱</dt><dd><strong>${esc(disp.name)}</strong></dd>` +
    `<dt>출처</dt><dd>${esc(disp.origin)}</dd></div>`;
}

function noticeBox(notice: string, error?: string): string {
  if (error) return `<div class="box err">${esc(error)}</div>`;
  return notice ? `<div class="box warn">${esc(notice)}</div>` : "";
}

function loginView(rid: string, disp: { name: string; origin: string }, notice: string, error?: string): string {
  // 외부 IdP(#1520)가 켜진 배포면 여기서도 그 버튼을 준다. 안 그러면 조직 지메일만 쓰는 고객이
  //  챗 커넥터를 붙일 때마다 별도 로컬 비밀번호를 요구받아, OIDC 를 붙인 목적의 절반이 무너진다.
  //  로그인 후 이 동의 화면(rid 그대로)으로 되돌아온다 — start 가 받는 to 는 same-origin 경로만 통과한다.
  const oidc = activeProviders().find((p) => p.kind === "oidc" && p.enabled);
  const oidcForm = oidc
    ? `<form method="get" action="/api/ui/auth/oidc/start">` +
      `<input type="hidden" name="to" value="${esc(`${OAUTH_CONSENT_PATH}?rid=${rid}`)}">` +
      `<div class="row"><button class="primary" type="submit">${esc(oidc.label)}</button></div></form>` +
      `<p class="foot">회사 계정이 없으면 아래 이메일·비밀번호로 로그인하세요.</p>`
    : "";
  return page("로그인 — Lively 연결 승인",
    `<h1>Lively 로그인</h1>` +
    `<p class="sub">연결을 승인하려면 먼저 회사 계정으로 로그인하세요.</p>` +
    clientBox(disp) + noticeBox(notice, error) + oidcForm +
    `<form method="post" action="${OAUTH_CONSENT_PATH}">` +
    `<input type="hidden" name="rid" value="${esc(rid)}">` +
    `<input type="hidden" name="action" value="login">` +
    `<label for="email">이메일</label><input id="email" name="email" type="email" autocomplete="username" required${oidc ? "" : " autofocus"}>` +
    `<label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" required>` +
    `<div class="row"><button class="${oidc ? "ghost" : "primary"}" type="submit">로그인</button></div></form>` +
    (oidc ? "" : `<p class="foot">구글 계정(매니지드)으로 쓰신다면 Lively 웹 UI 에서 먼저 로그인한 뒤 이 페이지를 새로고침하세요.</p>`));
}

function consentView(
  rid: string, disp: { name: string; origin: string }, who: string,
  scopes: string[], resource: string | null, notice: string,
): string {
  const scopeList = scopes.length
    ? `<ul class="scopes">${scopes.map((s) => `<li>${esc(SCOPE_LABEL[s] ?? s)} <span style="opacity:.6">(${esc(s)})</span></li>`).join("")}</ul>`
    : `<em>부여할 권한이 없습니다 — 관리자에게 구성원 권한을 요청하세요.</em>`;
  return page("연결 승인 — Lively",
    `<h1>Lively 연결을 승인하시겠어요?</h1>` +
    `<p class="sub">승인하면 이 앱이 <strong>${esc(who)}</strong> 님의 권한으로 조직 컨텍스트에 접근합니다.</p>` +
    clientBox(disp) + noticeBox(notice) +
    `<div class="box"><dt>부여되는 권한</dt><dd>${scopeList}</dd>` +
    (resource ? `<dt>연결 대상</dt><dd>${esc(resource)}</dd>` : "") + `</div>` +
    // 관리자 권한이 목록에 없는 건 버그가 아니라 설계다 — 사람이 그 이유를 알고 승인하게 명시한다.
    `<p class="foot">외부 앱에는 관리자·런타임 권한이 부여되지 않습니다. 승인 후에도 Lively 관리탭에서 언제든 회수할 수 있습니다.</p>` +
    `<form method="post" action="${OAUTH_CONSENT_PATH}">` +
    `<input type="hidden" name="rid" value="${esc(rid)}">` +
    `<div class="row">` +
    `<button class="ghost" type="submit" name="action" value="deny">거부</button>` +
    `<button class="primary" type="submit" name="action" value="approve"${scopes.length ? "" : " disabled"}>승인</button>` +
    `</div></form>`);
}
