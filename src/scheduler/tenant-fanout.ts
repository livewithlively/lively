// 주기 작업의 워크스페이스 순회 (#2418) — cron 틱과 위탁 큐가 공유한다.
//
//  ── 무엇이 문제였나 ──
//  `org_cron`·`org_task` 는 워크스페이스별로 행이 갈리는 테이블(RLS)이고, 어느 행을 볼지는 DB 세션 변수
//  `app.tenant_id` 가 정한다. 그런데 주기 타이머는 **테넌트 컨텍스트 밖**에서 돌아 조회가 기본 테넌트(primary)로
//  떨어졌다. 그 결과 **primary 가 아닌 워크스페이스의 잡·태스크는 enabled/queued 여도 아예 안 보였다.**
//  화면엔 켜져 있는데 영원히 안 도는 상태다(실측 2026-08-30: 페르소나 5곳에서 레인·잡이 다 정상인데
//  미증류 자료가 그대로 남았고, 위탁 배치 6건이 45분 넘게 queued 로 굳었다 — 손으로 부르면 정상 동작).
//
//  ── 규율 ──
//  · 샤딩(ownsTenant)을 존중한다 — 이 프로세스가 담당하지 않는 테넌트는 건드리지 않는다.
//  · 레지스트리가 없으면(단일 테넌트 배포) **종전 그대로 1회** — 무회귀가 기본값이다.
//  · 판정(planSchedulerTargets)은 순수 함수 — 엣지 표로 검증한다.
import { ownsTenant, type TenantContext } from "../org/tenant-context.js";
import { resolveBindingMode, type BindingMode } from "../db/tenant-binding-boot.js";

export interface FanoutWorkspace { id: string; slug: string; state: string }

/**
 * 순회 대상 판정(순수).
 *
 * ⚠ **바인딩 모드가 `currentTenant()` 를 읽는 모드일 때만 순회한다.**
 *  `off`(단일 테넌트)·`fixed`(프로세스당 테넌트 하나)에서는 리졸버가 컨텍스트를 아예 안 본다 —
 *  그 모드에서 순회하면 `withTenant` 가 풀에 아무 영향을 못 주고 **같은 잡을 워크스페이스 수만큼
 *  반복 실행**하게 된다(기존 고객 대부분이 이 모드다). 그래서 여기서 잘라 종전 경로로 보낸다.
 *
 * @returns `null` = 순회 안 함 → 호출부는 **종전 경로로 1회** 돈다.
 *          `[]`   = 담당 테넌트 없음 → 아무것도 하지 않는다(남의 것을 대신 돌리지 않는다).
 */
export function planSchedulerTargets(
  workspaces: ReadonlyArray<FanoutWorkspace>,
  owns: (slug: string) => boolean,
  mode: BindingMode,
): TenantContext[] | null {
  if (mode !== "registry" && mode !== "request") return null;
  if (!workspaces.length) return null;
  return workspaces
    .filter((w) => w.state === "active" && owns(w.slug))
    .map((w) => ({ id: w.id, slug: w.slug }));
}

/** 실제 대상 조회 — 레지스트리 테이블 부재·조회 실패는 `null`(종전 경로)로 수렴한다. */
export async function schedulerTargets(): Promise<TenantContext[] | null> {
  try {
    const { listWorkspaces } = await import("../org/tenancy/registry.js");
    const mode = resolveBindingMode().mode;
    if (mode !== "registry" && mode !== "request") return null;   // 조회 전에 자른다(불필요한 DB 호출 방지)
    return planSchedulerTargets(await listWorkspaces(), (slug) => ownsTenant(slug), mode);
  } catch {
    return null;
  }
}
