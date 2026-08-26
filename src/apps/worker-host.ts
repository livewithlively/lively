// 앱 worker 실행 호스트(#1780 Stage B) — 게이트웨이와 원격 노드가 **같은 코드**를 사용한다.
// 정책(앱 활성·grant·배치 선택)은 게이트웨이가 끝내고, 이 모듈은 검증된 단일 ESM 번들을 기계적으로 실행한다.
// 보안 불변식:
//  - 격리기가 없으면 평문 Node 로 폴백하지 않는다(fail closed).
//  - 자식에게 부모 env 를 상속하지 않는다(게이트웨이/노드 토큰·사용자 HOME 유출 금지).
//  - Node permission model 로 entry 외 FS 읽기·모든 FS 쓰기·child_process 를 거부한다.
//  - Node 권한 모델이 막지 못하는 네트워크는 macOS sandbox-exec 또는 Linux bwrap network namespace 로 막는다.
import crypto from "node:crypto";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeFetch } from "../net/ssrf.js";
import { cpuPercentBetween, parsePsCpuSeconds } from "./worker-policy.js";

export const WORKER_ENTRY_MAX_BYTES = 8 * 1024 * 1024;
export const WORKER_LINE_MAX_BYTES = 64 * 1024;
export const WORKER_RPC_CHUNK_BYTES = 512 * 1024; // base64+JSON도 노드 WS 1MiB 경계 아래.
const READY_TIMEOUT_MS = 8_000;
const STOP_GRACE_MS = 1_000;
const RSS_SAMPLE_MS = 1_000;
// CPU 폭주 판정은 표본 하나로 하지 않는다 — 기동 직후 컴파일·초기화 순간 스파이크로 정상 worker 를 죽이기 때문이다.
//  연속 CPU_BREACH_STREAK 회(= 그만큼의 초) 연속 초과일 때만 종료한다.
const CPU_BREACH_STREAK = 5;
const MESSAGE_RATE_MAX = 32;
const REQUEST_CONCURRENCY_MAX = 4;
export type WorkerRunStatus = "starting" | "ready" | "idle" | "running" | "stopping" | "stopped" | "failed";
export type WorkerStopReason = "explicit" | "placement_changed" | "package_updated" | "instance_closed" | "app_disabled" | "app_removed" | "grant_revoked" | "member_deactivated" | "idle_timeout" | "memory_budget" | "cpu_budget" | "wall_budget" | "protocol_error" | "ready_timeout" | "process_exit" | "host_shutdown";

export interface WorkerStartSpec {
  runId: string;
  appId: string;
  instanceId: string;
  entry: string;
  code: Buffer;
  codeHash: string;
  memoryMb: number;
  idleTimeoutSec: number;
  allowedHosts: string[];
  selfHosts: string[];
  /** worker 1개의 CPU 사용률 상한(%, 코어 1개=100). 0·미지정 = 감시 끔(#1780 Stage B). */
  cpuPercentMax?: number;
  /** worker 1개의 최대 수명(초). 0·미지정 = 무제한(#1780 Stage B). */
  maxWallSec?: number;
}

export interface WorkerRunSnapshot {
  runId: string;
  appId: string;
  instanceId: string;
  status: WorkerRunStatus;
  pid: number | null;
  reason: WorkerStopReason | null;
  exitCode: number | null;
  startedAt: string;
  readyAt: string | null;
  lastActiveAt: string;
  stoppedAt: string | null;
}

export interface WorkerSpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  isolator: "sandbox-exec" | "bwrap";
}

export class WorkerIsolationUnavailable extends Error {
  constructor(public readonly platform: NodeJS.Platform) {
    super(`worker-isolation-unavailable:${platform}`);
    this.name = "WorkerIsolationUnavailable";
  }
}

type WorkerBundleStage = { codeHash: string; total: number; chunks: Buffer[]; bytes: number; expiresAt: number };
/** 1MiB 노드 RPC 경계를 넘지 않게 받은 번들을 순서·크기·최종 해시까지 검증해 조립한다. */
export class WorkerBundleStager {
  private readonly stages = new Map<string, WorkerBundleStage>();
  constructor(private readonly ttlMs = 60_000, private readonly maxActive = 8) {}

  private prune(): void {
    const now = Date.now();
    for (const [id, stage] of this.stages) if (stage.expiresAt <= now) this.stages.delete(id);
  }
  stage(args: Record<string, unknown>): { received: number; total: number; complete: boolean } {
    this.prune();
    const runId = String(args.runId ?? "");
    const codeHash = String(args.codeHash ?? "");
    const index = Number(args.index);
    const total = Number(args.total);
    const encoded = String(args.chunkBase64 ?? "");
    const maxChunks = Math.ceil(WORKER_ENTRY_MAX_BYTES / WORKER_RPC_CHUNK_BYTES);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(runId) || !/^[a-f0-9]{64}$/.test(codeHash)) throw new Error("worker-stage-id-invalid");
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > maxChunks || index < 0 || index >= total) throw new Error("worker-stage-index-invalid");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("worker-stage-base64-invalid");
    const chunk = Buffer.from(encoded, "base64");
    if (chunk.length < 1 || chunk.length > WORKER_RPC_CHUNK_BYTES) throw new Error("worker-stage-chunk-size-invalid");
    let stage = this.stages.get(runId);
    if (!stage) {
      if (index !== 0 || this.stages.size >= this.maxActive) throw new Error(index !== 0 ? "worker-stage-order-invalid" : "worker-stage-capacity-exceeded");
      stage = { codeHash, total, chunks: [], bytes: 0, expiresAt: Date.now() + this.ttlMs };
      this.stages.set(runId, stage);
    }
    if (stage.codeHash !== codeHash || stage.total !== total || index !== stage.chunks.length) throw new Error("worker-stage-order-invalid");
    if (stage.bytes + chunk.length > WORKER_ENTRY_MAX_BYTES) throw new Error("worker-stage-size-invalid");
    stage.chunks.push(chunk);
    stage.bytes += chunk.length;
    stage.expiresAt = Date.now() + this.ttlMs;
    return { received: stage.chunks.length, total, complete: stage.chunks.length === total };
  }
  take(runId: string, codeHash: string): Buffer {
    this.prune();
    const stage = this.stages.get(runId);
    this.stages.delete(runId);
    if (!stage || stage.codeHash !== codeHash || stage.chunks.length !== stage.total) throw new Error("worker-stage-incomplete");
    const code = Buffer.concat(stage.chunks, stage.bytes);
    if (crypto.createHash("sha256").update(code).digest("hex") !== codeHash) throw new Error("worker-stage-hash-mismatch");
    return code;
  }
  delete(runId: string): void { this.stages.delete(runId); }
  clear(): void { this.stages.clear(); }
}

export type WorkerProtocolMessage = { t: "ready" | "heartbeat" | "event" | "request" | "response"; [key: string]: unknown };

/** stdout JSONL 한 줄의 엄격한 경계. 로그 문자열·미지 메시지를 프로토콜로 받아들이지 않는다. */
export function parseWorkerProtocolLine(line: Buffer | string): WorkerProtocolMessage {
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line);
  if (bytes.length > WORKER_LINE_MAX_BYTES) throw new Error("worker-line-too-long");
  let message: { t?: unknown };
  try { message = JSON.parse(bytes.toString("utf8")) as { t?: unknown }; }
  catch { throw new Error("worker-json-invalid"); }
  if (message.t !== "ready" && message.t !== "heartbeat" && message.t !== "event" && message.t !== "request" && message.t !== "response") {
    throw new Error("worker-message-unsupported");
  }
  return message as WorkerProtocolMessage;
}

type Exists = (file: string) => Promise<boolean>;
type SnapshotSink = (snapshot: WorkerRunSnapshot) => void | Promise<void>;

async function defaultExists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

function sandboxString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 플랫폼별 OS egress 격리 + 공통 Node permission 실행 계획. 격리기가 없으면 예외. */
export async function buildWorkerSpawnPlan(input: {
  platform?: NodeJS.Platform;
  entryPath: string;
  runDir: string;
  appId: string;
  instanceId: string;
  runId: string;
  memoryMb: number;
  nodePath?: string;
  exists?: Exists;
}): Promise<WorkerSpawnPlan> {
  const platform = input.platform ?? process.platform;
  const exists = input.exists ?? defaultExists;
  const nodePath = input.nodePath ?? process.execPath;
  const heapMb = Math.max(16, input.memoryMb - 32);
  const nodeArgs = [
    "--permission", // Node 22.13+ stable 이름. Node 24는 experimental 별칭을 제거했다.
    `--allow-fs-read=${input.entryPath}`,
    `--max-old-space-size=${heapMb}`,
    input.entryPath,
  ];
  // 의도적으로 process.env 를 펼치지 않는다. PATH·HOME·토큰·클라우드 자격을 worker가 상속하지 않는다.
  const env: NodeJS.ProcessEnv = {
    HOME: input.runDir,
    TMPDIR: input.runDir,
    TEMP: input.runDir,
    TMP: input.runDir,
    LANG: "C.UTF-8",
    LIVELY_APP_ID: input.appId,
    LIVELY_APP_INSTANCE_ID: input.instanceId,
    LIVELY_WORKER_RUN_ID: input.runId,
  };

  if (platform === "darwin" && await exists("/usr/bin/sandbox-exec")) {
    const writable = sandboxString(input.runDir);
    const profile = `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath "${writable}"))`;
    return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, nodePath, ...nodeArgs], env, isolator: "sandbox-exec" };
  }
  if (platform === "linux") {
    const bwrap = (await exists("/usr/bin/bwrap")) ? "/usr/bin/bwrap" : (await exists("/bin/bwrap")) ? "/bin/bwrap" : null;
    if (bwrap) {
      return {
        command: bwrap,
        args: ["--die-with-parent", "--new-session", "--unshare-net", "--ro-bind", "/", "/", "--bind", input.runDir, input.runDir,
          "--chdir", input.runDir, nodePath, ...nodeArgs],
        env,
        isolator: "bwrap",
      };
    }
  }
  throw new WorkerIsolationUnavailable(platform);
}

function validateSpec(spec: WorkerStartSpec): void {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(spec.runId)) throw new Error("worker-run-id-invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(spec.appId)) throw new Error("worker-app-id-invalid");
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(spec.instanceId)) throw new Error("worker-instance-id-invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:m?js)$/.test(spec.entry) || spec.entry.split("/").includes("..")) throw new Error("worker-entry-invalid");
  if (!Buffer.isBuffer(spec.code) || spec.code.length === 0 || spec.code.length > WORKER_ENTRY_MAX_BYTES) throw new Error("worker-code-size-invalid");
  if (crypto.createHash("sha256").update(spec.code).digest("hex") !== spec.codeHash) throw new Error("worker-code-hash-mismatch");
  if (!Number.isInteger(spec.memoryMb) || spec.memoryMb < 64 || spec.memoryMb > 512) throw new Error("worker-memory-invalid");
  if (!Number.isInteger(spec.idleTimeoutSec) || spec.idleTimeoutSec < 30 || spec.idleTimeoutSec > 3600) throw new Error("worker-idle-timeout-invalid");
  if (!Array.isArray(spec.allowedHosts) || spec.allowedHosts.some((h) => !/^[a-z0-9.-]+(?::\d+)?$/.test(h))) throw new Error("worker-allowed-hosts-invalid");
  if (!Array.isArray(spec.selfHosts) || spec.selfHosts.some((h) => !/^[a-z0-9.-]+$/.test(h))) throw new Error("worker-self-hosts-invalid");
}

export interface WorkerFetchRequest { id: string; url: string; method: string; headers: Record<string, string>; body?: string }

export function normalizeWorkerFetchRequest(message: WorkerProtocolMessage): WorkerFetchRequest {
  if (message.t !== "request" || message.op !== "fetch") throw new Error("worker-request-unsupported");
  const id = String(message.id ?? "");
  const input = message.input;
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id) || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("worker-request-invalid");
  const x = input as Record<string, unknown>;
  const url = String(x.url ?? "");
  if (url.length < 1 || url.length > 4000) throw new Error("worker-fetch-url-invalid");
  const method = String(x.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) throw new Error("worker-fetch-method-invalid");
  const headers: Record<string, string> = {};
  if (x.headers !== undefined) {
    if (!x.headers || typeof x.headers !== "object" || Array.isArray(x.headers)) throw new Error("worker-fetch-headers-invalid");
    for (const [name, value] of Object.entries(x.headers as Record<string, unknown>)) {
      const lower = name.toLowerCase();
      if (!/^[a-z0-9-]{1,100}$/.test(lower) || ["authorization", "cookie", "proxy-authorization", "host"].includes(lower)) throw new Error("worker-fetch-header-forbidden");
      const text = String(value);
      if (text.length > 4096) throw new Error("worker-fetch-header-too-large");
      headers[name] = text;
    }
  }
  const body = x.body === undefined ? undefined : String(x.body);
  if (body !== undefined && Buffer.byteLength(body) > 64 * 1024) throw new Error("worker-fetch-body-too-large");
  return { id, url, method, headers, ...(body !== undefined ? { body } : {}) };
}

interface LiveRun {
  spec: WorkerStartSpec;
  process: ChildProcessWithoutNullStreams;
  dir: string;
  snapshot: WorkerRunSnapshot;
  stdout: Buffer;
  stderr: string;
  readyResolve: (snapshot: WorkerRunSnapshot) => void;
  readyReject: (error: Error) => void;
  readySettled: boolean;
  readyTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout | null;
  rssTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  wallTimer: NodeJS.Timeout | null;
  cpuSample: { cpuSec: number; atMs: number } | null;
  cpuBreaches: number;
  messageWindowAt: number;
  messageCount: number;
  requestsInFlight: number;
  readyPromise: Promise<WorkerRunSnapshot>;
  emitQueue: Promise<void>;
}

export interface WorkerHostOptions {
  platform?: NodeJS.Platform;
  rootDir?: string;
  nodePath?: string;
  exists?: Exists;
  onSnapshot?: SnapshotSink;
}

export class WorkerHost {
  private readonly runs = new Map<string, LiveRun>();
  private readonly platform: NodeJS.Platform;
  private readonly rootDir: string;
  private readonly nodePath: string;
  private readonly exists: Exists;
  private readonly onSnapshot?: SnapshotSink;

  constructor(options: WorkerHostOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.rootDir = options.rootDir ?? path.join(os.tmpdir(), "lively-app-workers");
    this.nodePath = options.nodePath ?? process.execPath;
    this.exists = options.exists ?? defaultExists;
    this.onSnapshot = options.onSnapshot;
  }

  status(runId: string): WorkerRunSnapshot | null {
    const run = this.runs.get(runId);
    return run ? { ...run.snapshot } : null;
  }

  async start(spec: WorkerStartSpec): Promise<WorkerRunSnapshot> {
    validateSpec(spec);
    const current = this.runs.get(spec.runId);
    if (current && !["stopped", "failed"].includes(current.snapshot.status)) {
      return current.snapshot.status === "starting" ? await current.readyPromise : { ...current.snapshot };
    }

    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const createdDir = await mkdtemp(path.join(this.rootDir, `${spec.runId.replace(/[^A-Za-z0-9_.-]/g, "_")}-`));
    // macOS의 /tmp→/private/tmp 같은 심링크를 permission 플래그와 Node의 내부 realpath가 서로 다르게 보면
    // entry 자신도 ERR_ACCESS_DENIED가 난다. 모든 실행 경계에 canonical 경로 하나만 쓴다.
    const dir = await realpath(createdDir);
    const entryPath = path.join(dir, "worker.mjs");
    try {
      await writeFile(entryPath, spec.code, { mode: 0o400, flag: "wx" });
      await chmod(entryPath, 0o400);
      const plan = await buildWorkerSpawnPlan({
        platform: this.platform, entryPath, runDir: dir, appId: spec.appId, instanceId: spec.instanceId,
        runId: spec.runId, memoryMb: spec.memoryMb, nodePath: this.nodePath, exists: this.exists,
      });
      const child = spawn(plan.command, plan.args, { cwd: dir, env: plan.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const now = new Date().toISOString();
      let readyResolve!: (snapshot: WorkerRunSnapshot) => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<WorkerRunSnapshot>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const live = {} as LiveRun;
      Object.assign(live, {
        spec, process: child, dir, stdout: Buffer.alloc(0), stderr: "", readyResolve, readyReject, readySettled: false,
        idleTimer: null, rssTimer: null, killTimer: null, wallTimer: null, cpuSample: null, cpuBreaches: 0, messageWindowAt: Date.now(), messageCount: 0, requestsInFlight: 0,
        readyPromise: ready, emitQueue: Promise.resolve(),
        snapshot: { runId: spec.runId, appId: spec.appId, instanceId: spec.instanceId, status: "starting", pid: child.pid ?? null,
          reason: null, exitCode: null, startedAt: now, readyAt: null, lastActiveAt: now, stoppedAt: null },
      });
      live.readyTimer = setTimeout(() => this.fail(live, "ready_timeout", new Error("worker-ready-timeout")), READY_TIMEOUT_MS);
      live.readyTimer.unref?.();
      this.runs.set(spec.runId, live);
      this.emit(live);

      child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(live, chunk));
      child.stderr.on("data", (chunk: Buffer) => { live.stderr = (live.stderr + chunk.toString("utf8")).slice(-4096); });
      child.stdin.on("error", () => { /* 종료 경로에서 뒤늦은 stop/response write가 프로세스를 죽이지 않게 */ });
      child.once("error", (error) => this.fail(live, "process_exit", error));
      // spawn 자체 실패도 close로 수렴하므로 임시 디렉터리와 실행 맵을 반드시 회수한다.
      child.once("close", (code) => this.onExit(live, code));
      live.rssTimer = setInterval(() => { void this.checkBudget(live); }, RSS_SAMPLE_MS);
      live.rssTimer.unref?.();
      // 수명 상한(#1780 Stage B) — 0·미지정이면 무장하지 않는다(켜지 않은 조직에 회귀를 만들지 않는다).
      const maxWallSec = spec.maxWallSec ?? 0;
      if (maxWallSec > 0) {
        live.wallTimer = setTimeout(() => { void this.stop(spec.runId, "wall_budget"); }, maxWallSec * 1000);
        live.wallTimer.unref?.();
      }
      return await ready;
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => { /* exact private run dir */ });
      throw error;
    }
  }

  async stop(runId: string, reason: WorkerStopReason = "explicit"): Promise<WorkerRunSnapshot | null> {
    const live = this.runs.get(runId);
    if (!live) return null;
    if (["stopped", "failed"].includes(live.snapshot.status)) return { ...live.snapshot };
    live.snapshot.status = "stopping";
    live.snapshot.reason = reason;
    this.emit(live);
    try { live.process.stdin.write(JSON.stringify({ t: "stop", reason }) + "\n"); } catch { /* process exit path settles */ }
    live.killTimer = setTimeout(() => { try { live.process.kill("SIGKILL"); } catch { /* already gone */ } }, STOP_GRACE_MS);
    live.killTimer.unref?.();
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + STOP_GRACE_MS + 500;
      const poll = (): void => {
        if (["stopped", "failed"].includes(live.snapshot.status) || Date.now() >= deadline) { resolve(); return; }
        setTimeout(poll, 20);
      };
      poll();
    });
    return { ...live.snapshot };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.stop(id, "host_shutdown")));
  }

  private consumeStdout(live: LiveRun, chunk: Buffer): void {
    live.stdout = Buffer.concat([live.stdout, chunk]);
    if (live.stdout.length > WORKER_LINE_MAX_BYTES && live.stdout.indexOf(0x0a) < 0) {
      this.fail(live, "protocol_error", new Error("worker-line-too-long"));
      return;
    }
    for (;;) {
      const nl = live.stdout.indexOf(0x0a);
      if (nl < 0) break;
      const line = live.stdout.subarray(0, nl);
      live.stdout = live.stdout.subarray(nl + 1);
      if (line.length > WORKER_LINE_MAX_BYTES) { this.fail(live, "protocol_error", new Error("worker-line-too-long")); return; }
      const now = Date.now();
      if (now - live.messageWindowAt >= 1_000) { live.messageWindowAt = now; live.messageCount = 0; }
      if (++live.messageCount > MESSAGE_RATE_MAX) { this.fail(live, "protocol_error", new Error("worker-message-rate-exceeded")); return; }
      let message: WorkerProtocolMessage;
      try { message = parseWorkerProtocolLine(line); }
      catch (error) { this.fail(live, "protocol_error", error as Error); return; }
      if (message.t === "ready") {
        if (live.snapshot.status !== "starting") continue;
        clearTimeout(live.readyTimer);
        const now = new Date().toISOString();
        live.snapshot.status = "idle";
        live.snapshot.readyAt = now;
        live.snapshot.lastActiveAt = now;
        live.readySettled = true;
        this.armIdle(live);
        this.emit(live);
        live.readyResolve({ ...live.snapshot });
      } else if (message.t === "heartbeat" || message.t === "event" || message.t === "response") {
        if (live.snapshot.status === "starting") { this.fail(live, "protocol_error", new Error("worker-not-ready")); return; }
        live.snapshot.status = message.t === "heartbeat" ? "idle" : "running";
        live.snapshot.lastActiveAt = new Date().toISOString();
        this.armIdle(live);
        this.emit(live);
      } else if (message.t === "request") {
        if (live.snapshot.status === "starting") { this.fail(live, "protocol_error", new Error("worker-not-ready")); return; }
        live.snapshot.status = "running";
        live.snapshot.lastActiveAt = new Date().toISOString();
        this.armIdle(live);
        this.emit(live);
        void this.handleRequest(live, message);
      }
    }
  }

  private async handleRequest(live: LiveRun, message: WorkerProtocolMessage): Promise<void> {
    let id = String(message.id ?? "").slice(0, 100);
    if (live.requestsInFlight >= REQUEST_CONCURRENCY_MAX) {
      try { live.process.stdin.write(JSON.stringify({ t: "response", id, ok: false, error: "worker-request-concurrency-exceeded" }) + "\n"); } catch { /* exit path */ }
      return;
    }
    live.requestsInFlight++;
    try {
      const req = normalizeWorkerFetchRequest(message);
      id = req.id;
      const data = await safeFetch(req.url, { method: req.method, headers: req.headers, body: req.body,
        allowlist: live.spec.allowedHosts ?? [], selfHosts: live.spec.selfHosts ?? [], maxBytes: 256 * 1024, timeoutMs: 8_000, allowHttp: false, maxRedirects: 2 });
      live.process.stdin.write(JSON.stringify({ t: "response", id, ok: true, data }) + "\n");
    } catch (error) {
      try { live.process.stdin.write(JSON.stringify({ t: "response", id, ok: false,
        error: error instanceof Error ? error.message.slice(0, 500) : "worker-request-failed" }) + "\n"); } catch { /* exit path */ }
    } finally {
      live.requestsInFlight--;
      if (!["stopping", "stopped", "failed"].includes(live.snapshot.status)) {
        live.snapshot.status = "idle";
        live.snapshot.lastActiveAt = new Date().toISOString();
        this.armIdle(live);
        this.emit(live);
      }
    }
  }

  private armIdle(live: LiveRun): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => { void this.stop(live.spec.runId, "idle_timeout"); }, live.spec.idleTimeoutSec * 1000);
    live.idleTimer.unref?.();
  }

  /** 메모리(RSS)와 CPU 를 한 번의 ps 로 함께 표본한다 — 프로세스마다 초당 두 번 fork 하지 않기 위해. */
  private async checkBudget(live: LiveRun): Promise<void> {
    const pid = live.process.pid;
    if (!pid || ["stopped", "failed", "stopping"].includes(live.snapshot.status)) return;
    const sample = await new Promise<{ rssKb: number | null; cpuSec: number | null }>((resolve) => {
      execFile("ps", ["-o", "rss=,time=", "-p", String(pid)], { timeout: 800 }, (error, stdout) => {
        if (error) { resolve({ rssKb: null, cpuSec: null }); return; }
        // `rss= time=` 은 "  12345 0:01.23" 처럼 공백으로 갈린다. 앞 토큰이 KiB, 나머지가 누적 CPU 시간.
        const text = String(stdout).trim();
        const gap = text.search(/\s/);
        if (gap < 0) { resolve({ rssKb: Number(text) || null, cpuSec: null }); return; }
        const rss = Number(text.slice(0, gap));
        resolve({ rssKb: Number.isFinite(rss) ? rss : null, cpuSec: parsePsCpuSeconds(text.slice(gap + 1)) });
      });
    });
    if (["stopped", "failed", "stopping"].includes(live.snapshot.status)) return; // ps 대기 중 종료됐다
    if (sample.rssKb !== null && sample.rssKb > live.spec.memoryMb * 1024) { await this.stop(live.spec.runId, "memory_budget"); return; }

    // CPU 상한(#1780 Stage B) — 0·미지정이면 감시하지 않는다. 표본을 못 읽으면 판정도 하지 않는다(worker 는 살린다).
    const cpuMax = live.spec.cpuPercentMax ?? 0;
    if (cpuMax <= 0 || sample.cpuSec === null) { live.cpuSample = null; return; }
    const next = { cpuSec: sample.cpuSec, atMs: Date.now() };
    const prev = live.cpuSample;
    live.cpuSample = next;
    if (!prev) return; // 첫 표본은 비교 대상이 없다
    const percent = cpuPercentBetween(prev, next);
    if (percent === null) { live.cpuBreaches = 0; return; }
    live.cpuBreaches = percent > cpuMax ? live.cpuBreaches + 1 : 0;
    if (live.cpuBreaches >= CPU_BREACH_STREAK) await this.stop(live.spec.runId, "cpu_budget");
  }

  private fail(live: LiveRun, reason: WorkerStopReason, error: Error): void {
    if (["stopped", "failed"].includes(live.snapshot.status)) return;
    live.snapshot.status = "failed";
    live.snapshot.reason = reason;
    live.snapshot.stoppedAt = new Date().toISOString();
    this.clearTimers(live);
    try { live.process.kill("SIGKILL"); } catch { /* already gone */ }
    this.emit(live);
    if (!live.readySettled) { live.readySettled = true; live.readyReject(new Error(`${error.message}${live.stderr ? `: ${live.stderr}` : ""}`)); }
  }

  private onExit(live: LiveRun, code: number | null): void {
    const wasStopping = live.snapshot.status === "stopping";
    if (live.snapshot.status !== "failed") {
      live.snapshot.status = wasStopping ? "stopped" : "failed";
      live.snapshot.reason = live.snapshot.reason ?? "process_exit";
      live.snapshot.exitCode = code;
      live.snapshot.stoppedAt = new Date().toISOString();
      this.emit(live);
    } else {
      live.snapshot.exitCode = code;
      this.emit(live);
    }
    this.clearTimers(live);
    if (!live.readySettled) { live.readySettled = true; live.readyReject(new Error(`worker-exited-before-ready:${code ?? "signal"}${live.stderr ? `: ${live.stderr}` : ""}`)); }
    void rm(live.dir, { recursive: true, force: true }).catch(() => { /* exact private run dir */ });
  }

  private clearTimers(live: LiveRun): void {
    clearTimeout(live.readyTimer);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    if (live.rssTimer) clearInterval(live.rssTimer);
    if (live.killTimer) clearTimeout(live.killTimer);
    if (live.wallTimer) clearTimeout(live.wallTimer);
  }

  private emit(live: LiveRun): void {
    if (!this.onSnapshot) return;
    const snapshot = { ...live.snapshot };
    // starting→idle→stopped 저장이 비동기 DB 지연 때문에 역전되지 않게 run 단위로 직렬화한다.
    live.emitQueue = live.emitQueue.then(() => this.onSnapshot!(snapshot)).catch(() => { /* 관측 저장 실패는 프로세스를 죽이지 않는다 */ });
  }
}
