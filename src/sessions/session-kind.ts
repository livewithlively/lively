// **이 세션을 누가·무엇을 위해 열었나** — 세션 신원의 1급 축 (#2162).
//
//  ── 왜 이 축이 생겼나 ─────────────────────────────────────────────────────
//  #1979 는 같은 뿌리에서 나온 결함 **둘**을 고쳤다:
//   ① 이름짓기 헤드리스가 부모 env 를 상속해 훅이 부모 세션을 오염시켰다(모듈 삭제로 해소).
//   ② 위탁 워커의 **첫 프롬프트가 서버 조립물**이라 project-auto-bind 가 사람의 첫 지시로 오인했다
//      (`LIVELY_TASK_WS` 가드로 해소). 10분 주기 증류 크론만으로 하루 100건대 쓰레기가 쌓였다.
//  둘 다 "새로 만든 기계 세션 경로에 가드를 안 붙인 것"이고, 그건 **기본값이 '사람 세션'이기 때문**이었다.
//
//  ── 이 파일이 뒤집는 것 ───────────────────────────────────────────────────
//  종전엔 종류 신호가 **두 벌로 갈라져** 있었다(전수는 프로젝트 #2162 본문):
//   · 서버가 아는 것 — CreateInput 의 흩어진 필드(`managed`·`loginFor`·`appId`)
//   · 훅이 보는 것 — pane env(`LIVELY_MODE`·`LIVELY_TASK_WS`·`LIVELY_APP_ID`)
//  둘은 겹치지도 이어지지도 않았다. 특히 상시 세션 표시는 **pane env 로 한 글자도 안 나갔다** —
//  서버는 "이건 기계"를 아는데 훅은 못 봤다. 그래서 새 경로는 말없이 사람 세션이 됐다.
//
//  ⚠ `CreateInput.managed` 와 **직교**다(#2170 이 그걸 boolean → 상시세션 id 로 바꿨다). 그 필드는
//   **누구의 것인가**(정리기가 '내가 만든 세션'을 판정하는 신원)를, kind 는 **무엇인가**(종류)를 말한다.
//   종전 `managed: true` 는 그 둘을 한 불리언에 겹쳐 놓아 어느 쪽도 제대로 못 말했다.
//
//  이제 **한 축**이고, `CreateInput.kind` 는 **필수**다. 새 세션 경로를 만들며 종류를 잊으면
//  **컴파일이 안 된다** — 세 번째 사고를 사람 주의력에 맡기지 않는 것이 이 설계의 전부다.
//
//  ⚠ 실행 모드(readonly·incognito)는 **직교 축**이다. 사람이 연 세션도 읽기전용일 수 있다.
//   kind 로 흡수하지 마라 — 흡수하면 "읽기전용 위탁"을 표현할 수 없어진다.
//  ⚠ `LIVELY_SESSION_ID` 는 기계 세션에서도 뺄 수 없다 — #1291 이 기록범위 캡 조회를 위해 일부러 넣었다
//   (빼면 그 경로의 AI 가 항상 전체 공개로 기록한다). kind 는 신원을 **지우는** 축이 아니라 **설명하는** 축이다.

/**
 * 세션의 종류. 늘리는 건 자유지만, 늘리면 **아래 정책 함수들이 컴파일 에러로** 판단을 요구한다
 * (switch 가 exhaustive 다) — 그게 이 타입의 값어치다.
 *
 *  · `human`   사람이 웹·CLI 에서 연 작업 세션(프로젝트 세션·복원 포함). **유일하게** 프로젝트를 갖고 이름을 짓는다.
 *  · `task`    위탁 워커(spawnTaskSession) — 크론·delegate_run·`lively delegate`. 첫 프롬프트가 서버 조립물이다.
 *  · `managed` 상시 세션(org_managed_session) — keep-alive 가 영속을 소유하고 크론이 프롬프트를 주입한다.
 *  · `app`     앱 세션(#1780) — 소속이 인스턴스 축에 따로 있어 프로젝트를 만들지 않는다.
 *  · `login`   로그인 절차용(#1516) — 하네스 TUI 가 아니라 로그인 명령을 셸에서 돌린다. 작업 세션이 아니다.
 */
export type SessionKind = "human" | "task" | "managed" | "app" | "login";

const ALL: readonly SessionKind[] = ["human", "task", "managed", "app", "login"];

/** pane env 이름 — 훅이 읽는 유일한 종류 신호. 값은 SessionKind 그대로. */
export const SESSION_KIND_ENV = "LIVELY_SESSION_KIND";

/**
 * 저장/전송된 값 → SessionKind. **모르는 값·빈 값은 `human`** 이다.
 *
 *  ⚠ 왜 안전한 쪽(기계)이 아니라 `human` 으로 떨어지나 — 이 축이 생기기 **전에 만들어진 세션**과
 *   구 노드 번들이 보내는 요청이 여기로 온다. 그것들은 대부분 진짜 사람 세션이고, 기계로 오인하면
 *   **사람의 세션이 프로젝트를 못 갖고 이름도 못 받는다**(조용한 기능 상실 — 훨씬 나쁘다).
 *   기계 경로는 전부 **명시**하므로(컴파일 강제) 이 폴백에 의존하지 않는다.
 */
export function normalizeSessionKind(v: unknown): SessionKind {
  const s = String(v ?? "").trim().toLowerCase();
  return (ALL as readonly string[]).includes(s) ? (s as SessionKind) : "human";
}

/**
 * HTTP 세션 생성 요청 → SessionKind. **요청을 종류로 옮기는 유일한 자리**다.
 *
 *  왜 함수로 빼나 — 이 매핑을 라우트 안에 인라인으로 두면 아무도 못 본다. 종전에 `appId`·`loginFor` 를
 *   판정하는 곳마다 되짚던 것이 정확히 그 모양이었고, 그래서 새 종류가 생길 때 조건 추가를 잊어도
 *   아무 신호가 없었다. 여기 한 곳에 두고 표로 테스트한다.
 *
 *  ⚠ `readOnly`·`incognito` 는 여기 안 들어온다 — **직교 축**이다(읽기전용인 사람 세션이 있다).
 */
export function sessionKindFromRequest(b: { loginFor?: unknown; appId?: unknown }): SessionKind {
  if (String(b.loginFor ?? "").trim()) return "login";
  if (String(b.appId ?? "").trim()) return "app";
  return "human";
}

/**
 * **사람이 연 작업 세션인가** — 프로젝트 자동 생성·자동 바인딩·이름짓기의 대상인가.
 *
 *  이 한 술어가 종전의 흩어진 판정을 대신한다:
 *   · firstPromptProjectPlan 의 `appId || loginFor` 배제
 *   · project-auto-bind 훅의 `LIVELY_TASK_WS` 가드
 *   · session-name-ask 훅의 같은 가드
 */
export function isWorkSession(kind: unknown): boolean {
  switch (normalizeSessionKind(kind)) {
    case "human": return true;
    case "task": case "managed": case "app": case "login": return false;
  }
}

/**
 * **기계가 연 세션인가** — 사람이 그 프롬프트를 친 게 아닌가.
 *  `app`·`login` 은 사람이 열었지만 **작업 세션은 아니다**(isWorkSession=false, isMachineSession=false).
 *  둘을 하나로 합치지 마라 — "누가 열었나"와 "작업 세션인가"는 다른 질문이고, 화면 표시(배치 배지)는
 *  전자를, 프로젝트·이름 정책은 후자를 본다.
 */
export function isMachineSession(kind: unknown): boolean {
  switch (normalizeSessionKind(kind)) {
    case "task": case "managed": return true;
    case "human": case "app": case "login": return false;
  }
}
