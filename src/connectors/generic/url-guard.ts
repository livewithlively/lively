// 범용 수집기 URL 안전 검사(#1419 T2) — SSRF 기본 차단선. HTTP·RSS 드라이버가 **공유**한다.
//
//  왜 필요한가: 범용 수집기는 관리자가 준 URL 로 **게이트웨이가 직접 나간다**. 게이트웨이는 사내망 안이고,
//   클라우드에선 메타데이터 엔드포인트(169.254.169.254)에 닿는다 — URL 한 줄로 인스턴스 자격증명을 긁어올 수
//   있는 자리다. admin 전용이라 해도 오타·복붙 한 번의 반경이 너무 크므로 기본은 막고, 여는 것을 명시하게 한다.
//
//  ⚠ 한계(정직하게): 검사 시점과 실제 연결 시점 사이에 DNS 가 다시 해석될 수 있다(rebinding). 완전한 방어는
//   소켓 수준에서 연결 직전 IP 를 보는 것인데, fetch 로는 그 지점을 잡을 수 없다. 남는 위험은
//   '관리자가 준 주소'라는 전제로 감수하고, 기본 차단 + 명시적 옵트인으로 사고 반경을 줄이는 데 집중한다.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** 사설·루프백·링크로컬·CGNAT 판정. 못 읽는 형식은 보수적으로 '차단'으로 본다. */
export function isPrivateAddr(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true;  // ULA
    if (v.startsWith("fe80")) return true;                       // 링크로컬
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);          // IPv4-mapped → v4 규칙 재적용
    if (m) return isPrivateAddr(m[1]);
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;              // 클라우드 메타데이터 — 가장 위험한 하나
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  return false;
}

/**
 * URL 검사 후 정규화된 문자열을 돌려준다. allowPrivate=true 면 대역 검사를 건너뛴다
 * (사내 API 를 일부러 붙이는 경우 — 화면에서 명시적으로 켠 것).
 */
export async function assertUrlAllowed(raw: string, allowPrivate: boolean): Promise<string> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`URL 형식이 아닙니다: ${String(raw).slice(0, 120)}`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`http(s) 만 허용합니다: ${u.protocol}`);
  if (allowPrivate) return u.toString();

  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs: string[] = [];
  if (isIP(host)) addrs.push(host);
  else {
    try {
      const res = await lookup(host, { all: true });
      addrs.push(...res.map((r) => r.address));
    } catch { throw new Error(`호스트를 찾을 수 없습니다: ${host}`); }
  }
  if (!addrs.length) throw new Error(`호스트를 찾을 수 없습니다: ${host}`);
  const bad = addrs.find((a) => isPrivateAddr(a));
  if (bad) {
    throw new Error(
      `사설·내부 주소(${bad})로는 기본 차단됩니다. 사내 API·피드를 붙이려면 이 수집기의 '사내망 접근 허용'을 켜세요 — ` +
      "그 스위치는 SSRF 차단선을 여는 것이라 신뢰하는 주소에만 쓰세요.");
  }
  return u.toString();
}

/** RSS 드라이버용 별칭 — 같은 판정을 쓴다(차단선이 드라이버마다 다르면 그게 곧 구멍이다). */
export const assertRssUrlAllowed = assertUrlAllowed;
