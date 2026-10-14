// 시더 ↔ 덮어쓴 빌트인 **배선**(#4600) — 순수 판정(seedShouldSkipOverride)은 app-versions.test.ts 가 잡지만, seedBuiltinApps 가
//  그 판정을 실제로 부르는지는 거기서 안 보인다(호출을 지워도 초록). 그래서 가짜 스토어로 한 바퀴 돌려 못박는다(격리 리뷰 8).
//  이게 틀리면: 부팅마다 시더가 워크스페이스가 고친 판을 릴리스 원본으로 조용히 되돌린다 — 사람은 «내가 고친 게 밤새 사라졌다» 만 본다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedBuiltinApps, type SeedDeps } from "./seed.js";
import type { OrgApp } from "../org/store/apps.js";

const row = (over: Partial<OrgApp> = {}): OrgApp => ({
  id: "x1", title: "x", version: "1.0.0", manifest: {}, source: { kind: "builtin" }, content_hash: "old-hash",
  status: "active", enabled: true, installed_by: null, installed_at: "", updated_at: "", updated_by: null,
  edit_mode: "all", edit_members: [], builtin_version: "1.0.0", current_version_no: null, ...over,
});

/** 가짜 세계 — 무엇이 불렸나를 부작용으로 적는다. */
function fake(existing: OrgApp | null): SeedDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getApp: async (id) => { calls.push(`getApp:${id}`); return id === "x1" ? existing : null; },
    installLoadedApp: async (loaded, source) => { calls.push(`install:${loaded.manifest.id}:${JSON.stringify(source)}`); return { id: loaded.manifest.id, created: !existing, components: 0 }; },
    setAppBuiltinVersion: async (id, v) => { calls.push(`builtin_version:${id}:${v}`); },
    persistUiAssets: async () => { calls.push("persistUi"); },
    persistRuntimeAsset: async () => { calls.push("persistRuntime"); },
    withAppInstallLock: async (_id, fn) => fn(),
    removeInstalledApp: async () => { calls.push("remove"); return { components: 0, snapshot: null }; },
  } as SeedDeps & { calls: string[] };
}

function fixtureRoot(version: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "seed-override-"));
  mkdirSync(path.join(root, "x1"), { recursive: true });
  writeFileSync(path.join(root, "x1", "lively-app.json"), JSON.stringify({ id: "x1", title: "x", version, permissions: { scopes: [], tools: [] } }));
  return root;
}

test("[O1] 덮어쓴 빌트인(overrides_builtin) — 설치를 건너뛰고 폴더의 릴리스 판 번호만 적는다", async () => {
  const root = fixtureRoot("1.2.0");
  try {
    const d = fake(row({ source: { kind: "builtin", overrides_builtin: true, builtin_id: "x1" }, content_hash: "member-hash" }));
    const r = await seedBuiltinApps(root, d);
    assert.deepEqual(r.skipped, ["x1"]);
    assert.deepEqual(r.updated, []);
    assert.ok(!d.calls.some((c) => c.startsWith("install:")), `install 이 불리면 안 된다 — ${d.calls.join(" · ")}`);
    assert.ok(d.calls.includes("builtin_version:x1:1.2.0"), d.calls.join(" · "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[O2] 릴리스 그대로인 빌트인은 내용이 바뀌었으면 종전처럼 재설치한다(+ 판 번호)", async () => {
  const root = fixtureRoot("1.2.0");
  try {
    const d = fake(row());
    const r = await seedBuiltinApps(root, d);
    assert.deepEqual(r.updated, ["x1"]);
    assert.ok(d.calls.some((c) => c.startsWith("install:x1:") && c.includes('"kind":"builtin"')), d.calls.join(" · "));
    assert.ok(d.calls.includes("builtin_version:x1:1.2.0"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[O3] 설치돼 있지 않으면 새로 깐다 · 은퇴 회수 경로는 가짜 락 안에서 getApp 만 묻고 끝난다", async () => {
  const root = fixtureRoot("1.0.0");
  try {
    const d = fake(null);
    const r = await seedBuiltinApps(root, d);
    assert.deepEqual(r.seeded, ["x1"]);
    assert.deepEqual(r.retired, []);
    assert.ok(!d.calls.includes("remove"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
