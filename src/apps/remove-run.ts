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

export interface RemoveAppOutcome {
  components: number;
  snapshot: { taken_at: string; tables: unknown } | null;
  /** 떠 둘 것이 없어 건너뛴 사유(있을 때만). */
  snapshot_skipped?: unknown;
  /** 떠 두기가 실패한 사유(있을 때만) — 관리자가 «되돌릴 수 없는 제거였나» 를 알아야 한다. */
  snapshot_error?: string;
}

/**
 * 전개된 대상(하네스 자산·크론·툴·호스트 병합)은 CASCADE 밖(별도 스토어)이라 **먼저 reclaim** 한 뒤 앱 행을 지운다
 * (조인 component/grant 는 deleteApp 이 CASCADE).
 */
export async function removeInstalledApp(app: NonNullable<Awaited<ReturnType<typeof store.getApp>>>, ctx: WriteCtx): Promise<RemoveAppOutcome> {
  const id = app.id;
  await stopWorkersForApp(id, "app_removed");
  const deps = makeDeployDeps(id, ctx);
  const comps = await store.listComponents(id);
  for (const c of comps) {
    try { await deps.reclaim({ kind: c.kind, ref: c.ref, orig_name: c.orig_name ?? undefined }); }
    catch { /* best-effort — 조인은 아래 delete 로 CASCADE, 저널 삭제로 스위퍼도 무관 */ }
  }
  await store.pruneUiAssets(id, []);   // UI 자산은 FK CASCADE 대상이 아니므로(스키마 주석) 명시 삭제.
  // 앱 데이터 테이블(app 스키마)도 명시 DROP(소유자) — 매니페스트 선언분. best-effort.
  const dataTables = ((app.manifest as { data?: { tables?: Array<{ name?: string }> } })?.data?.tables ?? []).map((t) => String(t.name));
  //  스키마는 설치 때와 같은 규칙(#4223) — 워크스페이스가 설치한 앱이면 그 워크스페이스 스키마의 테이블만 지운다.
  try { await dropAppTables(id, dataTables, appSchemaFor(isBuiltinSource(app.source))); } catch { /* best-effort */ }
  await pruneAppInstances(id);             // FK 없는 v2.1 신규 표 — 앱 제거 전에 명시 회수.
  await pruneSessionApps(id);              // #4225 세션에 붙어 있던 기록도 — 같은 규칙(FK 없음).
  await store.deleteApp(id, ctx);
  return { components: comps.length, snapshot: null };
}
