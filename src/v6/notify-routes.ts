// 알림 실시간 스트림 (#1842) — 앱이 하나 물고 있으면 세션이 끝나는 **그 순간** 배너가 뜬다.
//
// 왜 SSE 인가 (WebSocket 이 아니라):
//  · 방향이 하나다 — 서버가 밀기만 하고 앱은 아무것도 보내지 않는다. WS 의 양방향은 쓸 데가 없다.
//  · 업그레이드 핸들링을 건드리지 않는다 — 이 게이트웨이의 `upgrade` 경로는 터미널 PTY 와 노드 레지스트리가
//    쓰고 있고(둘 다 `noServer: true`), 거기에 세 번째 소비자를 끼우는 것보다 평범한 GET 하나가 안전하다.
//  · 재연결이 표준이다 — 끊기면 클라이언트가 다시 붙는다. 그 사이 사건은 앱의 폴백 폴링이 줍는다.
//
// ⚠ 이 라우트는 **판정하지 않는다.** 전이 사실만 그대로 흘린다(notify-bus.ts 머리말 참조).
//
// #4054 — 무엇을 받는지는 **워크스페이스 + 사람**의 목록이 정한다(notify-scope.ts). 다른 워크스페이스의 사건은
//  클라이언트가 `?all=1` 로 청할 때만 받는다(데스크톱 앱). 목록은 스트림이 열리는 **즉시** 자기 워크스페이스로 걸고,
//  계정 서버 확인이 끝나면 넓힌다 — 확인을 기다리는 동안 난 사건을 놓치지 않게.
import type express from "express";
import { subscribeNotify, type NotifyRoute, type NotifySessionEvent } from "./notify-bus.js";
import { ownRouteNow } from "./notify-scope.js";

/** keepalive 주석 주기 — 프록시·로드밸런서가 조용한 연결을 끊는 것을 막는다(traefik 기본 유휴가 이보다 길다). */
const PING_MS = 25_000;
/** 받는 자리를 다시 확인하는 주기 — 워크스페이스에 들어가고 나가는 것을 연결을 끊지 않고 따라간다. */
export const ROUTE_REFRESH_MS = 5 * 60_000;

/** 받는 자리를 정하는 함수 — web.ts 가 실제 판정(notify-scope.resolveNotifyRoutes)을 넣는다. */
export type NotifyRouteResolver = (req: express.Request, me: string, all: boolean) =>
  Promise<{ routes: NotifyRoute[]; transient: boolean }>;

/** `?all=1` 인가 — 다른 워크스페이스 사건까지 청하는 클라이언트(데스크톱 앱). */
export function wantsAllWorkspaces(query: unknown): boolean {
  const v = (query as Record<string, unknown> | null | undefined)?.all;
  const one = Array.isArray(v) ? v[0] : v;
  return one === "1" || one === "true";
}

/**
 * `GET /api/ui/notify/stream` — 이 사람 앞으로 오는 사건을 흘린다.
 * @param app express 앱
 * @param mw 인증 미들웨어 체인(web.ts 의 `mw(scope)`) — 신원 없이는 열지 않는다
 * @param idOf 요청 → 멤버 id
 * @param resolve 받는 자리 판정. 없으면 자기 워크스페이스만(검증 하네스 등)
 * @param opts.refreshMs 받는 자리 재확인 주기(시험용 seam — 운영은 주지 않는다)
 */
export function registerNotifyRoutes(
  app: express.Express,
  mw: express.RequestHandler[],
  idOf: (req: express.Request) => string,
  resolve?: NotifyRouteResolver,
  opts: { refreshMs?: number } = {},
): void {
  const refreshMs = opts.refreshMs && opts.refreshMs > 0 ? opts.refreshMs : ROUTE_REFRESH_MS;
  app.get("/api/ui/notify/stream", ...mw, (req, res) => {
    const me = String(idOf(req) || "").trim();
    if (!me) { res.status(401).json({ error: "unauthenticated" }); return; }
    const all = wantsAllWorkspaces(req.query);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");   // nginx 계열이 버퍼링하면 '실시간'이 통째로 무의미해진다
    res.flushHeaders?.();
    res.write(": ok\n\n");                       // 첫 바이트 — 클라이언트가 '연결됨'을 알 수 있게

    const send = (ev: NotifySessionEvent) => {
      // SSE 는 줄 단위 프로토콜이라 본문에 개행이 섞이면 프레임이 깨진다 — JSON.stringify 가 개행을 이스케이프한다.
      res.write(`event: session\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    // 자기 워크스페이스는 **지금** 건다 — 이름·다른 워크스페이스는 아래 확인이 끝나면 채운다.
    const sub = subscribeNotify(ownRouteNow(me), send);
    let closed = false;
    let widened = false;   // 한 번이라도 넓은 목록을 받았나 — 일시 실패로 그 목록을 버리지 않는다
    const refresh = async () => {
      if (!resolve || closed) return;
      try {
        const r = await resolve(req, me, all);
        if (closed) return;
        if (r.transient && widened) return;       // 계정 서버가 잠깐 안 잡혔다 — 받던 대로 둔다
        sub.update(r.routes);
        widened = r.routes.length > 1;            // 확답으로 좁혀졌으면(구성원 아님 등) 다음 일시 실패에 지킬 넓은 목록도 없다
      } catch { /* 판정 실패 — 받던 대로 둔다(자기 워크스페이스는 이미 걸려 있다) */ }
    };
    void refresh();
    const again = all && resolve ? setInterval(() => void refresh(), refreshMs) : null;
    if (again?.unref) again.unref();
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* 곧 close 가 온다 */ } }, PING_MS);
    if (ping.unref) ping.unref();

    // ⚠ 해지를 반드시 건다 — 안 걸면 앱을 껐다 켤 때마다 구독이 쌓여 죽은 소켓에 계속 쓴다.
    const done = () => {
      closed = true;
      clearInterval(ping);
      if (again) clearInterval(again);
      sub.close();
    };
    req.on("close", done);
    res.on("close", done);
    res.on("error", done);
  });
}
