// 작업 컨테이너 판의 콜백 — **사용자 인증이 아니다** (#4490 앱 v2-11).
//  판은 컨테이너 안 `localhost:8080`(세션 루프백 → mcp.sock)으로 부른다. 테넌트는 브로커가 그 소켓에 붙인 헤더가 정하고(판이 사칭 못 한다),
//  작업 하나는 그 작업의 비밀(Bearer)이 연다 — boot 는 일회용 부트 비밀, tick·result·transcript(#5101) 는 boot 가 준 콜백 비밀, boot-failed 는 부트 비밀과 같은 값
//  (첫 박동 전까지만 — #4829). 작업 행은 RLS 로 그 워크스페이스 것만 보인다.
//  (로그인 판 /api/login-jobs/:id/* 과 같은 꼴 — terminal/routes.ts.)
import express from "express";
import { wrap, HttpError } from "../http/rest-util.js";
import { logger } from "../log.js";
import { TRANSCRIPT_GZ_MAX } from "./plan.js";

/** #5101 대화 기록 본문을 다 받기까지의 상한 — 멈춘 보고가 그 작업의 자리(receiving)를 쥐고 있지 못하게(판의 요청 상한 20초 · 8MiB 를 넉넉히 넘는다). */
const TRANSCRIPT_BODY_MS = 120_000;

export function registerAgentJobRoutes(app: express.Express, o: { transcriptBodyMs?: number } = {}): void {
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
  //  #5101 API 키 작업의 대화 기록 묶음(gzip 바이트 그대로) — 전역 JSON 파서(1MB)는 이 본문을 읽지 않는다(application/json 이 아니다). 상한은 그 수 그대로.
  //   본문을 읽기 **전에** 문(service.transcriptGate)이 콜백 비밀 · 도는 API 키 작업 · 보관 켜짐 · 아직 안 받음을 본다 — 비밀을 모르는 요청 · 받을 일이 없는
  //   보고가 8MiB 를 읽히지 못한다(받을 일이 없으면 200 {stored:false} · 비밀이 틀리면 401 · 끝난 작업 410).
  //   같은 작업의 보고를 동시에 여럿 받지 않는다(receiving — 이 프로세스에서 작업마다 본문 하나) — 콜백 비밀을 쥔 쪽이 저장 전에 8MiB 를 N 개 겹쳐 보내
  //   게이트웨이 메모리를 N 배 쥐게 하지 못한다(격리 리뷰). 겹친 보고는 받지 않음(200 {stored:false})이고, 판은 한 번만 보낸다.
  const receiving = new Set<number>();
  app.post("/api/agent-jobs/:id/transcript",
    (req, res, next) => {
      void (async () => {
        const id = idOf(req);
        const { transcriptGate } = await import("./service.js");
        //  문을 기다리는 사이 연결이 끊겼으면(res.destroyed) 자리를 잡지 않는다 — close 는 이미 지나가 다시 오지 않는다(격리 리뷰: 잡으면 영영 남는다).
        if ((await transcriptGate(id, bearer(req), await deps())).take && !receiving.has(id) && !res.destroyed) {
          receiving.add(id);
          const stall = setTimeout(() => req.destroy(), o.transcriptBodyMs ?? TRANSCRIPT_BODY_MS);
          res.on("close", () => { clearTimeout(stall); receiving.delete(id); });   // 답을 보냈거나 연결이 끊겼다
          next();
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.json({ ok: true, stored: false });
      })().catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status >= 500) logger.error({ err: (e as Error)?.message, path: req.path }, "[agent-job] 대화 기록 문에서 실패했다");
        res.status(status).json({ error: status === 500 ? "internal_error" : (e as Error).message });
      });
    },
    express.raw({ type: () => true, limit: TRANSCRIPT_GZ_MAX }),
    wrap(async (req, res) => {
      const { onTranscript } = await import("./service.js");
      res.setHeader("Cache-Control", "no-store");
      res.json(await onTranscript(idOf(req), bearer(req), req.body, req.headers["x-lvly-conversation"], await deps()));
    }));
}
