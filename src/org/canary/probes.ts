// 상류 회귀 자동탐지 — 프로브 정의 + 판정 (#1657).
//
// ── 왜 스키마 diff 로는 이번 사고를 못 잡나 (이 파일의 존재 이유) ──────────────────────────────
//  구글은 스키마를 **하나도 안 바꿨다.** `tools/list` 는 지금도 8툴을 멀쩡히 준다 — 토큰 없이 **익명으로 쳐도**
//  200 이다. 바뀐 건 데이터 평면의 인가 동작뿐이다. 그래서 계약 스냅샷을 아무리 비교해도 초록불이었다.
//  더구나 이번 403 은 **HTTP 200 + isError:true** 로 왔다 — "200 이 왔나"조차 판정 근거가 못 된다.
//  → 탐지는 **실자격으로 실호출하고 응답 '내용'을 단언**해야 한다. 그게 프로브다.
//
// ── ⚠ 설계 함정: 카나리가 고객보다 잘 설정돼 있으면 눈이 먼다 ─────────────────────────────────
//  이번 게이트는 **GCP 프로젝트 단위**다. 우리만 Developer Preview 에 등록해 두면 전 고객이 깨져도 우리 카나리는
//  초록불이다. 그래서 프로브마다 **구성 등급(tier)** 을 명시하고, 어댑터마다 '고객과 같은 등급(plain)' 프로브가
//  최소 하나 있어야 한다(assertProbeCoverage 가 강제). 등급이 갈릴 수밖에 없으면 그 축마다 프로브를 따로 둔다.
//
// ── 어디서 도나 ────────────────────────────────────────────────────────────────────────────
//  **고객사 게이트웨이가 아니다.** 카나리 자격을 고객이 들면 안 되고, 신호는 고객 수만큼이 아니라 함대 단위로
//  하나여야 한다. 라이블리 인프라에서 우리 계정(카나리 멤버)으로 돈다 — 실행 주체는 org_cron 이 정한다.

/** 선언적 단언 — '무엇이 오면 정상인가'. 코드가 아니라 데이터라 프로브를 늘려도 판정 로직은 그대로다. */
export interface ProbeExpect {
  /** 응답 본문이 JSON 이어야 한다. */
  json?: boolean;
  /** 이 경로들에 값이 있어야 한다. 점 표기 + 배열 인덱스: "files.0.id" */
  paths?: string[];
  /** 이 경로가 배열이고 최소 개수 이상이어야 한다. */
  arrayMin?: Array<{ path: string; min: number }>;
  /** 원문에 반드시 있어야 할 문자열(형식이 유동적인 상류용). */
  contains?: string[];
  /** 있으면 실패 — 상류가 200 으로 위장해 보내는 거부 문구를 잡는다. */
  notContains?: string[];
}

export type ProbeAdapter = "mcp_proxy" | "http_proxy" | "http_direct";
/**
 * 구성 등급 — **고객과 같은 구성인가**. plain = 고객이 하는 그대로(추가 등록·특례 없음).
 *  privileged = 우리만 가진 구성(예: Developer Preview 등록). 둘을 함께 돌려야 '우리만 되는 고장'이 보인다.
 */
export type ProbeTier = "plain" | "privileged";

export interface CanaryProbe {
  key: string;                                   // 안정 식별자(결과 행의 축)
  label: string;
  adapter: ProbeAdapter;
  tier: ProbeTier;
  /** mcp_proxy: {server, tool} · http_proxy: {tool}=org_tool 이름 · http_direct: {url} */
  target: { server?: string; tool?: string; url?: string };
  args: Record<string, unknown>;
  expect: ProbeExpect;
  why: string;                                   // 이 프로브가 무엇을 지키는지(경보 본문에 실린다)
}

// 상류가 "권한 없음"을 200 으로 실어 보내는 문구들 — 이번 사고의 실제 문자열이 여기 있다.
export const DENIAL_MARKERS = [
  "does not have permission",
  "PERMISSION_DENIED",
  "insufficient authentication scopes",
  "invalid_grant",
  "unauthorized",
];

/**
 * 슬랙은 거부를 **HTTP 200 + `ok:false` 봉투**로 준다 — 구글 문구와 겹치지 않으므로 따로 둔다.
 *  `missing_scope`·`not_allowed_token_type` 이 T9 가 겨눈 바로 그 고장이다(legacy 메서드는 새 앱의
 *  분할형 스코프를 거부한다). `invalid_auth`·`token_revoked` 는 연결자가 앱을 지운 경우.
 */
export const SLACK_DENIAL_MARKERS = [
  "missing_scope",
  "not_allowed_token_type",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "\"ok\":false",
];

// ⚠ 프로브가 보는 응답 본문은 **상류가 준 것 그대로**다(2026-08-12 dev 실측에서 잡음).
//  http_proxy 프로브는 `runHttpProxyTool` 을 직접 부르므로, MCP 등록 핸들러가 씌우는
//  `{status, ok, truncated, body}` 래퍼가 **없다.** 그 래퍼를 전제로 `paths:["body"]` 를 걸면
//  호출이 200 으로 멀쩡히 성공해도 "경로 body 가 없다"로 거짓 실패한다.
//  → 단언은 **상류 스키마 기준**으로 쓴다(Drive 는 `files`, Gmail 은 `labels`·`messages`).
// ── D 어댑터(http_direct · 프록시 없는 상류) — 하네스 설치기 (#2255) ───────────────────────────
//
//  ⚠ **머리말의 "별도 HTTP 클라이언트로 상류를 직접 찌르지 마라" 와 충돌하지 않는다.** 그 규칙의 이유는
//   "고객이 쓰는 길을 그대로 타야 우리 쪽 고장이 보인다" 인데, **여기엔 우리 쪽 길이 아예 없다** —
//   설치기는 회원 기계의 `curl`/`irm` 이 공급사를 **직접** 친다. 프록시를 태우면 그게 오히려 고객이
//   안 쓰는 길을 재는 것이 된다. 즉 이 어댑터에서는 직접 호출이 «고객과 같은 길» 이다.
//
//  무엇을 지키나 — `kit/hooks/harness-registry.mjs` 의 `install` 축은 2026-08-28 에 **스크립트 본문을 읽고**
//   쓴 값이다. 공급사가 URL 을 옮기거나 스크립트를 갈아치우면 그 표가 조용히 낡고, 우리는 **회원이 설치에
//   실패한 뒤에야** 안다. 이 프로브가 그 간극을 메운다.
//
//  ⚠ 한계(정직하게): 이건 **우리 인프라에서 본** 상류다. 회원 네트워크의 프록시·방화벽은 못 본다.
//   잡는 것은 «URL 이 죽었다 · 404 HTML 이 온다 · 우리가 의존하는 계약이 사라졌다» 셋이다.
export interface InstallerProbeSpec {
  id: string;                 // 하네스 id — 레지스트리 HARNESS_IDS 와 같아야 한다(테스트가 강제)
  os: "posix" | "win";
  label: string;
  url: string;
  /** 이 스크립트가 여전히 **우리가 아는 그것**임을 알리는 지문. 2026-08-28 본문에서 뽑았다. */
  marker: string;
  why: string;
}

/** 200 인데 스크립트가 아닌 것 — 404 안내 페이지·리다이렉트 랜딩이 이렇게 온다.
 *  ⚠ `\uFEFF`(BOM)는 [[delivery-install-invariants]] ⑤ 의 그 고장이다 — 파이프로 평가되는 스크립트의
 *   1번 문자가 BOM 이면 파스가 무너진다(#1087 이 윈도우 신규 설치를 전면 차단했다). */
export const SCRIPT_ROT_MARKERS = ["<!doctype", "<html", "\uFEFF"];

export const HARNESS_INSTALLERS: InstallerProbeSpec[] = [
  { id: "claude", os: "posix", label: "Claude Code", url: "https://claude.ai/install.sh",
    marker: "downloads.claude.ai", why: "하네스가 하나도 없는 사람의 기본 설치 경로 — 여기가 죽으면 신규 회원이 시작조차 못 한다." },
  { id: "claude", os: "win", label: "Claude Code", url: "https://claude.ai/install.ps1",
    marker: "downloads.claude.ai", why: "윈도우 자동 설치의 유일한 길(#2255 구멍 ①이 이 파일의 존재를 몰라서 생겼다)." },
  { id: "codex", os: "posix", label: "Codex", url: "https://chatgpt.com/codex/install.sh",
    marker: "CODEX_NON_INTERACTIVE",
    why: "★가장 값진 단언 — 5종 중 **유일하게 프롬프트가 있는** 설치기이고, 이 env 가 사라지면 우리 설치 흐름이 `Start Codex now?` 에서 멈춘다(실측: /dev/tty 를 직접 연다)." },
  { id: "codex", os: "win", label: "Codex", url: "https://chatgpt.com/codex/install.ps1",
    marker: "CODEX_NON_INTERACTIVE", why: "위와 같은 계약의 윈도우 판(install.ps1:14 이 같은 env 를 읽는다 — 실측)." },
  { id: "opencode", os: "posix", label: "OpenCode", url: "https://opencode.ai/install",
    marker: "opencode", why: "opencode 의 유일한 스크립트 경로(윈도우는 공급사가 안 준다 — npm 으로 간다)." },
  { id: "antigravity", os: "posix", label: "Antigravity CLI", url: "https://antigravity.google/cli/install.sh",
    marker: "antigravity", why: "Go 단일 바이너리 배포 — 이미 있으면 exit 0 으로 비켜서는 성질에 우리가 기대고 있다." },
  { id: "antigravity", os: "win", label: "Antigravity CLI", url: "https://antigravity.google/cli/install.ps1",
    marker: "antigravity", why: "윈도우 자리는 %LOCALAPPDATA%\\agy\\bin — 표의 binDir 이 이 스크립트에서 왔다." },
  { id: "grok", os: "posix", label: "Grok Build", url: "https://x.ai/cli/install.sh",
    marker: "x.ai/cli", why: "무결성 검증이 없는 설치기라(실측) 내용이 바뀌면 우리가 먼저 알아야 한다." },
  { id: "grok", os: "win", label: "Grok Build", url: "https://x.ai/cli/install.ps1",
    marker: "x.ai/cli", why: "위와 같음 — ps1 판도 체크섬을 안 본다." },
];

const installerProbes: CanaryProbe[] = HARNESS_INSTALLERS.map((s) => ({
  key: `d.harness_install.${s.id}.${s.os}`,
  label: `${s.label} 설치기(${s.os === "win" ? "Windows" : "POSIX"})`,
  adapter: "http_direct" as const,
  tier: "plain" as const,
  target: { url: s.url },
  args: {},
  expect: { contains: [s.marker], notContains: SCRIPT_ROT_MARKERS },
  why: s.why,
}));

export const CANARY_PROBES: CanaryProbe[] = [
  // ── B 어댑터(http_proxy · 클래식 REST) — 우리가 계약을 소유한다. 응답 형태 변화만 보면 되므로 싸다. ──
  {
    key: "b.google_drive.search",
    label: "Drive 검색(B · 클래식 API)",
    adapter: "http_proxy", tier: "plain",
    target: { tool: "google_drive_search" },
    args: { pageSize: 1 },
    // `files` 키의 존재가 곧 인가 통과 신호다 — 거부되면 이 키가 아예 안 온다. 개수는 안 본다
    //  (빈 드라이브도 정상인 구성이 있고, 그걸 실패로 세면 고객과 같은 등급이라는 전제가 깨진다).
    expect: { json: true, paths: ["files"], notContains: DENIAL_MARKERS },
    why: "구글을 B 로 내린 근거 자체 — 같은 토큰으로 클래식 API 는 200 이라는 비대칭이 유지되는가.",
  },
  {
    key: "b.google_gmail.labels",
    label: "Gmail 라벨 목록(B · 클래식 API)",
    adapter: "http_proxy", tier: "plain",
    target: { tool: "google_gmail_labels" },
    args: {},
    expect: { json: true, paths: ["labels"], notContains: DENIAL_MARKERS },
    why: "메일 읽기 경로의 최소 왕복 — 자격·scope·엔드포인트가 한꺼번에 검증된다.",
  },
  // ── A 어댑터(MCP 프록시) — 계약을 **상류가 소유**한다. 스키마도 동작도 우리 동의 없이 바뀐다. ──
  //  구글 A 프로브는 '지금 깨져 있음'을 고정한다: 고쳐지면(=우리가 프리뷰에 등록되거나 구글이 게이트를 풀면)
  //  이 프로브가 초록으로 바뀌고, 그 변화 자체가 우리가 알아야 할 신호다.
  {
    key: "a.google_drive.recent",
    label: "Drive 최근 파일(A · 호스티드 MCP)",
    adapter: "mcp_proxy", tier: "plain",
    target: { server: "google-drive", tool: "list_recent_files" },
    args: {},
    expect: { contains: ["files"], notContains: DENIAL_MARKERS },
    why: "Developer Preview 게이트 상태. 미등록 조직(=고객 기본값)에서 이게 초록이 되면 게이트가 풀린 것이다.",
  },
  // ── 슬랙 B(#1994 T11) — 구글은 2개인데 슬랙은 0개였다. 슬랙은 **수집과 도구가 같은 상류**를 쓰는데
  //  그 상류가 검색 표면을 갈아치우는 중이라(legacy search.messages → assistant.search.context) 눈이 필요하다.
  {
    key: "b.slack.search",
    label: "슬랙 검색(B · assistant.search.context)",
    adapter: "http_proxy", tier: "plain",
    target: { tool: "slack_search_messages" },
    args: { query: "lively" },
    // ★ `results.messages` 는 **현행 표면의 지문**이다. legacy(search.messages)는 `messages.matches` 를 주므로
    //  이 단언이 빨간불이면 둘 중 하나다 — ① 상류가 또 바꿨다 ② org_tool 행이 프리셋보다 낡아 legacy 를
    //  때리고 있다(2026-08-27 dev 에서 실제로 그 상태였다). 건수는 안 본다: 조용한 워크스페이스도 정상이다.
    expect: { json: true, paths: ["results.messages"], notContains: [...DENIAL_MARKERS, ...SLACK_DENIAL_MARKERS] },
    why: "legacy search.messages 는 새 앱 토큰(분할형 search:read.*)을 거부한다 — 검색 표면이 현행인지, 그리고 그 토큰으로 실제 통과하는지.",
  },
  {
    key: "b.slack.channels",
    label: "슬랙 채널 목록(B · conversations.list)",
    adapter: "http_proxy", tier: "plain",
    target: { tool: "slack_search_channels" },
    args: { limit: 1 },
    expect: { json: true, paths: ["channels"], notContains: [...DENIAL_MARKERS, ...SLACK_DENIAL_MARKERS] },
    why: "수집의 **열거 축**. 검색은 랭킹이라 완결성을 못 주고(#1959 실측), 채널 열거가 그 대안의 토대다 — 여기가 죽으면 수집 자체가 설 자리가 없다.",
  },
  {
    key: "a.notion.search",
    label: "Notion 검색(A · DCR OAuth)",
    adapter: "mcp_proxy", tier: "plain",
    target: { server: "notion", tool: "notion-search" },
    args: { query: "lively" },
    expect: { notContains: DENIAL_MARKERS },
    why: "A 어댑터 배관 자체의 대조군 — 구글이 깨졌을 때 '프록시가 고장'인지 '구글만 고장'인지 가른다.",
  },
  // ── D(http_direct) — 하네스 설치기 9칸. 표(HARNESS_INSTALLERS)에서 파생되므로 여기 손댈 일이 없다.
  ...installerProbes,
];

/**
 * 프로브 구성 검증 — **이 카나리가 고객의 고장을 볼 수 있는가**를 기계로 확인한다.
 *  '우리만 잘 설정돼 있어서 눈이 먼' 상태를 배포 전에 잡는 유일한 지점이다.
 */
export function assertProbeCoverage(probes: CanaryProbe[] = CANARY_PROBES): void {
  const keys = new Set<string>();
  for (const p of probes) {
    if (keys.has(p.key)) throw new Error(`카나리 프로브 key 중복: ${p.key}`);
    keys.add(p.key);
    if (p.adapter === "mcp_proxy" && !p.target.server) throw new Error(`${p.key}: mcp_proxy 프로브는 server 가 필요합니다`);
    if (p.adapter === "mcp_proxy" && !p.target.tool) throw new Error(`${p.key}: mcp_proxy 프로브는 tool 이 필요합니다`);
    if (p.adapter === "http_proxy" && p.target.server) throw new Error(`${p.key}: http_proxy 프로브에 server 는 의미가 없습니다`);
    if (p.adapter === "http_proxy" && !p.target.tool) throw new Error(`${p.key}: http_proxy 프로브는 tool(org_tool 이름)이 필요합니다`);
    if (p.adapter === "http_direct") {
      // 대상은 이 파일에 **하드코딩된 상수**다(사용자 입력이 아니다) — 그래도 https 를 강제한다:
      //  평문 http 로 받아 오는 스크립트는 중간자가 갈아끼울 수 있고, 그런 길을 우리가 «정상» 이라 판정할 수는 없다.
      if (!p.target.url) throw new Error(`${p.key}: http_direct 프로브는 url 이 필요합니다`);
      if (!p.target.url.startsWith("https://")) throw new Error(`${p.key}: http_direct 는 https 만 — ${p.target.url}`);
      if (p.target.server || p.target.tool) throw new Error(`${p.key}: http_direct 프로브에 server·tool 은 의미가 없습니다`);
    }
    const e = p.expect;
    const asserts = (e.paths?.length ?? 0) + (e.arrayMin?.length ?? 0) + (e.contains?.length ?? 0) + (e.notContains?.length ?? 0);
    // 단언이 하나도 없으면 '호출이 안 던졌다'만 보게 된다 — 그게 정확히 이번에 눈이 멀었던 방식이다.
    if (asserts === 0) throw new Error(`${p.key}: 응답 내용 단언이 없습니다 — 호출 성공만 보면 200+isError 를 놓친다`);
  }
  for (const adapter of new Set(probes.map((p) => p.adapter))) {
    const plain = probes.filter((p) => p.adapter === adapter && p.tier === "plain");
    if (plain.length === 0) {
      throw new Error(`${adapter}: 고객과 같은 구성 등급(plain) 프로브가 없습니다 — 우리만 잘 설정돼 있으면 고객 고장에 눈이 먼다`);
    }
  }
}
