// 서버 화면에 SDK 런타임 넣기(#4485 후속) — 사양 표 A · B · C · D(spec-4485-runtime.md). 순수 조각과 조각 흐름 끼우개를 행마다 본다.
//  이게 틀리면: 서버 앱이 라이블리 안에서 8초 뒤 종전 화면으로 바뀌거나(넣지 않음) · fetch 로 받는 HTML 조각 · JSON 이 깨지거나(넣지 말 곳에 넣음) ·
//  doctype 앞에 넣어 문서가 호환 모드로 그려지거나 · CSP 에 막혀 런타임이 돌지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  HEAD_WAIT_LIMIT, PROBE_PATH, SDK_PATH, addVary, asciiJs, docInjector, documentRequestHeaders, gzipDocResponse, gzipStream, injectableResponse, insertAt,
  isDocumentRequest, scriptModeFor, scriptVersion, sdkTags,
} from "./app-server-page.js";
import { loadAppScripts } from "./app-front-page.js";

test("A 문서 요청 판정 — 문서 · iframe · frame · 폼 제출 결과는 문서, fetch · 스크립트 · HEAD 는 아님, Sec-Fetch 없는 옛 브라우저는 Accept 로", () => {
  const nav = { "sec-fetch-mode": "navigate", accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  assert.equal(isDocumentRequest("GET", { ...nav, "sec-fetch-dest": "document" }), true, "A1");
  assert.equal(isDocumentRequest("GET", { ...nav, "sec-fetch-dest": "iframe" }), true, "A2");
  assert.equal(isDocumentRequest("GET", { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", accept: "text/html" }), false, "A3 fetch 로 받는 HTML 조각");
  assert.equal(isDocumentRequest("GET", { accept: "text/html,application/xhtml+xml" }), true, "A4 옛 브라우저");
  assert.equal(isDocumentRequest("GET", { accept: "*/*" }), false, "A5");
  assert.equal(isDocumentRequest("HEAD", { ...nav, "sec-fetch-dest": "document" }), false, "A6 본문 없음");
  assert.equal(isDocumentRequest("POST", { ...nav, "sec-fetch-dest": "iframe" }), true, "A7 폼 제출 결과 화면");
  assert.equal(isDocumentRequest("GET", { "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors", accept: "*/*" }), false, "A8");
  assert.equal(isDocumentRequest("GET", { ...nav, "sec-fetch-dest": "frame" }), true, "A9");
  //  대소문자 · 배열 머리
  assert.equal(isDocumentRequest("get", { "sec-fetch-dest": ["Document"] }), true);
});

test("B 넣을지 — HTML 문서 답만 · 압축 · 본문 없음 · 옮기기 · 부분 답 · 다른 종류는 그대로", () => {
  const html = { "content-type": "text/html; charset=utf-8" };
  assert.equal(injectableResponse(200, html), true, "B1");
  assert.equal(injectableResponse(200, { "content-type": "application/json" }), false, "B2");
  assert.equal(injectableResponse(304, html), false, "B3");
  assert.equal(injectableResponse(204, html), false, "B4");
  assert.equal(injectableResponse(302, html), false, "B5");
  assert.equal(injectableResponse(200, { ...html, "content-encoding": "gzip" }), false, "B6 압축");
  assert.equal(injectableResponse(404, html), true, "B8 앱의 오류 화면");
  assert.equal(injectableResponse(500, html), true, "B9");
  assert.equal(injectableResponse(200, {}), false, "B10 종류 모름");
  assert.equal(injectableResponse(200, { "content-type": "TEXT/HTML" }), true, "B11");
  assert.equal(injectableResponse(200, { "content-type": "application/xhtml+xml" }), false, "B12");
  assert.equal(injectableResponse(200, { ...html, "content-encoding": "identity" }), true, "B13");
  assert.equal(injectableResponse(206, html), false, "B14 부분 답");
  assert.equal(injectableResponse(205, html), false);
  assert.equal(injectableResponse(200, { "content-type": "text/html; charset=UTF-16" }), false, "ASCII 를 품지 않는 문자 집합");
  assert.equal(injectableResponse(200, { ...html, "content-disposition": 'attachment; filename="report.html"' }), false, "B15 내려받기(보고서 HTML)는 앱이 보낸 그대로");
  assert.equal(injectableResponse(200, { ...html, "content-disposition": "ATTACHMENT" }), false, "B15 대소문자");
  assert.equal(injectableResponse(200, { ...html, "content-disposition": 'inline; filename="a.html"' }), true, "B15 inline 은 화면");
  assert.equal(injectableResponse(200, { ...html, "cache-control": "private, no-transform" }), false, "B16 앱이 «바꾸지 말라»(no-transform)");
  assert.equal(injectableResponse(200, { ...html, "cache-control": "no-store" }), true, "B16 다른 캐시 지시는 상관없다");
  //  B-gz — 문서 요청의 답을 게이트웨이가 다시 압축하나(압축 머리를 빼고 넘겼으니)
  const gzReq = { "accept-encoding": "gzip, deflate, br" };
  assert.equal(gzipDocResponse(200, html, gzReq), true, "HTML");
  assert.equal(gzipDocResponse(200, { "content-type": "application/json" }, gzReq), true, "JSON 도(내비게이션으로 연 JSON)");
  assert.equal(gzipDocResponse(200, { "content-type": "image/png" }, gzReq), false, "이미 압축된 꼴");
  assert.equal(gzipDocResponse(200, html, { "accept-encoding": "br" }), false, "브라우저가 gzip 을 안 받음");
  assert.equal(gzipDocResponse(200, html, {}), false);
  assert.equal(gzipDocResponse(200, { ...html, "content-encoding": "gzip" }, gzReq), false, "앱이 이미 압축");
  assert.equal(gzipDocResponse(304, html, gzReq), false, "본문 없음");
  assert.equal(gzipDocResponse(200, { ...html, "content-disposition": "attachment" }, gzReq), false, "내려받기는 그대로(길이 머리)");
  assert.equal(gzipDocResponse(200, { ...html, "cache-control": "no-transform" }, gzReq), false, "no-transform 은 다시 압축도 안 한다");
  //  Vary 더하기 — 있으면 그대로 · 대소문자 무시 · `*` 는 그대로
  const v1: Record<string, string> = {}; addVary(v1, "Sec-Fetch-Dest"); addVary(v1, "accept-encoding"); addVary(v1, "Accept-Encoding");
  assert.equal(v1.vary, "Sec-Fetch-Dest, accept-encoding");
  const v2: Record<string, string> = { vary: "Origin" }; addVary(v2, "Sec-Fetch-Dest");
  assert.equal(v2.vary, "Origin, Sec-Fetch-Dest");
  const v3: Record<string, string> = { vary: "*" }; addVary(v3, "Sec-Fetch-Dest");
  assert.equal(v3.vary, "*");
  //  B-req — 문서 요청은 압축 · 조건부 머리를 빼고 넘긴다(원본은 그대로)
  const req = { accept: "text/html", "accept-encoding": "gzip, br", "If-None-Match": "\"x\"", "if-modified-since": "Mon", "user-agent": "u", cookie: "a=1" };
  const out = documentRequestHeaders(req);
  assert.deepEqual(Object.keys(out).sort(), ["accept", "cookie", "user-agent"], "B-req1");
  assert.equal(req["accept-encoding"], "gzip, br", "원본 머리를 바꿨다");
});

/** 조각들을 끼우개에 차례로 넣는다 — 조각마다 내보낸 것 · 끝 · 전부. */
function feed(chunks: Array<string | Buffer>, tag = "<T>"): { outs: string[]; end: string; all: Buffer } {
  const inj = docInjector(tag);
  const outs: Buffer[] = chunks.map((c) => inj.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")));
  const end = inj.end();
  return { outs: outs.map((b) => b.toString("utf8")), end: end.toString("utf8"), all: Buffer.concat([...outs, end]) };
}

test("C 넣는 자리 — doctype 바로 뒤(대소문자 · BOM · 공백 · 주석 · <?…> 앞), 없으면 맨 앞(BOM 뒤) · 걸친 doctype 은 기다린다", () => {
  assert.equal(feed(["<!doctype html><html><body>x"]).all.toString(), "<!doctype html><T><html><body>x", "C1");
  assert.equal(feed(['<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><p>']).all.toString(), '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><T><p>', "C2");
  const c3 = feed(["<!doc", "type html><p>a"]);
  assert.deepEqual(c3.outs, ["", "<!doctype html><T><p>a"], "C3 첫 조각에서 내보내면 doctype 앞에 들어갈 수 있다");
  assert.equal(feed(["﻿<!doctype html><p>"]).all.toString(), "﻿<!doctype html><T><p>", "C4");
  assert.equal(feed(["\n  \r\n<!doctype html>\n<p>"]).all.toString(), "\n  \r\n<!doctype html><T>\n<p>", "C5");
  assert.equal(feed(["<!-- 머리 주석 --><!doctype html><p>"]).all.toString(), "<!-- 머리 주석 --><!doctype html><T><p>", "C6");
  assert.equal(feed(['<?xml version="1.0"?>\n<!DOCTYPE html><p>']).all.toString(), '<?xml version="1.0"?>\n<!DOCTYPE html><T><p>');
  assert.equal(feed(["<html><head></head>"]).all.toString(), "<T><html><head></head>", "C7");
  assert.equal(feed(["﻿<html>"]).all.toString(), "﻿<T><html>", "C8 BOM 뒤");
  assert.equal(feed([]).all.toString(), "<T>", "C9 빈 본문");
  //  C10 — 공백만 1KB 넘게 · 끝나지 않는 주석: 1KB 에서 더 기다리지 않는다
  const ws = " ".repeat(HEAD_WAIT_LIMIT + 10);
  const c10 = feed([ws.slice(0, 600), ws.slice(600), "<!doctype html>"]);
  assert.equal(c10.outs[0], "", "1KB 전에는 기다린다");
  assert.equal(c10.outs[1], "<T>" + ws, "1KB 를 넘으면 맨 앞에 넣고 보낸다");
  assert.equal(c10.outs[2], "<!doctype html>", "정한 뒤는 그대로");
  const c10b = feed(["<!-- 끝나지 않는 주석 " + "x".repeat(HEAD_WAIT_LIMIT)]);
  assert.ok(c10b.outs[0]!.startsWith("<T><!--"), "끝나지 않는 주석에서 무한정 기다렸다");
  const c11 = feed(["<!doctype", " html", "><p>z"]);
  assert.deepEqual(c11.outs, ["", "", "<!doctype html><T><p>z"], "C11");
  assert.deepEqual(feed(["<", "!doctype html>"]).outs, ["", "<!doctype html><T>"], "C12 `<` 한 글자");
  assert.deepEqual(feed(["<!-", "- c --><!doctype html>"]).outs, ["", "<!-- c --><!doctype html><T>"], "주석이 시작되다 만 조각");
  //  C13 — 넣은 뒤 나머지는 바이트 그대로(조각 경계에 걸친 한글 포함)
  const body = Buffer.from("<!doctype html><p>한글 본문 — 조각 경계</p>", "utf8");
  const cut = body.indexOf(Buffer.from("한", "utf8")) + 1;   // 한 글자의 바이트 중간
  const c13 = feed([body.subarray(0, cut), body.subarray(cut)]);
  assert.deepEqual(Buffer.concat([c13.all.subarray(0, 15), c13.all.subarray(18)]), body, "C13 받은 바이트가 바뀌었다");
  assert.equal(c13.all.subarray(15, 18).toString(), "<T>");
  //  C14 — 흐름이 doctype 중간에 끝났다
  assert.equal(feed(["<!doctype ht"]).all.toString(), "<T><!doctype ht", "C14");
  assert.equal(feed(["﻿<!doc"]).all.toString(), "﻿<T><!doc", "C14 BOM 뒤");
  //  BOM 이 조각 경계에 걸림 — BOM 앞에 넣지 않는다(문서 맨 앞 BOM · doctype 이 그대로)
  const bom = Buffer.from("\uFEFF<!doctype html><p>", "utf8");
  for (let cut = 1; cut < 3; cut++) {
    const r = feed([bom.subarray(0, cut), bom.subarray(cut)]);
    assert.equal(r.all.toString(), "\uFEFF<!doctype html><T><p>", `BOM ${cut}바이트에서 잘림`);
  }
  //  모든 두 조각 나눔이 한 조각과 같다
  for (const doc of ["<!doctype html><p>x", "\uFEFF<!DOCTYPE html>\n<p>", "<!-- c --><!doctype html><b>", "<html><p>", "\n\n<?xml x?><!doctype html><i>"]) {
    const buf = Buffer.from(doc, "utf8");
    const whole = feed([buf]).all.toString();
    for (let cut = 1; cut < buf.length; cut++) assert.equal(feed([buf.subarray(0, cut), buf.subarray(cut)]).all.toString(), whole, `${JSON.stringify(doc)} ${cut}`);
  }
  //  UTF-16 BOM — 넣지 않는다
  const u16 = Buffer.from([0xff, 0xfe, 0x3c, 0x00]);
  assert.deepEqual(feed([u16]).all, u16);
  //  자리 함수 자체
  assert.equal(insertAt("<!doctype html>", false), 15);
  assert.equal(insertAt("   ", false), "wait");
  assert.equal(insertAt("   ", true), 0);
  assert.equal(insertAt("<p>", false), 0);
});

test("D 넣는 모양 — 같은 주소 파일이 기본(‘self’ · nonce · CSP 없음) · 파일을 막고 인라인만 받으면 인라인 · 탐침 · 속성을 깨는 nonce 는 안 씀", () => {
  const m = (csp?: string) => scriptModeFor(csp);
  const file = (nonce: string | null = null) => ({ kind: "external", nonce });
  const inline = (nonce: string | null = null) => ({ kind: "inline", nonce });
  assert.deepEqual(m(undefined), file(), "D1 CSP 없음 — 파일(판마다 한 번 · 1년 캐시)");
  assert.deepEqual(m("default-src 'self'"), file(), "D2");
  assert.deepEqual(m("script-src 'self' 'unsafe-inline'"), file(), "D3 둘 다 받으면 파일");
  assert.deepEqual(m("script-src 'nonce-abc'"), file("abc"), "D4 nonce 로 연 파일");
  assert.deepEqual(m("script-src 'nonce-abc' 'strict-dynamic'"), file("abc"), "D5");
  assert.deepEqual(m("script-src 'unsafe-inline' 'nonce-abc'"), file("abc"), "D6");
  assert.deepEqual(m("script-src 'sha256-xyz' 'unsafe-inline'"), file(), "D7 해시가 있으면 unsafe-inline 무시 — 둘 다 막힘(파일이 최선)");
  assert.deepEqual(m("img-src *; style-src 'self'"), file(), "D8 스크립트를 막지 않음");
  assert.deepEqual(m("default-src *, script-src 'self'"), file(), "D9 두 정책");
  assert.deepEqual(m("script-src 'nonce-a', script-src 'nonce-b'"), file(), "D10 nonce 가 다름");
  assert.deepEqual(m("script-src-elem 'self'; script-src 'unsafe-inline'"), file(), "D11 script-src-elem 이 이긴다");
  assert.deepEqual(m("default-src 'none'"), file(), "D12 다 막힘");
  assert.deepEqual(m("script-src 'nonce-a\"b'"), file(), "D15 따옴표 든 nonce 는 쓰지 않는다");
  assert.deepEqual(m("script-src 'strict-dynamic' 'nonce-n1', script-src 'self'"), file("n1"), "D18 한 정책은 nonce · 한 정책은 self");
  assert.deepEqual(m("script-src 'unsafe-inline' https://cdn.example.com"), inline(), "D19 파일은 막히고 인라인만 — 인라인");
  assert.deepEqual(m("script-src 'unsafe-inline'"), inline(), "D19");
  assert.deepEqual(m("script-src 'unsafe-inline', script-src 'nonce-q'"), inline("q"), "한 정책은 인라인만 · 다른 정책은 nonce — 파일은 첫째가 막아 nonce 인라인");
  assert.deepEqual(m("script-src 'unsafe-inline' 'strict-dynamic'"), file(), "strict-dynamic 이면 unsafe-inline · self 모두 무시 — 다 막힘");
  assert.deepEqual(m("script-src 'self'; script-src 'unsafe-inline'"), file(), "같은 지시가 둘이면 앞의 것");
  assert.deepEqual(m("script-src https:"), file(), "https: 출처");
  assert.deepEqual(m("script-src *"), file(), "* 출처");
  assert.deepEqual(m("script-src 'unsafe-inline' 'nonce-x', script-src 'unsafe-inline'"), inline("x"), "nonce 정책 + 인라인만 정책 — 파일은 둘째가 막아 nonce 인라인");

  const s = { runtime: "window.lively={k:'한'};</script><b>", probe: "probe()" };
  const tag = sdkTags({ kind: "inline", nonce: null }, { ...s, probe: null });
  assert.equal(tag, "<script>window.lively={k:'\\ud55c'};<\\/script><b></script>", "D16 ASCII · D17 </script 끊기");
  assert.equal(sdkTags({ kind: "inline", nonce: "n" }, { ...s, probe: null }).startsWith('<script nonce="n">'), true);
  assert.equal(sdkTags({ kind: "inline", nonce: null }, { runtime: "r()", probe: "p()" }), "<script>r()</script><script>p()</script>", "D13 탐침 인라인");
  const ext = sdkTags({ kind: "external", nonce: "n" }, { runtime: "r()", probe: "p()" });
  assert.equal(ext, `<script nonce="n" src="${SDK_PATH}?v=${scriptVersion("r()")}"></script><script nonce="n" src="${PROBE_PATH}?v=${scriptVersion("p()")}"></script>`, "D14 · D18");
  assert.equal(sdkTags({ kind: "external", nonce: null }, { runtime: "r()" }), `<script src="${SDK_PATH}?v=${scriptVersion("r()")}"></script>`);
  assert.match(scriptVersion("r()"), /^[0-9a-f]{16}$/);
  assert.notEqual(scriptVersion("r()"), scriptVersion("r( )"), "판이 바뀌면 지문도 바뀐다");
  assert.equal(asciiJs("a—b😀"), "a\\u2014b\\ud83d\\ude00");
});

test("G 다시 압축 — 조각마다 그 조각까지 바로 풀리고(흘려 보내기) · 끝을 붙이면 전부 · 빈 조각은 빈 것", async () => {
  const z = gzipStream();
  const a = await z.push(Buffer.from("<!doctype html><p>첫 조각</p>", "utf8"));
  assert.equal(zlib.gunzipSync(a, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString(), "<!doctype html><p>첫 조각</p>", "첫 조각만으로 풀린다");
  assert.equal((await z.push(Buffer.alloc(0))).length, 0);
  const b = await z.push(Buffer.from("<p>둘</p>", "utf8"));
  const c = await z.end();
  assert.equal(zlib.gunzipSync(Buffer.concat([a, b, c])).toString(), "<!doctype html><p>첫 조각</p><p>둘</p>");
  const d = gzipStream(); await d.push(Buffer.from("x")); d.destroy();   // 중간에 그만둬도 던지지 않는다
});

test("D16 ★ 실제 런타임 · 탐침 — ASCII 로 바꿔도 같은 글(백슬래시 바로 뒤의 비ASCII · String.raw 없음) · 바꾼 것이 JS 로 읽힌다", async () => {
  const s = await loadAppScripts();
  for (const [name, js] of [["runtime", s.runtime], ["probe", s.probe]] as const) {
    assert.ok(js.length > 100, `${name} 가 비었다`);
    //  \u 이스케이프는 문자열 · 주석 · 정규식 안에서 같은 글자다 — 백슬래시 바로 뒤(이스케이프의 일부)나 String.raw(날글)에서만 뜻이 바뀐다.
    assert.equal(/\\[^\x00-\x7f]/.test(js), false, `${name}: 백슬래시 바로 뒤에 비ASCII 글자가 있다`);
    assert.equal(/String\.raw/.test(js), false, `${name}: String.raw 가 있다`);
    const ascii = asciiJs(js);
    assert.equal(/[^\x00-\x7f]/.test(ascii), false);
    assert.doesNotThrow(() => new Function(ascii), `${name}: ASCII 로 바꾼 글이 JS 로 읽히지 않는다`);
    //  문서 안 인라인으로 넣을 때 HTML 해석이 스크립트를 일찍 끝내거나 이어 붙이지 않게
    assert.equal(/<!--/.test(js), false, `${name}: <!-- 가 있다(스크립트 안 HTML 주석 상태)`);
  }
});
