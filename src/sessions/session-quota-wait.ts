// 하네스 종료 규칙의 «한도 자동 이어감 대기» 재료 — 세션의 대화 기록 **끝**을 읽어 quotaScan·quotaBound 로 판정한다 (#4810).
//  판정·읽기의 몸통은 session-quota-scan.ts 다(#5043 — 원격 PC 노드 에이전트가 같은 몸통을 그 PC 의 파일로 쓰려고 떼어 냈다). 여기는 게이트웨이의
//  기본 파일 찾기(대화창·감시자와 같은 한 벌 — transcript-locate.ts, 셋이 다른 파일을 보면 조용히 갈린다 #3699)를 꽂는 자리만 남는다.
import { resolveTranscript, type TranscriptTarget } from "../terminal/transcript-locate.js";
import type { QuotaWait } from "../terminal/harness-io/quota-wait.js";
import { readQuotaWaitFrom } from "./session-quota-scan.js";

export { QUOTA_TAIL_BYTES, QUOTA_OPENER_SCAN_BYTES, QUOTA_SCAN_CACHE_MAX, resetQuotaScanCache } from "./session-quota-scan.js";

/**
 * 이 세션의 하네스가 지금 한도 자동 이어감을 걸어 두고 기다리는(또는 막 이어 가는) 중인가. claude 만 본다(다른 하네스엔 이 기능이 없다).
 *  대화 id 매핑이 없거나 파일을 못 찾으면 null(대기 재료 없음 — 종전대로 판정). 중계가 못 읽으면 **던진다**(부르는 쪽이 «모름» 으로 다룬다).
 *  @param launchedAtMs  하네스(tmux 세션)를 띄운 시각
 *  @param resolve       시험 seam — 기본은 대화창과 같은 파일 찾기
 */
export async function readQuotaWait(
  id: string, at: { launchedAtMs: number; nowMs: number }, resolve: (id: string) => Promise<TranscriptTarget> = resolveTranscript,
): Promise<QuotaWait | null> {
  return readQuotaWaitFrom(id, at, resolve);
}
