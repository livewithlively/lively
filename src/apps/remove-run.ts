// 앱 제거 실행 — 전개물 회수 + 레지스트리 삭제.
//  제거 verb(capabilities/apps.ts org_app_remove)와 빌트인 시더의 은퇴 앱 회수(seed.ts)가 쓰는 **공용 코어**다.
//   두 경로가 같은 순서로 지워야 한 곳에서만 잔재가 남는 일이 없다(설치의 install-run.ts 와 같은 이유).
//  ⚠ 호출부가 앱 설치 락(withAppInstallLock)을 잡고 부른다. «이 앱을 지워도 되나»(builtin 차단 등)도 호출부의 몫이다.
import * as store from "../org/store/apps.js";
import type { WriteCtx } from "../org/store/audit.js";
import { makeDeployDeps } from "./deploy.js";
import { dropAppTables, appSchemaFor } from "./store-schema.js";
import { isBuiltinSource } from "./store-ddl.js";
import { pruneAppInstances } from "../org/store/app-instances.js";
import { pruneSessionApps } from "./session-apps.js";
import { stopWorkersForApp } from "./worker-service.js";
import { snapshotAppData } from "./app-snapshot.js";
import { logger } from "../log.js";
import { liveTableNames } from "./app-view.js";
import { removeAppArchives, type ClearArchivesOutcome } from "./app-archive.js";

export interface RemoveAppOutcome {
  components: number;
  snapshot: { taken_at: string; tables: unknown } | null;
  /** 떠 둘 것이 없어 건너뛴 사유(있을 때만). */
  snapshot_skipped?: unknown;
  /** 떠 두기가 실패한 사유(있을 때만) — 관리자가 «되돌릴 수 없는 제거였나» 를 알아야 한다. */
  snapshot_error?: string;
  /** #4733 그 앱의 보관 표 — 지운 것(백업 묶음은 위 snapshot 과 같은 시각) · 못 지워 남긴 것과 까닭. 기본 앱은 없음(공유 보관 자리). */
  archives?: Pick<ClearArchivesOutcome, "taken_at" | "cleared" | "kept"> & { error?: string };
}

/**
 * 전개된 대상(하네스 자산·크론·툴·호스트 병합)은 CASCADE 밖(별도 스토어)이라 **먼저 reclaim** 한 뒤 앱 행을 지운다
 * (조인 component/grant 는 deleteApp 이 CASCADE).
 */
export async function removeInstalledApp(app: NonNullable<Awaited<ReturnType<typeof store.getApp>>>, ctx: WriteCtx): Promise<RemoveAppOutcome> {
  const id = app.id;
  await stopWorkersForApp(id, "app_removed");
  //  #4484 앱 서버 — 함수 · 로그 그룹 · zip · 기록을 걷는다(best-effort · 앱이 없으면 함수만 남아 돈을 쓰고 이름을 막는다).
  await import("./app-server-deploy.js").then((m) => m.removeServer(id))
    .then((r) => { if (r.errors.length) logger.warn({ id, errors: r.errors }, "앱 제거 — 서버 정리 일부 실패(비치명)"); })
    .catch((err) => logger.warn({ err, id }, "앱 제거 — 서버 정리 실패(비치명)"));
  const deps = makeDeployDeps(id, ctx);
  const comps = await store.listComponents(id);
  for (const c of comps) {
    try { await deps.reclaim({ kind: c.kind, ref: c.ref, orig_name: c.orig_name ?? undefined }); }
    catch { /* best-effort — 조인은 아래 delete 로 CASCADE, 저널 삭제로 스위퍼도 무관 */ }
  }
  await store.pruneUiAssets(id, []);   // UI 자산은 FK CASCADE 대상이 아니므로(스키마 주석) 명시 삭제.
  await store.pruneAllAppVersions(id); // #4600 판 이력도 같은 규칙(FK 없음) — 앱이 사라지면 되돌릴 곳이 없다.
  // #4226 — 테이블을 지우기 전에 데이터를 떠 둔다(7일 보관). 같은 id 로 다시 설치하면 app_data_restore 로 되돌린다.
  //  떠 두기가 실패해도 제거는 막지 않는다 — 명시로 요청한 제거다(로그는 남긴다).
  let snapError: string | null = null;
  const now = new Date();   // #4733 앱 표와 보관 표를 한 묶음(같은 시각)으로 떠 둔다
  const snap = await snapshotAppData(id, "before-remove", now).catch((err) => {
    logger.warn({ err, id }, "제거 전 앱 데이터 떠 두기 실패");
    snapError = (err as Error)?.message ?? String(err);
    return null;
  });
  // 앱 데이터 테이블(app 스키마)도 명시 DROP(소유자) — 매니페스트 선언분. best-effort.
  //  #4667 물리 표 전부 — 공개 앱에 초안이 걸려 있으면 초안이 뺀(공개 판이 아직 쓰는) 표도 지운다(고아로 남지 않게 · 격리 리뷰 NB-7).
  const dataTables = await liveTableNames(app);
  //  스키마는 설치 때와 같은 규칙(#4223) — 워크스페이스가 설치한 앱이면 그 워크스페이스 스키마의 테이블만 지운다.
  try { await dropAppTables(id, dataTables, appSchemaFor(isBuiltinSource(app.source))); } catch { /* best-effort */ }
  //  #4733 그 앱의 보관 표도 — 지우기 직전 백업(위와 같은 묶음)에 담고 지운다. 못 담으면 지우지 않고 남긴다(제거는 막지 않는다 —
  //   명시로 요청한 제거다). 기본 앱(시더의 은퇴 회수)은 보관 자리가 여러 워크스페이스의 것이라 건드리지 않는다.
  let archives: RemoveAppOutcome["archives"];
  if (!isBuiltinSource(app.source)) {
    archives = await removeAppArchives(id, now)
      .then(({ taken_at, cleared, kept }) => ({ taken_at, cleared, kept }))
      .catch((err) => {
        logger.warn({ err, id }, "제거하는 앱의 보관 표 정리 실패 — 그 자리에 둔다");
        return { taken_at: null, cleared: [], kept: [], error: (err as Error)?.message ?? String(err) };
      });
  }
  await pruneAppInstances(id);             // FK 없는 v2.1 신규 표 — 앱 제거 전에 명시 회수.
  await pruneSessionApps(id);              // #4225 세션에 붙어 있던 기록도 — 같은 규칙(FK 없음).
  await store.pruneMemberPrefs(id);        // #4601 구성원별 개인 설정도 — 같은 규칙(FK 없음).
  await store.deleteApp(id, ctx);
  return {
    components: comps.length,
    snapshot: snap?.taken_at ? { taken_at: snap.taken_at, tables: snap.tables } : null,
    ...(snap && !snap.taken_at ? { snapshot_skipped: snap.skipped ?? null } : {}),
    ...(snapError ? { snapshot_error: snapError } : {}),
    ...(archives ? { archives } : {}),
  };
}
