// DB 소스 보안 가드 — SSRF(외부 host 직접 TCP 연결) + 시크릿 참조 화이트리스트.
//  db_query/db_schema 는 등록된 소스 host 로 게이트웨이가 직접 pg 연결하므로 http_proxy 와 동일한 outbound
//  표면이다. → 사설/메타데이터 IP 차단(org/ssrf.ts isBlockedIp 재사용) + 비번 등 시크릿 참조는 운영자
//  화이트리스트(allowed_db_secret_refs)로 제한(인프라 시크릿 DATABASE_URL 등 차단).
//  ★ 검증과 접속을 같은 파서로 일치: new URL 은 ?host=/?password= 같은 pg 쿼리파라미터를 못 봐서, pg 가
//    실제 붙는 host/비번을 놓친다(SSRF·시크릿 우회). 그래서 pg-connection-string.parse() 로 검사한다.
import dns from "node:dns/promises";
import net from "node:net";
import { parse } from "pg-connection-string";
import { isBlockedIp } from "../org/ssrf.js";

export interface ConnInspect {
  host: string | null;
  hasPassword: boolean;
  hasHostAddr: boolean;
}

// pg 가 실제 쓸 접속 파라미터(쿼리파라미터 host/hostaddr/password 반영). 파싱 불가 = 보수적 빈 결과.
export function inspectConnString(url: string): ConnInspect {
  let cfg: Record<string, unknown>;
  try {
    cfg = parse(url) as unknown as Record<string, unknown>;
  } catch {
    return { host: null, hasPassword: false, hasHostAddr: false };
  }
  const rawHost = cfg.host;
  const host = typeof rawHost === "string" && rawHost.trim() !== "" ? rawHost.replace(/^\[|\]$/g, "").toLowerCase() : null;
  return {
    host,
    hasPassword: typeof cfg.password === "string" && cfg.password !== "",
    hasHostAddr: typeof cfg.hostaddr === "string" && (cfg.hostaddr as string).trim() !== "",
  };
}

// pg 접속문자열에서 host 추출(pg 실제 사용 host — UI 표시와 실제 접속이 일치). 없으면 null.
export function hostOfUrl(url: string): string | null {
  return inspectConnString(url).host;
}

// host 가 사설/메타데이터 대역인지(SSRF). IP 리터럴은 즉시, 도메인은 resolve 후.
//  멀티앤서: A 레코드 중 '하나라도' 사설이면 차단(pg 기본 lookup 이 사설 응답을 고를 수 있어 fail-closed).
//  resolve 실패/결과 없음 = true(fail-closed).
export async function isHostBlocked(host: string): Promise<boolean> {
  if (net.isIP(host)) return isBlockedIp(host);
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return true;
  }
  if (!addrs.length) return true;
  return addrs.some((a) => isBlockedIp(a.address)); // 하나라도 사설/메타데이터면 차단
}

// 시크릿 참조(auth_ref=env 이름)가 운영자 화이트리스트에 있는지. deny-all 기본.
export function isSecretRefAllowed(ref: string, allowed: string[]): boolean {
  return allowed.includes(ref);
}

// host 를 검증된 공인 IP '하나'로 핀해 반환(DB 소스 connect 대상으로 고정). DNS 리바인딩·멀티앤서 우회 차단:
//  도메인의 A 레코드 중 하나라도 사설/메타데이터면 거부(every public 일 때만 통과), 통과하면 그 공인 IP 로 고정.
//  pg 는 이 IP 로 직접 connect(재resolve 없음)하고, TLS 는 원래 호스트명을 servername 으로 검증한다(resolveConnectionString).
export async function pinHost(host: string): Promise<string> {
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`차단된 host(사설/메타데이터 IP): ${host}`);
    return host;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`host resolve 실패: ${host}`);
  }
  if (!addrs.length) throw new Error(`host resolve 결과 없음: ${host}`);
  if (addrs.some((a) => isBlockedIp(a.address))) throw new Error(`차단된 host(일부 응답이 사설/메타데이터 IP): ${host}`);
  return addrs[0].address; // 검증된 공인 IP 로 핀
}
