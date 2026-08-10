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
import { breakGlassCapabilities } from "./capabilities/break-glass.js"; // #1601 긴급 열람
import { addEnterpriseCapabilities } from "../capabilities/index.js";
import { oidcConfig } from "./auth/oidc.js"; // #1601 SSO — 외부 IdP 웹 로그인
import { registerOidcRoutes } from "./auth/oidc-routes.js";
import { oidcLinkStatus, unlinkOidcFromMember } from "./auth/oidc-login.js";
import { registerAuditExportRoutes } from "./audit/export-routes.js"; // #1601 감사 증빙 반출

export function registerEnterpriseModule(): void {
  // EE 관리 표면(db_audit_*·db_unmask_grant_*) 합류 — 코어 registry 는 이 이름들을 정적으로 모른다.
  addEnterpriseCapabilities([...dbAuditCapabilities, ...dbGrantCapabilities, ...breakGlassCapabilities]);
  registerEnterprise({
    dbMask: { maskValue, planMaskTargets, applyRowMasking },
    dbMaskPolicy: {
      refreshMaskPolicy, applyMaskOverlay, getSubjectColSet, resolveUnmaskKeys, peekMaskedSrcKeyToCol,
      getMaskStyleMap, resolveMaskedAttrs, resolveSubjectAttrs, resetCacheForTest, hasComplianceConfig,
    },
    dbAudit: { collectSubjectKeys, persistAccessOrThrow, persistAccessBestEffort },
    pii: { scrubPii, detectPii, scrubPiiDeep },
    ingestPolicy: { resolveIngestPolicy, getIngestPolicyRules, invalidateIngestPolicyCache },
    // SSO(#1601) — 설정이 갖춰졌을 때만 제공자로 노출한다. 미설정이면 null 이라 코어 로그인 화면은 local 만 그린다.
    sso: {
      ssoProvider: async () => {
        const cfg = await oidcConfig();
        return cfg ? { label: cfg.label } : null;
      },
      registerSsoRoutes: registerOidcRoutes,
      ssoLinkStatus: oidcLinkStatus,
      ssoUnlink: unlinkOidcFromMember,
    },
    auditExport: { registerAuditExportRoutes },
  });
}
