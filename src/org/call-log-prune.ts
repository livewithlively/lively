// MCP 호출 감사로그 prune(#1082) — mcp_call_log 를 보존기간(call_log_policy.retention_days) 밖까지만 남긴다.
//
// 왜: #318 도입 이래 이 표는 **무기한** 쌓였다(schema 주석이 "성장 시 주기 prune 을 별도 cron 으로 추가" 라고 예고만
//  하고 미구현). 누가 언제 무슨 툴을 썼는지가 사람 단위로 남는 표라, 기간 없는 축적은 개인정보 최소보관 원칙에 어긋난다.
//
// 왜 in-process 인가(log-janitor 와 같은 이유): 고객 박스는 우리가 못 들어간다 → OS cron 은 사실상 아무도 못 바꾼다.
//  관리탭에서 기간을 바꾸면 다음 스윕부터 그 값이 먹어야 한다(정책 로드를 매 스윕마다 다시 한다 — 캐시하지 않는 이유).
//
// ⚠ 소급 삭제는 하지 않는다(#1082 결정): 이번 변경은 '앞으로 쌓이는 인자'를 안 남기는 것이고, 이 prune 은 그와 별개로
//  '오래된 행'을 지운다. 이미 저장된 인자 본문을 소급 스크럽하는 마이그레이션은 범위 밖(사용자 결정).
import { itemsPool } from "../items/store.js";
import { logger } from "../log.js";

const SWEEP_MS = Number(process.env.CALL_LOG_PRUNE_INTERVAL_MS ?? 6 * 60 * 60_000); // 6시간 — 일 단위 정책엔 충분
const MAX_DELETE_PER_SWEEP = 50_000; // 한 스윕의 삭제 상한 — 첫 도입 박스(수년치 누적)에서 장시간 락을 잡지 않게

let timer: ReturnType<typeof setInterval> | null = null;

/** 테스트에서 가짜 풀을 넣기 위한 최소 형태(실제 pg.Pool 의 부분집합). */
export interface QueryablePool {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * 한 번 정리. retention_days<=0 이면 **쿼리 자체를 실행하지 않는다**(무기한 보관 = 명시적 opt-out).
 *  ⚠ 이 가드가 뚫리면 interval 이 0 이 되어 **전량 삭제**가 된다 — 그래서 '호출 0건'을 테스트가 못 박는다.
 *  반환값 = 삭제된 행 수. 상한에 걸리면 다음 스윕이 이어서 지운다(운영 로그로 남긴다).
 */
export async function pruneCallLog(retentionDays: number, pool: QueryablePool = itemsPool): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const r = await pool.query(
    `DELETE FROM mcp_call_log
      WHERE id IN (SELECT id FROM mcp_call_log
                    WHERE called_at < now() - ($1 || ' days')::interval
                    ORDER BY called_at
                    LIMIT $2)`,
    [String(Math.floor(retentionDays)), MAX_DELETE_PER_SWEEP],
  );
  const deleted = r.rowCount ?? 0;
  if (deleted > 0) {
    logger.info({ deleted, retentionDays, capped: deleted >= MAX_DELETE_PER_SWEEP }, "mcp_call_log prune");
  }
  return deleted;
}

/** 주기 기동 — 부팅 직후 1회 + SWEEP_MS 간격. 정책은 매 스윕마다 다시 읽는다(관리탭 변경 즉시 반영). */
export function startCallLogPrune(loadPolicy: () => Promise<{ retention_days: number }>): void {
  if (timer) return;
  const sweep = async (): Promise<void> => {
    try {
      const p = await loadPolicy();
      await pruneCallLog(p.retention_days);
    } catch (err) {
      // 실패해도 게이트웨이 동작엔 영향 없다(fail-open) — 다음 주기에 다시 시도한다.
      logger.warn({ err }, "mcp_call_log prune 스윕 실패");
    }
  };
  timer = setInterval(() => { void sweep(); }, SWEEP_MS);
  timer.unref?.(); // prune 이 프로세스 종료를 붙잡지 않게
  void sweep(); // 부팅 직후 1회 — 이미 기간을 넘긴 행을 다음 주기까지 방치하지 않는다
}

export function stopCallLogPrune(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
