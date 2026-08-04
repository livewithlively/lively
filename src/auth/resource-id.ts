// 이 게이트웨이의 **자원 식별자(RFC 8707 resource / audience)** 단일 소스 (#1473 T2).
//  MCP 사양(2025-11-25)은 자원서버가 "자기 앞으로 발급된 토큰만 수락"할 것을 MUST 로 요구한다(패스스루 금지).
//  그 판정 기준이 되는 문자열을 여기서만 만든다 — 공개 base 자체는 gateway-url.ts 가 권위(#1438 불변식).
//
//  왜 두 값(base·mcp)을 다 인정하나: 자원 식별자는 우리가 PRM 으로 광고하는 `<base>/mcp` 가 정본이지만,
//  클라이언트 구현이 PRM 의 resource 대신 '서버 origin'을 resource 로 보내는 사례가 흔하다(RFC 8707 은
//  값의 형태만 규정하고 어디서 얻는지는 클라 자유). 둘 다 **우리 게이트웨이를 가리키는 같은 대상**이므로
//  수락한다. 그 외(=남의 서버 앞으로 발급된 토큰)는 거부 — 이게 이 모듈이 막으려는 것이다.
//
//  ⚠ 캐시: 인증 핫패스에서 호출되므로 org 프로필 조회를 60초 메모한다. 게이트웨이 주소가 바뀌는 건
//   운영 이벤트(재배포·프로필 수정)라 60초 지연은 무해하다.
import { gatewayUrl } from "../gateway-url.js";

const TTL_MS = 60_000;
let memo: { at: number; ids: ResourceIds | null } | null = null;

export interface ResourceIds {
  base: string; // 예: https://dev.lvly.io
  mcp: string;  // 예: https://dev.lvly.io/mcp  ← PRM 이 광고하는 정본 자원 식별자
}

// 비교·저장용 정규화 — fragment 제거(RFC 8707: resource 는 fragment 를 가질 수 없다) + 말미 슬래시 제거.
//  대소문자는 건드리지 않는다(경로는 대소문자 유의). 파싱 불가면 원문 trim 을 돌려준다(비교에서 자연히 탈락).
export function normalizeResource(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    const href = u.href;
    return href.endsWith("/") ? href.slice(0, -1) : href;
  } catch {
    return s.replace(/\/+$/, "");
  }
}

export async function resourceIds(): Promise<ResourceIds | null> {
  const now = Date.now();
  if (memo && now - memo.at < TTL_MS) return memo.ids;
  const base = await gatewayUrl();
  const ids = base ? { base: normalizeResource(base), mcp: normalizeResource(`${base}/mcp`) } : null;
  memo = { at: now, ids };
  return ids;
}

// 테스트·주소 변경 직후용. 운영 코드가 부르지 않는다(캐시가 스스로 만료).
export function resetResourceIdCache(): void {
  memo = null;
}

// 토큰에 박힌 resource 가 '우리 앞으로 발급된 것'인가.
//  · 인자가 비면 true — 대상 미지정 토큰(레거시 lvk_ 등)은 audience 제약이 없다(무회귀).
//  · 공개 base 를 못 정하면 true — 판정 근거가 없는데 거부하면 미설정 셀프호스트가 통째로 잠긴다.
//    (그 환경은 애초에 OAuth 를 못 켠다 — mcpAuthRouter 가 issuer 없이는 안 뜬다.)
export async function isOwnResource(raw: string | null | undefined): Promise<boolean> {
  if (!raw) return true;
  const ids = await resourceIds();
  if (!ids) return true;
  const got = normalizeResource(raw);
  return got === ids.mcp || got === ids.base;
}
