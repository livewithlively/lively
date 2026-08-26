// 세션별 codex app-server 를 **게이트웨이 수명에서 떼어낸다** (#2055) — 순수 계산 + 기동/연결.
//
//  ── 왜 (실측 2026-08-26, dev) ──
//  1차 구현은 app-server 를 게이트웨이의 **자식**으로 stdio 로 띄웠다. 그래서 게이트웨이가 재기동되면
//  (dev 는 stage-sync 가 수시로 한다) 그 자식이 같이 죽고 **돌던 턴이 통째로 유실**됐다 —
//  사람 눈에는 "답이 안 온다"로만 보인다(rollout 에 질문만 남고 답이 없다). 실측 타임라인:
//    18:23:46 프롬프트 → app-server 로 전달 · 18:24:38 stage-sync 재기동 · 답 영영 없음.
//  tmux 경로에는 없던 퇴행이다(pane 은 게이트웨이와 수명이 다르다). 그래서 프로세스를 **떼어낸다**.
//
//  ── 어떻게 ──
//  · 전송을 stdio 에서 **WebSocket(loopback)** 으로 바꾼다. `codex app-server --listen ws://127.0.0.1:<포트>` 는
//    실측으로 동작한다(한 연결에서 스레드 여러 개도 확인). `unix://` 는 소켓은 생기는데 initialize 를 보내면
//    **서버가 그냥 연결을 끊는다**(별도 컨트롤 프로토콜로 보인다 — 규명 전까지 안 쓴다).
//  · 프로세스는 detached 로 띄우고 stdio 를 로그파일로 돌린다 — 부모(게이트웨이)가 죽어도 파이프가 없어
//    SIGPIPE·EOF 로 끌려 죽지 않는다.
//  · 재접속은 **포트를 세션 id 에서 결정론적으로 유도**해서 한다(레지스트리 파일이 필요 없다 — 게이트웨이가
//    재기동돼도 같은 세션이면 같은 포트를 다시 계산해 붙는다).
//  · ★ 게이트웨이가 재기동돼도 **서버는 계속 턴을 돌리고 rollout 파일에 답을 쓴다**. 화면의 읽기 경로가
//    그 파일이므로, 클라이언트가 잠깐 끊겨도 답은 도착한다 — 이것이 이 설계의 핵심 이득이다.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import type { AppServerTransport } from "./codex-app-server.js";

/** 포트 범위 — 사용자 서비스 대역을 피해 높은 자리에서 고른다(충돌 시 아래 probe 가 다음 칸으로 민다). */
export const PORT_BASE = 39_000;
export const PORT_SPAN = 2_000;

/**
 * (순수) 세션 id → 기본 포트. 결정론적이라 **레지스트리 없이** 재접속할 수 있다.
 *  같은 세션이면 게이트웨이가 재기동돼도 같은 값이 나온다. 충돌은 호출부가 nth 로 밀어서 푼다.
 */
export function sessionPort(sessionId: string, nth = 0): number {
  const h = createHash("sha256").update(String(sessionId)).digest();
  return PORT_BASE + ((h.readUInt32BE(0) + nth) % PORT_SPAN);
}

/**
 * (순수) 컨테이너 안에서 **detached 로** app-server 를 띄우는 셸 한 줄.
 *  매니지드는 게이트웨이가 그 컨테이너에 프로세스를 직접 못 만든다 — 멤버 exec 중계로 셸을 한 번 돌릴 뿐이라,
 *  그 셸이 끝나도 서버가 남아야 한다(`nohup … &`). 로그는 멤버 홈에 남겨 사후 진단이 가능하게 한다.
 */
export function detachedStartSh(port: number, logPath: string, env: Record<string, string> = {}): string {
  // ★ 세션 신원 env 를 반드시 싣는다 — 훅(work-flag)이 `LIVELY_SESSION_ID` 로 **대화 파일 경로를 게이트웨이에
  //  보고**한다. 그게 없으면 답이 rollout 에 쓰여도 **화면이 그 파일을 못 찾아 대화창이 빈 채로 남는다**
  //  (실측 2026-08-26: 답은 파일에 있는데 사용자에게는 "답이 안 온다"로 보였다).
  //  값은 우리가 만든 것(세션 id·하네스 키)이라 셸 메타문자가 없지만, 그래도 작은따옴표로 감싼다.
  const envPrefix = Object.entries(env).map(([k, v]) => `${k}='${String(v).replace(/'/g, "")}'`).join(" ");
  return [
    `if command -v codex >/dev/null 2>&1; then :; else echo "codex 없음" >&2; exit 127; fi`,
    // 이미 그 포트에 살아 있으면 두 번 띄우지 않는다(두 서버가 같은 스레드를 노리면 writer 충돌이 난다).
    `if node -e 'const n=require("net");const s=n.connect(${port},"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' 2>/dev/null; then echo already; exit 0; fi`,
    `${envPrefix ? envPrefix + " " : ""}nohup codex app-server --listen ws://127.0.0.1:${port} >>"${logPath}" 2>&1 &`,
    `echo started`,
  ].join("\n");
}

/** 그 포트에 이미 누가 듣고 있나(빠른 TCP 노크). 살아 있으면 재기동 없이 붙는다. */
export function portAlive(port: number, host = "127.0.0.1", timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean): void => { try { s.destroy(); } catch { /* */ } resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

/**
 * 로컬(비격리·dev) 기동 — **detached + 로그파일**. 부모가 죽어도 살아남는다.
 *  stdio 를 파이프로 두면 게이트웨이가 죽는 순간 EOF/SIGPIPE 로 자식이 끌려 죽는다(1차 구현의 실패 원인).
 */
export function spawnDetachedLocal(o: { port: number; cwd: string; logFd: number; bin?: string; env?: NodeJS.ProcessEnv }): number | undefined {
  const p = spawn(o.bin ?? "codex", ["app-server", "--listen", `ws://127.0.0.1:${o.port}`], {
    cwd: o.cwd,
    env: o.env ?? process.env,
    detached: true,
    stdio: ["ignore", o.logFd, o.logFd],
  });
  p.unref();
  return p.pid;
}

/** WebSocket 전송 — 끊겨도 **서버는 살아 있다**(그게 이 파일의 존재 이유다). */
export function wsTransport(url: string): AppServerTransport {
  const ws = new WebSocket(url);
  let onLineCb: ((l: string) => void) | null = null;
  let onCloseCb: ((r: string) => void) | null = null;
  const queue: string[] = [];
  ws.onopen = () => { for (const q of queue.splice(0)) ws.send(q); };
  ws.onmessage = (ev: MessageEvent) => {
    // 한 프레임에 여러 줄이 올 수 있다(서버가 붙여 보낼 때) — 줄 단위로 쪼갠다.
    for (const line of String(ev.data).split("\n")) if (line.trim()) onLineCb?.(line);
  };
  ws.onerror = () => { /* close 가 뒤따른다 — 사유는 close 에서 말한다 */ };
  ws.onclose = (ev: CloseEvent) => onCloseCb?.(`app-server 연결 종료(code=${ev?.code ?? "-"})`);
  return {
    send: (line) => { if (ws.readyState === WebSocket.OPEN) ws.send(line); else queue.push(line); },
    onLine: (cb) => { onLineCb = cb; },
    onClose: (cb) => { onCloseCb = cb; },
    // ⚠ close() 는 **연결만** 끊는다. 서버 프로세스는 살아서 턴을 마치고 rollout 에 답을 쓴다.
    //  프로세스까지 내리는 것은 '터미널로 넘기기'(release)의 몫이고, 그건 별도 경로다.
    close: () => { try { ws.close(); } catch { /* 이미 닫힘 */ } },
  };
}

/** 연결이 열릴 때까지(또는 실패까지) 기다린다 — 기동 직후엔 리스너가 아직 없을 수 있다. */
export async function waitPort(port: number, ms = 8000, host = "127.0.0.1"): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await portAlive(port, host)) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}
