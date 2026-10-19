// 작은 S3 클라이언트(#4481) 단위 체크 — 서명은 AWS S3 문서의 예시 서명을 그대로 맞춘다(보안 임계경로).
// 실행: npm run build && node dist/net/aws/s3-lite.test.js
//  벡터: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html («Examples: Signature Calculations»)
//   AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY · us-east-1 · 2013-05-24T00:00:00Z · examplebucket
//  E1~E16 은 사양 엣지 표의 행 번호다(요청 모양은 가짜 fetch 가 실제로 받은 URL·헤더·바이트로 본다).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signRequestV4 } from "./aws-sigv4.js";
import { EMPTY_SHA256, S3Error, parseListXml, presignAt, s3CanonicalQuery, s3Delete, s3EncodeKey, s3Get, s3GetStream, s3Head, s3List, s3PresignUrl, s3Put } from "./s3-lite.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const now = new Date("2013-05-24T00:00:00Z");
const sig = (auth: string): string => /Signature=([0-9a-f]{64})/.exec(auth)?.[1] ?? "";
const host = "examplebucket.s3.amazonaws.com";
const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

await t("빈 payload 해시 상수 = sha256(\"\")", () => assert.equal(EMPTY_SHA256, sha("")));

await t("E1 GET Object 예시 — Range 헤더 포함 서명", () => {
  const h = signRequestV4({ method: "GET", host, path: "/test.txt", region: "us-east-1", service: "s3", body: "",
    headers: { range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256 }, creds, now, payloadHash: EMPTY_SHA256 });
  assert.ok(h.Authorization.includes("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"), h.Authorization);
  assert.equal(sig(h.Authorization), "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

await t("E2 PUT Object 예시 — 키의 $ 는 한 번만 인코딩 · 바이트 payload", () => {
  const body = Buffer.from("Welcome to Amazon S3.");
  const ph = sha(body);
  assert.equal(ph, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const h = signRequestV4({ method: "PUT", host, path: "/" + s3EncodeKey("test$file.text"), region: "us-east-1", service: "s3", body,
    headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY", "x-amz-content-sha256": ph }, creds, now, payloadHash: ph });
  assert.ok(h.Authorization.includes("SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class"), h.Authorization);
  assert.equal(sig(h.Authorization), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

await t("E3 GET Bucket Lifecycle 예시 — 값 없는 쿼리는 `lifecycle=`", () => {
  const query = s3CanonicalQuery({ lifecycle: "" });
  assert.equal(query, "lifecycle=");
  const h = signRequestV4({ method: "GET", host, path: "/", region: "us-east-1", service: "s3", body: "",
    headers: { "x-amz-content-sha256": EMPTY_SHA256 }, creds, now, query, payloadHash: EMPTY_SHA256 });
  assert.equal(sig(h.Authorization), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
});

await t("E4 List Objects 예시 — 쿼리는 이름순(뒤섞어 줘도)", () => {
  const query = s3CanonicalQuery({ prefix: "J", "max-keys": "2" });
  assert.equal(query, "max-keys=2&prefix=J");
  const h = signRequestV4({ method: "GET", host, path: "/", region: "us-east-1", service: "s3", body: "",
    headers: { "x-amz-content-sha256": EMPTY_SHA256 }, creds, now, query, payloadHash: EMPTY_SHA256 });
  assert.equal(sig(h.Authorization), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

await t("E5 키 인코딩 — 슬래시는 두고 조각만 · 공백 %20 · !'()* 도", () => {
  assert.equal(s3EncodeKey("t/abc/b/x y!(1).txt"), "t/abc/b/x%20y%21%281%29.txt");
  assert.equal(s3EncodeKey("a*b'c"), "a%2Ab%27c");
  assert.equal(s3CanonicalQuery({ "continuation-token": "a+b/c=", prefix: "t/1/b/" }), "continuation-token=a%2Bb%2Fc%3D&prefix=t%2F1%2Fb%2F");
});

// ── 요청 모양 — 가짜 fetch 가 실제로 받은 것 ──
interface Seen { url: string; method: string; headers: Record<string, string>; body: Buffer | null }
type Reply = { status: number; body?: string | Buffer; headers?: Record<string, string> } | "network-error";
function fakeFetch(replies: Reply[], seen: Seen[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    const b = init?.body != null ? Buffer.from(init.body as Uint8Array) : null;
    seen.push({ url: String(url), method: String(init?.method), headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)])), body: b });
    const r = replies.shift() ?? { status: 500 };
    if (r === "network-error") throw new TypeError("fetch failed");
    return new Response(r.status === 204 ? null : ((r.body ?? "") as unknown as BodyInit), { status: r.status, headers: r.headers });
  }) as typeof fetch;
}
const cfg = { bucket: "lvly-cloud-appbundles-1", region: "ap-northeast-2" };
const deps = (f: typeof fetch) => ({ creds: async () => ({ ...creds, sessionToken: "TOK" }), fetch: f, now: () => now, retryDelayMs: 0 });

await t("E6 PUT — 가상 호스트 주소 · 해시 헤더 = sha256(보낸 바이트) · 토큰 헤더 · 바이트 그대로", async () => {
  const seen: Seen[] = [];
  const body = Buffer.from([0, 1, 2, 255]);
  await s3Put(cfg, "t/u1/b/abc", body, {}, deps(fakeFetch([{ status: 200 }], seen)));
  assert.equal(seen.length, 1, "배선 — 요청이 실제로 나갔다");
  assert.equal(seen[0].url, "https://lvly-cloud-appbundles-1.s3.ap-northeast-2.amazonaws.com/t/u1/b/abc");
  assert.equal(seen[0].method, "PUT");
  assert.deepEqual([...seen[0].body!], [0, 1, 2, 255]);
  assert.equal(seen[0].headers["x-amz-content-sha256"], sha(seen[0].body!));
  assert.equal(seen[0].headers["x-amz-security-token"], "TOK");
  assert.ok(seen[0].headers["authorization"].includes("/ap-northeast-2/s3/aws4_request"));
});

await t("E7 빈 본문(0바이트) PUT — 해시 헤더 = 빈 해시 · 본문 0바이트", async () => {
  const seen: Seen[] = [];
  await s3Put(cfg, "t/u1/b/empty", Buffer.alloc(0), {}, deps(fakeFetch([{ status: 200 }], seen)));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["x-amz-content-sha256"], EMPTY_SHA256);
  assert.equal(seen[0].body?.length ?? 0, 0);
});

await t("E8 일시 오류(503 SlowDown) 뒤 성공 — 2번 보낸다", async () => {
  const seen: Seen[] = [];
  await s3Put(cfg, "k", Buffer.from("x"), {}, deps(fakeFetch([{ status: 503, body: "<Error><Code>SlowDown</Code></Error>" }, { status: 200 }], seen)));
  assert.equal(seen.length, 2);
});

await t("E9 일시 오류 세 번 연속(경계) — 정확히 3번 보내고 던진다 · 네트워크 오류도 일시 오류", async () => {
  const seen: Seen[] = [];
  await assert.rejects(s3Put(cfg, "k", Buffer.from("x"), {}, deps(fakeFetch([{ status: 500 }, { status: 503 }, { status: 502 }, { status: 200 }], seen))),
    (e: unknown) => e instanceof S3Error && e.status === 502);
  assert.equal(seen.length, 3);
  const seen2: Seen[] = [];
  await s3Get(cfg, "k", deps(fakeFetch(["network-error", { status: 200, body: "ok" }], seen2)));
  assert.equal(seen2.length, 2);
});

await t("E10 4xx(403) — 한 번만 보내고 S3Error(상태·코드)", async () => {
  const seen: Seen[] = [];
  await assert.rejects(s3Put(cfg, "k", Buffer.from("x"), {}, deps(fakeFetch([{ status: 403, body: "<Error><Code>AccessDenied</Code><Message>no</Message></Error>" }, { status: 200 }], seen))),
    (e: unknown) => e instanceof S3Error && e.status === 403 && e.code === "AccessDenied");
  assert.equal(seen.length, 1);
});

await t("E11 GET/HEAD — 404 는 null · 200 은 내용/크기", async () => {
  const seen: Seen[] = [];
  const d = deps(fakeFetch([{ status: 404 }, { status: 200, body: Buffer.from("hello") }, { status: 404 }, { status: 200, headers: { "content-length": "5" } }], seen));
  assert.equal(await s3Get(cfg, "a", d), null);
  assert.equal((await s3Get(cfg, "a", d))?.toString(), "hello");
  assert.equal(await s3Head(cfg, "a", d), null);
  assert.deepEqual(await s3Head(cfg, "a", d), { size: 5, versionId: null });
  assert.equal(seen.length, 4);
  assert.equal(seen[0].headers["x-amz-content-sha256"], EMPTY_SHA256);
  assert.equal(seen[2].method, "HEAD");
});

await t("E11b HEAD 판 번호(#4801) — 머리 x-amz-version-id 가 있으면 그 값 · «null»(판 번호 끈 적 있는 버킷의 옛 객체) · 없으면 null", async () => {
  const seen: Seen[] = [];
  const d = deps(fakeFetch([
    { status: 200, headers: { "content-length": "7", "x-amz-version-id": "GphBDgso437Z5WE45HG2Rx1gsprz0Rbu" } },
    { status: 200, headers: { "content-length": "7", "x-amz-version-id": "null" } },
    { status: 200, headers: { "content-length": "7" } },
  ], seen));
  assert.deepEqual(await s3Head(cfg, "a", d), { size: 7, versionId: "GphBDgso437Z5WE45HG2Rx1gsprz0Rbu" });
  assert.deepEqual(await s3Head(cfg, "a", d), { size: 7, versionId: null });
  assert.deepEqual(await s3Head(cfg, "a", d), { size: 7, versionId: null });
  assert.equal(seen.length, 3);
});

await t("E12 DELETE — 204 · 404 둘 다 성공", async () => {
  const seen: Seen[] = [];
  const d = deps(fakeFetch([{ status: 204 }, { status: 404 }], seen));
  await s3Delete(cfg, "a", d);
  await s3Delete(cfg, "a", d);
  assert.deepEqual(seen.map((s) => s.method), ["DELETE", "DELETE"]);
});

await t("E13 목록 XML — url 인코딩 키 풀기 · truncated 일 때만 next", () => {
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
    <Contents><Key>t%2Fa%2Fb%2F01</Key><LastModified>2026-10-15T00:00:00.000Z</LastModified><Size>12</Size></Contents>
    <Contents><Key>t/a/b/02</Key><LastModified>2026-10-15T00:00:01.000Z</LastModified><Size>0</Size></Contents>
    <NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`;
  const r = parseListXml(xml);
  assert.deepEqual(r.items.map((i) => [i.key, i.size]), [["t/a/b/01", 12], ["t/a/b/02", 0]]);
  assert.equal(r.items[0].lastModified, "2026-10-15T00:00:00.000Z");
  assert.equal(r.next, "tok&1");
  assert.equal(parseListXml("<ListBucketResult><IsTruncated>false</IsTruncated><NextContinuationToken>x</NextContinuationToken></ListBucketResult>").next, null);
});

await t("E14 목록 요청 — list-type=2 · encoding-type=url · prefix(인코딩) · 이름순 · 이어받기 표", async () => {
  const seen: Seen[] = [];
  const d = deps(fakeFetch([{ status: 200, body: "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>" }, { status: 200, body: "<ListBucketResult/>" }], seen));
  assert.deepEqual(await s3List(cfg, "t/u1/b/", null, d), { items: [], next: null });
  assert.equal(seen[0].url, "https://lvly-cloud-appbundles-1.s3.ap-northeast-2.amazonaws.com/?encoding-type=url&list-type=2&prefix=t%2Fu1%2Fb%2F");
  await s3List(cfg, "p/", "tok/1", d);
  assert.equal(seen[1].url, "https://lvly-cloud-appbundles-1.s3.ap-northeast-2.amazonaws.com/?continuation-token=tok%2F1&encoding-type=url&list-type=2&prefix=p%2F");
});

await t("E15 호환 저장소 주소 — 경로 방식", async () => {
  const seen: Seen[] = [];
  await s3Put({ ...cfg, endpoint: "http://127.0.0.1:9000" }, "t/x", Buffer.from("1"), {}, deps(fakeFetch([{ status: 200 }], seen)));
  assert.equal(seen[0].url, "http://127.0.0.1:9000/lvly-cloud-appbundles-1/t/x");
});

await t("E16 자격 함수가 null — NoCredentials · 네트워크 0건", async () => {
  const seen: Seen[] = [];
  await assert.rejects(s3Put(cfg, "k", Buffer.from("x"), {}, { creds: async () => null, fetch: fakeFetch([], seen), retryDelayMs: 0 }),
    (e: unknown) => e instanceof S3Error && e.code === "NoCredentials");
  assert.equal(seen.length, 0);
});

await t("E17 네트워크 실패 — S3Error NetworkError · 밑의 까닭(cause.code)을 글에 · 다시 하기(3번) · attempts:1 이면 한 번", async () => {
  const seen: Seen[] = [];
  const boom = (async (url: string | URL | Request) => {
    seen.push({ url: String(url), method: "?", headers: {}, body: null });
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  }) as typeof fetch;
  await assert.rejects(s3Get(cfg, "k", deps(boom)), (e: unknown) => e instanceof S3Error && e.code === "NetworkError" && /ECONNRESET/.test(e.message));
  assert.equal(seen.length, 3, "일시 오류라 다시 한다");
  seen.length = 0;
  await assert.rejects(s3Delete(cfg, "k", { ...deps(boom), attempts: 1 }), (e: unknown) => e instanceof S3Error && e.code === "NetworkError");
  assert.equal(seen.length, 1, "attempts:1 — 다시 하지 않는다(잠근 채 부르는 정리)");
});

await t("E18 시간 초과 — 응답이 안 오면 timeoutMs 뒤 S3Error Timeout(다시 하기 포함)", async () => {
  let calls = 0;
  const hang = ((_u: string | URL | Request, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    calls++;
    init?.signal?.addEventListener("abort", () => rej(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const t0 = Date.now();
  //  AbortSignal.timeout 의 시계는 프로세스를 붙잡지 않는다(unref) — 게이트웨이에선 서버가 붙잡지만 이 시험엔 그것이 없어 따로 붙잡는다.
  const keep = setInterval(() => { /* 붙잡기 */ }, 1000);
  try {
    await assert.rejects(s3Get(cfg, "k", { ...deps(hang), timeoutMs: 60 }), (e: unknown) => e instanceof S3Error && e.code === "Timeout");
  } finally { clearInterval(keep); }
  assert.equal(calls, 3);
  assert.ok(Date.now() - t0 < 2000, "시한이 걸렸다(매달리지 않는다)");
});

await t("E19 흘려 받기는 머리까지만 잰다 — 본문이 timeoutMs 보다 오래 걸려도 끊지 않는다", async () => {
  const slow = ((_u: string | URL | Request, init?: RequestInit) => {
    const enc = new TextEncoder();
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (init?.signal?.aborted) { ctrl.error(init.signal.reason); return; }
        await new Promise((r) => setTimeout(r, 40));
        if (++n > 5) { ctrl.close(); return; }
        ctrl.enqueue(enc.encode(`c${n};`));
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-length": "15" } }));
  }) as typeof fetch;
  const got = await s3GetStream(cfg, "k", { ...deps(slow), timeoutMs: 60 });
  assert.ok(got, "머리는 시한 안에 왔다");
  const parts: Buffer[] = [];
  for await (const c of got!.stream) parts.push(Buffer.from(c as Uint8Array));
  assert.equal(Buffer.concat(parts).toString(), "c1;c2;c3;c4;c5;", "본문 200ms(> 시한 60ms)를 끝까지 받았다");
});

// ── #4484 서명한 주소(presigned URL) — 세션 컨테이너의 빌더가 zip 하나를 직접 올린다 ──
//  벡터: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html («An Example»)
//   GET https://examplebucket.s3.amazonaws.com/test.txt · 2013-05-24T00:00:00Z · X-Amz-Expires=86400 · us-east-1
await t("P1 서명한 주소 — AWS 문서 예시 서명과 같다", () => {
  const url = presignAt({ url: `https://${host}/test.txt`, host, path: "/test.txt" }, "us-east-1", { method: "GET", expiresSec: 86400, creds, now });
  assert.equal(new URL(url).searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  assert.ok(url.startsWith("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature="), url);
});

await t("P2 서명한 주소 — 임시 자격의 토큰도 서명에 들고, PUT 은 다른 서명 · 수명은 7일로 묶인다", () => {
  const tmp = { ...creds, sessionToken: "TOKEN/with+chars=" };
  const cfg = { bucket: "lvly-cloud-appbundles-1", region: "ap-northeast-2" };
  const put = new URL(s3PresignUrl(cfg, "t/ws/z/abc.zip", { method: "PUT", expiresSec: 900, creds: tmp, now }));
  const get = new URL(s3PresignUrl(cfg, "t/ws/z/abc.zip", { method: "GET", expiresSec: 900, creds: tmp, now }));
  assert.equal(put.host, "lvly-cloud-appbundles-1.s3.ap-northeast-2.amazonaws.com");
  assert.equal(put.pathname, "/t/ws/z/abc.zip");
  assert.equal(put.searchParams.get("X-Amz-Security-Token"), "TOKEN/with+chars=");
  assert.notEqual(put.searchParams.get("X-Amz-Signature"), get.searchParams.get("X-Amz-Signature"));
  const long = new URL(s3PresignUrl(cfg, "k", { method: "PUT", expiresSec: 10 ** 9, creds, now }));
  assert.equal(long.searchParams.get("X-Amz-Expires"), "604800");
});

console.log(`\n${pass} passed`);
