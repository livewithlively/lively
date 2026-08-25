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
import { fileURLToPath } from "node:url";
import { logger } from "../log.js";
import type { WriteCtx } from "../org/store/audit.js";
import { getApp } from "../org/store/apps.js";
import { loadAppPackage } from "./loader.js";
import { installLoadedApp, persistUiAssets, persistRuntimeAsset } from "./install-run.js";

export interface SeedBuiltinAppsResult { seeded: string[]; skipped: string[]; updated: string[] }

// apps/builtin 의 절대 경로 — 모듈 기준(cwd 무관: blue/green 심링크·다른 cwd 에서도 자기 레포의 파일을 읽는다).
function builtinAppsRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "builtin");
}

/**
 * apps/builtin/<id> 를 열거해 각 앱을 설치/갱신한다.
 *  - existing 없음        → runInstall(신규 설치).                            → seeded
 *  - content_hash 동일 & status=active → 아무것도 안 함.                       → skipped
 *  - 그 외(변경·이전 실패) → 새 계획으로 runInstall(멱등 재전개) + drop 회수.  → updated
 * 멱등: 변경 없는 앱은 다음 호출부터 전부 skipped.
 */
export async function seedBuiltinApps(): Promise<SeedBuiltinAppsResult> {
  const res: SeedBuiltinAppsResult = { seeded: [], skipped: [], updated: [] };
  const root = builtinAppsRoot();

  let dirents: string[];
  try {
    dirents = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return res; // apps/builtin 부재 = 빌트인 앱 없음(비치명)
  }

  const ctx: WriteCtx = { actor: "system", source: "migration" };

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
    const existing = await getApp(id);
    if (existing && existing.content_hash === loaded.contentHash && existing.status === "active") {
      // 패키지는 안 바뀌었지만 UI 자산은 뒤늦게 도입됐다(PR5) — 없으면 백필(멱등, 기존 설치 앱 마이그레이션).
      if (loaded.uiAssets.length > 0) await persistUiAssets(loaded);
      if (loaded.runtimeAsset) await persistRuntimeAsset(loaded);
      res.skipped.push(id);
      continue;
    }

    try {
      // builtin 은 코드 소유 → source={kind:'builtin'}. 공용 코어가 저널드 설치 + update-diff 를 처리한다.
      const outcome = await installLoadedApp(loaded, { kind: "builtin" }, ctx);
      (outcome.created ? res.seeded : res.updated).push(id);
    } catch (err) {
      // runInstall 은 실패 시 저널 status=failed 를 남기고 보상한다 — 부팅 스위퍼가 잔재를 회수한다. 다음 시딩이 재시도.
      logger.warn({ err, id }, "빌트인 앱 설치 실패(비치명 — 다음 시딩이 재시도)");
    }
  }

  return res;
}
