// SigV4-서명 FetchLike(#746) — AWS 원격 MCP(aws-mcp.*.api.aws, per-요청 SigV4)를 A 프록시로 붙이기 위한 auth.
//  각 상류 요청을 요청자 STS 단기자격으로 SigV4 서명 후, SSRF-안전 inner fetch 로 위임(서명 → 가드 → connect).
//  bearer/oauth 가 아닌 '요청별 서명' 스킴이라 별도 auth 모드. 서명기(signRequestV4)·STS(assumeMemberRole) 재사용.
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { signRequestV4, type AwsCreds } from "./aws-sigv4.js";

export interface Sigv4FetchOpts {
  creds: AwsCreds;      // STS 단기자격(요청자 귀속)
  region: string;
  service: string;      // SigV4 service(엔드포인트별 — org_credential meta 로 설정)
  inner: FetchLike;     // SSRF-안전 실전송(makeSsrfFetch)
}

// SigV4 서명 헤더(Authorization·X-Amz-Date·[X-Amz-Security-Token])를 붙여 inner 로 위임.
//  서명 헤더만 서명 대상(host·x-amz-date·security-token) — SDK 가 붙이는 Accept/mcp-session-id 등은 미서명(AWS 허용).
export function makeSigv4Fetch(opts: Sigv4FetchOpts): FetchLike {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let url: URL;
    try { url = input instanceof URL ? input : new URL(String(input)); }
    catch { throw new Error(`잘못된 URL: ${String(input)}`); }
    const method = (init?.method || "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : (init?.body == null ? "" : String(init.body));
    // ⚠ 서명기는 canonical query string 을 빈 문자열로 가정(STS 유래). aws-mcp POST/GET /mcp 는 쿼리 없음 →
    //   현재 OK. 쿼리가 붙는 엔드포인트면 서명 불일치(403) → 서명기에 canonical query 지원 추가 필요(후속).
    const signed = signRequestV4({ method, host: url.host, path: url.pathname, region: opts.region, service: opts.service, body, headers: {}, creds: opts.creds, now: new Date() });
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    for (const [k, v] of Object.entries(signed)) headers.set(k, v);
    return opts.inner(input, { ...init, headers });
  };
}
