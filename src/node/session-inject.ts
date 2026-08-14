// 세션에 프롬프트를 넣는 **라우팅 한 자리** — 그 세션이 이 게이트웨이 것이면 로컬 mux 로, 멤버 PC(노드) 것이면
//  노드로 릴레이한다. 소비자가 둘이라 여기 모아 둔다: 크론 주입(scheduler/actions/_headless)과 웹 REST
//  (terminal/routes 의 세션 프롬프트 보내기). 두 곳에 같은 if 를 두면 한쪽만 고쳐 노드 세션이 조용히 빠진다.
//
// 배치 이유: node → terminal 방향은 이미 성립한다(agent.ts 가 terminal-sessions 를 쓴다). 반대로 terminal 에
//  두면 terminal → node 가 생겨 순환이 된다. 그래서 라우팅은 node 계층이 진다 — '노드가 있으면 노드로'라는
//  판단 자체가 node 의 관심사이기도 하다.
import { nodeOfSession, nodeRpc } from "./registry.js";
import { sendKeysToSession } from "../terminal/send-keys.js";

/**
 * 세션 PTY 에 텍스트를 넣고 제출한다. **인가는 호출자 책임**이다 — 크론은 관리세션 해소로,
 * REST 는 canAttach/nodeCanAttach 로 이미 가른 뒤에 부른다(정책=게이트웨이, 실행=여기).
 *
 * 노드 세션인데 그 노드가 오프라인이거나 구버전(sendKeys 미지원)이면 nodeRpc 가 고정 문자열 에러로 던진다
 * (`node-offline` / `node-unsupported-op:sendKeys`) — 호출자가 사람 말로 옮긴다.
 */
export async function injectPrompt(sessionId: string, text: string): Promise<void> {
  const nodeId = nodeOfSession(sessionId);
  if (nodeId) { await nodeRpc(nodeId, "sendKeys", { id: sessionId, text }); return; }
  await sendKeysToSession(sessionId, text);
}
