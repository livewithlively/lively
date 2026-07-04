// 커넥터 config/시크릿 해소 — 커넥터가 process.env 를 직접 읽던 것의 단일 간접 계층 (프로젝트 #541 태스크 1).
//
//   · CONNECTOR_SPECS = 커넥터별 설정 필드의 **단일 진실원천**(scheduler.ts 의 CRON_ACTIONS 패턴과 동형).
//     관리탭이 이걸 읽어 커넥터 설정 폼을 동적 생성하고(하드코딩 폼 제거), config 해소·검증·문서의 SoT.
//     새 커넥터/필드 추가 = 여기 1개 항목(+커넥터 모듈) — 커넥터 코드는 process.env 이름을 모른다.
//
//   · resolveConnectorConfig(system) = 커넥터 config 를 해소한다. **현재 백엔드 = env 폴백(byte-identical)** —
//     각 필드의 env 이름에서 읽어 종전 process.env 직접 읽기와 정확히 같은 값을 돌려준다(빈 문자열→undefined 정규화).
//     ⚠ 토큰 저장 백엔드(#541 태스크 5, 관리탭)가 정해지면 **이 함수 뒤에만** DB(org_connector)+시크릿 복호화를
//     끼운다 — 커넥터 5개(slack/discord/notion/clickup/clickup-push)는 무변경(이 분리가 본 계층의 목적).
//
//   · 모듈 레벨 캐시(system 별, 프로세스당 1회 로드) — clickup 처럼 매 요청마다 토큰을 읽어도 DB 부하 0.
//     커넥터는 서브프로세스(run-sync/run-backfill/run-push)로 짧게 살다 죽으므로 stale 우려 없음.
import { itemsPool } from "../domainmap/db.js";
import { isEncrypted, tryDecryptSecret } from "../org/secret-box.js";

/** 커넥터 설정 필드 1개의 메타데이터. 관리탭 폼·해소·(미래)암호화의 공용 기술. */
export interface ConnectorField {
  /** 해소 결과 객체의 프로퍼티 키 — 예: "bot_token". 커넥터는 이 키로 값을 읽는다(env 이름 비의존). */
  key: string;
  /** 폴백 env 변수 이름 — 예: "SLACK_BOT_TOKEN". 현재 해소 백엔드가 이 env 에서 읽는다. */
  env: string;
  /** 시크릿 여부 — 관리탭 마스킹·redact·(미래)암호화 대상. */
  secret: boolean;
  /** 없으면 커넥터가 동작 불가(토큰 등). 관리탭 필수 표시·검증. */
  required?: boolean;
  /** 관리탭 표시 라벨. */
  label?: string;
  /** 관리탭 입력 힌트(placeholder). */
  hint?: string;
  /** 스코프 픽커(#586) — 지정 시 관리탭이 '목록에서 선택' 버튼을 붙이고 discover API 로 옵션을 채운다. */
  picker?: "notion_pages" | "clickup_lists";
}

/** 커넥터 1종의 설정 스펙. */
export interface ConnectorSpec {
  system: string;
  /** 사람이 읽는 커넥터 이름(관리탭 표시). */
  label: string;
  fields: ConnectorField[];
  /** 토큰 발급 가이드(#586) — 관리탭 폼 상단 접이식 안내. */
  guide?: { intro?: string; steps: string[]; url?: string };
}

// ── 단일 진실원천 — 커넥터별 설정 필드. env 이름은 종전 .env.example 과 정확히 일치(byte-identical). ──
export const CONNECTOR_SPECS: Record<string, ConnectorSpec> = {
  slack: {
    system: "slack",
    label: "Slack",
    guide: {
      steps: [
        "api.slack.com/apps ▸ [Create New App] ▸ From scratch — 워크스페이스 선택",
        "OAuth & Permissions ▸ Bot Token Scopes: channels:history, channels:read, users:read 추가",
        "[Install to Workspace] 승인 → Bot User OAuth Token(xoxb-…) 복사 → 아래 저장",
        "수집할 채널에서 /invite @앱이름 (봇이 초대된 채널만 읽음)",
      ],
      url: "https://api.slack.com/apps",
    },
    fields: [
      { key: "bot_token", env: "SLACK_BOT_TOKEN", secret: true, required: true, label: "Bot Token", hint: "xoxb-..." },
    ],
  },
  discord: {
    system: "discord",
    label: "Discord",
    guide: {
      steps: [
        "discord.com/developers/applications ▸ [New Application] ▸ Bot 탭 ▸ [Reset Token] 으로 봇 토큰 발급",
        "Privileged Gateway Intents 에서 MESSAGE CONTENT INTENT 켜기",
        "OAuth2 ▸ URL Generator 로 서버에 봇 초대(Read Messages/History 권한)",
      ],
      url: "https://discord.com/developers/applications",
    },
    fields: [
      { key: "bot_token", env: "DISCORD_BOT_TOKEN", secret: true, required: true, label: "Bot Token" },
      { key: "channels", env: "DISCORD_CHANNELS", secret: false, label: "채널 allowlist", hint: "채널 id 쉼표구분 (비우면 봇이 보는 전체)" },
    ],
  },
  notion: {
    system: "notion",
    label: "Notion",
    guide: {
      intro: "노션은 '내부(Internal) 통합'의 시크릿 토큰으로 읽습니다. 통합 생성은 워크스페이스 오너만 가능합니다.",
      steps: [
        "notion.so/profile/integrations → [+ 새 통합] — 이름 자유, 연결된 워크스페이스 = 싱크할 워크스페이스, 종류 = 내부(Internal). (Internal 이 안 보이면 그 워크스페이스 오너가 아닌 것 — 오너에게 생성을 요청하세요)",
        "통합 ▸ 기능(Capabilities): '콘텐츠 읽기' 필수 + '댓글 읽기'·'사용자 정보(이메일 포함) 읽기' 권장",
        "구성(Configuration) 탭의 '내부 통합 시크릿'(ntn_… / secret_…) 복사 → 아래 Integration Token 에 저장",
        "노션에서 싱크할 최상위 페이지(또는 팀스페이스) 열기 → ⋯ ▸ 연결(Connections) ▸ 이 통합 추가 — 여기 공유한 범위가 곧 싱크 범위(하위 페이지 자동 포함)",
        "저장 후 [지금 싱크] — 첫 실행은 전체 백필, 이후 자동 증분",
      ],
      url: "https://www.notion.so/profile/integrations",
    },
    fields: [
      { key: "token", env: "NOTION_TOKEN", secret: true, required: true, label: "Integration Token", hint: "secret_..." },
      { key: "instance", env: "NOTION_INSTANCE", secret: false, label: "Instance", hint: "워크스페이스 식별자 (기본 default)" },
      // #551 무손실 싱크 옵션
      { key: "root_pages", env: "NOTION_ROOT_PAGES", secret: false, label: "루트 페이지", picker: "notion_pages", hint: "페이지 URL·슬러그·id 아무 형태나 쉼표구분 — 지정 시 그 서브트리만 싱크(비우면 통합에 공유된 전체). 공유 직후엔 search 인덱싱 지연이 있어 루트 지정이 즉시 반영에 유리" },
      { key: "comments", env: "NOTION_COMMENTS", secret: false, label: "댓글 수집", hint: "page(기본: 페이지 단위) | all(블록 단위, 고비용) | off" },
      { key: "asset_dir", env: "NOTION_ASSET_DIR", secret: false, label: "자산 저장 경로", hint: "이미지/파일 다운로드 디렉터리 (기본 ./data/notion-assets)" },
      { key: "api_version", env: "NOTION_API_VERSION", secret: false, label: "API 버전", hint: "기본 2025-09-03 (data_source 분리)" },
    ],
  },
  clickup: {
    system: "clickup",
    label: "ClickUp",
    guide: {
      steps: [
        "ClickUp 우하단 아바타 ▸ Settings ▸ Apps — 'API Token' 에서 [Generate](personal token, pk_…) 후 복사",
        "아래 API Token 에 저장 → 리스트 필드는 [목록에서 선택] 으로 고르면 됩니다",
      ],
      url: "https://app.clickup.com/settings/apps",
    },
    fields: [
      { key: "api_token", env: "CLICKUP_API_TOKEN", secret: true, required: true, label: "API Token", hint: "personal token (pk_...)" },
      { key: "include_list_ids", env: "CLICKUP_INCLUDE_LIST_IDS", secret: false, label: "포함 리스트", picker: "clickup_lists", hint: "설정 시 이 리스트만 싱크 (쉼표구분)" },
      { key: "exclude_list_ids", env: "CLICKUP_EXCLUDE_LIST_IDS", secret: false, label: "제외 리스트", picker: "clickup_lists", hint: "노이즈/샘플 리스트 (쉼표구분)" },
      { key: "container_list_id", env: "CLICKUP_CONTAINER_LIST_ID", secret: false, label: "컨테이너 리스트", picker: "clickup_lists", hint: "아웃바운드 create 대상 List" },
    ],
  },
  // Google 커넥터 — OAuth2 refresh-token(google-auth.ts). client_id 는 공개 식별자(secret 아님), client_secret·refresh_token 은 시크릿.
  gmail: {
    system: "gmail",
    label: "Gmail",
    guide: {
      intro: "Google 은 OAuth 데스크톱 클라이언트의 refresh token 방식입니다(1개 토큰이 Gmail·Drive 공용 가능).",
      steps: [
        "console.cloud.google.com ▸ APIs & Services ▸ Credentials ▸ [Create Credentials ▸ OAuth client ID] — 유형 'Desktop app'",
        "OAuth consent screen 을 'In production' 으로 게시(Testing 상태면 refresh token 이 7일 만료)",
        "클라이언트 ID/Secret 으로 gmail.readonly scope 승인 → refresh token 발급(설치 키트의 google-oauth 헬퍼 또는 OAuth Playground)",
        "세 값을 아래에 저장",
      ],
      url: "https://console.cloud.google.com/apis/credentials",
    },
    fields: [
      { key: "client_id", env: "GMAIL_CLIENT_ID", secret: false, required: true, label: "OAuth Client ID", hint: "xxxx.apps.googleusercontent.com" },
      { key: "client_secret", env: "GMAIL_CLIENT_SECRET", secret: true, required: true, label: "OAuth Client Secret" },
      { key: "refresh_token", env: "GMAIL_REFRESH_TOKEN", secret: true, required: true, label: "Refresh Token", hint: "gmail.readonly scope" },
      { key: "query", env: "GMAIL_QUERY", secret: false, label: "검색 쿼리", hint: "Gmail 검색식 (예: -from:noreply, 비우면 전체)" },
    ],
  },
  gdrive: {
    system: "gdrive",
    label: "Google Drive",
    guide: {
      intro: "Gmail 과 같은 OAuth 클라이언트를 써도 됩니다 — scope 에 drive.readonly 를 합쳐 refresh token 을 발급하면 1개로 공용.",
      steps: [
        "Gmail 가이드와 동일하게 OAuth 데스크톱 클라이언트 준비",
        "drive.readonly scope 포함해 refresh token 발급 → 아래 저장",
      ],
      url: "https://console.cloud.google.com/apis/credentials",
    },
    fields: [
      { key: "client_id", env: "GDRIVE_CLIENT_ID", secret: false, required: true, label: "OAuth Client ID", hint: "xxxx.apps.googleusercontent.com" },
      { key: "client_secret", env: "GDRIVE_CLIENT_SECRET", secret: true, required: true, label: "OAuth Client Secret" },
      { key: "refresh_token", env: "GDRIVE_REFRESH_TOKEN", secret: true, required: true, label: "Refresh Token", hint: "drive.readonly scope" },
      { key: "folders", env: "GDRIVE_FOLDERS", secret: false, label: "폴더 id", hint: "이 폴더들만 (쉼표구분, 비우면 전체 Drive)" },
    ],
  },
};

// ── 해소 캐시 — system 별 프로세스당 1회 로드. ──
const _cache = new Map<string, Promise<Record<string, string | undefined>>>();

/**
 * 커넥터 config 해소. 반환 객체의 키 = CONNECTOR_SPECS[system].fields[].key.
 * 현재 백엔드 = env 폴백(byte-identical). 미지정/빈 문자열은 undefined 로 정규화(종전 falsy 검사와 동치).
 * 미정의 system 은 빈 객체.
 */
export function resolveConnectorConfig(system: string): Promise<Record<string, string | undefined>> {
  let p = _cache.get(system);
  if (!p) {
    p = loadConnectorConfig(system);
    _cache.set(system, p);
  }
  return p;
}

async function loadConnectorConfig(system: string): Promise<Record<string, string | undefined>> {
  const spec = CONNECTOR_SPECS[system];
  const out: Record<string, string | undefined> = {};
  if (!spec) return out;

  // ── 백엔드: DB(org_connector) 우선 → env 폴백 ──
  //  관리탭이 저장한 값이 있으면 그걸 쓰고(시크릿은 secret-box 복호화), 없거나 DB 미연결이면 env 로 폴백한다
  //  (byte-identical 무중단 — DB 부재·마스터키 부재·행 부재·복호화 실패 전부 env 로 수렴). 캐시라 프로세스당 1회 조회.
  let dbConfig: Record<string, unknown> = {};
  let dbSecrets: Record<string, unknown> = {};
  try {
    const r = await itemsPool.query<{ config: Record<string, unknown> | null; secrets: Record<string, unknown> | null }>(
      `SELECT config, secrets FROM org_connector WHERE system=$1`, [system]);
    if (r.rows[0]) { dbConfig = r.rows[0].config ?? {}; dbSecrets = r.rows[0].secrets ?? {}; }
  } catch { /* 테이블 부재/DB 미연결 → 전량 env 폴백 */ }

  for (const f of spec.fields) {
    let v: string | undefined;
    if (f.secret) {
      // 시크릿: DB 암호문 복호화(gcm$…). 암호화 안 된 평문 저장분도 관용. 실패/부재면 미확정(→env 폴백).
      const enc = dbSecrets[f.key];
      if (typeof enc === "string" && enc) v = isEncrypted(enc) ? (tryDecryptSecret(enc) ?? undefined) : enc;
    } else {
      // 비밀 아닌 설정: DB config 평문.
      const c = dbConfig[f.key];
      if (typeof c === "string" && c) v = c;
    }
    if (v == null || v === "") v = process.env[f.env]; // env 폴백
    out[f.key] = v != null && v !== "" ? v : undefined;
  }
  return out;
}

/** 테스트/재설정용 — 해소 캐시 무효화(관리탭에서 config 갱신 후 등). */
export function resetConnectorConfigCache(): void {
  _cache.clear();
}
