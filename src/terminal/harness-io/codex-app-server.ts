// Codex App Server 클라이언트 (#2055) — 대화창이 codex 와 **구조화된 프로토콜**로 말한다.
//
//  ── 왜 ──
//  종전 codex 대화창은 ⓐ 읽기 = rollout jsonl 파일 tail ⓑ 쓰기 = tmux send-keys 였다. ⓐ는 형식이 바뀌면 조용히 빈 화면이 되고,
//  ⓑ는 로그인·대화상자에 걸린 세션에서 **글자가 조용히 사라진다**. App Server 는 그 둘을 JSON-RPC 로 바꾸고,
//  덤으로 **승인을 우리에게 물어본다** — 정책을 플래그가 아니라 코드로 강제할 수 있다.
//
//  ── 실측 계약(codex-cli 0.149.1, 2026-08-26 · 지식 codex-app-server-spike-2055) ──
//  · 전송: `codex app-server`(stdio, 기본) 또는 `--listen ws://…`. **줄바꿈 구분 JSON**(LSP 식 Content-Length 는 거부됨).
//    `unix://` 는 소켓이 생기는데 응답이 없어 지금 쓰지 않는다(프레이밍 미규명).
//  · 핸드셰이크: 연결마다 `initialize` 1회 → `initialized` 알림 → 그 뒤 다른 메서드.
//  · 스레드 수명: 서버가 로드하고 **구독자 없이 30분이면 스스로 언로드**한다. 우리가 캐시를 만들 필요가 없다.
//  · ★ 스레드당 writer 는 **하나**다 — TUI 가 쥔 스레드는 우리가 못 열고, 우리가 쥔 스레드는 TUI 가 못 연다
//    (`thread-store conflict: … already has an active writer`). `thread/unsubscribe` 로도 안 풀리고 **프로세스 종료**가 유일한 반납이다.
//    그래서 codex 세션의 터미널 탭은 셸로 두고(=이 프로세스가 유일한 codex 런타임), 사람이 TUI 를 원하면 close() 로 넘겨준다.
//  · 승인: 서버가 **요청**(id + method)을 올린다. 우리가 result.decision 으로 답한다.
//    값은 accept | acceptForSession | decline | cancel. ⚠ 스키마에 없는 값을 보내면 **거부(fail-closed)** 로 처리된다(실측).
//
//  ── 경계 ──
//  이 파일은 전송·프로토콜만 안다. 화면용 번역은 codex-app-server-events.ts(순수)가 한다.
//  프로세스를 어디서 띄우나(로컬 · 세션 컨테이너 · ws)는 **호출자가 transport 로 주입**한다 — 배치가 바뀌어도 이 파일은 안 바뀐다.
import { spawn } from "node:child_process";
import { appServerLines } from "./codex-app-server-events.js";
import type { ChatLine, ParseState } from "./chat-line.js";

/** 전송 한 겹 — stdio·ws·(나중에) unix 를 같은 모양으로 본다. 줄 단위다(프레이밍은 전송이 책임진다). */
export interface AppServerTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

/** 승인 결정 — 실측 enum. 객체형(execpolicy·network 수정)은 아직 안 쓴다(있는 척 금지). */
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface ApprovalRequest {
  /** 서버가 올린 메서드 이름 그대로 — 예 item/commandExecution/requestApproval · applyPatchApproval */
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerOptions {
  transport: AppServerTransport;
  clientInfo?: { name: string; title: string; version: string };
  /** 정규화된 대화 줄(화면·중앙기록이 소비). */
  onLine?: (line: ChatLine) => void;
  /** 스트리밍 타이핑(줄이 아니다 — 화면이 '쓰는 중'을 그릴 때만 쓴다). */
  onDelta?: (delta: string, threadId: string) => void;
  /** 원본 알림 — 관측·디버깅용(토큰 사용량·레이트리밋·상태 변화가 여기로 온다). */
  onNotify?: (method: string, params: Record<string, unknown>) => void;
  /**
   * 승인 정책. **주지 않으면 전부 decline** 이다 — 자동 승인은 명시적으로 켜는 것이지 기본값이 아니다
   * (기본이 accept 면 정책을 안 붙인 호출자가 조용히 무제한 실행을 얻는다).
   */
  onApproval?: (req: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
  /** 요청 타임아웃(ms). 턴은 오래 걸리므로 **요청 응답**에만 건다(알림 스트림은 별개). */
  requestTimeoutMs?: number;
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const DEFAULT_TIMEOUT_MS = 60_000;

export class CodexAppServer {
  private readonly t: AppServerTransport;
  private readonly opts: CodexAppServerOptions;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private state: ParseState = {};
  private closed = false;
  private closeReason = "";

  constructor(opts: CodexAppServerOptions) {
    this.opts = opts;
    this.t = opts.transport;
    this.t.onLine((line) => this.onLine(line));
    this.t.onClose((reason) => {
      this.closed = true;
      this.closeReason = reason || "app-server 연결이 끊겼습니다";
      // 답을 기다리던 요청은 **에러로 깨운다** — 안 그러면 호출자가 영원히 멈춘다.
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(this.closeReason)); }
      this.pending.clear();
    });
  }

  /** 연결마다 1회. initialize 응답 뒤 initialized 알림까지가 계약이다. */
  async initialize(): Promise<Record<string, unknown>> {
    const clientInfo = this.opts.clientInfo ?? { name: "lively", title: "Lively", version: "1" };
    const res = await this.request("initialize", { clientInfo });
    this.notify("initialized", {});
    return res as Record<string, unknown>;
  }

  async startThread(params: {
    cwd: string; model?: string; approvalPolicy?: string; sandbox?: string; ephemeral?: boolean;
  }): Promise<{ threadId: string; raw: Record<string, unknown> }> {
    const r = await this.request("thread/start", params) as Record<string, any>;
    return { threadId: String(r?.thread?.id ?? ""), raw: r };
  }

  /** 이어 열기. 그 스레드를 **다른 프로세스가 쥐고 있으면 여기서 거부**된다(active writer) — 호출자가 그 뜻으로 다뤄야 한다. */
  async resumeThread(threadId: string): Promise<{ threadId: string; raw: Record<string, unknown> }> {
    const r = await this.request("thread/resume", { threadId }) as Record<string, any>;
    return { threadId: String(r?.thread?.id ?? threadId), raw: r };
  }

  /** 한 턴 시작. 응답은 turn 메타이고 **내용은 알림으로 흐른다**(onLine·onDelta). */
  async startTurn(threadId: string, text: string): Promise<Record<string, unknown>> {
    return await this.request("turn/start", { threadId, input: [{ type: "text", text }] }) as Record<string, unknown>;
  }

  async interrupt(threadId: string): Promise<void> { await this.request("turn/interrupt", { threadId }); }

  /** 돌고 있는 턴에 말을 얹는다(끊지 않고 방향만 바꾼다). */
  async steer(threadId: string, text: string): Promise<void> {
    await this.request("turn/steer", { threadId, input: [{ type: "text", text }] });
  }

  /** 구독만 끊는다. ⚠ **writer 락은 안 풀린다** — 스레드를 TUI 에 넘기려면 close() 로 프로세스를 내려야 한다(실측). */
  async unsubscribe(threadId: string): Promise<void> { await this.request("thread/unsubscribe", { threadId }); }

  close(): void { this.closed = true; this.t.close(); }
  get isClosed(): boolean { return this.closed; }

  // ── 아래는 배선 ──────────────────────────────────────────────────────────────
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(this.closeReason || "app-server 가 이미 닫혔습니다"));
    const id = this.nextId++;
    const ms = this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server ${method} 응답 없음(${ms}ms)`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.t.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.t.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let m: Record<string, any>;
    try { m = JSON.parse(line); } catch { return; }   // 잡음 한 줄이 세션을 죽이지 않는다

    // ① 서버 → 우리 **요청**(id 와 method 가 함께 온다) = 승인. 반드시 답해야 턴이 진행된다.
    if (m.method && m.id !== undefined) { void this.answerApproval(m.id, String(m.method), m.params ?? {}); return; }

    // ② 알림
    if (m.method) {
      const method = String(m.method);
      const params = (m.params ?? {}) as Record<string, any>;
      this.opts.onNotify?.(method, params);
      if (method === "item/agentMessage/delta") {
        const d = String(params.delta ?? "");
        if (d) this.opts.onDelta?.(d, String(params.threadId ?? ""));
        return;
      }
      const { lines, state } = appServerLines(m, this.state);
      this.state = state;
      for (const l of lines) this.opts.onLine?.(l);
      return;
    }

    // ③ 우리 요청의 응답
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(String(m.error?.message ?? "app-server 오류")));
    else p.resolve(m.result);
  }

  private async answerApproval(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    let decision: ApprovalDecision = "decline";   // ★ 기본은 거부 — 정책이 없으면 아무것도 통과하지 않는다
    try {
      if (this.opts.onApproval) decision = await this.opts.onApproval({ method, params });
    } catch {
      decision = "decline";                       // 정책이 터지면 막는 쪽으로 닫는다
    }
    this.t.send(JSON.stringify({ jsonrpc: "2.0", id, result: { decision } }));
  }
}

/** stdio 전송 — `codex app-server` 를 자식 프로세스로 띄운다(기본 배치). */
export function stdioTransport(o: { bin?: string; cwd?: string; env?: NodeJS.ProcessEnv; args?: string[] } = {}): AppServerTransport {
  const p = spawn(o.bin ?? "codex", ["app-server", ...(o.args ?? [])], {
    cwd: o.cwd, env: o.env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let onLineCb: ((l: string) => void) | null = null;
  let onCloseCb: ((r: string) => void) | null = null;
  p.stdout?.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) onLineCb?.(line);
    }
  });
  // stderr 는 진단 로그다(정상 동작에도 흐른다) — 삼키되 마지막 꼬리는 종료 사유로 쓴다.
  let errTail = "";
  p.stderr?.on("data", (c: Buffer) => { errTail = (errTail + c.toString("utf8")).slice(-2000); });
  p.on("exit", (code, sig) => onCloseCb?.(`app-server 종료(code=${code ?? "-"} sig=${sig ?? "-"})${errTail ? ` — ${errTail.trim().slice(-300)}` : ""}`));
  p.on("error", (e) => onCloseCb?.(`app-server 실행 실패 — ${e.message}`));
  return {
    send: (line) => { if (!p.killed) p.stdin?.write(line + "\n"); },
    onLine: (cb) => { onLineCb = cb; },
    onClose: (cb) => { onCloseCb = cb; },
    close: () => { try { p.kill(); } catch { /* 이미 죽었다 */ } },
  };
}
