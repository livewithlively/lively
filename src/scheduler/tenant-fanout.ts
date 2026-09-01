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
import { ownsTenant, withTenant, type TenantContext } from "../org/tenant-context.js";
import { resolveBindingMode, type BindingMode } from "../db/tenant-binding-boot.js";
import { logger } from "../log.js";

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

/**
 * 이 정비를 **워크스페이스마다** 돌린다 (#2479) — 주기 스윕용 `tickAllTenants` 상당물.
 *
 *  ── 왜 필요한가 ──
 *  registry 모드(#1750 셀프호스트 다중 워크스페이스)에서 부팅 하우스키핑은 **돈다.** 다만 타이머가
 *  테넌트 컨텍스트 **밖**이라 리졸버가 primary 로 떨어뜨린다. 그래서 비-primary 워크스페이스의
 *  정비가 통째로 안 온다 — 매니지드(request)와 **같은 최종상태에 다른 길로** 도착한다.
 *  매니지드에는 요청 정비표(`sessions/outbox-request-sweep.ts`)라는 대체 경로가 있지만 그 표는
 *  `requestScopedTenancy()`(= `&& !registryModeActive()`) 뒤라 registry 에서 무동작이고,
 *  CP 틱은 셀프호스트에 CP 자체가 없다. **registry 에는 닿는 길이 하나도 없었다.**
 *
 *  실측(2026-09-01 · dev.lvly.io · 워크스페이스 약 90개): 아웃박스 청소 잔존이 비-primary
 *  81곳에 245건(최고 12일)인데 **primary 는 0건**이었다. 청소 로직은 멀쩡하고 그 워크스페이스에
 *  **안 온 것**이다 — primary 의 0 이 그 대조군이다.
 *
 *  ── 규율(위 `planSchedulerTargets` 와 같다) ──
 *  · `null`(단일 테넌트 배포) = **종전 그대로 1회.** 무회귀가 기본값이다.
 *  · `[]`(담당 없음) = 아무것도 안 한다 — 남의 것을 대신 돌리지 않는다.
 *  · 한 워크스페이스의 실패가 나머지를 막지 않는다.
 *
 *  ⚠ **파괴적인 정비를 여기 태우지 마라.** 순회가 붙는 순간 그 동작이 *남의* 워크스페이스에서
 *   일어난다. `reapIdleSessions`(tmux 를 죽인다)를 일부러 뺀 이유이고, 그 판단은 #2148 의 몫이다.
 *
 *  ⓘ `targetsOf` 는 시험용 seam 이다 — 대상 조회가 env·DB·동적 import 를 타서, 주입 없이는
 *   «순회했나»를 실제로 잴 수가 없다(로그를 세는 시험은 동작이 아니라 로그를 잠근다).
 *   운영 호출은 인자를 주지 않는다.
 */
export async function forEachTenant(
  job: string,
  fn: () => Promise<unknown>,
  targetsOf: () => Promise<TenantContext[] | null> = schedulerTargets,
): Promise<void> {
  const targets = await targetsOf();
  if (targets === null) { await fn(); return; }   // 종전 경로 — 컨텍스트를 만들지 않는다
  for (const t of targets) {
    try { await withTenant(t, fn); }
    catch (err) { logger.warn({ err, workspace: t.slug, job }, "정비 tick 실패(워크스페이스) — 나머지는 계속"); }
  }
}
