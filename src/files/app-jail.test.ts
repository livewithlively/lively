import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInAppFolder } from "./app-jail.js";
import { probeLocal, type PathProbe } from "../terminal/path-jail.js";

// 앱 폴더 봉쇄(#4673) — 사양 표 A1~A8. 진짜 임시 폴더 · 진짜 링크 · 로컬 해소(probeLocal — 멤버 경계 PROBE_JS 와 같은 사양).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lively-app-jail-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 시험마다 새 apps 자리 — crm(진짜 폴더) · other(이웃 앱 폴더) · outside(자리 밖). */
function place(name: string): { apps: string; outside: string } {
  const apps = path.join(ROOT, name, "apps");
  const outside = path.join(ROOT, name, "outside");
  fs.mkdirSync(path.join(apps, "crm", "out"), { recursive: true });
  fs.mkdirSync(path.join(apps, "other"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(apps, "crm", "out", "a.txt"), "a");
  fs.writeFileSync(path.join(apps, "other", "b.txt"), "b");
  fs.writeFileSync(path.join(outside, "c.txt"), "c");
  return { apps, outside };
}
const inApp = (apps: string, app: string, rel: string): Promise<boolean> => isInAppFolder(apps, app, path.join(apps, app, rel), probeLocal);

test("A1 진짜 앱 폴더 — 안의 파일 · 앱 폴더 자신 · 아직 없는 새 이름 → 통과", async () => {
  const { apps } = place("a1");
  assert.equal(await inApp(apps, "crm", "out/a.txt"), true);
  assert.equal(await isInAppFolder(apps, "crm", path.join(apps, "crm"), probeLocal), true);
  assert.equal(await inApp(apps, "crm", "new/dir/n.txt"), true);
});

test("A2 앱 폴더가 아직 없다(첫 올리기) · apps 자리도 아직 없다 → 통과", async () => {
  const { apps } = place("a2");
  assert.equal(await inApp(apps, "fresh", "first.txt"), true);
  const none = path.join(ROOT, "a2-none", "apps");
  assert.equal(await inApp(none, "crm", "x.txt"), true);
});

test("A3 앱 폴더 자신이 이웃 앱 폴더로 가는 링크 → 거부(폴더 자신 · 그 아래 파일 · 새 이름)", async () => {
  const { apps } = place("a3");
  fs.symlinkSync(path.join(apps, "other"), path.join(apps, "linked"));
  assert.equal(await inApp(apps, "linked", "b.txt"), false);
  assert.equal(await isInAppFolder(apps, "linked", path.join(apps, "linked"), probeLocal), false);
  assert.equal(await inApp(apps, "linked", "new.txt"), false);
});

test("A4 앱 폴더 자신이 자리 밖으로 가는 링크 · 댕글링 링크 → 거부", async () => {
  const { apps, outside } = place("a4");
  fs.symlinkSync(outside, path.join(apps, "out-link"));
  assert.equal(await inApp(apps, "out-link", "c.txt"), false);
  fs.symlinkSync(path.join(apps, "nowhere"), path.join(apps, "dangling"));
  assert.equal(await inApp(apps, "dangling", "x.txt"), false);
});

test("A5 앱 폴더 안의 파일 링크가 이웃 앱 폴더를 가리키면 거부 · 앱 폴더 안을 가리키면 통과", async () => {
  const { apps } = place("a5");
  fs.symlinkSync(path.join(apps, "other", "b.txt"), path.join(apps, "crm", "to-other.txt"));
  assert.equal(await inApp(apps, "crm", "to-other.txt"), false);
  fs.symlinkSync(path.join(apps, "crm", "out", "a.txt"), path.join(apps, "crm", "to-self.txt"));
  assert.equal(await inApp(apps, "crm", "to-self.txt"), true);
});

test("A6 apps 자리 자신이 링크(진짜 폴더는 다른 곳)여도 그 안의 진짜 앱 폴더는 통과", async () => {
  const { apps } = place("a6");
  const alias = path.join(ROOT, "a6", "apps-alias");
  fs.symlinkSync(apps, alias);
  assert.equal(await inApp(alias, "crm", "out/a.txt"), true);
  assert.equal(await inApp(alias, "crm", "new.txt"), true);
});

test("A7 해소 실패(권한 등) → 거부", async () => {
  const failing = async (): Promise<PathProbe> => ({ base: "/x", real: null, rest: [], error: "EACCES" });
  assert.equal(await isInAppFolder("/x", "crm", "/x/crm/a.txt", failing), false);
});

test("A8 해소는 한 번 — apps 자리 기준으로 대상을 해소한다(매니지드에선 probe 한 번이 헬퍼 왕복 한 번)", async () => {
  const { apps } = place("a8");
  const calls: Array<[string, string]> = [];
  const recording = async (b: string, t: string): Promise<PathProbe> => { calls.push([b, t]); return probeLocal(b, t); };
  const target = path.join(apps, "crm", "out", "a.txt");
  assert.equal(await isInAppFolder(apps, "crm", target, recording), true);
  assert.deepEqual(calls, [[apps, target]]);
});

test("A9 앱 id 가 앞부분만 같은 이웃 앱 폴더(crm → crm2)로 가는 링크도 거부", async () => {
  const { apps } = place("a9");
  fs.mkdirSync(path.join(apps, "crm2"), { recursive: true });
  fs.writeFileSync(path.join(apps, "crm2", "z.txt"), "z");
  fs.symlinkSync(path.join(apps, "crm2", "z.txt"), path.join(apps, "crm", "to-crm2.txt"));
  assert.equal(await inApp(apps, "crm", "to-crm2.txt"), false);
});
