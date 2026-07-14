// 외부 도구 서버(MCP) 기본 프리셋 (#746) — 배포 시 자동 시딩되는 "호스팅 OAuth MCP 서버"의 정본(SoT).
//
// ⚠ 구 이름은 connector-catalog(DEFAULT_CONNECTORS) 였는데 **거짓말이었다**(#837). 여기 담긴 건 org_connector
//  (슬랙·노션을 우리 DB 로 당겨오는 패시브 미러 = 화면상 "외부 자료 수집")와 **아무 관계가 없고**, org_mcp_server
//  (AI 가 실시간 호출하는 외부 도구 서버) 의 프리셋이다 — 아래 name 필드가 그 증거다. 이름 때문에 코드 독자와
//  API 소비자가 정반대 축으로 오독해 왔다. 그래서 파일·타입·상수·엔드포인트를 전부 mcp-server-presets 로 개명했다.
//  bootstrap-connectors.mjs 가 seed=true 항목을 '없으면 등록'(멱등, 기존 보존)한다.
//  가르는 축은 상류의 OAuth 클라이언트 등록 방식:
//   - DCR(RFC7591) 지원 → 게이트웨이가 클라이언트를 동적 등록(무시크릿) → per-deploy 세팅 0 → seed=true(기본 출하).
//   - DCR 미지원(Slack·Google 등) → 콘솔에서 만든 사전등록 OAuth client 필요 → seed=false(카탈로그로 문서화만,
//     관리탭 MCP 서버 폼의 OAuth client_id/secret 로 등록 후 활성).
//  안전성: 커넥터는 '등록'만으로 데이터가 흐르지 않는다(구성원이 각자 OAuth 로 자기 계정을 연결해야 토큰 발생) →
//   기본 enabled 로 출하해도 무해. 어떤 기본 커넥터를 영구 제외하려면 삭제가 아니라 '비활성(disable)' 하라
//   (bootstrap 은 이름이 이미 존재하면 보존하므로 disable 상태가 유지된다; 삭제하면 다음 배포에 다시 시드됨).

export interface McpServerPreset {
  name: string;            // org_mcp_server.name (slug)
  label: string;           // 표시명
  url: string;             // 상류 remote MCP 엔드포인트(http streamable)
  auth_kind: string;       // vault 토큰 슬롯 kind (auth_mode=oauth 필수)
  scope: "items" | "context" | "db" | "memory" | "code";
  level: "L0" | "L1" | "L2"; // 서버 기본 등급(툴별 자동 분류가 우선; 미매칭 시 이 값)
  pii_scrub: boolean;      // 응답 비정형 PII 마스킹
  dcr: boolean;            // 상류가 동적 클라이언트 등록(RFC7591) 지원 여부
  seed: boolean;           // 배포 시 자동 등록 대상(=DCR 이라 무시크릿; 사전등록 client 필요분은 false)
  note: string;
}

export const MCP_SERVER_PRESETS: McpServerPreset[] = [
  // ── DCR 지원(무시크릿) — 배포 시 자동 등록. 구성원은 관리탭/자격에서 [연결]만. ──
  {
    name: "notion", label: "Notion", url: "https://mcp.notion.com/mcp",
    auth_kind: "notion_oauth", scope: "items", level: "L0", pii_scrub: true,
    dcr: true, seed: true,
    note: "Notion 공식 원격 MCP(DCR). 구성원이 각자 OAuth 로 자기 워크스페이스 연결(게스트는 Notion 이 차단).",
  },
  {
    name: "linear", label: "Linear", url: "https://mcp.linear.app/mcp",
    auth_kind: "linear_oauth", scope: "items", level: "L0", pii_scrub: true,
    dcr: true, seed: true,
    note: "Linear 공식 원격 MCP(OAuth2.1·DCR·no client secret). 구성원이 각자 OAuth 연결.",
  },
  // ── DCR 미지원 → 사전등록 OAuth client 필요(관리탭 OAuth client 필드). 카탈로그로 문서화만. ──
  {
    name: "slack", label: "Slack", url: "https://mcp.slack.com/mcp",
    auth_kind: "slack_oauth", scope: "items", level: "L0", pii_scrub: true,
    dcr: false, seed: false,
    note: "Slack 공식 MCP 는 DCR 미지원(사전등록 client 필요). 대안: 정적 사용자토큰 xoxp(slack_user_token) — search.messages 는 봇 불가.",
  },
  {
    name: "google-gmail", label: "Google Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1",
    auth_kind: "google_gmail_oauth", scope: "items", level: "L0", pii_scrub: true,
    dcr: false, seed: false,
    note: "Google 공식 MCP. Web앱 OAuth client(콘솔) 필요 — 승인 redirect 에 게이트웨이 /oauth/callback 등록. scope gmail.readonly(+compose).",
  },
  {
    name: "google-drive", label: "Google Drive", url: "https://drivemcp.googleapis.com/mcp/v1",
    auth_kind: "google_drive_oauth", scope: "items", level: "L0", pii_scrub: true,
    dcr: false, seed: false,
    note: "Google 공식 MCP. Web앱 OAuth client 필요. scope drive.readonly(+drive.file).",
  },
  {
    name: "google-calendar", label: "Google Calendar", url: "https://calendarmcp.googleapis.com/mcp/v1",
    auth_kind: "google_calendar_oauth", scope: "items", level: "L0", pii_scrub: false,
    dcr: false, seed: false,
    note: "Google 공식 MCP. Web앱 OAuth client 필요. scope calendar.events.readonly 등.",
  },
];
