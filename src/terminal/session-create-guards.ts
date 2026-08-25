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

/**
 * 첫 지시를 넣기 전 하네스의 **신뢰 대화상자를 대신 수락해도 되는 자리인가**(순수).
 *
 *  왜 필요한가(#1867 실측): 세션 전용 폴더(sessionDir)를 없애면서 자동 수락 조건이 `sessionDir` 과 함께 사라져
 *   `trustOk:false` 로 굳었다. 그러자 **라이블리가 스스로 만든 프로젝트 workspace**(`project/<id>`)에서 연 세션도
 *   "Is this a project you trust?" 에서 멈춰 **첫 지시가 영영 안 들어갔다**(2026-08-25 노드 세션 라이브 재현).
 *
 *  기준은 "세션 폴더인가"가 아니라 **이 폴더를 라이블리가 만들고 소유하는가**다(설계 [[workspace-project-binding-v2-design]]
 *   §세션 전용 폴더의 처리 — "사람이 직접 고른 임의 repo 는 파일을 건드리지 않는다"):
 *   · subpath 미지정 = 라이블리 루트 그 자체(개인/공유 워크스페이스) → 수락한다.
 *   · 프로젝트 세션이고 cwd 가 그 프로젝트의 canonical 폴더(또는 그 하위 워크트리) → 수락한다.
 *   · 그 밖(사람이 고른 임의 subpath) → 수락하지 않는다. 사람이 직접 답해야 한다.
 */
export function autoTrustWorkspace(input: { projectId?: number | null; subpath?: string | null }): boolean {
  const sub = String(input.subpath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!sub) return true;                                   // 라이블리 루트에서 시작 — 우리 자리다
  const pid = Number(input.projectId ?? 0);
  if (!Number.isInteger(pid) || pid <= 0) return false;     // 프로젝트 세션이 아닌데 폴더를 골랐다 = 사람의 폴더
  // 경계: `project/12` 와 `project/123` 을 접두로 헷갈리지 않게 세그먼트로 끊는다.
  const seg = sub.split("/");
  const base = seg[0], id = seg[1];
  return (base === "project" || base === "legacy-project") && id === String(pid);
}
