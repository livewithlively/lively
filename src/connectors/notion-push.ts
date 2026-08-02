// #976 아웃바운드(위키 투영) 오케스트레이터 — 지식(authored SoT) → 노션 '지식 피드' DB 카드. 인바운드(run-sync)의 역방향.
//  카드형(사용자 확정): 지식당 노션 페이지 1개(멱등 upsert). 속성=제목·도메인·유형·한줄요약·갱신, 본문=정본 링크.
//   전체 내용은 Lively(SoT) — 노션은 읽기전용 투영(연구 패턴 ②: 미러+자체레이어). content_hash 로 무변경 재푸시 skip.
//  ⚠ external_*(observed 미러 좌표)는 안 건드린다 — 발행표식(knowledge_publication)만 남긴다(#984).
//   피드 DB 는 exclude_pages 로 인바운드 스코프에서 제외해야 재수집·provenance 뒤집힘이 없다(ensureFeedDatabase 주석).
import crypto from "node:crypto";
import {
  getKnowledge, getKnowledgePublication, recordKnowledgePublication, markKnowledgePublicationFailed,
} from "../v6/knowledge-store.js";
import { loadNotionConfig, notionCreatePage, notionUpdatePage, notionCreateDatabase, notionRetrieveDatabase, type NotionConfig } from "./notion.js";
import { listFeedTargets, updateFeedTarget, listPublishableForFeedTarget } from "../v6/feed-target-store.js";
import { getOrgProfile } from "../org/store.js";
import { logger } from "../log.js";

const SYSTEM = "notion";

// 피드 DB 속성명 — ensureFeedDatabase 가 만든 스키마와 1:1(매핑이 이 이름으로 POST/PATCH). 바꾸면 부트스트랩도 함께.
const PROP = { title: "제목", domain: "도메인", type: "유형", summary: "한줄요약", updated: "갱신" } as const;

// 지식 유형(6종) → 한글 라벨. 노션 select 는 미존재 옵션을 쓰기 시 자동 생성하므로 사전 정의 불필요.
const TYPE_LABEL: Record<string, string> = {
  decision: "결정", concept: "개념", "how-to": "방법", reference: "참조", research: "리서치", entity: "엔티티",
};

// TIMESTAMPTZ 는 pg 드라이버가 native Date 로 파싱 → String() 은 로케일 문자열이라 노션 date(ISO-8601)에 부적합.
//  Date|string 이중성 안전(connector-mirror 와 동일 관용). 무효/빈값은 "". 노션 date.start·해시 입력 공통.
function toYmd(v: unknown): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// 스캔용 한줄요약 — summary(저작자 요약) 우선, 없으면 본문 첫 실질 문단에서 마크다운 장식 제거 후 발췌.
export function synopsisOf(k: { summary?: string | null; body_md?: string | null }, max = 200): string {
  const s = (k.summary ?? "").trim();
  if (s) return s.slice(0, max);
  for (const raw of (k.body_md ?? "").split(/\n{2,}/)) {
    const line = raw.replace(/[*_`>#\-]/g, "").replace(/\s+/g, " ").trim();  // 마크다운 장식·헤더 표식 제거 + 공백 접기
    if (line.length >= 8) return line.slice(0, max);
  }
  return "";
}

// 투영 대상 필드만 해시 — 무변경이면 재푸시 skip(노션 API 호출·rate 절약). 좌표(page_id)는 해시 대상 아님(위치는 불변).
export function feedContentHash(f: { title: string; domain: string; type: string; summary: string; updated: string }): string {
  return crypto.createHash("sha256")
    .update([f.title, f.domain, f.type, f.summary, f.updated].join("\u0000"))
    .digest("hex").slice(0, 32);
}

interface FeedFields { title: string; domain: string; type: string; summary: string; updated: string; livelyUrl: string | null }

// 지식 → 노션 DB 속성(카드 스키마). 빈 값은 생략(노션이 빈 select/date 를 거부하지 않게).
function feedProperties(f: FeedFields): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [PROP.title]: { title: [{ text: { content: f.title || "(제목 없음)" } }] },
    [PROP.summary]: { rich_text: f.summary ? [{ text: { content: f.summary } }] : [] },
  };
  if (f.domain) props[PROP.domain] = { select: { name: f.domain } };
  if (f.type) props[PROP.type] = { select: { name: f.type } };
  if (f.updated) props[PROP.updated] = { date: { start: f.updated } };
  return props;
}

// 페이지 본문 = 정본 링크만(정적 — update 로 안 건드려도 안 낡음). 요약·메타는 속성이 담는다. 전체는 Lively.
function feedChildren(f: FeedFields): unknown[] {
  if (!f.livelyUrl) return [];
  return [{
    object: "block", type: "paragraph",
    paragraph: { rich_text: [
      { text: { content: "전체 내용(정본)은 Lively에 있습니다 — " } },
      { text: { content: "Lively에서 보기 ↗", link: { url: f.livelyUrl } } },
    ] },
  }];
}

// ── 지식 1건을 노션 피드 DB 카드로 투영(멱등 upsert) ──────────────────────────
//  targetDbId = 피드 DB(ensureFeedDatabase 산출·config 보관). livelyBase = org gateway_url(딥링크; 없으면 링크 생략).
//  page_id 있고 content_hash 무변경이면 skip. update 가 404(외부 삭제)면 재생성. 실패는 표식 state=failed 로(다음 드레인 재시도).
export async function publishKnowledgeToNotion(
  name: string,
  opts: { cfg: NotionConfig; targetDbId: string; dataSourceId?: string | null; livelyBase?: string | null; publishedBy?: string | null },
): Promise<{ status: "created" | "updated" | "skipped" | "failed"; pageId?: string; reason?: string }> {
  const k = await getKnowledge(name);
  if (!k) return { status: "failed", reason: "지식 없음" };

  const cats = (k.categories as Array<{ name?: string | null; state?: string }> | undefined) ?? [];
  const domain = (cats.find((c) => c.state === "confirmed") ?? cats[0])?.name ?? "";
  const typeLabel = k.type ? (TYPE_LABEL[String(k.type)] ?? String(k.type)) : "";
  const summary = synopsisOf({ summary: k.summary, body_md: k.body_md });
  const updated = toYmd(k.updated_at);  // 노션 date 속성용 YYYY-MM-DD (pg 는 TIMESTAMPTZ 를 Date 로 반환 — toYmd 로 ISO)
  // #976 주의: livelyUrl 은 본문(create 시)에만 실리고 content_hash 5필드에 없다 → livelyBase 가 최초 발행 뒤 늦게
  //  설정되면 skip 으로 링크가 안 붙는 엣지. 드레인이 발행 전 livelyBase(gateway_url)를 필수 해소해 회피(후속 슬라이스).
  const livelyUrl = opts.livelyBase ? `${opts.livelyBase.replace(/\/+$/, "")}/#/k/${encodeURIComponent(name)}` : null;
  const fields: FeedFields = { title: k.title ?? name, domain, type: typeLabel, summary, updated, livelyUrl };
  const hash = feedContentHash(fields);

  const marker = await getKnowledgePublication(name, SYSTEM, opts.targetDbId);
  if (marker?.page_id && marker.state === "published" && marker.content_hash === hash) {
    return { status: "skipped", pageId: marker.page_id, reason: "unchanged" };
  }

  try {
    const props = feedProperties(fields);
    let pageId = marker?.page_id ?? null;
    let url: string | undefined;
    let created = false;
    if (pageId) {
      try {
        const r = await notionUpdatePage(opts.cfg, pageId, { properties: props });
        url = r.url;
      } catch (e) {
        if ((e as { status?: number })?.status === 404) pageId = null;  // 외부에서 삭제됨 → 재생성
        else throw e;
      }
    }
    if (!pageId) {
      // 2025-09-03: 페이지 부모는 data_source_id(database_id 아님). 미제공 시 피드 DB 에서 1회 해소(단일 소스 → [0]).
      let dsId = opts.dataSourceId ?? null;
      if (!dsId) {
        const db = await notionRetrieveDatabase(opts.cfg, opts.targetDbId);
        dsId = db.data_sources?.[0]?.id ?? null;
      }
      if (!dsId) {
        const reason = "피드 DB 의 data_source 해소 실패";
        await markKnowledgePublicationFailed(name, SYSTEM, opts.targetDbId, reason);  // 다른 실패경로와 일관 — state=failed 로 관측/재시도
        return { status: "failed", reason };
      }
      const r = await notionCreatePage(opts.cfg, {
        parent: { type: "data_source_id", data_source_id: dsId }, properties: props, children: feedChildren(fields),
      });
      pageId = r.id; url = r.url; created = true;
    }
    await recordKnowledgePublication({
      name, system: SYSTEM, instance: opts.cfg.instance, targetId: opts.targetDbId,
      pageId, url: url ?? livelyUrl, contentHash: hash, publishedBy: opts.publishedBy ?? "system",
    });
    return { status: created ? "created" : "updated", pageId };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    await markKnowledgePublicationFailed(name, SYSTEM, opts.targetDbId, msg);
    logger.warn({ err: e, name }, "노션 피드 투영 실패");
    return { status: "failed", reason: msg };
  }
}

// ── 피드 DB 부트스트랩(1회) — parent 페이지 하위에 카드 스키마로 DB 생성. 산출 id 는 config(feed_database_id)에 보관. ──
//  ⚠ 생성 직후 이 DB id 를 반드시 exclude_pages 에 추가한다 — 안 그러면 인바운드가 우리 발행물을 재수집해
//   observed 로 뒤집고 본문을 덮는다(#984). 호출측(관리 액션)이 이 두 스텝을 한 트랜잭션으로 안내해야 한다.
export async function ensureFeedDatabase(
  cfg: NotionConfig, parentPageId: string, title = "Lively 지식 피드",
): Promise<{ databaseId: string; dataSourceId: string | null; url?: string }> {
  const r = await notionCreateDatabase(cfg, {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: title } }],
    // 2025-09-03: 속성은 initial_data_source 아래로. 카드 스키마(제목=title, 도메인/유형=select, 요약=rich_text, 갱신=date).
    initial_data_source: {
      properties: {
        [PROP.title]: { title: {} },
        [PROP.domain]: { select: {} },
        [PROP.type]: { select: {} },
        [PROP.summary]: { rich_text: {} },
        [PROP.updated]: { date: {} },
      },
    },
  });
  return { databaseId: r.id, dataSourceId: r.data_sources?.[0]?.id ?? null, url: r.url };
}

// ── 드레인 — 등록된 노션 feed_target 전체를 순회하며 매핑 카테고리의 정본 지식을 투영(스케줄러 wiki_push 가 CLI 로 호출). ──
//  타깃 없으면 무비용 즉시 종료(옵트인). 타깃 있는데 노션 토큰 없으면 loadNotionConfig 가 throw(가시 — 설정 필요).
//  content_hash skip 덕에 반복 실행이 멱등·저비용(변경분만 실제 노션 쓰기). data_source 는 타깃당 1회 해소·캐시.
//  ⚠ 전체 스캔(타깃당 매핑 지식 전량) — 대형 KB 최적화(마지막 실행 이후 변경분만)는 후속. 지금은 정확·단순 우선.
export async function drainWikiFeeds(opts?: { limit?: number }): Promise<{ targets: number; created: number; updated: number; skipped: number; failed: number }> {
  const targets = await listFeedTargets({ system: SYSTEM, activeOnly: true });
  if (!targets.length) return { targets: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  const cfg = await loadNotionConfig();
  const livelyBase = (await getOrgProfile()).gateway_url ?? null;

  let created = 0, updated = 0, skipped = 0, failed = 0;
  for (const ft of targets) {
    // 페이지 부모 data_source(2025-09-03) 해소 — 캐시 없으면 1회 조회 후 저장. 실패 시 이 타깃만 skip.
    let dsId = ft.data_source_id;
    if (!dsId) {
      try {
        const db = await notionRetrieveDatabase(cfg, ft.target_id);
        dsId = db.data_sources?.[0]?.id ?? null;
        if (dsId) await updateFeedTarget(ft.id, { dataSourceId: dsId });
      } catch (e) { logger.warn({ err: e, feedTarget: ft.id }, "피드 data_source 해소 실패 — 이 타깃 skip"); continue; }
    }
    const names = await listPublishableForFeedTarget(ft.id, opts?.limit ?? 500);
    for (const name of names) {
      const r = await publishKnowledgeToNotion(name, { cfg, targetDbId: ft.target_id, dataSourceId: dsId, livelyBase });
      if (r.status === "created") created++;
      else if (r.status === "updated") updated++;
      else if (r.status === "skipped") skipped++;
      else failed++;
    }
  }
  logger.info({ targets: targets.length, created, updated, skipped, failed }, "위키 피드 드레인 완료");
  return { targets: targets.length, created, updated, skipped, failed };
}
