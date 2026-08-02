// 위탁 스케줄러 매칭(P2 #869) 단위 테스트 — 리소스 적합·용량·도커·노드지정·central 후순위.
import { strict as assert } from "node:assert";
import { matchNode, type SchedulableNode } from "./task-store.js";

const res = (mem: number, disk = 100_000, cpus = 8, load1 = 0) =>
  ({ cpus, load1, mem_total_mb: mem * 2, mem_free_mb: mem, disk_total_mb: disk * 2, disk_free_mb: disk });
const node = (id: string, over: Partial<SchedulableNode> = {}): SchedulableNode =>
  ({ id, kind: "member", hasDocker: false, res: res(8000), capacity: 1, running: 0, ...over });
const need = (over: Record<string, unknown> = {}) =>
  ({ need_cpu: null, need_ram_mb: null, need_disk_mb: null, needs_docker: false, node_pref: null, ...over }) as never;

// 메모리 여유 큰 노드 우선.
assert.equal(matchNode(need(), [node("a", { res: res(4000) }), node("b", { res: res(16000) })])?.id, "b");
// 동점이면 central 후순위(오프로드 취지).
assert.equal(matchNode(need(), [node("central", { central: true }), node("pc")])?.id, "pc");
// 용량 초과 노드 제외.
assert.equal(matchNode(need(), [node("full", { running: 1 }), node("free")])?.id, "free");
// RAM 요구 + 여유(512MB) — 4000 노드는 3600+512 미달.
assert.equal(matchNode(need({ need_ram_mb: 3600 }), [node("a", { res: res(4000) }), node("b", { res: res(8000) })])?.id, "b");
// 디스크 요구 + 여유(1GB).
assert.equal(matchNode(need({ need_disk_mb: 50_000 }), [node("a", { res: res(8000, 50_500) }), node("b", { res: res(4000, 200_000) })])?.id, "b");
// CPU 요구 — 유휴코어(cpus−load1) 미달 제외.
assert.equal(matchNode(need({ need_cpu: 4 }), [node("busy", { res: res(8000, 100_000, 8, 6) }), node("idle", { res: res(4000, 100_000, 8, 1) })])?.id, "idle");
// 도커 요구.
assert.equal(matchNode(need({ needs_docker: true }), [node("no"), node("yes", { hasDocker: true })])?.id, "yes");
// 노드 지정.
assert.equal(matchNode(need({ node_pref: "pin" }), [node("other", { res: res(64000) }), node("pin")])?.id, "pin");
// 리소스 미보고 노드는 '요구 없는' 태스크만.
assert.equal(matchNode(need({ need_ram_mb: 100 }), [node("blind", { res: null })]), null);
assert.equal(matchNode(need(), [node("blind", { res: null })])?.id, "blind");
// 적합 노드 없음.
assert.equal(matchNode(need({ need_ram_mb: 999_999 }), [node("a")]), null);

console.log("node/task-match.test OK");
