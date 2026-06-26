// 작업자(AI) 신원 — author_agent 의 단일 진실원천은 **게이트웨이가 본 접속 신원**(HTTP 헤더)이지 AI 자기보고가 아니다
//  (프로젝트 #182: "게이트웨이가 인증정보로 작업자 매핑"). 사람 축(author_person)은 이미 토큰→멤버로 게이트웨이 권위라
//  여기서 다루지 않는다.
//
//  하네스 식별 신호(우선순위):
//   1) `x-lively-harness` 헤더 — **per-harness 설치가 명시 stamp**(가장 권위·견고). 설치가 `--harness claude|codex` 라
//      어느 하네스인지 알고 그 하네스의 MCP 설정에 이 헤더를 박는다(claude-code=`claude mcp add --header`,
//      codex=config.toml `[mcp_servers.lively.http_headers]`). 가장 확실한 신호.
//   2) `User-Agent` — claude-code 는 `claude-code/<ver> (cli)` 를 보낸다(라이브 관측). ⚠ **codex 는 UA 를 안 보낸다**(라이브
//      관측, 2026-06-26) → UA 만으로는 codex 식별 불가라서 위 1) 헤더가 필요하다.
//   3) 둘 다 없으면 null → 호출자(activity_log)가 자기보고로 폴백.
//
//  stateless StreamableHTTP(요청마다 새 서버)라 MCP initialize 의 clientInfo 는 tools/call 요청에 없다 →
//   매 요청 존재하는 HTTP 헤더가 유일하게 신뢰할 수 있는 하네스 신호.

// 캐노니컬 하네스 id — 부분일치 패턴(소문자) → 정규화 id. 더 구체적인 패턴을 앞에 둔다.
const KNOWN_HARNESSES: ReadonlyArray<readonly [pattern: string, id: string]> = [
  ["claude-code", "claude-code"],
  ["claudecode", "claude-code"],
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["cline", "cline"],
  ["windsurf", "windsurf"],
];

// 자유 문자열(UA·헤더값) → 캐노니컬 하네스 id. 알려진 패턴은 정규화, 모르면 원문(64자) 보존
//  (게이트웨이가 실제로 '본' 값이라 자기보고보다 신뢰, 새 하네스도 데이터 무손실 — 매핑은 나중에 보강).
function normalizeHarness(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const [pattern, id] of KNOWN_HARNESSES) {
    if (lower.includes(pattern)) return id;
  }
  return trimmed.slice(0, 64);
}

// User-Agent → 작업자(AI) 신원. null = 식별 불가. (claude-code 전용 경로 — codex 는 UA 미전송.)
export function agentFromUserAgent(ua: string | null | undefined): string | null {
  return normalizeHarness(ua);
}

type Headers = Record<string, string | string[] | undefined> | undefined;

function headerValue(headers: Headers, key: string): string | null {
  const v = headers?.[key];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// HTTP 헤더 → 작업자(AI) 신원. x-lively-harness(설치 stamp, 권위) 우선, 없으면 User-Agent.
export function agentFromHeaders(headers: Headers): string | null {
  return normalizeHarness(headerValue(headers, "x-lively-harness"))
    ?? normalizeHarness(headerValue(headers, "user-agent"));
}

// MCP 핸들러 extra(RequestHandlerExtra) → 작업자(AI) 신원.
//  StreamableHTTPServerTransport 가 extra.requestInfo.headers(소문자 키, Object.fromEntries(Headers))로 넘긴다.
export function agentFromExtra(extra: unknown): string | null {
  const headers = (extra as { requestInfo?: { headers?: Headers } } | undefined)?.requestInfo?.headers;
  return agentFromHeaders(headers);
}
