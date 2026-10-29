// 앱 서버 실행면(#4487 앱 v2-8 1단계 «실행면 추상») 단위 시험 — 실행면 이름 · 설정 · 못 켜는 까닭 · 함수 실행면 · zip 저장소 고르기 · S3 zip 저장소 겉면 · 배선.
// 실행: npm run build && node dist/apps/app-server-host.test.js
//  행 이름(H · E · U · A · Z · S · W)은 사양 엣지 표(#4487 PR 1)의 행 번호다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_ADAPTER_LAYER_ARN, appServerApiUrl, appServerEnv, appServerHostKind, appServerHostUnavailable } from "./app-server-config.js";
import { appServerApi, appServerZipStore, s3ZipStore } from "./app-server-host.js";
import { appServerUnavailable } from "./app-server-deploy.js";

let pass = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>): void => { tests.push([name, fn]); };

const ROLE = "arn:aws:iam::111122223333:role/lvly-app-exec";
const BUCKET = { LIVELY_APP_BUNDLE_BUCKET: "lvly-bundles-test" };

t("H1 실행면 이름이 없음 · 빈 글 · 빈칸만 → lambda", () => {
  assert.equal(appServerHostKind({}), "lambda");
  assert.equal(appServerHostKind({ LIVELY_APP_SERVER_HOST: "" }), "lambda");
  assert.equal(appServerHostKind({ LIVELY_APP_SERVER_HOST: "   " }), "lambda");
});

t("H2 lambda · 대소문자 · 앞뒤 빈칸", () => {
  assert.equal(appServerHostKind({ LIVELY_APP_SERVER_HOST: "lambda" }), "lambda");
  assert.equal(appServerHostKind({ LIVELY_APP_SERVER_HOST: " LAMBDA " }), "lambda");
});

t("H3 local · 대소문자 · 앞뒤 빈칸", () => {
  assert.equal(appServerHostKind({ LIVELY_APP_SERVER_HOST: "local" }), "local");
  assert.equal(appServerHostKind({ LIVELY_APP_SERVER_HOST: " Local " }), "local");
});

t("H4 모르는 이름 → 모름 · 못 켜는 까닭에 그 이름", () => {
  for (const v of ["locl", "docker", "lambda-local"]) {
    assert.equal(appServerHostKind({ LIVELY_APP_SERVER_HOST: v }), null, v);
    assert.match(appServerHostUnavailable({ LIVELY_APP_SERVER_HOST: v }) ?? "", new RegExp(`LIVELY_APP_SERVER_HOST=${v}`), v);
  }
});

t("E1 lambda + 실행 역할 → 설정의 실행면 칸 = lambda", () => {
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE })?.host, "lambda");
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_SERVER_HOST: "lambda" })?.host, "lambda");
});

t("E2 · C1 local → 실행 역할 없이 켜짐(실행면 local · 런타임 = 이미지 · 아키텍처 = 이 박스 · COPY)", () => {
  //  #4487 2단계 — 1단계에선 이 판에서 꺼져 있었다(E2). 자가호스팅 박스엔 실행 역할 · 버킷이 없다.
  for (const extra of [{}, { LIVELY_APP_SERVER_EXEC_ROLE: ROLE }]) {
    const e = appServerEnv({ LIVELY_APP_SERVER_HOST: "local", ...extra }, "acme");
    assert.equal(e?.host, "local");
    assert.equal(e?.runtime, "node:22-bookworm-slim");
    assert.equal(e?.arch, process.arch === "arm64" ? "arm64" : "x86_64");
    assert.equal(e?.codeStorage, "COPY");
    assert.equal(e?.layerArn, LOCAL_ADAPTER_LAYER_ARN);
    assert.equal(e?.prefix, "lvly-app-");
  }
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_HOST: "local", LIVELY_APP_SERVER_IMAGE: "registry.example/node:22@sha256:abc" }, "acme")?.runtime, "registry.example/node:22@sha256:abc");
});

t("C2 local + 워크스페이스 스위치 밖 → 꺼짐 · 안 → 켜짐", () => {
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_HOST: "local", LIVELY_APP_SERVER_TENANTS: "other" }, "acme"), null);
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_HOST: "local", LIVELY_APP_SERVER_TENANTS: "other, acme" }, "acme")?.host, "local");
});

t("C3 이미지 env 꼴이 틀리면 기본 이미지(검사기가 그 값만 허락한다)", () => {
  for (const bad of ["Node:22", "node 22", "--privileged", "a".repeat(201), "node:22;rm -rf /"]) {
    assert.equal(appServerEnv({ LIVELY_APP_SERVER_HOST: "local", LIVELY_APP_SERVER_IMAGE: bad }, "acme")?.runtime, "node:22-bookworm-slim", bad);
  }
});

t("C4 local 의 게이트웨이 주소(LIVELY_API_URL) — env > 조직 게이트웨이 주소 > PUBLIC_URL · 슬러그를 붙이지 않는다", () => {
  const L = { LIVELY_APP_SERVER_HOST: "local", PUBLIC_URL: "https://box.example.com/x" };
  assert.equal(appServerApiUrl("acme", "https://gw.example.com/ui", { ...L, LIVELY_APP_SERVER_API_URL: "http://host.docker.internal:8080/" }), "http://host.docker.internal:8080");
  assert.equal(appServerApiUrl("acme", "https://gw.example.com/ui", L), "https://gw.example.com");
  assert.equal(appServerApiUrl("acme", null, L), "https://box.example.com", "acme.box.example.com 으로 붙이지 않는다");
  assert.equal(appServerApiUrl("acme", null, { ...L, LIVELY_APP_SERVER_API_URL: "ftp://x" }), "https://box.example.com", "http(s) 아닌 env 는 버린다");
  //  매니지드(lambda)는 종전대로 슬러그를 붙인다
  assert.equal(appServerApiUrl("acme", null, { PUBLIC_URL: "https://lvly.io" }), "https://acme.lvly.io");
});

t("E3 ★ 모르는 이름 + 실행 역할 → 꺼짐(조용히 Lambda 로 가지 않는다)", () => {
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_SERVER_HOST: "locl" }), null);
});

t("U1~U5 못 켜는 까닭 — local(켜짐 · 버킷 없이) · 모르는 이름 · 역할 없음 · 버킷 없음 · 다 있음", () => {
  assert.equal(appServerUnavailable({ LIVELY_APP_SERVER_HOST: "local" }), null, "자가호스팅은 실행 역할 · 버킷 없이 켜진다(#4487 2단계)");
  assert.match(appServerUnavailable({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_SERVER_HOST: "docker", ...BUCKET }) ?? "", /LIVELY_APP_SERVER_HOST=docker/);
  assert.match(appServerUnavailable({ ...BUCKET }) ?? "", /앱 서버 실행이 아직 켜져 있지 않습니다/);
  assert.match(appServerUnavailable({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE }) ?? "", /판 묶음 버킷\(LIVELY_APP_BUNDLE_BUCKET\)이 없어/);
  assert.equal(appServerUnavailable({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, ...BUCKET }), null);
});

const API_METHODS = ["getFunction", "getFunctionConfiguration", "createFunction", "updateFunctionCode", "updateFunctionConfiguration", "publishVersion", "listVersions",
  "putAlias", "invokeStream", "invokeAsync", "listLayerVersions", "publishLayerVersion", "deleteFunction", "putConcurrency", "deleteConcurrency", "ensureLogGroup", "deleteLogGroup"];

t("A1 함수 실행면 — lambda 면 흐름이 부르는 열일곱 동작이 다 있다", () => {
  const api = appServerApi({ host: "lambda", region: "ap-northeast-2" }) as unknown as Record<string, unknown>;
  for (const m of API_METHODS) assert.equal(typeof api[m], "function", m);
});

t("A2 함수 실행면 — local 도 열일곱 동작이 다 있다(로컬 컨테이너 실행면)", () => {
  const api = appServerApi({ host: "local", region: "local" }) as unknown as Record<string, unknown>;
  for (const m of API_METHODS) assert.equal(typeof api[m], "function", m);
});

t("Z1 · Z4 zip 저장소 — lambda + 버킷 → 버킷 이름 · 앞자리(설정 없으면 빈 글 · 있으면 끝에 / 하나)", () => {
  const a = appServerZipStore({ ...BUCKET });
  assert.equal(a?.bucket, "lvly-bundles-test");
  assert.equal(a?.prefix, "");
  const b = appServerZipStore({ ...BUCKET, LIVELY_APP_BUNDLE_PREFIX: "/stage/" });
  assert.equal(b?.prefix, "stage/");
});

t("Z2 zip 저장소 — 버킷 없음 → 없음", () => {
  assert.equal(appServerZipStore({}), null);
});

t("Z3 zip 저장소 — local 은 박스 디스크(버킷이 있어도 · 없어도) · 모르는 이름 → 없음", () => {
  for (const extra of [{}, BUCKET]) {
    const z = appServerZipStore({ ...extra, LIVELY_APP_SERVER_HOST: "local" });
    assert.equal(z?.bucket, "lively-local");
    assert.equal(z?.prefix, "");
  }
  assert.equal(appServerZipStore({ ...BUCKET, LIVELY_APP_SERVER_HOST: "nope" }), null);
});

// ── S3 zip 저장소 겉면 — 가짜 fetch 가 받은 요청으로 본다 ──
interface Seen { method: string; url: URL }
function fakeS3(reply: (s: Seen) => Response): { seen: Seen[]; store: ReturnType<typeof s3ZipStore> } {
  const seen: Seen[] = [];
  const store = s3ZipStore({ bucket: "b1", region: "ap-northeast-2", endpoint: "http://s3.test", prefix: "" }, {
    creds: async () => ({ accessKeyId: "AKIDTEST", secretAccessKey: "secret" }),
    retryDelayMs: 0,
    fetch: (async (u: string | URL, init?: RequestInit) => {
      const s = { method: String(init?.method ?? "GET"), url: new URL(String(u)) };
      seen.push(s);
      return reply(s);
    }) as typeof fetch,
  });
  return { seen, store };
}

t("S1 있나 — 옵션 없이 · 저장소가 계속 503 → 종전 기본처럼 세 번 시도", async () => {
  const { seen, store } = fakeS3(() => new Response(null, { status: 503 }));
  await assert.rejects(store.head("t/x/z/a/k.zip"));
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s.method === "HEAD" && s.url.pathname === "/b1/t/x/z/a/k.zip"), JSON.stringify(seen.map((s) => [s.method, s.url.pathname])));
});

t("S2 있나 — 한 번 · 짧게 → 한 번만 시도", async () => {
  const { seen, store } = fakeS3(() => new Response(null, { status: 503 }));
  await assert.rejects(store.head("k.zip", { attempts: 1, timeoutMs: 5_000 }));
  assert.equal(seen.length, 1);
});

t("S3 있나 — 판 번호를 주면 그 판으로 묻는다 · 404 · 405 는 없음", async () => {
  for (const status of [404, 405]) {
    const { seen, store } = fakeS3(() => new Response(null, { status }));
    assert.equal(await store.head("k.zip", { versionId: "v-7", attempts: 1 }), null, String(status));
    assert.equal(seen[0]?.url.searchParams.get("versionId"), "v-7");
  }
});

t("S4 있나 — 200 → 크기 · 지금 판 번호", async () => {
  const { seen, store } = fakeS3(() => new Response(null, { status: 200, headers: { "content-length": "1234", "x-amz-version-id": "zv9" } }));
  assert.deepEqual(await store.head("k.zip"), { size: 1234, versionId: "zv9" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url.searchParams.has("versionId"), false);
});

t("S5 지우기 — DELETE 한 번(일시 오류여도 다시 안 함)", async () => {
  const { seen, store } = fakeS3(() => new Response(null, { status: 503 }));
  await assert.rejects(store.remove("t/x/z/a/k.zip"));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, "DELETE");
  const ok = fakeS3(() => new Response(null, { status: 204 }));
  await ok.store.remove("k.zip");
  assert.equal(ok.seen.length, 1);
});

t("D1 실행면 이름을 틀리면 하우스키핑 결과에 꺼진 까닭이 실린다(조용히 멈추지 않게)", async () => {
  const { runAppServerHousekeeping } = await import("./app-server-watch.js");
  const before = process.env.LIVELY_APP_SERVER_HOST;
  process.env.LIVELY_APP_SERVER_HOST = "locl";
  try {
    const out = await runAppServerHousekeeping();
    assert.equal(out.skipped, "disabled");
    assert.match(String(out.why ?? ""), /LIVELY_APP_SERVER_HOST=locl/);
  } finally {
    if (before === undefined) delete process.env.LIVELY_APP_SERVER_HOST; else process.env.LIVELY_APP_SERVER_HOST = before;
  }
});

t("W1 배선 — 흐름 파일들은 Lambda · S3 를 직접 부르지 않는다(실행면 모듈만)", () => {
  //  dist/apps/<이 파일>.js → 소스 src/apps 로(시험은 빌드한 뒤 돈다).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, "../../src/apps");
  const flows = ["app-server-deploy.ts", "app-server-lifecycle.ts", "app-server-watch.ts", "app-server-build.ts", "app-front-server.ts", "app-jobs.ts"];
  const banned = [/\brealLambdaApi\(/, /\bappBundleS3Config\(/, /\bs3Head\(/, /\bs3Delete\(/, /\bs3PresignUrl\(/];
  for (const f of flows) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    assert.ok(text.length > 1000, `${f} 를 읽지 못했다`);   // 배선 — 빈 글을 읽고 통과하지 않게
    for (const re of banned) assert.equal(re.test(text), false, `${f} 가 ${re} 를 직접 부른다 — app-server-host 의 appServerApi · appServerZipStore 를 쓰세요`);
  }
});

for (const [name, fn] of tests) { await fn(); pass++; console.log(`ok  ${name}`); }
console.log(`\napp-server-host: ${pass}/${tests.length} 통과`);
