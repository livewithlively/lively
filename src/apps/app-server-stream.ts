// 흘려 받은 함수 응답 풀기(#4485 앱 v2-6) — Lambda 흘려 받기(InvokeWithResponseStream) 의 본문 조각들 → HTTP 응답(상태 · 머리글 · 쿠키) + 본문.
//
//  웹 어댑터가 응답 흘려 보내기 모드면 본문이 «HTTP 통합 응답» 틀이다(2026-10-16 시험 함수 실측):
//   JSON 앞머리 {"statusCode":200,"headers":{…},"cookies":["a=1; …", …]} + NUL 8바이트 + 본문. 쿠키는 headers 가 아니라 cookies 배열로 온다.
//   이 틀이면 Lambda 응답 머리 x-amzn-remapped-content-type 이 application/vnd.awslambda.http-integration-response 다.
//  앱이 응답을 시작하기 전에 죽으면(시작 실패 · 포트 안 열림 · 요청 중 종료) 그 머리가 application/octet-stream 이고 본문은 Lambda 오류 JSON
//   ({"errorType":"Runtime.ExitError",…}) — 그때는 «오류» 로 돌려준다(앱 응답처럼 내보내지 않는다).
//  앱이 본문을 보내다 죽거나 시간이 넘으면 흐름이 그냥 끝나고 InvokeComplete 에도 ErrorCode 가 없다 — 끝의 기록 REPORT 줄 «Status: error|timeout» 이
//   그 사실을 말한다(부르는 쪽이 그때 연결을 끊어 «잘린 응답» 을 온전한 응답처럼 끝내지 않는다).
import type { StreamEvent, StreamInvokeOut } from "../net/aws/lambda-lite.js";

export const HTTP_INTEGRATION_CT = "application/vnd.awslambda.http-integration-response";
const DELIM = Buffer.alloc(8);
/** 앞머리(상태 · 머리글 · 쿠키) 상한 — 넘으면 틀이 깨진 것으로 본다. */
export const PRELUDE_MAX = 128 * 1024;
/** 오류 본문 상한(사람에게 보일 만큼만 읽는다). */
const ERROR_MAX = 64 * 1024;

export interface HttpPrelude { statusCode: number; headers: Record<string, string>; cookies: string[] }
export type Complete = Extract<StreamEvent, { type: "complete" }>;

export type StreamStart =
  | { kind: "http"; prelude: HttpPrelude; first: Buffer; rest: AsyncGenerator<StreamEvent>; complete: Complete | null }
  | { kind: "error"; payload: Buffer; complete: Complete | null };

/** 앞머리 JSON → 값(모양이 틀리면 null). 머리글 값은 글자만 · 이름은 소문자. */
export function parsePrelude(raw: Buffer): HttpPrelude | null {
  let o: unknown;
  try { o = JSON.parse(raw.toString("utf8")); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const statusCode = Number(r.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return null;
  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === "object" && !Array.isArray(r.headers)) {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.filter((x) => typeof x === "string").join(", ");
      else if (typeof v === "number" || typeof v === "boolean") headers[k.toLowerCase()] = String(v);
    }
  }
  const cookies = Array.isArray(r.cookies) ? r.cookies.filter((c): c is string => typeof c === "string") : [];
  return { statusCode, headers, cookies };
}

/**
 * 흐름의 앞부분을 읽어 HTTP 응답의 시작(앞머리 + 앞머리 뒤에 붙어 온 본문 첫 바이트)을 돌려준다. 나머지 조각은 rest 로 이어 읽는다
 *  (같은 생성기 — 이 함수가 읽은 데까지는 다시 나오지 않는다). HTTP 통합 틀이 아니거나 앞머리 전에 끝나면 «오류».
 */
export async function startHttpStream(out: StreamInvokeOut): Promise<StreamStart> {
  const integration = (out.contentType ?? "").toLowerCase().startsWith(HTTP_INTEGRATION_CT);
  let buf: Buffer = Buffer.alloc(0);
  for (;;) {
    const n = await out.events.next();
    if (n.done) return { kind: "error", payload: buf.subarray(0, ERROR_MAX), complete: null };
    const ev = n.value;
    if (ev.type === "complete") return { kind: "error", payload: buf.subarray(0, ERROR_MAX), complete: ev };
    if (!integration) {
      if (buf.length < ERROR_MAX) buf = Buffer.concat([buf, ev.data]);
      continue;
    }
    buf = buf.length ? Buffer.concat([buf, ev.data]) : ev.data;
    const at = buf.indexOf(DELIM);
    if (at < 0) {
      if (buf.length > PRELUDE_MAX) return { kind: "error", payload: Buffer.from("응답 머리(앞머리)가 너무 깁니다"), complete: null };
      continue;
    }
    const prelude = parsePrelude(buf.subarray(0, at));
    if (!prelude) return { kind: "error", payload: Buffer.from("응답 머리(앞머리)를 읽지 못했습니다"), complete: null };
    return { kind: "http", prelude, first: buf.subarray(at + DELIM.length), rest: out.events, complete: null };
  }
}

/** 시험 호출 · 짧은 응답용 — 끝까지 읽는다(본문은 max 까지만 모은다). */
export async function collectHttpStream(out: StreamInvokeOut, max = 64 * 1024): Promise<
  { kind: "http"; prelude: HttpPrelude; body: Buffer; complete: Complete | null } | { kind: "error"; payload: Buffer; complete: Complete | null }> {
  const s = await startHttpStream(out);
  if (s.kind === "error") {
    let complete = s.complete;
    if (!complete) for await (const ev of out.events) if (ev.type === "complete") { complete = ev; break; }
    return { kind: "error", payload: s.payload, complete };
  }
  const parts: Buffer[] = [s.first.subarray(0, max)];
  let size = parts[0]!.length;
  let complete: Complete | null = null;
  for await (const ev of s.rest) {
    if (ev.type === "complete") { complete = ev; break; }
    if (size < max) { const take = ev.data.subarray(0, max - size); parts.push(take); size += take.length; }
  }
  return { kind: "http", prelude: s.prelude, body: Buffer.concat(parts), complete };
}

/** Lambda 오류 본문({"errorType","errorMessage"}) → 형 · 글. */
export function lambdaErrorOf(payload: Buffer): { type: string | null; message: string | null } {
  try {
    const o = JSON.parse(payload.toString("utf8")) as { errorType?: unknown; errorMessage?: unknown };
    return { type: typeof o.errorType === "string" ? o.errorType : null, message: typeof o.errorMessage === "string" ? o.errorMessage : null };
  } catch { return { type: null, message: payload.length ? payload.toString("utf8").slice(0, 500) : null }; }
}
