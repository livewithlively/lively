// 앱 설치 오케스트레이터 — 저널드 2-phase(#1780, design R2-1). **단일 DB 트랜잭션이 불가**한 설치를
//  저널(org_app.status) + component 선기록 + 실패 시 역순 보상으로 원자성에 준하게 만든다.
//  왜 tx 가 안 되나: 전개 대상(org_harness_asset·org_tool·cron·url_allowlist)이 autocommit 스토어라
//  한 tx 에 못 묶이고, app 스키마 DDL 은 다른 커넥션(부팅 자식), tar 추출·정적 서빙은 DB 밖이다.
//
// 전개 실행기(deploy/reclaim)는 **주입**한다 — 오케스트레이션(저널·순서·보상)만 여기서 순수하게 다루고
//  fail-first 로 검증한다. 실제 스토어 호출은 능력 레이어(delivery/apps.ts)가 deps 로 넣는다.
import type { AppComponentRef } from "./install-plan.js";

// 전개 1건 = 계획된 component + 그 전개에 필요한 payload(kind 별로 deploy 가 해석: 자산 body·툴 def·크론 schedule…).
export interface DeployItem { comp: AppComponentRef; payload: unknown }

export interface InstallAppMeta {
  id: string; title: string; version: string; manifest: unknown; source: unknown; content_hash: string | null;
}

// 오케스트레이터가 부르는 부작용들 — 실제 구현은 능력 레이어가 주입(스토어 호출). 순수 테스트에선 mock.
export interface InstallDeps {
  upsertApp(meta: InstallAppMeta, status: "installing"): Promise<void>;
  setStatus(id: string, status: "active" | "failed"): Promise<void>;
  addComponent(appId: string, comp: AppComponentRef): Promise<void>;   // 저널: 전개 **전에** 기록
  removeComponent(appId: string, comp: AppComponentRef): Promise<void>; // 보상: 조인 제거
  deploy(item: DeployItem): Promise<void>;   // 실제 전개(스토어 upsert 등)
  reclaim(comp: AppComponentRef): Promise<void>; // 보상: 전개된 대상 회수(스토어 remove/disable)
}

export class InstallError extends Error {
  constructor(message: string, readonly appId: string, readonly failedAt: AppComponentRef, readonly cause: unknown) {
    super(message);
    this.name = "InstallError";
  }
}

/**
 * 저널드 설치. 순서:
 *  1) upsertApp(status=installing) — 저널 시작.
 *  2) 각 item: addComponent(선기록) → deploy(전개). 성공분을 done 에 쌓는다.
 *  3) 전부 성공 → setStatus(active).
 *  4) 어느 하나라도 실패 → **역순 보상**(deploy 성공분을 reclaim + component 제거) → setStatus(failed) → InstallError throw.
 *     ⚠ 보상은 best-effort(보상 중 오류는 삼키고 계속) — 저널 status=failed 가 남으므로 부팅 스위퍼가 잔재를 회수한다.
 * 반환: 전개된 component 수(성공 시).
 */
export async function runInstall(meta: InstallAppMeta, items: DeployItem[], deps: InstallDeps): Promise<number> {
  await deps.upsertApp(meta, "installing");
  const done: DeployItem[] = [];
  try {
    for (const item of items) {
      await deps.addComponent(meta.id, item.comp);   // 선기록 — 실패해도 무엇을 심으려 했는지 저널에 남는다
      await deps.deploy(item);
      done.push(item);
    }
    await deps.setStatus(meta.id, "active");
    return done.length;
  } catch (err) {
    // 역순 보상 — 나중에 전개한 것부터 되돌린다(의존 역순 안전).
    for (let i = done.length - 1; i >= 0; i--) {
      const c = done[i].comp;
      try { await deps.reclaim(c); } catch { /* best-effort — status=failed 가 스위퍼를 부른다 */ }
      try { await deps.removeComponent(meta.id, c); } catch { /* 같음 */ }
    }
    // 실패한 item 의 선기록 component 도 제거(deploy 전 실패라 done 에 없다).
    const failedItem = items[done.length];
    if (failedItem) { try { await deps.removeComponent(meta.id, failedItem.comp); } catch { /* best-effort */ } }
    try { await deps.setStatus(meta.id, "failed"); } catch { /* 스위퍼가 installing/failed 잔재 회수 */ }
    const at = failedItem?.comp ?? { kind: "?", ref: "?" };
    throw new InstallError(`앱 '${meta.id}' 설치 실패 (${at.kind}/${at.ref}): ${(err as Error)?.message ?? err}`, meta.id, at, err);
  }
}
