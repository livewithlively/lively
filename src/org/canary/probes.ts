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

export type ProbeAdapter = "mcp_proxy" | "http_proxy";
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
  /** mcp_proxy: {server, tool} · http_proxy: {tool}=org_tool 이름 */
  target: { server?: string; tool: string };
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

// ⚠ 프로브가 보는 응답 본문은 **상류가 준 것 그대로**다(2026-08-12 dev 실측에서 잡음).
//  http_proxy 프로브는 `runHttpProxyTool` 을 직접 부르므로, MCP 등록 핸들러가 씌우는
//  `{status, ok, truncated, body}` 래퍼가 **없다.** 그 래퍼를 전제로 `paths:["body"]` 를 걸면
//  호출이 200 으로 멀쩡히 성공해도 "경로 body 가 없다"로 거짓 실패한다.
//  → 단언은 **상류 스키마 기준**으로 쓴다(Drive 는 `files`, Gmail 은 `labels`·`messages`).
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
  {
    key: "a.notion.search",
    label: "Notion 검색(A · DCR OAuth)",
    adapter: "mcp_proxy", tier: "plain",
    target: { server: "notion", tool: "notion-search" },
    args: { query: "lively" },
    expect: { notContains: DENIAL_MARKERS },
    why: "A 어댑터 배관 자체의 대조군 — 구글이 깨졌을 때 '프록시가 고장'인지 '구글만 고장'인지 가른다.",
  },
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
    if (p.adapter === "http_proxy" && p.target.server) throw new Error(`${p.key}: http_proxy 프로브에 server 는 의미가 없습니다`);
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
