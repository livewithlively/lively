// 시크릿 redaction (B20) — 감사 로그·HTTP 프록시 응답·CRUD 입력에서 토큰/키 평문이 새는 것을 차단.
//  redactDeep:   깊은 순회로 시크릿 패턴 문자열을 마스킹(감사/응답을 굳히기 전 적용).
//  assertNoHardSecrets: 고위험 패턴이 입력에 있으면 저장 자체를 거부(경고가 아닌 hard-block).
//   → 훅 source_code·툴 url/description 이 평문 시크릿의 사본이 되는 것을 원천 차단. 인증은 auth_env(이름)로만.
import { HttpError } from "../../http-error.js";

// 마스킹 대상(global) — 로그/응답에서 가린다.
//  ⓘ 두 벌로 나눈다(#4422): 값 자체가 토큰 모양인 것(TOKEN_SHAPE_RES)과, 산문에서도 걸릴 수 있는 문맥 규칙(PROSE_RISKY_RES).
//   AI 가 쓴 글(위탁 결과 요약)처럼 산문이 주인 자리는 모양만 가린다 — «Bearer authentication middleware» 가 가려지면 안 된다.
//  `(?<![A-Za-z0-9])` — 낱말 안에서 시작하지 않게(`desk-ant-…`·`risk-0123…` 이 가려지지 않게). `_` 뒤는 허용(`X_sk-ant-…`).
const TOKEN_SHAPE_RES: RegExp[] = [
  //  Anthropic 키·OAuth(setup-token `sk-ant-oat01-…`·`sk-ant-api03-…`) — 아래 OpenAI 모양은 `sk-` 뒤가 곧장 영숫자 16자여야 해서
  //   `sk-ant-` 의 하이픈에서 끊겨 **못 잡았다**(#4422 실측). 위탁 리스 토큰이 이 모양이다.
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9]{2,10}-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{16,}/g,                              // OpenAI
  /(?<![A-Za-z0-9])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,     // OpenAI 프로젝트·서비스계정·관리 키(#4501 — 위 모양은 두 번째 하이픈에서 끊겨 못 잡았다)
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                                      // GitHub PAT(classic)·OAuth·앱 설치·사용자-서버·갱신
  /github_pat_[A-Za-z0-9_]{20,}/g,                                    // GitHub PAT(fine-grained)
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,                                    // Slack
  /AKIA[0-9A-Z]{16}/g,                                                // AWS access key id
  /lvk_[A-Za-z0-9_-]{20,}/g,                                          // 라이블리 토큰
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,     // JWT
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
];
const PROSE_RISKY_RES: RegExp[] = [
  /[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g,                            // Authorization: Bearer <literal>
];

// 저장 거부(hard-block) — 마스킹으로 끝낼 수 없는 명백한 평문 시크릿.
//  ⓘ #4501 — v6 콘텐츠(지식·프로젝트 본문 등 긴 산문)에도 걸리면서 맞췄다: Anthropic 키(위탁 리스·setup-token 이
//   이 모양인데 목록에 없었다) · GitHub 토큰 전 종류(ghp_ 만 있었다 — gho_/ghs_/ghu_/ghr_ 도 같은 자격) · OpenAI 는 위 마스킹과
//   같은 `(?<![A-Za-z0-9])` — 없으면 산문의 «risk-managementprocedures» 같은 낱말이 키로 잡혀 저장이 거부된다.
const HARD_LABELS: { re: RegExp; label: string }[] = [
  { re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9]{2,10}-[A-Za-z0-9_-]{16,}/, label: "Anthropic 키" },
  { re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{16,}/, label: "OpenAI 키" },
  { re: /(?<![A-Za-z0-9])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, label: "OpenAI 키" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/, label: "GitHub 토큰" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, label: "GitHub PAT" },
  { re: /xox[abprs]-[A-Za-z0-9-]{10,}/, label: "Slack 토큰" },
  //  AWS 공식 문서의 예시 키(AKIAIOSFODNN7EXAMPLE — 끝이 EXAMPLE)는 자격이 아니다 — 런북이 인용한다(#4501 실측: 지식 1건).
  { re: /AKIA(?![0-9A-Z]{9}EXAMPLE)[0-9A-Z]{16}/, label: "AWS 액세스 키" },
  { re: /lvk_[A-Za-z0-9_-]{20,}/, label: "라이블리 토큰" },
  //  머리줄 뒤에 키 본문(base64 40자+)이 이어질 때만 — 머리줄만 적은 형식 설명은 키가 아니다(#4501 실측: 공증 런북 1건).
  //   사이에 올 수 있는 것은 건너뛴다: 공백·줄바꿈, JSON 이스케이프 `\n`(GCP 서비스계정 private_key), 암호화 PEM 머리
  //   (`Proc-Type:`·`DEK-Info:`), 인용 블록 `>`. 격리 리뷰가 첫 판(공백만 허용)의 누락을 잡았다 — 그 판은 이 셋을 놓쳤다.
  //   ⚠ 머리 줄 갈래는 **줄 끝(\n 또는 이스케이프 \n)까지 먹어야** 한다. 끝을 열어 두면(`[^\n\\]*` 로 끝) `a:a:a:…` 를 나누는
  //    방법이 지수로 늘어 200바이트짜리 문자열 하나로 이벤트 루프가 멈췄다(ReDoS — 재검토 리뷰가 잡음, n=42 에서 308ms·×4/2자).
  //    이 검사는 사람·AI 쓰기 입구 21곳의 모든 문자열에 돈다. 적대 입력 시간 상한은 content-secrets.test E17 이 잰다.
  { re: /-----BEGIN[^-]*PRIVATE KEY-----(?:\s|>|\\[nr]|[A-Za-z-]+:[^\n\\]*(?:\n|\\[nr]))*[A-Za-z0-9+/=]{40,}/, label: "개인키" },
];

/** 토큰 모양만 가린다 — 산문이 주인인 자리(AI 가 쓴 요약 등)용. */
export function redactTokenShapes(s: string): string {
  let out = s;
  for (const re of TOKEN_SHAPE_RES) out = out.replace(re, "[REDACTED]");
  return out;
}

export function redactString(s: string): string {
  let out = redactTokenShapes(s);
  for (const re of PROSE_RISKY_RES) out = out.replace(re, "[REDACTED]");
  return out;
}

export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redactString(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = redactDeep(val);
    return o as unknown as T;
  }
  return v;
}

/** hint = 무엇을 대신 하라는 안내(자리마다 다르다 — 연결 설정은 env 이름, 콘텐츠는 자격 금고). */
export function assertNoHardSecrets(text: string, field: string, hint = "토큰 값 대신 환경변수 이름(auth_env)으로 참조하세요"): void {
  for (const { re, label } of HARD_LABELS) {
    if (re.test(text)) {
      throw new HttpError(400, `${field} 에 ${label}(으)로 보이는 평문 시크릿이 있습니다 — ${hint}`);
    }
  }
}
