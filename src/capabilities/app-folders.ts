// 앱 폴더 상한 · 사용량 능력(#4785 앱 v2-20) — 판정과 저장은 apps/app-folder-quota.ts, 거는 것은 CP 의 쿼터 정비(lvly-cloud appfolderquota.ts).
//  · app_folder_limit_set — 앱 책임자 · 관리자가 앱 하나의 상한(GiB)을 정한다(null = 무제한 — 기본).
//  · app_folder_limits · app_folder_usage_report — CP 의 쿼터 정비가 운영 토큰(관리자)으로 부르는 두 길: 상한을 읽고, 잰 사용량을 보낸다.
//    사람 · AI 가 쓸 일이 없어 MCP 도구로는 내놓지 않는다(REST 만).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import * as store from "../org/store/apps.js";
import { canSeeApp, isAdminViewer, isAppOwner, type Viewer } from "../apps/visibility.js";
import { appFolderUsageOf, folderFields, fmtBytes, isSchemaNotReady, parseFolderLimit, recordAppFolderUsage, APP_FOLDER_LIMIT_MAX_GB } from "../apps/app-folder-quota.js";

/** CP 전용 두 길 — 표 · 열이 아직 없으면(롤 중 마이그레이션 전 창) 이 기능 전 코어와 같은 404 를 준다(CP 가 경보 없이 건너뛴다). */
async function orNotReady<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (isSchemaNotReady(e)) throw new HttpError(404, "앱 폴더 상한 표가 아직 없습니다(마이그레이션 전) — 다음 정비에 다시 오세요"); throw e; }
}

const actorOf = (u: { userId?: string; email?: string } | undefined): string => u?.userId || u?.email || "unknown";
const viewerOf = (u: LivelyUser | undefined): Viewer => ({ userId: actorOf(u), scopes: u?.scopes ?? [] });

const appFolderLimitSet: Capability = {
  name: "app_folder_limit_set",
  title: "앱 폴더 상한 바꾸기",
  description: `앱 하나의 앱 폴더(apps/<앱>/) 상한을 GiB 로 정한다 — limit_gb 1 ~ ${APP_FOLDER_LIMIT_MAX_GB} 의 정수, null 이면 상한 없음(기본). ` +
    "넘으면 그 앱 폴더에 쓰기가 막히고(세션 · 앱 서버 · 작업 컨테이너 모두) 80% 에 닿으면 앱 책임자와 관리자에게 알린다. " +
    "매니지드에서는 다음 쿼터 정비(최대 5분)에 적용된다. 워크스페이스 한도보다 크면 워크스페이스 한도가 먼저 막는다. 앱 책임자 · 관리자.",
  scope: null,
  input: { app_id: z.string(), limit_gb: z.number().int().nullable() },
  expose: {
    mcp: true,
    //  limit_gb 를 빠뜨린 본문은 parseFolderLimit 이 400 으로 돌려보낸다 — «없앰» 은 null 을 보낸 때만(걸어 둔 상한을 조용히 풀지 않게).
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/folder-limit"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, limit_gb: b.limit_gb };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = String(input.app_id ?? "").trim();
    if (!id) throw new HttpError(400, "app_id 가 필요합니다");
    const who = viewerOf(user);
    const app = await store.getApp(id);
    if (!app || !canSeeApp(app, who)) throw new HttpError(404, `앱 없음: ${id}`);
    if (!isAppOwner(app, who) && !isAdminViewer(who)) throw new HttpError(403, "앱 폴더 상한은 앱 책임자와 관리자가 바꿉니다");
    const limit = parseFolderLimit(input.limit_gb);
    const after = await store.setAppFolderLimit(id, limit, { actor: actorOf(user), source: ctx?.source ?? "web" });
    if (!after) throw new HttpError(404, `앱 없음: ${id}`);
    const usage = (await appFolderUsageOf([id])).get(id);
    //  지금 쓰는 양이 새 상한 이상이면 걸리는 순간 쓰기가 막힌다 — 막지는 않고(사람이 정한 값) 그 사실을 말한다.
    const over = limit !== null && usage && usage.used_bytes >= limit * 1024 ** 3;
    return {
      app_id: id,
      folder: folderFields(after, usage, true),
      note: "매니지드에서는 다음 쿼터 정비(최대 5분)에 적용됩니다",
      ...(over ? { warning: `지금 사용량(${fmtBytes(usage!.used_bytes)})이 새 상한 이상이라, 적용되면 이 앱 폴더에 더 쓸 수 없습니다` } : {}),
    };
  },
};

const appFolderLimits: Capability = {
  name: "app_folder_limits",
  title: "앱 폴더 상한 목록",
  description: "설치된 앱마다 앱 폴더 상한(GiB, null = 없음) — CP 의 쿼터 정비가 읽는다. 관리자.",
  scope: "admin",
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/app-folder-limits"], parse: () => ({}) }] },
  handler: async () => ({ apps: await orNotReady(() => store.listAppFolderLimits()) }),
};

const appFolderUsageReport: Capability = {
  name: "app_folder_usage_report",
  title: "앱 폴더 사용량 보내기",
  description: "CP 의 쿼터 정비가 잰 앱 폴더 사용량(바이트)과 그때 걸려 있던 상한을 받아 둔다 — 80% · 100% 를 처음 넘으면 앱 책임자와 관리자에게 알린다. 관리자.",
  scope: "admin",
  input: {
    apps: z.array(z.object({ app_id: z.string().max(64), used_bytes: z.number().nonnegative(), limit_gb: z.number().int().nullable() })).max(5000),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/app-folder-usage"], parse: (req) => ({ apps: ((req.body ?? {}) as Record<string, unknown>).apps ?? [] }) }],
  },
  handler: async (input: Record<string, unknown>) => {
    const rows = (Array.isArray(input.apps) ? input.apps : []) as Array<{ app_id: string; used_bytes: number; limit_gb: number | null }>;
    return orNotReady(() => recordAppFolderUsage(rows));
  },
};

export const appFolderCapabilities: Capability[] = [appFolderLimitSet, appFolderLimits, appFolderUsageReport];
