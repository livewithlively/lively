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
import { EXECUTION_SESSION_ID_RE } from "../org/auth/agent-identity.js";
import { publishNotify } from "../v6/notify-bus.js";
import { hereSlug } from "../v6/notify-scope.js";
import { browserRelay, relayKey, HOST_ID_RE, BROWSER_PROTOCOL, APP_PRINCIPAL_REFUSAL, isAppPrincipal, type BrowserRelay } from "./relay.js";

/** keepalive 주석 주기 — 프록시·로드밸런서가 조용한 연결을 끊는 것을 막는다(알림 스트림과 같은 값). */
const PING_MS = 25_000;

const clip = (v: unknown, max: number): string => String(v ?? "").slice(0, max);
/** 화면(web/v2/browser-host.ts)이 스트림·답·상태 요청마다 싣는 머리글 — 쿠키 세션 화면이 붙는 문(#5470). 값은 "1". */
export const BROWSER_HOST_HEADER = "x-lively-browser-host";

/**
 * 화면 쪽 요청이 실어야 할 자격 표시가 있는가 — 토큰 머리글, 또는 화면 표시 머리글(쿠키 세션 화면, #5470).
 *  keyOf 와 index.ts 의 답 경로 앞단(본문 4MB 파싱 전 거름)이 **같은 이 함수**를 쓴다 — 두 자리가 따로 놀아
 *  답만 토큰 전용으로 남았던 것이 #5470 2차 사고다(명령은 받고 답이 401 → 앱 화면 전체가 로그인 게이트로 튕김).
 */
export function hostCredentialPresent(headers: Record<string, unknown>): boolean {
  return /^Bearer\s+\S/i.test(String(headers.authorization || "")) || String(headers[BROWSER_HOST_HEADER] || "") === "1";
}
let revealSeq = 0;

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
   *  ⚠ 쿠키만 실린 요청은 받지 않는다 — 쿠키(SameSite=Lax)는 사람이 연 **다른 페이지의 최상위 이동**에도 실려서,
   *   그 길로 «답하지 않는 화면» 을 붙이면 AI 명령이 그리로 가 시간 초과만 난다(#4993 격리 리뷰).
   *  받는 것은 둘이다: ① 토큰 머리글(Authorization: Bearer) ② 화면 표시 머리글(BROWSER_HOST_HEADER).
   *   ②는 #5430 계정 로그인(앱 창이 CP 입장권 → 세션 쿠키로 워크스페이스에 들어간다 · 토큰이 없다) 화면을 위한 것이다.
   *   최상위 이동·링크·폼은 사용자 정의 머리글을 실을 수 없고, 다른 출처의 fetch 가 싣으면 사전 요청(CORS)을 거쳐야 하는데
   *   이 경로는 허용하지 않는다 — 그래서 ②가 붙은 요청은 «우리 화면의 스크립트가 보낸 것» 이고, 위 격리가 막던 길은 그대로 막힌다(#5470).
   */
  const keyOf = (req: express.Request, res: express.Response): string | null => {
    if (!hostCredentialPresent(req.headers)) {
      res.status(401).json({ error: "토큰 머리글(Authorization: Bearer) 또는 화면 표시 머리글로만 연결할 수 있습니다" });
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

  /**
   * 브라우저 호스트와 셸이 다른 창이어도 해당 세션의 웹 칸을 연다.
   * 브라우저 명령의 성공 여부와는 독립인 UI 힌트라 구독자가 없어도 성공으로 받는다.
   */
  app.post("/api/ui/browser/host/reveal", ...mw, (req, res) => {
    const key = keyOf(req, res);
    if (!key) return;
    const u = userOf(req)!; // keyOf 가 사람 신원과 userId 를 이미 확인했다.
    const b = (req.body ?? {}) as Record<string, unknown>;
    const session = clip(b.session, 80);
    const tabNo = typeof b.tab === "number" ? b.tab : (typeof b.tab === "string" && /^\d+$/.test(b.tab) ? Number(b.tab) : NaN);
    if (!EXECUTION_SESSION_ID_RE.test(session) || !Number.isSafeInteger(tabNo) || tabNo < 1 || tabNo > 999) {
      res.status(400).json({ error: "올바른 session·tab 이 필요합니다" });
      return;
    }
    const ts = Date.now();
    const delivered = publishNotify({ ws: hereSlug(), member: u.userId }, {
      type: "browser", kind: "reveal", session, tab: String(tabNo),
      key: `b:${session}:${tabNo}:${ts}:${++revealSeq}`, ts,
    });
    res.json({ ok: true, delivered });
  });
}
