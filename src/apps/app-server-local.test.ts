// 자가호스팅 앱 서버 실행면(#4487 앱 v2-8 2단계) 시험 — 로컬 함수 실행면(LambdaApi 겉면)이 Lambda 와 같은 약속을 지키는가.
//  컨테이너 겉면만 가짜다(ProcDriver — 같은 인자 검사기를 지난 뒤 «컨테이너» 대신 이 기계의 프로세스로 진짜 검사 층(guard.cjs)과 시험 앱을 띄운다).
//  판 풀기 · 검사 층 · 앱 · 흘려 받기 · 재우기 · 예산 · 작업 길은 운영 코드 그대로다. 진짜 Docker 로 띄우는 것은 별도 실측(as-built).
// 실행: npm run build && node dist/apps/app-server-local.test.js
//  행 이름 L1~L27 은 사양 엣지 표(#4487 PR 2 C절)의 행 번호다.
// @lively-test exclusive
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  LOCAL_BUCKET, LOCAL_BUILD_ZIP_MAX_BYTES, containerNameOf, localBuildRunner, localContainersOf, localHousekeeping, localLambdaApi, localLiveForTest, requestOfEvent,
  setLocalDepsForTest, sleepIdleLocalServers, type LocalDeps,
} from "./app-server-local.js";
import { DockerError, appRunArgs, type AppRunSpec, type BuildRunSpec, type ContainerDriver, type ContainerState, type ListedContainer } from "./app-server-docker.js";
import { assertSafeDockerRun, type DockerRunPolicy } from "../ops/docker-run-guard.js";
import { guardLayerZip, storeZip } from "./app-server-guard.js";
import { ed25519FromSeed, signAppIdentity } from "./app-identity.js";
import { jobCredential, jobInvokeEvent } from "./app-jobs-plan.js";
import { ZIP_MISSING_RE } from "./app-server-deploy.js";
import { LOCAL_ADAPTER_LAYER_ARN, smokeFailure } from "./app-server-config.js";
import { HTTP_INTEGRATION_CT } from "./app-server-stream.js";
import { AwsError } from "../net/aws/aws-json.js";
import type * as lam from "../net/aws/lambda-lite.js";

let pass = 0;
const tests: Array<[string, () => Promise<void>]> = [];
const t = (name: string, fn: () => Promise<void>): void => { tests.push([name, fn]); };

const WS = "11111111-2222-4333-8444-555555555555";
const IMAGE = "node:22-bookworm-slim", NET = "lvly-apps";
const key = ed25519FromSeed(crypto.createHash("sha256").update("app-server-local-test").digest());
const SDK_URL = new URL("../../public/sdk/lively-db.mjs", import.meta.url).href;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const exited = (p: ChildProcess): boolean => p.exitCode !== null || p.signalCode !== null;
const waitExit = (p: ChildProcess): Promise<void> => exited(p) ? Promise.resolve() : new Promise((r) => p.once("exit", () => r()));
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > end) throw new Error(`기다림 초과: ${what}`); await sleep(25); }
}

// ── 가짜 컨테이너 겉면 ──────────────────────────────────────────────────────────────────

interface FakeC { spec: AppRunSpec; guard: ChildProcess; app: ChildProcess; port: number; appPort: number; running: boolean; exitCode: number | null; log: string; startedAt: string; env: Record<string, string> }
const parseEnv = (text: string): Record<string, string> => Object.fromEntries(text.split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));

/** 컨테이너 대신 프로세스 — 인자는 운영과 같은 검사기를 지나야 띄운다. 검사 층은 판의 /opt/lively 원본에서 · 앱은 판 코드(/var/task 원본)의 시작 스크립트로. */
class ProcDriver implements ContainerDriver {
  readonly c = new Map<string, FakeC>();
  readonly runs: AppRunSpec[] = [];
  failRun: string | null = null;
  failRunOnce: string | null = null;   // 다음 runApp 한 번만 이 글로 실패(네트워크·이미지 사라짐 흉내)
  nets = 0;                            // ensureNetwork 가 불린 수(prepared 재준비 확인)
  async info(): Promise<{ memMb: number; cpus: number }> { return { memMb: 8192, cpus: 4 }; }
  async ensureImage(): Promise<void> { /* 없음 */ }
  async ensureNetwork(): Promise<void> { this.nets++; }
  async runApp(spec: AppRunSpec, policy: DockerRunPolicy): Promise<{ port: number }> {
    assertSafeDockerRun(appRunArgs(spec), policy);
    this.runs.push(spec);
    if (this.failRunOnce) { const m = this.failRunOnce; this.failRunOnce = null; throw new DockerError(`docker run 실패: ${m}`); }
    if (this.failRun) throw new DockerError(`docker run 실패: ${this.failRun}`);
    if (this.c.has(spec.name)) throw new DockerError(`docker run 실패: Conflict. The container name "/${spec.name}" is already in use`);
    const env = parseEnv(fs.readFileSync(spec.envFile, "utf8"));
    const code = spec.ro.find((m) => m.target === "/var/task")!.host;
    const opt = spec.ro.find((m) => m.target === "/opt/lively")!.host;
    const port = await freePort(), appPort = await freePort();
    const penv = { PATH: process.env.PATH ?? "", ...env, LIVELY_GUARD_HOST: "127.0.0.1", LIVELY_GUARD_PORT: String(port), PORT: String(appPort), LAMBDA_TASK_ROOT: code };
    const guard = spawn(process.execPath, [path.join(opt, "guard.cjs")], { env: penv, stdio: ["ignore", "pipe", "pipe"] });
    const app = spawn("/bin/sh", [path.join(code, env._HANDLER ?? "lively-run.sh")], { cwd: code, env: penv, stdio: ["ignore", "pipe", "pipe"] });
    const fc: FakeC = { spec, guard, app, port, appPort, running: true, exitCode: null, log: "", startedAt: new Date().toISOString(), env: penv };
    const cap = (d: Buffer): void => { fc.log = (fc.log + d.toString("utf8")).slice(-20_000); };
    for (const p of [guard, app]) { p.stdout!.on("data", cap); p.stderr!.on("data", cap); }
    app.on("exit", (c) => { fc.running = false; fc.exitCode = c ?? 137; if (!exited(guard)) guard.kill("SIGKILL"); });
    guard.on("exit", () => { if (fc.running) { fc.running = false; fc.exitCode = 1; if (!exited(app)) app.kill("SIGKILL"); } });
    this.c.set(spec.name, fc);
    return { port };
  }
  async state(name: string): Promise<ContainerState | null> {
    const fc = this.c.get(name);
    return fc ? { running: fc.running, exitCode: fc.running ? null : fc.exitCode, oomKilled: false, startedAt: fc.startedAt } : null;
  }
  async logs(name: string): Promise<string> { return this.c.get(name)?.log ?? ""; }
  async remove(name: string): Promise<void> {
    const fc = this.c.get(name);
    if (!fc) return;
    this.c.delete(name);
    for (const p of [fc.app, fc.guard]) if (!exited(p)) p.kill("SIGKILL");
    await Promise.all([waitExit(fc.app), waitExit(fc.guard)]);
  }
  async list(label: string): Promise<ListedContainer[]> {
    const [k, v] = label.split("=") as [string, string];
    return [...this.c.entries()].filter(([, fc]) => fc.spec.labels[k] === v).map(([name, fc]) => ({ name, labels: { ...fc.spec.labels }, running: fc.running, port: fc.running ? fc.port : null }));
  }
  spawnBuild(): ChildProcess { throw new Error("이 시험 겉면은 빌드를 띄우지 않는다"); }
  buildOutInContainer(spec: BuildRunSpec): string { return spec.outDir; }
  /** 게이트웨이 몰래 컨테이너가 죽는다(메모리 · 사람이 docker kill). */
  async crash(name: string): Promise<void> { const fc = this.c.get(name)!; fc.app.kill("SIGKILL"); await Promise.all([waitExit(fc.app), waitExit(fc.guard)]); }
  async stopAll(): Promise<void> { for (const n of [...this.c.keys()]) await this.remove(n); }
}

// ── 시험 앱 · 가짜 게이트웨이 ──────────────────────────────────────────────────────────

/** 시험 앱 — APP_MODE(exit · noport)로 시작을 망가뜨린다. 요청마다 받은 것을 그대로 돌려준다(SDK livelyMember · 열쇠가 맞는지 포함). */
const SERVER_MJS = `import http from "node:http";
import { livelyMember } from ${JSON.stringify(SDK_URL)};
const mode = process.env.APP_MODE || "";
if (mode === "exit") { console.error("boom: app failed to start"); process.exit(3); }
if (mode === "noport") { setInterval(() => {}, 1 << 30); }
else {
  http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", async () => {
      console.log("REQ " + req.url);
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/slow") await new Promise((r) => setTimeout(r, Number(u.searchParams.get("ms") || 1000)));
      if (u.pathname === "/die") process.exit(9);
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.writeHead(Number(u.searchParams.get("status") || 200), { "content-type": "application/json", "x-app": "yes" });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body_b64: Buffer.concat(parts).toString("base64"),
        member: livelyMember(req), keyOk: !!process.env.LIVELY_GUARD_KEY && req.headers["x-lively-guard-key"] === process.env.LIVELY_GUARD_KEY, pid: process.pid }));
    });
  }).listen(Number(process.env.PORT || 8080), "127.0.0.1");
}
`;
const APP_ZIP = storeZip([
  { name: "lively-run.sh", data: Buffer.from("#!/bin/sh\nexec node server.mjs\n"), mode: 0o755 },
  { name: "server.mjs", data: Buffer.from(SERVER_MJS), mode: 0o644 },
]);

interface ApiCall { path: string; headers: http.IncomingHttpHeaders; body: unknown }
/** 가짜 게이트웨이(작업 길) — claim · tick · result 에 정해진 답. */
async function startApi(): Promise<{ url: string; calls: ApiCall[]; close: () => Promise<void> }> {
  const calls: ApiCall[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; });
    req.on("end", () => {
      const m = /^\/api\/app-jobs\/(\d+)\/(claim|tick|result)$/.exec(req.url ?? "");
      calls.push({ path: req.url ?? "", headers: req.headers, body: body ? JSON.parse(body) : null });
      if (!m) { res.writeHead(404).end(); return; }
      const reply = m[2] === "claim" ? { job: Number(m[1]), run: jobCredential("run", Number(m[1]), "R".repeat(43)), member: "윤상민", member_name: "윤 상민", variant: "pub", timeout_s: 30, tick_s: 1 }
        : m[2] === "tick" ? { cancel: false } : { ok: true, status: "done" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

// ── 판 · 부르기 도우미 ──────────────────────────────────────────────────────────────────

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asl-")));
let skew = 0;
const now = (): number => Date.now() + skew;
let cur: Rig | null = null;
interface Rig {
  root: string; driver: ProcDriver; api: ReturnType<typeof localLambdaApi>; layerArn: string; deps: LocalDeps;
  notes: Array<{ appId: string; title: string; body: string }>; st: { budgetMb: number; idleMin: number; appIdle: Record<string, number | null>; pins: Record<string, string[]> };
  mkFn(appId: string, o?: { env?: Record<string, string>; mem?: number; timeout?: number; layer?: string }): Promise<{ fn: string; version: string }>;
}
async function setup(o: { budgetMb?: number; readyMs?: number; apiUrl?: string } = {}): Promise<Rig> {
  await cur?.driver.stopAll();
  skew = 0;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(work, "r-")));
  const driver = new ProcDriver();
  const notes: Rig["notes"] = [];
  const st: Rig["st"] = { budgetMb: o.budgetMb ?? 4096, idleMin: 10, appIdle: {}, pins: {} };
  const deps: LocalDeps = {
    driver, root, now, image: IMAGE, network: NET, user: "1000:1000", boxCeilingMb: 8192, readyTimeoutMs: o.readyMs ?? 15_000,
    policy: async () => ({ local_memory_mb: st.budgetMb, idle_sleep_min: st.idleMin }),
    appIdle: async (a) => st.appIdle[a] ?? null,
    jobPins: async (a) => st.pins[a] ?? [],
    notify: async (appId, title, body) => { notes.push({ appId, title, body }); },
  };
  setLocalDepsForTest(deps);
  const api = localLambdaApi({});
  const layer = await api.publishLayerVersion("lvly-app-guard", { zip: guardLayerZip().zip, description: "guard", architectures: ["arm64"] });
  const rig: Rig = {
    root, driver, api, layerArn: layer.LayerVersionArn, deps, notes, st,
    async mkFn(appId, f = {}) {
      const fn = `lvly-app-${appId}-w`;
      const zipKey = `t/${appId}.zip`;
      fs.mkdirSync(path.join(root, "zips", "t"), { recursive: true });
      fs.writeFileSync(path.join(root, "zips", zipKey), APP_ZIP);
      await api.createFunction({
        FunctionName: fn, Runtime: IMAGE, Role: "lively-local:role", Handler: "lively-run.sh", Code: { S3Bucket: LOCAL_BUCKET, S3Key: zipKey }, Architectures: ["arm64"],
        MemorySize: f.mem ?? 512, Timeout: f.timeout ?? 30, Layers: [LOCAL_ADAPTER_LAYER_ARN, f.layer ?? layer.LayerVersionArn],
        Environment: { Variables: { LIVELY_TENANT_ID: WS, LIVELY_APP_ID: appId, LIVELY_APP_IDENTITY_PUBKEYS: JSON.stringify({ k1: key.publicKeyB64 }),
          LIVELY_APP_TOKEN: "app-token-1", ...(o.apiUrl ? { LIVELY_API_URL: o.apiUrl } : {}), ...(f.env ?? {}) } },
        Tags: { "lvly:app": appId },
      });
      const v = await api.publishVersion(fn, {});
      await api.putAlias(fn, "cur", v.Version!, "");
      return { fn, version: v.Version! };
    },
  };
  cur = rig;
  return rig;
}
const secs = (): number => Math.floor(Date.now() / 1000);
const personTok = (appId: string): string => signAppIdentity({ ws: WS, app: appId, var: "pub", sub: "sangmin-yoon", name: "윤상민", iat: secs() - 5, exp: secs() + 595 }, key.privateKey, "k1");
const personEvent = (appId: string, p: string, o: { method?: string; query?: string; headers?: Record<string, string>; cookies?: string[]; body?: Buffer } = {}): string => JSON.stringify({
  version: "2.0", rawPath: p, rawQueryString: o.query ?? "", headers: { "x-lively-identity": personTok(appId), ...(o.headers ?? {}) }, cookies: o.cookies,
  requestContext: { http: { method: o.method ?? "GET" }, requestId: "r1" }, body: o.body ? o.body.toString("base64") : undefined, isBase64Encoded: !!o.body,
});
interface Got { prelude?: { statusCode: number; headers: Record<string, string>; cookies: string[] }; body?: Buffer; error?: { errorType: string; errorMessage: string }; log: string; executedVersion: string | null }
async function collect(out: lam.StreamInvokeOut): Promise<Got> {
  const chunks: Buffer[] = [];
  let log = "";
  for await (const ev of out.events) { if (ev.type === "chunk") chunks.push(ev.data); else log = ev.log; }
  const all = Buffer.concat(chunks);
  if (out.contentType !== HTTP_INTEGRATION_CT) return { error: JSON.parse(all.toString("utf8")), log, executedVersion: out.executedVersion };
  const cut = all.indexOf(Buffer.alloc(8));
  return { prelude: JSON.parse(all.subarray(0, cut).toString("utf8")), body: all.subarray(cut + 8), log, executedVersion: out.executedVersion };
}
const call = async (r: Rig, fn: string, ev: string, q = "cur"): Promise<Got> => collect(await r.api.invokeStream(fn, q, ev, { timeoutMs: 20_000 }));
const echo = (g: Got): { method: string; url: string; headers: Record<string, string>; body_b64: string; member: { id: string } | null; keyOk: boolean; pid: number } => JSON.parse(g.body!.toString("utf8"));
const awsErr = (status: number, code: string) => (e: unknown): boolean => e instanceof AwsError && e.status === status && e.code === code;

// ── 행 ─────────────────────────────────────────────────────────────────────────────────

t("L1 같은 이름 다시 만들기 409 · 없는 함수 조회 null · 없는 함수 지우기 조용", async () => {
  const r = await setup();
  await r.mkFn("dup-app");
  await assert.rejects(r.mkFn("dup-app"), awsErr(409, "ResourceConflictException"));
  assert.equal(await r.api.getFunction("lvly-app-nope-w"), null);
  assert.equal(await r.api.getFunction("lvly-app-dup-app-w", "77"), null);
  assert.equal(await r.api.getFunctionConfiguration("lvly-app-nope-w"), null);
  await r.api.deleteFunction("lvly-app-nope-w");
});

t("L2 zip 저장소에 zip 없음 — 배포가 «빌드 무효» 로 읽는 글", async () => {
  const r = await setup();
  const make = r.api.createFunction({ FunctionName: "lvly-app-nozip-w", Runtime: IMAGE, Role: "x", Handler: "lively-run.sh", Code: { S3Bucket: LOCAL_BUCKET, S3Key: "t/none.zip" },
    Architectures: ["arm64"], MemorySize: 512, Timeout: 30, Layers: [], Environment: { Variables: {} } });
  await assert.rejects(make, (e: unknown) => e instanceof AwsError && ZIP_MISSING_RE.test(e.message));
  await assert.rejects(r.api.createFunction({ FunctionName: "lvly-app-bad-w", Runtime: IMAGE, Role: "x", Handler: "h", Code: { S3Bucket: LOCAL_BUCKET, S3Key: "../../etc/passwd.zip" },
    Architectures: ["arm64"], MemorySize: 512, Timeout: 30, Layers: [], Environment: { Variables: {} } }), awsErr(400, "InvalidParameterValueException"));
});

t("L3 판 고정 — 코드 풀림 · 같은 설정이면 같은 판 · 설정 바뀌면 새 판 · CodeSha256 틀림 412", async () => {
  const r = await setup();
  const { fn, version } = await r.mkFn("pub-app");
  assert.equal(version, "1");
  const code = path.join(r.root, "fn", "00000000-0000-0000-0000-000000000000", fn, "v", "1", "code");
  assert.equal(fs.readFileSync(path.join(code, "server.mjs"), "utf8"), SERVER_MJS);
  assert.equal(fs.statSync(path.join(code, "lively-run.sh")).mode & 0o777, 0o755);
  assert.equal((await r.api.publishVersion(fn, {})).Version, "1", "같은 설정 — 같은 판");
  await r.api.updateFunctionConfiguration(fn, { Timeout: 60 });
  assert.equal((await r.api.publishVersion(fn, {})).Version, "2", "설정 바뀜 — 새 판");
  const cfg = await r.api.getFunctionConfiguration(fn, "2");
  assert.equal(cfg?.Timeout, 60);
  assert.equal((await r.api.getFunctionConfiguration(fn, "1"))?.Timeout, 30, "옛 판은 옛 설정");
  await assert.rejects(r.api.publishVersion(fn, { CodeSha256: "AAAA" }), awsErr(412, "PreconditionFailedException"));
  const vs = await r.api.listVersions(fn);
  assert.deepEqual(vs.map((v) => v.Version), ["$LATEST", "1", "2"]);
});

t("L4 없는 판 별칭 404 · 별칭으로 부르면 그 판", async () => {
  const r = await setup();
  const { fn } = await r.mkFn("alias-app");
  await assert.rejects(r.api.putAlias(fn, "cur", "99", ""), awsErr(404, "ResourceNotFoundException"));
  const g = await call(r, fn, personEvent("alias-app", "/echo"));
  assert.equal(g.executedVersion, "1");
  assert.equal(g.prelude?.statusCode, 200);
});

t("L5 사건 → 앱이 받은 요청이 그대로 · 앞머리(상태 · 머리글 · set-cookie 배열) + 본문 + REPORT", async () => {
  const r = await setup();
  const { fn } = await r.mkFn("echo-app");
  const body = Buffer.from([0, 1, 2, 255, 0x41]);
  const g = await call(r, fn, personEvent("echo-app", "/echo", { method: "POST", query: "a=1&b=%ED%95%9C",
    headers: { "x-custom": "값", "content-type": "application/octet-stream", "x-inject": "a\r\nx-evil: 1", "bad name": "1" }, cookies: ["c1=1", "c2=2", "c3=\r\nx"], body }));
  assert.equal(g.prelude!.statusCode, 200);
  assert.equal(g.prelude!.headers["x-app"], "yes");
  assert.deepEqual(g.prelude!.cookies, ["a=1; Path=/", "b=2; Path=/"]);
  const e = echo(g);
  assert.equal(e.method, "POST");
  assert.equal(e.url, "/echo?a=1&b=%ED%95%9C");
  assert.equal(Buffer.from(e.headers["x-custom"]!, "latin1").toString("utf8"), "값", "한글 머리글은 UTF-8 바이트 그대로(Lambda 와 같다)");
  assert.equal(e.headers["x-inject"], undefined, "줄바꿈 든 머리글은 버린다");
  assert.equal(e.headers["x-evil"], undefined);
  assert.equal(e.headers.cookie, "c1=1; c2=2", "줄바꿈 든 쿠키는 버린다");
  assert.equal(Buffer.from(e.body_b64, "base64").toString("hex"), body.toString("hex"));
  assert.match(g.log, /REPORT RequestId: \S+\tDuration: [\d.]+ ms\tBilled Duration: \d+ ms\tMemory Size: 512 MB\tInit Duration: [\d.]+ ms\t$/, "처음 부르기 — Init Duration");
  const g2 = await call(r, fn, personEvent("echo-app", "/echo"));
  assert.doesNotMatch(g2.log, /Init Duration|Status:/, "깨어 있는 컨테이너 — Init 없음 · 성공");
  assert.equal(echo(g2).pid, e.pid, "같은 컨테이너");
  //  순수 변환 — 들어온 content-length · x-amzn-lambda-context 는 버리고 새로 단다
  const q = requestOfEvent({ rawPath: "x", headers: { "Content-Length": "999", "X-Amzn-Lambda-Context": "{}", Host: "h" }, body: "abc" }, 123, "arn", "id");
  assert.equal(q.path, "/x");
  assert.equal(q.headers["content-length"], "3");
  assert.equal(JSON.parse(q.headers["x-amzn-lambda-context"]!).deadline, 123);
  assert.equal(q.headers.host, "h");
});

t("L6 마감 — 앱이 받은 x-amzn-lambda-context deadline ≈ 지금 + Timeout", async () => {
  const r = await setup();
  const { fn } = await r.mkFn("dl-app", { timeout: 40 });
  const t0 = Date.now();
  const e = echo(await call(r, fn, personEvent("dl-app", "/echo")));
  const ctx = JSON.parse(e.headers["x-amzn-lambda-context"]!) as { deadline: number; invoked_function_arn: string };
  assert.ok(ctx.deadline >= t0 + 40_000 - 100 && ctx.deadline <= Date.now() + 40_000, `deadline ${ctx.deadline - t0}ms`);
  assert.equal(ctx.invoked_function_arn, `lively-local:function:${fn}:1`);
});

t("L7 앱이 시작하자마자 끝남 — Runtime.ExitError · 기록 · REPORT error · 컨테이너 걷힘 · 배포 글", async () => {
  const r = await setup();
  const { fn, version } = await r.mkFn("exit-app", { env: { APP_MODE: "exit" } });
  const g = await call(r, fn, personEvent("exit-app", "/echo"));
  assert.equal(g.error?.errorType, "Runtime.ExitError");
  assert.match(g.error!.errorMessage, /exit status 3/);
  assert.match(g.log, /boom: app failed to start/);
  assert.match(g.log, /Status: error\tError Type: Runtime\.ExitError/);
  assert.equal(r.driver.c.has(containerNameOf(fn, version)), false, "죽은 컨테이너가 남았다");
  assert.match(smokeFailure("Unhandled", JSON.stringify(g.error), g.log)!, /시작하자마자/);
});

t("L8 앱이 포트를 안 엶 — 준비 시간 뒤 «did not become ready» · 배포 글은 PORT", async () => {
  const r = await setup({ readyMs: 1500 });
  const { fn, version } = await r.mkFn("noport-app", { env: { APP_MODE: "noport" } });
  const g = await call(r, fn, personEvent("noport-app", "/echo"));
  assert.equal(g.error?.errorType, "Extension.Crash");
  assert.match(g.log, /did not become ready within 2s/);
  assert.match(smokeFailure("Unhandled", JSON.stringify(g.error), g.log)!, /PORT/);
  assert.equal(r.driver.c.has(containerNameOf(fn, version)), false);
});

t("L9 동시 실행 0 — 컨테이너 내림 · 부르기 429 · 풀면 다시 뜸", async () => {
  const r = await setup();
  const { fn, version } = await r.mkFn("stop-app");
  await call(r, fn, personEvent("stop-app", "/echo"));
  assert.ok(r.driver.c.has(containerNameOf(fn, version)));
  await r.api.putConcurrency(fn, 0);
  assert.equal(r.driver.c.size, 0, "멈췄는데 컨테이너가 남았다");
  assert.equal((await r.api.getFunction(fn))?.Concurrency?.ReservedConcurrentExecutions, 0);
  await assert.rejects(r.api.invokeStream(fn, "cur", personEvent("stop-app", "/echo"), { timeoutMs: 5000 }), awsErr(429, "TooManyRequestsException"));
  await assert.rejects(r.api.invokeAsync(fn, "cur", {}), awsErr(429, "TooManyRequestsException"));
  await r.api.deleteConcurrency(fn);
  const g = await call(r, fn, personEvent("stop-app", "/echo"));
  assert.equal(g.prelude?.statusCode, 200);
  assert.match(g.log, /Init Duration/);
});

t("L10 재우기 — 시간 지남 · 처리 중 · 열린 작업 판 · 안 재움 · 앱별 값 · 다시 부르면 깨어남", async () => {
  const r = await setup();
  const a = await r.mkFn("idle-a");
  const name = containerNameOf(a.fn, a.version);
  await call(r, a.fn, personEvent("idle-a", "/echo"));
  skew += 9 * 60_000;
  assert.deepEqual((await sleepIdleLocalServers({})).slept, [], "9분 — 아직");
  skew += 2 * 60_000;
  assert.deepEqual((await sleepIdleLocalServers({})).slept, [name], "11분 — 재운다(기본 10분)");
  assert.equal(r.driver.c.has(name), false);
  const g = await call(r, a.fn, personEvent("idle-a", "/echo"));
  assert.match(g.log, /Init Duration/, "다시 부르면 깨어난다");
  //  처리 중이면 안 재운다
  const slow = call(r, a.fn, personEvent("idle-a", "/slow", { query: "ms=1500" }));
  await until("처리 중", () => localLiveForTest().some((c) => c.name === name && c.inflight === 1));
  skew += 30 * 60_000;
  assert.deepEqual((await sleepIdleLocalServers({})).slept, [], "처리 중 — 안 재운다");
  await slow;
  //  열린 작업이 그 판을 쓰면 안 재운다(그리고 «한가한 시각» 을 지금으로)
  skew += 30 * 60_000;
  r.st.pins["idle-a"] = [a.version];
  assert.deepEqual((await sleepIdleLocalServers({})).slept, [], "열린 작업 판 — 안 재운다");
  r.st.pins["idle-a"] = [];
  assert.deepEqual((await sleepIdleLocalServers({})).slept, [], "방금 작업 판이라 한가한 시각이 지금이 됐다");
  //  안 재움(0)
  r.st.appIdle["idle-a"] = 0;
  skew += 24 * 60 * 60_000;
  assert.deepEqual((await sleepIdleLocalServers({})).slept, [], "안 재움");
  //  앱별 값이 기본보다 앞선다 — 30분
  r.st.appIdle["idle-a"] = 30;
  await call(r, a.fn, personEvent("idle-a", "/echo"));
  skew += 20 * 60_000;
  assert.deepEqual((await sleepIdleLocalServers({})).slept, [], "앱별 30분 — 20분엔 아직(기본 10분이면 재웠다)");
  skew += 11 * 60_000;
  assert.deepEqual((await sleepIdleLocalServers({})).slept, [name], "31분 — 재운다");
  assert.deepEqual(localContainersOf(a.fn), []);
});

t("L11 예산 — 오래 쉰 것부터 내림 · 못 내리면 429(까닭) + 알림 한 번 · 예산보다 큰 앱", async () => {
  const r = await setup({ budgetMb: 1024 });
  const a = await r.mkFn("bud-a"), b = await r.mkFn("bud-b"), c = await r.mkFn("bud-c");
  await call(r, a.fn, personEvent("bud-a", "/echo"));
  skew += 1000;
  await call(r, b.fn, personEvent("bud-b", "/echo"));
  skew += 1000;
  await call(r, c.fn, personEvent("bud-c", "/echo"));
  assert.equal(r.driver.c.has(containerNameOf(a.fn, "1")), false, "가장 오래 쉰 a 를 내렸어야 한다");
  assert.ok(r.driver.c.has(containerNameOf(b.fn, "1")) && r.driver.c.has(containerNameOf(c.fn, "1")));
  r.st.appIdle["bud-b"] = 0;
  r.st.pins["bud-c"] = ["1"];
  await assert.rejects(r.api.invokeStream(a.fn, "cur", personEvent("bud-a", "/echo"), { timeoutMs: 5000 }),
    (e: unknown) => e instanceof AwsError && e.status === 429 && e.code === "TooManyRequestsException" && /예산이 다 찼습니다/.test(e.message));
  await assert.rejects(r.api.invokeStream(a.fn, "cur", personEvent("bud-a", "/echo"), { timeoutMs: 5000 }), awsErr(429, "TooManyRequestsException"));
  await until("알림", () => r.notes.length >= 1);
  await sleep(50);
  assert.equal(r.notes.length, 1, "알림은 한 시간에 한 번");
  assert.equal(r.notes[0]!.appId, "bud-a");
  const big = await r.mkFn("bud-big", { mem: 2048 });
  await assert.rejects(r.api.invokeStream(big.fn, "cur", personEvent("bud-big", "/echo"), { timeoutMs: 5000 }), (e: unknown) => e instanceof AwsError && /예산\(1024MB\)보다 큽니다/.test(e.message));
});

t("L12 판 지우기 — 그 판 컨테이너 내림 · 별칭이 가리키는 판은 409", async () => {
  const r = await setup();
  const { fn } = await r.mkFn("del-app");
  await assert.rejects(r.api.deleteFunction(fn, "1"), awsErr(409, "ResourceConflictException"));
  await r.api.updateFunctionConfiguration(fn, { Timeout: 31 });
  const v2 = (await r.api.publishVersion(fn, {})).Version!;
  await r.api.putAlias(fn, "cur", v2, "");
  await call(r, fn, personEvent("del-app", "/echo"), "1");
  await call(r, fn, personEvent("del-app", "/echo"), "cur");
  assert.ok(r.driver.c.has(containerNameOf(fn, "1")) && r.driver.c.has(containerNameOf(fn, v2)));
  await r.api.deleteFunction(fn, "1");
  assert.equal(r.driver.c.has(containerNameOf(fn, "1")), false);
  assert.ok(r.driver.c.has(containerNameOf(fn, v2)), "다른 판은 그대로");
  assert.equal(await r.api.getFunction(fn, "1"), null);
});

t("L13 함수 지우기 — 컨테이너 · 폴더 다 걷힘", async () => {
  const r = await setup();
  const { fn } = await r.mkFn("gone-app");
  await call(r, fn, personEvent("gone-app", "/echo"));
  await r.api.deleteFunction(fn);
  assert.equal(r.driver.c.size, 0);
  assert.equal(fs.existsSync(path.join(r.root, "fn", "00000000-0000-0000-0000-000000000000", fn)), false);
  assert.equal(await r.api.getFunction(fn), null);
});

t("L14 비동기 부르기 — 곧바로 202 · 검사 층 작업 길(claim → 앱 → 결과 보고)", async () => {
  const api = await startApi();
  try {
    const r = await setup({ apiUrl: api.url });
    const { fn } = await r.mkFn("job-app");
    const ev = jobInvokeEvent({ id: 7, route: "/slow?ms=1500&x=1", body: JSON.stringify({ n: 1 }), attempts: 0 }, jobCredential("call", 7, "S".repeat(43)), "job-app.example", Date.now());
    const t0 = Date.now();
    const out = await r.api.invokeAsync(fn, "cur", ev);
    assert.equal(out.status, 202);
    assert.ok(Date.now() - t0 < 1000, "깨우기를 기다리지 않고 곧바로 돌려준다");
    await until("결과 보고", () => api.calls.some((c) => c.path === "/api/app-jobs/7/result"), 15_000);
    const res = api.calls.find((c) => c.path === "/api/app-jobs/7/result")!.body as { outcome: string; status_code: number; body_b64: string };
    assert.equal(res.outcome, "response");
    assert.equal(res.status_code, 200);
    const seen = JSON.parse(Buffer.from(res.body_b64, "base64").toString("utf8")) as { url: string; member: { id: string; job: number }; headers: Record<string, string> };
    assert.equal(seen.url, "/slow?ms=1500&x=1");
    assert.deepEqual([seen.member.id, seen.member.job], ["윤상민", 7], "앱은 작업을 시작한 사람으로 받는다");
    assert.equal(api.calls.find((c) => c.path.endsWith("/claim"))!.headers.authorization, "Bearer app-token-1");
  } finally { await api.close(); }
});

t("L26 네트워크·이미지가 사라지면(운영자 prune) prepared 캐시를 지우고 다시 준비해 한 번 다시 띄운다", async () => {
  const r = await setup();
  const { fn } = await r.mkFn("prune-app");
  //  첫 깨우기로 네트워크 준비가 캐시된다(nets 1). 그다음 네트워크가 사라진 것처럼 runApp 이 한 번 실패하면, 다시 준비(nets 2)하고 다시 띄워 200.
  await call(r, fn, personEvent("prune-app", "/echo"));
  const netsAfterFirst = r.driver.nets;
  await r.api.putConcurrency(fn, 0);   // 컨테이너를 내려 다음 부르기가 새로 띄우게
  await r.api.deleteConcurrency(fn);
  r.driver.failRunOnce = "docker: Error response from daemon: network lvly-apps not found";
  const g = await call(r, fn, personEvent("prune-app", "/echo"));
  assert.equal(g.prelude?.statusCode, 200, JSON.stringify(g.error ?? g.prelude));
  assert.ok(r.driver.nets > netsAfterFirst, "prepared 를 지우고 네트워크를 다시 준비하지 않았다");
});

t("L25 비동기 부르기 — 깨어 있던 컨테이너가 죽었으면 한 번 다시 띄워 보낸다(동기 길과 같게)", async () => {
  const api = await startApi();
  try {
    const r = await setup({ apiUrl: api.url });
    const { fn, version } = await r.mkFn("ajob-app");
    //  먼저 한 번 띄워 live 에 넣고(동기), 게이트웨이 몰래 죽인다 — live 에는 죽은 항목이 남는다.
    const p1 = echo(await call(r, fn, personEvent("ajob-app", "/echo"))).pid;
    await r.driver.crash(containerNameOf(fn, version));
    await sleep(100);
    const ev = jobInvokeEvent({ id: 9, route: "/quick", body: JSON.stringify({ n: 1 }), attempts: 0 }, jobCredential("call", 9, "S".repeat(43)), "ajob-app.example", Date.now());
    const out = await r.api.invokeAsync(fn, "cur", ev);
    assert.equal(out.status, 202);
    await until("결과 보고", () => api.calls.some((c) => c.path === "/api/app-jobs/9/result"), 15_000);
    assert.equal(r.driver.runs.length, 2, "죽은 컨테이너를 걷고 새로 띄웠다");
    assert.equal((api.calls.find((c) => c.path === "/api/app-jobs/9/result")!.body as { outcome: string }).outcome, "response");
    assert.notEqual(echo(await call(r, fn, personEvent("ajob-app", "/echo"))).pid, p1, "새 컨테이너");
  } finally { await api.close(); }
});

t("L15 서명 신원인데 공개 키가 없음(자가호스팅 = claim 만) — 검사 층 401 · 앱에 안 닿음", async () => {
  const r = await setup();
  const { fn, version } = await r.mkFn("nokey-app", { env: { LIVELY_APP_IDENTITY_PUBKEYS: "{}" } });
  const g = await call(r, fn, personEvent("nokey-app", "/echo"));
  assert.equal(g.prelude?.statusCode, 401);
  assert.equal(g.prelude?.headers["x-lively-guard"], "denied");
  assert.doesNotMatch(r.driver.c.get(containerNameOf(fn, version))!.log, /REQ /, "앱에 닿았다");
  const forged = await call(r, fn, JSON.stringify({ rawPath: "/echo", headers: { "x-lively-member": "admin" }, requestContext: { http: { method: "GET" } } }));
  assert.equal(forged.prelude?.statusCode, 401);
});

t("L16 검사 층을 거친 요청은 열쇠가 맞아 SDK 가 사람으로 · 앱 포트로 바로 보낸 요청은 SDK null", async () => {
  const r = await setup();
  const { fn, version } = await r.mkFn("key-app");
  const e = echo(await call(r, fn, personEvent("key-app", "/echo")));
  assert.equal(e.keyOk, true);
  assert.equal(e.member?.id, "sangmin-yoon");
  const appPort = r.driver.c.get(containerNameOf(fn, version))!.appPort;
  for (const h of [{ "x-lively-member": "admin" }, { "x-lively-member": "admin", "x-lively-guard-key": "wrong-key" }]) {
    const direct = await new Promise<{ member: unknown; keyOk: boolean }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: appPort, path: "/echo", headers: h, agent: false }, (res) => {
        let s = ""; res.setEncoding("utf8"); res.on("data", (c: string) => { s += c; }); res.on("end", () => resolve(JSON.parse(s)));
      }).on("error", reject);
    });
    assert.equal(direct.member, null, `검사 층을 건너뛴 요청이 사람으로 읽혔다: ${JSON.stringify(h)}`);
    assert.equal(direct.keyOk, false);
  }
  const k1 = r.driver.c.get(containerNameOf(fn, version))!.env.LIVELY_GUARD_KEY;
  await r.api.putConcurrency(fn, 0);
  await r.api.deleteConcurrency(fn);
  await call(r, fn, personEvent("key-app", "/echo"));
  assert.notEqual(r.driver.c.get(containerNameOf(fn, version))!.env.LIVELY_GUARD_KEY, k1, "띄울 때마다 새 열쇠");
});

t("L17 컨테이너를 못 띄움 — 503 ServiceException · 그 판 Failed · 다음에 뜨면 걷힘", async () => {
  const r = await setup();
  const { fn } = await r.mkFn("fail-app");
  r.driver.failRun = "no space left on device";
  await assert.rejects(r.api.invokeStream(fn, "cur", personEvent("fail-app", "/echo"), { timeoutMs: 5000 }), awsErr(503, "ServiceException"));
  const got = await r.api.getFunction(fn, "1");
  assert.equal(got?.Configuration.State, "Failed");
  assert.match(String(got?.Configuration.StateReason), /no space left/);
  assert.equal((await r.api.getFunctionConfiguration(fn, "cur"))?.State, "Failed");
  r.driver.failRun = null;
  assert.equal((await call(r, fn, personEvent("fail-app", "/echo"))).prelude?.statusCode, 200);
  assert.equal((await r.api.getFunction(fn, "1"))?.Configuration.State, "Active");
});

t("L18 깨어 있던 컨테이너가 사이에 죽음 — 한 번 다시 띄워 보낸다", async () => {
  const r = await setup();
  const { fn, version } = await r.mkFn("crash-app");
  const p1 = echo(await call(r, fn, personEvent("crash-app", "/echo"))).pid;
  await r.driver.crash(containerNameOf(fn, version));
  await sleep(100);
  const g = await call(r, fn, personEvent("crash-app", "/echo"));
  assert.equal(g.prelude?.statusCode, 200);
  assert.notEqual(echo(g).pid, p1, "새 컨테이너");
  assert.equal(r.driver.runs.length, 2);
});

t("L19 레이어 — 올릴 때마다 판 번호 · 목록 · 판이 고른 레이어를 /opt/<폴더> 로", async () => {
  const r = await setup();
  const l2 = await r.api.publishLayerVersion("lvly-app-guard", { zip: guardLayerZip().zip, description: "guard v2", architectures: ["arm64"] });
  assert.equal(l2.LayerVersionArn, "lively-local:layer:lvly-app-guard:2");
  assert.deepEqual((await r.api.listLayerVersions("lvly-app-guard")).map((l) => [l.Version, l.Description]), [[1, "guard"], [2, "guard v2"]]);
  assert.deepEqual(await r.api.listLayerVersions("../etc"), []);
  await assert.rejects(r.api.publishLayerVersion("bad/name", { zip: guardLayerZip().zip, description: "", architectures: [] }), awsErr(400, "InvalidParameterValueException"));
  const { fn } = await r.mkFn("layer-app", { layer: l2.LayerVersionArn });
  await call(r, fn, personEvent("layer-app", "/echo"));
  const ro = r.driver.runs.at(-1)!.ro;
  assert.deepEqual(ro.map((m) => m.target), ["/var/task", "/opt/lively"], "웹 어댑터 자리(lively-local:adapter)는 마운트하지 않는다");
  assert.equal(ro[1]!.host, path.join(r.root, "layers", "lvly-app-guard", "2", "files", "lively"));
});

t("L20 게이트웨이를 다시 띄움(표 비움) — 떠 있는 컨테이너를 다시 넣는다(새로 안 띄움)", async () => {
  const r = await setup();
  const { fn } = await r.mkFn("adopt-app");
  const p1 = echo(await call(r, fn, personEvent("adopt-app", "/echo"))).pid;
  setLocalDepsForTest(r.deps);
  assert.deepEqual(localLiveForTest(), []);
  const g = await call(r, fn, personEvent("adopt-app", "/echo"));
  assert.equal(echo(g).pid, p1, "같은 컨테이너");
  assert.equal(r.driver.runs.length, 1, "새로 띄웠다");
  assert.doesNotMatch(g.log, /Init Duration/);
});

t("L21 env 파일 — 띄운 직후 지운다 · 남은 것과 주인 없는 컨테이너는 정비가 걷는다", async () => {
  const r = await setup();
  const { fn, version } = await r.mkFn("hk-app");
  await call(r, fn, personEvent("hk-app", "/echo"));
  assert.deepEqual(fs.readdirSync(path.join(r.root, "run")), [], "열쇠 · 토큰이 든 env 파일이 남았다");
  fs.writeFileSync(path.join(r.root, "run", "stale.env"), "LIVELY_APP_TOKEN=x\n");
  //  함수 폴더가 사라진(지우다 멈춘) 컨테이너 — 주인 없음
  fs.rmSync(path.join(r.root, "fn", "00000000-0000-0000-0000-000000000000", fn), { recursive: true });
  const hk = await localHousekeeping(600, {});
  assert.deepEqual(hk.removed, [containerNameOf(fn, version)]);
  assert.equal(hk.env_files, 1);
  assert.equal(r.driver.c.size, 0);
});

t("L22 부르는 도중 컨테이너가 죽음(메모리 · 앱이 끝남) — Lambda 꼴 함수 오류(Runtime.ExitError) · REPORT error · 죽은 컨테이너 걷음 · 다음엔 새로", async () => {
  const r = await setup();
  const { fn, version } = await r.mkFn("die-app");
  const p1 = echo(await call(r, fn, personEvent("die-app", "/echo"))).pid;
  const g = await call(r, fn, personEvent("die-app", "/die"));
  assert.equal(g.error?.errorType, "Runtime.ExitError", JSON.stringify(g));
  assert.match(g.error!.errorMessage, /exit status 9/);
  assert.match(g.log, /Status: error\tError Type: Runtime\.ExitError/);
  assert.equal(r.driver.c.has(containerNameOf(fn, version)), false, "죽은 컨테이너가 남았다");
  assert.notEqual(echo(await call(r, fn, personEvent("die-app", "/echo"))).pid, p1, "다음 부르기는 새 컨테이너");
});

t("L23 빌드 결과 받기 — 보통 파일만 · 크기 상한 · 지문은 코어가 잰다 · 아니면 zip 저장소에 아무것도 안 남김", async () => {
  const r = await setup();
  const mk = async (key: string) => {
    const runner = await localBuildRunner({ appId: "col-app", buildKey: key, zipKey: `t/z/col-app/${key}.zip`, image: IMAGE }, {});
    return { runner, file: fileURLToPath(runner.uploadUrl), dest: path.join(r.root, "zips", "t", "z", "col-app", `${key}.zip`) };
  };
  //  보통 파일 — 받고, 잰 값을 돌려준다
  const ok = await mk("k-ok");
  fs.writeFileSync(ok.file, Buffer.from("PK-zip-bytes"));
  const got = await ok.runner.collect();
  assert.equal(got.bytes, 12);
  assert.equal(got.sha256_b64, crypto.createHash("sha256").update("PK-zip-bytes").digest("base64"));
  assert.ok(fs.lstatSync(ok.dest).isFile() && !fs.lstatSync(ok.dest).isSymbolicLink());
  await ok.runner.cleanup();
  //  링크 · FIFO · 상한 넘음 · 없음 — 거절 · zip 저장소 자리에 아무것도 없음(FIFO 에 매달리지 않음)
  const outside = path.join(work, "outside-secret.txt");
  fs.writeFileSync(outside, "box secret");
  const cases: Array<[string, (f: string) => void]> = [
    ["k-link", (f) => fs.symlinkSync(outside, f)],
    ["k-fifo", (f) => execFileSync("mkfifo", [f])],
    ["k-big", (f) => { fs.writeFileSync(f, ""); fs.truncateSync(f, LOCAL_BUILD_ZIP_MAX_BYTES + 1); }],
    ["k-none", () => { /* 빌더가 아무것도 안 남김 */ }],
    ["k-dir", (f) => fs.mkdirSync(f)],
  ];
  for (const [key, plant] of cases) {
    const c = await mk(key);
    plant(c.file);
    const t0 = Date.now();
    //  매달리면(FIFO) 시험이 3초에 끊는다 — 그래도 아래 시간 단언이 빨간불을 낸다
    await assert.rejects(Promise.race([c.runner.collect(), sleep(3000).then(() => { throw new Error("매달림"); })]), key);
    assert.ok(Date.now() - t0 < 2000, `${key} 에 매달렸다`);
    assert.equal(fs.existsSync(c.dest), false, `${key} — zip 저장소에 무엇이 남았다`);
    await c.runner.cleanup();
  }
});

t("L24 예산 — 동시에 처음 부르기가 여럿이어도 띄우는 중인 것까지 세어 예산을 넘기지 않는다", async () => {
  const r = await setup({ budgetMb: 2048 });
  const fns = [];
  for (const id of ["par-a", "par-b", "par-c", "par-d"]) fns.push(await r.mkFn(id, { mem: 1024 }));
  r.st.appIdle = { "par-a": 0, "par-b": 0, "par-c": 0, "par-d": 0 };   // 안 재움 — 내릴 수 있는 것이 없다
  const outs = await Promise.allSettled(fns.map((f, k) => call(r, f.fn, personEvent(["par-a", "par-b", "par-c", "par-d"][k]!, "/echo"))));
  const up = outs.filter((o) => o.status === "fulfilled" && (o.value as Got).prelude?.statusCode === 200).length;
  const refused = outs.filter((o) => o.status === "rejected" && o.reason instanceof AwsError && o.reason.status === 429).length;
  assert.equal(r.driver.c.size, 2, `떠 있는 컨테이너 ${r.driver.c.size}개 — 예산 2048MB 에 1024MB 둘까지`);
  assert.deepEqual([up, refused], [2, 2]);
});

t("L27 예산 — 꽉 찬 상태에서 동시에 둘이 들어오면 각각 오래 쉰 것을 내리고 둘 다 뜬다(합이 예산을 안 넘는다)", async () => {
  const r = await setup({ budgetMb: 2048 });
  const a = await r.mkFn("ev-a", { mem: 1024 }), b = await r.mkFn("ev-b", { mem: 1024 });
  const c = await r.mkFn("ev-c", { mem: 1024 }), d = await r.mkFn("ev-d", { mem: 1024 });
  //  a · b 로 예산을 채운다(재울 수 있는 한가한 것). c · d 를 동시에 — 각각 a · b 를 내리고 떠야 한다.
  await call(r, a.fn, personEvent("ev-a", "/echo"));
  skew += 1000;
  await call(r, b.fn, personEvent("ev-b", "/echo"));
  assert.equal(r.driver.c.size, 2);
  const outs = await Promise.allSettled([call(r, c.fn, personEvent("ev-c", "/echo")), call(r, d.fn, personEvent("ev-d", "/echo"))]);
  assert.ok(outs.every((o) => o.status === "fulfilled" && (o.value as Got).prelude?.statusCode === 200), JSON.stringify(outs.map((o) => o.status)));
  assert.equal(r.driver.c.size, 2, `동시에 둘이 떴는데 합이 예산을 넘었다(${r.driver.c.size}개)`);
  assert.deepEqual([...r.driver.c.values()].map((x) => x.spec.labels["lvly.app"]).sort(), ["ev-c", "ev-d"], "c · d 가 뜨고 a · b 는 내려갔어야 한다");
});

//  ONLY=L5,L16 — 그 행들만(변이 시험이 행마다 빨간불을 볼 때).
const only = (process.env.ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
try {
  for (const [name, fn] of tests) {
    if (only.length && !only.includes(name.split(" ")[0]!)) continue;
    await fn(); pass++; console.log(`ok  ${name}`);
  }
} finally {
  await (cur as Rig | null)?.driver.stopAll();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`\napp-server-local: ${pass} 통과`);
