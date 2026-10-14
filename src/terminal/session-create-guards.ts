// 세션 생성 입력 가드 — 라우트(routes.ts)가 relay/createSession 을 부르기 **전에** 거는 순수 판정(#1780 v2 §7-1).
//  순수 함수로 둔 이유: 라우트는 express·노드 registry 에 묶여 단위 테스트가 안 되는데, 이 판정은 "무엇을 만들기
//  전에 거절하나" 라는 계약이라 그 자체로 못박혀야 한다(session-create-guards.test.ts).

//  (#3626) 여기 있던 assertAppSessionPlacement(노드+앱 400)는 사라졌다 — 노드 앱 세션은 게이트웨이가 토큰·자산을
//   선계산해 싣는 relay 계약(session-launch.ts prepareRemoteAppSession)이 생긴 뒤였고, 프로젝트 라우트만 옛 거절을
//   들고 있었다. 이제 두 입구가 같은 관문을 지나므로 거절 자리도 하나(그 계약)뿐이다.
import { LIV_SUBPATH } from "../org/liv/folder.js";   // 잎 상수 — 이 판정은 여전히 순수하다
import type { SessionKind } from "../sessions/session-kind.js";

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
 *   · 서버가 연 리브 세션(`task` 종류 · 개인 루트의 `liv`) → 수락한다(아래 #4032).
 *   · 프로젝트 세션이고 cwd 가 그 프로젝트의 canonical 폴더(또는 그 하위 워크트리) → 수락한다.
 *   · 그 밖(사람이 고른 임의 subpath) → 수락하지 않는다. 사람이 직접 답해야 한다.
 *
 *  리브 세션(#4032, 2026-09-16 매니지드 실측): 리브 부팅 훅을 켜려고 리브 세션(리브 탭·처음 설정 킥오프)을 개인 루트
 *   그 자체에서 `liv` 로 옮기자, 이 판정이 «사람이 고른 폴더» 로 읽어 첫 말이 신뢰 대화상자 앞에서 멈췄다
 *   (아웃박스 `trust_ok=false` 로 `sending` 고착 · 대화 기록 404).
 *   ⚠ 좌표만으로는 가를 수 없다 — 사람도 홈의 새 세션 폼에서 개인 폴더에 `liv` 를 만들어 같은 좌표로 열 수 있다
 *    (폴더 만들기에 예약어 제한이 없다). 그래서 **요청으로는 만들 수 없는 신호**를 함께 본다: 세션 종류 `task` 는
 *    서버 내부 호출만 준다(HTTP 는 sessionKindFromRequest 를 지나 login·app·human 만 된다). 프로젝트 예외가 안전한 이유
 *    (그 subpath 는 프로젝트 라우트가 봉쇄한다)와 같은 모양이다.
 *   정확히 그 폴더만 수락한다 — 그 아래 폴더는 리브 자리가 아니다(부팅 훅 게이트도 basename 이 `liv` 인 곳뿐이다).
 *   `rootKey` 가 비면 세션 생성과 같은 기본값(personal)으로 읽는다. 공유 루트의 `liv` 는 리브 자리가 아니다.
 */
export function autoTrustWorkspace(input: {
  projectId?: number | null; subpath?: string | null; rootKey?: string | null; kind?: SessionKind | null;
}): boolean {
  const sub = String(input.subpath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!sub) return true;                                   // 라이블리 루트에서 시작 — 우리 자리다
  //  서버가 연 리브 세션 — 우리가 정한 자리다(종류 task 는 요청으로 못 만든다).
  if (input.kind === "task" && (input.rootKey || "personal") === "personal" && sub === LIV_SUBPATH) return true;
  const pid = Number(input.projectId ?? 0);
  if (!Number.isInteger(pid) || pid <= 0) return false;     // 프로젝트 세션이 아닌데 폴더를 골랐다 = 사람의 폴더
  // 경계: `project/12` 와 `project/123` 을 접두로 헷갈리지 않게 세그먼트로 끊는다.
  const seg = sub.split("/");
  const base = seg[0], id = seg[1];
  return (base === "project" || base === "legacy-project") && id === String(pid);
}
