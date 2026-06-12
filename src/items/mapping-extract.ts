// 순수 결정적 추출기 — IO/DB/fetch 없음. 단위 테스트 가능(커넥터 toRawItem 스타일).
// 모든 함수는 "이미 받아온" 후보 vocab(도메인/프로젝트/엔티티명)을 인자로 받아 순수하게 유지한다.
// DESIGN §7: 매핑은 구조적·명시참조 우선, 미매핑은 신호 — 규칙을 넓혀 억지 매핑하지 않는다.

// Notion 본문은 ~500KB 까지 옴 — 정규식 스캔 전 항상 capText 로 bound.
export const BODY_SCAN_CAP = 50_000;
export function capText(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > BODY_SCAN_CAP ? s.slice(0, BODY_SCAN_CAP) : s;
}

// ── 공용 정규식 보조 ──
// 이슈키/약어 오탐 차단용 deny-prefix(라이선스·모델·표준·인코딩 등).
const DENY_PREFIXES = new Set([
  "AGPL", "GPL", "LGPL", "MIT", "CC", "BY", "NC", "SA", "ND",
  "GPT", "ERC", "EIP", "UTF", "ISO", "RFC", "SHA", "MD5", "AES",
  "AI", "ORP", "API", "URL", "URI", "JSON", "XML", "HTML", "CSS",
  "HTTP", "TCP", "UDP", "SQL", "CSV", "PDF", "PNG", "JPG", "GIF",
  "USD", "KRW", "EUR", "JPY", "RGB", "RGBA",
]);

// 트래커 URL(jira/linear/github issues 등) — 이슈키/해시 코로보레이션 신호.
const TRACKER_URL_RE = /(https?:\/\/[^\s)]*?(atlassian\.net|jira|linear\.app|github\.com\/[^\s/)]+\/[^\s/)]+\/(issues|pull)))/i;
// close-keyword: close/fix/resolve(d/s/es) — 명시 참조 신호.
const CLOSE_KEYWORD_RE = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b/i;

export interface IssueKeyRef { key: string; corroborated: boolean }

// P1 — 이슈키 [A-Z]{2,10}-\d+ 추출. corroborated=true 는 트래커 URL 또는 close-keyword 동반 시에만.
// deny-prefix(라이선스/모델/표준)는 드롭. corroboration 없는 키는 corroborated:false 로 표시(매퍼가 무시).
export function extractIssueKeys(text: string): IssueKeyRef[] {
  const t = capText(text);
  const hasTracker = TRACKER_URL_RE.test(t);
  const hasClose = CLOSE_KEYWORD_RE.test(t);
  const out: IssueKeyRef[] = [];
  const seen = new Set<string>();
  const re = /\b([A-Z]{2,10})-(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const prefix = m[1];
    const key = `${prefix}-${m[2]}`;
    if (DENY_PREFIXES.has(prefix)) continue; // 라이선스/모델/표준 오탐 제거
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, corroborated: hasTracker || hasClose });
  }
  return out;
}

export interface HashRef { num: number; corroborated: boolean }

// P1 — #\d+ 추출. corroborated=true 는 github repo URL 또는 close-keyword 동반 시에만.
// bare '#3352'(예: 'Daon#3352' 디스코드 태그)는 절대 corroborated 되지 않음.
export function extractHashRefs(text: string): HashRef[] {
  const t = capText(text);
  const hasRepoUrl = /github\.com\/[^\s/)]+\/[^\s/)]+/i.test(t);
  const hasClose = CLOSE_KEYWORD_RE.test(t);
  const corroborated = hasRepoUrl || hasClose;
  const out: HashRef[] = [];
  const seen = new Set<number>();
  // 앞에 식별자 문자(영숫자/_)가 붙은 #(예: Daon#3352)는 제외 → 순수 이슈/PR 참조만.
  const re = /(^|[^\w])#(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const num = Number(m[2]);
    if (!Number.isFinite(num) || seen.has(num)) continue;
    seen.add(num);
    out.push({ num, corroborated });
  }
  return out;
}

export interface CloseRef { keyword: string; ref: string }

// P1 — close/fix/resolve + (#해시 | 대문자 이슈키) 동반 참조. PR↔이슈 닫기 링크의 명시 신호.
// 실제 이슈 토큰만 — bare 숫자('close 5 things'/'fixed 3 bugs')는 매치 안 함(오탐 차단).
export function extractCloseRefs(text: string): CloseRef[] {
  const t = capText(text);
  const out: CloseRef[] = [];
  // ref = '#\d+'(해시 참조) 또는 'ABC-123'(대문자 이슈키). bare 숫자 불허.
  // 키워드는 대소문자 무시([Cc] 등), 이슈키는 대문자만(소문자 prefix 오탐 방지) → 전역 i 플래그 미사용.
  const re = /\b([Cc]lose[sd]?|[Ff]ix(?:e[sd])?|[Rr]esolve[sd]?)\b\s+(#\d+|[A-Z]{2,10}-\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    out.push({ keyword: m[1].toLowerCase(), ref: m[2] });
  }
  return out;
}

// 단일어 엔티티명 오탐 차단(DESIGN §7: 억지 매핑 금지). 일반 영단어와 충돌하는 엔티티명은
// 평문(특히 pre-pivot Notion 문서)에서 상시 등장해 confidence 0.7 의 가짜 도메인 매핑을 양산한다.
// 'Product Hunt'/'Google Product Category'/코드주석 예시목록의 'Product' 등 — 추천도메인 Product 엔티티 참조가 아님.
// 이런 단일어 일반명은 D3(rule)에서 스킵하고 D6(LLM 판단)로 미룬다. 멀티워드 PascalCase 는 고유성 충분 → 유지.
// 체크는 **대소문자 무시**(아래 _LOWER) — repo 별 vocab 케이스('Item' vs 'item')에 좌우되지 않게.
const AMBIGUOUS_ENTITY_NAMES = new Set([
  "Product", "User", "Post", "Message", "Item", "Order", "Tag", "Group", "Event",
  "Data", "Status", "Name", "Type", "Brand", "Place", "Comment", "Like", "Follow",
  "Category", "Image", "File", "Account", "Profile", "Notification", "Review",
  "Address", "Cart", "Payment", "Search", "Company", "Career", "Opinion",
]);
const AMBIGUOUS_ENTITY_NAMES_LOWER = new Set([...AMBIGUOUS_ENTITY_NAMES].map((n) => n.toLowerCase()));

// 멀티워드 PascalCase 여부 — 내부에 소문자→대문자 전이가 있으면 합성어(CampaignParticipation 등).
function isMultiWordPascal(name: string): boolean {
  return /[a-z][A-Z]/.test(name);
}

// 복합 식별자 여부 — 언더스코어/하이픈/숫자 포함('item_domain', 'lively-product-db' 등).
// 일반 영문 산문에 그대로 등장할 확률이 낮아 단일 lowercase 영단어와 달리 D3 토큰으로 충분히 고유.
function isCompoundIdentifier(name: string): boolean {
  return /[_\-0-9]/.test(name);
}

// D3 — 엔티티명(domainmap data_entity)을 \b 경계·대소문자 구분으로 단일 스캔.
// 'Campaign' 이 'CampaignParticipation' 안에서 부분일치하지 않도록 정확 토큰 매치.
// 단일 토큰 엔티티명 가드(2026-06-10 강화 — repo=productivity 오매핑 49행 사후검증 반영):
//   · 멀티워드 PascalCase('CampaignParticipation') / 복합 식별자('item_domain') → 고유성 충분, 유지
//   · 단일 PascalCase('Campaign') → 일반명 충돌(AMBIGUOUS, 대소문자 무시)만 아니면 유지
//   · 단일 lowercase 영단어('domain'·'project'·'item'·'repo' 등 snake 스키마 vocab) → **무조건 스킵**
//     (일반 영단어와 정면 충돌 — 임의 문서에서 conf 0.7 가짜 매핑 양산) → D6 LLM 판단으로 위임.
export function extractEntityTokens(text: string, entityNames: string[]): string[] {
  const t = capText(text);
  if (!t || !entityNames.length) return [];
  const matched: string[] = [];
  for (const name of entityNames) {
    if (!name || name.length < 3) continue; // 너무 짧은 이름(오탐)은 스킵
    if (!isMultiWordPascal(name) && !isCompoundIdentifier(name)) {
      // 단일 토큰: PascalCase 가 아니면(소문자 시작 = 일반 영단어 형태) rule 매치에서 제외(D6 로 위임).
      if (!/^[A-Z]/.test(name)) continue;
      // PascalCase 단일어라도 일반명과 충돌하면 제외 — 대소문자 무시 비교.
      if (AMBIGUOUS_ENTITY_NAMES_LOWER.has(name.toLowerCase())) continue;
    }
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`);
    if (re.test(t)) matched.push(name);
  }
  return matched;
}

// D3b — 도메인 slug(하이픈 key, 예 'commerce-shop')과 유의미한 name 토큰 매칭.
// key 는 하이픈 슬러그 그대로, name 은 공백 분해 후 길이>=4 토큰만(소음 방지). 매치된 domain_key 반환.
export function extractDomainSlugTokens(
  text: string,
  domainKeys: string[],
  domainNames: string[],
): string[] {
  const t = capText(text);
  if (!t) return [];
  const lower = t.toLowerCase();
  const matched = new Set<string>();
  for (const key of domainKeys) {
    if (!key) continue;
    // 슬러그는 단어경계로(주변 영숫자/하이픈이 더 붙으면 다른 토큰).
    const re = new RegExp(`(?<![a-z0-9-])${escapeRe(key.toLowerCase())}(?![a-z0-9-])`);
    if (re.test(lower)) matched.add(key);
  }
  // name 의 유의미 토큰(영문 길이>=4)도 보조 신호 — key 와 1:1 매핑이 아니므로 name 만으론 약함.
  // 여기선 key 기반 매치만 반환(name 토큰은 D6 LLM 판단으로 넘김 — 억지 매핑 방지).
  void domainNames;
  return [...matched];
}

// P1 — 프로젝트 slug(key) 매칭. 도메인과 동일 단어경계 규칙.
export function extractProjectSlugs(
  text: string,
  projectKeys: string[],
  projectNames: string[],
): string[] {
  const t = capText(text);
  if (!t) return [];
  const lower = t.toLowerCase();
  const matched = new Set<string>();
  for (const key of projectKeys) {
    if (!key) continue;
    const re = new RegExp(`(?<![a-z0-9-])${escapeRe(key.toLowerCase())}(?![a-z0-9-])`);
    if (re.test(lower)) matched.add(key);
  }
  void projectNames;
  return [...matched];
}

// D5/P4 — 본문 URL 전부 추출(중복 제거).
export function extractUrls(text: string): string[] {
  const t = capText(text);
  const out = new Set<string>();
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) out.add(m[0]);
  return [...out];
}

export interface DiscordDeepLink { guild: string; channel: string; message: string; externalId: string }

// discord.com/channels/{guild}/{channel}/{message} → externalId 'channel:message' (discord.ts toRawItem 과 동일).
export function parseDiscordDeepLink(url: string): DiscordDeepLink | null {
  const m = /discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/.exec(url);
  if (!m) return null;
  const [, guild, channel, message] = m;
  return { guild, channel, message, externalId: `${channel}:${message}` };
}

// notion.so URL 끝의 32-hex page id 추출(하이픈 포함/미포함 모두) → 정규화된 32-hex(소문자, 하이픈 제거).
export function parseNotionPageId(url: string): string | null {
  // 마지막 경로 세그먼트에서 32 hex(하이픈 옵션) 찾기.
  const m = /([0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})/.exec(url);
  if (!m) return null;
  const hex = m[1].replace(/-/g, "").toLowerCase();
  return hex.length === 32 ? hex : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
