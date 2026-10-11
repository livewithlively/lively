#!/usr/bin/env node
// 장표 수정 앱(deck-edit) — 앱에 있는 문서의 한 판을 **HTML 파일로 받는** 세션 스크립트 (#4592). deck-push.mjs 의 짝이다.
//
//  왜 필요한가: 문서는 세션으로 가르지 않는다 — 다른 세션이 올린 문서, 사람이 앱에서 폴더의 파일을 눌러 올린 문서를 이 세션의 AI 가
//   고쳐야 할 때가 있다. 그때 원본 경로(docs.source_path)가 이 세션에서 안 보이면(다른 기계 · 다른 폴더) 고칠 것이 없다.
//   앱의 표에는 판이 통째로 들어 있으므로(머리 1행 + 장 N행 + 꼬리 1행 + 자원 조각) 여기서 다시 이어 파일로 떨군다. 그 파일을 고쳐
//   deck-push 로 새 판을 올리면 된다. 이은 결과는 올린 원본과 글자까지 같다(앱 안에서만 쓰는 글꼴 별칭 스타일은 뺀다).
//
//  쓰는 법(세션 안):
//    node bin/deck-pull.mjs --doc <문서이름> [--ver <판>] [--base] [--session <id>] [--gateway <url>] [--token <파일>] <받을 경로.html>
//  판을 안 적으면 최신 판. 장마다 사람이 고른 안(picks)이 있으면 그 안으로 잇는다(--base 면 고른 안을 무시하고 기본 안).
//  표준 모듈만 쓴다(node 18+). 순수 함수 assembleHtml 은 export 해 scripts/deck-push.test.mjs 가 왕복(올림 → 받음 = 원본)을 본다.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const APP_ID = "deck-edit";

/**
 * 한 판의 versions 행과 자원(sha → 이어 붙인 본문)으로 HTML 을 다시 잇는다. picks = { slide_id: 고른 안 이름 }.
 *  장마다 고른 안이 있으면 그 안, 없으면 기본 안(variant 가 빈 것 · 없으면 첫 안). 자원 자리표가 남으면(조각이 없다) 그대로 둔다 — 호출한 쪽이 센다.
 */
export function assembleHtml(rows, assets, picks = {}) {
  const sorted = rows.slice().sort((a, b) => Number(a.seq) - Number(b.seq) || String(a.variant || "").localeCompare(String(b.variant || "")));
  const head = (sorted.find((r) => r.kind === "head") || {}).body || "";
  const tail = (sorted.find((r) => r.kind === "tail") || {}).body || "";
  const order = [], by = new Map();
  for (const r of sorted) {
    if (r.kind !== "slide") continue;
    if (!by.has(r.slide_id)) { by.set(r.slide_id, []); order.push(r.slide_id); }
    by.get(r.slide_id).push(r);
  }
  let html = head;
  for (const sid of order) {
    const cands = by.get(sid);
    const want = Object.prototype.hasOwnProperty.call(picks, sid) ? String(picks[sid] || "") : String(cands[0].variant || "");
    html += (cands.find((r) => String(r.variant || "") === want) || cands[0]).body;
  }
  html += tail;
  html = html.replace(/<style data-deck-edit="alias">[\s\S]*?<\/style>/g, "");   // 앱 안에서만 쓰는 글꼴 별칭 — 자원을 메우기 전에 뺀다(메운 뒤면 글꼴이 두 번 실린다)
  return html.replace(/__ASSET:([0-9a-f]{64})__/g, (m, sha) => (assets.has(sha) ? assets.get(sha) : m));
}

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
  const out = a._[0];
  if (!out || !a.doc) {
    console.error("쓰는 법: node bin/deck-pull.mjs --doc <문서이름> [--ver <판>] [--base] [--session <id>] [--gateway <url>] [--token <파일>] <받을 경로.html>");
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
  const html = assembleHtml(rows, assets, picks);
  const left = (html.match(/__ASSET:[0-9a-f]{64}__/g) || []).length;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  const slides = new Set(rows.filter((r) => r.kind === "slide").map((r) => r.slide_id)).size;
  console.log(`판 ${ver} 받음 · 장 ${slides} · ${out}${Object.keys(picks).length ? ` · 고른 안 ${Object.keys(picks).length}장 반영` : ""}${left ? ` · ⚠ 자원 ${left}곳을 못 메웠습니다(조각 없음)` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("deck-pull.mjs")) {
  main().catch((e) => { console.error("실패: " + (e && e.message ? e.message : e)); process.exit(1); });
}
