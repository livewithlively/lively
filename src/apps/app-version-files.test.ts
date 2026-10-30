// 판 파일 읽기·쓰기 한 자리의 순수 판정 + 저장소 동시 읽기(#4481 격리 리뷰 후속). 실행: npm run build && node dist/apps/app-version-files.test.js
//  V1 큰 판 내려받기의 내용 싣기 — 매니페스트 → HTML → 작은 것 순 · 파일 하나 상한 · 합 상한(경계: 합이 정확히 상한이면 싣는다) · 글 파일만
//  V2 매니지드 + S3 설정 없음(DB 저장소 = 공용 DB) — 옛 상한(8MiB · 200개)을 넘는 판만 막는다(경계: 정확히 상한은 된다) · S3 · 자가호스팅은 안 막는다
//  V3 저장소에서 판 파일 읽기는 동시 8개까지 · 순서는 묶음 순서 · 하나가 없으면 503 이고 돌던 것이 다 끝난 뒤에 던진다
//  이게 틀리면: 파일 수천 개 앱의 내려받기 응답이 수백 MB 가 되거나, 버킷 설정 전 롤 동안 250MB 판이 공용 DB 에 쌓이거나,
//   5,000개 앱 되돌리기가 S3 왕복을 하나씩 기다려 몇 분 걸리거나(또는 5,000개를 한꺼번에 열거나), 실패 뒤 정리와 쓰기가 엇갈린다.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { PULL_TEXT_FILE_MAX_BYTES, PULL_TEXT_TOTAL_MAX_BYTES, pickPullInline, sharedDbStoreDenial } from "./app-version-files.js";
import { BUNDLE_READ_CONCURRENCY, COMPAT_MAX_BYTES, COMPAT_MAX_FILES, materializeBundle, stageBundle, type AppBundle, type PreparedBundle } from "./app-bundle.js";
import { clearBlobCacheForTest, setBlobS3DepsForTest } from "./app-blob-store.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

{
  const K = 1024;
  const files = [
    { p: "dist/assets/big-AbCd12Ef.js", s: 300 * K },           // 파일 하나 상한(256KB) 넘음
    { p: "dist/assets/a-AbCd12Ef.js", s: 200 * K },
    { p: "dist/assets/b-AbCd12Ef.css", s: 100 * K },
    { p: "dist/logo.png", s: 1 * K },                            // 글 파일 아님
    { p: "dist/index.html", s: 50 * K },
    { p: "dist/about.html", s: 60 * K },
    { p: "lively-app.json", s: 2 * K },
  ];
  const got = pickPullInline(files);
  assert.equal(got[0], "lively-app.json", "매니페스트가 맨 앞");
  assert.deepEqual(got.slice(1, 3), ["dist/index.html", "dist/about.html"], "HTML 이 다음(작은 것부터)");
  assert.ok(!got.includes("dist/assets/big-AbCd12Ef.js"), "파일 하나 상한을 넘는 것은 지문만");
  assert.ok(!got.includes("dist/logo.png"), "그림은 지문만");
  //  합 상한 — 작게 잡아 고르는 순서를 본다: 2 + 50 + 60 = 112KB 까지만.
  assert.deepEqual(pickPullInline(files, PULL_TEXT_FILE_MAX_BYTES, 112 * K), ["lively-app.json", "dist/index.html", "dist/about.html"], "합이 정확히 상한이면 싣는다");
  assert.deepEqual(pickPullInline(files, PULL_TEXT_FILE_MAX_BYTES, 112 * K - 1), ["lively-app.json", "dist/index.html"], "1바이트 넘으면 그 파일은 지문만(뒤의 작은 것은 계속 본다)");
  //  수천 개 작은 글 파일 — 합 1MB 를 넘지 않는다.
  const many = Array.from({ length: 5000 }, (_, i) => ({ p: `dist/chunks/c${String(i).padStart(4, "0")}.js`, s: 10 * K }));
  const pickMany = pickPullInline([{ p: "lively-app.json", s: 1 * K }, ...many]);
  const sum = pickMany.reduce((n, p) => n + (p === "lively-app.json" ? 1 * K : 10 * K), 0);
  assert.ok(sum <= PULL_TEXT_TOTAL_MAX_BYTES, `합 ${sum}`);
  assert.equal(pickMany.length, 1 + Math.floor((PULL_TEXT_TOTAL_MAX_BYTES - 1 * K) / (10 * K)));
  assert.equal(pickMany[0], "lively-app.json");
  ok("V1 큰 판 내려받기 — 매니페스트 → HTML → 작은 것 · 파일 하나 256KB · 합 1MB(= 허용 · +1 지문) · 글 파일만 · 5,000개도 1MB 안");
}
{
  const prep = (n: number, each: number): PreparedBundle => ({ bundle: { v: 1, files: Array.from({ length: n }, (_, i) => ({ p: `f${i}`, h: "a".repeat(64), s: each })) }, readers: new Map() });
  const MANAGED = { LIVELY_TENANT_HEADER_SECRET: "x" } as NodeJS.ProcessEnv;
  const SELF = {} as NodeJS.ProcessEnv;
  const big = prep(1, COMPAT_MAX_BYTES + 1);
  assert.match(String(sharedDbStoreDenial("db", big, MANAGED)), /S3/, "매니지드 + DB 저장소 + 8MiB 넘음 → 막음");
  assert.equal(sharedDbStoreDenial("db", prep(1, COMPAT_MAX_BYTES), MANAGED), null, "정확히 8MiB 는 된다");
  assert.equal(sharedDbStoreDenial("db", prep(COMPAT_MAX_FILES, 1), MANAGED), null, "정확히 200개는 된다");
  assert.notEqual(sharedDbStoreDenial("db", prep(COMPAT_MAX_FILES + 1, 1), MANAGED), null, "201개는 막음");
  assert.equal(sharedDbStoreDenial("s3", big, MANAGED), null, "S3 저장소면 안 막는다");
  assert.equal(sharedDbStoreDenial("db", big, SELF), null, "자가호스팅 DB 저장소는 워크스페이스 상한만");
  ok("V2 매니지드 + 버킷 없음 — 8MiB · 200개 넘는 판만 막음(경계 = 허용) · S3 · 자가호스팅은 그대로");
}
{
  //  S3 저장소를 가짜 fetch 로 — 동시에 몇 개가 떠 있는지 센다.
  process.env.LIVELY_APP_BUNDLE_BUCKET = "bkt";
  process.env.LIVELY_APP_BUNDLE_REGION = "ap-northeast-2";
  const blobs = new Map<string, Buffer>();
  const N = 120;
  const entries = Array.from({ length: N }, (_, i) => {
    const b = Buffer.from(`file ${i} ` + "z".repeat(i));
    blobs.set(sha(b), b);
    return { p: `dist/f${String(i).padStart(3, "0")}.txt`, h: sha(b), s: b.length };
  });
  const bundle: AppBundle = { v: 1, files: entries };
  const st = { inflight: 0, max: 0, calls: 0, missing: null as string | null };
  const fake = (async (url: string | URL | Request) => {
    st.calls++; st.inflight++; st.max = Math.max(st.max, st.inflight);
    await new Promise((r) => setTimeout(r, 5));
    st.inflight--;
    const h = String(url).split("/").pop() as string;
    const b = h === st.missing ? undefined : blobs.get(h);
    return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  }) as typeof fetch;
  setBlobS3DepsForTest({ fetch: fake, creds: async () => ({ accessKeyId: "AK", secretAccessKey: "SK" }), retryDelayMs: 0 });
  clearBlobCacheForTest();
  const files = await materializeBundle("s3", bundle);
  assert.equal(st.calls, N, "파일마다 한 번(관측 장치 확인)");
  assert.equal(st.max, BUNDLE_READ_CONCURRENCY, `동시 최대 ${st.max}`);
  assert.deepEqual(files.map((f) => f.path), entries.map((e) => e.p), "순서는 묶음 순서");
  assert.equal(files[7].content, "file 7 " + "z".repeat(7));
  //  풀기(되돌리기 스테이지)도 같은 동시 수 · 하나가 없으면 503 · 돌던 것이 끝난 뒤 정리해 임시 폴더가 남지 않는다.
  clearBlobCacheForTest(); st.calls = 0; st.max = 0;
  const staged = await stageBundle("s3", bundle);
  try {
    assert.equal(st.max, BUNDLE_READ_CONCURRENCY);
    assert.equal(readFileSync(path.join(staged.dir, "dist/f119.txt"), "utf8"), "file 119 " + "z".repeat(119));
  } finally { await staged.cleanup(); }
  clearBlobCacheForTest(); st.calls = 0; st.max = 0; st.missing = entries[3].h;
  let err: unknown = null;
  try { await stageBundle("s3", bundle); } catch (e) { err = e; }
  assert.ok(err instanceof HttpError && err.status === 503, String(err));
  assert.equal(st.inflight, 0, "던질 때 떠 있는 읽기가 없다");
  assert.ok(st.calls < N / 2, `실패 뒤 새로 꺼내지 않는다(${st.calls})`);
  //  ⓘ 첫 실패 뒤 남은 파일을 더 읽지 않으니 getBlob 의 «없는 객체 → 장부 되돌리기» 는 그 하나만 — DB 가 없는 단위 시험이라 그 UPDATE 는 실패해도 경고만 남긴다.
  setBlobS3DepsForTest(undefined);
  delete process.env.LIVELY_APP_BUNDLE_BUCKET; delete process.env.LIVELY_APP_BUNDLE_REGION;
  ok("V3 판 파일 읽기 동시 8개 · 묶음 순서 · 없는 파일 503(떠 있는 읽기 0 · 더 꺼내지 않음) · 풀기도 같은 규칙");
}
console.log(`\n${pass} passed`);
process.exit(0);
