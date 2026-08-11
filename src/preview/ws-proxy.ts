// 프리뷰 환경의 **WebSocket 중계** (#1541) — `/preview/<id>/…` 로 오는 업그레이드를 그 환경으로 넘긴다.
//
// ⚠ 왜 routes.ts 가 아니라 여기인가 — 업그레이드는 **Express 를 통과하지 않는다.** `server.on("upgrade")`
//  로만 오고, 라우트 핸들러(app.all)는 절대 보지 못한다. 그래서 프리뷰는 HTTP 는 완벽히 프록시하면서
//  WS 는 **아무도 응답하지 않아** 클라이언트가 핸드셰이크 타임아웃까지 매달렸다. 실측(#1541):
//    {"err":"Opening handshake has timed out","msg":"노드 WSS 오류"}   ← 5초마다 무한 재시도
//  게이트웨이 로그엔 아무것도 안 남는다(요청이 어떤 핸들러에도 안 닿으므로). 그래서 진단이 오래 걸렸다.
//
// 이 파일이 닫는 것: 프리뷰 환경에서 **웹터미널(/terminal/ws)과 노드 채널(/node/ws)이 동작한다**.
//  둘 다 WS 라, 이게 없으면 프리뷰로는 터미널·노드 관련 변경을 **원리적으로 검증할 수 없었다**.
//
// 인증은 얹지 않는다 — HTTP 프록시와 같은 경계다(#1169): throwaway 는 자식 게이트웨이가 스스로 인증하고
//  (노드 토큰·세션 쿠키), 우리가 앞단에서 한 번 더 막으면 노드 토큰 흐름이 통째로 끊긴다.
import type { Server, IncomingMessage } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import { getPreviewEnv } from "./preview-envs.js";
import { portOf } from "./preview-proc.js";
import { logger } from "../log.js";

const PREVIEW_WS_RE = new RegExp("^/preview/([a-z0-9][a-z0-9_-]{0,63})/(.*)$");

/** `/preview/<id>/<rest>` 분해 — 순수. 매치 안 되면 null(우리 소관 아님 → 다른 핸들러에 양보). */
export function parsePreviewWsPath(rawUrl: string): { id: string; rest: string; search: string } | null {
  const qi = rawUrl.indexOf("?");
  const pathname = qi >= 0 ? rawUrl.slice(0, qi) : rawUrl;
  const search = qi >= 0 ? rawUrl.slice(qi) : "";
  const m = PREVIEW_WS_RE.exec(pathname);
  if (!m) return null;
  return { id: m[1], rest: m[2].replace(/^\/+/, ""), search };
}

/** 업스트림 101 응답을 **원문 그대로** 클라이언트에 되쓴다 — 순수.
 *  ⚠ Sec-WebSocket-Accept 는 클라이언트 키에서 파생된 값이라 한 글자도 바꾸면 브라우저가 연결을 거부한다.
 *   rawHeaders 를 쓰는 이유: 헤더 이름의 대소문자·중복(Set-Cookie 여러 줄)을 보존해야 한다. */
export function rebuildUpgradeResponse(statusCode: number, statusMessage: string, rawHeaders: string[]): string {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage || "Switching Protocols"}`];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  return lines.join("\r\n") + "\r\n\r\n";
}

function bail(socket: Duplex, status: string, why: string): void {
  // 소켓을 그냥 destroy 하면 클라이언트는 **핸드셰이크 타임아웃**(수십 초)까지 매달린다 — 그게 이 버그의 증상이었다.
  //  HTTP 응답을 한 줄이라도 돌려주면 즉시 실패하고 그 이유가 클라이언트 로그에 남는다.
  try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${why}`); } catch { /* 이미 끊김 */ }
  try { socket.destroy(); } catch { /* noop */ }
}

export function setupPreviewWsUpgrade(server: Server): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const hit = parsePreviewWsPath(req.url || "");
    if (!hit) return;                                  // 프리뷰 경로가 아니다 — /terminal/ws·/node/ws 핸들러의 몫
    void (async () => {
      let p;
      try { p = await getPreviewEnv(hit.id); } catch { bail(socket, "500 Internal Server Error", "프리뷰 조회 실패"); return; }
      if (!p) { bail(socket, "404 Not Found", `프리뷰 환경 없음: ${hit.id}`); return; }
      if (!p.enabled || p.status === "stopped") { bail(socket, "409 Conflict", "이 미리보기는 정지 상태입니다 — 관리 화면에서 ‘띄우기’를 눌러 주세요."); return; }
      if (p.status === "preparing") { bail(socket, "503 Service Unavailable", "미리보기를 준비하는 중입니다 — 잠시 후 다시 연결됩니다."); return; }

      // shared-proxy·stage 는 **자체 백엔드가 없다** — HTTP 에선 /api 를 본체로 307 하는 자리다(routes.ts).
      //  WS 는 리다이렉트가 없으므로, 접두사만 벗겨 **같은 서버에 업그레이드를 다시 흘린다**. 그러면 본체의
      //  /terminal/ws·/node/ws 핸들러가 평소처럼 받는다(그때 pathname 이 /preview/ 로 시작하지 않으니 재귀 없다).
      if (p.kind === "stage" || p.backing_mode === "shared-proxy") {
        req.url = "/" + hit.rest + hit.search;
        server.emit("upgrade", req, socket, head);
        return;
      }

      let base: string;
      if (p.backing_mode === "existing-ref") {
        if (!p.backing_ref) { bail(socket, "409 Conflict", "existing-ref 대상(backing_ref)이 없습니다."); return; }
        base = p.backing_ref;
      } else if (p.backing_mode === "throwaway") {
        const port = p.port || portOf(hit.id);
        if (!port) { bail(socket, "409 Conflict", "throwaway 백엔드가 아직 기동되지 않았습니다 — 관리탭에서 띄우세요."); return; }
        base = "http://127.0.0.1:" + port;
      } else { bail(socket, "500 Internal Server Error", "알 수 없는 backing_mode: " + p.backing_mode); return; }

      let target: URL;
      try { target = new URL(hit.rest + hit.search, base.endsWith("/") ? base : base + "/"); } catch { bail(socket, "502 Bad Gateway", "프록시 대상 URL 오류"); return; }
      if (target.protocol !== "http:") { bail(socket, "502 Bad Gateway", "프리뷰 WS 프록시는 http 대상만 지원합니다(현재)"); return; }

      // 헤더는 **그대로** 넘긴다 — Sec-WebSocket-Key/Version/Protocol·Authorization(노드 토큰)·Cookie(세션)가
      //  전부 여기 실려 있고, 하나라도 빠지면 자식이 거부한다. host 만 업스트림으로 바꾼다.
      const headers = { ...req.headers, host: target.host };
      const up = http.request({
        hostname: target.hostname, port: target.port || 80,
        path: target.pathname + target.search, method: req.method || "GET", headers,
      });
      let settled = false;
      up.on("upgrade", (upRes, upSocket, upHead) => {
        settled = true;
        try {
          socket.write(rebuildUpgradeResponse(upRes.statusCode || 101, upRes.statusMessage || "", upRes.rawHeaders));
          if (upHead?.length) socket.write(upHead);     // 101 직후에 이미 도착한 첫 프레임 조각
          if (head?.length) upSocket.write(head);       // 반대 방향도 마찬가지
        } catch { try { upSocket.destroy(); socket.destroy(); } catch { /* noop */ } return; }
        // 양방향 바이트 릴레이 — 프레임을 해석하지 않는다(멀티바이트가 경계에서 쪼개져도 무손실).
        socket.on("error", () => upSocket.destroy());
        upSocket.on("error", () => socket.destroy());
        socket.pipe(upSocket);
        upSocket.pipe(socket);
      });
      // 업그레이드가 아니라 **평범한 응답**이 오면(자식이 그 경로를 모름 → 404 등) 그 상태를 그대로 전달한다.
      //  여기서 조용히 끊으면 클라이언트는 또 타임아웃까지 기다린다 — 바로 그 실패 모양을 없애는 게 이 파일의 목적이다.
      up.on("response", (r) => {
        settled = true;
        bail(socket, `${r.statusCode} ${r.statusMessage || ""}`.trim(), `프리뷰 백엔드가 업그레이드하지 않았습니다(HTTP ${r.statusCode}) — 경로: /${hit.rest}`);
        r.resume();
      });
      up.on("error", (err) => {
        if (settled) return;
        // ⚠ 두 실패를 **구분해서** 말한다(실측: 구분 없이 "연결 실패" 로 뭉갰다가 '자식이 인증 거부한 것'을
        //  '백엔드가 죽은 것'으로 오독할 뻔했다). 자식은 인증 실패 시 소켓을 그냥 destroy 하므로,
        //  프록시 입장에선 ECONNRESET/socket hang up 으로 온다 — 그건 백엔드가 살아 있다는 증거다.
        const code = (err as NodeJS.ErrnoException)?.code;
        const refused = code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENOTFOUND";
        logger.warn({ err, id: hit.id, rest: hit.rest }, refused ? "프리뷰 WS 프록시 — 백엔드 미기동" : "프리뷰 WS 프록시 — 백엔드가 업그레이드 전에 끊음");
        bail(socket, "502 Bad Gateway", refused
          ? "프리뷰 백엔드 연결 실패 — 프로세스가 떠 있는지 확인하세요. (게이트웨이가 재시작되면 프리뷰 백엔드도 함께 내려갑니다 — 다시 띄우세요.)"
          : `프리뷰 백엔드가 업그레이드 전에 연결을 끊었습니다 — 인증 실패(토큰·쿠키)일 가능성이 큽니다. 경로: /${hit.rest}`);
      });
      // 자식이 **아무 응답도 안 하는** 경로(그 경로에 업그레이드 핸들러가 없음)에서 소켓을 영원히 붙잡지 않는다.
      //  침묵이 이 버그의 정체였다 — 프록시가 그 침묵을 그대로 물려주면 우리가 고친 의미가 없다.
      up.setTimeout(30_000, () => {
        if (settled) return;
        bail(socket, "504 Gateway Timeout", `프리뷰 백엔드가 업그레이드에 응답하지 않았습니다 — 그 경로에 WS 핸들러가 없을 수 있습니다. 경로: /${hit.rest}`);
        try { up.destroy(); } catch { /* noop */ }
      });
      socket.on("error", () => { try { up.destroy(); } catch { /* noop */ } });
      up.end();
    })();
  });
}
