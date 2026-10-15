// 앱 주소 큰 파일 흘려 보내기(#4481 격리 리뷰 B1) — 실제 express 라우트(registerAppFrontRoutes)로 저장소 쪽 흐름이 도중에 끊기는 경우를 본다.
// 실행: npm run build && node dist/apps/app-front-stream.test.js
//  S1 압축(gzip) 해서 보내다 저장소 흐름이 오류를 내도 프로세스에 처리 안 된 오류가 0 · 그 응답은 끊긴다 · 다음 요청은 그대로 200
//  S2 압축 없이 보내다 오류 — 같은 기준
//  S3 받는 쪽(브라우저)이 도중에 끊으면 저장소 흐름도 걷힌다(destroy — S3 연결이 매달려 남지 않게) · 처리 안 된 오류 0
//  이게 틀리면: 큰 앱 파일(1MB 넘음)을 내려받던 중 S3 연결 하나가 끊기는 것만으로 공용 게이트웨이가 통째로 내려간다.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import express from "express";
import { signAppFront } from "./app-front-auth.js";
import { clearFrontBundleCacheForTest, registerAppFrontRoutes, type AppFrontDeps } from "./app-front-routes.js";
import type { OrgMember } from "../org/store/members.js";
import type { OrgApp } from "../org/store/apps.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const uncaught: unknown[] = [];
process.on("uncaughtException", (e) => { uncaught.push(e); });
process.on("unhandledRejection", (e) => { uncaught.push(e); });

const SECRET = "s3cret";
const T = { id: "11111111-1111-1111-1111-111111111111", slug: "lively-46e3" };
const ENV = { LIVELY_TENANT_HEADER_SECRET: SECRET, LIVELY_APP_DOMAIN: "lvly.app" } as NodeJS.ProcessEnv;
const sign = (): string => signAppFront(SECRET, { op: "act", t: T.id, ws: T.slug, app: "web", var: "pub", mid: "bob", iat: Math.floor(Date.now() / 1000) } as never);
const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

const BIG = 3 * 1024 * 1024;                                    // 1MB 넘는 파일은 흘려 보낸다(app-front-routes)
const bigHash = sha("big-file-name-only");                     // 내용은 흐름이 만든다 — 지문은 이름 구실만
const smallBody = Buffer.from("console.log('ok');" + "y".repeat(2000));
const MAN = { web: { root: "dist" }, ui: { pages: [{ key: "main", title: "웹", entry: "dist/index.html" }] } };
const bundle = { v: 1, files: [
  { p: "dist/assets/big-AbCd12Ef.js", h: bigHash, s: BIG },
  { p: "dist/assets/small-AbCd12Ef.js", h: sha(smallBody), s: smallBody.length },
  { p: "dist/index.html", h: sha("<p>x</p>"), s: 8 },
].sort((a, b) => (a.p < b.p ? -1 : 1)) };

/** 앞 몇 덩이를 낸 뒤 오류를 내거나(fail) 끝없이 천천히 내는(slow) 저장소 흐름. */
function source(mode: "fail" | "slow"): Readable & { destroyedSeen?: boolean } {
  let sent = 0;
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const s: Readable & { destroyedSeen?: boolean } = new Readable({
    read() {
      sent++;
      if (mode === "fail" && sent > 3) { setImmediate(() => this.destroy(Object.assign(new Error("socket hang up (가짜 S3)"), { code: "ECONNRESET" }))); return; }
      if (mode === "slow") { setTimeout(() => this.push(chunk), 5); return; }
      this.push(chunk);
    },
    destroy(err, cb) { s.destroyedSeen = true; cb(err); },
  });
  return s;
}

//  상태는 객체에 — 닫힌 함수(readBlob)가 바꾸는 값을 TS 가 «null 그대로» 로 좁히지 않게.
const st: { last: (Readable & { destroyedSeen?: boolean }) | null; mode: "fail" | "slow" } = { last: null, mode: "fail" };
const reset = (m: "fail" | "slow"): void => { st.mode = m; st.last = null; };
const member = { id: "bob", kind: "human", display_name: "bob", email: "bob@x.io", state: "active", scopes: [] } as unknown as OrgMember;
const app = {
  id: "web", title: "웹", version: "1", manifest: MAN, source: { kind: "inline" }, content_hash: "h1", status: "active", enabled: true,
  installed_by: "alice", visibility: "all", published_version_no: 1, current_version_no: 1, draft_by: null, owner_member: "alice", made_by: "alice",
} as unknown as OrgApp;
const deps = (): AppFrontDeps => ({
  env: ENV, tenant: () => T,
  getMember: async (id) => (id === "bob" ? member : null),
  getApp: async (id) => (id === "web" ? app : null),
  listUiAssets: async () => [{ page_key: "main" }],
  getUiAsset: async () => ({ page_key: "main", html: "<p>v1</p>" }),
  getAppVersion: async () => null,
  redeem: async () => null,
  scripts: async () => ({ runtime: "window.lively={}", probe: "PROBE()" }),
  versionHash: async () => ({ content_hash: "h1", has_bundle: true }),
  versionBundle: async () => ({ manifest: MAN, content_hash: "h1", bundle, bundle_store: "s3" }),
  readBlob: async (_k, h) => {
    if (h === bigHash) { st.last = source(st.mode); return st.last; }
    return h === sha(smallBody) ? smallBody : Buffer.from("<p>x</p>");
  },
});

clearFrontBundleCacheForTest();
const ex = express();
registerAppFrontRoutes(ex, deps);
const server = http.createServer(ex);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as AddressInfo).port;

/** 요청 하나 — 응답이 끝났나(end) · 끊겼나(aborted/error) · 받은 바이트. abortAfter 를 주면 그만큼 받고 이쪽에서 끊는다. */
function get(p: string, opt: { gzip?: boolean; abortAfter?: number } = {}): Promise<{ status: number; bytes: number; ended: boolean; cut: boolean; enc: string | undefined }> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/api/app-front/page?path=${encodeURIComponent(p)}`,
      headers: { "x-lvly-app-front": sign(), ...(opt.gzip ? { "accept-encoding": "gzip" } : {}) } }, (res) => {
      let bytes = 0, ended = false, cut = false, settled = false;
      const fin = (): void => { if (settled) return; settled = true; resolve({ status: res.statusCode ?? 0, bytes, ended, cut, enc: res.headers["content-encoding"] as string | undefined }); };
      res.on("data", (c: Buffer) => {
        bytes += c.length;
        if (opt.abortAfter && bytes >= opt.abortAfter) { req.destroy(); cut = true; fin(); }
      });
      res.on("end", () => { ended = true; fin(); });
      res.on("aborted", () => { cut = true; });
      res.on("error", () => { cut = true; fin(); });
      res.on("close", () => { if (!ended) cut = true; fin(); });
    });
    req.on("error", () => resolve({ status: 0, bytes: 0, ended: false, cut: true, enc: undefined }));
    //  응답이 끝나지도 끊기지도 않고 매달리는 것도 실패다(옛 pipe 는 오류를 삼켜 그렇게 매달렸다) — 기다리지 않고 빨간불로.
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: -1, bytes: 0, ended: false, cut: false, enc: undefined }); });
  });
}
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error("시험 전체 시간 초과(30초) — 응답이 매달렸다"); process.exit(1); }, 30_000).unref();

//  본 흐름의 실패는 위 uncaughtException 기록과 섞이지 않게 여기서 받아 바로 빨간불로 끝낸다.
async function main(): Promise<void> {
  {
    reset("fail");
    const r = await get("/assets/big-AbCd12Ef.js", { gzip: true });
    await settle();
    assert.equal(r.status, 200, "머리는 이미 나갔다");
    assert.equal(r.enc, "gzip", "압축 길을 탔다(관측 장치 확인)");
    assert.ok(st.last, "저장소 흐름을 실제로 열었다");
    assert.equal(r.ended && !r.cut, false, "도중에 끊긴 응답이 «다 받음» 으로 끝나지 않는다");
    assert.deepEqual(uncaught.map(String), [], "처리 안 된 오류 0");
    const after = await get("/assets/small-AbCd12Ef.js");
    assert.equal(after.status, 200, "게이트웨이는 그대로 산다 — 다음 요청 200");
    assert.equal(after.ended, true);
    ok("S1 압축해 보내다 저장소 흐름 오류 — 처리 안 된 오류 0 · 응답 끊김 · 다음 요청 200");
  }
  {
    reset("fail");
    const r = await get("/assets/big-AbCd12Ef.js");
    await settle();
    assert.equal(r.status, 200);
    assert.equal(r.enc, undefined, "압축 없는 길(관측 장치 확인)");
    assert.ok(st.last);
    assert.ok(r.bytes < BIG, `덜 받았다(${r.bytes})`);
    assert.equal(r.ended && !r.cut, false);
    assert.deepEqual(uncaught.map(String), []);
    assert.equal((await get("/assets/small-AbCd12Ef.js")).status, 200);
    ok("S2 압축 없이 보내다 오류 — 처리 안 된 오류 0 · 덜 받고 끊김 · 다음 요청 200");
  }
  {
    reset("slow");
    const r = await get("/assets/big-AbCd12Ef.js", { gzip: true, abortAfter: 1 });
    await settle(300);
    assert.equal(r.cut, true, "이쪽에서 끊었다(관측 장치 확인)");
    assert.ok(st.last, "저장소 흐름을 열었다");
    assert.equal(st.last?.destroyedSeen, true, "받는 쪽이 끊기면 저장소 흐름도 걷힌다");
    assert.deepEqual(uncaught.map(String), []);
    assert.equal((await get("/assets/small-AbCd12Ef.js")).status, 200);
    ok("S3 받는 쪽이 끊으면 저장소 흐름 destroy · 처리 안 된 오류 0");
  }
}
main().then(() => { server.close(); console.log(`\n${pass} passed`); process.exit(0); },
  (e) => { console.error(e); process.exit(1); });
