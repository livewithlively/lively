// 세션 사용량(rate-limit 소진율) 라이브 스토어 — 계정 단위 in-memory.
//  Claude 구독 rate limit(5시간·7일)은 **세션이 아니라 계정(로그인) 단위 quota**다 — 같은 계정의 모든 세션이
//  같은 창을 공유한다. 그래서 세션(box-id)이 아니라 account 로 키잉한다(상시세션 목록이 account 로 조인).
//  statusLine 훅(kit/hooks/usage-report.mjs)이 그 세션 안에서만 얻을 수 있는 rate_limits 를 POST /usage 로 보고하고,
//  관리탭 상시세션 목록이 여기서 읽어 컬럼으로 보여준다. 게이트웨이가 rate_limits 를 얻는 유일 경로다(hook stdin 엔 없음).
// ponytail: 라이브 텔레메트리라 영속 불필요 — 재기동/blue-green flip 후 30초(훅 스로틀) 안에 다시 채워진다.
//  사용량 히스토리·다중 인스턴스 집계가 필요해지면 그때 테이블로 승격.
// resets_at = 창이 리셋되는 **Unix epoch 초**(Claude Code statusLine 계약 — ms 아님). 프론트가 *1000 으로 Date 화.
export interface UsageWindow { used_percentage: number; resets_at: number | null }
export interface AccountUsage { five_hour?: UsageWindow; seven_day?: UsageWindow; at: number }

const byAccount = new Map<string, AccountUsage>();

// 오래된 보고는 신선하지 않다 — 세션이 죽으면 statusLine 도 멈춰 값이 굳는다. TTL 지난 값은 '모름'으로 취급.
const TTL_MS = 15 * 60 * 1000;

function normWindow(w: unknown): UsageWindow | undefined {
  if (!w || typeof w !== "object") return undefined;
  const pct = (w as Record<string, unknown>).used_percentage;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return undefined; // 각 창은 독립적으로 부재 가능(문서)
  const r = (w as Record<string, unknown>).resets_at;
  return { used_percentage: Math.max(0, Math.min(100, pct)), resets_at: typeof r === "number" ? r : null };
}

/**
 * statusLine 훅이 보고한 rate_limits 를 계정 단위로 기록(last-write-wins). 유효 창이 하나도 없으면 무기록.
 * ⚠ account 는 **토큰 principal id**(routes 의 idOf(userOf(req)))다 — 상시세션은 asUser(account) 로 그 id 를 그대로
 *  userId 로 삼아 스폰되므로, 이 키가 managed_session_list 의 `m.account` 와 같은 값 공간이라야 조인이 맞는다.
 *  둘이 어긋나면 pill 이 영영 '미보고'(silent miss) — 상시세션 account 설정 오류의 신호다.
 */
export function recordUsage(account: string, rateLimits: unknown, nowMs = Date.now()): boolean {
  if (!account) return false;
  const rl = (rateLimits && typeof rateLimits === "object") ? rateLimits as Record<string, unknown> : {};
  const five = normWindow(rl.five_hour);
  const seven = normWindow(rl.seven_day);
  if (!five && !seven) return false;
  // 부재 창은 키 자체를 넣지 않는다(undefined 값으로 남기지 않음) — 소비자가 `key in obj`·deepEqual 로 '없음'을
  //  깔끔히 구분하게. 각 창은 독립 부재 가능(rate_limits 도메인).
  const u: AccountUsage = { at: nowMs };
  if (five) u.five_hour = five;
  if (seven) u.seven_day = seven;
  byAccount.set(account, u);
  return true;
}

/** 계정의 최신 사용량 — 없거나 TTL 지났으면 null(모름). */
export function getUsage(account: string | null | undefined, nowMs = Date.now()): AccountUsage | null {
  if (!account) return null;
  const u = byAccount.get(account);
  if (!u || nowMs - u.at > TTL_MS) return null;
  return u;
}
