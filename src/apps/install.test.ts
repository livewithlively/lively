import { strict as assert } from "node:assert";
import test from "node:test";
import { runInstall, InstallError, type DeployItem, type InstallDeps, type InstallAppMeta } from "./install.js";
import type { AppComponentRef } from "./install-plan.js";

const META: InstallAppMeta = { id: "app1", title: "T", version: "1.0.0", manifest: {}, source: {}, content_hash: "h" };

function comp(ref: string): AppComponentRef { return { kind: "host", ref }; }
function items(...refs: string[]): DeployItem[] { return refs.map((r) => ({ comp: comp(r), payload: null })); }

// 호출 기록형 mock — 부작용(무엇이 실제로 불렸나)으로 단언한다.
function mockDeps(opts: { failOn?: string } = {}): InstallDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async upsertApp(m, s) { log.push(`upsert:${m.id}:${s}`); },
    async setStatus(id, s) { log.push(`status:${id}:${s}`); },
    async addComponent(id, c) { log.push(`add:${c.ref}`); },
    async removeComponent(id, c) { log.push(`rmComp:${c.ref}`); },
    async deploy(item) {
      if (opts.failOn === item.comp.ref) { log.push(`deploy-FAIL:${item.comp.ref}`); throw new Error("boom"); }
      log.push(`deploy:${item.comp.ref}`);
    },
    async reclaim(c) { log.push(`reclaim:${c.ref}`); },
  };
}

test("성공: 저널 installing→active, 각 component add 후 deploy", async () => {
  const d = mockDeps();
  const n = await runInstall(META, items("a", "b"), d);
  assert.equal(n, 2);
  assert.deepEqual(d.log, [
    "upsert:app1:installing",
    "add:a", "deploy:a",
    "add:b", "deploy:b",
    "status:app1:active",
  ]);
});

test("addComponent 는 deploy **전에** 온다(선기록 저널)", async () => {
  const d = mockDeps();
  await runInstall(META, items("x"), d);
  assert.ok(d.log.indexOf("add:x") < d.log.indexOf("deploy:x"), "add 가 deploy 앞이어야 저널이 유효");
});

test("중간 실패: 앞선 성공분 역순 보상 + 실패분 선기록 제거 + status=failed + throw", async () => {
  const d = mockDeps({ failOn: "b" });
  await assert.rejects(() => runInstall(META, items("a", "b", "c"), d), InstallError);
  // a 는 deploy 성공 → reclaim + rmComp. b 는 deploy 실패(done 아님) → 선기록만 rmComp. c 는 시작 안 함.
  assert.ok(d.log.includes("deploy:a"));
  assert.ok(d.log.includes("deploy-FAIL:b"));
  assert.ok(!d.log.includes("deploy:c"), "실패 후 뒤 item 은 전개 안 함");
  assert.ok(d.log.includes("reclaim:a"), "성공분 a 는 보상돼야 함");
  assert.ok(d.log.includes("rmComp:a"), "성공분 a 조인 제거");
  assert.ok(d.log.includes("rmComp:b"), "실패분 b 선기록 제거");
  assert.ok(!d.log.includes("reclaim:b"), "deploy 실패한 b 는 reclaim 대상 아님(전개된 적 없음)");
  assert.ok(d.log.includes("status:app1:failed"));
  assert.ok(!d.log.includes("status:app1:active"));
});

test("보상은 역순(나중 것부터)", async () => {
  const d = mockDeps({ failOn: "c" });
  await assert.rejects(() => runInstall(META, items("a", "b", "c"), d));
  const iReclaimB = d.log.indexOf("reclaim:b");
  const iReclaimA = d.log.indexOf("reclaim:a");
  assert.ok(iReclaimB < iReclaimA, "b(나중 전개)를 a 보다 먼저 되돌려야 함");
});

test("보상 중 오류는 삼키고 계속(best-effort) — status=failed 는 반드시 남는다", async () => {
  const d = mockDeps({ failOn: "b" });
  const origReclaim = d.reclaim.bind(d);
  d.reclaim = async (c) => { origReclaim(c); throw new Error("reclaim boom"); };
  await assert.rejects(() => runInstall(META, items("a", "b"), d), InstallError);
  assert.ok(d.log.includes("status:app1:failed"), "보상이 던져도 status=failed 는 남아야 스위퍼가 회수");
});

test("빈 설치(component 0) → 즉시 active", async () => {
  const d = mockDeps();
  const n = await runInstall(META, [], d);
  assert.equal(n, 0);
  assert.deepEqual(d.log, ["upsert:app1:installing", "status:app1:active"]);
});
