// 브라우저 화면 쪽 표면 (#4993) — 데스크톱 앱 화면(웹 UI)이 **명령을 받는 스트림**과 **답을 돌려주는 자리**.
//
//  · GET  /api/ui/browser/host/stream?host=<id>   SSE — 게이트웨이가 명령(cmd)을 민다. 화면이 물고 있는 동안만 AI 가 브라우저를 쓴다.
//  · POST /api/ui/browser/host/reply              화면이 명령의 결과를 돌려준다(스크린샷이 실려 본문이 크다 — index.ts 가 이 경로만 4mb 로 받는다).
//  · POST /api/ui/browser/host/state              화면의 상태(사람이 만진 시각 · 창이 앞에 있나 · 탭을 쥔 세션).
//
// 왜 capability 가 아니라 라우트인가: 스트림은 JSON 한 번 돌려주는 표면이 아니다(notify-routes.ts 와 같은 사정).
//  답·상태도 «AI 가 부르는 툴» 이 아니라 화면만 쓰는 배관이라 MCP 표면에 둘 까닭이 없다.
//
// 왜 WebSocket 이 아니라 SSE + POST 인가: 이 게이트웨이의 upgrade 경로는 터미널 PTY 와 노드 레지스트리가 쓰고 있고
//  (둘 다 noServer), 프록시(traefik)를 지나는 평범한 GET·POST 가 가장 덜 깨진다 — 알림 스트림(#1842)이 이미 같은 길로 산다.
import type express from "express";
import type { LivelyUser } from "../context.js";
import { currentTenant } from "../org/tenant-context.js";
import { browserRelay, relayKey, HOST_ID_RE, BROWSER_PROTOCOL, APP_PRINCIPAL_REFUSAL, isAppPrincipal, type BrowserRelay } from "./relay.js";

/** keepalive 주석 주기 — 프록시·로드밸런서가 조용한 연결을 끊는 것을 막는다(알림 스트림과 같은 값). */
const PING_MS = 25_000;

const clip = (v: unknown, max: number): string => String(v ?? "").slice(0, max);

/**
 * @param app express 앱
 * @param mw 인증 미들웨어 체인(web.ts 의 `mw("memory")`) — 신원 없이는 열지 않는다
 * @param userOf 요청 → 사용자
 * @param relay 시험용 seam(운영은 주지 않는다)
 */
export function registerBrowserRoutes(
  app: express.Express,
  mw: express.RequestHandler[],
  userOf: (req: express.Request) => LivelyUser | undefined,
  relay: BrowserRelay = browserRelay,
): void {
  /**
   * 이 요청의 중계 열쇠. 앱 토큰·앱 서버 주체는 사람의 브라우저를 물 수 없다(그 사람의 로그인으로 남의 사이트를 부리는 통로가 된다).
   *  ⚠ 토큰 머리글(Authorization)로 온 요청만 받는다 — 쿠키(SameSite=Lax)는 사람이 연 **다른 페이지의 최상위 이동**에도 실려서,
   *   그 길로 «답하지 않는 화면» 을 붙이면 AI 명령이 그리로 가 시간 초과만 난다(#4993 격리 리뷰). 데스크톱 앱 화면은 늘 토큰으로 붙는다.
   */
  const keyOf = (req: express.Request, res: express.Response): string | null => {
    if (!/^Bearer\s+\S/i.test(String(req.headers.authorization || ""))) {
      res.status(401).json({ error: "토큰 머리글(Authorization: Bearer)로만 연결할 수 있습니다" });
      return null;
    }
    const u = userOf(req);
    if (!u || !u.userId) { res.status(401).json({ error: "unauthenticated" }); return null; }
    if (isAppPrincipal(u)) { res.status(403).json({ error: APP_PRINCIPAL_REFUSAL }); return null; }
    return relayKey(currentTenant()?.slug, u.userId);
  };

  app.get("/api/ui/browser/host/stream", ...mw, (req, res) => {
    const key = keyOf(req, res);
    if (!key) return;
    const host = clip(req.query.host, 80);
    if (!HOST_ID_RE.test(host)) { res.status(400).json({ error: "host 형식이 올바르지 않습니다" }); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");   // nginx 계열이 버퍼링하면 명령이 화면에 늦게 닿는다
    res.flushHeaders?.();
    res.write(": ok\n\n");

    let closed = false;
    const push = (event: string, data: unknown): boolean => {
      if (closed || res.writableEnded || res.destroyed) return false;
      // SSE 는 줄 단위라 본문 개행이 프레임을 깬다 — JSON.stringify 가 개행을 이스케이프한다.
      //  write 의 false 는 «버퍼가 찼다»(역압)이지 «닫혔다»가 아니다 — 쓰기는 이미 큐에 들어갔으므로 성공으로 본다.
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; }
      catch { return false; }
    };
    let detach: () => void = () => {};
    try {
      detach = relay.attach({
        id: host, key, push,
        end: () => { closed = true; try { res.end(); } catch { /* 이미 닫혔다 */ } },
        info: { app: clip(req.query.app, 40) || undefined, platform: clip(req.query.platform, 20) || undefined },
      });
    } catch (e) {
      push("error", { error: e instanceof Error ? e.message : String(e) });
      closed = true;
      res.end();
      return;
    }
    push("hello", { protocol: BROWSER_PROTOCOL, host });
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* 곧 close 가 온다 */ } }, PING_MS);
    ping.unref?.();
    // ⚠ 해지를 반드시 건다 — 안 걸면 화면을 다시 실을 때마다 죽은 연결이 «화면»으로 남아 명령이 거기로 간다.
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      closed = true;
      clearInterval(ping);
      detach();
    };
    req.on("close", done);
    res.on("close", done);
    res.on("error", done);
  });

  app.post("/api/ui/browser/host/reply", ...mw, (req, res) => {
    const key = keyOf(req, res);
    if (!key) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const host = clip(b.host, 80);
    const id = clip(b.id, 80);
    if (!HOST_ID_RE.test(host) || !id) { res.status(400).json({ error: "host·id 가 필요합니다" }); return; }
    const took = relay.reply(key, host, {
      id, ok: b.ok === true, result: b.result, error: typeof b.error === "string" ? b.error : undefined,
    });
    // 모르는 id 는 이미 시간 초과로 끝난 명령이다 — 화면 쪽 오류가 아니므로 200 으로 받고 taken:false 로만 알린다.
    res.json({ ok: true, taken: took });
  });

  app.post("/api/ui/browser/host/state", ...mw, (req, res) => {
    const key = keyOf(req, res);
    if (!key) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const host = clip(b.host, 80);
    if (!HOST_ID_RE.test(host)) { res.status(400).json({ error: "host 형식이 올바르지 않습니다" }); return; }
    const ok = relay.setState(key, host, {
      active_at: typeof b.active_at === "number" ? b.active_at : undefined,
      focused: typeof b.focused === "boolean" ? b.focused : undefined,
      sessions: Array.isArray(b.sessions) ? b.sessions.map((s) => String(s)) : undefined,
    });
    res.json({ ok });
  });
}
