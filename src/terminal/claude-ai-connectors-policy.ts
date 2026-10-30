// claude.ai 커넥터를 막나 (#4213 T6 #4427) — 라이블리가 claude 를 띄우는 두 자리(판 createSession · 대화 런타임 deliverPrompt)가
//  **같은 판정**을 쓴다. 판정을 자리마다 적으면 한쪽만 고쳐지고, 고장 나도 조용하다(막는다는 정책이 그 자리에서만 사라진다).
//
//  · 게이트웨이: 정책 능력(memberAiConnectorsPolicy)이 «allowed» 일 때만 싣는다. «blocked» 는 물론이고 «unknown»(못 읽음)·
//    능력이 던짐도 **막음**이다 — CONTRIBUTING «보안 관련 기본값은 fail-closed».
//  · 노드 에이전트: 능력이 등록돼 있지 않다 → 막지 않는다. 노드 세션은 그 사람 컴퓨터의 Claude 라 이 정책은 안내문으로만 닿는다
//    (상민 2026-10-16 «자기 PC 는 안내문만»). 게이트웨이에서 등록이 빠지는 사고는 gatewayCapability 가 크게 울고,
//    scripts/gateway-capabilities-wired.test.mjs 가 index.ts 등록을 강제한다.
//  · claude 가 아닌 하네스는 언제나 false — claude.ai 커넥터는 claude 만의 것이다.
import { gatewayCapability } from "../sessions/gateway-capabilities.js";

export async function claudeAiConnectorsBlocked(harnessKey: string): Promise<boolean> {
  if (String(harnessKey || "") !== "claude") return false;
  const policy = gatewayCapability("memberAiConnectorsPolicy");
  if (!policy) return false;
  try {
    return (await policy()) !== "allowed";
  } catch (err) {
    console.error(`[member-ai-connectors] 정책 판정이 던졌다 — 막음으로 본다(fail-closed, #4427): ${(err as Error)?.message ?? err}`);
    return true;
  }
}
