// 중앙 박스 — WebSocket ↔ node-pty 브리지. /terminal/ws?session=<id> 업그레이드를 받아
// ticket 쿠키(userId 보유)로 인증 + 세션 소유권 확인 후, node-pty 로 tmux 를 스폰해 브라우저 xterm.js 와 연결.
//
// 기본은 tmux "control mode"(`-CC`) — tmux 가 화면을 그려주는 대신 텍스트 프로토콜(%output/%begin…)로
//  pane 출력을 보내고, 브라우저(xterm.js)가 직접 렌더 + 스크롤백을 소유한다(= iTerm 처럼 휠 스크롤이
//  로컬 스크롤백을 직접 오르내림, resume/재출력이 신선하게 반영). 입력/리사이즈/백필은 클라가 "의도"만
//  보내고 서버가 안전한 tmux 명령(send-keys -H / refresh-client -C / capture-pane)으로 번역한다 —
//  클라가 임의 tmux 명령(kill-server 등)을 주입하지 못하게 명령 구성을 서버에 가둔다.
// TERMINAL_LEGACY_ATTACH=1 이면 옛 방식(plain `tmux attach`, tmux 가 화면 painting + copy-mode 스크롤)으로 폴백.
// ws 종료 = attach 클라만 종료(tmux 세션은 영속). 셸 미경유(argv).
import { WebSocketServer, type WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logger } from "./log.js";
import { TMUX_BIN, canAttach, sessionDir, ensureSessionOpts } from "./terminal-sessions.js";

export type TicketLookup = (cookieHeader?: string) => { userId: string } | null;

const CONTROL_MODE = process.env.TERMINAL_LEGACY_ATTACH !== "1"; // 기본 control mode, =1 이면 plain attach 폴백
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

export function setupPtyUpgrade(server: Server, lookupTicket: TicketLookup): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || "", "http://localhost"); } catch { return; }
    if (url.pathname !== "/terminal/ws") return; // 다른 업그레이드(있다면)는 미관여
    void (async () => {
      const tk = lookupTicket(req.headers.cookie);
      if (!tk) { socket.destroy(); return; }
      const id = url.searchParams.get("session") || "";
      const ok = await canAttach(id, tk.userId).catch(() => false);
      if (!ok) { socket.destroy(); return; }
      await ensureSessionOpts(id).catch(() => { /* 비치명 */ });
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, id));
    })();
  });
}

// 컨트롤 명령 전송 함수 타입. 시작 레이스(아래) 때문에 'term 직접 쓰기'가 아니라 attach 가 주는 버퍼링 send 를 쓴다.
type SendCmd = (line: string) => void;

// ── 클라 의도 → 안전한 tmux 명령(순수 함수, 테스트 대상). d/c/r/n 은 모두 서버가 검증·인코딩 →
//  클라가 임의 tmux 명령(kill-server 등)을 주입할 수 없다(입력은 hex 로만 인코딩되어 개행/공백 인젝션 불가).
// 입력 d: UTF-8 바이트로 hex 인코딩해 `send-keys -H`(과도하게 긴 명령줄 방지 위해 512B 청크 → 명령 배열).
export function inputToSendKeys(d: string): string[] {
  const bytes = Buffer.from(d, "utf8");
  const cmds: string[] = [];
  for (let i = 0; i < bytes.length; i += 512) {
    const hex = bytes.subarray(i, i + 512).toString("hex").replace(/(..)/g, "$1 ").trim();
    if (hex) cmds.push(`send-keys -H ${hex}`);
  }
  return cmds;
}
// 리사이즈: control-mode 클라 크기(= tmux 창 크기 결정). 1..2000 클램프.
export function resizeToRefresh(c: number, r: number): string {
  const cc = Math.min(Math.max(1, Math.trunc(c)), 2000), rr = Math.min(Math.max(1, Math.trunc(r)), 2000);
  return `refresh-client -C ${cc}x${rr}`;
}
// 백필: -p stdout, -e 색/속성 이스케이프 보존, -q 조용히, -N 줄 끝 공백 보존(= 배경색으로 줄 끝까지
//  채운 셀을 유지 — Claude 프롬프트의 회색 배경 채움이 재접속 복원 때 잘리지 않게). -S -n ~ -E -: 히스토리~가시영역.
export function captureCmd(n: number): string {
  const nn = Math.min(Math.max(0, Math.trunc(Number(n) || 0)), 100000);
  return `capture-pane -peqN -S -${nn} -E -`;
}

function handleControlMsg(send: SendCmd, msg: { t?: string; d?: unknown; c?: unknown; r?: unknown; n?: unknown }): void {
  if (msg.t === "i" && typeof msg.d === "string") {
    for (const cmd of inputToSendKeys(msg.d)) send(cmd);
  } else if (msg.t === "r" && Number.isInteger(msg.c) && Number.isInteger(msg.r)) {
    send(resizeToRefresh(msg.c as number, msg.r as number));
  } else if (msg.t === "cap") {
    send(captureCmd(Number(msg.n)));
  }
}

// 폴백(legacy plain attach): 옛 동작 — 입력 raw write, 리사이즈 pty.resize.
function handleLegacyMsg(term: IPty, msg: { t?: string; d?: unknown; c?: unknown; r?: unknown }): void {
  if (msg.t === "i" && typeof msg.d === "string") term.write(msg.d);
  else if (msg.t === "r" && Number.isInteger(msg.c) && Number.isInteger(msg.r)) {
    try { term.resize(Math.max(1, msg.c as number), Math.max(1, msg.r as number)); } catch { /* race on close */ }
  }
}

function attach(ws: WebSocket, id: string): void {
  let term: IPty | undefined;
  sessionDir(id)
    .then((cwd) => {
      // 게이트웨이가 launchd/nohup 로 떠 LANG 이 없으면 tmux 클라이언트가 utf8=0 으로 잡혀 한글(멀티바이트)
      //  렌더가 깨진다. UTF-8 로케일을 강제(env) + `tmux -u`(로케일과 무관하게 UTF-8 출력)로 이중 보장.
      const env = { ...process.env } as Record<string, string>;
      if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) {
        env.LANG = "en_US.UTF-8";
        env.LC_CTYPE = "en_US.UTF-8";
      }
      // control mode: `-CC`(echo off) + `-u`(UTF-8). 폴백: plain attach.
      const args = CONTROL_MODE ? ["-u", "-CC", "attach", "-t", id] : ["-u", "attach", "-t", id];
      // encoding:null → onData 가 Buffer(raw 바이트). 바이너리 프레임으로 그대로 relay하고 서버는 UTF-8 디코드를
      //  하지 않는다 — tmux 는 멀티바이트 UTF-8 문자를 %output 알림 경계에서 쪼갤 수 있어, 서버가 문자열로 디코드하면
      //  그 자리가 깨진다(�). 디코드/재조립은 클라가 바이트 레벨로 한다(terminal.js makeControl).
      term = ptySpawn(TMUX_BIN, args, { name: "xterm-256color", cols: 80, rows: 24, cwd, env, encoding: null });
      // 시작 레이스 방지: tmux -CC 가 tty 를 no-echo 로 잡기 전에 명령을 쓰면 pty 가 그 명령을 '에코백'하고,
      //  그 에코가 control 도입자(\x1bP1000p)보다 먼저 도착해 클라가 raw 로 오인 → 명령 텍스트가 화면에 뜬다.
      //  → tmux 의 '첫 출력'(= control 모드 진입·no-echo 완료)이 오기 전까지 명령을 큐에 모았다가 그때 flush.
      let ready = false;
      const cmdQueue: string[] = [];
      const sendCmd: SendCmd = (line) => {
        if (!ready) { cmdQueue.push(line); return; }
        try { term?.write(line + "\n"); } catch { /* socket closed */ }
      };
      term.onData((d) => {
        if (!ready) { ready = true; for (const q of cmdQueue) { try { term?.write(q + "\n"); } catch { /* noop */ } } cmdQueue.length = 0; }
        try { ws.send(d as unknown as Buffer); } catch { /* socket closed */ }
      });
      term.onExit(() => { try { ws.close(); } catch { /* already closed */ } });
      ws.on("message", (raw) => {
        let msg: { t?: string; d?: unknown; c?: unknown; r?: unknown; n?: unknown };
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!term) return;
        if (CONTROL_MODE) handleControlMsg(sendCmd, msg);
        else handleLegacyMsg(term, msg);
      });
      const cleanup = () => { try { term?.kill(); } catch { /* already gone */ } };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    })
    .catch((err) => { logger.warn({ err, id }, "pty attach 실패"); try { ws.close(); } catch { /* noop */ } });
}
