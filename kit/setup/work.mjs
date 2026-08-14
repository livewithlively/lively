#!/usr/bin/env node
// '내 컴퓨터에서 작업' 첫 부트스트랩 — 담당자 본인 PC 에서 1회 실행. 키트(~/.lively)로 배포된다.
//  하는 일(설계: local-work-project-repo-design + 대화 확정):
//   1) 프로젝트 폴더(=공유폴더, flat) 확보: ~/lively/projects/<id>/  (shared/ 중첩 없음)
//   2) 공유폴더 pull — 게이트웨이 매니페스트(/shared/manifest)와 로컬을 비교해 바뀐/새 파일만 다운로드(단방향, 삭제 안 함)
//   3) 코드 레포: --repo-path 사용(없거나 비면 --git-url 로 clone 폴백). --worktree 면 프로젝트폴더 아래 worktree, 아니면 add-dir
//      ⚠ 이 단계 실패는 **치명이 아니다**(#1155) — 아래 '레포 준비 실패는 fail-open' 참고.
//   4) 마커 ~/lively/projects/<id>/.lively/project.json 기록(project_id, last_pull=매니페스트 newest)
//   5) 그 폴더에서 하네스(claude|codex|opencode|antigravity) 실행
//  ⚠ 코드(레포/worktree)는 git, 공유폴더만 pull. push 없음(pull-only). 외부 바이너리 의존 없음(node + git 만).
//  사용: node work.mjs <projectId> [--repo-path <p>] [--worktree] [--branch <b>] [--git-url <u>] [--harness claude|codex|opencode|antigravity] [--no-launch] [--require-repo]
//        node work.mjs <projectId> --pull-only   # 공유폴더만 다시 pull(하네스·레포 provision 없이) — 세션 중 수동 '지금 동기화'
//  ⚠ --status 는 폐지됨(#905 C5a) — 같은 내용을 `lively status` 의 프로젝트 섹션이 보여준다(sync 모드까지).
//     이 명령은 호출자가 0이었다(사람이 안 침). 사람이 실제로 치는 표면 하나로 흡수했다.
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
    else if (t === "--repo-path") a.repoPath = argv[++i];
    else if (t === "--git-url") a.gitUrl = argv[++i];
    else if (t === "--branch") a.branch = argv[++i];
    else if (t === "--harness") a.harness = argv[++i];
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--auto-approve") a.autoApprove = true;
    else if (t === "--repos") a.repos = argv[++i];
    else if (t === "--require-repo") a.requireRepo = true;   // 레포 준비 실패를 치명으로(종전 동작) — 자동화·프로비저닝용
    else a._.push(t);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const projectId = String(args._[0] || "").trim();
if (!/^\d+$/.test(projectId)) die("프로젝트 id 가 필요합니다. 사용: node work.mjs <projectId> [--repo-path ..] [--worktree] [--git-url ..]");
const branch = args.branch || `project/${projectId}`;
// 하네스 선택 — 알려진 값이면 그대로, 모르면 claude(종전 기본). ⚠ 종전 코드는 codex 외 전부 claude 로
//  강제해 opencode·antigravity 프로젝트 세션을 영영 못 띄웠다(#1689 — 조용한 목록 사본).
const harness = ["claude", "codex", "opencode", "antigravity"].includes(args.harness) ? args.harness : "claude";
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
  // GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never — 자격이 없을 때 git 이 **프롬프트로 멈추지 않게**.
  //  stdout/stderr 를 파이프로 잡고 있어(위) 프롬프트 문구가 사용자에게 안 보이는데 git 은 /dev/tty 에서 입력을
  //  기다린다 → 아무 설명 없는 무한대기. fail-open 의 전제는 '빨리 실패'다: 조용히 멈추느니 인증실패로 떨어뜨리고
  //  아래 repoFailed 가 원인·복구법을 남긴다. 비대화형 helper(osxkeychain 등)는 그대로 동작한다.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  const r = spawnSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
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
const usedRepos = [];      // 마커에 기록(준비 성공)
const failedRepos = [];    // 마커에 기록(준비 실패) — 세션 프리로드 훅이 읽어 AI 에게 알린다

// ── 레포 준비 실패는 fail-open (#1155) ──────────────────────────────────────
//  종전엔 여기서 die 했다. 그런데 이 단계는 5) 하네스 실행 **앞**이라, git 자격 하나 없다고 세션 자체가 안 떴다 —
//  마커(4)도 못 쓰고, 사람은 플래그를 빼고 다시 치는 것 말곤 할 수 있는 게 없었다. 정작 실패 원인 대부분
//  (자격 없음·VPN 미접속·브랜치 점유)은 **세션 안에서 1분이면 푸는** 것들이다. 그래서 실패해도 세션은 띄운다.
//  ⚠ 대신 '조용히' 띄우면 더 나쁘다 — AI 가 레포를 '원래 없는 것'으로 오해해 엉뚱한 자리에 clone 하거나 공유 base 에서
//   작업한다. 그래서 실패는 마커(repos_failed)에 남겨 세션 프리로드가 컨텍스트로 주입한다(사람 눈에만 띄우면 묻힌다).
//  무인 위탁(delegate --repo)은 반대로 fail-fast 다(레포 없이 띄우면 빈 워크스페이스에서 헛돈다) — 대화형인 여기만 fail-open.
const recover = (name) => name
  ? `세션 안에서 \`lively repo worktree ${name}\` 로 다시 준비할 수 있습니다.`
  : "세션 안에서 `lively repo worktree <레포>` 로 다시 준비할 수 있습니다.";
// git stderr → 원인 분류. 자격/네트워크는 사람이 취할 조치가 완전히 달라 갈라준다(그 외엔 일반 안내).
function gitHint(err, name) {
  const e = String(err || "");
  if (/Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied|403 Forbidden|401 Unauthorized|access denied/i.test(e)) {
    return `git 자격 문제로 보입니다 — 해당 호스트에 로그인하거나(예: gh auth login) 관리탭 ▸ 레포(git) 관리에서 자격을 연결한 뒤, ${recover(name)}`;
  }
  if (/Could not resolve host|Connection refused|Connection timed out|network is unreachable|Operation timed out|SSL certificate/i.test(e)) {
    return `네트워크·VPN 문제로 보입니다 — 연결을 확인한 뒤, ${recover(name)}`;
  }
  return recover(name);
}
// expect = 준비가 성공했다면 코드가 있었을 자리. 프리로드 훅이 이 경로의 존재로 '이미 복구됨'을 판정해 낡은 경고를 지운다.
function repoFailed(spec, rpath, expect, reason, hint) {
  const name = spec.name || (rpath ? path.basename(rpath) : "repo");
  if (args.requireRepo) die(`레포 준비 실패(${name}) — ${reason}${hint ? "\n  " + hint : ""}`);
  failedRepos.push({ name, path: rpath || null, expect: expect || null, worktree: !!spec.worktree, reason, hint: hint || null });
  log(`⚠ 레포 준비 실패(${name}) — ${reason}`);
  if (hint) log(`   ${hint}`);
}

for (const spec of repoSpecs) {
  let rpath = expand(spec.path);
  if (!rpath) rpath = path.join(HOME, "lively", "repos", spec.name || `proj-${projectId}`);
  const br = (spec.branch && String(spec.branch).trim()) || branch;
  // 준비가 성공했을 때 코드가 놓일 자리 — worktree 면 프로젝트폴더 아래, 아니면 클론 경로 그 자체.
  const expect = spec.worktree ? path.join(projDir, path.basename(rpath)) : rpath;
  const existed = isRepo(rpath);
  if (!existed) {
    if (!spec.gitUrl) {
      repoFailed(spec, rpath, expect, `'${rpath}' 에 레포가 없고 git 주소도 없습니다.`,
        `경로를 지정하거나 관리탭 ▸ 레포(git) 관리에서 git 주소를 연결한 뒤, ${recover(spec.name)}`);
      continue;
    }
    log(`레포 clone: ${spec.gitUrl} → ${rpath}`);
    const c = git(["clone", spec.gitUrl, rpath]);
    if (!c.ok) { repoFailed(spec, rpath, expect, `git clone 실패 — ${c.err}`, gitHint(c.err, spec.name)); continue; }
  } else {
    refreshRepo(rpath);  // 재사용 클론은 새 워크트리 자르기 전 upstream 으로 최신화(best-effort)
  }
  if (spec.worktree) {
    const wtPath = expect;
    if (!fs.existsSync(wtPath)) {
      log(`worktree 생성: ${wtPath} (브랜치 ${br})`);
      // 사라진 워크트리의 등록이 이 브랜치를 계속 쥐고 있지 않게 먼저 턴다(#932) — prunable 등록도 점유로 세서
      //  -b 도 attach 도 막는다. 살아있는 등록엔 무해.
      git(["worktree", "prune"], rpath);
      // 같은 브랜치가 이미 다른 worktree 에 있으면 -b 가 실패 → 기존 브랜치 attach 폴백.
      let w = git(["worktree", "add", wtPath, "-b", br], rpath);
      if (!w.ok) w = git(["worktree", "add", wtPath, br], rpath);
      // 점유가 원인일 때만 안내를 덧붙인다(디스크·권한 등 무관한 실패에 엉뚱한 힌트를 주지 않게) — .mjs/.ts 형제는
      //  git worktree list 로 점유자를 조회하지만, 여기선 git 이 이미 그 경로를 stderr 에 찍어주므로 그걸 그대로 쓴다.
      // ⚠ 문구는 git 버전마다 다르다 — **구 git 을 빠뜨리면 정작 필요한 안내가 조용히 사라진다**:
      //   git 2.34.1(우분투 22.04 기본 = 고객사 A 실박스): `fatal: '<br>' is already checked out at '<경로>'`
      //   신형 git:                                        `fatal: '<br>' is already used by worktree at '<경로>'`
      //  구 git 에서 매칭이 실패하면 아래 일반 힌트("다시 준비할 수 있습니다")만 남고, 사용자는 원인(브랜치 점유)도
      //  해결책(기존 워크트리로 가거나 --branch)도 못 들은 채 같은 실패를 반복한다. 개발 환경이 신형 git 이면
      //  이 구멍이 안 보인다(그래서 테스트가 구 git 에서만 빨간불이었다).
      if (!w.ok) {
        const held = /already used by worktree|already checked out|already exists/i.test(w.err || "");
        repoFailed(spec, rpath, expect, `git worktree add 실패 — ${w.err}`,
          held
            ? "git 은 한 브랜치를 두 워크트리에 못 겁니다 — 위 경로의 워크트리에서 작업하거나 --branch 로 다른 이름을 주세요."
            : gitHint(w.err, spec.name));
        continue;
      }
    } else log(`worktree 이미 있음: ${wtPath}`);
    // worktree 는 projDir 하위 → cwd 기준 자동 접근(add-dir 불필요).
    usedRepos.push({ name: spec.name || path.basename(rpath), path: rpath, worktree: true, branch: br });
  } else {
    addDirTargets.push(rpath);  // 클론에서 in-place → add-dir 로 접근
    usedRepos.push({ name: spec.name || path.basename(rpath), path: rpath, worktree: false, branch: null });
  }
}

// ── 3-b) add-dir 설정파일(host-local, 동기화 제외) — worktree 미사용 시 레포를 자동 접근 대상으로 ──
// 옛 버전이 이스케이프 없이 박은 윈도우 경로 복구 — 그 파일은 **codex 가 통째로 못 읽는 상태**라
//  사용자는 손으로 고치기 전엔 codex 를 아예 못 켠다. 우리가 만든 고장이므로 우리가 되돌린다.
//  대상은 `writable_roots = [...]` 줄뿐(사용자의 다른 줄은 불가침). 유효 이스케이프(\\ \" \b\f\n\r\t \uXXXX \UXXXXXXXX)는 그대로 둔다.
//  ⚠ 유효 이스케이프를 **통째로 소비**해야 멱등이다. 백슬래시를 하나씩 lookahead 로 보면 이미 올바른 `\\Users` 에서
//   두 번째 백슬래시가 '\U 로 시작하는 잘못된 이스케이프'로 보여 재실행마다 백슬래시가 늘어난다(실측 W4).
const TOML_ESC = /\\\\|\\["bfnrt]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\\/g;
function repairTomlWinPaths(toml) {
  return String(toml).replace(/^([ \t]*writable_roots[ \t]*=[ \t]*)(\[[^\]\n]*\])/gm, (line, head, arr) =>
    head + arr.replace(/"(?:[^"\\]|\\.)*"/g, (lit) =>
      lit.replace(TOML_ESC, (m) => (m === "\\" ? "\\\\" : m))));
}

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
  //  ⚠ 경로는 **반드시 JSON.stringify** 로 넣는다 — TOML basic string 은 백슬래시를 이스케이프로 읽으므로
  //   윈도우 경로를 날것으로 넣으면 `C:\Users\…` 의 `\U` 가 유니코드 이스케이프로 해석돼
  //   `too few unicode value digits` 로 **config.toml 전체가 로드 실패**한다 = codex 가 아예 안 뜬다
  //   (mac/linux 에선 슬래시라 절대 재현되지 않는다 — 윈도우 전용 결함 클래스).
  try {
    const cxFile = path.join(HOME, ".codex", "config.toml");
    let toml = ""; try { toml = fs.readFileSync(cxFile, "utf8"); } catch { /* 신규 */ }
    const before = toml;
    toml = repairTomlWinPaths(toml);           // 옛 버전이 남긴 깨진 줄 복구(우리가 쓴 줄만)
    // 중복 판정도 **기록되는 표기**로 봐야 한다 — 날것 경로로 찾으면 윈도우에선 매번 못 찾아 같은 경로가 계속 쌓인다.
    const fresh = targets.filter((t) => !toml.includes(JSON.stringify(t)) && !toml.includes(`"${t}"`));
    if (!fresh.length && toml !== before) { await fsp.writeFile(cxFile, toml); } // 복구만 필요한 경우
    if (fresh.length) {
      await fsp.mkdir(path.dirname(cxFile), { recursive: true });
      const roots = fresh.map((t) => JSON.stringify(t)).join(", ");
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
// 준비 실패분(#1155) — 세션 프리로드가 읽어 AI 에게 주입한다. **성공하면 키를 지운다**(낡은 경고가 영구히 남지 않게):
//  이 실행에서 다 됐거나 애초에 실패가 없으면 삭제 → 마커는 늘 '직전 실행의 사실'만 말한다.
if (failedRepos.length) marker.repos_failed = failedRepos;
else delete marker.repos_failed;
await fsp.mkdir(dotLively, { recursive: true });
await fsp.writeFile(markerFile, JSON.stringify(marker, null, 2) + "\n");
log(`마커 기록: ${markerFile}`);

// 사람용 요약 — 하네스가 화면을 덮기 직전이라 마지막에 한 번 더 모아 보여준다(위 개별 로그는 clone 진행에 묻힌다).
//  AI 쪽 통지는 이 출력이 아니라 마커 → 세션 프리로드 주입이 담당한다(스크롤 소실 없음).
if (failedRepos.length) {
  log("");
  log(`⚠ 레포 ${failedRepos.length}개를 준비하지 못했습니다 — 세션은 그대로 시작합니다(#1155).`);
  for (const f of failedRepos) log(`   · ${f.name}: ${f.reason}`);
  log("   AI 세션에도 이 사실이 전달됩니다 — 코드가 필요해지면 위 안내대로 복구한 뒤 이어서 작업하세요.");
  log("");
}

// ── 5) 하네스 실행(프로젝트 폴더에서) ──
// 하네스 인자 — 모델/자동승인(웹 터미널 카탈로그와 동일 규칙: claude=--dangerously-skip-permissions, codex=--yolo).
//  바이너리명은 하네스 id 와 다를 수 있다(antigravity → agy, #1689) — id 로 spawn 하면 ENOENT 다.
const HARNESS_BIN = { claude: "claude", codex: "codex", opencode: "opencode", antigravity: "agy" };
const hbin = HARNESS_BIN[harness] || harness;
const hargs = [];
if (args.model) hargs.push("--model", args.model);
if (args.autoApprove) hargs.push(harness === "codex" ? "--yolo" : "--dangerously-skip-permissions");
const hcmd = [hbin, ...hargs].join(" ");
if (!args.launch) { log(`준비 완료. 시작: cd "${projDir}" && ${hcmd}`); process.exit(0); }
log(`${hcmd} 실행 → ${projDir}`);
// 윈도우는 claude/codex 가 .cmd/.ps1 셰임이라 shell:true 로 실행해야 PATH·확장자 해석이 됨(node spawn 직접실행 불가).
const child = spawn(hbin, hargs, { cwd: projDir, stdio: "inherit", shell: process.platform === "win32" });
child.on("error", (e) => die(`${hbin} 실행 실패(${e.message}). 직접: cd "${projDir}" && ${hcmd}`));
child.on("exit", (code) => process.exit(code ?? 0));
