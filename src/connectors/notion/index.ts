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
import type { Connector, RawItem, BackfillOpts, ConnectorUser } from "../types.js";
import type { NotionUser } from "../notion-types.js";
import type { NotionLedger } from "../../v6/connector-mirror.js"; // type-only — 런타임 의존 없음(원장은 run-sync 가 주입)
import { loadConfig, notionFetch, reqCount, resetReqCount } from "./client.js";
import { downloadAsset, findUrlByPath, refreshAssetUrl } from "./assets.js";
import { dbNode, pageNode } from "./state.js";
import type { NotionRunStats, PageNode, Traversal } from "./state.js";
import { discoverSeeds, hydrateUsers, processDb, processPage } from "./traverse.js";
import {
  dbDeltaShouldCollect, dbParentExternalId, discoverDelta, parentExternalIdOf, underExcluded,
} from "./scope.js";
import { emitDb, emitPage } from "./emit.js";
import { notionPostSync, prepareNotionSync } from "./sync.js";

// 배럴 — 구 notion.ts 의 export 집합을 그대로 재수출(소비자 import 무수정).
export { loadNotionConfig, notionCreateDatabase, notionCreatePage, notionRetrieveDatabase, notionUpdatePage } from "./client.js";
export type { NotionConfig } from "./client.js";
export type { NotionRunStats } from "./state.js";

const PAGE_CONCURRENCY = 4;  // 페이지 수집 병렬도 — 슬롯이 전역이라 총 rps 는 불변, 응답 지연만 숨긴다(#586)

// ── 백필: collect(BFS) → hydrate users → 방출 → 자산 다운로드 ─────────────────
//  onStats: 이 run 의 통계를 커넥터 인스턴스에 게시(#1313 R44 — 구 모듈 전역 lastRunStats 대체).
//   트래버설 생성 직후 즉시 호출하므로, 소비자는 스트림이 중간에 끊겨도 그 시점까지의 실패를 본다(구 동작 보존).
async function* backfill(opts?: BackfillOpts, onStats?: (s: NotionRunStats) => void): AsyncIterable<RawItem> {
  const cfg = await loadConfig();
  resetReqCount(); // 구 `reqCount = 0`(모듈 내부 대입) — client.ts 분리로 호출 대체(#1313 R22)
  const sinceRaw = opts?.since ? Date.parse(opts.since) : undefined;
  const ledger = (opts?.ledger ?? null) as NotionLedger | null;
  // 델타 증분(#586) — since + 미러 원장이 있으면 search 델타로 변경분만 수집(루트/서치 모드 공통).
  //  원장이 없으면(첫 run·미러 유실) 전체 트래버스로 안전 폴백. 루트 모드에서 원장 없는 증분도 전체
  //  트래버스(발견이 트래버스뿐이라 since 스킵 시 미변경 조상 아래 변경을 영영 못 봄 — 기존 시맨틱).
  const delta = Boolean(sinceRaw !== undefined && Number.isFinite(sinceRaw) && ledger?.byId.size);
  // 가속 full(#586) — full(since 없음)이라도 원장이 있으면 미변경 페이지의 무거운 수집을 생략(관측은 기록).
  //  발견은 BFS 그대로라 full 의 완전성(스윕 근거)이 유지된다 — 고객사 A 스케일 실측 125분 → 수십 분 기대.
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
    stats: { instance: cfg.instance, pages: 0, databases: 0, emitted: 0, failures: 0, failedIds: [], inaccessible: 0, inaccessibleIds: [], retryIds: [], unattributed: 0, observedIds: [], assets: 0, assetFailures: 0, requests: 0 },
  };
  onStats?.(t.stats);

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

// #837 — 사람 매핑 후보. Notion `GET /v1/users`(페이지네이션). 봇·미확인은 제외(사람 매핑 대상이 아니다).
//  이미 hydrateUsers 가 개별 `/users/{id}` 를 부르고 있었다 — 여기선 전체 목록을 한 번에 받는다.
async function listUsers(): Promise<ConnectorUser[]> {
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
}

// ── 커넥터 인스턴스(#1313 R44) — 실행 통계를 **인스턴스가 소유**한다. ─────────────
//  구조: 구 모듈 전역 `lastRunStats` + `getNotionRunStats()` 익스포트(= run-sync 가 이름으로 끌어가던 암묵 계약)를
//   클로저 + SPI 훅으로 대체. backfill 이 통계를 게시하고, runStats()/postSync 가 같은 접근자로 읽는다 —
//   '누가 언제 읽는가'가 인터페이스에 드러나고, 오케스트레이터는 notion 을 몰라도 된다.
function createNotionConnector(): Connector {
  let stats: NotionRunStats | null = null;
  const runStats = (): NotionRunStats | null => stats;
  return {
    name: "notion",
    backfill: (opts?: BackfillOpts) => backfill(opts, (s) => { stats = s; }),
    prepareSync: prepareNotionSync,
    runStats,
    postSync: (ctx) => notionPostSync(ctx, runStats()),
    listUsers,
  };
}

export const notionConnector: Connector = createNotionConnector();

// 테스트 훅 — 자산 재발급(만료 URL 치유) 경로의 결정적 검증용. 프로덕션 코드에서 사용 금지.
export const __assetTestables = { downloadAsset, refreshAssetUrl, findUrlByPath };
// 테스트 훅 — 제외 서브트리 판정(원장 조상 워크·직접 id·memo)·델타 DB 재수집 판정. 프로덕션 코드에서 사용 금지.
export const __scopeTestables = { underExcluded, dbDeltaShouldCollect };
