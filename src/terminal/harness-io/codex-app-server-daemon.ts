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
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AppServerTransport } from "./codex-app-server.js";

/** 포트 범위 — 사용자 서비스 대역을 피해 높은 자리에서 고른다(충돌 시 아래 probe 가 다음 칸으로 민다). */
export const PORT_BASE = 39_000;
export const PORT_SPAN = 2_000;

/** 노드 RPC 한 장에 싣는 원문 상한. base64 로 불어나도 WS 1MB 상한에 여유가 있다. */
export const CODEX_TRANSCRIPT_CHUNK_BYTES = 384 * 1024;

export interface LocalRolloutChunk {
  found: boolean;
  size: number;
  offset: number;
  data: string;
  eof: boolean;
}

const validThreadId = (threadId: string): boolean => /^[A-Za-z0-9-]{8,64}$/.test(threadId);
const rolloutPaths = new Map<string, string>();

/**
 * 이 컴퓨터의 CODEX_HOME 안에서 스레드의 최신 rollout을 찾는다.
 *
 * 셸 glob을 쓰지 않는다. Windows에는 `sh`가 없고, 스레드 id를 경로로 받으면 홈 밖 파일을
 * 읽는 표면이 생기기 때문이다. 날짜 세 단계와 정해진 파일명만 훑는다.
 */
export async function localRolloutPath(
  threadId: string,
  codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
): Promise<string> {
  if (!validThreadId(threadId)) return "";
  const memoKey = `${codexHome}\0${threadId}`;
  const memo = rolloutPaths.get(memoKey);
  if (memo) return memo;
  const root = path.join(codexHome, "sessions");
  let newest = "";
  let newestAt = -1;
  try {
    const years = await fsp.readdir(root, { withFileTypes: true });
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const yearPath = path.join(root, year.name);
      const months = await fsp.readdir(yearPath, { withFileTypes: true }).catch(() => []);
      for (const month of months) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        const monthPath = path.join(yearPath, month.name);
        const days = await fsp.readdir(monthPath, { withFileTypes: true }).catch(() => []);
        for (const day of days) {
          if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
          const dayPath = path.join(monthPath, day.name);
          const files = await fsp.readdir(dayPath, { withFileTypes: true }).catch(() => []);
          for (const file of files) {
            if (!file.isFile() || !file.name.startsWith("rollout-") || !file.name.endsWith(`-${threadId}.jsonl`)) continue;
            const candidate = path.join(dayPath, file.name);
            const st = await fsp.stat(candidate).catch(() => null);
            if (st?.isFile() && st.mtimeMs > newestAt) { newest = candidate; newestAt = st.mtimeMs; }
          }
        }
      }
    }
  } catch { return ""; }
  if (newest) rolloutPaths.set(memoKey, newest);
  return newest;
}

/**
 * 노드의 Codex rollout을 제한된 바이트 범위로 읽는다. 외부에서 받는 것은 스레드 id뿐이고,
 * 실제 경로는 위 함수가 CODEX_HOME 아래에서 계산하므로 임의 파일 읽기로 넓어지지 않는다.
 * len=0은 크기만 묻는 요청이다.
 */
export async function readLocalRolloutChunk(
  threadId: string,
  offsetRaw: number,
  lenRaw: number,
  codexHome?: string,
): Promise<LocalRolloutChunk> {
  const file = await localRolloutPath(threadId, codexHome);
  if (!file) return { found: false, size: 0, offset: 0, data: "", eof: true };
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return { found: false, size: 0, offset: 0, data: "", eof: true };
    const size = st.size;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.min(size, Math.floor(offsetRaw))) : 0;
    const len = Number.isFinite(lenRaw) ? Math.max(0, Math.min(CODEX_TRANSCRIPT_CHUNK_BYTES, Math.floor(lenRaw))) : 0;
    if (len === 0 || offset >= size) return { found: true, size, offset, data: "", eof: offset >= size };
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(len, size - offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return {
        found: true,
        size,
        offset,
        data: buf.subarray(0, bytesRead).toString("base64"),
        eof: offset + bytesRead >= size,
      };
    } finally { await fh.close(); }
  } catch { return { found: false, size: 0, offset: 0, data: "", eof: true }; }
}

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
    // ★ 로그 폴더를 보장한다 — **없으면 리다이렉트가 실패해 nohup 이 아예 안 뜬다.**
    //  `~/.codex` 는 codex 를 한 번이라도 쓴 홈에만 있다(키트가 첫 세션에 config.toml 을 심지만 그건
    //  '보통'이지 계약이 아니다). 갓 만든 멤버 홈에서 실측으로 밟았다(2026-08-26, 매니지드 실박스):
    //    sh: cannot create /home/box_…/.codex/…log: Directory nonexistent
    //  그런데도 아래 `echo started` 가 그대로 나가서 **호출자는 성공으로 읽고** 붙으러 갔다가 실패한다.
    `mkdir -p "$(dirname "${logPath}")" 2>/dev/null || true`,
    `${envPrefix ? envPrefix + " " : ""}nohup codex app-server --listen ws://127.0.0.1:${port} >>"${logPath}" 2>&1 &`,
    // ★ 기동을 **확인해서** 말한다. `&` 는 즉시 0 을 돌려주므로 그것만으로는 아무것도 안 본 것과 같다 —
    //  안 뜬 것을 started 라고 하면 호출자는 붙으러 갔다가 실패하고, 그 시점엔 원인이 이미 사라져 있다.
    //  ⚠ 매니지드에서는 게이트웨이가 이 포트에 **직접 못 닿는다**(컨테이너 loopback) — 확인은 여기서 해야 한다.
    //  실패하면 로그 꼬리를 stderr 로 함께 돌려준다: 그 몇 줄이 유일한 진단이다.
    `i=0; while [ $i -lt 20 ]; do`,
    `  if node -e 'const n=require("net");const s=n.connect(${port},"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' 2>/dev/null; then echo started; exit 0; fi`,
    `  i=$((i+1)); sleep 0.3`,
    `done`,
    `echo "codex app-server 가 포트를 열지 않았습니다" >&2; tail -n 5 "${logPath}" >&2 2>/dev/null; exit 1`,
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
export function spawnDetachedLocal(o: {
  port: number;
  cwd: string;
  logFd: number;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** 테스트 seam. Windows npm 실행 파일(.cmd)은 셸을 거쳐야 한다. */
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
}): Promise<number | undefined> {
  const platform = o.platform ?? process.platform;
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = (o.spawnFn ?? spawn)(o.bin ?? "codex", ["app-server", "--listen", `ws://127.0.0.1:${o.port}`], {
        cwd: o.cwd,
        env: o.env ?? process.env,
        detached: true,
        stdio: ["ignore", o.logFd, o.logFd],
        // npm 이 Windows 에 설치하는 codex 는 codex.cmd 다. CreateProcess 로 직접 띄우면 ENOENT 이므로
        // 이 플랫폼에서만 cmd.exe 를 통한다. 프롬프트는 이 argv 에 들어오지 않는다(고정 인자뿐).
        shell: platform === "win32",
      });
    } catch (e) {
      reject(e);
      return;
    }
    // spawn 오류는 생성자에서 throw 되지 않고 다음 tick 의 `error` 로도 온다. 리스너가 없으면
    // Node 가 그 이벤트를 uncaught 로 올려 **노드 에이전트 전체를 종료**한다(Windows 실측 ENOENT).
    p.once("error", reject);
    p.once("spawn", () => {
      p.unref();
      resolve(p.pid);
    });
  });
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
