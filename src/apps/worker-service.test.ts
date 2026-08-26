import { strict as assert } from "node:assert";
import test from "node:test";
import { parseAppManifest } from "./manifest.js";
import { resolveWorkerPlacement, runWorkerRecoveryBatch, validateRemoteWorkerSnapshot } from "./worker-service.js";

const manifest = (runtime?: Record<string, unknown>) => parseAppManifest({ id: "worker-app", title: "Worker", version: "1.0.0", ...(runtime ? { runtime } : {}) });

test("runtime 없는 UI 앱은 실행 위치도 없고, 임의 위치 지정은 거부한다", () => {
  assert.equal(resolveWorkerPlacement(manifest()), null);
  assert.throws(() => resolveWorkerPlacement(manifest(), { kind: "central" }), /without-runtime/);
});

test("placement any는 중앙 기본이며 명시한 원격 노드를 받을 수 있다", () => {
  const m = manifest({ entry: "dist/worker.mjs", placement: "any" });
  assert.deepEqual(resolveWorkerPlacement(m), { kind: "central", nodeId: null });
  assert.deepEqual(resolveWorkerPlacement(m, { kind: "remote", node_id: "node-a" }), { kind: "remote", nodeId: "node-a" });
});

test("central/remote 고정은 반대 위치를 거부하고 remote는 node_id를 요구한다", () => {
  assert.throws(() => resolveWorkerPlacement(manifest({ entry: "w.mjs", placement: "central" }), { kind: "remote", node_id: "n" }), /central-only/);
  assert.throws(() => resolveWorkerPlacement(manifest({ entry: "w.mjs", placement: "remote" })), /remote-node-required/);
  assert.throws(() => resolveWorkerPlacement(manifest({ entry: "w.mjs", placement: "remote" }), { kind: "central" }), /remote-only/);
});

test("worker 복구 배치는 한 인스턴스 실패가 나머지 복구를 막지 않고 결과를 구분한다", async () => {
  const seen: string[] = [];
  const result = await runWorkerRecoveryBatch(["kept", "broken", "restarted"], async (item) => {
    seen.push(item);
    if (item === "broken") throw new Error("node-offline");
    return item === "kept" ? "kept" : "restarted";
  });
  assert.deepEqual(seen, ["kept", "broken", "restarted"]);
  assert.deepEqual(result, { kept: 1, restarted: 1, failed: 1, failures: ["node-offline"] });
});

test("원격 worker push는 run 식별자·상태·시각이 완전한 snapshot만 받는다", () => {
  const good = {
    runId: "run-1", appId: "worker-app", instanceId: "instance-1", status: "failed", pid: 7,
    reason: "process_exit", exitCode: 42, startedAt: "2026-08-25T00:00:00.000Z",
    readyAt: "2026-08-25T00:00:01.000Z", lastActiveAt: "2026-08-25T00:00:02.000Z", stoppedAt: "2026-08-25T00:00:03.000Z",
  };
  assert.deepEqual(validateRemoteWorkerSnapshot(good), good);
  assert.throws(() => validateRemoteWorkerSnapshot({ ...good, status: "unknown" }), /snapshot-invalid/);
  assert.throws(() => validateRemoteWorkerSnapshot({ ...good, stoppedAt: "not-a-date" }), /snapshot-invalid/);
});
