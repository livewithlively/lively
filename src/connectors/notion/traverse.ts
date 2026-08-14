// Notion BFS 수집 계층(#1313 R22 분할 — 구 notion.ts 45-46·400-825).
//  발견(루트/자식)과 무거운 수집(블록 트리·속성 페이지네이션·사용자·댓글)을 담당. 수집 대상 여부 판정은
//  scope.ts, 방출(RawItem 변환)은 emit.ts.
import fs from "node:fs";
import path from "node:path";
import { normalizeNotionId } from "../notion-md.js";
import type {
  NotionBlock, NotionComment, NotionDatabase, NotionDataSource, NotionPage, NotionUser,
} from "../notion-types.js";
import { asArr, asRec, notionFetch, paginate, PAGE_SIZE, sleep } from "./client.js";
import type { Rec } from "./client.js";
import { dbNode, dsOwnerDb, isChanged, pageNode } from "./state.js";
import type { DbNode, PageNode, Traversal } from "./state.js";
import { underExcluded } from "./scope.js";
import { isInvalidCredential, allScopedRootsFailed } from "../failure-class.js";

const MAX_BLOCK_DEPTH = 64; // 순환 방지 가드(정상 문서는 도달 불가 — 구버전의 '깊이 5 절단'과 달리 손실 아님)
const PAGE_FETCH_RETRY = 2; // 페이지 단위 재시도(블록 트리 등) — 그 후 실패는 failures 로 집계(미방출)

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

export async function hydrateUsers(t: Traversal, roots: unknown[]): Promise<void> {
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
export async function processPage(t: Traversal, node: PageNode): Promise<void> {
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

export async function processDb(t: Traversal, node: DbNode): Promise<void> {
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
export async function discoverSeeds(t: Traversal): Promise<void> {
  if (t.cfg.rootIds.length) {
    // ⚠ 여기가 **"0건입니다"로 위장되던 자리**다(#1631 실측). 루트 접근 실패를 항목 하나의 실패로 집계하고
    //  조용히 넘어가면, 토큰이 무효여도 호출부는 정상 종료를 보고 `{"ok":true,"sample":[]}` 를 돌려준다.
    //  사람은 "아직 아무것도 안 들어왔네"로 읽고 진짜 이유를 영영 못 듣는다(페르소나가 이탈한 자리).
    //  그래서 두 경우는 **던진다**: ① 자격 자체가 무효(401) ② 지정한 범위가 통째로 실패.
    let failedRoots = 0;
    for (const id of t.cfg.rootIds) {
      try {
        const p = (await notionFetch(t.cfg, `/pages/${id}`)) as NotionPage;
        pageNode(t, normalizeNotionId(p.id)).page = p;
      } catch (first) {
        // 토큰이 무효면 database 로 재시도해도 같은 401 이다 — 요청만 낭비하고 원인은 그대로 묻힌다.
        if (isInvalidCredential(first)) throw first;
        try {
          const d = (await notionFetch(t.cfg, `/databases/${id}`)) as NotionDatabase;
          dbNode(t, normalizeNotionId(d.id)).db = d;
        } catch (err) {
          if (isInvalidCredential(err)) throw err;
          failedRoots++;
          t.stats.failures++;
          t.stats.unattributed++; // 발견 자체 실패 — 귀속 재시도 불가, 커서 동결 유지
          t.stats.failedIds.push(id);
          console.error(`[notion] 루트 ${id} 접근 실패(page/database 둘 다 아님):`, (err as Error)?.message ?? err);
        }
      }
    }
    // 401 이 아니어도(403 미연결 · 404 오타 id) **지정한 게 전부 안 잡히면 가져올 것이 없다** — 성공이 아니다.
    if (allScopedRootsFailed(t.cfg.rootIds.length, failedRoots)) {
      throw new Error(
        `지정한 노션 페이지 ${t.cfg.rootIds.length}개에 전부 접근하지 못했습니다. ` +
        `노션에서 그 페이지의 ⋯ ▸ 연결(Connections)로 이 통합을 추가했는지, 페이지 주소가 맞는지 확인해 주세요. ` +
        `(실패: ${t.stats.failedIds.slice(0, 5).join(", ")})`);
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
