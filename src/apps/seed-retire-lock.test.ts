// 시더의 은퇴 앱 회수 — 락은 «회수할 것이 있을 때만» (#4638).
//  종전엔 매 시딩·매 워크스페이스가 은퇴 앱(hello)마다 락부터 잡았다. 회수할 것이 없는 곳까지 모두 한 락 앞에 줄을 섰고,
//  그 줄이 2026-10-11 매니지드 전면 정지의 한 고리였다(지식 gw-pool-deadlock-orphan-migrator-advisory-lock-2026-10-11).
//  회수 판정 자체(무엇을 지우나)는 seed-retire.test.ts 가 잡는다 — 여기는 «락을 언제 잡나 · 락 안에서 다시 보나» 다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RETIRED_BUILTIN_APPS, seedBuiltinApps, type SeedDeps } from "./seed.js";
import type { OrgApp } from "../org/store/apps.js";

const row = (over: Partial<OrgApp> = {}): OrgApp => ({
  id: "hello", title: "안녕", version: "1.0.0", manifest: {}, source: { kind: "builtin" }, content_hash: "h",
  status: "active", enabled: true, installed_by: null, installed_at: "", updated_at: "", updated_by: null,
  edit_mode: "all", edit_members: [], builtin_version: "1.0.0", current_version_no: null, ...over,
});

/** 가짜 세계 — getApp 은 부를 때마다 `answers` 를 차례로 답한다(Error 면 던진다). 락·회수 호출을 적는다. */
function fake(answers: Array<OrgApp | null | Error>) {
  const calls = { locks: [] as string[], removes: [] as string[], gets: 0 };
  const deps: SeedDeps = {
    getApp: async (id) => {
      calls.gets++;
      const a = answers.length ? answers.shift()! : null;
      if (a instanceof Error) throw a;
      return a && a.id === id ? a : null;
    },
    installLoadedApp: async () => { throw new Error("패키지 폴더가 비어 있으니 설치는 불리면 안 된다"); },
    setAppBuiltinVersion: async () => undefined,
    persistUiAssets: async () => undefined,
    persistRuntimeAsset: async () => undefined,
    withAppInstallLock: async (id, fn) => { calls.locks.push(id); return fn(); },
    removeInstalledApp: async (existing) => { calls.removes.push(existing.id); return { components: 0, snapshot: null }; },
  } as SeedDeps;
  return { deps, calls };
}

/** 빈 패키지 폴더 — 은퇴 루프만 돈다(present 가 비어 hello 는 «폴더에 없음»). */
function emptyRoot(): string { return mkdtempSync(path.join(tmpdir(), "seed-retire-lock-")); }

test("[전제] 은퇴 목록은 hello 하나다 — 아래 표의 호출 수가 이 길이에 기댄다", () => {
  assert.deepEqual([...RETIRED_BUILTIN_APPS], ["hello"]);
});

test("[B1] 은퇴 앱이 설치돼 있지 않으면 락을 잡지 않는다", async () => {
  const root = emptyRoot();
  try {
    const f = fake([null, null]);
    const r = await seedBuiltinApps(root, f.deps);
    assert.ok(f.calls.gets >= 1, "배선 — 설치 여부를 물었다");
    assert.deepEqual(f.calls.locks, [], `회수할 것이 없는데 락을 잡았다: ${f.calls.locks.join(" · ")}`);
    assert.deepEqual(f.calls.removes, []);
    assert.deepEqual(r.retired, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[B2] 빌트인으로 설치돼 있으면 — 락을 잡고 · 회수하고 · 결과에 적는다", async () => {
  const root = emptyRoot();
  try {
    const f = fake([row(), row()]);
    const r = await seedBuiltinApps(root, f.deps);
    assert.deepEqual(f.calls.locks, ["hello"]);
    assert.deepEqual(f.calls.removes, ["hello"]);
    assert.deepEqual(r.retired, ["hello"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[B3] 락 밖에선 있었는데 락 안에서 다시 보니 없으면 — 회수하지 않고 결과에도 안 적는다", async () => {
  const root = emptyRoot();
  try {
    const f = fake([row(), null]);
    const r = await seedBuiltinApps(root, f.deps);
    assert.deepEqual(f.calls.locks, ["hello"], "락은 잡았다(회수 후보였다)");
    assert.equal(f.calls.gets, 2, "락 안에서 다시 물었다");
    assert.deepEqual(f.calls.removes, []);
    assert.deepEqual(r.retired, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[B4] 워크스페이스가 같은 id 로 직접 깐 앱(builtin 아님)이면 락을 잡지 않는다", async () => {
  const root = emptyRoot();
  try {
    const own = row({ source: { kind: "inline" } });
    const f = fake([own, own]);
    const r = await seedBuiltinApps(root, f.deps);
    assert.deepEqual(f.calls.locks, []);
    assert.deepEqual(f.calls.removes, []);
    assert.deepEqual(r.retired, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[B5] 은퇴 확인 조회가 던져도 시딩은 결과를 돌려준다(비치명)", async () => {
  const root = emptyRoot();
  try {
    const f = fake([new Error("db blip"), new Error("db blip")]);
    const r = await seedBuiltinApps(root, f.deps);
    assert.deepEqual(r.retired, []);
    assert.deepEqual(f.calls.removes, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
