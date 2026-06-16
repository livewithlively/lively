// 시크릿 redaction (B20) — 감사 로그·HTTP 프록시 응답·CRUD 입력에서 토큰/키 평문이 새는 것을 차단.
//  redactDeep:   깊은 순회로 시크릿 패턴 문자열을 마스킹(감사/응답을 굳히기 전 적용).
//  assertNoHardSecrets: 고위험 패턴이 입력에 있으면 저장 자체를 거부(경고가 아닌 hard-block).
//   → 훅 source_code·툴 url/description 이 평문 시크릿의 사본이 되는 것을 원천 차단. 인증은 auth_env(이름)로만.
import { HttpError } from "../capabilities/rest-util.js";

// 마스킹 대상(global) — 로그/응답에서 가린다.
const SECRET_RES: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g,                                              // OpenAI
  /ghp_[A-Za-z0-9]{20,}/g,                                            // GitHub PAT(classic)
  /github_pat_[A-Za-z0-9_]{20,}/g,                                    // GitHub PAT(fine-grained)
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,                                    // Slack
  /AKIA[0-9A-Z]{16}/g,                                                // AWS access key id
  /lvk_[A-Za-z0-9_-]{20,}/g,                                          // 라이블리 토큰
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,     // JWT
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g,                            // Authorization: Bearer <literal>
];

// 저장 거부(hard-block) — 마스킹으로 끝낼 수 없는 명백한 평문 시크릿.
const HARD_LABELS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9]{16,}/, label: "OpenAI 키" },
  { re: /ghp_[A-Za-z0-9]{20,}/, label: "GitHub 토큰" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, label: "GitHub PAT" },
  { re: /xox[abprs]-[A-Za-z0-9-]{10,}/, label: "Slack 토큰" },
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS 액세스 키" },
  { re: /lvk_[A-Za-z0-9_-]{20,}/, label: "라이블리 토큰" },
  { re: /-----BEGIN[^-]*PRIVATE KEY-----/, label: "개인키" },
];

export function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_RES) out = out.replace(re, "[REDACTED]");
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

export function assertNoHardSecrets(text: string, field: string): void {
  for (const { re, label } of HARD_LABELS) {
    if (re.test(text)) {
      throw new HttpError(400, `${field} 에 ${label}(으)로 보이는 평문 시크릿이 있습니다 — 토큰 값 대신 환경변수 이름(auth_env)으로 참조하세요`);
    }
  }
}
