// 세션 폴더 안 프로젝트 표현(#1719 session-project.applySessionProjectFs) — mkdtemp 샌드박스에서 부작용으로 단언한다.
//  사양(스크래치 spec.md §B) 7행. tmux·DB 는 안 만진다(applySessionProject 는 tmux 를 띄우므로 여기서 안 잰다).
//  ⚠ 프로젝트 폴더 존재 판정은 PROJECT_SHARED_BASE(TERMINAL_ROOT_SHARED) 기준이라, import 전에 env 를 샌드박스로 돌린다.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SHARED = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-sp-shared-"));
process.env.TERMINAL_ROOT_SHARED = SHARED;
const { applySessionProjectFs, PROJECT_LINK_NAME } = await import("./session-project.js");

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const readJson = (f: string): any => JSON.parse(fs.readFileSync(f, "utf8"));
const linkTarget = (p: string): string | null => { try { return fs.readlinkSync(p); } catch { return null; } };
const mkSession = async (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), "lively-sp-sess-"));

// 프로젝트 폴더 둘 — 12 는 AGENTS.md 있음, 13 은 없음, 99 는 없는 폴더.
await fsp.mkdir(path.join(SHARED, "project", "12"), { recursive: true });
await fsp.writeFile(path.join(SHARED, "project", "12", "AGENTS.md"), "# 프로젝트 12\n");
await fsp.mkdir(path.join(SHARED, "project", "13"), { recursive: true });
const P12 = path.join(SHARED, "project", "12");
const P13 = path.join(SHARED, "project", "13");

await t("[1] 빈 세션 폴더 + 프로젝트 폴더 있음 → 마커·링크·셔틀·@project/AGENTS.md · linked=true", async () => {
  const dir = await mkSession();
  const r = await applySessionProjectFs(dir, "box-yoon-1", { projectId: 12, folder: "project/12", name: "온보딩" });
  assert.equal(r.linked, true); assert.equal(r.projectDir, P12);
  const m = readJson(path.join(dir, ".lively", "project.json"));
  assert.equal(m.kind, "session"); assert.equal(m.session_id, "box-yoon-1"); assert.equal(m.project_id, 12);
  assert.equal(m.project_dir, P12); assert.equal(m.sync, "none");
  assert.equal(linkTarget(path.join(dir, PROJECT_LINK_NAME)), P12);
  assert.ok(fs.existsSync(path.join(dir, PROJECT_LINK_NAME, "AGENTS.md")), "링크를 타고 프로젝트 AGENTS.md 가 보인다");
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("<!-- lively:session-project -->"), "우리 표식으로 시작");
  assert.ok(agents.includes("#12") && agents.includes("온보딩"));
  const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.ok(claude.includes("@AGENTS.md") && claude.includes(`@${PROJECT_LINK_NAME}/AGENTS.md`));
});

await t("[2] 프로젝트 폴더가 이 호스트에 없음 → 마커 project_dir=null · 링크 없음 · CLAUDE.md 에 @project 없음 · linked=false", async () => {
  const dir = await mkSession();
  const r = await applySessionProjectFs(dir, "box-yoon-2", { projectId: 99, folder: "project/99" });
  assert.equal(r.linked, false); assert.equal(r.projectDir, null);
  assert.equal(readJson(path.join(dir, ".lively", "project.json")).project_dir, null);
  assert.equal(linkTarget(path.join(dir, PROJECT_LINK_NAME)), null);
  assert.ok(!fs.existsSync(path.join(dir, PROJECT_LINK_NAME)));
  assert.ok(!fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").includes(`@${PROJECT_LINK_NAME}/`));
  assert.ok(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").includes("이 컴퓨터에 없습니다"));
});

await t("[3] 다른 프로젝트로 재바인딩 → 링크가 새 폴더 · 마커 project_id 갱신", async () => {
  const dir = await mkSession();
  await applySessionProjectFs(dir, "box-yoon-3", { projectId: 12, folder: "project/12" });
  const r = await applySessionProjectFs(dir, "box-yoon-3", { projectId: 13, folder: "project/13" });
  assert.equal(r.linked, true);
  assert.equal(linkTarget(path.join(dir, PROJECT_LINK_NAME)), P13);
  assert.equal(readJson(path.join(dir, ".lively", "project.json")).project_id, 13);
});

await t("[4] 뗌(null) → 마커·링크·우리 셔틀 제거", async () => {
  const dir = await mkSession();
  await applySessionProjectFs(dir, "box-yoon-4", { projectId: 12, folder: "project/12" });
  const r = await applySessionProjectFs(dir, "box-yoon-4", null);
  assert.equal(r.linked, false);
  assert.ok(!fs.existsSync(path.join(dir, ".lively", "project.json")));
  assert.ok(!fs.existsSync(path.join(dir, PROJECT_LINK_NAME)));
  assert.ok(!fs.existsSync(path.join(dir, "AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(dir, "CLAUDE.md")));
});

await t("[5] 사용자 AGENTS.md(표식 없음)는 바인딩·뗌 모두 보존", async () => {
  const dir = await mkSession();
  const mine = "# 내 규칙\n건드리지 마\n";
  await fsp.writeFile(path.join(dir, "AGENTS.md"), mine);
  await applySessionProjectFs(dir, "box-yoon-5", { projectId: 12, folder: "project/12" });
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), mine, "바인딩이 사용자 파일을 덮지 않는다");
  await applySessionProjectFs(dir, "box-yoon-5", null);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), mine, "뗌이 사용자 파일을 지우지 않는다");
});

await t("[6] `project` 가 링크가 아니라 진짜 폴더면 건드리지 않는다 · linked=false", async () => {
  const dir = await mkSession();
  await fsp.mkdir(path.join(dir, PROJECT_LINK_NAME));
  await fsp.writeFile(path.join(dir, PROJECT_LINK_NAME, "keep.txt"), "x");
  const r = await applySessionProjectFs(dir, "box-yoon-6", { projectId: 12, folder: "project/12" });
  assert.equal(r.linked, false);
  assert.ok(fs.lstatSync(path.join(dir, PROJECT_LINK_NAME)).isDirectory() && !fs.lstatSync(path.join(dir, PROJECT_LINK_NAME)).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, PROJECT_LINK_NAME, "keep.txt"), "utf8"), "x");
  await applySessionProjectFs(dir, "box-yoon-6", null);
  assert.equal(fs.readFileSync(path.join(dir, PROJECT_LINK_NAME, "keep.txt"), "utf8"), "x", "뗌도 진짜 폴더는 지우지 않는다");
});

await t("[7] 프로젝트 폴더는 있으나 AGENTS.md 없음 → CLAUDE.md 는 표식 + @AGENTS.md 만", async () => {
  const dir = await mkSession();
  const r = await applySessionProjectFs(dir, "box-yoon-7", { projectId: 13, folder: "project/13" });
  assert.equal(r.linked, true);
  const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").trim().split("\n");
  assert.deepEqual(claude, ["<!-- lively:session-project -->", "@AGENTS.md"]);
});

console.log(`session-project: ${pass} passed`);
