// delivery(전달/관리) capabilities — workflow-std 흡수의 게이트웨이 표면.
// 비개발자 관리자가 org-content(강제규칙·회사맥락·메모리·구성원·게이트웨이주소)를 웹에서 편집/발행하고
// 구성원 토큰을 발급한다. admin/runtime scope — REST(웹) + MCP(에이전트) 양쪽 노출(#549).
//  과거엔 expose.mcp=false 로 에이전트를 원천 차단했으나(정책 변경 금지), 에이전트가 관리탭 기능을 직접
//  다뤄야 하는 상황이 실제로 생겨 MCP 로도 연다(#549). 안전판은 유지된다:
//   ① 회수 가능한 DB 토큰만(B5: 정적 토큰은 admin/runtime 거부 — web.ts:85, MCP 는 sanitize 로 admin scope 자체 제거),
//   ② 유효 scope = intersection(토큰, 멤버 LIVE) — 강등·퇴사 즉시 무효(store.ts computeEffectiveScopes),
//   ③ 모든 쓰기는 org_content_audit 에 누가(actor_kind: 사람/AI)·경로(channel: mcp/web)·before/after 감사(조회: org_audit_list).
// 모든 응답에 '구성원에게 미치는 효과'(meaning) 가이드를 함께 실어 UI 가 의미를 인지시킨다.
// 도메인 분할(#1313 R26): op 정의는 ./delivery/*.ts 에 있고, 여기는 **현 표면 순서 그대로**의 concat 조립자다.
//  (tools/list 순서가 표면 스냅샷에 잡히므로 아래 spread 순서를 바꾸지 마라.)
import type { Capability } from "./types.js";
import { overviewCapabilities } from "./delivery/overview.js";
import { orgContentReadCapabilities, orgContentCapabilities } from "./delivery/org-content.js";
import { membersReadCapabilities, membersCapabilities } from "./delivery/members.js";
import { tokensReadCapabilities, tokenMintCapabilities, deviceAuthCapabilities, tokenRevokeCapabilities } from "./delivery/tokens-devices.js";
import { connectorsReadCapabilities, connectorsCapabilities, connectorMembersCapabilities } from "./delivery/connectors.js";
import { collectorsReadCapabilities, collectorsCapabilities } from "./delivery/collectors.js"; // #1419 T1 — 수집기 n개 축
import { classifiersCapabilities } from "./delivery/classifiers.js"; // #1419 T4 — 분류기 n개 축
import { managersCapabilities } from "./delivery/managers.js"; // #1419 T5 — 관리기 4종 + 발견 큐
import { pipelineCapabilities } from "./delivery/pipeline.js"; // #1419 T6 — 파이프라인 현황 한 번에
import { meProfileCapabilities, meSelfCapabilities } from "./delivery/me-self.js";
import { gitCredentialCapabilities } from "./delivery/git-credentials.js";
import { runtimeConfigCapabilities } from "./delivery/runtime-config.js";
import { boxStatusCapabilities } from "./delivery/box-status.js";
import { workspaceCapabilities } from "./delivery/workspace.js";
import { embeddingsCapabilities } from "./delivery/embeddings.js";
import { mcpServersCapabilities } from "./delivery/mcp-servers.js";
import { ingestDistillersCapabilities } from "./delivery/ingest-distillers.js";
import { hooksCapabilities } from "./delivery/hooks.js";
import { toolsCapabilities } from "./delivery/tools.js";
import { harnessAssetsCapabilities } from "./delivery/harness-assets.js";
import { dbSourcesCapabilities } from "./delivery/db-sources.js";
import { auditCapabilities } from "./delivery/audit.js";
export { resolveHookSource, resolveHookMatcher } from "./delivery/hooks.js"; // hook-source-resolve.test.ts 계약

export const deliveryCapabilities: Capability[] = [
  ...overviewCapabilities,
  ...orgContentReadCapabilities,
  ...membersReadCapabilities,
  ...tokensReadCapabilities,
  ...connectorsReadCapabilities,
  ...collectorsReadCapabilities,
  ...orgContentCapabilities,
  ...membersCapabilities,
  ...tokenMintCapabilities,
  ...meProfileCapabilities,
  ...deviceAuthCapabilities,
  ...meSelfCapabilities,
  ...gitCredentialCapabilities,
  ...tokenRevokeCapabilities,
  ...runtimeConfigCapabilities,
  ...boxStatusCapabilities,
  ...workspaceCapabilities,
  ...embeddingsCapabilities,
  ...mcpServersCapabilities,
  ...connectorsCapabilities,
  ...collectorsCapabilities,
  ...ingestDistillersCapabilities,
  ...classifiersCapabilities,
  ...managersCapabilities,
  ...pipelineCapabilities,
  ...connectorMembersCapabilities,
  ...hooksCapabilities,
  ...toolsCapabilities,
  ...harnessAssetsCapabilities,
  ...dbSourcesCapabilities,
  ...auditCapabilities,
];
