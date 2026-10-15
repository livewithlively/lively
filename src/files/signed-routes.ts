// 서명 주소 받는 곳(#4673) — `GET · HEAD · PUT /api/files/s/<토큰>`. 쿠키도 토큰 머리글도 없이 URL 하나로 받고 올린다.
//
// ── 누가 부르나 ────────────────────────────────────────────────────────────────────────────
//  앱 서버(Lambda — v2-6) · 앱 화면(lvly.app iframe · srcdoc — 라이블리와 출처가 달라 쿠키가 없다) · 세션 AI(curl) · 사람의 브라우저(내려받기).
//   발급은 capabilities/files.ts file_url(인증 · 판정 뒤 — files/file-url.ts). 여기서는 토큰을 검증하고 **쓰는 순간 판정을 다시 탄다**
//   (files/file-access.ts) — 토큰은 «누가 · 어디를 · 언제까지» 의 증명이고, 그 사이 동의 철회 · 앱 끄기 · 공개범위 변경 · 구성원 비활성이 바로 먹는다.
//
// ── 바이트는 지금 게이트웨이가 나른다(1단계) ──────────────────────────────────────────────────
//  읽기 · 쓰기는 다른 파일 API 와 같은 멤버 경계(격리면 그 구성원 uid — 매니지드는 파일 작업 헬퍼)로 한다 → 파일 소유자가 맞는다.
//   올리기는 임시 파일 → 바꿔치기(upload-file.receiveUpload — 끊겨도 원본이 산다) · 1GB 상한 · 위 폴더는 만든다(S3 PUT 과 같은 뜻).
//   올린 뒤 처리는 다른 업로드 입구와 같은 한 자리(finishUpload — 자료 등록 · 그룹 rw · 도장). 앱 폴더 파일은 자료로 만들지 않는다
//   (상민님 2026-10-15 결정 1 — 자료 공개범위에 «그 앱 동의자» 축이 없어 동의 안 한 사람에게 검색으로 보이게 된다).
//  2단계(#4674)에선 발급 응답의 url 이 JuiceFS S3 게이트웨이 서명 주소로 바뀌고 이 라우트는 옛 주소를 받는 쪽으로만 남는다.
//
// ── 응답 머리 ─────────────────────────────────────────────────────────────────────────────
//  · CORS: 출처 무관(`*`, 쿠키 없음) — URL 자체가 자격이라 출처로 가릴 것이 없다. 앱 화면 · 다른 주소의 서버가 fetch 할 수 있게.
//  · 받기는 **늘 내려받기**(attachment) · nosniff · `CSP: sandbox` — 이 주소는 워크스페이스 주소(<slug>.app.lvly.io)다. 올린 파일이
//    이 출처의 문서로 열리지 않게 한다. 그림 · 소리 · 영상 · PDF · 글만 제 종류로, 나머지는 octet-stream.
//  · Referrer-Policy: no-referrer · no-store — 주소(=자격)가 다른 곳으로 새거나 캐시에 남지 않게.
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { logger } from "../log.js";
import { resolveRootPath, userOsUser } from "../terminal/profiles.js";
import { memberStat, memberReadTo, memberPathProbe } from "../terminal/terminal-member-fs.js";
import { isConfined, probeLocal } from "../terminal/path-jail.js";
import { isInAppFolder } from "./app-jail.js";
import { receiveUpload, uploadError, nfcPath } from "../terminal/upload-file.js";
import { uploadEntryOf, type UploadEntry } from "../ingest/upload-entry.js";
import { grantSharedGroupWrite } from "../project/project-fs.js";
import { parseAddress, formatAddress, appOfAddress, AddressError, type FileAddress } from "./address.js";
import { verifyFileUrlToken, FileUrlTokenError, FILE_URL_MAX_UPLOAD, type FileUrlClaims } from "./file-url-token.js";
import { authorizeFileAccess, assertWritableTarget, type FileAccessDeps, type FileOp } from "./file-access.js";

/** 받는 곳이 기대는 살아 있는 것 — 시험은 DB 없이 같은 라우트를 돌린다(files/signed-routes-live 가 운영 배선). */
export interface SignedRouteDeps {
  /** 서명 키(없으면 503) */
  key(): Buffer | null;
  /** 이 요청의 워크스페이스 id — 토큰의 워크스페이스와 대조한다 */
  tenantId(): string;
  /** 토큰을 받은 구성원이 **지금도** 활성이고 이 워크스페이스에 들어올 수 있으면 그 사람, 아니면 null */
  activeMember(id: string): Promise<{ id: string; email: string; scopes: string[] } | null>;
  access: FileAccessDeps;
  /** 공유 자리 올리기의 마무리(자료 등록 · 그룹 rw · 도장 — ingest/upload-finish). 앱 폴더엔 부르지 않는다 */
  finishShared(o: { user: LivelyUser; base: string; abs: string; osUser: string | null; entry: UploadEntry }): Promise<{ size?: number; mtime?: number; ref?: string; source_id?: number; skipped?: string }>;
}

// 받기에서 제 종류로 내도 되는 것 — 문서로 열려도 스크립트가 돌지 않는 종류만. HTML · SVG · XML · JS 는 여기 없다(octet-stream).
const SAFE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  md: "text/markdown; charset=utf-8", json: "application/json", zip: "application/zip",
};
/** 파일 이름 → 내보낼 Content-Type(순수). 모르는 것 · 위험한 것은 octet-stream. */
export function downloadContentType(name: string): string {
  const i = name.lastIndexOf(".");
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : "";
  return SAFE_TYPES[ext] ?? "application/octet-stream";
}

function setCommonHeaders(res: express.Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Expose-Headers", "content-length, content-type, content-disposition, last-modified");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/** 토큰 → 칸 · 주소. 서명 · 모양 · 만료 · 워크스페이스 · 방법을 본다. 실패는 403(만료 포함 — S3 와 같은 자세, 문장이 까닭을 말한다). */
function claimsOf(token: string, want: "GET" | "PUT", d: SignedRouteDeps): { claims: FileUrlClaims; address: FileAddress } {
  const key = d.key();
  if (!key) throw new HttpError(503, "이 게이트웨이에 서명 키(CONNECTOR_SECRET_KEY)가 없어 서명 주소를 받을 수 없습니다 — 관리자에게 알려 주세요");
  let claims: FileUrlClaims;
  try { claims = verifyFileUrlToken(token, key); }
  catch (e) { throw new HttpError(403, e instanceof FileUrlTokenError ? e.message : "주소를 확인하지 못했습니다"); }
  //  다른 워크스페이스에서 받은 주소다 — 존재를 말하지 않는다(404).
  if (claims.t !== d.tenantId()) throw new HttpError(404, "경로를 찾을 수 없습니다");
  if (claims.m !== want) throw new HttpError(403, claims.m === "GET" ? "이 주소는 받기 전용입니다 — 올리려면 PUT 주소를 받으세요" : "이 주소는 올리기 전용입니다 — 받으려면 GET 주소를 받으세요");
  //  토큰의 주소는 발급 때 이미 검사했지만 같은 규칙을 한 번 더 태운다(겹 방어 — 이 함수가 받는 것은 바깥에서 온 글자다).
  let address: FileAddress;
  try { address = parseAddress(formatAddress({ root: claims.r, rel: claims.p })); }
  catch (e) { throw new HttpError(403, e instanceof AddressError ? e.message : "주소가 올바르지 않습니다"); }
  return { claims, address };
}

/** 토큰을 받은 구성원 — 지금도 활성이고 이 워크스페이스에 들어올 수 있어야 한다. */
async function principalUser(claims: FileUrlClaims, d: SignedRouteDeps): Promise<LivelyUser> {
  const m = await d.activeMember(claims.s);
  if (!m) throw new HttpError(403, "이 주소를 받은 구성원이 지금 이 워크스페이스에서 활성 상태가 아닙니다");
  return { userId: m.id, email: m.email, scopes: m.scopes, projects: [] } as LivelyUser;
}

/** 주소 → 절대경로 + 파일 op 를 내릴 uid. 앱 폴더 주소는 그 앱 폴더 안에서만 연다(app-jail) · 그 밖은 자리 안에서만(path-jail). */
async function locate(user: LivelyUser, a: FileAddress, op: FileOp): Promise<{ abs: string; base: string; osUser: string | null }> {
  const rel = op === "write" ? nfcPath(a.rel) : a.rel;   // 새로 만드는 이름은 NFC 정본(#1278b) · 읽기는 그대로(옛 NFD 파일). 쓰기는 부르는 쪽이 이미 NFC 로 판정했다
  const osUser = await userOsUser(user);
  const { base, abs } = await resolveRootPath(user, a.root, rel, osUser);
  const probe = osUser ? (b: string, t: string) => memberPathProbe(osUser, b, t) : probeLocal;
  const app = appOfAddress(a);
  const ok = app ? await isInAppFolder(base, app.app, abs, probe) : await isConfined(base, abs, probe);
  if (!ok) throw new HttpError(400, "허용 경로를 벗어났습니다");
  return { abs, base, osUser };
}

// 이 라우트의 경로는 곧 자격(토큰)이다 — 실패 로그에는 고정 이름만 남긴다.
const LOG_PATH = { logPath: "/api/files/s/:token" };

/** 쓰기 주소는 NFC 로 맞춘 꼴로 판정 · 저장한다(#1278b — 새로 만드는 이름의 정본). 판정과 저장이 같은 글자를 보게. */
const canonicalWrite = (a: FileAddress): FileAddress => ({ root: a.root, rel: a.rel.normalize("NFC") });

async function statOf(abs: string, osUser: string | null): Promise<{ size: number; file: boolean; dir: boolean; mtime?: number } | null> {
  if (osUser) return memberStat(osUser, abs);
  try { const st = await fsp.stat(abs); return { size: st.size, file: st.isFile(), dir: st.isDirectory(), mtime: Math.floor(st.mtimeMs) }; }
  catch { return null; }
}

export function fileUrlRouter(d: SignedRouteDeps): express.Router {
  const router = express.Router();

  router.options("/:token", (_req, res) => { setCommonHeaders(res); res.status(204).end(); });

  const download = (head: boolean): express.RequestHandler => wrap(async (req, res) => {
    setCommonHeaders(res);
    const { claims, address } = claimsOf(String(req.params.token ?? ""), "GET", d);
    const user = await principalUser(claims, d);
    await authorizeFileAccess({ member: user.userId, scopes: user.scopes ?? [], app: claims.a ?? null }, address, "read", d.access);
    const { abs, osUser } = await locate(user, address, "read");
    const st = await statOf(abs, osUser);
    if (!st) throw new HttpError(404, "경로를 찾을 수 없습니다");
    if (!st.file) throw new HttpError(400, "파일이 아닙니다 — 폴더는 받을 수 없습니다");
    const name = path.basename(abs);
    res.setHeader("Content-Type", downloadContentType(name));
    res.setHeader("Content-Length", String(st.size));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    if (st.mtime) res.setHeader("Last-Modified", new Date(st.mtime).toUTCString());
    if (head) { res.status(200).end(); return; }
    logger.info({ op: "get", address: formatAddress(address), member: user.userId, app: claims.a ?? null, size: st.size }, "[file-url] 받기");
    if (osUser) {
      await memberReadTo(osUser, abs, res).catch((e) => { if (!res.headersSent) throw new HttpError(500, "읽기 실패"); res.destroy(e as Error); });
      return;
    }
    fs.createReadStream(abs).on("error", (e) => { if (!res.headersSent) res.status(500).json({ error: "읽기 실패" }); else res.destroy(e); }).pipe(res);
  }, LOG_PATH);
  router.head("/:token", download(true));
  router.get("/:token", download(false));

  router.put("/:token", wrap(async (req, res) => {
    setCommonHeaders(res);
    const c = claimsOf(String(req.params.token ?? ""), "PUT", d);
    const claims = c.claims;
    const address = canonicalWrite(c.address);
    const user = await principalUser(claims, d);
    await authorizeFileAccess({ member: user.userId, scopes: user.scopes ?? [], app: claims.a ?? null }, address, "write", d.access);
    assertWritableTarget(address);
    const { abs, base, osUser } = await locate(user, address, "write");
    const existing = await statOf(abs, osUser);
    if (existing && !existing.file) throw new HttpError(409, "같은 이름의 폴더가 있어 파일을 올릴 수 없습니다");
    try { await receiveUpload(req, abs, FILE_URL_MAX_UPLOAD, osUser); }
    catch (e) { const he = uploadError(e, FILE_URL_MAX_UPLOAD); if (!he) return; throw he; }   // he=null → 보내는 쪽이 끊었다(응답할 상대가 없다)
    const stored = formatAddress({ root: address.root, rel: path.relative(base, abs).split(path.sep).join("/") });
    logger.info({ op: "put", address: stored, member: user.userId, app: claims.a ?? null }, "[file-url] 올리기");
    //  공유 · 프로젝트 파일은 다른 업로드와 같은 마무리(자료 · 그룹 rw · 도장). 앱 폴더는 자료를 만들지 않고 그룹 rw 와 도장만.
    if (address.root === "shared") {
      const fin = await d.finishShared({ user, base, abs, osUser, entry: uploadEntryOf(req.headers) });
      res.json({ ok: true, address: stored, ...fin });
      return;
    }
    await grantSharedGroupWrite(abs, base, "file").catch((e) => logger.warn({ err: e, abs }, "[file-url] 그룹 rw 부여 실패"));
    const st = await statOf(abs, osUser);
    res.json({ ok: true, address: stored, ...(st ? { size: st.size, ...(st.mtime ? { mtime: st.mtime } : {}) } : {}) });
  }, LOG_PATH));

  return router;
}
