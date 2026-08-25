// 로드된 앱 패키지 1건을 설치/업데이트한다 — 저널드 2-phase(runInstall) + update-diff(빠진 component 회수).
//  builtin 시더(seed.ts)와 설치 verb(delivery/apps.ts org_app_install)의 **공용 코어** — 두 경로가 같은
//  설치 시맨틱을 쓰도록 한 곳에 둔다(선례: seed 가 인라인하던 diff/runInstall 블록을 여기로 승격).
import { getApp, listComponents, upsertUiAsset, pruneUiAssets, upsertRuntimeAsset, pruneRuntimeAssets } from "../org/store/apps.js";
import type { LoadedApp } from "./loader.js";
import { ensureAppTables } from "./store-schema.js";
import { logger } from "../log.js";
import type { WriteCtx } from "../org/store/audit.js";
import { diffComponents, type AppComponentRef } from "./install-plan.js";
import { runInstall, type InstallAppMeta } from "./install.js";
import { makeDeployDeps } from "./deploy.js";

export interface InstallOutcome { id: string; created: boolean; components: number }

/**
 * 로드된 패키지를 설치/재전개한다.
 *  - existing 없음 → 신규 설치(created=true).
 *  - existing 있음 → 새 계획 전체로 재전개(멱등 upsert) 후, 빠진 component(drop)를 회수(update-diff, R2-5).
 * runInstall 이 저널·보상을 책임진다(실패 시 InstallError throw + status=failed). content_hash 스킵 판단은
 *  **호출부**의 몫(builtin 시더만 content-owned 스킵을 한다 — verb 는 관리자 명시 요청이라 항상 재전개).
 */
export async function installLoadedApp(loaded: LoadedApp, source: unknown, ctx: WriteCtx): Promise<InstallOutcome> {
  const id = loaded.manifest.id;
  const existing = await getApp(id);
  const meta: InstallAppMeta = {
    id, title: loaded.manifest.title, version: loaded.manifest.version,
    manifest: loaded.manifest, source, content_hash: loaded.contentHash,
  };
  const deps = makeDeployDeps(id, ctx);

  let drop: AppComponentRef[] = [];
  if (existing) {
    const oldRefs: AppComponentRef[] = (await listComponents(id)).map((c) => ({ kind: c.kind, ref: c.ref, orig_name: c.orig_name ?? undefined }));
    drop = diffComponents(oldRefs, loaded.items.map((it) => it.comp)).drop;
  }

  const components = await runInstall(meta, loaded.items, deps);

  // UI entry HTML 보존(PR5) — 설치가 active 로 저널된 뒤. best-effort: 실패해도 앱(하네스·principal)은 유효하고
  //  다음 설치/시드가 재보존한다. seed 의 skip 경로도 같은 헬퍼로 백필한다(마이그레이션 — 기존 설치 앱).
  await persistUiAssets(loaded);
  await persistRuntimeAsset(loaded);

  // 앱 데이터 테이블(app 스키마, D6) — 선언 테이블을 소유자 커넥션으로 생성(tenant_id+RLS 한 몸). best-effort per-table.
  try { await ensureAppTables(id, loaded.manifest.data.tables.map((t) => ({ table: t.name, columns: t.columns }))); }
  catch (err) { logger.warn({ err, id }, "앱 데이터 테이블 보장 실패(비치명 — 다음 설치/부팅이 재보장)"); }

  for (const c of drop) {
    try { await deps.reclaim(c); } catch { /* best-effort — 저널이 스위퍼를 부른다 */ }
    try { await deps.removeComponent(id, c); } catch { /* best-effort */ }
  }
  return { id, created: !existing, components };
}


/** 로드된 앱의 UI entry HTML 을 보존(upsert)하고 선언 안 하는 페이지를 정리(prune). 멱등 — 설치·시드 skip 양쪽에서 호출.
 *  best-effort: 실패해도 앱(하네스·principal)은 유효(다음 설치/부팅이 재보존). */
export async function persistUiAssets(loaded: LoadedApp): Promise<void> {
  const id = loaded.manifest.id;
  try {
    for (const ui of loaded.uiAssets) {
      await upsertUiAsset(id, { page_key: ui.page_key, kind: ui.kind, title: ui.title, html: ui.html }, loaded.contentHash);
    }
    await pruneUiAssets(id, loaded.uiAssets.map((u) => u.page_key));
  } catch (err) {
    logger.warn({ err, id }, "앱 UI 자산 보존 실패(비치명 — 다음 설치/부팅이 재보존)");
  }
}

/** worker bundle 보존/백필. install의 runtime_worker deploy와 중복이어도 멱등이며, builtin skip 마이그레이션 경로가 쓴다. */
export async function persistRuntimeAsset(loaded: LoadedApp): Promise<void> {
  const id = loaded.manifest.id;
  try {
    if (loaded.runtimeAsset) {
      await upsertRuntimeAsset(id, { ...loaded.runtimeAsset, package_hash: loaded.contentHash });
      await pruneRuntimeAssets(id, loaded.contentHash);
    } else {
      await pruneRuntimeAssets(id, null);
    }
  } catch (err) {
    logger.warn({ err, id }, "앱 worker 번들 보존 실패(비치명 — 다음 설치/부팅이 재보존)");
  }
}
