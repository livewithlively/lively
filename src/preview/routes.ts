// 프리뷰 서브패스 서빙 — /preview/:id/* (#1036). backing_mode 별:
//  shared-proxy(work) · stage : 워크트리 public/ 정적 서빙(/api 는 게이트웨이 자신 — /preview/<id>/api/… 는 307 로 본체에 넘긴다).
//  throwaway : 게이트웨이가 spawn 한 백엔드 포트로 HTTP 프록시.  existing-ref : 등록된 기존 인스턴스 URL 로 프록시.
//  페이지가 /preview/<id>/ 기준으로 로드되므로 상대경로 asset/import 가 서브패스로 해소된다(→ /preview/<id> 는 슬래시로 정규화).
//  정규 주소(#1169): **/preview/<id>/ui/** — 루트·`/ui`(슬래시 없음) 진입은 302 로 여기 모인다(메인의 `/` → `/ui/` 와 동일).
//  인증(#1169): 메인 게이트웨이와 같은 자리 — 화면(정적·자식 프록시)은 비인증이고 인증은 API 가 한다.
//   existing-ref 만 예외로 이 라우트에서 인증한다(아래 registerPreviewRoutes 주석에 사연).
//  ⚠ 프록시 바디: /preview 는 express.json 이후 마운트라 JSON body 가 파싱돼 있다 → 프록시 시 재직렬화해 전달(JSON API 대상 전제).
import type express from "express";
import { statSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import http from "node:http";
import type { BearerVerifier } from "../auth/bearer.js";
import { sessionOrBearer } from "../auth/http-auth.js";
import { getPreviewEnvForRoute } from "./preview-envs.js";
import { portOf } from "./preview-proc.js";
import { withPreviewFavicon, isRewritableHtml } from "./preview-favicon.js";

const TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};
const ID_CAP = "([a-z0-9][a-z0-9_-]{0,63})";
export const HTML_REWRITE_CAP = 4 * 1024 * 1024; // 파비콘 치환을 위해 버퍼링할 HTML 상한 — 넘으면 원본 스트리밍으로 되돌린다

// serveStatic·proxyTo 는 라우트 내부 함수지만 **테스트가 실물 HTTP 로 붙을 수 있게** export 한다(#1572).
//  registerPreviewRoutes 로는 DB(getPreviewEnv) 없이 못 부르는데, 정작 검증이 필요한 건 그 아래의
//  응답 처리(HTML 만 치환·압축은 통과·큰 바디는 스트리밍 복귀·바디 없는 응답)라서다.
export function serveStatic(publicDir: string, rel: string, res: express.Response): void {
  const full = path.resolve(publicDir, rel || "index.html");
  if (full !== publicDir && !full.startsWith(publicDir + path.sep)) { res.status(400).end(); return; } // 경로 이탈 차단
  let st: Stats;
  try { st = statSync(full); } catch { res.status(404).type("text/plain; charset=utf-8").send("파일 없음"); return; }
  if (!st.isFile()) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "no-store"); // 프리뷰는 항상 워크트리의 현재 빌드
  const ext = path.extname(full).toLowerCase();
  res.type(TYPES[ext] || "application/octet-stream");
  // HTML 은 파비콘만 미리보기 아이콘으로 갈아끼워 내보낸다(#1572) — 워크트리 원본은 건드리지 않는다.
  if (ext === ".html" || ext === ".htm") { res.send(withPreviewFavicon(readFileSync(full, "utf8"))); return; }
  res.send(readFileSync(full));
}

// 자식이 준 Location 을 프리뷰 서브패스로 되돌린다(#1169).
//  자식 게이트웨이는 자기가 오리진 루트에 있다고 믿으므로 `/ui/` 같은 **루트 절대경로**를 준다(web.ts: `/` → `/ui/`).
//  그대로 흘리면 브라우저가 오리진 루트(=라이브 게이트웨이)로 따라가 **프리뷰가 풀린다** — `/preview/<id>/` 를
//  열었더니 라이브 UI 에 착지하던 증상의 정체다. 경로만 뽑아 접두사를 다시 붙인다.
//  건드리지 않는 것: 프로토콜 상대(`//host/…`)·다른 호스트로 보내는 Location(외부 리다이렉트는 의도된 이탈)·
//  상대경로 Location(브라우저가 현재 경로 기준으로 풀므로 이미 프리뷰 안이다).
function reLocate(loc: string, base: string, prefix: string): string | null {
  if (loc.startsWith("//")) return null;
  if (loc.startsWith("/")) return prefix + loc;
  try {
    const u = new URL(loc);
    const b = new URL(base.endsWith("/") ? base : base + "/");
    if (u.host !== b.host) return null;
    return prefix + u.pathname + u.search;
  } catch { return null; }
}

// 자식이 준 Set-Cookie 의 Path 를 프리뷰 서브패스로 되돌린다(#1541) — reLocate 와 같은 이유·같은 자리.
//  자식은 자기가 오리진 루트에 있다고 믿으므로 `Path=/terminal` 같은 **루트 절대경로**를 준다. 그대로 흘리면
//  브라우저는 그 쿠키를 `/preview/<id>/terminal/…` 요청에 **보내지 않는다**(Path 가 안 맞으므로).
//  실측 증상: 웹터미널 티켓 쿠키가 Path=/terminal 로 내려와, 프리뷰에서 WS 업그레이드에 쿠키가 빠짐 →
//   게이트웨이가 티켓을 못 찾아 소켓을 그냥 끊음 → 502 → 화면은 "재연결 중…" 무한 반복.
//   ⚠ raw 소켓 프로브로는 재현되지 않는다(도구는 Path 를 무시하고 쿠키를 싣는다) — 브라우저로만 보인다.
//  Path 가 없는 쿠키는 건드리지 않는다(브라우저 기본값이 요청 경로 기준이라 이미 프리뷰 안이다).
export function rePathCookie(setCookie: string, prefix: string): string {
  if (!prefix) return setCookie;
  return setCookie.replace(/(;\s*[Pp]ath\s*=\s*)(\/[^;]*)/, (m, pre: string, p: string) =>
    p === prefix || p.startsWith(prefix + "/") ? m : `${pre}${prefix}${p === "/" ? "/" : p}`);
}

// base(http(s)://host:port) 로 HTTP 프록시 — rest 경로 + 쿼리 보존, JSON body 재직렬화, 응답 스트림 파이프.
//  prefix = `/preview/<id>` — 자식 응답의 Location·Set-Cookie Path 를 이 아래로 되돌리는 데 쓴다.
export function proxyTo(base: string, rest: string, req: express.Request, res: express.Response, prefix: string): void {
  let target: URL;
  const qi = req.originalUrl.indexOf("?");
  const search = qi >= 0 ? req.originalUrl.slice(qi) : "";
  try { target = new URL((rest || "") + search, base.endsWith("/") ? base : base + "/"); } catch { res.status(502).type("text/plain; charset=utf-8").send("프록시 대상 URL 오류"); return; }
  if (target.protocol !== "http:") { res.status(502).type("text/plain; charset=utf-8").send("프리뷰 프록시는 http 대상만 지원합니다(현재)"); return; }
  const hasBody = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && Object.keys(req.body).length > 0;
  const bodyBuf = hasBody ? Buffer.from(JSON.stringify(req.body)) : null;
  // ── 본문 전달은 두 갈래다 ────────────────────────────────────────────────
  //  ① 앞단 express.json 이 이미 먹은 JSON → 다시 직렬화해 보낸다.
  //  ② 그 밖의 본문(파일 업로드의 application/octet-stream 등)은 파서가 손대지 않아 **아직 스트림에 남아 있다**
  //     → 그대로 흘린다. 이 갈래가 없어서 프리뷰를 거친 PUT /file 이 전부 **0바이트**로 저장됐다(실측 2026-08-20,
  //     #1819: 자료 붙여넣기가 조용히 빈 파일을 만들었고, 서버는 200 을 줘서 화면상 성공으로 보였다).
  //  ⚠ ② 에서는 원본 content-length 를 **지우지 않는다** — 길이를 지우면 상대가 청크 종료만 기다린다.
  //   반대로 본문이 없는데 길이를 남기면 상대가 오지 않을 바이트를 기다리므로, 없을 때만 지운다.
  const rawBody = !hasBody && req.readable && !req.complete && req.method !== "GET" && req.method !== "HEAD";
  const headers: Record<string, string | string[]> = { ...req.headers } as Record<string, string | string[]>;
  headers.host = target.host;
  if (bodyBuf) { headers["content-type"] = "application/json"; headers["content-length"] = String(bodyBuf.length); }
  else if (!rawBody) delete headers["content-length"];
  const up = http.request(
    { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers },
    (r) => {
      const out = { ...r.headers };
      if (typeof out.location === "string") {
        const fixed = reLocate(out.location, base, prefix);
        if (fixed) out.location = fixed;
      }
      // Set-Cookie 는 여러 줄일 수 있어 배열로 온다 — 전부 같은 규칙으로 되돌린다.
      //  (Node 타입상 string[] 이지만 구현에 따라 단일 문자열이 올 수 있어 둘 다 받는다.)
      const sc: unknown = out["set-cookie"];
      if (Array.isArray(sc)) out["set-cookie"] = sc.map((c) => rePathCookie(String(c), prefix));
      else if (typeof sc === "string") out["set-cookie"] = [rePathCookie(sc, prefix)];
      const code = r.statusCode || 502;
      // HTML 화면이면 파비콘만 미리보기 아이콘으로 갈아끼운다(#1572). 바디가 없는 응답(HEAD·204·304)과
      //  압축·비 utf-8·비 HTML 은 손대지 않고 그대로 흘린다.
      const bodyless = req.method === "HEAD" || code === 204 || code === 304;
      if (bodyless || !isRewritableHtml(out["content-type"], out["content-encoding"])) {
        res.writeHead(code, out); r.pipe(res); return;
      }
      const chunks: Buffer[] = [];
      let size = 0, streaming = false;
      r.on("data", (c: Buffer) => {
        if (streaming) return;
        chunks.push(c); size += c.length;
        if (size <= HTML_REWRITE_CAP) return;
        // 화면치고 지나치게 큰 HTML — 통째로 들고 있지 않고 여기서 원본 스트리밍으로 되돌린다(파비콘은 포기).
        streaming = true;
        res.writeHead(code, out);
        for (const b of chunks) res.write(b);
        chunks.length = 0;
        r.pipe(res);
      });
      r.on("end", () => {
        if (streaming) return;
        const body = Buffer.from(withPreviewFavicon(Buffer.concat(chunks).toString("utf8")), "utf8");
        delete out["transfer-encoding"]; // 우리가 길이를 아는 완결 바디로 바꿔 보낸다
        out["content-length"] = String(body.length);
        res.writeHead(code, out);
        res.end(body);
      });
    });
  // ⚠ charset 필수 — 이 경로가 사용자가 **실제로 가장 자주 만나는** 에러다(게이트웨이가 재시작되면 spawn 자식이
  //  함께 죽어 여기로 온다). 위 502/409 는 charset 을 붙이는데 여기만 raw res.end() 라 브라우저가 인코딩을
  //  추측해 한글이 깨졌고, 그래서 "뭐라는지 모르겠다"로 진단이 막혔다(#1153 확인 중 사용자 리포트).
  up.on("error", () => {
    if (res.headersSent) return;
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("프리뷰 백엔드 연결 실패 — 프로세스가 떠 있는지 확인하세요. (게이트웨이가 재시작되면 프리뷰 백엔드도 함께 내려갑니다 — 다시 띄우세요.)");
  });
  if (rawBody) {
    req.on("error", () => up.destroy());     // 클라이언트가 끊으면 상류 요청도 끊는다(반쯤 쓴 요청을 남기지 않는다)
    req.pipe(up);
  } else up.end(bodyBuf ?? undefined);
}

export function registerPreviewRoutes(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier);

  // ── 인증 경계 — 메인 게이트웨이와 같은 자리로 되돌린다(#1169). ──
  //  메인은 정적 프론트를 **비인증**으로 준다(web.ts `app.use("/ui", serveStatic)` — 미들웨어가 없다). 로드된
  //  SPA 가 `/api/ui/me` 에서 401 을 받고서야 로그인 게이트를 띄운다. 반면 프리뷰는 정적 자산까지 auth 를 걸어
  //  index.html 부터 `401 + WWW-Authenticate: Bearer` 를 줬다 — 브라우저는 Bearer 챌린지에 로그인 UI 를
  //  띄우지 않고 SPA 가 아예 로드되지 않으니 **로그인할 화면 자체가 없었다**(실측: `/ui/` 200 vs `/preview/<id>/` 401.
  //  "프리뷰 띄워도 로그인을 못해서 못 본다"의 정체 — 계정 문제가 아니었다). 그래서 화면은 열고 인증은 API 에 맡긴다:
  //    · shared-proxy·stage → `/preview/<id>/api/…` 를 본체로 307 → **본체가 인증**한다(경계 이동 없음).
  //    · throwaway          → 자식이 같은 코드라 `/ui` 비인증 + `/api` 인증을 그대로 적용한다.
  //    · existing-ref       → 대상이 자체 인증을 갖는다는 보장이 없다 → **여기서 인증을 유지**(유일 예외).

  // /preview/<id> → 정규 주소로. 접두사 없는 상대 asset 이 서브패스 기준으로 풀리도록 슬래시가 필수이고,
  //  착지점은 메인(`/` → `/ui/`)과 같은 `/ui/` 로 맞춘다.
  app.get(new RegExp("^/preview/" + ID_CAP + "$"), (req, res) => {
    res.redirect(302, "/preview/" + req.params[0] + "/ui/");
  });

  // /preview/<id>/* → backing_mode 별 정적 서빙 or 프록시(모든 메소드).
  app.all(new RegExp("^/preview/" + ID_CAP + "/(.*)$"), async (req, res) => {
    const id = req.params[0];
    const rest = decodeURIComponent(req.params[1] || "").replace(/^\/+/, "");
    // 루트·`/ui`(슬래시 없음) 진입은 정규 주소로 보낸다 — 메인의 `/` → `/ui/` 와 동일. 모드에 무관하게
    //  같은 주소(`/preview/<id>/ui/`)로 모이므로 사람에게 줄 링크가 하나로 정해진다.
    if ((req.method === "GET" || req.method === "HEAD") && (rest === "" || rest === "ui")) {
      res.redirect(302, "/preview/" + id + "/ui/"); return;
    }
    let p;
    try { p = await getPreviewEnvForRoute(id); } catch { res.status(500).end(); return; }
    if (!p) { res.status(404).type("text/plain; charset=utf-8").send("프리뷰 환경 없음: " + id); return; }
    if (!p.enabled || p.status === "stopped") { res.status(409).type("text/plain; charset=utf-8").send("이 미리보기는 정지 상태입니다 — 관리 화면에서 ‘띄우기’를 눌러 주세요."); return; }
    if (p.status === "preparing") { // 작업 폴더 준비·빌드가 백그라운드로 도는 중 — 브라우저가 잠시 뒤 다시 오게 안내
      res.status(503).setHeader("Retry-After", "5");
      res.type("text/plain; charset=utf-8").send("미리보기를 준비하는 중입니다(작업 폴더 준비·빌드). 잠시 후 새로고침해 주세요.");
      return;
    }

    // 정적 서빙 — stage(merge 워크트리) 또는 work+shared-proxy
    if (p.kind === "stage" || p.backing_mode === "shared-proxy") {
      // /preview/<id>/api/… → 게이트웨이 본체로 307(#1091). 프론트는 프리뷰 아래에서 API 도 접두사를 붙여 부르는데
      //  (core.ts apiUrl — throwaway 를 제 백엔드로 보내기 위해 필요하다), 정적 프리뷰엔 백엔드가 없다.
      //  307 은 메소드·바디를 보존하고 동일 오리진이라 Authorization 헤더도 그대로 따라간다.
      if (/^api\//.test(rest)) { res.redirect(307, req.originalUrl.slice(("/preview/" + id).length)); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.status(405).type("text/plain; charset=utf-8").send("정적 프리뷰는 GET 만 지원(API 는 게이트웨이 본체로 직접 호출)."); return; }
      if (!p.worktree_path) { res.status(409).type("text/plain; charset=utf-8").send("워크트리가 지정되지 않은 프리뷰입니다."); return; }
      // `ui/` 는 **마운트 접두사**라 벗긴다 — 메인의 `app.use("/ui", serveStatic)` 과 같은 의미다(그쪽도 `/ui` 는
      //  라우트 접두사일 뿐 실체는 public 루트다. `public/ui` 디렉터리는 존재하지 않는다). 프리뷰는 경로를
      //  public 하위에 그대로 이어 붙이므로 벗기지 않으면 `/preview/<id>/ui/` 가 404 였고, 그래서 같은 화면을
      //  모드마다 다른 주소로 열어야 했다(shared-proxy `/preview/<id>/` vs throwaway `/preview/<id>/ui/`).
      serveStatic(path.join(p.worktree_path, "public"), rest.replace(/^ui\//, ""), res); return;
    }

    // 프록시 — existing-ref(등록 URL) 또는 throwaway(spawn 포트)
    const prefix = "/preview/" + id;
    if (p.backing_mode === "existing-ref") {
      if (!p.backing_ref) { res.status(409).type("text/plain; charset=utf-8").send("existing-ref 대상(backing_ref)이 없습니다."); return; }
      const ref = p.backing_ref;
      // 유일하게 인증을 유지하는 분기 — 대상은 관리자가 등록한 임의 인스턴스라 자체 인증을 갖는다고 볼 수 없다.
      auth(req, res, () => { proxyTo(ref, rest, req, res, prefix); }); return;
    }
    if (p.backing_mode === "throwaway") {
      const port = p.port || portOf(id);
      if (!port) { res.status(409).type("text/plain; charset=utf-8").send("throwaway 백엔드가 아직 기동되지 않았습니다 — 관리탭에서 띄우세요."); return; }
      proxyTo("http://127.0.0.1:" + port, rest, req, res, prefix); return;
    }
    res.status(500).type("text/plain; charset=utf-8").send("알 수 없는 backing_mode: " + p.backing_mode);
  });
}
