// 세션 생성 입력 가드 — 라우트(routes.ts)가 relay/createSession 을 부르기 **전에** 거는 순수 판정(#1780 v2 §7-1).
//  순수 함수로 둔 이유: 라우트는 express·노드 registry 에 묶여 단위 테스트가 안 되는데, 이 판정은 "무엇을 만들기
//  전에 거절하나" 라는 계약이라 그 자체로 못박혀야 한다(session-create-guards.test.ts).
import { HttpError } from "../http-error.js";

/**
 * 노드(멤버 PC) 세션엔 앱을 실을 수 없다(아직). 노드엔 DB 가 없어 relay 된 createSession 의 mintAppToken
 *  (grant 검사·앱 토큰 발급)이 성립하지 않고 500 으로 죽는다(설계 R2-C10). 노드 relay 계약(게이트웨이가 토큰·
 *  자산을 선계산해 싣는 것)이 생기기 전까지 **relay 를 부르기 전에** 명시 거부한다. 중앙 세션·앱 없는 노드 세션은 무변경.
 */
export function assertAppSessionPlacement(input: { appId?: string }, nodeId: string): void {
  if (nodeId && input.appId) {
    throw new HttpError(400, "앱 세션은 아직 노드(개인 PC)에서 열 수 없습니다 — 중앙(박스)에서 여세요");
  }
}
