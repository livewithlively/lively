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
  // 상류가 페이지네이션을 제공하지 않는 목록 도구의 **명시 선언**(#1881). 값 = 그렇게 둬도 되는 이유.
  //  왜 필드로 두나: 응답 256KiB 상한 때문에 목록 도구는 URL 에 개수·필드 상한을 박는 것이 규칙이고, 테스트가 그걸
  //  강제한다. 그런데 상류에 따라 **줄 파라미터 자체가 없는** 경우가 있다(피그마 REST 는 projects·files·comments 에
  //  페이지 파라미터가 없다). 그때 도구 이름에서 'list' 를 빼 규칙을 피해 가면 규칙은 통과하고 위험만 남는다.
  //  그래서 회피 대신 선언하게 한다 — 리뷰어가 이유를 읽고, 응답이 커지는 상류가 새로 들어오면 여기서 걸린다.
  no_paging?: string;
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
const GH = "https://api.github.com";
const GL = "https://gitlab.com/api/v4";
const FIGMA = "https://api.figma.com/v1";

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
  // ── GitHub·GitLab 을 B 로 내린 이유 (#1881, 2026-08-26) ────────────────────────────────────────
  //  ★ 이 두 묶음이 생기기 전까지, [내 설정 ▸ 외부 서비스 관리] 의 GitHub·GitLab 카드는 "AI가 내 계정으로 이슈·PR·MR 을
  //   다룰 수 있습니다" 라고 약속하면서 **도구를 한 개도 만들지 않았다**. github_pat/gitlab_pat 의 유일한 소비처는
  //   레포 목록 드롭다운(repo-discover.ts)이었고, MCP 프리셋에도 http_proxy 에도 git 은 없었다. 약속과 코드의 어긋남을
  //   메우는 것이 이 묶음의 첫 목적이다(#1881 G4).
  //  왜 MCP(A)가 아니라 B 인가 — GitHub 원격 MCP(api.githubcopilot.com/mcp)의 인가서버는 github.com 자신이고 **DCR 을
  //   지원하지 않는다**(2026-08-26 프로브: github.com/.well-known/oauth-authorization-server 없음). 즉 라이블리가 자기
  //   GitHub App 을 소유하기 전에는 A 경로가 아예 성립하지 않는다. 반면 REST(api.github.com)는 PAT·App 토큰 모두 받는다.
  //   GitLab 은 반대로 공식 MCP 가 DCR 을 지원해 A 로 간다(mcp-server-presets 의 gitlab) — 여기 B 묶음은 그 MCP 토큰이
  //   **scope=mcp 로 묶여 REST 를 못 부르기 때문에**(gitlab#599020) 남겨 두는 보완 면이다.
  //  auth_kind 는 기존 슬롯(github_pat·gitlab_pat)을 그대로 쓴다 — 이미 토큰을 넣어 둔 사람이 재입력 없이 즉시 도구를
  //   얻고, 나중에 OAuth 가 붙어도 같은 슬롯에 토큰 묶음을 저장하면 oauth-proxy-auth 가 묶음/정적을 알아서 가른다
  //   (슬랙에서 "서버 이름이 승계의 열쇠" 였던 것과 같은 원리).
  //  ⚠ 경로 자리표시 값은 encodeURIComponent 된다(applyUrlTemplate — 경로 탈출 방지). 그래서:
  //   · GitHub `contents/{path}` 는 **쓸 수 없다**(docs/a.md → docs%2Fa.md 로 깨진다). 파일 읽기는 도구가 아니라
  //     클론된 레포를 그냥 읽는 게 맞다(레포 연결이 이미 workspace/repos 에 클론을 둔다) — 그래서 여기 없다.
  //   · GitLab 은 오히려 그 인코딩을 **요구한다**(projects/:id 는 group%2Fproject, files/:file_path 도 인코딩) — 맞물린다.
  //  조직 밖으로 나가는 쓰기(이슈 생성·코멘트)는 level L2 — per-user 자격 필수(사칭 방지) + 발송 확인 대상.
  {
    key: "github", label: "GitHub (REST API)", auth_kind: "github_pat",
    hosts: ["api.github.com"], scope: "items", level: "L0",
    tools: [
      {
        name: "github_list_my_repos",
        title: "내 GitHub 저장소 목록",
        description:
          "내 계정이 접근할 수 있는 저장소 목록(최근 갱신순). owner/repo 이름을 찾을 때 쓴다 — 다른 GitHub 도구는 전부 " +
          "owner 와 repo 를 따로 받는다(예: owner=lively-ai, repo=lively).",
        url: `${GH}/user/repos?per_page=50&sort=updated`,
        input_schema: obj({
          per_page: I("한 번에 받을 개수(기본 50, 최대 100)"),
          page: I("쪽 번호(1부터)"),
          affiliation: S("소속 필터: owner, collaborator, organization_member(쉼표구분)"),
        }),
        pii_scrub: false,
      },
      {
        name: "github_search_repos",
        title: "GitHub 저장소 검색",
        description: "GitHub 전체에서 저장소를 검색한다. q 는 GitHub 검색 문법(예: `org:lively-ai lively`).",
        url: `${GH}/search/repositories?per_page=20`,
        input_schema: obj({
          q: S("검색어(GitHub 검색 문법 — org:·user:·language: 등)"),
          sort: S("정렬: stars | forks | updated"),
          per_page: I("개수(기본 20)"),
        }, ["q"]),
        pii_scrub: false,
      },
      {
        name: "github_list_issues",
        title: "GitHub 이슈 목록",
        description:
          "저장소의 이슈 목록. state 로 열림/닫힘을 고른다. ⚠ GitHub 은 PR 도 이슈로 함께 돌려준다 — pull_request 칸이 " +
          "있는 항목이 PR 이다(PR 만 보려면 github_list_prs).",
        url: `${GH}/repos/{owner}/{repo}/issues?per_page=30&state=open`,
        input_schema: obj({
          owner: S("저장소 소유자(사용자 또는 조직)"),
          repo: S("저장소 이름"),
          state: S("open(기본) | closed | all"),
          labels: S("라벨(쉼표구분)"),
          since: S("이 시각 이후 갱신분만(ISO8601)"),
          per_page: I("개수(기본 30)"),
          page: I("쪽 번호"),
        }, ["owner", "repo"]),
        pii_scrub: true,
      },
      {
        name: "github_get_issue",
        title: "GitHub 이슈 읽기",
        description: "이슈 1건의 제목·본문·상태·라벨·담당자. 댓글은 github_get_issue_comments 로 따로 읽는다.",
        url: `${GH}/repos/{owner}/{repo}/issues/{issue_number}`,
        input_schema: obj({
          owner: S("저장소 소유자"),
          repo: S("저장소 이름"),
          issue_number: I("이슈 번호(#뒤의 숫자)"),
        }, ["owner", "repo", "issue_number"]),
        pii_scrub: true,
      },
      {
        name: "github_get_issue_comments",
        title: "GitHub 이슈 댓글 읽기",
        description: "이슈(또는 PR)의 댓글 목록. PR 의 일반 댓글도 이 경로다(코드 리뷰 코멘트는 별개).",
        url: `${GH}/repos/{owner}/{repo}/issues/{issue_number}/comments?per_page=50`,
        input_schema: obj({
          owner: S("저장소 소유자"),
          repo: S("저장소 이름"),
          issue_number: I("이슈 또는 PR 번호"),
          per_page: I("개수(기본 50)"),
        }, ["owner", "repo", "issue_number"]),
        pii_scrub: true,
      },
      {
        name: "github_list_prs",
        title: "GitHub PR 목록",
        description: "저장소의 Pull Request 목록. state 로 열림/닫힘/전체를 고른다.",
        url: `${GH}/repos/{owner}/{repo}/pulls?per_page=30&state=open`,
        input_schema: obj({
          owner: S("저장소 소유자"),
          repo: S("저장소 이름"),
          state: S("open(기본) | closed | all"),
          base: S("대상 브랜치로 좁히기(예: main)"),
          per_page: I("개수(기본 30)"),
          page: I("쪽 번호"),
        }, ["owner", "repo"]),
        pii_scrub: true,
      },
      {
        name: "github_get_pr",
        title: "GitHub PR 읽기",
        description: "PR 1건의 제목·본문·브랜치·머지 상태·변경 통계. 변경 파일은 github_get_pr_files.",
        url: `${GH}/repos/{owner}/{repo}/pulls/{pull_number}`,
        input_schema: obj({
          owner: S("저장소 소유자"),
          repo: S("저장소 이름"),
          pull_number: I("PR 번호"),
        }, ["owner", "repo", "pull_number"]),
        pii_scrub: true,
      },
      {
        name: "github_get_pr_files",
        title: "GitHub PR 변경 파일",
        description:
          "PR 의 변경 파일 목록과 각 파일의 patch(diff). ⚠ 응답 상한 256KiB 라 큰 PR 은 잘린다 — per_page 를 줄이고 " +
          "page 로 넘겨 읽는다.",
        url: `${GH}/repos/{owner}/{repo}/pulls/{pull_number}/files?per_page=30`,
        input_schema: obj({
          owner: S("저장소 소유자"),
          repo: S("저장소 이름"),
          pull_number: I("PR 번호"),
          per_page: I("개수(기본 30)"),
          page: I("쪽 번호"),
        }, ["owner", "repo", "pull_number"]),
        pii_scrub: false,
      },
      {
        name: "github_list_commits",
        title: "GitHub 커밋 목록",
        description: "브랜치·경로별 최근 커밋. sha 로 브랜치를, path 로 특정 파일 이력을 좁힌다.",
        url: `${GH}/repos/{owner}/{repo}/commits?per_page=20`,
        input_schema: obj({
          owner: S("저장소 소유자"),
          repo: S("저장소 이름"),
          sha: S("브랜치명 또는 커밋 sha(기본 기본브랜치)"),
          path: S("이 경로를 건드린 커밋만"),
          since: S("이 시각 이후(ISO8601)"),
          per_page: I("개수(기본 20)"),
        }, ["owner", "repo"]),
        pii_scrub: true,
      },
      {
        name: "github_search_code",
        title: "GitHub 코드 검색",
        description:
          "GitHub 코드 검색. q 는 검색 문법(예: `repo:lively-ai/lively resolveMemberSecret`). " +
          "⚠ 우리 조직 레포는 이미 클론돼 있으니(레포 연결) 로컬 grep 이 더 빠르고 정확하다 — 이 도구는 클론하지 않은 " +
          "저장소를 볼 때 쓴다.",
        url: `${GH}/search/code?per_page=20`,
        input_schema: obj({
          q: S("검색어(GitHub 코드검색 문법 — repo:·path:·language: 등)"),
          per_page: I("개수(기본 20)"),
        }, ["q"]),
        pii_scrub: false,
      },
      {
        name: "github_create_issue",
        title: "GitHub 이슈 만들기",
        description:
          "저장소에 이슈를 만든다(조직 밖으로 나가는 쓰기 — 저장소와 내용을 확인하고 부른다). " +
          "본문은 마크다운.",
        url: `${GH}/repos/{owner}/{repo}/issues`,
        method: "POST",
        input_schema: obj({
          owner: S("저장소 소유자"),
          repo: S("저장소 이름"),
          title: S("이슈 제목"),
          body: S("이슈 본문(마크다운)"),
          labels: S("라벨(쉼표구분)"),
        }, ["owner", "repo", "title"]),
        pii_scrub: false,
        level: "L2",
      },
      {
        name: "github_comment_issue",
        title: "GitHub 이슈·PR 에 댓글 달기",
        description:
          "이슈 또는 PR 에 댓글을 단다(조직 밖으로 나가는 쓰기 — 대상 번호와 내용을 확인하고 부른다).",
        url: `${GH}/repos/{owner}/{repo}/issues/{issue_number}/comments`,
        method: "POST",
        input_schema: obj({
          owner: S("저장소 소유자"),
          repo: S("저장소 이름"),
          issue_number: I("이슈 또는 PR 번호"),
          body: S("댓글 본문(마크다운)"),
        }, ["owner", "repo", "issue_number", "body"]),
        pii_scrub: false,
        level: "L2",
      },
    ],
  },
  {
    // ⚠ 이 묶음의 URL 은 gitlab.com 고정이다. self-managed GitLab 은 호스트가 조직마다 달라 프리셋 한 벌로 못 덮는다
    //  (org_tool.url 은 행 단위라 관리자가 도구별로 바꿀 수는 있다). self-managed 의 정공법은 A 경로(MCP) 인데,
    //  그쪽은 DCR 이라 URL 하나만 바꾸면 되고 도구 35개를 상류가 준다 — mcp-server-presets 의 gitlab 을 보라.
    key: "gitlab", label: "GitLab (REST API · gitlab.com)", auth_kind: "gitlab_pat",
    hosts: ["gitlab.com"], scope: "items", level: "L0",
    tools: [
      {
        name: "gitlab_search_projects",
        title: "내 GitLab 프로젝트 목록",
        description:
          "내가 속한 프로젝트 목록(최근 활동순). 다른 GitLab 도구가 받는 project_id 를 여기서 얻는다 — 숫자 id 또는 " +
          "전체 경로(group/sub/project) 둘 다 쓸 수 있다.",
        url: `${GL}/projects?membership=true&per_page=50&order_by=last_activity_at&simple=true`,
        input_schema: obj({
          search: S("이름으로 좁히기"),
          per_page: I("개수(기본 50)"),
          page: I("쪽 번호"),
        }),
        pii_scrub: false,
      },
      {
        name: "gitlab_list_issues",
        title: "GitLab 이슈 목록",
        description: "프로젝트의 이슈 목록. state 로 열림/닫힘을 고른다.",
        url: `${GL}/projects/{project_id}/issues?per_page=30&state=opened`,
        input_schema: obj({
          project_id: S("프로젝트 id(숫자) 또는 전체 경로(group/project)"),
          state: S("opened(기본) | closed | all"),
          labels: S("라벨(쉼표구분)"),
          per_page: I("개수(기본 30)"),
          page: I("쪽 번호"),
        }, ["project_id"]),
        pii_scrub: true,
      },
      {
        name: "gitlab_get_issue",
        title: "GitLab 이슈 읽기",
        description: "이슈 1건. iid 는 프로젝트 안에서 보이는 번호(#뒤 숫자)이지 전역 id 가 아니다.",
        url: `${GL}/projects/{project_id}/issues/{issue_iid}`,
        input_schema: obj({
          project_id: S("프로젝트 id 또는 전체 경로"),
          issue_iid: I("이슈 번호(프로젝트 내 iid)"),
        }, ["project_id", "issue_iid"]),
        pii_scrub: true,
      },
      {
        name: "gitlab_list_mrs",
        title: "GitLab 병합요청(MR) 목록",
        description: "프로젝트의 MR 목록. state 로 열림/병합됨/닫힘을 고른다.",
        url: `${GL}/projects/{project_id}/merge_requests?per_page=30&state=opened`,
        input_schema: obj({
          project_id: S("프로젝트 id 또는 전체 경로"),
          state: S("opened(기본) | merged | closed | all"),
          target_branch: S("대상 브랜치로 좁히기"),
          per_page: I("개수(기본 30)"),
          page: I("쪽 번호"),
        }, ["project_id"]),
        pii_scrub: true,
      },
      {
        name: "gitlab_get_mr",
        title: "GitLab MR 읽기",
        description: "MR 1건의 제목·본문·브랜치·병합 상태. 변경 내용은 gitlab_get_mr_changes.",
        url: `${GL}/projects/{project_id}/merge_requests/{merge_request_iid}`,
        input_schema: obj({
          project_id: S("프로젝트 id 또는 전체 경로"),
          merge_request_iid: I("MR 번호(프로젝트 내 iid)"),
        }, ["project_id", "merge_request_iid"]),
        pii_scrub: true,
      },
      {
        name: "gitlab_get_mr_changes",
        title: "GitLab MR 변경 내용",
        description:
          "MR 의 변경 파일과 diff. ⚠ 응답 상한 256KiB 라 큰 MR 은 잘린다 — 그때는 클론된 레포에서 직접 diff 를 보는 게 맞다.",
        url: `${GL}/projects/{project_id}/merge_requests/{merge_request_iid}/changes`,
        input_schema: obj({
          project_id: S("프로젝트 id 또는 전체 경로"),
          merge_request_iid: I("MR 번호(iid)"),
        }, ["project_id", "merge_request_iid"]),
        pii_scrub: false,
      },
      {
        name: "gitlab_read_file",
        title: "GitLab 파일 읽기",
        description:
          "저장소의 파일 1개를 읽는다(원문). ref 는 브랜치·태그·커밋(기본 기본브랜치). " +
          "클론된 레포가 있으면 로컬에서 읽는 편이 빠르다 — 이 도구는 클론하지 않은 프로젝트용.",
        url: `${GL}/projects/{project_id}/repository/files/{file_path}/raw`,
        input_schema: obj({
          project_id: S("프로젝트 id 또는 전체 경로"),
          file_path: S("파일 경로(예: docs/README.md — 인코딩은 자동)"),
          ref: S("브랜치·태그·커밋(기본 기본브랜치)"),
        }, ["project_id", "file_path"]),
        pii_scrub: true,
      },
      {
        name: "gitlab_search",
        title: "GitLab 전체 검색",
        description:
          "GitLab 인스턴스 전체에서 검색한다. scope 는 필수 — projects | issues | merge_requests | milestones | " +
          "users | blobs(코드) | commits | wiki_blobs 중 하나.",
        url: `${GL}/search?per_page=20`,
        input_schema: obj({
          scope: S("검색 대상: projects | issues | merge_requests | blobs | commits | wiki_blobs | users"),
          search: S("검색어"),
          per_page: I("개수(기본 20)"),
        }, ["scope", "search"]),
        pii_scrub: true,
      },
    ],
  },
  // ── 피그마를 B 로 내린 이유 (#1881, 2026-08-26) ──────────────────────────────────────────────
  //  피그마엔 A(게이트웨이 MCP 프록시) 경로가 **아예 없다**. mcp.figma.com 은 Figma MCP 카탈로그에 오른
  //  클라이언트(VS Code·Cursor·Claude Code…)만 받고, DCR 은 registration_endpoint 를 광고하면서도 실제 등록을
  //  403 으로 막는다(2026-08-26 실측 2회). 그래서 MCP 면은 레인 C(멤버 클라 직접등록, mcp-server-presets 의 figma)로
  //  내리고, **게이트웨이가 쓸 수 있는 유일한 피그마 표면이 이 REST API** 다.
  //  ★ 이 프리셋이 없으면 figma_token 칸은 죽은 표면이다 — 붙여넣기 칸(me-logins·admin-credentials)은 이미 있었지만
  //   그 토큰을 소비하는 도구가 0개였다(#1881 실측). 이 묶음이 그 칸에 처음으로 의미를 준다.
  //  ★ 그리고 이건 **매니지드 웹 세션·헤드리스 크론에서 도는 유일한 피그마 도구 면**이다(레인 C 는 개인 PC 전용).
  //  ★ 코멘트가 여기 있는 이유: 피그마 MCP 도구 25개에 코멘트·파일열거가 0개다. 디자인 맥락(결정·피드백·QA 지적)은
  //   전부 코멘트에 쌓이므로, 수집 축(#1881 F5)도 이 엔드포인트를 쓴다.
  //  인증: PAT(figd_…) 를 X-Figma-Token 헤더로 — CRED_KINDS.figma_token 의 meta(auth_header/token_prefix:"")가
  //   이미 그 형식을 지정하고 있어 authHeader() 가 Bearer 대신 이 헤더를 만든다. 별도 배선 불요.
  //  ⚠ 파일 열거(teams/projects)는 **PAT 라서** 쓸 수 있다 — 같은 엔드포인트가 공개 OAuth 앱에는 금지돼 있다
  //   ("The projects endpoints cannot be used with public OAuth apps"). 공개 앱(F3) 도입 후에도 이 두 도구는
  //   PAT 경로에만 남는다. team_id 는 API 로 얻을 수 없어 사람이 팀 URL 에서 복사해 넣어야 한다.
  {
    key: "figma", label: "Figma (REST API)", auth_kind: "figma_token",
    hosts: ["api.figma.com"], scope: "items", level: "L0",
    tools: [
      {
        name: "figma_get_me",
        title: "피그마 내 계정",
        description: "연결된 내 Figma 계정 정보(이름·이메일·핸들). 연결이 살아 있는지 확인할 때 먼저 부른다.",
        url: `${FIGMA}/me`,
        input_schema: obj({}),
        pii_scrub: true,
      },
      {
        name: "figma_get_file_comments",
        title: "피그마 파일 코멘트 읽기",
        description:
          "디자인 파일에 달린 코멘트를 모두 읽는다(디자이너·기획·QA 가 남긴 결정과 피드백이 여기 쌓인다). " +
          "fileKey 는 파일 주소에서 딴다 — figma.com/design/<fileKey>/<이름> 의 가운데 토막. " +
          "답글은 parent_id 로 부모를 가리키고(1단), resolved_at 이 있으면 이미 결론이 난 스레드다.",
        url: `${FIGMA}/files/{fileKey}/comments`,
        input_schema: obj({
          fileKey: S("파일 키 — figma.com/design/<fileKey>/… 주소의 가운데 토막"),
          as_md: S("코멘트 본문을 마크다운으로 받으려면 'true'"),
        }, ["fileKey"]),
        pii_scrub: true,
        no_paging: "피그마 코멘트 API 에 페이지 파라미터가 없다(reactions 만 커서 지원) — 파일 하나의 코멘트는 텍스트라 통상 작다. 아주 오래된 대형 파일에서 잘리면 수집 경로(웹훅 증분)로 받는다.",
      },
      {
        name: "figma_get_file",
        title: "피그마 파일 구조 읽기",
        description:
          "파일의 문서 구조(페이지·프레임 이름과 배치)를 읽는다. 코멘트가 가리키는 화면이 무엇인지 확인할 때 쓴다. " +
          "⚠ 전체 노드 트리는 매우 크다 — 기본 depth=2(페이지와 최상위 프레임)로 받고, 더 깊이 필요하면 " +
          "figma_get_file_nodes 로 특정 노드만 판다.",
        url: `${FIGMA}/files/{fileKey}?depth=2`,
        input_schema: obj({
          fileKey: S("파일 키"),
          depth: I("트리 깊이(기본 2 — 크게 잡으면 응답 상한 256KiB 를 넘겨 잘린다)"),
          branch_data: S("브랜치 메타까지 받으려면 'true'"),
        }, ["fileKey"]),
        pii_scrub: false,
      },
      {
        name: "figma_get_file_nodes",
        title: "피그마 특정 노드 읽기",
        description:
          "파일 안의 특정 노드(프레임·컴포넌트)만 골라 읽는다. ids 는 쉼표로 구분한 노드 id — " +
          "코멘트의 위치 정보나 figma_get_file 결과에서 얻는다. 파일 전체를 받지 않아 응답이 작다.",
        url: `${FIGMA}/files/{fileKey}/nodes?depth=2`,
        input_schema: obj({
          fileKey: S("파일 키"),
          ids: S("노드 id 목록(쉼표 구분, 예: 1:2,1:5)"),
          depth: I("트리 깊이(기본 2)"),
        }, ["fileKey", "ids"]),
        pii_scrub: false,
      },
      {
        name: "figma_list_team_projects",
        title: "피그마 팀 프로젝트 목록",
        description:
          "팀 안의 프로젝트(폴더) 목록. teamId 는 프로그램으로 얻을 수 없어 사람이 팀 주소에서 복사해 넣어야 한다 — " +
          "figma.com/files/team/<teamId>/… 의 team 뒤 숫자. ⚠ 이 도구는 개인 액세스 토큰으로만 동작한다.",
        url: `${FIGMA}/teams/{teamId}/projects`,
        input_schema: obj({
          teamId: S("팀 id — figma.com/files/team/<teamId>/… 주소에서 복사"),
        }, ["teamId"]),
        pii_scrub: false,
        no_paging: "피그마 projects API 에 페이지 파라미터가 없다 — 응답은 프로젝트 id·name 배열이라 팀이 커도 작다.",
      },
      {
        name: "figma_list_project_files",
        title: "피그마 프로젝트 파일 목록",
        description:
          "프로젝트(폴더) 안의 파일 목록 — 파일 이름과 key 를 얻는다. 여기서 얻은 key 로 figma_get_file_comments 를 부른다. " +
          "projectId 는 figma_list_team_projects 결과에서 온다.",
        url: `${FIGMA}/projects/{projectId}/files`,
        input_schema: obj({
          projectId: S("프로젝트 id(figma_list_team_projects 결과의 id)"),
          branch_data: S("브랜치 메타까지 받으려면 'true'"),
        }, ["projectId"]),
        pii_scrub: false,
        no_paging: "피그마 project files API 에 페이지 파라미터가 없다 — 파일당 몇 필드뿐이라 폴더가 커도 작다. branch_data 를 켜면 커지므로 기본은 끈 채로 둔다.",
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
