// 앱 서버 신원 검사 층(#4485 앱 v2-6) — 앱 서버 함수 **안에서** 앱 코드보다 먼저 사람 신원(X-Lively-Identity)을 검사하는 작은 문.
//
//  설계(v2-0 ③ 상민 2026-09-30 · §13-10 · §19 v2-6 결정 2026-10-16): 앱 코드는 아무것도 하지 않는다. 우리가 붙이는 층이 앱보다 먼저
//   서명(Ed25519 · 공개 키 LIVELY_APP_IDENTITY_PUBKEYS)을 보고, 없거나 틀리면 앱에 닿기 전에 401 로 끊는다. 함수 주소(Function URL)는
//   만들지 않아 인터넷에서 함수를 부를 길이 없다(게이트웨이만 부른다) — 이 층은 «AWS 자격으로 함수를 직접 부른 요청» 까지 막는 두 번째 벽이고,
//   v2-12 app_call(자동화가 앱 자체 주체로 부름)도 같은 층을 쓴다.
//
//  자리(레이어 `<접두>guard` — app-server-layer.ts 가 코어 판마다 올린다): /opt/lively/bootstrap · /opt/lively/guard.cjs
//   함수 설정: AWS_LAMBDA_EXEC_WRAPPER=/opt/lively/bootstrap(웹 어댑터의 /opt/bootstrap 자리 — 그쪽은 `exec $LAMBDA_TASK_ROOT/$_HANDLER` 한 줄이다).
//   bootstrap 이 이 문을 먼저 띄우고 앱의 시작 스크립트(lively-run.sh)를 실행한다. 웹 어댑터(확장)는 요청을 AWS_LWA_PORT(이 문)로 보내고,
//   이 문이 검사한 뒤 앱($PORT)으로 넘긴다. 준비 판정도 이 문(/_lively/guard/ready — 앱 포트가 열렸을 때만 200)으로 해서
//   «문이 떴고 앱도 떴다» 를 함께 본다. `/_lively/*` 는 앱 주소 앞단이 앱으로 보내지 않는 우리 자리라 앱 경로와 겹치지 않는다.
//  2026-10-16 실측(시험 함수 lvly-app-proto-4485-a, 지움): 차가운 시작 Init 226~298ms(문 없이 157~203ms) · 따뜻한 요청 함수 안 시간 +0.8ms ·
//   흘려 보내기 · 쿠키 · 4.5MB 본문 · 7MB 응답 · 위조 · 만료 · 다른 앱 신원 거부 · 앱이 $PORT 를 안 열면 20초 뒤 «did not become ready».
//
//  ⚠ guardMain 은 `.toString()` 으로 글이 되어 Lambda 안 node 에서 돈다 — **바깥 이름(import · 이 파일의 상수)을 쓰면 안 된다**(빌더와 같은 규율).
//   검사 규칙은 src/apps/app-identity.ts verifyAppIdentity 와 같아야 한다 — 시험(app-server-guard.test)이 같은 토큰 표로 둘을 대조한다.
import crypto from "node:crypto";
import { crc32 } from "../util/crc32.js";

declare const require: (id: string) => unknown;   // guardMain 이 Lambda 안에서 CommonJS 로 돌 때의 require — 이 모듈(ESM) 자체는 부르지 않는다

/** 문 판 — 레이어 설명에 들어간다(사람이 보는 표지 · 실제 같고 다름은 내용 지문으로 가른다). */
export const GUARD_VERSION = 1;
/** 문이 받는 포트(웹 어댑터 AWS_LWA_PORT) — 앱은 $PORT(8080)에서 받는다. */
export const GUARD_PORT = 8099;
export const APP_PORT = 8080;
/** 준비 판정 경로 — 앱 포트가 열렸을 때만 200. 앱 주소 앞단은 `/_lively/*` 를 앱으로 보내지 않는다. */
export const GUARD_READY_PATH = "/_lively/guard/ready";
/** 문이 붙이는 응답 머리글 — ready(준비 판정) · denied(신원 거부) · app-unreachable(앱에 못 닿음). 시험 호출이 «문이 있다» 를 이것으로 본다. */
export const GUARD_HEADER = "x-lively-guard";
/** 레이어 안 경로(/opt 아래). */
export const GUARD_BOOTSTRAP_PATH = "/opt/lively/bootstrap";
export const GUARD_FILES = { bootstrap: "lively/bootstrap", guard: "lively/guard.cjs" } as const;

function guardMain(): void {
  const http = require("node:http") as typeof import("node:http");
  const net = require("node:net") as typeof import("node:net");
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const env = process.env;
  const GUARD_PORT = Number(env.LIVELY_GUARD_PORT) || 8099;
  const APP_PORT = Number(env.PORT) || 8080;
  const APP_HOST = "127.0.0.1";
  const WS = String(env.LIVELY_TENANT_ID || "").trim().toLowerCase();
  const APP = String(env.LIVELY_APP_ID || "").trim();
  const READY_PATH = "/_lively/guard/ready";
  const GUARD = "x-lively-guard";
  //  app-identity.ts 와 같은 값 — APP_IDENTITY_MAX_TTL_SEC · APP_IDENTITY_SKEW_SEC · MAX_TOKEN_LEN · 칸 규칙.
  const MAX_TTL = 900, SKEW = 30, MAX_LEN = 4096;
  const KID_RE = /^[A-Za-z0-9_-]{1,32}$/, B64_RE = /^[A-Za-z0-9_-]+$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, APP_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

  const keys = new Map<string, import("node:crypto").KeyObject>();
  try {
    const o = JSON.parse(String(env.LIVELY_APP_IDENTITY_PUBKEYS || "{}")) as Record<string, unknown>;
    for (const [kid, v] of Object.entries(o || {})) {
      if (!KID_RE.test(kid) || typeof v !== "string" || !B64_RE.test(v) || Buffer.from(v, "base64url").length !== 32) continue;
      try { keys.set(kid, crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: v }, format: "jwk" })); } catch { /* 버린다 */ }
    }
  } catch { /* 키 없음 — 모든 요청을 거부한다(받는 쪽으로 새지 않는다) */ }

  type Claims = { sub: string; name: string; var: "pub" | "draft" };
  const verify = (raw: unknown, now: number): { claims: Claims } | { why: string } => {
    const t = String((Array.isArray(raw) ? raw[0] : raw) ?? "").trim();
    if (!t) return { why: "missing" };
    if (t.length > MAX_LEN) return { why: "too_long" };
    const p = t.split(".");
    if (p.length !== 4 || p[0] !== "v1") return { why: "format" };
    const kid = p[1]!, pb = p[2]!, sb = p[3]!;
    if (!KID_RE.test(kid) || !B64_RE.test(pb) || !B64_RE.test(sb)) return { why: "format" };
    const key = keys.get(kid);
    if (!key) return { why: "unknown_key" };
    const sig = Buffer.from(sb, "base64url");
    if (sig.length !== 64) return { why: "signature" };
    let ok = false;
    try { ok = crypto.verify(null, Buffer.from(`v1.${kid}.${pb}`, "utf8"), key, sig); } catch { ok = false; }
    if (!ok) return { why: "signature" };
    let c: Record<string, unknown>;
    try {
      const v = JSON.parse(Buffer.from(pb, "base64url").toString("utf8")) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return { why: "payload" };
      c = v as Record<string, unknown>;
    } catch { return { why: "payload" }; }
    const ws = typeof c.ws === "string" ? c.ws.toLowerCase() : "";
    const app = typeof c.app === "string" ? c.app : "";
    const sub = typeof c.sub === "string" ? c.sub : "";
    if (!UUID_RE.test(ws) || !APP_RE.test(app) || !sub || sub.length > 200) return { why: "claims" };
    if (c.var !== "pub" && c.var !== "draft") return { why: "claims" };
    const iat = c.iat as number, exp = c.exp as number;
    if (!Number.isInteger(iat) || !Number.isInteger(exp)) return { why: "claims" };
    if (c.name !== undefined && (typeof c.name !== "string" || c.name.length > 200)) return { why: "claims" };
    if (exp < now - SKEW) return { why: "expired" };
    if (iat > now + SKEW) return { why: "future" };
    if (exp - iat > MAX_TTL || exp < iat) return { why: "ttl" };
    if (ws !== WS) return { why: "other_workspace" };
    if (app !== APP) return { why: "other_app" };
    return { claims: { sub, name: typeof c.name === "string" ? c.name : "", var: c.var } };
  };

  //  중계자가 넘기지 않는 머리글(RFC 9110 §7.6.1) — 본문 틀은 node 가 다시 정한다.
  const HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  let denials = 0, denialsAt = 0;

  const sendJson = (res: import("node:http").ServerResponse, status: number, mark: string, o: unknown): void => {
    const body = Buffer.from(JSON.stringify(o), "utf8");
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store", [GUARD]: mark });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    const url = String(req.url || "/");
    const path = url.split("?")[0];
    if (path === READY_PATH) {
      //  준비 판정 — 앱 포트가 열렸나. 웹 어댑터가 여기를 200 이 될 때까지 묻는다(AWS_LWA_READINESS_CHECK_*).
      const s = net.connect(APP_PORT, APP_HOST);
      let answered = false;
      const done = (ok: boolean): void => {
        if (answered) return;
        answered = true;
        s.destroy();
        sendJson(res, ok ? 200 : 503, ok ? "ready" : "app-not-ready", { guard: 1, app: ok ? "ready" : "not-ready" });
      };
      s.setTimeout(1000, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
      return;
    }
    const v = verify(req.headers["x-lively-identity"], Math.floor(Date.now() / 1000));
    if ("why" in v) {
      const now = Date.now();
      if (now - denialsAt > 60_000) { denialsAt = now; denials = 0; }
      if (++denials <= 10) console.error(`[lively-guard] 신원 거부(${v.why}) ${req.method} ${path.slice(0, 200)}`);
      sendJson(res, 401, "denied", {
        error: v.why === "missing" ? "identity_required" : "identity_invalid",
        reason: v.why,
        message: "라이블리 앱 주소를 거친 요청만 받습니다(사람 신원 X-Lively-Identity 가 없거나 맞지 않습니다).",
      });
      return;
    }
    //  앱에 넘길 머리글 — 신원 원문(SDK 가 게이트웨이 호출에 다시 싣는다)은 두고, 그 밖의 x-lively-* 는 지운 뒤 검사한 값으로 다시 쓴다.
    const headers: Record<string, string | string[]> = {};
    for (const [k, val] of Object.entries(req.headers)) {
      if (val === undefined || HOP.has(k)) continue;
      if (k.startsWith("x-lively-") && k !== "x-lively-identity") continue;
      headers[k] = val;
    }
    headers["x-lively-member"] = v.claims.sub;
    headers["x-lively-member-name"] = encodeURIComponent(v.claims.name);
    headers["x-lively-variant"] = v.claims.var;
    const preq = http.request({ host: APP_HOST, port: APP_PORT, method: req.method, path: url, headers, agent }, (pres) => {
      const out: string[] = [];
      for (let i = 0; i + 1 < pres.rawHeaders.length; i += 2) {
        const k = pres.rawHeaders[i]!;
        if (HOP.has(k.toLowerCase())) continue;
        out.push(k, pres.rawHeaders[i + 1]!);
      }
      res.writeHead(pres.statusCode || 502, pres.statusMessage, out);
      pres.on("error", () => res.destroy());
      pres.pipe(res);
    });
    preq.on("error", () => {
      if (!res.headersSent) sendJson(res, 502, "app-unreachable", { error: "app_unreachable", message: "앱 서버에 닿지 못했습니다." });
      else res.destroy();
    });
    res.on("close", () => { if (!res.writableFinished) preq.destroy(); });
    req.pipe(preq);
  });
  server.keepAliveTimeout = 60_000;
  server.on("clientError", (_e, socket) => { try { socket.destroy(); } catch { /* 이미 닫혔다 */ } });
  server.listen(GUARD_PORT, "127.0.0.1");
  process.on("uncaughtException", (e) => { console.error("[lively-guard]", (e as Error)?.message ?? e); });
}

/** Lambda 안 /opt/lively/guard.cjs 의 글. */
export const GUARD_JS = `"use strict";(${guardMain.toString()})();\n`;

/** /opt/lively/bootstrap — 웹 어댑터의 /opt/bootstrap 자리. 문을 먼저 띄우고 앱의 시작 스크립트(핸들러)를 실행한다. */
export const GUARD_BOOTSTRAP_SH = [
  "#!/bin/sh",
  "# 라이블리 앱 서버 신원 검사 층(#4485) — 검사 문(guard.cjs)을 먼저 띄우고 앱의 시작 스크립트(핸들러)를 실행한다.",
  "#  웹 어댑터 레이어의 /opt/bootstrap 과 같은 자리(그쪽은 `exec $LAMBDA_TASK_ROOT/$_HANDLER` 한 줄)라 AWS_LAMBDA_EXEC_WRAPPER 가 이 파일을 가리킨다.",
  "NODE=node",
  "command -v node >/dev/null 2>&1 || NODE=/var/lang/bin/node",
  "\"$NODE\" /opt/lively/guard.cjs &",
  "exec \"${LAMBDA_TASK_ROOT}/${_HANDLER}\"",
  "",
].join("\n");

// ── 레이어 zip(결정적 — 같은 글이면 같은 바이트 · 같은 지문) ──────────────────────────────────

/** 저장(압축 없음) zip — 파일 몇 개짜리 레이어용. 시각은 1980-01-01 00:00 고정 · 유닉스 권한을 외부 속성에 싣는다. */
export function storeZip(files: Array<{ name: string; data: Buffer; mode: number }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;   // 1980-01-01
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(((0o100000 | f.mode) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cd, end]);
}

/** 검사 층 레이어 zip + 지문(sha256 hex) — 레이어 설명에 지문을 실어 «이 판의 문이 이미 올라가 있나» 를 가른다. */
export function guardLayerZip(): { zip: Buffer; sha256: string } {
  const zip = storeZip([
    { name: GUARD_FILES.bootstrap, data: Buffer.from(GUARD_BOOTSTRAP_SH, "utf8"), mode: 0o755 },
    { name: GUARD_FILES.guard, data: Buffer.from(GUARD_JS, "utf8"), mode: 0o644 },
  ]);
  return { zip, sha256: crypto.createHash("sha256").update(zip).digest("hex") };
}
