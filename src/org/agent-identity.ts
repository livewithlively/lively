// 작업자(AI) 신원 — author_agent 의 단일 진실원천은 **게이트웨이가 본 접속 신원**(HTTP User-Agent)이지
//  AI 자기보고가 아니다(프로젝트 #182: "게이트웨이가 인증정보로 작업자 매핑"). MCP 하네스(claude-code/codex …)는
//  클라이언트마다 고유한 User-Agent 를 보내므로, 게이트웨이가 매 요청 그 헤더로 어떤 AI 인지 권위 있게 식별한다.
//  사람 축(author_person)은 이미 토큰→멤버로 게이트웨이 권위라 여기서 다루지 않는다.
//
//  설계 원칙: 알려진 UA 는 캐노니컬 하네스 id 로 정규화하고, 모르는 UA 는 **원문을 보존**한다 — 게이트웨이가
//   실제로 '본' 값이라 자기보고보다 항상 신뢰할 수 있고, 새 하네스가 들어와도 데이터를 잃지 않는다(매핑은 나중에 보강).
//   stateless StreamableHTTP(요청마다 새 서버)라 MCP initialize 의 clientInfo 는 tools/call 요청에 없다 →
//   매 요청 존재하는 User-Agent 헤더가 유일하게 신뢰할 수 있는 하네스 신호다.

// 캐노니컬 하네스 id — 부분일치 패턴(소문자) → 정규화 id. 더 구체적인 패턴을 앞에 둔다.
//  ⚠ 실제 UA 문자열은 라이브 관측으로 검증/보강한다(claude-code·codex 가 보내는 정확한 UA). 미지의 UA 는 원문 폴백.
const KNOWN_HARNESSES: ReadonlyArray<readonly [pattern: string, id: string]> = [
  ["claude-code", "claude-code"],
  ["claudecode", "claude-code"],
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["cline", "cline"],
  ["windsurf", "windsurf"],
];

// User-Agent → 작업자(AI) 신원. null = 식별 불가(사람의 웹 직접 조작 등 — 표시 계층에서 '직접').
//  알려진 하네스는 캐노니컬 id, 모르는 UA 는 원문(64자 절단) 보존. 빈/누락 UA 는 null.
export function agentFromUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const trimmed = ua.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const [pattern, id] of KNOWN_HARNESSES) {
    if (lower.includes(pattern)) return id;
  }
  // 미지의 UA: 게이트웨이 관측 원문 보존(자기보고보다 신뢰). 표시·저장 안전 위해 64자 절단.
  return trimmed.slice(0, 64);
}

// MCP 핸들러 extra(RequestHandlerExtra)에서 원본 HTTP User-Agent 추출.
//  StreamableHTTPServerTransport 가 extra.requestInfo.headers(소문자 키, Object.fromEntries(Headers))로 넘긴다.
export function userAgentFromExtra(extra: unknown): string | null {
  const headers = (extra as { requestInfo?: { headers?: Record<string, string | string[] | undefined> } } | undefined)
    ?.requestInfo?.headers;
  const ua = headers?.["user-agent"];
  if (Array.isArray(ua)) return ua[0] ?? null;
  return ua ?? null;
}
