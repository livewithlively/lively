// 하네스 종료 규칙의 «한도 자동 이어감 대기» 재료 — 세션의 대화 기록 **끝**을 읽어 quotaScan·quotaBound 로 판정한다 (#4810).
//  끝 창보다 긴 «이어 간 턴» 이면 그 턴의 첫 줄을 거슬러 찾아 출처를 판정에 넘긴다 (#4821 ①).
//  판정 규칙(무슨 줄이 걸림·이어 감·접힘인가)은 harness-io/quota-wait.ts 가 갖는다. 여기는 «어느 파일의 어디를 언제 다시 읽나» 만 한다 —
//  파일 찾기는 대화창·감시자와 같은 한 벌(transcript-locate.ts)을 쓴다(셋이 다른 파일을 보면 조용히 갈린다 — #3699) — 그 찾기는 부르는 쪽이 넘긴다.
//  #5043 — 이 몸통을 session-quota-wait.ts 에서 떼어 냈다. 원격 PC 노드 에이전트도 **같은 판정**으로 그 PC 의 대화 기록을 읽는데(node/stop-step.ts),
//   게이트웨이 쪽 파일 찾기(transcript-locate → 장부 DB)를 끌고 가면 노드 번들에 DB 모듈이 딸려 든다(번들 가드 — «노드엔 DB 가 없다» 가 계약).
//   그래서 여기는 찾기를 **받기만** 하고(import type 뿐), 기본 찾기를 꽂는 일은 session-quota-wait.ts 가 한다.
import type { TranscriptTarget } from "../terminal/transcript-locate.js";
import { readAlignedWindow } from "../terminal/harness-io/window.js";
import type { TranscriptFs } from "../terminal/harness-io/transcript-fs.js";
import { quotaScanWithOpenTurn, quotaBound, type QuotaScan, type QuotaWait } from "../terminal/harness-io/quota-wait.js";
import { logger } from "../log.js";

/**
 * 대화 기록 끝에서 읽는 양. 실측(2026-10-16, 꺼진 5세션): 걸림 줄은 끈 시각 기준 파일 끝에서 3~40KB 안이었다(그 뒤엔 턴 끝 표식·비용 줄·
 *  백그라운드 작업 알림 한 턴뿐). 대기 중엔 사람의 말이 오지 않는 한 기록이 거의 안 자란다. 이 창 밖으로 밀린 걸림 줄은 못 본다 — 그러면 종전처럼 끈다.
 *  «이어 간 턴이 다시 걸림» 은 그 턴의 맨 앞(이어 감 줄)과 맨 끝(정리 안내)을 함께 봐야 한다 — 그 턴이 이 창보다 길면(약 8분 작업) 맨 앞을
 *   QUOTA_OPENER_SCAN_BYTES 까지 거슬러 찾는다(#4821 ① — harness-io/quota-wait.ts 머리말).
 */
export const QUOTA_TAIL_BYTES = 1024 * 1024;
/**
 * 끝 창보다 긴 «이어 간 턴» 의 첫 줄을 창 시작에서 앞으로 거슬러 찾는 상한(#4821 ①). 실측 대화 기록은 시간당 2~35MB(중앙값 약 7.6MB) 자라므로
 *  128MB 는 빨리 자라는 대화로도 서너 시간, 보통은 열 시간 넘는 턴이다. 그 밖이면 못 찾음 — 종전처럼 끈다.
 */
export const QUOTA_OPENER_SCAN_BYTES = 128 * 1024 * 1024;
/**
 * 세션·파일 → 지난번에 읽은 크기와 그때의 사건. 대기는 몇 시간씩 가고(그동안 기록이 안 자란다) 종료 규칙은 5분마다 다시 잰다 —
 *  크기가 같으면 새 줄이 없으니(덧붙이기만 하는 파일) 1MB 를 중계로 다시 읽지 않고 시각 조건만 다시 건다(격리 리뷰: 하루 대기 = 1MB × 295회).
 */
const scanCache = new Map<string, { size: number; scan: QuotaScan | null }>();
/** 기억하는 파일 수 상한 — 넘치면 가장 오래 안 쓴 것부터 버린다(턴 첫 줄 기억도 같은 상한). */
export const QUOTA_SCAN_CACHE_MAX = 500;
/**
 * 세션·파일·promptId → 그 턴의 첫 줄 출처(못 찾음 = null). 첫 줄은 안 바뀐다 — 대기 중에도 작업 알림 등으로 파일이 자라 창을 다시 읽을 때마다
 *  수십 MB 를 다시 거슬러 읽지 않게 한 번 찾은 답(못 찾음 포함)을 기억한다. 찾다 실패한 것은 기억하지 않는다(다음 판에 다시).
 */
const openerCache = new Map<string, string | null>();

/**
 * 이 세션의 하네스가 지금 한도 자동 이어감을 걸어 두고 기다리는(또는 막 이어 가는) 중인가. claude 만 본다(다른 하네스엔 이 기능이 없다).
 *  대화 id 매핑이 없거나 파일을 못 찾으면 null(대기 재료 없음 — 종전대로 판정). 중계가 못 읽으면 **던진다**(부르는 쪽이 «모름» 으로 다룬다).
 *  @param launchedAtMs  하네스(tmux 세션)를 띄운 시각
 *  @param resolve       파일 찾기 — 게이트웨이는 대화창과 같은 한 벌(session-quota-wait.ts), 원격 PC 는 그 PC 의 파일(node/stop-step.ts)
 */
export async function readQuotaWaitFrom(
  id: string, at: { launchedAtMs: number; nowMs: number }, resolve: (id: string) => Promise<TranscriptTarget>,
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
    let scan: QuotaScan | null = null;
    if (win.data.length) {
      //  #4821 ① — 창 판정이 «없음» 이고 창 맨 앞 턴(첫 줄이 창 앞)을 «이어 간 턴» 으로 보면 다시 걸림일 때만 그 턴의 첫 줄을 창 앞으로 거슬러
      //   찾는다(판정 규칙은 quotaScanWithOpenTurn 한 곳). 첫 걸림·대화상자 대기는 걸림 줄이 창 끝에 있어 묻지 않는다 — 드물고, 찾은 답은 기억한다.
      const lines = t.io.parse(win.data.toString("utf8"), {}).lines;
      scan = await quotaScanWithOpenTurn(lines, (promptId) => openerOriginOf(id, t.tfs, file, promptId, win.from));
    }
    hit = { size, scan };
  }
  scanCache.delete(key);
  scanCache.set(key, hit);   // 최근에 쓴 것을 뒤로 — 넘치면 앞(가장 오래 안 쓴 것)에서 버린다
  if (scanCache.size > QUOTA_SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value as string);
  return quotaBound(hit.scan, at);
}

/**
 * 그 턴의 첫 줄 출처 — 기억이 있으면 그것, 없으면 창 시작(before)에서 거슬러 찾아 기억한다(못 찾음도). 찾다 실패하면 던지고 기억하지 않는다.
 *  실제로 찾아본 판(던진 판 포함)은 소요(ms)와 결과를 info 로 남긴다 — 드문 일이고, 중계 한 번의 상한(허브 20초)에 얼마나 다가가는지 보는
 *  유일한 자리다. «다시 찾을 땐 캐시가 데워져 빨라진다» 는 아직 가정이다 — 롤 뒤 이 로그의 ms 로 확인한다.
 */
async function openerOriginOf(id: string, tfs: TranscriptFs, file: string, promptId: string, before: number): Promise<string | null> {
  const key = id + "\u0000" + file + "\u0000" + promptId;
  let v: string | null;
  if (openerCache.has(key)) v = openerCache.get(key) ?? null;
  else {
    //  던진 판(허브 20초 상한 등)도 소요를 남긴다 — 관찰하려는 것이 바로 그 판이다(격리 리뷰).
    const t0 = Date.now();
    let outcome = "실패(던짐)";
    try {
      v = await tfs.turnOpenerOrigin(file, promptId, before, QUOTA_OPENER_SCAN_BYTES);
      outcome = v ?? "못 찾음";
    } finally {
      logger.info({ id, promptId, origin: outcome, before, ms: Date.now() - t0 }, "한도 대기 판정: 끝 창보다 긴 이어 간 턴 — 그 턴의 첫 줄을 거슬러 찾아봤다(#4821)");
    }
  }
  openerCache.delete(key);
  openerCache.set(key, v);   // 최근에 쓴 것을 뒤로(scanCache 와 같은 규칙)
  if (openerCache.size > QUOTA_SCAN_CACHE_MAX) openerCache.delete(openerCache.keys().next().value as string);
  return v;
}

/** 시험용 — 읽은 크기 기억·턴 첫 줄 기억을 비운다. */
export function resetQuotaScanCache(): void {
  scanCache.clear();
  openerCache.clear();
}
