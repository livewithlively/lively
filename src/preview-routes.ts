// 프리뷰 서브패스 서빙 — /preview/:id/* (#1036). backing_mode 별:
//  shared-proxy(work) · stage : 워크트리 public/ 정적 서빙(/api 는 게이트웨이 자신; 프론트가 root-relative 로 부름).
//  throwaway : 게이트웨이가 spawn 한 백엔드 포트로 HTTP 프록시.  existing-ref : 등록된 기존 인스턴스 URL 로 프록시.
//  페이지가 /preview/<id>/ 기준으로 로드되므로 상대경로 asset/import 가 서브패스로 해소된다(→ /preview/<id> 는 슬래시로 정규화).
//  인증: sessionOrBearer(세션 쿠키 우선) — 브라우저 subresource 는 Authorization 헤더를 못 실으니 로그인 세션 쿠키에 의존.
//  ⚠ 프록시 바디: /preview 는 express.json 이후 마운트라 JSON body 가 파싱돼 있다 → 프록시 시 재직렬화해 전달(JSON API 대상 전제).
import type express from "express";
import { statSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import http from "node:http";
import type { BearerVerifier } from "./auth/bearer.js";
import { sessionOrBearer } from "./auth/http-auth.js";
import { getPreviewEnv } from "./org/preview-envs.js";
import { portOf } from "./org/preview-proc.js";

const TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};
const ID_CAP = "([a-z0-9][a-z0-9_-]{0,63})";

function serveStatic(publicDir: string, rel: string, res: express.Response): void {
  const full = path.resolve(publicDir, rel || "index.html");
  if (full !== publicDir && !full.startsWith(publicDir + path.sep)) { res.status(400).end(); return; } // 경로 이탈 차단
  let st: Stats;
  try { st = statSync(full); } catch { res.status(404).type("text/plain; charset=utf-8").send("파일 없음"); return; }
  if (!st.isFile()) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "no-store"); // 프리뷰는 항상 워크트리의 현재 빌드
  res.type(TYPES[path.extname(full).toLowerCase()] || "application/octet-stream");
  res.send(readFileSync(full));
}

// base(http(s)://host:port) 로 HTTP 프록시 — rest 경로 + 쿼리 보존, JSON body 재직렬화, 응답 스트림 파이프.
function proxyTo(base: string, rest: string, req: express.Request, res: express.Response): void {
  let target: URL;
  const qi = req.originalUrl.indexOf("?");
  const search = qi >= 0 ? req.originalUrl.slice(qi) : "";
  try { target = new URL((rest || "") + search, base.endsWith("/") ? base : base + "/"); } catch { res.status(502).type("text/plain; charset=utf-8").send("프록시 대상 URL 오류"); return; }
  if (target.protocol !== "http:") { res.status(502).type("text/plain; charset=utf-8").send("프리뷰 프록시는 http 대상만 지원합니다(현재)"); return; }
  const hasBody = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && Object.keys(req.body).length > 0;
  const bodyBuf = hasBody ? Buffer.from(JSON.stringify(req.body)) : null;
  const headers: Record<string, string | string[]> = { ...req.headers } as Record<string, string | string[]>;
  headers.host = target.host;
  if (bodyBuf) { headers["content-type"] = "application/json"; headers["content-length"] = String(bodyBuf.length); }
  else delete headers["content-length"];
  const up = http.request(
    { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on("error", () => { if (!res.headersSent) { res.statusCode = 502; res.end("프리뷰 백엔드 연결 실패 — 프로세스가 떠 있는지 확인하세요."); } });
  up.end(bodyBuf ?? undefined);
}

export function registerPreviewRoutes(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier);

  // /preview/<id> → 슬래시 정규화(상대경로 asset 이 서브패스 기준으로 풀리도록 필수).
  app.get(new RegExp("^/preview/" + ID_CAP + "$"), auth, (req, res) => {
    res.redirect(302, "/preview/" + req.params[0] + "/");
  });

  // /preview/<id>/* → backing_mode 별 정적 서빙 or 프록시(모든 메소드).
  app.all(new RegExp("^/preview/" + ID_CAP + "/(.*)$"), auth, async (req, res) => {
    const id = req.params[0];
    const rest = decodeURIComponent(req.params[1] || "").replace(/^\/+/, "");
    let p;
    try { p = await getPreviewEnv(id); } catch { res.status(500).end(); return; }
    if (!p) { res.status(404).type("text/plain; charset=utf-8").send("프리뷰 환경 없음: " + id); return; }
    if (!p.enabled || p.status === "stopped") { res.status(409).type("text/plain; charset=utf-8").send("프리뷰가 정지 상태입니다 — 관리탭에서 띄우세요(ensure)."); return; }

    // 정적 서빙 — stage(merge 워크트리) 또는 work+shared-proxy
    if (p.kind === "stage" || p.backing_mode === "shared-proxy") {
      if (req.method !== "GET" && req.method !== "HEAD") { res.status(405).type("text/plain; charset=utf-8").send("정적 프리뷰는 GET 만 지원(API 는 게이트웨이 본체로 직접 호출)."); return; }
      if (!p.worktree_path) { res.status(409).type("text/plain; charset=utf-8").send("워크트리가 지정되지 않은 프리뷰입니다."); return; }
      serveStatic(path.join(p.worktree_path, "public"), rest, res); return;
    }

    // 프록시 — existing-ref(등록 URL) 또는 throwaway(spawn 포트)
    if (p.backing_mode === "existing-ref") {
      if (!p.backing_ref) { res.status(409).type("text/plain; charset=utf-8").send("existing-ref 대상(backing_ref)이 없습니다."); return; }
      proxyTo(p.backing_ref, rest, req, res); return;
    }
    if (p.backing_mode === "throwaway") {
      const port = p.port || portOf(id);
      if (!port) { res.status(409).type("text/plain; charset=utf-8").send("throwaway 백엔드가 아직 기동되지 않았습니다 — 관리탭에서 띄우세요."); return; }
      proxyTo("http://127.0.0.1:" + port, rest, req, res); return;
    }
    res.status(500).type("text/plain; charset=utf-8").send("알 수 없는 backing_mode: " + p.backing_mode);
  });
}
