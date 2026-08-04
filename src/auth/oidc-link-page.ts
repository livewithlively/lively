// 계정 갈림길 화면(#1520 B) — 구글 로그인은 성공했는데 **그 이메일과 일치하는 구성원이 없을 때** 뜬다.
//  묻는 것은 하나다: "새로 시작할까요, 이미 쓰던 계정에 붙일까요?"
//
//  왜 필요한가: 이게 없으면 이메일 표기만 다른 사람(a.b@honest.ai ↔ ab@honest.ai)에게 **빈 계정이 하나 더**
//   생긴다. 본인은 자기 지식·프로젝트가 없는 화면을 보고 뭔가 잘못됐다고 느끼지만 무엇이 잘못됐는지는
//   알 수 없고, 관리자는 중복 구성원을 한참 뒤에 발견한다. 자동 가입이 꺼진 배포에서도 마찬가지로 필요하다 —
//   지금까지는 "등록된 구성원이 아닙니다"로 끝났는데, 실제로는 이메일만 다른 경우가 대부분이다.
//
//  보안: [기존 계정에 연결]은 **로컬 비밀번호를 요구한다**. 그게 '그 계정의 주인임'을 입증하는 유일한 근거다.
//   비밀번호 없이 이메일만으로 붙일 수 있게 하면 사내 아무나 남의 계정에 자기 구글을 붙일 수 있다.
//   연결 코드(pending_oidc_link)는 이미 IdP 인증을 통과한 사람만 쥐지만, 그것만으로는 '이 조직의 그 사람'이
//   증명되지 않는다 — 두 근거를 모두 요구하는 게 이 화면의 핵심이다.
import express from "express";
import { esc, page, errorPage } from "./auth-pages.js";
import { consumeOidcLink, readOidcLink, type PendingOidcLink } from "../org/store/oidc-auth.js";
import { verifyLogin } from "./local-accounts.js";
import { linkOidcToMember, provisionOidcMember } from "./oidc-login.js";
import { createSession, sessionCookie } from "./sessions.js";
import { logger } from "../log.js";

export const OIDC_LINK_PATH = "/auth/link";

export function registerOidcLinkPage(app: express.Express): void {
  // 이 화면은 폼 POST 를 받는다 — 전역 json 파서와 별개로 여기서만 urlencoded 를 붙인다(oauth-consent 와 같은 관례).
  const form = express.urlencoded({ extended: false });

  app.get(OIDC_LINK_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const code = String(req.query?.code ?? "");
    const link = code ? await readOidcLink(code) : null;
    if (!link) { res.status(400).send(expiredPage()); return; }
    res.send(chooseView(code, link, ""));
  });

  app.post(OIDC_LINK_PATH, form, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body.code ?? "");
    const action = String(body.action ?? "");
    try {
      const link = code ? await readOidcLink(code) : null;
      if (!link) { res.status(400).send(expiredPage()); return; }

      // ① 새 구성원으로 시작 — allowlist 도메인일 때만 제안했으므로 여기서도 그 사실을 다시 확인한다
      //   (화면의 버튼 유무만 믿으면 form 을 직접 만들어 우회할 수 있다).
      if (action === "new") {
        if (!link.canProvision) { res.status(403).send(errorPage("이 계정은 새로 시작할 수 없습니다. 관리자에게 문의하세요.", LINK_TITLE)); return; }
        const consumed = await consumeOidcLink(code);
        if (!consumed) { res.status(400).send(expiredPage()); return; }
        const memberId = await provisionOidcMember(consumed);
        await grantSession(req, res, memberId);
        return;
      }

      // ② 기존 계정에 연결 — 로컬 비밀번호로 그 계정의 주인임을 입증해야 한다.
      if (action !== "link") { res.status(400).send(errorPage("알 수 없는 요청입니다.", LINK_TITLE)); return; }
      const login = await verifyLogin(String(body.email ?? ""), String(body.password ?? ""));
      if (!login.ok) {
        // 코드는 아직 태우지 않았다 — 비밀번호 오타로 IdP 로그인을 처음부터 다시 하게 만들 이유가 없다.
        res.status(401).send(chooseView(code, link, "이메일 또는 비밀번호가 올바르지 않습니다."));
        return;
      }
      const consumed = await consumeOidcLink(code);
      if (!consumed) { res.status(400).send(expiredPage()); return; }
      const linked = await linkOidcToMember(login.memberId, consumed);
      if (!linked.ok) {
        logger.warn({ memberId: login.memberId, reason: linked.reason }, "[oidc] 계정 연결 실패");
        res.status(409).send(errorPage(
          linked.reason === "taken"
            ? "이 구글 계정은 이미 다른 구성원에게 연결되어 있습니다. 관리자에게 문의하세요."
            : "연결할 구성원을 찾지 못했습니다.", LINK_TITLE));
        return;
      }
      await grantSession(req, res, login.memberId);
    } catch (err) {
      logger.error({ err }, "[oidc] 계정 연결 화면 처리 실패");
      res.status(500).send(errorPage("일시적인 오류가 발생했습니다.", LINK_TITLE));
    }
  });
}

const LINK_TITLE = "계정 연결 — Lively";

async function grantSession(req: express.Request, res: express.Response, memberId: string): Promise<void> {
  const { sessionId, expiresAt } = await createSession(memberId,
    { ip: req.ip, userAgent: (req.headers["user-agent"] as string) ?? null });
  res.setHeader("Set-Cookie", sessionCookie(sessionId, expiresAt));
  res.redirect(303, "/ui/");
}

const expiredPage = (): string =>
  errorPage("연결 요청이 만료되었거나 이미 처리되었습니다.", LINK_TITLE, "로그인 화면에서 다시 시도해 주세요.");

function chooseView(code: string, link: PendingOidcLink, error: string): string {
  const who = `<div class="box"><dt>확인된 계정</dt><dd>${esc(link.email)}` +
    (link.displayName ? ` <span style="opacity:.7">(${esc(link.displayName)})</span>` : "") + `</dd></div>`;
  const err = error ? `<div class="box err">${esc(error)}</div>` : "";

  // 새로 시작 — allowlist 도메인일 때만. 버튼을 아예 안 그리는 게 아니라 '왜 없는지'를 말해 준다.
  const newForm = link.canProvision
    ? `<form method="post" action="${OIDC_LINK_PATH}">` +
      `<input type="hidden" name="code" value="${esc(code)}">` +
      `<input type="hidden" name="action" value="new">` +
      `<div class="row"><button class="primary" type="submit">새 구성원으로 시작</button></div></form>` +
      `<p class="foot">새로 시작하면 지식·프로젝트 조회 권한으로 시작합니다. 관리자·터미널 권한이 필요하면 관리자에게 요청하세요.</p>`
    : `<div class="box warn">이 도메인은 자동 가입 대상이 아닙니다. 이미 쓰던 계정이 있다면 아래에서 연결하고, ` +
      `없다면 관리자에게 구성원 등록을 요청하세요.</div>`;

  return page(LINK_TITLE,
    `<h1>어느 계정으로 들어갈까요?</h1>` +
    `<p class="sub">이 구글 계정과 이메일이 같은 구성원이 없습니다. 처음이시라면 새로 시작하고, ` +
    `이미 다른 이메일로 쓰던 계정이 있다면 그 계정에 연결하세요.</p>` +
    who + err + newForm +
    `<h1 style="margin-top:1.75rem;font-size:1rem">이미 계정이 있어요</h1>` +
    `<p class="sub">쓰던 계정의 이메일·비밀번호로 확인하면 이 구글 계정이 그 계정에 연결됩니다 — ` +
    `다음부터는 구글 버튼 한 번으로 들어옵니다.</p>` +
    `<form method="post" action="${OIDC_LINK_PATH}">` +
    `<input type="hidden" name="code" value="${esc(code)}">` +
    `<input type="hidden" name="action" value="link">` +
    `<label for="email">기존 계정 이메일</label>` +
    `<input id="email" name="email" type="email" autocomplete="username" required${link.canProvision ? "" : " autofocus"}>` +
    `<label for="password">비밀번호</label>` +
    `<input id="password" name="password" type="password" autocomplete="current-password" required>` +
    `<div class="row"><button class="${link.canProvision ? "ghost" : "primary"}" type="submit">기존 계정에 연결</button></div></form>` +
    `<p class="foot">비밀번호를 모르면 관리자에게 재발급을 요청하세요.</p>`);
}
