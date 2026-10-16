// 앱 폴더 상한 · 사용량(#4785 앱 v2-20) — 상한 값을 정하고, CP 가 잰 사용량을 받아 두고, 80% · 100% 에 닿으면 알린다.
//
// ── 누가 무엇을 하나 ─────────────────────────────────────────────────────────
//  · 상한은 코어에 둔다(org_app.folder_limit_gb) — 앱 책임자 · 관리자가 앱마다 건다(app_folder_limit_set). 기본은 무제한(null) —
//    상민님 2026-10-16 «기본 무제한 · 관리자 + 앱 책임자 · 넘으면 거절 + 80% 알림».
//  · 실제로 거는 것은 CP 의 5분 쿼터 정비다(lvly-cloud appfolderquota.ts — JuiceFS `/<워크스페이스>/apps/<앱>` 디렉터리 쿼터). 넘으면 그
//    폴더에 쓰기가 EDQUOT(Disk quota exceeded)로 막힌다 — 세션 셸 · 앱 서버(서명 주소) · 작업 컨테이너 모두 같은 파일시스템이라 한 번에.
//    그래서 바꾼 상한은 다음 정비(최대 5분)에 걸린다. 상한이 워크스페이스 한도보다 크면 워크스페이스 한도가 먼저 막는다(쿼터는 겹쳐 걸린다).
//  · 사용량은 CP 가 같은 판에서 쿼터 목록으로 재어 보낸다(app_folder_usage_report) — 상한이 없는 앱도 «용량 0(무제한) 쿼터» 로 센다.
//    CP 는 상한 있는 앱의 사용량을 JuiceFS 의 Use%(정확한 바이트로 낸 백분율)로 좁혀 보낸다 — 여기서 내는 80% · 100% 판정이 JuiceFS 와 같다.
//    여기서 저장하고, 80% · 100% 단계를 처음 넘을 때 앱 책임자와 관리자에게 알린다.
//    · 같은 단계는 한 번 — 그 단계보다 10%p 아래로 내려가야 기록을 낮춘다(heldLevel). 경계에서 오르내릴 때마다 다시 알리지 않는다.
//    · 앱마다 한 트랜잭션 — 사용량 행을 쥔 채 알리고 단계를 적는다. 보고가 겹치면 뒤 것이 기다렸다가 앞 것이 적은 단계를 읽어 한 쪽만
//      알린다. 알림이 한 장도 저장되지 않거나(받는 사람을 못 읽었거나 다 실패) 도중에 죽으면 단계가 오르지 않아 다음 판(5분)에 다시 알린다.
//  · 셀프호스트(CP 없음)에선 상한을 걸 자리가 없다 — 값은 남지만 걸리지도 재지도 않는다. 화면은 그렇다고 말한다(folder.enforced).
import { itemsPool, withTx } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { getAppsByIds, type OrgApp } from "../org/store/apps.js";
import { listActiveAdminIds } from "../org/store/members.js";
import { managedMode } from "../org/tenancy/state.js";
import { notifyAppInstaller } from "./notify.js";

/**
 * 앱 폴더 상한의 최댓값(GiB) — lvly-cloud appfolderquota.APP_FOLDER_LIMIT_MAX_GB 와 같은 자. JuiceFS 쿼터 목록의 크기 글은 유효숫자
 *  3자리라 1TiB 를 넘으면 건 값이 되읽히지 않는다(1500 → «1.5 TiB»=1536) — 그 안에서만 받는다.
 */
export const APP_FOLDER_LIMIT_MAX_GB = 1000;
const GIB = 1024 ** 3;

/** 알림 단계 — 0(없음) · 80(상한의 80% 이상) · 100(가득 — 쓰기가 막힌다). */
export type FolderLevel = 0 | 80 | 100;

/** 사용량이 상한의 어느 단계인가(순수). 상한이 없으면 0. 경계는 정확히 80% · 100% 에서 넘어간다. */
export function folderLevel(usedBytes: number, limitGb: number | null): FolderLevel {
  if (limitGb == null || !(limitGb > 0) || !(usedBytes >= 0)) return 0;
  const cap = limitGb * GIB;
  return usedBytes >= cap ? 100 : usedBytes * 10 >= cap * 8 ? 80 : 0;
}

/**
 * 알린 단계를 지금도 붙들고 있나(순수) — 단계보다 10%p 아래로 내려가야 놓는다(100 은 90% 아래에서 80 으로, 80 은 70% 아래에서 0 으로).
 *  사용량이 80% 언저리에서 오르내릴 때마다(빌드 산출물 · 캐시) 5분 판마다 다시 알리지 않게. 상한이 없어지면 놓는다.
 */
export function heldLevel(was: FolderLevel, usedBytes: number, limitGb: number | null): FolderLevel {
  if (limitGb == null || !(limitGb > 0) || !(usedBytes >= 0)) return 0;
  const cap = limitGb * GIB;
  if (was >= 100 && usedBytes * 10 >= cap * 9) return 100;
  if (was >= 80 && usedBytes * 10 >= cap * 7) return 80;
  return 0;
}

/**
 * 받은 상한을 검사한다(순수) — null 만 «상한 없음», 그 밖엔 1 ~ 최댓값의 정수(GiB). 아니면 400.
 *  ★ 빠뜨린 값(undefined) · 빈 글은 «없앰» 이 아니라 400 이다 — 본문을 잘못 보낸 요청이 걸어 둔 상한을 조용히 풀지 않게.
 */
export function parseFolderLimit(v: unknown): number | null {
  if (v === null) return null;
  if (v === undefined || v === "") throw new HttpError(400, "limit_gb 가 없습니다 — 상한을 없애려면 null 을 보내세요");
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 1 || n > APP_FOLDER_LIMIT_MAX_GB) {
    throw new HttpError(400, `앱 폴더 상한은 1 ~ ${APP_FOLDER_LIMIT_MAX_GB} 사이의 정수(GiB)이거나, null 이면 상한이 없습니다`);
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

/**
 * 표 · 열이 아직 없다는 오류인가(42P01 · 42703) — 매니지드 롤은 게이트웨이가 공용 DB 마이그레이션보다 먼저 요청을 받을 수 있다
 *  (지식 cp-login-job-asbuilt-4067 «새 표를 더하는 코어 변경은 표가 없는 창을 견뎌야 한다»).
 */
export function isSchemaNotReady(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42703";
}

/** 화면(앱 목록 · 상세)용 — 표가 아직 없는 창(마이그레이션 전)이면 «아직 안 잼» 으로 보인다. 그 밖의 오류는 그대로 던진다. */
export async function appFolderUsageForView(ids: readonly string[]): Promise<Map<string, FolderUsageRow>> {
  try { return await appFolderUsageOf(ids); }
  catch (e) { if (isSchemaNotReady(e)) return new Map(); throw e; }
}

/** 앱을 지울 때 — 그 앱의 사용량 행도(FK 없음, remove-run). 표가 아직 없으면(마이그레이션 전 창) 지울 것도 없다 — 앱 지우기를 막지 않는다. */
export async function pruneAppFolderUsage(appId: string): Promise<void> {
  try { await itemsPool.query(`DELETE FROM org_app_folder_usage WHERE app_id=$1`, [appId]); }
  catch (e) { if (!isSchemaNotReady(e)) throw e; }
}

/** 사용량이 이보다 오래되면 낡았다(stale) — CP 는 5분마다 잰다. 화면은 단계 문장 대신 «마지막으로 잰 때» 를 말한다. */
export const FOLDER_USAGE_STALE_MS = 30 * 60_000;

/**
 * 화면 · 응답에 싣는 앱 폴더 칸 — 원하는 상한 · 지금 걸린 상한 · 사용량 · 단계 · 낡았나 · 이 사람이 상한을 바꿀 수 있나 · 이 배포가 상한을 거나.
 *  단계는 «지금 걸린 상한» 으로 낸다 — 상한을 낮춘 직후(정비 전)엔 아직 옛 상한이 걸려 있어 쓸 수 있다.
 *  stale 은 서버 시계로 낸다(브라우저 시계가 어긋나도 같은 답).
 *  enforced = 매니지드(CP 의 쿼터 정비가 건다). 셀프호스트는 false — 화면이 «이 워크스페이스에서는 걸리지 않는다» 를 말한다.
 */
export function folderFields(app: Pick<OrgApp, "folder_limit_gb">, usage: FolderUsageRow | undefined, canSet: boolean,
  enforced: boolean = managedMode(), now: number = Date.now()): Record<string, unknown> {
  const at = usage ? Date.parse(usage.measured_at) : Number.NaN;
  return {
    limit_gb: app.folder_limit_gb ?? null,
    used_bytes: usage ? usage.used_bytes : null,
    applied_limit_gb: usage ? usage.limit_gb : null,
    measured_at: usage ? usage.measured_at : null,
    level: usage ? folderLevel(usage.used_bytes, usage.limit_gb) : 0,
    stale: Number.isFinite(at) && now - at > FOLDER_USAGE_STALE_MS,
    can_set: canSet,
    enforced,
  };
}

/** 사람이 읽는 크기 — 1024 단위(JuiceFS 와 같은 자) · GiB · MiB · KiB. */
export function fmtBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)}GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MiB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KiB`;
}

export interface UsageReport { app_id: string; used_bytes: number; limit_gb: number | null }

export interface UsageDeps {
  apps: (ids: readonly string[]) => Promise<Array<Pick<OrgApp, "id" | "title" | "owner_member">>>;
  admins: () => Promise<string[]>;
  /** ok = 저장했거나 같은 알림이 이미 있다(중복 억제). */
  notify: (to: { appId: string; memberId: string; title: string; body: string; dedupe_key: string }) => Promise<{ ok: boolean }>;
}
const liveUsageDeps: UsageDeps = {
  apps: (ids) => getAppsByIds(ids),
  admins: () => listActiveAdminIds(),
  notify: (n) => notifyAppInstaller(n),
};

/** 단계를 처음 넘었을 때의 알림 글(순수). */
export function folderNotice(title: string, usedBytes: number, limitGb: number, level: 80 | 100): { title: string; body: string } {
  const used = `${fmtBytes(usedBytes)} / ${limitGb}GiB`;
  return level === 100
    ? { title: `「${title}」 앱 폴더가 가득 찼습니다`, body: `${used} — 이 앱 폴더에 더 쓸 수 없습니다. 파일을 지우거나 앱빌더 «배포 설정» 에서 상한을 올리세요.` }
    : { title: `「${title}」 앱 폴더가 상한의 80% 를 넘었습니다`, body: `${used} — 상한에 닿으면 이 앱 폴더에 쓸 수 없게 됩니다. 파일을 지우거나 앱빌더 «배포 설정» 에서 상한을 올리세요.` };
}

/**
 * CP 가 잰 사용량을 받아 둔다 — 없는 앱은 건너뛴다. 단계(80 · 100)를 처음 넘으면 앱 책임자와 관리자에게 알린다(머리말).
 *  앱마다 한 트랜잭션이다.
 *  ① 사용량 숫자를 적으며 그 행을 쥔다(INSERT … ON CONFLICT DO UPDATE 가 행을 잠근다) — 겹친 보고(CP 리더 교대 · 수동 호출)는 여기서
 *    앞 것이 끝나길 기다렸다가 앞 것이 적은 단계를 읽는다. 앱이 그새 지워졌으면 적지 않는다(지우기와 겹친 보고가 고아 행을 되살리지 않게).
 *  ② 새 단계에 닿았으면 알린다. 관리자 목록을 못 읽었으면 이번 판엔 아무에게도 보내지 않는다(책임자만 받고 관리자가 놓치지 않게).
 *  ③ 알림이 한 장이라도 저장됐으면 그 단계를 적는다(warned_at 도) — 아니면 붙든 단계 그대로라 다음 판에 다시 알린다. 일부만 실패하면
 *    단계를 적는다 — 실패한 사람 몫은 다시 가지 않는다(«한 장이라도» 를 고른 값). 도중에 죽으면 트랜잭션이 되돌려 단계가 오르지 않는다.
 *  한 번 알린 단계는 10%p 아래로 내려가야 놓는다(heldLevel). notified = 이번에 실제로 알림이 저장된 앱 · 단계.
 */
export async function recordAppFolderUsage(rows: readonly UsageReport[], deps: UsageDeps = liveUsageDeps): Promise<{ stored: number; notified: Array<{ app_id: string; level: FolderLevel }> }> {
  const valid = rows.filter((r) => r && typeof r.app_id === "string" && Number.isFinite(r.used_bytes) && r.used_bytes >= 0);
  if (!valid.length) return { stored: 0, notified: [] };
  const apps = new Map((await deps.apps(valid.map((r) => r.app_id))).map((a) => [a.id, a]));
  const notified: Array<{ app_id: string; level: FolderLevel }> = [];
  let stored = 0;
  let admins: string[] | null | undefined;   // undefined = 아직 안 읽음 · null = 못 읽음(이번 판엔 알리지 않는다)
  for (const r of valid) {
    const app = apps.get(r.app_id);
    if (!app) continue;
    const limit = r.limit_gb != null && Number.isInteger(r.limit_gb) && r.limit_gb > 0 ? r.limit_gb : null;
    const level = folderLevel(r.used_bytes, limit);
    const done = await withTx(async (c) => {
      //  ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, app_id)로 재작성한다(attachAppRow 와 같은 규약).
      const row = (await c.query(
        `INSERT INTO org_app_folder_usage(app_id, used_bytes, limit_gb, measured_at)
           SELECT $1,$2,$3,now() WHERE EXISTS (SELECT 1 FROM org_app WHERE id=$1)
         ON CONFLICT (tenant_id, app_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes, limit_gb=EXCLUDED.limit_gb, measured_at=now()
         RETURNING warned_level`,
        [r.app_id, Math.round(r.used_bytes), limit])).rows[0];
      if (!row) return null;
      const was = (Number(row.warned_level) || 0) as FolderLevel;
      const hold = heldLevel(was, r.used_bytes, limit);
      let delivered = 0;
      //  level > hold 면 새 단계에 닿았다(heldLevel 이 지금 사용량으로 붙들기 때문에 이때 level > was 다). 이때 limit 은 있다 —
      //   상한이 없으면 folderLevel 이 0 을 넘지 않는다.
      if (level > hold) {
        if (admins === undefined) {
          admins = await deps.admins().catch((e) => { logger.warn({ err: e }, "앱 폴더 용량 알림 — 관리자 목록을 못 읽어 다음 판에 다시 알린다(#4785)"); return null; });
        }
        if (admins !== null) {
          const to = new Set(admins);
          if (app.owner_member) to.add(app.owner_member);
          const n = folderNotice(app.title || app.id, r.used_bytes, limit!, level as 80 | 100);
          for (const m of to) {
            const res = await deps.notify({ appId: app.id, memberId: m, title: n.title, body: n.body, dedupe_key: `app-folder-${level}:${app.id}` })
              .catch((e) => { logger.warn({ err: e, app: app.id, member: m }, "앱 폴더 용량 알림 실패(#4785)"); return null; });
            if (res?.ok) delivered++;
          }
        }
      }
      const warned: FolderLevel = delivered > 0 ? level : hold;
      if (warned !== was || delivered > 0) {
        await c.query(`UPDATE org_app_folder_usage SET warned_level=$2, warned_at=CASE WHEN $3 THEN now() ELSE warned_at END WHERE app_id=$1`,
          [r.app_id, warned, delivered > 0]);
      }
      return { delivered };
    });
    if (!done) continue;
    stored++;
    if (done.delivered > 0) notified.push({ app_id: app.id, level });
  }
  return { stored, notified };
}
