#!/usr/bin/env node
// #551 노션 무손실 싱크 검증기 — Notion 을 **독립 재트래버스**해 DB(knowledge/knowledge_link/자산)와 전수 대조한다.
//
//   사용: node --env-file-if-exists=.env scripts/verify-notion-sync.mjs
//   필요 env: NOTION_TOKEN · ITEMS_DATABASE_URL (+선택 NOTION_API_VERSION/NOTION_ROOT_PAGES/NOTION_ASSET_DIR/NOTION_INSTANCE)
//
//   커넥터 코드와 독립(공유 모듈 미사용) — "커넥터가 읽은 걸 커넥터가 썼다" 순환 검증을 피하고,
//   Notion API 를 다시 읽어 아래를 단언한다:
//     1  페이지/DB 전수 존재      — 모든 노션 객체에 knowledge 행(external 좌표)
//     2  잉여 행 없음             — 노션에 없는 notion 행은 lifecycle='archived' 여야
//     3  제목 일치
//     4  트리(부모) 일치          — parent_name == 기대(page/db/data_source→db 폴딩/block→소유페이지)
//     5  형제 순서 일치           — 부모 블록트리의 child_page/child_database 순서 == 자식 sort 순서
//     6  본문 텍스트 전수         — 노션 블록의 모든 텍스트 런이 body_md 에 존재(정규화 대조)
//     7  원장(raw) 블록 전수      — raw.blocks 의 블록 id 집합 == 노션 블록 id 집합
//     8  링크 그래프 물질화       — 멘션/링크/관계 엣지(양끝 싱크됨) ⊆ knowledge_link(origin=connector:notion)
//     9  속성 전수                — 비-title 속성이 fields.notion.properties 에 존재
//    10  아카이브 전파            — 노션 in_trash/archived ⇒ lifecycle='archived'
//    11  자산 보존                — body 가 참조하는 /api/ui/notion-assets/* 파일이 실제로 존재(+비어있지 않음)
//    12  댓글 수                  — fields.notion.comment_count == 노션 페이지 댓글 수(모드 page 기준)
//
//   원천적으로 API 가 안 주는 것(해결된 댓글, 인라인 anchor, DB 뷰 설정, 버전 히스토리, unsupported 블록 내용)은
//   검증 범위 밖(설계 문서 고지 항목).
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const API = "https://api.notion.com/v1";
const VER = process.env.NOTION_API_VERSION || "2025-09-03";
const TOKEN = process.env.NOTION_TOKEN;
const DB_URL = process.env.ITEMS_DATABASE_URL;
const ASSET_DIR = process.env.NOTION_ASSET_DIR || path.resolve(process.cwd(), "data", "notion-assets");
const COMMENTS_MODE = (process.env.NOTION_COMMENTS || "page").toLowerCase();
if (!TOKEN || !DB_URL) { console.error("NOTION_TOKEN / ITEMS_DATABASE_URL 필요"); process.exit(2); }

const norm = (id) => {
  const s = String(id || "").trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (s.length !== 32) return String(id || "").trim().toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
// unitName 재현(external-identity.ts 와 동일 규칙) — notion-<uuid>, 64자 상한.
const unit = (id) => ("notion-" + String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, "-")).slice(0, 64);

let lastReq = 0;
async function nfetch(p, init) {
  for (let a = 0; a <= 5; a++) {
    const wait = lastReq + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReq = Date.now();
    const res = await fetch(p.startsWith("http") ? p : API + p, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": VER, "Content-Type": "application/json" },
      body: init?.body != null ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      await res.text().catch(() => {});
      if (a < 5) { await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : 700 * (a + 1))); continue; }
    }
    if (!res.ok) { const t = await res.text().catch(() => ""); const e = new Error(`Notion ${res.status} ${p}: ${t.slice(0, 200)}`); e.status = res.status; throw e; }
    return res.json();
  }
  throw new Error("notion fetch 재시도 소진: " + p);
}
async function* pages(make) {
  let cursor;
  do {
    const req = make(cursor);
    const d = await nfetch(req.path, { method: req.method, body: req.body });
    for (const r of d.results ?? []) yield r;
    cursor = d.has_more && d.next_cursor ? d.next_cursor : undefined;
  } while (cursor);
}

// ── 노션 재트래버스 ─────────────────────────────────────────────────────────
const P = new Map();   // pageId → {page, blocks, textRuns, blockIds, links, childOrder, comments}
const D = new Map();   // dbId → {db, dsList, rowIds, textRuns:[]}
const dsToDb = new Map();

async function blockTree(id, depth, seen) {
  if (depth > 64 || seen.has(id)) return [];
  seen.add(id);
  const out = [];
  for await (const b of pages((c) => ({ path: `/blocks/${id}/children?page_size=100${c ? `&start_cursor=${encodeURIComponent(c)}` : ""}` }))) {
    out.push(b);
    const t = String(b.type ?? "");
    if (t === "child_page" || t === "child_database") continue;
    if (t === "synced_block") {
      try {
        b._children = await blockTree(b.id, depth + 1, seen);
        const from = b.synced_block?.synced_from?.block_id;
        if (!b._children.length && from) b._children = await blockTree(from, depth + 1, seen);
      } catch { b._children = []; }
      continue;
    }
    if (b.has_children) b._children = await blockTree(b.id, depth + 1, seen);
  }
  return out;
}

// 블록 트리 → 텍스트 런(모든 rich_text/plain_text·표 셀·코드·캡션·수식) + 블록 id + 링크 타깃 수집.
function harvest(blocks, acc) {
  for (const b of blocks ?? []) {
    acc.blockIds.add(norm(b.id));
    const t = String(b.type ?? "");
    const inner = b[t] ?? {};
    const rts = [];
    if (Array.isArray(inner.rich_text)) rts.push(...inner.rich_text);
    if (Array.isArray(inner.caption)) rts.push(...inner.caption);
    if (Array.isArray(inner.cells)) for (const cell of inner.cells) rts.push(...(cell ?? []));
    if (typeof inner.expression === "string" && inner.expression) acc.textRuns.push(inner.expression);
    if (typeof inner.title === "string" && inner.title) acc.textRuns.push(inner.title); // child_page/child_database 제목
    for (const rt of rts) {
      const pt = String(rt?.plain_text ?? "");
      if (pt.trim()) acc.textRuns.push(pt);
      const href = rt?.href || rt?.text?.link?.url;
      if (href) { const nid = idFromUrl(href); if (nid) acc.links.add(nid); }
      const m = rt?.mention;
      if (m) {
        const nid = m.page?.id ?? m.database?.id ?? m.data_source?.id;
        if (nid) acc.links.add(norm(nid));
      }
    }
    if (t === "link_to_page") {
      const nid = inner.page_id ?? inner.database_id ?? inner.data_source_id;
      if (nid) acc.links.add(norm(nid));
    }
    if (t === "image" || t === "video" || t === "audio" || t === "file" || t === "pdf") {
      if (inner.type === "file" && inner.file?.url) acc.assets++;
    }
    if (t === "child_page") acc.childOrder.push(norm(b.id));
    if (t === "child_database") acc.childOrder.push(norm(b.id));
    if (Array.isArray(b._children)) harvest(b._children, acc);
  }
}
function idFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)notion\.(so|site|com)$/.test(u.hostname)) return null;
    const m = (u.pathname.split("/").filter(Boolean).pop() ?? "").match(/([0-9a-fA-F]{32})$/);
    return m ? norm(m[1]) : null;
  } catch { return null; }
}

function ensureP(id) {
  if (!P.has(id)) P.set(id, { page: null, textRuns: [], blockIds: new Set(), links: new Set(), childOrder: [], assets: 0, comments: 0, parentOverride: null, propNames: [] });
  return P.get(id);
}

console.error(`[verify] 노션 재트래버스 시작 (버전 ${VER}, 댓글 모드 ${COMMENTS_MODE})`);
const roots = (process.env.NOTION_ROOT_PAGES || "").split(",").map((s) => {
  const cleaned = s.trim().split(/[?#]/)[0];
  const hex = cleaned.toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length >= 32 ? norm(hex.slice(-32)) : "";
}).filter((s) => s.length === 36);
if (roots.length) {
  for (const id of roots) {
    try { ensureP(id).page = await nfetch(`/pages/${id}`); }
    catch { try { const db = await nfetch(`/databases/${id}`); D.set(norm(db.id), { db, dsList: [], rowIds: [] }); } catch (e) { console.error("루트 접근 실패:", id, e.message); } }
  }
} else {
  for await (const r of pages((c) => ({ path: "/search", method: "POST", body: { filter: { property: "object", value: "page" }, page_size: 100, ...(c ? { start_cursor: c } : {}) } }))) {
    if (r.object === "page") { const n = ensureP(norm(r.id)); if (!n.page) n.page = r; }
  }
  try {
    for await (const r of pages((c) => ({ path: "/search", method: "POST", body: { filter: { property: "object", value: "data_source" }, page_size: 100, ...(c ? { start_cursor: c } : {}) } }))) {
      if (r.object === "data_source") {
        const dbId = norm(r.database_parent?.database_id ?? r.parent?.database_id ?? "");
        if (dbId.length === 36) { if (!D.has(dbId)) D.set(dbId, { db: null, dsList: [], rowIds: [] }); dsToDb.set(norm(r.id), dbId); }
      } else if (r.object === "database") {
        if (!D.has(norm(r.id))) D.set(norm(r.id), { db: null, dsList: [], rowIds: [] });
      }
    }
  } catch (e) { console.error("data_source search 실패(구버전?):", e.message); }
}

const doneP = new Set(), doneD = new Set();
let moved = true;
while (moved) {
  moved = false;
  for (const [id, n] of [...D]) {
    if (doneD.has(id)) continue;
    doneD.add(id); moved = true;
    try {
      if (!n.db) n.db = await nfetch(`/databases/${id}`);
      const refs = n.db.data_sources ?? [];
      for (const ref of refs) {
        try { n.dsList.push(await nfetch(`/data_sources/${ref.id}`)); dsToDb.set(norm(ref.id), id); } catch {}
        const rows = [];
        for await (const row of pages((c) => ({ path: `/data_sources/${ref.id}/query`, method: "POST", body: { page_size: 100, sorts: [{ timestamp: "created_time", direction: "ascending" }], ...(c ? { start_cursor: c } : {}) } }))) {
          if (row.object !== "page") continue;
          const rid = norm(row.id);
          const rn = ensureP(rid);
          if (!rn.page) rn.page = row;
          rn.parentOverride = id;
          rows.push({ id: rid, created: row.created_time ?? "" });
        }
        for (const r of rows) n.rowIds.push(r.id); // 생성순은 query sorts 가 보장(created_time 분 절사 동률 회피)
      }
    } catch (e) { console.error("[verify] DB 실패:", id, e.message); }
  }
  for (const [id, n] of [...P]) {
    if (doneP.has(id)) continue;
    doneP.add(id); moved = true;
    try {
      if (!n.page) n.page = await nfetch(`/pages/${id}`);
      // 속성 25개 절단 해소(relation has_more)
      for (const [pname, prop] of Object.entries(n.page.properties ?? {})) {
        n.propNames.push(pname);
        const needs = prop?.has_more === true || (prop?.type === "relation" && (prop.relation ?? []).length >= 25);
        if (needs && prop.id) {
          const propId = /^[A-Za-z0-9%~_.\-]+$/.test(String(prop.id)) ? String(prop.id) : encodeURIComponent(String(prop.id)); // 이미 인코딩된 id — 이중 인코딩 금지
          const items = [];
          try { for await (const it of pages((c) => ({ path: `/pages/${n.page.id}/properties/${propId}?page_size=100${c ? `&start_cursor=${encodeURIComponent(c)}` : ""}` }))) items.push(it); } catch {}
          if (prop.type === "relation" && items.length) prop.relation = items.map((i) => i.relation).filter(Boolean);
        }
        if (prop?.type === "relation") for (const r of prop.relation ?? []) if (r?.id) n.links.add(norm(r.id));
        // 속성 텍스트 런(제목·rich_text)도 본문 아님 → fields 검증으로 커버(텍스트런에 안 넣음)
      }
      const blocks = await blockTree(n.page.id, 0, new Set());
      const acc = { textRuns: n.textRuns, blockIds: n.blockIds, links: n.links, childOrder: n.childOrder, assets: 0 };
      acc.assets = 0;
      harvest(blocks, acc);
      n.assets = acc.assets;
      // 트리 발견 — child_page/child_database 큐잉 + 소유 부모 덮어쓰기
      for (const cid of n.childOrder) {
        if (P.has(cid) || D.has(cid)) { (P.get(cid) ?? {}).parentOverride ??= id; continue; }
        // 타입 미상 — page 먼저, 실패 시 database
        try { const cp = await nfetch(`/pages/${cid}`); const cn = ensureP(cid); cn.page = cp; cn.parentOverride = id; }
        catch { try { const cdb = await nfetch(`/databases/${cid}`); D.set(cid, { db: cdb, dsList: [], rowIds: [] }); } catch {} }
      }
      for (const cid of n.childOrder) { if (D.has(cid)) { const dn = D.get(cid); dn.parentOverride ??= id; } }
      if (COMMENTS_MODE !== "off") {
        try { let cnt = 0; for await (const _ of pages((c) => ({ path: `/comments?block_id=${id}&page_size=100${c ? `&start_cursor=${encodeURIComponent(c)}` : ""}` }))) cnt++; n.comments = cnt; } catch {}
      }
    } catch (e) { console.error("[verify] 페이지 실패:", id, e.message); }
  }
}
console.error(`[verify] 노션: 페이지 ${P.size} · DB ${D.size}`);

// ── DB 읽기 ────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
const kn = new Map();
{
  const r = await pool.query(
    `SELECT name, title, body_md, parent_name, sort, lifecycle, external_id, fields, raw
     FROM knowledge WHERE external_system='notion'`);
  for (const row of r.rows) kn.set(norm(row.external_id), row);
}
const linkRows = (await pool.query(
  `SELECT from_name, to_name FROM knowledge_link WHERE origin='connector:notion'`)).rows;
const linkSet = new Set(linkRows.map((l) => l.from_name + "→" + l.to_name));

// ── 대조 ───────────────────────────────────────────────────────────────────
const fails = [];
const F = (cat, id, msg) => fails.push({ cat, id, msg });
const normText = (t) => String(t).replace(/`/g, "'").replace(/\s+/g, " ").trim();
// H1 redact 패리티(src/org/redact.ts SECRET_RES 복제) — 미러는 시크릿 패턴을 [REDACTED] 로 마스킹하므로
// 노션 원문 런도 같은 규칙으로 마스킹해 대조(마스킹은 의도된 변형이지 손실이 아님).
const SECRET_RES = [
  /sk-[A-Za-z0-9]{16,}/g, /ghp_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, /AKIA[0-9A-Z]{16}/g, /lvk_[A-Za-z0-9_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /[Bb]earer\s+[A-Za-z0-9._~+\/-]{12,}=*/g,
];
const redactParity = (t) => { let o = String(t); for (const re of SECRET_RES) o = o.replace(re, "[REDACTED]"); return o; };
const expectedParent = (n, page) => {
  if (n.parentOverride) return unit(n.parentOverride);
  const p = page?.parent ?? {};
  if (p.type === "page_id" && p.page_id) return unit(norm(p.page_id));
  if (p.type === "database_id" && p.database_id) return unit(norm(p.database_id));
  if (p.type === "data_source_id" && p.data_source_id) { const db = dsToDb.get(norm(p.data_source_id)); return db ? unit(db) : null; }
  if (p.type === "block_id") return "__block__"; // 소유 페이지 — 트래버스 override 로 잡히는 게 정상, 못 잡으면 별도 확인
  return null;
};

let checkedAssets = 0, okAssets = 0;
for (const [id, n] of P) {
  const row = kn.get(id);
  if (!n.page) continue;
  if (!row) { F("존재", id, "knowledge 행 없음: " + (n.page?.properties && Object.values(n.page.properties).find((p) => p.type === "title")?.title?.map((t) => t.plain_text).join("") || id)); continue; }
  // 제목
  const expTitle = (Object.values(n.page.properties ?? {}).find((p) => p?.type === "title")?.title ?? []).map((t) => t.plain_text ?? "").join("").trim() || "(제목 없음)";
  if ((row.title ?? "") !== expTitle) F("제목", id, `'${row.title}' ≠ '${expTitle}'`);
  // 아카이브 전파
  const archived = n.page.archived === true || n.page.in_trash === true;
  if (archived && row.lifecycle !== "archived") F("아카이브", id, `노션 archived 인데 lifecycle=${row.lifecycle}`);
  if (!archived && row.lifecycle !== "active") F("아카이브", id, `노션 활성인데 lifecycle=${row.lifecycle}`);
  // 부모
  const expP = expectedParent(n, n.page);
  if (expP === "__block__") { if (!row.parent_name) F("트리", id, "block 부모 — parent_name 비어 있음"); }
  else if ((row.parent_name ?? null) !== expP) F("트리", id, `parent_name '${row.parent_name}' ≠ 기대 '${expP}'`);
  // 원장 블록 전수
  const rawBlocks = new Set();
  const collectIds = (bs) => { for (const b of bs ?? []) { rawBlocks.add(norm(b.id)); collectIds(b._children); } };
  collectIds(row.raw?.blocks);
  for (const bid of n.blockIds) if (!rawBlocks.has(bid)) F("원장", id, `raw.blocks 에 블록 누락 ${bid}`);
  // 본문 텍스트 전수 — 표 셀 이스케이프(\|)는 언이스케이프본과 원본 양쪽 대조(리터럴 '\|' 오탐 방지),
  //  시크릿 패턴은 redact 패리티 적용, 인용 블록은 줄마다 '> ' 접두사가 붙으므로(마크다운 문법 — 무손실)
  //  줄바꿈 포함 런 대조용으로 인용 마커 스트립 변형도 함께 본다.
  const bodyStr = String(row.body_md ?? "");
  const stripQuote = (t) => t.replace(/(^|\n)[ \t]*(?:>[ \t]?)+/g, "$1");
  const bodies = [
    normText(bodyStr),
    normText(bodyStr.replace(/\\\|/g, "|")),
    normText(stripQuote(bodyStr).replace(/\\\|/g, "|")),
  ];
  for (const run of n.textRuns) {
    const cands = [normText(run), normText(run.replace(/\n/g, " ")), normText(redactParity(run))].filter(Boolean);
    if (!cands.length) continue;
    const found = cands.some((c) => bodies.some((b) => b.includes(c)));
    if (!found) F("본문", id, `텍스트 런 누락: "${cands[0].slice(0, 60)}"`);
  }
  // 속성 전수(비-title)
  const propBag = row.fields?.notion?.properties ?? {};
  for (const pname of n.propNames) {
    const prop = n.page.properties?.[pname];
    if (prop?.type === "title") continue;
    if (!(pname in propBag)) F("속성", id, `속성 누락: ${pname}`);
  }
  // 링크 물질화(타깃이 싱크된 것만 기대)
  for (const target of n.links) {
    const tId = dsToDb.get(target) ?? target;
    if (tId === id) continue;
    if (!kn.has(tId)) continue; // 스코프 밖 — 물질화 대상 아님
    if (!linkSet.has(row.name + "→" + kn.get(tId).name)) F("링크", id, `knowledge_link 누락 → ${tId}`);
  }
  // 자식 순서
  if (n.childOrder.length) {
    const kids = [...kn.values()].filter((k) => k.parent_name === row.name && n.childOrder.includes(norm(k.external_id)));
    const sorted = kids.slice().sort((a, b) => (a.sort - b.sort));
    const expOrder = n.childOrder.filter((c) => kids.some((k) => norm(k.external_id) === c));
    const gotOrder = sorted.map((k) => norm(k.external_id));
    if (JSON.stringify(expOrder) !== JSON.stringify(gotOrder)) F("순서", id, `자식 순서 불일치\n  기대 ${expOrder.join(",")}\n  실제 ${gotOrder.join(",")}`);
  }
  // 자산 — body 가 참조하는 로컬 자산 파일 존재
  for (const m of String(row.body_md ?? "").matchAll(/\/api\/ui\/notion-assets\/([A-Za-z0-9._-]+)/g)) {
    checkedAssets++;
    const fp = path.join(ASSET_DIR, m[1]);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 0) okAssets++;
    else F("자산", id, `자산 파일 없음/빈 파일: ${m[1]}`);
  }
  if (n.assets > 0) {
    const refCount = [...String(row.body_md ?? "").matchAll(/\/api\/ui\/notion-assets\//g)].length;
    if (refCount === 0) F("자산", id, `노션 호스팅 파일 ${n.assets}개인데 body 에 로컬 자산 참조 0`);
  }
  // 댓글 수
  if (COMMENTS_MODE === "page") {
    const got = Number(row.fields?.notion?.comment_count ?? 0);
    if (got !== n.comments) F("댓글", id, `comment_count ${got} ≠ ${n.comments}`);
  }
}
for (const [id, n] of D) {
  const row = kn.get(id);
  if (!n.db) continue;
  if (!row) { F("존재", id, "DB knowledge 행 없음"); continue; }
  const expTitle = (n.db.title ?? []).map((t) => t.plain_text ?? "").join("").trim() || "(제목 없는 데이터베이스)";
  if ((row.title ?? "") !== expTitle) F("제목", id, `DB 제목 '${row.title}' ≠ '${expTitle}'`);
  // 스키마 속성 이름이 본문(스키마 표)에 있어야
  for (const ds of n.dsList) for (const pname of Object.keys(ds.properties ?? {})) {
    if (!String(row.body_md ?? "").includes(pname)) F("DB스키마", id, `스키마 속성 '${pname}' 이 본문에 없음`);
  }
  // 행 순서(sort)
  const kids = [...kn.values()].filter((k) => k.parent_name === row.name && n.rowIds.includes(norm(k.external_id)));
  const sorted = kids.slice().sort((a, b) => (a.sort - b.sort)).map((k) => norm(k.external_id));
  const exp = n.rowIds.filter((r) => kids.some((k) => norm(k.external_id) === r));
  if (JSON.stringify(exp) !== JSON.stringify(sorted)) F("순서", id, "DB 행 순서 불일치");
}
// 잉여 행 — 노션에 없는데 active 인 미러
for (const [extId, row] of kn) {
  if (!P.has(extId) && !D.has(extId) && row.lifecycle === "active") {
    F("잉여", extId, `노션에 없는데 active: ${row.name} (${row.title})`);
  }
}

// ── 리포트 ─────────────────────────────────────────────────────────────────
const byCat = {};
for (const f of fails) byCat[f.cat] = (byCat[f.cat] ?? 0) + 1;
console.log("\n══════════ 노션 무손실 싱크 검증 리포트 ══════════");
console.log(`노션: 페이지 ${P.size} · 데이터베이스 ${D.size}`);
console.log(`DB 미러: knowledge ${kn.size} 행 · knowledge_link ${linkRows.length} (connector:notion)`);
console.log(`자산: body 참조 ${checkedAssets} 중 ${okAssets} 존재`);
console.log(`검증 항목: 존재·잉여·제목·트리·순서·본문 텍스트 전수·원장 블록 전수·링크 물질화·속성·아카이브·자산·댓글수`);
if (!fails.length) {
  console.log("\n✅ 손실 0 — 모든 검증 통과");
} else {
  console.log(`\n❌ 실패 ${fails.length}건:`, byCat);
  for (const f of fails.slice(0, 80)) console.log(` - [${f.cat}] ${f.id}: ${f.msg}`);
  if (fails.length > 80) console.log(` … 외 ${fails.length - 80}건`);
}
await pool.end();
process.exit(fails.length ? 1 : 0);
