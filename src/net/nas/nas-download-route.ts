// NAS 파일 내려받기 — 사람이 로그인한 브라우저 세션(쿠키)으로만 연다. Bearer 토큰은 받지 않는다.
//
//  왜 쿠키만인가: nas_find·nas_list 는 AI 에게 이름과 링크만 준다. 이 경로가 Bearer 토큰을 받으면 AI 세션이 자기 토큰으로
//   링크를 그대로 받아 본문(계약서 스캔 같은 개인정보)을 읽을 수 있게 되고, «본문은 사람만 연다»는 경계가 사라진다.
//   AI 세션은 사람의 브라우저 쿠키를 갖고 있지 않다.
//  ⚠ 남는 길: 사람과 브라우저를 같이 쓰는 데스크톱 앱의 AI 브라우저 도구는 그 사람의 쿠키로 이 주소를 열 수 있다.
//   그래서 늘 attachment 로 내려보내 화면에 그리지 않게 한다(브라우저 도구가 읽는 것은 화면이다). 이걸 지우면 그 길이 열린다.
import type express from "express";
import { parseSessionCookie, userFromSession } from "../../auth/sessions.js";
import { logger } from "../../log.js";
import { decodeRawPath, isSafeRawPath, displayPath } from "../ftp/ftp-list.js";
import { NasConfigError, openNasSession, NAS_DOWNLOAD_PATH } from "./nas-access.js";

export function contentDisposition(display: string): string {
  const base = display.slice(display.lastIndexOf("/") + 1) || "download";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

export function registerNasDownloadRoute(app: express.Express): void {
  app.get(NAS_DOWNLOAD_PATH, (req, res) => {
    void (async () => {
      const sid = parseSessionCookie(req.headers.cookie);
      const user = sid ? await userFromSession(sid).catch(() => null) : null;
      if (!user?.userId) {
        res.status(401).json({ error: "라이블리에 로그인한 브라우저에서만 내려받을 수 있습니다" });
        return;
      }
      const raw = decodeRawPath(String(req.query.p ?? ""));
      if (!raw || !isSafeRawPath(raw)) { res.status(400).json({ error: "파일 경로가 올바르지 않습니다" }); return; }
      const shown = displayPath(raw);

      let opened: Awaited<ReturnType<typeof openNasSession>>;
      try {
        opened = await openNasSession(user.userId);
      } catch (e) {
        const status = e instanceof NasConfigError ? e.status : 502;
        res.status(status).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
      const { session, username } = opened;
      try {
        const { stream, done } = await session.retr(raw);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", contentDisposition(shown));
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        logger.info({ member: user.userId, ftpUser: username, path: shown }, "[nas] 파일 내려받기");
        res.on("close", () => { if (!res.writableFinished) stream.destroy(); });
        stream.pipe(res);
        await done;
      } catch (e) {
        if (!res.headersSent) res.status(404).json({ error: `파일을 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
        else res.destroy();
      } finally {
        await session.close();
      }
    })().catch((e) => {
      logger.warn({ err: e }, "[nas] 내려받기 처리 실패");
      if (!res.headersSent) res.status(500).json({ error: "내려받기 처리 실패" });
    });
  });
}
