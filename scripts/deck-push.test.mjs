// 장표 수정 앱 · 판 올리기 스크립트(apps/builtin/deck-edit/bin/deck-push.mjs)의 순수 함수 (#4596).
//
//  왜 시험하나: 판은 머리 1행 + 장 N행 + 꼬리 1행으로 나뉘어 앱 표에 들어가고, 앱이 그것을 다시 이어 그린다. 나누기가
//   한 글자라도 어긋나면 장표가 깨지거나 글 줄이 어긋난다. 또 store_* 본문 상한(1MiB, 실측 #4593)을 넘는 조각이 생기면
//   올리기가 413 으로 멈춘다. 그래서 ① 나눈 것을 이으면 원본과 같다 ② 자원 조각은 990,000자 이하 ③ 글꼴 별칭이 걸린다
//   ④ 외부 참조를 잡는다 — 네 가지를 고정한다.
//  실행: node scripts/deck-push.test.mjs
import assert from "node:assert/strict";
import { splitHtml, assetize, fontAlias, checkExternal, chunk, plan, usedFamilies, CHUNK } from "../apps/builtin/deck-edit/bin/deck-push.mjs";

let pass = 0;
const ok = (c, name, detail = "") => { assert.ok(c, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };
const red = (fn, name) => { let threw = false; try { fn(); } catch { threw = true; } ok(threw, name); };

// ── S1 나누기: section.page 바깥 것만 장, 이으면 원본 ──
const bigFont = "data:font/woff2;base64," + "A".repeat(50_000);
const smallImg = "data:image/png;base64,iVBORw0KGgo=";
const deck = `<!doctype html><html><head><meta charset="utf-8"><title>덱</title>
<link rel="stylesheet" href="https://cdn.example.com/pretendard.css">
<style>@font-face{font-family:"Pretendard Variable";font-weight:45 920;src:url(${bigFont}) format("woff2")} :root{--font:Pretendard,-apple-system,sans-serif} body{font-family:var(--font)} .x{font-family:Georgia,serif}</style>
<style>.logo{background:url(${smallImg})}</style></head><body><main id="deck">
<div class="pw"><section class="page" id="s1" data-title="표지"><h1>제목 <b>굵게</b></h1><section class="inner page">안쪽</section></section></div>
<div class="note">노트</div>
<div class="pw"><section class="page" id="s2"><h2>둘째 장</h2><p>글</p></section></div>
</main></body></html>`;
{
  const sp = splitHtml(deck);
  ok(sp.mode === "slides" && sp.slides.length === 2, "S1a 바깥 section.page 둘만 장이다(안쪽 중첩 page 는 장이 아니다)", JSON.stringify(sp.slides.map((s) => s.slide_id)));
  ok(sp.slides[0].slide_id === "s1" && sp.slides[0].summary === "표지", "S1b 장 id 와 data-title");
  ok(sp.slides[1].summary === "둘째 장", "S1c data-title 이 없으면 h2 글이 요약");
  ok(sp.head + sp.slides.map((s) => s.body).join("") + sp.tail === deck, "S1d 머리 + 장들 + 꼬리를 이으면 원본과 글자까지 같다");
  ok(sp.slides[1].body.startsWith("</div>\n<div class=\"note\">"), "S1e 장 사이의 포장·노트는 다음 장에 딸린다(이어 붙이면 원본)");
  const doc = splitHtml("<!doctype html><html><head></head><body><h1>보고서</h1><p>본문</p></body></html>");
  ok(doc.mode === "doc" && doc.slides.length === 1 && doc.slides[0].slide_id === "doc" && doc.head.endsWith("<body>") && doc.tail === "</body></html>", "S1f section.page 가 없으면 body 안쪽이 장 하나");
}

// ── S2 자원 분리: 큰 data: 만 자리표로, 글꼴은 family·weight 를 기억, 이으면 원본 ──
{
  const sp = splitHtml(deck);
  const { head, assets, fonts } = assetize(sp.head);
  ok(assets.length === 1 && fonts.length === 1 && fonts[0].family === "Pretendard Variable" && fonts[0].weight === "45 920", "S2a 큰 글꼴 하나만 자원(작은 그림은 그 자리에)", JSON.stringify(fonts));
  ok(/__ASSET:[0-9a-f]{64}__/.test(head) && head.includes(smallImg), "S2b 자리표가 들어가고 작은 data: 는 남는다");
  const re = head.replace(/__ASSET:([0-9a-f]{64})__/g, (m, sha) => assets.find((a) => a.sha === sha).body);
  ok(re === sp.head, "S2c 자리표를 자원으로 메우면 원본 머리와 같다");
  const twice = assetize(`<style>@font-face{font-family:A;src:url(${bigFont})} .a{background:url(${bigFont})}</style>`);
  ok(twice.assets.length === 1 && (twice.head.match(/__ASSET:/g) || []).length === 2, "S2d 같은 자원이 두 번 쓰이면 자원은 하나, 자리표는 둘");
}

// ── S3 조각: 990,000 이하, 이으면 원본 ──
{
  const s = "x".repeat(CHUNK * 2 + 17);
  const parts = chunk(s);
  ok(parts.length === 3 && parts.every((p) => p.length <= CHUNK) && parts.join("") === s, "S3a 조각은 상한 이하이고 이으면 원본");
  ok(chunk("").length === 1, "S3b 빈 문자열도 조각 하나(행이 0개가 되지 않게)");
  const p = plan(deck);
  ok(p.assets.every((r) => Buffer.byteLength(r.body) <= CHUNK), "S3c 자원 행마다 바이트 ≤ 990,000");
}

// ── S4 글꼴 별칭: 선언 없이 쓰이는 이름(Pretendard · Georgia)을 첫 글꼴 자원에 건다 ──
{
  const used = usedFamilies(deck);
  ok(used.includes("Pretendard") && used.includes("Georgia") && used.includes("Pretendard Variable") && !used.includes("sans-serif"), "S4a 쓰는 글꼴 이름을 모은다(일반 이름 제외)", JSON.stringify(used));
  const sp = splitHtml(deck); const { fonts } = assetize(sp.head);
  const alias = fontAlias(deck, fonts);
  ok(alias.includes('font-family:"Pretendard"') && alias.includes('font-family:"Georgia"') && !alias.includes('"Pretendard Variable"') && alias.includes(`__ASSET:${fonts[0].sha}__`), "S4b 별칭은 선언 없는 이름에만, 첫 글꼴 자원으로");
  ok(fontAlias(deck, []) === "", "S4c 글꼴 자원이 없으면 별칭도 없다");
  const p = plan(deck);
  ok(p.rows[0].kind === "head" && p.rows[0].body.includes('data-deck-edit="alias"') && p.rows[0].body.indexOf("</head>") > p.rows[0].body.indexOf('data-deck-edit="alias"'), "S4d 별칭 스타일은 머리 </head> 앞에");
}

// ── S5 외부 참조 경고 ──
{
  const ext = checkExternal(deck);
  ok(ext.length === 1 && ext[0].kind === "link" && ext[0].url.startsWith("https://cdn.example.com/"), "S5a CDN 스타일시트를 잡는다", JSON.stringify(ext));
  const ext2 = checkExternal('<style>@import url("https://a.b/c.css"); .x{background:url(https://a.b/i.png)}</style><img src="https://a.b/p.png">');
  ok(ext2.map((e) => e.kind).sort().join(",") === "@import,img,url()", "S5b @import · img · url() 도 잡는다", JSON.stringify(ext2));
  ok(plan(deck).warnings.some((w) => w.includes("cdn.example.com")), "S5c plan 의 경고에 들어간다");
}

// ── S6 plan 행 모양 ──
{
  const p = plan(deck, { variant: "" });
  ok(p.rows.length === 4 && p.rows[0].kind === "head" && p.rows[0].seq === 0 && p.rows[3].kind === "tail" && p.rows[3].seq === 3, "S6a 머리 0 · 장 1..N · 꼬리 N+1");
  ok(p.rows[1].slide_id === "s1" && p.rows[1].variant === "" && p.rows[2].summary === "둘째 장", "S6b 장 행에 slide_id · variant · summary");
  const v = plan(deck, { variant: "2안", slides: "s2" });
  ok(v.rows.length === 1 && v.rows[0].kind === "slide" && v.rows[0].slide_id === "s2" && v.rows[0].variant === "2안", "S6c 안(variant)은 고른 장 행만, 머리·꼬리 없이");
  const huge = deck.replace("<p>글</p>", `<p><img src="data:image/png;base64,${"B".repeat(CHUNK + 10)}"></p>`);
  ok(plan(huge).warnings.some((w) => w.includes("한 행 상한")), "S6d 장 하나가 상한을 넘으면 경고");
}

// ── 빨간불 확인: 나누기가 어긋나면 S1d 가 잡는다(변이 1발) ──
red(() => { const sp = splitHtml(deck); assert.equal(sp.head + sp.slides.map((s) => s.body.slice(1)).join("") + sp.tail, deck); }, "R1 장 body 를 한 글자 깎으면 S1d 식 비교가 빨간불");

console.log(`\n${pass} passed`);
