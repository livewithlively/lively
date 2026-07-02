// 박스 러너 — 프로젝트 레포 환경 provision(clone→worktree→.lively 마커). work.mjs(로컬 PC)의 서버측 대응.
//  central-box-design §1 의 '박스=경작업' 경계를 "간단 코드작업도 경작업, 쉬운 UI 제공" 으로 확장(2026-06-26 윤상민 결정).
//  설계: [[local-work-project-repo-design]] §3(경로 모델)·§5(러너가 환경 provision). 마커는 [[box-project-lively-marker]].
//  보안(central-box-design §9 위협모델=사내신뢰): 경로는 workspace 안으로 봉쇄(.. 탈출 거부) · git 은 spawn arg-array
//   (셸 없음→인젝션 불가) · clone_url 은 레지스트리 sanitize(자격증명 제거) · 레포명/브랜치명 화이트리스트 검증.
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PROJECT_SHARED_BASE, projectAbsPath } from "./project-fs.js";
import { getRepo } from "./domainmap/core/repos.js";
import { sanitizeCloneUrl } from "./domainmap/core/queries.js";
import { HttpError } from "./capabilities/rest-util.js";

export const REPOS_SUBDIR = "repos"; // workspace/repos/<name> — 박스 호스트 클론(프로젝트 간 공유, worktree 의 부모)
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;        // 경로 컴포넌트로 쓰이므로 슬래시·.. 금지
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/; // git 브랜치명(선두 특수문자 금지)
const GIT_TIMEOUT_MS = 180_000;

export interface RepoSpec { name: string; path?: string; worktree?: boolean; branch?: string; }
//  subpath = cwd 의 workspace 루트 기준 상대경로. 워크트리(project/<id>/<repo>)면 프로젝트 폴더 안이라 세션 cwd 로 쓸 수 있다
//   (세션 POST 가 프로젝트 폴더 봉쇄를 거므로). 클론 직접작업(workspace/repos/<repo>)이면 프로젝트 폴더 밖이라 세션 cwd 불가.
export interface ProvisionedRepo { name: string; path: string; worktree: boolean; branch: string | null; cwd: string; subpath: string; cloned: boolean; }

// git 실행 — async spawn(이벤트루프 비블로킹). 셸 미사용(arg-array) → 인젝션 불가. 타임아웃 시 kill.
function git(args: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = (r: { ok: boolean; out: string; err: string }) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* */ } finish({ ok: false, out: out.trim(), err: `git 타임아웃(${GIT_TIMEOUT_MS}ms)` }); }, GIT_TIMEOUT_MS);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { clearTimeout(timer); finish({ ok: false, out: out.trim(), err: err.trim() || e.message }); });
    p.on("close", (code) => { clearTimeout(timer); finish({ ok: code === 0, out: out.trim(), err: err.trim() }); });
  });
}
async function isRepo(p: string): Promise<boolean> { return !!p && fs.existsSync(p) && (await git(["rev-parse", "--git-dir"], p)).ok; }

// 재사용 레포를 현재 브랜치의 upstream 으로 fast-forward — 새 워크트리가 최신 base HEAD 에서 잘리도록.
//  best-effort·비파괴: 무인 provision 이라 자동 머지커밋·리베이스·충돌 금지 → ff-only 만.
//   dirty·무upstream·갈라짐·오프라인이면 손대지 않고 낡은 채 진행(터미널 생성을 막지 않음).
//   @{u} 사용 → repos 기본 클론(main→origin/main)이든 직접입력 경로(피처브랜치→그 upstream)든 브랜치 선택 존중.
async function refreshRepo(repoPath: string): Promise<void> {
  const st = await git(["status", "--porcelain"], repoPath);
  if (!st.ok || st.out) return;                        // dirty 또는 상태확인 실패 → skip
  await git(["fetch"], repoPath);                       // 실패(오프라인 등) 무시 — 아래 ff 가 no-op 될 뿐
  await git(["merge", "--ff-only", "@{u}"], repoPath);  // ff 불가(갈라짐/무upstream) → 실패 무시, base 그대로
}

// 경로 봉쇄 — 절대경로 정규화 후 workspace 루트 안에 있어야 함(.. 탈출 거부). 신뢰 위협모델이라 string-prefix 검사로 충분.
function confineToWorkspace(abs: string, label: string): string {
  const resolved = path.resolve(abs);
  if (resolved !== PROJECT_SHARED_BASE && !resolved.startsWith(PROJECT_SHARED_BASE + path.sep)) {
    throw new HttpError(400, `${label} 경로가 워크스페이스(${PROJECT_SHARED_BASE}) 밖입니다: ${abs}`);
  }
  return resolved;
}
const expandHome = (p: string): string => (p.startsWith("~/") ? path.join(process.env.HOME || "", p.slice(2)) : p);

// 프로젝트 레포들을 박스에 provision — 각 spec: 경로(없으면 workspace/repos/<name> 기본) 확보(없으면 clone) +
//  worktree 옵션 시 project/<id>/<name> 워크트리(브랜치 project/<id>) 생성. 결과 경로를 .lively/project.json(provisioned)에 기록.
//  멱등: 이미 있는 클론/워크트리는 재사용(덮어쓰기 없음). 비치명 호출 아님 — 실패 시 HttpError throw(엔드포인트가 4xx/5xx).
export async function provisionProjectRepos(
  projectId: number, folder: string, specs: RepoSpec[], opts?: { clone?: boolean },
): Promise<ProvisionedRepo[]> {
  if (!folder) throw new HttpError(400, "프로젝트 폴더가 없습니다");
  const projDir = projectAbsPath(folder);                       // workspace/project/<id>
  const reposBase = path.join(PROJECT_SHARED_BASE, REPOS_SUBDIR); // workspace/repos
  const allowClone = opts?.clone !== false;
  const out: ProvisionedRepo[] = [];

  for (const spec of specs) {
    const name = String(spec?.name || "").trim();
    if (!REPO_NAME_RE.test(name)) throw new HttpError(400, `레포 이름 형식 오류(영숫자.-_, 슬래시 불가): ${name}`);
    const branch = (spec.branch && String(spec.branch).trim()) || `project/${projectId}`;
    if (!BRANCH_RE.test(branch)) throw new HttpError(400, `브랜치명 형식 오류: ${branch}`);

    // ① 클론 경로 — 입력(워크스페이스 봉쇄) 또는 기본 workspace/repos/<name>
    const inputPath = spec.path && String(spec.path).trim() ? expandHome(String(spec.path).trim()) : path.join(reposBase, name);
    const repoPath = confineToWorkspace(inputPath, "레포");

    // ② 없으면 clone (레지스트리 clone_url 필요)
    let cloned = false;
    if (!(await isRepo(repoPath))) {
      if (!allowClone) throw new HttpError(409, `레포가 '${repoPath}' 에 없습니다(클론 비활성).`);
      const row = await getRepo(name).catch(() => null);
      const url = sanitizeCloneUrl(row?.git_url ?? null);
      if (!url) throw new HttpError(409, `레포 '${name}' 의 git 주소가 레지스트리에 없습니다 — 관리탭 ▸ 레포(git) 관리에서 연결하세요.`);
      await fsp.mkdir(path.dirname(repoPath), { recursive: true });
      const c = await git(["clone", url, repoPath]);
      if (!c.ok) throw new HttpError(502, `git clone 실패(${name}): ${c.err}`);
      cloned = true;
    }

    // ②-b 재사용 base(갓 clone 아님)는 새 워크트리를 자르기 전에 upstream 으로 fast-forward(best-effort).
    if (!cloned) await refreshRepo(repoPath);

    // ③ worktree 옵션 — project/<id>/<name> 에 브랜치 격리(이미 있으면 재사용). 미사용 시 cwd=클론 경로.
    let cwd = repoPath;
    const worktree = !!spec.worktree;
    if (worktree) {
      const wtPath = confineToWorkspace(path.join(projDir, name), "워크트리");
      if (!fs.existsSync(wtPath)) {
        await fsp.mkdir(projDir, { recursive: true });
        // -b 로 새 브랜치 시도 → 같은 브랜치가 이미 다른 worktree 면 실패 → 기존 브랜치 attach 폴백(work.mjs 동형).
        let w = await git(["worktree", "add", wtPath, "-b", branch], repoPath);
        if (!w.ok) w = await git(["worktree", "add", wtPath, branch], repoPath);
        if (!w.ok) throw new HttpError(502, `git worktree add 실패(${name}): ${w.err}`);
      }
      cwd = wtPath;
    }
    const subpath = path.relative(PROJECT_SHARED_BASE, cwd);
    out.push({ name, path: repoPath, worktree, branch: worktree ? branch : null, cwd, subpath, cloned });
  }

  // 세션 cwd = 프로젝트 폴더(work.mjs 동형) — 워크트리는 그 폴더 하위라 그냥 접근된다. 비워크트리 클론(폴더 밖)만 add-dir.
  await writeAddDir(projDir, projectId, out.filter((r) => !r.worktree).map((r) => r.path));
  await writeProvisionMarker(projDir, projectId, out);
  return out;
}

// add-dir — 세션 cwd(프로젝트 폴더) 밖의 레포 클론을 하네스가 접근하도록 등록(work.mjs writeAddDir 서버 포팅, 멱등).
//  Claude Code: 프로젝트 폴더의 .claude/settings.local.json(additionalDirectories, host-local·비동기화).
//  Codex: ~/.codex/config.toml 의 [sandbox_workspace_write] writable_roots(이미 있는 경로는 건너뜀).
async function writeAddDir(projDir: string, projectId: number, targets: string[]): Promise<void> {
  if (!targets.length) return;
  // Claude Code — 프로젝트-로컬 설정
  const ccDir = path.join(projDir, ".claude");
  await fsp.mkdir(ccDir, { recursive: true });
  const ccFile = path.join(ccDir, "settings.local.json");
  let cc: Record<string, unknown> = {};
  try { cc = JSON.parse(await fsp.readFile(ccFile, "utf8")); } catch { /* 신규 */ }
  const dirs = new Set(Array.isArray(cc.additionalDirectories) ? cc.additionalDirectories as string[] : []);
  targets.forEach((t) => dirs.add(t));
  cc.additionalDirectories = [...dirs];
  await fsp.writeFile(ccFile, JSON.stringify(cc, null, 2) + "\n");
  // Codex — 박스 사용자 전역 config(이미 등재된 경로는 제외; 미설치/실패는 무해)
  try {
    const cxFile = path.join(os.homedir(), ".codex", "config.toml");
    let toml = ""; try { toml = await fsp.readFile(cxFile, "utf8"); } catch { /* 신규 */ }
    const fresh = targets.filter((t) => !toml.includes(t));
    if (fresh.length) {
      await fsp.mkdir(path.dirname(cxFile), { recursive: true });
      const roots = fresh.map((t) => `"${t}"`).join(", ");
      const ins = `[sandbox_workspace_write]\n# lively: 프로젝트 ${projectId} 레포\nwritable_roots = [${roots}]`;
      const block = toml.includes("[sandbox_workspace_write]") ? toml.replace(/\[sandbox_workspace_write\]/, ins) : toml + "\n" + ins + "\n";
      await fsp.writeFile(cxFile, block);
    }
  } catch { /* codex 미설치 등 — 무해 */ }
}

// .lively/project.json 의 'provisioned' 키에 박스 클론/워크트리 경로 기록(이름만 적는 'repos' 키와 분리 — 충돌 없음·비파괴).
//  ensureAgentsMd 가 'repos'(이름) 를 갱신해도 'provisioned' 는 보존되고, 그 반대도 성립.
async function writeProvisionMarker(projDir: string, projectId: number, repos: ProvisionedRepo[]): Promise<void> {
  const file = path.join(projDir, ".lively", "project.json");
  let prev: Record<string, unknown> = {};
  try { prev = JSON.parse(await fsp.readFile(file, "utf8")); } catch { /* 신규/파손 */ }
  const provisioned = repos.map((r) => ({ name: r.name, path: r.path, worktree: r.worktree, branch: r.branch, cwd: r.cwd, subpath: r.subpath }));
  const next = { ...prev, project_id: projectId, provisioned };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(next, null, 2) + "\n");
}
