// Notion HTTP 클라이언트(#1313 R22 분할 — 구 notion.ts 38-44·70-217).
//  커넥터 전 계층이 쓰는 유일한 네트워크 표면: config 해석 + 인증/버전 헤더 + rate limit 슬롯 + 커서 페이지네이션,
//  그리고 #976 아웃바운드(위키 투영) 공개 표면. 트래버스/방출 계층은 여기 말고 노션을 직접 부르지 않는다.
import { stateDir } from "../../ops/state-dir.js";
import { resolveConnectorConfig } from "../config.js";
import { parseNotionRootId } from "../notion-md.js";
import type { NotionListResponse } from "../notion-types.js";

// ── 상수 ───────────────────────────────────────────────────────────────────
const API_BASE = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2025-09-03"; // data_source 분리 버전(멀티소스 DB 대응) — NOTION_API_VERSION 로 오버라이드
export const PAGE_SIZE = 100; // search/children/query/comments 공통 최대 페이지 크기
const REQ_INTERVAL_MS = 340; // 자발적 스로틀(~2.9 req/s 슬롯) — rate limit 선제 회피
const MAX_RETRY = 5; // 429/529/5xx 재시도 횟수

// ── 작은 유틸 ───────────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export type Rec = Record<string, unknown>;
export const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface NotionConfig {
  token: string; instance: string; version: string;
  rootIds: string[]; excludeIds: string[]; comments: "page" | "all" | "off"; assetDir: string;
}

export async function loadConfig(): Promise<NotionConfig> {
  const c = await resolveConnectorConfig("notion");
  if (!c.token) throw new Error("Notion 토큰이 없습니다 — [외부 앱 연결 ▸ Notion ▸ 팀 자료로 모으기]로 연결하거나, Notion integration 토큰(ntn_/secret_…)을 설정하세요(관리탭 또는 .env)");
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

/**
 * external_instance 스탬프 값만 — **토큰 없이** 구한다(#1881 다중 워크스페이스).
 *  왜 loadConfig 를 안 쓰나: 원장 로드는 backfill **전에** 돌고, loadConfig 는 토큰이 없으면 던진다.
 *  범위 축만 필요한 자리(원장)에서 토큰 부재로 실패하면 폴백이 '전 워크스페이스 원장'이 돼 더 나쁘다.
 *  값 산출은 loadConfig 와 **한 줄로 동일**해야 한다(`c.instance || "default"`) — 어긋나면 범위가 갈린다.
 */
export async function resolveNotionInstance(): Promise<string> {
  const c = await resolveConnectorConfig("notion");
  return c.instance || "default";
}

// ── HTTP 호출(인증/버전 헤더 + rate limit 존중 + 자발적 스로틀) ───────────────
//  전역 슬롯 방식(#586 속도개선): 요청 '시작 시각'을 REQ_INTERVAL_MS 간격의 슬롯으로 직렬화하되,
//  응답 대기는 겹친다(동시 in-flight) — 직렬 구현은 응답 지연만큼 실효 속도가 3rps 아래로 떨어졌다(~2rps).
//  병렬 워커(PAGE_CONCURRENCY)와 결합하면 노션 공식 한도(평균 3req/s)에 실효로 붙는다.
let nextSlotAt = 0;
export let reqCount = 0;
/** 요청 카운터 리셋 — 구 backfill 의 모듈 내부 대입(`reqCount = 0`)을 분할 후 호출로 대체(#1313 R22). */
export function resetReqCount(): void { reqCount = 0; }

async function rateSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + REQ_INTERVAL_MS;
  if (at > now) await sleep(at - now);
}

export async function notionFetch(cfg: NotionConfig, pathname: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
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
        //  귀결된다(고객사 A 실배포 의혹). 60s 에 끊고 재시도 → 소진 시 실패 집계(커서 동결)로 전환.
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

// ── #976 아웃바운드(위키 투영) 공개 표면 — 내부 loadConfig/notionFetch 재사용. 인바운드(run-sync)의 역방향. ──
//  우리 SoT(지식)를 노션 피드 DB 에 투영한다. observed 미러 경로와 무관 — 발행표식(knowledge_publication)만 남긴다.
//  얇은 래퍼(clickup.ts 의 createTask/updateTask 대칭) — 지식→속성 매핑 등 오케스트레이션은 notion-push.ts.
export async function loadNotionConfig(): Promise<NotionConfig> { return loadConfig(); }

export async function notionCreatePage(
  cfg: NotionConfig, body: { parent: Rec; properties: Rec; children?: unknown[] },
): Promise<{ id: string; url?: string }> {
  return (await notionFetch(cfg, "/pages", { method: "POST", body })) as { id: string; url?: string };
}

// properties 부분수정(멱등 upsert 의 update 측). archived:true 로 발행 취소(휴지통)도 가능.
export async function notionUpdatePage(
  cfg: NotionConfig, pageId: string, body: { properties?: Rec; archived?: boolean },
): Promise<{ id: string; url?: string }> {
  return (await notionFetch(cfg, `/pages/${encodeURIComponent(pageId)}`, { method: "PATCH", body })) as { id: string; url?: string };
}

// 피드 DB 부트스트랩용(ensureFeedDatabase) — parent 페이지 하위에 알려진 스키마로 DB 생성.
//  ⚠ API 2025-09-03: 속성은 initial_data_source.properties 로 감싼다(멀티소스 DB 분리). 응답에 data_sources[] 동봉.
export async function notionCreateDatabase(
  cfg: NotionConfig, body: { parent: Rec; title: unknown[]; initial_data_source: Rec },
): Promise<{ id: string; url?: string; data_sources?: Array<{ id: string; name?: string }> }> {
  return (await notionFetch(cfg, "/databases", { method: "POST", body })) as { id: string; url?: string; data_sources?: Array<{ id: string; name?: string }> };
}

// DB 조회 — data_source 해소용(2025-09-03: 페이지 부모는 data_source_id, database_id 아님). data_sources[] 반환.
export async function notionRetrieveDatabase(
  cfg: NotionConfig, dbId: string,
): Promise<{ id: string; data_sources?: Array<{ id: string; name?: string }> }> {
  return (await notionFetch(cfg, `/databases/${encodeURIComponent(dbId)}`)) as { id: string; data_sources?: Array<{ id: string; name?: string }> };
}

// 커서 페이지네이션 공통 — GET(qs) / POST(body) 양쪽.
export async function* paginate(cfg: NotionConfig, make: (cursor?: string) => { path: string; method?: string; body?: Rec }): AsyncGenerator<Rec> {
  let cursor: string | undefined;
  do {
    const req = make(cursor);
    const data = (await notionFetch(cfg, req.path, { method: req.method, body: req.body })) as NotionListResponse;
    for (const r of data.results ?? []) yield asRec(r);
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);
}
