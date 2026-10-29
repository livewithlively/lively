// 작업 컨테이너 판의 콜백 — **사용자 인증이 아니다** (#4490 앱 v2-11).
//  판은 컨테이너 안 `localhost:8080`(세션 루프백 → mcp.sock)으로 부른다. 테넌트는 브로커가 그 소켓에 붙인 헤더가 정하고(판이 사칭 못 한다),
//  작업 하나는 그 작업의 비밀(Bearer)이 연다 — boot 는 일회용 부트 비밀, tick·result·transcript(#5101) 는 boot 가 준 콜백 비밀, boot-failed 는 부트 비밀과 같은 값
//  (첫 박동 전까지만 — #4829). 작업 행은 RLS 로 그 워크스페이스 것만 보인다.
//  (로그인 판 /api/login-jobs/:id/* 과 같은 꼴 — terminal/routes.ts.)
import express from "express";
import { wrap, HttpError } from "../http/rest-util.js";
import { TRANSCRIPT_GZ_MAX } from "./plan.js";

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
  app.post("/api/agent-jobs/:id/boot-failed", wrap(async (req, res) => {
    const { onBootFailed } = await import("./service.js");
    res.setHeader("Cache-Control", "no-store");
    res.json(await onBootFailed(idOf(req), bearer(req), req.body, await deps()));
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
  //  #5101 API 키 작업의 대화 기록(gzip 바이트 그대로) — 전역 JSON 파서(1MB)는 이 본문을 읽지 않는다(application/json 이 아니다). 상한은 그 수 그대로.
  //   비밀을 모르는 요청이 큰 본문을 읽히지 않게 머리글부터 본다(브라우저 답 입구 /api/ui/browser/host/reply 와 같은 꼴).
  app.post("/api/agent-jobs/:id/transcript",
    (req, res, next) => { if (bearer(req)) next(); else res.status(401).json({ error: "작업 비밀이 맞지 않습니다" }); },
    express.raw({ type: () => true, limit: TRANSCRIPT_GZ_MAX }),
    wrap(async (req, res) => {
      const { onTranscript } = await import("./service.js");
      res.setHeader("Cache-Control", "no-store");
      res.json(await onTranscript(idOf(req), bearer(req), req.body, req.headers["x-lvly-conversation"], await deps()));
    }));
}
