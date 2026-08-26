// 알림 실시간 스트림 (#1842) — 앱이 하나 물고 있으면 세션이 끝나는 **그 순간** 배너가 뜬다.
//
// 왜 SSE 인가 (WebSocket 이 아니라):
//  · 방향이 하나다 — 서버가 밀기만 하고 앱은 아무것도 보내지 않는다. WS 의 양방향은 쓸 데가 없다.
//  · 업그레이드 핸들링을 건드리지 않는다 — 이 게이트웨이의 `upgrade` 경로는 터미널 PTY 와 노드 레지스트리가
//    쓰고 있고(둘 다 `noServer: true`), 거기에 세 번째 소비자를 끼우는 것보다 평범한 GET 하나가 안전하다.
//  · 재연결이 표준이다 — 끊기면 클라이언트가 다시 붙는다. 그 사이 사건은 앱의 폴백 폴링이 줍는다.
//
// ⚠ 이 라우트는 **판정하지 않는다.** 전이 사실만 그대로 흘린다(notify-bus.ts 머리말 참조).
import type express from "express";
import { subscribeNotify, type NotifySessionEvent } from "./notify-bus.js";

/** keepalive 주석 주기 — 프록시·로드밸런서가 조용한 연결을 끊는 것을 막는다(traefik 기본 유휴가 이보다 길다). */
const PING_MS = 25_000;

/**
 * `GET /api/ui/notify/stream` — 이 사람 앞으로 오는 사건을 흘린다.
 * @param app express 앱
 * @param mw 인증 미들웨어 체인(web.ts 의 `mw(scope)`) — 신원 없이는 열지 않는다
 * @param idOf 요청 → 멤버 id
 */
export function registerNotifyRoutes(
  app: express.Express,
  mw: express.RequestHandler[],
  idOf: (req: express.Request) => string,
): void {
  app.get("/api/ui/notify/stream", ...mw, (req, res) => {
    const me = String(idOf(req) || "").trim();
    if (!me) { res.status(401).json({ error: "unauthenticated" }); return; }

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
    const off = subscribeNotify(me, send);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* 곧 close 가 온다 */ } }, PING_MS);
    if (ping.unref) ping.unref();

    // ⚠ 해지를 반드시 건다 — 안 걸면 앱을 껐다 켤 때마다 구독이 쌓여 죽은 소켓에 계속 쓴다.
    const done = () => { clearInterval(ping); off(); };
    req.on("close", done);
    res.on("close", done);
    res.on("error", done);
  });
}
