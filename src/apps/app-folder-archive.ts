// 앱 폴더 보관(#4778) — 앱을 지우면 그 앱 폴더(<apps 자리>/<앱>/)를 apps 주소로 닿지 않는 보관 자리로 옮기고, 보관 기간이 지나면 지운다.
//  파일 쪽(보관 이름 · 고정 스크립트 · 자리 고르기 · 지우기)은 app-folder-ops.ts — 이 모듈은 기록 · 목록 · 관리자 도구 · 정비다.
//
// ── 왜 ───────────────────────────────────────────────────────────────────────────────────
//  앱 폴더(#4671 ② · #4673)는 앱 id 로 정해지는 자리다. 앱을 지우면 그 앱 폴더를 apps 주소로 닿지 않는 보관 자리로 옮기고, 같은 id 로
//   새로 만든 앱은 빈 앱 폴더로 시작한다. 보관 기간이 지나면 지운다. 앱 표는 이미 «떠 둔 뒤 지움»이다(#4226 · #4733) — 앱 폴더도 같은 자세다.
//
// ── 규칙 ──────────────────────────────────────────────────────────────────────────────────
//  · 앱 행을 지우는 모든 입구(remove-run — 관리자 제거 · 나만 보는 앱 지우기 · 시더의 은퇴 회수 · 빈 예약 거두기)가 archiveAppFolder 로
//    그 앱 폴더를 보관으로 옮긴다. 못 옮겨도 지우기는 막지 않는다(명시로 요청한 지우기다 — 응답에 까닭을 싣는다).
//  · 같은 id 로 앱을 새로 만들 때 그 자리에 폴더가 남아 있으면 먼저 보관으로 옮긴다(archiveLeftoverAppFolder) — 새 앱은 늘 빈 앱 폴더로 시작한다.
//    못 옮기면 만들지 않는다(fail-closed). 지우는 사이 들어온 올리기가 폴더를 새로 만든 경우도 여기서 걸린다.
//  · 보관 기간(앱 데이터 떠 두기와 같은 LIVELY_APP_SNAPSHOT_DAYS, 기본 7일)이 지나면 정비가 지운다(pruneAppFolderArchives).
//    관리자는 목록을 보고 비우거나, 같은 id 로 다시 만든 앱에 되돌린다 — 명시로만(app_data_restore 와 같은 자세, 상민 2026-10-16).
//  · 앱 행 없이 폴더만 남은 것(고아)은 정비가 훑지 않는다 — 관리자 목록이 보여 주고 관리자가 보관으로 옮긴다(상민 2026-10-16:
//    매니지드에서 워크스페이스마다 파일 작업 헬퍼를 깨우지 않게 · 셀프호스트 기본 자리 ~/apps 에 원래 있던 폴더를 옮기지 않게).
//
// ── 기록 — org_app_folder_archive ─────────────────────────────────────────────────────────────
//  보관 하나 = 행 하나(이름 · 앱 · 언제 · 누가 · 어느 입구 · 크기 · 파일 수). 정비는 이 표만 보고 기간이 지난 보관이 있을 때만 파일을
//   만진다(보관이 없는 워크스페이스는 헬퍼를 깨우지 않는다). 파일 쪽이 진짜다 — 목록은 파일을 훑어 행 없는 보관(옮긴 뒤 기록이
//   실패한 것)을 행으로 채우고, 파일이 없는 행은 «사라짐» 으로 보인다. 못 지운 보관은 행이 남아 다음 정비 · 관리자 목록이 다시 본다.
import { itemsPool } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { getApp, withAppInstallLock } from "../org/store/apps.js";
import { APP_ID_RE } from "./manifest.js";
import { snapshotKeepDays } from "./app-snapshot.js";
import { appsAreaFor, archiveNameFor, parseArchiveName, removeArchives, MEASURE_CAP, type AppsArea } from "./app-folder-ops.js";

/** 어느 입구에서 옮겼나 — 관리자 목록 · 감사에 그대로 보인다. */
export type AppFolderArchiveEntry =
  | "remove"      // 관리자 제거(org_app_remove)
  | "discard"     // 나만 보는 앱 지우기(app_draft_remove)
  | "retire"      // 시더의 은퇴 앱 회수
  | "draft-drop"  // 첫 판 없는 빈 예약 거두기(설치 실패 · 그만둔 만들기)
  | "create"      // 같은 id 로 새로 만들 때 그 자리에 남아 있던 폴더
  | "orphan";     // 관리자가 고아 폴더를 보관으로

/** 정비 한 번에 지우는 보관 수 상한 — 안 해 본 · 오래된 것부터(남은 것은 다음 정비가). */
export const PRUNE_BATCH = 20;

// ── 기록(org_app_folder_archive) ────────────────────────────────────────────────────────────

export interface AppFolderArchive {
  name: string;
  app_id: string;
  archived_at: string;
  archived_by: string | null;
  entry: AppFolderArchiveEntry | "unknown";
  kind: "dir" | "file" | "link";
  files: number | null;
  bytes: number | null;
  truncated: boolean;
  /** 지우려다 못 지웠으면 그 까닭과 시각(권한 · 시간 예산) — 정비는 이것을 뒤로 보낸다. */
  last_error: string | null;
  last_try_at: string | null;
}

type Row = Omit<AppFolderArchive, "archived_at" | "last_try_at"> & { archived_at: Date; last_try_at: Date | null };

const rowOf = (r: Record<string, unknown>): Row => ({
  name: String(r.name), app_id: String(r.app_id),
  archived_at: r.archived_at instanceof Date ? r.archived_at : new Date(String(r.archived_at)),
  archived_by: r.archived_by == null ? null : String(r.archived_by),
  entry: String(r.entry) as Row["entry"], kind: (String(r.kind || "dir")) as Row["kind"],
  files: r.files == null ? null : Number(r.files), bytes: r.bytes == null ? null : Number(r.bytes), truncated: r.truncated === true,
  last_error: r.last_error == null ? null : String(r.last_error),
  last_try_at: r.last_try_at == null ? null : r.last_try_at instanceof Date ? r.last_try_at : new Date(String(r.last_try_at)),
});
const publicOf = (r: Row): AppFolderArchive => ({ ...r, archived_at: r.archived_at.toISOString(), last_try_at: r.last_try_at ? r.last_try_at.toISOString() : null });

async function insertRow(r: Row): Promise<void> {
  // ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, name) 으로 다시 쓴다(attachAppRow 와 같은 규약).
  await itemsPool.query(
    `INSERT INTO org_app_folder_archive(name, app_id, archived_at, archived_by, entry, kind, files, bytes, truncated)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, name) DO NOTHING`,
    [r.name, r.app_id, r.archived_at, r.archived_by, r.entry, r.kind, r.files, r.bytes, r.truncated]);
}
async function allRows(): Promise<Row[]> {
  return (await itemsPool.query(`SELECT * FROM org_app_folder_archive ORDER BY archived_at DESC, name`)).rows.map(rowOf);
}
async function rowsByNames(names: string[]): Promise<Row[]> {
  if (!names.length) return [];
  return (await itemsPool.query(`SELECT * FROM org_app_folder_archive WHERE name = ANY($1::text[])`, [names])).rows.map(rowOf);
}
async function deleteRows(names: string[]): Promise<void> {
  if (names.length) await itemsPool.query(`DELETE FROM org_app_folder_archive WHERE name = ANY($1::text[])`, [names]);
}
/** 못 지운 보관 — 마지막 시도 시각과 까닭을 남긴다(정비 차례에서 뒤로 · 목록에 까닭). */
async function markTried(left: Array<{ name: string; why: string }>): Promise<void> {
  if (!left.length) return;
  await itemsPool.query(
    `UPDATE org_app_folder_archive a SET last_try_at = now(), last_error = l.why
       FROM unnest($1::text[], $2::text[]) AS l(name, why) WHERE a.name = l.name`,
    [left.map((x) => x.name), left.map((x) => x.why)]).catch((err) => logger.warn({ err }, "[app-folder] 못 지운 보관의 시도를 기록하지 못했다"));
}

/** 못 지운 까닭(사람이 읽는 말) — 시간 예산이면 정비는 «다음 정비가 이어서», 비우기는 «다시 비우면 이어서». */
export function keptWhy(k: { error: string; budget?: true }, by: "prune" | "clear"): string {
  if (k.budget) return by === "prune" ? "시간이 모자라 다 지우지 못했습니다 — 다음 정비가 이어서 지웁니다" : "시간이 모자라 다 지우지 못했습니다 — 다시 비우면 이어서 지웁니다";
  return `지우지 못했습니다 — ${k.error}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 보관 기한 — 옮긴 시각 + 보관 일수. */
export function expiresAt(archivedAt: Date | string, keepDays: number = snapshotKeepDays()): string {
  return new Date(new Date(archivedAt).getTime() + Math.floor(keepDays) * DAY_MS).toISOString();
}

// ── 옮기기 ─────────────────────────────────────────────────────────────────────────────────

export interface AppFolderArchiveOutcome {
  /** 옮긴 보관(없으면 null — 그 앱 폴더가 없었다). */
  archived: AppFolderArchive | null;
  /** 옮길 것을 찾지도 않은 까닭(앱 id 꼴이 아님 · apps 자리 없음). */
  skipped?: string;
}

/**
 * 그 앱 폴더를 보관으로 옮긴다 — 없으면 아무것도 안 한다(archived=null). 파일 op 가 실패하면(상한 초과 포함) 던진다(부르는 쪽이 정한다 —
 *  지우기는 까닭만 싣고 계속, 새로 만들기는 멈춘다). 옮긴 뒤 기록을 못 남기면 경고만 — 목록이 파일에서 다시 채운다.
 */
export async function archiveAppFolder(appId: string, opts: { by: string | null; entry: AppFolderArchiveEntry; now?: Date; area?: AppsArea | null }): Promise<AppFolderArchiveOutcome> {
  if (!APP_ID_RE.test(appId)) return { archived: null, skipped: "앱 id 꼴이 아니라 앱 폴더가 없습니다" };
  const area = opts.area !== undefined ? opts.area : appsAreaFor(opts.by);
  if (!area) return { archived: null, skipped: "앱 폴더 자리가 없습니다" };
  const now = opts.now ?? new Date();
  const name = archiveNameFor(appId, now);
  const r = await area.run<{ moved: boolean; kind?: Row["kind"]; files?: number; bytes?: number; truncated?: boolean }>(
    { op: "archive", app: appId, name, ...MEASURE_CAP });
  if (!r?.moved) return { archived: null };
  const row: Row = {
    name, app_id: appId, archived_at: now, archived_by: opts.by, entry: opts.entry,
    kind: r.kind ?? "dir", files: r.files ?? null, bytes: r.bytes ?? null, truncated: r.truncated === true, last_error: null, last_try_at: null,
  };
  await insertRow(row).catch((err) => logger.warn({ err, name, app: appId }, "[app-folder] 보관으로 옮겼는데 기록을 못 남겼다 — 관리자 목록이 파일에서 다시 채운다"));
  logger.info({ app: appId, name, entry: opts.entry, files: row.files, bytes: row.bytes, truncated: row.truncated }, "[app-folder] 앱 폴더를 보관으로 옮김");
  return { archived: publicOf(row) };
}

/**
 * 새 앱을 만들기 직전 — 같은 id 의 앱 폴더가 남아 있으면 보관으로 옮긴다(새 앱은 늘 빈 앱 폴더로 시작한다). 못 보면 만들지 않는다(503).
 *  앱 행이 아직 없는 자리에서만 부른다(부르는 쪽이 설치 락 안에서 «없음» 을 본 뒤).
 */
export async function archiveLeftoverAppFolder(appId: string, by: string | null): Promise<AppFolderArchive | null> {
  try {
    return (await archiveAppFolder(appId, { by, entry: "create" })).archived;
  } catch (err) {
    logger.warn({ err, app: appId }, "[app-folder] 새 앱의 앱 폴더 자리를 확인하지 못해 만들기를 멈춘다");
    throw new HttpError(503, `앱 '${appId}' 의 앱 폴더 자리를 확인하지 못해 만들지 않았습니다 — 잠시 뒤 다시 해 주세요(새 앱이 빈 앱 폴더로 시작하도록 먼저 확인합니다)`, { cause: err });
  }
}

// ── 목록(관리자) ───────────────────────────────────────────────────────────────────────────

export interface AppFolderArchiveItem extends AppFolderArchive {
  expires_at: string;
  /** 보관 기간이 지났다 — 정비가 지우는 중이라 되돌리지 않는다. */
  expired: boolean;
  /** 지금 같은 id 의 앱이 있나 — 되돌리기는 있을 때만 된다. */
  app_exists: boolean;
  /** 기록은 있는데 파일이 없다(누가 셸에서 지웠다 · 옮기기가 실패한 기록) — 다음 정비가 기록을 걷는다. */
  missing?: true;
}
export interface AppFolderOrphan { app_id: string; kind: "dir" | "file" | "link"; files: number; bytes: number; truncated: boolean }
export interface AppFolderArchiveListing {
  keep_days: number;
  archives: AppFolderArchiveItem[];
  /** 앱 행 없이 남은 앱 폴더 — 관리자가 보관으로 옮긴다(app_folder_orphans_archive). */
  orphans: AppFolderOrphan[];
  count: number; bytes: number; orphan_count: number; orphan_bytes: number;
  /** 파일을 못 훑었으면 그 까닭 — 그때 archives 는 기록만(사라짐 · 고아를 모른다). */
  scan_error?: string;
}

interface ScanResult {
  exists: boolean;
  archives: Array<{ name: string; kind: Row["kind"]; files?: number; bytes?: number; truncated?: boolean }>;
  orphans: Array<{ name: string; kind: Row["kind"]; files: number; bytes: number; truncated: boolean }>;
}

/** 기록 + 파일 훑기 → 목록(순수). 파일에만 있는 보관은 채울 행(fill)으로 돌려준다. */
export function mergeListing(rows: Row[], scan: ScanResult | null, liveIds: ReadonlySet<string>, keepDays: number, now: Date = new Date()): { items: AppFolderArchiveItem[]; fill: Row[]; orphans: AppFolderOrphan[] } {
  const present = scan ? new Set(scan.archives.map((a) => a.name)) : null;
  const known = new Set(rows.map((r) => r.name));
  const fill: Row[] = [];
  for (const a of scan?.archives ?? []) {
    if (known.has(a.name)) continue;
    const parsed = parseArchiveName(a.name);
    if (!parsed) continue;
    fill.push({ name: a.name, app_id: parsed.app_id, archived_at: parsed.archived_at, archived_by: null, entry: "unknown",
      kind: a.kind, files: a.files ?? null, bytes: a.bytes ?? null, truncated: a.truncated === true, last_error: null, last_try_at: null });
  }
  const items = [...rows, ...fill]
    .sort((a, b) => b.archived_at.getTime() - a.archived_at.getTime() || a.name.localeCompare(b.name))
    .map((r): AppFolderArchiveItem => ({
      ...publicOf(r), expires_at: expiresAt(r.archived_at, keepDays), expired: Date.parse(expiresAt(r.archived_at, keepDays)) <= now.getTime(),
      app_exists: liveIds.has(r.app_id),
      ...(present && !present.has(r.name) ? { missing: true as const } : {}),
    }));
  const orphans = (scan?.orphans ?? []).map((o) => ({ app_id: o.name, kind: o.kind, files: o.files, bytes: o.bytes, truncated: o.truncated }));
  return { items, fill, orphans };
}

/** 이 워크스페이스의 앱 id 전부(기본 앱 포함 — 행이 있으면 그 폴더는 고아가 아니다). */
async function liveAppIds(): Promise<string[]> {
  return (await itemsPool.query(`SELECT id FROM org_app`)).rows.map((r) => String(r.id));
}

export async function listAppFolderArchives(by: string | null = null): Promise<AppFolderArchiveListing> {
  const keepDays = snapshotKeepDays();
  const rows = await allRows();
  const live = await liveAppIds();
  const area = appsAreaFor(by);
  let scan: ScanResult | null = null, scanError: string | undefined;
  if (area) {
    try { scan = await area.run<ScanResult>({ op: "scan", live, known: rows.map((r) => r.name), ...MEASURE_CAP }); }
    catch (err) { scanError = (err as Error)?.message ?? String(err); logger.warn({ err }, "[app-folder] apps 자리를 훑지 못했다 — 기록만 보인다"); }
  }
  const { items, fill, orphans } = mergeListing(rows, scan, new Set(live), keepDays);
  for (const r of fill) await insertRow(r).catch((err) => logger.warn({ err, name: r.name }, "[app-folder] 파일에만 있던 보관을 기록하지 못했다"));
  return {
    keep_days: keepDays, archives: items, orphans,
    count: items.length, bytes: items.reduce((n, a) => n + (a.missing ? 0 : a.bytes ?? 0), 0),
    orphan_count: orphans.length, orphan_bytes: orphans.reduce((n, o) => n + o.bytes, 0),
    ...(scanError ? { scan_error: scanError } : {}),
  };
}

// ── 비우기 · 되돌리기 · 고아 옮기기(관리자) ─────────────────────────────────────────────────────

export interface ClearFolderArchivesOutcome {
  /** 지운 것 — was_missing 이면 파일은 이미 없었고 기록만 걷었다. */
  cleared: Array<{ name: string; app_id: string; was_missing?: true }>;
  /** 못 지워 남긴 것과 까닭(기록도 남는다 — 목록에 계속 보이고 다시 비울 수 있다). */
  kept: Array<{ name: string; why: string }>;
  /** 보관 이름 꼴이 아니거나 기록도 파일도 없는 이름 — 아무것도 하지 않았다. */
  missing: string[];
}

/** 보관을 지운다(되살릴 길이 없다 — 이 보관이 마지막 사본이다. 테넌트 백업 보관 기간 동안은 백업에만 남는다). */
export async function clearAppFolderArchives(names: string[], by: string | null = null): Promise<ClearFolderArchivesOutcome> {
  const want = [...new Set(names.map((n) => String(n ?? "").trim()).filter(Boolean))];
  const out: ClearFolderArchivesOutcome = { cleared: [], kept: [], missing: [] };
  const valid = want.filter((n) => parseArchiveName(n));
  out.missing.push(...want.filter((n) => !parseArchiveName(n)));
  if (!valid.length) return out;
  const area = appsAreaFor(by);
  if (!area) throw new HttpError(503, "앱 폴더 자리가 없습니다");
  const rows = new Map((await rowsByNames(valid)).map((r) => [r.name, r]));
  const r = await removeArchives(area, valid);
  const appOf = (n: string): string => rows.get(n)?.app_id ?? parseArchiveName(n)!.app_id;
  for (const n of r.removed) out.cleared.push({ name: n, app_id: appOf(n) });
  //  파일이 처음부터 없던 이름 — 기록이 있으면 기록만 걷고(사라진 보관) · 기록도 없으면 아무것도 안 한 것으로 알린다.
  for (const n of r.absent) {
    if (rows.has(n)) out.cleared.push({ name: n, app_id: appOf(n), was_missing: true });
    else out.missing.push(n);
  }
  for (const k of r.left) out.kept.push({ name: k.name, why: keptWhy(k, "clear") });
  await deleteRows([...r.removed, ...r.absent.filter((n) => rows.has(n))]);
  await markTried(out.kept);
  return out;
}

/**
 * 보관을 같은 id 의 앱 폴더로 되돌린다 — 그 앱이 지금 있고(다시 만든 뒤) 그 앱 폴더가 없거나 비었을 때만 · 보관 기간 안이고 지우다 멈춘
 *  보관이 아닐 때만. 설치 락 안에서(그 앱의 설치 · 지우기와 엇갈리지 않게). 되돌리면 기록을 지운다.
 */
export async function restoreAppFolderArchive(name: string, by: string | null = null): Promise<{ app_id: string; name: string }> {
  const parsed = parseArchiveName(name);
  if (!parsed) throw new HttpError(400, `보관 이름 꼴이 아닙니다: ${String(name).slice(0, 80)} — app_folder_archives 의 name 을 그대로 주세요`);
  const appId = parsed.app_id;
  return withAppInstallLock(appId, async () => {
    //  보관 기간이 지났거나 지우다 멈춘 보관이면 되돌리지 않는다 — 지우기는 여러 번에 나눠 가므로 일부 파일이 이미 지워졌을 수 있다
    //   (반쯤 지워진 것을 새 앱에 붙이지 않게). 지우다 멈춘 것 = 비우기 · 정비가 권한 · 시간 예산으로 멈춰 시도가 기록된 보관.
    const row = (await rowsByNames([name]))[0];
    const archivedAt = row?.archived_at ?? parsed.archived_at;
    if (Date.parse(expiresAt(archivedAt)) <= Date.now()) {
      throw new HttpError(409, `보관 '${name}' 은(는) 보관 기간이 지나 지우는 중이라 되돌리지 않습니다`);
    }
    if (row?.last_try_at) {
      throw new HttpError(409, `보관 '${name}' 은(는) 지우다 멈춘 보관이라 되돌리지 않습니다 — 일부 파일이 이미 지워졌을 수 있습니다(다시 비우면 이어서 지웁니다)`);
    }
    if (!(await getApp(appId))) {
      const until = expiresAt(archivedAt).slice(0, 10);
      throw new HttpError(409, `앱 '${appId}' 이(가) 지금 없습니다 — 같은 id 로 앱을 다시 만든 뒤 되돌리세요(보관은 ${until} 무렵까지 남습니다)`);
    }
    const area = appsAreaFor(by);
    if (!area) throw new HttpError(503, "앱 폴더 자리가 없습니다");
    const r = await area.run<{ ok: boolean; why?: "missing" | "occupied" }>({ op: "restore", name, app: appId });
    if (!r?.ok && r?.why === "missing") {
      await deleteRows([name]);
      throw new HttpError(410, `보관 '${name}' 이(가) 없습니다 — 이미 지워졌습니다`);
    }
    if (!r?.ok) throw new HttpError(409, `앱 '${appId}' 의 앱 폴더에 지금 파일이 있어 되돌리지 않았습니다 — 아무것도 바꾸지 않았습니다(새 앱의 파일을 덮지 않습니다)`);
    await deleteRows([name]);
    logger.info({ app: appId, name }, "[app-folder] 보관을 앱 폴더로 되돌림");
    return { app_id: appId, name };
  });
}

export interface OrphanArchiveOutcome {
  archived: AppFolderArchive[];
  skipped: Array<{ app_id: string; why: string }>;
}

/**
 * 고아 앱 폴더(앱 행이 없는 것)를 보관으로 옮긴다 — 앱마다 설치 락 안에서 «앱 없음» 을 다시 본 뒤. 하나가 실패해도(락 대기 초과 ·
 *  파일 op 실패) 그 까닭을 skipped 에 적고 나머지를 이어 간다 — 앞서 옮긴 것이 응답 · 감사에서 빠지지 않게.
 */
/** 고아 옮기기가 기대는 것 — 시험이 갈아 끼운다(락 대기 초과 · 파일 op 실패를 DB 없이 재현). */
export interface OrphanDeps {
  lock: <T>(appId: string, fn: () => Promise<T>) => Promise<T>;
  getApp: (appId: string) => Promise<unknown>;
  archive: typeof archiveAppFolder;
}
const realOrphanDeps: OrphanDeps = { lock: (id, fn) => withAppInstallLock(id, fn), getApp, archive: archiveAppFolder };

export async function archiveOrphanAppFolders(appIds: string[], by: string | null = null, deps: OrphanDeps = realOrphanDeps): Promise<OrphanArchiveOutcome> {
  const out: OrphanArchiveOutcome = { archived: [], skipped: [] };
  for (const id of [...new Set(appIds.map((x) => String(x ?? "").trim()).filter(Boolean))]) {
    if (!APP_ID_RE.test(id)) { out.skipped.push({ app_id: id, why: "앱 id 꼴이 아닙니다" }); continue; }
    try {
      await deps.lock(id, async () => {
        if (await deps.getApp(id)) { out.skipped.push({ app_id: id, why: "같은 id 의 앱이 있습니다 — 고아가 아니라 그 앱의 폴더입니다" }); return; }
        const r = await deps.archive(id, { by, entry: "orphan" });
        if (r.archived) out.archived.push(r.archived);
        else out.skipped.push({ app_id: id, why: r.skipped ?? "앱 폴더가 없습니다" });
      });
    } catch (err) {
      logger.warn({ err, app: id }, "[app-folder] 고아 앱 폴더를 보관으로 옮기지 못했다");
      out.skipped.push({ app_id: id, why: `옮기지 못했습니다 — ${(err as Error)?.message ?? String(err)}` });
    }
  }
  return out;
}

// ── 정비 — 보관 기간이 지난 것 지우기 ──────────────────────────────────────────────────────────

export interface PruneFolderArchivesOutcome { pruned: string[]; kept: Array<{ name: string; why: string }>; due: number }

/**
 * 보관 기간이 지난 보관을 지운다 — 기록(표)만 먼저 본다. 지울 것이 없으면 파일을 만지지 않는다(매니지드에서 헬퍼를 깨우지 않는다).
 *  한 번에 오래된 것부터 PRUNE_BATCH 개까지(남은 것은 다음 정비가). 파일이 이미 없으면 기록만 걷는다. 못 지운 것은 기록을 남긴다
 *  (다음 정비가 다시 · 관리자 목록에 보인다). due = 기간이 지난 보관 전부의 수(이번에 다룬 것이 아니라).
 */
export async function pruneAppFolderArchives(now: Date = new Date(), keepDays: number = snapshotKeepDays(), batch: number = PRUNE_BATCH): Promise<PruneFolderArchivesOutcome> {
  const cutoff = new Date(now.getTime() - Math.floor(keepDays) * DAY_MS);
  //  차례: 아직 안 해 본 것(오래된 보관부터) → 못 지웠던 것(오래전에 해 본 것부터) — 못 지우는 보관이 쌓여도 뒤의 보관이 막히지 않게.
  const due = (await itemsPool.query(
    `SELECT * FROM org_app_folder_archive WHERE archived_at < $1
      ORDER BY (last_try_at IS NOT NULL), COALESCE(last_try_at, archived_at), name`, [cutoff])).rows.map(rowOf);
  if (!due.length) return { pruned: [], kept: [], due: 0 };
  const area = appsAreaFor(null);
  if (!area) return { pruned: [], kept: due.map((r) => ({ name: r.name, why: "앱 폴더 자리가 없습니다" })), due: due.length };
  const r = await removeArchives(area, due.slice(0, Math.max(1, Math.floor(batch))).map((x) => x.name));
  const pruned = [...r.removed, ...r.absent];   // 파일이 이미 없던 것은 기록만 걷는다
  await deleteRows(pruned);
  const kept = r.left.map((k) => ({ name: k.name, why: keptWhy(k, "prune") }));
  await markTried(kept);
  if (pruned.length) logger.info({ pruned: pruned.length, keepDays }, "[app-folder] 보관 기간이 지난 앱 폴더 보관을 지움");
  for (const k of kept) logger.warn({ name: k.name, why: k.why }, "[app-folder] 보관 기간이 지난 보관을 지우지 못했다 — 다음 정비가 다시");
  return { pruned, kept, due: due.length };
}
