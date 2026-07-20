// 프리뷰 서브패스 서빙 — /preview/:id/* 를 프리뷰 환경의 워크트리 public/ 에서 정적 서빙 (#1036).
//  shared-proxy(work): 프론트만 워크트리 것, API(/api/ui)는 프론트가 root-relative 로 부르므로 게이트웨이 자신이 처리 —
//  별도 프로세스·포트·프록시 불필요. 페이지가 /preview/<id>/ 기준으로 로드되므로 상대경로 asset/import 가 자동으로
//  서브패스로 해소된다(그래서 /preview/<id> 는 반드시 /preview/<id>/ 로 정규화해야 한다).
//  인증: sessionOrBearer(세션 쿠키 우선) — 브라우저 subresource 는 Authorization 헤더를 못 실으니 로그인 세션 쿠키에 의존.
import type express from "express";
import { statSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import type { BearerVerifier } from "./auth/bearer.js";
import { sessionOrBearer } from "./auth/http-auth.js";
import { getPreviewEnv } from "./org/preview-envs.js";

const TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

const ID_CAP = "([a-z0-9][a-z0-9_-]{0,63})";

export function registerPreviewRoutes(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier);

  // /preview/<id> → 슬래시 정규화(상대경로 asset 이 서브패스 기준으로 풀리도록 필수).
  app.get(new RegExp("^/preview/" + ID_CAP + "$"), auth, (req, res) => {
    res.redirect(302, "/preview/" + req.params[0] + "/");
  });

  // /preview/<id>/* → 워크트리 public/ 정적 서빙.
  app.get(new RegExp("^/preview/" + ID_CAP + "/(.*)$"), auth, async (req, res) => {
    const id = req.params[0];
    let rel = decodeURIComponent(req.params[1] || "").replace(/^\/+/, "");
    if (rel === "") rel = "index.html";

    let p;
    try { p = await getPreviewEnv(id); } catch { res.status(500).end(); return; }
    if (!p) { res.status(404).type("text/plain; charset=utf-8").send("프리뷰 환경 없음: " + id); return; }
    if (!p.enabled || p.status === "stopped") {
      res.status(409).type("text/plain; charset=utf-8").send("프리뷰가 정지 상태입니다 — 관리탭에서 띄우세요(ensure)."); return;
    }
    const wt = p.worktree_path;
    if (!wt) { res.status(409).type("text/plain; charset=utf-8").send("워크트리가 지정되지 않은 프리뷰입니다."); return; }

    const publicDir = path.join(wt, "public");
    const full = path.resolve(publicDir, rel);
    if (full !== publicDir && !full.startsWith(publicDir + path.sep)) { res.status(400).end(); return; } // 경로 이탈 차단

    let st: Stats;
    try { st = statSync(full); } catch { res.status(404).type("text/plain; charset=utf-8").send("파일 없음: " + rel); return; }
    if (!st.isFile()) { res.status(404).end(); return; }

    res.setHeader("Cache-Control", "no-store"); // 프리뷰는 항상 워크트리의 현재 빌드를 보여준다
    res.type(TYPES[path.extname(full).toLowerCase()] || "application/octet-stream");
    res.send(readFileSync(full));
  });
}
