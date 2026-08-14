// 리브가 사람에게 자격을 받는 자리의 **순수 판정**(#1631) — 어디에 넣어도 되는가, 아직 물어야 하는가.
//
//  왜 떼어냈나: 이 두 판정이 **안전 경계**다. 겨눌 수 있는 자리를 잘못 열면 리브가 아무 수집기에나 값을
//   흘려보낼 수 있고, 죽은 요청을 계속 띄우면 사람은 이미 끝난 일을 붙들고 앉는다. DB·HTTP 에 묻어 두면
//   그 두 가지를 눈으로 확인할 방법이 없다.
//
//  ⚠ **값은 이 모듈을 지나가지 않는다.** 여기 있는 건 "무엇을 어디에" 뿐이다.

/** 판정에 필요한 만큼의 수집기(CollectorView 의 부분집합). */
export interface AskTargetCollector {
  id: number;
  secretsSet: Record<string, boolean>;
  fields: Array<{ key: string; secret?: boolean }>;
  secrets_enabled: boolean;
}

export type AskTargetVerdict =
  | { ok: true }
  | { ok: false; reason: "no-collector" | "not-a-secret-field" | "no-master-key" };

/**
 * 리브가 이 자리에 자격을 요청해도 되는가.
 *
 * - 수집기가 없으면 안 된다(존재하지 않는 대상).
 * - **그 프리셋이 시크릿이라고 선언한 필드**여야 한다 — 아무 설정 칸이나 겨누면 평문 설정에 자격이 박힌다.
 * - 마스터키가 없으면 안 된다. 받아 봐야 안전하게 못 넣는데 사람에게 시키면 그게 거짓말이다.
 */
export function askTargetVerdict(c: AskTargetCollector | null | undefined, field: string): AskTargetVerdict {
  if (!c) return { ok: false, reason: "no-collector" };
  const f = (c.fields ?? []).find((x) => x.key === field);
  if (!f?.secret) return { ok: false, reason: "not-a-secret-field" };
  if (!c.secrets_enabled) return { ok: false, reason: "no-master-key" };
  return { ok: true };
}

/**
 * 화면에 그 요청을 아직 띄워야 하는가.
 *
 * **이미 채워졌거나 대상이 사라졌으면 띄우지 않는다.** 다른 경로로 값이 들어왔을 수 있고(관리탭에서 직접
 * 입력, 다른 기기의 리브), 그때도 칸이 남아 있으면 사람은 "아직 안 됐나" 하고 같은 일을 또 한다.
 */
export function askStillOpen(
  ask: { collector_id: number; field: string } | null | undefined,
  collectors: ReadonlyArray<Pick<AskTargetCollector, "id" | "secretsSet">>,
): boolean {
  if (!ask) return false;
  const c = collectors.find((x) => x.id === ask.collector_id);
  if (!c) return false;                        // 수집기가 지워졌다 — 죽은 요청
  return !c.secretsSet?.[ask.field];           // 이미 채워졌으면 끝난 일
}
