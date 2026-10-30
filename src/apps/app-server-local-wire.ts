// 자가호스팅 앱 서버 실행면(#4487 앱 v2-8)의 «웹 어댑터» 변환 — 함수 주소 모양 사건 ↔ 검사 층에 보낼 HTTP · 응답 앞머리 · REPORT 줄 · 함수 오류 꼴(순수 함수).
//  Lambda 웹 어댑터와 같은 꼴을 짓는다 — 게이트웨이(app-server-stream parsePrelude · app-server-usage parseReport)가 실행면을 가리지 않고 읽는다.
import type http from "node:http";
import type * as lam from "../net/aws/lambda-lite.js";

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

export interface FnUrlEvent {
  rawPath?: unknown; rawQueryString?: unknown; headers?: Record<string, unknown>; cookies?: unknown; body?: unknown; isBase64Encoded?: unknown;
  requestContext?: { http?: { method?: unknown }; requestId?: unknown };
}

/** 함수 주소 모양 사건 → 검사 층에 보낼 HTTP 요청(순수 — 시험 대상). 마감은 x-amzn-lambda-context deadline(epoch ms). */
export function requestOfEvent(ev: FnUrlEvent, deadlineMs: number, functionArn: string, requestId: string): { method: string; path: string; headers: Record<string, string>; body: Buffer } {
  const method = String(ev.requestContext?.http?.method ?? "GET").toUpperCase();
  const raw = String(ev.rawPath ?? "/");
  const rawPath = raw.startsWith("/") ? raw : `/${raw}`;
  const q = typeof ev.rawQueryString === "string" && ev.rawQueryString ? `?${ev.rawQueryString}` : "";
  //  머리글은 바이트다 — 1바이트를 넘는 글자(한글 등)는 UTF-8 바이트 그대로 싣고(Lambda 웹 어댑터와 같다 · Node 는 그런 글을 거절한다),
  //   이름 꼴이 틀렸거나 값에 줄바꿈 · NUL 이 든 머리글은 버린다(머리글 끼워 넣기).
  const wire = (v: string): string | null => (/[\r\n\0]/.test(v) ? null : /[^\x00-\xff]/.test(v) ? Buffer.from(v, "utf8").toString("latin1") : v);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(ev.headers ?? {})) {
    if (typeof v !== "string" || !HEADER_NAME_RE.test(k)) continue;
    const w = wire(v);
    if (w !== null) headers[k.toLowerCase()] = w;
  }
  const cookies = Array.isArray(ev.cookies) ? ev.cookies.filter((c): c is string => typeof c === "string").map(wire).filter((c): c is string => c !== null) : [];
  if (cookies.length) headers.cookie = cookies.join("; ");
  const body = typeof ev.body === "string" && ev.body ? Buffer.from(ev.body, ev.isBase64Encoded === true ? "base64" : "utf8") : Buffer.alloc(0);
  for (const h of ["content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "expect", "x-amzn-lambda-context"]) delete headers[h];
  headers["content-length"] = String(body.length);
  headers["x-amzn-lambda-context"] = JSON.stringify({ request_id: requestId, deadline: deadlineMs, invoked_function_arn: functionArn });
  return { method, path: rawPath + q, headers, body };
}

/** 검사 층의 응답 머리 → «HTTP 통합 응답» 앞머리(JSON + NUL 8개 · app-server-stream parsePrelude 가 읽는 꼴). */
export function preludeOf(statusCode: number, rawHeaders: http.IncomingHttpHeaders): Buffer {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === undefined) continue;
    if (k === "set-cookie") { cookies.push(...(Array.isArray(v) ? v : [v])); continue; }
    headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return Buffer.concat([Buffer.from(JSON.stringify({ statusCode, headers, cookies }), "utf8"), Buffer.alloc(8)]);
}

/** Lambda 와 같은 꼴의 REPORT 줄 — app-server-usage · app-front-server 가 parseReport 로 읽는다(ok 면 Status 칸이 없다). */
export function reportLine(id: string, ms: number, memMb: number, initMs: number | null, status: "ok" | "error" | "timeout", errorType?: string | null): string {
  return `REPORT RequestId: ${id}\tDuration: ${ms.toFixed(2)} ms\tBilled Duration: ${Math.max(1, Math.ceil(ms))} ms\tMemory Size: ${memMb} MB\t` +
    (initMs != null ? `Init Duration: ${initMs.toFixed(2)} ms\t` : "") + (status !== "ok" ? `Status: ${status}\t${errorType ? `Error Type: ${errorType}\t` : ""}` : "");
}

export function errorOut(version: string, errorType: string, message: string, log: string): lam.StreamInvokeOut {
  async function* events(): AsyncGenerator<lam.StreamEvent> {
    yield { type: "chunk", data: Buffer.from(JSON.stringify({ errorType, errorMessage: message })) };
    yield { type: "complete", errorCode: null, errorDetails: null, log };
  }
  return { status: 200, executedVersion: version, contentType: "application/octet-stream", events: events() };
}
