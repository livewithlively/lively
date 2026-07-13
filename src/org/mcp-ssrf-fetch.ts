// SSRF-안전 FetchLike (#746 T1 리뷰) — StreamableHTTPClientTransport 가 상류 remote MCP 에 붙을 때 쓰는 fetch.
//  위협: org_mcp_server.url 은 관리자 입력(길이검증만) → 사설/메타데이터(169.254.169.254)/게이트웨이 자기자신 IP 로의
//   크리덴셜 주입 요청을 막아야 한다(http_proxy 의 safeFetch 와 동급). git 이력상 외부 outbound 대상 기능마다 반복 하드닝된 위협.
//  구현: node v22 global fetch=undici 지만 undici Agent(dispatcher) 미가용(패키지 없음) → node:https 로 직접 요청.
//   pinHost 로 host 를 '검증된 IP 하나'에 고정 connect(DNS 리바인딩 차단) + servername=원래 호스트로 TLS 신원검증 유지.
//   응답은 Readable.toWeb 로 웹 스트림 Response 로 감싸 SSE(text/event-stream) 스트리밍을 보존한다.
//  내부(사설/localhost) MCP 서버는 운영자가 allowed_internal_hosts(런타임설정)에 명시한 host 만 허용 — allowed_db_hosts 와 동형.
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { pinHost } from "../db/source-guard.js";
import { SsrfError } from "./ssrf.js";

export interface SsrfFetchOpts {
  allowedInternalHosts?: string[]; // 운영자 명시 허용(사설/loopback MCP 서버). 비면 사설/메타데이터 전부 차단(fail-closed).
  selfHosts?: string[];            // 게이트웨이 자기자신 host(confused-deputy 차단).
  timeoutMs?: number;              // 기본 15s.
}

// HeadersInit(Headers | [k,v][] | Record) → 소문자 키 Record. host/content-length 는 우리가 직접 관리하므로 제거.
function normHeaders(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string): void => {
    const key = k.toLowerCase();
    if (key === "host" || key === "content-length") return; // 우리가 pinnedIp/write 로 결정 — 상류엔 원래 host 헤더만.
    out[key] = v;
  };
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && !Array.isArray(h)) {
    (h as Headers).forEach((v, k) => put(k, v));
  } else if (Array.isArray(h)) {
    for (const pair of h as [string, string][]) if (pair && pair.length >= 2) put(String(pair[0]), String(pair[1]));
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) if (v != null) put(k, String(v));
  }
  return out;
}

// 널바디 상태(Response 생성자가 body 를 금지) — 스트림을 붙이면 throw 하므로 null 로.
const NULL_BODY = new Set([101, 204, 205, 304]);

export function makeSsrfFetch(opts: SsrfFetchOpts): FetchLike {
  const allowedInternal = (opts.allowedInternalHosts ?? []).map((s) => s.toLowerCase());
  const selfHosts = (opts.selfHosts ?? []).map((s) => s.toLowerCase());
  const timeoutMs = opts.timeoutMs ?? 15000;
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let url: URL;
    try { url = input instanceof URL ? input : new URL(String(input)); }
    catch { throw new SsrfError(`잘못된 URL: ${String(input)}`); }
    const scheme = url.protocol;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isInternalAllowed = allowedInternal.includes(host);
    // scheme: 원격은 https 전용. 내부 http 는 운영자 명시 허용 host 만(평문 위험을 운영자가 수용).
    if (scheme !== "https:" && !(scheme === "http:" && isInternalAllowed)) {
      throw new SsrfError(`허용되지 않은 scheme: ${scheme} — 원격 MCP 는 https 전용(내부 http 는 allowed_internal_hosts 등록 필요)`);
    }
    if (selfHosts.includes(host)) throw new SsrfError(`게이트웨이 자기 자신 프록시 금지(confused-deputy): ${host}`);
    // 검증 + IP 핀 — 사설/메타데이터면 allowed_internal_hosts 에 있을 때만 통과, 아니면 throw. 이후 이 IP 로만 connect(재resolve 없음).
    const pinnedIp = await pinHost(host, allowedInternal);
    const isHttps = scheme === "https:";
    const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
    const lib = isHttps ? https : http;
    const headers = normHeaders(init?.headers);
    headers["host"] = url.host; // 원래 host[:port] — 상류 vhost 라우팅용(연결은 pinnedIp 로).
    const method = (init?.method || "GET").toUpperCase();
    const bodyStr = typeof init?.body === "string" ? init.body : (init?.body == null ? undefined : String(init.body));
    const signal = init?.signal as AbortSignal | undefined | null;

    const nodeRes = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = lib.request(
        { host: pinnedIp, port, method, path: url.pathname + url.search, headers, servername: isHttps ? host : undefined, timeout: timeoutMs },
        resolve,
      );
      req.on("error", (e) => reject(e instanceof SsrfError ? e : new SsrfError(`상류 연결 오류: ${e.message}`)));
      req.on("timeout", () => req.destroy(new SsrfError("상류 요청 타임아웃")));
      if (signal) {
        if (signal.aborted) req.destroy(new SsrfError("요청 취소됨"));
        else signal.addEventListener("abort", () => req.destroy(new SsrfError("요청 취소됨")), { once: true });
      }
      if (bodyStr) req.write(bodyStr);
      req.end();
    });

    const status = nodeRes.statusCode ?? 502;
    const resHeaders = new Headers();
    for (const [k, v] of Object.entries(nodeRes.headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) for (const x of v) resHeaders.append(k, x);
      else resHeaders.set(k, String(v));
    }
    const nullBody = method === "HEAD" || NULL_BODY.has(status);
    if (nullBody) { nodeRes.resume(); return new Response(null, { status, statusText: nodeRes.statusMessage || "", headers: resHeaders }); }
    const body = Readable.toWeb(nodeRes) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status, statusText: nodeRes.statusMessage || "", headers: resHeaders });
  };
}
