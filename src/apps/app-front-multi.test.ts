// 앱 주소의 여러 파일 앱 응답(#4481) — 가짜 의존(판 지문 · 판 묶음 · 파일 내용)으로 app-front-routes 의 page 길을 끝까지 본다.
// 실행: npm run build && node dist/apps/app-front-multi.test.js
//  M1~M12: 사양 표 B 의 응답 쪽 + D 의 «보는 판»(#4667) · 깨진 판 처리 · v1 앱 무회귀.
//  이게 틀리면: 빌드한 앱의 스크립트가 HTML 로 오거나(종류) · 새 판이 캐시에 묻히거나(ETag/캐시) · 초안을 남에게 보이거나 ·
//   설치된 내용과 다른 판의 파일을 내거나 · v1 앱(화면 한 장)이 새 길로 빨려 들어가 깨진다.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { HttpError } from "../http-error.js";
import { signAppFront } from "./app-front-auth.js";
import { appFrontPage, clearFrontBundleCacheForTest, gzCacheStatsForTest, type AppFrontDeps } from "./app-front-routes.js";
import type { OrgMember } from "../org/store/members.js";
import type { OrgApp } from "../org/store/apps.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const SECRET = "s3cret";
const T = { id: "11111111-1111-1111-1111-111111111111", slug: "lively-46e3" };
const ENV = { LIVELY_TENANT_HEADER_SECRET: SECRET, LIVELY_APP_DOMAIN: "lvly.app" } as NodeJS.ProcessEnv;
const now = (): number => Math.floor(Date.now() / 1000);
const H = (mid = "alice", app = "web", v: "pub" | "draft" = "pub") => ({ "x-lvly-app-front": signAppFront(SECRET, { op: "act", t: T.id, ws: T.slug, app, var: v, mid, iat: now() } as never) });
/** 초안 주소(`…-draft`) — 초안 코드는 이 주소에서만 돈다(#4667 · 설계 §13-5). */
const HD = (mid = "alice", app = "web") => H(mid, app, "draft");
const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

const member = (id: string, scopes: string[] = []): OrgMember => ({
  id, kind: "human", display_name: id, nickname: null, use_nickname: false, email: `${id}@x.io`, identities: [], body_md: "",
  avatar: null, avatar_char: null, avatar_color: null, state: "active", scopes, sort: 0, version: 1, updated_at: null, updated_by: null,
} as unknown as OrgMember);

//  판 둘: 1판(공개) · 2판(alice 의 초안). 둘 다 web.root=dist.
const files = (label: string) => ({
  "lively-app.json": "{}", "dist/index.html": `<!doctype html><title>${label}</title><script type="module" src="/assets/index-BjU7aAkd.js"></script>`,
  "dist/assets/index-BjU7aAkd.js": `console.log("${label}");` + "x".repeat(2000), "dist/logo.png": "PNG" + label,
  ...(label === "v2" ? { "dist/only-v2.txt": "new" } : {}),
});
const MAN = { web: { root: "dist" }, ui: { pages: [{ key: "main", title: "웹", entry: "dist/index.html" }] }, csp: { connect_domains: ["api.example.com"] } };
function mkVersion(label: string) {
  const blobs = new Map<string, Buffer>();
  const list = Object.entries(files(label)).map(([p, c]) => { const b = Buffer.from(c); blobs.set(sha(b), b); return { p, h: sha(b), s: b.length }; }).sort((a, b) => (a.p < b.p ? -1 : 1));
  return { bundle: { v: 1, files: list }, blobs, content_hash: "hash-" + label };
}
const V = { 1: mkVersion("v1"), 2: mkVersion("v2") } as Record<number, ReturnType<typeof mkVersion>>;

function deps(appOver: Partial<OrgApp> = {}, over: Partial<AppFrontDeps> = {}) {
  const calls = { versionBundle: 0, readBlob: 0 };
  const app = {
    id: "web", title: "웹", version: "1", manifest: MAN, source: { kind: "inline" }, content_hash: "hash-v2", status: "active", enabled: true,
    installed_by: "alice", installed_at: "", updated_at: "", updated_by: null, visibility: "all", published_version_no: 1, current_version_no: 2,
    draft_by: "alice", owner_member: "alice", made_by: "alice", ...appOver,
  } as unknown as OrgApp;
  const d: AppFrontDeps = {
    env: ENV, tenant: () => T,
    getMember: async (id) => (id === "alice" || id === "bob" ? member(id) : null),
    getApp: async (id) => (id === "web" ? app : null),
    listUiAssets: async () => [{ page_key: "main" }],
    getUiAsset: async () => ({ page_key: "main", html: "<p>v1 화면 한 장</p>" }),
    getAppVersion: async () => null,
    redeem: async () => null,
    scripts: async () => ({ runtime: "window.lively={}", probe: "PROBE()" }),
    versionHash: async (_a, no) => (V[no] ? { content_hash: V[no].content_hash, has_bundle: true } : null),
    versionBundle: async (_a, no) => { calls.versionBundle++; return V[no] ? { manifest: MAN, content_hash: V[no].content_hash, bundle: V[no].bundle, bundle_store: "db" } : null; },
    readBlob: async (_k, h, size) => { calls.readBlob++; const b = V[1].blobs.get(h) ?? V[2].blobs.get(h) ?? null; return b && size > 1024 * 1024 ? Readable.from([b]) : b; },
    ...over,
  };
  return { d, calls };
}
const text = (r: { body?: Buffer; html?: string; headers?: Record<string, string> }): string =>
  r.body ? (r.headers?.["Content-Encoding"] === "gzip" ? zlib.gunzipSync(r.body).toString() : r.body.toString()) : String(r.html ?? "");

clearFrontBundleCacheForTest();
{
  const { d } = deps();
  const js = await appFrontPage(H("bob"), "/assets/index-BjU7aAkd.js", d);
  assert.equal(js.status, 200);
  assert.equal(js.headers?.["Content-Type"], "text/javascript; charset=utf-8");
  assert.equal(js.headers?.["Cache-Control"], "private, max-age=31536000, immutable");
  assert.match(text(js), /console\.log\("v1"\)/, "bob 은 공개 판(1판)");
  const ownPub = await appFrontPage(H("alice"), "/assets/index-BjU7aAkd.js", d);
  assert.match(text(ownPub), /console\.log\("v1"\)/, "공개 주소는 초안을 만든 alice 에게도 공개 판(1판)");
  const own = await appFrontPage(HD("alice"), "/assets/index-BjU7aAkd.js", d);
  assert.match(text(own), /console\.log\("v2"\)/, "초안 주소에서 alice 는 설치된 판(2판)");
  const other = await appFrontPage(HD("bob"), "/assets/index-BjU7aAkd.js", d);
  assert.equal(other.status, 404, "남의 초안 주소는 없는 판");
  ok("M1 보는 판 — 공개 주소는 모두에게 1판(초안 주인 포함) · 초안 주소는 초안 주인만 2판 · 남에겐 404(#4667)");
}
{
  const { d } = deps();
  const r = await appFrontPage(H("bob"), "/only-v2.txt", d);
  assert.equal(r.status, 404, "공개 판에 없는 파일은 남에게 안 보인다");
  assert.equal((await appFrontPage(H("alice"), "/only-v2.txt", d)).status, 404, "초안 주인도 공개 주소에선 공개 판");
  const a = await appFrontPage(HD("alice"), "/only-v2.txt", d);
  assert.equal(a.status, 200);
  ok("M2 초안에만 있는 파일은 초안 주인의 초안 주소에서만");
}
{
  const { d } = deps();
  const r = await appFrontPage(H("bob"), "/", d);
  assert.equal(r.status, 200);
  assert.equal(r.headers?.["Content-Type"], "text/html; charset=utf-8");
  assert.equal(r.headers?.["Cache-Control"], "private, no-cache");
  const csp = String(r.headers?.["Content-Security-Policy"]);
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.example\.com/);
  const html = text(r);
  assert.ok(html.indexOf("window.lively={}") > 0 && html.indexOf("window.lively={}") < html.indexOf("<title>"), "SDK 런타임이 문서 머리에");
  assert.ok(!html.includes("PROBE()"), "탐침은 표시가 있을 때만");
  assert.match(text(await appFrontPage(H("bob"), "/?__lively_probe=1", d)), /PROBE\(\)/);
  ok("M3 HTML 문서 — 런타임 주입 · 여러 파일 CSP · 다시 확인 캐시 · 탐침은 표시 때만");
}
{
  const { d } = deps();
  const first = await appFrontPage(H("bob"), "/logo.png", d);
  const etag = String(first.headers?.ETag);
  assert.ok(/^"[0-9a-f]{32}"$/.test(etag), etag);
  const again = await appFrontPage({ ...H("bob"), "if-none-match": etag }, "/logo.png", d);
  assert.equal(again.status, 304);
  assert.equal(again.body, undefined);
  assert.equal(again.headers?.ETag, etag);
  const html1 = await appFrontPage(H("bob"), "/", d);
  const html304 = await appFrontPage({ ...H("bob"), "if-none-match": String(html1.headers?.ETag) }, "/", d);
  assert.equal(html304.status, 304, "HTML 도 지문으로 304");
  ok("M4 ETag · If-None-Match → 304(본문 없음)");
}
{
  const { d } = deps();
  const gz = await appFrontPage({ ...H("bob"), "accept-encoding": "gzip, br" }, "/assets/index-BjU7aAkd.js", d);
  assert.equal(gz.headers?.["Content-Encoding"], "gzip");
  assert.match(String(gz.headers?.ETag), /-gz"$/, "압축본은 다른 지문");
  assert.match(text(gz), /console\.log\("v1"\)/);
  const png = await appFrontPage({ ...H("bob"), "accept-encoding": "gzip" }, "/logo.png", d);
  assert.equal(png.headers?.["Content-Encoding"], undefined, "작은 그림은 압축하지 않는다");
  ok("M5 gzip — 글 종류 1KB 이상만 · 압축본 지문 따로");
}
{
  const { d } = deps();
  const spa = await appFrontPage(H("bob"), "/users/42", d);
  assert.equal(spa.status, 200);
  assert.match(text(spa), /<title>v1<\/title>/, "한 페이지 앱 — 없는 화면 주소는 index.html");
  const miss = await appFrontPage(H("bob"), "/nope.js", d);
  assert.equal(miss.status, 404);
  const red = await appFrontPage(H("bob"), "/?page=main", d);
  assert.equal(red.status, 200, "entry 가 index.html 이면 그 자리");
  ok("M6 한 페이지 앱 · 없는 파일 404 · ?page=");
}
{
  const { d } = deps({ content_hash: "something-else" });
  const r = await appFrontPage(HD("alice"), "/", d);
  assert.equal(r.status, 409, "설치된 내용과 지금 판 번호의 내용이 다르면 그 판을 내지 않는다");
  const { d: d2 } = deps({ current_version_no: null });
  assert.equal((await appFrontPage(HD("alice"), "/", d2)).status, 409);
  ok("M7 설치된 내용 ≠ 판 내용 · 판 번호 없음 → 409(다시 저장 안내)");
}
{
  //  v1 앱(web.root 없음) — 새 길을 타지 않는다(판 묶음 의존을 부르지 않는다).
  const { d, calls } = deps({ manifest: { csp: {} }, draft_by: null, published_version_no: null }, {});
  const r = await appFrontPage(H("alice"), "/", d);
  assert.equal(r.status, 200);
  assert.match(String(r.html), /v1 화면 한 장/);
  assert.equal(calls.versionBundle, 0, "v1 앱은 판 묶음을 안 읽는다");
  assert.equal((await appFrontPage(H("alice"), "/assets/x.js", d)).status, 404, "v1 은 종전대로 `/` 만");
  ok("M8 v1 앱 무회귀 — 종전 길 · 판 묶음 안 읽음");
}
{
  const { d } = deps();
  const r = await appFrontPage(H("bob"), "/a%2Fb", d);
  assert.equal(r.status, 400);
  ok("M9 틀린 경로 꼴 → 400");
}
{
  //  큰 파일(1MB 초과)은 흘려 보낸다 · 그림은 압축하지 않는다 · 길이를 싣는다.
  const big = Buffer.alloc(1024 * 1024 + 5, 1);
  const h = sha(big);
  const BV = { bundle: { v: 1, files: [{ p: "dist/big.bin", h, s: big.length }, { p: "dist/index.html", h: sha("<p/>"), s: 4 }] }, content_hash: "hash-big" };
  const { d } = deps({ published_version_no: 9, current_version_no: 9, draft_by: null, content_hash: "hash-big" }, {
    versionHash: async () => ({ content_hash: "hash-big", has_bundle: true }),
    versionBundle: async () => ({ manifest: MAN, content_hash: "hash-big", bundle: BV.bundle, bundle_store: "s3" }),
    readBlob: async (_k, hh, size) => (hh === h ? (size > 1024 * 1024 ? Readable.from([big]) : big) : Buffer.from("<p/>")),
  });
  const r = await appFrontPage({ ...H("bob"), "accept-encoding": "gzip" }, "/big.bin", d);
  assert.ok(r.stream, "흘려 보낸다");
  assert.equal(r.headers?.["Content-Length"], String(big.length));
  assert.equal(r.headers?.["Content-Encoding"], undefined);
  ok("M10 큰 파일 흘려 보내기 · 길이");
}
{
  //  화면 한 장 앱(v1)에 남의 초안이 걸려 있다 — 공개 판 화면을 저장소에서 못 읽으면(S3 먹통 · 파일 없음) 503 이지,
  //   설치된 화면(= 남의 초안)을 공개 주소에 내지 않는다(격리 리뷰 재검토 1).
  const V1 = { csp: {}, ui: { pages: [{ key: "main", title: "한 장", entry: "ui/index.html" }] } };
  clearFrontBundleCacheForTest();   // 앞 시험이 같은 판 번호 · 지문으로 여러 파일 묶음을 캐시해 두었다
  let asked = 0;
  //  판 행의 매니페스트도 화면 한 장 앱(web.root 없음) — 여러 파일 길은 null 을 주고 v1 길로 온다.
  const v1Bundle = async () => ({ manifest: V1, content_hash: "hash-v1", bundle: V[1].bundle, bundle_store: "db" });
  const { d } = deps({ manifest: V1, draft_by: "alice", published_version_no: 1, current_version_no: 2 }, {
    versionBundle: v1Bundle,
    getAppVersion: async () => { asked++; throw new HttpError(503, "앱 파일 저장소(S3)에 닿지 못했습니다"); },
    getUiAsset: async () => ({ page_key: "main", html: "<p>alice 의 초안 화면</p>" }),
  });
  const r = await appFrontPage(H("bob"), "/", d);
  assert.equal(asked, 1, "공개 판 화면을 읽으려 했다(관측 장치 확인)");
  assert.equal(r.status, 503);
  assert.ok(!String(r.html).includes("초안 화면"), "남의 초안을 내지 않는다");
  const { d: d2 } = deps({ manifest: V1, draft_by: "alice", published_version_no: 1, current_version_no: 2 }, {
    versionBundle: v1Bundle,
    getAppVersion: async () => ({ manifest: V1, files: [{ path: "ui/index.html", content: "<p>공개 판 화면</p>" }] }),
    getUiAsset: async () => ({ page_key: "main", html: "<p>alice 의 초안 화면</p>" }),
  });
  clearFrontBundleCacheForTest();
  assert.match(String((await appFrontPage(H("bob"), "/", d2)).html), /공개 판 화면/, "읽히면 공개 판");
  ok("M11 v1 공개 판 화면을 못 읽으면 503 — 남의 초안으로 떨어지지 않는다");
}
{
  //  같은 파일을 동시에 처음 받는 요청 여럿 — 압축본 캐시는 한 벌만 센다(셈과 실제 합이 같다).
  clearFrontBundleCacheForTest();
  const { d } = deps();
  const rs = await Promise.all(Array.from({ length: 6 }, () => appFrontPage({ ...H("bob"), "accept-encoding": "gzip" }, "/assets/index-BjU7aAkd.js", d)));
  assert.ok(rs.every((r) => r.headers?.["Content-Encoding"] === "gzip"), "압축 길을 탔다(관측 장치 확인)");
  const st = gzCacheStatsForTest();
  assert.equal(st.entries, 1);
  assert.equal(st.counted, st.actual, `셈 ${st.counted} = 실제 ${st.actual}`);
  ok("M12 동시 첫 요청 — 압축본 캐시 셈이 두 번 늘지 않는다");
}
console.log(`\n${pass} passed`);
