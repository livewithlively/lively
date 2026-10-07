#!/usr/bin/env node
// 장표 수정 앱(deck-edit) — HTML 산출물을 **판(version)** 으로 앱 표에 올리는 세션 스크립트 (#4596).
//
//  왜 스크립트인가(실측 #4593): store_* 요청 본문은 1MiB 가 상한이고, AI 가 MCP 인자로 MB 단위를 실을 길이 없다.
//   그래서 세션 안에서 이 스크립트가 HTML 을 머리 1행 + 장 N행 + 꼬리 1행으로 나누고, 머리의 큰 data: 자원(글꼴·그림)은
//   sha256 키로 990,000B 이하 조각(assets)으로 한 번만 올린다(3.7MB 덱 → 24행 3.6초). 다시 이으면 원본과 바이트까지 같다.
//  ⚠ 앱 안의 중첩 문서는 앱의 CSP 를 물려받아 외부 CSS·글꼴이 **조용히** 막힌다(같은 실측). 그래서 올리기 전에 외부 참조를
//   찾아 경고하고, 문서가 쓰는 글꼴 이름 가운데 @font-face 가 없는 것은 첫 글꼴 자원으로 **별칭**을 걸어 둔다
//   (별칭을 걸면 18장 줄 수가 원본과 일치했다 — 대체 글꼴로 그리면 3쪽에서 픽셀 63,606 이 달랐다).
//
//  쓰는 법(세션 안):
//    node bin/deck-push.mjs --doc <문서이름> [--title <제목>] [--session <id>] [--gateway <url>] [--token <파일>] <html>
//    node bin/deck-push.mjs --doc <문서이름> --variant <안 이름> [--slides a,b] <html>   ← 같은 판에 안(variant)을 덧붙인다
//  토큰·게이트웨이 기본값은 ~/.lively/token · ~/.lively/gateway-url, 세션은 LIVELY_SESSION_ID. 표준 모듈만 쓴다(node 18+).
//  순수 함수(splitHtml · assetize · fontAlias · checkExternal · chunk · plan)는 export 해 scripts/deck-push.test.mjs 가 시험한다.
//  같은 함수들을 앱 화면(ui/index.html)도 쓴다 — 사람이 앱에서 폴더의 HTML 을 눌러 바로 올릴 때. 그래서 ⟦deck-split⟧ 블록으로 묶어 두 파일에 같은 글로 둔다.
//  받는 쪽은 bin/deck-pull.mjs(앱의 최신 판을 HTML 파일로 — 원본이 이 세션에 없을 때).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_ID = "deck-edit";
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const byteLen = (s) => Buffer.byteLength(s);

// ⟦deck-split⟧ — 이 표식 사이는 ui/index.html 의 같은 표식 사이와 **글자 하나 다르지 않아야** 한다(scripts/deck-push.test.mjs 가 본다).
//  바깥에서 주는 것: sha256(문자열 → 16진수) · byteLen(문자열 → UTF-8 바이트 수). 여기를 고치면 두 파일을 함께 고친다.
const CHUNK = 990_000;          // 조각 상한 — 요청 본문 1,048,576B 아래에 JSON 포장 여유를 둔 값
const ASSET_MIN = 20_000;       // 이보다 큰 data: URL 만 자원으로 뺀다(작은 아이콘은 그 자리에 둔다)
const GENERIC_FONTS = new Set(["sans-serif", "serif", "monospace", "system-ui", "-apple-system", "blinkmacsystemfont", "ui-monospace",
  "ui-sans-serif", "ui-serif", "apple sd gothic neo", "segoe ui", "roboto", "helvetica", "helvetica neue", "arial", "noto sans kr",
  "malgun gothic", "sfmono-regular", "menlo", "monaco", "consolas", "courier new", "cursive", "fantasy", "inherit", "initial", "unset"]);

/** 문자열을 n 글자 조각으로. 조각은 UTF-16 코드 단위 기준이라 바이트는 그보다 클 수 있다 — data: URL 은 ASCII 라 같다. */
function chunk(s, n = CHUNK) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [""];
}

/**
 * HTML 을 머리 · 장 · 꼬리로 나눈다. 장 = `<section class="…page…">` 바깥 요소(중첩 section 은 안에 둔다).
 *  장 i 의 body 는 **앞 장의 끝(또는 머리의 끝)부터 이 장의 끝까지** — 장 사이의 포장(`</div><div class="pw">` · 발표자 노트)이
 *  그 장에 딸려 간다. 그래서 head + slides + tail 을 이으면 원본과 글자 하나 다르지 않다(앱이 한 장만 보일 때는 CSS 로 가린다).
 *  section.page 가 없으면 body 안쪽 전체가 장 하나(slide_id 'doc').
 */
function splitHtml(html) {
  const starts = [];
  const re = /<section\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const cls = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(tag);
    if (!cls || !/(^|\s)page(\s|$)/.test(cls[2])) continue;
    starts.push({ at: m.index, tag });
  }
  // 중첩된 page(바깥 page 안의 page)는 뺀다 — 바깥 것만 장이다.
  const sections = [];
  for (const s of starts) {
    const end = sectionEnd(html, s.at);
    if (end < 0) continue;
    if (sections.length && s.at < sections[sections.length - 1].end) continue;
    const idm = /\bid\s*=\s*(["'])(.*?)\1/i.exec(s.tag);
    const tm = /\bdata-title\s*=\s*(["'])(.*?)\1/i.exec(s.tag);
    sections.push({ start: s.at, end, id: idm ? idm[2] : "", title: tm ? tm[2] : "" });
  }
  if (!sections.length) {
    const bo = /<body\b[^>]*>/i.exec(html);
    const bc = html.lastIndexOf("</body>");
    if (!bo || bc < 0) return { mode: "doc", head: "", slides: [{ slide_id: "doc", no: 1, body: html, summary: titleOf(html) }], tail: "" };
    const hEnd = bo.index + bo[0].length;
    return { mode: "doc", head: html.slice(0, hEnd), slides: [{ slide_id: "doc", no: 1, body: html.slice(hEnd, bc), summary: titleOf(html) }], tail: html.slice(bc) };
  }
  const head = html.slice(0, sections[0].start);
  const slides = sections.map((s, i) => {
    const from = i === 0 ? s.start : sections[i - 1].end;
    const body = html.slice(from, s.end);
    return { slide_id: s.id || `s${i + 1}`, no: i + 1, body, summary: s.title || headingOf(body) };
  });
  return { mode: "slides", head, slides, tail: html.slice(sections[sections.length - 1].end) };
}

function sectionEnd(html, start) {
  const re = /<\/?section\b[^>]*>/gi;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (m[0][1] === "/") { depth--; if (depth === 0) return m.index + m[0].length; }
    else if (!/\/>$/.test(m[0])) depth++;
  }
  return -1;
}
const strip = (s) => s.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function headingOf(body) { const h = /<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i.exec(body); return h ? strip(h[1]).slice(0, 80) : ""; }
function titleOf(html) { const t = /<title>([\s\S]*?)<\/title>/i.exec(html); return t ? strip(t[1]).slice(0, 80) : ""; }

/**
 * 머리(head) 안의 큰 data: URL 을 자원으로 뺀다. @font-face 블록 안의 것은 글꼴(family · weight 를 기억한다).
 *  반환 head 에는 `__ASSET:<sha>__` 자리표가 들어가고, assets 는 sha 하나당 하나(같은 자원이 두 번 쓰이면 한 번만).
 */
function assetize(head, min = ASSET_MIN) {
  const assets = new Map();
  const fonts = [];
  const take = (dataUrl, meta) => {
    const sha = sha256(dataUrl);
    if (!assets.has(sha)) assets.set(sha, { sha, body: dataUrl, bytes: byteLen(dataUrl), mime: mimeOf(dataUrl), ...(meta || {}) });
    return `__ASSET:${sha}__`;
  };
  let out = head.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    const fam = /font-family\s*:\s*(["']?)([^;"'}]+)\1/i.exec(block);
    const wt = /font-weight\s*:\s*([^;}]+)/i.exec(block);
    let sha = null;
    const rep = block.replace(/url\((["']?)(data:[^)"']+)\1\)/gi, (all, q, du) => {
      if (du.length < min) return all;
      const ph = take(du, {});
      sha = ph.slice(8, -2);
      return `url(${ph})`;
    });
    if (sha) fonts.push({ sha, family: fam ? fam[2].trim() : "", weight: wt ? wt[1].trim() : "" });
    return rep;
  });
  out = out.replace(/(url\((["']?)|src=(["']))(data:[^)"']{1,})(\2|\3)/gi, (all, pre, q1, q2, du, post) => (du.length < min ? all : `${pre}${take(du, {})}${post}`));
  return { head: out, assets: [...assets.values()], fonts };
}
function mimeOf(dataUrl) { const m = /^data:([^;,]+)/.exec(dataUrl); return m ? m[1] : "application/octet-stream"; }

/** 문서가 쓰는 글꼴 이름(font-family 선언의 첫 이름 · --font 류 변수값)을 모은다. 일반 이름(sans-serif 등)은 뺀다. */
function usedFamilies(html) {
  const names = new Set();
  const add = (list) => {
    for (const raw of list.split(",")) {
      const n = raw.trim().replace(/^["']|["']$/g, "").trim();
      if (!n || /^var\(|^!important|\)$/.test(n) || GENERIC_FONTS.has(n.toLowerCase())) continue;
      names.add(n);
      break;   // 첫 이름만(뒤는 대체 글꼴)
    }
  };
  for (const m of html.matchAll(/font-family\s*:\s*([^;}"]+|"[^"]+"[^;}]*|'[^']+'[^;}]*)/gi)) add(m[1]);
  for (const m of html.matchAll(/--[a-z0-9-]*font[a-z0-9-]*\s*:\s*([^;}]+)/gi)) add(m[1]);
  for (const m of html.matchAll(/font\s*:\s*[^;}]*?\d[^;}]*?\s([^;}]+)/gi)) add(m[1]);
  return [...names];
}

/**
 * 별칭 스타일 — @font-face 로 선언되지 않은 채 쓰이는 글꼴 이름을 첫 글꼴 자원에 건다. 글꼴 자원이 없으면 빈 문자열.
 *  (문서가 CDN 의 Pretendard 를 쓰고 파일 안엔 Pretendard Variable 만 있을 때, 앱 안에서 Pretendard 가 비는 것을 막는다.)
 */
function fontAlias(html, fonts) {
  if (!fonts.length) return "";
  const declared = new Set(fonts.map((f) => f.family.toLowerCase()).filter(Boolean));
  const first = fonts[0];
  const missing = usedFamilies(html).filter((n) => !declared.has(n.toLowerCase()));
  if (!missing.length) return "";
  const weight = first.weight || "45 920";
  const rules = missing.map((n) => `@font-face{font-family:${JSON.stringify(n)};font-weight:${weight};font-display:block;src:url(__ASSET:${first.sha}__) format("woff2")}`);
  return `<style data-deck-edit="alias">${rules.join("")}</style>`;
}

/** 앱 안에서 막힐 외부 참조 — 경고용. 같은 주소는 한 번만(먼저 잡힌 종류로). */
function checkExternal(html) {
  const out = [];
  const seen = new Set();
  const push = (kind, url) => { if (seen.has(url)) return; seen.add(url); out.push({ kind, url }); };
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*(["'])(https?:[^"']+)\1/gi)) push("link", m[2]);
  for (const m of html.matchAll(/@import\s+(?:url\()?\s*(["']?)(https?:[^"')\s]+)\1/gi)) push("@import", m[2]);
  for (const m of html.matchAll(/<(script|img|iframe)\b[^>]*\bsrc\s*=\s*(["'])(https?:[^"']+)\2/gi)) push(m[1], m[3]);
  for (const m of html.matchAll(/url\((["']?)(https?:[^)"']+)\1\)/gi)) push("url()", m[2]);
  return out;
}

/**
 * 올릴 행을 짠다. 반환 { mode, rows, assets, warnings, slides }.
 *  rows: versions 표 행(kind head|slide|tail · seq · slide_id · variant · body · summary) — 자리표가 든 머리, 장들, 꼬리.
 *  assets: assets 표 행(sha · seq · body · bytes · mime) — 조각으로 나눈 것.
 */
function plan(html, opts = {}) {
  const variant = String(opts.variant || "");
  const only = opts.slides ? new Set(String(opts.slides).split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const sp = splitHtml(html);
  const { head, assets, fonts } = assetize(sp.head, opts.assetMin);
  const alias = fontAlias(html, fonts);
  const head2 = alias ? (head.includes("</head>") ? head.replace("</head>", () => alias + "</head>") : head + alias) : head;
  const rows = [];
  if (!variant) rows.push({ kind: "head", seq: 0, slide_id: "", variant: "", body: head2, summary: "" });
  sp.slides.forEach((s) => {
    if (only && !only.has(s.slide_id)) return;
    rows.push({ kind: "slide", seq: s.no, slide_id: s.slide_id, variant, body: s.body, summary: s.summary || "" });
  });
  if (!variant) rows.push({ kind: "tail", seq: sp.slides.length + 1, slide_id: "", variant: "", body: sp.tail, summary: "" });
  const assetRows = [];
  for (const a of assets) chunk(a.body).forEach((part, i) => assetRows.push({ sha: a.sha, seq: i, body: part, bytes: byteLen(part), mime: a.mime }));
  const warnings = checkExternal(html).map((e) => `외부 참조 ${e.kind} ${e.url} — 앱 안에서는 막힙니다(네트워크 0). 파일 안에 넣어 두세요.`);
  const big = rows.filter((r) => byteLen(r.body) > CHUNK).map((r) => `${r.kind} ${r.slide_id || r.seq} 가 ${byteLen(r.body)}B 로 한 행 상한(${CHUNK}B)을 넘습니다 — 장 안의 큰 data: 그림을 파일 밖으로 빼거나 장을 나누세요.`);
  return { mode: sp.mode, rows, assets: assetRows, warnings: warnings.concat(big), slides: sp.slides.map((s) => ({ slide_id: s.slide_id, no: s.no, summary: s.summary })), fonts, alias: !!alias };
}
// ⟦/deck-split⟧

export { CHUNK, ASSET_MIN, chunk, splitHtml, assetize, usedFamilies, fontAlias, checkExternal, plan };

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1"; o[k] = v; }
    else o._.push(a);
  }
  return o;
}
function readLocal(rel) { try { return readFileSync(join(process.env.LIVELY_HOME || homedir(), ".lively", rel), "utf8").trim() || null; } catch { return null; } }

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const file = a._[0];
  if (!file || !a.doc) {
    console.error("쓰는 법: node bin/deck-push.mjs --doc <문서이름> [--title <제목>] [--variant <안> [--slides a,b]] [--session <id>] [--gateway <url>] [--token <파일>] <html>");
    process.exit(2);
  }
  const html = readFileSync(file, "utf8");
  const token = (a.token ? readFileSync(a.token, "utf8").trim() : (process.env.LIVELY_TOKEN || "").trim()) || readLocal("token");
  let gw = (a.gateway || process.env.LIVELY_GATEWAY_URL || readLocal("gateway-url") || "http://localhost:8080").replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");
  const sid = a.session || process.env.LIVELY_SESSION_ID || "";
  if (!token) { console.error("토큰이 없습니다 — ~/.lively/token 또는 --token <파일>"); process.exit(2); }
  if (!sid) { console.error("세션 id 가 없습니다 — 라이블리 세션 안에서 돌리거나 --session <id>. 붙은 앱 판정에 필요합니다."); process.exit(2); }
  const headers = { authorization: "Bearer " + token, "content-type": "application/json", "x-lively-session": sid };
  const ws = (process.env.LVLY_TENANT_SLUG || "").trim(); if (ws) headers["x-lively-workspace"] = ws;
  const call = async (table, verb, body) => {
    const res = await fetch(`${gw}/api/ui/store/${encodeURIComponent(table)}/${verb}`, { method: "POST", headers, body: JSON.stringify({ app_id: APP_ID, ...body }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${table}/${verb} ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return {}; }
  };
  const q = async (table, match, limit = 100) => (await call(table, "query", { match, limit })).rows || [];
  const ins = (table, row) => call(table, "insert", { row });
  const upd = (table, match, set) => call(table, "update", { match, set });

  const p = plan(html, { variant: a.variant, slides: a.slides });
  for (const w of p.warnings) console.error("⚠ " + w);
  const now = new Date().toISOString();
  const existing = await q("docs", { doc: a.doc }, 1);
  const latest = existing.length ? Number(existing[0].latest_ver || 0) : 0;
  const ver = a.variant ? (latest || 1) : latest + 1;
  if (a.variant && !latest) console.error("⚠ 아직 판이 없는 문서에 안(variant)을 올립니다 — 판 1 로 올립니다. 먼저 variant 없이 한 번 올리는 것이 맞습니다.");

  // 자원: 있는 sha 는 건너뛴다(글꼴은 처음 한 번만 든다).
  let newAssets = 0;
  const shas = [...new Set(p.assets.map((r) => r.sha))];
  for (const sha of shas) {
    const have = await q("assets", { sha }, 1);
    if (have.length) continue;
    for (const r of p.assets.filter((x) => x.sha === sha)) await ins("assets", r);
    newAssets++;
  }
  // 판 행.
  for (const r of p.rows) await ins("versions", { doc: a.doc, ver, ...r, session: sid });   // created_at 은 시스템 칸(저절로 붙는다) — 적지 않는다
  // 문서 행.
  const title = a.title || (existing[0] && existing[0].title) || titleOf(html) || a.doc;
  if (existing.length) await upd("docs", { id: existing[0].id }, { latest_ver: ver, title, source_path: file, changed_at: now, session: sid });
  else await ins("docs", { doc: a.doc, title, session: sid, latest_ver: ver, source_path: file, changed_at: now });
  console.log(`판 ${ver} 올림 · 장 ${p.rows.filter((r) => r.kind === "slide").length}${a.variant ? ` (안 「${a.variant}」)` : ""} · 자원 ${shas.length}(새 ${newAssets})${p.alias ? " · 글꼴 별칭 걸음" : ""}${p.warnings.length ? ` · 경고 ${p.warnings.length}` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("deck-push.mjs")) {
  main().catch((e) => { console.error("실패: " + (e && e.message ? e.message : e)); process.exit(1); });
}
