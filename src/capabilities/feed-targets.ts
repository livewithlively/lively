// #976 위키 아웃바운드 관리 capability — 피드 목적지(feed_target) + 카테고리 N:M 매핑 CRUD + 드레인. admin scope.
//  관리탭 '위키 아웃바운드' 패널(REST /api/ui/feed-targets)·MCP 양쪽. 발행 엔진은 notion-push(drainWikiFeeds), 여기는 정의·매핑 관리 + 드레인 위임.
//  create: 새 피드는 노션 DB 부트스트랩(ensureFeedDatabase), 기존 DB 는 databaseId 로 등록. 둘 다 #984 exclude_pages 자동 등록(재수집 차단).
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { itemsPool } from "../db/client.js";
import {
  createFeedTarget, listFeedTargets, getFeedTarget, updateFeedTarget, deleteFeedTarget,
  setCategoryFeeds, categoriesForFeedTarget,
} from "../v6/feed-target-store.js";
import { ensureFeedDatabase, drainWikiFeeds } from "../connectors/notion-push.js";
import { loadNotionConfig, notionRetrieveDatabase } from "../connectors/notion.js";
import { resolveConnectorConfig, resetConnectorConfigCache } from "../connectors/config.js";
import { upsertConnector } from "../org/store.js";
import { logger } from "../log.js";

// 노션 인바운드 exclude_pages 에 피드 DB id 추가(#984 — 우리 발행물 재수집·observed 뒤집힘 차단). 기존 평문설정 보존.
async function addNotionExcludePage(dbId: string, actor: string | null): Promise<void> {
  const cfg = (await resolveConnectorConfig("notion")) as Record<string, unknown>;
  const cur = String(cfg.exclude_pages ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!cur.includes(dbId)) cur.push(dbId);
  const PLAIN = ["instance", "root_pages", "comments", "asset_dir", "api_version"]; // 비밀 아닌 필드만 되쓴다(token 제외)
  const config: Record<string, string> = {};
  for (const k of PLAIN) { const v = cfg[k]; if (v != null && String(v) !== "") config[k] = String(v); }
  config.exclude_pages = cur.join(",");
  await upsertConnector({ system: "notion", config }, actor ?? undefined, "web");
  resetConnectorConfigCache();
}

const feedTargetList: Capability = {
  name: "feed_target_list",
  title: "피드 목적지 목록",
  description: "위키 아웃바운드 피드 목적지(feed_target) 목록 + 각 피드의 매핑 카테고리·발행 카드 수. 발행 게이트(카테고리 N:M) 관리 표면. 카테고리 피커용 전체 카테고리 동봉.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/feed-targets"], parse: () => ({}) }] },
  handler: async () => {
    const targets = await listFeedTargets();
    const withMeta = await Promise.all(targets.map(async (t) => {
      const cats = await categoriesForFeedTarget(t.id);
      const cnt = await itemsPool.query(
        `SELECT count(*)::int n FROM knowledge_publication WHERE system=$1 AND target_id=$2 AND state='published'`,
        [t.system, t.target_id]);
      return { ...t, categories: cats, card_count: (cnt.rows[0]?.n as number) ?? 0 };
    }));
    const categories = (await itemsPool.query(
      `SELECT id, name, key FROM category WHERE state='active' ORDER BY key`)).rows;
    return { targets: withMeta, categories };
  },
};

const feedTargetCreate: Capability = {
  name: "feed_target_create",
  title: "피드 목적지 생성/등록",
  description:
    "새 노션 피드를 만들거나(부트스트랩: parent_page_id 하위에 '지식 피드' DB 생성) 기존 노션 DB 를 등록(database_id). " +
    "둘 다 #984 안전을 위해 피드 DB 를 인바운드 exclude_pages 에 자동 등록(우리 발행물이 재수집돼 observed 로 뒤집히는 것 차단). all_categories=true 면 매핑 없이 모든 정본 발행.",
  scope: "admin",
  input: {
    title: z.string().max(200).optional(),
    parentPageId: z.string().max(200).optional(),
    databaseId: z.string().max(200).optional(),
    allCategories: z.boolean().optional(),
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/feed-targets"], parse: (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return {
      title: b.title != null ? String(b.title) : undefined,
      parentPageId: b.parent_page_id != null ? String(b.parent_page_id) : undefined,
      databaseId: b.database_id != null ? String(b.database_id) : undefined,
      allCategories: typeof b.all_categories === "boolean" ? b.all_categories : undefined,
    };
  } }] },
  handler: async (input: any, user: any, ctx: any) => {
    const actor = ctx?.actor ?? user?.userId ?? null;
    const cfg = await loadNotionConfig();
    const title = (input.title?.trim() || "Lively 지식 피드") as string;
    let dbId = input.databaseId?.trim() as string | undefined;
    let dsId: string | null = null;
    let parentPageId: string | null = input.parentPageId?.trim() ?? null;

    if (dbId) {
      const db = await notionRetrieveDatabase(cfg, dbId);
      dsId = db.data_sources?.[0]?.id ?? null;
      if (!dsId) throw new HttpError(400, "이 노션 DB 의 data_source 를 해소할 수 없습니다(공유·권한 확인)");
    } else if (parentPageId) {
      const r = await ensureFeedDatabase(cfg, parentPageId, title);
      dbId = r.databaseId; dsId = r.dataSourceId;
    } else {
      throw new HttpError(400, "parent_page_id(새 피드 생성) 또는 database_id(기존 DB 등록) 중 하나가 필요합니다");
    }

    const ft = await createFeedTarget({ system: "notion", instance: cfg.instance, targetId: dbId!, dataSourceId: dsId, parentPageId, title });
    let excludeRegistered = false;
    try { await addNotionExcludePage(dbId!, actor); await updateFeedTarget(ft.id, { excludeRegistered: true }); excludeRegistered = true; }
    catch (e) { logger.warn({ err: e, dbId }, "피드 DB exclude_pages 등록 실패 — 관리탭에서 수동 제외 필요"); }
    if (input.allCategories) await updateFeedTarget(ft.id, { allCategories: true });
    return { feed_target: await getFeedTarget(ft.id), exclude_registered: excludeRegistered };
  },
};

const feedTargetUpdate: Capability = {
  name: "feed_target_update",
  title: "피드 목적지 수정",
  description: "피드 제목·상태(active/paused)·all_categories(매핑 무시하고 모든 정본 발행) 패치. 주어진 키만 변경.",
  scope: "admin",
  input: {
    id: z.number().int().positive(),
    title: z.string().max(200).optional(),
    state: z.enum(["active", "paused"]).optional(),
    allCategories: z.boolean().optional(),
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/feed-targets/:id"], parse: (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return {
      id: Number(req.params?.id),
      title: b.title != null ? String(b.title) : undefined,
      state: b.state != null ? String(b.state) : undefined,
      allCategories: typeof b.all_categories === "boolean" ? b.all_categories : undefined,
    };
  } }] },
  handler: async (input: any) => {
    const id = Number(input.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "유효한 피드 id 가 필요합니다");
    if (!(await getFeedTarget(id))) throw new HttpError(404, "피드 목적지를 찾을 수 없습니다");
    await updateFeedTarget(id, { title: input.title, state: input.state, allCategories: input.allCategories });
    return { feed_target: await getFeedTarget(id) };
  },
};

const feedTargetDelete: Capability = {
  name: "feed_target_delete",
  title: "피드 목적지 삭제",
  description: "피드 목적지 등록을 삭제(카테고리 매핑도 CASCADE). ⚠ 노션 DB 자체와 이미 발행된 카드·exclude_pages 항목은 남는다(외부 삭제는 하지 않음).",
  scope: "admin",
  input: { id: z.number().int().positive() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/feed-targets/:id/delete"], parse: (req) => ({ id: Number(req.params?.id) }) }] },
  handler: async (input: any) => {
    const id = Number(input.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "유효한 피드 id 가 필요합니다");
    await deleteFeedTarget(id);
    return { deleted: true, id };
  },
};

const feedTargetSetCategories: Capability = {
  name: "feed_target_set_categories",
  title: "피드 발행 카테고리 매핑",
  description: "이 피드로 발행할 카테고리 집합을 통째로 설정(발행 게이트, N:M). all_categories=true 인 피드는 이 매핑을 무시한다.",
  scope: "admin",
  input: { id: z.number().int().positive(), categoryIds: z.array(z.number().int()).default([]) },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/feed-targets/:id/categories"], parse: (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b.category_ids) ? b.category_ids.map(Number).filter((n) => Number.isInteger(n)) : [];
    return { id: Number(req.params?.id), categoryIds: ids };
  } }] },
  handler: async (input: any) => {
    const id = Number(input.id);
    if (!(await getFeedTarget(id))) throw new HttpError(404, "피드 목적지를 찾을 수 없습니다");
    await setCategoryFeeds(id, input.categoryIds);
    return { mapped: input.categoryIds.length, id };
  },
};

const feedTargetDrain: Capability = {
  name: "feed_target_drain",
  title: "피드 즉시 발행(드레인)",
  description: "등록된 노션 피드 전체를 지금 1회 드레인(정본 지식 → 카드, 멱등). 백그라운드 실행(대량은 수십 초~분) — started 반환 후 진행. 상시 갱신은 cron push-wiki-notion.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/feed-targets/drain"], parse: () => ({}) }] },
  handler: async () => {
    void drainWikiFeeds().then((r) => logger.info(r, "수동 위키 드레인 완료")).catch((e) => logger.warn({ err: e }, "수동 위키 드레인 실패"));
    return { started: true };
  },
};

export const feedTargetCapabilities: Capability[] = [
  feedTargetList, feedTargetCreate, feedTargetUpdate, feedTargetDelete, feedTargetSetCategories, feedTargetDrain,
];
