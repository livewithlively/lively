// http_proxy(B 어댑터) 도구 프리셋 — org_tool 행의 정본(SoT) (#1655).
//
// 왜 여기 있나: 도구 정의는 데이터(org_tool 행)라 관리탭으로도 넣을 수 있지만, 손으로 넣으면 조직마다 달라지고
//  무엇이 표준인지 아무도 모르게 된다. 코드에 SoT 를 두고 적용 경로가 그걸 심는다(mcp-server-presets 와 같은 규약).
//
// ── 왜 구글을 B 로 내렸나 (2026-08-12 실측) ──────────────────────────────────────────────────
//  같은 OAuth 토큰·같은 `drive.readonly` 로:
//   · `drive.googleapis.com`(클래식 API, GA) → 200, 파일 다 읽힘
//   · `drivemcp.googleapis.com`(MCP, Developer Preview) → 403 `The caller does not have permission`
//  게이트는 **호출하는 앱의 GCP 프로젝트**에 걸린다(Workspace Developer Preview 미등록). 구글이 막은 건 데이터가
//  아니라 새 에이전트 표면이다. 그래서 클래식 API 로 내려간다 — 이 경로는 우리 자료수집기가 **이미 프로덕션에서**
//  쓰고 있다(src/connectors/gmail.ts·gdrive.ts). 새로 검증할 엔드포인트가 아니다.
//  부수 이득: A 경로는 상류 응답을 그대로 재노출해 pii_scrub 가 사실상 안 걸렸는데, B 는 scrubPii 가 응답 본문에
//  실제로 돈다 — 메일·드라이브야말로 PII 덩어리라 우리 통제층이 여기서 처음으로 제대로 작동한다.
//
// ── 프리셋을 쓸 때 반드시 아는 제약 ─────────────────────────────────────────────────────────
//  ① 인자 이름은 **구글 파라미터명 그대로**다. runHttpProxyTool 은 args 를 그대로 querystring 에 붙이고 매핑
//     계층이 없다 — 예쁜 이름을 지어 붙이면 그냥 안 먹는다.
//  ② 기본값은 **URL 의 query 에 박아 둔다**(pageSize·fields·format). 인자로 주면 덮어쓰고, 안 주면 그 값이 산다.
//     input_schema 의 default 는 아무도 안 읽는다(jsonSchemaToZodShape 는 optional 여부만 본다).
//  ③ 응답은 256KiB·8초 상한이다. 그래서 목록 계열은 pageSize 를 낮게, fields 로 필요한 칸만 받는다.
//  ④ 경로 자리표시 `{fileId}` 는 인자로 채워진다(#1655). 그 키는 반드시 required 여야 한다 — 안 그러면 런타임에
//     "경로 인자가 필요합니다" 로 죽는다. assertHttpToolPreset 이 이걸 강제한다.
//
// ── A(MCP 프록시) → B 전환 순서 (#1656) ─────────────────────────────────────────────────────
//  ⚠ **B 를 먼저 켜고 A 를 나중에 내린다.** 반대로 하면 그 사이 구글이 통째로 죽는다.
//   1. `org_http_tool_preset_apply {key}` — 도구를 심고 url_allowlist 에 호스트를 함께 넣는다
//      (allowlist 는 deny-all 기본이라 이걸 빠뜨리면 심어도 전부 차단된다).
//   2. 구성원 1인이 실제로 호출해 200 을 확인한다(연결은 이미 돼 있다 — 아래 참조).
//   3. A 서버를 `enabled=false` 로 내린다(org_mcp_upsert) → 403 을 뱉던 도구 표면이 사라진다.
//   4. 되돌릴 땐 3번만 반대로 — A 를 다시 켜면 즉시 복구된다.
//  **재로그인은 필요 없다.** 금고 행은 (owner, auth_kind, scope_key) 로 잡히지 어느 서버 행에 묶여 있지 않고,
//   B 가 같은 auth_kind·같은 scope_key 를 쓰기 때문이다. scope 도 그대로라 재동의 사유가 없다 —
//   클래식 API 는 현재 scope 로 충분하다(drive.readonly · gmail.readonly · calendar.readonly).
//  자격 화면도 그대로다: 비활성 서버라도 그 auth_kind 를 쓰는 도구가 켜져 있으면 연결 목록에 남는다
//   (foldOAuthConnectors, #1656). 서버 **이름**이 승계의 열쇠라 바꾸지 않는다.
//  ⚠ 예외 — access_type=offline 픽스(2026-07-22) 이전에 연결한 사람은 refresh token 이 없어 이미 죽어 있다.
//   전환과 무관하게 [다시 연결]이 필요하다.
import type { OrgToolInput } from "../store/tools.js";
import { assertSafeJsonSchema, urlTemplateKeys, CALLABLE_SCOPES } from "../../mcp/dynamic-tools.js";

export interface HttpToolPreset {
  name: string;
  title: string;
  description: string;
  url: string;                       // 절대 URL. 기본 query 를 박아 둘 수 있고, 경로 자리표시 {key} 를 쓸 수 있다.
  method?: "GET" | "POST";           // 기본 GET
  input_schema: Record<string, unknown>;
  pii_scrub: boolean;
  note?: string;
  // 도구별 등급(#1881) — 묶음 기본(group.level)을 덮는다. 발송(chat.postMessage)처럼 조직 밖으로 **내보내는** 도구는
  //  L2 여야 한다: ① per-user 자격 필수(통합 폴백 금지 — 사칭 방지) ② 채널 정책이 'write' 로 판정(발송 fail-closed).
  //  A 어댑터는 classifyToolLevel 이 동사(send)로 자동 분류하지만 B 는 행의 level 이 전부라 여기서 명시한다.
  level?: "L0" | "L1" | "L2";
}

export interface HttpToolPresetGroup {
  key: string;                       // 묶음 식별자(관리탭 표시·적용 단위)
  label: string;
  auth_kind: string;                 // 금고 슬롯 kind — A 어댑터(org_mcp_server)와 **같은 값**이라 기존 연결을 그대로 승계한다
  hosts: string[];                   // 이 묶음을 쓰려면 url_allowlist 에 있어야 하는 호스트(기본 deny-all)
  scope: "items" | "context" | "db" | "memory" | "code";
  level: "L0" | "L1" | "L2";
  tools: HttpToolPreset[];
}

// ── 스키마 헬퍼(읽기 편하려고만) ──
const S = (description: string): Record<string, unknown> => ({ type: "string", description });
const I = (description: string): Record<string, unknown> => ({ type: "integer", description });
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: "object", properties, required, additionalProperties: false });

const DRIVE = "https://www.googleapis.com/drive/v3";
const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const CAL = "https://www.googleapis.com/calendar/v3";
const SLACK = "https://slack.com/api";

// ── 슬랙을 B 로 내린 이유 (#1881, 2026-08-25) ──────────────────────────────────────────────────
//  슬랙 공식 MCP(mcp.slack.com)는 **마켓플레이스 등록 앱·내부 앱만** 쓸 수 있다("unlisted apps are prohibited from
//  using MCP" — docs.slack.dev/ai/slack-mcp-server). 라이블리가 소유한 공개배포 앱(구성원이 [Slack 연결] 한 번으로
//  붙는 경로)은 고객 워크스페이스 입장에선 unlisted 라 MCP 서버가 거부한다. 도구 면을 클래식 Web API 로 내리면
//  그 제약과 DCR 부재에서 벗어난다. 금고 슬롯(auth_kind=slack_oauth)은 A 와 같아 연결이 그대로 승계된다.
//  ⚠ 슬랙은 실패도 HTTP 200 + {ok:false} 다 — runHttpProxyTool 의 envelopeFailed 가 잡는다. 채널별 개인 정책(#1226)은
//   channel-enforce 가 이 도구들에도 건다(auth_kind 가 slack 으로 시작 + 호스트 slack.com). 도구 이름은 channelToolKind 의
//   판정표와 맞춘다: `*_search_channels|users|emojis` = meta(정책 밖) · 발송 = level L2(write) · 나머지 = read.
//  인자 이름은 슬랙 파라미터명 그대로다(runHttpProxyTool 은 매핑 계층이 없다). GET 은 query, POST 는 JSON 본문 — 슬랙
//   Web API 는 둘 다 받는다(chat.postMessage 는 JSON + Bearer). 응답 상한 256KiB 라 limit/count 를 낮게 박아 둔다.
//  빠진 것: MCP 의 `slack_send_message_draft`(발송 안 하는 초안) — Web API 에 대응물이 없고 발송 전 확인은 P2 컨펌(L2)이 맡는다.

export const HTTP_TOOL_PRESETS: HttpToolPresetGroup[] = [
  {
    key: "google-drive", label: "Google Drive (클래식 API)", auth_kind: "google_drive_oauth",
    hosts: ["www.googleapis.com"], scope: "items", level: "L0",
    tools: [
      {
        name: "google_drive_search",
        title: "구글 드라이브 검색",
        description:
          "내 구글 드라이브에서 파일을 찾는다. q 는 구글 드라이브 검색 문법 그대로다 — 예: \"name contains '계약'\", " +
          "\"mimeType='application/vnd.google-apps.document'\", \"modifiedTime > '2026-01-01T00:00:00'\". " +
          "q 를 비우면 최근 수정순으로 목록만 준다. 본문을 읽으려면 결과의 id 를 google_drive_file_read 나 google_drive_doc_export 에 넘긴다.",
        url: `${DRIVE}/files?pageSize=20&orderBy=modifiedTime%20desc&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,owners(displayName),webViewLink)`,
        input_schema: obj({
          q: S("드라이브 검색 문법(비우면 전체를 최근 수정순으로)"),
          pageSize: I("한 번에 받을 개수(기본 20, 응답 상한 256KiB 라 크게 잡지 말 것)"),
          orderBy: S("정렬(기본 modifiedTime desc)"),
          pageToken: S("다음 쪽 토큰(이전 응답의 nextPageToken)"),
        }),
        pii_scrub: true,
      },
      {
        name: "google_drive_file_meta",
        title: "구글 드라이브 파일 정보",
        description: "파일 하나의 메타데이터(이름·형식·크기·수정시각·소유자·링크). 본문은 주지 않는다.",
        url: `${DRIVE}/files/{fileId}?fields=id,name,mimeType,size,modifiedTime,owners(displayName),webViewLink,parents`,
        input_schema: obj({ fileId: S("파일 id(검색 결과의 id)") }, ["fileId"]),
        pii_scrub: true,
      },
      {
        name: "google_drive_file_read",
        title: "구글 드라이브 파일 본문 읽기",
        description:
          "업로드된 파일의 원본 내용을 그대로 받는다(텍스트·마크다운·CSV·JSON 등). " +
          "⚠ 구글 문서/스프레드시트/슬라이드(mimeType 이 application/vnd.google-apps.* )는 이 도구로 못 읽는다 — google_drive_doc_export 를 쓴다. " +
          "⚠ 256KiB 를 넘으면 잘린다. PDF·이미지 같은 바이너리는 의미 있는 결과가 나오지 않는다.",
        url: `${DRIVE}/files/{fileId}?alt=media`,
        input_schema: obj({ fileId: S("파일 id") }, ["fileId"]),
        pii_scrub: true,
      },
      {
        name: "google_drive_doc_export",
        title: "구글 문서 텍스트로 내보내기",
        description:
          "구글 문서·스프레드시트·슬라이드를 텍스트로 변환해 받는다(기본 text/plain). " +
          "스프레드시트는 mimeType 을 text/csv 로 주면 첫 시트를 CSV 로 준다. ⚠ 256KiB 상한.",
        url: `${DRIVE}/files/{fileId}/export?mimeType=text%2Fplain`,
        input_schema: obj({
          fileId: S("구글 문서 id"),
          mimeType: S("내보낼 형식(기본 text/plain, 스프레드시트는 text/csv)"),
        }, ["fileId"]),
        pii_scrub: true,
      },
    ],
  },
  {
    key: "google-gmail", label: "Google Gmail (클래식 API)", auth_kind: "google_gmail_oauth",
    hosts: ["gmail.googleapis.com"], scope: "items", level: "L0",
    tools: [
      {
        name: "google_gmail_search",
        title: "지메일 검색",
        description:
          "내 메일을 검색해 **메시지 id 목록**을 준다(본문은 없다). q 는 지메일 검색 문법 그대로 — 예: " +
          "\"from:foo@bar.com newer_than:7d\", \"subject:계약 has:attachment\". 본문은 결과 id 를 google_gmail_message 에 넘겨 받는다.",
        url: `${GMAIL}/users/me/messages?maxResults=20`,
        input_schema: obj({
          q: S("지메일 검색 문법"),
          maxResults: I("한 번에 받을 개수(기본 20)"),
          pageToken: S("다음 쪽 토큰"),
          labelIds: S("라벨 id 로 좁히기(google_gmail_labels 로 조회)"),
        }),
        pii_scrub: true,
      },
      {
        name: "google_gmail_message",
        title: "지메일 메시지 읽기",
        description:
          "메시지 하나의 헤더와 본문. format 기본값은 full(본문 포함, base64url 인코딩된 파트로 온다). " +
          "제목·보낸사람만 필요하면 format 을 metadata 로 주면 훨씬 작다. ⚠ 첨부가 큰 메일은 256KiB 에서 잘린다.",
        url: `${GMAIL}/users/me/messages/{id}?format=full`,
        input_schema: obj({
          id: S("메시지 id(검색 결과의 id)"),
          format: S("full(기본)·metadata·minimal"),
        }, ["id"]),
        pii_scrub: true,
      },
      {
        name: "google_gmail_thread",
        title: "지메일 스레드 읽기",
        description: "한 대화(스레드)의 메시지들을 한 번에. ⚠ 긴 스레드는 256KiB 에서 잘리므로 그때는 메시지별로 읽는다.",
        url: `${GMAIL}/users/me/threads/{id}?format=full`,
        input_schema: obj({
          id: S("스레드 id(검색 결과의 threadId)"),
          format: S("full(기본)·metadata·minimal"),
        }, ["id"]),
        pii_scrub: true,
      },
      {
        name: "google_gmail_labels",
        title: "지메일 라벨 목록",
        description: "내 지메일 라벨(시스템·사용자 정의) 목록. 검색을 라벨로 좁힐 때 id 를 여기서 얻는다.",
        url: `${GMAIL}/users/me/labels`,
        input_schema: obj({}),
        pii_scrub: true,
      },
    ],
  },
  {
    key: "google-calendar", label: "Google Calendar (클래식 API)", auth_kind: "google_calendar_oauth",
    hosts: ["www.googleapis.com"], scope: "items", level: "L0",
    tools: [
      {
        name: "google_calendar_list",
        title: "구글 캘린더 목록",
        description: "내가 접근할 수 있는 캘린더 목록. 여기서 얻은 id 를 google_calendar_events 의 calendarId 로 넘긴다(내 기본 캘린더는 primary).",
        url: `${CAL}/users/me/calendarList?maxResults=50`,
        input_schema: obj({ maxResults: I("한 번에 받을 개수(기본 50)"), pageToken: S("다음 쪽 토큰") }),
        pii_scrub: false,
      },
      {
        name: "google_calendar_events",
        title: "구글 캘린더 일정 조회",
        description:
          "한 캘린더의 일정을 시간순으로. 반복 일정은 개별 발생으로 펼쳐 준다(singleEvents=true). " +
          "기간은 timeMin·timeMax 에 RFC3339 로 준다 — 예: 2026-08-12T00:00:00+09:00. 내 캘린더는 calendarId=primary.",
        url: `${CAL}/calendars/{calendarId}/events?maxResults=25&singleEvents=true&orderBy=startTime`,
        input_schema: obj({
          calendarId: S("캘린더 id(내 기본 캘린더는 primary)"),
          timeMin: S("시작 시각 하한(RFC3339)"),
          timeMax: S("시작 시각 상한(RFC3339)"),
          q: S("본문·제목 검색어"),
          maxResults: I("한 번에 받을 개수(기본 25)"),
          pageToken: S("다음 쪽 토큰"),
        }, ["calendarId"]),
        pii_scrub: false,
      },
    ],
  },
  {
    key: "slack", label: "Slack (Web API)", auth_kind: "slack_oauth",
    hosts: ["slack.com"], scope: "items", level: "L0",
    tools: [
      {
        // ⚠ search.messages 가 아니다 — 그 메서드는 legacy `search:read` 전용이고 새 앱 토큰(search:read.* 분할형)을 거부한다.
        //  현행 검색 표면은 assistant.search.context(유저 토큰은 action_token 불요). 응답 항목에 channel_id 가 실려
        //  채널 정책 응답 필터(#1226)가 항목 단위로 도려낼 수 있다.
        name: "slack_search_messages",
        title: "슬랙 메시지 검색",
        description:
          "내 슬랙 계정으로 메시지를 검색한다(내가 볼 수 있는 대화 — 비공개·DM 은 개인 설정에서 허용한 것만 결과에 남는다). " +
          "query 는 자연어 또는 키워드. 기간은 after/before(Unix 초). 결과의 channel_id·message_ts 로 slack_read_thread 를 부르면 스레드 전체를 읽는다.",
        url: `${SLACK}/assistant.search.context`,
        method: "POST",
        input_schema: obj({
          query: S("검색어(자연어·키워드)"),
          limit: I("한 번에 받을 개수(기본 20 — 응답 상한 256KiB 라 크게 잡지 말 것)"),
          cursor: S("다음 쪽 커서(이전 응답의 response_metadata.next_cursor)"),
          sort: S("정렬 기준: score(기본) | timestamp"),
          sort_dir: S("정렬 방향: desc(기본) | asc"),
          after: I("이 시각(Unix 초) 이후만"),
          before: I("이 시각(Unix 초) 이전만"),
        }, ["query"]),
        pii_scrub: true,
      },
      {
        name: "slack_search_channels",
        title: "슬랙 채널 목록",
        description:
          "내가 볼 수 있는 채널 목록(공개 + 내가 속한 비공개). 이름으로 channel id 를 찾을 때 쓴다 — 읽기·발송 도구는 " +
          "id(C…)를 받는다. 목록은 대화 내용이 아니라 개인 열람 설정의 대상이 아니다.",
        url: `${SLACK}/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200`,
        input_schema: obj({
          limit: I("한 번에 받을 개수(기본 200, 최대 1000)"),
          cursor: S("다음 쪽 커서(이전 응답의 response_metadata.next_cursor)"),
          types: S("대화 종류(쉼표구분): public_channel, private_channel, mpim, im — 기본 public_channel,private_channel"),
        }),
        pii_scrub: false,
      },
      {
        name: "slack_search_users",
        title: "슬랙 사용자 목록",
        description: "워크스페이스 사용자 목록(id·이름·표시명). 멘션·DM 상대의 user id(U…)를 찾을 때 쓴다.",
        url: `${SLACK}/users.list?limit=200`,
        input_schema: obj({
          limit: I("한 번에 받을 개수(기본 200)"),
          cursor: S("다음 쪽 커서(response_metadata.next_cursor)"),
        }),
        pii_scrub: true,
      },
      {
        name: "slack_search_emojis",
        title: "슬랙 커스텀 이모지 목록",
        description: "워크스페이스 커스텀 이모지 이름 목록.",
        url: `${SLACK}/emoji.list`,
        input_schema: obj({}),
        pii_scrub: false,
      },
      {
        name: "slack_read_channel",
        title: "슬랙 채널 메시지 읽기",
        description:
          "채널(또는 DM) 최근 메시지를 읽는다. channel 은 id(C…/D…). 스레드 답글은 여기 안 실린다 — 부모 메시지의 ts 로 " +
          "slack_read_thread 를 부른다. oldest/latest 는 슬랙 ts(예: 1723456789.000100).",
        url: `${SLACK}/conversations.history?limit=50`,
        input_schema: obj({
          channel: S("채널 id(C…, D…, G…)"),
          limit: I("한 번에 받을 개수(기본 50, 최대 200)"),
          cursor: S("다음 쪽 커서"),
          oldest: S("이 ts 이후만"),
          latest: S("이 ts 이전만"),
        }, ["channel"]),
        pii_scrub: true,
      },
      {
        name: "slack_read_thread",
        title: "슬랙 스레드 읽기",
        description: "부모 메시지(channel + ts)의 스레드 답글 전체를 읽는다. ts 는 검색/채널 읽기 결과의 ts 값 그대로.",
        url: `${SLACK}/conversations.replies?limit=100`,
        input_schema: obj({
          channel: S("채널 id"),
          ts: S("부모 메시지 ts"),
          limit: I("한 번에 받을 개수(기본 100)"),
          cursor: S("다음 쪽 커서"),
        }, ["channel", "ts"]),
        pii_scrub: true,
      },
      {
        name: "slack_list_channel_members",
        title: "슬랙 채널 멤버",
        description: "채널에 속한 사용자 id 목록. 이름은 slack_search_users 로 푼다.",
        url: `${SLACK}/conversations.members?limit=200`,
        input_schema: obj({
          channel: S("채널 id"),
          limit: I("한 번에 받을 개수(기본 200)"),
          cursor: S("다음 쪽 커서"),
        }, ["channel"]),
        pii_scrub: false,
      },
      {
        // 이름에 react… 가 들어가면 채널 정책이 '발송'(react 동사)으로 오판해 지목 없는 호출을 막는다 → emoji 로.
        name: "slack_read_message_emoji",
        title: "슬랙 메시지 반응(이모지)",
        description: "메시지 하나(channel + timestamp)에 달린 이모지 반응과 누른 사람.",
        url: `${SLACK}/reactions.get?full=true`,
        input_schema: obj({
          channel: S("채널 id"),
          timestamp: S("메시지 ts"),
        }, ["channel", "timestamp"]),
        pii_scrub: false,
      },
      {
        name: "slack_read_file",
        title: "슬랙 파일 정보",
        description: "파일 id(F…)의 메타데이터(이름·형식·크기·올린 사람·공유된 채널·다운로드 링크). 본문은 주지 않는다.",
        url: `${SLACK}/files.info`,
        input_schema: obj({ file: S("파일 id(F…)") }, ["file"]),
        pii_scrub: true,
      },
      {
        name: "slack_send_message",
        title: "슬랙 메시지 보내기",
        description:
          "내 계정으로 채널·DM 에 메시지를 보낸다(조직 밖으로 나가는 발송 — 보내기 전에 대상과 내용을 확인한다). " +
          "channel 은 id. 스레드에 답글로 달려면 thread_ts 에 부모 ts.",
        url: `${SLACK}/chat.postMessage`,
        method: "POST",
        input_schema: obj({
          channel: S("보낼 채널 id(C…) 또는 DM id(D…)"),
          text: S("메시지 본문(슬랙 mrkdwn)"),
          thread_ts: S("스레드 답글이면 부모 메시지 ts"),
        }, ["channel", "text"]),
        pii_scrub: false,
        level: "L2",
      },
      {
        name: "slack_schedule_message",
        title: "슬랙 메시지 예약 발송",
        description: "내 계정으로 지정 시각(post_at, epoch 초)에 메시지를 보내도록 예약한다(발송 — 대상·내용·시각을 확인한다).",
        url: `${SLACK}/chat.scheduleMessage`,
        method: "POST",
        input_schema: obj({
          channel: S("보낼 채널 id"),
          text: S("메시지 본문"),
          post_at: I("보낼 시각(Unix epoch 초, 지금부터 120일 이내)"),
          thread_ts: S("스레드 답글이면 부모 메시지 ts"),
        }, ["channel", "text", "post_at"]),
        pii_scrub: false,
        level: "L2",
      },
    ],
  },
];

/**
 * 프리셋 자기검증 — 손으로 쓴 정의라 오타가 런타임까지 살아나가는 걸 막는다.
 *  특히 ④(경로 자리표시가 required 인가)는 안 지키면 그 도구가 **호출 때마다** 죽는데, 저장 시엔 아무도 모른다.
 */
export function assertHttpToolPreset(group: HttpToolPresetGroup, tool: HttpToolPreset): void {
  const where = `${group.key}/${tool.name}`;
  assertSafeJsonSchema(tool.input_schema);
  if (!CALLABLE_SCOPES.has(group.scope)) throw new Error(`${where}: 호출 불가 scope(${group.scope})`);

  let url: URL;
  try { url = new URL(tool.url.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, "x")); }
  catch { throw new Error(`${where}: url 이 절대 URL 이 아닙니다`); }
  if (url.protocol !== "https:") throw new Error(`${where}: https 가 아닙니다`);
  if (!group.hosts.includes(url.hostname)) throw new Error(`${where}: url 호스트(${url.hostname})가 묶음 hosts 에 없습니다 — allowlist 에 못 올라가 전부 차단된다`);

  const props = (tool.input_schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set((tool.input_schema.required as string[]) ?? []);
  for (const key of urlTemplateKeys(tool.url)) {
    if (!(key in props)) throw new Error(`${where}: 경로 인자 '${key}' 가 input_schema 에 없습니다`);
    if (!required.has(key)) throw new Error(`${where}: 경로 인자 '${key}' 는 required 여야 합니다(없으면 호출 때마다 실패)`);
  }
}

/** 프리셋 → org_tool upsert 입력. 적용 경로(관리탭·부트스트랩)가 이걸 그대로 넘긴다. */
export function httpToolPresetToInput(group: HttpToolPresetGroup, tool: HttpToolPreset): OrgToolInput {
  assertHttpToolPreset(group, tool);
  return {
    name: tool.name,
    kind: "http_proxy",
    enabled: true,
    title: tool.title,
    description: tool.description,
    scope: group.scope,
    input_schema: tool.input_schema,
    method: tool.method ?? "GET",
    url: tool.url,
    level: tool.level ?? group.level, // 도구별 등급 우선(#1881 — 발송은 L2)
    auth_kind: group.auth_kind,   // A 어댑터와 같은 슬롯 — 이미 연결한 멤버는 재로그인이 필요 없다
    auth_scope_key: "",
    pii_scrub: tool.pii_scrub,
    log_args: false,              // 조직 밖으로 나가는 통신 — 인자 값은 남기지 않는다(#1082)
    auto_approve: false,
    note: tool.note ?? `${group.label} — 클래식 REST API(B 어댑터). #1652`,
  };
}

/** 이 묶음들을 쓰려면 url_allowlist 에 있어야 하는 호스트(중복 제거). */
export function httpToolPresetHosts(groups: HttpToolPresetGroup[] = HTTP_TOOL_PRESETS): string[] {
  return [...new Set(groups.flatMap((g) => g.hosts))].sort();
}
