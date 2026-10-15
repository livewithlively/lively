// 작은 S3 클라이언트(#4481) 단위 체크 — 서명은 AWS S3 문서의 예시 서명을 그대로 맞춘다(보안 임계경로).
// 실행: npm run build && node dist/net/aws/s3-lite.test.js
//  벡터: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html («Examples: Signature Calculations»)
//   AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY · us-east-1 · 2013-05-24T00:00:00Z · examplebucket
//  E1~E16 은 사양 엣지 표의 행 번호다(요청 모양은 가짜 fetch 가 실제로 받은 URL·헤더·바이트로 본다).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signRequestV4 } from "./aws-sigv4.js";
import { EMPTY_SHA256, S3Error, parseListXml, s3CanonicalQuery, s3Delete, s3EncodeKey, s3Get, s3Head, s3List, s3Put } from "./s3-lite.js";

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
  assert.deepEqual(await s3Head(cfg, "a", d), { size: 5 });
  assert.equal(seen.length, 4);
  assert.equal(seen[0].headers["x-amz-content-sha256"], EMPTY_SHA256);
  assert.equal(seen[2].method, "HEAD");
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

console.log(`\n${pass} passed`);
