// Notion 스코프 판정·델타 발견(#1313 R22 분할 — 구 notion.ts 47-50·827-936·938-1099).
//  '무엇을 수집 대상으로 볼지'를 정하는 계층: 부모 체인 해소 → 제외 서브트리/루트 스코프 판정 → 델타 후보 시딩.
//  실제 수집(블록/댓글/속성 fetch)은 traverse.ts 가 한다.
import { normalizeNotionId } from "../notion-md.js";
import type { NotionDatabase, NotionDataSource, NotionPage } from "../notion-types.js";
import type { NotionLedgerEntry } from "../../v6/connector-mirror.js"; // type-only — 런타임 의존 없음
import { asRec, notionFetch, paginate, PAGE_SIZE } from "./client.js";
import type { Rec } from "./client.js";
import { dbNode, dsOwnerDb, pageNode, titleOfPage } from "./state.js";
import type { PageNode, Traversal } from "./state.js";

// 델타 증분(#586) 인덱싱 지연 안전창 — 노션 search 는 eventually-consistent 라 방금 편집분이 늦게 인덱싱될 수 있다.
//  커서보다 이만큼 과거까지 스캔하되, 원장(last_edited 동등) 대조로 기수집분은 0비용 스킵 → 지연이 이 창 안이면 유실 없음.
//  창을 넘는 지연·댓글 단독 변경·멘션 제목 캐시는 일일 full 스윕이 수렴(완결성의 최종 담보는 언제나 full).
const DELTA_LOOKBACK_MS = 72 * 3_600_000;

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
export async function underExcluded(t: Traversal, id: string, seedParentExt?: string | null): Promise<boolean> {
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

// ── 델타 증분(#586) — search(last_edited desc) + 원장 대조로 변경분만 수집. ─────
//  비용이 워크스페이스 크기가 아니라 **변경량에 비례**한다:
//   · 페이지/행: 정렬 search 를 since-LOOKBACK 까지만 스캔, 원장 last_edited 동등이면 0비용 스킵.
//   · DB: data_source 나열(~N/100 req)로 스키마 변경·신규만 재수집 — linked 뷰(ds 없음)는 비용 0.
//   · 신규/이동/복원은 원장 불일치로, 자식 추가·재정렬은 부모 last_edited 갱신으로 잡힌다(노션 시맨틱).
//  안 잡히는 것(댓글 단독 변경·타 페이지 멘션의 제목 캐시·아카이브 전파·LOOKBACK 초과 인덱싱 지연)은
//  일일 full 스윕이 수렴 — 증분은 빠른 수렴 경로, 완결성의 담보는 full 이라는 기존 불변식 유지.

/** 델타에서 이 DB(data_source 관측)를 재수집할지 — **알려진 활성 DB + 스키마 변경 positive evidence** 일 때만 true.
 *  전 워크스페이스엔 data_source 가 수백~수천(대부분 linked 뷰·인라인 표)일 수 있고 대부분 미러에 안 남는다 →
 *  모르는(led 없음)·비활성·비-DB·미변경은 재수집 금지(매 증분 재수집이면 비용 붕괴). 신규 top-level DB·놓친 스키마
 *  변경은 일일 full 이 수렴하고, 신규 인라인 DB 는 부모 페이지 델타→discoverChildren 로 잡힌다(그 경로 불변). */
export function dbDeltaShouldCollect(led: NotionLedgerEntry | undefined, live: string): boolean {
  if (!led || led.kind !== "database" || led.lifecycle !== "active") return false; // 모름/비활성/비-DB
  if (!led.dsEdited || !live || live <= led.dsEdited) return false;                 // 미변경/비교 불가(응답 드리프트) — 스킵
  return true;
}

/** 델타 발견 — 후보를 t.pages/t.dbs 에 시딩. 이후 BFS·방출은 full 과 동일 경로(코드 분기 최소화). */
export async function discoverDelta(t: Traversal, sinceMs: number): Promise<void> {
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
  //  수백~수천이면 매 증분이 그 전부를 inScope 워크+재수집했다(고객사 A 실박스: 알려진 8 vs 발견 838 → 증분 30분+,
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

// 페이지의 트리 부모 external id — 트래버스 override 우선, 없으면 page.parent 매핑.
export async function parentExternalIdOf(t: Traversal, node: PageNode): Promise<string | undefined> {
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
export async function dbParentExternalId(t: Traversal, db: NotionDatabase): Promise<string | undefined> {
  const p = db.parent;
  if (!p) return undefined;
  if (p.type === "page_id" && p.page_id) return normalizeNotionId(p.page_id);
  if (p.type === "database_id" && p.database_id) return normalizeNotionId(p.database_id);
  if (p.type === "data_source_id" && p.data_source_id) return dsOwnerDb(t, normalizeNotionId(p.data_source_id));
  if (p.type === "block_id" && p.block_id) return (await resolveBlockOwnerPage(t, p.block_id)) ?? undefined;
  return undefined; // workspace
}
