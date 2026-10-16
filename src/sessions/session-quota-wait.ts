// 하네스 종료 규칙의 «한도 자동 이어감 대기» 재료 — 세션의 대화 기록 **끝**을 읽어 quotaScan·quotaBound 로 판정한다 (#4810).
//  판정 규칙(무슨 줄이 걸림·이어 감·접힘인가)은 harness-io/quota-wait.ts 가 갖는다. 여기는 «어느 파일의 어디를 언제 다시 읽나» 만 한다 —
//  파일 찾기는 대화창·감시자와 같은 한 벌(transcript-locate.ts)을 쓴다(셋이 다른 파일을 보면 조용히 갈린다 — #3699).
import { resolveTranscript, type TranscriptTarget } from "../terminal/transcript-locate.js";
import { readAlignedWindow } from "../terminal/harness-io/window.js";
import { quotaScan, quotaBound, type QuotaScan, type QuotaWait } from "../terminal/harness-io/quota-wait.js";

/**
 * 대화 기록 끝에서 읽는 양. 실측(2026-10-16, 꺼진 5세션): 걸림 줄은 끈 시각 기준 파일 끝에서 3~40KB 안이었다(그 뒤엔 턴 끝 표식·비용 줄·
 *  백그라운드 작업 알림 한 턴뿐). 대기 중엔 사람의 말이 오지 않는 한 기록이 거의 안 자란다. 이 창 밖으로 밀린 걸림 줄은 못 본다 — 그러면 종전처럼 끈다.
 *  ⚠ «이어 간 턴이 다시 걸림» 은 그 턴의 맨 앞(이어 감 줄)과 맨 끝(정리 안내)을 함께 봐야 해서, 그 턴이 이 창보다 길면(약 8분 작업) 못 본다
 *   (harness-io/quota-wait.ts 머리말 «못 읽는 경우» — 후속).
 */
export const QUOTA_TAIL_BYTES = 1024 * 1024;
/**
 * 세션·파일 → 지난번에 읽은 크기와 그때의 사건. 대기는 몇 시간씩 가고(그동안 기록이 안 자란다) 종료 규칙은 5분마다 다시 잰다 —
 *  크기가 같으면 새 줄이 없으니(덧붙이기만 하는 파일) 1MB 를 중계로 다시 읽지 않고 시각 조건만 다시 건다(격리 리뷰: 하루 대기 = 1MB × 295회).
 */
const scanCache = new Map<string, { size: number; scan: QuotaScan | null }>();
/** 기억하는 파일 수 상한 — 넘치면 가장 오래 안 쓴 것부터 버린다. */
export const QUOTA_SCAN_CACHE_MAX = 500;

/**
 * 이 세션의 하네스가 지금 한도 자동 이어감을 걸어 두고 기다리는(또는 막 이어 가는) 중인가. claude 만 본다(다른 하네스엔 이 기능이 없다).
 *  대화 id 매핑이 없거나 파일을 못 찾으면 null(대기 재료 없음 — 종전대로 판정). 중계가 못 읽으면 **던진다**(부르는 쪽이 «모름» 으로 다룬다).
 *  @param launchedAtMs  하네스(tmux 세션)를 띄운 시각
 *  @param resolve       시험 seam — 기본은 대화창과 같은 파일 찾기
 */
export async function readQuotaWait(
  id: string, at: { launchedAtMs: number; nowMs: number }, resolve: (id: string) => Promise<TranscriptTarget> = resolveTranscript,
): Promise<QuotaWait | null> {
  const t = await resolve(id);
  if (!t.ok || t.io.key !== "claude") return null;
  const { file, size } = t.found;
  const key = id + "\u0000" + file;
  let hit = scanCache.get(key);
  if (!hit || hit.size !== size) {
    //  중계 읽기(memberReadRange)는 `tail … | head -c N` 이라 tail 이 실패해도 종료코드 0 에 빈 출력이다(격리 리뷰) — 크기가 있는 파일에서
    //   한 바이트도 못 받았으면 «대기 없음» 이 아니라 못 읽은 것이다(던진다 · 기억하지 않는다). 온전한 줄이 없는 창(한 줄이 1MB 넘음)은 읽은 것이다.
    let raw = 0;
    const win = await t.tfs.read(file, size, (r) => readAlignedWindow(
      { read: async (s, e) => { const b = await r.read(s, e); raw += b.length; return b; } },
      size, Math.max(0, size - QUOTA_TAIL_BYTES), size, false,
    ));
    if (size > 0 && raw === 0) throw new Error(`대화 기록을 못 읽음(빈 읽기 · ${size}바이트 파일)`);
    hit = { size, scan: win.data.length ? quotaScan(t.io.parse(win.data.toString("utf8"), {}).lines) : null };
  }
  scanCache.delete(key);
  scanCache.set(key, hit);   // 최근에 쓴 것을 뒤로 — 넘치면 앞(가장 오래 안 쓴 것)에서 버린다
  if (scanCache.size > QUOTA_SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value as string);
  return quotaBound(hit.scan, at);
}

/** 시험용 — 읽은 크기 기억을 비운다. */
export function resetQuotaScanCache(): void {
  scanCache.clear();
}
