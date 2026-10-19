// #4769 링크 미리보기 — 순수 판정(주소 정규화 · SSRF 판정 · HTML 파싱). 사양 표(L1~L12)는 스크래치 spec-link-preview.md.
import { strict as assert } from "node:assert";
import test from "node:test";
import { isForbiddenAddress, normalizePreviewUrl, parseLinkMeta, LINK_PREVIEW_URL_MAX } from "./link-preview.js";

// ── A. 주소 ──
test("L1 http · https 만 — 조각은 떼고 자격이 든 주소는 거부", () => {
  assert.equal(normalizePreviewUrl("https://example.com/a?b=1#top"), "https://example.com/a?b=1");
  assert.equal(normalizePreviewUrl("http://example.com"), "http://example.com/");
  assert.equal(normalizePreviewUrl("ftp://example.com/x"), null);
  assert.equal(normalizePreviewUrl("javascript:alert(1)"), null);
  assert.equal(normalizePreviewUrl("https://user:pw@example.com/"), null);
  assert.equal(normalizePreviewUrl("   "), null);
  assert.equal(normalizePreviewUrl(null), null);
});
test("L2 길이 경계 — 2048자 통과 · 2049자 거부", () => {
  const base = "https://example.com/";
  assert.ok(normalizePreviewUrl(base + "a".repeat(LINK_PREVIEW_URL_MAX - base.length)));
  assert.equal(normalizePreviewUrl(base + "a".repeat(LINK_PREVIEW_URL_MAX - base.length + 1)), null);
});

// ── B. SSRF — 풀린 IP 로 판정 ──
test("L3 ★ 사설 · 루프백 · 링크로컬 · 메타데이터 · CGNAT · 멀티캐스트 · 미지정은 막는다", () => {
  for (const ip of ["127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "224.0.0.1", "255.255.255.255", "0.0.0.0"]) {
    assert.equal(isForbiddenAddress(ip), true, ip);
  }
});
test("L4 공인 IPv4 는 연다 — 경계값(172.15 · 172.32 · 100.63 · 100.128 · 9.255 · 11.0)", () => {
  for (const ip of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "9.255.255.255", "11.0.0.1", "223.255.255.255"]) {
    assert.equal(isForbiddenAddress(ip), false, ip);
  }
});
test("L5 ★ IPv6 — 루프백 · 링크로컬 · 고유 로컬 · 멀티캐스트 · IPv4 매핑(사설) · NAT64 는 막고 공인은 연다", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "64:ff9b::a00:1"]) assert.equal(isForbiddenAddress(ip), true, ip);
  for (const ip of ["2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isForbiddenAddress(ip), false, ip);
});
test("L6 IP 가 아닌 글자(이름)는 판정 불가 → 막는다(호출자가 먼저 풀어 넘긴다)", () => {
  assert.equal(isForbiddenAddress("example.com"), true);
  assert.equal(isForbiddenAddress(""), true);
});

// ── C. HTML 파싱 ──
const PAGE = `<!doctype html><html><head>
<meta charset="utf-8"><title>  제목 &amp; 태그  </title>
<meta property="og:title" content="OG 제목 &quot;따옴표&quot;">
<meta name="description" content="메타 설명">
<meta property="og:description" content="OG 설명 &#8230; 끝">
<meta property="og:image" content="/img/cover.png">
<meta property="og:image" content="/img/second.png">
<meta property="og:site_name" content="예시 사이트">
<link rel="shortcut icon" href="favicon.ico">
<link rel="apple-touch-icon" href="/touch.png">
</head><body><!-- <meta property="og:title" content="주석 안"> --></body></html>`;
test("L7 ★ og:* 가 먼저 — 제목 · 설명 · 그림(첫 것) · 사이트 이름 · 아이콘을 절대 주소로", () => {
  const m = parseLinkMeta(PAGE, "https://example.com/post/1");
  assert.equal(m.title, 'OG 제목 "따옴표"');
  assert.equal(m.description, "OG 설명 … 끝");
  assert.equal(m.image, "https://example.com/img/cover.png");
  assert.equal(m.site_name, "예시 사이트");
  assert.equal(m.favicon, "https://example.com/post/favicon.ico");
});
test("L8 og 가 없으면 twitter:* → <title> · meta description 으로 — 아이콘은 /favicon.ico 기본", () => {
  const m = parseLinkMeta(`<html><head><title>T &lt;x&gt;</title><meta name="twitter:description" content="tw 설명"><meta name="twitter:image" content="https://cdn.example.org/p.jpg"></head></html>`, "https://a.example.com/x/y");
  assert.equal(m.title, "T <x>");
  assert.equal(m.description, "tw 설명");
  assert.equal(m.image, "https://cdn.example.org/p.jpg");
  assert.equal(m.site_name, null);
  assert.equal(m.favicon, "https://a.example.com/favicon.ico");
});
test("L9 그림 주소가 http(s) 가 아니면(data: · javascript:) 버린다 · 주석 안의 meta 는 안 읽는다", () => {
  const m = parseLinkMeta(`<head><meta property="og:image" content="javascript:x"><!-- <meta property="og:title" content="주석"> --><title>실제</title></head>`, "https://example.com/");
  assert.equal(m.image, null);
  assert.equal(m.title, "실제");
});
test("L10 길이 상한 — 제목 200 · 설명 400 · 공백은 한 칸으로", () => {
  const m = parseLinkMeta(`<head><meta property="og:title" content="${"가 ".repeat(300)}"><meta property="og:description" content="${"나".repeat(1000)}"></head>`, "https://example.com/");
  assert.equal(m.title!.length, 200);
  assert.equal(m.description!.length, 400);
  assert.equal(/\s\s/.test(m.title!), false);
});
test("L11 빈 HTML · 이상한 입력도 던지지 않는다", () => {
  const m = parseLinkMeta("", "https://example.com/");
  assert.deepEqual({ ...m }, { title: null, description: null, image: null, site_name: null, favicon: "https://example.com/favicon.ico" });
  assert.doesNotThrow(() => parseLinkMeta("<meta property=og:title content=plain>", "https://example.com/"));
  assert.equal(parseLinkMeta("<meta property=og:title content=plain>", "https://example.com/").title, "plain");
});
test("L12 같은 키는 첫 것 — og:image:secure_url 이 있으면 그것", () => {
  const m = parseLinkMeta(`<meta property="og:image" content="http://x.example/a.png"><meta property="og:image:secure_url" content="https://x.example/a.png">`, "https://example.com/");
  assert.equal(m.image, "https://x.example/a.png");
});
