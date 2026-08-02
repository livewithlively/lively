// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// EE 적재 엔트리 — 코어(src/enterprise/load.ts)가 부팅 시 이 모듈을 동적으로 찾아 아래 함수를 호출한다.
//  코어는 이 파일을 **정적으로 import 하지 않는다** — src/ee 를 통째로 지운 무료 배포판도 그대로 빌드·구동된다.
import { registerEnterprise } from "../enterprise/registry.js";
import { maskValue, planMaskTargets, applyRowMasking } from "./db/mask.js";
import {
  refreshMaskPolicy, applyMaskOverlay, getSubjectColSet, resolveUnmaskKeys, peekMaskedSrcKeyToCol,
  getMaskStyleMap, resolveMaskedAttrs, resolveSubjectAttrs, resetCacheForTest, hasComplianceConfig,
} from "./db/mask-policy.js";
import { collectSubjectKeys, persistAccessOrThrow, persistAccessBestEffort } from "./db/access-log.js";
import { scrubPii, detectPii, scrubPiiDeep } from "./ingest/pii-scrub.js";
import { resolveIngestPolicy } from "./ingest/ingest-policy.js";
import { getIngestPolicyRules, invalidateIngestPolicyCache } from "./ingest/ingest-policy-load.js";
import { dbAuditCapabilities } from "./capabilities/db-audit.js";
import { dbGrantCapabilities } from "./capabilities/db-grant.js";
import { addEnterpriseCapabilities } from "../capabilities/index.js";

export function registerEnterpriseModule(): void {
  // EE 관리 표면(db_audit_*·db_unmask_grant_*) 합류 — 코어 registry 는 이 이름들을 정적으로 모른다.
  addEnterpriseCapabilities([...dbAuditCapabilities, ...dbGrantCapabilities]);
  registerEnterprise({
    dbMask: { maskValue, planMaskTargets, applyRowMasking },
    dbMaskPolicy: {
      refreshMaskPolicy, applyMaskOverlay, getSubjectColSet, resolveUnmaskKeys, peekMaskedSrcKeyToCol,
      getMaskStyleMap, resolveMaskedAttrs, resolveSubjectAttrs, resetCacheForTest, hasComplianceConfig,
    },
    dbAudit: { collectSubjectKeys, persistAccessOrThrow, persistAccessBestEffort },
    pii: { scrubPii, detectPii, scrubPiiDeep },
    ingestPolicy: { resolveIngestPolicy, getIngestPolicyRules, invalidateIngestPolicyCache },
  });
}
