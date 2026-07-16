#!/usr/bin/env node
// '내 컴퓨터에서 작업' 첫 부트스트랩 — 담당자 본인 PC 에서 1회 실행. 키트(~/.lively)로 배포된다.
//  하는 일(설계: local-work-project-repo-design + 대화 확정):
//   1) 프로젝트 폴더(=공유폴더, flat) 확보: ~/lively/projects/<id>/  (shared/ 중첩 없음)
//   2) 공유폴더 pull — 게이트웨이 매니페스트(/shared/manifest)와 로컬을 비교해 바뀐/새 파일만 다운로드(단방향, 삭제 안 함)
//   3) 코드 레포: --repo-path 사용(없거나 비면 --git-url 로 clone 폴백). --worktree 면 프로젝트폴더 아래 worktree, 아니면 add-dir
//   4) 마커 ~/lively/projects/<id>/.lively/project.json 기록(project_id, last_pull=매니페스트 newest)
//   5) 그 폴더에서 하네스(claude|codex) 실행
//  ⚠ 코드(레포/worktree)는 git, 공유폴더만 pull. push 없음(pull-only). 외부 바이너리 의존 없음(node + git 만).
//  사용: node work.mjs <projectId> [--repo-path <p>] [--worktree] [--branch <b>] [--git-url <u>] [--harness claude|codex] [--no-launch]
//        node work.mjs <projectId> --pull-only   # 공유폴더만 다시 pull(하네스·레포 provision 없이) — 세션 중 수동 '지금 동기화'
//        node work.mjs <projectId> --status      # pull 없이 상태만: 마지막 pull·서버 최신·로컬 미반영 파일 수 출력(+sync-status.json 갱신)
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

const HOME = os.homedir();
const die = (m) => { console.error("[work] " + m); process.exit(1); };
const log = (m) => console.error("[work] " + m);

// ── 인자 파싱 ──
function parseArgs(argv) {
  const a = { _: [], worktree: false, launch: true, harness: "claude" };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--worktree") a.worktree = true;
    else if (t === "--no-launch") a.launch = false;
    else if (t === "--pull-only") a.pullOnly = true;   // 공유폴더만 pull 후 종료(하네스·레포 provision 생략)
    else if (t === "--status") a.status = true;        // pull 없이 동기화 상태만 점검·출력 후 종료(sync-status.json 갱신)
    else if (t === "--repo-path") a.repoPath = argv[++i];
    else if (t === "--git-url") a.gitUrl = argv[++i];
    else if (t === "--branch") a.branch = argv[++i];
    else if (t === "--harness") a.harness = argv[++i];
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--auto-approve") a.autoApprove = true;
    else if (t === "--repos") a.repos = argv[++i];
    else a._.push(t);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const projectId = String(args._[0] || "").trim();
if (!/^\d+$/.test(projectId)) die("프로젝트 id 가 필요합니다. 사용: node work.mjs <projectId> [--repo-path ..] [--worktree] [--git-url ..]");
const branch = args.branch || `project/${projectId}`;
const harness = args.harness === "codex" ? "codex" : "claude";
// 마커의 싱크 모드(#905 P1-②) — pull 훅이 "이 폴더에 서버 파일을 써도 되나"를 이걸로 판정한다.
//  work.mjs 가 만드는 ~/lively/projects/<id> 는 **공유폴더 그 자체**(라이블리 소유)라 pull 이 기본이다.
//  ⚠ 사용자 자기 폴더에 마커를 심는 `lively init`(C2a)의 기본값은 반대로 "none" 이어야 한다 — 그쪽은
//   사용자 파일이 사는 곳이라 서버 매니페스트가 덮으면 무음 파괴다(#905 §2). 두 기본값을 헷갈리지 말 것.
const DEFAULT_SYNC = "pull";

// ── 게이트웨이 base + 토큰 (session-preload 와 동일 출처) ──
function readFirst(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (c.env && process.env[c.env]) return process.env[c.env].trim();
    if (c.file) { try { const v = fs.readFileSync(c.file, "utf8").trim(); if (v) return v; } catch { /* 없음 */ } }
  }
  return "";
}
let base = readFirst({ env: "LIVELY_GATEWAY_URL" }, { file: path.join(HOME, ".lively", "gateway-url") }) || "http://localhost:8080";
base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, ""); // 끝의 /mcp·슬래시 제거 → 호스트 루트
const token = readFirst({ env: "LIVELY_TOKEN" }, { file: path.join(HOME, ".lively", "token") });
if (!token) die("인증 토큰을 찾을 수 없습니다(~/.lively/token). 먼저 온보딩 설치를 완료하세요.");

async function jfetch(p, opts = {}) {
  const res = await fetch(base + p, { ...opts, headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return res;
}

// ── 1) 프로젝트 폴더(=공유폴더, flat) ──
const projDir = path.join(HOME, "lively", "projects", projectId);
await fsp.mkdir(projDir, { recursive: true });

// ── 2) 공유폴더 pull (매니페스트 diff → 변경분만 다운로드, 단방향·삭제 없음) ──
async function fetchManifest() {
  try { return await (await jfetch(`/api/ui/v6/projects/${projectId}/shared/manifest`)).json(); }
  catch (e) { die("공유폴더 매니페스트를 가져오지 못했습니다 — " + e.message + " (프로젝트 멤버인지, 게이트웨이 동작 확인)"); }
}
// 로컬과 매니페스트를 비교해 아직 안 받은(크기·mtime 다른) 파일만 반환 — pull·status 공용.
function pendingFiles(files) {
  const out = [];
  for (const f of files) {
    const dest = path.join(projDir, f.path);
    if (path.relative(projDir, dest).startsWith("..")) continue; // 경로 탈출 방어
    try { const st = fs.statSync(dest); if (st.size === f.size && Math.floor(st.mtimeMs) >= f.mtime) continue; } catch { /* 로컬 없음 → pending */ }
    out.push(f);
  }
  return out;
}
// sync 상태를 .lively/sync-status.json 에 기록 — 웹/세션이 '동기화 됐나'를 확인하는 표면(#828). best-effort.
async function writeSyncStatus(status) {
  try {
    await fsp.mkdir(path.join(projDir, ".lively"), { recursive: true });
    await fsp.writeFile(path.join(projDir, ".lively", "sync-status.json"), JSON.stringify(status, null, 2) + "\n");
  } catch { /* 상태기록 실패는 무해 */ }
}
async function pullShared() {
  const manifest = await fetchManifest();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const todo = pendingFiles(files);
  let pulled = 0, failed = 0;
  for (const f of todo) {
    const dest = path.join(projDir, f.path);
    try {
      const res = await jfetch(`/api/ui/v6/projects/${projectId}/file?path=${encodeURIComponent(f.path)}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
      if (f.mtime) { try { const t = new Date(f.mtime); fs.utimesSync(dest, t, t); } catch { /* mtime 보존 실패 무해 */ } }
      pulled++;
    } catch { failed++; } // 개별 파일 실패는 건너뛰고 계속(다음 동기화에서 재시도)
  }
  log(`공유폴더 pull: ${pulled}/${todo.length} 파일 갱신 → ${projDir}` + (failed ? ` (실패 ${failed}, 다음 동기화에서 재시도)` : ""));
  if (manifest.truncated) log("⚠ 서버 매니페스트가 파일 상한에 도달 — 일부 문서가 동기화 목록에서 누락됐을 수 있습니다(관리자 확인 필요).");
  await writeSyncStatus({
    at: new Date().toISOString(),
    server_newest: manifest.newest || 0,
    server_count: typeof manifest.count === "number" ? manifest.count : files.length,
    pulled, pending: failed, truncated: !!manifest.truncated,
  });
  return manifest.newest || 0;
}

// ── (옵션) --status: 읽기전용 동기화 상태 점검 후 종료 — sync 가시화(#828) ──
if (args.status) {
  const manifest = await fetchManifest();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const pending = pendingFiles(files);
  let lastPull = 0;
  try { lastPull = Number(JSON.parse(fs.readFileSync(path.join(projDir, ".lively", "project.json"), "utf8")).last_pull) || 0; } catch { /* 마커 없음 */ }
  const iso = (ms) => (ms ? new Date(ms).toISOString() : "없음");
  const serverCount = typeof manifest.count === "number" ? manifest.count : files.length;
  log(`동기화 상태 — 프로젝트 #${projectId}`);
  log(`  로컬 폴더        : ${projDir}`);
  log(`  마지막 pull      : ${iso(lastPull)}`);
  log(`  서버 최신(newest): ${iso(manifest.newest || 0)}`);
  log(`  서버 파일 수     : ${serverCount}${manifest.truncated ? "  ⚠ 상한 도달(일부 문서 누락 가능)" : ""}`);
  log(`  로컬 미반영      : ${pending.length} 파일` + (pending.length ? `  → 'node work.mjs ${projectId} --pull-only' 로 받으세요` : "  (최신)"));
  await writeSyncStatus({ at: new Date().toISOString(), server_newest: manifest.newest || 0, server_count: serverCount, pulled: 0, pending: pending.length, truncated: !!manifest.truncated });
  process.exit(0);
}

const newest = await pullShared();

// ── (옵션) --pull-only: 마커 last_pull 만 갱신(기존 repos/provisioned 보존) 후 종료 — 하네스·레포 provision 생략(#828) ──
if (args.pullOnly) {
  const markerPath = path.join(projDir, ".lively", "project.json");
  let marker = {};
  try { marker = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch { /* 신규 */ }
  marker.project_id = Number(projectId);
  marker.sync = marker.sync || DEFAULT_SYNC;
  marker.last_pull = newest;
  await fsp.mkdir(path.dirname(markerPath), { recursive: true });
  await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n");
  log(`pull-only 완료 (하네스·레포 provision 생략) → ${projDir}`);
  process.exit(0);
}

// ── 3) 코드 레포: repo-path 사용(없으면 clone 폴백) + worktree | add-dir ──
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function isRepo(p) { return !!p && git(["rev-parse", "--git-dir"], p).ok; }
// 재사용 레포를 현재 브랜치 upstream 으로 fast-forward(best-effort·비파괴): dirty·무upstream·갈라짐·오프라인이면 skip.
//  무인이라 자동 머지·리베이스·충돌 금지 → ff-only 만. @{u} → 기본 클론(main)·직접입력 피처브랜치 모두 브랜치 존중.
function refreshRepo(p) {
  const st = git(["status", "--porcelain"], p);
  if (!st.ok || st.out) return;                     // dirty/확인실패 → skip
  git(["fetch"], p);                                 // 실패 무시
  const w = git(["merge", "--ff-only", "@{u}"], p);  // ff 불가 → skip
  if (w.ok) log(`레포 최신화(ff): ${p}`);
}
const expand = (p) => p && p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;

// repos: --repos base64(JSON [{name?,path?,worktree,branch?,gitUrl?}]) 우선, 없으면 레거시 단일 플래그.
let repoSpecs = [];
if (args.repos) {
  try { repoSpecs = JSON.parse(Buffer.from(args.repos, "base64").toString("utf8")); }
  catch { die("--repos 파싱 실패(base64 JSON 이어야 함)"); }
  if (!Array.isArray(repoSpecs)) repoSpecs = [];
} else if (args.repoPath || args.gitUrl || args.worktree) {
  repoSpecs = [{ path: args.repoPath, gitUrl: args.gitUrl, worktree: args.worktree, branch: args.branch }];
}
const addDirTargets = [];  // worktree 미사용 레포 → add-dir 대상
const usedRepos = [];      // 마커에 기록
for (const spec of repoSpecs) {
  let rpath = expand(spec.path);
  if (!rpath) rpath = path.join(HOME, "lively", "repos", spec.name || `proj-${projectId}`);
  const existed = isRepo(rpath);
  if (!existed) {
    if (!spec.gitUrl) die(`레포가 '${rpath}' 에 없습니다. 경로를 지정하거나 레포 레지스트리에서 git 주소를 연결하세요.`);
    log(`레포 clone: ${spec.gitUrl} → ${rpath}`);
    const c = git(["clone", spec.gitUrl, rpath]);
    if (!c.ok) die("git clone 실패 — " + c.err);
  } else {
    refreshRepo(rpath);  // 재사용 클론은 새 워크트리 자르기 전 upstream 으로 최신화(best-effort)
  }
  const br = (spec.branch && String(spec.branch).trim()) || branch;
  if (spec.worktree) {
    const wtPath = path.join(projDir, path.basename(rpath));
    if (!fs.existsSync(wtPath)) {
      log(`worktree 생성: ${wtPath} (브랜치 ${br})`);
      // 같은 브랜치가 이미 다른 worktree 에 있으면 -b 가 실패 → 기존 브랜치 attach 폴백.
      let w = git(["worktree", "add", wtPath, "-b", br], rpath);
      if (!w.ok) w = git(["worktree", "add", wtPath, br], rpath);
      if (!w.ok) die("git worktree add 실패 — " + w.err);
    } else log(`worktree 이미 있음: ${wtPath}`);
    // worktree 는 projDir 하위 → cwd 기준 자동 접근(add-dir 불필요).
    usedRepos.push({ name: spec.name || path.basename(rpath), path: rpath, worktree: true, branch: br });
  } else {
    addDirTargets.push(rpath);  // 클론에서 in-place → add-dir 로 접근
    usedRepos.push({ name: spec.name || path.basename(rpath), path: rpath, worktree: false, branch: null });
  }
}

// ── 3-b) add-dir 설정파일(host-local, 동기화 제외) — worktree 미사용 시 레포를 자동 접근 대상으로 ──
async function writeAddDir(targets) {
  if (!targets.length) return;
  // Claude Code: .claude/settings.local.json 의 additionalDirectories (프로젝트-로컬, 비동기화)
  const ccDir = path.join(projDir, ".claude");
  await fsp.mkdir(ccDir, { recursive: true });
  const ccFile = path.join(ccDir, "settings.local.json");
  let cc = {}; try { cc = JSON.parse(fs.readFileSync(ccFile, "utf8")); } catch { /* 신규 */ }
  const dirs = new Set(Array.isArray(cc.additionalDirectories) ? cc.additionalDirectories : []);
  targets.forEach((t) => dirs.add(t));
  cc.additionalDirectories = [...dirs];
  await fsp.writeFile(ccFile, JSON.stringify(cc, null, 2) + "\n");
  // Codex: ~/.codex/config.toml 의 [sandbox_workspace_write] writable_roots (이미 있는 경로는 제외)
  try {
    const cxFile = path.join(HOME, ".codex", "config.toml");
    let toml = ""; try { toml = fs.readFileSync(cxFile, "utf8"); } catch { /* 신규 */ }
    const fresh = targets.filter((t) => !toml.includes(t));
    if (fresh.length) {
      await fsp.mkdir(path.dirname(cxFile), { recursive: true });
      const roots = fresh.map((t) => `"${t}"`).join(", ");
      const ins = `[sandbox_workspace_write]\n# lively: 프로젝트 ${projectId} 레포\nwritable_roots = [${roots}]`;
      const block = toml.includes("[sandbox_workspace_write]") ? toml.replace(/\[sandbox_workspace_write\]/, ins) : toml + "\n" + ins + "\n";
      await fsp.writeFile(cxFile, block);
    }
  } catch { /* codex 미설치 등 — 무해 */ }
  log(`add-dir 설정: ${targets.join(", ")}`);
}
await writeAddDir(addDirTargets);

// ── 4) 마커 기록(.lively/project.json) — read→merge→write(위 --pull-only 분기와 같은 규율) ──
//  ⚠ 통째 덮어쓰기 금지: 마커는 writer 가 여럿이고 **키가 분리**돼 있다 — 우리가 쓰는 project_id/last_pull/repos 외에
//   서버측 writeProvisionMarker(project-provision.ts)가 'provisioned'(박스 클론/워크트리 경로)를 같은 파일에 쓴다.
//   그쪽은 `{...prev}` 로 우리 키를 보존하는데(그래서 그 주석이 "충돌 없음·비파괴 — 그 반대도 성립"이라 단언한다),
//   여기서 prev 없이 쓰면 그 단언이 깨지고 'provisioned' 가 조용히 증발한다. 모르는 키도 그대로 보존한다.
const dotLively = path.join(projDir, ".lively");
const markerFile = path.join(dotLively, "project.json");
let marker = {};
try { marker = JSON.parse(fs.readFileSync(markerFile, "utf8")); } catch { /* 신규/파손 */ }
marker.project_id = Number(projectId);
marker.sync = marker.sync || DEFAULT_SYNC; // 기존 선택(예: 사람이 none 으로 끔)은 보존
marker.last_pull = newest;
marker.repos = usedRepos;
await fsp.mkdir(dotLively, { recursive: true });
await fsp.writeFile(markerFile, JSON.stringify(marker, null, 2) + "\n");
log(`마커 기록: ${markerFile}`);

// ── 5) 하네스 실행(프로젝트 폴더에서) ──
// 하네스 인자 — 모델/자동승인(웹 터미널 카탈로그와 동일 규칙: claude=--dangerously-skip-permissions, codex=--yolo).
const hargs = [];
if (args.model) hargs.push("--model", args.model);
if (args.autoApprove) hargs.push(harness === "codex" ? "--yolo" : "--dangerously-skip-permissions");
const hcmd = [harness, ...hargs].join(" ");
if (!args.launch) { log(`준비 완료. 시작: cd "${projDir}" && ${hcmd}`); process.exit(0); }
log(`${hcmd} 실행 → ${projDir}`);
// 윈도우는 claude/codex 가 .cmd/.ps1 셰임이라 shell:true 로 실행해야 PATH·확장자 해석이 됨(node spawn 직접실행 불가).
const child = spawn(harness, hargs, { cwd: projDir, stdio: "inherit", shell: process.platform === "win32" });
child.on("error", (e) => die(`${harness} 실행 실패(${e.message}). 직접: cd "${projDir}" && ${hcmd}`));
child.on("exit", (code) => process.exit(code ?? 0));
