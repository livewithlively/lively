// 게이트웨이의 worker 정책/배치 계층(#1780 Stage B). 중앙·원격 모두 worker-host.ts의 같은 실행 계약을 쓴다.
import { parseAppManifest, type LivelyAppManifest } from "./manifest.js";
import { WorkerHost, WORKER_RPC_CHUNK_BYTES, type WorkerRunSnapshot, type WorkerStopReason } from "./worker-host.js";
import type { OrgApp } from "../org/store/apps.js";
import { getActiveGrant, getApp, getRuntimeAsset } from "../org/store/apps.js";
import type { AppInstanceRow } from "../org/store/app-instances.js";
import { listActiveRuntimeInstances } from "../org/store/app-instances.js";
import * as runs from "../org/store/app-worker-runs.js";
import { liveNodes, nodeAgentStale, nodeOnline, nodeRpc, nodeSupports, onNodeReady, onWorkerState } from "../node/registry.js";
import { getRuntimeConfig } from "../org/store/runtime-config.js";
import { getOrgProfile } from "../org/store/profile.js";

const gatewayWorkerHost = new WorkerHost({ onSnapshot: (snapshot) => runs.applyWorkerSnapshot(snapshot) });

export interface WorkerPlacement { kind: "central" | "remote"; nodeId: string | null }

export interface WorkerRecoveryResult { kept: number; restarted: number; failed: number; failures: string[] }

export async function assertWorkerGrant(appId: string, owner: string,
  lookup: (id: string, member: string) => Promise<unknown> = getActiveGrant): Promise<void> {
  if (!(await lookup(appId, owner))) throw new Error("worker-grant-required");
}

/** 복구 한 건의 실패가 다른 AppInstance를 막지 않게 직렬 실행하고 결과를 정규화한다. */
export async function runWorkerRecoveryBatch<T>(items: readonly T[], recover: (item: T) => Promise<"kept" | "restarted">): Promise<WorkerRecoveryResult> {
  const result: WorkerRecoveryResult = { kept: 0, restarted: 0, failed: 0, failures: [] };
  for (const item of items) {
    try { result[await recover(item)]++; }
    catch (error) {
      result.failed++;
      result.failures.push((error instanceof Error ? error.message : String(error)).slice(0, 500));
    }
  }
  return result;
}

const WORKER_STATUSES = new Set(["starting", "ready", "idle", "running", "stopping", "stopped", "failed"]);
export function validateRemoteWorkerSnapshot(value: unknown): WorkerRunSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worker-snapshot-invalid");
  const x = value as Record<string, unknown>;
  const id = (v: unknown): boolean => typeof v === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(v);
  const nullableInt = (v: unknown): boolean => v === null || Number.isInteger(v);
  const date = (v: unknown, nullable = false): boolean => (nullable && v === null)
    || (typeof v === "string" && v.length > 0 && Number.isFinite(Date.parse(v)));
  if (!id(x.runId) || !id(x.appId) || !id(x.instanceId) || !WORKER_STATUSES.has(String(x.status))
      || !nullableInt(x.pid) || !nullableInt(x.exitCode) || !(x.reason === null || typeof x.reason === "string")
      || !date(x.startedAt) || !date(x.readyAt, true) || !date(x.lastActiveAt) || !date(x.stoppedAt, true)) {
    throw new Error("worker-snapshot-invalid");
  }
  return value as WorkerRunSnapshot;
}

export function resolveWorkerPlacement(manifest: LivelyAppManifest, requested?: { kind: "central" | "remote"; node_id?: string } | null): WorkerPlacement | null {
  const runtime = manifest.runtime;
  if (!runtime) {
    if (requested) throw new Error("worker-placement-without-runtime");
    return null;
  }
  const kind = requested?.kind ?? (runtime.placement === "remote" ? "remote" : "central");
  if (runtime.placement === "central" && kind !== "central") throw new Error("worker-placement-central-only");
  if (runtime.placement === "remote" && kind !== "remote") throw new Error("worker-placement-remote-only");
  const nodeId = kind === "remote" ? String(requested?.node_id ?? "").trim() : null;
  if (kind === "remote" && !nodeId) throw new Error("worker-remote-node-required");
  if (kind === "central" && requested?.node_id) throw new Error("worker-central-node-forbidden");
  return { kind, nodeId };
}

function startEnvelope(runId: string, app: OrgApp, manifest: LivelyAppManifest, instance: AppInstanceRow,
  asset: NonNullable<Awaited<ReturnType<typeof getRuntimeAsset>>>, allowedHosts: string[], selfHosts: string[]): Record<string, unknown> {
  const runtime = manifest.runtime!;
  return {
    runId, appId: app.id, instanceId: instance.id, entry: asset.entry,
    codeHash: asset.code_hash, memoryMb: runtime.memory_mb, idleTimeoutSec: runtime.idle_timeout_sec, allowedHosts, selfHosts,
  };
}

async function stageRemoteBundle(nodeId: string, runId: string, codeHash: string, code: Buffer): Promise<void> {
  const total = Math.ceil(code.length / WORKER_RPC_CHUNK_BYTES);
  for (let index = 0; index < total; index++) {
    const chunk = code.subarray(index * WORKER_RPC_CHUNK_BYTES, (index + 1) * WORKER_RPC_CHUNK_BYTES);
    await nodeRpc(nodeId, "stageWorkerChunk", { runId, codeHash, index, total, chunkBase64: chunk.toString("base64") });
  }
}

const starts = new Map<string, Promise<runs.AppWorkerRunRow | null>>();

async function startWorkerForInstanceCore(app: OrgApp, manifest: LivelyAppManifest, instance: AppInstanceRow): Promise<runs.AppWorkerRunRow | null> {
  if (!manifest.runtime) return null;
  const currentApp = await getApp(app.id);
  if (!currentApp || !currentApp.enabled || currentApp.status !== "active" || currentApp.content_hash !== app.content_hash) {
    throw new Error("worker-app-no-longer-active");
  }
  await assertWorkerGrant(app.id, instance.owner_member);
  if (!app.content_hash) throw new Error("worker-package-hash-missing");
  const asset = await getRuntimeAsset(app.id, app.content_hash);
  if (!asset) throw new Error("worker-runtime-asset-missing");
  const kind = instance.execution_host_kind;
  const nodeId = instance.execution_host_id;
  if (kind !== "central" && kind !== "remote") throw new Error("worker-placement-missing");
  if (kind === "remote" && (!nodeId || !nodeOnline(nodeId) || !nodeSupports(nodeId, "startWorker") || !nodeSupports(nodeId, "stageWorkerChunk"))) {
    throw new Error(!nodeId || !nodeOnline(nodeId) ? "worker-node-offline" : "worker-node-unsupported");
  }
  const existing = await runs.activeWorkerRun(instance.id);
  if (existing) {
    const samePlacement = existing.host_kind === kind && existing.host_id === nodeId && existing.package_hash === app.content_hash;
    if (samePlacement) {
      const observed = await observeActiveWorkerRun(instance.id);
      if (observed) return observed;
    } else {
      await stopWorkerForInstance(instance.id, existing.package_hash === app.content_hash ? "placement_changed" : "package_updated");
    }
  }
  const run = await runs.prepareWorkerRun({ instanceId: instance.id, appId: app.id, owner: instance.owner_member,
    projectId: instance.project_id, hostKind: kind, hostId: nodeId, packageHash: app.content_hash });
  try {
    let snapshot: WorkerRunSnapshot;
    const orgHosts = new Set((await getRuntimeConfig()).url_allowlist.map((h) => h.toLowerCase()));
    const allowedHosts = manifest.permissions.hosts.map((h) => h.toLowerCase()).filter((h) => orgHosts.has(h));
    const selfHosts: string[] = [];
    try { const url = (await getOrgProfile()).gateway_url; if (url) selfHosts.push(new URL(url).hostname.toLowerCase()); } catch { /* 프로필 없음 */ }
    const envelope = startEnvelope(run.id, app, manifest, instance, asset, allowedHosts, selfHosts);
    if (kind === "central") {
      snapshot = await gatewayWorkerHost.start({
        runId: String(envelope.runId), appId: String(envelope.appId), instanceId: String(envelope.instanceId), entry: String(envelope.entry),
        code: asset.code, codeHash: String(envelope.codeHash),
        memoryMb: Number(envelope.memoryMb), idleTimeoutSec: Number(envelope.idleTimeoutSec),
        allowedHosts,
        selfHosts,
      });
      // onSnapshot은 순서 보장 비동기 관측이다. 응답 전에 ready 상태를 한 번 확정해 prepared 노출을 막는다.
      await runs.applyWorkerSnapshot(snapshot);
    } else {
      await stageRemoteBundle(nodeId!, run.id, asset.code_hash, asset.code);
      snapshot = await nodeRpc<WorkerRunSnapshot>(nodeId!, "startWorker", envelope);
      await runs.applyWorkerSnapshot(snapshot);
    }
    return (await runs.activeWorkerRun(instance.id)) ?? { ...run, status: snapshot.status };
  } catch (error) {
    await runs.failPreparedWorkerRun(run.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function startWorkerForInstance(app: OrgApp, manifest: LivelyAppManifest, instance: AppInstanceRow): Promise<runs.AppWorkerRunRow | null> {
  const current = starts.get(instance.id);
  if (current) return current;
  const task = startWorkerForInstanceCore(app, manifest, instance);
  starts.set(instance.id, task);
  try { return await task; }
  finally { if (starts.get(instance.id) === task) starts.delete(instance.id); }
}

/** 조회 시 원격 호스트의 실제 상태를 한 번 접어, 게이트웨이 재시작/idle 종료 뒤 stale active를 숨기지 않는다. */
async function observeActiveWorkerRun(instanceId: string): Promise<runs.AppWorkerRunRow | null> {
  const run = await runs.activeWorkerRun(instanceId);
  if (!run) return null;
  let snapshot: WorkerRunSnapshot | null = null;
  try {
    snapshot = run.host_kind === "central"
      ? gatewayWorkerHost.status(run.id)
      : (run.host_id && nodeOnline(run.host_id) && nodeSupports(run.host_id, "workerStatus"))
        ? await nodeRpc<WorkerRunSnapshot | null>(run.host_id, "workerStatus", { runId: run.id }) : null;
  } catch { return run; }
  if (!snapshot) {
    await runs.failActiveWorkerRun(run.id, "worker-host-lost-run");
    return null;
  }
  await runs.applyWorkerSnapshot(snapshot);
  return await runs.activeWorkerRun(instanceId);
}

/** UI에는 active run이 없더라도 마지막 terminal 상태·종료 사유를 보여준다. */
export async function workerRunForInstance(instanceId: string): Promise<runs.AppWorkerRunRow | null> {
  return (await observeActiveWorkerRun(instanceId)) ?? await runs.latestWorkerRun(instanceId);
}

export async function stopWorkerForInstance(instanceId: string, reason: WorkerStopReason = "explicit"): Promise<void> {
  const run = await runs.activeWorkerRun(instanceId);
  if (!run) return;
  if (run.host_kind === "central") {
    const snapshot = await gatewayWorkerHost.stop(run.id, reason);
    if (snapshot) await runs.applyWorkerSnapshot(snapshot);
    else await runs.failActiveWorkerRun(run.id, "worker-host-lost-run");
    return;
  }
  if (!run.host_id) { await runs.failActiveWorkerRun(run.id, "worker-host-missing"); return; }
  try {
    const snapshot = await nodeRpc<WorkerRunSnapshot | null>(run.host_id, "stopWorker", { runId: run.id, reason });
    if (snapshot) await runs.applyWorkerSnapshot(snapshot);
    else await runs.failActiveWorkerRun(run.id, "worker-host-lost-run");
  } catch (error) {
    await runs.failActiveWorkerRun(run.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function stopWorkersForApp(appId: string, reason: WorkerStopReason): Promise<void> {
  const failed: string[] = [];
  for (const run of await runs.listActiveWorkerRuns({ appId })) {
    await stopWorkerForInstance(run.instance_id, reason).catch(() => { failed.push(run.id); });
  }
  if (failed.length) throw new Error(`worker-stop-failed:${failed.length}`);
}

export async function stopWorkersForMemberApp(owner: string, appId: string, reason: WorkerStopReason): Promise<number> {
  const active = await runs.listActiveWorkerRuns({ appId, owner });
  const failed: string[] = [];
  for (const run of active) await stopWorkerForInstance(run.instance_id, reason).catch(() => { failed.push(run.id); });
  if (failed.length) throw new Error(`worker-stop-failed:${failed.length}`);
  return active.length;
}

export async function stopWorkersForMember(owner: string, reason: WorkerStopReason): Promise<number> {
  const active = await runs.listActiveWorkerRuns({ owner });
  let stopped = 0;
  for (const run of active) await stopWorkerForInstance(run.instance_id, reason).then(() => { stopped++; }).catch(() => { /* 멤버의 나머지 세션·grant 회수는 계속 */ });
  return stopped;
}

/** 게이트웨이 재기동·원격 노드 재연결 뒤 active AppInstance와 실제 worker를 다시 수렴시킨다. */
export async function recoverWorkersForHost(hostKind: "central" | "remote", nodeId: string | null = null): Promise<WorkerRecoveryResult> {
  if (hostKind === "remote" && (!nodeId || !nodeOnline(nodeId) || !nodeSupports(nodeId, "workerStatus") || !nodeSupports(nodeId, "startWorker"))) {
    return { kept: 0, restarted: 0, failed: 0, failures: [] };
  }
  const instances = await listActiveRuntimeInstances({ hostKind, hostId: hostKind === "central" ? null : nodeId });
  return runWorkerRecoveryBatch(instances, async (instance) => {
    const app = await getApp(instance.app_id);
    if (!app || !app.enabled || app.status !== "active") {
      await stopWorkerForInstance(instance.id, "app_disabled").catch(() => { /* disabled 정본이 우선 */ });
      return "kept";
    }
    const manifest = parseAppManifest(app.manifest);
    if (!manifest.runtime) {
      await stopWorkerForInstance(instance.id, "package_updated").catch(() => { /* runtime 제거가 정본 */ });
      return "kept";
    }
    const active = await runs.activeWorkerRun(instance.id);
    if (active?.package_hash !== app.content_hash) {
      if (active) await stopWorkerForInstance(instance.id, "package_updated").catch(() => { /* 새 run 시작이 최종 판정 */ });
    } else if (await observeActiveWorkerRun(instance.id)) return "kept";
    await startWorkerForInstance(app, manifest, instance);
    return "restarted";
  });
}

/** 패키지 내용이 바뀌면 기존 run을 새 hash로 교체한다. 설치 성공은 유지하고 인스턴스별 실패를 결과로 돌린다. */
export async function restartWorkersForApp(appId: string): Promise<WorkerRecoveryResult> {
  const instances = await listActiveRuntimeInstances({ appId });
  for (const instance of instances) await stopWorkerForInstance(instance.id, "package_updated").catch(() => { /* 아래 start가 개별 실패로 기록 */ });
  const app = await getApp(appId);
  if (!app || !app.enabled || app.status !== "active") return { kept: instances.length, restarted: 0, failed: 0, failures: [] };
  const manifest = parseAppManifest(app.manifest);
  if (!manifest.runtime) return { kept: instances.length, restarted: 0, failed: 0, failures: [] };
  return runWorkerRecoveryBatch(instances, async (instance) => {
    await startWorkerForInstance(app, manifest, instance);
    return "restarted";
  });
}

let recoveryArmed = false;
/** DB 스키마·builtin 시딩 뒤 한 번 호출. 중앙 부팅복구 + 이미 붙은/앞으로 붙을 최신 노드 복구를 함께 건다. */
export async function armWorkerRecovery(): Promise<{ central: WorkerRecoveryResult; remote: WorkerRecoveryResult[] }> {
  if (!recoveryArmed) {
    recoveryArmed = true;
    onNodeReady(async (nodeId) => { await recoverWorkersForHost("remote", nodeId); });
    onWorkerState(async (nodeId, value) => {
      const snapshot = validateRemoteWorkerSnapshot(value);
      const run = await runs.getWorkerRun(snapshot.runId);
      if (!run || run.host_kind !== "remote" || run.host_id !== nodeId
          || run.app_id !== snapshot.appId || run.instance_id !== snapshot.instanceId) {
        if (nodeSupports(nodeId, "stopWorker")) await nodeRpc(nodeId, "stopWorker", { runId: snapshot.runId, reason: "host_shutdown" }).catch(() => { /* 고아 fail-closed */ });
        return;
      }
      await runs.applyWorkerSnapshot(snapshot);
    });
  }
  const central = await recoverWorkersForHost("central");
  const remote: WorkerRecoveryResult[] = [];
  for (const node of liveNodes()) if (node.online && nodeSupports(node.id, "startWorker")) {
    if (await nodeAgentStale(node.id)) continue; // helloOk 자가갱신 뒤 최신 번들 재연결 훅이 복구한다.
    remote.push(await recoverWorkersForHost("remote", node.id));
  }
  return { central, remote };
}

export async function shutdownGatewayWorkers(): Promise<void> { await gatewayWorkerHost.shutdown(); }
