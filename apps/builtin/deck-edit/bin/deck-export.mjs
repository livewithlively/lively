#!/usr/bin/env node
// 장표 수정 앱(deck-edit) — 앱에서 단 의견을 **장 위에 얹어** HTML · PDF 로 내보내는 세션 스크립트 (#4636). deck-pull.mjs 의 형제다.
//
//  왜 필요한가: 앱에서 단 의견은 세션의 AI 에게 가는 것뿐이었다. 사람에게 「여기 이렇게 고쳐 주세요」 를 넘길 때는 장표 위에 자리 표시가 찍히고
//   그 옆에 의견이 적힌 PDF 한 벌이 필요하다. 앱 화면은 샌드박스(allow-scripts 뿐)라 인쇄 · 내려받기를 못 하므로 세션에서 뽑는다.
//
//  무엇이 나오나: 장마다 한 쪽. 왼쪽은 장표 그대로이고 그 위에 번호표가 선다 — 핀(한 점) · 영역/개체(상자) · 고친 글 줄(그 글의 테두리).
//   오른쪽 칸에는 같은 번호로 의견이 적힌다(고친 글은 바탕 글 → 고친 글). 장 전체 의견은 번호 없이 맨 위에, 문서 전체 의견 · 장 순서는 첫 쪽 칸에.
//   쪽 크기는 장표 폭 + 의견 칸 폭 × 장표 높이(1280×720 장표면 1700×720).
//
//  쓰는 법(세션 안):
//    node bin/deck-export.mjs --doc <문서이름> [--ver <판>] [--bundle <묶음>] [--draft] [--only-commented] [--by <이름>] [--base] <받을 경로.pdf|.html>
//  받을 경로가 .pdf 면 같은 자리에 .html 도 함께 남기고 크롬(헤드리스)으로 PDF 를 굽는다(크롬 자리: --chrome <경로> 또는 CHROME_PATH).
//  기본은 그 판의 의견 전부 + 지난 판에 남긴 채 안 보낸 것(앱 화면에 보이는 것과 같다). --bundle K 는 그 묶음만, --draft 는 아직 안 보낸 것만.
//  표준 모듈만 쓴다(node 18+). 순수 함수 annotateHtml 은 export 해 scripts/deck-push.test.mjs 가 본다.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assembleHtml, APP_ID } from "./deck-pull.mjs";

/** 내보낼 의견만 고른다 — 글이 있는 것(의견이나 고친 글). 질문(ask) · 빈 행은 뺀다. */
export function pickComments(comments, { ver, bundle = null, draftOnly = false } = {}) {
  return comments.filter((c) => {
    if (!["unit", "spot", "slide", "doc", "order"].includes(c.scope)) return false;
    if (!String(c.note || "").trim() && c.edited == null) return false;
    if (bundle != null) return Number(c.bundle) === Number(bundle);
    if (draftOnly && c.status !== "draft") return false;
    return Number(c.ver) === Number(ver) || (Number(c.ver) < Number(ver) && c.status === "draft");
  }).sort((a, b) => Number(a.id) - Number(b.id));
}

//  내보낸 문서 안에서 도는 스크립트 — 장(section.page 바깥 것 · 없으면 body 전체)을 찾아 쪽 틀에 넣고 번호표와 의견 칸을 세운다.
//   장 id 규칙은 deck-push 의 splitHtml 과 같다(id 속성 · 없으면 s<번호> · 장이 없으면 'doc').
const RUNTIME = "(" + function (D) {
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function norm(s) { return String(s || "").replace(/==|\*\*/g, "").replace(/\s+/g, " ").trim(); }
  function geo(c) {
    var m = /^(pin|box|obj):([\d.,]+)$/.exec(String(c.unit_key || "")); if (!m) return null;
    var a = m[2].split(",").map(Number);
    if (a.some(function (v) { return !(v >= 0 && v <= 1); })) return null;
    if (m[1] === "pin") return a.length === 2 ? { k: "pin", x: a[0], y: a[1] } : null;
    return a.length === 4 ? { k: m[1], x: a[0], y: a[1], w: a[2], h: a[3] } : null;
  }
  /** 글 줄 의견이 가리키는 요소 — 그 글(바탕 글 · 없으면 열쇠에 든 앞 20자)을 담은 가장 안쪽 요소. 못 찾으면 null(칸에만 적는다). */
  function findUnit(sec, c) {
    var want = norm(c.orig), key = norm(String(c.unit_key || "").split("|").slice(2).join("|"));
    var best = null, bestLen = Infinity;
    [want, key].some(function (t) {
      if (!t || t.length < 2) return false;
      var all = sec.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var e = all[i]; if (/^(SCRIPT|STYLE|SVG|svg)$/.test(e.tagName) || e.closest(".dx-layer")) continue;
        var tx = norm(e.textContent); if (tx.indexOf(t) < 0) continue;
        if (tx.length <= bestLen) { best = e; bestLen = tx.length; }
      }
      return !!best;
    });
    return best;
  }
  function run() {
    var secs = [].slice.call(document.querySelectorAll("section")).filter(function (s) { return /(^|\s)page(\s|$)/.test(s.className) && !(s.parentElement && s.parentElement.closest("section.page")); });
    var docMode = !secs.length;
    if (docMode) { var wrap = el("div", "dx-doc"); while (document.body.firstChild) wrap.appendChild(document.body.firstChild); document.body.appendChild(wrap); secs = [wrap]; }
    var W = secs[0].offsetWidth || 1280, H = docMode ? 0 : (secs[0].offsetHeight || 720), P = Math.round(Math.max(360, W * 0.33));
    var st = el("style"); st.textContent = (docMode ? "" : "@page{size:" + (W + P) + "px " + H + "px;margin:0}") + ".dx-page{width:" + (W + P) + "px;" + (H ? "height:" + H + "px;" : "") + "}.dx-stage{width:" + W + "px;" + (H ? "height:" + H + "px;" : "") + "}.dx-side{width:" + P + "px;}";
    document.head.appendChild(st);
    var general = D.comments.filter(function (c) { return c.scope === "doc" || c.scope === "order"; });
    var shown = 0, fits = [];
    secs.forEach(function (sec, i) {
      var sid = docMode ? "doc" : (sec.id || "s" + (i + 1));
      var mine = D.comments.filter(function (c) { return c.slide_id === sid && (c.scope === "spot" || c.scope === "unit" || c.scope === "slide"); });
      var gen = shown === 0 ? general : [];
      if (D.onlyCommented && !mine.length && !gen.length) { sec.style.display = "none"; return; }
      shown++;
      var page = el("div", "dx-page"), stage = el("div", "dx-stage"), layer = el("div", "dx-layer"), side = el("aside", "dx-side");
      sec.parentNode.insertBefore(page, sec); stage.appendChild(sec); stage.appendChild(layer); page.appendChild(stage); page.appendChild(side);
      var head = el("div", "dx-h"); head.appendChild(el("b", "", "의견")); head.appendChild(el("span", "", docMode ? "" : "장 " + (i + 1) + " / " + secs.length)); side.appendChild(head);
      var list = el("div", "dx-list"); side.appendChild(list);
      function item(no, kind, c, ctx) {
        var it = el("div", "dx-it " + kind);
        it.appendChild(no ? el("i", "dx-no", String(no)) : el("i", "dx-no all", kind === "gen" ? "문서" : "장"));
        var body = el("div", "dx-b");
        if (ctx) body.appendChild(el("div", "dx-ctx", ctx));
        if (c.scope === "unit" && c.edited != null) {
          var ed = el("div", "dx-ed"); ed.appendChild(el("s", "", norm(c.orig))); ed.appendChild(el("span", "dx-ar", "→")); ed.appendChild(el("b", "", norm(c.edited) || "(지움)")); body.appendChild(ed);
        }
        if (String(c.note || "").trim()) body.appendChild(el("div", "dx-nt", String(c.note).trim()));
        it.appendChild(body); list.appendChild(it);
      }
      gen.forEach(function (c) { item(0, "gen", c, c.scope === "order" ? "장 순서 바꾸기" : "문서 전체"); });
      mine.filter(function (c) { return c.scope === "slide"; }).forEach(function (c) { item(0, "all", c, "장 전체"); });
      var n = 0, late = [];
      mine.filter(function (c) { return c.scope !== "slide"; }).forEach(function (c) {
        n++;
        if (c.scope === "spot") {
          var g = geo(c); if (!g) { item(n, "spot", c, c.orig); return; }
          var m;
          if (g.k === "pin") { m = el("b", "dx-pin", String(n)); m.style.left = g.x * 100 + "%"; m.style.top = g.y * 100 + "%"; }
          else { m = el("div", "dx-box" + (g.k === "obj" ? " obj" : "")); m.style.left = g.x * 100 + "%"; m.style.top = g.y * 100 + "%"; m.style.width = g.w * 100 + "%"; m.style.height = g.h * 100 + "%"; m.appendChild(el("b", "", String(n))); }
          layer.appendChild(m);
          item(n, "spot", c, "");
        } else {
          var no = n; late.push(function () {
            var t = findUnit(sec, c); if (!t) return;
            var r = t.getBoundingClientRect(), s = stage.getBoundingClientRect(); if (!r.width || !r.height) return;
            var m = el("div", "dx-box txt"); m.style.left = (r.left - s.left - 4) + "px"; m.style.top = (r.top - s.top - 3) + "px"; m.style.width = (r.width + 8) + "px"; m.style.height = (r.height + 6) + "px"; m.appendChild(el("b", "", String(no))); layer.appendChild(m);
          });
          item(n, "txt", c, c.edited != null ? "" : "「" + norm(c.orig).slice(0, 40) + (norm(c.orig).length > 40 ? "…" : "") + "」");
        }
      });
      if (!list.children.length) list.appendChild(el("div", "dx-none", "의견 없음"));
      if (D.by) side.appendChild(el("div", "dx-by", D.by));
      fits.push(function () {
        late.forEach(function (f) { f(); });
        if (!H) return;
        var fs = 15; while (fs > 11.5 && list.scrollHeight > list.clientHeight + 1) { fs -= 0.5; list.style.fontSize = fs + "px"; }
        //  그래도 넘치면 남는 의견은 다음 쪽(이어서)으로 넘긴다 — 세 단으로 적는다
        var over = []; while (list.children.length > 1 && list.scrollHeight > list.clientHeight + 1) over.unshift(list.removeChild(list.lastChild));
        if (!over.length) return;
        list.appendChild(el("div", "dx-none", "→ 다음 쪽에 이어짐"));
        if (list.scrollHeight > list.clientHeight + 1 && list.children.length > 2) { over.unshift(list.removeChild(list.children[list.children.length - 2])); }
        var more = el("div", "dx-page dx-more"), mh = el("div", "dx-h"), ml = el("div", "dx-list");
        mh.appendChild(el("b", "", "의견 (이어서)")); mh.appendChild(el("span", "", "장 " + (i + 1) + " / " + secs.length));
        over.forEach(function (o) { ml.appendChild(o); }); more.appendChild(mh); more.appendChild(ml);
        page.parentNode.insertBefore(more, page.nextSibling);
      });
    });
    //  글 줄의 테두리와 칸 맞춤은 글꼴이 다 실린 뒤 한 번만 잰다(글꼴이 바뀌면 줄 자리가 달라진다)
    var done = false;
    function place() { if (done) return; done = true; fits.forEach(function (f) { f(); }); document.documentElement.setAttribute("data-dx", "ready"); }
    var loaded = document.readyState === "complete" ? Promise.resolve() : new Promise(function (ok) { window.addEventListener("load", ok); });
    Promise.all([loaded, document.fonts && document.fonts.ready ? document.fonts.ready : null]).then(place, place);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
} + ")";

const STYLE = `
.dx-page,.dx-page .dx-stage,.dx-page .dx-side,.dx-page .dx-list,.dx-page .dx-it,.dx-page .dx-b{box-sizing:border-box}
.dx-page{display:flex;align-items:stretch;flex:none;background:#fff;position:relative;overflow:hidden;break-after:page;page-break-after:always;break-inside:avoid}
.dx-stage{position:relative;flex:none;overflow:hidden}
.dx-stage>section,.dx-stage>.dx-doc{break-after:auto!important;page-break-after:auto!important;margin:0!important;border-radius:0!important;box-shadow:none!important}
.dx-layer{position:absolute;inset:0;z-index:2147483000;pointer-events:none}
.dx-pin{position:absolute;transform:translate(-50%,-50%);min-width:24px;height:24px;padding:0 6px;border-radius:12px;display:grid;place-items:center;font:800 13px/1 ui-monospace,Menlo,monospace;color:#3A2400;background:#F2B56B;border:2px solid #fff;outline:1px solid #B97A2E}
.dx-box{position:absolute;border:2px dashed #D98A2B;background:rgba(242,181,107,.13);border-radius:4px}
.dx-box.obj{border-style:solid}
.dx-box.txt{border:2px solid #2D6BF0;background:rgba(45,107,240,.07)}
.dx-box>b{position:absolute;left:-2px;top:-2px;transform:translateY(-100%);min-width:22px;height:20px;padding:0 6px;border-radius:5px 5px 5px 0;display:grid;place-items:center;font:800 12.5px/1 ui-monospace,Menlo,monospace;color:#3A2400;background:#F2B56B}
.dx-box.txt>b{color:#fff;background:#2D6BF0}
.dx-side{flex:none;display:flex;flex-direction:column;gap:10px;padding:22px 20px 16px;background:#FBFAF7;border-left:1px solid #E4DFD3;color:#15233B;font-family:inherit;text-align:left;word-break:keep-all;overflow-wrap:anywhere;min-height:0}
.dx-h{flex:none;display:flex;align-items:baseline;justify-content:space-between;padding-bottom:9px;border-bottom:2px solid #15233B;font-size:13px;color:#8A8371}
.dx-h b{font-size:17px;font-weight:800;color:#15233B}
.dx-list{flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:9px;font-size:15px;line-height:1.5}
.dx-it{display:flex;gap:9px;align-items:flex-start}
.dx-no{flex:none;font-style:normal;min-width:22px;height:22px;padding:0 6px;border-radius:11px;display:grid;place-items:center;font:800 12.5px/1 ui-monospace,Menlo,monospace;color:#3A2400;background:#F2B56B;margin-top:.1em}
.dx-it.txt .dx-no{color:#fff;background:#2D6BF0}
.dx-no.all{font-family:inherit;font-size:11.5px;color:#fff;background:#15233B;border-radius:5px}
.dx-b{flex:1 1 auto;min-width:0}
.dx-ctx{font-size:.8em;font-weight:700;color:#8A8371}
.dx-ed{font-size:.93em;color:#5A6B85}
.dx-ed s{color:#9AA3B5}
.dx-ed .dx-ar{margin:0 5px;color:#2D6BF0;font-weight:800}
.dx-ed b{color:#1E54CC;font-weight:700}
.dx-nt{font-weight:600;white-space:pre-wrap}
.dx-none{color:#B5AE9C;font-size:13px}
.dx-by{flex:none;font-size:11.5px;color:#8A8371;text-align:right}
.dx-more{flex-direction:column;gap:12px;padding:30px 36px 24px;background:#FBFAF7;color:#15233B;text-align:left;word-break:keep-all;overflow-wrap:anywhere}
.dx-more .dx-list{display:block;column-count:3;column-gap:30px;column-fill:auto;font-size:14px}
.dx-more .dx-it{break-inside:avoid;margin-bottom:10px}
@media screen{.dx-page{box-shadow:0 10px 34px rgba(21,35,59,.13)}}
@media print{.dx-page{box-shadow:none}}
`;

/**
 * 이은 HTML 에 의견을 얹는다 — `</body>` 앞에 스타일 · 의견(JSON) · 스크립트를 끼운다. 장표의 글은 건드리지 않는다.
 *  comments 는 pickComments 로 고른 행. opts: { by(의견 칸 아래 한 줄 — 누가 · 언제), onlyCommented(의견 없는 장은 뺀다) }.
 */
export function annotateHtml(html, comments, opts = {}) {
  const rows = comments.map((c) => ({ id: c.id, scope: c.scope, slide_id: c.slide_id || "", unit_key: c.unit_key || "", orig: c.orig || "", edited: c.edited == null ? null : String(c.edited), note: c.note || "", status: c.status || "" }));
  const data = JSON.stringify({ comments: rows, by: opts.by || "", onlyCommented: !!opts.onlyCommented }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const add = `<style data-deck-export>${STYLE}</style><script data-deck-export>${RUNTIME}(${data});</script>`;
  const at = html.lastIndexOf("</body>");
  return at < 0 ? html + add : html.slice(0, at) + add + html.slice(at);
}

/** 이 기계의 크롬 — 준 경로 · CHROME_PATH · 흔한 자리 차례로. 없으면 null. */
export function findChrome(given) {
  const cands = [given, process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"];
  return cands.find((p) => p && existsSync(p)) || null;
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") && !["draft", "only-commented", "base"].includes(k) ? argv[++i] : "1"; o[k] = v; }
    else o._.push(a);
  }
  return o;
}
function readLocal(rel) { try { return readFileSync(join(process.env.LIVELY_HOME || homedir(), ".lively", rel), "utf8").trim() || null; } catch { return null; } }

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = a._[0];
  if (!out || !a.doc) {
    console.error("쓰는 법: node bin/deck-export.mjs --doc <문서이름> [--ver <판>] [--bundle <묶음>] [--draft] [--only-commented] [--by <이름>] [--base] [--chrome <경로>] <받을 경로.pdf|.html>");
    process.exit(2);
  }
  const token = (a.token ? readFileSync(a.token, "utf8").trim() : (process.env.LIVELY_TOKEN || "").trim()) || readLocal("token");
  const gw = (a.gateway || process.env.LIVELY_GATEWAY_URL || readLocal("gateway-url") || "http://localhost:8080").replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");
  const sid = a.session || process.env.LIVELY_SESSION_ID || "";
  if (!token) { console.error("토큰이 없습니다 — ~/.lively/token 또는 --token <파일>"); process.exit(2); }
  if (!sid) { console.error("세션 id 가 없습니다 — 라이블리 세션 안에서 돌리거나 --session <id>. 붙은 앱 판정에 필요합니다."); process.exit(2); }
  const headers = { authorization: "Bearer " + token, "content-type": "application/json", "x-lively-session": sid };
  const ws = (process.env.LVLY_TENANT_SLUG || "").trim(); if (ws) headers["x-lively-workspace"] = ws;
  const q = async (table, match, limit = 100) => {
    const res = await fetch(`${gw}/api/ui/store/${encodeURIComponent(table)}/query`, { method: "POST", headers, body: JSON.stringify({ app_id: APP_ID, match, limit }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${table}/query ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text).rows || []; } catch { return []; }
  };
  const docs = await q("docs", { doc: a.doc }, 1);
  if (!docs.length) { console.error(`문서가 없습니다: ${a.doc} — 앱의 docs 표에서 doc 칸을 확인하세요(store_query docs).`); process.exit(1); }
  const ver = Number(a.ver) || Number(docs[0].latest_ver) || 1;
  const rows = await q("versions", { doc: a.doc, ver }, 1000);
  if (!rows.some((r) => r.kind === "head")) { console.error(`판 ${ver} 이 없습니다(문서 ${a.doc} 의 최신 판은 ${docs[0].latest_ver}).`); process.exit(1); }
  const shas = new Set();
  for (const r of rows) for (const m of String(r.body || "").matchAll(/__ASSET:([0-9a-f]{64})__/g)) shas.add(m[1]);
  const assets = new Map();
  for (const sha of shas) {
    const parts = (await q("assets", { sha }, 200)).sort((x, y) => Number(x.seq) - Number(y.seq));
    if (parts.length) assets.set(sha, parts.map((p) => p.body).join(""));
  }
  const picks = {};
  if (!a.base) for (const p of await q("picks", { doc: a.doc, ver }, 500)) picks[p.slide_id] = p.variant || "";
  const comments = pickComments(await q("comments", { doc: a.doc }, 1000), { ver, bundle: a.bundle != null ? Number(a.bundle) : null, draftOnly: !!a.draft });
  if (!comments.length) { console.error(`내보낼 의견이 없습니다(문서 ${a.doc} · 판 ${ver}${a.bundle != null ? ` · 묶음 #${a.bundle}` : ""}) — 앱에서 단 의견이 저장됐는지 확인하세요.`); process.exit(1); }
  const html = annotateHtml(assembleHtml(rows, assets, picks), comments, { by: a.by || "", onlyCommented: !!a["only-commented"] });
  const pdf = /\.pdf$/i.test(out);
  const htmlOut = resolve(pdf ? out.replace(/\.pdf$/i, ".html") : out);
  mkdirSync(dirname(htmlOut), { recursive: true });
  writeFileSync(htmlOut, html);
  const n = { spot: 0, unit: 0, slide: 0, doc: 0, order: 0 };
  for (const c of comments) n[c.scope]++;
  const sum = `판 ${ver} · 의견 ${comments.length}(자리 ${n.spot} · 글 ${n.unit} · 장 전체 ${n.slide}${n.doc + n.order ? ` · 문서 ${n.doc + n.order}` : ""})`;
  if (!pdf) { console.log(`${sum} · ${htmlOut}`); return; }
  const chrome = findChrome(a.chrome);
  if (!chrome) { console.error(`${sum} · HTML 은 남겼습니다: ${htmlOut}\n크롬을 못 찾아 PDF 는 굽지 못했습니다 — --chrome <경로> 를 주거나, 그 HTML 을 브라우저에서 열어 인쇄(PDF 로 저장 · 여백 없음 · 배경 그래픽)하세요.`); process.exit(1); }
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=8000", "--run-all-compositor-stages-before-draw", `--print-to-pdf=${resolve(out)}`, pathToFileURL(htmlOut).href], { stdio: "ignore", timeout: 120_000 });
  console.log(`${sum} · ${resolve(out)} (HTML: ${htmlOut})`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("deck-export.mjs")) {
  main().catch((e) => { console.error("실패: " + (e && e.message ? e.message : e)); process.exit(1); });
}
