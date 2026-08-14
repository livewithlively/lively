// 위탁 실패의 **분류**(#1675 ②③) — "이 실패가 자격(인증) 때문인가"를 순수 함수로 판정한다.
//
// 왜 필요(어니스트 2026-08-12 전면장애): `claude setup-token` 이 폐기(401 revoked)되자 증류 크론의 위탁이
//  10분마다 9건씩 **전량** 실패했다. 그런데 실패는 전부 '일반 실패'로 취급돼 ① 재시도 대상이 되고
//  ② 다음 주기에 또 접수되고 ③ 아무도 알림을 못 받았다. 200건 연속 실패가 24시간 이어졌고, 그 사이
//  쌓인 세션 2,300개가 스왑을 고갈시켜 박스 전체를 무너뜨렸다.
//  (지식: ernest-token-revoked-session-leak-outage-0812)
//
// 자격 실패는 **회복 불가(terminal)** 다 — 사람이 토큰을 다시 발급하기 전엔 100% 같은 결과다. 그래서
//  일반 실패와 다르게 다뤄야 한다: 재시도 금지 · 후속 접수 차단 · 즉시 알림 · 그 크론 정지.
//
// ⚠ **오탐이 이 모듈의 유일한 실질 위험이다.** 이 판정이 참이면 크론이 멈추고 사람이 호출된다. 그런데
//  위탁의 산출물은 **AI 가 쓴 자유 텍스트**라, "401 인증 오류를 조사해줘" 같은 작업의 결과 요약에는
//  이 패턴이 얼마든 등장할 수 있다. 그래서 두 겹으로 막는다:
//   ① **stderr 우선.** stderr 는 하네스 CLI 가 쓴 것이지 AI 산출물이 아니다 — 여기 잡히면 신뢰도가 높다.
//   ② **요약은 짧을 때만 본다.** 자격 실패는 하네스가 init 단계에서 죽어 stream.jsonl 이 거의 비어 있다
//      (어니스트 실측: 40초 만에 exit=1). 반대로 AI 가 401 을 *논한* 보고서는 길다. SHORT_OUTPUT_CAP 이
//      그 경계다 — 넘으면 "작업은 돌았고 내용에 401 이 나왔을 뿐"으로 보고 판정하지 않는다.
//  그래도 남는 오탐은 판정 근거(evidence)를 알림에 실어 사람이 3초 만에 뒤집을 수 있게 한다.

/**
 * 요약(stream.jsonl 파생)에서 인증 패턴을 인정하는 최대 길이.
 * 이보다 길면 '하네스가 시작도 못 하고 죽은 것'이 아니라 '작업이 돌았고 산출물에 그 말이 있는 것'으로 본다.
 */
export const SHORT_OUTPUT_CAP = 600;

/**
 * 자격 실패 시그니처 — 하네스(claude CLI)/Anthropic API 가 **인증 거부**로 낼 때만 나오는 문구.
 *
 * ⚠ 여기에 `401` 단독이나 `token` 단독을 넣으면 안 된다 — HTTP 상태를 다루는 어떤 작업 로그에도 나온다.
 *  각 항목은 '인증 주체가 거부당했다'는 뜻이 문구 자체에 박혀 있어야 한다.
 */
const AUTH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // 어니스트 실측 원문: "Failed to authenticate. API Error: 401 OAuth access token has been revoked."
  { re: /OAuth\s+(?:access\s+)?token\s+has\s+been\s+revoked/i, label: "토큰 폐기(revoked)" },
  { re: /OAuth\s+(?:access\s+)?token\s+(?:has\s+)?expired/i, label: "토큰 만료(expired)" },
  { re: /Failed\s+to\s+authenticate/i, label: "인증 실패" },
  { re: /authentication_error/i, label: "authentication_error" },
  { re: /invalid[_\s]api[_\s]key/i, label: "API 키 무효" },
  { re: /\binvalid\s+bearer\s+token\b/i, label: "bearer 토큰 무효" },
  // `claude` CLI 가 미로그인 상태에서 안내하는 문구.
  { re: /please\s+run\s+\/login/i, label: "로그인 필요(/login)" },
  { re: /\bnot\s+(?:logged\s+in|authenticated)\b/i, label: "미인증" },
  // 401 은 **인증 낱말과 붙어 있을 때만** 인정한다(근접 매칭 — 80자 이내).
  { re: /\b401\b[\s\S]{0,80}?(?:unauthorized|oauth|authenticate|credential)/i, label: "401 인증 거부" },
  { re: /(?:unauthorized|oauth|authenticate|credential)[\s\S]{0,80}?\b401\b/i, label: "401 인증 거부" },
];

export interface TaskFailureInput {
  /** stderr.log 꼬리 — 하네스가 쓴 것(AI 산출물 아님). 신뢰도 높음. */
  error?: string | null;
  /** stream.jsonl 에서 뽑은 최종 요약 — **AI 산출물일 수 있다**. 짧을 때만 본다. */
  summary?: string | null;
}

export interface AuthFailure {
  /** 무엇으로 판정했나 — 알림에 그대로 실어 사람이 즉시 뒤집을 수 있게 한다. */
  label: string;
  /** 판정 근거를 담은 원문 조각(최대 200자). 시크릿이 섞이지 않게 토큰꼴 문자열은 지운다. */
  evidence: string;
  /** 어느 필드에서 잡았나 — stderr 가 summary 보다 신뢰도가 높다. */
  from: "stderr" | "summary";
}

/** 근거 조각을 안전하게 다듬는다 — 길이 상한 + **토큰꼴 문자열 제거**(알림·로그로 나가는 값이다). */
function safeEvidence(text: string, re: RegExp): string {
  const m = re.exec(text);
  const at = m ? Math.max(0, m.index - 40) : 0;
  return text.slice(at, at + 200)
    // sk-ant-…/oauth 토큰 등 긴 자격 문자열이 근거에 섞여 나가지 않게 — 알림은 슬랙으로 흘러간다.
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,})\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 이 실패가 **자격(인증) 실패**인가. 아니면 null.
 *
 * 호출 전제: 이미 실패(ok=false)로 종결된 태스크에만 부른다 — 성공 경로는 애초에 대상이 아니다.
 */
export function detectAuthFailure(input: TaskFailureInput): AuthFailure | null {
  const stderr = (input.error ?? "").trim();
  if (stderr) {
    for (const p of AUTH_PATTERNS) {
      if (p.re.test(stderr)) return { label: p.label, evidence: safeEvidence(stderr, p.re), from: "stderr" };
    }
  }
  // 요약은 **짧을 때만** — 위 머리주석 ②. 긴 산출물 안의 '401' 은 작업 내용이지 실행 실패가 아니다.
  const summary = (input.summary ?? "").trim();
  if (summary && summary.length <= SHORT_OUTPUT_CAP) {
    for (const p of AUTH_PATTERNS) {
      if (p.re.test(summary)) return { label: p.label, evidence: safeEvidence(summary, p.re), from: "summary" };
    }
  }
  return null;
}

/**
 * 이 실패를 **재시도해도 되나**(#1675 ②). 자격 실패는 재시도가 무의미하고 부하만 배로 만든다
 *  (`max_attempts:2` 가 어니스트에서 정확히 그 일을 했다).
 */
export function isRetriableFailure(input: TaskFailureInput): boolean {
  return detectAuthFailure(input) === null;
}

/**
 * 크론 잡 id 추출 — 위탁의 `requester_session` 마커가 `cron:<jobId>` 또는 `cron:<jobId>#<lane>` 꼴이다
 *  (_headless.enqueueHeadlessTask 가 심는다). 자격 실패 시 **어느 크론을 멈춰야 하는지**가 여기서 나온다.
 *  크론이 낸 위탁이 아니면(사람이 delegate_run 한 것) null — 멈출 크론이 없다.
 */
export function cronJobIdFromMarker(marker: string | null | undefined): string | null {
  const s = (marker ?? "").trim();
  if (!s.startsWith("cron:")) return null;
  const id = s.slice("cron:".length).split("#")[0].trim();
  return id || null;
}
