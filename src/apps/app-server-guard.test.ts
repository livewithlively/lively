// 앱 서버 신원 검사 층(#4485 앱 v2-6) 시험 — 진짜 검사 층 글(GUARD_JS)을 이 기계의 node 로 띄우고 그 뒤에 가짜 앱을 둔다(Lambda 안과 같은 모양:
//  웹 어댑터 → 검사 층 → 앱). 사양 표 A(spec-4485.md): A1~A9 판정(게이트웨이 verifyAppIdentity 와 같은 토큰 표로 대조 · 경계 포함) ·
//  A10 · A11 새로 도입한 env 가 없을 때 · A12 머리글 · A13 준비 판정 · A14 흘려 보내기 · A15 앱에 못 닿음 · A16 그대로 넘기는 것 · 레이어 zip · bootstrap ·
//  A17 · A18 ASCII 밖 id · 이름 · A19 문 안의 오류 · A20 맞대기 표 더함(격리 리뷰 2026-10-16).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn, type ChildProcess } from "node:child_process";
import { GUARD_BOOTSTRAP_SH, GUARD_FILES, GUARD_JS, GUARD_READY_PATH, guardLayerZip } from "./app-server-guard.js";
import { ed25519FromSeed, signAppIdentity, verifyAppIdentity } from "./app-identity.js";

const WS = "11111111-2222-4333-8444-555555555555";
const APP = "deck-edit";
const key = ed25519FromSeed(crypto.createHash("sha256").update("guard-test").digest());
const other = ed25519FromSeed(crypto.createHash("sha256").update("other").digest());
const KEYS = new Map([["k1", key.publicKey]]);

const freePort = (): Promise<number> => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
async function startApp(port: number): Promise<{ seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; });
    req.on("end", async () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: 1\n\n");
        await new Promise((r) => setTimeout(r, 300));
        res.end("data: 2\n\n");
        return;
      }
      res.writeHead(207, { "content-type": "application/json", "set-cookie": ["a=1; Path=/", "b=2; Path=/"] });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  return { seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

async function startGuard(appPort: number, env: Record<string, string | undefined> = {}): Promise<{ port: number; proc: ChildProcess; stop: () => void }> {
  const port = await freePort();
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", PORT: String(appPort), LIVELY_GUARD_PORT: String(port), LIVELY_TENANT_ID: WS, LIVELY_APP_ID: APP,
    LIVELY_APP_IDENTITY_PUBKEYS: JSON.stringify({ k1: key.publicKeyB64 }) };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete base[k]; else base[k] = v; }
  const proc = spawn(process.execPath, ["-e", GUARD_JS], { stdio: ["ignore", "ignore", "ignore"], env: base });
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise<boolean>((r) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { port, proc, stop: () => { try { proc.kill("SIGKILL"); } catch { /* 이미 끝났다 */ } } };
}

function req(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string):
  Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; chunks: Array<{ at: number; s: string }> }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const r = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      const chunks: Array<{ at: number; s: string }> = [];
      res.setEncoding("utf8");
      res.on("data", (c: string) => chunks.push({ at: Date.now() - t0, s: c }));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunks.map((c) => c.s).join(""), chunks }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

const now = (): number => Math.floor(Date.now() / 1000);
type C = Partial<{ ws: string; app: string; var: "pub" | "draft"; sub: string; name: string; iat: number; exp: number }>;
const tok = (o: C = {}, priv = key.privateKey, kid = "k1"): string =>
  signAppIdentity({ ws: WS, app: APP, var: "pub", sub: "sangmin-yoon", name: "윤상민", iat: now() - 5, exp: now() + 595, ...o }, priv, kid);
/** 칸을 마음대로(형 · 값) — signAppIdentity 가 막는 모양도 서명해 만든다. */
const rawJson = (payload: unknown, priv = key.privateKey, kid = "k1"): string => {
  const input = `v1.${kid}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${input}.${crypto.sign(null, Buffer.from(input), priv).toString("base64url")}`;
};
const rawTok = (claims: Record<string, unknown>, priv = key.privateKey, kid = "k1"): string => rawJson(claims, priv, kid);

test("A1~A9 ★ 판정 = 게이트웨이 검증(verifyAppIdentity) — 같은 토큰 표 · 경계 포함 · 거부한 요청은 앱에 닿지 않는다", async () => {
  const appPort = await freePort();
  const app = await startApp(appPort);
  const g = await startGuard(appPort);
  try {
    const valid = tok();
    const [v, kid, p, s] = valid.split(".");
    const n = now();
    const rows: Array<[string, string, boolean]> = [
      ["A1 올바른 신원", valid, true],
      ["A1 초안 판", tok({ var: "draft" }), true],
      ["A1 이름 없음", signAppIdentity({ ws: WS, app: APP, var: "pub", sub: "m", iat: n, exp: n + 60 }, key.privateKey, "k1"), true],
      ["A3 조각 셋", `${v}.${kid}.${p}`, false],
      ["A3 v2", valid.replace(/^v1\./, "v2."), false],
      ["A4 모르는 kid", tok({}, key.privateKey, "k9"), false],
      ["A4 남의 키 서명", tok({}, other.privateKey), false],
      ["A4 본문 고침", `${v}.${kid}.${Buffer.from(JSON.stringify({ ws: WS, app: APP, var: "pub", sub: "admin", iat: n, exp: n + 60 })).toString("base64url")}.${s}`, false],
      ["A7 경계 수명 900초 받음", tok({ iat: n - 10, exp: n + 890 }), true],
      ["A7 경계 수명 901초 거부", tok({ iat: n - 10, exp: n + 891 }), false],
      ["A7 exp < iat 거부", rawTok({ ws: WS, app: APP, var: "pub", sub: "m", iat: n, exp: n - 1 }), false],
      ["A8 다른 워크스페이스", tok({ ws: "99999999-2222-4333-8444-555555555555" }), false],
      ["A8 워크스페이스 대문자 받음", tok({ ws: WS.toUpperCase() }), true],
      ["A9 다른 앱", tok({ app: "other-app" }), false],
      ["A9 var 틀림", rawTok({ ws: WS, app: APP, var: "prod", sub: "m", iat: n, exp: n + 60 }), false],
      ["A9 sub 빈 값", rawTok({ ws: WS, app: APP, var: "pub", sub: "", iat: n, exp: n + 60 }), false],
      ["A9 name 200자 받음", tok({ name: "가".repeat(200) }), true],
      ["A9 name 201자 거부", tok({ name: "가".repeat(201) }), false],
      ["A9 iat 정수 아님", rawTok({ ws: WS, app: APP, var: "pub", sub: "m", iat: n + 0.5, exp: n + 60 }), false],
      ["A9 4,097자", "v1.k1." + "a".repeat(4085) + ".b", false],
      //  A20 맞대기 표 더함(격리 리뷰) — 칸 길이 · 본문 꼴 · kid · base64 모양
      ["A20 sub 200자 받음", rawTok({ ws: WS, app: APP, var: "pub", sub: "a".repeat(200), iat: n, exp: n + 60 }), true],
      ["A20 sub 201자 거부", rawTok({ ws: WS, app: APP, var: "pub", sub: "a".repeat(201), iat: n, exp: n + 60 }), false],
      ["A20 본문 [] 거부", rawJson([]), false],
      ["A20 본문 null 거부", rawJson(null), false],
      ["A20 kid 33자 거부", rawTok({ ws: WS, app: APP, var: "pub", sub: "m", iat: n, exp: n + 60 }, key.privateKey, "k".repeat(33)), false],
      ["A20 kid 에 «.» 거부", rawTok({ ws: WS, app: APP, var: "pub", sub: "m", iat: n, exp: n + 60 }, key.privateKey, "k.1"), false],
      ["A20 base64 끝에 «=» 거부", `${v}.${kid}.${p}=.${s}`, false],
    ];
    let accepted = 0;
    for (const [name, t, want] of rows) {
      let gw = true;
      try { verifyAppIdentity(t, { ws: WS, app: APP }, { keys: KEYS }); } catch { gw = false; }
      assert.equal(gw, want, `사양 행이 게이트웨이 판정과 다르다 — ${name}`);
      const r = await req(g.port, "/x", { "x-lively-identity": t });
      assert.equal(r.status === 207, want, `${name}: 검사 층 ${r.status}`);
      if (!want) {
        assert.equal(r.status, 401, name);
        assert.equal(r.headers["x-lively-guard"], "denied", name);
        assert.equal(JSON.parse(r.body).error, "identity_invalid", name);
      } else accepted++;
    }
    //  A5 · A6 시각 경계 — 검사 층은 제 시계로 잰다. 초가 바뀌는 사이에 걸리지 않게 새 초의 머리에서 만들고 곧바로 보낸다.
    const edges: Array<[string, (m: number) => string, boolean]> = [
      ["A5 경계 exp = 지금−30 받음", (m) => tok({ iat: m - 600, exp: m - 30 }), true],
      ["A5 경계 exp = 지금−31 거부", (m) => tok({ iat: m - 600, exp: m - 31 }), false],
      ["A6 경계 iat = 지금+30 받음", (m) => tok({ iat: m + 30, exp: m + 300 }), true],
      ["A6 경계 iat = 지금+31 거부", (m) => tok({ iat: m + 31, exp: m + 300 }), false],
    ];
    for (const [name, make, want] of edges) {
      await new Promise((r) => setTimeout(r, 1015 - (Date.now() % 1000)));
      const m = now();
      const t = make(m);
      let gw = true;
      try { verifyAppIdentity(t, { ws: WS, app: APP }, { keys: KEYS, now: m }); } catch { gw = false; }
      assert.equal(gw, want, `사양 행이 게이트웨이 판정과 다르다 — ${name}`);
      const r = await req(g.port, "/x", { "x-lively-identity": t });
      assert.equal(r.status === 207, want, `${name}: 검사 층 ${r.status}`);
      if (want) accepted++;
    }
    //  A2 · A3 빈 값 — 머리가 없거나 비었다
    for (const h of [{}, { "x-lively-identity": "" }, { "x-lively-identity": "   " }]) {
      const r = await req(g.port, "/x", h as Record<string, string>);
      assert.equal(r.status, 401, JSON.stringify(h));
      assert.equal(JSON.parse(r.body).error, "identity_required");
    }
    assert.equal(app.seen.length, accepted, "거부한 요청이 앱에 닿았다");
  } finally {
    g.stop();
    await app.close();
  }
});

test("A10 · A11 ★ 새로 도입한 env 가 없으면 — 공개 키 없음 · 깨진 JSON · 워크스페이스 · 앱 id 없음 → 모든 요청 거부(앱 0)", async () => {
  const appPort = await freePort();
  const app = await startApp(appPort);
  try {
    for (const env of [
      { LIVELY_APP_IDENTITY_PUBKEYS: undefined }, { LIVELY_APP_IDENTITY_PUBKEYS: "" }, { LIVELY_APP_IDENTITY_PUBKEYS: "{not json" },
      { LIVELY_APP_IDENTITY_PUBKEYS: JSON.stringify({ k1: "short" }) },
      { LIVELY_TENANT_ID: undefined }, { LIVELY_APP_ID: undefined }, { LIVELY_TENANT_ID: "" },
    ] as Array<Record<string, string | undefined>>) {
      const g = await startGuard(appPort, env);
      try {
        const r = await req(g.port, "/x", { "x-lively-identity": tok() });
        assert.equal(r.status, 401, JSON.stringify(env));
      } finally { g.stop(); }
    }
    assert.equal(app.seen.length, 0);
  } finally { await app.close(); }
});

test("A12 · A16 앱이 받는 것 — 검사한 구성원 · 이름 · 판으로 다시 쓴다 · 그 밖 x-lively-* 없음 · 신원 원문 · 메서드 · 쿼리 · 본문 · 쿠키 · 상태 · 쿠키 여러 줄 그대로", async () => {
  const appPort = await freePort();
  const app = await startApp(appPort);
  const g = await startGuard(appPort);
  try {
    const t = tok({ var: "draft" });
    const r = await req(g.port, "/api/items?x=%ED%95%9C&y=1", {
      "x-lively-identity": t, "x-lively-member": "admin", "x-lively-member-name": "x", "x-lively-variant": "pub", "x-lively-other": "1",
      cookie: "c=1; d=2", "content-type": "application/json",
    }, "PATCH", JSON.stringify({ a: 1 }));
    assert.equal(r.status, 207);
    assert.deepEqual(r.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
    const s = app.seen.at(-1)!;
    assert.equal(s.method, "PATCH");
    assert.equal(s.url, "/api/items?x=%ED%95%9C&y=1");
    assert.equal(s.body, JSON.stringify({ a: 1 }));
    assert.equal(s.headers["x-lively-member"], "sangmin-yoon", "들어온 x-lively-member 를 믿었다");
    assert.equal(decodeURIComponent(String(s.headers["x-lively-member-name"])), "윤상민");
    assert.equal(s.headers["x-lively-variant"], "draft");
    assert.equal(s.headers["x-lively-identity"], t, "SDK 가 다시 실을 신원 원문이 없다");
    assert.equal(s.headers["x-lively-other"], undefined);
    assert.equal(s.headers.cookie, "c=1; d=2");
  } finally {
    g.stop();
    await app.close();
  }
});

test("A17 · A18 ★ ASCII 밖 구성원 id · 이름(한글 · 이모지 · 짝 없는 대리 문자) — 매달리지 않고 앱에 닿는다 · 머리글은 퍼센트 인코딩(풀면 그 값)", async () => {
  const appPort = await freePort();
  const app = await startApp(appPort);
  const g = await startGuard(appPort);
  try {
    const n = now();
    const cases: Array<[string, string, string]> = [
      ["ASCII id 는 그대로", "sangmin-yoon", "sangmin-yoon"],
      ["한글 id(이메일 없는 구성원)", "윤상민", encodeURIComponent("윤상민")],
      ["이모지", "emoji😀", encodeURIComponent("emoji😀")],
      ["짝 없는 대리 문자 — U+FFFD 로 바로잡음", "a\ud800b", "a%EF%BF%BDb"],
    ];
    for (const [why, sub, wantHeader] of cases) {
      const t = rawTok({ ws: WS, app: APP, var: "pub", sub, name: sub, iat: n, exp: n + 60 });
      let gw = true;
      try { verifyAppIdentity(t, { ws: WS, app: APP }, { keys: KEYS }); } catch { gw = false; }
      assert.equal(gw, true, `${why}: 게이트웨이는 받는 토큰이다(그래서 검사 층도 답해야 한다)`);
      const r = await Promise.race([
        req(g.port, "/x", { "x-lively-identity": t }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${why}: 2초 안에 답이 없다(매달림)`)), 2000)),
      ]);
      assert.equal(r.status, 207, why);
      const seen = app.seen.at(-1)!;
      assert.equal(seen.headers["x-lively-member"], wantHeader, why);
      assert.equal(seen.headers["x-lively-member-name"], wantHeader, `${why}(이름)`);
      assert.equal(decodeURIComponent(String(seen.headers["x-lively-member"])), sub.replace("\ud800", "\ufffd"), `${why}: 풀면 그 값`);
    }
  } finally {
    g.stop();
    await app.close();
  }
});

test("A19 ★ 검사 층 안의 예기치 못한 오류(앱으로 갈 요청을 못 만듦) — 매달리지 않고 500 JSON · x-lively-guard: error", async () => {
  //  앱 포트가 틀리면(70000) 앱으로 가는 요청을 만드는 순간 동기로 던진다 — 감싸지 않으면 답이 안 나가 함수 시간까지 매달린다.
  const g = await startGuard(70000);
  try {
    const r = await Promise.race([
      req(g.port, "/x", { "x-lively-identity": tok() }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("2초 안에 답이 없다(매달림)")), 2000)),
    ]);
    assert.equal(r.status, 500);
    assert.equal(r.headers["x-lively-guard"], "error");
    assert.equal(JSON.parse(r.body).error, "guard_error");
    //  다음 요청도 받는다(프로세스가 살아 있다)
    assert.equal((await req(g.port, "/x", { "x-lively-identity": tok() })).status, 500);
  } finally { g.stop(); }
});

test("A13 준비 판정 — 앱 포트 닫힘 503 · 열림 200 · 신원 없이 · 그 경로는 앱에 안 간다", async () => {
  const appPort = await freePort();
  const g = await startGuard(appPort);
  try {
    const before = await req(g.port, GUARD_READY_PATH);
    assert.equal(before.status, 503);
    assert.equal(before.headers["x-lively-guard"], "app-not-ready");
    const app = await startApp(appPort);
    try {
      const after = await req(g.port, `${GUARD_READY_PATH}?x=1`);
      assert.equal(after.status, 200);
      assert.equal(after.headers["x-lively-guard"], "ready");
      assert.equal(app.seen.length, 0, "준비 판정이 앱에 닿았다");
      assert.equal((await req(g.port, "/")).status, 401, "신원 없는 보통 요청");
    } finally { await app.close(); }
  } finally { g.stop(); }
});

test("A14 흘려 보내기 — 앱이 조각으로 보내면 받는 쪽도 조각으로(모았다 보내지 않는다)", async () => {
  const appPort = await freePort();
  const app = await startApp(appPort);
  const g = await startGuard(appPort);
  try {
    const r = await req(g.port, "/stream", { "x-lively-identity": tok() });
    assert.equal(r.status, 200);
    assert.equal(r.body, "data: 1\n\ndata: 2\n\n");
    assert.ok(r.chunks.length >= 2 && r.chunks.at(-1)!.at - r.chunks[0]!.at >= 200, `첫 조각이 늦게 왔다(모았다 보냈다): ${JSON.stringify(r.chunks)}`);
  } finally {
    g.stop();
    await app.close();
  }
});

test("A15 앱에 못 닿음 — 502 app-unreachable", async () => {
  const appPort = await freePort();
  const g = await startGuard(appPort);
  try {
    const r = await req(g.port, "/", { "x-lively-identity": tok() });
    assert.equal(r.status, 502);
    assert.equal(r.headers["x-lively-guard"], "app-unreachable");
  } finally { g.stop(); }
});

/** 저장(압축 없음) zip 을 읽는다 — 이름 · 권한 · 내용 · CRC. */
function readStoreZip(zip: Buffer): Array<{ name: string; mode: number; data: Buffer; crcOk: boolean }> {
  const out: Array<{ name: string; mode: number; data: Buffer; crcOk: boolean }> = [];
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = zip.readUInt16LE(eocd + 10);
  let o = zip.readUInt32LE(eocd + 16);
  const z = zlib as unknown as { crc32: (b: Buffer) => number };
  for (let i = 0; i < n; i++) {
    assert.equal(zip.readUInt32LE(o), 0x02014b50);
    const crc = zip.readUInt32LE(o + 16), size = zip.readUInt32LE(o + 24), nl = zip.readUInt16LE(o + 28);
    const ext = zip.readUInt32LE(o + 38), lo = zip.readUInt32LE(o + 42);
    const name = zip.subarray(o + 46, o + 46 + nl).toString("utf8");
    const lnl = zip.readUInt16LE(lo + 26), lel = zip.readUInt16LE(lo + 28);
    const data = Buffer.from(zip.subarray(lo + 30 + lnl + lel, lo + 30 + lnl + lel + size));
    out.push({ name, mode: (ext >>> 16) & 0o7777, data, crcOk: (z.crc32(data) >>> 0) === crc });
    o += 46 + nl + zip.readUInt16LE(o + 30) + zip.readUInt16LE(o + 32);
  }
  return out;
}

test("레이어 zip — 두 파일(bootstrap 0755 · guard.cjs 0644) · CRC · 같은 글이면 같은 바이트 · 지문", () => {
  const a = guardLayerZip(), b = guardLayerZip();
  assert.ok(a.zip.equals(b.zip), "같은 글인데 zip 바이트가 다르다(결정적이 아니다)");
  assert.equal(a.sha256, crypto.createHash("sha256").update(a.zip).digest("hex"));
  const files = readStoreZip(a.zip);
  assert.deepEqual(files.map((f) => [f.name, f.mode.toString(8)]), [[GUARD_FILES.bootstrap, "755"], [GUARD_FILES.guard, "644"]]);
  assert.ok(files.every((f) => f.crcOk), "CRC 가 틀렸다");
  assert.equal(files[0]!.data.toString("utf8"), GUARD_BOOTSTRAP_SH);
  assert.equal(files[1]!.data.toString("utf8"), GUARD_JS);
});

test("bootstrap — 검사 층을 먼저(백그라운드) 띄우고 핸들러(앱 시작 스크립트)를 exec 한다", () => {
  const lines = GUARD_BOOTSTRAP_SH.split("\n");
  assert.equal(lines[0], "#!/bin/sh");
  const iGuard = lines.findIndex((l) => l.includes("/opt/lively/guard.cjs") && l.trim().endsWith("&"));
  const iExec = lines.findIndex((l) => l.startsWith("exec ") && l.includes("${LAMBDA_TASK_ROOT}/${_HANDLER}"));
  assert.ok(iGuard > 0 && iExec > iGuard, GUARD_BOOTSTRAP_SH);
});
