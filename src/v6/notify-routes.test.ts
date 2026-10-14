import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerNotifyRoutes, wantsAllWorkspaces, type NotifyRouteResolver } from "./notify-routes.js";
import { publishNotify, notifyStreamCount, type NotifyRoute, type NotifySessionEvent, type NotifyWorkspace } from "./notify-bus.js";

// ── 알림 스트림 라우트 (#4054) — 사양 표 S14~S16 · 청함(`?all=1`) ─────────────────────
//  실제 express 라우트에 실제 HTTP 로 붙어 SSE 프레임을 읽는다. 받는 자리 판정(resolver)만 대본으로 갈아 끼운다.

const OWN: NotifyWorkspace = { slug: "primary", name: "", current: true, via: "same" };
const B: NotifyWorkspace = { slug: "ws-b", name: "B", current: false, via: "enter", enter: "https://cp.example/ws/00000000-0000-0000-0000-000000000001/enter" };
const ownRoutes = (name = "우리"): NotifyRoute[] => [{ ws: "primary", member: "alice", label: { ...OWN, name } }];
const wide = (): NotifyRoute[] => [...ownRoutes(), { ws: "ws-b", account: "acct-1", label: B }];

const ev = (id: string): NotifySessionEvent => ({ type: "session", id, name: "세션", prev: "busy", phase: "idle", key: `k-${id}`, ts: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("기다린 상태가 오지 않았다");
    await sleep(5);
  }
}

/** 서버를 띄우고 스트림에 붙는다. events 에 받은 사건이 쌓인다. */
async function open(resolver: NotifyRouteResolver | undefined, query: string, refreshMs?: number) {
  const app = express();
  registerNotifyRoutes(app, [(_req, _res, next) => next()], () => "alice", resolver, refreshMs ? { refreshMs } : {});
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/ui/notify/stream${query}`, { signal: ctl.signal, headers: { Accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  const events: NotifySessionEvent[] = [];
  let opened = false;
  const pump = (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const f of parts) {
          if (f.startsWith(": ok")) opened = true;
          const data = f.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch { /* abort */ }
  })();
  await until(() => opened);
  const close = async () => {
    ctl.abort();
    await pump;
    await new Promise((r) => server.close(r));
    await until(() => notifyStreamCount() === 0);
  };
  return { events, close };
}

test("S14 스트림이 열리는 즉시 자기 워크스페이스 사건을 받는다 — 계정 서버 확인을 기다리는 동안에도", async () => {
  let release: (v: { routes: NotifyRoute[]; transient: boolean }) => void = () => {};
  const calls: boolean[] = [];
  const resolver: NotifyRouteResolver = (_req, _me, all) => { calls.push(all); return new Promise((r) => { release = r; }); };
  const s = await open(resolver, "?all=1");
  try {
    assert.deepEqual(calls, [true], "청함(all=1)이 판정에 전달되지 않았다");
    assert.equal(publishNotify({ ws: "primary", member: "alice" }, ev("e1")), 1, "확인 전 자기 워크스페이스 사건을 놓쳤다");
    assert.equal(publishNotify({ ws: "ws-b", member: "alice", account: "acct-1" }, ev("e2")), 0, "확인 전인데 다른 워크스페이스를 받았다");
    release({ routes: wide(), transient: false });
    await until(() => publishNotify({ ws: "ws-b", member: "zz", account: "acct-1" }, ev("e3")) === 1);
    await until(() => s.events.length === 2);
    assert.deepEqual(s.events.map((e) => [e.id, e.ws]), [["e1", OWN], ["e3", B]]);
  } finally { await s.close(); }
});

test("S15 이미 넓힌 뒤 계정 서버가 잠깐 안 잡히면(transient) 넓힌 목록을 지킨다", async () => {
  const script = [{ routes: wide(), transient: false }, { routes: ownRoutes(), transient: true }];
  let n = 0;
  const resolver: NotifyRouteResolver = async () => script[Math.min(n++, script.length - 1)]!;
  const s = await open(resolver, "?all=1", 20);
  try {
    await until(() => n >= 3);   // 넓힘 → 일시 실패 → 일시 실패
    assert.equal(publishNotify({ ws: "ws-b", member: "zz", account: "acct-1" }, ev("t1")), 1, "일시 실패로 다른 워크스페이스 알림이 끊겼다");
  } finally { await s.close(); }
});

test("S16 계정 서버가 확답(구성원 아님 등)으로 좁히면 다른 워크스페이스는 끊기고 자기 워크스페이스는 남는다", async () => {
  const script = [{ routes: wide(), transient: false }, { routes: ownRoutes(), transient: false }, { routes: ownRoutes(), transient: true }];
  let n = 0;
  const resolver: NotifyRouteResolver = async () => script[Math.min(n++, script.length - 1)]!;
  const s = await open(resolver, "?all=1", 20);
  try {
    await until(() => n >= 4);
    assert.equal(publishNotify({ ws: "ws-b", member: "zz", account: "acct-1" }, ev("n1")), 0, "좁혀진 뒤에도 다른 워크스페이스를 받는다");
    assert.equal(publishNotify({ ws: "primary", member: "alice" }, ev("n2")), 1);
    await until(() => s.events.length === 1);
    assert.deepEqual(s.events[0]!.ws, { ...OWN, name: "우리" }, "좁힌 목록의 이름이 붙지 않았다");
  } finally { await s.close(); }
});

test("청하지 않은 클라이언트(웹 셸)는 판정을 한 번만 받고, 다시 확인하지도 않는다", async () => {
  const calls: boolean[] = [];
  const resolver: NotifyRouteResolver = async (_req, _me, all) => { calls.push(all); return { routes: ownRoutes(), transient: false }; };
  const s = await open(resolver, "", 10);
  try {
    await sleep(80);
    assert.deepEqual(calls, [false]);
  } finally { await s.close(); }
});

test("판정이 없어도(검증 하네스) 자기 워크스페이스는 받는다 · 끊으면 구독이 사라진다", async () => {
  const s = await open(undefined, "?all=1");
  assert.equal(publishNotify({ ws: "primary", member: "alice" }, ev("h1")), 1);
  await until(() => s.events.length === 1);
  await s.close();
  assert.equal(notifyStreamCount(), 0);
});

test("청함 판정 — all=1·true 만(그 밖의 값은 청하지 않은 것)", () => {
  assert.equal(wantsAllWorkspaces({ all: "1" }), true);
  assert.equal(wantsAllWorkspaces({ all: "true" }), true);
  assert.equal(wantsAllWorkspaces({ all: ["1", "0"] }), true);
  for (const q of [{}, { all: "0" }, { all: "" }, { all: "yes" }, null, undefined]) assert.equal(wantsAllWorkspaces(q), false, JSON.stringify(q));
});

test("배선 — web.ts 가 스트림에 실제 판정(resolveNotifyRoutes)을 넘긴다", () => {
  const src = readFileSync(new URL("../../src/web.ts", import.meta.url), "utf8");
  const call = /registerNotifyRoutes\(app,[\s\S]{0,200}?\)\);/.exec(src)?.[0] ?? "";
  assert.ok(call, "registerNotifyRoutes 호출을 못 찾았다");
  assert.match(call, /resolveNotifyRoutes\(userOf\(req\), me, all\)/, "판정 없이 등록하면 다른 워크스페이스 알림이 영영 안 온다");
});

test("배선 — 훅 보고의 발행이 «워크스페이스 + 사람 + (있으면) 계정» 으로 나간다", () => {
  const src = readFileSync(new URL("../../src/terminal/routes.ts", import.meta.url), "utf8");
  const body = /const notifyPhaseChange = async[\s\S]{0,900}?\n  \};/.exec(src)?.[0] ?? "";
  assert.ok(body, "notifyPhaseChange 를 못 찾았다");
  assert.match(body, /publishNotify\(\{ ws: hereSlug\(\), member: owner, account \}/, "발행 주소에 워크스페이스가 빠지면 다른 워크스페이스 스트림으로 샌다");
  assert.match(body, /accountRoutesActive\(\) \? await notifyAccountOf\(owner\) : null/, "계정 조회는 계정으로 받는 스트림이 있을 때만(핫패스)");
});

test("배선 — 알림 피드 응답에 자기 워크스페이스 표시가 실린다(앱의 폴링·사람 알림 배너 윗줄)", () => {
  const src = readFileSync(new URL("../../src/capabilities/notify.ts", import.meta.url), "utf8");
  assert.match(src, /const workspace = await hereWorkspaceLabel\(\)/);
  assert.match(src, /return \{ items: [^\n]*, prefs, workspace, now:/);
});
