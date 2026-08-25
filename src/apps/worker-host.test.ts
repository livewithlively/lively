import { strict as assert } from "node:assert";
import test from "node:test";
import { buildWorkerSpawnPlan, normalizeWorkerFetchRequest, parseWorkerProtocolLine, WorkerBundleStager, WorkerHost, WorkerIsolationUnavailable, WORKER_LINE_MAX_BYTES } from "./worker-host.js";
import crypto from "node:crypto";

const base = { entryPath: "/private/tmp/run/worker.mjs", runDir: "/private/tmp/run", appId: "hello-app",
  instanceId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", memoryMb: 128,
  nodePath: "/opt/homebrew/bin/node" };

test("Darwin 계획은 sandbox-exec로 네트워크를 거부하고 부모 env를 상속하지 않는다", async () => {
  process.env.LIVELY_NODE_TOKEN = "must-not-leak";
  const p = await buildWorkerSpawnPlan({ ...base, platform: "darwin", exists: async (x) => x === "/usr/bin/sandbox-exec" });
  assert.equal(p.command, "/usr/bin/sandbox-exec");
  assert.equal(p.isolator, "sandbox-exec");
  assert.match(p.args.join(" "), /deny network/);
  assert.ok(p.args.includes(`--allow-fs-read=${base.entryPath}`));
  assert.ok(!p.args.includes("--allow-child-process"));
  assert.equal(p.env.LIVELY_NODE_TOKEN, undefined);
  assert.equal(p.env.LIVELY_APP_ID, "hello-app");
});

test("Linux 계획은 bwrap network namespace와 같은 Node permission 계약을 쓴다", async () => {
  const p = await buildWorkerSpawnPlan({ ...base, platform: "linux", exists: async (x) => x === "/usr/bin/bwrap" });
  assert.equal(p.command, "/usr/bin/bwrap");
  assert.ok(p.args.includes("--unshare-net"));
  assert.ok(p.args.includes("--permission"));
  assert.ok(!p.args.includes("--experimental-permission"));
});

test("격리기 없는 Linux와 Windows는 평문 Node 폴백 없이 fail closed", async () => {
  await assert.rejects(() => buildWorkerSpawnPlan({ ...base, platform: "linux", exists: async () => false }), WorkerIsolationUnavailable);
  await assert.rejects(() => buildWorkerSpawnPlan({ ...base, platform: "win32", exists: async () => true }), WorkerIsolationUnavailable);
});

test("JSONL 프로토콜은 다섯 메시지만 받고 깨진 JSON·미지 타입·64KiB 초과를 거부한다", () => {
  for (const t of ["ready", "heartbeat", "event", "request", "response"] as const) assert.equal(parseWorkerProtocolLine(JSON.stringify({ t })).t, t);
  assert.throws(() => parseWorkerProtocolLine("not-json"), /worker-json-invalid/);
  assert.throws(() => parseWorkerProtocolLine('{"t":"log"}'), /worker-message-unsupported/);
  assert.throws(() => parseWorkerProtocolLine("x".repeat(WORKER_LINE_MAX_BYTES + 1)), /worker-line-too-long/);
});

test("원격 번들은 1MiB 경계 아래 청크를 순서대로 받고 최종 해시로 조립한다", () => {
  const code = Buffer.from("x".repeat(700_000));
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  const stager = new WorkerBundleStager();
  const a = code.subarray(0, 512 * 1024);
  const b = code.subarray(512 * 1024);
  assert.deepEqual(stager.stage({ runId: base.runId, codeHash: hash, index: 0, total: 2, chunkBase64: a.toString("base64") }),
    { received: 1, total: 2, complete: false });
  assert.equal(stager.stage({ runId: base.runId, codeHash: hash, index: 1, total: 2, chunkBase64: b.toString("base64") }).complete, true);
  assert.deepEqual(stager.take(base.runId, hash), code);
});

test("원격 번들 스테이징은 순서 위반·변조 해시를 fail closed 한다", () => {
  const code = Buffer.from("safe-code");
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  const stager = new WorkerBundleStager();
  assert.throws(() => stager.stage({ runId: base.runId, codeHash: hash, index: 1, total: 2, chunkBase64: code.toString("base64") }), /order-invalid/);
  stager.stage({ runId: base.runId, codeHash: hash, index: 0, total: 1, chunkBase64: Buffer.from("tampered").toString("base64") });
  assert.throws(() => stager.take(base.runId, hash), /hash-mismatch/);
});

test("fetch RPC는 안전한 입력만 정규화하고 자격 헤더·큰 body를 거부한다", () => {
  const ok = normalizeWorkerFetchRequest({ t: "request", id: "r1", op: "fetch", input: { url: "https://example.com/x", method: "post", headers: { "content-type": "application/json" }, body: "{}" } });
  assert.equal(ok.method, "POST");
  assert.throws(() => normalizeWorkerFetchRequest({ t: "request", id: "r2", op: "fetch", input: { url: "https://example.com", headers: { Authorization: "secret" } } }), /header-forbidden/);
  assert.throws(() => normalizeWorkerFetchRequest({ t: "request", id: "r3", op: "fetch", input: { url: "https://example.com", body: "x".repeat(65 * 1024) } }), /body-too-large/);
});

test("번들 해시가 다르면 프로세스 준비 전에 거부한다", async () => {
  const code = Buffer.from('process.stdout.write("{\\"t\\":\\"ready\\"}\\n")');
  const host = new WorkerHost({ platform: "win32" });
  await assert.rejects(() => host.start({ runId: base.runId, appId: base.appId, instanceId: base.instanceId,
    entry: "dist/worker.mjs", code, codeHash: crypto.createHash("sha256").update(Buffer.from("different")).digest("hex"),
    memoryMb: 128, idleTimeoutSec: 30, allowedHosts: [], selfHosts: [] }), /worker-code-hash-mismatch/);
});
