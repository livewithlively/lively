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
import os from "node:os";
import { TMUX_BIN, canAttach, ensureSessionOpts, sessionGone } from "./terminal-sessions.js";
import { nodeCanAttach, nodeRelayAttach } from "./node/registry.js";

// attach 가 실제로 쓰는 소켓 표면 — 게이트웨이 로컬은 실 WebSocket, 노드 에이전트(#869)는 게이트웨이행
//  단일 WSS 위의 '채널 어댑터'가 이 인터페이스를 구현해 같은 attach 로직(tmux -CC · 큐잉 · 정리)을 재사용한다.
export interface AttachSocket {
  send(data: Buffer | string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error" | "pong", listener: (...args: any[]) => void): void;
}

export type TicketLookup = (cookieHeader?: string) => { userId: string } | null;

const CONTROL_MODE = process.env.TERMINAL_LEGACY_ATTACH !== "1"; // 기본 control mode, =1 이면 plain attach 폴백
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

// ── attach PTY 수명 관리(#687 PTY 누수) ──
// 배경: attach 는 브라우저 WS 하나당 node-pty(`tmux -CC attach`) 1개 = **PTY 1개**를 뜬다. 이건 term.kill() 로만
//  회수되고, kill 은 ws 의 'close'/'error' 에서만 돈다. 그런데 (1) 노트북 절전·네트워크 끊김·프록시 타임아웃으로
//  TCP 가 '반쯤 열린' 채 사라지면 서버 ws 는 'close' 를 영영 안 받아 PTY 가 좀비로 남고(프론트는 자동 재연결하며
//  새 PTY 를 또 뜬다 → 한 세션에 뷰어 수백), (2) 게이트웨이가 재시작되면 node-pty 자식들이 init(PPID 1)로
//  재부모화돼 살아남아 PTY 를 영구 점유한다. 실측(어니스트 박스): 세션 ~30개에 좀비 attach 3164개 → PTY 고갈.
// 대응: ⓐ WS ping/pong heartbeat 로 죽은 소켓을 주기적으로 terminate(→ close → kill), ⓑ 종료 시 살아있는 PTY 일괄
//  kill(고아 방지), ⓒ 시작 시 이전 인스턴스가 남긴 고아 attach 회수.
const HEARTBEAT_MS = 30_000;              // 이 주기로 ping — 직전 주기에 pong 이 없던 소켓은 죽은 것으로 보고 terminate.
const liveTerms = new Set<IPty>();        // 이 인스턴스가 띄운 살아있는 attach node-pty — 종료 훅이 일괄 kill 한다.
// 스폰 실패 폭주 차단(#869) — node-pty spawn 이 반복 실패하면(예: 노드에서 fd 고갈 EMFILE) 매 실패가 pty fd 를 새게 해
//  가속 붕괴한다(실측: 노드 에이전트 fd 1543개, 10K 실패). 세션별 최근 연속 실패를 세어 임계 초과 시 **스폰 자체를 건너뛰고**
//  즉시 닫는다 — 할당을 안 하니 누수 원천 차단(정상 스폰 1회로 스트릭 리셋). 브라우저 재연결은 하되 pty 는 안 뜬다.
const spawnFailStreak = new Map<string, { n: number; at: number }>();
const SPAWN_FAIL_WINDOW_MS = 60_000, SPAWN_FAIL_MAX = 8, SPAWN_COOLDOWN_MS = 30_000;
type LiveWS = WebSocket & { isAlive?: boolean };
let heartbeat: NodeJS.Timeout | null = null;

export function setupPtyUpgrade(server: Server, lookupTicket: TicketLookup): void {
  startHeartbeat();                     // 죽은 attach 소켓 주기 회수(#687)
  void reapOrphanAttachClients();       // 이전 인스턴스가 남긴 고아 attach 회수(#687) — best-effort·비동기
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || "", "http://localhost"); } catch { return; }
    if (url.pathname !== "/terminal/ws") return; // 다른 업그레이드(있다면)는 미관여
    void (async () => {
      const tk = lookupTicket(req.headers.cookie);
      if (!tk) { socket.destroy(); return; }
      const id = url.searchParams.get("session") || "";
      // 노드 세션(#869) — ?node=<id> 면 그 노드의 아웃바운드 채널로 릴레이한다. 정책(가시성)은 여기(게이트웨이)서
      //  판정하고 노드는 기계적으로 attach 만 실행(F7). 거부 사유는 로컬과 같은 코드 체계(4410/4403)+4462(노드 오프라인).
      const nodeId = url.searchParams.get("node") || "";
      if (nodeId) {
        const verdict = await nodeCanAttach(nodeId, id, tk.userId);
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (!verdict.ok) {
            logger.info({ nodeId, id, userId: tk.userId, code: verdict.code }, "ws 노드 attach 거부");
            try { ws.close(verdict.code, verdict.reason); } catch { /* noop */ }
            return;
          }
          nodeRelayAttach(nodeId, id, ws);
        });
        return;
      }
      const ok = await canAttach(id, tk.userId).catch(() => false);
      if (!ok) {
        // 거부를 조용히 끊으면(socket.destroy) 클라가 영원히 재연결한다 → WS 핸드셰이크만 완료한 뒤 '이유가 담긴 코드'로
        //  닫아 terminal.js 가 사용자에게 정확한 문구를 띄우게 한다. 이유는 둘이고 클라 동작이 갈린다(#835):
        //   4410 session-gone — tmux 가 '그런 세션 없다'고 확답 → 세션이 진짜 끝남 → 클라는 재연결을 멈추고 '종료됨'을 명시.
        //   4403 no-access    — 권한 없음, 또는 판정 불가(tmux 과부하·타임아웃 = #687 의 '가짜 4403') → 클라는 몇 번 더 재시도.
        //  판정 불가를 gone 으로 넘기지 않는 게 핵심 — 살아있는 세션을 '종료됨'으로 오인하는 건 재연결 반복보다 나쁘다.
        const gone = await sessionGone(id).catch(() => false);
        logger.info({ id, userId: tk.userId, gone }, gone ? "ws attach 거부(세션이 종료됨)" : "ws attach 거부(접근권 없음 또는 세션-프로젝트 불일치)");
        wss.handleUpgrade(req, socket, head, (ws) => {
          try { ws.close(gone ? 4410 : 4403, gone ? "session-gone" : "no-access"); } catch { /* noop */ }
        });
        return;
      }
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
// pane 실상태 질의 — capture-pane 백필은 '화면 텍스트'만 담고 DECSET(alt-screen 1049h·마우스모드 1003h)·커서위치는
//  담지 못한다. 그래서 클라(xterm)는 앱이 지금 alt-screen 인지·마우스모드인지·커서가 어디인지 '추측'할 수밖에 없어,
//  재접속 갭이나 다중 클라에서 앱의 mouse-off(1003l)·alt-off(1049l)를 놓치면 마우스가 stuck(이동마다 셸에 키 주입)
//  되거나 화면/커서가 어긋난다. tmux 는 pane 의 진짜 상태를 포맷 변수로 안다 → 마커 한 줄로 회수해 클라가 추측 대신
//  '동기화'하게 한다. 마커 프리픽스는 클라 control 파서가 '캡처 백필 블록'과 '상태 블록'을 구분하는 신호(화면 좌상단이
//  이 문자열로 시작할 확률=사실상 0). 출력 예: `__LTSTATE__ alt=1 any=1 btn=0 std=0 sgr=1 cx=39 cy=0`.
export const STATE_MARKER = "__LTSTATE__";
export function stateCmd(): string {
  return `display-message -p '${STATE_MARKER} alt=#{alternate_on} any=#{mouse_any_flag} btn=#{mouse_button_flag} std=#{mouse_standard_flag} sgr=#{mouse_sgr_flag} cx=#{cursor_x} cy=#{cursor_y}'`;
}

export function handleControlMsg(send: SendCmd, msg: { t?: string; d?: unknown; c?: unknown; r?: unknown; n?: unknown; st?: unknown }): void {
  if (msg.t === "i" && typeof msg.d === "string") {
    for (const cmd of inputToSendKeys(msg.d)) send(cmd);
  } else if (msg.t === "r" && Number.isInteger(msg.c) && Number.isInteger(msg.r)) {
    send(resizeToRefresh(msg.c as number, msg.r as number));
  } else if (msg.t === "cap") {
    // 상태 블록은 '클라가 요청할 때만'(msg.st) 백필 직전에 보낸다. 옛 클라(캐시된 terminal.js)는 st 를 안 실어
    //  보내므로 상태 블록을 못 받고 → 마커(__LTSTATE__)를 화면에 출력하는 회귀가 없다(신·구 클라 버전 스큐 안전).
    if (msg.st) send(stateCmd());      // pane 실상태(alt/mouse/cursor) → 클라가 동기화 후 렌더
    send(captureCmd(Number(msg.n)));
  } else if (msg.t === "st") {
    send(stateCmd());                  // 상태만 동기화(재접속 시 — 스크롤백 truncate 없이 마우스/alt stuck·커서 어긋남 해소). 옛 클라는 st 를 안 보냄.
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
  attachSession(ws as unknown as AttachSocket, id);
}

// attach 본체 — 게이트웨이 로컬(WebSocket)과 노드 에이전트(채널 어댑터 #869)가 공유한다.
export function attachSession(ws: AttachSocket, id: string): void {
  // 스폰 실패 폭주 차단(#869) — 이 세션 attach 가 최근 연속 실패했으면(예: node-pty 가 이 OS 에서 spawn 불가 = spawn-helper
  //  비호환) 스폰을 건너뛰고 즉시 닫는다. pty 할당 자체를 안 하므로 fd 누수가 원천 차단(정상 스폰 1회로 스트릭 리셋).
  const sf = spawnFailStreak.get(id);
  if (sf && sf.n >= SPAWN_FAIL_MAX && Date.now() - sf.at < SPAWN_COOLDOWN_MS) {
    logger.warn({ id, fails: sf.n }, "attach 스폰 반복 실패 — 쿨다운 스킵(fd 누수·핫루프 차단)");
    try { ws.close(4403, "attach-throttled"); } catch { /* noop */ }
    return;
  }
  let term: IPty | undefined;
  // heartbeat(#687): 새 소켓은 살아있음으로 시작하고, 브라우저가 자동 응답하는 pong 을 받을 때마다 생존 표시.
  //  ping 은 WS 프로토콜 제어프레임이라 tmux 데이터와 무관 — 프론트 코드 변경 불요(브라우저가 투명하게 pong).
  //  (노드 어댑터는 pong 이 안 와 isAlive 가 안 갱신되지만, 노드 채널 생존은 노드 WSS 자체 heartbeat 가 담당.)
  (ws as { isAlive?: boolean }).isAlive = true;
  ws.on("pong", () => { (ws as { isAlive?: boolean }).isAlive = true; });
  // attach 는 tmux **클라이언트**일 뿐 — 그 cwd 는 세션 pane 에 영향 없다. 세션 작업디렉터리(격리 시 멤버 700 홈)로
  //  chdir 하면 게이트웨이가 못 들어가 'chdir(2) failed: Permission denied' 가 반복된다(격리 개인폴더 attach 버그 #524).
  //  게이트웨이가 늘 접근 가능한 서버 홈을 쓴다.
  Promise.resolve()
    .then(() => {
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
      term = ptySpawn(TMUX_BIN, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: os.homedir(), env, encoding: null });
      liveTerms.add(term); // 종료 훅이 회수할 수 있게 추적(#687 고아 방지)
      spawnFailStreak.delete(id); // 정상 스폰 → 실패 스트릭 리셋(#869)
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
      term.onExit(() => { if (term) liveTerms.delete(term); try { ws.close(); } catch { /* already closed */ } });
      ws.on("message", (raw) => {
        let msg: { t?: string; d?: unknown; c?: unknown; r?: unknown; n?: unknown };
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!term) return;
        if (CONTROL_MODE) handleControlMsg(sendCmd, msg);
        else handleLegacyMsg(term, msg);
      });
      const cleanup = () => { if (term) liveTerms.delete(term); try { term?.kill(); } catch { /* already gone */ } };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    })
    .catch((err) => {
      // 실패 스트릭 증가(#869) — 임계 초과 시 위 서킷브레이커가 다음 attach 스폰을 건너뛴다(fd 누수·핫루프 상한).
      const now = Date.now();
      const s = spawnFailStreak.get(id);
      if (s && now - s.at < SPAWN_FAIL_WINDOW_MS) { s.n++; s.at = now; } else spawnFailStreak.set(id, { n: 1, at: now });
      logger.warn({ err, id, fails: spawnFailStreak.get(id)?.n }, "pty attach 실패");
      try { ws.close(); } catch { /* noop */ }
    });
}

// WS liveness heartbeat(#687) — 반쯤 끊긴 attach 소켓을 주기적으로 걸러 terminate 한다. terminate 는 'close' 를
//  발생시켜 기존 cleanup(term.kill)이 돌게 하므로 PTY 가 정상 회수된다(=탭 정상 종료와 동일 경로). 게이트웨이가
//  프로세스 정상 종료하는 걸 막지 않도록 unref. 멱등(중복 호출 무시).
function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<LiveWS>) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* noop */ } continue; } // 직전 주기에 pong 없음 = 죽음
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
}

// 게이트웨이 종료(SIGTERM 재배포·SIGINT·크래시) 시 이 인스턴스의 attach node-pty 를 전부 kill 한다(#687). 안 죽이면
//  자식이 init(PPID 1)로 재부모화돼 PTY 를 영구 점유(관측된 고아 3천 개의 원인). SIGKILL — 종료 경로라 유예 불요,
//  tmux '클라이언트'만 죽고 세션/서버는 영속(재접속 시 다시 attach). index.ts 의 시그널 핸들러가 호출한다.
export function killAttachedPtys(): void {
  for (const t of liveTerms) { try { t.kill("SIGKILL"); } catch { /* noop */ } }
  liveTerms.clear();
}

// 시작 시 1회(#687) — 이전 게이트웨이 인스턴스가 남긴 '고아 attach 클라이언트'를 회수해 누적된 PTY 를 즉시 해제한다.
//  대상 판정(3중 게이트, 오탐 0 지향): (1) PPID===1(원부모 사망=고아 — 살아있는 부모 있는 건 절대 안 건드림. 현재
//  인스턴스가 방금 띄운 attach 는 우리 자식이라 PPID≠1 → 매칭 안 됨), (2) 우리 웹터미널 attach 시그니처(tmux …
//  attach … -t box-…), (3) 우리 uid 소유일 때만 kill 성공(타 uid 는 EPERM 로 skip). ps 는 리눅스·macOS 공통 포맷.
async function reapOrphanAttachClients(): Promise<void> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const { stdout } = await execFileP("ps", ["-eo", "pid=,ppid=,args="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    const victims: number[] = [];
    for (const line of stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]), ppid = Number(m[2]), cmd = m[3];
      if (ppid !== 1 || pid === process.pid) continue;                    // 고아만 — 살아있는 부모가 있으면 스킵
      if (!/tmux\b.*\battach\b.*\s-t\s+box-[a-z0-9-]+/.test(cmd)) continue; // 우리 웹터미널 attach 시그니처만
      victims.push(pid);
    }
    if (!victims.length) return;
    // ⚠ 페이싱(#687 후속): 수천 개를 한꺼번에 죽이면 tmux 서버가 동시 클라 해제로 순간 과부하되고, 그 사이 재접속
    //  클라의 canAttach(tmux show-options)가 5s 타임아웃→가짜 4403(입장거부)로 오인될 수 있다(대량 백로그 청소 시 실측).
    //  배치로 나눠 짧은 간격을 둬 tmux 부하를 분산한다(정상 운영 시 victims≈0 이라 즉시 끝남). 프론트도 4403 재시도로 이중방어.
    const BATCH = 50, GAP_MS = 150;
    let reaped = 0;
    for (let i = 0; i < victims.length; i += BATCH) {
      for (const pid of victims.slice(i, i + BATCH)) {
        try { process.kill(pid, "SIGKILL"); reaped++; } catch { /* 우리 소유 아님(EPERM) 등 — skip */ }
      }
      if (i + BATCH < victims.length) await new Promise((r) => setTimeout(r, GAP_MS));
    }
    logger.info({ reaped, victims: victims.length }, "고아 attach 클라이언트 회수(#687 페이싱 배치)");
  } catch (e) { logger.warn({ err: (e as Error)?.message ?? String(e) }, "고아 attach 회수 실패(비치명)"); }
}
