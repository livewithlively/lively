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

// 캐노니컬 하네스 id 집합(중복 제거) — normalizeHarness 가 **식별에 성공한** 값만. 원문 보존된 UA
//  (curl/8.7.1 · Google · python-requests …)와 구분해야 하는 소비자용이다.
//  ⚠ 이 구분이 필요한 이유(#1570): 사용 내역 위젯이 "같은 맥락을 여러 AI 도구에서 이어받았다"를 말할 때
//   미식별 UA 를 하네스로 세면 **화면이 거짓을 주장한다**(스크립트 한 번 돈 것이 '도구'가 된다). 로그가
//   거짓말하면 배지보다 신뢰를 더 깎으므로, 그런 소비자는 이 집합으로 좁혀 세고 미식별은 버린다.
//   위 KNOWN_HARNESSES 에 하네스를 추가하면 그 소비자도 자동으로 따라온다(목록 두 벌 금지).
export const CANONICAL_HARNESS_IDS: readonly string[] = [...new Set(KNOWN_HARNESSES.map(([, id]) => id))];

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

// ── 세션 신원(#852) — "이 요청은 **어느 터미널 세션**에서 왔는가". ──
//  author_agent(위)와 완전히 같은 원리다: **게이트웨이가 접속에서 본 것**이 권위이고 AI 자기보고가 아니다.
//  경로: 세션 생성 시 pane 에 `-e LIVELY_SESSION_ID=box-…`(terminal-sessions.createSession)
//        → 하네스 MCP 설정의 `x-lively-session: ${LIVELY_SESSION_ID}` 헤더(연결 시 env 확장)
//        → 여기서 읽어 ctx.session → activity_log 가 기록.
//  세션 밖(개인 랩탑 등)이면 env 가 없어 빈 값/미확장 문자열이 온다 → null(=미기록). 무회귀 폴백.
//
//  ⚠ 왜 형식만 보나: 헤더는 클라이언트 자기주장이다. 여기선 **모양**만 거른다(box-<slug>-<8hex>) —
//   그것만으로도 옛 오염(하네스가 제 UUID 를 자기보고하던 값)과 미확장 리터럴 '${LIVELY_SESSION_ID}' 가 탈락한다.
//   "그 세션에서 일할 자격이 있는 사람인가"는 형식으로 알 수 없으므로 **소비처(activity_log)가 canAttach 로** 본다
//   (프로젝트 폴더 세션은 공동 세션이라 소유자가 아닌 팀원도 정당하게 그 세션에서 일한다 — 소유자 대조로는 못 가른다).
export const SESSION_ID_RE = /^box-[a-z0-9-]+-[a-f0-9]{8}$/;

export function sessionFromHeaders(headers: Headers): string | null {
  const raw = headerValue(headers, "x-lively-session");
  if (!raw) return null;
  const v = String(raw).trim();
  return SESSION_ID_RE.test(v) ? v : null;
}

export function sessionFromExtra(extra: unknown): string | null {
  const headers = (extra as { requestInfo?: { headers?: Headers } } | undefined)?.requestInfo?.headers;
  return sessionFromHeaders(headers);
}

// ── 실행 모드(#1007+) — "이 요청은 어느 모드인가"(normal|readonly|incognito). **단일 헤더 x-lively-mode** 로 전달. ──
//  x-lively-session(#852)·x-lively-harness(#182)와 **같은 레일·같은 원리**: 게이트웨이가 접속 헤더에서 본 것이 권위. 무상태 /mcp 라 요청마다 재계산 = per-session.
//  경로: `lively run --readonly|--incognito`(또는 웹 셀렉터) → pane env `LIVELY_MODE=…` → 하네스 MCP 헤더 `x-lively-mode: ${LIVELY_MODE:-}`(연결 시 확장) → 여기.
//   readonly = 쓰기 툴 소거·REST 쓰기 403 · incognito = lively 툴 0개+전체 차단(읽기 포함) = 사실상 연결없음(+ 훅 off).
//  ⚠ **opt-in fail-safe**: 유효 모드(readonly|incognito)만 인정. 미설정·미확장 리터럴 `${LIVELY_MODE:-}`·빈 값·기타는 전부 **normal(쓰기 허용)** — 실수로 격리에 빠지지 않게.
//  ⚠ **하위호환**: 단일 헤더 이전(#1007 초기)의 구 boolean 헤더 x-lively-readonly / x-lively-incognito 도 fallback 으로 인정 — 아직 x-lively-mode 로 재등록/전파 안 된 기존 설치를 위해(자동 업데이터가 x-lively-mode 를 additive 로 채우면 그게 우선).
const MODE_TRUTHY: ReadonlySet<string> = new Set(["1", "true", "on", "yes"]);
const VALID_MODES: ReadonlySet<string> = new Set(["readonly", "incognito"]); // normal='아무것도 아님'이라 별도 취급 불요
const isTruthy = (raw: string | null): boolean => !!raw && MODE_TRUTHY.has(String(raw).trim().toLowerCase());

export type SessionMode = "normal" | "readonly" | "incognito";

export function modeFromHeaders(headers: Headers): SessionMode {
  const m = headerValue(headers, "x-lively-mode");
  if (m) { const v = String(m).trim().toLowerCase(); if (VALID_MODES.has(v)) return v as SessionMode; }
  // 하위호환 fallback(구 boolean 헤더) — incognito 가 readonly 보다 강하므로 먼저 본다.
  if (isTruthy(headerValue(headers, "x-lively-incognito"))) return "incognito";
  if (isTruthy(headerValue(headers, "x-lively-readonly"))) return "readonly";
  return "normal";
}
export function modeFromExtra(extra: unknown): SessionMode {
  const headers = (extra as { requestInfo?: { headers?: Headers } } | undefined)?.requestInfo?.headers;
  return modeFromHeaders(headers);
}

// 편의 파생 — 강제 코드(index.ts·web.ts·server.ts)는 이 둘로 게이트한다(모드 판정의 단일 소스는 modeFromHeaders).
export function readOnlyFromHeaders(headers: Headers): boolean { return modeFromHeaders(headers) === "readonly"; }
export function incognitoFromHeaders(headers: Headers): boolean { return modeFromHeaders(headers) === "incognito"; }
export function readOnlyFromExtra(extra: unknown): boolean { return modeFromExtra(extra) === "readonly"; }
export function incognitoFromExtra(extra: unknown): boolean { return modeFromExtra(extra) === "incognito"; }
