import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";

// 서명 주소 끝단(#4673) — 사양 표 J1~J18 · K1~K6. 진짜 라우트(express) · 진짜 파일(임시 폴더)에 DB 쪽만 가짜를 꽂는다.
//  발급(mintFileUrl) → 받는 곳(fileUrlRouter) 을 실제 HTTP 로 잇는다 — 앱 서버(Lambda)가 할 일 그대로.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lively-file-url-"));
process.env.LIVELY_MEMBER_ISOLATION = "off";   // 파일 op 는 이 프로세스의 fs 로(격리 멤버 uid 없음)
process.env.TERMINAL_ROOT_SHARED = path.join(ROOT, "shared");
process.env.TERMINAL_ROOT_APPS = path.join(ROOT, "apps");
process.env.TERMINAL_ROOT_PERSONAL = path.join(ROOT, "box");
for (const d of ["shared", "apps", "box"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

const { fileUrlRouter } = await import("./signed-routes.js");
const { mintFileUrl } = await import("./file-url.js");
const { fileUrlKey, signFileUrlToken } = await import("./file-url-token.js");
const { logger } = await import("../log.js");
const { parseAddress } = await import("./address.js");
type Principal = import("./file-access.js").FilePrincipal;

const KEY = fileUrlKey({ CONNECTOR_SECRET_KEY: "file-url-test-master" })!;
const app = (id: string, over: Partial<OrgApp> = {}): OrgApp => ({
  id, title: id, version: "1.0.0", manifest: { permissions: { tools: ["file_url"], app_folder: true } }, source: {}, content_hash: null,
  status: "active", enabled: true, installed_by: "owner", installed_at: "", updated_at: "", updated_by: null,
  edit_mode: "all", edit_members: [], builtin_version: null, current_version_no: null,
  visibility: "all", published_version_no: null, published_at: null, published_by: null, draft_by: null,
  made_by: "owner", owner_member: "owner", build_session: null, origin_app_id: null, ...over,
} as OrgApp);
const grant = (appId: string, member: string): AppGrantRow => ({ app_id: appId, member_id: member, scopes: [], tools: ["file_url"], granted_at: "", granted_by: null, revoked_at: null });

// 바꿀 수 있는 세계 — 시험마다 되돌린다.
const W = {
  apps: new Map<string, OrgApp>(), grants: [] as AppGrantRow[], members: new Set<string>(),
  shared: (_m: string, _rel: string) => true, keyOn: true, tenant: "t1", finished: [] as string[], finishThrows: false,
};
function reset(): void {
  W.apps = new Map([["crm", app("crm")], ["other", app("other")]]);
  W.grants = [grant("crm", "m1"), grant("other", "m1")];
  W.members = new Set(["m1"]);
  W.shared = () => true; W.keyOn = true; W.tenant = "t1"; W.finished = []; W.finishThrows = false;
}
reset();
const access = {
  getApp: async (id: string) => W.apps.get(id) ?? null,
  getGrant: async (id: string, m: string) => W.grants.find((g) => g.app_id === id && g.member_id === m) ?? null,
  sharedGate: async (m: string) => ({ ok: (rel: string) => W.shared(m, rel) }),
};
const server = express();
server.use("/api/files/s", fileUrlRouter({
  key: () => (W.keyOn ? KEY : null),
  tenantId: () => W.tenant,
  activeMember: async (id) => (W.members.has(id) ? { id, email: `${id}@x`, scopes: ["memory"] } : null),
  access,
  finishShared: async ({ abs }) => {
    if (W.finishThrows) throw new Error("finish exploded");
    W.finished.push(abs); return { size: fs.statSync(abs).size, ref: "shared/" + path.basename(abs) };
  },
}));
server.use(express.json({ limit: "1mb" }));   // 전역 파서는 서명 주소 라우트 **뒤**(index.ts 와 같은 순서) — J12
const listener = server.listen(0);
await new Promise<void>((r) => listener.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
test.after(() => { listener.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const AS_APP: Principal = { member: "m1", scopes: ["memory"], app: "crm" };
const PERSON: Principal = { member: "m1", scopes: ["memory"] };
const mintDeps = (over: Partial<Parameters<typeof mintFileUrl>[1]> = {}): Parameters<typeof mintFileUrl>[1] => ({
  access, key: () => KEY, tenantId: () => "t1", base: async () => BASE, workspaceSlug: () => null, ...over,
});
const mint = (address: string, method: "GET" | "PUT", principal: Principal, over: Partial<Parameters<typeof mintFileUrl>[0]> = {}, d = mintDeps()) =>
  mintFileUrl({ address: parseAddress(address), method, ttlSec: 900, principal, readOnly: false, ...over }, d);
const onDisk = (rel: string): string => path.join(ROOT, rel);

test("J1 앱 주체로 올리기 — 앱 폴더에 파일이 생기고(바이트 같음) 자료 마무리는 안 탄다", async () => {
  reset();
  const bytes = crypto.randomBytes(70_000);
  const u = await mint("apps/crm/out/a.bin", "PUT", AS_APP);
  const r = await fetch(u.url, { method: "PUT", body: bytes });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json() as { ok: boolean; address: string; size?: number };
  assert.equal(j.address, "apps/crm/out/a.bin");
  assert.equal(j.size, bytes.length);
  assert.ok(fs.readFileSync(onDisk("apps/crm/out/a.bin")).equals(bytes));
  assert.deepEqual(W.finished, [], "앱 폴더 파일은 자료 마무리를 타지 않는다");
});

test("J2 받기 — 같은 바이트 · attachment · nosniff · CSP sandbox · CORS *", async () => {
  reset();
  fs.mkdirSync(onDisk("apps/crm/out"), { recursive: true });
  fs.writeFileSync(onDisk("apps/crm/out/b.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const u = await mint("apps/crm/out/b.png", "GET", AS_APP);
  const r = await fetch(u.url, { headers: { origin: "https://crm-lively-46e3.lvly.app" } });
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(Buffer.from([137, 80, 78, 71, 1, 2, 3])));
  assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''b\.png$/);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("J3 HEAD — 크기만 · 본문 없음", async () => {
  reset();
  fs.mkdirSync(onDisk("apps/crm"), { recursive: true });
  fs.writeFileSync(onDisk("apps/crm/h.txt"), "hello");
  const u = await mint("apps/crm/h.txt", "GET", AS_APP);
  const r = await fetch(u.url, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-length"), "5");
  assert.equal((await r.arrayBuffer()).byteLength, 0);
});

test("J4 OPTIONS(사전 요청) — 204 · CORS", async () => {
  const u = await mint("apps/crm/x.txt", "PUT", AS_APP);
  const r = await fetch(u.url, { method: "OPTIONS", headers: { origin: "https://x.lvly.app", "access-control-request-method": "PUT" } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.match(r.headers.get("access-control-allow-methods") ?? "", /PUT/);
});

test("J5 받기 주소로 올리기 · 올리기 주소로 받기 → 403", async () => {
  reset();
  const g = await mint("apps/crm/j5.txt", "GET", AS_APP);
  assert.equal((await fetch(g.url, { method: "PUT", body: "x" })).status, 403);
  assert.equal(fs.existsSync(onDisk("apps/crm/j5.txt")), false, "받기 주소로 파일이 생기면 안 된다");
  const p = await mint("apps/crm/j5.txt", "PUT", AS_APP);
  assert.equal((await fetch(p.url)).status, 403);
});

test("J6 다른 워크스페이스에서 받은 주소 → 404(존재 은닉)", async () => {
  reset();
  const u = await mint("apps/crm/j6.txt", "PUT", AS_APP, {}, mintDeps({ tenantId: () => "t2" }));
  const r = await fetch(u.url, { method: "PUT", body: "x" });
  assert.equal(r.status, 404);
  assert.equal(fs.existsSync(onDisk("apps/crm/j6.txt")), false);
});

test("J7 만료된 주소 → 403(만료)", async () => {
  reset();
  const past = Math.floor(Date.now() / 1000) - 3600;
  const u = await mint("apps/crm/j7.txt", "PUT", AS_APP, { ttlSec: 30 }, mintDeps({ now: () => past }));
  const r = await fetch(u.url, { method: "PUT", body: "x" });
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { error: string }).error, /만료/);
});

test("J8 발급 뒤 동의를 거두면 쓰는 순간 막힌다(다시 판정) · 앱을 끄면 409", async () => {
  reset();
  const u = await mint("apps/crm/j8.txt", "PUT", AS_APP);
  W.grants = W.grants.filter((g) => g.app_id !== "crm");
  assert.equal((await fetch(u.url, { method: "PUT", body: "x" })).status, 403);
  assert.equal(fs.existsSync(onDisk("apps/crm/j8.txt")), false);
  reset();
  const v = await mint("apps/crm/j8.txt", "PUT", AS_APP);
  W.apps.set("crm", app("crm", { enabled: false }));
  assert.equal((await fetch(v.url, { method: "PUT", body: "x" })).status, 409);
});

test("J9 받은 구성원이 비활성이면 403", async () => {
  reset();
  const u = await mint("apps/crm/j9.txt", "PUT", AS_APP);
  W.members.clear();
  assert.equal((await fetch(u.url, { method: "PUT", body: "x" })).status, 403);
});

test("J10 앱 폴더 안 링크가 다른 앱 폴더를 가리키면 400(그 앱 폴더로 봉쇄)", async () => {
  reset();
  fs.mkdirSync(onDisk("apps/other"), { recursive: true });
  fs.writeFileSync(onDisk("apps/other/secret.txt"), "other app's secret");
  fs.mkdirSync(onDisk("apps/crm"), { recursive: true });
  fs.rmSync(onDisk("apps/crm/link.txt"), { force: true });
  fs.symlinkSync(onDisk("apps/other/secret.txt"), onDisk("apps/crm/link.txt"));
  const u = await mint("apps/crm/link.txt", "GET", AS_APP);
  const r = await fetch(u.url);
  assert.equal(r.status, 400);
  assert.doesNotMatch(await r.text(), /secret/);
});

test("J11 폴더 자리에 올리기 → 409", async () => {
  reset();
  fs.mkdirSync(onDisk("apps/crm/dir"), { recursive: true });
  const u = await mint("apps/crm/dir", "PUT", AS_APP);
  assert.equal((await fetch(u.url, { method: "PUT", body: "x" })).status, 409);
  assert.ok(fs.statSync(onDisk("apps/crm/dir")).isDirectory());
});

test("J12 Content-Type: application/json 으로 올려도 본문 그대로(전역 JSON 파서가 먹지 않는다)", async () => {
  reset();
  const body = '{"a":1,\n "b":[true]}';
  const u = await mint("apps/crm/data.json", "PUT", AS_APP);
  const r = await fetch(u.url, { method: "PUT", body, headers: { "content-type": "application/json" } });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(onDisk("apps/crm/data.json"), "utf8"), body);
});

test("J13 받는 쪽에 서명 키가 없으면 503", async () => {
  reset();
  const u = await mint("apps/crm/j13.txt", "PUT", AS_APP);
  W.keyOn = false;
  assert.equal((await fetch(u.url, { method: "PUT", body: "x" })).status, 503);
  W.keyOn = true;
});

test("J14 HTML 은 문서로 열리지 않게 octet-stream 으로 준다", async () => {
  reset();
  fs.mkdirSync(onDisk("apps/crm"), { recursive: true });
  fs.writeFileSync(onDisk("apps/crm/page.html"), "<script>alert(1)</script>");
  const u = await mint("apps/crm/page.html", "GET", AS_APP);
  const r = await fetch(u.url);
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.match(r.headers.get("content-disposition") ?? "", /^attachment/);
});

test("J15 공유 쓰기 — 잠금이 NFC 로 적혀 있으면 NFD 로 적은 주소도 막힌다(발급으로도 · 발급을 거치지 않은 토큰으로도)", async () => {
  reset();
  const NFC = "영업/비공개", NFD = NFC.normalize("NFD");
  assert.notEqual(NFC, NFD);
  W.shared = (_m, rel) => !(rel === NFC || rel.startsWith(NFC + "/"));
  await assert.rejects(() => mint(`shared/${NFD}/x.txt`, "PUT", PERSON), (e: { status?: number }) => e.status === 404);
  //  받는 곳 단독 — 발급을 거치지 않은 토큰이어도 같은 판정이다.
  const tok = signFileUrlToken({ t: "t1", m: "PUT", r: "shared", p: `${NFD}/x.txt`, s: "m1", e: Math.floor(Date.now() / 1000) + 600 }, KEY);
  assert.equal((await fetch(`${BASE}/api/files/s/${tok}`, { method: "PUT", body: "x" })).status, 404);
  assert.equal(fs.existsSync(onDisk(`shared/${NFC}/x.txt`)), false);
  assert.equal(fs.existsSync(onDisk(`shared/${NFD}/x.txt`)), false);
});

test("J15b 허락된 사람이 NFD 로 적은 주소에 올리기 — NFC 이름으로 저장되고 그 저장 이름이 판정에 들어간다", async () => {
  reset();
  const NFC = "영업/공개", NFD = NFC.normalize("NFD");
  const seen: string[] = [];
  W.shared = (_m, rel) => { seen.push(rel); return true; };
  const u = await mint(`shared/${NFD}/y.txt`, "PUT", PERSON);
  assert.equal(u.address, `shared/${NFC}/y.txt`, "서명한 주소는 NFC 이름");
  seen.length = 0;
  const r = await fetch(u.url, { method: "PUT", body: "y" });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(((await r.json()) as { address: string }).address, `shared/${NFC}/y.txt`);
  assert.equal(fs.readFileSync(onDisk(`shared/${NFC}/y.txt`), "utf8"), "y");
  const storedRel = path.relative(onDisk("shared"), W.finished[0]!).split(path.sep).join("/");
  assert.ok(seen.includes(storedRel), `받는 곳의 판정에 저장 이름이 없다: ${JSON.stringify(seen)}`);
});

test("J16 앱 폴더 자신이 이웃 앱 폴더로 가는 링크면 받기 · 올리기 모두 400 · 이웃 폴더에 아무것도 생기지 않는다", async () => {
  reset();
  W.apps.set("crm2", app("crm2")); W.grants.push(grant("crm2", "m1"));
  fs.mkdirSync(onDisk("apps/other2"), { recursive: true });
  fs.writeFileSync(onDisk("apps/other2/secret.txt"), "other2 secret");
  fs.rmSync(onDisk("apps/crm2"), { recursive: true, force: true });
  fs.symlinkSync(onDisk("apps/other2"), onDisk("apps/crm2"));
  const AS_CRM2: Principal = { member: "m1", scopes: ["memory"], app: "crm2" };
  const g = await fetch((await mint("apps/crm2/secret.txt", "GET", AS_CRM2)).url);
  assert.equal(g.status, 400);
  assert.doesNotMatch(await g.text(), /other2 secret/);
  const p = await mint("apps/crm2/planted.txt", "PUT", AS_CRM2);
  assert.equal((await fetch(p.url, { method: "PUT", body: "x" })).status, 400);
  assert.equal(fs.existsSync(onDisk("apps/other2/planted.txt")), false);
});

test("J17 실패 로그에 주소(토큰)를 남기지 않는다 — 올리기 5xx 두 갈래(HttpError · 그 밖의 오류) · 받기 5xx", async () => {
  reset();
  const logged: string[] = [];
  const orig = logger.error;
  (logger as { error: unknown }).error = (...args: unknown[]) => { logged.push(JSON.stringify(args)); };
  try {
    W.finishThrows = true;
    const u = await mint("shared/docs/j17.txt", "PUT", PERSON);
    assert.equal((await fetch(u.url, { method: "PUT", body: "x" })).status, 500);
    W.finishThrows = false;
    const v = await mint("apps/crm/j17.txt", "PUT", AS_APP);
    const g = await mint("apps/crm/j17.txt", "GET", AS_APP);
    W.keyOn = false;
    assert.equal((await fetch(v.url, { method: "PUT", body: "x" })).status, 503);
    assert.equal((await fetch(g.url)).status, 503);
    W.keyOn = true;
    assert.ok(logged.length >= 3, `실패가 로그에 남지 않았다: ${logged.length}`);
    const all = logged.join("\n");
    for (const url of [u.url, v.url, g.url]) assert.ok(!all.includes(new URL(url).pathname.split("/").pop()!), "로그에 토큰이 남았다");
    assert.ok(logged.every((l) => l.includes("/api/files/s/:token")), "로그에 어느 라우트인지 남는다");
  } finally {
    (logger as { error: unknown }).error = orig;
  }
});

test("J18 index.ts 는 서명 주소 라우트를 전역 express.json 앞에 붙인다(J12 의 전제)", () => {
  const src = fs.readFileSync("src/index.ts", "utf8");
  const route = src.indexOf('app.use("/api/files/s", fileUrlRouter(');
  const json = src.search(/^app\.use\(express\.json\(/m);
  assert.ok(route > 0, "서명 주소 라우트가 index.ts 에 없다");
  assert.ok(json > 0, "전역 express.json 이 index.ts 에 없다");
  assert.ok(route < json, "서명 주소 라우트가 전역 JSON 파서 뒤에 붙었다 — JSON 본문 올리기가 비게 된다");
});

test("J 공유 자리 올리기 — 사람 · 다른 업로드와 같은 마무리를 탄다 · 응답에 그 결과", async () => {
  reset();
  const u = await mint("shared/docs/a.txt", "PUT", PERSON);
  const r = await fetch(u.url, { method: "PUT", body: "공유" });
  assert.equal(r.status, 200);
  const j = await r.json() as { address: string; ref?: string };
  assert.equal(j.address, "shared/docs/a.txt");
  assert.equal(j.ref, "shared/a.txt");
  assert.deepEqual(W.finished, [onDisk("shared/docs/a.txt")]);
  assert.equal(fs.readFileSync(onDisk("shared/docs/a.txt"), "utf8"), "공유");
});

test("J 공유 자리 받기 — 쓰는 순간 공개범위가 닫혔으면 404", async () => {
  reset();
  fs.mkdirSync(onDisk("shared/docs"), { recursive: true });
  fs.writeFileSync(onDisk("shared/docs/b.txt"), "b");
  const u = await mint("shared/docs/b.txt", "GET", PERSON);
  W.shared = () => false;
  assert.equal((await fetch(u.url)).status, 404);
});

// ── K. 발급 ─────────────────────────────────────────────────────────────────────
test("K1 발급 — url 이 <게이트웨이>/api/files/s/<토큰> · 올리기는 상한을 알린다", async () => {
  reset();
  const u = await mint("apps/crm/k1.txt", "PUT", AS_APP);
  assert.match(u.url, new RegExp("^" + BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/api/files/s/v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"));
  assert.equal(u.method, "PUT");
  assert.equal(u.address, "apps/crm/k1.txt");
  assert.deepEqual(u.headers, {});
  assert.equal(u.max_bytes, 1024 * 1024 * 1024);
  assert.ok(Date.parse(u.expires_at) > Date.now());
  const g = await mint("apps/crm/k1.txt", "GET", AS_APP);
  assert.equal("max_bytes" in g, false);
});

test("K2 읽기전용 세션 — 올리기 주소는 403 · 받기 주소는 준다", async () => {
  reset();
  await assert.rejects(() => mint("apps/crm/k2.txt", "PUT", AS_APP, { readOnly: true }), (e: { status?: number }) => e.status === 403);
  assert.ok((await mint("apps/crm/k2.txt", "GET", AS_APP, { readOnly: true })).url);
});

test("K2b 읽기전용 여부를 모르면(빈 값) 올리기 주소를 주지 않는다", async () => {
  reset();
  await assert.rejects(() => mint("apps/crm/k2b.txt", "PUT", AS_APP, { readOnly: undefined as unknown as boolean }), (e: { status?: number }) => e.status === 403);
});

test("K2c file_url 도구 — 읽기전용 세션(ctx.readOnly)이면 올리기 주소를 주지 않는다(판정 · 서명 전에)", async () => {
  const { fileCapabilities } = await import("../capabilities/files.js");
  const cap = fileCapabilities.find((c) => c.name === "file_url")!;
  const user = { userId: "m1", email: "m1@x", scopes: ["memory"], projects: [] } as unknown as import("../context.js").LivelyUser;
  await assert.rejects(() => cap.handler({ address: "apps/crm/k2c.txt", method: "PUT" }, user, { source: "mcp", actor: "m1", readOnly: true }),
    (e: { status?: number; message?: string }) => e.status === 403 && /읽기전용/.test(String(e.message)));
});

test("K6 수명은 발급이 경계로 맞춘다 — 넘치면 3600 · 모자라면 30", async () => {
  reset();
  assert.equal((await mint("apps/crm/k6.txt", "GET", AS_APP, { ttlSec: 999_999 })).expires_in, 3600);
  assert.equal((await mint("apps/crm/k6.txt", "GET", AS_APP, { ttlSec: 1 })).expires_in, 30);
});

test("K3 서명 키가 없으면 503", async () => {
  reset();
  await assert.rejects(() => mint("apps/crm/k3.txt", "GET", AS_APP, {}, mintDeps({ key: () => null })), (e: { status?: number }) => e.status === 503);
});

test("K4 셀프호스트 다중 워크스페이스 — 주소에 워크스페이스를 싣는다(받는 쪽은 그대로 받는다)", async () => {
  reset();
  const u = await mint("apps/crm/k4.txt", "PUT", AS_APP, {}, mintDeps({ workspaceSlug: () => "ws-a" }));
  assert.match(u.url, /\?lvly_ws=ws-a$/);
  assert.equal((await fetch(u.url, { method: "PUT", body: "k4" })).status, 200);
});

test("K5 판정 거절은 토큰을 만들기 전에 — 사람은 앱 폴더 올리기 주소를 못 받는다 · 앱은 공유 폴더 주소를 못 받는다", async () => {
  reset();
  let signed = 0;
  const counting = mintDeps({ key: () => { signed++; return KEY; } });
  await assert.rejects(() => mint("apps/crm/k5.txt", "PUT", PERSON, {}, counting), (e: { status?: number }) => e.status === 403);
  await assert.rejects(() => mint("shared/docs/k5.txt", "GET", AS_APP, {}, counting), (e: { status?: number }) => e.status === 403);
  await assert.rejects(() => mint("apps/crm", "PUT", AS_APP, {}, counting), (e: { status?: number }) => e.status === 400);
  assert.equal(signed, 0, "거절된 발급에서 서명 키를 꺼내면 안 된다");
});
