// 커서 전진 불변식(#1313 R44) — run-sync 의 "모든 단계 성공 후에만 전진"을 담는 **순수** 판정.
//  DB·네트워크 무의존 leaf 라 단위 테스트로 조건 조합을 고정한다(sync-cursor.test.ts).
//  구 run-sync.ts 의 커서 전진 블록을 그대로 옮긴 것 — 조건을 바꾸지 말고, 바꿔야 하면 테스트부터 바꿔라.
import type { PostSyncResult } from "./types.js";

export const CURSOR_EPSILON_MS = 1000; // strict greater-than 커서의 동일 ms 경계 유실 방지 재폴링(멱등이라 무비용).

export interface CursorPlanInput {
  /** 저장돼 있던 커서 시각(ISO) 원문 — 문자열이 아니면 '없음' 취급. */
  prevIso: unknown;
  /** prevIso 의 ms(파싱 실패/부재는 0). */
  prevMs: number;
  /** 이번 run 이 관측한 최대 updated_at ms. */
  maxMs: number;
  /** 항목 단위 미러 실패 수(#541) — 1건이라도 있으면 시각커서 전진 금지. */
  mirrorFailures: number;
  /** 커서에 저장돼 있던 재시도 목록(변경 여부 대사용). */
  prevRetry: string[];
  /** 커넥터 postSync 훅의 반환값(훅 없으면 null). */
  post: PostSyncResult | null;
}

export interface CursorPlan {
  /** 훅이 요구한 동결 — run 을 실패로 보고(exit 1) 커서를 **기록하지 않는다**. */
  freeze: boolean;
  /** 시각커서 전진 여부(로그·기록 페이로드 결정). */
  advance: boolean;
  /** connector_state 에 기록할 커서(없으면 기록 자체를 생략 — 무변경 write 노이즈 방지). */
  write: Record<string, unknown> | null;
}

/**
 * 커서 기록 계획 — 전진/동결 판정 한 곳.
 *  · 훅이 freezeCursor 를 반환하면 무조건 동결(적재분은 멱등 보존, 다음 run 이 같은 윈도 재수집).
 *  · 시각커서는 **미러 실패 0 이고 관측 최대가 이전보다 클 때만** 전진(시계 추측 금지: 0건/무진전이면 유지).
 *  · 재시도 목록만 바뀐 경우(#586 부분 성공)는 기존 시각커서를 그대로 보존한 채 retry_ids 만 기록한다.
 */
export function planCursorWrite(inp: CursorPlanInput): CursorPlan {
  if (inp.post?.freezeCursor) return { freeze: true, advance: false, write: null };
  const retryIds = inp.post?.retryIds ?? null;
  const advance = inp.mirrorFailures === 0 && inp.maxMs > inp.prevMs;
  const retryChanged = retryIds != null
    && (retryIds.length !== inp.prevRetry.length || retryIds.some((x) => !inp.prevRetry.includes(x)));
  if (!advance && !retryChanged) return { freeze: false, advance, write: null };
  return {
    freeze: false,
    advance,
    write: {
      ...(advance ? { max_updated_iso: new Date(inp.maxMs).toISOString() }
        : (typeof inp.prevIso === "string" && inp.prevIso ? { max_updated_iso: inp.prevIso } : {})),
      ...(retryIds != null ? { retry_ids: retryIds } : {}),
    },
  };
}
