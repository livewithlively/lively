// 아웃바운드 행 실패의 판정과 파킹 — «행 하나의 영구 실패가 크론 전체를 세우는» 구조를 막는 순수 leaf.
//
//  왜 필요한가: run-push 는 행 실패가 하나라도 있으면 exit 1 이고(push-budget.ts exitCodeForPush), 연속 실패
//   서킷브레이커(org_cron.max_fail_streak)가 push-clickup 을 자동 정지시킨다. ClickUp 이 **그 행만** 매 틱 같은
//   4xx 로 거절하면 재시도로 풀릴 일이 없는데도 조직 전체 반출이 선다(2026-09-22 404, 2026-10-06 ITEM_137 400).
//   원인별 자가 치유(404 detach·createUnderParent)는 그 원인만 막는다 — 여기는 원인과 무관하게 구조를 막는다.
//
//  판정 기준은 «그 거절이 다른 행에도 똑같이 오는가» 다.
//   · 401·403 = 토큰·권한 — 전 행이 같이 죽는다. 멈추는 게 맞다(브레이커가 사람을 부른다).
//   · 429     = 레이트리밋 — 시간이 풀어 준다. 행 탓이 아니다.
//   · 그 외 4xx(400·404·409·422 …) = 그 행의 본문·좌표에 대한 거절. 같은 행은 같은 답을 받는다.
//   · 5xx·네트워크·타임아웃·DB·형식 모를 오류 = 시스템성. 모르는 것을 «행 탓» 으로 접으면 전역 장애가 숨는다.

/** 행 고유 거절로 볼 수 있는 상태코드 자리(clickupFetch: `ClickUp ${status} ${path}: …`). SQL(~)과 JS 가 같은 문자열을 쓴다. */
export const ROW_REJECT_RE = "^ClickUp 4[0-9]{2} ";
/** 4xx 지만 행 탓이 아닌 것 — ROW_REJECT_RE 에서 뺀다. */
export const SYSTEMIC_4XX_RE = "^ClickUp (401|403|429) ";

const rowReject = new RegExp(ROW_REJECT_RE);
const systemic4xx = new RegExp(SYSTEMIC_4XX_RE);

export type PushFailureKind = "rejected" | "systemic";

/**
 * 행 실패 오류를 가른다.
 *  ⚠ 상태코드 자리만 본다 — 메시지엔 경로·본문이 실리므로 includes("404") 류는 id·본문에 숫자가 든 5xx 를
 *   «행 거절» 로 오판한다(clickup-push.ts isClickupTaskGone 머리말의 사고와 같은 자리).
 */
export function classifyPushFailure(e: unknown): PushFailureKind {
  if (!(e instanceof Error)) return "systemic";
  return isRowRejectMessage(e.message) ? "rejected" : "systemic";
}

/** markErr 가 남긴 last_error 문자열 기준의 같은 판정 — 파킹 SQL 과 대칭(테스트가 둘을 함께 잠근다). */
export function isRowRejectMessage(msg: string | null | undefined): boolean {
  const m = msg ?? "";
  return rowReject.test(m) && !systemic4xx.test(m);
}

// 같은 행이 몇 번 거절당하면 드레인 대상에서 뺄 것인가. 1 이면 일시적으로 보이는 4xx(직후 수렴하는 부모 좌표 등)
//  한 번에 바로 빠진다. 크게 잡으면 그만큼 매 틱 같은 호출이 반복된다(행당 요청 여러 번 — 예산을 깎는다).
//  재enqueue(그 항목을 다시 편집)는 attempts 를 0 으로 되돌리므로 파킹이 풀린다(검증: `grep -n "attempts=0" src/v6/external-outbox.ts`).
//  ⚠ attempts 는 상태셋 로드 실패 등 다른 실패와 같은 칸이다 — 앞선 시스템성 실패가 있으면 거절 한 번에 파킹될 수 있다.
export const PARK_AFTER = 3;

/** 이 시도(attemptsBefore 는 SELECT 시점 값) 뒤 그 행이 파킹되는가. */
export function parksAfter(attemptsBefore: number, kind: PushFailureKind): boolean {
  return kind === "rejected" && attemptsBefore + 1 >= PARK_AFTER;
}

/** JS 쪽 파킹 술어 — parkedSql 과 같은 의미(테스트 대조용). */
export function isParkedRow(r: { attempts: number; last_error: string | null }): boolean {
  return r.attempts >= PARK_AFTER && isRowRejectMessage(r.last_error);
}

/**
 * 파킹된 행의 SQL 술어(별칭 `o` = external_outbox). 파라미터는 `$n`·`$n+1`·`$n+2` 에 parkedParams() 순서로 싣는다.
 *  상태를 따로 저장하지 않고 attempts·last_error 에서 도출한다 — 재enqueue 가 두 칸을 리셋하므로 해제가 공짜이고,
 *  새 컬럼을 두면 그 리셋을 enqueue 에도 따로 배선해야 한다.
 *  COALESCE 가 빠지면 last_error 가 NULL 인 행에서 술어 전체가 NULL 이 되어 `NOT (…)` 가 그 행을 **빼 버린다**.
 */
export function parkedSql(n: number): string {
  return `(o.attempts >= $${n} AND COALESCE(o.last_error, '') ~ $${n + 1} AND COALESCE(o.last_error, '') !~ $${n + 2})`;
}
export function parkedParams(): [number, string, string] {
  return [PARK_AFTER, ROW_REJECT_RE, SYSTEMIC_4XX_RE];
}

// 한 실행에서 거절이 이만큼 이상이고 반출이 0건이면 행 탓이 아니라 설정 탓으로 본다(clickup-push.ts 일괄 거절 분기).
//  너무 작으면 서로 다른 행의 진짜 거절 몇 건이 겹친 실행에 크론이 선다 — 그래도 사람이 보면 되는 쪽이라 낮게 둔다.
//  반출이 한 건이라도 있으면 이 분기는 들지 않는다 — 컨테이너 리스트가 지워져도 같은 실행에 미러 편집(PUT)이 섞여
//  성공하면 네이티브 생성 거절은 파킹으로 간다. 그때 복구는 런북의 일괄 해제 SQL 이다.
export const MASS_REJECT_MIN = 5;
/** 일괄 거절로 올린 행의 last_error 머리표 — 파킹 술어의 `^ClickUp` 앵커에서 빠지게 한다. */
export const MASS_REJECT_MARK = "[일괄 거절] ";

/** 이번 실행이 일괄 거절(설정 문제)인가. */
export function isMassRejection(r: { rejected: number; pushed: number }): boolean {
  return r.rejected >= MASS_REJECT_MIN && r.pushed === 0;
}

export interface ParkedRow { outboxId: number; entityId: number; error: string }

/** 이번 실행에서 새로 파킹된 행 → 경보 한 건. 없으면 null. */
export function parkedAlert(rows: readonly ParkedRow[]): { severity: "warn"; title: string; text: string; detail: Record<string, unknown> } | null {
  if (!rows.length) return null;
  const sample = rows.slice(0, 5).map((r) => `· 항목 #${r.entityId}: ${r.error.slice(0, 160)}`).join("\n");
  return {
    severity: "warn",
    title: `ClickUp 반출 — ${rows.length}건을 반출 대상에서 뺐습니다`,
    text: `ClickUp 이 같은 항목을 ${PARK_AFTER}회 연속 거절해(4xx, 권한·레이트리밋 제외) 더는 재시도하지 않습니다.`
      + ` 다른 항목의 반출과 크론은 계속 돕니다.\n${sample}\n`
      + `→ 원인을 고친 뒤 그 항목을 다시 편집하면 큐에 다시 들어갑니다. 여러 건을 한꺼번에 풀려면 런북 clickup-sync 의 «파킹 행 일괄 해제» SQL 을 쓰세요.`
      + ` 남은 파킹 수는 관리 ▸ 스케줄 의 push 요약 parked 에 있습니다.`,
    detail: { parked: rows.length, rows: rows.slice(0, 20) },
  };
}

/** 경보 발송 — 실행당 한 번. 실패는 삼킨다(경보가 드레인 결과를 바꾸면 안 된다). */
export async function notifyParked(rows: readonly ParkedRow[], send: (a: NonNullable<ReturnType<typeof parkedAlert>>) => Promise<unknown>): Promise<boolean> {
  const a = parkedAlert(rows);
  if (!a) return false;
  try { await send(a); return true; } catch { return false; }
}
