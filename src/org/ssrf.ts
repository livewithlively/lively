// SSRF-안전 HTTP 클라이언트 (B13~B17, B24) — http_proxy 툴이 외부 API 를 호출할 때만 쓴다.
//  핵심: 호스트를 1회 resolve→공인 IP 만 통과→그 IP 로 connect 고정(node http.request 의 lookup 옵션).
//   → "검증 후 fetch" 의 2차 DNS 조회(rebinding)가 불가능. 모든 가드는 fail-CLOSED(불확실하면 차단).
//  의존성 무추가: node:https/http 의 lookup 옵션이 undici Agent.connect.lookup 과 동일한 IP-pin 을 제공.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

export class SsrfError extends Error {}

export interface SafeFetchResult { status: number; headers: Record<string, string>; body: string; truncated: boolean; }
export interface SafeFetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  allowlist: string[];   // 허용 호스트(소문자). 비면 deny-all.
  selfHosts?: string[];  // 게이트웨이 자기 자신(차단 — confused-deputy 방지)
  maxBytes?: number;     // 기본 256KiB
  timeoutMs?: number;    // 기본 8s
  allowHttp?: boolean;   // 기본 false(https 전용)
  maxRedirects?: number; // 기본 2
}

// private/loopback/link-local/CGNAT/메타데이터/멀티캐스트 대역 차단. v4-mapped/6to4/Teredo IPv6 는 내부 v4 로 재검증.
export function isBlockedIp(ip: string): boolean {
  const addr = (ip || "").replace(/^\[|\]$/g, ""); // IPv6 리터럴 대괄호 제거
  const fam = net.isIP(addr);
  if (fam === 4) {
    const o = addr.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
    if (o[0] === 169 && o[1] === 254) return true;                 // link-local + 169.254.169.254 메타데이터
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;    // CGNAT
    if (o[0] >= 224) return true;                                   // multicast/reserved
    return false;
  }
  if (fam === 6) {
    const x = addr.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("fc") || x.startsWith("fd")) return true;      // fc00::/7 ULA
    if (/^fe[89ab]/.test(x)) return true;                           // fe80::/10 link-local
    if (x.startsWith("ff")) return true;                            // ff00::/8 multicast
    if (x.startsWith("2002:")) return true;                         // 6to4(임베드 v4 → 보수적 전체 차단)
    if (/^2001:0{1,4}:/.test(x) || x === "2001::" || x.startsWith("2001::")) return true; // Teredo 2001:0000::/32
    if (x.startsWith("64:ff9b")) return true;                       // NAT64
    // 임베드 v4(점표기, 압축/전개 무관: …:127.0.0.1) → 내부 v4 검증
    const dotted = x.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
    if (dotted) return net.isIP(dotted[1]) === 4 ? isBlockedIp(dotted[1]) : true;
    // v4-mapped 16진 형(…:ffff:7f00:1) → 마지막 32비트 디코드 검증, 불명확하면 보수적 차단
    if (x.includes(":ffff:")) {
      const seg = x.split(":").filter(Boolean);
      const i = seg.lastIndexOf("ffff");
      if (i >= 0 && seg.length - i === 3) {
        const hi = parseInt(seg[i + 1], 16), lo = parseInt(seg[i + 2], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
          if (net.isIP(v4) === 4) return isBlockedIp(v4);
        }
      }
      return true;
    }
    return false;
  }
  return true; // IP 가 아니면 차단(우리는 검증된 IP 로만 connect)
}

// 호스트명을 resolve 해 공인 IP 1개만 골라 connect 대상으로 고정한다(rebinding 차단).
//  node 20+ autoSelectFamily 는 lookup 을 all:true 로 호출 → 콜백은 [{address,family}] 배열을 기대.
//  all:false 면 (err,address,family) 단일 형. 둘 다 지원해야 http_proxy 가 실제로 연결된다(콜백 계약 준수).
function pinnedLookup(hostname: string, options: { all?: boolean } | undefined, cb: (...args: unknown[]) => void): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs as { address: string; family: number }[]).find((a) => !isBlockedIp(a.address));
    if (!ok) return cb(new SsrfError(`차단된 호스트(사설/메타데이터 IP): ${hostname}`));
    if (options && options.all) cb(null, [{ address: ok.address, family: ok.family }]);
    else cb(null, ok.address, ok.family);
  });
}

function hostAllowed(hostname: string, allowlist: string[]): boolean {
  const h = hostname.toLowerCase();
  return allowlist.some((raw) => {
    const e = raw.toLowerCase().trim();
    if (!e) return false;
    if (e.startsWith(".")) return h === e.slice(1) || h.endsWith(e); // ".example.com" = 서브도메인 허용
    return h === e;
  });
}

function once(url: string, opts: SafeFetchOpts, redirectsLeft: number): Promise<SafeFetchResult> {
  return new Promise<SafeFetchResult>((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new SsrfError(`잘못된 URL: ${url}`)); }
    const scheme = u.protocol;
    if (scheme !== "https:" && !(opts.allowHttp && scheme === "http:")) {
      return reject(new SsrfError(`허용되지 않은 scheme: ${scheme} (https 전용)`));
    }
    const host = u.hostname.toLowerCase();
    if (opts.selfHosts?.some((s) => s.toLowerCase() === host)) return reject(new SsrfError(`게이트웨이 자기 자신 호출 금지: ${host}`));
    if (!hostAllowed(host, opts.allowlist)) return reject(new SsrfError(`허용 목록(url_allowlist)에 없는 호스트: ${host}`));
    const hostBare = host.replace(/^\[|\]$/g, ""); // IPv6 리터럴은 hostname 에 대괄호 포함 → 제거 후 isIP 검사
    if (net.isIP(hostBare) && isBlockedIp(hostBare)) return reject(new SsrfError(`차단된 IP: ${host}`));

    const max = opts.maxBytes ?? 256 * 1024;
    const timeoutMs = opts.timeoutMs ?? 8000;
    const lib = scheme === "https:" ? https : http;
    let done = false;
    const finish = (r: SafeFetchResult): void => { if (!done) { done = true; resolve(r); } };
    const fail = (e: Error): void => { if (!done) { done = true; reject(e); } };

    const req = lib.request(u, { method: (opts.method || "GET").toUpperCase(), headers: opts.headers, lookup: pinnedLookup as unknown as undefined, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      // 리디렉트 수동 처리(B14): 자동 추적 금지 — Location 재검증 후 cross-origin 이면 Authorization 드롭.
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return fail(new SsrfError("리디렉트 횟수 초과"));
        let loc: string;
        try { loc = new URL(res.headers.location, u).toString(); } catch { return fail(new SsrfError("잘못된 리디렉트 Location")); }
        const nextHeaders = { ...(opts.headers ?? {}) };
        if (new URL(loc).hostname.toLowerCase() !== host) { delete nextHeaders.Authorization; delete nextHeaders.authorization; }
        once(loc, { ...opts, headers: nextHeaders }, redirectsLeft - 1).then(finish, fail);
        return;
      }
      const clen = Number(res.headers["content-length"] ?? "");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (k.toLowerCase() === "set-cookie" || k.toLowerCase() === "authorization") continue; // 응답 시크릿 미반환
        headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      }
      if (Number.isFinite(clen) && clen > max) { res.destroy(); req.destroy(); return finish({ status, headers, body: "", truncated: true }); }
      const chunks: Buffer[] = [];
      let len = 0;
      res.on("data", (c: Buffer) => {
        if (done) return;
        len += c.length;
        if (len > max) { chunks.push(c); res.destroy(); req.destroy(); finish({ status, headers, body: Buffer.concat(chunks).toString("utf8").slice(0, max), truncated: true }); return; }
        chunks.push(c);
      });
      res.on("end", () => finish({ status, headers, body: Buffer.concat(chunks).toString("utf8"), truncated: false }));
      res.on("error", fail);
    });
    req.on("timeout", () => req.destroy(new SsrfError("요청 타임아웃")));
    req.on("error", (e) => fail(e instanceof SsrfError ? e : new SsrfError(`네트워크 오류: ${e.message}`)));
    const deadline = setTimeout(() => req.destroy(new SsrfError("요청 데드라인 초과")), timeoutMs + 5000);
    req.on("close", () => clearTimeout(deadline));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export async function safeFetch(url: string, opts: SafeFetchOpts): Promise<SafeFetchResult> {
  return once(url, opts, opts.maxRedirects ?? 2);
}
