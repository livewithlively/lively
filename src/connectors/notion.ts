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
import { stateDir } from "../state-dir.js";
import crypto from "node:crypto";
import type { Connector, RawItem, BackfillOpts, ConnectorUser } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { unitName } from "../org/external-identity.js";
import {
  blocksToMd, commentsToMd, dataSourceSchemaMd, normalizeNotionId, normalizeProperties,
  parseNotionRootId, propertiesTableMd, type NotionMdCtx, type NormalizedProp,
} from "./notion-md.js";
import type {
  NotionBlock, NotionComment, NotionDatabase, NotionDataSource, NotionListResponse,
  NotionPage, NotionRichText, NotionUser,
} from "./notion-types.js";
import type { NotionLedger, NotionLedgerEntry } from "../v6/connector-mirror.js"; // type-only — 런타임 의존 없음(원장은 run-sync 가 주입)

// ── 상수 ───────────────────────────────────────────────────────────────────
const API_BASE = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2025-09-03"; // data_source 분리 버전(멀티소스 DB 대응) — NOTION_API_VERSION 로 오버라이드
const PAGE_SIZE = 100; // search/children/query/comments 공통 최대 페이지 크기
const REQ_INTERVAL_MS = 340; // 자발적 스로틀(~2.9 req/s 슬롯) — rate limit 선제 회피
const PAGE_CONCURRENCY = 4;  // 페이지 수집 병렬도 — 슬롯이 전역이라 총 rps 는 불변, 응답 지연만 숨긴다(#586)
const MAX_RETRY = 5; // 429/529/5xx 재시도 횟수
const MAX_BLOCK_DEPTH = 64; // 순환 방지 가드(정상 문서는 도달 불가 — 구버전의 '깊이 5 절단'과 달리 손실 아님)
const PAGE_FETCH_RETRY = 2; // 페이지 단위 재시도(블록 트리 등) — 그 후 실패는 failures 로 집계(미방출)
// 델타 증분(#586) 인덱싱 지연 안전창 — 노션 search 는 eventually-consistent 라 방금 편집분이 늦게 인덱싱될 수 있다.
//  커서보다 이만큼 과거까지 스캔하되, 원장(last_edited 동등) 대조로 기수집분은 0비용 스킵 → 지연이 이 창 안이면 유실 없음.
//  창을 넘는 지연·댓글 단독 변경·멘션 제목 캐시는 일일 full 스윕이 수렴(완결성의 최종 담보는 언제나 full).
const DELTA_LOOKBACK_MS = 72 * 3_600_000;

// ── 실행 통계 — run-sync 가 커서 동결/스윕 판단에 사용 ─────────────────────────
export interface NotionRunStats {
  pages: number; databases: number; emitted: number;
  failures: number; failedIds: string[];
  /** 권한 경계(403/404) — 통합이 볼 수 없는 객체. 실패와 달리 커서를 동결하지 않는다(재시도 무의미·liveness 보호). */
  inaccessible: number; inaccessibleIds: string[];
  /** 귀속 가능한 실패의 재시도 대상 ext id — 전부 귀속되면 run-sync 가 커서를 전진시키고 이 목록만 다음 run 이 재시도.
   *  (all-or-nothing 동결의 대체: '뭘 놓쳤는지 아는' 실패는 창을 닫아도 유실이 아니다) */
  retryIds: string[];
  /** 귀속 불가 실패(발견 자체 실패 등) — 1건이라도 있으면 기존대로 커서 동결. */
  unattributed: number;
  /** 가속 full 에서 원장 일치로 스킵(미방출)했지만 관측한 항목 — run-sync 가 last_synced_at 을 일괄 갱신(스윕 오탐 방지). */
  observedIds: string[];
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
  rootIds: string[]; excludeIds: string[]; comments: "page" | "all" | "off"; assetDir: string;
}

async function loadConfig(): Promise<NotionConfig> {
  const c = await resolveConnectorConfig("notion");
  if (!c.token) throw new Error("NOTION_TOKEN 이 없습니다 — Notion integration 토큰(secret_…)을 설정하세요(관리탭 또는 .env)");
  // 루트 페이지 — URL/슬러그/uuid 어떤 형태든 관용 파싱. 파싱 불가 항목은 **조용히 버리지 않고 즉시 실패**
  //  (버리면 search 폴백으로 넘어가 '왜 0건이지' 미스터리가 됨 — 실사용에서 발생한 함정 #551).
  const parseIds = (raw: string | undefined, envName: string): string[] => {
    const out: string[] = [];
    for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const id = parseNotionRootId(entry);
      if (!id || id.length !== 36) {
        throw new Error(`${envName} 항목을 페이지 id 로 해석할 수 없습니다: "${entry}" — 페이지 URL 전체, 슬러그(제목-32hex), 또는 32자리 id 를 넣으세요`);
      }
      out.push(id);
    }
    return out;
  };
  const rootIds = parseIds(c.root_pages, "NOTION_ROOT_PAGES");
  // 제외 페이지(및 하위 전체) — 파싱 불가 항목은 조용히 버리지 않고 즉시 실패(빠뜨리면 '제외했는데 계속 싱크되네'
  //  미스터리 + 원치 않은 데이터 유입). 루트와 대칭.
  const excludeIds = parseIds(c.exclude_pages, "NOTION_EXCLUDE_PAGES");
  const cm = (c.comments ?? "page").toLowerCase();
  return {
    token: c.token,
    instance: c.instance || "default",
    version: c.api_version || DEFAULT_NOTION_VERSION,
    rootIds, excludeIds,
    comments: cm === "all" || cm === "off" ? (cm as "all" | "off") : "page",
    assetDir: c.asset_dir || stateDir("notion-assets"),
  };
}

// ── HTTP 호출(인증/버전 헤더 + rate limit 존중 + 자발적 스로틀) ───────────────
//  전역 슬롯 방식(#586 속도개선): 요청 '시작 시각'을 REQ_INTERVAL_MS 간격의 슬롯으로 직렬화하되,
//  응답 대기는 겹친다(동시 in-flight) — 직렬 구현은 응답 지연만큼 실효 속도가 3rps 아래로 떨어졌다(~2rps).
//  병렬 워커(PAGE_CONCURRENCY)와 결합하면 노션 공식 한도(평균 3req/s)에 실효로 붙는다.
let nextSlotAt = 0;
let reqCount = 0;

async function rateSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + REQ_INTERVAL_MS;
  if (at > now) await sleep(at - now);
}

async function notionFetch(cfg: NotionConfig, pathname: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const url = pathname.startsWith("http") ? pathname : `${API_BASE}${pathname}`;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    await rateSlot();
    reqCount++;

    let res: Response;
    try {
      res = await fetch(url, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Notion-Version": cfg.version,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: init?.body != null ? JSON.stringify(init.body) : undefined,
        // 요청당 하드 타임아웃 — 응답이 안 오는 fetch 가 무한 대기하면 워커가 침묵 정지(행)해 정체 감지 킬로
        //  귀결된다(어니스트 실배포 의혹). 60s 에 끊고 재시도 → 소진 시 실패 집계(커서 동결)로 전환.
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (attempt < MAX_RETRY) { await sleep(REQ_INTERVAL_MS * (attempt + 2)); continue; } // 타임아웃/네트워크 — 재시도
      throw new Error(`Notion 네트워크 실패(재시도 소진) ${pathname}: ${(err as Error)?.message ?? err}`);
    }

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

// ── 자산(asset) 다운로드 ──────────────────────────────────────────────────────
//  ⚠ 화면·로그에 내보내는 말은 **'첨부 파일'** 이다(#859) — '자산'은 관리탭에서 스킬·서브에이전트·커맨드를
//  가리키는 다른 뜻으로 이미 쓰였다. 여기 식별자(assetDir·assetJobs·stats.assets)는 그대로 둔다.
//  노션 파일 URL 은 발급 후 1시간 만료 — 대형 워크스페이스는 수집만 2시간+라 다운로드 시점(맨 끝)엔 초반
//  URL 이 전부 죽는다(어니스트 실배포: 자산 403 48건 → 커서 동결 → 125분 full 무한 반복). 소유 블록/페이지를
//  재조회하면 같은 S3 경로에 새 서명이 발급되므로(경로는 파일 버전당 안정), 만료·403 시 재조회로 치유한다.
interface AssetJob { url: string; file: string; blockId?: string; pageId?: string; kind?: string; expiry?: string }

function assetFileName(hint: { blockId?: string; pageId?: string; kind: string; name?: string }, url: string): string {
  let base = "";
  try { base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""); } catch { /* 무시 */ }
  const name = (hint.name || base || "asset").slice(-80);
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
  let urlPath = "";
  try { urlPath = new URL(url).pathname; } catch { /* 무시 */ }
  // URL 경로를 키에 포함 — 같은 페이지에서 동명 파일 2개(files 속성·댓글 첨부 등)가 서로를 덮어쓰는 충돌 방지.
  //  S3 키 경로는 파일 버전당 안정(서명 쿼리만 변동)이라 재싱크에도 파일명이 결정적.
  const key = crypto.createHash("sha1")
    .update(`${hint.pageId ?? ""}|${hint.blockId ?? ""}|${hint.kind}|${name}|${urlPath}`)
    .digest("hex").slice(0, 24);
  return ext ? `${key}.${ext}` : key;
}

/** JSON 을 깊이 걷어 원본과 같은 S3 경로(pathname)를 가진 새 presigned URL 을 찾는다. */
function findUrlByPath(node: unknown, targetPath: string): string | null {
  if (typeof node === "string") {
    if (node.startsWith("http")) {
      try { if (new URL(node).pathname === targetPath) return node; } catch { /* URL 아님 */ }
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const v of node) { const r = findUrlByPath(v, targetPath); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node as Rec)) { const r = findUrlByPath(v, targetPath); if (r) return r; }
  }
  return null;
}

/** 만료된 자산 URL 재발급 — 소유 블록 → 페이지 → (댓글 첨부) 순으로 재조회해 같은 경로의 새 서명을 찾는다. */
async function refreshAssetUrl(t: Traversal, job: AssetJob): Promise<string | null> {
  let targetPath = "";
  try { targetPath = new URL(job.url).pathname; } catch { return null; }
  const sources: Array<() => Promise<unknown>> = [];
  if (job.blockId) sources.push(() => notionFetch(t.cfg, `/blocks/${job.blockId}`));
  if (job.pageId) sources.push(() => notionFetch(t.cfg, `/pages/${job.pageId}`));
  if (job.kind === "comment_attachment" && job.pageId) {
    sources.push(async () => {
      const out: unknown[] = [];
      for await (const cr of paginate(t.cfg, (cursor) => ({
        path: `/comments?block_id=${encodeURIComponent(job.pageId!)}&page_size=${PAGE_SIZE}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      }))) out.push(cr);
      return out;
    });
  }
  for (const src of sources) {
    try {
      const fresh = findUrlByPath(await src(), targetPath);
      if (fresh) return fresh;
    } catch { /* 다음 소스 */ }
  }
  return null;
}

async function downloadAsset(t: Traversal, job: AssetJob, dir: string): Promise<void> {
  const dest = path.join(dir, job.file);
  let url = job.url;
  // 선제 재발급 — 만료시각(expiry_time)이 지났으면 죽은 요청을 시도조차 하지 않는다(대형 워크스페이스 기본 경로).
  if (job.expiry && Date.parse(job.expiry) < Date.now() + 30_000) {
    url = (await refreshAssetUrl(t, job)) ?? url;
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 자산은 파일 크기가 커 API 보다 넉넉한 타임아웃(5분) — 무한 대기(행)만 차단.
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) {
        // 403/400 = 서명 만료(수집~다운로드 사이 1h 초과) — 소유 객체 재조회로 새 URL 발급 후 재시도.
        if ((res.status === 403 || res.status === 400) && !refreshed) {
          refreshed = true;
          const fresh = await refreshAssetUrl(t, job);
          if (fresh) { url = fresh; throw new Error(`HTTP ${res.status} — 재발급 후 재시도`); }
        }
        throw new Error(`HTTP ${res.status}`);
      }
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
  /** 델타 증분 — since 판정과 무관하게 강제 수집(원장 불일치·개명 부모 재렌더 등) */
  forceChanged?: boolean;
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
  /** API 미지원 DB(linked 뷰 등) — 노드는 적재하되(트리 링크 보존) 행/스키마 없음. 실패로 집계하지 않는다. */
  unsupported: boolean;
}

interface Traversal {
  cfg: NotionConfig;
  sinceMs: number | undefined;
  /** 델타 증분(#586) — 미러 원장 스냅샷. 있으면 discoverSeeds 대신 search 델타로 변경분만 수집. */
  ledger: NotionLedger | null;
  /** 가속 full(#586) — full 트래버스에서 원장 일치 페이지의 무거운 수집(블록/댓글/속성)을 생략하되 관측은 기록.
   *  발견은 여전히 BFS(트래버스가 진실) — search 의존이 아니라 full 의 완전성 보장이 유지된다. */
  fastFull: boolean;
  /** 원장 기준 부모→자식(ext id) — 가속 full 에서 미변경 페이지의 자식을 요청 0으로 큐잉(행은 DB 나열이 담당). */
  ledgerChildren: Map<string, string[]>;
  /** 루트 모드 델타의 스코프 판정 메모(조상 체인 워크 결과 캐시 — 형제 후보 반복 워크 방지) */
  membership: Map<string, boolean>;
  /** 제외 서브트리(excludeIds) 판정 메모 — id→(조상 중 제외 루트 존재?). excludeIds 비면 미사용. */
  excluded: Map<string, boolean>;
  /** 댓글 read capability 부재(403) 관측 — 이후 페이지는 댓글 호출 자체를 스킵(페이지당 1회 403 낭비 제거, #586). */
  commentsDenied: boolean;
  pages: Map<string, PageNode>;
  dbs: Map<string, DbNode>;
  dsToDb: Map<string, string>;
  users: Map<string, NotionUser | null>;
  assetJobs: Map<string, AssetJob>; // file → job (중복 다운로드 방지)
  stats: NotionRunStats;
}

/** data_source id → 소유 DB — 이번 run 관측 우선, 없으면 원장 역매핑(델타에서 미변경 DB 의 행/링크 해소). */
function dsOwnerDb(t: Traversal, dsId: string): string | undefined {
  return t.dsToDb.get(dsId) ?? t.ledger?.dsToDb.get(dsId);
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
    n = { id, db: null, dataSources: [], rowIds: [], parentOverride: null, sort: null, failed: false, unsupported: false };
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
  // seen = 현재 **경로**(조상 체인) — 순환(synced A↔B)만 차단한다. 전역 방문셋로 하면 같은 원본을 참조하는
  //  두 번째 synced 복제의 자식이 절단된다(#551 리뷰). 경로 시맨틱은 재귀 뒤 delete 로 유지.
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
  seen.delete(blockId); // 경로 이탈 — 형제 브랜치에서 같은 블록(synced 원본) 재fetch 허용
  return out;
}

// 블록 트리에서 child_page/child_database 발견 → 노드 큐잉 + 부모의 자식 순서 기록.
function discoverChildren(t: Traversal, node: PageNode): void {
  const order: string[] = [];
  const walk = (blocks: NotionBlock[]): void => {
    for (const b of blocks) {
      const type = String(b.type ?? "");
      const id = normalizeNotionId(String(b.id ?? ""));
      // 제외 루트로 지정된 하위 문서/DB 는 부모의 자식목록(트리)에서도 뺀다 — 노드 생성·큐잉 자체를 생략(하위 전체는
      //  발견되지 않아 자연히 제외; search 로 시딩된 하위는 방출 게이트가 처리). excludeIds 비면 무비용.
      if ((type === "child_page" || type === "child_database") && t.cfg.excludeIds.length && t.cfg.excludeIds.includes(id)) continue;
      if (type === "child_page") {
        // 델타(#586): 원장이 같은 부모의 활성 자식으로 이미 아는 페이지는 노드 생성 자체를 생략(요청 0) —
        //  그 자식이 실제로 변경됐다면 search 델타가 별도 후보로 이미 큐잉했다(t.pages 에 존재 → 이 분기 미진입).
        //  가속 full 에선 생략 금지 — 모든 자식이 관측(last_synced_at)돼야 스윕이 오탐하지 않는다(1req 스킵 경로로 흡수).
        if (t.ledger && !t.fastFull && !t.pages.has(id)) {
          const led = t.ledger.byId.get(id);
          if (led && led.kind !== "database" && led.lifecycle === "active" && led.parentExt === node.id) { order.push(id); continue; }
        }
        const child = pageNode(t, id);
        child.parentOverride = node.id;
        child.sort = order.length;
        if (t.ledger) child.forceChanged = true; // 신규/이동/복원 자식 — 원장 불일치로만 이 분기에 온다
        order.push(id);
      } else if (type === "child_database") {
        if (t.ledger && !t.fastFull && !t.dbs.has(id)) {
          const led = t.ledger.byId.get(id);
          if (led && led.kind === "database" && led.lifecycle === "active" && led.parentExt === node.id) { order.push(id); continue; }
        }
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
      // ⚠ 노션 속성 id 는 이미 퍼센트 인코딩된 형태(예: %60Tv%3D)로 온다 — encodeURIComponent 로 이중 인코딩하면
      //  엉뚱한 속성 조회가 되고 API 가 404 가 아니라 **200 + 빈 결과** 를 줘 실패 감지까지 우회한다(#551 실검증에서 발견).
      const propId = /^[A-Za-z0-9%~_.\-]+$/.test(String(p.id)) ? String(p.id) : encodeURIComponent(String(p.id));
      const items: unknown[] = [];
      for await (const item of paginate(t.cfg, (cursor) => ({
        path: `/pages/${page.id}/properties/${propId}?page_size=${PAGE_SIZE}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      }))) items.push(item);
      if (!items.length) throw new Error("property items 0건(절단 상태 유지 위험) — 속성 id 인코딩/권한 확인 필요");
      node.propertyItems[pname] = items;
      mergePropertyItems(p, type, items);
    } catch (err) {
      // 속성 하이드레이션 실패 = 25개 절단 상태 — 조용히 넘어가면 손실이므로 실패로 집계(커서 동결 → 다음 run 재시도).
      t.stats.failures++;
      t.stats.failedIds.push(`${page.id}:prop:${pname}`);
      t.stats.retryIds.push(normalizeNotionId(String(page.id)));
      console.error(`[notion] 속성 하이드레이션 실패 ${page.id} '${pname}':`, (err as Error)?.message ?? err);
    }
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
  if (t.cfg.comments === "off" || t.commentsDenied) return;
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
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 403) {
        if (!t.commentsDenied) console.error("[notion] 댓글 read capability 없음(403) — 이후 페이지의 댓글 호출을 전부 생략(통합 설정에서 'Read comments' 를 켜면 다음 싱크부터 수집)");
        t.commentsDenied = true; // 권한 경계 — 손실 아님, 이후 전부 스킵(요청 낭비 제거)
        break;
      }
      t.stats.failures++;
      t.stats.failedIds.push(`${node.id}:comments`);
      t.stats.retryIds.push(node.id);
      console.error(`[notion] 댓글 수집 실패 ${node.id}:`, (err as Error)?.message ?? err);
      break;
    }
  }
}

// ── collect 단계 — BFS 로 페이지/DB 전체 수집 ─────────────────────────────────
async function processPage(t: Traversal, node: PageNode): Promise<void> {
  try {
    // 제외 서브트리 게이트 — 방출·관측 이전에 막는다(가속 full 의 관측 갱신보다 먼저라야 이미 싱크된 제외 항목이
    //  last_synced_at 갱신을 피하고 다음 full 스윕에서 보관된다). 미방출·미관측 → 실패/재시도 아님(결정적 제외).
    if (await underExcluded(t, node.id, node.parentOverride)) { node.changed = false; return; }
    if (!node.page) {
      node.page = (await notionFetch(t.cfg, `/pages/${node.id}`)) as NotionPage;
    }
    // 가속 full(#586) — 원장 일치(편집시각 동등·settled·활성·부모 불변·자산 실재) 페이지는 무거운 수집 생략.
    //  방출은 안 하지만 '관측'으로 기록(run-sync 가 last_synced_at 일괄 갱신 → 스윕 오탐 방지),
    //  자식은 원장으로 큐잉(행 제외 — DB 나열이 무료로 담당). 자산 파일이 디스크에 없으면 스킵하지 않고
    //  전체 재수집 → 재발급 다운로드로 자가치유(과거 run 의 자산 실패 잔재 정리).
    if (t.fastFull && node.forceChanged !== true && t.ledger) {
      const led = t.ledger.byId.get(node.id);
      const live = String(node.page.last_edited_time ?? "");
      const settled = led?.syncedAt && led.lastEdited
        ? Date.parse(led.syncedAt) - Date.parse(led.lastEdited) >= 60_000 : false;
      const p = node.page.parent;
      const curParent = node.parentOverride
        ?? (p?.type === "page_id" && p.page_id ? normalizeNotionId(p.page_id)
          : p?.type === "database_id" && p.database_id ? normalizeNotionId(p.database_id)
          : p?.type === "data_source_id" && p.data_source_id ? dsOwnerDb(t, normalizeNotionId(p.data_source_id)) ?? null
          : null);
      const assetsOk = !led?.assets?.length
        || led.assets.every((f) => { try { return fs.existsSync(path.join(t.cfg.assetDir, f)); } catch { return false; } });
      if (led && led.lifecycle === "active" && led.lastEdited === live && settled
          && (curParent == null || led.parentExt == null || curParent === led.parentExt) && assetsOk) {
        node.changed = false;
        t.stats.observedIds.push(node.id);
        for (const childId of t.ledgerChildren.get(node.id) ?? []) {
          const cl = t.ledger.byId.get(childId);
          if (cl?.kind === "database") dbNode(t, childId);
          else pageNode(t, childId);
        }
        return;
      }
    }
    node.changed = node.forceChanged === true || isChanged(t, node.page.last_edited_time);
    if (!node.changed && t.ledger) {
      // 델타 — last_edited 로는 안 잡히는 변경: 원장에 없음(신규/편입), 아카이브→복원, 부모 이동.
      //  (block_id 부모의 이동은 여기서 동기 판정 불가 — full 이 수렴. 나머지는 즉시 재방출.)
      const led = t.ledger.byId.get(node.id);
      const p = node.page.parent;
      const curParent = node.parentOverride
        ?? (p?.type === "page_id" && p.page_id ? normalizeNotionId(p.page_id)
          : p?.type === "database_id" && p.database_id ? normalizeNotionId(p.database_id)
          : p?.type === "data_source_id" && p.data_source_id ? dsOwnerDb(t, normalizeNotionId(p.data_source_id)) ?? null
          : null);
      if (!led || led.lifecycle === "archived" || (curParent != null && led.parentExt != null && curParent !== led.parentExt)) {
        node.changed = true;
      }
    }
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
    const status = (err as { status?: number })?.status;
    if (status === 403 || status === 404) {
      // 권한 경계 — 통합이 볼 수 없는 하위 페이지(공유 해제 등). 재시도 무의미: 실패로 치면 커서가 영구 동결된다.
      t.stats.inaccessible++;
      t.stats.inaccessibleIds.push(node.id);
    } else {
      t.stats.failures++;
      t.stats.failedIds.push(node.id);
      t.stats.retryIds.push(node.id);
    }
    console.error(`[notion] 페이지 수집 실패 ${node.id} (${status ?? "?"}):`, (err as Error)?.message ?? err);
  }
}

async function processDb(t: Traversal, node: DbNode): Promise<void> {
  try {
    // 제외 서브트리 게이트 — DB 와 그 행 전체를 방출 이전에 막는다(node.failed 로 안 남겨 방출 루프가 건너뜀).
    if (await underExcluded(t, node.id, node.parentOverride)) { node.failed = true; return; }
    node.db = (await notionFetch(t.cfg, `/databases/${node.id}`)) as NotionDatabase;
    const dsRefs = node.db.data_sources ?? [];
    if (dsRefs.length) {
      for (const ref of dsRefs) {
        try {
          const ds = (await notionFetch(t.cfg, `/data_sources/${ref.id}`)) as NotionDataSource;
          node.dataSources.push(ds);
          t.dsToDb.set(normalizeNotionId(ref.id), node.id);
        } catch (err) {
          t.stats.failures++; // 스키마 없이 적재하면 DB 노드가 절단 — 실패로 집계(귀속 재시도)
          t.stats.failedIds.push(`${node.id}:ds:${ref.id}`);
          t.stats.retryIds.push(node.id);
          console.error(`[notion] data_source 스키마 실패 ${ref.id}:`, (err as Error)?.message ?? err);
        }
        // 행 나열 — 전 행(page 객체), 생성순 정렬을 노션에 위임(created_time 은 분 단위 절사라 로컬 재정렬 시
        //  같은 분에 만든 행들이 쿼리 반환순으로 뒤집힘 — API sorts 가 내부 정밀도로 동률을 해소한다).
        const rows: Array<{ id: string; created: string }> = [];
        for await (const row of paginate(t.cfg, (cursor) => ({
          path: `/data_sources/${ref.id}/query`, method: "POST",
          body: {
            page_size: PAGE_SIZE,
            sorts: [{ timestamp: "created_time", direction: "ascending" }],
            ...(cursor ? { start_cursor: cursor } : {}),
          },
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
        // 노션 뷰 순서는 API 미제공(설계 고지) — 생성순은 위 query sorts 가 보장(API 반환 순서 신뢰).
        rows.forEach((r, i) => {
          const child = pageNode(t, r.id);
          if (child.sort == null) child.sort = i;
          node.rowIds.push(r.id);
        });
      }
    } else if (t.ledger?.byId.get(node.id)?.unsupported) {
      // 원장이 이미 linked 뷰(미지원)로 아는 DB — 무의미한 query 400 왕복 생략(가속 full/델타 공통).
      node.unsupported = true;
      t.stats.inaccessible++;
      t.stats.inaccessibleIds.push(`${node.id}:linked-db`);
    } else {
      // data_sources 가 빈 DB — ① 구버전 API(2022-06-28) 강제 시 database 직접 query ② **linked database 뷰**
      //  (연결된 DB 보기)는 2025-09-03 에서 이 폴백이 400 invalid_request_url 로 거절된다(원본 query 는 원본
      //  DB 가 공유 범위에 있으면 그쪽에서 수집됨). 후자는 노션 API 원천 한계 — 실패(커서 동결)가 아니라
      //  미지원으로 분류하고 노드 자체는 적재해 트리/링크가 깨지지 않게 한다(#586 실배포에서 발견).
      try {
        for await (const row of paginate(t.cfg, (cursor) => ({
          path: `/databases/${node.id}/query`, method: "POST",
          body: {
            page_size: PAGE_SIZE,
            sorts: [{ timestamp: "created_time", direction: "ascending" }],
            ...(cursor ? { start_cursor: cursor } : {}),
          },
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
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 400 || status === 404) {
          node.unsupported = true;
          t.stats.inaccessible++;
          t.stats.inaccessibleIds.push(`${node.id}:linked-db`);
          console.error(`[notion] DB 미지원(linked 뷰 등) ${node.id} — 행 수집 생략(원본 DB 가 공유 범위에 있으면 그쪽으로 수집됨)`);
        } else {
          throw err; // 5xx/429 소진 등 — 실제 실패(재시도 대상, 커서 동결)
        }
      }
    }
  } catch (err) {
    node.failed = true;
    const status = (err as { status?: number })?.status;
    if (status === 403 || status === 404) {
      t.stats.inaccessible++;
      t.stats.inaccessibleIds.push(node.id);
    } else {
      t.stats.failures++;
      t.stats.failedIds.push(node.id);
      t.stats.retryIds.push(node.id);
    }
    console.error(`[notion] DB 수집 실패 ${node.id} (${status ?? "?"}):`, (err as Error)?.message ?? err);
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
          t.stats.unattributed++; // 발견 자체 실패 — 귀속 재시도 불가, 커서 동결 유지
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
    } catch {
      // DB 발견 자체가 실패 — 이대로 full 스윕하면 살아있는 DB·행 전부가 미관측→archived 오탐. 실패로 집계.
      t.stats.failures++;
      t.stats.unattributed++; // 발견 자체 실패 — 스윕/증분 창 신뢰 불가, 커서 동결
      t.stats.failedIds.push("search:data_source");
      console.error("[notion] database 발견 search 실패:", (err as Error)?.message ?? err);
    }
  }
}

// ── 델타 증분(#586) — search(last_edited desc) + 원장 대조로 변경분만 수집. ─────
//  비용이 워크스페이스 크기가 아니라 **변경량에 비례**한다:
//   · 페이지/행: 정렬 search 를 since-LOOKBACK 까지만 스캔, 원장 last_edited 동등이면 0비용 스킵.
//   · DB: data_source 나열(~N/100 req)로 스키마 변경·신규만 재수집 — linked 뷰(ds 없음)는 비용 0.
//   · 신규/이동/복원은 원장 불일치로, 자식 추가·재정렬은 부모 last_edited 갱신으로 잡힌다(노션 시맨틱).
//  안 잡히는 것(댓글 단독 변경·타 페이지 멘션의 제목 캐시·아카이브 전파·LOOKBACK 초과 인덱싱 지연)은
//  일일 full 스윕이 수렴 — 증분은 빠른 수렴 경로, 완결성의 담보는 full 이라는 기존 불변식 유지.

// ── 제외 서브트리(관리탭 '제외 페이지') — excludeIds 로 지정한 페이지/DB 와 그 하위 전체를 싱크에서 뺀다. ──
//  스코프(inScope)와 대칭: 조상 체인을 워크해 excludeIds 에 닿으면 제외. 원장 parentExt 로 0-fetch 우선(대부분
//  이미 싱크된 페이지라 부모를 원장이 앎), 미상만 live 조회. 결과 memo. excludeIds 비면 즉시 false(무비용 — 기존 설치 무영향).
//  방출 직전(processPage/processDb 최상단)에 게이트하므로 모든 발견 경로(루트 BFS·search·DB 행·원장 자식)를 한 곳에서 막는다.

/** parent 레코드 → 상위 페이지/DB 의 external id(최상단이면 null). inScope 의 부모 해소와 동일 규칙. */
async function parentExtOf(t: Traversal, parent: Rec): Promise<string | null> {
  const ptype = String(parent.type ?? "");
  if (ptype === "page_id") return normalizeNotionId(String(parent.page_id ?? "")) || null;
  if (ptype === "database_id") return normalizeNotionId(String(parent.database_id ?? "")) || null;
  if (ptype === "data_source_id") return dsOwnerDb(t, normalizeNotionId(String(parent.data_source_id ?? ""))) ?? null;
  if (ptype === "block_id") return (await resolveBlockOwnerPage(t, String(parent.block_id ?? ""))) ?? null;
  return null; // workspace 등 — 최상단
}

/** id(또는 그 조상)가 제외 루트에 속하나. seedParentExt = 알려진 직계 부모(있으면 첫 홉 조회 절약: DB 행·자식). */
async function underExcluded(t: Traversal, id: string, seedParentExt?: string | null): Promise<boolean> {
  if (!t.cfg.excludeIds.length) return false;
  if (t.cfg.excludeIds.includes(id)) return true;
  const cached = t.excluded.get(id);
  if (cached !== undefined) return cached;
  const walked: string[] = [id];
  let cur = id;
  let verdict = false;
  let memoize = true; // 일시 실패(5xx 소진 등)로 조상 미상이면 memo 하지 않는다 — '제외 아님' 오판을 굳혀 원치 않은 유입 방지, 다음 run 재판정.
  for (let hops = 0; hops < 24; hops++) {
    let parentExt: string | null = hops === 0 && seedParentExt != null ? seedParentExt : null;
    if (parentExt == null) parentExt = t.ledger?.byId.get(cur)?.parentExt ?? null;
    if (parentExt == null) {
      try {
        parentExt = await parentExtOf(t, asRec(((await notionFetch(t.cfg, `/pages/${cur}`)) as NotionPage).parent));
      } catch {
        try {
          parentExt = await parentExtOf(t, asRec(((await notionFetch(t.cfg, `/databases/${cur}`)) as NotionDatabase).parent));
        } catch (err) {
          const s = (err as { status?: number })?.status;
          if (s !== 400 && s !== 403 && s !== 404) memoize = false; // 접근 불가/비객체 조상 = 진짜 경계(제외 아님); 그 외는 일시 실패로 판정 보류
          break;
        }
      }
    }
    if (!parentExt || parentExt.length !== 36) break; // 워크스페이스 등 최상단 — 제외 루트 못 만남
    if (t.cfg.excludeIds.includes(parentExt)) { verdict = true; break; }
    const memoed = t.excluded.get(parentExt);
    if (memoed !== undefined) { verdict = memoed; break; }
    walked.push(parentExt);
    cur = parentExt;
  }
  if (memoize) for (const w of walked) t.excluded.set(w, verdict);
  return verdict;
}

/** 루트 모드 스코프 판정 — 조상 체인을 원장/루트에 닿을 때까지 워크(결과는 memo). search 모드는 전 범위. */
async function inScope(t: Traversal, id: string, parent: Rec): Promise<boolean> {
  if (!t.cfg.rootIds.length) return true;
  if (t.cfg.rootIds.includes(id)) return true;
  // 원장 숏컷은 **부모 불변 + 활성**일 때만 — 원장 존재만으로 판정하면 서브트리 밖으로 이동한 페이지가
  //  full 스윕(archived)과 델타(재활성) 사이에서 플래핑한다(리뷰). 부모가 그대로면 기존 스코프를 신뢰.
  const selfLed = t.ledger?.byId.get(id);
  const ptype0 = String(parent.type ?? "");
  const curExt = ptype0 === "page_id" ? normalizeNotionId(String(parent.page_id ?? ""))
    : ptype0 === "database_id" ? normalizeNotionId(String(parent.database_id ?? ""))
    : ptype0 === "data_source_id" ? (dsOwnerDb(t, normalizeNotionId(String(parent.data_source_id ?? ""))) ?? null)
    : null;
  if (selfLed?.lifecycle === "active" && curExt != null && curExt === selfLed.parentExt) return true;
  const cached = t.membership.get(id);
  if (cached !== undefined) return cached;
  const walked: string[] = [id];
  let curParent = parent;
  let verdict = false;
  for (let hops = 0; hops < 24; hops++) {
    const ptype = String(curParent.type ?? "");
    let nextId: string | null = null;
    if (ptype === "page_id") nextId = normalizeNotionId(String(curParent.page_id ?? ""));
    else if (ptype === "database_id") nextId = normalizeNotionId(String(curParent.database_id ?? ""));
    else if (ptype === "data_source_id") nextId = dsOwnerDb(t, normalizeNotionId(String(curParent.data_source_id ?? ""))) ?? null;
    else if (ptype === "block_id") nextId = await resolveBlockOwnerPage(t, String(curParent.block_id ?? ""));
    else break; // workspace 등 — 루트 체인에 닿지 못함 → 범위 밖
    if (!nextId || nextId.length !== 36) break;
    if (t.cfg.rootIds.includes(nextId) || t.ledger?.byId.get(nextId)?.lifecycle === "active") { verdict = true; break; }
    const memoed = t.membership.get(nextId);
    if (memoed !== undefined) { verdict = memoed; break; }
    walked.push(nextId);
    try {
      curParent = asRec(((await notionFetch(t.cfg, `/pages/${nextId}`)) as NotionPage).parent);
    } catch {
      try { curParent = asRec(((await notionFetch(t.cfg, `/databases/${nextId}`)) as NotionDatabase).parent); }
      catch (err2) {
        const s = (err2 as { status?: number })?.status;
        if (s === 400 || s === 403 || s === 404) break; // 접근 불가/비객체 조상 — 진짜 경계, 범위 밖 취급
        // 일시 실패(5xx 소진 등) — '범위 밖' 오판을 memo 로 체인 전체에 굳히면 커서 전진과 함께 유실된다(리뷰)
        //  → memo 없이 실패 집계(커서 동결), 다음 run 이 재판정.
        t.stats.failures++;
        t.stats.failedIds.push(`${id}:scope`);
        t.stats.retryIds.push(id);
        return false;
      }
    }
  }
  for (const w of walked) t.membership.set(w, verdict);
  return verdict;
}

/** 델타에서 이 DB(data_source 관측)를 재수집할지 — **알려진 활성 DB + 스키마 변경 positive evidence** 일 때만 true.
 *  전 워크스페이스엔 data_source 가 수백~수천(대부분 linked 뷰·인라인 표)일 수 있고 대부분 미러에 안 남는다 →
 *  모르는(led 없음)·비활성·비-DB·미변경은 재수집 금지(매 증분 재수집이면 비용 붕괴). 신규 top-level DB·놓친 스키마
 *  변경은 일일 full 이 수렴하고, 신규 인라인 DB 는 부모 페이지 델타→discoverChildren 로 잡힌다(그 경로 불변). */
function dbDeltaShouldCollect(led: NotionLedgerEntry | undefined, live: string): boolean {
  if (!led || led.kind !== "database" || led.lifecycle !== "active") return false; // 모름/비활성/비-DB
  if (!led.dsEdited || !live || live <= led.dsEdited) return false;                 // 미변경/비교 불가(응답 드리프트) — 스킵
  return true;
}

/** 델타 발견 — 후보를 t.pages/t.dbs 에 시딩. 이후 BFS·방출은 full 과 동일 경로(코드 분기 최소화). */
async function discoverDelta(t: Traversal, sinceMs: number): Promise<void> {
  const ledger = t.ledger!;
  const floorMs = sinceMs - DELTA_LOOKBACK_MS;
  const c = { pages: 0, rows: 0, dbs: 0, skippedDbs: 0, skipped: 0, outOfScope: 0, scanned: 0 };

  // 개명 감지 시 이전/현재 부모 재렌더 큐잉 — 부모 본문의 child_page 제목 캐시·DB 항목 목록이 스테일해지지 않게.
  const reRender = (pid: string | null | undefined): void => {
    if (!pid || pid.length !== 36) return;
    const led = ledger.byId.get(pid);
    if (!led || led.lifecycle !== "active") return;
    if (led.kind === "database") { dbNode(t, pid); return; }
    const pn = pageNode(t, pid);
    pn.forceChanged = true;
    // DB 행을 일반 페이지로 재방출하면 속성 테이블·kind 가 소실된다(리뷰). parentOverride 는 두지 않는다 —
    //  원장 부모는 스테일할 수 있고(그 사이 행 이동), live page.parent(processPage 재fetch)가 진실.
    if (led.kind === "db_row") pn.isDbRow = true;
  };

  // ① data_source 스윕 — dsToDb 최신화 + **변경 증거 있는 알려진 DB만** 재수집.
  //  ⚠ 예전엔 여기서 발견한 data_source 를 (모르는 것 포함) 죄다 큐잉해, 전 워크스페이스에 linked 뷰·인라인 표가
  //  수백~수천이면 매 증분이 그 전부를 inScope 워크+재수집했다(어니스트 실박스: 알려진 8 vs 발견 838 → 증분 30분+,
  //  방출 0). dbDeltaShouldCollect 로 모르는/비활성/미변경은 스킵 → 발견 비용이 변경량에 비례(dsToDb 매핑만 전량 최신화).
  for await (const r of paginate(t.cfg, (cursor) => ({
    path: "/search", method: "POST",
    body: { filter: { property: "object", value: "data_source" }, page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) },
  }))) {
    if (r.object !== "data_source") continue;
    const ds = r as unknown as NotionDataSource & { last_edited_time?: string };
    const dsId = normalizeNotionId(String(ds.id ?? ""));
    const dbId = normalizeNotionId(String(ds.database_parent?.database_id ?? asRec(ds.parent).database_id ?? ""));
    if (dbId.length !== 36) continue;
    t.dsToDb.set(dsId, dbId); // 행→소유 DB 해소용 — 스킵과 무관하게 항상 최신화(비용 0)
    if (t.dbs.has(dbId)) continue;
    const led = ledger.byId.get(dbId);
    const live = String((ds as Rec).last_edited_time ?? "");
    if (!dbDeltaShouldCollect(led, live)) { c.skippedDbs++; continue; } // 모름/미변경/비활성 → inScope·재수집 전에 컷
    if (!(await inScope(t, dbId, asRec(ds.parent)))) { c.outOfScope++; continue; }
    dbNode(t, dbId);
    c.dbs++;
  }

  // ② 페이지 델타 — last_edited desc 정렬 스캔, floor 아래에서 중단(그 이전은 전부 원장이 안다).
  outer:
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
    c.scanned++;
    const ms = Date.parse(p.last_edited_time ?? "");
    if (Number.isFinite(ms) && ms < floorMs) break outer;
    const id = normalizeNotionId(p.id);
    const preSeeded = t.pages.has(id); // reRender 로 선큐잉된 페이지 — 스킵 판정은 건너뛰되 북키핑은 수행(리뷰)
    const led = ledger.byId.get(id);
    const live = String(p.last_edited_time ?? "");
    if (!preSeeded) {
      // 원장 일치 스킵 — 단, 노션 last_edited 는 분 절사라 '적재가 그 분 안에서 일어난' 행은 같은 분의
      //  재편집이 문자열 동등 뒤에 숨는다(리뷰) → 적재 시각이 편집 분의 끝(+60s)을 지난 행만 스킵.
      const settled = led?.syncedAt && led.lastEdited
        ? Date.parse(led.syncedAt) - Date.parse(led.lastEdited) >= 60_000 : false;
      if (led && led.lifecycle === "active" && led.lastEdited === live && settled) { c.skipped++; continue; }
      if (!(await inScope(t, id, asRec(p.parent)))) { c.outOfScope++; continue; }
    }
    const node = pageNode(t, id);
    if (!node.page) node.page = p;
    node.forceChanged = true;
    // 무제 문서는 저장 제목이 플레이스홀더('(제목 없음)') — 원문 '' 와 그대로 비교하면 매 편집이 개명 오탐(리뷰).
    const renamed = led != null && led.title !== (titleOfPage(p) || "(제목 없음)");
    const ptype = String(asRec(p.parent).type ?? "");
    if (ptype === "data_source_id" || ptype === "database_id") {
      const rawPid = normalizeNotionId(String(asRec(p.parent).data_source_id ?? asRec(p.parent).database_id ?? ""));
      const dbId = ptype === "database_id" ? rawPid : dsOwnerDb(t, rawPid);
      if (dbId) {
        node.parentOverride = dbId;
        node.isDbRow = true;
        // 신규/개명/타 DB 에서 이동/복원 행 — 소유 DB 본문(항목 목록)·행 순서가 스테일 → DB 재수집.
        if (!led || renamed || led.parentExt !== dbId || led.lifecycle !== "active") reRender(dbId);
      }
      c.rows++;
    } else {
      // 개명 — 부모 본문의 child_page 제목 캐시 재렌더.
      if (renamed) reRender(led!.parentExt);
      c.pages++;
    }
    // 개명 — 이 페이지를 본문에서 참조(멘션·링크)하는 페이지들의 제목 캐시도 스테일 → 역링크 재렌더.
    //  (독립 검증기가 잡은 유일 실패 축 — full 대기 없이 델타에서 즉시 수렴)
    if (renamed) for (const src of ledger.backlinks.get(id) ?? []) reRender(src);
    if (led && led.parentExt) {
      // 이동 — 이전 부모의 children_order/본문에서 이 페이지가 빠졌어야 함(이전 부모도 보통 델타에 잡히지만 벨트+멜빵).
      const curParent = node.parentOverride
        ?? (ptype === "page_id" ? normalizeNotionId(String(asRec(p.parent).page_id ?? "")) : null);
      if (curParent && curParent !== led.parentExt) reRender(led.parentExt);
    }
  }

  console.error(`[notion] 델타 — 후보 페이지 ${c.pages}·행 ${c.rows}·DB ${c.dbs} · 원장일치 스킵 ${c.skipped} · DB스킵 ${c.skippedDbs} · 범위밖 ${c.outOfScope} · 스캔 ${c.scanned} (원장 ${ledger.byId.size})`);
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
    return dsOwnerDb(t, normalizeNotionId(p.data_source_id));
  }
  if (p.type === "block_id" && p.block_id) {
    return (await resolveBlockOwnerPage(t, p.block_id)) ?? undefined;
  }
  return undefined; // workspace 루트
}

// DB 의 트리 부모 — 증분에서 parentOverride(블록트리 발견)가 없어도 page/block/data_source 부모를 해소해
//  기존 parent_name 을 NULL 로 클로버하지 않게 한다(인라인 DB 가 컬럼/토글 안에 있으면 parent.type='block_id').
async function dbParentExternalId(t: Traversal, db: NotionDatabase): Promise<string | undefined> {
  const p = db.parent;
  if (!p) return undefined;
  if (p.type === "page_id" && p.page_id) return normalizeNotionId(p.page_id);
  if (p.type === "database_id" && p.database_id) return normalizeNotionId(p.database_id);
  if (p.type === "data_source_id" && p.data_source_id) return dsOwnerDb(t, normalizeNotionId(p.data_source_id));
  if (p.type === "block_id" && p.block_id) return (await resolveBlockOwnerPage(t, p.block_id)) ?? undefined;
  return undefined; // workspace
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
      const viaDs = dsOwnerDb(t, id);
      const target = viaDs ?? id;
      const pn = t.pages.get(target);
      if (pn?.page) return { name: unitName("notion", target), title: titleOfPage(pn.page) || null };
      const dn = t.dbs.get(target);
      if (dn?.db) return { name: unitName("notion", target), title: titleOfDb(dn.db) || null };
      // 델타(#586) — 이번 run 이 안 건드린 미변경 대상은 원장으로 해소(링크·제목이 델타에서도 끊기지 않게).
      //  활성만: archived 를 해소하면 full 렌더(트래버스 미포함=null)와 어긋나 본문이 모드 따라 왕복(리뷰).
      //  이번 run 실패 노드(page/db null)는 원장 제목이 있으면 그걸 우선(실패가 제목을 가리지 않게).
      const led = t.ledger?.byId.get(target);
      if (led?.lifecycle === "active") return { name: unitName("notion", target), title: led.title || null };
      if (pn || dn) return { name: unitName("notion", target), title: null };
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
      else if (asRec(f.file).url) { url = String(asRec(f.file).url); expiring = true; } // 댓글 첨부 {category, file:{url}} — type 필드 없음
      else if (asRec(f.external).url) url = String(asRec(f.external).url);
      else if (typeof f.url === "string") url = f.url;
      if (!url) return null;
      if (!expiring) return url; // external — 만료 없음, 원본 유지
      const fname = assetFileName({ ...hint, pageId: ownerId }, url);
      if (!t.assetJobs.has(fname)) {
        const expiry = String(asRec(f.file).expiry_time ?? "") || undefined;
        t.assetJobs.set(fname, { url, file: fname, blockId: hint.blockId, pageId: ownerId, kind: hint.kind, expiry });
      }
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

function iconValue(icon: Rec | null | undefined, ctx?: NotionMdCtx): unknown {
  if (!icon) return null;
  if (icon.type === "emoji") return icon.emoji ?? null;
  // 파일형/커스텀 이모지 아이콘 — 업로드형은 1시간 만료 URL 이라 자산으로 다운로드해 영구 참조로 치환.
  const url = ctx ? ctx.assetUrl(icon, { kind: "icon" }) : null;
  return url ? { type: icon.type ?? "file", url } : icon;
}

function linksArray(t: Traversal, links: Map<string, string>): Array<{ target_external_id: string; target_name: string; kind: string }> {
  return [...links.entries()]
    .filter(([, kind]) => kind !== "child") // 자식 엣지는 트리(parent_name)가 진실 — 링크 그래프에 중복 물질화하지 않음
    .filter(([id]) => {
      if (t.pages.has(id) || t.dbs.has(id) || t.dsToDb.has(id)) return true;
      // 델타 — 미변경 대상은 원장으로 유지(링크 유실 방지). 활성만: archived 는 full 렌더와의 결정성(리뷰).
      const tgt = t.ledger?.dsToDb.get(id) ?? id;
      return t.ledger?.byId.get(tgt)?.lifecycle === "active";
    })
    .map(([id, kind]) => {
      const target = dsOwnerDb(t, id) ?? id;
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
        icon: iconValue(page.icon as Rec | null, ctx),
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
  if (node.unsupported) {
    parts.push([
      ":::callout icon=ℹ️",
      "연결된 데이터베이스 보기(linked view)라 노션 API 가 행 조회를 지원하지 않습니다 — 원본 데이터베이스가 공유 범위에 있으면 내용은 그쪽 노드로 수집됩니다.",
      ":::",
    ].join("\n"));
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
        icon: iconValue(db.icon as Rec | null, ctx),
        is_inline: db.is_inline ?? false,
        unsupported: node.unsupported || undefined, // linked 뷰 — 행 조회 API 미지원(한계 고지)
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
  const sinceRaw = opts?.since ? Date.parse(opts.since) : undefined;
  const ledger = (opts?.ledger ?? null) as NotionLedger | null;
  // 델타 증분(#586) — since + 미러 원장이 있으면 search 델타로 변경분만 수집(루트/서치 모드 공통).
  //  원장이 없으면(첫 run·미러 유실) 전체 트래버스로 안전 폴백. 루트 모드에서 원장 없는 증분도 전체
  //  트래버스(발견이 트래버스뿐이라 since 스킵 시 미변경 조상 아래 변경을 영영 못 봄 — 기존 시맨틱).
  const delta = Boolean(sinceRaw !== undefined && Number.isFinite(sinceRaw) && ledger?.byId.size);
  // 가속 full(#586) — full(since 없음)이라도 원장이 있으면 미변경 페이지의 무거운 수집을 생략(관측은 기록).
  //  발견은 BFS 그대로라 full 의 완전성(스윕 근거)이 유지된다 — 어니스트 스케일 실측 125분 → 수십 분 기대.
  const fastFull = Boolean(!delta && ledger?.byId.size);
  const sinceMs = delta ? sinceRaw : (cfg.rootIds.length ? undefined : sinceRaw);
  if (cfg.rootIds.length && opts?.since && !delta) console.error("[notion] 루트 모드 — 원장 없음, 증분(since) 무시하고 전체 트래버스");
  const ledgerChildren = new Map<string, string[]>();
  if ((delta || fastFull) && ledger) {
    for (const [cid, led] of ledger.byId) {
      // 행(db_row)은 소유 DB 나열이 무료로 관측 — 원장 자식 큐잉에서 제외(행별 1req 낭비 방지).
      if (!led.parentExt || led.lifecycle !== "active" || led.kind === "db_row") continue;
      const arr = ledgerChildren.get(led.parentExt);
      if (arr) arr.push(cid); else ledgerChildren.set(led.parentExt, [cid]);
    }
  }
  const t: Traversal = {
    cfg,
    sinceMs,
    ledger: delta || fastFull ? ledger : null,
    fastFull,
    ledgerChildren,
    membership: new Map(),
    excluded: new Map(),
    commentsDenied: false,
    pages: new Map(), dbs: new Map(), dsToDb: new Map(), users: new Map(),
    assetJobs: new Map(),
    stats: { pages: 0, databases: 0, emitted: 0, failures: 0, failedIds: [], inaccessible: 0, inaccessibleIds: [], retryIds: [], unattributed: 0, observedIds: [], assets: 0, assetFailures: 0, requests: 0 },
  };
  lastRunStats = t.stats;

  // 생존 티커 — 어떤 페이즈든 120초마다, 단 **요청 카운터가 실제로 늘었을 때만** 신호를 남긴다.
  //  무조건 찍으면 진짜 행(fetch 정지)에도 살아있는 척이 되어 정체 감지가 무력화된다 — 진행 없으면 침묵을
  //  유지해 run-tracker(15분 무출력=킬)가 행을 잡게 한다. 오탐(정상인데 침묵)은 이 티커+완료 로그가 제거.
  let lastTickReq = -1;
  const ticker = setInterval(() => {
    if (reqCount === lastTickReq) return; // 무진전 — 침묵(정체 감지 존중)
    lastTickReq = reqCount;
    console.error(`[notion] 진행중 — 요청 ${reqCount} · 페이지 ${t.pages.size} · DB ${t.dbs.size} · 첨부 ${t.stats.assets}/${t.assetJobs.size}`);
  }, 120_000);
  try {

  if (delta) await discoverDelta(t, sinceRaw!);
  else await discoverSeeds(t);
  if (fastFull) console.error(`[notion] 가속 full — 원장 ${ledger!.byId.size}건 대조(미변경은 1req 관측·첨부 실재 검사)`);

  // 이전 run 의 귀속 실패 재시도(#586) — 커서는 전진했지만 이 항목들은 미완(자산 등). 강제 재수집으로 자가치유.
  const retrySeeds = [...new Set((opts?.retryIds ?? []).filter((rid) => typeof rid === "string" && rid.length === 36))];
  for (const rid of retrySeeds) {
    const led = ledger?.byId.get(rid);
    if (led?.kind === "database") { dbNode(t, rid); continue; }
    const n = pageNode(t, rid);
    n.forceChanged = true;
    if (led?.kind === "db_row") n.isDbRow = true;
  }
  if (retrySeeds.length) console.error(`[notion] 재시도 시딩 — 이전 run 실패 ${retrySeeds.length}건`);

  // BFS — 맵이 자라는 동안 반복(새 발견 노드 처리). 처리 표식으로 순환 없이 수렴.
  const donePages = new Set<string>();
  const doneDbs = new Set<string>();
  console.error(`[notion] 발견 — 페이지 ${t.pages.size} · DB ${t.dbs.size} (트래버스로 추가 발견될 수 있음)`);
  // 페이지는 서로 독립이라 라운드별 워커 풀로 병렬 수집(전역 rate 슬롯이 총 rps 를 지배 — 응답 지연만 숨김).
  //  DB 는 행 순서 결정성(생성순 나열)을 위해 직렬 유지. 맵 확장(BFS 발견)은 라운드 재스캔으로 수렴.
  const pagePool = async (nodes: PageNode[]): Promise<void> => {
    const iter = nodes[Symbol.iterator]();
    // 진행 로그는 **완료 수** 기준(#586 박스 실배포 교훈): 라운드 시작에 done 마킹을 일괄로 하므로
    //  donePages.size 는 라운드 중 불변 — 그걸 기준 삼으면 큰 라운드(수백 페이지·수십 분)가 통째로 침묵해
    //  정체 감지(15분 무출력=킬)가 멀쩡한 run 을 죽인다.
    const already = donePages.size - nodes.length;
    let processed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const nx = iter.next();
        if (nx.done) return;
        await processPage(t, nx.value);
        processed++;
        if (processed % 20 === 0 || processed === nodes.length) {
          console.error(`[notion] 진행 — 페이지 ${already + processed}/${t.pages.size} 수집 · 실패 ${t.stats.failures} · 요청 ${reqCount}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, nodes.length) }, worker));
  };
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, node] of [...t.dbs]) {
      if (doneDbs.has(id)) continue;
      doneDbs.add(id);
      progressed = true;
      await processDb(t, node);
      if (doneDbs.size % 10 === 0 || doneDbs.size === t.dbs.size) {
        console.error(`[notion] 진행 — DB ${doneDbs.size}/${t.dbs.size} 수집`);
      }
    }
    const pending: PageNode[] = [];
    for (const [id, node] of [...t.pages]) {
      if (donePages.has(id)) continue;
      donePages.add(id);
      pending.push(node);
    }
    if (pending.length) {
      progressed = true;
      await pagePool(pending);
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
    const parentExtId = node.parentOverride ?? (await dbParentExternalId(t, node.db));
    try { yield emitDb(t, node, parentExtId); }
    catch (err) {
      node.failed = true; t.stats.failures++; t.stats.failedIds.push(node.id); t.stats.retryIds.push(node.id);
      console.error(`[notion] DB 방출 실패 ${node.id}:`, (err as Error)?.message ?? err);
    }
  }
  for (const node of t.pages.values()) {
    if (node.failed || !node.changed || !node.page) continue;
    try {
      const parentExtId = await parentExternalIdOf(t, node);
      yield emitPage(t, node, parentExtId);
    } catch (err) {
      node.failed = true; t.stats.failures++; t.stats.failedIds.push(node.id); t.stats.retryIds.push(node.id);
      console.error(`[notion] 페이지 방출 실패 ${node.id}:`, (err as Error)?.message ?? err);
    }
  }

  // 자산 다운로드 — 방출 후 일괄(중복 제거됨). 실패는 assetFailures + failures(커서 동결 → 다음 run 재시도).
  //  디렉토리 선검사: 권한 문제(EACCES)는 파일마다 반복 실패시키지 말고 한 번에 명확한 처방으로 알린다.
  if (t.assetJobs.size) {
    try {
      fs.mkdirSync(cfg.assetDir, { recursive: true });
    } catch (err) {
      t.stats.assetFailures += t.assetJobs.size;
      t.stats.failures += t.assetJobs.size;
      for (const j of t.assetJobs.values()) { if (j.pageId) t.stats.retryIds.push(j.pageId); else t.stats.unattributed++; }
      console.error(`[notion] 첨부 파일 디렉토리 생성 불가 ${cfg.assetDir}: ${(err as Error)?.message ?? err}`
        + ` — 앱 디렉토리에서 'sudo chown -R $(whoami) data' 로 소유권을 서비스 유저로 바꾸면 다음 run 이 재수집합니다(커서 동결로 유실 없음)`);
      t.assetJobs.clear();
    }
  }
  for (const job of t.assetJobs.values()) {
    try {
      await downloadAsset(t, job, cfg.assetDir);
      t.stats.assets++;
    } catch (err) {
      t.stats.assetFailures++;
      t.stats.failures++;
      if (job.pageId) t.stats.retryIds.push(job.pageId); else t.stats.unattributed++;
      console.error(`[notion] 첨부 파일 다운로드 실패 ${job.file}:`, (err as Error)?.message ?? err);
    }
  }

  t.stats.requests = reqCount;
  console.error(`[notion] 수집 완료 — 페이지 ${t.stats.pages} · DB ${t.stats.databases} · 방출 ${t.stats.emitted} · 실패 ${t.stats.failures} · 접근불가 ${t.stats.inaccessible} · 첨부 ${t.stats.assets}(실패 ${t.stats.assetFailures}) · 요청 ${t.stats.requests}`);

  } finally {
    clearInterval(ticker); // 소비자 조기 종료(return/throw) 포함 — 티커 누수 방지
  }
}

export const notionConnector: Connector = {
  name: "notion",
  backfill,
  // #837 — 사람 매핑 후보. Notion `GET /v1/users`(페이지네이션). 봇·미확인은 제외(사람 매핑 대상이 아니다).
  //  이미 hydrateUsers 가 개별 `/users/{id}` 를 부르고 있었다 — 여기선 전체 목록을 한 번에 받는다.
  async listUsers(): Promise<ConnectorUser[]> {
    const cfg = await loadConfig();
    const out: ConnectorUser[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ page_size: "100" });
      if (cursor) qs.set("start_cursor", cursor);
      const res = (await notionFetch(cfg, `/users?${qs.toString()}`)) as
        { results?: NotionUser[]; next_cursor?: string | null; has_more?: boolean };
      for (const u of res.results ?? []) {
        if (!u?.id || u.type === "bot") continue;
        out.push({ id: u.id, name: u.name ?? null, email: u.person?.email ?? null, instance: cfg.instance || null });
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return out;
  },
};

// 테스트 훅 — 자산 재발급(만료 URL 치유) 경로의 결정적 검증용. 프로덕션 코드에서 사용 금지.
export const __assetTestables = { downloadAsset, refreshAssetUrl, findUrlByPath };
// 테스트 훅 — 제외 서브트리 판정(원장 조상 워크·직접 id·memo)·델타 DB 재수집 판정. 프로덕션 코드에서 사용 금지.
export const __scopeTestables = { underExcluded, dbDeltaShouldCollect };
