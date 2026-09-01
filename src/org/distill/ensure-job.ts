// 증류기를 켜면 **그것을 실제로 돌릴 잡**이 반드시 있게 한다 (#2415).
//
//  ── 왜 필요한가 (실측 2026-08-30) ──
//  증류 잡을 자동 등록하는 것은 프리셋 셋뿐이고(local·github·figma), `org_distiller_upsert` 로 만든 증류기는
//  **잡을 갖지 않는다.** 게다가 처음 설정이 심는 잡은 `params.distiller='local-files'` 로 **한 증류기에 묶여 있어**
//  나중에 켠 것을 접수하지 않는다. 그 결과가 이것이다 — 레인 8개 켜짐 · 미증류 자료 20건 그대로 · 화면은 전부 초록불.
//  `local-preset.ts` 의 주석이 이 상태를 정확히 예고해 뒀다: "잡이 없으면 초록불인데 아무것도 안 도는 상태가 된다."
//
//  ── 왜 잡을 늘리지 않고 '푸는가' ──
//  `distill_sources_headless` 의 `distiller` 는 **선택**이고, 비우면 `pickDistillerBatch(params,{one:false})` 가
//  **켜진 증류기 전부**를 각각 배치로 접수한다(scheduler/actions/distill.ts). 그래서 잡 하나면 충분하다 —
//  레인마다 잡을 만들면 같은 일을 레인 수만큼 한다.
//
//  ── 규율 ──
//  · 사람이 꺼 둔 잡을 되살리지 않는다(마스터킬 보존).
//  · 운영자가 만든 잡의 params 를 말없이 고치지 않는다 — **처음 설정이 심은 잡만** 넓힌다.
//  · 판정(planDistillJob)은 순수 함수 — 엣지 표로 검증한다.
import { LOCAL_DISTILL_JOB_ID, LOCAL_DISTILL_INTERVAL_SEC } from "./local-preset.js";

/** 전체 접수 잡을 새로 만들 때 쓰는 id — 심은 잡(local-files 전용)과 구분된다. */
export const ALL_LANES_JOB_ID = "distill-lanes";

export interface DistillJobRow {
  id: string;
  enabled: boolean;
  /** org_cron.params — `{distiller?: string}`. 비었거나 공백이면 '켜진 증류기 전부'. */
  params: Record<string, unknown> | null;
}

export type DistillJobPlan =
  | { action: "none"; reason: string }
  | { action: "widen"; jobId: string; reason: string }
  | { action: "create"; jobId: string; reason: string };

/** params.distiller 를 정규화 — 문자열이 아니거나 공백뿐이면 '지정 없음'(= 전체 접수). */
function pinnedTo(row: DistillJobRow): string {
  const v = (row.params ?? {}).distiller;
  return typeof v === "string" ? v.trim() : "";
}

/** 이 잡이 그 증류기를 접수하나 — 켜져 있고, 묶임이 없거나(전체) 바로 그 증류기에 묶였을 때. */
function covers(row: DistillJobRow, distillerKey: string): boolean {
  if (!row.enabled) return false;
  const pin = pinnedTo(row);
  return pin === "" || pin === distillerKey;
}

/**
 * 켠 증류기 하나를 놓고 무엇을 해야 하는지 정한다(순수).
 *
 * @param jobs 이 워크스페이스의 `distill_sources_headless` 잡 전부(꺼진 것 포함)
 * @param distillerKey 방금 켜진 증류기의 key
 */
export function planDistillJob(jobs: readonly DistillJobRow[], distillerKey: string): DistillJobPlan {
  const key = String(distillerKey ?? "").trim();
  if (!key) return { action: "none", reason: "증류기 key 가 없어 판정하지 않았다" };

  const covering = jobs.find((j) => covers(j, key));
  if (covering) return { action: "none", reason: `잡 '${covering.id}' 가 이미 접수한다` };

  // 심은 잡이 켜진 채 다른 증류기에 묶여 있으면 그 묶음을 푼다 — 잡을 늘리지 않는다.
  const seeded = jobs.find((j) => j.id === LOCAL_DISTILL_JOB_ID && j.enabled && pinnedTo(j) !== "");
  if (seeded) {
    return { action: "widen", jobId: seeded.id, reason: `'${seeded.id}' 가 '${pinnedTo(seeded)}' 하나에 묶여 있어 전체 접수로 넓힌다` };
  }

  // 증류 잡이 아예 없다 → 전체 접수 잡을 만든다.
  if (!jobs.length) return { action: "create", jobId: ALL_LANES_JOB_ID, reason: "증류 잡이 없어 새로 만든다" };

  // 심은 잡이 없고 운영자 잡만 있는데 그중 접수하는 것이 없다 → 남의 잡을 건드리지 않고 하나 만든다.
  //  단 **전부 꺼져 있다면** 사람이 증류를 통째로 꺼 둔 것이므로 되살리지 않는다.
  if (jobs.some((j) => j.enabled)) return { action: "create", jobId: ALL_LANES_JOB_ID, reason: "켜진 잡이 이 증류기를 접수하지 않아 전체 접수 잡을 만든다" };
  return { action: "none", reason: "증류 잡이 전부 꺼져 있다 — 사람이 끈 것을 되살리지 않는다" };
}

/**
 * 계획을 실제로 적용한다. 실패는 던지지 않는다 — 증류기 저장은 이미 끝났고, 잡 정비는 그것을 되돌릴 이유가 아니다.
 * @returns 무엇을 했는지(로그·요약용). 아무것도 안 했으면 action='none'.
 */
export async function ensureDistillJob(distillerKey: string, actor?: string | null): Promise<DistillJobPlan> {
  const { itemsPool } = await import("../../db/client.js");
  const { upsertCronJob } = await import("../cron-store.js");

  let jobs: DistillJobRow[] = [];
  try {
    const r = await itemsPool.query(
      `SELECT id, enabled, params FROM org_cron WHERE action='distill_sources_headless'`);
    jobs = r.rows as DistillJobRow[];
  } catch {
    return { action: "none", reason: "잡 목록을 읽지 못했다(테이블 부재 등)" };
  }

  const plan = planDistillJob(jobs, distillerKey);
  try {
    if (plan.action === "widen") {
      // params 에서 distiller 만 뺀다 — 노드 고정·의뢰자 등 나머지 설정은 보존한다.
      await itemsPool.query(
        `UPDATE org_cron SET params = COALESCE(params,'{}'::jsonb) - 'distiller', updated_at=now(), updated_by=$2
          WHERE id=$1`, [plan.jobId, actor ?? null]);
    } else if (plan.action === "create") {
      await upsertCronJob({
        id: plan.jobId, label: "자료 증류 — 켜진 레인 전부", action: "distill_sources_headless",
        params: JSON.stringify({}), interval_sec: LOCAL_DISTILL_INTERVAL_SEC, cron_expr: null, enabled: true,
        note: "증류기를 켤 때 자동 등록(#2415). distiller 를 비워 켜진 증류기 전부를 각각 배치로 접수한다 — 레인마다 잡을 만들지 않는다.",
        run_once: null, actor: actor ?? null,
      });
    }
  } catch (e) {
    return { action: "none", reason: `잡 정비 실패: ${(e as Error)?.message ?? e}` };
  }
  return plan;
}
