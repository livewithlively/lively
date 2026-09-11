// 복원 요청을 **끊김에만** 짧게 다시 묻는다(순수, #3891).
//
// 왜: 복원(`POST …/restore`)은 수 초 걸린다(컨테이너 → 판 → 메타 → 뒷정리). 그 사이 매니지드 롤이 게이트웨이를
//  내리면 요청이 중간에 잘린다 — 실측 2026-09-11 08:45:00Z: SIGTERM 15ms 뒤 relay 가 죽어 요청이 실패했다.
//  종전 화면은 그 실패를 토스트 한 줄로 삼키고 제자리에 남았다: 보낸 말은 한 번도 전송되지 않았고, 서버엔 이미 뜬
//  세션이 따로 남아 사이드바에 같은 세션이 두 줄 섰다.
//  청/녹 교대라 몇 초 뒤엔 새 게이트웨이가 받는다 — 그래서 **끊긴 실패만** 다시 묻는다. 서버 복원은 다시 불러도
//  같은 대화를 둘로 만들지 않는다(src/terminal/restore-adopt.ts — 이미 떠 있는 세션으로 잇는다). 그 보장이 없는
//  요청(말 전달 POST …/prompt, 이어보기 POST v6/…/resume)엔 쓰지 않는다 — 응답만 잃은 경우 두 번 들어간다.
//
//  무엇이 «끊김» 인가: 응답 자체가 없거나(네트워크 — fetch 가 status 없이 던진다) 5xx 중 **게이트웨이·중계가 넘어진
//  모양**(500·502·503·504). 4xx 는 서버가 **판단해서** 거절한 것(권한·없음·상태 모름 409)이라 다시 물어도 같은 답이다 —
//  사람에게 그 사유를 바로 보인다.

/** 다시 묻기 전 기다림(ms) — 첫 시도 뒤 최대 3번 · 합 10.5초. 롤 교대 창(배수 수 초)을 넘길 만큼이면 된다. */
export const RESTORE_RETRY_DELAYS_MS: readonly number[] = [1500, 3000, 6000];

const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

/** 이 실패가 «다시 물으면 달라질 수 있는 끊김» 인가. 오류 객체가 없으면 판정 근거가 없어 **아니다**. */
export function isTransientRequestError(e: unknown): boolean {
  if (e == null || typeof e !== "object") return false;
  const raw = (e as { status?: unknown }).status;
  if (raw === undefined || raw === null) return true;              // 응답이 없었다(네트워크) — api() 는 HTTP 실패에만 status 를 단다
  const st = Number(raw);
  if (!Number.isFinite(st) || st === 0) return true;
  return TRANSIENT_STATUS.has(st);
}

export interface RetryOpts {
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** 참이면 더 묻지 않고 마지막 오류를 던진다(화면이 사라졌다 등). */
  stop?: () => boolean;
  /** n 번째 다시 묻기 **직전**(기다리기 전)에 부른다 — 화면이 «다시 여는 중» 을 말할 자리. */
  onRetry?: (n: number, e: unknown) => void;
}

/** run 을 부르고, 끊김이면 delays 대로 기다렸다 다시 부른다. 끊김이 아니거나 횟수를 다 쓰면 그 오류를 그대로 던진다. */
export async function withRetry<T>(run: () => Promise<T>, o: RetryOpts = {}): Promise<T> {
  const delays = o.delays ?? RESTORE_RETRY_DELAYS_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= delays.length || !isTransientRequestError(e) || (o.stop && o.stop())) throw e;
      o.onRetry?.(i + 1, e);
      await sleep(delays[i]);
      if (o.stop && o.stop()) throw e;
    }
  }
}
