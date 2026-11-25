// 슬랙 다리(#1782) — 소켓 모드 연결 하나. 앱 수준 토큰으로 주소를 받아(apps.connections.open) wss 로 붙고, envelope 마다 먼저 ack 한 뒤 넘긴다.
//
//  슬랙 소켓 모드의 규칙(api.slack.com/apis/socket-mode):
//   · 붙으면 { type:"hello" } 가 온다 — 그때부터 «연결됨».
//   · envelope 은 3초 안에 { envelope_id } 로 ack 해야 한다 — 처리 전에 먼저 보낸다(처리는 부르는 쪽이 비동기로).
//   · { type:"disconnect" } 는 곧 끊는다는 예고다(refresh_requested · warning — 몇 시간마다). 새 주소로 먼저 붙고, 새 연결이 hello 를 받으면 옛 연결을 닫는다.
//   · 끊기면 새 주소로 다시 붙는다(1초부터 두 배씩 60초까지 기다리며).
//   · 서버가 주기적으로 ping 을 보낸다 — 60초 동안 아무것도 안 오면 죽은 연결로 보고 끊고 다시 붙는다(반대쪽에서 20초마다 ping 도 보낸다).
//  이 클래스는 슬랙 · DB 를 모른다 — 주소 받기(openUrl) · 주소 검사 · 받은 envelope · 상태 바뀜을 부르는 쪽(manager.ts)이 넣는다(시험이 바꿔 끼운다).
import WebSocket from "ws";
import { reconnectDelayMs, shortError, socketAppIdOf, type SocketEnvelope } from "./plan.js";

export type SocketState = "connecting" | "connected" | "waiting" | "stopped";

export interface SocketDeps {
  /** 이번 연결의 주소(apps.connections.open) — 연결마다 새로 받는다. 던지면 기다렸다 다시. */
  openUrl(): Promise<string>;
  /** 슬랙 소켓 주소인가 — 아니면 붙지 않는다. */
  allowUrl(url: string): boolean;
  /** ack 를 보낸 뒤 부른다. 오래 걸리는 일은 부르는 쪽이 비동기로 한다(여기서 기다리지 않는다). */
  onEnvelope(env: SocketEnvelope): void;
  /** 상태가 바뀔 때 — error 는 그 상태가 된 까닭(waiting), slackAppId 는 hello 를 받은 연결의 슬랙 앱. */
  onState(state: SocketState, detail?: { error?: string; slackAppId?: string | null }): void;
  WebSocketImpl?: typeof WebSocket;
  now?(): number;
  /** 시험용 — 기다림(다시 붙기 전) 길이를 바꾼다. */
  delayMs?(attempt: number): number;
  pingMs?: number;
  idleMs?: number;
  /** 감시 주기(기본 5초) — 시험이 줄인다. */
  tickMs?: number;
}

export class SlackSocket {
  private ws: WebSocket | null = null;
  /** disconnect 예고를 받은 옛 연결 — 새 연결이 hello 를 받을 때까지 둔다(그사이 오는 envelope 도 받는다). */
  private draining: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastInbound = 0;
  private lastPing = 0;
  private connecting = false;

  constructor(private readonly d: SocketDeps) {}

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    //  죽은 연결 감시 · ping — 연결 하나에 타이머 하나(5초).
    this.tickTimer = setInterval(() => this.tick(), this.d.tickMs ?? 5_000);
    this.tickTimer.unref?.();
    void this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    for (const w of [this.ws, this.draining]) { try { w?.close(1000); } catch { /* 이미 닫힘 */ } }
    this.ws = null; this.draining = null;
    this.d.onState("stopped");
  }

  /** 지금 hello 를 받은 연결이 있나. */
  get open(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.helloSeen; }
  private helloSeen = false;

  private tick(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = this.now();
    if (now - this.lastInbound > (this.d.idleMs ?? 60_000)) {
      //  슬랙 쪽 ping 도 우리 ping 의 pong 도 오지 않았다 — 반쯤 열린 연결이다. 끊으면 close 가 다시 붙인다.
      try { ws.terminate(); } catch { /* 이미 닫힘 */ }
      return;
    }
    if (now - this.lastPing >= (this.d.pingMs ?? 20_000)) {
      this.lastPing = now;
      try { ws.ping(); } catch { /* 닫히는 중 */ }
    }
  }

  private wait(error: string): void {
    if (this.stopped) return;
    this.d.onState("waiting", { error });
    const delay = this.d.delayMs ? this.d.delayMs(this.attempt) : reconnectDelayMs(this.attempt);
    this.attempt++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay);
    this.retryTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.helloSeen = false;
    this.d.onState("connecting");
    let url: string;
    try {
      url = await this.d.openUrl();
    } catch (e) {
      this.connecting = false;
      this.wait(shortError(e));
      return;
    }
    if (this.stopped) { this.connecting = false; return; }
    if (!this.d.allowUrl(url)) {
      this.connecting = false;
      this.wait("슬랙이 준 소켓 주소가 slack.com 의 wss 주소가 아닙니다 — 붙지 않았습니다");
      return;
    }
    const Impl = this.d.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(url, { handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024 });
    } catch (e) {
      this.connecting = false;
      this.wait(shortError(e));
      return;
    }
    this.connecting = false;
    this.ws = ws;
    let closedWhy = "";
    ws.on("open", () => { this.lastInbound = this.now(); this.lastPing = this.now(); });
    ws.on("ping", () => { this.lastInbound = this.now(); });   // ws 가 pong 을 스스로 보낸다
    ws.on("pong", () => { this.lastInbound = this.now(); });
    ws.on("message", (data) => this.onMessage(ws, data, url));
    ws.on("error", (err) => { closedWhy = shortError(err); });
    ws.on("close", (code) => this.onClose(ws, code, closedWhy));
  }

  private onMessage(ws: WebSocket, data: WebSocket.RawData, url: string): void {
    this.lastInbound = this.now();
    let msg: Record<string, unknown>;
    try {
      const j = JSON.parse(data.toString()) as unknown;
      if (!j || typeof j !== "object" || Array.isArray(j)) return;
      msg = j as Record<string, unknown>;
    } catch { return; }
    if (msg.type === "hello") {
      if (ws !== this.ws) return;
      this.helloSeen = true;
      this.attempt = 0;
      const info = (msg.connection_info && typeof msg.connection_info === "object" ? msg.connection_info : {}) as Record<string, unknown>;
      const appId = typeof info.app_id === "string" ? info.app_id : socketAppIdOf(url);
      this.d.onState("connected", { slackAppId: appId });
      //  새 연결이 섰다 — disconnect 예고를 받은 옛 연결을 닫는다.
      const old = this.draining;
      this.draining = null;
      if (old) { try { old.close(1000); } catch { /* 이미 닫힘 */ } }
      return;
    }
    if (msg.type === "disconnect") {
      //  곧 끊는다는 예고(refresh_requested · warning · link_disabled …) — 이 연결은 «옛 연결» 로 두고 새 주소로 먼저 붙는다.
      if (ws === this.ws) {
        if (this.draining && this.draining !== ws) { try { this.draining.close(1000); } catch { /* 이미 닫힘 */ } }
        this.draining = ws;
        this.ws = null;
        void this.connect();
      }
      return;
    }
    const envelopeId = typeof msg.envelope_id === "string" ? msg.envelope_id : null;
    if (!envelopeId) return;
    //  ack 먼저 — 3초 안에 안 오면 슬랙이 다시 보낸다(retry_attempt). 처리는 그 뒤다.
    try { ws.send(JSON.stringify({ envelope_id: envelopeId })); } catch { /* 닫히는 중 — 슬랙이 다른 연결로 다시 보낸다 */ }
    try { this.d.onEnvelope(msg as SocketEnvelope); } catch { /* 넘기는 쪽의 오류가 연결을 죽이지 않게 */ }
  }

  private onClose(ws: WebSocket, code: number, why: string): void {
    if (ws === this.draining) { this.draining = null; return; }   // 예고한 대로 닫힌 옛 연결 — 새 연결이 이미 붙는 중이다
    if (ws !== this.ws) return;
    this.ws = null;
    this.helloSeen = false;
    if (this.stopped) return;
    this.wait(why || `연결이 끊겼습니다(code ${code})`);
  }
}
