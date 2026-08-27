// 세션의 **두 이름**을 한자리에서 다루는 순수 규칙(#2151). 세션 하나는 이름이 둘이다 —
//  박스 id(`box-…`, tmux/desired-state)와 대화 uuid(중앙 기록·하네스가 쥔 대화). 어느 표면에서 왔느냐에 따라
//  손에 들어오는 이름이 다른데, **판정은 늘 둘 다로 재야 한다.**
//
// 왜 이 규칙이 따로 있어야 하는가(2026-08-27 실측, 상민님 신고):
//  프로젝트를 통째로 버릴 때 묶음 수집기(capabilities/projects-v6.myProjectSessionIds)는 세 출처를 합치는데,
//  라이브·복원 목록은 **박스 id** 를, 중앙 기록 목록은 **대화 uuid** 를 준다. 그런데 휴지통 조작의
//  "아직 돌고 있는 세션인가?" 가드는 라이브 집합(박스 id)에 `ids` 를 그대로 대어 봤다 —
//  대화 uuid 로 들어온 세션은 `liveIds.has(uuid)` 가 언제나 false 라 **돌고 있는 세션이 멈춤 없이,
//  아무 경고 없이 휴지통으로 들어갔다.** 실측: 대화 9a0f069a(프로젝트 #1884 작업 세션)가 쓰레기 프로젝트
//  #1946 을 버릴 때 함께 쓸려 들어갔고, 그 뒤로도 30분 넘게 멀쩡히 일하고 있었다(트랜스크립트로 확인).
//  표식은 대화 uuid 에만 붙었고, 목록 응답이 `claudeSessionId` 로도 표식을 매칭하므로(terminal/routes.ts)
//  **그 대화를 이어받은 세션은 몇 번을 새로 띄워도 태어날 때부터 휴지통 소속** = 사이드바에서 영영 사라졌다.
//
// #2110('사이드바 × 가 안 먹던 이유')과 같은 계열이다 — **적는 자와 재는 자가 다른 어휘를 썼다.**
//  그래서 어휘 변환을 한 곳에 모으고, 여기 규칙으로만 재게 한다.

/**
 * 이 세션의 **모든 이름**. 호출자가 손에 든 이름(given)과, 그것을 풀어서 알아낸 박스 id·대화 uuid 를 합친다.
 * 빈 값·중복은 제거한다. 순서는 박스 id 우선 — 소비자가 '대표 이름'이 필요할 때 첫 값을 쓰면 되게.
 */
export function sessionNames(
  given: string,
  boxId?: string | null,
  convUuid?: string | null,
): string[] {
  const out: string[] = [];
  for (const x of [boxId, given, convUuid]) {
    const v = String(x ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 지금 돌고 있나 — 라이브 집합에 이 세션의 **어느 이름이라도** 있으면 살아 있는 것이다.
 *
 * ⚠ 라이브 집합은 tmux·노드 스냅샷에서 오므로 **박스 id 만** 들어 있다. 그래서 대화 uuid 하나만 대어 보면
 *  살아 있는 세션도 늘 '안 돌고 있음'으로 읽힌다 — 이 함수가 존재하는 이유다. 이름을 하나만 넘기지 마라.
 */
export function isLiveByAnyName(names: readonly string[], liveIds: ReadonlySet<string>): boolean {
  return names.some((n) => liveIds.has(n));
}
