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
  oauth_scope?: string;    // authorize 에 실을 OAuth scope(공백구분). 상류가 scopes_supported 를 명시·요구할 때만(예 Slack).
                           //  비우면 미요청 — Notion·Linear 처럼 scopes_supported 가 없는 상류는 scope 를 넣으면 오히려 깨지므로 넣지 않는다.
  oauth_token_url?: string; // 토큰 발급·갱신 엔드포인트(#1654). http_proxy(B 어댑터)가 만료된 access token 을 갱신할 때 쓴다.
                           //  MCP 프록시(A) 경로엔 불필요하다 — SDK auth() 가 상류 URL 에서 디스커버리해 알아서 갱신한다.
                           //  B 는 상류가 MCP 서버가 아니라 그냥 REST API 라(예 www.googleapis.com/drive/v3) 디스커버리할 곳이 없다.
  note: string;
  // 서비스별 셋업 절차(#1226 후속) — 있으면 관리탭 위저드가 **범용 템플릿 대신 이걸** 보여준다.
  //  왜 필요한가: 종전 위저드는 provider 무관 5단계였고 서비스 특화는 note 한 줄이 전부였다. 그래서 슬랙에
  //  ' "웹 애플리케이션" OAuth 클라이언트 생성'(구글 용어) 같은 안 맞는 문구가 떴고, "스코프는 note 참조"라는데
  //  정작 note 엔 스코프가 없었으며, 슬랙 특유의 필수 단계(MCP 접근 활성화·User Token Scopes)가 통째로 빠져 있었다.
  //  org_connector 의 guide({intro, steps, url})와 같은 모양으로 맞춘다.
  //  steps 안의 `{callback}` 은 화면이 그 게이트웨이의 실제 콜백 URL 로 치환한다.
  guide?: { url?: string; intro?: string; steps: string[] };
}

// 구글 3종 공통 셋업 — 콘솔 절차가 같고 '어느 API 를 켜느냐'만 다르다.
//
// ⚠⚠ 2026-08-12 재판정(#1652) — 이 안내는 **한 단계를 통째로 빠뜨리고 있었고, 한 문장은 정반대로 읽혔다.**
//  ① 진짜 게이트는 API 활성화가 아니라 **Google Workspace Developer Preview 등록**이다. 등록 안 된 GCP
//     프로젝트에서는 API 를 다 켜고 scope·토큰이 완벽해도 tools/call 이 전부 403(PERMISSION_DENIED)이다.
//     게이트는 사용자 계정이 아니라 **호출하는 앱의 GCP 프로젝트**에 걸린다(claude.ai 가 같은 구글 계정으로
//     200 인 것이 근거 — Anthropic 이 전 사용자 이메일을 등록했을 리 없다). 조여진 게 아니라 처음부터
//     잠겨 있었다(최초 보고 2026-04-26 · 공개 프리뷰 2026-05-01 · 커뮤니티 규명 2026-07-28).
//  ② 옛 문구 "일반 Gmail/Drive/Calendar API 를 켠 것과 별개입니다" 는 **"일반 API 는 안 켜도 된다"로 읽혔다**
//     (실제 오독 사례 발생). 뜻은 '추가로 켜야 한다' 였다.
//  ③ tools/list 200 은 아무것도 증명하지 않는다 — **익명으로 쳐도** 200 + 8툴이 나온다. [발행]이 성공했다는
//     사실을 '연결이 살아 있다'의 근거로 쓰면 안 된다.
//  → 그래서 대안(B 어댑터, 클래식 REST API)을 먼저 제시한다. 같은 토큰·같은 scope 로 클래식 API 는 200 이고,
//    그 경로는 우리 자료수집기가 이미 프로덕션에서 쓰고 있다(org_tool 프리셋 = http-tool-presets.ts).
const GOOGLE_INTRO =
  "구글은 클라우드 콘솔의 '웹 애플리케이션' OAuth 클라이언트로 붙습니다. " +
  "⚠ 먼저 아셔야 할 것: 구글의 원격 MCP 는 **Workspace Developer Preview 에 등록된 GCP 프로젝트에서만** 실제 호출이 됩니다. " +
  "등록 없이 설정을 아무리 정확히 해도 도구 호출이 전부 403 으로 거부됩니다(도구 목록은 정상으로 보이기 때문에 성공한 것처럼 착각하기 쉽습니다). " +
  "등록 절차가 부담되면 [AI 도구] ▸ 구글 프리셋(클래식 REST API)을 쓰세요 — 같은 계정·같은 권한으로 동작하며 프리뷰 등록이 필요 없습니다.";
function googleSteps(api: string): string[] {
  return [
    "⚠ **가장 먼저** — 이 GCP 프로젝트를 Google Workspace Developer Preview 에 등록합니다(developers.google.com/workspace/preview). " +
      "등록되지 않은 프로젝트는 아래 설정을 전부 마쳐도 도구 호출이 403 으로 거부됩니다. 이게 이 연동에서 가장 흔한 실패 원인입니다",
    `console.cloud.google.com ▸ API 및 서비스 ▸ 라이브러리에서 **${api}** 를 활성화합니다 — 원격 MCP 전용 API 라 일반 Gmail/Drive/Calendar API 와 **둘 다** 켜야 합니다(둘 중 하나가 아닙니다)`,
    "사용자 인증 정보 ▸ [사용자 인증 정보 만들기] ▸ OAuth 클라이언트 ID ▸ 유형 **웹 애플리케이션**",
    "승인된 리디렉션 URI 에 게이트웨이 콜백 추가 → {callback}",
    "OAuth 동의 화면을 게시(In production) — 테스트 상태면 refresh token 이 7일 만에 만료됩니다",
    "발급된 클라이언트 ID·보안 비밀을 아래 [OAuth 클라이언트] 필드에 입력하고 저장합니다",
    "⚠ 저장 후 **본인이 먼저 [외부 서비스 관리 ▸ 해당 서비스 ▸ 연결]** 을 마칩니다 — [발행]은 설정자의 개인 토큰으로 상류에 붙습니다",
    "[발행] — 상류 도구 목록을 캡처합니다. 이후 구성원은 각자 [연결]만 하면 됩니다",
    "⚠ **[발행] 성공은 연결이 살아 있다는 증거가 아닙니다** — 도구 목록은 인증 없이도 조회됩니다. " +
      "반드시 도구를 **실제로 한 번 호출해** 결과가 오는지 확인하세요. 403 이 오면 1번(프리뷰 등록)을 다시 보세요",
  ];
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
  {
    // GitLab 공식 MCP (#1881 G3) — 상류 실측 2026-08-26:
    //   GET gitlab.com/.well-known/oauth-authorization-server → registration_endpoint: /oauth/register  (=DCR)
    //   GET .../oauth-protected-resource/api/v4/mcp          → scopes_supported: ["mcp"]
    //  Beta(18.6~) · Free tier(19.2~) · 최소 18.3 · GitLab.com·self-managed·Dedicated 전부 · 도구 35개를 상류가 유지한다.
    //  ⚠ oauth_scope 를 비우면 안 된다 — 상류가 scopes_supported 를 **명시**하는 쪽이라(슬랙과 같은 부류) 노션·리니어처럼
    //   생략하면 authorize 가 거부된다.
    //  ⚠⚠ 이 토큰으로는 clone 도 REST 수집도 못 한다. GitLab 은 **동적 등록 클라이언트의 scope 를 mcp/mcp_orbit 으로
    //   제한**하고(gitlab-org/gitlab#599020: "insufficient for API calls (need api or read_api)"), 사전등록 앱에 mcp scope 를
    //   주는 경로는 아직 admin 폼에 노출조차 안 됐다. 그래서 레포 연결·자료 수집 축은 별도 OAuth(api read_repository)로 간다
    //   — 사용자에게 동의가 2회로 보이는 건 우리 설계가 아니라 상류 제약이다. 상류가 #599020 을 내면 한 번으로 합친다.
    //  self-managed: 이 url 의 호스트만 자기 GitLab 주소로 바꾸면 된다(org_mcp_server.url 은 행 단위 필드).
    //   DCR 이라 관리자가 앱을 등록할 필요가 없다 — self-managed 에서도 [연결] 한 번이면 끝난다.
    name: "gitlab", label: "GitLab", url: "https://gitlab.com/api/v4/mcp",
    auth_kind: "gitlab_oauth", scope: "code", level: "L0", pii_scrub: true,
    dcr: true, seed: true,
    oauth_scope: "mcp",
    note: "GitLab 공식 원격 MCP(DCR·무시크릿). 구성원이 각자 [연결]만 하면 이슈·MR·파이프라인·위키 도구가 열린다. self-managed 는 URL 의 호스트를 자기 주소로 바꾸세요(18.3 이상). ⚠ 이 연결은 AI 도구 전용입니다 — 저장소 연결·자료 수집은 GitLab 정책상 별도 동의가 필요합니다(#1881).",
    guide: {
      url: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
      intro: "GitLab 은 동적 등록(DCR)을 지원해서 관리자가 준비할 것이 없습니다. gitlab.com 이면 그대로 두고, 자체 운영 GitLab 이면 주소만 바꾸세요.",
      steps: [
        "gitlab.com 을 쓰면 아무것도 하지 않아도 됩니다 — 구성원이 [외부 앱 연결 ▸ GitLab ▸ 연결]만 누르면 됩니다",
        "자체 운영 GitLab 이면 이 서버의 URL 을 https://<우리 GitLab 주소>/api/v4/mcp 로 바꿉니다(GitLab 18.3 이상 필요)",
        "⚠ [발행] 성공은 연결이 살아 있다는 증거가 아닙니다 — 도구를 **실제로 한 번 호출해** 결과가 오는지 확인하세요",
      ],
    },
  },
  // ── DCR 미지원 → 사전등록 OAuth client 필요(관리탭 OAuth client 필드). 카탈로그로 문서화만. ──
  {
    name: "slack", label: "Slack", url: "https://mcp.slack.com/mcp",
    auth_kind: "slack_oauth", scope: "items", level: "L0", pii_scrub: true,
    dcr: false, seed: false,
    // scopes_supported(mcp.slack.com/.well-known/oauth-protected-resource 실측)에서 read/search + 전송(chat:write)만.
    //  users:read.email(PII)·canvases·기타 *:write(파괴)는 제외 — 최소권한, #746 사양=read/search+send(L2 컨펌). 조정은 후속(서버별 override).
    //  im:read 추가(#1226): 채널별 개인 열람/발송 정책 화면이 users.conversations 로 **DM 도 목록에 띄우려면** 필요하다.
    //   (im:history 는 '읽기'라 목록 권한이 안 된다.) 이 scope 가 없던 시절에 연결해 둔 사람의 토큰엔 없으므로
    //   slack-channels 가 missing_scope 를 만나면 DM 을 빼고 한 번 더 부른다 — [다시 연결]하면 DM 도 잡힌다.
    oauth_scope: "search:read.public search:read.private search:read.mpim search:read.im search:read.files search:read.users channels:history groups:history im:history mpim:history channels:read groups:read mpim:read im:read users:read files:read reactions:read emoji:read chat:write",
    note: "#1881 — 슬랙 도구는 이 서버(mcp.slack.com)가 아니라 Web API 프리셋 'slack'(http_proxy)이 제공한다: 슬랙 공식 MCP 는 마켓플레이스 등록 앱·내부 앱만 허용(unlisted 금지)하고 DCR 도 없다. 이 행은 **OAuth 연결 창구**(auth_kind=slack_oauth 의 [연결] 버튼)로만 쓴다 — 발행 불필요, 켜 두면 A 툴이 등록되므로 B 적용 후 enabled=false 권장. 연결 한 번에 유저 토큰(개인 도구)+봇 토큰(비공개 채널 수집)이 함께 저장된다.",
    guide: {
      url: "https://api.slack.com/apps",
      intro: "매니지드(app.lvly.io)는 라이블리 Slack 앱이 이미 있어 이 설정이 필요 없습니다. 셀프호스팅은 자기 Slack 앱을 하나 만듭니다 — 아래 링크가 이름·권한·봇·콜백을 전부 채워 줘서 사람이 고를 것은 없습니다.",
      steps: [
        "아래 [Slack 앱 만들기 링크 열기] — 채워진 생성 화면이 뜹니다. 워크스페이스를 고르고 [Create] (콜백 {callback} 이 이미 들어 있습니다)",
        "[Basic Information] ▸ App Credentials 의 Client ID·Client Secret 을 아래 [OAuth 클라이언트] 칸에 넣고 저장",
        "[외부 앱 연결 ▸ Slack ▸ 계정으로 연결] — 관리자가 먼저 연결하면 '팀 자료로 모으기'를 켤 수 있고, 구성원은 각자 [연결]만 하면 됩니다. [발행]은 누르지 않습니다(도구는 Web API 프리셋).",
      ],
    },
  },
  {
    name: "google-gmail", label: "Google Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1",
    auth_kind: "google_gmail_oauth", scope: "items", level: "L0", pii_scrub: true,
    dcr: false, seed: false,
    // gmail MCP(gmailmcp) 의 create_draft 는 Gmail API 직접호출은 gmail.compose 로 200 인데도 MCP 계층에서 permission 거부 →
    //  gmailmcp 이 쓰기 tool 에 gmail.modify 를 요구(실측 규명). 그래서 readonly+compose+modify. mail.google.com(전체·영구삭제)만 제외.
    oauth_scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.modify",
    oauth_token_url: "https://oauth2.googleapis.com/token",
    note: "Google 공식 MCP(Developer Preview). ⚠ **프리뷰 미등록 GCP 프로젝트에서는 tools/call 이 전부 403** — 설정이 완벽해도 안 된다(2026-08-12 실측). 대안: [AI 도구] 의 google-gmail 프리셋(클래식 Gmail API, 같은 자격 슬롯·프리뷰 불요). Web앱 OAuth client 필요 — 승인 redirect 에 /oauth/callback 등록.",
    guide: { url: "https://console.cloud.google.com/apis/credentials", intro: GOOGLE_INTRO, steps: googleSteps("gmailmcp.googleapis.com") },
  },
  {
    name: "google-drive", label: "Google Drive", url: "https://drivemcp.googleapis.com/mcp/v1",
    auth_kind: "google_drive_oauth", scope: "items", level: "L0", pii_scrub: true,
    dcr: false, seed: false,
    // scopes_supported 실측(drive / drive.readonly / drive.file)에서 읽기만 — drive(전체)·drive.file(쓰기)는 후속.
    oauth_scope: "https://www.googleapis.com/auth/drive.readonly",
    oauth_token_url: "https://oauth2.googleapis.com/token",
    note: "Google 공식 MCP(Developer Preview). ⚠ **프리뷰 미등록이면 tools/call 전부 403.** 같은 토큰·같은 drive.readonly 로 클래식 API(drive.googleapis.com)는 200 이다 — 막힌 건 데이터가 아니라 새 에이전트 표면. 대안: [AI 도구] 의 google-drive 프리셋. Web앱 OAuth client 필요.",
    guide: { url: "https://console.cloud.google.com/apis/credentials", intro: GOOGLE_INTRO, steps: googleSteps("drivemcp.googleapis.com") },
  },
  {
    name: "google-calendar", label: "Google Calendar", url: "https://calendarmcp.googleapis.com/mcp/v1",
    auth_kind: "google_calendar_oauth", scope: "items", level: "L0", pii_scrub: false,
    dcr: false, seed: false,
    // scopes_supported 실측(calendar 전체·events·readonly 등 12종)에서 읽기만 — 이벤트 쓰기 등은 후속(L2).
    oauth_scope: "https://www.googleapis.com/auth/calendar.readonly",
    oauth_token_url: "https://oauth2.googleapis.com/token",
    note: "Google 공식 MCP(Developer Preview). ⚠ **프리뷰 미등록이면 tools/call 전부 403.** 대안: [AI 도구] 의 google-calendar 프리셋(클래식 Calendar API). Web앱 OAuth client 필요.",
    guide: { url: "https://console.cloud.google.com/apis/credentials", intro: GOOGLE_INTRO, steps: googleSteps("calendarmcp.googleapis.com") },
  },
];

// 상류 auth_kind 로 프리셋의 OAuth scope 를 찾는다(authorize 에 실을 값). 없으면 undefined = scope 미요청.
//  broker(loadProxyServer)가 이 값을 authorize 에 싣는다 — scopes_supported 를 요구하는 상류(Slack)만 채워지고,
//  scopes_supported 가 없는 상류(Notion·Linear)는 undefined 라 현행(무-scope)대로 동작한다.
export function presetOAuthScope(authKind: string | null | undefined): string | undefined {
  if (!authKind) return undefined;
  return MCP_SERVER_PRESETS.find((c) => c.auth_kind === authKind)?.oauth_scope;
}

// 같은 auth_kind 축의 토큰 발급처(#1654) — http_proxy 가 만료된 access token 을 갱신할 때 POST 할 곳.
//  ⚠ 이 파일이 org_mcp_server 프리셋인데 org_tool(http_proxy)이 참조하는 게 어색해 보일 수 있다. 하지만 두 어댑터가
//  공유하는 축은 서버 행이 아니라 **auth_kind**(금고 슬롯 키)다 — 같은 구글 계정을 A 로 쓰든 B 로 쓰든 토큰은 한 슬롯에
//  있고 발급처도 하나다. 그래서 auth_kind 별 OAuth 설정(scope·token_url)의 SoT 를 여기 한 곳에 둔다.
//  없으면 undefined = 갱신 불가(호출자가 재연결을 안내한다. 조용히 만료 토큰을 쓰지 않는다).
export function presetOAuthTokenUrl(authKind: string | null | undefined): string | undefined {
  if (!authKind) return undefined;
  return MCP_SERVER_PRESETS.find((c) => c.auth_kind === authKind)?.oauth_token_url;
}
