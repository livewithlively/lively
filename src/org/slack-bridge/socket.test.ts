// 슬랙 다리(#1782) 소켓 모드 연결 시험 — 엣지 표 D2 · D3 · D4 · D9 + 죽은 연결 감시(spec-1782). 로컬 ws 서버가 슬랙 소켓 모드를 흉내 낸다(실 슬랙 없음).
// 실행: npm run build && node --test dist/org/slack-bridge/socket.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { SlackSocket, type SocketDeps, type SocketState } from "./socket.js";

interface Fake {
  url(n: number): string;
  conns: Array<{ ws: WebSocket; n: string; acks: string[]; closed: boolean }>;
  close(): Promise<void>;
  hello: boolean;
}
async function fakeSlack(): Promise<Fake> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((ok) => wss.once("listening", () => ok()));
  const port = (wss.address() as AddressInfo).port;
  const f: Fake = {
    hello: true,
    url: (n) => `ws://127.0.0.1:${port}/link/?ticket=t${n}&app_id=A777`,
    conns: [],
    close: () => new Promise<void>((ok) => { for (const c of wss.clients) c.terminate(); wss.close(() => ok()); }),
  };
  wss.on("connection", (ws, req) => {
    const n = new URL(req.url ?? "/", "http://x").searchParams.get("ticket") ?? "?";
    const rec = { ws, n, acks: [] as string[], closed: false };
    f.conns.push(rec);
    ws.on("message", (d) => { try { const j = JSON.parse(d.toString()) as { envelope_id?: string }; if (j.envelope_id) rec.acks.push(j.envelope_id); } catch { /* */ } });
    ws.on("close", () => { rec.closed = true; });
    if (f.hello) ws.send(JSON.stringify({ type: "hello", num_connections: 1, connection_info: n === "t1" ? { app_id: "A777" } : undefined }));
  });
  return f;
}

const until = async (cond: () => boolean, ms = 3000, what = "조건"): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`기다림 초과 — ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function harness(f: Fake, o: Partial<SocketDeps> = {}) {
  let opens = 0;
  const states: Array<{ s: SocketState; error?: string; app?: string | null }> = [];
  const envs: unknown[] = [];
  const sock = new SlackSocket({
    openUrl: async () => { opens++; return f.url(opens); },
    allowUrl: (u) => u.startsWith("ws://127.0.0.1:"),
    onEnvelope: (e) => { envs.push(e); },
    onState: (s, d) => { states.push({ s, error: d?.error, app: d?.slackAppId }); },
    delayMs: () => 20,
    ...o,
  });
  return { sock, states, envs, opens: () => opens };
}

test("S1 · D2 hello 뒤 «연결됨» · envelope 은 처리 전에 ack — 처리가 던져도 ack 는 나가고 연결은 산다", async () => {
  const f = await fakeSlack();
  let throwOnce = true;
  const h = harness(f, { onEnvelope: () => { if (throwOnce) { throwOnce = false; throw new Error("처리 실패(가짜)"); } } });
  try {
    h.sock.start();
    await until(() => h.states.some((x) => x.s === "connected"), 3000, "connected");
    assert.equal(h.states.find((x) => x.s === "connected")?.app, "A777", "hello 의 app_id");
    assert.equal(h.sock.open, true);
    const c = f.conns[0]!;
    c.ws.send(JSON.stringify({ envelope_id: "E-1", type: "events_api", payload: {} }));
    c.ws.send(JSON.stringify({ envelope_id: "E-2", type: "events_api", payload: {} }));
    await until(() => c.acks.length === 2, 3000, "ack 둘");
    assert.deepEqual(c.acks, ["E-1", "E-2"], "처리가 던진 envelope 도 ack 됐다");
    assert.equal(c.closed, false, "연결이 살아 있다");
    c.ws.send("not json");
    c.ws.send(JSON.stringify({ type: "events_api" }));   // envelope_id 없음 — 무시
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.acks.length, 2, "envelope_id 없는 것 · 깨진 글에는 ack 하지 않는다");
  } finally { h.sock.stop(); await f.close(); }
});

test("D3 disconnect 예고 — 새 주소로 먼저 붙고, 새 연결 hello 뒤에 옛 연결을 닫는다 · 그사이 옛 연결의 envelope 도 ack", async () => {
  const f = await fakeSlack();
  const h = harness(f);
  try {
    h.sock.start();
    await until(() => f.conns.length === 1 && h.sock.open, 3000, "첫 연결");
    const old = f.conns[0]!;
    f.hello = false;   // 새 연결은 hello 를 늦게 보낸다
    old.ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    await until(() => f.conns.length === 2, 3000, "새 연결");
    assert.equal(h.opens(), 2, "새 주소를 받았다");
    old.ws.send(JSON.stringify({ envelope_id: "OLD-1", type: "events_api", payload: {} }));
    await until(() => old.acks.includes("OLD-1"), 3000, "옛 연결 ack");
    assert.equal(old.closed, false, "새 연결 hello 전에는 옛 연결을 닫지 않는다");
    f.conns[1]!.ws.send(JSON.stringify({ type: "hello" }));
    await until(() => old.closed, 3000, "옛 연결 닫힘");
    assert.equal(f.conns[1]!.closed, false, "새 연결은 산다");
    f.conns[1]!.ws.send(JSON.stringify({ envelope_id: "NEW-1", type: "events_api", payload: {} }));
    await until(() => f.conns[1]!.acks.includes("NEW-1"), 3000, "새 연결 ack");
    assert.equal(h.envs.length, 2);
  } finally { h.sock.stop(); await f.close(); }
});

test("D4 서버가 끊으면 기다렸다 새 주소로 다시 붙는다 · stop 뒤에는 다시 붙지 않는다", async () => {
  const f = await fakeSlack();
  const h = harness(f);
  try {
    h.sock.start();
    await until(() => h.sock.open, 3000, "연결");
    f.conns[0]!.ws.close(1011);
    await until(() => h.states.some((x) => x.s === "waiting"), 3000, "waiting");
    await until(() => f.conns.length === 2 && h.sock.open, 3000, "다시 붙음");
    assert.equal(h.opens(), 2);
    h.sock.stop();
    assert.equal(h.states.at(-1)?.s, "stopped");
    await until(() => f.conns[1]!.closed, 3000, "stop 이 닫음");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.conns.length, 2, "stop 뒤 다시 붙지 않는다");
  } finally { h.sock.stop(); await f.close(); }
});

test("D9 · 주소 받기 실패 — 슬랙 주소가 아니면 붙지 않고 기다린다 · openUrl 이 던지면 기다렸다 다시", async () => {
  const f = await fakeSlack();
  let n = 0;
  const h = harness(f, { allowUrl: () => { n++; return n >= 3; } });
  try {
    h.sock.start();
    await until(() => h.sock.open, 3000, "세 번째에 붙음");
    assert.equal(f.conns.length, 1, "허용 안 된 주소로는 붙지 않았다");
    assert.ok(h.states.some((x) => x.s === "waiting" && /wss/.test(x.error ?? "")), "까닭이 상태에 실린다");
  } finally { h.sock.stop(); await f.close(); }

  const f2 = await fakeSlack();
  let k = 0;
  const h2 = harness(f2, { openUrl: async () => { k++; if (k < 3) throw new Error("apps.connections.open 실패: invalid_auth"); return f2.url(k); } });
  try {
    h2.sock.start();
    await until(() => h2.sock.open, 3000, "세 번째 주소로 붙음");
    assert.ok(h2.states.filter((x) => x.s === "waiting").length >= 2);
    assert.match(h2.states.find((x) => x.s === "waiting")?.error ?? "", /invalid_auth/);
  } finally { h2.sock.stop(); await f2.close(); }
});

test("죽은 연결 감시 — 아무것도 안 오면 끊고 다시 붙는다", async () => {
  const f = await fakeSlack();
  const h = harness(f, { idleMs: 200, pingMs: 60_000, tickMs: 25 });
  try {
    h.sock.start();
    await until(() => f.conns.length >= 2, 4000, "감시가 끊고 다시 붙음");
    assert.equal(f.conns[0]!.closed, true);
  } finally { h.sock.stop(); await f.close(); }
});
