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
//  allowedHosts: 운영자가 런타임설정(allowed_db_hosts)에 명시한 host 는 SSRF 검사 면제(내부/localhost DB 허용).
//   브라우저 임의입력은 화이트리스트 밖이면 여전히 차단 — 운영자만 admin 으로 host 를 등록할 수 있다.
export async function isHostBlocked(host: string, allowedHosts: string[] = []): Promise<boolean> {
  if (allowedHosts.includes(host.toLowerCase())) return false; // 운영자 명시 허용 — SSRF 검사 면제
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

// ── mysql 접속 URL 검사(#715) — pg 와 달리 쿼리파라미터 스머글링 표면이 없도록 엄격 화이트리스트. ──
//  형식: mysql://user@host[:port]/database[?ssl=require] — 비번 인라인 금지(auth_ref), database(스키마) 필수
//  (게이트웨이가 소스를 그 스키마로 고정 — firewall 크로스-스키마 거부·db_schema DATABASE() 필터의 전제).
//  파라미터는 ssl 하나만 허용(그 외 전부 거부 — mysql2 옵션 주입 차단). 순수 함수(단위테스트).
export interface MysqlUrlInspect {
  ok: boolean;
  error?: string;
  hasPassword?: boolean;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  ssl?: boolean;
}

export function inspectMysqlUrl(url: string): MysqlUrlInspect {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "URL 형식이 아닙니다" };
  }
  if (u.protocol !== "mysql:") return { ok: false, error: "mysql:// 스킴이어야 합니다" };
  if (!u.hostname) return { ok: false, error: "host 가 없습니다" };
  if (u.password) return { ok: false, error: "url 에 비밀번호를 넣지 마세요 — auth_ref(환경변수 이름)로 참조하세요", hasPassword: true };
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) {
    return { ok: false, error: "database(스키마) 필수 — mysql://user@host:3306/dbname 형식" };
  }
  let ssl = false;
  for (const [k, v] of u.searchParams) {
    if (k !== "ssl") return { ok: false, error: `허용되지 않은 url 파라미터: ${k} (ssl 만 허용)` };
    if (!["1", "true", "require"].includes(v.toLowerCase())) return { ok: false, error: "ssl 파라미터는 1|true|require 만" };
    ssl = true;
  }
  const port = u.port ? Number(u.port) : 3306;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: "port 가 올바르지 않습니다" };
  return {
    ok: true,
    host: u.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    database,
    ssl,
  };
}

// host 를 검증된 공인 IP '하나'로 핀해 반환(DB 소스 connect 대상으로 고정). DNS 리바인딩·멀티앤서 우회 차단:
//  도메인의 A 레코드 중 하나라도 사설/메타데이터면 거부(every public 일 때만 통과), 통과하면 그 공인 IP 로 고정.
//  pg 는 이 IP 로 직접 connect(재resolve 없음)하고, TLS 는 원래 호스트명을 servername 으로 검증한다(resolveConnectionString).
//  allowedHosts: 운영자 명시 허용 host 는 사설/loopback 도 핀 허용(localhost 내부 DB 접속용). IP 리터럴은 그대로,
//   도메인(localhost 등)은 resolve 후 첫 IP 로 핀(DNS 리바인딩 차단은 유지하되 사설 거부만 면제).
export async function pinHost(host: string, allowedHosts: string[] = []): Promise<string> {
  const allowed = allowedHosts.includes(host.toLowerCase()); // 운영자 명시 허용 — 사설/메타데이터 거부 면제
  if (net.isIP(host)) {
    if (!allowed && isBlockedIp(host)) throw new Error(`차단된 host(사설/메타데이터 IP): ${host}`);
    return host;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`host resolve 실패: ${host}`);
  }
  if (!addrs.length) throw new Error(`host resolve 결과 없음: ${host}`);
  if (!allowed && addrs.some((a) => isBlockedIp(a.address))) throw new Error(`차단된 host(일부 응답이 사설/메타데이터 IP): ${host}`);
  return addrs[0].address; // 검증된(또는 운영자 허용) IP 로 핀
}
