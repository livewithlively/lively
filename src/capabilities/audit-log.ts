// ⚙ 공용 헬퍼 — op 정의 아님(capability 를 export 하지 않는다. registry 조립 대상이 아니라 op 들이 쓰는 도구다).
// 쓰기 capability 감사 로그 래퍼(구조적 로그 — org_content_audit DB 감사와 별개의 운영 로그).
//  결과 시점 outcome(ok/failed)·change_id·httpStatus 를 분리 기록한다. label 로 감사 그룹 구분.
//  구 domainmap-crud / domainmap-curation 에 byte-identical 로 복붙돼 있던 정의를 통합(라벨만 인자화).
import { logger } from "../log.js";
import { HttpError } from "./rest-util.js";
import type { LivelyUser } from "../context.js";
import type { CapabilityCtx } from "./types.js";

export function makeAudited(label: string) {
  return async function audited<T>(
    action: string, user: LivelyUser, ctx: CapabilityCtx | undefined,
    extra: Record<string, unknown>, fn: () => Promise<T>,
  ): Promise<T> {
    const base = { audit: label, action, by: user.userId, source: ctx?.source ?? "unknown", ...extra };
    try {
      const result = await fn();
      const changeId = (result as { change_id?: unknown } | null)?.change_id;
      logger.info({ ...base, outcome: "ok", ...(changeId !== undefined ? { changeId } : {}) });
      return result;
    } catch (err) {
      // 키 충돌 주의: extra 에 status(debt 목표 상태 등)가 있을 수 있어 HTTP 코드는 httpStatus 로.
      const httpStatus = err instanceof HttpError ? err.status : undefined;
      logger.info({ ...base, outcome: "failed", ...(httpStatus !== undefined ? { httpStatus } : {}),
        error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
}
