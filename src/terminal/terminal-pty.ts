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
import { spawn as ptySpawn } from "node-pty";
import { spawn as cpSpawn, execFile as cpExecFile } from "node:child_process";   // psmux 파이프 attach 백엔드 + CLI 입력(#1541)
import { promisify } from "node:util";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logger } from "../log.js";
import os from "node:os";
import { TMUX_BIN, canAttach, ensureSessionOpts, sessionGone } from "./terminal-sessions.js";
import { tmuxExecArgv } from "./tmux-exec.js";
import { resolveTenantFromHeaders, withTenant } from "../org/tenant-context.js";
import { nodeCanAttach, nodeRelayAttach } from "../node/registry.js";

// attach 가 실제로 쓰는 소켓 표면 — 게이트웨이 로컬은 실 WebSocket, 노드 에이전트(#869)는 게이트웨이행
//  단일 WSS 위의 '채널 어댑터'가 이 인터페이스를 구현해 같은 attach 로직(tmux -CC · 큐잉 · 정리)을 재사용한다.
export interface AttachSocket {
  send(data: Buffer | string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error" | "pong", listener: (...args: any[]) => void): void;
}

export type TicketLookup = (cookieHeader?: string) => { userId: string } | null;

const CONTROL_MODE = process.env.TERMINAL_LEGACY_ATTACH !== "1"; // 기본 control mode, =1 이면 plain attach 폴백
const execFileP = promisify(cpExecFile);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

// ── attach PTY 수명 관리(#687 PTY 누수) ──
// 배경: attach 는 브라우저 WS 하나당 node-pty(`tmux -CC attach`) 1개 = **PTY 1개**를 뜬다. 이건 term.kill() 로만
//  회수되고, kill 은 ws 의 'close'/'error' 에서만 돈다. 그런데 (1) 노트북 절전·네트워크 끊김·프록시 타임아웃으로
//  TCP 가 '반쯤 열린' 채 사라지면 서버 ws 는 'close' 를 영영 안 받아 PTY 가 좀비로 남고(프론트는 자동 재연결하며
//  새 PTY 를 또 뜬다 → 한 세션에 뷰어 수백), (2) 게이트웨이가 재시작되면 node-pty 자식들이 init(PPID 1)로
//  재부모화돼 살아남아 PTY 를 영구 점유한다. 실측(고객사 A 박스): 세션 ~30개에 좀비 attach 3164개 → PTY 고갈.
// 대응: ⓐ WS ping/pong heartbeat 로 죽은 소켓을 주기적으로 terminate(→ close → kill), ⓑ 종료 시 살아있는 PTY 일괄
//  kill(고아 방지), ⓒ 시작 시 이전 인스턴스가 남긴 고아 attach 회수.
// 후속(2026-07-27) — ⓐ~ⓒ 로 안 잡히는 축이 둘 더 있었다. 둘 다 '프로세스 개수'만 보면 안 보이고, 플랫폼별로 갈린다:
//  (3) **SIGHUP 무효(리눅스에서 발현)**: node-pty kill() 의 기본 시그널은 SIGHUP 인데 tmux control-mode(-CC)
//      클라이언트가 이를 무시한다(tmux 3.2a 실측 — SIGHUP=생존 / SIGTERM·SIGKILL=사망). 즉 ⓐ 는 죽은 소켓을
//      '검출'까지만 하고 '회수'에서 실패했다(고객사 A 박스: 라이브 WS 5개인데 attach 339개 생존). node-pty 는 kill
//      실패를 삼키므로 "보냈다=죽었다"로 가정할 수 없다 → cleanup 이 SIGTERM 을 **명시**한다(아래).
//  (4) **네이티브 fd 누수(macOS 에서 발현)**: node-pty 1.1.0 의 pty_posix_spawn(`#if __APPLE__`)이 부모가 연
//      slave fd 와 low_fds[0] 을 닫지 않아 attach 1회당 fd 가 2개씩 영구 잔류했다(dev 맥미니: ptmx 476 / revoked
//      462 → kern.tty.ptmx_max 511 소진 → ssh 조차 PTY 할당 실패). 자식은 정상 종료하므로 고아 프로세스가 0이라
//      ⓒ 에 안 걸리고, JS 로는 회수도 불가하다(kill·destroy 모두 무효 — 잔류 fd 2개 동일 실측). upstream 이
//      close(slave) + low_fds 정리 off-by-one 을 고친 **1.2.0-beta.10+** 로 올려 해결한다(package.json).
const HEARTBEAT_MS = 30_000;              // 이 주기로 ping — 직전 주기에 pong 이 없던 소켓은 죽은 것으로 보고 terminate.
// ── attach 백엔드 (#1541) ─────────────────────────────────────────────────────
// tmux 는 `attach` 에 tty 를 요구하므로 node-pty 로 띄운다. 그런데 **Windows 노드의 멀티플렉서(psmux)는
//  정반대**다 — PTY 위에서 control mode 가 **아무것도 내보내지 않는다**(실측: 같은 node-pty 로 cmd.exe·
//  powershell·psmux plain attach 는 모두 데이터가 흐르는데 `-CC` 만 0바이트). 반면 **파이프로 붙이면 정상**이고
//  (`%begin`/`%end`/`%output` 수신 확인), psmux 는 attach 에 tty 를 요구하지도 않는다.
//  → 그 조합에서만 파이프로 붙인다. 인터페이스를 node-pty 와 같게 맞춰 **아래 attach 로직은 한 벌로** 유지한다.
//  ⚠ resize 가 갈린다: PTY 는 창 크기를 커널에 알려야 하지만, control mode 는 크기를 `refresh-client -C w,h`
//   명령으로 전달한다(resizeToRefresh). 그래서 파이프 백엔드의 resize 는 no-op 이 맞다 — 실제 통지는 이미
//   control 스트림으로 나간다.
export interface AttachTerm {
  onData(cb: (d: Buffer) => void): void;
  onExit(cb: () => void): void;
  write(s: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
/** psmux(윈도우 네이티브 tmux 구현)인가 — 파일명으로 판정한다(경로·확장자 무관). */
export const isPsmuxBin = (bin: string): boolean => /(^|[\\/])psmux(\.exe)?$/i.test(String(bin || ""));

function spawnAttachTerm(bin: string, args: string[], env: Record<string, string>): AttachTerm {
  if (!isPsmuxBin(bin)) {
    // encoding:null → onData 가 Buffer(raw 바이트). 아래 relay 가 디코드하지 않는 이유는 attachSession 주석 참조.
    const t = ptySpawn(bin, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: os.homedir(), env, encoding: null });
    return {
      onData: (cb) => { t.onData((d) => cb(d as unknown as Buffer)); },
      onExit: (cb) => { t.onExit(() => cb()); },
      write: (s) => t.write(s),
      resize: (c, r) => { try { t.resize(c, r); } catch { /* 이미 종료 */ } },
      kill: (sig) => t.kill(sig),
    };
  }
  const c = cpSpawn(bin, args, { cwd: os.homedir(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let exited = false;
  const fire = new Set<() => void>();
  const done = (): void => { if (exited) return; exited = true; for (const f of fire) f(); };
  c.on("exit", done);
  c.on("error", done);
  return {
    onData: (cb) => { c.stdout?.on("data", (d: Buffer) => cb(d)); },
    onExit: (cb) => { fire.add(cb); if (exited) cb(); },
    write: (s) => { try { c.stdin?.write(s); } catch { /* 파이프 닫힘 */ } },
    resize: () => { /* control mode 가 refresh-client 로 통지한다 — 파이프엔 창 크기 개념이 없다 */ },
    kill: (sig) => { try { c.kill((sig as NodeJS.Signals) || "SIGTERM"); } catch { /* 이미 종료 */ } },
  };
}

const liveTerms = new Set<AttachTerm>();  // 이 인스턴스가 띄운 살아있는 attach 클라 — 종료 훅이 일괄 kill 한다.
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
    // ★★ 업그레이드는 Express 미들웨어를 **안 탄다** — 테넌트 컨텍스트(tenant-middleware)가 여기엔 없다.
    //  요청별 테넌시 배포에서 컨텍스트 없이 canAttach 를 부르면 tmux 중계·DB 조회가 "컨텍스트 밖"으로
    //  죽고, 그 실패가 4403 으로 접혀 **소유자 본인이 무한 '연결 확인중'** 이 된다(실측 2026-08-18).
    //  같은 헤더·같은 비밀로 여기서 직접 연다. 거절 사유면 소켓을 닫는다(비밀 불일치 = 배선 문제).
    const tr = resolveTenantFromHeaders(req.headers as Record<string, string | string[] | undefined>, process.env);
    if (!tr.ok && tr.reason !== "disabled") { socket.destroy(); return; }
    // registry(#1750 후속) — 셀프호스트 다중 워크스페이스. 브라우저 WS URL 은 커스텀 헤더를 못 실으므로
    //  **세션 정본(gw_session_map)** 으로 소속을 되찾는다: 맵에 있으면 그 워크스페이스, 없으면 primary(종전).
    //  이게 없으면 secondary 세션 attach 가 primary 컨텍스트로 돌아 기본 tmux 소켓을 뒤지고 4410(가짜
    //  '세션 없음')이 된다 — 세션은 lvly-<slug> 소켓에 살아 있는데.
    const registrySessionCtx = async (): Promise<{ id: string; slug: string } | null> => {
      if (tr.ok || (process.env.LIVELY_TENANCY_MODE || "").trim().toLowerCase() !== "registry") return null;
      const sid = url.searchParams.get("session") || "";
      if (!sid) return null;
      const { workspaceForSession } = await import("../org/tenancy/registry.js");
      const w = await workspaceForSession(sid).catch(() => null);
      return w ? { id: w.id, slug: w.slug } : null;
    };
    void (async () => {
      const regCtx = await registrySessionCtx();
      const inTenant = <T>(fn: () => T): T => (tr.ok ? withTenant(tr.tenant, fn) : regCtx ? withTenant(regCtx, fn) : fn());
      return inTenant(() => (async () => {
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
      wss.handleUpgrade(req, socket, head, (ws) => inTenant(() => attach(ws, id)));
      })());
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
// ── psmux 입력 경로 (#1541) — 같은 의도를 **다른 표면**으로 보낸다 ─────────────────
// psmux 는 `send-keys -H`(hex)를 **받지 않는다**. 공식 `docs/tmux_args_reference.md` 가 send-keys 에 대해
//  "Not accepted: `-c`, `-F`, `-H`, `-K`, `-M`" 로 `-H` 를 명시 배제하고, 실측도 일치한다
//  (`-H 41 42 43` → 화면에 `41 42 43` 리터럴. CLI·control 양쪽).
// 대안은 tmux 표준 키 표기 `0xNN` 인데 **인코딩 단위가 바이트가 아니라 코드포인트**여야 한다:
//   UTF-8 바이트(`한`=ed 95 9c) → `íU\` 로 깨짐 ❌ / 코드포인트(`한`=0xd55c) → `한` ✅ (BMP 밖 이모지도 정상)
// ⚠ 그리고 psmux 는 **CLI 파서와 control 파서가 갈려 있다** — 같은 `0xNN` 이 CLI 로는 한글·이모지까지 되는데
//  control mode stdin 으로는 ASCII(2자리)만 된다(4자리 hex 를 못 받는다). 10-1 의 "PTY 에서 -CC 만 침묵"과
//  같은 계열이다. → **출력은 control mode(파이프) 유지, 입력만 CLI 호출**로 갈라 보낸다.
// 인젝션 안전성은 그대로 승계된다 — 값이 전부 `0x…` 토큰이고 execFile argv(셸 미경유)라
//  `;kill-server;` 를 쳐도 서버가 살고 화면엔 리터럴로만 도달한다(실측). `-l`(리터럴)로 바꿔 보안 경계를
//  새로 그릴 필요 **없다**.
const SENDKEYS_CHUNK = 512;    // 한 호출에 싣는 키 토큰 수 — 토큰 최대 8자라 ~4.6KB(Windows 명령줄 한도 32767자 대비 여유)
const INPUT_DEBOUNCE_MS = 16;  // 키 배치 창(≈1프레임) — 매 키마다 프로세스를 띄우지 않게 묶는다
/**
 * 입력 d → `psmux send-keys` **argv 배열들**(순수 함수). 셸을 안 거치므로 argv 요소는 인용 불요.
 *
 * ⚠ 토큰 폭은 **2자리 이상**으로 고정한다. 실측에서 통과가 확인된 형태는 `0x0d`·ASCII 자연폭(2자리)·
 *  `0xd55c`·`0x1f680` 뿐이고 1자리(`0x3`)는 미검증이다 — Ctrl-C(0x03)·Tab(0x09) 이 안 먹으면 터미널을
 *  통째로 못 쓴다. 검증된 폭 안에 머무는 게 맞다.
 */
export function inputToSendKeysArgv(id: string, d: string): string[][] {
  const toks: string[] = [];
  for (const ch of d) toks.push("0x" + (ch.codePointAt(0) as number).toString(16).padStart(2, "0")); // for..of = 코드포인트 단위(서로게이트 쌍 보존)
  const out: string[][] = [];
  for (let i = 0; i < toks.length; i += SENDKEYS_CHUNK) out.push(["send-keys", "-t", id, ...toks.slice(i, i + SENDKEYS_CHUNK)]);
  return out;
}
/**
 * psmux 입력 펌프 — 배치(디바운스) + **순차 실행**(순서 보장).
 *
 * 입력을 CLI 로 가르면 축이 둘로 갈린다: **입력은 비동기(프로세스 spawn)** · **명령은 동기(stdin write)**.
 * 그대로 두면 순서가 뒤집힌다 — 방금 친 글자가 pane 에 닿기 전에 `capture-pane` 이 나가 **그 글자가 빠진
 * 화면**을 백필하는 식(재접속마다 마지막 입력이 사라져 보인다). 그래서 **입력과 명령을 하나의 직렬 체인**에
 * 태운다. 체인이 곧 순서다.
 *
 * 배치가 필요한 이유는 비용이다 — 키 하나에 프로세스 하나면 타이핑이 그대로 프로세스 폭풍이 된다.
 * 16ms(≈1프레임) 창으로 묶고, 붙여넣기처럼 큰 입력은 청크로 갈라지되 같은 체인이라 글자가 섞이지 않는다.
 */
export interface InputPump {
  /** 클라 입력 — 디바운스 창으로 묶어 순차 전송. */
  sendInput(d: string): void;
  /** control 명령 — 대기 입력을 **먼저** 내보낸 뒤 같은 체인에 태운다(입력↔명령 순서 보존). */
  sendCmd(line: string): void;
  /** 연결 종료 — 대기 입력 폐기 + 타이머 해제. 이후 아무것도 보내지 않는다. */
  close(): void;
  /** 체인이 빌 때까지. 순서·순차 계약을 실제로 재는 관측점(테스트·종료 대기). */
  idle(): Promise<void>;
}
export function createInputPump(
  id: string,
  run: (argv: string[]) => Promise<unknown>,
  write: (line: string) => void,
  debounceMs: number = INPUT_DEBOUNCE_MS,
): InputPump {
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let pending = "";
  let timer: NodeJS.Timeout | null = null;
  const enqueue = (fn: () => Promise<unknown> | unknown): void => {
    chain = chain.then(() => (closed ? undefined : fn())).then(() => undefined, (err) => {
      // 전송 1건 실패가 세션을 끊지 않는다 — 다음 입력은 계속 흐른다(체인은 이어진다).
      logger.warn({ err: (err as Error)?.message ?? String(err), id }, "psmux 입력 전송 실패(비치명)");
    });
  };
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    const d = pending; pending = "";
    // ⚠ 지연의 정체(#1541 실측): psmux 입력은 배치마다 **CLI 프로세스를 새로 띄운다**. Windows 에서 프로세스
    //  생성은 수십 ms 라, 중앙 세션(제어 스트림에 바로 쓰기)과 나란히 두면 타이핑이 눈에 띄게 늦다.
    //  psmux 의 control-mode stdin 은 **2자리 토큰(0xNN)** 은 받아준다 → 코드포인트가 0xff 이하인 배치
    //  (영문·숫자·기호·제어키 = 타이핑의 대부분)는 프로세스 없이 스트림으로 보낸다. 한글처럼 3자리 이상
    //  토큰이 섞인 배치만 종전대로 CLI 로 간다(정확성 우선 — 여기서 잘못 보내면 글자가 깨진다).
    for (const argv of inputToSendKeysArgv(id, d)) {
      const streamable = argv.every((a) => !a.startsWith("0x") || a.length === 4);
      if (streamable) enqueue(() => write(argv.join(" ")));
      else enqueue(() => run(argv));
    }
  };
  return {
    sendInput(d) {
      if (!d || closed) return;
      pending += d;
      if (!timer) timer = setTimeout(flush, debounceMs);
    },
    sendCmd(line) { flush(); enqueue(() => write(line)); },
    close() { closed = true; if (timer) { clearTimeout(timer); timer = null; } pending = ""; },
    idle() { return chain; },
  };
}

// 리사이즈: control-mode 클라 크기(= tmux 창 크기 결정). 1..2000 클램프.
// ⚠ 구분자가 백엔드마다 다르다(#1541 실측). tmux 는 `WxH`·`W,H` 를 **둘 다** 받지만(3.6a 확인),
//  **psmux 는 콤마만** 받고 `WxH` 는 **오류도 없이 조용히 무시**한다(psmux 3.3.7 실측:
//  `-C 120x40` → 창 그대로 120x30 / `-C 120,40` → 120x40). 조용한 무시라 종료코드·%error 로는 안 잡히고,
//  증상은 "웹터미널 크기가 브라우저를 안 따라간다"로만 나타난다.
//  콤마는 tmux 3.2 에서 도입됐다 — 우리는 tmux 하한을 못 박지 않았으므로(배포판이 주는 걸 쓴다: Debian 11=3.1c)
//  tmux 경로는 **손대지 않고** psmux 일 때만 콤마로 보낸다. 한쪽으로 통일하는 건 하한을 정한 뒤에 할 일이다.
export function resizeToRefresh(c: number, r: number, sep: "x" | "," = "x"): string {
  const cc = Math.min(Math.max(1, Math.trunc(c)), 2000), rr = Math.min(Math.max(1, Math.trunc(r)), 2000);
  return `refresh-client -C ${cc}${sep}${rr}`;
}
// 백필: -p stdout, -e 색/속성 이스케이프 보존, -q 조용히, -N 줄 끝 공백 보존(= 배경색으로 줄 끝까지
//  채운 셀을 유지 — Claude 프롬프트의 회색 배경 채움이 재접속 복원 때 잘리지 않게). -S -n ~ -E -: 히스토리~가시영역.
//  -J(#1117 버그B): 화면폭에 랩된 줄을 '논리적 한 줄'로 이어붙여 준다. 없으면 클라가 랩된 각 행을 별개 줄로 써서
//  xterm 이 isWrapped 를 못 매기고 → 백필된 문단을 드래그 복사하면 화면폭마다 가짜 개행이 박힌 텍스트가 클립보드에
//  들어간다(다른 창에 붙여넣으면 여러 줄로 깨짐 — 붙여넣기 오염 제보의 원인 축). -J 면 긴 줄을 클라 xterm 이 다시
//  랩하며 isWrapped 를 매겨 선택 복사가 원문 그대로 나온다(폭은 refresh-client -C 로 이미 클라와 일치).
export function captureCmd(n: number): string {
  const nn = Math.min(Math.max(0, Math.trunc(Number(n) || 0)), 100000);
  return `capture-pane -peqJN -S -${nn} -E -`;
}
// pane 실상태 질의 — capture-pane 백필은 '화면 텍스트'만 담고 DECSET(alt-screen 1049h·마우스모드 1003h)·커서위치는
//  담지 못한다. 그래서 클라(xterm)는 앱이 지금 alt-screen 인지·마우스모드인지·커서가 어디인지 '추측'할 수밖에 없어,
//  재접속 갭이나 다중 클라에서 앱의 mouse-off(1003l)·alt-off(1049l)를 놓치면 마우스가 stuck(이동마다 셸에 키 주입)
//  되거나 화면/커서가 어긋난다. tmux 는 pane 의 진짜 상태를 포맷 변수로 안다 → 마커 한 줄로 회수해 클라가 추측 대신
//  '동기화'하게 한다. 마커 프리픽스는 클라 control 파서가 '캡처 백필 블록'과 '상태 블록'을 구분하는 신호(화면 좌상단이
//  이 문자열로 시작할 확률=사실상 0). 출력 예: `__LTSTATE__ alt=1 any=1 btn=0 std=0 sgr=1 cx=39 cy=0 cmd=zsh`.
// cmd(#{pane_current_command}) 는 '지금 그 pane 의 foreground 프로세스' — 마우스 flag 가 **stale 인지** 가리는 유일한
//  단서다. tmux 는 앱이 켠 마우스모드를 앱이 죽어도 **영원히 안 지운다**(실측: 하드킬·미reset 후 셸로 돌아와도
//  mouse_any_flag=1 이 clear/명령실행에도 유지). 그래서 flag 만 믿고 클라 마우스모드를 되살리면, 앱이 없는 셸
//  프롬프트에 마우스 이동마다 리포트가 주입돼 garbage 가 쏟아지고 **새로고침해도 안 풀린다**(붙을 때마다 되살리므로).
//  셸은 마우스 트래킹을 켜는 일이 없다 → foreground 가 셸이면 그 flag 는 죽은 앱의 잔재다(클라가 이걸로 게이팅).
//  ⚠ cmd 는 반드시 **마지막** 토큰: 프로세스명에 공백이 있어도 앞 항목 파싱을 깨지 않는다.
export const STATE_MARKER = "__LTSTATE__";
// mux= 는 **우리가 아는 사실**을 그대로 실어 보내는 리터럴이다(멀티플렉서가 그대로 되돌려준다).
//  왜 필요한가(실측 #1541): psmux 는 alt-screen 팬에 `capture-pane` 을 걸면 **제어 스트림 전체가 멈춘다**
//  (`%begin` 만 오고 `%end` 도, 그 뒤 어떤 `%output` 도 오지 않는다 — 실측 9초 무응답). 그러면 화면 복원은
//  물론이고 앱의 재그리기·리사이즈 응답까지 통째로 막혀 웹터미널이 하얀 화면으로 굳는다.
//  클라가 '이 백엔드에는 캡처를 걸면 안 된다'를 알아야 그 명령을 처음부터 보내지 않을 수 있다.
export function stateCmd(psmux = false): string {
  return `display-message -p '${STATE_MARKER} mux=${psmux ? "psmux" : "tmux"} alt=#{alternate_on} any=#{mouse_any_flag} btn=#{mouse_button_flag} std=#{mouse_standard_flag} sgr=#{mouse_sgr_flag} cx=#{cursor_x} cy=#{cursor_y} cmd=#{pane_current_command}'`;
}
// stale 마우스모드 복구 — tmux 가 아는 pane 상태 자체를 고친다(클라 게이팅은 이 클라의 garbage 만 막을 뿐,
//  tmux 의 잘못된 진실은 그대로라 다른 클라·실 터미널 attach 는 계속 flood 를 받는다).
//  pane 의 모드는 '그 pane 의 프로그램이 낸 출력'으로만 바뀐다 → tmux 명령으로는 손댈 수 없고, pane 의 tty 에
//  DECRST 를 직접 써야 한다. run-shell 이 #{pane_tty} 를 확장해주므로 제어스트림 한 줄로 가능(실측 확인:
//  any=1 sgr=1 → any=0 sgr=0, 화면 오염 0 — 비출력 시퀀스라 렌더에 아무것도 안 남는다).
//  ⚠ 클라 입력이 섞이지 않는 **고정 상수** 명령이다(주입면 없음). alt-screen(1049)은 건드리지 않는다 — 그건
//   화면 내용을 바꾸는 되돌리기 어려운 조작이라, 클라 표시 동기화(applyPaneState)로만 다룬다.
export function mouseResetCmd(): string {
  return `run-shell -b 'printf "\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1005l\\033[?1006l\\033[?1015l" > #{pane_tty}'`;
}

// psmux: 주면 **그 백엔드용으로** 두 군데가 갈린다(#1541) — ① 입력은 control 스트림이 아니라 그 싱크(CLI)로,
//  ② 리사이즈 구분자는 콤마. 둘 다 psmux 라는 **하나의 사실**에서 나오므로 인자 하나로 묶는다.
//  나머지(백필·상태·복구)는 두 경우 모두 control 스트림 그대로 — 응답(%begin/%end 블록)이 그 스트림으로
//  되돌아오므로 옮길 수 없다.
export function handleControlMsg(send: SendCmd, msg: { t?: string; d?: unknown; c?: unknown; r?: unknown; n?: unknown; st?: unknown }, psmux?: { sendInput(d: string): void }): void {
  if (msg.t === "i" && typeof msg.d === "string") {
    if (psmux) psmux.sendInput(msg.d);
    else for (const cmd of inputToSendKeys(msg.d)) send(cmd);
  } else if (msg.t === "r" && Number.isInteger(msg.c) && Number.isInteger(msg.r)) {
    send(resizeToRefresh(msg.c as number, msg.r as number, psmux ? "," : "x"));
  } else if (msg.t === "cap") {
    // 상태 블록은 '클라가 요청할 때만'(msg.st) 백필 직전에 보낸다. 옛 클라(캐시된 terminal.js)는 st 를 안 실어
    //  보내므로 상태 블록을 못 받고 → 마커(__LTSTATE__)를 화면에 출력하는 회귀가 없다(신·구 클라 버전 스큐 안전).
    if (msg.st) send(stateCmd(!!psmux));   // pane 실상태(alt/mouse/cursor/백엔드) → 클라가 동기화 후 렌더
    send(captureCmd(Number(msg.n)));
  } else if (msg.t === "st") {
    send(stateCmd(!!psmux));           // 상태만 동기화(재접속 시 — 스크롤백 truncate 없이 마우스/alt stuck·커서 어긋남 해소). 옛 클라는 st 를 안 보냄.
  } else if (msg.t === "mr") {
    // 클라가 'flag 는 마우스 ON 인데 foreground 는 셸' = stale 을 관측했을 때만 온다 → tmux 쪽 진실을 복구하고,
    //  고쳐진 상태를 곧바로 되돌려 클라가 확인(관측 없이 여는 경로 없음).
    send(mouseResetCmd());
    send(stateCmd(!!psmux));
  }
}

// 폴백(legacy plain attach): 옛 동작 — 입력 raw write, 리사이즈 pty.resize.
function handleLegacyMsg(term: AttachTerm, msg: { t?: string; d?: unknown; c?: unknown; r?: unknown }): void {
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
  let term: AttachTerm | undefined;
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
      // ⚠ 백엔드는 멀티플렉서가 고른다(#1541) — tmux=node-pty(tty 필수) · psmux=파이프(PTY 에선 -CC 가 침묵).
      // encoding:null → onData 가 Buffer(raw 바이트). 바이너리 프레임으로 그대로 relay하고 서버는 UTF-8 디코드를
      //  하지 않는다 — tmux 는 멀티바이트 UTF-8 문자를 %output 알림 경계에서 쪼갤 수 있어, 서버가 문자열로 디코드하면
      //  그 자리가 깨진다(�). 디코드/재조립은 클라가 바이트 레벨로 한다(terminal.js makeControl).
      // attach 실행 seam(#1437) — 기본은 로컬 tmux(설정 없으면 종전과 완전히 동일).
      //  ★ 명령형 tmux 는 tmux-exec 의 seam 이 덮지만 **attach 는 그 경로가 아니다**(장수 PTY 다).
      //   게이트웨이와 tmux 서버가 다른 곳에 있는 배포를 위해 여기도 갈아끼울 수 있어야 한다.
      //   계약은 같다: 지정한 프로그램에 tmux argv 를 그대로 이어 붙인다.
      const relay = tmuxExecArgv();
      const [abin, ...aprefix] = relay.length ? relay : [TMUX_BIN];
      term = spawnAttachTerm(abin!, [...aprefix, ...args], env);
      liveTerms.add(term); // 종료 훅이 회수할 수 있게 추적(#687 고아 방지)
      spawnFailStreak.delete(id); // 정상 스폰 → 실패 스트릭 리셋(#869)
      // 시작 레이스 방지: tmux -CC 가 tty 를 no-echo 로 잡기 전에 명령을 쓰면 pty 가 그 명령을 '에코백'하고,
      //  그 에코가 control 도입자(\x1bP1000p)보다 먼저 도착해 클라가 raw 로 오인 → 명령 텍스트가 화면에 뜬다.
      //  → tmux 의 '첫 출력'(= control 모드 진입·no-echo 완료)이 오기 전까지 명령을 큐에 모았다가 그때 flush.
      let ready = false;
      const cmdQueue: string[] = [];
      const writeCmd: SendCmd = (line) => {
        if (!ready) { cmdQueue.push(line); return; }
        try { term?.write(line + "\n"); } catch { /* socket closed */ }
      };
      // 입력 경로는 멀티플렉서가 가른다(#1541) — tmux 는 control 스트림 그대로, psmux 는 CLI 펌프.
      const pump = isPsmuxBin(TMUX_BIN)
        ? createInputPump(id, (argv) => execFileP(TMUX_BIN, argv, { timeout: 5000, env, windowsHide: true }), writeCmd)
        : null;
      const sendCmd: SendCmd = pump ? (line) => pump.sendCmd(line) : writeCmd;
      term.onData((d) => {
        if (!ready) { ready = true; for (const q of cmdQueue) { try { term?.write(q + "\n"); } catch { /* noop */ } } cmdQueue.length = 0; }
        try { ws.send(d as unknown as Buffer); } catch { /* socket closed */ }
      });
      term.onExit(() => { if (term) liveTerms.delete(term); try { ws.close(); } catch { /* already closed */ } });
      ws.on("message", (raw) => {
        let msg: { t?: string; d?: unknown; c?: unknown; r?: unknown; n?: unknown };
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!term) return;
        if (CONTROL_MODE) handleControlMsg(sendCmd, msg, pump ?? undefined);
        else handleLegacyMsg(term, msg);
      });
      // 회수는 **SIGTERM 명시** — 기본 SIGHUP 은 tmux -CC 클라가 무시해 좀비로 남는다(위 (3)). 여기가 연결 단위
      //  회수의 유일한 관문이라(탭 종료·heartbeat terminate·에러 전부 이 경로) 시그널 하나가 곧 누수 여부다.
      const cleanup = () => {
        pump?.close();                        // 대기 입력 폐기 + 타이머 해제(#1541 — 닫힌 세션에 유령 입력·타이머 잔류 금지)
        if (term) liveTerms.delete(term);
        try { term?.kill("SIGTERM"); } catch { /* already gone */ }
      };
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
/**
 * 이 인스턴스가 **지금 붙들고 있는** attach PTY 수. PTY 경보(box-watch)가 '시스템 PTY 사용량 vs 우리 몫'의
 * 갭을 보여줄 때 쓴다 — 갭이 크면 누수, 작으면 실사용이라 받는 사람이 조치를 바로 고를 수 있다.
 */
export function liveAttachCount(): number {
  return liveTerms.size;
}

// 우리 웹터미널 attach 클라이언트의 프로세스 시그니처 — 스캔하는 쪽(관측)과 죽이는 쪽(회수)이 **같은 판정**을
//  써야 한다. 어긋나면 "안 세는 걸 0 으로 보여주거나(관측 사각지대)", "안 죽일 걸 죽인다(오탐 kill)".
const ATTACH_SIG = /tmux\b.*\battach\b.*\s-t\s+box-[a-z0-9-]+/;

/**
 * ps `etime`("[[dd-]hh:]mm:ss") → 초. 파싱 불가면 null.
 *
 * 리눅스 procps 의 `etimes`(초 단위)가 편하지만 **macOS ps 엔 없다** — 두 플랫폼 공통인 `etime` 을 파싱한다.
 */
export function parseEtimeSec(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [, d, h, mi, sec] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(sec);
}

export interface AttachProcs {
  /** 현 인스턴스의 **자식**인 살아있는 attach 클라 수 — 장부(liveTerms)와의 차이가 곧 회수 실패분. */
  children: number;
  /** 부모를 잃은(PPID=1) attach 클라 수 — 이전 인스턴스 잔재(#687 버그B 축). 자식이 아니라 `children` 엔 안 잡힌다. */
  orphans: number;
  /** 자식 중 **가장 오래된** attach 의 나이(초). 하나도 없거나 못 재면 null. */
  oldestChildSec: number | null;
}

/**
 * `ps -eo pid=,ppid=,etime=,args=` 출력 → attach 프로세스 요약. **순수 함수**(ps 를 띄우지 않아 테스트 가능).
 *
 * 세 값이 각각 왜 필요한가:
 * - `children` — `liveAttachCount()`(장부)와 비교하면 누수량이 그대로 나온다. `cleanup` 은 kill 성공 여부와
 *   **무관하게** 장부에서 먼저 지우므로, 시그널을 씹고 살아남은 놈은 **장부에 없고 프로세스로만 남는다**.
 * - `orphans` — 자식 게이트(`ppid===process.pid`)만 세면 고아는 **원리적으로 안 잡힌다**. 게이트웨이가
 *   크래시·SIGKILL 로 죽어 남은 잔재가 정확히 그 축(#687 버그B)이라, 안 세면 "0" 으로 보여 사람을 안심시킨다.
 * - `oldestChildSec` — 누수 0 의 **신뢰도**를 재는 값. 가동시간과 나란히 놓아야 "정말 안 샌다"와 "방금 재시작해
 *   아직 안 쌓였다"가 갈린다(가동 21h 인데 최고령 attach 3h37m = 그 사이 것들이 회수됐다는 직접 증거).
 *
 * ps 가 `etime` 컬럼을 안 주는 환경도 견딘다 — 3번째 토큰이 etime 으로 안 읽히면 거기부터 args 로 본다.
 */
export function summarizeAttachProcs(stdout: string, selfPid: number): AttachProcs {
  let children = 0, orphans = 0;
  let oldestChildSec: number | null = null;
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    const ageSec = parseEtimeSec(m[3]);
    const cmd = ageSec === null ? `${m[3]} ${m[4]}` : m[4]; // etime 없는 ps → 3번째 토큰이 이미 args 의 첫 조각
    if (pid === selfPid || !ATTACH_SIG.test(cmd)) continue;
    if (ppid === selfPid) {
      children++;
      if (ageSec !== null && (oldestChildSec === null || ageSec > oldestChildSec)) oldestChildSec = ageSec;
    } else if (ppid === 1) {
      orphans++;
    }
  }
  return { children, orphans, oldestChildSec };
}

/** 위 요약의 실측 판(ps 1회). 잴 수 없으면 null — 못 잰다고 경보하지 않는다(디스크·PTY 와 같은 규약). */
export async function scanAttachProcs(): Promise<AttachProcs | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const { stdout } = await execFileP("ps", ["-eo", "pid=,ppid=,etime=,args="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    return summarizeAttachProcs(stdout, process.pid);
  } catch {
    return null;
  }
}

/** 프로세스 축 누수 지표의 관측값(자식 수만). `scanAttachProcs()` 의 얇은 래퍼 — 기존 호출부 호환용. */
export async function countAttachChildren(): Promise<number | null> {
  const s = await scanAttachProcs();
  return s ? s.children : null;
}

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
      if (!ATTACH_SIG.test(cmd)) continue;                                // 우리 웹터미널 attach 시그니처만(관측과 동일 판정)
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
