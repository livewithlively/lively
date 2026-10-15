// 앱 주소 → 판 묶음 파일(#4481) — 사양 표 B(R1~R15). 실행: npm run build && node dist/apps/app-front-files.test.js
//  이게 틀리면: 빌드한 앱의 스크립트·폴더 주소가 안 열리거나, 한 페이지 앱이 새로고침에 404 가 나거나, ui.root 밖(매니페스트 · 소스)이
//   주소로 새거나, `..` 로 폴더 밖을 묻거나, 지문이 아닌 이름을 1년 캐시해 새 판이 안 보이거나, 깨진 스크립트 주소가 HTML 을 받는다.
import assert from "node:assert/strict";
import type { AppBundle } from "./app-bundle.js";
import {
  IMMUTABLE, REVALIDATE, cacheControlFor, compressible, contentTypeFor, etagMatches, indexUnderRoot, isHashedAssetName, parseFrontUrl, resolveFrontPath,
} from "./app-front-files.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const H = "a".repeat(64);
const bundle = (paths: string[]): AppBundle => ({ v: 1, files: paths.map((p) => ({ p, h: H, s: 1 })) });
const url = (raw: string) => { const u = parseFrontUrl(raw); assert.ok(u, `꼴: ${raw}`); return u; };
const go = (paths: string[], raw: string, root = "dist", pages: Array<[string, string]> = []) =>
  resolveFrontPath(indexUnderRoot(bundle(paths), root), url(raw), new Map(pages));
const fileOf = (r: ReturnType<typeof go>): string => (r.kind === "file" ? `${r.rel}@${r.status}` : r.kind === "redirect" ? `→${r.location}` : "notfound");

const APP = ["lively-app.json", "src/main.ts", "dist/index.html", "dist/assets/app.js", "dist/docs/index.html", "dist/about.html", "dist/guide/index.html", "dist/한 a.png"];

{
  assert.equal(fileOf(go(APP, "/assets/app.js")), "assets/app.js@200");
  ok("R1 정확한 파일");
}
{
  assert.equal(fileOf(go(APP, "/")), "index.html@200");
  assert.equal(fileOf(go(APP, "/docs/")), "docs/index.html@200");
  ok("R2 `/` · `/docs/` → index.html");
}
{
  assert.equal(fileOf(go(APP, "/about")), "about.html@200");
  ok("R3 확장자 없는 주소 → .html");
}
{
  assert.equal(fileOf(go(APP, "/guide?a=1")), "→/guide/?a=1");
  ok("R4 폴더 주소 → `/x/` 로 308(쿼리 보존)");
}
{
  assert.equal(fileOf(go(APP, "/users/42")), "index.html@200");
  ok("R5 없는 확장자 없는 주소 → 맨 위 index.html(한 페이지 앱)");
}
{
  assert.equal(fileOf(go(APP, "/missing.js")), "notfound");
  ok("R6 없는 파일(확장자 있음) → notfound");
}
{
  assert.equal(fileOf(go([...APP, "dist/404.html"], "/nope")), "404.html@404");
  assert.equal(fileOf(go([...APP, "dist/404.html"], "/nope.js")), "404.html@404");
  ok("R7 맨 위 404.html 이 있으면 그것을 404 로");
}
{
  for (const bad of ["/a%2Fb", "/a%5Cb", "//x", "/a b", "/" + "x".repeat(2048), "/a\\b", "/%00", "relative", "/%E0%A4%A"]) assert.equal(parseFrontUrl(bad), null, bad);
  //  `%2e%2e` 는 주소 표준(WHATWG)이 먼저 `..` 로 읽어 풀어 버린다 — 맨 앞(/)보다 위로는 못 간다(앞단도 같은 정규화를 거친 경로를 준다).
  assert.equal(parseFrontUrl("/%2e%2e/secret")?.path, "secret");
  assert.equal(parseFrontUrl("/x/%2e%2e/%2E%2E/../y")?.path, "y");
  assert.equal(fileOf(go(APP, "/%2e%2e/lively-app.json")), "notfound", "풀어도 ui.root 밖으로는 못 나간다");
  ok("R8 꼴 거부(조각 안 `/`·`\\` · `//` · 공백 · 2,049자 · 역슬래시 · NUL · 상대 · 깨진 % 인코딩) · `..` 는 맨 앞 위로 못 감");
}
{
  const r = go(APP, "/lively-app.json");
  assert.equal(fileOf(r), "notfound", "root 밖 매니페스트를 주소로 못 받는다");
  assert.equal(fileOf(go(APP, "/src/main.ts")), "notfound");
  assert.equal(fileOf(go(APP, "/lively-app.json", "")), "lively-app.json@200", "root 가 패키지 맨 위면 다 보인다");
  ok("R9 ui.root 밖 파일 0");
}
{
  const pages: Array<[string, string]> = [["main", "index.html"], ["list", "list.html"]];
  const P = [...APP, "dist/list.html"];
  assert.equal(fileOf(go(P, "/?page=main", "dist", pages)), "index.html@200");
  assert.equal(fileOf(go(P, "/?page=list&x=1", "dist", pages)), "→/list.html?x=1");
  assert.equal(fileOf(go(P, "/?page=zzz", "dist", pages)), "index.html@200", "모르는 키는 무시");
  assert.equal(fileOf(go(P, "/?page=list&__lively_probe=1", "dist", pages)), "→/list.html?__lively_probe=1", "탐침 표시는 따라간다");
  ok("R10 `/?page=<키>` → 그 화면 entry");
}
{
  assert.equal(fileOf(go(["dist/app.html"], "/", "dist", [["main", "app.html"]])), "→/app.html");
  ok("R11 index.html 이 없으면 첫 화면 entry 로");
}
{
  const cases: Array<[string, string]> = [
    //  실측 Vite 6.4.4 빌드(시험 앱) — 지문에 하이픈이 섞이거나 숫자가 없다
    ["assets/index-MUbec-0l.js", IMMUTABLE], ["assets/index-XlyKSLnJ.css", IMMUTABLE], ["assets/later-fWhkYVbu.js", IMMUTABLE], ["vite.svg", REVALIDATE],
    ["index.html", REVALIDATE], ["assets/index-BjU7aAkd.js", IMMUTABLE], ["logo.png", REVALIDATE], ["assets/My-Company-Logo.png", REVALIDATE],
    ["assets/icon-settings.svg", REVALIDATE], ["assets/photo-20240101.png", REVALIDATE], ["assets/logo-Settings.png", REVALIDATE],
    ["logo-BjU7aAkd.png", REVALIDATE], ["_next/static/chunks/x.js", IMMUTABLE], ["_astro/a.b.js", IMMUTABLE],
    ["static/js/main.3f2a1b9c.js", IMMUTABLE], ["static/js/787.2b1c3d4e.chunk.js", IMMUTABLE], ["static/js/main.js", REVALIDATE],
  ];
  for (const [p, want] of cases) assert.equal(cacheControlFor(p), want, p);
  assert.equal(isHashedAssetName("photo-20240101.png"), false, "숫자만은 지문이 아니다");
  assert.equal(cacheControlFor("assets/page-a1b2c3d4.html"), REVALIDATE, "HTML 은 지문 이름이어도 다시 확인");
  ok("R12 캐시 — 빌드 도구의 지문 자리·꼴만 1년(실측 Vite 이름 포함) · 맨 위 파일·낱말·날짜는 다시 확인 · HTML 은 늘 다시 확인");
}
{
  assert.equal(contentTypeFor("a.JS"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("x.woff2"), "font/woff2");
  assert.equal(contentTypeFor("x.unknownext"), "application/octet-stream");
  assert.equal(contentTypeFor("dir/a.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("noext"), "application/octet-stream");
  assert.equal(compressible("text/javascript; charset=utf-8"), true);
  assert.equal(compressible("image/png"), false);
  assert.equal(compressible("image/svg+xml"), true);
  ok("R13 종류 · 압축할 만한 종류");
}
{
  assert.equal(etagMatches('W/"abc", "def"', '"def"'), true);
  assert.equal(etagMatches('"abc"', 'W/"abc"'), true);
  assert.equal(etagMatches('W/"abc"', '"abc"'), true, "중간 캐시가 약한 표시를 붙여 보내도 같은 지문");
  assert.equal(etagMatches("*", '"x"'), true);
  assert.equal(etagMatches("", '"x"'), false);
  assert.equal(etagMatches(undefined, '"x"'), false);
  assert.equal(etagMatches('"abc-gz"', '"abc"'), false, "압축본 지문은 다른 지문");
  ok("R14 If-None-Match");
}
{
  assert.equal(fileOf(go(APP, "/%ED%95%9C%20a.png")), "한 a.png@200");
  ok("R15 퍼센트 인코딩된 이름(한글·공백)");
}
console.log(`\n${pass} passed`);
