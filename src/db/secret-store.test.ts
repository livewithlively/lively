// #1764 시크릿 저장소 읽기 · 기억 · 실패 까닭 — 단위 시험(스크래치 spec.md B · C · D · 엣지 E4~E6 · E8 · E9).
//  GCP 는 가짜 메타데이터 서버와 가짜 Secret Manager 를 **실제 HTTP 서버**(127.0.0.1)로 띄워 요청 경로 · 머리 · 응답 해석을 함께 본다.
//  AWS 는 fetch 를 끼워 넣어 실제 서명기(aws-json.awsCall)가 만든 요청을 본다. 실제 클라우드에는 닿지 않는다.
//  값이 새지 않는지는 문구가 아니라 부작용으로 본다 — 로거를 가로채 모든 로그 · 모든 오류 문장에 시크릿 값이 없음을 단언한다.
// 실행: npm run build && node dist/db/secret-store.test.js
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { logger } from "../log.js";
import {
  readDbSecret, forgetDbSecret, interpretSecretValue, DbSecretError, __setSecretStoreDepsForTest, secretVersion,
  SECRET_TTL_MS, SECRET_MAX_STALE_MS, SECRET_STALE_RETRY_MS, type DbSecretReason, type SecretStoreDeps,
} from "./secret-store.js";

const MARKER = "pw-MARKER-7f3a"; // 시크릿 값 — 로그 · 오류 문장 어디에도 나오면 안 된다
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

// ── 로그 가로채기(값 누출 단언용) ──
const logs: string[] = [];
for (const lvl of ["trace", "debug", "info", "warn", "error", "fatal"]) {
  (logger as unknown as Record<string, unknown>)[lvl] = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
}
const errors: string[] = []; // 시험 중 받은 모든 오류 문장

// ── 가짜 HTTP 서버 ──
interface Rep { status: number; json?: unknown; text?: string; headers?: Record<string, string>; delayMs?: number }
interface Call { method: string; url: string; headers: http.IncomingHttpHeaders }
class Fake {
  calls: Call[] = [];
  queue: Rep[] = [];
  fallback: Rep;
  base = "";
  private server = http.createServer((req, res) => {
    this.calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const r = this.queue.shift() ?? this.fallback;
    const send = (): void => {
      const headers: Record<string, string> = { ...(r.headers ?? {}) };
      let body = r.text ?? "";
      if (r.json !== undefined) { body = JSON.stringify(r.json); headers["content-type"] = "application/json"; }
      res.writeHead(r.status, headers).end(body);
    };
    if (r.delayMs) setTimeout(send, r.delayMs); else send();
  });
  constructor(fallback: Rep) { this.fallback = fallback; }
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  reset(fallback?: Rep): void { this.calls = []; this.queue = []; if (fallback) this.fallback = fallback; }
  close(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }
}

const FLAVOR = { "Metadata-Flavor": "Google" };
const TOKEN_OK: Rep = { status: 200, json: { access_token: "tok-1", expires_in: 3599, token_type: "Bearer" }, headers: FLAVOR };
const smValue = (v: string): Rep => ({ status: 200, json: { name: "projects/123/secrets/db-pw/versions/7", payload: { data: b64(v), dataCrc32c: "1" } } });
const gErr = (status: number, grpc: string, message: string, reason?: string): Rep => ({
  status,
  json: { error: { code: status, message, status: grpc, ...(reason ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }] } : {}) } },
});

const meta = new Fake(TOKEN_OK);
const sm = new Fake(smValue(MARKER));
await meta.start();
await sm.start();
// 닫힌 포트 — 메타데이터 서버가 없는 자리(GCP 밖)
const closed = http.createServer();
await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
const CLOSED_BASE = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
await new Promise<void>((r) => closed.close(() => r()));

// ── AWS 가짜 fetch ──
interface AwsCallLog { url: string; method: string; headers: Record<string, string>; body: string }
let awsCalls: AwsCallLog[] = [];
let awsQueue: Array<{ status: number; json: unknown }> = [];
const awsFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) h[k.toLowerCase()] = v;
  awsCalls.push({ url: String(input), method: String(init?.method), headers: h, body: String(init?.body ?? "") });
  const r = awsQueue.shift() ?? { status: 200, json: { Name: "prod/db", SecretString: MARKER, VersionId: "v1" } };
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/x-amz-json-1.1" } });
}) as typeof fetch;
let awsCreds: (() => Promise<{ accessKeyId: string; secretAccessKey: string } | null>) = async () => ({ accessKeyId: "AKIDTEST", secretAccessKey: "test-secret-key" });

let clock = 1_000_000;
let metaBase = ""; // 메타데이터 주소 — 시험 중간에 서버가 사라지는 경우를 기억을 지우지 않고 흉내 낸다
const setup = (over: Partial<SecretStoreDeps> = {}): void => {
  metaBase = meta.base;
  meta.reset(TOKEN_OK);
  sm.reset(smValue(MARKER));
  awsCalls = [];
  awsQueue = [];
  awsCreds = async () => ({ accessKeyId: "AKIDTEST", secretAccessKey: "test-secret-key" });
  clock = 1_000_000;
  __setSecretStoreDepsForTest({
    now: () => clock,
    gcpMetadataBase: () => metaBase,
    gcpSecretManagerBase: `${sm.base}/v1`,
    retryDelayMs: 0,
    aws: { fetch: awsFetch, creds: () => awsCreds(), now: () => new Date("2026-11-19T00:00:00Z"), retryDelayMs: 0 },
    ...over,
  });
};

const reasonOf = async (p: Promise<unknown>): Promise<{ reason: DbSecretReason; message: string }> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof DbSecretError, `DbSecretError 가 아니다: ${(e as Error)?.message}`);
    errors.push(e.message);
    return { reason: e.reason, message: e.message };
  }
  assert.fail("실패해야 하는데 값을 돌려줬다");
};

const GREF = "gcp-sm:my-project/db-pw";
const SM_PATH = "/v1/projects/my-project/secrets/db-pw/versions/latest:access";
const AREF = "aws-sm:ap-northeast-2/prod/db";

const tests: Array<[string, () => Promise<void>]> = [];
const t = (name: string, fn: () => Promise<void>): void => { tests.push([name, fn]); };

// ── B. 값 해석 ──
t("값: 끝 줄바꿈(\\r\\n 포함)만 떼고 가운데 줄바꿈은 둔다", async () => {
  assert.deepEqual(interpretSecretValue("a\nb\r\n", "r"), { password: "a\nb" });
  assert.deepEqual(interpretSecretValue("pw  ", "r"), { password: "pw  " }); // 끝 공백은 비밀번호의 일부
});
t("값: {\"password\"} JSON 이면 password(+username)", async () => {
  assert.deepEqual(interpretSecretValue(JSON.stringify({ username: "svc", password: MARKER, engine: "mysql" }), "r"), { password: MARKER, username: "svc" });
});
t("값(E3): JSON 에 username 이 없으면 password 만", async () => {
  assert.deepEqual(interpretSecretValue(JSON.stringify({ password: MARKER }), "r"), { password: MARKER });
});
t("값: «{» 로 시작해도 JSON 이 아니면 그대로 비밀번호", async () => {
  assert.deepEqual(interpretSecretValue("{not json", "r"), { password: "{not json" });
});
t("값: JSON 인데 password 칸이 없으면 값 형식 오류(값은 문장에 없다)", async () => {
  const r = await reasonOf(Promise.resolve().then(() => interpretSecretValue(JSON.stringify({ pw: MARKER }), "r")));
  assert.equal(r.reason, "bad_value");
});
t("값: 빈 값(줄바꿈뿐)은 값 형식 오류", async () => {
  assert.equal((await reasonOf(Promise.resolve().then(() => interpretSecretValue("\n", "r")))).reason, "bad_value");
});

// ── B. GCP 읽기 — 배선 ──
t("GCP: 메타데이터 토큰 → Secret Manager 접근 — 경로 · 머리 · 값", async () => {
  setup();
  sm.reset(smValue(MARKER + "\n")); // echo 로 넣은 값처럼 끝 줄바꿈
  const v = await readDbSecret(GREF);
  assert.deepEqual(v, { password: MARKER });
  assert.equal(meta.calls.length, 1, "메타데이터 서버를 한 번 불러야 한다");
  assert.equal(meta.calls[0].url, "/computeMetadata/v1/instance/service-accounts/default/token");
  assert.equal(meta.calls[0].headers["metadata-flavor"], "Google");
  assert.equal(sm.calls.length, 1);
  assert.equal(sm.calls[0].method, "GET");
  assert.equal(sm.calls[0].url, SM_PATH);
  assert.equal(sm.calls[0].headers.authorization, "Bearer tok-1");
});
t("GCP: 버전을 적으면 그 버전 경로로", async () => {
  setup();
  await readDbSecret("gcp-sm:my-project/db-pw#7");
  assert.equal(sm.calls[0].url, "/v1/projects/my-project/secrets/db-pw/versions/7:access");
});
t("GCP: JSON 시크릿이면 username 도", async () => {
  setup();
  sm.reset(smValue(JSON.stringify({ username: "svc_ro", password: MARKER })));
  assert.deepEqual(await readDbSecret(GREF), { password: MARKER, username: "svc_ro" });
});
t("GCP: 빈 값은 값 형식 오류", async () => {
  setup();
  sm.reset(smValue(""));
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "bad_value");
});

// ── D. GCP 실패 까닭 ──
t("GCP 까닭: 메타데이터 서버에 연결 못 함 → 자격 없음(저장소는 안 부름)", async () => {
  setup({ gcpMetadataBase: () => CLOSED_BASE });
  const r = await reasonOf(readDbSecret(GREF));
  assert.equal(r.reason, "no_credentials");
  assert.equal(sm.calls.length, 0);
});
t("GCP 까닭: 메타데이터 주소가 GCP 아닌 응답(머리 없음) → 자격 없음", async () => {
  setup();
  meta.reset({ status: 404, text: "Not Found" }); // AWS IMDS 처럼 같은 주소에 답하는 다른 서버
  const r = await reasonOf(readDbSecret(GREF));
  assert.equal(r.reason, "no_credentials");
  assert.match(r.message, /GCP 밖/);
  assert.equal(sm.calls.length, 0);
});
t("GCP 까닭: 메타데이터 404(서비스 계정 없음) → 자격 없음", async () => {
  setup();
  meta.reset({ status: 404, text: "service account not found", headers: FLAVOR });
  const r = await reasonOf(readDbSecret(GREF));
  assert.equal(r.reason, "no_credentials");
  assert.match(r.message, /서비스 계정/);
});
t("GCP 까닭: 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT → 접근 범위 부족", async () => {
  setup();
  sm.reset(gErr(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes.", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"));
  const r = await reasonOf(readDbSecret(GREF));
  assert.equal(r.reason, "scope_insufficient");
  assert.match(r.message, /cloud-platform/);
});
t("GCP 까닭: 403 IAM(이유 칸 없음) → 권한 없음", async () => {
  setup();
  sm.reset(gErr(403, "PERMISSION_DENIED", "Permission 'secretmanager.versions.access' denied for resource 'projects/my-project/secrets/db-pw/versions/latest' (or it may not exist)."));
  const r = await reasonOf(readDbSecret(GREF));
  assert.equal(r.reason, "permission_denied");
  assert.match(r.message, /secretAccessor/);
});
t("GCP 까닭: 403 SERVICE_DISABLED → API 꺼짐", async () => {
  setup();
  sm.reset(gErr(403, "PERMISSION_DENIED", "Secret Manager API has not been used in project 123 before or it is disabled.", "SERVICE_DISABLED"));
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "api_disabled");
});
t("GCP 까닭: 404 → 시크릿 없음", async () => {
  setup();
  sm.reset(gErr(404, "NOT_FOUND", "Secret [projects/123/secrets/db-pw] not found or has no versions."));
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "not_found");
});
t("GCP 까닭: 400 FAILED_PRECONDITION(DISABLED) → 쓸 수 없는 버전", async () => {
  setup();
  sm.reset(gErr(400, "FAILED_PRECONDITION", "Secret Version [projects/123/secrets/db-pw/versions/1] is in DISABLED state."));
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "disabled");
});
t("GCP(E8): 503 두 번 뒤 200 → 세 번째에 성공", async () => {
  setup();
  sm.queue.push({ status: 503, text: "x" }, { status: 503, text: "x" });
  assert.deepEqual(await readDbSecret(GREF), { password: MARKER });
  assert.equal(sm.calls.length, 3);
});
t("GCP(E8): 503 세 번 → 저장소에 닿지 못함(네 번째는 없다)", async () => {
  setup();
  sm.reset({ status: 503, text: "x" });
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "unavailable");
  assert.equal(sm.calls.length, 3);
});
t("GCP(E9): 401 한 번 → 토큰을 새로 받아 성공", async () => {
  setup();
  sm.queue.push(gErr(401, "UNAUTHENTICATED", "Request had invalid authentication credentials."));
  meta.queue.push(TOKEN_OK, { ...TOKEN_OK, json: { access_token: "tok-2", expires_in: 3599, token_type: "Bearer" } });
  assert.deepEqual(await readDbSecret(GREF), { password: MARKER });
  assert.equal(meta.calls.length, 2);
  assert.equal(sm.calls[1].headers.authorization, "Bearer tok-2");
});
t("GCP(E9): 401 두 번 → 토큰은 한 번만 새로 받고 자격 없음", async () => {
  setup();
  sm.reset(gErr(401, "UNAUTHENTICATED", "Request had invalid authentication credentials."));
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "no_credentials");
  assert.equal(meta.calls.length, 2);
  assert.equal(sm.calls.length, 2);
});

// ── C. 기억 ──
t("기억: 토큰은 여러 시크릿이 같이 쓴다", async () => {
  setup();
  await readDbSecret(GREF);
  await readDbSecret("gcp-sm:my-project/other");
  assert.equal(meta.calls.length, 1);
  assert.equal(sm.calls.length, 2);
});
t("기억(E5): 5분 안은 다시 묻지 않고, 정확히 5분이면 다시 읽는다", async () => {
  setup();
  await readDbSecret(GREF);
  clock += SECRET_TTL_MS - 1;
  await readDbSecret(GREF);
  assert.equal(sm.calls.length, 1, "5분 안인데 저장소에 다시 물었다");
  clock += 1;
  await readDbSecret(GREF);
  assert.equal(sm.calls.length, 2, "5분이 됐는데 다시 읽지 않았다");
});
t("기억: fresh 는 기억을 건너뛴다", async () => {
  setup();
  await readDbSecret(GREF);
  await readDbSecret(GREF, { fresh: true });
  assert.equal(sm.calls.length, 2);
});
t("기억: 같은 참조를 동시에 읽으면 저장소에는 한 번", async () => {
  setup();
  sm.reset({ ...smValue(MARKER), delayMs: 50 });
  const [a, b] = await Promise.all([readDbSecret(GREF), readDbSecret(GREF)]);
  assert.deepEqual(a, b);
  assert.equal(sm.calls.length, 1);
});
t("기억: 5분 뒤 일시 오류면 기억한 값으로 버틴다", async () => {
  setup();
  await readDbSecret(GREF);
  clock += SECRET_TTL_MS;
  sm.reset({ status: 503, text: "x" }); // 호출 기록도 여기서 비운다
  assert.deepEqual(await readDbSecret(GREF), { password: MARKER });
  assert.equal(sm.calls.length, 3, "다시 읽기를 세 번 시도한 뒤에 버텨야 한다(묻지도 않고 옛 값을 쓰면 안 된다)");
});
t("기억(E6): 정확히 1시간이 지난 값으로는 버티지 않는다", async () => {
  setup();
  await readDbSecret(GREF);
  clock += SECRET_MAX_STALE_MS;
  sm.reset({ status: 503, text: "x" });
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "unavailable");
});
t("기억: 확정 오류(권한 없음)는 기억한 값이 있어도 낸다", async () => {
  setup();
  await readDbSecret(GREF);
  clock += SECRET_TTL_MS;
  sm.reset(gErr(403, "PERMISSION_DENIED", "Permission denied"));
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "permission_denied");
});
t("기억: fresh 는 일시 오류에 옛 값으로 버티지 않는다", async () => {
  setup();
  await readDbSecret(GREF);
  sm.reset({ status: 503, text: "x" });
  assert.equal((await reasonOf(readDbSecret(GREF, { fresh: true }))).reason, "unavailable");
});
t("기억(E4): 첫 읽기가 일시 오류면 버틸 값이 없어 낸다", async () => {
  setup();
  sm.reset({ status: 503, text: "x" });
  assert.equal((await reasonOf(readDbSecret(GREF))).reason, "unavailable");
});
t("기억: forget 하면 다음 읽기가 저장소에 묻는다", async () => {
  setup();
  await readDbSecret(GREF);
  forgetDbSecret(GREF);
  forgetDbSecret(null); // 없는 참조 · null 은 조용히 무시
  await readDbSecret(GREF);
  assert.equal(sm.calls.length, 2);
});
t("기억: 값이 바뀌면 «교체» 를 로그에 남긴다(값 없이)", async () => {
  setup();
  await readDbSecret(GREF);
  sm.reset(smValue(MARKER + "-rotated"));
  const before = logs.length;
  await readDbSecret(GREF, { fresh: true });
  assert.ok(logs.slice(before).some((l) => l.includes("바뀌었다")), "교체 로그가 없다");
});

t("값 판 번호: 첫 읽기 1 · 같은 값 다시 읽기는 그대로 · 바뀌면 오른다", async () => {
  setup();
  assert.equal(secretVersion(GREF), 0);
  await readDbSecret(GREF);
  assert.equal(secretVersion(GREF), 1);
  await readDbSecret(GREF, { fresh: true });
  assert.equal(secretVersion(GREF), 1, "같은 값인데 판 번호가 올랐다");
  sm.reset(smValue(MARKER + "-2"));
  await readDbSecret(GREF, { fresh: true });
  assert.equal(secretVersion(GREF), 2);
});
t("기억: 옛 값으로 버틴 뒤 30초는 저장소에 다시 묻지 않고, 지나면 다시 묻는다", async () => {
  setup();
  await readDbSecret(GREF);
  clock += SECRET_TTL_MS;
  sm.reset({ status: 503, text: "x" });
  await readDbSecret(GREF); // 버틴다(세 번 시도)
  assert.equal(sm.calls.length, 3);
  clock += SECRET_STALE_RETRY_MS - 1;
  assert.deepEqual(await readDbSecret(GREF), { password: MARKER });
  assert.equal(sm.calls.length, 3, "버티는 중인데 새 연결마다 저장소를 다시 기다렸다");
  clock += 1;
  assert.deepEqual(await readDbSecret(GREF), { password: MARKER });
  assert.equal(sm.calls.length, 6, "30초가 지났는데 다시 묻지 않았다");
});
t("GCP: 한 번 답한 메타데이터 서버의 일시 장애는 «자격 없음» 이 아니라 일시 오류 — 기억한 값으로 버틴다", async () => {
  setup();
  meta.reset({ ...TOKEN_OK, json: { access_token: "tok-1", expires_in: 600, token_type: "Bearer" } });
  await readDbSecret(GREF); // 메타데이터 서버가 답했다
  clock += 600_000; // 토큰도 기억도 지났다(1시간 안)
  metaBase = CLOSED_BASE;
  assert.deepEqual(await readDbSecret(GREF), { password: MARKER });
  const r = await reasonOf(readDbSecret(GREF, { fresh: true })); // fresh 는 버티지 않는다 — 까닭을 본다
  assert.equal(r.reason, "unavailable");
});
t("기억: fresh 읽기는 옛 값으로 버틸 수 있는 보통 읽기에 합류하지 않는다", async () => {
  setup();
  await readDbSecret(GREF);
  clock += SECRET_TTL_MS;
  sm.reset({ status: 503, text: "x", delayMs: 20 });
  const a = readDbSecret(GREF); // 보통 읽기 — 버틸 것이다
  const b = reasonOf(readDbSecret(GREF, { fresh: true })); // 같은 때의 fresh — 옛 값을 «새로 읽은 값» 으로 받으면 안 된다
  assert.deepEqual(await a, { password: MARKER });
  assert.equal((await b).reason, "unavailable");
});
t("GCP: 함께 기다린 토큰 받기가 실패하면 각자의 참조로 오류를 낸다", async () => {
  setup({ gcpMetadataBase: () => CLOSED_BASE });
  const other = "gcp-sm:my-project/other";
  const [r1, r2] = await Promise.all([reasonOf(readDbSecret(GREF)), reasonOf(readDbSecret(other))]);
  assert.ok(r1.message.includes(`(${GREF})`), r1.message);
  assert.ok(r2.message.includes(`(${other})`), r2.message);
});

// ── B · D. AWS ──
t("AWS: SigV4 서명한 GetSecretValue — 주소 · 머리 · 본문 · 값", async () => {
  setup();
  assert.deepEqual(await readDbSecret(AREF), { password: MARKER });
  assert.equal(awsCalls.length, 1);
  const c = awsCalls[0];
  assert.equal(c.url, "https://secretsmanager.ap-northeast-2.amazonaws.com/");
  assert.equal(c.method, "POST");
  assert.equal(c.headers["x-amz-target"], "secretsmanager.GetSecretValue");
  assert.equal(c.headers["content-type"], "application/x-amz-json-1.1");
  assert.match(c.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20261119\/ap-northeast-2\/secretsmanager\/aws4_request, SignedHeaders=/);
  assert.deepEqual(JSON.parse(c.body), { SecretId: "prod/db" });
});
t("AWS: ARN 참조 — SecretId 는 ARN, 주소는 ARN 의 리전", async () => {
  setup();
  const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf";
  await readDbSecret(`aws-sm:${arn}`);
  assert.equal(awsCalls[0].url, "https://secretsmanager.us-east-1.amazonaws.com/");
  assert.deepEqual(JSON.parse(awsCalls[0].body), { SecretId: arn });
});
t("AWS: 스테이징 라벨 · 버전 ID 가 본문으로", async () => {
  setup();
  await readDbSecret(`${AREF}#AWSPREVIOUS`);
  await readDbSecret(`${AREF}#3f2504e0-4f89-11d3-9a0c-0305e82c3301`);
  assert.deepEqual(JSON.parse(awsCalls[0].body), { SecretId: "prod/db", VersionStage: "AWSPREVIOUS" });
  assert.deepEqual(JSON.parse(awsCalls[1].body), { SecretId: "prod/db", VersionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" });
});
t("AWS: 중국 리전은 amazonaws.com.cn", async () => {
  setup();
  await readDbSecret("aws-sm:cn-north-1/prod/db");
  assert.equal(awsCalls[0].url, "https://secretsmanager.cn-north-1.amazonaws.com.cn/");
});
t("AWS: SecretBinary 는 base64 를 풀어 쓴다", async () => {
  setup();
  awsQueue.push({ status: 200, json: { Name: "prod/db", SecretBinary: b64(MARKER) } });
  assert.deepEqual(await readDbSecret(AREF), { password: MARKER });
});
t("AWS: RDS 가 관리하는 JSON 시크릿 → username + password", async () => {
  setup();
  awsQueue.push({ status: 200, json: { SecretString: JSON.stringify({ username: "admin", password: MARKER, engine: "postgres", host: "h", port: 5432 }) } });
  assert.deepEqual(await readDbSecret(AREF), { password: MARKER, username: "admin" });
});
t("AWS 까닭: 자격 없음 → 자격 없음(호출 안 함)", async () => {
  setup();
  awsCreds = async () => null;
  assert.equal((await reasonOf(readDbSecret(AREF))).reason, "no_credentials");
  assert.equal(awsCalls.length, 0);
});
const awsCase = (code: string, want: DbSecretReason, status = 400): void => {
  t(`AWS 까닭: ${code} → ${want}`, async () => {
    setup();
    awsQueue.push({ status, json: { __type: code, Message: "some message" } }, { status, json: { __type: code } }, { status, json: { __type: code } });
    assert.equal((await reasonOf(readDbSecret(AREF))).reason, want);
  });
};
awsCase("AccessDeniedException", "permission_denied");
awsCase("DecryptionFailure", "permission_denied");
awsCase("ResourceNotFoundException", "not_found");
awsCase("UnrecognizedClientException", "no_credentials");
awsCase("InvalidRequestException", "disabled");
awsCase("InternalServiceError", "unavailable", 500);

// ── 참조 꼴 ──
t("참조: 환경변수 이름은 저장소에서 읽지 않는다(배선 오류)", async () => {
  setup();
  assert.equal((await reasonOf(readDbSecret("ANALYTICS_PW"))).reason, "bad_ref");
  assert.equal(sm.calls.length + awsCalls.length + meta.calls.length, 0);
});
t("참조: 형식이 틀린 저장소 참조는 참조 형식 오류", async () => {
  setup();
  assert.equal((await reasonOf(readDbSecret("gcp-sm:Bad/x"))).reason, "bad_ref");
});
t("오류에 소스 이름 붙이기(withSource)", async () => {
  const e = new DbSecretError("permission_denied", GREF, "d", { providerCode: "403 PERMISSION_DENIED" }).withSource("analytics");
  assert.equal(e.reason, "permission_denied");
  assert.match(e.message, /^db source 'analytics' /);
  assert.match(e.message, /\[403 PERMISSION_DENIED\]$/);
});

let pass = 0;
try {
  for (const [name, fn] of tests) {
    await fn();
    pass++;
    console.log(`ok  ${name}`);
  }
  // 값 누출(부작용) — 이 시험 동안 남은 모든 로그 · 받은 모든 오류 문장에 시크릿 값이 없다.
  assert.ok(errors.length >= 25, `오류 문장 표본이 너무 적다(${errors.length}) — 관측 장치가 죽었다`);
  assert.ok(logs.length >= 10, `로그 표본이 너무 적다(${logs.length}) — 로거 가로채기가 죽었다`);
  const leakedLog = logs.find((l) => l.includes(MARKER));
  assert.equal(leakedLog, undefined, `로그에 시크릿 값이 실렸다: ${leakedLog?.slice(0, 200)}`);
  const leakedErr = errors.find((m) => m.includes(MARKER));
  assert.equal(leakedErr, undefined, `오류 문장에 시크릿 값이 실렸다: ${leakedErr?.slice(0, 200)}`);
  pass++;
  console.log(`ok  누출 없음 — 로그 ${logs.length}건 · 오류 ${errors.length}건 어디에도 시크릿 값이 없다`);
  console.log(`\n${pass} passed`);
} finally {
  __setSecretStoreDepsForTest(null);
  await meta.close();
  await sm.close();
}
