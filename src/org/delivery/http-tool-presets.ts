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
    level: group.level,
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
