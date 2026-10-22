// 작은 S3 클라이언트(#4481 앱 v2-2) — 앱 판 묶음의 파일을 넣고·받고·지우고·목록을 본다. SDK 무의존(aws-sigv4.ts 와 같은 관례).
//
//  왜 SDK 를 안 쓰나: 코어 의존성은 손에 꼽을 만큼만 둔다(package.json) — 서명은 이미 AWS 공개 벡터로 못 박은 signRequestV4 가 있고,
//   쓰는 동작은 다섯 개(PUT · GET · HEAD · DELETE · ListObjectsV2)뿐이다. 자격은 게이트웨이 base 자격(env → EC2 인스턴스 프로파일,
//   aws-broker.ts resolveGatewayBaseCreds) — 매니지드 게이트웨이는 CP 박스의 호스트 프로세스라 박스 역할(lvly-cloud-box)을 받는다.
//  서명 규칙(S3): 경로 조각은 **한 번만** 인코딩(다른 서비스처럼 두 번 하지 않는다) · x-amz-content-sha256 헤더 = 서명에 쓴 payload 해시.
//   https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — s3-lite.test.ts 가 그 문서의 예시 서명을 그대로 맞춘다.
//  모든 동작이 멱등이라(같은 이름에 같은 내용 · 지우기 · 읽기) 일시 오류(5xx · 네트워크)는 두 번까지 다시 한다.
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { amzDate, sha256HexOf, signRequestV4, signStringV4, type AwsCreds } from "./aws-sigv4.js";
import { resolveGatewayBaseCreds } from "./aws-broker.js";

export interface S3Config {
  bucket: string;
  region: string;
  /** 시험·호환 저장소(MinIO 등) 주소 — 주면 경로 방식(`<endpoint>/<bucket>/<key>`), 없으면 AWS 가상 호스트 방식. */
  endpoint?: string;
}

export interface S3Deps {
  creds?: () => Promise<AwsCreds | null>;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  /** 일시 오류에서 다시 하기 전 기다림(ms) — 시험은 0. */
  retryDelayMs?: number;
  /** 한 동작을 몇 번까지 해 보나(처음 포함 · 기본 3). 잠근 채 부르는 정리(gc)는 1 — 잠금을 오래 붙들지 않게. */
  attempts?: number;
}

export class S3Error extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "S3Error"; }
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha256hex = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

/** RFC 3986 unreserved 밖은 전부 %XX — encodeURIComponent 가 남기는 !'()* 도 인코딩한다(S3 서명 규칙). */
export function s3Encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
/** 키 → canonical URI 조각(슬래시는 그대로 두고 조각마다 한 번 인코딩). */
export function s3EncodeKey(key: string): string {
  return key.split("/").map(s3Encode).join("/");
}
/** canonical query — 이름으로 정렬, 이름·값 모두 인코딩. 값이 빈 칸도 `name=` 으로 남는다. */
export function s3CanonicalQuery(params: Record<string, string>): string {
  return Object.keys(params).sort().map((k) => `${s3Encode(k)}=${s3Encode(params[k] ?? "")}`).join("&");
}

interface Target { url: string; host: string; path: string }
function target(cfg: S3Config, key: string): Target {
  if (cfg.endpoint) {
    const u = new URL(cfg.endpoint);
    const path = `/${s3Encode(cfg.bucket)}${key ? "/" + s3EncodeKey(key) : "/"}`;
    return { url: `${u.protocol}//${u.host}${path}`, host: u.host, path };
  }
  const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const path = "/" + s3EncodeKey(key);
  return { url: `https://${host}${path}`, host, path };
}

interface Req {
  method: "GET" | "PUT" | "HEAD" | "DELETE"; key: string; query?: Record<string, string>; body?: Buffer; headers?: Record<string, string>;
  /** 'headers' = 응답 머리가 올 때까지만 시간을 잰다(흘려 받기 — 본문은 받는 쪽 속도로 오래 걸릴 수 있다). 기본 'total'(본문까지). */
  timeout?: "total" | "headers";
}

async function send(cfg: S3Config, deps: S3Deps, r: Req): Promise<Response> {
  const creds = await (deps.creds ?? resolveGatewayBaseCreds)();
  if (!creds) throw new S3Error(0, "NoCredentials", "S3 자격이 없습니다 — 게이트웨이 env(AWS_*) 또는 EC2 인스턴스 프로파일이 필요합니다");
  const t = target(cfg, r.key);
  const query = r.query ? s3CanonicalQuery(r.query) : "";
  const payloadHash = r.body ? sha256hex(r.body) : EMPTY_SHA256;
  const signedHeaders: Record<string, string> = { "x-amz-content-sha256": payloadHash, ...(r.headers ?? {}) };
  const auth = signRequestV4({
    method: r.method, host: t.host, path: t.path, region: cfg.region, service: "s3", body: r.body ?? "",
    headers: signedHeaders, creds, now: (deps.now ?? (() => new Date()))(), query, payloadHash,
  });
  const f = deps.fetch ?? fetch;
  const ms = deps.timeoutMs ?? 30_000;
  //  흘려 받기는 머리까지만 잰다 — 본문 전체에 시한을 걸면 받는 쪽(브라우저)이 느리거나 멈춘 사이 시한이 지나 스트림이 오류로 끝난다.
  const ac = r.timeout === "headers" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(new DOMException("S3 응답 머리 시간 초과", "TimeoutError")), ms) : null;
  try {
    return await f(t.url + (query ? "?" + query : ""), {
      method: r.method,
      headers: { ...signedHeaders, ...auth },
      //  Buffer 를 복사 없이 바이트 보기로 넘긴다(fetch 의 BodyInit 타입이 Buffer 를 직접 받지 않는다).
      body: r.body ? (new Uint8Array(r.body.buffer, r.body.byteOffset, r.body.byteLength) as unknown as BodyInit) : undefined,
      signal: ac ? ac.signal : AbortSignal.timeout(ms),
    });
  } catch (e) {
    //  네트워크 · 시간 초과도 S3Error 로 — 부르는 쪽이 한 가지 꼴로 다루고(503 문구), 다시 하기 판정이 같은 규칙을 쓴다.
    const name = (e as { name?: string })?.name;
    //  fetch 는 «fetch failed» 만 말한다 — 밑의 까닭(ECONNRESET · ENOTFOUND · 인증서)을 붙여야 운영자가 가른다.
    const cause = (e as { cause?: { code?: unknown; message?: unknown } })?.cause;
    const why = cause ? ` (${String(cause.code ?? cause.message ?? "")})` : "";
    throw new S3Error(0, name === "TimeoutError" || name === "AbortError" ? "Timeout" : "NetworkError", `S3 ${r.method} ${r.key || "/"} 연결 실패: ${(e as Error)?.message ?? e}${why}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 오류 응답 → S3Error(본문 XML 의 Code). */
async function fail(res: Response, what: string): Promise<S3Error> {
  const text = await res.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${res.status}`;
  const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? "";
  return new S3Error(res.status, code, `S3 ${what} 실패: ${res.status} ${code}${msg ? " — " + msg : ""}`);
}

/** 다시 해 볼 만한 실패인가 — 네트워크 · 시간 초과 · 5xx · SlowDown. 자격 없음 · 4xx 는 다시 해도 같다. */
const transient = (e: unknown): boolean => {
  if (!(e instanceof S3Error)) return true;
  if (e.code === "NoCredentials") return false;
  return e.status >= 500 || ["SlowDown", "RequestTimeout", "NetworkError", "Timeout"].includes(e.code);
};

/** 일시 오류(5xx · 네트워크 · 시간 초과)면 두 번까지 다시 한다(attempts) — 모든 동작이 멱등이다. */
async function withRetry<T>(deps: S3Deps, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  const n = Math.max(1, Math.floor(deps.attempts ?? 3));
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!transient(e) || i === n - 1) throw e;
      const wait = deps.retryDelayMs ?? 200 * (i + 1);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
  }
  throw last;
}

/** 객체를 넣는다(같은 이름이면 덮어쓴다 — 지문 이름이라 내용이 같다). */
export async function s3Put(cfg: S3Config, key: string, body: Buffer, opts: { contentType?: string } = {}, deps: S3Deps = {}): Promise<void> {
  await withRetry(deps, async () => {
    const res = await send(cfg, deps, { method: "PUT", key, body, headers: { "content-type": opts.contentType ?? "application/octet-stream" } });
    if (!res.ok) throw await fail(res, `PUT ${key}`);
    await res.arrayBuffer().catch(() => undefined);   // 연결을 놓아준다
  });
}

/**
 * 있으면 크기와 지금 판 번호(versionId), 없으면 null. 판 번호는 버킷이 판 번호를 켰을 때만 온다(#4801 — Lambda 가 그 판을 바로 읽게 함수에 적는다).
 *  판 번호를 끈 적이 있는 버킷의 옛 객체는 «null» 이라는 글자를 준다 — 판 번호 없음으로 읽는다.
 */
export async function s3Head(cfg: S3Config, key: string, deps: S3Deps = {}, opts: { versionId?: string | null } = {}): Promise<{ size: number; versionId: string | null } | null> {
  return withRetry(deps, async () => {
    const res = await send(cfg, deps, { method: "HEAD", key, ...(opts.versionId ? { query: { versionId: opts.versionId } } : {}) });
    //  판 번호를 주면 그 판(#4887 — 함수가 읽는 판이 아직 있나) — 영구 삭제한 판은 404, 지움 표시 판은 405 다(둘 다 «없음»).
    if (res.status === 404 || (opts.versionId && res.status === 405)) return null;
    if (!res.ok) throw new S3Error(res.status, `HTTP${res.status}`, `S3 HEAD ${key} 실패: ${res.status}`);
    const v = res.headers.get("x-amz-version-id");
    return { size: Number(res.headers.get("content-length") ?? "0"), versionId: v && v !== "null" ? v : null };
  });
}

/** 내용 전체(작은 객체). 없으면 null. */
export async function s3Get(cfg: S3Config, key: string, deps: S3Deps = {}): Promise<Buffer | null> {
  return withRetry(deps, async () => {
    const res = await send(cfg, deps, { method: "GET", key });
    if (res.status === 404) { await res.arrayBuffer().catch(() => undefined); return null; }
    if (!res.ok) throw await fail(res, `GET ${key}`);
    return Buffer.from(await res.arrayBuffer());
  });
}

/** 흘려 받기(큰 객체 — 앱 주소가 그대로 흘려 보낸다). 없으면 null. 받기 시작한 뒤의 실패는 스트림 오류로 온다(다시 하지 않는다). */
export async function s3GetStream(cfg: S3Config, key: string, deps: S3Deps = {}): Promise<{ stream: Readable; size: number } | null> {
  return withRetry(deps, async () => {
    const res = await send(cfg, deps, { method: "GET", key, timeout: "headers" });
    if (res.status === 404) { await res.arrayBuffer().catch(() => undefined); return null; }
    if (!res.ok || !res.body) throw await fail(res, `GET ${key}`);
    //  받는 쪽이 이 스트림을 destroy 하면(브라우저가 끊음) 밑의 S3 연결도 걷힌다(Readable.fromWeb 이 reader 를 cancel 한다).
    return { stream: Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream), size: Number(res.headers.get("content-length") ?? "0") };
  });
}

/** 지운다(없어도 성공 — S3 가 204). */
export async function s3Delete(cfg: S3Config, key: string, deps: S3Deps = {}): Promise<void> {
  await withRetry(deps, async () => {
    const res = await send(cfg, deps, { method: "DELETE", key });
    if (!res.ok && res.status !== 404) throw await fail(res, `DELETE ${key}`);
    await res.arrayBuffer().catch(() => undefined);
  });
}

/**
 * (#4484) 서명한 주소(presigned URL) — 자격 없는 쪽(세션 컨테이너의 빌더)이 이 키 **하나에만** PUT(또는 GET) 하게 한다.
 *  쿼리 문자열 서명(https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html): 서명 머리는 host 하나 · 본문은
 *  UNSIGNED-PAYLOAD · 임시 자격이면 X-Amz-Security-Token 도 서명에 든다. ⚠ 주소의 수명은 X-Amz-Expires 와 **자격의 남은 수명 중 짧은 쪽**이다
 *  (임시 자격이 만료되면 주소도 죽는다) — 부르는 쪽이 넉넉한 자격으로 만든다(aws-broker resolveGatewayBaseCreds 의 남은 시간).
 *  s3-lite.test.ts 가 AWS 문서의 예시 주소 서명을 그대로 맞춘다.
 */
export function s3PresignUrl(cfg: S3Config, key: string, opts: { method: "GET" | "PUT"; expiresSec: number; creds: AwsCreds; now: Date }): string {
  return presignAt(target(cfg, key), cfg.region, opts);
}

/** 서명 본체 — 주소(host · 경로)를 바로 받는다(시험이 AWS 문서 예시의 옛 전역 주소 `<버킷>.s3.amazonaws.com` 로 맞춘다). */
export function presignAt(t: { url: string; host: string; path: string }, region: string, opts: { method: "GET" | "PUT"; expiresSec: number; creds: AwsCreds; now: Date }): string {
  const { amzDate: xAmzDate, dateStamp } = amzDate(opts.now);
  const cfg = { region };
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${opts.creds.accessKeyId}/${scope}`,
    "X-Amz-Date": xAmzDate,
    "X-Amz-Expires": String(Math.max(1, Math.min(604_800, Math.floor(opts.expiresSec)))),
    "X-Amz-SignedHeaders": "host",
  };
  if (opts.creds.sessionToken) q["X-Amz-Security-Token"] = opts.creds.sessionToken;
  const query = s3CanonicalQuery(q);
  const canonical = [opts.method, t.path, query, `host:${t.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", xAmzDate, scope, sha256HexOf(canonical)].join("\n");
  const sig = signStringV4(toSign, opts.creds.secretAccessKey, dateStamp, cfg.region, "s3");
  return `${t.url}?${query}&X-Amz-Signature=${sig}`;
}

export interface S3ListItem { key: string; size: number; lastModified: string }

/** ListObjectsV2 한 쪽(최대 1,000개). next 가 있으면 이어서. 키는 encoding-type=url 로 받아 풀어 준다(XML 이스케이프를 안 다룬다). */
export async function s3List(cfg: S3Config, prefix: string, next: string | null = null, deps: S3Deps = {}): Promise<{ items: S3ListItem[]; next: string | null }> {
  return withRetry(deps, async () => {
    const query: Record<string, string> = { "list-type": "2", prefix, "encoding-type": "url" };
    if (next) query["continuation-token"] = next;
    const res = await send(cfg, deps, { method: "GET", key: "", query });
    if (!res.ok) throw await fail(res, `LIST ${prefix}`);
    return parseListXml(await res.text());
  });
}

const unurl = (s: string): string => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
const unxml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** ListObjectsV2 응답 XML → 항목(순수 — 시험용 export). */
export function parseListXml(xml: string): { items: S3ListItem[]; next: string | null } {
  const items: S3ListItem[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (key == null) continue;
    items.push({
      key: unurl(unxml(key)),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? "0"),
      lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] ?? "",
    });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { items, next: truncated && token ? unxml(token) : null };
}
