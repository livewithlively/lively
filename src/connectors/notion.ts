// Notion 커넥터 v2 (#551 무손실) — 재귀 트래버스로 페이지·DB 전체를 수집해 canonical RawItem(type:'doc')으로 방출.
//
//   무손실 설계(notion-lossless-sync-551-design):
//   · **search 는 루트 발견용** — Notion 공식이 search 완전성 비보장("not guaranteed to return everything")이라
//     BFS 트래버스가 수집의 진실: GET /blocks/{id}/children 재귀 + child_page/child_database 확장 + DB query.
//   · **원장+뷰 이중 저장** — raw = { page|database, blocks(전체 트리), comments, data_sources, property_items },
//     body = notion-md.ts 가 만든 마크다운 뷰(구조·링크·서식 표현).
//   · **페이지 트리** — parent_external_id + sort(형제 순서) + fields.notion.children_order(부모가 아는 자식 순서).
//   · **연결구조** — fields.notion.links(멘션/인라인/link_to_page/relation) → 미러가 knowledge_link 로 물질화.
//   · **자산** — Notion 호스팅 파일 URL 은 1시간 만료 → 싱크 시점 다운로드(NOTION_ASSET_DIR, 기본 ./data/notion-assets),
//     본문은 인증 라우트 /api/ui/notion-assets/<file> 참조. external URL 은 원본 유지.
//   · **실패 시맨틱** — 페이지 처리 실패를 조용히 삼키지 않는다: 해당 페이지 미방출 + failures 카운트 →
//     run-sync 가 커서 동결(다음 run 재수집). (구버전: 빈 본문 방출 + 커서 전진 = 조용한 손실)
//   · API 버전 2025-09-03(data_source 분리 — 멀티소스 DB 필수). NOTION_API_VERSION 으로 오버라이드 가능.
//     파서는 archived/in_trash 양쪽 관용, 미지 블록·멘션·속성 타입은 notion-md 가 보존 폴백.
//
//   증분(since): search 로 전 페이지 나열(제목·부모·last_edited 맵 확보) + last_edited>=since 인 페이지만
//   전체 추출·방출. 알려진 DB 는 매 run 스키마 재fetch + 전 행 나열(행별 changed 판정). 구조 변화(자식 추가/이동)는
//   부모 last_edited 갱신으로 잡힘. 삭제/아카이브 전파는 full 모드에서 run-sync 의 스윕이 담당.
//   rate limit: 평균 ~3 req/s 자발 스로틀 + 429/529 Retry-After 재시도.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { unitName } from "../org/external-identity.js";
import {
  blocksToMd, commentsToMd, dataSourceSchemaMd, normalizeNotionId, normalizeProperties,
  propertiesTableMd, type NotionMdCtx, type NormalizedProp,
} from "./notion-md.js";
import type {
  NotionBlock, NotionComment, NotionDatabase, NotionDataSource, NotionListResponse,
  NotionPage, NotionRichText, NotionUser,
} from "./notion-types.js";

// ── 상수 ───────────────────────────────────────────────────────────────────
const API_BASE = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2025-09-03"; // data_source 분리 버전(멀티소스 DB 대응) — NOTION_API_VERSION 로 오버라이드
const PAGE_SIZE = 100; // search/children/query/comments 공통 최대 페이지 크기
const REQ_INTERVAL_MS = 350; // 자발적 스로틀(~3 req/s) — rate limit 선제 회피
const MAX_RETRY = 5; // 429/529/5xx 재시도 횟수
const MAX_BLOCK_DEPTH = 64; // 순환 방지 가드(정상 문서는 도달 불가 — 구버전의 '깊이 5 절단'과 달리 손실 아님)
const PAGE_FETCH_RETRY = 2; // 페이지 단위 재시도(블록 트리 등) — 그 후 실패는 failures 로 집계(미방출)

// ── 실행 통계 — run-sync 가 커서 동결/스윕 판단에 사용 ─────────────────────────
export interface NotionRunStats {
  pages: number; databases: number; emitted: number;
  failures: number; failedIds: string[];
  assets: number; assetFailures: number; requests: number;
}
let lastRunStats: NotionRunStats | null = null;
export function getNotionRunStats(): NotionRunStats | null { return lastRunStats; }

// ── 작은 유틸 ───────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

interface NotionConfig {
  token: string; instance: string; version: string;
  rootIds: string[]; comments: "page" | "all" | "off"; assetDir: string;
}

async function loadConfig(): Promise<NotionConfig> {
  const c = await resolveConnectorConfig("notion");
  if (!c.token) throw new Error("NOTION_TOKEN 이 없습니다 — Notion integration 토큰(secret_…)을 설정하세요(관리탭 또는 .env)");
  const rootIds = (c.root_pages ?? "").split(",").map((s) => normalizeNotionId(s)).filter((s) => s.length === 36);
  const cm = (c.comments ?? "page").toLowerCase();
  return {
    token: c.token,
    instance: c.instance || "default",
    version: c.api_version || DEFAULT_NOTION_VERSION,
    rootIds,
    comments: cm === "all" || cm === "off" ? (cm as "all" | "off") : "page",
    assetDir: c.asset_dir || path.resolve(process.cwd(), "data", "notion-assets"),
  };
}

// ── HTTP 호출(인증/버전 헤더 + rate limit 존중 + 자발적 스로틀) ───────────────
let lastReqAt = 0;
let reqCount = 0;

async function notionFetch(cfg: NotionConfig, pathname: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const url = pathname.startsWith("http") ? pathname : `${API_BASE}${pathname}`;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const wait = lastReqAt + REQ_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReqAt = Date.now();
    reqCount++;

    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Notion-Version": cfg.version,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: init?.body != null ? JSON.stringify(init.body) : undefined,
    });

    if (res.status === 429 || res.status === 529) { // rate limit/과부하 — Retry-After 존중
      const ra = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : REQ_INTERVAL_MS * (attempt + 2);
      await res.text().catch(() => "");
      if (attempt < MAX_RETRY) { await sleep(delay); continue; }
      throw new Error(`Notion ${res.status} rate_limited (재시도 소진): ${pathname}`);
    }
    if (res.status >= 500 && attempt < MAX_RETRY) {
      await res.text().catch(() => "");
      await sleep(REQ_INTERVAL_MS * (attempt + 2));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Notion ${res.status} ${pathname}: ${body.slice(0, 300)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  throw new Error(`Notion 요청 실패(예상치 못한 종료): ${pathname}`);
}

// 커서 페이지네이션 공통 — GET(qs) / POST(body) 양쪽.
async function* paginate(cfg: NotionConfig, make: (cursor?: string) => { path: string; method?: string; body?: Rec }): AsyncGenerator<Rec> {
  let cursor: string | undefined;
  do {
    const req = make(cursor);
    const data = (await notionFetch(cfg, req.path, { method: req.method, body: req.body })) as NotionListResponse;
    for (const r of data.results ?? []) yield asRec(r);
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);
}

// ── 자산 다운로드 ─────────────────────────────────────────────────────────────
interface AssetJob { url: string; file: string }

function assetFileName(hint: { blockId?: string; pageId?: string; kind: string; name?: string }, url: string): string {
  let base = "";
  try { base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""); } catch { /* 무시 */ }
  const name = (hint.name || base || "asset").slice(-80);
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
  const key = crypto.createHash("sha1")
    .update(`${hint.pageId ?? ""}|${hint.blockId ?? ""}|${hint.kind}|${name}`)
    .digest("hex").slice(0, 24);
  return ext ? `${key}.${ext}` : key;
}

async function downloadAsset(job: AssetJob, dir: string): Promise<void> {
  const dest = path.join(dir, job.file);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(job.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("빈 응답");
      fs.mkdirSync(dir, { recursive: true });
      const tmp = dest + ".part";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest); // 원자적 교체 — 서빙 중 반쪽 파일 방지
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
}

// ── 트래버설 노드 ─────────────────────────────────────────────────────────────
interface PageNode {
  id: string;
  page: NotionPage | null;
  blocks: NotionBlock[] | null;
  comments: NotionComment[];
  propertyItems: Record<string, unknown[]>;
  parentOverride: string | null; // 트래버스가 아는 소유 부모(child_page 발견·DB 행) — page.parent 보다 우선
  sort: number | null;
  childrenOrder: string[];
  changed: boolean;   // since 증분 — true 면 전체 추출·방출
  isDbRow: boolean;
  failed: boolean;
}
interface DbNode {
  id: string;
  db: NotionDatabase | null;
  dataSources: NotionDataSource[];
  rowIds: string[];
  parentOverride: string | null;
  sort: number | null;
  failed: boolean;
}

interface Traversal {
  cfg: NotionConfig;
  sinceMs: number | undefined;
  pages: Map<string, PageNode>;
  dbs: Map<string, DbNode>;
  dsToDb: Map<string, string>;
  users: Map<string, NotionUser | null>;
  assetJobs: Map<string, AssetJob>; // file → job (중복 다운로드 방지)
  stats: NotionRunStats;
}

function pageNode(t: Traversal, id: string): PageNode {
  let n = t.pages.get(id);
  if (!n) {
    n = { id, page: null, blocks: null, comments: [], propertyItems: {}, parentOverride: null, sort: null, childrenOrder: [], changed: true, isDbRow: false, failed: false };
    t.pages.set(id, n);
  }
  return n;
}
function dbNode(t: Traversal, id: string): DbNode {
  let n = t.dbs.get(id);
  if (!n) {
    n = { id, db: null, dataSources: [], rowIds: [], parentOverride: null, sort: null, failed: false };
    t.dbs.set(id, n);
  }
  return n;
}

function isChanged(t: Traversal, lastEdited: string | undefined): boolean {
  if (t.sinceMs == null) return true;
  const ms = lastEdited ? Date.parse(lastEdited) : NaN;
  return !Number.isFinite(ms) || ms >= t.sinceMs;
}

// ── 블록 트리 재귀 fetch — _children 부착. child_page/child_database 는 별도 노드(내용 재귀 금지, 발견만). ──
async function fetchBlockTree(t: Traversal, blockId: string, depth: number, seen: Set<string>): Promise<NotionBlock[]> {
  if (depth > MAX_BLOCK_DEPTH || seen.has(blockId)) return [];
  seen.add(blockId);
  const out: NotionBlock[] = [];
  for await (const raw of paginate(t.cfg, (cursor) => ({
    path: `/blocks/${blockId}/children?page_size=${PAGE_SIZE}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
  }))) {
    const b = raw as unknown as NotionBlock;
    out.push(b);
    const type = String(b.type ?? "");
    if (type === "child_page" || type === "child_database") continue; // 하위 문서/DB — 트리 확장은 collect 단계에서
    if (type === "synced_block") {
      // 복제본: 자신의 children 이 비면 원본(synced_from.block_id)에서 시도. 404(원본 미공유)는 손실 마커로 강등.
      const from = asRec(asRec(b.synced_block).synced_from);
      try {
        b._children = await fetchBlockTree(t, b.id, depth + 1, seen);
        if (!b._children.length && from.block_id) {
          b._children = await fetchBlockTree(t, String(from.block_id), depth + 1, seen);
        }
      } catch { b._children = []; }
      continue;
    }
    if (b.has_children) {
      b._children = await fetchBlockTree(t, b.id, depth + 1, seen);
    }
  }
  return out;
}

// 블록 트리에서 child_page/child_database 발견 → 노드 큐잉 + 부모의 자식 순서 기록.
function discoverChildren(t: Traversal, node: PageNode): void {
  const order: string[] = [];
  const walk = (blocks: NotionBlock[]): void => {
    for (const b of blocks) {
      const type = String(b.type ?? "");
      const id = normalizeNotionId(String(b.id ?? ""));
      if (type === "child_page") {
        const child = pageNode(t, id);
        child.parentOverride = node.id;
        child.sort = order.length;
        order.push(id);
      } else if (type === "child_database") {
        const child = dbNode(t, id);
        child.parentOverride = node.id;
        child.sort = order.length;
        order.push(id);
      } else if (Array.isArray(b._children)) {
        walk(b._children);
      }
    }
  };
  if (node.blocks) walk(node.blocks);
  node.childrenOrder = order;
}

// ── 속성 페이지네이션(25개 절단 해소) — has_more 속성은 property item API 로 전량 수집·병합. ──
async function hydrateProperties(t: Traversal, node: PageNode): Promise<void> {
  const page = node.page;
  if (!page?.properties) return;
  for (const [pname, prop] of Object.entries(page.properties)) {
    const p = asRec(prop);
    const type = String(p.type ?? "");
    const needsMore = p.has_more === true
      || (type === "relation" && asArr(p.relation).length >= 25)
      || asRec(p[type]).has_more === true;
    if (!needsMore || !p.id) continue;
    try {
      const items: unknown[] = [];
      for await (const item of paginate(t.cfg, (cursor) => ({
        path: `/pages/${page.id}/properties/${encodeURIComponent(String(p.id))}?page_size=${PAGE_SIZE}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      }))) items.push(item);
      node.propertyItems[pname] = items;
      mergePropertyItems(p, type, items);
    } catch { /* 속성 하이드레이션 실패 — 원본 25개 유지(원장에 실패 흔적 없음은 no — propertyItems 부재로 판별) */ }
  }
}

// property item 배열 → 페이지 속성 값에 전량 병합(문서화된 paginated 타입: title/rich_text/relation/people/rollup).
function mergePropertyItems(prop: Rec, type: string, items: unknown[]): void {
  const of = (t: string) => items.map((i) => asRec(i)[t]).filter((v) => v != null);
  if (type === "relation") prop.relation = of("relation");
  else if (type === "people") prop.people = of("people");
  else if (type === "title") prop.title = of("title");
  else if (type === "rich_text") prop.rich_text = of("rich_text");
  // rollup 은 property item 페이지네이션 구조가 특수(aggregate) — 원장(propertyItems)에 보존, 값 병합은 생략.
  prop.has_more = false;
}

// ── 사용자 해소 — JSON 을 훑어 {object:'user', id} 참조를 수집, GET /users/{id} 캐시. ──
function collectUserIds(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) { for (const x of v) collectUserIds(x, out); return; }
  if (v && typeof v === "object") {
    const r = v as Rec;
    if (r.object === "user" && typeof r.id === "string") out.add(r.id);
    if (typeof (r as { created_by?: { id?: string } }).created_by === "object") {
      const id = asRec(r.created_by).id;
      if (typeof id === "string") out.add(id);
    }
    for (const val of Object.values(r)) collectUserIds(val, out);
  }
}

async function hydrateUsers(t: Traversal, roots: unknown[]): Promise<void> {
  const ids = new Set<string>();
  for (const r of roots) collectUserIds(r, ids);
  for (const id of ids) {
    if (t.users.has(id)) continue;
    try { t.users.set(id, (await notionFetch(t.cfg, `/users/${id}`)) as NotionUser); }
    catch { t.users.set(id, null); } // 권한/봇 — id 만 보존
  }
}

// ── 댓글 수집 — page(기본): 페이지 1콜 · all: 모든 블록 id 콜(고비용, 옵트인) · off. ──
async function fetchComments(t: Traversal, node: PageNode): Promise<void> {
  if (t.cfg.comments === "off") return;
  const ids = [node.id];
  if (t.cfg.comments === "all" && node.blocks) {
    const walk = (bs: NotionBlock[]): void => {
      for (const b of bs) { ids.push(String(b.id)); if (Array.isArray(b._children)) walk(b._children); }
    };
    walk(node.blocks);
  }
  const seen = new Set<string>();
  for (const bid of ids) {
    try {
      for await (const c of paginate(t.cfg, (cursor) => ({
        path: `/comments?block_id=${encodeURIComponent(bid)}&page_size=${PAGE_SIZE}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      }))) {
        const cc = c as unknown as NotionComment;
        if (!seen.has(cc.id)) { seen.add(cc.id); node.comments.push(cc); }
      }
    } catch { break; } // 코멘트 capability 없음(403) 등 — 페이지 손실로 치지 않음(원장에 comments 없음으로 판별)
  }
}

// ── collect 단계 — BFS 로 페이지/DB 전체 수집 ─────────────────────────────────
async function processPage(t: Traversal, node: PageNode): Promise<void> {
  try {
    if (!node.page) {
      node.page = (await notionFetch(t.cfg, `/pages/${node.id}`)) as NotionPage;
    }
    node.changed = isChanged(t, node.page.last_edited_time);
    if (!node.changed) return; // 미변경 — 제목/부모 맵만 유지(방출 안 함), 블록/댓글 fetch 생략
    for (let attempt = 0; ; attempt++) {
      try {
        await hydrateProperties(t, node);
        node.blocks = await fetchBlockTree(t, node.id, 0, new Set());
        break;
      } catch (err) {
        if (attempt >= PAGE_FETCH_RETRY) throw err;
        await sleep(1000 * (attempt + 1));
      }
    }
    discoverChildren(t, node);
    await fetchComments(t, node);
  } catch (err) {
    node.failed = true;
    t.stats.failures++;
    t.stats.failedIds.push(node.id);
    console.error(`[notion] 페이지 수집 실패 ${node.id}:`, (err as Error)?.message ?? err);
  }
}

async function processDb(t: Traversal, node: DbNode): Promise<void> {
  try {
    node.db = (await notionFetch(t.cfg, `/databases/${node.id}`)) as NotionDatabase;
    const dsRefs = node.db.data_sources ?? [];
    if (dsRefs.length) {
      for (const ref of dsRefs) {
        try {
          const ds = (await notionFetch(t.cfg, `/data_sources/${ref.id}`)) as NotionDataSource;
          node.dataSources.push(ds);
          t.dsToDb.set(normalizeNotionId(ref.id), node.id);
        } catch (err) {
          console.error(`[notion] data_source 스키마 실패 ${ref.id}:`, (err as Error)?.message ?? err);
        }
        // 행 나열 — 전 행(page 객체). 행 자체의 changed 판정은 processPage 에서.
        const rows: Array<{ id: string; created: string }> = [];
        for await (const row of paginate(t.cfg, (cursor) => ({
          path: `/data_sources/${ref.id}/query`, method: "POST",
          body: { page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) },
        }))) {
          if (row.object !== "page") continue; // wiki DB 는 data_source 객체가 섞여 나올 수 있음
          const rp = row as unknown as NotionPage;
          const rid = normalizeNotionId(rp.id);
          const child = pageNode(t, rid);
          if (!child.page) child.page = rp;
          child.parentOverride = node.id; // data_source 는 소유 DB 로 폴딩
          child.isDbRow = true;
          rows.push({ id: rid, created: rp.created_time ?? "" });
        }
        rows.sort((a, b) => a.created.localeCompare(b.created)); // 노션 뷰 순서는 API 미제공 — created_time asc(설계 고지)
        rows.forEach((r, i) => {
          const child = pageNode(t, r.id);
          if (child.sort == null) child.sort = i;
          node.rowIds.push(r.id);
        });
      }
    } else {
      // 구버전 API(2022-06-28) 폴백 — database 직접 query. 스키마는 db.properties.
      for await (const row of paginate(t.cfg, (cursor) => ({
        path: `/databases/${node.id}/query`, method: "POST",
        body: { page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) },
      }))) {
        if (row.object !== "page") continue;
        const rp = row as unknown as NotionPage;
        const rid = normalizeNotionId(rp.id);
        const child = pageNode(t, rid);
        if (!child.page) child.page = rp;
        child.parentOverride = node.id;
        child.isDbRow = true;
        node.rowIds.push(rid);
      }
    }
  } catch (err) {
    node.failed = true;
    t.stats.failures++;
    t.stats.failedIds.push(node.id);
    console.error(`[notion] DB 수집 실패 ${node.id}:`, (err as Error)?.message ?? err);
  }
}

// 루트 발견 — NOTION_ROOT_PAGES 지정 시 그 서브트리만, 아니면 search(page + data_source 2패스).
async function discoverSeeds(t: Traversal): Promise<void> {
  if (t.cfg.rootIds.length) {
    for (const id of t.cfg.rootIds) {
      try {
        const p = (await notionFetch(t.cfg, `/pages/${id}`)) as NotionPage;
        pageNode(t, normalizeNotionId(p.id)).page = p;
      } catch {
        try {
          const d = (await notionFetch(t.cfg, `/databases/${id}`)) as NotionDatabase;
          dbNode(t, normalizeNotionId(d.id)).db = d;
        } catch (err) {
          t.stats.failures++;
          t.stats.failedIds.push(id);
          console.error(`[notion] 루트 ${id} 접근 실패(page/database 둘 다 아님):`, (err as Error)?.message ?? err);
        }
      }
    }
    return;
  }
  // search: page 전량 — 제목/부모/last_edited 맵 + 트래버스가 못 닿는 고아 페이지 안전망.
  for await (const r of paginate(t.cfg, (cursor) => ({
    path: "/search", method: "POST",
    body: {
      filter: { property: "object", value: "page" },
      sort: { timestamp: "last_edited_time", direction: "descending" },
      page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}),
    },
  }))) {
    if (r.object !== "page") continue;
    const p = r as unknown as NotionPage;
    const n = pageNode(t, normalizeNotionId(p.id));
    if (!n.page) n.page = p;
  }
  // search: data_source → 소유 database 큐잉(2025-09+). 구버전 호환으로 database 결과도 관용.
  try {
    for await (const r of paginate(t.cfg, (cursor) => ({
      path: "/search", method: "POST",
      body: { filter: { property: "object", value: "data_source" }, page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) },
    }))) {
      if (r.object === "database") { dbNode(t, normalizeNotionId(String(r.id ?? ""))); continue; }
      if (r.object !== "data_source") continue;
      const ds = r as unknown as NotionDataSource;
      const dbId = normalizeNotionId(String(ds.database_parent?.database_id ?? asRec(ds.parent).database_id ?? ""));
      if (dbId.length === 36) {
        dbNode(t, dbId);
        t.dsToDb.set(normalizeNotionId(ds.id), dbId);
      }
    }
  } catch (err) {
    // 구버전(2022-06-28) 강제 시 data_source 필터 미지원 — database 필터로 폴백.
    try {
      for await (const r of paginate(t.cfg, (cursor) => ({
        path: "/search", method: "POST",
        body: { filter: { property: "object", value: "database" }, page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) },
      }))) {
        if (r.object === "database") dbNode(t, normalizeNotionId(String(r.id ?? "")));
      }
    } catch { console.error("[notion] database 발견 search 실패:", (err as Error)?.message ?? err); }
  }
}

// block_id 부모 → 소유 페이지 해소(페이지가 컬럼/토글 안에 생성된 경우). 부모 체인을 따라 페이지까지.
async function resolveBlockOwnerPage(t: Traversal, blockId: string, hops = 8): Promise<string | null> {
  let cur = blockId;
  for (let i = 0; i < hops; i++) {
    try {
      const b = asRec(await notionFetch(t.cfg, `/blocks/${cur}`));
      const parent = asRec(b.parent);
      const type = String(parent.type ?? "");
      if (type === "page_id") return normalizeNotionId(String(parent.page_id ?? ""));
      if (type === "database_id") return normalizeNotionId(String(parent.database_id ?? ""));
      if (type === "data_source_id") {
        const dbId = t.dsToDb.get(normalizeNotionId(String(parent.data_source_id ?? "")));
        return dbId ?? null;
      }
      if (type === "block_id") { cur = String(parent.block_id ?? ""); continue; }
      return null; // workspace 등
    } catch { return null; }
  }
  return null;
}

// 페이지의 트리 부모 external id — 트래버스 override 우선, 없으면 page.parent 매핑.
async function parentExternalIdOf(t: Traversal, node: PageNode): Promise<string | undefined> {
  if (node.parentOverride) return node.parentOverride;
  const p = node.page?.parent;
  if (!p) return undefined;
  if (p.type === "page_id" && p.page_id) return normalizeNotionId(p.page_id);
  if (p.type === "database_id" && p.database_id) return normalizeNotionId(p.database_id);
  if (p.type === "data_source_id" && p.data_source_id) {
    return t.dsToDb.get(normalizeNotionId(p.data_source_id)) ?? undefined;
  }
  if (p.type === "block_id" && p.block_id) {
    return (await resolveBlockOwnerPage(t, p.block_id)) ?? undefined;
  }
  return undefined; // workspace 루트
}

// ── 방출 단계 헬퍼 ───────────────────────────────────────────────────────────
function titleOfPage(page: NotionPage | null): string {
  if (!page?.properties) return "";
  for (const v of Object.values(page.properties)) {
    if (v?.type === "title" && Array.isArray(v.title)) {
      const s = (v.title as NotionRichText[]).map((rt) => rt.plain_text ?? "").join("").trim();
      if (s) return s;
    }
  }
  return "";
}
function titleOfDb(db: NotionDatabase | null): string {
  return (db?.title ?? []).map((rt) => rt.plain_text ?? "").join("").trim();
}

function makeCtx(t: Traversal, ownerId: string, links: Map<string, string>): NotionMdCtx {
  return {
    resolveRef: (nid) => {
      const id = normalizeNotionId(nid);
      const viaDs = t.dsToDb.get(id);
      const target = viaDs ?? id;
      const pn = t.pages.get(target);
      if (pn) return { name: unitName("notion", target), title: titleOfPage(pn.page) || null };
      const dn = t.dbs.get(target);
      if (dn) return { name: unitName("notion", target), title: titleOfDb(dn.db) || null };
      return null;
    },
    resolveUser: (uid) => t.users.get(uid)?.name ?? null,
    assetUrl: (file, hint) => {
      const f = asRec(file);
      const type = String(f.type ?? "");
      let url = "";
      let expiring = false;
      if (type === "external") url = String(asRec(f.external).url ?? "");
      else if (type === "file") { url = String(asRec(f.file).url ?? ""); expiring = true; }
      else if (type === "custom_emoji") url = String(asRec(f.custom_emoji).url ?? "");
      else if (typeof f.url === "string") url = f.url;
      if (!url) return null;
      if (!expiring) return url; // external — 만료 없음, 원본 유지
      const fname = assetFileName({ ...hint, pageId: ownerId }, url);
      if (!t.assetJobs.has(fname)) t.assetJobs.set(fname, { url, file: fname });
      return `/api/ui/notion-assets/${fname}`;
    },
    addLink: (target, kind) => {
      const id = normalizeNotionId(target);
      if (!id || id === ownerId) return;
      if (!links.has(id)) links.set(id, kind);
    },
  };
}

function coverMd(ctx: NotionMdCtx, obj: { cover?: Rec | null } | null): string {
  const cover = obj?.cover;
  if (!cover) return "";
  const url = ctx.assetUrl(cover, { kind: "cover" });
  return url ? `![cover](${url})` : "";
}

function iconValue(icon: Rec | null | undefined): unknown {
  if (!icon) return null;
  if (icon.type === "emoji") return icon.emoji ?? null;
  return icon; // 파일형 아이콘 — 원본 객체 보존(자산은 assetUrl 경유 시 등록)
}

function linksArray(t: Traversal, links: Map<string, string>): Array<{ target_external_id: string; target_name: string; kind: string }> {
  return [...links.entries()]
    .filter(([id]) => t.pages.has(id) || t.dbs.has(id) || t.dsToDb.has(id))
    .map(([id, kind]) => {
      const target = t.dsToDb.get(id) ?? id;
      return { target_external_id: target, target_name: unitName("notion", target), kind };
    });
}

function emitPage(t: Traversal, node: PageNode, parentExtId: string | undefined): RawItem {
  const page = node.page!;
  const links = new Map<string, string>();
  const ctx = makeCtx(t, node.id, links);

  const parts: string[] = [];
  const cover = coverMd(ctx, page as { cover?: Rec | null });
  if (cover) parts.push(cover);
  const normProps = normalizeProperties(page.properties, ctx);
  if (node.isDbRow) {
    const table = propertiesTableMd(normProps);
    if (table) parts.push(table);
  }
  if (node.blocks) parts.push(blocksToMd(node.blocks, ctx));
  if (node.comments.length) parts.push(commentsToMd(node.comments, ctx));
  const body = parts.filter(Boolean).join("\n\n").trim();

  // 자식 순서를 부모가 들고 간다 — 증분에서 부모만 변경돼도(자식 재정렬) run-sync 후처리가 자식 sort 수렴.
  const childrenOrder = node.childrenOrder;
  const propsForFields: Record<string, NormalizedProp> = {};
  for (const [k, v] of Object.entries(normProps)) if (v.type !== "title") propsForFields[k] = v;

  const actorId = page.created_by?.id;
  const actorUser = actorId ? t.users.get(actorId) : null;
  const archived = page.archived === true || page.in_trash === true;

  t.stats.emitted++;
  return {
    type: "doc",
    provenance: {
      category: "collab_tool", system: "notion", instance: t.cfg.instance,
      external_id: node.id, external_url: page.url,
    },
    actor: actorId ? {
      external_id: actorId,
      display_name: actorUser?.name,
      email: actorUser?.person?.email,
      is_bot: actorUser?.type === "bot",
    } : undefined,
    container_ref: parentExtId,
    parent_external_id: parentExtId,
    sort: node.sort ?? undefined,
    title: titleOfPage(page) || "(제목 없음)",
    body: body || undefined,
    occurred_at: page.created_time,
    updated_at: page.last_edited_time,
    fields: {
      archived: page.archived ?? false,
      in_trash: page.in_trash ?? false,
      parent_type: page.parent?.type,
      last_edited_by: page.last_edited_by?.id,
      notion: {
        kind: node.isDbRow ? "db_row" : "page",
        url: page.url ?? null,
        icon: iconValue(page.icon as Rec | null),
        archived,
        properties: propsForFields,
        links: linksArray(t, links),
        children_order: childrenOrder,
        comment_count: node.comments.length,
      },
    },
    raw: {
      page,
      blocks: node.blocks ?? [],
      comments: node.comments,
      property_items: node.propertyItems,
    },
  };
}

function emitDb(t: Traversal, node: DbNode, parentExtId: string | undefined): RawItem {
  const db = node.db!;
  const links = new Map<string, string>();
  const ctx = makeCtx(t, node.id, links);

  const parts: string[] = [];
  const cover = coverMd(ctx, db as { cover?: Rec | null });
  if (cover) parts.push(cover);
  const desc = (db.description ?? []).map((rt) => rt.plain_text ?? "").join("").trim();
  if (desc) parts.push(desc);
  const schemaSrc = node.dataSources.length ? node.dataSources : (db.properties ? [{ id: db.id, properties: db.properties } as NotionDataSource] : []);
  if (schemaSrc.length) {
    parts.push("## 스키마", dataSourceSchemaMd(schemaSrc));
  }
  if (node.rowIds.length) {
    const listed = node.rowIds.slice(0, 100).map((rid) => {
      const rn = t.pages.get(rid);
      const title = titleOfPage(rn?.page ?? null) || "(제목 없음)";
      return `- 📄 [${title}](#/k/${unitName("notion", rid)})`;
    });
    parts.push(`## 항목 (${node.rowIds.length})`, listed.join("\n") + (node.rowIds.length > 100 ? `\n- … 외 ${node.rowIds.length - 100}건(하위 페이지 트리 참조)` : ""));
  }
  const body = parts.filter(Boolean).join("\n\n").trim();
  const archived = db.archived === true || db.in_trash === true;

  t.stats.emitted++;
  return {
    type: "doc",
    provenance: {
      category: "collab_tool", system: "notion", instance: t.cfg.instance,
      external_id: node.id, external_url: db.url,
    },
    actor: db.created_by?.id ? { external_id: db.created_by.id, display_name: t.users.get(db.created_by.id)?.name } : undefined,
    container_ref: parentExtId,
    parent_external_id: parentExtId,
    sort: node.sort ?? undefined,
    title: titleOfDb(db) || "(제목 없는 데이터베이스)",
    body: body || undefined,
    occurred_at: db.created_time,
    updated_at: db.last_edited_time,
    fields: {
      archived: db.archived ?? false,
      in_trash: db.in_trash ?? false,
      parent_type: db.parent?.type,
      notion: {
        kind: "database",
        url: db.url ?? null,
        icon: iconValue(db.icon as Rec | null),
        is_inline: db.is_inline ?? false,
        archived,
        links: linksArray(t, links),
        children_order: node.rowIds,
        data_source_ids: node.dataSources.map((d) => normalizeNotionId(d.id)),
      },
    },
    raw: { database: db, data_sources: node.dataSources },
  };
}

// ── 백필: collect(BFS) → hydrate users → 방출 → 자산 다운로드 ─────────────────
async function* backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
  const cfg = await loadConfig();
  reqCount = 0;
  const t: Traversal = {
    cfg,
    sinceMs: opts?.since ? Date.parse(opts.since) : undefined,
    pages: new Map(), dbs: new Map(), dsToDb: new Map(), users: new Map(),
    assetJobs: new Map(),
    stats: { pages: 0, databases: 0, emitted: 0, failures: 0, failedIds: [], assets: 0, assetFailures: 0, requests: 0 },
  };
  lastRunStats = t.stats;

  await discoverSeeds(t);

  // BFS — 맵이 자라는 동안 반복(새 발견 노드 처리). 처리 표식으로 순환 없이 수렴.
  const donePages = new Set<string>();
  const doneDbs = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, node] of [...t.dbs]) {
      if (doneDbs.has(id)) continue;
      doneDbs.add(id);
      progressed = true;
      await processDb(t, node);
    }
    for (const [id, node] of [...t.pages]) {
      if (donePages.has(id)) continue;
      donePages.add(id);
      progressed = true;
      await processPage(t, node);
    }
  }
  t.stats.pages = t.pages.size;
  t.stats.databases = t.dbs.size;

  // 사용자 해소 — 변경된 페이지/DB 의 원본 JSON 에서 user 참조 수집(멘션·people·created_by·댓글).
  const userRoots: unknown[] = [];
  for (const n of t.pages.values()) if (n.changed && !n.failed) userRoots.push(n.page, n.blocks, n.comments);
  for (const n of t.dbs.values()) if (!n.failed) userRoots.push(n.db);
  await hydrateUsers(t, userRoots);

  // 방출 — DB 노드 먼저(부모 dangling 최소화; 미러는 소프트참조라 순서 무해하지만 로그 가독성), 그 다음 변경 페이지.
  for (const node of t.dbs.values()) {
    if (node.failed || !node.db) continue;
    const parentExtId = node.parentOverride
      ?? (node.db.parent?.type === "page_id" && node.db.parent.page_id ? normalizeNotionId(node.db.parent.page_id) : undefined);
    try { yield emitDb(t, node, parentExtId); }
    catch (err) {
      node.failed = true; t.stats.failures++; t.stats.failedIds.push(node.id);
      console.error(`[notion] DB 방출 실패 ${node.id}:`, (err as Error)?.message ?? err);
    }
  }
  for (const node of t.pages.values()) {
    if (node.failed || !node.changed || !node.page) continue;
    try {
      const parentExtId = await parentExternalIdOf(t, node);
      yield emitPage(t, node, parentExtId);
    } catch (err) {
      node.failed = true; t.stats.failures++; t.stats.failedIds.push(node.id);
      console.error(`[notion] 페이지 방출 실패 ${node.id}:`, (err as Error)?.message ?? err);
    }
  }

  // 자산 다운로드 — 방출 후 일괄(중복 제거됨). 실패는 assetFailures + failures(커서 동결 → 다음 run 재시도).
  for (const job of t.assetJobs.values()) {
    try {
      await downloadAsset(job, cfg.assetDir);
      t.stats.assets++;
    } catch (err) {
      t.stats.assetFailures++;
      t.stats.failures++;
      console.error(`[notion] 자산 다운로드 실패 ${job.file}:`, (err as Error)?.message ?? err);
    }
  }

  t.stats.requests = reqCount;
  console.error(`[notion] 수집 완료 — 페이지 ${t.stats.pages} · DB ${t.stats.databases} · 방출 ${t.stats.emitted} · 실패 ${t.stats.failures} · 자산 ${t.stats.assets}(실패 ${t.stats.assetFailures}) · 요청 ${t.stats.requests}`);
}

export const notionConnector: Connector = {
  name: "notion",
  backfill,
};
