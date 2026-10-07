// 빌트인 앱 시더 — 코드 소유(apps/builtin/<id>) 앱을 게이트웨이 부팅 시 idempotent 하게 설치/갱신한다(#1780).
//
//  seed-content.ts(디폴트 지식·훅·스킬)와 같은 규약이되 대상이 **앱 패키지**다:
//   · 시맨틱: 빌트인 앱은 코드 소유 → content_hash 가 바뀔 때만 재시딩(운영자 토글·상태는 앱 저널이 관리).
//   · 멱등: 두 번째 호출은 content_hash 동일 + status=active 이면 전부 skip.
//   · 비치명: 시딩 실패는 부팅을 막지 않는다(호출부가 .catch — housekeeping best-effort 스텝).
//
//  경로: REPO_ROOT = 이 모듈(dist/apps/seed.js)의 두 단계 위 = 레포 루트(agent-bundle.ts 와 동일 관례).
//   apps/builtin 은 src 밖(코드 소유 데이터)이라 컴파일되지 않고 레포 루트에 그대로 있다.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { logger } from "../log.js";
import type { WriteCtx } from "../org/store/audit.js";
import { getApp, setAppBuiltinVersion, withAppInstallLock } from "../org/store/apps.js";
import { loadAppPackage } from "./loader.js";
import { installLoadedApp, persistUiAssets, persistRuntimeAsset } from "./install-run.js";
import { removeInstalledApp } from "./remove-run.js";
import { isBuiltinSource } from "./store-ddl.js";
import { builtinAppsRoot } from "./builtin-root.js";
import { isOverrideSource, seedShouldSkipOverride } from "./app-versions.js";

export interface SeedBuiltinAppsResult { seeded: string[]; skipped: string[]; updated: string[]; retired: string[] }

/**
 * 시더가 부르는 부작용들 — 기본은 실제 스토어·설치 코어. 유닛 시험(seed-override.test.ts)이 가짜를 주어 **배선**을 못박는다
 *  (덮어쓴 행이면 install 이 안 불리고 builtin_version 만 갱신되는지 — 순수 판정 함수만 시험하면 호출을 지워도 초록이다. 격리 리뷰 8).
 */
export interface SeedDeps {
  getApp: typeof getApp;
  installLoadedApp: typeof installLoadedApp;
  setAppBuiltinVersion: typeof setAppBuiltinVersion;
  persistUiAssets: typeof persistUiAssets;
  persistRuntimeAsset: typeof persistRuntimeAsset;
  withAppInstallLock: typeof withAppInstallLock;
  removeInstalledApp: typeof removeInstalledApp;
}
const realSeedDeps: SeedDeps = { getApp, installLoadedApp, setAppBuiltinVersion, persistUiAssets, persistRuntimeAsset, withAppInstallLock, removeInstalledApp };

// 은퇴한 빌트인 앱(#4554) — 패키지를 제품에서 뺀 앱. 패키지 폴더를 지우는 것만으로는 이미 설치된 워크스페이스에 그대로 남는다
//  (시더는 있는 폴더만 돌고, 제거 verb 는 builtin 을 막는다). 그래서 뺀 앱은 여기 적고 시더가 회수한다.
//   · hello(「안녕 앱」) — 앱이 어떻게 도는지 보여 주던 예시 앱(원준 2026-10-04 "안녕앱은 그냥 지워버려줘").
//  ⚠ «폴더에 없는 builtin 은 전부 회수» 로 일반화하지 않는다 — 폴더가 통째로 빠진 배포(seed-shipped.test.ts 가 막는 사고)에서
//   빌트인 앱 전부를 지우게 된다. 지울 앱은 이름으로 적는다.
export const RETIRED_BUILTIN_APPS: readonly string[] = ["hello"];

/**
 * 은퇴한 빌트인 앱을 회수할지 — 순수 판정.
 *  · 은퇴 목록에 없으면 안 지운다.
 *  · 이번에 읽은 패키지 폴더에 **아직 있으면** 안 지운다(되살린 앱 · 시험 픽스처를 방금 심고 곧바로 지우지 않는다).
 *  · 설치돼 있지 않으면 지울 것이 없다.
 *  · 설치된 것이 builtin 이 아니면 안 지운다 — 워크스페이스가 같은 id 로 직접 만든 앱은 그 워크스페이스의 것이다.
 *  · 빌트인을 워크스페이스가 **덮어쓴** 것(#4600 source.overrides_builtin)도 안 지운다 — 사람이 고쳐 쓰는 그 워크스페이스의 판이다.
 */
export function shouldRetireBuiltin(id: string, present: ReadonlySet<string>, existing: { source?: unknown } | null | undefined,
  retired: readonly string[] = RETIRED_BUILTIN_APPS): boolean {
  return retired.includes(id) && !present.has(id) && !!existing && isBuiltinSource(existing.source) && !isOverrideSource(existing.source);
}

/**
 * apps/builtin/<id> 를 열거해 각 앱을 설치/갱신하고, 은퇴한 빌트인 앱을 회수한다.
 *  - existing 없음        → runInstall(신규 설치).                            → seeded
 *  - content_hash 동일 & status=active → 아무것도 안 함.                       → skipped
 *  - 그 외(변경·이전 실패) → 새 계획으로 runInstall(멱등 재전개) + drop 회수.  → updated
 *  - 은퇴 목록(RETIRED_BUILTIN_APPS)의 앱이 builtin 으로 남아 있음 → 회수.  → retired
 * 멱등: 변경 없는 앱은 다음 호출부터 전부 skipped, 회수한 앱은 다음 호출부터 없다.
 * @param root 패키지 폴더(기본 = 이 레포의 apps/builtin). 시험이 픽스처 폴더를 심을 때만 준다.
 * @param deps 부작용(스토어·설치) — 기본은 실제. 유닛 시험만 가짜를 준다.
 */
export async function seedBuiltinApps(root: string = builtinAppsRoot(), deps: SeedDeps = realSeedDeps): Promise<SeedBuiltinAppsResult> {
  const res: SeedBuiltinAppsResult = { seeded: [], skipped: [], updated: [], retired: [] };

  let dirents: string[];
  try {
    dirents = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return res; // apps/builtin 부재 = 빌트인 앱 없음(비치명)
  }

  const ctx: WriteCtx = { actor: "system", source: "migration" };
  const present = new Set<string>();   // 이번에 읽은 패키지의 앱 id — 은퇴 판정이 «아직 있는 앱» 을 건드리지 않게 한다

  for (const name of dirents) {
    const dir = path.join(root, name);
    let loaded;
    try {
      loaded = await loadAppPackage(dir);
    } catch (err) {
      logger.warn({ err, dir }, "빌트인 앱 로드 실패(건너뜀)");
      continue;
    }

    const id = loaded.manifest.id;
    present.add(id);
    const existing = await deps.getApp(id);
    // #4600 — 워크스페이스가 이 빌트인을 덮어썼다(app_save). 부팅 시딩이 덮으면 사람이 고친 판이 릴리스 원본으로 조용히 돌아간다.
    //  설치는 건너뛰고 폴더의 릴리스 판 번호만 적어 둔다 — 화면이 「원본에 새 판이 있다」 를 알리는 재료. 되돌아가는 길은 app_revert(원본 판).
    if (seedShouldSkipOverride(existing)) {
      await deps.setAppBuiltinVersion(id, loaded.manifest.version).catch((err) => logger.warn({ err, id }, "빌트인 판 번호 기록 실패(비치명)"));
      res.skipped.push(id);
      continue;
    }
    if (existing && existing.content_hash === loaded.contentHash && existing.status === "active") {
      // 패키지는 안 바뀌었지만 UI 자산은 뒤늦게 도입됐다(PR5) — 없으면 백필(멱등, 기존 설치 앱 마이그레이션).
      if (loaded.uiAssets.length > 0) await deps.persistUiAssets(loaded);
      if (loaded.runtimeAsset) await deps.persistRuntimeAsset(loaded);
      await deps.setAppBuiltinVersion(id, loaded.manifest.version).catch(() => undefined);   // 판 이력 도입 전 설치 백필(같은 값이면 안 쓴다)
      res.skipped.push(id);
      continue;
    }

    try {
      // builtin 은 코드 소유 → source={kind:'builtin'}. 공용 코어가 저널드 설치 + update-diff 를 처리한다.
      const outcome = await deps.installLoadedApp(loaded, { kind: "builtin" }, ctx);
      await deps.setAppBuiltinVersion(id, loaded.manifest.version).catch((err) => logger.warn({ err, id }, "빌트인 판 번호 기록 실패(비치명)"));
      (outcome.created ? res.seeded : res.updated).push(id);
    } catch (err) {
      // runInstall 은 실패 시 저널 status=failed 를 남기고 보상한다 — 부팅 스위퍼가 잔재를 회수한다. 다음 시딩이 재시도.
      logger.warn({ err, id }, "빌트인 앱 설치 실패(비치명 — 다음 시딩이 재시도)");
    }
  }

  // 은퇴한 빌트인 앱 회수(#4554) — 제거 verb 와 같은 코어(전개물 회수 → 데이터 떠 두기 → 앱 행). 실패는 비치명(다음 시딩이 재시도).
  for (const id of RETIRED_BUILTIN_APPS) {
    try {
      const done = await deps.withAppInstallLock(id, async () => {
        const existing = await deps.getApp(id);   // 락 안에서 다시 읽는다 — 그새 다른 경로가 지웠거나 다시 깔았을 수 있다
        if (!existing || !shouldRetireBuiltin(id, present, existing)) return false;
        await deps.removeInstalledApp(existing, ctx);
        return true;
      });
      if (done) res.retired.push(id);
    } catch (err) {
      logger.warn({ err, id }, "은퇴한 빌트인 앱 회수 실패(비치명 — 다음 시딩이 재시도)");
    }
  }

  return res;
}
