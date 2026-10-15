// 앱 판 묶음 하우스키핑(#4481 앱 v2-2) — 워크스페이스마다(테넌트 컨텍스트 안에서) 세 가지를 조금씩:
//   ① 옛 판 옮기기 — files JSONB 에 내용을 통째로 담은 판(#4600)을 파일 목록(bundle) + 저장소(S3 · 자가호스팅 DB)로. files 는 지우지 않는다
//      (옛 코어 호환 사본이 된다 — 옮긴 뒤 옛 코어로 급히 되돌려도 되돌리기 · 공개 판 화면이 돈다).
//   ② 옛 코어 호환 사본 비우기 — 파일 목록을 단 지 30일 지난 판의 files(상민 2026-10-15 «한 달 뒤 지움»).
//   ③ 정리 — 어떤 판도 안 가리키고 24시간 안 쓰인 파일(app-blob-store gcBlobs). 워크스페이스마다 6시간에 한 번.
//  어디서 부르나: 매니지드 = CP 가 테넌트마다 두드리는 /api/ops/housekeeping/tick · 자가호스팅 = boot/housekeeping 의 perTenant 타이머.
//  한 번에 조금만(틱을 오래 붙잡지 않게) — 남은 것은 다음 틱이 잇는다. 실패는 그 판만 건너뛰고 로그를 남긴다(다음 틱이 다시 본다).
import * as store from "../org/store/apps.js";
import { logger } from "../log.js";
import { appBundleS3Config, blobTenant, defaultBlobStoreKind, gcBlobs, storeBlobs, type BlobGcResult } from "./app-blob-store.js";
import { managedMode } from "../org/tenancy/state.js";
import { bundleBytes, bundleFromFiles, COMPAT_KEEP_DAYS } from "./app-bundle.js";
import type { AppFile } from "./app-versions.js";

export const MIGRATE_PER_TICK = 25;
export const GC_EVERY_MS = 6 * 60 * 60_000;
const lastGc = new Map<string, number>();
/** 이 프로세스에서 옮기다 실패한 판 — 같은 틱마다 같은 실패를 되풀이하지 않게(재기동하면 다시 본다). */
const failedThisProcess = new Set<string>();

export interface BundleHousekeepingResult {
  migrated: number; migrate_failed: number; legacy_left: boolean;
  compat_purged: number; gc: BlobGcResult | "skipped";
  /** 매니지드인데 S3 설정이 없어 옛 판 옮기기를 미뤘다(공용 DB 로 옮기지 않는다). */
  migrate_deferred?: "no-bucket";
}
let warnedNoBucket = false;

/** 옛 판 몇 개를 옮긴다. 반환 = 옮긴 수 · 실패 수 · 아직 남았나. */
export async function migrateLegacyVersions(limit = MIGRATE_PER_TICK): Promise<{ migrated: number; failed: number; left: boolean }> {
  const tenant = blobTenant();
  const rows = (await store.listLegacyVersions(limit + failedThisProcess.size)).filter((r) => !failedThisProcess.has(`${tenant}/${r.app_id}/${r.version_no}`)).slice(0, limit);
  let migrated = 0, failed = 0;
  const kind = defaultBlobStoreKind();
  for (const r of rows) {
    try {
      const prep = bundleFromFiles(r.files as AppFile[]);
      //  상한은 보지 않는다 — 옛 판은 옛 상한(8MiB) 안에서 이미 저장된 것이다. 워크스페이스 상한으로 옛 판을 못 옮기면 되돌릴 판이 사라진다.
      await storeBlobs(kind, prep.bundle.files.map((f) => ({ h: f.h, size: f.s, read: prep.readers.get(f.h) as () => Promise<Buffer> })));
      if (await store.setLegacyVersionBundle(r.app_id, r.version_no, { bundle: prep.bundle, bundle_store: kind, bundle_bytes: bundleBytes(prep.bundle) })) migrated++;
    } catch (e) {
      failed++;
      failedThisProcess.add(`${tenant}/${r.app_id}/${r.version_no}`);
      logger.warn({ err: e instanceof Error ? e.message : String(e), app: r.app_id, version_no: r.version_no }, "옛 판을 판 묶음으로 옮기지 못했다(#4481 — 그 판은 옛 자리에서 계속 읽힌다)");
    }
  }
  return { migrated, failed, left: rows.length >= limit };
}

/** 하우스키핑 한 번(워크스페이스 하나) — ① 옮기기 ② 사본 비우기 ③ 정리(6시간에 한 번). */
export async function runAppBundleHousekeeping(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<BundleHousekeepingResult> {
  //  매니지드(공용 DB)인데 버킷이 아직 없으면(cp.env LVLY_APP_BUNDLE_BUCKET 을 적기 전 롤) 옛 판을 DB 저장소로 옮기지 않는다 —
  //   옮기는 목적이 공용 DB 를 가볍게 하는 것이라, 그 자리에 다시 쌓으면 거꾸로다. 새 저장은 그동안 DB 저장소로 간다(판 행이 저장소를 적어 둔다).
  const defer = managedMode(env) && !appBundleS3Config(env);
  if (defer && !warnedNoBucket) { warnedNoBucket = true; logger.warn("매니지드인데 LIVELY_APP_BUNDLE_BUCKET 이 없어 옛 판 옮기기를 미룬다(#4481)"); }
  const m = defer ? { migrated: 0, failed: 0, left: true } : await migrateLegacyVersions();
  const purged = await store.purgeCompatCopies(COMPAT_KEEP_DAYS);
  const tenant = blobTenant();
  let gc: BlobGcResult | "skipped" = "skipped";
  if (now - (lastGc.get(tenant) ?? 0) >= GC_EVERY_MS) {
    lastGc.set(tenant, now);
    gc = await gcBlobs();
  }
  return { migrated: m.migrated, migrate_failed: m.failed, legacy_left: m.left, compat_purged: purged, gc, ...(defer ? { migrate_deferred: "no-bucket" as const } : {}) };
}

export function resetAppBundleHousekeepingForTest(): void { lastGc.clear(); failedThisProcess.clear(); }
