// lib/claude-connectors.ts — 구성원 Claude 커넥터(claude.ai 커넥터)를 화면에서 말하는 한 벌(#4213 T13).
//  DOM 을 모르는 순수 모듈이다 — 처음 설정(v2/onboarding.ts) · [외부 앱 연결] 현황판(v2/connect-board.ts) ·
//  [구성원 권한 관리 ▸ Claude 커넥터](admin-ai-connectors.ts)가 같은 말·같은 매핑을 쓴다. 표가 두 벌이 되면 조용히 어긋난다.
//
//  이름 공간 셋(조사 2026-10-16):
//   (a) Claude 커넥터 이름 — «claude.ai » 뒤 이름(대소문자 보존): Slack · Notion · Gmail · Google Drive · Microsoft 365 · Claude Docs …
//   (b) 앱 키 — 수집 단위·자료의 외부 시스템 키(slack · notion · gmail · gdrive · outlook …). 서버 unit-store connectorOfApp 가 (b)→(a).
//   (c) 화면 서비스 키(me-logins LOGIN_SERVICES) — google 하나가 drive·gmail·gcal 을 묶는다. 로고는 svc-icons presetSvcKey((b)).
//  여기는 (a)→(b) 와 (b)의 이름표를 둔다. 서버 쪽과의 일치는 scripts/claude-connectors.test.mjs 가 맞춘다.

/** Claude 에서 앱을 연결하는 자리 — 공식 도움말(support.claude.com «Pre-built web connectors using remote MCP»): Customize > Connectors. */
export const CLAUDE_CONNECTORS_URL = 'https://claude.ai/customize/connectors';
/** Claude 커넥터 목록 전체(디렉터리). */
export const CLAUDE_CONNECTORS_DIRECTORY_URL = 'https://claude.ai/connectors';

/** 상태 이름 — 이름이라 명사로 둔다(설명문이 아니다). 서버 상태 표(org/store/member-ai-connectors.ts)와 한 벌. */
export const CLAUDE_CONNECTOR_STATUS_LABEL: Readonly<Record<string, string>> = {
  connected: '연결됨',
  'needs-auth': '다시 로그인 필요',
  failed: '연결 실패',
  pending: '승인 대기',
  unknown: '상태 모름',
  removed: '끊음',
};

/** 확인 실패 사유 → 사람 말. 모르는 사유는 뭉뚱그려 «확인하지 못했어요» — 내부 코드를 그대로 보이지 않는다. */
export function scanErrorText(error: string | null | undefined): string {
  switch (String(error || '')) {
    case 'not-logged-in': return 'Claude 에 로그인돼 있지 않아요.';
    case 'not-claude-ai-login': return 'Claude 계정이 아니라 API 키로 로그인돼 있어 커넥터가 보이지 않아요.';
    case 'no-cli': return '이 자리에 Claude Code 가 없어요.';
    case 'timeout': return '확인하는 데 시간이 너무 오래 걸렸어요.';
    case 'no-capacity': return '지금 자리가 모자라 확인하지 못했어요. 잠시 뒤 다시 해 주세요.';
    case 'no-claude-ai-connectors': return '수집 실행에서 Claude 커넥터가 하나도 보이지 않았어요.';
    case 'unconfirmed-empty': return '연결해 둔 앱이 한 번에 모두 보이지 않았어요. 로그인이 풀렸을 수도 있어 한 번 더 확인하면 반영합니다.';
    default: return '확인하지 못했어요.';
  }
}

/** (a) Claude 커넥터 이름(소문자) → (b) 앱 키. 표에 없으면 이름을 슬러그로 접는다(새 커넥터도 화면이 깨지지 않게). */
const APP_OF_CONNECTOR: Readonly<Record<string, string>> = {
  slack: 'slack', notion: 'notion', gmail: 'gmail', 'google drive': 'gdrive', 'google calendar': 'gcal',
  'microsoft 365': 'outlook', outlook: 'outlook', github: 'github', gitlab: 'gitlab', linear: 'linear',
  figma: 'figma', clickup: 'clickup', jira: 'jira', confluence: 'confluence', 'atlassian': 'atlassian',
  asana: 'asana', discord: 'discord', 'claude docs': 'claude-docs',
};

export function appKeyOfConnector(name: string | null | undefined): string {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return '';
  return APP_OF_CONNECTOR[n] ?? n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** (b) 앱 키 → 보여 줄 이름. 표에 없으면 받은 대체 이름(커넥터 이름 등), 그것도 없으면 키 그대로. */
const APP_LABEL: Readonly<Record<string, string>> = {
  slack: 'Slack', notion: 'Notion', gmail: 'Gmail', gdrive: 'Google Drive', gcal: 'Google Calendar', outlook: 'Microsoft 365',
  github: 'GitHub', gitlab: 'GitLab', linear: 'Linear', figma: 'Figma', clickup: 'ClickUp', jira: 'Jira', confluence: 'Confluence',
  atlassian: 'Atlassian', asana: 'Asana', discord: 'Discord', 'claude-docs': 'Claude Docs',
};

export function appLabel(key: string, fallback?: string | null): string {
  return APP_LABEL[key] ?? (String(fallback ?? '').trim() || key);
}

/** 일 자료가 아닌 커넥터 — Claude 도움말 문서처럼 그 사람 회사 맥락이 담기지 않는 것. 현황판의 앱 줄에 세우지 않는다. */
export const NOT_WORK_APPS: ReadonlySet<string> = new Set(['claude-docs']);

/** 지금 수집 실행(collect_claude_run)이 목록·수집을 아는 앱 — 서버 org/collect/collect-plan.ts CLAUDE_COLLECT_APPS 의 키와 같다(계약 시험). */
export const CLAUDE_COLLECT_APP_KEYS: readonly string[] = ['slack', 'gmail', 'notion'];
