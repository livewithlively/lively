// 수집 실패를 **어떻게 다룰지** 가르는 순수 판정(#1631) — 삼킬 것인가, 던질 것인가.
//
//  왜 필요한가(실측): 노션 토큰이 무효(`401 API token is invalid`)인데 미리보기가
//   `{"ok":true,"sample":[]}` 를 돌려줬다. 커넥터가 "루트 하나 접근 실패"로 집계하고 조용히 넘어갔고,
//   그 집계는 응답에 실리지 않기 때문이다. 사람은 "0건"만 보고, 리브도 원인을 추측하다 틀렸다.
//   페르소나 실측에서 사람이 통합 생성·권한 확인·페이지 연결·주소 재복사·5분 대기를 다 하고도
//   **진짜 이유를 못 들은 채** 이탈한 자리가 정확히 여기다.
//
//  ⚠ 그렇다고 모든 실패를 던지면 안 된다 — 페이지 10개 중 1개가 지워진 것과, 토큰이 틀려 10개가 전부
//   안 되는 것은 다르다. 전자는 계속 가야 하고 후자는 멈춰서 말해야 한다. 그 경계가 이 파일이다.

/**
 * 자격 **자체가** 무효인가 — 토큰이 틀렸거나 만료됐다.
 *
 * **401만 해당한다. 403 은 아니다.**
 * 403 은 "이 자원·이 능력은 안 된다"라서 나머지는 정상 동작한다 — 실제로 노션 커넥터는 댓글 403 을
 * 받으면 댓글만 건너뛰고 페이지 수집을 계속한다(그게 옳다). 403 을 치명으로 올리면 그 정상 동작이 깨진다.
 */
export function isInvalidCredential(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (status != null && Number(status) === 401) return true;

  // status 를 안 싣는 커넥터용 폴백. **숫자만으로 판단하지 않는다** — 페이지 id 나 경로에 401 이
  //  들어간 메시지를 오탐하면 멀쩡한 수집이 통째로 멈춘다. 인증을 가리키는 낱말이 함께 있어야 한다.
  const msg = err == null ? "" : String((err as { message?: unknown })?.message ?? err);
  return /(^|[^0-9])401([^0-9]|$)/.test(msg)
    && /unauthorized|invalid[_\s-]*(api[_\s-]*)?token|authentication|api key/i.test(msg);
}

/**
 * 사람이 **지정한 범위가 통째로 실패**했나 — 가져올 게 하나도 없다.
 *
 * 범위를 지정했는데 그게 전부 안 잡히면 그 실행은 "0건 수집 성공"이 아니라 **실패**다. 여기서 안 던지면
 * 사람은 "아직 아무것도 안 들어왔네" 로 읽고 원인을 영영 못 듣는다(401 이 아닌 403·404·오타 id 도 같다).
 *
 * ⚠ **범위를 지정하지 않은 경우는 해당 없다**(전체 검색 경로라 루트 개념이 없다).
 */
export function allScopedRootsFailed(configured: number, failed: number): boolean {
  return configured > 0 && failed >= configured;
}
