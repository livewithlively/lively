// Notion 트래버설 상태(#1313 R22 분할 — 구 notion.ts 52-66·320-398·1102-1114).
//  한 run 의 수집 상태(Traversal)와 그 위의 순수 접근자만 — 네트워크 의존 0(런타임 import 없음).
//  scope·traverse·emit·index 가 공유하는 바닥 계층이라 여기서 위쪽(수집/방출)을 참조하지 않는다.
import type {
  NotionBlock, NotionComment, NotionDatabase, NotionDataSource,
  NotionPage, NotionRichText, NotionUser,
} from "../notion-types.js";
import type { NotionConfig } from "./client.js";
import type { AssetJob } from "./assets.js";
import type { NotionLedger } from "../../v6/connector-mirror.js"; // type-only — 런타임 의존 없음(원장은 run-sync 가 주입)

// ── 실행 통계 — run-sync 가 커서 동결/스윕 판단에 사용 ─────────────────────────
export interface NotionRunStats {
  /** 이 run 이 스탬프한 external_instance(#1881 다중 워크스페이스). 후처리(스윕·대사)의 범위 축이다 —
   *  emit 이 쓰는 `cfg.instance` **그 값 그대로** 실어 보낸다(재조회하면 둘이 어긋날 수 있고, 어긋나면
   *  스윕이 남의 워크스페이스를 아카이브하거나 자기 것을 통째로 아카이브한다). */
  instance: string;
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

// ── 트래버설 노드 ─────────────────────────────────────────────────────────────
export interface PageNode {
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
export interface DbNode {
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

export interface Traversal {
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
export function dsOwnerDb(t: Traversal, dsId: string): string | undefined {
  return t.dsToDb.get(dsId) ?? t.ledger?.dsToDb.get(dsId);
}

export function pageNode(t: Traversal, id: string): PageNode {
  let n = t.pages.get(id);
  if (!n) {
    n = { id, page: null, blocks: null, comments: [], propertyItems: {}, parentOverride: null, sort: null, childrenOrder: [], changed: true, isDbRow: false, failed: false };
    t.pages.set(id, n);
  }
  return n;
}
export function dbNode(t: Traversal, id: string): DbNode {
  let n = t.dbs.get(id);
  if (!n) {
    n = { id, db: null, dataSources: [], rowIds: [], parentOverride: null, sort: null, failed: false, unsupported: false };
    t.dbs.set(id, n);
  }
  return n;
}

export function isChanged(t: Traversal, lastEdited: string | undefined): boolean {
  if (t.sinceMs == null) return true;
  const ms = lastEdited ? Date.parse(lastEdited) : NaN;
  return !Number.isFinite(ms) || ms >= t.sinceMs;
}

// ── 제목 해소 — 방출·델타(개명 판정) 공용 ─────────────────────────────────────
export function titleOfPage(page: NotionPage | null): string {
  if (!page?.properties) return "";
  for (const v of Object.values(page.properties)) {
    if (v?.type === "title" && Array.isArray(v.title)) {
      const s = (v.title as NotionRichText[]).map((rt) => rt.plain_text ?? "").join("").trim();
      if (s) return s;
    }
  }
  return "";
}
export function titleOfDb(db: NotionDatabase | null): string {
  return (db?.title ?? []).map((rt) => rt.plain_text ?? "").join("").trim();
}
