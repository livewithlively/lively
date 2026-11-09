// 워크스페이스 간 옮기기(#5458) — 파일이 오가는 두 경로(capability 표면은 JSON 이라 바이트를 못 싣는다):
//   POST /api/ui/transfer/export   고른 것(JSON) → 묶음 파일 내려받기
//   POST /api/ui/transfer/upload   묶음 파일(본문 그대로) → 미리보기(JSON)
// 나머지(고르기 목록 · 미리보기 수 · 적용 · 되돌리기 · 목록)는 capabilities/transfer.ts — REST·MCP 가 같은 handler 를 쓴다.
//
// 권한: 관리자만(상민님 2026-11-09 — 내보내기·가져오기 모두). 감사로그 내보내기(ee/audit/export-routes.ts)와 같은 문:
//  인증(세션 쿠키 또는 Bearer) → admin 스코프 → 정적 토큰 거부(admin 은 위험 스코프) → 인코그니토 거부.
import express from "express";
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap } from "../http/rest-util.js";
import { HttpError } from "../http-error.js";
import { DANGEROUS_SCOPES } from "../auth/scopes.js";
import { incognitoFromHeaders } from "../org/auth/agent-identity.js";
import { exportBundle, parseSelection, BUNDLE_MAX_BYTES } from "./export.js";
import { stageImport, listActiveCategories } from "./apply.js";
import { assertUsablePassword, SealPasswordError } from "./seal.js";
import { mapTransferErrors } from "./http-errors.js";
import { batchView } from "./view.js";

export const TRANSFER_EXPORT_PATH = "/api/ui/transfer/export";
export const TRANSFER_UPLOAD_PATH = "/api/ui/transfer/upload";

const userOf = (req: express.Request): LivelyUser =>
  ((req as unknown as { auth?: { extra?: unknown } }).auth?.extra ?? {}) as unknown as LivelyUser;

function decodeHeader(v: unknown, max: number): string | null {
  if (typeof v !== "string" || !v) return null;
  try { return decodeURIComponent(v).slice(0, max); } catch { return v.slice(0, max); }
}

export function registerTransferRoutes(app: express.Express, verifier: BearerVerifier): void {
  const authResolve = sessionOrBearer(verifier);
  const requireAdmin: express.RequestHandler = (req, res, next) => {
    const user = userOf(req);
    if (!user || !user.userId) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (!(Array.isArray(user.scopes) && user.scopes.includes("admin"))) {
      res.status(403).json({ error: "워크스페이스 간 옮기기는 관리자만 할 수 있습니다" }); return;
    }
    if (DANGEROUS_SCOPES.has("admin") && user.tokenSource === "static") {
      res.status(403).json({ error: "정적 토큰으로는 관리/런타임 변경이 불가합니다 — 접속 해제할 수 있는 발급 토큰(lvk_)을 사용하세요" }); return;
    }
    if (incognitoFromHeaders(req.headers)) {
      res.status(403).json({ error: "인코그니토 세션 — 라이블리 접근이 비활성화되어 있습니다(#1007). 이 세션의 LIVELY_MODE(=incognito)를 해제하고 다시 시도하세요." }); return;
    }
    next();
  };

  // 내보내기 — 본문 JSON(고른 것 + 선택 비밀번호). 고른 지식 이름 목록이 길 수 있어 이 경로만 상한을 넉넉히 둔다.
  app.post(TRANSFER_EXPORT_PATH, express.json({ limit: "4mb" }), authResolve, requireAdmin, wrap(async (req, res) => {
    const user = userOf(req);
    const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const sel = parseSelection(b);
    const password = typeof b.password === "string" && b.password ? b.password : null;
    if (password) {
      try { assertUsablePassword(password); } catch (e) { if (e instanceof SealPasswordError) throw new HttpError(400, e.message, { body: { code: "weak_password" } }); throw e; }
    }
    const out = await mapTransferErrors(async () => {
      try { return await exportBundle(sel, { actor: user.userId, password, source: "web" }); }
      catch (e) {
        // 도메인 문구(내보낼 것이 없다 · 상한 초과)는 사람이 고칠 수 있는 입력 문제다 — 500 이 아니라 400 으로.
        const msg = (e as Error).message || "";
        if (/내보낼 지식이 없습니다|상한\(100MB\)을 넘습니다/.test(msg)) throw new HttpError(400, msg);
        throw e;
      }
    });
    const ascii = out.filename.replace(/[^\x20-\x7e]/g, "_");
    res.setHeader("Content-Type", out.sealed ? "application/octet-stream" : "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Lively-Transfer-Counts", JSON.stringify(out.manifest.counts));
    res.end(out.file);
  }));

  // 올리기 — 본문이 파일 바이트 그대로(Content-Type: application/octet-stream). 비밀번호·파일 이름은 머리글(URI 인코딩).
  //  전역 express.json() 은 JSON 형식이 아닌 본문을 건드리지 않으므로 이 경로의 raw 파서가 받는다.
  app.post(TRANSFER_UPLOAD_PATH, authResolve, requireAdmin,
    express.raw({ type: () => true, limit: BUNDLE_MAX_BYTES }),
    wrap(async (req, res) => {
      const user = userOf(req);
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw new HttpError(400, "파일을 본문으로 보내 주세요(Content-Type: application/octet-stream)");
      }
      const password = decodeHeader(req.headers["x-lively-bundle-password"], 256);
      const fileName = decodeHeader(req.headers["x-lively-bundle-name"], 300);
      const { batch, plan } = await mapTransferErrors(() =>
        stageImport(req.body as Buffer, { password, fileName, ctx: { actor: user.userId, source: "web" } }));
      res.setHeader("Cache-Control", "no-store");
      res.json({ batch: batchView(batch), plan, target_categories: await listActiveCategories() });
    }));
}
