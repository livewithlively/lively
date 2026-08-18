// 워크스페이스 접근 게이트(#1750 S1) — "이 사람이 지금 컨텍스트의 워크스페이스 멤버인가".
//
// ── 왜 인증 계층에 서는가 ───────────────────────────────────────────────────
// 미들웨어(컨텍스트를 여는 곳)는 인증 전이라 사람을 모른다. 인증이 끝나는 곳은 정확히 둘이다 —
//  웹 세션(userFromSession)과 bearer(BearerVerifier.verifyAccessToken). **모든 표면(REST·MCP·웹)이
//  그 둘로 수렴**하므로, 거기서 게이트를 걸면 새 라우트가 생겨도 빠질 자리가 없다.
//
// ── 판정 ────────────────────────────────────────────────────────────────────
//  · 컨텍스트 없음(= primary) → 통과. 박스 로그인 자체가 primary 접근 권한이다(종전과 동일).
//  · secondary → gw_workspace_member 에 있어야 통과. **admin 우회 없음** — 개인 워크스페이스의
//    프라이버시가 이 축의 존재 이유다(#1291 의 "admin 은 가시성 우회가 아니다"와 같은 결).
//  · registry 모드가 아니면(매니지드·단일) 항상 통과 — 이 게이트는 셀프호스트 다중 전용이다.
//    (매니지드 공유 게이트웨이의 접근 통제는 CP 서명 헤더가 이미 담당한다.)
import { currentTenant } from "../tenant-context.js";
import { registryModeActive } from "./state.js";
import { isWorkspaceMember, PRIMARY_TENANT_ID } from "./registry.js";

/**
 * 인증 직후 호출 — 통과하면 그대로, 아니면 false(호출자가 401/403 으로 바꾼다).
 * 실패 방향: 등록부 조회가 죽으면 **거부**한다(fail-closed) — 격리 게이트가 "모르겠으면 통과"면 게이트가 아니다.
 */
export async function workspaceAccessAllowed(memberId: string | null | undefined): Promise<boolean> {
  if (!registryModeActive()) return true;
  const t = currentTenant();
  if (!t || t.id === PRIMARY_TENANT_ID) return true;
  if (!memberId) return false;
  try { return await isWorkspaceMember(t.id, memberId); }
  catch { return false; }
}
