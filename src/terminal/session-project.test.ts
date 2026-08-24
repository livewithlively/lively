// 세션 폴더 안 프로젝트 표현(#1719 session-project.applySessionProjectFs) — mkdtemp 샌드박스에서 부작용으로 단언한다.
//  사양(스크래치 spec.md §B) 7행. tmux·DB 는 안 만진다(applySessionProject 는 tmux 를 띄우므로 여기서 안 잰다).
//  ⚠ 프로젝트 폴더 존재 판정은 PROJECT_SHARED_BASE(TERMINAL_ROOT_SHARED) 기준이라, import 전에 env 를 샌드박스로 돌린다.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 워크스페이스를 샌드박스 **안쪽**에 둔다 — '워크스페이스 밖'(E5)을 재는 테스트가 탈출 경로를 만들려 시도하므로,
//  그 자리가 공용 os.tmpdir() 이면 실행 간 잔재가 남아 다음 실행을 오염시킨다(실측: mutation 실행이 남긴 폴더가
//  다음 green 실행을 빨갛게 만들었다). 한 겹 깊게 잡으면 탈출 시도도 이 샌드박스 안에 갇힌다.
const SANDBOX = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-sp-"));
const SHARED = path.join(SANDBOX, "workspace");
await fsp.mkdir(SHARED, { recursive: true });
process.env.TERMINAL_ROOT_SHARED = SHARED;
const { applySessionProjectFs, planSessionProjectFs, PROJECT_LINK_NAME, MEMBER_JS } = await import("./session-project.js");
import { spawnSync } from "node:child_process";

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

// ── 멤버 uid 실행기(MEMBER_JS) — 격리 홈에선 이 고정 리터럴이 같은 계획을 실행한다. 여기선 로컬 uid 로 돌려 계약(probe→ops)을 검증 ──
const runMember = (input: unknown): any => {
  const r = spawnSync(process.execPath, ["-e", MEMBER_JS], { input: JSON.stringify(input), encoding: "utf8" });
  if (r.status !== 0) throw new Error("member js exit " + r.status + " " + r.stderr);
  return JSON.parse(r.stdout);
};
// probe 대상 경로 한 벌 — 프로젝트 폴더 쪽(#1856)까지 함께 묻는다(계획 함수는 파일시스템을 직접 안 본다).
const pathsOf = (dir: string, projDir: string | null): Record<string, string> => ({
  link: path.join(dir, PROJECT_LINK_NAME), agents: path.join(dir, "AGENTS.md"), claude: path.join(dir, "CLAUDE.md"),
  ...(projDir ? { projDir, projAgents: path.join(projDir, "AGENTS.md"), projMarker: path.join(projDir, ".lively", "project.json") } : {}),
});
await t("[8] MEMBER_JS probe — 링크 없음·셔틀 없음이면 {false,null,null} · 우리 셔틀이 있으면 head 로 표식이 보인다", async () => {
  const dir = await mkSession();
  const paths = { link: path.join(dir, PROJECT_LINK_NAME), agents: path.join(dir, "AGENTS.md"), claude: path.join(dir, "CLAUDE.md") };
  // 프로젝트 경로를 안 물으면 proj* 는 전부 false — 계획 함수가 "폴더 없음"으로 읽는 그 값이다(#1856).
  assert.deepEqual(runMember({ probe: paths }), {
    linkIsSymlink: false, agentsHead: null, claudeHead: null,
    projDirExists: false, projAgentsExists: false, projMarkerExists: false,
  });
  await fsp.writeFile(paths.agents, "<!-- lively:session-project -->\n# x\n");
  await fsp.symlink(P12, paths.link, "dir");
  const pr = runMember({ probe: paths });
  assert.equal(pr.linkIsSymlink, true); assert.ok(String(pr.agentsHead).startsWith("<!-- lively:session-project -->")); assert.equal(pr.claudeHead, null);
  // 프로젝트 폴더 쪽 관측 — 격리 통로도 같은 사실을 본다(12 는 폴더·AGENTS.md 있음, 마커는 없음).
  const pp = runMember({ probe: pathsOf(dir, P12) });
  assert.equal(pp.projDirExists, true); assert.equal(pp.projAgentsExists, true); assert.equal(pp.projMarkerExists, false);
});
await t("[9] MEMBER_JS ops — 로컬 io 와 같은 계획을 실행하면 같은 결과(마커·링크·셔틀) · 뗌 계획도 같다", async () => {
  const dir = await mkSession();
  const paths = pathsOf(dir, P12);
  const plan = planSessionProjectFs(dir, "box-yoon-9", { projectId: 12, folder: "project/12", name: "온보딩" }, P12, runMember({ probe: paths }));
  assert.deepEqual(runMember({ ops: plan.ops }), { linkFailed: false });
  assert.equal(readJson(path.join(dir, ".lively", "project.json")).project_id, 12);
  assert.equal(linkTarget(paths.link), P12);
  assert.ok(fs.readFileSync(paths.claude, "utf8").includes(`@${PROJECT_LINK_NAME}/AGENTS.md`));
  // 실패한 링크는 linkFailed 로 보고(진짜 폴더가 자리를 차지) — 나머지 op 는 그대로 수행
  const dir2 = await mkSession(); await fsp.mkdir(path.join(dir2, PROJECT_LINK_NAME));
  const paths2 = pathsOf(dir2, P12);
  const plan2 = planSessionProjectFs(dir2, "box-yoon-9b", { projectId: 12, folder: "project/12" }, P12, runMember({ probe: paths2 }));
  assert.deepEqual(runMember({ ops: plan2.ops }), { linkFailed: true });
  assert.ok(fs.existsSync(path.join(dir2, ".lively", "project.json")));
  // 뗌
  const unplan = planSessionProjectFs(dir, "box-yoon-9", null, null, runMember({ probe: paths }));
  assert.deepEqual(runMember({ ops: unplan.ops }), { linkFailed: false });
  assert.ok(!fs.existsSync(paths.link) && !fs.existsSync(paths.agents) && !fs.existsSync(path.join(dir, ".lively", "project.json")));
});

// ── #1856 A — 프로젝트 폴더 확보 + AGENTS.md 씨앗 (사양 S1·S2·S3 / 엣지 E1~E5) ──
//  배경: cwd 가 세션 폴더로 바뀌면서(#1719) 원격 노드엔 프로젝트 폴더가 **아예 만들어지지 않았고**,
//   그래서 링크도 문서 pull 도 성립하지 않았다. 여기서 그 확보 규칙을 못박는다.
const P21 = path.join(SHARED, "project", "21");
const P22 = path.join(SHARED, "project", "22");
const P23 = path.join(SHARED, "project", "23");

await t("[10:E1] 폴더생성=on · 폴더 없음 · AGENTS.md 전문 있음 → 폴더·마커(sync:pull)·씨앗·링크·@project", async () => {
  const dir = await mkSession();
  const seed = "# 프로젝트 21 digest\n";
  const r = await applySessionProjectFs(dir, "box-yoon-10", { projectId: 21, folder: "project/21" }, undefined, { createProjectDir: true, agentsMd: seed });
  assert.equal(r.createdProjectDir, true);
  assert.equal(r.linked, true); assert.equal(r.projectDir, P21);
  assert.equal(fs.readFileSync(path.join(P21, "AGENTS.md"), "utf8"), seed, "씨앗이 프로젝트 폴더에 심긴다");
  const pm = readJson(path.join(P21, ".lively", "project.json"));
  assert.equal(pm.project_id, 21); assert.equal(pm.sync, "pull", "로컬 사본은 받기만 한다");
  assert.equal(readJson(path.join(dir, ".lively", "project.json")).project_dir, P21);
  assert.equal(linkTarget(path.join(dir, PROJECT_LINK_NAME)), P21);
  assert.ok(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").includes(`@${PROJECT_LINK_NAME}/AGENTS.md`));
});

await t("[11:E2] 폴더생성=on · 전문 부재 → 폴더·마커는 생기고 AGENTS.md 는 안 쓰며 @project import 도 없다", async () => {
  const dir = await mkSession();
  const r = await applySessionProjectFs(dir, "box-yoon-11", { projectId: 22, folder: "project/22" }, undefined, { createProjectDir: true });
  assert.equal(r.createdProjectDir, true); assert.equal(r.linked, true);
  assert.ok(fs.existsSync(path.join(P22, ".lively", "project.json")), "폴더·마커는 만든다(pull 진입 조건)");
  assert.ok(!fs.existsSync(path.join(P22, "AGENTS.md")), "전문이 없으면 AGENTS.md 를 만들지 않는다 — pull 이 채운다");
  assert.ok(!fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").includes(`@${PROJECT_LINK_NAME}/`), "없는 파일을 import 하지 않는다");
});

await t("[12:E3] 폴더·마커가 이미 있으면 마커도 AGENTS.md 도 덮지 않는다", async () => {
  const dir = await mkSession();
  await fsp.mkdir(path.join(P23, ".lively"), { recursive: true });
  const existing = { project_id: 23, sync: "both", last_pull: 12345 };
  await fsp.writeFile(path.join(P23, ".lively", "project.json"), JSON.stringify(existing) + "\n");
  await fsp.writeFile(path.join(P23, "AGENTS.md"), "# 기존 digest\n");
  const r = await applySessionProjectFs(dir, "box-yoon-12", { projectId: 23, folder: "project/23" }, undefined, { createProjectDir: true, agentsMd: "# 새 씨앗\n" });
  assert.equal(r.createdProjectDir, false, "이미 있으면 만들지 않는다");
  assert.deepEqual(readJson(path.join(P23, ".lively", "project.json")), existing, "last_pull·사람이 정한 sync 를 보존한다");
  assert.equal(fs.readFileSync(path.join(P23, "AGENTS.md"), "utf8"), "# 기존 digest\n", "정본은 pull 이 관리 — 씨앗이 덮지 않는다");
});

await t("[13:E4] 폴더생성=off(격리·기본값) · 폴더 없음 → 공유폴더를 만들지 않는다", async () => {
  const dir = await mkSession();
  const r = await applySessionProjectFs(dir, "box-yoon-13", { projectId: 24, folder: "project/24" }, undefined, { agentsMd: "# 씨앗\n" });
  assert.equal(r.createdProjectDir, false); assert.equal(r.linked, false); assert.equal(r.projectDir, null);
  assert.ok(!fs.existsSync(path.join(SHARED, "project", "24")), "격리 통로에선 공유폴더를 멤버 권한으로 만들지 않는다");
  assert.equal(readJson(path.join(dir, ".lively", "project.json")).project_dir, null);
});

await t("[14:E5] 프로젝트 폴더가 워크스페이스 밖 → 프로젝트 폴더 op 0건 · project_dir=null", async () => {
  const dir = await mkSession();
  const r = await applySessionProjectFs(dir, "box-yoon-14", { projectId: 25, folder: "../escape/25" }, undefined, { createProjectDir: true, agentsMd: "# 씨앗\n" });
  assert.equal(r.createdProjectDir, false); assert.equal(r.projectDir, null);
  assert.ok(!fs.existsSync(path.join(path.dirname(SHARED), "escape")), "워크스페이스 밖에는 아무것도 만들지 않는다");
  assert.equal(readJson(path.join(dir, ".lively", "project.json")).project_dir, null);
});

console.log(`session-project: ${pass} passed`);
