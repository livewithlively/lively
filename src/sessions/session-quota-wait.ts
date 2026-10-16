// 하네스 종료 규칙의 «한도 자동 이어감 대기» 재료 — 세션의 대화 기록 **끝**을 읽어 quotaWaitOf 로 판정한다 (#4810).
//  판정 규칙(무슨 줄이 걸림·풀림인가)은 harness-io/quota-wait.ts 가 갖는다. 여기는 «어느 파일의 어디를 읽나» 만 한다 —
//  파일 찾기는 대화창·감시자와 같은 한 벌(transcript-locate.ts)을 쓴다(셋이 다른 파일을 보면 조용히 갈린다 — #3699).
import { resolveTranscript, type TranscriptTarget } from "../terminal/transcript-locate.js";
import { readAlignedWindow } from "../terminal/harness-io/window.js";
import { quotaWaitOf, type QuotaWait } from "../terminal/harness-io/quota-wait.js";

/**
 * 대화 기록 끝에서 읽는 양. 실측(2026-10-16, 꺼진 5세션): 걸림 줄은 끈 시각 기준 파일 끝에서 3~40KB 안이었다(그 뒤엔 턴 끝 표식·비용 줄·
 *  백그라운드 작업 알림 한 턴뿐). 대기 중엔 사람의 말이 오지 않는 한 기록이 거의 안 자란다. 이 창 밖으로 밀린 걸림 줄은 못 본다 — 그러면 종전처럼 끈다.
 */
export const QUOTA_TAIL_BYTES = 1024 * 1024;

/**
 * 이 세션의 하네스가 지금 한도 자동 이어감을 걸어 두고 기다리는 중인가. claude 만 본다(다른 하네스엔 이 기능이 없다).
 *  대화 id 매핑이 없거나 파일을 못 찾으면 null(대기 재료 없음 — 종전대로 판정). 중계가 못 읽으면 **던진다**(부르는 쪽이 «모름» 으로 다룬다).
 *  @param sinceMs  하네스(tmux 세션)를 띄운 시각
 *  @param resolve  시험 seam — 기본은 대화창과 같은 파일 찾기
 */
export async function readQuotaWait(
  id: string, at: { sinceMs: number; nowMs: number }, resolve: (id: string) => Promise<TranscriptTarget> = resolveTranscript,
): Promise<QuotaWait | null> {
  const t = await resolve(id);
  if (!t.ok || t.io.key !== "claude") return null;
  const size = t.found.size;
  const win = await t.tfs.read(t.found.file, size, (r) => readAlignedWindow(r, size, Math.max(0, size - QUOTA_TAIL_BYTES), size, false));
  if (!win.data.length) return null;
  return quotaWaitOf(t.io.parse(win.data.toString("utf8"), {}).lines, at);
}
