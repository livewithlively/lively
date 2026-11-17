// NAS 파일 내려받기·올리기 — 사람의 브라우저(세션 쿠키)와 그 사람의 AI 세션(Bearer, lively_local_nas_pull·push) 둘 다 받는다.
//
//  AI 가 본문까지 읽는 것은 의도다 — 구성원이 자기 FTP 계정으로 열 수 있는 파일은 그 구성원의 AI 세션도 연다.
//   볼 수 있는 범위는 그 구성원 본인 FTP 계정의 폴더 권한이 정한다(nas-access.ts — 공용·남의 계정 폴백 없음).
//  ⚠ 받은 본문은 AI 세션과 그 모델 제공자에게 넘어간다. 본문 반출을 막아야 하는 조직이면 이 경로의 Bearer 허용이 검토 대상이다.
import type express from "express";
import { createHash, randomBytes } from "node:crypto";
import { sessionOrBearer } from "../../auth/http-auth.js";
import type { BearerVerifier } from "../../auth/bearer.js";
import type { LivelyUser } from "../../context.js";
import { HttpError } from "../../http-error.js";
import { requireAppTool } from "../../apps/principal.js";
import { incognitoFromHeaders, readOnlyFromHeaders } from "../../org/auth/agent-identity.js";
import { logger } from "../../log.js";
import { decodeRawPath, isSafeRawPath, displayPath, childRawPath, encodeRawPath } from "../ftp/ftp-list.js";
import { NasConfigError, openNasSession, NAS_DOWNLOAD_PATH, NAS_UPLOAD_PATH, nasIndexCache, nasIndexKey, type NasServer } from "./nas-access.js";
import { uploadAtomically, type UploadOps } from "./nas-upload.js";
import { FtpError, type FtpSession } from "../ftp/ftp-client.js";

// 파일명에 고객 이름이 흔해 경로 원문은 로그에 남기지 않는다. 같은 파일인지는 해시로 대조한다.
const hashPath = (raw: string): string => createHash("sha256").update(raw, "latin1").digest("hex").slice(0, 16);

// 앞의 처리기가 요청 본문을 이미 읽었나 — 끝까지 읽힌 스트림(readableEnded)이거나 body-parser 가 남긴 표지(_body).
//  complete 는 보지 않는다: 작은 본문은 인증을 기다리는 사이 다 받아져 complete 가 되지만 아직 아무도 읽지 않았다(session-log-routes readRawBody 와 같은 판단).
const bodyAlreadyRead = (req: express.Request): boolean => req.readableEnded || (req as { _body?: unknown })._body === true;

export function contentDisposition(display: string): string {
  const base = display.slice(display.lastIndexOf("/") + 1) || "download";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // RFC 5987 attr-char 밖인 ! ' ( ) * 도 퍼센트 인코딩한다(encodeURIComponent 가 남기는 문자들)
  const ext = encodeURIComponent(base).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
}

/**
 * 이 경로는 능력 어댑터(web.ts restMounts) 밖의 맨 라우트라 거기 게이트를 물려받지 못한다. 같은 판정을 여기서 다시 건다.
 *  · context 권한 — nas_find·nas_list 와 같다. 목록을 못 보는 토큰이 본문을 다루지 않게(쿠키도 같다).
 *  · 앱 세션 토큰 — 그 앱 동의 도구에 tool 이 있어야 한다(requireAppTool). 빼면 nas 동의가 없는 앱이 구성원 FTP 계정으로 파일을 다룬다.
 *  · 세션 모드(#1007) — 인코그니토는 전부, 읽기전용은 쓰기(mutates)를 막는다.
 * 실패면 응답을 보내고 null.
 */
async function nasCaller(req: express.Request, res: express.Response, gate: { tool: string; mutates: boolean }): Promise<{ user: LivelyUser; via: "agent" | "browser" } | null> {
  const user = (req.auth?.extra ?? null) as LivelyUser | null;
  if (!user?.userId) { res.status(401).json({ error: "라이블리 인증이 필요합니다" }); return null; }
  if (!Array.isArray(user.scopes) || !user.scopes.includes("context")) {
    res.status(403).json({ error: "이 토큰으로는 NAS 파일을 다룰 수 없습니다(context 권한 필요)" });
    return null;
  }
  if (incognitoFromHeaders(req.headers)) {
    res.status(403).json({ error: "인코그니토 세션 — 라이블리 접근이 비활성화되어 있습니다(#1007)" });
    return null;
  }
  if (gate.mutates && readOnlyFromHeaders(req.headers)) {
    res.status(403).json({ error: "읽기전용 세션 — NAS 에 쓸 수 없습니다(#1007)" });
    return null;
  }
  try {
    await requireAppTool(user, gate.tool);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    res.status(e.status).json({ error: e.message });
    return null;
  }
  return { user, via: req.auth?.token ? "agent" : "browser" };
}

export function registerNasDownloadRoute(app: express.Express, verifier: BearerVerifier): void {
  app.get(NAS_DOWNLOAD_PATH, sessionOrBearer(verifier), (req, res) => {
    void (async () => {
      const who = await nasCaller(req, res, { tool: "nas_list", mutates: false });
      if (!who) return;
      const { user, via } = who;
      const raw = decodeRawPath(String(req.query.p ?? ""));
      if (!raw || !isSafeRawPath(raw)) { res.status(400).json({ error: "파일 경로가 올바르지 않습니다" }); return; }
      const shown = displayPath(raw);

      let opened: Awaited<ReturnType<typeof openNasSession>>;
      try {
        opened = await openNasSession(user.userId);
      } catch (e) {
        const status = e instanceof NasConfigError ? e.status : 502;
        if (!(e instanceof NasConfigError)) logger.warn({ err: e, member: user.userId }, "[nas] 내려받기 접속 실패");
        res.status(status).json({ error: e instanceof NasConfigError ? e.message : "NAS 에 접속하지 못했습니다" });
        return;
      }
      const { session, username } = opened;
      let clientGone = false;
      let current: { destroy(err?: Error): void } | null = null;
      // retr 가 끝나기 전에 끊겨도 스트림을 닫을 수 있게 먼저 듣는다
      res.on("close", () => {
        if (res.writableFinished) return;
        clientGone = true;
        current?.destroy(new Error("내려받는 쪽이 연결을 끊었습니다"));
      });
      try {
        const { stream, done } = await session.retr(raw);
        current = stream;
        if (clientGone) stream.destroy(new Error("내려받는 쪽이 연결을 끊었습니다"));
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", contentDisposition(shown));
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        // 접근 기록이다 — NAS 가 파일을 연(RETR 150) 시점에 늘 남긴다. 사람이 중간에 취소했는지는 끝에 따로 남긴다.
        logger.info({ member: user.userId, ftpUser: username, via, pathHash: hashPath(raw) }, "[nas] 파일 내려받기");
        stream.pipe(res);
        await done;
        if (clientGone) logger.info({ member: user.userId, pathHash: hashPath(raw) }, "[nas] 내려받기 취소");
      } catch (e) {
        // 사람이 받다가 취소한 것은 경고가 아니다. 오류 원문은 서버 응답 문구를 담을 수 있어 이름·코드만 남긴다.
        const brief = { name: e instanceof Error ? e.name : "unknown", code: e instanceof FtpError ? e.code : null, fatal: e instanceof FtpError ? e.fatal : null };
        if (clientGone) logger.info({ member: user.userId, pathHash: hashPath(raw) }, "[nas] 내려받기 취소");
        else if (!(e instanceof FtpError && e.code === 550)) logger.warn({ ...brief, member: user.userId, pathHash: hashPath(raw) }, "[nas] 내려받기 실패");
        if (!res.headersSent) res.status(404).json({ error: "파일을 열지 못했습니다(없거나 내 계정으로 열 수 없습니다)" });
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

/** 올리기 라우트가 여는 NAS 세션 — 기본은 구성원 본인 FTP 계정(openNasSession). 시험은 가짜 세션을 꽂는다(nas-upload-route.test). */
export interface NasUploadRouteDeps {
  open?: (memberId: string) => Promise<{ session: UploadOps & Pick<FtpSession, "dele" | "close">; username: string; server: NasServer }>;
}

/**
 * 올리기(PUT NAS_UPLOAD_PATH). 본문이 파일 바이트 그대로라 index.ts 는 이 라우트를 전역 express.json() **앞**에 붙인다 —
 *  뒤에 붙으면 `Content-Type: application/json` 본문을 전역 파서가 먼저 읽어 빈 파일이 «성공» 으로 남는다.
 */
export function registerNasUploadRoute(app: express.Express, verifier: BearerVerifier, deps: NasUploadRouteDeps = {}): void {
  const open: NonNullable<NasUploadRouteDeps["open"]> = deps.open ?? openNasSession;
  // 올리기 — 먼저 같은 폴더의 임시 이름으로 받고 다 받은 뒤 제 이름으로 옮긴다. 전송이 끊겨도 반쪽 파일이 제 이름으로 남지 않게.
  //  덮기(overwrite=1)가 아니면 같은 이름이 있을 때 409 와 그 크기를 돌려준다(받는 쪽이 «이미 올림»을 가를 수 있게).
  app.put(NAS_UPLOAD_PATH, sessionOrBearer(verifier), (req, res) => {
    void (async () => {
      const who = await nasCaller(req, res, { tool: "nas_manage", mutates: true });
      if (!who) { req.resume(); return; }
      const { user, via } = who;
      // 본문을 앞의 처리기(전역 JSON 파서 등)가 이미 읽었으면 흘릴 바이트가 없다 — 그대로 올리면 빈 파일이 «성공» 으로 남고 덮기면 기존 파일이 비워진다.
      //  index.ts 가 이 라우트를 전역 파서 앞에 붙여 정상 배선에선 오지 않는 자리다. 배선이 깨져도 빈 파일을 쓰지 않게 NAS 를 열기 전에 거절한다.
      if (bodyAlreadyRead(req)) {
        logger.warn({ member: user.userId, via, contentType: req.headers["content-type"] ?? null }, "[nas] 올리기 본문을 앞의 처리기가 먼저 읽음 — 라우트 배선 확인 필요");
        res.status(415).json({ error: "올릴 본문을 받지 못했습니다(게이트웨이의 다른 처리기가 먼저 읽었습니다) — Content-Type: application/octet-stream 으로 다시 보내세요" });
        return;
      }
      const dir = decodeRawPath(String(req.query.dir ?? ""));
      const target = dir ? childRawPath(dir, String(req.query.name ?? "")) : null;
      const temp = dir ? childRawPath(dir, `.${randomBytes(6).toString("hex")}.lively-upload`) : null;
      if (!target || !temp) { req.resume(); res.status(400).json({ error: "올릴 폴더(dir)나 이름(name)이 올바르지 않습니다" }); return; }
      const overwrite = req.query.overwrite === "1" || req.query.overwrite === "true";
      const declared = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);

      let opened: Awaited<ReturnType<typeof open>>;
      try {
        opened = await open(user.userId);
      } catch (e) {
        req.resume();
        const status = e instanceof NasConfigError ? e.status : 502;
        if (!(e instanceof NasConfigError)) logger.warn({ err: e, member: user.userId }, "[nas] 올리기 접속 실패");
        res.status(status).json({ error: e instanceof NasConfigError ? e.message : "NAS 에 접속하지 못했습니다" });
        return;
      }
      const { session, username, server } = opened;
      // 임시 파일 정리는 늘 새 세션으로 한다 — 전송이 끊긴 세션은 이미 버려졌고(poison), 실패 종류를 여기서 가르지 않는다
      const cleanupTemp = async (): Promise<void> => {
        try {
          const { session: s2 } = await open(user.userId);
          try { await s2.dele(temp); } finally { await s2.close(); }
        } catch (e) {
          if (!(e instanceof FtpError && e.code === 550)) logger.warn({ err: e instanceof Error ? e.name : "unknown", member: user.userId }, "[nas] 올리기 임시 파일 정리 실패");
        }
      };
      try {
        const r = await uploadAtomically(session, { temp, target, overwrite, body: req, declared: Number.isFinite(declared) ? declared : null }, cleanupTemp);
        if (r.kind === "exists") {
          req.resume();
          res.status(409).json({ error: "같은 이름의 파일이 있습니다", exists: true, size: r.size, path: displayPath(target), p: encodeRawPath(target) });
          return;
        }
        nasIndexCache.markStale(nasIndexKey(user.userId, username, server));
        logger.info({ member: user.userId, ftpUser: username, via, pathHash: hashPath(target), bytes: r.bytes, overwritten: r.overwritten }, "[nas] 파일 올리기");
        res.json({ path: displayPath(target), p: encodeRawPath(target), size: r.bytes, overwritten: r.overwritten });
      } catch (e) {
        req.resume();
        const brief = { name: e instanceof Error ? e.name : "unknown", code: e instanceof FtpError ? e.code : null, fatal: e instanceof FtpError ? e.fatal : null };
        logger.warn({ ...brief, member: user.userId, via, pathHash: hashPath(target) }, "[nas] 올리기 실패");
        if (!res.headersSent) {
          const denied = e instanceof FtpError && (e.code === 550 || e.code === 553);
          res.status(denied ? 403 : 502).json({ error: denied ? "그 폴더에 올릴 수 없습니다(없거나 내 계정에 쓰기 권한이 없습니다)" : "올리지 못했습니다" });
        }
      } finally {
        await session.close();
      }
    })().catch((e) => {
      logger.warn({ err: e }, "[nas] 올리기 처리 실패");
      if (!res.headersSent) res.status(500).json({ error: "올리기 처리 실패" });
    });
  });
}
