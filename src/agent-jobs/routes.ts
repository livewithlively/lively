// 작업 컨테이너 판의 콜백 — **사용자 인증이 아니다** (#4490 앱 v2-11).
//  판은 컨테이너 안 `localhost:8080`(세션 루프백 → mcp.sock)으로 부른다. 테넌트는 브로커가 그 소켓에 붙인 헤더가 정하고(판이 사칭 못 한다),
//  작업 하나는 그 작업의 비밀(Bearer)이 연다 — boot 는 일회용 부트 비밀, tick·result 는 boot 가 준 콜백 비밀. 작업 행은 RLS 로 그 워크스페이스 것만 보인다.
//  (로그인 판 /api/login-jobs/:id/* 과 같은 꼴 — terminal/routes.ts.)
import type express from "express";
import { wrap, HttpError } from "../http/rest-util.js";

export function registerAgentJobRoutes(app: express.Express): void {
  const idOf = (req: express.Request): number => {
    const n = Number(req.params.id);
    if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, "없는 작업입니다");
    return n;
  };
  const bearer = (req: express.Request): string => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
  const deps = async () => (await import("./live.js")).liveAgentJobDeps();
  app.post("/api/agent-jobs/:id/boot", wrap(async (req, res) => {
    const { onBoot } = await import("./service.js");
    res.setHeader("Cache-Control", "no-store");
    res.json(await onBoot(idOf(req), bearer(req), await deps()));
  }));
  app.post("/api/agent-jobs/:id/tick", wrap(async (req, res) => {
    const { onTick } = await import("./service.js");
    res.setHeader("Cache-Control", "no-store");
    res.json(await onTick(idOf(req), bearer(req), req.body, await deps()));
  }));
  app.post("/api/agent-jobs/:id/result", wrap(async (req, res) => {
    const { onResult } = await import("./service.js");
    res.setHeader("Cache-Control", "no-store");
    res.json(await onResult(idOf(req), bearer(req), req.body, await deps()));
  }));
}
