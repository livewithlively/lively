// 로드된 앱 패키지 1건을 설치/업데이트한다 — 저널드 2-phase(runInstall) + update-diff(빠진 component 회수).
//  builtin 시더(seed.ts)와 설치 verb(delivery/apps.ts org_app_install)의 **공용 코어** — 두 경로가 같은
//  설치 시맨틱을 쓰도록 한 곳에 둔다(선례: seed 가 인라인하던 diff/runInstall 블록을 여기로 승격).
import { getApp, listComponents, upsertUiAsset, pruneUiAssets, upsertRuntimeAsset, pruneRuntimeAssets } from "../org/store/apps.js";
import type { LoadedApp } from "./loader.js";
import { ensureAppTables, appSchemaFor, cleanupDroppedTables, checkAppTableFuse, emptyTableReport, type AppTableReport, type DroppedTablesReport } from "./store-schema.js";
import { isBuiltinSource, physicalTableName } from "./store-ddl.js";
import { notifyAppInstaller } from "./notify.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { WriteCtx } from "../org/store/audit.js";
import { diffComponents, type AppComponentRef } from "./install-plan.js";
import { runInstall, type InstallAppMeta } from "./install.js";
import { makeDeployDeps } from "./deploy.js";
import { isOverrideSource, newTablesForOverride } from "./app-versions.js";

/** 설치가 데이터 테이블에 한 일(#4224) — 워크스페이스가 설치한 앱에서만 채워진다(기본 앱은 코드가 구조의 주인). */
export type InstallTablesOutcome = AppTableReport & DroppedTablesReport & { schema: string };
export interface InstallOutcome { id: string; created: boolean; components: number; tables?: InstallTablesOutcome }

/** 매니페스트(저장된 것 포함)의 data.tables 이름들. 모양이 어긋나도 던지지 않는다 — 옛 설치의 매니페스트를 읽는 자리다. */
function declaredTableNames(manifest: unknown): string[] {
  const t = (manifest as { data?: { tables?: Array<{ name?: unknown }> } } | null)?.data?.tables;
  return Array.isArray(t) ? t.map((x) => String(x?.name ?? "")).filter(Boolean) : [];
}

/** 알림을 받을 사람 — 설치를 요청한 구성원. 사람이 아닌 행위자(시더·익명)면 보내지 않는다. */
function installerOf(ctx: WriteCtx): string | null {
  const a = String(ctx.actor ?? "").trim();
  return a && a !== "unknown" && a !== "system" ? a : null;
}

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

  // 앱 데이터 테이블(D6) — 스키마는 누가 구조의 주인인가로 가른다(store-ddl.appSchemaName, #4223).
  const builtin = isBuiltinSource(source);
  const schema = appSchemaFor(builtin);
  const tableSpecs = loaded.manifest.data.tables.map((t) => ({ table: t.name, columns: t.columns, indexes: t.indexes }));
  let tables: InstallTablesOutcome | undefined;
  if (!builtin) {
    // 이름 사전검증(#4224) — 하이픈 id·63자 초과는 여기서 400. ensureAppTables 안에서 나면 «만들지 못했다(503)» 로 뭉개진다.
    for (const t of tableSpecs) physicalTableName(id, t.table);
    // 워크스페이스 퓨즈 — 이 설치로 테이블이 상한을 넘으면 아무것도 바꾸지 않고 거절한다.
    if (tableSpecs.length) {
      const fuse = await checkAppTableFuse(id, tableSpecs.map((t) => t.table), schema);
      if (!fuse.ok) {
        const msg = `이 워크스페이스의 앱 테이블이 상한(${fuse.limit}개)을 넘게 됩니다 — 지금 ${fuse.current}개 · 보관 ${fuse.archived}개 · 이번에 새로 ${fuse.adding}개. 쓰지 않는 앱을 제거하거나 관리자에게 알려 주세요`;
        const who = installerOf(ctx);
        if (who) await notifyAppInstaller({ appId: id, memberId: who, title: `앱 '${loaded.manifest.title}' 설치를 거절했습니다`, body: msg, dedupe_key: `app-table-fuse:${id}` }).catch(() => undefined);
        throw new HttpError(409, `앱 '${id}' 설치 거절: ${msg}`);
      }
    }
    // ★ 사람이 요청한 설치는 테이블을 **먼저, 엄격하게** 만든다 — 실패면 아무것도 설치하지 않고 원인을 돌려준다.
    //  종전엔 설치를 끝낸 뒤 경고만 남겨 «설치 성공, 데이터 층 없음» 이 됐다(매니지드 실측 2026-09-22).
    //  (빈 테이블이 남는 쪽은 무해하다 — CREATE IF NOT EXISTS 라 다음 설치가 그대로 쓴다.) 이미 있는 테이블엔 늘어난 칸을 더한다.
    const report = emptyTableReport();
    //  #4226 — 자유 SQL 역할도 여기서 맞춘다(비치명 — 못 만들면 report.sql_role 에 까닭이 남고 store_sql 만 막힌다).
    await ensureAppTables(id, tableSpecs, { schema, strict: true, report, sqlRole: true });
    tables = { ...report, dropped: [], archived: [], failed: [], schema };
  } else if (isOverrideSource(source)) {
    // #4600 — 워크스페이스가 덮어쓴 빌트인: 표는 그대로 빌트인 스키마에 살지만(코드가 구조의 주인이던 자리), 구성원이 **새로 선언한 표**는
    //  워크스페이스 앱과 같은 관문을 지난다 — 이름 사전검증(63자·식별자)과 퓨즈(워크스페이스 표 상한). 릴리스가 만든 기존 표는 그대로.
    //  생성 자체는 아래 빌트인 경로(비치명 ensureAppTables)가 한다 — 덮어쓰기가 표 하나 못 만들었다고 화면까지 안 바뀌면 안 된다.
    const fresh = newTablesForOverride(existing?.manifest, tableSpecs.map((t) => t.table));
    for (const t of fresh) physicalTableName(id, t);
    if (fresh.length) {
      const fuse = await checkAppTableFuse(id, fresh, schema);
      if (!fuse.ok) {
        throw new HttpError(409, `앱 '${id}' 저장 거절: 새 표 ${fresh.length}개로 이 워크스페이스의 앱 테이블이 상한(${fuse.limit}개)을 넘게 됩니다 — 지금 ${fuse.current}개 · 보관 ${fuse.archived}개`);
      }
    }
  }

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

  // 기본 앱 시딩은 종전처럼 비치명 — 워크스페이스마다 주기적으로 돌고, 여기서 던지면 시딩 전체가 보상(롤백)된다.
  //  빠진 테이블은 store_* 첫 호출의 지연 복구가 채운다(capabilities/app-store withTableRepair).
  if (builtin) {
    try { await ensureAppTables(id, tableSpecs, { schema, tenantScopedIndexes: true }); }
    catch (err) { logger.warn({ err, id }, "앱 데이터 테이블 보장 실패(비치명 — 첫 사용 때 지연 복구)"); }
  }

  for (const c of drop) {
    try { await deps.reclaim(c); } catch { /* best-effort — 저널이 스위퍼를 부른다 */ }
    try { await deps.removeComponent(id, c); } catch { /* best-effort */ }
  }

  // 매니페스트에서 빠진 테이블(#4224) — 설치가 active 로 저널된 **뒤에** 정리한다(설치가 실패해 보상되면 옛 선언이 살아
  //  있어야 하므로 앞에서 지우지 않는다). 비었으면 DROP, 데이터가 있으면 보관 스키마로 옮기고 설치한 사람에게 알린다.
  if (tables && existing) {
    const next = new Set(tableSpecs.map((t) => t.table));
    const gone = declaredTableNames(existing.manifest).filter((t) => !next.has(t));
    if (gone.length) {
      const cleaned = await cleanupDroppedTables(id, gone, schema);
      tables = { ...tables, ...cleaned };
      const who = installerOf(ctx);
      if (who && (cleaned.archived.length || cleaned.failed.length)) {
        const parts = [
          ...cleaned.archived.map((a) => `'${a.table}'(${a.rows}행) → ${a.archived_as} 로 보관`),
          ...cleaned.failed.map((f) => `'${f.table}' 정리 실패 — 그 자리에 둠`),
        ];
        await notifyAppInstaller({
          appId: id, memberId: who,
          title: `앱 '${loaded.manifest.title}' 에서 빠진 테이블에 데이터가 있어 보관했습니다`,
          body: `매니페스트에서 빠진 테이블을 지우지 않고 옮겨 두었습니다: ${parts.join(" · ")}. 앱 화면과 세션에서는 더 보이지 않지만 데이터는 DB 의 보관 스키마에 그대로 남아 있습니다.`,
        }).catch((err) => logger.warn({ err, id }, "보관 알림 발송 실패(비치명)"));
      }
    }
  }
  return { id, created: !existing, components, tables };
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
