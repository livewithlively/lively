// 경보 알림 채널(#813) — 관리자가 등록한 웹훅으로 박스 상태 경보를 **밀어서(push)** 보낸다.
//
// 왜: T5 로 가드는 넣었지만(위험하면 신규 세션·클론·업로드 차단) **그 사실을 아무도 모른다.**
//  2026-07-13 사고의 본질은 "디스크가 찼다"가 아니라 **"아무도 몰랐다"** 였다 — 사람이 로그인 실패로 발견했다.
//  /readyz·관리탭 배너는 '가서 봐야' 알고, 로그는 아무도 안 본다. **밀어야 닿는다.**
//  (지식: gateway-disk-leak-audit-2026-07-13 §L4)
//
// ⚠ 웹훅 URL 은 **시크릿**이다 — 그 URL 만 알면 누구나 그 채널에 글을 쓸 수 있다. 그래서 이 코드베이스의 시크릿 관례를 따른다:
//  ① **암호화 저장.** org_runtime_config 에 시크릿 '값'을 넣은 전례는 **0건**이다(전부 env 이름·호스트 '참조'뿐 —
//     embedding_config.auth_env_ref 주석이 그 경계를 명시한다). 시크릿은 secret-box(AES-256-GCM)로 암호화해
//     member_secret(owner=gateway)에 둔다 — org_credential 과 **동형**(스키마 변경 불요).
//     `CONNECTOR_SECRET_KEY` 미설정이면 **저장을 거부**한다(fail-closed — 평문 저장 금지).
//  ② **응답에 값을 싣지 않는다.** `configured`(boolean)만. 마스킹 문자열조차 되돌려주지 않는 게 이 레포 관례다.
//  ③ **로그·감사에 URL 을 넣지 않는다.** `redactDeep`(src/org/redact.ts)은 URL 패턴을 안 잡는다 → 스냅샷에 넣으면 그대로 샌다.
//  ④ **리다이렉트를 따라가지 않는다.** URL path 자체가 시크릿이라 리다이렉트를 타면 3자에게 넘어간다.
//     (makeSsrfFetch 는 리다이렉트를 따라가지 않는다 — 그래서 이걸 쓴다.)
//
// ⚠ 아웃바운드는 **기존 SSRF 가드를 재사용한다.** "관리자가 지정한 URL 이니 안전하다"는 이 코드베이스가 명시적으로
//  부정한다 — src/org/mcp-ssrf-fetch.ts 머리주석: "org_mcp_server.url 은 **관리자 입력(길이검증만)** → 사설/메타데이터
//  (169.254.169.254)/게이트웨이 자기자신 IP 로의 요청을 막아야 한다 … **git 이력상 외부 outbound 대상 기능마다 반복
//  하드닝된 위협**." → makeSsrfFetch(사설·메타데이터·self 차단 + IP 핀 + https 전용; 내부 host 는 운영자가 등록한
//  allowed_internal_hosts 만 면제)를 그대로 쓴다.
import { makeSsrfFetch } from "./org/mcp-ssrf-fetch.js";
import { getMemberSecret, setMemberSecret, deleteMemberSecret, GATEWAY_OWNER } from "./org/member-secret-store.js";
import { secretsEnabled } from "./org/secret-box.js";
import { getRuntimeConfig, getOrgProfile } from "./org/store.js";
import { logger } from "./log.js";
import type { BoxAlert } from "./box-watch.js";

/** member_secret 좌표 — org_credential 과 같은 테이블을 쓰되 kind 로 구분한다(스키마 변경 없음). */
export const ALERT_KIND = "alert_webhook";
export const ALERT_SCOPE = "default";

export type MinSeverity = "warn" | "critical";

/** 관리탭에 보여줄 공개 뷰 — **URL 은 절대 담지 않는다.** */
export interface AlertChannelPublic {
  configured: boolean;
  min_severity: MinSeverity;
  label: string | null;
  /** CONNECTOR_SECRET_KEY 가 없으면 저장 자체가 불가 — UI 가 미리 안내해야 한다. */
  encryption_ready: boolean;
}

function normMin(v: unknown): MinSeverity {
  return v === "critical" ? "critical" : "warn";
}

/** 문제 경보를 보낼지 — min_severity 게이트. (복구 알림 'ok' 는 여기서 판단하지 않는다 — box-watch 가 '알린 문제'에만 해제를 보낸다.) */
export function shouldSend(severity: BoxAlert["severity"], min: MinSeverity): boolean {
  if (severity === "ok") return true; // 해제 여부는 호출자가 이미 결정했다
  if (severity === "critical") return true;
  return min === "warn"; // warn 은 min 이 warn 일 때만
}

export async function loadAlertChannel(): Promise<AlertChannelPublic> {
  const ready = secretsEnabled();
  try {
    const row = await getMemberSecret(GATEWAY_OWNER, ALERT_KIND, ALERT_SCOPE);
    const meta = (row?.meta ?? {}) as Record<string, unknown>;
    return {
      configured: !!row?.secret,
      min_severity: normMin(meta.min_severity),
      label: typeof meta.label === "string" ? meta.label : null,
      encryption_ready: ready,
    };
  } catch (err) {
    logger.warn({ err }, "경보 채널 설정 조회 실패");
    return { configured: false, min_severity: "warn", label: null, encryption_ready: ready };
  }
}

/**
 * 웹훅 등록/변경. url 이 빈 값이면 **미변경**(setMemberSecret 관례 — 실수로 비우기 방지, 삭제는 removeAlertChannel).
 * ⚠ url 을 로그·감사에 남기지 않는다(시크릿).
 */
export async function saveAlertChannel(
  input: { url?: string | null; min_severity?: unknown; label?: string | null },
  actor: string,
): Promise<AlertChannelPublic> {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url) {
    if (!secretsEnabled()) {
      throw new Error("시크릿 암호화 키(CONNECTOR_SECRET_KEY) 미설정 — 웹훅을 저장할 수 없습니다");
    }
    // 형식 검증만 여기서(연결 가능성은 [테스트 전송]이 확인). https 강제는 전송 시 SSRF 가드가 한다.
    let u: URL;
    try { u = new URL(url); } catch { throw new Error("웹훅 주소 형식이 올바르지 않습니다(전체 URL 을 넣으세요)"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("웹훅 주소는 http(s) 여야 합니다");
  }
  const prev = await loadAlertChannel();
  await setMemberSecret(
    GATEWAY_OWNER, ALERT_KIND, ALERT_SCOPE,
    {
      secret: url || null, // 빈 값 = 미변경(기존 암호문 유지)
      meta: {
        min_severity: normMin(input.min_severity ?? prev.min_severity),
        label: typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 100) : prev.label,
      },
      label: null,
    },
    actor,
  );
  return loadAlertChannel();
}

export async function removeAlertChannel(): Promise<boolean> {
  return deleteMemberSecret(GATEWAY_OWNER, ALERT_KIND, ALERT_SCOPE);
}

// 슬랙 incoming webhook 은 {text}, 디스코드는 {content} 를 읽는다. 둘 다 담으면 서로 상대 필드를 무시하므로
//  **슬랙·디스코드·범용 웹훅을 한 페이로드로** 커버한다(채널마다 코드를 나누지 않는다).
export function alertPayload(a: BoxAlert): Record<string, unknown> {
  const icon = a.severity === "critical" ? "🔴" : a.severity === "warn" ? "🟡" : "🟢";
  const line = `${icon} ${a.title}\n${a.text}`;
  return { text: line, content: line, severity: a.severity, title: a.title, detail: a.detail };
}

export interface SendResult { sent: boolean; reason?: string }

/**
 * 경보 전송. **throw 하지 않는다** — 알림 실패가 게이트웨이를 죽이거나 감시 루프를 끊으면 안 된다.
 * 미설정이면 조용히 no-op(sent=false).
 */
export async function sendBoxAlert(a: BoxAlert): Promise<SendResult> {
  let url: string;
  let min: MinSeverity;
  try {
    const row = await getMemberSecret(GATEWAY_OWNER, ALERT_KIND, ALERT_SCOPE);
    if (!row?.secret) return { sent: false, reason: "웹훅 미설정" };
    url = row.secret;
    min = normMin((row.meta as Record<string, unknown>)?.min_severity);
  } catch (err) {
    logger.warn({ err }, "경보 웹훅 조회 실패(복호화 키 문제일 수 있음)");
    return { sent: false, reason: "웹훅 설정을 읽지 못했습니다" };
  }
  if (!shouldSend(a.severity, min)) return { sent: false, reason: "임계 미만(min_severity)" };
  return postWebhook(url, alertPayload(a));
}

/**
 * 테스트 전송 — **min_severity 게이트를 우회해 무조건 보낸다.**
 * 저장만 하고 안 보내보면 정작 장애 때 안 온다(오타·만료·권한). 설정이 실제로 닿는지 확인하는 유일한 방법이다.
 */
export async function sendTestAlert(a: BoxAlert): Promise<SendResult> {
  let url: string;
  try {
    const row = await getMemberSecret(GATEWAY_OWNER, ALERT_KIND, ALERT_SCOPE);
    if (!row?.secret) return { sent: false, reason: "웹훅 미설정" };
    url = row.secret;
  } catch {
    return { sent: false, reason: "웹훅 설정을 읽지 못했습니다(암호화 키 확인)" };
  }
  return postWebhook(url, alertPayload(a));
}

/** 웹훅 POST — SSRF 가드 경유. ⚠ url 을 에러·로그에 절대 넣지 않는다(시크릿). */
export async function postWebhook(url: string, payload: Record<string, unknown>): Promise<SendResult> {
  try {
    const cfg = await getRuntimeConfig().catch(() => null);
    const selfHosts: string[] = [];
    try {
      const p = await getOrgProfile();
      if (p.gateway_url) selfHosts.push(new URL(p.gateway_url).hostname.toLowerCase());
    } catch { /* 프로필 없음 — selfHosts 비움(mcp-proxy 와 동일 관례) */ }

    const fetchFn = makeSsrfFetch({
      allowedInternalHosts: cfg?.allowed_internal_hosts ?? [], // 내부 웹훅 수신기는 운영자가 명시 등록해야 통과
      selfHosts,                                               // confused-deputy 차단
      timeoutMs: 8000,
      maxBytes: 64 * 1024,                                     // 웹훅 응답은 작다
    });
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual", // ⚠ URL 자체가 시크릿 — 리다이렉트를 타면 3자에게 넘어간다
    });
    if (res.status >= 200 && res.status < 300) return { sent: true };
    // 응답 본문을 그대로 노출하지 않는다(웹훅이 URL 을 에코할 수 있다). 상태코드만.
    return { sent: false, reason: `웹훅이 ${res.status} 를 반환했습니다` };
  } catch (err) {
    // ⚠ 로그에 URL 을 넣지 않는다(시크릿). SsrfError 메시지는 host 만 담고 path 는 안 담으므로 reason 으로는 안전하다.
    logger.warn({ kind: err instanceof Error ? err.name : "unknown" }, "경보 웹훅 전송 실패");
    const msg = err instanceof Error ? err.message : String(err);
    return { sent: false, reason: webhookReason(msg) };
  }
}

// SSRF 가드는 MCP 프록시와 공유하는 코드라 메시지가 그 맥락으로 쓰여 있다("원격 MCP 는 https 전용" 등).
//  웹훅을 설정하는 관리자에겐 무슨 소린지 모를 말이므로, **이 화면의 말로 번역**한다. 원인은 그대로 보존.
export function webhookReason(msg: string): string {
  if (/허용되지 않은 scheme/.test(msg)) {
    return "웹훅 주소는 https 여야 합니다 (사내 http 주소를 쓰려면 관리 ▸ AI 도구의 '허용 내부 host'에 그 호스트를 먼저 등록하세요).";
  }
  if (/차단된 host|사설|메타데이터/.test(msg)) {
    return `${msg} — 사내/사설망 주소는 관리 ▸ AI 도구의 '허용 내부 host'에 등록해야 보낼 수 있습니다.`;
  }
  if (/자기 자신|confused-deputy/.test(msg)) {
    return "게이트웨이 자기 자신을 웹훅 대상으로 지정할 수 없습니다.";
  }
  if (/잘못된 URL/.test(msg)) return "웹훅 주소 형식이 올바르지 않습니다.";
  // 그 밖(DNS·타임아웃·TLS)은 원문을 그대로 주지 않는다 — URL 이 섞여 나올 여지를 남기지 않는다.
  return "웹훅에 연결하지 못했습니다 (주소·네트워크를 확인하세요).";
}
