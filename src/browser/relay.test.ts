import { strict as assert } from "node:assert";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { BrowserRelay, BrowserRelayError, MAX_HOSTS_PER_KEY, MAX_PENDING_PER_KEY, NO_HOST_MESSAGE, relayKey, type BrowserCmd } from "./relay.js";
import { registerBrowserRoutes } from "./routes.js";
import { browserMcpContent } from "../capabilities/browser.js";
import type { LivelyUser } from "../context.js";

// ── 브라우저 중계 (#4993) — 사양·엣지 표(E·R·M 행)는 scratch spec 과 같은 번호다 ─────────────
//  단언은 문구가 아니라 부작용으로 한다: 화면에 밀린 프레임 · 기다리는 명령 수 · 붙은 화면 수 · end 호출 · taken.
//  (예외: E1 의 안내 문구는 그 자체가 사양이다 — AI 의 다음 행동이 그 문구다. 상수와 같은지만 본다.)

type Pushed = { event: string; data: BrowserCmd };
function fakeHost(relay: BrowserRelay, id: string, key: string) {
  const pushed: Pushed[] = [];
  let ended = 0;
  let ok = true;
  const detach = relay.attach({ id, key, push: (event, data) => { if (ok) pushed.push({ event, data: data as BrowserCmd }); return ok; }, end: () => { ended++; } });
  return { pushed, detach, get ended() { return ended; }, fail() { ok = false; } };
}
const K = relayKey("ws-a", "alice");
const tick = () => new Promise((r) => setImmediate(r));
const isCode = (code: string) => (e: unknown) => e instanceof BrowserRelayError && e.code === code;

test("E1 화면이 없으면 no_host — 안내 문구는 상수 그대로", async () => {
  const relay = new BrowserRelay();
  await assert.rejects(relay.call(K, { op: "screenshot", session: null }, 5_000), (e: unknown) => isCode("no_host")(e) && (e as Error).message === NO_HOST_MESSAGE);
  assert.equal(relay.pendingCount(), 0);
});

test("E2 명령이 cmd 로 밀리고 그 화면의 ok 답이 호출을 푼다", async () => {
  const relay = new BrowserRelay();
  const h = fakeHost(relay, "host-aaaa1", K);
  const p = relay.call(K, { op: "navigate", session: "box-s-12345678", args: { url: "https://example.com" } }, 5_000);
  await tick();
  assert.equal(h.pushed.length, 1, "화면에 밀리지 않았다");
  assert.equal(h.pushed[0].event, "cmd");
  assert.equal(h.pushed[0].data.op, "navigate");
  assert.equal(h.pushed[0].data.session, "box-s-12345678");
  assert.deepEqual(h.pushed[0].data.args, { url: "https://example.com" });
  assert.equal(h.pushed[0].data.ttl_ms, 5_000, "명령에 시간 한도가 실리지 않았다(화면이 늦은 명령을 버릴 근거)");
  assert.equal(relay.pendingCount(), 1);
  assert.equal(relay.reply(K, "host-aaaa1", { id: h.pushed[0].data.id, ok: true, result: { url: "https://example.com/" } }), true);
  assert.deepEqual(await p, { url: "https://example.com/" });
  assert.equal(relay.pendingCount(), 0);
});

test("E3·E3b 실패 답 — 화면의 문구 그대로 · 문구가 없으면 기본 문구", async () => {
  const relay = new BrowserRelay();
  const h = fakeHost(relay, "host-aaaa1", K);
  const p = relay.call(K, { op: "act", session: null }, 5_000);
  const q = relay.call(K, { op: "act", session: null }, 5_000);
  await tick();
  relay.reply(K, "host-aaaa1", { id: h.pushed[0].data.id, ok: false, error: "ref e9 를 찾지 못했습니다" });
  relay.reply(K, "host-aaaa1", { id: h.pushed[1].data.id, ok: false });
  await assert.rejects(p, (e: unknown) => isCode("host_error")(e) && (e as Error).message === "ref e9 를 찾지 못했습니다");
  await assert.rejects(q, (e: unknown) => isCode("host_error")(e) && (e as Error).message.length > 0);
});

test("E4·E5 같은 사람의 다른 화면 · 다른 사람이 보낸 답은 받지 않는다", async () => {
  const relay = new BrowserRelay();
  const a = fakeHost(relay, "host-aaaa1", K);
  fakeHost(relay, "host-bbbb2", K);
  const other = relayKey("ws-a", "bob");
  fakeHost(relay, "host-cccc3", other);
  relay.setState(K, "host-aaaa1", { focused: true });
  const p = relay.call(K, { op: "read", session: null }, 5_000);
  await tick();
  assert.equal(a.pushed.length, 1);
  const id = a.pushed[0].data.id;
  assert.equal(relay.reply(K, "host-bbbb2", { id, ok: true, result: "가짜" }), false, "같은 사람의 다른 화면이 답을 가로챘다");
  assert.equal(relay.reply(other, "host-cccc3", { id, ok: true, result: "가짜" }), false, "다른 사람이 답을 가로챘다");
  assert.equal(relay.reply(other, "host-aaaa1", { id, ok: true, result: "가짜" }), false, "다른 열쇠로 같은 화면 id 를 대며 답을 가로챘다");
  assert.equal(relay.pendingCount(), 1, "남의 답에 대기가 풀렸다");
  assert.equal(relay.reply(K, "host-aaaa1", { id, ok: true, result: "진짜" }), true);
  assert.equal(await p, "진짜");
});

test("E6 시간 초과 — 끝내고 대기를 비우며, 늦은 답은 받지 않는다", async () => {
  const relay = new BrowserRelay();
  const h = fakeHost(relay, "host-aaaa1", K);
  const t0 = Date.now();
  await assert.rejects(relay.call(K, { op: "screenshot", session: null }, 1_000), isCode("timeout"));
  assert.ok(Date.now() - t0 >= 950, "1초 전에 끝났다");
  assert.equal(relay.pendingCount(), 0);
  assert.equal(relay.reply(K, "host-aaaa1", { id: h.pushed[0].data.id, ok: true }), false, "늦은 답을 받았다");
});

test("E6b·E6c 시간 한도 경계 — 1ms 는 1초로 올리고, 0 은 기본값(곧바로 끝내지 않는다)", async () => {
  const relay = new BrowserRelay();
  const h = fakeHost(relay, "host-aaaa1", K);
  const t0 = Date.now();
  const tiny = relay.call(K, { op: "read", session: null }, 1);
  const zero = relay.call(K, { op: "read", session: null }, 0);
  await assert.rejects(tiny, isCode("timeout"));
  const took = Date.now() - t0;
  assert.ok(took >= 950, `1ms 한도가 1초로 올라가지 않았다(${took}ms)`);
  await new Promise((r) => setTimeout(r, 400));   // 한도 0 이 하한(1초)으로 떨어졌다면 지금쯤 끝나 있다
  assert.equal(relay.pendingCount(), 1, "한도 0 인 명령이 기본값(30초)이 아니라 곧 끝났다");
  assert.deepEqual([h.pushed[0].data.ttl_ms, h.pushed[1].data.ttl_ms], [1_000, 30_000], "화면에 실린 한도가 실제 한도와 다르다");
  relay.reply(K, "host-aaaa1", { id: h.pushed[1].data.id, ok: true, result: 0 });
  assert.equal(await zero, 0);
});

test("E7 화면이 끊기면 기다리던 명령을 곧바로 깨운다", async () => {
  const relay = new BrowserRelay();
  const h = fakeHost(relay, "host-aaaa1", K);
  const p = relay.call(K, { op: "navigate", session: null }, 60_000);
  await tick();
  const t0 = Date.now();
  h.detach();
  await assert.rejects(p, isCode("disconnected"));
  assert.ok(Date.now() - t0 < 500, "끊긴 화면의 명령이 시간 초과까지 매달렸다");
  assert.equal(relay.hostCount(), 0);
  assert.equal(relay.pendingCount(), 0);
});

test("E8·E8b 고르기 — 세션 탭 > 앞에 있는 창 > 최근에 만짐 > 최근에 붙음 · 세션 없는 명령엔 세션 가점 없음", async () => {
  let now = 1_000_000;
  const relay = new BrowserRelay({ now: () => now });
  const a = fakeHost(relay, "host-aaaa1", K);
  now += 10;
  const b = fakeHost(relay, "host-bbbb2", K);
  now += 10;
  const c = fakeHost(relay, "host-cccc3", K);
  // 아무 보고도 없으면 최근에 붙은 화면
  assert.equal(relay.pick(K, null)?.id, "host-cccc3", "최근에 붙은 화면이 아니다");
  now += 100;
  relay.setState(K, "host-aaaa1", { active_at: now });
  assert.equal(relay.pick(K, null)?.id, "host-aaaa1", "최근에 만진 화면이 아니다");
  relay.setState(K, "host-bbbb2", { focused: true });
  // 앞에 있는 창을 고른 뒤 다른 화면을 더 최근에 만져도 — 앞 창이 이긴다(만진 시각만으로는 a 가 이길 상황을 만든다)
  now += 50;
  relay.setState(K, "host-aaaa1", { active_at: now });
  assert.equal(relay.pick(K, null)?.id, "host-bbbb2", "앞에 있는 창이 아니다");
  relay.setState(K, "host-cccc3", { sessions: ["box-s-12345678"] });
  assert.equal(relay.pick(K, "box-s-12345678")?.id, "host-cccc3", "세션 탭을 쥔 화면으로 가지 않았다");
  assert.equal(relay.pick(K, null)?.id, "host-bbbb2", "세션 없는 명령에 세션 가점이 붙었다");
  assert.equal(relay.pick(K, "box-other-87654321")?.id, "host-bbbb2");
  // 실제 call 도 같은 판정으로 간다
  const p = relay.call(K, { op: "read", session: "box-s-12345678" }, 5_000);
  await tick();
  assert.deepEqual([a.pushed.length, b.pushed.length, c.pushed.length], [0, 0, 1]);
  relay.reply(K, "host-cccc3", { id: c.pushed[0].data.id, ok: true, result: 1 });
  await p;
});

test("E9 같은 id 재접속 — 옛 연결을 끊고 갈아 끼우며, 옛 연결의 늦은 닫힘이 새 연결을 떼지 않는다", async () => {
  const relay = new BrowserRelay();
  const old = fakeHost(relay, "host-aaaa1", K);
  const p = relay.call(K, { op: "read", session: null }, 60_000);
  await tick();
  const fresh = fakeHost(relay, "host-aaaa1", K);
  assert.equal(old.ended, 1, "옛 연결을 닫지 않았다");
  await assert.rejects(p, isCode("disconnected"));
  old.detach();
  assert.equal(relay.hostCount(), 1, "옛 연결의 늦은 닫힘이 새 연결을 뗐다");
  const q = relay.call(K, { op: "read", session: null }, 5_000);
  await tick();
  assert.equal(fresh.pushed.length, 1);
  relay.reply(K, "host-aaaa1", { id: fresh.pushed[0].data.id, ok: true, result: "ok" });
  assert.equal(await q, "ok");
});

test("E10 같은 화면 id 를 다른 사람이 쓰려 하면 거절 — 원래 연결은 그대로", async () => {
  const relay = new BrowserRelay();
  const mine = fakeHost(relay, "host-aaaa1", K);
  assert.throws(() => fakeHost(relay, "host-aaaa1", relayKey("ws-a", "mallory")));
  assert.equal(mine.ended, 0, "원래 연결을 끊었다");
  assert.equal(relay.hostsFor(K).length, 1);
  assert.equal(relay.hostsFor(relayKey("ws-a", "mallory")).length, 0);
});

test("E11 대기 상한 경계 — 정확히 상한까지는 받고, 그다음 하나는 busy", async () => {
  const relay = new BrowserRelay();
  const h = fakeHost(relay, "host-aaaa1", K);
  const ps = Array.from({ length: MAX_PENDING_PER_KEY }, () => relay.call(K, { op: "read", session: null }, 60_000).catch(() => null));
  await tick();
  assert.equal(h.pushed.length, MAX_PENDING_PER_KEY, "상한 안쪽 명령이 밀리지 않았다");
  await assert.rejects(relay.call(K, { op: "read", session: null }, 60_000), isCode("busy"));
  assert.equal(h.pushed.length, MAX_PENDING_PER_KEY, "busy 인 명령이 화면에 밀렸다");
  // 다른 사람의 대기는 내 상한에 안 센다
  const o = fakeHost(relay, "host-bbbb2", relayKey("ws-a", "bob"));
  const op = relay.call(relayKey("ws-a", "bob"), { op: "read", session: null }, 60_000);
  await tick();
  assert.equal(o.pushed.length, 1, "남의 대기가 내 상한에 세어졌다");
  relay.detach("host-aaaa1", "evicted");
  relay.detach("host-bbbb2", "evicted");
  await Promise.all(ps);
  await op.catch(() => null);
});

test("E12 다른 워크스페이스의 같은 아이디는 서로의 화면으로 가지 않는다", async () => {
  const relay = new BrowserRelay();
  const a = fakeHost(relay, "host-aaaa1", relayKey("ws-a", "john"));
  const b = fakeHost(relay, "host-bbbb2", relayKey("ws-b", "john"));
  const p = relay.call(relayKey("ws-b", "john"), { op: "read", session: null }, 5_000);
  await tick();
  assert.deepEqual([a.pushed.length, b.pushed.length], [0, 1], "다른 워크스페이스의 화면으로 갔다");
  relay.reply(relayKey("ws-b", "john"), "host-bbbb2", { id: b.pushed[0].data.id, ok: true, result: 2 });
  assert.equal(await p, 2);
});

test("E13 화면에 밀기가 실패하면 그 화면을 떼고 disconnected", async () => {
  const relay = new BrowserRelay();
  const h = fakeHost(relay, "host-aaaa1", K);
  h.fail();
  await assert.rejects(relay.call(K, { op: "read", session: null }, 5_000), isCode("disconnected"));
  assert.equal(relay.hostCount(), 0);
  assert.equal(relay.pendingCount(), 0);
});

test("E13b 밀기가 실패한 화면은 떼고 같은 사람의 다음 화면에 민다 — 그 화면의 답이 호출을 푼다", async () => {
  const relay = new BrowserRelay();
  const back = fakeHost(relay, "host-back1", K);
  const front = fakeHost(relay, "host-front1", K);
  relay.setState(K, "host-front1", { focused: true });
  front.fail();
  const p = relay.call(K, { op: "read", session: null }, 5_000);
  await tick();
  assert.deepEqual([front.pushed.length, back.pushed.length], [0, 1], "다음 화면으로 넘어가지 않았다");
  assert.deepEqual(relay.hostsFor(K).map((h) => h.id), ["host-back1"], "실패한 화면을 떼지 않았다");
  assert.equal(relay.reply(K, "host-back1", { id: back.pushed[0].data.id, ok: true, result: 7 }), true);
  assert.equal(await p, 7);
  assert.equal(relay.pendingCount(), 0);
});

test("E14 화면 상한을 넘으면 가장 오래 붙은 화면을 끊는다", () => {
  let now = 1;
  const relay = new BrowserRelay({ now: () => now });
  const hs = Array.from({ length: MAX_HOSTS_PER_KEY }, (_, i) => { now += 1; return fakeHost(relay, `host-${String(i).padStart(5, "0")}`, K); });
  assert.equal(relay.hostsFor(K).length, MAX_HOSTS_PER_KEY);
  now += 1;
  fakeHost(relay, "host-newest", K);
  assert.equal(relay.hostsFor(K).length, MAX_HOSTS_PER_KEY, "상한을 넘었다");
  assert.equal(hs[0].ended, 1, "가장 오래된 화면을 끊지 않았다");
  assert.ok(hs.slice(1).every((h) => h.ended === 0), "엉뚱한 화면을 끊었다");
  assert.ok(relay.hostsFor(K).some((h) => h.id === "host-newest"));
});

test("E15·E15b·E15c 상태 보고 — 남의 열쇠 거절 · 미래 시각은 지금으로 · 세션 목록 거르기", () => {
  let now = 5_000;
  const relay = new BrowserRelay({ now: () => now });
  fakeHost(relay, "host-aaaa1", K);
  assert.equal(relay.setState(relayKey("ws-a", "bob"), "host-aaaa1", { focused: true, sessions: ["box-x-11111111"] }), false);
  assert.deepEqual(relay.hostsFor(K)[0].sessions, [], "남의 열쇠로 상태가 바뀌었다");
  assert.equal(relay.hostsFor(K)[0].focused, false);
  assert.equal(relay.setState(K, "host-aaaa1", { active_at: now + 10 ** 9 }), true);
  assert.equal(relay.hostsFor(K)[0].active_at, now, "미래 시각이 지금을 넘었다");
  const long = "x".repeat(129);
  relay.setState(K, "host-aaaa1", { sessions: ["box-s-12345678", 42 as unknown as string, long] });
  assert.deepEqual(relay.hostsFor(K)[0].sessions, ["box-s-12345678"]);
});

test("E16 단일 테넌트 열쇠는 '-|구성원'", () => {
  assert.equal(relayKey(null, "john"), "-|john");
  assert.equal(relayKey(undefined, "john"), "-|john");
  assert.equal(relayKey("ws-a", "john"), "ws-a|john");
});

// ── MCP 결과 조각 — 스크린샷은 그림으로 ─────────────────────────────────────
test("M1~M4 그림 조각", () => {
  const out = browserMcpContent({ image: { mime: "image/jpeg", data: "QUJD" }, url: "https://x.test/", width: 1280 });
  assert.ok(out);
  assert.deepEqual(out![0], { type: "image", data: "QUJD", mimeType: "image/jpeg" });
  assert.equal(out![1].type, "text");
  assert.deepEqual(JSON.parse((out![1] as { text: string }).text), { url: "https://x.test/", width: 1280 }, "메타에 그림 데이터가 섞였다");
  assert.equal(browserMcpContent({ url: "https://x.test/" }), null);
  assert.equal(browserMcpContent(null), null);
  assert.equal(browserMcpContent({ image: { data: "" } }), null);
  assert.equal((browserMcpContent({ image: { mime: "text/html", data: "QUJD" } })![0] as { mimeType: string }).mimeType, "image/jpeg");
  assert.equal((browserMcpContent({ image: { mime: "image/png", data: "QUJD" } })![0] as { mimeType: string }).mimeType, "image/png");
  assert.equal((browserMcpContent({ image: { mime: "image/webp", data: "QUJD" } })![0] as { mimeType: string }).mimeType, "image/webp");
});

// ── 라우트 — 실제 HTTP 로 스트림에 붙어 명령을 받고 답을 돌려준다 ──────────────
async function server(userOf: () => Partial<LivelyUser> | null, relay: BrowserRelay) {
  const app = express();
  app.use(express.json());
  registerBrowserRoutes(app, [(_req, _res, next) => next()], () => { const u = userOf(); return u ? ({ email: "", scopes: [], projects: [], ...u } as LivelyUser) : undefined; }, relay);
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => srv.close(r)) };
}
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("기다린 상태가 오지 않았다"); await new Promise((r) => setTimeout(r, 5)); }
}
function openStream(url: string, bearer = true) {
  const ctl = new AbortController();
  const frames: { event: string; data: any }[] = [];
  let status = 0;
  let type = "";
  let ended = false;
  const done = (async () => {
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: bearer ? { authorization: "Bearer test-token" } : {} });
      status = res.status;
      type = res.headers.get("content-type") || "";
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: fin } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const f of parts) {
          const ev = f.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim() || "";
          const data = f.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (data) frames.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch { /* abort */ } finally { ended = true; }
  })();
  return { frames, ctl, done, get status() { return status; }, get type() { return type; }, get ended() { return ended; } };
}
const post = (base: string, path: string, body: unknown, bearer = true) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer test-token" } : {}) }, body: JSON.stringify(body) });
const getStream = (url: string, bearer = true) => fetch(url, { headers: bearer ? { authorization: "Bearer test-token" } : {} });

test("R4~R7 스트림 — hello · 상태 반영 · cmd 받고 reply 로 답 · 늦은 답 taken:false · 끊으면 화면이 빠진다", async () => {
  const relay = new BrowserRelay();
  const s = await server(() => ({ userId: "alice" }), relay);
  const st = openStream(`${s.base}/api/ui/browser/host/stream?host=host-aaaa1&app=0.1.300&platform=darwin`);
  try {
    await until(() => st.frames.some((f) => f.event === "hello"));
    assert.equal(st.status, 200);
    assert.match(st.type, /text\/event-stream/);
    assert.equal(st.frames[0].data.protocol, 1);
    const key = relayKey(null, "alice");
    assert.equal(relay.hostsFor(key).length, 1);
    assert.equal(relay.hostsFor(key)[0].platform, "darwin");
    assert.deepEqual(await (await post(s.base, "/api/ui/browser/host/state", { host: "host-aaaa1", focused: true, sessions: ["box-s-12345678"] })).json(), { ok: true });
    assert.deepEqual(relay.hostsFor(key)[0].sessions, ["box-s-12345678"]);
    const call = relay.call(key, { op: "screenshot", session: "box-s-12345678", args: {} }, 5_000);
    await until(() => st.frames.some((f) => f.event === "cmd"));
    const cmd = st.frames.find((f) => f.event === "cmd")!.data;
    assert.equal(cmd.op, "screenshot");
    assert.deepEqual(await (await post(s.base, "/api/ui/browser/host/reply", { host: "host-aaaa1", id: cmd.id, ok: true, result: { url: "https://x.test/" } })).json(), { ok: true, taken: true });
    assert.deepEqual(await call, { url: "https://x.test/" });
    assert.deepEqual(await (await post(s.base, "/api/ui/browser/host/reply", { host: "host-aaaa1", id: cmd.id, ok: true })).json(), { ok: true, taken: false });
    st.ctl.abort();
    await st.done;
    await until(() => relay.hostCount() === 0);
  } finally {
    st.ctl.abort();
    await s.close();
  }
});

test("R1~R3 신원 없음 401 · 앱 토큰/앱 서버 403 · 형식 불량 400 — 화면은 하나도 안 붙는다", async () => {
  const relay = new BrowserRelay();
  let who: Partial<LivelyUser> | null = null;
  const s = await server(() => who, relay);
  try {
    for (const path of ["/api/ui/browser/host/reply", "/api/ui/browser/host/state"]) assert.equal((await post(s.base, path, { host: "host-aaaa1", id: "x" })).status, 401, path);
    assert.equal((await getStream(`${s.base}/api/ui/browser/host/stream?host=host-aaaa1`)).status, 401);
    for (const u of [{ userId: "alice", appId: "app-x" }, { userId: "alice", appServer: true }]) {
      who = u;
      assert.equal((await getStream(`${s.base}/api/ui/browser/host/stream?host=host-aaaa1`)).status, 403);
      assert.equal((await post(s.base, "/api/ui/browser/host/reply", { host: "host-aaaa1", id: "x" })).status, 403);
      assert.equal((await post(s.base, "/api/ui/browser/host/state", { host: "host-aaaa1" })).status, 403);
    }
    who = { userId: "alice" };
    assert.equal((await getStream(`${s.base}/api/ui/browser/host/stream?host=${encodeURIComponent("bad id!")}`)).status, 400);
    assert.equal((await getStream(`${s.base}/api/ui/browser/host/stream`)).status, 400);
    assert.equal((await post(s.base, "/api/ui/browser/host/reply", { host: "host-aaaa1" })).status, 400);
    assert.equal((await post(s.base, "/api/ui/browser/host/state", { host: "short" })).status, 400);
    assert.equal(relay.hostCount(), 0);
  } finally { await s.close(); }
});

test("R9 토큰 머리글(Authorization) 없이 온 요청은 신원이 있어도 401 — 쿠키만으로는 화면을 못 붙인다", async () => {
  //  쿠키(SameSite=Lax)는 사람이 연 다른 페이지의 최상위 이동에도 실린다 — 그 길로 «답하지 않는 화면» 을 붙여 AI 명령을 삼키게 할 수 있다.
  //   데스크톱 앱 화면은 늘 토큰 머리글로 붙는다(browser-host headers()).
  const relay = new BrowserRelay();
  const s = await server(() => ({ userId: "alice" }), relay);
  try {
    assert.equal((await getStream(`${s.base}/api/ui/browser/host/stream?host=host-aaaa1`, false)).status, 401);
    assert.equal((await post(s.base, "/api/ui/browser/host/state", { host: "host-aaaa1" }, false)).status, 401);
    assert.equal((await post(s.base, "/api/ui/browser/host/reply", { host: "host-aaaa1", id: "x" }, false)).status, 401);
    assert.equal(relay.hostCount(), 0);
  } finally { await s.close(); }
});

test("R8 같은 화면 id 를 다른 사람이 스트림으로 열면 오류 프레임 후 닫히고 원래 화면은 남는다", async () => {
  const relay = new BrowserRelay();
  let who: Partial<LivelyUser> = { userId: "alice" };
  const s = await server(() => who, relay);
  const mine = openStream(`${s.base}/api/ui/browser/host/stream?host=host-aaaa1`);
  try {
    await until(() => mine.frames.some((f) => f.event === "hello"));
    who = { userId: "mallory" };
    const theirs = openStream(`${s.base}/api/ui/browser/host/stream?host=host-aaaa1`);
    await until(() => theirs.ended);
    assert.ok(theirs.frames.some((f) => f.event === "error"), "오류 프레임이 없다");
    assert.ok(!theirs.frames.some((f) => f.event === "hello"), "남의 화면 id 로 hello 를 받았다");
    assert.equal(relay.hostsFor(relayKey(null, "alice")).length, 1, "원래 화면이 빠졌다");
    assert.equal(relay.hostsFor(relayKey(null, "mallory")).length, 0);
    assert.equal(mine.ended, false, "원래 스트림이 닫혔다");
  } finally {
    mine.ctl.abort();
    await mine.done;
    await s.close();
  }
});
