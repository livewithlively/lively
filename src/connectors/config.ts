// 커넥터 config/시크릿 해소 — 커넥터가 process.env 를 직접 읽던 것의 단일 간접 계층 (프로젝트 #541 태스크 1).
//
//   · CONNECTOR_SPECS = 커넥터별 설정 필드의 **단일 진실원천**(scheduler/index.ts 의 CRON_ACTIONS 패턴과 동형).
//     관리탭이 이걸 읽어 커넥터 설정 폼을 동적 생성하고(하드코딩 폼 제거), config 해소·검증·문서의 SoT.
//     새 커넥터/필드 추가 = 여기 1개 항목(+커넥터 모듈) — 커넥터 코드는 process.env 이름을 모른다.
//
//   · resolveConnectorConfig(system) = 커넥터 config 를 해소한다. **현재 백엔드 = env 폴백(byte-identical)** —
//     각 필드의 env 이름에서 읽어 종전 process.env 직접 읽기와 정확히 같은 값을 돌려준다(빈 문자열→undefined 정규화).
//     ⚠ 토큰 저장 백엔드(#541 태스크 5, 관리탭)가 정해지면 **이 함수 뒤에만** DB(org_connector)+시크릿 복호화를
//     끼운다 — 커넥터 5개(slack/discord/notion/clickup/clickup-push)는 무변경(이 분리가 본 계층의 목적).
//
//   · 모듈 레벨 캐시(system 별, 프로세스당 1회 로드) — clickup 처럼 매 요청마다 토큰을 읽어도 DB 부하 0.
//     커넥터는 서브프로세스(run-sync/run-push)로 짧게 살다 죽으므로 stale 우려 없음.
import { itemsPool } from "../db/client.js";
import { isEncrypted, tryDecryptSecret } from "../org/credentials/secret-box.js";

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
  // 슬랙은 **두 모드**다(#1531) — 어느 토큰을 넣었는지가 곧 모드다.
  //  · 유저 토큰(xoxp-) = 검색 스윕 — 봇 초대 없이 **전 공개채널**. 비공개는 원리적으로 못 본다.
  //  · 봇 토큰(xoxb-)   = 멤버십 스윕 — **봇이 초대된 채널만**, 대신 **비공개 채널이 들어온다**.
  //  둘은 배타가 아니라 상보라 보통 수집기를 둘 만든다(공개 전체 1개 + 비공개 담당 봇 1개). 커서는
  //  인스턴스별로 갈리므로(#1419) 서로의 진행을 밀지 않는다. 한 수집기에 둘 다 넣으면 유저 토큰이 이긴다.
  slack: {
    system: "slack",
    label: "Slack",
    guide: {
      intro: "토큰 종류가 수집 방식을 결정합니다. **유저 토큰(xoxp-)** 은 검색(search.messages)으로 봇 초대 없이 전 공개채널을 훑습니다(비공개는 못 봅니다). **봇 토큰(xoxb-)** 은 봇이 초대된 채널만 읽는 대신 **비공개 채널을 수집할 수 있습니다**. 둘 다 필요하면 수집기를 두 개 만드세요 — 각자 커서를 가지므로 서로 간섭하지 않습니다.",
      steps: [
        "api.slack.com/apps ▸ 앱 선택(없으면 [Create New App] ▸ From scratch — 워크스페이스 선택)",
        "[공개채널 전체를 훑을 때] OAuth & Permissions ▸ 'User Token Scopes': search:read, channels:read, users:read, users:read.email → [Install to Workspace] → 'User OAuth Token'(xoxp-…) 을 아래 User Token 에 저장. 채널 초대 불필요.",
        "[비공개 채널을 수집할 때] 같은 화면 'Bot Token Scopes': groups:history, groups:read, channels:history, channels:read, users:read (+첨부까지 받으려면 files:read) → 재설치 → 'Bot User OAuth Token'(xoxb-…) 을 아래 Bot Token 에 저장",
        "봇 토큰은 **초대된 채널만** 읽습니다 — 대상 채널에서 /invite @봇이름 으로 초대하세요(초대 안 된 채널은 조용히 빠집니다)",
        "모니터링·알람 등 노이즈 채널은 '제외 채널'에, 봇이 초대된 채널 중 일부만 원하면 '대상 채널'에 적으세요.",
      ],
      url: "https://api.slack.com/apps",
    },
    fields: [
      // ⚠ required 를 뗀 이유: 봇 전용 수집기는 유저 토큰이 **없는 것이 정상**이다. 대신 커넥터가 부팅 때
      //  "둘 중 하나는 있어야 한다"를 검사하고 어느 쪽을 넣어야 하는지 알려준다(빈 값 = 조용한 무수집 방지).
      { key: "user_token", env: "SLACK_USER_TOKEN", secret: true, label: "User Token", hint: "xoxp-... — 검색 스윕(전 공개채널). 비공개 채널을 원하면 아래 Bot Token 을 쓰세요" },
      { key: "bot_token", env: "SLACK_BOT_TOKEN", secret: true, label: "Bot Token", hint: "xoxb-... — 봇이 초대된 채널만 수집(**비공개 채널 포함**). User Token 을 함께 넣으면 그쪽이 우선합니다" },
      { key: "channels", env: "SLACK_CHANNELS", secret: false, label: "대상 채널", hint: "봇 모드 전용 — 채널명·id 를 공백·쉼표로 구분(비우면 봇이 초대된 전체). 예: hai솔루션_front hai솔루션_closing" },
      { key: "noise_exclude", env: "SLACK_NOISE_EXCLUDE", secret: false, label: "제외 채널", hint: "수집에서 제외할 채널명을 공백·쉼표로 구분해 입력 (예: alerts monitoring) — 모니터링·알람 등 메시지가 많은 봇 채널에 사용합니다." },
      { key: "backfill_since", env: "SLACK_BACKFILL_SINCE", secret: false, label: "최초 수집 시작일", hint: "이 날짜 이후의 자료만 수집합니다 (YYYY-MM-DD, 비우면 활동이 있는 과거 전체를 자동 수집)" },
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
      { key: "exclude_pages", env: "NOTION_EXCLUDE_PAGES", secret: false, label: "제외 페이지", picker: "notion_pages", hint: "여기 지정한 페이지·DB 와 그 하위 전체를 싱크에서 제외(쉼표구분). 루트 안의 특정 서브트리를 빼거나 전체 공유 중 일부만 뺄 때. 이미 싱크된 항목은 다음 전체 싱크에서 자동 보관 처리(제외 해제 시 복원)" },
      { key: "comments", env: "NOTION_COMMENTS", secret: false, label: "댓글 수집", hint: "page(기본: 페이지 단위) | all(블록 단위, 고비용) | off" },
      { key: "asset_dir", env: "NOTION_ASSET_DIR", secret: false, label: "첨부 파일 저장 경로", hint: "이미지/파일 다운로드 디렉터리 (기본 ./data/notion-assets)" },
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
  // 도메인위키(#696) — 로컬 git 마크다운 미러(team_wiki) → 지식. 자격증명 없음(로컬 경로만). 인입 시 상대 .md·[[..]]·notion URL 링크를 #/k/ 로 정규화.
  "domain-wiki": {
    system: "domain-wiki",
    label: "도메인 위키 (Git Markdown)",
    guide: {
      intro: "로컬에 체크아웃된 마크다운 위키 repo(예: git@git.example.com:acme-dev/domain-wiki.git 의 clone)를 지식으로 인입합니다. 파일 1개=지식 1개(name=파일명 슬러그), 상대경로 .md·[[위키링크]]·노션 URL 링크는 인입 시 내부 #/k/ 링크로 자동 정규화됩니다. 자격증명 불필요 — 게이트웨이가 읽을 수 있는 로컬 경로만 지정하세요.",
      steps: [
        "게이트웨이 호스트에 repo 를 clone/pull (예: /srv/lively/shared/repos/domain-wiki) — 게이트웨이 프로세스가 읽을 수 있는 경로",
        "아래 '체크아웃 경로'에 그 절대경로 저장 (content 하위 폴더가 기본 스캔 대상)",
        "저장 후 [지금 싱크] — 매 실행 워킹트리 전량 재인입(멱등). 삭제된 파일은 아카이브로 전파",
        "선택: 'git pull' 을 true 로 하면 싱크 전 ff-only pull 시도(자격증명 필요, 없으면 워킹트리 그대로)",
      ],
    },
    fields: [
      { key: "repo_path", env: "DOMAIN_WIKI_PATH", secret: false, required: true, label: "체크아웃 경로", hint: "로컬 repo 절대경로 (예: /srv/lively/shared/repos/domain-wiki)" },
      { key: "content_subdir", env: "DOMAIN_WIKI_CONTENT", secret: false, label: "콘텐츠 하위폴더", hint: "스캔할 하위폴더 (기본 content)" },
      { key: "git_pull", env: "DOMAIN_WIKI_GIT_PULL", secret: false, label: "싱크 전 git pull", hint: "true 면 ff-only pull 시도 (기본 false — 워킹트리 그대로 읽음)" },
      { key: "base_url", env: "DOMAIN_WIKI_BASE_URL", secret: false, label: "원본 blob URL 접두", hint: "external_url 구성용 (기본 gitlab blob/main)" },
      { key: "instance", env: "DOMAIN_WIKI_INSTANCE", secret: false, label: "Instance", hint: "repo 식별자 (기본 domain-wiki)" },
    ],
  },
};

// ════════ 다중 수집기 인스턴스 해소 (#1419 T1) ════════
//  이 파일 상단이 약속한 확장을 그대로 이행한다 — "토큰 저장 백엔드가 정해지면 **이 함수 뒤에만** 끼운다.
//  커넥터 5개는 무변경(이 분리가 본 계층의 목적)." 이제 끼우는 것이 '어느 인스턴스의 설정인가'다.
//
//  ⚠ 커넥터 모듈(slack/notion/clickup/gmail/gdrive/discord/domain-wiki)은 여전히 `resolveConnectorConfig("slack")`
//   한 줄만 부른다 — 그들이 몇 번째 인스턴스로 돌고 있는지 **몰라도 되게** 하는 것이 요점이다. 대신 바깥에서
//   '지금 어느 인스턴스인가'를 씌운다. 그 씌우는 방식이 호출 맥락에 따라 둘이다:
//
//   · **싱크 서브프로세스**(run-sync) — `bindCollector()` 로 프로세스 전체를 못 박는다. 프로세스 하나가
//     수집기 하나만 담당하고 짧게 살다 죽으므로 전역 바인딩이 정확하다.
//   · **장수 게이트웨이**(discover 픽커·멤버 매핑 등 REST 경로) — 전역은 **틀린 도구**다. 요청 두 개가 서로 다른
//     수집기로 동시에 들어오면 늦게 도착한 쪽이 앞선 요청의 바인딩을 갈아엎는다(조용히 남의 토큰으로 호출).
//     그래서 `withCollector(c, fn)` 로 **비동기 컨텍스트에만** 씌운다(AsyncLocalStorage — 요청별 격리).
//
//  해소 순서(3단 폴백 — 무중단 제1계약):
//   ① 바인딩된 수집기(org_collector) → ② 레거시 기본 인스턴스(org_collector 미마이그레이션분: org_connector)
//   → ③ env. 어느 단계가 비어도 다음으로 떨어지므로, org_collector 가 **텅 빈 배포는 종전과 완전히 동일**하다.
import { AsyncLocalStorage } from "node:async_hooks";

/** 수집기 바인딩 — 어느 인스턴스로 해소할 것인가. */
export interface CollectorBinding {
  id: number;
  presetKey: string;
  instanceKey: string;
  /**
   * 산출 정책(#1419 T3) — 이 수집기의 결과를 자료로 둘지 지식으로 올릴지. 미러가 라우팅에 쓴다.
   *  바인딩에 실어 나르는 이유: 미러(v6/connector-mirror)는 항목 단위로 불리는데 그때마다 DB 를 되묻으면
   *  항목당 쿼리 한 번이 붙는다. 프로세스가 곧 수집기 하나라 시작할 때 한 번 읽어 들고 다니는 게 맞다.
   */
  outputMode?: import("../org/ingest/ingest-classify.js").CollectorOutputMode;
  /** 지식 직행 시 적용할 규칙(대상 분류·기본 유형·이름 접두어). output_config 원문. */
  outputConfig?: Record<string, unknown>;
}

// ── 해소 캐시 ──
//  ⚠ 키에 **수집기 id 가 반드시 들어간다**(`<collectorId|_>:<system>`). system 만으로 키를 잡으면 게이트웨이에서
//   먼저 조회한 수집기의 토큰이 캐시에 눌러앉아, 그 다음 요청이 다른 수집기를 물어도 그 값을 돌려준다 —
//   '남의 워크스페이스 토큰으로 호출'이라는 조용하고 위험한 오작동이 된다.
const _cache = new Map<string, Promise<Record<string, string | undefined>>>();

/** 프로세스 전역 바인딩(싱크 서브프로세스 전용). null = 레거시 단일 인스턴스 모드(종전 동작). */
let _boundCollector: CollectorBinding | null = null;
/** 요청 범위 바인딩(장수 게이트웨이) — 전역보다 우선한다. */
const _als = new AsyncLocalStorage<CollectorBinding | null>();

/** 지금 유효한 바인딩 — 요청 범위가 있으면 그것, 없으면 프로세스 전역. */
function activeBinding(): CollectorBinding | null {
  const scoped = _als.getStore();
  return scoped !== undefined ? scoped : _boundCollector;
}

/**
 * 이 **프로세스**를 한 수집기 인스턴스에 못 박는다(#1419 T1). run-sync 가 첫 해소보다 먼저 부른다.
 *  ⚠ 장수 게이트웨이에서는 쓰지 마라 — 동시 요청이 서로의 바인딩을 덮는다. 거기선 withCollector 를 쓴다.
 */
export function bindCollector(c: CollectorBinding | null): void {
  _boundCollector = c;
}

/**
 * fn 을 이 수집기 바인딩 **안에서** 실행한다(게이트웨이 REST 경로용 — 요청별 격리).
 *  AsyncLocalStorage 라 동시 요청끼리 섞이지 않고, fn 이 끝나면 바인딩도 함께 사라진다.
 */
export function withCollector<T>(c: CollectorBinding | null, fn: () => Promise<T>): Promise<T> {
  return _als.run(c, fn);
}

/** 지금 바인딩된 수집기(없으면 null) — run-sync·clickup 커서가 네임스페이스 계산에 쓴다. */
export function boundCollector(): CollectorBinding | null {
  return activeBinding();
}

/**
 * 지금 맥락의 커서 네임스페이스 — connector_state(system, instance) 의 instance.
 *  바인딩이 없으면 종전 그대로 '_'(레거시 단일 인스턴스). 그래서 마이그레이션된 기본 수집기가
 *  instance_key='_' 를 물려받으면 **커서가 그대로 승계**된다(전체 재수집 없음).
 */
export function collectorInstanceKey(): string {
  return activeBinding()?.instanceKey ?? "_";
}

/**
 * 커넥터 config 해소. 반환 객체의 키 = CONNECTOR_SPECS[system].fields[].key.
 * 백엔드 = 바인딩된 수집기 → org_connector(레거시 기본) → env 폴백. 미지정/빈 문자열은 undefined 로
 * 정규화(종전 falsy 검사와 동치). 미정의 system 은 빈 객체.
 */
export function resolveConnectorConfig(system: string): Promise<Record<string, string | undefined>> {
  const bound = activeBinding();
  // 바인딩의 프리셋이 물어본 system 과 다르면 그 바인딩은 이 조회에 무관하다 — 레거시 키로 떨어뜨려
  //  캐시가 인스턴스별로 쪼개지지 않게 한다(한 프로세스가 남의 system 을 곁다리로 읽는 경로).
  const scope = bound && bound.presetKey === system ? String(bound.id) : "_";
  const cacheKey = `${scope}:${system}`;
  let p = _cache.get(cacheKey);
  if (!p) {
    p = loadConnectorConfig(system, bound && bound.presetKey === system ? bound : null);
    _cache.set(cacheKey, p);
  }
  return p;
}

async function loadConnectorConfig(
  system: string, bound: CollectorBinding | null,
): Promise<Record<string, string | undefined>> {
  const spec = CONNECTOR_SPECS[system];
  const out: Record<string, string | undefined> = {};
  if (!spec) return out;

  // ── 백엔드: 수집기 인스턴스 → org_connector(레거시) → env 폴백 ──
  //  관리탭이 저장한 값이 있으면 그걸 쓰고(시크릿은 secret-box 복호화), 없거나 DB 미연결이면 env 로 폴백한다
  //  (byte-identical 무중단 — DB 부재·마스터키 부재·행 부재·복호화 실패 전부 env 로 수렴). 캐시라 조합당 1회 조회.
  let dbConfig: Record<string, unknown> = {};
  let dbSecrets: Record<string, unknown> = {};
  // ① 바인딩된 수집기 — 호출자가 프리셋 일치를 이미 확인해 넘긴다(불일치면 null).
  if (bound) {
    try {
      const r = await itemsPool.query<{ config: Record<string, unknown> | null; secrets: Record<string, unknown> | null }>(
        `SELECT config, secrets FROM org_collector WHERE id=$1`, [bound.id]);
      if (r.rows[0]) { dbConfig = r.rows[0].config ?? {}; dbSecrets = r.rows[0].secrets ?? {}; }
    } catch { /* 테이블 부재(마이그레이션 전) → 아래 레거시 경로로 */ }
  }
  // ② 레거시 기본 인스턴스(org_connector) — **바인딩이 없을 때만** 본다.
  //  ⚠ 바인딩이 있으면 이 층을 건너뛴다. 안 그러면 새로 만든 수집기(아직 토큰 미입력)가 기존 기본 인스턴스의
  //   토큰을 조용히 물려받아 **남의 워크스페이스를 긁는다** — 게다가 커서 네임스페이스는 달라서 같은 자료를
  //   처음부터 다시 훑는다. 수집기는 자기 설정으로 완결돼야 하고, 빈 필수값은 화면이 막는다(저장 시 검증).
  //   마이그레이션이 기존 값을 수집기로 복사하므로 이 생략으로 잃는 것은 없다(기본 인스턴스는 자기 값을 갖는다).
  let legacyConfig: Record<string, unknown> = {};
  let legacySecrets: Record<string, unknown> = {};
  if (!bound) {
    try {
      const r = await itemsPool.query<{ config: Record<string, unknown> | null; secrets: Record<string, unknown> | null }>(
        `SELECT config, secrets FROM org_connector WHERE system=$1`, [system]);
      if (r.rows[0]) { legacyConfig = r.rows[0].config ?? {}; legacySecrets = r.rows[0].secrets ?? {}; }
    } catch { /* 테이블 부재/DB 미연결 → 전량 env 폴백 */ }
  }

  for (const f of spec.fields) {
    let v: string | undefined;
    if (f.secret) {
      // 시크릿: DB 암호문 복호화(gcm$…). 암호화 안 된 평문 저장분도 관용. 실패/부재면 미확정(→다음 단계).
      const enc = dbSecrets[f.key] ?? legacySecrets[f.key];
      if (typeof enc === "string" && enc) v = isEncrypted(enc) ? (tryDecryptSecret(enc) ?? undefined) : enc;
    } else {
      // 비밀 아닌 설정: DB config 평문.
      const c = dbConfig[f.key] ?? legacyConfig[f.key];
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
