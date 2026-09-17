// 자동 실행 카드(context-stage-job)가 **어느 잡을 대표로 보여 주고, 끌 때 무엇을 끄는지** — 순수 규칙(#4052 후속).
//
//  왜 따로 뺐나: 한 단계에 같은 일을 하는 잡이 여럿 켜질 수 있다(증류: 처음 설정이 심은 local-files 전용 잡 + 전체 접수 잡,
//   옛 매니지드 워크스페이스의 distill-lanes + distill-sources-headless). 종전 카드는 목록(sort, id) 순 «첫 켜진 잡» 하나만
//   보여 주고 그것만 껐다 —
//   ① 전용 잡이 목록 앞에 오면 카드가 그 잡의 주기(10분)로 말하는데, 대부분의 레인은 다른 잡(30분)이 돌렸고
//   ② 스위치를 꺼도 다른 잡이 계속 돌아 다시 그리면 여전히 «켜짐» 이었다(끈 줄 알았는데 AI 비용이 계속 난다).

type StageJob = { id?: unknown; enabled?: unknown; params?: unknown };

/**
 * 대표 잡 — 켜진 것 중 prefer 를 만족하는 잡 → 켜진 잡 → (모두 꺼짐) prefer 를 만족하는 잡 → 첫 잡. 목록 순. 없으면 null.
 *  모두 꺼져 있을 때도 prefer 를 먼저 보는 이유: 대표가 곧 [켜기] 가 켜는 잡이다 — 전용 잡이 대표면 켜도 한 레인만 돈다.
 *  prefer 가 없으면 종전 규칙(첫 켜진 잡 → 첫 잡) 그대로.
 */
export function pickStageJob<T extends StageJob>(found: readonly T[], prefer?: (j: T) => boolean): T | null {
  const on = found.filter((j) => j.enabled === true);
  return (prefer ? on.find(prefer) : undefined) ?? on[0]
    ?? (prefer ? found.find(prefer) : undefined) ?? found[0] ?? null;
}

/** 스위치를 끌 때 끌 잡 — 이 단계의 **켜진 잡 전부**(대표 포함). 켜진 것이 없으면 대표만. */
export function stageOffTargets<T extends StageJob>(found: readonly T[], job: T): T[] {
  const on = found.filter((j) => j.enabled === true);
  return on.length ? on : [job];
}

/**
 * 증류 잡이 한 증류기에 묶이지 않았나 — 켜진 레인 전부를 접수하는 **전체 잡**인가.
 *  서버 판정(org/distill/ensure-job.ts 의 pinnedTo)과 같다: params.distiller 가 비지 않은 문자열일 때만 묶인 것이다.
 */
export function isWholeDistillJob(j: StageJob): boolean {
  const p = j.params;
  const v = p && typeof p === 'object' ? (p as Record<string, unknown>).distiller : undefined;
  return !(typeof v === 'string' && v.trim());
}
