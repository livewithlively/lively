// 미리보기 준비 — 작업 폴더(워크트리) 확보 + 빌드 실행 (#1036).
//  '띄우기' 한 번으로 끝나게 만드는 부분이다: 사람이 터미널을 열어 워크트리를 만들거나 빌드를 돌릴 필요가 없다.
//  ⚠ clone/worktree + 빌드는 수십 초~수 분이라 **요청 안에서 하면 안 된다**(#600 에서 동기 provision 이 프록시
//   타임아웃으로 504 를 낸 전례). 호출부(preview-envs.ensurePreviewEnv)가 status='preparing' 을 먼저 쓰고
//   이 함수들을 백그라운드로 돌린다.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { provisionProjectRepos } from "../project/project-provision.js";
import { createProjectFolder } from "../project/project-fs.js";
import { getProject, setProjectFolder } from "../v6/project-store.js";

const BUILD_TIMEOUT_MS = 900_000;   // 15분
const INSTALL_TIMEOUT_MS = 600_000; // 10분 — 첫 준비의 의존성 설치(둘을 합쳐도 재시도 창 30분 안에 든다)

// 작업 폴더(워크트리) 확보 — 프로젝트 폴더가 없으면 만들고, 레포를 clone→worktree 한다(멱등: 이미 있으면 그 경로).
//  provisionProjectRepos 를 그대로 재사용하므로 '내 컴퓨터에서 작업'·세션 provision 과 **같은 자리**에 수렴한다.
export async function ensureProjectWorktree(projectId: number, repo: string, memberId?: string | null): Promise<string> {
  const proj = await getProject(projectId);
  if (!proj) throw new Error(`프로젝트 #${projectId} 를 찾을 수 없습니다`);
  let folder = proj.folder;
  if (!folder) {
    folder = await createProjectFolder(projectId);
    await setProjectFolder(projectId, folder, { source: "web" }).catch(() => { /* 폴더 자체는 이미 만들어졌다 */ });
  }
  // 프리뷰는 코드가 없으면 아무 의미가 없다 → failOpen 을 쓰지 않는다(실패는 그대로 throw — #1155 기본 정책).
  const { provisioned } = await provisionProjectRepos(projectId, folder, [{ name: repo, worktree: true }], { memberId: memberId ?? null });
  const mine = provisioned.find((r) => r.name === repo);
  if (!mine?.cwd) throw new Error(`‘${repo}’ 작업 폴더를 준비하지 못했습니다`);
  return mine.cwd;
}

// 의존성 확보 — 빌드·기동 명령을 돌리기 전에 node_modules 를 채운다. 이미 있으면 즉시 통과(멱등).
//  왜 준비 단계에 있나: provision 은 clone → worktree 까지만 한다. 그런데 이 레포의 웹 빌드는
//  `createRequire("typescript")` 로 도구를 찾으므로 **node_modules 없는 새 워크트리에서는 첫 줄에서 즉사**한다
//  (실측 #2143: `requireStack: [ …/scripts/build-web.mjs ]` — 사람 눈엔 그냥 "빌드에 실패했습니다"였다).
//  사람이 터미널을 열지 않아도 되게 하는 것이 프리뷰의 요점이니, 설치도 여기서 끝낸다.
export async function ensureDeps(cwd: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<{ ok: boolean; out: string; action: string }> {
  if (!existsSync(path.join(cwd, "package.json"))) return { ok: true, out: "", action: "no-package-json" };
  if (existsSync(path.join(cwd, "node_modules"))) return { ok: true, out: "", action: "already-installed" };
  // lockfile 이 있으면 ci(잠긴 버전 그대로 · 더 빠르다), 없으면 install. audit·fund 는 출력만 늘린다.
  const cmd = existsSync(path.join(cwd, "package-lock.json"))
    ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
  return { ...await runCmd(cwd, cmd, timeoutMs), action: cmd };
}

// 빌드 실행 — 스택 프로필의 build_cmd(예: `npm run build:web`). 실패해도 throw 하지 않고 결과로 돌려준다
//  (호출부가 상태·안내문으로 바꿔 보여준다). 출력은 꼬리 2000자만 — 화면에 원문 로그를 쏟지 않기 위해.
export function runBuild(cwd: string, cmd: string, timeoutMs = BUILD_TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
  return runCmd(cwd, cmd, timeoutMs);
}

// 준비 단계의 셸 실행기 — 설치·빌드가 같은 규율(타임아웃·꼬리 2000자·throw 안 함)을 공유한다.
function runCmd(cwd: string, cmd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", done = false;
    const fin = (r: { ok: boolean; out: string }): void => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ }
      fin({ ok: false, out: (out + `\n(${Math.round(timeoutMs / 1000)}초를 넘겨 중단했습니다: ${cmd})`).slice(-2000) });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); fin({ ok: false, out: (out + "\n" + e.message).slice(-2000) }); });
    child.on("close", (code) => { clearTimeout(timer); fin({ ok: code === 0, out: out.slice(-2000) }); });
  });
}

// 빌드 실패 안내 — 로그 원문 대신 마지막 의미 있는 줄들만 추려 사람이 읽을 한 문장으로.
export function buildFailureHint(out: string): string { return failureHint("빌드에 실패했습니다", out); }

// 설치 실패 안내 — 빌드 실패와 **다른 문장**이어야 한다. 종전엔 설치가 없어 모든 실패가 '빌드 실패'로 보였고,
//  실제 원인(node_modules 부재)에 닿는 데만 한참 걸렸다(#2143).
export function installFailureHint(out: string): string { return failureHint("의존성 설치에 실패했습니다", out); }

function failureHint(lead: string, out: string): string {
  const lines = String(out || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const tail = lines.slice(-3).join(" / ");
  return tail ? `${lead} — ${tail.slice(0, 300)}` : lead;
}

// 화면 진입 자산 점검 — index.html 이 실제로 로드하는 **로컬 스크립트**가 그 폴더에 있는지 본다(없는 것만 반환).
//  왜 필요한가: 정적 서빙의 준비 판정은 오래도록 `public/ 폴더가 있나` 하나였는데, 빌드 산출물이 git 밖으로
//  나간 뒤(#2054) 그 판정은 **항상 참**이다 — public/ 에 index.html·styles 는 남아 있으니. 그래서 빌드가 통째로
//  생략돼도 상태는 'running' 이고, 사람이 보는 것은 200 을 받은 **하얀 화면**이다(진입 모듈만 404).
//  실패가 오류가 아니라 정상 화면의 얼굴로 나타나는 부류라, 준비 단계에서 직접 확인하는 수밖에 없다.
export function missingEntryAssets(publicDir: string): string[] {
  let html: string;
  try { html = readFileSync(path.join(publicDir, "index.html"), "utf8"); }
  catch { return []; }   // index.html 이 없는 레포는 이 검사의 대상이 아니다(판정 불가 ≠ 실패)
  return entryScriptSrcs(html).filter((src) => !existsSync(path.join(publicDir, src)));
}

// index.html 의 <script src> 중 **이 폴더 기준 상대경로**만 — 판정할 수 있는 것만 고른다.
//  제외: 외부 주소(CDN)·data: · 루트상대(`/…` 는 서빙 접두사에 따라 실제 파일 자리가 달라진다)·상위 탈출(`..`).
//  오탐(있는 파일을 없다고 하는 것)은 멀쩡한 미리보기를 오류로 만들므로, 애매하면 검사하지 않는 쪽으로 기운다.
export function entryScriptSrcs(html: string): string[] {
  const found = new Set<string>();
  for (const m of String(html).matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("/")) continue;
    const rel = raw.split(/[?#]/)[0].replace(/^\.\//, "");
    if (rel && !rel.startsWith("..")) found.add(rel);
  }
  return [...found];
}
