// 앱 백그라운드 작업 — 함수 안 검사 층의 콜백(#4486 앱 v2-7). **사용자 인증이 아니다.**
//  검사 층이 워크스페이스 주소(LIVELY_API_URL)로 부른다 → 앞단(CP 라우터)이 테넌트를 붙인다(작업 행은 RLS 로 그 워크스페이스 것만 보인다).
//  자격은 둘을 함께: ① 그 함수에 구운 앱 서버 토큰(Authorization: Bearer — 이 워크스페이스 · 이 앱의 것) ② 작업 비밀 —
//   claim 은 부르기 비밀(x-lively-job-secret · 한 번만 넘긴다), tick · result 는 claim 이 준 돌기 신원(x-lively-job-run).
//  판정 · 흐름은 apps/app-jobs.ts(onJobClaim · onJobTick · onJobResult). 작업 컨테이너 판의 콜백(/api/agent-jobs/:id/*)과 같은 꼴이다.
import type express from "express";
import { wrap, HttpError } from "../http/rest-util.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";

export function registerAppJobRoutes(app: express.Express, verifier: BearerVerifier): void {
  const idOf = (req: express.Request): number => {
    const n = Number(req.params.id);
    if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, "없는 작업입니다");
    return n;
  };
  const header = (req: express.Request, name: string): string => {
    const v = req.headers[name];
    return String((Array.isArray(v) ? v[0] : v) ?? "").trim();
  };
  const callerOf = async (req: express.Request) => {
    const m = /^Bearer\s+(\S+)$/i.exec(header(req, "authorization"));
    if (!m) throw new HttpError(401, "앱 서버 토큰이 필요합니다");
    let user: LivelyUser | undefined;
    try { user = (await verifier.verifyAccessToken(m[1]!)).extra as LivelyUser | undefined; } catch { throw new HttpError(401, "앱 서버 토큰이 유효하지 않습니다"); }
    return (await import("./app-jobs.js")).jobCallerOf(user);
  };
  app.post("/api/app-jobs/:id/claim", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const svc = await import("./app-jobs.js");
    res.json(await svc.onJobClaim(idOf(req), await callerOf(req), header(req, "x-lively-job-secret")));
  }));
  app.post("/api/app-jobs/:id/tick", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const svc = await import("./app-jobs.js");
    res.json(await svc.onJobTick(idOf(req), await callerOf(req), header(req, "x-lively-job-run")));
  }));
  app.post("/api/app-jobs/:id/result", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const svc = await import("./app-jobs.js");
    res.json(await svc.onJobResult(idOf(req), await callerOf(req), header(req, "x-lively-job-run"), req.body));
  }));
}
