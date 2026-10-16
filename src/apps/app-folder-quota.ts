// 앱 폴더 상한 · 사용량(#4785 앱 v2-20) — 상한 값을 정하고, CP 가 잰 사용량을 받아 두고, 80% · 100% 에 닿으면 알린다.
//
// ── 누가 무엇을 하나 ─────────────────────────────────────────────────────────
//  · 상한은 코어에 둔다(org_app.folder_limit_gb) — 앱 책임자 · 관리자가 앱마다 건다(app_folder_limit_set). 기본은 무제한(null) —
//    상민님 2026-10-16 «기본 무제한 · 관리자 + 앱 책임자 · 넘으면 거절 + 80% 알림».
//  · 실제로 거는 것은 CP 의 5분 쿼터 정비다(lvly-cloud appfolderquota.ts — JuiceFS `/<워크스페이스>/apps/<앱>` 디렉터리 쿼터). 넘으면 그
//    폴더에 쓰기가 EDQUOT(Disk quota exceeded)로 막힌다 — 세션 셸 · 앱 서버(서명 주소) · 작업 컨테이너 모두 같은 파일시스템이라 한 번에.
//    그래서 바꾼 상한은 다음 정비(최대 5분)에 걸린다. 상한이 워크스페이스 한도보다 크면 워크스페이스 한도가 먼저 막는다(쿼터는 겹쳐 걸린다).
//  · 사용량은 CP 가 같은 판에서 쿼터 목록으로 재어 보낸다(app_folder_usage_report) — 상한이 없는 앱도 «용량 0(무제한) 쿼터» 로 센다.
//    여기서 저장하고, 80% · 100% 단계를 처음 넘을 때 앱 책임자와 관리자에게 알린다(같은 단계는 한 번 · 내려갔다 다시 넘으면 또).
//  · 셀프호스트(CP 없음)에선 상한을 걸 자리가 없다 — 값은 남지만 사용량이 오지 않는다(화면은 «아직 재지 않았다» 를 말한다).
import { itemsPool } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { getAppsByIds, type OrgApp } from "../org/store/apps.js";
import { listActiveAdminIds } from "../org/store/members.js";
import { notifyAppInstaller } from "./notify.js";

/** 앱 폴더 상한의 최댓값(GiB) — lvly-cloud appfolderquota.APP_FOLDER_LIMIT_MAX_GB 와 같은 자. */
export const APP_FOLDER_LIMIT_MAX_GB = 10240;
const GIB = 1024 ** 3;

/** 알림 단계 — 0(없음) · 80(상한의 80% 이상) · 100(가득 — 쓰기가 막힌다). */
export type FolderLevel = 0 | 80 | 100;

/** 사용량이 상한의 어느 단계인가(순수). 상한이 없으면 0. 경계는 정확히 80% · 100% 에서 넘어간다. */
export function folderLevel(usedBytes: number, limitGb: number | null): FolderLevel {
  if (limitGb == null || !(limitGb > 0) || !(usedBytes >= 0)) return 0;
  const cap = limitGb * GIB;
  return usedBytes >= cap ? 100 : usedBytes * 10 >= cap * 8 ? 80 : 0;
}

/** 받은 상한을 검사한다(순수) — null · 빈 값은 무제한, 그 밖엔 1 ~ 최댓값의 정수(GiB). 아니면 400. */
export function parseFolderLimit(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 1 || n > APP_FOLDER_LIMIT_MAX_GB) {
    throw new HttpError(400, `앱 폴더 상한은 1 ~ ${APP_FOLDER_LIMIT_MAX_GB} 사이의 정수(GiB)이거나, 비워 두면 상한이 없습니다`);
  }
  return n;
}

export interface FolderUsageRow { app_id: string; used_bytes: number; limit_gb: number | null; measured_at: string; warned_level: FolderLevel }

/** 이 앱들의 마지막 사용량(재지 않은 앱은 빠진다). */
export async function appFolderUsageOf(ids: readonly string[]): Promise<Map<string, FolderUsageRow>> {
  const out = new Map<string, FolderUsageRow>();
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return out;
  const r = await itemsPool.query(
    `SELECT app_id, used_bytes, limit_gb, measured_at, warned_level FROM org_app_folder_usage WHERE app_id = ANY($1::text[])`, [want]);
  for (const x of r.rows) {
    out.set(String(x.app_id), {
      app_id: String(x.app_id), used_bytes: Number(x.used_bytes), limit_gb: x.limit_gb == null ? null : Number(x.limit_gb),
      measured_at: x.measured_at instanceof Date ? x.measured_at.toISOString() : String(x.measured_at),
      warned_level: (Number(x.warned_level) || 0) as FolderLevel,
    });
  }
  return out;
}

/** 앱을 지울 때 — 그 앱의 사용량 행도(FK 없음, remove-run). */
export async function pruneAppFolderUsage(appId: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_app_folder_usage WHERE app_id=$1`, [appId]);
}

/** 화면 · 응답에 싣는 앱 폴더 칸 — 원하는 상한 · 지금 걸린 상한 · 사용량 · 단계 · 이 사람이 상한을 바꿀 수 있나. */
export function folderFields(app: Pick<OrgApp, "folder_limit_gb">, usage: FolderUsageRow | undefined, canSet: boolean): Record<string, unknown> {
  return {
    limit_gb: app.folder_limit_gb ?? null,
    used_bytes: usage ? usage.used_bytes : null,
    applied_limit_gb: usage ? usage.limit_gb : null,
    measured_at: usage ? usage.measured_at : null,
    level: usage ? folderLevel(usage.used_bytes, usage.limit_gb) : 0,
    can_set: canSet,
  };
}

/** 사람이 읽는 크기 — 1024 단위(JuiceFS 와 같은 자). */
export function fmtGiB(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)}GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MiB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KiB`;
}

export interface UsageReport { app_id: string; used_bytes: number; limit_gb: number | null }

export interface UsageDeps {
  apps: (ids: readonly string[]) => Promise<Array<Pick<OrgApp, "id" | "title" | "owner_member">>>;
  admins: () => Promise<string[]>;
  notify: (to: { appId: string; memberId: string; title: string; body: string; dedupe_key: string }) => Promise<unknown>;
}
const liveUsageDeps: UsageDeps = {
  apps: (ids) => getAppsByIds(ids),
  admins: () => listActiveAdminIds(),
  notify: (n) => notifyAppInstaller(n),
};

/** 단계를 처음 넘었을 때의 알림 글(순수). */
export function folderNotice(title: string, usedBytes: number, limitGb: number, level: 80 | 100): { title: string; body: string } {
  const used = `${fmtGiB(usedBytes)} / ${limitGb}GiB`;
  return level === 100
    ? { title: `「${title}」 앱 폴더가 가득 찼습니다`, body: `${used} — 이 앱 폴더에 더 쓸 수 없습니다. 파일을 지우거나 앱빌더 «배포 설정» 에서 상한을 올리세요.` }
    : { title: `「${title}」 앱 폴더가 상한의 80% 를 넘었습니다`, body: `${used} — 상한에 닿으면 이 앱 폴더에 쓸 수 없게 됩니다. 파일을 지우거나 앱빌더 «배포 설정» 에서 상한을 올리세요.` };
}

/**
 * CP 가 잰 사용량을 받아 둔다 — 없는 앱은 건너뛴다. 단계(80 · 100)를 처음 넘으면 앱 책임자와 관리자에게 알리고, 단계가 내려가면
 *  기록을 낮춰 다시 넘을 때 또 알린다. 알림 실패는 그 알림만(기록은 남긴다 — 다음 판에 같은 단계면 다시 알리지 않는다).
 */
export async function recordAppFolderUsage(rows: readonly UsageReport[], deps: UsageDeps = liveUsageDeps): Promise<{ stored: number; notified: Array<{ app_id: string; level: FolderLevel }> }> {
  const valid = rows.filter((r) => r && typeof r.app_id === "string" && Number.isFinite(r.used_bytes) && r.used_bytes >= 0);
  if (!valid.length) return { stored: 0, notified: [] };
  const apps = new Map((await deps.apps(valid.map((r) => r.app_id))).map((a) => [a.id, a]));
  const prev = await appFolderUsageOf([...apps.keys()]);
  const notified: Array<{ app_id: string; level: FolderLevel }> = [];
  let stored = 0;
  let admins: string[] | null = null;
  for (const r of valid) {
    const app = apps.get(r.app_id);
    if (!app) continue;
    const limit = r.limit_gb != null && Number.isInteger(r.limit_gb) && r.limit_gb > 0 ? r.limit_gb : null;
    const level = folderLevel(r.used_bytes, limit);
    const was = prev.get(r.app_id)?.warned_level ?? 0;
    const warn = level > was;
    //  ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, app_id)로 재작성한다(attachAppRow 와 같은 규약).
    await itemsPool.query(
      `INSERT INTO org_app_folder_usage(app_id, used_bytes, limit_gb, measured_at, warned_level, warned_at)
         VALUES($1,$2,$3,now(),$4, CASE WHEN $5 THEN now() END)
       ON CONFLICT (tenant_id, app_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes, limit_gb=EXCLUDED.limit_gb, measured_at=now(),
         warned_level=EXCLUDED.warned_level, warned_at=CASE WHEN $5 THEN now() ELSE org_app_folder_usage.warned_at END`,
      [r.app_id, Math.round(r.used_bytes), limit, level, warn]);
    stored++;
    if (!warn || !limit) continue;
    admins ??= await deps.admins().catch(() => [] as string[]);
    const to = new Set(admins);
    if (app.owner_member) to.add(app.owner_member);
    const n = folderNotice(app.title || app.id, r.used_bytes, limit, level as 80 | 100);
    for (const m of to) {
      await deps.notify({ appId: app.id, memberId: m, title: n.title, body: n.body, dedupe_key: `app-folder-${level}:${app.id}` })
        .catch((e) => logger.warn({ err: e, app: app.id, member: m }, "앱 폴더 용량 알림 실패(#4785)"));
    }
    notified.push({ app_id: app.id, level });
  }
  return { stored, notified };
}
